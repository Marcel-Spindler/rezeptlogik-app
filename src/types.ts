// Gemeinsame Datentypen für Importer und Frontend.
// Markets in Verden (VF) produziert; Verpackung unterscheidet die Länder.
export type Market = "BENL" | "DKSE" | "DE";

export interface WeekRecipe {
  hfWeek: string;            // "2026-W19"
  weekShort: string;         // "W19"
  code: string;              // Family code, z. B. "FE4009A"
  recipeName: string;
  preference: string;        // "P+", "Keto", "CS", ...
  slot: { BENL?: number; DKSE?: number; DE?: number };
  verdenVolume: { BENL: number; DKSE: number; DE: number };
  totalVerdenVolume: number; // Summe aller Märkte (= was tatsächlich gekocht wird)
  productionBuffer: number;
}

export interface SubRecipe {
  id: string;                // "SUB-013858-4-001"
  name: string;
  category: string;          // z. B. "HAND MIX / BLAST CHILLER" (= Cook Method Key)
  yield?: number;
  yieldUom?: string;
  instructions?: string;
  methodColor?: string;
  methodType?: string;
}

export interface Ingredient {
  name: string;
  ingredientId: string;
  ingredientCategory?: string;       // PRO / PHF / SPI / DRY ...
  type?: string;                     // S, R, ...
  subRecipeId?: string;              // Zuordnung zum Sub-Rezept
  subRecipeName?: string;
  quantityPerPortion: number;        // pro Portion
  uom: string;                       // "grams", "ml", ...
  preparation?: string;
}

export interface RecipeMarketDetails {
  market: Market;
  msku: string;
  recipeNameLocal: string;           // [BNL] / [DE] / [DKSE]-Variante
  recipeYield?: number;
  recipeYieldUom?: string;
  allergens?: string;
  primaryPackagingSku?: string;
  compartmentName?: string;
  secondaryPackagingSkus?: string;
  subRecipes: SubRecipe[];
  ingredients: Ingredient[];
}

export interface Recipe {
  code: string;                                    // "FE4009A"
  baseName: string;                                // Markt-übergreifender Name
  markets: Partial<Record<Market, RecipeMarketDetails>>;
  // Brutto-Zutaten je Markt (aus gross-ingredients-CSV) — meist identisch über Märkte hinweg
  grossIngredients: Partial<Record<Market, GrossIngredient[]>>;
}

export interface GrossIngredient {
  subRecipe1?: string;
  subRecipe2?: string;
  subRecipe3?: string;
  ingredient: string;
  ingredientId: string;
  ingredientCategory?: string;
  grossQuantityPerPortion: number;
  uom: string;
}

export interface ShelfLifeInfo {
  skuCode: string;
  skuName: string;
  category?: string;
  subCategory?: string;
  tempCategory?: string;
  totalShelfLifeRaw?: string;
  totalShelfLifeDays?: number;
  mlorRaw?: string;
  mlorDays?: number;
  openShelfLifeRaw?: string;
  openShelfLifeDays?: number;
  customerMinDays: number;
  mlorVsCustomerGapDays?: number;
  openVsCustomerGapDays?: number;
  status: "ok" | "risk" | "critical" | "unknown";
}

export interface CookSchedule {
  cookMethod: string;        // Key, matcht SubRecipe.category
  site: string;              // "VF" für Verden
  cookShifts: number;        // 1, 2, 3
  steps: {
    shiftsBefore: number;    // 4..0 (0 = Same Day/Shift)
    label: string;           // "STAGING", "BRAISER", ...
  }[];
}

// === PFEI: Equipment-/Prozess-Spezifikation pro Sub-Rezept =================
// Stationen exakt in der Reihenfolge der MAIN-Sheet Spalten I … AF.
// Diese Reihenfolge ist gleichzeitig unsere "kanonische" Workflow-Reihenfolge,
// wenn die Cook-Method-Kategorie keine eigene Reihenfolge erzwingt.
export const STATIONS = [
  "Staging",
  "Spice Portioning",
  "Debox",
  "Thaw",
  "Brine",
  "Marinade",
  "Hand Marinade",
  "Immersion Blender",
  "Planetary Mixer",
  "Horizontal Mixer",
  "Patty Maker",
  "Braiser",
  "Grill",
  "Crusted",
  "Oven",
  "Drain",
  "Hand Mix",
  "Cold Shredder",
  "Hot Shredder",
  "Scooper",
  "Butter Machine",
  "Slicer",
  "Cupping",
  "Blast Chiller"
] as const;
export type Station = typeof STATIONS[number];

export interface ProcessSpec {
  subRecipeId: string;            // "SUB-013361-4-001"
  name: string;                   // wie in PFEI MAIN col A
  productFamily?: string;         // col C
  primaryStation?: string;        // col F  ("Batch Constraint")
  batchSizeKg?: number;           // col G
  batchUom?: string;              // col H
  hygienic?: boolean;             // col CE
  // Minuten pro Batch je Station (Block 1, MAIN cols I..AF)
  minutesPerBatch: Partial<Record<Station, number>>;
  // Hold-/Cool-Zeit je Station (Block 3, MAIN cols BE..BB)
  holdTimeMin: Partial<Record<Station, number>>;
}

// === Detailed Recipe Structure (aus export-sub-recipes-by-recipe-detailed.csv) =========
// Repräsentiert den vollständigen Rezeptbaum: Main → Sub1 → Sub2 → Sub3 → Sub4 → Ingredient

export interface DetailedIngredient {
  id: string;
  name: string;
  grossQty: number;
  netQty: number;
  uom: string;
  allergen?: string;
  yieldPct?: number;
}

export interface DetailedSubRecipe {
  id: string;
  name: string;
  categories: string;          // z. B. "BLAST CHILLER, GRILL, MARINADE, OVEN"
  quantity?: number;
  uom?: string;
  subRecipes: DetailedSubRecipe[];   // verschachtelte Sub-Rezepte
  ingredients: DetailedIngredient[]; // direkte Zutaten auf dieser Ebene
}

export interface RecipeStructure {
  code: string;
  recipeId: string;
  name: string;
  markets: Partial<Record<Market, DetailedSubRecipe[]>>; // Top-Level-Sub-Rezepte je Markt
}

export interface DataBundle {
  generatedAt: string;
  weeks: string[];                                // sortiert: ["2026-W17", ...]
  weekRecipes: WeekRecipe[];
  recipes: Record<string, Recipe>;                // key = code
  cookSchedules: Record<string, CookSchedule>;    // key = cookMethod (für VF)
  processSpecs?: Record<string, ProcessSpec>;     // key = subRecipeId
  shelfLifeBySku?: Record<string, ShelfLifeInfo>; // key = ingredient / SKU code
  structures?: Record<string, RecipeStructure>;   // key = recipe code
}
