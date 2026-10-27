// Removes personal and secret data from text before it is logged or stored
// as an error/audit detail. Ticket fields that staff need (customer email,
// phone) are stored as data, never copied into logs.
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?<![\w-])\+?\d[\d\s-]{8,}\d(?![\w-])/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PARAM = /\b(client_secret|access_token|refresh_token|password|code)=([^&\s]+)/gi;

export function maskEmail(value = '') {
  const [local, domain] = String(value).split('@');
  if (!domain) return '[redacted]';
  return `${local.slice(0, 1)}***@${domain}`;
}

export function redactText(value, max = 500) {
  if (value === undefined || value === null) return value;
  return String(value)
    .replace(BEARER, '$1 [redacted]')
    .replace(SECRET_PARAM, '$1=[redacted]')
    .replace(EMAIL, match => maskEmail(match))
    .replace(PHONE, '[phone]')
    .slice(0, max);
}

// Shallow-redacts an object of audit details. Keys that hold content the
// customer wrote are dropped entirely rather than masked.
const DROP_KEYS = new Set(['body', 'bodyText', 'content', 'password', 'token', 'secret']);
export function redactDetails(details = {}) {
  const result = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (DROP_KEYS.has(key)) continue;
    if (typeof value === 'string') result[key] = redactText(value, 300);
    else if (Array.isArray(value)) result[key] = value.slice(0, 20).map(item => (typeof item === 'string' ? redactText(item, 120) : item));
    else result[key] = value;
  }
  return result;
}

export function safeErrorMessage(error) {
  return redactText(error?.message || String(error || 'Unknown error'), 300);
}
