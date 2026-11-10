import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakes } from './fakes.js';
import {
  TIMING,
  KEEP_REVIEWS,
  shardOf,
  withLock,
  getScanState,
  setScanState,
  setGrants,
  getGrants,
  clearRun,
  saveReview,
  reviewsToDrop,
  listReviewIds,
  getReviewMeta,
  setReviewMeta,
  getReviewRows,
  getDecisions,
  setDecisions,
  deleteReview,
} from '../src/lib/store.js';

const { data, hooks } = installFakes();
const reset = () => {
  data.clear();
  hooks.beforeGet = null;
  hooks.beforeSet = null;
  hooks.failStorage = 0;
};

const row = (accountId, extra = {}) => ({ accountId, products: [], groups: [], admin: false, active: true, ...extra });
const entry = (accountId, decision, by = 'admin-1') => ({ accountId, decision, note: '', by, at: '2026-11-10T00:00:00.000Z' });

/** Two account ids that land in the same decision shard. */
function sameShardPair(shards = 64) {
  const seen = new Map();
  for (let i = 0; ; i++) {
    const id = `712020:user-${i}`;
    const s = shardOf(id, shards);
    if (seen.has(s)) return [seen.get(s), id];
    seen.set(s, id);
  }
}

async function publish(id, { status = 'open', rows = [row('u1')] } = {}) {
  await saveReview({ id, status: 'open', generatedAt: new Date(Number(id)).toISOString() }, rows, []);
  if (status === 'complete') await setReviewMeta(id, { status: 'complete', completedAt: '2026-11-01T00:00:00.000Z' });
}

// --- the shard lock ---------------------------------------------------------------

test('two saves that touch the same decision shard at the same moment both land', async () => {
  reset();
  await publish('1000');
  const meta = await getReviewMeta('1000');
  const [a, b] = sameShardPair();
  // Side by side: without the lock both read the shard before either writes,
  // and the second write drops the first decision.
  await Promise.all([setDecisions(meta, [entry(a, 'keep')]), setDecisions(meta, [entry(b, 'remove')])]);
  const stored = await getDecisions(meta);
  assert.equal(stored[a]?.decision, 'keep');
  assert.equal(stored[b]?.decision, 'remove');
  assert.equal([...data.keys()].filter((k) => k.endsWith(':lock')).length, 0, 'every lock is released');
});

test('a lock is released when the work inside it throws', async () => {
  reset();
  await assert.rejects(withLock('some:key', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(data.has('some:key:lock'), false);
  assert.equal(await withLock('some:key', async () => 'again'), 'again');
});

test('a lock left by an invocation that died is taken over; a live one is waited for, then reported busy', async () => {
  reset();
  data.set('some:key:lock', { token: 'dead', at: Date.now() - TIMING.lockStaleMs - 1000 });
  assert.equal(await withLock('some:key', async () => 'took over'), 'took over');

  data.set('some:key:lock', { token: 'alive', at: Date.now() });
  await assert.rejects(withLock('some:key', async () => 'never', { tries: 3 }), (err) => err.busy === true);
  assert.equal(data.get('some:key:lock').token, 'alive', 'a live lock is left alone');
});

test('nothing is written to a review once it is signed off, even by a save that started before', async () => {
  reset();
  await publish('1000');
  const before = await getReviewMeta('1000'); // read while the review was open
  await setReviewMeta('1000', { status: 'complete' });
  const saved = await setDecisions(before, [entry('u1', 'keep')]);
  assert.deepEqual(saved, { count: 0, signedOff: true });
  assert.deepEqual(await getDecisions(before), {});
});

test('bulk marking never overwrites a decision made by hand', async () => {
  reset();
  await publish('1000', { rows: [row('u1'), row('u2'), row('u3')] });
  const meta = await getReviewMeta('1000');
  await setDecisions(meta, [entry('u2', 'remove', 'admin-2')]);
  const saved = await setDecisions(meta, ['u1', 'u2', 'u3'].map((id) => entry(id, 'keep')), { onlyUnset: true });
  assert.equal(saved.count, 2);
  const stored = await getDecisions(meta);
  assert.equal(stored.u2.decision, 'remove');
  assert.equal(stored.u2.by, 'admin-2');
  assert.equal(stored.u1.decision, 'keep');
  assert.equal(stored.u3.decision, 'keep');
});

test('clearing a decision removes the entry', async () => {
  reset();
  await publish('1000');
  const meta = await getReviewMeta('1000');
  await setDecisions(meta, [entry('u1', 'keep')]);
  await setDecisions(meta, [entry('u1', null)]);
  assert.deepEqual(await getDecisions(meta), {});
});

// --- which review makes room for a new one -------------------------------------------

test('over the cap, the oldest review that is not signed off goes first; a signed-off one never does', () => {
  const reviews = (statuses) => statuses.map((status, i) => ({ id: `r${i}`, status }));
  // Newest first. r0 is the one being saved.
  assert.deepEqual(reviewsToDrop(reviews(['open', 'complete', 'open', 'complete']), 3), ['r2']);
  assert.deepEqual(reviewsToDrop(reviews(['open', 'open', 'open', 'complete', 'complete']), 3), ['r2', 'r1']);
  assert.deepEqual(reviewsToDrop(reviews(['open', 'complete', 'complete', 'complete']), 3), [], 'all signed off: nothing is removed');
  assert.deepEqual(reviewsToDrop(reviews(['open', 'complete']), 3), []);
  assert.equal(KEEP_REVIEWS, 12);
});

test('a thirteenth snapshot removes the oldest unsigned review and keeps every signed-off one', async () => {
  reset();
  // Oldest first: 1001 is signed off, 1002 is not, the rest are signed off.
  for (let i = 1; i <= 12; i++) await publish(String(1000 + i), { status: i === 2 ? 'open' : 'complete' });
  await publish('2000');
  const ids = await listReviewIds();
  assert.equal(ids.length, 12);
  assert.equal(ids[0], '2000');
  assert.ok(ids.includes('1001'), 'the oldest review is signed off and stays');
  assert.ok(!ids.includes('1002'), 'the unsigned one made room');
  assert.equal(await getReviewMeta('1002'), undefined);
  assert.deepEqual(await getReviewRows('1001'), [row('u1')]);
});

test('when every kept review is signed off, saving one more removes nothing', async () => {
  reset();
  for (let i = 1; i <= 12; i++) await publish(String(1000 + i), { status: 'complete' });
  await publish('2000');
  assert.equal((await listReviewIds()).length, 13);
  assert.ok(await getReviewMeta('1001'));
});

test('publishing the same snapshot twice keeps the decisions and the sign-off made in between', async () => {
  reset();
  await publish('1000', { rows: [row('u1'), row('u2')] });
  const meta = await getReviewMeta('1000');
  await setDecisions(meta, [entry('u1', 'keep')]);
  await setReviewMeta('1000', { status: 'complete', completedBy: 'admin-1' });
  // A second attempt of the same finalize slice, this time with nothing left to read.
  await saveReview({ id: '1000', status: 'open' }, [], []);
  const again = await getReviewMeta('1000');
  assert.equal(again.status, 'complete');
  assert.equal(again.rowCount, 2);
  assert.equal((await getReviewRows('1000')).length, 2);
  assert.deepEqual(await listReviewIds(), ['1000']);
});

test('deleting a review removes its rows, groups, decisions and record', async () => {
  reset();
  await saveReview({ id: '1000', status: 'open' }, [row('u1')], [{ id: 'g1', name: 'g', products: [] }]);
  await setDecisions(await getReviewMeta('1000'), [entry('u1', 'keep')]);
  await deleteReview('1000');
  assert.deepEqual([...data.keys()].filter((k) => k.startsWith('review:')), []);
  assert.deepEqual(await listReviewIds(), []);
});

// --- storage errors -----------------------------------------------------------------

test('a storage call that fails is tried again before the error is passed on', async () => {
  reset();
  await setScanState({ run: 'r1', status: 'running' });
  hooks.failStorage = 2;
  assert.equal((await getScanState()).run, 'r1');

  hooks.failStorage = TIMING.retries + 1;
  await assert.rejects(getScanState(), /storage unavailable/);
  hooks.failStorage = 0;
});

test('a write the service refuses outright is not tried again', async () => {
  reset();
  let attempts = 0;
  hooks.beforeSet = () => {
    attempts += 1;
    const err = new Error('value too large');
    err.responseDetails = { status: 413 };
    throw err;
  };
  await assert.rejects(setScanState({ run: 'r1' }), /too large/);
  assert.equal(attempts, 1);
});

// --- product-granting groups ----------------------------------------------------------

test('the grants are stored in pages of their own and cleared with the run', async () => {
  reset();
  const grants = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`group-${i}`, ['Jira Software']]));
  const pages = await setGrants('run-1', grants);
  assert.equal(pages, 3);
  assert.deepEqual(await getGrants('run-1', pages), grants);
  await clearRun('run-1', 0, pages);
  assert.deepEqual([...data.keys()], []);
});
