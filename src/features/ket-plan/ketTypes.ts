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
  // Factor-Regeln (Matteos capacity-rules.js): SEPARATE-Tag bzw. Spice-Room-Zutat —
  // wird in der PDF/UI immer zuerst sortiert + unterstrichen dargestellt.
  separate: boolean;
  spiceRoom: boolean;
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
}
