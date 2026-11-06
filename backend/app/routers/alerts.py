from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from .. import audit
from ..db import get_db
from ..models import Alert, AlertLevel, AlertStatus, FieldTask, Role, TaskStatus, User
from ..schemas import AlertOut, AlertUpdate, TaskIn, TaskOut, TaskUpdate
from ..security import can_analyse, get_current_user

router = APIRouter(prefix="/api", tags=["alerts & tasks"])

TRANSITIONS = {
    AlertStatus.new: {AlertStatus.acknowledged, AlertStatus.verifying, AlertStatus.dismissed},
    AlertStatus.acknowledged: {AlertStatus.verifying, AlertStatus.verified, AlertStatus.dismissed},
    AlertStatus.verifying: {AlertStatus.verified, AlertStatus.dismissed},
    AlertStatus.verified: {AlertStatus.resolved},
    AlertStatus.dismissed: {AlertStatus.new},
    AlertStatus.resolved: set(),
}
REVIEW_STATES = {AlertStatus.verified, AlertStatus.dismissed, AlertStatus.resolved}


def _alert_out(a: Alert) -> AlertOut:
    out = AlertOut.model_validate(a)
    out.area_name = a.area.name if a.area else None
    return out


@router.get("/alerts")
def list_alerts(status: list[AlertStatus] | None = Query(None), level: AlertLevel | None = None,
                area_id: int | None = None, indicator: str | None = None, open_only: bool = False,
                limit: int = Query(100, le=500), offset: int = 0,
                db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    q = select(Alert)
    if open_only:
        q = q.where(Alert.status.in_([AlertStatus.new, AlertStatus.acknowledged, AlertStatus.verifying]))
    if status:
        q = q.where(Alert.status.in_(status))
    if level:
        q = q.where(Alert.level == level)
    if area_id:
        q = q.where(Alert.area_id == area_id)
    if indicator:
        q = q.where(Alert.indicator == indicator)
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rank = case((Alert.level == AlertLevel.high, 0), (Alert.level == AlertLevel.medium, 1), else_=2)
    rows = db.scalars(q.order_by(rank, Alert.created_at.desc()).limit(limit).offset(offset)).all()
    return {"total": total, "items": [_alert_out(a) for a in rows]}


@router.get("/alerts/{alert_id}", response_model=AlertOut)
def get_alert(alert_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    a = db.get(Alert, alert_id)
    if not a:
        raise HTTPException(404, "Alert not found")
    return _alert_out(a)


@router.patch("/alerts/{alert_id}", response_model=AlertOut)
def update_alert(alert_id: int, body: AlertUpdate, request: Request, db: Session = Depends(get_db),
                 user: User = Depends(can_analyse)):
    a = db.get(Alert, alert_id)
    if not a:
        raise HTTPException(404, "Alert not found")
    detail = {}
    if body.status and body.status != a.status:
        if body.status not in TRANSITIONS[a.status]:
            raise HTTPException(409, f"Cannot move alert from {a.status.value} to {body.status.value}")
        if body.status == AlertStatus.new and user.role != Role.admin:
            raise HTTPException(403, "Only administrators can reopen dismissed alerts")
        if body.status in REVIEW_STATES and not (body.review_notes or a.review_notes):
            raise HTTPException(422, "Review notes are required to verify, dismiss or resolve an alert")
        detail["status"] = {"from": a.status.value, "to": body.status.value}
        a.status = body.status
        if body.status in REVIEW_STATES:
            a.reviewed_by, a.reviewed_at = user.id, datetime.now(timezone.utc)
    if body.assigned_to is not None:
        if body.assigned_to and not db.get(User, body.assigned_to):
            raise HTTPException(422, "Unknown assignee")
        detail["assigned_to"] = body.assigned_to
        a.assigned_to = body.assigned_to or None
    if body.review_notes is not None:
        a.review_notes = body.review_notes
        detail["review_notes"] = body.review_notes
    audit.record(db, user, "update", "alert", a.id, detail, request)
    db.commit()
    db.refresh(a)
    return _alert_out(a)


# ---------- field tasks ----------
def _task_out(t: FieldTask) -> TaskOut:
    o = TaskOut.model_validate(t)
    o.assignee_name = t.assignee.full_name if t.assignee else None
    o.area_name = t.area.name if t.area else None
    return o


@router.get("/tasks", response_model=list[TaskOut])
def list_tasks(mine: bool = False, status: TaskStatus | None = None, alert_id: int | None = None,
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(FieldTask).order_by(FieldTask.due_date.asc().nulls_last(), FieldTask.created_at.desc()).limit(500)
    if mine:
        q = q.where(FieldTask.assigned_to == user.id)
    if status:
        q = q.where(FieldTask.status == status)
    if alert_id:
        q = q.where(FieldTask.alert_id == alert_id)
    return [_task_out(t) for t in db.scalars(q)]


@router.post("/tasks", response_model=TaskOut, status_code=201)
def create_task(body: TaskIn, request: Request, db: Session = Depends(get_db), user: User = Depends(can_analyse)):
    area_id = body.area_id
    if body.alert_id:
        alert = db.get(Alert, body.alert_id)
        if not alert:
            raise HTTPException(422, "Unknown alert")
        area_id = area_id or alert.area_id
        if alert.status in (AlertStatus.new, AlertStatus.acknowledged):
            alert.status = AlertStatus.verifying
    if body.assigned_to and not db.get(User, body.assigned_to):
        raise HTTPException(422, "Unknown assignee")
    t = FieldTask(**body.model_dump(exclude={"area_id"}), area_id=area_id, created_by=user.id)
    db.add(t)
    db.flush()
    audit.record(db, user, "create", "task", t.id, body.model_dump(mode="json"), request)
    db.commit()
    db.refresh(t)
    return _task_out(t)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: int, body: TaskUpdate, request: Request, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    t = db.get(FieldTask, task_id)
    if not t:
        raise HTTPException(404, "Task not found")
    is_manager = user.role in (Role.admin, Role.analyst)
    if not is_manager and t.assigned_to != user.id:
        raise HTTPException(403, "You can only update tasks assigned to you")
    changes = body.model_dump(exclude_unset=True)
    if not is_manager and ({"assigned_to", "due_date"} & changes.keys()):
        raise HTTPException(403, "Only analysts can reassign or reschedule tasks")
    if changes.get("status") == TaskStatus.done and not (body.outcome or t.outcome):
        raise HTTPException(422, "Record the outcome before completing a task")
    for k, v in changes.items():
        setattr(t, k, v)
    if changes.get("status") == TaskStatus.done:
        t.completed_at = datetime.now(timezone.utc)
    audit.record(db, user, "update", "task", t.id, {k: (v.value if hasattr(v, "value") else str(v)) for k, v in changes.items()}, request)
    db.commit()
    db.refresh(t)
    return _task_out(t)
