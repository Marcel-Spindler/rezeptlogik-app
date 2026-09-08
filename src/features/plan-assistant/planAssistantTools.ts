// Werkzeuge für „Frag den Plan" — Deklarationen (an Gemini) + Ausführung (im
// Client, gegen die Live-Daten). Der Agent-Loop in planAssistantAgent.ts ruft
// executeClientTool() für die Lese-/Simulations-Tools; die propose_*- und
// check_plan_issues-Tools sind terminal und werden dort abgefangen.

import type { DataBundle, Recipe } from "../../core/types";
import { codeDigits, fmtNum, resolveRecipeByCode } from "../../lib/helpers";
import { getBaseVerdenVolume } from "../../lib/equipment";
import type { PlannerDay } from "../../lib/planner";
import type { WoReconciliationState } from "../wo-reconciliation/WoReconciliationContext";
import type { BackfillsState } from "../backfills/BackfillsContext";
import {
  assignRunsToShifts, computeDayLoads, generatePlatingPlan, summarizePlatingPlan,
} from "../plating-plan/platingPlanLogic";
import {
  applyDayPlanMoves, describeDayPlan, generateAllDayPlans, summarizeDayPlan,
} from "../plating-plan/platingDayLogic";
import { PLATING_DAYS, type PlatingDay, type PlatingWeekPlan } from "../plating-plan/platingPlanTypes";
import { describeKitchenPlan, generateKitchenPlan } from "../kitchen-plan/kitchenPlanLogic";

export interface ToolContext {
  data: DataBundle;
  week: string;
  upliftPercent: number;
  reconciliation: WoReconciliationState | null;
  backfills: BackfillsState | null;
  platingPlan: PlatingWeekPlan | null;
}

export const TERMINAL_TOOLS = new Set([
  "check_plan_issues", "propose_plating_plan", "propose_day_plating_change",
]);

/** Erzeugt einen Plating-Plan und wendet Move-/Notiz-Deltas an (für Sim + Apply).
 *  `basePlan` (falls vorhanden) liefert die gespeicherten Params + Tages-Kapazität,
 *  damit von Hand gepflegte Stellschrauben nicht verloren gehen. */
export function buildPlatingPlanWithMoves(
  data: DataBundle, week: string,
  firstRunPct: number | undefined,
  moves: Array<{ code: string; runIndex: number; day: string }>,
  notes: Array<{ code: string; note: string }>,
  basePlan?: PlatingWeekPlan | null,
  withDailyPlans = false,
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
  // Re-run shift assignment after manual moves
  const withShifts = assignRunsToShifts(plan);
  const out: PlatingWeekPlan = { ...withShifts, updatedAt: new Date().toISOString() };
  if (withDailyPlans || basePlan?.dailyPlans) out.dailyPlans = generateAllDayPlans(out);
  return out;
}

// ─── Gemini-Funktionsdeklarationen ─────────────────────────────────────────────
const DAY_MOVE_DAY = { type: "STRING", description: "Produktionstag Mo/Di/Mi/Do/Fr/Sa" } as const;
const DAY_MOVE_ITEM = {
  type: "OBJECT",
  properties: {
    code: { type: "STRING", description: "Meal-Code des zu verschiebenden Slots, z. B. FV0035A" },
    runIndex: { type: "NUMBER", description: "Optional: welcher Run (1/2), falls das Meal an dem Tag mehrfach läuft" },
    toLine: { type: "NUMBER", description: "Ziel-Linie (1-basiert). (Linienzahl+1) = neue Overload-Linie, sofern die Tageskapazität weitere Linien zulässt." },
    toIndex: { type: "NUMBER", description: "Optional: 0-basierte Einfüge-Position auf der Ziel-Linie; leer = ans Ende" },
  },
  required: ["code", "toLine"],
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
      name: "get_kitchen_plan",
      description: "Der abgeleitete Kochplan: pro Küchentag (Mo–Fr) die zu fertigenden Sub-Meals, gruppiert nach Küchenbereich (Braiser / Middle Kitchen / Brine-Grill / Oven), mit Portionen, kg, Batches und aktiver Kochzeit. Küchentag = Plating-Tag − Vorlauf (aus dem Cook Schedule). Braucht einen gespeicherten Wochen-Plating-Plan.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "get_plating_plan",
      description: "Der aktuell gespeicherte Wochen-Plating-Plan (Meals links, KW-Tage rechts, Runs). Zeigt auch ob schon ein (evtl. von Hand angepasster) Plan existiert.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "generate_plating_plan",
      description: "Erzeugt den Wochen-Plating-Plan aus dem Ramp-Up nach den Regeln (Demand=BENL+NORD+DE; ≤2250 → 1 Run +10%; >2250 → 2 Runs +5%, Run 1 = First-Run%; Seafood 1. Run so SPÄT wie möglich (Do); bis Do jedes Meal 1×; Fr/Sa reduziert; Complexity Score cx: komplex→früh, einfach→flexibel/Montag). Bei Tagen mit 2 Schichten wird automatisch Früh-/Spätschicht zugewiesen (Frühschicht füllen, Spätschicht = Rest). Speichert NICHT — nur zur Ansicht/Bewertung. NACH DEM GENERIEREN: Ergebnis prüfen (Überkapazität, Seafood-Platzierung, Balance), dann simulate_plating_change für Verbesserungen, dann propose_plating_plan.",
      parameters: {
        type: "OBJECT",
        properties: { firstRunPct: { type: "NUMBER", description: "0.62–0.72; leer = KW-Default (meist 0.70)" } },
      },
    },
    {
      name: "get_day_plating_plan",
      description: "Der tägliche Linienplan (Phase 3): Meals je Tag auf Plating-Linien aufsteigend nach Allergenen sequenziert (kein Allergen → viele). Zeigt Reinigungen (Allergen-Wegfall = Saubermach-Aktion), easy Changeovers (nur zufügen), Besetzung (⌈Sub-Meals × platerFactor⌉ + feste Helfer je Linie, beides KW-Parameter) und Carry-over auf den Folgetag (Seafood/komplex = kritisch). Ohne Argument: alle Tage; mit `day`: nur dieser Tag.",
      parameters: { type: "OBJECT", properties: { day: { type: "STRING", description: "Mo/Di/Mi/Do/Fr/Sa — leer = alle" } } },
    },
    {
      name: "generate_day_plating_plan",
      description: "Baut aus dem Wochen-Plating-Plan die täglichen Linienpläne: L1 Highrunner = größter sauberer Block (0 Reinigungen), L2 Flex nimmt die Reinigungen auf, L3 Overload nur wenn L1+L2 das Volumen nicht fassen. Gibt Reinigungen, easy Changeovers, Rüst-Minuten und (kritisches) Carry-over je Tag zurück. Speichert NICHT.",
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "simulate_day_plating_change",
      description: "Verschiebt einzelne Slots im täglichen Linienplan EINES Tages PROBEWEISE (auf eine andere Linie / Position) und rechnet Umrüsten, Reinigungen und Carry-over neu. Gibt vorher/nachher zurück (Reinigungen, easy, Rüst-min, Linien über Kapazität, Carry-over). Nutzt den gespeicherten Tagesplan als Basis — vorher ggf. generate_day_plating_plan. IMMER vor propose_day_plating_change.",
      parameters: {
        type: "OBJECT",
        properties: { day: DAY_MOVE_DAY, moves: { type: "ARRAY", items: DAY_MOVE_ITEM } },
        required: ["day", "moves"],
      },
    },
    {
      name: "propose_day_plating_change",
      description: "TERMINAL. Legt dem Nutzer die Umsortierung des täglichen Linienplans eines Tages zur Bestätigung vor (verschobene Slots + Begründung). Ändert nur diesen einen Tag, nicht die ganze Woche. Erst nach simulate_day_plating_change.",
      parameters: {
        type: "OBJECT",
        properties: {
          day: DAY_MOVE_DAY,
          moves: { type: "ARRAY", items: DAY_MOVE_ITEM },
          summary: { type: "STRING", description: "Was wird umsortiert, warum, + Simulations-Ergebnis (Reinigungen/Carry-over vorher→nachher)" },
        },
        required: ["day", "moves", "summary"],
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
          regenerateDailyPlans: { type: "BOOLEAN", description: "true = zusätzlich die täglichen Linienpläne (Phase 2) neu bauen" },
          summary: { type: "STRING", description: "Was wurde geplant + Simulations-Ergebnis (Tageslast/Engpässe)" },
        },
        required: ["summary"],
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

// ── Tag-Normalisierung (auch für den Plating-Apply-Pfad genutzt) ──────────────
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

function toolGetKitchenPlan(_args: Record<string, unknown>, ctx: ToolContext) {
  if (!ctx.platingPlan) return { note: `Für ${ctx.week} ist noch kein Plating-Plan gespeichert — der Kochplan baut darauf auf. generate_plating_plan erzeugt den Rohbau.` };
  const kp = generateKitchenPlan(ctx.data, ctx.platingPlan);
  return { plan: describeKitchenPlan(kp) };
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

function toolGetDayPlating(args: Record<string, unknown>, ctx: ToolContext) {
  const daily = ctx.platingPlan?.dailyPlans ?? {};
  const days = PLATING_DAYS.filter(d => daily[d]);
  if (!days.length) return { note: "Noch keine täglichen Linienpläne. generate_day_plating_plan baut sie." };
  const want = typeof args.day === "string" ? normalizeDay(args.day) : null;
  const pick = want && daily[want as PlatingDay] ? [want as PlatingDay] : days;
  return { days: pick.map(d => describeDayPlan(daily[d]!)) };
}

function toolGenerateDayPlating(_args: Record<string, unknown>, ctx: ToolContext) {
  const base = ctx.platingPlan ?? generatePlatingPlan(ctx.data, ctx.week);
  const daily = generateAllDayPlans(base);
  const days = PLATING_DAYS.filter(d => daily[d]);
  return {
    warning: ctx.platingPlan?.dailyPlans ? "Es gibt bereits Tagespläne — generieren würde sie ersetzen." : undefined,
    perDay: days.map(d => {
      const s = summarizeDayPlan(daily[d]!);
      return `${d}: ${s.totalPortions} P · ${s.slots} Slots · ${s.cleaningActions} Reinigungen${s.easyChangeovers ? ` (+${s.easyChangeovers} easy)` : ""} (${s.changeoverMin} min)${s.linesOver ? ` · ⚠ ${s.linesOver} Linie(n) über Kapazität` : ""}${s.carryOut ? ` · Carry-over ${s.carryOut} P${s.carryOutCritical ? ` (${s.carryOutCritical} kritisch)` : ""}` : ""}`;
    }),
    detail: days.map(d => describeDayPlan(daily[d]!)),
  };
}

function toolSimulatePlating(args: Record<string, unknown>, ctx: ToolContext) {
  const frp = typeof args.firstRunPct === "number" ? args.firstRunPct : undefined;
  const moves = (Array.isArray(args.moves) ? args.moves : []) as Array<{ code: string; runIndex: number; day: string }>;
  const plan = buildPlatingPlanWithMoves(ctx.data, ctx.week, frp, moves, [], ctx.platingPlan);
  const loads = computeDayLoads(plan);
  return {
    appliedMoves: moves.length,
    dayLoads: loads.filter(l => l.lines > 0 || l.portions > 0).map(l => {
      let line = `${l.day}: ${l.portions} P · ${l.meals} Runs · ${l.lines}L/${l.availableHours}h${l.shifts > 1 ? ` (${l.shifts}S)` : ""} · ~${l.perHourPerLine}/h/L${l.overCapacity ? " ⚠ ÜBER" : ""}`;
      if (l.shiftLoads) {
        for (const sl of l.shiftLoads) {
          if (sl.portions > 0) line += ` | ${sl.shift === "früh" ? "Früh" : "Spät"}: ${sl.portions}P ${sl.neededHours}/${sl.availableHours}h${sl.overCapacity ? " ⚠" : ""}`;
        }
      }
      return line;
    }),
    overCapacityDays: loads.filter(l => l.overCapacity).map(l => l.day),
    unassigned: plan.meals.filter(m => m.runs.some(r => !r.day && r.portions > 0)).map(m => m.code),
  };
}

function toolSimulateDayPlating(args: Record<string, unknown>, ctx: ToolContext) {
  const plan = ctx.platingPlan;
  if (!plan?.dailyPlans || !Object.keys(plan.dailyPlans).length) {
    return { error: "Noch keine täglichen Linienpläne. generate_day_plating_plan baut sie zuerst." };
  }
  const day = normalizeDay(String(args.day ?? ""));
  if (!day || !plan.dailyPlans[day as PlatingDay]) {
    return { error: `Kein Tagesplan für „${args.day}". Vorhanden: ${PLATING_DAYS.filter(d => plan.dailyPlans?.[d]).join(", ") || "—"}` };
  }
  const moves = (Array.isArray(args.moves) ? args.moves : []) as Array<{ code: string; runIndex?: number; toLine: number; toIndex?: number }>;
  if (!moves.length) return { error: "Keine moves übergeben." };

  const dpBefore = plan.dailyPlans[day as PlatingDay]!;
  const before = summarizeDayPlan(dpBefore);
  const { dayPlan, applied, skipped } = applyDayPlanMoves(dpBefore, plan, moves);
  const after = summarizeDayPlan(dayPlan);
  const brief = (s: typeof before) => ({
    reinigungen: s.cleaningActions, easy: s.easyChangeovers, ruestMin: s.changeoverMin,
    linienUeberKapazitaet: s.linesOver, carryOver: s.carryOut, carryOverKritisch: s.carryOutCritical,
  });
  return {
    day, applied, skipped,
    before: brief(before),
    after: brief(after),
    verdict: after.cleaningActions <= before.cleaningActions && after.carryOut <= before.carryOut + 1 && after.linesOver <= before.linesOver
      ? "besser oder gleich"
      : "verschlechtert mindestens eine Kennzahl — abwägen",
    detail: describeDayPlan(dayPlan),
  };
}

const EXECUTORS: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => unknown> = {
  get_recipe_detail: toolGetRecipeDetail,
  get_backfill_detail: toolGetBackfillDetail,
  get_wo_trace: toolGetWoTrace,
  get_kitchen_plan: toolGetKitchenPlan,
  get_plating_plan: toolGetPlatingPlan,
  generate_plating_plan: toolGeneratePlating,
  get_day_plating_plan: toolGetDayPlating,
  generate_day_plating_plan: toolGenerateDayPlating,
  simulate_plating_change: toolSimulatePlating,
  simulate_day_plating_change: toolSimulateDayPlating,
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
