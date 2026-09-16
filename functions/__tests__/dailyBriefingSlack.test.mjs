// node:test — läuft mit `npm test` im functions/-Ordner (Node 22, keine Deps).
// Deckt die reinen Helfer von dailyBriefingSlack.js ab: das Staffing-Plan-
// Sheet-Parsing (Portierung von parseStaffingPlan.ts), die HF-Wochen-
// Berechnung (Duplikat von src/lib/hfWeek.ts) und den vereinfachten
// Kritisch(Küche)/Zu-plaitieren/Morgen-zuerst-Zwilling von
// matchPostblastToWorkOrders/mealProgress/plateableNet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parseStaffingPlan, hfWeekLabel, weekNumFromLabel, buildMessage, buildBriefingParts,
  buildMealProgress, grossPlateableLite, buildPlatingTodoLite, buildKitchenCritical,
  buildTomorrowPriorityLite, parseKitchenDayShift, berlinIsoDate,
  parseWoOverviewRows, buildProducibilityCritical, buildCombinedCritical,
  formatEquipmentSection, formatFeasibilitySection, chunkText,
} = require("../dailyBriefingSlack.js")._internal;

// Derselbe Referenz-Zeitpunkt wie rtiBackfillWatch.test.mjs (dort als "KW38"
// annotiert) — hfWeekLabel muss dieselbe Woche liefern, nur mit Jahr.
// In Berlin-Zeit (Sommerzeit, UTC+2) ist das Mittwoch, 2026-09-09 — "morgen"
// ist also 2026-09-10.
const REF_NOW = new Date("2026-09-09T10:00:00Z");

// Neutraler Default für buildMessage-Tests, die den erweiterten Block nicht
// selbst prüfen (sonst müsste jeder ältere Test `extended` erfinden).
const OK_EXTENDED_EMPTY = { ok: true, generatedAt: null, kitchenCritical: [], platingTodo: [], tomorrowPriority: [] };
// Dito für Producibility (null = "Sheet-Fehler/nicht abgerufen") und den
// Relay-Snapshot (Equipment/Feasibility) — Standardfall "Relay lief nicht".
const NO_PRODUCIBILITY = null;
const RELAY_UNAVAILABLE = { available: false };

test("hfWeekLabel matches the same HF-week rtiBackfillWatch's currentWorkOrderWeek computes for the same date", () => {
  assert.equal(hfWeekLabel(REF_NOW), "2026-W38");
});

test("hfWeekLabel rolls over into the next year past week 52", () => {
  // 2026-12-31 liegt weit in KW53+ der ISO-Rechnung -> rollt auf naechstes Jahr W01.
  const label = hfWeekLabel(new Date("2026-12-31T10:00:00Z"));
  assert.match(label, /^2027-W01$/);
});

// Nachgebaut aus dem echten Sheet-Dump (Tab "Financial", gid=308443134).
function realisticRows() {
  const header = ["", "", "", "", "2026", "2026-W01", "2026-W02", "2026-W38", "2026-W39"];
  const kitchen = ["Input", "Staffing", "Headcount - Required", "Kitchen", "", "0", "0", "32", "36"];
  const plating = ["Input", "Staffing", "Headcount - Required", "Plating", "", "0", "0", "40", "44"];
  return [header, kitchen, plating];
}

test("parseStaffingPlan reads Kitchen AND Plating for the requested week, not mixed up", () => {
  const result = parseStaffingPlan(realisticRows(), "2026-W39");
  assert.deepEqual(result, { kitchenHeadcount: 36, platingHeadcount: 44, weekLabel: "2026-W39" });
});

test("parseStaffingPlan returns null for both when the week isn't in the sheet", () => {
  const result = parseStaffingPlan(realisticRows(), "2030-W01");
  assert.equal(result.kitchenHeadcount, null);
  assert.equal(result.platingHeadcount, null);
});

test("buildMessage reports 'kein offener Backfill-Bedarf' when nothing is open", () => {
  const text = buildMessage({
    now: REF_NOW, openMeals: [], platingProgress: [], rtiError: false,
    kitchenHeadcount: 36, platingHeadcount: 44, weekLabel: "2026-W38", extended: OK_EXTENDED_EMPTY, producibility: NO_PRODUCIBILITY, relay: RELAY_UNAVAILABLE,
  });
  assert.match(text, /Kein offener Backfill-Bedarf/);
  assert.match(text, /36 MA/);
  assert.match(text, /44 MA/);
});

test("buildMessage reports the Staffing-Plan-unreachable state honestly instead of a fake number", () => {
  const text = buildMessage({
    now: REF_NOW, openMeals: [], platingProgress: [], rtiError: false,
    kitchenHeadcount: null, platingHeadcount: null, weekLabel: "2026-W38", extended: OK_EXTENDED_EMPTY, producibility: NO_PRODUCIBILITY, relay: RELAY_UNAVAILABLE,
  });
  assert.match(text, /Besetzung Küche: _Staffing-Plan nicht erreichbar_/);
  assert.match(text, /Besetzung Plating: _Staffing-Plan nicht erreichbar_/);
});

test("buildMessage reports the RTI-unreachable state honestly instead of a fake 'alles gut'", () => {
  const text = buildMessage({
    now: REF_NOW, openMeals: [], platingProgress: [], rtiError: true,
    kitchenHeadcount: 36, platingHeadcount: 44, weekLabel: "2026-W38", extended: OK_EXTENDED_EMPTY, producibility: NO_PRODUCIBILITY, relay: RELAY_UNAVAILABLE,
  });
  assert.match(text, /RTI-Sheet gerade nicht erreichbar/);
  assert.doesNotMatch(text, /Kein offener Backfill-Bedarf/);
});

test("buildMessage shows plating progress, sorted worst-first, done count excludes the open ones", () => {
  const platingProgress = [
    { mealCode: "FV1111A", mealName: "Fertig", plannedTarget: 1000, actuals: 1000, pct: 100, targetEstimated: false },
    { mealCode: "FV2222A", mealName: "Halb fertig", plannedTarget: 1000, actuals: 400, pct: 40, targetEstimated: false },
  ];
  const text = buildMessage({
    now: REF_NOW, openMeals: [], platingProgress, rtiError: false,
    kitchenHeadcount: 36, platingHeadcount: 44, weekLabel: "2026-W38", extended: OK_EXTENDED_EMPTY, producibility: NO_PRODUCIBILITY, relay: RELAY_UNAVAILABLE,
  });
  assert.match(text, /1 von 2 Meals ≥95 % fertig/);
  assert.match(text, /FV2222A/);
  assert.match(text, /40 %/);
  assert.doesNotMatch(text, /FV1111A/); // fertige Meals werden nicht einzeln aufgelistet
});

test("buildMessage caps the open-plating list and notes the remainder", () => {
  const platingProgress = Array.from({ length: 10 }, (_, i) => ({
    mealCode: `FV${1000 + i}A`, mealName: `Meal ${i}`, plannedTarget: 1000, actuals: 100, pct: 10, targetEstimated: false,
  }));
  const text = buildMessage({
    now: REF_NOW, openMeals: [], platingProgress, rtiError: false,
    kitchenHeadcount: 36, platingHeadcount: 44, weekLabel: "2026-W38", extended: OK_EXTENDED_EMPTY, producibility: NO_PRODUCIBILITY, relay: RELAY_UNAVAILABLE,
  });
  assert.match(text, /\+2 weitere < 95 %/);
});

test("buildMessage is honest when no plating weighings exist yet today", () => {
  const text = buildMessage({
    now: REF_NOW, openMeals: [], platingProgress: [], rtiError: false,
    kitchenHeadcount: 36, platingHeadcount: 44, weekLabel: "2026-W38", extended: OK_EXTENDED_EMPTY, producibility: NO_PRODUCIBILITY, relay: RELAY_UNAVAILABLE,
  });
  assert.match(text, /noch keine Wiegedaten für heute/);
});

// ── buildMealProgress (Zwilling von matchPostblastToWorkOrders) ────────────

function planRow(o = {}) {
  return { workOrder: "38-1", recipeCode: "FV0001A", recipeName: "Testmeal", subRecipe: "Sauce", plannedMeals: 1000, postKg: 100, ...o };
}

test("buildMealProgress: kein Gewicht trotz Plan -> isCritical", () => {
  const { meals } = buildMealProgress([planRow()], new Map(), new Map());
  assert.equal(meals[0].criticalWOs.length, 1);
});

test("buildMealProgress: >=95% gewogen -> isComplete, nicht mehr kritisch", () => {
  const { meals } = buildMealProgress([planRow()], new Map([["38-1", 96]]), new Map());
  assert.equal(meals[0].criticalWOs.length, 0);
});

test("buildMealProgress: preblast>0 aber postblast=0 -> awaitingPostBlast, NICHT kritisch (wartet nur auf 2. Wiegung)", () => {
  const { matched, meals } = buildMealProgress([planRow()], new Map(), new Map([["38-1", 50]]));
  assert.equal(matched[0].awaitingPostBlast, true);
  assert.equal(meals[0].criticalWOs.length, 0);
});

test("buildMealProgress: gruppiert mehrere WOs desselben Meals korrekt", () => {
  const rows = [planRow({ workOrder: "38-1" }), planRow({ workOrder: "38-2", subRecipe: "Beilage" })];
  const { meals } = buildMealProgress(rows, new Map(), new Map());
  assert.equal(meals.length, 1);
  assert.equal(meals[0].workOrders.length, 2);
  assert.equal(meals[0].criticalWOs.length, 2);
});

// ── grossPlateableLite (Planverhältnis-Fallback, kein recipeWeights) ───────

test("grossPlateableLite: Planverhältnis hochgerechnet auf plannedMeals", () => {
  const meal = { plannedMeals: 1000, workOrders: [{ subRecipe: "Sauce", plannedKg: 100, actualKg: 50, awaitingPostBlast: false }] };
  const gross = grossPlateableLite(meal);
  assert.equal(gross.meals, 500); // 50/100 * 1000
});

test("grossPlateableLite: ein Sub komplett ohne Gewicht (nicht awaitingPostBlast) blockiert auf 0", () => {
  const meal = {
    plannedMeals: 1000,
    workOrders: [
      { subRecipe: "Sauce", plannedKg: 100, actualKg: 100, awaitingPostBlast: false },
      { subRecipe: "Beilage", plannedKg: 100, actualKg: 0, awaitingPostBlast: false },
    ],
  };
  assert.equal(grossPlateableLite(meal).meals, 0);
});

test("grossPlateableLite: kein Plan für irgendein Sub -> null", () => {
  const meal = { plannedMeals: 0, workOrders: [{ subRecipe: "Sauce", plannedKg: 0, actualKg: 0, awaitingPostBlast: false }] };
  assert.equal(grossPlateableLite(meal), null);
});

// ── buildPlatingTodoLite (netto = brutto - schon plaitiert) ────────────────

test("buildPlatingTodoLite: netMeals = grossMeals - plaited, per codeDigits gematcht", () => {
  const meal = { recipeCode: "FV0001A", recipeName: "X", plannedMeals: 1000, workOrders: [{ subRecipe: "S", plannedKg: 100, actualKg: 80, awaitingPostBlast: false }] };
  const items = buildPlatingTodoLite([meal], new Map([["0001", 300]]));
  assert.equal(items.length, 1);
  assert.equal(items[0].grossMeals, 800);
  assert.equal(items[0].platedMeals, 300);
  assert.equal(items[0].netMeals, 500);
});

test("buildPlatingTodoLite: schon alles plaitiert (plated >= gross) -> Meal fällt raus", () => {
  const meal = { recipeCode: "FV0001A", recipeName: "X", plannedMeals: 1000, workOrders: [{ subRecipe: "S", plannedKg: 100, actualKg: 80, awaitingPostBlast: false }] };
  const items = buildPlatingTodoLite([meal], new Map([["0001", 100_000]]));
  assert.equal(items.length, 0);
});

// ── buildKitchenCritical ────────────────────────────────────────────────────

test("buildKitchenCritical: nennt WO-Nummern, deckelt auf 4 + Zähler", () => {
  const meal = {
    recipeCode: "FV0001A", recipeName: "X",
    criticalWOs: Array.from({ length: 6 }, (_, i) => ({ workOrder: `38-${i}` })),
  };
  const [item] = buildKitchenCritical([meal]);
  assert.match(item.message, /6 WO ohne Gewicht trotz Plan/);
  assert.match(item.message, /\+2/);
});

// ── parseKitchenDayShift / berlinIsoDate ────────────────────────────────────

test("parseKitchenDayShift: extrahiert das Datum vor dem Schicht-Suffix", () => {
  assert.equal(parseKitchenDayShift("2026-09-16 - 1").date, "2026-09-16");
  assert.equal(parseKitchenDayShift("2026-09-16").date, "2026-09-16");
});

test("berlinIsoDate: +1 Tag ab REF_NOW (Mi 09.09. Berlin) ist der 10.09.", () => {
  assert.equal(berlinIsoDate(REF_NOW, 0), "2026-09-09");
  assert.equal(berlinIsoDate(REF_NOW, 1), "2026-09-10");
});

// ── buildTomorrowPriorityLite ────────────────────────────────────────────────

test("buildTomorrowPriorityLite: nur offene (nicht isComplete) WOs von morgen, kritisch zuerst", () => {
  const matched = [
    { workOrder: "38-1", recipeCode: "FV0001A", recipeName: "Kritisch-Meal", subRecipe: "S", plannedMeals: 500, isComplete: false, kitchenDay: "2026-09-10" },
    { workOrder: "38-2", recipeCode: "FV0002A", recipeName: "Großer Ansatz", subRecipe: "S", plannedMeals: 5000, isComplete: false, kitchenDay: "2026-09-10 - 2" },
    { workOrder: "38-3", recipeCode: "FV0003A", recipeName: "Schon fertig", subRecipe: "S", plannedMeals: 100, isComplete: true, kitchenDay: "2026-09-10" },
    { workOrder: "38-4", recipeCode: "FV0004A", recipeName: "Übermorgen", subRecipe: "S", plannedMeals: 100, isComplete: false, kitchenDay: "2026-09-11" },
  ];
  const kitchenCriticalByCode = new Map([["FV0001A", { message: "1 WO ohne Gewicht trotz Plan — 38-1" }]]);
  const result = buildTomorrowPriorityLite(matched, REF_NOW, kitchenCriticalByCode);
  assert.deepEqual(result.map(r => r.workOrder), ["38-1", "38-2"]); // kritisch vor "nur groß", fertig/übermorgen raus
  assert.match(result[0].reason, /Kritisch \(Küche\)/);
  assert.match(result[1].reason, /Großer Ansatz/);
});

test("buildTomorrowPriorityLite: nichts für morgen -> leere Liste", () => {
  const matched = [{ workOrder: "38-1", recipeCode: "FV0001A", recipeName: "X", subRecipe: "S", plannedMeals: 500, isComplete: false, kitchenDay: "2026-09-09" }];
  assert.deepEqual(buildTomorrowPriorityLite(matched, REF_NOW, new Map()), []);
});

// ── buildMessage: erweiterter Block (Kritisch Küche / Zu plaitieren / Morgen) ─

test("buildMessage: ehrlicher Fehlerzustand statt stillschweigend leerer Liste, wenn extended.ok=false", () => {
  const text = buildMessage({
    now: REF_NOW, openMeals: [], platingProgress: [], rtiError: false,
    kitchenHeadcount: 36, platingHeadcount: 44, weekLabel: "2026-W38",
    extended: { ok: false, reason: "kein Produktionsplan für 2026-W38 gefunden", kitchenCritical: [], platingTodo: [], tomorrowPriority: [] },
    producibility: NO_PRODUCIBILITY, relay: RELAY_UNAVAILABLE,
  });
  assert.match(text, /kein Produktionsplan für 2026-W38 gefunden/);
});

test("buildMessage: zeigt Kritisch-Küche, Zu-plaitieren und Morgen-zuerst, wenn extended.ok=true", () => {
  const text = buildMessage({
    now: REF_NOW, openMeals: [], platingProgress: [], rtiError: false,
    kitchenHeadcount: 36, platingHeadcount: 44, weekLabel: "2026-W38",
    extended: {
      ok: true, generatedAt: "2026-09-09T08:00:00Z",
      kitchenCritical: [{ recipeCode: "FV0001A", recipeName: "X", count: 2, message: "2 WO ohne Gewicht trotz Plan — 38-1, 38-2" }],
      platingTodo: [{ recipeCode: "FV0002A", recipeName: "Y", netMeals: 500, grossMeals: 800, platedMeals: 300 }],
      tomorrowPriority: [{ workOrder: "38-9", recipeCode: "FV0003A", recipeName: "Z", subRecipe: "S", plannedMeals: 5000, reason: "Großer Ansatz (5.000 Portionen)" }],
    },
    producibility: NO_PRODUCIBILITY, relay: RELAY_UNAVAILABLE,
  });
  assert.match(text, /Kritisch – Küche \(1 Meal/);
  assert.match(text, /FV0001A/);
  assert.match(text, /Zu plaitieren \(jetzt möglich\)/);
  assert.match(text, /500 Port\. bereit/);
  assert.match(text, /Morgen zuerst anfassen/);
  assert.match(text, /WO 38-9/);
  assert.match(text, /Produktionsplan-Stand/);
});

test("buildMessage: keine kritischen Küchen-WOs -> positive Meldung statt leerer Sektion", () => {
  const text = buildMessage({
    now: REF_NOW, openMeals: [], platingProgress: [], rtiError: false,
    kitchenHeadcount: 36, platingHeadcount: 44, weekLabel: "2026-W38", extended: OK_EXTENDED_EMPTY, producibility: NO_PRODUCIBILITY, relay: RELAY_UNAVAILABLE,
  });
  assert.match(text, /Keine kritischen Küchen-WOs/);
});

// ── parseWoOverviewRows (dünner Adapter über transparency.parseTotalOverview
//    — dieselbe Spalten-Erkennung wie Producibility, siehe Kommentar in
//    dailyBriefingSlack.js: eine textbasierte Header-Suche griff live auf dem
//    echten Sheet nicht, die feste Spaltenzuordnung von parseTotalOverview
//    dagegen schon) ────────────────────────────────────────────────────────

function overviewRows() {
  const header = ["Run", "", "", "Planned Kitchen day", "WO", "Comment", "Recipe", "Sub recipe", "Planned Meals", "Planned Staging kg", "Kitchen kg", "Planned Post kg", "Yield"];
  const row1 = ["Run1", "", "", "2026-09-10 - 1", "38-101", "", "FV0001A - Testmeal [DE]", "Sauce", "1000", "50", "80", "100", "0.9"];
  const rowNoWo = ["Run1", "", "", "2026-09-10 - 1", "", "", "FV0002A - X [DE]", "Sauce", "500", "10", "10", "10", "0.9"];
  return [header, row1, rowNoWo];
}

test("parseWoOverviewRows: mapt parseTotalOverview-Zeilen auf die von buildMealProgress gebrauchten Felder", () => {
  const rows = parseWoOverviewRows(overviewRows());
  assert.equal(rows.length, 1); // die Zeile ohne WO fällt raus (kein recipeCode/workOrder)
  assert.equal(rows[0].workOrder, "38-101");
  assert.equal(rows[0].recipeCode, "FV0001A");
  assert.equal(rows[0].subRecipe, "Sauce");
  assert.equal(rows[0].plannedMeals, 1000);
  assert.equal(rows[0].postKg, 100);
  assert.equal(rows[0].kitchenKg, 80);
  assert.equal(rows[0].kitchenDay, "2026-09-10 - 1");
});

test("parseWoOverviewRows: kein erkennbarer Header -> leere Liste statt Crash", () => {
  assert.deepEqual(parseWoOverviewRows([["", "", ""], ["a", "b", "c"]]), []);
});

// ── buildProducibilityCritical ──────────────────────────────────────────────

test("buildProducibilityCritical: nur blocked/partial, ready fällt raus", () => {
  const producibility = {
    meals: [
      { recipeCode: "FV0001A", recipeName: "Ready-Meal", status: "ready", blockedReasons: [] },
      { recipeCode: "FV0002A", recipeName: "Blocked-Meal", status: "blocked", blockedReasons: ["Sauce: kein Soll gewogen (0.0/50.0 kg)"] },
      { recipeCode: "FV0003A", recipeName: "Partial-Meal", status: "partial", blockedReasons: ["Beilage: 40% gewogen (20.0/50.0 kg)"] },
    ],
  };
  const items = buildProducibilityCritical(producibility);
  assert.equal(items.length, 2);
  assert.equal(items[0].severity, "critical");
  assert.equal(items[1].severity, "warning");
  assert.match(items[0].message, /kein Soll gewogen/);
});

test("buildProducibilityCritical: kein Producibility-Ergebnis -> leere Liste", () => {
  assert.deepEqual(buildProducibilityCritical(null), []);
});

// ── buildCombinedCritical (Küche + Produzierbarkeit + Rohware, EIN sortierte
//    Liste, Zwilling von buildCriticalItems in dailyBriefingLogic.ts) ──────

test("buildCombinedCritical: mischt alle drei Quellen und sortiert kritisch vor warnung", () => {
  const kitchen = [{ recipeCode: "FV0001A", recipeName: "A", message: "3 WO ohne Gewicht" }];
  const producibility = [{ recipeCode: "FV0002A", recipeName: "B", severity: "warning", message: "40% gewogen" }];
  const feasibility = [{ recipeCode: "FV0003A", recipeName: "C", verdict: "blocked", message: "Rohware fehlt komplett" }];
  const items = buildCombinedCritical(kitchen, producibility, feasibility);
  assert.equal(items.length, 3);
  assert.equal(items[0].severity, "critical");
  assert.equal(items[1].severity, "critical");
  assert.equal(items[2].severity, "warning");
  assert.deepEqual(new Set(items.map(i => i.sourceLabel)), new Set(["Küche", "Produzierbarkeit", "Rohware"]));
});

// ── formatEquipmentSection / formatFeasibilitySection ──────────────────────

test("formatEquipmentSection: kein Relay-Snapshot -> ehrlicher Hinweis, kein Fake-Wert", () => {
  const text = formatEquipmentSection({ available: false });
  assert.match(text, /kein Relay-Snapshot verfügbar/);
});

test("formatEquipmentSection: veralteter Snapshot nennt das Alter", () => {
  const text = formatEquipmentSection({ available: false, staleMinutes: 90 });
  assert.match(text, /veraltet \(90 Min\.\)/);
});

test("formatEquipmentSection: verfügbar -> zeigt Stationen/Batches/Chiller", () => {
  const relay = {
    available: true,
    equipmentTomorrow: {
      date: "2026-09-17",
      runs: [{
        run: 1, shiftLabel: "Früh", totalWos: 12, totalKg: 500, totalGnTrays: 20, totalWannen: 3, totalStaffNeeded: 4,
        stations: [{ label: "Braiser", totalBatches: 5, totalKg: 200, ovenLoads: null }],
        chillerSlots: [{ label: "Chiller 1", woCount: 3 }],
      }],
    },
  };
  const text = formatEquipmentSection(relay);
  assert.match(text, /Equipment morgen \(2026-09-17\)/);
  assert.match(text, /Braiser/);
  assert.match(text, /Chiller 1:3/);
});

test("formatFeasibilitySection: Relay verfügbar, aber keine Einträge -> positive Meldung", () => {
  assert.match(formatFeasibilitySection({ available: true, feasibility: [] }), /keine blockierten\/knappen Backfills/);
});

test("formatFeasibilitySection: Relay nicht verfügbar -> null (kein doppelter Hinweis)", () => {
  assert.equal(formatFeasibilitySection({ available: false }), null);
});

test("formatFeasibilitySection: zeigt blockierte Backfills mit Nachricht", () => {
  const text = formatFeasibilitySection({ available: true, feasibility: [{ recipeCode: "FV0001A", recipeName: "X", verdict: "blocked", message: "Rohware fehlt komplett" }] });
  assert.match(text, /FV0001A/);
  assert.match(text, /Rohware fehlt komplett/);
});

// ── chunkText (Slack-Limit-Schutz, Punkt "Post darf nicht überlaufen") ─────

test("chunkText: kurzer Text bleibt EIN Chunk", () => {
  assert.deepEqual(chunkText("Zeile 1\nZeile 2", 100), ["Zeile 1\nZeile 2"]);
});

test("chunkText: langer Text wird an Zeilengrenzen gesplittet, keine Zeile zerschnitten", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `Zeile ${i} ist ein bisschen länger als man denkt`);
  const text = lines.join("\n");
  const chunks = chunkText(text, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 200 || !c.includes("\n")); // eine einzelne zu lange Zeile darf ausnahmsweise durch
  assert.equal(chunks.join("\n"), text); // nichts verloren
});

// ── buildBriefingParts: Kompakter Hauptpost + volle Details im Thread ─────

test("buildBriefingParts: compact bleibt kurz und verweist auf den Thread, detail trägt die vollen Listen", () => {
  const extended = {
    ok: true, generatedAt: null,
    kitchenCritical: [{ recipeCode: "FV0001A", recipeName: "X", count: 1, message: "1 WO ohne Gewicht trotz Plan — 38-1" }],
    platingTodo: [], tomorrowPriority: [],
  };
  const { compact, detail } = buildBriefingParts({
    now: REF_NOW, openMeals: [], platingProgress: [], rtiError: false,
    kitchenHeadcount: 36, platingHeadcount: 44, weekLabel: "2026-W38",
    extended, producibility: NO_PRODUCIBILITY, relay: RELAY_UNAVAILABLE,
  });
  assert.match(compact, /Details \(Backfill, Plating-Fortschritt, Produzierbarkeit, Zu plaitieren, Morgen zuerst, Equipment, Rohware\) im Thread/);
  assert.doesNotMatch(compact, /Kritisch – Küche/); // die volle Küchen-Sektion gehört ins Detail, nicht in den Kompakt-Post
  assert.match(detail, /Kritisch – Küche \(1 Meal/);
  assert.match(detail, /Equipment morgen/);
});
