"""Social sign-in: Google (OIDC), Apple (Sign in with Apple) and GitHub (OAuth 2.0).

Flow (authorization code):
1. /api/auth/oauth/{provider}/start  -> sets a short-lived signed cookie holding the state, nonce and
   PKCE verifier, then redirects the browser to the provider.
2. Provider redirects back to /api/auth/oauth/{provider}/callback (Apple POSTs a form).
3. The callback checks the state against the cookie, exchanges the code server-to-server over TLS,
   reads a *verified* email and the provider's stable subject id, and resolves a local account.

Only verified email addresses are trusted for account linking.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
import jwt

from ..config import get_settings

PROVIDERS = ("google", "apple", "github")
STATE_TTL = 600


class OAuthError(Exception):
    """Carries a short machine code the frontend turns into a readable message."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(detail or code)
        self.code = code


@dataclass
class Profile:
    provider: str
    subject: str
    email: str | None
    email_verified: bool
    name: str | None


def enabled(provider: str) -> bool:
    s = get_settings()
    if provider == "google":
        return bool(s.google_client_id and s.google_client_secret)
    if provider == "github":
        return bool(s.github_client_id and s.github_client_secret)
    if provider == "apple":
        return bool(s.apple_client_id and s.apple_team_id and s.apple_key_id and s.apple_private_key)
    return False


def callback_url(provider: str) -> str:
    return f"{get_settings().public_url.rstrip('/')}/api/auth/oauth/{provider}/callback"


def _client() -> httpx.Client:
    """Factory so tests can substitute a mock transport."""
    return httpx.Client(timeout=15, headers={"User-Agent": "chimpwatch-ai"})


# --------------------------------------------------------------------------- state
def new_flow(provider: str, mode: str) -> dict:
    verifier = secrets.token_urlsafe(48)
    return {"p": provider, "m": mode, "s": secrets.token_urlsafe(24), "n": secrets.token_urlsafe(24),
            "v": verifier, "exp": int(time.time()) + STATE_TTL}


def seal(flow: dict) -> str:
    return jwt.encode(flow, get_settings().secret_key, algorithm="HS256")


def unseal(token: str | None) -> dict:
    if not token:
        raise OAuthError("session_expired", "Sign-in cookie missing")
    try:
        return jwt.decode(token, get_settings().secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise OAuthError("session_expired", "Sign-in cookie invalid or expired")


def _challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


# --------------------------------------------------------------------------- authorize
def authorize_url(flow: dict) -> str:
    s = get_settings()
    p = flow["p"]
    if p == "google":
        q = {"client_id": s.google_client_id, "redirect_uri": callback_url(p), "response_type": "code",
             "scope": "openid email profile", "state": flow["s"], "nonce": flow["n"],
             "code_challenge": _challenge(flow["v"]), "code_challenge_method": "S256", "prompt": "select_account"}
        return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(q)
    if p == "github":
        q = {"client_id": s.github_client_id, "redirect_uri": callback_url(p), "scope": "read:user user:email",
             "state": flow["s"], "code_challenge": _challenge(flow["v"]), "code_challenge_method": "S256",
             "allow_signup": "true"}
        return "https://github.com/login/oauth/authorize?" + urlencode(q)
    if p == "apple":
        q = {"client_id": s.apple_client_id, "redirect_uri": callback_url(p), "response_type": "code",
             "response_mode": "form_post", "scope": "name email", "state": flow["s"], "nonce": flow["n"]}
        return "https://appleid.apple.com/auth/authorize?" + urlencode(q)
    raise OAuthError("unknown_provider")


# --------------------------------------------------------------------------- exchange
def apple_client_secret() -> str:
    s = get_settings()
    now = int(time.time())
    key = (s.apple_private_key or "").replace("\\n", "\n")
    return jwt.encode({"iss": s.apple_team_id, "iat": now, "exp": now + 3600, "aud": "https://appleid.apple.com",
                       "sub": s.apple_client_id}, key, algorithm="ES256", headers={"kid": s.apple_key_id})


def _check_id_token(id_token: str, issuer: tuple[str, ...], audience: str, nonce: str) -> dict:
    # The ID token arrives directly from the provider's token endpoint over TLS, which OIDC Core
    # §3.1.3.7 accepts in place of signature validation. Claims are still checked.
    try:
        claims = jwt.decode(id_token, options={"verify_signature": False})
    except jwt.PyJWTError:
        raise OAuthError("provider_error", "Malformed ID token")
    aud = claims.get("aud")
    if claims.get("iss") not in issuer or (aud != audience and audience not in (aud or [])):
        raise OAuthError("provider_error", "ID token issuer or audience mismatch")
    if int(claims.get("exp", 0)) < time.time():
        raise OAuthError("provider_error", "ID token expired")
    if claims.get("nonce") and claims["nonce"] != nonce:
        raise OAuthError("provider_error", "ID token nonce mismatch")
    return claims


def _truthy(v) -> bool:
    return v is True or str(v).lower() == "true"


def exchange(flow: dict, code: str, apple_user: dict | None = None) -> Profile:
    s = get_settings()
    p = flow["p"]
    with _client() as c:
        if p == "google":
            r = c.post("https://oauth2.googleapis.com/token", data={
                "code": code, "client_id": s.google_client_id, "client_secret": s.google_client_secret,
                "redirect_uri": callback_url(p), "grant_type": "authorization_code", "code_verifier": flow["v"]})
            if r.status_code != 200:
                raise OAuthError("provider_error", f"Google token exchange failed ({r.status_code})")
            claims = _check_id_token(r.json().get("id_token", ""), ("https://accounts.google.com", "accounts.google.com"),
                                     s.google_client_id, flow["n"])
            return Profile("google", str(claims["sub"]), claims.get("email"), _truthy(claims.get("email_verified")),
                           claims.get("name"))

        if p == "github":
            r = c.post("https://github.com/login/oauth/access_token", headers={"Accept": "application/json"}, data={
                "code": code, "client_id": s.github_client_id, "client_secret": s.github_client_secret,
                "redirect_uri": callback_url(p), "code_verifier": flow["v"]})
            tok = r.json().get("access_token") if r.status_code == 200 else None
            if not tok:
                raise OAuthError("provider_error", "GitHub token exchange failed")
            h = {"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json"}
            u = c.get("https://api.github.com/user", headers=h).json()
            emails = c.get("https://api.github.com/user/emails", headers=h).json()
            primary = next((e for e in emails if e.get("primary") and e.get("verified")), None) \
                or next((e for e in emails if e.get("verified")), None)
            return Profile("github", str(u["id"]), primary["email"] if primary else None, bool(primary),
                           u.get("name") or u.get("login"))

        if p == "apple":
            r = c.post("https://appleid.apple.com/auth/token", data={
                "code": code, "client_id": s.apple_client_id, "client_secret": apple_client_secret(),
                "redirect_uri": callback_url(p), "grant_type": "authorization_code"})
            if r.status_code != 200:
                raise OAuthError("provider_error", f"Apple token exchange failed ({r.status_code})")
            claims = _check_id_token(r.json().get("id_token", ""), ("https://appleid.apple.com",), s.apple_client_id, flow["n"])
            name = None
            if apple_user and isinstance(apple_user.get("name"), dict):  # only sent on first authorisation
                n = apple_user["name"]
                name = " ".join(x for x in (n.get("firstName"), n.get("lastName")) if x) or None
            return Profile("apple", str(claims["sub"]), claims.get("email"), _truthy(claims.get("email_verified")), name)
    raise OAuthError("unknown_provider")
