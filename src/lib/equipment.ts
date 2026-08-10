// Equipment-/Workflow-Berechnungen für Verden (VF).
// Annahmen (bewusst dokumentiert):
//   - "totalVerdenVolume" = Summe BENL+DKSE+DE = wird in einem Schwung produziert.
//   - kg pro Sub-Rezept = portions × g/Portion / 1000.
//     g/Portion = bevorzugt SubRecipe.yield (wenn Yield-UOM "g"/"grams"),
//     sonst Summe der grossIngredients-Zeilen, deren Sub-Rezept-Match passt
//     UND deren UOM in {g, grams} liegt.
//   - batches = ceil(kg / processSpec.batchSizeKg). Bei batchSizeKg<=0 → 1 Batch.
//   - Minuten pro Station = batches × minutesPerBatch[s].
//   - Hold-Time wird einmalig (nicht ×batches) addiert, weil Lagerung parallel passiert.
//   - Workflow-Reihenfolge der Schritte: Wir parsen SubRecipe.category (z. B.
//     "SPICE PORTIONING / BRAISER / BLAST CHILLER"), splitten per "/" und mappen
//     jedes Token via STATION_ALIAS auf eine Station; unbekannte Tokens bleiben
//     als Roh-Label erhalten (damit nichts verloren geht).

import type {
  DataBundle, WeekRecipe, Recipe, SubRecipe, ProcessSpec, Market, Station
} from "../core/types";
import { STATIONS } from "../core/types";

const MARKETS: Market[] = ["BENL", "DKSE", "DE"];
export const DEFAULT_SHIFT_MIN = 8 * 60;
export const STATION_DEVICE_COUNT_STORAGE_KEY = "rezeptlogik-station-device-counts-v1";
export const STATION_POOL_STORAGE_KEY = "rezeptlogik-station-pools-v1";
export const DEFAULT_STATION_DEVICE_COUNTS: Record<Station, number> = {
  // Baseline aus aktuellem Equipment-Sheet/Fotos (falls fuer eine Station nichts klar war: konservativ 1).
  "Staging": 3,
  "Spice Portioning": 1,
  "Debox": 1,
  "Thaw": 1,
  "Brine": 20,
  "Marinade": 20,
  "Hand Marinade": 1,
  "Immersion Blender": 15,
  "Planetary Mixer": 6,
  "Horizontal Mixer": 1,
  "Patty Maker": 1,
  "Braiser": 6,
  "Grill": 3,
  "Crusted": 1,
  "Oven": 10,
  "Drain": 1,
  "Hand Mix": 15,
  "Cold Shredder": 1,
  "Hot Shredder": 1,
  "Scooper": 20,
  "Butter Machine": 20,
  "Slicer": 1,
  "Cupping": 1,
  "Blast Chiller": 1
};
export const DEFAULT_STATION_POOLS: Record<Station, string> = Object.fromEntries(
  STATIONS.map(station => [station, station])
) as Record<Station, string>;

export function loadStationDeviceCounts(): Record<Station, number> {
  if (typeof window === "undefined") return { ...DEFAULT_STATION_DEVICE_COUNTS };
  try {
    const raw = window.localStorage.getItem(STATION_DEVICE_COUNT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATION_DEVICE_COUNTS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_STATION_DEVICE_COUNTS };
    for (const station of STATIONS) {
      const value = Number(parsed[station]);
      if (Number.isFinite(value) && value > 0) out[station] = Math.max(1, Math.floor(value));
    }
    return out;
  } catch {
    return { ...DEFAULT_STATION_DEVICE_COUNTS };
  }
}

export function saveStationDeviceCounts(counts: Record<Station, number>) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STATION_DEVICE_COUNT_STORAGE_KEY, JSON.stringify(counts));
}

export function normalizePoolName(value: string | undefined, fallback: Station): string {
  const trimmed = (value ?? "").trim();
  return trimmed || fallback;
}

export function loadStationPools(): Record<Station, string> {
  if (typeof window === "undefined") return { ...DEFAULT_STATION_POOLS };
  try {
    const raw = window.localStorage.getItem(STATION_POOL_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATION_POOLS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out = { ...DEFAULT_STATION_POOLS };
    for (const station of STATIONS) out[station] = normalizePoolName(String(parsed[station] ?? ""), station);
    return out;
  } catch {
    return { ...DEFAULT_STATION_POOLS };
  }
}

export function saveStationPools(pools: Record<Station, string>) {
  if (typeof window === "undefined") return;
  const normalized = Object.fromEntries(STATIONS.map(station => [station, normalizePoolName(pools[station], station)])) as Record<Station, string>;
  window.localStorage.setItem(STATION_POOL_STORAGE_KEY, JSON.stringify(normalized));
}

// Mapping von Cook-Method-Token → Station (case- und whitespace-insensitive).
const STATION_ALIAS: Record<string, Station> = (() => {
  const m: Record<string, Station> = {};
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Direkter 1:1-Match
  for (const s of STATIONS) m[norm(s)] = s;
  // Aliase
  m[norm("Spice")] = "Spice Portioning";
  m[norm("Hand Marinate")] = "Hand Marinade";
  m[norm("ImmersionBlender")] = "Immersion Blender";
  m[norm("Cooler")] = "Blast Chiller";
  m[norm("BC")] = "Blast Chiller";
  m[norm("Tilt Skillet")] = "Braiser";
  m[norm("Combi Oven")] = "Oven";
  return m;
})();

export function tokenToStation(raw: string): Station | null {
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return STATION_ALIAS[key] ?? null;
}

export function getBaseVerdenVolume(wr: WeekRecipe): number {
  return wr.verdenVolume.BENL + wr.verdenVolume.DKSE + wr.verdenVolume.DE;
}

function recipeDigitKey(code: string): string {
  const match = /(\d{4,5})/.exec(String(code ?? ""));
  return match ? match[1] : String(code ?? "");
}

function resolveRecipeByCode(data: DataBundle, code: string): Recipe | undefined {
  const exact = data.recipes[code];
  if (exact) return exact;
  const wanted = recipeDigitKey(code);
  return Object.values(data.recipes).find((recipe) => recipeDigitKey(recipe.code) === wanted);
}

export interface SubRecipeMassProfile {
  outputGramsPerPortion: number;
  grossInputGramsPerPortion: number;
  planningGramsPerPortion: number;
  yieldRatio?: number;
  lossPercent?: number;
}

export function getSubRecipeMassProfile(sub: SubRecipe, recipe: Recipe): SubRecipeMassProfile {
  const outputGramsPerPortion =
    sub.yield && sub.yieldUom && /^(g|gram)/i.test(sub.yieldUom) ? sub.yield : 0;

  const subNameLc = sub.name.trim().toLowerCase();
  let grossInputGramsPerPortion = 0;
  for (const m of MARKETS) {
    const list = recipe.grossIngredients[m];
    if (!list || list.length === 0) continue;
    let sum = 0;
    for (const g of list) {
      const subMatch = [g.subRecipe1, g.subRecipe2, g.subRecipe3]
        .some(n => (n ?? "").trim().toLowerCase() === subNameLc);
      if (!subMatch) continue;
      if (!/^g(rams)?$/i.test(g.uom)) continue;
      sum += g.grossQuantityPerPortion;
    }
    if (sum > 0) {
      grossInputGramsPerPortion = sum;
      break;
    }
  }

  const planningGramsPerPortion = grossInputGramsPerPortion || outputGramsPerPortion;
  const yieldRatio = outputGramsPerPortion > 0 && grossInputGramsPerPortion > 0
    ? Math.min(1, outputGramsPerPortion / grossInputGramsPerPortion)
    : undefined;
  const lossPercent = yieldRatio !== undefined ? Math.max(0, (1 - yieldRatio) * 100) : undefined;

  return {
    outputGramsPerPortion,
    grossInputGramsPerPortion,
    planningGramsPerPortion,
    yieldRatio,
    lossPercent
  };
}

/** g/Portion für ein bestimmtes Sub-Rezept eines Recipes. */
export function gramsPerPortionFor(sub: SubRecipe, recipe: Recipe): number {
  return getSubRecipeMassProfile(sub, recipe).planningGramsPerPortion;
}

export interface SubRecipeLoad {
  subRecipeId: string;
  subRecipeName: string;
  category: string;
  spec?: ProcessSpec;
  gramsPerPortion: number;
  outputGramsPerPortion: number;
  grossInputGramsPerPortion: number;
  totalKg: number;
  batches: number;
  yieldRatio?: number;
  lossPercent?: number;
  minutesPerStation: Partial<Record<Station, number>>;
  holdTimePerStation: Partial<Record<Station, number>>;
  totalActiveMin: number;
}

export interface RecipeLoad {
  weekRecipe: WeekRecipe;
  subs: SubRecipeLoad[];
  perStationMin: Partial<Record<Station, number>>;
  totalActiveMin: number;
}

export interface WeekLoad {
  week: string;
  recipes: RecipeLoad[];
  perStationMin: Record<Station, number>;
  perStationDriversTop3: Record<Station, { code: string; sub: string; minutes: number }[]>;
  totalActiveMin: number;
}

export interface StationCapacityView {
  totalMin: number;
  deviceCount: number;
  shiftMin: number;
  runtimePerDeviceMin: number;
  utilizationPct: number;
  requiredDevices: number;
  freeDeviceBuffer: number;
}

export function getStationCapacityView(totalMin: number, deviceCount: number, shiftMin = DEFAULT_SHIFT_MIN): StationCapacityView {
  const safeDevices = Math.max(1, Math.floor(deviceCount) || 1);
  const safeShiftMin = Math.max(1, Math.floor(shiftMin) || DEFAULT_SHIFT_MIN);
  const runtimePerDeviceMin = totalMin / safeDevices;
  const utilizationPct = (totalMin / (safeDevices * safeShiftMin)) * 100;
  const requiredDevices = totalMin > 0 ? Math.ceil(totalMin / safeShiftMin) : 0;
  return {
    totalMin,
    deviceCount: safeDevices,
    shiftMin: safeShiftMin,
    runtimePerDeviceMin,
    utilizationPct,
    requiredDevices,
    freeDeviceBuffer: Math.max(0, safeDevices - requiredDevices)
  };
}

export function computeWeekLoad(data: DataBundle, week: string, options?: { portionMultiplier?: number }): WeekLoad {
  const wrs = data.weekRecipes.filter(r => {
    if (r.hfWeek !== week) return false;
    const code = (r.code ?? "").toUpperCase();
    if (!(code.startsWith("FE") || code.startsWith("FV"))) return false;
    return (r.verdenVolume.BENL + r.verdenVolume.DKSE + r.verdenVolume.DE) > 0;
  });
  const recipeLoads: RecipeLoad[] = [];
  const portionMultiplier = options?.portionMultiplier ?? 1;

  for (const wr of wrs) {
    const recipe = resolveRecipeByCode(data, wr.code);
    if (!recipe) {
      // Kein Recipe-Eintrag vorhanden → trotzdem im Kalender zeigen (0 Stationslast)
      recipeLoads.push({ weekRecipe: wr, subs: [], perStationMin: {}, totalActiveMin: 0 });
      continue;
    }
    // Sub-Rezepte über alle Märkte deduplizieren (selber id)
    const seen = new Map<string, SubRecipe>();
    for (const m of MARKETS) {
      const md = recipe.markets[m];
      if (!md) continue;
      for (const s of md.subRecipes) if (!seen.has(s.id)) seen.set(s.id, s);
    }
    const portions = getBaseVerdenVolume(wr) * portionMultiplier;
    const subLoads: SubRecipeLoad[] = [];
    const perStation: Partial<Record<Station, number>> = {};
    let recipeTotal = 0;

    for (const sub of seen.values()) {
      const spec = data.processSpecs?.[sub.id];
      const mass = getSubRecipeMassProfile(sub, recipe);
      const gpp = mass.planningGramsPerPortion;
      const totalKg = (portions * gpp) / 1000;
      const batchSize = spec?.batchSizeKg && spec.batchSizeKg > 0 ? spec.batchSizeKg : 0;
      const batches = batchSize > 0 ? Math.max(1, Math.ceil(totalKg / batchSize)) : (totalKg > 0 ? 1 : 0);

      const minutesPerStation: Partial<Record<Station, number>> = {};
      const holdTimePerStation: Partial<Record<Station, number>> = {};
      let activeSum = 0;
      if (spec) {
        for (const s of STATIONS) {
          const mpb = spec.minutesPerBatch[s];
          if (mpb && batches > 0) {
            const t = mpb * batches;
            minutesPerStation[s] = t;
            perStation[s] = (perStation[s] ?? 0) + t;
            activeSum += t;
          }
          const hold = spec.holdTimeMin[s];
          if (hold && batches > 0) holdTimePerStation[s] = hold;
        }
      }
      subLoads.push({
        subRecipeId: sub.id, subRecipeName: sub.name, category: sub.category,
        spec,
        gramsPerPortion: gpp,
        outputGramsPerPortion: mass.outputGramsPerPortion,
        grossInputGramsPerPortion: mass.grossInputGramsPerPortion,
        totalKg,
        batches,
        yieldRatio: mass.yieldRatio,
        lossPercent: mass.lossPercent,
        minutesPerStation, holdTimePerStation, totalActiveMin: activeSum
      });
      recipeTotal += activeSum;
    }
    recipeLoads.push({ weekRecipe: wr, subs: subLoads, perStationMin: perStation, totalActiveMin: recipeTotal });
  }

  // Aggregat
  const perStationMin = Object.fromEntries(STATIONS.map(s => [s, 0])) as Record<Station, number>;
  const driversAcc: Record<Station, { code: string; sub: string; minutes: number }[]> =
    Object.fromEntries(STATIONS.map(s => [s, []])) as any;
  let total = 0;
  for (const rl of recipeLoads) {
    total += rl.totalActiveMin;
    for (const s of STATIONS) {
      const v = rl.perStationMin[s] ?? 0;
      if (v > 0) {
        perStationMin[s] += v;
        // Treiber sammeln (pro Sub-Rezept)
        for (const sl of rl.subs) {
          const m = sl.minutesPerStation[s] ?? 0;
          if (m > 0) driversAcc[s].push({ code: rl.weekRecipe.code, sub: sl.subRecipeName, minutes: m });
        }
      }
    }
  }
  const perStationDriversTop3 = Object.fromEntries(
    STATIONS.map(s => [s, driversAcc[s].sort((a, b) => b.minutes - a.minutes).slice(0, 3)])
  ) as Record<Station, { code: string; sub: string; minutes: number }[]>;

  return { week, recipes: recipeLoads, perStationMin, perStationDriversTop3, totalActiveMin: total };
}

/** Workflow-Schritte aus SubRecipe.category — als geordnete Liste mit Minuten-Hint. */
export interface WorkflowStep {
  index: number;
  rawLabel: string;
  station: Station | null;
  minutesPerBatch?: number;
  holdMin?: number;
}
export function workflowSteps(sub: SubRecipe, spec?: ProcessSpec): WorkflowStep[] {
  if (!sub.category) return [];
  const tokens = sub.category.split(/[\/>→»·]+/).map(t => t.trim()).filter(Boolean);
  return tokens.map((raw, i) => {
    const station = tokenToStation(raw);
    return {
      index: i + 1,
      rawLabel: raw,
      station,
      minutesPerBatch: station ? spec?.minutesPerBatch[station] : undefined,
      holdMin: station ? spec?.holdTimeMin[station] : undefined
    };
  });
}

export function fmtMin(min: number): string {
  if (!min || min <= 0) return "—";
  if (min >= 60) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(min)}m`;
}
