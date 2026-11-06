"""GBIF occurrence import (https://www.gbif.org/developer/occurrence).

Imports georeferenced occurrence records for a species in the configured country.
Each record keeps its GBIF key, licence and basis of record. Imported records enter the
validation queue as ``pending``; they are never auto-verified.
"""
from __future__ import annotations

from datetime import datetime, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..geo import point
from ..models import EvidenceType, Observation
from .spatial import assign_area

BASIS_TO_EVIDENCE = {
    "HUMAN_OBSERVATION": EvidenceType.direct_sighting,
    "MACHINE_OBSERVATION": EvidenceType.camera_trap,
    "OBSERVATION": EvidenceType.direct_sighting,
}


def fetch(scientific_name: str, limit: int = 300, client: httpx.Client | None = None) -> list[dict]:
    s = get_settings()
    c = client or httpx.Client(timeout=30)
    out, offset = [], 0
    while len(out) < limit:
        r = c.get(f"{s.gbif_api_url}/occurrence/search", params={
            "scientificName": scientific_name, "country": s.gbif_country, "hasCoordinate": "true",
            "hasGeospatialIssue": "false", "limit": min(300, limit - len(out)), "offset": offset})
        r.raise_for_status()
        data = r.json()
        out.extend(data.get("results", []))
        if data.get("endOfRecords", True):
            break
        offset += data.get("limit", 300)
    return out


def import_records(db: Session, records: list[dict], org_id: int | None) -> dict:
    created = skipped = 0
    for rec in records:
        key = str(rec.get("key") or rec.get("gbifID") or "")
        lat, lon = rec.get("decimalLatitude"), rec.get("decimalLongitude")
        if not key or lat is None or lon is None:
            skipped += 1
            continue
        if db.scalar(select(Observation.id).where(Observation.source == "gbif", Observation.external_id == key)):
            skipped += 1
            continue
        when = rec.get("eventDate")
        try:
            observed = datetime.fromisoformat(when.replace("Z", "+00:00")) if when else None
        except ValueError:
            observed = None
        if observed is None:
            skipped += 1
            continue
        if observed.tzinfo is None:
            observed = observed.replace(tzinfo=timezone.utc)
        species = rec.get("species") or rec.get("scientificName", "unknown")
        geom = point(lat, lon)
        obs = Observation(
            species=species, common_name=rec.get("vernacularName"),
            evidence_type=BASIS_TO_EVIDENCE.get(rec.get("basisOfRecord", ""), EvidenceType.direct_sighting),
            count=int(rec.get("individualCount") or 1), observed_at=observed, geom=geom,
            gps_accuracy_m=rec.get("coordinateUncertaintyInMeters"), sensitive=species.startswith("Pan "),
            source="gbif", external_id=key, licence=rec.get("license"), org_id=org_id,
            notes=f"GBIF dataset {rec.get('datasetKey', '?')}; basis {rec.get('basisOfRecord', '?')}",
        )
        obs.area_id = assign_area(db, lon, lat)
        db.add(obs)
        created += 1
    db.flush()
    return {"created": created, "skipped": skipped}
