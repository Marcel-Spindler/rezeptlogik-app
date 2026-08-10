// Browser-kompatibler CSV-Parser — portiert aus scripts/import-local.ts.
// Keine Node.js-APIs; nimmt rohen CSV-Text entgegen und gibt getypte Objekte zurück.
import Papa from "papaparse";
import type { Market, Recipe, RecipeStructure, DetailedSubRecipe } from "../core/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseCsv(text: string): Record<string, string>[] {
  const res = Papa.parse<Record<string, string>>(
    text.replace(/^\uFEFF/, ""), // BOM entfernen
    { header: true, skipEmptyLines: true }
  );
  return res.data;
}

function num(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function detectMarket(fullName: string): Market | null {
  if (/\[BNL\]|\[BENL\]/i.test(fullName)) return "BENL";
  if (/\[DKSE\]|\[NORD\]/i.test(fullName)) return "DKSE";
  if (/\[DE\]/i.test(fullName)) return "DE";
  if (/\s(BNL|BENL)\s*$/i.test(fullName)) return "BENL";
  if (/\s(DKSE|NORD)\s*$/i.test(fullName)) return "DKSE";
  if (/\sDE\s*$/i.test(fullName)) return "DE";
  return null;
}

function detectDetailedMarket(fullName: string): Market | null {
  if (/\[BNL\]/i.test(fullName) || /\[BENL\]/i.test(fullName)) return "BENL";
  if (/\[DKSE\]/i.test(fullName) || /\[NORD\]/i.test(fullName)) return "DKSE";
  if (/\[DE\]/i.test(fullName)) return "DE";
  return null;
}

function parseCode(fullName: string): { code: string; base: string } {
  const m = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s*-\s*(.+?)(?:\s*\[(?:BNL|BENL|DE|DKSE|NORD)\])?\s*$/.exec(fullName);
  if (m) return { code: m[1], base: m[2].trim() };
  const suffix = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s+(.+?)\s+(?:BNL|BENL|DE|DKSE|NORD)\s*$/i.exec(fullName);
  if (suffix) return { code: suffix[1], base: suffix[2].trim() };
  const plain = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s+(.+?)\s*$/.exec(fullName);
  if (plain) return { code: plain[1], base: plain[2].trim() };
  return { code: fullName, base: fullName };
}

// ─── 1) export-recipes*.csv → Recipe ─────────────────────────────────────────

export function parseRecipesCsv(text: string): Record<string, Recipe> {
  const recipes: Record<string, Recipe> = {};
  const rows = parseCsv(text);

  for (const row of rows) {
    const fullName = row["Recipe name"] ?? "";
    const { code, base } = parseCode(fullName);
    if (!code) continue;
    const market = detectMarket(fullName);
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
        ingredients: [],
      };
      rec.markets[market] = md;
    }

    const subId = row["Sub-Recipe ID"] || "";
    const subName = row["Ingredient Name"] || "";
    if (subId && !md.subRecipes.find(s => s.id === subId)) {
      md.subRecipes.push({
        id: subId,
        name: subName,
        category: row["Sub-Recipe Categories"] || "",
        yield: num(row["Sub-Recipe Yield"]) || undefined,
        yieldUom: row["Recipe Yield UOM"] || undefined,
        instructions: row["Instructions"] || undefined,
        methodColor: row["Method Color"] || undefined,
        methodType: row["Method Type"] || undefined,
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
      preparation: row["Preparation"] || undefined,
    });
  }

  return recipes;
}

// ─── 2) export-sub-recipes-by-recipe-detailed*.csv → RecipeStructure + Gross ─

function buildSubTree(rows: Record<string, string>[], level: number): DetailedSubRecipe[] {
  if (level > 4 || rows.length === 0) return [];
  const idCol   = `Sub-Recipe ${level} ID`;
  const nameCol = `Sub-Recipe ${level} Name`;
  const catCol  = `Sub-Recipe ${level} Recipe Categories`;
  const qtyCol  = `Sub-Recipe ${level} Quantity`;
  const uomCol  = `Sub-Recipe ${level} UOM`;

  const byId = new Map<string, Record<string, string>[]>();
  for (const row of rows) {
    const id = (row[idCol] ?? "").trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(row);
  }

  const nodes: DetailedSubRecipe[] = [];
  for (const [id, subRows] of byId) {
    const first = subRows[0];
    const nextIdCol = `Sub-Recipe ${level + 1} ID`;
    const deeper = level < 4 ? subRows.filter(r => (r[nextIdCol] ?? "").trim() !== "") : [];
    const leaves = subRows.filter(r => level >= 4 || (r[nextIdCol] ?? "").trim() === "");

    const node: DetailedSubRecipe = {
      id,
      name: (first[nameCol] ?? "").trim(),
      categories: (first[catCol] ?? "").trim(),
      quantity: num(first[qtyCol]) || undefined,
      uom: (first[uomCol] ?? "").trim() || undefined,
      subRecipes: deeper.length > 0 ? buildSubTree(deeper, level + 1) : [],
      ingredients: [],
    };

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
        grossQty: num(r["Gross Ingredient Qty"]),
        netQty:   num(r["Net Ingredient Qty"]),
        uom:      (r["Ingredient UOM"] ?? "").trim(),
        allergen: (r["Ingredient Allergen Type"] ?? "").trim() || undefined,
        yieldPct: num(r["Sub-Recipe Yield %"]) || undefined,
      });
    }
    nodes.push(node);
  }
  return nodes;
}

export function parseDetailedCsv(text: string): {
  structures: Record<string, RecipeStructure>;
  grossByCode: Record<string, Partial<Record<Market, ReturnType<typeof buildGrossFromRows>>>>;
} {
  const rows = parseCsv(text);

  // Strukturen aufbauen
  const grouped = new Map<string, Map<Market, { recipeId: string; name: string; rows: Record<string, string>[] }>>();
  for (const row of rows) {
    const fullName = (row["Recipe Name"] ?? "").trim();
    if (!fullName) continue;
    const { code, base } = parseCode(fullName);
    if (!code) continue;
    const market = detectDetailedMarket(fullName);
    const markets: Market[] = market ? [market] : (["BENL", "DKSE", "DE"] as Market[]);
    const recipeId = (row["Recipe ID"] ?? "").trim();
    const groupKey = market ? code : base.toLowerCase().trim();

    if (!grouped.has(groupKey)) grouped.set(groupKey, new Map());
    const mMap = grouped.get(groupKey)!;
    for (const m of markets) {
      if (!mMap.has(m)) mMap.set(m, { recipeId, name: base, rows: [] });
      mMap.get(m)!.rows.push(row);
    }
  }

  const structures: Record<string, RecipeStructure> = {};
  for (const [groupKey, mMap] of grouped) {
    const first = [...mMap.values()][0];
    const docKey = groupKey.replace(/\//g, "_");
    const struct: RecipeStructure = { code: docKey, recipeId: first.recipeId, name: first.name, markets: {} };
    for (const [market, { rows: mRows }] of mMap) {
      struct.markets[market] = buildSubTree(mRows, 1);
    }
    structures[docKey] = struct;
  }

  // Gross-Ingredients aufbauen (für Recipe-Objekte)
  const grossByCode: Record<string, Partial<Record<Market, any[]>>> = {};
  for (const row of rows) {
    const fullName = (row["Recipe Name"] ?? "").trim();
    if (!fullName) continue;
    const { code } = parseCode(fullName);
    if (!code || !/^[A-Z]{2}\d{4}[A-Z0-9]+$/.test(code)) continue;
    const market = detectDetailedMarket(fullName) ?? "BENL";
    if (!grossByCode[code]) grossByCode[code] = {};
    const arr = (grossByCode[code][market] ??= []);
    const ingredientId = row["Ingredient ID"] || "";
    const catMatch = ingredientId.match(/^([A-Z]{2,4})-/);
    arr.push({
      subRecipe1: row["Sub-Recipe 1 Name"] || undefined,
      subRecipe2: row["Sub-Recipe 2 Name"] || undefined,
      subRecipe3: row["Sub-Recipe 3 Name"] || undefined,
      ingredient: row["Ingredient"] || "",
      ingredientId,
      ingredientCategory: catMatch ? catMatch[1] : undefined,
      grossQuantityPerPortion: num(row["Gross Ingredient Qty"]),
      uom: row["Ingredient UOM"] || "",
    });
  }

  return { structures, grossByCode };
}

// Dummy type helper (wird nicht exportiert, nur für internes Typing)
function buildGrossFromRows(_: unknown) { return [] as any[]; }
void buildGrossFromRows;

// ─── Merge: Gross-Ingredients in bestehende Recipes einpflegen ────────────────

export function mergeGrossIntoRecipes(
  recipes: Record<string, Recipe>,
  grossByCode: Record<string, Partial<Record<Market, any[]>>>
): void {
  for (const [code, byMarket] of Object.entries(grossByCode)) {
    if (!recipes[code]) continue;
    for (const [market, arr] of Object.entries(byMarket)) {
      if (arr) recipes[code].grossIngredients[market as Market] = arr;
    }
  }
}
