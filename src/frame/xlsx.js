import { zipSync, strToU8 } from 'fflate';

/**
 * A minimal, valid .xlsx built by hand: one sheet, inline strings, a bold
 * header row that stays frozen. No spreadsheet library, so nothing large or
 * vulnerable ships in the export frame. Values are written as text, never as
 * formulas, so a name like "=HYPERLINK(...)" cannot run in Excel.
 */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Pure: escape for XML text, and drop control characters XML forbids. */
export const xmlText = (v) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Pure: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Pure: the four XML files that make up the sheet and its workbook. */
export function sheetXml(table) {
  const widths = (table[0] ?? []).map((_, c) =>
    Math.min(60, Math.max(10, ...table.map((r) => String(r[c] ?? '').length + 2)))
  );
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const rows = table
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">` +
        r
          .map(
            (v, ci) =>
              `<c r="${columnName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`
          )
          .join('') +
        '</row>'
    )
    .join('');
  return (
    `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`
  );
}

/**
 * Build the workbook. Either one table (an array of rows, the first being the
 * header) with a sheet name, or a list of `{ name, table }` for several sheets.
 */
export function buildXlsx(tableOrSheets, sheetName = 'Sheet1') {
  const sheets = Array.isArray(tableOrSheets?.[0]) || !tableOrSheets?.length
    ? [{ name: sheetName, table: tableOrSheets ?? [] }]
    : tableOrSheets;
  const safeName = (n, i) =>
    xmlText(String(n ?? '').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`);
  const files = {
    '[Content_Types].xml':
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
    '_rels/.rels':
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${sheets.map((sh, i) => `<sheet name="${safeName(sh.name, i)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
    'xl/styles.xml':
      `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
      '</styleSheet>',
  };
  sheets.forEach((sh, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sh.table);
  });
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

/**
 * Pure: a CSV cell. Values that a spreadsheet would read as a formula get a
 * leading apostrophe, so opening the CSV can never run anything.
 */
export const csvCell = (v) => {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export const toCsv = (table) => table.map((r) => r.map(csvCell).join(',')).join('\r\n');
