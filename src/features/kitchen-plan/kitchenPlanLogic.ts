// Deterministischer Kern des Kochplans. Reine Logik, kein React.
//
// Eingang: der gespeicherte Wochen-Plating-Plan (Meals → Runs → Plating-Tag) +
//   das DataBundle (Rezepte/Sub-Rezepte, PFEI-Batchgrößen, Cook Schedules).
// Ausgang: je Küchentag (So · Mo–Fr) und Schicht (Früh/Spät bzw. Tag) die zu
//   fertigenden Sub-Meals, gruppiert nach Küchenbereich, INNERHALB der Station
//   allergen-aufsteigend sequenziert (wenig → viele Allergene), mit Reinigungen,
//   Rüstzeiten und einer Mini-Zeitachse.
//
// Regeln:
//  - Küchentag = Plating-Tag − Vorlauf. Vorlauf aus dem Cook Schedule
//    (cookShifts → Tage, je Cook-Method überschreibbar).
//  - Saucen/Marinaden/Brine/Spice (langer Vorlauf) werden zusätzlich Richtung
//    Sonntag vorgezogen; der Sonntag läuft nur eine Schicht.
//  - Sa ist die Küche zu → „So" ist der Sonntag VOR der Woche (frühester Kochtag).
//  - Muss fertig sein, bevor das Plating kommt → die Zeitachse rechnet je Schicht.

import type { CookSchedule, DataBundle } from "../../core/types";
import { codeDigits, fmtNum, resolveCookSchedule } from "../../lib/helpers";
import { computeWeekLoad, type SubRecipeLoad } from "../../lib/equipment";
import { VF_COOK_SCHEDULES } from "../../data/cookSchedulesVF";
import { PLATING_DAYS, type PlatingDay, type PlatingWeekPlan } from "../plating-plan/platingPlanTypes";
import { areaForCookMethod, KITCHEN_AREA_ORDER, type KitchenArea } from "./kitchenAreas";
import {
  DEFAULT_KITCHEN_PARAMS, KITCHEN_DAYS,
  type KitchenBlock, type KitchenChangeover, type KitchenDayPlan, type KitchenOverride,
  type KitchenPlanParams, type KitchenScheduleStep, type KitchenShift, type KitchenShiftPlan,
  type KitchenSubJob, type KitchenWeekPlan,
} from "./kitchenPlanTypes";

const COMPLEX_CX = 1.15;
const WEEKDAY_SHIFTS: KitchenShift[] = ["früh", "spät"];

/** „Halt-Komponenten" — werden vorab gemacht und halten: Saucen, (Kompound-)
 *  Butter, Ketchup/Dips/Dressings, Marinaden, Brine, Spice, Stock/Broth. Kommen
 *  auf den Sonntag, wenn ihr Run bis zum Cutoff geplatet wird. Mehrschicht-
 *  Prozesse (cookShifts ≥ 2) kommen unabhängig von der Kategorie dazu — das ist
 *  die eigentliche „dauert am längsten"-Regel. */
const HOLD_PREP_CAT_RE = /\bsauce\b|ketchup|\bdip\b|dressing|\bglaze\b|chutney|relish|aioli|coulis|\bpesto\b|\bbutter\b|marinade|\bbrine\b|acid bath|spice portioning|spice blend|\bstock\b|\bbroth\b|\bcure\b|ferment/i;
const HOLD_PREP_NAME_RE = /\bsauce\b|ketchup|\bpesto\b|dressing|aioli|coulis|chutney|\bdip\b|\bglaze\b|marinade|\bbrine\b/i;

function round(n: number): number {
  return Math.max(0, Math.round(n));
}

function clampNum(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo;
}

function clampShifts(n: number): 1 | 2 | 3 {
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

/** Position eines Plating-Tags in der Küchen-Zeitachse So(0)·Mo(1)·…·Fr(5).
 *  Sa/So-Plating rechnet gegen Fr+1 (Küche Sa zu). */
function platingKitchenIdx(d: PlatingDay): number {
  switch (d) {
    case "Mo": return 1;
    case "Di": return 2;
    case "Mi": return 3;
    case "Do": return 4;
    case "Fr": return 5;
    default: return 6; // Sa / So
  }
}

/** Normaler Rückwärts-Vorlauf: Küchentag = Plating-Tag − Vorlauf, geklemmt auf
 *  **Mo…Fr**. Der Sonntag ist hier bewusst NICHT erreichbar — dort landen nur
 *  die leichten Sauce/Butter/Spice-Vorbereitungen über die explizite Sonntag-
 *  Regel (goSunday). So bleibt der Sonntag ein ruhiger Arbeitstag. */
export function kitchenDayFor(platingDay: PlatingDay, leadDays: number): PlatingDay {
  const idx = platingKitchenIdx(platingDay) - Math.max(1, Math.round(leadDays));
  return KITCHEN_DAYS[Math.max(1, Math.min(KITCHEN_DAYS.length - 1, idx))];
}

/** Vollständige Params auf einem (Teil-)Override aufsetzen + klemmen. */
export function resolveKitchenParams(override?: Partial<KitchenPlanParams>): KitchenPlanParams {
  const d = DEFAULT_KITCHEN_PARAMS;
  const o = override ?? {};
  const lead: Partial<Record<1 | 2 | 3, number>> = o.leadDaysByShift ?? {};
  return {
    leadDaysByShift: {
      1: clampNum(lead[1] ?? d.leadDaysByShift[1], 0, 6),
      2: clampNum(lead[2] ?? d.leadDaysByShift[2], 0, 6),
      3: clampNum(lead[3] ?? d.leadDaysByShift[3], 0, 6),
    },
    methodLeadOverride: { ...(o.methodLeadOverride ?? {}) },
    longPrepExtraLeadDays: clampNum(o.longPrepExtraLeadDays ?? d.longPrepExtraLeadDays, 0, 5),
    saucesToSunday: o.saucesToSunday ?? d.saucesToSunday,
    sundayCutoffDay: (["Mo", "Di", "Mi", "Do", "Fr"] as PlatingDay[]).includes(o.sundayCutoffDay as PlatingDay)
      ? (o.sundayCutoffDay as PlatingDay) : d.sundayCutoffDay,
    dualShiftWeekdays: o.dualShiftWeekdays ?? d.dualShiftWeekdays,
    weekdayShiftMin: clampNum(o.weekdayShiftMin ?? d.weekdayShiftMin, 30, 5000),
    sundayShiftMin: clampNum(o.sundayShiftMin ?? d.sundayShiftMin, 30, 5000),
    changeoverCleanMin: clampNum(o.changeoverCleanMin ?? d.changeoverCleanMin, 0, 240),
    changeoverEasyMin: clampNum(o.changeoverEasyMin ?? d.changeoverEasyMin, 0, 120),
  };
}

// ── Allergen-Sequenzierung ──────────────────────────────────────────────────

function allergenSet(raw: string): Set<string> {
  return new Set(String(raw || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}
function allergenSig(set: Set<string>): string {
  return [...set].sort().join(",");
}

const KIND_RANK: Record<KitchenChangeover, number> = { none: 0, easy: 1, clean: 2 };

interface CoParams { cleanMin: number; easyMin: number }

function classifyChangeover(prev: Set<string> | null, next: Set<string>, co: CoParams): {
  min: number; kind: KitchenChangeover;
} {
  if (!prev) return { min: 0, kind: "none" };
  for (const a of prev) if (!next.has(a)) return { min: co.cleanMin, kind: "clean" };
  for (const a of next) if (!prev.has(a)) return { min: co.easyMin, kind: "easy" };
  return { min: 0, kind: "none" };
}

function addedCount(prev: Set<string>, next: Set<string>): number {
  let n = 0;
  for (const a of next) if (!prev.has(a)) n++;
  return n;
}

/** Aufsteigende Sequenz: Start beim Job mit den wenigsten Allergenen, dann jeweils
 *  der Job mit dem billigsten Übergang (none < easy < clean). Unter „easy" der mit
 *  den wenigsten neuen Allergenen; dann langer Vorlauf zuerst; dann kritisch; dann
 *  größere Menge. Deckt sich mit platingDayLogic.sequenceAscending. */
function sequenceAscending(jobs: KitchenSubJob[], co: CoParams): KitchenSubJob[] {
  if (jobs.length <= 1) return [...jobs];
  const setOf = new Map(jobs.map(j => [j.key, allergenSet(j.allergens)]));
  const pool = [...jobs].sort((a, b) =>
    a.allergenCount - b.allergenCount
    || Number(b.longPrep) - Number(a.longPrep)
    || Number(b.critical) - Number(a.critical)
    || b.kg - a.kg
    || a.allergens.localeCompare(b.allergens),
  );
  const seq: KitchenSubJob[] = [pool.shift()!];
  while (pool.length) {
    const prevSet = setOf.get(seq[seq.length - 1].key)!;
    let bestIdx = 0;
    let bestScore = Infinity;
    pool.forEach((j, i) => {
      const jSet = setOf.get(j.key)!;
      const c = classifyChangeover(prevSet, jSet, co);
      const addTier = c.kind === "easy" ? addedCount(prevSet, jSet) : 0;
      const score = KIND_RANK[c.kind] * 1e15
        + addTier * 1e9
        - Number(j.longPrep) * 1e7
        - Number(j.critical) * 1e6
        - Math.min(j.kg, 999_999);
      if (score < bestScore) { bestScore = score; bestIdx = i; }
    });
    seq.push(pool.splice(bestIdx, 1)[0]);
  }
  return seq;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

interface Accum {
  subRecipeId: string;
  subRecipeName: string;
  area: KitchenArea;
  cookMethod: string;
  cookDay: PlatingDay;
  platingDays: Set<PlatingDay>;
  portions: number;
  kg: number;
  minPerBatch: number;
  batchSizeKg: number;
  feedsMeals: Map<string, string>;
  cookShifts: number;
  leadDays: number;
  scheduleSteps: KitchenScheduleStep[];
  longPrep: boolean;
  critical: boolean;
  allergens: Set<string>;
  dayOverridden: boolean;
}

function subMinutesPerBatch(sub: SubRecipeLoad): number {
  const mpb = sub.spec?.minutesPerBatch;
  if (!mpb) return 0;
  return Object.values(mpb).reduce((s, v) => s + (v ?? 0), 0);
}

function isHoldPrep(category: string, name: string): boolean {
  return HOLD_PREP_CAT_RE.test(category || "") || HOLD_PREP_NAME_RE.test(name || "");
}

/** Wie viele aktive Kochminuten steckt in dieser aggregierten Menge. */
function accActiveMin(a: { kg: number; batchSizeKg: number; minPerBatch: number }): number {
  const batches = a.batchSizeKg > 0 ? Math.max(1, Math.ceil(a.kg / a.batchSizeKg)) : (a.kg > 0 ? 1 : 0);
  return batches * a.minPerBatch;
}

/** Kochplan aus dem Wochen-Plating-Plan + DataBundle ableiten. */
export function generateKitchenPlan(
  data: DataBundle,
  platingPlan: PlatingWeekPlan,
  paramsOverride?: Partial<KitchenPlanParams>,
  overrides: Record<string, KitchenOverride> = {},
): KitchenWeekPlan {
  const params = resolveKitchenParams(paramsOverride);
  const co: CoParams = { cleanMin: params.changeoverCleanMin, easyMin: params.changeoverEasyMin };
  const now = new Date().toISOString();

  const weekLoad = computeWeekLoad(data, platingPlan.week, { portionMultiplier: 1 });
  const loadByDigits = new Map<string, SubRecipeLoad[]>();
  for (const rl of weekLoad.recipes) {
    const dk = codeDigits(rl.weekRecipe.code);
    if (dk) loadByDigits.set(dk, rl.subs);
  }

  const cookSchedules: Record<string, CookSchedule> = data.cookSchedules ?? {};
  const acc = new Map<string, Accum>();
  const unresolvedMeals: string[] = [];
  const sundayCutoffIdx = platingKitchenIdx(params.sundayCutoffDay);

  for (const meal of platingPlan.meals) {
    const subs = loadByDigits.get(codeDigits(meal.code));
    const runs = meal.runs.filter(r => r.day && r.portions > 0);
    if (!runs.length) continue;
    if (!subs || !subs.length) { unresolvedMeals.push(meal.code); continue; }

    const critical = meal.seafood || (meal.complexity != null && meal.complexity >= COMPLEX_CX);

    for (const sub of subs) {
      const vf = resolveCookSchedule(sub.category, VF_COOK_SCHEDULES);
      const fs = vf.schedule ? vf : resolveCookSchedule(sub.category, cookSchedules);
      const schedule = fs.schedule;
      const matchedMethod = fs.matchedMethod ?? sub.category;
      const cookShifts = schedule?.cookShifts ?? 1;
      const steps: KitchenScheduleStep[] = (schedule?.steps ?? []).map(s => ({ shiftsBefore: s.shiftsBefore, label: s.label }));
      const area = areaForCookMethod(sub.category);
      const minPerBatch = subMinutesPerBatch(sub);
      const batchSizeKg = sub.spec?.batchSizeKg && sub.spec.batchSizeKg > 0 ? sub.spec.batchSizeKg : 0;
      const ov = overrides[sub.subRecipeId];

      // Sonntag-Regel: die längste Vorarbeit vorab. Kandidat = Mehrschicht-Prozess
      // (cookShifts ≥ 2: Brine/Marinade/Slow-Cook/Thaw) ODER Halt-Komponente
      // (Sauce/Butter/Spice …). Nur die Run-Menge, die bis zum Cutoff (Default Mi)
      // geplatet wird. Passt danach eine Station nicht in die Sonntag-Schicht,
      // wandert der kürzeste Rest auf Montag (Kapazitäts-Pass unten).
      const gpp = sub.gramsPerPortion || 0;
      const sundayCand = params.saucesToSunday
        && (cookShifts >= 2 || isHoldPrep(sub.category, sub.subRecipeName));
      const longPrep = sundayCand || cookShifts >= 3;
      const baseLead = params.methodLeadOverride[matchedMethod]
        ?? params.leadDaysByShift[clampShifts(cookShifts)]
        ?? cookShifts;
      const effLead = baseLead + (cookShifts >= 3 ? params.longPrepExtraLeadDays : 0);

      for (const run of runs) {
        const platingDay = run.day as PlatingDay;
        const goSunday = sundayCand && platingKitchenIdx(platingDay) <= sundayCutoffIdx;
        const cookDay = ov?.cookDay ?? (goSunday ? "So" : kitchenDayFor(platingDay, effLead));
        const kg = (run.portions * gpp) / 1000;

        const key = `${sub.subRecipeId}__${cookDay}`;
        let a = acc.get(key);
        if (!a) {
          a = {
            subRecipeId: sub.subRecipeId,
            subRecipeName: sub.subRecipeName,
            area, cookMethod: matchedMethod, cookDay,
            platingDays: new Set(), portions: 0, kg: 0,
            minPerBatch, batchSizeKg,
            feedsMeals: new Map(), cookShifts,
            leadDays: Math.max(0, platingKitchenIdx(platingDay) - KITCHEN_DAYS.indexOf(cookDay)),
            scheduleSteps: steps, longPrep, critical: false,
            allergens: new Set(), dayOverridden: !!ov?.cookDay,
          };
          acc.set(key, a);
        }
        a.portions += run.portions;
        a.kg += kg;
        a.platingDays.add(platingDay);
        a.feedsMeals.set(meal.code, meal.name);
        if (critical) a.critical = true;
        for (const al of allergenSet(meal.allergens)) a.allergens.add(al);
      }
    }
  }

  // ── Sonntag-Kapazitäts-Pass ────────────────────────────────────────────────
  // Der Sonntag ist EINE Schicht. Je Station bleibt nur so viel drauf, wie in
  // eine Schicht passt — die Prozesse mit dem LÄNGSTEN Vorlauf / der längsten
  // Kochzeit zuerst. Der kürzeste Rest wandert auf Montag (dort landet er im
  // normalen Rückwärts-Vorlauf-Bucket).
  const sundayByArea = new Map<KitchenArea, Accum[]>();
  for (const a of acc.values()) {
    if (a.cookDay !== "So") continue;
    const arr = sundayByArea.get(a.area) ?? [];
    arr.push(a);
    sundayByArea.set(a.area, arr);
  }
  for (const list of sundayByArea.values()) {
    list.sort((x, y) =>
      y.cookShifts - x.cookShifts
      || accActiveMin(y) - accActiveMin(x)
      || y.kg - x.kg,
    );
    let usedMin = 0;
    for (const a of list) {
      const am = accActiveMin(a);
      if (usedMin === 0 || usedMin + am <= params.sundayShiftMin) { usedMin += am; continue; }
      // → auf Montag verschieben (in den vorhandenen Mo-Bucket mergen)
      acc.delete(`${a.subRecipeId}__So`);
      const moKey = `${a.subRecipeId}__Mo`;
      const mo = acc.get(moKey);
      const minPlatIdx = Math.min(...[...a.platingDays].map(d => platingKitchenIdx(d)));
      if (mo) {
        mo.portions += a.portions; mo.kg += a.kg;
        for (const d of a.platingDays) mo.platingDays.add(d);
        for (const [c, n] of a.feedsMeals) mo.feedsMeals.set(c, n);
        for (const al of a.allergens) mo.allergens.add(al);
        if (a.critical) mo.critical = true;
      } else {
        a.cookDay = "Mo";
        a.leadDays = Math.max(0, minPlatIdx - KITCHEN_DAYS.indexOf("Mo"));
        acc.set(moKey, a);
      }
    }
  }

  // Accum → Roh-Jobs (Schicht + Sequenz kommen danach).
  let jobs: KitchenSubJob[] = [...acc.values()].map(a => {
    const kg = round(a.kg);
    const batches = a.batchSizeKg > 0 ? Math.max(1, Math.ceil(a.kg / a.batchSizeKg)) : (a.kg > 0 ? 1 : 0);
    const sig = allergenSig(a.allergens);
    return {
      key: `${a.subRecipeId}__${a.cookDay}`,
      subRecipeId: a.subRecipeId,
      subRecipeName: a.subRecipeName,
      area: a.area,
      cookMethod: a.cookMethod,
      cookDay: a.cookDay,
      shift: "tag" as KitchenShift,
      platingDays: PLATING_DAYS.filter(d => a.platingDays.has(d)),
      portions: round(a.portions),
      kg,
      batches,
      activeCookMin: round(batches * a.minPerBatch),
      allergens: sig,
      allergenCount: a.allergens.size,
      feedsMeals: [...a.feedsMeals.entries()].map(([code, name]) => ({ code, name })),
      cookShifts: a.cookShifts,
      leadDays: a.leadDays,
      scheduleSteps: a.scheduleSteps,
      longPrep: a.longPrep,
      critical: a.critical,
      overridden: a.dayOverridden,
      manualOrder: false,
      seq: 0, startMin: 0, endMin: 0, changeoverBeforeMin: 0, changeoverKind: "none" as KitchenChangeover,
    } satisfies KitchenSubJob;
  });

  // Schicht zuweisen: Override gewinnt; So + Einschicht-Modus → „tag";
  // sonst je Station großes/langes zuerst in die Frühschicht bis Kapazität.
  jobs = assignShifts(jobs, params, overrides);

  const days: Partial<Record<PlatingDay, KitchenDayPlan>> = {};
  for (const day of KITCHEN_DAYS) {
    const dayJobs = jobs.filter(j => j.cookDay === day);
    if (!dayJobs.length) continue;
    days[day] = buildDayPlan(day, dayJobs, params, co, overrides);
  }

  return {
    week: platingPlan.week,
    generatedAt: now,
    updatedAt: now,
    params,
    overrides: { ...overrides },
    days,
    unresolvedMeals,
    source: "generated",
  };
}

function assignShifts(
  jobs: KitchenSubJob[],
  params: KitchenPlanParams,
  overrides: Record<string, KitchenOverride>,
): KitchenSubJob[] {
  const out = jobs.map(j => ({ ...j }));
  for (const day of KITCHEN_DAYS) {
    const dual = params.dualShiftWeekdays && day !== "So";
    const dayJobs = out.filter(j => j.cookDay === day);
    if (!dual) {
      for (const j of dayJobs) j.shift = "tag";
      continue;
    }
    // je Station: langer Vorlauf + große Menge zuerst in die Frühschicht.
    const byArea = new Map<KitchenArea, KitchenSubJob[]>();
    for (const j of dayJobs) {
      const arr = byArea.get(j.area) ?? [];
      arr.push(j);
      byArea.set(j.area, arr);
    }
    for (const list of byArea.values()) {
      list.sort((a, b) => Number(b.longPrep) - Number(a.longPrep) || b.activeCookMin - a.activeCookMin);
      let fruehMin = 0;
      for (const j of list) {
        const ov = overrides[j.subRecipeId]?.shift;
        if (ov === "früh" || ov === "spät") { j.shift = ov; if (ov === "früh") fruehMin += j.activeCookMin; continue; }
        if (fruehMin + j.activeCookMin <= params.weekdayShiftMin || fruehMin === 0) {
          j.shift = "früh";
          fruehMin += j.activeCookMin;
        } else {
          j.shift = "spät";
        }
      }
    }
  }
  return out;
}

function buildDayPlan(
  day: PlatingDay,
  dayJobs: KitchenSubJob[],
  params: KitchenPlanParams,
  co: CoParams,
  overrides: Record<string, KitchenOverride>,
): KitchenDayPlan {
  const dual = params.dualShiftWeekdays && day !== "So";
  const shiftList: KitchenShift[] = dual ? WEEKDAY_SHIFTS : ["tag"];
  const availableMin = day === "So" ? params.sundayShiftMin : (dual ? params.weekdayShiftMin : params.sundayShiftMin);

  // Bei dual immer BEIDE Schichten ausgeben (auch leer = sichtbares Drop-Ziel).
  const shifts: KitchenShiftPlan[] = shiftList.map(shift => {
    const shiftJobs = dayJobs.filter(j => j.shift === shift);
    const byArea = new Map<KitchenArea, KitchenSubJob[]>();
    for (const j of shiftJobs) {
      const arr = byArea.get(j.area) ?? [];
      arr.push(j);
      byArea.set(j.area, arr);
    }
    const blocks: KitchenBlock[] = KITCHEN_AREA_ORDER
      .filter(a => byArea.has(a))
      .map(area => sequenceBlock(area, shift, byArea.get(area)!, co, overrides, availableMin));

    const kg = round(blocks.reduce((s, b) => s + b.kg, 0));
    const batches = blocks.reduce((s, b) => s + b.batches, 0);
    const neededMin = blocks.reduce((s, b) => s + b.neededMin, 0);
    const cleanCount = blocks.reduce((s, b) => s + b.cleanCount, 0);
    return {
      shift, blocks, kg, batches, neededMin, availableMin, cleanCount,
      overCapacity: blocks.some(b => b.overCapacity),
    };
  }).filter(s => dual || s.blocks.length > 0);

  return {
    day,
    shiftModel: dual ? 2 : 1,
    shifts,
    totalKg: round(shifts.reduce((s, sp) => s + sp.kg, 0)),
    totalBatches: shifts.reduce((s, sp) => s + sp.batches, 0),
    totalJobs: dayJobs.length,
    cleanCount: shifts.reduce((s, sp) => s + sp.cleanCount, 0),
  };
}

function sequenceBlock(
  area: KitchenArea,
  shift: KitchenShift,
  rawJobs: KitchenSubJob[],
  co: CoParams,
  overrides: Record<string, KitchenOverride>,
  availableMin: number,
): KitchenBlock {
  const hasManual = rawJobs.some(j => overrides[j.subRecipeId]?.order != null);
  let ordered: KitchenSubJob[];
  if (hasManual) {
    ordered = [...rawJobs].sort((a, b) => {
      const oa = overrides[a.subRecipeId]?.order ?? Number.POSITIVE_INFINITY;
      const ob = overrides[b.subRecipeId]?.order ?? Number.POSITIVE_INFINITY;
      return oa - ob || a.allergenCount - b.allergenCount || b.kg - a.kg;
    });
  } else {
    ordered = sequenceAscending(rawJobs, co);
  }

  const jobs: KitchenSubJob[] = [];
  let used = 0;
  let prev: Set<string> | null = null;
  let changeoverMin = 0, cleanCount = 0, easyCount = 0;
  ordered.forEach((raw, i) => {
    const set = allergenSet(raw.allergens);
    const c = classifyChangeover(prev, set, co);
    const start = used + c.min;
    const end = start + raw.activeCookMin;
    jobs.push({
      ...raw,
      key: `${raw.subRecipeId}__${raw.cookDay}__${shift}`,
      shift,
      manualOrder: hasManual,
      seq: i,
      startMin: round(start),
      endMin: round(end),
      changeoverBeforeMin: c.min,
      changeoverKind: c.kind,
    });
    used = end;
    changeoverMin += c.min;
    if (c.kind === "clean") cleanCount++;
    else if (c.kind === "easy") easyCount++;
    prev = set;
  });

  const activeCookMin = jobs.reduce((s, j) => s + j.activeCookMin, 0);
  const neededMin = activeCookMin + changeoverMin;
  return {
    area, shift, jobs,
    kg: round(jobs.reduce((s, j) => s + j.kg, 0)),
    batches: jobs.reduce((s, j) => s + j.batches, 0),
    activeCookMin, changeoverMin, cleanCount, easyCount,
    neededMin, availableMin,
    overCapacity: neededMin > availableMin + 0.5,
  };
}

// ── Auswertung ──────────────────────────────────────────────────────────────

export function summarizeKitchenPlan(plan: KitchenWeekPlan): {
  jobs: number; kg: number; batches: number; cleanings: number; blocksOver: number; days: number;
} {
  let jobs = 0, kg = 0, batches = 0, cleanings = 0, blocksOver = 0, days = 0;
  for (const day of KITCHEN_DAYS) {
    const dp = plan.days[day];
    if (!dp) continue;
    days++;
    jobs += dp.totalJobs;
    kg += dp.totalKg;
    batches += dp.totalBatches;
    cleanings += dp.cleanCount;
    for (const s of dp.shifts) blocksOver += s.blocks.filter(b => b.overCapacity).length;
  }
  return { jobs, kg: round(kg), batches, cleanings, blocksOver, days };
}

const SHIFT_LABEL: Record<KitchenShift, string> = { früh: "Frühschicht", spät: "Spätschicht", tag: "Tag" };

/** Kurztext für den KI-Kontext / Tool-Ausgabe (analog summarizePlatingPlan). */
export function describeKitchenPlan(plan: KitchenWeekPlan): string {
  const p = plan.params;
  const out: string[] = [];
  out.push(`Kochplan ${plan.week} · Stand ${plan.source} · Vorlauf ${p.leadDaysByShift[1]}/${p.leadDaysByShift[2]}/${p.leadDaysByShift[3]} Tage (1/2/3 Shifts)${p.saucesToSunday ? ` · Sonntag (1 Schicht): längste Vorarbeit (Mehrschicht-Prozesse + Sauce/Butter/Spice) für Runs bis Plating-Tag ${p.sundayCutoffDay}, Überlauf → Montag` : ""}`);
  if (plan.unresolvedMeals.length) out.push(`Ohne Sub-Rezept-Daten (nicht im Kochplan): ${plan.unresolvedMeals.join(", ")}`);
  const ovCount = Object.keys(plan.overrides).length;
  if (ovCount) out.push(`${ovCount} Sub-Meal(s) von Hand verschoben/fixiert.`);

  for (const day of KITCHEN_DAYS) {
    const dp = plan.days[day];
    if (!dp) continue;
    out.push(`\n${day} (${dp.shiftModel === 2 ? "Früh+Spät" : "eine Schicht"}): ${fmtNum(dp.totalKg)} kg · ${dp.totalBatches} Batches · ${dp.totalJobs} Sub-Meals · ${dp.cleanCount} Reinigungen`);
    for (const sp of dp.shifts) {
      if (!sp.blocks.length) continue;
      out.push(`  ${SHIFT_LABEL[sp.shift]}: ${fmtNum(sp.kg)} kg · ${Math.round(sp.neededMin / 6) / 10}/${Math.round(sp.availableMin / 6) / 10} h${sp.overCapacity ? " ⚠" : ""}`);
      for (const b of sp.blocks) {
        const seq = b.jobs.map(j =>
          `${j.subRecipeName}${j.changeoverBeforeMin ? `·${j.changeoverKind === "easy" ? "~" : "🧽"}${j.changeoverBeforeMin}` : ""} [${fmtNum(j.kg)}kg/${j.batches}B${j.allergens ? `/${j.allergens}` : ""}]`,
        ).join(" → ");
        out.push(`    ${b.area} (${b.cleanCount} Reinig.${b.easyCount ? ` +${b.easyCount} easy` : ""}): ${seq}`);
      }
    }
  }
  return out.join("\n");
}
