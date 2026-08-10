// WMS Übersicht – Bilanz-Snapshots (localStorage-Persistenz für Vergleiche).
import type { SkuBilanzEntry } from "./wmsAggregate";

// ─── Snapshot System ─────────────────────────────────────────────────────────

export const SNAPSHOT_KEY = "wms-snapshots-v2";
export const MAX_SNAPSHOTS = 15;

export type WmsSnapshot = {
  id: string;
  week: string;
  timestamp: string;
  label: string;
  bilanz: SkuBilanzEntry[];
};

export function loadSnapshots(): WmsSnapshot[] {
  try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "[]") as WmsSnapshot[]; }
  catch { return []; }
}

export function persistSnapshot(week: string, bilanz: SkuBilanzEntry[]): void {
  const snap: WmsSnapshot = {
    id: String(Date.now()),
    week,
    timestamp: new Date().toISOString(),
    label: `${week} · ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`,
    bilanz,
  };
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify([snap, ...loadSnapshots()].slice(0, MAX_SNAPSHOTS))); }
  catch (_e) { /* localStorage not available or quota exceeded */ }
}

export function removeSnapshot(id: string): void {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(loadSnapshots().filter(s => s.id !== id))); }
  catch (_e) { /* localStorage not available */ }
}

