import { humanize, num } from "../lib/format";

/** Ranked horizontal bars for a small categorical breakdown (one series, so no legend). */
export default function BarList({ data, label = humanize, unit = "", max = 8 }: {
  data: Record<string, number> | [string, number][]; label?: (k: string) => string; unit?: string; max?: number;
}) {
  const rows = (Array.isArray(data) ? data : Object.entries(data)).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const shown = rows.slice(0, max);
  const rest = rows.slice(max).reduce((t, [, v]) => t + v, 0);
  if (rest) shown.push(["Other", rest]);
  const top = Math.max(1, ...shown.map(([, v]) => v));
  if (!shown.length) return <p className="small muted">Nothing recorded in this period.</p>;
  return (
    <ul className="barlist">
      {shown.map(([k, v]) => (
        <li key={k} title={`${label(k)}: ${num(v)}${unit}`}>
          <span className="barlist-label">{k === "Other" ? "Other" : label(k)}</span>
          <span className="barlist-track"><span className="barlist-fill" style={{ width: `${(v / top) * 100}%` }} /></span>
          <span className="barlist-val">{num(v)}{unit}</span>
        </li>
      ))}
    </ul>
  );
}
