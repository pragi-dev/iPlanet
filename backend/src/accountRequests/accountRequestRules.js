// Field rules for self-service sign-up. The portal UI applies the same rules
// (frontend/src/auth/signupValidation.js) but only this copy is authoritative.

// Corporate sign-ups become a request an iPlanet Service user approves. iPlanet Service
// sign-ups are active at once, but only for emails on a configured company domain.
export const SELF_SERVICE_ACCOUNT_TYPES = ['corporate', 'service'];
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{6,18}[0-9]$/;
// GSTIN: state code, PAN, entity number, 'Z', check character.
export const GST_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// SERVICE_SIGNUP_EMAIL_DOMAINS, e.g. "iplanet.in, iplanet.co.in". Empty means nobody may sign up for service.
export const parseEmailDomains = value => String(value || '').split(',').map(domain => domain.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
export const isServiceEmailAllowed = (email, domains) => domains.includes(String(email).toLowerCase().split('@').pop());

const text = value => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '');

export function passwordProblems(password) {
  if (typeof password !== 'string' || !password) return ['Enter a password.'];
  const problems = [];
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`Use ${PASSWORD_MAX_LENGTH} characters or fewer.`);
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) problems.push('Include upper and lower case letters.');
  if (!/[0-9]/.test(password)) problems.push('Include a number.');
  return problems;
}

// Reads only the fields sign-up accepts. Anything else in the request — role,
// companyId, status and so on — is ignored, so it can never reach the database.
export function normalizeAccountRequest(body = {}) {
  const values = {
    accountType: text(body.accountType).toLowerCase() || 'corporate',
    name: text(body.name),
    email: text(body.email).toLowerCase(),
    phone: text(body.phone),
    organization: text(body.organization),
    gstNumber: text(body.gstNumber).replace(/\s/g, '').toUpperCase(),
  };
  const errors = {};
  if (values.name.length < 2 || values.name.length > 100) errors.name = 'Enter your full name.';
  if (!EMAIL_PATTERN.test(values.email) || values.email.length > 254) errors.email = 'Enter a valid email address.';
  if (!PHONE_PATTERN.test(values.phone)) errors.phone = 'Enter a valid mobile number.';
  if (values.organization.length < 2 || values.organization.length > 120) errors.organization = 'Enter your organization name.';
  if (!GST_PATTERN.test(values.gstNumber)) errors.gstNumber = 'Enter a valid 15-character GSTIN.';
  const problems = passwordProblems(body.password);
  if (problems.length) errors.password = problems.join(' ');
  else if (body.confirmPassword !== body.password) errors.confirmPassword = 'Passwords do not match.';
  return { values, password: typeof body.password === 'string' ? body.password : '', errors };
}
