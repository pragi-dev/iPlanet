// Mirrors backend/src/accountRequests/accountRequestRules.js so mistakes are shown
// before submitting. The API applies the same rules and is the one that counts.
export const PASSWORD_MIN_LENGTH = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{6,18}[0-9]$/;
const GST_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const passwordChecks = password => [
  { key: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters`, met: password.length >= PASSWORD_MIN_LENGTH && password.length <= 128 },
  { key: 'case', label: 'Upper and lower case letters', met: /[a-z]/.test(password) && /[A-Z]/.test(password) },
  { key: 'number', label: 'At least one number', met: /[0-9]/.test(password) },
];

export function validateSignup(form) {
  const errors = {};
  const name = form.name.trim();
  const email = form.email.trim();
  const organization = form.organization.trim();
  const phone = form.phone.trim();
  const gstNumber = form.gstNumber.replace(/\s/g, '').toUpperCase();
  if (name.length < 2 || name.length > 100) errors.name = 'Enter your full name.';
  if (!EMAIL_PATTERN.test(email) || email.length > 254) errors.email = 'Enter a valid work email address.';
  if (!PHONE_PATTERN.test(phone)) errors.phone = 'Enter a valid mobile number.';
  if (organization.length < 2 || organization.length > 120) errors.organization = 'Enter your organization name.';
  if (!GST_PATTERN.test(gstNumber)) errors.gstNumber = 'Enter a valid 15-character GSTIN.';
  if (!form.password) errors.password = 'Enter a password.';
  else if (passwordChecks(form.password).some(check => !check.met)) errors.password = 'Password does not meet the requirements below.';
  if (!errors.password && form.confirmPassword !== form.password) errors.confirmPassword = 'Passwords do not match.';
  return errors;
}
