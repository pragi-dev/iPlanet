// Tests for corporate device registration: field rules, the Excel parser,
// and the HTTP routes against a real MongoDB. Each run uses a new, uniquely named database
// that is dropped afterwards; set DEVICE_TEST_MONGODB_URI to point at a different server.
// The HTTP tests are skipped when MongoDB is not reachable.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Company, Device, ServiceCentre, Ticket } from '../models.js';
import { allowRoles, auth } from '../middleware.js';
import { coverageStatus, normalizeDevice, parseDate } from './deviceRules.js';
import { DEVICES_SHEET, MAX_IMPORT_ROWS, WorkbookError, readDeviceRows } from './deviceWorkbook.js';
import { createDeviceRegistrationRouter } from './deviceRoutes.js';
import { createClaudeColumnMapper } from './columnMapper.js';

const JWT_SECRET = 'device-registration-test-secret';
process.env.JWT_SECRET = JWT_SECRET;
const NOW = new Date('2026-10-26T06:00:00Z');
const LOCATIONS = ['Bengaluru', 'Chennai', 'Coimbatore', 'Madurai'];
const HEADERS = ['Device Model *', 'Device Type *', 'Serial Number *', 'Asset ID', 'Location', 'Assignment Status', 'Purchase Date', 'Warranty End Date', 'AMC End Date'];

async function workbook(rows, { headers = HEADERS, sheet = DEVICES_SHEET, above = [], before = [] } = {}) {
  const book = new ExcelJS.Workbook();
  before.forEach(name => book.addWorksheet(name).addRow(['Cover page']));
  const ws = book.addWorksheet(sheet);
  above.forEach(row => ws.addRow(row));
  ws.addRow(headers);
  rows.forEach(row => ws.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe('device field rules', () => {
  test('normalizes a valid device and works out coverage from end dates', () => {
    const { values, errors } = normalizeDevice({ model: ' MacBook Air M3 ', deviceType: 'macbook', serialNumber: 'c02abc12xy', location: 'chennai', warrantyExpiry: '2027-03-01', amcExpiry: '15-11-2026' }, { locations: LOCATIONS, now: NOW });
    assert.deepEqual(errors, []);
    assert.equal(values.model, 'MacBook Air M3');
    assert.equal(values.deviceType, 'MacBook');
    assert.equal(values.serialNumber, 'C02ABC12XY');
    assert.equal(values.location, 'Chennai');
    assert.equal(values.deviceAllocationStatus, 'Unassigned');
    assert.equal(values.warrantyStatus, 'Active');
    assert.equal(values.amcStatus, 'Expiring Soon');
  });

  test('does not invent coverage when end dates are unknown', () => {
    const { values } = normalizeDevice({ model: 'iPhone 16', deviceType: 'iPhone', serialNumber: 'F2LX1234AB' }, { locations: LOCATIONS, now: NOW });
    assert.equal(values.warrantyStatus, undefined);
    assert.equal(values.amcStatus, undefined);
    assert.equal(coverageStatus(new Date('2026-10-01'), NOW), 'Expired');
  });

  test('reports every invalid field', () => {
    const { errors } = normalizeDevice({ model: '', deviceType: 'Toaster', serialNumber: 'abc', assetId: 'bad id!', location: 'Mumbai', deviceAllocationStatus: 'Lent', purchaseDate: '2030-01-01', warrantyExpiry: '31-02-2026' }, { locations: LOCATIONS, now: NOW });
    assert.deepEqual(errors.map(error => error.field).sort(), ['assetId', 'deviceAllocationStatus', 'deviceType', 'location', 'model', 'purchaseDate', 'serialNumber', 'warrantyExpiry'].sort());
  });

  test('parses supported date formats only', () => {
    assert.equal(parseDate('2026-02-28').toISOString().slice(0, 10), '2026-02-28');
    assert.equal(parseDate('28/02/2026').toISOString().slice(0, 10), '2026-02-28');
    assert.equal(parseDate('2026-02-30'), undefined);
    assert.equal(parseDate(''), null);
  });
});

describe('device workbook', () => {
  test('reads rows from a valid workbook and skips blank lines', async () => {
    const parsed = await readDeviceRows(await workbook([['MacBook Pro', 'MacBook', 'C02TEST001A'], [], ['iPad Air', 'iPad', 'DMPTEST002B']]));
    assert.deepEqual(parsed.rows.map(row => row.row), [2, 4]);
    assert.equal(parsed.rows[1].input.serialNumber, 'DMPTEST002B');
  });

  test('rejects files that are not .xlsx workbooks', async () => {
    await assert.rejects(readDeviceRows(Buffer.from('serial,model\nABC123,Mac')), WorkbookError);
    await assert.rejects(readDeviceRows(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), /Older \.xls files/);
    await assert.rejects(readDeviceRows(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)])), /could not be read/);
  });

  test('rejects oversized files and too many rows', async () => {
    await assert.rejects(readDeviceRows(Buffer.alloc(1024 * 1024 + 1, 0x50)), /1 MB or smaller/);
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => ['Mac', 'MacBook', `C02BULK${String(index).padStart(4, '0')}`]);
    await assert.rejects(readDeviceRows(await workbook(many)), /more than 500/);
  });

  test('reports missing mandatory columns', async () => {
    await assert.rejects(readDeviceRows(await workbook([['MacBook Pro']], { headers: ['Device Model *', 'Asset ID'] })), error => error instanceof WorkbookError && error.missingColumns.join() === 'Device Type *,Serial Number *');
  });
});

describe('automatic column detection', () => {
  test('finds a header below title rows on a sheet with another name', async () => {
    const parsed = await readDeviceRows(await workbook([['MacBook Pro', 'MacBook', 'C02TITLE01A']], { sheet: 'Sheet3', before: ['Cover'], above: [['Acme Corp device register'], [], ['Exported 2026-10-01']] }));
    assert.equal(parsed.sheetName, 'Sheet3');
    assert.equal(parsed.headerRow, 4);
    assert.deepEqual(parsed.rows.map(row => row.row), [5]);
    assert.equal(parsed.rows[0].input.serialNumber, 'C02TITLE01A');
  });

  test('matches differently worded headings by keyword and ignores unrelated columns', async () => {
    const headers = ['Employee', 'Machine Serial No.', 'Product Name', 'Equipment Type', 'Warranty Status', 'Warranty Valid Till', 'Branch'];
    const parsed = await readDeviceRows(await workbook([['Asha', 'C02KEYWD1A', 'MacBook Air', 'MacBook', 'Active', '2027-01-01', 'Chennai']], { headers }));
    assert.deepEqual(Object.fromEntries(parsed.columnMapping.map(item => [item.heading, item.field])), { 'Machine Serial No.': 'serialNumber', 'Product Name': 'model', 'Equipment Type': 'deviceType', 'Warranty Valid Till': 'warrantyExpiry', Branch: 'location' });
    assert.ok(parsed.columnMapping.every(item => item.source === 'keyword'));
    assert.deepEqual(parsed.ignoredColumns, ['Employee', 'Warranty Status']);
  });

  test('recognises serial and device type columns by their values', async () => {
    const parsed = await readDeviceRows(await workbook([['MacBook Air', 'C02VALUE1A', 'MacBook'], ['iPad Pro', 'DMPVALUE2B', 'iPad']], { headers: ['Device Model', 'Code', 'Kind'] }));
    assert.deepEqual(parsed.columnMapping.map(item => [item.column, item.field, item.source]), [['A', 'model', 'heading'], ['B', 'serialNumber', 'values'], ['C', 'deviceType', 'values']]);
  });

  test('asks the fallback only about unmapped columns, and accepts only valid suggestions', async () => {
    const calls = [];
    const suggestMapping = async request => {
      calls.push(request);
      return [{ column: 'B', field: 'serialNumber' }, { column: 'C', field: 'deviceType' }, { column: 'A', field: 'assetId' }, { column: 'Z', field: 'location' }, { column: 'D', field: 'deviceType' }];
    };
    const parsed = await readDeviceRows(await workbook([['MacBook Air', 'X1', 'Laptop', 'Laptop']], { headers: ['Device Model', 'Ref', 'Group', 'Group 2'] }), { suggestMapping });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].columns.map(item => item.column), ['B', 'C', 'D'], 'mapped columns are not sent');
    assert.deepEqual(calls[0].columns[0], { column: 'B', heading: 'Ref', samples: ['X1'] });
    assert.ok(!calls[0].fields.some(field => field.key === 'model'), 'fields already matched are not offered');
    assert.deepEqual(parsed.columnMapping.map(item => [item.column, item.field, item.source]), [['A', 'model', 'heading'], ['B', 'serialNumber', 'ai'], ['C', 'deviceType', 'ai']]);
    assert.equal(parsed.rows[0].input.serialNumber, 'X1', 'values still come from the file, to be validated as usual');
  });

  test('with no recognisable headings, the fullest row is the header, not a title above it', async () => {
    let offered;
    const suggestMapping = async request => { offered = request.columns.map(item => item.heading); return []; };
    await assert.rejects(readDeviceRows(await workbook([['MacBook Air', 'Laptop', 'X1']], { headers: ['Gadget', 'Kind of gear', 'ID on chassis'], above: [['Acme IT asset register'], []] }), { suggestMapping }), WorkbookError);
    assert.deepEqual(offered, ['Gadget', 'Kind of gear', 'ID on chassis']);
  });

  test('does not call the fallback when the rules find every mandatory column', async () => {
    let called = false;
    await readDeviceRows(await workbook([['MacBook Pro', 'MacBook', 'C02NOCALL1A']]), { suggestMapping: async () => { called = true; return []; } });
    assert.equal(called, false);
  });

  test('a failing or empty fallback leaves the usual missing-column error', async () => {
    const file = await workbook([['MacBook Pro', 'abc']], { headers: ['Device Model', 'Notes'] });
    for (const suggestMapping of [async () => { throw new Error('network down'); }, async () => [], async () => 'nonsense']) {
      await assert.rejects(readDeviceRows(file, { suggestMapping }), error => error instanceof WorkbookError && error.missingColumns.join() === 'Device Type *,Serial Number *');
    }
  });
});

describe('Claude column mapper', () => {
  const quiet = { warn() {} };
  const fields = [{ key: 'serialNumber', label: 'Serial Number', hint: 'h' }, { key: 'deviceType', label: 'Device Type', hint: 'h' }];
  const columns = [{ column: 'B', heading: 'Ref', samples: ['C02ABC123'] }];
  const fakeClient = respond => {
    const requests = [];
    const create = async request => { requests.push(request); return respond(request); };
    return { requests, client: { messages: { create }, beta: { messages: { create } } } };
  };

  test('is off without an API key', () => {
    assert.equal(createClaudeColumnMapper({ apiKey: '' }), null);
  });

  test('sends headings and samples with a schema limited to the free fields, and reads the mapping', async () => {
    const fake = fakeClient(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ mappings: [{ column: 'B', field: 'serialNumber' }] }) }] }));
    const suggest = createClaudeColumnMapper({ client: fake.client, model: 'claude-opus-5-5', logger: quiet });
    assert.deepEqual(await suggest({ fields, columns }), [{ column: 'B', field: 'serialNumber' }]);
    const [request] = fake.requests;
    assert.equal(request.model, 'claude-opus-5-5');
    assert.deepEqual(request.output_config.format.schema.properties.mappings.items.properties.field.enum, ['serialNumber', 'deviceType']);
    assert.equal(request.fallbacks, 'default');
    assert.deepEqual(JSON.parse(request.messages[0].content).columns, columns);
  });

  test('returns no suggestions on a refusal, bad output or an API error', async () => {
    for (const respond of [() => ({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }), () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }), () => { throw new Error('timeout'); }]) {
      const suggest = createClaudeColumnMapper({ client: fakeClient(respond).client, logger: quiet });
      assert.deepEqual(await suggest({ fields, columns }), []);
    }
  });
});

let mongoAvailable = true;
const DB_NAME = `iplanet_device_test_${process.pid}_${Date.now()}`;
try { await mongoose.connect(process.env.DEVICE_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017', { dbName: DB_NAME, serverSelectionTimeoutMS: 3000 }); } catch { mongoAvailable = false; }
const skip = mongoAvailable ? false : 'MongoDB is not reachable (set DEVICE_TEST_MONGODB_URI)';

describe('device registration API', { skip }, () => {
  let server; let base; let companyA; let companyB; let adminA; let adminB; let serviceUser;
  const token = payload => `Bearer ${jwt.sign(payload, JWT_SECRET)}`;
  const call = (path, { method = 'GET', user = adminA, body, form } = {}) => fetch(`${base}${path}`, { method, headers: { ...(user ? { Authorization: user } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
  const upload = async (buffer, user = adminA, name = 'devices.xlsx') => { const form = new FormData(); form.append('file', new Blob([buffer]), name); return call('/api/corporate/devices/import', { method: 'POST', user, form }); };

  before(async () => {
    await Promise.all([Device.init(), ServiceCentre.init()]);
    await ServiceCentre.insertMany(LOCATIONS.map(location => ({ name: `iPlanet ${location}`, location })));
    [companyA, companyB] = await Company.insertMany([{ companyId: 'TEST-ORG-A', name: 'Test Org A', location: 'Chennai' }, { companyId: 'TEST-ORG-B', name: 'Test Org B', location: 'Madurai' }]);
    adminA = token({ id: new mongoose.Types.ObjectId().toString(), role: 'corporate_admin', companyId: String(companyA._id) });
    adminB = token({ id: new mongoose.Types.ObjectId().toString(), role: 'corporate_admin', companyId: String(companyB._id) });
    serviceUser = token({ id: new mongoose.Types.ObjectId().toString(), role: 'iplanet_service' });
    await Device.create({ serialNumber: 'C02EXIST01A', model: 'MacBook Air', deviceType: 'MacBook', assetId: 'AST-A-001', companyId: companyA._id, location: 'Chennai' });
    await Device.create({ serialNumber: 'C02OTHER01B', model: 'iPhone 15', deviceType: 'iPhone', assetId: 'AST-B-001', companyId: companyB._id, location: 'Madurai' });
    const app = express();
    app.use(express.json());
    app.use('/api/corporate/devices', createDeviceRegistrationRouter({ models: { Device, Company, ServiceCentre }, auth, allowRoles, now: () => NOW }));
    app.use((error, req, res, next) => res.status(500).json({ message: error.message }));
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('a corporate admin adds a device to their own organization', async () => {
    const response = await call('/api/corporate/devices', { method: 'POST', body: { model: 'MacBook Pro 14', deviceType: 'MacBook', serialNumber: 'c02manual1a', assetId: 'AST-A-100', warrantyExpiry: '2027-06-30', companyId: String(companyB._id) } });
    assert.equal(response.status, 201);
    const device = await Device.findOne({ serialNumber: 'C02MANUAL1A' }).lean();
    assert.equal(String(device.companyId), String(companyA._id), 'company comes from the session, not the request body');
    assert.equal(device.location, 'Chennai');
    assert.equal(device.warrantyStatus, 'Active');
    assert.equal(device.amcStatus, undefined);
    assert.equal(device.deviceAllocationStatus, 'Unassigned');
  });

  test('users who are not corporate admins cannot add devices', async () => {
    assert.equal((await call('/api/corporate/devices', { method: 'POST', user: null, body: { model: 'X', deviceType: 'iPad', serialNumber: 'DMPNOAUTH1' } })).status, 401);
    assert.equal((await call('/api/corporate/devices', { method: 'POST', user: serviceUser, body: { model: 'X', deviceType: 'iPad', serialNumber: 'DMPNOAUTH1' } })).status, 403);
    assert.equal((await upload(await workbook([['X', 'iPad', 'DMPNOAUTH1']]), serviceUser)).status, 403);
    assert.equal(await Device.countDocuments({ serialNumber: 'DMPNOAUTH1' }), 0);
  });

  test('duplicate serial numbers are rejected, whichever organization owns the device', async () => {
    const own = await call('/api/corporate/devices', { method: 'POST', body: { model: 'MacBook Air', deviceType: 'MacBook', serialNumber: 'c02exist01a' } });
    assert.equal(own.status, 409);
    assert.match((await own.json()).message, /already in your devices/);
    const other = await call('/api/corporate/devices', { method: 'POST', body: { model: 'iPhone 15', deviceType: 'iPhone', serialNumber: 'C02OTHER01B' } });
    assert.equal(other.status, 409);
    const message = (await other.json()).message;
    assert.match(message, /already registered with iPlanet/);
    assert.doesNotMatch(message, /Test Org B/);
    assert.equal(String((await Device.findOne({ serialNumber: 'C02OTHER01B' })).companyId), String(companyB._id), 'ownership is unchanged');
  });

  test('asset IDs are unique within an organization only', async () => {
    const clash = await call('/api/corporate/devices', { method: 'POST', body: { model: 'iPad', deviceType: 'iPad', serialNumber: 'DMPASSET01', assetId: 'ast-a-001' } });
    assert.equal(clash.status, 409);
    const otherOrg = await call('/api/corporate/devices', { method: 'POST', body: { model: 'iPad', deviceType: 'iPad', serialNumber: 'DMPASSET02', assetId: 'AST-B-001' } });
    assert.equal(otherOrg.status, 201);
  });

  test('invalid fields and unknown locations are rejected with field errors', async () => {
    const response = await call('/api/corporate/devices', { method: 'POST', body: { model: 'iPad', deviceType: 'Tablet', serialNumber: 'DMPLOC0001', location: 'Mumbai' } });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.deepEqual(body.errors.map(error => error.field).sort(), ['deviceType', 'location']);
  });

  test('a valid file validates, then imports every row on confirmation', async () => {
    const preview = await upload(await workbook([['MacBook Air M3', 'MacBook', 'C02IMPORT1A', 'AST-A-201', 'Coimbatore', 'Assigned', '2025-01-15', '2027-01-14', ''], ['iPhone 16', 'iphone', 'F2LIMPORT2B', '', '', '', '', '', '2026-12-01']]));
    assert.equal(preview.status, 200);
    const report = await preview.json();
    assert.deepEqual(report.summary, { total: 2, valid: 2, invalid: 0, duplicates: 0 });
    assert.equal(report.headerRow, 1);
    assert.deepEqual(report.columnMapping.map(item => item.field), ['model', 'deviceType', 'serialNumber', 'assetId', 'location', 'deviceAllocationStatus', 'purchaseDate', 'warrantyExpiry', 'amcExpiry']);
    assert.equal(await Device.countDocuments({ serialNumber: { $in: ['C02IMPORT1A', 'F2LIMPORT2B'] } }), 0, 'nothing is saved before confirmation');
    const confirm = await call(`/api/corporate/devices/import/${report.importId}/confirm`, { method: 'POST' });
    assert.equal(confirm.status, 201);
    assert.equal((await confirm.json()).result.imported, 2);
    const saved = await Device.find({ serialNumber: { $in: ['C02IMPORT1A', 'F2LIMPORT2B'] } }).lean();
    assert.equal(saved.length, 2);
    assert.ok(saved.every(device => String(device.companyId) === String(companyA._id)));
    assert.equal(saved.find(device => device.serialNumber === 'C02IMPORT1A').deviceAllocationStatus, 'Assigned');
    assert.equal(saved.find(device => device.serialNumber === 'F2LIMPORT2B').amcStatus, 'Expiring Soon');
    const again = await call(`/api/corporate/devices/import/${report.importId}/confirm`, { method: 'POST' });
    assert.equal(again.status, 409, 'an import cannot be confirmed twice');
    const status = await (await call(`/api/corporate/devices/import/${report.importId}`)).json();
    assert.equal(status.status, 'imported');
  });

  test('invalid rows, in-file duplicates and existing devices are reported per row, and block the import', async () => {
    const preview = await upload(await workbook([
      ['Mac mini', 'Mac mini', 'C02BATCH01A', 'AST-A-301'],
      ['Mac mini', 'Mac mini', 'c02batch01a', 'AST-A-302'],
      ['iPad Pro', 'iPad', 'C02EXIST01A', 'AST-A-303'],
      ['iPad Pro', 'iPad', 'DMPBATCH04', 'AST-A-001'],
      ['', 'Watch', 'x1', '', 'Pune'],
    ]));
    const report = await preview.json();
    assert.deepEqual(report.summary, { total: 5, valid: 1, invalid: 4, duplicates: 3 });
    const byRow = Object.fromEntries(report.rows.map(row => [row.row, row.errors]));
    assert.deepEqual(byRow[2], []);
    assert.equal(byRow[3][0].duplicate, 'file');
    assert.match(byRow[3][0].message, /also on row 2/);
    assert.equal(byRow[4][0].duplicate, 'database');
    assert.equal(byRow[5][0].field, 'assetId');
    assert.deepEqual(byRow[6].map(error => error.field).sort(), ['deviceType', 'location', 'model', 'serialNumber']);
    const confirm = await call(`/api/corporate/devices/import/${report.importId}/confirm`, { method: 'POST' });
    assert.equal(confirm.status, 409);
    assert.equal(await Device.countDocuments({ serialNumber: { $in: ['C02BATCH01A', 'DMPBATCH04'] } }), 0, 'no partial import');
  });

  test('a device registered after the preview stops the whole batch without partial records', async () => {
    const report = await (await upload(await workbook([['MacBook Air', 'MacBook', 'C02RACE001A'], ['MacBook Air', 'MacBook', 'C02RACE002B']]))).json();
    assert.equal(report.summary.valid, 2);
    await Device.create({ serialNumber: 'C02RACE002B', model: 'MacBook Air', deviceType: 'MacBook', companyId: companyB._id });
    const confirm = await call(`/api/corporate/devices/import/${report.importId}/confirm`, { method: 'POST' });
    assert.equal(confirm.status, 409);
    assert.equal(await Device.countDocuments({ serialNumber: 'C02RACE001A' }), 0);
  });

  test('a failed insert is rolled back, leaving no partial records', async () => {
    const report = await (await upload(await workbook([['Mac Studio', 'Mac Studio', 'C02ROLL001A'], ['Mac Studio', 'Mac Studio', 'C02ROLL002B']]))).json();
    // Simulate a concurrent writer winning the race between re-validation and insert.
    const original = Device.insertMany.bind(Device);
    Device.insertMany = async (docs, options) => { await Device.create({ serialNumber: 'C02ROLL002B', model: 'Mac Studio', deviceType: 'Mac Studio', companyId: companyB._id }); return original(docs, options); };
    try {
      const confirm = await call(`/api/corporate/devices/import/${report.importId}/confirm`, { method: 'POST' });
      assert.equal(confirm.status, 409);
    } finally { Device.insertMany = original; }
    assert.equal(await Device.countDocuments({ serialNumber: 'C02ROLL001A' }), 0, 'the first row was rolled back');
    assert.equal(String((await Device.findOne({ serialNumber: 'C02ROLL002B' })).companyId), String(companyB._id));
  });

  test('file-level problems are rejected before any rows are read', async () => {
    const wrongType = await upload(Buffer.from('serial,model\nC02CSV0001A,Mac'), adminA, 'devices.csv');
    assert.equal(wrongType.status, 400);
    const missing = await upload(await workbook([['MacBook']], { headers: ['Device Model *'] }));
    assert.equal(missing.status, 400);
    assert.deepEqual((await missing.json()).missingColumns, ['Device Type *', 'Serial Number *']);
    const oversized = await upload(Buffer.alloc(1024 * 1024 + 10, 0x50));
    assert.equal(oversized.status, 400);
  });

  test('another organization cannot see or confirm an import', async () => {
    const report = await (await upload(await workbook([['iPad mini', 'iPad', 'DMPTENANT1']]))).json();
    assert.equal((await call(`/api/corporate/devices/import/${report.importId}`, { user: adminB })).status, 404);
    assert.equal((await call(`/api/corporate/devices/import/${report.importId}/confirm`, { method: 'POST', user: adminB })).status, 404);
    assert.equal(await Device.countDocuments({ serialNumber: 'DMPTENANT1' }), 0);
  });

  test('registered devices do not change existing tickets or devices', async () => {
    assert.equal(await Ticket.countDocuments(), 0);
    assert.equal((await Device.findOne({ serialNumber: 'C02EXIST01A' })).assetId, 'AST-A-001');
  });
});
