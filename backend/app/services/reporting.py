"""Grounded natural-language reporting.

Summaries are generated deterministically from approved data and the latest risk
assessment, so every sentence traces to a stored value. Each report states data dates,
model version and uncertainty (proposal §4).
"""
from __future__ import annotations

import html
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Alert, AlertStatus, Observation, ProtectedArea, RiskAssessment, ValidationStatus
from .risk import INDICATORS, OPEN_STATUSES

CONF_WORDS = {"high": "high confidence", "medium": "moderate confidence", "low": "low confidence",
              "insufficient": "insufficient data"}


def area_narrative(area: ProtectedArea, ra: RiskAssessment | None) -> list[str]:
    if ra is None:
        return [f"No risk assessment has been run for {area.name} yet."]
    lines = [
        f"{area.name} ({area.designation}, {area.district} district) is currently assessed at "
        f"{ra.overall_level.value.upper()} overall conservation concern (model {ra.model_version}, "
        f"computed {ra.computed_at:%d %b %Y}, latest input data {ra.data_as_of or 'unknown'})."
    ]
    for key, label in INDICATORS.items():
        c = ra.components.get(key)
        if not c:
            continue
        if c.get("score") is None:
            lines.append(f"{label}: not assessed — {c['drivers'][0] if c['drivers'] else 'no data'}.")
            continue
        basis = "modelled estimate" if c["basis"] == "modelled" else "observed data"
        lines.append(
            f"{label}: {c['level']} (score {c['score']:.0f}/100, {basis}, {CONF_WORDS.get(c['confidence'], c['confidence'])}). "
            + " ".join(c["drivers"][:2])
        )
    fs = ra.components.get("food_security_vulnerability", {})
    if fs.get("caveat"):
        lines.append(fs["caveat"])
    lines.append("These outputs are decision-support evidence. They do not replace field surveys or expert judgement, "
                 "and encounter rates are relative indices, not population counts.")
    return lines


def summary(db: Session, assessments: list[RiskAssessment]) -> dict:
    total_obs = db.scalar(select(func.count(Observation.id))) or 0
    verified = db.scalar(select(func.count(Observation.id)).where(
        Observation.validation_status == ValidationStatus.verified)) or 0
    open_alerts = db.execute(select(Alert.level, func.count()).where(Alert.status.in_(OPEN_STATUSES))
                             .group_by(Alert.level)).all()
    areas = []
    for ra in sorted(assessments, key=lambda r: {"high": 0, "medium": 1, "low": 2}[r.overall_level.value]):
        areas.append({"area": ra.area.name, "area_id": ra.area_id, "level": ra.overall_level.value,
                      "narrative": area_narrative(ra.area, ra)})
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "observations_total": total_obs,
        "observations_verified": verified,
        "open_alerts": {lv.value: n for lv, n in open_alerts},
        "areas": areas,
    }


def summary_html(data: dict, org_name: str) -> str:
    e = html.escape
    rows = "".join(
        f"<section><h2>{e(a['area'])} <span class='lv {e(a['level'])}'>{e(a['level'].upper())}</span></h2>"
        + "".join(f"<p>{e(line)}</p>" for line in a["narrative"]) + "</section>"
        for a in data["areas"]
    )
    oa = data["open_alerts"]
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>CHIMP-WATCH AI situation report</title>
<style>body{{font:14px/1.5 Georgia,serif;max-width:820px;margin:40px auto;padding:0 20px;color:#1d2a22}}
h1{{font-size:24px;margin-bottom:4px}}h2{{font-size:17px;border-top:1px solid #ccd5cf;padding-top:14px}}
.meta{{color:#5b6b61;font-size:12px}}.lv{{font:600 11px sans-serif;padding:2px 8px;border-radius:10px;vertical-align:middle}}
.high{{background:#f6d2cc;color:#8a1f10}}.medium{{background:#f7e6bf;color:#7a5200}}.low{{background:#d6ebdc;color:#1f5a32}}
.kpi{{display:flex;gap:24px;margin:16px 0}}.kpi div{{font:13px sans-serif}}.kpi b{{display:block;font-size:22px}}
@media print{{body{{margin:0}}}}</style></head><body>
<h1>CHIMP-WATCH AI — Situation report</h1>
<div class="meta">Prepared for {e(org_name)} · Generated {e(data['generated_at'][:16].replace('T', ' '))} UTC · Restricted: contains conservation-sensitive information</div>
<div class="kpi"><div><b>{data['observations_verified']}</b>verified observations</div>
<div><b>{oa.get('high', 0)}</b>open high alerts</div><div><b>{oa.get('medium', 0)}</b>open medium alerts</div></div>
{rows}
<p class="meta">Precise chimpanzee locations are excluded from this report. Modelled indicators are estimates with stated
uncertainty; alert thresholds are configured by conservation specialists and should be reviewed regularly.</p>
</body></html>"""
