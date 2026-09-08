import { describe, expect, it } from "vitest";
import { parseProductionPlan } from "../features/gsheet-monitor/parsers/parseProductionPlan";

// Zeilen 1:1 aus einem echten Dump von "F_VE Production Plan", Tab
// "W37 - Plating Plan [WIP]" (per scripts/dump-gsheet.ts gezogen) — sichert
// die Spaltenindizes gegen das reale, unregelmäßig formatierte Sheet ab statt
// gegen eine handgebaute Annahme.
const LEGEND_ROWS = [
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "First Run assumptions", "", "Buffer Assumption"],
  ["Week", "2026-W37", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "70%", "", "5%"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Refire Day"],
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "PLATING", "", "", "", "", "", "", "", "Ready", "", "", "", "Min Needs"],
];
const HEADER_ROW = ["Code", "Preference", "Recipe Name", "BENL", "NORD", "DE", "Total", "Total+Buffer", "Complexity Score", "# subs", "# Cook stations", "Active cook min", "Passive Hold", "Grill", "Cup", "Butter", "Oven", "Braiser", "Slice", "Allergens", "", "", "Sunday 30.08.", "Monday 31.08.", "Tuesday 01.09.", "Wednesday 02.09.", "Thursday 03.09.", "Friday 04.09.", "Saturday 05.09.", "", "Thu", "Fri", "Sat", "", "Thursday", "Friday", "Saturday"];
// Meal mit Cup-Vorbereitungstagen: Montag/Mittwoch = Label "Cup", Dienstag/Donnerstag = Portionen.
const ROW_CUP_PREP = ["FV0257A", "Keto", "Greek style ground beef and feta", "3563", "2076", "1739", "7378", "7747", "1.28", "8", "8", "625", "0", "", "", "X", "X", "X", "", "milk,sulphites", "", "", "", "Cup", "5,423", "Cup", "2,324", "", "", "", "7747", "7747", "7747", "", "3998"];
// Meal ohne Stationslabel: reine Portionszahlen an Donnerstag/Samstag.
const ROW_PLAIN_NUMBERS = ["FV4101A", "Perf", "Sticky Seeded Salmon & Potato-Dill Mash ", "4212", "2924", "2194", "9330", "9797", "0.99", "4", "6", "389", "2880", "", "", "", "X", "X", "", "celery,fish,milk,sesame,soya,sulphites", "", "", "", "", "", "", "6,858", "", "2,939", "", "9797", "9797", "9797", "", "4832"];
const ROW_TOTALS = ["", "", "", "31,851", "21,636", "17,410", "79,369", "83,436"];
const ROW_KPI_UNIQUE_MEALS = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "unique meals", "0", "0", "7", "7", "7", "9", "3", "", "Cup"];
// Enthält bei idx24 den Streuwert "Meals" (Legenden-Artefakt im Original-Sheet) statt einer Zahl.
const ROW_KPI_CUPPING_TIME = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "cupping time", "", "", "Meals"];
const ROW_UTILIZATION_HEADER = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Utilization", "Sunday 30.08.", "Monday 31.08.", "Tuesday 01.09.", "Wednesday 02.09.", "Thursday 03.09.", "Friday 04.09.", "Saturday 05.09."];
const ROW_BRAISER = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "BRAISER", "0", "0", "19088", "12097", "18478", "9091", "5143"];

const ALL_ROWS = [
  ...LEGEND_ROWS,
  HEADER_ROW,
  ROW_CUP_PREP,
  ROW_PLAIN_NUMBERS,
  ROW_TOTALS,
  ROW_KPI_UNIQUE_MEALS,
  ROW_KPI_CUPPING_TIME,
  ROW_UTILIZATION_HEADER,
  ROW_BRAISER,
];

describe("parseProductionPlan", () => {
  it("extracts the week label from the legend rows above the header", () => {
    expect(parseProductionPlan(ALL_ROWS).week).toBe("2026-W37");
  });

  it("classifies day cells as station-label vs. portions vs. empty", () => {
    const row = parseProductionPlan(ALL_ROWS).rows.find((r) => r.code === "FV0257A")!;
    expect(row.byDay.Sunday).toEqual({ kind: "empty" });
    expect(row.byDay.Monday).toEqual({ kind: "station", label: "Cup" });
    expect(row.byDay.Tuesday).toEqual({ kind: "portions", portions: 5423 });
    expect(row.byDay.Wednesday).toEqual({ kind: "station", label: "Cup" });
    expect(row.byDay.Thursday).toEqual({ kind: "portions", portions: 2324 });
  });

  it("parses a meal row's core fields, stripping thousands commas", () => {
    const row = parseProductionPlan(ALL_ROWS).rows.find((r) => r.code === "FV0257A")!;
    expect(row.recipeName).toBe("Greek style ground beef and feta");
    expect(row.total).toBe(7378);
    expect(row.totalWithBuffer).toBe(7747);
    expect(row.complexityScore).toBeCloseTo(1.28);
    expect(row.stations).toEqual({ grill: false, cup: false, butter: true, oven: true, braiser: true, slice: false });
    expect(row.allergens).toBe("milk,sulphites");
  });

  it("reads Ready and Min Needs side columns independently of the day matrix", () => {
    const row = parseProductionPlan(ALL_ROWS).rows.find((r) => r.code === "FV0257A")!;
    expect(row.readyByDay).toEqual({ thu: 7747, fri: 7747, sat: 7747 });
    expect(row.minNeedsByDay).toEqual({ thu: 3998, fri: null, sat: null });
  });

  it("handles a row with plain portion numbers and no station label", () => {
    const row = parseProductionPlan(ALL_ROWS).rows.find((r) => r.code === "FV4101A")!;
    expect(row.byDay.Thursday).toEqual({ kind: "portions", portions: 6858 });
    expect(row.byDay.Saturday).toEqual({ kind: "portions", portions: 2939 });
    expect(row.byDay.Friday).toEqual({ kind: "empty" });
    expect(row.minNeedsByDay.thu).toBe(4832);
  });

  it("captures the week totals row", () => {
    expect(parseProductionPlan(ALL_ROWS).totals).toEqual({
      benl: 31851, nordics: 21636, de: 17410, total: 79369, totalWithBuffer: 83436,
    });
  });

  it("collects KPI rows by label, ignoring stray legend text in unrelated cells", () => {
    const kpi = parseProductionPlan(ALL_ROWS).kpiRows;
    expect(kpi.find((k) => k.label === "unique meals")?.byDay).toEqual({
      Sunday: 0, Monday: 0, Tuesday: 7, Wednesday: 7, Thursday: 7, Friday: 9, Saturday: 3,
    });
    // "Meals" bei idx24 ist kein Zahlenwert und darf nicht als Dienstag-Wert durchrutschen.
    expect(kpi.find((k) => k.label === "cupping time")?.byDay.Tuesday).toBeNull();
  });

  it("switches from KPI rows to per-station utilization rows after the 'Utilization' label", () => {
    const data = parseProductionPlan(ALL_ROWS);
    expect(data.kpiRows.some((k) => k.label === "Utilization")).toBe(false);
    expect(data.utilization).toEqual([
      { station: "BRAISER", byDay: { Sunday: 0, Monday: 0, Tuesday: 19088, Wednesday: 12097, Thursday: 18478, Friday: 9091, Saturday: 5143 } },
    ]);
  });

  it("returns an empty result when no header row is found", () => {
    const data = parseProductionPlan([["not", "a", "header"]]);
    expect(data.rows).toEqual([]);
    expect(data.totals).toBeNull();
  });

  it("defaults shiftModel to 'single' for the classic 7-day layout", () => {
    expect(parseProductionPlan(ALL_ROWS).shiftModel).toBe("single");
    expect(parseProductionPlan(ALL_ROWS).kitchen).toBeUndefined();
  });
});

// ── Zweischicht-Layout (ab W39) ────────────────────────────────────────────────
// Mo-Fr je zwei Tagesspalten (early/late), So/Sa einspaltig → 12 Spalten (22-33);
// Ready 35-37, Min Needs 39-41. Darunter ein zweiter "Code"-Block ("KITCHEN").
function w39Row(entries: Record<number, string>): string[] {
  const max = Math.max(...Object.keys(entries).map(Number));
  const arr = Array(max + 1).fill("");
  for (const [k, v] of Object.entries(entries)) arr[Number(k)] = v;
  return arr;
}

const W39_HEADER = [
  "Code", "Preference", "Recipe Name", "BENL", "NORD", "DE", "Total", "Total+Buffer",
  "Complexity Score", "# subs", "# Cook stations", "Active cook min", "Passive Hold",
  "Grill", "Cup", "Butter", "Oven", "Braiser", "Slice", "Allergens", "", "",
  "Sunday 13.09.", "Monday 14.09.", "Monday 14.09.", "Tuesday 15.09.", "Tuesday 15.09.",
  "Wednesday 16.09.", "Wednesday 16.09.", "Thursday 17.09.", "Thursday 17.09.",
  "Friday 18.09.", "Friday 18.09.", "Saturday 19.09.", "", "Thu", "Fri", "Sat", "", "Thursday", "Friday", "Saturday",
];

// FV1351A: Plating am Mi (früh) + Fr (früh); Ready 35-37, Min Needs nur Do (39).
const W39_PLATING_A = w39Row({
  0: "FV1351A", 1: "CS", 2: "Cheddar & Red Pepper Chicken Thigh Pasta",
  3: "3356", 4: "2116", 5: "1374", 6: "6846", 7: "7188", 8: "1.02", 9: "5", 10: "6", 11: "428", 12: "166",
  16: "X", 17: "X", 19: "gluten,milk,sulphites,wheat",
  27: "5,032", 31: "2,156", 35: "7188", 36: "7188", 37: "7188", 39: "3615",
});
// Synthetisch: Montag früh UND spät befüllt (Merge-Summe), Dienstag früh "Cup"-Label + spät Portionen.
const W39_PLATING_B = w39Row({
  0: "FV9999A", 1: "Keto", 2: "Two-Shift Test Meal",
  3: "1000", 4: "800", 5: "600", 6: "2400", 7: "2520", 8: "0.5", 9: "3", 10: "4", 11: "200", 12: "0",
  16: "X", 19: "milk",
  23: "1,000", 24: "500", 25: "Cup", 26: "200", 35: "2520", 36: "2520", 37: "2520", 39: "900",
});
const W39_PLATING_TOTALS = ["", "", "", "44,106", "30,139", "21,484", "95,729", "100,804"];
const W39_KPI_UNIQUE = w39Row({ 21: "unique meals", 22: "0", 23: "0", 25: "9", 27: "8", 29: "7", 31: "10", 33: "8" });
const W39_KPI_TOTAL_MEALS = w39Row({ 21: "total meals", 25: "24,601", 27: "26,281", 29: "25,469", 31: "11,463", 33: "12,991" });

const W39_KITCHEN_HEADER = ["Code", "Preference", "Recipe Name"];
// FV1351A gekocht am Di (früh) + Do (früh) — ein Tag vor dem jeweiligen Plating-Tag.
const W39_KITCHEN_A = w39Row({
  0: "FV1351A", 1: "CS", 2: "Cheddar & Red Pepper Chicken Thigh Pasta",
  3: "3356", 4: "2116", 5: "1374", 6: "6846", 7: "7188",
  16: "X", 17: "X", 19: "gluten,milk,sulphites,wheat",
  25: "5,032", 29: "2,156",
});
const W39_KITCHEN_TOTALS = ["", "", "", "44,106", "30,139", "21,484", "95,729", "100,804"];
// Wiederholt das "total meals"-Label — darf den KPI-Block NICHT ein zweites Mal füllen.
const W39_KITCHEN_KPI_TOTAL_MEALS = w39Row({ 21: "total meals", 23: "24,601", 25: "26,281", 27: "25,469", 29: "11,463", 31: "12,991" });

const W39_UTIL_HEADER = w39Row({
  21: "Utilization", 22: "Sunday 13.09.", 23: "Monday 14.09.", 25: "Tuesday 15.09.",
  27: "Wednesday 16.09.", 29: "Thursday 17.09.", 31: "Friday 18.09.", 33: "Saturday 19.09.",
});
const W39_UTIL_BRAISER = w39Row({ 21: "BRAISER", 22: "0", 23: "0", 25: "24102", 27: "26281", 29: "16663", 31: "11249", 33: "9217" });

const W39_ROWS = [
  ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "First Run assumptions", "", "Buffer Assumption"],
  ["Week", "2026-W39", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "70%", "", "5%"],
  w39Row({ 22: "PLATING", 35: "Ready", 39: "Min Needs" }),
  w39Row({ 23: "early shift", 24: "late shift", 25: "early shift", 26: "late shift" }),
  W39_HEADER,
  W39_PLATING_A,
  W39_PLATING_B,
  W39_PLATING_TOTALS,
  W39_KPI_UNIQUE,
  W39_KPI_TOTAL_MEALS,
  W39_KITCHEN_HEADER,
  W39_KITCHEN_A,
  W39_KITCHEN_TOTALS,
  W39_KITCHEN_KPI_TOTAL_MEALS,
  W39_UTIL_HEADER,
  W39_UTIL_BRAISER,
];

describe("parseProductionPlan – Zweischicht-Layout (W39)", () => {
  const data = parseProductionPlan(W39_ROWS);

  it("detects the dual-shift model and finds the week label above the extra header rows", () => {
    expect(data.week).toBe("2026-W39");
    expect(data.shiftModel).toBe("dual");
  });

  it("merges early + late shift portions into the per-day view", () => {
    const b = data.rows.find(r => r.code === "FV9999A")!;
    expect(b.byDay.Monday).toEqual({ kind: "portions", portions: 1500 }); // 1000 + 500
    // Dienstag: früh "Cup"-Label + spät 200 Portionen → Portionen gewinnen
    expect(b.byDay.Tuesday).toEqual({ kind: "portions", portions: 200 });
    expect(b.byDay.Sunday).toEqual({ kind: "empty" });
  });

  it("keeps the raw early/late split in byShift", () => {
    const b = data.rows.find(r => r.code === "FV9999A")!;
    expect(b.byShift?.Monday).toEqual({
      early: { kind: "portions", portions: 1000 },
      late: { kind: "portions", portions: 500 },
    });
    expect(b.byShift?.Tuesday).toEqual({
      early: { kind: "station", label: "Cup" },
      late: { kind: "portions", portions: 200 },
    });
    // So/Sa haben keine Schicht-Aufteilung
    expect(b.byShift?.Sunday).toBeUndefined();
  });

  it("reads Ready (35-37) and Min Needs (39-41) at the shifted column offsets", () => {
    const a = data.rows.find(r => r.code === "FV1351A")!;
    expect(a.readyByDay).toEqual({ thu: 7188, fri: 7188, sat: 7188 });
    expect(a.minNeedsByDay).toEqual({ thu: 3615, fri: null, sat: null });
    expect(a.byDay.Wednesday).toEqual({ kind: "portions", portions: 5032 });
    expect(a.byDay.Friday).toEqual({ kind: "portions", portions: 2156 });
  });

  it("parses the KITCHEN block separately (no double-counting of the meal rows)", () => {
    expect(data.rows.map(r => r.code)).toEqual(["FV1351A", "FV9999A"]);
    expect(data.kitchen?.rows.map(r => r.code)).toEqual(["FV1351A"]);
    const k = data.kitchen!.rows[0];
    expect(k.byDay.Tuesday).toEqual({ kind: "portions", portions: 5032 });
    expect(k.byDay.Thursday).toEqual({ kind: "portions", portions: 2156 });
    expect(k.readyByDay).toEqual({ thu: null, fri: null, sat: null });
  });

  it("captures only the first (plating) week totals, not the repeated kitchen totals", () => {
    expect(data.totals).toEqual({
      benl: 44106, nordics: 30139, de: 21484, total: 95729, totalWithBuffer: 100804,
    });
  });

  it("dedupes KPI labels so the repeated kitchen KPI block does not appear twice", () => {
    expect(data.kpiRows.filter(k => k.label === "total meals")).toHaveLength(1);
    expect(data.kpiRows.find(k => k.label === "total meals")?.byDay).toMatchObject({
      Sunday: null, Tuesday: 24601, Wednesday: 26281, Thursday: 25469, Friday: 11463, Saturday: 12991,
    });
  });

  it("reads per-station utilization at the dual-shift day columns", () => {
    expect(data.utilization).toEqual([
      { station: "BRAISER", byDay: { Sunday: 0, Monday: 0, Tuesday: 24102, Wednesday: 26281, Thursday: 16663, Friday: 11249, Saturday: 9217 } },
    ]);
  });
});
