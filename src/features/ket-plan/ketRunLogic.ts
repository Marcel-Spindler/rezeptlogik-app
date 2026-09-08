// Schicht- und Run-Modell für KET Plan / WO — beide "später zuschaltbar"
// (Marcel, 2026-08-21), unabhängig voneinander:
//
// SCHICHT ist ein reines Uhrzeit-Fenster (Frühschicht 06-14 Uhr, Spätschicht
// 14-22 Uhr) und kommt 1:1 aus der Zahl hinter dem Datum in "Date Needed"
// (z.B. "2026-08-18 - 1" → Schicht 1 → Frühschicht). Bestätigt von Marcel:
// diese Zahl ist wirklich die Schicht, nicht der Run (Rundmail nennt dieselbe
// Rohspalte fälschlich "Run" — das ist ein bekanntes, separates Problem dort,
// hier NICHT übernehmen).
//
// RUN hat mit der Schicht nichts zu tun. Ein Meal mit sehr hohem
// Portionen-Aufkommen wird über die Woche verteilt mehrfach produziert — Run 1
// deckt immer ~70% des Wochenvolumens dieses Meals ab, Run 2 den Rest, je nach
// Forecast. Run 1 und Run 2 können an komplett unterschiedlichen Tagen UND
// Schichten liegen (Beispiel Marcel: "Run 1 am Montag in der Spätschicht,
// Run 2 des Meals am Donnerstag früh"). Die reale Zuteilung wird an anderer
// Stelle geplant (Plating-Plan: firstRunPct-Regler, Default 70 %; Kochplan
// leitet die Küchentage daraus ab). KET-Plan bekommt davon aktuell keinen
// verlässlichen Wert durchgereicht
// (WorkOrderEntry.run existiert, ist in der Praxis aber lückenhaft: nur 0/1,
// nie explizit 2). Diese Funktion SCHÄTZT die Run-Zuteilung daher selbst rein
// aus den KET-Zeilen (kumulierte Ziel-Portionen je Tag, chronologisch) — klar
// als Schätzung zu behandeln, nicht als WMS-Fakt.

import type { KetRow } from "./ketTypes";
import { parseDateShift, parseSortKey } from "./ketLogic";

// ── Schicht ──────────────────────────────────────────────────────────────

export interface ShiftWindow {
  label: string;
  start: string; // "06:00"
  end: string;   // "14:00"
}

// Nur die zwei aktuell bestätigten Fenster — weitere Schichten (z.B. eine
// Nachtschicht) ergänzen, sobald Marcel sie bestätigt, nicht raten.
export const SHIFT_WINDOWS: Record<string, ShiftWindow> = {
  "1": { label: "Frühschicht", start: "06:00", end: "14:00" },
  "2": { label: "Spätschicht", start: "14:00", end: "22:00" },
};

export function shiftWindow(shift: string): ShiftWindow | null {
  return SHIFT_WINDOWS[shift.trim()] ?? null;
}

// "Frühschicht (06:00–14:00 Uhr)" — null bei unbekannter Schichtnummer (z.B.
// eine dritte Schicht, die es laut Marcel aktuell nicht gibt).
export function shiftLabel(shift: string): string | null {
  const w = shiftWindow(shift);
  return w ? `${w.label} (${w.start}–${w.end} Uhr)` : null;
}

// ── Run ──────────────────────────────────────────────────────────────────

export const DEFAULT_FIRST_RUN_PCT = 70;

export interface RunInfo {
  run: 1 | 2;
  // Anteil (0..1) des Wochenvolumens dieses Meals, der bis EINSCHLIESSLICH
  // diesem Tag kumuliert erreicht ist — für eine Tooltip-Erklärung in der UI.
  cumulativeSharePct: number;
  // true, wenn das Meal an mehreren Tagen dieser Woche produziert wird (nur
  // dann ist eine Run-Aufteilung überhaupt sinnvoll) — bei nur einem
  // Produktionstag ist alles automatisch "Run 1", aber ohne echten Split.
  isSplit: boolean;
}

// Schätzt Run 1 / Run 2 je (recipeCode, Tag)-Gruppe der übergebenen Zeilen:
// läuft je Meal (recipeCode) chronologisch durch seine Produktionstage in DER
// woche und kumuliert die Ziel-Portionen (pro Tag: höchster targetPortions-
// Wert unter den Sub-Rezept-Zeilen dieses Tages — die tragen für dasselbe
// Meal denselben Zielwert, nicht aufsummieren). Sobald die kumulierte Menge
// VOR einem Tag bereits firstRunPct % des Wochentotals erreicht hat, gilt
// dieser Tag (und alle folgenden) als Run 2. Alle Sub-Rezept-Zeilen eines
// Tages erben denselben Run — ein Run ist meal- und tagesweit, nicht pro
// Sub-Rezept.
export function computeRunAssignments(
  rows: KetRow[],
  firstRunPct: number = DEFAULT_FIRST_RUN_PCT,
): Map<string, RunInfo> {
  const assignments = new Map<string, RunInfo>();
  const byRecipe = new Map<string, KetRow[]>();
  for (const row of rows) {
    if (!row.recipeCode) continue;
    if (!byRecipe.has(row.recipeCode)) byRecipe.set(row.recipeCode, []);
    byRecipe.get(row.recipeCode)!.push(row);
  }

  for (const recipeRows of byRecipe.values()) {
    const byDay = new Map<string, KetRow[]>();
    for (const row of recipeRows) {
      const day = parseDateShift(row.dateNeeded).date;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(row);
    }
    const days = [...byDay.entries()].sort((a, b) => parseSortKey(a[0]) - parseSortKey(b[0]));
    const dayPortions = days.map(([, dayRows]) => ({
      dayRows,
      portions: Math.max(0, ...dayRows.map((r) => r.targetPortions)),
    }));
    const weekTotal = dayPortions.reduce((s, d) => s + d.portions, 0);
    const isSplit = days.length > 1 && weekTotal > 0;

    let cumulative = 0;
    const threshold = weekTotal * (firstRunPct / 100);
    for (const { dayRows, portions } of dayPortions) {
      const run: 1 | 2 = !isSplit || cumulative < threshold ? 1 : 2;
      const cumulativeShare = weekTotal > 0 ? Math.min(1, (cumulative + portions) / weekTotal) : 0;
      for (const row of dayRows) {
        assignments.set(row.key, { run, cumulativeSharePct: cumulativeShare, isSplit });
      }
      cumulative += portions;
    }
  }

  return assignments;
}
