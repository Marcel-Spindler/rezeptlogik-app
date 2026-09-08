import { describe, expect, it } from "vitest";
import { _parseRows } from "../lib/planningSheetApi";

// _parseRows bekommt die von _fetchGvizRaw aufbereiteten Zeilen: Zeile 0 sind
// die gviz-Spaltenlabels, danach die Datenzeilen. Tages-Header stehen als
// Excel-Seriennummer-String (so liefert gviz die Datums-Zellen des Sheets).
// Serials für die W39-Woche: So 13.09.=46278 … Sa 19.09.=46284.
const COL_LABELS = Array(34).fill("");

function row(entries: Record<number, string>): string[] {
  const max = Math.max(33, ...Object.keys(entries).map(Number));
  const arr = Array(max + 1).fill("");
  for (const [k, v] of Object.entries(entries)) arr[Number(k)] = v;
  return arr;
}

const WEEK_ROW = row({ 0: "Week", 1: "2026-W39" });

// Zweischicht-Header: jeder Wochentag Mo-Fr taucht mit ZWEI Datums-Spalten auf.
const HEADER = row({
  0: "Code", 1: "Preference", 2: "Recipe Name", 6: "Total", 7: "Total+Buffer",
  13: "Grill", 14: "Cup", 15: "Butter", 16: "Oven", 17: "Braiser", 18: "Slice", 19: "Allergens",
  22: "46278", 23: "46279", 24: "46279", 25: "46280", 26: "46280",
  27: "46281", 28: "46281", 29: "46282", 30: "46282", 31: "46283", 32: "46283", 33: "46284",
});

// Plating: Mi früh 5032 + Fr früh 2156.
const PLATING_A = row({
  0: "FV1351A", 1: "CS", 2: "Cheddar & Red Pepper Chicken Thigh Pasta", 6: "6846", 7: "7188",
  16: "X", 17: "X", 19: "gluten,milk,sulphites,wheat", 27: "5032", 31: "2156",
});
// Synthetisch: Montag früh 1000 + Montag spät 500 → Tagessumme 1500.
const PLATING_B = row({
  0: "FV9999A", 1: "Keto", 2: "Two-Shift Test Meal", 6: "2400", 7: "2520",
  16: "X", 19: "milk", 23: "1000", 24: "500",
});

const TOTALS = row({ 3: "44,106", 6: "95,729", 7: "100,804" });
const KPI = row({ 21: "total meals", 25: "24601" });

// Zweiter "Code"-Block = KITCHEN (Kochtag-Plan), gleiche Codes, andere Tage.
const KITCHEN_HEADER = row({ 0: "Code", 1: "Preference", 2: "Recipe Name" });
const KITCHEN_A = row({ 0: "FV1351A", 1: "CS", 2: "Cheddar & Red Pepper Chicken Thigh Pasta", 25: "5032", 29: "2156" });

const RAW = [COL_LABELS, WEEK_ROW, HEADER, PLATING_A, PLATING_B, TOTALS, KPI, KITCHEN_HEADER, KITCHEN_A];

describe("_parseRows – Zweischicht-Layout (W39)", () => {
  const data = _parseRows(RAW, "W39 - Plating Plan [WIP]");

  it("reads the week label and detects the dual shift model", () => {
    expect(data.week).toBe("2026-W39");
    expect(data.shiftModel).toBe("dual");
  });

  it("sums early + late shift columns of the same weekday", () => {
    const b = data.rows.find(r => r.code === "FV9999A")!;
    expect(b.days.Monday).toBe(1500); // 1000 früh + 500 spät
  });

  it("keeps plating days on the plating rows and attaches the KITCHEN block as kitchenDays", () => {
    expect(data.rows.map(r => r.code)).toEqual(["FV1351A", "FV9999A"]);
    const a = data.rows.find(r => r.code === "FV1351A")!;
    // Plating-Tage: Mi/Fr — NICHT von den Kitchen-Kochtagen (Di/Do) überschrieben.
    expect(a.days.Wednesday).toBe(5032);
    expect(a.days.Friday).toBe(2156);
    expect(a.days.Tuesday ?? 0).toBe(0);
    expect(a.days.Thursday ?? 0).toBe(0);
    // Küchenplan als eigenes Feld: Kochtage Di/Do.
    expect(a.kitchenDays?.Tuesday).toBe(5032);
    expect(a.kitchenDays?.Thursday).toBe(2156);
    expect(a.kitchenDays?.Wednesday ?? 0).toBe(0);
    // FV9999A hat keine Kitchen-Zeile im Fixture → kein kitchenDays.
    expect(data.rows.find(r => r.code === "FV9999A")!.kitchenDays).toBeUndefined();
  });

  it("still parses stations", () => {
    const a = data.rows.find(r => r.code === "FV1351A")!;
    expect(a.stations.Oven).toBe(true);
    expect(a.stations.Braiser).toBe(true);
  });
});

// Regression: klassisches Einschicht-Layout (1 Spalte je Wochentag).
const SINGLE_HEADER = row({
  0: "Code", 1: "Preference", 2: "Recipe Name", 6: "Total", 7: "Total+Buffer",
  16: "Oven", 17: "Braiser",
  22: "46278", 23: "46279", 24: "46280", 25: "46281", 26: "46282", 27: "46283", 28: "46284",
});
const SINGLE_MEAL = row({ 0: "FV1351A", 1: "CS", 2: "Cheddar", 6: "6846", 7: "7188", 24: "5402", 26: "2233" });
const SINGLE_RAW = [COL_LABELS, row({ 0: "Week", 1: "2026-W38" }), SINGLE_HEADER, SINGLE_MEAL];

describe("_parseRows – Einschicht-Layout bleibt unverändert", () => {
  const data = _parseRows(SINGLE_RAW, "W38 - Plating Plan [WIP]");
  it("maps one column per weekday, no kitchen block, shiftModel single", () => {
    expect(data.shiftModel).toBe("single");
    const a = data.rows.find(r => r.code === "FV1351A")!;
    expect(a.days.Tuesday).toBe(5402);
    expect(a.days.Thursday).toBe(2233);
    expect(a.kitchenDays).toBeUndefined();
  });
});
