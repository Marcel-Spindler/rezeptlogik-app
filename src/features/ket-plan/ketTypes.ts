// Domänen-Typen und Equipment-Konstanten für KET Plan / WO Breakdown.
import type { EquipBibleEntry } from "../../core/types";

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
}

export interface EquipBatch {
  equip: string;        // "BRAISER"
  label: string;        // "Braiser"
  capacityKg: number;
  batches: number;
  perBatchKg: number;
  // Set only for BRAISER when capacityKg came from a Kuechenbible match
  // (instead of the manual/default caps value) — lets the UI label the source.
  bibleMatch?: EquipBibleEntry | null;
}

export interface BatchCalc {
  totalKg: number;
  equipBatches: EquipBatch[];   // je Cook Method mit bekannter Kapazität
  primaryEquip: string | null;  // wichtigstes Equipment (erster Treffer in EQUIP_PRIORITY)
  capacityKg: number | null;
  // Set when primaryEquip === "BRAISER" and capacityKg came from a Kuechenbible match.
  primaryCapBibleMatch?: EquipBibleEntry | null;
  batches: number;              // Batche des primaryEquip
  perBatchKg: number;
  resolvedCookMethods: string[];
  manualEquipment?: ManualEquipmentOverride | null;
  ingredients: IngCalc[];
  recipeFound: boolean;
  subRecipeFound: boolean;
  cookingInstructions: string | null;
  subRecipeInstructions: string | null;
  subRecipeInstructionsDE: string | null;
  subRecipeInstructionsGermanFallback: boolean;
}
