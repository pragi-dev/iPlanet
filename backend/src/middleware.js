import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

// Without JWT_SECRET a random per-process secret is used, so a missing
// variable can never fall back to a publicly known value. Sessions then end
// whenever the server restarts.
let fallbackSecret = null;
export function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (!fallbackSecret) {
    fallbackSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[auth] JWT_SECRET is not set; using a temporary secret. Sessions will end when the server restarts.');
  }
  return fallbackSecret;
}

export function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'Authentication required' });
  try { req.user = jwt.verify(token, jwtSecret()); next(); }
  catch { res.status(401).json({ message: 'Session expired' }); }
}
// B2C-only staff ('b2c_staff') may sign in and use the B2C escalation API, but
// no B2B endpoint: several B2B routes only check that a user is signed in.
export const B2C_ONLY_ROLE = 'b2c_staff';
export function restrictB2COnlyStaff(req, res, next) {
  if (/^\/(b2c|auth|health|internal)(\/|$)/.test(req.path)) return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return next();
  try {
    if (jwt.verify(token, jwtSecret()).role === B2C_ONLY_ROLE) return res.status(403).json({ message: 'This account can only access B2C escalations.' });
  } catch { /* the route's own auth check reports invalid tokens */ }
  next();
}
export function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ message: 'This account is not allowed to access this area' });
}
