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
cp .env.example .env      # set POSTGRES_PASSWORD, MINIO_*, CW_SECRET_KEY, CW_CORS_ORIGINS
# optional: CW_SEED_DEMO=true to load the synthetic Sierra Leone pilot
docker compose up -d --build
open http://localhost:8080
```

Services: `db` (PostGIS 16), `redis`, `minio` (photo storage), `api` (FastAPI/gunicorn; runs migrations on start), `worker` (re-runs the risk assessment every 6 h), `web` (nginx serving the PWA and proxying `/api`). Put a TLS-terminating proxy in front for production.

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
cd backend && pytest -q    # 31 tests; needs a chimpwatch_test PostGIS database
```

They cover auth and lockout, RBAC, location generalisation in every output, offline sync idempotency, EXIF stripping, the trend model, low-confidence capping, the alert state machine, field tasks, threshold auditing, all-or-nothing CSV imports, GBIF import and report content. CI (`.github/workflows/ci.yml`) also checks for migration drift and builds the frontend.

## Data in

- **CSV import** (Reports → Import data): observations, habitat metrics and indicators. Templates are downloadable. Imports are all-or-nothing with row-level errors, and future dates are rejected.
- **GBIF:** imports georeferenced occurrences for the configured country. They keep their licence and enter the validation queue as *pending*.
- **Camera-trap AI:** set `CW_CLASSIFIER_BACKEND=http` and `CW_CLASSIFIER_URL` to an inference service returning `{model_version, detections:[{label, confidence, bbox}]}` (e.g. MegaDetector or a fine-tuned YOLO). No weights are bundled, and detections always need expert confirmation.

## Not yet included (next steps from the proposal)

- Direct Sentinel/Landsat raster processing and GFW API pulls. Land-cover metrics currently arrive by CSV.
- Trained camera-trap models and individual re-identification.
- MFA, email/SMS notification delivery, and multi-country tenancy configuration.
- Expert calibration of thresholds and model validation against real pilot data (§11).

## Layout

```
backend/   FastAPI app (app/), Alembic migrations, tests, Dockerfile
frontend/  React + TypeScript + OpenLayers PWA, nginx config, Dockerfile
docker-compose.yml, .env.example, .github/workflows/ci.yml
```
