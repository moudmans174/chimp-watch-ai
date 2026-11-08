"""Password reset, profile, notifications, survey sessions, landscapes, admin CLI."""
import re
import uuid
from datetime import date, datetime, timedelta, timezone

from app.services import mailer


def last_mail(to: str):
    return next((m for m in reversed(mailer.outbox) if to in m.to), None)


def test_forgot_and_reset_password_single_use(client, admin):
    client.post("/api/users", headers=admin, json={"email": "reset.me@test.example", "full_name": "Reset Me",
                                                   "password": "Original-Pass-1", "role": "viewer", "org_id": 1})
    r = client.post("/api/auth/forgot-password", json={"email": "reset.me@test.example"})
    assert r.status_code == 202
    mail = last_mail("reset.me@test.example")
    assert mail and "reset" in mail.subject.lower()
    token = re.search(r"token=([^\s&]+)", mail.links[0]).group(1)
    assert client.post("/api/auth/reset-password", json={"token": token, "new_password": "short"}).status_code == 422
    assert client.post("/api/auth/reset-password", json={"token": token, "new_password": "Brand-New-Pass-2"}).status_code == 204
    assert client.post("/api/auth/reset-password", json={"token": token, "new_password": "Another-Pass-3"}).status_code == 400
    assert client.post("/api/auth/login", data={"username": "reset.me@test.example", "password": "Brand-New-Pass-2"}).status_code == 200
    assert "changed" in last_mail("reset.me@test.example").subject


def test_forgot_password_does_not_reveal_accounts(client):
    before = len(mailer.outbox)
    a = client.post("/api/auth/forgot-password", json={"email": "nobody-here@test.example"})
    assert a.status_code == 202 and a.json()["status"] == "sent" and len(mailer.outbox) == before
    assert client.post("/api/auth/reset-password", json={"token": "garbage", "new_password": "Whatever-123"}).status_code == 400


def test_profile_update(client, ranger):
    r = client.patch("/api/auth/me", headers=ranger, json={"full_name": "Mohamed K. Conteh", "phone": "+232 30 555 000"})
    assert r.status_code == 200 and r.json()["full_name"] == "Mohamed K. Conteh" and r.json()["phone"] == "+232 30 555 000"
    assert client.patch("/api/auth/me", headers=ranger, json={"phone": "<b>"}).status_code == 422
    client.patch("/api/auth/me", headers=ranger, json={"full_name": "Mohamed Conteh"})


def test_signup_notifies_admins_and_approval_notifies_user(client, admin):
    email = f"new.{uuid.uuid4().hex[:6]}@example.org"
    client.post("/api/auth/signup", json={"full_name": "Aminata Sesay", "email": email, "password": "Forest-Watch-77",
                                          "organisation": "Gola Rangers", "requested_role": "field_monitor",
                                          "reason": "I patrol the Gola north sector every week.", "accept_terms": True})
    assert last_mail("admin@chimpwatch.example").subject == "New access request"
    u = next(x for x in client.get("/api/users?pending=true", headers=admin).json() if x["email"] == email)
    client.patch(f"/api/users/{u['id']}", headers=admin, json={"is_active": True, "org_id": 2, "role": "field_monitor"})
    m = last_mail(email)
    assert m.subject == "Your access has been approved" and "field monitor" in m.text


def test_high_alert_emails_go_to_analysts(client, analyst):
    client.put("/api/thresholds/habitat_pressure", headers=analyst, json={"medium": 5, "high": 10})
    # close existing habitat alerts so new ones are raised
    for a in client.get("/api/alerts?indicator=habitat_pressure&open_only=true", headers=analyst).json()["items"]:
        client.patch(f"/api/alerts/{a['id']}", headers=analyst, json={"status": "dismissed", "review_notes": "test reset"})
    before = len(mailer.outbox)
    client.post("/api/analytics/run", headers=analyst)
    new = mailer.outbox[before:]
    assert any(m.subject == "High-level alert" and "analyst@chimpwatch.example" in m.to for m in new)
    client.put("/api/thresholds/habitat_pressure", headers=analyst, json={"medium": 40, "high": 70})


def test_offline_survey_session_links_observations(client, ranger):
    s_uuid = str(uuid.uuid4())
    obs = {"client_uuid": str(uuid.uuid4()), "evidence_type": "nest", "count": 2, "survey_client_uuid": s_uuid,
           "observed_at": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(), "lat": 8.553, "lon": -11.69}
    # observation before its survey arrives is rejected and kept for retry
    r = client.post("/api/observations/sync", headers=ranger, json=[obs]).json()["results"][0]
    assert r["status"] == "error" and "survey" in r["detail"]
    survey = {"client_uuid": s_uuid, "area_id": 5, "method": "recce", "start_date": date.today().isoformat(),
              "end_date": date.today().isoformat(), "effort_km": 6.4, "team": "Team A"}
    assert client.post("/api/surveys", headers=ranger, json={**survey, "effort_km": None}).status_code == 422
    first = client.post("/api/surveys", headers=ranger, json=survey)
    again = client.post("/api/surveys", headers=ranger, json=survey)
    assert first.status_code == 201 and again.status_code == 200 and first.json()["id"] == again.json()["id"]
    r = client.post("/api/observations/sync", headers=ranger, json=[obs]).json()["results"][0]
    assert r["status"] == "created"
    mine = client.get("/api/surveys?mine=true", headers=ranger).json()
    assert mine[0]["client_uuid"] == s_uuid


def test_landscape_upload_and_edit(client, admin, analyst):
    fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": {
        "type": "Polygon", "coordinates": [[[-12.1, 8.1], [-12.0, 8.1], [-12.0, 8.2], [-12.1, 8.2], [-12.1, 8.1]]]}}]}
    body = {"name": "Test Community Forest", "designation": "Community forest", "district": "Moyamba", "boundary": fc}
    assert client.post("/api/areas", headers=analyst, json=body).status_code == 403
    r = client.post("/api/areas", headers=admin, json=body)
    assert r.status_code == 201 and 100 < r.json()["area_km2"] < 150
    r = client.patch(f"/api/areas/{r.json()['id']}", headers=admin, json={"description": "Pilot community forest"})
    assert r.status_code == 200 and r.json()["description"] == "Pilot community forest"
    bad = {**body, "name": "Broken", "boundary": {"type": "Point", "coordinates": [0, 0]}}
    assert client.post("/api/areas", headers=admin, json=bad).status_code == 422


def test_manage_cli_create_admin_and_reset(capsys):
    import sys
    from app import manage
    sys.argv = ["manage", "create-admin", "--email", "cli.admin@test.example", "--name", "CLI Admin", "--password", "Cli-Admin-Pass-1"]
    manage.main()
    sys.argv = ["manage", "reset-password", "--email", "cli.admin@test.example", "--password", "Cli-Admin-Pass-2"]
    manage.main()
    out = capsys.readouterr().out
    assert "Created administrator cli.admin@test.example" in out and "Password reset" in out


def test_cli_admin_can_sign_in(client):
    r = client.post("/api/auth/login", data={"username": "cli.admin@test.example", "password": "Cli-Admin-Pass-2"})
    assert r.status_code == 200 and r.json()["user"]["role"] == "admin"
