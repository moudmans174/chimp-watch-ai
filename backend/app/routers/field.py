"""Field-operations modules: camera traps, patrols, human-wildlife conflict, community outreach,
satellite forest alerts."""
from __future__ import annotations

import hashlib
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from geoalchemy2.shape import from_shape, to_shape
from pydantic import BaseModel, Field, field_validator
from shapely.geometry import LineString, mapping
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..config import get_settings
from ..db import get_db
from ..geo import point, visible_location
from ..models import (
    CameraCapture,
    CameraDeployment,
    CameraStation,
    ConflictIncident,
    EvidenceType,
    ForestAlert,
    Observation,
    OutreachActivity,
    Patrol,
    ProtectedArea,
    Role,
    SurveyEffort,
    User,
    ValidationStatus,
)
from ..security import can_analyse, can_submit, get_current_user
from ..services import cameras, classifier, forest_alerts, notify
from ..services.spatial import assign_area
from ..services.storage import ALLOWED_TYPES, get_storage, sniff

router = APIRouter(prefix="/api", tags=["field operations"])

SENSITIVE_SPECIES = ("Pan ", "Smutsia", "Panthera", "Loxodonta", "Choeropsis", "Cephalophus jentinki")


def _area_name(db: Session, area_id: int | None) -> str | None:
    if not area_id:
        return None
    a = db.get(ProtectedArea, area_id)
    return a.name if a else None


def _not_future(v: datetime) -> datetime:
    vv = v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    if vv > datetime.now(timezone.utc) + timedelta(hours=1):
        raise ValueError("Date cannot be in the future")
    return vv


# =========================================================================================== camera traps
class StationIn(BaseModel):
    code: str = Field(min_length=2, max_length=40)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    habitat: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=2000)


class StationPatch(BaseModel):
    active: bool | None = None
    habitat: str | None = None
    notes: str | None = None


class DeployIn(BaseModel):
    deployed_on: date
    camera_model: str | None = Field(default=None, max_length=80)
    card_id: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=2000)


class RetrieveIn(BaseModel):
    retrieved_on: date
    status: Literal["retrieved", "failed"] = "retrieved"
    notes: str | None = Field(default=None, max_length=2000)


class ReviewIn(BaseModel):
    status: Literal["confirmed", "empty", "rejected"]
    species: str | None = Field(default=None, max_length=120)
    common_name: str | None = Field(default=None, max_length=120)
    count: int | None = Field(default=None, ge=1, le=200)


def _station_out(db: Session, s: CameraStation, user: User, counts: dict, active: CameraDeployment | None, deps: list[CameraDeployment]):
    td = sum(cameras.trap_days(d) for d in deps if d.status != "failed")
    return {
        "id": s.id, "code": s.code, "area_id": s.area_id, "area_name": s.area.name if s.area else None,
        "location": visible_location(s.geom, True, user), "habitat": s.habitat, "notes": s.notes, "active": s.active,
        "active_deployment": {"id": active.id, "deployed_on": active.deployed_on, "camera_model": active.camera_model,
                              "card_id": active.card_id, "trap_days": cameras.trap_days(active)} if active else None,
        "deployments": len(deps), "trap_days": td,
        "captures": {"pending": counts.get("pending", 0), "confirmed": counts.get("confirmed", 0),
                     "empty": counts.get("empty", 0), "rejected": counts.get("rejected", 0)},
    }


@router.get("/camera/stations")
def list_stations(area_id: int | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(CameraStation).order_by(CameraStation.code)
    if area_id:
        q = q.where(CameraStation.area_id == area_id)
    stations = db.scalars(q).unique().all()
    counts = cameras.station_counts(db)
    deps_by: dict[int, list[CameraDeployment]] = defaultdict(list)
    for d in db.scalars(select(CameraDeployment).order_by(CameraDeployment.deployed_on.desc())).unique():
        deps_by[d.station_id].append(d)
    return [_station_out(db, s, user, counts.get(s.id, {}), next((d for d in deps_by[s.id] if d.status == "active"), None),
                         deps_by[s.id]) for s in stations]


@router.post("/camera/stations", status_code=201)
def create_station(body: StationIn, request: Request, db: Session = Depends(get_db), user: User = Depends(can_submit)):
    if db.scalar(select(CameraStation.id).where(func.lower(CameraStation.code) == body.code.strip().lower())):
        raise HTTPException(409, "A station with this code already exists")
    s = CameraStation(code=body.code.strip().upper(), geom=point(body.lat, body.lon), habitat=body.habitat,
                      notes=body.notes, created_by=user.id)
    s.area_id = assign_area(db, body.lon, body.lat, buffer_km=5)
    db.add(s)
    db.flush()
    audit.record(db, user, "create", "camera_station", s.id, {"code": s.code, "area_id": s.area_id}, request)
    db.commit()
    db.refresh(s)
    return _station_out(db, s, user, {}, None, [])


@router.patch("/camera/stations/{sid}")
def update_station(sid: int, body: StationPatch, request: Request, db: Session = Depends(get_db), user: User = Depends(can_analyse)):
    s = db.get(CameraStation, sid)
    if not s:
        raise HTTPException(404, "Station not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(s, k, v)
    audit.record(db, user, "update", "camera_station", s.id, body.model_dump(exclude_unset=True), request)
    db.commit()
    return {"id": s.id, "active": s.active}


@router.post("/camera/stations/{sid}/deploy", status_code=201)
def deploy(sid: int, body: DeployIn, request: Request, db: Session = Depends(get_db), user: User = Depends(can_submit)):
    s = db.get(CameraStation, sid)
    if not s:
        raise HTTPException(404, "Station not found")
    if body.deployed_on > date.today():
        raise HTTPException(422, "Deployment date can't be in the future")
    if db.scalar(select(CameraDeployment.id).where(CameraDeployment.station_id == sid, CameraDeployment.status == "active")):
        raise HTTPException(409, "This station already has an active camera. Retrieve it first.")
    d = CameraDeployment(station_id=sid, deployed_on=body.deployed_on, camera_model=body.camera_model, card_id=body.card_id,
                         notes=body.notes, deployed_by=user.id, status="active")
    s.active = True
    db.add(d)
    db.flush()
    audit.record(db, user, "deploy", "camera_deployment", d.id, {"station": s.code}, request)
    db.commit()
    return {"id": d.id, "station_id": sid, "deployed_on": d.deployed_on, "status": d.status}


@router.post("/camera/deployments/{did}/retrieve")
def retrieve(did: int, body: RetrieveIn, request: Request, db: Session = Depends(get_db), user: User = Depends(can_submit)):
    d = db.get(CameraDeployment, did)
    if not d:
        raise HTTPException(404, "Deployment not found")
    if d.status != "active":
        raise HTTPException(409, "This camera has already been retrieved")
    if body.retrieved_on < d.deployed_on or body.retrieved_on > date.today():
        raise HTTPException(422, "Retrieval date must be between the deployment date and today")
    d.retrieved_on, d.status, d.retrieved_by = body.retrieved_on, body.status, user.id
    if body.notes:
        d.notes = (d.notes + "\n" if d.notes else "") + body.notes
    days = cameras.trap_days(d)
    if body.status == "retrieved" and days > 0 and d.station.area_id:
        sv = SurveyEffort(area_id=d.station.area_id, org_id=user.org_id, method="camera_trap", start_date=d.deployed_on,
                          end_date=d.retrieved_on, effort_trap_days=float(days), team=f"Camera {d.station.code}",
                          source="field", created_by=user.id)
        db.add(sv)
        db.flush()
        d.survey_id = sv.id
    audit.record(db, user, "retrieve", "camera_deployment", d.id, {"status": body.status, "trap_days": days}, request)
    db.commit()
    return {"id": d.id, "status": d.status, "trap_days": days, "survey_id": d.survey_id}


@router.post("/camera/deployments/{did}/captures", status_code=201)
async def upload_captures(did: int, request: Request, files: list[UploadFile] = File(...),
                          db: Session = Depends(get_db), user: User = Depends(can_submit)):
    d = db.get(CameraDeployment, did)
    if not d:
        raise HTTPException(404, "Deployment not found")
    if len(files) > 200:
        raise HTTPException(413, "Upload at most 200 photos at a time")
    limit = get_settings().max_upload_mb * 1024 * 1024
    from .observations import _strip_metadata  # reuse EXIF/GPS stripping
    created, skipped, errors = 0, 0, []
    seen: set[str] = set()  # duplicates within this batch (not yet flushed to the database)
    for f in files:
        data = await f.read(limit + 1)
        if len(data) > limit:
            errors.append(f"{f.filename}: larger than {get_settings().max_upload_mb} MB")
            continue
        ctype = sniff(data)
        if ctype not in ALLOWED_TYPES:
            errors.append(f"{f.filename}: not a JPEG, PNG or WebP image")
            continue
        digest = hashlib.sha256(data).hexdigest()
        if digest in seen or db.scalar(select(CameraCapture.id).where(CameraCapture.deployment_id == did, CameraCapture.sha256 == digest)):
            skipped += 1
            continue
        seen.add(digest)
        taken = cameras.exif_datetime(data) or datetime.now(timezone.utc)
        try:
            clean = _strip_metadata(data, ctype)
        except Exception:
            errors.append(f"{f.filename}: image could not be read")
            continue
        key, _ = get_storage().put(clean, ctype, f"camera/{d.station_id}/{did}")
        db.add(CameraCapture(deployment_id=did, captured_at=taken, storage_key=key, content_type=ctype, size_bytes=len(clean),
                             sha256=digest, classification=classifier.classify(clean, ctype), uploaded_by=user.id))
        created += 1
    if created:
        notify.captures_to_review(db, created, d.station.code)
    audit.record(db, user, "upload", "camera_capture", None, {"deployment": did, "created": created, "skipped": skipped}, request)
    db.commit()
    return {"created": created, "duplicates": skipped, "errors": errors}


def _capture_out(c: CameraCapture) -> dict:
    st = c.deployment.station
    return {"id": c.id, "captured_at": c.captured_at, "station_id": st.id, "station_code": st.code,
            "area_name": st.area.name if st.area else None, "deployment_id": c.deployment_id,
            "review_status": c.review_status, "species": c.species, "common_name": c.common_name, "count": c.count,
            "classification": c.classification, "observation_id": c.observation_id, "reviewed_at": c.reviewed_at}


@router.get("/camera/captures")
def list_captures(status: str | None = "pending", station_id: int | None = None, limit: int = Query(60, le=500), offset: int = 0,
                  db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    q = select(CameraCapture).join(CameraDeployment, CameraCapture.deployment_id == CameraDeployment.id)
    if status:
        q = q.where(CameraCapture.review_status == status)
    if station_id:
        q = q.where(CameraDeployment.station_id == station_id)
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rows = db.scalars(q.order_by(CameraCapture.captured_at.desc()).limit(limit).offset(offset)).unique().all()
    return {"total": total, "items": [_capture_out(c) for c in rows]}


@router.get("/camera/captures/{cid}/image")
def capture_image(cid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    c = db.get(CameraCapture, cid)
    if not c:
        raise HTTPException(404, "Capture not found")
    return Response(get_storage().get(c.storage_key), media_type=c.content_type, headers={"Cache-Control": "private, max-age=86400"})


@router.post("/camera/captures/{cid}/review")
def review_capture(cid: int, body: ReviewIn, request: Request, db: Session = Depends(get_db), user: User = Depends(can_analyse)):
    c = db.get(CameraCapture, cid)
    if not c:
        raise HTTPException(404, "Capture not found")
    if body.status == "confirmed" and not body.species:
        raise HTTPException(422, "Choose the species before confirming")
    st = c.deployment.station
    c.review_status, c.reviewed_by, c.reviewed_at = body.status, user.id, datetime.now(timezone.utc)
    if body.status == "confirmed":
        c.species, c.common_name, c.count = body.species.strip(), body.common_name, body.count or 1
        lon, lat = to_shape(st.geom).x, to_shape(st.geom).y
        if c.observation_id and (obs := db.get(Observation, c.observation_id)):
            obs.species, obs.common_name, obs.count = c.species, c.common_name, c.count
        else:
            obs = Observation(area_id=st.area_id, species=c.species, common_name=c.common_name,
                              evidence_type=EvidenceType.camera_trap, count=c.count, observed_at=c.captured_at,
                              geom=point(lat, lon), sensitive=c.species.startswith(SENSITIVE_SPECIES),
                              id_confidence=1.0, source="camera_trap", org_id=user.org_id, observer_id=c.uploaded_by,
                              notes=f"Camera station {st.code}", validation_status=ValidationStatus.verified,
                              validated_by=user.id, validated_at=datetime.now(timezone.utc))
            db.add(obs)
            db.flush()
            c.observation_id = obs.id
    elif c.observation_id and (obs := db.get(Observation, c.observation_id)):
        obs.validation_status = ValidationStatus.rejected
        obs.validation_note = f"Camera capture marked {body.status}"
    if st.area_id:
        cameras.refresh_richness(db, st.area_id)
    audit.record(db, user, "review", "camera_capture", c.id, body.model_dump(), request)
    db.commit()
    return _capture_out(c)


@router.get("/camera/summary")
def camera_summary(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    deps = db.scalars(select(CameraDeployment)).unique().all()
    since = date.today() - timedelta(days=365)
    trap_by_area: dict[str, int] = defaultdict(int)
    for d in deps:
        if d.status == "failed" or (d.retrieved_on and d.retrieved_on < since):
            continue
        trap_by_area[d.station.area.name if d.station.area else "Outside pilot areas"] += cameras.trap_days(d)
    status = dict(db.execute(select(CameraCapture.review_status, func.count()).group_by(CameraCapture.review_status)).all())
    species = db.execute(select(CameraCapture.common_name, CameraCapture.species, func.count())
                         .where(CameraCapture.review_status == "confirmed")
                         .group_by(CameraCapture.common_name, CameraCapture.species)
                         .order_by(func.count().desc()).limit(12)).all()
    return {"stations": db.scalar(select(func.count(CameraStation.id))) or 0,
            "active_cameras": sum(1 for d in deps if d.status == "active"),
            "trap_days_12m": sum(trap_by_area.values()), "trap_days_by_area": dict(trap_by_area), "captures": status,
            "top_species": [{"common_name": cn, "species": sp, "count": n} for cn, sp, n in species]}


# =========================================================================================== patrols
class PatrolIn(BaseModel):
    client_uuid: str = Field(min_length=8, max_length=36)
    started_at: datetime
    ended_at: datetime
    team: str | None = Field(default=None, max_length=200)
    purpose: Literal["monitoring", "law_enforcement", "survey", "community", "other"] = "monitoring"
    notes: str | None = Field(default=None, max_length=4000)
    source: Literal["app", "gpx"] = "app"
    area_id: int | None = None
    points: list[list[float]] = Field(min_length=2, max_length=50000)  # [lon, lat] or [lon, lat, epoch_ms]

    @field_validator("started_at", "ended_at")
    @classmethod
    def not_future(cls, v: datetime) -> datetime:
        return _not_future(v)

    @field_validator("points")
    @classmethod
    def valid_points(cls, v):
        for p in v:
            if len(p) < 2 or not (-180 <= p[0] <= 180 and -90 <= p[1] <= 90):
                raise ValueError("Each point must be [longitude, latitude]")
        return v


def _patrol_out(p: Patrol) -> dict:
    hours = max(0.0, (p.ended_at - p.started_at).total_seconds() / 3600)
    return {"id": p.id, "client_uuid": p.client_uuid, "area_id": p.area_id, "area_name": p.area.name if p.area else None,
            "leader_id": p.leader_id, "leader_name": p.leader.full_name if p.leader else None, "team": p.team,
            "purpose": p.purpose, "started_at": p.started_at, "ended_at": p.ended_at, "hours": round(hours, 2),
            "distance_km": round(p.distance_km, 2), "points": p.points, "source": p.source, "notes": p.notes}


def _patrol_area(db: Session, track_wkb) -> int | None:
    """Landscape with the longest stretch of the track inside it, else nearest within 5 km."""
    inter = func.ST_Length(func.Geography(func.ST_Intersection(ProtectedArea.geom, track_wkb)))
    row = db.execute(select(ProtectedArea.id, inter.label("m")).where(func.ST_Intersects(ProtectedArea.geom, track_wkb))
                     .order_by(inter.desc()).limit(1)).first()
    if row:
        return row.id
    dist = func.ST_Distance(func.Geography(ProtectedArea.geom), func.Geography(track_wkb))
    row = db.execute(select(ProtectedArea.id, dist.label("d")).order_by(dist).limit(1)).first()
    return row.id if row and row.d is not None and row.d <= 5000 else None


@router.post("/patrols", status_code=201)
def create_patrol(body: PatrolIn, request: Request, response: Response, db: Session = Depends(get_db), user: User = Depends(can_submit)):
    existing = db.scalar(select(Patrol).where(Patrol.client_uuid == body.client_uuid))
    if existing:
        response.status_code = 200
        return _patrol_out(existing)
    if body.ended_at < body.started_at:
        raise HTTPException(422, "The patrol must end after it starts")
    coords = [(p[0], p[1]) for p in body.points]
    dedup = [coords[0]] + [c for i, c in enumerate(coords[1:], 1) if c != coords[i - 1]]
    if len(dedup) < 2:
        raise HTTPException(422, "The track needs at least two different positions")
    line = LineString(dedup)
    geom = from_shape(line, srid=4326)
    expr = func.ST_GeomFromText(line.wkt, 4326)
    km = float(db.scalar(select(func.ST_Length(func.Geography(expr))))) / 1000
    if body.area_id and not db.get(ProtectedArea, body.area_id):
        raise HTTPException(422, "Unknown landscape")
    p = Patrol(client_uuid=body.client_uuid, track=geom, distance_km=round(km, 3), points=len(dedup), leader_id=user.id,
               org_id=user.org_id, team=body.team, purpose=body.purpose, started_at=body.started_at, ended_at=body.ended_at,
               notes=body.notes, source=body.source)
    p.area_id = body.area_id or _patrol_area(db, expr)
    db.add(p)
    db.flush()
    audit.record(db, user, "create", "patrol", p.id, {"km": round(km, 2), "area_id": p.area_id, "source": body.source}, request)
    db.commit()
    db.refresh(p)
    return _patrol_out(p)


@router.get("/patrols")
def list_patrols(area_id: int | None = None, days: int = Query(90, le=3650), mine: bool = False,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(Patrol).where(Patrol.started_at >= datetime.now(timezone.utc) - timedelta(days=days)).order_by(Patrol.started_at.desc()).limit(1000)
    if area_id:
        q = q.where(Patrol.area_id == area_id)
    if mine:
        q = q.where(Patrol.leader_id == user.id)
    return [_patrol_out(p) for p in db.scalars(q).unique()]


@router.get("/patrols.geojson")
def patrols_geojson(days: int = Query(90, le=3650), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Patrol routes reveal ranger movements, so they're withheld from viewers."""
    if user.role == Role.viewer:
        return {"type": "FeatureCollection", "features": []}
    rows = db.scalars(select(Patrol).where(Patrol.started_at >= datetime.now(timezone.utc) - timedelta(days=days))
                      .order_by(Patrol.started_at.desc()).limit(500)).unique().all()
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": mapping(to_shape(p.track).simplify(0.0002)),
         "properties": {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in _patrol_out(p).items() if k != "notes"}}
        for p in rows]}


@router.get("/patrols/summary")
def patrol_summary(days: int = Query(90, le=3650), db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = db.execute(select(Patrol.area_id, func.count(), func.sum(Patrol.distance_km),
                             func.sum(func.extract("epoch", Patrol.ended_at - Patrol.started_at)))
                      .where(Patrol.started_at >= since).group_by(Patrol.area_id)).all()
    names = dict(db.execute(select(ProtectedArea.id, ProtectedArea.name)).all())
    by_area = [{"area_id": a, "area_name": names.get(a, "Outside pilot areas"), "patrols": n, "km": round(km or 0, 1),
                "hours": round((secs or 0) / 3600, 1)} for a, n, km, secs in rows]
    by_area.sort(key=lambda r: -r["km"])
    return {"days": days, "patrols": sum(r["patrols"] for r in by_area), "km": round(sum(r["km"] for r in by_area), 1),
            "hours": round(sum(r["hours"] for r in by_area), 1), "by_area": by_area}


# =========================================================================================== human-wildlife conflict
CONFLICT_SPECIES = ("chimpanzee", "elephant", "baboon", "monkey", "bush_pig", "porcupine", "cane_rat", "leopard", "other")
CONFLICT_KINDS = ("crop_raiding", "property_damage", "livestock_loss", "human_injury", "wildlife_injured", "wildlife_killed", "other")
CONFLICT_STATUSES = ("reported", "verified", "responded", "closed")


class ConflictIn(BaseModel):
    client_uuid: str = Field(min_length=8, max_length=36)
    occurred_at: datetime
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    community: str | None = Field(default=None, max_length=150)
    district: str | None = Field(default=None, max_length=100)
    species: Literal[CONFLICT_SPECIES]  # type: ignore[valid-type]
    kind: Literal[CONFLICT_KINDS]  # type: ignore[valid-type]
    crops: str | None = Field(default=None, max_length=200)
    loss_estimate_le: float | None = Field(default=None, ge=0)
    area_damaged_ha: float | None = Field(default=None, ge=0, le=10000)
    people_affected: int | None = Field(default=None, ge=0, le=100000)
    description: str | None = Field(default=None, max_length=4000)
    reporter_name: str | None = Field(default=None, max_length=150)
    reporter_phone: str | None = Field(default=None, max_length=40, pattern=r"^[0-9+()\-\s]*$")

    @field_validator("occurred_at")
    @classmethod
    def not_future(cls, v: datetime) -> datetime:
        return _not_future(v)


class ConflictPatch(BaseModel):
    status: Literal[CONFLICT_STATUSES] | None = None  # type: ignore[valid-type]
    response_notes: str | None = Field(default=None, max_length=4000)
    assigned_to: int | None = None


def _conflict_out(c: ConflictIncident, user: User) -> dict:
    pt = to_shape(c.geom)
    private = user.role in (Role.admin, Role.analyst)
    return {"id": c.id, "client_uuid": c.client_uuid, "occurred_at": c.occurred_at, "lon": round(pt.x, 5), "lat": round(pt.y, 5),
            "area_id": c.area_id, "area_name": c.area.name if c.area else None, "district": c.district, "community": c.community,
            "species": c.species, "kind": c.kind, "crops": c.crops, "loss_estimate_le": c.loss_estimate_le,
            "area_damaged_ha": c.area_damaged_ha, "people_affected": c.people_affected, "description": c.description,
            "reporter_name": c.reporter_name if private else None, "reporter_phone": c.reporter_phone if private else None,
            "status": c.status, "response_notes": c.response_notes, "assigned_to": c.assigned_to, "source": c.source,
            "created_at": c.created_at, "updated_at": c.updated_at}


@router.post("/conflicts", status_code=201)
def create_conflict(body: ConflictIn, request: Request, response: Response, db: Session = Depends(get_db), user: User = Depends(can_submit)):
    existing = db.scalar(select(ConflictIncident).where(ConflictIncident.client_uuid == body.client_uuid))
    if existing:
        response.status_code = 200
        return _conflict_out(existing, user)
    data = body.model_dump(exclude={"lat", "lon"})
    c = ConflictIncident(**data, geom=point(body.lat, body.lon), created_by=user.id, org_id=user.org_id)
    c.area_id = assign_area(db, body.lon, body.lat, buffer_km=15)
    if not c.district and c.area_id:
        c.district = db.get(ProtectedArea, c.area_id).district
    db.add(c)
    db.flush()
    db.refresh(c)
    notify.conflict_reported(db, c)
    audit.record(db, user, "create", "conflict", c.id, {"kind": c.kind, "species": c.species, "district": c.district}, request)
    db.commit()
    return _conflict_out(c, user)


@router.get("/conflicts")
def list_conflicts(status: str | None = None, kind: str | None = None, species: str | None = None, district: str | None = None,
                   days: int = Query(365, le=3650), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(ConflictIncident).where(ConflictIncident.occurred_at >= datetime.now(timezone.utc) - timedelta(days=days))
    for col, val in ((ConflictIncident.status, status), (ConflictIncident.kind, kind), (ConflictIncident.species, species),
                     (ConflictIncident.district, district)):
        if val:
            q = q.where(col == val)
    return [_conflict_out(c, user) for c in db.scalars(q.order_by(ConflictIncident.occurred_at.desc()).limit(2000)).unique()]


@router.patch("/conflicts/{cid}")
def update_conflict(cid: int, body: ConflictPatch, request: Request, db: Session = Depends(get_db), user: User = Depends(can_analyse)):
    c = db.get(ConflictIncident, cid)
    if not c:
        raise HTTPException(404, "Incident not found")
    changes = body.model_dump(exclude_unset=True)
    if changes.get("status") == "closed" and not (body.response_notes or c.response_notes):
        raise HTTPException(422, "Record the response before closing the incident")
    if "assigned_to" in changes and changes["assigned_to"]:
        assignee = db.get(User, changes["assigned_to"])
        if not assignee or not assignee.is_active:
            raise HTTPException(422, "Unknown assignee")
        if assignee.id != c.assigned_to:
            notify.conflict_assigned(db, c, assignee)
    for k, v in changes.items():
        setattr(c, k, v)
    audit.record(db, user, "update", "conflict", c.id, changes, request)
    db.commit()
    db.refresh(c)
    return _conflict_out(c, user)


@router.get("/conflicts/summary")
def conflict_summary(days: int = Query(365, le=3650), db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    rows = db.scalars(select(ConflictIncident).where(ConflictIncident.occurred_at >= datetime.now(timezone.utc) - timedelta(days=days))).unique().all()
    months = Counter(c.occurred_at.strftime("%Y-%m") for c in rows)
    return {"total": len(rows), "open": sum(1 for c in rows if c.status != "closed"),
            "by_kind": Counter(c.kind for c in rows), "by_species": Counter(c.species for c in rows),
            "by_district": Counter(c.district or "Unknown" for c in rows), "by_status": Counter(c.status for c in rows),
            "by_month": [{"month": m, "count": months[m]} for m in sorted(months)],
            "loss_estimate_le": round(sum(c.loss_estimate_le or 0 for c in rows)),
            "area_damaged_ha": round(sum(c.area_damaged_ha or 0 for c in rows), 1)}


# =========================================================================================== community outreach
OUTREACH_KINDS = ("meeting", "awareness", "school", "training", "agreement", "monitor_recruitment", "other")


class OutreachIn(BaseModel):
    client_uuid: str = Field(default_factory=lambda: str(uuid.uuid4()), min_length=8, max_length=36)
    area_id: int | None = None
    community: str = Field(min_length=2, max_length=150)
    kind: Literal[OUTREACH_KINDS]  # type: ignore[valid-type]
    held_on: date
    participants: int = Field(ge=0, le=100000)
    women: int | None = Field(default=None, ge=0)
    youth: int | None = Field(default=None, ge=0)
    facilitator: str | None = Field(default=None, max_length=150)
    summary: str = Field(min_length=5, max_length=4000)
    follow_up: str | None = Field(default=None, max_length=2000)
    follow_up_due: date | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)

    @field_validator("held_on")
    @classmethod
    def not_future(cls, v: date) -> date:
        if v > date.today():
            raise ValueError("Date cannot be in the future")
        return v


class OutreachPatch(BaseModel):
    follow_up_done: bool | None = None
    follow_up: str | None = None
    follow_up_due: date | None = None


def _outreach_out(o: OutreachActivity) -> dict:
    return {"id": o.id, "area_id": o.area_id, "area_name": o.area.name if o.area else None, "community": o.community,
            "kind": o.kind, "held_on": o.held_on, "participants": o.participants, "women": o.women, "youth": o.youth,
            "facilitator": o.facilitator, "summary": o.summary, "follow_up": o.follow_up, "follow_up_due": o.follow_up_due,
            "follow_up_done": o.follow_up_done, "source": o.source, "created_by": o.created_by}


@router.post("/outreach", status_code=201)
def create_outreach(body: OutreachIn, request: Request, response: Response, db: Session = Depends(get_db), user: User = Depends(can_submit)):
    existing = db.scalar(select(OutreachActivity).where(OutreachActivity.client_uuid == body.client_uuid))
    if existing:
        response.status_code = 200
        return _outreach_out(existing)
    for part in (body.women, body.youth):
        if part is not None and part > body.participants:
            raise HTTPException(422, "Women and youth counts can't exceed the total participants")
    if body.area_id and not db.get(ProtectedArea, body.area_id):
        raise HTTPException(422, "Unknown landscape")
    o = OutreachActivity(**body.model_dump(exclude={"lat", "lon"}), created_by=user.id, org_id=user.org_id)
    if body.lat is not None and body.lon is not None:
        o.geom = point(body.lat, body.lon)
        o.area_id = o.area_id or assign_area(db, body.lon, body.lat, buffer_km=15)
    db.add(o)
    db.flush()
    audit.record(db, user, "create", "outreach", o.id, {"kind": o.kind, "community": o.community}, request)
    db.commit()
    db.refresh(o)
    return _outreach_out(o)


@router.get("/outreach")
def list_outreach(area_id: int | None = None, kind: str | None = None, days: int = Query(365, le=3650), open_follow_ups: bool = False,
                  db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    q = select(OutreachActivity).where(OutreachActivity.held_on >= date.today() - timedelta(days=days))
    if area_id:
        q = q.where(OutreachActivity.area_id == area_id)
    if kind:
        q = q.where(OutreachActivity.kind == kind)
    if open_follow_ups:
        q = q.where(OutreachActivity.follow_up.is_not(None), OutreachActivity.follow_up_done.is_(False))
    return [_outreach_out(o) for o in db.scalars(q.order_by(OutreachActivity.held_on.desc()).limit(2000)).unique()]


@router.patch("/outreach/{oid}")
def update_outreach(oid: int, body: OutreachPatch, request: Request, db: Session = Depends(get_db), user: User = Depends(can_submit)):
    o = db.get(OutreachActivity, oid)
    if not o:
        raise HTTPException(404, "Activity not found")
    if user.role == Role.field_monitor and o.created_by != user.id:
        raise HTTPException(403, "You can only update activities you recorded")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(o, k, v)
    audit.record(db, user, "update", "outreach", o.id, body.model_dump(exclude_unset=True, mode="json"), request)
    db.commit()
    db.refresh(o)
    return _outreach_out(o)


@router.get("/outreach/summary")
def outreach_summary(days: int = Query(365, le=3650), db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    rows = db.scalars(select(OutreachActivity).where(OutreachActivity.held_on >= date.today() - timedelta(days=days))).unique().all()
    by_area: dict[str, dict] = defaultdict(lambda: {"activities": 0, "participants": 0})
    for o in rows:
        a = by_area[o.area.name if o.area else "Not linked to a landscape"]
        a["activities"] += 1
        a["participants"] += o.participants
    total = sum(o.participants for o in rows)
    women = sum(o.women or 0 for o in rows)
    youth = sum(o.youth or 0 for o in rows)
    return {"activities": len(rows), "participants": total, "women": women, "youth": youth,
            "communities": len({o.community.strip().lower() for o in rows}),
            "open_follow_ups": sum(1 for o in rows if o.follow_up and not o.follow_up_done),
            "by_kind": Counter(o.kind for o in rows), "by_area": by_area}


# =========================================================================================== satellite forest alerts
@router.get("/forest-alerts/status")
def forest_status(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return forest_alerts.status(db)


@router.post("/forest-alerts/sync")
def forest_sync(request: Request, db: Session = Depends(get_db), user: User = Depends(can_analyse)):
    if not forest_alerts.configured():
        raise HTTPException(409, "Satellite alerts aren't set up. Add CW_GFW_API_KEY to the server settings.")
    result = forest_alerts.sync(db)
    audit.record(db, user, "sync", "forest_alerts", None, {k: v for k, v in result.items() if k != "errors"}, request)
    db.commit()
    return result


@router.get("/forest-alerts")
def list_forest_alerts(area_id: int | None = None, days: int = Query(90, le=730), db: Session = Depends(get_db),
                       _: User = Depends(get_current_user)):
    q = select(ForestAlert).where(ForestAlert.alert_date >= date.today() - timedelta(days=days)).order_by(ForestAlert.alert_date.desc()).limit(10000)
    if area_id:
        q = q.where(ForestAlert.area_id == area_id)
    rows = db.scalars(q).all()
    names = dict(db.execute(select(ProtectedArea.id, ProtectedArea.name)).all())
    by_area = Counter(names.get(r.area_id, "Other") for r in rows)
    return {"total": len(rows), "by_area": by_area,
            "by_week": sorted(Counter((r.alert_date - timedelta(days=r.alert_date.weekday())).isoformat() for r in rows).items()),
            "items": [{"id": r.id, "area_id": r.area_id, "area_name": names.get(r.area_id), "date": r.alert_date, "lat": r.lat,
                       "lon": r.lon, "confidence": r.confidence, "source": r.source, "pressure_event_id": r.pressure_event_id}
                      for r in rows]}
