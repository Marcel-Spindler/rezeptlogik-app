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
// POSTBLAST-WIEGUNGEN (Haupt-Daten-Tab)
// ════════════════════════════════════════════════════════════════════════════

export interface PostblastEntry {
  timestamp: string;
  date: string;
  workOrder: string;
  skuCode: string;
  subRecipeName: string;
  rawWeightKg: number;
  subSubRecipe: string;
  postBlastKg: number;
  targetKg: number;
}

export interface PostblastData {
  entries: PostblastEntry[];
  byWorkOrder: Map<string, PostblastEntry[]>;
  bySubRecipe: Map<string, PostblastEntry[]>;
  totalWeightKg: number;
  lastEntry: PostblastEntry | null;
  lastUpdated: number;
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
  // "done" = reguläre WO fertig gewogen (Kitchen hat abgeschlossen).
  // "not-needed" = Mensch hat im Sheet explizit "kein Backfill nötig" markiert (meist Überschuss).
  // "open" = noch keine Entscheidung/Wiegung. "unknown" = Status-Zelle mit unerwartetem Wert.
  status: "done" | "not-needed" | "open" | "unknown";
  // true = diese Zeile ist eine Wiederholung eines bereits im selben Meal-Block
  // vorkommenden Sub-Rezepts — d.h. eine im RTI-Rechner bereits vorbereitete
  // Backfill-Kandidaten-WO mit echter WO-Nummer, keine reguläre Erstproduktion.
  isBackfillCandidate: boolean;
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

// ════════════════════════════════════════════════════════════════════════════
// ET — MASTER-WORKORDER-LISTE (Tab "ET" im selben Sheet)
// ════════════════════════════════════════════════════════════════════════════
// Enthält JEDE im WMS angelegte WO über mehrere Kalenderwochen hinweg (die WO-
// Nummer selbst trägt die KW als Präfix, z.B. "35-222" = KW35) — die einzige
// Quelle, die live zeigt, welche Wochen gerade WIRKLICH im System sind. Der
// Firestore-Produktionsplan kann hinterherhinken (nur die "neueste" KW, die
// zufällig importiert wurde); dieses Tab nicht.

export interface EtEntry {
  cookingDay: string;   // ISO "2026-08-10", aus "2026/08/10" im Sheet
  workOrder: string;    // "34-1"
  recipeId: string;
  recipeCode: string;   // "FV4055A"
  recipeName: string;
  subRecipeName: string;
}

export interface EtData {
  entries: EtEntry[];
  byWorkOrder: Map<string, EtEntry>;
  lastUpdated: number;
}
