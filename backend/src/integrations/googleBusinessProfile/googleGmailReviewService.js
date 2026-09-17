import { getGoogleGmailMessage, listGoogleReviewEmails } from './googleGmailService.js';
import { describeGoogleReviewEmailStructure, parseGoogleReviewEmail } from './googleReviewEmailParser.js';

export async function retrieveGoogleReviewEmails({ refreshToken, environment = process.env, fetchImpl = fetch, maxResults = 50 } = {}) {
  const businessName = environment.GOOGLE_REVIEW_BUSINESS_NAME || 'Phoenixx IT';
  const query = environment.GOOGLE_GMAIL_SEARCH_QUERY || `(review OR rating OR stars) newer_than:${environment.GOOGLE_GMAIL_LOOKBACK_DAYS || 30}d`;
  const ids = await listGoogleReviewEmails({ refreshToken, query, maxResults, environment, fetchImpl });
  const parsed = [];
  const rejected = [];
  for (const messageId of ids) {
    const message = await getGoogleGmailMessage({ refreshToken, messageId, environment, fetchImpl });
    if (environment.GOOGLE_GMAIL_DEBUG_STRUCTURE === 'true') console.log(`[GOOGLE GMAIL STRUCTURE] ${JSON.stringify(describeGoogleReviewEmailStructure(message))}`);
    const review = parseGoogleReviewEmail(message, {
      placeId: environment.GOOGLE_REVIEW_PLACE_ID || 'ChIJDWJ8PaWsKycR3-r2Ijr0D0I',
      businessName,
    });
    if (!review || !review.businessName) {
      rejected.push({ messageId, reason: !review ? 'not-a-review' : 'business-mismatch' });
      continue;
    }
    parsed.push(review);
  }
  return { query, found: ids.length, parsed, rejected };
}
