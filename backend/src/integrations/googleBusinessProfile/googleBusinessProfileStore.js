// Persistence used by the Google Business routes. Kept behind this small
// interface so the routes can be tested with an in-memory store.
export const GOOGLE_BUSINESS_PROVIDER = 'google-business-profile';

export function createMongoGoogleBusinessStore({ GoogleBusinessIntegration, GoogleBusinessLocationMapping, GoogleBusinessNotificationReceipt, ServiceCentre, User, Notification }) {
  return {
    getIntegration: () => GoogleBusinessIntegration.findOne({ provider: GOOGLE_BUSINESS_PROVIDER }).lean(),
    upsertIntegration: update => GoogleBusinessIntegration.findOneAndUpdate({ provider: GOOGLE_BUSINESS_PROVIDER }, { ...update, provider: GOOGLE_BUSINESS_PROVIDER }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean(),
    updateIntegration: update => GoogleBusinessIntegration.findOneAndUpdate({ provider: GOOGLE_BUSINESS_PROVIDER }, update, { new: true }).lean(),

    listMappings: () => GoogleBusinessLocationMapping.find().sort({ serviceCentreName: 1 }).lean(),
    getMapping: id => /^[a-f0-9]{24}$/i.test(String(id)) ? GoogleBusinessLocationMapping.findById(id).lean() : null,
    findMappingByLocation: (accountName, locationName) => GoogleBusinessLocationMapping.findOne({ locationName, ...(accountName ? { accountName } : {}) }).lean(),
    // A Google location belongs to exactly one service centre; mapping it again moves it.
    async saveMapping(mapping) {
      await GoogleBusinessLocationMapping.deleteMany({ locationName: mapping.locationName, serviceCentreId: { $ne: mapping.serviceCentreId } });
      return GoogleBusinessLocationMapping.findOneAndUpdate({ serviceCentreId: mapping.serviceCentreId, locationName: mapping.locationName }, { ...mapping, mappedAt: new Date() }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    },
    updateMapping: (id, update) => GoogleBusinessLocationMapping.findByIdAndUpdate(id, update, { new: true }).lean(),
    deleteMapping: async id => Boolean(await GoogleBusinessLocationMapping.findByIdAndDelete(id)),

    getActiveServiceCentre: id => /^[a-f0-9]{24}$/i.test(String(id)) ? ServiceCentre.findOne({ _id: id, status: 'Active' }).lean() : null,
    getUser: id => /^[a-f0-9]{24}$/i.test(String(id)) ? User.findById(id).select('_id role').lean() : null,
    serviceUsersForCentre: serviceCentreId => User.find({ role: 'iplanet_service', $or: [{ serviceCentreId }, { serviceCentreId: null }] }).select('_id role').lean(),
    createNotifications: docs => docs.length ? Notification.insertMany(docs) : [],

    // 'created' for a first delivery, 'retry' for a redelivery of a message
    // whose processing failed, 'duplicate' otherwise (same message ID, or the
    // same review event under another message ID).
    async recordNotificationReceipt({ messageId, eventKey, type, location }) {
      try {
        await GoogleBusinessNotificationReceipt.create({ messageId, eventKey: eventKey || undefined, type, location });
        return 'created';
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const retried = await GoogleBusinessNotificationReceipt.findOneAndUpdate({ messageId, status: 'failed' }, { status: 'processing' });
        return retried ? 'retry' : 'duplicate';
      }
    },
    updateNotificationReceipt: (messageId, update) => GoogleBusinessNotificationReceipt.updateOne({ messageId }, update),
  };
}
