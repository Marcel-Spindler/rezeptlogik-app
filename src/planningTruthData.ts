import Papa from "papaparse";

export interface PlanningTruthRecipeIntel {
  recipeCode: string;
  recipeDigitKey: string;
  recipeName: string;
  aliases: string[];
  forecastTotal: number;
  forecastByMarket: {
    bnl: number;
    nordics: number;
    germany: number;
  };
  forecastSlots: Array<{
    week: string;
    slot: string;
    bnl: number;
    nordics: number;
    germany: number;
    total: number;
  }>;
  pdlBoxCount: number;
  pdlPortions: number;
  pdlProductionDates: string[];
  pdlLanes: Array<{ name: string; count: number }>;
  pdlBoxSizes: Array<{ name: string; count: number }>;
  pdlExtras: Array<{ name: string; count: number }>;
}

export interface PlanningTruthWeekIntel {
  week: string;
  recipes: string[];
  forecastTotal: number;
  forecastByMarket: {
    bnl: number;
    nordics: number;
    germany: number;
  };
  pdlBoxCount: number;
  pdlPortions: number;
  forecastRecipeCount: number;
  pdlRecipeCount: number;
  productionDates: string[];
}

export interface PlanningTruthDataset {
  recipesByDigit: Record<string, PlanningTruthRecipeIntel>;
  weeks: Record<string, PlanningTruthWeekIntel>;
}

type TruthRecipeAccumulator = {
  recipeCode: string;
  recipeDigitKey: string;
  recipeName: string;
  aliases: Set<string>;
  forecastByMarket: {
    bnl: number;
    nordics: number;
    germany: number;
  };
  forecastSlots: Map<string, { week: string; slot: string; bnl: number; nordics: number; germany: number; total: number }>;
  pdlBoxCount: number;
  pdlPortions: number;
  pdlProductionDates: Set<string>;
  pdlLanes: Map<string, number>;
  pdlBoxSizes: Map<string, number>;
  pdlExtras: Map<string, number>;
};

type TruthWeekAccumulator = {
  week: string;
  recipes: Set<string>;
  forecastRecipeDigits: Set<string>;
  pdlRecipeDigits: Set<string>;
  forecastByMarket: {
    bnl: number;
    nordics: number;
    germany: number;
  };
  pdlBoxCount: number;
  pdlPortions: number;
  productionDates: Set<string>;
};

let planningTruthPromise: Promise<PlanningTruthDataset> | null = null;

function normalizeCell(value: unknown): string {
  return String(value ?? "").trim();
}

function parseNum(value: unknown): number {
  const raw = normalizeCell(value);
  if (!raw) return 0;
  const normalized = raw.replace(/€/g, "").replace(/\./g, "").replace(/,/g, ".");
  const num = Number.parseFloat(normalized);
  return Number.isFinite(num) ? num : 0;
}

function recipeDigitKey(raw: string): string {
  const match = normalizeCell(raw).toUpperCase().match(/(?:FE|FV)?(\d{4})[A-Z0-9]?/);
  return match?.[1] ?? normalizeCell(raw).toUpperCase();
}

// Shift an ISO-week string by +deltaDays (in 7-day increments).
// "2026-W21" + 7 days → "2026-W22", handles year boundaries.
function shiftIsoWeek(weekStr: string, deltaDays: number): string {
  const m = weekStr.match(/^(\d{4})-W(\d{1,2})$/);
  if (!m) return weekStr;
  const year = Number(m[1]);
  const week = Number(m[2]);
  // Find the Thursday of the given ISO week (ISO weeks are identified by their Thursday)
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const w1Thu = new Date(jan4);
  w1Thu.setUTCDate(jan4.getUTCDate() + (4 - ((jan4.getUTCDay() || 7) - 1) - 1) % 7 - ((jan4.getUTCDay() || 7) >= 5 ? 0 : 0));
  // Simpler: Mon of W1 = Jan 4 minus its weekday offset (Mon=1)
  const w1Mon = new Date(Date.UTC(year, 0, 4));
  w1Mon.setUTCDate(w1Mon.getUTCDate() - ((w1Mon.getUTCDay() + 6) % 7));
  const targetMon = new Date(w1Mon);
  targetMon.setUTCDate(w1Mon.getUTCDate() + (week - 1) * 7 + deltaDays);
  // Convert target date back to ISO week
  const d = new Date(targetMon);
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function preferredRecipeCode(current: string, candidate: string): string {
  if (!current) return candidate;
  if (current.startsWith("FV")) return current;
  if (candidate.startsWith("FV")) return candidate;
  if (current.startsWith("FE")) return current;
  if (candidate.startsWith("FE")) return candidate;
  return current.length <= candidate.length ? current : candidate;
}

function tallyMap(source: Map<string, number>): Array<{ name: string; count: number }> {
  return Array.from(source.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de"));
}

function ensureRecipe(recipes: Map<string, TruthRecipeAccumulator>, recipeCode: string, recipeName = ""): TruthRecipeAccumulator {
  const normalizedCode = normalizeCell(recipeCode).toUpperCase();
  const digitKey = recipeDigitKey(normalizedCode);
  const existing = recipes.get(digitKey);
  if (existing) {
    if (normalizedCode) {
      existing.aliases.add(normalizedCode);
      existing.recipeCode = preferredRecipeCode(existing.recipeCode, normalizedCode);
    }
    if (recipeName && !existing.recipeName) existing.recipeName = recipeName;
    return existing;
  }
  const next: TruthRecipeAccumulator = {
    recipeCode: normalizedCode,
    recipeDigitKey: digitKey,
    recipeName,
    aliases: new Set(normalizedCode ? [normalizedCode] : []),
    forecastByMarket: { bnl: 0, nordics: 0, germany: 0 },
    forecastSlots: new Map(),
    pdlBoxCount: 0,
    pdlPortions: 0,
    pdlProductionDates: new Set(),
    pdlLanes: new Map(),
    pdlBoxSizes: new Map(),
    pdlExtras: new Map(),
  };
  recipes.set(digitKey, next);
  return next;
}

function ensureWeek(weeks: Map<string, TruthWeekAccumulator>, week: string): TruthWeekAccumulator {
  const existing = weeks.get(week);
  if (existing) return existing;
  const next: TruthWeekAccumulator = {
    week,
    recipes: new Set(),
    forecastRecipeDigits: new Set(),
    pdlRecipeDigits: new Set(),
    forecastByMarket: { bnl: 0, nordics: 0, germany: 0 },
    pdlBoxCount: 0,
    pdlPortions: 0,
    productionDates: new Set(),
  };
  weeks.set(week, next);
  return next;
}

async function fetchCsvRows(path: string): Promise<string[][]> {
  const response = await fetch(`${path}?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Quelle nicht gefunden: ${path}`);
  const text = await response.text();
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
  return parsed.data;
}

async function fetchCsvObjects(path: string): Promise<Array<Record<string, string>>> {
  const response = await fetch(`${path}?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Quelle nicht gefunden: ${path}`);
  const text = await response.text();
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  return parsed.data;
}

function parseForecastRows(rows: string[][], recipes: Map<string, TruthRecipeAccumulator>, weeks: Map<string, TruthWeekAccumulator>) {
  const headerIndex = rows.findIndex((row) => normalizeCell(row[0]) === "All Markets" && row.some((cell) => normalizeCell(cell) === "recipe code"));
  if (headerIndex < 0) return;

  const header = rows[headerIndex].map((cell) => normalizeCell(cell));
  const weekIdx = header.findIndex((cell) => cell === "week.value");
  const slotIdx = header.findIndex((cell) => cell === "slot");
  const recipeIdx = header.findIndex((cell) => cell === "recipe code");
  const bnlIdx = header.findIndex((cell) => cell === "orderSize BNL");
  const norIdx = header.findIndex((cell) => cell === "orderSize NOR");
  const deIdx = header.findIndex((cell) => cell === "orderSize DE");

  for (const row of rows.slice(headerIndex + 1)) {
    const week = normalizeCell(row[weekIdx]);
    const rawRecipeCode = normalizeCell(row[recipeIdx]);
    if (!week || !rawRecipeCode) continue;
    const recipe = ensureRecipe(recipes, rawRecipeCode);
    const weekInfo = ensureWeek(weeks, week);
    const slot = normalizeCell(row[slotIdx]);
    const bnl = parseNum(row[bnlIdx]);
    const nordics = parseNum(row[norIdx]);
    const germany = parseNum(row[deIdx]);
    const total = bnl + nordics + germany;
    if (total <= 0) continue;

    recipe.forecastByMarket.bnl += bnl;
    recipe.forecastByMarket.nordics += nordics;
    recipe.forecastByMarket.germany += germany;
    recipe.aliases.add(rawRecipeCode);
    weekInfo.recipes.add(recipe.recipeCode || rawRecipeCode);
    weekInfo.forecastRecipeDigits.add(recipe.recipeDigitKey);
    weekInfo.forecastByMarket.bnl += bnl;
    weekInfo.forecastByMarket.nordics += nordics;
    weekInfo.forecastByMarket.germany += germany;

    const slotKey = `${week}:${slot}`;
    const currentSlot = recipe.forecastSlots.get(slotKey) ?? { week, slot, bnl: 0, nordics: 0, germany: 0, total: 0 };
    currentSlot.bnl += bnl;
    currentSlot.nordics += nordics;
    currentSlot.germany += germany;
    currentSlot.total += total;
    recipe.forecastSlots.set(slotKey, currentSlot);
  }
}

function parsePdlRows(rows: Array<Record<string, string>>, source: "de" | "nor" | "daily", recipes: Map<string, TruthRecipeAccumulator>, weeks: Map<string, TruthWeekAccumulator>) {
  for (const row of rows) {
    const rawWeek = normalizeCell(row.hf_week || row.hellofresh_week);
    const mealSwap = normalizeCell(row.meal_swap);
    if (!rawWeek || !mealSwap) continue;
    // Daily Export uses production/ISO weeks; Factor_DE/Nor use HF delivery weeks (= planning week).
    // Shift daily by +7 days (1 week) so it aligns with the planning week used everywhere else.
    const week = source === "daily" ? shiftIsoWeek(rawWeek, 7) : rawWeek;
    const weekInfo = ensureWeek(weeks, week);
    const productionDate = normalizeCell(row.production_date);
    const lane = normalizeCell(row.lane_by_delivery_time);
    const boxSize = normalizeCell(row.box_size || row.cool_pouch_name);
    const extrasRaw = normalizeCell(row.extras || row.cool_pouch_name);
    const extras = extrasRaw.split(/\s*\+\s*/).map((item) => item.trim()).filter(Boolean);

    for (const token of mealSwap.split(/\s+/)) {
      const match = token.match(/^(\d+):(\d+)/);
      if (!match) continue;
      const digitToken = match[1].padStart(4, "0");
      const portions = Number.parseInt(match[2], 10);
      const recipe = ensureRecipe(recipes, digitToken);
      recipe.pdlBoxCount += 1;
      recipe.pdlPortions += Number.isFinite(portions) ? portions : 0;
      if (productionDate) recipe.pdlProductionDates.add(productionDate);
      if (lane) recipe.pdlLanes.set(lane, (recipe.pdlLanes.get(lane) ?? 0) + 1);
      if (boxSize) recipe.pdlBoxSizes.set(boxSize, (recipe.pdlBoxSizes.get(boxSize) ?? 0) + 1);
      for (const extra of extras) recipe.pdlExtras.set(extra, (recipe.pdlExtras.get(extra) ?? 0) + 1);

      weekInfo.recipes.add(recipe.recipeCode || digitToken);
      weekInfo.pdlRecipeDigits.add(recipe.recipeDigitKey);
      weekInfo.pdlBoxCount += 1;
      weekInfo.pdlPortions += Number.isFinite(portions) ? portions : 0;
      if (productionDate) weekInfo.productionDates.add(productionDate);

      if (source === "de") recipe.aliases.add(`DE-${digitToken}`);
      else if (source === "nor") recipe.aliases.add(`NOR-${digitToken}`);
      // "daily" fügt kein Alias-Präfix hinzu (gemischte DE/NOR-Quelle)
    }
  }
}

function finalize(recipes: Map<string, TruthRecipeAccumulator>, weeks: Map<string, TruthWeekAccumulator>): PlanningTruthDataset {
  const recipeEntries = Array.from(recipes.values())
    .sort((left, right) => left.recipeDigitKey.localeCompare(right.recipeDigitKey, "de"))
    .map((recipe) => {
      const aliases = Array.from(recipe.aliases).filter(Boolean).sort((a, b) => a.localeCompare(b, "de"));
      const forecastSlots = Array.from(recipe.forecastSlots.values())
        .sort((left, right) => left.week.localeCompare(right.week, "de") || left.slot.localeCompare(right.slot, "de"));
      return [recipe.recipeDigitKey, {
        recipeCode: recipe.recipeCode || recipe.recipeDigitKey,
        recipeDigitKey: recipe.recipeDigitKey,
        recipeName: recipe.recipeName,
        aliases,
        forecastTotal: recipe.forecastByMarket.bnl + recipe.forecastByMarket.nordics + recipe.forecastByMarket.germany,
        forecastByMarket: recipe.forecastByMarket,
        forecastSlots,
        pdlBoxCount: recipe.pdlBoxCount,
        pdlPortions: recipe.pdlPortions,
        pdlProductionDates: Array.from(recipe.pdlProductionDates).sort((a, b) => a.localeCompare(b, "de")),
        pdlLanes: tallyMap(recipe.pdlLanes),
        pdlBoxSizes: tallyMap(recipe.pdlBoxSizes),
        pdlExtras: tallyMap(recipe.pdlExtras),
      } satisfies PlanningTruthRecipeIntel] as const;
    });

  const weekEntries = Array.from(weeks.values())
    .sort((left, right) => left.week.localeCompare(right.week, "de"))
    .map((week) => [week.week, {
      week: week.week,
      recipes: Array.from(week.recipes).sort((a, b) => a.localeCompare(b, "de")),
      forecastTotal: week.forecastByMarket.bnl + week.forecastByMarket.nordics + week.forecastByMarket.germany,
      forecastByMarket: week.forecastByMarket,
      pdlBoxCount: week.pdlBoxCount,
      pdlPortions: week.pdlPortions,
      forecastRecipeCount: week.forecastRecipeDigits.size,
      pdlRecipeCount: week.pdlRecipeDigits.size,
      productionDates: Array.from(week.productionDates).sort((a, b) => a.localeCompare(b, "de")),
    } satisfies PlanningTruthWeekIntel] as const);

  return {
    recipesByDigit: Object.fromEntries(recipeEntries),
    weeks: Object.fromEntries(weekEntries),
  };
}

// ─── Factor Daily Meta ────────────────────────────────────────────────────────

export interface FactorDailyMeta {
  week: string;
  sourceFile: string;
  downloadedAt: string;
  rowCount: number;
}

let factorDailyMetaPromise: Promise<FactorDailyMeta | null> | null = null;

export function loadFactorDailyMeta(): Promise<FactorDailyMeta | null> {
  if (!factorDailyMetaPromise) {
    factorDailyMetaPromise = fetch(`/data/factor-daily-meta.json?ts=${Date.now()}`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<FactorDailyMeta>) : null))
      .catch(() => null);
  }
  return factorDailyMetaPromise;
}

// ─── Dataset laden ────────────────────────────────────────────────────────────

export function loadPlanningTruthDataset(): Promise<PlanningTruthDataset> {
  if (!planningTruthPromise) {
    planningTruthPromise = Promise.all([
      fetchCsvRows("/data/gsheet-truth-export/Running Forecast - All Markets.csv"),
      fetchCsvObjects("/data/gsheet-truth-export/Factor_DE - PDL Forecast.csv"),
      fetchCsvObjects("/data/gsheet-truth-export/Factor_Nor - PDL Forecast.csv"),
      // Factor Daily: wird täglich um 07:30 per sync:factor:forecast aktualisiert.
      // Graceful fallback auf [] wenn noch kein Download stattgefunden hat.
      fetchCsvObjects("/data/gsheet-truth-export/Factor_Daily - PDL Forecast.csv").catch(() => []),
    ]).then(([forecastRows, pdlDeRows, pdlNorRows, pdlDailyRows]) => {
      const recipes = new Map<string, TruthRecipeAccumulator>();
      const weeks = new Map<string, TruthWeekAccumulator>();
      parseForecastRows(forecastRows, recipes, weeks);
      parsePdlRows(pdlDeRows, "de", recipes, weeks);
      parsePdlRows(pdlNorRows, "nor", recipes, weeks);
      if (pdlDailyRows.length > 0) {
        parsePdlRows(pdlDailyRows, "daily", recipes, weeks);
        console.log(`[PlanningTruth] Factor Daily geladen: ${pdlDailyRows.length} Zeilen`);
      }
      return finalize(recipes, weeks);
    });
  }
  return planningTruthPromise;
}