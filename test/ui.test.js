import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { scanProgress, showReviewPrompt } from '../src/lib/ui.js';
import { buildXlsx, columnName, xmlText, csvCell, toCsv } from '../src/frame/xlsx.js';

test('progress is indeterminate until the per-user check, then counts shards', () => {
  assert.equal(scanProgress({ phase: 'groups' }).indeterminate, true);
  assert.equal(scanProgress({ phase: 'members' }).indeterminate, true);
  assert.equal(scanProgress({ phase: 'issues' }).indeterminate, true);
  assert.deepEqual(scanProgress({ phase: 'verify', verifyShard: 0 }), { value: 0.5, indeterminate: false });
  assert.deepEqual(scanProgress({ phase: 'verify', verifyShard: 32 }), { value: 0.725, indeterminate: false });
  // The scan record says how many shards it walks; older records had 16.
  assert.deepEqual(scanProgress({ phase: 'verify', verifyShard: 8, shards: 16 }), { value: 0.725, indeterminate: false });
  assert.equal(scanProgress({ phase: 'verify', verifyShard: 999 }).value, 0.95);
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
