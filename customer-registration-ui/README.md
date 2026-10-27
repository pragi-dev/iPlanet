# Customer Registration UI

A standalone React + Vite page where a B2C customer registers themselves and their mobile
device. It is separate from the main portal in `frontend/`: it has its own package manifest,
Vite config, entry point and stylesheet, and it imports nothing from `frontend/` or `backend/`.

| | Main portal (`frontend/`) | Customer Registration UI |
| --- | --- | --- |
| Dev port | 5173 | **5174** (`strictPort`) |
| Preview port | Vite default | 4174 |
| Start | `npm run frontend` | `npm run dev:customer-registration` |

## Install and run

```bash
# once
npm --prefix customer-registration-ui install

# from the repository root
npm run dev:customer-registration      # http://localhost:5174
npm run build:customer-registration    # builds to customer-registration-ui/dist

# or inside the folder
cd customer-registration-ui && npm run dev
```

Both apps can run at the same time. If port 5174 is taken, Vite stops with an error instead
of moving to another port; change `server.port` in `vite.config.js` to use a different one.
`npm run dev` at the root does **not** start this app; start it separately.

## Modes

Set `VITE_REGISTRATION_MODE` in `customer-registration-ui/.env.local` (see `.env.example`).

- **`demo`** (default). Everything happens in the browser: the form is validated and a
  simulated reference (`DEMO-XXXXXX`) is shown. No network request is made, nothing is
  saved, no email is sent and no ticket or token is created. The page shows a *Demo mode*
  badge and banner, and the confirmation says plainly that nothing was saved. In a demo build
  the API code is removed from the bundle entirely.
- **`api`**. Uses the existing public B2C endpoints documented in
  [docs/b2c-customer-registration.md](../docs/b2c-customer-registration.md):
  `GET` / `POST /api/b2c/public/registration/:token`. The page only works when opened from a
  registration link (`/b2c/customer-registration/<token>`); without a token it shows
  "A registration link is required". In development `/api/b2c` is proxied to the local B2C
  server (`B2C_DEV_TARGET`, default `http://localhost:5100`). Set
  `VITE_REGISTRATION_API_BASE` only to point at a server you mean to use. Port 5174 is already in the
  backend's default CORS allowlist (`backend/src/corsPolicy.js`).

All outside calls are in `src/service/registrationService.js`. The page never calls
`fetch` directly, so the backend connection can change without touching the form.

## Fields and validation

The fields, labels, required flags, length limits and checks are copied from
`REGISTRATION_FIELDS` / `validateRegistration` in `backend/src/b2c/registration.js` (see
`src/fields.js`), so the form asks for exactly what the backend accepts:

- Customer: full name*, email*, mobile number*
- Device: serial number, model
- Purchase: purchase date, store or city of purchase*, purchase region, dealer or retailer,
  invoice or order number
- Confirmation that the details are accurate*

The backend also accepts an alternate phone number and a brand; this form does not ask for them.
The serial number and purchase date are optional, but are checked when given.

Phone numbers follow the backend rule: Indian numbers with or without `+91` / a leading `0`,
or international numbers of 10–15 digits. The purchase date cannot be in the future or before
2000. In api mode the server repeats every check and its field errors are shown inline.

Without a serial number the server cannot find the device, so it has no region. A customer whose
details match an existing customer record is verified, and their ticket goes to manual triage. A
new customer without a serial number goes to manual review, because each customer record is one
purchase and needs a serial number.

## Service journey

After a successful submission, the confirmation page shows a **Service journey** panel on the
right (below the message on screens narrower than 900px):

- **Details submitted:** done, with the time the submission was confirmed.
- **Details verified:** current stage.
- **Request created** and **Engineer assigned:** upcoming, with no times.

The server gives the same answer whether or not the details were verified, so the form cannot be
used to test what is on record. The page therefore never shows verification, ticket creation or
assignment as done. The steps are in `src/registrationJourney.js`.

## Design system

`src/styles.css` contains copies of the portal's design tokens (colours, radii, shadows,
spacing, the SF system font stack) and its button, badge, form-field and inline-alert rules
from `frontend/src/ui/styles.css`. The page layout follows the portal's own registration page
(`.b2c-register-*` in `frontend/src/ui/b2c.css`), using the same 767px and 640px breakpoints.
`src/components.jsx` copies `Button`, `Field` and `InlineAlert` from
`frontend/src/ui/primitives.jsx`, so the markup and class names match. Icons come from
`lucide-react`, as in the portal.

These are **copies**: a change to the portal's tokens is not picked up automatically.
The portal has no dark theme, so this page has none either.

## Limitations

- Demo mode only simulates a submission; it does not test against the backend.
- The "Email me a new link" action for expired links (in the portal's built-in page) is not
  included; an expired link tells the customer to reply to the support email.
- Demo-mode purchase regions are sample values; in api mode they come from the device records.
- There is no logo image in the repository; the header uses the portal's "i" brand mark.
- The main portal already serves the same form at `/b2c/customer-registration/:token`
  (`frontend/src/b2c/CustomerRegistration.jsx`). This app does not replace it. Decide which
  one customers should use before going live.
