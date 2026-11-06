"""Social sign-in tests. Provider HTTP endpoints are mocked; the full redirect/state/cookie flow is real."""
import time
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.services import oauth

FAKE_KEY = "test-signing-key-that-is-long-enough-for-hs256"


def id_token(iss, aud, sub, email, verified=True, nonce=None, name=None, exp_in=600):
    claims = {"iss": iss, "aud": aud, "sub": sub, "email": email, "email_verified": verified,
              "exp": int(time.time()) + exp_in, "iat": int(time.time())}
    if nonce:
        claims["nonce"] = nonce
    if name:
        claims["name"] = name
    return jwt.encode(claims, FAKE_KEY, algorithm="HS256")


@pytest.fixture()
def providers(monkeypatch):
    s = get_settings()
    key = ec.generate_private_key(ec.SECP256R1()).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    for k, v in {"google_client_id": "g-id", "google_client_secret": "g-secret", "github_client_id": "gh-id",
                 "github_client_secret": "gh-secret", "apple_client_id": "org.example.web", "apple_team_id": "TEAM123",
                 "apple_key_id": "KEY123", "apple_private_key": key, "public_url": "http://localhost:8080"}.items():
        monkeypatch.setattr(s, k, v)
    return s


class Mock:
    """Programmable provider: set .profile per test."""

    def __init__(self):
        self.profile = {}
        self.seen = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        p = self.profile
        host = request.url.host
        if host == "oauth2.googleapis.com":
            body = parse_qs(request.content.decode())
            assert body["code_verifier"][0] and body["client_secret"] == ["g-secret"]
            return httpx.Response(200, json={"id_token": id_token("https://accounts.google.com", "g-id", p["sub"], p["email"],
                                                                  p.get("verified", True), p.get("nonce"), p.get("name"))})
        if host == "github.com":
            return httpx.Response(200, json={"access_token": "gh-token"})
        if host == "api.github.com" and request.url.path == "/user":
            return httpx.Response(200, json={"id": p["sub"], "login": "octo", "name": p.get("name")})
        if host == "api.github.com" and request.url.path == "/user/emails":
            return httpx.Response(200, json=p["emails"])
        if host == "appleid.apple.com":
            body = parse_qs(request.content.decode())
            secret = jwt.decode(body["client_secret"][0], options={"verify_signature": False})
            assert secret["iss"] == "TEAM123" and secret["sub"] == "org.example.web"
            return httpx.Response(200, json={"id_token": id_token("https://appleid.apple.com", p.get("aud", "org.example.web"),
                                                                  p["sub"], p["email"], "true", p.get("nonce"))})
        return httpx.Response(404)


@pytest.fixture()
def mock(monkeypatch):
    m = Mock()
    monkeypatch.setattr(oauth, "_client", lambda: httpx.Client(transport=httpx.MockTransport(m)))
    return m


def start(c: TestClient, provider: str, mode: str):
    r = c.get(f"/api/auth/oauth/{provider}/start?mode={mode}", follow_redirects=False)
    assert r.status_code == 302, r.text
    q = parse_qs(urlparse(r.headers["location"]).query)
    flow = oauth.unseal(c.cookies.get("cw_oauth"))
    return q, flow


def fragment(r):
    loc = urlparse(r.headers["location"])
    return loc.path, parse_qs(loc.query), parse_qs(loc.fragment)


def test_providers_report_and_unconfigured_redirect(client):
    assert client.get("/api/auth/providers").json() == {"google": False, "apple": False, "github": False}
    r = client.get("/api/auth/oauth/google/start?mode=signup", follow_redirects=False)
    path, q, _ = fragment(r)
    assert path == "/signup" and q["error"] == ["not_configured"]


def test_google_signup_requires_admin_approval(providers, mock, admin):
    c = TestClient(app)
    q, flow = start(c, "google", "signup")
    assert q["code_challenge_method"] == ["S256"] and q["redirect_uri"] == ["http://localhost:8080/api/auth/oauth/google/callback"]
    mock.profile = {"sub": "g-1001", "email": "New.Person@gmail.com", "name": "New Person", "nonce": flow["n"]}
    r = c.get(f"/api/auth/oauth/google/callback?state={q['state'][0]}&code=abc", follow_redirects=False)
    path, _, frag = fragment(r)
    assert path == "/auth/callback" and frag["status"] == ["created"] and "token" not in frag

    users = c.get("/api/users?pending=true", headers=admin).json()
    u = next(x for x in users if x["email"] == "new.person@gmail.com")
    assert u["pending_approval"] and not u["is_active"] and u["providers"] == ["google"] and u["role"] == "viewer"
    assert not u["can_view_sensitive"]

    # cannot be approved until assigned to a real organisation
    assert c.patch(f"/api/users/{u['id']}", headers=admin, json={"is_active": True}).status_code == 422
    r = c.patch(f"/api/users/{u['id']}", headers=admin, json={"is_active": True, "org_id": 2, "role": "field_monitor"})
    assert r.status_code == 200 and not r.json()["pending_approval"]

    q, flow = start(c, "google", "signin")
    mock.profile["nonce"] = flow["n"]
    r = c.get(f"/api/auth/oauth/google/callback?state={q['state'][0]}&code=abc", follow_redirects=False)
    tok = fragment(r)[2]["token"][0]
    me = c.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"}).json()
    assert me["email"] == "new.person@gmail.com" and me["role"] == "field_monitor"


def test_pending_user_sees_pending_again_and_cannot_use_password(providers, mock):
    c = TestClient(app)
    q, flow = start(c, "google", "signup")
    mock.profile = {"sub": "g-2002", "email": "waiting@gmail.com", "nonce": flow["n"]}
    c.get(f"/api/auth/oauth/google/callback?state={q['state'][0]}&code=x", follow_redirects=False)
    q, flow = start(c, "google", "signin")
    mock.profile["nonce"] = flow["n"]
    r = c.get(f"/api/auth/oauth/google/callback?state={q['state'][0]}&code=x", follow_redirects=False)
    assert fragment(r)[2]["status"] == ["pending"]
    r = c.post("/api/auth/login", data={"username": "waiting@gmail.com", "password": "anything"})
    assert r.status_code == 403 and "approval" in r.json()["detail"]


def test_signin_without_account_points_to_signup(providers, mock):
    c = TestClient(app)
    q, flow = start(c, "google", "signin")
    mock.profile = {"sub": "g-3003", "email": "stranger@gmail.com", "nonce": flow["n"]}
    r = c.get(f"/api/auth/oauth/google/callback?state={q['state'][0]}&code=x", follow_redirects=False)
    path, qs, _ = fragment(r)
    assert path == "/login" and qs["error"] == ["no_account"]


def test_verified_email_links_existing_account_unverified_does_not(providers, mock):
    c = TestClient(app)
    q, flow = start(c, "google", "signin")
    mock.profile = {"sub": "g-4004", "email": "viewer@chimpwatch.example", "verified": False, "nonce": flow["n"]}
    r = c.get(f"/api/auth/oauth/google/callback?state={q['state'][0]}&code=x", follow_redirects=False)
    assert fragment(r)[1]["error"] == ["email_required"]
    q, flow = start(c, "google", "signin")
    mock.profile = {"sub": "g-4004", "email": "viewer@chimpwatch.example", "verified": True, "nonce": flow["n"]}
    r = c.get(f"/api/auth/oauth/google/callback?state={q['state'][0]}&code=x", follow_redirects=False)
    assert "token" in fragment(r)[2]


def test_state_and_cookie_are_enforced(providers, mock):
    c = TestClient(app)
    start(c, "google", "signin")
    r = c.get("/api/auth/oauth/google/callback?state=forged&code=x", follow_redirects=False)
    assert fragment(r)[1]["error"] == ["state_mismatch"]
    fresh = TestClient(app)  # no cookie, e.g. a link opened in another browser
    r = fresh.get("/api/auth/oauth/google/callback?state=any&code=x", follow_redirects=False)
    assert fragment(r)[1]["error"] == ["session_expired"]
    assert not mock.seen  # no token exchange attempted


def test_user_cancel_at_provider(providers, mock):
    c = TestClient(app)
    q, _ = start(c, "github", "signup")
    r = c.get(f"/api/auth/oauth/github/callback?state={q['state'][0]}&error=access_denied", follow_redirects=False)
    path, qs, _ = fragment(r)
    assert path == "/signup" and qs["error"] == ["cancelled"]


def test_github_signup_uses_verified_primary_email(providers, mock):
    c = TestClient(app)
    q, _ = start(c, "github", "signup")
    assert "user:email" in q["scope"][0]
    mock.profile = {"sub": 777, "name": "Octo Cat", "emails": [
        {"email": "old@unverified.example", "primary": False, "verified": False},
        {"email": "octo@github-user.example", "primary": True, "verified": True}]}
    r = c.get(f"/api/auth/oauth/github/callback?state={q['state'][0]}&code=x", follow_redirects=False)
    assert fragment(r)[2]["email"] == ["octo@github-user.example"]


def test_apple_form_post_signup_and_audience_check(providers, mock):
    c = TestClient(app, base_url="https://testserver")  # Apple's cookie is Secure + SameSite=None
    q, flow = start(c, "apple", "signup")
    assert q["response_mode"] == ["form_post"]
    mock.profile = {"sub": "001234.apple", "email": "abc123@privaterelay.appleid.com", "nonce": flow["n"]}
    r = c.post("/api/auth/oauth/apple/callback", follow_redirects=False,
               data={"state": q["state"][0], "code": "x", "user": '{"name":{"firstName":"Ada","lastName":"Lovelace"}}'})
    assert fragment(r)[2]["status"] == ["created"]

    q, flow = start(c, "apple", "signup")
    mock.profile = {"sub": "009999.apple", "email": "x@privaterelay.appleid.com", "nonce": flow["n"], "aud": "someone.else"}
    r = c.post("/api/auth/oauth/apple/callback", follow_redirects=False, data={"state": q["state"][0], "code": "x"})
    assert fragment(r)[1]["error"] == ["provider_error"]


def test_audit_records_signup(admin, client):
    log = client.get("/api/audit?action=signup_requested", headers=admin).json()
    assert log


def test_admin_can_reject_pending_signup(providers, mock, admin):
    c = TestClient(app)
    q, flow = start(c, "google", "signup")
    mock.profile = {"sub": "g-5005", "email": "reject.me@gmail.com", "nonce": flow["n"]}
    c.get(f"/api/auth/oauth/google/callback?state={q['state'][0]}&code=x", follow_redirects=False)
    u = next(x for x in c.get("/api/users?pending=true", headers=admin).json() if x["email"] == "reject.me@gmail.com")
    r = c.patch(f"/api/users/{u['id']}", headers=admin, json={"is_active": False})
    assert r.status_code == 200 and not r.json()["pending_approval"] and not r.json()["is_active"]
    q, flow = start(c, "google", "signin")
    mock.profile["nonce"] = flow["n"]
    r = c.get(f"/api/auth/oauth/google/callback?state={q['state'][0]}&code=x", follow_redirects=False)
    assert fragment(r)[1]["error"] == ["disabled"]
