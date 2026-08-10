// Liest die XLSX (Meal Selection) und die CSVs aus dem konfigurierten
// Rezeptlogik-Quellordner und schreibt eine konsolidierte public/data/data.json.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ExcelJS from "exceljs";
import type {
  DataBundle, Market, WeekRecipe, Recipe,
  GrossIngredient, CookSchedule,
  RecipeStructure, DetailedSubRecipe, ShelfLifeInfo, ProcessSpec, ProductionPlan
} from "../src/core/types.ts";
import { readOpenShelfLifeSheet } from "./read-open-shelf.ts";
import { readPfei } from "./import-pfei.ts";
import { readCookSchedulesFromGSheet } from "./read-cook-schedules.ts";
import { readProductionPlan } from "./read-production-plan.ts";
import { parseRecipeName, digitKey, resolveSourceDir, readCsv } from "./lib/helpers.ts";
import { loadRecipeDb, mergeIntoDb, saveRecipeDb, supplementFromDb } from "./lib/recipe-db.ts";

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

  const kw23Overrides: WeekRecipe[] = [
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV0322A",
      recipeName: "Sour Cream & Chive Chicken",
      preference: "CS",
      slot: { BENL: 402, DKSE: 602, DE: 302 },
      verdenVolume: { BENL: 3194, DKSE: 1909, DE: 1812 },
      totalVerdenVolume: 6915,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV0402A",
      recipeName: "Spicy jalapeño bowl with beef",
      preference: "Keto",
      slot: { BENL: 403, DKSE: 603, DE: 303 },
      verdenVolume: { BENL: 2577, DKSE: 1436, DE: 1288 },
      totalVerdenVolume: 5301,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV1320A",
      recipeName: "Ají Verde Salmon",
      preference: "P+",
      slot: { BENL: 404, DKSE: 604, DE: 304 },
      verdenVolume: { BENL: 5035, DKSE: 2537, DE: 2055 },
      totalVerdenVolume: 9627,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV0035A",
      recipeName: "Salmon with spinach pesto",
      preference: "Keto",
      slot: { BENL: 406, DKSE: 606, DE: 306 },
      verdenVolume: { BENL: 2355, DKSE: 1286, DE: 1544 },
      totalVerdenVolume: 5185,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV0401A",
      recipeName: "Pulled chicken with cheddar and bacon",
      preference: "Keto",
      slot: { BENL: 407, DKSE: 607, DE: 307 },
      verdenVolume: { BENL: 2523, DKSE: 1301, DE: 1291 },
      totalVerdenVolume: 5115,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV0778A",
      recipeName: "Creamy pesto pasta",
      preference: "Veggie",
      slot: { BENL: 409, DKSE: 609, DE: 309 },
      verdenVolume: { BENL: 730, DKSE: 338, DE: 302 },
      totalVerdenVolume: 1370,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV0131A",
      recipeName: "Black Bean Bowl and Enchilada Sauce",
      preference: "Veggie",
      slot: { BENL: 410, DKSE: 610, DE: 310 },
      verdenVolume: { BENL: 556, DKSE: 288, DE: 273 },
      totalVerdenVolume: 1117,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV4048A",
      recipeName: "Creamy Leek Pork tenderloin",
      preference: "CS",
      slot: { BENL: 413, DKSE: 613, DE: 313 },
      verdenVolume: { BENL: 799, DKSE: 524, DE: 421 },
      totalVerdenVolume: 1744,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV0601A",
      recipeName: "Mozzarella Burger & Roasted Potatoes",
      preference: "Keto",
      slot: { BENL: 415, DKSE: 615, DE: 315 },
      verdenVolume: { BENL: 3792, DKSE: 1652, DE: 1450 },
      totalVerdenVolume: 6894,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV4053A",
      recipeName: "Gochugaru Chicken",
      preference: "P+",
      slot: { BENL: 417, DKSE: 617, DE: 317 },
      verdenVolume: { BENL: 1764, DKSE: 887, DE: 826 },
      totalVerdenVolume: 3477,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV4042A",
      recipeName: "Pork tenderloin and Mediterranean mash",
      preference: "CS",
      slot: { BENL: 418, DKSE: 618, DE: 318 },
      verdenVolume: { BENL: 883, DKSE: 597, DE: 400 },
      totalVerdenVolume: 1880,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV1646A",
      recipeName: "Lemon Garlic Shrimp & Spanakorizo",
      preference: "CS",
      slot: { BENL: 419, DKSE: 619, DE: 319 },
      verdenVolume: { BENL: 1795, DKSE: 736, DE: 750 },
      totalVerdenVolume: 3281,
      productionBuffer: 0
    },
    {
      hfWeek: "2026-W23",
      weekShort: "W23",
      code: "FV0612A",
      recipeName: "Ground Beef & Mushroom Skillet",
      preference: "Perf",
      slot: { BENL: 421, DKSE: 621, DE: 321 },
      verdenVolume: { BENL: 1183, DKSE: 635, DE: 686 },
      totalVerdenVolume: 2504,
      productionBuffer: 0
    }
  ];

  const finalOut = out.filter(r => r.hfWeek !== "2026-W23");
  finalOut.push(...kw23Overrides);

  const weeks = [...weekSet].sort();
  return { weekRecipes: finalOut, weeks };
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
        if (!code || !/^[A-Z]{2}\d{4}[A-Z0-9]+$/.test(code)) continue;
        const market = parseDetailedMarket(fullName) ?? "BENL";
        if (!recipes[code]) {
          recipes[code] = { code, baseName: parseRecipeName(fullName).base, markets: {}, grossIngredients: {} };
        }
        // Sub-Rezepte (Top-Level = Sub-Recipe 1) aus Detailed-CSV befüllen,
        // falls die Recipe-CSV diesen Code nicht enthält (z. B. neue KW-Rezepte).
        if (!recipes[code].markets[market]) {
          recipes[code].markets[market] = {
            market,
            msku: "",
            recipeNameLocal: fullName,
            subRecipes: [],
            ingredients: []
          };
        }
        const md = recipes[code].markets[market]!;
        const sub1Id   = (row["Sub-Recipe 1 ID"]                ?? "").trim();
        const sub1Name = (row["Sub-Recipe 1 Name"]              ?? "").trim();
        const sub1Cat  = (row["Sub-Recipe 1 Recipe Categories"] ?? "").trim();
        if (sub1Id && !md.subRecipes.find(s => s.id === sub1Id)) {
          md.subRecipes.push({
            id: sub1Id,
            name: sub1Name,
            category: sub1Cat,
            yield: numStr(row["Sub-Recipe 1 Quantity"]) || undefined,
            yieldUom: (row["Sub-Recipe 1 UOM"] ?? "").trim() || undefined,
          });
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
  if (!existsSync(path)) {
    console.warn(`  Cook-Schedules-CSV nicht gefunden (${COOK_CSV}) — überspringe`);
    return {};
  }
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
  const xlsxPath = join(SOURCE_DIR, XLSX_FILE);
  let weekRecipes: WeekRecipe[];
  let weeks: string[];
  if (existsSync(xlsxPath)) {
    console.log("Lese Meal Selection …");
    ({ weekRecipes, weeks } = await loadMealSelection());
    console.log(`  ${weekRecipes.length} Zeilen, ${weeks.length} Wochen`);
  } else {
    console.warn(`  XLSX nicht gefunden (${XLSX_FILE}) — behalte bestehende weekRecipes aus data.json`);
    const existing: DataBundle = existsSync(OUT_FILE)
      ? JSON.parse(readFileSync(OUT_FILE, "utf8"))
      : { weekRecipes: [], weeks: [], recipes: {}, cookSchedules: {}, structures: {}, generatedAt: "" };
    weekRecipes = existing.weekRecipes ?? [];
    weeks = existing.weeks ?? [];
  }

  console.log("Lese Recipes …");
  const recipes = loadRecipes();
  console.log(`  ${Object.keys(recipes).length} Rezept-Codes`);

  console.log("Lese Gross-Ingredients …");
  loadGross(recipes);

  console.log("Lese Cook Schedules (Site VF) …");
  let cookSchedules = loadCookSchedules();
  if (Object.keys(cookSchedules).length === 0) {
    try {
      cookSchedules = await readCookSchedulesFromGSheet();
    } catch {
      console.warn("  Cook-Schedules-GSheet nicht erreichbar. Überspringe.");
    }
  }
  console.log(`  ${Object.keys(cookSchedules).length} VF-Cook-Methoden`);

  console.log("Lese Open Shelf Life / MLOR live …");
  let shelfLifeBySku: Record<string, ShelfLifeInfo> = {};
  try {
    shelfLifeBySku = await readOpenShelfLifeSheet();
  } catch {
    console.warn("  Shelf-Life-Tabelle nicht erreichbar (Google-Credentials fehlen?). Überspringe.");
  }

  console.log("Lese PFEI (Equipment- & Batch-Daten) live …");
  let processSpecs: Record<string, ProcessSpec> = {};
  try {
    processSpecs = await readPfei();
  } catch {
    console.warn("  PFEI-Sheet nicht erreichbar. Überspringe.");
  }

  console.log("Lese Fertigstellungszeitplan (Sheet 6) live …");
  let productionPlan: ProductionPlan | undefined;
  try {
    productionPlan = await readProductionPlan(process.env.SHEET_FERTIGSTELLUNG ?? "1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY") ?? undefined;
  } catch {
    console.warn("  Fertigstellungszeitplan nicht erreichbar. Überspringe.");
  }

  console.log("Lese Detailed Recipe Structures …");
  const structures = loadDetailedStructures();

  // ---- Persistente Rezept-Datenbank: alle gesehenen Rezepte akkumulieren ----
  console.log("Aktualisiere Rezept-Datenbank …");
  const recipeDb = loadRecipeDb(SOURCE_DIR);
  const { added, updated } = mergeIntoDb(recipeDb, recipes, structures);
  saveRecipeDb(SOURCE_DIR, recipeDb);
  console.log(`  Neu: ${added}, aktualisiert: ${updated}`);
  // Aus DB ergänzen: Rezepte die geplant sind aber nicht in den aktuellen CSVs enthalten
  const weekCodes = weekRecipes.map(wr => wr.code);
  const { supplementedRecipes, supplementedStructures } = supplementFromDb(recipeDb, recipes, structures, weekCodes);
  if (supplementedRecipes > 0 || supplementedStructures > 0) {
    console.log(`  Aus DB ergänzt: ${supplementedRecipes} Rezepte, ${supplementedStructures} Strukturen`);
  }

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
    processSpecs,
    shelfLifeBySku,
    structures,
    productionPlan: productionPlan ?? undefined,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(bundle));
  const sizeMb = (Buffer.byteLength(JSON.stringify(bundle)) / 1024 / 1024).toFixed(2);
  console.log(`✓ ${OUT_FILE}  (${sizeMb} MB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
