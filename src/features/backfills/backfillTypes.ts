// Backfills – Typen für die quellenübergreifende Zusammenführung.
// Führt drei unabhängige Signale pro Meal (recipeCode) zusammen:
// 1) Küche (Postblast Live: Pre-/Post-Blast-Gewicht je Sub-Rezept/WO)
// 2) Plating (LinePlaiting: Di-Do Fehlmenge beim Plating + Grund, Fr Mindest-
//    Nachproduktionsbedarf, Sa Backfill-Ergebnis)
// 3) RTI (Plating-Holding-Puffer)
//
// WICHTIG: Küche (Post-Blast) und Plating sind ZWEI EIGENSTÄNDIGE Kontroll-
// punkte im Produktionsablauf, keine zwei Blickwinkel auf dieselbe Zahl. Ein
// grünes Post-Blast heißt NICHT, dass beim Plating nichts fehlen kann — zu
// spät gekocht, ein Rack im Plating Holding umgefallen/beschädigt, oder ein
// Rechenfehler irgendwo in der Kette, der erst beim tatsächlichen Plaiten
// sichtbar wird. "plating-only" ist deshalb keine Unstimmigkeit, die eine
// Bestätigung durch die Küche braucht, sondern ein für sich genommen
// vollwertiger, eigenständiger Backfill-Bedarf (siehe combineBackfills.ts).
export type BackfillConfidence = "confirmed" | "kitchen-only" | "plating-only";
export type BackfillPriority = "critical" | "behind" | "on-track";

export interface CombinedBackfillNeed {
  recipeCode: string;
  recipeName: string;

  // Küchen-Signal (aus postblastMatch.ts BackfillNeed[], je Meal aufsummiert)
  kitchenMissingKg: number;
  kitchenMissingPortions: number;
  kitchenPriority: BackfillPriority | null; // null = keine Küchen-Meldung für dieses Meal
  kitchenSubRecipes: string[];

  // Plating-Signal (LinePlaiting, Di-Do "shortage"-Phase)
  platingPlannedPortions: number;   // Summe Planned über alle shortage-Zeilen (Referenz fürs Verhältnis)
  platingShortagePortions: number;  // Summe der Fehlmengen (nur negative Deltas)
  platingShortageReasons: string[]; // dedupliziert
  platingDaysAffected: string[];

  // Freitag: von Hand berechneter Mindestbedarf ("Min Needs")
  minNeededPortions: number | null;

  // Samstag: Ergebnis der tatsächlich gefahrenen Backfill-Charge(n)
  backfillResultPortions: number | null;
  backfillResultComments: string[];

  // RTI-Signal (Sheet, von Hand gepflegt)
  rtiHoldingKg: number;

  // WMS live: tatsächlicher Warenbestand in Plating-Holding-Locations (PLH),
  // direkt aus Snowflake — der physische Puffer zwischen Post-Blast und
  // Plating (siehe combineBackfills.ts). Verlässlicher als rtiHoldingKg, aber
  // nur für WOs verfügbar, deren Sub-Rezept sich über die SKU auflösen lässt.
  // null = (noch) keine Daten / SKU nicht auflösbar, NICHT "Puffer ist leer".
  liveWmsHoldingKg: number | null;

  // Redzone Live (Maschinen-Zählung an der Plating-Linie) — nur verfügbar,
  // wenn der lokale WMS-Server läuft (Browser-SSO zu Snowflake, siehe
  // RedzoneContext.tsx), online sonst leer. Rein informativ ("was zeigt die
  // Linie GERADE JETZT"), fließt NICHT in recommendedBackfillPortions ein —
  // andere Zeitbasis (heutiger Run) als der Wochen-Bedarf, und die Zahl darf
  // nicht je nach Umgebung (lokal/online) unterschiedliche Ergebnisse liefern.
  liveRedzonePortions: number | null;
  liveRedzoneStatus: "active" | "completed" | null;

  // Die eine Zahl, die zählt: wie viele Portionen dieses Meals noch
  // nachproduziert werden müssen — nach bestem verfügbarem Signal (siehe
  // recommendedSource). Sa-Ergebnis wird NICHT automatisch abgezogen (siehe
  // backfillResultPortions/Kommentar in combineBackfills.ts). 0, wenn kein
  // Signal einen Bedarf zeigt.
  recommendedBackfillPortions: number;
  // Woher recommendedBackfillPortions kommt, priorisiert:
  // 1) "min-needs"  — Freitags-Handrechnung (Mensch hat direkt am Plating-
  //    Boden mit voller Wochenkenntnis gerechnet, am verlässlichsten)
  // 2) "plating"    — tatsächliche Plating-Fehlmenge Di-Do (Meal-Portionen,
  //    Planned-Actual, real gemessen statt geschätzt)
  // 3) "kitchen"    — Küchen-Schätzung aus Pre-/Post-Blast-Gewichten (einzige
  //    verfügbare Zahl, bevor überhaupt geplated wurde)
  // "none"          — kein Signal, kein Backfill-Bedarf bekannt
  recommendedSource: "min-needs" | "plating" | "kitchen" | "none";

  confidence: BackfillConfidence;
  priority: BackfillPriority;
}

export type BackfillAlertSeverity = "critical" | "warning" | "info";

export interface BackfillAlert {
  id: string;
  severity: BackfillAlertSeverity;
  recipeCode: string;
  recipeName: string;
  title: string;
  message: string;
}
