// node:test — läuft mit `npm test` im functions/-Ordner (Node 22, keine Deps).
// Deckt die reinen Helfer von rtiBackfillWatch.js ab: Rechner-Parität mit
// src/features/backfills/rtiBackfillCalculator.ts, das Zeit-Fenster und die
// Schreib-Guards von fillRtiHeader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  computeRtiBackfills, detectWeek, codeDigits,
  usableExternalTarget, lookbackHoursSinceMonday, withinPlatingHours, fillRtiHeader,
  parseCsv, parseWholeNumber, plannedActualFromRow,
  mealBlock, subNeed, itemLine, IND, RULE,
} = require("../rtiBackfillWatch.js")._internal;

const sub = (o = {}) => ({
  workOrder: "38-000", subRecipeName: "Sub", platingHoldingKg: 0, weighedKg: 0,
  gramPerMeal: 100, availableMealcount: 0, minimumNeed: 0, backfillMeals: 0,
  shortagePct: 0, status: "open", isBackfillCandidate: false, ...o,
});

test("computeRtiBackfills — KW38 FV4048A Parität", () => {
  const meals = [{
    mealCode: "FV4048A", mealName: "Creamy Leek", plannedTarget: 3763, actuals: 2848, headerRow: 5,
    subRecipes: [
      sub({ workOrder: "38-161", subRecipeName: "Creamy Leek", weighedKg: 97.31, availableMealcount: 974, minimumNeed: 59, shortagePct: 1.57 }),
      sub({ workOrder: "38-162", subRecipeName: "Green beans", weighedKg: 53.5, availableMealcount: 1271, minimumNeed: 356, shortagePct: 9.46 }),
      sub({ workOrder: "38-163", subRecipeName: "Mash", weighedKg: 0, availableMealcount: 0, minimumNeed: -915, backfillMeals: -1137, shortagePct: -24.32 }),
      sub({ workOrder: "38-164", subRecipeName: "Pork tenderloin", weighedKg: 10.22, availableMealcount: 103, minimumNeed: -812, backfillMeals: -987, shortagePct: -21.58 }),
    ],
  }];
  const [r] = computeRtiBackfills(meals);
  assert.equal(r.gap, 915);
  assert.equal(r.recommendedMin, 915);
  assert.deepEqual(r.openSubs.map(s => `${s.subRecipeName}:${s.minimumNeed}/${s.bufferedNeed}`),
    ["Mash:915/1137", "Pork tenderloin:812/987"]);
  assert.equal(r.targetEstimated, false);
});

test("computeRtiBackfills — Kopf leer + externalTargets + Wiegung → geschätzt", () => {
  const meals = [{
    mealCode: "FV0780A", mealName: "Penne", plannedTarget: 0, actuals: 0, headerRow: 12,
    subRecipes: [sub({ subRecipeName: "Beilage", weighedKg: 40 }), sub({ subRecipeName: "Bolo", weighedKg: 0 })],
  }];
  const tgt = new Map([["0780", { plannedTarget: 6918, actuals: 5539, source: "Forecast + Redzone" }]]);
  const [r] = computeRtiBackfills(meals, tgt);
  assert.equal(r.targetEstimated, true);
  assert.equal(r.gap, 1379);
  assert.equal(r.plannedTarget, 6918);
  assert.equal(r.headerRow, 12);
});

test("computeRtiBackfills — Kopf leer, aber noch NICHTS gewogen → keine Substitution", () => {
  const meals = [{
    mealCode: "FV0780A", mealName: "Penne", plannedTarget: 0, actuals: 0, headerRow: 12,
    subRecipes: [sub({ subRecipeName: "Bolo", weighedKg: 0 })],
  }];
  const tgt = new Map([["0780", { plannedTarget: 6918, actuals: 5539, source: "x" }]]);
  assert.equal(computeRtiBackfills(meals, tgt).length, 0);
});

test("usableExternalTarget — Plausibilität", () => {
  assert.equal(usableExternalTarget({ plannedTarget: 3000, actuals: 2600 }), true);
  assert.equal(usableExternalTarget({ plannedTarget: 3000, actuals: 3600 }), false);
  assert.equal(usableExternalTarget({ plannedTarget: 0, actuals: 0 }), false);
  assert.equal(usableExternalTarget(undefined), false);
});

test("detectWeek / codeDigits", () => {
  assert.equal(detectWeek([["irgendwas"], ["KW 39"]]), "W39");
  assert.equal(codeDigits("FV0780A"), "0780");
});

test("withinPlatingHours — 6–15 Uhr Berlin", () => {
  assert.equal(withinPlatingHours(new Date("2026-09-09T10:00:00Z")), true);  // 12:00 Berlin
  assert.equal(withinPlatingHours(new Date("2026-09-09T18:00:00Z")), false); // 20:00 Berlin
  assert.equal(withinPlatingHours(new Date("2026-09-09T03:00:00Z")), false); // 05:00 Berlin
});

test("lookbackHoursSinceMonday — geklemmt [24,168]", () => {
  assert.equal(lookbackHoursSinceMonday(new Date("2026-09-07T05:00:00Z")), 24);   // Mo 07:00 Berlin → min
  assert.equal(lookbackHoursSinceMonday(new Date("2026-09-09T12:00:00Z")), 62);   // Mi ~14:00 Berlin
  assert.equal(lookbackHoursSinceMonday(new Date("2026-09-13T21:30:00Z")), 168);  // So 23:30 Berlin → cap
});

test("parseCsv — Quoting + eingebettete Kommas", () => {
  assert.deepEqual(parseCsv('a,"b,c",d\n1,"2""x",3\n'), [["a", "b,c", "d"], ["1", '2"x', "3"]]);
});

test("parseWholeNumber — Tausender-Trenner beide Stile", () => {
  assert.equal(parseWholeNumber("5,485"), 5485);
  assert.equal(parseWholeNumber("5.485"), 5485);
  assert.equal(parseWholeNumber("1 234"), 1234);
  assert.equal(parseWholeNumber(""), 0);
  assert.equal(parseWholeNumber("-915"), -915);
});

test("fillRtiHeader — leere Zellen: schreiben", async () => {
  const rows = [];
  rows[5] = ["", "FV0780A - Whole Wheat Penne Bolognese [DE]", "", "", ""];
  const meal = { mealCode: "FV0780A", headerRow: 5 };
  const writes = [];
  const sheets = { spreadsheets: { values: { update: async a => { writes.push(a); return {}; } } } };

  const ok = await fillRtiHeader(sheets, rows, meal, 5510, 5539);
  assert.equal(ok.ok, true);
  assert.equal(ok.cell, "'RTI'!D6:E6");
  assert.equal(ok.rewrite, false);
  assert.deepEqual(writes[0].requestBody.values, [[5510, 5539]]);
});

test("fillRtiHeader — Hand-Eintrag: niemals anfassen", async () => {
  const meal = { mealCode: "FV0780A", headerRow: 5 };
  const writes = [];
  const sheets = { spreadsheets: { values: { update: async a => { writes.push(a); return {}; } } } };
  const rows = [[], [], [], [], [], ["", "FV0780A - x", "", "7000", "6000"]];
  // kein prevFill → fremder Wert
  assert.equal((await fillRtiHeader(sheets, rows, meal, 5510, 5539)).reason, "human-edit");
  // prevFill passt NICHT zu den Zellen → jemand hat editiert
  assert.equal((await fillRtiHeader(sheets, rows, meal, 5510, 5539, { planned: 6918, actuals: 5600 })).reason, "human-edit");
  assert.equal(writes.length, 0);
});

test("fillRtiHeader — eigener Fehl-Eintrag: korrigieren", async () => {
  const meal = { mealCode: "FV0780A", headerRow: 5 };
  const writes = [];
  const sheets = { spreadsheets: { values: { update: async a => { writes.push(a); return {}; } } } };
  const rows = [[], [], [], [], [], ["", "FV0780A - x", "", "6918", "5600"]];
  const r = await fillRtiHeader(sheets, rows, meal, 5510, 5600, { planned: 6918, actuals: 5600 });
  assert.equal(r.ok, true);
  assert.equal(r.rewrite, true);
  assert.deepEqual(writes[0].requestBody.values, [[5510, 5600]]);
  // marginale Änderung → kein Rewrite
  assert.equal((await fillRtiHeader(sheets, rows, meal, 6919, 5601, { planned: 6918, actuals: 5600 })).reason, "no-change");
});

test("fillRtiHeader — Plausibilität + Zeilen-Check", async () => {
  const rows = [[], [], [], [], [], ["", "FV0780A - x", "", "", ""]];
  const meal = { mealCode: "FV0780A", headerRow: 5 };
  const sheets = { spreadsheets: { values: { update: async () => ({}) } } };
  assert.equal((await fillRtiHeader(sheets, rows, meal, 6918, 7400)).reason, "implausible");
  assert.equal((await fillRtiHeader(sheets, rows, meal, 80, 10)).reason, "out-of-range");
  const rows3 = [[], [], [], [], [], ["", "FV9999A - Other", "", "", ""]];
  assert.equal((await fillRtiHeader(sheets, rows3, meal, 6918, 5539)).reason, "row-mismatch");
});

test("Slack-Format — mealBlock: Kopf + eingerückte Sub-Zeilen (nbsp-Einzug)", () => {
  const b = mealBlock(
    { mealCode: "FV4048A", mealName: "Creamy Leek", gap: 915, actuals: 2848, plannedTarget: 3763 },
    [subNeed({ subRecipeName: "Mash", minimumNeed: 915, bufferedNeed: 1137, basis: "sheet" })],
  );
  const lines = b.split("\n");
  assert.equal(lines[0], "*FV4048A*  ·  Creamy Leek");
  assert.ok(lines[1].startsWith(IND), "Detailzeile mit nbsp eingerückt");
  assert.match(lines[1], /915 fehlen.*2\.848 \/ 3\.763/);
  assert.ok(lines[2].startsWith(IND + "• *Mash*"));
  assert.equal(IND, "   ");
});

test("Slack-Format — itemLine: Code fett, optionale 2. Zeile eingerückt", () => {
  assert.equal(itemLine("FV0780A", "Penne", ""), "• *FV0780A*  ·  Penne");
  assert.equal(itemLine("FV0780A", "Penne", "Planned 5.510"), `• *FV0780A*  ·  Penne\n${IND}Planned 5.510`);
});

test("Slack-Format — RULE ist eine Trennlinie", () => {
  assert.ok(RULE.length >= 20 && /^─+$/.test(RULE));
});

test("plannedActualFromRow — Tripel p,a,d mit d=a−p, Run-Zähler weg", () => {
  // [code, name, planned, "", "", "3.0", actual, delta, ...rechts Wochensummen]
  const row = ["FV4048A", "Creamy Leek", "3763", "", "", "3.0", "2848", "-915", "", "", "note", "24.32%", "", "12599", "0", "-12599"];
  assert.deepEqual(plannedActualFromRow(row, 2), { planned: 3763, actual: 2848 });
  // Überproduktion: delta positiv
  const row2 = ["FV0780A", "Penne", "5510", "", "", "5.0", "5600", "90"];
  assert.deepEqual(plannedActualFromRow(row2, 2), { planned: 5510, actual: 5600 });
});
