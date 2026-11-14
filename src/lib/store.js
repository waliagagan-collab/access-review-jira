import { kvs } from '@forge/kvs';

/**
 * Storage layer.
 *
 * What a review holds: account IDs, group IDs and names, product names,
 * activity bands, and the reviewers' decisions, notes and timestamps, with
 * the account ID of whoever decided. Display names and emails are never
 * stored; they are resolved from Jira at read time.
 *
 * A stored value is size-limited (about 240 KiB), so everything that grows
 * with the site is split: users and activity by account shard, groups,
 * product grants and review rows into fixed-size pages, decisions by their
 * own shard. A user and every fact about them land in the same shard, so
 * joins are shard-local.
 *
 * Every call goes through `kv`, which tries a failed call again a few times.
 * A decision shard is only changed under its lock (`withLock`).
 */

export const SHARDS = 64;
export const GROUP_PAGE = 250; // groups per stored page: inside the limit at any name length
export const ROW_PAGE = 100; // review rows per stored page: a row lists every group id the person holds
export const DECISION_SHARDS = 64;
const PARALLEL = 8;

export const shardOf = (accountId, shards = SHARDS) => {
  let h = 0;
  for (let i = 0; i < accountId.length; i++) {
    h = (h * 31 + accountId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % shards;
};

/** Pure: split a list into pages of `size`. */
export const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < (items ?? []).length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Run `fn` over `items` with at most `limit` in flight; results in order. */
async function inParallel(items, limit, fn) {
  const out = [];
  for (const batch of chunk(items, limit)) out.push(...(await Promise.all(batch.map(fn))));
  return out;
}

const range = (n) => Array.from({ length: Math.max(0, n) }, (_, i) => i);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits and limits, in one place so tests can shorten them. */
export const TIMING = {
  retries: 3, // extra attempts for a storage call that fails
  retryMs: 200, // first pause; doubles each time
  lockStaleMs: 15_000, // a lock older than this belongs to an invocation that died
  lockWaitMs: 150, // pause between attempts to take a lock
  lockTries: 60, // about nine seconds in all
};

/**
 * A storage call that fails is tried again a few times with a short pause
 * before the error is passed on. A request the service refuses outright (a
 * value that is too large, a bad key) is not tried again: it cannot succeed.
 */
async function retrying(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.responseDetails?.status;
      const refused = status >= 400 && status < 500 && status !== 429;
      if (refused || attempt >= TIMING.retries) throw err;
      await sleep(TIMING.retryMs * 2 ** attempt);
    }
  }
}

const kv = {
  get: (key) => retrying(() => kvs.get(key)),
  set: (key, value) => retrying(() => kvs.set(key, value)),
  delete: (key) => retrying(() => kvs.delete(key)),
};

/**
 * Run `fn` while holding a lock on `key`, so a read-change-write of one
 * stored value never interleaves with another.
 *
 * The lock is a key written with FAIL_IF_EXISTS and read back to confirm it
 * is ours. Its value carries the time it was taken: a lock older than
 * `lockStaleMs` belongs to an invocation that died, so it is deleted and
 * taken again. A key's TTL is not used for this, because expired keys can
 * linger. The lock is released in `finally`.
 */
export async function withLock(key, fn, { tries = TIMING.lockTries } = {}) {
  const name = `${key}:lock`;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let takenAt = 0;
  for (let i = 0; i < tries && !takenAt; i++) {
    try {
      await kvs.set(name, { token, at: Date.now() }, { keyPolicy: 'FAIL_IF_EXISTS' });
    } catch {
      // Held by someone else, or the write failed: the read below decides.
    }
    const held = await kv.get(name);
    if (held?.token === token) {
      takenAt = Date.now();
    } else if (held && Date.now() - (Number(held.at) || 0) > TIMING.lockStaleMs) {
      await kv.delete(name);
    } else if (i < tries - 1) {
      await sleep(TIMING.lockWaitMs);
    }
  }
  if (!takenAt) {
    const err = new Error('Another change is being saved.');
    err.busy = true;
    throw err;
  }
  try {
    return await fn();
  } finally {
    // Held past the stale limit, someone may have taken it over: leave theirs alone.
    if (Date.now() - takenAt < TIMING.lockStaleMs) {
      try {
        await kvs.delete(name);
      } catch {
        // It goes stale and is taken over.
      }
    }
  }
}

const groupByShard = (items, idOf, shards = SHARDS) => {
  const m = new Map();
  for (const it of items) {
    const s = shardOf(idOf(it), shards);
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(it);
  }
  return m;
};

// ---------------------------------------------------------------------------
// A snapshot in progress
// ---------------------------------------------------------------------------

export const SCAN_KEY = 'scan:state';
const usersKey = (run, s) => `scan:${run}:users:${s}`;
const activeKey = (run, s) => `scan:${run}:active:${s}`;
const groupPageKey = (run, i) => `scan:${run}:groups:${i}`;
const grantPageKey = (run, i) => `scan:${run}:grants:${i}`;
const GRANT_PAGE = 1000; // product-granting groups per stored page

export const getScanState = () => kv.get(SCAN_KEY);
export const setScanState = (state) =>
  kv.set(SCAN_KEY, { ...state, updatedAt: new Date().toISOString() });

/**
 * Upsert users, unioning product and group membership. Called once per
 * invocation with everything that invocation collected; distinct shards are
 * written in parallel.
 */
export async function upsertUsers(run, users) {
  await inParallel([...groupByShard(users, (u) => u.accountId)], PARALLEL, async ([s, batch]) => {
    const key = usersKey(run, s);
    const existing = (await kv.get(key)) ?? {};
    for (const u of batch) {
      const prev = existing[u.accountId];
      const products = new Set([...(prev?.products ?? []), ...(u.products ?? [])]);
      const groups = new Set([...(prev?.groups ?? []), ...(u.groups ?? [])]);
      existing[u.accountId] = { products: [...products], groups: [...groups] };
    }
    await kv.set(key, existing);
  });
}

/** Pure: keep the latest timestamp per account. */
export function mergeActive(existing, latest) {
  const out = { ...(existing ?? {}) };
  for (const [id, at] of Object.entries(latest ?? {})) {
    if (!out[id] || Date.parse(at) > Date.parse(out[id])) out[id] = at;
  }
  return out;
}

/** Record accounts the sweep proved active, with when they were last seen acting. */
export async function markActive(run, latestById) {
  const entries = Object.entries(latestById ?? {});
  await inParallel([...groupByShard(entries, ([id]) => id)], PARALLEL, async ([s, batch]) => {
    const key = activeKey(run, s);
    await kv.set(key, mergeActive(await kv.get(key), Object.fromEntries(batch)));
  });
}

export const getShardUsers = async (run, s) => (await kv.get(usersKey(run, s))) ?? {};
export const getShardActive = async (run, s) => (await kv.get(activeKey(run, s))) ?? {};

/** The groups found so far, in pages. A page is rewritten whole when member counts land. */
export const getGroupPage = async (run, i) => (await kv.get(groupPageKey(run, i))) ?? [];
export const setGroupPage = (run, i, groups) => kv.set(groupPageKey(run, i), groups);

/**
 * Which groups grant which product: { groupId -> product names }. Kept in
 * pages of its own, not in the scan record, so a site that grants access
 * through thousands of groups stays inside the value size limit. Returns the
 * number of pages written.
 */
export async function setGrants(run, grants) {
  const pages = chunk(Object.entries(grants ?? {}), GRANT_PAGE);
  await inParallel(range(pages.length), PARALLEL, (i) => kv.set(grantPageKey(run, i), pages[i]));
  return pages.length;
}

export async function getGrants(run, pages = 0) {
  const stored = await inParallel(range(pages), PARALLEL, (i) => kv.get(grantPageKey(run, i)));
  return Object.fromEntries(stored.flatMap((p) => p ?? []));
}

export async function clearRun(run, groupPages = 0, grantPages = 0) {
  const keys = [];
  for (const s of range(SHARDS)) keys.push(usersKey(run, s), activeKey(run, s));
  for (const i of range(groupPages)) keys.push(groupPageKey(run, i));
  for (const i of range(grantPages)) keys.push(grantPageKey(run, i));
  await inParallel(keys, PARALLEL, (k) => kv.delete(k));
}

// ---------------------------------------------------------------------------
// Reviews: a snapshot plus the decisions made on it
// ---------------------------------------------------------------------------

const REVIEWS_INDEX = 'reviews:index';
export const KEEP_REVIEWS = 12;
export const metaKey = (id) => `review:${id}:meta`;
export const rowsKey = (id, i) => `review:${id}:rows:${i}`;
const groupsKey = (id, i) => `review:${id}:groups:${i}`;
export const decisionsKey = (id, s) => `review:${id}:decisions:${s}`;

export const listReviewIds = async () => (await kv.get(REVIEWS_INDEX)) ?? [];

/** Reviews saved before decisions had their own shard count used the scan's 16. */
export const decisionShardsOf = (meta) => Number(meta?.decisionShards) || 16;

/**
 * Pure: which reviews to remove so that at most `keep` remain. `reviews` is
 * newest first; the first one is the review being saved and is never removed.
 * The oldest review that is not signed off goes first. A signed-off review is
 * never removed here, so the list can stay over the cap until an admin
 * deletes one (starting a new review is refused in that state).
 */
export function reviewsToDrop(reviews, keep = KEEP_REVIEWS) {
  const drop = [];
  for (let i = (reviews ?? []).length - 1; i >= 1 && reviews.length - drop.length > keep; i--) {
    if (reviews[i].status !== 'complete') drop.push(reviews[i].id);
  }
  return drop;
}

/**
 * Publish a review: page its rows and groups, record it newest-first, and
 * make room (see `reviewsToDrop`). Safe to run twice for the same snapshot: a
 * review whose record already exists was published whole by an earlier
 * attempt and is not written again, so decisions and a sign-off made since
 * are kept.
 */
export async function saveReview(meta, rows, groups) {
  if (!(await getReviewMeta(meta.id))) {
    const rowPages = chunk(rows, ROW_PAGE);
    const groupPages = chunk(groups ?? [], GROUP_PAGE);
    await inParallel(range(rowPages.length), PARALLEL, (i) => kv.set(rowsKey(meta.id, i), rowPages[i]));
    await inParallel(range(groupPages.length), PARALLEL, (i) => kv.set(groupsKey(meta.id, i), groupPages[i]));
    await kv.set(metaKey(meta.id), {
      ...meta,
      pages: rowPages.length,
      pageSize: ROW_PAGE,
      rowCount: rows.length,
      groupPages: groupPages.length,
      groupCount: (groups ?? []).length,
      decisionShards: DECISION_SHARDS,
    });
  }
  const index = (await listReviewIds()).filter((id) => id !== meta.id);
  index.unshift(meta.id);
  let dropped = [];
  if (index.length > KEEP_REVIEWS) {
    const metas = await inParallel(index, PARALLEL, (id) => getReviewMeta(id));
    dropped = reviewsToDrop(index.map((id, i) => ({ id, status: metas[i]?.status })));
  }
  await kv.set(REVIEWS_INDEX, index.filter((id) => !dropped.includes(id)));
  for (const id of dropped) await deleteReview(id, { fromIndex: false });
}

export const getReviewMeta = (id) => kv.get(metaKey(id));

export async function setReviewMeta(id, patch) {
  const meta = await getReviewMeta(id);
  if (!meta) return null;
  const next = { ...meta, ...patch, updatedAt: new Date().toISOString() };
  await kv.set(metaKey(id), next);
  return next;
}

/** Rows from stored pages `from` (inclusive) to `to` (exclusive). */
export async function getReviewRowPages(id, from, to) {
  const meta = await getReviewMeta(id);
  const last = Math.min(to, meta?.pages ?? 0);
  const idx = [];
  for (let i = from; i < last; i++) idx.push(i);
  const pages = await inParallel(idx, PARALLEL, (i) => kv.get(rowsKey(id, i)));
  return pages.flatMap((p) => p ?? []);
}

export const getReviewRows = (id) => getReviewRowPages(id, 0, Infinity);

/** Every group in the snapshot. Reviews saved before groups were paged hold them in the record itself. */
export async function getReviewGroups(meta) {
  if (!meta) return [];
  if (Array.isArray(meta.groups)) return meta.groups;
  const pages = await inParallel(range(meta.groupPages ?? 0), PARALLEL, (i) => kv.get(groupsKey(meta.id, i)));
  return pages.flatMap((p) => p ?? []);
}

export async function listReviews() {
  const metas = await inParallel(await listReviewIds(), PARALLEL, (id) => getReviewMeta(id));
  return metas.filter(Boolean);
}

export async function deleteReview(id, { fromIndex = true } = {}) {
  const meta = await getReviewMeta(id);
  const keys = [];
  for (const i of range(meta?.pages ?? 0)) keys.push(rowsKey(id, i));
  for (const i of range(meta?.groupPages ?? 0)) keys.push(groupsKey(id, i));
  for (const s of range(decisionShardsOf(meta))) keys.push(decisionsKey(id, s), `${decisionsKey(id, s)}:lock`);
  await inParallel(keys, PARALLEL, (k) => kv.delete(k));
  await kv.delete(metaKey(id));
  if (fromIndex) await kv.set(REVIEWS_INDEX, (await listReviewIds()).filter((x) => x !== id));
}

/** { accountId -> { decision, note, by, at } } for a review. */
export async function getDecisions(meta) {
  const shards = await inParallel(range(decisionShardsOf(meta)), PARALLEL, (s) => kv.get(decisionsKey(meta.id, s)));
  return Object.assign({}, ...shards.map((x) => x ?? {}));
}

/**
 * The same, but each shard is read under its lock, so a write that is in
 * flight has landed before the shard is read. Sign-off counts with this.
 */
export async function getDecisionsSettled(meta) {
  const shards = await inParallel(range(decisionShardsOf(meta)), PARALLEL, (s) => {
    const key = decisionsKey(meta.id, s);
    return withLock(key, () => kv.get(key));
  });
  return Object.assign({}, ...shards.map((x) => x ?? {}));
}

/**
 * Record decisions; a null decision clears the entry. Each shard is read,
 * changed and written under that shard's lock, so two saves that touch the
 * same shard at the same moment both land. Under the lock the review record
 * is read again: once a review is signed off nothing more is written to it.
 * With `onlyUnset`, an existing decision is never overwritten (bulk marking).
 * Returns how many entries were written, and whether a sign-off stopped any.
 */
export async function setDecisions(meta, entries, { onlyUnset = false } = {}) {
  const shards = decisionShardsOf(meta);
  let signedOff = false;
  const written = await inParallel([...groupByShard(entries, (e) => e.accountId, shards)], PARALLEL, ([s, batch]) => {
    const key = decisionsKey(meta.id, s);
    return withLock(key, async () => {
      const fresh = await getReviewMeta(meta.id);
      if (!fresh || fresh.status === 'complete') {
        signedOff = true;
        return 0;
      }
      const existing = (await kv.get(key)) ?? {};
      let count = 0;
      for (const e of batch) {
        if (onlyUnset && existing[e.accountId]?.decision) continue;
        if (e.decision) existing[e.accountId] = { decision: e.decision, note: e.note ?? '', by: e.by ?? null, at: e.at };
        else delete existing[e.accountId];
        count += 1;
      }
      if (count) await kv.set(key, existing);
      return count;
    });
  });
  return { count: written.reduce((a, b) => a + b, 0), signedOff };
}

// ---------------------------------------------------------------------------
// When a change the personal data report must not cross last started: a
// snapshot started or cancelled, a bulk decision, a sign-off, a reopen or a
// delete. Only the time, no account: the weekly report does not erase while
// one may still be running (busy in personal-data.js), since each writes from
// what it read a moment before. Single decisions need no note: they are
// written under their shard's lock, which erasing takes too.
// ---------------------------------------------------------------------------

export const ACTION_KEY = 'action:started';

export const markActionStarted = () => kv.set(ACTION_KEY, { at: new Date().toISOString() });
export const getActionStarted = () => kv.get(ACTION_KEY);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'settings';

export const getSettings = async () => (await kv.get(SETTINGS_KEY)) ?? {};

export async function saveSettings(settings) {
  await kv.set(SETTINGS_KEY, settings);
  return settings;
}
