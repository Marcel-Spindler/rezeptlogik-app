// node:test — läuft mit `npm test` im functions/-Ordner (Node 22, keine Deps).
// Deckt die reinen Helfer von dailyBriefingSlack.js ab: das Staffing-Plan-
// Sheet-Parsing (Portierung von parseStaffingPlan.ts) und die HF-Wochen-
// Berechnung (Duplikat von src/lib/hfWeek.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseStaffingPlan, hfWeekLabel, buildMessage } = require("../dailyBriefingSlack.js")._internal;

// Derselbe Referenz-Zeitpunkt wie rtiBackfillWatch.test.mjs (dort als "KW38"
// annotiert) — hfWeekLabel muss dieselbe Woche liefern, nur mit Jahr.
const REF_NOW = new Date("2026-09-09T10:00:00Z");

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

test("parseStaffingPlan reads the Kitchen row for the requested week, not Plating", () => {
  const result = parseStaffingPlan(realisticRows(), "2026-W39");
  assert.deepEqual(result, { kitchenHeadcount: 36, weekLabel: "2026-W39" });
});

test("parseStaffingPlan returns null when the week isn't in the sheet", () => {
  const result = parseStaffingPlan(realisticRows(), "2030-W01");
  assert.equal(result.kitchenHeadcount, null);
});

test("buildMessage reports 'kein offener Backfill-Bedarf' when nothing is open", () => {
  const text = buildMessage({ now: REF_NOW, openMeals: [], kitchenHeadcount: 36, weekLabel: "2026-W38" });
  assert.match(text, /Kein offener Backfill-Bedarf/);
  assert.match(text, /36 MA/);
});

test("buildMessage reports the Staffing-Plan-unreachable state honestly instead of a fake number", () => {
  const text = buildMessage({ now: REF_NOW, openMeals: [], kitchenHeadcount: null, weekLabel: "2026-W38" });
  assert.match(text, /Staffing-Plan nicht erreichbar/);
});
