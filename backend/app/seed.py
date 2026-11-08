"""Demo seed for the Sierra Leone pilot.

IMPORTANT: everything created here is *synthetic demonstration data* (source = "demo").
Protected-area outlines are rough approximations around real park locations, not official
boundaries. Replace with WDPA / national boundary data and real survey records before use.

Run: ``python -m app.seed`` (idempotent; does nothing if areas already exist).
"""
from __future__ import annotations

import math
import random
from datetime import date, datetime, timedelta, timezone

from geoalchemy2.shape import from_shape, to_shape
from shapely.geometry import MultiPolygon, Point, Polygon
from sqlalchemy import select

from .db import Base, SessionLocal, engine
from .models import (
    Alert,
    EnvironmentalIndicator,
    EvidenceType,
    FieldTask,
    HabitatMetric,
    Observation,
    Organisation,
    PressureEvent,
    ProtectedArea,
    Role,
    SurveyEffort,
    User,
    ValidationStatus,
)
from .security import hash_password
from .services import risk

DEMO_PASSWORD = "ChimpWatch!2026"
BOUNDARY_NOTE = "Approximate demo outline — replace with WDPA / official boundary"
DEMO_SRC = "Demo synthetic data"

# name, designation, district, centre (lon, lat), target km2, annual trend in encounter rate,
# base encounter rate (records/km), forest loss %/yr, fragmentation, pressure intensity
AREAS = [
    ("Outamba-Kilimi National Park", "National park", "Karene", (-12.33, 9.72), 1100, -0.10, 0.55, 0.9, 0.32, 1.2),
    ("Loma Mountains National Park", "National park", "Falaba", (-11.12, 9.20), 335, -0.02, 0.70, 0.5, 0.22, 0.6),
    ("Gola Rainforest National Park", "National park", "Kenema", (-10.88, 7.60), 710, 0.01, 0.62, 0.3, 0.15, 0.5),
    ("Western Area Peninsula National Park", "National park", "Western Area Rural", (-13.15, 8.36), 180, -0.24, 0.45, 2.4, 0.55, 2.5),
    ("Kangari Hills Forest Reserve", "Forest reserve", "Tonkolili", (-11.70, 8.55), 85, -0.30, 0.40, 2.8, 0.60, 3.0),
    ("Tingi Hills Forest Reserve", "Forest reserve", "Kono", (-10.78, 8.90), 110, -0.07, 0.50, 1.4, 0.38, 1.6),
]
DISTRICT_FOOD = {  # ipc phase, crop vulnerability, rainfall anomaly
    "Karene": (2.6, 0.58, -14), "Falaba": (2.9, 0.63, -18), "Kenema": (2.1, 0.44, -6),
    "Western Area Rural": (2.3, 0.40, 9), "Tonkolili": (2.8, 0.61, -21), "Kono": (2.5, 0.52, -11),
}
OTHER_SPECIES = [
    ("Cephalophus jentinki", "Jentink's duiker"), ("Choeropsis liberiensis", "Pygmy hippopotamus"),
    ("Loxodonta cyclotis", "African forest elephant"), ("Colobus polykomos", "King colobus"),
    ("Cercopithecus diana", "Diana monkey"), ("Potamochoerus porcus", "Red river hog"),
    ("Panthera pardus", "Leopard"), ("Smutsia gigantea", "Giant pangolin"),
    ("Philantomba maxwellii", "Maxwell's duiker"), ("Atilax paludinosus", "Marsh mongoose"),
]
CHIMP_EVIDENCE = [EvidenceType.nest] * 6 + [EvidenceType.feeding_sign, EvidenceType.dung, EvidenceType.vocalisation,
                                            EvidenceType.direct_sighting, EvidenceType.tool_use, EvidenceType.footprint]


def make_polygon(rng: random.Random, lon: float, lat: float, km2: float) -> Polygon:
    r_km = math.sqrt(km2 / math.pi)
    pts = []
    n = 28
    phase = rng.random() * math.pi
    for i in range(n):
        a = 2 * math.pi * i / n
        wobble = 1 + 0.18 * math.sin(3 * a + phase) + 0.08 * math.sin(7 * a + 2 * phase) + rng.uniform(-0.04, 0.04)
        dx = r_km * wobble * math.cos(a) * 1.25
        dy = r_km * wobble * math.sin(a) * 0.8
        pts.append((lon + dx / (111.32 * math.cos(math.radians(lat))), lat + dy / 110.57))
    return Polygon(pts).buffer(0)


def random_point_in(rng: random.Random, poly: Polygon) -> Point:
    minx, miny, maxx, maxy = poly.bounds
    while True:
        p = Point(rng.uniform(minx, maxx), rng.uniform(miny, maxy))
        if poly.contains(p):
            return p


def quarter_starts(start: date, end: date):
    d = start
    while d <= end:
        yield d
        m = d.month + 3
        d = date(d.year + (m - 1) // 12, (m - 1) % 12 + 1, 1)


def seed(today: date | None = None) -> bool:
    today = today or datetime.now(timezone.utc).date()
    rng = random.Random(20261106)
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        if db.scalar(select(ProtectedArea.id).limit(1)):
            return False

        orgs = {
            "nps": Organisation(name="National Protected Area Authority (demo)", kind="government"),
            "ngo": Organisation(name="Chimpanzee Conservation Partners (demo)", kind="ngo"),
            "uni": Organisation(name="Njala University Ecology Lab (demo)", kind="research"),
        }
        db.add_all(orgs.values())
        db.flush()
        pw = hash_password(DEMO_PASSWORD)
        users = {
            "admin": User(email="admin@chimpwatch.example", full_name="Aminata Kamara", role=Role.admin,
                          org_id=orgs["nps"].id, can_view_sensitive=True, hashed_password=pw),
            "analyst": User(email="analyst@chimpwatch.example", full_name="Dr. Ibrahim Sesay", role=Role.analyst,
                            org_id=orgs["ngo"].id, can_view_sensitive=True, hashed_password=pw),
            "ranger": User(email="ranger@chimpwatch.example", full_name="Mohamed Conteh", role=Role.field_monitor,
                           org_id=orgs["ngo"].id, can_view_sensitive=False, hashed_password=pw),
            "viewer": User(email="viewer@chimpwatch.example", full_name="Fatmata Bangura", role=Role.viewer,
                           org_id=orgs["uni"].id, can_view_sensitive=False, hashed_password=pw),
        }
        db.add_all(users.values())
        db.flush()

        start_q = date(2023, 1, 1)
        for (name, desig, district, (lon, lat), km2, trend, base, loss_pct, frag, press) in AREAS:
            poly = make_polygon(rng, lon, lat, km2)
            area = ProtectedArea(name=name, designation=desig, district=district,
                                 geom=from_shape(MultiPolygon([poly]), srid=4326), area_km2=km2,
                                 boundary_source=BOUNDARY_NOTE,
                                 description=f"Pilot landscape in {district} district. Demonstration data only.")
            db.add(area)
            db.flush()

            # --- surveys & chimp observations
            for q in quarter_starts(start_q, today - timedelta(days=62)):  # only quarters whose surveys have finished
                if rng.random() < 0.12:  # some quarters not surveyed
                    continue
                years = (q - start_q).days / 365.25
                effort = round(rng.uniform(18, 55) * (km2 / 400) ** 0.3, 1)
                sv = SurveyEffort(area_id=area.id, org_id=orgs["ngo"].id, method=rng.choice(["line_transect", "recce"]),
                                  start_date=q + timedelta(days=rng.randint(0, 20)),
                                  end_date=q + timedelta(days=rng.randint(25, 60)),
                                  effort_km=effort, team="Demo survey team", source="demo")
                db.add(sv)
                db.flush()
                lam = base * effort * (1 + trend) ** years * rng.uniform(0.85, 1.15)
                n = max(0, int(round(rng.gauss(lam, math.sqrt(max(lam, 1))))))
                for _ in range(n):
                    when = datetime.combine(sv.start_date + timedelta(days=rng.randint(0, 25)),
                                            datetime.min.time(), timezone.utc) + timedelta(hours=rng.randint(6, 17))
                    ev = rng.choice(CHIMP_EVIDENCE)
                    cnt = rng.randint(1, 6) if ev in (EvidenceType.nest, EvidenceType.direct_sighting) else 1
                    recent = (today - when.date()).days < 80
                    status = ValidationStatus.pending if recent and rng.random() < 0.6 else (
                        ValidationStatus.rejected if rng.random() < 0.03 else ValidationStatus.verified)
                    db.add(Observation(
                        area_id=area.id, survey_id=sv.id, org_id=orgs["ngo"].id, observer_id=users["ranger"].id,
                        species="Pan troglodytes verus", common_name="Western chimpanzee", evidence_type=ev,
                        count=cnt, observed_at=when, geom=from_shape(random_point_in(rng, poly), srid=4326),
                        gps_accuracy_m=rng.choice([4, 6, 8, 12]), sensitive=True,
                        id_confidence=round(rng.uniform(0.7, 1.0), 2), source="demo", validation_status=status,
                        validated_by=users["analyst"].id if status != ValidationStatus.pending else None,
                        validated_at=when + timedelta(days=14) if status != ValidationStatus.pending else None,
                        validation_note="Duplicate nest record" if status == ValidationStatus.rejected else None,
                    ))

            # --- recent opportunistic records awaiting validation (not linked to a survey)
            for _ in range(rng.randint(3, 6)):
                when = datetime.now(timezone.utc) - timedelta(days=rng.randint(1, 20), hours=rng.randint(0, 10))
                db.add(Observation(
                    area_id=area.id, org_id=orgs["ngo"].id, observer_id=users["ranger"].id,
                    species="Pan troglodytes verus", common_name="Western chimpanzee",
                    evidence_type=rng.choice(CHIMP_EVIDENCE), count=rng.randint(1, 5), observed_at=when,
                    geom=from_shape(random_point_in(rng, poly), srid=4326), gps_accuracy_m=rng.choice([5, 8, 15]),
                    sensitive=True, id_confidence=round(rng.uniform(0.6, 0.95), 2), source="demo",
                    notes="Opportunistic record during patrol"))

            # --- camera-trap wildlife records
            richness_base = rng.randint(8, 10)
            for q in quarter_starts(date(2024, 1, 1), today - timedelta(days=90)):
                years = (q - date(2024, 1, 1)).days / 365.25
                decline = max(0, -trend) * 0.8
                k = max(3, int(round(richness_base * (1 - decline) ** years + rng.uniform(-0.6, 0.6))))
                for sci, common in rng.sample(OTHER_SPECIES, min(k, len(OTHER_SPECIES))):
                    when = datetime.combine(q + timedelta(days=rng.randint(0, 80)), datetime.min.time(), timezone.utc)
                    db.add(Observation(
                        area_id=area.id, org_id=orgs["uni"].id, species=sci, common_name=common,
                        evidence_type=EvidenceType.camera_trap, count=rng.randint(1, 3), observed_at=when,
                        geom=from_shape(random_point_in(rng, poly), srid=4326), sensitive=sci in ("Smutsia gigantea", "Panthera pardus", "Loxodonta cyclotis"),
                        id_confidence=round(rng.uniform(0.6, 0.98), 2), source="demo",
                        validation_status=ValidationStatus.verified, validated_by=users["analyst"].id,
                        validated_at=when + timedelta(days=10)))
                db.add(EnvironmentalIndicator(category="biodiversity", indicator="species_richness", area_id=area.id,
                                              district=district, period_start=q, value=k, unit="species",
                                              source=f"{DEMO_SRC} (camera-trap grid)", data_date=q + timedelta(days=85)))

            # --- habitat metrics
            cover = km2 * rng.uniform(0.78, 0.9)
            for yr in range(2019, today.year):
                loss = cover * (loss_pct / 100) * rng.uniform(0.7, 1.3) * (1 + 0.06 * (yr - 2019))
                cover -= loss
                db.add(HabitatMetric(area_id=area.id, period_start=date(yr, 1, 1), period_end=date(yr, 12, 31),
                                     forest_cover_km2=round(cover, 2), forest_loss_km2=round(loss, 2),
                                     fragmentation_index=round(min(0.95, frag + 0.015 * (yr - 2019)), 3),
                                     suitability_index=round(max(0.1, 0.85 - frag * 0.6), 3),
                                     source=f"{DEMO_SRC} (pattern after Hansen GFC)", data_date=date(yr + 1, 4, 1)))

            # --- pressures (last 365 days)
            kinds = ["agriculture", "logging", "charcoal", "snare", "mining", "hunting", "settlement", "fire", "road"]
            for _ in range(int(press * rng.uniform(4, 7))):
                p = random_point_in(rng, poly.buffer(0.02))
                when = datetime.now(timezone.utc) - timedelta(days=rng.randint(1, 360))
                db.add(PressureEvent(area_id=area.id, kind=rng.choice(kinds), severity=rng.choice([1, 2, 2, 3]),
                                     observed_at=when, geom=from_shape(p, srid=4326), source="demo",
                                     description="Demo pressure report from ranger patrol",
                                     validation_status=rng.choice([ValidationStatus.verified, ValidationStatus.verified,
                                                                   ValidationStatus.pending]),
                                     reported_by=users["ranger"].id))

            # --- ecosystem indicators
            for i, q in enumerate(quarter_starts(date(2025, 1, 1), today - timedelta(days=100))):
                db.add(EnvironmentalIndicator(category="ecosystem", indicator="ndvi_anomaly", area_id=area.id,
                                              district=district, period_start=q,
                                              value=round(-frag * 1.6 + rng.uniform(-0.3, 0.4), 2), unit="SD",
                                              source=f"{DEMO_SRC} (pattern after Sentinel-2 NDVI)", data_date=q + timedelta(days=95)))
            db.add(EnvironmentalIndicator(category="ecosystem", indicator="water_quality_index", area_id=area.id,
                                          district=district, period_start=date(today.year, 1, 1),
                                          value=round(88 - frag * 50 + rng.uniform(-5, 5)), unit="index 0-100",
                                          source=f"{DEMO_SRC} (catchment sampling)", data_date=today - timedelta(days=75)))
            db.add(EnvironmentalIndicator(category="ecosystem", indicator="soil_erosion_risk", area_id=area.id,
                                          district=district, period_start=date(today.year, 1, 1),
                                          value=round(min(0.95, frag * 0.9 + rng.uniform(0, 0.1)), 2), unit="index 0-1",
                                          source=f"{DEMO_SRC} (RUSLE model)", data_date=today - timedelta(days=120)))

        # --- district food-security context
        for district, (ipc, cv, rf) in DISTRICT_FOOD.items():
            for back, season in ((2, "2025-lean"), (1, "2026-lean"), (0, "2026-current")):
                ps = date(today.year - (1 if back == 2 else 0), 6 if back else 9, 1)
                if ps + timedelta(days=30) > today:
                    ps = ps.replace(year=ps.year - 1)
                db.add(EnvironmentalIndicator(category="food_security", indicator="ipc_phase", district=district,
                                              period_start=ps, value=round(ipc - 0.15 * back + rng.uniform(-0.1, 0.1), 1),
                                              unit="phase 1-5", source=f"{DEMO_SRC} (pattern after Cadre Harmonisé)",
                                              data_date=ps + timedelta(days=30)))
            db.add(EnvironmentalIndicator(category="food_security", indicator="crop_vulnerability_index", district=district,
                                          period_start=date(today.year, 1, 1), value=cv, unit="index 0-1",
                                          source=f"{DEMO_SRC} (agricultural survey)", data_date=today - timedelta(days=90)))
            db.add(EnvironmentalIndicator(category="climate", indicator="rainfall_anomaly_pct", district=district,
                                          period_start=date(today.year, 5, 1), value=rf, unit="% vs 1991-2020",
                                          source=f"{DEMO_SRC} (pattern after CHIRPS)", data_date=today - timedelta(days=40)))
        db.commit()

        # --- run early warning and seed follow-up tasks
        risk.run_all(db, notify_users=False)
        top = db.scalars(select(Alert).order_by(Alert.score.desc().nulls_last()).limit(2)).all()
        for a in top:
            db.add(FieldTask(alert_id=a.id, area_id=a.area_id, title=f"Field verification: {a.area.name}",
                             description="Walk recce transects in the flagged sector, record all chimpanzee signs and "
                                         "human-pressure indicators, and upload photos.",
                             assigned_to=users["ranger"].id, created_by=users["analyst"].id,
                             due_date=today + timedelta(days=14)))
            a.status = a.status.__class__.verifying
        db.commit()
    return True


if __name__ == "__main__":
    created = seed()
    print("Seeded demo data." if created else "Database already contains areas; seed skipped.")
    if created:
        print(f"Demo accounts (password {DEMO_PASSWORD}): admin@, analyst@, ranger@, viewer@chimpwatch.example")
