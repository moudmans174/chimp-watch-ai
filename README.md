# CHIMP-WATCH AI

Chimpanzee conservation, ecosystem intelligence and food-security early-warning platform, built from the *CHIMP-WATCH AI Project Concept & Development Proposal* (Sierra Leone pilot, November 2026).

This is the MVP described in §10 of the proposal: a responsive web app and offline-capable field PWA, a FastAPI + PostGIS backend, an early-warning engine with configurable thresholds, alert and field-task workflows, reporting, data imports, and the governance safeguards from §8.

> **Demo data is synthetic.** The seed script creates six pilot landscapes with *approximate* outlines around real Sierra Leone parks, plus generated surveys, observations, land-cover and indicator data, all labelled `demo`. Replace it with WDPA boundaries and real survey records before any operational use.

## What's in it

| Proposal module | Implementation |
|---|---|
| Chimpanzee population monitoring | Observations with evidence type, group composition, GPS accuracy and ID confidence; survey-effort records; quarterly encounter rates (verified signs per km); trend and 4-quarter forecast |
| Habitat & land-cover | Annual forest cover/loss, fragmentation and suitability per area (CSV import; pattern after Hansen GFC / GFW); mapped pressure reports (mining, logging, snares, etc.) |
| Biodiversity intelligence | Camera-trap species records and species-richness trends; pluggable image classifier (manual review or external HTTP inference service) |
| Ecosystem & food security | NDVI anomaly, water quality and soil-erosion indicators per area; district IPC phase, crop vulnerability and rainfall anomaly, shown as *context only* |
| Early warning & decision support | Five separate risk indicators per area, expert-configurable thresholds, low/medium/high alerts, alert review workflow, field tasks, situation reports |
| Field data collection | Installable PWA; offline queue in IndexedDB with idempotent sync; GPS capture; photo upload with EXIF/GPS stripped |
| GIS dashboard | OpenLayers map with risk-coloured protected areas, chimpanzee records, wildlife and pressure layers, OSM or satellite basemap |

### Analytical method (`backend/app/services/analytics.py`, `risk.py`)

- **Population trend:** a quasi-Poisson GLM of verified sign counts with log(survey km) as an offset. Annual change is reported with a 90% CI. Quarters with no survey effort count as missing, not zero. Quarters where more than 20% of records are still pending validation are excluded until they are reviewed.
- **Five indicators, never blended:** population concern (modelled), habitat pressure, biodiversity change, ecosystem condition, and food-security vulnerability (observed). Each one carries a score from 0 to 100, a level, a confidence label, its data date and its drivers.
- **Safeguards from §5–6 of the proposal:**
  - A low-confidence indicator is capped at *medium*.
  - The overall *high* level needs two or more elevated conservation indicators.
  - Modelled alerts are labelled "not a confirmed population count".
  - Food security is excluded from the overall level and always carries a caveat that it is not caused by chimpanzee decline.
  - Every output records the model version and input-data date.

These are baseline methods for the MVP. Per the proposal, conservation specialists must validate and calibrate them against real survey data.

### Governance & security (§8)

- JWT auth with bcrypt. Account lockout after 5 failed sign-ins, plus per-IP login rate limiting (Redis-backed).
- Four roles: admin, analyst, field monitor and viewer. Analysts can validate records from their own organisation only.
- **Sensitive-location generalisation:** chimpanzee coordinates are snapped to a ~11 km grid cell for anyone without explicit sensitive-location access. This applies to the API, map, GeoJSON and CSV exports. Observers always see their own records precisely.
- Photo uploads are checked by magic bytes and re-encoded to remove EXIF (including embedded GPS).
- Full audit log covering logins, validations, threshold changes, exports, imports and alert decisions.
- Mandatory review notes before an alert can be verified, dismissed or resolved. Explicit alert state machine.
- Production mode refuses to start with a default secret, disables the API docs, and adds HSTS and a CSP (nginx).

## Run it

### Docker (recommended)

```bash
cp .env.example .env      # set POSTGRES_PASSWORD, CW_SECRET_KEY, CW_CORS_ORIGINS
# optional: CW_SEED_DEMO=true to load the synthetic Sierra Leone pilot
docker compose up -d --build
open http://localhost:8090
```

Services: `db` (PostGIS 16), `redis`, `api` (FastAPI/gunicorn; runs migrations on start; photos on the `media` volume, or any S3-compatible store via `CW_STORAGE_BACKEND=s3`), `worker` (re-runs the risk assessment every 6 h), `web` (nginx serving the PWA and proxying `/api`). Put a TLS-terminating proxy in front for production.

### Local development

```bash
# backend (needs PostgreSQL with PostGIS)
cd backend
pip install -r requirements-dev.txt
export CW_DATABASE_URL=postgresql+psycopg://chimp:chimp@localhost:5432/chimpwatch
alembic upgrade head
python -m app.seed                 # synthetic demo data
uvicorn app.main:app --reload      # API docs at http://localhost:8000/api/docs

# frontend
cd frontend
npm install
npm run dev                        # http://localhost:5173 (proxies /api to :8000)
```

Demo accounts (password `ChimpWatch!2026`): `admin@`, `analyst@`, `ranger@`, `viewer@chimpwatch.example`. The ranger and viewer accounts see generalised chimpanzee locations.

### Tests

```bash
cd backend && pytest -q    # 55 tests; needs a chimpwatch_test PostGIS database
```

They cover auth and lockout, the Google/Apple/GitHub sign-in flows (state, nonce, email verification, approval), RBAC, location generalisation in every output, offline sync idempotency, EXIF stripping, the trend model, low-confidence capping, the alert state machine, field tasks, threshold auditing, all-or-nothing CSV imports, GBIF import and report content. CI (`.github/workflows/ci.yml`) also checks for migration drift and builds the frontend.

## Public page and sign-in with Google, Apple or GitHub

Signed-out visitors land on a public page at `/welcome` with **Sign in** and **Sign up**. Both offer *Continue with Google / Apple / GitHub*. Sign-up also has an email form where people enter their full name, email, password, organisation, the access they need (field monitor, analyst or viewer), an optional phone number and why they need access, and agree to the data-use terms. Sign-in accepts email and password.

**Sign-up always needs approval.** Every new sign-up, by email or through Google, Apple or GitHub, creates a *pending* viewer account with no access to data. Administrators see it under **Admin → Users → Access requests**, where they see the details the person entered (visible to administrators only), choose an organisation and role, and approve or decline. The email sign-up endpoint is rate-limited (5 per hour per network) and gives the same response for already-registered emails, so it can't be used to find out who has an account. If a provider confirms a **verified** email that matches an existing account, the two are linked automatically. Unverified emails are never linked.

Each provider's button is enabled once its credentials are in `.env`; otherwise it shows as unavailable. Callback URL pattern: `{CW_PUBLIC_URL}/api/auth/oauth/<provider>/callback`.

| Provider | Where to register | Callback URL to enter | `.env` values |
|---|---|---|---|
| Google | Google Cloud Console → APIs & Services → Credentials → *Create OAuth client ID* (Web application). Configure the consent screen with scopes `openid`, `email`, `profile`. | `http://localhost:8090/api/auth/oauth/google/callback` | `CW_GOOGLE_CLIENT_ID`, `CW_GOOGLE_CLIENT_SECRET` |
| GitHub | GitHub → Settings → Developer settings → OAuth Apps → *New OAuth App* | `http://localhost:8090/api/auth/oauth/github/callback` | `CW_GITHUB_CLIENT_ID`, `CW_GITHUB_CLIENT_SECRET` |
| Apple | Apple Developer → Identifiers → *Services ID* (enable Sign in with Apple and add your domain and return URL), plus Keys → a *Sign in with Apple* key (.p8). Requires a paid Apple Developer account. | `https://YOUR-DOMAIN/api/auth/oauth/apple/callback` | `CW_APPLE_CLIENT_ID` (the Services ID), `CW_APPLE_TEAM_ID`, `CW_APPLE_KEY_ID`, `CW_APPLE_PRIVATE_KEY` |

Apple does not accept `localhost` or plain `http` return URLs, so Apple sign-in only works once the site runs on a real HTTPS domain. Google and GitHub work on `http://localhost:8090` for local testing. In production, set `CW_PUBLIC_URL` to your HTTPS address and update each provider's callback URL to match.

Security details: the authorization-code flow uses a signed, short-lived state cookie (CSRF protection), PKCE for Google and GitHub, and a nonce for Google and Apple. ID-token issuer, audience, expiry and nonce are all checked. The resulting session token is passed to the browser in the URL fragment, which is never sent to servers or logged, and is removed from the address bar immediately. Sign-ups, links, approvals and failed attempts all go to the audit log.

## Operating the platform

### Administrator command-line tools

Run these inside the API container (`docker compose exec api ...`) or in `backend/` locally:

| Command | What it does |
|---|---|
| `python -m app.manage create-admin --email you@org --name "Your Name"` | Create (or promote) an administrator. You're prompted for the password. |
| `python -m app.manage reset-password --email someone@org` | Set a new password and unlock the account. Add `--activate` to also activate it. |
| `python -m app.manage list-users` | List every account with role and status. |
| `python -m app.manage test-email --to you@org` | Send a test email to check the SMTP settings. |
| `python -m app.manage run-assessment` | Recompute all risk assessments now (the worker also does this every 6 hours). |

### Email

Set the `CW_SMTP_*` values in `.env` (see `.env.example`) and restart. The platform then emails:
- **Administrators:** new access requests.
- **Requesters:** approval or decline.
- **Anyone who asks:** password-reset links, valid once and for one hour.
- **Analysts and administrators:** new or escalated **high** alerts.

Without SMTP, every email is written to the API log (`docker compose logs api`), so password resets still work during setup. Chimpanzee coordinates are never included in email.

### Field surveys and encounter rates

In **Add record**, a ranger starts a survey (landscape, method, team), records signs as usual, then taps **Finish survey** and enters the distance walked. Surveys and their records sync together when the device is online, and each carries a client ID, so retries never create duplicates. Encounter-rate trends use only signs recorded within surveys, divided by kilometres walked.

### Map

The map workspace has light, streets, satellite and terrain basemaps, a layer panel with record counts, clustered points, a density heatmap, landscape search, a time filter, scale bar, coordinate readout, "my location", "zoom to all" and full screen. Click a landscape to open its details panel. Basemap tiles come from Esri (light grey canvas and satellite), OpenStreetMap (streets) and OpenTopoMap (terrain); none need an API key. (CARTO's raster tiles have required a free API key since September 2026, so they're no longer used by default.) These free services have fair-use limits. For heavy production use, take a commercial tile plan (for example Esri, CARTO, MapTiler or Mapbox) and change the URLs in `frontend/src/components/MapView.tsx`.

### Landscapes and organisations

Administrators can add organisations and landscapes under **Admin**. For a landscape, upload its boundary as GeoJSON in WGS84 (for example exported from QGIS, or downloaded from Protected Planet / WDPA), or replace an existing boundary. Then run an assessment to compute indicators.

## Data in

- **CSV import** (Reports → Import data): observations, habitat metrics and indicators. Templates are downloadable. Imports are all-or-nothing with row-level errors, and future dates are rejected.
- **GBIF:** imports georeferenced occurrences for the configured country. They keep their licence and enter the validation queue as *pending*.
- **Camera-trap AI:** set `CW_CLASSIFIER_BACKEND=http` and `CW_CLASSIFIER_URL` to an inference service returning `{model_version, detections:[{label, confidence, bbox}]}` (e.g. MegaDetector or a fine-tuned YOLO). No weights are bundled, and detections always need expert confirmation.

## Not yet included (next steps from the proposal)

- Direct Sentinel/Landsat raster processing and GFW API pulls. Land-cover metrics currently arrive by CSV.
- Trained camera-trap models and individual re-identification.
- MFA, SMS notifications, and multi-country tenancy configuration.
- Expert calibration of thresholds and model validation against real pilot data (§11).

## Layout

```
backend/   FastAPI app (app/), Alembic migrations, tests, Dockerfile
frontend/  React + TypeScript + OpenLayers PWA, nginx config, Dockerfile
docker-compose.yml, .env.example, .github/workflows/ci.yml
```
