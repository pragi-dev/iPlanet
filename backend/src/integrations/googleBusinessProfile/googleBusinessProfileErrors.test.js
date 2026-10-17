import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGoogleApiResponse, classifyGoogleOAuthResponse, parseRetryAfter } from './googleBusinessProfileErrors.js';
import { parseGoogleBusinessNotification } from './googleBusinessProfilePubSub.js';
import { normalizeGoogleBusinessReview, summarizeRetrievedReviews } from './googleBusinessProfileSyncService.js';
import { googleReviewsLocationPath } from './googleBusinessProfileProvider.js';

const errorInfo = (reason, metadata = {}) => ({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, metadata }] } });
const headers = values => new Headers(values);

test('429 with a zero quota limit means API access has not been granted', () => {
  const error = classifyGoogleApiResponse(429, errorInfo('RATE_LIMIT_EXCEEDED', { quota_limit_value: '0' }), headers({ 'retry-after': '60' }));
  assert.equal(error.category, 'access_pending');
  assert.equal(error.retryable, false);
  assert.equal(error.retryAfterSeconds, null);
});

test('429 with a real quota is a retryable rate limit that keeps Retry-After', () => {
  const error = classifyGoogleApiResponse(429, errorInfo('RATE_LIMIT_EXCEEDED', { quota_limit_value: '300' }), headers({ 'retry-after': '7' }));
  assert.equal(error.category, 'rate_limited');
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSeconds, 7);
});

test('403 reasons map to disabled API, insufficient scope or permission denied', () => {
  assert.equal(classifyGoogleApiResponse(403, errorInfo('SERVICE_DISABLED')).category, 'api_disabled');
  assert.equal(classifyGoogleApiResponse(403, errorInfo('ACCESS_TOKEN_SCOPE_INSUFFICIENT')).category, 'insufficient_scope');
  assert.equal(classifyGoogleApiResponse(403, null).category, 'permission_denied');
  assert.equal(classifyGoogleApiResponse(401, null).category, 'token_expired');
  assert.equal(classifyGoogleApiResponse(503, null).retryable, true);
});

test('OAuth token errors distinguish revoked grants from bad client credentials', () => {
  assert.equal(classifyGoogleOAuthResponse(400, { error: 'invalid_grant' }).category, 'reconnect_required');
  assert.equal(classifyGoogleOAuthResponse(401, { error: 'invalid_client' }).category, 'invalid_client');
});

test('Retry-After accepts seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('3'), 3);
  assert.equal(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) >= 4, true);
  assert.equal(parseRetryAfter('soon'), null);
});

test('Error JSON never includes the raw Google response', () => {
  const error = classifyGoogleApiResponse(400, { error: { message: 'secret detail ya29.token' } });
  assert.equal(JSON.stringify(error.toJSON()).includes('ya29'), false);
});

test('Review normalization keeps missing fields null instead of inventing them', () => {
  const review = normalizeGoogleBusinessReview({ name: 'accounts/1/locations/2/reviews/r1', starRating: 'STAR_RATING_UNSPECIFIED', reviewer: { isAnonymous: true } });
  assert.equal(review.reviewId, 'r1');
  assert.equal(review.rating, null);
  assert.equal(review.comment, null);
  assert.equal(review.createTime, null);
  assert.equal(review.reviewer.displayName, null);
  assert.equal(review.reviewer.isAnonymous, true);
  assert.equal(normalizeGoogleBusinessReview({ comment: 'no id' }), null);
  assert.deepEqual(summarizeRetrievedReviews([review]), { retrievedCount: 1, averageRating: null, awaitingReply: 1 });
});

test('Review paths are built only from well-formed Google resource names', () => {
  assert.equal(googleReviewsLocationPath('accounts/1', 'locations/2'), 'accounts/1/locations/2');
  assert.throws(() => googleReviewsLocationPath('accounts/1', 'locations/../x'));
  assert.throws(() => googleReviewsLocationPath('', 'locations/2'));
});

test('Pub/Sub parsing derives the location from the review resource', () => {
  const data = Buffer.from(JSON.stringify({ type: 'UPDATED_REVIEW', review: 'accounts/1/locations/2/reviews/r9' })).toString('base64');
  const parsed = parseGoogleBusinessNotification({ message: { messageId: '42', data } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.location, 'accounts/1/locations/2');
  assert.equal(parsed.accountName, 'accounts/1');
  assert.equal(parsed.locationName, 'locations/2');
  assert.equal(parsed.reviewId, 'r9');
  const other = parseGoogleBusinessNotification({ message: { messageId: '43', data: Buffer.from(JSON.stringify({ type: 'GOOGLE_UPDATE', location: 'accounts/1/locations/2' })).toString('base64') } });
  assert.equal(other.relevant, false);
});
