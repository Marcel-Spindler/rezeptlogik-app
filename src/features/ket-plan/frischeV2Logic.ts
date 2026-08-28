// Frischeliste 2.0 – Aggregationslogik
// 3 Küchenbereiche: Braiser | Middle Kitchen | Brine / Grill
//
// Sheet-Spalten → Bereich:
//   Braiser                        → Braiser
//   Cup, Butter, Slice             → Middle Kitchen  (Planetary mix, Butter scooping, Immersion Blender, Shredder)
//   Grill                          → Brine / Grill   (Proteine + extra)
//   Oven                           → Andere           (überall vorhanden, kein eigener Bereich)
// Priority bei mehreren aktiven Stationen: Braiser > Grill > Cup > Butter > Slice > Oven

import type { DataBundle, Recipe, CookSchedule } from "../../core/types";
import type { Market } from "../../core/types";
import type { PlanningSheetData, PlanningRow, SheetDay } from "../../lib/planningSheetApi";
import { PROD_DAYS } from "../../lib/planningSheetApi";
import { resolveCookSchedule } from "../../lib/helpers";
import { VF_COOK_SCHEDULES } from "../../data/cookSchedulesVF";


// ── Tages-Offset (Cook Schedule–aware) ───────────────────────────────────────

const DAY_ORDER: SheetDay[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Verschiebt einen Wochentag um `offset` Tage zurück.
// offsetDay("Monday", 1) → "Sunday"  |  offsetDay("Monday", 2) → "Saturday"
function offsetDay(day: SheetDay, offset: number): SheetDay {
  const idx = DAY_ORDER.indexOf(day);
  return DAY_ORDER[((idx - offset) % 7 + 7) % 7];
}

// Rechnet Cook Shifts in Tage Vorlauf um.
// +1 Tag: Anlieferung muss einen Tag VOR Staging-Start erfolgen.
// Aktuell: 1 Schicht = 1 Tag (Tagschicht-Modell).
// Bei Umstellung auf 2-Schicht-Betrieb: hier anpassen.
function shiftsToDays(shifts: number): number {
  return shifts + 1;
}

// Alle Tage die in der Ansicht auftauchen können (So–Sa), erweitert weil
// Zutaten mit 2-3 Shifts auch auf Sa landen können.
export const COOK_DAYS: SheetDay[] = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

// ── Stationen (exakte Sheet-Spalten-Namen) ────────────────────────────────────

export type StationType =
  | "Braiser"
  | "Grill"
  | "Cup"
  | "Butter"
  | "Slice"
  | "Oven"
  | "Andere";

export const STATION_ORDER: StationType[] = [
  "Braiser",
  "Grill",
  "Cup",
  "Butter",
  "Slice",
  "Oven",
  "Andere",
];

export const STATION_COLORS: Record<StationType, { bg: string; text: string; border: string; badge: string }> = {
  "Braiser": { bg: "bg-orange-50",  text: "text-orange-900",  border: "border-orange-200",  badge: "bg-orange-100 text-orange-700 border-orange-200" },
  "Grill":   { bg: "bg-rose-50",    text: "text-rose-900",    border: "border-rose-200",    badge: "bg-rose-100 text-rose-700 border-rose-200" },
  "Cup":     { bg: "bg-sky-50",     text: "text-sky-900",     border: "border-sky-200",     badge: "bg-sky-100 text-sky-700 border-sky-200" },
  "Butter":  { bg: "bg-yellow-50",  text: "text-yellow-900",  border: "border-yellow-300",  badge: "bg-yellow-100 text-yellow-700 border-yellow-300" },
  "Slice":   { bg: "bg-violet-50",  text: "text-violet-900",  border: "border-violet-200",  badge: "bg-violet-100 text-violet-700 border-violet-200" },
  "Oven":    { bg: "bg-amber-50",   text: "text-amber-900",   border: "border-amber-200",   badge: "bg-amber-100 text-amber-700 border-amber-200" },
  "Andere":  { bg: "bg-slate-50",   text: "text-slate-700",   border: "border-slate-200",   badge: "bg-slate-100 text-slate-600 border-slate-200" },
};

// ── Küchenbereiche ────────────────────────────────────────────────────────────

export type StationGroup = "Braiser" | "Middle Kitchen" | "Brine / Grill" | "Andere";

export const GROUP_ORDER: StationGroup[] = ["Braiser", "Middle Kitchen", "Brine / Grill", "Andere"];

// Station → Küchenbereich
export const STATION_GROUP_MAP: Record<StationType, StationGroup> = {
  "Braiser": "Braiser",
  "Grill":   "Brine / Grill",
  "Cup":     "Middle Kitchen",
  "Butter":  "Middle Kitchen",
  "Slice":   "Middle Kitchen",
  "Oven":    "Andere",
  "Andere":  "Andere",
};

export const GROUP_COLORS: Record<StationGroup, { bg: string; text: string; border: string; header: string }> = {
  "Braiser": {
    bg: "bg-orange-600", text: "text-white", border: "border-orange-700",
    header: "bg-orange-600 text-white",
  },
  "Middle Kitchen": {
    bg: "bg-[#1e3a5f]", text: "text-white", border: "border-blue-900",
    header: "bg-[#1e3a5f] text-white",
  },
  "Brine / Grill": {
    bg: "bg-rose-700", text: "text-white", border: "border-rose-800",
    header: "bg-rose-700 text-white",
  },
  "Andere": {
    bg: "bg-slate-500", text: "text-white", border: "border-slate-600",
    header: "bg-slate-500 text-white",
  },
};

// ── Kategorie ─────────────────────────────────────────────────────────────────

export type CatType = "PHF" | "PTN" | "Andere";

export const CAT_COLORS: Record<CatType, { bg: string; text: string; border: string }> = {
  PHF:    { bg: "bg-orange-100", text: "text-orange-800", border: "border-orange-200" },
  PTN:    { bg: "bg-pink-100",   text: "text-pink-800",   border: "border-pink-200" },
  Andere: { bg: "bg-slate-100",  text: "text-slate-600",  border: "border-slate-200" },
};

// ── Zeilen-Typen ──────────────────────────────────────────────────────────────

export type DaysKg = Record<SheetDay, number>;

export function emptyDays(): DaysKg {
  return { Sunday: 0, Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 0 };
}

export interface V2Row {
  key: string;
  ingredientId: string;
  name: string;
  category: string;
  catType: CatType;
  submeal: string;
  station: StationType;
  stationGroup: StationGroup;
  recipes: Set<string>;
  mealNames: Set<string>;
  daysKg: DaysKg;
  totalKg: number;
  leadDays: number;        // Tatsächliche Vorlaufzeit in Tagen (shifts + 1, da Anlieferung vor Staging)
  cookMethod: string;      // Matched Cook Method für Tooltip
}

export interface V2StationGroup {
  station: StationType;
  stationGroup: StationGroup;
  all: V2Row[];
  daysKg: DaysKg;
  totalKg: number;
}

export interface V2ParentGroup {
  group: StationGroup;
  stations: V2StationGroup[];
  daysKg: DaysKg;
  totalKg: number;
}

export interface V2Result {
  parents: V2ParentGroup[];
  stations: V2StationGroup[];
  allRows: V2Row[];
  einkauf: V2Row[];
  daysKg: DaysKg;
  totalKg: number;
  week: string;
  recipeCount: number;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function classifyCat(cat: string | undefined): CatType {
  const c = (cat || "").toUpperCase().trim();
  if (c === "PHF") return "PHF";
  if (c === "PTN") return "PTN";
  return "Andere";
}

// Subrecipe-Kategorie → StationType (ingredient-level Granularität)
function cookMethodToStation(category: string): StationType {
  const c = (category || "").toUpperCase();
  if (c.includes("BRAISER"))    return "Braiser";
  if (c.includes("OVEN"))       return "Oven";
  if (c.includes("GRILL"))      return "Grill";
  if (
    c.includes("PLANETARY") ||
    c.includes("IMMERSION") ||
    c.includes("BLAST CHILLER") ||
    c.includes("HORIZONTAL MIXER") ||
    c.includes("HAND MIX") ||
    c.includes("CUP")
  )                              return "Cup";
  if (c.includes("BUTTER"))     return "Butter";
  if (c.includes("SLICE"))      return "Slice";
  return "Andere";
}

// Rezept-Ebene: primäre Station nach Priorität (Braiser > Grill > Cup > Butter > Slice > Oven)
function recipeToStation(planRow: PlanningRow | undefined): StationType {
  if (!planRow?.stations) return "Andere";
  if (planRow.stations["Braiser"]) return "Braiser";
  if (planRow.stations["Grill"])   return "Grill";
  if (planRow.stations["Cup"])     return "Cup";
  if (planRow.stations["Butter"])  return "Butter";
  if (planRow.stations["Slice"])   return "Slice";
  if (planRow.stations["Oven"])    return "Oven";
  return "Andere";
}

function detectStation(
  subRecipeName: string | undefined,
  recipe: Recipe,
  market: Market,
  planRow: PlanningRow | undefined,
): StationType {
  // 1. Subrecipe-Kategorie (ingredient-level Granularität)
  if (subRecipeName) {
    const mDetails =
      recipe.markets[market] ??
      recipe.markets["DE"] ??
      recipe.markets["BENL"] ??
      recipe.markets["DKSE"];
    if (mDetails) {
      const sub = mDetails.subRecipes.find(s => s.name === subRecipeName);
      if (sub) {
        const st = cookMethodToStation(sub.category);
        if (st !== "Andere") return st;
      }
    }
  }
  // 2. Fallback: Rezept-Ebene Priorität
  return recipeToStation(planRow);
}

// Cook-Schedule Lookup: Wieviele Schichten vor Plating muss STAGING starten?
// Primär: statische VF-Daten (246 Einträge aus Excel).
// Fallback: Firestore cookSchedules.
function detectCookShifts(
  subRecipeName: string | undefined,
  recipe: Recipe,
  market: Market,
  cookSchedules: Record<string, CookSchedule>,
): { shifts: number; matchedMethod: string } {
  if (subRecipeName) {
    const mDetails =
      recipe.markets[market] ??
      recipe.markets["DE"] ??
      recipe.markets["BENL"] ??
      recipe.markets["DKSE"];
    if (mDetails) {
      const sub = mDetails.subRecipes.find(s => s.name === subRecipeName);
      if (sub) {
        // 1. Statische VF-Daten (primär)
        const vfResolved = resolveCookSchedule(sub.category, VF_COOK_SCHEDULES);
        if (vfResolved.schedule) {
          return { shifts: vfResolved.schedule.cookShifts, matchedMethod: vfResolved.matchedMethod ?? sub.category };
        }
        // 2. Firestore (Fallback)
        const fsResolved = resolveCookSchedule(sub.category, cookSchedules);
        if (fsResolved.schedule) {
          return { shifts: fsResolved.schedule.cookShifts, matchedMethod: fsResolved.matchedMethod ?? sub.category };
        }
      }
    }
  }
  return { shifts: 1, matchedMethod: "" };
}

function addDays(a: DaysKg, b: DaysKg): DaysKg {
  return {
    Sunday:    a.Sunday    + b.Sunday,
    Monday:    a.Monday    + b.Monday,
    Tuesday:   a.Tuesday   + b.Tuesday,
    Wednesday: a.Wednesday + b.Wednesday,
    Thursday:  a.Thursday  + b.Thursday,
    Friday:    a.Friday    + b.Friday,
    Saturday:  a.Saturday  + b.Saturday,
  };
}

function buildParentGroups(stations: V2StationGroup[]): V2ParentGroup[] {
  const groupMap = new Map<StationGroup, V2StationGroup[]>();
  for (const sg of stations) {
    const g = sg.stationGroup;
    const list = groupMap.get(g) ?? [];
    list.push(sg);
    groupMap.set(g, list);
  }
  return GROUP_ORDER
    .filter(g => groupMap.has(g))
    .map(group => {
      const sts = groupMap.get(group)!;
      const daysKg = sts.reduce((acc, s) => addDays(acc, s.daysKg), emptyDays());
      return {
        group,
        stations: sts,
        daysKg,
        totalKg: sts.reduce((s, sg) => s + sg.totalKg, 0),
      };
    });
}

// ── Haupt-Aggregation ─────────────────────────────────────────────────────────

export function buildV2Data(
  data: DataBundle,
  planSheet: PlanningSheetData,
  catFilter: Set<CatType>,
): V2Result {
  const planMap = new Map<string, PlanningRow>();
  for (const pr of planSheet.rows) planMap.set(pr.code, pr);

  const agg = new Map<string, V2Row>();
  let recipeCount = 0;

  for (const wr of data.weekRecipes) {
    if (wr.hfWeek !== planSheet.week) continue;
    const planRow = planMap.get(wr.code);
    if (!planRow) continue;

    const recipe = data.recipes[wr.code];
    if (!recipe) continue;

    recipeCount++;

    const sheetTotal = PROD_DAYS.reduce((s, d) => s + (planRow.days[d] ?? 0), 0);
    if (sheetTotal === 0) continue;

    const grossIngs =
      recipe.grossIngredients["DE"] ??
      recipe.grossIngredients["BENL"] ??
      recipe.grossIngredients["DKSE"] ??
      [];

    const deduped = new Map<string, {
      qty: number; submeal: string; station: StationType;
      category: string; name: string; id: string;
      leadDays: number; cookMethod: string;
    }>();

    for (const ing of grossIngs) {
      const catT = classifyCat(ing.ingredientCategory);
      if (catFilter.size > 0 && !catFilter.has(catT)) continue;

      const ingKey = ing.ingredientId || ing.ingredient;
      const submeal = ing.subRecipe1 || "—";
      const rowKey = `${ingKey}|${submeal}`;
      const existing = deduped.get(rowKey);
      if (existing) {
        existing.qty += ing.grossQuantityPerPortion;
      } else {
        const station = detectStation(ing.subRecipe1, recipe, "DE", planRow);
        const { shifts, matchedMethod } = detectCookShifts(ing.subRecipe1, recipe, "DE", data.cookSchedules);
        deduped.set(rowKey, {
          qty: ing.grossQuantityPerPortion,
          submeal,
          station,
          category: ing.ingredientCategory ?? "",
          name: ing.ingredient,
          id: ingKey,
          leadDays: shiftsToDays(shifts),
          cookMethod: matchedMethod,
        });
      }
    }

    for (const [rowKey, { qty, submeal, station, category, name, id, leadDays, cookMethod }] of deduped) {
      const daysKg = emptyDays();
      let totalKg = 0;
      for (const platingDay of PROD_DAYS) {
        const portions = planRow.days[platingDay] ?? 0;
        if (portions <= 0) continue;
        const deliveryDay = offsetDay(platingDay, leadDays);
        const kg = (portions * qty) / 1000;
        daysKg[deliveryDay] += kg;
        totalKg += kg;
      }
      if (totalKg <= 0) continue;

      let row = agg.get(rowKey);
      if (!row) {
        row = {
          key: rowKey,
          ingredientId: id,
          name,
          category,
          catType: classifyCat(category),
          submeal,
          station,
          stationGroup: STATION_GROUP_MAP[station],
          recipes: new Set(),
          mealNames: new Set(),
          daysKg: emptyDays(),
          totalKg: 0,
          leadDays,
          cookMethod,
        };
        agg.set(rowKey, row);
      } else {
        // Spezifischere Station gewinnt: dieselbe Zutat+Submeal kann in mehreren Rezepten
        // unterschiedliche Fallback-Stationen bekommen. Wir nehmen immer die höchstrangige
        // (Braiser > Grill > Cup > Butter > Slice > Oven > Andere).
        const newPriority = STATION_ORDER.indexOf(station);
        const curPriority = STATION_ORDER.indexOf(row.station);
        if (newPriority < curPriority) {
          row.station = station;
          row.stationGroup = STATION_GROUP_MAP[station];
        }
      }
      row.daysKg = addDays(row.daysKg, daysKg);
      row.totalKg += totalKg;
      row.recipes.add(wr.code);
      row.mealNames.add(wr.recipeName || wr.code);
    }
  }

  const allRows = [...agg.values()].sort((a, b) => b.totalKg - a.totalKg);

  // Einkauf: gleiche Zutat über alle Submeals zusammenfassen
  const einkaufMap = new Map<string, V2Row>();
  for (const row of allRows) {
    const existing = einkaufMap.get(row.ingredientId);
    if (existing) {
      existing.daysKg = addDays(existing.daysKg, row.daysKg);
      existing.totalKg += row.totalKg;
      if (row.leadDays > existing.leadDays) {
        existing.leadDays = row.leadDays;
        existing.cookMethod = row.cookMethod;
      }
      for (const r of row.recipes) existing.recipes.add(r);
      for (const m of row.mealNames) existing.mealNames.add(m);
    } else {
      einkaufMap.set(row.ingredientId, {
        ...row,
        key: row.ingredientId,
        submeal: "—",
        daysKg: { ...row.daysKg },
        recipes: new Set(row.recipes),
        mealNames: new Set(row.mealNames),
      });
    }
  }
  const einkauf = [...einkaufMap.values()].sort((a, b) => b.totalKg - a.totalKg);

  const stationMap = new Map<StationType, V2Row[]>();
  for (const row of allRows) {
    const list = stationMap.get(row.station) ?? [];
    list.push(row);
    stationMap.set(row.station, list);
  }

  const stations: V2StationGroup[] = STATION_ORDER
    .filter(s => stationMap.has(s))
    .map(station => {
      const rows = stationMap.get(station)!;
      const daysKg = rows.reduce((acc, r) => addDays(acc, r.daysKg), emptyDays());
      return {
        station,
        stationGroup: STATION_GROUP_MAP[station],
        all: rows,
        daysKg,
        totalKg: rows.reduce((s, r) => s + r.totalKg, 0),
      };
    });

  const parents = buildParentGroups(stations);
  const globalDays = allRows.reduce((acc, r) => addDays(acc, r.daysKg), emptyDays());

  return {
    parents,
    stations,
    allRows,
    einkauf,
    daysKg: globalDays,
    totalKg: allRows.reduce((s, r) => s + r.totalKg, 0),
    week: planSheet.week,
    recipeCount,
  };
}

// ── Fallback ──────────────────────────────────────────────────────────────────

export function buildV2DataFallback(
  data: DataBundle,
  week: string,
  dayWeights: DaysKg,
  catFilter: Set<CatType>,
): V2Result {
  const weekRecs = data.weekRecipes.filter(wr => wr.hfWeek === week);
  const totalPortions = weekRecs.reduce((s, wr) => s + wr.totalVerdenVolume, 0);
  const weightTotal = PROD_DAYS.reduce((s, d) => s + (dayWeights[d] ?? 0), 0);

  if (totalPortions === 0 || weightTotal === 0) {
    return { parents: [], stations: [], allRows: [], einkauf: [], daysKg: emptyDays(), totalKg: 0, week, recipeCount: 0 };
  }

  const planRows: PlanningRow[] = weekRecs.map(wr => {
    const days: Partial<Record<SheetDay, number>> = {};
    for (const d of PROD_DAYS) {
      const w = dayWeights[d] ?? 0;
      days[d] = wr.totalVerdenVolume * (w / weightTotal);
    }
    return {
      code: wr.code, name: wr.recipeName || wr.code, preference: wr.preference,
      total: wr.totalVerdenVolume, totalBuffer: wr.totalVerdenVolume, stations: {}, days,
    };
  });

  const synthetic: PlanningSheetData = { week, tabName: "(Schätzung)", rows: planRows, fetchedAt: Date.now() };
  return buildV2Data(data, synthetic, catFilter);
}

// ── Exporte ───────────────────────────────────────────────────────────────────

const DAY_EXPORT_LABELS: Record<string, string> = {
  Sunday: "So", Monday: "Mo", Tuesday: "Di", Wednesday: "Mi",
  Thursday: "Do", Friday: "Fr", Saturday: "Sa",
};

const LEAD_LABEL: Record<number, string> = { 1: "1T", 2: "2T", 3: "3T", 4: "4T" };
function leadLabel(n: number): string { return LEAD_LABEL[n] ?? `${n}T`; }

export function v2ToCsv(rows: V2Row[], week: string, includeSubmeal: boolean): string {
  const dayLabels = COOK_DAYS.map(d => DAY_EXPORT_LABELS[d] ?? d);
  const header = [
    "Bereich", "Station", "Kategorie", "Artikel", "SKU", "Vorlauf",
    ...(includeSubmeal ? ["Submeal", "Mahlzeiten"] : []),
    ...dayLabels, "Gesamt (kg)",
  ].join(",");

  const lines = [`# Frischeliste 2.0 – ${week}`, `# Tage = Anlieferungstag (Plating minus Vorlaufzeit)`, header];
  for (const r of rows) {
    const days = COOK_DAYS.map(d => r.daysKg[d].toFixed(2));
    const cols = [
      `"${r.stationGroup}"`,
      `"${r.station}"`,
      `"${r.category}"`,
      `"${r.name.replace(/"/g, '""')}"`,
      `"${r.ingredientId}"`,
      `"${leadLabel(r.leadDays)} vorher"`,
      ...(includeSubmeal
        ? [`"${r.submeal.replace(/"/g, '""')}"`, `"${[...r.mealNames].join("; ").replace(/"/g, '""')}"`]
        : []),
      ...days,
      r.totalKg.toFixed(2),
    ];
    lines.push(cols.join(","));
  }
  return lines.join("\n");
}

export function v2ToExcelRows(rows: V2Row[], includeSubmeal: boolean): (string | number)[][] {
  const dayLabels = COOK_DAYS.map(d => DAY_EXPORT_LABELS[d] ?? d);
  const header: (string | number)[] = [
    "Bereich", "Station", "Kategorie", "Artikel", "SKU", "Vorlauf",
    ...(includeSubmeal ? ["Submeal"] : []),
    ...dayLabels, "Gesamt (kg)",
  ];
  const data: (string | number)[][] = [header];
  for (const r of rows) {
    const row: (string | number)[] = [
      r.stationGroup, r.station, r.category, r.name, r.ingredientId,
      `${leadLabel(r.leadDays)} vorher`,
      ...(includeSubmeal ? [r.submeal] : []),
      ...COOK_DAYS.map(d => parseFloat(r.daysKg[d].toFixed(2))),
      parseFloat(r.totalKg.toFixed(2)),
    ];
    data.push(row);
  }
  return data;
}

// Einkauf-Export: getrennt nach PHF und PTN, ohne Bereich/Station
export function v2ToEinkaufExcelRows(phfRows: V2Row[], ptnRows: V2Row[]): (string | number)[][] {
  const dayLabels = COOK_DAYS.map(d => DAY_EXPORT_LABELS[d] ?? d);
  const header: (string | number)[] = ["Artikel", "SKU", "Vorlauf", ...dayLabels, "Gesamt (kg)"];
  const toRow = (r: V2Row): (string | number)[] => [
    r.name, r.ingredientId, `${leadLabel(r.leadDays)} vorher`,
    ...COOK_DAYS.map(d => parseFloat(r.daysKg[d].toFixed(2))),
    parseFloat(r.totalKg.toFixed(2)),
  ];
  return [
    header,
    [`── PHF (${phfRows.length} Artikel) ──`],
    ...phfRows.map(toRow),
    [],
    [`── PTN (${ptnRows.length} Artikel) ──`],
    ...ptnRows.map(toRow),
  ];
}

const GER_DAYS: Partial<Record<SheetDay, string>> = {
  Monday: "Montag", Tuesday: "Dienstag", Wednesday: "Mittwoch",
  Thursday: "Donnerstag", Friday: "Freitag", Saturday: "Samstag", Sunday: "Sonntag",
};

const AREA_COLORS: Record<string, { header: string; sub: string }> = {
  "Braiser":        { header: "#c2410c", sub: "#fed7aa" },
  "Middle Kitchen": { header: "#1e3a5f", sub: "#dbeafe" },
  "Brine / Grill":  { header: "#be123c", sub: "#ffe4e6" },
  "Andere":         { header: "#64748b", sub: "#f1f5f9" },
};

// PDF-Export: pro Tag ein eigener Abschnitt mit Seitenumbruch.
// activeDays = vom User gewählte Tage; null → alle PROD_DAYS mit Daten.
export function v2ToPdfHtml(result: V2Result, week: string, includeSubmeal: boolean, activeDays?: SheetDay[]): string {
  const days = (activeDays ?? COOK_DAYS).filter(d => result.daysKg[d] > 0);

  const daySections = days.map((day, dayIdx) => {
    const dayTotal = result.allRows.reduce((s, r) => s + r.daysKg[day], 0);
    if (dayTotal === 0) return "";

    const areaBlocks = result.parents.map(pg => {
      if (pg.daysKg[day] === 0) return "";
      const colors = AREA_COLORS[pg.group] ?? { header: "#475569", sub: "#f8fafc" };

      const stBlocks = pg.stations.map(sg => {
        const sgDayKg = sg.daysKg[day];
        if (sgDayKg === 0) return "";
        const activeRows = sg.all.filter(r => r.daysKg[day] > 0)
          .sort((a, b) => b.daysKg[day] - a.daysKg[day]);

        const rowsHtml = activeRows.map(r => {
          const leadBadge = r.leadDays > 2
            ? `<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px;margin-left:4px;">${r.leadDays}T vorher</span>`
            : "";
          return `
          <tr>
            <td style="padding:3px 6px;font-size:11px;">${r.name}${leadBadge}</td>
            <td style="padding:3px 6px;font-size:10px;color:#666;">${r.category}</td>
            ${includeSubmeal ? `<td style="padding:3px 6px;font-size:10px;color:#555;">${r.submeal}</td>` : ""}
            <td style="text-align:right;padding:3px 6px;font-size:11px;font-weight:700;">${r.daysKg[day].toFixed(1)} kg</td>
          </tr>`;
        }).join("");

        return `
          <div style="margin-bottom:8px;margin-left:16px;">
            <div style="background:#475569;color:white;padding:4px 8px;font-weight:700;font-size:11px;">
              ${sg.station} — ${sgDayKg.toFixed(1)} kg · ${activeRows.length} Artikel
            </div>
            <table style="width:100%;border-collapse:collapse;border:1px solid #ddd;border-top:none;">
              <thead>
                <tr style="background:${colors.sub};">
                  <th style="text-align:left;padding:3px 6px;font-size:10px;">Artikel</th>
                  <th style="padding:3px 6px;font-size:10px;">Kat</th>
                  ${includeSubmeal ? `<th style="padding:3px 6px;font-size:10px;">Submeal</th>` : ""}
                  <th style="text-align:right;padding:3px 6px;font-size:10px;">Bedarf</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>`;
      }).filter(Boolean).join("");

      return `
        <div style="margin-bottom:12px;">
          <div style="background:${colors.header};color:white;padding:6px 12px;font-weight:800;font-size:12px;border-radius:4px 4px 0 0;">
            ${pg.group} — ${pg.daysKg[day].toFixed(1)} kg
          </div>
          ${stBlocks}
        </div>`;
    }).filter(Boolean).join("");

    const pageBreak = dayIdx > 0 ? "page-break-before:always;" : "";
    return `
      <div style="${pageBreak}margin-bottom:30px;">
        <h2 style="font-size:18px;font-weight:900;color:#1e3a5f;border-bottom:3px solid #1e3a5f;padding-bottom:6px;margin-bottom:14px;">
          ${GER_DAYS[day] ?? day}
          <span style="font-size:12px;font-weight:400;color:#666;margin-left:12px;">Gesamt: ${dayTotal.toFixed(1)} kg</span>
        </h2>
        ${areaBlocks}
      </div>`;
  }).filter(Boolean).join("");

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Frischeliste 2.0 – ${week}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; color: #1a1a1a; }
    h1 { font-size: 16px; color: #1e3a5f; margin-bottom: 4px; }
    .meta { font-size: 11px; color: #666; margin-bottom: 16px; }
    @media print { body { margin: 10mm; } }
  </style>
</head>
<body>
  <h1>Frischeliste 2.0 – ${week}</h1>
  <div class="meta">Gesamt: ${result.totalKg.toFixed(1)} kg · ${result.recipeCount} Rezepte · ${days.map(d => GER_DAYS[d] ?? d).join(", ")} · ${new Date().toLocaleString("de-DE")}</div>
  <div class="meta" style="margin-top:2px;font-style:italic;">Tage = Anlieferungstag · Artikel mit <span style="background:#fef3c7;color:#92400e;padding:0 3px;border-radius:2px;font-weight:700;">3T+</span> müssen extra früh da sein (Cook Schedule)</div>
  ${daySections}
  <script>window.print();</script>
</body>
</html>`;
}

export { PROD_DAYS };
