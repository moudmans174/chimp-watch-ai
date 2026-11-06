import { useState } from "react";
import { api, download, getToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/useApi";
import { fmtDate } from "../lib/format";
import { Empty, ErrorBox, LevelBadge, Loading, toast } from "../components/ui";

interface Summary { generated_at: string; observations_total: number; observations_verified: number; open_alerts: Record<string, number>; areas: { area: string; area_id: number; level: "low" | "medium" | "high"; narrative: string[] }[] }

export default function Reports() {
  const { can } = useAuth();
  const s = useApi<Summary>("/reports/summary");

  const openHtml = async () => {
    const res = await fetch("/api/reports/summary.html", { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) { toast("Could not generate the report"); return; }
    const url = URL.createObjectURL(new Blob([await res.text()], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
  };

  return (
    <>
      <header className="page-head">
        <div><h1>Reports and data</h1><p>Situation reports are generated from verified data and the latest assessment. Precise chimpanzee locations are never included.</p></div>
        <div className="page-actions">
          <button className="btn" onClick={() => download("/exports/observations.csv", "chimpwatch_observations.csv").catch((e) => toast(e.message))}>Export records (CSV)</button>
          <button className="btn primary" onClick={openHtml}>Open printable report</button>
        </div>
      </header>

      <div className="two">
        <section className="panel">
          <div className="panel-head"><h2>Situation summary</h2><span className="sub">{s.data && `Generated ${fmtDate(s.data.generated_at, true)}`}</span></div>
          <ErrorBox error={s.error} />
          {!s.data ? <Loading rows={5} /> : s.data.areas.length ? s.data.areas.map((a) => (
            <div className="comp" key={a.area_id}>
              <h3>{a.area}</h3><LevelBadge level={a.level} />
              <div className="narrative small" style={{ gridColumn: "1/-1" }}>{a.narrative.slice(1, -2).map((l, i) => <p key={i}>{l}</p>)}</div>
            </div>
          )) : <Empty title="No assessments yet" />}
        </section>
        {can("analyst") ? <Imports /> : (
          <section className="panel panel-pad"><h2>Data imports</h2><p className="small muted" style={{ marginTop: 8 }}>Analysts and administrators can import survey, habitat and indicator data.</p></section>
        )}
      </div>
    </>
  );
}

function Imports() {
  const [kind, setKind] = useState("observations");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const upload = async () => {
    if (!file) return;
    setBusy(true); setErrors(null); setMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api<{ imported: number }>(`/imports/${kind}`, { method: "POST", body: fd });
      setMsg(`Imported ${r.imported} rows.${kind === "observations" ? " New records are awaiting validation." : " Run an assessment to update indicators."}`);
    } catch (e) {
      const d = (e as { detail?: { errors?: string[] } }).detail;
      setErrors(d?.errors ?? [(e as Error).message]);
    } finally { setBusy(false); }
  };
  const gbif = async () => {
    setBusy(true); setErrors(null); setMsg(null);
    try {
      const r = await api<{ created: number; skipped: number }>("/integrations/gbif/import?limit=500", { method: "POST" });
      setMsg(`GBIF: ${r.created} new records imported for validation, ${r.skipped} skipped (duplicates or missing coordinates).`);
    } catch (e) { setErrors([(e as Error).message]); } finally { setBusy(false); }
  };

  return (
    <section className="panel panel-pad stack">
      <h2>Import data</h2>
      <p className="small muted">Upload a UTF-8 CSV using the template. Imports are all-or-nothing: if any row fails, nothing is saved and every problem row is listed.</p>
      <label className="field">Data type
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="observations">Observations</option><option value="habitat">Habitat and land-cover metrics</option><option value="indicators">Ecosystem, climate and food-security indicators</option>
        </select>
      </label>
      <button className="btn" onClick={() => download(`/imports/templates/${kind}.csv`, `${kind}_template.csv`)}>Download template</button>
      <label className="field">CSV file<input className="input" type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      <button className="btn primary" disabled={!file || busy} onClick={upload}>{busy ? "Importing…" : "Import file"}</button>
      {msg && <div className="note-box">{msg}</div>}
      {errors && <div className="error-box"><b>Nothing was imported.</b><ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>}
      <hr style={{ border: 0, borderTop: "1px solid var(--line)", width: "100%" }} />
      <h3>GBIF occurrences</h3>
      <p className="small muted">Pull georeferenced chimpanzee occurrences for Sierra Leone from GBIF. Records keep their licence and enter the validation queue.</p>
      <button className="btn" disabled={busy} onClick={gbif}>Import from GBIF</button>
    </section>
  );
}
