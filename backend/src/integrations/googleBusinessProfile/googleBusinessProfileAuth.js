import crypto from 'node:crypto';

const GOOGLE_BUSINESS_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_BUSINESS_SCOPE = 'https://www.googleapis.com/auth/business.manage';

export function buildGoogleBusinessAuthUrl({
  clientId,
  redirectUri,
  state,
  accessType = 'offline',
  prompt = 'consent',
  includeGrantedScopes = true,
  scope = GOOGLE_BUSINESS_SCOPE,
} = {}) {
  const params = new URLSearchParams({
    client_id: clientId || process.env.GOOGLE_BUSINESS_CLIENT_ID || '',
    redirect_uri: redirectUri || process.env.GOOGLE_BUSINESS_REDIRECT_URI || '',
    response_type: 'code',
    scope,
    access_type: accessType,
    prompt,
    include_granted_scopes: String(includeGrantedScopes),
    state: state || JSON.stringify({ ts: Date.now() }),
  });

  return `${GOOGLE_BUSINESS_OAUTH_URL}?${params.toString()}`;
}

export function parseGoogleBusinessState(rawState) {
  if (!rawState) return {};
  try {
    return typeof rawState === 'string' ? JSON.parse(rawState) : rawState;
  } catch {
    return { rawState };
  }
}

export function encryptGoogleBusinessToken(value, secretKey = process.env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY) {
  if (!value) return '';
  if (!secretKey) return value;
  const key = crypto.createHash('sha256').update(String(secretKey)).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptGoogleBusinessToken(value, secretKey = process.env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY) {
  if (!value) return '';
  if (!secretKey || !String(value).includes(':')) return value;
  const [ivHex, encryptedHex] = String(value).split(':');
  const key = crypto.createHash('sha256').update(String(secretKey)).digest();
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
