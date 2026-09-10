// GSheet Monitor – Production-Plan-Parser ("F_VE Production Plan", Tab
// "W{XX} - Plating Plan [WIP]"). Das ist der VORAB-Plan für eine kommende
// Woche, von Hand gepflegt — nicht zu verwechseln mit LinePlaiting (Ist-
// Tracking der laufenden Woche, parseLinePlaiting.ts).
//
// Spalten A-T sind in BEIDEN Layouts gleich (0-indiziert, siehe gsheetTypes.ts
// ProductionPlanRow): A Code, B Preference, C Recipe Name, D-F BENL/NORD/DE,
// G Total, H Total+Buffer, I Complexity Score, J # subs, K # Cook stations,
// L Active cook min, M Passive Hold, N-S Grill/Cup/Butter/Oven/Braiser/Slice
// (X-Flags), T Allergens.
//
// Ab Spalte W (22) hängt die Tages-Matrix vom Tab-Layout ab, das hier dynamisch
// aus der Header-Zeile erkannt wird (parseHeaderDayLayout):
//   • Einschicht (bis W38, wieder ab W40): 7 Spalten So-Sa (22-28),
//     Ready Do/Fr/Sa = 30-32, Min Needs Do/Fr/Sa = 34-36.
//   • Zweischicht (ab W39): Mo-Fr je zwei Spalten (early/late shift), So+Sa
//     einspaltig → 12 Tagesspalten (22-33), Ready = 35-37, Min Needs = 39-41.
//     Unter dem Plating-Block folgt ein zweiter Block mit eigener "Code"-
//     Kopfzeile ("KITCHEN") = der Kochtag-Plan je Meal, ohne Ready/Min Needs.
//
// Unterhalb der Meal-Zeilen folgen zwei weitere Blöcke, beide über die
// Label-Spalte V (21) erkannt: ein KPI-Block (z.B. "unique meals", "lines",
// "cupping time") und — eingeleitet durch das Label "Utilization" — ein
// Block mit einer Auslastungszeile pro Station (BRAISER, GRILL, ...). Beide
// Blöcke nutzen für die Tageswerte dieselben Spalten wie die Meal-Matrix
// (bei Zweischicht steht der Wert je Tag in der early-Spalte, late = 0).
import { PRODUCTION_PLAN_DAYS, type ProductionPlanData, type ProductionPlanDay, type ProductionPlanDayCell, type ProductionPlanKpiRow, type ProductionPlanRow, type ProductionPlanStationUtilization, type ProductionPlanTotals } from "../gsheetTypes";

const DAY_COL_START = 22; // Spalte W
const LABEL_COL = 21; // Spalte V
const UTILIZATION_LABEL = "Utilization";

// Einschicht-Fallback, falls die Header-Zeile keine erkennbaren Tages-Spalten hat.
const LEGACY_READY_START = 30;
const LEGACY_MIN_NEEDS_START = 34;

const WEEKDAY_BY_FIRST_WORD: Record<string, ProductionPlanDay> = {
  sunday: "Sunday", monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday",
};

// Header-Zellen sind FORMATTED_VALUE, z.B. "Monday 14.09." — das erste Wort
// trägt den Wochentag. Alles andere (leer, "Thu", "Utilization", ...) → null.
function headerCellToDay(raw: string): ProductionPlanDay | null {
  const first = (raw ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return WEEKDAY_BY_FIRST_WORD[first] ?? null;
}

interface DayLayout {
  shiftModel: "single" | "dual";
  // Alle Sheet-Spalten je Wochentag (Einschicht: 1, Zweischicht Mo-Fr: 2).
  dayColumns: Record<ProductionPlanDay, number[]>;
  // Nur Zweischicht: die Früh/Spät-Spalten je Mo-Fr-Tag.
  shiftColumns: Partial<Record<ProductionPlanDay, { early: number; late: number }>>;
  readyStart: number;    // Spalte "Ready Do", +1 = Fr, +2 = Sa
  minNeedsStart: number; // Spalte "Min Needs Do", +1 = Fr, +2 = Sa
}

function legacyLayout(): DayLayout {
  const dayColumns = {} as Record<ProductionPlanDay, number[]>;
  PRODUCTION_PLAN_DAYS.forEach((day, i) => { dayColumns[day] = [DAY_COL_START + i]; });
  return { shiftModel: "single", dayColumns, shiftColumns: {}, readyStart: LEGACY_READY_START, minNeedsStart: LEGACY_MIN_NEEDS_START };
}

// Aus der (ersten) "Code"-Kopfzeile: zusammenhängenden Lauf von Wochentag-
// Spalten ab Spalte W zählen (7 → Einschicht, 12 → Zweischicht) und daraus die
// Spalten-Zuordnung sowie Ready/Min-Needs-Startspalten ableiten.
function parseHeaderDayLayout(headerRow: string[]): DayLayout {
  const run: { col: number; day: ProductionPlanDay }[] = [];
  for (let c = DAY_COL_START; c < headerRow.length; c++) {
    const day = headerCellToDay(headerRow[c] ?? "");
    if (!day) break;
    run.push({ col: c, day });
  }
  if (run.length === 0) return legacyLayout();

  const dayColumns = {} as Record<ProductionPlanDay, number[]>;
  for (const day of PRODUCTION_PLAN_DAYS) {
    dayColumns[day] = run.filter(r => r.day === day).map(r => r.col);
  }
  // Sicherheitsnetz: Tage ohne Treffer im Lauf trotzdem befüllen (ein Tag darf
  // im Sheet nie ganz fehlen, aber falls doch: kein Crash beim Zugriff).
  let cursor = DAY_COL_START;
  for (const day of PRODUCTION_PLAN_DAYS) {
    if (dayColumns[day].length === 0) dayColumns[day] = [cursor];
    cursor = dayColumns[day][dayColumns[day].length - 1] + 1;
  }

  const shiftColumns: DayLayout["shiftColumns"] = {};
  let hasDual = false;
  for (const day of PRODUCTION_PLAN_DAYS) {
    const cols = dayColumns[day];
    if (cols.length >= 2) {
      shiftColumns[day] = { early: cols[0], late: cols[1] };
      hasDual = true;
    }
  }

  const readyStart = DAY_COL_START + run.length + 1; // +1 = Leerspalte zwischen Matrix und "Ready"
  return {
    shiftModel: hasDual ? "dual" : "single",
    dayColumns,
    shiftColumns,
    readyStart,
    // Der Min-Needs-Block trägt IMMER die vollen Wochentagsnamen als Kopf
    // ("Thursday"/"Friday"/"Saturday"), der Ready-Block die Abkürzungen
    // ("Thu"/"Fri"/"Sat"). Zwischen W36 und W37 wurde im Einschicht-Layout ein
    // zusätzlicher "Thu/Fri/Sat"-Split-Block + "Total"-Spalte eingeschoben und
    // hat Min Needs von Spalte 34 auf 38 geschoben — der feste Offset
    // (readyStart + 4) traf danach den Split-Block statt Min Needs. Deshalb den
    // Block über den Header suchen statt über einen festen Abstand.
    minNeedsStart: findFullWeekdayBlockStart(headerRow, readyStart) ?? readyStart + 4,
  };
}

// Erste Spalte eines zusammenhängenden "Thursday"/"Friday"/"Saturday"-Kopf-Trios
// ab Spalte `from`. Die Tages-Matrix-Header ("Thursday 03.09.") matchen NICHT,
// weil hier auf exakte Gleichheit (getrimmt, case-insensitiv) geprüft wird.
function findFullWeekdayBlockStart(headerRow: string[], from: number): number | null {
  const eq = (raw: string | undefined, name: string) => (raw ?? "").trim().toLowerCase() === name;
  for (let c = Math.max(0, from); c + 2 < headerRow.length; c++) {
    if (eq(headerRow[c], "thursday") && eq(headerRow[c + 1], "friday") && eq(headerRow[c + 2], "saturday")) return c;
  }
  return null;
}

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

// Mehrere Schicht-Zellen desselben Wochentags zu einer Tagessicht zusammenfassen:
// Portionen summieren; sonst Stationslabels zusammenführen; sonst leer.
function mergeDayCells(cells: ProductionPlanDayCell[]): ProductionPlanDayCell {
  const portions = cells
    .filter((c): c is Extract<ProductionPlanDayCell, { kind: "portions" }> => c.kind === "portions")
    .reduce((sum, c) => sum + c.portions, 0);
  if (cells.some(c => c.kind === "portions")) return { kind: "portions", portions };

  const labels = [...new Set(
    cells.filter((c): c is Extract<ProductionPlanDayCell, { kind: "station" }> => c.kind === "station").map(c => c.label),
  )];
  if (labels.length) return { kind: "station", label: labels.join(" / ") };

  return { kind: "empty" };
}

function parseByDayCells(row: string[], layout: DayLayout): Record<ProductionPlanDay, ProductionPlanDayCell> {
  const byDay = {} as Record<ProductionPlanDay, ProductionPlanDayCell>;
  for (const day of PRODUCTION_PLAN_DAYS) {
    byDay[day] = mergeDayCells(layout.dayColumns[day].map(c => classifyDayCell(row[c] ?? "")));
  }
  return byDay;
}

function parseByShiftCells(row: string[], layout: DayLayout): ProductionPlanRow["byShift"] {
  const byShift: NonNullable<ProductionPlanRow["byShift"]> = {};
  for (const day of PRODUCTION_PLAN_DAYS) {
    const cols = layout.shiftColumns[day];
    if (!cols) continue;
    byShift[day] = {
      early: classifyDayCell(row[cols.early] ?? ""),
      late: classifyDayCell(row[cols.late] ?? ""),
    };
  }
  return byShift;
}

// KPI-/Utilization-Zeilen: ein Wert je Tag, bei Zweischicht in der early-Spalte
// (late = 0). Summe über beide Schicht-Spalten trifft in beiden Layouts zu.
function parseByDayNumbers(row: string[], layout: DayLayout, emptyAs: null | 0): Partial<Record<ProductionPlanDay, number | null>> {
  const byDay: Partial<Record<ProductionPlanDay, number | null>> = {};
  for (const day of PRODUCTION_PLAN_DAYS) {
    const vals = layout.dayColumns[day].map(c => parseIntCell(row[c] ?? ""));
    const nums = vals.filter((v): v is number => v != null);
    byDay[day] = nums.length ? nums.reduce((a, b) => a + b, 0) : emptyAs;
  }
  return byDay;
}

function isFlag(raw: string): boolean {
  return (raw ?? "").trim().toUpperCase() === "X";
}

function findWeekLabel(rows: string[][]): string {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = rows[i];
    if (!r) continue;
    const wi = r.findIndex(c => (c ?? "").trim() === "Week");
    if (wi >= 0) {
      const val = (r[wi + 1] ?? "").trim();
      if (val) return val;
    }
  }
  return (rows[1]?.[1] ?? "").trim();
}

function parseMealRow(row: string[], layout: DayLayout, isKitchen: boolean): ProductionPlanRow {
  const nullReady = { thu: null, fri: null, sat: null };
  const out: ProductionPlanRow = {
    code: (row[0] ?? "").trim(),
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
    byDay: parseByDayCells(row, layout),
    readyByDay: isKitchen ? { ...nullReady } : {
      thu: parseIntCell(row[layout.readyStart] ?? ""),
      fri: parseIntCell(row[layout.readyStart + 1] ?? ""),
      sat: parseIntCell(row[layout.readyStart + 2] ?? ""),
    },
    minNeedsByDay: isKitchen ? { ...nullReady } : {
      thu: parseIntCell(row[layout.minNeedsStart] ?? ""),
      fri: parseIntCell(row[layout.minNeedsStart + 1] ?? ""),
      sat: parseIntCell(row[layout.minNeedsStart + 2] ?? ""),
    },
  };
  if (layout.shiftModel === "dual") out.byShift = parseByShiftCells(row, layout);
  return out;
}

export function parseProductionPlan(rows: string[][]): ProductionPlanData {
  const week = findWeekLabel(rows);

  const headerIdx = rows.findIndex((r) => (r[0] ?? "").trim() === "Code");
  if (headerIdx === -1) {
    return { week, shiftModel: "single", rows: [], totals: null, kpiRows: [], utilization: [], lastUpdated: Date.now() };
  }

  const layout = parseHeaderDayLayout(rows[headerIdx]);

  const platingRows: ProductionPlanRow[] = [];
  const kitchenRows: ProductionPlanRow[] = [];
  let totals: ProductionPlanTotals | null = null;
  const kpiRows: ProductionPlanKpiRow[] = [];
  const seenKpiLabels = new Set<string>();
  const utilization: ProductionPlanStationUtilization[] = [];
  let inUtilizationBlock = false;
  let inKitchenBlock = false;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;
    const code = (row[0] ?? "").trim();

    if (code === "Code") {
      // Zweite "Code"-Kopfzeile → ab hier der KITCHEN-Block (Zweischicht-Layout).
      inKitchenBlock = true;
      inUtilizationBlock = false;
      continue;
    }

    if (code) {
      (inKitchenBlock ? kitchenRows : platingRows).push(parseMealRow(row, layout, inKitchenBlock));
      continue;
    }

    // Code leer, aber BENL gefüllt -> Wochensummen-Zeile (nur die erste Plating-Summe zählt).
    const benlTotal = parseIntCell(row[3] ?? "");
    if (benlTotal != null) {
      if (!totals && !inKitchenBlock) {
        totals = {
          benl: benlTotal,
          nordics: parseIntCell(row[4] ?? ""),
          de: parseIntCell(row[5] ?? ""),
          total: parseIntCell(row[6] ?? ""),
          totalWithBuffer: parseIntCell(row[7] ?? ""),
        };
      }
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
      const byDay = parseByDayNumbers(row, layout, 0) as Partial<Record<ProductionPlanDay, number>>;
      utilization.push({ station: label, byDay });
    } else if (!seenKpiLabels.has(label)) {
      // Der KITCHEN-Block wiederholt viele KPI-Labels ("total meals", "lines", ...) —
      // nur das erste Vorkommen (Plating) behalten, damit der KPI-Block nicht doppelt erscheint.
      seenKpiLabels.add(label);
      kpiRows.push({ label, byDay: parseByDayNumbers(row, layout, null) });
    }
  }

  const result: ProductionPlanData = {
    week,
    shiftModel: layout.shiftModel,
    rows: platingRows,
    totals,
    kpiRows,
    utilization,
    lastUpdated: Date.now(),
  };
  if (layout.shiftModel === "dual" || kitchenRows.length > 0) {
    result.kitchen = { rows: kitchenRows };
  }
  return result;
}
