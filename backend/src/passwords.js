import crypto from 'node:crypto';

// Passwords are stored as "scrypt$<salt hex>$<hash hex>". Accounts created
// before hashing was introduced still hold the plain value; they are accepted
// once and re-hashed on that successful login (see needsRehash).
const PREFIX = 'scrypt$';
const KEY_LENGTH = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LENGTH);
  return `${PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !password || typeof stored !== 'string' || !stored) return false;
  if (!stored.startsWith(PREFIX)) {
    const a = Buffer.from(password);
    const b = Buffer.from(stored);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const [saltHex, hashHex] = stored.slice(PREFIX.length).split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const needsRehash = stored => typeof stored === 'string' && !stored.startsWith(PREFIX);
