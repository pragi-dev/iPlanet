import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeGoogleReviewInput, buildGoogleReviewAnalytics, processGoogleReview } from './googleReviewService.js';

test('normalizeGoogleReviewInput keeps Google review original content and maps location data', () => {
  const review = normalizeGoogleReviewInput({
    googleReviewId: 'g-123',
    googleLocationId: 'loc-1',
    googleAccountId: 'acct-1',
    reviewerName: 'Asha',
    rating: 5,
    comment: 'Very good service. Staff were helpful.',
    reviewCreatedAt: '2026-09-17T10:00:00Z',
    locationName: 'Coimbatore Service Centre',
    serviceCentreName: 'Coimbatore Service Centre'
  });

  assert.equal(review.googleReviewId, 'g-123');
  assert.equal(review.googleLocationId, 'loc-1');
  assert.equal(review.serviceCentreName, 'Coimbatore Service Centre');
  assert.equal(review.comment, 'Very good service. Staff were helpful.');
  assert.equal(review.sentiment, 'positive');
});

test('analytics report totals and sentiment buckets for stored reviews', () => {
  const analytics = buildGoogleReviewAnalytics([
    { rating: 5, sentiment: 'positive', status: 'Open', serviceCentreId: 'svc-1' },
    { rating: 3, sentiment: 'neutral', status: 'Acknowledged', serviceCentreId: 'svc-1' },
    { rating: 1, sentiment: 'negative', status: 'Open', serviceCentreId: 'svc-2' },
    { rating: 2, sentiment: 'negative', status: 'Resolved', serviceCentreId: 'svc-2' }
  ]);

  assert.equal(analytics.totalReviews, 4);
  assert.equal(analytics.averageRating, 2.75);
  assert.equal(analytics.positiveReviews, 1);
  assert.equal(analytics.negativeReviews, 2);
  assert.equal(analytics.unresolvedNegativeReviews, 1);
});

test('processGoogleReview catches duplicate review IDs without creating a second notification', async () => {
  const seen = new Map();
  const result = await processGoogleReview({
    googleReviewId: 'duplicate-1',
    googleLocationId: 'loc-1',
    googleAccountId: 'acct-1',
    reviewerName: 'Karthik',
    rating: 1,
    comment: 'Very poor service. Nobody contacted me after I submitted my phone.',
    reviewCreatedAt: '2026-09-17T10:00:00Z',
    serviceCentreName: 'Coimbatore Service Centre'
  }, {
    findServiceCentre: async () => ({ _id: 'svc-1', name: 'Coimbatore Service Centre', googleBusinessProfile: { locationId: 'loc-1' } }),
    findExisting: async () => ({ googleReviewId: 'duplicate-1' }),
    createNotification: async () => ({ created: true }),
    recordResult: async () => ({ status: 'duplicate' }),
    saveReview: async review => {
      seen.set(review.googleReviewId, review);
      return review;
    }
  });

  assert.equal(result.duplicate, true);
  assert.equal(result.notificationsCreated, 0);
  assert.equal(seen.size, 0);
});
