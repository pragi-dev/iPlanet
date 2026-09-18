export function normalizeGoogleBusinessReview(review, fallbackLocation = null) {
  if (!review || typeof review !== 'object') return null;

  return {
    googleReviewId: review.name || review.reviewId || review.id || null,
    authorName: review.reviewer?.displayName || review.author?.displayName || 'Google review author',
    rating: Number(review.starRating || review.rating || 0) || 0,
    comment: review.comment || review.reviewText || review.text || '',
    createdAt: review.createTime || review.createdAt || new Date().toISOString(),
    locationName: review.locationName || fallbackLocation || review.location?.name || null,
    state: review.state || 'PUBLISHED',
    source: 'google_business_profile',
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
