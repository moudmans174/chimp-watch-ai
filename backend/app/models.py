"""Core data model.

Conventions
- All geometries are WGS84 (EPSG:4326).
- Every analytical record keeps provenance: source, data_date and validation status.
- Chimpanzee locations are sensitive by default (see geo.generalise_point).
"""
from __future__ import annotations

import enum
import uuid
from datetime import date, datetime, timezone

from geoalchemy2 import Geometry
from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _enum(e: type[enum.Enum]) -> Enum:
    return Enum(e, native_enum=False, length=32, values_callable=lambda x: [i.value for i in x])


class Role(str, enum.Enum):
    admin = "admin"  # platform / organisation administration
    analyst = "analyst"  # validate data, review alerts, configure thresholds
    field_monitor = "field_monitor"  # submit observations, complete field tasks
    viewer = "viewer"  # read-only dashboards


class ValidationStatus(str, enum.Enum):
    pending = "pending"
    verified = "verified"
    rejected = "rejected"


class EvidenceType(str, enum.Enum):
    direct_sighting = "direct_sighting"
    nest = "nest"
    vocalisation = "vocalisation"
    camera_trap = "camera_trap"
    feeding_sign = "feeding_sign"
    dung = "dung"
    tool_use = "tool_use"
    footprint = "footprint"


class AlertLevel(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"


class AlertStatus(str, enum.Enum):
    new = "new"
    acknowledged = "acknowledged"
    verifying = "verifying"
    verified = "verified"
    dismissed = "dismissed"
    resolved = "resolved"


class TaskStatus(str, enum.Enum):
    open = "open"
    in_progress = "in_progress"
    done = "done"
    cancelled = "cancelled"


class Organisation(Base):
    __tablename__ = "organisations"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    kind: Mapped[str] = mapped_column(String(50), default="ngo")  # government | ngo | research | community | partner
    country: Mapped[str] = mapped_column(String(2), default="SL")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(200))
    hashed_password: Mapped[str] = mapped_column(String(200))
    role: Mapped[Role] = mapped_column(_enum(Role), default=Role.viewer)
    org_id: Mapped[int] = mapped_column(ForeignKey("organisations.id"))
    can_view_sensitive: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Self sign-ups wait here (inactive) until an administrator approves them.
    pending_approval: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", index=True)
    # Details supplied at self sign-up, shown to administrators when reviewing the request
    phone: Mapped[str | None] = mapped_column(String(40))
    requested_org: Mapped[str | None] = mapped_column(String(200))
    requested_role: Mapped[str | None] = mapped_column(String(32))
    signup_note: Mapped[str | None] = mapped_column(Text)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    org: Mapped[Organisation] = relationship(lazy="joined")
    identities: Mapped[list[UserIdentity]] = relationship(back_populates="user", cascade="all, delete-orphan",
                                                          lazy="selectin")

    @property
    def providers(self) -> list[str]:
        return sorted({i.provider for i in self.identities})


class UserIdentity(Base):
    """An external sign-in (Google, Apple, GitHub) linked to a user account."""

    __tablename__ = "user_identities"
    __table_args__ = (UniqueConstraint("provider", "subject", name="uq_identity_provider_subject"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(20))
    subject: Mapped[str] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(254))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="identities")


class ProtectedArea(Base):
    """A monitored landscape: national park, forest reserve, community forest or corridor."""

    __tablename__ = "protected_areas"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    designation: Mapped[str] = mapped_column(String(80))
    district: Mapped[str] = mapped_column(String(100), index=True)
    country: Mapped[str] = mapped_column(String(2), default="SL")
    area_km2: Mapped[float | None] = mapped_column(Float)
    description: Mapped[str | None] = mapped_column(Text)
    boundary_source: Mapped[str | None] = mapped_column(String(200))
    geom = mapped_column(Geometry("MULTIPOLYGON", srid=4326, spatial_index=True))


class SurveyEffort(Base):
    """Survey effort is required to turn raw sign counts into comparable encounter rates."""

    __tablename__ = "survey_efforts"
    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("protected_areas.id"), index=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organisations.id"))
    method: Mapped[str] = mapped_column(String(40))  # line_transect | recce | camera_trap | patrol
    start_date: Mapped[date] = mapped_column(Date, index=True)
    end_date: Mapped[date] = mapped_column(Date)
    effort_km: Mapped[float | None] = mapped_column(Float)
    effort_trap_days: Mapped[float | None] = mapped_column(Float)
    team: Mapped[str | None] = mapped_column(String(200))
    source: Mapped[str] = mapped_column(String(40), default="field")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Observation(Base):
    __tablename__ = "observations"
    id: Mapped[int] = mapped_column(primary_key=True)
    client_uuid: Mapped[str] = mapped_column(String(36), unique=True, default=lambda: str(uuid.uuid4()))
    area_id: Mapped[int | None] = mapped_column(ForeignKey("protected_areas.id"), index=True)
    survey_id: Mapped[int | None] = mapped_column(ForeignKey("survey_efforts.id"))
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organisations.id"), index=True)
    observer_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    species: Mapped[str] = mapped_column(String(120), default="Pan troglodytes verus", index=True)
    common_name: Mapped[str | None] = mapped_column(String(120))
    evidence_type: Mapped[EvidenceType] = mapped_column(_enum(EvidenceType))
    count: Mapped[int] = mapped_column(Integer, default=1)
    adults: Mapped[int | None] = mapped_column(Integer)
    juveniles: Mapped[int | None] = mapped_column(Integer)
    infants: Mapped[int | None] = mapped_column(Integer)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    geom = mapped_column(Geometry("POINT", srid=4326, spatial_index=True))
    gps_accuracy_m: Mapped[float | None] = mapped_column(Float)
    sensitive: Mapped[bool] = mapped_column(Boolean, default=True)
    id_confidence: Mapped[float | None] = mapped_column(Float)  # 0-1, observer or model confidence
    notes: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(40), default="field")  # field | camera_trap | gbif | import | demo
    external_id: Mapped[str | None] = mapped_column(String(100), index=True)
    licence: Mapped[str | None] = mapped_column(String(100))

    validation_status: Mapped[ValidationStatus] = mapped_column(
        _enum(ValidationStatus), default=ValidationStatus.pending, index=True
    )
    validated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    validation_note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    area: Mapped[ProtectedArea | None] = relationship(lazy="joined")
    media: Mapped[list[Media]] = relationship(back_populates="observation", cascade="all, delete-orphan")


class Media(Base):
    __tablename__ = "media"
    id: Mapped[int] = mapped_column(primary_key=True)
    observation_id: Mapped[int] = mapped_column(ForeignKey("observations.id", ondelete="CASCADE"), index=True)
    storage_key: Mapped[str] = mapped_column(String(300))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    classification: Mapped[dict | None] = mapped_column(JSON)  # detections, model_version, review status
    uploaded_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    observation: Mapped[Observation] = relationship(back_populates="media")


class HabitatMetric(Base):
    """Annual (or periodic) land-cover metrics per area, e.g. derived from Hansen/GFW or Sentinel-2."""

    __tablename__ = "habitat_metrics"
    __table_args__ = (UniqueConstraint("area_id", "period_start", "source", name="uq_habitat_area_period_src"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("protected_areas.id"), index=True)
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    forest_cover_km2: Mapped[float] = mapped_column(Float)
    forest_loss_km2: Mapped[float] = mapped_column(Float, default=0.0)
    fragmentation_index: Mapped[float | None] = mapped_column(Float)  # 0 (intact) - 1 (highly fragmented)
    suitability_index: Mapped[float | None] = mapped_column(Float)  # 0-1 modelled habitat suitability
    source: Mapped[str] = mapped_column(String(100))
    data_date: Mapped[date | None] = mapped_column(Date)


class PressureEvent(Base):
    """Mapped human pressure: mining, logging, agricultural clearing, fire, snares, roads, settlements."""

    __tablename__ = "pressure_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int | None] = mapped_column(ForeignKey("protected_areas.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40), index=True)
    severity: Mapped[int] = mapped_column(Integer, default=2)  # 1 low - 3 high
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    geom = mapped_column(Geometry("POINT", srid=4326, spatial_index=True))
    description: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(40), default="field")
    validation_status: Mapped[ValidationStatus] = mapped_column(
        _enum(ValidationStatus), default=ValidationStatus.pending
    )
    reported_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EnvironmentalIndicator(Base):
    """Ecosystem, climate, biodiversity and food-security indicators at area or district level."""

    __tablename__ = "environmental_indicators"
    __table_args__ = (Index("ix_indicator_lookup", "indicator", "district", "period_start"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    category: Mapped[str] = mapped_column(String(40), index=True)  # ecosystem | food_security | climate | biodiversity
    indicator: Mapped[str] = mapped_column(String(80))
    district: Mapped[str | None] = mapped_column(String(100))
    area_id: Mapped[int | None] = mapped_column(ForeignKey("protected_areas.id"), index=True)
    period_start: Mapped[date] = mapped_column(Date)
    value: Mapped[float] = mapped_column(Float)
    unit: Mapped[str | None] = mapped_column(String(40))
    source: Mapped[str] = mapped_column(String(150))
    data_date: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text)


class AlertThreshold(Base):
    """Expert-configured thresholds per risk indicator (scores are 0-100, higher = more concern)."""

    __tablename__ = "alert_thresholds"
    id: Mapped[int] = mapped_column(primary_key=True)
    indicator: Mapped[str] = mapped_column(String(60), unique=True)
    medium: Mapped[float] = mapped_column(Float, default=40)
    high: Mapped[float] = mapped_column(Float, default=70)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    description: Mapped[str | None] = mapped_column(Text)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class RiskAssessment(Base):
    __tablename__ = "risk_assessments"
    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("protected_areas.id"), index=True)
    computed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    model_version: Mapped[str] = mapped_column(String(40))
    data_as_of: Mapped[date | None] = mapped_column(Date)
    overall_level: Mapped[AlertLevel] = mapped_column(_enum(AlertLevel))
    components: Mapped[dict] = mapped_column(JSON)  # per-indicator score, level, basis, confidence, drivers
    forecast: Mapped[dict | None] = mapped_column(JSON)

    area: Mapped[ProtectedArea] = relationship(lazy="joined")


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    area_id: Mapped[int] = mapped_column(ForeignKey("protected_areas.id"), index=True)
    assessment_id: Mapped[int | None] = mapped_column(ForeignKey("risk_assessments.id"))
    indicator: Mapped[str] = mapped_column(String(60), index=True)
    level: Mapped[AlertLevel] = mapped_column(_enum(AlertLevel), index=True)
    status: Mapped[AlertStatus] = mapped_column(_enum(AlertStatus), default=AlertStatus.new, index=True)
    basis: Mapped[str] = mapped_column(String(20))  # observed | modelled
    title: Mapped[str] = mapped_column(String(250))
    description: Mapped[str] = mapped_column(Text)
    recommended_action: Mapped[str | None] = mapped_column(Text)
    score: Mapped[float | None] = mapped_column(Float)
    confidence: Mapped[str | None] = mapped_column(String(20))
    model_version: Mapped[str | None] = mapped_column(String(40))
    data_as_of: Mapped[date | None] = mapped_column(Date)
    evidence: Mapped[dict | None] = mapped_column(JSON)
    assigned_to: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    area: Mapped[ProtectedArea] = relationship(lazy="joined")


class FieldTask(Base):
    __tablename__ = "field_tasks"
    id: Mapped[int] = mapped_column(primary_key=True)
    alert_id: Mapped[int | None] = mapped_column(ForeignKey("alerts.id"), index=True)
    area_id: Mapped[int | None] = mapped_column(ForeignKey("protected_areas.id"))
    title: Mapped[str] = mapped_column(String(250))
    description: Mapped[str | None] = mapped_column(Text)
    assigned_to: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    due_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[TaskStatus] = mapped_column(_enum(TaskStatus), default=TaskStatus.open, index=True)
    outcome: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    area: Mapped[ProtectedArea | None] = relationship(lazy="joined")
    assignee: Mapped[User | None] = relationship(foreign_keys=[assigned_to], lazy="joined")


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    action: Mapped[str] = mapped_column(String(60), index=True)
    entity: Mapped[str] = mapped_column(String(60))
    entity_id: Mapped[str | None] = mapped_column(String(60))
    detail: Mapped[dict | None] = mapped_column(JSON)
    ip: Mapped[str | None] = mapped_column(String(64))
