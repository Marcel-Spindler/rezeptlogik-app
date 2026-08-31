// Phase 3 — allergen-getriebener täglicher Linienplan.
//
// Der Changeover zwischen zwei Meals ist REIN allergen-getrieben (Ziel: Tempo +
// wenig Reinigung):
//   milk → milk,sulphites   = EASY CHANGEOVER (nur zufügen) → kurze Rüstzeit, KEINE Reinigung
//   milk,sulphites → milk   = REINIGUNG (Allergen weg) = Saubermach-Aktion
//   milk → milk             = 0
// Jede Linie wird aufsteigend sequenziert: möglichst kein Allergen → viele.
//
// Besetzung: pro Meal auf einer Linie = (# Sub-Meals) + 1 Helfer (einer je Linie).
// Daraus Spitzenbesetzung je Linie/Tag + Personenminuten.
//
// Linien (der Tag hat laut Kapazität `lines` besetzt):
//   L1 HIGHRUNNER = der größte „saubere Block" (Kette ohne Reinigung), bis die
//                   Schicht voll ist; ein einzelner Block wird ggf. gesplittet.
//   L2 FLEX       = der Rest, aufsteigend sequenziert — nimmt die Reinigungen auf.
//   L3.. OVERLOAD = nur wenn L1 + L2 das Tagesvolumen NICHT fassen (und der Tag
//                   ≥ 3 Linien besetzt hat).
//   Danach die Restkapazität ALLER Linien auffüllen. Was dann noch übrig ist →
//   Carry-over auf den Folgetag; Seafood / komplexe Meals dabei kritisch.
//
// Reine Logik, kein React.

import { PLATING_DAYS, type ChangeoverKind, type PlatingCarryItem, type PlatingDay,
  type PlatingDayPlan, type PlatingLinePlan, type PlatingPlanParams,
  type PlatingSlot, type PlatingWeekPlan,
} from "./platingPlanTypes";

/** cx ab hier gilt ein Meal als komplex → harte Deadline (siehe Wochenplan). */
const COMPLEX_CX = 1.15;

/** Besetzung einer Linie für ein Meal: ein MA pro Sub-Meal + ein Helfer je Linie.
 *  0 Sub-Meals (unbekannt) → 0 (keine Schätzung). */
function headcountFor(subMeals: number): number {
  return subMeals > 0 ? subMeals + 1 : 0;
}

/** Allergen-Menge (klein, getrimmt). */
function allergenSet(raw: string): Set<string> {
  return new Set(
    String(raw || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  );
}

/** Kanonische Allergen-Signatur (sortiert) — nur für Anzeige/Vergleich. */
function allergenSig(set: Set<string>): string {
  return [...set].sort().join(",");
}

function round(n: number): number {
  return Math.max(0, Math.round(n));
}

/** Spitzenbesetzung (max gleichzeitige MA auf der Linie) + Personenminuten
 *  (Σ headcount × Slot-Dauer) aus den fertigen Slots einer Linie. */
function lineStaffing(slots: PlatingSlot[]): { peakHeadcount: number; manMinutes: number } {
  let peak = 0, manMin = 0;
  for (const s of slots) {
    if (s.headcount > peak) peak = s.headcount;
    manMin += s.headcount * Math.max(0, s.endMin - s.startMin);
  }
  return { peakHeadcount: peak, manMinutes: round(manMin) };
}

interface Job {
  code: string;
  name: string;
  runIndex: number;
  portions: number;
  allergens: string;              // Anzeige (Original-String)
  allergenSet: Set<string>;
  seafood: boolean;
  complexity: number | null;
  subMeals: number;
  critical: boolean;              // Seafood oder cx ≥ COMPLEX_CX
}

interface CoParams {
  easyMin: number;
  allergenMin: number;
}

function coParams(p: PlatingPlanParams): CoParams {
  return {
    easyMin: p.changeoverEasyMin ?? 10,
    allergenMin: p.changeoverAllergenMin ?? 30,
  };
}

const KIND_RANK: Record<ChangeoverKind, number> = { none: 0, easy: 1, allergen: 2 };

/** Umrüst-Kosten + Klasse zwischen zwei aufeinanderfolgenden Jobs — rein aus den
 *  Allergenen: Allergen weg = Reinigung, Allergen nur dazu = easy, sonst 0. */
function classifyChangeover(prev: Job | null, next: Job, co: CoParams): {
  min: number; reason: PlatingSlot["changeoverReason"]; kind: ChangeoverKind;
} {
  if (!prev) return { min: 0, reason: null, kind: "none" };

  let removed = false;
  for (const a of prev.allergenSet) if (!next.allergenSet.has(a)) { removed = true; break; }
  let added = false;
  for (const a of next.allergenSet) if (!prev.allergenSet.has(a)) { added = true; break; }

  if (removed) return { min: co.allergenMin, reason: "allergen", kind: "allergen" };
  if (added) return { min: co.easyMin, reason: "easy", kind: "easy" };
  return { min: 0, reason: null, kind: "none" };
}

/** true = dieser Übergang ist eine Saubermach-Aktion (bricht einen „sauberen Block"). */
function isCleaning(kind: ChangeoverKind): boolean {
  return kind === "allergen";
}

/** Alle Runs eines Tages + Carry-in als Job-Liste. */
function collectJobs(plan: PlatingWeekPlan, day: PlatingDay, carryIn: PlatingCarryItem[]): Job[] {
  const jobs: Job[] = [];
  const byCode = new Map(plan.meals.map(m => [m.code, m]));

  const mkJob = (
    code: string, name: string, runIndex: number, portions: number,
    allergens: string, seafood: boolean, complexity: number | null, subMeals: number, criticalHint = false,
  ): Job => ({
    code, name, runIndex, portions,
    allergens, allergenSet: allergenSet(allergens),
    seafood, complexity, subMeals: Math.max(0, subMeals || 0),
    critical: criticalHint || seafood || (complexity != null && complexity >= COMPLEX_CX),
  });

  for (const meal of plan.meals) {
    for (const run of meal.runs) {
      if (run.day !== day || run.portions <= 0) continue;
      jobs.push(mkJob(meal.code, meal.name, run.runIndex, run.portions,
        meal.allergens, meal.seafood, meal.complexity, meal.subMealCount));
    }
  }
  for (const ci of carryIn) {
    if (ci.portions <= 0) continue;
    const meal = byCode.get(ci.code);
    jobs.push(mkJob(
      ci.code, meal?.name ?? ci.name, 0, ci.portions,
      meal?.allergens ?? "", meal?.seafood ?? false, meal?.complexity ?? null,
      meal?.subMealCount ?? 0, ci.critical ?? false,
    ));
  }
  return jobs;
}

/** Leftover-Jobs zu Carry-Items je Meal-Code zusammenfassen. */
function toCarryItems(jobs: Job[]): PlatingCarryItem[] {
  const byCode = new Map<string, PlatingCarryItem>();
  for (const j of jobs) {
    if (j.portions <= 0) continue;
    const cur = byCode.get(j.code);
    if (cur) {
      cur.portions += j.portions;
      if (j.critical) cur.critical = true;
    } else {
      byCode.set(j.code, { code: j.code, name: j.name, portions: j.portions, ...(j.critical ? { critical: true } : {}) });
    }
  }
  return [...byCode.values()].map(c => ({ ...c, portions: Math.round(c.portions) }));
}

/** Wie viele Allergene fügt `next` gegenüber `prev` NEU hinzu. */
function addedCount(prev: Job, next: Job): number {
  let n = 0;
  for (const a of next.allergenSet) if (!prev.allergenSet.has(a)) n++;
  return n;
}

/** Aufsteigende Sequenz: Start beim Job mit den wenigsten Allergenen, dann jeweils
 *  der Job mit dem billigsten Übergang (none < easy < allergen).
 *  Unter „easy" den mit den WENIGSTEN neuen Allergenen (auf der Treppe bleiben),
 *  dann kritische Meals vorziehen (Deadline), dann größere Menge. */
function sequenceAscending(jobs: Job[], co: CoParams): Job[] {
  if (jobs.length <= 1) return [...jobs];
  const pool = [...jobs].sort((a, b) =>
    a.allergenSet.size - b.allergenSet.size
    || Number(b.critical) - Number(a.critical)
    || b.portions - a.portions
    || allergenSig(a.allergenSet).localeCompare(allergenSig(b.allergenSet)),
  );
  const seq: Job[] = [pool.shift()!];
  while (pool.length) {
    const prev = seq[seq.length - 1];
    let bestIdx = 0;
    let bestScore = Infinity;
    pool.forEach((j, i) => {
      const c = classifyChangeover(prev, j, co);
      const addTier = c.kind === "easy" ? addedCount(prev, j) : 0;
      // Übergangsklasse dominiert; dann wenige neue Allergene; dann kritisch; dann Volumen
      const score = KIND_RANK[c.kind] * 1e15
        + addTier * 1e9
        - Number(j.critical) * 1e6
        - Math.min(j.portions, 999_999);
      if (score < bestScore) { bestScore = score; bestIdx = i; }
    });
    seq.push(pool.splice(bestIdx, 1)[0]);
  }
  return seq;
}

/** Zusammenhängende Ketten der Sequenz OHNE Reinigung dazwischen (nur none/easy). */
interface CleanBlock { jobs: Job[]; portions: number; }
function splitCleanBlocks(seq: Job[], co: CoParams): CleanBlock[] {
  const blocks: CleanBlock[] = [];
  let cur: Job[] = [];
  for (let i = 0; i < seq.length; i++) {
    if (i > 0 && isCleaning(classifyChangeover(seq[i - 1], seq[i], co).kind)) {
      blocks.push({ jobs: cur, portions: cur.reduce((s, j) => s + j.portions, 0) });
      cur = [];
    }
    cur.push(seq[i]);
  }
  if (cur.length) blocks.push({ jobs: cur, portions: cur.reduce((s, j) => s + j.portions, 0) });
  return blocks;
}

function slotBase(j: Job): Omit<PlatingSlot, "seq" | "startMin" | "endMin" | "changeoverBeforeMin" | "changeoverReason" | "changeoverKind"> {
  return {
    code: j.code, name: j.name, runIndex: j.runIndex, portions: j.portions,
    allergens: j.allergens, seafood: j.seafood, complexity: j.complexity,
    subMeals: j.subMeals, headcount: headcountFor(j.subMeals),
  };
}

/** Befüllt EINE Linie in der übergebenen Job-Reihenfolge (die Sequenz ist bereits
 *  aufsteigend optimiert — kein Nearest-Neighbour mehr nötig). Gibt die nicht mehr
 *  passenden Jobs zurück; `carryOver` wird hier NICHT annotiert (macht der finale
 *  annotateCarryOver-Lauf, sonst würde ein auf die nächste Linie geflossener Rest
 *  doppelt gezählt). */
function packLine(
  line: number, role: PlatingLinePlan["role"], availableMin: number,
  jobs: Job[], minPerPortion: number, co: CoParams,
  start?: { prev?: Job | null; usedMin?: number; seq?: number },
): { line: PlatingLinePlan; leftover: Job[] } {
  const slots: PlatingSlot[] = [];
  const seqOffset = start?.seq ?? 0;
  let used = start?.usedMin ?? 0;
  let platingMin = 0, changeoverMin = 0, cleanActions = 0, easy = 0;
  let prev: Job | null = start?.prev ?? null;
  const queue = [...jobs];

  while (queue.length) {
    const next = queue[0];
    const c = classifyChangeover(prev, next, co);
    const jobMin = next.portions * minPerPortion;

    if (used + c.min + jobMin <= availableMin + 0.01) {
      queue.shift();
      const startAt = used + c.min;
      slots.push({
        ...slotBase(next), seq: seqOffset + slots.length,
        startMin: round(startAt), endMin: round(startAt + jobMin),
        changeoverBeforeMin: c.min, changeoverReason: c.reason, changeoverKind: c.kind,
      });
      used = startAt + jobMin;
      platingMin += jobMin;
      changeoverMin += c.min;
      if (c.kind === "easy") easy++;
      else if (isCleaning(c.kind)) cleanActions++;
      prev = next;
      continue;
    }

    // passt nicht mehr ganz → Prefix draufpacken (wenn ≥ 50 Portionen reinpassen), Rest ist Leftover
    const roomMin = availableMin - used - c.min;
    const fit = Math.floor(roomMin / minPerPortion);
    if (fit >= 50) {
      queue.shift();
      const startAt = used + c.min;
      const fitMin = fit * minPerPortion;
      slots.push({
        ...slotBase(next), portions: fit, seq: seqOffset + slots.length,
        startMin: round(startAt), endMin: round(startAt + fitMin),
        changeoverBeforeMin: c.min, changeoverReason: c.reason, changeoverKind: c.kind,
      });
      used = startAt + fitMin;
      platingMin += fitMin;
      changeoverMin += c.min;
      if (c.kind === "easy") easy++;
      else if (isCleaning(c.kind)) cleanActions++;
      queue.unshift({ ...next, portions: next.portions - fit });
    }
    break; // Linie ist voll
  }

  return {
    line: {
      line, role, slots,
      platingMin: round(platingMin), changeoverMin: round(changeoverMin),
      availableMin: round(availableMin), changeovers: cleanActions, easyChangeovers: easy,
      ...lineStaffing(slots),
      overCapacity: used > availableMin + 1,
    },
    leftover: queue,
  };
}

/** L1-Highrunner-Auswahl: der größte saubere Block (0 Reinigungen). Passt der Block
 *  nicht ganz auf L1, kommt sein Prefix drauf und der Rest wandert weiter. Die
 *  übrigen Blöcke bleiben in aufsteigender Sequenz-Reihenfolge für L2. */
function pickHighrunner(blocks: CleanBlock[]): { l1Jobs: Job[]; rest: Job[] } {
  if (!blocks.length) return { l1Jobs: [], rest: [] };
  let biggest = 0;
  blocks.forEach((b, i) => { if (b.portions > blocks[biggest].portions) biggest = i; });
  const l1Jobs = [...blocks[biggest].jobs];
  const rest: Job[] = [];
  blocks.forEach((b, i) => { if (i !== biggest) rest.push(...b.jobs); });
  return { l1Jobs, rest };
}

/** Setzt `carryOver` auf dem jeweils LETZTEN Slot eines Codes, dessen Menge auf den
 *  Folgetag geschoben wird. Läuft nach dem Linien-Packen über alle Linien. */
function annotateCarryOver(lines: PlatingLinePlan[], carry: PlatingCarryItem[]): void {
  for (const item of carry) {
    let target: PlatingSlot | null = null;
    for (const l of lines) for (const s of l.slots) if (s.code === item.code) target = s;
    if (target) target.carryOver = item.portions;
  }
}

/** Linienplan für EINEN Tag (mit übernommenem Carry-in vom Vortag). */
export function generateDayPlan(
  plan: PlatingWeekPlan, day: PlatingDay, carryIn: PlatingCarryItem[] = [],
): PlatingDayPlan {
  const cap = plan.dayCapacity[day];
  const maxLines = cap?.lines ?? 0;
  const hours = cap?.hours ?? 0;
  const rate = plan.params.platingRatePerLineHour || 900;
  const co = coParams(plan.params);
  const minPerPortion = 60 / (rate > 0 ? rate : 900);
  const availableMin = hours * 60;
  const now = new Date().toISOString();

  const jobs = collectJobs(plan, day, carryIn);
  const carryInFromPrev = carryIn.filter(c => c.portions > 0);

  if (maxLines <= 0 || hours <= 0 || !jobs.length) {
    return {
      day, lines: [], carryInFromPrev,
      carryOutToNext: toCarryItems(jobs), generatedAt: now, source: "generated",
    };
  }

  const seq = sequenceAscending(jobs, co);
  const lines: PlatingLinePlan[] = [];
  let pool: Job[];

  if (maxLines === 1) {
    const r = packLine(1, "highrunner", availableMin, seq, minPerPortion, co);
    lines.push(r.line);
    pool = r.leftover;
  } else {
    const blocks = splitCleanBlocks(seq, co);
    const { l1Jobs, rest } = pickHighrunner(blocks);
    const r1 = packLine(1, "highrunner", availableMin, l1Jobs, minPerPortion, co);
    lines.push(r1.line);
    // L2 FLEX: der Highrunner-Rest (Split-Überhang zuerst) + die übrigen Blöcke
    const r2 = packLine(2, "flex", availableMin, [...r1.leftover, ...rest], minPerPortion, co);
    lines.push(r2.line);
    pool = r2.leftover;

    // L3.. OVERLOAD: nur wenn noch Volumen übrig UND der Tag ≥ 3 Linien hat
    let n = 3;
    while (pool.length && n <= maxLines) {
      const r = packLine(n, "overload", availableMin, pool, minPerPortion, co);
      lines.push(r.line);
      pool = r.leftover;
      n++;
    }

    // Restkapazität ALLER Linien auffüllen, bevor etwas auf den Folgetag wandert.
    // Marcel: „lieber durchziehen" — beim Plating ist die Zeit gegen das Soll der
    // Engpass, nicht die Reinigung (die Reinigungsfirma putzt am Schichtende eh
    // alles). Also Volumen fertig machen > saubere Linie halten. L1 zuerst
    // (Highrunner-Priorität), dann L2, L3 …
    for (const l of lines) {
      if (!pool.length) break;
      const usedMin = l.platingMin + l.changeoverMin;
      if (l.availableMin - usedMin <= 1) continue;
      const prevLast = l.slots.length ? jobFromSlot(l.slots[l.slots.length - 1]) : null;
      const r = packLine(l.line, l.role, l.availableMin, [...pool], minPerPortion, co,
        { prev: prevLast, usedMin, seq: l.slots.length });
      l.slots.push(...r.line.slots);
      l.platingMin += r.line.platingMin;
      l.changeoverMin += r.line.changeoverMin;
      l.changeovers += r.line.changeovers;
      l.easyChangeovers += r.line.easyChangeovers;
      Object.assign(l, lineStaffing(l.slots));
      l.overCapacity = (l.platingMin + l.changeoverMin) > l.availableMin + 1;
      pool = r.leftover;
    }
  }

  // Trailing leere Linien nicht ausgeben (z. B. L2 leer, weil alles auf L1 passte)
  while (lines.length > 1 && lines[lines.length - 1].slots.length === 0) lines.pop();

  const carryOutToNext = toCarryItems(pool);
  annotateCarryOver(lines, carryOutToNext);

  return { day, lines, carryInFromPrev, carryOutToNext, generatedAt: now, source: "generated" };
}

/** Slot → (Teil-)Job für Weiterrechnungen. */
function jobFromSlot(s: PlatingSlot): Job {
  return {
    code: s.code, name: s.name, runIndex: s.runIndex, portions: s.portions,
    allergens: s.allergens, allergenSet: allergenSet(s.allergens),
    seafood: s.seafood, complexity: s.complexity, subMeals: s.subMeals ?? 0,
    critical: s.seafood || (s.complexity != null && s.complexity >= COMPLEX_CX),
  };
}


/** Nach einer manuellen Umsortierung (Slots neu geordnet / Linie gewechselt) die
 *  Zeiten, Umrüstungen und Carry-over einer Linie neu berechnen. Die Slot-Reihen-
 *  folge + Linien-Zuordnung bleiben wie übergeben; nur die Ableitungen werden frisch.
 *  Cross-Day-Carry wird NICHT neu gefädelt — dafür „Tagespläne neu generieren". */
export function recomputeDayPlan(dp: PlatingDayPlan, plan: PlatingWeekPlan): PlatingDayPlan {
  const rate = plan.params.platingRatePerLineHour || 900;
  const minPerPortion = 60 / (rate > 0 ? rate : 900);
  const co = coParams(plan.params);
  const carryOut: Job[] = [];

  const lines: PlatingLinePlan[] = dp.lines.map(line => {
    const slots: PlatingSlot[] = [];
    let used = 0, platingMin = 0, changeoverMin = 0, cleanActions = 0, easy = 0;
    let prev: Job | null = null;
    let lineFull = false;
    for (const s of line.slots) {
      const total = s.portions + (s.carryOver ?? 0);
      const job: Job = { ...jobFromSlot(s), portions: total };
      if (lineFull) { carryOut.push(job); continue; }
      const c = classifyChangeover(prev, job, co);
      const jobMin = total * minPerPortion;
      if (used + c.min + jobMin <= line.availableMin + 0.01) {
        const start = used + c.min;
        slots.push({
          ...slotBase(job), portions: total, carryOver: undefined, seq: slots.length,
          startMin: round(start), endMin: round(start + jobMin),
          changeoverBeforeMin: c.min, changeoverReason: c.reason, changeoverKind: c.kind,
        });
        used = start + jobMin; platingMin += jobMin; changeoverMin += c.min;
        if (c.kind === "easy") easy++;
        else if (isCleaning(c.kind)) cleanActions++;
        prev = job;
      } else {
        const roomMin = line.availableMin - used - c.min;
        const fit = Math.floor(roomMin / minPerPortion);
        if (fit >= 50) {
          const start = used + c.min;
          const fitMin = fit * minPerPortion;
          slots.push({
            ...slotBase(job), portions: fit, carryOver: total - fit, seq: slots.length,
            startMin: round(start), endMin: round(start + fitMin),
            changeoverBeforeMin: c.min, changeoverReason: c.reason, changeoverKind: c.kind,
          });
          used = start + fitMin; platingMin += fitMin; changeoverMin += c.min;
          if (c.kind === "easy") easy++;
          else if (isCleaning(c.kind)) cleanActions++;
          carryOut.push({ ...job, portions: total - fit });
        } else {
          carryOut.push(job);
        }
        lineFull = true;
      }
    }
    return {
      ...line, slots,
      platingMin: round(platingMin), changeoverMin: round(changeoverMin),
      changeovers: cleanActions, easyChangeovers: easy,
      ...lineStaffing(slots),
      overCapacity: used > line.availableMin + 1,
    };
  });

  return {
    ...dp, lines, carryOutToNext: toCarryItems(carryOut),
    source: "edited", generatedAt: new Date().toISOString(),
  };
}

// ── Gezielte Umsortierung eines Tagesplans (Sortier-Modus + KI-Tools) ─────────

/** Eine Slot-Verschiebung im Tagesplan: Meal `code` (ggf. Run `runIndex`) auf
 *  Linie `toLine` an Position `toIndex` (0-basiert; fehlt = ans Ende). */
export interface DayPlanMove {
  code: string;
  runIndex?: number;
  toLine: number;
  toIndex?: number;
}

const codeDigits = (s: string): string => String(s || "").replace(/\D/g, "");
const codeNorm = (s: string): string => String(s || "").trim().toUpperCase();

/** Matcht einen Slot-Code gegen die Angabe im Move: erst exakt, dann (nur wenn
 *  vorhanden) über die Ziffern-Kennung — robuster als reines codeDigits, das bei
 *  Codes ohne Ziffern kollidieren würde. */
function slotCodeMatches(slotCode: string, wantCode: string): boolean {
  if (codeNorm(slotCode) === codeNorm(wantCode)) return true;
  const wd = codeDigits(wantCode);
  return wd.length > 0 && codeDigits(slotCode) === wd;
}

/** Wendet eine Reihe von Slot-Verschiebungen auf einen Tagesplan an und rechnet
 *  danach Zeiten/Umrüsten/Carry-over neu (via recomputeDayPlan). Die Slot-
 *  Reihenfolge folgt exakt den Moves; Cross-Day-Carry wird NICHT neu gefädelt.
 *  Genutzt vom „✎ Sortieren"-Modus und den KI-Tools. */
export function applyDayPlanMoves(
  dp: PlatingDayPlan, plan: PlatingWeekPlan, moves: DayPlanMove[],
): { dayPlan: PlatingDayPlan; applied: string[]; skipped: string[] } {
  const clone = structuredClone(dp);
  const applied: string[] = [];
  const skipped: string[] = [];
  const cap = plan.dayCapacity[dp.day];
  const maxLines = cap?.lines ?? clone.lines.length;
  const hours = cap?.hours ?? 0;
  const availableMin = hours > 0 ? hours * 60 : (clone.lines[0]?.availableMin ?? 0);

  for (const mv of moves) {
    let src: { line: PlatingLinePlan; idx: number } | null = null;
    for (const line of clone.lines) {
      const idx = line.slots.findIndex(s =>
        slotCodeMatches(s.code, mv.code) && (mv.runIndex == null || s.runIndex === mv.runIndex));
      if (idx >= 0) { src = { line, idx }; break; }
    }
    if (!src) { skipped.push(`${mv.code}: kein Slot im Tagesplan`); continue; }

    let target = clone.lines.find(l => l.line === mv.toLine) ?? null;
    if (!target) {
      if (mv.toLine === clone.lines.length + 1 && clone.lines.length < maxLines && availableMin > 0) {
        target = {
          line: mv.toLine, role: "overload", slots: [],
          platingMin: 0, changeoverMin: 0, availableMin,
          changeovers: 0, easyChangeovers: 0, peakHeadcount: 0, manMinutes: 0, overCapacity: false,
        };
        clone.lines.push(target);
      } else {
        skipped.push(`${mv.code}: Linie ${mv.toLine} existiert nicht`);
        continue;
      }
    }

    const [slot] = src.line.slots.splice(src.idx, 1);
    let insertAt = target.slots.length;
    if (mv.toIndex != null && Number.isFinite(mv.toIndex)) {
      insertAt = Math.max(0, Math.min(Math.trunc(mv.toIndex), target.slots.length));
      if (src.line === target && src.idx < insertAt) insertAt -= 1;
    }
    target.slots.splice(insertAt, 0, slot);
    applied.push(`${slot.code} → L${target.line}${mv.toIndex != null ? ` @${insertAt}` : ""}`);
  }

  while (clone.lines.length > 1 && clone.lines[clone.lines.length - 1].slots.length === 0) clone.lines.pop();

  return { dayPlan: recomputeDayPlan(clone, plan), applied, skipped };
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
  changeovers: number;         // = Saubermach-Aktionen
  cleaningActions: number;     // Alias, explizit
  easyChangeovers: number;
  changeoverMin: number;
  linesOver: number;
  carryOut: number;
  carryOutCritical: number;
  /** Besetzung: Spitze = Σ der Linien-Spitzenbesetzung (worst case gleichzeitig);
   *  manHours = Σ Personenminuten / 60 (Plating-Arbeitsstunden über den Tag). */
  peakHeadcount: number;
  manHours: number;
}

export function summarizeDayPlan(dp: PlatingDayPlan): DayPlanSummary {
  let totalPortions = 0, slots = 0, cleaningActions = 0, easyChangeovers = 0, changeoverMin = 0, linesOver = 0;
  let peakHeadcount = 0, manMinutes = 0;
  for (const l of dp.lines) {
    slots += l.slots.length;
    cleaningActions += l.changeovers;
    easyChangeovers += l.easyChangeovers ?? 0;
    changeoverMin += l.changeoverMin;
    if (l.overCapacity) linesOver++;
    peakHeadcount += l.peakHeadcount ?? 0;
    manMinutes += l.manMinutes ?? 0;
    for (const s of l.slots) totalPortions += s.portions;
  }
  return {
    day: dp.day, totalPortions, slots,
    changeovers: cleaningActions, cleaningActions, easyChangeovers, changeoverMin, linesOver,
    carryOut: dp.carryOutToNext.reduce((s, c) => s + c.portions, 0),
    carryOutCritical: dp.carryOutToNext.filter(c => c.critical).reduce((s, c) => s + c.portions, 0),
    peakHeadcount, manHours: Math.round(manMinutes / 6) / 10,
  };
}

/** Kurztext für den KI-Kontext / Tool-Ausgabe. */
export function describeDayPlan(dp: PlatingDayPlan): string {
  const out: string[] = [];
  const s = summarizeDayPlan(dp);
  out.push(
    `Plating-Tagesplan ${dp.day} · ${s.totalPortions} P · ${s.slots} Slots · ${s.cleaningActions} Reinigungen`
    + (s.easyChangeovers ? ` (+${s.easyChangeovers} easy)` : "")
    + ` · ${s.changeoverMin} min Rüsten`
    + (s.peakHeadcount ? ` · Besetzung ~${s.peakHeadcount} MA / ${s.manHours} Pers.-h` : "")
    + (s.linesOver ? ` · ⚠ ${s.linesOver} Linie(n) über Kapazität` : ""),
  );
  if (dp.carryInFromPrev.length) out.push(`  Carry-in: ${dp.carryInFromPrev.map(c => `${c.code} ${c.portions}`).join(", ")}`);
  for (const l of dp.lines) {
    const seq = l.slots.map(sl =>
      `${sl.code}${sl.changeoverBeforeMin ? `·${sl.changeoverKind === "easy" ? "~" : "🧽"}${sl.changeoverBeforeMin}` : ""}:${sl.portions}${sl.carryOver ? `(→${sl.carryOver})` : ""}`,
    ).join(" → ");
    out.push(`  L${l.line} ${l.role}: ${seq || "—"} [${l.platingMin + l.changeoverMin}/${l.availableMin} min · ${l.changeovers} Reinig.${l.peakHeadcount ? ` · ${l.peakHeadcount} MA` : ""}${l.overCapacity ? " ⚠" : ""}]`);
  }
  if (dp.carryOutToNext.length) {
    out.push(`  Carry-out → Folgetag: ${dp.carryOutToNext.map(c => `${c.code} ${c.portions}${c.critical ? " ⚠KRITISCH" : ""}`).join(", ")}`);
  }
  return out.join("\n");
}
