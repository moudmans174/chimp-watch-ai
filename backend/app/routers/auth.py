from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..db import get_db
from ..models import User
from ..schemas import PasswordChange, Token, UserOut
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


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
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
