import ExcelJS from 'exceljs';
import { DEVICE_FIELDS, DEVICE_TYPES, isValidSerial } from './deviceRules.js';

export const DEVICES_SHEET = 'Devices';
export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_BYTES = 1024 * 1024;

export class WorkbookError extends Error {}

// Column headings; a trailing " *" (marking a mandatory column) is optional.
const headerFor = field => `${field.label}${field.required ? ' *' : ''}`;
const headerKey = value => String(value || '').toLowerCase().replace(/\(.*?\)|\*/g, '').replace(/[^a-z0-9]/g, '');
const COLUMN_ALIASES = new Map([
  ...DEVICE_FIELDS.map(field => [headerKey(field.label), field.key]),
  ['model', 'model'], ['devicename', 'model'], ['devicenamemodel', 'model'], ['type', 'deviceType'], ['category', 'deviceType'], ['devicecategory', 'deviceType'],
  ['serial', 'serialNumber'], ['serialno', 'serialNumber'], ['assettag', 'assetId'], ['assignment', 'deviceAllocationStatus'], ['status', 'deviceAllocationStatus'],
  ['warrantyexpiry', 'warrantyExpiry'], ['warrantyenddate', 'warrantyExpiry'], ['amcexpiry', 'amcExpiry'], ['amcenddate', 'amcExpiry'],
]);
// Rows searched for the header, so title or note rows above it are skipped.
const HEADER_SCAN_ROWS = 20;
// Values per column used to recognise a column by its contents, and sent to the AI fallback.
const VALUE_SAMPLE_ROWS = 20;
const AI_SAMPLE_ROWS = 5;
const AI_MAX_COLUMNS = 40;
// Share of a column's values that must look like a field for it to be matched by values.
const VALUE_MATCH_SHARE = 0.8;

// Headings that are not an exact alias but clearly name a field, tried in this order.
// A heading must contain a word from each `all` group and none of the `none` words.
const DATE_WORDS = ['end', 'expiry', 'expires', 'expiration', 'exp', 'till', 'until', 'upto', 'date', 'valid', 'validity'];
const KEYWORD_RULES = [
  { field: 'serialNumber', all: [['serial']] },
  { field: 'assetId', all: [['asset'], ['id', 'tag', 'no', 'number', 'code']] },
  { field: 'warrantyExpiry', all: [['warranty'], DATE_WORDS], none: ['status', 'type'] },
  { field: 'amcExpiry', all: [['amc'], DATE_WORDS], none: ['status', 'type'] },
  { field: 'purchaseDate', all: [['purchase', 'purchased', 'invoice', 'bought'], ['date', 'on']] },
  { field: 'deviceAllocationStatus', all: [['assigned', 'assignment', 'allocation', 'allocated']] },
  { field: 'location', all: [['location', 'branch', 'site', 'city', 'office']] },
  { field: 'deviceType', all: [['type', 'category']], none: ['warranty', 'amc', 'coverage', 'contract'] },
  { field: 'model', all: [['model', 'product']] },
];
const headingWords = value => String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function keywordField(heading) {
  const words = new Set(headingWords(heading));
  const rule = KEYWORD_RULES.find(item => item.all.every(group => group.some(word => words.has(word))) && !(item.none || []).some(word => words.has(word)));
  return rule?.field;
}
const columnLetter = number => { let letters = ''; for (let n = number; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters; return letters; };
const isHidden = sheet => sheet.state === 'hidden' || sheet.state === 'veryHidden';

// Formula cells contribute their cached result only; formulas and macros are never run.
function cellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('result' in value) return cellValue(value.result);
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text).join('');
    if ('text' in value) return cellValue(value.text);
    if ('error' in value) return '';
    return '';
  }
  return value;
}

const isZip = buffer => buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
const isLegacyXls = buffer => buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

// Matches a header row's headings to fields: exact aliases first, then keyword rules.
// Each field is used at most once, by the first column that claims it.
function mapHeadings(headings) {
  const columns = new Map();
  const sources = new Map();
  const used = new Set();
  for (const [source, match] of [['heading', heading => COLUMN_ALIASES.get(headerKey(heading))], ['keyword', keywordField]]) {
    for (const [column, heading] of headings) {
      if (columns.has(column)) continue;
      const field = match(heading);
      if (field && !used.has(field)) { columns.set(column, field); sources.set(column, source); used.add(field); }
    }
  }
  return { columns, sources };
}

const rowHeadings = row => {
  const headings = new Map();
  row.eachCell((cell, column) => { const heading = String(cellValue(cell.value)).trim(); if (heading) headings.set(column, heading); });
  return headings;
};

// Picks the sheet and header row whose headings match the most fields, counting mandatory
// ones twice. Other ties go to the "Devices" sheet, then the earlier sheet and row.
function findHeader(workbook) {
  const preferred = workbook.getWorksheet(DEVICES_SHEET);
  const sheets = [preferred, ...workbook.worksheets.filter(sheet => sheet !== preferred && !isHidden(sheet))].filter(Boolean);
  let best = null;
  for (const sheet of sheets) {
    for (let rowNumber = 1; rowNumber <= Math.min(HEADER_SCAN_ROWS, sheet.rowCount); rowNumber += 1) {
      const headings = rowHeadings(sheet.getRow(rowNumber));
      if (!headings.size) continue;
      const fields = [...mapHeadings(headings).columns.values()];
      const score = fields.length + DEVICE_FIELDS.filter(field => field.required && fields.includes(field.key)).length;
      // On the same sheet, an equal score goes to the row with more filled cells, so a
      // one-cell title row never wins over the real header.
      if (!best || score > best.score || (score === best.score && sheet === best.sheet && headings.size > best.headings.size)) best = { sheet, rowNumber, headings, score };
    }
  }
  return best;
}

// Non-blank values of a column below the header, up to `limit`.
function columnSamples(sheet, headerRow, column, limit) {
  const values = [];
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount && values.length < limit; rowNumber += 1) {
    const value = cellValue(sheet.getRow(rowNumber).getCell(column).value);
    if (String(value ?? '').trim() !== '') values.push(value);
  }
  return values;
}

// Matches still-unmapped columns by what they contain. Only fields with an unambiguous
// shape (device types, serial numbers) are tried, and only when exactly one column fits.
function mapByValues(sheet, headerRow, candidates, mapping) {
  const used = new Set(mapping.columns.values());
  const tests = [
    ['deviceType', value => typeof value === 'string' && DEVICE_TYPES.some(type => type.toLowerCase() === value.trim().toLowerCase())],
    ['serialNumber', value => typeof value === 'string' && isValidSerial(value.trim().toUpperCase())],
  ];
  for (const [field, looksRight] of tests) {
    if (used.has(field)) continue;
    const fits = candidates.filter(column => {
      if (mapping.columns.has(column)) return false;
      const values = columnSamples(sheet, headerRow, column, VALUE_SAMPLE_ROWS);
      return values.length > 0 && values.filter(looksRight).length / values.length >= VALUE_MATCH_SHARE;
    });
    if (fits.length === 1) { mapping.columns.set(fits[0], field); mapping.sources.set(fits[0], 'values'); used.add(field); }
  }
}

// Asks the AI fallback about the unmapped columns. A suggestion is accepted only for a
// column that was offered and a field that is still free.
async function mapWithSuggestions(sheet, headerRow, candidates, mapping, headings, suggestMapping) {
  const used = new Set(mapping.columns.values());
  const fields = DEVICE_FIELDS.filter(field => !used.has(field.key));
  const columns = candidates.filter(column => !mapping.columns.has(column)).slice(0, AI_MAX_COLUMNS)
    .map(column => ({ number: column, column: columnLetter(column), heading: headings.get(column) || '', samples: columnSamples(sheet, headerRow, column, AI_SAMPLE_ROWS) }))
    .filter(item => item.heading || item.samples.length);
  if (!fields.length || !columns.length) return;
  let suggestions;
  try { suggestions = await suggestMapping({ fields, columns: columns.map(({ column, heading, samples }) => ({ column, heading, samples })) }); }
  catch { suggestions = []; }
  const byLetter = new Map(columns.map(item => [item.column, item.number]));
  const free = new Set(fields.map(field => field.key));
  for (const { column, field } of Array.isArray(suggestions) ? suggestions : []) {
    const number = byLetter.get(String(column).trim().toUpperCase());
    if (!number || mapping.columns.has(number) || !free.has(field)) continue;
    mapping.columns.set(number, field);
    mapping.sources.set(number, 'ai');
    free.delete(field);
  }
}

// Reads the device rows from an uploaded workbook. Throws WorkbookError for a file that
// can't be used at all; per-row problems are left to row validation.
// Columns are matched by heading, then keyword, then their values. If a mandatory column
// is still missing and `suggestMapping` (the Claude fallback) is given, it is asked too.
export async function readDeviceRows(buffer, { suggestMapping } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new WorkbookError('The file is empty.');
  if (buffer.length > MAX_IMPORT_BYTES) throw new WorkbookError('The file must be 1 MB or smaller.');
  if (isLegacyXls(buffer)) throw new WorkbookError('Older .xls files are not supported. Save the file as .xlsx (Excel Workbook) and upload it again.');
  if (!isZip(buffer)) throw new WorkbookError('This is not an Excel .xlsx file. Save it as an Excel Workbook (.xlsx) and upload it again.');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch { throw new WorkbookError('The workbook could not be read. It may be damaged or password-protected.'); }
  const header = findHeader(workbook);
  if (!header) throw new WorkbookError(`The workbook has no "${DEVICES_SHEET}" sheet.`);
  const { sheet, rowNumber: headerRow, headings } = header;
  if (sheet.actualRowCount - 1 > MAX_IMPORT_ROWS) throw new WorkbookError(`The file has more than ${MAX_IMPORT_ROWS} rows. Split it into smaller files.`);

  // Every column with a heading or with a value below the header.
  const valued = Array.from({ length: sheet.columnCount }, (_, index) => index + 1).filter(column => columnSamples(sheet, headerRow, column, 1).length);
  const candidates = [...new Set([...headings.keys(), ...valued])].sort((a, b) => a - b);
  const mapping = mapHeadings(headings);
  const missing = () => DEVICE_FIELDS.filter(field => field.required && ![...mapping.columns.values()].includes(field.key));
  if (missing().length) mapByValues(sheet, headerRow, candidates, mapping);
  if (missing().length && suggestMapping) await mapWithSuggestions(sheet, headerRow, candidates, mapping, headings, suggestMapping);
  const missingColumns = missing().map(field => headerFor(field));
  if (missingColumns.length) {
    const error = new WorkbookError(`Mandatory column${missingColumns.length === 1 ? ' is' : 's are'} missing: ${missingColumns.join(', ')}.`);
    error.missingColumns = missingColumns;
    throw error;
  }

  const ordered = [...mapping.columns].sort(([a], [b]) => a - b);
  const columnMapping = ordered.map(([column, field]) => ({ column: columnLetter(column), heading: headings.get(column) || '', field, label: DEVICE_FIELDS.find(item => item.key === field).label, source: mapping.sources.get(column) }));
  const ignoredColumns = [...headings].filter(([column]) => !mapping.columns.has(column)).map(([, heading]) => heading);

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const input = {};
    for (const [column, field] of ordered) input[field] = cellValue(row.getCell(column).value);
    // Rows with nothing in the device columns are blank lines, not devices.
    if (Object.values(input).every(value => String(value ?? '').trim() === '')) return;
    rows.push({ row: rowNumber, input });
  });
  if (rows.length > MAX_IMPORT_ROWS) throw new WorkbookError(`The file has more than ${MAX_IMPORT_ROWS} devices. Split it into smaller files.`);
  if (!rows.length) throw new WorkbookError(`The "${sheet.name}" sheet has no devices. Add one device per row below the header.`);
  return { sheetName: sheet.name, headerRow, rows, ignoredColumns, columnMapping };
}
