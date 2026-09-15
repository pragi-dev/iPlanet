# Apple Self-Care Portal

Confidential local-only prototype with one role-aware React frontend and one shared Express/MongoDB API.

## Structure

- `frontend/`: Unified React frontend on port 5173. It preserves both existing portal experiences behind role-protected routes.
- `frontend/src/corporate/`: Corporate Admin pages, components, API, and styles.
- `frontend/src/service/`: iPlanet Service pages, components, API, and styles.
- `backend/`: Shared API on port 5000.
- `database/`: Local MongoDB notes.
- `uploads/`: Local uploaded service-request images.
- `render.yaml`: Render blueprint for the production backend service.

## Run locally

Start MongoDB Community Edition at `mongodb://127.0.0.1:27017`, then from the repository root:

```powershell
npm install
cd backend
npm install
npm run seed
cd ..
cd frontend
npm install
cd ..
```

Run the unified application and backend:

```powershell
npm run backend
npm run frontend
```

Or start both services with:

```powershell
npm run dev
```

Open:

- Login: `http://localhost:5173/login`
- Corporate Admin: `http://localhost:5173/corporate/dashboard`
- iPlanet Service: `http://localhost:5173/service/dashboard`
- Shared API: `http://localhost:5000`

## Demo accounts

Corporate Admin:

```text
admin@corporate.local
Demo@123
```

iPlanet Service:

```text
service@iplanet.local
Demo@123
```

There are exactly two top-level roles: `corporate_admin` and `iplanet_service`. Engineer assignment is workflow data inside the iPlanet Service portal, not a separate login role.

## Complete demo dataset

Run the persistent MongoDB demo seed with:

```powershell
npm --prefix backend run seed:demo
```

The seed creates connected records for 3 companies, 4 service centres, 6 Corporate Admin users, 1 service-desk user, 6 service-role engineer accounts, 16 devices, 25 device-master enrollment records, 6 engineers, 21 tickets, 97 chronological timeline events, 42 notifications, 6 call records, and 4 escalation rules. It validates company, device, ticket, and engineer references before completing.

Enrollment serials include `SAMPLE12345`, `SAMPLE98765`, `ENROLL-IP15-001`, `ENROLL-IP15-002`, `ENROLL-IP14-001`, `ENROLL-MBA-001`, `ENROLL-MBP-001`, `ENROLL-IPAD-001`, and `ENROLL-IPAD-002`.

The existing schema does not have separate Branch, Employee, Warranty, AMC Contract, Model Number, Operating System, IMEI, Purchase Price, Engineer Skill, or User Address collections/fields. The seed stores supported employee, location, warranty, AMC, device, and engineer information in the existing fields rather than inventing a parallel schema.

## Demo workflow

1. Open the single login screen and sign in with either supported account.
2. Use My Devices or Raise Request to create a ticket. Seeded demo ticket `SR-1024` is available.
3. The iPlanet Service account opens the service dashboard and Service Requests.
4. Review `SR-1024`, assign a Service Engineer, and update its workflow.
5. Refresh the Corporate Admin ticket to see the same shared status and timeline.
6. Use Device Enrollment with `SAMPLE98765` to look up the local device master, assign employee/department/location, and enroll it.
7. Refresh Corporate Admin My Devices to see the enrolled device.

Available enrollment demo serial numbers:

```text
SAMPLE12345
SAMPLE98765
ENROLL-IP15-001
ENROLL-IP15-002
ENROLL-IP14-001
ENROLL-MBA-001
ENROLL-MBP-001
ENROLL-IPAD-001
ENROLL-IPAD-002
```

The iPlanet Service API also exposes the complete catalog at `GET /api/iplanet/device-master` for an authenticated service account.

Device responsibility is intentionally split: iPlanet Service assigns `Device -> Company` and leaves the device `Unassigned`; Corporate Admin receives the `New Device Added` notification and manages `Device -> Employee` from Unassigned Devices.

Everything uses sample data and local MongoDB only. No deployment, external APIs, cloud storage, or production credentials are used.

## AI Support Engine foundation

The backend includes an isolated iPlanetCare AI Support Engine for safe, Level-1 Apple-device guidance. It is separate from the existing ticket-bound troubleshooting flow and does not modify tickets, coverage, assignments, or the chatbot UI. Its local RAG foundation ranks concise, approved troubleshooting documents for battery drain, overheating, charging, Wi-Fi/connectivity, and performance before sending a request to the AI model. This keyword-based retriever has the same interface intended for a future embedding/vector implementation.

`POST /api/ai/support/chat` requires a Corporate Admin JWT (`Authorization: Bearer <token>`):

```json
{ "message": "My iPhone battery is draining very quickly" }
```

Successful responses are `{ "success": true, "reply": "..." }`. An optional `conversation` array of `{ "role": "user" | "assistant", "content": "..." }` supplies short-term context; no AI conversation is persisted yet.

Configure these backend environment variables in `backend/.env`: `AI_PROVIDER=gemini`, `GEMINI_API_KEY`, `GEMINI_MODEL`, optional `GEMINI_FALLBACK_MODEL`, `GEMINI_TIMEOUT_MS`, and optional local-only `AI_KNOWLEDGE_DEBUG=true`. API credentials and retrieval details stay in Express and are never sent to the React app.

Start the backend with `npm run backend`. After logging in to the Corporate portal, use its token to verify the endpoint:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:5000/api/ai/support/chat -Headers @{ Authorization = 'Bearer <corporate-admin-token>' } -ContentType 'application/json' -Body '{"message":"My iPhone is getting very hot and the battery is draining quickly"}'
```

The planned extension path is: Chatbot -> AI Support API -> AI Support Engine -> Knowledge Retrieval -> Portal Context -> AI Model -> Response. The current small troubleshooting modules and local retrieval are intentionally replaceable by a future vector database and MongoDB-backed context.

## Running with VS Code Port Forwarding

The browser must call the backend's forwarded URL when a portal is opened remotely. `localhost:5000` only works for a browser running on the development machine.

1. Start the backend and unified frontend:

   ```powershell
   npm run backend
   npm run frontend
   ```

2. In VS Code, forward ports `5000` and `5173`.
3. Copy the forwarded URL for port `5000`, then create/update these uncommitted files:

   ```text
   frontend/.env.local
   ```

   Set the same backend URL in both files (replace the placeholder with your actual port-5000 forwarding URL):

   ```dotenv
   VITE_API_URL=https://<backend-forwarded-url>/api
   ```

4. Add the forwarded frontend URL to `FRONTEND_URLS` in `backend/.env`, keeping the local origin too:

   ```dotenv
   FRONTEND_URLS=http://localhost:5173,https://<frontend-forwarded-url>
   ```

5. Restart the backend after changing `FRONTEND_URLS`, and restart the unified Vite frontend after changing `VITE_API_URL`.
6. Open the forwarded frontend URL. Verify the backend tunnel directly at:

   ```text
   https://<backend-forwarded-url>/api/health
   ```

   A successful response is `{ "success": true, "message": "API is running" }`. Log in with the normal demo accounts, load devices/tickets/notifications, then make a mutation such as assigning a device or saving an escalation rule. Refresh to confirm the MongoDB-backed change persists.

The unified frontend ships with a non-secret `.env` that sets `VITE_API_URL=http://localhost:5000/api` for local work. Use its ignored `.env.local` counterpart to override that value for a tunnel. The backend continues to connect to MongoDB Atlas; MongoDB is never exposed through a tunnel.

## Production deployment

### Backend on Render

This repository includes [render.yaml](render.yaml). In Render, create a Blueprint from the repository, or configure a Web Service with:

```text
Root directory: backend
Build command: npm install
Start command: npm start
Health check path: /api/health
```

Set these Render environment variables:

```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-host>/<database>?retryWrites=true&w=majority
JWT_SECRET=<long-random-secret>
FRONTEND_URLS=https://<your-vercel-app>.vercel.app
AI_PROVIDER=gemini
GEMINI_API_KEY=<server-only-gemini-key>
GEMINI_MODEL=gemini-3.6-flash
GEMINI_FALLBACK_MODEL=gemini-3.6-flash
GEMINI_TIMEOUT_MS=60000
```

Do not commit the real MongoDB URI, JWT secret, or Gemini key. Configure MongoDB Atlas Network Access to allow the Render service to connect.

### Frontend on Vercel

Create the Vercel project with `frontend` as its Root Directory. Vercel will use [frontend/vercel.json](frontend/vercel.json):

```text
Build command: npm run build
Output directory: dist
```

Set this Vercel environment variable for Production, Preview, and Development as needed:

```env
VITE_API_URL=https://<actual-render-service>.onrender.com/api
```

Use the exact backend URL shown in the Render service dashboard. Verify it first at `https://<actual-render-service>.onrender.com/api/health`; it must return `{ "success": true, "message": "API is running" }`.

After the Vercel URL is known, set that URL in Render's `FRONTEND_URLS` variable and redeploy the backend. The Vercel SPA rewrite keeps `/login`, `/corporate/*`, and `/service/*` routes working on refresh.
