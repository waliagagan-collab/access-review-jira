import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import {
  isAdminGroupName,
  normaliseDecision,
  normaliseNote,
  buildRow,
  sortRows,
  groupSummary,
  diffReviews,
  decisionStats,
  filterReviewRows,
  quarterName,
  flagChanges,
  signoffHistory,
  withSignoffs,
  isActiveNonAdmin,
  MAX_NOTE,
  closedMarker,
  isClosedAccount,
  whoName,
} from '../src/lib/review.js';
import { activityOf } from '../src/worker.js';
import { sheetsOf, fileStamp } from '../src/frame/evidence.js';
import { buildXlsx } from '../src/frame/xlsx.js';

const GROUPS = {
  'g-jsw': { name: 'jira-software-users-site', products: ['Jira Software'], admin: false, members: 3 },
  'g-jsm': { name: 'jira-servicemanagement-users-site', products: ['Jira Service Management'], admin: false, members: 2 },
  'g-org': { name: 'org-admins', products: ['Jira Software', 'Jira Service Management'], admin: true, members: 1 },
  'g-team': { name: 'design-team', products: [], admin: false, members: 2 },
  'g-empty': { name: 'old-contractors', products: [], admin: false, members: 0 },
};

test('rows carry products from groups, the admin flag, and the activity facts', () => {
  const r = buildRow('u1', { groups: ['g-jsw', 'g-team', 'gone', 'g-jsw'] }, GROUPS, { active: true, at: '2026-10-01T00:00:00Z' });
  assert.deepEqual(r.groups, ['g-jsw', 'g-team']);
  assert.deepEqual(r.products, ['Jira Software']);
  assert.equal(r.admin, false);
  assert.equal(r.active, true);
  assert.equal(r.lastActivityAt, '2026-10-01T00:00:00Z');
  const a = buildRow('u2', { groups: ['g-org'] }, GROUPS, { active: false, bucket: 'over-365', label: 'Over a year, or never', severity: 2 });
  assert.equal(a.admin, true);
  assert.deepEqual(a.products, ['Jira Service Management', 'Jira Software']);
  assert.equal(a.label, 'Over a year, or never');
  assert.equal(buildRow('u3', { groups: ['g-team'] }, GROUPS, { active: false }).products.length, 0);
});

test('the active map encodes sweep dates, verified-active and inactive bands', () => {
  assert.deepEqual(activityOf(undefined), { active: false });
  assert.deepEqual(activityOf('verified'), { active: true });
  assert.deepEqual(activityOf('2026-10-01T00:00:00Z'), { active: true, at: '2026-10-01T00:00:00Z' });
  assert.deepEqual(activityOf('inactive:180-365|180–365 days|1'), { active: false, bucket: '180-365', label: '180–365 days', severity: 1 });
});

test('rows sort admins first, then longest inactive, then by id', () => {
  const rows = sortRows([
    { accountId: 'b', admin: false, severity: 2 },
    { accountId: 'a', admin: false, severity: 2 },
    { accountId: 'c', admin: true, severity: 0 },
    { accountId: 'd', admin: false, severity: 0 },
  ]);
  assert.deepEqual(rows.map((r) => r.accountId), ['c', 'a', 'b', 'd']);
});

test('group summary counts members in the review and flags empty and admin groups', () => {
  const rows = [
    { accountId: 'u1', groups: ['g-jsw', 'g-team'] },
    { accountId: 'u2', groups: ['g-org', 'g-jsw'] },
  ];
  const g = groupSummary(GROUPS, rows);
  assert.equal(g[0].name, 'org-admins'); // admin groups first
  const jsw = g.find((x) => x.id === 'g-jsw');
  assert.equal(jsw.licensedMembers, 2);
  assert.equal(jsw.members, 3);
  assert.equal(g.find((x) => x.id === 'g-empty').empty, true);
});

test('admin groups are recognised by a word that is or ends with an admin word, not by any name containing "admin"', () => {
  for (const name of ['jira-admins-acme', 'site-admins', 'org-admins', 'administrators', 'jira-administrators', 'sysadmin', 'Admin', 'ADMIN-team', 'confluence_admin']) {
    assert.equal(isAdminGroupName(name), true, name);
  }
  // Written without a separator, or in camel case.
  for (const name of ['JiraAdmins', 'siteadmins', 'itadmin', 'ITADMINS', 'JiraAdministrators', 'jiraAdmin2', 'sysadmins', 'Jira-Administratoren', 'platformSysadmins']) {
    assert.equal(isAdminGroupName(name), true, name);
  }
  for (const name of ['badminton-club', 'Badminton', 'administrative-assistants', 'AdministrativeStaff', 'adminton', 'administration', 'design-team', '', null]) {
    assert.equal(isAdminGroupName(name), false, String(name));
  }
});

test('rows carry their own new and became-admin flags, with no cap', () => {
  const previous = [
    { accountId: 'stays', admin: false },
    { accountId: 'promoted', admin: false },
  ];
  const current = [
    { accountId: 'stays', admin: false },
    { accountId: 'promoted', admin: true },
    { accountId: 'joined', admin: false },
  ];
  const flagged = flagChanges(current, previous);
  assert.equal(flagged[0].newSinceLast, undefined);
  assert.equal(flagged[0].becameAdmin, undefined);
  assert.equal(flagged[1].becameAdmin, true);
  assert.equal(flagged[2].newSinceLast, true);
  assert.deepEqual(flagChanges(current, undefined).map((r) => r.newSinceLast), [true, true, true]);
});

test('a new account that sits in an admin group is a new admin too', () => {
  const previous = [{ accountId: 'stays', admin: true, products: ['Jira Software'] }];
  const current = [
    { accountId: 'stays', admin: true, products: ['Jira Software', 'Jira Service Management'] },
    { accountId: 'new-admin', admin: true, products: [] },
    { accountId: 'new-user', admin: false, products: [] },
  ];
  const flagged = flagChanges(current, previous);
  assert.equal(flagged[0].becameAdmin, undefined, 'was an admin before');
  assert.deepEqual(flagged[0].gainedProducts, ['Jira Service Management']);
  assert.equal(flagged[1].newSinceLast, true);
  assert.equal(flagged[1].becameAdmin, true);
  assert.equal(flagged[2].becameAdmin, undefined);
  assert.equal(flagged[2].gainedProducts, undefined);
  const d = diffReviews(current, previous);
  assert.deepEqual(d.added, ['new-admin', 'new-user']);
  assert.deepEqual(d.becameAdmin, ['new-admin']);
  assert.deepEqual(d.counts, { added: 2, removed: 0, becameAdmin: 1, gainedProducts: 1 });
});

test('a person Jira would not answer for is neither active nor inactive, and is never bulk-kept', () => {
  assert.deepEqual(activityOf('unchecked'), { active: false, unchecked: true });
  const r = buildRow('u1', { groups: ['g-jsw'] }, GROUPS, activityOf('unchecked'));
  assert.equal(r.active, false);
  assert.equal(r.unchecked, true);
  assert.equal(r.label, 'Not checked');
  const rows = [
    { accountId: 'a', active: true, admin: false },
    { accountId: 'b', active: false, admin: false },
    { accountId: 'c', active: false, admin: false, unchecked: true },
    { accountId: 'd', active: true, admin: true },
  ];
  const ids = (f) => filterReviewRows(rows, f).map((x) => x.accountId);
  assert.deepEqual(ids({ activity: 'active' }), ['a', 'd']);
  assert.deepEqual(ids({ activity: 'inactive' }), ['b']);
  assert.deepEqual(ids({ activity: 'unchecked' }), ['c']);
  assert.deepEqual(rows.filter(isActiveNonAdmin).map((x) => x.accountId), ['a']);
});

test('the sign-off history reads both stored shapes', () => {
  const stats = { total: 2, keep: 2, remove: 0, flag: 0, undecided: 0 };
  // Signed off, never reopened.
  const signed = { status: 'complete', completedAt: '2026-10-01T01:00:00Z', completedBy: 'a', stats };
  assert.deepEqual(signoffHistory(signed), []);
  assert.equal(withSignoffs(signed).completedAt, '2026-10-01T01:00:00Z');
  // Reopened by the previous version: the sign-off is still in the live fields.
  const legacy = { ...signed, status: 'open', reopenedAt: '2026-10-20T09:00:00Z', reopenedBy: 'b' };
  assert.deepEqual(signoffHistory(legacy), [{ completedAt: '2026-10-01T01:00:00Z', completedBy: 'a', stats, reopenedAt: '2026-10-20T09:00:00Z', reopenedBy: 'b' }]);
  const seen = withSignoffs(legacy);
  assert.equal(seen.completedAt, null);
  assert.equal(seen.completedBy, null);
  assert.equal(seen.stats, null);
  assert.equal(seen.signoffs.length, 1);
  // Reopened by this version: the history is stored.
  const current = { status: 'open', completedAt: null, signoffs: [{ completedAt: 'x', completedBy: 'a', stats, reopenedAt: 'y', reopenedBy: 'b' }] };
  assert.equal(signoffHistory(current), current.signoffs);
  // Never signed off.
  assert.deepEqual(signoffHistory({ status: 'open' }), []);
  assert.deepEqual(withSignoffs({ status: 'open' }).signoffs, []);
});

test('the diff names who was added, who left, who became an admin and who gained products', () => {
  const previous = [
    { accountId: 'stays', admin: false, products: ['Jira Software'] },
    { accountId: 'left', admin: false, products: ['Jira Software'] },
    { accountId: 'promoted', admin: false, products: ['Jira Software'] },
  ];
  const current = [
    { accountId: 'stays', admin: false, products: ['Jira Software', 'Jira Service Management'] },
    { accountId: 'promoted', admin: true, products: ['Jira Software'] },
    { accountId: 'joined', admin: false, products: ['Jira Software'] },
  ];
  const d = diffReviews(current, previous);
  assert.deepEqual(d.added, ['joined']);
  assert.deepEqual(d.removed, ['left']);
  assert.deepEqual(d.becameAdmin, ['promoted']);
  assert.deepEqual(d.gainedProducts, [{ accountId: 'stays', products: ['Jira Service Management'] }]);
  assert.deepEqual(d.counts, { added: 1, removed: 1, becameAdmin: 1, gainedProducts: 1 });
});

test('decision stats and filters agree on what counts as undecided', () => {
  const rows = [
    { accountId: 'a', displayName: 'Ann', active: true, admin: true, products: ['Jira Software'], groups: ['g-org'], decision: 'keep' },
    { accountId: 'b', displayName: 'Bo', active: false, admin: false, products: [], groups: ['g-team'], decision: null, newSinceLast: true },
    { accountId: 'c', displayName: 'Cy', email: 'cy@x.com', active: true, admin: false, products: ['Jira Software'], groups: ['g-jsw'], decision: 'remove' },
  ];
  const stats = decisionStats(rows, { a: { decision: 'keep' }, c: { decision: 'remove' } });
  assert.deepEqual(stats, { total: 3, keep: 1, remove: 1, flag: 0, undecided: 1 });
  const ids = (f) => filterReviewRows(rows, f).map((r) => r.accountId);
  assert.deepEqual(ids({ decision: 'undecided' }), ['b']);
  assert.deepEqual(ids({ adminOnly: true }), ['a']);
  assert.deepEqual(ids({ activity: 'inactive' }), ['b']);
  assert.deepEqual(ids({ product: 'none' }), ['b']);
  assert.deepEqual(ids({ product: 'Jira Software' }), ['a', 'c']);
  assert.deepEqual(ids({ group: 'g-jsw' }), ['c']);
  assert.deepEqual(ids({ newOnly: true }), ['b']);
  assert.deepEqual(ids({ query: 'CY@' }), ['c']);
  assert.deepEqual(ids({}), ['a', 'b', 'c']);
});

test('decisions and notes from the page are normalised, never trusted', () => {
  assert.equal(normaliseDecision('keep'), 'keep');
  assert.equal(normaliseDecision('DROP'), null);
  assert.equal(normaliseDecision(undefined), null);
  assert.equal(normaliseNote('  hi  '), 'hi');
  assert.equal(normaliseNote('x'.repeat(MAX_NOTE + 50)).length, MAX_NOTE);
});

test('quarter names', () => {
  assert.equal(quarterName('2026-10-13T00:00:00Z'), 'Q4 2026');
  assert.equal(quarterName('2026-02-01T00:00:00Z'), 'Q1 2026');
  assert.equal(quarterName('not a date'), '');
});

test('the evidence workbook has summary, users, groups and changes sheets and no live formulas', () => {
  const review = {
    startedAt: '2026-10-13T01:00:00Z', generatedAt: '2026-10-13T01:05:00Z', status: 'complete', completedAt: '2026-10-13T02:00:00Z',
    startedByName: 'Gagan', completedByName: 'Gagan', days: 90, counts: { users: 2, admins: 1, inactive: 1, noAccess: 0 },
    products: [{ name: 'Jira Software', userCount: 2 }], groups: [{ name: 'org-admins', products: ['Jira Software'], admin: true, members: 1, licensedMembers: 1, empty: false }],
    changes: { counts: { added: 1, removed: 0, becameAdmin: 0, gainedProducts: 0 } }, warnings: [],
  };
  const rows = [
    { accountId: 'a', displayName: '=HYPERLINK("x")', email: null, products: ['Jira Software'], groupNames: ['org-admins'], admin: true, active: true, lastActivityAt: '2026-10-01T00:00:00Z', decision: 'keep', note: '', decidedByName: 'Gagan', decidedAt: '2026-10-13T01:30:00Z', newSinceLast: false },
    { accountId: 'b', displayName: 'Bo', email: 'bo@x.com', products: [], groupNames: [], admin: false, active: false, label: 'Over a year, or never', decision: null, note: 'Left in May', newSinceLast: true },
  ];
  const sheets = sheetsOf(review, rows, { keep: 1, remove: 0, flag: 0, undecided: 1 });
  assert.deepEqual(sheets.map((s) => s.name), ['Summary', 'Users', 'Groups', 'Changes']);
  assert.equal(sheets[1].table[1][7], 'Keep');
  assert.equal(sheets[1].table[2][7], 'Undecided');
  const files = unzipSync(buildXlsx(sheets));
  const names = Object.keys(files);
  assert.ok(names.includes('xl/worksheets/sheet4.xml'));
  const workbook = strFromU8(files['xl/workbook.xml']);
  assert.match(workbook, /name="Users"/);
  assert.match(workbook, /name="Changes"/);
  const users = strFromU8(files['xl/worksheets/sheet2.xml']);
  assert.ok(users.includes('t="inlineStr"'), 'values are text, never formulas');
  assert.ok(!/<f>/.test(users));
});

const cell = (table, label) => table.find((r) => r[0] === label)?.[1];

test('the workbook says "Jira products", and counts people who were not checked', () => {
  const review = { status: 'open', startedAt: '2026-10-13T01:00:00Z', generatedAt: '2026-10-13T01:05:00Z', counts: { users: 2, admins: 0, inactive: 0, unchecked: 1, noAccess: 1 }, products: [{ name: 'Jira Software', userCount: 1 }], groups: [], warnings: ['w1'] };
  const rows = [
    { accountId: 'a', displayName: 'Ann', products: [], groupNames: ['confluence-users'], active: false, unchecked: true, label: 'Not checked' },
    { accountId: 'b', displayName: 'Bo', products: ['Jira Software'], groupNames: [], active: true },
  ];
  const [summary, users, groups] = sheetsOf(review, rows, {}).map((s) => s.table);
  assert.equal(cell(summary, 'Users with no Jira product access'), 1);
  assert.equal(cell(summary, 'Users whose activity was not checked'), 1);
  assert.equal(cell(summary, 'Jira products (seats Atlassian counts)'), 'Jira Software: 1');
  assert.equal(cell(summary, 'Users with no product access'), undefined);
  assert.equal(users[0][3], 'Jira products');
  assert.equal(users[1][6], 'Not checked');
  assert.equal(users[2][6], 'Active in the window');
  assert.equal(groups[0][1], 'Grants (Jira products)');
  // A review saved before the count existed shows 0.
  assert.equal(cell(sheetsOf({ ...review, counts: { users: 2 } }, rows, {})[0].table, 'Users whose activity was not checked'), 0);
});

test('"last seen" in the workbook is the UTC day, the same day the page shows', () => {
  const review = { status: 'open', startedAt: '2026-09-05T00:00:00Z', generatedAt: '2026-09-05T00:10:00Z', groups: [] };
  // 03:00 at +05:30 is 21:30 UTC the day before.
  const rows = [{ accountId: 'a', displayName: 'Ann', active: true, lastActivityAt: '2026-09-04T03:00:00.000+0530' }];
  assert.equal(sheetsOf(review, rows, {})[1].table[1][6], 'Active (last seen 2026-09-03)');
  assert.equal(fileStamp('2026-10-13T02:40:59.000Z'), '2026-10-13-0240');
  assert.equal(fileStamp(undefined), '');
});

test('an open review prints no sign-off, and earlier sign-offs are listed with who reopened them', () => {
  const stats = { total: 3, keep: 2, remove: 1, flag: 0, undecided: 0 };
  const base = { startedAt: '2026-10-01T00:00:00Z', generatedAt: '2026-10-01T00:05:00Z', groups: [] };
  const history = [{ completedAt: '2026-10-01T01:00:00.000Z', completedByName: 'Ann', stats, reopenedAt: '2026-12-20T10:00:00.000Z', reopenedByName: 'Bo' }];

  // Reopened and not signed again. Even with stale live fields, as the previous version stored them.
  const open = sheetsOf({ ...base, status: 'open', completedAt: '2026-10-01T01:00:00.000Z', completedByName: 'Ann', signoffs: history }, [], {})[0].table;
  assert.equal(cell(open, 'Status'), 'Open');
  assert.equal(cell(open, 'Signed off at'), '');
  assert.equal(cell(open, 'Signed off by'), '');
  assert.equal(cell(open, 'Earlier sign-off 1'), 'Signed off 2026-10-01 01:00 UTC by Ann (2 keep, 1 remove, 0 follow up, 0 undecided). Reopened 2026-12-20 10:00 UTC by Bo.');

  // Signed off again by Bo: the new sign-off and the earlier one are both there.
  const resigned = sheetsOf({ ...base, status: 'complete', completedAt: '2026-12-20T11:00:00.000Z', completedByName: 'Bo', signoffs: history }, [], {})[0].table;
  assert.equal(cell(resigned, 'Signed off at'), '2026-12-20 11:00 UTC');
  assert.equal(cell(resigned, 'Signed off by'), 'Bo');
  assert.match(cell(resigned, 'Earlier sign-off 1'), /by Ann/);

  // Never reopened: no extra line.
  const plain = sheetsOf({ ...base, status: 'complete', completedAt: '2026-10-01T01:00:00.000Z', completedByName: 'Ann' }, [], {})[0].table;
  assert.equal(plain.some((r) => String(r[0]).startsWith('Earlier sign-off')), false);
});

test('the Changes sheet names who is gone, who was added, who gained a product and who joined an admin group', () => {
  const review = {
    status: 'open', startedAt: '2026-10-13T01:00:00Z', generatedAt: '2026-10-13T01:05:00Z', groups: [],
    changes: { counts: { added: 1, removed: 3, becameAdmin: 2, gainedProducts: 2 }, gainedProducts: [{ accountId: 'old-shape', products: ['Jira Service Management'] }] },
    gone: [{ accountId: 'g1', displayName: 'Gone One', email: 'g1@x.com' }, { accountId: 'g2', displayName: '(unknown)', email: null }],
  };
  const rows = [
    { accountId: 'n1', displayName: 'New Admin', email: 'n1@x.com', newSinceLast: true, becameAdmin: true },
    { accountId: 'p1', displayName: 'Promoted', becameAdmin: true },
    { accountId: 'gp', displayName: 'Gained', gainedProducts: ['Jira Software'] },
    { accountId: 'old-shape', displayName: 'Old Shape' },
    { accountId: 'same', displayName: 'Same' },
  ];
  const changes = sheetsOf(review, rows, {})[3].table;
  assert.deepEqual(changes[0], ['Change', 'Display name', 'Email', 'Account ID', 'Detail']);
  assert.deepEqual(changes.slice(1), [
    ['Gone', 'Gone One', 'g1@x.com', 'g1', 'In the previous review, not in this one'],
    ['Gone', '(unknown)', '', 'g2', 'In the previous review, not in this one'],
    ['Gone', '', '', '', '1 more not listed: over the 500 kept, or their Atlassian account was closed'],
    ['Added', 'New Admin', 'n1@x.com', 'n1', 'Not in the previous review'],
    ['Gained a Jira product', 'Gained', '', 'gp', 'Jira Software'],
    ['Gained a Jira product', 'Old Shape', '', 'old-shape', 'Jira Service Management'],
    ['Joined an admin group (by name)', 'New Admin', 'n1@x.com', 'n1', ''],
    ['Joined an admin group (by name)', 'Promoted', '', 'p1', ''],
  ]);
  // The first review on a site has nothing to compare with.
  assert.deepEqual(sheetsOf({ ...review, changes: null }, rows, {})[3].table[1][0], 'No earlier signed-off review to compare with');
});

test('a closed account is nobody who left or joined, is never bulk-kept, and an admin whose account was closed reads "Closed account"', () => {
  const closed = closedMarker(0, 2);
  assert.equal(closed, '~closed:0.2');
  assert.equal(isClosedAccount(closed), true);
  for (const id of ['5b10ac8d82e05b22cc7d4e01', '712020:2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', '', null, undefined, 7]) assert.equal(isClosedAccount(id), false, String(id));

  const previous = [
    { accountId: 'a', products: ['Jira Software'], admin: false },
    { accountId: closed, products: ['Jira Software'], admin: true },
  ];
  const current = [{ accountId: 'a', products: ['Jira Software'], admin: false }, { accountId: 'b', products: [], admin: false }];
  const d = diffReviews(current, previous);
  assert.deepEqual(d.counts, { added: 1, removed: 0, becameAdmin: 0, gainedProducts: 0 });
  assert.deepEqual(d.added, ['b']);
  assert.deepEqual(flagChanges(current, previous).map((r) => Boolean(r.newSinceLast)), [false, true]);
  // A review whose own rows include a marker: it is not counted on either side.
  assert.deepEqual(diffReviews(previous, current).counts, { added: 0, removed: 1, becameAdmin: 0, gainedProducts: 0 });

  assert.equal(isActiveNonAdmin({ accountId: closed, active: true, admin: false }), false);
  assert.equal(isActiveNonAdmin({ accountId: 'a', active: true, admin: false }), true);

  const names = { a: { displayName: 'Ann' } };
  assert.equal(whoName('a', false, names), 'Ann');
  assert.equal(whoName('a', true, names), 'Ann', 'a field that holds an ID shows that person');
  assert.equal(whoName('x', false, names), '(unknown)');
  assert.equal(whoName(null, true, names), 'Closed account');
  assert.equal(whoName(null, false, names), null);

  // The flags travel with an old-shape sign-off, and an open review shows no sign-off.
  const legacy = { status: 'open', completedAt: 'x', completedBy: null, completedByClosed: true, reopenedAt: 'y', reopenedBy: null, reopenedByClosed: true };
  assert.deepEqual(signoffHistory(legacy), [{ completedAt: 'x', completedBy: null, completedByClosed: true, stats: null, reopenedAt: 'y', reopenedBy: null, reopenedByClosed: true }]);
  assert.equal('completedByClosed' in withSignoffs(legacy), false);
  assert.equal(withSignoffs({ ...legacy, status: 'complete' }).completedByClosed, true);
});
