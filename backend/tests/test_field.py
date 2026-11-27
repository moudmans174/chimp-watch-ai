"""Camera traps, patrols, human-wildlife conflict, outreach, forest alerts, notifications."""
import io
import json
import uuid
from datetime import date, datetime, timedelta, timezone

import httpx
from PIL import Image

from app.config import get_settings
from app.db import SessionLocal
from app.services import forest_alerts

KANGARI = (-11.70, 8.55)


def jpeg(color=(30, 60, 40), when: str | None = "2026:10:14 05:42:10") -> bytes:
    img = Image.new("RGB", (80, 60), color)
    buf = io.BytesIO()
    exif = Image.Exif()
    if when:
        exif[306] = when
    img.save(buf, format="JPEG", exif=exif.tobytes())
    return buf.getvalue()


def me(client, h):
    return client.get("/api/auth/me", headers=h).json()


# ------------------------------------------------------------------ camera traps
def test_camera_trap_full_cycle(client, ranger, analyst, viewer):
    code = f"KH-T{uuid.uuid4().hex[:4]}"
    r = client.post("/api/camera/stations", headers=ranger, json={"code": code, "lat": KANGARI[1], "lon": KANGARI[0], "habitat": "Riverine"})
    assert r.status_code == 201, r.text
    st = r.json()
    assert st["area_name"] == "Kangari Hills Forest Reserve"
    # station position is sensitive: generalised for viewers
    v = next(s for s in client.get("/api/camera/stations", headers=viewer).json() if s["id"] == st["id"])
    assert v["location"]["generalised"] is True
    d = client.post(f"/api/camera/stations/{st['id']}/deploy", headers=ranger,
                    json={"deployed_on": (date.today() - timedelta(days=30)).isoformat(), "camera_model": "Browning"})
    assert d.status_code == 201
    assert client.post(f"/api/camera/stations/{st['id']}/deploy", headers=ranger, json={"deployed_on": date.today().isoformat()}).status_code == 409
    did = d.json()["id"]
    files = [("files", ("a.jpg", jpeg(), "image/jpeg")), ("files", ("b.jpg", jpeg((10, 10, 10)), "image/jpeg")),
             ("files", ("a-copy.jpg", jpeg(), "image/jpeg")), ("files", ("bad.jpg", b"not an image", "image/jpeg"))]
    up = client.post(f"/api/camera/deployments/{did}/captures", headers=ranger, files=files).json()
    assert up["created"] == 2 and up["duplicates"] == 1 and len(up["errors"]) == 1
    queue = client.get(f"/api/camera/captures?status=pending&station_id={st['id']}", headers=analyst).json()["items"]
    assert len(queue) == 2 and queue[0]["captured_at"].startswith("2026-10-14")
    img = client.get(f"/api/camera/captures/{queue[0]['id']}/image", headers=viewer)
    assert img.status_code == 200 and not Image.open(io.BytesIO(img.content)).getexif()
    # review: field monitors can't; confirming needs a species; confirm creates a verified observation
    assert client.post(f"/api/camera/captures/{queue[0]['id']}/review", headers=ranger, json={"status": "confirmed", "species": "x"}).status_code == 403
    assert client.post(f"/api/camera/captures/{queue[0]['id']}/review", headers=analyst, json={"status": "confirmed"}).status_code == 422
    r = client.post(f"/api/camera/captures/{queue[0]['id']}/review", headers=analyst,
                    json={"status": "confirmed", "species": "Pan troglodytes verus", "common_name": "Western chimpanzee", "count": 3})
    assert r.status_code == 200 and r.json()["observation_id"]
    obs = client.get(f"/api/observations/{r.json()['observation_id']}", headers=analyst).json()
    assert obs["source"] == "camera_trap" and obs["validation_status"] == "verified" and obs["count"] == 3 and obs["sensitive"]
    client.post(f"/api/camera/captures/{queue[1]['id']}/review", headers=analyst, json={"status": "empty"})
    # retrieval turns trap-days into survey effort
    r = client.post(f"/api/camera/deployments/{did}/retrieve", headers=ranger, json={"retrieved_on": date.today().isoformat()})
    assert r.status_code == 200 and r.json()["trap_days"] == 30 and r.json()["survey_id"]
    s = client.get("/api/camera/summary", headers=viewer).json()
    assert s["trap_days_12m"] >= 30 and s["captures"].get("confirmed", 0) >= 1
    # platform-derived richness indicator exists for the landscape
    inds = client.get("/api/indicators?indicator=species_richness&area_id=5", headers=viewer).json()
    assert any(i["source"] == "CHIMP-WATCH camera traps" for i in inds)


def test_capture_upload_notifies_analysts(client, ranger, analyst):
    st = client.post("/api/camera/stations", headers=ranger, json={"code": f"NT-{uuid.uuid4().hex[:4]}", "lat": 7.6, "lon": -10.88}).json()
    did = client.post(f"/api/camera/stations/{st['id']}/deploy", headers=ranger, json={"deployed_on": date.today().isoformat()}).json()["id"]
    client.post(f"/api/camera/deployments/{did}/captures", headers=ranger, files=[("files", ("x.jpg", jpeg((90, 20, 20), None), "image/jpeg"))])
    n = client.get("/api/notifications", headers=analyst).json()
    assert n["unread"] >= 1 and any(i["kind"] == "camera" for i in n["items"])


# ------------------------------------------------------------------ patrols
def track(n=30, lon=-11.715, lat=8.545, step=0.001):
    return [[lon + i * step, lat + (i % 3) * 0.0003] for i in range(n)]


def test_patrol_record_distance_area_and_idempotency(client, ranger, viewer, analyst):
    now = datetime.now(timezone.utc)
    body = {"client_uuid": str(uuid.uuid4()), "started_at": (now - timedelta(hours=3)).isoformat(), "ended_at": now.isoformat(),
            "team": "Team C", "purpose": "monitoring", "points": track()}
    r1 = client.post("/api/patrols", headers=ranger, json=body)
    r2 = client.post("/api/patrols", headers=ranger, json=body)
    assert r1.status_code == 201 and r2.status_code == 200 and r1.json()["id"] == r2.json()["id"]
    p = r1.json()
    assert p["area_name"] == "Kangari Hills Forest Reserve" and 3.0 < p["distance_km"] < 3.5 and p["hours"] == 3.0
    assert client.post("/api/patrols", headers=viewer, json={**body, "client_uuid": str(uuid.uuid4())}).status_code == 403
    bad = {**body, "client_uuid": str(uuid.uuid4()), "points": [[0, 0], [0, 0]]}
    assert client.post("/api/patrols", headers=ranger, json=bad).status_code == 422
    # routes are hidden from viewers
    assert client.get("/api/patrols.geojson", headers=viewer).json()["features"] == []
    assert any(f["properties"]["id"] == p["id"] for f in client.get("/api/patrols.geojson", headers=analyst).json()["features"])
    s = client.get("/api/patrols/summary?days=30", headers=viewer).json()
    assert any(a["area_name"] == "Kangari Hills Forest Reserve" and a["km"] >= 3 for a in s["by_area"])


# ------------------------------------------------------------------ conflict
def test_conflict_reporting_privacy_and_workflow(client, ranger, analyst, viewer):
    body = {"client_uuid": str(uuid.uuid4()), "occurred_at": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
            "lat": 8.6, "lon": -11.66, "community": "Mabonto", "species": "chimpanzee", "kind": "crop_raiding",
            "crops": "Rice", "area_damaged_ha": 0.8, "loss_estimate_le": 1500000, "reporter_name": "Fatu K.", "reporter_phone": "+232 76 111222"}
    r = client.post("/api/conflicts", headers=ranger, json=body)
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    assert r.json()["district"] == "Tonkolili"
    assert client.post("/api/conflicts", headers=ranger, json=body).status_code == 200
    seen_by_viewer = next(c for c in client.get("/api/conflicts", headers=viewer).json() if c["id"] == cid)
    assert seen_by_viewer["reporter_phone"] is None and seen_by_viewer["reporter_name"] is None
    seen_by_analyst = next(c for c in client.get("/api/conflicts", headers=analyst).json() if c["id"] == cid)
    assert seen_by_analyst["reporter_phone"] == "+232 76 111222"
    assert any(n["kind"] == "conflict" for n in client.get("/api/notifications", headers=analyst).json()["items"])
    # workflow
    assert client.patch(f"/api/conflicts/{cid}", headers=ranger, json={"status": "verified"}).status_code == 403
    assert client.patch(f"/api/conflicts/{cid}", headers=analyst, json={"status": "closed"}).status_code == 422
    rid = me(client, ranger)["id"]
    r = client.patch(f"/api/conflicts/{cid}", headers=analyst, json={"status": "verified", "assigned_to": rid})
    assert r.status_code == 200
    assert any(n["kind"] == "conflict" and "assigned" in n["title"] for n in client.get("/api/notifications", headers=ranger).json()["items"])
    bad = {**body, "client_uuid": str(uuid.uuid4()), "species": "dragon"}
    assert client.post("/api/conflicts", headers=ranger, json=bad).status_code == 422
    s = client.get("/api/conflicts/summary", headers=viewer).json()
    assert s["by_kind"]["crop_raiding"] >= 1 and s["by_district"]["Tonkolili"] >= 1


def test_conflicts_appear_as_food_security_context(client, analyst):
    client.post("/api/analytics/run?area_id=5", headers=analyst)
    ra = next(a for a in client.get("/api/analytics/latest", headers=analyst).json() if a["area_id"] == 5)
    fs = ra["components"]["food_security_vulnerability"]
    assert fs["metrics"]["crop_raiding_incidents_12m"] >= 1 and "not used in the score" in " ".join(fs["drivers"])


# ------------------------------------------------------------------ outreach
def test_outreach_log(client, analyst, ranger, viewer):
    body = {"area_id": 3, "community": "Lalehun", "kind": "meeting", "held_on": date.today().isoformat(), "participants": 40,
            "women": 18, "youth": 12, "summary": "Discussed crop protection and the community monitoring scheme.",
            "follow_up": "Deliver deterrent training", "follow_up_due": (date.today() + timedelta(days=14)).isoformat()}
    r = client.post("/api/outreach", headers=analyst, json=body)
    assert r.status_code == 201
    oid = r.json()["id"]
    assert client.post("/api/outreach", headers=analyst, json={**body, "women": 50}).status_code == 422
    assert client.post("/api/outreach", headers=viewer, json=body).status_code == 403
    assert client.patch(f"/api/outreach/{oid}", headers=ranger, json={"follow_up_done": True}).status_code == 403
    assert client.patch(f"/api/outreach/{oid}", headers=analyst, json={"follow_up_done": True}).json()["follow_up_done"]
    s = client.get("/api/outreach/summary", headers=viewer).json()
    assert s["participants"] >= 40 and s["women"] >= 18


# ------------------------------------------------------------------ forest alerts
def test_forest_alerts_unconfigured(client, analyst):
    assert client.get("/api/forest-alerts/status", headers=analyst).json()["configured"] is False
    assert client.post("/api/forest-alerts/sync", headers=analyst).status_code == 409


def test_forest_alert_sync_clusters_into_pressures(monkeypatch, client, analyst):
    monkeypatch.setattr(get_settings(), "gfw_api_key", "test-key")
    seen = []
    today = date.today()

    def handler(req: httpx.Request):
        seen.append(req)
        assert req.headers["x-api-key"] == "test-key"
        body = json.loads(req.content)
        assert "gfw_integrated_alerts__date >=" in body["sql"] and body["geometry"]["type"] in ("Polygon", "MultiPolygon")
        if "Kangari" not in json.dumps(body) and len(seen) != 5:
            return httpx.Response(200, json={"data": [], "status": "success"})
        rows = [{"latitude": 8.551 + i * 0.0002, "longitude": -11.702, "gfw_integrated_alerts__date": today.isoformat(),
                 "gfw_integrated_alerts__confidence": "high", "gfw_integrated_alerts__intensity": 40} for i in range(6)]
        rows.append({"latitude": 8.55, "longitude": -11.70, "gfw_integrated_alerts__date": today.isoformat(),
                     "gfw_integrated_alerts__confidence": "low"})  # below the confidence threshold
        return httpx.Response(200, json={"data": rows, "status": "success"})

    with SessionLocal() as db:
        out = forest_alerts.sync(db, lookback_days=30, client=httpx.Client(transport=httpx.MockTransport(handler)))
        again = forest_alerts.sync(db, lookback_days=30, client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert out["new_alerts"] == 6 and out["hotspots"] == 1 and again["new_alerts"] == 0
    press = client.get("/api/pressures?kind=forest_loss_alert&days=10", headers=analyst).json()
    assert any(p["severity"] == 2 and "GFW" in p["description"] for p in press)
    assert any(n["kind"] == "forest" for n in client.get("/api/notifications", headers=analyst).json()["items"])
    st = client.get("/api/forest-alerts/status", headers=analyst).json()
    assert st["configured"] and st["last_sync"]["new_alerts"] == 0


# ------------------------------------------------------------------ notifications & tasks
def test_task_assignment_notifies_and_read_state(client, analyst, ranger):
    rid = me(client, ranger)["id"]
    t = client.post("/api/tasks", headers=analyst, json={"title": "Check camera KH-CT01 batteries", "assigned_to": rid, "area_id": 5})
    assert t.status_code == 201
    n = client.get("/api/notifications", headers=ranger).json()
    item = next(i for i in n["items"] if i["kind"] == "task")
    assert "Check camera" in item["title"] and not item["read"]
    assert client.post(f"/api/notifications/{item['id']}/read", headers=ranger).status_code == 204
    assert client.post(f"/api/notifications/{item['id']}/read", headers=analyst).status_code == 404
    client.post("/api/notifications/read-all", headers=ranger)
    assert client.get("/api/notifications", headers=ranger).json()["unread"] == 0


def test_dashboard_field_activity(client, viewer):
    f = client.get("/api/dashboard", headers=viewer).json()["field"]
    assert f["patrols_30d"] >= 1 and f["conflicts_90d"] >= 1 and "captures_to_review" in f
