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
  MAX_NOTE,
} from '../src/lib/review.js';
import { activityOf } from '../src/worker.js';
import { sheetsOf } from '../src/frame/evidence.js';
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

test('admin groups are recognised by a whole word, not by any name containing "admin"', () => {
  for (const name of ['jira-admins-acme', 'site-admins', 'org-admins', 'administrators', 'jira-administrators', 'sysadmin', 'Admin', 'ADMIN-team', 'confluence_admin']) {
    assert.equal(isAdminGroupName(name), true, name);
  }
  for (const name of ['badminton-club', 'administrative-assistants', 'padmin', 'adminton', 'design-team', '', null]) {
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

test('the evidence workbook has summary, users and groups sheets and no live formulas', () => {
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
  assert.deepEqual(sheets.map((s) => s.name), ['Summary', 'Users', 'Groups']);
  assert.equal(sheets[1].table[1][7], 'Keep');
  assert.equal(sheets[1].table[2][7], 'Undecided');
  const files = unzipSync(buildXlsx(sheets));
  const names = Object.keys(files);
  assert.ok(names.includes('xl/worksheets/sheet3.xml'));
  const workbook = strFromU8(files['xl/workbook.xml']);
  assert.match(workbook, /name="Users"/);
  const users = strFromU8(files['xl/worksheets/sheet2.xml']);
  assert.ok(users.includes('t="inlineStr"'), 'values are text, never formulas');
  assert.ok(!/<f>/.test(users));
});
