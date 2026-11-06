from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="CW_", extra="ignore")

    app_name: str = "CHIMP-WATCH AI"
    environment: str = "development"  # development | staging | production
    database_url: str = "postgresql+psycopg://chimp:chimp@localhost:5432/chimpwatch"
    redis_url: str | None = "redis://localhost:6379/0"

    # Security
    secret_key: str = Field(default="change-me-in-production-please-use-64-random-bytes")
    access_token_minutes: int = 60 * 8
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:8080"]
    login_rate_limit_per_minute: int = 10

    # Sensitive-location generalisation (degrees). 0.1 deg ~ 11 km at the equator.
    location_generalisation_deg: float = 0.1

    # Object storage: "local" or "s3" (MinIO / AWS S3 compatible)
    storage_backend: str = "local"
    storage_local_dir: str = "./media"
    s3_endpoint_url: str | None = None
    s3_bucket: str = "chimpwatch-media"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    max_upload_mb: int = 25

    # Camera-trap classifier: "manual" (human review only) or "http" (external inference service)
    classifier_backend: str = "manual"
    classifier_url: str | None = None
    classifier_min_confidence: float = 0.5

    # Analytics
    risk_model_version: str = "cw-risk-0.3.0"
    worker_interval_minutes: int = 360
    min_periods_for_trend: int = 4

    # External integrations
    gbif_api_url: str = "https://api.gbif.org/v1"
    gbif_country: str = "SL"

    seed_demo: bool = False

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.is_production and s.secret_key.startswith("change-me"):
        raise RuntimeError("CW_SECRET_KEY must be set to a strong random value in production")
    return s
