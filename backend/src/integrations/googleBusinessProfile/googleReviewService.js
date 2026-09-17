const positiveKeywords = ['excellent', 'great', 'helpful', 'friendly', 'good', 'fast', 'quick', 'professional', 'smooth', 'thank', 'happy', 'amazing', 'satisfied'];
const negativeKeywords = ['poor', 'bad', 'slow', 'unhelpful', 'rude', 'late', 'delayed', 'nobody', 'ignored', 'failed', 'broken', 'terrible', 'worst'];

export function analyzeGoogleReview(comment = '', rating = 0) {
  const text = String(comment || '').trim();
  const normalizedText = text.toLowerCase();
  const positiveHits = positiveKeywords.filter(keyword => normalizedText.includes(keyword)).length;
  const negativeHits = negativeKeywords.filter(keyword => normalizedText.includes(keyword)).length;
  const ratingScore = Number(rating) || 0;

  let sentiment = 'neutral';
  let sentimentScore = 0;
  if (ratingScore >= 4 || positiveHits > negativeHits) {
    sentiment = 'positive';
    sentimentScore = 0.7 + (positiveHits * 0.1) + (ratingScore >= 4 ? 0.2 : 0);
  } else if (ratingScore <= 2 || negativeHits > positiveHits) {
    sentiment = 'negative';
    sentimentScore = -0.7 - (negativeHits * 0.1) - (ratingScore <= 2 ? 0.2 : 0);
  } else {
    sentiment = 'neutral';
    sentimentScore = 0;
  }

  const safeComment = text || 'Google review without text';
  const summary = text.length > 150 ? `${text.slice(0, 147).trim()}...` : text || 'Customer left a review about service quality.';

  let priority = 'low';
  let recommendedAction = 'Monitor the review and keep the customer informed.';
  if (sentiment === 'negative') {
    priority = ratingScore <= 1 || negativeHits >= 2 ? 'high' : 'medium';
    recommendedAction = 'Review the related service interaction and contact the customer to address the concern.';
  } else if (sentiment === 'positive') {
    priority = 'low';
    recommendedAction = 'Share the positive feedback with the service team and maintain the current standard.';
  }

  const suggestedResponse = sentiment === 'negative'
    ? 'We are sorry to hear about your experience. We appreciate the feedback and would like to review this concern with our team and follow up directly.'
    : 'Thank you for your kind feedback. We are grateful for the opportunity to support you and appreciate your trust.';

  return {
    sentiment,
    sentimentScore: Number(sentimentScore.toFixed(2)),
    aiSummary: summary,
    keyIssue: sentiment === 'negative' ? 'Customer reported a service issue that requires follow-up.' : 'Customer highlighted positive service quality.',
    suggestedResponse,
    priority,
    recommendedAction,
    originalComment: safeComment,
  };
}

export function normalizeGoogleReviewInput(review = {}) {
  const createdAtSource = review.reviewCreatedAt || review.reviewUpdatedAt || review.createdAt || new Date().toISOString();
  const originalComment = String(review.comment || review.originalReview || '').trim();
  const normalized = {
    googleReviewId: String(review.googleReviewId || review.id || `gmb-${Date.now()}`),
    gmailMessageId: review.gmailMessageId || review.externalId || '',
    googlePlaceId: review.googlePlaceId || review.placeId || '',
    businessName: review.businessName || '',
    googleLocationId: review.googleLocationId || review.locationId || '',
    googleAccountId: review.googleAccountId || review.accountId || '',
    serviceCentreId: review.serviceCentreId || null,
    serviceCentreName: review.serviceCentreName || review.locationName || review.location || review.serviceCentre?.name || '',
    reviewerName: review.reviewerName || 'Google reviewer',
    rating: Number(review.rating || 0),
    comment: originalComment,
    reviewCreatedAt: new Date(createdAtSource).toISOString(),
    reviewUpdatedAt: review.reviewUpdatedAt ? new Date(review.reviewUpdatedAt).toISOString() : new Date(createdAtSource).toISOString(),
    emailReceivedAt: review.emailReceivedAt ? new Date(review.emailReceivedAt).toISOString() : undefined,
    reviewUrl: review.reviewUrl || '',
    source: review.source || 'google-api',
    googleReplyStatus: review.googleReplyStatus || 'not_attempted',
    googleReply: review.googleReply || '',
  };

  const analysis = analyzeGoogleReview(normalized.comment, normalized.rating);
  return {
    ...normalized,
    ...analysis,
    status: review.status || 'Open',
    notificationCreated: Boolean(review.notificationCreated),
  };
}

export function buildGoogleReviewAnalytics(rows = []) {
  const totalReviews = rows.length;
  const averageRating = totalReviews ? rows.reduce((sum, row) => sum + Number(row.rating || 0), 0) / totalReviews : 0;
  const positiveReviews = rows.filter(row => row.sentiment === 'positive').length;
  const neutralReviews = rows.filter(row => row.sentiment === 'neutral').length;
  const negativeReviews = rows.filter(row => row.sentiment === 'negative').length;
  const unresolvedNegativeReviews = rows.filter(row => row.sentiment === 'negative' && row.status !== 'Resolved').length;

  return {
    totalReviews,
    averageRating: Number(averageRating.toFixed(2)),
    positiveReviews,
    neutralReviews,
    negativeReviews,
    unresolvedNegativeReviews,
  };
}

export async function processGoogleReview(reviewInput, dependencies = {}) {
  const {
    findServiceCentre = async () => null,
    findExisting = async () => null,
    saveReview = async () => null,
    createNotification = async () => ({ created: 0 }),
    recordResult = async () => ({ status: 'processed' }),
  } = dependencies;

  const normalized = normalizeGoogleReviewInput(reviewInput);
  const serviceCentre = await findServiceCentre(normalized);

  if (!serviceCentre) {
    return {
      duplicate: false,
      mapped: false,
      review: normalized,
      notificationsCreated: 0,
      error: 'No iPlanet Service Centre is mapped to the Google Business Profile location.',
    };
  }

  const existing = await findExisting(normalized.googleReviewId);
  if (existing) {
    return {
      duplicate: true,
      mapped: true,
      review: existing,
      notificationsCreated: 0,
      duplicateReviewId: normalized.googleReviewId,
    };
  }

  const storedReview = await saveReview({
    ...normalized,
    serviceCentreId: serviceCentre._id || serviceCentre.id || null,
    serviceCentreName: serviceCentre.name || normalized.serviceCentreName,
    googleLocationId: normalized.googleLocationId || serviceCentre.googleBusinessProfile?.locationId || '',
    googleAccountId: normalized.googleAccountId || serviceCentre.googleBusinessProfile?.accountId || '',
  });

  const notificationsCreated = await createNotification({ review: storedReview, serviceCentre });
  const result = await recordResult({ review: storedReview, serviceCentre, notificationsCreated, duplicate: false });

  return {
    duplicate: false,
    mapped: true,
    review: storedReview,
    notificationsCreated: Number(notificationsCreated?.created || notificationsCreated?.count || 0),
    result,
  };
}
