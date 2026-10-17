import { clearRequestCache } from './requestCache';

// Called when the API rejects the stored token (expired or revoked). Retrying can
// never succeed, so the session is cleared and the user is sent to sign in again.
export function endExpiredSession() {
  clearRequestCache();
  localStorage.clear();
  if (window.location.pathname !== '/login') window.location.assign('/login');
}

// Sign-in answers 401 for a wrong password, and the Google Business endpoints answer 401
// when *Google* access needs reconnecting; neither means the portal session expired.
export const isExpiredSessionResponse = (status, path, hadToken) => status === 401 && hadToken && !/^\/(auth|google-business)\//.test(String(path));
