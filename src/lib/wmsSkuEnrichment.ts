import type { DataBundle, DetailedSubRecipe, GrossIngredient, Ingredient, Market } from "../core/types";

export type WmsSkuInfo = {
  sku: string;
  name: string;
  uom: string;
  category: string;
  plannedQty: number;
  recipes: Set<string>;
  source: "week-plan" | "catalog" | "shelf-life" | "wms-only";
};

export function buildSkuInfoIndex(data: DataBundle, week: string): Map<string, WmsSkuInfo> {
  const map = new Map<string, WmsSkuInfo>();
  const markets: Market[] = ["BENL", "DKSE", "DE"];
  const weekRecipes = data.weekRecipes.filter((row) => row.hfWeek === week);
  const weekRecipeCodes = new Set(weekRecipes.map((row) => row.code));

  const addPlannedSku = (row: { sku: string; name: string; uom: string; category?: string; qty: number; recipeCode: string }) => {
    const key = skuKey(row.sku);
    if (!key) return;
    const current = map.get(key) ?? {
      sku: key,
      name: cleanSkuName(row.name),
      uom: row.uom || skuDefaultUom(key),
      category: row.category ?? key.slice(0, 3),
      plannedQty: 0,
      recipes: new Set<string>(),
      source: "week-plan" as const,
    };
    current.name ||= cleanSkuName(row.name);
    current.uom ||= row.uom || skuDefaultUom(key);
    current.category ||= row.category ?? key.slice(0, 3);
    current.plannedQty += Number.isFinite(row.qty) ? row.qty : 0;
    if (row.recipeCode) current.recipes.add(row.recipeCode);
    current.source = "week-plan";
    map.set(key, current);
  };

  const addCatalogSku = (row: { sku: string; name: string; uom?: string; category?: string; recipeCode?: string }) => {
    const key = skuKey(row.sku);
    const name = cleanSkuName(row.name);
    if (!key || !name || isGenericSkuName(name, key)) return;
    const current = map.get(key) ?? {
      sku: key,
      name,
      uom: row.uom || skuDefaultUom(key),
      category: row.category ?? key.slice(0, 3),
      plannedQty: 0,
      recipes: new Set<string>(),
      source: "catalog" as const,
    };
    if (isGenericSkuName(current.name, key) || current.source !== "week-plan") current.name = name;
    current.uom ||= row.uom || skuDefaultUom(key);
    current.category ||= row.category ?? key.slice(0, 3);
    if (row.recipeCode) current.recipes.add(row.recipeCode);
    if (current.source !== "week-plan") current.source = "catalog";
    map.set(key, current);
  };

  const addDetailedSubRecipeCatalog = (node: DetailedSubRecipe, recipeCode: string) => {
    addCatalogSku({ sku: node.id, name: node.name, uom: node.uom || "grams", category: "SUB", recipeCode });
    for (const ingredient of node.ingredients) {
      addCatalogSku({ sku: ingredient.id, name: ingredient.name, uom: ingredient.uom, category: ingredient.id.slice(0, 3), recipeCode });
    }
    for (const child of node.subRecipes) addDetailedSubRecipeCatalog(child, recipeCode);
  };

  for (const weekRecipe of weekRecipes) {
    const recipe = data.recipes[weekRecipe.code];
    if (!recipe) continue;
    // WMS Plating arbeitet mit der rohen "Recipe ID" (z.B. "REC-022729-4-006"),
    // nicht mit der MSKU - ohne diese fiel jede Plating-Zeile durch den
    // wochenbasierten SKU-Filter, obwohl das Rezept genau diese Woche lief.
    const recipeId = data.structures?.[weekRecipe.code]?.recipeId;

    for (const market of markets) {
      const portions = weekRecipe.verdenVolume[market] ?? 0;
      if (portions <= 0) continue;
      const marketDetails = recipe.markets[market];

      if (marketDetails?.msku) {
        addPlannedSku({ sku: marketDetails.msku, name: marketDetails.recipeNameLocal || recipe.baseName || weekRecipe.recipeName, uom: "each", category: "MSKU", qty: portions, recipeCode: weekRecipe.code });
      }
      if (recipeId) {
        addPlannedSku({ sku: recipeId, name: marketDetails?.recipeNameLocal || recipe.baseName || weekRecipe.recipeName, uom: "each", category: "REC", qty: portions, recipeCode: weekRecipe.code });
      }

      for (const subRecipe of marketDetails?.subRecipes ?? []) {
        addPlannedSku({ sku: subRecipe.id, name: subRecipe.name, uom: subRecipe.yieldUom || "grams", category: "SUB", qty: portions * (subRecipe.yield ?? 0), recipeCode: weekRecipe.code });
      }

      const grossRows = recipe.grossIngredients[market] ?? [];
      if (grossRows.length > 0) {
        for (const ingredient of grossRows as GrossIngredient[]) {
          addPlannedSku({ sku: ingredient.ingredientId, name: ingredient.ingredient, uom: ingredient.uom, category: ingredient.ingredientCategory, qty: ingredient.grossQuantityPerPortion * portions, recipeCode: weekRecipe.code });
        }
        continue;
      }

      for (const ingredient of (marketDetails?.ingredients ?? []) as Ingredient[]) {
        addPlannedSku({ sku: ingredient.ingredientId, name: ingredient.name, uom: ingredient.uom, category: ingredient.ingredientCategory, qty: ingredient.quantityPerPortion * portions, recipeCode: weekRecipe.code });
      }
    }
  }

  for (const [sku, shelf] of Object.entries(data.shelfLifeBySku ?? {})) {
    const key = skuKey(sku);
    if (!key || map.has(key)) continue;
    map.set(key, {
      sku: key,
      name: shelf.skuName,
      uom: skuDefaultUom(key),
      category: shelf.category ?? key.slice(0, 3),
      plannedQty: 0,
      recipes: new Set<string>(),
      source: "shelf-life",
    });
  }

  for (const recipe of Object.values(data.recipes)) {
    for (const market of markets) {
      const marketDetails = recipe.markets[market];
      if (marketDetails?.msku) {
        addCatalogSku({ sku: marketDetails.msku, name: marketDetails.recipeNameLocal || recipe.baseName, uom: "each", category: "MSKU", recipeCode: recipe.code });
      }
      for (const subRecipe of marketDetails?.subRecipes ?? []) {
        addCatalogSku({ sku: subRecipe.id, name: subRecipe.name, uom: subRecipe.yieldUom || "grams", category: "SUB", recipeCode: recipe.code });
      }
      for (const ingredient of marketDetails?.ingredients ?? []) {
        addCatalogSku({ sku: ingredient.ingredientId || ingredient.subRecipeId || "", name: ingredient.name || ingredient.subRecipeName || "", uom: ingredient.uom, category: ingredient.ingredientCategory, recipeCode: recipe.code });
      }
      for (const ingredient of recipe.grossIngredients[market] ?? []) {
        addCatalogSku({ sku: ingredient.ingredientId, name: ingredient.ingredient, uom: ingredient.uom, category: ingredient.ingredientCategory, recipeCode: recipe.code });
      }
    }
  }

  for (const structure of Object.values(data.structures ?? {})) {
    for (const marketNodes of Object.values(structure.markets)) {
      for (const node of marketNodes ?? []) addDetailedSubRecipeCatalog(node, structure.code);
    }
  }

  for (const info of map.values()) {
    info.recipes = new Set([...info.recipes].filter((recipeCode) => weekRecipeCodes.has(recipeCode)));
  }

  return map;
}

export function getSkuDisplayLabel(sku: string, index: Map<string, WmsSkuInfo>): string {
  const key = skuKey(sku);
  const info = index.get(key);
  if (info?.name && !isGenericSkuName(info.name, key)) return info.name;
  return key || "–";
}

export function skuKey(value: string): string {
  return String(value ?? "").trim().toUpperCase();
}

// SKUs, die laut Rezeptplan (weekRecipes + deren Sub-Rezepte/Zutaten) für die
// gegebene KW tatsächlich gebraucht werden — Teilmenge von buildSkuInfoIndex,
// ohne die zusätzlichen wochenunabhängigen Katalog-/Shelf-Life-Einträge, die
// dort ebenfalls (nur für Namens-Anreicherung) mitgeführt werden.
export function weekPlannedSkuSet(skuInfoIndex: Map<string, WmsSkuInfo>): Set<string> {
  const skus = new Set<string>();
  for (const [sku, info] of skuInfoIndex) {
    if (info.source === "week-plan") skus.add(sku);
  }
  return skus;
}

function skuDefaultUom(sku: string, fallback = ""): string {
  const prefix = skuKey(sku).slice(0, 3);
  if (["SUB", "PTN", "PHF", "PRO", "SPI", "DRY", "DAI"].includes(prefix)) return "grams";
  if (["BEV", "SAU"].includes(prefix)) return "ml";
  if (["CON", "PCK", "LAB"].includes(prefix)) return "each";
  return fallback || "each";
}

function cleanSkuName(name: string): string {
  return String(name ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s+\[PENDING CULINARY REVIEW\]/gi, "")
    .trim();
}

function isGenericSkuName(name: string, sku: string): boolean {
  const value = name.trim().toUpperCase();
  if (!value) return true;
  if (value === skuKey(sku)) return true;
  return /^(SUBRECIPE SKU|INGREDIENT SKU|PRIMARY PACKAGING|SECONDARY PACKAGING|DECREMENT|AUTO MOVE|UNKNOWN|-)$/.test(value);
}
