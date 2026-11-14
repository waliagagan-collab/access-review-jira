import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { kvs, WhereConditions } from '@forge/kvs';
import api from '@forge/api';
import { installFakes, fakeSite, call, drain, refuse } from './fakes.js';
import { handler as worker } from '../src/worker.js';
import { handler as resolver } from '../src/index.js';
import { getScanState, getReviewMeta, getReviewRows, getDecisions, shardOf, decisionsKey } from '../src/lib/store.js';
import { closedMarker, isClosedAccount } from '../src/lib/review.js';
import { runSlice, kvsStore } from '../src/lib/privacy.js';
import * as personal from '../src/lib/personal-data.js';

/**
 * The weekly personal data report on a fake site. Snapshots store the
 * account IDs of every group member, of the admin who started them, and of
 * who decided, signed off and reopened each review; notes can quote an
 * account ID, and a failed snapshot keeps Jira's error text, which can too.
 * Atlassian says some accounts were closed; after the report none of their
 * account IDs is left, signed-off and open reviews keep every row, decision
 * and total under a marker, and everyone else is as they were.
 */

const { data, pushed, hooks } = installFakes();

const ALICE = '5b10ac8d82e05b22cc7d4e01'; // inactive, marked Remove with a note; closes her account
const BOB = '5b10ac8d82e05b22cc7d4e02'; // active; his note quotes Alice's account ID
const CAROL = '5b10ac8d82e05b22cc7d4e03'; // active; joins an admin group before the second snapshot
const DAN = '5b10ac8d82e05b22cc7d4e04'; // inactive; leaves before the second snapshot; closes
const EVE = '5b10ac8d82e05b22cc7d4e05'; // added before the second snapshot; closes
const ADMIN = '712020:2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'; // starts, decides, signs off and reopens; closes too
const OTHER_ADMIN = '5b10ac8d82e05b22cc7d4e09';
const PEOPLE = [ALICE, BOB, CAROL, DAN, EVE, ADMIN, OTHER_ADMIN];
const CLOSED = [ALICE, DAN, EVE, ADMIN];

const ROLES = [
  { key: 'jira-software', name: 'Jira Software', userCount: 6, groupDetails: [{ groupId: 'g-jsw', name: 'jira-software-users' }] },
  { key: 'jira-servicedesk', name: 'Jira Service Management', userCount: 2, groupDetails: [{ groupId: 'g-adm', name: 'site-admins' }] },
];
const ACTIVE = new Set([ADMIN, OTHER_ADMIN, BOB, CAROL, EVE]);
const recently = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

let members;
const site = () =>
  fakeSite({
    roles: ROLES,
    groups: [
      { groupId: 'g-jsw', name: 'jira-software-users', members: members.jsw },
      { groupId: 'g-adm', name: 'site-admins', members: members.adm },
      { groupId: 'g-empty', name: 'old-contractors', members: [] },
    ],
    // The first pass sees Bob create an issue.
    swept: [{ fields: { created: recently, creator: { accountId: BOB }, reporter: { accountId: BOB } } }],
    active: (id) => ACTIVE.has(id),
  });

const reset = () => {
  data.clear();
  pushed.length = 0;
  Object.assign(hooks, { beforeGet: null, beforeSet: null, failStorage: 0, failPush: null, admin: true });
  for (const list of [hooks.calls, hooks.writes, hooks.reported, hooks.closed]) list.length = 0;
  members = { jsw: [ADMIN, OTHER_ADMIN, ALICE, BOB, CAROL, DAN], adm: [ADMIN, OTHER_ADMIN] };
  hooks.jira = site();
};

const as = (accountId) => ({ accountId });

async function snapshot(by) {
  const res = await call(resolver, 'startReview', { days: 90 }, as(by));
  assert.equal(res.ok, true, res.error);
  await drain(worker, pushed, { max: 200 });
  return getScanState();
}

async function act(key, payload, by) {
  const res = await call(resolver, key, payload, as(by));
  assert.equal(res.ok, true, `${key}: ${res.error}`);
  return res;
}

/** Jira rejects the activity query for the admin, quoting the account ID, so the snapshot fails with that text. */
const quotingAdmin = (base) => (path) => {
  const jql = path.startsWith('/rest/api/3/search/jql') ? new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('jql') ?? '' : '';
  if (jql.includes(`CHANGED BY "${ADMIN}"`)) return refuse(400, { errorMessages: [`The value '${ADMIN}' does not exist for the field 'worklogAuthor'.`] });
  return base(path);
};

/**
 * Two reviews and a failed snapshot, touching every stored value:
 *   first   signed off by Admin, reopened by Admin, signed off again by the
 *           other admin. Admin decided on Alice (Remove, with a note), Bob
 *           (Keep, a note that quotes Alice's ID), Dan and the other admin.
 *   second  open, taken after Dan left, Eve joined and Carol joined an admin
 *           group. Its first slice could not queue the next one (paused), and
 *           the page's status call carried it on.
 *   last    a snapshot Admin started that failed with Jira's error quoting him.
 */
async function buildSite() {
  const first = (await snapshot(ADMIN)).reviewId;
  await act('setDecision', { reviewId: first, accountId: ALICE, decision: 'remove', note: 'Left in May' }, ADMIN);
  await act('setDecision', { reviewId: first, accountId: BOB, decision: 'keep', note: `Covers for ${ALICE}` }, ADMIN);
  await act('setDecision', { reviewId: first, accountId: DAN, decision: 'flag', note: 'Ask his manager' }, ADMIN);
  await act('setDecision', { reviewId: first, accountId: OTHER_ADMIN, decision: 'keep' }, ADMIN);
  await act('setDecision', { reviewId: first, accountId: ADMIN, decision: 'keep' }, OTHER_ADMIN);
  await act('setDecisionsBulk', { reviewId: first, decision: 'keep' }, OTHER_ADMIN); // Carol
  await act('completeReview', { reviewId: first }, ADMIN);
  await act('reopenReview', { reviewId: first }, ADMIN);
  await act('completeReview', { reviewId: first }, OTHER_ADMIN);
  await act('hideReviewPrompt', {}, OTHER_ADMIN);

  members.jsw = [ADMIN, OTHER_ADMIN, ALICE, BOB, CAROL, EVE];
  members.adm = [ADMIN, OTHER_ADMIN, CAROL];
  hooks.jira = site();
  await act('startReview', { days: 90 }, OTHER_ADMIN);
  hooks.failPush = new Error('Too many events in one chain');
  await worker({ body: pushed.shift() });
  hooks.failPush = null;
  assert.equal((await getScanState()).paused, true);
  await act('getStatus', {}, OTHER_ADMIN);
  await drain(worker, pushed, { max: 200 });
  const second = (await getScanState()).reviewId;
  await act('setDecision', { reviewId: second, accountId: EVE, decision: 'flag', note: 'Who added her?' }, ADMIN);

  hooks.jira = quotingAdmin(site());
  const failed = await snapshot(ADMIN);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error.includes(ADMIN), 'the error text quotes the admin');
  hooks.jira = site();
  return { first, second };
}

/** A sign-off, a reopen or a bulk decision that started more than a minute ago is over. */
const actionsOver = () => data.set('action:started', { at: new Date(Date.now() - 2 * 60_000).toISOString() });
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

const slice = () => runSlice({ store: kvsStore(kvs, WhereConditions), report: api.privacy.reportPersonalData, sources: personal.SOURCES, busy: personal.busy });

/** Every slice the hourly trigger would run, until this week's report is done. */
async function runReport() {
  for (let i = 0; i < 50; i++) {
    const res = await slice();
    assert.equal(res.error, undefined, res.error);
    if (data.get('pdr:state')?.phase === 'idle') return data.get('pdr:state').last;
  }
  throw new Error('the report did not finish');
}

const appValues = () => [...data.entries()].filter(([k]) => !k.startsWith('pdr:'));
const storedText = () => JSON.stringify(appValues());
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.accountId, r]));
/** Where each person's row is in a review, as the marker the report gives it. */
const markersOf = (rows) => Object.fromEntries(rows.map((r, i) => [r.accountId, closedMarker(Math.floor(i / 100), i % 100)]));

// --- every key the app writes ------------------------------------------------------

/**
 * Every key the app writes, and whether a source reads it ('source') or it
 * holds no account ID ('none'). The report's own pdr: keys are left out: they
 * belong to lib/privacy.js, which deletes the account IDs it gathered when a
 * report ends.
 */
const KEYS = {
  'scan:state': 'source', // the snapshot in progress or the last one: who started it, an error text
  'scan:{run}:users:{s}': 'source', // working data: every group member, by account ID
  'scan:{run}:active:{s}': 'source', // working data: what each member did, by account ID
  'scan:{run}:groups:{i}': 'none', // working data: group IDs, names, products, member counts
  'scan:{run}:grants:{i}': 'none', // working data: which group grants which Jira product
  'reviews:index': 'none', // review IDs, newest first
  'review:{id}:meta': 'source', // who started, signed off and reopened; earlier sign-offs; who changed since the last review
  'review:{id}:rows:{i}': 'source', // one row per person
  'review:{id}:groups:{i}': 'none', // the review's groups: IDs, names, products, counts
  'review:{id}:decisions:{s}': 'source', // each person's decision and note, and who decided
  'action:started': 'none', // when a snapshot, a sign-off, a reopen, a bulk decision or a delete last started
  settings: 'none', // the day the review request was closed
};
/** The locks withLock writes beside a key: a token and a time. */
const LOCKS = { 'scan:state:lock': 'none', 'review:{id}:decisions:{s}:lock': 'none' };
const ALL = { ...KEYS, ...LOCKS };
const sample = (pattern) => pattern.replace(/\{(run|id)\}/g, '1762000000000').replace(/\{\w+\}/g, '3');
const patternOf = (key) => Object.keys(ALL).find((p) => new RegExp(`^${p.replace(/\{(run|id)\}/g, '[^:]+').replace(/\{\w+\}/g, '\\d+')}$`).test(key));
const walked = (key) => personal.SOURCES.some((s) => (s.key ? s.key === key : key.startsWith(s.prefix)));

test('every key the app writes is listed, and each is read by a source or holds no account ID', () => {
  // The key names in store.js are the only keys the app writes besides the report's own and the locks.
  const store = readFileSync(new URL('../src/lib/store.js', import.meta.url), 'utf8');
  const defined = [...store.matchAll(/^(?:export )?const \w*(?:KEY|INDEX|Key)\w* = (?:\([^)]*\) => )?[`'"]([^`'"]+)[`'"]/gm)].map((m) => m[1].replace(/\$\{(\w+)\}/g, '{$1}'));
  assert.deepEqual(defined.sort(), Object.keys(KEYS).sort(), 'a key was added to or taken from store.js: list it here, and give it a source if it can hold an account ID');
  assert.ok(store.includes('const name = `${key}:lock`;'), 'a lock is the key it guards with ":lock" after it');
  for (const [pattern, what] of Object.entries(ALL)) {
    const key = sample(pattern);
    assert.equal(patternOf(key), pattern);
    assert.equal(personal.kindOf(key) !== null, what === 'source', pattern);
    if (what === 'source') assert.ok(walked(key), `${pattern} is walked by a source`);
  }
  // Nothing else in src writes to storage.
  const files = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}${e.name}/`) : [`${dir}${e.name}`]));
  for (const file of files('../src/')) {
    if (['../src/lib/store.js', '../src/lib/privacy.js', '../src/lib/personal-data.js', '../src/privacy.js'].includes(file)) continue;
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/@forge\/kvs|\bkvs\.|\bstorage\.(set|get|delete)\b/.test(text), `${file} must not write storage itself`);
  }
});

test('every account ID in every value the app writes is found: snapshots, decisions, notes, sign-offs, reopens, changes, errors', async () => {
  reset();
  await buildSite();
  const seen = new Set();
  for (const [key, value] of hooks.writes) {
    if (key.startsWith('pdr:')) continue;
    const pattern = patternOf(key);
    assert.ok(pattern, `${key} is not in the list of keys`);
    seen.add(pattern);
    const text = JSON.stringify(value);
    const held = PEOPLE.filter((id) => text.includes(id));
    if (ALL[pattern] === 'none') assert.deepEqual(held, [], `${key} holds no account ID`);
    else for (const id of held) assert.ok(personal.idsIn(key, value).includes(id), `${key}: ${id} is found`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(ALL).sort(), 'every listed key was written in these runs');
});

// --- the weekly report over a whole site ------------------------------------------

test('closed accounts are erased everywhere; rows, decisions and totals stay under markers; nobody else is touched', async () => {
  reset();
  const { first, second } = await buildSite();
  actionsOver();
  const before = {
    first: await getReviewMeta(first),
    second: await getReviewMeta(second),
    firstRows: await getReviewRows(first),
    secondRows: await getReviewRows(second),
    firstDecisions: await getDecisions(await getReviewMeta(first)),
    secondDecisions: await getDecisions(await getReviewMeta(second)),
    state: await getScanState(),
    settings: data.get('settings'),
    index: data.get('reviews:index'),
  };
  assert.deepEqual(before.second.changes.removed, [DAN]);
  assert.deepEqual(before.second.changes.added, [EVE]);
  assert.deepEqual(before.second.changes.becameAdmin, [CAROL]);

  hooks.closed.push(...CLOSED);
  const last = await runReport();
  assert.deepEqual(new Set(hooks.reported.map((a) => a.accountId)), new Set(PEOPLE), 'every stored account is reported');
  assert.equal(hooks.reported.length, PEOPLE.length, 'once each');
  assert.equal(last.accounts, PEOPLE.length);
  assert.equal(last.closed, CLOSED.length);
  assert.equal(last.unreadable, 0);
  assert.ok(!hooks.reported.some((a) => isClosedAccount(a.accountId)), 'a marker is never reported');

  for (const id of CLOSED) assert.ok(!storedText().includes(id), `${id} is erased`);
  for (const id of [BOB, CAROL, OTHER_ADMIN]) assert.ok(storedText().includes(id), `${id} stays`);
  assert.ok(![...data.keys()].some((k) => k.startsWith('pdr:ids:') || k.startsWith('pdr:closed:')), 'the gathered IDs go when the report ends');

  // The signed-off review: every row stays, the closed ones under the marker of their place.
  const marker = markersOf(before.firstRows);
  const rows = await getReviewRows(first);
  assert.equal(rows.length, before.firstRows.length);
  rows.forEach((r, i) => {
    const was = before.firstRows[i];
    assert.deepEqual(r, CLOSED.includes(was.accountId) ? { ...was, accountId: marker[was.accountId] } : was);
  });
  // Their decisions stay with the row, without the note; a closed admin who decided is cleared and flagged.
  const decisions = await getDecisions(await getReviewMeta(first));
  const d = before.firstDecisions;
  assert.deepEqual(decisions[marker[ALICE]], { decision: 'remove', note: '', by: null, at: d[ALICE].at, byClosed: true });
  assert.deepEqual(decisions[marker[DAN]], { decision: 'flag', note: '', by: null, at: d[DAN].at, byClosed: true });
  assert.deepEqual(decisions[marker[ADMIN]], { ...d[ADMIN], note: '' }, 'decided by the other admin: kept');
  assert.deepEqual(decisions[BOB], { ...d[BOB], note: 'Covers for (closed account)', by: null, byClosed: true });
  assert.deepEqual(decisions[OTHER_ADMIN], { ...d[OTHER_ADMIN], by: null, byClosed: true });
  assert.deepEqual(decisions[CAROL], d[CAROL], 'decided by the other admin');
  assert.equal(Object.keys(decisions).length, Object.keys(d).length);
  // Each moved decision sits in the shard its marker belongs to, once.
  for (const id of [ALICE, DAN, ADMIN]) {
    const holders = Object.keys(Object.fromEntries([...data.entries()].filter(([k, v]) => k.startsWith(`review:${first}:decisions:`) && !k.endsWith(':lock') && v?.[marker[id]])));
    assert.deepEqual(holders, [decisionsKey(first, shardOf(marker[id], 64))]);
  }
  // The record: the closed admin who started, signed off and reopened is cleared and flagged; totals stay.
  const meta = await getReviewMeta(first);
  assert.deepEqual(meta, {
    ...before.first,
    startedBy: null,
    startedByClosed: true,
    reopenedBy: null,
    reopenedByClosed: true,
    signoffs: [{ ...before.first.signoffs[0], completedBy: null, completedByClosed: true, reopenedBy: null, reopenedByClosed: true }],
  });
  assert.equal(meta.completedBy, OTHER_ADMIN);
  assert.deepEqual(meta.stats, before.first.stats);
  assert.deepEqual(meta.counts, before.first.counts);

  // The open review is treated the same way: rows and counts stay, the closed accounts leave the lists of changes.
  const secondMarker = markersOf(before.secondRows);
  const secondRows = await getReviewRows(second);
  secondRows.forEach((r, i) => {
    const was = before.secondRows[i];
    assert.deepEqual(r, CLOSED.includes(was.accountId) ? { ...was, accountId: secondMarker[was.accountId] } : was);
  });
  assert.equal(byId(secondRows)[secondMarker[EVE]].newSinceLast, true, 'Eve was added since the review before');
  assert.deepEqual((await getDecisions(await getReviewMeta(second)))[secondMarker[EVE]], { ...before.secondDecisions[EVE], note: '', by: null, byClosed: true });
  const secondMeta = await getReviewMeta(second);
  assert.deepEqual(secondMeta.changes, { ...before.second.changes, added: [], removed: [] });
  assert.deepEqual(secondMeta.counts, before.second.counts);
  assert.equal(secondMeta.startedBy, OTHER_ADMIN);

  // The failed snapshot: its starter is cleared, and the error text no longer quotes him.
  const state = await getScanState();
  assert.deepEqual(state, { ...before.state, startedBy: null, startedByClosed: true, error: before.state.error.replace(ADMIN, '(closed account)') });
  assert.match(state.error, /The value '\(closed account\)' does not exist for the field 'worklogAuthor'\./);
  assert.deepEqual(data.get('settings'), before.settings);
  assert.deepEqual(data.get('reviews:index'), before.index);
});

test('no closed account: nothing changes but the report state', async () => {
  reset();
  await buildSite();
  actionsOver();
  const keep = new Map(appValues());
  const last = await runReport();
  assert.equal(last.closed, 0);
  assert.equal(last.accounts, PEOPLE.length);
  assert.deepEqual(new Map(appValues()), keep);
});

test('a later report gives a second closed person of the same review a marker of their own, and leaves the first alone', async () => {
  reset();
  const { first } = await buildSite();
  actionsOver();
  const rows = await getReviewRows(first);
  const marker = markersOf(rows);
  hooks.closed.push(ALICE);
  await runReport();
  const once = await getDecisions(await getReviewMeta(first));
  hooks.closed.length = 0;
  hooks.closed.push(DAN);
  data.set('pdr:state', { phase: 'idle', last: null });
  await runReport();
  const after = byId(await getReviewRows(first));
  assert.ok(after[marker[ALICE]] && after[marker[DAN]] && marker[ALICE] !== marker[DAN]);
  const twice = await getDecisions(await getReviewMeta(first));
  assert.deepEqual(twice[marker[ALICE]], once[marker[ALICE]]);
  assert.equal(twice[marker[DAN]].decision, 'flag');
});

test('a run cut short between the decisions and the rows is ended by the next one, with the same markers', async () => {
  reset();
  const { first } = await buildSite();
  actionsOver();
  const before = await getReviewRows(first);
  const marker = markersOf(before);
  const decided = await getDecisions(await getReviewMeta(first));
  // The first write of a row page fails, after the decisions have moved.
  let failed = false;
  hooks.beforeSet = async (key) => {
    if (!failed && key.startsWith(`review:${first}:rows:`)) {
      failed = true;
      throw new Error('storage unavailable');
    }
  };
  hooks.closed.push(ALICE);
  let res;
  for (let i = 0; i < 10 && !failed; i++) res = await slice();
  for (let i = 0; i < 10 && !res?.error; i++) res = await slice();
  assert.equal(res.error, 'storage unavailable');
  const half = await getDecisions(await getReviewMeta(first));
  assert.equal(half[marker[ALICE]].decision, 'remove', 'the decision has moved');
  assert.equal(half[ALICE], undefined);
  assert.ok((await getReviewRows(first)).some((r) => r.accountId === ALICE), 'the row has not');

  await runReport();
  assert.ok(!storedText().includes(ALICE));
  const rows = await getReviewRows(first);
  assert.equal(rows.find((r) => isClosedAccount(r.accountId)).accountId, marker[ALICE]);
  assert.deepEqual((await getDecisions(await getReviewMeta(first)))[marker[ALICE]], { ...decided[ALICE], note: '' });
});

// --- when erasing waits --------------------------------------------------------------

test('erasing waits within a minute of a sign-off, a reopen, a bulk decision, a delete or a snapshot starting', async () => {
  reset();
  const { first, second } = await buildSite();
  hooks.closed.push(ALICE);
  for (let i = 0; i < 4; i++) await slice();
  assert.equal(data.get('pdr:state').phase, 'erase');
  assert.ok(data.get('pdr:state').waits >= 1);
  assert.ok(storedText().includes(ALICE), 'nothing erased within a minute of the last snapshot starting');

  for (const [key, payload] of [
    ['reopenReview', { reviewId: first }],
    ['completeReview', { reviewId: first }],
    ['setDecisionsBulk', { reviewId: second, decision: 'keep' }],
    ['deleteReview', { reviewId: 'none' }],
    ['cancelScan', {}],
  ]) {
    actionsOver();
    await call(resolver, key, payload, as(OTHER_ADMIN));
    const waits = data.get('pdr:state').waits;
    await slice();
    assert.equal(data.get('pdr:state').waits, waits + 1, `${key} holds it back`);
    assert.ok(storedText().includes(ALICE));
  }
  actionsOver();
  await runReport();
  assert.ok(!storedText().includes(ALICE));
});

test('erasing waits while a snapshot runs; once it stops moving, its working data is erased and it can still finish', async () => {
  reset();
  await buildSite();
  hooks.closed.push(ALICE, ADMIN);
  // A new snapshot, part way: its working data holds every group member.
  await act('startReview', { days: 90 }, ADMIN);
  while ((await getScanState()).phase !== 'verify') await worker({ body: pushed.shift() });
  const scratch = [...data.keys()].filter((k) => /^scan:\d+:(users|active):/.test(k));
  assert.ok(scratch.some((k) => k.includes(':users:')) && scratch.some((k) => k.includes(':active:')));
  actionsOver();
  for (let i = 0; i < 4; i++) await slice();
  assert.equal(data.get('pdr:state').phase, 'erase');
  assert.ok(data.get('pdr:state').waits >= 1);
  assert.ok(storedText().includes(ALICE), 'nothing erased while the snapshot runs');

  // The snapshot stops moving for 20 minutes: erasing goes ahead, working data included.
  data.set('scan:state', { ...data.get('scan:state'), updatedAt: minutesAgo(21) });
  await runReport();
  assert.ok(!storedText().includes(ALICE) && !storedText().includes(ADMIN));
  const state = await getScanState();
  assert.equal(state.startedBy, null);
  assert.equal(state.startedByClosed, true);
  assert.equal(state.status, 'running', 'the snapshot itself is left as it was');

  // Its next event comes after all: it finishes, without the closed accounts, and says who started it.
  await drain(worker, pushed, { max: 200 });
  const done = await getScanState();
  assert.equal(done.status, 'complete');
  const rows = await getReviewRows(done.reviewId);
  assert.deepEqual(rows.map((r) => r.accountId).sort(), [OTHER_ADMIN, BOB, CAROL, EVE].sort());
  const meta = await getReviewMeta(done.reviewId);
  assert.equal(meta.startedBy, null);
  assert.equal(meta.startedByClosed, true);
});

test('busy: a running snapshot holds erasing back until it stops moving, and so does a change that writes, for a minute', async () => {
  const at = Date.parse('2026-11-14T10:00:00.000Z');
  const ago = (min) => new Date(at - min * 60_000).toISOString();
  const { scanLive, actionLive, busy } = personal;
  assert.equal(scanLive({ status: 'running', updatedAt: ago(1) }, at), true);
  assert.equal(scanLive({ status: 'running', updatedAt: ago(20) }, at), true);
  assert.equal(scanLive({ status: 'running', updatedAt: ago(21) }, at), false, 'stopped moving');
  assert.equal(scanLive({ status: 'running', startedAt: ago(2) }, at), true, 'no update yet');
  assert.equal(scanLive({ status: 'running', paused: true, updatedAt: ago(1) }, at), true, 'paused: the page picks it up');
  assert.equal(scanLive({ status: 'running', paused: true, updatedAt: ago(30) }, at), false, 'paused and left');
  assert.equal(scanLive({ status: 'running' }, at), false, 'no time to go by');
  for (const status of ['complete', 'failed', 'cancelled']) assert.equal(scanLive({ status, updatedAt: ago(1) }, at), false, status);
  assert.equal(scanLive(null, at), false);
  assert.equal(actionLive({ at: ago(0.5) }, at), true);
  assert.equal(actionLive({ at: ago(1) }, at), false, 'a minute on, it has ended');
  assert.equal(actionLive({ at: new Date(at + 5000).toISOString() }, at), true, 'a clock a little ahead');
  for (const mark of [null, undefined, {}, { at: 'soon' }]) assert.equal(actionLive(mark, at), false, JSON.stringify(mark));
  const none = async () => undefined;
  assert.equal(await busy(async () => ({ status: 'running', updatedAt: ago(1) }), none, () => at), true);
  assert.equal(await busy(none, async () => ({ at: ago(0.2) }), () => at), true);
  assert.equal(await busy(none, async () => ({ at: ago(5) }), () => at), false);
  assert.equal(await busy(none, none, () => at), false);
});

test('a write is refused when the app started writing since the report last asked, and reads the value again otherwise', async () => {
  const map = new Map([
    ['scan:1:users:0', { [ALICE]: { products: [], groups: ['g'] }, [BOB]: { products: [], groups: ['g'] } }],
    // A review that was never published whole: no record.
    ['review:9:rows:0', [{ accountId: ALICE }, { accountId: BOB }]],
    ['review:9:decisions:3', { [ALICE]: { decision: 'keep', note: 'x', by: BOB, at: 't' }, [BOB]: { decision: 'keep', note: '', by: ALICE, at: 't' } }],
  ]);
  const store = {
    get: async (k) => structuredClone(map.get(k)),
    set: async (k, v) => void map.set(k, v),
  };
  const locked = [];
  const lock = async (key, fn) => (locked.push(key), fn());
  const closed = new Set([ALICE]);
  const [reviews, scans] = personal.personalDataSources(store, async () => true, lock);
  await assert.rejects(scans.erase('scan:1:users:0', closed), new RegExp(personal.BUSY_MESSAGE));
  assert.equal(Object.keys(map.get('scan:1:users:0')).length, 2);
  const [freeReviews, freeScans] = personal.personalDataSources(store, async () => false, lock);
  assert.equal(await freeScans.erase('scan:1:users:0', closed), true);
  assert.deepEqual(Object.keys(map.get('scan:1:users:0')), [BOB]);
  assert.equal(await freeScans.erase('scan:1:users:0', closed), false, 'nothing left to change');
  assert.equal(await freeScans.erase('scan:1:users:9', closed), false, 'gone since the walk read it');
  // Pages with no record: the row gets its marker where it is; the decision goes, under the shard's lock.
  assert.equal(await freeReviews.erase('review:9:rows:0', closed), true);
  assert.deepEqual(map.get('review:9:rows:0'), [{ accountId: closedMarker(0, 0) }, { accountId: BOB }]);
  assert.equal(await freeReviews.erase('review:9:decisions:3', closed), true);
  assert.deepEqual(map.get('review:9:decisions:3'), { [BOB]: { decision: 'keep', note: '', by: null, byClosed: true, at: 't' } });
  assert.deepEqual(locked, ['review:9:decisions:3']);
  assert.equal(reviews.prefix, 'review:');
});

// --- pure ---------------------------------------------------------------------------

test('the key says what a value holds; groups, grants, the index, locks, settings and other keys hold no account', () => {
  const { kindOf, idsIn } = personal;
  assert.equal(kindOf('scan:state'), 'scanState');
  assert.equal(kindOf('scan:1762000000000:users:0'), 'byAccount');
  assert.equal(kindOf('scan:1762000000000:active:63'), 'byAccount');
  assert.equal(kindOf('review:1762000000000:meta'), 'meta');
  assert.equal(kindOf('review:1762000000000:rows:12'), 'rows');
  assert.equal(kindOf('review:1762000000000:decisions:15'), 'decisions');
  for (const key of ['scan:state:lock', 'scan:1762000000000:groups:0', 'scan:1762000000000:grants:0', 'reviews:index', 'review:1762000000000:groups:0', 'review:1762000000000:decisions:3:lock', 'action:started', 'settings', 'pdr:state', 'pdr:ids:0', 'scan:states', 'review:1:rows:x', 'review:1:meta:x', undefined, null]) {
    assert.equal(kindOf(key), null, String(key));
  }
  assert.deepEqual(idsIn('review:1:groups:0', [{ id: 'g', name: 'site-admins', members: 2 }]), []);
});

test('each kind of value gives its account IDs; only closed ones are taken out; a value without one is left alone', () => {
  const { idsIn, scrubbed, scrubRows, scrubMeta, scrubDecisions, movedDecision, CLOSED_TEXT } = personal;
  const closed = new Set([ALICE, ADMIN]);

  // The scan state: who started it, and the account IDs an error text quotes.
  const state = { run: '1', status: 'failed', startedBy: ADMIN, error: `Jira rejected the query (400) — The value '${ADMIN}' does not exist. Also ${BOB} and ${ALICE}.`, pauseReason: null, products: [{ key: 'jira-software', name: 'Jira Software' }] };
  assert.deepEqual(idsIn('scan:state', state), [ADMIN, ADMIN, BOB, ALICE]);
  const next = scrubbed('scan:state', state, closed);
  assert.equal(next.startedBy, null);
  assert.equal(next.startedByClosed, true);
  assert.equal(next.error, `Jira rejected the query (400) — The value '${CLOSED_TEXT}' does not exist. Also ${BOB} and ${CLOSED_TEXT}.`);
  assert.equal(scrubbed('scan:state', { ...state, startedBy: BOB, error: 'Jira returned 503' }, closed), undefined);
  assert.deepEqual(scrubbed('scan:state', { startedBy: 'admin-1', error: 'no admin-1 here' }, new Set(['admin-1'])), { startedBy: null, error: `no ${CLOSED_TEXT} here`, startedByClosed: true });
  assert.deepEqual(idsIn('scan:state', { error: 'Field worklogAuthor does not exist; request 0123456789abcdef0123456789abcdef' }), [], 'words and other numbers are not accounts');

  // Working data by account.
  const users = { [ALICE]: { products: ['Jira Software'], groups: ['g-jsw'] }, [BOB]: { products: [], groups: ['g-x'] } };
  assert.deepEqual(idsIn('scan:1:users:3', users), [ALICE, BOB]);
  assert.deepEqual(scrubbed('scan:1:users:3', users, closed), { [BOB]: users[BOB] });
  assert.equal(scrubbed('scan:1:active:3', { [BOB]: 'verified', [CAROL]: '2026-11-01T00:00:00Z' }, closed), undefined);
  assert.deepEqual(scrubbed('scan:1:active:3', { [ALICE]: 'inactive:over-365|Over a year, or never|3' }, closed), {});

  // Review rows: a closed person keeps their row under the marker of its place; the flags the record listed move onto it.
  const rows = [{ accountId: BOB, products: [], groups: ['g-x'], admin: false, active: true }, { accountId: ALICE, products: ['Jira Software'], groups: ['g-jsw'], admin: true, active: false, bucket: 'over-365', label: 'Over a year, or never', severity: 3 }];
  assert.deepEqual(idsIn('review:1:rows:2', rows), [BOB, ALICE]);
  assert.deepEqual(scrubRows(rows, 2, closed), [rows[0], { ...rows[1], accountId: '~closed:2.1' }]);
  assert.deepEqual(scrubbed('review:1:rows:2', rows, closed), scrubRows(rows, 2, closed));
  const legacy = { added: [ALICE], removed: [], becameAdmin: [ALICE], gainedProducts: [{ accountId: ALICE, products: ['Jira Software'] }] };
  assert.deepEqual(scrubRows(rows, 0, closed, legacy)[1], { ...rows[1], accountId: '~closed:0.1', newSinceLast: true, becameAdmin: true, gainedProducts: ['Jira Software'] });
  assert.equal(scrubRows([rows[0]], 0, closed), undefined);
  assert.deepEqual(idsIn('review:1:rows:0', [{ accountId: '~closed:0.1' }, { accountId: BOB }]), [BOB], 'a marker is not an account');

  // Decisions: keys, who decided, and account IDs quoted in a note.
  const shard = { [ALICE]: { decision: 'remove', note: 'Left in May', by: BOB, at: 't1' }, [BOB]: { decision: 'keep', note: `Covers for ${ALICE}`, by: ADMIN, at: 't2' }, [CAROL]: { decision: 'keep', note: '', by: BOB, at: 't3' } };
  assert.deepEqual(idsIn('review:1:decisions:5', shard), [ALICE, BOB, CAROL, BOB, ADMIN, ALICE, BOB]);
  assert.deepEqual(scrubDecisions(shard, closed), { [BOB]: { decision: 'keep', note: `Covers for ${CLOSED_TEXT}`, by: null, at: 't2', byClosed: true }, [CAROL]: shard[CAROL] });
  assert.equal(scrubDecisions({ [CAROL]: shard[CAROL] }, closed), undefined);
  assert.deepEqual(movedDecision(shard[ALICE], closed), { decision: 'remove', note: '', by: BOB, at: 't1' });
  assert.deepEqual(movedDecision({ ...shard[ALICE], by: ADMIN }, closed), { decision: 'remove', note: '', by: null, at: 't1', byClosed: true });
  assert.deepEqual(idsIn('review:1:decisions:0', { '~closed:0.1': { decision: 'keep', note: '', by: null, byClosed: true } }), []);

  // The review record: who started, signed off and reopened, earlier sign-offs, and the lists of changes.
  const meta = {
    id: '1', status: 'complete', startedBy: ADMIN, completedBy: BOB, reopenedBy: ALICE, counts: { users: 4 }, stats: { total: 4, keep: 4 },
    signoffs: [{ completedAt: 'a', completedBy: ADMIN, stats: { total: 4 }, reopenedAt: 'b', reopenedBy: BOB }],
    changes: { counts: { added: 2, removed: 1, becameAdmin: 1, gainedProducts: 1 }, added: [ALICE, CAROL], removed: [ADMIN], becameAdmin: [CAROL], gainedProducts: [{ accountId: ALICE, products: ['Jira Software'] }] },
  };
  assert.deepEqual(idsIn('review:1:meta', meta), [ADMIN, BOB, ALICE, ADMIN, BOB, ALICE, CAROL, ADMIN, CAROL, ALICE]);
  assert.deepEqual(scrubMeta(meta, closed), {
    ...meta,
    startedBy: null,
    startedByClosed: true,
    reopenedBy: null,
    reopenedByClosed: true,
    signoffs: [{ ...meta.signoffs[0], completedBy: null, completedByClosed: true }],
    changes: { ...meta.changes, added: [CAROL], removed: [], gainedProducts: [] },
  });
  assert.equal(scrubMeta({ ...meta, startedBy: BOB, reopenedBy: BOB, signoffs: [], changes: null }, closed), undefined);
  assert.deepEqual(scrubbed('review:1:meta', meta, closed), scrubMeta(meta, closed));

  // Odd values never throw, and give nothing.
  for (const key of ['scan:state', 'scan:1:users:0', 'review:1:meta', 'review:1:rows:0', 'review:1:decisions:0']) {
    for (const value of [null, undefined, 'text', 7, [], {}, [null, 'x'], { x: null }]) {
      assert.ok(Array.isArray(idsIn(key, value)), key);
      assert.equal(scrubbed(key, value, closed), undefined, `${key} ${JSON.stringify(value)}`);
    }
  }
  assert.equal(scrubbed('review:1:rows:0', rows, new Set()), undefined, 'no closed accounts');
  assert.equal(scrubbed('settings', { x: ALICE }, closed), undefined);
});
