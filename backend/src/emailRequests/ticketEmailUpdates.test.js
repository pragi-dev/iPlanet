// Tests for acknowledgement emails on tickets raised by email, against a real MongoDB with
// a fake SMTP sender. Each run uses a new, uniquely named database that is dropped
// afterwards; set EMAIL_TEST_MONGODB_URI to point at a different server. Skipped when
// MongoDB is not reachable. No real email is sent.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { TicketEmail } from '../models.js';
import { composeTicketEmail, createTicketEmailUpdates } from './ticketEmailUpdates.js';

const ticket = (fields = {}) => ({ _id: new mongoose.Types.ObjectId(), ticketId: 'TKT-1001', category: 'Service', issueType: 'Battery', priority: 'Critical', emailSource: { address: 'karthik@demo.test', name: 'Karthik', messageId: '<m1@demo.test>', subject: 'iPhone battery swelling', trackingToken: 'tok' }, ...fields });
const entry = (fields = {}) => ({ _id: new mongoose.Types.ObjectId(), status: 'Open', message: 'Created from an email.', timestamp: new Date('2026-10-28T09:30:00Z'), ...fields });
const closed = (fields = {}) => entry({ status: 'Closed', message: 'Battery replaced and tested.', ...fields });

describe('composing an acknowledgement', () => {
  test('the opening email confirms the ticket and links to its tracking page', () => {
    const { subject, text } = composeTicketEmail({ ticket: ticket(), entry: entry(), device: { model: 'iPhone 16', serialNumber: 'C02ZK3C1ABCG' }, created: true, trackingUrl: 'https://portal.test/track/tok' });
    assert.equal(subject, 'Re: iPhone battery swelling');
    assert.match(text, /^Dear Karthik,/);
    assert.match(text, /logged your request as ticket TKT-1001/);
    assert.match(text, /Device: iPhone 16 \(C02ZK3C1ABCG\)/);
    assert.match(text, /Track the progress of your request at any time:\nhttps:\/\/portal\.test\/track\/tok/);
    assert.match(text, /email you again when the ticket is closed/);
  });

  test('the closing email gives the closing note and time', () => {
    const { subject, text } = composeTicketEmail({ ticket: ticket({ category: 'Health Camp', issueType: null, deviceCount: 40, emailSource: { address: 'a@b.test', subject: 'Re: Health camp' } }), entry: closed() });
    assert.equal(subject, 'Re: Health camp');
    assert.match(text, /^Dear Customer,/);
    assert.match(text, /TKT-1001 has been closed/);
    assert.match(text, /Closing note: Battery replaced and tested\.\nClosed: 28 Oct 2026, 3:00 pm IST/i);
    assert.match(text, /Devices: 40/);
    assert.doesNotMatch(text, /track/i);
  });
});

const DB_NAME = `iplanet_ticket_emails_test_${Date.now()}_${process.pid}`;
let mongoAvailable = true;
try { await mongoose.connect(process.env.EMAIL_TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017', { dbName: DB_NAME, serverSelectionTimeoutMS: 5000 }); } catch { mongoAvailable = false; }
const skip = mongoAvailable ? false : 'MongoDB is not reachable (set EMAIL_TEST_MONGODB_URI)';

describe('queueing and sending', { skip }, () => {
  const sent = [];
  let failing = false;
  let clock = new Date('2026-10-28T09:30:00Z');
  const send = async message => { if (failing) throw new Error('SMTP down'); sent.push(message); return { messageId: `<sent${sent.length}@iplanet.test>` }; };
  const logger = { info() {}, warn() {}, error() {} };
  const updates = createTicketEmailUpdates({ models: { TicketEmail }, send, fromAddress: 'requests@iplanet.test', trackingUrl: token => `https://portal.test/track/${token}`, now: () => clock, logger });

  before(async () => { await TicketEmail.createIndexes(); });
  after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });

  test('only opening and closing are mailed, once each, as replies', async () => {
    const theTicket = ticket();
    const opened = entry();
    await updates.queueUpdate({ ticket: theTicket, entry: opened, created: true });
    await updates.queueUpdate({ ticket: theTicket, entry: opened, created: true });
    for (const status of ['Engineer Assigned', 'In Progress', 'Completed']) assert.equal(await updates.queueUpdate({ ticket: theTicket, entry: entry({ status }) }), null);
    await updates.queueUpdate({ ticket: theTicket, entry: closed() });
    await updates.processQueue();
    assert.equal(sent.length, 2);
    assert.ok(sent.every(message => message.to === 'karthik@demo.test' && message.inReplyTo === '<m1@demo.test>'));
    assert.match(sent[0].text, /https:\/\/portal\.test\/track\/tok/);
    assert.match(sent[1].text, /has been closed/);
    const stored = await TicketEmail.find({ ticketId: theTicket._id }).lean();
    assert.deepEqual(stored.map(email => email.status), ['sent', 'sent']);
  });

  test('portal tickets, our own address and an unconfigured sender are never mailed', async () => {
    const before = await TicketEmail.countDocuments();
    assert.equal(await updates.queueUpdate({ ticket: ticket({ emailSource: undefined }), entry: entry(), created: true }), null);
    assert.equal(await updates.queueUpdate({ ticket: ticket({ emailSource: { address: 'requests@iplanet.test' } }), entry: entry(), created: true }), null);
    const off = createTicketEmailUpdates({ models: { TicketEmail }, send: null, fromAddress: 'requests@iplanet.test', logger });
    assert.equal(await off.queueUpdate({ ticket: ticket(), entry: entry(), created: true }), null);
    assert.equal(await TicketEmail.countDocuments(), before);
  });

  test('a stored key that is not a Message-ID is not used for threading', async () => {
    const theTicket = ticket({ emailSource: { address: 'x@demo.test', messageId: 'imap:requests@iplanet.test:INBOX:7', subject: 'Help' } });
    const email = await updates.queueUpdate({ ticket: theTicket, entry: closed() });
    assert.equal(email.inReplyTo, null);
    await updates.processQueue();
  });

  test('a failed send is retried later and given up after five attempts', async () => {
    failing = true;
    const theTicket = ticket();
    await updates.queueUpdate({ ticket: theTicket, entry: closed() });
    await updates.processQueue();
    let stored = await TicketEmail.findOne({ ticketId: theTicket._id }).lean();
    assert.equal(stored.status, 'queued');
    assert.equal(stored.attempts, 1);
    assert.match(stored.lastError, /SMTP down/);
    assert.ok(stored.nextAttemptAt > clock);
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      clock = new Date(clock.getTime() + 2 * 3600000);
      await updates.processQueue();
    }
    stored = await TicketEmail.findOne({ ticketId: theTicket._id }).lean();
    assert.equal(stored.status, 'failed');
    assert.equal(stored.attempts, 5);
    failing = false;
  });
});
