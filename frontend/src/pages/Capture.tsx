import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { activeSession, cancelSession, discard, enqueue, finishSession, onQueueChange, queued, startSession, syncNow, type QueuedObservation, type SurveySession } from "../lib/offline";
import { useApi } from "../lib/useApi";
import type { Area } from "../lib/types";
import { humanize } from "../lib/format";
import { ErrorBox, toast } from "../components/ui";

const EVIDENCE = ["nest", "direct_sighting", "vocalisation", "feeding_sign", "dung", "footprint", "tool_use", "camera_trap"];
const PRESSURES = ["agriculture", "logging", "charcoal", "mining", "snare", "hunting", "fire", "settlement", "road", "other"];

function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function useGps() {
  const [pos, setPos] = useState<{ lat: number; lon: number; acc: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locate = () => {
    if (!navigator.geolocation) { setErr("This device has no GPS. Enter coordinates by hand."); return; }
    setBusy(true); setErr(null);
    navigator.geolocation.getCurrentPosition(
      (p) => { setPos({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) }); setBusy(false); },
      (e) => { setErr(e.code === 1 ? "Location permission was denied. Allow it in your browser settings or enter coordinates by hand." : "Could not get a GPS fix. Move to open sky and try again."); setBusy(false); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  };
  return { pos, setPos, err, busy, locate };
}

export default function Capture() {
  const [mode, setMode] = useState<"chimp" | "pressure">("chimp");
  const [queue, setQueue] = useState<QueuedObservation[]>([]);
  const [session, setSession] = useState<SurveySession | null>(activeSession());
  useEffect(() => {
    const r = () => { void queued().then(setQueue); setSession(activeSession()); };
    r();
    const un = onQueueChange(r);
    return () => { un(); };
  }, []);
  const heldBySession = session ? queue.filter((q) => q.payload.survey_client_uuid === session.client_uuid).length : 0;

  return (
    <div className="capture">
      <header className="page-head">
        <div>
          <h1>Add a record</h1>
          <p>Works without signal. Records are saved on this device and sent automatically when you are back online.</p>
        </div>
      </header>
      <SurveyPanel session={session} recorded={heldBySession} />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === "chimp"} onClick={() => setMode("chimp")}>Chimpanzee sign</button>
        <button role="tab" aria-selected={mode === "pressure"} onClick={() => setMode("pressure")}>Human pressure</button>
      </div>
      {queue.length > 0 && (
        <div className="queue stack" style={{ gap: 8, marginBottom: 16 }}>
          <div className="spread"><b>{queue.length} record{queue.length > 1 ? "s" : ""} waiting to send{heldBySession ? ` (${heldBySession} held until the survey ends)` : ""}</b>
            <button className="btn" onClick={async () => { const r = await syncNow(); toast(r.sent ? `Sent ${r.sent} record${r.sent > 1 ? "s" : ""}` : navigator.onLine ? "Nothing sent — see errors below" : "Still offline"); }}>Send now</button></div>
          {queue.filter((q) => q.last_error).map((q) => (
            <div key={q.client_uuid} className="small spread"><span>{humanize(String(q.payload.evidence_type))}, {new Date(String(q.payload.observed_at)).toLocaleString("en-GB")}: {q.last_error}</span>
              <button className="btn ghost" onClick={() => discard(q.client_uuid)}>Discard</button></div>
          ))}
        </div>
      )}
      {mode === "chimp" ? <ChimpForm session={session} /> : <PressureForm />}
    </div>
  );
}

function Coords({ gps, lat, lon, setLat, setLon }: { gps: ReturnType<typeof useGps>; lat: string; lon: string; setLat: (v: string) => void; setLon: (v: string) => void }) {
  useEffect(() => { if (gps.pos) { setLat(gps.pos.lat.toFixed(6)); setLon(gps.pos.lon.toFixed(6)); } }, [gps.pos]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="gps">
        <div style={{ flex: 1 }}>{gps.pos ? <><b>{gps.pos.lat.toFixed(5)}, {gps.pos.lon.toFixed(5)}</b><div className="xs muted">Accuracy ±{gps.pos.acc} m</div></> : <span className="muted small">No position yet</span>}</div>
        <button type="button" className="btn primary" onClick={gps.locate} disabled={gps.busy}>{gps.busy ? "Locating…" : gps.pos ? "Update position" : "Use my position"}</button>
      </div>
      {gps.err && <div className="error-box">{gps.err}</div>}
      <div className="grid2">
        <label className="field">Latitude<input className="input" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} required /></label>
        <label className="field">Longitude<input className="input" inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} required /></label>
      </div>
    </div>
  );
}

function SurveyPanel({ session, recorded }: { session: SurveySession | null; recorded: number }) {
  const areas = useApi<Area[]>("/areas");
  const [open, setOpen] = useState(false);
  const [areaId, setAreaId] = useState("");
  const [method, setMethod] = useState<SurveySession["method"]>("recce");
  const [team, setTeam] = useState("");
  const [km, setKm] = useState("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  if (session) {
    const started = new Date(session.started_at);
    return (
      <section className="survey-live" aria-live="polite">
        <div className="spread" style={{ alignItems: "flex-start" }}>
          <div>
            <div className="live-dot"><i />Survey in progress</div>
            <h2>{session.area_name}</h2>
            <p className="small muted">{humanize(session.method)}{session.team ? ` · ${session.team}` : ""} · started {started.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} · {recorded} sign{recorded === 1 ? "" : "s"} recorded</p>
          </div>
        </div>
        <div className="row" style={{ alignItems: "end", marginTop: 12 }}>
          <label className="field" style={{ flex: "1 1 160px" }}>Distance walked (km)
            <input className="input" inputMode="decimal" value={km} onChange={(e) => setKm(e.target.value)} placeholder="e.g. 4.5" /></label>
          <label className="field" style={{ flex: "2 1 220px" }}>Notes <span className="hint">Optional</span>
            <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Weather, route, team changes" /></label>
        </div>
        {err && <div className="error-box" style={{ marginTop: 10 }}>{err}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={async () => {
            const v = Number(km);
            if (!km || Number.isNaN(v) || v <= 0 || v > 200) { setErr("Enter the distance walked in kilometres (for example 4.5)."); return; }
            setErr(null);
            await finishSession(v, notes);
            toast(navigator.onLine ? "Survey finished and sent" : "Survey finished. It will send when you're online.");
            setKm(""); setNotes("");
          }}>Finish survey</button>
          <button className="btn ghost" onClick={async () => {
            if (window.confirm("Cancel this survey? Signs you recorded are kept as ordinary records.")) { await cancelSession(); toast("Survey cancelled"); }
          }}>Cancel survey</button>
        </div>
        <p className="xs muted" style={{ marginTop: 8 }}>Signs recorded during a survey are linked to it, so the platform can calculate encounter rates per kilometre.</p>
      </section>
    );
  }
  if (!open) {
    return (
      <section className="survey-start">
        <div><b>Walking a transect or recce?</b><p className="small muted">Start a survey so your signs count towards encounter-rate trends.</p></div>
        <button className="btn" onClick={() => setOpen(true)}>Start a survey</button>
      </section>
    );
  }
  return (
    <section className="survey-start open">
      <div className="stack" style={{ gap: 12, width: "100%" }}>
        <b>Start a survey</b>
        <div className="grid2">
          <label className="field">Landscape
            <select className="input" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              <option value="">Choose…</option>{areas.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></label>
          <label className="field">Method
            <select className="input" value={method} onChange={(e) => setMethod(e.target.value as SurveySession["method"])}>
              <option value="recce">Recce walk</option><option value="line_transect">Line transect</option><option value="patrol">Patrol</option>
            </select></label>
        </div>
        <label className="field">Team <span className="hint">Optional</span>
          <input className="input" value={team} onChange={(e) => setTeam(e.target.value)} placeholder="e.g. Team A, 3 people" /></label>
        {err && <div className="error-box">{err}</div>}
        <div className="row">
          <button className="btn primary" onClick={() => {
            const a = areas.data?.find((x) => String(x.id) === areaId);
            if (!a) { setErr(areas.data ? "Choose the landscape you're surveying." : "The landscape list needs a connection the first time. Connect once, then it works offline."); return; }
            startSession({ area_id: a.id, area_name: a.name, method, team });
            toast("Survey started");
          }}>Start survey</button>
          <button className="btn ghost" onClick={() => setOpen(false)}>Not now</button>
        </div>
      </div>
    </section>
  );
}

function ChimpForm({ session }: { session: SurveySession | null }) {
  const gps = useGps();
  const [evidence, setEvidence] = useState("nest");
  const [count, setCount] = useState(1);
  const [when, setWhen] = useState(localNow());
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [err, setErr] = useState<Error | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const la = Number(lat), lo = Number(lon);
    if (!lat || !lon || Number.isNaN(la) || Number.isNaN(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) { setErr(new Error("Enter a valid position, or tap Use my position.")); return; }
    setErr(null);
    const client_uuid = crypto.randomUUID();
    await enqueue({
      client_uuid, photos, queued_at: new Date().toISOString(),
      payload: { evidence_type: evidence, count, observed_at: new Date(when).toISOString(), lat: la, lon: lo,
        gps_accuracy_m: gps.pos?.acc ?? null, notes: notes || null, species: "Pan troglodytes verus", common_name: "Western chimpanzee",
        ...(session ? { survey_client_uuid: session.client_uuid } : {}) },
    });
    const r = await syncNow();
    toast(session ? "Sign saved to this survey" : r.sent ? "Record sent for validation" : "Saved on this device. It will send when you're online.");
    setCount(1); setNotes(""); setPhotos([]); setWhen(localNow());
  };

  return (
    <form className="panel panel-pad stack" onSubmit={submit}>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small" style={{ fontWeight: 560, color: "var(--ink-2)", marginBottom: 6 }}>What did you find?</legend>
        <div className="evidence">{EVIDENCE.map((e) => <button type="button" key={e} aria-pressed={evidence === e} onClick={() => setEvidence(e)}>{humanize(e)}</button>)}</div>
      </fieldset>
      <div className="grid2">
        <label className="field">{evidence === "nest" ? "Number of nests" : "Number of individuals or signs"}
          <input className="input" type="number" min={0} max={500} value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>
        <label className="field">Date and time<input className="input" type="datetime-local" value={when} max={localNow()} onChange={(e) => setWhen(e.target.value)} /></label>
      </div>
      <Coords gps={gps} lat={lat} lon={lon} setLat={setLat} setLon={setLon} />
      <label className="field">Photos <span className="hint">Location data inside photos is removed on upload</span>
        <input className="input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" multiple onChange={(e) => setPhotos(Array.from(e.target.files || []))} /></label>
      <label className="field">Notes<textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Nest age, tree species, group behaviour…" /></label>
      <ErrorBox error={err} />
      <button className="btn primary big">Save record</button>
      <p className="xs muted">Chimpanzee locations are treated as sensitive. Only authorised staff can see precise positions.</p>
    </form>
  );
}

function PressureForm() {
  const gps = useGps();
  const [kind, setKind] = useState("agriculture");
  const [severity, setSeverity] = useState(2);
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [desc, setDesc] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api("/pressures", { method: "POST", json: { kind, severity, lat: Number(lat), lon: Number(lon), description: desc || null, observed_at: new Date().toISOString() } });
      toast("Pressure report sent");
      setDesc("");
    } catch (ex) { setErr(ex as Error); } finally { setBusy(false); }
  };

  return (
    <form className="panel panel-pad stack" onSubmit={submit}>
      <label className="field">Type of pressure
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{PRESSURES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</select></label>
      <div className="field">Severity
        <div className="segmented" role="group">{[[1, "Minor"], [2, "Moderate"], [3, "Severe"]].map(([v, l]) => (
          <button type="button" key={v} aria-pressed={severity === v} onClick={() => setSeverity(Number(v))}>{l}</button>))}</div></div>
      <Coords gps={gps} lat={lat} lon={lon} setLat={setLat} setLon={setLon} />
      <label className="field">Description<textarea className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Area cleared, number of snares, active machinery…" /></label>
      <ErrorBox error={err} />
      <button className="btn primary big" disabled={busy || !lat || !lon}>{busy ? "Sending…" : "Send pressure report"}</button>
      <p className="xs muted">Pressure reports need a connection.</p>
    </form>
  );
}
