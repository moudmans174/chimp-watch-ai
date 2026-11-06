from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import HTMLResponse, PlainTextResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..db import get_db
from ..models import (
    Alert,
    AlertStatus,
    FieldTask,
    HabitatMetric,
    Observation,
    PressureEvent,
    ProtectedArea,
    RiskAssessment,
    TaskStatus,
    User,
    ValidationStatus,
)
from ..schemas import AssessmentOut
from ..security import can_analyse, get_current_user
from ..services import gbif, importers, reporting, risk

router = APIRouter(prefix="/api", tags=["analytics & reporting"])


@router.post("/analytics/run")
def run_analytics(request: Request, area_id: int | None = None, db: Session = Depends(get_db),
                  user: User = Depends(can_analyse)):
    if area_id:
        area = db.get(ProtectedArea, area_id)
        if not area:
            raise HTTPException(404, "Area not found")
        ra = risk.assess_area(db, area)
        alerts = risk.generate_alerts(db, ra)
        result = {"assessed": 1, "alerts_created_or_escalated": len(alerts), "levels": {area.name: ra.overall_level.value}}
    else:
        result = risk.run_all(db)
    audit.record(db, user, "run", "risk_assessment", area_id, result, request)
    db.commit()
    return result


@router.get("/analytics/latest", response_model=list[AssessmentOut])
def latest(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return risk.latest_assessments(db)


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    now = datetime.now(timezone.utc)
    year_ago = now - timedelta(days=365)
    obs_counts = dict(db.execute(select(Observation.validation_status, func.count()).group_by(Observation.validation_status)).all())
    chimp_12m = db.scalar(select(func.count()).where(
        Observation.species.like("Pan troglodytes%"), Observation.validation_status == ValidationStatus.verified,
        Observation.observed_at >= year_ago)) or 0
    chimp_prev = db.scalar(select(func.count()).where(
        Observation.species.like("Pan troglodytes%"), Observation.validation_status == ValidationStatus.verified,
        Observation.observed_at >= year_ago - timedelta(days=365), Observation.observed_at < year_ago)) or 0
    open_alerts = dict(db.execute(select(Alert.level, func.count()).where(
        Alert.status.in_(risk.OPEN_STATUSES)).group_by(Alert.level)).all())
    species = db.scalar(select(func.count(func.distinct(Observation.species))).where(
        Observation.validation_status == ValidationStatus.verified)) or 0

    # habitat: latest metric per area
    sub = select(HabitatMetric.area_id, func.max(HabitatMetric.period_start).label("p")).group_by(HabitatMetric.area_id).subquery()
    latest_hab = db.scalars(select(HabitatMetric).join(sub, (HabitatMetric.area_id == sub.c.area_id) &
                                                       (HabitatMetric.period_start == sub.c.p))).all()
    cover = sum(h.forest_cover_km2 for h in latest_hab)
    loss = sum(h.forest_loss_km2 for h in latest_hab)
    frag = [h.fragmentation_index for h in latest_hab if h.fragmentation_index is not None]
    pressures_90 = db.scalar(select(func.count()).where(PressureEvent.observed_at >= now - timedelta(days=90),
                                                        PressureEvent.validation_status != ValidationStatus.rejected)) or 0
    tasks_open = db.scalar(select(func.count()).where(FieldTask.status.in_([TaskStatus.open, TaskStatus.in_progress]))) or 0
    my_tasks = db.scalar(select(func.count()).where(FieldTask.assigned_to == user.id,
                                                   FieldTask.status.in_([TaskStatus.open, TaskStatus.in_progress]))) or 0

    assessments = risk.latest_assessments(db)
    comp_avgs = {}
    for key in risk.INDICATORS:
        vals = [ra.components[key]["score"] for ra in assessments if ra.components.get(key, {}).get("score") is not None]
        comp_avgs[key] = round(sum(vals) / len(vals), 1) if vals else None

    # monthly verified chimp records, last 24 months
    month = func.date_trunc("month", Observation.observed_at)
    monthly = db.execute(select(month.label("m"), func.count()).where(
        Observation.species.like("Pan troglodytes%"), Observation.validation_status == ValidationStatus.verified,
        Observation.observed_at >= now - timedelta(days=730)).group_by("m").order_by("m")).all()

    return {
        "observations": {k.value: v for k, v in obs_counts.items()},
        "chimp_records_12m": chimp_12m,
        "chimp_records_prev_12m": chimp_prev,
        "verified_species": species,
        "open_alerts": {k.value: v for k, v in open_alerts.items()},
        "habitat": {"forest_cover_km2": round(cover, 1), "forest_loss_km2_latest": round(loss, 1),
                    "loss_rate_pct": round(loss / (cover + loss) * 100, 2) if cover else None,
                    "mean_fragmentation": round(sum(frag) / len(frag), 2) if frag else None,
                    "latest_period": max((h.period_start for h in latest_hab), default=None)},
        "pressures_90d": pressures_90,
        "tasks_open": tasks_open,
        "my_open_tasks": my_tasks,
        "indicator_means": comp_avgs,
        "areas": [{"area_id": ra.area_id, "area": ra.area.name, "level": ra.overall_level.value,
                   "computed_at": ra.computed_at, "scores": {k: c.get("score") for k, c in ra.components.items()},
                   "levels": {k: c.get("level") for k, c in ra.components.items()}} for ra in assessments],
        "monthly_chimp_records": [{"month": m.strftime("%Y-%m"), "count": n} for m, n in monthly],
        "last_assessment": max((ra.computed_at for ra in assessments), default=None),
    }


# ---------- reports ----------
@router.get("/reports/summary")
def report_summary(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return reporting.summary(db, risk.latest_assessments(db))


@router.get("/reports/summary.html", response_class=HTMLResponse)
def report_summary_html(request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    data = reporting.summary(db, risk.latest_assessments(db))
    audit.record(db, user, "export", "report", None, {"type": "summary_html"}, request)
    db.commit()
    return reporting.summary_html(data, user.org.name if user.org else "")


@router.get("/reports/area/{area_id}")
def report_area(area_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    area = db.get(ProtectedArea, area_id)
    if not area:
        raise HTTPException(404, "Area not found")
    ra = db.scalars(select(RiskAssessment).where(RiskAssessment.area_id == area_id)
                    .order_by(RiskAssessment.computed_at.desc())).first()
    alerts = db.scalars(select(Alert).where(Alert.area_id == area_id, Alert.status.in_(risk.OPEN_STATUSES))).all()
    return {"area": area.name, "narrative": reporting.area_narrative(area, ra),
            "assessment": AssessmentOut.model_validate(ra).model_dump(mode="json") if ra else None,
            "open_alerts": [{"id": a.id, "title": a.title, "level": a.level.value, "status": a.status.value} for a in alerts]}


# ---------- imports ----------
@router.get("/imports/templates/{kind}.csv", response_class=PlainTextResponse)
def import_template(kind: str, _: User = Depends(get_current_user)):
    if kind not in importers.TEMPLATES:
        raise HTTPException(404, "Unknown template")
    return PlainTextResponse(",".join(importers.TEMPLATES[kind]) + "\n", media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename={kind}_template.csv"})


@router.post("/imports/{kind}")
async def import_data(kind: str, request: Request, file: UploadFile = File(...), db: Session = Depends(get_db),
                      user: User = Depends(can_analyse)):
    content = await file.read(20 * 1024 * 1024 + 1)
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(413, "CSV exceeds 20 MB")
    try:
        result = importers.import_csv(db, kind, content, user.org_id, user.id)
    except importers.ImportError_ as exc:
        db.rollback()
        raise HTTPException(422, {"message": "Import failed; no rows were saved", "errors": exc.errors})
    except UnicodeDecodeError:
        raise HTTPException(422, "File must be UTF-8 encoded CSV")
    audit.record(db, user, "import", kind, None, {**result, "filename": file.filename}, request)
    db.commit()
    return result


@router.post("/integrations/gbif/import")
def gbif_import(request: Request, scientific_name: str = Query("Pan troglodytes verus"), limit: int = Query(300, le=3000),
                db: Session = Depends(get_db), user: User = Depends(can_analyse)):
    try:
        records = gbif.fetch(scientific_name, limit)
    except Exception as exc:
        raise HTTPException(502, f"GBIF request failed: {exc}")
    result = gbif.import_records(db, records, user.org_id)
    audit.record(db, user, "import", "gbif", None, {"scientific_name": scientific_name, **result}, request)
    db.commit()
    return result
