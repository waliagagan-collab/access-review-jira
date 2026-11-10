import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakes, fakeSite, call, drain, refuse } from './fakes.js';
import { handler as worker, NO_WORKLOG_WARNING } from '../src/worker.js';
import { handler as resolver } from '../src/index.js';
import { getScanState, setScanState, getReviewMeta, getReviewRows, getReviewGroups, getDecisions, listReviewIds } from '../src/lib/store.js';

const { data, pushed, hooks } = installFakes();
const reset = (site) => {
  data.clear();
  pushed.length = 0;
  hooks.beforeGet = null;
  hooks.beforeSet = null;
  hooks.failStorage = 0;
  hooks.failPush = null;
  hooks.calls.length = 0;
  hooks.jira = fakeSite(site);
};

const person = (accountId) => ({ accountId });
const recently = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

/** Six people: one seen by the sweep, one who only commented, one admin, one dormant, two more. */
const SITE = {
  roles: [{ key: 'jira-software', name: 'Jira Software', userCount: 4, groupDetails: [{ groupId: 'g-jsw', name: 'jira-software-users' }] }],
  groups: [
    { groupId: 'g-jsw', name: 'jira-software-users', members: ['admin-1', 'swept', 'commenter', 'dormant'] },
    { groupId: 'g-adm', name: 'JiraAdmins', members: ['admin-1'] },
    { groupId: 'g-conf', name: 'confluence-users', members: ['wiki-only'] },
    { groupId: 'g-empty', name: 'old-contractors', members: [] },
  ],
  swept: [{ fields: { created: recently, creator: person('swept'), reporter: person('swept') } }],
  // The per-user query finds the commenter only through updatedBy().
  active: (id, jql) => id === 'admin-1' || (id === 'commenter' && jql.includes('issue in updatedBy("commenter", "-90d")')),
};

const start = async () => {
  const res = await call(resolver, 'startReview', { days: 90 }, { accountId: 'admin-1' });
  assert.equal(res.ok, true);
  return res.state.run;
};
const scratch = () => [...data.keys()].filter((k) => k.startsWith('scan:') && k !== 'scan:state');
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.accountId, r]));

// --- a whole snapshot -----------------------------------------------------------------

test('a snapshot runs from roles to a published review and leaves no scratch data', async () => {
  reset(SITE);
  const run = await start();
  await drain(worker, pushed);

  const state = await getScanState();
  assert.equal(state.status, 'complete');
  assert.equal(state.reviewId, run);
  assert.deepEqual(scratch(), []);

  const meta = await getReviewMeta(run);
  const rows = byId(await getReviewRows(run));
  assert.deepEqual(Object.keys(rows).sort(), ['admin-1', 'commenter', 'dormant', 'swept', 'wiki-only']);
  assert.equal(rows.swept.active, true);
  assert.equal(rows.swept.lastActivityAt, recently);
  assert.equal(rows.commenter.active, true, 'someone who only commented is found by the per-user query');
  assert.equal(rows.dormant.active, false);
  assert.equal(rows.dormant.label, 'Over a year, or never');
  assert.equal(rows['admin-1'].admin, true, 'a camel-case admin group name is recognised');
  assert.deepEqual(rows['wiki-only'].products, []);
  assert.deepEqual(rows.swept.products, ['Jira Software']);
  assert.deepEqual(meta.counts, { users: 5, admins: 1, inactive: 2, unchecked: 0, noAccess: 1 });
  assert.deepEqual(meta.warnings, []);

  const groups = await getReviewGroups(meta);
  assert.equal(groups.find((g) => g.id === 'g-empty').empty, true);
  assert.deepEqual(groups.find((g) => g.id === 'g-jsw').products, ['Jira Software']);
});

test('the grants are not kept in the scan record', async () => {
  reset(SITE);
  await start();
  await worker({ body: pushed.shift() }); // roles
  const state = await getScanState();
  assert.equal(state.phase, 'groups');
  assert.equal(state.grants, undefined);
  assert.equal(state.grantPages, 1);
  assert.deepEqual(data.get(`scan:${state.run}:grants:0`), [['g-jsw', ['Jira Software']]]);
});

test('a run started by the previous version, with the grants in its record, still finishes', async () => {
  reset(SITE);
  const run = await start();
  pushed.length = 0;
  // Where the previous version stood after its roles slice.
  await setScanState({ ...(await getScanState()), phase: 'groups', seq: 1, products: [{ key: 'jira-software', name: 'Jira Software' }], grants: { 'g-jsw': ['Jira Software'] }, groupCursor: 0, groupPages: 0, groupCount: 0 });
  pushed.push({ run, seq: 1 });
  await drain(worker, pushed);
  assert.equal((await getScanState()).status, 'complete');
  assert.deepEqual(byId(await getReviewRows(run)).swept.products, ['Jira Software']);
});

// --- duplicate events -----------------------------------------------------------------

test('an event with an old sequence number is dropped', async () => {
  reset(SITE);
  const run = await start();
  const first = pushed.shift();
  await worker({ body: first });
  const after = await getScanState();
  hooks.calls.length = 0;
  await worker({ body: first }); // the same event again
  assert.equal(hooks.calls.length, 0, 'no Jira call is made');
  assert.deepEqual(await getScanState(), after);
  assert.deepEqual(pushed, [{ run, seq: 1 }]);
});

test('a slice that finds the sequence number moved on writes nothing and pushes nothing', async () => {
  reset(SITE);
  const run = await start();
  await worker({ body: pushed.shift() }); // roles
  await worker({ body: pushed.shift() }); // groups
  const membersEvent = pushed.shift();
  // While this copy is reading members, another copy of the same event commits.
  const site = hooks.jira;
  let moved = false;
  hooks.jira = async (path) => {
    if (path.startsWith('/rest/api/3/group/member') && !moved) {
      moved = true;
      const state = data.get('scan:state');
      data.set('scan:state', { ...state, seq: state.seq + 1, phase: 'issues', marker: 'other copy' });
    }
    return site(path);
  };
  const before = new Map(data);
  await worker({ body: membersEvent });
  assert.equal(moved, true);
  assert.deepEqual(pushed, [], 'nothing is pushed');
  assert.deepEqual([...data.keys()].sort(), [...before.keys()].sort(), 'no scratch key is added');
  assert.equal(data.get('scan:state').marker, 'other copy');
  assert.equal(data.get('scan:state').status, 'running');
  assert.equal(data.get(`scan:${run}:groups:0`)[0].members, 0, 'the group page is not rewritten');
});

test('a duplicate that fails does not fail the run another copy has moved on', async () => {
  reset(SITE);
  await start();
  await worker({ body: pushed.shift() }); // roles
  const groupsEvent = pushed.shift();
  hooks.jira = async () => {
    const state = data.get('scan:state');
    data.set('scan:state', { ...state, seq: state.seq + 1 });
    return refuse(403);
  };
  await worker({ body: groupsEvent });
  assert.equal(data.get('scan:state').status, 'running');
});

// --- a rejected activity query --------------------------------------------------------

test('a person whose query Jira rejects is "not checked": never active, never inactive, and counted', async () => {
  reset({ ...SITE, rejects: (id) => id === 'dormant' });
  const run = await start();
  await drain(worker, pushed);

  const meta = await getReviewMeta(run);
  const rows = byId(await getReviewRows(run));
  assert.equal(rows.dormant.unchecked, true);
  assert.equal(rows.dormant.active, false);
  assert.equal(rows.dormant.label, 'Not checked');
  assert.equal(meta.counts.unchecked, 1);
  assert.equal(meta.counts.inactive, 1, 'not counted as inactive either');
  assert.equal(meta.warnings.length, 1);
  assert.match(meta.warnings[0], /rejected the activity query for 1 user/);
  // The query was tried once more without the work-log clauses before giving up.
  const jqlOf = (path) => new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('jql') ?? '';
  const tries = hooks.calls.map(jqlOf).filter((jql) => jql.includes('CHANGED BY "dormant"')).map((jql) => jql.includes('worklogAuthor'));
  assert.deepEqual(tries, [true, false]);

  // "Keep all active non-admins" leaves the person out.
  await call(resolver, 'setDecisionsBulk', { reviewId: run, decision: 'keep' });
  assert.equal((await getDecisions(meta)).dormant, undefined);
});

test('when Jira will not search work logs, the whole run checks without them and says so', async () => {
  reset({ ...SITE, rejects: (id, jql) => jql.includes('worklogAuthor') });
  const run = await start();
  await drain(worker, pushed);

  const meta = await getReviewMeta(run);
  const rows = byId(await getReviewRows(run));
  assert.equal((await getScanState()).status, 'complete');
  assert.deepEqual(meta.warnings, [NO_WORKLOG_WARNING]);
  assert.equal(meta.counts.unchecked, 0);
  assert.equal(rows.commenter.active, true);
  assert.equal(rows.dormant.active, false);
  assert.equal(rows.dormant.unchecked, undefined);
});

test('when Jira rejects the query even without work logs, the snapshot fails with Jira\'s message and publishes nothing', async () => {
  reset({ ...SITE, rejects: () => true });
  const run = await start();
  await drain(worker, pushed);

  const state = await getScanState();
  assert.equal(state.status, 'failed');
  assert.match(state.error, /Jira rejected the query \(400\)/);
  assert.match(state.error, /worklogAuthor/);
  assert.equal(await getReviewMeta(run), undefined);
  assert.deepEqual(await listReviewIds(), []);
  assert.deepEqual(scratch(), []);
});

// --- the queue refuses a push ---------------------------------------------------------

test('when the next event cannot be queued the run is paused with everything kept, and the status call carries it on', async () => {
  reset(SITE);
  const run = await start();
  await worker({ body: pushed.shift() }); // roles
  const groupsEvent = pushed.shift();
  hooks.failPush = new Error('InvocationLimitReachedError');
  await worker({ body: groupsEvent });

  const paused = await getScanState();
  assert.equal(paused.status, 'running');
  assert.equal(paused.paused, true);
  assert.match(paused.pauseReason, /InvocationLimitReached/);
  assert.equal(paused.phase, 'members', 'the slice\'s work is committed');
  assert.equal(paused.seq, 2);
  assert.ok(data.has(`scan:${run}:groups:0`), 'nothing is deleted');
  assert.deepEqual(pushed, []);

  hooks.failPush = null;
  const status = await call(resolver, 'getStatus');
  assert.equal(status.state.paused, false);
  assert.deepEqual(pushed, [{ run, seq: 2 }]);
  await drain(worker, pushed);
  assert.equal((await getScanState()).status, 'complete');
  assert.equal((await getReviewRows(run)).length, 5);
});

// --- finalize --------------------------------------------------------------------------

test('finalize run a second time does not rebuild the review from deleted scratch data', async () => {
  reset(SITE);
  const run = await start();
  await drain(worker, pushed);
  const meta = await getReviewMeta(run);
  await call(resolver, 'setDecision', { reviewId: run, accountId: 'swept', decision: 'keep' });
  await call(resolver, 'completeReview', { reviewId: run });

  // The finalize event arrives again as if the first attempt had not finished.
  const state = await getScanState();
  await setScanState({ ...state, status: 'running', phase: 'finalize', reviewId: undefined });
  await worker({ body: { run, seq: state.seq } });

  assert.equal((await getScanState()).status, 'complete');
  const again = await getReviewMeta(run);
  assert.equal(again.status, 'complete', 'the sign-off is kept');
  assert.equal(again.rowCount, 5);
  assert.equal(again.generatedAt, meta.generatedAt);
  assert.equal((await getReviewRows(run)).length, 5);
  assert.equal((await getDecisions(again)).swept.decision, 'keep');
  assert.deepEqual(await listReviewIds(), [run]);
});

test('the scratch data is deleted only after the run is marked complete', async () => {
  reset(SITE);
  const run = await start();
  // Deliver everything up to finalize.
  while ((await getScanState()).phase !== 'finalize') await worker({ body: pushed.shift() });
  let scratchAtCommit = null;
  hooks.beforeSet = (key, value) => {
    if (key === 'scan:state' && value.status === 'complete') scratchAtCommit = scratch().length;
  };
  await worker({ body: pushed.shift() });
  assert.ok(scratchAtCommit > 0, 'still there when the run is marked complete');
  assert.deepEqual(scratch(), []);
  assert.equal((await getReviewRows(run)).length, 5);
});

// --- changes since the previous review ---------------------------------------------------

test('the next review flags a new account in an admin group as a new admin, and rows carry gained products', async () => {
  reset(SITE);
  const first = await start();
  await drain(worker, pushed);
  await call(resolver, 'completeReview', { reviewId: first });

  await new Promise((resolve) => setTimeout(resolve, 2)); // a later run id
  hooks.jira = fakeSite({
    ...SITE,
    groups: [
      { groupId: 'g-jsw', name: 'jira-software-users', members: ['admin-1', 'swept', 'commenter', 'wiki-only'] },
      { groupId: 'g-adm', name: 'JiraAdmins', members: ['admin-1', 'new-admin', 'commenter'] },
      { groupId: 'g-conf', name: 'confluence-users', members: ['wiki-only'] },
    ],
  });
  const second = await start();
  await drain(worker, pushed);

  const meta = await getReviewMeta(second);
  const rows = byId(await getReviewRows(second));
  assert.deepEqual(meta.changes.counts, { added: 1, removed: 1, becameAdmin: 2, gainedProducts: 1 });
  assert.equal(rows['new-admin'].newSinceLast, true);
  assert.equal(rows['new-admin'].becameAdmin, true);
  assert.equal(rows.commenter.becameAdmin, true);
  assert.equal(rows['admin-1'].becameAdmin, undefined);
  assert.deepEqual(rows['wiki-only'].gainedProducts, ['Jira Software']);
  assert.deepEqual(meta.changes.removed, ['dormant']);

  const read = await call(resolver, 'getReview', { reviewId: second });
  assert.deepEqual(read.review.gone, [{ accountId: 'dormant', displayName: 'Name of dormant', email: 'dormant@example.com' }]);
});

// --- rate limits and deleted groups (behaviour kept) ---------------------------------------

test('a rate limit mid-slice keeps the cursor and asks for a retry of the same event', async () => {
  reset(SITE);
  const run = await start();
  await worker({ body: pushed.shift() }); // roles
  await worker({ body: pushed.shift() }); // groups
  const membersEvent = pushed.shift();
  const site = hooks.jira;
  let limited = false;
  hooks.jira = async (path) => {
    if (path.includes('groupId=g-adm') && !limited) {
      limited = true;
      return refuse(429, {}, { 'Retry-After': '7' });
    }
    return site(path);
  };
  const res = await worker({ body: membersEvent });
  assert.equal(res.retryOptions.retryAfter, 7);
  const state = await getScanState();
  assert.equal(state.phase, 'members');
  assert.equal(state.seq, 2, 'the same event is accepted again');
  assert.equal(state.memberCursor.index, 1, 'the first group is done');
  assert.deepEqual(pushed, []);

  await worker({ body: membersEvent });
  await drain(worker, pushed);
  assert.equal((await getReviewRows(run)).length, 5);
});

test('a group deleted while the snapshot runs counts as empty', async () => {
  reset(SITE);
  const run = await start();
  await worker({ body: pushed.shift() });
  await worker({ body: pushed.shift() });
  const site = hooks.jira;
  hooks.jira = async (path) => (path.includes('groupId=g-conf') ? refuse(404) : site(path));
  await drain(worker, pushed);
  const rows = byId(await getReviewRows(run));
  assert.equal(rows['wiki-only'], undefined);
  assert.equal((await getReviewGroups(await getReviewMeta(run))).find((g) => g.id === 'g-conf').empty, true);
});
