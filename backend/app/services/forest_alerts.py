"""Satellite forest-disturbance alerts from Global Forest Watch (GFW Data API).

For each monitored landscape we query the integrated deforestation alerts dataset
(GLAD-L, GLAD-S2 and RADD combined) with the landscape boundary, store new alert pixels,
then group them into ~1 km hotspots per week. Each hotspot becomes a `forest_loss_alert`
pressure report awaiting verification, which feeds the habitat-pressure indicator.

API reference: POST {gfw_data_api_url}/dataset/gfw_integrated_alerts/latest/query/json
with header x-api-key and body {"sql": ..., "geometry": <GeoJSON polygon>}.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

import httpx
from geoalchemy2.shape import from_shape, to_shape
from shapely.geometry import Point, mapping
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import ForestAlert, PressureEvent, ProtectedArea, SyncState, ValidationStatus
from . import notify

log = logging.getLogger("chimpwatch.gfw")

CONF_RANK = {"low": 0, "nominal": 1, "high": 2, "highest": 3}
STATE_KEY = "gfw_forest_alerts"
CELL_DEG = 0.01  # ~1.1 km hotspots


def configured() -> bool:
    return bool(get_settings().gfw_api_key)


def _client() -> httpx.Client:
    return httpx.Client(timeout=60, headers={"User-Agent": "chimpwatch-ai"})


def status(db: Session) -> dict:
    st = db.get(SyncState, STATE_KEY)
    total = db.scalar(select(func.count(ForestAlert.id))) or 0
    last90 = db.scalar(select(func.count(ForestAlert.id)).where(
        ForestAlert.alert_date >= date.today() - timedelta(days=90))) or 0
    return {"configured": configured(), "dataset": get_settings().gfw_dataset, "total_alerts": total,
            "alerts_90d": last90, "last_sync": (st.value or {}) if st else None}


def _query_area(client: httpx.Client, area: ProtectedArea, since: date) -> list[dict]:
    s = get_settings()
    shape = to_shape(area.geom).simplify(0.0005, preserve_topology=True)
    sql = ("SELECT longitude, latitude, gfw_integrated_alerts__date, gfw_integrated_alerts__confidence, "
           "gfw_integrated_alerts__intensity FROM results "
           f"WHERE gfw_integrated_alerts__date >= '{since.isoformat()}'")
    r = client.post(f"{s.gfw_data_api_url.rstrip('/')}/dataset/{s.gfw_dataset}/latest/query/json",
                    headers={"x-api-key": s.gfw_api_key or "", "Content-Type": "application/json"},
                    content=json.dumps({"sql": sql, "geometry": mapping(shape)}))
    if r.status_code != 200:
        raise RuntimeError(f"GFW returned {r.status_code}: {r.text[:200]}")
    body = r.json()
    if body.get("status") not in (None, "success"):
        raise RuntimeError(f"GFW query failed: {str(body)[:200]}")
    return body.get("data", [])


def ingest(db: Session, area: ProtectedArea, rows: list[dict], source: str = "gfw_integrated_alerts") -> list[ForestAlert]:
    """Store alert rows (deduplicated). Returns the newly created alerts."""
    min_rank = CONF_RANK.get(get_settings().forest_alert_min_confidence, 1)
    new: list[ForestAlert] = []
    for row in rows:
        try:
            lat, lon = round(float(row["latitude"]), 5), round(float(row["longitude"]), 5)
            d = date.fromisoformat(str(row.get("gfw_integrated_alerts__date") or row.get("date"))[:10])
        except (KeyError, TypeError, ValueError):
            continue
        conf = str(row.get("gfw_integrated_alerts__confidence") or row.get("confidence") or "nominal").lower()
        if CONF_RANK.get(conf, 1) < min_rank:
            continue
        exists = db.scalar(select(ForestAlert.id).where(ForestAlert.source == source, ForestAlert.alert_date == d,
                                                        ForestAlert.lat == lat, ForestAlert.lon == lon))
        if exists:
            continue
        fa = ForestAlert(area_id=area.id, alert_date=d, lat=lat, lon=lon, geom=from_shape(Point(lon, lat), srid=4326),
                         confidence=conf, intensity=row.get("gfw_integrated_alerts__intensity"), source=source)
        db.add(fa)
        new.append(fa)
    db.flush()
    return new


def cluster_to_pressures(db: Session, alerts: list[ForestAlert]) -> list[PressureEvent]:
    """Group new alert pixels into ~1 km weekly hotspots and raise one pressure report per hotspot."""
    groups: dict[tuple, list[ForestAlert]] = defaultdict(list)
    for a in alerts:
        week = a.alert_date - timedelta(days=a.alert_date.weekday())
        groups[(a.area_id, week, int(a.lat // CELL_DEG), int(a.lon // CELL_DEG))].append(a)
    events = []
    for (area_id, week, _, _), px in groups.items():
        best = max(px, key=lambda a: CONF_RANK.get(a.confidence, 1))
        n = len(px)
        severity = 3 if n >= 20 or CONF_RANK.get(best.confidence, 1) >= 3 else 2 if n >= 5 or best.confidence == "high" else 1
        lat = sum(a.lat for a in px) / n
        lon = sum(a.lon for a in px) / n
        ev = PressureEvent(area_id=area_id, kind="forest_loss_alert", severity=severity,
                           observed_at=datetime.combine(max(a.alert_date for a in px), datetime.min.time(), timezone.utc),
                           geom=from_shape(Point(lon, lat), srid=4326), source="gfw" if px[0].source != "demo" else "demo",
                           validation_status=ValidationStatus.pending,
                           description=(f"{n} satellite forest-disturbance alert pixel{'s' if n != 1 else ''} in the week of "
                                        f"{week:%d %b %Y} (GFW integrated alerts; highest confidence: {best.confidence}). "
                                        "Verify on the ground or with recent imagery."))
        db.add(ev)
        db.flush()
        for a in px:
            a.pressure_event_id = ev.id
        events.append(ev)
    return events


def sync(db: Session, lookback_days: int | None = None, client: httpx.Client | None = None) -> dict:
    if not configured():
        return {"configured": False, "message": "Set CW_GFW_API_KEY to enable satellite forest alerts."}
    s = get_settings()
    lookback = lookback_days or s.forest_alert_lookback_days
    result = {"configured": True, "areas": 0, "new_alerts": 0, "hotspots": 0, "errors": []}
    own = client is None
    c = client or _client()
    try:
        for area in db.scalars(select(ProtectedArea)):
            last = db.scalar(select(func.max(ForestAlert.alert_date)).where(ForestAlert.area_id == area.id,
                                                                              ForestAlert.source == "gfw_integrated_alerts"))
            since = max(last - timedelta(days=7), date.today() - timedelta(days=lookback)) if last else date.today() - timedelta(days=lookback)
            try:
                rows = _query_area(c, area, since)
            except Exception as exc:
                log.warning("GFW query for %s failed: %s", area.name, exc)
                result["errors"].append(f"{area.name}: {exc}")
                continue
            new = ingest(db, area, rows)
            events = cluster_to_pressures(db, new)
            result["areas"] += 1
            result["new_alerts"] += len(new)
            result["hotspots"] += len(events)
    finally:
        if own:
            c.close()
    st = db.get(SyncState, STATE_KEY) or SyncState(key=STATE_KEY)
    st.value = {"at": datetime.now(timezone.utc).isoformat(), **{k: v for k, v in result.items() if k != "configured"}}
    db.add(st)
    db.commit()
    notify.forest_alerts_found(db, result["hotspots"], result["new_alerts"])
    db.commit()
    return result


def due(db: Session) -> bool:
    if not configured():
        return False
    st = db.get(SyncState, STATE_KEY)
    if not st or not st.value or "at" not in st.value:
        return True
    last = datetime.fromisoformat(st.value["at"])
    return datetime.now(timezone.utc) - last >= timedelta(hours=get_settings().forest_alert_sync_hours)
