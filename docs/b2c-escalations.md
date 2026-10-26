# B2C customer escalations — setup and operation

Sabora's B2C module turns customer emails sent to TCM's Service/Retail support
inboxes into tracked escalation tickets. It runs as its own API server
(`backend/src/b2cServer.js`) next to the main backend, and inside the existing
portal. It shares user accounts, sign-in, in-app notifications and UI
components with B2B, but keeps its own collections, API routes and pages. B2B
tickets, devices, SLA rules and screens are unchanged.

## Separate B2C server

| | Main API (`src/server.js`) | B2C server (`src/b2cServer.js`) |
| --- | --- | --- |
| Port | `PORT` (5000) | `B2C_PORT` (5100) |
| Routes | Everything except B2C; `/api/auth/login` | `/api/health`, `/api/b2c/*`, `/api/internal/b2c/run` |
| Scheduler | Proactive service | B2C email polling |

- Users sign in on the main API. The B2C server accepts the same tokens, so
  **both must use the same `JWT_SECRET` and `MONGODB_URI`**.
- `B2C_SEPARATE_SERVER=true` stops the main API from mounting B2C routes or
  starting the B2C scheduler. Without it, the main API keeps serving B2C as
  before (so run only one of the two for B2C).
- Frontend: calls to `/b2c/*` go to `VITE_B2C_API_URL` (e.g.
  `https://<b2c-service>.onrender.com/api`). If it is unset they use
  `VITE_API_URL`; in development the Vite proxy sends `/api/b2c` to
  `localhost:5100` (override with `B2C_DEV_TARGET`).
- Local: `npm run dev` at the repo root starts the main API, the B2C server
  and the frontend. On its own: `cd backend && npm run b2c:dev`.
- Render: `render.yaml` defines `iplanet-b2c` (`npm run b2c:start`), which
  takes `JWT_SECRET` from `iplanet-backend`. The B2C variables below are set on
  this service, not the main one.

> **Integration status.** The email-to-ticket flow is complete and tested
> end to end with the **test adapters** (an in-memory mailbox and a CRM stub
> with fictitious `TEST-` records). No live TCM system is connected. The
> Microsoft Graph mailbox connector follows Microsoft's documented API but has
> not been run against a TCM tenant. There is no live CRM connector because TCM
> has not supplied its CRM API. See [Outstanding TCM dependencies](#outstanding-tcm-dependencies).

## How an email becomes a ticket

```
Customer email → TCM inbox
  → poll (every B2C_EMAIL_POLL_MINUTES, or POST /api/internal/b2c/run)
  → B2CInboundEmail stored (deduplicated), then marked read at the provider
  → normalised to plain text; auto-replies / bulk / bounces / own inboxes ignored
  → reply to an existing ticket?  (reference "[B2C-YYYY-NNNNNN]" in subject or
    In-Reply-To/References, and same sender) → appended to that ticket
  → otherwise a new B2CEscalation:
       identifiers extracted with the configured patterns
       Service / Retail classified with the configured rules (never guessed)
       CRM lookup (case ID → serial number → sender email)
       anything missing or ambiguous → "Pending Triage" (B2C admin queue)
       otherwise routed to the first level of the category's workflow path
  → acknowledgement queued; sent only once its template is approved
```

Every step is idempotent. One email always produces one ticket and one
acknowledgement, even when it is delivered twice, delivered to two inboxes, or
reprocessed after a crash. Failures are retried with backoff (1, 5, 15, 30 and
60 minutes). After the attempt limit they are parked as `failed`, where an
admin can see them on **Integration Health** and retry them.

## Escalation workflow

Every ticket follows the same six stages as B2B service tickets:

| Stage | Status | Reached by |
| --- | --- | --- |
| Request created | `Open` (`Pending Triage` while an admin reviews it) | Email received |
| Engineer assigned | `Engineer Assigned` | Auto-assignment, Assign, Reroute to a named person |
| Engineer accepted | `Engineer Accepted` | The assignee accepts, or someone takes ownership |
| Work started | `In Progress` (`Awaiting Customer`, `Pending Validation` inside it) | Start work |
| Repair completed | `Completed` | Complete repair (after validation, if required) |
| Closed | `Closed` | Close, or close without resolution |

`Reopened` returns a ticket to its owner before work restarts. Tickets saved
with the earlier names (`Assigned`, `Investigating`, `Resolved`) are renamed on
startup. The ticket page shows these stages as a **Service journey**.

Levels (configurable labels, order and on/off): Cluster Manager → Regional
Business Head → Trainer → CD Team Assistant Manager → Service Excellence Lead.

- Every new ticket's **path** runs through all enabled levels in order, for
  both Service and Retail. An admin can change the path of a single ticket.
- When exactly one person holds the level for the ticket's region, the ticket
  is assigned to them. Otherwise it waits in that level's queue until someone
  takes ownership.
- Actions: take ownership, assign, accept assignment, start work, request
  clarification (emails the customer), reroute to any
  level, complete the repair, approve or return it, close, close without resolution, reopen,
  and add internal notes.
- **Validation** of a proposed resolution: `next_level` (default; the next
  level on the path validates, or a B2C admin at the top), `level` (one fixed
  level), or `none`. Nobody can validate their own resolution.
- The API enforces every permission. The UI only shows the actions the API
  reports as allowed. Tickets a user may not see return 404.
- Every change is written to an append-only audit trail (`B2CAuditEvent`).

### SLA escalation (same process as B2B)

Escalation is automatic, as for B2B service tickets. There is no manual
"escalate" action. The calculation is shared code (`backend/src/slaEscalation.js`).

- B2C has **no priority levels**. Every ticket gets the standard B2B targets
  (response 4 business hours, resolution 24 hours), counted from when the email
  arrived. Completed and closed tickets stop the clock.
- The **B2B escalation rules** (Service portal → Escalation Matrix, the
  `escalationrules` collection) apply to B2C. Only rules for all priorities
  apply, so priority-specific rules (such as the Critical level 3 rule) never
  match. With the defaults: 80% of the target → `At Risk`, level 1; 100% →
  `SLA Breached` / `Escalated`, level 2.
- Rules are evaluated on every processing cycle and whenever a ticket is
  opened. Each change is recorded once in the audit trail as "SLA Monitor" and
  notified. The owner stays the same. Level 1 notifies the owner (or the level
  queue). Level 2 also notifies the next level on the ticket's path and the
  B2C admins. Level 3 also notifies the level after that.
- Tickets created before SLA tracking, or with a priority from an earlier
  version, get the standard target from their creation time on startup.

These are iPlanet's B2B targets, applied at the user's request. TCM has not
confirmed them for B2C.

## Roles and access

| Account | How it is created | B2B access | B2C access |
| --- | --- | --- | --- |
| `b2c_staff` + `b2cRole` | `npm run b2c:staff -- grant …` (new address) | None (403 on every B2B endpoint) | Per role |
| `iplanet_service` + `b2cRole` | `npm run b2c:staff -- grant …` (existing address) | Unchanged | Per role; B2C group added to the Service navigation |
| `corporate_admin` | unchanged | Unchanged | None; the CLI refuses to grant |

`b2cRole` is `b2c_admin` or a level key (`cluster_manager`, `rbh`, `trainer`,
`cd_team_am`, `service_excellence_lead`). `b2cRegions` limits a level user to
tickets in those regions; leaving it empty means all regions. Roles are re-read
from the database on every request, so revoking one takes effect immediately.

- **B2C admin**: every ticket, the triage queue, settings, integration health,
  failed-processing queues and retries.
- **Level staff**: tickets at their level and region, tickets assigned to
  them, tickets they have worked on, and resolutions they must validate.

```bash
cd backend
npm run b2c:staff -- grant --email lead@tcm.example --role b2c_admin --name "Full Name"
npm run b2c:staff -- grant --email cm.north@tcm.example --role cluster_manager --name "Full Name" --regions "North"
npm run b2c:staff -- grant --email existing.service.user@iplanet.example --role rbh   # keeps B2B Service access
npm run b2c:staff -- revoke --email cm.north@tcm.example
npm run b2c:staff -- list
```

A new account's temporary password is printed once. Share it over a secure
channel. The portal has no self-service password change (the same as the
existing B2B accounts). Users already signed in see navigation changes after
signing in again.

## Configuration

**Business rules** live in the `B2CSettings` document and are edited on the
**B2C Settings** page (B2C admin). They are kept out of code so TCM's decisions
can be applied without a deploy:

| Setting | Starting value |
| --- | --- |
| Inboxes | One test inbox (`B2C_TEST_INBOX_ADDRESS`, provider `test`) |
| Identifier patterns | Two generic placeholders (labelled "Case ID …", "Serial No …"), marked **unconfirmed** |
| Service/Retail keywords | **Empty**, so every ticket goes to triage until TCM provides rules |
| Inbox default category | None |
| Workflow levels | The proposed five-level hierarchy, all enabled |
| Validation mode | `next_level` |
| Customer email templates | Generic placeholder wording, **not approved**. Nothing is sent until an admin approves each template |

**Credentials and limits** come from environment variables (backend only; never
stored in MongoDB or sent to the browser):

| Variable | Default | Purpose |
| --- | --- | --- |
| `B2C_EMAIL_POLL_MINUTES` | `2` | In-process poll interval; `0` disables (use the cron endpoint) |
| `B2C_CRON_SECRET` | – | Enables `POST /api/internal/b2c/run` with `Authorization: Bearer <secret>` |
| `B2C_GRAPH_TENANT_ID`, `B2C_GRAPH_CLIENT_ID`, `B2C_GRAPH_CLIENT_SECRET` | – | Microsoft Graph mailbox connector |
| `B2C_CRM_PROVIDER` | `none` | `none` or `test`. A live value is added with the TCM CRM adapter |
| `B2C_CRM_TIMEOUT_MS` | `15000` | CRM lookup timeout |
| `B2C_ALLOW_TEST_ADAPTERS` | `false` | Test adapters are off when `NODE_ENV=production` unless this is `true` (staging only) |
| `B2C_TEST_INBOX_ADDRESS` | `escalations@b2c-inbox.test` | Address of the seeded test inbox |
| `B2C_REFERENCE_PREFIX` | `B2C` | Reference format `PREFIX-YYYY-NNNNNN` |
| `B2C_MESSAGE_ID_DOMAIN` | `sabora.local` | Domain in outbound `Message-ID`s |
| `B2C_ATTACHMENT_DIR` | `backend/storage/b2c-attachments` | Attachment storage; **use a persistent disk in production** |
| `B2C_MAX_ATTACHMENT_MB`, `B2C_MAX_ATTACHMENTS` | `10`, `10` | Per-file and per-email limits |
| `B2C_MAX_PROCESSING_ATTEMPTS`, `B2C_MAX_SEND_ATTEMPTS`, `B2C_MAX_CRM_ATTEMPTS` | `5` | Retries before parking as failed |
| `B2C_POLL_BATCH_SIZE` | `25` | Messages fetched per inbox per poll |
| `B2C_DEMO_ACCOUNTS` | `true` | Local demo staff (`b2c.<role>@iplanet.local` / `Demo@123`); never created when `NODE_ENV=production` |

## API endpoints

All routes are under `/api/b2c`. They need a signed-in `b2c_staff` or
`iplanet_service` account holding a B2C role. Routes marked *admin* need
`b2c_admin`.

| Method & path | Purpose |
| --- | --- |
| `GET /me` | Current user's B2C role and regions |
| `GET /dashboard` | Counts, distributions, recent activity (+ health counts for admins) |
| `GET /staff` | B2C staff for assignment pickers |
| `GET /tickets` | Queue: `status`, `category`, `region`, `level`, `assignee` (`me`/`unassigned`/id), `queue=validation`, `ageing`, `from`, `to`, `search`, `sort`, `order`, `page`, `limit` |
| `GET /tickets/:id` | Ticket, email conversation, audit trail, allowed actions |
| `POST /tickets/:id/actions/:action` | Workflow actions (see above) |
| `GET /tickets/:id/attachments/:key` | Attachment download (always `Content-Disposition: attachment`, audited) |
| `GET /reports` | By region, category, status, level, ageing, resolution time, monthly |
| `GET /notifications`, `GET /notifications/unread-count`, `PATCH /notifications/:id/read`, `PATCH /notifications/read-all` | B2C notifications |
| `GET /settings`, `PUT /settings` *(admin)* | Business-rule configuration |
| `GET /integrations/health` *(admin)* | Inbox, CRM, outbound and scheduler status, queue counts |
| `POST /integrations/run` *(admin)* | Run one processing cycle now |
| `GET /inbound`, `POST /inbound/:id/retry` *(admin)* | Failed / ignored inbound emails |
| `GET /outbound`, `POST /outbound/:id/retry` *(admin)* | Held / failed customer emails |
| `POST /test-adapter/inbound`, `GET /test-adapter/outbox` *(admin)* | **Test adapter only**; 404 when disabled |
| `POST /api/internal/b2c/run` | External cron trigger (bearer secret; 404 when unset) |

## Data (MongoDB)

Collections are created on startup (`ensureB2CIndexes`). Nothing existing is
altered except two optional fields on `User` (`b2cRole`, `b2cRegions`), which
are unset for all B2B accounts. No migration of existing documents is needed.

| Collection | Contents |
| --- | --- |
| `b2csettings` | One `default` document of business rules |
| `b2cinboundemails` | Normalised received emails, attachment metadata, processing state |
| `b2cescalations` | Tickets: identifiers, CRM-mapped customer/devices/cases, workflow, validation, resolution |
| `b2coutboundemails` | Customer emails with send state (queued / held / retrying / sent / failed) |
| `b2cauditevents` | Append-only audit trail |
| `b2cintegrationstatuses` | Last success/error per connector |
| `b2ccounters` | Yearly reference sequence |

Only the mapped CRM fields are stored. Raw CRM responses are never persisted
or logged.

## Security

- Email content is untrusted. It is converted to plain text (scripts, styles
  and markup removed), stripped of control and bidi-override characters, size
  limited, and rendered as text in the portal, never as HTML.
- Attachments: allowlisted types only (PDF, JPEG, PNG, HEIC, TXT). The leading
  bytes must match the declared type. Files are stored under random names
  outside the public `/uploads` folder and served only through the authorised
  endpoint as downloads, with `nosniff` and a sandbox CSP.
- Customer emails are sent as plain text from approved templates. Only known
  placeholders are filled, and subject values are single-line (no header
  injection).
- Logs, error messages and audit details are redacted (emails masked, phone
  numbers, bearer tokens and secrets removed, message bodies dropped).
  In-app notification text contains the ticket reference only.
- Optimistic concurrency means two people acting on the same ticket at once
  get a "reload and try again" message instead of overwriting each other.

## Deployment

1. **Backend (Render):** deploy as usual. Set `NODE_ENV=production` and the
   variables above. Attach a **persistent disk** and point
   `B2C_ATTACHMENT_DIR` at it, because Render's default filesystem is
   discarded on each deploy. Run a single instance, or set
   `B2C_EMAIL_POLL_MINUTES=0` and drive processing from one external cron
   calling `/api/internal/b2c/run`. Processing is safe to repeat, but one
   scheduler avoids wasted polls.
2. **Frontend (Vercel):** no change is needed. The existing SPA rewrite serves
   `/b2c/*`.
3. **Accounts:** create the first B2C admin with `npm run b2c:staff`
   (run with the production `MONGODB_URI`), then the level staff.
4. **Staging rehearsal with one inbox:** on staging (`B2C_ALLOW_TEST_ADAPTERS=true`,
   `B2C_CRM_PROVIDER=test`), use **Integration Health → Send test email and process** to
   run the whole flow: ticket, acknowledgement in the test outbox, routing,
   resolution, final email.
5. **First live inbox:** once TCM confirms Microsoft 365 and grants the app
   registration, set the `B2C_GRAPH_*` variables. In B2C Settings, change the
   inbox to provider `microsoft_graph` with the real address and confirm on
   Integration Health that the inbox reports `live` with no errors. Approve the
   templates only after TCM signs off the wording.
6. **Expand to all four inboxes:** add the remaining three addresses in B2C
   Settings, with a default category or region per inbox if TCM wants one.

### Microsoft Graph app registration (if TCM uses Microsoft 365)

Register an app in TCM's Entra ID tenant with **application** permissions
`Mail.ReadWrite` and `Mail.Send`, and grant admin consent. Restrict it to the
four support mailboxes with an Exchange Online **application access policy**
(RBAC for Applications), so it cannot read any other mailbox. The connector
uses the client-credentials flow and these documented v1.0 endpoints: list
unread inbox messages, list file attachments, `PATCH isRead`, `sendMail`.
Messages are marked read only after they are stored.

## Tests

```bash
cd backend
npm run test:b2c        # unit tests + end-to-end flow against a throwaway MongoDB database
```

The flow suite connects to `mongodb://127.0.0.1:27017` (override with
`B2C_TEST_MONGODB_URI`), uses a uniquely named database that it drops
afterwards, and is skipped if MongoDB is unreachable.

## Outstanding TCM dependencies

| Needed from TCM | Blocks |
| --- | --- |
| Confirmation of the email provider (Microsoft 365 assumed; Gmail/IMAP would need another adapter behind the same interface) and the four inbox addresses | Live inbound/outbound email |
| Graph app registration credentials and mailbox access policy | Live email |
| CRM API documentation, credentials, environment URLs and field mapping | Live CRM lookup (the `crmConnector.js` contract lists what the adapter must return) |
| Approved identifier formats (case ID, serial number, others) | Confirming or replacing the placeholder patterns |
| Service vs Retail classification rules (per-inbox defaults and/or keywords) | Automatic classification; until then tickets go to triage |
| Region list and staff-to-region mapping | Regional queues and auto-assignment |
| Workflow paths per category and the validation rule | Routing beyond the proposed default |
| Approved wording for the acknowledgement, clarification and final emails | Any customer email being sent |
| Confirmation of SLA targets and escalation rules for B2C | B2C currently uses the B2B targets and rules |
| Data retention period for emails and attachments | A retention job (none exists yet) |
