from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import Role, User

ALGORITHM = "HS256"
MAX_FAILED_LOGINS = 5
LOCKOUT_MINUTES = 15

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


def validate_password_strength(password: str) -> None:
    if len(password) < 10 or password.isalpha() or password.isdigit():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Password must be at least 10 characters and mix letters with numbers or symbols",
        )


def create_access_token(user: User) -> str:
    s = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "role": user.role.value,
        "org": user.org_id,
        "iat": now,
        "exp": now + timedelta(minutes=s.access_token_minutes),
    }
    return jwt.encode(payload, s.secret_key, algorithm=ALGORITHM)


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    creds_exc = HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired credentials",
                              headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(token, get_settings().secret_key, algorithms=[ALGORITHM])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise creds_exc
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise creds_exc
    return user


def require_roles(*roles: Role):
    allowed = set(roles) | {Role.admin}

    def checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role does not permit this action")
        return user

    return checker


can_submit = require_roles(Role.analyst, Role.field_monitor)
can_analyse = require_roles(Role.analyst)
admin_only = require_roles()
