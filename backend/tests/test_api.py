import io
import uuid
from datetime import datetime, timedelta, timezone

from PIL import Image

from app.seed import DEMO_PASSWORD

KANGARI = (-11.70, 8.55)  # lon, lat inside a seeded area


def obs_payload(**kw):
    p = {"client_uuid": str(uuid.uuid4()), "evidence_type": "nest", "count": 3,
         "observed_at": (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(),
         "lon": KANGARI[0] + 0.0123, "lat": KANGARI[1] + 0.0071}
    p.update(kw)
    return p


# ---------------------------------------------------------------- auth
def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["database"] is True


def test_login_rejects_bad_password(client):
    r = client.post("/api/auth/login", data={"username": "viewer@chimpwatch.example", "password": "nope"})
    assert r.status_code == 401


def test_requires_auth(client):
    assert client.get("/api/observations").status_code == 401


def test_lockout_after_repeated_failures(client, admin):
    r = client.post("/api/users", headers=admin, json={"email": "lock@test.example", "full_name": "Lock Test",
                                                       "password": "Sufficient123", "role": "viewer", "org_id": 1})
    assert r.status_code == 201
    for _ in range(5):
        client.post("/api/auth/login", data={"username": "lock@test.example", "password": "wrong"})
    r = client.post("/api/auth/login", data={"username": "lock@test.example", "password": "Sufficient123"})
    assert r.status_code == 423


def test_weak_password_rejected(client, admin):
    r = client.post("/api/users", headers=admin, json={"email": "weak@test.example", "full_name": "Weak",
                                                       "password": "short", "org_id": 1})
    assert r.status_code == 422


# ---------------------------------------------------------------- RBAC & sensitive locations
def test_viewer_cannot_submit(client, viewer):
    assert client.post("/api/observations", headers=viewer, json=obs_payload()).status_code == 403


def test_location_generalised_for_unprivileged_users(client, ranger, viewer, analyst):
    r = client.post("/api/observations", headers=ranger, json=obs_payload())
    assert r.status_code == 201, r.text
    oid = r.json()["id"]
    assert r.json()["area_name"] == "Kangari Hills Forest Reserve"
    # the observer sees their own record precisely
    assert r.json()["location"]["generalised"] is False
    v = client.get(f"/api/observations/{oid}", headers=viewer).json()["location"]
    assert v["generalised"] is True and v["precision_km"] > 5
    assert abs(v["lon"] - (KANGARI[0] + 0.0123)) > 0.001
    a = client.get(f"/api/observations/{oid}", headers=analyst).json()["location"]
    assert a["generalised"] is False and abs(a["lon"] - (KANGARI[0] + 0.0123)) < 1e-5


def test_geojson_and_csv_respect_generalisation(client, viewer):
    fc = client.get("/api/observations.geojson?species=Pan", headers=viewer).json()
    assert fc["features"] and all(f["properties"]["generalised"] for f in fc["features"])
    csv = client.get("/api/exports/observations.csv", headers=viewer).text
    assert "True" in csv.splitlines()[1]


def test_future_observation_rejected(client, ranger):
    r = client.post("/api/observations", headers=ranger,
                    json=obs_payload(observed_at=(datetime.now(timezone.utc) + timedelta(days=2)).isoformat()))
    assert r.status_code == 422


def test_offline_sync_is_idempotent(client, ranger):
    items = [obs_payload(), obs_payload()]
    r1 = client.post("/api/observations/sync", headers=ranger, json=items).json()["results"]
    r2 = client.post("/api/observations/sync", headers=ranger, json=items).json()["results"]
    assert [x["status"] for x in r1] == ["created", "created"]
    assert [x["status"] for x in r2] == ["duplicate", "duplicate"]
    assert [x["id"] for x in r1] == [x["id"] for x in r2]


def test_validation_workflow(client, ranger, analyst, viewer):
    oid = client.post("/api/observations", headers=ranger, json=obs_payload()).json()["id"]
    assert client.post(f"/api/observations/{oid}/validate", headers=viewer, json={"status": "verified"}).status_code == 403
    assert client.post(f"/api/observations/{oid}/validate", headers=analyst, json={"status": "rejected"}).status_code == 422
    r = client.post(f"/api/observations/{oid}/validate", headers=analyst, json={"status": "verified", "note": "Nest confirmed"})
    assert r.status_code == 200 and r.json()["validation_status"] == "verified"


def test_media_upload_strips_exif_and_rejects_non_images(client, ranger):
    oid = client.post("/api/observations", headers=ranger, json=obs_payload()).json()["id"]
    img = Image.new("RGB", (64, 48), (40, 90, 50))
    exif = Image.Exif()
    exif[0x8825] = {2: (8.0, 33.0, 0.0)}  # GPS IFD
    exif[0x010F] = "TrailCam"
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif.tobytes())
    r = client.post(f"/api/observations/{oid}/media", headers=ranger, files={"file": ("x.jpg", buf.getvalue(), "image/jpeg")})
    assert r.status_code == 201, r.text
    assert r.json()["classification"]["review_status"] == "needs_review"
    mid = r.json()["id"]
    data = client.get(f"/api/media/{mid}", headers=ranger).content
    assert not Image.open(io.BytesIO(data)).getexif()
    bad = client.post(f"/api/observations/{oid}/media", headers=ranger,
                      files={"file": ("x.jpg", b"<script>alert(1)</script>", "image/jpeg")})
    assert bad.status_code == 415


# ---------------------------------------------------------------- analytics, alerts, tasks
def test_dashboard_and_assessments(client, viewer):
    d = client.get("/api/dashboard", headers=viewer).json()
    assert d["chimp_records_12m"] > 0 and len(d["areas"]) == 6
    levels = {a["area"]: a["level"] for a in d["areas"]}
    assert levels["Kangari Hills Forest Reserve"] == "high"
    assert levels["Gola Rainforest National Park"] == "low"
    latest = client.get("/api/analytics/latest", headers=viewer).json()
    for ra in latest:
        assert ra["model_version"] and set(ra["components"]) == {
            "population_concern", "habitat_pressure", "biodiversity_change", "ecosystem_condition",
            "food_security_vulnerability"}
        fs = ra["components"]["food_security_vulnerability"]
        assert "does not attribute" in fs["caveat"]
        assert ra["components"]["population_concern"]["basis"] == "modelled"


def test_modelled_alerts_are_labelled(client, viewer):
    items = client.get("/api/alerts?indicator=population_concern", headers=viewer).json()["items"]
    assert items and all("Modelled risk" in a["description"] for a in items)


def test_viewer_cannot_run_analytics(client, viewer, analyst):
    assert client.post("/api/analytics/run", headers=viewer).status_code == 403
    r = client.post("/api/analytics/run", headers=analyst)
    assert r.status_code == 200 and r.json()["assessed"] == 6


def test_rerun_does_not_duplicate_open_alerts(client, analyst):
    before = client.get("/api/alerts?open_only=true", headers=analyst).json()["total"]
    client.post("/api/analytics/run", headers=analyst)
    after = client.get("/api/alerts?open_only=true", headers=analyst).json()["total"]
    assert before == after


def test_alert_workflow_and_tasks(client, analyst, ranger):
    alerts = client.get("/api/alerts?status=new", headers=analyst).json()["items"]
    a = alerts[0]
    r = client.patch(f"/api/alerts/{a['id']}", headers=analyst, json={"status": "resolved"})
    assert r.status_code == 409
    r = client.patch(f"/api/alerts/{a['id']}", headers=analyst, json={"status": "verified"})
    assert r.status_code == 409  # new -> verified not allowed
    me_ranger = client.get("/api/auth/me", headers=ranger).json()["id"]
    t = client.post("/api/tasks", headers=analyst, json={"alert_id": a["id"], "title": "Verify nests", "assigned_to": me_ranger})
    assert t.status_code == 201
    assert client.get(f"/api/alerts/{a['id']}", headers=analyst).json()["status"] == "verifying"
    tid = t.json()["id"]
    assert client.patch(f"/api/tasks/{tid}", headers=ranger, json={"status": "done"}).status_code == 422
    assert client.patch(f"/api/tasks/{tid}", headers=ranger, json={"due_date": "2030-01-01"}).status_code == 403
    r = client.patch(f"/api/tasks/{tid}", headers=ranger, json={"status": "done", "outcome": "12 fresh nests found"})
    assert r.status_code == 200 and r.json()["completed_at"]
    assert client.patch(f"/api/alerts/{a['id']}", headers=analyst, json={"status": "verified"}).status_code == 422
    r = client.patch(f"/api/alerts/{a['id']}", headers=analyst, json={"status": "verified", "review_notes": "Confirmed in field"})
    assert r.status_code == 200 and r.json()["reviewed_by"]


def test_thresholds_validation_and_audit(client, analyst, admin, viewer):
    assert client.put("/api/thresholds/habitat_pressure", headers=analyst, json={"medium": 60, "high": 50}).status_code == 422
    assert client.put("/api/thresholds/habitat_pressure", headers=viewer, json={"medium": 40, "high": 70}).status_code == 403
    assert client.put("/api/thresholds/habitat_pressure", headers=analyst, json={"medium": 40, "high": 70}).status_code == 200
    log = client.get("/api/audit?entity=threshold", headers=admin).json()
    assert log and log[0]["detail"]["after"]["high"] == 70
    assert client.get("/api/audit", headers=analyst).status_code == 403


def test_reports(client, viewer):
    s = client.get("/api/reports/summary", headers=viewer).json()
    assert s["areas"][0]["level"] == "high"
    html = client.get("/api/reports/summary.html", headers=viewer).text
    assert "Situation report" in html and "not population counts" in html


# ---------------------------------------------------------------- imports & integrations
def test_csv_import_is_all_or_nothing(client, analyst):
    bad = ("category,indicator,district,area_name,period_start,value,unit,source,data_date\n"
           "ecosystem,ndvi_anomaly,,Gola Rainforest National Park,2026-07-01,-0.2,SD,Test,2026-10-01\n"
           "nonsense,x,,,2026-07-01,1,,Test,\n")
    r = client.post("/api/imports/indicators", headers=analyst, files={"file": ("i.csv", bad, "text/csv")})
    assert r.status_code == 422 and "Row 3" in r.json()["detail"]["errors"][0]
    good = bad.splitlines()[0] + "\n" + bad.splitlines()[1] + "\n"
    r = client.post("/api/imports/indicators", headers=analyst, files={"file": ("i.csv", good, "text/csv")})
    assert r.status_code == 200 and r.json()["imported"] == 1


def test_gbif_records_import_as_pending(client):
    from app.db import SessionLocal
    from app.models import Observation
    from app.services import gbif
    recs = [{"key": 999001, "decimalLatitude": 7.61, "decimalLongitude": -10.87, "eventDate": "2025-03-04T10:00:00",
             "species": "Pan troglodytes", "basisOfRecord": "HUMAN_OBSERVATION", "license": "CC_BY_4_0"},
            {"key": 999002, "decimalLatitude": None, "decimalLongitude": None}]
    with SessionLocal() as db:
        res = gbif.import_records(db, recs, None)
        db.commit()
        again = gbif.import_records(db, recs, None)
        o = db.query(Observation).filter_by(external_id="999001").one()
    assert res == {"created": 1, "skipped": 1} and again["created"] == 0
    assert o.validation_status.value == "pending" and o.sensitive and o.area_id is not None


def test_password_change(client, admin):
    client.post("/api/users", headers=admin, json={"email": "pw@test.example", "full_name": "PW",
                                                   "password": "Original123", "role": "viewer", "org_id": 1})
    tok = client.post("/api/auth/login", data={"username": "pw@test.example", "password": "Original123"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert client.post("/api/auth/change-password", headers=h, json={"current_password": "bad", "new_password": "Another1234"}).status_code == 400
    assert client.post("/api/auth/change-password", headers=h, json={"current_password": "Original123", "new_password": "Another1234"}).status_code == 204
    assert client.post("/api/auth/login", data={"username": "pw@test.example", "password": "Another1234"}).status_code == 200


def test_admin_cannot_demote_self(client, admin):
    me = client.get("/api/auth/me", headers=admin).json()
    assert client.patch(f"/api/users/{me['id']}", headers=admin, json={"role": "viewer"}).status_code == 400


def test_demo_password_constant():
    assert len(DEMO_PASSWORD) >= 10


def test_csv_import_rejects_future_dates(client, analyst):
    future = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()
    body = ("category,indicator,district,area_name,period_start,value,unit,source,data_date\n"
            f"ecosystem,ndvi_anomaly,,Gola Rainforest National Park,{future},-0.2,SD,Test,\n")
    r = client.post("/api/imports/indicators", headers=analyst, files={"file": ("i.csv", body, "text/csv")})
    assert r.status_code == 422 and "future" in r.json()["detail"]["errors"][0]


def test_seed_has_no_future_data(client, viewer):
    today = datetime.now(timezone.utc).date().isoformat()
    for ra in client.get("/api/analytics/latest", headers=viewer).json():
        assert ra["data_as_of"] <= today
        for c in ra["components"].values():
            assert not c["data_as_of"] or c["data_as_of"] <= today
