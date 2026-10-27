import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from '../models.js';
import { hashPassword } from '../passwords.js';
import { runStaffCommand, StaffCommandError } from './b2cStaff.js';

// npm run b2c:staff -- grant --email <address> --role <role> [--name "Full Name"] [--regions "North,South"]
// npm run b2c:staff -- revoke --email <address>
// npm run b2c:staff -- list
await mongoose.connect(process.env.MONGODB_URI);
try {
  const { lines } = await runStaffCommand({ User, hashPassword, argv: process.argv.slice(2) });
  console.log(lines.length ? lines.join('\n') : 'No B2C staff found.');
} catch (error) {
  if (!(error instanceof StaffCommandError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
