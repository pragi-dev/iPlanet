import crypto from 'node:crypto';
import { B2C_ROLES } from './b2cDefaults.js';
import { B2C_ONLY_ROLE } from '../middleware.js';

// Grants and revokes B2C escalation roles. Used by the b2c:staff CLI so that
// production accounts are provisioned by an operator with database access,
// not through a new privileged HTTP endpoint.
//
// - An existing iPlanet Service account keeps its B2B access and gains the B2C role.
// - A new address becomes a B2C-only ('b2c_staff') account with a random
//   temporary password, returned once to be handed over securely.
// - Corporate (customer) accounts can never be given a B2C role.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STAFF_ROLES = [B2C_ONLY_ROLE, 'iplanet_service'];

export class StaffCommandError extends Error {}
const fail = message => { throw new StaffCommandError(message); };

export function parseStaffArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const match = /^--([a-z]+)$/.exec(rest[index]);
    if (!match || rest[index + 1] === undefined) fail(`Unexpected argument "${rest[index]}".`);
    options[match[1]] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

const regionsFrom = value => (value === undefined ? undefined : [...new Set(String(value).split(',').map(item => item.trim()).filter(Boolean))].slice(0, 50));

export async function runStaffCommand({ User, hashPassword, argv }) {
  const { command, options } = parseStaffArgs(argv);
  if (command === 'list') {
    const staff = await User.find({ role: { $in: STAFF_ROLES }, b2cRole: { $in: B2C_ROLES } }).select('name email role b2cRole b2cRegions').sort({ b2cRole: 1, email: 1 }).lean();
    return { lines: staff.map(item => `${item.email}\t${item.b2cRole}\t${item.role}\t${(item.b2cRegions || []).join(',') || 'all regions'}`) };
  }
  const email = String(options.email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) fail('Provide --email with a valid address.');
  const user = await User.findOne({ email }).select('name email role b2cRole b2cRegions');

  if (command === 'revoke') {
    if (!user?.b2cRole) fail(`${email} has no B2C role.`);
    await User.updateOne({ _id: user._id }, { $set: { b2cRole: null }, $unset: { b2cRegions: 1 } });
    return { lines: [`Revoked the B2C role from ${email}. Access ends on their next request.`] };
  }
  if (command !== 'grant') fail('Usage: grant --email <address> --role <role> [--name <full name>] [--regions "A,B"] | revoke --email <address> | list');

  if (!B2C_ROLES.includes(options.role)) fail(`--role must be one of: ${B2C_ROLES.join(', ')}.`);
  const regions = regionsFrom(options.regions);
  if (user) {
    if (!STAFF_ROLES.includes(user.role)) fail(`${email} is a ${user.role} account; only iPlanet Service or B2C staff accounts can hold a B2C role.`);
    await User.updateOne({ _id: user._id }, { $set: { b2cRole: options.role, ...(regions !== undefined ? { b2cRegions: regions } : {}) } });
    return { lines: [`${email} (${user.role}) now holds B2C role ${options.role}${regions?.length ? ` for regions ${regions.join(', ')}` : ''}.`] };
  }
  const name = String(options.name || '').trim().slice(0, 120);
  if (!name) fail('A new account needs --name.');
  const password = crypto.randomBytes(12).toString('base64url');
  await User.create({ name, email, password: hashPassword(password), role: B2C_ONLY_ROLE, company: 'B2C Escalations', b2cRole: options.role, b2cRegions: regions || [] });
  return { lines: [`Created B2C-only account ${email} with role ${options.role}.`, `Temporary password (shown once; share it securely): ${password}`] };
}
