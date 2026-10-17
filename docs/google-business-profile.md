# Google Business Profile reviews — setup and operation

The iPlanet Service Portal reads Google reviews for mapped Business Profile
locations, lets authorized iPlanet Service users reply, and (optionally)
receives Pub/Sub notifications when reviews are added or updated. Internal
iPlanet reviews (the `Review` model, tied to closed tickets) are unchanged and
shown separately with an "Internal review" badge; Google reviews carry a
"Google" badge.

## Architecture

```
Browser (Service Portal, /service/reviews/google)
  → iPlanet backend /api/google-business/*   (JWT, iplanet_service role only)
      → Account Management API v1        accounts
      → Business Information API v1      locations
      → Google My Business API v4        reviews, review replies
      → Notifications API v1             account notificationSetting (Pub/Sub topic)

Google Business Profile → Cloud Pub/Sub topic → authenticated push subscription
  → POST /api/google-business/pubsub  (OIDC token verified)
      → idempotent receipt → review cache invalidated → portal notification
```

Code:

| Area | File |
| --- | --- |
| Routes | `backend/src/routes/googleBusiness.js` |
| OAuth, signed state, token refresh/revoke | `backend/src/integrations/googleBusinessProfile/googleBusinessProfileAuth.js` |
| Google API calls, retries | `.../googleBusinessProfileProvider.js` |
| Error classification (quota zero vs rate limit, etc.) | `.../googleBusinessProfileErrors.js` |
| Review normalization, transient cache | `.../googleBusinessProfileSyncService.js` |
| Pub/Sub push verification and parsing | `.../googleBusinessProfilePubSub.js` |
| MongoDB access | `.../googleBusinessProfileStore.js` |
| UI | `frontend/src/service/GoogleBusinessProfile.jsx`, `reviewShared.jsx` |

## API endpoints (all under `/api/google-business`)

| Method & path | Purpose |
| --- | --- |
| `GET /status` (`/health` alias) | Configuration, connection, access state, mappings, Pub/Sub status |
| `GET /auth[?reconnect=true]` | Signed Google OAuth URL; refused (409) while a working connection exists unless `reconnect=true` |
| `GET /callback` | OAuth redirect target; verifies signed state, stores encrypted tokens, redirects to the portal |
| `POST /check` | Re-tests access by listing accounts (5 s cooldown) |
| `DELETE /connection` | Turns off notifications, revokes the token at Google, deletes stored tokens (mappings kept) |
| `GET /accounts` | Accessible Business Profile accounts |
| `GET /locations[?refresh=true]` | Accessible locations with their mapping, plus mappings that are no longer accessible |
| `GET /mappings` | Mapped locations with sync metadata |
| `POST /locations/map` | `{ locationName, serviceCentreId }` — location must be accessible via Google; remapping moves it |
| `DELETE /locations/map/:mappingId` | Remove a mapping |
| `GET /reviews[?mappingId&pageToken]` | First page for every mapped location, or the next page for one |
| `POST /locations/:mappingId/sync` | Fresh retrieval bypassing the cache (15 s cooldown per location) |
| `PUT /locations/:mappingId/reviews/:reviewId/reply` | `{ comment, confirmed: true }` → Google `PUT .../reply` with `{ comment }` |
| `DELETE /locations/:mappingId/reviews/:reviewId/reply` | `{ confirmed: true }` → Google `DELETE .../reply` |
| `GET /notifications?accountName=` / `PUT /notifications` | Read / set the account's Pub/Sub notification setting |
| `POST /pubsub` | Pub/Sub push endpoint (no portal JWT; Google OIDC token required) |

Corporate Admin users receive 403 on every endpoint above; `/callback` also
rejects a state issued to any non-`iplanet_service` user.

## Error handling and the earlier HTTP 429

Google errors are classified from the `google.rpc.ErrorInfo` detail:

| Google response | Category | Portal behaviour |
| --- | --- | --- |
| 429 / `RESOURCE_EXHAUSTED` with `quota_limit_value: "0"` | `access_pending` | **Not retried.** Status banner: "Google Business Profile access pending" with the approval message and a *Check connection* button |
| 429 with a non-zero quota | `rate_limited` | Up to 3 attempts, exponential backoff (0.5 s, 1 s), `Retry-After` honoured up to 30 s |
| 5xx / network error | `transient` | Same retry policy |
| 403 `SERVICE_DISABLED` | `api_disabled` | "Enable the API" message |
| 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT` | `insufficient_scope` | Reconnect prompt |
| other 403 | `permission_denied` | Shown per account/location |
| 401 | `token_expired` | One refresh + retry |
| token endpoint `invalid_grant` | `reconnect_required` | Integration marked `reconnect_required`; Reconnect button |
| token endpoint `invalid_client` | `invalid_client` | Backend credentials message |

The earlier failure (account discovery returning 429 with a zero
requests-per-minute quota) is the `access_pending` case: the project has not yet
been granted Business Profile API access. Increasing quota in the Cloud console
does not fix it; Google must approve access (see setup step 2). Until then the
portal says so plainly, keeps the OAuth connection, and shows no reviews —
there is no mock or fallback review data anywhere in production code.

## Data storage and retention

What is stored in MongoDB:

- `GoogleBusinessIntegration` (one document): encrypted access/refresh tokens
  (AES-256-CBC, key from `GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY`, falling back to
  `JWT_SECRET`), granted scope, connection status, last access check and error
  category, Pub/Sub account/topic.
- `GoogleBusinessLocationMapping`: Google account/location resource names,
  location title and Maps URL, iPlanet service centre, sync status and
  timestamps, number of reviews retrieved on the last first-page sync.
- `GoogleBusinessNotificationReceipt`: Pub/Sub message ID, event type, location
  and review resource name, processing outcome — **expires after 7 days** (TTL index).
- `Notification`: an operational alert such as "New Google review activity
  detected for Chennai Service Centre." — no review text, rating or reviewer.

What is **not** stored: review text, star ratings, reviewer names or photos,
reply text. Reviews are fetched from Google when the portal shows them and kept
only in backend process memory for 5 minutes (to avoid spending API quota on
repeat views). That cache is cleared on expiry, on Pub/Sub activity for the
location, after a reply change, on remapping and on disconnect. The browser
keeps the last retrieved result in memory for the current tab only.

Policy basis: this minimal-storage design was chosen so the integration does
not depend on any caching allowance. The official Business Profile API pages
are the reference and **should be re-read before changing what is stored**:

- https://developers.google.com/my-business/content/policies
- https://developers.google.com/my-business/content/review-data
- https://developers.google.com/my-business/content/overview
- https://developers.google.com/my-business/content/notification-setup

Do not apply Places API caching rules here; they are a different product with
different terms.

## Google Cloud setup (human steps)

1. **Enable APIs** in project `peak-eon-508209-t3` (APIs & Services → Library):
   - My Business Account Management API
   - My Business Business Information API
   - Google My Business API (v4, serves reviews and replies)
   - My Business Notifications API (only for Pub/Sub)
   - Cloud Pub/Sub API (only for Pub/Sub)
2. **Request Business Profile API access.** New projects have a quota of 0
   requests per minute for these APIs until Google approves the access request
   form linked from the Business Profile APIs "Prerequisites" page. Creating
   OAuth credentials or enabling the APIs does not grant access. After approval,
   confirm the quota on APIs & Services → each API → Quotas is non-zero, then
   press **Check connection** in the portal.
3. **OAuth client** (APIs & Services → Credentials, type "Web application"):
   - Authorized redirect URI: `https://iplanet-backend.onrender.com/api/google-business/callback`
     (plus `http://localhost:5000/api/google-business/callback` for local testing)
   - OAuth consent screen scope: `https://www.googleapis.com/auth/business.manage`
   - While the consent screen is in "Testing", add the Google account that
     manages the Business Profile as a test user.
4. **Connect** from the portal (Reviews → Google → Connect) using the Google
   account that owns or manages the locations, then map each location to an
   iPlanet service centre on the *Locations* tab.

### Pub/Sub notifications (optional)

Manual retrieval works without these steps.

5. Create a topic, e.g. `projects/peak-eon-508209-t3/topics/gbp-reviews`.
6. Grant **Pub/Sub Publisher** on that topic to
   `mybusiness-api-pubsub@system.gserviceaccount.com` (Google's publisher
   account for Business Profile notifications).
7. Create a service account for push authentication, e.g.
   `gbp-push@peak-eon-508209-t3.iam.gserviceaccount.com`. Grant the Pub/Sub
   service agent (`service-<project-number>@gcp-sa-pubsub.iam.gserviceaccount.com`)
   **Service Account Token Creator** on it.
8. Create a **push** subscription on the topic:
   - Endpoint: `https://iplanet-backend.onrender.com/api/google-business/pubsub`
   - Enable authentication, service account from step 7
   - Audience: the endpoint URL above (must equal `GOOGLE_PUBSUB_PUSH_AUDIENCE`)
   - Optionally add a dead-letter topic.
9. Set the Render variables below, redeploy, then in the portal open
   *Notifications*, choose the account and press **Enable review notifications**
   (this calls `PATCH accounts/{id}/notificationSetting` with
   `pubsubTopic` and `NEW_REVIEW`, `UPDATED_REVIEW`).

The push endpoint rejects any request without a valid Google-signed OIDC token
for the configured audience and service account, and answers 503 while those
variables are unset.

## Environment variables (Render backend)

| Variable | Required | Notes |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | yes | OAuth web client |
| `GOOGLE_CLIENT_SECRET` | yes | secret — backend only |
| `GOOGLE_REDIRECT_URI` | yes | `https://iplanet-backend.onrender.com/api/google-business/callback` |
| `GOOGLE_BUSINESS_SCOPE` | yes | `https://www.googleapis.com/auth/business.manage` |
| `GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY` | recommended | long random string; changing it makes stored tokens unreadable (reconnect required) |
| `GOOGLE_BUSINESS_RETURN_URL` | optional | where the OAuth callback sends the browser; defaults to the first `FRONTEND_URLS` entry + `/service/reviews/google` |
| `FRONTEND_URLS` | yes (existing) | first entry should be the Vercel portal URL |
| `GOOGLE_PUBSUB_TOPIC` | Pub/Sub only | `projects/<project>/topics/<topic>` |
| `GOOGLE_PUBSUB_PUSH_AUDIENCE` | Pub/Sub only | must match the subscription's audience |
| `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT` | Pub/Sub only | push subscription's service-account email |

None of these may be prefixed `VITE_`; the frontend never sees Google
credentials or tokens.

## Tests

```
cd backend
npm run test:google
```

All Google HTTP traffic is mocked and persistence uses an in-memory store, so
no Google credentials or MongoDB are required.
