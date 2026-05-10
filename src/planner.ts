import type { DataBundle, ProcessSpec, Station, SubRecipe, WeekRecipe } from "./types";
import { STATIONS } from "./types";
import { DEFAULT_SHIFT_MIN, computeWeekLoad, getStationCapacityView, normalizePoolName } from "./equipment";

export const PLANNER_DAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] as const;
export const PLANNER_SHIFTS = ["S1", "S2", "S3"] as const;
export const SHIFT_CAPACITY_MIN = DEFAULT_SHIFT_MIN;
export const PLANNER_STORAGE_KEY = "rezeptlogik-planner-v1";

// Day timeline window: 06:00 → next 06:00 = 24h = 1440 min, shifts 8h each
export const DAY_START_HOUR = 6;
export const DAY_VISIBLE_MIN = 24 * 60;
export const SHIFT_LENGTH_MIN = 8 * 60;
export function getShiftStartMin(shift: PlannerShift): number {
  if (shift === "S1") return 0;          // 06:00
  if (shift === "S2") return SHIFT_LENGTH_MIN;     // 14:00
  return SHIFT_LENGTH_MIN * 2;            // 22:00
}
export function getShiftFromStartMin(min: number): PlannerShift {
  const m = ((min % DAY_VISIBLE_MIN) + DAY_VISIBLE_MIN) % DAY_VISIBLE_MIN;
  if (m < SHIFT_LENGTH_MIN) return "S1";
  if (m < SHIFT_LENGTH_MIN * 2) return "S2";
  return "S3";
}
export function formatDayMin(min: number): string {
  const totalMinutes = (DAY_START_HOUR * 60 + min) % (24 * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export type PlannerDay = typeof PLANNER_DAYS[number];
export type PlannerShift = typeof PLANNER_SHIFTS[number];

export interface RecipeAssignment {
  recipeCode: string;
  /** Wenn gesetzt: dies ist eine separat geplante Sub-Rezept-Zuordnung. */
  subRecipeId?: string;
  /** Anzeigename für Sub-Tiles (Cache für UI ohne data-Lookup). */
  subRecipeName?: string;
  day: PlannerDay;
  shift: PlannerShift;
  /** Reihenfolge innerhalb Tag+Schicht (1..n), unabhängig von Uhrzeit. */
  order?: number;
  /** Minuten ab 06:00 (0 … 1440). Optional – fallback = Schicht-Startminute */
  startMin?: number;
  note?: string;
}

/** Storage-Key innerhalb scenario.assignments. */
export function assignmentKey(recipeCode: string, subRecipeId?: string): string {
  return subRecipeId ? `${recipeCode}::${subRecipeId}` : recipeCode;
}

export interface PlannerScenario {
  id: string;
  name: string;
  assignments: Record<string, RecipeAssignment>;
}

interface PlannerWeekState {
  activeScenarioId: string;
  scenarios: PlannerScenario[];
}

interface PlannerStorage {
  weeks: Record<string, PlannerWeekState>;
}

export interface PlannerStationConflict {
  station: Station;
  day: PlannerDay;
  shift: PlannerShift;
  totalMin: number;
  capacityMin: number;
  deviceCount: number;
  utilizationPct: number;
  requiredDevices: number;
  assignments: Array<{ recipeCode: string; recipeName: string; minutes: number }>;
}

export interface PlannerPoolConflict {
  poolName: string;
  day: PlannerDay;
  shift: PlannerShift;
  totalMin: number;
  capacityMin: number;
  deviceCount: number;
  utilizationPct: number;
  requiredDevices: number;
  assignments: Array<{ recipeCode: string; recipeName: string; station: Station; minutes: number }>;
}

export interface SubRecipePlanEntry {
  subRecipeId: string;
  subRecipeName: string;
  category: string;
  activeMin: number;
  perStationMin: Partial<Record<Station, number>>;
  assigned?: RecipeAssignment;
}

export interface RecipePlanSummary {
  recipeCode: string;
  recipeName: string;
  assigned?: RecipeAssignment;
  /** Aktive Minuten der Hauptkachel = Gesamt minus separat geplanter Subs. */
  activeMin: number;
  /** Original-Gesamtzeit aller Subs. */
  totalActiveMin: number;
  topStations: Array<{ station: Station; minutes: number }>;
  subRecipes: SubRecipePlanEntry[];
}

export interface PlannerWeekAnalysis {
  week: string;
  scenario: PlannerScenario;
  unplannedCount: number;
  plannedCount: number;
  recipes: RecipePlanSummary[];
  conflicts: PlannerStationConflict[];
  poolConflicts: PlannerPoolConflict[];
  stationLoadBySlot: Record<string, Partial<Record<Station, number>>>;
  poolLoadBySlot: Record<string, Record<string, number>>;
}

export interface PlannerSuggestedAssignment {
  recipeCode: string;
  day: PlannerDay;
  shift: PlannerShift;
  score: number;
  reason: string;
}

function fallbackScenario(): PlannerScenario {
  return { id: "base", name: "Basis", assignments: {} };
}

function createScenarioId(): string {
  return `scn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isPlannerDay(v: unknown): v is PlannerDay {
  return typeof v === "string" && (PLANNER_DAYS as readonly string[]).includes(v);
}

function isPlannerShift(v: unknown): v is PlannerShift {
  return typeof v === "string" && (PLANNER_SHIFTS as readonly string[]).includes(v);
}

function sanitizeScenario(input: unknown): PlannerScenario | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id ? raw.id : createScenarioId();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Szenario";
  const assignmentsRaw = raw.assignments;
  const assignments: Record<string, RecipeAssignment> = {};
  if (assignmentsRaw && typeof assignmentsRaw === "object") {
    for (const [key, value] of Object.entries(assignmentsRaw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      if (typeof row.recipeCode !== "string" || !isPlannerDay(row.day) || !isPlannerShift(row.shift)) continue;
      const rawStart = row.startMin;
      const startMin = typeof rawStart === "number" && Number.isFinite(rawStart)
        ? Math.max(0, Math.min(DAY_VISIBLE_MIN - 1, Math.round(rawStart)))
        : undefined;
      const subRecipeId = typeof row.subRecipeId === "string" && row.subRecipeId ? row.subRecipeId : undefined;
      const subRecipeName = typeof row.subRecipeName === "string" && row.subRecipeName ? row.subRecipeName : undefined;
      const rawOrder = row.order;
      const order = typeof rawOrder === "number" && Number.isFinite(rawOrder)
        ? Math.max(1, Math.round(rawOrder))
        : undefined;
      assignments[key] = {
        recipeCode: row.recipeCode,
        subRecipeId,
        subRecipeName,
        day: row.day,
        shift: row.shift,
        order,
        startMin,
        note: typeof row.note === "string" && row.note.trim() ? row.note.trim() : undefined
      };
    }
  }
  return { id, name, assignments };
}

export function loadPlannerStorage(): PlannerStorage {
  if (typeof window === "undefined") return { weeks: {} };
  try {
    const raw = window.localStorage.getItem(PLANNER_STORAGE_KEY);
    if (!raw) return { weeks: {} };
    const parsed = JSON.parse(raw) as { weeks?: Record<string, unknown> };
    const weeks: PlannerStorage["weeks"] = {};
    for (const [week, value] of Object.entries(parsed.weeks ?? {})) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      const scenarios = Array.isArray(row.scenarios)
        ? row.scenarios.map(sanitizeScenario).filter(Boolean) as PlannerScenario[]
        : [];
      const normalized = scenarios.length > 0 ? scenarios : [fallbackScenario()];
      const activeScenarioId = typeof row.activeScenarioId === "string" && normalized.some(s => s.id === row.activeScenarioId)
        ? row.activeScenarioId
        : normalized[0].id;
      weeks[week] = { activeScenarioId, scenarios: normalized };
    }
    return { weeks };
  } catch {
    return { weeks: {} };
  }
}

export function savePlannerStorage(storage: PlannerStorage) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PLANNER_STORAGE_KEY, JSON.stringify(storage));
}

export function getWeekState(storage: PlannerStorage, week: string): PlannerWeekState {
  return storage.weeks[week] ?? { activeScenarioId: "base", scenarios: [fallbackScenario()] };
}

export function getActiveScenario(storage: PlannerStorage, week: string): PlannerScenario {
  const weekState = getWeekState(storage, week);
  return weekState.scenarios.find(s => s.id === weekState.activeScenarioId) ?? weekState.scenarios[0];
}

export function upsertWeekState(storage: PlannerStorage, week: string, updater: (prev: PlannerWeekState) => PlannerWeekState): PlannerStorage {
  const prev = getWeekState(storage, week);
  return {
    weeks: {
      ...storage.weeks,
      [week]: updater(prev)
    }
  };
}

export function assignRecipe(
  storage: PlannerStorage,
  week: string,
  scenarioId: string,
  recipe: WeekRecipe,
  assignment?: Omit<RecipeAssignment, "recipeCode">
): PlannerStorage {
  function nextOrderForSlot(assignments: Record<string, RecipeAssignment>, day: PlannerDay, shift: PlannerShift): number {
    let maxOrder = 0;
    for (const row of Object.values(assignments)) {
      if (row.day !== day || row.shift !== shift) continue;
      if (typeof row.order === "number" && Number.isFinite(row.order)) {
        maxOrder = Math.max(maxOrder, Math.round(row.order));
      }
    }
    return Math.max(1, maxOrder + 1);
  }

  return upsertWeekState(storage, week, prev => ({
    ...prev,
    scenarios: prev.scenarios.map(s => {
      if (s.id !== scenarioId) return s;
      const key = assignmentKey(recipe.code, assignment?.subRecipeId);
      const assignments = { ...s.assignments };
      if (!assignment) delete assignments[key];
      else {
        const existing = assignments[key];
        const keepsSlot = !!existing && existing.day === assignment.day && existing.shift === assignment.shift;
        const order = typeof assignment.order === "number" && Number.isFinite(assignment.order)
          ? Math.max(1, Math.round(assignment.order))
          : keepsSlot && typeof existing?.order === "number"
            ? existing.order
            : nextOrderForSlot(assignments, assignment.day, assignment.shift);
        assignments[key] = { recipeCode: recipe.code, ...assignment, order };
      }
      return { ...s, assignments };
    })
  }));
}

/** Löscht eine Sub-Rezept-Zuordnung (oder Hauptrezept, wenn subRecipeId leer). */
export function removeAssignment(
  storage: PlannerStorage,
  week: string,
  scenarioId: string,
  recipeCode: string,
  subRecipeId?: string
): PlannerStorage {
  return upsertWeekState(storage, week, prev => ({
    ...prev,
    scenarios: prev.scenarios.map(s => {
      if (s.id !== scenarioId) return s;
      const key = assignmentKey(recipeCode, subRecipeId);
      if (!(key in s.assignments)) return s;
      const assignments = { ...s.assignments };
      delete assignments[key];
      return { ...s, assignments };
    })
  }));
}

export function setActiveScenario(storage: PlannerStorage, week: string, scenarioId: string): PlannerStorage {
  return upsertWeekState(storage, week, prev => ({
    ...prev,
    activeScenarioId: prev.scenarios.some(s => s.id === scenarioId) ? scenarioId : prev.activeScenarioId
  }));
}

export function createScenario(storage: PlannerStorage, week: string, name: string, cloneFromId?: string): PlannerStorage {
  return upsertWeekState(storage, week, prev => {
    const source = prev.scenarios.find(s => s.id === cloneFromId) ?? prev.scenarios[0] ?? fallbackScenario();
    const scenario: PlannerScenario = {
      id: createScenarioId(),
      name: name.trim() || `Szenario ${prev.scenarios.length + 1}`,
      assignments: { ...source.assignments }
    };
    return {
      activeScenarioId: scenario.id,
      scenarios: [...prev.scenarios, scenario]
    };
  });
}

export function resetScenario(storage: PlannerStorage, week: string, scenarioId: string): PlannerStorage {
  return upsertWeekState(storage, week, prev => ({
    ...prev,
    scenarios: prev.scenarios.map(s => s.id === scenarioId ? { ...s, assignments: {} } : s)
  }));
}

export function analyzePlan(
  data: DataBundle,
  week: string,
  scenario: PlannerScenario,
  options?: { portionMultiplier?: number; shiftCapacityMin?: number; stationDeviceCounts?: Partial<Record<Station, number>>; stationPools?: Partial<Record<Station, string>> }
): PlannerWeekAnalysis {
  const load = computeWeekLoad(data, week, { portionMultiplier: options?.portionMultiplier });
  const shiftCapacityMin = options?.shiftCapacityMin ?? SHIFT_CAPACITY_MIN;
  const stationDeviceCounts = options?.stationDeviceCounts ?? {};
  const stationPools = options?.stationPools ?? {};
  const recipeNameByCode = Object.fromEntries(
    load.recipes.map(r => [r.weekRecipe.code, r.weekRecipe.recipeName])
  ) as Record<string, string>;
  const stationLoadBySlot: PlannerWeekAnalysis["stationLoadBySlot"] = {};
  const poolLoadBySlot: PlannerWeekAnalysis["poolLoadBySlot"] = {};
  const recipes: RecipePlanSummary[] = load.recipes.map(r => {
    const topStations = STATIONS
      .map(station => ({ station, minutes: r.perStationMin[station] ?? 0 }))
      .filter(row => row.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 3);
    const mainAssigned = scenario.assignments[r.weekRecipe.code];
    // Sub-Rezept Einträge aufbauen + separat geplante Subs identifizieren
    const subEntries: SubRecipePlanEntry[] = r.subs.map(sub => ({
      subRecipeId: sub.subRecipeId,
      subRecipeName: sub.subRecipeName,
      category: sub.category,
      activeMin: sub.totalActiveMin,
      perStationMin: sub.minutesPerStation,
      assigned: scenario.assignments[assignmentKey(r.weekRecipe.code, sub.subRecipeId)]
    }));
    const standaloneSubMin = subEntries.filter(s => s.assigned).reduce((sum, s) => sum + s.activeMin, 0);
    const mainActiveMin = Math.max(0, r.totalActiveMin - standaloneSubMin);

    // Last in Slot-Buckets schreiben – Hauptzuordnung trägt nur die NICHT separat geplanten Subs.
    if (mainAssigned) {
      const slotKey = `${mainAssigned.day}__${mainAssigned.shift}`;
      const current = stationLoadBySlot[slotKey] ?? {};
      const poolCurrent = poolLoadBySlot[slotKey] ?? {};
      for (const sub of r.subs) {
        const subAssigned = scenario.assignments[assignmentKey(r.weekRecipe.code, sub.subRecipeId)];
        if (subAssigned) continue; // wird unten separat verbucht
        for (const station of STATIONS) {
          const minutes = sub.minutesPerStation[station] ?? 0;
          if (minutes <= 0) continue;
          current[station] = (current[station] ?? 0) + minutes;
          const poolName = normalizePoolName(stationPools[station], station);
          poolCurrent[poolName] = (poolCurrent[poolName] ?? 0) + minutes;
        }
      }
      stationLoadBySlot[slotKey] = current;
      poolLoadBySlot[slotKey] = poolCurrent;
    }
    // Separat geplante Subs in eigene Slots verbuchen
    for (const sub of r.subs) {
      const subAssigned = scenario.assignments[assignmentKey(r.weekRecipe.code, sub.subRecipeId)];
      if (!subAssigned) continue;
      const slotKey = `${subAssigned.day}__${subAssigned.shift}`;
      const current = stationLoadBySlot[slotKey] ?? {};
      const poolCurrent = poolLoadBySlot[slotKey] ?? {};
      for (const station of STATIONS) {
        const minutes = sub.minutesPerStation[station] ?? 0;
        if (minutes <= 0) continue;
        current[station] = (current[station] ?? 0) + minutes;
        const poolName = normalizePoolName(stationPools[station], station);
        poolCurrent[poolName] = (poolCurrent[poolName] ?? 0) + minutes;
      }
      stationLoadBySlot[slotKey] = current;
      poolLoadBySlot[slotKey] = poolCurrent;
    }

    return {
      recipeCode: r.weekRecipe.code,
      recipeName: r.weekRecipe.recipeName,
      assigned: mainAssigned,
      activeMin: mainActiveMin,
      totalActiveMin: r.totalActiveMin,
      topStations,
      subRecipes: subEntries
    };
  });

  const buckets = new Map<string, PlannerStationConflict>();
  const poolBuckets = new Map<string, PlannerPoolConflict>();
  for (const r of load.recipes) {
    const mainAssigned = scenario.assignments[r.weekRecipe.code];
    for (const sub of r.subs) {
      const subAssigned = scenario.assignments[assignmentKey(r.weekRecipe.code, sub.subRecipeId)];
      const slotAssigned = subAssigned ?? mainAssigned;
      if (!slotAssigned) continue;
      const labelName = subAssigned
        ? `${recipeNameByCode[r.weekRecipe.code] ?? r.weekRecipe.code} · ${sub.subRecipeName}`
        : recipeNameByCode[r.weekRecipe.code] ?? r.weekRecipe.code;
      for (const station of STATIONS) {
        const minutes = sub.minutesPerStation[station] ?? 0;
        if (minutes <= 0) continue;
        const key = `${slotAssigned.day}__${slotAssigned.shift}__${station}`;
        const bucket = buckets.get(key) ?? {
          station,
          day: slotAssigned.day,
          shift: slotAssigned.shift,
          totalMin: 0,
          capacityMin: Math.max(1, Math.floor(stationDeviceCounts[station] ?? 1)) * shiftCapacityMin,
          deviceCount: Math.max(1, Math.floor(stationDeviceCounts[station] ?? 1)),
          utilizationPct: 0,
          requiredDevices: 0,
          assignments: []
        };
        bucket.totalMin += minutes;
        bucket.assignments.push({
          recipeCode: r.weekRecipe.code,
          recipeName: labelName,
          minutes
        });
        buckets.set(key, bucket);

        const poolName = normalizePoolName(stationPools[station], station);
        const poolKey = `${slotAssigned.day}__${slotAssigned.shift}__${poolName}`;
        const poolStations = STATIONS.filter(candidate => normalizePoolName(stationPools[candidate], candidate) === poolName);
        const poolDeviceCount = poolStations.reduce((sum, candidate) => sum + Math.max(1, Math.floor(stationDeviceCounts[candidate] ?? 1)), 0);
        const poolBucket = poolBuckets.get(poolKey) ?? {
          poolName,
          day: slotAssigned.day,
          shift: slotAssigned.shift,
          totalMin: 0,
          capacityMin: poolDeviceCount * shiftCapacityMin,
          deviceCount: poolDeviceCount,
          utilizationPct: 0,
          requiredDevices: 0,
          assignments: []
        };
        poolBucket.totalMin += minutes;
        poolBucket.assignments.push({
          recipeCode: r.weekRecipe.code,
          recipeName: labelName,
          station,
          minutes
        });
        poolBuckets.set(poolKey, poolBucket);
      }
    }
  }

  const conflicts = [...buckets.values()]
    .map(bucket => {
      const capacity = getStationCapacityView(bucket.totalMin, bucket.deviceCount, shiftCapacityMin);
      return {
        ...bucket,
        capacityMin: capacity.deviceCount * capacity.shiftMin,
        utilizationPct: capacity.utilizationPct,
        requiredDevices: capacity.requiredDevices
      };
    })
    .filter(bucket => bucket.totalMin > bucket.capacityMin || bucket.assignments.length > bucket.deviceCount)
    .sort((a, b) => b.totalMin - a.totalMin);

  const poolConflicts = [...poolBuckets.values()]
    .map(bucket => {
      const capacity = getStationCapacityView(bucket.totalMin, bucket.deviceCount, shiftCapacityMin);
      return {
        ...bucket,
        capacityMin: capacity.deviceCount * capacity.shiftMin,
        utilizationPct: capacity.utilizationPct,
        requiredDevices: capacity.requiredDevices
      };
    })
    .filter(bucket => bucket.totalMin > bucket.capacityMin)
    .sort((a, b) => b.totalMin - a.totalMin);

  return {
    week,
    scenario,
    unplannedCount: recipes.filter(r => !r.assigned && !r.subRecipes.some(s => s.assigned)).length,
    plannedCount: recipes.filter(r => !!r.assigned || r.subRecipes.some(s => s.assigned)).length,
    recipes: recipes.sort((a, b) => a.recipeName.localeCompare(b.recipeName)),
    conflicts,
    poolConflicts,
    stationLoadBySlot,
    poolLoadBySlot
  };
}

function recipePlanningHints(data: DataBundle, week: string, recipeCode: string): { thaw: boolean; preproduction: boolean; seafood: boolean } {
  const recipe = data.recipes[recipeCode];
  if (!recipe) return { thaw: false, preproduction: false, seafood: false };
  const subRecipes = Object.values(recipe.markets).flatMap(market => market.subRecipes);
  const categories = subRecipes.map(sub => sub.category.toLowerCase());
  const thaw = categories.some(category => category.includes("thaw"));
  const preproduction = subRecipes.some(sub => {
    const spec = data.processSpecs?.[sub.id];
    const holds = Object.values(spec?.holdTimeMin ?? {});
    return /blast chiller|butter/i.test(sub.category) || holds.some(v => (v ?? 0) >= 480) || spec?.productFamily === "Butter";
  });
  const seafood = Object.values(recipe.grossIngredients)
    .flatMap(rows => rows ?? [])
    .some(row => /salmon|shrimp|prawn|fish|seafood/i.test(`${row.ingredient} ${row.ingredientId}`));
  return { thaw, preproduction, seafood };
}

/**
 * Lead-Time-Klasse eines Subrezepts (in "Tagen vor Plating-Tag", die diese
 * Komponente fuer die Vorproduktion benoetigt). Hoehere Klasse = frueher in der
 * Woche eingeplant.
 *
 *  4 = Inbound / sehr lange Vorlaufprozesse (Brining, Curing, Ferment).
 *  3 = Saucen / Marinaden / Slow-Cook / Butter-Family / lange Hold-Zeiten.
 *  2 = Blast-Chiller / chilled Hold (8-24 h Vorlauf).
 *  1 = Standard-Vorbereitung am Vortag (Cutting, Chilled Prep).
 *  0 = Hot-Cook / Finishing (am Plating-Tag selbst).
 */
function subRecipeLeadClass(sub: SubRecipe, spec?: ProcessSpec): number {
  const cat = (sub.category ?? "").toLowerCase();
  const family = (spec?.productFamily ?? "").toLowerCase();
  const maxHold = Math.max(0, ...Object.values(spec?.holdTimeMin ?? {}).map(v => v ?? 0));

  // Inbound / lange Vorbereitung (>= 2 Tage)
  if (/brine|cure|ferment|marinade .*(over|long)|raw .*(receive|inbound)/i.test(cat)) return 4;
  if (maxHold >= 24 * 60) return 4;

  // Saucen, Slow-Cook, Butter-Family, lange Holds (>= 12 h)
  if (/sauce|broth|stock|gravy|braise|sous vide|slow cook|butter|marinade/i.test(cat)) return 3;
  if (family === "butter") return 3;
  if (maxHold >= 12 * 60) return 3;

  // Blast-Chiller / chilled Hold (>= 4 h)
  if (/blast chiller|chill hold|cold hold|portion .*(chill)/i.test(cat)) return 2;
  if (maxHold >= 4 * 60) return 2;

  // Hot Cook / Finishing
  if (/grill|fry|sear|roast|pan cook|wok|hot finish|griddle/i.test(cat)) return 0;

  // Standard chilled Vorbereitung
  return 1;
}

function defaultPlatingDayForRecipe(weekRecipe: WeekRecipe): PlannerDay {
  // Wenn es einen DE-Sonntagssplit gibt und der DE-Anteil ueberwiegt → Plating So.
  // Sonst Plating am Freitag (DK/SE + BENL + DE Split 1).
  const total = weekRecipe.verdenVolume.BENL + weekRecipe.verdenVolume.DKSE + weekRecipe.verdenVolume.DE;
  if (total <= 0) return "Fr";
  const deShare = weekRecipe.verdenVolume.DE / total;
  // Heuristik: ueberwiegender DE-Anteil → ein Teil laeuft Sonntag; wir wollen
  // dass die Komponenten bis Fr UND Sa fertig sind. Wir nehmen den FRUEHEREN
  // Plating-Tag (Fr) als Deadline, damit Komponenten fuer beide Splits da sind.
  if (deShare >= 0.6) return "Fr"; // bewusst Fr, weil Fr-Split 1 zuerst raus muss
  return "Fr";
}

function shiftDaysBackward(day: PlannerDay, days: number): PlannerDay {
  const idx = PLANNER_DAYS.indexOf(day);
  if (idx < 0) return day;
  const target = Math.max(0, idx - Math.max(0, days));
  const candidate = PLANNER_DAYS[target] ?? day;
  // Sa/So → Kueche zu, also auf den letzten Mo–Fr davor zurueckfallen.
  if (isKitchenOpen(candidate)) return candidate;
  for (let i = target - 1; i >= 0; i--) {
    const d = PLANNER_DAYS[i];
    if (d && isKitchenOpen(d)) return d;
  }
  return "Mo";
}

/**
 * Batch-Split Plan: pro Woche und Rezept werden die Mengen auf die beiden
 * Fulfillment-Tage (Fr / So) aufgeteilt, und je Charge wird das aus der
 * MHD-Regel (Fisch 9 Tage, sonst 13 Tage; Kunde will 7 Tage Rest) gueltige
 * Produktionsfenster berechnet.
 *
 * Hintergrund: Wenn DE am Sonntag (DE Split 2) gefulfillt wird, dann darf
 * Fisch nicht am Mo produziert werden, weil sonst beim Kunden weniger als
 * 7 Tage Rest-MHD ankommen. Folge: dieselbe SKU muss auf zwei Produktionstage
 * verteilt werden, z.B. 1000 Stk Di (fuer Fr-Fulfillment) und 1000 Stk Sa
 * (fuer So-Fulfillment).
 */
export interface BatchSplit {
  fulfillmentDay: PlannerDay;
  fulfillmentLabel: string;
  portions: number;
  earliestProductionDay: PlannerDay;
  latestProductionDay: PlannerDay;
  recommendedProductionDay: PlannerDay;
  reason: string;
}

export interface BatchSplitPlan {
  recipeCode: string;
  recipeName: string;
  isSeafood: boolean;
  shelfLifeDays: number;
  customerTargetDays: number;
  totalPortions: number;
  batches: BatchSplit[];
}

const CUSTOMER_TARGET_DAYS = 7;

function recipeIsSeafood(data: DataBundle, recipeCode: string): boolean {
  const recipe = data.recipes[recipeCode];
  if (!recipe) return false;
  return Object.values(recipe.grossIngredients)
    .flatMap(rows => rows ?? [])
    .some(row => /salmon|shrimp|prawn|fish|seafood|cod|tuna|trout|hering|herring/i.test(`${row.ingredient ?? ""} ${row.ingredientId ?? ""}`));
}

/**
 * Sa und So ist die Kueche in Verden NICHT besetzt. Produktion findet
 * ausschliesslich Mo–Fr statt. Fulfillment-Verladungen am Fr/So sind davon
 * unabhaengig, weil sie nur Versand sind.
 */
export const KITCHEN_OPEN_DAYS: ReadonlyArray<PlannerDay> = ["Mo", "Di", "Mi", "Do", "Fr"];
export const KITCHEN_CLOSED_DAYS: ReadonlyArray<PlannerDay> = ["Sa", "So"];

export function isKitchenOpen(day: PlannerDay): boolean {
  return KITCHEN_OPEN_DAYS.includes(day);
}

/** Findet den letzten Kueche-offen-Tag im Index-Bereich [earliestIdx..latestIdx]. */
function clampToKitchenOpenIdx(earliestIdx: number, latestIdx: number): { lo: number; hi: number } | null {
  let lo = -1;
  let hi = -1;
  for (let i = earliestIdx; i <= latestIdx; i++) {
    const d = PLANNER_DAYS[i];
    if (d && isKitchenOpen(d)) {
      if (lo === -1) lo = i;
      hi = i;
    }
  }
  if (lo === -1) return null;
  return { lo, hi };
}

function recommendedProdDayInWindow(
  fulfillmentDay: PlannerDay,
  earliestIdx: number,
  latestIdx: number
): PlannerDay {
  // Operativ bevorzugt: so spaet wie moeglich vor Fulfillment (max. MHD beim
  // Kunden), aber NUR an einem Kueche-offen-Tag (Mo–Fr) und nicht am
  // Fulfillment-Tag selbst (Plating-Last).
  const fulfillIdx = PLANNER_DAYS.indexOf(fulfillmentDay);
  const upper = Math.min(latestIdx, fulfillIdx - 1);
  const clamped = clampToKitchenOpenIdx(earliestIdx, Math.max(earliestIdx, upper));
  if (clamped) return PLANNER_DAYS[clamped.hi];
  // Fallback: gesamtes Fenster nur Sa/So → letzter Mo–Fr-Tag davor.
  for (let i = Math.min(latestIdx, PLANNER_DAYS.length - 1); i >= 0; i--) {
    const d = PLANNER_DAYS[i];
    if (d && isKitchenOpen(d)) return d;
  }
  return fulfillmentDay;
}

export function computeBatchSplitPlan(data: DataBundle, week: string): BatchSplitPlan[] {
  const rows = data.weekRecipes.filter(r => {
    if (r.hfWeek !== week) return false;
    const code = (r.code ?? "").toUpperCase();
    if (!(code.startsWith("FE") || code.startsWith("FV"))) return false;
    return (r.verdenVolume.BENL + r.verdenVolume.DKSE + r.verdenVolume.DE) > 0;
  });

  const plans: BatchSplitPlan[] = [];
  for (const wr of rows) {
    const dkse = wr.verdenVolume.DKSE ?? 0;
    const benl = wr.verdenVolume.BENL ?? 0;
    const de = wr.verdenVolume.DE ?? 0;
    const deFri = Math.round(de / 2);
    const deSun = Math.max(0, de - deFri);
    const friPortions = dkse + benl + deFri;
    const sunPortions = deSun;
    const totalPortions = friPortions + sunPortions;
    if (totalPortions <= 0) continue;

    const isSeafood = recipeIsSeafood(data, wr.code);
    const shelfLifeDays = isSeafood ? 9 : 13;
    const maxGapDays = Math.max(1, shelfLifeDays - CUSTOMER_TARGET_DAYS);

    const batches: BatchSplit[] = [];

    if (friPortions > 0) {
      const fulfillIdx = PLANNER_DAYS.indexOf("Fr");
      const earliestIdxRaw = Math.max(0, fulfillIdx - maxGapDays);
      const latestIdxRaw = fulfillIdx; // bis einschliesslich Fr (Plating)
      const clamped = clampToKitchenOpenIdx(earliestIdxRaw, latestIdxRaw);
      const earliestIdx = clamped ? clamped.lo : earliestIdxRaw;
      const latestIdx = clamped ? clamped.hi : latestIdxRaw;
      const earliest = PLANNER_DAYS[earliestIdx];
      const latest = PLANNER_DAYS[latestIdx];
      const recommended = recommendedProdDayInWindow("Fr", earliestIdx, latestIdx);
      batches.push({
        fulfillmentDay: "Fr",
        fulfillmentLabel: "Fulfillment 1 (DK/SE + BENL + DE Split 1)",
        portions: friPortions,
        earliestProductionDay: earliest,
        latestProductionDay: latest,
        recommendedProductionDay: recommended,
        reason: isSeafood
          ? `Fisch MHD 9d → fruehestens ${earliest}, empfohlen ${recommended} (Mo–Fr)`
          : `MHD 13d → Produktion ${earliest}–${latest} (Mo–Fr), empfohlen ${recommended}`
      });
    }

    if (sunPortions > 0) {
      const fulfillIdx = PLANNER_DAYS.indexOf("So");
      const earliestIdxRaw = Math.max(0, fulfillIdx - maxGapDays);
      const latestIdxRaw = fulfillIdx;
      const clamped = clampToKitchenOpenIdx(earliestIdxRaw, latestIdxRaw);
      const earliestIdx = clamped ? clamped.lo : earliestIdxRaw;
      const latestIdx = clamped ? clamped.hi : latestIdxRaw;
      const earliest = PLANNER_DAYS[earliestIdx];
      const latest = PLANNER_DAYS[latestIdx];
      const recommended = recommendedProdDayInWindow("So", earliestIdx, latestIdx);
      const kitchenClosedTail = !clamped || clamped.hi < latestIdxRaw;
      batches.push({
        fulfillmentDay: "So",
        fulfillmentLabel: "Fulfillment 2 (DE Split 2)",
        portions: sunPortions,
        earliestProductionDay: earliest,
        latestProductionDay: latest,
        recommendedProductionDay: recommended,
        reason: isSeafood
          ? `Fisch MHD 9d, Sa/So Kueche zu → Produktion zwingend ${recommended} (Vorlauf 2 Tage in den Versand am So)`
          : kitchenClosedTail
            ? `MHD 13d, Sa/So Kueche zu → spaetestmoeglich ${recommended}, Fenster ${earliest}–${latest}`
            : `MHD 13d → Produktion ${earliest}–${latest}, empfohlen ${recommended}`
      });
    }

    plans.push({
      recipeCode: wr.code,
      recipeName: wr.recipeName,
      isSeafood,
      shelfLifeDays,
      customerTargetDays: CUSTOMER_TARGET_DAYS,
      totalPortions,
      batches
    });
  }

  // Sortiere: Multi-Batch zuerst (Split-Faelle), dann Seafood, dann Rest.
  return plans.sort((a, b) => {
    const aMulti = a.batches.length > 1 ? 0 : 1;
    const bMulti = b.batches.length > 1 ? 0 : 1;
    if (aMulti !== bMulti) return aMulti - bMulti;
    if (a.isSeafood !== b.isSeafood) return a.isSeafood ? -1 : 1;
    return b.totalPortions - a.totalPortions;
  });
}

export function suggestAssignments(
  data: DataBundle,
  week: string,
  scenario: PlannerScenario,
  activeShifts: readonly PlannerShift[],
  options?: { portionMultiplier?: number; shiftCapacityMin?: number; stationDeviceCounts?: Partial<Record<Station, number>>; stationPools?: Partial<Record<Station, string>> }
): Record<string, PlannerSuggestedAssignment> {
  const analysis = analyzePlan(data, week, scenario, options);
  const stationDeviceCounts = options?.stationDeviceCounts ?? {};
  const stationPools = options?.stationPools ?? {};
  const shiftCapacityMin = options?.shiftCapacityMin ?? SHIFT_CAPACITY_MIN;
  const suggestions: Record<string, PlannerSuggestedAssignment> = {};

  // Mutable Last-Snapshots, damit Sub-Vorschlaege die schon vorgeschlagenen
  // Slots beruecksichtigen (vermeidet, dass alle in denselben Slot fallen).
  const stationLoad: Record<string, Partial<Record<Station, number>>> = JSON.parse(JSON.stringify(analysis.stationLoadBySlot));
  const poolLoad: Record<string, Record<string, number>> = JSON.parse(JSON.stringify(analysis.poolLoadBySlot));

  function pickShiftForSlot(day: PlannerDay, perStation: Partial<Record<Station, number>>): { shift: PlannerShift; overload: number; peak: number } {
    let best: { shift: PlannerShift; overload: number; peak: number } | undefined;
    for (const shift of activeShifts) {
      const slotKey = `${day}__${shift}`;
      let overload = 0;
      let peak = 0;
      for (const station of STATIONS) {
        const added = perStation[station] ?? 0;
        if (added <= 0) continue;
        const current = stationLoad[slotKey]?.[station] ?? 0;
        const cap = getStationCapacityView(current + added, stationDeviceCounts[station] ?? 1, shiftCapacityMin);
        peak = Math.max(peak, cap.utilizationPct);
        overload += Math.max(0, cap.utilizationPct - 100) * 10;
      }
      if (!best || overload + peak < best.overload + best.peak) best = { shift, overload, peak };
    }
    return best ?? { shift: activeShifts[0] ?? "S1", overload: 0, peak: 0 };
  }

  function commitLoad(day: PlannerDay, shift: PlannerShift, perStation: Partial<Record<Station, number>>) {
    const slotKey = `${day}__${shift}`;
    const current = stationLoad[slotKey] ?? {};
    const poolCurrent = poolLoad[slotKey] ?? {};
    for (const station of STATIONS) {
      const added = perStation[station] ?? 0;
      if (added <= 0) continue;
      current[station] = (current[station] ?? 0) + added;
      const poolName = normalizePoolName(stationPools[station], station);
      poolCurrent[poolName] = (poolCurrent[poolName] ?? 0) + added;
    }
    stationLoad[slotKey] = current;
    poolLoad[slotKey] = poolCurrent;
  }

  for (const recipe of analysis.recipes) {
    const recipeLoad = computeWeekLoad(data, week, { portionMultiplier: options?.portionMultiplier }).recipes.find(r => r.weekRecipe.code === recipe.recipeCode);
    if (!recipeLoad) continue;
    const platingDay = defaultPlatingDayForRecipe(recipeLoad.weekRecipe);
    const hints = recipePlanningHints(data, week, recipe.recipeCode);

    // Pro Sub-Rezept Lead-Klasse → Tag bestimmen.
    const subPlan: Array<{ sub: typeof recipeLoad.subs[number]; day: PlannerDay; leadClass: number }> = [];
    let earliestLeadClass = 0;
    for (const sub of recipeLoad.subs) {
      const leadClass = subRecipeLeadClass(
        { id: sub.subRecipeId, name: sub.subRecipeName, category: sub.category } as SubRecipe,
        sub.spec
      );
      const subDay = shiftDaysBackward(platingDay, leadClass);
      subPlan.push({ sub, day: subDay, leadClass });
      earliestLeadClass = Math.max(earliestLeadClass, leadClass);
    }

    // 1) Vorschlag fuer das Hauptrezept = Plating-Tag (der "letzte Touch") –
    //    fuer Hot-Cook/Finishing-Profile bleibt es am Plating-Tag. Wenn das
    //    Rezept aber NUR aus Vorlauf-Komponenten besteht, ziehen wir den
    //    Hauptslot mit nach vorne.
    const mainDay = recipeLoad.subs.length === 0
      ? platingDay
      : (subPlan.every(p => p.leadClass >= 2) ? shiftDaysBackward(platingDay, Math.min(2, earliestLeadClass)) : platingDay);
    const mainPick = pickShiftForSlot(mainDay, recipeLoad.perStationMin);
    if (!recipe.assigned) {
      suggestions[recipe.recipeCode] = {
        recipeCode: recipe.recipeCode,
        day: mainDay,
        shift: mainPick.shift,
        score: mainPick.overload + mainPick.peak,
        reason: hints.seafood
          ? `Seafood (MHD 9d): Plating ${mainDay} ${mainPick.shift}, Komponenten Mo–Mi`
          : hints.preproduction
            ? `Vorprod-Profil: Plating ${mainDay}, Lead bis Mo`
            : `Plating ${mainDay} ${mainPick.shift}; Subs rueckwaerts`
      };
    }
    commitLoad(mainDay, mainPick.shift, recipeLoad.perStationMin);

    // 2) Pro-Sub-Vorschlaege (Schluessel = recipeCode::subId), nur wenn nicht
    //    bereits zugeordnet.
    for (const plan of subPlan) {
      const key = assignmentKey(recipe.recipeCode, plan.sub.subRecipeId);
      const existing = scenario.assignments[key];
      if (existing) continue;
      const pick = pickShiftForSlot(plan.day, plan.sub.minutesPerStation);
      const reasonByClass: Record<number, string> = {
        4: `Inbound/Lange Vorlauf (KW-1): ${plan.day} ${pick.shift}`,
        3: `Sauce/Marinade/Slow-Cook: ${plan.day} ${pick.shift} (3 Tage vor Plating)`,
        2: `Blast-Chiller/Hold: ${plan.day} ${pick.shift} (2 Tage vor Plating)`,
        1: `Vortags-Prep: ${plan.day} ${pick.shift}`,
        0: `Hot-Cook/Finishing: am Plating-Tag ${plan.day} ${pick.shift}`
      };
      suggestions[key] = {
        recipeCode: recipe.recipeCode,
        day: plan.day,
        shift: pick.shift,
        score: pick.overload + pick.peak,
        reason: reasonByClass[plan.leadClass] ?? `geplant fuer ${plan.day} ${pick.shift}`
      };
      commitLoad(plan.day, pick.shift, plan.sub.minutesPerStation);
    }
  }

  return suggestions;
}