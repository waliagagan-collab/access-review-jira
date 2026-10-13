import { Queue, InvocationError, InvocationErrorCode } from '@forge/events';
import {
  fetchApplicationRoles,
  fetchGroupListPage,
  fetchGroupMemberPage,
  fetchActivityPage,
  verifyCandidate,
} from './lib/jira.js';
import {
  SHARDS,
  getScanState,
  setScanState,
  upsertUsers,
  markActive,
  getShardUsers,
  getShardActive,
  clearRun,
  saveReview,
  listReviews,
  getReviewRows,
} from './lib/store.js';
import { isAdminGroupName, buildRow, sortRows, groupSummary, diffReviews } from './lib/review.js';

const queue = new Queue({ key: 'scan-queue' });

/**
 * A review snapshot is built by a state machine driven by the async event
 * queue:
 *
 *   roles -> groups -> members -> issues -> verify -> finalize
 *
 * Each invocation does a bounded slice, commits its cursor, and re-queues
 * itself. Work inside a slice is accumulated in memory and written to storage
 * ONCE at the end. If a slice dies mid-way, the next event resumes from the
 * last committed cursor; every write is idempotent, so replaying is safe.
 */
const SLICE = {
  groupPages: 20,
  memberPages: 30,
  issuePages: 12,
  verifyUsers: 40,
  softBudgetMs: 38_000, // stop early; the manifest gives the function 60s
};
const ISSUE_PAGE = 50;
const MAX_ISSUE_PAGES = 400; // sweep ceiling; verify makes a partial sweep harmless
const MAX_TRANSIENT_RETRIES = 6;

export const SWEEP_TRUNCATED_WARNING =
  `This site had more than ${MAX_ISSUE_PAGES * ISSUE_PAGE} issues updated in the window, so the activity sweep stopped at the most recent ${MAX_ISSUE_PAGES * ISSUE_PAGE}. Every user was still checked individually, but Jira cannot search comments by author, so someone whose only activity was a comment on an older issue may show as inactive.`;
export const NO_ROLES_WARNING =
  'Application roles were not readable, so the review cannot say which product each group grants. Group membership and activity are still complete.';

const now = () => Date.now();
const overBudget = (t0) => now() - t0 > SLICE.softBudgetMs;

// @forge/events v2+ invokes a consumer function directly with an AsyncEvent;
// the pushed payload is on `event.body`. Resolvers are not used here.
export async function handler(event) {
  const body = event?.body ?? {};
  const state = await getScanState();
  if (!state || state.status !== 'running' || state.run !== body.run) {
    return; // superseded or cancelled: drop the event, do not re-queue
  }

  try {
    let live;
    switch (state.phase) {
      case 'roles':
        live = await doRoles(state);
        break;
      case 'groups':
        live = await doGroups(state);
        break;
      case 'members':
        live = await doMembers(state);
        break;
      case 'issues':
        live = await doIssues(state);
        break;
      case 'verify':
        live = await doVerify(state);
        break;
      case 'finalize':
        live = await doFinalize(state);
        break;
      default:
        return await fail(state, `Unknown scan phase "${state.phase}"`);
    }
    // A cancel or a new scan landed while this slice ran: its scratch writes
    // would otherwise sit in storage for ever.
    if (live === false) await clearRun(state.run);
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
 * Commit a patch only if this run is still the live one. A cancel that lands
 * mid-slice must win; without this check the slice would overwrite it with
 * its stale `status: 'running'` snapshot and carry on.
 */
async function commit(state, patch, { requeue = true } = {}) {
  const fresh = await getScanState();
  if (!fresh || fresh.run !== state.run || fresh.status !== 'running') return false;
  const next = { ...fresh, ...patch };
  await setScanState(next);
  if (requeue) await queue.push({ body: { run: state.run } });
  return true;
}

async function fail(state, error) {
  const fresh = await getScanState();
  if (!fresh || fresh.run !== state.run) return;
  await setScanState({
    ...fresh,
    status: 'failed',
    error,
    finishedAt: new Date().toISOString(),
  });
  // Scratch data from a failed run has no further use; do not leave it behind.
  await clearRun(state.run);
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
  return commit(state, {
    phase: 'groups',
    warnings,
    products: roles.map(({ groups, ...r }) => r),
    grants,
    groupsAll: {},
    groupCursor: 0,
  });
}

// --- groups: every group on the site, empty ones included ------------------

async function doGroups(state) {
  const t0 = now();
  const groupsAll = { ...(state.groupsAll ?? {}) };
  let startAt = state.groupCursor ?? 0;
  let isLast = false;
  for (let i = 0; i < SLICE.groupPages && !overBudget(t0); i++) {
    const page = await fetchGroupListPage(startAt);
    for (const g of page.groups) {
      groupsAll[g.groupId] = {
        name: g.name,
        products: state.grants?.[g.groupId] ?? [],
        admin: isAdminGroupName(g.name),
        members: 0,
      };
    }
    startAt = page.nextStartAt;
    if (page.isLast) {
      isLast = true;
      break;
    }
  }
  const groupQueue = isLast ? Object.entries(groupsAll).map(([groupId, g]) => ({ groupId, name: g.name, startAt: 0 })) : state.groupQueue;
  return commit(state, {
    groupsAll,
    groupCursor: startAt,
    phase: isLast ? 'members' : 'groups',
    ...(isLast ? { groupQueue, usersFound: 0 } : {}),
  });
}

// --- members: who is in each group -----------------------------------------

async function doMembers(state) {
  const t0 = now();
  const groupQueue = [...(state.groupQueue ?? [])];
  const groupsAll = { ...(state.groupsAll ?? {}) };
  const collected = [];

  for (let i = 0; i < SLICE.memberPages && groupQueue.length && !overBudget(t0); i++) {
    const head = groupQueue[0];
    const page = await fetchGroupMemberPage(head.groupId, head.startAt);
    const meta = groupsAll[head.groupId] ?? { name: head.name, products: [], admin: isAdminGroupName(head.name), members: 0 };
    groupsAll[head.groupId] = { ...meta, members: (meta.members ?? 0) + page.rawCount };
    for (const u of page.users) {
      collected.push({ ...u, products: meta.products ?? [], groups: [head.groupId] });
    }
    if (page.isLast) groupQueue.shift();
    else groupQueue[0] = { ...head, startAt: page.nextStartAt };
  }

  if (collected.length) await upsertUsers(state.run, collected);

  const done = groupQueue.length === 0;
  return commit(state, {
    groupQueue,
    groupsAll,
    usersFound: (state.usersFound ?? 0) + collected.length,
    phase: done ? 'issues' : 'members',
    ...(done ? { issueToken: null, issuePages: 0, issuesScanned: 0 } : {}),
  });
}

// --- issues (sweep) ---------------------------------------------------------

async function doIssues(state) {
  const t0 = now();
  let token = state.issueToken ?? null;
  let pages = state.issuePages ?? 0;
  let scanned = state.issuesScanned ?? 0;
  let done = false;
  let truncated = false;
  const latest = {};

  for (let i = 0; i < SLICE.issuePages && !overBudget(t0); i++) {
    const page = await fetchActivityPage(state.days, token, ISSUE_PAGE);
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

  if (Object.keys(latest).length) await markActive(state.run, latest);

  return commit(state, {
    issueToken: token,
    issuePages: pages,
    issuesScanned: scanned,
    sweepTruncated: Boolean(state.sweepTruncated) || truncated,
    phase: done ? 'verify' : 'issues',
    ...(done ? { verifyShard: 0, verifyIndex: 0, verified: 0, inactiveFound: 0 } : {}),
  });
}

// --- verify -----------------------------------------------------------------

/**
 * For every user the sweep could not vouch for, ask Jira directly. This is
 * exhaustive across all issues, so it is correct even when the sweep was
 * truncated. Results are kept in the active map: a verified-active user gets
 * `true`, an inactive one gets their band, so finalize needs no extra lookups.
 */
async function doVerify(state) {
  const t0 = now();
  let shard = state.verifyShard ?? 0;
  let index = state.verifyIndex ?? 0;
  let verified = state.verified ?? 0;
  let inactiveFound = state.inactiveFound ?? 0;
  let checked = 0;

  while (shard < SHARDS && checked < SLICE.verifyUsers && !overBudget(t0)) {
    const users = await getShardUsers(state.run, shard);
    const activeSet = await getShardActive(state.run, shard);
    const ids = Object.keys(users).sort();
    const results = {};

    while (index < ids.length && checked < SLICE.verifyUsers && !overBudget(t0)) {
      const accountId = ids[index];
      index += 1;
      if (activeSet[accountId]) continue; // sweep already proved them active

      const result = await verifyCandidate(accountId, state.days);
      checked += 1;
      verified += 1;
      if (result.active) results[accountId] = 'verified';
      else {
        inactiveFound += 1;
        results[accountId] = `inactive:${result.bucket}|${result.label}|${result.severity}`;
      }
    }

    if (Object.keys(results).length) await markActive(state.run, results);

    if (index >= ids.length) {
      shard += 1;
      index = 0;
    }
  }

  const done = shard >= SHARDS;
  return commit(state, {
    verifyShard: shard,
    verifyIndex: index,
    verified,
    inactiveFound,
    phase: done ? 'finalize' : 'verify',
  });
}

/** Pure: an active-map value -> the activity facts for a row. */
export function activityOf(value) {
  if (!value) return { active: false };
  if (value === 'verified') return { active: true };
  if (String(value).startsWith('inactive:')) {
    const [bucket, label, severity] = String(value).slice('inactive:'.length).split('|');
    return { active: false, bucket, label, severity: Number(severity) || 0 };
  }
  return { active: true, at: value }; // an ISO timestamp from the sweep
}

// --- finalize ---------------------------------------------------------------

async function doFinalize(state) {
  const groupsAll = state.groupsAll ?? {};
  const rows = [];
  for (let s = 0; s < SHARDS; s++) {
    const users = await getShardUsers(state.run, s);
    const active = await getShardActive(state.run, s);
    for (const [accountId, u] of Object.entries(users)) {
      rows.push(buildRow(accountId, u, groupsAll, activityOf(active[accountId])));
    }
  }
  const sorted = sortRows(rows);

  // What changed since the last completed review.
  const previous = (await listReviews()).find((m) => m.status === 'complete' && m.id !== state.run) ?? null;
  const changes = previous ? diffReviews(sorted, await getReviewRows(previous.id)) : null;

  const meta = {
    id: state.run,
    status: 'open',
    startedAt: state.startedAt,
    startedBy: state.startedBy ?? null,
    days: state.days,
    generatedAt: new Date().toISOString(),
    counts: {
      users: sorted.length,
      admins: sorted.filter((r) => r.admin).length,
      inactive: sorted.filter((r) => !r.active).length,
      noAccess: sorted.filter((r) => !(r.products ?? []).length).length,
    },
    products: state.products ?? [],
    groups: groupSummary(groupsAll, sorted),
    previousReviewId: previous?.id ?? null,
    previousCompletedAt: previous?.completedAt ?? null,
    changes,
    issuesScanned: state.issuesScanned ?? 0,
    verified: state.verified ?? 0,
    sweepTruncated: Boolean(state.sweepTruncated),
    warnings: [...(state.warnings ?? []), ...(state.sweepTruncated ? [SWEEP_TRUNCATED_WARNING] : [])],
  };
  await saveReview(meta, sorted);
  await clearRun(state.run);

  return commit(state, { status: 'complete', phase: 'done', finishedAt: meta.generatedAt, reviewId: meta.id }, { requeue: false });
}
