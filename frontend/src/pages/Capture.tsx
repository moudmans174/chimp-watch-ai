import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { discard, enqueue, onQueueChange, queued, syncNow, type QueuedObservation } from "../lib/offline";
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
  useEffect(() => { const r = () => { void queued().then(setQueue); }; r(); const un = onQueueChange(r); return () => { un(); }; }, []);

  return (
    <div className="capture">
      <header className="page-head">
        <div>
          <h1>Record in the field</h1>
          <p>Works without signal. Records are saved on this device and sent automatically when you are back online.</p>
        </div>
      </header>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === "chimp"} onClick={() => setMode("chimp")}>Chimpanzee sign</button>
        <button role="tab" aria-selected={mode === "pressure"} onClick={() => setMode("pressure")}>Human pressure</button>
      </div>
      {queue.length > 0 && (
        <div className="queue stack" style={{ gap: 8, marginBottom: 16 }}>
          <div className="spread"><b>{queue.length} record{queue.length > 1 ? "s" : ""} waiting to send</b>
            <button className="btn" onClick={async () => { const r = await syncNow(); toast(r.sent ? `Sent ${r.sent} record${r.sent > 1 ? "s" : ""}` : navigator.onLine ? "Nothing sent — see errors below" : "Still offline"); }}>Send now</button></div>
          {queue.filter((q) => q.last_error).map((q) => (
            <div key={q.client_uuid} className="small spread"><span>{humanize(String(q.payload.evidence_type))}, {new Date(String(q.payload.observed_at)).toLocaleString("en-GB")}: {q.last_error}</span>
              <button className="btn ghost" onClick={() => discard(q.client_uuid)}>Discard</button></div>
          ))}
        </div>
      )}
      {mode === "chimp" ? <ChimpForm /> : <PressureForm />}
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

function ChimpForm() {
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
        gps_accuracy_m: gps.pos?.acc ?? null, notes: notes || null, species: "Pan troglodytes verus", common_name: "Western chimpanzee" },
    });
    const r = await syncNow();
    toast(r.sent ? "Record sent for validation" : "Saved on this device. It will send when you're online.");
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
