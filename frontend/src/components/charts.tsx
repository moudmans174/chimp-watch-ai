import { useEffect, useMemo, useRef, useState } from "react";

/** Measure the container so SVG text stays at its true pixel size at any width. */
function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}
import type { ForecastPoint, SeriesPoint } from "../lib/types";

const H = 240, M = { t: 14, r: 16, b: 30, l: 44 };

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** Encounter rate per quarter, fitted trend and 4-quarter forecast with 80% prediction interval. */
export function TrendChart({ series, fitted, forecast }: {
  series: SeriesPoint[]; fitted?: { period: string; fitted: number }[]; forecast?: ForecastPoint[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth();
  const labels = useMemo(() => [...series.map((s) => s.period), ...(forecast || []).map((f) => f.period)], [series, forecast]);
  const yMax = niceMax(Math.max(0.01, ...series.map((s) => s.rate), ...(forecast || []).map((f) => f.upper)) * 1.05);
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const x = (i: number) => M.l + (labels.length <= 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = (v: number) => M.t + ih - (v / yMax) * ih;
  const fitMap = new Map((fitted || []).map((f) => [f.period, f.fitted]));
  const n = series.length;
  const line = series.map((s, i) => `${i ? "L" : "M"}${x(i)},${y(s.rate)}`).join("");
  const fitPts = series.map((s, i) => (fitMap.has(s.period) ? [x(i), y(fitMap.get(s.period)!)] : null)).filter(Boolean) as number[][];
  const fc = forecast || [];
  const lastFit = fitPts.length ? fitPts[fitPts.length - 1] : null;
  const fcLine = lastFit ? `M${lastFit[0]},${lastFit[1]}` + fc.map((f, i) => `L${x(n + i)},${y(f.rate)}`).join("") : "";
  const band = fc.length && lastFit
    ? `M${lastFit[0]},${lastFit[1]}` + fc.map((f, i) => `L${x(n + i)},${y(f.upper)}`).join("") +
      [...fc].reverse().map((f, j) => `L${x(n + fc.length - 1 - j)},${y(f.lower)}`).join("") + "Z"
    : "";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * yMax);
  const step = Math.max(1, Math.ceil(labels.length / Math.max(3, Math.floor(W / 80))));
  const tip = hover === null ? null : hover < n
    ? { x: x(hover), y: y(series[hover].rate), text: `${series[hover].period}: ${series[hover].rate.toFixed(2)} records/km · ${series[hover].records} records over ${series[hover].effort_km} km${series[hover].complete ? "" : " · validation incomplete, excluded"}` }
    : { x: x(hover), y: y(fc[hover - n].rate), text: `${fc[hover - n].period} forecast: ${fc[hover - n].rate.toFixed(2)} (80% interval ${fc[hover - n].lower.toFixed(2)}–${fc[hover - n].upper.toFixed(2)})` };

  return (
    <div className="chart-wrap" ref={ref}>
      <svg className="chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Encounter rate by quarter, ${series.length} surveyed quarters${fc.length ? ` with ${fc.length}-quarter forecast` : ""}`}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} />
            <text x={M.l - 8} y={y(t) + 4} textAnchor="end">{t.toFixed(2)}</text>
          </g>
        ))}
        {labels.map((l, i) => (i % step === 0 || i === labels.length - 1) && (
          <text key={l} x={x(i)} y={H - 8} textAnchor="middle">{l}</text>
        ))}
        {band && <path className="band" d={band} />}
        {fitPts.length > 1 && <path className="fit" d={fitPts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join("")} />}
        {fcLine && <path className="fit" d={fcLine} />}
        <path className="series" d={line} />
        {hover !== null && tip && <line className="cross" x1={tip.x} x2={tip.x} y1={M.t} y2={M.t + ih} />}
        {series.map((s, i) => <circle key={s.period} className={`dot ${s.complete ? "" : "excluded"}`} cx={x(i)} cy={y(s.rate)} r={4} />)}
        {labels.map((l, i) => (
          <rect key={`h${l}`} className="hit" x={x(i) - iw / labels.length / 2} y={M.t} width={iw / labels.length} height={ih} onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {tip && <div className="tooltip" style={{ left: `${(tip.x / W) * 100}%`, top: `${(tip.y / H) * 100}%` }}>{tip.text}</div>}
      <div className="chart-key">
        <span><i />Verified records per km</span>
        <span><i className="fit" />Fitted trend &amp; forecast</span>
        {fc.length > 0 && <span><i className="band" />80% interval for expected rate</span>}
        {series.some((s) => !s.complete) && <span>○ Excluded: validation incomplete</span>}
      </div>
    </div>
  );
}

/** Single-series bar chart with per-bar hover. */
export function BarChart({ data, unit, tone = "default", height = 180 }: {
  data: { label: string; value: number }[]; unit: string; tone?: "default" | "loss"; height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth();
  const h = height, iw = W - M.l - M.r, ih = h - M.t - M.b;
  const yMax = niceMax(Math.max(...data.map((d) => d.value), 0.0001));
  const bw = iw / Math.max(data.length, 1);
  const gap = Math.min(6, bw * 0.25);
  const y = (v: number) => M.t + ih - (v / yMax) * ih;
  const step = Math.max(1, Math.ceil(data.length / Math.max(3, Math.floor(W / 70))));
  return (
    <div className="chart-wrap" ref={ref}>
      <svg className="chart" width={W} height={h} viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`Bar chart of ${unit}`} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line className="grid" x1={M.l} x2={W - M.r} y1={y(t * yMax)} y2={y(t * yMax)} />
            <text x={M.l - 8} y={y(t * yMax) + 4} textAnchor="end">{+(t * yMax).toFixed(yMax < 10 ? 1 : 0)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const bx = M.l + i * bw + gap / 2, top = y(d.value), bh = M.t + ih - top;
          const r = Math.min(4, bh, (bw - gap) / 2);
          return (
            <g key={d.label}>
              <path className={`bar ${tone === "loss" ? "loss" : ""}`} opacity={hover === null || hover === i ? 1 : 0.55}
                d={`M${bx},${M.t + ih} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + bw - gap - r} Q${bx + bw - gap},${top} ${bx + bw - gap},${top + r} V${M.t + ih} Z`} />
              {i % step === 0 && <text x={bx + (bw - gap) / 2} y={h - 8} textAnchor="middle">{d.label}</text>}
              <rect className="hit" x={M.l + i * bw} y={M.t} width={bw} height={ih} onMouseEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${((M.l + hover * bw + bw / 2) / W) * 100}%`, top: `${(y(data[hover].value) / h) * 100}%` }}>
          {data[hover].label}: {data[hover].value.toLocaleString("en-GB", { maximumFractionDigits: 2 })} {unit}
        </div>
      )}
    </div>
  );
}
