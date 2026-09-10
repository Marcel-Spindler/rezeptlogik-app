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
  parseCsv, parseWholeNumber,
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

test("fillRtiHeader — schreibt D/E nur wenn beide leer + plausibel", async () => {
  const rows = [];
  rows[5] = ["", "FV0780A - Whole Wheat Penne Bolognese [DE]", "", "", ""];
  const meal = { mealCode: "FV0780A", headerRow: 5 };
  const writes = [];
  const sheets = { spreadsheets: { values: { update: async a => { writes.push(a); return {}; } } } };

  const ok = await fillRtiHeader(sheets, rows, meal, 6918, 5539);
  assert.equal(ok.ok, true);
  assert.equal(ok.cell, "'RTI'!D6:E6");
  assert.deepEqual(writes[0].requestBody.values, [[6918, 5539]]);

  // D schon gefüllt → niemals überschreiben
  const rows2 = [[], [], [], [], [], ["", "FV0780A - x", "", "7000", ""]];
  writes.length = 0;
  assert.equal((await fillRtiHeader(sheets, rows2, meal, 6918, 5539)).reason, "not-empty");
  assert.equal(writes.length, 0);

  // Ist > Ziel*1.05 → implausibel
  assert.equal((await fillRtiHeader(sheets, rows, meal, 6918, 7400)).reason, "implausible");
  // Ziel außerhalb Bereich
  assert.equal((await fillRtiHeader(sheets, rows, meal, 80, 10)).reason, "out-of-range");
  // Zeile trägt anderen Code
  const rows3 = [[], [], [], [], [], ["", "FV9999A - Other", "", "", ""]];
  assert.equal((await fillRtiHeader(sheets, rows3, meal, 6918, 5539)).reason, "row-mismatch");
});
