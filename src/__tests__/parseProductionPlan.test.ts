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
});
