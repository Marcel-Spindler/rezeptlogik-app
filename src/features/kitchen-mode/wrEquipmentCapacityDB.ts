// Kapazitäts-Datenbank aus dem VEGGIE DEBOX Google Sheet (gid=732210423).
// Spalten: CAPACITY WANNE (kg pro Wanne), KG PRODUCT EA 2:1 GN, MAX. TRAY EA WANNE, OVEN RACK CAPACITY 40/20.
import { norm } from "./wrEquipmentFormat";

export interface EquipmentCapacity {
  category: string;
  item: string;
  /** kg pro Wanne (=kgPerGn21 × traysPerWanne, direkt aus Sheet) */
  wanneKg: number | null;
  /** kg pro GN 2:1 Tray */
  kgPerGn21: number | null;
  /** GN 2:1 Trays pro Wanne */
  traysPerWanne: number | null;
  /** GN Trays pro Ofen-Ladung (null = kein Ofen-Schritt hier) */
  ovenCap: number | null;
}

export interface EquipmentNeeds {
  cap: EquipmentCapacity;
  wannen: number | null;
  trays: number | null;
  ovenLoads: number | null;
}

// ── Vollständige DB ──────────────────────────────────────────────────────────
// Alle Werte direkt aus dem Sheet; null = TBD oder nicht zutreffend
const CAPACITY_DB: EquipmentCapacity[] = [
  // Fresh Vegetable
  { category: "Fresh Vegetable", item: "Fresh & Trimmed Green Bean",           wanneKg: 65,  kgPerGn21: 5,   traysPerWanne: 13, ovenCap: null },
  { category: "Fresh Vegetable", item: "Fresh & Trimmed Green Beans No Spices", wanneKg: 80,  kgPerGn21: 5,   traysPerWanne: 16, ovenCap: null },
  { category: "Fresh Vegetable", item: "Broccoli Florets",                      wanneKg: 45,  kgPerGn21: 3,   traysPerWanne: 15, ovenCap: null },
  { category: "Fresh Vegetable", item: "Shredded Brussel Sprouts",              wanneKg: 70,  kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Fresh Vegetable", item: "Zucchini Noodles",                      wanneKg: 75,  kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Fresh Vegetable", item: "Cherry Tomatoes",                       wanneKg: 110, kgPerGn21: 4,   traysPerWanne: 27, ovenCap: null },
  { category: "Fresh Vegetable", item: "Cauliflower Florets",                   wanneKg: 60,  kgPerGn21: 5,   traysPerWanne: 12, ovenCap: null },
  { category: "Fresh Vegetable", item: "Corn Kernels",                          wanneKg: 100, kgPerGn21: 3,   traysPerWanne: 33, ovenCap: null },
  // Frozen IQF
  { category: "Frozen IQF Vegetable", item: "IQF Green Beans",                 wanneKg: 65,  kgPerGn21: 2,   traysPerWanne: 32, ovenCap: null },
  { category: "Frozen IQF Vegetable", item: "IQF Broccoli Florets",            wanneKg: 45,  kgPerGn21: 3,   traysPerWanne: 15, ovenCap: null },
  { category: "Frozen IQF Vegetable", item: "IQF Cauliflower Florets",         wanneKg: 60,  kgPerGn21: 3,   traysPerWanne: 20, ovenCap: null },
  { category: "Frozen IQF Vegetable", item: "Artichoke Quartered",             wanneKg: 95,  kgPerGn21: 7.2, traysPerWanne: 13, ovenCap: null },
  { category: "Frozen IQF Vegetable", item: "Spinach IQF",                     wanneKg: null,kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  // Cut / Processed Vegetable
  { category: "Cut Vegetable", item: "1-1/2 Cut Green Beans",                  wanneKg: 105, kgPerGn21: 3,   traysPerWanne: 35, ovenCap: null },
  { category: "Cut Vegetable", item: "Mixed 5mm Diced Vegetables",             wanneKg: 100, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Cut Vegetable", item: "Mixed 10mm Diced Vegetables",            wanneKg: 100, kgPerGn21: 3,   traysPerWanne: 33, ovenCap: null },
  { category: "Cut Vegetable", item: "Diced Broccoli",                         wanneKg: 115, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Cut Vegetable", item: "Diced Cauliflower",                      wanneKg: 115, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Cut Vegetable", item: "Halve Brussel Sprouts",                  wanneKg: 60,  kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Cut Vegetable", item: "10mm Diced Zucchini",                    wanneKg: 110, kgPerGn21: 3,   traysPerWanne: 36, ovenCap: null },
  { category: "Cut Vegetable", item: "10mm Diced Cabbage",                     wanneKg: 60,  kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Cut Vegetable", item: "Cauliflower Rice",                       wanneKg: 100, kgPerGn21: 6.8, traysPerWanne: 14, ovenCap: null },
  { category: "Cut Vegetable", item: "10mm Diced Pepper",                      wanneKg: 105, kgPerGn21: 8,   traysPerWanne: 13, ovenCap: null },
  { category: "Cut Vegetable", item: "5mm Shredded Cabbage",                   wanneKg: 70,  kgPerGn21: 5.6, traysPerWanne: 12, ovenCap: null },
  { category: "Cut Vegetable", item: "5mm Sliced Peppers",                     wanneKg: 100, kgPerGn21: 6,   traysPerWanne: 16, ovenCap: null },
  // Root Vegetable
  { category: "Root Vegetable", item: "10mm Coin Cut Carrot",                  wanneKg: 70,  kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Root Vegetable", item: "5mm Coin Cut Carrot",                   wanneKg: 70,  kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Root Vegetable", item: "10mm Diced Russet Potatoes",            wanneKg: 105, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Root Vegetable", item: "10mm Diced Yukon Potatoes",             wanneKg: 105, kgPerGn21: 3,   traysPerWanne: 35, ovenCap: null },
  { category: "Root Vegetable", item: "10mm Diced Sweet Potatoes",             wanneKg: 105, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Root Vegetable", item: "5mm Diced Russet Potatoes",             wanneKg: 105, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Root Vegetable", item: "5mm Diced Yukon Potatoes",              wanneKg: 105, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Root Vegetable", item: "5mm Sliced Russet Potatoes",            wanneKg: 95,  kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Root Vegetable", item: "Wedges Potatoes",                       wanneKg: 90,  kgPerGn21: 4,   traysPerWanne: 22, ovenCap: null },
  // Mushroom
  { category: "Mushroom", item: "Sliced Cremini Mushrooms",                    wanneKg: 55,  kgPerGn21: 2,   traysPerWanne: 27, ovenCap: null },
  { category: "Mushroom", item: "Sliced Button Mushrooms",                     wanneKg: 55,  kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Mushroom", item: "Sliced Portobello Mushrooms",                 wanneKg: 55,  kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  // Legume
  { category: "Legume", item: "Edamame Mixed Vegetable",                       wanneKg: 105, kgPerGn21: 2,   traysPerWanne: 52, ovenCap: null },
  { category: "Legume", item: "Edamame",                                       wanneKg: 100, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  // Allium
  { category: "Allium", item: "5mm Diced Leek",                                wanneKg: 100, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Allium", item: "Scallion",                                       wanneKg: 80,  kgPerGn21: 2,   traysPerWanne: null, ovenCap: 40 },
  // Protein
  { category: "Protein Animal", item: "Eggs",                                  wanneKg: 270, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  { category: "Protein Plant", item: "5-Spice Smoked Tofu",                   wanneKg: 100, kgPerGn21: 8,   traysPerWanne: 12, ovenCap: null },
  // Sauce / Liquid
  { category: "Sauce Liquid", item: "Sauces",                                  wanneKg: 270, kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  // Leafy / Herb
  { category: "Leafy Herb", item: "Spinach Fresh",                             wanneKg: null,kgPerGn21: 1,   traysPerWanne: null, ovenCap: null },
  { category: "Leafy Herb", item: "Basil Leaves Fresh",                        wanneKg: null,kgPerGn21: null,traysPerWanne: null, ovenCap: null },
  // Nuts / Dry
  { category: "Nuts Dry", item: "Oven Nuts",                                   wanneKg: null,kgPerGn21: 2,   traysPerWanne: null, ovenCap: null },
  // Pre-Roasted
  { category: "Pre-Roasted", item: "Roasted Garlic",                           wanneKg: null,kgPerGn21: null,traysPerWanne: null, ovenCap: null },
];

// ── Lookup ───────────────────────────────────────────────────────────────────

/** Sucht den besten Eintrag per Token-Overlap (Schwelle 40%). */
export function lookupEquipmentCapacity(ingredientName: string): EquipmentCapacity | null {
  if (!ingredientName) return null;
  const needle = norm(ingredientName);
  const needleTokens = needle.split(/\s+/).filter(Boolean);
  if (!needleTokens.length) return null;
  const needleSet = new Set(needleTokens);

  let bestScore = 0;
  let bestMatch: EquipmentCapacity | null = null;

  for (const entry of CAPACITY_DB) {
    const hayTokens = norm(entry.item).split(/\s+/).filter(Boolean);
    if (!hayTokens.length) continue;
    const haySet = new Set(hayTokens);

    let overlap = 0;
    for (const t of haySet) { if (needleSet.has(t)) overlap++; }

    const score = overlap / Math.max(needleSet.size, haySet.size);
    if (score > bestScore && score >= 0.4) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  return bestMatch;
}

/** Berechnet Wannen, GN-Trays und Ofen-Ladungen für ein gegebenes Gewicht. */
export function calcEquipmentNeeds(totalKg: number | null, cap: EquipmentCapacity): EquipmentNeeds {
  const kg = totalKg ?? 0;
  const wannen   = cap.wanneKg   && kg > 0 ? Math.ceil(kg / cap.wanneKg)   : null;
  const trays    = cap.kgPerGn21 && kg > 0 ? Math.ceil(kg / cap.kgPerGn21) : null;
  const ovenLoads = cap.ovenCap  && trays   ? Math.ceil(trays / cap.ovenCap) : null;
  return { cap, wannen, trays, ovenLoads };
}
