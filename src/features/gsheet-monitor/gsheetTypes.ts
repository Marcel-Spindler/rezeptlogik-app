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
// LINEPLAITING — eigenes Wochen-Sheet (andere Datei als Postblast/RTI/ET),
// gid ändert sich jede KW (neuer Tab, gleiche Datei — siehe useLinePlaitingGid
// in useGSheetMonitor.ts). Zeitslot-Raster Mo-Sa: Di-Do reguläres Plating mit
// Fehlmenge+Grund, Fr wird daraus der Mindest-Nachproduktionsbedarf ("Min
// Needs") berechnet, Sa laufen die Backfill-Chargen und ihr Ergebnis wird
// festgehalten. Siehe parseLinePlaiting.ts für die Block-Erkennung.
// ════════════════════════════════════════════════════════════════════════════

// "shortage" = Di-Do regulaeres Plating (Fehlmenge wird sichtbar), "min-needs"
// = Fr (Mensch berechnet daraus den Nachproduktionsbedarf), "result" = Sa
// (die Backfill-Charge laeuft, Ergebnis wird festgehalten).
export type LinePlaitingPhase = "shortage" | "min-needs" | "result";

export interface LinePlaitingRow {
  day: string;               // "Tuesday" ... "Saturday" (Montag wird nicht erfasst, keine Plating-Daten)
  time: string;               // "06:00 - 06:30"
  phase: LinePlaitingPhase;
  recipeCode: string;         // "FV0713A"
  meal: string;
  plannedPortions: number;
  actualPortions: number;
  deltaPortions: number;      // actual - planned, negativ = Fehlmenge
  comment: string;
  // true = Spalte "Backfills" enthaelt woertlich "yes" (Di-Do-Flag: als
  // Backfill gemeldet). false bei "Min Needs"/Ergebnis-Zeilen (Fr/Sa) sowie
  // wenn schlicht keine Meldung vorliegt.
  backfillConfirmed: boolean;
  // Zahl aus "Min: 1.400" (Fr) oder einer nackten Zahl in der Backfills-Spalte
  // (Sa) -- null wenn nicht vorhanden/nicht parsbar.
  minNeededPortions: number | null;
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
  rows: LinePlaitingRow[];
  byRecipeCode: Map<string, LinePlaitingRow[]>;
  dayTotals: LinePlaitingDayTotal[];
  lastUpdated: number;
}
