from datetime import date

from app.models import AlertLevel, AlertThreshold
from app.services.analytics import Period, add_quarters, fit_trend, trend_confidence
from app.services.risk import level_for


def _series(rates, start=date(2023, 1, 1), pending=None):
    out = []
    for i, r in enumerate(rates):
        q = add_quarters(start, i)
        out.append(Period(q, f"Q{i}", 40.0, int(r * 40), int(r * 40), r, (pending or {}).get(i, 0)))
    return out


def test_declining_trend_detected_with_ci():
    rates = [0.6 * (0.8 ** (i / 4)) for i in range(12)]
    trend, fc = fit_trend(_series(rates))
    assert trend.sufficient
    assert -0.22 < trend.annual_change < -0.18
    assert trend.ci90[1] < 0
    assert len(fc["points"]) == 4 and all(p["lower"] <= p["rate"] <= p["upper"] for p in fc["points"])
    assert trend_confidence(trend, today=date(2026, 1, 15)) == "high"


def test_insufficient_data_is_not_scored():
    trend, fc = fit_trend(_series([0.5, 0.4]))
    assert not trend.sufficient and fc is None
    assert trend_confidence(trend) == "insufficient"


def test_quarters_with_incomplete_validation_are_excluded():
    rates = [0.5] * 8 + [0.05]
    trend, _ = fit_trend(_series(rates, pending={8: 30}))
    assert trend.n_periods == 8 and abs(trend.annual_change) < 0.01


def test_stale_data_lowers_confidence():
    rates = [0.6 * (0.8 ** (i / 4)) for i in range(12)]
    trend, _ = fit_trend(_series(rates))
    assert trend_confidence(trend, today=date(2029, 1, 1)) == "low"


def test_low_confidence_never_escalates_to_high():
    th = AlertThreshold(indicator="x", medium=40, high=70, enabled=True)
    assert level_for(90, "high", th)[0] == AlertLevel.high
    lvl, note = level_for(90, "low", th)
    assert lvl == AlertLevel.medium and "capped" in note
    assert level_for(50, "low", th)[0] == AlertLevel.medium
    assert level_for(None, "high", th)[0] == AlertLevel.low
    th.enabled = False
    assert level_for(99, "high", th)[0] == AlertLevel.low
