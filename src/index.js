import ResolverModule from '@forge/resolver';
import { Queue } from '@forge/events';
import {
  SHARDS,
  getScanState,
  setScanState,
  clearRun,
  listReviews,
  getReviewMeta,
  setReviewMeta,
  getReviewRows,
  getReviewRowPages,
  getReviewGroups,
  getDecisions,
  setDecisions,
  deleteReview,
  getSettings,
  saveSettings,
} from './lib/store.js';
import { fetchUsersBulk } from './lib/jira.js';
import { adminOnly } from './lib/admin.js';
import { normaliseDays, isStale, licenseGate, licenseMessage } from './lib/scan.js';
import { normaliseDecision, normaliseNote, decisionStats } from './lib/review.js';

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
  const { groups, changes, ...rest } = m;
  return { ...rest, groupCount: m.groupCount ?? groups?.length ?? 0, changeCounts: changes?.counts ?? null };
};

// --- snapshot -------------------------------------------------------------------

define('startReview', async ({ payload, context }) => {
  // The frontend gates too, but a resolver can be invoked directly, so the
  // paid-app check is enforced here as well. Non-production is never blocked.
  const refused = licenseRefusal(context);
  if (refused) return refused;

  const days = normaliseDays(payload?.days);

  const existing = await getScanState();
  if (existing?.status === 'running' && !isStale(existing)) {
    return { ok: false, error: 'A review snapshot is already being built.' };
  }
  if (existing?.run) await clearRun(existing.run, existing.groupPages ?? 0);

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
  const state = await getScanState();
  if (state?.status === 'running') {
    await setScanState({ ...state, status: 'cancelled', finishedAt: new Date().toISOString() });
    await clearRun(state.run, state.groupPages ?? 0);
  }
  return { ok: true };
});

define('getStatus', async () => {
  const [state, reviews] = await Promise.all([getScanState(), listReviews()]);
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
 * and group names are attached the same way.
 */
async function decorate(meta, groups, rows) {
  const [people, decisions] = await Promise.all([fetchUsersBulk(rows.map((r) => r.accountId)), getDecisions(meta)]);
  const groupName = Object.fromEntries(groups.map((g) => [g.id, g.name]));
  // Reviews saved before rows carried their own flags have a capped list.
  const added = new Set(meta.changes?.added ?? []);
  const becameAdmin = new Set(meta.changes?.becameAdmin ?? []);
  return rows.map((r) => {
    const d = decisions[r.accountId];
    return {
      ...r,
      displayName: people[r.accountId]?.displayName ?? '(unknown)',
      email: people[r.accountId]?.email ?? null,
      groupNames: (r.groups ?? []).map((id) => groupName[id] ?? id),
      decision: d?.decision ?? null,
      note: d?.note ?? '',
      decidedBy: d?.by ?? null,
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
  const names = await fetchUsersBulk([meta.startedBy, meta.completedBy, ...rows.map((r) => r.decidedBy)].filter(Boolean));
  const name = (id) => (id ? (names[id]?.displayName ?? '(unknown)') : null);
  const { groups: inline, ...rest } = meta;
  return {
    ok: true,
    // The group table travels with the first page only; later pages are rows.
    review: { ...rest, groups: page === 0 ? groups : [], startedByName: name(meta.startedBy), completedByName: name(meta.completedBy) },
    rows: rows.map((r) => ({ ...r, decidedByName: name(r.decidedBy) })),
    page,
    pages,
  };
});

// --- decisions -------------------------------------------------------------------------

async function openReview(reviewId) {
  const meta = await getReviewMeta(String(reviewId ?? ''));
  if (!meta) return { error: 'That review was not found.' };
  if (meta.status === 'complete') return { error: 'This review is signed off. Reopen it to change decisions.' };
  return { meta };
}

define('setDecision', async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;
  const { meta, error } = await openReview(payload?.reviewId);
  if (error) return { ok: false, error };
  const accountId = String(payload?.accountId ?? '');
  if (!accountId) return { ok: false, error: 'No account given.' };
  const decision = normaliseDecision(payload?.decision);
  // Clearing the decision clears its note: the entry is removed as a whole.
  const note = decision ? normaliseNote(payload?.note) : '';
  const at = new Date().toISOString();
  await setDecisions(meta, [{ accountId, decision, note, by: context?.accountId ?? null, at }]);
  return { ok: true, decision, note, at };
});

define('setDecisionsBulk', async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;
  const { meta, error } = await openReview(payload?.reviewId);
  if (error) return { ok: false, error };
  const decision = normaliseDecision(payload?.decision);
  if (!decision) return { ok: false, error: 'No decision given.' };
  const ids = [...new Set((payload?.accountIds ?? []).map(String))].slice(0, BULK_LIMIT);
  if (!ids.length) return { ok: false, error: 'No users selected.' };
  const at = new Date().toISOString();
  // Bulk never overwrites a decision someone already made by hand.
  const decided = await setDecisions(
    meta,
    ids.map((accountId) => ({ accountId, decision, note: '', by: context?.accountId ?? null, at })),
    { onlyUnset: true }
  );
  return { ok: true, decided, skipped: ids.length - decided };
});

// --- sign-off ------------------------------------------------------------------------------

define('completeReview', async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;
  const { meta, error } = await openReview(payload?.reviewId);
  if (error) return { ok: false, error };
  const rows = await getReviewRows(meta.id);
  const stats = decisionStats(rows, await getDecisions(meta));
  const at = new Date().toISOString();
  const updated = await setReviewMeta(meta.id, { status: 'complete', completedAt: at, completedBy: context?.accountId ?? null, stats });
  return { ok: true, review: summaryOf(updated) };
});

define('reopenReview', async ({ payload, context }) => {
  const refused = licenseRefusal(context);
  if (refused) return refused;
  const meta = await getReviewMeta(String(payload?.reviewId ?? ''));
  if (!meta) return { ok: false, error: 'That review was not found.' };
  const updated = await setReviewMeta(meta.id, {
    status: 'open',
    reopenedAt: new Date().toISOString(),
    reopenedBy: context?.accountId ?? null,
  });
  return { ok: true, review: summaryOf(updated) };
});

// Deleting is never licence-gated: a customer whose subscription has ended
// can still remove what the app holds.
define('deleteReview', async ({ payload }) => {
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
