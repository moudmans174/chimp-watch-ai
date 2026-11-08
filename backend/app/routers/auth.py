import json

import jwt
import secrets as _secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..config import get_settings
from ..db import get_db
from ..models import Organisation, Role, User, UserIdentity
from ..ratelimit import limiter
from ..schemas import AdminUserOut, ForgotIn, PasswordChange, ProfileUpdate, ResetIn, SignupIn, Token, UserOut
from ..services import notify, oauth
from ..security import (
    LOCKOUT_MINUTES,
    MAX_FAILED_LOGINS,
    create_access_token,
    get_current_user,
    hash_password,
    validate_password_strength,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=Token)
def login(request: Request, form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(func.lower(User.email) == form.username.strip().lower()))
    now = datetime.now(timezone.utc)
    generic = HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect email or password")
    if not user:
        verify_password(form.password, "$2b$12$" + "x" * 53)  # equalise timing
        raise generic
    if user.pending_approval:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your account is awaiting approval by an administrator.")
    if user.locked_until and user.locked_until > now:
        raise HTTPException(status.HTTP_423_LOCKED, "Account temporarily locked after repeated failed sign-ins. Try again later.")
    if not user.is_active or not verify_password(form.password, user.hashed_password):
        user.failed_logins += 1
        if user.failed_logins >= MAX_FAILED_LOGINS:
            user.locked_until = now + timedelta(minutes=LOCKOUT_MINUTES)
            user.failed_logins = 0
            audit.record(db, user, "account_locked", "user", user.id, request=request)
        audit.record(db, user, "login_failed", "user", user.id, request=request)
        db.commit()
        raise generic
    user.failed_logins = 0
    user.locked_until = None
    user.last_login = now
    audit.record(db, user, "login", "user", user.id, request=request)
    db.commit()
    return Token(access_token=create_access_token(user), user=UserOut.model_validate(user))


@router.get("/me", response_model=AdminUserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.patch("/me", response_model=AdminUserOut)
def update_me(body: ProfileUpdate, request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    changes = body.model_dump(exclude_unset=True)
    if "full_name" in changes and changes["full_name"]:
        user.full_name = changes["full_name"].strip()
    if "phone" in changes:
        user.phone = (changes["phone"] or "").strip() or None
    audit.record(db, user, "profile_updated", "user", user.id, {k: ("***" if k == "phone" else v) for k, v in changes.items()}, request)
    db.commit()
    db.refresh(user)
    return user


@router.post("/change-password", status_code=204)
def change_password(body: PasswordChange, request: Request, user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    if not verify_password(body.current_password, user.hashed_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    validate_password_strength(body.new_password)
    user.hashed_password = hash_password(body.new_password)
    audit.record(db, user, "password_changed", "user", user.id, request=request)
    db.commit()
    notify.password_changed(user)


# ============================================================================ social sign-in
COOKIE = "cw_oauth"


def oauth_name(p: str) -> str:
    return {"google": "Google", "apple": "Apple", "github": "GitHub"}.get(p, p)


@router.get("/providers")
def providers():
    """Which social sign-in options this server has credentials for."""
    return {p: oauth.enabled(p) for p in oauth.PROVIDERS}


def _front(path: str, **params) -> RedirectResponse:
    base = get_settings().public_url.rstrip("/")
    frag = params.pop("_fragment", None)
    url = f"{base}{path}" + (f"?{urlencode(params)}" if params else "") + (f"#{frag}" if frag else "")
    r = RedirectResponse(url, status_code=303)
    r.delete_cookie(COOKIE, path="/api/auth/oauth")
    return r


@router.get("/oauth/{provider}/start")
def oauth_start(provider: str, mode: str = "signin"):
    if provider not in oauth.PROVIDERS:
        raise HTTPException(404, "Unknown sign-in provider")
    if mode not in ("signin", "signup"):
        raise HTTPException(422, "mode must be signin or signup")
    if not oauth.enabled(provider):
        return _front("/signup" if mode == "signup" else "/login", error="not_configured", provider=provider)
    flow = oauth.new_flow(provider, mode)
    r = RedirectResponse(oauth.authorize_url(flow), status_code=302)
    secure = get_settings().public_url.startswith("https") or provider == "apple"
    # Apple returns with a cross-site POST, which only carries SameSite=None (and therefore Secure) cookies.
    r.set_cookie(COOKIE, oauth.seal(flow), max_age=oauth.STATE_TTL, httponly=True, path="/api/auth/oauth",
                 secure=secure, samesite="none" if provider == "apple" else "lax")
    return r


def _signup_org(db: Session) -> Organisation:
    name = get_settings().signup_org_name
    org = db.scalar(select(Organisation).where(Organisation.name == name))
    if not org:
        org = Organisation(name=name, kind="pending")
        db.add(org)
        db.flush()
    return org


def _complete(db: Session, request: Request, flow: dict, profile: oauth.Profile) -> RedirectResponse:
    now = datetime.now(timezone.utc)
    ident = db.scalar(select(UserIdentity).where(UserIdentity.provider == profile.provider,
                                                 UserIdentity.subject == profile.subject))
    user = ident.user if ident else None
    created = False

    if user is None and profile.email and profile.email_verified:
        user = db.scalar(select(User).where(func.lower(User.email) == profile.email.lower()))
        if user is not None:
            db.add(UserIdentity(user_id=user.id, provider=profile.provider, subject=profile.subject, email=profile.email))
            audit.record(db, user, "identity_linked", "user", user.id, {"provider": profile.provider}, request)

    if user is None:
        if not (profile.email and profile.email_verified):
            db.commit()
            return _front("/signup" if flow["m"] == "signup" else "/login", error="email_required", provider=profile.provider)
        if flow["m"] != "signup":
            db.commit()
            return _front("/login", error="no_account", provider=profile.provider)
        org = _signup_org(db)
        user = User(email=profile.email.lower(), full_name=(profile.name or profile.email.split("@")[0])[:200],
                    hashed_password="!", role=Role.viewer, org_id=org.id, can_view_sensitive=False,
                    is_active=False, pending_approval=True)
        db.add(user)
        db.flush()
        db.add(UserIdentity(user_id=user.id, provider=profile.provider, subject=profile.subject, email=profile.email))
        audit.record(db, user, "signup_requested", "user", user.id, {"provider": profile.provider, "email": user.email}, request)
        created = True
        notify.access_requested(db, user, oauth_name(profile.provider))

    if ident:
        ident.last_used_at = now
    if user.pending_approval:
        db.commit()
        return _front("/auth/callback", _fragment=f"status={'created' if created else 'pending'}&email={quote(user.email)}")
    if not user.is_active:
        db.commit()
        return _front("/login", error="disabled")
    user.last_login = now
    user.failed_logins = 0
    audit.record(db, user, "login", "user", user.id, {"provider": profile.provider}, request)
    db.commit()
    return _front("/auth/callback", _fragment=f"token={create_access_token(user)}")


def _callback(provider: str, request: Request, db: Session, params: dict) -> RedirectResponse:
    mode_guess = "signin"
    try:
        flow = oauth.unseal(request.cookies.get(COOKIE))
        mode_guess = flow.get("m", "signin")
        if flow.get("p") != provider or not params.get("state") or not _secrets.compare_digest(str(params["state"]), flow["s"]):
            raise oauth.OAuthError("state_mismatch", "State does not match this sign-in attempt")
        if params.get("error"):
            raise oauth.OAuthError("cancelled", str(params["error"]))
        if not params.get("code"):
            raise oauth.OAuthError("provider_error", "No authorisation code returned")
        apple_user = None
        if params.get("user"):
            try:
                apple_user = json.loads(params["user"])
            except ValueError:
                apple_user = None
        profile = oauth.exchange(flow, str(params["code"]), apple_user)
        return _complete(db, request, flow, profile)
    except oauth.OAuthError as exc:
        audit.record(db, None, "oauth_failed", "auth", None, {"provider": provider, "code": exc.code, "detail": str(exc)}, request)
        db.commit()
        return _front("/signup" if mode_guess == "signup" else "/login", error=exc.code, provider=provider)
    except Exception as exc:  # network failures and unexpected provider responses
        audit.record(db, None, "oauth_failed", "auth", None, {"provider": provider, "code": "provider_error",
                                                             "detail": type(exc).__name__}, request)
        db.commit()
        return _front("/signup" if mode_guess == "signup" else "/login", error="provider_error", provider=provider)


@router.get("/oauth/{provider}/callback")
def oauth_callback_get(provider: str, request: Request, db: Session = Depends(get_db)):
    if provider not in oauth.PROVIDERS:
        raise HTTPException(404, "Unknown sign-in provider")
    return _callback(provider, request, db, dict(request.query_params))


@router.post("/oauth/{provider}/callback")
async def oauth_callback_post(provider: str, request: Request, db: Session = Depends(get_db)):
    """Apple uses response_mode=form_post."""
    if provider not in oauth.PROVIDERS:
        raise HTTPException(404, "Unknown sign-in provider")
    form = await request.form()
    params = {k: v for k, v in form.items() if isinstance(v, str)}
    return await run_in_threadpool(_callback, provider, request, db, params)


# ============================================================================ email sign-up
SIGNUP_ACK = {"status": "pending",
              "message": "Request received. An administrator will review it before you can sign in."}


@router.post("/signup", status_code=202)
def signup(body: SignupIn, request: Request, db: Session = Depends(get_db)):
    """Self-service sign-up. Creates a pending account with no data access until an admin approves it.

    The response is identical whether or not the email is already registered, so the endpoint
    cannot be used to discover who has an account.
    """
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
    if not limiter.allow(f"signup:{ip}", 5, 3600):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many sign-up attempts from this network. Try again later.")
    validate_password_strength(body.password)
    email = body.email.lower()
    existing = db.scalar(select(User).where(func.lower(User.email) == email))
    if existing:
        audit.record(db, existing, "signup_duplicate", "user", existing.id, {"email": email}, request)
        db.commit()
        return SIGNUP_ACK
    org = _signup_org(db)
    u = User(email=email, full_name=body.full_name, hashed_password=hash_password(body.password), role=Role.viewer,
             org_id=org.id, can_view_sensitive=False, is_active=False, pending_approval=True,
             phone=(body.phone or "").strip() or None, requested_org=body.organisation,
             requested_role=body.requested_role.value, signup_note=body.reason)
    db.add(u)
    db.flush()
    audit.record(db, u, "signup_requested", "user", u.id, {"provider": "email", "email": email,
                                                           "requested_role": body.requested_role.value,
                                                           "requested_org": body.organisation}, request)
    db.commit()
    notify.access_requested(db, u, "email")
    return SIGNUP_ACK


# ============================================================================ password reset
import hashlib  # noqa: E402

RESET_TTL_MIN = 60
FORGOT_ACK = {"status": "sent", "message": "If an active account uses that email, we've sent a link to reset the password."}


def _fingerprint(user: User) -> str:
    # Changes whenever the password changes, so a reset link works only once.
    return hashlib.sha256(f"{user.id}:{user.hashed_password}".encode()).hexdigest()[:24]


def make_reset_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": str(user.id), "purpose": "reset", "fp": _fingerprint(user), "iat": now,
                       "exp": now + timedelta(minutes=RESET_TTL_MIN)}, get_settings().secret_key, algorithm="HS256")


@router.post("/forgot-password", status_code=202)
def forgot_password(body: ForgotIn, request: Request, db: Session = Depends(get_db)):
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
    if not limiter.allow(f"forgot:{ip}", 5, 3600):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many reset requests from this network. Try again later.")
    user = db.scalar(select(User).where(func.lower(User.email) == body.email.lower()))
    if user and user.is_active and not user.pending_approval:
        notify.password_reset(user, make_reset_token(user))
        audit.record(db, user, "password_reset_requested", "user", user.id, request=request)
        db.commit()
    return FORGOT_ACK


@router.post("/reset-password", status_code=204)
def reset_password(body: ResetIn, request: Request, db: Session = Depends(get_db)):
    bad = HTTPException(status.HTTP_400_BAD_REQUEST, "This reset link is invalid or has expired. Request a new one.")
    try:
        claims = jwt.decode(body.token, get_settings().secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise bad
    if claims.get("purpose") != "reset":
        raise bad
    user = db.get(User, int(claims.get("sub", 0)))
    if not user or not user.is_active or claims.get("fp") != _fingerprint(user):
        raise bad
    validate_password_strength(body.new_password)
    user.hashed_password = hash_password(body.new_password)
    user.failed_logins = 0
    user.locked_until = None
    audit.record(db, user, "password_reset", "user", user.id, request=request)
    db.commit()
    notify.password_changed(user)
