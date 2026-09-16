// node:test — läuft mit `npm test` im functions/-Ordner (Node 22, keine Deps).
// Deckt die reinen Parser/Compute-Helfer von transparencyLite.js ab: die 4
// Sheet-Parser (Portierungen von parseTotalOverview.ts/parseWeighingLedger.ts/
// parseRtem.ts/parsePlanningCheck.ts) und die Produzierbarkeits-Engine
// (Portierung von transparencyProducibility.ts). Es gibt in src/__tests__/
// keine dedizierte Testdatei für diese 4 Parser oder
// transparencyProducibility.ts — die Fälle hier sind deshalb aus dem echten
// Spaltenlayout (Kommentare in den .ts-Quellen) nachgebaut, nicht 1:1
// portiert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TRANSPARENCY_SHEET_ID, TRANSPARENCY_TABS,
  parseTotalOverview, parseWeighingLedger, parseRtem, parsePlanningCheck,
  computeTransparencyProducibility,
  splitRecipeCodeAndName, looksLikeRecipeCode, weekPrefixFromWoNumber,
} = require("../transparencyLite.js");

test("TRANSPARENCY_TABS matches the registry used server-side (scripts/wms-local-server.ts)", () => {
  assert.equal(TRANSPARENCY_SHEET_ID, "1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY");
  assert.deepEqual(TRANSPARENCY_TABS["total-overview"], { title: "Transperancy Total Overview", range: "A1:BF4200" });
  assert.deepEqual(TRANSPARENCY_TABS["importrange-weights"], { title: "Importrange Weights", range: "A1:R23000" });
  assert.deepEqual(TRANSPARENCY_TABS["planning-check"], { title: "Planning Check", range: "A1:U120" });
  assert.deepEqual(TRANSPARENCY_TABS.rtem, { title: "RTEM", range: "A1:R1800" });
});

test("splitRecipeCodeAndName splits 'CODE - Name [Region]' but passes through unmatched text", () => {
  assert.deepEqual(splitRecipeCodeAndName("FV4034A - Pulled chicken in smokey tomato sauce [DE]"), {
    code: "FV4034A",
    name: "Pulled chicken in smokey tomato sauce [DE]",
  });
  assert.deepEqual(splitRecipeCodeAndName("no code here"), { code: "", name: "no code here" });
});

test("looksLikeRecipeCode filters out repeated header rows mid-data", () => {
  assert.equal(looksLikeRecipeCode("FV4034A"), true);
  assert.equal(looksLikeRecipeCode("Recipe Code"), false);
});

test("weekPrefixFromWoNumber reads the WO's week prefix ('35-1' -> 35)", () => {
  assert.equal(weekPrefixFromWoNumber("35-1"), 35);
  assert.equal(weekPrefixFromWoNumber("9-3"), 9);
  assert.equal(weekPrefixFromWoNumber("no-prefix"), null);
});

// ── parseTotalOverview ──────────────────────────────────────────────────────
function totalOverviewRows() {
  const header = ["Run", "", "", "Planned Kitchen day", "WO", "Comment", "Recipe", "Sub recipe", "Planned Meals", "Planned Staging kg", "Kitchen kg", "Planned Post kg", "Yield"];
  const row1 = ["Run1", "", "", "Mon", "35-1", "", "FV4034A - Pulled chicken [DE]", "Chicken", "100", "50", "48", "45", "0.9",
    "TRUE", "", "TRUE", "", "", "", "", "", "", "In Progress", "Alice"];
  const row2 = ["Run1", "", "", "Mon", "35-2", "", "FV4034A - Pulled chicken [DE]", "Rice", "100", "30", "29", "28", "0.93",
    "TRUE", "", "FALSE", "", "", "", "", "", "", "Open", "Bob"];
  return [header, row1, row2];
}

test("parseTotalOverview extracts flow rows, splits recipe code/name, and groups by WO and recipe code", () => {
  const result = parseTotalOverview(totalOverviewRows());
  assert.equal(result.rows.length, 2);

  const chicken = result.rows[0];
  assert.equal(chicken.workOrder, "35-1");
  assert.equal(chicken.recipeCode, "FV4034A");
  assert.equal(chicken.recipeName, "Pulled chicken [DE]");
  assert.equal(chicken.subRecipeName, "Chicken");
  assert.equal(chicken.plannedPostKg, 45);
  assert.equal(chicken.logisticStaged, true);
  assert.equal(chicken.kitchenCooked, true);
  assert.equal(chicken.logisticStatus, "In Progress");

  assert.equal(result.byWorkOrder.get("35-1").length, 1);
  assert.equal(result.byRecipeCode.get("FV4034A").length, 2);
});

test("parseTotalOverview skips rows without a WO and returns empty result when the header is missing", () => {
  const header = ["Run", "", "", "Planned Kitchen day", "WO"];
  const rowNoWo = ["Run1", "", "", "Mon", ""];
  const result = parseTotalOverview([header, rowNoWo]);
  assert.equal(result.rows.length, 0);

  const noHeader = parseTotalOverview([["irrelevant"]]);
  assert.equal(noHeader.rows.length, 0);
  assert.equal(noHeader.byWorkOrder.size, 0);
});

// ── parseWeighingLedger ─────────────────────────────────────────────────────
test("parseWeighingLedger extracts Raw/Pre-Blast/Post-Blast as three independent chains and sums kg by WO", () => {
  const header = ["", "WO Number", "", "", "Raw kg", "", "WO Number", "kg", "SKU", "Subrezept", "Stück pro Rack", "", "WO Number", "kg", "SKU", "Rezept", "Subrezept"];
  // Zeile mit nur Post-Blast befüllt (Raw/Pre-Blast in dieser Zeile leer) —
  // genau der Fall, den der Kommentar in parseWeighingLedger.ts beschreibt.
  const row1 = ["", "35-1", "SKU1", "Chicken", "10", "", "", "", "", "", "", "", "35-1", "5", "SKU1", "Pulled chicken", "Chicken"];
  const row2 = ["", "", "", "", "", "", "35-2", "20", "SKU2", "Rice", "8", "", "35-1", "3", "SKU1", "Pulled chicken", "Chicken"];
  const result = parseWeighingLedger([header, row1, row2]);

  assert.equal(result.raw.length, 1);
  assert.equal(result.raw[0].weightKg, 10);
  assert.equal(result.preBlast.length, 1);
  assert.equal(result.preBlast[0].piecesPerRack, 8);
  assert.equal(result.postBlast.length, 2);

  assert.equal(result.rawKgByWorkOrder.get("35-1"), 10);
  assert.equal(result.preBlastKgByWorkOrder.get("35-2"), 20);
  // Zwei Post-Blast-Wiegungen fuer dieselbe WO -> aufsummiert.
  assert.equal(result.postBlastKgByWorkOrder.get("35-1"), 8);
});

// ── parseRtem ────────────────────────────────────────────────────────────
test("parseRtem splits the recipe name into FV-code + name and groups by recipe code and sub-recipe name", () => {
  const header = ["Slot #", "Menu Week", "Recipe Code", "Recipe Name", "Demand", "Scheduled Portions", "Sub Recipe Code", "Sub Recipe Name", "Cook Methods", "", "Quantity Cooked", "", "", "Total Cooked", "Total Mapped", "Estimated RTI left", "Actual RTI left"];
  const row = ["1", "2026-W38", "REC-123", "FV4034A - Pulled chicken [DE]", "100", "90", "SR-1", "Chicken", "Sous Vide", "", "50", "", "", "48", "45", "10", "8"];
  const result = parseRtem([header, row]);

  assert.equal(result.rows.length, 1);
  const r = result.rows[0];
  assert.equal(r.recipeCode, "FV4034A");
  assert.equal(r.recipeName, "Pulled chicken [DE]");
  assert.equal(r.internalRecipeId, "REC-123");
  assert.equal(r.actualRtiLeft, 8);

  assert.equal(result.byRecipeCode.get("FV4034A").length, 1);
  assert.equal(result.bySubRecipeName.get("Chicken").length, 1);
});

test("parseRtem falls back to the raw recipe name when it doesn't match the FV-code pattern", () => {
  const header = ["Slot #", "Menu Week", "Recipe Code", "Recipe Name"];
  const row = ["1", "2026-W38", "REC-999", "Unbenanntes Rezept ohne Code"];
  const result = parseRtem([header, row]);
  assert.equal(result.rows[0].recipeCode, "");
  assert.equal(result.rows[0].recipeName, "Unbenanntes Rezept ohne Code");
});

// ── parsePlanningCheck ──────────────────────────────────────────────────────
function planningCheckRows() {
  const weekRow = ["", "", "2026-W38"];
  const header = ["", "Recipe Code", "Recipe Name", "Slot", "Total", "Planned 1", "Planned 2", "Planned 3", "Planned vs Forecast", "Planned Remaining to Plate", "",
    "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "", "Forecast Delta"];
  const dataRow = ["", "FV4034A", "Pulled chicken", "Slot1", "100", "30", "30", "40", "5", "20", "",
    "10", "", "15", "", "", "", "", "-2"];
  // Wiederholte Kopfzeile mitten in den Daten (mehrere Blöcke gestapelt) —
  // muss durch looksLikeRecipeCode() rausfallen.
  const repeatedHeader = ["", "Recipe Code", "Recipe Name", "Slot"];
  return [weekRow, header, dataRow, repeatedHeader];
}

test("parsePlanningCheck reads the week label, parses actuals-by-day, and skips repeated header rows", () => {
  const result = parsePlanningCheck(planningCheckRows());
  assert.equal(result.week, "2026-W38");
  assert.equal(result.rows.length, 1);

  const r = result.rows[0];
  assert.equal(r.recipeCode, "FV4034A");
  assert.equal(r.total, 100);
  assert.equal(r.actualsByDay.mon, 10);
  assert.equal(r.actualsByDay.tue, null);
  assert.equal(r.actualsByDay.wed, 15);
  assert.equal(r.forecastDeltaTotal, -2);

  assert.equal(result.byRecipeCode.get("FV4034A").recipeName, "Pulled chicken");
});

// ── computeTransparencyProducibility ────────────────────────────────────────
// Baut die 4 Teil-Datensätze direkt aus den Parser-Ergebnissen (statt
// Roh-Rows erneut zu tippen), um die Producibility-Logik isoliert zu testen.
function flowData(rows) {
  const byWorkOrder = new Map();
  const byRecipeCode = new Map();
  for (const r of rows) {
    if (!byWorkOrder.has(r.workOrder)) byWorkOrder.set(r.workOrder, []);
    byWorkOrder.get(r.workOrder).push(r);
    if (!byRecipeCode.has(r.recipeCode)) byRecipeCode.set(r.recipeCode, []);
    byRecipeCode.get(r.recipeCode).push(r);
  }
  return { rows, byWorkOrder, byRecipeCode, lastUpdated: Date.now() };
}
function weighingData(postBlastKgByWorkOrder) {
  return { raw: [], preBlast: [], postBlast: [], rawKgByWorkOrder: new Map(), preBlastKgByWorkOrder: new Map(), postBlastKgByWorkOrder: new Map(Object.entries(postBlastKgByWorkOrder)), lastUpdated: Date.now() };
}
function planningCheckData(rows) {
  return { week: "2026-W38", rows, byRecipeCode: new Map(rows.map((r) => [r.recipeCode, r])), lastUpdated: Date.now() };
}
function flowRow(overrides) {
  return { run: "Run1", plannedKitchenDay: "Mon", workOrder: "38-1", comment: "", recipeCode: "FV4034A", recipeName: "Pulled chicken", subRecipeName: "Chicken", plannedMeals: 100, plannedStagingKg: 50, kitchenKg: 48, plannedPostKg: 45, yieldPct: 0.9, logisticStaged: true, kitchenCooked: true, logisticStatus: "Open", logisticOwner: "Alice", ...overrides };
}

test("computeTransparencyProducibility marks a meal 'ready' when all its sub-recipes are weighed >= 98% of plan", () => {
  const flow = flowData([flowRow()]);
  const weighing = weighingData({ "38-1": 45 }); // 45/45 = 100%
  const planningCheck = planningCheckData([{ recipeCode: "FV4034A", recipeName: "Pulled chicken" }]);

  const result = computeTransparencyProducibility(flow, weighing, null, planningCheck, 38);
  assert.equal(result.meals.length, 1);
  assert.equal(result.meals[0].status, "ready");
  assert.equal(result.readyCount, 1);
  assert.equal(result.blockedCount, 0);
});

test("computeTransparencyProducibility marks a meal 'blocked' when no sub-recipe has any weighed kg yet", () => {
  const flow = flowData([flowRow()]);
  const weighing = weighingData({}); // nichts gewogen
  const planningCheck = planningCheckData([{ recipeCode: "FV4034A", recipeName: "Pulled chicken" }]);

  const result = computeTransparencyProducibility(flow, weighing, null, planningCheck, 38);
  assert.equal(result.meals[0].status, "blocked");
  assert.equal(result.blockedCount, 1);
  assert.match(result.meals[0].blockedReasons[0], /Chicken/);
});

test("computeTransparencyProducibility marks a meal 'partial' when some but not all sub-recipes are complete", () => {
  // Zwei Subrezepte auf getrennten WOs, damit jedes unabhaengig gewogen
  // werden kann (postBlastKgByWorkOrder ist ja pro WO, nicht pro Subrezept).
  const flow = flowData([
    flowRow({ workOrder: "38-1", subRecipeName: "Chicken", plannedPostKg: 45 }),
    flowRow({ workOrder: "38-2", subRecipeName: "Rice", plannedPostKg: 20 }),
  ]);
  const weighing = weighingData({ "38-1": 45, "38-2": 0 });
  const planningCheck = planningCheckData([{ recipeCode: "FV4034A", recipeName: "Pulled chicken" }]);

  const result = computeTransparencyProducibility(flow, weighing, null, planningCheck, 38);
  assert.equal(result.meals[0].status, "partial");
  assert.equal(result.partialCount, 1);
});

test("computeTransparencyProducibility separates recipes not in the current week's Planning Check into otherWeekMeals", () => {
  const flow = flowData([
    flowRow({ recipeCode: "FV4034A", recipeName: "Pulled chicken" }),
    flowRow({ workOrder: "20-1", recipeCode: "FV9999A", recipeName: "Old week meal" }),
  ]);
  const weighing = weighingData({ "38-1": 45, "20-1": 10 });
  const planningCheck = planningCheckData([{ recipeCode: "FV4034A", recipeName: "Pulled chicken" }]);

  const result = computeTransparencyProducibility(flow, weighing, null, planningCheck, 38);
  assert.equal(result.meals.length, 1);
  assert.equal(result.meals[0].recipeCode, "FV4034A");
  assert.equal(result.otherWeekMeals.length, 1);
  assert.equal(result.otherWeekMeals[0].recipeCode, "FV9999A");
});

test("computeTransparencyProducibility filters flow rows to the selected week via the WO-number prefix", () => {
  // Zwei WOs desselben Rezepts, eine aus KW38 eine aus KW20 (Total Overview
  // kumuliert ueber viele Wochen) -- nur die KW38-WO darf in die Bewertung
  // einfliessen.
  const flow = flowData([
    flowRow({ workOrder: "38-1", plannedPostKg: 45 }),
    flowRow({ workOrder: "20-9", plannedPostKg: 999 }),
  ]);
  const weighing = weighingData({ "38-1": 45 });
  const planningCheck = planningCheckData([{ recipeCode: "FV4034A", recipeName: "Pulled chicken" }]);

  const result = computeTransparencyProducibility(flow, weighing, null, planningCheck, 38);
  assert.equal(result.meals[0].status, "ready");
  assert.equal(result.meals[0].subRecipes[0].plannedPostKg, 45);
});

test("computeTransparencyProducibility returns 'unknown' with a German reason when a current-week recipe has no flow rows at all", () => {
  const flow = flowData([]);
  const weighing = weighingData({});
  const planningCheck = planningCheckData([{ recipeCode: "FV4034A", recipeName: "Pulled chicken" }]);

  const result = computeTransparencyProducibility(flow, weighing, null, planningCheck, 38);
  assert.equal(result.meals[0].status, "unknown");
  assert.match(result.meals[0].blockedReasons[0], /Keine Daten/);
});

test("computeTransparencyProducibility sums actualRtiLeft across matching RTEM rows for a sub-recipe", () => {
  const flow = flowData([flowRow({ subRecipeName: "Chicken" })]);
  const weighing = weighingData({ "38-1": 45 });
  const rtem = { rows: [], byRecipeCode: new Map(), bySubRecipeName: new Map([["Chicken", [{ actualRtiLeft: 5 }, { actualRtiLeft: 3 }]]]), lastUpdated: Date.now() };
  const planningCheck = planningCheckData([{ recipeCode: "FV4034A", recipeName: "Pulled chicken" }]);

  const result = computeTransparencyProducibility(flow, weighing, rtem, planningCheck, 38);
  assert.equal(result.meals[0].subRecipes[0].actualRtiLeft, 8);
});
