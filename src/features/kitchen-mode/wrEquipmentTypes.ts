// Kitchen Mode / Breakdown – Domänen-Typen (Rezept-Einträge, Ingredient-Zeilen, Pfad-Aggregate,
// Work-Order-Match, Meal-Aggregat, GN-Kapazitäts-/Tray-Hints, manuelle Overrides).
import type { Market } from "../../core/types";
import { PTN_ID_TRAY_SPECS, tokenize } from "./wrEquipmentFormat";

// ═══════════════════════════════════════════════════════════════════════════
// WANNEN-RECHNER – Rezeptstil mit Meal/Sub/SubSub und kg + Wannen
// ═══════════════════════════════════════════════════════════════════════════

export const WANNEN: { label: string; kg: number }[] = [
  { label: "5 kg",   kg: 5   },
  { label: "10 kg",  kg: 10  },
  { label: "15 kg",  kg: 15  },
  { label: "25 kg",  kg: 25  },
  { label: "40 kg",  kg: 40  },
  { label: "60 kg",  kg: 60  },
  { label: "80 kg",  kg: 80  },
  { label: "120 kg", kg: 120 },
];

export const MARKET_PRIO_NEW: Market[] = ["DE", "BENL", "DKSE"];
export const BREAKDOWN_OVERRIDE_STORAGE_KEY = "rezeptlogik_v1_breakdown_item_overrides";

export interface WR_RecipeEntry {
  key: string;
  code: string;
  name: string;
  portions: number;
  mode: "fertig" | "roh";
  workOrder?: string;
  kitchenDay?: string;
}

export interface WR_IngRow {
  ingredientId: string;
  name: string;
  category: string;
  uom: string;
  overrideKey: string;
  totalQty: number;
  totalKg: number | null;
  pieceKgHint: number | null;
  inferredPcsPerTray: number | null;
  inferredGnType: string | null;
  // Yield-Verlust
  yieldPct: number | null;   // 0..1 (z. B. 0.85 = 85 % Ausbeute, 15 % Verlust)
  lossKg: number | null;     // = totalKg * (1 - yieldPct)
}

export interface WR_PathAgg {
  sub1: string;
  sub2: string;
  sub3: string;
  rows: WR_IngRow[];
  totalKg: number;
  totalLossKg: number;       // Summe der Yield-Verluste aller Zutaten
  capacityKgHint: number | null;
  equipmentHint: string | null;
  isBrining: boolean;        // 1:1 Wasserzugabe beim Brinen → Wannenvolumen verdoppelt sich
  cookingMethod: string;     // primäre Cooking-Methode des Sub-Meals (tiefste Ebene)
  cookCategories: string;    // kombinierte Sub-Rezept-Kategorien
}

export interface WRBreakdownPlan {
  briningFactor: number;
  effectiveTubKg: number;
  capacityKg: number | null;
  count: number | null;
  woSizeKg: number | null;
}

export interface WRMatchedWorkOrder {
  workOrder: string;
  kitchenDay: string;
  targetPortions: number | null;
  woCookedPortions: number | null;
  cookedPortionsExcess: number | null;
  cookMethods: string;
  kitchenStatus: string;
  stagingStatus: string;
  unlockedEta: string;
  workOrderComment: string;
}

export interface WR_MealAgg {
  key: string;
  code: string;
  name: string;
  mode: "fertig" | "roh";
  workOrder?: string;
  kitchenDay?: string;
  portionsInput: number;
  portionsEffective: number;
  paths: WR_PathAgg[];
  totalKg: number;
  totalLossKg: number;       // Gesamtverlust über alle Pfade
}

export type WREntryMode = "recipe" | "wo";

export interface WRCapacityHint {
  subRecipeKey: string;
  subRecipeName: string;
  capacityKg: number;
  equipment: string | null;
}

export interface WRTrayHint {
  key: string;
  pcsPerTray: number;
  gnType?: string;  // e.g. "GN 2/1", "GN 1/1"
}

export function parseGnType(spec: string): string | null {
  const m = spec.match(/GN\s*(\d+)[:/](\d+)/i);
  if (!m) return null;
  return `GN ${m[1]}/${m[2]}`;
}

export function wrLookupGnType(trayHints: WRTrayHint[], ingredientName: string, ingredientId?: string): string | null {
  if (ingredientId && PTN_ID_TRAY_SPECS[ingredientId]) return "GN 2/1";
  const keyTokens = new Set(tokenize(ingredientName));
  if (keyTokens.size === 0) return null;
  let best: { hintSize: number; gnType: string } | null = null;
  for (const hint of trayHints) {
    if (!hint.gnType) continue;
    const hintTokens = new Set(tokenize(hint.key));
    if (hintTokens.size === 0) continue;
    let overlap = 0;
    for (const t of hintTokens) { if (keyTokens.has(t)) overlap++; }
    if (overlap < hintTokens.size) continue;
    if (!best || hintTokens.size > best.hintSize) best = { hintSize: hintTokens.size, gnType: hint.gnType };
  }
  return best ? best.gnType : null;
}

export interface WROverride {
  qty?: number;
  kg?: number;
  pcsPerTray?: number;
}

