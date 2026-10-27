import { assessDeviceRegion, normaliseSerial, serialFromIdentifiers } from './deviceRegion.js';

// Decides which registered customer a B2C email is about, which device it concerns,
// and so the region it is routed to. A customer is identified only when at least two
// independent details point to the same Customer record: two of name, email address and
// phone number, or the email's serial number registered on that record plus one of them.
// One detail alone never identifies anyone, and details pointing to different people
// identify nobody. The serial number has priority for the region: a serial number on a
// device record routes the ticket to that device's region, unless it is not the
// identified customer's. Without a serial number, the identified customer's only
// registered device is used. Pure functions: the service performs the database lookups
// and passes the records in. Anything missing or ambiguous returns an explicit
// unresolved result so the ticket goes to triage instead of an assumed customer, device
// or region.
//
// Each purchase is its own Customer record (one deviceSerialNumber each), so records
// with the same email and mobile number are one person with several devices.

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// A phone number counts only after a label ("Mobile: …") or in international "+" form,
// so order numbers and other long digit runs are not mistaken for one.
const PHONE_IN_TEXT = /(?:\b(?:phone|mobile|mob|cell|tel|telephone|contact|whatsapp)\s*(?:no\.?|number|#)?\s*[:#-]?\s*(\+?\d[\d ()-]{8,18}\d)|(\+\d[\d ()-]{8,18}\d))/gi;
// A name in the message counts only on its own labelled line ("Name: …", "Customer name: …").
const NAME_IN_TEXT = /^[ \t]*(?:customer[ \t]+name|full[ \t]+name|name)[ \t]*[:-][ \t]*([^\n]{2,80})$/gim;
const SCAN_LIMIT = 20_000;
const MAX_CANDIDATES = 5;

// Phone numbers are compared as digits. An Indian number is reduced to its 10 digits,
// so +91 98765 43210, 098765 43210 and 9876543210 are the same number. Any other country
// code is kept, so numbers with different country codes never compare equal.
export function normalisePhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}
export const normaliseEmail = value => String(value ?? '').trim().toLowerCase();
// Names are compared whole and exactly: only spacing, letter case and a trailing full stop
// are ignored. No partial or "sounds like" matching.
export const normaliseName = value => String(value ?? '').normalize('NFKC').trim().replace(/[.,;]+$/, '').replace(/\s+/g, ' ').toLowerCase();

// The customer details an email offers: the sender's address and display name, and any
// email address, phone number or labelled name written in it. The sender is not assumed
// to be the purchaser: a relative or dealer may write for them, so details in the
// message count too.
export function extractContacts({ from, fromName = '', subject = '', body = '', ignore = [] }) {
  const text = `${String(subject).slice(0, 1000)}\n${String(body).slice(0, SCAN_LIMIT)}`;
  const skip = new Set([from, ...ignore].map(normaliseEmail));
  const emails = [...new Set((text.match(EMAIL_IN_TEXT) || []).map(normaliseEmail))].filter(item => !skip.has(item)).slice(0, MAX_CANDIDATES);
  const phones = [...new Set([...text.matchAll(PHONE_IN_TEXT)].map(match => normalisePhone(match[1] || match[2])).filter(Boolean))].slice(0, MAX_CANDIDATES);
  const labelled = [...String(body).slice(0, SCAN_LIMIT).matchAll(NAME_IN_TEXT)].map(match => match[1]);
  const names = [...new Set([fromName, ...labelled].map(normaliseName).filter(name => name.length >= 2 && !name.includes('@')))].slice(0, MAX_CANDIDATES);
  return { senderEmail: from ? normaliseEmail(from) : null, emails, phones, names };
}

const personKey = record => `${normaliseEmail(record.email)}|${normalisePhone(record.mobileNumber) || ''}`;
const FIELDS = ['name', 'email', 'phone'];
const FIELD_VALUE = { name: record => normaliseName(record.name), email: record => normaliseEmail(record.email), phone: record => normalisePhone(record.mobileNumber) };

// `candidates` are the Customer records found by the email's addresses and phone numbers;
// `serialOwners` those registered with the email's serial number `serial`. Names are only
// compared with these records, never searched. Statuses: 'matched' (the person's records
// are returned); 'insufficient': details found someone, but fewer than two on one record;
// 'ambiguous': more than one person qualifies; 'conflict': details point to different
// people; 'not_found'. Nothing about an unmatched person is returned.
export function matchCustomer({ candidates = [], names = [], emails = [], phones = [], serial = null, serialOwners = [] } = {}) {
  const none = status => ({ status, method: null, matchedBy: [], records: [] });
  const evidence = {
    name: [...new Set(names.map(normaliseName).filter(Boolean))],
    email: [...new Set(emails.map(normaliseEmail).filter(Boolean))],
    phone: [...new Set(phones.map(normalisePhone).filter(Boolean))],
  };
  const records = [...new Map([...candidates, ...serialOwners].map(record => [String(record._id), record])).values()];
  const ownsSerial = record => Boolean(serial) && normaliseSerial(record.deviceSerialNumber) === normaliseSerial(serial);
  // A field counts once per record, however many of the email's values it matches.
  const fieldsOf = record => FIELDS.filter(field => { const value = FIELD_VALUE[field](record); return Boolean(value) && evidence[field].includes(value); });

  // Each detail in the email that found someone, and the people (person keys) it found.
  const details = [
    ...FIELDS.flatMap(field => evidence[field].map(value => ({ field, people: new Set(records.filter(record => FIELD_VALUE[field](record) === value).map(personKey)) }))),
    ...(serial ? [{ field: 'serial', people: new Set(records.filter(ownsSerial).map(personKey)) }] : []),
  ].filter(item => item.people.size);

  const byContacts = new Set(records.filter(record => fieldsOf(record).length >= 2).map(personKey));
  const bySerial = new Set(records.filter(record => ownsSerial(record) && fieldsOf(record).length >= 1).map(personKey));
  const qualified = new Set([...byContacts, ...bySerial]);
  if (qualified.size > 1) return none('ambiguous');
  if (!qualified.size) {
    // Two details with nobody in common describe different people.
    const disjoint = details.some((a, index) => details.slice(index + 1).some(b => ![...a.people].some(key => b.people.has(key))));
    if (disjoint) return none('conflict');
    return none(details.some(item => item.field !== 'serial') ? 'insufficient' : 'not_found');
  }
  const [key] = qualified;
  // Every contact detail that found someone must also fit the identified person. A serial
  // number that is someone else's is judged by assessCustomerRegion (serial_customer_conflict).
  if (details.some(item => item.field !== 'serial' && !item.people.has(key))) return none('conflict');
  const own = records.filter(record => personKey(record) === key).sort((a, b) => (a.customerId ?? 0) - (b.customerId ?? 0));
  const matchedBy = [...FIELDS.filter(field => own.some(record => fieldsOf(record).includes(field))), ...(own.some(ownsSerial) ? ['serial'] : [])];
  return { status: 'matched', method: byContacts.has(key) ? 'contact_details' : 'serial_and_contact', matchedBy, records: own };
}

export const registeredSerials = match => [...new Set((match.records || []).map(record => normaliseSerial(record.deviceSerialNumber)).filter(Boolean))];

// The serial number whose device records assessCustomerRegion needs: the email's when it
// gives one, otherwise the matched customer's only registered device. Null when there is
// nothing to look up.
export function serialForLookup({ match, identifiers = [] }) {
  const { serial, reason } = serialFromIdentifiers(identifiers);
  if (serial) return serial;
  if (reason !== 'serial_number_missing' || match.status !== 'matched') return null;
  const registered = registeredSerials(match);
  return registered.length === 1 ? registered[0] : null;
}

// Whether the email's serial number is registered to the sender. `serialOwners` are the
// Customer records with that serial number. Another owner is never named.
// 'verified' | 'customer_not_matched' | 'other_customer' | 'not_registered'
export function ownerCheck({ match, serial, serialOwners = [] }) {
  if (match.status !== 'matched') return 'customer_not_matched';
  if (registeredSerials(match).includes(serial)) return 'verified';
  return serialOwners.some(owner => normaliseSerial(owner.deviceSerialNumber) === serial) ? 'other_customer' : 'not_registered';
}

const CUSTOMER_REASONS = { not_found: 'customer_not_found', insufficient: 'customer_match_insufficient', ambiguous: 'customer_ambiguous', conflict: 'customer_identifiers_conflict' };

// Which device and region the ticket gets. `match` comes from matchCustomer; `devices` are
// the device records with the serial number from serialForLookup; `serialOwners` are the
// Customer records with the email's serial number.
export function assessCustomerRegion({ match, identifiers = [], serialOwners = [], devices = [] }) {
  const { serial: emailSerial, reason: serialReason } = serialFromIdentifiers(identifiers);
  const result = (status, extra = {}) => ({ status, region: null, source: null, reason: null, serialNumber: emailSerial || null, emailSerialNumber: emailSerial || null, deviceId: null, model: null, ownerCheck: null, ...extra });
  if (serialReason && serialReason !== 'serial_number_missing') return result('unresolved', { reason: serialReason });

  // The email's serial number decides the device and the region, once it is on a device
  // record and does not contradict who the customer is.
  if (emailSerial) {
    const device = { ...assessDeviceRegion({ identifiers: [{ type: 'serialNumber', value: emailSerial }], devices }), emailSerialNumber: emailSerial, ownerCheck: ownerCheck({ match, serial: emailSerial, serialOwners }) };
    const unresolved = reason => ({ ...device, status: 'unresolved', region: null, source: null, reason });
    // Details that point to different people, or to several, are for a person to decide.
    if (match.status === 'ambiguous' || match.status === 'conflict') return unresolved(CUSTOMER_REASONS[match.status]);
    if (device.status !== 'automatic') return device;
    // An identified customer quoting a serial number that is not theirs.
    if (device.ownerCheck === 'other_customer' || device.ownerCheck === 'not_registered') return unresolved('serial_customer_conflict');
    return device;
  }
  // No serial number: the matched customer's only registered device.
  if (match.status !== 'matched') return result('unresolved', { reason: CUSTOMER_REASONS[match.status] });
  const registered = registeredSerials(match);
  if (registered.length !== 1) return result('unresolved', { reason: registered.length ? 'customer_device_ambiguous' : 'customer_has_no_device' });
  const device = assessDeviceRegion({ identifiers: [{ type: 'serialNumber', value: registered[0] }], devices });
  return { ...device, reason: device.reason === 'serial_not_found' ? 'registered_device_not_found' : device.reason, emailSerialNumber: null, ownerCheck: 'verified' };
}
