"""Camera-trap helpers: capture timestamps and platform-derived species richness."""
from __future__ import annotations

import io
from datetime import date, datetime, timezone

from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import CameraCapture, CameraDeployment, CameraStation, EnvironmentalIndicator, ProtectedArea
from .analytics import quarter_start

RICHNESS_SOURCE = "CHIMP-WATCH camera traps"
NON_SPECIES = {"", "unknown", "human", "vehicle", "domestic dog", "empty"}


def exif_datetime(data: bytes) -> datetime | None:
    """Read DateTimeOriginal from a camera-trap photo, if present."""
    try:
        img = Image.open(io.BytesIO(data))
        exif = img.getexif()
        raw = exif.get_ifd(0x8769).get(36867) or exif.get(306)  # DateTimeOriginal, else DateTime
        if not raw:
            return None
        return datetime.strptime(str(raw).strip()[:19], "%Y:%m:%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def refresh_richness(db: Session, area_id: int) -> int:
    """Recompute quarterly species richness from confirmed captures for one landscape."""
    rows = db.execute(
        select(CameraCapture.captured_at, CameraCapture.species)
        .join(CameraDeployment, CameraCapture.deployment_id == CameraDeployment.id)
        .join(CameraStation, CameraDeployment.station_id == CameraStation.id)
        .where(CameraStation.area_id == area_id, CameraCapture.review_status == "confirmed")
    ).all()
    by_q: dict[date, set[str]] = {}
    for when, sp in rows:
        if sp and sp.strip().lower() not in NON_SPECIES:
            by_q.setdefault(quarter_start(when.date()), set()).add(sp.strip())
    area = db.get(ProtectedArea, area_id)
    for q, species in by_q.items():
        ind = db.scalar(select(EnvironmentalIndicator).where(
            EnvironmentalIndicator.indicator == "species_richness", EnvironmentalIndicator.area_id == area_id,
            EnvironmentalIndicator.period_start == q, EnvironmentalIndicator.source == RICHNESS_SOURCE))
        if not ind:
            ind = EnvironmentalIndicator(category="biodiversity", indicator="species_richness", area_id=area_id,
                                         district=area.district if area else None, period_start=q, unit="species",
                                         source=RICHNESS_SOURCE)
            db.add(ind)
        ind.value = float(len(species))
        ind.data_date = date.today()
        ind.notes = ", ".join(sorted(species))[:2000]
    db.flush()
    return len(by_q)


def trap_days(dep: CameraDeployment, today: date | None = None) -> int:
    end = dep.retrieved_on or today or date.today()
    return max(0, (end - dep.deployed_on).days)


def station_counts(db: Session) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for sid, status, n in db.execute(
        select(CameraDeployment.station_id, CameraCapture.review_status, func.count())
        .join(CameraDeployment, CameraCapture.deployment_id == CameraDeployment.id)
        .group_by(CameraDeployment.station_id, CameraCapture.review_status)
    ).all():
        out.setdefault(sid, {})[status] = n
    return out
