// Lokaler Relay für Tagesbriefing: Equipment-Bedarf morgen + Rohware/MHD-
// Feasibility offener Backfills.
//
// Die Cloud Function `dailyBriefingSlack` (functions/dailyBriefingSlack.js)
// postet um 15:00 den Tagesbriefing-Slack-Post, kann aber zwei Dinge NICHT
// selbst berechnen, weil ihr die dafür nötigen Daten fehlen:
//   • Equipment für morgen (GN-Bleche/Wannen/Racks/Blast-Chiller/MA-Bedarf je
//     Station) — braucht computeFullResourceDemand (ketEquipmentSummary.ts),
//     das wiederum die VOLLE Rezeptstruktur (data.json) + die manuell
//     importierte KET-CSV braucht. Beides liegt nur lokal, nicht in der Cloud
//     Function.
//   • Rohware/MHD-Feasibility offener Backfills — braucht den WMS-Vollbestand
//     aus Snowflake (computeBackfillFeasibility, backfillFeasibility.ts).
//     Snowflake läuft in der Cloud Function nicht (JWT kaputt, siehe
//     Memory-Notiz vom 2026-09-16) — nur der lokale WMS-Server (Browser-SSO)
//     kommt aktuell durch.
//
// Dieses Script rechnet beides lokal (mit tsx direkten Zugriff auf src/ —
// keine Duplikat-"Lite"-Logik nötig wie sonst zwischen src/ und functions/)
// und schreibt das Ergebnis nach Firestore. Die Cloud Function liest den
// Snapshot beim Posten und zeigt ihn nur, wenn er frisch genug ist (siehe
// RELAY_FRESHNESS_MIN in dailyBriefingSlack.js) — sonst ehrlich "nicht
// verfügbar" statt einer veralteten Momentaufnahme.
//
// Gedacht für einen Windows Scheduled Task, ähnlich rti-redzone-relay.ts:
//   npm run daily-briefing:relay
// Equipment braucht nur die KET-CSV (kein Server nötig) — läuft also auch,
// wenn der lokale WMS-Server gerade nicht offen ist. Feasibility braucht ihn
// (Vollbestand); ist er nicht erreichbar, wird NUR die Feasibility-Sektion
// leise ausgelassen (kein Fehler-Alarm), Equipment wird trotzdem geschrieben.
//
//   apps/rezeptlogik/dailyBriefing/relaySnapshot
//     { updatedAt, updatedIso, sourceWeek,
//       equipmentTomorrow: { date, stations, chillerSlots, totals... } | null,
//       feasibility: [ {recipeCode, recipeName, verdict, message, ...} ] }
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import admin from "firebase-admin";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";
import { resolveSourceDir } from "./lib/helpers.ts";

import type { DataBundle } from "../src/core/types.ts";
import type { BatchCalc, KetRow } from "../src/features/ket-plan/ketTypes.ts";
import { EQUIP_DEFAULTS, type ManualEquipmentOverride } from "../src/features/ket-plan/ketTypes.ts";
import { calcBatch, EMPTY_GN_HINTS, parseDateShift, parseKetCsv, type GnHints } from "../src/features/ket-plan/ketLogic.ts";
import { computeRunAssignments } from "../src/features/ket-plan/ketRunLogic.ts";
import { computeFullResourceDemand, type FullResourceSummary, type RunDemand } from "../src/features/ket-plan/ketEquipmentSummary.ts";
import { parseExportRecipesCsv } from "../src/features/gsheet-monitor/parsers/parseExportRecipes.ts";
import type { RecipeWeightLookup } from "../src/features/gsheet-monitor/parsers/parseExportRecipes.ts";
import { wrBuildHintsFromDumps } from "../src/features/kitchen-mode/wrEquipmentHints.ts";
import { grossPlateable } from "../src/features/gsheet-monitor/mealProgress.ts";
import type { MealProgress, WoMatchedStatus } from "../src/features/gsheet-monitor/postblastMatch.ts";
import { computeBackfillFeasibility } from "../src/features/backfills/backfillFeasibility.ts";
import type { CombinedBackfillNeed } from "../src/features/backfills/backfillTypes.ts";
import type { FullInventoryRow } from "../src/features/wms-overview/wmsTypes.ts";

const ROOT = resolve(".");
const BUNDLE_PATH = join(ROOT, "public", "data", "data.json");
const RTI_SHEET_ID = process.env.RTI_SHEET_ID || "1-brEn6eKSMFDTubokqA7brq_BzjKP0RpmGw4A1RPspw";
const POSTBLAST_GID = "161435799";
const PREBLAST_GID = "152682456";
const WMS_LOCAL_URL = process.env.WMS_LOCAL_URL || "http://127.0.0.1:3141";
const FETCH_TIMEOUT_MS = 15_000;
// Unter diesem Wert zählt eine Abweichung als Rauschen, nicht als echter
// Backfill-Bedarf — gleiche Schwelle wie MIN_SUB_SHORTFALL (rtiBackfillCalculator.ts).
const MIN_SHORTFALL_PORTIONS = 30;

// ── Quell-Dateien (imports/-Ordner, siehe resolveSourceDir) ─────────────────

function findLatestMatching(dir: string, pattern: RegExp): string | null {
  if (!existsSync(dir)) return null;
  const cands = readdirSync(dir)
    .filter((f) => pattern.test(f))
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return cands[0]?.f ?? null;
}

function findLatestKetCsv(): string | null {
  const dir = resolveSourceDir();
  return findLatestMatching(dir, /^KET.*\.csv$/i) ?? findLatestMatching(join(homedir(), "Downloads"), /^KET.*\.csv$/i);
}

function findLatestExportRecipesCsv(): string | null {
  return findLatestMatching(resolveSourceDir(), /^export-recipes.*\.csv$/i);
}

function loadGnHints(): GnHints {
  try {
    const p = join(ROOT, "public", "data", "gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json");
    if (!existsSync(p)) return EMPTY_GN_HINTS;
    const bibles = JSON.parse(readFileSync(p, "utf8"));
    const { trayHints, pieceWeightKg } = wrBuildHintsFromDumps(null, bibles);
    return { trayHints, pieceWeightKg };
  } catch {
    return EMPTY_GN_HINTS;
  }
}

// ── Datum (Berlin) ───────────────────────────────────────────────────────────

function berlinIsoDate(date: Date, dayOffset: number): string {
  const shifted = new Date(date.getTime() + dayOffset * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(shifted);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ── Blast-Gewichte je WO (öffentliches gviz-CSV, kein Auth nötig) ──────────
// 1:1 dieselbe Technik wie fetchBlastWeightsByWo in functions/dailyBriefingSlack.js —
// hier separat, weil dieses Script keinen Zugriff auf functions/ hat (eigenes
// node_modules, würde firebase-functions als Nebeneffekt laden).
function numKg(s: string | undefined): number {
  if (!s) return 0;
  const cleaned = String(s).replace(/[,\s]/g, "").replace(/[^\d.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseGvizCsv(text: string): string[][] {
  // Minimal-Parser reicht: die Blast-Sheets haben keine Kommas/Anführungszeichen
  // in den relevanten Spalten (WO-Nummer, kg-Zahl).
  return text.split(/\r?\n/).filter((l) => l.length > 0).map((l) => l.split(","));
}

async function fetchBlastWeightsByWo(gid: string): Promise<Map<string, number>> {
  const url = `https://docs.google.com/spreadsheets/d/${RTI_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Blast-CSV gid=${gid} nicht lesbar (HTTP ${res.status})`);
  const rows = parseGvizCsv(await res.text());
  const byWo = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const wo = String(row[1] ?? "").trim();
    if (!wo) continue;
    byWo.set(wo, (byWo.get(wo) ?? 0) + numKg(row[2]));
  }
  return byWo;
}

// ── Vollbestand vom lokalen WMS-Server (Snowflake/Browser-SSO) ─────────────
// Best-effort: läuft der Server nicht oder ist Snowflake nicht verbunden,
// bleibt die Feasibility-Sektion einfach leer — kein Alarm, siehe
// rti-redzone-relay.ts für dasselbe Muster.
async function fetchFullInventory(): Promise<FullInventoryRow[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${WMS_LOCAL_URL}/wms-full-inventory`, { signal: ctrl.signal });
    if (!res.ok) { console.log(`WMS-Server antwortet mit ${res.status} — keine Feasibility-Pruefung.`); return null; }
    const body = (await res.json()) as { ok?: boolean; rows?: FullInventoryRow[] };
    if (!body?.ok || !Array.isArray(body.rows)) { console.log("WMS-Server: Antwort ohne rows — keine Feasibility-Pruefung."); return null; }
    return body.rows;
  } catch (e) {
    console.log(`Lokaler WMS-Server (${WMS_LOCAL_URL}) nicht erreichbar: ${(e as Error).message} — keine Feasibility-Pruefung.`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── Meal-Fortschritt aus KET-Plan + echten Postblast-Gewichten ────────────
// Baut MealProgress[] (Original-Typ aus postblastMatch.ts, NICHT dupliziert)
// direkt aus den KET-Zeilen + calcBatch.totalKg (Soll) + Postblast-Summe (Ist)
// — schlanker als der volle matchPostblastToWorkOrders-Pfad (der zusätzlich
// RTI-Overrides/unplanned-WO-Flags kennt, die hier nicht gebraucht werden),
// aber mit denselben WoMatchedStatus-Feldern, die grossPlateable/mealReadiness
// tatsächlich lesen (siehe mealProgress.ts).
function buildMealProgress(
  rows: KetRow[],
  calcMap: Map<string, BatchCalc>,
  postblastByWo: Map<string, number>,
  preblastByWo: Map<string, number>,
): MealProgress[] {
  const byMeal = new Map<string, WoMatchedStatus[]>();
  for (const row of rows) {
    const calc = calcMap.get(row.key);
    const plannedKg = calc?.totalKg ?? 0;
    const actualKg = postblastByWo.get(row.woNumber) ?? 0;
    const preBlastKg = preblastByWo.get(row.woNumber) ?? 0;
    const awaitingPostBlast = preBlastKg > 0 && actualKg === 0;
    const progressPct = plannedKg > 0 ? Math.min(100, (actualKg / plannedKg) * 100) : actualKg > 0 ? 100 : 0;
    const wo: WoMatchedStatus = {
      workOrder: row.woNumber, subRecipe: row.subRecipeName, recipeCode: row.recipeCode, recipeName: row.recipeName,
      plannedMeals: row.targetPortions, plannedKg, actualKg, progressPct, deltaKg: actualKg - plannedKg,
      isComplete: plannedKg > 0 && progressPct >= 95, isCritical: plannedKg > 0 && progressPct < 30 && actualKg === 0 && !awaitingPostBlast,
      hasPlan: plannedKg > 0, isEstimated: false, preBlastKg, shrinkKg: 0, shrinkPct: 0, awaitingPostBlast,
      preBlastLikelyDone: false, lastPreBlastWeighing: null, run: 1, weighings: [], lastWeighing: null,
      platingHoldingKg: 0, rtiStatus: null,
    };
    const list = byMeal.get(row.recipeCode) ?? [];
    list.push(wo);
    byMeal.set(row.recipeCode, list);
  }

  const meals: MealProgress[] = [];
  for (const [recipeCode, workOrders] of byMeal) {
    const completedWOs = workOrders.filter((w) => w.isComplete).length;
    const totalPlannedKg = workOrders.reduce((s, w) => s + w.plannedKg, 0);
    const totalActualKg = workOrders.reduce((s, w) => s + w.actualKg, 0);
    meals.push({
      recipeCode, recipeName: workOrders[0].recipeName,
      plannedMeals: workOrders.reduce((max, w) => Math.max(max, w.plannedMeals), 0),
      workOrders, totalPlannedKg, totalActualKg,
      progressPct: totalPlannedKg > 0 ? Math.min(100, (totalActualKg / totalPlannedKg) * 100) : 0,
      completedWOs, totalWOs: workOrders.length,
      criticalWOs: workOrders.filter((w) => w.isCritical),
    });
  }
  return meals;
}

// ── Minimaler CombinedBackfillNeed-Adapter ─────────────────────────────────
// computeBackfillFeasibility/computeOne lesen von einem CombinedBackfillNeed
// tatsächlich nur: recipeCode, recipeName, recommendedBackfillPortions,
// kitchenSubRecipes, platingShortageReasons (siehe backfillFeasibility.ts).
// Alle anderen Felder sind hier reine Typ-Fülle ohne Bedeutung für die
// Rechnung — die volle Cross-Source-Zusammenführung (combineBackfills.ts,
// ~560 Zeilen, braucht LinePlating/RTI/WMS-SKU-Live-Daten) wird hier bewusst
// NICHT nachgebaut, das wäre ein eigenes großes Feature für einen anderen Tag.
function buildCombinedNeed(meal: MealProgress, shortfallPortions: number, kitchenSubRecipes: string[]): CombinedBackfillNeed {
  return {
    recipeCode: meal.recipeCode, codeVariants: [meal.recipeCode], recipeName: meal.recipeName,
    kitchenMissingKg: 0, kitchenMissingPortions: shortfallPortions, kitchenPriority: "critical", kitchenSubRecipes,
    platingPlannedPortions: 0, platingShortagePortions: 0, platingShortageReasons: [], platingDaysAffected: [],
    lpShortfallPortions: 0, lpWeek: "", lpStatusText: "", minNeededPortions: null,
    backfillResultPortions: null, backfillResultComments: [], rtiHoldingKg: 0,
    rtiPlannedTarget: null, rtiActuals: null, rtiShortfallPortions: 0, rtiRecommendedBuffered: 0,
    rtiKitchenDone: false, rtiHasOpenSubs: false, rtiVetoed: false, rtiTargetEstimated: false,
    rtiTargetSourceLabel: "", rtiBackfillCandidateSubs: [], rtiSubShortfalls: [],
    liveWmsHoldingKg: null, liveRedzonePortions: null, liveRedzoneStatus: null,
    recommendedBackfillPortions: shortfallPortions, recommendedSource: "kitchen",
    confidence: "kitchen-only", priority: "critical",
  };
}

// Shortfall je Meal = Plan minus das, was die Küche laut echten Postblast-
// Gewichten (grossPlateable, mit Rezeptgewichten falls vorhanden) bislang
// geschafft hat. kitchenSubRecipes = die Subs, die noch nicht auf Zielgewicht
// sind — dieselbe 95%-Schwelle wie isComplete oben.
function buildBackfillCandidates(meals: MealProgress[], recipeWeights: RecipeWeightLookup | null): CombinedBackfillNeed[] {
  const out: CombinedBackfillNeed[] = [];
  for (const meal of meals) {
    if (meal.plannedMeals <= 0) continue;
    const gross = grossPlateable(meal, recipeWeights);
    const produced = gross?.meals ?? 0;
    const shortfall = Math.max(0, meal.plannedMeals - produced);
    if (shortfall < MIN_SHORTFALL_PORTIONS) continue;
    const openSubs = [...new Set(meal.workOrders.filter((w) => w.hasPlan && !w.isComplete).map((w) => w.subRecipe))];
    out.push(buildCombinedNeed(meal, shortfall, openSubs));
  }
  return out;
}

// ── Feasibility → kompakte Nachricht (Zwilling der Formatierung in
// buildFeasibilityItems, dailyBriefingLogic.ts) ────────────────────────────
function fmtMhd(iso: string | null): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }); } catch { return ""; }
}

function feasibilityMessage(f: { verdict: string; neededPortions: number; maxProduciblePortions: number; coveragePct: number; bottleneck: { ingredientName: string; nearestExpiry: string | null; expiredQty: number; uom: string }[] }): string {
  const b = f.bottleneck[0];
  const mhd = b ? fmtMhd(b.nearestExpiry) : "";
  const wareLabel = b
    ? mhd ? ` — Engpass: ${b.ingredientName} (Rest-Bestand MHD ${mhd})`
      : b.expiredQty > 0 ? ` — Engpass: ${b.ingredientName} (${Math.round(b.expiredQty)} ${b.uom} auf Lager, aber MHD abgelaufen)`
        : ` — Engpass: ${b.ingredientName}`
    : "";
  return f.verdict === "blocked"
    ? `Rohware fehlt komplett${wareLabel} (0/${Math.round(f.neededPortions)} Portionen möglich)`
    : `Rohware reicht nur für ${Math.round(f.maxProduciblePortions)}/${Math.round(f.neededPortions)} Portionen (${Math.round(f.coveragePct * 100)}%)${wareLabel}`;
}

// ── Equipment morgen → kompakte Firestore-Form ──────────────────────────────
function summarizeTomorrow(summary: FullResourceSummary, tomorrowIso: string): RunDemand[] {
  return summary.byRunDayShift.filter((rd) => rd.date === tomorrowIso);
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const tomorrowIso = berlinIsoDate(now, 1);

  const ketPath = findLatestKetCsv();
  if (!ketPath) {
    console.log("Keine KET*.csv im imports/-Ordner (oder Downloads) gefunden — Equipment/Feasibility werden ausgelassen.");
    return;
  }
  if (!existsSync(BUNDLE_PATH)) {
    console.log(`${BUNDLE_PATH} fehlt ('npm run import:local' ausführen) — Equipment/Feasibility werden ausgelassen.`);
    return;
  }

  const bundle = JSON.parse(readFileSync(BUNDLE_PATH, "utf8")) as DataBundle;
  const { rows, warnings } = parseKetCsv(readFileSync(ketPath, "utf8"));
  if (warnings.length) warnings.slice(0, 3).forEach((w) => console.warn(`  ⚠ ${w}`));
  console.log(`KET-CSV: ${ketPath} (${rows.length} Zeilen)`);

  const recipeWeightsPath = findLatestExportRecipesCsv();
  const recipeWeights = recipeWeightsPath ? parseExportRecipesCsv(readFileSync(recipeWeightsPath, "utf8")) : null;
  console.log(recipeWeightsPath ? `Rezeptgewichte: ${recipeWeightsPath}` : "Keine export-recipes*.csv gefunden — Feasibility nutzt Planverhältnis-Fallback.");

  const gnHints = loadGnHints();
  const calcMap = new Map<string, BatchCalc>();
  for (const row of rows) calcMap.set(row.key, calcBatch(row, EQUIP_DEFAULTS as Record<string, number>, bundle, undefined as ManualEquipmentOverride | null | undefined, undefined, gnHints));

  // ── Equipment morgen ───────────────────────────────────────────────────
  const runAssignments = computeRunAssignments(rows);
  const fullSummary = computeFullResourceDemand(rows, calcMap, runAssignments);
  const tomorrowRuns = summarizeTomorrow(fullSummary, tomorrowIso);
  const equipmentTomorrow = tomorrowRuns.length > 0 ? { date: tomorrowIso, runs: tomorrowRuns } : null;
  console.log(equipmentTomorrow
    ? `Equipment morgen (${tomorrowIso}): ${tomorrowRuns.length} Run/Schicht-Gruppe(n), ${tomorrowRuns.reduce((s, r) => s + r.totalWos, 0)} WOs.`
    : `Equipment morgen (${tomorrowIso}): keine WOs im KET-Plan für diesen Tag.`);

  // ── Feasibility offener Backfills ──────────────────────────────────────
  let feasibilityOut: { recipeCode: string; recipeName: string; verdict: string; message: string }[] = [];
  const fullInventoryRows = await fetchFullInventory();
  if (fullInventoryRows && fullInventoryRows.length > 0) {
    try {
      const [postblastByWo, preblastByWo] = await Promise.all([
        fetchBlastWeightsByWo(POSTBLAST_GID),
        fetchBlastWeightsByWo(PREBLAST_GID),
      ]);
      const meals = buildMealProgress(rows, calcMap, postblastByWo, preblastByWo);
      const combined = buildBackfillCandidates(meals, recipeWeights);
      const feasibilityMap = computeBackfillFeasibility(combined, bundle, fullInventoryRows);
      for (const f of feasibilityMap.values()) {
        if (f.verdict !== "blocked" && f.verdict !== "partial") continue;
        const need = combined.find((c) => c.recipeCode === f.recipeCode);
        feasibilityOut.push({
          recipeCode: f.recipeCode, recipeName: need?.recipeName ?? f.recipeCode,
          verdict: f.verdict, message: feasibilityMessage(f),
        });
      }
      console.log(`Feasibility: ${combined.length} Backfill-Kandidat(en) geprüft, ${feasibilityOut.length} blockiert/teilweise.`);
    } catch (e) {
      console.warn(`Feasibility-Berechnung fehlgeschlagen: ${(e as Error).message} — Sektion wird ausgelassen.`);
      feasibilityOut = [];
    }
  } else {
    console.log("Kein WMS-Vollbestand verfügbar — Feasibility-Sektion wird ausgelassen.");
  }

  // ── Firestore-Snapshot schreiben ────────────────────────────────────────
  configureFirestoreWriterAuth();
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const ref = admin.firestore().collection("apps").doc("rezeptlogik").collection("dailyBriefing").doc("relaySnapshot");
  await ref.set({
    updatedAt: Date.now(), updatedIso: now.toISOString(),
    equipmentTomorrow, feasibility: feasibilityOut,
  });
  console.log("Firestore-Snapshot geschrieben: apps/rezeptlogik/dailyBriefing/relaySnapshot");
}

main().catch((e) => { console.error(e); process.exit(1); });
