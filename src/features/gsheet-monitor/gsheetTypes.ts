// GSheet Monitor – Typen für generisches Google-Sheet-Polling mit erweiterbare Parsern.

export interface GSheetConfig {
  id: string;
  name: string;
  sheetTab: string;
  pollIntervalMs: number;
  parser: string;
}

export interface GSheetSnapshot<T = unknown> {
  timestamp: number;
  hash: string;
  rawCsv: string;
  rows: string[][];
  parsed: T;
}

export interface GSheetChange {
  sheetId: string;
  sheetName: string;
  prevHash: string;
  newHash: string;
  changedRowIndices: number[];
  addedRowIndices: number[];
  removedCount: number;
  timestamp: number;
}

// ════════════════════════════════════════════════════════════════════════════
// RTI-SPEZIFISCHE TYPEN
// ════════════════════════════════════════════════════════════════════════════

export interface RtiSubRecipeEntry {
  workOrder: string;
  subRecipeName: string;
  platingHoldingKg: number;
  rtiPlatingKg: number;
  producedQty: number;
  delta: number;
  deltaPct: number;
  status: "done" | "open" | "unknown";
}

export interface RtiMealBlock {
  mealCode: string;
  mealName: string;
  plannedTarget: number;
  actuals: number;
  delta: number;
  deltaPct: number;
  subRecipes: RtiSubRecipeEntry[];
}

export interface RtiData {
  week: string;
  meals: RtiMealBlock[];
  lastUpdated: number;
}
