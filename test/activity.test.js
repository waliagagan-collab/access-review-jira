import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceIssues,
  windowStart,
  filterLicensedUsers,
  normaliseRoles,
  searchParams,
  buildSweepJql,
  buildUserActivityJql,
  classifyDormancy,
} from '../src/lib/jira.js';
import { shardOf, SHARDS, mergeActive, chunk, decisionShardsOf } from '../src/lib/store.js';
import { isStale, normaliseDays, licenseGate, licenseMessage } from '../src/lib/scan.js';

const person = (id) => ({ accountId: id, displayName: id });

// --- the activity rules: the product's central claim --------------------------

test('a commenter is active — the case that breaks trust if wrong', () => {
  const activity = reduceIssues([
    {
      fields: {
        created: '2026-09-01T10:00:00.000+0000',
        creator: person('alice'),
        reporter: person('alice'),
        comment: { comments: [{ author: person('bob'), created: '2026-09-02T09:00:00.000+0000' }] },
      },
    },
  ]);
  assert.ok(activity.bob, 'bob commented and must not be dormant');
  assert.equal(activity.bob.via, 'commented');
});

test('a field-changer and a work-logger are active', () => {
  const activity = reduceIssues([
    {
      changelog: { histories: [{ author: person('carol'), created: '2026-09-03T08:00:00.000+0000' }] },
      fields: {
        worklog: { worklogs: [{ author: person('dave'), started: '2026-09-03T07:00:00.000+0000' }] },
      },
    },
  ]);
  assert.equal(activity.carol.via, 'edited an issue');
  assert.equal(activity.dave.via, 'logged work');
});

test('being the assignee is NOT activity — a departed assignee on a live ticket must be flagged', () => {
  const activity = reduceIssues([
    {
      fields: {
        created: '2024-01-01T00:00:00.000+0000',
        updated: '2026-09-10T00:00:00.000+0000',
        assignee: person('gone'),
        creator: person('alice'),
        reporter: person('alice'),
      },
    },
  ]);
  assert.equal(activity.gone, undefined);
});

test('creator and reporter are stamped at created, never at updated', () => {
  const activity = reduceIssues([
    {
      fields: {
        created: '2024-01-01T00:00:00.000+0000',
        updated: '2026-09-10T00:00:00.000+0000',
        creator: person('old'),
        reporter: person('old'),
      },
    },
  ]);
  assert.equal(activity.old.at, '2024-01-01T00:00:00.000+0000');
});

test('keeps the latest timestamp across mixed UTC offsets', () => {
  // 09:00+0530 is 03:30Z — EARLIER than 05:00Z, but sorts LATER as a string.
  const activity = reduceIssues([
    {
      fields: {
        comment: {
          comments: [
            { author: person('eve'), created: '2026-09-04T05:00:00.000+0000' },
            { author: person('eve'), created: '2026-09-04T09:00:00.000+0530' },
          ],
        },
      },
    },
  ]);
  assert.equal(activity.eve.at, '2026-09-04T05:00:00.000+0000');
});

test('an old comment on a recently updated issue does NOT make the commenter active', () => {
  // The sweep returns whole histories and comment lists. Only actions inside
  // the window count, or a departed colleague is hidden by others' edits.
  const since = windowStart(90, Date.parse('2026-09-20T00:00:00Z'));
  const activity = reduceIssues(
    [
      {
        changelog: { histories: [{ author: person('leaver'), created: '2024-05-01T08:00:00.000+0000' }] },
        fields: {
          created: '2024-01-01T00:00:00.000+0000',
          updated: '2026-09-19T00:00:00.000+0000',
          creator: person('leaver'),
          reporter: person('leaver'),
          comment: {
            comments: [
              { author: person('leaver'), created: '2024-06-01T09:00:00.000+0000' },
              { author: person('stayer'), created: '2026-09-19T09:00:00.000+0000' },
            ],
          },
          worklog: { worklogs: [{ author: person('leaver'), started: '2024-02-01T07:00:00.000+0000' }] },
        },
      },
    ],
    since
  );
  assert.equal(activity.leaver, undefined, 'every action by leaver is outside the window');
  assert.equal(activity.stayer.via, 'commented');
});

test('without a window, every recorded action counts (pure reducer default)', () => {
  const activity = reduceIssues([
    { fields: { created: '2020-01-01T00:00:00.000+0000', creator: person('ancient') } },
  ]);
  assert.ok(activity.ancient);
});

test('survives empty, missing and malformed pages', () => {
  assert.deepEqual(reduceIssues([]), {});
  assert.deepEqual(reduceIssues(undefined), {});
  assert.deepEqual(reduceIssues([{}]), {});
  assert.deepEqual(reduceIssues([null]), {});
  assert.deepEqual(reduceIssues([{ fields: { comment: { comments: [null] } } }]), {});
});

test('never leaks the internal comparison field', () => {
  const activity = reduceIssues([
    { fields: { created: '2026-09-01T10:00:00.000+0000', creator: person('gina') } },
  ]);
  assert.deepEqual(Object.keys(activity.gina).sort(), ['at', 'via']);
});

// --- who holds a seat ---------------------------------------------------------

test('excludes bots and JSM portal customers from the seat count', () => {
  const users = filterLicensedUsers([
    { accountId: 'a1', accountType: 'atlassian', active: true, displayName: 'Human' },
    { accountId: 'b1', accountType: 'app', active: true, displayName: 'Automation Bot' },
    { accountId: 'c1', accountType: 'customer', active: true, displayName: 'Portal User' },
    { accountId: 'd1', accountType: 'atlassian', active: false, displayName: 'Deactivated' },
  ]);
  assert.deepEqual(users.map((u) => u.accountId), ['a1']);
});

test('user filter tolerates a non-array response', () => {
  assert.deepEqual(filterLicensedUsers(null), []);
  assert.deepEqual(filterLicensedUsers({ errorMessages: ['nope'] }), []);
});

test('application roles keep only defined roles with licensing groups', () => {
  const roles = normaliseRoles([
    {
      key: 'jira-software',
      name: 'Jira Software',
      userCount: 412,
      numberOfSeats: 500,
      groupDetails: [{ groupId: 'g1', name: 'jira-software-users' }, { name: 'no-id' }],
    },
    { key: 'jira-core', name: 'Jira Core', defined: false, groupDetails: [{ groupId: 'g2' }] },
    { key: 'empty', name: 'No groups', groupDetails: [] },
  ]);
  assert.equal(roles.length, 1);
  assert.equal(roles[0].groups.length, 1);
  assert.equal(roles[0].userCount, 412);
});

// --- the wire format: route() encodes values itself, so never pre-encode --------

test('searchParams passes raw JQL and drops empty values', () => {
  const p = searchParams({ jql: 'updated >= -90d', maxResults: 50, nextPageToken: null, x: '' });
  assert.equal(p.get('jql'), 'updated >= -90d', 'must not be pre-encoded');
  assert.equal(p.has('nextPageToken'), false);
  assert.equal(p.has('x'), false);
  assert.equal(p.get('maxResults'), '50');
});

test('sweep JQL is bounded to the window', () => {
  assert.equal(buildSweepJql(90), 'updated >= -90d ORDER BY updated DESC');
  assert.equal(buildSweepJql('30'), 'updated >= -30d ORDER BY updated DESC');
});

test('per-user JQL quotes the account id and only lists things the user DID', () => {
  const jql = buildUserActivityJql('557058:abc-def', 90);
  assert.ok(jql.includes('"557058:abc-def"'), 'account ids contain a colon and must be quoted');
  assert.ok(jql.includes('status CHANGED BY'));
  for (const f of ['assignee', 'priority', 'resolution', 'fixVersion', 'reporter']) {
    assert.ok(jql.includes(`${f} CHANGED BY`), `${f} CHANGED BY must be in the verify query`);
  }
  assert.ok(jql.includes('worklogAuthor ='));
  assert.ok(jql.includes('creator ='));
  assert.ok(jql.includes('worklogAuthor ='));
  assert.ok(jql.includes('creator ='));
  assert.ok(!/assignee = /.test(jql), 'assignee equality is not a signal');
  assert.ok(jql.includes('startOfDay(-90d)'));
});

// --- dormancy bands -----------------------------------------------------------

test('the band starts at the last probe that found nothing, and longer bands sort higher', () => {
  assert.deepEqual(classifyDormancy(90, { 180: true }), {
    bucket: '90-180',
    label: '90–180 days',
    severity: 1,
  });
  // Inactive in 90 and in 180 but active within 365: that is 180–365, not 90–365.
  assert.deepEqual(classifyDormancy(90, { 180: false, 365: true }), {
    bucket: '180-365',
    label: '180–365 days',
    severity: 2,
  });
  assert.deepEqual(classifyDormancy(90, { 180: false, 365: false }), {
    bucket: 'over-365',
    label: 'Over a year, or never',
    severity: 3,
  });
  assert.deepEqual(classifyDormancy(180, { 365: true }), { bucket: '180-365', label: '180–365 days', severity: 1 });
  assert.deepEqual(classifyDormancy(180, { 365: false }).bucket, 'over-365');
});

test('a 365-day window has no wider probe and goes straight to the top band', () => {
  assert.equal(classifyDormancy(365, {}).bucket, 'over-365');
});

test('seat filter keeps only the account id — no names or emails reach storage', () => {
  const users = filterLicensedUsers([
    { accountId: 'a1', accountType: 'atlassian', active: true, displayName: 'Human', emailAddress: 'h@x.io' },
  ]);
  assert.deepEqual(users, [{ accountId: 'a1' }]);
});

// --- storage ------------------------------------------------------------------

test('sharding is deterministic, in range, and spreads accounts', () => {
  const counts = new Array(SHARDS).fill(0);
  for (let i = 0; i < 2000; i++) {
    const id = `712020:${i}-abcdef`;
    const s = shardOf(id);
    assert.ok(Number.isInteger(s) && s >= 0 && s < SHARDS);
    assert.equal(s, shardOf(id));
    counts[s]++;
  }
  assert.ok(Math.max(...counts) < 2000 * 0.35, 'badly skewed');
  assert.ok(Math.min(...counts) > 0, 'a shard is never used');
});

test('stored values are split into pages, and old reviews keep their 16 decision shards', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.deepEqual(chunk(undefined, 2), []);
  assert.equal(decisionShardsOf({}), 16);
  assert.equal(decisionShardsOf(null), 16);
  assert.equal(decisionShardsOf({ decisionShards: 64 }), 64);
  assert.equal(shardOf('712020:abc', 16) < 16, true);
});

// --- stuck-scan detection -----------------------------------------------------

test('a running scan with no cursor movement for 20 minutes is stale', () => {
  const t = Date.parse('2026-09-21T12:00:00Z');
  const fresh = { status: 'running', updatedAt: '2026-09-21T11:50:00Z' };
  const stuck = { status: 'running', updatedAt: '2026-09-21T11:30:00Z' };
  const done = { status: 'complete', updatedAt: '2026-09-21T10:00:00Z' };
  assert.equal(isStale(fresh, t), false);
  assert.equal(isStale(stuck, t), true);
  assert.equal(isStale(done, t), false);
  assert.equal(isStale(null, t), false);
});

// --- paid-app licence gate ----------------------------------------------------

test('production requires an active licence; a missing licence is a refusal', () => {
  assert.equal(licenseGate({ active: true }, 'PRODUCTION').allowed, true);
  assert.equal(licenseGate({ active: true, isEvaluation: true }, 'PRODUCTION').reason, 'trial');
  assert.equal(licenseGate({ active: false }, 'PRODUCTION').allowed, false);
  assert.equal(licenseGate(undefined, 'PRODUCTION').allowed, false);
  assert.equal(licenseGate(null, 'production').reason, 'missing');
});

test('development and staging are never locked out by an absent licence', () => {
  assert.equal(licenseGate(undefined, 'DEVELOPMENT').allowed, true);
  assert.equal(licenseGate(undefined, 'STAGING').allowed, true);
  assert.equal(licenseGate(undefined, undefined).allowed, true);
  assert.equal(licenseGate({ active: true }, 'DEVELOPMENT').allowed, true);
});

test('a simulated inactive licence blocks a test site, so the gate itself can be tested', () => {
  const gate = licenseGate({ active: false }, 'DEVELOPMENT');
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'simulated-inactive');
});

test('the refusal message distinguishes an expired trial from never subscribing', () => {
  assert.equal(licenseMessage({ allowed: true }, {}), null);
  assert.match(
    licenseMessage({ allowed: false, reason: 'inactive' }, { trialEndDate: '2020-01-01T00:00:00Z' }),
    /trial .* has ended/
  );
  assert.match(licenseMessage({ allowed: false, reason: 'missing' }, null), /free 30-day trial/);
});

test('the audit window only accepts the offered values', () => {
  assert.equal(normaliseDays(30), 30);
  assert.equal(normaliseDays('180'), 180);
  assert.equal(normaliseDays(7), 90, 'unknown values fall back to the default');
  assert.equal(normaliseDays(undefined), 90);
  assert.equal(normaliseDays('DROP TABLE'), 90);
});

test('a replayed slice keeps the latest activity timestamp per account', () => {
  const merged = mergeActive({ a: '2026-09-01T00:00:00Z', c: 'verified' }, { a: '2026-09-20T00:00:00Z', b: '2026-08-01T00:00:00Z' });
  assert.equal(merged.a, '2026-09-20T00:00:00Z');
  assert.equal(merged.b, '2026-08-01T00:00:00Z');
  assert.equal(merged.c, 'verified');
  assert.deepEqual(mergeActive(undefined, {}), {});
});
