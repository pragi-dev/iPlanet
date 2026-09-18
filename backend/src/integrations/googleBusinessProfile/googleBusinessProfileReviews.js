export function normalizeGoogleBusinessReview(review, location) {
  const googleReviewId = review.name || review.reviewId;
  const ratingMap = { STAR_RATING_UNSPECIFIED: 0, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return {
    googleReviewId,
    googleAccountId: location.googleAccountId,
    googleLocationId: location.googleLocationId,
    googlePlaceId: location.placeId || '',
    businessName: location.businessName,
    serviceCentreName: location.businessName,
    reviewerName: review.reviewer?.displayName || null,
    rating: ratingMap[review.starRating] || Number(review.rating || 0),
    comment: review.comment || null,
    reviewCreatedAt: review.createTime || null,
    reviewUpdatedAt: review.updateTime || review.createTime || null,
    reviewUrl: review.reviewUrl || '',
    googleReplyStatus: review.reviewReply ? 'replied' : 'not_attempted',
    googleReply: review.reviewReply?.comment || '',
    source: 'google-business-profile',
  };
}
