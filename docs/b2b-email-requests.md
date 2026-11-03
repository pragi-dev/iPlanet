# B2B Email Requests

Corporate customers can raise a service request by email. The request inbox is read over
IMAP, Claude drafts a ticket from each new email, and an iPlanet Service user reviews the
draft in **Email Requests**. Only approval creates a ticket. The sender then gets an
acknowledgement with a tracking link, and a second email when the ticket is closed.

Code: `backend/src/emailRequests/`.

## How an email becomes a ticket

```
Email to the request inbox (B2B_EMAIL_USER)
  → checked every B2B_EMAIL_POLL_MINUTES (or "Check now" in Email Requests)
  → stored as an EmailRequest, then marked read in the mailbox
  → Claude extracts the request details (emailExtractor.js)
  → sender, company, requester and device matched against the database
    (emailRequestMatching.js); free mail domains never identify a company, and a sender
    who identifies a company only ever gets that company's devices
  → pending draft in Email Requests: the reviewer edits, approves or rejects it
  → approve: the ticket is created and checked like a Raise Request from the portal
  → opening acknowledgement queued to the sender (with the /track/<token> link)
  → closing acknowledgement queued when the ticket is closed
```

Other status changes are not emailed; the customer follows them on the tracking page.
Tickets raised in the portal are never emailed.

## Attachments

Every file attached to the email is fetched with it (images embedded in the body, such as
signature logos, are not). Each is checked as B2C email attachments are: PDF, JPG, PNG, HEIC
or TXT only, contents that match the type (a renamed file is refused), up to 10 MB, and the
first 10 files. Accepted files are stored under a random name in `uploads/`; refused ones are
listed on the request as *Not imported* with the reason, so the reviewer can open the email in
the mailbox for them.

On approval every stored file goes with the ticket: photos as its images (shown under
Evidence) and other files, such as an invoice PDF, as its attachments (listed under Evidence on
the service and corporate ticket pages).

**Claude reads the attachments with the email** (`backend/src/attachmentReading.js`): PDFs as
documents, JPG/PNG/GIF/WEBP photos as images and text files as text, up to 5 files and 20 MB
per email. HEIC photos cannot be read by Claude and are listed as *Not read*. Serial numbers,
asset IDs, models, the invoice number and purchase date found in the files fill the draft like
those in the email text; *What Claude found* lists the files read and a note of what they
showed. The files are treated as data from the sender, never as instructions. B2C escalations
read attachments the same way (see `docs/b2c-escalations.md`).

## Acknowledgement emails

Each acknowledgement goes to the address the request came from, as a reply in that email's
thread (`Re: <original subject>`). They are queued in the `ticketemails` collection and sent
after the ticket update is saved, so a mail problem never blocks the ticket.

- Up to 5 attempts, waiting 2, 4, 8 and 16 minutes between them; then `failed`, with the
  reason in `lastError`.
- Not sent when the sender is the request inbox itself, or when no sender is configured.
- The tracking link uses the first address in `FRONTEND_URLS`.

### How they are sent

| Setting | Route |
| --- | --- |
| `B2B_EMAIL_API_KEY` set | Brevo's HTTPS API (`api.brevo.com`, port 443) |
| Only `B2B_EMAIL_SMTP_HOST` set | SMTP, logged in as `B2B_EMAIL_USER` |
| Neither | Acknowledgements are off |

**Render's free plan blocks outgoing SMTP** (ports 25, 465 and 587 time out), so the live
backend uses Brevo. Reading the inbox over IMAP (port 993) is not affected.

With Brevo, the sender is `B2B_EMAIL_FROM_ADDRESS`, or `B2B_EMAIL_USER` when it is empty.
That address must be a verified sender (or on an authenticated domain) in the Brevo
account. When it differs from the inbox, `Reply-To` is set to `B2B_EMAIL_USER`, so customer
replies still come back to the request inbox.

On startup the server logs which route it uses, for example:

```
[Ticket emails] Sending opening and closing acknowledgements from test2@aavoraa.com via Brevo as sender@example.com.
```

`via SMTP` on Render means the Brevo key was not picked up.

## Settings

Locally the settings live in their own file, `backend/.env.b2b-email` (copy
`backend/.env.b2b-email.example`; the file is git-ignored). They are kept apart from
`backend/.env` and the B2C settings. Where the file does not exist, as on Render, the same
names are read from the environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `B2B_EMAIL_IMAP_HOST`, `B2B_EMAIL_USER`, `B2B_EMAIL_PASSWORD` | — (required) | The request mailbox. Use its own mailbox, not the B2C inbox |
| `B2B_EMAIL_IMAP_PORT`, `B2B_EMAIL_IMAP_SECURE`, `B2B_EMAIL_MAILBOX` | `993`, `true`, `INBOX` | IMAP connection |
| `B2B_EMAIL_POLL_MINUTES` | `2` | How often the inbox is checked |
| `B2B_EMAIL_API_KEY` | — | Brevo API key (`xkeysib-…`, not the SMTP key). When set, Brevo is used instead of SMTP |
| `B2B_EMAIL_FROM_ADDRESS` | — | Optional Brevo-verified sender different from `B2B_EMAIL_USER` |
| `B2B_EMAIL_API_TIMEOUT_MS` | `20000` | Brevo request timeout |
| `B2B_EMAIL_SMTP_HOST`, `B2B_EMAIL_SMTP_PORT`, `B2B_EMAIL_SMTP_SECURE` | —, `465`, `true` | SMTP route, when Brevo is not used |
| `B2B_EMAIL_FROM_NAME` | `iPlanet Service` | Sender display name |
| `ANTHROPIC_API_KEY` (in `backend/.env`) | — | Claude drafting. Without it, drafts arrive empty and are filled in by hand |

## Brevo setup

1. Sign up at brevo.com. The signup address is already a verified sender.
2. **SMTP & API → API Keys → Generate a new API key.** Copy it once; it is shown only then.
3. To send from another address, add it under **Senders, Domains & Dedicated IPs** and verify
   it. A domain whose DMARC policy is `quarantine` or `reject` (such as aavoraa.com) must be
   authenticated in Brevo first; free mail addresses with `p=none` (Gmail, Outlook) can be
   used as they are.
4. On Render (**iplanet-backend → Environment**) set `B2B_EMAIL_API_KEY` and, if needed,
   `B2B_EMAIL_FROM_ADDRESS`, then **Save, rebuild, and deploy**.
5. Check the startup log for `via Brevo`, send a test request from another address, approve
   it, and look in **Brevo → Transactional → Logs**.

The free Brevo plan allows 300 emails a day. Mail from a free address sent through Brevo may
land in spam; authenticating your own domain in Brevo fixes this, with no code change.

## Tests

`npm --prefix backend run test:email` covers Claude's output normalisation, the inbox check,
review and approval routes, and the acknowledgement queue with fake SMTP and Brevo senders.
It needs a reachable MongoDB; no real email or Claude request is made.
