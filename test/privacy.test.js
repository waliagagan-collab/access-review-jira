import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSlice, narrower, isAccountId, CYCLE_MS, REPORT_LIMIT, ID_PAGE, MAX_FAILURES, STATE_KEY, KEY_CHARS, idPageKey, closedPageKey, updatedPageKey } from '../src/lib/privacy.js';

// The shared personal data reporting cycle, against a small in-memory store
// that refuses values over the Forge storage limit, and a stand-in for
// privacy.reportPersonalData.

const SIZE_LIMIT = 240 * 1024;

function memoryStore(entries = {}) {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  let locked = false;
  const store = {
    map,
    largest: 0,
    get: async (key) => copy(map.get(key)),
    async set(key, value) {
      const size = JSON.stringify(value).length;
      if (size > SIZE_LIMIT) throw new Error(`value too large for ${key}`);
      if (key === STATE_KEY) store.largest = Math.max(store.largest, size);
      map.set(key, copy(value));
    },
    delete: async (key) => void map.delete(key),
    async page(prefix, cursor, limit = 20) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix) && (!cursor || k > cursor)).sort();
      const page = keys.slice(0, limit);
      return { results: page.map((key) => ({ key, value: copy(map.get(key)) })), ...(keys.length > limit ? { nextCursor: page.at(-1) } : {}) };
    },
    lock: async () => (locked ? false : (locked = true)),
    unlock: async () => void (locked = false),
  };
  return store;
}

const id = (n) => `5b10ac8d82e05b22cc7d${String(n).padStart(4, '0')}`;
const longId = (n) => `712020:${String(n).padStart(8, '0')}-1111-2222-3333-444455556666`;
const pdrKeys = (store) => [...store.map.keys()].filter((k) => k.startsWith('pdr:ids:') || k.startsWith('pdr:closed:'));

// Two sources: one value per thing with an owner and a list of people, and one site value.
const SOURCES = [
  {
    prefix: 'thing:',
    ids: (v) => [v.owner, ...(v.people ?? [])],
    scrub(v, key, closed) {
      const people = (v.people ?? []).filter((p) => !closed.has(p));
      const owner = closed.has(v.owner) ? null : v.owner;
      if (people.length === (v.people ?? []).length && owner === v.owner) return undefined;
      return people.length || owner ? { ...v, owner, people } : null;
    },
  },
  {
    key: 'site',
    ids: (v) => Object.keys(v.rates ?? {}),
    scrub(v, key, closed) {
      const kept = Object.entries(v.rates ?? {}).filter(([a]) => !closed.has(a));
      return kept.length === Object.keys(v.rates ?? {}).length ? undefined : { ...v, rates: Object.fromEntries(kept) };
    },
  },
];

const reporter = (closed = new Set()) => {
  const calls = [];
  const fn = async (accounts) => {
    calls.push(accounts);
    assert.ok(accounts.length <= REPORT_LIMIT);
    return accounts.filter((a) => closed.has(a.accountId)).map((a) => ({ accountId: a.accountId, status: 'closed' }));
  };
  fn.calls = calls;
  return fn;
};

const clock = (start = Date.parse('2026-11-04T10:00:00Z')) => {
  let t = start;
  const now = () => t;
  now.add = (ms) => (t += ms);
  return now;
};

/** Every store read moves the clock on, so each slice stops after a few steps. */
function slowly(store, now, ms = 200) {
  const get = store.get;
  store.get = async (key) => {
    now.add(ms);
    return get(key);
  };
  const page = store.page;
  store.page = async (...args) => {
    now.add(ms * 1.5);
    return page(...args);
  };
}

async function untilIdle(args, max = 2000) {
  let res;
  for (let i = 0; i < max; i++) {
    res = await runSlice(args);
    if (res.phase === 'idle' && res.ran) return { res, slices: i + 1 };
  }
  throw new Error(`not idle after ${max} slices: ${JSON.stringify(res)}`);
}

test('account IDs: real shapes pass, unknown and junk do not', () => {
  assert.ok(isAccountId('5b10ac8d82e05b22cc7d4ef5'));
  assert.ok(isAccountId('712020:2a1b3c4d-1111-2222-3333-444455556666'));
  assert.ok(!isAccountId('unknown'));
  assert.ok(!isAccountId(''));
  assert.ok(!isAccountId(null));
  assert.ok(!isAccountId('__proto__'));
  assert.ok(!isAccountId('a b'));
  assert.ok(!isAccountId('#closed-1'));
});

test('a cycle reports every stored account once, erases the closed ones, and cleans up', async () => {
  const store = memoryStore({
    'thing:1': { owner: id(1), people: [id(2), id(3), 'unknown'] },
    'thing:2': { owner: id(2), people: [id(3)] },
    'thing:3': { owner: id(4), people: [] },
    site: { rates: { [id(3)]: 10, [id(5)]: 20 } },
    other: { owner: id(9) },
  });
  const report = reporter(new Set([id(3), id(4)]));
  const now = clock();
  const res = await runSlice({ store, report, sources: SOURCES, now });
  assert.equal(res.ran, true);
  assert.equal(res.phase, 'idle');
  assert.equal(res.last.closed, 2, 'the totals come back when the cycle ends');
  const sent = report.calls.flat().map((a) => a.accountId).sort();
  assert.deepEqual(sent, [id(1), id(2), id(3), id(4), id(5)]);
  assert.ok(report.calls.flat().every((a) => a.updatedAt === '2026-11-04T10:00:00.000Z'));
  assert.deepEqual(store.map.get('thing:1'), { owner: id(1), people: [id(2), 'unknown'] });
  assert.deepEqual(store.map.get('thing:2'), { owner: id(2), people: [] });
  assert.equal(store.map.has('thing:3'), false);
  assert.deepEqual(store.map.get('site'), { rates: { [id(5)]: 20 } });
  assert.deepEqual(store.map.get('other'), { owner: id(9) });
  const state = store.map.get(STATE_KEY);
  assert.equal(state.phase, 'idle');
  const { started, finished, lastReport, ...totals } = state.last;
  assert.deepEqual(totals, { accounts: 5, reported: 5, closed: 2, updated: 0, refreshed: 0, erased: 4, skipped: 0, unreadable: 0 });
  assert.equal(lastReport, '2026-11-04T10:00:00.000Z');
  assert.deepEqual(pdrKeys(store), []);
  assert.equal(JSON.stringify(state).includes(id(3)), false, 'no closed account ID is left in the state');
  assert.equal(JSON.stringify(res).includes(id(3)), false, 'nor in what the slice returns');
});

test('the next cycle starts 7 days after the last report call, and sends the last cycle start as updatedAt', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1) } });
  const report = reporter();
  const now = clock();
  await runSlice({ store, report, sources: SOURCES, now });
  now.add(CYCLE_MS - 60_000);
  assert.deepEqual(await runSlice({ store, report, sources: SOURCES, now }), { ran: false, phase: 'idle' });
  assert.equal(report.calls.length, 1);
  now.add(60_000);
  await runSlice({ store, report, sources: SOURCES, now });
  assert.equal(report.calls.length, 2);
  assert.equal(report.calls[1][0].updatedAt, '2026-11-04T10:00:00.000Z');
});

test('a cycle that reports over several days: no account is reported again within 7 days', async () => {
  const entries = {};
  for (let i = 0; i < 400; i++) entries[`thing:${String(i).padStart(4, '0')}`] = { owner: id(i) };
  const store = memoryStore(entries);
  const now = clock();
  const sentAt = new Map();
  const report = async (accounts) => {
    for (const a of accounts) {
      const before = sentAt.get(a.accountId);
      if (before !== undefined) assert.ok(now() - before >= CYCLE_MS, `${a.accountId} again after ${(now() - before) / 3_600_000} h`);
      sentAt.set(a.accountId, now());
    }
    now.add(3_600_000); // each call takes an hour of wall time, so one cycle spans days
    return [];
  };
  for (let hour = 0; hour < 24 * 30; hour++) {
    await runSlice({ store, report, sources: SOURCES, now, budgetMs: 1 });
    now.add(60_000);
  }
  assert.equal(sentAt.size, 400);
});

test('no account IDs stored: the cycle ends without a call', async () => {
  const store = memoryStore({ other: 1 });
  const report = reporter();
  const res = await runSlice({ store, report, sources: SOURCES, now: clock() });
  assert.equal(res.phase, 'idle');
  assert.equal(res.last.accounts, 0);
  assert.equal(report.calls.length, 0);
});

test('many accounts: batches of 90, slices that run out of time go on where they stopped', async () => {
  const entries = {};
  const total = ID_PAGE + 350; // more than one page of gathered IDs
  for (let i = 0; i < total; i++) entries[`thing:${String(i).padStart(5, '0')}`] = { owner: id(i) };
  const store = memoryStore(entries);
  const report = reporter(new Set([id(7), id(1200)]));
  const now = clock();
  slowly(store, now);
  const { res, slices } = await untilIdle({ store, report, sources: SOURCES, now, budgetMs: 2_000 });
  assert.ok(slices > 3, `took ${slices} slices`);
  const sent = report.calls.flat().map((a) => a.accountId);
  assert.equal(sent.length, total, 'each account reported once');
  assert.equal(new Set(sent).size, total);
  assert.ok(report.calls.every((c) => c.length <= REPORT_LIMIT));
  assert.equal(store.map.has('thing:00007'), false);
  assert.equal(store.map.has('thing:01200'), false);
  assert.equal(res.last.closed, 2);
  assert.deepEqual(pdrKeys(store), []);
});

test('thousands of closed accounts: the state stays small and the cycle ends', async () => {
  const entries = {};
  const total = 8_000;
  for (let i = 0; i < total; i++) entries[`thing:${String(i).padStart(5, '0')}`] = { owner: longId(i) };
  const store = memoryStore(entries);
  const closed = new Set(Array.from({ length: 6_000 }, (_, i) => longId(i)));
  const report = reporter(closed);
  const now = clock();
  slowly(store, now, 20);
  const { res } = await untilIdle({ store, report, sources: SOURCES, now, budgetMs: 5_000 });
  assert.equal(res.last.closed, 6_000);
  assert.equal(report.calls.flat().length, total, 'each account reported once');
  assert.equal([...store.map.keys()].filter((k) => k.startsWith('thing:')).length, total - 6_000);
  assert.deepEqual(pdrKeys(store), []);
  assert.ok(store.largest < 4_000, `pdr:state grew to ${store.largest} bytes`);
});

test('a storage error after some calls keeps what was saved: no account is reported twice', async () => {
  const entries = {};
  for (let i = 0; i < 400; i++) entries[`thing:${String(i).padStart(4, '0')}`] = { owner: id(i) };
  const store = memoryStore(entries);
  const report = reporter();
  const now = clock();
  const set = store.set;
  let writes = 0;
  store.set = async (key, value) => {
    if (key === STATE_KEY && ++writes === 3) throw new Error('storage down');
    return set(key, value);
  };
  const first = await runSlice({ store, report, sources: SOURCES, now });
  assert.equal(first.error, 'storage down');
  assert.equal(first.phase, 'report');
  await untilIdle({ store, report, sources: SOURCES, now });
  const sent = report.calls.flat().map((a) => a.accountId);
  assert.equal(new Set(sent).size, 400);
  assert.ok(sent.length <= 400 + REPORT_LIMIT, `sent ${sent.length}: only the batch whose save failed may go again`);
});

test('a rate limit waits for Retry-After, then the same batch is sent again', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1) } });
  const now = clock();
  let fail = true;
  const calls = [];
  const report = async (accounts) => {
    calls.push(accounts);
    if (fail) {
      fail = false;
      return Promise.reject({ status: 429, headers: { get: (h) => (h === 'retry-after' ? '7200' : null) } });
    }
    return [];
  };
  const first = await runSlice({ store, report, sources: SOURCES, now });
  assert.deepEqual(first, { ran: true, phase: 'report', error: 'HTTP 429' });
  now.add(3_600_000);
  assert.deepEqual(await runSlice({ store, report, sources: SOURCES, now }), { ran: false, phase: 'report' });
  now.add(3_600_000);
  assert.equal((await runSlice({ store, report, sources: SOURCES, now })).phase, 'idle');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test('a bad request: the batch goes one account at a time and only the refused account is skipped', async () => {
  const entries = {};
  for (let i = 0; i < 100; i++) entries[`thing:${String(i).padStart(3, '0')}`] = { owner: id(i) };
  const store = memoryStore(entries);
  const sent = [];
  const report = async (accounts) => {
    if (accounts.some((a) => a.accountId === id(5))) return Promise.reject({ status: 400, headers: { get: () => null } });
    sent.push(...accounts.map((a) => a.accountId));
    return accounts.filter((a) => a.accountId === id(6)).map((a) => ({ accountId: a.accountId, status: 'closed' }));
  };
  const res = await runSlice({ store, report, sources: SOURCES, now: clock() });
  assert.equal(res.phase, 'idle');
  assert.equal(res.last.skipped, 1);
  assert.equal(new Set(sent).size, 99);
  assert.equal(store.map.has('thing:006'), false, 'a closed account in the split batch is still erased');
});

test('a batch that keeps failing is skipped after a day, so the cycle can end', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1) } });
  const now = clock();
  const report = async () => Promise.reject({ status: 503, headers: { get: () => null } });
  let res;
  for (let i = 0; i < MAX_FAILURES; i++) {
    res = await runSlice({ store, report, sources: SOURCES, now });
    now.add(3_600_000);
  }
  assert.equal(res.phase, 'idle');
  assert.equal(store.map.get(STATE_KEY).last.skipped, 1);
});

test('erase waits while the app is busy with its own data, and counts the waits', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1), people: [id(2)] } });
  const report = reporter(new Set([id(2)]));
  const now = clock();
  let busy = true;
  assert.equal((await runSlice({ store, report, sources: SOURCES, now, busy: async () => busy })).phase, 'erase');
  assert.equal((await runSlice({ store, report, sources: SOURCES, now, busy: async () => busy })).phase, 'erase');
  assert.equal(store.map.get(STATE_KEY).waits, 2);
  assert.deepEqual(store.map.get('thing:1').people, [id(2)]);
  busy = false;
  assert.equal((await runSlice({ store, report, sources: SOURCES, now, busy: async () => busy })).phase, 'idle');
  assert.deepEqual(store.map.get('thing:1').people, []);
  assert.equal(report.calls.length, 1, 'waiting does not report again');
});

test('the app becoming busy in the middle of an erase stops it before the next write, without skipping a value', async () => {
  const entries = {};
  for (let i = 0; i < 60; i++) entries[`thing:${String(i).padStart(3, '0')}`] = { owner: id(i), people: [id(1000)] };
  const store = memoryStore(entries);
  const report = reporter(new Set([id(1000)]));
  const now = clock();
  let busy = false;
  let writes = 0;
  const set = store.set;
  store.set = async (key, value) => {
    if (key.startsWith('thing:') && ++writes === 25) busy = true; // a sync starts after 25 writes
    now.add(3_000); // so busy() is asked again before each write
    return set(key, value);
  };
  const first = await runSlice({ store, report, sources: SOURCES, now, busy: async () => busy, budgetMs: 10 * 60_000 });
  assert.equal(first.phase, 'erase');
  assert.equal(writes, 25, 'no write after the app became busy');
  busy = false;
  await untilIdle({ store, report, sources: SOURCES, now, busy: async () => busy, budgetMs: 10 * 60_000 });
  for (const [k, v] of store.map) if (k.startsWith('thing:')) assert.deepEqual(v.people, [], k);
});

test('a value that cannot be read is counted and skipped; a held lock skips the slice', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1) }, 'thing:2': 'not an object' });
  const sources = [{ ...SOURCES[0], ids: (v) => (typeof v === 'string' ? JSON.parse(v) : [v.owner]) }];
  const report = reporter();
  await store.lock();
  assert.deepEqual(await runSlice({ store, report, sources, now: clock() }), { ran: false, phase: 'idle' });
  await store.unlock();
  assert.equal((await runSlice({ store, report, sources, now: clock() })).phase, 'idle');
  assert.equal(store.map.get(STATE_KEY).last.unreadable, 1);
  assert.equal(report.calls.flat().length, 1);
});

test('a scrub that throws on an odd value is counted and the erase goes on', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1), people: [id(2)] }, 'thing:2': { owner: id(2), odd: true } });
  const sources = [{ ...SOURCES[0], scrub: (v, k, c) => (v.odd ? JSON.parse('{') : SOURCES[0].scrub(v, k, c)) }];
  const res = await runSlice({ store, report: reporter(new Set([id(2)])), sources, now: clock() });
  assert.equal(res.phase, 'idle');
  assert.deepEqual(store.map.get('thing:1').people, []);
  assert.equal(res.last.unreadable, 1);
});

test('a storage error keeps the cycle where it was, and the next slice goes on', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1) } });
  const report = reporter();
  const now = clock();
  const page = store.page;
  let fail = true;
  store.page = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error('storage down');
    }
    return page(...args);
  };
  // Nothing of the new cycle was saved yet, so the stored state is still the idle one, with the error.
  assert.deepEqual(await runSlice({ store, report, sources: SOURCES, now }), { ran: true, phase: 'idle', error: 'storage down' });
  assert.equal(store.map.get(STATE_KEY).error.message, 'storage down');
  assert.equal((await runSlice({ store, report, sources: SOURCES, now })).phase, 'idle');
  assert.equal(report.calls.flat().length, 1);
  assert.ok(!store.map.has(idPageKey(0)));
});

test('pages a stopped slice wrote past what the state knew of are deleted when the cycle ends', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1) }, [idPageKey(7)]: [id(99)], [closedPageKey(3)]: [id(98)] });
  const res = await runSlice({ store, report: reporter(), sources: SOURCES, now: clock() });
  assert.equal(res.phase, 'idle');
  assert.deepEqual(pdrKeys(store), []);
});

test('a deploy that changes the sources in the middle of a cycle walks them again from the start', async () => {
  const entries = {};
  for (let i = 0; i < 100; i++) entries[`thing:${String(i).padStart(3, '0')}`] = { owner: id(i) };
  entries.site = { rates: { [id(500)]: 1 } };
  const store = memoryStore(entries);
  const report = reporter();
  const now = clock();
  slowly(store, now);
  // The old list: the site value first, then the things. Stop after a few pages.
  const before = [SOURCES[1], SOURCES[0]];
  assert.equal((await runSlice({ store, report, sources: before, now, budgetMs: 1_500 })).phase, 'collect');
  // The new list adds a source in front, so the saved position would point at the wrong one.
  const extra = { prefix: 'extra:', ids: () => [], scrub: () => undefined };
  await untilIdle({ store, report, sources: [extra, ...SOURCES], now, budgetMs: 1_500 });
  const sent = new Set(report.calls.flat().map((a) => a.accountId));
  assert.equal(sent.size, 101);
});

test('a state saved by the first version, with its closed list inside, carries on', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1), people: [id(2)] }, [idPageKey(0)]: [id(1), id(2)] });
  store.map.set(STATE_KEY, { phase: 'report', cycle: '2026-11-04T09:00:00.000Z', since: null, src: 0, cursor: null, pages: 1, count: 2, pos: 2, closed: [id(2)], last: null });
  const res = await runSlice({ store, report: reporter(), sources: SOURCES, now: clock() });
  assert.equal(res.phase, 'idle');
  assert.deepEqual(store.map.get('thing:1').people, []);
  assert.equal(res.last.closed, 1);
  assert.equal(JSON.stringify(store.map.get(STATE_KEY)).includes(id(2)), false);
});

// --- no query cursor is kept between slices -----------------------------------------------

/**
 * Forge says a query cursor may not stay valid, so one must only be used in
 * the slice that got it. This makes the store refuse any cursor from an
 * earlier slice: `next()` starts a new slice.
 */
function cursorsOfOneSlice(store) {
  let slice = 0;
  const page = store.page;
  store.page = async (prefix, cursor, limit) => {
    let plain = null;
    if (cursor) {
      const [of, key] = JSON.parse(cursor);
      if (of !== slice) throw new Error('this cursor is from an earlier slice');
      plain = key;
    }
    const res = await page(prefix, plain, limit);
    return { results: res.results, ...(res.nextCursor ? { nextCursor: JSON.stringify([slice, res.nextCursor]) } : {}) };
  };
  return { next: () => (slice += 1) };
}

async function untilIdleBySlices(args, slices, max = 3000) {
  for (let i = 0; i < max; i++) {
    const res = await runSlice(args);
    if (res.error) throw new Error(res.error);
    if (res.phase === 'idle' && res.ran) return { res, slices: i + 1 };
    slices.next();
  }
  throw new Error('not idle');
}

test('a walk that takes many slices keeps prefixes still to do, never a query cursor, and misses no value', async () => {
  const entries = {};
  // Keys that all start alike, as the app's do (review:1762...:decisions:12), in three groups.
  for (let i = 0; i < 400; i++) entries[`thing:1762077600000:decisions:${i}`] = { owner: id(i) };
  for (let i = 0; i < 300; i++) entries[`thing:1762077600000:people.v2:${i}`] = { owner: id(1000 + i), people: [id(2000 + i)] };
  for (let i = 0; i < 60; i++) entries[`thing:1761000000000:meta${i ? `:${i}` : ''}`] = { owner: id(3000 + i) };
  entries.site = { rates: { [id(9000)]: 1 } };
  const store = memoryStore(entries);
  const slices = cursorsOfOneSlice(store);
  const closed = new Set([id(5), id(1250), id(2299), id(3059), id(9000)]);
  const report = reporter(closed);
  const now = clock();
  slowly(store, now);
  // A few query pages a slice: far less than one prefix needs.
  const args = { store, report, sources: SOURCES, now, budgetMs: 1_500 };
  let sawTodo = false;
  const get = store.get;
  store.get = async (key) => {
    const v = await get(key);
    if (key === STATE_KEY && v) {
      assert.equal('cursor' in v, false, 'no cursor in the state');
      assert.ok(!JSON.stringify(v).includes('nextCursor'));
      if (Array.isArray(v.todo) && v.todo.length > 1) sawTodo = true;
    }
    return v;
  };
  const { res, slices: took } = await untilIdleBySlices(args, slices);
  assert.ok(took > 10, `took ${took} slices`);
  assert.ok(sawTodo, 'the state held the prefixes still to do');
  const sent = report.calls.flat().map((a) => a.accountId);
  assert.equal(new Set(sent).size, 400 + 600 + 60 + 1, 'every stored account was reported');
  assert.equal(sent.length, new Set(sent).size, 'each one once');
  assert.equal(res.last.closed, 5);
  // Every closed account is gone from every value.
  const left = JSON.stringify([...store.map].filter(([k]) => k.startsWith('thing:') || k === 'site'));
  for (const a of closed) assert.ok(!left.includes(a), a);
  assert.deepEqual(pdrKeys(store), []);
});

test('a prefix cut narrower covers every key under it once, whatever the keys look like', () => {
  const keys = ['p', 'p:', 'p:a', 'p:a:1', 'p:a:10', 'p:ab', 'p:b.v2:idx', 'p:z-9_x', 'p:A', 'px', 'q:a'];
  const covered = (units, key) =>
    units.filter(([, base, chars]) => (chars === null ? key === base : chars === '' ? key.startsWith(base) : [...chars].some((c) => key.startsWith(base + c)))).length;
  for (const prefix of ['p', 'p:', 'p:a']) {
    for (const seen of [null, prefix, 'p:a:1', 'p:a', 'other']) {
      const units = narrower(0, prefix, seen);
      for (const key of keys) assert.equal(covered(units, key), key.startsWith(prefix) ? 1 : 0, `${prefix} / ${seen} / ${key}`);
    }
  }
  // It goes straight down to the start the keys read so far share, in one cut.
  assert.deepEqual(narrower(0, 'review:', 'review:1762077600000:decisions:').at(-1), [0, 'review:1762077600000:decisions:', '']);
  assert.ok(KEY_CHARS.includes(':') && KEY_CHARS.includes('.') && KEY_CHARS.includes('-'));
});

test('a prefix whose keys hold a character the cut does not know is never cut: it is walked whole, so no value is skipped', async () => {
  const entries = {};
  for (let i = 0; i < 60; i++) entries[`thing:é${String(i).padStart(2, '0')}`] = { owner: id(i) };
  const store = memoryStore(entries);
  const report = reporter();
  const now = clock();
  slowly(store, now);
  // Too little time for the whole prefix: the slice stops, and the state still holds the prefix whole.
  await runSlice({ store, report, sources: SOURCES, now, budgetMs: 700 });
  const state = store.map.get(STATE_KEY);
  assert.equal(state.phase, 'collect');
  assert.deepEqual(state.todo[0], [0, 'thing:', '']);
  // With time for it, it is walked from its start and every account is reported.
  await untilIdle({ store, report, sources: SOURCES, now, budgetMs: 60_000 });
  assert.equal(new Set(report.calls.flat().map((a) => a.accountId)).size, 60);
});

test('a state saved with a source number and a cursor carries on from the start of that source, without the cursor', async () => {
  const entries = { site: { rates: { [id(900)]: 1 } } };
  for (let i = 0; i < 30; i++) entries[`thing:${String(i).padStart(2, '0')}`] = { owner: id(i) };
  const store = memoryStore(entries);
  const slices = cursorsOfOneSlice(store);
  slices.next();
  // As the version before saved it, part way through the first source.
  store.map.set(STATE_KEY, { phase: 'collect', cycle: '2026-11-04T09:00:00.000Z', since: null, shape: 'p:thing:|k:site', src: 0, cursor: JSON.stringify([0, 'thing:14']), pages: 0, count: 0, pos: 0, closedPages: 0, closedCount: 0, last: null });
  const report = reporter();
  const res = await runSlice({ store, report, sources: SOURCES, now: clock() });
  assert.equal(res.error, undefined);
  assert.equal(res.phase, 'idle');
  assert.equal(new Set(report.calls.flat().map((a) => a.accountId)).size, 31);
});

// --- accounts whose profile changed -----------------------------------------------------------

test('updated accounts are handed to the app, which reads again what it keeps of them, over as many slices as it needs', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1), people: [id(2), id(3)] }, 'thing:2': { owner: id(4) } });
  const answers = { [id(2)]: 'updated', [id(3)]: 'closed', [id(4)]: 'updated' };
  const report = async (accounts) => accounts.filter((a) => answers[a.accountId]).map((a) => ({ accountId: a.accountId, status: answers[a.accountId] }));
  const now = clock();
  const calls = [];
  // The app's refresh does one piece a slice, and says where it is.
  const refresh = async (updated, late, pos) => {
    calls.push({ updated: [...updated].sort(), pos });
    const at = (pos ?? 0) + 1;
    return { done: at >= 3, changed: 1, pos: at };
  };
  const first = await runSlice({ store, report, refresh, sources: SOURCES, now });
  assert.equal(first.phase, 'refresh');
  assert.deepEqual(store.map.get(updatedPageKey(0)), [id(2), id(4)]);
  await runSlice({ store, report, refresh, sources: SOURCES, now });
  const last = await runSlice({ store, report, refresh, sources: SOURCES, now });
  assert.equal(last.phase, 'idle', 'then the closed account is erased and the cycle ends');
  assert.deepEqual(calls, [
    { updated: [id(2), id(4)], pos: null },
    { updated: [id(2), id(4)], pos: 1 },
    { updated: [id(2), id(4)], pos: 2 },
  ]);
  assert.equal(last.last.updated, 2);
  assert.equal(last.last.refreshed, 3);
  assert.equal(last.last.closed, 1);
  assert.deepEqual(store.map.get('thing:1').people, [id(2)]);
  assert.equal([...store.map.keys()].some((k) => k.startsWith('pdr:updated:')), false, 'the updated accounts are deleted when the cycle ends');
  // An app that keeps nothing of a profile gives no refresh: updated accounts then need nothing.
  const plain = memoryStore({ 'thing:1': { owner: id(2) } });
  assert.equal((await runSlice({ store: plain, report, sources: SOURCES, now: clock() })).phase, 'idle');
});

test('a refresh that fails keeps the cycle at that step, and the next slice tries again', async () => {
  const store = memoryStore({ 'thing:1': { owner: id(1) } });
  const report = async (accounts) => accounts.map((a) => ({ accountId: a.accountId, status: 'updated' }));
  let fail = true;
  const refresh = async () => {
    if (fail) throw new Error('Confluence is busy');
    return { done: true, changed: 0, pos: null };
  };
  const now = clock();
  const res = await runSlice({ store, report, refresh, sources: SOURCES, now });
  assert.equal(res.phase, 'refresh');
  assert.match(res.error, /Confluence is busy/);
  fail = false;
  assert.equal((await runSlice({ store, report, refresh, sources: SOURCES, now })).phase, 'idle');
});
