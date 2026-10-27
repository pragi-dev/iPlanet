import crypto from 'node:crypto';
import { matchCustomer, normaliseEmail, normalisePhone } from './customerMatch.js';
import { normaliseSerial, regionKey, resolveDeviceRegion } from './deviceRegion.js';

// Customer registration: what a customer who could not be matched submits through the
// secure link, and whether it identifies them and their device. Pure functions: the service
// performs the database lookups and passes the records in.
//
// The link carries a random 256-bit token. Only its SHA-256 hash is stored (the token has
// full entropy, so no salt or slow hash is needed), and possession of the link proves
// nothing about who the customer is: every detail is checked against the device and
// customer records before the ticket uses it.

export const newRegistrationToken = () => crypto.randomBytes(32).toString('base64url');
export const hashRegistrationToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
// 32 bytes in base64url. Anything else is rejected before a database lookup.
export const isRegistrationToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

const VALID_EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const NAME = /^\p{L}[\p{L}\p{M} .'-]*$/u;
// Same character rules as serial numbers in emails and triage, at least 5 characters.
const SERIAL = /^[A-Z0-9][\w./-]{4,59}$/;
const INVOICE = /^[\w./ -]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EARLIEST_PURCHASE = Date.UTC(2000, 0, 1);
const DAY = 86_400_000;
const CONTROL = /[\u0000-\u001f\u007f]/g;

// The fields the form offers. Anything else in a submission (ticket, customer or request
// ids, ownership flags) is ignored: those come only from the stored request.
export const REGISTRATION_FIELDS = {
  name: { label: 'Full name', required: true, max: 80 },
  email: { label: 'Email address', required: true, max: 254 },
  phone: { label: 'Mobile number', required: true, max: 20 },
  alternatePhone: { label: 'Alternate phone number', required: false, max: 20 },
  serialNumber: { label: 'Serial number', required: false, max: 60 },
  brand: { label: 'Brand', required: false, max: 40 },
  model: { label: 'Model', required: false, max: 60 },
  purchaseDate: { label: 'Purchase date', required: false, max: 10 },
  purchaseLocation: { label: 'Store or city of purchase', required: true, max: 120 },
  purchaseRegion: { label: 'Purchase region', required: false, max: 80 },
  dealer: { label: 'Dealer or retailer', required: false, max: 120 },
  invoiceNumber: { label: 'Invoice or order number', required: false, max: 40 },
};

// A phone number in the form the customer records use (+ and 10–15 digits).
const storedPhone = digits => (digits.length === 10 ? `+91${digits}` : `+${digits}`);

// Returns { values, errors }: errors maps a field to a message; values is set only when
// there are none. `regions` are the regions defined on device records.
export function validateRegistration(input = {}, { regions = [], now = new Date() } = {}) {
  const errors = {};
  const text = field => (typeof input?.[field] === 'string' ? input[field].replace(CONTROL, ' ').trim().replace(/\s+/g, ' ') : '');
  const raw = Object.fromEntries(Object.keys(REGISTRATION_FIELDS).map(field => [field, text(field)]));
  for (const [field, rule] of Object.entries(REGISTRATION_FIELDS)) {
    if (rule.required && !raw[field]) errors[field] = `${rule.label} is required.`;
    else if (raw[field].length > rule.max) errors[field] = `${rule.label} must be ${rule.max} characters or fewer.`;
  }
  const values = {};
  if (!errors.name) {
    if (raw.name.length < 2 || !NAME.test(raw.name)) errors.name = 'Enter your full name using letters only.';
    else values.name = raw.name;
  }
  if (!errors.email) {
    const email = normaliseEmail(raw.email);
    if (!VALID_EMAIL.test(email)) errors.email = 'Enter a valid email address.';
    else values.email = email;
  }
  if (!errors.phone) {
    const digits = normalisePhone(raw.phone);
    if (!digits || !/^[+\d][\d ()-]*$/.test(raw.phone)) errors.phone = 'Enter a valid mobile number, e.g. +91 98765 43210.';
    else values.phone = storedPhone(digits);
  }
  if (!errors.alternatePhone && raw.alternatePhone) {
    const digits = normalisePhone(raw.alternatePhone);
    if (!digits || !/^[+\d][\d ()-]*$/.test(raw.alternatePhone)) errors.alternatePhone = 'Enter a valid phone number or leave it empty.';
    else if (values.phone && storedPhone(digits) === values.phone) errors.alternatePhone = 'The alternate number must differ from the mobile number.';
    else values.alternatePhone = storedPhone(digits);
  }
  // Optional; checked only when given.
  if (!errors.serialNumber && raw.serialNumber) {
    const serial = normaliseSerial(raw.serialNumber).replace(/\s+/g, '');
    if (!SERIAL.test(serial)) errors.serialNumber = 'Enter the serial number exactly as shown on the device or invoice (letters and digits).';
    else values.serialNumber = serial;
  }
  if (!errors.purchaseDate && raw.purchaseDate) {
    const date = DATE.test(raw.purchaseDate) ? new Date(`${raw.purchaseDate}T00:00:00Z`) : null;
    const valid = date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw.purchaseDate;
    // A day's grace for time zones.
    if (!valid) errors.purchaseDate = 'Enter a valid purchase date, or leave it empty.';
    else if (date.getTime() > now.getTime() + DAY) errors.purchaseDate = 'The purchase date cannot be in the future.';
    else if (date.getTime() < EARLIEST_PURCHASE) errors.purchaseDate = 'Check the purchase date.';
    else values.purchaseDate = date;
  }
  if (!errors.purchaseLocation) {
    if (raw.purchaseLocation.length < 2) errors.purchaseLocation = 'Enter the store or city where the device was bought.';
    else values.purchaseLocation = raw.purchaseLocation;
  }
  if (!errors.purchaseRegion && raw.purchaseRegion) {
    // Only a region defined on the device records; never free text.
    const region = regions.find(name => regionKey(name) === regionKey(raw.purchaseRegion));
    if (!region) errors.purchaseRegion = 'Choose a region from the list, or leave it empty.';
    else values.purchaseRegion = region;
  }
  if (!errors.invoiceNumber && raw.invoiceNumber) {
    if (!INVOICE.test(raw.invoiceNumber)) errors.invoiceNumber = 'Use letters, digits and - . / only.';
    else values.invoiceNumber = raw.invoiceNumber;
  }
  for (const field of ['brand', 'model', 'dealer']) if (!errors[field] && raw[field]) values[field] = raw[field];
  if (input?.confirm !== true) errors.confirm = 'Confirm that the details are accurate.';
  return Object.keys(errors).length ? { errors } : { values };
}

const CUSTOMER_REVIEW = { insufficient: 'customer_details_partial_match', ambiguous: 'customer_ambiguous', conflict: 'customer_identifiers_conflict' };

// Decides what a valid submission identifies. `devices`: device records with the submitted
// serial number; `serialOwners`: customer records registered with it; `candidates`: customer
// records found by the submitted email and phone numbers.
// Returns { status: 'verified' | 'review', reason, customerRecord, customer, device, region, checks }:
// - 'existing': the serial number is already registered to this person; their record is used.
// - 'linked': this person is a registered customer (two details match) and the device is
//   unregistered; a purchase record is added with their stored details, never the submitted ones.
// - 'created': nobody matches any detail; a new customer record is created from the submission.
// Anything else ('review') goes to a B2C admin: an unknown or duplicated serial number, a
// purchase region or date that contradicts the device record, a device registered to
// someone else, or details that partly match an existing customer (which could otherwise
// become a duplicate record). A device record without a region still verifies the customer:
// `region` is then null (with check 'device_region_missing') and the ticket goes to manual
// triage; the region the customer states is never used in its place.
// The serial number and purchase date are optional. Without a serial number there is no
// device, so no region: a registered customer (two details match) is verified with their
// stored record and the ticket goes to manual triage; anyone else goes to review, since a new
// purchase record needs the serial number. A purchase date is compared only when given.
export function resolveRegistration({ values, devices = [], serialOwners = [], candidates = [], toleranceDays = 7 }) {
  const checks = [];
  const review = (reason, extra = {}) => ({ status: 'review', reason, customerRecord: null, customer: null, device: null, region: null, checks, ...extra });
  const serial = values.serialNumber;
  if (!serial) {
    const match = matchCustomer({ candidates, names: [values.name], emails: [values.email], phones: [values.phone, values.alternatePhone].filter(Boolean) });
    if (match.status !== 'matched') return review(match.status === 'not_found' ? 'serial_number_missing' : CUSTOMER_REVIEW[match.status] || 'customer_details_partial_match');
    checks.push('customer_matched', ...match.matchedBy.map(field => `matched_${field}`));
    return { status: 'verified', reason: null, customerRecord: 'existing', customer: match.records[0], records: match.records, device: null, region: null, checks };
  }
  const matches = devices.filter(device => normaliseSerial(device?.serialNumber) === serial);
  if (!matches.length) return review('serial_not_found');
  if (matches.length > 1) return review('multiple_device_matches');
  const [device] = matches;
  checks.push('device_found');
  const region = resolveDeviceRegion(device);
  if (!region.resolved) checks.push('device_region_missing');
  // The region is the device record's: a stated region only confirms it.
  else if (values.purchaseRegion) {
    if (regionKey(values.purchaseRegion) !== regionKey(region.region)) return review('purchase_region_mismatch', { device, region: region.region });
    checks.push('purchase_region_confirmed');
  }
  if (device.purchaseDate && values.purchaseDate) {
    const difference = Math.abs(new Date(device.purchaseDate).getTime() - values.purchaseDate.getTime());
    if (!(difference <= toleranceDays * DAY)) return review('purchase_date_mismatch', { device, region: region.region });
    checks.push('purchase_date_confirmed');
  }
  const found = { device, region: region.region };

  const match = matchCustomer({ candidates, names: [values.name], emails: [values.email], phones: [values.phone, values.alternatePhone].filter(Boolean), serial, serialOwners });
  const owns = record => normaliseSerial(record.deviceSerialNumber) === serial;
  if (serialOwners.some(owns)) {
    // Registered already: only to the same person, identified by the serial number plus a detail.
    const own = match.status === 'matched' ? match.records.find(owns) : null;
    if (!own) return review('serial_registered_to_other_customer', found);
    checks.push('customer_matched', ...match.matchedBy.map(field => `matched_${field}`));
    return { status: 'verified', reason: null, customerRecord: 'existing', customer: own, records: match.records, checks, ...found };
  }
  if (match.status === 'matched') {
    const [person] = match.records;
    checks.push('customer_matched', ...match.matchedBy.map(field => `matched_${field}`));
    return { status: 'verified', reason: null, customerRecord: 'linked', customer: { name: person.name, email: person.email, mobileNumber: person.mobileNumber, deviceSerialNumber: serial }, records: match.records, checks, ...found };
  }
  if (match.status !== 'not_found') return review(CUSTOMER_REVIEW[match.status] || 'customer_details_partial_match', found);
  checks.push('new_customer');
  return { status: 'verified', reason: null, customerRecord: 'created', customer: { name: values.name, email: values.email, mobileNumber: values.phone, deviceSerialNumber: serial }, records: [], checks, ...found };
}
