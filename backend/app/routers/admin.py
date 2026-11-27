from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..config import get_settings
from ..db import get_db
from ..models import AlertThreshold, AuditLog, Organisation, Role, User
from ..schemas import AdminUserOut, AuditOut, OrgIn, OrgOut, ThresholdIn, ThresholdOut, UserCreate, UserOut, UserUpdate
from ..security import admin_only, can_analyse, get_current_user, hash_password, validate_password_strength
from ..services import notify
from ..services.risk import ensure_thresholds

router = APIRouter(prefix="/api", tags=["admin"])


@router.get("/organisations", response_model=list[OrgOut])
def list_orgs(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return db.scalars(select(Organisation).order_by(Organisation.name)).all()


@router.post("/organisations", response_model=OrgOut, status_code=201)
def create_org(body: OrgIn, request: Request, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    if db.scalar(select(Organisation).where(func.lower(Organisation.name) == body.name.lower())):
        raise HTTPException(409, "Organisation already exists")
    org = Organisation(**body.model_dump())
    db.add(org)
    db.flush()
    audit.record(db, user, "create", "organisation", org.id, body.model_dump(), request)
    db.commit()
    return org


@router.get("/users", response_model=list[AdminUserOut] | list[UserOut])
def list_users(pending: bool | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = select(User).order_by(User.pending_approval.desc(), User.full_name)
    if user.role != Role.admin:
        q = q.where(User.is_active.is_(True))
    if pending is not None:
        q = q.where(User.pending_approval.is_(pending))
    schema = AdminUserOut if user.role == Role.admin else UserOut
    return [schema.model_validate(u) for u in db.scalars(q).all()]


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(body: UserCreate, request: Request, db: Session = Depends(get_db), user: User = Depends(admin_only)):
    validate_password_strength(body.password)
    if db.scalar(select(User).where(func.lower(User.email) == body.email.lower())):
        raise HTTPException(409, "A user with this email already exists")
    if not db.get(Organisation, body.org_id):
        raise HTTPException(422, "Unknown organisation")
    u = User(email=body.email.lower(), full_name=body.full_name, hashed_password=hash_password(body.password),
             role=body.role, org_id=body.org_id, can_view_sensitive=body.can_view_sensitive)
    db.add(u)
    db.flush()
    audit.record(db, user, "create", "user", u.id, {"email": u.email, "role": u.role.value,
                                                   "can_view_sensitive": u.can_view_sensitive}, request)
    db.commit()
    db.refresh(u)
    return u


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, request: Request, db: Session = Depends(get_db),
                user: User = Depends(admin_only)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found")
    changes = body.model_dump(exclude_unset=True)
    if u.id == user.id and (changes.get("role") not in (None, Role.admin) or changes.get("is_active") is False):
        raise HTTPException(400, "You cannot remove your own administrator access")
    if "org_id" in changes and not db.get(Organisation, changes["org_id"]):
        raise HTTPException(422, "Unknown organisation")
    approving = u.pending_approval and changes.get("is_active") is True
    if approving:
        if "org_id" not in changes and u.org and u.org.name == get_settings().signup_org_name:
            raise HTTPException(422, "Assign an organisation before approving this account")
        u.pending_approval = False
        changes["approved"] = True
    rejecting = u.pending_approval and changes.get("is_active") is False
    if rejecting:
        u.pending_approval = False
        changes["rejected"] = True
    if "password" in changes:
        validate_password_strength(changes["password"])
        u.hashed_password = hash_password(changes.pop("password"))
        changes["password"] = "***"
    for k, v in changes.items():
        if k not in ("password", "approved", "rejected"):
            setattr(u, k, v)
    audit.record(db, user, "approve" if approving else "reject" if rejecting else "update", "user", u.id, {k: (v.value if hasattr(v, "value") else v) for k, v in changes.items()}, request)
    db.commit()
    db.refresh(u)
    if approving:
        notify.approved(u, db)
    elif rejecting:
        notify.declined(u)
    return u


@router.get("/thresholds", response_model=list[ThresholdOut])
def list_thresholds(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    ensure_thresholds(db)
    db.commit()
    return db.scalars(select(AlertThreshold).order_by(AlertThreshold.id)).all()


@router.put("/thresholds/{indicator}", response_model=ThresholdOut)
def update_threshold(indicator: str, body: ThresholdIn, request: Request, db: Session = Depends(get_db),
                     user: User = Depends(can_analyse)):
    ensure_thresholds(db)
    t = db.scalar(select(AlertThreshold).where(AlertThreshold.indicator == indicator))
    if not t:
        raise HTTPException(404, "Unknown indicator")
    before = {"medium": t.medium, "high": t.high, "enabled": t.enabled}
    t.medium, t.high, t.enabled, t.updated_by = body.medium, body.high, body.enabled, user.id
    audit.record(db, user, "update", "threshold", indicator, {"before": before, "after": body.model_dump()}, request)
    db.commit()
    return t


@router.get("/audit", response_model=list[AuditOut])
def audit_log(limit: int = Query(200, le=1000), action: str | None = None, entity: str | None = None,
              db: Session = Depends(get_db), _: User = Depends(admin_only)):
    q = select(AuditLog).order_by(AuditLog.at.desc()).limit(limit)
    if action:
        q = q.where(AuditLog.action == action)
    if entity:
        q = q.where(AuditLog.entity == entity)
    return db.scalars(q).all()
