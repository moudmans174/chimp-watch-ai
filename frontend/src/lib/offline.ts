/* Offline-first field capture queue (IndexedDB). Observations are stored locally with a
   client_uuid and synchronised idempotently via POST /observations/sync. Photos are kept
   as blobs and uploaded once the observation has a server id. */
import { createStore, del, entries, get, set } from "idb-keyval";
import { api } from "./api";

const store = createStore("chimpwatch", "outbox");

export interface QueuedObservation {
  client_uuid: string;
  payload: Record<string, unknown>;
  photos: Blob[];
  queued_at: string;
  last_error?: string;
}

export async function enqueue(item: QueuedObservation) {
  await set(item.client_uuid, item, store);
  notify();
}

export async function queued(): Promise<QueuedObservation[]> {
  return (await entries<string, QueuedObservation>(store)).map(([, v]) => v);
}

const listeners = new Set<() => void>();
export function onQueueChange(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { listeners.forEach((f) => f()); }

let syncing = false;
export async function syncNow(): Promise<{ sent: number; failed: number }> {
  if (syncing || !navigator.onLine) return { sent: 0, failed: 0 };
  syncing = true;
  let sent = 0, failed = 0;
  try {
    const items = await queued();
    if (!items.length) return { sent, failed };
    const res = await api<{ results: { client_uuid: string; id?: number; status: string; detail?: string }[] }>(
      "/observations/sync", { method: "POST", json: items.map((i) => ({ ...i.payload, client_uuid: i.client_uuid })) },
    );
    for (const r of res.results) {
      const item = await get<QueuedObservation>(r.client_uuid, store);
      if (!item) continue;
      if ((r.status === "created" || r.status === "duplicate") && r.id) {
        let photoError = false;
        for (const blob of item.photos) {
          const fd = new FormData();
          fd.append("file", blob, "photo.jpg");
          try { await api(`/observations/${r.id}/media`, { method: "POST", body: fd }); }
          catch { photoError = true; }
        }
        if (photoError) {
          await set(r.client_uuid, { ...item, payload: item.payload, last_error: "Saved, but a photo failed to upload" }, store);
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
  } catch {
    failed++;
  } finally {
    syncing = false;
    notify();
  }
  return { sent, failed };
}

export async function discard(uuid: string) { await del(uuid, store); notify(); }

export function startAutoSync() {
  window.addEventListener("online", () => { void syncNow(); });
  setInterval(() => { void syncNow(); }, 60_000);
  void syncNow();
}
