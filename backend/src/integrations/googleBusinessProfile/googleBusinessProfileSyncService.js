import { normalizeGoogleBusinessLocation } from './googleBusinessProfileLocations.js';
import { normalizeGoogleBusinessReview } from './googleBusinessProfileReviews.js';

export async function discoverGoogleLocations({ provider, GoogleBusinessLocation, ServiceCentre }) {
  const discovered = await provider.discoverLocations();
  const centres = await ServiceCentre.find({ status: 'Active' }).lean();
  const rows = [];
  for (const item of discovered) {
    const normalized = normalizeGoogleBusinessLocation(item);
    const existing = await GoogleBusinessLocation.findOne({ googleAccountId: normalized.googleAccountId, googleLocationId: normalized.googleLocationId });
    const row = existing || new GoogleBusinessLocation(normalized);
    const existingMapping = row.mappingStatus;
    const existingServiceCentre = row.serviceCentreId;
    Object.assign(row, normalized, { lastSyncedAt: new Date(), mappingStatus: existingMapping || normalized.mappingStatus, serviceCentreId: existingServiceCentre || null });
    if (!row.serviceCentreId) {
      const suggestion = centres.find(centre => normalized.placeId && centre.googleBusinessProfile?.placeId === normalized.placeId);
      if (suggestion) { row.serviceCentreId = suggestion._id; row.mappingStatus = 'SUGGESTED'; }
    }
    await row.save();
    rows.push(row.toObject());
  }
  return rows;
}

export async function syncGoogleBusinessReviews({ provider, GoogleBusinessLocation, persistReview }) {
  const locations = await GoogleBusinessLocation.find({ mappingStatus: 'MAPPED', serviceCentreId: { $ne: null }, status: 'ACTIVE' }).lean();
  const summary = { locationsChecked: locations.length, reviewsFound: 0, newReviews: 0, updatedReviews: 0, duplicates: 0, failed: 0 };
  for (const location of locations) {
    try {
      const reviews = await provider.getAllReviews(location.googleAccountId, location.googleLocationId);
      summary.reviewsFound += reviews.length;
      for (const review of reviews) {
        try {
          const result = await persistReview(normalizeGoogleBusinessReview(review, location));
          if (result.duplicate) summary.duplicates += 1;
          else if (result.updated) summary.updatedReviews += 1;
          else if (result.mapped) summary.newReviews += 1;
          else summary.failed += 1;
        } catch {
          summary.failed += 1;
        }
      }
      await GoogleBusinessLocation.updateOne({ _id: location._id }, { $set: { lastSyncedAt: new Date() } });
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
