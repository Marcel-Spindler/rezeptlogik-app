// Werkzeuge für „Frag den Plan" — Deklarationen (an Gemini) + Ausführung (im
// Client, gegen die Live-Daten). Der Agent-Loop in planAssistantAgent.ts ruft
// executeClientTool() für die Lese-/Simulations-Tools; propose_plan_change und
// check_plan_issues sind terminal und werden dort abgefangen.

import type { DataBundle, Recipe } from "../../core/types";
import { codeDigits, fmtNum, resolveRecipeByCode } from "../../lib/helpers";
import {
  getBaseVerdenVolume, loadStationDeviceCounts, loadStationPools, DEFAULT_SHIFT_MIN,
} from "../../lib/equipment";
import {
  analyzePlan, assignRecipe, getActiveScenario, loadPlannerStorage, suggestAssignments,
  PLANNER_SHIFTS, type PlannerDay, type PlannerShift,
} from "../../lib/planner";
import { buildBoardNote, composeBoardNotes } from "../planning-oasis/cockpit/slotScheduling";
import type { WoReconciliationState } from "../wo-reconciliation/WoReconciliationContext";
import type { BackfillsState } from "../backfills/BackfillsContext";
import {
  computeDayLoads, generatePlatingPlan, summarizePlatingPlan,
} from "../plating-plan/platingPlanLogic";
import { PLATING_DAYS, type PlatingWeekPlan } from "../plating-plan/platingPlanTypes";
import type { PlanChange } from "./planAssistantTypes";

export interface ToolContext {
  data: DataBundle;
  week: string;
  upliftPercent: number;
  reconciliation: WoReconciliationState | null;
  backfills: BackfillsState | null;
  platingPlan: PlatingWeekPlan | null;
}

export const TERMINAL_TOOLS = new Set(["propose_plan_change", "check_plan_issues", "propose_plating_plan"]);

/** Erzeugt einen Plating-Plan und wendet Move-/Notiz-Deltas an (für Sim + Apply).
 *  `basePlan` (falls vorhanden) liefert die gespeicherten Params + Tages-Kapazität,
 *  damit von Hand gepflegte Stellschrauben nicht verloren gehen. */
export function buildPlatingPlanWithMoves(
  data: DataBundle, week: string,
  firstRunPct: number | undefined,
  moves: Array<{ code: string; runIndex: number; day: string }>,
  notes: Array<{ code: string; note: string }>,
  basePlan?: PlatingWeekPlan | null,
): PlatingWeekPlan {
  const paramsOverride = {
    ...(basePlan?.params ?? {}),
    ...(typeof firstRunPct === "number" ? { firstRunPct } : {}),
  };
  const plan = generatePlatingPlan(data, week, paramsOverride, basePlan?.dayCapacity);
  const dayOk = new Set(PLATING_DAYS as readonly string[]);
  for (const mv of moves) {
    const meal = plan.meals.find(m => codeDigits(m.code) === codeDigits(mv.code));
    if (!meal || !dayOk.has(mv.day)) continue;
    const run = meal.runs.find(r => r.runIndex === mv.runIndex);
    if (run) run.day = mv.day as typeof PLATING_DAYS[number];
  }
  for (const nt of notes) {
    const meal = plan.meals.find(m => codeDigits(m.code) === codeDigits(nt.code));
    if (meal) meal.note = nt.note;
  }
  return { ...plan, updatedAt: new Date().toISOString() };
}

// ─── Gemini-Funktionsdeklarationen ─────────────────────────────────────────────
const CHANGE_ITEM = {
  type: "OBJECT",
  properties: {
    recipeCode: { type: "STRING", description: "Rezept-Code, z. B. FV0035A" },
    subRecipeId: { type: "STRING", description: "Nur bei separat geplantem Sub-Rezept" },
    day: { type: "STRING", description: "Produktionstag Mo/Di/Mi/Do/Fr/Sa (Küche Mo–Fr)" },
    shift: { type: "STRING", description: "S1=Früh, S2=Spät" },
    targetPortions: { type: "NUMBER", description: "Optional: Ziel-Portionszahl" },
    splitSpec: { type: "STRING", description: "Optional: Batch-Split, z. B. Do:400|Fr:1200" },
    reason: { type: "STRING", description: "Kurze Begründung" },
  },
  required: ["recipeCode", "day", "shift", "reason"],
} as const;

export const TOOL_DECLARATIONS = [{
  functionDeclarations: [
    {
      name: "get_recipe_detail",
      description: "Vollständige Rezept-Details: Sub-Rezepte mit Kochmethode/Station, Allergene je Markt, Top-Brutto-Zutaten. Nutzen, bevor man über ein konkretes Meal urteilt.",
      parameters: {
        type: "OBJECT",
        properties: { recipeCode: { type: "STRING" } },
        required: ["recipeCode"],
      },
    },
    {
      name: "get_backfill_detail",
      description: "Nachproduktions-Bedarf + Rohware-Machbarkeit für ein Meal: Fehlmengen je Quelle (Küche/Plating/RTI), Engpass-Zutaten aus dem WMS-Vollbestand.",
      parameters: {
        type: "OBJECT",
        properties: { recipeCode: { type: "STRING" } },
        required: ["recipeCode"],
      },
    },
    {
      name: "get_wo_trace",
      description: "Cross-Source-Abgleich einer Work Order oder eines Rezept-Codes: Portionen/kg je Quelle (App-Plan, KET, PET, Ist-Wiegung), Mismatches, Production-Plan-Zeilen mit Status.",
      parameters: {
        type: "OBJECT",
        properties: { query: { type: "STRING", description: "WO-Nummer (z. B. 23-175) oder Rezept-Code" } },
        required: ["query"],
      },
    },
    {
      name: "simulate_plan_change",
      description: "Wendet vorgeschlagene Assignment-Änderungen NUR probeweise an (nichts wird gespeichert) und gibt zurück, welche Stations-/Pool-Engpässe dadurch neu entstehen oder wegfallen. IMMER vor propose_plan_change aufrufen.",
      parameters: {
        type: "OBJECT",
        properties: { changes: { type: "ARRAY", items: CHANGE_ITEM } },
        required: ["changes"],
      },
    },
    {
      name: "suggest_assignments",
      description: "Automatischer Vorschlag, an welchem Tag/welcher Schicht die noch ungeplanten Meals am besten laufen (Lead-Class rückwärts vom Plating-Tag, Kapazitäts-bewusst).",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "get_capacity_overview",
      description: "Auslastung je Station und Tag/Schicht im aktuellen Plan (auch unter 100%) — zeigt, wo noch Kapazität frei ist.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "get_plating_plan",
      description: "Der aktuell gespeicherte Wochen-Plating-Plan (Meals links, KW-Tage rechts, Runs). Zeigt auch ob schon ein (evtl. von Hand angepasster) Plan existiert.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "generate_plating_plan",
      description: "Erzeugt den Wochen-Plating-Plan aus dem Ramp-Up nach den Regeln (Demand=BENL+NORD+DE; ≤2250 → 1 Run +10%; >2250 → 2 Runs +5%, Run 1 = First-Run%; Seafood 1. Run ≥ Mi; bis Do jedes Meal 1×; Fr/Sa reduziert; Complexity Score cx: komplex → 1. Run früh, einfach → flexibel/Montag). Speichert NICHT — nur zur Ansicht/Bewertung.",
      parameters: {
        type: "OBJECT",
        properties: { firstRunPct: { type: "NUMBER", description: "0.62–0.72; leer = KW-Default (meist 0.70)" } },
      },
    },
    {
      name: "simulate_plating_change",
      description: "Generiert den Plating-Plan und wendet Run→Tag-Verschiebungen probeweise an; gibt die Tages-Auslastung (Portionen, Linien, Std, Über-Kapazität) zurück. Vor propose_plating_plan nutzen.",
      parameters: {
        type: "OBJECT",
        properties: {
          firstRunPct: { type: "NUMBER" },
          moves: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                code: { type: "STRING" },
                runIndex: { type: "NUMBER", description: "1 oder 2" },
                day: { type: "STRING", description: "Mo/Di/Mi/Do/Fr/Sa" },
              },
              required: ["code", "runIndex", "day"],
            },
          },
        },
      },
    },
    {
      name: "propose_plating_plan",
      description: "TERMINAL. Legt dem Nutzer den Wochen-Plating-Plan zur Bestätigung vor (First-Run%, Tag-Verschiebungen ggü. der Auto-Generierung, Notizen). Erst nach simulate_plating_change.",
      parameters: {
        type: "OBJECT",
        properties: {
          firstRunPct: { type: "NUMBER" },
          moves: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { code: { type: "STRING" }, runIndex: { type: "NUMBER" }, day: { type: "STRING" } },
              required: ["code", "runIndex", "day"],
            },
          },
          notes: {
            type: "ARRAY",
            items: { type: "OBJECT", properties: { code: { type: "STRING" }, note: { type: "STRING" } }, required: ["code", "note"] },
          },
          summary: { type: "STRING", description: "Was wurde geplant + Simulations-Ergebnis (Tageslast/Engpässe)" },
        },
        required: ["summary"],
      },
    },
    {
      name: "propose_plan_change",
      description: "TERMINAL. Legt dem Nutzer Assignment-Änderungen zur Bestätigung vor. Erst nach simulate_plan_change nutzen.",
      parameters: {
        type: "OBJECT",
        properties: {
          changes: { type: "ARRAY", items: CHANGE_ITEM },
          summary: { type: "STRING", description: "Was wird geändert, warum, + Simulations-Ergebnis" },
        },
        required: ["changes", "summary"],
      },
    },
    {
      name: "check_plan_issues",
      description: "TERMINAL. Strukturierte Liste von Risiken/Problemen/Optimierungen im Plan.",
      parameters: {
        type: "OBJECT",
        properties: {
          issues: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                severity: { type: "STRING", description: "critical | warning | info" },
                description: { type: "STRING" },
                affectedRecipes: { type: "ARRAY", items: { type: "STRING" } },
                suggestion: { type: "STRING" },
              },
              required: ["severity", "description"],
            },
          },
        },
        required: ["issues"],
      },
    },
  ],
}];

// ─── Ausführung (Client-seitig) ───────────────────────────────────────────────

function analyzeOpts(upliftPercent: number) {
  return {
    portionMultiplier: 1 + (upliftPercent || 0) / 100,
    shiftCapacityMin: DEFAULT_SHIFT_MIN,
    stationDeviceCounts: loadStationDeviceCounts(),
    stationPools: loadStationPools(),
  };
}

function findRecipe(data: DataBundle, code: string): Recipe | undefined {
  const byCode = Object.fromEntries((Object.values(data.recipes ?? {}) as Recipe[]).map(r => [r.code, r]));
  return resolveRecipeByCode(byCode, code)
    ?? (Object.values(data.recipes ?? {}) as Recipe[]).find(r => codeDigits(r.code) === codeDigits(code));
}

function toolGetRecipeDetail(args: Record<string, unknown>, ctx: ToolContext) {
  const code = String(args.recipeCode ?? "").trim();
  const recipe = findRecipe(ctx.data, code);
  const wr = ctx.data.weekRecipes.find(w => w.hfWeek === ctx.week && codeDigits(w.code) === codeDigits(code));
  if (!recipe && !wr) return { error: `Kein Rezept/Meal zu ${code} in ${ctx.week}` };

  const markets = recipe
    ? Object.values(recipe.markets).map(md => ({
        market: md.market,
        allergens: md.allergens || "",
        subRecipes: md.subRecipes.map(s => ({ id: s.id, name: s.name, cookMethod: s.category, yield: s.yield ?? null })),
      }))
    : [];
  const grossTop = recipe
    ? (Object.values(recipe.grossIngredients)[0] ?? [])
        .slice()
        .sort((a, b) => (b.grossQuantityPerPortion || 0) - (a.grossQuantityPerPortion || 0))
        .slice(0, 12)
        .map(g => `${g.ingredient} ${g.grossQuantityPerPortion}${g.uom}`)
    : [];

  return {
    code: recipe?.code ?? wr?.code ?? code,
    name: recipe?.baseName ?? wr?.recipeName,
    preference: wr?.preference ?? null,
    portionsThisWeek: wr ? Math.round(getBaseVerdenVolume(wr) * (1 + (ctx.upliftPercent || 0) / 100)) : null,
    marketSplit: wr ? wr.verdenVolume : null,
    markets,
    topGrossIngredients: grossTop,
  };
}

function toolGetBackfillDetail(args: Record<string, unknown>, ctx: ToolContext) {
  const code = String(args.recipeCode ?? "").trim();
  if (!ctx.backfills) return { error: "Backfill-Daten nicht geladen (kein lokaler Server / keine GSheet-Verbindung)." };
  const combined = ctx.backfills.combined.find(c => codeDigits(c.recipeCode) === codeDigits(code));
  const feas = [...ctx.backfills.feasibilityByMeal.entries()].find(([k]) => codeDigits(k) === codeDigits(code))?.[1];
  if (!combined && !feas) return { note: `Kein Backfill-Bedarf für ${code}.` };
  return {
    recipeCode: combined?.recipeCode ?? code,
    kitchenMissingPortions: combined?.kitchenMissingPortions ?? 0,
    platingShortagePortions: combined?.platingShortagePortions ?? 0,
    minNeededPortions: combined?.minNeededPortions ?? null,
    kitchenPriority: combined?.kitchenPriority ?? null,
    feasibility: feas ? {
      verdict: feas.verdict,
      maxProduciblePortions: feas.maxProduciblePortions,
      coveragePct: Math.round((feas.coveragePct ?? 0) * 100),
      bottlenecks: feas.bottleneck.slice(0, 6).map(b => `${b.ingredientName}: ${fmtNum(b.availableQty)} ${b.uom} verfügbar → max ${fmtNum(b.maxPortions)} Portionen`),
    } : null,
  };
}

function toolGetWoTrace(args: Record<string, unknown>, ctx: ToolContext) {
  const q = String(args.query ?? "").trim();
  const isWo = /^\d{1,3}-\d+$/.test(q);
  const rec = ctx.reconciliation?.rows.filter(r =>
    isWo ? r.workOrder === q : codeDigits(r.recipeCode) === codeDigits(q),
  ) ?? [];
  const pp = (ctx.data.productionPlan?.rows ?? []).filter(r =>
    isWo ? r.workOrder === q : codeDigits(r.recipeCode) === codeDigits(q),
  );
  if (!rec.length && !pp.length) return { note: `Nichts zu „${q}" in Abgleich/Production-Plan.` };
  return {
    reconciliation: rec.slice(0, 20).map(r => ({
      wo: r.workOrder, recipe: r.recipeCode, sub: r.subRecipe,
      presentIn: r.presentIn, severity: r.severity,
      appPortions: r.appPortions, ketPortions: r.ketPortions, petTarget: r.petTarget,
      appKg: r.appKg, actualKg: r.actualKg, progressPct: r.progressPct,
      mismatch: [r.kgMismatch && "kg", r.portionsMismatch && "Portionen", r.missingPetAssignment && "PET fehlt"].filter(Boolean),
    })),
    productionPlan: pp.slice(0, 30).map(r => ({
      wo: r.workOrder, day: r.kitchenDay, sub: r.subRecipe, meals: r.plannedMeals,
      kitchenStatus: r.kitchenStatus ?? null, stagingStatus: r.stagingStatus ?? null, yieldPct: r.yieldPct ?? null,
    })),
  };
}

function conflictSummary(a: ReturnType<typeof analyzePlan>) {
  return {
    plannedCount: a.plannedCount,
    unplannedCount: a.unplannedCount,
    stationConflicts: a.conflicts.map(c => `${c.station} ${c.day}/${c.shift} ${Math.round(c.utilizationPct)}%`),
    poolConflicts: a.poolConflicts.map(p => `${p.poolName} ${p.day}/${p.shift} ${Math.round(p.utilizationPct)}%`),
  };
}

function toolSimulate(args: Record<string, unknown>, ctx: ToolContext) {
  const changes = (Array.isArray(args.changes) ? args.changes : []) as PlanChange[];
  if (!changes.length) return { error: "Keine changes übergeben." };
  const opts = analyzeOpts(ctx.upliftPercent);
  const base = loadPlannerStorage();
  const scenario = getActiveScenario(base, ctx.week);
  const before = analyzePlan(ctx.data, ctx.week, scenario, opts);

  let tmp = base;
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const ch of changes) {
    const wr = ctx.data.weekRecipes.find(
      r => r.hfWeek === ctx.week && codeDigits(r.code) === codeDigits(ch.recipeCode),
    );
    const day = normalizeDay(ch.day);
    const shift = normalizeShift(ch.shift);
    if (!wr || !day || !shift) { skipped.push(`${ch.recipeCode} (${!wr ? "kein Meal" : !day ? "Tag?" : "Schicht?"})`); continue; }
    tmp = assignRecipe(tmp, ctx.week, scenario.id, wr, {
      subRecipeId: ch.subRecipeId || undefined,
      day, shift,
      targetPortions: typeof ch.targetPortions === "number" ? Math.max(0, Math.round(ch.targetPortions)) : undefined,
      note: buildBoardNote("Sim", composeBoardNotes("", ch.subRecipeId ? "" : (ch.splitSpec ?? ""))),
    });
    applied.push(`${wr.code}→${day}/${shift}`);
  }
  const after = analyzePlan(ctx.data, ctx.week, getActiveScenario(tmp, ctx.week), opts);
  const beforeSet = new Set(before.conflicts.map(c => `${c.station} ${c.day}/${c.shift}`));
  const afterSet = new Set(after.conflicts.map(c => `${c.station} ${c.day}/${c.shift}`));
  return {
    applied, skipped,
    before: conflictSummary(before),
    after: conflictSummary(after),
    newConflicts: [...afterSet].filter(x => !beforeSet.has(x)),
    resolvedConflicts: [...beforeSet].filter(x => !afterSet.has(x)),
    verdict: [...afterSet].some(x => !beforeSet.has(x)) ? "erzeugt neue Engpässe" : "keine neuen Engpässe",
  };
}

function toolSuggest(_args: Record<string, unknown>, ctx: ToolContext) {
  const storage = loadPlannerStorage();
  const scenario = getActiveScenario(storage, ctx.week);
  const suggestions = suggestAssignments(
    ctx.data, ctx.week, scenario, PLANNER_SHIFTS.slice(0, 2),
    analyzeOpts(ctx.upliftPercent),
  );
  const rows = Object.entries(suggestions).slice(0, 40).map(([key, s]) =>
    `${key}: ${s.day}/${s.shift} (Score ${Math.round(s.score)}) — ${s.reason}`,
  );
  return { count: rows.length, suggestions: rows };
}

function toolCapacity(_args: Record<string, unknown>, ctx: ToolContext) {
  const storage = loadPlannerStorage();
  const scenario = getActiveScenario(storage, ctx.week);
  const a = analyzePlan(ctx.data, ctx.week, scenario, analyzeOpts(ctx.upliftPercent));
  const counts = loadStationDeviceCounts();
  const rows: string[] = [];
  for (const [slot, perStation] of Object.entries(a.stationLoadBySlot)) {
    for (const [station, min] of Object.entries(perStation)) {
      if (!min) continue;
      const cap = (counts[station as keyof typeof counts] ?? 1) * DEFAULT_SHIFT_MIN;
      rows.push(`${slot.replace("__", "/")} ${station}: ${Math.round((min / cap) * 100)}% (${fmtNum(min)}/${fmtNum(cap)} min)`);
    }
  }
  rows.sort((x, y) => parseInt(y.split(": ")[1]) - parseInt(x.split(": ")[1]));
  return { slots: rows.slice(0, 40) };
}

// ── Tag/Schicht-Normalisierung (auch für den Apply-Pfad genutzt) ──────────────
export function normalizeDay(raw: string): PlannerDay | null {
  const s = String(raw ?? "").trim().toLowerCase();
  const map: Record<string, PlannerDay> = {
    mo: "Mo", montag: "Mo", monday: "Mo", di: "Di", dienstag: "Di", tuesday: "Di",
    mi: "Mi", mittwoch: "Mi", wednesday: "Mi", do: "Do", donnerstag: "Do", thursday: "Do",
    fr: "Fr", freitag: "Fr", friday: "Fr", sa: "Sa", samstag: "Sa", saturday: "Sa",
    so: "So", sonntag: "So", sunday: "So",
  };
  return map[s] ?? null;
}
export function normalizeShift(raw: string): PlannerShift | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s.startsWith("s1") || s.includes("früh") || s.includes("fruh") || s.includes("early") || s === "1") return "S1";
  if (s.startsWith("s2") || s.includes("spät") || s.includes("spat") || s.includes("late") || s === "2") return "S2";
  if (s.startsWith("s3") || s === "3") return "S3";
  return (PLANNER_SHIFTS as readonly string[]).includes(s.toUpperCase()) ? (s.toUpperCase() as PlannerShift) : null;
}

function toolGetPlatingPlan(_args: Record<string, unknown>, ctx: ToolContext) {
  if (!ctx.platingPlan) return { note: `Für ${ctx.week} ist noch kein Plating-Plan gespeichert. generate_plating_plan erzeugt den Rohbau.` };
  return { exists: true, source: ctx.platingPlan.source, plan: summarizePlatingPlan(ctx.platingPlan) };
}

function toolGeneratePlating(args: Record<string, unknown>, ctx: ToolContext) {
  const frp = typeof args.firstRunPct === "number" ? args.firstRunPct : undefined;
  const paramsOverride = {
    ...(ctx.platingPlan?.params ?? {}),
    ...(frp != null ? { firstRunPct: frp } : {}),
  };
  const plan = generatePlatingPlan(ctx.data, ctx.week, paramsOverride, ctx.platingPlan?.dayCapacity);
  return {
    warning: ctx.platingPlan ? "Es existiert bereits ein Plan — generieren würde ihn ersetzen." : undefined,
    plan: summarizePlatingPlan(plan),
  };
}

function toolSimulatePlating(args: Record<string, unknown>, ctx: ToolContext) {
  const frp = typeof args.firstRunPct === "number" ? args.firstRunPct : undefined;
  const moves = (Array.isArray(args.moves) ? args.moves : []) as Array<{ code: string; runIndex: number; day: string }>;
  const plan = buildPlatingPlanWithMoves(ctx.data, ctx.week, frp, moves, [], ctx.platingPlan);
  const loads = computeDayLoads(plan);
  return {
    appliedMoves: moves.length,
    dayLoads: loads.filter(l => l.lines > 0 || l.portions > 0).map(l =>
      `${l.day}: ${l.portions} P · ${l.meals} Runs · ${l.lines}L/${l.hours}h · ~${l.perHourPerLine}/h/L${l.overCapacity ? " ⚠ ÜBER" : ""}`),
    overCapacityDays: loads.filter(l => l.overCapacity).map(l => l.day),
    unassigned: plan.meals.filter(m => m.runs.some(r => !r.day && r.portions > 0)).map(m => m.code),
  };
}

const EXECUTORS: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => unknown> = {
  get_recipe_detail: toolGetRecipeDetail,
  get_backfill_detail: toolGetBackfillDetail,
  get_wo_trace: toolGetWoTrace,
  simulate_plan_change: toolSimulate,
  suggest_assignments: toolSuggest,
  get_capacity_overview: toolCapacity,
  get_plating_plan: toolGetPlatingPlan,
  generate_plating_plan: toolGeneratePlating,
  simulate_plating_change: toolSimulatePlating,
};

export function executeClientTool(name: string, args: Record<string, unknown>, ctx: ToolContext): unknown {
  const fn = EXECUTORS[name];
  if (!fn) return { error: `Unbekanntes Werkzeug: ${name}` };
  try {
    return fn(args, ctx);
  } catch (e) {
    return { error: `Werkzeug ${name} fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}` };
  }
}
