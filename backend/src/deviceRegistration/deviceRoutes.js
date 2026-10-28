import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { ASSIGNMENT_STATUSES, DEVICE_FIELDS, DEVICE_TYPES, deviceDocument, findDuplicates, normalizeDevice } from './deviceRules.js';
import { DEVICE_SOURCES } from './deviceSource.js';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, WorkbookError, readDeviceRows } from './deviceWorkbook.js';

// How long a validated import waits for confirmation before it must be uploaded again.
const IMPORT_TTL_MS = 30 * 60 * 1000;

// Corporate admins register their own devices one at a time or from an Excel workbook.
// Mounted at /api/corporate/devices. Every route is limited to the admin's own
// organization: the company always comes from the signed-in user, never the request.
// `suggestColumnMapping` is the optional Claude fallback for Excel column detection.
export function createDeviceRegistrationRouter({ models, auth, allowRoles, now = () => new Date(), suggestColumnMapping = null }) {
  const { Device, Company, ServiceCentre } = models;
  const router = express.Router();
  const corporateAdmin = [auth, allowRoles('corporate_admin'), (req, res, next) => req.user.companyId ? next() : res.status(403).json({ message: 'Your account is not linked to an organization.' })];
  // Workbooks are held in memory only and never written to disk.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } });
  // Validated imports waiting for confirmation, by import ID. Each holds only normalized
  // rows, not the uploaded file.
  const imports = new Map();

  const sweep = () => { const cutoff = now().getTime() - IMPORT_TTL_MS; for (const [id, item] of imports) if (item.createdAt.getTime() < cutoff) imports.delete(id); };

  async function context(companyId) {
    const [company, locations] = await Promise.all([Company.findById(companyId).select('location').lean(), ServiceCentre.distinct('location', { status: { $ne: 'Inactive' } })]);
    const sorted = locations.filter(Boolean).sort();
    return { locations: sorted, defaultLocation: sorted.includes(company?.location) ? company.location : '' };
  }

  async function validate(inputs, companyId) {
    const options = { ...(await context(companyId)), now: now() };
    const rows = inputs.map(({ row, input }) => ({ row, input, ...normalizeDevice(input, options) }));
    await findDuplicates(rows, { Device, companyId });
    return rows;
  }

  // Inserts every device or none. MongoDB here runs without replica-set transactions, so a
  // failed batch is rolled back by deleting the documents it inserted. The unique serial
  // index (and the per-organization asset ID index) stops concurrent imports adding the same device.
  async function insertAll(docs) {
    const withIds = docs.map(doc => ({ _id: new mongoose.Types.ObjectId(), ...doc }));
    try {
      await Device.insertMany(withIds, { ordered: true });
      return withIds;
    } catch (error) {
      await Device.deleteMany({ _id: { $in: withIds.map(doc => doc._id) } });
      throw error;
    }
  }

  const summaryOf = rows => {
    const invalid = rows.filter(item => item.errors.length);
    return { total: rows.length, valid: rows.length - invalid.length, invalid: invalid.length, duplicates: rows.filter(item => item.errors.some(error => error.duplicate)).length };
  };
  // What the file said, as text, so a rejected value can be shown next to its error.
  const asText = input => Object.fromEntries(Object.entries(input || {}).map(([field, value]) => [field, value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 120)]));
  const present = rows => rows.map(({ row, input, values, errors }) => ({ row, input: asText(input), values, errors: errors.map(({ field, message, duplicate }) => ({ field, message, ...(duplicate ? { duplicate } : {}) })) }));
  const duplicateKey = error => error?.code === 11000 || error?.writeErrors?.some?.(item => item.code === 11000) || error?.cause?.code === 11000;

  // Choices for the add-device form, from the same rules the server validates against.
  router.get('/registration-options', ...corporateAdmin, async (req, res) => {
    const { locations, defaultLocation } = await context(req.user.companyId);
    res.json({ deviceTypes: DEVICE_TYPES, assignmentStatuses: ASSIGNMENT_STATUSES, locations, defaultLocation, fields: DEVICE_FIELDS, maxImportRows: MAX_IMPORT_ROWS, maxImportBytes: MAX_IMPORT_BYTES });
  });

  router.post('/', ...corporateAdmin, async (req, res) => {
    const [result] = await validate([{ row: 1, input: req.body || {} }], req.user.companyId);
    if (result.errors.length) return res.status(result.errors.some(error => error.duplicate) ? 409 : 400).json({ message: result.errors[0].message, errors: result.errors });
    try {
      const device = await Device.create(deviceDocument(result.values, req.user.companyId, DEVICE_SOURCES.MANUAL));
      res.status(201).json(device);
    } catch (error) {
      if (duplicateKey(error)) return res.status(409).json({ message: 'This serial number or asset ID was registered a moment ago. Refresh your devices and check.' });
      throw error;
    }
  });

  router.post('/import', ...corporateAdmin, (req, res, next) => upload.single('file')(req, res, error => {
    if (!error) return next();
    if (error instanceof multer.MulterError) return res.status(400).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'The file must be 1 MB or smaller.' : 'Upload one Excel file in the "file" field.' });
    next(error);
  }), async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Choose an Excel (.xlsx) file to upload.' });
    let parsed;
    try { parsed = await readDeviceRows(req.file.buffer, { suggestMapping: suggestColumnMapping }); }
    catch (error) {
      if (error instanceof WorkbookError) return res.status(400).json({ message: error.message, ...(error.missingColumns ? { missingColumns: error.missingColumns } : {}) });
      throw error;
    }
    const rows = await validate(parsed.rows, req.user.companyId);
    sweep();
    const id = crypto.randomUUID();
    const summary = summaryOf(rows);
    imports.set(id, { id, userId: String(req.user.id), companyId: String(req.user.companyId), fileName: String(req.file.originalname || 'devices.xlsx').slice(0, 120), rows: parsed.rows, summary, status: 'validated', createdAt: now() });
    res.json({ importId: id, fileName: imports.get(id).fileName, sheetName: parsed.sheetName, headerRow: parsed.headerRow, columnMapping: parsed.columnMapping, ignoredColumns: parsed.ignoredColumns, summary, rows: present(rows), expiresInMinutes: IMPORT_TTL_MS / 60000 });
  });

  const ownImport = req => {
    sweep();
    const item = imports.get(req.params.id);
    return item && item.userId === String(req.user.id) && item.companyId === String(req.user.companyId) ? item : null;
  };

  router.get('/import/:id', ...corporateAdmin, (req, res) => {
    const item = ownImport(req);
    if (!item) return res.status(404).json({ message: 'This import has expired. Upload the file again.' });
    res.json({ importId: item.id, fileName: item.fileName, status: item.status, summary: item.summary, ...(item.result ? { result: item.result } : {}) });
  });

  // Confirms a validated import. The rows are checked again, since devices may have been
  // added since the preview; any problem stops the whole batch.
  router.post('/import/:id/confirm', ...corporateAdmin, async (req, res) => {
    const item = ownImport(req);
    if (!item) return res.status(404).json({ message: 'This import has expired. Upload the file again.' });
    if (item.status === 'imported') return res.status(409).json({ message: 'This file has already been imported.', result: item.result });
    if (item.status === 'importing') return res.status(409).json({ message: 'This import is already in progress.' });
    item.status = 'importing';
    try {
      const rows = await validate(item.rows, item.companyId);
      const summary = summaryOf(rows);
      if (summary.invalid) {
        item.status = 'validated';
        item.summary = summary;
        return res.status(summary.duplicates ? 409 : 400).json({ message: `${summary.invalid} row${summary.invalid === 1 ? ' has' : 's have'} problems, so nothing was imported. Fix the file and upload it again.`, summary, rows: present(rows) });
      }
      let inserted;
      try { inserted = await insertAll(rows.map(row => deviceDocument(row.values, item.companyId, DEVICE_SOURCES.EXCEL_IMPORT))); }
      catch (error) {
        item.status = 'validated';
        if (duplicateKey(error)) return res.status(409).json({ message: 'Some of these devices were registered while you were reviewing the file, so nothing was imported. Upload the file again to see which.' });
        throw error;
      }
      item.status = 'imported';
      item.result = { imported: inserted.length, importedAt: now(), devices: inserted.map((doc, index) => ({ row: rows[index].row, _id: doc._id, serialNumber: doc.serialNumber, model: doc.model })) };
      item.rows = [];
      res.status(201).json({ importId: item.id, status: item.status, summary, result: item.result });
    } catch (error) {
      if (item.status === 'importing') item.status = 'validated';
      throw error;
    }
  });

  return router;
}
