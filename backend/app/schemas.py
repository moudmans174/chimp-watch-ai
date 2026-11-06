from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from .models import AlertLevel, AlertStatus, EvidenceType, Role, TaskStatus, ValidationStatus


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------- auth / users ----------
class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class OrgOut(ORM):
    id: int
    name: str
    kind: str
    country: str


class OrgIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    kind: str = "ngo"
    country: str = Field(default="SL", min_length=2, max_length=2)


class UserOut(ORM):
    id: int
    email: str
    full_name: str
    role: Role
    org_id: int
    org: OrgOut | None = None
    can_view_sensitive: bool
    is_active: bool
    pending_approval: bool = False
    last_login: datetime | None = None
    created_at: datetime | None = None
    providers: list[str] = []


class AdminUserOut(UserOut):
    """Includes personal details from sign-up; only returned to administrators."""
    phone: str | None = None
    requested_org: str | None = None
    requested_role: str | None = None
    signup_note: str | None = None


class SignupIn(BaseModel):
    full_name: str = Field(min_length=2, max_length=200)
    email: EmailStr
    password: str = Field(max_length=200)
    organisation: str = Field(min_length=2, max_length=200)
    requested_role: Role = Role.viewer
    phone: str | None = Field(default=None, max_length=40, pattern=r"^[0-9+()\-\s]*$")
    reason: str = Field(min_length=10, max_length=1000)
    accept_terms: bool

    @field_validator("full_name", "organisation", "reason")
    @classmethod
    def strip(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Too short")
        return v

    @field_validator("requested_role")
    @classmethod
    def no_admin(cls, v: Role) -> Role:
        if v == Role.admin:
            raise ValueError("Administrator access cannot be requested")
        return v

    @field_validator("accept_terms")
    @classmethod
    def must_accept(cls, v: bool) -> bool:
        if not v:
            raise ValueError("You must agree to the data-use terms")
        return v


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=200)
    password: str
    role: Role = Role.viewer
    org_id: int
    can_view_sensitive: bool = False


class UserUpdate(BaseModel):
    full_name: str | None = None
    org_id: int | None = None
    role: Role | None = None
    can_view_sensitive: bool | None = None
    is_active: bool | None = None
    password: str | None = None


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


# ---------- areas ----------
class AreaIn(BaseModel):
    name: str
    designation: str
    district: str
    country: str = "SL"
    description: str | None = None
    boundary_source: str | None = None
    boundary: dict  # GeoJSON Polygon/MultiPolygon


class AreaOut(ORM):
    id: int
    name: str
    designation: str
    district: str
    country: str
    area_km2: float | None
    description: str | None
    boundary_source: str | None


# ---------- observations ----------
class ObservationIn(BaseModel):
    client_uuid: str | None = Field(default=None, max_length=36)
    species: str = "Pan troglodytes verus"
    common_name: str | None = "Western chimpanzee"
    evidence_type: EvidenceType
    count: int = Field(default=1, ge=0, le=500)
    adults: int | None = Field(default=None, ge=0)
    juveniles: int | None = Field(default=None, ge=0)
    infants: int | None = Field(default=None, ge=0)
    observed_at: datetime
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    gps_accuracy_m: float | None = Field(default=None, ge=0)
    id_confidence: float | None = Field(default=None, ge=0, le=1)
    survey_id: int | None = None
    notes: str | None = Field(default=None, max_length=4000)
    sensitive: bool | None = None

    @field_validator("observed_at")
    @classmethod
    def not_future(cls, v: datetime) -> datetime:
        from datetime import timezone, timedelta
        now = datetime.now(timezone.utc)
        vv = v if v.tzinfo else v.replace(tzinfo=timezone.utc)
        if vv > now + timedelta(hours=1):
            raise ValueError("Observation time cannot be in the future")
        return vv


class Location(BaseModel):
    lon: float
    lat: float
    generalised: bool
    precision_km: float | None


class ObservationOut(BaseModel):
    id: int
    client_uuid: str
    area_id: int | None
    area_name: str | None
    species: str
    common_name: str | None
    evidence_type: EvidenceType
    count: int
    adults: int | None
    juveniles: int | None
    infants: int | None
    observed_at: datetime
    location: Location | None
    gps_accuracy_m: float | None
    sensitive: bool
    id_confidence: float | None
    notes: str | None
    source: str
    validation_status: ValidationStatus
    validation_note: str | None
    validated_at: datetime | None
    observer_id: int | None
    org_id: int | None
    media_count: int = 0
    created_at: datetime


class ValidationIn(BaseModel):
    status: ValidationStatus
    note: str | None = None


class SurveyIn(BaseModel):
    area_id: int
    method: str
    start_date: date
    end_date: date
    effort_km: float | None = Field(default=None, ge=0)
    effort_trap_days: float | None = Field(default=None, ge=0)
    team: str | None = None


class SurveyOut(ORM):
    id: int
    area_id: int
    method: str
    start_date: date
    end_date: date
    effort_km: float | None
    effort_trap_days: float | None
    team: str | None
    source: str


class PressureIn(BaseModel):
    kind: str
    severity: int = Field(default=2, ge=1, le=3)
    observed_at: datetime
    lat: float
    lon: float
    description: str | None = None


class PressureOut(BaseModel):
    id: int
    area_id: int | None
    area_name: str | None
    kind: str
    severity: int
    observed_at: datetime
    lon: float
    lat: float
    description: str | None
    source: str
    validation_status: ValidationStatus


# ---------- habitat & indicators ----------
class HabitatOut(ORM):
    id: int
    area_id: int
    period_start: date
    period_end: date
    forest_cover_km2: float
    forest_loss_km2: float
    fragmentation_index: float | None
    suitability_index: float | None
    source: str
    data_date: date | None


class IndicatorOut(ORM):
    id: int
    category: str
    indicator: str
    district: str | None
    area_id: int | None
    period_start: date
    value: float
    unit: str | None
    source: str
    data_date: date | None


# ---------- risk / alerts ----------
class ThresholdOut(ORM):
    id: int
    indicator: str
    medium: float
    high: float
    enabled: bool
    description: str | None
    updated_at: datetime


class ThresholdIn(BaseModel):
    medium: float = Field(ge=0, le=100)
    high: float = Field(ge=0, le=100)
    enabled: bool = True

    @field_validator("high")
    @classmethod
    def high_above_medium(cls, v, info):
        if "medium" in info.data and v <= info.data["medium"]:
            raise ValueError("high threshold must be greater than medium")
        return v


class AssessmentOut(ORM):
    id: int
    area_id: int
    computed_at: datetime
    model_version: str
    data_as_of: date | None
    overall_level: AlertLevel
    components: dict[str, Any]
    forecast: dict[str, Any] | None


class AlertOut(ORM):
    id: int
    area_id: int
    area_name: str | None = None
    indicator: str
    level: AlertLevel
    status: AlertStatus
    basis: str
    title: str
    description: str
    recommended_action: str | None
    score: float | None
    confidence: str | None
    model_version: str | None
    data_as_of: date | None
    evidence: dict | None
    assigned_to: int | None
    reviewed_by: int | None
    reviewed_at: datetime | None
    review_notes: str | None
    created_at: datetime
    updated_at: datetime


class AlertUpdate(BaseModel):
    status: AlertStatus | None = None
    assigned_to: int | None = None
    review_notes: str | None = Field(default=None, max_length=4000)


class TaskIn(BaseModel):
    alert_id: int | None = None
    area_id: int | None = None
    title: str = Field(min_length=3, max_length=250)
    description: str | None = None
    assigned_to: int | None = None
    due_date: date | None = None


class TaskUpdate(BaseModel):
    status: TaskStatus | None = None
    outcome: str | None = None
    assigned_to: int | None = None
    due_date: date | None = None


class TaskOut(ORM):
    id: int
    alert_id: int | None
    area_id: int | None
    title: str
    description: str | None
    assigned_to: int | None
    assignee_name: str | None = None
    area_name: str | None = None
    created_by: int | None
    due_date: date | None
    status: TaskStatus
    outcome: str | None
    created_at: datetime
    completed_at: datetime | None


class AuditOut(ORM):
    id: int
    at: datetime
    user_id: int | None
    action: str
    entity: str
    entity_id: str | None
    detail: dict | None
    ip: str | None


class Page(BaseModel):
    total: int
    items: list[Any]


Token.model_rebuild()
