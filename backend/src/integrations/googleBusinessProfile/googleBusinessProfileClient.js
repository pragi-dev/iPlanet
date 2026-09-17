export class GoogleBusinessProfileProvider {
  constructor(environment = process.env) {
    this.environment = environment || {};
  }

  async getLocations() {
    throw new Error('Google Business Profile provider is not implemented');
  }

  async getReviews(locationId) {
    throw new Error('Google Business Profile provider is not implemented');
  }

  async getReview(reviewId) {
    throw new Error('Google Business Profile provider is not implemented');
  }

  async setupNotifications() {
    throw new Error('Google Business Profile provider is not implemented');
  }

  async replyToReview(reviewId, payload = {}) {
    throw new Error('Google Business Profile provider is not implemented');
  }
}

export class DemoGoogleBusinessProfileProvider extends GoogleBusinessProfileProvider {
  async getLocations() {
    return [];
  }

  async getReviews() {
    return [];
  }

  async getReview() {
    return null;
  }

  async setupNotifications() {
    return { enabled: false, mode: 'demo', message: 'Google Business Profile demo mode is enabled; no live API calls are made.' };
  }

  async replyToReview() {
    throw new Error('Google reply actions are disabled in demo mode. Enable Google API mode after OAuth configuration.');
  }
}

export class GoogleApiBusinessProfileProvider extends GoogleBusinessProfileProvider {
  async getLocations() {
    if (!this.environment.GOOGLE_CLIENT_ID || !this.environment.GOOGLE_CLIENT_SECRET) {
      throw new Error('Google Business Profile integration is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the backend environment.');
    }
    return [];
  }

  async getReviews() {
    if (!this.environment.GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID) {
      throw new Error('Google Business Profile account configuration is missing. Set GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID.');
    }
    return [];
  }

  async getReview() {
    return null;
  }

  async setupNotifications() {
    if (!this.environment.GOOGLE_PUBSUB_PROJECT_ID || !this.environment.GOOGLE_PUBSUB_TOPIC) {
      throw new Error('Google Pub/Sub configuration is missing. Set GOOGLE_PUBSUB_PROJECT_ID and GOOGLE_PUBSUB_TOPIC.');
    }
    return { enabled: true, mode: 'google-api' };
  }

  async replyToReview() {
    throw new Error('Google review reply requires explicit admin approval and a configured Google Business Profile write scope.');
  }
}

export function getGoogleBusinessProfileProvider(environment = process.env) {
  const mode = String(environment.GOOGLE_REVIEW_MODE || 'demo').toLowerCase();
  if (mode === 'google-api') return new GoogleApiBusinessProfileProvider(environment);
  return new DemoGoogleBusinessProfileProvider(environment);
}
