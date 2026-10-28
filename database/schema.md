# Database schema

MongoDB, accessed through Mongoose. The connection string is `MONGODB_URI` (see `backend/.env.example`); locally it is `mongodb://127.0.0.1:27017/iplanet_portal`.

The schemas are defined in code, and this file describes them:

- `backend/src/models.js`: B2B portal (users, companies, devices, tickets, reviews, Google Business, notifications, proactive service, AI support)
- `backend/src/b2c/b2cModels.js`: B2C email escalations. Both `server.js` and `b2cServer.js` read their connection from `MONGODB_URI`.

Update this file whenever a schema changes.

Conventions used below:

- Every document has an `_id` (ObjectId). Collections marked **timestamps** also have `createdAt` and `updatedAt`.
- `→ Model` means an ObjectId reference to that model.
- *Date-only* means a `YYYY-MM-DD` string, not a `Date`.
- Fields without a default are absent until set.

---

## Overview

| Model | Collection | Purpose |
|---|---|---|
| User | `users` | Portal login accounts (all roles) |
| Company | `companies` | Corporate customers |
| ServiceCentre | `servicecentres` | iPlanet service centres |
| Device | `devices` | Devices enrolled to a company or service centre |
| DeviceMaster | `devicemasters` | Master list of known serial numbers and warranty data |
| Engineer | `engineers` | Field engineers |
| Ticket | `tickets` | B2B service tickets |
| TicketTimeline | `tickettimelines` | Status history entries for a ticket |
| CallRecord | `callrecords` | Support calls made against a ticket |
| Review | `reviews` | Customer rating and comment on a closed ticket |
| EscalationRule | `escalationrules` | SLA escalation rules |
| ServiceFollowUp | `servicefollowups` | One proactive-service cycle for one device |
| Notification | `notifications` | In-portal notifications |
| AITroubleshootingSession | `aitroubleshootingsessions` | AI support chat sessions |
| Customer | `customers` | Individual customers and their device |
| Counter | `counters` | Sequence counters for B2B auto-increment IDs |
| GoogleBusinessIntegration | `googlebusinessintegrations` | Connected Google Business Profile account (single document) |
| GoogleBusinessLocationMapping | `googlebusinesslocationmappings` | Google location ↔ service centre mapping |
| GoogleBusinessNotificationReceipt | `googlebusinessnotificationreceipts` | Pub/Sub delivery receipts (idempotency, 7-day TTL) |
| B2CSettings | `b2csettings` | B2C configuration (single document, `key: "default"`) |
| B2CInboundEmail | `b2cinboundemails` | Received customer emails |
| B2CEscalation | `b2cescalations` | B2C escalation tickets |
| B2CAuditEvent | `b2cauditevents` | Append-only audit trail for B2C tickets |
| B2COutboundEmail | `b2coutboundemails` | Outgoing B2C emails and their send queue |
| B2CIntegrationStatus | `b2cintegrationstatuses` | Health of B2C connectors and scheduler |
| B2CCounter | `b2ccounters` | Sequence counters (ticket reference numbers) |

### Relationships

```
Company ─┬─< User >─── ServiceCentre
         ├─< Device >── (selectedEntityId: Company or ServiceCentre)
         └─< Ticket >── Device, User (customer), ServiceCentre, Engineer
                ├─< TicketTimeline
                ├─< CallRecord
                ├── Review (one per ticket)
                └── ServiceFollowUp (two-way link)

Engineer ── User (login account)
ServiceCentre ─< GoogleBusinessLocationMapping
B2CInboundEmail >── B2CEscalation ─┬─< B2CAuditEvent
                                   └─< B2COutboundEmail
```

---

## B2B portal (`models.js`)

### User

| Field | Type | Notes |
|---|---|---|
| name | String | |
| email | String | **unique** |
| password | String | Hashed; `select: false` (excluded from queries unless asked for) |
| role | String | default `corporate_admin`; values used: `corporate_admin`, `iplanet_service`, `b2c_staff` |
| company | String | Company name (denormalised) |
| companyId | → Company | |
| serviceCentreId | → ServiceCentre | |
| phone | String | |
| b2cRole | String | default `null`. `b2c_admin` or a B2C workflow level key. Unset for B2B-only accounts |
| b2cRegions | [String] | Regions whose B2C queues the user sees; empty/absent = all |

### Company

| Field | Type | Notes |
|---|---|---|
| name | String | **unique** |
| companyId | String | **unique**; business identifier, not the `_id` |
| contactName, contactEmail, phone, location | String | |

### ServiceCentre (timestamps)

| Field | Type | Notes |
|---|---|---|
| serviceCentreId | String | unique, sparse |
| name | String | **unique** |
| location | String | **required** |
| address, city, state, contactNumber, email | String | |
| status | String | default `Active` |

### Device

| Field | Type | Notes |
|---|---|---|
| assetId | String | |
| serialNumber | String | **unique** |
| deviceType, model | String | |
| companyId | → Company | indexed |
| selectedEntityId | ObjectId | Company or ServiceCentre, per `selectedEntityType` |
| selectedEntityType | String | `corporate` \| `service_centre` |
| employeeName, employeeId, department | String | Assigned user details |
| location | String | Assigned user location. Also the device's **region** for B2C escalations: an email quoting this device's serial number is routed to this region |
| purchaseDate, installationDate, lastServiceDate, nextServiceDate | Date | |
| warrantyStatus, amcStatus | String | |
| warrantyExpiry, amcExpiry | Date | |
| deviceStatus | String | |
| deviceAllocationStatus | String | `Unassigned` \| `Assigned`, default `Unassigned` |
| serviceIntervalMonths | Number | 1–60 |

### DeviceMaster

| Field | Type | Notes |
|---|---|---|
| serialNumber | String | **unique** |
| deviceType, model, assetId | String | |
| purchaseDate, warrantyExpiry, amcExpiry | Date | |
| warrantyStatus, amcStatus | String | |

### Engineer

| Field | Type | Notes |
|---|---|---|
| name, phone, location | String | |
| employeeId | String | **unique** |
| email | String | **unique** |
| status | String | default `Available` |
| userId | → User | Login account |

### Ticket (timestamps)

| Field | Type | Notes |
|---|---|---|
| ticketId | String | **unique**; human-readable ticket number |
| customerId | → User | |
| companyId | → Company | |
| serviceCentreId | → ServiceCentre | |
| deviceId | → Device | |
| category, issueType, description, location, priority | String | |
| images, originalImages, annotatedImages | [String] | Upload paths |
| preferredServiceDate | Date | |
| status | String | default `Open` |
| assignedEngineer | String | Engineer name (denormalised) |
| assignedEngineerId | → Engineer | |
| assignedAt | Date | |
| expectedTAT, responseTarget, resolutionTarget | String | |
| slaTargetAt | Date | |
| slaStatus | String | `Healthy` \| `At Risk` \| `Escalated` \| `SLA Breached` \| `Resolved`, default `Healthy` |
| escalationLevel | Number | default `0` |
| escalationStatus | String | `Not Escalated` \| `At Risk` \| `Escalated` \| `SLA Breached` \| `Resolved`, default `Not Escalated` |
| escalationReason | String | |
| escalatedAt | Date | |
| serviceFollowUpId | → ServiceFollowUp | Set when the ticket came from a proactive-service cycle |

Indexes: `{companyId, createdAt: -1}`, `{status, createdAt: -1}`, `{deviceId, status}`, `{assignedEngineerId, status}`.

### TicketTimeline

| Field | Type | Notes |
|---|---|---|
| ticketId | → Ticket | |
| status, message, note, updatedBy, userRole | String | |
| timestamp | Date | default now |

Indexes: `{ticketId, timestamp}`, `{timestamp: -1}`, `{status, timestamp: -1}`.

### CallRecord (timestamps)

| Field | Type | Notes |
|---|---|---|
| ticketId | → Ticket | **required** |
| agentUserId | → User | |
| agentName, ticketNumber, customerName, customerPhone, notes | String | |
| outcome | String | `Issue Resolved Remotely` \| `Customer Needs Further Assistance` \| `Engineer Visit Required` \| `Customer Unavailable` \| `Call Back Required`, default `Customer Unavailable` |
| callStatus | String | default `Call Attempted` |

### Review (timestamps)

| Field | Type | Notes |
|---|---|---|
| ticketId | → Ticket | **required, unique**: one review per ticket |
| corporateId | → Company | **required**, indexed |
| customerId | → User | **required**, indexed |
| serviceCentreId | → ServiceCentre | indexed |
| deviceId | → Device | |
| engineerId | → Engineer | |
| rating | Number | **required**, 1–5 |
| comment | String | **required**, trimmed, max 2000 chars |

Indexes: `{corporateId, createdAt: -1}`, `{serviceCentreId, createdAt: -1}`.

### EscalationRule (timestamps)

| Field | Type | Notes |
|---|---|---|
| name | String | **required** |
| level | Number | **required**, 1–3 |
| trigger | String | **required** |
| priority | String | default `All` |
| slaThreshold | Number | **required**, 0–100 (percent of SLA elapsed) |
| action | String | **required** |
| isActive | Boolean | default `true` |

### ServiceFollowUp (timestamps)

One proactive-service cycle for one device: the recommended service date, what the service team and corporate customer did about it, and which notifications have been sent.

| Field | Type | Notes |
|---|---|---|
| deviceId | → Device | **required** |
| companyId | → Company | indexed |
| serviceCentreId | → ServiceCentre | indexed |
| dueDate | Date-only | **required** |
| intervalMonths | Number | |
| basis | String | What the due date was calculated from |
| stage | String | `Open` \| `Contacted` \| `Remind Later` \| `Scheduled` \| `In Service` \| `Completed` \| `Not Required` \| `Superseded`, default `Open`, indexed |
| contactLog | [subdoc] | `{ at: Date, byUserId: → User, byName, method, outcome, notes }` |
| customerResponse | subdoc | `{ type, at: Date, byUserId: → User, byName, reason, notes }` |
| followUpDate | Date-only | |
| followUpSetBy | String | `iplanet_service` \| `corporate_admin` |
| scheduledDate | Date-only | |
| ticketId | → Ticket | |
| completedAt, closedAt | Date | |
| notRequiredReason | String | |
| notifiedStates | [String] | default `[]` |

Indexes: `{deviceId, dueDate}` **unique**.

### Notification (timestamps)

| Field | Type | Notes |
|---|---|---|
| user | → User | Recipient |
| company | → Company | |
| serviceCentreId | → ServiceCentre | |
| portalRole, type, title, message | String | |
| priority | String | `normal` \| `high`, default `normal` |
| ticket | → Ticket | |
| device | → Device | |
| reviewId | → Review | |
| action | Object | default `null`; link/action payload for the UI |
| read | Boolean | default `false` |

Indexes: `{user, createdAt: -1}`, `{user, read}`.

### AITroubleshootingSession (timestamps)

| Field | Type | Notes |
|---|---|---|
| sessionId | String | **required, unique** |
| ticketId | → Ticket | |
| customerId | → User | |
| deviceId | → Device | |
| preparedRequest | Object | Ticket draft extracted from the chat |
| issueContext | Object | default `{}` |
| messages | [subdoc] | `{ role: 'user' \| 'assistant' (required), content (required), timestamp }` |
| troubleshootingSteps | [subdoc] | `{ step, outcome, timestamp }` |
| customerResponses | [subdoc] | `{ response, timestamp }` |
| result, status | String | default `In Progress` |
| escalationStatus | String | `Not Escalated` \| `Recommended Service Assistance` \| `Resolved`, default `Not Escalated` |
| providerAvailable | Boolean | default `false` |
| providerStatus | String | |
| feedback | subdoc | `{ promptedAt: Date, rating: 1–5, comment (max 2000), submittedAt: Date }` |

### Customer (timestamps)

| Field | Type | Notes |
|---|---|---|
| customerId | Number | **unique**, immutable; auto-incremented (1, 2, 3…) from `Counter` key `customer` when the document is first saved |
| name | String | **required**, trimmed |
| mobileNumber | String | **required**; 10–15 digits, optional leading `+`; indexed |
| email | String | lowercased; must look like an email |
| deviceSerialNumber | String | **required**, indexed; a customer is added only when they buy a device. Matches `Device.serialNumber` (not a reference) |

A customer's purchase is recorded on the `Device` with their serial number: `purchaseDate`, and `location`, which is the region the device was bought in and the region B2C routes escalations to.

Test data: `npm run seed:customers -- --database=<db name>` (in `backend`) adds 20 fictional customers with devices `TESTMOB0001`–`TESTMOB0020`, spread across the regions already on device records. It skips records that already exist and refuses to run when `NODE_ENV=production` or when the named database isn't the one in `MONGODB_URI`.

### Counter

| Field | Type | Notes |
|---|---|---|
| key | String | **required, unique**, e.g. `customer` |
| seq | Number | default `0`; incremented atomically with `$inc` |

### GoogleBusinessIntegration (timestamps)

There is a single document per provider. It holds OAuth tokens, so treat it as sensitive.

| Field | Type | Notes |
|---|---|---|
| userId | → User | **required**; who connected it |
| portalRole | String | **required**, `iplanet_service` |
| provider | String | **required**, default `google-business-profile`; **unique** index `provider_1` |
| accountId, accountName, accountDisplayName | String | default `null` |
| accessToken, refreshToken | String | default `null` |
| tokenType | String | default `Bearer` |
| expiresAt | Date | default `null` |
| connectedAt | Date | default now |
| lastSyncedAt, lastCheckedAt, lastErrorAt | Date | default `null` |
| status | String | `connected` \| `error` \| `disconnected` \| `reconnect_required`, default `connected` |
| grantedScope | String | |
| accessState | String | `unknown` \| `granted` \| `pending` \| `error`, default `unknown` (latest Google API outcome) |
| lastErrorCategory, lastErrorMessage | String | |
| notificationAccountName, notificationTopic | String | Pub/Sub setup |
| notificationsEnabledAt | Date | |

### GoogleBusinessLocationMapping (timestamps)

Stores sync metadata only. Google review content is never stored.

| Field | Type | Notes |
|---|---|---|
| serviceCentreId | → ServiceCentre | **required**, indexed |
| locationName | String | **required**; Google resource name |
| locationDisplayName, accountName, serviceCentreName | String | default `''` |
| mapsUri | String | |
| mappedAt | Date | default now |
| lastReviewSyncAt, lastSyncAttemptAt, nextRetryAt, lastNotificationAt | Date | |
| lastSyncedReviewCount | Number | default `0` |
| syncStatus | String | `never` \| `ok` \| `error` \| `pending`, default `never` |
| lastErrorCategory | String | |

Indexes: `{serviceCentreId, locationName}` **unique** (`serviceCentre_locationName_unique`). The application also ensures that a location maps to only one service centre: mapping it again moves it.

### GoogleBusinessNotificationReceipt

There is one document per Pub/Sub delivery, used to make processing idempotent.

| Field | Type | Notes |
|---|---|---|
| messageId | String | **required, unique** |
| eventKey | String | unique, sparse; dedupes the same review event under different message IDs |
| type, location, outcome | String | |
| status | String | `processing` \| `processed` \| `ignored` \| `failed`, default `processing` |
| receivedAt | Date | default now; **TTL index: expires after 7 days** |

---

## B2C escalations (`b2c/b2cModels.js`)

B2C has its own collections, separate from `tickets`. Enum constants come from `b2c/b2cDefaults.js`:

- `CATEGORIES` = `Service`, `Retail` (plus `Unclassified`)
- `IDENTIFIER_TYPES` = `caseId`, `serialNumber`, `orderNumber`, `other`
- `TEMPLATE_KEYS` = `acknowledgement`, `clarification`, `final_resolution`

A **person** subdocument is `{ userId: → User (default null), name, email }`.

### B2CSettings (timestamps)

A single document with `key: "default"`.

| Field | Type | Notes |
|---|---|---|
| key | String | **required, unique** |
| inboxes | [subdoc] | `{ key (required, /^[a-z0-9-]{2,40}$/), address (required, lowercased), displayName, provider: 'test' \| 'microsoft_graph' \| 'imap' (required; 'imap' is receive-only), defaultCategory: CATEGORIES \| null, defaultRegion, enabled (default true) }` |
| identifierRules | [subdoc] | `{ key, type: IDENTIFIER_TYPES, label, pattern, flags (default 'i'), enabled, confirmed }` |
| classificationRules | [subdoc] | `{ category: CATEGORIES, keywords: [String], enabled }` |
| workflowLevels | [subdoc] | `{ key, label, order, enabled }` |
| validation | subdoc | `{ mode: 'next_level' \| 'level' \| 'none' (default 'next_level'), levelKey (default null) }` |
| templates | [subdoc] | `{ key: TEMPLATE_KEYS, label, subject, body, approved, approvedBy, approvedAt }` |
| updatedBy | String | |

### B2CInboundEmail (timestamps)

| Field | Type | Notes |
|---|---|---|
| dedupeKey | String | **required, unique** |
| inboxKey | String | **required** |
| inboxAddress, provider | String | |
| providerMessageId | String | **required** |
| internetMessageId | String | Unique when present (partial index), so a message cc'd to two inboxes creates one ticket |
| inReplyTo | String | |
| references, to, cc | [String] | |
| from | subdoc | `{ address, name }` |
| subject, bodyText | String | |
| bodyTruncated | Boolean | |
| receivedAt | Date | |
| autoGenerated | String | default `null`; reason the email was treated as automated (auto-reply, bulk, bounce) |
| attachments | [subdoc] | `{ storageKey, filename, contentType, size, sha256, status: 'stored' \| 'rejected', rejectReason }` |
| status | String | `received` \| `processing` \| `retrying` \| `processed` \| `ignored` \| `failed`, default `received` |
| outcome, lastError | String | |
| attempts | Number | default `0` |
| nextAttemptAt, lockedUntil, processedAt | Date | |
| ticketId | → B2CEscalation | |

Indexes: `{internetMessageId}` unique partial, `{status, nextAttemptAt}`, `{ticketId, receivedAt}`.

### B2CEscalation (timestamps, optimistic concurrency)

| Field | Type | Notes |
|---|---|---|
| reference | String | **required, unique**; generated from `B2CCounter` key `reference-<year>` |
| sourceEmailId | → B2CInboundEmail | Unique when present (partial index) |
| inboxKey, inboxAddress, subject, summary | String | |
| category | String | CATEGORIES \| `Unclassified`, default `Unclassified` |
| classification | subdoc | `{ source: 'inbox' \| 'rule' \| 'manual' \| null, matched: [String], note }` |
| identifiers | [subdoc] | `{ type: IDENTIFIER_TYPES, value, ruleKey, source }` |
| customer | subdoc | `{ email, name, phone, crmCustomerId }` |
| devices | [subdoc] | `{ serialNumber, model, productName, purchaseDate, warrantyStatus, crmDeviceId }` |
| crmCases | [subdoc] | `{ caseId, status, openedAt, description }` |
| crm | subdoc | `{ status: 'pending' \| 'not_configured' \| 'matched' \| 'no_match' \| 'multiple_matches' \| 'error' (default 'pending'), provider, mode, fetchedAt, attempts (default 0), lastError, matchCount, nextAttemptAt }` |
| customerMatch | subdoc | `{ status: 'pending' \| 'matched' \| 'not_found' \| 'ambiguous' \| 'conflict', method: 'sender_email' \| 'message_email' \| 'phone' \| null, matchedBy: [String], customerIds: [Number] (Customer.customerId), name, email, evaluatedAt }`. The registered `Customer` the email was matched to by exact email or phone; never by name. Ids, name and the registered email (where the acknowledgement goes) are kept only for a match. Unset on tickets created before customer matching |
| region | String | default `''`. The region (`location`) of the `devices` record with the email's serial number (or, without one, the matched customer's only registered device), or the region a B2C admin chose in triage. Never the customer's own region |
| regionAssignment | subdoc | `{ status: 'pending' \| 'automatic' \| 'manual' \| 'unresolved', region, source: 'device_location' \| 'manual' \| null, reason, serialNumber, emailSerialNumber, ownerCheck: 'verified' \| 'customer_not_matched' \| 'other_customer' \| 'not_registered' \| null, deviceId: → Device, model, evaluatedAt, decidedBy: person, note }`. `ownerCheck` records whether the device is the matched sender's; routing does not depend on it, but only a `verified` serial number is quoted to the customer or sent to the CRM. How `region` was decided; `reason` says why it is unresolved, `note` is the admin's reason for a manual choice. `serialNumber` is the customer's registered serial number used (or the email's when unresolved); `emailSerialNumber` is the one written in the email. Unset on tickets created before device-region routing |
| status | String | `Pending Triage` \| `Open` \| `Engineer Assigned` \| `Engineer Accepted` \| `In Progress` \| `Awaiting Customer` \| `Pending Validation` \| `Completed` \| `Closed` \| `Reopened`, default `Pending Triage` |
| responseTarget, resolutionTarget | String | Every ticket gets the standard (`Medium`) 24-hour target; B2C has no priority field |
| slaTargetAt | Date | |
| slaStatus, escalationLevel, escalationStatus, escalationReason, escalatedAt | | Same values as on `Ticket` |
| triage | subdoc | `{ reasons: [String], resolvedAt, resolvedBy }` |
| workflow | subdoc | `{ path: [String], currentLevel (default null), assignee: person, assignedAt }` |
| participants | [→ User] | |
| validation | subdoc | `{ validatorLevel, proposedBy: person, proposedAt, resolutionSummary, customerMessage, decidedBy: person, decidedAt, decision, rejectionReason }` |
| resolution | subdoc | `{ summary, resolvedBy: person, resolvedAt, finalMessageId: → B2COutboundEmail }` |
| acknowledgement | subdoc | `{ status: 'pending' \| 'queued' \| 'held' \| 'sent' \| 'failed' \| 'skipped' (default 'pending'), outboundId: → B2COutboundEmail, sentAt, reason }`. `reason` says why none is sent: `customer_not_verified` or `invalid_recipient`. Independent of the ticket's status |
| registration | subdoc | `{ status, requestId: → B2CRegistrationRequest, reason, requestedAt, completedAt }`. Mirror of the ticket's customer registration request (statuses as on the request, plus `not_requested`: needed, but no email could be sent; `reason` says why). A ticket created after registration gets it with the completed (or, when an admin created the ticket, the current) request. Only a request that staff sent for an existing ticket, or one from before tickets waited for registration, can be open on a ticket: the acknowledgement then waits and triage lists `customer_registration_pending`. Unset when no registration was needed |
| reopenCount | Number | default `0` |
| closedAt | Date | |
| closure | subdoc | `{ reason, by: person }` |
| lastCustomerMessageAt, lastActivityAt | Date | |

Indexes: `{sourceEmailId}` unique partial, `{status, createdAt: -1}`, `{slaStatus, status}`, `{workflow.assignee.userId, status}`, `{workflow.currentLevel, status}`, `{category, region}`, `{customer.email}`, `{crm.status, crm.nextAttemptAt}`.

At startup, `ensureB2CIndexes()` also migrates existing data: it renames old statuses (`Assigned`, `Investigating`, `Resolved`), backfills SLA fields, and removes the old `priority` field.

### B2CAuditEvent

This collection is append-only.

| Field | Type | Notes |
|---|---|---|
| ticketId | → B2CEscalation | indexed |
| reference | String | |
| action | String | **required** |
| actor | subdoc | `{ userId: → User (default null), name, role }` |
| fromStatus, toStatus, note | String | |
| details | Object | default `{}` |
| at | Date | default now |

Indexes: `{ticketId, at}`.

### B2COutboundEmail (timestamps)

| Field | Type | Notes |
|---|---|---|
| dedupeKey | String | unique, sparse; `ack:<ticket id>` makes the acknowledgement once per ticket |
| ticketId | → B2CEscalation | indexed |
| via | String | `inbox` (default; the ticket's inbox connector sends it) \| `company_sender` (acknowledgement from `B2C_ACK_FROM_EMAIL` over SMTP) |
| from, replyTo | String | Sender and Reply-To of a `company_sender` email |
| inboxKey, templateKey, to, subject, bodyText | String | |
| kind | String | `acknowledgement` \| `clarification` \| `final` \| `reply` \| `registration` |
| registrationId | → B2CRegistrationRequest | For `registration`: the request whose link the email carries. The link is added only to the message sent; `bodyText` stores a placeholder |
| vars | Object | default `{}`; template variables |
| status | String | `queued` \| `held` \| `retrying` \| `sending` \| `sent` \| `failed` \| `skipped` (receive-only IMAP inbox, never sent), default `queued` |
| heldReason, lastError, messageId, providerMessageId, mode | String | |
| attempts | Number | default `0` |
| nextAttemptAt, lockedUntil, sentAt | Date | |
| createdBy | person | |

Indexes: `{status, nextAttemptAt}`, `{messageId}` sparse.

### B2CRegistrationRequest (timestamps)

One per incoming email whose sender could not be matched to a registered customer ([docs/b2c-customer-registration.md](../docs/b2c-customer-registration.md)). No ticket exists while it is open: the ticket is created from the original email once the registration is completed (or by a B2C admin). Requests from before this rule, and those staff send for an existing ticket, carry their ticket from the start.

| Field | Type | Notes |
|---|---|---|
| ticketId | → B2CEscalation | `null` until the ticket is created; unique when set |
| reference | String | The ticket's reference, once it exists |
| sourceEmailId | → B2CInboundEmail | The original email (the support request); unique: one request per email |
| internetMessageId, inboxKey, inboxAddress | String | Of the original email |
| subject, issueSummary | String | The original email's subject and issue summary |
| relatedEmailIds | [→ B2CInboundEmail] | Replies to the registration email received before the ticket existed; added to the ticket's conversation when it is created |
| ticketCreatedBy, ticketCreatedAt | String, Date | `registration` (created when the registration completed) \| `staff` (a B2C admin proceeded without it); unset on earlier requests |
| trigger | String | The email's customer match status when requested: `not_found` \| `insufficient` |
| recipient | String | **required**; the address the email came from |
| status | String | `required` \| `email_pending` \| `email_sent` \| `email_failed` \| `in_progress` (opened) \| `processing` (submission being checked) \| `completed` \| `manual_review` \| `expired` \| `cancelled` |
| reason | String | Why it needs review, or why no email was sent |
| tokenHash | String | SHA-256 of the current link's token; unique partial. The token itself is never stored. Removed when a new email is queued |
| tokenIssuedAt, expiresAt | Date | Set as each email is sent (every send issues a new token) |
| sendCount, lastQueuedAt, lastSentAt | Number, Date | Emails queued (limited by `B2C_REGISTRATION_MAX_SENDS`); `lastSentAt` = accepted by the mail server |
| outboundId | → B2COutboundEmail | The latest registration email |
| openedAt, submittedAt, completedAt | Date | |
| failedAttempts | Number | Rejected submissions; at `B2C_REGISTRATION_MAX_SUBMIT_ATTEMPTS` the link is withdrawn (`manual_review`) |
| lockedUntil | Date | Claim of a submission being checked; the processing cycle finishes a claim whose lock expired from the stored `submission` |
| submission | subdoc | Validated form values: `name, email, phone, alternatePhone, serialNumber, brand, model, purchaseDate, purchaseLocation, purchaseRegion, dealer, invoiceNumber`, stored when the submission is claimed. Shown only to B2C admins, only in review; never logged or audited |
| outcome | subdoc | `{ customerRecord: 'existing' \| 'linked' \| 'created', customerIds, name, email, phone (of the record used), deviceId → Device, model, region (the device's), checks: [String] }` |
| resumedAt, resumingUntil | Date | When the ticket was created (or the earlier ticket continued) from the submission; retried each cycle until set |

Indexes: `{ticketId}` unique partial (set ids only), `{sourceEmailId}` unique partial, `{tokenHash}` unique partial, `{status, expiresAt}`, `{recipient, createdAt: -1}`.

On startup the earlier `{ticketId}` unique index (which counted every request without a ticket as a duplicate `null`) is dropped and recreated as partial. Existing tickets and requests need no other change. `B2CAuditEvent.registrationId` holds the events of a request that has no ticket yet; they are linked to the ticket (`ticketId`, `reference`) when it is created.

### B2CIntegrationStatus (timestamps)

| Field | Type | Notes |
|---|---|---|
| key | String | **required, unique** |
| kind | String | `email` \| `crm` \| `outbound` \| `scheduler` |
| label, provider, lastError | String | |
| mode | String | `test` \| `live` \| `not_configured` \| `disabled` |
| lastRunAt, lastSuccessAt, lastErrorAt | Date | |
| consecutiveFailures | Number | default `0` |
| details | Object | default `{}` |

### B2CCounter

| Field | Type | Notes |
|---|---|---|
| key | String | **required, unique**, e.g. `reference-2026` |
| seq | Number | default `0`; incremented atomically with `$inc` |
