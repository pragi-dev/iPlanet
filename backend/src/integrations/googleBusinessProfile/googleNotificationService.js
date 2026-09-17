export async function createGoogleReviewNotifications({ review, serviceCentre, users, Notification, eventType = 'NEW_GOOGLE_REVIEW' }) {
  if (!review || !serviceCentre || !Array.isArray(users) || !users.length) {
    return { created: 0, reason: 'No recipients available.' };
  }

  const notificationRows = users
    .filter(Boolean)
    .filter(user => !user.serviceCentreId || String(user.serviceCentreId) === String(serviceCentre._id || serviceCentre.id))
    .map(user => ({
      user: user._id,
      company: user.companyId || null,
      serviceCentreId: serviceCentre._id || serviceCentre.id || null,
      portalRole: user.role,
      type: review.sentiment === 'negative' ? 'NEGATIVE_GOOGLE_REVIEW' : 'NEW_GOOGLE_REVIEW',
      title: review.sentiment === 'negative' ? 'Negative Google Review' : 'New Google Review',
      message: review.sentiment === 'negative'
        ? `${serviceCentre.name}: ${review.aiSummary || review.comment}`
        : `${serviceCentre.name}: ${review.aiSummary || review.comment}`,
      reviewId: review._id || review.googleReviewId,
      read: false,
      createdAt: new Date(),
    }));

  if (!notificationRows.length) {
    return { created: 0, reason: 'Relevant service-centre users were not found.' };
  }

  await Notification.insertMany(notificationRows);
  return { created: notificationRows.length, type: eventType };
}
