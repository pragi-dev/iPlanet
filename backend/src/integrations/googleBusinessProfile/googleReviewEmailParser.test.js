import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleReviewEmail } from './googleReviewEmailParser.js';

const message = {
  id: 'gmail-message-123',
  internalDate: String(new Date('2026-05-17T10:00:00.000Z').getTime()),
  payload: {
    headers: [
      { name: 'From', value: 'Google Business Profile <noreply@google.com>' },
      { name: 'Subject', value: 'New review for Phoenixx IT' },
      { name: 'Date', value: 'Sun, 17 May 2026 10:00:00 +0000' },
    ],
    body: {
      data: Buffer.from('Phoenixx IT received a new review.\nJohn Doe\n5 stars\nExcellent service and quick support!\nView review: https://www.google.com/maps/reviews/data=abc').toString('base64url'),
    },
  },
};

test('parses a review notification without inventing missing fields', () => {
  const parsed = parseGoogleReviewEmail(message, {
    placeId: 'ChIJDWJ8PaWsKycR3-r2Ijr0D0I',
    businessName: 'Phoenixx IT',
  });

  assert.deepEqual(parsed, {
    source: 'google-email',
    externalId: 'gmail-message-123',
    gmailMessageId: 'gmail-message-123',
    placeId: 'ChIJDWJ8PaWsKycR3-r2Ijr0D0I',
    businessName: 'Phoenixx IT',
    reviewerName: 'John Doe',
    rating: 5,
    comment: 'Excellent service and quick support!',
    reviewCreatedAt: '2026-05-17T10:00:00.000Z',
    reviewUrl: 'https://www.google.com/maps/reviews/data=abc',
    emailReceivedAt: '2026-05-17T10:00:00.000Z',
    rawSource: 'gmail',
  });
});

test('rejects unrelated Gmail messages', () => {
  const unrelated = { ...message, id: 'unrelated', payload: { ...message.payload, headers: [{ name: 'Subject', value: 'Your monthly statement' }], body: { data: Buffer.from('Your account statement is ready.').toString('base64url') } } };
  assert.equal(parseGoogleReviewEmail(unrelated, { placeId: 'place', businessName: 'Phoenixx IT' }), null);
});
