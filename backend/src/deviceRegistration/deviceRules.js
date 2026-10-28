// Field rules for devices a corporate admin registers, shared by the manual form and the
// Excel import so both apply exactly the same validation. Only fields that exist on the
// Device model are accepted. Employee details are intentionally not collected: they are
// not shown anywhere in the portals.

export const DEVICE_TYPES = ['MacBook', 'iMac', 'Mac mini', 'Mac Studio', 'iPhone', 'iPad', 'Apple Watch', 'Other'];
export const ASSIGNMENT_STATUSES = ['Unassigned', 'Assigned'];
// Coverage that ends within this many days is shown as "Expiring Soon".
export const EXPIRING_SOON_DAYS = 60;

// Same shape the rest of the app treats as a serial: capitals, digits and hyphens, with
// at least one letter and one digit.
const SERIAL_PATTERN = /^[A-Z0-9-]{6,20}$/;
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;
// For an already upper-cased, trimmed serial.
export const isValidSerial = serial => SERIAL_PATTERN.test(serial) && /[A-Z]/.test(serial) && /[0-9]/.test(serial);

// Field order is the column order listed for Excel imports.
export const DEVICE_FIELDS = [
  { key: 'model', label: 'Device Model', required: true, hint: 'For example MacBook Air M3. Up to 80 characters.' },
  { key: 'deviceType', label: 'Device Type', required: true, hint: `One of: ${DEVICE_TYPES.join(', ')}.` },
  { key: 'serialNumber', label: 'Serial Number', required: true, hint: '6 to 20 letters, digits or hyphens, with at least one letter and one digit. Must not already be registered.' },
  { key: 'assetId', label: 'Asset ID', required: false, hint: 'Your internal asset tag. Must be unique within your organization.' },
  { key: 'location', label: 'Location', required: false, hint: 'An iPlanet service location. Leave blank to use your organization\'s location.' },
  { key: 'deviceAllocationStatus', label: 'Assignment Status', required: false, hint: 'Assigned or Unassigned. Defaults to Unassigned.' },
  { key: 'purchaseDate', label: 'Purchase Date', required: false, hint: 'Date as YYYY-MM-DD or DD-MM-YYYY. Cannot be in the future.' },
  { key: 'warrantyExpiry', label: 'Warranty End Date', required: false, hint: 'Leave blank if unknown. Warranty status is worked out from this date.' },
  { key: 'amcExpiry', label: 'AMC End Date', required: false, hint: 'Leave blank if there is no AMC or it is unknown.' },
];

const MS_PER_DAY = 86400000;
const startOfUtcDay = date => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

// Accepts a Date (from an Excel date cell) or a YYYY-MM-DD / DD-MM-YYYY / DD/MM/YYYY string.
// Returns a UTC-midnight Date, null for blank, or undefined when the value is not a real date.
export function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : new Date(startOfUtcDay(value));
  const raw = text(value);
  if (!raw) return null;
  let year; let month; let day;
  let match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, year, month, day] = match.map(Number);
  else if ((match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) [, day, month, year] = match.map(Number);
  else return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
}

// Coverage status from an end date; no date means the status is unknown, not invented.
export function coverageStatus(expiry, now = new Date()) {
  if (!expiry) return undefined;
  const days = (startOfUtcDay(expiry) - startOfUtcDay(now)) / MS_PER_DAY;
  if (days < 0) return 'Expired';
  return days <= EXPIRING_SOON_DAYS ? 'Expiring Soon' : 'Active';
}

const pick = (value, options) => options.find(option => option.toLowerCase() === text(value).toLowerCase());

// Validates one device's input. `locations` is the list of known service locations.
// Returns { values, errors } where errors is [{ field, message }].
export function normalizeDevice(input = {}, { locations = [], defaultLocation = '', now = new Date() } = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const values = {};

  const model = text(input.model);
  if (!model) fail('model', 'Device model is required.');
  else if (model.length > 80) fail('model', 'Device model must be 80 characters or fewer.');
  else values.model = model;

  if (!text(input.deviceType)) fail('deviceType', 'Device type is required.');
  else {
    const deviceType = pick(input.deviceType, DEVICE_TYPES);
    if (deviceType) values.deviceType = deviceType;
    else fail('deviceType', `Device type must be one of: ${DEVICE_TYPES.join(', ')}.`);
  }

  const serialNumber = text(input.serialNumber).toUpperCase();
  if (!serialNumber) fail('serialNumber', 'Serial number is required.');
  else if (!isValidSerial(serialNumber)) fail('serialNumber', 'Serial number must be 6 to 20 letters, digits or hyphens, with at least one letter and one digit.');
  else values.serialNumber = serialNumber;

  const assetId = text(input.assetId);
  if (assetId) {
    if (ASSET_ID_PATTERN.test(assetId)) values.assetId = assetId;
    else fail('assetId', 'Asset ID can use up to 40 letters, digits, dots, slashes, underscores or hyphens.');
  }

  if (text(input.location)) {
    const location = pick(input.location, locations);
    if (location) values.location = location;
    else fail('location', `Location must be one of: ${locations.join(', ')}.`);
  } else if (defaultLocation) values.location = defaultLocation;

  if (text(input.deviceAllocationStatus)) {
    const status = pick(input.deviceAllocationStatus, ASSIGNMENT_STATUSES);
    if (status) values.deviceAllocationStatus = status;
    else fail('deviceAllocationStatus', 'Assignment status must be Assigned or Unassigned.');
  } else values.deviceAllocationStatus = 'Unassigned';

  for (const [field, label] of [['purchaseDate', 'Purchase date'], ['warrantyExpiry', 'Warranty end date'], ['amcExpiry', 'AMC end date']]) {
    const date = parseDate(input[field]);
    if (date === undefined) fail(field, `${label} must be a valid date (YYYY-MM-DD or DD-MM-YYYY).`);
    else if (date) values[field] = date;
  }
  if (values.purchaseDate && startOfUtcDay(values.purchaseDate) > startOfUtcDay(now)) fail('purchaseDate', 'Purchase date cannot be in the future.');
  if (values.purchaseDate && values.warrantyExpiry && values.warrantyExpiry < values.purchaseDate) fail('warrantyExpiry', 'Warranty end date cannot be before the purchase date.');

  if (values.warrantyExpiry) values.warrantyStatus = coverageStatus(values.warrantyExpiry, now);
  if (values.amcExpiry) values.amcStatus = coverageStatus(values.amcExpiry, now);
  return { values, errors };
}

const key = value => String(value).toLowerCase();

// Duplicate serial numbers and asset IDs, both within the batch and against the database.
// Serials are unique across iPlanet; asset IDs are unique within an organization.
// `rows` are [{ row, values, errors }]; conflicts are appended to each row's errors.
export async function findDuplicates(rows, { Device, companyId }) {
  const firstRowBySerial = new Map();
  const firstRowByAsset = new Map();
  for (const item of rows) {
    const { serialNumber, assetId } = item.values;
    if (serialNumber) {
      const seen = firstRowBySerial.get(key(serialNumber));
      if (seen) item.errors.push({ field: 'serialNumber', duplicate: 'file', message: `Serial number ${serialNumber} is also on row ${seen}.` });
      else firstRowBySerial.set(key(serialNumber), item.row);
    }
    if (assetId) {
      const seen = firstRowByAsset.get(key(assetId));
      if (seen) item.errors.push({ field: 'assetId', duplicate: 'file', message: `Asset ID ${assetId} is also on row ${seen}.` });
      else firstRowByAsset.set(key(assetId), item.row);
    }
  }
  const serials = [...firstRowBySerial.keys()];
  const assets = [...firstRowByAsset.keys()];
  const caseInsensitive = { locale: 'en', strength: 2 };
  const [serialMatches, assetMatches] = await Promise.all([
    serials.length ? Device.find({ serialNumber: { $in: serials } }).collation(caseInsensitive).select('serialNumber companyId').lean() : [],
    assets.length ? Device.find({ companyId, assetId: { $in: assets } }).collation(caseInsensitive).select('assetId').lean() : [],
  ]);
  const existingSerials = new Map(serialMatches.map(device => [key(device.serialNumber), device]));
  const existingAssets = new Set(assetMatches.map(device => key(device.assetId)));
  for (const item of rows) {
    const { serialNumber, assetId } = item.values;
    const device = serialNumber && existingSerials.get(key(serialNumber));
    // Another organization's device is reported without revealing whose it is.
    if (device) item.errors.push({ field: 'serialNumber', duplicate: 'database', message: String(device.companyId) === String(companyId) ? `Serial number ${serialNumber} is already in your devices.` : `Serial number ${serialNumber} is already registered with iPlanet. Contact iPlanet Service if this device belongs to you.` });
    if (assetId && existingAssets.has(key(assetId))) item.errors.push({ field: 'assetId', duplicate: 'database', message: `Asset ID ${assetId} is already used by another of your devices.` });
  }
  return rows;
}

// The Device document for a validated device, owned by the admin's organization.
// `deviceSource` is chosen by the route that registers it, never by the input.
export function deviceDocument(values, companyId, deviceSource) {
  return { ...values, companyId, deviceSource, selectedEntityType: 'corporate', selectedEntityId: companyId, deviceStatus: 'In Use' };
}
