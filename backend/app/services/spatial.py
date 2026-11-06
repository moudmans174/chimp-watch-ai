from geoalchemy2.functions import ST_Contains, ST_MakePoint, ST_SetSRID
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import ProtectedArea


def assign_area(db: Session, lon: float, lat: float, buffer_km: float = 2.0) -> int | None:
    """Return the protected area containing the point, else the nearest within buffer_km."""
    pt = ST_SetSRID(ST_MakePoint(lon, lat), 4326)
    hit = db.scalar(select(ProtectedArea.id).where(ST_Contains(ProtectedArea.geom, pt)).limit(1))
    if hit:
        return hit
    dist = func.ST_Distance(func.Geography(ProtectedArea.geom), func.Geography(pt))
    row = db.execute(select(ProtectedArea.id, dist.label("d")).order_by(dist).limit(1)).first()
    if row and row.d is not None and row.d <= buffer_km * 1000:
        return row.id
    return None


def compute_area_km2(db: Session, area: ProtectedArea) -> float:
    return float(db.scalar(select(func.ST_Area(func.Geography(ProtectedArea.geom)) / 1e6).where(
        ProtectedArea.id == area.id)) or 0)
