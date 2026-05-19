import type { WeekRecipe } from "./types";

export interface RampUpSnapshot {
  ts: string;
  label: string;
  volumes: Record<string, number>; // code → totalVerdenVolume
}

export interface RampUpChangeEvent {
  code: string;
  recipeName: string;
  oldTotal: number;
  newTotal: number;
  delta: number;
  ts: string;
}

const STORAGE_KEY = (week: string) => `rezeptlogik-rampup-history-${week}`;
const MAX_SNAPSHOTS = 30;

function formatLabel(iso: string): string {
  const d = new Date(iso);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day}.${month}. ${hh}:${mm}`;
}

export function getRampUpHistory(week: string): RampUpSnapshot[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY(week));
    if (!raw) return [];
    return JSON.parse(raw) as RampUpSnapshot[];
  } catch {
    return [];
  }
}

export function recordRampUpSnapshot(
  week: string,
  weekRecipes: WeekRecipe[]
): { changes: RampUpChangeEvent[]; history: RampUpSnapshot[] } {
  const relevantRecipes = weekRecipes.filter(r => r.hfWeek === week);
  if (relevantRecipes.length === 0) return { changes: [], history: getRampUpHistory(week) };

  const currentVolumes: Record<string, number> = {};
  const nameMap: Record<string, string> = {};
  for (const r of relevantRecipes) {
    currentVolumes[r.code] = r.totalVerdenVolume;
    nameMap[r.code] = r.recipeName;
  }

  const history = getRampUpHistory(week);
  const lastSnapshot = history[history.length - 1];

  const changes: RampUpChangeEvent[] = [];
  const ts = new Date().toISOString();

  if (lastSnapshot) {
    for (const code of Object.keys(currentVolumes)) {
      const prev = lastSnapshot.volumes[code] ?? 0;
      const curr = currentVolumes[code];
      if (curr !== prev) {
        changes.push({ code, recipeName: nameMap[code] ?? code, oldTotal: prev, newTotal: curr, delta: curr - prev, ts });
      }
    }
    // Detect removed recipes
    for (const code of Object.keys(lastSnapshot.volumes)) {
      if (!(code in currentVolumes)) {
        changes.push({ code, recipeName: nameMap[code] ?? code, oldTotal: lastSnapshot.volumes[code], newTotal: 0, delta: -lastSnapshot.volumes[code], ts });
      }
    }
  }

  const hasChanges = changes.length > 0 || !lastSnapshot;
  if (!hasChanges) return { changes: [], history };

  const newSnapshot: RampUpSnapshot = { ts, label: formatLabel(ts), volumes: currentVolumes };
  const updatedHistory = [...history, newSnapshot].slice(-MAX_SNAPSHOTS);

  try {
    window.localStorage.setItem(STORAGE_KEY(week), JSON.stringify(updatedHistory));
  } catch {
    // localStorage quota exceeded – silently ignore
  }

  return { changes, history: updatedHistory };
}
