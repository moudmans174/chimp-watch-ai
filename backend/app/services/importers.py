"""CSV bulk import for data managers.

Every row is validated; the import is all-or-nothing and returns row-level errors.
"""
from __future__ import annotations

import csv
import io
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..geo import point
from ..models import EnvironmentalIndicator, EvidenceType, HabitatMetric, Observation, ProtectedArea
from .spatial import assign_area

TEMPLATES = {
    "observations": ["observed_at", "lat", "lon", "species", "evidence_type", "count", "notes"],
    "habitat": ["area_name", "period_start", "period_end", "forest_cover_km2", "forest_loss_km2",
                "fragmentation_index", "suitability_index", "source", "data_date"],
    "indicators": ["category", "indicator", "district", "area_name", "period_start", "value", "unit", "source", "data_date"],
}
CATEGORIES = {"ecosystem", "food_security", "climate", "biodiversity"}
MAX_ROWS = 20000


class ImportError_(Exception):
    def __init__(self, errors: list[str]):
        self.errors = errors


def _rows(content: bytes, kind: str):
    text = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    missing = [c for c in TEMPLATES[kind] if c not in (reader.fieldnames or []) and c not in ("notes", "unit", "data_date", "fragmentation_index", "suitability_index", "district", "area_name")]
    if missing:
        raise ImportError_([f"Missing required columns: {', '.join(missing)}"])
    rows = list(reader)
    if len(rows) > MAX_ROWS:
        raise ImportError_([f"Too many rows (max {MAX_ROWS})"])
    return rows


def _d(v: str | None) -> date | None:
    if not v or not v.strip():
        return None
    d = date.fromisoformat(v.strip())
    if d > datetime.now(timezone.utc).date():
        raise ValueError(f"date {d} is in the future")
    return d


def _f(v: str | None) -> float | None:
    return float(v) if v not in (None, "") else None


def _area_lookup(db: Session) -> dict[str, int]:
    return {n.lower(): i for i, n in db.execute(select(ProtectedArea.id, ProtectedArea.name)).all()}


def import_csv(db: Session, kind: str, content: bytes, org_id: int | None, user_id: int | None) -> dict:
    if kind not in TEMPLATES:
        raise ImportError_([f"Unknown import type {kind}"])
    rows = _rows(content, kind)
    areas = _area_lookup(db)
    errors: list[str] = []
    objs = []
    for i, r in enumerate(rows, start=2):
        try:
            if kind == "observations":
                when = datetime.fromisoformat(r["observed_at"].strip())
                if when.tzinfo is None:
                    when = when.replace(tzinfo=timezone.utc)
                if when > datetime.now(timezone.utc):
                    raise ValueError("observed_at is in the future")
                lat, lon = float(r["lat"]), float(r["lon"])
                species = (r.get("species") or "Pan troglodytes verus").strip()
                o = Observation(observed_at=when, geom=point(lat, lon), species=species,
                                evidence_type=EvidenceType(r["evidence_type"].strip()),
                                count=int(r.get("count") or 1), notes=r.get("notes") or None, source="import",
                                org_id=org_id, observer_id=user_id, sensitive=species.startswith("Pan "))
                o.area_id = assign_area(db, lon, lat)
                objs.append(o)
            elif kind == "habitat":
                aid = areas.get((r.get("area_name") or "").strip().lower())
                if not aid:
                    raise ValueError(f"unknown area '{r.get('area_name')}'")
                objs.append(HabitatMetric(area_id=aid, period_start=_d(r["period_start"]), period_end=_d(r["period_end"]),
                                          forest_cover_km2=float(r["forest_cover_km2"]),
                                          forest_loss_km2=float(r.get("forest_loss_km2") or 0),
                                          fragmentation_index=_f(r.get("fragmentation_index")),
                                          suitability_index=_f(r.get("suitability_index")),
                                          source=r["source"].strip(), data_date=_d(r.get("data_date"))))
            else:
                cat = r["category"].strip()
                if cat not in CATEGORIES:
                    raise ValueError(f"category must be one of {sorted(CATEGORIES)}")
                aname = (r.get("area_name") or "").strip()
                aid = areas.get(aname.lower()) if aname else None
                if aname and not aid:
                    raise ValueError(f"unknown area '{aname}'")
                objs.append(EnvironmentalIndicator(category=cat, indicator=r["indicator"].strip(),
                                                   district=(r.get("district") or "").strip() or None, area_id=aid,
                                                   period_start=_d(r["period_start"]), value=float(r["value"]),
                                                   unit=r.get("unit") or None, source=r["source"].strip(),
                                                   data_date=_d(r.get("data_date"))))
        except (ValueError, KeyError, TypeError) as exc:
            errors.append(f"Row {i}: {exc}")
            if len(errors) >= 50:
                break
    if errors:
        raise ImportError_(errors)
    db.add_all(objs)
    db.flush()
    return {"imported": len(objs)}
