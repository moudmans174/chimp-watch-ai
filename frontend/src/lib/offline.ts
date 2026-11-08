/* Offline-first field data (IndexedDB).
   - Observations are queued with a client_uuid and synchronised idempotently via POST /observations/sync.
   - Survey sessions: a ranger starts a session, records signs during it, then finishes it with the distance
     walked. The finished survey is sent first (idempotent on its client_uuid); observations that belong to it
     carry survey_client_uuid and are held until their survey has been sent.
   - Photos are kept as blobs and uploaded once the observation has a server id. */
import { createStore, del, entries, get, set } from "idb-keyval";
import { api } from "./api";

const store = createStore("chimpwatch", "outbox");
const surveyStore = createStore("chimpwatch-surveys", "surveys");
const SESSION_KEY = "cw.session.active";

export interface QueuedObservation {
  client_uuid: string;
  payload: Record<string, unknown>;
  photos: Blob[];
  queued_at: string;
  last_error?: string;
}

export interface SurveySession {
  client_uuid: string;
  area_id: number;
  area_name: string;
  method: "line_transect" | "recce" | "patrol";
  team: string;
  started_at: string;
  notes?: string;
}

export interface QueuedSurvey {
  client_uuid: string;
  payload: Record<string, unknown>;
  sent: boolean;
  last_error?: string;
}

// ---------------------------------------------------------------- active session (this device)
export function activeSession(): SurveySession | null {
  try { const s = localStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function startSession(s: Omit<SurveySession, "client_uuid" | "started_at">): SurveySession {
  const session: SurveySession = { ...s, client_uuid: crypto.randomUUID(), started_at: new Date().toISOString() };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* ignore */ }
  notify();
  return session;
}
export async function finishSession(effortKm: number, notes?: string) {
  const s = activeSession();
  if (!s) return;
  const today = new Date().toISOString().slice(0, 10);
  await set(s.client_uuid, {
    client_uuid: s.client_uuid, sent: false,
    payload: { client_uuid: s.client_uuid, area_id: s.area_id, method: s.method, team: s.team || null,
      start_date: s.started_at.slice(0, 10), end_date: today, effort_km: effortKm, notes: notes || s.notes || null },
  } satisfies QueuedSurvey, surveyStore);
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  notify();
  void syncNow();
}
export async function cancelSession() {
  const s = activeSession();
  if (!s) return;
  // records made during a cancelled session are kept, but detached from the survey
  for (const item of await queued()) {
    if (item.payload.survey_client_uuid === s.client_uuid) {
      const { survey_client_uuid: _drop, ...rest } = item.payload;
      void _drop;
      await set(item.client_uuid, { ...item, payload: rest }, store);
    }
  }
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  notify();
}

// ---------------------------------------------------------------- queues
export async function enqueue(item: QueuedObservation) {
  await set(item.client_uuid, item, store);
  notify();
}
export async function queued(): Promise<QueuedObservation[]> {
  return (await entries<string, QueuedObservation>(store)).map(([, v]) => v);
}
export async function queuedSurveys(): Promise<QueuedSurvey[]> {
  return (await entries<string, QueuedSurvey>(surveyStore)).map(([, v]) => v);
}

const listeners = new Set<() => void>();
export function onQueueChange(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function notify() { listeners.forEach((f) => f()); }

let syncing = false;
export async function syncNow(): Promise<{ sent: number; failed: number; held: number }> {
  if (syncing || !navigator.onLine) return { sent: 0, failed: 0, held: 0 };
  syncing = true;
  let sent = 0, failed = 0, held = 0;
  try {
    // 1. finished surveys first
    const sentSurveys = new Set<string>();
    for (const sv of await queuedSurveys()) {
      if (sv.sent) { sentSurveys.add(sv.client_uuid); continue; }
      try {
        await api("/surveys", { method: "POST", json: sv.payload });
        await set(sv.client_uuid, { ...sv, sent: true, last_error: undefined }, surveyStore);
        sentSurveys.add(sv.client_uuid);
      } catch (e) {
        await set(sv.client_uuid, { ...sv, last_error: (e as Error).message }, surveyStore);
        if ((e as { status?: number }).status === 0) return { sent, failed, held };
      }
    }
    // 2. observations whose survey (if any) has been sent
    const active = activeSession()?.client_uuid;
    const items = await queued();
    const ready = items.filter((i) => {
      const s = i.payload.survey_client_uuid as string | undefined;
      if (!s) return true;
      if (s === active || !sentSurveys.has(s)) { held++; return false; }
      return true;
    });
    if (ready.length) {
      const res = await api<{ results: { client_uuid: string; id?: number; status: string; detail?: string }[] }>(
        "/observations/sync", { method: "POST", json: ready.map((i) => ({ ...i.payload, client_uuid: i.client_uuid })) },
      );
      for (const r of res.results) {
        const item = await get<QueuedObservation>(r.client_uuid, store);
        if (!item) continue;
        if ((r.status === "created" || r.status === "duplicate") && r.id) {
          let photoError = false;
          for (const blob of item.photos) {
            const fd = new FormData();
            fd.append("file", blob, "photo.jpg");
            try { await api(`/observations/${r.id}/media`, { method: "POST", body: fd }); } catch { photoError = true; }
          }
          if (photoError) {
            await set(r.client_uuid, { ...item, photos: [], last_error: "Saved, but a photo failed to upload" }, store);
            failed++;
          } else {
            await del(r.client_uuid, store);
            sent++;
          }
        } else {
          await set(r.client_uuid, { ...item, last_error: r.detail || "Rejected by server" }, store);
          failed++;
        }
      }
    }
    // 3. forget surveys whose observations have all gone
    const remaining = new Set((await queued()).map((i) => i.payload.survey_client_uuid as string | undefined));
    for (const sv of await queuedSurveys()) if (sv.sent && !remaining.has(sv.client_uuid)) await del(sv.client_uuid, surveyStore);
  } catch {
    failed++;
  } finally {
    syncing = false;
    notify();
  }
  return { sent, failed, held };
}

export async function discard(uuid: string) { await del(uuid, store); notify(); }

export function startAutoSync() {
  window.addEventListener("online", () => { void syncNow(); });
  setInterval(() => { void syncNow(); }, 60_000);
  void syncNow();
}
