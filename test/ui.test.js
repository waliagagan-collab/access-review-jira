import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { normaliseSeatCosts, yearlySaving, fmtMoney, filterRows, bandOptions, scanProgress, showReviewPrompt } from '../src/lib/ui.js';
import { buildXlsx, columnName, xmlText, csvCell, toCsv } from '../src/frame/xlsx.js';

test('seat prices keep only positive, sane numbers', () => {
  assert.deepEqual(
    normaliseSeatCosts({ 'Jira Software': '100', 'Jira Service Management': '1,250.5', Bad: 'abc', Zero: 0, Neg: -5, Huge: 1e9, '': 9 }),
    { 'Jira Software': 100, 'Jira Service Management': 1250.5 }
  );
  assert.deepEqual(normaliseSeatCosts(null), {});
  assert.deepEqual(normaliseSeatCosts('nope'), {});
});

test('seat prices cap the number of products stored', () => {
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`P${i}`, 10]));
  assert.equal(Object.keys(normaliseSeatCosts(many)).length, 20);
});

test('yearly saving multiplies inactive seats by each product price', () => {
  assert.equal(yearlySaving({ 'Jira Software': 3, 'Jira Service Management': 2 }, { 'Jira Software': 100, 'Jira Service Management': 250 }), 800);
});

test('yearly saving is null, not zero, when nothing inactive is priced', () => {
  assert.equal(yearlySaving({ 'Jira Software': 3 }, {}), null);
  assert.equal(yearlySaving({ 'Jira Software': 0 }, { 'Jira Software': 100 }), null);
  assert.equal(yearlySaving(undefined, undefined), null);
});

test('money is a whole number with separators', () => {
  assert.equal(fmtMoney(1234567.4), '1,234,567');
  assert.equal(fmtMoney(undefined), '0');
});

const ROWS = [
  { accountId: 'a', displayName: 'Asha Rao', email: 'asha@acme.test', products: ['Jira Software'], bucket: 'over-365', label: 'Over a year, or never', severity: 2 },
  { accountId: 'b', displayName: 'Ben Ito', email: null, products: ['Jira Software', 'Jira Service Management'], bucket: '90-180', label: '90–180 days', severity: 1 },
  { accountId: 'c', displayName: 'Chen Li', email: 'chen@acme.test', products: ['Jira Service Management'], bucket: 'over-365', label: 'Over a year, or never', severity: 2 },
];

test('search matches name or email, ignoring case', () => {
  assert.deepEqual(filterRows(ROWS, { query: 'ASHA' }).map((r) => r.accountId), ['a']);
  assert.deepEqual(filterRows(ROWS, { query: 'acme.test' }).map((r) => r.accountId), ['a', 'c']);
  assert.deepEqual(filterRows(ROWS, { query: '  ' }).length, 3);
});

test('product and inactivity filters combine with search', () => {
  assert.deepEqual(filterRows(ROWS, { product: 'Jira Service Management' }).map((r) => r.accountId), ['b', 'c']);
  assert.deepEqual(filterRows(ROWS, { product: 'Jira Service Management', band: 'over-365' }).map((r) => r.accountId), ['c']);
  assert.deepEqual(filterRows(ROWS, { query: 'ben', band: 'over-365' }), []);
  assert.deepEqual(filterRows(undefined), []);
});

test('band options list each band once, longest inactive first', () => {
  assert.deepEqual(bandOptions(ROWS), [
    { value: 'over-365', label: 'Over a year, or never' },
    { value: '90-180', label: '90–180 days' },
  ]);
});

test('progress is indeterminate until the per-user check, then counts shards', () => {
  assert.equal(scanProgress({ phase: 'issues' }).indeterminate, true);
  assert.deepEqual(scanProgress({ phase: 'verify', verifyShard: 0 }), { value: 0.5, indeterminate: false });
  assert.deepEqual(scanProgress({ phase: 'verify', verifyShard: 8 }), { value: 0.725, indeterminate: false });
  assert.equal(scanProgress({ phase: 'verify', verifyShard: 99 }).value, 0.95);
  assert.equal(scanProgress({ phase: 'finalize' }).value, 0.97);
  assert.equal(scanProgress(null).indeterminate, true);
});

test('excel columns are lettered like a spreadsheet', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(701), 'ZZ');
});

test('the excel file is a valid package with a frozen bold header and escaped text', () => {
  const bytes = buildXlsx([['Name', 'Email'], ['A & B <x>', '=HYPERLINK("x")']], 'Inactive users');
  const files = unzipSync(bytes);
  for (const f of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files[f], `${f} present`);
  }
  const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
  assert.match(sheet, /A &amp; B &lt;x&gt;/);
  assert.match(sheet, /state="frozen"/);
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1">/);
  assert.ok(!/<f>/.test(sheet), 'values are text, never formulas');
  assert.match(strFromU8(files['xl/workbook.xml']), /name="Inactive users"/);
});

test('xml text drops characters XML forbids', () => {
  assert.equal(xmlText('a\u0001b'), 'ab');
});

test('csv cells neutralise spreadsheet formulas and quote safely', () => {
  assert.equal(csvCell('=SUM(A1)'), `"'=SUM(A1)"`);
  assert.equal(csvCell('+1'), `"'+1"`);
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(toCsv([['a', 'b'], ['1', '2']]), '"a","b"\r\n"1","2"');
});

test('the review request appears once value is shown and never after it is closed', () => {
  assert.equal(showReviewPrompt({ earned: true, hidden: false }), true);
  assert.equal(showReviewPrompt({ earned: false, hidden: false }), false);
  assert.equal(showReviewPrompt({ earned: true, hidden: true }), false);
  assert.equal(showReviewPrompt({ earned: undefined, hidden: undefined }), false);
});
