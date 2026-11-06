import csv
import io
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .. import audit
from ..config import get_settings
from ..db import get_db
from ..geo import point, visible_location
from ..models import EvidenceType, Media, Observation, Role, SurveyEffort, User, ValidationStatus
from ..schemas import ObservationIn, ObservationOut, SurveyIn, SurveyOut, ValidationIn
from ..security import can_analyse, can_submit, get_current_user
from ..services import classifier
from ..services.spatial import assign_area
from ..services.storage import ALLOWED_TYPES, get_storage, sniff

router = APIRouter(prefix="/api", tags=["observations"])


def serialize(o: Observation, user: User) -> ObservationOut:
    viewer = user if (user.can_view_sensitive or o.observer_id != user.id) else _owner_view(user)
    return ObservationOut(
        id=o.id, client_uuid=o.client_uuid, area_id=o.area_id, area_name=o.area.name if o.area else None,
        species=o.species, common_name=o.common_name, evidence_type=o.evidence_type, count=o.count,
        adults=o.adults, juveniles=o.juveniles, infants=o.infants, observed_at=o.observed_at,
        location=visible_location(o.geom, o.sensitive, viewer), gps_accuracy_m=o.gps_accuracy_m,
        sensitive=o.sensitive, id_confidence=o.id_confidence, notes=o.notes, source=o.source,
        validation_status=o.validation_status, validation_note=o.validation_note, validated_at=o.validated_at,
        observer_id=o.observer_id, org_id=o.org_id, media_count=len(o.media), created_at=o.created_at,
    )


class _OwnerView:
    """Observers always see their own submissions precisely."""
    can_view_sensitive = True


def _owner_view(_user: User):
    return _OwnerView()


def _filtered(q, area_id, species, status, source, date_from, date_to, bbox):
    if area_id:
        q = q.where(Observation.area_id == area_id)
    if species:
        q = q.where(Observation.species.ilike(f"%{species}%"))
    if status:
        q = q.where(Observation.validation_status == status)
    if source:
        q = q.where(Observation.source == source)
    if date_from:
        q = q.where(Observation.observed_at >= date_from)
    if date_to:
        q = q.where(Observation.observed_at <= date_to)
    if bbox:
        try:
            minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
        except ValueError:
            raise HTTPException(422, "bbox must be minLon,minLat,maxLon,maxLat")
        q = q.where(func.ST_Intersects(Observation.geom, func.ST_MakeEnvelope(minx, miny, maxx, maxy, 4326)))
    return q


@router.get("/observations")
def list_observations(
    area_id: int | None = None, species: str | None = None, status: ValidationStatus | None = None,
    source: str | None = None, date_from: datetime | None = None, date_to: datetime | None = None,
    bbox: str | None = None, mine: bool = False, limit: int = Query(100, le=1000), offset: int = 0,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    q = _filtered(select(Observation), area_id, species, status, source, date_from, date_to, bbox)
    if mine:
        q = q.where(Observation.observer_id == user.id)
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rows = db.scalars(q.options(selectinload(Observation.media)).order_by(Observation.observed_at.desc())
                      .limit(limit).offset(offset)).unique().all()
    return {"total": total, "items": [serialize(o, user) for o in rows]}


@router.get("/observations.geojson")
def observations_geojson(
    area_id: int | None = None, species: str | None = None, status: ValidationStatus | None = None,
    date_from: datetime | None = None, date_to: datetime | None = None, limit: int = Query(5000, le=20000),
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    q = _filtered(select(Observation), area_id, species, status, None, date_from, date_to, None)
    rows = db.scalars(q.options(selectinload(Observation.media)).order_by(Observation.observed_at.desc()).limit(limit)).unique().all()
    feats = []
    for o in rows:
        s = serialize(o, user)
        if not s.location:
            continue
        props = s.model_dump(mode="json", exclude={"location", "notes"})
        props.update(generalised=s.location.generalised, precision_km=s.location.precision_km)
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [s.location.lon, s.location.lat]},
                      "properties": props})
    return {"type": "FeatureCollection", "features": feats}


def _create(db: Session, body: ObservationIn, user: User) -> tuple[Observation, bool]:
    if body.client_uuid:
        existing = db.scalar(select(Observation).where(Observation.client_uuid == body.client_uuid))
        if existing:
            if existing.observer_id != user.id:
                raise HTTPException(409, "client_uuid already used")
            return existing, False
    data = body.model_dump(exclude={"lat", "lon", "client_uuid", "sensitive"})
    o = Observation(**data, geom=point(body.lat, body.lon), observer_id=user.id, org_id=user.org_id, source="field",
                    sensitive=body.sensitive if body.sensitive is not None else body.species.startswith("Pan "))
    if body.client_uuid:
        o.client_uuid = body.client_uuid
    if body.survey_id and not db.get(SurveyEffort, body.survey_id):
        raise HTTPException(422, "Unknown survey_id")
    o.area_id = assign_area(db, body.lon, body.lat)
    db.add(o)
    db.flush()
    return o, True


@router.post("/observations", response_model=ObservationOut, status_code=201)
def create_observation(body: ObservationIn, request: Request, response: Response, db: Session = Depends(get_db),
                       user: User = Depends(can_submit)):
    o, created = _create(db, body, user)
    if created:
        audit.record(db, user, "create", "observation", o.id, {"species": o.species, "area_id": o.area_id}, request)
    else:
        response.status_code = 200
    db.commit()
    db.refresh(o)
    return serialize(o, user)


@router.post("/observations/sync")
def sync_observations(items: list[ObservationIn], request: Request, db: Session = Depends(get_db),
                      user: User = Depends(can_submit)):
    """Idempotent batch upload from the offline field app. Each item must carry a client_uuid."""
    if len(items) > 500:
        raise HTTPException(413, "At most 500 observations per sync")
    results = []
    for item in items:
        if not item.client_uuid:
            results.append({"client_uuid": None, "status": "error", "detail": "client_uuid required"})
            continue
        try:
            with db.begin_nested():
                o, created = _create(db, item, user)
            results.append({"client_uuid": item.client_uuid, "id": o.id, "status": "created" if created else "duplicate"})
        except HTTPException as exc:
            results.append({"client_uuid": item.client_uuid, "status": "error", "detail": exc.detail})
    audit.record(db, user, "sync", "observation", None,
                 {"created": sum(r["status"] == "created" for r in results), "total": len(items)}, request)
    db.commit()
    return {"results": results}


@router.get("/observations/{obs_id}", response_model=ObservationOut)
def get_observation(obs_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    o = db.get(Observation, obs_id)
    if not o:
        raise HTTPException(404, "Observation not found")
    return serialize(o, user)


@router.post("/observations/{obs_id}/validate", response_model=ObservationOut)
def validate_observation(obs_id: int, body: ValidationIn, request: Request, db: Session = Depends(get_db),
                         user: User = Depends(can_analyse)):
    o = db.get(Observation, obs_id)
    if not o:
        raise HTTPException(404, "Observation not found")
    if user.role != Role.admin and o.org_id not in (None, user.org_id):
        raise HTTPException(403, "Analysts can validate records from their own organisation only")
    if body.status == ValidationStatus.rejected and not body.note:
        raise HTTPException(422, "A note is required when rejecting a record")
    before = o.validation_status.value
    o.validation_status, o.validation_note = body.status, body.note
    o.validated_by, o.validated_at = user.id, datetime.now(timezone.utc)
    audit.record(db, user, "validate", "observation", o.id, {"from": before, "to": body.status.value, "note": body.note}, request)
    db.commit()
    db.refresh(o)
    return serialize(o, user)


@router.delete("/observations/{obs_id}", status_code=204)
def delete_observation(obs_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    o = db.get(Observation, obs_id)
    if not o:
        raise HTTPException(404, "Observation not found")
    is_own_pending = o.observer_id == user.id and o.validation_status == ValidationStatus.pending
    if user.role != Role.admin and not is_own_pending:
        raise HTTPException(403, "Only administrators, or the observer while pending, can delete a record")
    audit.record(db, user, "delete", "observation", o.id, {"species": o.species, "observed_at": o.observed_at.isoformat()}, request)
    db.delete(o)
    db.commit()


# ---------- media ----------
def _strip_metadata(data: bytes, ctype: str) -> bytes:
    """Re-encode the image without EXIF so embedded GPS coordinates cannot leak."""
    img = Image.open(io.BytesIO(data))
    img.load()
    target = "RGB" if ctype == "image/jpeg" else ("RGBA" if img.mode not in ("RGB", "L") else img.mode)
    if img.mode != target:
        img = img.convert(target)
    clean = Image.new(img.mode, img.size)
    clean.paste(img)
    out = io.BytesIO()
    fmt = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}[ctype]
    clean.save(out, format=fmt, quality=92) if fmt != "PNG" else clean.save(out, format=fmt)
    return out.getvalue()


@router.post("/observations/{obs_id}/media", status_code=201)
async def upload_media(obs_id: int, request: Request, file: UploadFile = File(...), db: Session = Depends(get_db),
                       user: User = Depends(can_submit)):
    o = db.get(Observation, obs_id)
    if not o:
        raise HTTPException(404, "Observation not found")
    limit = get_settings().max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"File exceeds {get_settings().max_upload_mb} MB")
    ctype = sniff(data)
    if ctype not in ALLOWED_TYPES:
        raise HTTPException(415, "Only JPEG, PNG or WebP images are accepted")
    try:
        data = _strip_metadata(data, ctype)
    except Exception:
        raise HTTPException(422, "Image could not be decoded")
    key, digest = get_storage().put(data, ctype, f"observations/{obs_id}")
    result = classifier.classify(data, ctype)
    m = Media(observation_id=obs_id, storage_key=key, content_type=ctype, size_bytes=len(data), sha256=digest,
              classification=result, uploaded_by=user.id)
    db.add(m)
    db.flush()
    audit.record(db, user, "upload", "media", m.id, {"observation_id": obs_id, "sha256": digest}, request)
    db.commit()
    return {"id": m.id, "content_type": ctype, "size_bytes": m.size_bytes, "classification": result}


@router.get("/observations/{obs_id}/media")
def list_media(obs_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    rows = db.scalars(select(Media).where(Media.observation_id == obs_id)).all()
    return [{"id": m.id, "content_type": m.content_type, "size_bytes": m.size_bytes, "classification": m.classification,
             "created_at": m.created_at} for m in rows]


@router.get("/media/{media_id}")
def get_media(media_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    m = db.get(Media, media_id)
    if not m:
        raise HTTPException(404, "Media not found")
    return Response(get_storage().get(m.storage_key), media_type=m.content_type,
                    headers={"Cache-Control": "private, max-age=3600"})


# ---------- export ----------
@router.get("/exports/observations.csv")
def export_csv(area_id: int | None = None, status: ValidationStatus | None = None, request: Request = None,
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = _filtered(select(Observation), area_id, None, status, None, None, None, None)
    rows = db.scalars(q.options(selectinload(Observation.media)).order_by(Observation.observed_at)).unique().all()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "observed_at", "area", "species", "evidence_type", "count", "lon", "lat", "location_generalised",
                "validation_status", "source"])
    for o in rows:
        s = serialize(o, user)
        loc = s.location
        w.writerow([o.id, o.observed_at.isoformat(), s.area_name or "", o.species, o.evidence_type.value, o.count,
                    loc.lon if loc else "", loc.lat if loc else "", loc.generalised if loc else "",
                    o.validation_status.value, o.source])
    audit.record(db, user, "export", "observation", None, {"rows": len(rows), "area_id": area_id}, request)
    db.commit()
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=chimpwatch_observations.csv"})


# ---------- survey effort ----------
@router.get("/surveys", response_model=list[SurveyOut])
def list_surveys(area_id: int | None = None, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    q = select(SurveyEffort).order_by(SurveyEffort.start_date.desc()).limit(500)
    if area_id:
        q = q.where(SurveyEffort.area_id == area_id)
    return db.scalars(q).all()


@router.post("/surveys", response_model=SurveyOut, status_code=201)
def create_survey(body: SurveyIn, request: Request, db: Session = Depends(get_db), user: User = Depends(can_submit)):
    if body.end_date < body.start_date:
        raise HTTPException(422, "end_date must be on or after start_date")
    s = SurveyEffort(**body.model_dump(), org_id=user.org_id)
    db.add(s)
    db.flush()
    audit.record(db, user, "create", "survey", s.id, body.model_dump(mode="json"), request)
    db.commit()
    return s


EVIDENCE_TYPES = [e.value for e in EvidenceType]
