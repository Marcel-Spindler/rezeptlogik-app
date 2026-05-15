// Liest die XLSX (Meal Selection) und die CSVs aus dem konfigurierten
// Rezeptlogik-Quellordner und schreibt eine konsolidierte public/data/data.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import Papa from "papaparse";
import ExcelJS from "exceljs";
import type {
  DataBundle, Market, WeekRecipe, Recipe,
  GrossIngredient, CookSchedule,
  RecipeStructure, DetailedSubRecipe, ShelfLifeInfo
} from "../src/types.ts";
import { readOpenShelfLifeSheet } from "./read-open-shelf.ts";

// Detaillierte Sub-Rezept CSVs: werden automatisch per Glob aus SOURCE_DIR erkannt.
// Alle Dateien "export-sub-recipes-by-recipe-detailed*.csv" werden zusammengeführt.
// Neue Exporte (z. B. (4), (5) …) werden automatisch eingeschlossen.
function findDetailedCsvs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^export-sub-recipes-by-recipe-detailed.*\.csv$/i.test(f))
    .sort()
    .map(f => f);
}

// Kombinierter Recipes-Export: neueste Datei "export-recipes (N).csv" oder Basis-Datei
function findCombinedRecipeCsv(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter(f => /^export-recipes.*\.csv$/i.test(f))
    .sort();
  // Höchste Nummer gewinnt; bei Gleichstand alphabetisch letztes
  return files.at(-1) ?? null;
}

// Aggregiertes Gross-Ingredients-CSV (Vorrang vor Per-Markt-Dateien)
const AGGREGATED_GROSS_CSV = "export-gross-aggregated-ingredients-by-recipe.csv";

function resolveSourceDir(): string {
  const configured = process.env.REZEPTLOGIK_SOURCE_DIR?.trim();
  if (configured) return configured;

  const candidates = [
    "C:\\Rezeptlogik",
    resolve("Rezeptlogik"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, XLSX_FILE))) return candidate;
  }

  return candidates[0];
}

const OUT_DIR = resolve("public", "data");
const OUT_FILE = join(OUT_DIR, "data.json");

const XLSX_FILE = "F_EU - 2026 Ramp Up Planning V2.0 (1).xlsx";
const COOK_CSV = "Cook Schedules Per DC - Cook Shifts per DC.csv";
const SOURCE_DIR = resolveSourceDir();

// CSV-Mapping nach Markt (gemäß Inhalt: (1)=BNL, (2)=DE, (3)=DKSE)
const RECIPE_CSVS: Record<Market, string> = {
  BENL: "export-recipes (1).csv",
  DE:   "export-recipes (2).csv",
  DKSE: "export-recipes (3).csv"
};
const GROSS_CSVS: Record<Market, string> = {
  BENL: "export-gross-ingredients-and-sub-recipes-by-recipe (1).csv",
  DE:   "export-gross-ingredients-and-sub-recipes-by-recipe (2).csv",
  DKSE: "export-gross-ingredients-and-sub-recipes-by-recipe (3).csv"
};

// ---------- Helpers ----------
function readCsv<T = Record<string, string>>(path: string): T[] {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const res = Papa.parse<T>(text, { header: true, skipEmptyLines: true });
  if (res.errors.length) console.warn(`CSV warnings ${path}:`, res.errors.slice(0, 3));
  return res.data as T[];
}

// ExcelJS liefert Formel-Zellen als { result, formula, ... } — Wert daraus extrahieren.
function cellVal(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === "object" && v !== null && "result" in (v as any)) return (v as any).result;
  if (typeof v === "object" && v !== null && "richText" in (v as any)) {
    return (v as any).richText.map((t: any) => t.text).join("");
  }
  return v;
}
function str(v: unknown): string {
  const x = cellVal(v);
  return x == null ? "" : String(x).trim();
}
function num(v: unknown): number {
  const x = cellVal(v);
  if (x == null || x === "") return 0;
  const n = typeof x === "number" ? x : parseFloat(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

// "FE0628B - Mushroom Chicken & Wild Rice [BNL]" -> { code: "FE0628B", base: "Mushroom Chicken & Wild Rice" }
// "FV1646A Lemon Garlic Shrimp & Spanakopita Rice DKSE" -> { code: "FV1646A", base: "Lemon Garlic Shrimp & Spanakopita Rice" }
function parseRecipeName(full: string): { code: string; base: string } {
  const m = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s*-\s*(.+?)(?:\s*\[(?:BNL|BENL|DE|DKSE|NORD)\])?\s*$/.exec(full);
  if (m) return { code: m[1], base: m[2].trim() };
  const suffix = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s+(.+?)\s+(?:BNL|BENL|DE|DKSE|NORD)\s*$/i.exec(full);
  if (suffix) return { code: suffix[1], base: suffix[2].trim() };
  const plain = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s+(.+?)\s*$/.exec(full);
  if (plain) return { code: plain[1], base: plain[2].trim() };
  return { code: full, base: full };
}

// Kern-Schlüssel: nur die 4-stellige Nummer (z. B. "FE0972B" und "FV0972A" -> "0972").
// Damit lassen sich Meal-Selection-Codes (FE…) und Verden-Produktions-Codes (FV…)
// trotz unterschiedlichem Prefix / Trailing-Letter zusammenführen.
function digitKey(code: string): string {
  const m = /(\d{4,5})/.exec(code);
  return m ? m[1] : code;
}

// ---------- 1) Meal Selection (XLSX) ----------
async function loadMealSelection(): Promise<{ weekRecipes: WeekRecipe[]; weeks: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(SOURCE_DIR, XLSX_FILE));
  const ws = wb.getWorksheet("Meal Selection");
  if (!ws) throw new Error("Sheet 'Meal Selection' nicht gefunden");

  // Header in Zeile 2 — Spalten gemäß Analyse:
  // 1 HF Week | 2 Code | 3 Preference | 4 Recipe Name | 5 Week
  // 6 Slot BENL | 7 Slot DKSE | 8 Slot DE
  // 9 BENL Vol | 10 NORD Vol | 11 DE Vol | 12 Convini DE
  // 13 Total Vol BNL | 14 Total Vol NORD | 15 Total Vol DE
  // 16 Verden Share BENL | 17 DKSE | 18 DE
  // 19 Verden Absolute BENL | 20 NORD | 21 DE
  // 22 Total Verden Volume | 23 Locked Values | 24 Production Buffer
  const out: WeekRecipe[] = [];
  const weekSet = new Set<string>();

  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const hfWeek = str(row.getCell(1).value);
    const code = str(row.getCell(2).value);
    if (!hfWeek || !code) continue;
    if (!/^\d{4}-W\d{2}$/.test(hfWeek)) continue;

    const recipeName = str(row.getCell(4).value);
    const preference = str(row.getCell(3).value);
    const verdenAbsBENL = num(row.getCell(19).value);
    const verdenAbsNORD = num(row.getCell(20).value);   // = DKSE
    const verdenAbsDE   = num(row.getCell(21).value);
    const total = num(row.getCell(22).value);

    out.push({
      hfWeek,
      weekShort: hfWeek.slice(5),
      code,
      recipeName,
      preference,
      slot: {
        BENL: num(row.getCell(6).value) || undefined,
        DKSE: num(row.getCell(7).value) || undefined,
        DE:   num(row.getCell(8).value) || undefined
      },
      verdenVolume: { BENL: verdenAbsBENL, DKSE: verdenAbsNORD, DE: verdenAbsDE },
      totalVerdenVolume: total || (verdenAbsBENL + verdenAbsNORD + verdenAbsDE),
      productionBuffer: num(row.getCell(24).value)
    });
    weekSet.add(hfWeek);
  }

  const weeks = [...weekSet].sort();
  return { weekRecipes: out, weeks };
}

// ---------- 2) Recipes (CSV je Markt oder kombiniert) ----------
function detectMarket(fullName: string): Market | null {
  if (/\[BNL\]|\[BENL\]/i.test(fullName)) return "BENL";
  if (/\[DKSE\]|\[NORD\]/i.test(fullName)) return "DKSE";
  if (/\[DE\]/i.test(fullName)) return "DE";
  if (/\s(BNL|BENL)\s*$/i.test(fullName)) return "BENL";
  if (/\s(DKSE|NORD)\s*$/i.test(fullName)) return "DKSE";
  if (/\sDE\s*$/i.test(fullName)) return "DE";
  return null;
}

function loadRecipes(): Record<string, Recipe> {
  const recipes: Record<string, Recipe> = {};

  const combinedFile = findCombinedRecipeCsv(SOURCE_DIR);
  const combinedPath = combinedFile ? join(SOURCE_DIR, combinedFile) : null;
  const usesCombined = combinedPath !== null && existsSync(combinedPath);

  if (usesCombined) {
    console.log(`  Kombiniertes CSV: ${combinedFile}`);
  }

  function processRecipeRows(rows: Record<string, string>[], fixedMarket?: Market) {
    for (const row of rows) {
      const fullName = row["Recipe name"] ?? "";
      const { code, base } = parseRecipeName(fullName);
      if (!code) continue;
      const market = fixedMarket ?? detectMarket(fullName);
      if (!market) continue;

      if (!recipes[code]) {
        recipes[code] = { code, baseName: base, markets: {}, grossIngredients: {} };
      }
      const rec = recipes[code];
      let md = rec.markets[market];
      if (!md) {
        md = {
          market,
          msku: row["MSKU Code"] ?? "",
          recipeNameLocal: fullName,
          recipeYield: num(row["Recipe Yield"]) || undefined,
          recipeYieldUom: row["Recipe Yield UOM"] || undefined,
          allergens: row["Allergen Contains"] || undefined,
          primaryPackagingSku: row["Primary Packaging Sku Code"] || undefined,
          compartmentName: row["Compartment Name"] || undefined,
          secondaryPackagingSkus: row["Secondary Packaging Sku Codes"] || undefined,
          subRecipes: [],
          ingredients: []
        };
        rec.markets[market] = md;
      }

      const subId = row["Sub-Recipe ID"] || "";
      const subName = row["Ingredient Name"] || "";
      const subCat = row["Sub-Recipe Categories"] || "";

      if (subId && !md.subRecipes.find(s => s.id === subId)) {
        md.subRecipes.push({
          id: subId,
          name: subName,
          category: subCat,
          yield: num(row["Sub-Recipe Yield"]) || undefined,
          yieldUom: row["Recipe Yield UOM"] || undefined,
          instructions: row["Instructions"] || undefined,
          methodColor: row["Method Color"] || undefined,
          methodType: row["Method Type"] || undefined
        });
      }

      md.ingredients.push({
        name: subName,
        ingredientId: row["Ingredient ID"] || "",
        ingredientCategory: row["Ingredient Type"] || undefined,
        type: row["Ingredient Type"] || undefined,
        subRecipeId: subId || undefined,
        subRecipeName: subName || undefined,
        quantityPerPortion: num(row["Ingredient Quantity"]),
        uom: row["Ingredient UOM"] || "",
        preparation: row["Preparation"] || undefined
      });
    }
  }

  if (usesCombined) {
    processRecipeRows(readCsv<Record<string, string>>(combinedPath));
  } else {
    for (const market of Object.keys(RECIPE_CSVS) as Market[]) {
      const path = join(SOURCE_DIR, RECIPE_CSVS[market]);
      if (!existsSync(path)) { console.warn(`fehlt: ${path}`); continue; }
      processRecipeRows(readCsv<Record<string, string>>(path), market);
    }
  }
  return recipes;
}

// ---------- 3) Gross Ingredients (CSV je Markt) ----------
// ---------- 3) Gross Ingredients (CSV je Markt, Detailed-CSV oder aggregiert) ----------
function loadGross(recipes: Record<string, Recipe>) {
  // Vorrang 1: Detaillierte Sub-Rezept-CSVs — enthalten Sub-Rezept 1-4 Namen + Ingredient-Infos
  // Diese Dateien erlauben das Sub-Rezept-Matching in getSubRecipeInfo().
  const detailedCsvs = findDetailedCsvs(SOURCE_DIR);
  if (detailedCsvs.length > 0) {
    console.log(`  Gross-Ingredients aus Detailed-CSVs: ${detailedCsvs.join(", ")}`);
    for (const csvFile of detailedCsvs) {
      const path = join(SOURCE_DIR, csvFile);
      const rows = readCsv<Record<string, string>>(path);
      for (const row of rows) {
        const fullName = (row["Recipe Name"] ?? "").trim();
        if (!fullName) continue;
        const { code } = parseRecipeName(fullName);
        if (!code) continue;
        const market = parseDetailedMarket(fullName);
        if (!market) continue; // Nur Hauptrezepte mit Markt-Tag ([DE], [BNL], [DKSE])
        if (!recipes[code]) {
          recipes[code] = { code, baseName: parseRecipeName(fullName).base, markets: {}, grossIngredients: {} };
        }
        const arr = (recipes[code].grossIngredients[market] ??= []);
        const ingredientId = row["Ingredient ID"] || "";
        // Kategorie aus Ingredient-ID ableiten (z.B. "PHF" aus "PHF-00-139175-3")
        const catMatch = ingredientId.match(/^([A-Z]{2,4})-/);
        arr.push({
          subRecipe1: row["Sub-Recipe 1 Name"] || undefined,
          subRecipe2: row["Sub-Recipe 2 Name"] || undefined,
          subRecipe3: row["Sub-Recipe 3 Name"] || undefined,
          ingredient: row["Ingredient"] || "",
          ingredientId,
          ingredientCategory: catMatch ? catMatch[1] : undefined,
          grossQuantityPerPortion: num(row["Gross Ingredient Qty"]),
          uom: row["Ingredient UOM"] || ""
        });
      }
    }
    return;
  }

  // Vorrang 2: Aggregiertes Gross-CSV (kein Sub-Rezept-Info, aber Fallback wenn keine Detailed-CSVs)
  const aggregatedPath = join(SOURCE_DIR, AGGREGATED_GROSS_CSV);
  if (existsSync(aggregatedPath)) {
    // Neues Format: MSKU Recipe Name, CSKU Name, CSKU Code, Ingredient Category, Gross Qty, UoM, MSKU Code
    console.log(`  Aggregiertes Gross-CSV (kein Sub-Rezept-Info): ${AGGREGATED_GROSS_CSV}`);
    const rows = readCsv<Record<string, string>>(aggregatedPath);
    for (const row of rows) {
      const fullName = row["MSKU Recipe Name"] ?? "";
      const { code } = parseRecipeName(fullName);
      if (!code) continue;
      const market = detectMarket(fullName);
      if (!market) continue;
      if (!recipes[code]) {
        recipes[code] = { code, baseName: parseRecipeName(fullName).base, markets: {}, grossIngredients: {} };
      }
      const arr = (recipes[code].grossIngredients[market] ??= []);
      arr.push({
        ingredient: row["CSKU Name"] || "",
        ingredientId: row["CSKU Code"] || "",
        ingredientCategory: row["Ingredient Category"] || undefined,
        grossQuantityPerPortion: num(row["Gross Qty"]),
        uom: row["UoM"] || ""
      });
    }
    return;
  }

  // Fallback: alte per-Markt-Dateien
  for (const market of Object.keys(GROSS_CSVS) as Market[]) {
    const path = join(SOURCE_DIR, GROSS_CSVS[market]);
    if (!existsSync(path)) { console.warn(`fehlt: ${path}`); continue; }
    const rows = readCsv<Record<string, string>>(path);

    for (const row of rows) {
      const fullName = row["Recipe Name"] ?? "";
      const { code } = parseRecipeName(fullName);
      if (!code) continue;
      if (!recipes[code]) {
        recipes[code] = { code, baseName: parseRecipeName(fullName).base, markets: {}, grossIngredients: {} };
      }
      const arr = (recipes[code].grossIngredients[market] ??= []);
      const gi: GrossIngredient = {
        subRecipe1: row["Sub-Recipe 1 Name"] || undefined,
        subRecipe2: row["Sub-Recipe 2 Name"] || undefined,
        subRecipe3: row["Sub-Recipe 3 Name"] || undefined,
        ingredient: row["Ingredient"] || "",
        ingredientId: row["Ingredient ID"] || "",
        ingredientCategory: row["Ingredient Category"] || undefined,
        grossQuantityPerPortion: num(row["Gross Quantity"]),
        uom: row["UOM"] || ""
      };
      arr.push(gi);
    }
  }
}

// ---------- 5) Detailed Recipe Structure (always-on, alle Märkte) ----------
// Baut den vollständigen Rezeptbaum aus der Detailed-CSV.
// Ergänzt außerdem fehlende Rezepteinträge im recipes-Record (z. B. FV0426A).

function parseDetailedMarket(fullName: string): Market | null {
  if (/\[BNL\]/i.test(fullName) || /\[BENL\]/i.test(fullName)) return "BENL";
  if (/\[DKSE\]/i.test(fullName) || /\[NORD\]/i.test(fullName)) return "DKSE";
  if (/\[DE\]/i.test(fullName)) return "DE";
  return null;
}

function numStr(v: string | undefined): number {
  if (!v || v.trim() === "") return 0;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function buildSubTree(rows: Record<string, string>[], level: number): DetailedSubRecipe[] {
  if (level > 4 || rows.length === 0) return [];
  const idCol   = `Sub-Recipe ${level} ID`;
  const nameCol = `Sub-Recipe ${level} Name`;
  const catCol  = `Sub-Recipe ${level} Recipe Categories`;
  const qtyCol  = `Sub-Recipe ${level} Quantity`;
  const uomCol  = `Sub-Recipe ${level} UOM`;

  // Gruppen nach Sub-Rezept-ID auf dieser Ebene
  const byId = new Map<string, Record<string, string>[]>();
  const noSub: Record<string, string>[] = [];

  for (const row of rows) {
    const id = (row[idCol] ?? "").trim();
    if (!id) { noSub.push(row); continue; }
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(row);
  }

  const nodes: DetailedSubRecipe[] = [];

  for (const [id, subRows] of byId) {
    const first = subRows[0];
    const nextIdCol = `Sub-Recipe ${level + 1} ID`;

    // Zeilen mit tieferem Sub-Rezept vs. direkte Blatt-Zutat
    const deeper = level < 4 ? subRows.filter(r => (r[nextIdCol] ?? "").trim() !== "") : [];
    const leaves = subRows.filter(r => level >= 4 || (r[nextIdCol] ?? "").trim() === "");

    const node: DetailedSubRecipe = {
      id,
      name: (first[nameCol] ?? "").trim(),
      categories: (first[catCol] ?? "").trim(),
      quantity: numStr(first[qtyCol]) || undefined,
      uom: (first[uomCol] ?? "").trim() || undefined,
      subRecipes: deeper.length > 0 ? buildSubTree(deeper, level + 1) : [],
      ingredients: []
    };

    // Direkte Zutaten dieses Sub-Rezepts (Blätter ohne tieferes Sub)
    const seen = new Set<string>();
    for (const r of leaves) {
      const ingName = (r["Ingredient"] ?? "").trim();
      const ingId   = (r["Ingredient ID"] ?? "").trim();
      if (!ingName) continue;
      const key = `${ingId}|${ingName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      node.ingredients.push({
        id: ingId,
        name: ingName,
        grossQty: numStr(r["Gross Ingredient Qty"]),
        netQty:   numStr(r["Net Ingredient Qty"]),
        uom:      (r["Ingredient UOM"] ?? "").trim(),
        allergen: (r["Ingredient Allergen Type"] ?? "").trim() || undefined,
        yieldPct: numStr(r["Sub-Recipe Yield %"]) || undefined
      });
    }

    nodes.push(node);
  }

  // Zeilen auf dieser Ebene ganz ohne Sub-ID → werden im Parent-Knoten verarbeitet.
  void noSub; // intentionally unused at this level
  return nodes;
}

function loadDetailedStructures(): Record<string, RecipeStructure> {
  // Alle passenden Detailed-CSVs automatisch per Glob erkennen und zusammenführen.
  // Neue Exporte (z. B. (4), (5) …) werden ohne Konfigurationsänderung eingeschlossen.
  const detailedCsvs = findDetailedCsvs(SOURCE_DIR);
  if (detailedCsvs.length === 0) console.warn("Keine Detailed-CSVs gefunden!");
  let rows: Record<string, string>[] = [];
  for (const csvFile of detailedCsvs) {
    const path = join(SOURCE_DIR, csvFile);
    const fileRows = readCsv<Record<string, string>>(path);
    console.log(`  Detailed CSV ${csvFile}: ${fileRows.length} Zeilen`);
    rows = rows.concat(fileRows);
  }
  if (rows.length === 0) { console.warn("Keine Detailed-CSVs gefunden!"); return {}; }
  console.log(`  Detailed CSVs gesamt: ${rows.length} Zeilen`);

  // Gruppen: { code → { market → rows[] } }
  const grouped = new Map<string, Map<Market, { recipeId: string; name: string; rows: Record<string, string>[] }>>();

  for (const row of rows) {
    const fullName = (row["Recipe Name"] ?? "").trim();
    if (!fullName) continue;
    const { code, base } = parseRecipeName(fullName);
    if (!code) continue;
    const market = parseDetailedMarket(fullName);
    if (!market) continue;
    const recipeId = (row["Recipe ID"] ?? "").trim();

    if (!grouped.has(code)) grouped.set(code, new Map());
    const mMap = grouped.get(code)!;
    if (!mMap.has(market)) mMap.set(market, { recipeId, name: base, rows: [] });
    mMap.get(market)!.rows.push(row);
  }

  const structures: Record<string, RecipeStructure> = {};

  for (const [code, mMap] of grouped) {
    const firstEntry = [...mMap.values()][0];
    const struct: RecipeStructure = {
      code,
      recipeId: firstEntry.recipeId,
      name: firstEntry.name,
      markets: {}
    };

    for (const [market, { rows: mRows }] of mMap) {
      struct.markets[market] = buildSubTree(mRows, 1);
    }

    structures[code] = struct;
    // Detailed-CSVs liefern NUR die Baumstruktur (structures).
    // Neue Recipe-Einträge werden hier NICHT angelegt – die planbaren Meals
    // kommen ausschließlich aus dem Ramp-Up-XLSX (weekRecipes).
  }

  console.log(`  Strukturen geladen: ${Object.keys(structures).length} Rezepte`);
  return structures;
}

// ---------- 4) Cook Schedules (CSV) — nur Site VF ----------
function loadCookSchedules(): Record<string, CookSchedule> {
  const path = join(SOURCE_DIR, COOK_CSV);
  const rows = readCsv<Record<string, string>>(path);
  const out: Record<string, CookSchedule> = {};

  for (const row of rows) {
    if ((row["Site"] || "").trim().toUpperCase() !== "VF") continue;
    const method = (row["COOK METHODS"] || "").trim();
    if (!method) continue;
    const shifts = num(row["Cook Shifts"]) || 1;

    const steps: CookSchedule["steps"] = [];
    const cells: [number, string][] = [
      [4, row["4 Shifts Before"] || ""],
      [3, row["3 Shifts Before"] || ""],
      [2, row["2 Shifts Before"] || ""],
      [1, row["1 Shift Before"]  || ""],
      [0, row["Same Day/Shift"]   || ""]
    ];
    for (const [n, label] of cells) {
      const l = label.trim();
      if (l) steps.push({ shiftsBefore: n, label: l });
    }
    out[method] = { cookMethod: method, site: "VF", cookShifts: shifts, steps };
  }
  return out;
}

// ---------- main ----------
async function main() {
  console.log("Lese Meal Selection …");
  const { weekRecipes, weeks } = await loadMealSelection();
  console.log(`  ${weekRecipes.length} Zeilen, ${weeks.length} Wochen`);

  console.log("Lese Recipes …");
  const recipes = loadRecipes();
  console.log(`  ${Object.keys(recipes).length} Rezept-Codes`);

  console.log("Lese Gross-Ingredients …");
  loadGross(recipes);

  console.log("Lese Cook Schedules (Site VF) …");
  const cookSchedules = loadCookSchedules();
  console.log(`  ${Object.keys(cookSchedules).length} VF-Cook-Methoden`);

  console.log("Lese Open Shelf Life / MLOR live …");
  let shelfLifeBySku: Record<string, ShelfLifeInfo> = {};
  try {
    shelfLifeBySku = await readOpenShelfLifeSheet();
  } catch {
    console.warn("  Shelf-Life-Tabelle nicht erreichbar (Google-Credentials fehlen?). Überspringe.");
  }

  console.log("Lese Detailed Recipe Structures …");
  const structures = loadDetailedStructures();

  // ---- Codes harmonisieren: FE… (Meal Selection) ↔ FV… (Recipes) per 4-stelliger Nummer ----
  const recipeByDigits: Record<string, Recipe> = {};
  for (const r of Object.values(recipes)) recipeByDigits[digitKey(r.code)] = r;

  let aliased = 0, unmatched = 0;
  for (const wr of weekRecipes) {
    if (recipes[wr.code]) continue;
    const hit = recipeByDigits[digitKey(wr.code)];
    if (hit) {
      recipes[wr.code] = hit;
      aliased++;
    } else {
      unmatched++;
    }
  }
  // Structures ebenfalls aliasieren
  const structByDigits: Record<string, RecipeStructure> = {};
  for (const s of Object.values(structures)) structByDigits[digitKey(s.code)] = s;
  for (const wr of weekRecipes) {
    if (!structures[wr.code]) {
      const hit = structByDigits[digitKey(wr.code)];
      if (hit) structures[wr.code] = hit;
    }
  }
  console.log(`  Code-Mapping: ${aliased} Aliase (FE↔FV), ${unmatched} ohne Match`);

  const bundle: DataBundle = {
    generatedAt: new Date().toISOString(),
    weeks,
    weekRecipes,
    recipes,
    cookSchedules,
    shelfLifeBySku,
    structures
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(bundle));
  const sizeMb = (Buffer.byteLength(JSON.stringify(bundle)) / 1024 / 1024).toFixed(2);
  console.log(`✓ ${OUT_FILE}  (${sizeMb} MB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
