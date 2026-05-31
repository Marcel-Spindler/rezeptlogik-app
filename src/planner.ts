import type { DataBundle, ProcessSpec, Station, SubRecipe, WeekRecipe } from "./types";
import { STATIONS } from "./types";
import { DEFAULT_SHIFT_MIN, computeWeekLoad, getStationCapacityView, normalizePoolName } from "./equipment";
import { runSplitForRecipeLike } from "./runPlanning";

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
  /** Optionales Soll pro Zuordnung (Main/Sub) für Wochenboard-Dialog. */
  targetPortions?: number;
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
      const rawTarget = row.targetPortions;
      const targetPortions = typeof rawTarget === "number" && Number.isFinite(rawTarget)
        ? Math.max(0, Math.round(rawTarget))
        : undefined;
      assignments[key] = {
        recipeCode: row.recipeCode,
        subRecipeId,
        subRecipeName,
        day: row.day,
        shift: row.shift,
        order,
        startMin,
        targetPortions,
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

  // @ts-expect-error unused
function recipePlanningHints(data: DataBundle, week: string, recipeCode: string): { thaw: boolean; preproduction: boolean; seafood: boolean } {
  const recipe = resolvePlannerRecipe(data, recipeCode);
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
  if (/thaw|thawed|defrost/i.test(cat)) return 4;
  if (/brine|cure|ferment|marinade .*(over|long)|raw .*(receive|inbound)/i.test(cat)) return 4;
  if (maxHold >= 24 * 60) return 4;

  // Saucen, Slow-Cook, Butter-Family, lange Holds (>= 12 h)
  if (/sauce|broth|stock|gravy|braise|sous vide|slow cook|butter|marinade|hand marinade/i.test(cat)) return 3;
  if (family === "butter") return 3;
  if (maxHold >= 12 * 60) return 3;

  // Blast-Chiller / chilled Hold (>= 4 h)
  if (/blast chiller|chill hold|cold hold|portion .*(chill)/i.test(cat)) return 2;
  if (maxHold >= 4 * 60) return 2;

  if (/patty maker|burger patty|patty/i.test(cat)) return 2;

  // Hot Cook / Finishing
  if (/grill|fry|sear|roast|pan cook|wok|hot finish|griddle/i.test(cat)) return 0;

  // Standard chilled Vorbereitung
  return 1;
}

function defaultPlatingDayForRecipe(weekRecipe: WeekRecipe): PlannerDay {
  // Plating-Linie läuft 1 Tag VOR dem Versand (Fr), damit noch Zeit für Sleeving bleibt.
  // → Plating-Anker für die Küchen-Autoplanung = "Do" (Donnerstag).
  // Ausnahme: wenn DE-Anteil überwiegt und ein So-Split entsteht, bleibt Do als
  // frühester gemeinsamer Anker (Fr-Split 1 läuft auf Do, So-Split auf Sa – Do
  // deckt trotzdem den frühesten Bedarf ab).
  const total = weekRecipe.verdenVolume.BENL + weekRecipe.verdenVolume.DKSE + weekRecipe.verdenVolume.DE;
  if (total <= 0) return "Do";
  return "Do"; // 1 Tag vor Fr-Versand → Sleeving-Puffer sichergestellt
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
  /** Tatsächlicher Plating-Linen-Tag (= 1 Tag vor Versand im Fallback; = entry.platDay bei liniengetriebenem Pfad) */
  platDay: PlannerDay;
  earliestProductionDay: PlannerDay;
  latestProductionDay: PlannerDay;
  recommendedProductionDay: PlannerDay;
  reason: string;
  /** Kapazität der Plating-Linie für diesen Batch (wenn aus Linienplanung bekannt) */
  lineCapacityPortions?: number;
}

export interface BatchSplitPlan {
  recipeCode: string;
  recipeName: string;
  isSeafood: boolean;
  shelfLifeDays: number;
  customerTargetDays: number;
  totalPortions: number;
  batches: BatchSplit[];
  /** Gesamtkapazität aller Plating-Linien für dieses Rezept (wenn bekannt) */
  totalLineCapacity?: number;
  /** Forecast - Linienkapazität (positiv = Lücke, negativ = Überschuss) */
  lineCoverageGap?: number;
}

/**
 * Zusammenfassung der Plating-Linienkapazität pro Rezept und Produktionstag.
 * Wird aus dem Linienplan-Schedule (Firestore) berechnet und an
 * computeBatchSplitPlan übergeben.
 */
export interface LinePlatingEntry {
  /** Produktionstag auf der Linie (als PlannerDay: Mo/Di/Mi/Do/Fr/Sa/So) */
  platDay: PlannerDay;
  /** Gesamtkapazität der Linie an diesem Tag für dieses Rezept (Portionen) */
  capacityPortions: number;
  /** Anzahl der belegten Zeitslots */
  slotCount: number;
}

export interface LinePlatingSummary {
  /** keyed by recipe code */
  byRecipe: Record<string, LinePlatingEntry[]>;
}

export interface SpecialDeliveryOrder {
  id: string;
  recipeCode: string;
  fulfillmentDay: PlannerDay;
  portions: number;
  market?: string;
  note?: string;
  manualStatus?: "open" | "done";
}

type ComputeBatchSplitPlanOptions = {
  lineSummary?: LinePlatingSummary;
  specialDeliveries?: SpecialDeliveryOrder[];
  /** Letzter Sub-Rezept-Tag je Rezept-Code → Plating-Tag = nächster Tag danach */
  subRecipeLastDays?: Map<string, PlannerDay>;
  /** Nur Run 1 planen (kein Run-2-Split) */
  singleRun?: boolean;
};

const CUSTOMER_TARGET_DAYS = 7;

function plannerRecipeDigitKey(code: string): string {
  const match = /(\d{4,5})/.exec(String(code ?? ""));
  return match ? match[1] : String(code ?? "");
}

function resolvePlannerRecipe(data: DataBundle, code: string) {
  const exact = data.recipes[code];
  if (exact) return exact;
  const wanted = plannerRecipeDigitKey(code);
  return Object.values(data.recipes).find((recipe) => plannerRecipeDigitKey(recipe.code) === wanted);
}

function recipeIsSeafood(data: DataBundle, recipeCode: string): boolean {
  const recipe = resolvePlannerRecipe(data, recipeCode);
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

/**
 * Berechnet den empfohlenen Küchenproduktions-Tag relativ zu einem gegebenen
 * Plating-Tag unter Berücksichtigung der MHD-Regeln.
 */
function computeProductionWindowForPlatDay(
  platDay: PlannerDay,
  maxGapDays: number
): { earliest: PlannerDay; latest: PlannerDay; recommended: PlannerDay } {
  const platIdx = PLANNER_DAYS.indexOf(platDay);
  // Küche muss spätestens am Tag VOR dem Plating fertig sein
  const latestIdxRaw = Math.max(0, platIdx - 1);
  const earliestIdxRaw = Math.max(0, platIdx - maxGapDays);
  const clamped = clampToKitchenOpenIdx(earliestIdxRaw, latestIdxRaw);
  const earliestIdx = clamped ? clamped.lo : earliestIdxRaw;
  const latestIdx = clamped ? clamped.hi : latestIdxRaw;
  const recommended = recommendedProdDayInWindow(platDay, earliestIdx, latestIdx);
  return {
    earliest: PLANNER_DAYS[earliestIdx] ?? platDay,
    latest: PLANNER_DAYS[latestIdx] ?? platDay,
    recommended,
  };
}

/**
 * Batch-Split Plan: pro Woche und Rezept werden die Mengen auf die Plating-Tage
 * aufgeteilt.
 *
 * Wenn `lineSummary` übergeben wird und für ein Rezept Plating-Linen-Einträge
 * vorhanden sind, werden die Batches aus dem Linienplan abgeleitet (liniengetrieben).
 * Die Ghost-Pills zeigen dann den tatsächlichen Plating-Tag der Linie und die
 * Linienkapazität. Der Forecast-Vergleich wird in `lineCoverageGap` geliefert.
 *
 * Ohne Linienplan (oder wenn ein Rezept im Linienplan fehlt) fällt die Funktion
 * auf die MHD-basierte Fr/So-Heuristik zurück.
 */
export function computeBatchSplitPlan(
  data: DataBundle,
  week: string,
  options?: ComputeBatchSplitPlanOptions
): BatchSplitPlan[] {
  const rows = data.weekRecipes.filter(r => {
    if (r.hfWeek !== week) return false;
    const code = (r.code ?? "").toUpperCase();
    if (!(code.startsWith("FE") || code.startsWith("FV"))) return false;
    return (r.verdenVolume.BENL + r.verdenVolume.DKSE + r.verdenVolume.DE) > 0;
  });

  const plans: BatchSplitPlan[] = [];
  for (const wr of rows) {
    const runSplit = runSplitForRecipeLike(wr);
    const runOnePortions = runSplit.firstRun.total;
    const totalPortions = runSplit.baseTotal;
    // @ts-expect-error unused
    const _runTwoPortions = Math.max(0, totalPortions - runOnePortions);
    if (totalPortions <= 0) continue;

    const isSeafood = recipeIsSeafood(data, wr.code);
    const shelfLifeDays = isSeafood ? 9 : 13;
    const maxGapDays = Math.max(1, shelfLifeDays - CUSTOMER_TARGET_DAYS);

    const specialDeliveries = (options?.specialDeliveries ?? [])
      .filter((entry) => entry.recipeCode === wr.code && entry.portions > 0);
    const forcedByDay = new Map<PlannerDay, { portions: number; labels: string[] }>();
    for (const delivery of specialDeliveries) {
      const current = forcedByDay.get(delivery.fulfillmentDay) ?? { portions: 0, labels: [] };
      current.portions += Math.max(0, Math.round(delivery.portions));
      const extra = [delivery.market?.trim(), delivery.note?.trim()].filter(Boolean).join(" · ");
      current.labels.push(extra ? extra : "Sonderlieferung");
      forcedByDay.set(delivery.fulfillmentDay, current);
    }
    const forcedTotal = [...forcedByDay.values()].reduce((sum, row) => sum + row.portions, 0);

    // ── Liniengetriebener Pfad ──────────────────────────────────────────────
    const lineEntries = options?.lineSummary?.byRecipe[wr.code];
    if (lineEntries && lineEntries.length > 0 && forcedByDay.size === 0) {
      // Einträge chronologisch sortieren (Mo < Di < ... < So)
      const sorted = [...lineEntries].sort(
        (a, b) => PLANNER_DAYS.indexOf(a.platDay) - PLANNER_DAYS.indexOf(b.platDay)
      );
      let remainingLineTarget = totalPortions;
      const cappedEntries = sorted
        .map((entry) => {
          const capacityPortions = Math.max(0, Math.min(entry.capacityPortions, remainingLineTarget));
          remainingLineTarget -= capacityPortions;
          return { ...entry, capacityPortions };
        })
        .filter((entry) => entry.capacityPortions > 0);
      const totalLineCapacity = cappedEntries.reduce((s, e) => s + e.capacityPortions, 0);
      const lineCoverageGap = totalPortions - totalLineCapacity; // positiv = Lücke

      const batches: BatchSplit[] = cappedEntries.map((entry) => {
        const { earliest, latest, recommended } = computeProductionWindowForPlatDay(
          entry.platDay, maxGapDays
        );
        return {
          fulfillmentDay: entry.platDay,
          platDay: entry.platDay,
          fulfillmentLabel: `Plating-Linie ${entry.platDay} (${entry.slotCount} Slot${entry.slotCount !== 1 ? "s" : ""})`,
          portions: entry.capacityPortions,
          earliestProductionDay: earliest,
          latestProductionDay: latest,
          recommendedProductionDay: recommended,
          reason: `Linienplanung: ${entry.slotCount} Slot(s) am ${entry.platDay} → ${entry.capacityPortions.toLocaleString("de-DE")} Port. Kapazität${isSeafood ? " (Fisch MHD 9d)" : ""}`,
          lineCapacityPortions: entry.capacityPortions,
        } satisfies BatchSplit;
      });

      plans.push({
        recipeCode: wr.code,
        recipeName: wr.recipeName,
        isSeafood,
        shelfLifeDays,
        customerTargetDays: CUSTOMER_TARGET_DAYS,
        totalPortions,
        batches,
        totalLineCapacity,
        lineCoverageGap,
      });
      continue;
    }

    // ── Fallback: Run-Template aus Planning OASE ───────────────────────────
    // Run 1 = BENL 50% + Nordics 100% + DE 70%.
    // Run 2 = Restmenge des echten Verden-Plans, ohne automatischen 10%-Puffer.
    const batches: BatchSplit[] = [];

    const pushBatchForDay = (
      fulfillmentDay: PlannerDay,
      portions: number,
      fulfillmentLabel: string,
      reason: string,
      lineCapacityPortions?: number,
    ) => {
      if (portions <= 0) return;
      const platDay = fulfillmentDay;
      const { earliest, latest, recommended } = computeProductionWindowForPlatDay(platDay, maxGapDays);
      batches.push({
        fulfillmentDay,
        platDay,
        fulfillmentLabel,
        portions,
        earliestProductionDay: earliest,
        latestProductionDay: latest,
        recommendedProductionDay: recommended,
        reason,
        lineCapacityPortions,
      });
    };

    for (const [day, row] of [...forcedByDay.entries()].sort((a, b) => PLANNER_DAYS.indexOf(a[0]) - PLANNER_DAYS.indexOf(b[0]))) {
      pushBatchForDay(
        day,
        row.portions,
        `Sonderlieferung ${day}`,
        `Sonderlieferung fix auf ${day}: ${row.labels.join(" / ")}${isSeafood ? " · Fisch MHD 9d" : ""}`,
      );
    }

    const remainingPortions = Math.max(0, totalPortions - forcedTotal);
    const remainingRunOnePortions = Math.min(runOnePortions, remainingPortions);
    const remainingRunTwoPortions = options?.singleRun ? 0 : Math.max(0, remainingPortions - remainingRunOnePortions);

    // Dynamischer Plating-Tag aus letztem Sub-Rezept-Tag (+ 1 Tag), Fallback: Fr/So
    const lastSubDay = options?.subRecipeLastDays?.get(wr.code);
    const run1FulfillDay: PlannerDay = (() => {
      if (!lastSubDay) return "Fr";
      const idx = PLANNER_DAYS.indexOf(lastSubDay);
      return idx >= 0 && idx < PLANNER_DAYS.length - 1 ? PLANNER_DAYS[idx + 1]! : lastSubDay;
    })();
    const run2FulfillDay: PlannerDay = (() => {
      if (!lastSubDay) return "So";
      // Run 2 Sub-Rezepte liegen 1 Tag später als Run 1 → Plating = Run 1 Plating + 1
      const idx = PLANNER_DAYS.indexOf(run1FulfillDay);
      const next = idx >= 0 && idx < PLANNER_DAYS.length - 1 ? PLANNER_DAYS[idx + 1]! : run1FulfillDay;
      // Run 2 darf nicht später als Samstag sein
      const satIdx = PLANNER_DAYS.indexOf("Sa");
      return PLANNER_DAYS.indexOf(next) <= satIdx ? next : "Sa";
    })();

    if (remainingRunOnePortions > 0) {
      pushBatchForDay(
        run1FulfillDay,
        remainingRunOnePortions,
        `Run 1 (BNL ${Math.round((wr.verdenVolume.BENL ?? 0) * 0.5).toLocaleString("de-DE")} + Nordics ${(wr.verdenVolume.DKSE ?? 0).toLocaleString("de-DE")} + DE ${Math.round((wr.verdenVolume.DE ?? 0) * 0.7).toLocaleString("de-DE")})`,
        isSeafood
          ? `Run 1 nach Template: BENL 50%, Nordics 100%, DE 70% → Fisch MHD 9d`
          : `Run 1 nach Template: BENL 50%, Nordics 100%, DE 70% → MHD 13d`,
      );
    }

    if (remainingRunTwoPortions > 0) {
      pushBatchForDay(
        run2FulfillDay,
        remainingRunTwoPortions,
        "Run 2 (Restmenge Verden Plan)",
        isSeafood
          ? `Run 2 = Verden Plan minus Sonderlieferungen/Run 1 → Fisch MHD 9d`
          : "Run 2 = Verden Plan minus Sonderlieferungen/Run 1",
      );
    }

    plans.push({
      recipeCode: wr.code,
      recipeName: wr.recipeName,
      isSeafood,
      shelfLifeDays,
      customerTargetDays: CUSTOMER_TARGET_DAYS,
      totalPortions,
      batches: batches.sort((a, b) => PLANNER_DAYS.indexOf(a.fulfillmentDay) - PLANNER_DAYS.indexOf(b.fulfillmentDay))
    });
  }

  // Sortiere: Liniengetriebene zuerst, dann Multi-Batch (Split-Faelle), dann Seafood, dann Rest.
  return plans.sort((a, b) => {
    const aLine = a.totalLineCapacity !== undefined ? 0 : 1;
    const bLine = b.totalLineCapacity !== undefined ? 0 : 1;
    if (aLine !== bLine) return aLine - bLine;
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
  options?: { portionMultiplier?: number; shiftCapacityMin?: number; stationDeviceCounts?: Partial<Record<Station, number>>; stationPools?: Partial<Record<Station, string>>; lineSummary?: LinePlatingSummary }
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

    // Plating-Tag: aus Linienplan (Quelle der Wahrheit) oder Fallback-Heuristik.
    // Wenn mehrere Plating-Tage im Linienplan existieren, nehmen wir den
    // FRÜHESTEN, da der rückwärts geplante Küchentag konservativ sein muss.
    const lineEntries = options?.lineSummary?.byRecipe[recipe.recipeCode];
    const platingDay: PlannerDay = lineEntries && lineEntries.length > 0
      ? lineEntries.reduce((earliest, e) =>
          PLANNER_DAYS.indexOf(e.platDay) < PLANNER_DAYS.indexOf(earliest.platDay) ? e : earliest
        ).platDay
      : defaultPlatingDayForRecipe(recipeLoad.weekRecipe);

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
