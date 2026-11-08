"""Who gets told about what. All messages link back to the platform and never include site coordinates."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Alert, AlertLevel, Role, User
from . import mailer


def _url(path: str) -> str:
    return get_settings().public_url.rstrip("/") + path


def _emails(db: Session, *roles: Role) -> list[str]:
    return list(db.scalars(select(User.email).where(User.is_active.is_(True), User.role.in_(roles))))


def access_requested(db: Session, user: User, provider: str) -> None:
    detail = [f"{user.full_name} ({user.email}) has requested access using {provider}."]
    if user.requested_org:
        detail.append(f"Organisation: {user.requested_org}. Access requested: {(user.requested_role or 'viewer').replace('_', ' ')}.")
    if user.signup_note:
        detail.append(f"Reason given: {user.signup_note}")
    detail.append("They can't see any data until an administrator approves the request.")
    mailer.send(_emails(db, Role.admin), "New access request", detail, ("Review the request", _url("/admin")))


def approved(user: User) -> None:
    mailer.send(user.email, "Your access has been approved", [
        f"Hello {user.full_name},",
        f"An administrator has approved your CHIMP-WATCH AI account as {user.role.value.replace('_', ' ')}"
        + (f" with {user.org.name}." if user.org else "."),
        "You can now sign in with the same option you used to sign up.",
    ], ("Sign in", _url("/login")))


def declined(user: User) -> None:
    mailer.send(user.email, "Your access request", [
        f"Hello {user.full_name},",
        "Your request for access to CHIMP-WATCH AI was not approved. If you think this is a mistake, "
        "contact your organisation's CHIMP-WATCH administrator.",
    ])


def password_reset(user: User, token: str) -> None:
    mailer.send(user.email, "Reset your password", [
        f"Hello {user.full_name},",
        "We received a request to reset your password. The link below works once and expires in one hour.",
        "If you didn't ask for this, you can ignore this email; your password won't change.",
    ], ("Choose a new password", _url(f"/reset-password?token={token}")))


def password_changed(user: User) -> None:
    mailer.send(user.email, "Your password was changed", [
        f"Hello {user.full_name},",
        "The password for your CHIMP-WATCH AI account was just changed. If this wasn't you, reset it "
        "immediately and contact your administrator.",
    ], ("Sign in", _url("/login")))


def high_alerts(db: Session, alerts: list[Alert]) -> None:
    high = [a for a in alerts if a.level == AlertLevel.high]
    if not high:
        return
    lines = [f"{len(high)} high-level alert{'s' if len(high) > 1 else ''} raised or escalated:"]
    for a in high[:10]:
        basis = "modelled risk estimate" if a.basis == "modelled" else "observed change"
        lines.append(f"• {a.title.replace('High: ', '')} ({basis}, {a.confidence or 'unknown'} confidence)")
    lines.append("High alerts need specialist review and, where appropriate, field verification.")
    target = f"/alerts?id={high[0].id}" if len(high) == 1 else "/alerts"
    mailer.send(_emails(db, Role.admin, Role.analyst), "High-level alert", lines, ("Review alerts", _url(target)))
