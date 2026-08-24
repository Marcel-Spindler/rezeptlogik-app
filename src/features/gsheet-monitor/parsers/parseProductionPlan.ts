// GSheet Monitor – Production-Plan-Parser ("F_VE Production Plan", Tab
// "W{XX} - Plating Plan [WIP]"). Das ist der VORAB-Plan für eine kommende
// Woche, von Hand gepflegt — nicht zu verwechseln mit LinePlaiting (Ist-
// Tracking der laufenden Woche, parseLinePlaiting.ts).
//
// Spalten (0-indiziert, siehe gsheetTypes.ts ProductionPlanRow):
// A Code, B Preference, C Recipe Name, D-F BENL/NORD/DE, G Total,
// H Total+Buffer, I Complexity Score, J # subs, K # Cook stations,
// L Active cook min, M Passive Hold, N-S Grill/Cup/Butter/Oven/Braiser/Slice
// (X-Flags), T Allergens, W-AC (22-28) Tages-Matrix So-Sa, AE-AG (30-32)
// Ready Do/Fr/Sa, AI-AK (34-36) Min Needs Do/Fr/Sa.
//
// Unterhalb der Meal-Zeilen folgen zwei weitere Blöcke, beide über die
// Label-Spalte V (21) erkannt: ein KPI-Block (z.B. "unique meals", "lines",
// "cupping time") und — eingeleitet durch das Label "Utilization" — ein
// Block mit einer Auslastungszeile pro Station (BRAISER, GRILL, ...). Beide
// Blöcke nutzen für die Tageswerte dieselben Spalten W-AC wie die Meal-Matrix.
import { PRODUCTION_PLAN_DAYS, type ProductionPlanData, type ProductionPlanDay, type ProductionPlanDayCell, type ProductionPlanKpiRow, type ProductionPlanRow, type ProductionPlanStationUtilization, type ProductionPlanTotals } from "../gsheetTypes";

const DAY_COL_START = 22; // Spalte W
const READY_COLS = { thu: 30, fri: 31, sat: 32 } as const;
const MIN_NEEDS_COLS = { thu: 34, fri: 35, sat: 36 } as const;
const LABEL_COL = 21; // Spalte V
const UTILIZATION_LABEL = "Utilization";

// Zahlen im Sheet mischen Tausender-Kommas ("31,851") und reine Ziffern
// ("7378") je nach Zellformat — beide Formen müssen zum selben Wert führen.
function parseIntCell(raw: string): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatCell(raw: string): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Eine Tagesspalte in der Plating-Matrix enthält entweder eine reine Zahl
// (Portionen am tatsächlichen Plating-Tag) oder ein Stationslabel wie "Cup"
// (Vorbereitungstag) — nie beides in derselben Zelle.
function classifyDayCell(raw: string): ProductionPlanDayCell {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { kind: "empty" };
  if (/^-?[\d,]+$/.test(trimmed)) {
    const portions = parseIntCell(trimmed);
    if (portions != null) return { kind: "portions", portions };
  }
  return { kind: "station", label: trimmed };
}

function parseByDayCells(row: string[]): Record<ProductionPlanDay, ProductionPlanDayCell> {
  const byDay = {} as Record<ProductionPlanDay, ProductionPlanDayCell>;
  PRODUCTION_PLAN_DAYS.forEach((day, i) => {
    byDay[day] = classifyDayCell(row[DAY_COL_START + i] ?? "");
  });
  return byDay;
}

function parseByDayNumbers(row: string[]): Partial<Record<ProductionPlanDay, number | null>> {
  const byDay: Partial<Record<ProductionPlanDay, number | null>> = {};
  PRODUCTION_PLAN_DAYS.forEach((day, i) => {
    byDay[day] = parseIntCell(row[DAY_COL_START + i] ?? "");
  });
  return byDay;
}

function isFlag(raw: string): boolean {
  return (raw ?? "").trim().toUpperCase() === "X";
}

export function parseProductionPlan(rows: string[][]): ProductionPlanData {
  const week = (rows[1]?.[1] ?? "").trim();

  const headerIdx = rows.findIndex((r) => (r[0] ?? "").trim() === "Code");
  if (headerIdx === -1) {
    return { week, rows: [], totals: null, kpiRows: [], utilization: [], lastUpdated: Date.now() };
  }

  const planRows: ProductionPlanRow[] = [];
  let totals: ProductionPlanTotals | null = null;
  const kpiRows: ProductionPlanKpiRow[] = [];
  const utilization: ProductionPlanStationUtilization[] = [];
  let inUtilizationBlock = false;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const code = (row[0] ?? "").trim();

    if (code) {
      if (code === "Code") continue; // wiederholte Header-Zeile
      planRows.push({
        code,
        preference: (row[1] ?? "").trim(),
        recipeName: (row[2] ?? "").trim(),
        benl: parseIntCell(row[3] ?? "") ?? 0,
        nordics: parseIntCell(row[4] ?? "") ?? 0,
        de: parseIntCell(row[5] ?? "") ?? 0,
        total: parseIntCell(row[6] ?? "") ?? 0,
        totalWithBuffer: parseIntCell(row[7] ?? "") ?? 0,
        complexityScore: parseFloatCell(row[8] ?? ""),
        subCount: parseIntCell(row[9] ?? ""),
        cookStationCount: parseIntCell(row[10] ?? ""),
        activeCookMin: parseIntCell(row[11] ?? ""),
        passiveHoldMin: parseIntCell(row[12] ?? ""),
        stations: {
          grill: isFlag(row[13] ?? ""),
          cup: isFlag(row[14] ?? ""),
          butter: isFlag(row[15] ?? ""),
          oven: isFlag(row[16] ?? ""),
          braiser: isFlag(row[17] ?? ""),
          slice: isFlag(row[18] ?? ""),
        },
        allergens: (row[19] ?? "").trim(),
        byDay: parseByDayCells(row),
        readyByDay: {
          thu: parseIntCell(row[READY_COLS.thu] ?? ""),
          fri: parseIntCell(row[READY_COLS.fri] ?? ""),
          sat: parseIntCell(row[READY_COLS.sat] ?? ""),
        },
        minNeedsByDay: {
          thu: parseIntCell(row[MIN_NEEDS_COLS.thu] ?? ""),
          fri: parseIntCell(row[MIN_NEEDS_COLS.fri] ?? ""),
          sat: parseIntCell(row[MIN_NEEDS_COLS.sat] ?? ""),
        },
      });
      continue;
    }

    // Code leer, aber BENL gefüllt -> Wochensummen-Zeile (nur die erste zählt).
    const benlTotal = parseIntCell(row[3] ?? "");
    if (!totals && benlTotal != null) {
      totals = {
        benl: benlTotal,
        nordics: parseIntCell(row[4] ?? ""),
        de: parseIntCell(row[5] ?? ""),
        total: parseIntCell(row[6] ?? ""),
        totalWithBuffer: parseIntCell(row[7] ?? ""),
      };
      continue;
    }

    // Code+BENL leer, aber Label-Spalte gefüllt -> KPI- oder Utilization-Zeile.
    const label = (row[LABEL_COL] ?? "").trim();
    if (!label) continue;

    if (label === UTILIZATION_LABEL) {
      inUtilizationBlock = true; // diese Zeile selbst ist nur der Tages-Header-Repeat, keine Werte
      continue;
    }

    if (inUtilizationBlock) {
      const byDay: Partial<Record<ProductionPlanDay, number>> = {};
      PRODUCTION_PLAN_DAYS.forEach((day, di) => {
        byDay[day] = parseIntCell(row[DAY_COL_START + di] ?? "") ?? 0;
      });
      utilization.push({ station: label, byDay });
    } else {
      kpiRows.push({ label, byDay: parseByDayNumbers(row) });
    }
  }

  return { week, rows: planRows, totals, kpiRows, utilization, lastUpdated: Date.now() };
}
