import Papa from "papaparse";

export type RackMarket = "de" | "nordics";

export type RackEntry = {
  id: string;
  recipe: string;
  line: string;
  flowRackPosition: string;
  quantity: number;
  sku: string;
  ingredient: string;
  scanRegEx: string;
  labelPos: string;
  uniCode: string;
  displayName: string;
  gramage: string;
  sort: number;
  source: "rackfile" | "multiline" | "manual";
  /** Optionale Etage im Pickface: 1 = unten, 2 = mitte, 3 = oben.
   *  Wird vom Rack-v2-Auto-Fill gesetzt; legacy Quellen lassen sie undefined. */
  tier?: 1 | 2 | 3;
};

export type RackValidationIssue = {
  severity: "error" | "warning" | "info";
  message: string;
};

export type RackValidationResult = {
  ok: boolean;
  issues: RackValidationIssue[];
};

export type RackBoxSnapshot = {
  mealIds: Set<string>;
  loyaltyIds: Set<string>;
  giftIds: Set<string>;
  iceIds: Set<string>;
  coolPouches: Set<string>;
  boxSizes: Set<string>;
};

export const RACK_MARKET_PROFILES: Record<RackMarket, { sheet: string; lines: string[]; boxPrefix: string }> = {
  de: {
    sheet: "static exportP2L - DACH",
    lines: ["ASL3", "ASL4"],
    boxPrefix: "TZ",
  },
  nordics: {
    sheet: "static exportP2L - Nordics",
    lines: ["ASL1", "ASL5"],
    boxPrefix: "TK",
  },
};

const RECIPE_ALIASES: Record<string, string> = {
  "805_1p": "205_1p",
  "806_1p": "206_1p",
  "809_1p": "209_1p",
  "810_1p": "210_1p",
};

function asString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function asInt(value: unknown, fallback = 1): number {
  const normalized = asString(value).replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export function normalizeRecipeId(recipeId: string): string {
  return RECIPE_ALIASES[recipeId] ?? recipeId;
}

export function sortKey(flowRackPosition: string): number {
  const match = /^F(\d+)$/i.exec(flowRackPosition.trim());
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function deriveEntryKind(entry: RackEntry): "meal" | "packaging" | "ice" | "loyalty" | "beverage" | "protein" | "other" {
  if (entry.sku === "IcePack" || /^Ice\d+/i.test(entry.recipe)) return "ice";
  if (entry.sku === "Loyalties") return "loyalty";
  if (/Factor Box|Factor Liner|^XS$|^S$|^M$|^L$/i.test(entry.recipe) || /^Factor Box|^Factor Liner/.test(entry.sku)) return "packaging";
  if (/^BEV-/i.test(entry.sku)) return "beverage";
  if (/^PTN-/i.test(entry.sku)) return "protein";
  if (/^CON-/i.test(entry.sku) || /^\d+_\dp$/i.test(entry.recipe)) return "meal";
  return "other";
}

function buildRackEntry(base: Partial<RackEntry> & Pick<RackEntry, "recipe" | "line" | "flowRackPosition">): RackEntry {
  const flowRackPosition = asString(base.flowRackPosition);
  const labelPos = base.labelPos && base.labelPos.length > 0 ? base.labelPos : `${base.line}${flowRackPosition}`;
  const recipe = normalizeRecipeId(asString(base.recipe));
  const portionSuffix = recipe.includes("_") ? recipe.split("_", 2)[1] : "";
  return {
    id: `${base.line}:${flowRackPosition}:${recipe}:${crypto.randomUUID()}`,
    recipe,
    line: asString(base.line),
    flowRackPosition,
    quantity: base.quantity ?? 1,
    sku: asString(base.sku),
    ingredient: asString(base.ingredient),
    scanRegEx: asString(base.scanRegEx),
    labelPos,
    uniCode: base.uniCode && base.uniCode.length > 0 ? base.uniCode : `${labelPos}${portionSuffix}`,
    displayName: asString(base.displayName || base.ingredient),
    gramage: asString(base.gramage),
    sort: base.sort ?? sortKey(flowRackPosition),
    source: base.source ?? "manual",
  };
}

export async function parseRackfileCsv(file: File): Promise<RackEntry[]> {
  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  return parsed.data
    .filter((row) => asString(row.Recipe) && asString(row.FlowRackPosition))
    .map((row) => buildRackEntry({
      recipe: row.Recipe,
      line: row.Line,
      flowRackPosition: row.FlowRackPosition,
      quantity: asInt(row.Quantity, 1),
      sku: row.SKU,
      ingredient: row.Ingredient,
      scanRegEx: row.ScanRegEx,
      labelPos: row.LabelPos,
      uniCode: row.UniCode,
      displayName: row.DisplayName,
      gramage: row.Gramage,
      sort: asInt(row.Sort, sortKey(asString(row.FlowRackPosition))),
      source: "rackfile",
    }));
}

export async function parseMultilineExcel(file: File, market: RackMarket, lines?: string[]): Promise<RackEntry[]> {
  const exceljs = await import("exceljs");
  const WorkbookClass = exceljs.Workbook || (exceljs as any).default?.Workbook;
  const workbook = new WorkbookClass();
  await workbook.xlsx.load(await file.arrayBuffer());

  const profile = RACK_MARKET_PROFILES[market];
  const worksheet = workbook.getWorksheet(profile.sheet);
  if (!worksheet) {
    throw new Error(`Sheet fehlt: ${profile.sheet}`);
  }

  const headerRow = worksheet.getRow(1);
  const headerMap = new Map<string, number>();
  headerRow.eachCell((cell, colNumber) => {
    headerMap.set(asString(cell.value), colNumber);
  });

  const targetLines = lines && lines.length > 0 ? lines : profile.lines;
  const out: RackEntry[] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const recipe = asString(row.getCell(headerMap.get("Recipe") ?? 1).value);
    const ingredient = asString(row.getCell(headerMap.get("Ingredient") ?? 2).value);
    const sku = asString(row.getCell(headerMap.get("SKU") ?? 3).value);
    const flowRackPosition = asString(row.getCell(headerMap.get("FlowRackPosition") ?? 5).value);
    const quantity = asInt(row.getCell(headerMap.get("Quantity") ?? 6).value, 1);
    const scanRegEx = asString(row.getCell(headerMap.get("ScanRegEx") ?? 7).value);
    if (!recipe || !flowRackPosition) continue;

    for (const line of targetLines) {
      out.push(buildRackEntry({
        recipe,
        line,
        flowRackPosition,
        quantity,
        sku,
        ingredient,
        scanRegEx,
        displayName: ingredient,
        source: "multiline",
      }));
    }
  }

  return out.sort((a, b) => a.line.localeCompare(b.line) || a.sort - b.sort || a.recipe.localeCompare(b.recipe));
}

export async function parsePdlCsv(file: File, weekFilter?: string): Promise<Set<string>> {
  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const ids = new Set<string>();
  for (const row of parsed.data) {
    // Wenn weekFilter angegeben, nur Zeilen der aktuellen Woche auswerten
    if (weekFilter) {
      const rowWeek = asString(row.hf_week);
      if (rowWeek !== weekFilter) continue;
    }
    const mealSwap = asString(row.meal_swap);
    for (const token of mealSwap.split(/\s+/)) {
      const match = token.match(/^(\d+):/);
      if (match) ids.add(normalizeRecipeId(`${match[1]}_1p`));
    }
  }
  return ids;
}

/**
 * Filtert Einträge auf PDL-aktive Mahlzeiten + alle Nicht-Mahlzeit-Einträge (Verpackung, Ice usw.).
 * Wird nur angewendet wenn pdlIds nicht leer ist (Sicherheits-Fallback).
 */
export function applyPdlFilter(entries: RackEntry[], pdlIds: Set<string>): RackEntry[] {
  if (pdlIds.size === 0) return entries;
  return entries.filter((e) => {
    const kind = deriveEntryKind(e);
    if (kind === "meal") return pdlIds.has(e.recipe);
    return true; // Verpackung, Ice, Loyalty, Beverage, Protein behalten
  });
}

export async function parseBoxfileCsv(file: File): Promise<RackBoxSnapshot> {
  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const mealIds = new Set<string>();
  const loyaltyIds = new Set<string>();
  const giftIds = new Set<string>();
  const iceIds = new Set<string>();
  const coolPouches = new Set<string>();
  const boxSizes = new Set<string>();

  function collectMealIds(raw: string) {
    const normalized = asString(raw);
    if (!normalized) return;
    for (const match of normalized.matchAll(/(\d+_\dp)/g)) {
      mealIds.add(normalizeRecipeId(match[1]));
    }
    for (const match of normalized.matchAll(/-(\d{3})-/g)) {
      mealIds.add(normalizeRecipeId(`${match[1]}_1p`));
    }
    for (const match of normalized.matchAll(/(\d{3}):/g)) {
      mealIds.add(normalizeRecipeId(`${match[1]}_1p`));
    }
  }

  for (const row of parsed.data) {
    collectMealIds(row.Recipes ?? "");
    collectMealIds((row as Record<string, string>)["RecipeCards"] ?? "");
    collectMealIds((row as Record<string, string>)["meal_swap"] ?? "");
    collectMealIds((row as Record<string, string>)["meal_swap_dash"] ?? "");

    const loyalty = asString(row.loyalty);
    for (const match of loyalty.matchAll(/([A-Z]{2,}\d+)/g)) loyaltyIds.add(match[1]);

    const gift = asString(row.Gift);
    for (const match of gift.matchAll(/([A-Z]{2,}\d+)/g)) giftIds.add(match[1]);

    const ice = asString(row.Ice);
    if (ice) iceIds.add(ice);

    const coolPouch = asString(row.Coolpouch1);
    if (coolPouch) coolPouches.add(coolPouch);

    const boxSize = asString(row.BoxSize);
    if (boxSize) boxSizes.add(boxSize);
  }

  return { mealIds, loyaltyIds, giftIds, iceIds, coolPouches, boxSizes };
}

export async function parseCo2Csv(file: File, boxPrefix?: string): Promise<Set<string>> {
  const ids = new Set<string>();

  function collectFromText(raw: string) {
    const value = asString(raw);
    if (!value) return;
    for (const match of value.matchAll(/(\d+_\dp)/g)) ids.add(normalizeRecipeId(match[1]));
    for (const match of value.matchAll(/-(\d{3})-/g)) ids.add(normalizeRecipeId(`${match[1]}_1p`));
    for (const match of value.matchAll(/(\d{3}):/g)) ids.add(normalizeRecipeId(`${match[1]}_1p`));
  }

  const lowerName = String(file.name ?? "").toLowerCase();
  if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xlsm")) {
    const exceljs = await import("exceljs");
    const WorkbookClass = exceljs.Workbook || (exceljs as any).default?.Workbook;
    const workbook = new WorkbookClass();
    await workbook.xlsx.load(await file.arrayBuffer());
    for (const worksheet of workbook.worksheets) {
      const headerRow = worksheet.getRow(1);
      const headerMap = new Map<string, number>();
      headerRow.eachCell((cell, colNumber) => {
        headerMap.set(asString(cell.value).toLowerCase(), colNumber);
      });

      const boxIdCol = headerMap.get("boxid")
        ?? headerMap.get("box_id")
        ?? headerMap.get("box id")
        ?? 0;
      const mealSwapDashCol = headerMap.get("meal_swap_dash")
        ?? headerMap.get("meal swap dash")
        ?? 0;
      const mealSwapCol = headerMap.get("meal_swap")
        ?? headerMap.get("meal swap")
        ?? 0;

      for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const row = worksheet.getRow(rowNumber);
        const boxId = boxIdCol > 0 ? asString(row.getCell(boxIdCol).value) : "";
        if (boxPrefix && boxId && !boxId.startsWith(boxPrefix)) continue;
        if (mealSwapDashCol > 0) collectFromText(asString(row.getCell(mealSwapDashCol).value));
        if (mealSwapCol > 0) collectFromText(asString(row.getCell(mealSwapCol).value));
      }
    }
    return ids;
  }

  const text = await file.text();
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.includes(";") ? ";" : ",";
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    delimiter,
  });
  for (const row of parsed.data) {
    const boxId = asString(row.boxid || row.box_id || (row as Record<string, string>)["Box ID"]);
    if (boxPrefix && boxId && !boxId.startsWith(boxPrefix)) continue;
    collectFromText(asString(row.meal_swap_dash || row.meal_swap || (row as Record<string, string>)["Meal Swap Dash"]));
  }
  return ids;
}

export type BoxfileVolumes = {
  picks: Map<string, number>;
  boxCount: number;
};

/** Parst VE-TZ.csv oder VE-TK-TV.csv und zählt Picks pro Rezept (High-Runner-Ranking). */
export async function parseBoxfileForVolumes(file: File): Promise<BoxfileVolumes> {
  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const picks = new Map<string, number>();
  for (const row of parsed.data) {
    const src = asString(row.Recipes || row.RecipeCards);
    if (!src) continue;
    for (const token of src.split('+')) {
      const id = normalizeRecipeId(token.trim());
      if (/^\d+_\d+p$/.test(id)) {
        picks.set(id, (picks.get(id) ?? 0) + 1);
      }
    }
  }
  return { picks, boxCount: parsed.data.length };
}

// Feste Loyalty-Artikel je Markt (ändern sich nur bei Loyalty-Programmwechsel)
const DE_LOYALTY_ITEMS: Array<{ recipe: string; ingredient: string }> = [
  { recipe: "FLA1", ingredient: "FA-DE Hydroflask" },
  { recipe: "FLY4", ingredient: "FA-DE Flyer 4. Box" },
  { recipe: "FLY3", ingredient: "FA-DE Flyer 3. Box" },
  { recipe: "SOC1", ingredient: "FA-DE Socks" },
  { recipe: "BAG1", ingredient: "FA-DE Tote Bag" },
  { recipe: "FLY2", ingredient: "FA-DE Flyer 2. Box" },
  { recipe: "FLY1", ingredient: "FA-DE Flyer 1. Box" },
  { recipe: "WB1",  ingredient: "FA-DE Welcome Booklet" },
  { recipe: "FR1",  ingredient: "FA-DE Freebies" },
  { recipe: "DUF1", ingredient: "FA-DE Duffel Bag" },
];
const NORDICS_LOYALTY_ITEMS: Array<{ recipe: string; ingredient: string }> = [
  { recipe: "NPS1", ingredient: "FA-DK Trust Pilot Flyer (TK)" },
  { recipe: "WB1", ingredient: "FA-Nordics Welcome Booklet" },
  { recipe: "FR1", ingredient: "FA-NO Freebies" },
];

function skuFromRecipeId(recipeId: string): string {
  const match = /^(\d+)_\d+p$/.exec(recipeId);
  if (!match) return recipeId;
  const num = parseInt(match[1], 10);
  if (num === 206 || num === 706) return `PTN-${recipeId}`;
  if ((num >= 200 && num < 300) || (num >= 700 && num < 800)) return `BEV-${recipeId}`;
  return `CON-${recipeId}`;
}

function makePoolEntry(recipe: string, quantity: number, sku: string, ingredient?: string): RackEntry {
  const r = normalizeRecipeId(recipe);
  return {
    id: `pool:${r}:${String(Math.random()).slice(2)}`,
    recipe: r,
    line: "",
    flowRackPosition: "",
    quantity,
    sku,
    ingredient: ingredient ?? r,
    scanRegEx: "",
    labelPos: "",
    uniCode: r,
    displayName: r,
    gramage: "",
    sort: 0,
    source: "manual",
  };
}

export type BoxfilePoolResult = {
  entries: RackEntry[];
  volumes: Map<string, number>;
  boxCount: number;
  isNordics: boolean;
};

/**
 * Baut den vollständigen Rack-Pool direkt aus einer Boxfile (VE-TZ.csv oder VE-TK-TV.csv).
 * Kein separater P2L-Export nötig.
 */
export async function buildPoolFromBoxfile(file: File): Promise<BoxfilePoolResult> {
  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });

  const volumes = new Map<string, number>();
  const iceTypes = new Set<string>();
  const boxSizes = new Set<string>();
  const linerTypes = new Set<string>();

  for (const row of parsed.data) {
    const src = asString(row.Recipes || row.RecipeCards);
    for (const token of src.split('+')) {
      const id = normalizeRecipeId(token.trim());
      if (/^\d+_\d+p$/.test(id)) volumes.set(id, (volumes.get(id) ?? 0) + 1);
    }
    const ice = asString(row.Ice).trim();
    if (ice) iceTypes.add(ice);
    const boxSize = asString(row.BoxSize).trim();
    if (boxSize) boxSizes.add(boxSize);
    const liner = asString(row.Coolpouch1).trim();
    if (liner) linerTypes.add(liner);
  }

  const isNordics = [...volumes.keys()].some(id => /^6\d\d_/.test(id));
  const entries: RackEntry[] = [];

  for (const [recipe, picks] of volumes) {
    entries.push(makePoolEntry(recipe, picks, skuFromRecipeId(recipe)));
  }
  for (const ice of iceTypes) {
    entries.push(makePoolEntry(ice, 1, "IcePack"));
  }
  for (const boxSize of boxSizes) {
    entries.push(makePoolEntry(boxSize, 1, boxSize));
  }
  for (const liner of linerTypes) {
    entries.push(makePoolEntry(liner, 1, liner));
  }
  for (const { recipe, ingredient } of (isNordics ? NORDICS_LOYALTY_ITEMS : DE_LOYALTY_ITEMS)) {
    entries.push(makePoolEntry(recipe, 1, "Loyalties", ingredient));
  }

  return { entries, volumes, boxCount: parsed.data.length, isNordics };
}

export function lineSlotRange(entries: RackEntry[], line: string): number[] {
  const positions = entries
    .filter((entry) => entry.line === line)
    .map((entry) => entry.sort)
    .filter((value) => Number.isFinite(value) && value < Number.MAX_SAFE_INTEGER);
  if (positions.length === 0) return [];
  const min = Math.min(...positions);
  const max = Math.max(...positions);
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

export function exportRackfileCsv(entries: RackEntry[]): string {
  const ordered = [...entries].sort((a, b) => a.line.localeCompare(b.line) || a.sort - b.sort || a.recipe.localeCompare(b.recipe));
  const header = ["Recipe", "Line", "FlowRackPosition", "Quantity", "SKU", "Ingredient", "ScanRegEx", "LabelPos", "UniCode", "DisplayName", "Gramage", "Sort"];
  const escape = (value: unknown) => {
    const text = String(value ?? "");
    if (text.includes(",") || text.includes("\n") || text.includes("\"")) {
      return `"${text.replaceAll("\"", "\"\"")}"`;
    }
    return text;
  };
  return `${header.join(",")}\n${ordered.map((entry) => [
    entry.recipe,
    entry.line,
    entry.flowRackPosition,
    entry.quantity,
    entry.sku,
    entry.ingredient,
    entry.scanRegEx,
    entry.labelPos,
    entry.uniCode,
    entry.displayName,
    entry.gramage,
    entry.sort,
  ].map(escape).join(",")).join("\n")}\n`;
}

export function validateRackPlan(entries: RackEntry[], options?: { pdlIds?: Set<string>; boxfile?: RackBoxSnapshot; co2MealIds?: Set<string> }): RackValidationResult {
  const issues: RackValidationIssue[] = [];
  const groupedByUniCode = new Map<string, RackEntry[]>();
  const groupedBySlot = new Map<string, RackEntry[]>();

  for (const entry of entries) {
    if (!entry.recipe) issues.push({ severity: "error", message: `Recipe fehlt bei ${entry.line}/${entry.flowRackPosition}` });
    if (!/^F\d+$/i.test(entry.flowRackPosition)) issues.push({ severity: "error", message: `Ungültiger Rackplatz: ${entry.flowRackPosition}` });

    const uniBucket = groupedByUniCode.get(entry.uniCode) ?? [];
    uniBucket.push(entry);
    groupedByUniCode.set(entry.uniCode, uniBucket);

    const slotKey = `${entry.line}:${entry.flowRackPosition}`;
    const slotBucket = groupedBySlot.get(slotKey) ?? [];
    slotBucket.push(entry);
    groupedBySlot.set(slotKey, slotBucket);
  }

  for (const [uniCode, bucket] of groupedByUniCode.entries()) {
    if (bucket.length < 2) continue;
    const onlyIce = bucket.every((entry) => deriveEntryKind(entry) === "ice");
    if (onlyIce) {
      // Geteilter UniCode für IcePack ist erlaubt und Standard (z. B. 3er-Eis) – kein Hinweis nötig.
      continue;
    }
    issues.push({ severity: "error", message: `Duplikat UniCode: ${uniCode}` });
  }

  for (const [slotKey, bucket] of groupedBySlot.entries()) {
    const nonIce = bucket.filter((entry) => deriveEntryKind(entry) !== "ice");
    if (nonIce.length > 1) {
      issues.push({
        severity: "error",
        message: `Mehrfachbelegung in ${slotKey}: ${nonIce.map((entry) => entry.recipe).join(", ")}. Ein Fach darf nur einmal belegt sein.`,
      });
    }
  }

  const rackMealIds = new Set(entries.filter((entry) => /^\d+_\dp$/i.test(entry.recipe)).map((entry) => normalizeRecipeId(entry.recipe)));
  const rackRecipes = new Set(entries.map((entry) => entry.recipe));

  if (options?.pdlIds) {
    for (const recipeId of [...rackMealIds].sort()) {
      if (!options.pdlIds.has(recipeId)) issues.push({ severity: "warning", message: `Recipe im Rackfile aber nicht in PDL: ${recipeId}` });
    }
    for (const recipeId of [...options.pdlIds].sort()) {
      if (!rackMealIds.has(recipeId)) issues.push({ severity: "warning", message: `Recipe in PDL aber nicht im Rackfile: ${recipeId}` });
    }
  }

  if (options?.boxfile) {
    for (const recipeId of [...options.boxfile.mealIds].sort()) {
      if (!rackMealIds.has(recipeId)) issues.push({ severity: "error", message: `Boxfile-Recipe fehlt im Rackfile: ${recipeId}` });
    }
    for (const ice of [...options.boxfile.iceIds].sort()) {
      if (!rackRecipes.has(ice)) issues.push({ severity: "error", message: `Ice aus Boxfile fehlt im Rackfile: ${ice}` });
    }
    for (const loyalty of [...options.boxfile.loyaltyIds].sort()) {
      if (!rackRecipes.has(loyalty)) issues.push({ severity: "warning", message: `Loyalty aus Boxfile fehlt im Rackfile: ${loyalty}` });
    }
    for (const gift of [...options.boxfile.giftIds].sort()) {
      if (!rackRecipes.has(gift)) issues.push({ severity: "warning", message: `Gift aus Boxfile fehlt im Rackfile: ${gift}` });
    }
    for (const box of [...options.boxfile.boxSizes].sort()) {
      if (!rackRecipes.has(box)) issues.push({ severity: "warning", message: `BoxSize aus Boxfile fehlt im Rackfile: ${box}` });
    }
    for (const pouch of [...options.boxfile.coolPouches].sort()) {
      const exists = [...rackRecipes].some((recipe) => recipe === pouch || recipe.startsWith(pouch));
      if (!exists) issues.push({ severity: "warning", message: `Coolpouch aus Boxfile fehlt im Rackfile: ${pouch}` });
    }
  }

  if (options?.co2MealIds) {
    for (const recipeId of [...options.co2MealIds].sort()) {
      if (!rackMealIds.has(recipeId)) issues.push({ severity: "error", message: `CO2-Recipe fehlt im Rackfile: ${recipeId}` });
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

export function updateRackEntry(entries: RackEntry[], entryId: string, patch: Partial<Pick<RackEntry, "line" | "flowRackPosition" | "quantity">>): RackEntry[] {
  return entries.map((entry) => {
    if (entry.id !== entryId) return entry;
    const line = patch.line ?? entry.line;
    const flowRackPosition = patch.flowRackPosition ?? entry.flowRackPosition;
    const sort = sortKey(flowRackPosition);
    const labelPos = `${line}${flowRackPosition}`;
    const suffix = entry.recipe.includes("_") ? entry.recipe.split("_", 2)[1] : "";
    return {
      ...entry,
      line,
      flowRackPosition,
      quantity: patch.quantity ?? entry.quantity,
      sort,
      labelPos,
      uniCode: suffix ? `${labelPos}${suffix}` : labelPos,
    };
  });
}

export function rackSummary(entries: RackEntry[]) {
  const counts = {
    meal: 0,
    packaging: 0,
    ice: 0,
    loyalty: 0,
    beverage: 0,
    protein: 0,
    other: 0,
  };
  for (const entry of entries) counts[deriveEntryKind(entry)] += 1;
  return counts;
}

export function uniqueRackLines(entries: RackEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.line))].sort((a, b) => a.localeCompare(b));
}

type RackTemplateItem = Omit<RackEntry, "id" | "line" | "labelPos" | "uniCode" | "sort"> & {
  flowRackPosition: string;
};

function collapseRackTemplate(entries: RackEntry[]): RackTemplateItem[] {
  const unique = new Map<string, RackTemplateItem>();
  for (const entry of entries) {
    const key = [
      entry.recipe,
      entry.flowRackPosition,
      entry.quantity,
      entry.sku,
      entry.ingredient,
      entry.displayName,
      entry.scanRegEx,
      entry.gramage,
      entry.source,
    ].join("|");
    if (!unique.has(key)) {
      unique.set(key, {
        recipe: entry.recipe,
        flowRackPosition: entry.flowRackPosition,
        quantity: entry.quantity,
        sku: entry.sku,
        ingredient: entry.ingredient,
        scanRegEx: entry.scanRegEx,
        displayName: entry.displayName,
        gramage: entry.gramage,
        source: entry.source,
      });
    }
  }
  return [...unique.values()].sort((a, b) => sortKey(a.flowRackPosition) - sortKey(b.flowRackPosition) || a.recipe.localeCompare(b.recipe));
}

export function projectRackEntriesToLines(entries: RackEntry[], targetLines: string[]): RackEntry[] {
  const template = collapseRackTemplate(entries);
  const out: RackEntry[] = [];
  for (const line of targetLines) {
    for (const item of template) {
      out.push(buildRackEntry({
        recipe: item.recipe,
        line,
        flowRackPosition: item.flowRackPosition,
        quantity: item.quantity,
        sku: item.sku,
        ingredient: item.ingredient,
        scanRegEx: item.scanRegEx,
        displayName: item.displayName,
        gramage: item.gramage,
        source: item.source,
      }));
    }
  }
  return out.sort((a, b) => a.line.localeCompare(b.line) || a.sort - b.sort || a.recipe.localeCompare(b.recipe));
}