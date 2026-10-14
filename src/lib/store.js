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
 * with the site is split: users and activity by account shard, groups and
 * review rows into fixed-size pages, decisions by their own shard. A user and
 * every fact about them land in the same shard, so joins are shard-local.
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

export const getScanState = () => kvs.get(SCAN_KEY);
export const setScanState = (state) =>
  kvs.set(SCAN_KEY, { ...state, updatedAt: new Date().toISOString() });

/**
 * Upsert users, unioning product and group membership. Called once per
 * invocation with everything that invocation collected; distinct shards are
 * written in parallel.
 */
export async function upsertUsers(run, users) {
  await inParallel([...groupByShard(users, (u) => u.accountId)], PARALLEL, async ([s, batch]) => {
    const key = usersKey(run, s);
    const existing = (await kvs.get(key)) ?? {};
    for (const u of batch) {
      const prev = existing[u.accountId];
      const products = new Set([...(prev?.products ?? []), ...(u.products ?? [])]);
      const groups = new Set([...(prev?.groups ?? []), ...(u.groups ?? [])]);
      existing[u.accountId] = { products: [...products], groups: [...groups] };
    }
    await kvs.set(key, existing);
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
    await kvs.set(key, mergeActive(await kvs.get(key), Object.fromEntries(batch)));
  });
}

export const getShardUsers = async (run, s) => (await kvs.get(usersKey(run, s))) ?? {};
export const getShardActive = async (run, s) => (await kvs.get(activeKey(run, s))) ?? {};

/** The groups found so far, in pages. A page is rewritten whole when member counts land. */
export const getGroupPage = async (run, i) => (await kvs.get(groupPageKey(run, i))) ?? [];
export const setGroupPage = (run, i, groups) => kvs.set(groupPageKey(run, i), groups);

export async function clearRun(run, groupPages = 0) {
  const keys = [];
  for (const s of range(SHARDS)) keys.push(usersKey(run, s), activeKey(run, s));
  for (const i of range(groupPages)) keys.push(groupPageKey(run, i));
  await inParallel(keys, PARALLEL, (k) => kvs.delete(k));
}

// ---------------------------------------------------------------------------
// Reviews: a snapshot plus the decisions made on it
// ---------------------------------------------------------------------------

const REVIEWS_INDEX = 'reviews:index';
const KEEP_REVIEWS = 12;
const metaKey = (id) => `review:${id}:meta`;
const rowsKey = (id, i) => `review:${id}:rows:${i}`;
const groupsKey = (id, i) => `review:${id}:groups:${i}`;
const decisionsKey = (id, s) => `review:${id}:decisions:${s}`;

export const listReviewIds = async () => (await kvs.get(REVIEWS_INDEX)) ?? [];

/** Reviews saved before decisions had their own shard count used the scan's 16. */
export const decisionShardsOf = (meta) => Number(meta?.decisionShards) || 16;

/** Publish a review: page its rows and groups, record it newest-first, drop the oldest beyond the cap. */
export async function saveReview(meta, rows, groups) {
  const rowPages = chunk(rows, ROW_PAGE);
  const groupPages = chunk(groups ?? [], GROUP_PAGE);
  await inParallel(range(rowPages.length), PARALLEL, (i) => kvs.set(rowsKey(meta.id, i), rowPages[i]));
  await inParallel(range(groupPages.length), PARALLEL, (i) => kvs.set(groupsKey(meta.id, i), groupPages[i]));
  await kvs.set(metaKey(meta.id), {
    ...meta,
    pages: rowPages.length,
    pageSize: ROW_PAGE,
    rowCount: rows.length,
    groupPages: groupPages.length,
    groupCount: (groups ?? []).length,
    decisionShards: DECISION_SHARDS,
  });
  const index = (await listReviewIds()).filter((id) => id !== meta.id);
  index.unshift(meta.id);
  const dropped = index.splice(KEEP_REVIEWS);
  await kvs.set(REVIEWS_INDEX, index);
  for (const id of dropped) await deleteReview(id, { fromIndex: false });
}

export const getReviewMeta = (id) => kvs.get(metaKey(id));

export async function setReviewMeta(id, patch) {
  const meta = await getReviewMeta(id);
  if (!meta) return null;
  const next = { ...meta, ...patch, updatedAt: new Date().toISOString() };
  await kvs.set(metaKey(id), next);
  return next;
}

/** Rows from stored pages `from` (inclusive) to `to` (exclusive). */
export async function getReviewRowPages(id, from, to) {
  const meta = await getReviewMeta(id);
  const last = Math.min(to, meta?.pages ?? 0);
  const idx = [];
  for (let i = from; i < last; i++) idx.push(i);
  const pages = await inParallel(idx, PARALLEL, (i) => kvs.get(rowsKey(id, i)));
  return pages.flatMap((p) => p ?? []);
}

export const getReviewRows = (id) => getReviewRowPages(id, 0, Infinity);

/** Every group in the snapshot. Reviews saved before groups were paged hold them in the record itself. */
export async function getReviewGroups(meta) {
  if (!meta) return [];
  if (Array.isArray(meta.groups)) return meta.groups;
  const pages = await inParallel(range(meta.groupPages ?? 0), PARALLEL, (i) => kvs.get(groupsKey(meta.id, i)));
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
  for (const s of range(decisionShardsOf(meta))) keys.push(decisionsKey(id, s));
  await inParallel(keys, PARALLEL, (k) => kvs.delete(k));
  await kvs.delete(metaKey(id));
  if (fromIndex) await kvs.set(REVIEWS_INDEX, (await listReviewIds()).filter((x) => x !== id));
}

/** { accountId -> { decision, note, by, at } } for a review. */
export async function getDecisions(meta) {
  const shards = await inParallel(range(decisionShardsOf(meta)), PARALLEL, (s) => kvs.get(decisionsKey(meta.id, s)));
  return Object.assign({}, ...shards.map((x) => x ?? {}));
}

/**
 * Record decisions; a null decision clears the entry. Each shard is read and
 * written straight back, so two reviewers on the same review only collide
 * when they touch the same shard at the same moment. With `onlyUnset`, an
 * existing decision is never overwritten (bulk marking). Returns how many
 * entries were written.
 */
export async function setDecisions(meta, entries, { onlyUnset = false } = {}) {
  const shards = decisionShardsOf(meta);
  const written = await inParallel([...groupByShard(entries, (e) => e.accountId, shards)], PARALLEL, async ([s, batch]) => {
    const key = decisionsKey(meta.id, s);
    const existing = (await kvs.get(key)) ?? {};
    let count = 0;
    for (const e of batch) {
      if (onlyUnset && existing[e.accountId]?.decision) continue;
      if (e.decision) existing[e.accountId] = { decision: e.decision, note: e.note ?? '', by: e.by ?? null, at: e.at };
      else delete existing[e.accountId];
      count += 1;
    }
    if (count) await kvs.set(key, existing);
    return count;
  });
  return written.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'settings';

export const getSettings = async () => (await kvs.get(SETTINGS_KEY)) ?? {};

export async function saveSettings(settings) {
  await kvs.set(SETTINGS_KEY, settings);
  return settings;
}
