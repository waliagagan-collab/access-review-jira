import { kvs } from '@forge/kvs';

/**
 * Storage layer.
 *
 * Rule: never store anything a customer authored, and nothing personal beyond
 * the account ID. A review holds account ids, group ids, product names,
 * activity bands and the reviewers' decisions and notes. Display names and
 * emails are resolved from Jira at read time.
 *
 * Values are sharded because a KVS value is size-limited and a large site
 * holds thousands of accounts. A user and every fact about them always land
 * in the same shard, so joins are shard-local.
 */

export const SHARDS = 16;

export const shardOf = (accountId) => {
  let h = 0;
  for (let i = 0; i < accountId.length; i++) {
    h = (h * 31 + accountId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % SHARDS;
};

export const SCAN_KEY = 'scan:state';
const usersKey = (run, s) => `scan:${run}:users:${s}`;
const activeKey = (run, s) => `scan:${run}:active:${s}`;

export const getScanState = () => kvs.get(SCAN_KEY);
export const setScanState = (state) =>
  kvs.set(SCAN_KEY, { ...state, updatedAt: new Date().toISOString() });

const groupByShard = (items, idOf) => {
  const m = new Map();
  for (const it of items) {
    const s = shardOf(idOf(it));
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(it);
  }
  return m;
};

/**
 * Upsert users, unioning product and group membership. Called once per
 * invocation with everything that invocation collected, so a slice costs at
 * most 16 writes.
 */
export async function upsertUsers(run, users) {
  for (const [s, batch] of groupByShard(users, (u) => u.accountId)) {
    const key = usersKey(run, s);
    const existing = (await kvs.get(key)) ?? {};
    for (const u of batch) {
      const prev = existing[u.accountId];
      const products = new Set([...(prev?.products ?? []), ...(u.products ?? [])]);
      const groups = new Set([...(prev?.groups ?? []), ...(u.groups ?? [])]);
      existing[u.accountId] = { products: [...products], groups: [...groups] };
    }
    await kvs.set(key, existing);
  }
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
  for (const [s, batch] of groupByShard(entries, ([id]) => id)) {
    const key = activeKey(run, s);
    await kvs.set(key, mergeActive(await kvs.get(key), Object.fromEntries(batch)));
  }
}

export const getShardUsers = async (run, s) => (await kvs.get(usersKey(run, s))) ?? {};
export const getShardActive = async (run, s) => (await kvs.get(activeKey(run, s))) ?? {};

export async function clearRun(run) {
  for (let s = 0; s < SHARDS; s++) {
    await kvs.delete(usersKey(run, s));
    await kvs.delete(activeKey(run, s));
  }
}

// ---------------------------------------------------------------------------
// Reviews: a snapshot plus the decisions made on it
// ---------------------------------------------------------------------------

const REVIEWS_INDEX = 'reviews:index';
const KEEP_REVIEWS = 12;
const ROW_PAGE = 250;
const metaKey = (id) => `review:${id}:meta`;
const rowsKey = (id, i) => `review:${id}:rows:${i}`;
const decisionsKey = (id, s) => `review:${id}:decisions:${s}`;

export const listReviewIds = async () => (await kvs.get(REVIEWS_INDEX)) ?? [];

/** Publish a review: page its rows, record it newest-first, drop the oldest beyond the cap. */
export async function saveReview(meta, rows) {
  const pages = Math.max(1, Math.ceil(rows.length / ROW_PAGE));
  for (let i = 0; i < pages; i++) await kvs.set(rowsKey(meta.id, i), rows.slice(i * ROW_PAGE, (i + 1) * ROW_PAGE));
  await kvs.set(metaKey(meta.id), { ...meta, pages, pageSize: ROW_PAGE, rowCount: rows.length });
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

export async function getReviewRows(id, limit = Infinity) {
  const meta = await getReviewMeta(id);
  const rows = [];
  for (let i = 0; i < (meta?.pages ?? 0) && rows.length < limit; i++) {
    rows.push(...((await kvs.get(rowsKey(id, i))) ?? []));
  }
  return rows.slice(0, limit);
}

export async function listReviews() {
  const metas = [];
  for (const id of await listReviewIds()) {
    const m = await getReviewMeta(id);
    if (m) metas.push(m);
  }
  return metas;
}

export async function deleteReview(id, { fromIndex = true } = {}) {
  const meta = await getReviewMeta(id);
  for (let i = 0; i < (meta?.pages ?? 0); i++) await kvs.delete(rowsKey(id, i));
  for (let s = 0; s < SHARDS; s++) await kvs.delete(decisionsKey(id, s));
  await kvs.delete(metaKey(id));
  if (fromIndex) await kvs.set(REVIEWS_INDEX, (await listReviewIds()).filter((x) => x !== id));
}

/** { accountId -> { decision, note, by, at } } for a review. */
export async function getDecisions(id) {
  const out = {};
  for (let s = 0; s < SHARDS; s++) Object.assign(out, (await kvs.get(decisionsKey(id, s))) ?? {});
  return out;
}

/** Record decisions; a null decision clears the entry. One write per touched shard. */
export async function setDecisions(id, entries) {
  for (const [s, batch] of groupByShard(entries, (e) => e.accountId)) {
    const key = decisionsKey(id, s);
    const existing = (await kvs.get(key)) ?? {};
    for (const e of batch) {
      if (e.decision) existing[e.accountId] = { decision: e.decision, note: e.note ?? '', by: e.by ?? null, at: e.at };
      else delete existing[e.accountId];
    }
    await kvs.set(key, existing);
  }
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
