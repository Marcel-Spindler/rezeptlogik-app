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

// Verden produziert Mo–Fr (KITCHEN_OPEN_DAYS in planner.ts). Der Wochen-Kapazitäts-
// Warner (CapacityWarningBanner) vergleicht die STATIONS-Last einer ganzen Woche
// gegen dieses Fenster je Gerät — nicht mehr gegen eine einzelne 8-h-Schicht.
export const WEEK_PRODUCTION_DAYS = 5;
export const KITCHEN_SHIFTS_PER_DAY = 2;        // Küche: zweischichtig
export const BLAST_CHILLER_SHIFTS_PER_DAY = 3;  // Blast Chiller läuft durch (24 h)
export const WEEKLY_MINUTES_PER_DEVICE = WEEK_PRODUCTION_DAYS * KITCHEN_SHIFTS_PER_DAY * DEFAULT_SHIFT_MIN;               // 4 800
export const BLAST_CHILLER_WEEKLY_MINUTES_PER_DEVICE = WEEK_PRODUCTION_DAYS * BLAST_CHILLER_SHIFTS_PER_DAY * DEFAULT_SHIFT_MIN; // 7 200

// Blast Chiller wird über Rack-Durchsatz modelliert, NICHT über "Minuten je Koch-
// Batch" — ein Chiller-Zyklus kühlt ein ganzes Rack (mehrere hundert kg,
// allergenrein sortiert), nicht einen einzelnen 40–50-kg-Kochbatch.
export const BLAST_CHILLER_RACK_KG = 200;
export const BLAST_CHILLER_CYCLE_MIN = 90;

// Thaw = Kühlraum-Kapazität (kg, die gleichzeitig auftauen können) — reines
// kg-Modell, keine Geräte-Minuten.
export const THAW_ROOM_CAPACITY_KG = 8000;

export const DEFAULT_STATION_DEVICE_COUNTS: Record<Station, number> = {
  // Reale Geräteanzahl Verden (Marcel, 2026-08-28). Braiser/Blast Chiller etc.
  // decken sich mit dem KET-Modell (DEFAULT_STATION_COUNT in ketEquipmentSummary.ts).
  "Staging": 3,
  "Spice Portioning": 3,
  "Debox": 1,
  "Thaw": 1,
  "Brine": 20,
  "Marinade": 20,
  "Hand Marinade": 20,     // gemeinsamer Pool mit Marinade
  "Immersion Blender": 3,   // Stabmixer (= Hand Mix, gemeinsamer Pool)
  "Planetary Mixer": 3,
  "Horizontal Mixer": 1,
  "Patty Maker": 1,
  "Braiser": 6,
  "Grill": 3,
  "Crusted": 1,
  "Oven": 10,
  "Drain": 1,
  "Hand Mix": 3,            // = Hand Mixer, gleiche Anzahl wie Stabmixer
  "Cold Shredder": 1,
  "Hot Shredder": 1,
  "Scooper": 20,
  "Butter Machine": 20,
  "Slicer": 1,
  "Cupping": 1,
  "Blast Chiller": 6
};

// Stationen, die im Wochen-Kapazitäts-Warner NICHT als Engpass geführt werden
// (kein Gerät im engeren Sinn / nie limitierend).
export const CAPACITY_WARN_EXCLUDE: ReadonlySet<Station> = new Set<Station>(["Scooper"]);

// Stationen, die in Verden dasselbe Gerät / denselben Pool sind und im
// Wochen-Kapazitäts-Warner als EIN Eintrag geführt werden (Last summiert,
// gemeinsame Geräteanzahl). Marcel, 2026-08-28.
export const CAPACITY_STATION_GROUPS: ReadonlyArray<{ label: string; devices: number; members: Station[] }> = [
  { label: "Marinade", devices: 20, members: ["Marinade", "Hand Marinade"] },
  { label: "Stabmixer / Hand Mix", devices: 3, members: ["Immersion Blender", "Hand Mix"] },
  { label: "Shredder", devices: 2, members: ["Hot Shredder", "Cold Shredder"] },
];
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

// ── Wochen-Kapazitäts-Auslastung je Station ────────────────────────────────
// Für den CapacityWarningBanner: nimmt die Stations-Last EINER WOCHE und stellt
// sie dem realen Wochen-Fenster je Gerät gegenüber (WEEKLY_MINUTES_PER_DEVICE).
// Zwei Stationen laufen NICHT über das Minuten-Modell:
//   • Blast Chiller → Rack-Durchsatz (ceil(kg/Rack) × Zyklus, 24-h-Fenster)
//   • Thaw          → Kühlraum-kg (gleichzeitige Belegung)

export type StationCapacityModel = "minutes" | "chiller-racks" | "thaw-room";

export interface WeeklyStationLoad {
  /** Stabiler Schlüssel (Station-Name oder Gruppen-Label) für React/Dedup. */
  key: string;
  /** Anzeige-Label (Gruppen-Label bzw. Station-Name). */
  label: string;
  model: StationCapacityModel;
  deviceCount: number;
  utilizationPct: number;
  /** Zusätzlich benötigte Geräte/Plätze, damit ≤ 100 % (0 = passt). */
  extraDevicesNeeded: number;
  /** Menschenlesbare Rechenbasis, z. B. "462 Racks à 200 kg · 90 min · 6 Chiller · 24 h". */
  basis: string;
}

export function computeWeeklyStationLoads(
  weekLoad: WeekLoad,
  deviceCounts: Partial<Record<Station, number>> = DEFAULT_STATION_DEVICE_COUNTS,
): WeeklyStationLoad[] {
  const devOf = (s: Station) => Math.max(1, Math.floor(deviceCounts[s] ?? DEFAULT_STATION_DEVICE_COUNTS[s] ?? 1));

  // kg-Summen für die Sondermodelle aus den Sub-Rezept-Lasten ziehen.
  let chillerRackCount = 0;
  let thawKg = 0;
  for (const rl of weekLoad.recipes) {
    for (const sl of rl.subs) {
      if (sl.minutesPerStation["Blast Chiller"] && sl.totalKg > 0) {
        chillerRackCount += Math.ceil(sl.totalKg / BLAST_CHILLER_RACK_KG);
      }
      if (sl.minutesPerStation["Thaw"] && sl.totalKg > 0) {
        thawKg += sl.totalKg;
      }
    }
  }

  const minutesEntry = (key: string, label: string, totalMin: number, devices: number): WeeklyStationLoad => {
    const utilizationPct = (totalMin / (devices * WEEKLY_MINUTES_PER_DEVICE)) * 100;
    return {
      key, label, model: "minutes", deviceCount: devices, utilizationPct,
      extraDevicesNeeded: Math.max(0, Math.ceil(totalMin / WEEKLY_MINUTES_PER_DEVICE) - devices),
      basis: `${Math.round(totalMin / 60).toLocaleString("de-DE")} h auf ${devices} Gerät${devices > 1 ? "e" : ""} · ${WEEK_PRODUCTION_DAYS} Tage × ${KITCHEN_SHIFTS_PER_DAY} Schichten`,
    };
  };

  const groupOf = new Map<Station, typeof CAPACITY_STATION_GROUPS[number]>();
  for (const g of CAPACITY_STATION_GROUPS) for (const m of g.members) groupOf.set(m, g);

  const out: WeeklyStationLoad[] = [];
  const emittedGroups = new Set<string>();

  for (const station of STATIONS) {
    if (CAPACITY_WARN_EXCLUDE.has(station)) continue;

    if (station === "Blast Chiller") {
      if (chillerRackCount === 0) continue;
      const devices = devOf(station);
      const neededMin = chillerRackCount * BLAST_CHILLER_CYCLE_MIN;
      out.push({
        key: station, label: station, model: "chiller-racks", deviceCount: devices,
        utilizationPct: (neededMin / (devices * BLAST_CHILLER_WEEKLY_MINUTES_PER_DEVICE)) * 100,
        extraDevicesNeeded: Math.max(0, Math.ceil(neededMin / BLAST_CHILLER_WEEKLY_MINUTES_PER_DEVICE) - devices),
        basis: `${chillerRackCount} Racks à ${BLAST_CHILLER_RACK_KG} kg · ${BLAST_CHILLER_CYCLE_MIN} min/Zyklus · ${devices} Chiller · 24 h`,
      });
      continue;
    }

    if (station === "Thaw") {
      if (thawKg === 0) continue;
      out.push({
        key: station, label: station, model: "thaw-room", deviceCount: 1,
        utilizationPct: (thawKg / THAW_ROOM_CAPACITY_KG) * 100,
        extraDevicesNeeded: 0,
        basis: `${Math.round(thawKg).toLocaleString("de-DE")} kg / ${THAW_ROOM_CAPACITY_KG.toLocaleString("de-DE")} kg Kühlraum`,
      });
      continue;
    }

    const group = groupOf.get(station);
    if (group) {
      if (emittedGroups.has(group.label)) continue;
      emittedGroups.add(group.label);
      const totalMin = group.members.reduce((s, m) => s + (weekLoad.perStationMin[m] ?? 0), 0);
      if (totalMin <= 0) continue;
      out.push(minutesEntry(group.label, group.label, totalMin, group.devices));
      continue;
    }

    const totalMin = weekLoad.perStationMin[station] ?? 0;
    if (totalMin <= 0) continue;
    out.push(minutesEntry(station, station, totalMin, devOf(station)));
  }

  return out.sort((a, b) => b.utilizationPct - a.utilizationPct);
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
