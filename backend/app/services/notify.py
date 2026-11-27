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
    inapp(db, role_ids(db, Role.admin), "access", f"Access request from {user.full_name}", user.requested_org or user.email, "/admin")
    db.commit()


def approved(user: User, db: Session | None = None) -> None:
    if db is not None:
        inapp(db, [user.id], "access", "Your access was approved", f"Role: {user.role.value.replace('_', ' ')}", "/")
        db.commit()
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
    inapp(db, role_ids(db, Role.admin, Role.analyst), "alert", lines[0].rstrip(":"),
          "; ".join(a.title.replace("High: ", "") for a in high[:3]), target)
    db.commit()
    mailer.send(_emails(db, Role.admin, Role.analyst), "High-level alert", lines, ("Review alerts", _url(target)))


# ============================================================================ in-app notifications
from ..models import Notification  # noqa: E402


def inapp(db: Session, user_ids, kind: str, title: str, body: str | None = None, link: str | None = None) -> int:
    """Add a bell notification for each user. Caller commits."""
    ids = {int(u) for u in user_ids if u}
    for uid in ids:
        db.add(Notification(user_id=uid, kind=kind, title=title[:250], body=body, link=link))
    return len(ids)


def role_ids(db: Session, *roles: Role) -> list[int]:
    return list(db.scalars(select(User.id).where(User.is_active.is_(True), User.role.in_(roles))))


def task_assigned(db: Session, task, assignee: User, by: User | None) -> None:
    link = "/tasks"
    inapp(db, [assignee.id], "task", f"New field task: {task.title}",
          f"Assigned by {by.full_name if by else 'an analyst'}" + (f", due {task.due_date:%d %b %Y}" if task.due_date else ""), link)
    mailer.send(assignee.email, "New field task assigned to you", [
        f"Hello {assignee.full_name},",
        f"You've been assigned: {task.title}." + (f" Due {task.due_date:%d %B %Y}." if task.due_date else ""),
        task.description or "",
    ], ("Open your tasks", _url(link)))


def conflict_reported(db: Session, incident) -> None:
    title = f"Conflict reported: {incident.kind.replace('_', ' ')} by {incident.species.replace('_', ' ')}"
    where = incident.community or (incident.area.name if incident.area else incident.district) or "unknown location"
    inapp(db, role_ids(db, Role.admin, Role.analyst), "conflict", title, f"{where} · {incident.occurred_at:%d %b %Y}", f"/conflict?id={incident.id}")


def conflict_assigned(db: Session, incident, assignee: User) -> None:
    inapp(db, [assignee.id], "conflict", "Conflict incident assigned to you",
          f"{incident.kind.replace('_', ' ')} · {incident.community or incident.district or ''}", f"/conflict?id={incident.id}")


def captures_to_review(db: Session, n: int, station_code: str) -> None:
    inapp(db, role_ids(db, Role.admin, Role.analyst), "camera", f"{n} camera-trap photo{'s' if n != 1 else ''} to review",
          f"Uploaded from station {station_code}", "/cameras?tab=review")


def forest_alerts_found(db: Session, events: int, pixels: int) -> None:
    if not events:
        return
    ids = role_ids(db, Role.admin, Role.analyst)
    inapp(db, ids, "forest", f"{events} new forest-disturbance hotspot{'s' if events != 1 else ''}",
          f"{pixels} satellite alert pixels grouped into pressure reports for review", "/observations?tab=pressures")
    mailer.send(_emails(db, Role.admin, Role.analyst), "New satellite forest alerts", [
        f"Global Forest Watch reported {pixels} forest-disturbance alert pixels inside monitored landscapes, grouped into {events} hotspot{'s' if events != 1 else ''}.",
        "They have been added as pressure reports awaiting verification.",
    ], ("Review pressure reports", _url("/observations?tab=pressures")))
