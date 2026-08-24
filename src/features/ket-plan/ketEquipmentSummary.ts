// Vollständige Stations-Ressourcen-Aggregation über alle WOs einer Woche.
// Reiner Helper ohne UI/React-Abhängigkeit — gruppiert nach Station (PROCESS_ORDER),
// aufgeteilt in Run 1 (70%) / Run 2 (30%), berechnet:
//   • Batches & geschätzte Dauer (parallelisiert nach stationCount)
//   • GN-Bleche (Trays) pro Station inkl. Debox-Vorlauf
//   • Wannen (zutatbasiert aus CapacityDB, nicht pauschal)
//   • Ofen-Ladungen (Racks)
//   • Scoops (welche + wie viele)
//   • Allergene an der Station (HACCP)
//   • Blast-Chiller-Slots (Auslastung je Chiller 1-6)
//   • Gantt-Timeline (frühester/spätester Start je Station)
// Kein Essen/Zutaten in der Ausgabe — nur Equipment, Mengen, Zeiten.

import type { BatchCalc, EquipBatch, GnTraySummary, IngCalc, KetRow, ScoopInfo } from "./ketTypes";
import { EQUIP_LABELS } from "./ketTypes";
import { parseDateShift } from "./ketLogic";
import { shiftLabel, type RunInfo } from "./ketRunLogic";
import { processOrder } from "./woInstructionBot";
import { CHILLER_CFG, CHILLER_KEYS, type ChillerKey } from "../blast-chiller/blastChillerLogic";
import { lookupEquipmentCapacity } from "../kitchen-mode/wrEquipmentCapacityDB";

// ── Konstanten ─────────────────────────────────────────────────────────────

const PROCESS_ORDER_CACHE = processOrder();

export const DEFAULT_MINUTES_PER_BATCH: Record<string, number> = {
  "SPICE PORTIONING": 5,
  "VEGGIE DEBOX": 10,
  "PROTEIN DEBOX": 15,
  MARINADE: 20,
  "HAND MARINADE": 15,
  BRAISER: 45,
  "HORIZONTAL MIXER": 20,
  "PLANETARY MIXER": 15,
  "PATTY MAKER": 10,
  GRILL: 20,
  OVEN: 35,
  "IMMERSION BLENDER": 5,
  "HAND MIX": 5,
  "HOT SHREDDER": 15,
  CUPPING: 10,
  BRINE: 60,
  "BLAST CHILLER": 90,
};

// Standardmäßige Geräte-Anzahl je Station (1 = ein Gerät, 2 = parallel nutzbar etc.)
export const DEFAULT_STATION_COUNT: Record<string, number> = {
  BRAISER: 3,
  OVEN: 2,
  "PLANETARY MIXER": 1,
  "HORIZONTAL MIXER": 1,
  "PATTY MAKER": 1,
  "HOT SHREDDER": 1,
  "BLAST CHILLER": 6,
  GRILL: 1,
};

export const SHIFT_HOURS = 8;
const DEFAULT_OVEN_RACK_CAPACITY = 40;
const DEFAULT_WANNE_KG_FALLBACK = 80;
export const DEFAULT_TRAYS_PER_RACK = 12;

const STATION_LABELS: Record<string, string> = {
  ...EQUIP_LABELS,
  "SPICE PORTIONING": "Spice Room",
  "VEGGIE DEBOX": "Veggie Debox",
  "PROTEIN DEBOX": "Protein Debox",
  MARINADE: "Marinade",
  "HAND MARINADE": "Hand Marinade",
  GRILL: "Grill",
  "IMMERSION BLENDER": "Stabmixer",
  "HAND MIX": "Hand Mix",
  "BLAST CHILLER": "Blast Chiller",
  DRAIN: "Drain",
};

// ── Typen ──────────────────────────────────────────────────────────────────

export interface ScoopEntry {
  methodType: string;
  methodColor: string;
  yieldGrams: number | null;
  count: number;
}

export interface GnTrayDemand {
  gnType: string;
  count: number;
}

export interface StationDemand {
  station: string;
  label: string;
  totalBatches: number;
  totalKg: number;
  estimatedMinutes: number;
  effectiveMinutes: number;
  deviceCount: number;
  gnTrays: GnTrayDemand[];
  wannen: number;
  racksNeeded: number;
  ovenLoads: number | null;
  scoopsNeeded: ScoopEntry[];
  allergensPresent: string[];
  woNumbers: string[];
  ganttStartMin: number;
  ganttEndMin: number;
  staffNeeded: number;
}

export interface ChillerSlotDemand {
  key: ChillerKey;
  label: string;
  sub: string;
  woCount: number;
  woNumbers: string[];
}

export interface RunDemand {
  run: 1 | 2;
  runSharePct: number;
  date: string;
  shift: string;
  shiftLabel: string;
  stations: StationDemand[];
  chillerSlots: ChillerSlotDemand[];
  totalKg: number;
  totalWos: number;
  totalGnTrays: number;
  totalWannen: number;
  totalRacksNeeded: number;
  criticalPathMinutes: number;
  totalStaffNeeded: number;
}

export interface StationPeakInfo {
  station: string;
  label: string;
  peakBatches: number;
  peakKg: number;
  peakDate: string;
  avgBatchesPerDay: number;
}

export interface BottleneckWarning {
  date: string;
  shift: string;
  run: 1 | 2;
  station: string;
  label: string;
  totalBatches: number;
  estimatedHours: number;
  effectiveHours: number;
  deviceCount: number;
  shiftHoursAvailable: number;
  reason: string;
}

export interface FullResourceSummary {
  byRunDayShift: RunDemand[];
  stationPeaks: StationPeakInfo[];
  bottlenecks: BottleneckWarning[];
  scoopInventory: ScoopEntry[];
  allergenStationMap: { station: string; label: string; allergens: string[] }[];
  chillerWeekSummary: ChillerSlotDemand[];
  totalKgWeek: number;
  totalGnTraysWeek: number;
  totalWannenWeek: number;
  totalRacksNeededWeek: number;
  criticalPathPeakMinutes: number;
  peakStaffNeeded: number;
}

// Compat-Typen (alte API)
export interface EquipSlot { equip: string; label: string; totalBatches: number; totalKg: number; peakCapacityKg: number; estimatedMinutes: number; woNumbers: string[]; }
export interface DayShiftEquipDemand { date: string; shift: string; shiftLabel: string; equipment: EquipSlot[]; totalKg: number; woCount: number; }
export interface EquipPeakInfo { equip: string; label: string; peakBatches: number; peakDate: string; avgBatchesPerDay: number; }
export interface EquipmentDemandSummary { byDayShift: DayShiftEquipDemand[]; weekPeaks: EquipPeakInfo[]; bottlenecks: BottleneckWarning[]; }

// ── Optionen ───────────────────────────────────────────────────────────────

export interface ResourceDemandOptions {
  minutesPerBatch?: Record<string, number>;
  ovenRackCapacity?: number;
  stationCount?: Record<string, number>;
  firstRunPct?: number;
  minutesPerStaffShift?: number;
  traysPerRack?: number;
}

// ── Interne Helfer ─────────────────────────────────────────────────────────

function getStationLabel(station: string): string {
  return STATION_LABELS[station] ?? station;
}

function getStationOrder(station: string): number {
  const idx = PROCESS_ORDER_CACHE.indexOf(station);
  return idx >= 0 ? idx : PROCESS_ORDER_CACHE.length;
}

function makeScoopKey(s: ScoopInfo): string {
  return `${s.methodType ?? "UNKNOWN"}||${s.methodColor ?? ""}||${s.yieldGrams != null ? s.yieldGrams : "x"}`;
}

function mergeGnTrays(summaries: GnTraySummary[]): GnTrayDemand[] {
  if (summaries.length === 0) return [];
  const map = new Map<string, number>();
  for (const s of summaries) {
    if (s.trays > 0) map.set(s.gnType, (map.get(s.gnType) ?? 0) + s.trays);
  }
  return [...map.entries()]
    .map(([gnType, count]) => ({ gnType, count }))
    .sort((a, b) => a.gnType.localeCompare(b.gnType));
}

// Berechnet Wannen aus den einzelnen Zutaten (pro Zutat die CapacityDB fragen).
// Fallback auf pauschal wenn keine Zutat einen DB-Treffer hat.
function computeWannenFromIngredients(ingredients: IngCalc[], totalKg: number): number {
  if (totalKg <= 0) return 0;
  let wannenSum = 0;
  let coveredKg = 0;
  for (const ing of ingredients) {
    if (ing.totalKg <= 0) continue;
    const cap = lookupEquipmentCapacity(ing.name);
    if (cap?.wanneKg && cap.wanneKg > 0) {
      wannenSum += Math.ceil(ing.totalKg / cap.wanneKg);
      coveredKg += ing.totalKg;
    }
  }
  // Für den nicht-abgedeckten Rest: Fallback 80kg/Wanne
  const uncoveredKg = totalKg - coveredKg;
  if (uncoveredKg > 0) {
    wannenSum += Math.ceil(uncoveredKg / DEFAULT_WANNE_KG_FALLBACK);
  }
  return wannenSum;
}

// Debox-Stationen brauchen GN-Trays VOR dem Kochen — aus den Zutaten der WO
// kann man ableiten welche Trays in der Debox gebraucht werden (Protein/Veggie
// Debox = Auftauen/Portionieren auf GN-Bleche bevor es in den Braiser/Oven geht).
function computeDeboxTrays(ingredients: IngCalc[], station: string): GnTrayDemand[] {
  if (station !== "VEGGIE DEBOX" && station !== "PROTEIN DEBOX") return [];
  const map = new Map<string, number>();
  for (const ing of ingredients) {
    if (ing.gnTrays && ing.gnTrays > 0 && ing.gnType) {
      map.set(ing.gnType, (map.get(ing.gnType) ?? 0) + ing.gnTrays);
    }
  }
  return [...map.entries()]
    .map(([gnType, count]) => ({ gnType, count }))
    .sort((a, b) => a.gnType.localeCompare(b.gnType));
}

interface StationAccumulator {
  batches: number;
  kg: number;
  minutes: number;
  gnTrays: GnTraySummary[];
  deboxTrays: GnTrayDemand[];
  scoops: Map<string, ScoopEntry>;
  allergens: Set<string>;
  woNumbers: Set<string>;
  ingredients: IngCalc[];
}

function createStationAcc(): StationAccumulator {
  return { batches: 0, kg: 0, minutes: 0, gnTrays: [], deboxTrays: [], scoops: new Map(), allergens: new Set(), woNumbers: new Set(), ingredients: [] };
}

function accumulateBlock(
  stationMap: Map<string, StationAccumulator>,
  woNumber: string,
  equipBatches: EquipBatch[],
  gnTraySummary: GnTraySummary[],
  scoopInfo: ScoopInfo | null,
  primaryEquip: string | null,
  resolvedCookMethods: string[],
  minutesPerBatch: Record<string, number>,
  ingredients: IngCalc[],
): void {
  const ensure = (station: string) => {
    if (!stationMap.has(station)) stationMap.set(station, createStationAcc());
    return stationMap.get(station)!;
  };

  for (const eb of equipBatches) {
    if (eb.batches <= 0) continue;
    const agg = ensure(eb.equip);
    agg.batches += eb.batches;
    agg.kg += eb.batches * eb.perBatchKg;
    agg.minutes += eb.batches * (minutesPerBatch[eb.equip] ?? 30);
    agg.woNumbers.add(woNumber);
  }

  if (gnTraySummary.length > 0 && primaryEquip) {
    ensure(primaryEquip).gnTrays.push(...gnTraySummary);
  }

  if (scoopInfo?.methodType) {
    const key = makeScoopKey(scoopInfo);
    const station = primaryEquip ?? resolvedCookMethods[0] ?? "UNKNOWN";
    const agg = ensure(station);
    const existing = agg.scoops.get(key);
    if (existing) { existing.count++; }
    else {
      agg.scoops.set(key, {
        methodType: scoopInfo.methodType,
        methodColor: scoopInfo.methodColor ?? "",
        yieldGrams: scoopInfo.yieldGrams ?? null,
        count: 1,
      });
    }
  }

  // Zutaten für Wannen-Berechnung + Debox-Tray-Ableitung sammeln (nur intern,
  // NICHT in der Ausgabe — kein Essen listen).
  if (ingredients.length > 0) {
    const station = primaryEquip ?? resolvedCookMethods[0];
    if (station) ensure(station).ingredients.push(...ingredients);
    // Debox-Stationen: Zutaten dort zuordnen
    for (const method of resolvedCookMethods) {
      if (method === "VEGGIE DEBOX" || method === "PROTEIN DEBOX") {
        const deboxAgg = ensure(method);
        const deboxTrays = computeDeboxTrays(ingredients, method);
        if (deboxTrays.length > 0) deboxAgg.deboxTrays.push(...deboxTrays.map(t => ({ gnType: t.gnType, count: t.count })));
      }
    }
  }
}

// ── Haupt-Funktion ─────────────────────────────────────────────────────────

export function computeFullResourceDemand(
  rows: KetRow[],
  batchCalcs: Map<string, BatchCalc>,
  runAssignments: Map<string, RunInfo>,
  opts?: ResourceDemandOptions,
): FullResourceSummary {
  const minutesPerBatch = opts?.minutesPerBatch ?? DEFAULT_MINUTES_PER_BATCH;
  const ovenRackCap = opts?.ovenRackCapacity ?? DEFAULT_OVEN_RACK_CAPACITY;
  const stationCount = opts?.stationCount ?? DEFAULT_STATION_COUNT;
  const firstRunPct = opts?.firstRunPct ?? 70;
  const staffShiftMin = opts?.minutesPerStaffShift ?? (SHIFT_HOURS * 60);
  const traysPerRack = opts?.traysPerRack ?? DEFAULT_TRAYS_PER_RACK;

  // 1) Gruppierung: (date, shift, run)
  const groups = new Map<string, { date: string; shift: string; run: 1 | 2; rows: KetRow[] }>();
  for (const row of rows) {
    const { date, shift } = parseDateShift(row.dateNeeded);
    const run: 1 | 2 = runAssignments.get(row.key)?.run ?? 1;
    const key = `${date}||${shift}||${run}`;
    if (!groups.has(key)) groups.set(key, { date, shift, run, rows: [] });
    groups.get(key)!.rows.push(row);
  }

  // 2) Pro Gruppe: Station-Aggregation
  const byRunDayShift: RunDemand[] = [];
  const globalScoops = new Map<string, ScoopEntry>();
  const globalAllergensByStation = new Map<string, Set<string>>();
  const globalChillerSlots = new Map<ChillerKey, Set<string>>();

  for (const { date, shift, run, rows: groupRows } of groups.values()) {
    const stationMap = new Map<string, StationAccumulator>();
    const ensure = (station: string) => {
      if (!stationMap.has(station)) stationMap.set(station, createStationAcc());
      return stationMap.get(station)!;
    };

    const localChillerSlots = new Map<ChillerKey, Set<string>>();

    for (const row of groupRows) {
      const calc = batchCalcs.get(row.key);
      if (!calc) continue;

      if (calc.components.length > 0) {
        for (const comp of calc.components) {
          accumulateBlock(stationMap, row.woNumber, comp.equipBatches, comp.gnTraySummary, comp.scoopInfo, comp.primaryEquip, comp.resolvedCookMethods, minutesPerBatch, comp.ingredients);
        }
      } else {
        accumulateBlock(stationMap, row.woNumber, calc.equipBatches, calc.gnTraySummary, calc.scoopInfo, calc.primaryEquip, calc.resolvedCookMethods, minutesPerBatch, calc.ingredients);
      }

      // Allergene → alle Stationen
      if (calc.allergensContains.length > 0) {
        const stations = calc.components.length > 0
          ? [...new Set(calc.components.flatMap(c => c.resolvedCookMethods))]
          : calc.resolvedCookMethods;
        for (const station of stations) {
          const agg = ensure(station);
          for (const a of calc.allergensContains) agg.allergens.add(a);
        }
      }

      // Blast-Chiller-Slot
      if (calc.chillerAssignment) {
        const ck = calc.chillerAssignment.key;
        if (!localChillerSlots.has(ck)) localChillerSlots.set(ck, new Set());
        localChillerSlots.get(ck)!.add(row.woNumber);
        if (!globalChillerSlots.has(ck)) globalChillerSlots.set(ck, new Set());
        globalChillerSlots.get(ck)!.add(row.woNumber);
      }
    }

    // 3) Station-Akkumulatoren → StationDemand[]
    const stations: StationDemand[] = [...stationMap.entries()]
      .map(([station, agg]) => {
        // GN-Trays: Equipment-basiert + Debox-basiert zusammen
        const equipGnTrays = mergeGnTrays(agg.gnTrays);
        const deboxGnMap = new Map<string, number>();
        for (const dt of agg.deboxTrays) deboxGnMap.set(dt.gnType, (deboxGnMap.get(dt.gnType) ?? 0) + dt.count);
        const deboxGnTrays: GnTrayDemand[] = [...deboxGnMap.entries()].map(([gnType, count]) => ({ gnType, count }));
        // Merge: nimm die höhere Zahl (nicht addieren — Debox-Trays sind dieselben
        // physischen Bleche die danach im Ofen landen, nicht zusätzliche).
        const allGnTypes = new Set([...equipGnTrays.map(t => t.gnType), ...deboxGnTrays.map(t => t.gnType)]);
        const gnTrays: GnTrayDemand[] = [...allGnTypes]
          .map(gnType => {
            const fromEquip = equipGnTrays.find(t => t.gnType === gnType)?.count ?? 0;
            const fromDebox = deboxGnTrays.find(t => t.gnType === gnType)?.count ?? 0;
            return { gnType, count: Math.max(fromEquip, fromDebox) };
          })
          .filter(t => t.count > 0)
          .sort((a, b) => a.gnType.localeCompare(b.gnType));

        const totalGnCount = gnTrays.reduce((s, t) => s + t.count, 0);

        // Wannen: zutatbasiert aus CapacityDB
        const wannen = computeWannenFromIngredients(agg.ingredients, agg.kg);

        const ovenLoads = station === "OVEN" && totalGnCount > 0
          ? Math.ceil(totalGnCount / ovenRackCap)
          : null;

        // Parallelisierung
        const devices = stationCount[station] ?? 1;
        const effectiveMin = devices > 1 ? Math.ceil(agg.minutes / devices) : agg.minutes;

        // Global-Scoop + Global-Allergen
        for (const [key, scoop] of agg.scoops) {
          const existing = globalScoops.get(key);
          if (existing) { existing.count += scoop.count; }
          else { globalScoops.set(key, { ...scoop }); }
        }
        if (agg.allergens.size > 0) {
          if (!globalAllergensByStation.has(station)) globalAllergensByStation.set(station, new Set());
          const globalSet = globalAllergensByStation.get(station)!;
          for (const a of agg.allergens) globalSet.add(a);
        }

        // Rack-Bedarf: Gesamte GN-Bleche ÷ Bleche pro Rack
        const racksNeeded = totalGnCount > 0 ? Math.ceil(totalGnCount / traysPerRack) : 0;

        return {
          station,
          label: getStationLabel(station),
          totalBatches: agg.batches,
          totalKg: +agg.kg.toFixed(2),
          estimatedMinutes: agg.minutes,
          effectiveMinutes: effectiveMin,
          deviceCount: devices,
          gnTrays,
          wannen,
          racksNeeded,
          ovenLoads,
          scoopsNeeded: [...agg.scoops.values()],
          allergensPresent: [...agg.allergens].sort(),
          woNumbers: [...agg.woNumbers].sort(),
          ganttStartMin: 0,
          ganttEndMin: 0,
          staffNeeded: staffShiftMin > 0 ? Math.ceil(effectiveMin / staffShiftMin) : 0,
        };
      })
      .sort((a, b) => getStationOrder(a.station) - getStationOrder(b.station));

    // 4) Gantt-Timeline: sequenziell nach PROCESS_ORDER
    let cumulativeMin = 0;
    for (const st of stations) {
      st.ganttStartMin = cumulativeMin;
      st.ganttEndMin = cumulativeMin + st.effectiveMinutes;
      cumulativeMin += st.effectiveMinutes;
    }
    const criticalPathMinutes = cumulativeMin;

    // Chiller-Slots für diese Gruppe
    const chillerSlots: ChillerSlotDemand[] = CHILLER_KEYS.map(ck => {
      const wos = localChillerSlots.get(ck);
      return {
        key: ck,
        label: CHILLER_CFG[ck].label,
        sub: CHILLER_CFG[ck].sub,
        woCount: wos?.size ?? 0,
        woNumbers: wos ? [...wos].sort() : [],
      };
    }).filter(s => s.woCount > 0);

    const totalKg = stations.reduce((s, st) => s + st.totalKg, 0);
    const totalGnTrays = stations.reduce((s, st) => s + st.gnTrays.reduce((ss, t) => ss + t.count, 0), 0);
    const totalWannen = stations.reduce((s, st) => s + st.wannen, 0);
    const totalRacksNeeded = totalGnTrays > 0 ? Math.ceil(totalGnTrays / traysPerRack) : 0;

    byRunDayShift.push({
      run,
      runSharePct: run === 1 ? firstRunPct : (100 - firstRunPct),
      date,
      shift,
      shiftLabel: shiftLabel(shift) ?? `Schicht ${shift}`,
      stations,
      chillerSlots,
      totalKg: +totalKg.toFixed(2),
      totalWos: groupRows.length,
      totalGnTrays,
      totalWannen,
      totalRacksNeeded,
      criticalPathMinutes,
      totalStaffNeeded: stations.reduce((s, st) => s + st.staffNeeded, 0),
    });
  }

  byRunDayShift.sort((a, b) =>
    a.run - b.run || a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift),
  );

  // 5) Engpass-Erkennung (effectiveMinutes = parallelisiert)
  const bottlenecks: BottleneckWarning[] = [];
  for (const rd of byRunDayShift) {
    for (const st of rd.stations) {
      const effectiveHours = st.effectiveMinutes / 60;
      if (effectiveHours > SHIFT_HOURS) {
        bottlenecks.push({
          date: rd.date,
          shift: rd.shift,
          run: rd.run,
          station: st.station,
          label: st.label,
          totalBatches: st.totalBatches,
          estimatedHours: +(st.estimatedMinutes / 60).toFixed(1),
          effectiveHours: +effectiveHours.toFixed(1),
          deviceCount: st.deviceCount,
          shiftHoursAvailable: SHIFT_HOURS,
          reason: `${st.label}: ${st.totalBatches} Bat ÷ ${st.deviceCount} Geräte ≈ ${effectiveHours.toFixed(1)}h — übersteigt ${SHIFT_HOURS}h`,
        });
      }
    }
  }

  // 6) Station-Peaks
  const peakMap = new Map<string, { batches: number; kg: number; date: string }[]>();
  for (const rd of byRunDayShift) {
    for (const st of rd.stations) {
      if (!peakMap.has(st.station)) peakMap.set(st.station, []);
      peakMap.get(st.station)!.push({ batches: st.totalBatches, kg: st.totalKg, date: rd.date });
    }
  }
  const stationPeaks: StationPeakInfo[] = [...peakMap.entries()]
    .map(([station, days]) => {
      const peak = days.reduce((best, d) => d.batches > best.batches ? d : best, days[0]);
      const avg = days.reduce((s, d) => s + d.batches, 0) / days.length;
      return { station, label: getStationLabel(station), peakBatches: peak.batches, peakKg: peak.kg, peakDate: peak.date, avgBatchesPerDay: +avg.toFixed(1) };
    })
    .sort((a, b) => getStationOrder(a.station) - getStationOrder(b.station));

  // 7) Globale Übersichten
  const scoopInventory = [...globalScoops.values()].sort((a, b) => b.count - a.count);
  const allergenStationMap = [...globalAllergensByStation.entries()]
    .map(([station, set]) => ({ station, label: getStationLabel(station), allergens: [...set].sort() }))
    .sort((a, b) => getStationOrder(a.station) - getStationOrder(b.station));

  const chillerWeekSummary: ChillerSlotDemand[] = CHILLER_KEYS.map(ck => {
    const wos = globalChillerSlots.get(ck);
    return { key: ck, label: CHILLER_CFG[ck].label, sub: CHILLER_CFG[ck].sub, woCount: wos?.size ?? 0, woNumbers: wos ? [...wos].sort() : [] };
  }).filter(s => s.woCount > 0);

  const totalKgWeek = byRunDayShift.reduce((s, rd) => s + rd.totalKg, 0);
  const totalGnTraysWeek = byRunDayShift.reduce((s, rd) => s + rd.totalGnTrays, 0);
  const totalWannenWeek = byRunDayShift.reduce((s, rd) => s + rd.totalWannen, 0);
  const totalRacksNeededWeek = totalGnTraysWeek > 0 ? Math.ceil(totalGnTraysWeek / traysPerRack) : 0;
  const criticalPathPeakMinutes = byRunDayShift.reduce((max, rd) => Math.max(max, rd.criticalPathMinutes), 0);

  return {
    byRunDayShift,
    stationPeaks,
    bottlenecks,
    scoopInventory,
    allergenStationMap,
    chillerWeekSummary,
    totalKgWeek: +totalKgWeek.toFixed(2),
    totalGnTraysWeek,
    totalWannenWeek,
    totalRacksNeededWeek,
    criticalPathPeakMinutes,
    peakStaffNeeded: byRunDayShift.reduce((max, rd) => Math.max(max, rd.totalStaffNeeded), 0),
  };
}

// ── Compat: computeEquipmentDemand ─────────────────────────────────────────

export function computeEquipmentDemand(
  rows: KetRow[],
  batchCalcs: Map<string, BatchCalc>,
  minutesPerBatch: Record<string, number> = DEFAULT_MINUTES_PER_BATCH,
): EquipmentDemandSummary {
  const full = computeFullResourceDemand(rows, batchCalcs, new Map(), { minutesPerBatch });

  const byDayShiftMap = new Map<string, DayShiftEquipDemand>();
  for (const rd of full.byRunDayShift) {
    const key = `${rd.date}||${rd.shift}`;
    if (!byDayShiftMap.has(key)) {
      byDayShiftMap.set(key, { date: rd.date, shift: rd.shift, shiftLabel: rd.shiftLabel, equipment: [], totalKg: 0, woCount: 0 });
    }
    const ds = byDayShiftMap.get(key)!;
    ds.woCount += rd.totalWos;
    ds.totalKg = +(ds.totalKg + rd.totalKg).toFixed(2);
    for (const st of rd.stations) {
      const existing = ds.equipment.find(e => e.equip === st.station);
      if (existing) {
        existing.totalBatches += st.totalBatches;
        existing.totalKg = +(existing.totalKg + st.totalKg).toFixed(2);
        existing.estimatedMinutes += st.estimatedMinutes;
        existing.peakCapacityKg = Math.max(existing.peakCapacityKg, st.totalKg);
        for (const wo of st.woNumbers) { if (!existing.woNumbers.includes(wo)) existing.woNumbers.push(wo); }
      } else {
        ds.equipment.push({ equip: st.station, label: st.label, totalBatches: st.totalBatches, totalKg: st.totalKg, peakCapacityKg: st.totalKg, estimatedMinutes: st.estimatedMinutes, woNumbers: [...st.woNumbers] });
      }
    }
  }

  const byDayShift = [...byDayShiftMap.values()]
    .map(ds => { ds.equipment.sort((a, b) => b.estimatedMinutes - a.estimatedMinutes); ds.equipment.forEach(e => e.woNumbers.sort()); return ds; })
    .sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift));

  const bottlenecks: BottleneckWarning[] = full.bottlenecks;

  const equipDays = new Map<string, { batches: number; date: string }[]>();
  for (const ds of byDayShift) {
    for (const slot of ds.equipment) {
      if (!equipDays.has(slot.equip)) equipDays.set(slot.equip, []);
      equipDays.get(slot.equip)!.push({ batches: slot.totalBatches, date: ds.date });
    }
  }
  const weekPeaks: EquipPeakInfo[] = [...equipDays.entries()]
    .map(([equip, days]) => {
      const peak = days.reduce((best, d) => d.batches > best.batches ? d : best, days[0]);
      const avg = days.reduce((s, d) => s + d.batches, 0) / days.length;
      return { equip, label: getStationLabel(equip), peakBatches: peak.batches, peakDate: peak.date, avgBatchesPerDay: +avg.toFixed(1) };
    })
    .sort((a, b) => b.peakBatches - a.peakBatches);

  return { byDayShift, weekPeaks, bottlenecks };
}

// ── Formatierung: Text ─────────────────────────────────────────────────────

export function formatFullResourceAsText(summary: FullResourceSummary): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.length >= n ? s : s + " ".repeat(n - s.length);

  lines.push("╔══════════════════════════════════════════════════════════════════════════╗");
  lines.push("║   STATIONS-RESSOURCEN-PLAN — WOCHENÜBERSICHT                            ║");
  lines.push("╚══════════════════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`  Gesamt:  ${summary.totalKgWeek.toFixed(0)} kg · ${summary.totalGnTraysWeek} GN-Bleche · ${summary.totalWannenWeek} Wannen`);
  lines.push(`  Kritischer Pfad (Peak): ${(summary.criticalPathPeakMinutes / 60).toFixed(1)}h`);
  lines.push("");

  if (summary.bottlenecks.length > 0) {
    lines.push("  ⚠ ENGPÄSSE:");
    for (const b of summary.bottlenecks) lines.push(`    Run ${b.run} · ${b.date} · ${b.reason}`);
    lines.push("");
  }

  if (summary.chillerWeekSummary.length > 0) {
    lines.push("  ❄ BLAST CHILLER (Woche):");
    for (const c of summary.chillerWeekSummary) lines.push(`    ${pad(c.label, 16)} ${c.sub.padEnd(14)} ${c.woCount} WOs`);
    lines.push("");
  }

  if (summary.scoopInventory.length > 0) {
    lines.push("  🥄 SCOOP-BEDARF (Woche):");
    for (const s of summary.scoopInventory) {
      const gram = s.yieldGrams ? ` (${s.yieldGrams}g)` : "";
      lines.push(`    ${s.count}× ${s.methodType} ${s.methodColor}${gram}`);
    }
    lines.push("");
  }

  if (summary.allergenStationMap.length > 0) {
    lines.push("  ⚠ ALLERGEN-STATIONEN (HACCP):");
    for (const entry of summary.allergenStationMap) lines.push(`    ${pad(entry.label, 18)} ${entry.allergens.join(", ")}`);
    lines.push("");
  }

  lines.push("  ── Station-Peaks ──");
  for (const p of summary.stationPeaks) lines.push(`    ${pad(p.label, 18)} Peak: ${p.peakBatches} Bat / ${p.peakKg.toFixed(0)} kg (${p.peakDate}) · Ø ${p.avgBatchesPerDay}/Tag`);
  lines.push("");

  for (const rd of summary.byRunDayShift) {
    lines.push(`  ┌─ Run ${rd.run} (${rd.runSharePct}%) · ${rd.date} · ${rd.shiftLabel} · ${rd.totalWos} WOs ─┐`);
    lines.push(`  │  ${rd.totalKg.toFixed(0)} kg · ${rd.totalGnTrays} Bleche · ${rd.totalWannen} Wannen · Pfad: ${(rd.criticalPathMinutes / 60).toFixed(1)}h`);
    if (rd.chillerSlots.length > 0) {
      lines.push(`  │  ❄ ${rd.chillerSlots.map(c => `${c.label}:${c.woCount}`).join(" · ")}`);
    }
    lines.push(`  │`);
    lines.push(`  │  ${pad("Station", 18)} ${"Bat".padStart(4)} ${"kg".padStart(6)} ${"~h".padStart(5)} ${"eff.h".padStart(5)} ${"Ger".padStart(3)} ${"Wa".padStart(3)} ${"Bleche".padStart(7)} ${"Racks".padStart(5)}`);
    lines.push(`  │  ${"─".repeat(72)}`);
    for (const st of rd.stations) {
      const hours = (st.estimatedMinutes / 60).toFixed(1);
      const effH = (st.effectiveMinutes / 60).toFixed(1);
      const gnStr = st.gnTrays.length > 0 ? st.gnTrays.map(t => `${t.count}×${t.gnType.replace("GN ", "")}`).join("+") : "—";
      const rackStr = st.ovenLoads != null ? String(st.ovenLoads) : "—";
      const allergenMark = st.allergensPresent.length > 0 ? " ⚠" : "";
      lines.push(`  │  ${pad(st.label + allergenMark, 18)} ${String(st.totalBatches).padStart(4)} ${st.totalKg.toFixed(0).padStart(6)} ${hours.padStart(5)} ${effH.padStart(5)} ${String(st.deviceCount).padStart(3)} ${String(st.wannen).padStart(3)} ${gnStr.padStart(7)} ${rackStr.padStart(5)}`);
      if (st.scoopsNeeded.length > 0) {
        lines.push(`  │  ${" ".repeat(18)} 🥄 ${st.scoopsNeeded.map(s => `${s.count}× ${s.methodType} ${s.methodColor}`).join(", ")}`);
      }
    }
    lines.push(`  │`);
    lines.push(`  │  Gantt (sequenziell):`);
    for (const st of rd.stations) {
      if (st.effectiveMinutes <= 0) continue;
      const startH = (st.ganttStartMin / 60).toFixed(1);
      const endH = (st.ganttEndMin / 60).toFixed(1);
      const bar = "█".repeat(Math.max(1, Math.round(st.effectiveMinutes / 15)));
      lines.push(`  │    ${startH}h ${bar} ${endH}h  ${st.label}`);
    }
    lines.push(`  └${"─".repeat(74)}┘`);
    lines.push("");
  }

  return lines.join("\n");
}

// Compat-Helfer
export function formatDemandAsText(summary: EquipmentDemandSummary): string {
  const lines: string[] = [];
  lines.push("═══ EQUIPMENT DEMAND – WOCHENÜBERSICHT ═══\n");
  if (summary.bottlenecks.length > 0) {
    lines.push("⚠ ENGPÄSSE:");
    for (const b of summary.bottlenecks) lines.push(`  ${b.date} ${b.reason}`);
    lines.push("");
  }
  lines.push("── Peaks ──");
  for (const p of summary.weekPeaks) lines.push(`  ${p.label.padEnd(18)} Peak: ${p.peakBatches} Batches (${p.peakDate}) · Ø ${p.avgBatchesPerDay}/Tag`);
  lines.push("");
  for (const ds of summary.byDayShift) {
    lines.push(`── ${ds.date} · ${ds.shiftLabel} · ${ds.woCount} WOs · ${ds.totalKg} kg ──`);
    for (const slot of ds.equipment) {
      const hours = (slot.estimatedMinutes / 60).toFixed(1);
      lines.push(`  ${slot.label.padEnd(18)} ${String(slot.totalBatches).padStart(3)} Bat · ${slot.totalKg.toFixed(1).padStart(7)} kg · ~${hours}h · WOs: ${slot.woNumbers.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── Formatierung: HTML-Snippet (für Rundmail) ──────────────────────────────

export function formatFullResourceAsHtml(summary: FullResourceSummary): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const bottleneckHtml = summary.bottlenecks.length > 0
    ? `<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;padding:8px 12px;margin-bottom:12px;">
        <div style="font-weight:800;color:#991B1B;font-size:11px;margin-bottom:4px;">⚠ ENGPÄSSE</div>
        ${summary.bottlenecks.map(b => `<div style="font-size:10px;color:#7F1D1D;">Run ${b.run} · ${esc(b.date)} · ${esc(b.reason)}</div>`).join("")}
      </div>`
    : "";

  const chillerHtml = summary.chillerWeekSummary.length > 0
    ? `<div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:6px;padding:8px 12px;margin-bottom:12px;">
        <div style="font-weight:800;color:#1E40AF;font-size:11px;margin-bottom:4px;">❄ BLAST CHILLER</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${summary.chillerWeekSummary.map(c => `<span style="background:#DBEAFE;border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;">${esc(c.label)}: ${c.woCount} WOs</span>`).join("")}
        </div>
      </div>`
    : "";

  const scoopHtml = summary.scoopInventory.length > 0
    ? `<div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:6px;padding:8px 12px;margin-bottom:12px;">
        <div style="font-weight:800;color:#166534;font-size:11px;margin-bottom:4px;">🥄 SCOOPS</div>
        <div style="font-size:10px;color:#14532D;">${summary.scoopInventory.map(s => `${s.count}× ${esc(s.methodType)} ${esc(s.methodColor)}${s.yieldGrams ? ` (${s.yieldGrams}g)` : ""}`).join(" · ")}</div>
      </div>`
    : "";

  const kpiRow = `
    <div style="display:flex;gap:6px;margin-bottom:12px;">
      <div style="flex:1;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:6px;padding:6px 10px;text-align:center;">
        <div style="font-size:8px;color:#64748B;text-transform:uppercase;">Gesamt kg</div>
        <div style="font-size:16px;font-weight:900;color:#0F172A;">${summary.totalKgWeek.toFixed(0)}</div>
      </div>
      <div style="flex:1;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:6px;padding:6px 10px;text-align:center;">
        <div style="font-size:8px;color:#64748B;text-transform:uppercase;">GN-Bleche</div>
        <div style="font-size:16px;font-weight:900;color:#0F172A;">${summary.totalGnTraysWeek}</div>
      </div>
      <div style="flex:1;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:6px;padding:6px 10px;text-align:center;">
        <div style="font-size:8px;color:#64748B;text-transform:uppercase;">Wannen</div>
        <div style="font-size:16px;font-weight:900;color:#0F172A;">${summary.totalWannenWeek}</div>
      </div>
      <div style="flex:1;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:6px;padding:6px 10px;text-align:center;">
        <div style="font-size:8px;color:#64748B;text-transform:uppercase;">Krit. Pfad</div>
        <div style="font-size:16px;font-weight:900;color:#0F172A;">${(summary.criticalPathPeakMinutes / 60).toFixed(1)}h</div>
      </div>
    </div>`;

  const dayBlocks = summary.byRunDayShift.map(rd => {
    const stRows = rd.stations.map(st => {
      const gnStr = st.gnTrays.length > 0 ? st.gnTrays.map(t => `${t.count}× ${esc(t.gnType)}`).join(", ") : "—";
      const effH = (st.effectiveMinutes / 60).toFixed(1);
      const allergenDot = st.allergensPresent.length > 0 ? ` <span style="color:#DC2626;">⚠</span>` : "";
      return `<tr>
        <td style="padding:3px 6px;font-weight:700;white-space:nowrap;">${esc(st.label)}${allergenDot}</td>
        <td style="padding:3px 6px;text-align:right;">${st.totalBatches}</td>
        <td style="padding:3px 6px;text-align:right;">${st.totalKg.toFixed(0)} kg</td>
        <td style="padding:3px 6px;text-align:right;">${effH}h</td>
        <td style="padding:3px 6px;text-align:center;">${st.deviceCount}</td>
        <td style="padding:3px 6px;text-align:right;">${st.wannen}</td>
        <td style="padding:3px 6px;">${gnStr}</td>
        <td style="padding:3px 6px;text-align:right;">${st.ovenLoads ?? "—"}</td>
      </tr>`;
    }).join("");

    return `<div style="border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;margin-bottom:10px;">
      <div style="background:#1E293B;padding:6px 12px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:11px;font-weight:800;color:#FFF;">Run ${rd.run} (${rd.runSharePct}%) · ${esc(rd.date)} · ${esc(rd.shiftLabel)}</span>
        <span style="font-size:9px;color:#94A3B8;">${rd.totalWos} WOs · ${rd.totalKg.toFixed(0)} kg · ${rd.totalGnTrays} Bleche · ${rd.totalWannen} Wa · Pfad ${(rd.criticalPathMinutes / 60).toFixed(1)}h</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:9px;">
        <thead><tr style="background:#F8FAFC;border-bottom:1px solid #E2E8F0;">
          <th style="padding:3px 6px;text-align:left;font-size:8px;text-transform:uppercase;color:#64748B;">Station</th>
          <th style="padding:3px 6px;text-align:right;font-size:8px;text-transform:uppercase;color:#64748B;">Bat</th>
          <th style="padding:3px 6px;text-align:right;font-size:8px;text-transform:uppercase;color:#64748B;">kg</th>
          <th style="padding:3px 6px;text-align:right;font-size:8px;text-transform:uppercase;color:#64748B;">eff.h</th>
          <th style="padding:3px 6px;text-align:center;font-size:8px;text-transform:uppercase;color:#64748B;">Ger.</th>
          <th style="padding:3px 6px;text-align:right;font-size:8px;text-transform:uppercase;color:#64748B;">Wa</th>
          <th style="padding:3px 6px;font-size:8px;text-transform:uppercase;color:#64748B;">Bleche</th>
          <th style="padding:3px 6px;text-align:right;font-size:8px;text-transform:uppercase;color:#64748B;">Racks</th>
        </tr></thead>
        <tbody>${stRows}</tbody>
      </table>
    </div>`;
  }).join("");

  return `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#1E293B;max-width:800px;">
    ${kpiRow}
    ${bottleneckHtml}
    ${chillerHtml}
    ${scoopHtml}
    ${dayBlocks}
  </div>`;
}

// ── CSV-Export der Equipment-Summary ────────────────────────────────────────
// Erzeugt eine RFC-4180-konforme CSV-Datei mit einer Zeile pro Station pro
// Run/Tag — geeignet für weitere Analyse in Excel/Sheets oder als Anhang an
// Rundmails.

export function formatFullResourceAsCsv(summary: FullResourceSummary): string {
  const header = [
    "Run", "Datum", "Schicht", "Station", "Batches", "kg",
    "Dauer (min)", "Effektiv (min)", "Geräte", "Wannen", "GN-Bleche",
    "Rack-Ladungen", "MA-Bedarf", "Allergene", "WOs",
  ].join(";");

  const rows: string[] = [];
  for (const rd of summary.byRunDayShift) {
    for (const st of rd.stations) {
      const gnTotal = st.gnTrays.reduce((s, t) => s + t.count, 0);
      rows.push([
        rd.run,
        rd.date,
        rd.shiftLabel,
        st.label,
        st.totalBatches,
        st.totalKg.toFixed(1),
        st.estimatedMinutes,
        st.effectiveMinutes,
        st.deviceCount,
        st.wannen,
        gnTotal,
        st.ovenLoads ?? "",
        st.staffNeeded,
        st.allergensPresent.join(", "),
        st.woNumbers.join(", "),
      ].join(";"));
    }
  }
  return [header, ...rows].join("\n");
}

// ── Wochen-Vergleich (Delta-Dashboard) ─────────────────────────────────────
// Vergleicht zwei FullResourceSummary-Objekte (z.B. Vorwoche vs. aktuelle Woche)
// und berechnet Deltas für die wichtigsten KPIs pro Station.

export interface WeekDeltaStation {
  station: string;
  label: string;
  batchesCurrent: number;
  batchesPrevious: number;
  batchesDelta: number;
  kgCurrent: number;
  kgPrevious: number;
  kgDelta: number;
  minutesCurrent: number;
  minutesPrevious: number;
  minutesDelta: number;
  staffCurrent: number;
  staffPrevious: number;
  staffDelta: number;
}

export interface WeekDelta {
  kgDelta: number;
  gnTraysDelta: number;
  wannenDelta: number;
  staffDelta: number;
  criticalPathDelta: number;
  stations: WeekDeltaStation[];
}

export function computeWeekDelta(
  current: FullResourceSummary,
  previous: FullResourceSummary,
): WeekDelta {
  const stationMap = new Map<string, { cur: { batches: number; kg: number; min: number; staff: number }; prev: { batches: number; kg: number; min: number; staff: number } }>();

  const aggregate = (summary: FullResourceSummary, side: "cur" | "prev") => {
    for (const rd of summary.byRunDayShift) {
      for (const st of rd.stations) {
        if (!stationMap.has(st.station)) {
          stationMap.set(st.station, {
            cur: { batches: 0, kg: 0, min: 0, staff: 0 },
            prev: { batches: 0, kg: 0, min: 0, staff: 0 },
          });
        }
        const entry = stationMap.get(st.station)![side];
        entry.batches += st.totalBatches;
        entry.kg += st.totalKg;
        entry.min += st.effectiveMinutes;
        entry.staff = Math.max(entry.staff, st.staffNeeded);
      }
    }
  };

  aggregate(current, "cur");
  aggregate(previous, "prev");

  const stations: WeekDeltaStation[] = [...stationMap.entries()]
    .map(([station, { cur, prev }]) => ({
      station,
      label: STATION_LABELS[station] ?? station,
      batchesCurrent: cur.batches,
      batchesPrevious: prev.batches,
      batchesDelta: cur.batches - prev.batches,
      kgCurrent: +cur.kg.toFixed(1),
      kgPrevious: +prev.kg.toFixed(1),
      kgDelta: +(cur.kg - prev.kg).toFixed(1),
      minutesCurrent: cur.min,
      minutesPrevious: prev.min,
      minutesDelta: cur.min - prev.min,
      staffCurrent: cur.staff,
      staffPrevious: prev.staff,
      staffDelta: cur.staff - prev.staff,
    }))
    .sort((a, b) => Math.abs(b.batchesDelta) - Math.abs(a.batchesDelta));

  return {
    kgDelta: +(current.totalKgWeek - previous.totalKgWeek).toFixed(1),
    gnTraysDelta: current.totalGnTraysWeek - previous.totalGnTraysWeek,
    wannenDelta: current.totalWannenWeek - previous.totalWannenWeek,
    staffDelta: current.peakStaffNeeded - previous.peakStaffNeeded,
    criticalPathDelta: current.criticalPathPeakMinutes - previous.criticalPathPeakMinutes,
    stations,
  };
}

// ── Allergen-Sortierung für Shopfloor ────────────────────────────────────────

// Deckt alle biAllergen()-Ausgaben aus factorRules.ts ab (ALLERGEN_BILINGUAL) —
// spezifische Nuss-/Getreide-/Meeresfrüchte-Sorten teilen sich das Gewicht
// ihrer Oberkategorie, sonst fallen sie unbemerkt auf den 2er-Default zurück.
const ALLERGEN_WEIGHT: Record<string, number> = {
  "Tree nuts / Schalenfrüchte": 5,
  "Peanuts / Erdnüsse": 5,
  "Almonds / Mandeln": 5,
  "Walnuts / Walnüsse": 5,
  "Cashew nuts / Kaschunüsse": 5,
  "Pistachios / Pistazien": 5,
  "Hazelnuts / Haselnüsse": 5,
  "Brazil nuts / Paranüsse": 5,
  "Pecans / Pekannüsse": 5,
  "Macadamia nuts / Macadamianüsse": 5,
  "Sesame seeds / Sesamsamen": 4,
  "Fish / Fisch": 4,
  "Crustaceans / Krebstiere": 4,
  "Molluscs / Weichtiere": 4,
  "Eggs / Eier": 3,
  "Milk (incl. lactose) / Milch (einschließlich Laktose)": 2,
  "Soya / Soja": 2,
  "Lupin / Lupinen": 2,
  "Sulphur dioxide & sulphites / Schwefeldioxide und Sulfite": 2,
  "Cereals containing gluten / Glutenhaltiges Getreide": 1,
  "Wheat / Weizen": 1,
  "Barley / Gerste": 1,
  "Oats / Hafer": 1,
  "Rye / Roggen": 1,
  "Spelt / Dinkel": 1,
  "Celery / Sellerie": 1,
  "Mustard / Senf": 1,
};

export function allergenSortScore(allergens: string[]): number {
  if (allergens.length === 0) return 0;
  let score = 0;
  for (const a of allergens) {
    score += ALLERGEN_WEIGHT[a] ?? 2;
  }
  return score;
}
