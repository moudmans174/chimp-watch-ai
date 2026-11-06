"""Population indicator time series, trend estimation and forecasting.

Method (MVP baseline, to be validated with conservation specialists):
- Encounter rate = verified chimpanzee sign records per km of survey effort, per quarter.
- Quarters without recorded survey effort are treated as *missing*, never as zero.
- Trend = quasi-Poisson GLM of verified sign counts on time (years), with log(survey km) as an
  offset. Annual change = exp(slope) - 1, with a 90% CI from the dispersion-scaled standard error
  (t-distribution). Zero-detection quarters are handled naturally; overdispersion widens the CI.
- Forecast = the fitted model projected four quarters ahead with an 80% interval for the expected rate.

These are indices of relative abundance, not population counts. Outputs always state
their uncertainty, data date and model version.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone

import numpy as np
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Observation, SurveyEffort, ValidationStatus

CHIMP_SPECIES = ("Pan troglodytes verus", "Pan troglodytes")
TRANSECT_METHODS = ("line_transect", "recce", "patrol")
MAX_PENDING_SHARE = 0.2

# Two-sided t critical values (df -> t) for 90% and 80% intervals. Avoids a scipy dependency.
_T90 = {1: 6.314, 2: 2.920, 3: 2.353, 4: 2.132, 5: 2.015, 6: 1.943, 7: 1.895, 8: 1.860, 9: 1.833,
        10: 1.812, 12: 1.782, 15: 1.753, 20: 1.725, 30: 1.697}
_T80 = {1: 3.078, 2: 1.886, 3: 1.638, 4: 1.533, 5: 1.476, 6: 1.440, 7: 1.415, 8: 1.397, 9: 1.383,
        10: 1.372, 12: 1.356, 15: 1.341, 20: 1.325, 30: 1.310}


def _t(table: dict[int, float], df: int) -> float:
    if df <= 0:
        return float("inf")
    keys = sorted(table)
    for k in keys:
        if df <= k:
            return table[k]
    return table[keys[-1]]


def quarter_start(d: date) -> date:
    return date(d.year, 3 * ((d.month - 1) // 3) + 1, 1)


def quarter_label(d: date) -> str:
    return f"{d.year}-Q{(d.month - 1) // 3 + 1}"


def add_quarters(d: date, n: int) -> date:
    m = d.month - 1 + 3 * n
    return date(d.year + m // 12, m % 12 + 1, 1)


def decimal_year(d: date) -> float:
    return d.year + (d.timetuple().tm_yday - 1) / 365.25


@dataclass
class Period:
    start: date
    label: str
    effort_km: float
    records: int
    individuals: int
    rate: float  # records per km
    pending: int = 0

    @property
    def complete(self) -> bool:
        """A quarter whose records are still largely awaiting validation is excluded from trend fitting."""
        total = self.records + self.pending
        return total == 0 or self.pending / total <= MAX_PENDING_SHARE


def encounter_series(db: Session, area_id: int) -> list[Period]:
    efforts = db.execute(
        select(SurveyEffort.start_date, SurveyEffort.effort_km).where(
            SurveyEffort.area_id == area_id,
            SurveyEffort.method.in_(TRANSECT_METHODS),
            SurveyEffort.effort_km.is_not(None),
            SurveyEffort.effort_km > 0,
        )
    ).all()
    effort_by_q: dict[date, float] = {}
    for start, km in efforts:
        q = quarter_start(start)
        effort_by_q[q] = effort_by_q.get(q, 0.0) + float(km)

    obs = db.execute(
        select(Observation.observed_at, Observation.count, Observation.validation_status).where(
            Observation.area_id == area_id,
            Observation.species.in_(CHIMP_SPECIES),
            Observation.validation_status != ValidationStatus.rejected,
            Observation.survey_id.is_not(None),
        )
    ).all()
    rec_by_q: dict[date, list[int]] = {}
    pend_by_q: dict[date, int] = {}
    for when, cnt, status in obs:
        q = quarter_start(when.date())
        if status == ValidationStatus.verified:
            rec_by_q.setdefault(q, []).append(cnt or 0)
        else:
            pend_by_q[q] = pend_by_q.get(q, 0) + 1

    out = []
    for q in sorted(effort_by_q):
        km = effort_by_q[q]
        recs = rec_by_q.get(q, [])
        out.append(Period(q, quarter_label(q), round(km, 2), len(recs), int(sum(recs)), len(recs) / km,
                          pend_by_q.get(q, 0)))
    return out


@dataclass
class Trend:
    n_periods: int
    annual_change: float | None  # fraction, e.g. -0.12
    ci90: tuple[float, float] | None
    r2: float | None
    latest_period: date | None
    sufficient: bool
    note: str


def _poisson_irls(x: np.ndarray, y: np.ndarray, offset: np.ndarray, iters: int = 50):
    """Poisson GLM with log link and offset, fitted by iteratively reweighted least squares."""
    X = np.column_stack([np.ones_like(x), x])
    beta = np.array([np.log(max(y.sum(), 0.5) / np.exp(offset).sum()), 0.0])
    for _ in range(iters):
        eta = X @ beta + offset
        mu = np.exp(eta)
        z = eta - offset + (y - mu) / mu
        W = mu
        XtW = X.T * W
        new = np.linalg.solve(XtW @ X, XtW @ z)
        if np.max(np.abs(new - beta)) < 1e-9:
            beta = new
            break
        beta = new
    mu = np.exp(X @ beta + offset)
    cov = np.linalg.inv((X.T * mu) @ X)
    return beta, cov, mu


def fit_trend(series: list[Period], min_periods: int = 4) -> tuple[Trend, dict | None]:
    series = [p for p in series if p.complete]
    latest = series[-1].start if series else None
    if len(series) < min_periods:
        return Trend(len(series), None, None, None, latest, False,
                     f"Insufficient data: {len(series)} surveyed quarter(s); at least {min_periods} required."), None
    xs = np.array([decimal_year(p.start) for p in series])
    x0 = xs.mean()
    x = xs - x0
    if float((x ** 2).sum()) == 0:
        return Trend(len(series), None, None, None, latest, False, "All surveys fall in the same period."), None
    y = np.array([float(p.records) for p in series])
    effort = np.array([p.effort_km for p in series])
    if y.sum() == 0:
        return Trend(len(series), None, None, None, latest, False, "No verified detections in any surveyed quarter."), None
    off = np.log(effort)
    beta, cov, mu = _poisson_irls(x, y, off)
    n, k = len(series), 2
    df = n - k
    # Quasi-Poisson: inflate the covariance by the Pearson dispersion (never below 1).
    phi = max(1.0, float((((y - mu) ** 2) / mu).sum() / df)) if df > 0 else 1.0
    cov = cov * phi
    slope, se = float(beta[1]), float(np.sqrt(cov[1, 1]))
    t90 = _t(_T90, df)
    change = float(np.exp(slope) - 1)
    ci = (float(np.exp(slope - t90 * se) - 1), float(np.exp(slope + t90 * se) - 1))
    # Deviance-based pseudo R^2
    with np.errstate(divide="ignore", invalid="ignore"):
        dev = 2 * np.sum(np.where(y > 0, y * np.log(y / mu), 0) - (y - mu))
        mu0 = effort * y.sum() / effort.sum()
        dev0 = 2 * np.sum(np.where(y > 0, y * np.log(y / mu0), 0) - (y - mu0))
    r2 = float(1 - dev / dev0) if dev0 > 0 else 0.0

    t80 = _t(_T80, df)

    def rate_at(xv: float):
        v = np.array([1.0, xv])
        eta = float(v @ beta)
        s = float(np.sqrt(v @ cov @ v))
        return float(np.exp(eta)), float(np.exp(eta - t80 * s)), float(np.exp(eta + t80 * s))

    fc = []
    base = series[-1].start
    for h in range(1, 5):
        qd = add_quarters(base, h)
        r, lo, hi = rate_at(decimal_year(qd) - x0)
        fc.append({"period": quarter_label(qd), "rate": round(r, 4), "lower": round(lo, 4), "upper": round(hi, 4)})
    fitted = [{"period": p.label, "fitted": round(rate_at(decimal_year(p.start) - x0)[0], 4)} for p in series]
    forecast = {
        "metric": "encounter_rate_records_per_km",
        "horizon": "4 quarters",
        "interval": "80% confidence interval for the expected rate",
        "method": "Quasi-Poisson regression of sign counts with survey-effort offset",
        "dispersion": round(phi, 2),
        "points": fc,
        "fitted": fitted,
    }
    return Trend(n, change, ci, round(r2, 3), latest, True, "OK"), forecast


def trend_confidence(trend: Trend, today: date | None = None) -> str:
    if not trend.sufficient or trend.ci90 is None:
        return "insufficient"
    today = today or datetime.now(timezone.utc).date()
    lo, hi = trend.ci90
    excludes_zero = lo > 0 or hi < 0
    width = hi - lo
    stale = trend.latest_period is not None and (today - trend.latest_period).days > 400
    if trend.n_periods >= 8 and excludes_zero and width < 0.6 and not stale:
        return "high"
    if excludes_zero and not stale:
        return "medium"
    return "low"


def series_payload(series: list[Period]) -> list[dict]:
    return [
        {"period": p.label, "start": p.start.isoformat(), "effort_km": p.effort_km, "records": p.records,
         "individuals": p.individuals, "rate": round(p.rate, 4), "pending": p.pending,
         "complete": p.complete}
        for p in series
    ]


def latest_observation_date(db: Session, area_id: int) -> date | None:
    v = db.scalar(select(func.max(Observation.observed_at)).where(Observation.area_id == area_id))
    return v.date() if v else None
