// Typen für das "F_VE Transparency Plan"-GSheet (eigene Datei, Sheet-ID
// 1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY — unabhängig von allen anderen
// Sheets in gsheetTypes.ts). Namenskonvention "Transparency<Tab>..." bewusst,
// um mit den drei bereits bestehenden "Station"-Konzepten im Code nicht zu
// kollidieren (Production-Plan-Stationsflags, GSheet-Utilization-Block,
// WMS-Pipeline-StationKey — siehe wms-overview/wmsTypes.ts).

// ════════════════════════════════════════════════════════════════════════════
// KERN: WIEGUNGEN (Tab "Importrange Weights") — drei unabhängige Ketten
// (Raw/Pre-Blast/Post-Blast), NICHT zeilenweise miteinander verknüpft. Jede
// Kette wird separat über ihre eigenen Spalten extrahiert (siehe
// parseWeighingLedger.ts) — analog zu den bestehenden Preblast/Postblast-
// Typen, nur eben aus diesem anderen Sheet. Die RTI-Seitenspalten dieses Tabs
// (rechts, ab Spalte ~17) sind ein manuell-selektiertes Einzel-Meal-Panel wie
// "Easier overview" und werden bewusst NICHT geparst — RTEM (unten) liefert
// dasselbe strukturiert für alle Subrezepte gleichzeitig.
// ════════════════════════════════════════════════════════════════════════════

export interface TransparencyRawWeightEntry {
  workOrder: string;
  skuCode: string;
  subRecipeName: string;
  weightKg: number;
}

export interface TransparencyPreBlastEntry {
  workOrder: string;
  skuCode: string;
  subRecipeName: string;
  weightKg: number;
  piecesPerRack: number | null;
}

export interface TransparencyPostBlastEntry {
  workOrder: string;
  skuCode: string;
  weightKg: number;
  recipeName: string;
  subRecipeName: string;
}

export interface TransparencyWeighingData {
  raw: TransparencyRawWeightEntry[];
  preBlast: TransparencyPreBlastEntry[];
  postBlast: TransparencyPostBlastEntry[];
  rawKgByWorkOrder: Map<string, number>;
  preBlastKgByWorkOrder: Map<string, number>;
  postBlastKgByWorkOrder: Map<string, number>;
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// KERN: STATUS DURCH DIE STATIONEN (Tab "Transperancy Total Overview") — eine
// Zeile je (Run, Work Order, Subrezept), Staging -> Kitchen -> Post.
// ════════════════════════════════════════════════════════════════════════════

export interface TransparencyFlowRow {
  run: string;
  plannedKitchenDay: string;
  workOrder: string;
  comment: string;
  recipeCode: string;
  recipeName: string;
  subRecipeName: string;
  plannedMeals: number | null;
  plannedStagingKg: number | null;
  kitchenKg: number | null;
  plannedPostKg: number | null;
  yieldPct: number | null;
  logisticStaged: boolean;
  kitchenCooked: boolean;
  logisticStatus: string;
  logisticOwner: string;
}

export interface TransparencyFlowData {
  rows: TransparencyFlowRow[];
  byWorkOrder: Map<string, TransparencyFlowRow[]>;
  byRecipeCode: Map<string, TransparencyFlowRow[]>;
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// KERN: MEAL-EBENE PLAN VS. ACTUALS (Tab "Planning Check")
// ════════════════════════════════════════════════════════════════════════════

export interface TransparencyPlanningCheckRow {
  recipeCode: string;
  recipeName: string;
  slot: string;
  total: number | null;
  planned1: number | null;
  planned2: number | null;
  planned3: number | null;
  plannedVsForecast: number | null;
  plannedRemainingToPlate: number | null;
  actualsByDay: { mon: number | null; tue: number | null; wed: number | null; thu: number | null; fri: number | null; sat: number | null };
  forecastDeltaTotal: number | null;
}

export interface TransparencyPlanningCheckData {
  week: string;
  rows: TransparencyPlanningCheckRow[];
  byRecipeCode: Map<string, TransparencyPlanningCheckRow>;
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// KERN: RTI/GEKOCHT-BESTAND JE SUBREZEPT (Tab "RTEM")
// ════════════════════════════════════════════════════════════════════════════

export interface TransparencyRtemRow {
  slot: string;
  menuWeek: string;
  recipeCode: string; // aus recipeName extrahierter FV-Code, NICHT die interne "REC-..."-Id
  internalRecipeId: string;
  recipeName: string;
  demandAmount: number | null;
  scheduledPortions: number | null;
  subRecipeCode: string;
  subRecipeName: string;
  cookMethods: string;
  quantityCooked: number | null;
  totalCookedPortions: number | null;
  totalMapped: number | null;
  estimatedRtiLeft: number | null;
  actualRtiLeft: number | null;
}

export interface TransparencyRtemData {
  rows: TransparencyRtemRow[];
  byRecipeCode: Map<string, TransparencyRtemRow[]>;
  bySubRecipeName: Map<string, TransparencyRtemRow[]>;
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// KERN: BEDARF (Tab "[Import] Forecast") — Superset der bestehenden
// ForecastData (gsheetTypes.ts), aus einem anderen Sheet.
// ════════════════════════════════════════════════════════════════════════════

export interface TransparencyForecastRow {
  hfWeek: string;
  recipeCode: string;
  mealPref: string;
  recipeName: string;
  benlVolumeBuffer: number | null;
  dkseVolumeBuffer: number | null;
  deVolumeBuffer: number | null;
}

export interface TransparencyForecastData {
  rows: TransparencyForecastRow[];
  byRecipeCode: Map<string, TransparencyForecastRow>;
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// WO-/STATIONS-STATUS (Tabs "WMS WO", "ET", "Input Kitchen")
// ════════════════════════════════════════════════════════════════════════════

export interface TransparencyWmsWoRow {
  week: string;
  workOrder: string;
  status: string;
  subRecipeName: string;
  subRecipeId: string;
  stagingDay: string;
  targetQty: number | null;
  uom: string;
  cookMethods: string;
}

export interface TransparencyWmsWoData {
  rows: TransparencyWmsWoRow[];
  byWorkOrder: Map<string, TransparencyWmsWoRow>;
  lastUpdated: number;
}

export interface TransparencyEtRow {
  cookingDay: string;
  workOrder: string;
  recipeId: string;
  recipeName: string;
  subRecipeName: string;
  stagingStatus: string;
  kitchenStatus: string;
}

export interface TransparencyEtData {
  rows: TransparencyEtRow[];
  byWorkOrder: Map<string, TransparencyEtRow>;
  lastUpdated: number;
}

export interface TransparencyInputKitchenRow {
  priority: string;
  woStagingBy: string;
  deboxDay: string;
  woReady: boolean;
  hotKitchenWeekday: string;
  dateNeeded: string;
  workOrder: string;
  recipeName: string;
  subRecipeName: string;
  cookMethods: string;
  targetPortions: number | null;
  stagingStatus: string;
  kitchenStatus: string;
  allergens: string;
}

export interface TransparencyInputKitchenData {
  rows: TransparencyInputKitchenRow[];
  byWorkOrder: Map<string, TransparencyInputKitchenRow>;
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// LOGISTIK/DOWNSTREAM (Sleeving, Printing, BENL Outbound)
// ════════════════════════════════════════════════════════════════════════════

export interface TransparencySleevingOutputRow {
  day: string;
  recipeCode: string;
  recipeName: string;
  from: string;
  to: string;
  boxCount: number | null;
  meals: number | null;
  comment: string;
}

export interface TransparencySleevingRequirementRow {
  slot: string;
  recipeCode: string;
  recipeName: string;
  needsThuTotal: number | null;
  needsFriTotal: number | null;
  needsSatTotal: number | null;
}

export interface TransparencySleevingData {
  output: TransparencySleevingOutputRow[];
  requirements: TransparencySleevingRequirementRow[];
  lastUpdated: number;
}

export interface TransparencyPrintingRow {
  mealCode: string;
  mealName: string;
  region: string;
  quantity: number | null;
  done: boolean;
  comment: string;
}

export interface TransparencyPrintingData {
  output: TransparencyPrintingRow[];
  requirements: TransparencyPrintingRow[];
  lastUpdated: number;
}

export interface TransparencyBenlOutboundDayBlock {
  day: "thu" | "fri" | "sat";
  ready: number | null;
  minimum: number | null;
  outbound: number | null;
  minimumDelta: number | null;
  overMin: number | null;
}

export interface TransparencyBenlOutboundRow {
  slot: string;
  recipeCode: string;
  recipeName: string;
  total: number | null;
  byDay: Record<"thu" | "fri" | "sat", TransparencyBenlOutboundDayBlock>;
}

export interface TransparencyBenlOutboundData {
  rows: TransparencyBenlOutboundRow[];
  byRecipeCode: Map<string, TransparencyBenlOutboundRow>;
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// AUSFÜHRUNG/HOLDING (Plating Execution Tracking, Counting Plating Holding)
// ════════════════════════════════════════════════════════════════════════════

export interface TransparencyPlatingExecutionRow {
  productionShift: string;
  workOrder: string;
  recipeName: string;
  recipeWoMapped: number | null;
  recipeWoTarget: number | null;
  platingStatus: string;
  manualPlatingStatus: string;
}

export interface TransparencyPlatingExecutionData {
  rows: TransparencyPlatingExecutionRow[];
  byWorkOrder: Map<string, TransparencyPlatingExecutionRow>;
  lastUpdated: number;
}

export interface TransparencyPlatingHoldingRow {
  workOrder: string;
  subRecipeName: string;
  quantity: number | null;
}

export interface TransparencyPlatingHoldingData {
  rows: TransparencyPlatingHoldingRow[];
  byWorkOrder: Map<string, TransparencyPlatingHoldingRow[]>;
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// KPI/LOG (Kitchen KPIs, Issue Tracker)
// ════════════════════════════════════════════════════════════════════════════

export interface TransparencyKitchenKpiSeries {
  label: string;
  valuesByDate: Record<string, number | null>;
}

export interface TransparencyKitchenKpiData {
  dates: string[];
  series: TransparencyKitchenKpiSeries[];
  lastUpdated: number;
}

export interface TransparencyIssueRow {
  date: string;
  issue: string;
  description: string;
  rootCause: string;
  action: string;
  departments: string;
}

export interface TransparencyIssueTrackerData {
  rows: TransparencyIssueRow[];
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// GENERISCHER FALLBACK — für Tabs ohne dedizierten Parser (kaputte/leere/
// reine Referenz-Tabs, siehe TRANSPARENCY_TAB_REGISTRY): Rohzeilen 1:1
// durchgereicht, damit sie in der App trotzdem sichtbar/durchsuchbar sind,
// ohne dass jeder einzeln vorab typisiert werden muss.
// ════════════════════════════════════════════════════════════════════════════

export interface TransparencyRawTabData {
  rows: string[][];
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// PRODUZIERBARKEIT — eigene, in der App berechnete Regel (siehe
// transparencyProducibility.ts), NICHT die Sheet-eigene "Ready to plate?"-
// Formel (die ist nur für ein manuell selektiertes Meal sichtbar).
// ════════════════════════════════════════════════════════════════════════════

export type SubmealProducibilityStatus = "ready" | "partial" | "blocked" | "unknown";

export interface SubRecipeProducibility {
  subRecipeName: string;
  workOrders: string[];
  plannedPostKg: number;
  weighedPostKg: number;
  pct: number | null; // weighedPostKg / plannedPostKg * 100, null wenn kein Soll bekannt
  weighedComplete: boolean;
  actualRtiLeft: number | null;
}

export interface MealProducibility {
  recipeCode: string;
  recipeName: string;
  status: SubmealProducibilityStatus;
  subRecipes: SubRecipeProducibility[];
  blockedReasons: string[];
}

export interface TransparencyProducibilityResult {
  byRecipeCode: Map<string, MealProducibility>;
  meals: MealProducibility[];
  readyCount: number;
  partialCount: number;
  blockedCount: number;
  // Rezepte, die NICHT im "Planning Check"-Tab der aktuell gewählten KW
  // stehen (kommen nur über Work Orders anderer Wochen in "Transperancy Total
  // Overview" vor, das über viele Wochen/Runs kumuliert) — bewusst getrennt
  // von "meals" gehalten statt stillschweigend mitgezählt, siehe
  // transparencyProducibility.ts.
  otherWeekMeals: MealProducibility[];
  weekNum: number | null;
}
