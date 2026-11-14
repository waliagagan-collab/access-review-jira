import { kvs } from '@forge/kvs';
import {
  SCAN_KEY,
  metaKey,
  rowsKey,
  decisionsKey,
  decisionShardsOf,
  shardOf,
  withLock,
  getScanState,
  getActionStarted,
} from './store.js';
import { STALE_AFTER_MS } from './scan.js';
import { closedMarker, isClosedAccount } from './review.js';

/**
 * Where this app keeps Atlassian account IDs, for the weekly personal data
 * report (lib/privacy.js), and what is erased when Atlassian says an account
 * was closed:
 *
 *   scan:state                 the snapshot in progress or the last one: the admin who started it
 *                              (`startedBy`), cleared to null with `startedByClosed` set, so the
 *                              review it makes says "Closed account". An error text from Jira can
 *                              quote an account ID: it becomes "(closed account)".
 *   scan:{run}:users:{s}       working data of a snapshot: every group member, by account ID
 *   scan:{run}:active:{s}      working data: what each member did, by account ID
 *                              A closed account is taken out of each.
 *   review:{id}:rows:{i}       a page of a review, one row per person. A closed person's row stays,
 *                              with the account ID replaced by a marker that holds only the row's
 *                              place (closedMarker in review.js).
 *   review:{id}:decisions:{s}  each person's decision, note, who decided (`by`) and when. A closed
 *                              person's decision moves to the marker of their row and their note is
 *                              erased. A closed admin's `by` is cleared to null with `byClosed` set.
 *                              An account ID quoted in a note becomes "(closed account)".
 *   review:{id}:meta           the review record: who started it, signed it off and reopened it,
 *                              the earlier sign-offs, and who was added, gone, joined an admin
 *                              group or gained a Jira product since the review before. A closed
 *                              admin is cleared to null with `startedByClosed`, `completedByClosed`
 *                              or `reopenedByClosed` set; a closed account leaves the lists of
 *                              changes, and their counts stay.
 *
 * No account ID is kept in a snapshot's group and grant pages
 * (`scan:{run}:groups:{i}`, `scan:{run}:grants:{i}`: group IDs, names and
 * Jira products), in a review's group pages (`review:{id}:groups:{i}`), in
 * `reviews:index` (review IDs), in the locks (`scan:state:lock`,
 * `review:{id}:decisions:{s}:lock`: a token and a time), in `action:started`
 * (a time), in `settings` (the day the review request was closed) or in a
 * queue event (a run ID and a number). The report's own pdr: values are
 * looked after by lib/privacy.js.
 *
 * A signed-off review is evidence an admin signed, so nothing is taken out of
 * it: the closed person's row, decision and the review's totals stay, and only
 * the account ID, the note and the name of a closed admin go. Open reviews are
 * treated the same way. Many are signed off later, and a reopened one carries
 * the totals of its earlier sign-offs: with every row kept, the rows, the
 * decisions and those totals still agree. An open review's closed row can
 * still be decided, without a note. A snapshot still running is working data,
 * not evidence: a closed account is taken out of it, and the review it makes
 * does not list them, as their seat is gone.
 *
 * Within a review the decisions, the rows and the record are changed in that
 * order, in one go (eraseReview): a decision moves to its marker before the
 * row that names the marker changes, and the record keeps the lists of
 * changes until the rows have taken their flags from them. A run cut short is
 * ended by the next one, which finds the same markers: a marker comes from the
 * row's place, which never changes.
 *
 * A snapshot writes its state, its working data and, at the end, a review; a
 * sign-off, a reopen, a bulk decision and a delete write from what they read
 * a moment before. So erasing waits while any of them may be running (busy),
 * and asks again before it changes rows or a record. A single decision is
 * written under its shard's lock, which erasing takes too.
 */

// --- which value a key holds ----------------------------------------------------

/** Pure: what kind of value a stored key holds, or null when it holds no account ID. */
export function kindOf(key) {
  const k = String(key ?? '');
  if (k === SCAN_KEY) return 'scanState';
  if (/^scan:[^:]+:(users|active):\d+$/.test(k)) return 'byAccount';
  if (/^review:[^:]+:meta$/.test(k)) return 'meta';
  if (/^review:[^:]+:rows:\d+$/.test(k)) return 'rows';
  if (/^review:[^:]+:decisions:\d+$/.test(k)) return 'decisions';
  return null;
}

const reviewOf = (key) => String(key).split(':')[1];
const pageOf = (key) => Number(String(key).split(':').pop());

// --- pure: the account IDs in each kind of value ----------------------------------

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const rowsOf = (v) => (Array.isArray(v) ? v : []);
const accountsOf = (v) => (isObject(v) ? Object.keys(v) : []);
const valuesOf = (v) => (isObject(v) ? Object.values(v) : []);

/**
 * An account ID inside a text: Jira's error messages can quote the one in a
 * query, and an admin may paste one into a note. Only the two forms Atlassian
 * gives out are read (24 hex digits, or a number, a colon and a UUID), so no
 * word is ever taken for an account ID.
 */
const ID_IN_TEXT = /(?<![A-Za-z0-9:_-])(?:[0-9a-f]{24}|\d{1,10}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![A-Za-z0-9:_-])/gi;
const idsInText = (text) => (typeof text === 'string' ? (text.match(ID_IN_TEXT) ?? []) : []);
/** The texts a scan state keeps: the reason it failed, and why its next slice could not be queued. */
const TEXTS = ['error', 'pauseReason'];
/** The "who" fields of a review record, and of each earlier sign-off in it. */
const META_WHO = ['startedBy', 'completedBy', 'reopenedBy'];
const SIGNOFF_WHO = ['completedBy', 'reopenedBy'];
/** The lists of changes since the review before (capped at 500 each); the counts beside them hold no account. */
const CHANGE_LISTS = ['added', 'removed', 'becameAdmin'];

const changeIds = (c) => [...CHANGE_LISTS.flatMap((f) => rowsOf(c?.[f])), ...rowsOf(c?.gainedProducts).map((g) => g?.accountId)];

const IDS = {
  scanState: (s) => [s?.startedBy, ...TEXTS.flatMap((f) => idsInText(s?.[f]))],
  byAccount: accountsOf,
  meta: (m) => [...META_WHO.map((f) => m?.[f]), ...rowsOf(m?.signoffs).flatMap((s) => SIGNOFF_WHO.map((f) => s?.[f])), ...changeIds(m?.changes)],
  rows: (v) => rowsOf(v).map((r) => r?.accountId),
  decisions: (v) => [...accountsOf(v), ...valuesOf(v).flatMap((d) => [d?.by, ...idsInText(d?.note)])],
};

/** Pure: the account IDs a stored value holds. A marker is not an account (the engine keeps only IDs shaped like one). */
export function idsIn(key, value) {
  const kind = kindOf(key);
  return kind ? IDS[kind](value).filter((id) => typeof id === 'string' && !isClosedAccount(id)) : [];
}

// --- pure: a value without the closed accounts --------------------------------------

/** What a stored text says where it quoted a closed account. */
export const CLOSED_TEXT = '(closed account)';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text with the closed accounts replaced: those in Atlassian's forms, and `also` (the admin a value names) in whatever form. */
function textWithout(text, closed, also = []) {
  if (typeof text !== 'string' || !text) return text;
  let out = text.replace(ID_IN_TEXT, (id) => (closed.has(id) ? CLOSED_TEXT : id));
  for (const id of also) {
    if (typeof id === 'string' && id && closed.has(id) && out.includes(id)) {
      out = out.replace(new RegExp(`(?<![A-Za-z0-9:_-])${escape(id)}(?![A-Za-z0-9:_-])`, 'g'), CLOSED_TEXT);
    }
  }
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A "who" field that names a closed admin: cleared to null, and `<field>Closed` set so screens say "Closed account". */
function withoutWho(value, fields, closed) {
  const out = { ...value };
  for (const f of fields) if (closed.has(value[f])) Object.assign(out, { [f]: null, [`${f}Closed`]: true });
  return out;
}

/** Pure: one decision with a closed admin cleared and closed accounts taken out of its note. */
function decisionWithout(d, closed) {
  const out = withoutWho(d, ['by'], closed);
  if (typeof d.note === 'string') out.note = textWithout(d.note, closed);
  return out;
}

/** Pure: a closed person's decision as it moves to the marker of their row: the decision and when stay, the note goes. */
export const movedDecision = (d, closed) => ({ ...decisionWithout(d, closed), note: '' });

/**
 * Pure: a decision shard without the closed accounts. The entry of a closed
 * person goes from here: eraseReview has written it under their row's marker
 * first. One whose person has no row in the review goes with nothing in its
 * place.
 */
export function scrubDecisions(shard, closed) {
  if (!isObject(shard)) return undefined;
  const out = {};
  for (const [accountId, d] of Object.entries(shard)) {
    if (closed.has(accountId)) continue;
    out[accountId] = isObject(d) ? decisionWithout(d, closed) : d;
  }
  return same(out, shard) ? undefined : out;
}

/**
 * Pure: a page of review rows with each closed person's account ID replaced
 * by their marker. The row keeps everything else. A review saved before rows
 * carried their own change flags keeps them in its record's lists, which lose
 * the account: `changes` (those lists) puts the flags on the row first.
 */
export function scrubRows(rows, page, closed, changes = null) {
  const all = rowsOf(rows);
  if (!all.some((r) => closed.has(r?.accountId))) return undefined;
  return all.map((r, i) => (closed.has(r?.accountId) ? { ...flagsFrom(r, changes), accountId: closedMarker(page, i) } : r));
}

function flagsFrom(r, c) {
  const out = { ...r };
  if (!isObject(c)) return out;
  if (out.newSinceLast === undefined && rowsOf(c.added).includes(r.accountId)) out.newSinceLast = true;
  if (out.becameAdmin === undefined && rowsOf(c.becameAdmin).includes(r.accountId)) out.becameAdmin = true;
  const gained = rowsOf(c.gainedProducts).find((g) => g?.accountId === r.accountId);
  if (out.gainedProducts === undefined && rowsOf(gained?.products).length) out.gainedProducts = gained.products;
  return out;
}

/** Pure: a review record without the closed accounts. The counts and totals stay as they were. */
export function scrubMeta(m, closed) {
  if (!isObject(m)) return undefined;
  const out = withoutWho(m, META_WHO, closed);
  if (Array.isArray(m.signoffs)) out.signoffs = m.signoffs.map((s) => (isObject(s) ? withoutWho(s, SIGNOFF_WHO, closed) : s));
  if (isObject(m.changes)) {
    const c = { ...m.changes };
    for (const f of CHANGE_LISTS) if (Array.isArray(c[f])) c[f] = c[f].filter((id) => !closed.has(id));
    if (Array.isArray(c.gainedProducts)) c.gainedProducts = c.gainedProducts.filter((g) => !closed.has(g?.accountId));
    out.changes = c;
  }
  return same(out, m) ? undefined : out;
}

const SCRUB = {
  scanState(s, closed) {
    if (!isObject(s)) return undefined;
    const out = withoutWho(s, ['startedBy'], closed);
    for (const f of TEXTS) if (typeof s[f] === 'string') out[f] = textWithout(s[f], closed, [s.startedBy]);
    return same(out, s) ? undefined : out;
  },
  byAccount(v, closed) {
    if (!accountsOf(v).some((a) => closed.has(a))) return undefined;
    return Object.fromEntries(Object.entries(v).filter(([a]) => !closed.has(a)));
  },
  meta: (m, closed) => scrubMeta(m, closed),
  rows: (v, closed, key) => scrubRows(v, pageOf(key), closed),
  decisions: (v, closed) => scrubDecisions(v, closed),
};

/**
 * Pure: a stored value without the closed accounts, or undefined when it
 * holds none of them. For a review's values this is what that value alone
 * would become; eraseReview changes the whole review together.
 */
export function scrubbed(key, value, closed) {
  const kind = kindOf(key);
  if (!kind || value === undefined || value === null || !closed?.size) return undefined;
  return SCRUB[kind](value, closed, key);
}

// --- when erasing waits -------------------------------------------------------------

/**
 * Pure: is a snapshot running that has moved in the last 20 minutes? A
 * paused one counts while it is recent: the page picks it up within seconds.
 * One that nobody picked up for 20 minutes, like one that stopped moving,
 * does not hold erasing back; if it goes on later it finds its working data
 * without the closed accounts, which only means fewer people in the review.
 */
export function scanLive(state, at = Date.now()) {
  if (state?.status !== 'running') return false;
  const moved = Date.parse(state.updatedAt ?? state.startedAt ?? '');
  return Number.isFinite(moved) && at - moved <= STALE_AFTER_MS;
}

/** A sign-off, a reopen, a bulk decision or a delete is one resolver call, which Forge stops after 25 seconds. */
export const ACTION_LIVE_MS = 60_000;

/** Pure: may a change that started at `mark.at` still be running? */
export function actionLive(mark, at = Date.now()) {
  const started = Date.parse(mark?.at ?? '');
  return Number.isFinite(started) && at - started < ACTION_LIVE_MS;
}

/**
 * True while a snapshot runs (it writes its state, its working data and, at
 * the end, a review) or a change that writes from what it read may (see
 * markActionStarted in store.js), so erasing waits.
 */
export async function busy(readScan = getScanState, readAction = getActionStarted, now = Date.now) {
  const [scan, action] = await Promise.all([readScan(), readAction()]);
  const at = now();
  return scanLive(scan, at) || actionLive(action, at);
}

export const BUSY_MESSAGE = 'A snapshot, a sign-off, a reopen, a bulk decision or a delete started while closed accounts were being erased; erasing goes on at the next run.';

// --- the sources --------------------------------------------------------------------

/** The characters this app's stored keys use after a prefix (see narrower in privacy.js). */
const KEY_CHARS = '0123456789:abcdefghijklmnopqrstuvwxyz';

/** Reads `keys`, a few at a time, in order. */
async function readAll(store, keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 8) out.push(...(await Promise.all(keys.slice(i, i + 8).map((k) => store.get(k)))));
  return out;
}

/**
 * Takes the closed accounts out of one review, as described at the top: the
 * decisions first, then the rows, then the record. `meta` is the record as
 * read a moment ago. Returns true when it changed something.
 */
async function eraseReview(store, live, lock, id, meta, closed) {
  const shards = decisionShardsOf(meta);
  const count = (n) => Array.from({ length: Math.max(0, Number(n) || 0) }, (_, i) => i);
  const pages = (await readAll(store, count(meta.pages).map((i) => rowsKey(id, i)))).map(rowsOf);
  const markerOf = new Map();
  pages.forEach((rows, i) => rows.forEach((r, j) => closed.has(r?.accountId) && markerOf.set(r.accountId, closedMarker(i, j))));
  let changed = false;

  // A closed person's decision is first written under the marker of their
  // row, in the shard the marker belongs to, so a later decision on that row
  // in an open review lands on the same entry. Only then does the entry under
  // the account ID go.
  const held = await readAll(store, count(shards).map((s) => decisionsKey(id, s)));
  const moves = new Map();
  for (const shard of held) {
    for (const [accountId, d] of Object.entries(isObject(shard) ? shard : {})) {
      const marker = closed.has(accountId) ? markerOf.get(accountId) : null;
      if (!marker || !isObject(d)) continue;
      const to = shardOf(marker, shards);
      moves.set(to, { ...(moves.get(to) ?? {}), [marker]: movedDecision(d, closed) });
    }
  }
  for (const [to, add] of moves) {
    const key = decisionsKey(id, to);
    await lock(key, async () => {
      const fresh = (await store.get(key)) ?? {};
      // Already there from a run cut short, and perhaps decided again since: left as it is.
      const missing = Object.entries(add).filter(([marker]) => !Object.hasOwn(fresh, marker));
      if (!missing.length) return;
      await store.set(key, { ...fresh, ...Object.fromEntries(missing) });
      changed = true;
    });
  }
  for (let s = 0; s < shards; s++) {
    if (scrubDecisions(held[s], closed) === undefined) continue;
    const key = decisionsKey(id, s);
    await lock(key, async () => {
      const next = scrubDecisions(await store.get(key), closed);
      if (next === undefined) return;
      await store.set(key, next);
      changed = true;
    });
  }

  if (markerOf.size) {
    if (await live()) throw new Error(BUSY_MESSAGE);
    for (let i = 0; i < pages.length; i++) {
      if (!pages[i].some((r) => closed.has(r?.accountId))) continue;
      const next = scrubRows(await store.get(rowsKey(id, i)), i, closed, meta.changes);
      if (next === undefined) continue;
      await store.set(rowsKey(id, i), next);
      changed = true;
    }
  }

  if (scrubMeta(meta, closed) !== undefined) {
    if (await live()) throw new Error(BUSY_MESSAGE);
    const next = scrubMeta(await store.get(metaKey(id)), closed);
    if (next !== undefined) {
      await store.set(metaKey(id), next);
      changed = true;
    }
  }
  return changed;
}

/**
 * `store` is @forge/kvs, or a stand-in in tests; `live` is busy; `lock` is
 * withLock (store.js), so a decision shard or the scan state is never changed
 * between another call's read and its write. Each write asks first whether
 * the app has started writing since the report last asked (it asks at most
 * every 2 seconds), then reads the value again.
 */
export function personalDataSources(store = kvs, live = busy, lock = withLock) {
  const one = async (key, closed) => {
    const next = scrubbed(key, await store.get(key), closed);
    if (next === undefined) return false;
    await store.set(key, next);
    return true;
  };
  const erase = async (key, closed) => {
    if (await live()) throw new Error(BUSY_MESSAGE);
    const kind = kindOf(key);
    if (kind === 'scanState') return lock(SCAN_KEY, () => one(key, closed));
    if (kind === 'byAccount') return one(key, closed);
    if (!kind || scrubbed(key, await store.get(key), closed) === undefined) return false;
    const meta = await store.get(metaKey(reviewOf(key)));
    if (isObject(meta)) return eraseReview(store, live, lock, reviewOf(key), meta, closed);
    // Pages of a review that was never published whole: nothing reads them,
    // so the closed accounts are taken out where they are.
    return kind === 'decisions' ? lock(key, () => one(key, closed)) : one(key, closed);
  };
  const source = (prefix) => ({
    prefix,
    chars: KEY_CHARS,
    ids: (value, key) => idsIn(key, value),
    scrub: (value, key, closed) => scrubbed(key, value, closed),
    erase,
  });
  // The reviews first: they are what is kept for good.
  return [source('review:'), source('scan:')];
}

export const SOURCES = personalDataSources();
