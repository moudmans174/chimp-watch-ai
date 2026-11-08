"""Early-warning risk engine.

Computes five *separate* indicators per monitored area (proposal §5, step 4):
  population_concern, habitat_pressure, biodiversity_change,
  ecosystem_condition, food_security_vulnerability

Each indicator returns a 0-100 concern score (higher = more concern), a level from the
expert-configured thresholds, its basis (observed vs modelled), a confidence label,
its input data date and the drivers behind it.

Safeguards built in:
- Low-confidence or insufficient-data indicators are never escalated to HIGH.
- The overall assessment is HIGH only when multiple indicators are elevated (proposal §5 table).
- Food-security vulnerability is reported as landscape context. It is never attributed to
  chimpanzee decline (proposal §6).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import (
    Alert,
    AlertLevel,
    AlertStatus,
    AlertThreshold,
    EnvironmentalIndicator,
    HabitatMetric,
    PressureEvent,
    ProtectedArea,
    RiskAssessment,
    ValidationStatus,
)
from . import analytics

INDICATORS = {
    "population_concern": "Chimpanzee population concern",
    "habitat_pressure": "Habitat pressure",
    "biodiversity_change": "Biodiversity change",
    "ecosystem_condition": "Ecosystem condition",
    "food_security_vulnerability": "Food-security vulnerability (context)",
}

DEFAULT_THRESHOLDS = {
    "population_concern": (35, 65, "Driven by the trend in verified encounter rates per km of survey effort."),
    "habitat_pressure": (40, 70, "Forest loss rate, fragmentation and recent mapped pressures."),
    "biodiversity_change": (40, 70, "Decline in camera-trap species richness against the recent baseline."),
    "ecosystem_condition": (45, 75, "Vegetation (NDVI) anomaly, water-quality and soil-erosion indicators."),
    "food_security_vulnerability": (50, 80, "District IPC phase, crop vulnerability and rainfall anomaly. Context only."),
}

RECOMMENDED = {
    AlertLevel.low: "Continue routine monitoring and scheduled data review.",
    AlertLevel.medium: "Request field verification and review contributing factors.",
    AlertLevel.high: "Escalate to designated conservation authorities and prioritise field assessment.",
}

OPEN_STATUSES = (AlertStatus.new, AlertStatus.acknowledged, AlertStatus.verifying)
_ORDER = {AlertLevel.low: 0, AlertLevel.medium: 1, AlertLevel.high: 2}


def clamp(v: float, lo: float = 0, hi: float = 100) -> float:
    return max(lo, min(hi, v))


def ensure_thresholds(db: Session) -> dict[str, AlertThreshold]:
    existing = {t.indicator: t for t in db.scalars(select(AlertThreshold))}
    for key, (m, h, desc) in DEFAULT_THRESHOLDS.items():
        if key not in existing:
            t = AlertThreshold(indicator=key, medium=m, high=h, description=desc)
            db.add(t)
            existing[key] = t
    db.flush()
    return existing


def level_for(score: float | None, confidence: str, th: AlertThreshold | None) -> tuple[AlertLevel, str | None]:
    if score is None or th is None or not th.enabled:
        return AlertLevel.low, None
    if score >= th.high:
        if confidence in ("low", "insufficient"):
            return AlertLevel.medium, "Score exceeds the high threshold but confidence is low; capped at medium pending validation."
        return AlertLevel.high, None
    if score >= th.medium:
        return AlertLevel.medium, None
    return AlertLevel.low, None


def _age_confidence(data_date: date | None, today: date) -> str:
    if data_date is None:
        return "insufficient"
    age = (today - data_date).days
    return "high" if age <= 400 else "medium" if age <= 800 else "low"


# ----------------------------------------------------------------------------- indicators
def population_concern(db: Session, area: ProtectedArea, today: date):
    s = get_settings()
    series = analytics.encounter_series(db, area.id)
    trend, forecast = analytics.fit_trend(series, s.min_periods_for_trend)
    conf = analytics.trend_confidence(trend, today)
    comp = {
        "label": INDICATORS["population_concern"],
        "basis": "modelled",
        "confidence": conf,
        "data_as_of": trend.latest_period.isoformat() if trend.latest_period else None,
        "score": None,
        "drivers": [],
        "metrics": {"n_periods": trend.n_periods, "r2": trend.r2},
    }
    if not trend.sufficient:
        comp["drivers"].append(trend.note)
        return comp, forecast, series
    chg = trend.annual_change
    lo, hi = trend.ci90
    excluded = [p.label for p in series if not p.complete]
    if excluded:
        comp["drivers"].append(f"Excluded from trend while validation is incomplete: {', '.join(excluded)}.")
    comp["metrics"].update({
        "annual_change_pct": round(chg * 100, 1),
        "ci90_pct": [round(lo * 100, 1), round(hi * 100, 1)],
        "latest_rate": round(series[-1].rate, 3),
    })
    # -20%/yr -> 50, -40%/yr -> 100. Increases score 0. Trends whose CI spans zero are shrunk.
    shrink = 1.0 if (hi < 0 or lo > 0) else 0.6
    score = clamp(-chg * 250 * shrink)
    comp["score"] = round(score, 1)
    direction = "decline" if chg < 0 else "increase"
    comp["drivers"].append(
        f"Encounter rate shows an estimated {abs(chg) * 100:.1f}% annual {direction} "
        f"(90% CI {lo * 100:+.1f}% to {hi * 100:+.1f}%) across {trend.n_periods} surveyed quarters."
    )
    if lo <= 0 <= hi:
        comp["drivers"].append("The confidence interval includes zero: the trend is not statistically distinguishable from stable.")
    return comp, forecast, series


def habitat_pressure(db: Session, area: ProtectedArea, today: date):
    metrics = db.scalars(
        select(HabitatMetric).where(HabitatMetric.area_id == area.id).order_by(HabitatMetric.period_start)
    ).all()
    comp = {"label": INDICATORS["habitat_pressure"], "basis": "observed", "score": None,
            "confidence": "insufficient", "data_as_of": None, "drivers": [], "metrics": {}}
    since = datetime.now(timezone.utc) - timedelta(days=180)
    pressure_rows = db.execute(
        select(PressureEvent.kind, PressureEvent.severity, PressureEvent.validation_status).where(
            PressureEvent.area_id == area.id, PressureEvent.observed_at >= since,
            PressureEvent.validation_status != ValidationStatus.rejected)
    ).all()
    weighted = sum(sev * (1.0 if vs == ValidationStatus.verified else 0.5) for _, sev, vs in pressure_rows)
    per100 = weighted / max(area.area_km2 or 100, 1) * 100
    pressure_score = clamp(per100 * 15)
    kinds: dict[str, int] = {}
    for k, _, _ in pressure_rows:
        kinds[k] = kinds.get(k, 0) + 1

    if not metrics:
        if pressure_rows:
            comp.update(score=round(pressure_score * 0.5, 1), confidence="low",
                        data_as_of=today.isoformat())
            comp["drivers"].append(f"{len(pressure_rows)} pressure reports in 180 days; no land-cover data available.")
        else:
            comp["drivers"].append("No land-cover metrics or pressure reports available.")
        return comp
    latest = metrics[-1]
    prev_cover = metrics[-2].forest_cover_km2 if len(metrics) > 1 else latest.forest_cover_km2 + latest.forest_loss_km2
    loss_rate = latest.forest_loss_km2 / prev_cover * 100 if prev_cover else 0
    recent = metrics[-3:]
    avg_loss_rate = sum(m.forest_loss_km2 for m in recent) / max(sum(m.forest_cover_km2 + m.forest_loss_km2 for m in recent), 1) * 100
    frag = latest.fragmentation_index or 0
    loss_score = clamp(max(loss_rate, avg_loss_rate) * 30)  # 1%/yr -> 30, 3.3%/yr -> 100
    score = 0.5 * loss_score + 0.25 * frag * 100 + 0.25 * pressure_score
    data_date = latest.data_date or latest.period_end
    comp.update(score=round(score, 1), confidence=_age_confidence(data_date, today), data_as_of=data_date.isoformat())
    comp["metrics"] = {
        "forest_cover_km2": round(latest.forest_cover_km2, 1),
        "forest_loss_km2_latest": round(latest.forest_loss_km2, 2),
        "loss_rate_pct_latest": round(loss_rate, 2),
        "loss_rate_pct_3yr": round(avg_loss_rate, 2),
        "fragmentation_index": round(frag, 2),
        "pressure_reports_180d": len(pressure_rows),
        "pressure_by_kind": kinds,
        "land_cover_source": latest.source,
    }
    comp["drivers"].append(f"Forest loss of {latest.forest_loss_km2:.1f} km² ({loss_rate:.2f}%) in the latest period ({latest.source}).")
    if frag >= 0.4:
        comp["drivers"].append(f"Fragmentation index {frag:.2f} indicates reduced habitat connectivity.")
    if pressure_rows:
        top = ", ".join(f"{k} ({v})" for k, v in sorted(kinds.items(), key=lambda kv: -kv[1]))
        comp["drivers"].append(f"{len(pressure_rows)} pressure reports in the last 180 days: {top}.")
    return comp


def _indicator_series(db: Session, name: str, area_id: int | None = None, district: str | None = None):
    q = select(EnvironmentalIndicator).where(EnvironmentalIndicator.indicator == name)
    if area_id is not None:
        q = q.where(EnvironmentalIndicator.area_id == area_id)
    if district is not None:
        q = q.where(EnvironmentalIndicator.district == district, EnvironmentalIndicator.area_id.is_(None))
    return db.scalars(q.order_by(EnvironmentalIndicator.period_start)).all()


def biodiversity_change(db: Session, area: ProtectedArea, today: date):
    comp = {"label": INDICATORS["biodiversity_change"], "basis": "observed", "score": None,
            "confidence": "insufficient", "data_as_of": None, "drivers": [], "metrics": {}}
    rows = _indicator_series(db, "species_richness", area_id=area.id)[-8:]
    if len(rows) < 4:
        comp["drivers"].append("Fewer than four periods of camera-trap species-richness data.")
        return comp
    xs = [analytics.decimal_year(r.period_start) for r in rows]
    ys = [r.value for r in rows]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx if sxx else 0
    change = slope / my if my else 0  # fractional change per year relative to mean
    score = clamp(-change * 250)  # -20%/yr -> 50
    latest = rows[-1]
    dd = latest.data_date or latest.period_start
    comp.update(score=round(score, 1), confidence=_age_confidence(dd, today) if len(rows) >= 6 else "low",
                data_as_of=dd.isoformat())
    comp["metrics"] = {"latest_richness": latest.value, "mean_richness": round(my, 1),
                       "annual_change_pct": round(change * 100, 1), "n_periods": len(rows)}
    comp["drivers"].append(f"Camera-trap species richness trending {change * 100:+.1f}% per year over "
                           f"{len(rows)} periods (latest {latest.value:.0f}, mean {my:.1f}).")
    return comp
    latest = rows[-1]
    baseline = rows[-4:-1]
    base = sum(r.value for r in baseline) / len(baseline)
    change = (latest.value - base) / base if base else 0
    score = clamp(-change * 300)  # -10% -> 30, -25% -> 75
    dd = latest.data_date or latest.period_start
    comp.update(score=round(score, 1), confidence=_age_confidence(dd, today) if len(rows) >= 4 else "low",
                data_as_of=dd.isoformat())
    comp["metrics"] = {"latest_richness": latest.value, "baseline_richness": round(base, 1),
                       "change_pct": round(change * 100, 1)}
    comp["drivers"].append(f"Camera-trap species richness {latest.value:.0f} vs baseline {base:.1f} ({change * 100:+.1f}%).")
    return comp


def ecosystem_condition(db: Session, area: ProtectedArea, today: date):
    comp = {"label": INDICATORS["ecosystem_condition"], "basis": "observed", "score": None,
            "confidence": "insufficient", "data_as_of": None, "drivers": [], "metrics": {}}
    parts, dates = [], []
    ndvi = _indicator_series(db, "ndvi_anomaly", area_id=area.id)
    if ndvi:
        v = ndvi[-1].value  # standardised anomaly; negative = browning
        parts.append(clamp(-v * 40 + 20))
        comp["metrics"]["ndvi_anomaly"] = v
        dates.append(ndvi[-1].data_date or ndvi[-1].period_start)
        if v < -0.5:
            comp["drivers"].append(f"Vegetation greenness anomaly of {v:+.2f} SD below the long-term mean.")
    wq = _indicator_series(db, "water_quality_index", area_id=area.id)
    if wq:
        v = wq[-1].value  # 0-100, higher is better
        parts.append(clamp(100 - v))
        comp["metrics"]["water_quality_index"] = v
        dates.append(wq[-1].data_date or wq[-1].period_start)
        if v < 60:
            comp["drivers"].append(f"Water-quality index {v:.0f}/100 in catchments draining the area.")
    soil = _indicator_series(db, "soil_erosion_risk", area_id=area.id)
    if soil:
        v = soil[-1].value  # 0-1
        parts.append(clamp(v * 100))
        comp["metrics"]["soil_erosion_risk"] = v
        dates.append(soil[-1].data_date or soil[-1].period_start)
        if v > 0.5:
            comp["drivers"].append(f"Elevated soil-erosion risk ({v:.2f}).")
    if not parts:
        comp["drivers"].append("No ecosystem-condition indicators available for this area.")
        return comp
    dd = min(dates)
    comp.update(score=round(sum(parts) / len(parts), 1), data_as_of=dd.isoformat(),
                confidence=_age_confidence(dd, today) if len(parts) >= 2 else "low")
    if not comp["drivers"]:
        comp["drivers"].append("Ecosystem indicators within expected ranges.")
    return comp


def food_security_vulnerability(db: Session, area: ProtectedArea, today: date):
    comp = {"label": INDICATORS["food_security_vulnerability"], "basis": "observed", "score": None,
            "confidence": "insufficient", "data_as_of": None, "drivers": [], "metrics": {"district": area.district},
            "caveat": ("Landscape context only. Food-security outcomes have many interacting drivers "
                       "(climate, markets, productivity, infrastructure, livelihoods); this indicator does "
                       "not attribute food insecurity to chimpanzee population change.")}
    parts, dates = [], []
    ipc = _indicator_series(db, "ipc_phase", district=area.district)
    if ipc:
        v = ipc[-1].value
        parts.append(clamp((v - 1) / 4 * 100))
        comp["metrics"]["ipc_phase"] = v
        dates.append(ipc[-1].data_date or ipc[-1].period_start)
        comp["drivers"].append(f"District IPC phase {v:.1f} ({ipc[-1].source}).")
    cv = _indicator_series(db, "crop_vulnerability_index", district=area.district)
    if cv:
        v = cv[-1].value
        parts.append(clamp(v * 100))
        comp["metrics"]["crop_vulnerability_index"] = v
        dates.append(cv[-1].data_date or cv[-1].period_start)
        comp["drivers"].append(f"Crop vulnerability index {v:.2f}.")
    rf = _indicator_series(db, "rainfall_anomaly_pct", district=area.district)
    if rf:
        v = rf[-1].value
        parts.append(clamp(abs(v) * 2.5))
        comp["metrics"]["rainfall_anomaly_pct"] = v
        dates.append(rf[-1].data_date or rf[-1].period_start)
        if abs(v) >= 15:
            comp["drivers"].append(f"Seasonal rainfall {v:+.0f}% vs long-term average.")
    if not parts:
        comp["drivers"].append(f"No food-security indicators for {area.district} district.")
        return comp
    dd = min(dates)
    comp.update(score=round(sum(parts) / len(parts), 1), data_as_of=dd.isoformat(),
                confidence=_age_confidence(dd, today) if len(parts) >= 2 else "low")
    return comp


# ----------------------------------------------------------------------------- orchestration
def assess_area(db: Session, area: ProtectedArea, thresholds: dict[str, AlertThreshold] | None = None,
                today: date | None = None) -> RiskAssessment:
    s = get_settings()
    today = today or datetime.now(timezone.utc).date()
    thresholds = thresholds or ensure_thresholds(db)

    pop, forecast, series = population_concern(db, area, today)
    comps = {
        "population_concern": pop,
        "habitat_pressure": habitat_pressure(db, area, today),
        "biodiversity_change": biodiversity_change(db, area, today),
        "ecosystem_condition": ecosystem_condition(db, area, today),
        "food_security_vulnerability": food_security_vulnerability(db, area, today),
    }
    for key, c in comps.items():
        lvl, note = level_for(c["score"], c["confidence"], thresholds.get(key))
        c["level"] = lvl.value
        if note:
            c["drivers"].append(note)

    # Overall: HIGH requires >=2 elevated conservation indicators including one HIGH.
    # Food-security context is excluded from the overall conservation level.
    cons = [AlertLevel(c["level"]) for k, c in comps.items() if k != "food_security_vulnerability"]
    elevated = sum(1 for lv in cons if lv != AlertLevel.low)
    if AlertLevel.high in cons and elevated >= 2:
        overall = AlertLevel.high
    elif elevated >= 1:
        overall = AlertLevel.medium
    else:
        overall = AlertLevel.low

    dates = [date.fromisoformat(c["data_as_of"]) for c in comps.values() if c.get("data_as_of")]
    fc = forecast or {}
    fc["series"] = analytics.series_payload(series)
    ra = RiskAssessment(area_id=area.id, model_version=s.risk_model_version,
                        data_as_of=max(dates) if dates else None, overall_level=overall,
                        components=comps, forecast=fc)
    db.add(ra)
    db.flush()
    return ra


def generate_alerts(db: Session, ra: RiskAssessment) -> list[Alert]:
    changed: list[Alert] = []
    area = db.get(ProtectedArea, ra.area_id)
    for key, c in ra.components.items():
        lvl = AlertLevel(c["level"])
        if lvl == AlertLevel.low:
            continue
        existing = db.scalars(
            select(Alert).where(Alert.area_id == ra.area_id, Alert.indicator == key, Alert.status.in_(OPEN_STATUSES))
            .order_by(Alert.created_at.desc())
        ).first()
        evidence = {"drivers": c["drivers"], "metrics": c.get("metrics", {}), "caveat": c.get("caveat")}
        title = f"{lvl.value.capitalize()}: {c['label']} — {area.name}"
        desc = " ".join(c["drivers"]) or c["label"]
        if c["basis"] == "modelled":
            desc = "[Modelled risk, not a confirmed population count] " + desc
        if existing:
            if _ORDER[lvl] > _ORDER[existing.level]:
                hist = (existing.evidence or {}).get("history", [])
                hist.append({"at": datetime.now(timezone.utc).isoformat(), "from": existing.level.value,
                             "to": lvl.value, "score": c["score"]})
                evidence["history"] = hist
                existing.level = lvl
                existing.title = title
                existing.recommended_action = RECOMMENDED[lvl]
                existing.status = AlertStatus.new
                changed.append(existing)
            else:
                evidence["history"] = (existing.evidence or {}).get("history", [])
            existing.score = c["score"]
            existing.confidence = c["confidence"]
            existing.description = desc
            existing.evidence = evidence
            existing.assessment_id = ra.id
            existing.data_as_of = date.fromisoformat(c["data_as_of"]) if c.get("data_as_of") else None
            existing.model_version = ra.model_version
            continue
        a = Alert(area_id=ra.area_id, assessment_id=ra.id, indicator=key, level=lvl, basis=c["basis"],
                  title=title, description=desc, recommended_action=RECOMMENDED[lvl], score=c["score"],
                  confidence=c["confidence"], model_version=ra.model_version,
                  data_as_of=date.fromisoformat(c["data_as_of"]) if c.get("data_as_of") else None,
                  evidence=evidence)
        db.add(a)
        changed.append(a)
    db.flush()
    return changed


def run_all(db: Session, notify_users: bool = True) -> dict:
    thresholds = ensure_thresholds(db)
    areas = db.scalars(select(ProtectedArea)).all()
    results = {"assessed": 0, "alerts_created_or_escalated": 0, "levels": {}}
    changed: list[Alert] = []
    for area in areas:
        ra = assess_area(db, area, thresholds)
        alerts = generate_alerts(db, ra)
        changed.extend(alerts)
        results["assessed"] += 1
        results["alerts_created_or_escalated"] += len(alerts)
        results["levels"][area.name] = ra.overall_level.value
    db.commit()
    if notify_users:
        from . import notify
        notify.high_alerts(db, changed)
    return results


def latest_assessments(db: Session) -> list[RiskAssessment]:
    sub = select(RiskAssessment.area_id, func.max(RiskAssessment.computed_at).label("m")).group_by(
        RiskAssessment.area_id).subquery()
    return db.scalars(select(RiskAssessment).join(
        sub, (RiskAssessment.area_id == sub.c.area_id) & (RiskAssessment.computed_at == sub.c.m))).all()
