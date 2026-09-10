import type { RtiSubShortfall } from "./rtiBackfillCalculator";

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
// "rti-only" = Bedarf allein aus dem RTI-Sheet (Planned Target vs. Actuals),
// noch kein Küchen-Gewichts-/LinePlaiting-Signal dazu.
export type BackfillConfidence = "confirmed" | "kitchen-only" | "plating-only" | "rti-only";
export type BackfillPriority = "critical" | "behind" | "on-track";

export interface CombinedBackfillNeed {
  recipeCode: string;         // Anzeige-Code (LinePlating > RTI > Küche)
  // Alle rohen Code-Varianten, die für dieses Meal zusammengeführt wurden
  // (z.B. FV4063A/FV4063B nach SKU-/Sleeve-Druckänderung — dieselbe 4-Ziffer,
  // dasselbe Meal). Länge > 1 = die Quellen benutzen unterschiedliche Buchstaben.
  codeVariants: string[];
  recipeName: string;

  // Küchen-Signal (aus postblastMatch.ts BackfillNeed[], je Meal aufsummiert)
  kitchenMissingKg: number;
  kitchenMissingPortions: number;
  kitchenPriority: BackfillPriority | null; // null = keine Küchen-Meldung für dieses Meal
  kitchenSubRecipes: string[];

  // Plating-Signal (LinePlating-Tab, Di-Do "shortage"-Phase — Detail-Anzeige)
  platingPlannedPortions: number;   // Summe Planned über alle shortage-Zeilen (Referenz fürs Verhältnis)
  platingShortagePortions: number;  // Summe der Fehlmengen (nur negative Deltas)
  platingShortageReasons: string[]; // dedupliziert
  platingDaysAffected: string[];

  // LinePlating über die GANZE KW (alle Tage): Σ Planned − Σ Actual. Rohe
  // Fehlmenge, tendenziell zu hoch (ein Teil war Puffer) — treibt den Bedarf
  // nur, solange noch kein "{Tag} needs" eingetragen ist.
  lpShortfallPortions: number;
  lpWeek: string;                   // "W36" — aus dem LinePlating-Tab-Kopf
  lpStatusText: string;             // "Ready" / "blocked" / "done" vom letzten Tag

  // "{Tag} needs" des zuletzt befüllten Tages (Fr schlägt Do schlägt Di) — der
  // vom Plating-Team gepflegte Restbedarf. Die maßgebliche Backfill-Zahl.
  minNeededPortions: number | null;

  // Samstag: Ergebnis der tatsächlich gefahrenen Backfill-Charge(n)
  backfillResultPortions: number | null;
  backfillResultComments: string[];

  // RTI Plating Holding — Fertigware-Puffer laut RTI-Sheet (Sub-Rezept-Summe).
  rtiHoldingKg: number;

  // RTI Plating Tracker (gid=1486350915) — das Sheet, das den Backfill EXAKT
  // errechnet: Meal-Block Planned Target vs. Actuals. Treibt jetzt
  // recommendedBackfillPortions (source "rti"). rtiKitchenDone = alle echten
  // Sub-Rezepte im Sheet auf "done"/"no" → der Rückstand ist final.
  // null/false, wenn das Meal nicht im RTI-Sheet steht.
  rtiPlannedTarget: number | null;
  rtiActuals: number | null;
  rtiShortfallPortions: number;      // größter offener Sub-Engpass (≈ Planned − Actuals)
  rtiRecommendedBuffered: number;    // dito, mit dem %-Sicherheitspuffer des Sheets (Spalte "Backfill Meals")
  rtiKitchenDone: boolean;
  rtiHasOpenSubs: boolean;
  rtiVetoed: boolean;                // alle Engpass-Sub-Rezepte "no" → kein Backfill
  // true = Planned Target / Actuals standen NICHT im RTI-Sheet-Kopf, sondern
  // wurden aus App-Daten hergeleitet (Forecast/Redzone/LinePlaiting). Der
  // Backfill ist dann eine Schätzung — im RTI-Sheet-Kopf nachtragen.
  rtiTargetEstimated: boolean;
  rtiTargetSourceLabel: string;      // z.B. "Forecast + Redzone" (leer wenn aus dem Sheet)
  rtiBackfillCandidateSubs: string[];
  // Pro Sub-Rezept, das laut RTI-Rechner nachgekocht werden muss (Spalten
  // "Minimum need" / "Backfill Meals" / Status). Treibt die Backfill-Wächter-
  // Ansicht und die app-weite "Backfill nötig"-Meldung. Leer, wenn das Meal
  // nicht im RTI-Sheet steht oder der Rückstand komplett aus Holding gedeckt ist.
  rtiSubShortfalls: RtiSubShortfall[];

  // WMS live: tatsächlicher Warenbestand in Plating-Holding-Locations (PLH),
  // direkt aus Snowflake — der physische Puffer zwischen Post-Blast und
  // Plating (siehe combineBackfills.ts). Verlässlicher als rtiHoldingKg, aber
  // nur für WOs verfügbar, deren Sub-Rezept sich über die SKU auflösen lässt.
  // null = (noch) keine Daten / SKU nicht auflösbar, NICHT "Puffer ist leer".
  liveWmsHoldingKg: number | null;

  // Redzone Live (Maschinen-Zählung an der Plating-Linie, 24-h-Fenster) — nur
  // wenn der lokale WMS-Server läuft, online sonst leer. Rein informativ
  // ("was zeigt die Linie GERADE JETZT"), fließt NICHT in die Zahl ein.
  liveRedzonePortions: number | null;
  liveRedzoneStatus: "active" | "completed" | null;

  // Die eine Zahl, die zählt: wie viele Portionen dieses Meals noch
  // nachproduziert werden müssen — nach bestem verfügbarem Signal (siehe
  // recommendedSource). Sa-Ergebnis wird NICHT automatisch abgezogen (siehe
  // backfillResultPortions/Kommentar in combineBackfills.ts). 0, wenn kein
  // Signal einen Bedarf zeigt.
  recommendedBackfillPortions: number;
  // Woher recommendedBackfillPortions kommt, priorisiert:
  // 1) "lineplating" — Kitchen-Priority "LinePlating W{XX}": "{Tag} needs" des
  //    zuletzt befüllten Tages. Der vom Plating-Team gepflegte Restbedarf.
  // 2) "plating"     — LinePlating Σ(Planned − Actual) über die KW, solange noch
  //    kein "{Tag} needs" eingetragen ist (frühe Woche). Rohe Fehlmenge.
  // 3) "rti"         — RTI-Wiegung (Weight-Tracking): Planned Target − Actuals.
  //    Rückfall + bestätigt den Bedarf und schlüsselt ihn pro Sub-Rezept auf.
  // 4) "kitchen"     — Küchen-Schätzung aus Pre-/Post-Blast-Gewichten
  // "none"           — kein Signal, kein Backfill-Bedarf bekannt
  recommendedSource: "lineplating" | "plating" | "rti" | "kitchen" | "none";

  confidence: BackfillConfidence;
  priority: BackfillPriority;
}

// ─── Bestandsprüfung Rohware ─────────────────────────────────────────────────
// Ein Backfill wird IMMER aus Rohware nachgekocht (kein Umbuchen fertiger Ware).
// Geprüft wird deshalb, ob die Brutto-Rohware der zu wenig produzierten Sub-
// Rezepte für recommendedBackfillPortions im WMS-Vollbestand verfügbar ist
// (Status "A", MHD nicht überschritten). Siehe backfillFeasibility.ts.

export type BackfillFeasibilityVerdict = "feasible" | "partial" | "blocked" | "unknown";
// "components" = nur die konkret gemeldeten Sub-Rezepte geprüft;
// "full-meal"  = kein einzelnes Sub-Rezept bekannt, ganzes Meal angesetzt.
export type BackfillFeasibilityScope = "components" | "full-meal";

export interface BackfillFeasibilityIngredient {
  ingredientId: string;
  ingredientName: string;
  subRecipeName: string;
  uom: string;
  grossPerPortion: number;   // Brutto-Rohware pro Endteller-Portion (aus der Rezeptstruktur)
  neededTotal: number;       // grossPerPortion × neededPortions
  availableQty: number;      // Σ actualQty, Status "A", MHD nicht überschritten
  expiredQty: number;        // Σ actualQty, Status "A", aber MHD überschritten (nur Info)
  notInWms: boolean;         // SKU taucht im Vollbestand gar nicht auf (ID-/Namens-Mismatch möglich)
  maxPortions: number;       // floor(availableQty / grossPerPortion)
  isBottleneck: boolean;
}

export interface BackfillFeasibility {
  recipeCode: string;
  verdict: BackfillFeasibilityVerdict;
  scope: BackfillFeasibilityScope;
  neededPortions: number;          // = recommendedBackfillPortions
  maxProduciblePortions: number;   // min über alle Zutaten (0 = blockiert)
  coveragePct: number;             // maxProduciblePortions / neededPortions
  targetSubRecipes: string[];      // Namen der geprüften Sub-Rezepte
  unmatchedComponents: string[];   // Küchen-Meldungen, die nicht in der Struktur gefunden wurden
  bottleneck: BackfillFeasibilityIngredient[];
  ingredients: BackfillFeasibilityIngredient[];
  reason?: string;                 // bei verdict "unknown": warum nicht bewertbar
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
