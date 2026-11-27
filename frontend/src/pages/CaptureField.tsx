import { useEffect, useRef, useState, type FormEvent } from "react";
import { enqueueJob } from "../lib/offline";
import { useApi } from "../lib/useApi";
import { humanize } from "../lib/format";
import type { Meta } from "../lib/types";
import { ErrorBox, toast } from "../components/ui";

// ------------------------------------------------------------------ geometry helpers
type Pt = [number, number, number]; // lon, lat, epoch ms
export function metres(a: [number, number], b: [number, number]) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const trackKm = (pts: Pt[]) => pts.reduce((t, p, i) => (i ? t + metres([pts[i - 1][0], pts[i - 1][1]], [p[0], p[1]]) : 0), 0) / 1000;

/** Reads track points from a GPX file (trkpt, falling back to rtept). */
export function parseGpx(xml: string): Pt[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("That file isn't valid GPX.");
  let nodes = Array.from(doc.getElementsByTagName("trkpt"));
  if (!nodes.length) nodes = Array.from(doc.getElementsByTagName("rtept"));
  const pts: Pt[] = [];
  for (const n of nodes) {
    const lat = Number(n.getAttribute("lat")), lon = Number(n.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const t = n.getElementsByTagName("time")[0]?.textContent;
    pts.push([lon, lat, t ? Date.parse(t) : NaN]);
  }
  if (pts.length < 2) throw new Error("The file has fewer than two track points.");
  return pts;
}

// ------------------------------------------------------------------ patrol recorder
const KEY = "cw.patrol.active";
const MIN_STEP_M = 20;      // ignore GPS jitter below this
const MAX_ACC_M = 50;       // ignore fixes worse than this
interface Active { client_uuid: string; started_at: string; team: string; purpose: string; points: Pt[] }
const load = (): Active | null => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } };
const save = (a: Active | null) => { try { a ? localStorage.setItem(KEY, JSON.stringify(a)) : localStorage.removeItem(KEY); } catch { /* storage full */ } };
const PURPOSES = ["monitoring", "law_enforcement", "survey", "community", "other"];

export function PatrolForm() {
  const [active, setActive] = useState<Active | null>(load());
  const [team, setTeam] = useState(active?.team ?? "");
  const [purpose, setPurpose] = useState(active?.purpose ?? "monitoring");
  const [notes, setNotes] = useState("");
  const [fix, setFix] = useState<{ acc: number; at: number } | null>(null);
  const [gpsErr, setGpsErr] = useState<string | null>(null);
  const [, tick] = useState(0);
  const watch = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    if (!navigator.geolocation) { setGpsErr("This device has no GPS. Import a GPX file instead."); return; }
    watch.current = navigator.geolocation.watchPosition((p) => {
      setGpsErr(null);
      setFix({ acc: Math.round(p.coords.accuracy), at: Date.now() });
      if (p.coords.accuracy > MAX_ACC_M) return;
      const pt: Pt = [Number(p.coords.longitude.toFixed(6)), Number(p.coords.latitude.toFixed(6)), p.timestamp];
      setActive((cur) => {
        if (!cur) return cur;
        const last = cur.points[cur.points.length - 1];
        if (last && metres([last[0], last[1]], [pt[0], pt[1]]) < MIN_STEP_M) return cur;
        const next = { ...cur, points: [...cur.points, pt] };
        save(next);
        return next;
      });
    }, (e) => setGpsErr(e.code === 1 ? "Location permission was denied. Allow it in your browser settings." : "Waiting for a GPS fix. Move to open sky."),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    const t = window.setInterval(() => tick((n) => n + 1), 15000);
    return () => { if (watch.current != null) navigator.geolocation.clearWatch(watch.current); window.clearInterval(t); };
  }, [active?.client_uuid]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => {
    const a: Active = { client_uuid: crypto.randomUUID(), started_at: new Date().toISOString(), team, purpose, points: [] };
    save(a); setActive(a);
  };
  const finish = async () => {
    if (!active) return;
    if (active.points.length < 2) { toast("Not enough GPS points yet. Walk a little further, or cancel."); return; }
    await enqueueJob("/patrols", `Patrol, ${trackKm(active.points).toFixed(1)} km`, {
      client_uuid: active.client_uuid, started_at: active.started_at, ended_at: new Date().toISOString(),
      team: team || null, purpose, notes: notes || null, source: "app", points: active.points.map(([lon, lat]) => [lon, lat]),
    });
    save(null); setActive(null); setNotes(""); setFix(null);
    toast("Patrol saved. It will send when you're online.");
  };
  const cancel = () => { if (confirmCancel()) { save(null); setActive(null); setFix(null); } };

  if (active) {
    const mins = Math.round((Date.now() - Date.parse(active.started_at)) / 60000);
    return (
      <section className="panel panel-pad stack">
        <div className="survey-live">
          <span className="live-dot" aria-hidden />
          <div style={{ flex: 1 }}>
            <b>Patrol in progress</b>
            <div className="small">{trackKm(active.points).toFixed(2)} km · {active.points.length} points · {Math.floor(mins / 60)}h {mins % 60}m</div>
            <div className="xs muted">{fix ? `GPS ±${fix.acc} m${fix.acc > MAX_ACC_M ? " (too weak, point skipped)" : ""}` : "Waiting for GPS…"}</div>
          </div>
        </div>
        {gpsErr && <div className="error-box">{gpsErr}</div>}
        <p className="xs muted">Keep this page open with the screen on. Most phones stop GPS when the browser is in the background. The track is saved on the phone as you walk.</p>
        <label className="field">Team <span className="hint">Optional</span><input className="input" value={team} onChange={(e) => setTeam(e.target.value)} /></label>
        <label className="field">Notes <span className="hint">Optional</span><textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Weather, route, anything seen" /></label>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary big" onClick={finish}>Finish patrol</button>
          <button className="btn ghost" onClick={cancel}>Cancel</button>
        </div>
      </section>
    );
  }
  return (
    <div className="stack">
      <section className="panel panel-pad stack">
        <h2>Record with this phone</h2>
        <div className="row" style={{ alignItems: "end" }}>
          <label className="field" style={{ flex: 1 }}>Team <span className="hint">Optional</span><input className="input" value={team} onChange={(e) => setTeam(e.target.value)} placeholder="e.g. Kambui north team" /></label>
          <label className="field" style={{ flex: 1 }}>Purpose<select className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)}>{PURPOSES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</select></label>
        </div>
        <button className="btn primary big" onClick={start}>Start patrol</button>
        <p className="xs muted">Positions are logged every {MIN_STEP_M} m or more. Works without signal.</p>
      </section>
      <GpxImport team={team} purpose={purpose} />
    </div>
  );
}
function confirmCancel() {
  // A styled confirm would be nicer; window.confirm keeps the destructive step explicit and works offline.
  return window.confirm("Discard this patrol track? This can't be undone.");
}

function GpxImport({ team, purpose }: { team: string; purpose: string }) {
  const [pts, setPts] = useState<Pt[] | null>(null);
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const read = async (f: File | undefined) => {
    setErr(null); setPts(null);
    if (!f) return;
    try {
      const p = parseGpx(await f.text());
      setPts(p); setName(f.name);
      const times = p.map((x) => x[2]).filter(Number.isFinite);
      const toLocal = (ms: number) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
      setStart(times.length ? toLocal(Math.min(...times)) : "");
      setEnd(times.length ? toLocal(Math.max(...times)) : "");
    } catch (e) { setErr((e as Error).message); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pts) return;
    const s = new Date(start), en = new Date(end);
    if (!(en > s)) { setErr("The end time must be after the start time."); return; }
    await enqueueJob("/patrols", `GPX ${name}`, {
      started_at: s.toISOString(), ended_at: en.toISOString(), team: team || null, purpose, source: "gpx",
      notes: `Imported from ${name}`, points: pts.map(([lon, lat]) => [lon, lat]),
    });
    toast("GPX patrol queued"); setPts(null); setName("");
  };
  return (
    <form className="panel panel-pad stack" onSubmit={submit}>
      <h2>Import a GPX track</h2>
      <p className="small muted">From a handheld GPS (Garmin and similar) or another tracking app.</p>
      <input className="input" type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml" onChange={(e) => read(e.target.files?.[0])} />
      {err && <div className="error-box">{err}</div>}
      {pts && (
        <>
          <p className="small"><b>{pts.length}</b> points, <b>{trackKm(pts).toFixed(2)} km</b></p>
          <div className="row" style={{ alignItems: "end" }}>
            <label className="field" style={{ flex: 1 }}>Started<input className="input" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="field" style={{ flex: 1 }}>Ended<input className="input" type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          </div>
          <button className="btn primary">Save imported patrol</button>
        </>
      )}
    </form>
  );
}

// ------------------------------------------------------------------ wildlife conflict
function localNow() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }

export function ConflictForm() {
  const meta = useApi<Meta>("/meta");
  const species = meta.data?.conflict_species ?? ["chimpanzee", "elephant", "baboon", "monkey", "bush_pig", "porcupine", "cane_rat", "leopard", "other"];
  const kinds = meta.data?.conflict_kinds ?? ["crop_raiding", "property_damage", "livestock_loss", "human_injury", "wildlife_injured", "wildlife_killed", "other"];
  const blank = { occurred_at: localNow(), species: "chimpanzee", kind: "crop_raiding", community: "", crops: "", area_damaged_ha: "", loss_estimate_le: "", people_affected: "", description: "", reporter_name: "", reporter_phone: "", lat: "", lon: "" };
  const [f, setF] = useState(blank);
  const [gps, setGps] = useState<{ busy: boolean; err: string | null; acc?: number }>({ busy: false, err: null });
  const [err, setErr] = useState<Error | null>(null);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const n = (v: string) => (v === "" ? null : Number(v));
  const locate = () => {
    if (!navigator.geolocation) { setGps({ busy: false, err: "No GPS on this device. Enter coordinates by hand." }); return; }
    setGps({ busy: true, err: null });
    navigator.geolocation.getCurrentPosition(
      (p) => { setF((x) => ({ ...x, lat: p.coords.latitude.toFixed(6), lon: p.coords.longitude.toFixed(6) })); setGps({ busy: false, err: null, acc: Math.round(p.coords.accuracy) }); },
      (e) => setGps({ busy: false, err: e.code === 1 ? "Location permission was denied." : "Couldn't get a GPS fix. Try again in the open." }),
      { enableHighAccuracy: true, timeout: 20000 });
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    const when = new Date(f.occurred_at);
    if (when.getTime() > Date.now() + 60000) { setErr(new Error("The date can't be in the future.")); return; }
    await enqueueJob("/conflicts", `${humanize(f.kind)}, ${f.community || "no community"}`, {
      occurred_at: when.toISOString(), lat: Number(f.lat), lon: Number(f.lon), species: f.species, kind: f.kind,
      community: f.community || null, crops: f.crops || null, area_damaged_ha: n(f.area_damaged_ha), loss_estimate_le: n(f.loss_estimate_le),
      people_affected: n(f.people_affected), description: f.description || null, reporter_name: f.reporter_name || null, reporter_phone: f.reporter_phone || null,
    });
    toast("Incident saved. It will send when you're online.");
    setF({ ...blank, occurred_at: localNow() });
  };
  const crop = f.kind === "crop_raiding";
  return (
    <form className="panel panel-pad stack" onSubmit={submit}>
      <div className="row" style={{ alignItems: "end" }}>
        <label className="field" style={{ flex: 1 }}>What happened<select className="input" value={f.kind} onChange={set("kind")}>{kinds.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select></label>
        <label className="field" style={{ flex: 1 }}>Animal<select className="input" value={f.species} onChange={set("species")}>{species.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select></label>
      </div>
      <div className="row" style={{ alignItems: "end" }}>
        <label className="field" style={{ flex: 1 }}>When<input className="input" type="datetime-local" required max={localNow()} value={f.occurred_at} onChange={set("occurred_at")} /></label>
        <label className="field" style={{ flex: 1 }}>Community or village<input className="input" value={f.community} onChange={set("community")} /></label>
      </div>
      <div className="gps">
        <div style={{ flex: 1 }}>{f.lat && f.lon ? <><b>{Number(f.lat).toFixed(5)}, {Number(f.lon).toFixed(5)}</b>{gps.acc != null && <div className="xs muted">Accuracy ±{gps.acc} m</div>}</> : <span className="muted small">Where it happened: the farm or site</span>}</div>
        <button type="button" className="btn primary" onClick={locate} disabled={gps.busy}>{gps.busy ? "Locating…" : "Use my position"}</button>
      </div>
      {gps.err && <div className="error-box">{gps.err}</div>}
      <div className="grid2">
        <label className="field">Latitude<input className="input" inputMode="decimal" required value={f.lat} onChange={set("lat")} /></label>
        <label className="field">Longitude<input className="input" inputMode="decimal" required value={f.lon} onChange={set("lon")} /></label>
      </div>
      {crop && <label className="field">Crops damaged<input className="input" value={f.crops} onChange={set("crops")} placeholder="Cassava, rice, banana…" /></label>}
      <div className="row" style={{ alignItems: "end" }}>
        {crop && <label className="field" style={{ flex: 1 }}>Area damaged (ha)<input className="input" type="number" min={0} step="0.01" value={f.area_damaged_ha} onChange={set("area_damaged_ha")} /></label>}
        <label className="field" style={{ flex: 1 }}>Estimated loss (Le)<input className="input" type="number" min={0} value={f.loss_estimate_le} onChange={set("loss_estimate_le")} /></label>
        <label className="field" style={{ flex: 1 }}>People affected<input className="input" type="number" min={0} value={f.people_affected} onChange={set("people_affected")} /></label>
      </div>
      <label className="field">Description <span className="hint">Optional</span><textarea className="input" value={f.description} onChange={set("description")} placeholder="How many animals, time of day, what the farmer did" /></label>
      <div className="row" style={{ alignItems: "end" }}>
        <label className="field" style={{ flex: 1 }}>Reported by <span className="hint">Optional, seen only by analysts</span><input className="input" value={f.reporter_name} onChange={set("reporter_name")} /></label>
        <label className="field" style={{ flex: 1 }}>Phone <span className="hint">Optional</span><input className="input" type="tel" value={f.reporter_phone} onChange={set("reporter_phone")} /></label>
      </div>
      <ErrorBox error={err} />
      <button className="btn primary big" disabled={!f.lat || !f.lon}>Save incident</button>
      <p className="xs muted">Saved on this phone and sent automatically when you have signal.</p>
    </form>
  );
}
