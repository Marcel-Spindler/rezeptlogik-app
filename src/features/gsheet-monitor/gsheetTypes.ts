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
// PRE-BLAST- & POST-BLAST-WIEGUNGEN — zwei getrennte Tabs im selben Sheet.
// Eine Charge wird ZWEIMAL gewogen: einmal direkt nach dem Kochen (Pre-Blast),
// dann noch mal nach dem Blast Chiller (Post-Blast) — dazwischen verliert sie
// an Menge (Schwund/Kühlverlust). Post-Blast ist deshalb das entscheidende
// Ist-Gewicht für Fertig/Kritisch/Backfill (siehe postblastMatch.ts); Pre-Blast
// ist ein früherer Zwischenstatus ("schon gekocht, noch im Chiller") plus die
// Referenz, um den Schwund überhaupt sichtbar zu machen.
// ════════════════════════════════════════════════════════════════════════════

export interface PreblastEntry {
  timestamp: string;
  date: string;
  workOrder: string;
  subRecipeName: string;
  weightKg: number;
  // "Anzahl pro Rack -> Bei Proteins" — nur bei Protein-Chargen befüllt,
  // sonst null. Aktuell nicht weiter ausgewertet, nur durchgereicht.
  piecesPerRack: number | null;
}

export interface PreblastData {
  entries: PreblastEntry[];
  byWorkOrder: Map<string, PreblastEntry[]>;
  bySubRecipe: Map<string, PreblastEntry[]>;
  totalWeightKg: number;
  lastEntry: PreblastEntry | null;
  lastUpdated: number;
}

// Datenqualität der Post-Blast-Quelle (Stand 2026-08-23): "Rezept Name"/
// "SKU code"/die eigene "Timestamp"-Spalte im Sheet sind in der Praxis IMMER
// leer, das Datum in der ersten Spalte fehlt bei über der Hälfte der Zeilen.
// Der Parser füllt nur das DATUM aus der letzten bekannten Zeile vorwärts auf
// (für "heute"-Filter) — erfindet aber nie eine genaue Uhrzeit, wo keine im
// Sheet steht. Tempo-Analysen mit echter Uhrzeit haben dadurch entsprechend
// weniger Datenpunkte als bei Pre-Blast.
export interface PostblastEntry {
  timestamp: string;
  date: string;
  workOrder: string;
  subRecipeName: string;
  weightKg: number;
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

// ════════════════════════════════════════════════════════════════════════════
// LINEPLAITING — "Kitchen Priority List" (Tab "LinePlating W{XX}", ein Tab je
// KW, gleiche Datei — Auto-Wochenwahl bzw. useLinePlaitingGid in
// useGSheetMonitor.ts). Zeitslot-Raster Mo-Sa mit rechtem Meal-Block je Tag:
// Planned vs. Actual, Delta, "{Tag} needs" (Restbedarf laut Plating-Team) und
// Shortage-Grund. Di-Do reguläres Plating, Fr Mindestbedarf, Sa weiterer
// Plating-Tag / Ergebnis.
//
// WICHTIG: Die Spaltenpositionen wandern von KW zu KW (W34 ≠ W35 ≠ W36 — neue
// Spalten Start/Stop/Run Time/Awaiting Del, "Backfills" → "{Tag} needs"). Der
// Parser findet die Spalten deshalb pro Tagesblock über die Header-NAMEN, nicht
// über feste Indizes. Siehe parseLinePlaiting.ts.
// ════════════════════════════════════════════════════════════════════════════

// "shortage" = Di-Do regulaeres Plating (Fehlmenge wird sichtbar), "min-needs"
// = Fr (Mensch berechnet daraus den Nachproduktionsbedarf), "result" = Sa
// (die Backfill-Charge laeuft, Ergebnis wird festgehalten).
export type LinePlaitingPhase = "shortage" | "min-needs" | "result";

export interface LinePlaitingRow {
  week: string;               // "W36" — aus dem Tab-Kopf (leer, wenn nicht lesbar)
  day: string;               // "Tuesday" ... "Saturday" (Montag wird nicht erfasst, keine Plating-Daten)
  time: string;               // "06:00 - 06:30"
  phase: LinePlaitingPhase;
  recipeCode: string;         // "FV0713A"
  meal: string;
  plannedPortions: number;
  actualPortions: number;
  deltaPortions: number;      // actual - planned, negativ = Fehlmenge
  comment: string;
  // true = Spalte "Backfills" enthaelt woertlich "yes" (Alt-Layout ≤ W35).
  // Ab W36 gibt es diese Spalte nicht mehr -> immer false.
  backfillConfirmed: boolean;
  // Fr-Mindestbedarf: gleich dayNeedPortions, aber nur auf der "min-needs"-Phase
  // gesetzt (Abwärtskompatibilität für bestehende Konsumenten). null sonst.
  minNeededPortions: number | null;
  // "{Tag} needs" / "Min Needs THU" — der vom Plating-Team eingetragene
  // Restbedarf dieses Meals für den jeweiligen Tag. null, wenn leer oder als
  // Status-Text ("done") statt Zahl eingetragen. Ersetzt ab W36 die alte
  // "Backfills"/"Min Needs"-Spalte.
  dayNeedPortions: number | null;
  // Status-Text, der in manchen KW in der "Shortage in %"-Spalte am Fr/Sa steht
  // ("Ready" / "blocked" / "blocked WO235" / "done") statt einer Prozentzahl.
  statusText: string;
  shortageReason: string;     // Freitext-Grund, oft mit WO-Nummern/Handrechnung
  shortagePct: number | null; // -delta/planned*100, negativ = Ueberschuss
}

export interface LinePlaitingDayTotal {
  day: string;
  phase: LinePlaitingPhase;
  plannedPortions: number;
  actualPortions: number;
  deltaPortions: number;
  shortagePct: number | null;
}

export interface LinePlaitingData {
  week: string;               // "W36" — aus dem Tab-Kopf, "" wenn nicht lesbar
  rows: LinePlaitingRow[];
  byRecipeCode: Map<string, LinePlaitingRow[]>;
  dayTotals: LinePlaitingDayTotal[];
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// PRODUCTION PLAN — "F_VE Production Plan"-Sheet (eigene Datei, andere ID als
// LinePlaiting/Postblast/RTI/ET), ein Tab pro KW ("W37 - Plating Plan [WIP]"),
// von Marcel von Hand vorgeplant — gid wechselt jede KW (siehe
// useProductionPlanGid in useGSheetMonitor.ts). Anders als LinePlaiting (Ist-
// Tracking der laufenden Woche) ist das hier der VORAB-PLAN für eine
// kommende Woche: welches Meal wird an welchem Tag (So-Sa) geplatet, inkl.
// Cup/Slicing-Vorbereitungstagen.
//
// ZWEI TAB-LAYOUTS (siehe parseProductionPlan.ts, dort dynamisch erkannt):
//   • Einschicht (bis W38, wieder ab W40): Tages-Matrix = Spalten W-AC
//     (0-indiziert 22-28, je 1 Spalte So-Sa), Ready = 30-32, Min Needs = 34-36.
//   • Zweischicht (ab W39): Mo-Fr je zwei Spalten (early/late shift), So+Sa
//     einspaltig → 12 Tagesspalten (22-33), Ready = 35-37, Min Needs = 39-41.
//     Darunter folgt zusätzlich ein zweiter Block "KITCHEN" (eigene Code-
//     Kopfzeile) = der Kochtag-Plan je Meal/Schicht, ohne Ready/Min Needs.
// `byDay` ist in BEIDEN Layouts die pro Wochentag zusammengefasste Sicht
// (Portionen summiert, Stationslabels zusammengeführt); die Schicht-Aufteilung
// liegt zusätzlich in `byShift` (nur beim Zweischicht-Layout gesetzt).
// ════════════════════════════════════════════════════════════════════════════

export type ProductionPlanDay = "Sunday" | "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";

export const PRODUCTION_PLAN_DAYS: readonly ProductionPlanDay[] = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// Zweischicht-Layout: Mo-Fr sind in eine Früh- ("early") und eine Spätschicht
// ("late") aufgeteilt. So/Sa haben keine Schicht-Aufteilung.
export type ProductionPlanShift = "early" | "late";

export const PRODUCTION_PLAN_SHIFTS: readonly ProductionPlanShift[] = ["early", "late"];

// Eine Tageszelle in der Plating-Matrix ist entweder leer, ein Stationslabel
// ("Cup"/"Slicing"/"Cup + Slicing" — Vorbereitungstag) oder eine Portionszahl
// (der tatsächliche Plating-Tag). Beides kann in derselben Zeile an
// unterschiedlichen Tagen vorkommen (Label am Vorbereitungstag, Zahl am
// späteren Plating-Tag).
export type ProductionPlanDayCell =
  | { kind: "empty" }
  | { kind: "station"; label: string }
  | { kind: "portions"; portions: number };

export interface ProductionPlanRow {
  code: string;
  preference: string;
  recipeName: string;
  benl: number;
  nordics: number;
  de: number;
  total: number;
  totalWithBuffer: number;
  complexityScore: number | null;
  subCount: number | null;
  cookStationCount: number | null;
  activeCookMin: number | null;
  passiveHoldMin: number | null;
  stations: { grill: boolean; cup: boolean; butter: boolean; oven: boolean; braiser: boolean; slice: boolean };
  allergens: string;
  // Pro Wochentag zusammengefasst (bei Zweischicht: Früh + Spät gemergt —
  // Portionen summiert, Stationslabels zusammengeführt). In BEIDEN Layouts gesetzt.
  byDay: Record<ProductionPlanDay, ProductionPlanDayCell>;
  // Nur beim Zweischicht-Layout gesetzt: die rohe Früh/Spät-Aufteilung je
  // Mo-Fr-Tag (So/Sa tauchen hier nicht auf, keine Schichten).
  byShift?: Partial<Record<ProductionPlanDay, Record<ProductionPlanShift, ProductionPlanDayCell>>>;
  // "Ready"-Spalten (nur Do/Fr/Sa im Sheet vorhanden) — bis wann die Gesamtmenge fertig sein soll.
  // Im KITCHEN-Block immer null (dort gibt es diese Spalten nicht).
  readyByDay: { thu: number | null; fri: number | null; sat: number | null };
  // "Min Needs"-Spalten (nur Do/Fr/Sa) — negativ = Überschuss, wie bei LinePlaiting.
  minNeedsByDay: { thu: number | null; fri: number | null; sat: number | null };
}

export interface ProductionPlanTotals {
  benl: number | null;
  nordics: number | null;
  de: number | null;
  total: number | null;
  totalWithBuffer: number | null;
}

// Zeilen aus dem KPI-Block unterhalb der Meal-Zeilen (Label in Spalte V,
// Werte je Tag in W-AC) — z.B. "unique meals", "total meals", "per hour",
// "lines", "per hr/per line", "available plating time", "needd plating time"
// (Tippfehler im Original-Sheet, bewusst unverändert übernommen), "cupping time".
export interface ProductionPlanKpiRow {
  label: string;
  byDay: Partial<Record<ProductionPlanDay, number | null>>;
}

// Stationszeilen aus dem "Utilization"-Block (BRAISER, CUPPING, GRILL, OVEN,
// PATTY MAKER, SCOOPER (BUTTER), HOT SHREDDER, IMMERSION BLENDER, PLANETARY
// MIXER) — Auslastung je Station und Tag.
export interface ProductionPlanStationUtilization {
  station: string;
  byDay: Partial<Record<ProductionPlanDay, number>>;
}

// Der zweite "KITCHEN"-Block unter dem Plating-Block (nur Zweischicht-Layout):
// derselbe Zeilen-Aufbau je Meal, aber die Tages-/Schicht-Werte sind die
// geplanten KOCHmengen (Kochtag, meist einen Tag vor dem Plating-Tag).
// readyByDay/minNeedsByDay sind hier immer null.
export interface ProductionPlanKitchen {
  rows: ProductionPlanRow[];
}

export interface ProductionPlanData {
  week: string; // "2026-W37", aus Zeile "Week" / Spalte B
  // "single" = Einschicht-Layout (bis W38, ab W40), "dual" = Zweischicht (ab W39).
  shiftModel: "single" | "dual";
  rows: ProductionPlanRow[];
  totals: ProductionPlanTotals | null;
  kpiRows: ProductionPlanKpiRow[];
  utilization: ProductionPlanStationUtilization[];
  // Nur bei shiftModel === "dual": der Küchenplan-Block unter dem Plating-Block.
  kitchen?: ProductionPlanKitchen;
  lastUpdated: number;
}

// Ein per Namensmuster ("W{NN} - Plating Plan [WIP]") live im Sheet gefundener
// Wochen-Tab -- siehe /production-plan-weeks in scripts/wms-local-server.ts.
// Nur Tabs ab der aktuell laufenden KW aufwaerts, aeltere Tabs im Sheet folgen
// uneinheitlichen Namen (Duplikate, "[Updated] ...", kein "[WIP]"-Suffix) und
// werden absichtlich nicht erkannt.
export interface ProductionPlanWeekOption {
  week: number;   // reine Wochenzahl aus dem Tab-Namen, z.B. 37 (kein Jahr im Tab-Namen enthalten)
  gid: string;
  title: string;
}

// ════════════════════════════════════════════════════════════════════════════
// FORECAST & RECIPE PROFIL — zwei weitere Tabs im selben "F_VE Production
// Plan"-Sheet, aus denen die Production-Plan-Zeilen selbst per VLOOKUP/FILTER
// gespeist werden (siehe parseProductionPlan.ts-Kommentar). Der Production-
// Plan-Tab liefert bereits die von Google Sheets fertig berechneten Werte --
// diese beiden Quellen werden NICHT als Ersatz dafür geholt, sondern für den
// unabhängigen Live-Vergleich (productionPlanLiveCheck.ts): weicht der im
// Production-Plan-Tab eingefrorene Wert von dem ab, was Forecast/Recipe
// Profil gerade jetzt sagen (typischer Fall: eine neue Zeile, deren VLOOKUP-
// Formeln noch nicht heruntergezogen wurden), wird das sichtbar.
// ════════════════════════════════════════════════════════════════════════════

export interface ForecastRow {
  hfWeek: string;
  code: string;
  preference: string;
  recipeName: string;
  benl: number;
  nordics: number;
  de: number;
  total: number;
}

export interface ForecastData {
  week: string;
  rows: ForecastRow[];
  byCode: Map<string, ForecastRow>;
  lastUpdated: number;
}

// "Recipe Profil"-Tab: eine Zeile pro Rezeptcode, global (nicht wochenweise).
// complexityScore = Spalte "Complexity cx" (median-normiert, im Sheet selbst
// live aus Gewichten B3:E3 berechnet) -- die rohe "Complexity raw" wird nicht
// gebraucht, weil der Production-Plan-Tab per VLOOKUP nur die normierte holt.
export interface RecipeProfilRow {
  code: string;
  recipeName: string;
  activeCookMin: number | null;
  cookStationCount: number | null;
  subCount: number | null;
  complexityScore: number | null;
  stationsText: string; // Rohtext, z.B. "BLAST CHILLER, BRAISER, GRILL, ..." -- Basis für die Stationsflags (SEARCH-Vergleich im Sheet)
  allergens: string;
  passiveHoldMin: number | null;
}

export interface RecipeProfilData {
  rows: RecipeProfilRow[];
  byCode: Map<string, RecipeProfilRow>;
  lastUpdated: number;
}

// ════════════════════════════════════════════════════════════════════════════
// SHORTS TRACKER — separates Sheet ("VE Warehouse/Inventory Shorts Tracker"),
// Tab "Shorts Tracker". Rohstoff-/Zutaten-Engpässe, die GANZ AM ANFANG der
// Produktion auftreten (Procurement/Warehouse trägt ein, bevor überhaupt
// gekocht wird) — unabhängig von den Postblast/Preblast-Wiegungen, die erst
// NACH dem Kochen greifen. Sheet ist privat mit dem Service-Account geteilt
// (nicht per gviz/tq-CSV lesbar), läuft daher wie Production Plan/Forecast/
// Recipe Profil über die authentifizierte Route in wms-local-server.ts.
//
// Die "WO"-Spalte trägt hier NUR die laufende Nummer ohne KW-Präfix — anders
// als überall sonst in der App ("<KW>-<Nummer>", siehe weekPrefixFromWoNumber).
// parseShortsTracker.ts rekonstruiert das Präfix aus der "Staging Day"-Spalte,
// damit sich ein Eintrag hier per exakter WO-Nummer mit Postblast/ET/
// Produktionsplan verknüpfen lässt (siehe shortageAlerts.ts).
export interface ShortageEntry {
  rawWorkOrderSuffix: string;
  stagingDay: string; // ISO "2026-08-22", "" falls im Sheet nicht parsbar
  // Rekonstruierte volle WO-Nummer "<KW>-<Nummer>" — null, wenn stagingDay
  // fehlt/nicht parsbar war und die KW deshalb nicht bestimmbar ist.
  workOrder: string | null;
  ingredient: string;
  sku: string;
  shortKg: number;
  recoveryStatus: string;
  ticketNumber: string;
  notes: string;
  filled: boolean;
  // Zeilenindex im Sheet — dient als stabile Identität, um neue/verschwundene
  // Zeilen zwischen zwei Polls zu erkennen (siehe shortageAlerts.ts).
  rowIndex: number;
}

export interface ShortsTrackerData {
  entries: ShortageEntry[];
  byWorkOrder: Map<string, ShortageEntry[]>;
  lastUpdated: number;
}
