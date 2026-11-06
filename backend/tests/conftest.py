import os

os.environ.setdefault("CW_DATABASE_URL", "postgresql+psycopg://chimp:chimp@localhost:5432/chimpwatch_test")
os.environ.setdefault("CW_STORAGE_LOCAL_DIR", "/tmp/chimpwatch-test-media")
os.environ.setdefault("CW_LOGIN_RATE_LIMIT_PER_MINUTE", "1000")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.ratelimit import limiter  # noqa: E402
from app.seed import DEMO_PASSWORD, seed  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def database():
    with engine.begin() as c:
        c.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    seed()
    yield


@pytest.fixture()
def client():
    limiter.reset()
    return TestClient(app)


def _login(client, who):
    r = client.post("/api/auth/login", data={"username": f"{who}@chimpwatch.example", "password": DEMO_PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture()
def admin(client):
    return _login(client, "admin")


@pytest.fixture()
def analyst(client):
    return _login(client, "analyst")


@pytest.fixture()
def ranger(client):
    return _login(client, "ranger")


@pytest.fixture()
def viewer(client):
    return _login(client, "viewer")
