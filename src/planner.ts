import type { DataBundle, Station, WeekRecipe } from "./types";
import { STATIONS } from "./types";
import { DEFAULT_SHIFT_MIN, computeWeekLoad, getStationCapacityView, normalizePoolName } from "./equipment";

export const PLANNER_DAYS = ["Do", "Fr", "So", "Mo", "Di", "Mi"] as const;
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
      assignments[key] = {
        recipeCode: row.recipeCode,
        subRecipeId,
        subRecipeName,
        day: row.day,
        shift: row.shift,
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
  return upsertWeekState(storage, week, prev => ({
    ...prev,
    scenarios: prev.scenarios.map(s => {
      if (s.id !== scenarioId) return s;
      const key = assignmentKey(recipe.code, assignment?.subRecipeId);
      const assignments = { ...s.assignments };
      if (!assignment) delete assignments[key];
      else assignments[key] = { recipeCode: recipe.code, ...assignment };
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

  for (const recipe of analysis.recipes.filter(row => !row.assigned)) {
    const loadRecipe = analysis.recipes.find(row => row.recipeCode === recipe.recipeCode);
    if (!loadRecipe) continue;
    const recipeLoad = computeWeekLoad(data, week, { portionMultiplier: options?.portionMultiplier }).recipes.find(r => r.weekRecipe.code === recipe.recipeCode);
    if (!recipeLoad) continue;
    const hints = recipePlanningHints(data, week, recipe.recipeCode);
    const preferredDays = hints.thaw || hints.seafood
      ? ["Do", "Fr", "Sa", "So", "Mo", "Di", "Mi"]
      : hints.preproduction
        ? ["Do", "Sa", "Fr", "So", "Mo", "Di", "Mi"]
        : ["Fr", "So", "Do", "Sa", "Mo", "Di", "Mi"];

    let best: PlannerSuggestedAssignment | undefined;
    for (const day of PLANNER_DAYS) {
      for (const shift of activeShifts) {
        const slotKey = `${day}__${shift}`;
        let overloadPenalty = 0;
        let peakUtilization = 0;
        for (const station of STATIONS) {
          const current = analysis.stationLoadBySlot[slotKey]?.[station] ?? 0;
          const added = recipeLoad.perStationMin[station] ?? 0;
          if (added <= 0) continue;
          const capacity = getStationCapacityView(current + added, stationDeviceCounts[station] ?? 1, shiftCapacityMin);
          peakUtilization = Math.max(peakUtilization, capacity.utilizationPct);
          overloadPenalty += Math.max(0, capacity.utilizationPct - 100) * 10;
        }
        const poolLoads = new Map<string, number>();
        for (const station of STATIONS) {
          const added = recipeLoad.perStationMin[station] ?? 0;
          if (added <= 0) continue;
          const poolName = normalizePoolName(stationPools[station], station);
          poolLoads.set(poolName, (poolLoads.get(poolName) ?? (analysis.poolLoadBySlot[slotKey]?.[poolName] ?? 0)) + added);
        }
        for (const [poolName, total] of poolLoads.entries()) {
          const members = STATIONS.filter(candidate => normalizePoolName(stationPools[candidate], candidate) === poolName);
          const devices = members.reduce((sum, candidate) => sum + Math.max(1, Math.floor(stationDeviceCounts[candidate] ?? 1)), 0);
          const capacity = getStationCapacityView(total, devices, shiftCapacityMin);
          overloadPenalty += Math.max(0, capacity.utilizationPct - 100) * 12;
          peakUtilization = Math.max(peakUtilization, capacity.utilizationPct);
        }
        const dayPenalty = preferredDays.indexOf(day) >= 0 ? preferredDays.indexOf(day) * 5 : 30;
        const shiftPenalty = activeShifts.indexOf(shift) * 1.5;
        const score = overloadPenalty + peakUtilization + dayPenalty + shiftPenalty;
        const reason = overloadPenalty > 0
          ? `niedrigste Ueberlast fuer ${day} ${shift}`
          : hints.thaw || hints.seafood
            ? `THAW/Seafood bevorzugt frueh: ${day} ${shift}`
            : hints.preproduction
              ? `Prep-/Chiller-Profil bevorzugt ${day} ${shift}`
              : `geringste Last in ${day} ${shift}`;
        if (!best || score < best.score) best = { recipeCode: recipe.recipeCode, day, shift, score, reason };
      }
    }
    if (best) suggestions[recipe.recipeCode] = best;
  }

  return suggestions;
}