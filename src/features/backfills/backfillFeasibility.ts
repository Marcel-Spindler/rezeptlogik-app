// Backfills – Bestandsprüfung: reicht die Rohware im Lager (WMS-Vollbestand) für
// die empfohlene Nachproduktionsmenge? Reine Logik, keine Hooks (Live-Verdrahtung
// siehe BackfillsContext.tsx), damit unabhängig testbar.
//
// Modell (Marcels Vorgabe): ein Backfill wird IMMER aus Rohware nachgekocht, nie
// durch Umbuchen fertiger Ware. Geprüft wird deshalb, ob die Brutto-Rohware der
// zu wenig produzierten Sub-Rezepte für N Portionen im Lager verfügbar ist
// (Status "A", MHD nicht überschritten). Engpass = die Zutat mit der geringsten
// Portionsdeckung.
//
// Bekannte v1-Grenze: reservierte / für den regulären Plan verplante Mengen
// werden NICHT abgezogen (FullInventoryRow.reservedFor existiert → mögliches v2).
// Rezept-uom vs. WMS-Stocking-UOM wird nicht umgerechnet — Bedarf/Bestand werden
// mit uom-Label ausgewiesen, sodass ein Ausreißer sichtbar bleibt.
import type { DataBundle, DetailedSubRecipe } from "../../core/types";
import type { FullInventoryRow } from "../wms-overview/wmsTypes";
import type { WmsSkuInfo } from "../../lib/wmsSkuEnrichment";
import { skuKey } from "../../lib/wmsSkuEnrichment";
import { resolveStructureByCode } from "../../lib/helpers";
import { getStructureForRecipe } from "../whatif/whatIfAggregate";
import { collectIngredientsFromNode, type IngredientHit } from "../whatif/whatIfSearch";
import type {
  BackfillFeasibility,
  BackfillFeasibilityIngredient,
  BackfillFeasibilityScope,
  CombinedBackfillNeed,
} from "./backfillTypes";

interface InvEntry {
  availableQty: number;
  expiredQty: number;
}

// SKU → verfügbare / abgelaufene Menge aus dem WMS-Vollbestand. Nur Status "A"
// (verfügbar) zählt; "H"/andere = gesperrt/in Prüfung. Ein Eintrag mit 0
// verfügbar (SKU im Dump, aber nichts frei) unterscheidet sich bewusst von
// "SKU gar nicht im Dump" (→ ID-/Namens-Mismatch möglich, nicht dasselbe wie
// "nicht auf Lager"): fehlt der Map-Eintrag komplett, setzt computeOne notInWms.
function buildInventoryIndex(rows: FullInventoryRow[]): Map<string, InvEntry> {
  const now = Date.now();
  const map = new Map<string, InvEntry>();
  for (const row of rows) {
    const key = skuKey(row.itemNumber);
    if (!key) continue;
    let e = map.get(key);
    if (!e) {
      e = { availableQty: 0, expiredQty: 0 };
      map.set(key, e);
    }
    const qty = row.actualQty ?? 0;
    if (qty <= 0 || row.status !== "A") continue;
    const expired = row.expirationDate != null && new Date(row.expirationDate).getTime() < now;
    if (expired) e.expiredQty += qty;
    else e.availableQty += qty;
  }
  return map;
}

function normalizeName(s: string): string {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Leitungswasser (und Eis) sind im Rezept-System als Brutto-Zutat mitgerechnet,
// kommen aber aus dem Hahn — nie ein Lagerengpass. Aus der Bestandsprüfung
// rausnehmen, sonst blockiert "FA-DE Water / Wasser" (nicht im WMS) fast jedes
// Meal. "coconut water" / "Kokoswasser" o.ä. sind echte SKUs → bleiben drin.
function isTapSourced(name: string, id: string): boolean {
  const halves = String(name ?? "")
    .replace(/^fa-de\s+/i, "")
    .toLowerCase()
    .split(/\s*\/\s*/)
    .map((h) => h.trim().split(",")[0].trim()); // "water, filtered" → "water"
  if (halves.some((h) => h === "water" || h === "wasser" || h === "ice" || h === "eis")) return true;
  return /^oth-00-144038-/i.test(String(id ?? "")); // bekannte Wasser-SKU
}

// node.ingredients / node.subRecipes können in Altdaten fehlen —
// collectIngredientsFromNode ist nicht defensiv, deshalb hier vorab auf Arrays
// normalisieren.
function normalizeNode(n: DetailedSubRecipe): DetailedSubRecipe {
  return {
    ...n,
    ingredients: Array.isArray(n.ingredients) ? n.ingredients : [],
    subRecipes: (Array.isArray(n.subRecipes) ? n.subRecipes : []).map(normalizeNode),
  };
}

function flattenNodes(nodes: DetailedSubRecipe[]): DetailedSubRecipe[] {
  const out: DetailedSubRecipe[] = [];
  const walk = (n: DetailedSubRecipe) => {
    out.push(n);
    n.subRecipes.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

function descendantIds(n: DetailedSubRecipe): Set<string> {
  const s = new Set<string>();
  for (const c of n.subRecipes) {
    s.add(c.id);
    for (const x of descendantIds(c)) s.add(x);
  }
  return s;
}

// Redundante Auswahl entfernen: ist ein gewähltes Sub-Rezept bereits Nachkomme
// eines anderen gewählten, würde collectIngredientsFromNode seine Zutaten doppelt
// zählen.
function dropNestedSelections(selected: DetailedSubRecipe[]): DetailedSubRecipe[] {
  const covered = new Set<string>();
  for (const s of selected) for (const id of descendantIds(s)) covered.add(id);
  return selected.filter((n) => !covered.has(n.id));
}

// Welche Sub-Rezepte müssen nachgekocht werden?
// 1) kitchenSubRecipes (exakte Küchen-Meldung) → diese Knoten
// 2) sonst: Tokens aus platingShortageReasons gegen Sub-Rezept-Namen (Heuristik)
// 3) sonst: das ganze Meal (alle Top-Level-Knoten)
function selectTargetNodes(
  need: CombinedBackfillNeed,
  topNodes: DetailedSubRecipe[],
): { nodes: DetailedSubRecipe[]; scope: BackfillFeasibilityScope; unmatched: string[] } {
  const all = flattenNodes(topNodes);
  const matchByName = (name: string): DetailedSubRecipe | undefined => {
    const n = normalizeName(name);
    if (!n) return undefined;
    return (
      all.find((node) => normalizeName(node.name) === n) ??
      all.find((node) => {
        const nn = normalizeName(node.name);
        return nn.length > 2 && (nn.includes(n) || n.includes(nn));
      })
    );
  };

  if (need.kitchenSubRecipes.length > 0) {
    const matched: DetailedSubRecipe[] = [];
    const unmatched: string[] = [];
    for (const name of need.kitchenSubRecipes) {
      const hit = matchByName(name);
      if (hit) {
        if (!matched.includes(hit)) matched.push(hit);
      } else {
        unmatched.push(name);
      }
    }
    if (matched.length > 0) {
      return { nodes: dropNestedSelections(matched), scope: "components", unmatched };
    }
    // Küche hat gemeldet, aber die Namen matchen die Struktur nicht → ganzes Meal.
    return { nodes: topNodes, scope: "full-meal", unmatched };
  }

  const tokens = need.platingShortageReasons
    .join(" ")
    .toLowerCase()
    .split(/[^a-zäöüß0-9]+/i)
    .filter((t) => t.length >= 4);
  if (tokens.length > 0) {
    const matched = all.filter((node) => {
      const nn = normalizeName(node.name);
      return tokens.some((t) => nn.includes(t));
    });
    if (matched.length > 0) {
      return { nodes: dropNestedSelections(matched), scope: "components", unmatched: [] };
    }
  }

  return { nodes: topNodes, scope: "full-meal", unmatched: [] };
}

function mkUnknown(
  need: CombinedBackfillNeed,
  reason: string,
  extra?: Partial<BackfillFeasibility>,
): BackfillFeasibility {
  return {
    recipeCode: need.recipeCode,
    verdict: "unknown",
    scope: "full-meal",
    neededPortions: need.recommendedBackfillPortions,
    maxProduciblePortions: 0,
    coveragePct: 0,
    targetSubRecipes: [],
    unmatchedComponents: [],
    bottleneck: [],
    ingredients: [],
    reason,
    ...extra,
  };
}

function computeOne(
  need: CombinedBackfillNeed,
  structures: DataBundle["structures"],
  invIndex: Map<string, InvEntry>,
  skuInfoIndex?: Map<string, WmsSkuInfo>,
): BackfillFeasibility {
  const N = need.recommendedBackfillPortions;

  const structure = resolveStructureByCode(structures, need.recipeCode, undefined, need.recipeName);
  if (!structure) return mkUnknown(need, "keine Rezeptstruktur importiert");

  const topNodesRaw = getStructureForRecipe(structure);
  if (topNodesRaw.length === 0) return mkUnknown(need, "keine Sub-Rezept-Struktur für das Rezept");
  const topNodes = topNodesRaw.map(normalizeNode);

  const { nodes: targetNodes, scope, unmatched } = selectTargetNodes(need, topNodes);
  const targetSubRecipes = [...new Set(targetNodes.map((n) => n.name))];

  const hits: IngredientHit[] = [];
  for (const node of targetNodes) {
    collectIngredientsFromNode(node, [], need.recipeCode, need.recipeName, hits);
  }

  const grouped = new Map<string, BackfillFeasibilityIngredient>();
  for (const h of hits) {
    if (!(h.grossQty > 0)) continue;
    if (isTapSourced(h.ingredientName, h.ingredientId)) continue; // Wasser/Eis aus dem Hahn
    const sku = skuKey(h.ingredientId);
    const key = `${sku}__${h.uom}`;
    const cur = grouped.get(key);
    if (cur) {
      cur.grossPerPortion += h.grossQty;
      cur.neededTotal = cur.grossPerPortion * N;
      cur.maxPortions = Math.floor(cur.availableQty / cur.grossPerPortion);
      continue;
    }
    const inv = invIndex.get(sku);
    const availableQty = inv?.availableQty ?? 0;
    grouped.set(key, {
      ingredientId: sku,
      ingredientName: h.ingredientName?.trim() || skuInfoIndex?.get(sku)?.name || sku,
      subRecipeName: h.subRecipeName,
      uom: h.uom,
      grossPerPortion: h.grossQty,
      neededTotal: h.grossQty * N,
      availableQty,
      expiredQty: inv?.expiredQty ?? 0,
      notInWms: !inv,
      maxPortions: Math.floor(availableQty / h.grossQty),
      isBottleneck: false,
    });
  }

  const ingredients = [...grouped.values()].sort(
    (a, b) => a.maxPortions - b.maxPortions || b.neededTotal - a.neededTotal,
  );

  if (ingredients.length === 0) {
    // Es gab Zutaten, aber nur Wasser/Eis → nichts, was das Lager begrenzt.
    if (hits.some((h) => h.grossQty > 0)) {
      return {
        recipeCode: need.recipeCode,
        verdict: "feasible",
        scope,
        neededPortions: N,
        maxProduciblePortions: N,
        coveragePct: 1,
        targetSubRecipes,
        unmatchedComponents: unmatched,
        bottleneck: [],
        ingredients: [],
      };
    }
    return mkUnknown(need, "keine Zutaten in der Rezeptstruktur", {
      scope,
      targetSubRecipes,
      unmatchedComponents: unmatched,
    });
  }

  const maxProduciblePortions = Math.min(...ingredients.map((i) => i.maxPortions));
  for (const ing of ingredients) {
    if (ing.maxPortions === maxProduciblePortions) ing.isBottleneck = true;
  }
  const verdict =
    maxProduciblePortions >= N ? "feasible" : maxProduciblePortions > 0 ? "partial" : "blocked";

  return {
    recipeCode: need.recipeCode,
    verdict,
    scope,
    neededPortions: N,
    maxProduciblePortions,
    coveragePct: N > 0 ? maxProduciblePortions / N : 1,
    targetSubRecipes,
    unmatchedComponents: unmatched,
    bottleneck: ingredients.filter((i) => i.isBottleneck),
    ingredients,
  };
}

export function computeBackfillFeasibility(
  combined: CombinedBackfillNeed[],
  data: DataBundle,
  fullInventoryRows?: FullInventoryRow[],
  skuInfoIndex?: Map<string, WmsSkuInfo>,
): Map<string, BackfillFeasibility> {
  const out = new Map<string, BackfillFeasibility>();
  if (!fullInventoryRows || fullInventoryRows.length === 0) return out;
  const invIndex = buildInventoryIndex(fullInventoryRows);
  for (const need of combined) {
    if (need.recommendedBackfillPortions <= 0) continue;
    out.set(need.recipeCode, computeOne(need, data.structures, invIndex, skuInfoIndex));
  }
  return out;
}
