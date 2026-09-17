import crypto from 'node:crypto';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export class GoogleGmailError extends Error {
  constructor(message, code = 'GMAIL_ERROR', statusCode = 502) {
    super(message);
    this.name = 'GoogleGmailError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function encryptionKey(environment = process.env) {
  return crypto.createHash('sha256').update(String(environment.GOOGLE_GMAIL_TOKEN_ENCRYPTION_KEY || environment.JWT_SECRET || 'local-demo-secret')).update('iplanet-google-gmail-refresh-token').digest();
}

export function encryptRefreshToken(token, environment = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(environment), iv);
  const encrypted = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptRefreshToken(value, environment = process.env) {
  if (!value) return '';
  try {
    const [version, ivText, tagText, encryptedText] = String(value).split(':');
    if (version !== 'v1') return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(environment), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function requireOAuthConfig(environment) {
  if (!environment.GOOGLE_GMAIL_CLIENT_ID || !environment.GOOGLE_GMAIL_CLIENT_SECRET || !environment.GOOGLE_GMAIL_REDIRECT_URI) {
    throw new GoogleGmailError('Google Reviews is not connected. Configure the Gmail OAuth client and redirect URI.', 'GMAIL_OAUTH_NOT_CONFIGURED', 503);
  }
}

export function isGmailConfigured(environment = process.env, refreshToken = '') {
  return Boolean(environment.GOOGLE_GMAIL_CLIENT_ID && environment.GOOGLE_GMAIL_CLIENT_SECRET && environment.GOOGLE_GMAIL_REDIRECT_URI && (refreshToken || environment.GOOGLE_GMAIL_REFRESH_TOKEN));
}

export function buildGoogleGmailAuthUrl(environment = process.env, state = '') {
  requireOAuthConfig(environment);
  const params = new URLSearchParams({
    client_id: environment.GOOGLE_GMAIL_CLIENT_ID,
    redirect_uri: environment.GOOGLE_GMAIL_REDIRECT_URI,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPE,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function fetchJson(url, options, fetchImpl = fetch) {
  const response = await fetchImpl(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = url === GOOGLE_TOKEN_ENDPOINT ? 'TOKEN_REFRESH_FAILED' : (response.status === 401 ? 'GMAIL_AUTH_FAILED' : 'GMAIL_API_ACCESS_FAILED');
    throw new GoogleGmailError(body.error_description || body.error?.message || `Google request failed (${response.status})`, code, response.status);
  }
  return body;
}

export async function exchangeGoogleGmailCode(code, environment = process.env, fetchImpl = fetch) {
  requireOAuthConfig(environment);
  if (!code) throw new GoogleGmailError('Google OAuth callback did not include an authorization code.', 'GMAIL_OAUTH_CODE_MISSING', 400);
  return fetchJson(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: environment.GOOGLE_GMAIL_CLIENT_ID, client_secret: environment.GOOGLE_GMAIL_CLIENT_SECRET, redirect_uri: environment.GOOGLE_GMAIL_REDIRECT_URI, grant_type: 'authorization_code' }),
  }, fetchImpl);
}

async function accessToken({ refreshToken, environment = process.env, fetchImpl = fetch }) {
  requireOAuthConfig(environment);
  const token = refreshToken || environment.GOOGLE_GMAIL_REFRESH_TOKEN;
  if (!token) throw new GoogleGmailError('Google Reviews is not connected. Authorize the configured Gmail account first.', 'GMAIL_REFRESH_TOKEN_MISSING', 503);
  const result = await fetchJson(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: environment.GOOGLE_GMAIL_CLIENT_ID, client_secret: environment.GOOGLE_GMAIL_CLIENT_SECRET, refresh_token: token, grant_type: 'refresh_token' }),
  }, fetchImpl);
  if (!result.access_token) throw new GoogleGmailError('Google did not return an access token.', 'TOKEN_REFRESH_FAILED', 502);
  return result.access_token;
}

export async function listGoogleReviewEmails({ refreshToken, query, maxResults = 50, environment = process.env, fetchImpl = fetch } = {}) {
  const token = await accessToken({ refreshToken, environment, fetchImpl });
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const result = await fetchJson(`${GMAIL_API}/messages?${params}`, { headers: { Authorization: `Bearer ${token}` } }, fetchImpl);
  return (result.messages || []).map(message => message.id).filter(Boolean);
}

export async function getGoogleGmailMessage({ refreshToken, messageId, environment = process.env, fetchImpl = fetch } = {}) {
  const token = await accessToken({ refreshToken, environment, fetchImpl });
  return fetchJson(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}?format=full`, { headers: { Authorization: `Bearer ${token}` } }, fetchImpl);
}

export async function getGoogleGmailProfile({ refreshToken, environment = process.env, fetchImpl = fetch } = {}) {
  const token = await accessToken({ refreshToken, environment, fetchImpl });
  return fetchJson(`${GMAIL_API}/profile`, { headers: { Authorization: `Bearer ${token}` } }, fetchImpl);
}

export async function diagnoseGoogleGmailConnection({ refreshToken, environment = process.env, fetchImpl = fetch } = {}) {
  if (!environment.GOOGLE_GMAIL_CLIENT_ID || !environment.GOOGLE_GMAIL_CLIENT_SECRET || !environment.GOOGLE_GMAIL_REDIRECT_URI) return { status: 'AUTH_CLIENT_MISSING', connected: false };
  if (!refreshToken && !environment.GOOGLE_GMAIL_REFRESH_TOKEN) return { status: 'REFRESH_TOKEN_MISSING', connected: false };
  try {
    const messageIds = await listGoogleReviewEmails({ refreshToken, query: 'in:anywhere', maxResults: 1, environment, fetchImpl });
    return { status: 'GMAIL_API_CONNECTED', connected: true, readOnlyRequest: 'users.messages.list', sampleCount: messageIds.length };
  } catch (error) {
    return { status: error.code === 'TOKEN_REFRESH_FAILED' ? 'TOKEN_REFRESH_FAILED' : 'GMAIL_API_ACCESS_FAILED', connected: false, message: error.message };
  }
}

export { GMAIL_SCOPE };
