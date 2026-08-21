// Domänen-Typen und Equipment-Konstanten für KET Plan / WO Breakdown.
import type { EquipBibleEntry } from "../../core/types";
import type { ChillerAssignment } from "../blast-chiller/blastChillerLogic";

export type WoSortMode = "date" | "wo" | "recipe" | "status" | "batches" | "kg";

export const EQUIP_PRIORITY = [
  "BRAISER",
  "OVEN",
  "PLANETARY MIXER",
  "HORIZONTAL MIXER",
  "PATTY MAKER",
  "HOT SHREDDER",
  "CUPPING",
  "BRINE",
];

export const EQUIP_DEFAULTS: Record<string, number> = {
  BRAISER: 80,
  OVEN: 60,
  "PLANETARY MIXER": 30,
  "HORIZONTAL MIXER": 50,
  "PATTY MAKER": 400,
  "HOT SHREDDER": 20,
  CUPPING: 50,
};

export const EQUIP_LABELS: Record<string, string> = {
  BRAISER: "Braiser",
  OVEN: "Ofen",
  "PLANETARY MIXER": "Planetary Mixer",
  "HORIZONTAL MIXER": "Horizontal Mixer",
  "PATTY MAKER": "Patty Maker",
  "HOT SHREDDER": "Hot Shredder",
  CUPPING: "Cupping",
  BRINE: "Brine",
};

export const LS_CAPS_KEY = "ket_breakdown_caps_v2";

export interface KetRow {
  key: string;
  dateNeeded: string;
  shift: string;
  woNumber: string;
  recipeId: string;
  recipeCode: string;
  recipeName: string;
  subRecipeName: string;
  cookMethods: string[];
  woCookedPortions: number | null;
  targetPortions: number;
  cookedPortionsExcess: number | null;
  stagingStatus: string;
  stagingComment: string;
  kitchenStatus: string;
  unlockedEta: string;
  workOrderComment: string;
}

export interface ManualEquipmentOverride {
  equipment: string;
  capacityKg: number;
}

export interface WoInstruction {
  english: string;
  german: string;
  status: "generated" | "needs_review" | "failed";
  generatedAt?: string;
  model?: string;
}

export interface IngCalc {
  name: string;
  id: string;
  category: string;
  uom: string;
  totalKg: number;
  perBatchKg: number;
  yieldPct: number | null;
  // Stückzahl-Zutaten (pcs/stk/ea): kg bleibt 0, Menge hier.
  totalPcs: number;
  // Allergen dieser konkreten Zutat (aus DetailedIngredient.allergen, nur auf dem
  // Struktur-Pfad verfügbar) — zeigt in der Zutatentabelle direkt, WELCHE Zutat
  // das WO-weite "CONTAINS"-Badge auslöst, statt nur die Gesamtliste zu kennen.
  allergen?: string;
  // Factor-Regeln (Matteos capacity-rules.js): SEPARATE-Tag bzw. Spice-Room-Zutat —
  // wird in der PDF/UI immer zuerst sortiert + unterstrichen dargestellt.
  separate: boolean;
  spiceRoom: boolean;
  // GN-Blech-Bedarf dieser Zutat (siehe ketLogic.resolveGnTrays) — kg-basiert über
  // die Kuechenbible/VEGGIE-DEBOX-Kapazitätsdichte oder stückbasiert über
  // PROTEIN-DEBOX-Tray-Specs. null = keine Blech-Kennzahl für diese Zutat bekannt
  // (z.B. Flüssigkeiten/Saucen, die nur in die Wanne gehen).
  gnTrays: number | null;
  gnType: string | null; // z.B. "GN 2/1"
}

// Aufsummierter GN-Blech-Bedarf, gruppiert nach GN-Größe (nicht austauschbar —
// "12× GN 2/1" und "3× GN 1/1" dürfen nicht zu einer Zahl verschmolzen werden).
export interface GnTraySummary {
  gnType: string;
  trays: number;
}

// Portionierwerkzeug (Scoop/Ladle/…) aus der Sub-Rezept-Definition (Recipe.markets
// SubRecipe.methodType/methodColor, siehe wrResolveSubRecipeYieldInfo) — beantwortet
// "welcher Scoop wird genommen" direkt aus den Rezeptdaten, kein manueller Eintrag nötig.
export interface ScoopInfo {
  yieldGrams: number | null;
  yieldUom: string | null;
  methodType: string | null;
  methodColor: string | null;
}

// Eine eigenständige Zubereitungskomponente innerhalb einer WO — entsteht, wenn
// das gematchte Sub-Rezept im Rezeptbaum selbst ≥2 Kind-Sub-Rezepte mit eigenen,
// unterschiedlichen Cook Methods hat (z.B. "Stuffed Pepper Casserole Base-V2" =
// "Ground Beef - cooked" [BRAISER] + "Stuffed Pepper Casserole Vegetable Mix"
// [OVEN]). Jede Komponente braucht eine eigene, separate Kochanweisung — die
// echten Factor-Produktionsblätter drucken sie als eigene Abschnitte auf
// derselben WO-Karte, nicht als eine vermischte Anweisung.
export interface WoComponent {
  name: string;
  ingredients: IngCalc[];
  totalKg: number;
  resolvedCookMethods: string[];
  equipBatches: EquipBatch[];
  primaryEquip: string | null;
  capacityKg: number | null;
  primaryCapBibleMatch?: EquipBibleEntry | null;
  batches: number;
  perBatchKg: number;
  instructionsEnglish: string | null;
  instructionsGerman: string | null;
  instructionsGermanFallback: boolean;
  // Factor-Produktionsregeln, klassifiziert nach DIESER Komponente eigenem Namen
  // (z.B. "Ground Beef - cooked" → neverBatch) — nicht nach dem zusammengesetzten
  // WO-Namen, der per Zufall ein unpassendes Schlüsselwort treffen kann (z.B.
  // "Stuffed PEPPER Casserole Base-V2" träfe die Paprika-VEG-Regel, obwohl die
  // Komponente eigentlich das Rindfleisch ist). Siehe factorRules.classify().
  rti: boolean;
  neverBatch: boolean;
  factorCapacityKg: number | null;
  factorBatches: number | null;
  factorBatchQtyKg: number | null;
  factorFallbackCapacity: boolean;
  readyMade: boolean;
  // GN-Blech-Bedarf dieser Komponente, aufsummiert über ihre eigenen Zutaten
  // (siehe IngCalc.gnTrays), gruppiert nach GN-Größe.
  gnTraySummary: GnTraySummary[];
  // Portionierwerkzeug für DIESE Komponente (eigener Name) — siehe ScoopInfo oben.
  scoopInfo: ScoopInfo | null;
}

export interface EquipBatch {
  equip: string;        // "BRAISER"
  label: string;        // "Braiser"
  capacityKg: number;
  batches: number;
  // Menge je Batch — Gesamtmenge gleichmäßig auf `batches` verteilt (Küchenchef-Vorgabe:
  // alle Batches gleich groß, kein kleinerer Rest-Batch). Immer <= capacityKg.
  perBatchKg: number;
  remainderKg: number;  // immer 0 (Feld bleibt für bestehende Abfragen erhalten)
  // Auslastung je Batch in % (0–100), gilt einheitlich für alle Batches dieser Equipment-Gruppe.
  utilizationPct: number;
  // Set only for BRAISER when capacityKg came from a Kuechenbible match
  // (instead of the manual/default caps value) — lets the UI label the source.
  bibleMatch?: EquipBibleEntry | null;
  // Wie gut der Bible-Match ist: "exact" (gesamter Name), "substring" (Teilstring), "none".
  matchQuality?: "exact" | "substring" | "none";
}

export interface BatchCalc {
  totalKg: number;
  equipBatches: EquipBatch[];   // je Cook Method mit bekannter Kapazität
  primaryEquip: string | null;  // wichtigstes Equipment (erster Treffer in EQUIP_PRIORITY)
  capacityKg: number | null;
  // Set when primaryEquip === "BRAISER" and capacityKg came from a Kuechenbible match.
  primaryCapBibleMatch?: EquipBibleEntry | null;
  batches: number;              // Batche des primaryEquip (inkl. Rest-Batch)
  perBatchKg: number;           // volle Batch-Kapazität
  remainderKg: number;          // letzter Rest-Batch (0 wenn exakt aufgeht)
  resolvedCookMethods: string[];
  manualEquipment?: ManualEquipmentOverride | null;
  ingredients: IngCalc[];
  recipeFound: boolean;
  subRecipeFound: boolean;
  cookingInstructions: string | null;
  subRecipeInstructions: string | null;
  subRecipeInstructionsDE: string | null;
  subRecipeInstructionsGermanFallback: boolean;

  // ── Factor-Produktionsregeln (portiert aus Matteos factor-recipe-bot) ──────
  // RTI = roher "FA-DE ..."-Artikel ohne Cook Methods → kein Batch, direkt Plating.
  rti: boolean;
  // Fleisch/Fisch, das laut Matteo NIE gesplittet wird (immer als Gesamtmenge zeigen).
  neverBatch: boolean;
  // Kapazität/Batchzahl nach der rezeptnamen-basierten Factor-Klassifizierung —
  // unabhängig von Equipment/Kuechenbible, ergänzt (ersetzt nicht) equipBatches oben.
  factorCapacityKg: number | null;
  factorBatches: number | null;
  factorBatchQtyKg: number | null;
  factorFallbackCapacity: boolean;
  // "Roasted Garlic"/"Roasted Garlic Oil" — wöchentlich fertiges Produkt, nie expandieren.
  readyMade: boolean;
  // Bilinguale (EN/DE) CONTAINS-Allergenliste, aus DetailedIngredient.allergen gesammelt.
  allergensContains: string[];
  // HACCP: welchem Blast Chiller (1-6, Allergen-Trennung) diese WO zugeordnet ist —
  // gleiche Zuteilung wie der eigenständige Blast Chiller Bot. null nur wenn weder
  // Rezept noch Struktur gefunden wurden (kein Allergen-Datenpunkt verfügbar).
  chillerAssignment: ChillerAssignment | null;
  // Warnungen zu unbekannten/unkonvertierbaren Einheiten (z.B. "oz", "cup").
  uomWarnings: string[];
  // true wenn Factor-Regeln (neverBatch/rti) die equipBatches-Logik übersteuern.
  factorOverridesEquip: boolean;
  // Zubereitungskomponenten mit eigener Kochanweisung — leer beim normalen
  // Einzel-Sub-Rezept-Fall, gefüllt nur bei zusammengesetzten Sub-Rezepten
  // (siehe WoComponent oben). equipBatches/batches/perBatchKg oben bleiben in
  // diesem Fall der reine Gesamt-Rohware-Überblick — die belastbaren Batch-
  // Zahlen je Equipment stehen dann in den einzelnen components[].
  components: WoComponent[];
  // GN-Blech-Bedarf über ALLE Zutaten dieser WO (siehe IngCalc.gnTrays), gruppiert
  // nach GN-Größe. Bei zusammengesetzten Sub-Rezepten die Summe aller Komponenten
  // PLUS gemeinsamer/nicht komponenten-gebundener Zutaten (z.B. geteilte Gewürze) —
  // die belastbare Pro-Komponente-Aufschlüsselung steht in components[].gnTraySummary.
  gnTraySummary: GnTraySummary[];
  // Portionierwerkzeug (Scoop/Ladle/…) für das gematchte Sub-Rezept dieser WO — null
  // im zusammengesetzten Fall (components.length > 0), dort steht es je Komponente
  // in components[].scoopInfo statt hier vermischt für die ganze WO.
  scoopInfo: ScoopInfo | null;
}
