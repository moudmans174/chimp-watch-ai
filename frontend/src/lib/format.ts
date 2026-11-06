export const humanize = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) });
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)} days ago`;
  return fmtDate(iso);
}

export const num = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-GB", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const CONFIDENCE_TEXT: Record<string, string> = {
  high: "High confidence", medium: "Moderate confidence", low: "Low confidence", insufficient: "Insufficient data",
};

export const ROLE_TEXT: Record<string, string> = {
  admin: "Administrator", analyst: "Analyst", field_monitor: "Field monitor", viewer: "Viewer",
};
