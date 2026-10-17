// Maps Google's v4 Review resource to the portal's representation. Fields
// Google omits stay null; nothing is invented (no default dates, names or
// ratings), so the UI can show "not provided" honestly.
const STAR_RATINGS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

const str = value => (typeof value === 'string' && value ? value : null);

export function starRatingToNumber(value) {
  if (typeof value === 'number' && value >= 1 && value <= 5) return Math.round(value);
  return STAR_RATINGS[value] || null;
}

export function normalizeGoogleBusinessReview(review, location = {}) {
  if (!review || typeof review !== 'object') return null;
  const name = str(review.name);
  const reviewId = str(review.reviewId) || (name ? name.split('/').pop() : null);
  if (!reviewId) return null;
  const reviewer = review.reviewer && typeof review.reviewer === 'object' ? review.reviewer : {};
  const reply = review.reviewReply && typeof review.reviewReply === 'object' ? review.reviewReply : null;

  return {
    source: 'google',
    reviewId,
    reviewName: name,
    rating: starRatingToNumber(review.starRating),
    comment: str(review.comment),
    reviewer: {
      displayName: str(reviewer.displayName),
      isAnonymous: reviewer.isAnonymous === true,
      profilePhotoUrl: str(reviewer.profilePhotoUrl),
    },
    createTime: str(review.createTime),
    updateTime: str(review.updateTime),
    reply: reply ? { comment: str(reply.comment), updateTime: str(reply.updateTime) } : null,
    location: {
      mappingId: location.mappingId ? String(location.mappingId) : null,
      locationName: location.locationName || null,
      title: location.title || null,
      serviceCentreId: location.serviceCentreId ? String(location.serviceCentreId) : null,
      serviceCentreName: location.serviceCentreName || null,
      mapsUri: location.mapsUri || null,
    },
  };
}

export function buildGoogleBusinessMappingPayload({
  accountName,
  locationName,
  locationDisplayName,
  serviceCentreId,
  serviceCentreName,
}) {
  return {
    accountName,
    locationName,
    locationDisplayName,
    serviceCentreId,
    serviceCentreName,
    mappedAt: new Date().toISOString(),
  };
}

// Review content is held only in process memory for a short time so that
// repeated page views do not spend Google API quota. It is never written to
// MongoDB, and it is dropped on expiry, on Pub/Sub activity for the location,
// on reply changes, and on disconnect.
export const GOOGLE_REVIEW_CACHE_TTL_MS = 5 * 60 * 1000;

export function createTransientReviewCache({ ttlMs = GOOGLE_REVIEW_CACHE_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map();
  const prune = () => { const time = now(); for (const [key, entry] of entries) if (entry.expiresAt <= time) entries.delete(key); };
  return {
    get(key) { prune(); return entries.get(key)?.value ?? null; },
    set(key, value) { entries.set(key, { value, expiresAt: now() + ttlMs }); return value; },
    invalidate(prefix) { for (const key of entries.keys()) if (key === prefix || key.startsWith(`${prefix}|`)) entries.delete(key); },
    clear() { entries.clear(); },
    get size() { prune(); return entries.size; },
  };
}

// Summary for the dataset the portal actually retrieved. It is labelled as
// such in the UI and never presented as the lifetime count.
export function summarizeRetrievedReviews(reviews) {
  const rated = reviews.filter(review => review.rating);
  return {
    retrievedCount: reviews.length,
    averageRating: rated.length ? Math.round((rated.reduce((sum, review) => sum + review.rating, 0) / rated.length) * 10) / 10 : null,
    awaitingReply: reviews.filter(review => !review.reply?.comment).length,
  };
}
