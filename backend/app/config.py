"""
API configuration, loaded from environment variables (12-factor).

Secrets never live in code or in the image: they are injected at runtime by
docker-compose (from a gitignored .env) or by the deployment platform's secret
store. The API refuses to start with a missing or weak SECRET_KEY rather than
silently running with a guessable one.

Only the API imports this module. The worker never needs the JWT secret.
"""
from functools import lru_cache

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MIN_SECRET_LENGTH = 32

# Values that must never be accepted, including the key that used to be
# hardcoded here and is still visible in git history.
_KNOWN_BAD_SECRETS = {
    "your-super-secret-key-change-in-production",
    "changeme",
    "change-me",
    "secret",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(case_sensitive=False, extra="ignore")

    secret_key: SecretStr = Field(..., description="HMAC key used to sign JWTs")
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = Field(default=60 * 24 * 7, gt=0)

    @field_validator("secret_key")
    @classmethod
    def _reject_weak_secret(cls, value: SecretStr) -> SecretStr:
        raw = value.get_secret_value()
        if raw.strip().lower() in _KNOWN_BAD_SECRETS or raw.startswith("REPLACE_"):
            raise ValueError("SECRET_KEY is a placeholder; generate a real one (see .env.example)")
        if len(raw) < MIN_SECRET_LENGTH:
            raise ValueError(f"SECRET_KEY must be at least {MIN_SECRET_LENGTH} characters")
        return value

    @field_validator("jwt_algorithm")
    @classmethod
    def _restrict_algorithm(cls, value: str) -> str:
        # Symmetric HMAC only; "none" and asymmetric algorithms need different key handling.
        if value not in {"HS256", "HS384", "HS512"}:
            raise ValueError("JWT_ALGORITHM must be HS256, HS384 or HS512")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
