// Phase 2 — täglicher Linienplan.
// Nimmt die im Wochenplan auf einen Tag verplanten Runs und sequenziert sie
// changeover-minimiert auf die Plating-Linien des Tages:
//   - Linie 1 = HIGHRUNNER: höchstes Volumen zuerst, dann jeweils der Run mit
//     dem kleinsten Umrüst-Aufwand vom aktuellen Ende (Nearest-Neighbour).
//   - Linie 2 = FLEX: der Rest, gleiche Sequenzierung.
//   - Linie 3 = OVERLOAD: wird nur befüllt, wenn 1 + 2 voll sind.
//   - Umrüsten: Allergen-Wechsel = changeoverAllergenMin, Protein-Typ-Wechsel
//     = changeoverProteinMin (der höhere Wert gewinnt).
//   - Carry-over: was nicht mehr in die Schicht passt, wandert auf den Folgetag.
//
// Reine Logik, kein React.

import { PLATING_DAYS, type PlatingCarryItem, type PlatingDay, type PlatingDayPlan,
  type PlatingLinePlan, type PlatingSlot, type PlatingWeekPlan, type ProteinType,
} from "./platingPlanTypes";

const PROTEIN_RE: [RegExp, ProteinType][] = [
  [/\b(shrimp|prawn|salmon|barramundi|fish|tuna|seafood|cod|pollock|crab|scampi)\b/i, "seafood"],
  [/\b(chicken|poultry|hähnchen|huhn|geflügel|turkey|pute)\b/i, "chicken"],
  [/\b(beef|steak|rind|meatball|bulgogi|brisket)\b/i, "beef"],
  [/\b(pork|schwein|bacon|ham|sausage|chorizo|pulled pork)\b/i, "pork"],
  [/\b(veg|veggie|tofu|halloumi|chickpea|lentil|paneer|mushroom|bean|falafel)\b/i, "veggie"],
];

/** Grobe Protein-Typ-Klassifikation aus dem Meal-Namen (für Changeover-Kosten). */
export function proteinTypeFromName(name: string): ProteinType {
  for (const [re, t] of PROTEIN_RE) if (re.test(name)) return t;
  return "other";
}

/** Kanonische Allergen-Signatur (sortiert, klein) für den Sequenz-Vergleich. */
function allergenSig(raw: string): string {
  return String(raw || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

interface Job {
  code: string;
  name: string;
  runIndex: number;
  portions: number;
  allergens: string;
  allergenSig: string;
  proteinType: ProteinType;
  seafood: boolean;
  complexity: number | null;
}

/** Umrüst-Kosten (Minuten) + Grund zwischen zwei aufeinanderfolgenden Jobs. */
function changeover(prev: Job | null, next: Job, allergenMin: number, proteinMin: number): {
  min: number; reason: "allergen" | "protein" | null;
} {
  if (!prev) return { min: 0, reason: null };
  const proteinChange = prev.proteinType !== next.proteinType
    && !(prev.proteinType === "other" || next.proteinType === "other");
  const allergenChange = prev.allergenSig !== next.allergenSig;
  if (proteinChange) return { min: Math.max(proteinMin, allergenChange ? allergenMin : 0), reason: "protein" };
  if (allergenChange) return { min: allergenMin, reason: "allergen" };
  return { min: 0, reason: null };
}

/** Alle Runs eines Tages + Carry-in als Job-Liste. */
function collectJobs(plan: PlatingWeekPlan, day: PlatingDay, carryIn: PlatingCarryItem[]): Job[] {
  const jobs: Job[] = [];
  const byCode = new Map(plan.meals.map(m => [m.code, m]));
  for (const meal of plan.meals) {
    for (const run of meal.runs) {
      if (run.day !== day || run.portions <= 0) continue;
      jobs.push({
        code: meal.code, name: meal.name, runIndex: run.runIndex, portions: run.portions,
        allergens: meal.allergens, allergenSig: allergenSig(meal.allergens),
        proteinType: proteinTypeFromName(`${meal.name} ${meal.allergens}`),
        seafood: meal.seafood, complexity: meal.complexity ?? null,
      });
    }
  }
  for (const ci of carryIn) {
    if (ci.portions <= 0) continue;
    const meal = byCode.get(ci.code);
    const name = meal?.name ?? ci.name;
    const allergens = meal?.allergens ?? "";
    jobs.push({
      code: ci.code, name, runIndex: 0, portions: ci.portions,
      allergens, allergenSig: allergenSig(allergens),
      proteinType: proteinTypeFromName(`${name} ${allergens}`),
      seafood: meal?.seafood ?? false, complexity: meal?.complexity ?? null,
    });
  }
  return jobs;
}

/** Nächsten Job wählen: kleinster Umrüst-Aufwand vom Ende, Gleichstand → mehr Portionen. */
function pickNext(prev: Job | null, pool: Job[], allergenMin: number, proteinMin: number): Job {
  if (!prev) return [...pool].sort((a, b) => b.portions - a.portions)[0];
  let best = pool[0];
  let bestCost = Infinity;
  for (const j of pool) {
    const c = changeover(prev, j, allergenMin, proteinMin).min;
    if (c < bestCost || (c === bestCost && j.portions > best.portions)) { bestCost = c; best = j; }
  }
  return best;
}

/** Befüllt EINE Linie greedy + zeitbewusst; gibt die nicht mehr passenden Jobs zurück. */
function buildLine(
  line: number, role: PlatingLinePlan["role"], availableMin: number,
  pool: Job[], ratePerLineHour: number, allergenMin: number, proteinMin: number,
): { line: PlatingLinePlan; leftover: Job[] } {
  const slots: PlatingSlot[] = [];
  const rate = ratePerLineHour > 0 ? ratePerLineHour : 900;
  const minPerPortion = 60 / rate;
  let used = 0;
  let platingMin = 0;
  let changeoverMin = 0;
  let changeovers = 0;
  let prev: Job | null = null;
  const remaining = [...pool];

  while (remaining.length) {
    const next = pickNext(prev, remaining, allergenMin, proteinMin);
    remaining.splice(remaining.indexOf(next), 1);
    const co = changeover(prev, next, allergenMin, proteinMin);
    const jobPlating = next.portions * minPerPortion;

    if (used + co.min + jobPlating <= availableMin + 0.01) {
      const start = used + co.min;
      slots.push({
        code: next.code, name: next.name, runIndex: next.runIndex, portions: next.portions,
        seq: slots.length, startMin: Math.round(start), endMin: Math.round(start + jobPlating),
        changeoverBeforeMin: co.min, changeoverReason: co.reason,
        allergens: next.allergens, proteinType: next.proteinType, seafood: next.seafood,
        complexity: next.complexity,
      });
      used = start + jobPlating;
      platingMin += jobPlating;
      changeoverMin += co.min;
      if (co.min > 0) changeovers++;
      prev = next;
      continue;
    }

    // passt nicht mehr ganz → aufteilen (wenn sich der Anlauf lohnt), Rest ist Leftover
    const roomMin = availableMin - used - co.min;
    const fitPortions = Math.floor(roomMin / minPerPortion);
    if (fitPortions >= 50) {
      const start = used + co.min;
      const fitMin = fitPortions * minPerPortion;
      slots.push({
        code: next.code, name: next.name, runIndex: next.runIndex, portions: fitPortions,
        seq: slots.length, startMin: Math.round(start), endMin: Math.round(start + fitMin),
        changeoverBeforeMin: co.min, changeoverReason: co.reason,
        allergens: next.allergens, proteinType: next.proteinType, seafood: next.seafood,
        complexity: next.complexity, carryOver: next.portions - fitPortions,
      });
      platingMin += fitMin;
      changeoverMin += co.min;
      if (co.min > 0) changeovers++;
      used = start + fitMin;
      remaining.unshift({ ...next, portions: next.portions - fitPortions });
    } else {
      remaining.unshift(next);
    }
    break; // Linie ist voll
  }

  return {
    line: {
      line, role, slots,
      platingMin: Math.round(platingMin), changeoverMin: Math.round(changeoverMin),
      availableMin: Math.round(availableMin), changeovers,
      overCapacity: used > availableMin + 1,
    },
    leftover: remaining,
  };
}

/** Leftover-Jobs zu Carry-Items je Meal-Code zusammenfassen. */
function toCarryItems(jobs: Job[]): PlatingCarryItem[] {
  const byCode = new Map<string, PlatingCarryItem>();
  for (const j of jobs) {
    if (j.portions <= 0) continue;
    const cur = byCode.get(j.code);
    if (cur) cur.portions += j.portions;
    else byCode.set(j.code, { code: j.code, name: j.name, portions: j.portions });
  }
  return [...byCode.values()].map(c => ({ ...c, portions: Math.round(c.portions) }));
}

/** Linienplan für EINEN Tag (mit übernommenem Carry-in vom Vortag). */
export function generateDayPlan(
  plan: PlatingWeekPlan, day: PlatingDay, carryIn: PlatingCarryItem[] = [],
): PlatingDayPlan {
  const cap = plan.dayCapacity[day];
  const lineCount = cap?.lines ?? 0;
  const hours = cap?.hours ?? 0;
  const rate = plan.params.platingRatePerLineHour || 900;
  const aMin = plan.params.changeoverAllergenMin ?? 30;
  const pMin = plan.params.changeoverProteinMin ?? 60;
  const now = new Date().toISOString();

  let pool = collectJobs(plan, day, carryIn);
  const lines: PlatingLinePlan[] = [];

  if (lineCount > 0 && hours > 0 && pool.length) {
    const availableMin = hours * 60;
    for (let n = 1; n <= lineCount; n++) {
      const role: PlatingLinePlan["role"] =
        n === 1 ? "highrunner" : (n === lineCount && lineCount >= 3 ? "overload" : "flex");
      const built = buildLine(n, role, availableMin, pool, rate, aMin, pMin);
      lines.push(built.line);
      pool = built.leftover;
      if (!pool.length) break;
    }
    // Overload-Linie ggf. noch anlegen (falls oben per break übersprungen)
    for (let n = lines.length + 1; n <= lineCount && pool.length; n++) {
      const role: PlatingLinePlan["role"] = n === lineCount && lineCount >= 3 ? "overload" : "flex";
      const built = buildLine(n, role, availableMin, pool, rate, aMin, pMin);
      lines.push(built.line);
      pool = built.leftover;
    }
  }

  return {
    day, lines,
    carryInFromPrev: carryIn.filter(c => c.portions > 0),
    carryOutToNext: toCarryItems(pool),
    generatedAt: now, source: "generated",
  };
}

/** Nach einer manuellen Umsortierung (Slots neu geordnet / Linie gewechselt) die
 *  Zeiten, Umrüstungen und Carry-over einer Linie neu berechnen. Die Slot-Reihen-
 *  folge + Linien-Zuordnung bleiben wie übergeben; nur die Ableitungen werden frisch.
 *  Cross-Day-Carry wird NICHT neu gefädelt — dafür „Tagespläne neu generieren". */
export function recomputeDayPlan(dp: PlatingDayPlan, plan: PlatingWeekPlan): PlatingDayPlan {
  const rate = plan.params.platingRatePerLineHour || 900;
  const minPerPortion = 60 / rate;
  const aMin = plan.params.changeoverAllergenMin ?? 30;
  const pMin = plan.params.changeoverProteinMin ?? 60;
  const carryOut: Job[] = [];

  const lines: PlatingLinePlan[] = dp.lines.map(line => {
    const slots: PlatingSlot[] = [];
    let used = 0, platingMin = 0, changeoverMin = 0, changeovers = 0;
    let prev: Job | null = null;
    let lineFull = false;
    for (const s of line.slots) {
      const total = s.portions + (s.carryOver ?? 0);
      const job: Job = {
        code: s.code, name: s.name, runIndex: s.runIndex, portions: total,
        allergens: s.allergens, allergenSig: allergenSig(s.allergens),
        proteinType: s.proteinType, seafood: s.seafood, complexity: s.complexity,
      };
      if (lineFull) { carryOut.push(job); continue; }
      const co = changeover(prev, job, aMin, pMin);
      const jobPlating = total * minPerPortion;
      if (used + co.min + jobPlating <= line.availableMin + 0.01) {
        const start = used + co.min;
        slots.push({
          ...s, portions: total, carryOver: undefined, seq: slots.length,
          startMin: Math.round(start), endMin: Math.round(start + jobPlating),
          changeoverBeforeMin: co.min, changeoverReason: co.reason,
        });
        used = start + jobPlating; platingMin += jobPlating; changeoverMin += co.min;
        if (co.min > 0) changeovers++;
        prev = job;
      } else {
        const roomMin = line.availableMin - used - co.min;
        const fit = Math.floor(roomMin / minPerPortion);
        if (fit >= 50) {
          const start = used + co.min;
          const fitMin = fit * minPerPortion;
          slots.push({
            ...s, portions: fit, carryOver: total - fit, seq: slots.length,
            startMin: Math.round(start), endMin: Math.round(start + fitMin),
            changeoverBeforeMin: co.min, changeoverReason: co.reason,
          });
          used = start + fitMin; platingMin += fitMin; changeoverMin += co.min;
          if (co.min > 0) changeovers++;
          carryOut.push({ ...job, portions: total - fit });
        } else {
          carryOut.push(job);
        }
        lineFull = true;
      }
    }
    return {
      ...line, slots,
      platingMin: Math.round(platingMin), changeoverMin: Math.round(changeoverMin),
      changeovers, overCapacity: used > line.availableMin + 1,
    };
  });

  return { ...dp, lines, carryOutToNext: toCarryItems(carryOut), source: "edited",
    generatedAt: new Date().toISOString() };
}

/** Linienpläne für alle Produktionstage — Carry-over wird von Tag zu Tag durchgereicht. */
export function generateAllDayPlans(plan: PlatingWeekPlan): Partial<Record<PlatingDay, PlatingDayPlan>> {
  const out: Partial<Record<PlatingDay, PlatingDayPlan>> = {};
  let carry: PlatingCarryItem[] = [];
  for (const day of PLATING_DAYS) {
    const dp = generateDayPlan(plan, day, carry);
    const hasContent = dp.lines.length || dp.carryInFromPrev.length || dp.carryOutToNext.length;
    if (hasContent) out[day] = dp;
    carry = dp.carryOutToNext;
  }
  return out;
}

// ── Auswertung ───────────────────────────────────────────────────────────────

export interface DayPlanSummary {
  day: PlatingDay;
  totalPortions: number;
  slots: number;
  changeovers: number;
  changeoverMin: number;
  linesOver: number;
  carryOut: number;
}

export function summarizeDayPlan(dp: PlatingDayPlan): DayPlanSummary {
  let totalPortions = 0, slots = 0, changeovers = 0, changeoverMin = 0, linesOver = 0;
  for (const l of dp.lines) {
    slots += l.slots.length;
    changeovers += l.changeovers;
    changeoverMin += l.changeoverMin;
    if (l.overCapacity) linesOver++;
    for (const s of l.slots) totalPortions += s.portions;
  }
  return {
    day: dp.day, totalPortions, slots, changeovers, changeoverMin, linesOver,
    carryOut: dp.carryOutToNext.reduce((s, c) => s + c.portions, 0),
  };
}

/** Kurztext für den KI-Kontext / Tool-Ausgabe. */
export function describeDayPlan(dp: PlatingDayPlan): string {
  const out: string[] = [];
  const s = summarizeDayPlan(dp);
  out.push(`Plating-Tagesplan ${dp.day} · ${s.totalPortions} P · ${s.slots} Slots · ${s.changeovers} Wechsel (${s.changeoverMin} min)${s.linesOver ? ` · ⚠ ${s.linesOver} Linie(n) über Kapazität` : ""}`);
  if (dp.carryInFromPrev.length) out.push(`  Carry-in: ${dp.carryInFromPrev.map(c => `${c.code} ${c.portions}`).join(", ")}`);
  for (const l of dp.lines) {
    const seq = l.slots.map(sl => `${sl.code}${sl.changeoverBeforeMin ? `·+${sl.changeoverBeforeMin}` : ""}:${sl.portions}${sl.carryOver ? `(→${sl.carryOver})` : ""}`).join(" → ");
    out.push(`  L${l.line} ${l.role}: ${seq || "—"} [${l.platingMin + l.changeoverMin}/${l.availableMin} min${l.overCapacity ? " ⚠" : ""}]`);
  }
  if (dp.carryOutToNext.length) out.push(`  Carry-out → Folgetag: ${dp.carryOutToNext.map(c => `${c.code} ${c.portions}`).join(", ")}`);
  return out.join("\n");
}
