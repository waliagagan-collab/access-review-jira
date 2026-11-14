/**
 * Personal data reporting, as Atlassian's user privacy rules ask of apps that
 * keep Atlassian account IDs.
 *
 * Once a cycle (7 days) the app reports every account ID it keeps to
 * Atlassian (privacy.reportPersonalData, at most 90 per call). Atlassian
 * answers which of those accounts were closed, and the app then erases what it
 * keeps about them. It also answers which accounts changed their profile
 * ("updated"): whatever the app keeps of a profile is then read again or
 * erased, by the app's own `refresh` (see runSlice).
 *
 * An hourly scheduled trigger runs the work in slices. Each slice stops itself
 * after a time budget, and the next one goes on where it stopped:
 *   collect  walk the app's stored values, source by source, and gather the account IDs
 *   report   report them, 90 at a time, and note the closed and the updated ones
 *   refresh  read again what the app keeps of the updated accounts' profiles
 *   erase    walk the sources again and take the closed accounts out of each value
 * The gathered IDs (`pdr:ids:<n>`), the closed ones (`pdr:closed:<n>`) and the
 * updated ones (`pdr:updated:<n>`) are kept in pages, so no value nears the
 * storage limit, and deleted when the cycle ends. `pdr:state` holds where the
 * cycle is, and the totals of the last one. A new cycle starts 7 days after the
 * last report call of the one before, so no account is reported more often
 * than once in 7 days.
 *
 * Where a walk is, is kept as a list of key prefixes still to do, never as a
 * storage query cursor: Forge says a cursor may not stay valid, so one lives
 * only inside the slice that got it (see walk).
 *
 * A source describes one kind of stored value: `prefix` (every key that starts
 * with it) or `key` (one key), `ids(value, key)` the account IDs in that value,
 * and `scrub(value, key, closed)` the value without the closed accounts:
 * undefined when nothing changes, null to delete the key. A source whose
 * values are saved another way (a revision number, a claim) also has
 * `erase(key, closed)`, which writes the change itself and returns true when
 * it changed something. This module never imports Forge itself, so it runs
 * under plain Node in the tests.
 */

export const CYCLE_MS = 7 * 24 * 60 * 60 * 1000;
export const REPORT_LIMIT = 90;
export const ID_PAGE = 1000;
/** A slice stops itself after this; scheduled trigger functions are stopped by Forge at 55 seconds unless the manifest gives more. */
export const SOFT_BUDGET_MS = 40_000;
/** After this many failed calls in a row on the same batch, it is skipped so one bad batch cannot stop every later cycle. */
export const MAX_FAILURES = 24;
/** While erasing, busy() is asked again before a write once this long has passed since it was last asked. */
export const BUSY_EVERY_MS = 2_000;
export const STATE_KEY = 'pdr:state';
export const LOCK_KEY = 'pdr:lock';
/** A slice's lock is free again after this long, whatever storage still holds: longer than the function may run. */
export const LOCK_MS = 120_000;
const IDS = 'pdr:ids:';
const CLOSED = 'pdr:closed:';
const UPDATED = 'pdr:updated:';
export const idPageKey = (n) => `${IDS}${n}`;
export const closedPageKey = (n) => `${CLOSED}${n}`;
export const updatedPageKey = (n) => `${UPDATED}${n}`;
const QUERY_PAGE = 20;
const MAX_ROUNDS = 100_000;
const ACTIVE = ['collect', 'report', 'refresh', 'erase', 'finish'];
const STOP = Symbol('stop');
/**
 * The characters a stored key may hold after a source's prefix. A prefix
 * that cannot be walked in one slice is cut into narrower ones by its next
 * character (see narrower), so this must name every such character; a key
 * that holds another one keeps its prefix whole. A source can give its own
 * (`chars`).
 */
export const KEY_CHARS = '-.0123456789:_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** An Atlassian account ID: 5b10ac8d82e05b22cc7d4ef5, 712020:2a1b..., never `unknown`. */
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const isAccountId = (id) => typeof id === 'string' && ACCOUNT_ID.test(id) && id !== 'unknown';

const iso = (ms) => new Date(ms).toISOString();

/** A short reason for the log and the state. The report helper rejects with the response itself. */
export const describe = (err) => (typeof err?.status === 'number' ? `HTTP ${err.status}` : String(err?.message ?? err ?? 'unknown error').slice(0, 300));

/** Seconds from a Retry-After header, or null. */
const retryAfter = (err) => {
  const raw = err?.headers?.get?.('retry-after');
  const s = Number(raw);
  return Number.isFinite(s) && s > 0 ? s : null;
};

/** The store this module uses, made from @forge/kvs. */
export function kvsStore(kvs, WhereConditions) {
  return {
    get: (key) => kvs.get(key),
    set: (key, value) => kvs.set(key, value),
    delete: (key) => kvs.delete(key),
    async page(prefix, cursor, limit = QUERY_PAGE) {
      let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(limit);
      if (cursor) query = query.cursor(cursor);
      return query.getMany();
    },
    /**
     * True when this slice may run: no other slice holds the lock. The lock's
     * value starts with the time it was taken, and that decides when a lock
     * left by a slice that was stopped is free again (two minutes): Forge can
     * keep a key for up to 48 hours after its TTL, so the TTL only tidies up.
     */
    async lock(token, at = Date.now()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await kvs.set(LOCK_KEY, token, { keyPolicy: 'FAIL_IF_EXISTS', ttl: { value: LOCK_MS / 1000, unit: 'SECONDS' } });
          return true;
        } catch {
          try {
            const held = await kvs.get(LOCK_KEY);
            if (held === undefined || held === null) continue;
            const since = Number.parseInt(String(held), 10);
            if (!(Number.isFinite(since) && at - since > LOCK_MS)) return false;
            await kvs.delete(LOCK_KEY);
          } catch {
            return false;
          }
        }
      }
      return false;
    },
    /** Let the lock go, unless it lapsed and another slice has taken it since. */
    async unlock(token) {
      if (token === undefined || (await kvs.get(LOCK_KEY)) === token) await kvs.delete(LOCK_KEY);
    },
  };
}

async function loadPages(store, prefix, pages, count) {
  const out = [];
  for (let n = 0; n < (pages ?? 0); n++) out.push(...((await store.get(`${prefix}${n}`)) ?? []));
  return out.slice(0, count ?? 0);
}

/** Writes the pages from the one that held entry number `from` on. Returns how many pages there are. */
async function savePages(store, prefix, list, from) {
  const pages = Math.ceil(list.length / ID_PAGE);
  for (let n = Math.floor(from / ID_PAGE); n < pages; n++) await store.set(`${prefix}${n}`, list.slice(n * ID_PAGE, (n + 1) * ID_PAGE));
  return pages;
}

/** Deletes the pages the state knows of, then any a slice wrote before it was stopped (pages are written before the state). */
async function clearPages(store, prefix, pages) {
  for (let n = 0; n < (pages ?? 0); n++) await store.delete(`${prefix}${n}`);
  let cursor = null;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { results, nextCursor } = await store.page(prefix, cursor, 100);
    for (const { key } of results ?? []) await store.delete(key);
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
}

/** Which sources a walk position points into. A deploy that changes the list mid-cycle makes the walk start again. */
const shapeOf = (sources) => sources.map((s) => (s.key ? `k:${s.key}` : `p:${s.prefix}`)).join('|');

/**
 * What a walk still has to do, as units [source, base, chars]:
 *   chars === null  the one key `base`
 *   chars === ''    every key that starts with `base`
 *   chars 'abc'     every key that starts with `base` + one of these characters
 * A state saved before units were kept has a source number and a cursor: its
 * walk goes on from the start of that source, without the cursor.
 */
function todoOf(state, sources) {
  if (Array.isArray(state.todo)) return state.todo;
  return sources.flatMap((s, i) => (i < (state.src ?? 0) ? [] : [[i, s.key ?? s.prefix, s.key ? null : '']]));
}

/** Pure: the start two keys share. */
function shared(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return a.slice(0, n);
}

/**
 * Pure: a prefix that could not be walked in one slice, as narrower units
 * that together cover every key under it. `seen` is the start shared by the
 * keys read so far: the cut goes straight down to it, so a store whose keys
 * all start alike (`review:1762...`) is not cut one character a slice. On the
 * way down each step keeps the key that ends there, and every other next
 * character.
 */
export function narrower(src, prefix, seen, chars = KEY_CHARS) {
  const to = typeof seen === 'string' && seen.length > prefix.length && seen.startsWith(prefix) ? seen : prefix;
  const out = [];
  for (let d = prefix.length; d < to.length; d++) out.push([src, to.slice(0, d), null], [src, to.slice(0, d), chars.replace(to[d], '')]);
  if (to.length > prefix.length) out.push([src, to, '']);
  else out.push([src, prefix, null], [src, prefix, chars]);
  return out;
}

/**
 * Calls fn(source, key, value) for each stored value of the units in `todo`,
 * until done or late. A prefix is walked from its start to its end with a
 * query cursor that lives only in this slice. One that is not finished when
 * the slice runs out of time is cut into narrower prefixes (see narrower),
 * and the next slice starts those from their beginning: no cursor is kept
 * between slices. Walking a value twice is harmless: collecting gathers a
 * set, and erasing leaves a value it has already changed alone. When fn
 * returns STOP the walk ends with the current unit still to do.
 * -> { todo, done }
 */
async function walk(store, sources, todo, late, fn) {
  const left = todo.map((u) => [...u]);
  let first = true;
  for (let round = 0; left.length && round < MAX_ROUNDS; round++) {
    // A slice always does its first unit, so every slice gets somewhere.
    if (!first && late()) break;
    const [src, base, chars] = left[0];
    const source = sources[src];
    if (!source) {
      left.shift();
      continue;
    }
    if (chars === null) {
      const value = await store.get(base);
      if (value !== undefined && value !== null && (await fn(source, base, value)) === STOP) return { todo: left, done: false };
      left.shift();
      first = false;
      continue;
    }
    const prefix = chars ? base + chars[0] : base;
    const rest = chars && chars.length > 1 ? [[src, base, chars.slice(1)]] : [];
    const alphabet = source.chars ?? KEY_CHARS;
    let cursor = null;
    let seen = null;
    let splittable = true;
    let complete = false;
    for (let pages = 0; pages < MAX_ROUNDS; pages++) {
      if (!(first && pages === 0) && late()) break;
      const { results, nextCursor } = await store.page(prefix, cursor, source.pageSize ?? QUERY_PAGE);
      for (const { key, value } of results ?? []) {
        seen = seen === null ? key : shared(seen, key);
        // A key with a character the cut does not know of: its prefix is never cut, only walked whole.
        if (splittable && [...key.slice(prefix.length)].some((c) => !alphabet.includes(c))) splittable = false;
        if ((await fn(source, key, value)) === STOP) return { todo: left, done: false };
      }
      if (!nextCursor || nextCursor === cursor) {
        complete = true;
        break;
      }
      cursor = nextCursor;
    }
    first = false;
    if (complete) left.splice(0, 1, ...rest);
    else {
      // Out of time before its end. The next slice gets narrower prefixes, each from its beginning.
      left.splice(0, 1, ...(splittable ? narrower(src, prefix, seen, alphabet) : [[src, prefix, '']]), ...rest);
      break;
    }
  }
  return { todo: left, done: left.length === 0 };
}

async function collect(store, state, sources, late) {
  const ids = await loadPages(store, IDS, state.pages, state.count);
  const from = ids.length;
  const seen = new Set(ids);
  let unreadable = state.unreadable ?? 0;
  const at = await walk(store, sources, todoOf(state, sources), late, (source, key, value) => {
    let found;
    try {
      found = source.ids(value, key);
    } catch {
      unreadable++;
      return;
    }
    for (const id of found ?? []) {
      if (isAccountId(id) && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  });
  const pages = await savePages(store, IDS, ids, from);
  const { src, cursor, ...rest } = state;
  return at.done ? { ...rest, phase: 'report', todo: null, pages, count: ids.length, pos: 0, unreadable } : { ...rest, todo: at.todo, pages, count: ids.length, unreadable };
}

async function report(store, state, send, late, now, save) {
  const ids = await loadPages(store, IDS, state.pages, state.count);
  const closedList = await loadPages(store, CLOSED, state.closedPages, state.closedCount);
  const closed = new Set(closedList);
  const updatedList = await loadPages(store, UPDATED, state.updatedPages, state.updatedCount);
  const updated = new Set(updatedList);
  const updatedAt = state.since ?? state.cycle;
  while (state.pos < ids.length && !late()) {
    // After Atlassian refused a batch as a bad request, its accounts go one at a time, so one odd ID costs only itself.
    const size = state.pos < (state.singlesUntil ?? 0) ? 1 : REPORT_LIMIT;
    const batch = ids.slice(state.pos, state.pos + size);
    let answer;
    try {
      answer = await send(batch.map((accountId) => ({ accountId, updatedAt })));
    } catch (err) {
      const error = { at: iso(now()), message: describe(err) };
      if (err?.status === 429) return { ...state, notBefore: iso(now() + (retryAfter(err) ?? 3600) * 1000), error };
      if (err?.status === 400 && batch.length > 1) {
        state = { ...state, singlesUntil: state.pos + batch.length };
        continue;
      }
      const failures = (state.failures ?? 0) + 1;
      if (err?.status !== 400 && failures < MAX_FAILURES) return { ...state, failures, error };
      // A bad request for one account, or the same batch failing for a whole day: skip it and go on with the rest.
      state = await save({ ...state, pos: state.pos + batch.length, failures: 0, skipped: (state.skipped ?? 0) + batch.length, error });
      continue;
    }
    const sent = new Set(batch);
    let added = 0;
    let changed = 0;
    for (const a of answer ?? []) {
      if (a?.status === 'closed' && sent.has(a.accountId) && !closed.has(a.accountId)) {
        closed.add(a.accountId);
        closedList.push(a.accountId);
        added++;
      } else if (a?.status === 'updated' && sent.has(a.accountId) && !updated.has(a.accountId)) {
        // The profile changed: what the app keeps of it is read again or erased (see refresh in runSlice).
        updated.add(a.accountId);
        updatedList.push(a.accountId);
        changed++;
      }
    }
    // The closed and updated pages are written before the state, so a slice cut short never loses one.
    const closedPages = added ? await savePages(store, CLOSED, closedList, closedList.length - added) : state.closedPages ?? 0;
    const updatedPages = changed ? await savePages(store, UPDATED, updatedList, updatedList.length - changed) : state.updatedPages ?? 0;
    // Saved after every call, so a slice cut short never reports the same accounts twice.
    state = await save({
      ...state,
      pos: state.pos + batch.length,
      closedPages,
      closedCount: closedList.length,
      updatedPages,
      updatedCount: updatedList.length,
      failures: 0,
      reported: (state.reported ?? 0) + batch.length,
      lastReport: iso(now()),
    });
  }
  if (state.pos < ids.length) return state;
  return { ...state, phase: updatedList.length ? 'refresh' : closedList.length ? 'erase' : 'finish', todo: null };
}

async function erase(store, state, sources, late, isBusy) {
  const closed = new Set(await loadPages(store, CLOSED, state.closedPages, state.closedCount));
  let erased = state.erased ?? 0;
  let unreadable = state.unreadable ?? 0;
  let paused = false;
  const scrub = (source, value, key) => {
    try {
      return { next: source.scrub(value, key, closed) };
    } catch {
      unreadable++;
      return { next: undefined };
    }
  };
  const at = await walk(store, sources, todoOf(state, sources), late, async (source, key, value) => {
    if (scrub(source, value, key).next === undefined) return;
    // The app started writing its own data meanwhile: stop here and go on in a later slice.
    if (await isBusy()) {
      paused = true;
      return STOP;
    }
    if (source.erase) {
      if (await source.erase(key, closed)) erased++;
      return;
    }
    // Read again just before the write, so a change saved since the walk read it is kept.
    const fresh = await store.get(key);
    if (fresh === undefined || fresh === null) return;
    const { next } = scrub(source, fresh, key);
    if (next === undefined) return;
    if (next === null) await store.delete(key);
    else await store.set(key, next);
    erased++;
  });
  const { src, cursor, ...rest } = state;
  if (at.done) return { ...rest, phase: 'finish', todo: null, erased, unreadable };
  return { ...rest, todo: at.todo, erased, unreadable, ...(paused ? { waits: (state.waits ?? 0) + 1 } : {}) };
}

async function finish(store, state, now) {
  await clearPages(store, IDS, state.pages);
  await clearPages(store, CLOSED, state.closedPages);
  await clearPages(store, UPDATED, state.updatedPages);
  return {
    phase: 'idle',
    last: {
      started: state.cycle,
      lastReport: state.lastReport ?? null,
      finished: iso(now()),
      accounts: state.count ?? 0,
      reported: state.reported ?? 0,
      closed: state.closedCount ?? 0,
      updated: state.updatedCount ?? 0,
      refreshed: state.refreshed ?? 0,
      erased: state.erased ?? 0,
      skipped: state.skipped ?? 0,
      unreadable: state.unreadable ?? 0,
    },
  };
}

/** busy(), asked at most every BUSY_EVERY_MS. */
function throttled(busy, now) {
  if (!busy) return async () => false;
  let askedAt = -Infinity;
  let answer = false;
  return async () => {
    if (now() - askedAt >= BUSY_EVERY_MS) {
      answer = Boolean(await busy());
      askedAt = now();
    }
    return answer;
  };
}

/**
 * One slice of the cycle. Starts a new cycle 7 days after the last report call
 * of the one before. `busy()` says the app is writing its own data right now;
 * erasing then waits for a later slice (`waits` counts the slices it waited).
 * `refresh(updated, late, pos)` is the app's own answer to accounts whose
 * profile changed: it reads again (or erases) what the app keeps of those
 * profiles, stops when `late()`, and returns { done, changed, pos } where
 * `pos` is handed back to it by the next slice. Without it, updated accounts
 * need nothing.
 * Returns { ran, phase, error?, last? } (`last`: the totals, when this slice
 * ended the cycle); nothing it returns or logs holds an account ID.
 */
export async function runSlice({ store, report: send, sources, busy, refresh = null, now = () => Date.now(), budgetMs = SOFT_BUDGET_MS }) {
  const deadline = now() + budgetMs;
  const late = () => now() >= deadline;
  const due = (s) => {
    if (s.notBefore && now() < Date.parse(s.notBefore)) return false;
    if (ACTIVE.includes(s.phase)) return true;
    const from = Date.parse(s.last?.lastReport ?? s.last?.started ?? '');
    return !(Number.isFinite(from) && now() - from < CYCLE_MS);
  };
  let state = (await store.get(STATE_KEY)) ?? { phase: 'idle' };
  if (!due(state)) return { ran: false, phase: state.phase };
  const token = `${now()}-${Math.random().toString(36).slice(2)}`;
  if (store.lock && !(await store.lock(token, now()))) return { ran: false, phase: state.phase };
  // The last state written: an error never puts an older one back over it.
  let saved;
  const save = async (s) => {
    await store.set(STATE_KEY, s);
    saved = s;
    return s;
  };
  try {
    // Read again under the lock: another slice may have moved on since the read above.
    state = (await store.get(STATE_KEY)) ?? { phase: 'idle' };
    saved = state;
    if (!due(state)) return { ran: false, phase: state.phase };
    if (Array.isArray(state.closed)) {
      // A state from before the closed pages: move its list into them.
      const { closed, ...rest } = state;
      state = { ...rest, closedPages: await savePages(store, CLOSED, closed, 0), closedCount: closed.length };
    }
    const shape = shapeOf(sources);
    if (!ACTIVE.includes(state.phase)) {
      await clearPages(store, IDS, state.pages);
      await clearPages(store, CLOSED, state.closedPages);
      await clearPages(store, UPDATED, state.updatedPages);
      state = { phase: 'collect', cycle: iso(now()), since: state.last?.started ?? null, shape, todo: null, pages: 0, count: 0, pos: 0, closedPages: 0, closedCount: 0, updatedPages: 0, updatedCount: 0, last: state.last ?? null };
    }
    const { notBefore, error, ...clean } = state;
    state = clean;
    if (state.shape !== shape) state = { ...state, shape, ...(state.phase === 'collect' || state.phase === 'erase' ? { todo: null, src: 0, cursor: null } : {}) };
    const isBusy = throttled(busy, now);
    if (state.phase === 'collect') state = await collect(store, state, sources, late);
    if (state.phase === 'report' && !late()) state = await report(store, state, send, late, now, save);
    if (state.phase === 'refresh' && !late()) {
      const after = { phase: (state.closedCount ?? 0) > 0 ? 'erase' : 'finish', todo: null, refreshPos: null };
      if (!refresh) state = { ...state, ...after };
      else {
        // Saved first, so a refresh that fails leaves the cycle at this step.
        state = await save(state);
        const updated = new Set(await loadPages(store, UPDATED, state.updatedPages, state.updatedCount));
        const r = await refresh(updated, late, state.refreshPos ?? null);
        state = { ...state, refreshed: (state.refreshed ?? 0) + (r?.changed ?? 0), refreshPos: r?.pos ?? null, ...(r?.done === false ? {} : after) };
      }
    }
    if (state.phase === 'erase' && !late()) {
      if (await isBusy()) state = { ...state, waits: (state.waits ?? 0) + 1 };
      else state = await erase(store, state, sources, late, isBusy);
    }
    const ended = state.phase === 'finish';
    if (ended) state = await finish(store, state, now);
    await save(state);
    return { ran: true, phase: state.phase, ...(state.error ? { error: state.error.message } : {}), ...(ended ? { last: state.last } : {}) };
  } catch (err) {
    try {
      await store.set(STATE_KEY, { ...saved, error: { at: iso(now()), message: describe(err) } });
    } catch {
      // Storage is down; the next slice starts from the last state that was written.
    }
    return { ran: true, phase: saved?.phase ?? state.phase, error: describe(err) };
  } finally {
    if (store.unlock) await store.unlock(token);
  }
}
