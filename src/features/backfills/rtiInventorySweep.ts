// Backfill-Wächter – "steht die Komponente vielleicht schon woanders?"
//
// Bevor ein Sub-Rezept nachgekocht wird: den fertigen Sub-Bestand über ALLE
// WMS-Lagerorte prüfen (Blast-Chiller, Post-Blast-Staging, Bulk …) — NUR
// Plating-Holding (PLH) wird ausgeklammert, das steckt schon in Spalte F
// ("Availble Mealcount"). Reicht das Woanders-Vorhandene für den Bedarf, muss
// erst dort geschaut werden statt sofort einen Backfill anzusetzen.
//
// Läuft nur mit dem lokalen WMS-Server (Vollbestand). Sonst leere Map → im
// Wächter erscheint schlicht keine Zeile.
import type { DataBundle, DetailedSubRecipe } from "../../core/types";
import type { FullInventoryRow } from "../wms-overview/wmsTypes";
import { skuKey, type WmsSkuInfo } from "../../lib/wmsSkuEnrichment";
import { resolveStructureByCode, codeDigits } from "../../lib/helpers";
import { getStructureForRecipe } from "../whatif/whatIfAggregate";
import type { RtiMealBackfill, RtiSubShortfall } from "./rtiBackfillCalculator";

export interface SubStockElsewhere {
  totalPortions: number;
  byLocation: { location: string; portions: number }[];
  /** true = deckt den Mindestbedarf UND Zuordnung ist eindeutig (exakter Name, SKU nicht meal-übergreifend). */
  covered: boolean;
  /** true = dieselbe Sub-SKU steckt in mehreren Meals → Menge nicht allein diesem Meal zurechenbar. */
  shared: boolean;
}

function norm(s: string): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// "FA-DE …" = eingekaufte Rohware, kein gekochtes Sub-Rezept → nicht sweepen.
function isRawIngredient(name: string): boolean {
  return /^(fa-de|fa-eu|fa-us)\b/i.test(String(name ?? "").trim());
}

function flatten(nodes: DetailedSubRecipe[]): DetailedSubRecipe[] {
  const out: DetailedSubRecipe[] = [];
  const walk = (n: DetailedSubRecipe) => { out.push(n); (Array.isArray(n.subRecipes) ? n.subRecipes : []).forEach(walk); };
  nodes.forEach(walk);
  return out;
}

function matchNode(all: DetailedSubRecipe[], name: string): { node: DetailedSubRecipe; exact: boolean } | undefined {
  const n = norm(name);
  if (!n) return undefined;
  const exact = all.find(x => norm(x.name) === n);
  if (exact) return { node: exact, exact: true };
  const fuzzy = all.find(x => { const xn = norm(x.name); return xn.length > 4 && (xn.includes(n) || n.includes(xn)); });
  return fuzzy ? { node: fuzzy, exact: false } : undefined;
}

export function subKey(mealCode: string, sub: RtiSubShortfall): string {
  return `${mealCode}|${sub.subRecipeName}`;
}

export function sweepRtiInventory(
  meals: RtiMealBackfill[],
  data: DataBundle | null | undefined,
  fullInvRows: FullInventoryRow[] | null | undefined,
  skuInfoIndex?: Map<string, WmsSkuInfo>,
): Map<string, SubStockElsewhere> {
  const out = new Map<string, SubStockElsewhere>();
  if (!data || !fullInvRows || fullInvRows.length === 0) return out;

  const today = new Date().toISOString().slice(0, 10);
  const bySku = new Map<string, Map<string, number>>(); // sku → location → grams
  for (const r of fullInvRows) {
    const qty = r.actualQty ?? 0;
    if (qty <= 0) continue;
    if ((r.status || "").toUpperCase() !== "A") continue;
    if (r.expirationDate && r.expirationDate < today) continue;
    const loc = r.locationId || "?";
    if (/^plh/i.test(loc)) continue; // Plating Holding zählt Spalte F schon
    const k = skuKey(r.itemNumber);
    let m = bySku.get(k);
    if (!m) { m = new Map(); bySku.set(k, m); }
    m.set(loc, (m.get(loc) ?? 0) + qty);
  }

  for (const meal of meals) {
    if (meal.openSubs.length === 0) continue;
    const structure = resolveStructureByCode(data.structures, meal.mealCode, undefined, meal.mealName);
    const all = flatten(getStructureForRecipe(structure));
    if (all.length === 0) continue;

    for (const sub of meal.openSubs) {
      if (sub.gramPerMeal <= 0 || isRawIngredient(sub.subRecipeName)) continue;
      const m = matchNode(all, sub.subRecipeName);
      if (!m) continue;
      const sku = skuKey(m.node.id);
      const locMap = bySku.get(sku);
      if (!locMap || locMap.size === 0) continue;

      const byLocation = [...locMap.entries()]
        .map(([location, grams]) => ({ location, portions: Math.round(grams / sub.gramPerMeal) }))
        .filter(x => x.portions > 0)
        .sort((a, b) => b.portions - a.portions);
      if (byLocation.length === 0) continue;

      // Steckt die SKU in mehreren Meals dieser KW? Dann ist der Bestand nicht
      // allein diesem Meal zurechenbar → nur informativ, kein "gedeckt".
      const info = skuInfoIndex?.get(sku);
      const mealDigits = codeDigits(meal.mealCode);
      const shared = !!info && [...info.recipes].filter(r => codeDigits(r) !== mealDigits).length > 0;

      const totalPortions = byLocation.reduce((s, x) => s + x.portions, 0);
      out.set(subKey(meal.mealCode, sub), {
        totalPortions,
        byLocation,
        shared,
        covered: m.exact && !shared && totalPortions >= sub.minimumNeed,
      });
    }
  }
  return out;
}
