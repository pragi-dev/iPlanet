// Form fields and checks, mirroring REGISTRATION_FIELDS and validateRegistration in
// backend/src/b2c/registration.js. Copied rather than imported so this app has no runtime
// dependency on the backend; the server repeats every check when it is connected.
// The backend also accepts an alternate phone number and a brand; this form does not ask for them.

export const FIELDS = {
  name: { label: 'Full name', required: true, max: 80 },
  email: { label: 'Email address', required: true, max: 254 },
  phone: { label: 'Mobile number', required: true, max: 20 },
  serialNumber: { label: 'Serial number', required: false, max: 60 },
  model: { label: 'Model', required: false, max: 60 },
  purchaseDate: { label: 'Purchase date', required: false, max: 10 },
  purchaseLocation: { label: 'Store or city of purchase', required: true, max: 120 },
  purchaseRegion: { label: 'Purchase region', required: false, max: 80 },
  dealer: { label: 'Dealer or retailer', required: false, max: 120 },
  invoiceNumber: { label: 'Invoice or order number', required: false, max: 40 },
};

export const SECTIONS = [
  { title: 'Customer information', description: 'How we can reach you about your support request.', fields: ['name', 'email', 'phone'] },
  { title: 'Mobile device', description: 'The device you are contacting support about.', fields: ['serialNumber', 'model'] },
  { title: 'Purchase information', description: 'Used to match your device with our purchase records.', fields: ['purchaseDate', 'purchaseLocation', 'purchaseRegion', 'dealer', 'invoiceNumber'] },
];

export const EMPTY_FORM = { ...Object.fromEntries(Object.keys(FIELDS).map(key => [key, ''])), confirm: false };

const VALID_EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const NAME = /^\p{L}[\p{L}\p{M} .'-]*$/u;
const SERIAL = /^[A-Z0-9][\w./-]{4,59}$/;
const INVOICE = /^[\w./ -]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_CHARS = /^[+\d][\d ()-]*$/;
const EARLIEST_PURCHASE = Date.UTC(2000, 0, 1);
const DAY = 86_400_000;

// Indian numbers may be written with +91 or a leading 0; international numbers have 10–15 digits.
function phoneDigits(value) {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');

export const todayIso = () => new Date().toISOString().slice(0, 10);

// Returns { field: message } for every problem; empty when the form can be submitted.
export function validate(form, { regions = [], now = new Date() } = {}) {
  const errors = {};
  const raw = Object.fromEntries(Object.keys(FIELDS).map(key => [key, clean(form[key])]));
  for (const [key, rule] of Object.entries(FIELDS)) {
    if (rule.required && !raw[key]) errors[key] = `${rule.label} is required.`;
    else if (raw[key].length > rule.max) errors[key] = `${rule.label} must be ${rule.max} characters or fewer.`;
  }
  if (!errors.name && (raw.name.length < 2 || !NAME.test(raw.name))) errors.name = 'Enter your full name using letters only.';
  if (!errors.email && !VALID_EMAIL.test(raw.email.toLowerCase())) errors.email = 'Enter a valid email address.';
  if (!errors.phone && !(PHONE_CHARS.test(raw.phone) && phoneDigits(raw.phone))) errors.phone = 'Enter a valid mobile number, e.g. +91 98765 43210.';
  // Serial number and purchase date are optional; checked only when given.
  if (!errors.serialNumber && raw.serialNumber && !SERIAL.test(raw.serialNumber.toUpperCase().replace(/\s+/g, ''))) errors.serialNumber = 'Enter the serial number exactly as shown on the device or invoice (letters and digits).';
  if (!errors.purchaseDate && raw.purchaseDate) {
    const date = DATE.test(raw.purchaseDate) ? new Date(`${raw.purchaseDate}T00:00:00Z`) : null;
    const valid = date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw.purchaseDate;
    if (!valid) errors.purchaseDate = 'Enter a valid purchase date, or leave it empty.';
    else if (date.getTime() > now.getTime() + DAY) errors.purchaseDate = 'The purchase date cannot be in the future.';
    else if (date.getTime() < EARLIEST_PURCHASE) errors.purchaseDate = 'Check the purchase date.';
  }
  if (!errors.purchaseLocation && raw.purchaseLocation.length < 2) errors.purchaseLocation = 'Enter the store or city where the device was bought.';
  if (!errors.purchaseRegion && raw.purchaseRegion && !regions.some(region => region.toLowerCase() === raw.purchaseRegion.toLowerCase())) errors.purchaseRegion = 'Choose a region from the list, or leave it empty.';
  if (!errors.invoiceNumber && raw.invoiceNumber && !INVOICE.test(raw.invoiceNumber)) errors.invoiceNumber = 'Use letters, digits and - . / only.';
  if (form.confirm !== true) errors.confirm = 'Confirm that the details are accurate.';
  return errors;
}

// The submission body, trimmed, in the shape the backend expects.
export const toPayload = form => ({ ...Object.fromEntries(Object.keys(FIELDS).map(key => [key, clean(form[key])])), confirm: form.confirm === true });
