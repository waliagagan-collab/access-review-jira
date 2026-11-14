import { Queue, InvocationError, InvocationErrorCode } from '@forge/events';
import {
  fetchApplicationRoles,
  fetchGroupListPage,
  fetchGroupMemberPage,
  fetchActivityPage,
  verifyCandidate,
  wasActiveWithin,
} from './lib/jira.js';
import {
  SHARDS,
  GROUP_PAGE,
  chunk,
  getScanState,
  setScanState,
  upsertUsers,
  markActive,
  getShardUsers,
  getShardActive,
  getGroupPage,
  setGroupPage,
  setGrants,
  getGrants,
  clearRun,
  saveReview,
  listReviews,
  getReviewRows,
} from './lib/store.js';
import { isAdminGroupName, buildRow, sortRows, groupSummary, diffReviews, flagChanges } from './lib/review.js';

const queue = new Queue({ key: 'scan-queue' });

/**
 * A review snapshot is built by a state machine driven by the async event
 * queue:
 *
 *   roles -> groups -> members -> issues -> verify -> finalize
 *
 * Each invocation does a bounded slice, commits its cursor, and re-queues
 * itself. Work inside a slice is accumulated in memory and written to storage
 * at the end. If a slice dies mid-way, the platform delivers the event again
 * and the slice resumes from the last committed cursor; every write is
 * idempotent, so replaying is safe.
 *
 * Forge allows a chain of at most 1,000 queue pushes from one start, so
 * slices are long (minutes, not seconds) to keep a large site well inside
 * that. If a push fails all the same, the run is marked paused with
 * everything kept, and the page's status call sends the next event.
 *
 * The scan record itself stays small: groups go to storage in pages of their
 * own, users and activity into shards, so a site with thousands of groups and
 * users never pushes one stored value past the size limit.
 */
const SLICE = {
  groupPages: 120,
  memberPages: 200,
  issuePages: 75,
  verifyUsers: 250,
  softBudgetMs: 240_000, // stop early; the manifest gives the function 300s
};
const ISSUE_PAGE = 50;
const MAX_ISSUE_PAGES = 400; // sweep ceiling; verify makes a partial sweep harmless
const MAX_TRANSIENT_RETRIES = 6;

const SWEEP_LIMIT = (MAX_ISSUE_PAGES * ISSUE_PAGE).toLocaleString('en-US');
// The per-user check uses updatedBy(), which covers comments, so a sweep that
// stopped early costs nobody their "active": only the "last seen" date.
export const SWEEP_TRUNCATED_WARNING =
  `This site had more than ${SWEEP_LIMIT} issues updated in the window, so the first pass read the ${SWEEP_LIMIT} most recently updated. Everyone it did not find there was then checked one by one against all issues the app can see, so nobody is shown as inactive because of this limit. People found only by that second check show as Active with no "last seen" date.`;
export const NO_ROLES_WARNING =
  'Application roles were not readable, so the review cannot say which Jira product each group grants. Group membership and activity are still complete.';
export const NO_WORKLOG_WARNING =
  'Jira would not search work logs on this site (time tracking may be off or hidden), so the per-user check ran without them. Every other kind of update was still checked.';
export const uncheckedWarning = (n) =>
  `Jira rejected the activity query for ${n} ${n === 1 ? 'user' : 'users'}. They are marked "Not checked": neither active nor inactive. Check them by hand.`;

const now = () => Date.now();
const overBudget = (t0) => now() - t0 > SLICE.softBudgetMs;
const START_CURSOR = { page: 0, index: 0, startAt: 0, count: 0 };

// @forge/events v2+ invokes a consumer function directly with an AsyncEvent;
// the pushed payload is on `event.body`. Resolvers are not used here.
export async function handler(event) {
  const body = event?.body ?? {};
  const state = await getScanState();
  if (!state || state.status !== 'running' || state.run !== body.run) {
    return; // superseded or cancelled: drop the event, do not re-queue
  }
  // Events are delivered at least once. Every commit bumps `seq` and sends it
  // with the next event, so a duplicate or late copy is dropped instead of
  // running the slice twice and forking the scan.
  if ((body.seq ?? 0) !== (state.seq ?? 0)) return;

  try {
    switch (state.phase) {
      case 'roles':
        await doRoles(state);
        break;
      case 'groups':
        await doGroups(state);
        break;
      case 'members':
        await doMembers(state);
        break;
      case 'issues':
        await doIssues(state);
        break;
      case 'verify':
        await doVerify(state);
        break;
      case 'finalize':
        await doFinalize(state);
        break;
      default:
        return await fail(state, `Unknown scan phase "${state.phase}"`);
    }
    return undefined;
  } catch (err) {
    if (err.rateLimited) {
      return new InvocationError({
        retryAfter: err.retryAfter,
        retryReason: InvocationErrorCode.FUNCTION_UPSTREAM_RATE_LIMITED,
      });
    }
    // Nothing was committed, so a retry resumes from the last good cursor.
    // Bounded: a Jira outage should surface as a failed scan, not a scan that
    // spins for the whole retention window.
    const retries = event?.retryContext?.retryCount ?? 0;
    if (err.retryable && retries < MAX_TRANSIENT_RETRIES) {
      return new InvocationError({
        retryAfter: 15 * (retries + 1),
        retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
      });
    }
    return fail(state, String(err?.message ?? err));
  }
}

/**
 * Is this invocation still the one that owns the run? False once the run was
 * cancelled or restarted, and false when another copy of the same event has
 * already committed (the queue delivers at least once). A slice asks this
 * before it writes anything.
 */
async function owns(state) {
  const fresh = await getScanState();
  return Boolean(fresh && fresh.run === state.run && fresh.status === 'running' && (fresh.seq ?? 0) === (state.seq ?? 0));
}

/**
 * Commit a patch only if this run is still the live one. A cancel that lands
 * mid-slice must win; without this check the slice would overwrite it with
 * its stale `status: 'running'` snapshot and carry on. A superseded slice's
 * scratch writes belong to a run nobody will finish, so they are cleared.
 *
 * A slice whose sequence number is no longer the stored one lost to another
 * copy of the same event: it writes nothing and pushes nothing.
 */
async function commit(state, patch, { requeue = true } = {}) {
  const fresh = await getScanState();
  if (!fresh || fresh.run !== state.run || fresh.status !== 'running') {
    await clearRun(state.run, Math.max(state.groupPages ?? 0, patch.groupPages ?? 0), Math.max(state.grantPages ?? 0, patch.grantPages ?? 0));
    return false;
  }
  if ((fresh.seq ?? 0) !== (state.seq ?? 0)) return false;
  // The seq only moves when a new event is sent; a pause (rate limit) keeps
  // it, so the platform's retry of the same event is still accepted.
  const seq = requeue ? (fresh.seq ?? 0) + 1 : (fresh.seq ?? 0);
  const next = { ...fresh, ...patch, seq, paused: false, pauseReason: null };
  await setScanState(next);
  if (requeue) {
    try {
      await queue.push({ body: { run: state.run, seq } });
    } catch (err) {
      // The work is saved and nothing is deleted. The run waits, paused, for
      // the page's status call to send this event again as a new chain.
      await setScanState({ ...next, paused: true, pauseReason: String(err?.message ?? err) });
    }
  }
  return true;
}

/**
 * A rate limit mid-slice: save what the slice collected so far, commit the
 * cursor without re-queueing, then rethrow so the handler asks the platform
 * to retry after Retry-After. The retry resumes from the committed cursor.
 */
async function pause(state, patch, err) {
  await commit(state, patch, { requeue: false });
  throw err;
}

async function fail(state, error) {
  const fresh = await getScanState();
  // Not ours to fail: restarted, cancelled or finished, or another copy of
  // this event has already moved the run on.
  if (!fresh || fresh.run !== state.run || fresh.status !== 'running' || (fresh.seq ?? 0) !== (state.seq ?? 0)) return;
  await setScanState({
    ...fresh,
    status: 'failed',
    error,
    finishedAt: new Date().toISOString(),
  });
  // Scratch data from a failed run has no further use; do not leave it behind.
  await clearRun(state.run, fresh.groupPages ?? 0, fresh.grantPages ?? 0);
}

// --- roles: which groups grant which product -------------------------------

async function doRoles(state) {
  let roles = [];
  const warnings = [...(state.warnings ?? [])];
  try {
    roles = await fetchApplicationRoles();
  } catch (err) {
    if (err.status === 401 || err.status === 403 || err.status === 404) warnings.push(NO_ROLES_WARNING);
    else throw err;
  }
  const grants = {}; // groupId -> products
  for (const r of roles) {
    for (const g of r.groups) {
      grants[g.groupId] = [...new Set([...(grants[g.groupId] ?? []), r.name])];
    }
  }
  if (!(await owns(state))) return false;
  // The grants go to pages of their own; one entry per product-granting
  // group would not always fit in the scan record.
  const grantPages = await setGrants(state.run, grants);
  return commit(state, {
    phase: 'groups',
    warnings,
    products: roles.map(({ groups, ...r }) => r),
    grantPages,
    groupCursor: 0,
    groupPages: 0,
    groupCount: 0,
  });
}

// --- groups: every group on the site, empty ones included ------------------

async function doGroups(state) {
  const t0 = now();
  let startAt = state.groupCursor ?? 0;
  let pages = state.groupPages ?? 0;
  // A run started by an earlier version carries the grants in its record.
  const grants = state.grants ?? (await getGrants(state.run, state.grantPages ?? 0));
  const collected = [];
  let isLast = false;
  let paused = null;
  for (let i = 0; i < SLICE.groupPages && !overBudget(t0); i++) {
    let page;
    try {
      page = await fetchGroupListPage(startAt);
    } catch (err) {
      if (err.rateLimited) {
        paused = err;
        break;
      }
      throw err;
    }
    for (const g of page.groups) {
      collected.push({
        groupId: g.groupId,
        name: g.name,
        products: grants[g.groupId] ?? [],
        admin: isAdminGroupName(g.name),
        members: 0,
      });
    }
    startAt = page.nextStartAt;
    if (page.isLast) {
      isLast = true;
      break;
    }
  }
  if (!(await owns(state))) return false;
  // Groups go to storage in pages of their own; a few thousand of them would
  // not fit in the scan record. A replayed slice rewrites the same pages.
  for (const page of chunk(collected, GROUP_PAGE)) {
    await setGroupPage(state.run, pages, page);
    pages += 1;
  }
  const patch = {
    groupCursor: startAt,
    groupPages: pages,
    groupCount: (state.groupCount ?? 0) + collected.length,
    phase: isLast ? 'members' : 'groups',
    ...(isLast ? { memberCursor: START_CURSOR, usersFound: 0 } : {}),
  };
  if (paused) return pause(state, patch, paused);
  return commit(state, patch);
}

// --- members: who is in each group -----------------------------------------

/**
 * Walks the stored group pages in order. The cursor names the page, the
 * group within it, the member page to ask for next, and the member count so
 * far for that group; when a group's last member page lands, its count is
 * written into the group page.
 */
async function doMembers(state) {
  const t0 = now();
  const cursor = { ...START_CURSOR, ...(state.memberCursor ?? {}) };
  const totalPages = state.groupPages ?? 0;
  const pages = new Map(); // page index -> groups, loaded as the cursor reaches them
  const touched = new Set();
  const collected = [];
  let calls = 0;
  let paused = null;

  while (calls < SLICE.memberPages && cursor.page < totalPages && !overBudget(t0)) {
    if (!pages.has(cursor.page)) pages.set(cursor.page, await getGroupPage(state.run, cursor.page));
    const page = pages.get(cursor.page);
    if (cursor.index >= page.length) {
      cursor.page += 1;
      cursor.index = 0;
      cursor.startAt = 0;
      cursor.count = 0;
      continue;
    }
    const g = page[cursor.index];
    let res;
    try {
      res = await fetchGroupMemberPage(g.groupId, cursor.startAt);
    } catch (err) {
      if (err.rateLimited) {
        paused = err;
        break;
      }
      if (err.status === 404) res = { users: [], rawCount: 0, isLast: true }; // deleted since it was listed
      else throw err;
    }
    calls += 1;
    for (const u of res.users) {
      collected.push({ ...u, products: g.products ?? [], groups: [g.groupId] });
    }
    cursor.count += res.rawCount;
    if (res.isLast) {
      page[cursor.index] = { ...g, members: cursor.count };
      touched.add(cursor.page);
      cursor.index += 1;
      cursor.startAt = 0;
      cursor.count = 0;
    } else {
      cursor.startAt = res.nextStartAt;
    }
  }

  if (!(await owns(state))) return false;
  for (const i of touched) await setGroupPage(state.run, i, pages.get(i));
  if (collected.length) await upsertUsers(state.run, collected);

  const done = cursor.page >= totalPages && !paused;
  const patch = {
    memberCursor: cursor,
    usersFound: (state.usersFound ?? 0) + collected.length,
    phase: done ? 'issues' : 'members',
    ...(done ? { issueToken: null, issuePages: 0, issuesScanned: 0 } : {}),
  };
  if (paused) return pause(state, patch, paused);
  return commit(state, patch);
}

// --- issues (sweep) ---------------------------------------------------------

async function doIssues(state) {
  const t0 = now();
  let token = state.issueToken ?? null;
  let pages = state.issuePages ?? 0;
  let scanned = state.issuesScanned ?? 0;
  let done = false;
  let truncated = false;
  let paused = null;
  const latest = {};

  for (let i = 0; i < SLICE.issuePages && !overBudget(t0); i++) {
    let page;
    try {
      page = await fetchActivityPage(state.days, token, ISSUE_PAGE);
    } catch (err) {
      if (err.rateLimited) {
        paused = err;
        break;
      }
      throw err;
    }
    for (const [id, a] of Object.entries(page.activity)) {
      if (!latest[id] || Date.parse(a.at) > Date.parse(latest[id])) latest[id] = a.at;
    }
    scanned += page.count;
    pages += 1;
    token = page.nextPageToken;

    if (page.isLast) {
      done = true;
      break;
    }
    if (pages >= MAX_ISSUE_PAGES) {
      done = true;
      truncated = true;
      break;
    }
  }

  if (!(await owns(state))) return false;
  if (Object.keys(latest).length) await markActive(state.run, latest);

  const patch = {
    issueToken: token,
    issuePages: pages,
    issuesScanned: scanned,
    sweepTruncated: Boolean(state.sweepTruncated) || truncated,
    phase: done ? 'verify' : 'issues',
    ...(done ? { verifyShard: 0, verifyIndex: 0, verified: 0, inactiveFound: 0, unchecked: 0, verifyMode: null } : {}),
  };
  if (paused) return pause(state, patch, paused);
  return commit(state, patch);
}

// --- verify -----------------------------------------------------------------

/**
 * Before anyone is checked, run the per-user query once for the person who
 * started the snapshot. If Jira rejects it (400), try without the work-log
 * clauses: the whole run then uses that form and the review says so. If Jira
 * rejects that too, the error is thrown and the snapshot fails with Jira's
 * own message, instead of marking people one by one.
 */
async function probeVerify(state) {
  if (!state.startedBy) return 'full';
  try {
    await wasActiveWithin(state.startedBy, state.days);
    return 'full';
  } catch (err) {
    if (err.status !== 400) throw err;
  }
  await wasActiveWithin(state.startedBy, state.days, { worklog: false });
  return 'no-worklog';
}

/**
 * One person's check. A 400 is tried once more without the work-log clauses.
 * If Jira still rejects it, the person is "not checked": never active on a
 * guess, never inactive on a guess.
 */
async function checkUser(accountId, days, mode) {
  const worklog = mode !== 'no-worklog';
  try {
    return await verifyCandidate(accountId, days, { worklog });
  } catch (err) {
    if (err.status !== 400) throw err;
    if (!worklog) return { unchecked: true };
  }
  try {
    return await verifyCandidate(accountId, days, { worklog: false });
  } catch (err) {
    if (err.status !== 400) throw err;
    return { unchecked: true };
  }
}

/**
 * For every user the sweep could not vouch for, ask Jira directly. This is
 * exhaustive across all issues the app can see, so it is correct even when
 * the sweep was truncated. Results are kept in the active map: a
 * verified-active user gets `verified`, an inactive one gets their band, one
 * Jira would not answer for gets `unchecked`, so finalize needs no lookups.
 */
async function doVerify(state) {
  const t0 = now();
  let shard = state.verifyShard ?? 0;
  let index = state.verifyIndex ?? 0;
  let verified = state.verified ?? 0;
  let inactiveFound = state.inactiveFound ?? 0;
  let unchecked = state.unchecked ?? 0;
  let checked = 0;
  let paused = null;

  let mode = state.verifyMode ?? null;
  const warnings = [...(state.warnings ?? [])];
  if (!mode) {
    mode = await probeVerify(state);
    if (mode === 'no-worklog' && !warnings.includes(NO_WORKLOG_WARNING)) warnings.push(NO_WORKLOG_WARNING);
  }

  const results = {};
  while (shard < SHARDS && checked < SLICE.verifyUsers && !overBudget(t0) && !paused) {
    const users = await getShardUsers(state.run, shard);
    const activeSet = await getShardActive(state.run, shard);
    const ids = Object.keys(users).sort();

    while (index < ids.length && checked < SLICE.verifyUsers && !overBudget(t0)) {
      const accountId = ids[index];
      if (activeSet[accountId]) {
        index += 1;
        continue; // the sweep proved them active, or an earlier slice checked them
      }

      let result;
      try {
        result = await checkUser(accountId, state.days, mode);
      } catch (err) {
        if (err.rateLimited) {
          paused = err; // this user is re-verified when the slice resumes
          break;
        }
        throw err;
      }
      index += 1;
      checked += 1;
      verified += 1;
      if (result.unchecked) {
        unchecked += 1;
        results[accountId] = 'unchecked';
      } else if (result.active) results[accountId] = 'verified';
      else {
        inactiveFound += 1;
        results[accountId] = `inactive:${result.bucket}|${result.label}|${result.severity}`;
      }
    }

    if (index >= ids.length && !paused) {
      shard += 1;
      index = 0;
    }
  }

  if (!(await owns(state))) return false;
  if (Object.keys(results).length) await markActive(state.run, results);

  const done = shard >= SHARDS && !paused;
  const patch = {
    verifyShard: shard,
    verifyIndex: index,
    verified,
    inactiveFound,
    unchecked,
    verifyMode: mode,
    warnings,
    phase: done ? 'finalize' : 'verify',
  };
  if (paused) return pause(state, patch, paused);
  return commit(state, patch);
}

/** Pure: an active-map value -> the activity facts for a row. */
export function activityOf(value) {
  if (!value) return { active: false };
  if (value === 'verified') return { active: true };
  if (value === 'unchecked') return { active: false, unchecked: true };
  if (String(value).startsWith('inactive:')) {
    const [bucket, label, severity] = String(value).slice('inactive:'.length).split('|');
    return { active: false, bucket, label, severity: Number(severity) || 0 };
  }
  return { active: true, at: value }; // an ISO timestamp from the sweep
}

// --- finalize ---------------------------------------------------------------

async function doFinalize(state) {
  const groupsAll = {};
  for (let i = 0; i < (state.groupPages ?? 0); i++) {
    for (const g of await getGroupPage(state.run, i)) {
      groupsAll[g.groupId] = { name: g.name, products: g.products ?? [], admin: Boolean(g.admin), members: g.members ?? 0 };
    }
  }

  const rows = [];
  for (const batch of chunk(Array.from({ length: SHARDS }, (_, s) => s), 8)) {
    const parts = await Promise.all(batch.map(async (s) => [await getShardUsers(state.run, s), await getShardActive(state.run, s)]));
    for (const [users, active] of parts) {
      for (const [accountId, u] of Object.entries(users)) {
        rows.push(buildRow(accountId, u, groupsAll, activityOf(active[accountId])));
      }
    }
  }

  // What changed since the last completed review: each row carries its own
  // flags, and the record keeps the counts and a capped list.
  const previous = (await listReviews()).find((m) => m.status === 'complete' && m.id !== state.run) ?? null;
  const previousRows = previous ? await getReviewRows(previous.id) : null;
  const sorted = previous ? flagChanges(sortRows(rows), previousRows) : sortRows(rows);
  const changes = previous ? diffReviews(sorted, previousRows) : null;
  const groups = groupSummary(groupsAll, sorted);
  const uncheckedRows = sorted.filter((r) => r.unchecked).length;

  const meta = {
    id: state.run,
    status: 'open',
    startedAt: state.startedAt,
    startedBy: state.startedBy ?? null,
    // The personal data report cleared the starter while this ran: their account was closed.
    ...(state.startedByClosed && !state.startedBy ? { startedByClosed: true } : {}),
    days: state.days,
    generatedAt: new Date().toISOString(),
    counts: {
      users: sorted.length,
      admins: sorted.filter((r) => r.admin).length,
      inactive: sorted.filter((r) => !r.active && !r.unchecked).length,
      unchecked: uncheckedRows,
      noAccess: sorted.filter((r) => !(r.products ?? []).length).length,
    },
    products: state.products ?? [],
    previousReviewId: previous?.id ?? null,
    previousCompletedAt: previous?.completedAt ?? null,
    changes,
    issuesScanned: state.issuesScanned ?? 0,
    verified: state.verified ?? 0,
    sweepTruncated: Boolean(state.sweepTruncated),
    warnings: [
      ...(state.warnings ?? []),
      ...(state.sweepTruncated ? [SWEEP_TRUNCATED_WARNING] : []),
      ...(uncheckedRows ? [uncheckedWarning(uncheckedRows)] : []),
    ],
  };

  // Publish only while this invocation still owns the run. A second copy of
  // the event must not rebuild the review from scratch data that the first
  // copy has started to delete.
  if (!(await owns(state))) return false;
  await saveReview(meta, sorted, groups);

  // The scratch data goes only after the run is marked complete. A retry of
  // this slice therefore finds either all of it or a finished run.
  const done = await commit(state, { status: 'complete', phase: 'done', finishedAt: meta.generatedAt, reviewId: meta.id }, { requeue: false });
  if (done) await clearRun(state.run, state.groupPages ?? 0, state.grantPages ?? 0);
  return done;
}
