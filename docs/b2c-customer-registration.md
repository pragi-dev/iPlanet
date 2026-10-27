# B2C customer registration links

When an email's sender cannot be matched to a registered customer, the B2C server emails them a
secure, single-use link to a registration form — and creates **no ticket**. The email waits in a
registration request. Only once the customer's details are validated and saved is the ticket
created from the original email: it gets its ticket number, the region from the device record,
routing to the regional queue or Cluster Manager, and then the acknowledgement.

The feature is off unless `B2C_REGISTRATION_ENABLED=true`. Until then every email becomes a ticket
at once, as described in [b2c-escalations.md](b2c-escalations.md).

## The sequence

1. **Email received** (IMAP or another inbox connector). It is stored once (`dedupeKey`, and the
   `Message-ID` across inboxes) before it is marked read.
2. **Customer matched**, with the usual rules (`customerMatch.js`): two independent details of
   name, email and phone on one customer record, or the email's serial number plus one of them.
3. If a customer and device are identified, or a device record gives the email a region, the
   **ticket is created** and handled as before.
4. Otherwise, if the match is `not_found` or `insufficient`, a **registration request** is created
   for the email (`B2CRegistrationRequest`, unique per email) and the registration email is queued.
   No ticket, no ticket number, no region and no assignee exist yet; the stored email's outcome is
   `awaiting_registration`. Details that **conflict** or fit **several** customers are not asked to
   register: the ticket is created and goes to triage, as before.
5. **The customer submits the form.** The token, request and expiry are checked on the server; the
   submission is validated and verified against the device and customer records.
6. **The registration is saved**: the customer's purchase record (when a new one is needed) and the
   request's outcome, in one transaction where MongoDB supports them (replica set or sharded
   cluster). The request is `completed` only after these writes succeed; the link cannot be used
   again.
7. **The ticket is created** from the original email (subject, text, attachments, sender), linked to
   the registered customer and device, and gets its ticket number.
8. **Region and routing**: the region is the device record's `location`. Triage completes by itself
   when the category is known, and the ticket is routed to the region's Cluster Manager (or its
   queue), recorded as `routed` with the region and its source. A device without a region, or a
   region nobody covers, sends the ticket to manual triage (`device_region_missing`,
   `no_regional_assignee`); it is never left unprocessed and the region is never guessed.
9. **Acknowledgement**: queued once the ticket exists, with the real ticket number and the issue
   summary, from the company sender to the address the email came from.

The registration request's history (requested, email sent, opened, expired…) is recorded against
the request and moves to the ticket when the ticket is created, so the ticket's history starts with
it. Replies to the registration email that arrive before the ticket exists are added to the request
(`appended_to_registration`) and join the ticket's conversation once it is created.

## When a link is sent

The email goes to the address the email came from, from the company sender (`B2C_ACK_FROM_EMAIL`,
over SMTP) when it is enabled, otherwise through the inbox it came to, if that inbox can send. IMAP
is only ever used to read mail.

One address receives at most `B2C_REGISTRATION_MAX_PER_RECIPIENT_DAY` registration emails in 24
hours. Beyond that — or with no way to send, an invalid sender address, or no valid
`B2C_REGISTRATION_PORTAL_URL` — the request is kept as `required` with the reason and waits for a B2C
admin. No ticket is created in these cases either.

The wording is the `registration_request` template in B2C Settings. Like every customer email it is
**held until a B2C admin approves it**. Placeholders: `{{registrationLink}}`, `{{linkExpiry}}`,
`{{companyName}}`, `{{issueSummary}}`. The email carries no ticket number, because none exists yet.

The registration email has its own status on the request (`email_pending`, `email_sent`,
`email_failed`), separate from any ticket. A temporary failure is retried with backoff; a
permanent one leaves the request `email_failed` for an admin to resend. A failed email never
creates a ticket.

## The link

- A random 256-bit token (`crypto.randomBytes(32)`, base64url) in
  `<B2C_REGISTRATION_PORTAL_URL>/b2c/customer-registration/<token>`. No customer data, serial
  number, id or credential is in the URL.
- Only the token's SHA-256 hash is stored. The token is generated as the email is sent and is placed
  only in the message handed to the mail server; the stored copy of the email and the audit trail
  show a placeholder.
- It expires `B2C_REGISTRATION_TTL_HOURS` after the email is sent. Each email (first, resend,
  renewal) has a new token; queuing a new email withdraws the previous link at once.
- Single use: a submission claims the request atomically, so two submissions at once produce one
  result, and a used link answers "already received".
- Holding the link signs nobody in. It opens only the form for its own request; staff routes still
  need a staff login, and nothing in the form can choose the ticket, request, customer, device or
  region.
- In production the portal URL must be HTTPS or no link is sent.

## The form (`/b2c/customer-registration/:token`)

A public page without portal navigation (also available as the standalone
`customer-registration-ui`). The server checks the token on every request. It shows the form, field
errors from the server, a confirmation after submission, and clear pages for invalid, expired, used
and withdrawn links. An expired link offers **Email me a new link**: the answer is always the same,
and a new link is sent only to the original address, within the resend limits.

| Section | Field | Required |
| --- | --- | --- |
| Customer | Full name, email, mobile number | yes |
| | Alternate phone | no |
| Device | Serial number | yes |
| | Brand, model | no |
| Purchase | Purchase date, store or city of purchase | yes |
| | Purchase region (only the regions on the device records), dealer, invoice number | no |
| | Confirmation that the details are accurate | yes |

All validation is repeated on the server (`registration.js`). Each rejected submission is counted;
after `B2C_REGISTRATION_MAX_SUBMIT_ATTEMPTS` the link is withdrawn for manual review. The public
endpoints are rate limited per client address (view 60, submit 15 per 15 minutes; renew 5 per
hour). Behind a proxy set `TRUST_PROXY_HOPS` so the limits see the client's address.

The confirmation is the same whatever the outcome (`{state: 'submitted', reference: null}`), so the
form cannot be used to test what is on record; the ticket number reaches the customer in the
acknowledgement.

## Verification

The submission must identify one device and one customer:

1. **Device**: exactly one device record has the serial number. A purchase date on the device
   record must be within `B2C_REGISTRATION_PURCHASE_DATE_TOLERANCE_DAYS` of the stated one. A
   stated purchase region must equal the device record's. The region always comes from the device
   record, never from the customer's choice or address. There is no separate location-to-region
   mapping: the device's `location` is the approved region.
2. **Customer**, by the same two-detail rule as emails (`matchCustomer`):
   - the device is registered to this person (serial number plus a matching detail): their record is
     used (`existing`);
   - the device is unregistered and two details match a customer: a purchase record is added with
     **their stored** name, email and phone (`linked`) — the submission never overwrites them;
   - nobody matches any detail: a new customer record is created (`created`).

A device record without a region still verifies the customer; the ticket is then created and goes
to manual triage. Anything else goes to **manual review** with a reason, without creating or
changing a customer record and **without creating a ticket**: unknown or duplicated serial number,
region or date mismatch, device registered to someone else, or details that partly match an
existing customer (which would otherwise become a duplicate).

Device records are not created from the form: the device must already be on record, because its
record is what gives the region.

## Reliability

- **One ticket per email**: the ticket's `sourceEmailId` is unique, and so is the request's. Polling
  again, reprocessing, resending the link, submitting twice or retrying never adds a ticket, request,
  customer or acknowledgement (`ack:<ticket id>` is unique).
- **Crash while saving the registration**: the validated submission is stored when the request is
  claimed. If the run stops, the processing cycle finishes it from the stored submission once the
  lock expires; a purchase record written before the stop is found as the device's owner
  (`existing`), so it is not duplicated. Without transactions this is how consistency is kept; with
  them the purchase record and the completion are committed together.
- **Database error while saving**: nothing is completed, the submission is discarded and the link
  can be used again.
- **Crash after the registration is saved**: a `completed` request without `resumedAt` is picked up
  by every processing cycle until its ticket exists. Creating the ticket, routing it and queuing the
  acknowledgement are each safe to repeat.
- **A new link after a review**: a corrected submission with a link sent again creates the ticket
  like a first one.
- **Feature turned off**: links stop working, saved registrations still get their ticket, and
  requests still waiting stay on *Awaiting Registration* for an admin to create their tickets.

## Staff view

**Awaiting Registration** (`/b2c/registrations`, B2C admins): the emails that have no ticket yet —
waiting for the customer, or needing a decision (under review, expired, no email sent, or registered
with the ticket still being created). Each request shows its status, masked recipient, emails sent,
timestamps, the checks passed, its history and — for one under review — what the customer
submitted. Actions:

- **Send the link again**: at most `B2C_REGISTRATION_MAX_SENDS` emails per request and one per
  `B2C_REGISTRATION_RESEND_MINUTES`; recorded in the history.
- **Create ticket without registration**: with a reason. The ticket is created from the original
  email and goes to triage, where the admin decides the customer, region and assignee; an open link
  is withdrawn. For a registered request it creates the ticket straight away.

The dashboard shows *Awaiting registration* and *Registrations to decide* to admins. On a ticket,
the **Customer registration** panel shows the request and whether the ticket was created after
registration or by an admin.

## Tickets created before this change

Before this change every email became a ticket at once, and the registration request was opened for
that ticket. Those tickets keep working: when such a customer completes registration, the existing
ticket continues (region, routing, acknowledgement) and no second ticket is created.

To list them (read only — it changes nothing and prints no customer details):

```sh
npm --prefix backend run b2c:premature-tickets          # summary
npm --prefix backend run b2c:premature-tickets -- --json
```

A ticket is listed when its registration request was opened automatically with the ticket
(`ticketCreatedBy` unset and no staff `send_registration`), or when it was marked `not_requested`
automatically. `state` is `awaiting_registration` (registration not completed: open, expired, under
review or never sent) or `registered_later` (completed afterwards; the ticket was continued).

Proposed reconciliation — **nothing is deleted or changed automatically**; each step needs a B2C
admin's decision and is recorded in the ticket history:

1. Run the report and review the `awaiting_registration` tickets in triage.
2. Leave tickets whose customer is still within the link's lifetime: completing registration
   continues them as before.
3. For the rest, decide per ticket in triage: complete triage with the customer and region
   confirmed another way, send the registration link again, or *Close without resolution* with a
   reason. Ticket numbers already issued are not reused and audit history is kept.
4. Run the report again to confirm nothing is left unreviewed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `B2C_REGISTRATION_ENABLED` | `false` | Turns the feature on |
| `B2C_REGISTRATION_PORTAL_URL` | — | Public frontend address (HTTPS in production) |
| `B2C_REGISTRATION_TTL_HOURS` | `72` | Link lifetime after the email is sent |
| `B2C_REGISTRATION_MAX_SENDS` | `3` | Emails per request (first + resends + renewals) |
| `B2C_REGISTRATION_RESEND_MINUTES` | `15` | Minimum time between emails of one request |
| `B2C_REGISTRATION_MAX_PER_RECIPIENT_DAY` | `3` | Registration emails one address may get in 24 hours |
| `B2C_REGISTRATION_MAX_SUBMIT_ATTEMPTS` | `10` | Rejected submissions before the link is withdrawn |
| `B2C_REGISTRATION_PURCHASE_DATE_TOLERANCE_DAYS` | `7` | Allowed difference from the device record's purchase date |
| `TRUST_PROXY_HOPS` | — | Proxies in front of the server (Render: `1`) |

The sender is the existing company sender (`B2C_ACK_*`); no new credentials are needed.

On startup the earlier unique index on `b2cregistrationrequests.ticketId` (which required a ticket)
is replaced by one over set ticket ids only, and a unique index on `sourceEmailId` is added.

## Endpoints

| Method & path | Access | Purpose |
| --- | --- | --- |
| `GET /api/b2c/public/registration/:token` | token | Checks the link; returns the expiry, regions and field list (no customer data) |
| `POST /api/b2c/public/registration/:token` | token | Submits the form: `200 {state: 'submitted'}`, `422` with `fields`, `410` used/expired/closed, `409` in progress |
| `POST /api/b2c/public/registration/:token/renew` | token | Requests a new link for an expired one (always the same answer) |
| `GET /api/b2c/registrations?status=open\|decide\|<status>` | B2C admin | Registration requests without a ticket |
| `GET /api/b2c/registrations/:id` | B2C admin | One request, its history and (under review) the submission |
| `POST /api/b2c/registrations/:id/actions/resend` | B2C admin | Sends the link again |
| `POST /api/b2c/registrations/:id/actions/create_ticket` | B2C admin | Creates the ticket (`{reason}` required unless registered) |
| `POST /api/b2c/tickets/:id/actions/send_registration` | B2C admin | Asks the customer of an existing ticket to register |

Public answers carry `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
`X-Robots-Tag: noindex`.

## Tests

`backend/src/b2c/b2cRegistration.test.js` (part of `npm run test:b2c`) uses a throwaway MongoDB
database, the in-memory test inbox and a mocked SMTP sender; no real email is sent. It covers the
sequence above, failures of the email, the database and the process at each step, repeated
submissions and the report of earlier tickets.

## Open business decisions

- Approval of the registration email wording (the default follows the brief and promises no
  resolution time).
- The link lifetime and resend limits.
- Who reviews registrations in manual review, and whether a stated purchase date or region that
  contradicts the device record should block verification (it does now).
- When the SLA clock starts for a customer who registers: it starts when the ticket is created
  (after registration), not when the email arrived.
- Whether an alternate phone number, dealer and invoice number should be stored on the customer
  record; the `customers` schema has no such fields, so they are kept on the registration request.
- Retention period for submitted registration details.
