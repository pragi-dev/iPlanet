import 'dotenv/config';
import mongoose from 'mongoose';
import { b2cModels } from './b2cModels.js';
import { findPrematureTickets } from './prematureTickets.js';

// npm run b2c:premature-tickets [-- --json]
// Lists tickets created for a customer before registration was complete (see
// prematureTickets.js). Read only: it changes nothing and prints no customer details.
await mongoose.connect(process.env.MONGODB_URI);
try {
  const found = await findPrematureTickets(b2cModels);
  if (process.argv.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else if (!found.length) console.log('No tickets were created before customer registration.');
  else {
    const waiting = found.filter(item => item.state === 'awaiting_registration');
    console.log(`${found.length} ticket(s) created before customer registration; ${waiting.length} still without a completed registration.`);
    for (const item of found) console.log([item.reference, item.ticketStatus, `registration: ${item.registrationStatus}${item.registrationReason ? ` (${item.registrationReason})` : ''}`, item.assigned ? 'assigned' : 'unassigned', item.state, new Date(item.createdAt).toISOString()].join(' | '));
  }
} finally {
  await mongoose.disconnect();
}
