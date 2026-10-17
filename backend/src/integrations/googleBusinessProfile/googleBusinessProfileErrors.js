// Classifies Google API failures into categories the portal can act on.
// Google returns errors as { error: { code, message, status, details: [...] } };
// the google.rpc.ErrorInfo detail carries a machine-readable `reason` and, for
// quota errors, `metadata.quota_limit_value`. A quota limit of "0" means the
// project has not been granted Business Profile API access — retrying or
// raising the quota manually does not fix that, so it is not treated as a
// transient rate limit.

export const GOOGLE_ERROR_CATEGORIES = {
  NOT_CONFIGURED: 'not_configured',
  NOT_CONNECTED: 'not_connected',
  ACCESS_PENDING: 'access_pending',
  RATE_LIMITED: 'rate_limited',
  API_DISABLED: 'api_disabled',
  PERMISSION_DENIED: 'permission_denied',
  INSUFFICIENT_SCOPE: 'insufficient_scope',
  TOKEN_EXPIRED: 'token_expired',
  RECONNECT_REQUIRED: 'reconnect_required',
  INVALID_CLIENT: 'invalid_client',
  NOT_FOUND: 'not_found',
  INVALID_REQUEST: 'invalid_request',
  TRANSIENT: 'transient',
  UNKNOWN: 'unknown',
};

const C = GOOGLE_ERROR_CATEGORIES;

// Messages shown in the Service Portal. They never include Google's raw
// response, which can echo identifiers or request content.
export const GOOGLE_ERROR_MESSAGES = {
  [C.NOT_CONFIGURED]: 'Google OAuth is not configured on the backend. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI and GOOGLE_BUSINESS_SCOPE.',
  [C.NOT_CONNECTED]: 'Google Business Profile is not connected.',
  [C.ACCESS_PENDING]: 'Google authentication is connected, but Google has not granted the API quota required to retrieve business accounts and reviews. Complete the required Google Business Profile API access approval.',
  [C.RATE_LIMITED]: 'Google is temporarily limiting requests. Try again shortly.',
  [C.API_DISABLED]: 'A required Google Business Profile API is not enabled for this Google Cloud project. Enable it in the Google Cloud console.',
  [C.PERMISSION_DENIED]: 'The connected Google account does not have permission for this Business Profile resource.',
  [C.INSUFFICIENT_SCOPE]: 'The Google connection was granted without the business.manage scope. Reconnect and approve Business Profile access.',
  [C.TOKEN_EXPIRED]: 'The Google access token expired and could not be refreshed.',
  [C.RECONNECT_REQUIRED]: 'Google access was revoked or has expired. Reconnect Google Business Profile.',
  [C.INVALID_CLIENT]: 'Google rejected the OAuth client credentials configured on the backend.',
  [C.NOT_FOUND]: 'Google could not find this Business Profile resource.',
  [C.INVALID_REQUEST]: 'Google rejected the request.',
  [C.TRANSIENT]: 'Google Business Profile is temporarily unavailable. Try again shortly.',
  [C.UNKNOWN]: 'Google Business Profile returned an unexpected error.',
};

// HTTP status the portal API answers with for each category.
const PORTAL_STATUS = {
  [C.NOT_CONFIGURED]: 503,
  [C.NOT_CONNECTED]: 409,
  [C.ACCESS_PENDING]: 503,
  [C.RATE_LIMITED]: 429,
  [C.API_DISABLED]: 503,
  [C.PERMISSION_DENIED]: 403,
  [C.INSUFFICIENT_SCOPE]: 403,
  [C.TOKEN_EXPIRED]: 401,
  [C.RECONNECT_REQUIRED]: 401,
  [C.INVALID_CLIENT]: 503,
  [C.NOT_FOUND]: 404,
  [C.INVALID_REQUEST]: 400,
  [C.TRANSIENT]: 502,
  [C.UNKNOWN]: 502,
};

export class GoogleBusinessApiError extends Error {
  constructor(category, { status = null, reason = null, retryAfterSeconds = null, quotaLimitValue = null, service = null, message } = {}) {
    super(message || GOOGLE_ERROR_MESSAGES[category] || GOOGLE_ERROR_MESSAGES[C.UNKNOWN]);
    this.name = 'GoogleBusinessApiError';
    this.category = category;
    this.status = status;
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
    this.quotaLimitValue = quotaLimitValue;
    this.service = service;
  }

  get retryable() {
    return this.category === C.RATE_LIMITED || this.category === C.TRANSIENT;
  }

  get portalStatus() {
    return PORTAL_STATUS[this.category] || 502;
  }

  // Safe to send to the browser and to persist: no tokens, no raw response.
  toJSON() {
    return {
      category: this.category,
      message: this.message,
      googleStatus: this.status,
      reason: this.reason,
      retryAfterSeconds: this.retryAfterSeconds,
      service: this.service,
    };
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : null;
}

function errorInfo(body) {
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  return details.find(detail => String(detail?.['@type'] || '').endsWith('google.rpc.ErrorInfo')) || null;
}

// `body` is the parsed JSON error body (or null); `headers` is a Headers-like object.
export function classifyGoogleApiResponse(status, body, headers = null) {
  const info = errorInfo(body);
  const reason = info?.reason || null;
  const metadata = info?.metadata || {};
  const rpcStatus = body?.error?.status || null;
  const quotaLimitValue = metadata.quota_limit_value ?? metadata.quotaLimitValue ?? null;
  const retryAfterSeconds = parseRetryAfter(headers?.get?.('retry-after'));
  const service = metadata.service || null;
  const base = { status, reason, retryAfterSeconds, quotaLimitValue, service };

  if (status === 429 || rpcStatus === 'RESOURCE_EXHAUSTED') {
    if (String(quotaLimitValue) === '0') return new GoogleBusinessApiError(C.ACCESS_PENDING, { ...base, retryAfterSeconds: null });
    return new GoogleBusinessApiError(C.RATE_LIMITED, base);
  }
  if (status === 401 || rpcStatus === 'UNAUTHENTICATED') return new GoogleBusinessApiError(C.TOKEN_EXPIRED, base);
  if (status === 403 || rpcStatus === 'PERMISSION_DENIED') {
    if (reason === 'SERVICE_DISABLED' || reason === 'API_DISABLED') return new GoogleBusinessApiError(C.API_DISABLED, base);
    if (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') return new GoogleBusinessApiError(C.INSUFFICIENT_SCOPE, base);
    return new GoogleBusinessApiError(C.PERMISSION_DENIED, base);
  }
  if (status === 404) return new GoogleBusinessApiError(C.NOT_FOUND, base);
  if (status === 400 || status === 409 || status === 412) return new GoogleBusinessApiError(C.INVALID_REQUEST, base);
  if (status >= 500) return new GoogleBusinessApiError(C.TRANSIENT, base);
  return new GoogleBusinessApiError(C.UNKNOWN, base);
}

// OAuth token endpoint errors use { error, error_description } instead.
export function classifyGoogleOAuthResponse(status, body) {
  const code = body?.error || null;
  if (code === 'invalid_grant') return new GoogleBusinessApiError(C.RECONNECT_REQUIRED, { status, reason: code });
  if (code === 'invalid_client' || code === 'unauthorized_client') return new GoogleBusinessApiError(C.INVALID_CLIENT, { status, reason: code });
  if (status === 429 || status >= 500) return new GoogleBusinessApiError(C.TRANSIENT, { status, reason: code });
  return new GoogleBusinessApiError(C.INVALID_REQUEST, { status, reason: code, message: 'Google rejected the OAuth request.' });
}

export function toGoogleBusinessApiError(error) {
  if (error instanceof GoogleBusinessApiError) return error;
  return new GoogleBusinessApiError(C.UNKNOWN);
}
