import api, { route } from '@forge/api';

/**
 * Every Jira read the app makes, and every rule about what counts as
 * "active", lives in this file. That rule is the product's central claim and
 * the thing customers will argue with, so it stays explicit and in one place.
 *
 * Two layers:
 *   1. A cheap SWEEP over recently-updated issues proves most users active.
 *   2. An exhaustive per-user VERIFY query runs only for the remaining
 *      candidates, so a wrong answer can't come from the sweep being partial.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const HEADERS = { Accept: 'application/json' };

/**
 * `route` encodes each interpolated query value itself, so values must be
 * passed RAW. A URLSearchParams instance is passed through verbatim, which is
 * the one safe way to build a multi-parameter query string.
 */
export function searchParams(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  return p;
}

function explain(status, body) {
  const detail = body?.errorMessages?.length
    ? ` — ${body.errorMessages.join('; ')}`
    : '';
  if (status === 401 || status === 403) {
    return `Jira refused the request (${status}). The app is probably missing a permission it was granted after install — reinstalling it re-grants the current scopes.${detail}`;
  }
  if (status === 400) return `Jira rejected the query (400)${detail}`;
  return `Jira returned ${status}${detail}`;
}

async function getJson(path) {
  let res;
  try {
    res = await api.asApp().requestJira(path, { headers: HEADERS });
  } catch (err) {
    // No response at all: a dropped connection or platform hiccup. Retry.
    err.retryable = true;
    throw err;
  }

  if (res.status === 429) {
    const err = new Error('Rate limited by Jira');
    err.rateLimited = true;
    err.retryAfter = Math.max(1, Number(res.headers.get('Retry-After')) || 5);
    throw err;
  }
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(explain(res.status, body));
    err.status = res.status;
    // A 5xx is Jira having a moment, not a reason to abandon a scan.
    err.retryable = res.status >= 500;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Who holds a seat
// ---------------------------------------------------------------------------

/**
 * Pure: /applicationrole rows -> the products whose seats we audit.
 * `userCount` is Atlassian's own "users counting against your license".
 */
export function normaliseRoles(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.key && r?.defined !== false)
    .map((r) => ({
      key: r.key,
      name: r.name ?? r.key,
      userCount: Number.isFinite(r.userCount) ? r.userCount : null,
      numberOfSeats: Number.isFinite(r.numberOfSeats) ? r.numberOfSeats : null,
      hasUnlimitedSeats: Boolean(r.hasUnlimitedSeats),
      groups: (r.groupDetails ?? [])
        .filter((g) => g?.groupId)
        .map((g) => ({ groupId: g.groupId, name: g.name ?? g.groupId })),
    }))
    .filter((r) => r.groups.length > 0);
}

export const fetchApplicationRoles = async () =>
  normaliseRoles(await getJson(route`/rest/api/3/applicationrole`));

/**
 * Pure: raw user rows -> seat-consuming accounts.
 * accountType 'app' (bots, Connect) and 'customer' (JSM portal-only) never
 * consume a product seat, so counting them would overstate the bill.
 */
export function filterLicensedUsers(batch) {
  // Only the account ID is kept. Names and emails are looked up live when a
  // report is read (see fetchUsersBulk), so nothing personal beyond the ID
  // is ever written to storage.
  return (Array.isArray(batch) ? batch : [])
    .filter((u) => u?.active === true && u?.accountType === 'atlassian' && u?.accountId)
    .map((u) => ({ accountId: u.accountId }));
}

const BULK_PAGE = 100; // /user/bulk accepts up to 200 IDs; 100 keeps URLs short
const BULK_CONCURRENCY = 5;

/**
 * Resolve display names and emails for account IDs at read time. The result
 * always reflects current profiles and privacy settings, and it means the
 * report at rest contains account IDs and dormancy bands, nothing else.
 */
export async function fetchUsersBulk(accountIds) {
  const ids = [...new Set((accountIds ?? []).filter(Boolean))];
  const chunks = [];
  for (let i = 0; i < ids.length; i += BULK_PAGE) chunks.push(ids.slice(i, i + BULK_PAGE));
  const out = {};
  const fetchChunk = async (chunk) => {
    const params = new URLSearchParams();
    for (const id of chunk) params.append('accountId', id);
    params.set('maxResults', String(BULK_PAGE));
    const body = await getJson(route`/rest/api/3/user/bulk?${params}`);
    for (const u of body?.values ?? []) {
      if (u?.accountId) {
        out[u.accountId] = {
          displayName: u.displayName ?? '(unknown)',
          email: u.emailAddress ?? null,
        };
      }
    }
  };
  for (let i = 0; i < chunks.length; i += BULK_CONCURRENCY) {
    await Promise.all(chunks.slice(i, i + BULK_CONCURRENCY).map(fetchChunk));
  }
  return out;
}

const GROUP_PAGE = 50; // hard API maximum for /group/member

/** One page of a group's members. `rawCount` counts every active account, bots included. */
export async function fetchGroupMemberPage(groupId, startAt) {
  const params = searchParams({ groupId, startAt, maxResults: GROUP_PAGE });
  const body = await getJson(route`/rest/api/3/group/member?${params}`);
  const values = body?.values ?? [];
  return {
    users: filterLicensedUsers(values),
    rawCount: values.length,
    isLast: Boolean(body?.isLast) || values.length < GROUP_PAGE,
    nextStartAt: startAt + GROUP_PAGE,
  };
}

const GROUP_LIST_PAGE = 100;

/**
 * One page of every group on the site, including empty ones. The user export
 * in Atlassian Administration leaves empty groups out; a review must not.
 */
export async function fetchGroupListPage(startAt) {
  const params = searchParams({ startAt, maxResults: GROUP_LIST_PAGE });
  const body = await getJson(route`/rest/api/3/group/bulk?${params}`);
  const values = body?.values ?? [];
  return {
    groups: values.filter((g) => g?.groupId).map((g) => ({ groupId: g.groupId, name: g.name ?? g.groupId })),
    isLast: Boolean(body?.isLast) || values.length < GROUP_LIST_PAGE,
    nextStartAt: startAt + GROUP_LIST_PAGE,
  };
}

/**
 * Fallback only: the whole site directory. Used when application roles are
 * unreadable. It includes Confluence-only accounts, so the report is labelled
 * accordingly rather than presented as seat-accurate.
 */
export async function fetchDirectoryPage(startAt, pageSize) {
  const params = searchParams({ startAt, maxResults: pageSize });
  const batch = await getJson(route`/rest/api/3/users/search?${params}`);
  return {
    users: filterLicensedUsers(batch),
    // Pagination follows the RAW page length, not the filtered length, or a
    // page of bots would end the sweep early.
    isLast: !Array.isArray(batch) || batch.length < pageSize,
  };
}

// ---------------------------------------------------------------------------
// Sweep: what has happened recently, and who did it
// ---------------------------------------------------------------------------

const epoch = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * Pure reducer: a page of issues -> { accountId -> { at, via } }.
 *
 * Only things a person DID count, and only inside the window (`since`).
 * Being assigned is done TO you — the changelog records who did the
 * assigning — so the assignee field alone is not a signal. Creator and
 * reporter are stamped at `created`, which is when that person acted, never
 * at `updated`, which may be someone else's edit.
 *
 * The window matters: `expand=changelog` returns an issue's WHOLE history and
 * `comment` its whole comment list, so a recently updated issue carries the
 * names of everyone who ever touched it. Without the cut-off, a colleague who
 * left two years ago would look active every time someone edits an old
 * ticket they once commented on — the exact person this report exists to find.
 */
export function reduceIssues(issues, since) {
  const activity = {};
  const floor = Number.isFinite(since) ? since : -Infinity;

  const mark = (person, at, via) => {
    const id = person?.accountId;
    const ts = id && at ? epoch(at) : null;
    if (ts === null || ts < floor) return;
    const prev = activity[id];
    if (!prev || ts > prev.ts) activity[id] = { at, via, ts };
  };

  for (const issue of issues ?? []) {
    const f = issue?.fields ?? {};

    for (const h of issue?.changelog?.histories ?? []) {
      mark(h?.author, h?.created, 'edited an issue');
    }
    for (const w of f.worklog?.worklogs ?? []) {
      mark(w?.author, w?.started ?? w?.created, 'logged work');
      mark(w?.updateAuthor, w?.updated, 'logged work');
    }
    for (const c of f.comment?.comments ?? []) {
      mark(c?.author, c?.created, 'commented');
      mark(c?.updateAuthor, c?.updated, 'commented');
    }
    mark(f.creator, f.created, 'created an issue');
    mark(f.reporter, f.created, 'reported an issue');
  }

  for (const entry of Object.values(activity)) delete entry.ts;
  return activity;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the audit window, matching JQL's `updated >= -Nd`. */
export const windowStart = (days, at = Date.now()) => at - Number(days) * DAY_MS;

export const buildSweepJql = (days) =>
  `updated >= -${Number(days)}d ORDER BY updated DESC`;

/** One page of recent issue activity. */
export async function fetchActivityPage(days, nextPageToken, pageSize) {
  const params = searchParams({
    jql: buildSweepJql(days),
    maxResults: pageSize,
    fields: 'creator,reporter,created,comment,worklog',
    expand: 'changelog',
    nextPageToken,
  });
  const body = await getJson(route`/rest/api/3/search/jql?${params}`);
  const issues = body?.issues ?? [];
  return {
    activity: reduceIssues(issues, windowStart(days)),
    count: issues.length,
    nextPageToken: body?.nextPageToken ?? null,
    isLast: Boolean(body?.isLast) || !body?.nextPageToken,
  };
}

// ---------------------------------------------------------------------------
// Verify: an exhaustive per-user check that does not depend on the sweep
// ---------------------------------------------------------------------------

/**
 * Pure. Every clause is something the user DID, scoped to the window.
 * `startOfDay(-Nd)` rather than a bare `-Nd` because the CHANGED predicate
 * is documented against date functions.
 *
 * JQL's CHANGED BY works on exactly six fields — status, assignee, priority,
 * resolution, fix version and reporter — and all six are used, so the only
 * actions this query cannot see are comments and edits to other fields.
 * Those are covered by the sweep; see reduceIssues.
 */
export const CHANGED_FIELDS = ['status', 'assignee', 'priority', 'resolution', 'fixVersion', 'reporter'];

export function buildUserActivityJql(accountId, days) {
  const id = JSON.stringify(String(accountId));
  const n = Number(days);
  return [
    ...CHANGED_FIELDS.map((f) => `${f} CHANGED BY ${id} AFTER startOfDay(-${n}d)`),
    `worklogAuthor = ${id} AND worklogDate >= -${n}d`,
    `creator = ${id} AND created >= -${n}d`,
    `reporter = ${id} AND created >= -${n}d`,
  ]
    .map((c) => `(${c})`)
    .join(' OR ');
}

/** true if the user did anything in Jira within `days`, across ALL issues. */
export async function wasActiveWithin(accountId, days) {
  const params = searchParams({
    jql: buildUserActivityJql(accountId, days),
    maxResults: 1,
    fields: 'id',
  });
  const body = await getJson(route`/rest/api/3/search/jql?${params}`);
  return (body?.issues ?? []).length > 0;
}

/**
 * Pure. Given the audit window and the wider probes that came back inactive
 * or active, name the dormancy band. Severity sorts the report: the longer
 * dormant, the higher up.
 */
export const PROBES = [180, 365];

export function classifyDormancy(days, probeResults) {
  const wider = PROBES.filter((p) => p > days);
  // The band's lower bound is the last probe that found nothing: inactive in
  // 90 and in 180 but active in 365 means 180–365 days, not 90–365.
  let floor = days;
  for (let i = 0; i < wider.length; i++) {
    const p = wider[i];
    if (probeResults[p] === true) {
      return { bucket: `${floor}-${p}`, label: `${floor}–${p} days`, severity: i + 1 };
    }
    floor = p;
  }
  return {
    bucket: `over-${floor}`,
    label: floor >= 365 ? 'Over a year, or never' : `Over ${floor} days`,
    severity: wider.length + 1,
  };
}

/** Runs the probes for a candidate the sweep could not vouch for. */
export async function verifyCandidate(accountId, days) {
  if (await wasActiveWithin(accountId, days)) return { active: true };

  const probeResults = {};
  for (const p of PROBES) {
    if (p <= days) continue;
    probeResults[p] = await wasActiveWithin(accountId, p);
    if (probeResults[p]) break; // found the band; no need to look wider
  }
  return { active: false, ...classifyDormancy(days, probeResults) };
}
