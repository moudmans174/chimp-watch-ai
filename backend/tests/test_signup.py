"""Email self sign-up with personal details."""
import uuid

from app.ratelimit import limiter


def payload(**kw):
    p = {"full_name": "Isatu Kanu", "email": f"isatu.{uuid.uuid4().hex[:6]}@example.org", "password": "Forest-Watch-77",
         "organisation": "Tacugama Field Team", "requested_role": "field_monitor", "phone": "+232 76 123456",
         "reason": "I lead nest surveys in the Western Area Peninsula and need to submit records.", "accept_terms": True}
    p.update(kw)
    return p


def test_signup_creates_pending_account_with_details(client, admin, viewer):
    body = payload()
    r = client.post("/api/auth/signup", json=body)
    assert r.status_code == 202 and r.json()["status"] == "pending"
    # cannot sign in yet
    r = client.post("/api/auth/login", data={"username": body["email"], "password": body["password"]})
    assert r.status_code == 403 and "approval" in r.json()["detail"]
    u = next(x for x in client.get("/api/users?pending=true", headers=admin).json() if x["email"] == body["email"])
    assert u["requested_org"] == "Tacugama Field Team" and u["requested_role"] == "field_monitor"
    assert u["phone"] == "+232 76 123456" and "nest surveys" in u["signup_note"]
    assert u["role"] == "viewer" and not u["can_view_sensitive"] and not u["is_active"]
    # personal details are admin-only
    others = client.get("/api/users", headers=viewer).json()
    assert all("phone" not in x for x in others) and all(x["email"] != body["email"] for x in others)
    # approve, then the password works
    r = client.patch(f"/api/users/{u['id']}", headers=admin, json={"is_active": True, "org_id": 2, "role": "field_monitor"})
    assert r.status_code == 200
    r = client.post("/api/auth/login", data={"username": body["email"], "password": body["password"]})
    assert r.status_code == 200 and r.json()["user"]["role"] == "field_monitor"


def test_duplicate_email_gets_same_response_and_changes_nothing(client):
    r = client.post("/api/auth/signup", json=payload(email="viewer@chimpwatch.example", password="Different-Pass-99"))
    assert r.status_code == 202 and r.json()["status"] == "pending"
    r = client.post("/api/auth/login", data={"username": "viewer@chimpwatch.example", "password": "ChimpWatch!2026"})
    assert r.status_code == 200


def test_validation_rules(client):
    assert client.post("/api/auth/signup", json=payload(password="short")).status_code == 422
    assert client.post("/api/auth/signup", json=payload(accept_terms=False)).status_code == 422
    assert client.post("/api/auth/signup", json=payload(requested_role="admin")).status_code == 422
    assert client.post("/api/auth/signup", json=payload(reason="pls")).status_code == 422
    assert client.post("/api/auth/signup", json=payload(email="not-an-email")).status_code == 422
    assert client.post("/api/auth/signup", json=payload(phone="<script>")).status_code == 422


def test_signup_rate_limited(client):
    limiter.reset()
    codes = [client.post("/api/auth/signup", json=payload()).status_code for _ in range(6)]
    assert codes[:5] == [202] * 5 and codes[5] == 429
    limiter.reset()
