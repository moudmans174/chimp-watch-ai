from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..db import get_db
from ..geo import geom_geojson, lonlat, multipolygon_from_geojson, point
from ..models import (
    EnvironmentalIndicator,
    HabitatMetric,
    Observation,
    PressureEvent,
    ProtectedArea,
    RiskAssessment,
    User,
    ValidationStatus,
)
from ..schemas import AreaIn, AreaOut, AreaUpdate, AssessmentOut, HabitatOut, IndicatorOut, PressureIn, PressureOut, ValidationIn
from ..security import admin_only, can_analyse, can_submit, get_current_user
from ..services import analytics
from ..services.spatial import assign_area, compute_area_km2

router = APIRouter(prefix="/api", tags=["areas & environment"])


@router.get("/areas", response_model=list[AreaOut])
def list_areas(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return db.scalars(select(ProtectedArea).order_by(ProtectedArea.name)).all()


@router.get("/areas.geojson")
def areas_geojson(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    from ..services.risk import latest_assessments
    levels = {ra.area_id: ra.overall_level.value for ra in latest_assessments(db)}
    rows = db.scalars(select(ProtectedArea)).all()
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": a.id, "geometry": geom_geojson(a.geom),
         "properties": {"id": a.id, "name": a.name, "designation": a.designation, "district": a.district,
                        "area_km2": a.area_km2, "risk_level": levels.get(a.id)}}
        for a in rows]}


@router.post("/areas", response_model=AreaOut, status_code=201)
def create_area(body: AreaIn, request: Request, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    try:
        geom = multipolygon_from_geojson(body.boundary)
    except Exception as exc:
        raise HTTPException(422, f"Invalid boundary: {exc}")
    a = ProtectedArea(**body.model_dump(exclude={"boundary"}), geom=geom)
    db.add(a)
    db.flush()
    a.area_km2 = round(compute_area_km2(db, a), 1)
    audit.record(db, user, "create", "area", a.id, {"name": a.name}, request)
    db.commit()
    return a


@router.patch("/areas/{area_id}", response_model=AreaOut)
def update_area(area_id: int, body: AreaUpdate, request: Request, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    a = db.get(ProtectedArea, area_id)
    if not a:
        raise HTTPException(404, "Area not found")
    changes = body.model_dump(exclude_unset=True)
    if "boundary" in changes:
        try:
            a.geom = multipolygon_from_geojson(changes.pop("boundary"))
        except Exception as exc:
            raise HTTPException(422, f"Invalid boundary: {exc}")
        db.flush()
        a.area_km2 = round(compute_area_km2(db, a), 1)
        changes["boundary"] = "replaced"
    for k, v in changes.items():
        if k != "boundary":
            setattr(a, k, v)
    audit.record(db, user, "update", "area", a.id, changes, request)
    db.commit()
    return a


@router.get("/areas/{area_id}", response_model=AreaOut)
def get_area(area_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    a = db.get(ProtectedArea, area_id)
    if not a:
        raise HTTPException(404, "Area not found")
    return a


@router.get("/areas/{area_id}/summary")
def area_summary(area_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    a = db.get(ProtectedArea, area_id)
    if not a:
        raise HTTPException(404, "Area not found")
    counts = dict(db.execute(select(Observation.validation_status, func.count()).where(Observation.area_id == area_id)
                             .group_by(Observation.validation_status)).all())
    species = db.scalar(select(func.count(func.distinct(Observation.species))).where(
        Observation.area_id == area_id, Observation.validation_status == ValidationStatus.verified))
    series = analytics.encounter_series(db, area_id)
    return {
        "area": AreaOut.model_validate(a).model_dump(),
        "observations": {k.value: v for k, v in counts.items()},
        "verified_species": species,
        "latest_observation": analytics.latest_observation_date(db, area_id),
        "encounter_series": analytics.series_payload(series),
    }


@router.get("/areas/{area_id}/habitat", response_model=list[HabitatOut])
def area_habitat(area_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return db.scalars(select(HabitatMetric).where(HabitatMetric.area_id == area_id).order_by(HabitatMetric.period_start)).all()


@router.get("/areas/{area_id}/assessments", response_model=list[AssessmentOut])
def area_assessments(area_id: int, limit: int = Query(20, le=200), db: Session = Depends(get_db),
                     _: User = Depends(get_current_user)):
    return db.scalars(select(RiskAssessment).where(RiskAssessment.area_id == area_id)
                      .order_by(RiskAssessment.computed_at.desc()).limit(limit)).all()


@router.get("/indicators", response_model=list[IndicatorOut])
def list_indicators(category: str | None = None, indicator: str | None = None, district: str | None = None,
                    area_id: int | None = None, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    q = select(EnvironmentalIndicator).order_by(EnvironmentalIndicator.period_start)
    if category:
        q = q.where(EnvironmentalIndicator.category == category)
    if indicator:
        q = q.where(EnvironmentalIndicator.indicator == indicator)
    if district:
        q = q.where(EnvironmentalIndicator.district == district)
    if area_id:
        q = q.where(EnvironmentalIndicator.area_id == area_id)
    return db.scalars(q.limit(5000)).all()


# ---------- pressures ----------
def _p_out(p: PressureEvent, names: dict[int, str]) -> PressureOut:
    lon, lat = lonlat(p.geom)
    return PressureOut(id=p.id, area_id=p.area_id, area_name=names.get(p.area_id), kind=p.kind, severity=p.severity,
                       observed_at=p.observed_at, lon=round(lon, 5), lat=round(lat, 5), description=p.description,
                       source=p.source, validation_status=p.validation_status)


PRESSURE_KINDS = {"mining", "logging", "agriculture", "fire", "snare", "hunting", "settlement", "road", "charcoal", "other"}


@router.get("/pressures", response_model=list[PressureOut])
def list_pressures(area_id: int | None = None, kind: str | None = None, days: int = Query(365, le=3650),
                   db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    since = datetime.now(timezone.utc).timestamp() - days * 86400
    q = select(PressureEvent).where(PressureEvent.observed_at >= datetime.fromtimestamp(since, timezone.utc)) \
        .order_by(PressureEvent.observed_at.desc()).limit(2000)
    if area_id:
        q = q.where(PressureEvent.area_id == area_id)
    if kind:
        q = q.where(PressureEvent.kind == kind)
    names = dict(db.execute(select(ProtectedArea.id, ProtectedArea.name)).all())
    return [_p_out(p, names) for p in db.scalars(q)]


@router.post("/pressures", response_model=PressureOut, status_code=201)
def create_pressure(body: PressureIn, request: Request, db: Session = Depends(get_db), user: User = Depends(can_submit)):
    if body.kind not in PRESSURE_KINDS:
        raise HTTPException(422, f"kind must be one of {sorted(PRESSURE_KINDS)}")
    p = PressureEvent(kind=body.kind, severity=body.severity, observed_at=body.observed_at, geom=point(body.lat, body.lon),
                      description=body.description, reported_by=user.id, source="field")
    p.area_id = assign_area(db, body.lon, body.lat, buffer_km=5)
    db.add(p)
    db.flush()
    audit.record(db, user, "create", "pressure", p.id, {"kind": p.kind, "area_id": p.area_id}, request)
    db.commit()
    names = dict(db.execute(select(ProtectedArea.id, ProtectedArea.name)).all())
    return _p_out(p, names)


@router.post("/pressures/{pid}/validate", response_model=PressureOut)
def validate_pressure(pid: int, body: ValidationIn, request: Request, db: Session = Depends(get_db),
                      user: User = Depends(can_analyse)):
    p = db.get(PressureEvent, pid)
    if not p:
        raise HTTPException(404, "Not found")
    p.validation_status = body.status
    audit.record(db, user, "validate", "pressure", p.id, {"to": body.status.value, "note": body.note}, request)
    db.commit()
    names = dict(db.execute(select(ProtectedArea.id, ProtectedArea.name)).all())
    return _p_out(p, names)
