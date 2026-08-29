// Redzone – reine Aufbereitung eines Roh-Runs + Meal-Code-Auflösung.
// Kein React/State hier, damit sowohl RedzoneProvider/RedzoneLiveView als auch
// die Backfill-Rückstandsrechnung (features/backfills/redzoneShortfall.ts)
// dieselbe Logik nutzen.
import type { DataBundle } from "../../core/types";
import type { PlatingRunDisplay, RedzoneRun } from "./redzoneTypes";

export function extractMealCode(name: string): string | null {
  const match = String(name ?? "").match(/\b(F[A-Z]\d{4}[A-Z])\b/);
  return match ? match[1] : null;
}

function durationMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return ms > 0 ? Math.round(ms / 60_000) : null;
}

export function enrichRun(run: RedzoneRun): PlatingRunDisplay {
  // Ovens/Braisers melden outCount praktisch nie (immer 0) — dort ist endTime
  // das einzig verlässliche Signal. Für Plating zählt zusätzlich "noch kein
  // Output", weil ein Run dort schon vor dem ersten gezählten Stück beginnt.
  const isActive = run.areaName === "Plating"
    ? run.endTime === null || run.outCount === 0 || run.outCount === null
    : run.endTime === null;
  return {
    ...run,
    status: isActive ? "active" : "completed",
    mealCode: extractMealCode(run.productTypeName),
    durationMin: durationMinutes(run.startTime, run.endTime),
  };
}

const norm = (s: string): string => String(s ?? "").trim().toUpperCase();

// Redzone liefert productTypeName als Freitext ("FV4039A - Salmon …") und
// productTypeSKU oft als MSKU statt als Rezept-Code. Auflösung: erst der schon
// per Regex extrahierte mealCode (wenn er ein echtes Rezept ist), sonst die
// MSKU → Rezept-Code, sonst der rohe mealCode. Gibt einen Resolver zurück,
// damit die Indizes nur einmal gebaut werden.
export function buildRedzoneCodeResolver(
  data: DataBundle | null | undefined,
): (run: { mealCode: string | null; productTypeSKU: string }) => string | null {
  const codeSet = new Set<string>();
  const mskuToCode = new Map<string, string>();
  for (const [code, recipe] of Object.entries(data?.recipes ?? {})) {
    codeSet.add(norm(code));
    for (const market of ["DE", "BENL", "DKSE"] as const) {
      const msku = recipe.markets?.[market]?.msku;
      if (msku) mskuToCode.set(norm(msku), norm(code));
    }
  }
  return (run) => {
    if (run.mealCode && codeSet.has(norm(run.mealCode))) return norm(run.mealCode);
    const bySku = run.productTypeSKU ? mskuToCode.get(norm(run.productTypeSKU)) : undefined;
    if (bySku) return bySku;
    return run.mealCode ? norm(run.mealCode) : null;
  };
}
