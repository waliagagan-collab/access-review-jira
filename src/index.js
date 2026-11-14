import ResolverModule from '@forge/resolver';
import { Queue } from '@forge/events';
import {
  SHARDS,
  SCAN_KEY,
  KEEP_REVIEWS,
  withLock,
  getScanState,
  setScanState,
  clearRun,
  listReviews,
  reviewsToDrop,
  getReviewMeta,
  setReviewMeta,
  getReviewRows,
  getReviewRowPages,
  getReviewGroups,
  getDecisions,
  getDecisionsSettled,
  setDecisions,
  deleteReview,
  getSettings,
  saveSettings,
  markActionStarted,
} from './lib/store.js';
import { fetchUsersBulk } from './lib/jira.js';
import { adminOnly } from './lib/admin.js';
import { normaliseDays, isStale, licenseGate, licenseMessage } from './lib/scan.js';
import {
  normaliseDecision,
  normaliseNote,
  decisionStats,
  signoffHistory,
  withSignoffs,
  isActiveNonAdmin,
  isClosedAccount,
  whoName,
  CLOSED_ACCOUNT_NAME,
} from './lib/review.js';
import { utcDay } from './lib/ui.js';

// Forge bundles this ESM file with webpack, and the CommonJS `@forge/resolver`
// arrives as a namespace object rather than the class. Take the default when
// one is present, so this works under either interop.
const Resolver = ResolverModule?.default ?? ResolverModule;

const resolver = new Resolver();

// Every resolver is admin-only. Defining through this helper means a new
// resolver can't be added without the check.
const define = (key, fn) => resolver.define(key, adminOnly(fn));
const queue = new Queue({ key: 'scan-queue' });

// A review is read in calls of this many stored row pages (1,000 rows for a
// review saved by this version), so a large site never needs one long call.
const ROW_PAGES_PER_CALL = 10;
const BULK_LIMIT = 50_000;

const licenseRefusal = (context) => {
  const gate = licenseGate(context?.license, context?.environmentType);
  return gate.allowed
    ? null
    : { ok: false, unlicensed: true, error: licenseMessage(gate, context?.license) };
};

/** Review summaries for lists: everything but the big tables. */
const summaryOf = (m) => {
  if (!m) return null;
  const { groups, changes, ...rest } = withSignoffs(m);
  return { ...rest, groupCount: m.groupCount ?? groups?.length ?? 0, changeCounts: changes?.counts ?? null };
};

const SIGNED_OFF_MESSAGE = 'This review is signed off. Reopen it to change decisions.';
const BUSY_MESSAGE = 'Another change to this review is being saved. Try again in a moment.';

/**
 * The weekly personal data report does not erase while this change may still
 * be running (busy in lib/personal-data.js). A note that cannot be written
 * only means the report does not wait.
 */
const noteStarted = () => markActionStarted().catch(() => {});

/** A save that could not get its turn in time is reported, not thrown. */
const reportBusy = (fn) => async (request) => {
  try {
    return await fn(request);
  } catch (err) {
    if (err?.busy) return { ok: false, busy: true, error: BUSY_MESSAGE };
    throw err;
  }
};

// --- snapshot -------------------------------------------------------------------

define('startReview', async ({ payload, context }) => {
  // The frontend gates too, but a resolver can be invoked directly, so the
  // paid-app check is enforced here as well. Non-production is never blocked.
  const refused = licenseRefusal(context);
  if (refused) return refused;
  await noteStarted();

  const days = normaliseDays(payload?.days);

  const existing = await getScanState();
  if (existing?.status === 'running' && !isStale(existing)) {
    return { ok: false, error: 'A review snapshot is already being built.' };
  }

  // A new review makes room by removing the oldest one that is not signed
  // off. Signed-off reviews are never removed for the admin, so when every
  // kept review is signed off the admin has to make the room.
  const reviews = await listReviews();
  if (reviews.length >= KEEP_REVIEWS && reviews.every((r) => r.status === 'complete')) {
    const oldest = reviews[reviews.length - 1];
    return {
      ok: false,
      full: true,
      error: `Access Review keeps ${KEEP_REVIEWS} reviews and all of them are signed off. Download the evidence for the oldest one (snapshot of ${utcDay(oldest.generatedAt)}), delete it under Past reviews, then start again.`,
    };
  }

  // Otherwise the review that will make room is removed with its decisions
  // and notes when the new snapshot is saved. The admin is told which one and
  // agrees first; the page sends back the IDs it showed.
  const dropping = reviewsToDrop([{ id: null, status: 'open' }, ...reviews]);
  const agreed = Array.isArray(payload?.remove) ? payload.remove.map(String) : [];
  if (dropping.some((id) => !agreed.includes(String(id)))) {
    const byId = new Map(reviews.map((r) => [r.id, r]));
    return {
      ok: false,
      confirmRemove: dropping.map((id) => ({ id, generatedAt: byId.get(id)?.generatedAt ?? null })),
    };
  }

  if (existing?.run) await clearRun(existing.run, existing.groupPages ?? 0, existing.grantPages ?? 0);

  const state = {
    run: `${Date.now()}`,
    status: 'running',
    phase: 'roles',
    days,
    shards: SHARDS,
    seq: 0,
    startedAt: new Date().toISOString(),
    startedBy: context?.accountId ?? null,
    finishedAt: null,
    error: null,
    warnings: [],
  };
  await setScanState(state);

  try {
    await queue.push({ body: { run: state.run, seq: 0 } });
  } catch (err) {
    await setScanState({
      ...state,
      status: 'failed',
      phase: 'failed',
      finishedAt: new Date().toISOString(),
      error: `Could not queue the snapshot: ${err?.message ?? err}`,
    });
    return { ok: false, error: 'Could not start the review. Please try again.' };
  }
  return { ok: true, state };
});

define('cancelScan', async () => {
  await noteStarted();
  const state = await getScanState();
  if (state?.status === 'running') {
    await setScanState({ ...state, status: 'cancelled', paused: false, finishedAt: new Date().toISOString() });
    await clearRun(state.run, state.groupPages ?? 0, state.grantPages ?? 0);
  }
  return { ok: true };
});

/**
 * A run is paused when the worker saved its slice but could not queue the
 * next one (Forge limits how long one chain of queue events may be). Sending
 * the event from here starts a new chain. The flag is cleared before the
 * push, while no worker can be running, and put back if the push fails; the
 * lock keeps two open tabs from sending the same event twice.
 */
async function resumePaused() {
  try {
    await withLock(
      SCAN_KEY,
      async () => {
        const state = await getScanState();
        if (state?.status !== 'running' || !state.paused) return;
        await setScanState({ ...state, paused: false, pauseReason: null });
        try {
          await queue.push({ body: { run: state.run, seq: state.seq ?? 0 } });
        } catch (err) {
          await setScanState({ ...state, pauseReason: String(err?.message ?? err) });
        }
      },
      { tries: 1 }
    );
  } catch (err) {
    if (!err?.busy) throw err; // busy: another tab is doing it
  }
  return getScanState();
}

define('getStatus', async () => {
  const [found, reviews] = await Promise.all([getScanState(), listReviews()]);
  const state = found?.status === 'running' && found.paused ? await resumePaused() : found;
  return {
    ok: true,
    state: state ?? null,
    stale: isStale(state),
    reviews: reviews.map(summaryOf),
  };
});

// --- reading a review ---------------------------------------------------------------

/**
 * Stored rows carry account IDs only. Names and emails are attached here, at
 * read time, so they are always current and never sit in storage. Decisions
 * and group names are attached the same way. A closed account's row carries
 * a marker instead of the ID (personal data report): it shows as "Closed
 * account", with no email.
 */
async function decorate(meta, groups, rows) {
  const [people, decisions] = await Promise.all([fetchUsersBulk(rows.map((r) => r.accountId)), getDecisions(meta)]);
  const groupName = Object.fromEntries(groups.map((g) => [g.id, g.name]));
  // Reviews saved before rows carried their own flags have a capped list.
  const added = new Set(meta.changes?.added ?? []);
  const becameAdmin = new Set(meta.changes?.becameAdmin ?? []);
  return rows.map((r) => {
    const d = decisions[r.accountId];
    const closed = isClosedAccount(r.accountId);
    return {
      ...r,
      displayName: closed ? CLOSED_ACCOUNT_NAME : (people[r.accountId]?.displayName ?? '(unknown)'),
      email: closed ? null : (people[r.accountId]?.email ?? null),
      groupNames: (r.groups ?? []).map((id) => groupName[id] ?? id),
      decision: d?.decision ?? null,
      note: d?.note ?? '',
      decidedBy: d?.by ?? null,
      decidedByClosed: Boolean(d?.byClosed),
      decidedAt: d?.at ?? null,
      newSinceLast: Boolean(r.newSinceLast ?? added.has(r.accountId)),
      becameAdmin: Boolean(r.becameAdmin ?? becameAdmin.has(r.accountId)),
    };
  });
}

define('getReview', async ({ payload }) => {
  const meta = await getReviewMeta(String(payload?.reviewId ?? ''));
  if (!meta) return { ok: false, error: 'That review was not found.' };
  const pages = Math.max(1, Math.ceil((meta.pages ?? 0) / ROW_PAGES_PER_CALL));
  const page = Math.min(pages - 1, Math.max(0, Math.floor(Number(payload?.page) || 0)));
  const groups = await getReviewGroups(meta);
  const stored = await getReviewRowPages(meta.id, page * ROW_PAGES_PER_CALL, (page + 1) * ROW_PAGES_PER_CALL);
  const rows = await decorate(meta, groups, stored);
  const history = signoffHistory(meta);
  // People who were in the previous review and are not in this one are not
  // among the rows, so their names are looked up here, with the first page.
  const goneIds = page === 0 ? (meta.changes?.removed ?? []) : [];
  const names = await fetchUsersBulk(
    [meta.startedBy, meta.completedBy, ...history.flatMap((h) => [h.completedBy, h.reopenedBy]), ...rows.map((r) => r.decidedBy), ...goneIds].filter(Boolean)
  );
  // A "who" field the personal data report cleared reads "Closed account".
  const name = (id, closed = false) => whoName(id, closed, names);
  const { groups: inline, ...rest } = withSignoffs(meta);
  return {
    ok: true,
    // The group table travels with the first page only; later pages are rows.
    review: {
      ...rest,
      groups: page === 0 ? groups : [],
      startedByName: name(meta.startedBy, meta.startedByClosed),
      completedByName: name(rest.completedBy, rest.completedByClosed),
      signoffs: history.map((h) => ({ ...h, completedByName: name(h.completedBy, h.completedByClosed), reopenedByName: name(h.reopenedBy, h.reopenedByClosed) })),
      gone: goneIds.map((id) => ({ accountId: id, displayName: name(id), email: names[id]?.email ?? null })),
    },
    rows: rows.map((r) => ({ ...r, decidedByName: name(r.decidedBy, r.decidedByClosed) })),
    page,
    pages,
  };
});

// --- decisions -------------------------------------------------------------------------

async function openReview(reviewId) {
  const meta = await getReviewMeta(String(reviewId ?? ''));
  if (!meta) return { error: 'That review was not found.' };
  if (meta.status === 'complete') return { error: SIGNED_OFF_MESSAGE };
  return { meta };
}

define('setDecision', reportBusy(async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;
  const { meta, error } = await openReview(payload?.reviewId);
  if (error) return { ok: false, error };
  const accountId = String(payload?.accountId ?? '');
  if (!accountId) return { ok: false, error: 'No account given.' };
  const decision = normaliseDecision(payload?.decision);
  // Clearing the decision clears its note: the entry is removed as a whole.
  // A closed account's row can be decided but takes no note: the report
  // erased what admins wrote about that person.
  const note = decision && !isClosedAccount(accountId) ? normaliseNote(payload?.note) : '';
  const at = new Date().toISOString();
  const saved = await setDecisions(meta, [{ accountId, decision, note, by: context?.accountId ?? null, at }]);
  // A sign-off landed between the check above and the write: nothing was saved.
  if (saved.signedOff) return { ok: false, error: SIGNED_OFF_MESSAGE };
  return { ok: true, decision, note, at };
}));

define('setDecisionsBulk', reportBusy(async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;
  await noteStarted();
  const { meta, error } = await openReview(payload?.reviewId);
  if (error) return { ok: false, error };
  const decision = normaliseDecision(payload?.decision);
  if (!decision) return { ok: false, error: 'No decision given.' };
  // The page sends the review only and the rows are picked here, from
  // storage: active, not in an admin group, activity checked. A list of
  // accounts is still accepted from a page loaded before this version.
  const picked = Array.isArray(payload?.accountIds)
    ? payload.accountIds.map(String)
    : (await getReviewRows(meta.id)).filter(isActiveNonAdmin).map((r) => r.accountId);
  const ids = [...new Set(picked)].slice(0, BULK_LIMIT);
  if (!ids.length) return { ok: false, error: 'No users selected.' };
  const at = new Date().toISOString();
  // Bulk never overwrites a decision someone already made by hand.
  const saved = await setDecisions(
    meta,
    ids.map((accountId) => ({ accountId, decision, note: '', by: context?.accountId ?? null, at })),
    { onlyUnset: true }
  );
  if (saved.signedOff && !saved.count) return { ok: false, error: SIGNED_OFF_MESSAGE };
  return { ok: true, decided: saved.count, skipped: ids.length - saved.count };
}));

// --- sign-off ------------------------------------------------------------------------------

define('completeReview', reportBusy(async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;
  await noteStarted();
  const { meta, error } = await openReview(payload?.reviewId);
  if (error) return { ok: false, error };
  const rows = await getReviewRows(meta.id);
  // The page sends the number of undecided people the admin saw in the
  // dialog. If storage disagrees (rows still loading, a save that did not
  // land, another admin at work), nothing is signed and the page reloads.
  const expected = Number.isInteger(payload?.expectedUndecided) ? payload.expectedUndecided : null;
  const differs = (stats) => expected !== null && stats.undecided !== expected;
  const changed = (stats) => ({
    ok: false,
    changed: true,
    stats,
    error: `The review changed while you were looking at it: ${stats.undecided} of ${stats.total} are undecided now. Check the list and sign off again.`,
  });
  const before = decisionStats(rows, await getDecisions(meta));
  if (differs(before)) return changed(before);

  // Sign off first, then count again once every decision shard's lock has
  // been passed. A save that was in flight has landed by then, and a later
  // one sees the sign-off and writes nothing, so the totals are final.
  const at = new Date().toISOString();
  const signed = { status: 'complete', completedAt: at, completedBy: context?.accountId ?? null, signoffs: signoffHistory(meta) };
  const unsign = () => setReviewMeta(meta.id, { status: 'open', completedAt: null, completedBy: null, stats: null });
  await setReviewMeta(meta.id, { ...signed, stats: before });
  let stats;
  try {
    stats = decisionStats(rows, await getDecisionsSettled(meta));
  } catch (err) {
    // The final count could not be taken: leave no sign-off that might not match.
    await unsign();
    throw err;
  }
  if (differs(stats)) {
    await unsign();
    return changed(stats);
  }
  const updated = await setReviewMeta(meta.id, { stats });
  return { ok: true, review: summaryOf(updated) };
}));

define('reopenReview', async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;
  await noteStarted();
  const meta = await getReviewMeta(String(payload?.reviewId ?? ''));
  if (!meta) return { ok: false, error: 'That review was not found.' };
  if (meta.status !== 'complete') return { ok: false, error: 'This review is not signed off.' };
  // The sign-off moves into the history with who reopened it and when; the
  // live fields are cleared so an open review never shows a sign-off.
  const reopenedAt = new Date().toISOString();
  const reopenedBy = context?.accountId ?? null;
  const updated = await setReviewMeta(meta.id, {
    status: 'open',
    signoffs: [
      ...signoffHistory(meta),
      {
        completedAt: meta.completedAt ?? null,
        completedBy: meta.completedBy ?? null,
        // The admin who signed off had their account closed (personal data report).
        ...(meta.completedByClosed && !meta.completedBy ? { completedByClosed: true } : {}),
        stats: meta.stats ?? null,
        reopenedAt,
        reopenedBy,
      },
    ],
    completedAt: null,
    completedBy: null,
    stats: null,
    reopenedAt,
    reopenedBy,
  });
  return { ok: true, review: summaryOf(updated) };
});

// Deleting is never licence-gated: a customer whose subscription has ended
// can still remove what the app holds.
define('deleteReview', async ({ payload }) => {
  await noteStarted();
  const id = String(payload?.reviewId ?? '');
  if (!(await getReviewMeta(id))) return { ok: false, error: 'That review was not found.' };
  await deleteReview(id);
  return { ok: true };
});

// --- settings -------------------------------------------------------------------------------

define('getSettings', async () => ({ ok: true, settings: await getSettings() }));

// The review request is shown once per site, after a review has been signed
// off. Closing it is remembered here so no admin sees it again.
define('hideReviewPrompt', async () => {
  const current = await getSettings();
  await saveSettings({ ...current, reviewPromptHiddenAt: new Date().toISOString() });
  return { ok: true };
});

export const handler = resolver.getDefinitions();
