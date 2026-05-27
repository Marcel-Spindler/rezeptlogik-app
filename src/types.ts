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

// === Production Plan (Sheet 6: Fertigstellungszeitplan) ======================
// Work Order structure — "W{XX} Transperancy Total Overview" tab.
// Each row = one sub-recipe batch within a Work Order.
export interface WorkOrderEntry {
  run: number;
  kitchenDay: string;         // "2026-05-24"
  workOrder: string;          // "23-175"
  recipeCode: string;         // "FV0035A"
  recipeName: string;         // "Salmon with pesto [BNL]"
  subRecipe: string;          // "Salmon - garlic seasoning"
  plannedMeals: number;
  stagingKg: number;
  kitchenKg: number;
  postKg: number;
  yieldPct: number;           // 40.9 (not 0.409)
  logisticTarget?: number;
}

export interface ProductionPlan {
  week: string;
  generatedAt: string;
  rows: WorkOrderEntry[];
}

// === Print Orders (Sheet 2: Print Orders Sleeven) ============================
export interface PrintOrderRow {
  week: string;
  code: string;
  msku: string;
  qty: number;
  sleeveType?: string;
}

// === Kitchen Priority (Sheet 3) ==============================================
// "Verden-2026-W{XX}" tab: header row 1, data from row 2.
// Cols: [0]=date-group, [2]=Priority, [3]=WOStaging by, [4]=Comments,
//       [5]=Debox Day, [6]=WO Ready, [7]=Hot Kitchen Weekday,
//       [8]=Date Needed, [9]=Work Order Number
export interface KitchenPriorityRow {
  priority: number;
  workOrder: string;          // "23-175"
  woStagingBy?: string;
  deboxDay?: string;          // "Tuesday"
  woReady: boolean;
  hotKitchenWeekday?: string; // "Monday"
  dateNeeded?: string;        // "2026-05-24 - 1"
  comments?: string;
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
  productionPlan?: ProductionPlan;
  printOrders?: PrintOrderRow[];
  kitchenPriority?: KitchenPriorityRow[];
  produktionsplanung?: Record<string, ProduktionsplanungEntry>;
  maitreRampup?: Record<string, MaitreRampupEntry>;
}

// === Fulfillment Report: Maitre-Ramp-up ======================================
// Aus "Maitre Inputs DE/NO_Stamm" Tab des OUTPUT Fulfillment Report Sheets.
// Volumen-Snapshots je Rezept, Markt und Woche – von 4 Wochen vor Lieferung bis Bestellung.

export type MaitreSnapshotLabel = "wed-4wk" | "wed-3wk" | "wed-2wk" | "wed-1wk" | "fri-1wk" | "mon" | "tue" | "wed" | "thu";

export interface MaitreRampupEntry {
  week: string;        // "W22" (Lieferwoche, kurz)
  market: string;      // "DE" | "NORDICS"
  slot: number;        // Slot-Nummer (301, 601, ...)
  recipeCode: string;  // "FE4014C"
  maitreCode: string;  // "565303" (Maitre WMS-Code)
  skuCode: string;     // "CON-00-136675-3"
  recipeName: string;  // Lokaler Rezeptname
  snapshots: Partial<Record<MaitreSnapshotLabel, number>>; // Volumen je Snapshot-Zeitpunkt
  orderVolume: number; // Finale Bestellmenge
}

// === Fulfillment Report: Produktionsplanung DE / Nordics =====================
// Aus "Produktionsvorbereitung_DE" / "_Nordics" Tabs – geplante Mengen je Liefertag.

export interface ProduktionsplanungSlot {
  slot: number;
  maitreCode: string;
  recipeCode: string;
  skuCode: string;
  recipeName: string;
  volRun1: number;    // Freitag-Lieferung (DE) / TK (Nordics)
  volRun2: number;    // Montag-Lieferung (DE) / TV (Nordics)
  totalVol: number;
  paletten?: string;  // z. B. "5P, 2K"
}

export interface ProduktionsplanungEntry {
  week: string;          // "2026-W22"
  market: string;        // "DE" | "NORDICS"
  boxVolRun1: number;
  boxVolRun2: number;
  maxKapaPerDay: number;
  startTime: string;
  endTime: string;
  slots: ProduktionsplanungSlot[];
  generatedAt: string;
}

// === Fulfillment Report: FCMS Inbound-Lieferungen ============================
// Aus "Logistik - FCMS Meals" Tab – tatsächlich eingegangene PO-Positionen.

export interface FcmsInboundRow {
  poNumber: string;
  unloadDateLocal: string;
  itemNumber: string;
  description: string;
  uom: string;
  poExpected: number;
  totalReceived: number;
  variancePct: string;
}

export interface FcmsInboundData {
  week: string;
  generatedAt: string;
  rows: FcmsInboundRow[];
}
