import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakes, fakeSite, call } from './fakes.js';
import { handler } from '../src/index.js';
import { KEEP_REVIEWS, TIMING, saveReview, getReviewMeta, setReviewMeta, getDecisions, getScanState, setScanState, shardOf } from '../src/lib/store.js';

const { data, pushed, hooks } = installFakes();
const reset = () => {
  data.clear();
  pushed.length = 0;
  hooks.beforeGet = null;
  hooks.beforeSet = null;
  hooks.failStorage = 0;
  hooks.failPush = null;
  hooks.admin = true;
  hooks.jira = fakeSite();
};

const row = (accountId, extra = {}) => ({ accountId, products: ['Jira Software'], groups: ['g1'], admin: false, active: true, ...extra });
const GROUPS = [{ id: 'g1', name: 'jira-software-users', products: ['Jira Software'], admin: false, members: 3, licensedMembers: 3, empty: false }];
const ROWS = [row('u1'), row('u2'), row('u3', { active: false, severity: 1, label: '90–180 days' })];

async function publish(id = '1000', rows = ROWS) {
  await saveReview({ id, status: 'open', startedBy: 'admin-1', generatedAt: '2026-11-01T02:40:00.000Z', startedAt: '2026-11-01T02:30:00.000Z', days: 90, counts: { users: rows.length } }, rows, GROUPS);
}
const as = (accountId) => ({ accountId });

// --- who may call ------------------------------------------------------------------

test('a caller who is not a Jira admin is refused by every resolver', async () => {
  reset();
  await publish();
  hooks.admin = false;
  for (const key of ['getStatus', 'getReview', 'setDecision', 'setDecisionsBulk', 'completeReview', 'reopenReview', 'deleteReview', 'startReview', 'cancelScan']) {
    const res = await call(handler, key, { reviewId: '1000', accountId: 'u1', decision: 'keep' });
    assert.equal(res.forbidden, true, key);
  }
  assert.deepEqual(await getDecisions(await getReviewMeta('1000')), {});
});

test('without a licence in production, nothing can be changed', async () => {
  reset();
  await publish();
  const unlicensed = { environmentType: 'PRODUCTION', license: { active: false } };
  for (const key of ['startReview', 'setDecision', 'setDecisionsBulk', 'completeReview', 'reopenReview']) {
    const res = await call(handler, key, { reviewId: '1000', accountId: 'u1', decision: 'keep' }, unlicensed);
    assert.equal(res.unlicensed, true, key);
  }
  assert.equal((await call(handler, 'getReview', { reviewId: '1000' }, unlicensed)).ok, true, 'reading stays open');
  // The page says so: reviews can still be listed, opened (and so downloaded) and deleted.
  assert.equal((await call(handler, 'getStatus', {}, unlicensed)).reviews.length, 1, 'the list stays open');
  assert.equal((await call(handler, 'deleteReview', { reviewId: '1000' }, unlicensed)).ok, true, 'deleting stays open');
  assert.equal(await getReviewMeta('1000'), undefined);
});

// --- decisions and sign-off -----------------------------------------------------------

test('who decided and when come from the server, not from the page', async () => {
  reset();
  await publish();
  const res = await call(handler, 'setDecision', { reviewId: '1000', accountId: 'u1', decision: 'remove', note: '  left in May  ', by: 'someone-else', at: '1999-01-01' }, as('admin-7'));
  assert.equal(res.ok, true);
  const stored = (await getDecisions(await getReviewMeta('1000'))).u1;
  assert.equal(stored.by, 'admin-7');
  assert.equal(stored.note, 'left in May');
  assert.notEqual(stored.at, '1999-01-01');
});

test('a signed-off review refuses decisions, bulk decisions and a second sign-off', async () => {
  reset();
  await publish();
  await call(handler, 'setDecision', { reviewId: '1000', accountId: 'u1', decision: 'keep' });
  const done = await call(handler, 'completeReview', { reviewId: '1000', expectedUndecided: 2 }, as('admin-2'));
  assert.equal(done.ok, true);
  assert.deepEqual(done.review.stats, { total: 3, keep: 1, remove: 0, flag: 0, undecided: 2 });
  assert.equal(done.review.completedBy, 'admin-2');

  for (const [key, payload] of [
    ['setDecision', { reviewId: '1000', accountId: 'u2', decision: 'remove' }],
    ['setDecisionsBulk', { reviewId: '1000', decision: 'keep' }],
    ['completeReview', { reviewId: '1000' }],
  ]) {
    const res = await call(handler, key, payload);
    assert.equal(res.ok, false, key);
    assert.match(res.error, /signed off/, key);
  }
  const stored = await getDecisions(await getReviewMeta('1000'));
  assert.deepEqual(Object.keys(stored), ['u1']);
});

test('sign-off is refused when the page saw a different undecided count than storage holds', async () => {
  reset();
  await publish();
  await call(handler, 'setDecision', { reviewId: '1000', accountId: 'u1', decision: 'keep' });
  // The page believes everyone is decided (rows still loading, or a save that did not land).
  const res = await call(handler, 'completeReview', { reviewId: '1000', expectedUndecided: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.changed, true);
  assert.equal(res.stats.undecided, 2);
  const meta = await getReviewMeta('1000');
  assert.equal(meta.status, 'open');
  assert.equal(meta.completedAt ?? null, null);
});

test('a decision that lands while sign-off is in progress is counted in the totals', async () => {
  reset();
  await publish();
  // The save arrives after sign-off has counted and just before its record is written.
  let fired = false;
  hooks.beforeSet = async (key, value) => {
    if (key === 'review:1000:meta' && value.status === 'complete' && !fired) {
      fired = true;
      hooks.beforeSet = null;
      const late = await call(handler, 'setDecision', { reviewId: '1000', accountId: 'u2', decision: 'remove' });
      assert.equal(late.ok, true);
    }
  };
  const done = await call(handler, 'completeReview', { reviewId: '1000' });
  assert.equal(done.ok, true);
  const meta = await getReviewMeta('1000');
  const stored = await getDecisions(meta);
  assert.equal(stored.u2.decision, 'remove');
  assert.deepEqual(meta.stats, { total: 3, keep: 0, remove: 1, flag: 0, undecided: 2 }, 'the signed totals match the stored decisions');
});

test('with the count the admin saw, that same late decision stops the sign-off instead', async () => {
  reset();
  await publish();
  let fired = false;
  hooks.beforeSet = async (key, value) => {
    if (key === 'review:1000:meta' && value.status === 'complete' && !fired) {
      fired = true;
      hooks.beforeSet = null;
      await call(handler, 'setDecision', { reviewId: '1000', accountId: 'u2', decision: 'remove' });
    }
  };
  const res = await call(handler, 'completeReview', { reviewId: '1000', expectedUndecided: 3 });
  assert.equal(res.changed, true);
  assert.equal((await getReviewMeta('1000')).status, 'open');
});

test('if the final count cannot be taken, the review is left open, not signed with unchecked totals', async () => {
  reset();
  await publish();
  // A save that holds one decision shard and does not let go in time.
  data.set(`review:1000:decisions:${shardOf('u1', 64)}:lock`, { token: 'held', at: Date.now() });
  const tries = TIMING.lockTries;
  TIMING.lockTries = 3;
  const res = await call(handler, 'completeReview', { reviewId: '1000' });
  TIMING.lockTries = tries;
  assert.equal(res.ok, false);
  assert.equal(res.busy, true);
  const meta = await getReviewMeta('1000');
  assert.equal(meta.status, 'open');
  assert.equal(meta.completedAt, null);
});

test('two decisions sent side by side for the same shard both land', async () => {
  reset();
  // Two accounts that share a decision shard.
  const seen = new Map();
  let pair = null;
  for (let i = 0; !pair; i++) {
    const id = `712020:u-${i}`;
    const s = shardOf(id, 64);
    if (seen.has(s)) pair = [seen.get(s), id];
    seen.set(s, id);
  }
  await publish('1000', pair.map((id) => row(id)));
  const [a, b] = await Promise.all(pair.map((accountId) => call(handler, 'setDecision', { reviewId: '1000', accountId, decision: 'keep' })));
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(Object.keys(await getDecisions(await getReviewMeta('1000'))).sort(), [...pair].sort());
});

// --- bulk keep -----------------------------------------------------------------------

test('"keep all active non-admins" picks the rows on the server and leaves hand-made decisions alone', async () => {
  reset();
  await publish('1000', [
    row('active-1'),
    row('active-2'),
    row('admin', { admin: true }),
    row('inactive', { active: false }),
    row('not-checked', { active: false, unchecked: true }),
    row('by-hand'),
  ]);
  await call(handler, 'setDecision', { reviewId: '1000', accountId: 'by-hand', decision: 'remove' }, as('admin-2'));
  const res = await call(handler, 'setDecisionsBulk', { reviewId: '1000', decision: 'keep' });
  assert.deepEqual({ ok: res.ok, decided: res.decided, skipped: res.skipped }, { ok: true, decided: 2, skipped: 1 });
  const stored = await getDecisions(await getReviewMeta('1000'));
  assert.deepEqual(Object.keys(stored).sort(), ['active-1', 'active-2', 'by-hand']);
  assert.equal(stored['by-hand'].decision, 'remove');
  assert.equal(stored['by-hand'].by, 'admin-2');
});

test('a list of accounts from a page loaded before this version is still accepted', async () => {
  reset();
  await publish();
  const res = await call(handler, 'setDecisionsBulk', { reviewId: '1000', decision: 'keep', accountIds: ['u1', 'u1', 'u2'] });
  assert.equal(res.decided, 2);
});

// --- reopening -----------------------------------------------------------------------

test('reopening keeps who signed off, when and the totals, and who reopened; the open review shows no sign-off', async () => {
  reset();
  await publish();
  await call(handler, 'setDecision', { reviewId: '1000', accountId: 'u1', decision: 'keep' });
  await call(handler, 'completeReview', { reviewId: '1000' }, as('admin-A'));
  const first = await getReviewMeta('1000');

  const reopened = await call(handler, 'reopenReview', { reviewId: '1000' }, as('admin-B'));
  assert.equal(reopened.ok, true);
  const open = await getReviewMeta('1000');
  assert.equal(open.status, 'open');
  assert.equal(open.completedAt, null);
  assert.equal(open.completedBy, null);
  assert.equal(open.stats, null);
  assert.equal(open.signoffs.length, 1);
  assert.equal(open.signoffs[0].completedBy, 'admin-A');
  assert.equal(open.signoffs[0].completedAt, first.completedAt);
  assert.deepEqual(open.signoffs[0].stats, { total: 3, keep: 1, remove: 0, flag: 0, undecided: 2 });
  assert.equal(open.signoffs[0].reopenedBy, 'admin-B');
  assert.ok(open.signoffs[0].reopenedAt);

  // Changed, signed off again by B, reopened again by A: both sign-offs stay.
  await call(handler, 'setDecision', { reviewId: '1000', accountId: 'u2', decision: 'remove' }, as('admin-B'));
  await call(handler, 'completeReview', { reviewId: '1000' }, as('admin-B'));
  assert.equal((await getReviewMeta('1000')).signoffs.length, 1, 'signing off again keeps the history');
  await call(handler, 'reopenReview', { reviewId: '1000' }, as('admin-A'));
  const twice = await getReviewMeta('1000');
  assert.deepEqual(twice.signoffs.map((s) => [s.completedBy, s.reopenedBy]), [['admin-A', 'admin-B'], ['admin-B', 'admin-A']]);

  const read = await call(handler, 'getReview', { reviewId: '1000' });
  assert.equal(read.review.completedAt, null);
  assert.equal(read.review.signoffs[0].completedByName, 'Name of admin-A');
  assert.equal(read.review.signoffs[0].reopenedByName, 'Name of admin-B');
});

test('reopening a review that is not signed off changes nothing', async () => {
  reset();
  await publish();
  const res = await call(handler, 'reopenReview', { reviewId: '1000' });
  assert.equal(res.ok, false);
  assert.equal((await getReviewMeta('1000')).signoffs, undefined);
});

test('a review reopened by the previous version reads as open with its one earlier sign-off, and keeps it when signed again', async () => {
  reset();
  await publish();
  // The shape the previous version left behind: live sign-off fields on an open review.
  const stats = { total: 3, keep: 3, remove: 0, flag: 0, undecided: 0 };
  await setReviewMeta('1000', { status: 'open', completedAt: '2026-10-01T01:00:00.000Z', completedBy: 'admin-A', stats, reopenedAt: '2026-10-20T09:00:00.000Z', reopenedBy: 'admin-B' });

  const status = await call(handler, 'getStatus');
  assert.equal(status.reviews[0].completedAt, null);
  assert.equal(status.reviews[0].stats, null);
  assert.equal(status.reviews[0].signoffs.length, 1);
  const read = await call(handler, 'getReview', { reviewId: '1000' });
  assert.equal(read.review.completedByName, null);
  assert.deepEqual(read.review.signoffs.map((s) => [s.completedAt, s.completedByName, s.reopenedByName]), [['2026-10-01T01:00:00.000Z', 'Name of admin-A', 'Name of admin-B']]);

  await call(handler, 'completeReview', { reviewId: '1000' }, as('admin-C'));
  const signed = await getReviewMeta('1000');
  assert.equal(signed.completedBy, 'admin-C');
  assert.equal(signed.signoffs[0].completedBy, 'admin-A');
});

// --- reviews stored by the previous version -------------------------------------------

test('a review saved in the oldest stored shape (groups inline, 16 decision shards, 250-row pages) still opens with its decisions', async () => {
  reset();
  const rows = [row('u1'), row('u2')];
  data.set('review:900:meta', { id: '900', status: 'complete', startedAt: '2026-10-13T01:00:00.000Z', generatedAt: '2026-10-13T01:05:00.000Z', completedAt: '2026-10-13T02:00:00.000Z', completedBy: 'admin-1', startedBy: 'admin-1', days: 90, counts: { users: 2, admins: 0, inactive: 0, noAccess: 0 }, stats: { total: 2, keep: 1, remove: 0, flag: 0, undecided: 1 }, pages: 1, pageSize: 250, rowCount: 2, groups: GROUPS, changes: { counts: { added: 1, removed: 1, becameAdmin: 0, gainedProducts: 0 }, added: ['u2'], removed: ['gone-1'], becameAdmin: [], gainedProducts: [] } });
  data.set('review:900:rows:0', rows);
  data.set(`review:900:decisions:${shardOf('u1', 16)}`, { u1: { decision: 'keep', note: 'ok', by: 'admin-1', at: '2026-10-13T01:30:00.000Z' } });
  data.set('reviews:index', ['900']);

  const read = await call(handler, 'getReview', { reviewId: '900' });
  assert.equal(read.ok, true);
  assert.equal(read.rows.length, 2);
  assert.equal(read.rows[0].decision, 'keep');
  assert.equal(read.rows[0].decidedByName, 'Name of admin-1');
  assert.equal(read.rows[1].newSinceLast, true, 'the capped list still flags rows of an old review');
  assert.equal(read.review.status, 'complete');
  assert.equal(read.review.completedAt, '2026-10-13T02:00:00.000Z');
  assert.equal(read.review.completedByName, 'Name of admin-1');
  assert.deepEqual(read.review.signoffs, []);
  assert.equal(read.review.groups.length, 1);
  assert.deepEqual(read.review.gone, [{ accountId: 'gone-1', displayName: 'Name of gone-1', email: 'gone-1@example.com' }]);

  assert.match((await call(handler, 'setDecision', { reviewId: '900', accountId: 'u2', decision: 'keep' })).error, /signed off/);
  assert.equal((await call(handler, 'reopenReview', { reviewId: '900' })).ok, true);
  assert.equal((await call(handler, 'setDecision', { reviewId: '900', accountId: 'u2', decision: 'keep' })).ok, true);
  assert.ok(data.get(`review:900:decisions:${shardOf('u2', 16)}`).u2, 'still written to the 16-shard layout');
  assert.equal((await call(handler, 'deleteReview', { reviewId: '900' })).ok, true);
  assert.deepEqual([...data.keys()].filter((k) => k.startsWith('review:900')), []);
});

// --- starting a snapshot --------------------------------------------------------------

test('a new review is refused when all twelve kept reviews are signed off, and names the oldest', async () => {
  reset();
  for (let i = 1; i <= KEEP_REVIEWS; i++) {
    await saveReview({ id: String(1000 + i), status: 'open', generatedAt: `2026-${String(i).padStart(2, '0')}-05T00:00:00.000Z` }, [row('u1')], []);
    await setReviewMeta(String(1000 + i), { status: 'complete' });
  }
  const refused = await call(handler, 'startReview', { days: 90 });
  assert.equal(refused.ok, false);
  assert.equal(refused.full, true);
  assert.match(refused.error, /2026-01-05/);
  assert.equal(await getScanState(), undefined, 'nothing was started');
  assert.equal(pushed.length, 0);

  // One review that is not signed off is enough: it will make room.
  await setReviewMeta('1003', { status: 'open' });
  const started = await call(handler, 'startReview', { days: 90 }, as('admin-1'));
  assert.equal(started.ok, true);
  assert.equal(started.state.startedBy, 'admin-1');
  assert.deepEqual(pushed, [{ run: started.state.run, seq: 0 }]);
});

// --- a paused run ----------------------------------------------------------------------

test('the status call sends the next event for a paused run and clears the flag', async () => {
  reset();
  await setScanState({ run: 'r1', status: 'running', phase: 'verify', seq: 7, verifyShard: 3, paused: true, pauseReason: 'limit' });
  const res = await call(handler, 'getStatus');
  assert.deepEqual(pushed, [{ run: 'r1', seq: 7 }]);
  assert.equal(res.state.paused, false);
  assert.equal(res.state.verifyShard, 3, 'the cursor is untouched');
  assert.equal(res.stale, false);

  // A second poll finds nothing to resume.
  await call(handler, 'getStatus');
  assert.equal(pushed.length, 1);
});

test('if that push fails too, the run stays paused with everything kept', async () => {
  reset();
  await setScanState({ run: 'r1', status: 'running', phase: 'members', seq: 2, paused: true });
  hooks.failPush = new Error('still limited');
  const res = await call(handler, 'getStatus');
  assert.equal(res.state.paused, true);
  assert.equal(res.state.status, 'running');
  assert.equal(res.state.seq, 2);
  hooks.failPush = null;
  await call(handler, 'getStatus');
  assert.deepEqual(pushed, [{ run: 'r1', seq: 2 }]);
});

test('cancelling stops a running snapshot', async () => {
  reset();
  await setScanState({ run: 'r1', status: 'running', phase: 'verify', seq: 4 });
  assert.equal((await call(handler, 'cancelScan')).ok, true);
  assert.equal((await getScanState()).status, 'cancelled');
});
