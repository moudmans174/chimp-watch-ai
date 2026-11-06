from fastapi import Request
from sqlalchemy.orm import Session

from .models import AuditLog, User


def record(db: Session, user: User | None, action: str, entity: str, entity_id=None,
           detail: dict | None = None, request: Request | None = None) -> None:
    """Append an audit entry. Caller commits as part of its own transaction."""
    ip = None
    if request is not None:
        fwd = request.headers.get("x-forwarded-for")
        ip = fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None)
    db.add(AuditLog(user_id=user.id if user else None, action=action, entity=entity,
                    entity_id=str(entity_id) if entity_id is not None else None, detail=detail, ip=ip))
