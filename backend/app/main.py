import logging
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .config import get_settings
from .db import SessionLocal
from .ratelimit import limiter
from .routers import admin, alerts, analytics, areas, auth, field, notifications, observations

settings = get_settings()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("chimpwatch")

app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    description="Chimpanzee conservation, ecosystem intelligence and food-security early-warning platform.",
    docs_url=None if settings.is_production else "/api/docs",
    redoc_url=None,
    openapi_url=None if settings.is_production else "/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def security_and_logging(request: Request, call_next):
    if request.url.path == "/api/auth/login" and request.method == "POST":
        ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0]
        if not limiter.allow(f"login:{ip}", settings.login_rate_limit_per_minute, 60):
            return JSONResponse({"detail": "Too many sign-in attempts. Wait a minute and try again."}, status_code=429)
    start = time.perf_counter()
    response = await call_next(request)
    ms = (time.perf_counter() - start) * 1000
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(self), camera=(self)"
    if request.url.path.startswith("/api/") and not request.url.path.startswith("/api/docs"):
        response.headers.setdefault("Cache-Control", "no-store")
    if settings.is_production:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    log.info("%s %s %s %.0fms", request.method, request.url.path, response.status_code, ms)
    return response


for r in (auth.router, admin.router, areas.router, observations.router, alerts.router, analytics.router,
          field.router, notifications.router):
    app.include_router(r)


@app.get("/api/health", tags=["ops"])
def health():
    db_ok = True
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
    except Exception:
        db_ok = False
    return JSONResponse({"status": "ok" if db_ok else "degraded", "database": db_ok, "version": app.version},
                        status_code=200 if db_ok else 503)


@app.get("/api/meta", tags=["ops"])
def meta():
    from .models import AlertLevel, AlertStatus, EvidenceType, Role, TaskStatus
    from .routers.areas import PRESSURE_KINDS
    from .routers.field import CONFLICT_KINDS, CONFLICT_SPECIES, OUTREACH_KINDS
    from .services.risk import INDICATORS
    return {
        "evidence_types": [e.value for e in EvidenceType],
        "roles": [r.value for r in Role],
        "alert_levels": [lv.value for lv in AlertLevel],
        "alert_statuses": [s.value for s in AlertStatus],
        "task_statuses": [s.value for s in TaskStatus],
        "pressure_kinds": sorted(PRESSURE_KINDS),
        "conflict_species": list(CONFLICT_SPECIES),
        "conflict_kinds": list(CONFLICT_KINDS),
        "outreach_kinds": list(OUTREACH_KINDS),
        "indicators": INDICATORS,
        "model_version": settings.risk_model_version,
        "generalisation_km": round(settings.location_generalisation_deg * 111, 1),
    }
