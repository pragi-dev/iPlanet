// Works out which region a B2C escalation belongs to: the serial number in the
// email is looked up in the portal's own `devices` collection, and the ticket
// goes to the region recorded on that device (its `location`). The customer's
// address, the sender's email and the wording of the email are never used.
// Pure functions: the service performs the database lookup and passes the
// matching device records in. Anything missing or ambiguous returns an explicit
// unresolved result so the ticket goes to triage instead of an assumed region.

// Same character rules as identifiers added by hand in triage.
const SERIAL_FORMAT = /^[A-Z0-9][\w./-]{0,59}$/;

export const normaliseSerial = value => String(value ?? '').trim().toUpperCase();
export const regionKey = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// The serial number to look up, from the ticket's identifiers.
export function serialFromIdentifiers(identifiers = []) {
  const serials = [...new Set(identifiers.filter(item => item.type === 'serialNumber').map(item => normaliseSerial(item.value)).filter(Boolean))];
  if (!serials.length) return { reason: 'serial_number_missing' };
  if (serials.length > 1) return { reason: 'multiple_serial_numbers', serials };
  if (!SERIAL_FORMAT.test(serials[0])) return { reason: 'serial_number_invalid', serial: serials[0] };
  return { serial: serials[0] };
}

// The region pre-defined on a device record.
export function resolveDeviceRegion(device) {
  const region = typeof device?.location === 'string' ? device.location.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  return region ? { resolved: true, region, reason: null } : { resolved: false, region: null, reason: 'device_region_missing' };
}

// `devices` are the records whose serial number equals `serial` (case-insensitive,
// exact). Returns the regionAssignment fields to store on the ticket.
export function assessDeviceRegion({ identifiers, devices = [] }) {
  const result = (status, extra = {}) => ({ status, region: null, source: null, reason: null, serialNumber: null, deviceId: null, model: null, ...extra });
  const { serial, reason } = serialFromIdentifiers(identifiers);
  if (reason) return result('unresolved', { reason, serialNumber: serial || null });
  const matches = devices.filter(device => normaliseSerial(device?.serialNumber) === serial);
  if (!matches.length) return result('unresolved', { serialNumber: serial, reason: 'serial_not_found' });
  if (matches.length > 1) return result('unresolved', { serialNumber: serial, reason: 'multiple_device_matches' });
  const [device] = matches;
  const found = { serialNumber: serial, deviceId: device._id || null, model: device.model || null };
  const resolution = resolveDeviceRegion(device);
  return resolution.resolved
    ? result('automatic', { ...found, region: resolution.region, source: 'device_location' })
    : result('unresolved', { ...found, reason: resolution.reason });
}
