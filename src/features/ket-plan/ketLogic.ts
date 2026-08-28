// Reine Logik für KET Plan / WO Breakdown: CSV-/WorkOrder-Parsing, Rezeptbaum-
// Suche, Batch-/Kapazitätsberechnung (inkl. Kuechenbible-Fallback für BRAISER).
import Papa from "papaparse";
import type {
  DataBundle, DetailedIngredient, DetailedSubRecipe, EquipBibleEntry, GrossIngredient,
  Recipe, RecipeStructure, WorkOrderEntry,
} from "../../core/types";
import { EQUIP_DEFAULTS, EQUIP_LABELS, EQUIP_PRIORITY, type BatchCalc, type EquipBatch, type GnTraySummary, type IngCalc, type KetRow, type ManualEquipmentOverride, type ScoopInfo, type WoComponent } from "./ketTypes";
import { cleanRecipeName, codeDigits, extractCode, fmtNum, parseSteps } from "../../lib/helpers";
import { biAllergen, classify, NO_BATCH, ONE_BATCH, READY_MADE, isSeparate, isSpiceRoom } from "./factorRules";
import { computeWoChiller } from "../blast-chiller/blastChillerLogic";
import { lookupEquipmentCapacity, calcEquipmentNeeds } from "../kitchen-mode/wrEquipmentCapacityDB";
import { wrLookupPieceKg, wrLookupTrayPcs } from "../kitchen-mode/wrEquipmentHints";
import { wrLookupGnType, type WRTrayHint } from "../kitchen-mode/wrEquipmentTypes";
import { wrResolveSubRecipeYieldInfo } from "../kitchen-mode/wrEquipmentCalc";

export { isSeparate, isSpiceRoom } from "./factorRules";

// Sammelt CONTAINS-Allergene rekursiv aus dem Detailbaum eines Sub-Rezepts.
function collectAllergens(sub: DetailedSubRecipe, acc: Set<string>): void {
  for (const ing of sub.ingredients) if (ing.allergen) acc.add(ing.allergen.trim());
  for (const child of sub.subRecipes) collectAllergens(child, acc);
}

export { cleanRecipeName, extractCode, fmtNum, parseSteps };

// Allgemeine Normalisierung für Rezept-/Zutatennamen-Vergleiche (lowercase, nur alnum).
export function normStr(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ── Kuechenbible (equipmentBible) matching ───────────────────────────────
// Normalisierung für Equipment-Bible: UPPERCASE, nur Letters/Digits/Spaces.
// Getrennt von normStr weil Bible-Einträge case-sensitiv verglichen werden
// (BRAISER vs. braiser) und Sonderzeichen anders behandelt werden müssen.
function normBibleStr(s: string): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Finds the best BRAISER Kuechenbible entry for a given sub-recipe name.
// Only substring-matches concrete itemName values against the (normalized)
// sub-recipe name; bare "-" itemName rows are category-level fallbacks
// (e.g. "SAUCES", "RISOTTOS") with no ingredient keyword to match against a
// sub-recipe name, and a KetRow carries no reliable cook-method/category link
// back to the Bible's "category" column — so per spec, those are always
// skipped rather than guessed. If several concrete itemNames match as a
// substring, the longest (most specific) one wins.
export function findBraiserBibleMatch(
  subRecipeName: string,
  equipmentBible: EquipBibleEntry[] | undefined,
): EquipBibleEntry | null {
  if (!equipmentBible?.length) return null;
  const normSub = normBibleStr(subRecipeName);
  if (!normSub) return null;

  let best: EquipBibleEntry | null = null;
  let bestLen = -1;
  for (const entry of equipmentBible) {
    if (entry.source !== "BRAISER") continue;
    // Defensive: a malformed/absent capacity must never win a match and get
    // applied as this row's BRAISER cap (would silently produce a bogus
    // batch count — 0, NaN, or Infinity — instead of falling back safely).
    if (typeof entry.maxKg !== "number" || !Number.isFinite(entry.maxKg) || entry.maxKg <= 0) continue;
    const itemName = (entry.itemName ?? "").trim();
    if (!itemName || itemName === "-") continue; // category-level fallback — skip, see above
    const normItem = normBibleStr(itemName);
    // Guard against a future short/generic itemName (e.g. a single 2-3 letter
    // word) turning into an accidental substring match against unrelated
    // sub-recipe names. Concrete Bible item names are always multi-word or
    // long descriptive terms in practice; require some minimum specificity.
    if (normItem.length < 4) continue;
    if (normSub.includes(normItem) && normItem.length > bestLen) {
      best = entry;
      bestLen = normItem.length;
    }
  }
  return best;
}

const EQUIPMENT_NAMES = [
  ...EQUIP_PRIORITY,
  "GRILL",
  "HAND MIX",
  "IMMERSION BLENDER",
  "MARINADE",
  "HAND MARINADE",
  "SPICE PORTIONING",
  "SCOOPER",
  "BUTTER MACHINE",
  "SLICER",
  "THAW",
  "BLAST CHILLER",
];

function equipmentNamesFromText(value: string): string[] {
  const normalized = normBibleStr(value);
  return EQUIPMENT_NAMES.filter((equipment) => normalized.includes(normBibleStr(equipment)));
}

function findProcessSpec(data: DataBundle, subRecipeName: string) {
  const target = normStr(subRecipeName);
  if (!target) return undefined;
  return Object.values(data.processSpecs ?? {}).find((spec) => normStr(spec.name) === target);
}

function resolveCookMethods(row: KetRow, data: DataBundle, structure?: RecipeStructure, recipe?: Recipe): string[] {
  const methods = new Set<string>();
  for (const method of row.cookMethods) {
    const normalized = equipmentNamesFromText(method)[0] ?? method.trim().toUpperCase();
    if (normalized) methods.add(normalized);
  }

  const processSpec = findProcessSpec(data, row.subRecipeName);
  for (const method of equipmentNamesFromText(processSpec?.primaryStation ?? "")) methods.add(method);

  if (structure) {
    const detailed = findDetailedSub(structure, row.subRecipeName);
    for (const method of equipmentNamesFromText(detailed?.categories ?? "")) methods.add(method);
  }

  if (recipe) {
    for (const market of Object.values(recipe.markets)) {
      const sub = market?.subRecipes.find((item) => normStr(item.name) === normStr(row.subRecipeName));
      if (sub) {
        for (const method of equipmentNamesFromText(sub.category ?? "")) methods.add(method);
      }
    }
  }

  return [...methods];
}

function findBibleCapacity(
  subRecipeName: string,
  equipment: string,
  entries: EquipBibleEntry[] | undefined,
): EquipBibleEntry | null {
  if (!entries?.length) return null;
  const target = normBibleStr(subRecipeName);
  if (!target) return null;
  let best: EquipBibleEntry | null = null;
  let bestLength = 0;
  for (const entry of entries) {
    if (entry.maxKg <= 0 || !normBibleStr(entry.itemName)) continue;
    const entryEquipment = entry.source === "BRAISER"
      ? "BRAISER"
      : equipmentNamesFromText(entry.category)[0];
    if (entryEquipment !== equipment || !target.includes(normBibleStr(entry.itemName))) continue;
    if (normBibleStr(entry.itemName).length > bestLength) {
      best = entry;
      bestLength = normBibleStr(entry.itemName).length;
    }
  }
  return best;
}

export function fmtKg(kg: number): string {
  if (kg === 0) return "0 kg";
  if (kg < 0.1) return `${(kg * 1000).toFixed(0)} g`;
  if (kg < 1) return `${(kg * 1000).toFixed(0)} g`;
  return `${kg.toFixed(1).replace(".", ",")} kg`;
}

export function escHtml(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function parseDateShift(dateNeeded: string): { date: string; shift: string } {
  const m = dateNeeded.match(/^(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d+)/);
  if (m) return { date: m[1], shift: m[2] };
  return { date: dateNeeded, shift: "" };
}

export function parseSortKey(dateNeeded: string): number {
  const { date, shift } = parseDateShift(dateNeeded);
  const ts = Date.parse(date);
  if (Number.isNaN(ts)) return 0;
  return ts * 10 + parseInt(shift || "0");
}

export function fmtDateHeader(dateNeeded: string): string {
  const { date, shift } = parseDateShift(dateNeeded);
  const d = new Date(date);
  const dayName = d.toLocaleDateString("de-DE", { weekday: "short" });
  const dateStr = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  return shift ? `${dayName} ${dateStr} · Shift ${shift}` : `${dayName} ${dateStr}`;
}

// ── Recipe structure helpers ───────────────────────────────────────────────

export function findDetailedSub(structure: RecipeStructure, subName: string): DetailedSubRecipe | null {
  const norm = normStr(subName);
  for (const mkt of ["DE", "BENL", "DKSE"] as const) {
    const roots = structure.markets[mkt];
    if (!roots) continue;
    for (const root of roots) {
      const found = searchSubRec(root, norm);
      if (found) return found;
    }
  }
  return null;
}

function searchSubRec(node: DetailedSubRecipe, normTarget: string): DetailedSubRecipe | null {
  if (normStr(node.name) === normTarget) return node;
  for (const child of node.subRecipes) {
    const f = searchSubRec(child, normTarget);
    if (f) return f;
  }
  return null;
}

function collectDetailedIngredients(sub: DetailedSubRecipe): DetailedIngredient[] {
  return [...sub.ingredients, ...sub.subRecipes.flatMap(collectDetailedIngredients)];
}

// Echte Kochanweisungen aus Recipe.markets SubRecipes
// Prioritätsreihenfolge (erste nicht-leere Quelle gewinnt):
//   1. instructionCatalog (Firestore „instructions"-Sammlung, manuell gepflegt)
//   2. recipe.markets[mkt].subRecipes[].instructions (aus Rezept-Import)
//   3. mealCatalog[code].instructionsBySubRecipe (aus Meal-Catalog-Import)
function findSubRecipeInstructions(
  recipe: Recipe | undefined,
  mealCatalog: DataBundle["mealCatalog"],
  instructionCatalog: DataBundle["instructions"],
  subName: string,
): { english: string | null; german: string | null; germanIsFallback: boolean } {
  const recipeDigits = recipe?.code ? codeDigits(recipe.code) : "";
  const catalogEntry = recipe?.code
    ? mealCatalog?.[recipe.code]
      ?? Object.values(mealCatalog ?? {}).find((entry) => codeDigits(entry.mealId) === recipeDigits)
    : undefined;
  const subNeedle = normStr(subName);
  const databaseInstruction = Object.values(instructionCatalog ?? {})
    .find((entry) => (entry.recipeCode === recipe?.code || codeDigits(entry.recipeCode) === codeDigits(recipe?.code)) && (
      normStr(entry.subRecipeName) === subNeedle || normStr(entry.subRecipeId ?? "") === subNeedle
    ));
  const catalogInstructions = Object.values(catalogEntry?.instructionsBySubRecipe ?? {})
    .find((entry) => normStr(entry.subRecipeName) === subNeedle || normStr(entry.subRecipeId ?? "") === subNeedle);
  const norm = normStr(subName);
  if (recipe) {
    for (const mkt of ["DE", "BENL", "DKSE"] as const) {
      const md = recipe.markets[mkt];
      if (!md?.subRecipes) continue;
      for (const sub of md.subRecipes) {
        if (normStr(sub.name) !== norm) continue;
        const english = databaseInstruction?.english || sub.instructions || catalogInstructions?.english || null;
        const german = databaseInstruction?.german || sub.instructionsDE || catalogInstructions?.german || null;
        return {
          english,
          german: german || english,
          germanIsFallback: !german && !!english,
        };
      }
    }
  }
  const english = databaseInstruction?.english || catalogInstructions?.english || null;
  const german = databaseInstruction?.german || catalogInstructions?.german || null;
  return { english, german: german || english, germanIsFallback: !german && !!english };
}

// ── Gross-ingredient fallback ──────────────────────────────────────────────

function matchGrossIngredients(
  grossMap: Partial<Record<"DE" | "BENL" | "DKSE", GrossIngredient[]>>,
  subName: string,
): GrossIngredient[] {
  const norm = normStr(subName);
  for (const mkt of ["DE", "BENL", "DKSE"] as const) {
    const list = grossMap[mkt];
    if (!list?.length) continue;
    const hits = list.filter(g =>
      normStr(g.subRecipe1 ?? "") === norm ||
      normStr(g.subRecipe2 ?? "") === norm ||
      normStr(g.subRecipe3 ?? "") === norm
    );
    if (hits.length) return hits;
  }
  return [];
}

// ── Ingredient sort (shared: ketLogic + ketPdf) ──────────────────────────
// Spice-Room/SEPARATE zuerst, dann Kategorie, dann Gewicht absteigend.
const ING_CAT_ORDER: Record<string, number> = { SPI: 0, PHF: 1, DAI: 2, PRO: 3 };

export function sortIngredients(a: IngCalc, b: IngCalc): number {
  const sa = a.spiceRoom || a.separate ? 1 : 0;
  const sb = b.spiceRoom || b.separate ? 1 : 0;
  if (sa !== sb) return sb - sa;
  const ao = ING_CAT_ORDER[(a.category ?? "").trim().toUpperCase().slice(0, 3)] ?? 99;
  const bo = ING_CAT_ORDER[(b.category ?? "").trim().toUpperCase().slice(0, 3)] ?? 99;
  if (ao !== bo) return ao - bo;
  return b.totalKg - a.totalKg;
}

// ── UoM to kg conversion ─────────────────────────────────────────────────
// Konvertiert Mengeneinheit → kg-Faktor. Gibt [factor, isPcs] zurück.
// isPcs=true: Stückzahl-Zutat, nicht als Gewicht zählen.
const PIECE_UOMS = /^(pcs|stk|stück|ea|each|piece|pieces|portion|portionen)$/i;
const GRAM_UOMS = /^(g|gram|grams|gramm)$/i;
const KG_UOMS = /^(kg|kilogram|kilograms)$/i;
const ML_UOMS = /^(ml|milliliter|millilitre)$/i;
const LITER_UOMS = /^(l|liter|litre|liters|litres)$/i;

function uomToKgFactor(uom: string): { factor: number; isPcs: boolean; unknown: boolean } {
  const u = (uom ?? "").trim();
  if (!u || GRAM_UOMS.test(u)) return { factor: 0.001, isPcs: false, unknown: false };
  if (KG_UOMS.test(u)) return { factor: 1, isPcs: false, unknown: false };
  if (ML_UOMS.test(u)) return { factor: 0.001, isPcs: false, unknown: false };
  if (LITER_UOMS.test(u)) return { factor: 1, isPcs: false, unknown: false };
  if (PIECE_UOMS.test(u)) return { factor: 0, isPcs: true, unknown: false };
  // Unbekannt — Fallback assume grams (legacy), aber warnen.
  return { factor: 0.001, isPcs: false, unknown: true };
}


// ── Equipment-/Batch-Berechnung — geteilt zwischen der ganzen WO (Top-Level)
// und einzelnen WoComponents (zusammengesetzte Sub-Rezepte, siehe unten) ──────
interface EquipmentBatchResult {
  resolvedCookMethods: string[];
  equipBatches: EquipBatch[];
  primaryEquip: string | null;
  capacityKg: number | null;
  primaryCapBibleMatch: EquipBibleEntry | null;
  batches: number;
  perBatchKg: number;
  remainderKg: number;
}

function computeEquipmentBatches(
  matchName: string,
  cookMethods: string[],
  totalKg: number,
  caps: Record<string, number>,
  equipmentBible: EquipBibleEntry[] | undefined,
  processSpec: ReturnType<typeof findProcessSpec>,
  manualEquipment?: ManualEquipmentOverride | null,
): EquipmentBatchResult {
  const uniqueCookMethods = (() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const method of cookMethods) {
      const key = method.trim().toUpperCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(key);
    }
    return result;
  })();

  const bibleMatches = new Map<string, EquipBibleEntry>();
  for (const equipment of uniqueCookMethods) {
    const match = equipment === "BRAISER"
      ? findBraiserBibleMatch(matchName, equipmentBible)
      : findBibleCapacity(matchName, equipment, equipmentBible);
    if (match) bibleMatches.set(equipment, match);
  }

  const methods = [...uniqueCookMethods];
  if (manualEquipment?.equipment && manualEquipment.capacityKg > 0) {
    const manualName = manualEquipment.equipment.trim().toUpperCase();
    if (manualName && !methods.includes(manualName)) methods.push(manualName);
  }

  const effectiveCap = (e: string) => {
    // Ein expliziter manueller Cap — inklusive bewusster "0" zum Deaktivieren
    // dieses Equipments — gewinnt immer. Der Kuechenbible-Treffer füllt nur,
    // wenn der Nutzer für dieses Equipment noch nichts gesetzt hat.
    if (caps[e] !== undefined) return caps[e];
    const bibleMatch = bibleMatches.get(e);
    if (bibleMatch) return bibleMatch.maxKg;
    if (manualEquipment?.equipment.trim().toUpperCase() === e && manualEquipment.capacityKg > 0) return manualEquipment.capacityKg;
    if (
      processSpec?.batchSizeKg && processSpec.batchSizeKg > 0
      && equipmentNamesFromText(processSpec.primaryStation ?? "").includes(e)
    ) return processSpec.batchSizeKg;
    return EQUIP_DEFAULTS[e] ?? 0;
  };

  const bibleActive = (equipment: string) => !!bibleMatches.get(equipment) && caps[equipment] === undefined;

  const equipBatches: EquipBatch[] = methods
    .filter(m => effectiveCap(m) > 0)
    .map(m => {
      const cap = effectiveCap(m);
      const batches = totalKg > 0 ? Math.ceil(totalKg / cap) : 0;
      const perBatch = batches > 0 ? +(totalKg / batches).toFixed(3) : 0;
      const utilization = batches > 0 ? Math.round((perBatch / cap) * 100) : 0;
      const bMatch = bibleActive(m) ? bibleMatches.get(m) ?? null : null;
      const mq: "exact" | "substring" | "none" = !bMatch
        ? "none"
        : normBibleStr(bMatch.itemName ?? "") === normBibleStr(matchName)
          ? "exact"
          : "substring";
      return {
        equip: m,
        label: EQUIP_LABELS[m] ?? m,
        capacityKg: cap,
        batches,
        perBatchKg: perBatch,
        remainderKg: 0,
        utilizationPct: utilization,
        bibleMatch: bMatch,
        matchQuality: mq,
      };
    });

  const primaryEquip =
    EQUIP_PRIORITY.find(e => methods.includes(e) && effectiveCap(e) > 0) ??
    methods.find(m => effectiveCap(m) > 0) ??
    null;

  const capacityKg = primaryEquip ? effectiveCap(primaryEquip) : null;
  const primaryCapBibleMatch = primaryEquip && bibleActive(primaryEquip) ? bibleMatches.get(primaryEquip) ?? null : null;
  const primaryBatch = equipBatches.find(eb => eb.equip === primaryEquip);
  const batches = primaryBatch?.batches ?? 0;
  const perBatchKg = primaryBatch?.perBatchKg ?? (capacityKg ?? 0);
  const remainderKg = primaryBatch?.remainderKg ?? 0;

  return { resolvedCookMethods: methods, equipBatches, primaryEquip, capacityKg, primaryCapBibleMatch, batches, perBatchKg, remainderKg };
}

// Equipment-Namen direkt aus den categories/processSpec eines Kind-Sub-Rezepts
// (kein CSV-Cook-Methods-Feld auf dieser Ebene verfügbar wie bei der WO selbst).
function resolveComponentCookMethods(name: string, categories: string, data: DataBundle): string[] {
  const methods = new Set<string>(equipmentNamesFromText(categories));
  const processSpec = findProcessSpec(data, name);
  for (const m of equipmentNamesFromText(processSpec?.primaryStation ?? "")) methods.add(m);
  return [...methods];
}

// Reichert Zutaten (typischerweise strukturbasiert, category="") mit der
// Kategorie (PRO/PHF/SPI/DRY) aus den Gross-Ingredients an, gematcht über den
// übergebenen Sub-Rezept-Namen — dieselbe Logik wie der Top-Level-Merge in
// calcBatch, aber wiederverwendbar für einzelne Komponenten (deren Zutaten
// sonst nie eine Kategorie/Farbcodierung bekämen, siehe buildWoComponents).
function mergeGrossCategories(ingredients: IngCalc[], recipe: Recipe | undefined, subName: string): void {
  if (!recipe) return;
  const grossHits = matchGrossIngredients(recipe.grossIngredients, subName);
  if (!grossHits.length) return;
  const stripPrefix = (s: string) => s.replace(/^[A-Z]{2}-[A-Z]{2}\s+/i, "");
  const catLookup = new Map<string, string>();
  for (const g of grossHits) {
    const cat = g.ingredientCategory ?? "";
    catLookup.set(normStr(g.ingredient), cat);
    catLookup.set(normStr(stripPrefix(g.ingredient)), cat);
  }
  for (const ing of ingredients) {
    if (!ing.category) {
      ing.category = catLookup.get(normStr(ing.name)) || catLookup.get(normStr(stripPrefix(ing.name))) || "";
    }
  }
}

// GN-Blech-Hints aus dem Kuechenbible-GSheet-Dump (siehe features/kitchen-mode,
// wrBuildHintsFromDumps) — optional. Ohne Hints greift für Zutaten mit Treffer
// in der fest codierten Kapazitäts-Tabelle (lookupEquipmentCapacity) trotzdem
// eine kg-basierte Schätzung; nur die stückbasierte Protein-Schätzung entfällt
// dann (siehe resolveGnTrays).
export interface GnHints {
  trayHints: WRTrayHint[];
  pieceWeightKg: Map<string, number>;
}

export const EMPTY_GN_HINTS: GnHints = { trayHints: [], pieceWeightKg: new Map() };

// Ermittelt den GN-Blech-Bedarf einer einzelnen Zutat — zwei unabhängige Wege je
// nachdem was für diese Zutat bekannt ist (Kern-Lookups wiederverwendet aus dem
// Kitchen-Mode-Rechner, src/features/kitchen-mode/):
//   1. Stückbasiert (v.a. Proteine): "Stück pro Tray" aus der PROTEIN-DEBOX-Bible
//      bzw. VEGGIE-DEBOX "MAX. TRAY"-Spalte (wrLookupTrayPcs) + Stückgewicht
//      (wrLookupPieceKg), um aus kg die Stückzahl abzuleiten.
//   2. kg-basiert (v.a. Gemüse): feste kg-pro-GN-2:1-Dichte aus der fest
//      codierten Kapazitäts-Tabelle (lookupEquipmentCapacity/calcEquipmentNeeds) —
//      funktioniert auch ganz ohne GnHints.
// Kein Treffer in keiner der beiden Quellen → null (nie raten, siehe uomWarnings-Konvention).
// Strukturzutaten tragen oft "FA-DE Name, Details /Deutsche Übersetzung"
// (Länderpräfix + bilinguale Kurzform) — die Kitchen-Mode-Kapazitätsquellen
// sind auf kurze, englische Namen ausgelegt (z.B. "10mm Diced Pepper"). Ohne
// Bereinigung verdünnt der lange, zweisprachige Name jeden Fuzzy-Match auf
// nahezu 0. Gleiches Präfix-Muster wie mergeGrossCategories oben, zusätzlich
// wird nur der englische Teil vor dem "/" behalten.
function cleanIngredientNameForGnLookup(name: string): string {
  const withoutPrefix = name.replace(/^[A-Z]{2}-[A-Z]{2}\s+/i, "");
  const slashIdx = withoutPrefix.indexOf("/");
  const english = (slashIdx >= 0 ? withoutPrefix.slice(0, slashIdx) : withoutPrefix).trim();
  // lookupEquipmentCapacity() scores matches by raw token-overlap-count ÷ larger
  // side — a plural needle word ("Peppers") never token-matches a singular DB
  // entry ("10mm Diced Pepper"), so a more specific match can silently lose a
  // scoring tie to a less specific one that happens to share the same overlap
  // count (e.g. generic "Mixed Diced Vegetables"). Naive singularization here
  // (only on our side, the DB text itself is untouched) fixes that without
  // touching the shared kitchen-mode matcher other features also rely on.
  return english.replace(/\b([a-z]{3,})s\b/gi, (word, stem: string) =>
    /s$/i.test(stem) ? word : stem);
}

function resolveGnTrays(ing: IngCalc, hints: GnHints): { trays: number | null; gnType: string | null } {
  const lookupName = cleanIngredientNameForGnLookup(ing.name);
  const trayPcsHint = wrLookupTrayPcs(hints.trayHints, lookupName, ing.id);
  if (trayPcsHint && trayPcsHint > 0) {
    const gnType = wrLookupGnType(hints.trayHints, lookupName, ing.id) ?? "GN 2/1";
    if (ing.totalPcs > 0) {
      return { trays: Math.ceil(ing.totalPcs / trayPcsHint), gnType };
    }
    if (ing.totalKg > 0) {
      const pieceKg = wrLookupPieceKg(hints.pieceWeightKg, lookupName, ing.id);
      if (pieceKg && pieceKg > 0) {
        return { trays: Math.ceil((ing.totalKg / pieceKg) / trayPcsHint), gnType };
      }
    }
  }
  if (ing.totalKg > 0) {
    const cap = lookupEquipmentCapacity(lookupName);
    if (cap?.kgPerGn21 && cap.kgPerGn21 > 0) {
      const needs = calcEquipmentNeeds(ing.totalKg, cap);
      if (needs.trays) return { trays: needs.trays, gnType: "GN 2/1" };
    }
  }
  return { trays: null, gnType: null };
}

// Trägt gnTrays/gnType direkt in die Zutatenliste ein (mutiert wie separate/
// spiceRoom weiter oben) und baut daraus die nach GN-Größe gruppierte Summe —
// unterschiedliche GN-Größen dürfen nicht zu einer Zahl verschmolzen werden.
function applyGnTrays(ingredients: IngCalc[], hints: GnHints): GnTraySummary[] {
  const totals = new Map<string, number>();
  for (const ing of ingredients) {
    const { trays, gnType } = resolveGnTrays(ing, hints);
    ing.gnTrays = trays;
    ing.gnType = gnType;
    if (trays && gnType) totals.set(gnType, (totals.get(gnType) ?? 0) + trays);
  }
  return [...totals.entries()]
    .map(([gnType, trays]) => ({ gnType, trays }))
    .sort((a, b) => a.gnType.localeCompare(b.gnType));
}

// Portionierwerkzeug (Scoop/Ladle/…) für ein Sub-Rezept — dieselbe Quelle wie
// BreakdownEquipmentView (wrResolveSubRecipeYieldInfo), hier nur mit einer statt
// drei Sub-Ebenen aufgerufen (KetRow/WoComponent kennen nur einen flachen Namen).
// null wenn weder Method-Typ/-Farbe noch eine Portionsmenge im Rezept hinterlegt ist.
function resolveScoopInfo(recipe: Recipe | undefined, subName: string): ScoopInfo | null {
  if (!recipe || !subName) return null;
  const info = wrResolveSubRecipeYieldInfo(recipe, subName, "—", "—");
  if (!info.yieldGrams && !info.methodType && !info.methodColor) return null;
  return info;
}

// Gruppierungs-Schlüssel für "unterschiedliche Equipment-Gruppe" — zwei Kinder
// mit identischem Equipment-Set gehören zum selben Zubereitungsschritt und
// werden NICHT als getrennte Komponenten behandelt.
function componentEquipmentKey(name: string, categories: string, data: DataBundle): string {
  return resolveComponentCookMethods(name, categories, data).sort().join("+");
}

// Findet rekursiv die "Blätter" der Zubereitungs-Baumstruktur unterhalb eines
// Knotens — jedes Blatt ist eine physisch eigenständige Zubereitungskomponente
// mit eigener Kochanweisung. Ein Knoten wird NUR aufgespalten, wenn er ≥2
// Kinder mit (rekursiv) eigenen Zutaten UND ≥2 unterschiedlichen Equipment-
// Gruppen hat — sonst ist der Knoten selbst das Blatt (inkl. aller eigenen +
// verschachtelten Zutaten, wie bisher). Ein Kind, das selbst wieder so ein
// Split ist (ein "Sub-Sub-Meal"), wird weiter aufgelöst statt als ein Block
// behandelt zu werden — jede echte Zubereitungskomponente auf jeder Ebene
// bekommt am Ende ihre eigene WoComponent.
function flattenLeafSubRecipes(node: DetailedSubRecipe, data: DataBundle): DetailedSubRecipe[] {
  const substantial = (node.subRecipes ?? []).filter((c) => collectDetailedIngredients(c).length > 0);
  if (substantial.length < 2) return [node];
  const distinctEquip = new Set(substantial.map((c) => componentEquipmentKey(c.name, c.categories, data)));
  if (distinctEquip.size < 2) return [node];
  return substantial.flatMap((child) => flattenLeafSubRecipes(child, data));
}

// Erkennt zusammengesetzte Sub-Rezepte (z.B. "Stuffed Pepper Casserole Base-V2"
// = "Ground Beef - cooked" [BRAISER] + "...Vegetable Mix" [OVEN], beliebig tief
// verschachtelt) und baut für jedes Blatt mit eigenen Zutaten + eigenem
// Equipment eine eigenständige WoComponent mit eigener Batch-Rechnung und
// eigener Kochanweisungs-Suche.
function buildWoComponents(
  matchedSub: DetailedSubRecipe,
  targetPortions: number,
  recipe: Recipe | undefined,
  data: DataBundle,
  caps: Record<string, number>,
  componentManualEquipment: Record<string, ManualEquipmentOverride> | undefined,
  gnHints: GnHints,
): { components: WoComponent[]; uomWarnings: string[] } {
  const leaves = flattenLeafSubRecipes(matchedSub, data);
  // Kein Split gefunden → matchedSub selbst ist das einzige Blatt, kein
  // zusammengesetztes Sub-Rezept (normaler Einzel-Fall, unverändert).
  if (leaves.length < 2) return { components: [], uomWarnings: [] };

  const uomWarnings: string[] = [];
  const components: WoComponent[] = leaves.map((child) => {
    const ings = collectDetailedIngredients(child);
    const ingredients: IngCalc[] = [];
    let totalKg = 0;
    for (const ing of ings) {
      const { factor, isPcs, unknown } = uomToKgFactor(ing.uom);
      if (unknown) uomWarnings.push(`${child.name} / ${ing.name}: unbekannte Einheit "${ing.uom}" (als Gramm behandelt)`);
      const ingKg = isPcs ? 0 : factor * ing.grossQty * targetPortions;
      const ingPcs = isPcs ? ing.grossQty * targetPortions : 0;
      totalKg += ingKg;
      ingredients.push({
        name: ing.name,
        id: ing.id,
        category: "",
        uom: ing.uom,
        totalKg: ingKg,
        perBatchKg: 0,
        yieldPct: ing.yieldPct ?? null,
        totalPcs: ingPcs,
        separate: isSeparate(ing.name),
        spiceRoom: isSpiceRoom(ing.name),
        allergen: ing.allergen || undefined,
        gnTrays: null,
        gnType: null,
      });
    }

    mergeGrossCategories(ingredients, recipe, child.name);

    const cookMethods = resolveComponentCookMethods(child.name, child.categories, data);
    const processSpec = findProcessSpec(data, child.name);
    const equipResult = computeEquipmentBatches(
      child.name, cookMethods, totalKg, caps, data.equipmentBible, processSpec, componentManualEquipment?.[child.name] ?? null,
    );

    for (const ing of ingredients) {
      ing.perBatchKg = equipResult.batches > 0 ? +(ing.totalKg / equipResult.batches).toFixed(3) : 0;
    }
    ingredients.sort(sortIngredients);
    const gnTraySummary = applyGnTrays(ingredients, gnHints);

    const instructionPair = findSubRecipeInstructions(recipe, data.mealCatalog, data.instructions, child.name);

    // Factor-Regeln nach dem NAMEN DIESER KOMPONENTE klassifizieren, nicht nach
    // dem zusammengesetzten WO-Namen — "Ground Beef - cooked" muss als
    // neverBatch erkannt werden, auch wenn der WO-Name (z.B. "Stuffed Pepper
    // Casserole Base-V2") zufällig ein anderes Schlüsselwort ("Pepper") trifft.
    const componentFactorClass = classify(child.name, equipResult.resolvedCookMethods);
    const componentRti = componentFactorClass.rti;
    const componentNeverBatch = !componentRti && componentFactorClass.capacityKg === NO_BATCH;
    const componentFactorCapacityKg = !componentRti && !componentNeverBatch ? componentFactorClass.capacityKg : null;
    const componentFactorBatches = componentRti
      ? null
      : componentNeverBatch
        ? (totalKg > 0 ? 1 : 0)
        : (totalKg > 0 && componentFactorCapacityKg ? Math.ceil(totalKg / componentFactorCapacityKg) : null);
    const componentFactorBatchQtyKg = componentFactorBatches && componentFactorBatches > 0
      ? +(totalKg / componentFactorBatches).toFixed(3)
      : null;

    return {
      name: child.name,
      ingredients,
      totalKg,
      resolvedCookMethods: equipResult.resolvedCookMethods,
      equipBatches: equipResult.equipBatches,
      primaryEquip: equipResult.primaryEquip,
      capacityKg: equipResult.capacityKg,
      primaryCapBibleMatch: equipResult.primaryCapBibleMatch,
      batches: equipResult.batches,
      perBatchKg: equipResult.perBatchKg,
      instructionsEnglish: instructionPair.english,
      instructionsGerman: instructionPair.german,
      instructionsGermanFallback: instructionPair.germanIsFallback,
      rti: componentRti,
      neverBatch: componentNeverBatch,
      factorCapacityKg: componentFactorCapacityKg,
      factorBatches: componentFactorBatches,
      factorBatchQtyKg: componentFactorBatchQtyKg,
      factorFallbackCapacity: !!componentFactorClass.fallback,
      readyMade: READY_MADE.test(child.name),
      gnTraySummary,
      scoopInfo: resolveScoopInfo(recipe, child.name),
    };
  });

  return { components, uomWarnings };
}

// Fasst die je-Komponente korrekt berechneten equipBatches zu einer WO-weiten
// Übersicht zusammen — nie erneut "totalKg / capacity" rechnen (das wäre exakt
// der ursprüngliche Bug: die kombinierte Gesamtmenge auf jedes Equipment
// angewendet, obwohl z.B. nur das Fleisch in den Braiser und nur das Gemüse in
// den Ofen geht). Nutzen zwei Komponenten dasselbe Equipment, werden ihre
// bereits korrekten Batch-Zahlen einfach addiert.
function mergeComponentEquipBatches(components: WoComponent[]): EquipBatch[] {
  const merged = new Map<string, EquipBatch>();
  for (const component of components) {
    for (const eb of component.equipBatches) {
      const existing = merged.get(eb.equip);
      if (!existing) {
        merged.set(eb.equip, { ...eb });
        continue;
      }
      const combinedKg = existing.perBatchKg * existing.batches + eb.perBatchKg * eb.batches;
      const batches = existing.batches + eb.batches;
      // Zwei Komponenten aus unterschiedlichen Ästen können zufällig dasselbe
      // Equipment nutzen, aber unterschiedliche Kuechenbible-Kapazitätsquellen
      // haben — die zusammengeführte Kachel darf dann nicht einfach die erste
      // Quelle als "die" Quelle für den gesamten Batch-Betrag ausgeben.
      const sameBibleSource = existing.bibleMatch?.itemName === eb.bibleMatch?.itemName;
      merged.set(eb.equip, {
        ...existing,
        batches,
        perBatchKg: batches > 0 ? +(combinedKg / batches).toFixed(3) : 0,
        utilizationPct: batches > 0
          ? Math.round((existing.utilizationPct * existing.batches + eb.utilizationPct * eb.batches) / batches)
          : 0,
        bibleMatch: sameBibleSource ? existing.bibleMatch : null,
        matchQuality: sameBibleSource ? existing.matchQuality : "none",
      });
    }
  }
  return [...merged.values()];
}

export function calcBatch(
  row: KetRow,
  caps: Record<string, number>,
  data: DataBundle,
  manualEquipment?: ManualEquipmentOverride | null,
  // Equipment-Ausnahme je Komponente (keyed by component.name) — unabhängig von
  // manualEquipment oben, das nur für den Nicht-Komponenten-Fall bzw. als
  // WO-weiter Fallback gilt (siehe buildWoComponents).
  componentManualEquipment?: Record<string, ManualEquipmentOverride>,
  // GN-Blech-Hints aus dem Kuechenbible-GSheet-Dump (siehe GnHints oben) —
  // optional, ohne sie greift für viele Zutaten trotzdem die fest codierte
  // kg-basierte Kapazitäts-Tabelle.
  gnHints: GnHints = EMPTY_GN_HINTS,
): BatchCalc {
  const recipe = data.recipes[row.recipeCode];
  const structure = data.structures?.[row.recipeCode];
  const processSpec = findProcessSpec(data, row.subRecipeName);
  const resolvedCookMethods = resolveCookMethods(row, data, structure, recipe);
  const ingredients: IngCalc[] = [];
  const uomWarnings: string[] = [];
  let totalKg = 0;
  let subRecipeFound = false;
  let cookingInstructions: string | null = null;
  let matchedSub: DetailedSubRecipe | null = null;

  if (recipe || structure) {
    // Try detailed structure first (more accurate)
    if (structure) {
      const sub = findDetailedSub(structure, row.subRecipeName);
      if (sub) {
        matchedSub = sub;
        subRecipeFound = true;
        cookingInstructions = sub.categories ?? null;
        const ings = collectDetailedIngredients(sub);
        for (const ing of ings) {
          const { factor, isPcs, unknown } = uomToKgFactor(ing.uom);
          if (unknown) uomWarnings.push(`${ing.name}: unbekannte Einheit "${ing.uom}" (als Gramm behandelt)`);
          const ingKg = isPcs ? 0 : factor * ing.grossQty * row.targetPortions;
          const ingPcs = isPcs ? ing.grossQty * row.targetPortions : 0;
          totalKg += ingKg;
          ingredients.push({
            name: ing.name,
            id: ing.id,
            category: "", // DetailedIngredient has no category; fill from gross below
            uom: ing.uom,
            totalKg: ingKg,
            perBatchKg: 0,
            yieldPct: ing.yieldPct ?? null,
            totalPcs: ingPcs,
            separate: false,
            spiceRoom: false,
            allergen: ing.allergen || undefined,
            gnTrays: null,
            gnType: null,
          });
        }
      }
    }

    // Fallback: grossIngredients (adds category info)
    const grossHits = recipe ? matchGrossIngredients(recipe.grossIngredients, row.subRecipeName) : [];
    if (!subRecipeFound && grossHits.length) {
      subRecipeFound = true;
      for (const g of grossHits) {
        const { factor, isPcs, unknown } = uomToKgFactor(g.uom);
        if (unknown) uomWarnings.push(`${g.ingredient}: unbekannte Einheit "${g.uom}" (als Gramm behandelt)`);
        const ingKg = isPcs ? 0 : factor * g.grossQuantityPerPortion * row.targetPortions;
        const ingPcs = isPcs ? g.grossQuantityPerPortion * row.targetPortions : 0;
        totalKg += ingKg;
        ingredients.push({
          name: g.ingredient,
          id: g.ingredientId,
          category: g.ingredientCategory ?? "",
          uom: g.uom,
          totalKg: ingKg,
          perBatchKg: 0,
          yieldPct: null,
          totalPcs: ingPcs,
          separate: false,
          spiceRoom: false,
          gnTrays: null,
          gnType: null,
        });
      }
    }

    // Merge categories from gross into structure-sourced ingredients.
    // Structure ingredient names often carry a country prefix ("FA-DE Spice, Sea Salt")
    // while gross ingredients may not ("Spice, Sea Salt") — index both forms so the
    // lookup succeeds regardless of which side has the prefix.
    if (subRecipeFound && structure && grossHits.length) {
      const stripPrefix = (s: string) => s.replace(/^[A-Z]{2}-[A-Z]{2}\s+/i, "");
      const catLookup = new Map<string, string>();
      for (const g of grossHits) {
        const cat = g.ingredientCategory ?? "";
        catLookup.set(normStr(g.ingredient), cat);
        catLookup.set(normStr(stripPrefix(g.ingredient)), cat);
      }
      for (const ing of ingredients) {
        if (!ing.category) {
          ing.category =
            catLookup.get(normStr(ing.name)) ||
            catLookup.get(normStr(stripPrefix(ing.name))) ||
            "";
        }
      }
    }
  }

  const equipResult = computeEquipmentBatches(
    row.subRecipeName, resolvedCookMethods, totalKg, caps, data.equipmentBible, processSpec, manualEquipment,
  );
  resolvedCookMethods.splice(0, resolvedCookMethods.length, ...equipResult.resolvedCookMethods);

  // Zusammengesetzte Sub-Rezepte (z.B. "Stuffed Pepper Casserole Base-V2" aus
  // "Ground Beef - cooked" [BRAISER] + "...Vegetable Mix" [OVEN]) — jede
  // Komponente braucht eine eigene Kochanweisung + eigene Batch-Rechnung, statt
  // die kombinierte Gesamtmenge fälschlich auf jedes Equipment anzuwenden.
  const { components, uomWarnings: componentUomWarnings } = matchedSub
    ? buildWoComponents(matchedSub, row.targetPortions, recipe, data, caps, componentManualEquipment, gnHints)
    : { components: [] as WoComponent[], uomWarnings: [] as string[] };
  uomWarnings.push(...componentUomWarnings);

  // Bei Komponenten: equipBatches/batches/perBatchKg oben durch die korrekt
  // je-Komponente gerechneten Werte ersetzen (siehe mergeComponentEquipBatches)
  // — sonst würde die WO-Kopfzeile weiterhin die kombinierte Gesamtmenge
  // fälschlich auf jedes Equipment anwenden.
  const equipBatches = components.length > 0 ? mergeComponentEquipBatches(components) : equipResult.equipBatches;
  const primaryEquip = components.length > 0
    ? (EQUIP_PRIORITY.find((e) => equipBatches.some((eb) => eb.equip === e)) ?? equipBatches[0]?.equip ?? null)
    : equipResult.primaryEquip;
  const primaryBatch = components.length > 0 ? equipBatches.find((eb) => eb.equip === primaryEquip) : undefined;
  const capacityKg = components.length > 0 ? (primaryBatch?.capacityKg ?? null) : equipResult.capacityKg;
  const primaryCapBibleMatch = components.length > 0 ? (primaryBatch?.bibleMatch ?? null) : equipResult.primaryCapBibleMatch;
  const batches = components.length > 0 ? (primaryBatch?.batches ?? 0) : equipResult.batches;
  const perBatchKg = components.length > 0 ? (primaryBatch?.perBatchKg ?? 0) : equipResult.perBatchKg;
  const remainderKg = components.length > 0 ? 0 : equipResult.remainderKg;

  for (const ing of ingredients) {
    ing.perBatchKg = batches > 0
      ? +(ing.totalKg / batches).toFixed(3)
      : 0;
    ing.separate = isSeparate(ing.name);
    ing.spiceRoom = isSpiceRoom(ing.name);
  }
  ingredients.sort(sortIngredients);
  const gnTraySummary = applyGnTrays(ingredients, gnHints);

  const instructionPair = findSubRecipeInstructions(recipe, data.mealCatalog, data.instructions, row.subRecipeName);

  // ── Factor-Produktionsregeln (RTI / nie-batchen-Fleisch / Batch-Kapazität nach Name) ──
  const factorClass = classify(row.subRecipeName, resolvedCookMethods);
  const rti = factorClass.rti;
  const neverBatch = !rti && factorClass.capacityKg === NO_BATCH;
  const factorCapacityKg = !rti && !neverBatch ? factorClass.capacityKg : null;
  const factorBatches = rti
    ? null
    : neverBatch
      ? (totalKg > 0 ? 1 : 0)
      : (totalKg > 0 && factorCapacityKg ? Math.ceil(totalKg / factorCapacityKg) : null);
  const factorBatchQtyKg = factorBatches && factorBatches > 0 ? +(totalKg / factorBatches).toFixed(3) : null;

  const allergenSet = new Set<string>();
  if (matchedSub) collectAllergens(matchedSub, allergenSet);
  if (!matchedSub && allergenSet.size === 0 && recipe) {
    // Rezept-Level-Fallback NUR wenn kein Struktur-Match gefunden wurde.
    // Bei gefundenem matchedSub vertrauen wir den Ingredient-Daten — 0 Allergene
    // heißt dort "bestätigt allergenfrei", nicht "Datenlücke".
    for (const mkt of ["DE", "BENL", "DKSE"] as const) {
      const raw = recipe.markets[mkt]?.allergens;
      if (raw) for (const a of raw.split(/[,;/]/)) { const t = a.trim(); if (t) allergenSet.add(t); }
    }
  }
  const allergensContains = [...allergenSet].map(biAllergen);

  // HACCP: gleiche Allergen→Chiller-Zuteilung wie der eigenständige Blast Chiller
  // Bot (blastChillerLogic.ts) — hier direkt aus den bereits geladenen App-Daten,
  // kein separater CSV-Upload nötig.
  const chillerAssignment = recipe || structure ? computeWoChiller(data, row.recipeCode, row.subRecipeName) : null;

  return {
    totalKg, equipBatches, primaryEquip, capacityKg, primaryCapBibleMatch, batches, perBatchKg, remainderKg,
    resolvedCookMethods, manualEquipment: manualEquipment ?? null,
    ingredients, recipeFound: !!(recipe || structure), subRecipeFound, cookingInstructions,
    subRecipeInstructions: instructionPair.english,
    subRecipeInstructionsDE: instructionPair.german,
    subRecipeInstructionsGermanFallback: instructionPair.germanIsFallback,
    rti, neverBatch, factorCapacityKg, factorBatches, factorBatchQtyKg,
    factorFallbackCapacity: !!factorClass.fallback,
    readyMade: READY_MADE.test(row.subRecipeName),
    allergensContains,
    chillerAssignment,
    uomWarnings,
    factorOverridesEquip: rti || neverBatch,
    components,
    gnTraySummary,
    // Nur für den Nicht-Komponenten-Fall — bei zusammengesetzten Sub-Rezepten steht
    // es je Komponente in components[].scoopInfo (siehe Kommentar bei BatchCalc.scoopInfo).
    scoopInfo: components.length === 0 ? resolveScoopInfo(recipe, row.subRecipeName) : null,
  };
}

// ── CSV parsers ────────────────────────────────────────────────────────────

export interface ParseKetCsvResult {
  rows: KetRow[];
  warnings: string[];
}

export function parseKetCsv(text: string): ParseKetCsvResult {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  });

  const warnings: string[] = [];
  if (result.errors.length) {
    for (const err of result.errors) {
      warnings.push(`Zeile ${(err.row ?? 0) + 2}: ${err.message}`);
    }
  }

  const rows = result.data
    .map((row, idx) => {
      const recipeName = (row["Recipe Name"] ?? "").trim();
      // extractCode erwartet den Code als Präfix ("FV1234A - Name [DE]"). Sehr
      // vereinzelt kommt aus dem Export auch "[DE] - FV1234A - Name" vorbei
      // (Markt-Klammer VOR statt nach dem Code) — dann den Marker abstreifen
      // und erneut versuchen, statt die WO ganz ohne recipeCode zu lassen.
      const recipeCode = extractCode(recipeName) || extractCode(recipeName.replace(/^\[[A-Z]+\]\s*-?\s*/, ""));
      const woNumber = (row["Work Order Number"] ?? "").trim();
      const dateNeeded = (row["Date Needed"] ?? "").trim();
      const { shift } = parseDateShift(dateNeeded);
      const cookRaw = (row["Cook Methods"] ?? "").trim();
      const cookMethods = cookRaw
        ? cookRaw.split(",").map(m => m.trim().toUpperCase()).filter(Boolean)
        : [];
      const targetPortions = parseFloat(row["Target Portions"] ?? "0") || 0;
      const woCookedPortions = row["WO Cooked Portions"] ? parseFloat(row["WO Cooked Portions"]) || null : null;
      const cookedPortionsExcess = row["Cooked Portions Excess"] ? parseFloat(row["Cooked Portions Excess"]) || null : null;

      return {
        key: `csv::${idx}::${dateNeeded}::${woNumber}`,
        dateNeeded,
        shift,
        woNumber,
        recipeId: (row["Recipe ID"] ?? "").trim(),
        recipeCode,
        recipeName: cleanRecipeName(recipeName),
        subRecipeName: (row["Sub Recipe Name"] ?? "").trim(),
        cookMethods,
        woCookedPortions,
        targetPortions,
        cookedPortionsExcess,
        stagingStatus: (row["Staging Status"] ?? "").trim(),
        stagingComment: (row["Staging Comment"] ?? "").trim(),
        kitchenStatus: (row["Kitchen Status"] ?? "").trim(),
        unlockedEta: (row["Unlocked ETA"] ?? "").trim(),
        workOrderComment: (row["Work Order Comment"] ?? "").trim(),
      } satisfies KetRow;
    })
    .filter(r => r.woNumber);

  return { rows, warnings };
}

export function woEntriesToKetRows(rows: WorkOrderEntry[]): KetRow[] {
  return rows
    .filter(r => r.workOrder && r.recipeCode)
    .map((r, idx) => {
      const dateNeeded = r.kitchenDay ?? "";
      const { shift } = parseDateShift(dateNeeded);
      return {
        key: `wo::${idx}::${dateNeeded}::${r.workOrder}`,
        dateNeeded,
        shift,
        woNumber: r.workOrder,
        recipeId: r.recipeId ?? "",
        recipeCode: r.recipeCode,
        recipeName: cleanRecipeName(r.recipeName),
        subRecipeName: r.subRecipe ?? "",
        cookMethods: r.cookMethods
          ? r.cookMethods.split(",").map(m => m.trim().toUpperCase()).filter(Boolean)
          : [],
        woCookedPortions: r.woCookedPortions ?? null,
        targetPortions: r.targetPortions ?? r.plannedMeals ?? 0,
        cookedPortionsExcess: r.cookedPortionsExcess ?? null,
        stagingStatus: r.stagingStatus ?? "",
        stagingComment: r.stagingComment ?? "",
        kitchenStatus: r.kitchenStatus ?? "",
        unlockedEta: r.unlockedEta ?? "",
        workOrderComment: r.workOrderComment ?? "",
      };
    });
}

// ── Status helpers ─────────────────────────────────────────────────────────

export function statusColors(status: string): { bg: string; text: string; dot: string } {
  if (status === "Post Blast")    return { bg: "bg-emerald-100", text: "text-emerald-800", dot: "bg-emerald-500" };
  if (status === "Pre Blast")     return { bg: "bg-amber-100",   text: "text-amber-800",   dot: "bg-amber-500"   };
  if (status === "Staged")        return { bg: "bg-green-100",   text: "text-green-800",   dot: "bg-green-500"   };
  if (status === "Partially Staged") return { bg: "bg-orange-100", text: "text-orange-800", dot: "bg-orange-500" };
  if (status === "Picking")       return { bg: "bg-blue-100",    text: "text-blue-800",    dot: "bg-blue-500"    };
  if (status === "Released")      return { bg: "bg-purple-100",  text: "text-purple-800",  dot: "bg-purple-500"  };
  if (status === "Open")          return { bg: "bg-violet-100",  text: "text-violet-800",  dot: "bg-violet-500"  };
  if (status === "Not Started")   return { bg: "bg-slate-100",   text: "text-slate-600",   dot: "bg-slate-400"   };
  return { bg: "bg-slate-100", text: "text-slate-500", dot: "bg-slate-300" };
}

export function catColor(cat: string): string {
  const c = cat.toUpperCase();
  if (c === "PRO") return "text-red-700 bg-red-50";
  if (c === "PHF") return "text-blue-700 bg-blue-50";
  if (c === "SPI") return "text-amber-700 bg-amber-50";
  if (c === "DRY") return "text-slate-600 bg-slate-100";
  return "text-slate-500 bg-slate-50";
}

// Debox-Department (Shopfloor-Dashboard, Sidebar-Filter): Protein Debox
// (Fleisch/Fisch/sonstige Proteine) vs. Veggie Debox (alles andere). Primär
// über eine explizite "VEGGIE DEBOX"/"PROTEIN DEBOX"-Cook-Method (falls die
// Datenquelle das liefert, z.B. aus manueller Zuweisung), sonst über die
// Factor-Klassifizierung (neverBatch = Fleisch/Fisch nie gesplittet,
// factorCapacityKg ONE_BATCH/NO_BATCH = sonstige Proteine) — dieselbe
// Heuristik, mit der praktisch jede nicht-RTI-WO eindeutig einer der beiden
// Debox-Stationen zugeordnet werden kann, auch ohne explizite Cook-Method.
export function classifyDeboxDepartment(calc: BatchCalc): "protein" | "veggie" | null {
  if (calc.rti) return null;
  if (calc.resolvedCookMethods.includes("PROTEIN DEBOX")) return "protein";
  if (calc.resolvedCookMethods.includes("VEGGIE DEBOX")) return "veggie";
  const isProtein = calc.neverBatch || calc.factorCapacityKg === NO_BATCH || calc.factorCapacityKg === ONE_BATCH;
  return isProtein ? "protein" : "veggie";
}

// Stabiler Cache-Key für WO-Instructions: basiert auf Rezeptcode + Sub-Rezeptname,
// damit Instructions über Wochen hinweg wiederverwendet werden (gleiche Gerichte
// wiederholen sich alle 3–8 Wochen mit neuen WO-Nummern).
export function instructionCacheKey(row: KetRow, componentName?: string): string {
  return componentName
    ? `${row.recipeCode}::${row.subRecipeName}::${componentName}`
    : `${row.recipeCode}::${row.subRecipeName}`;
}

// Normalisiert einen Sub-Rezept-/Komponentennamen für den unscharfen Abgleich:
// Groß/Klein, Satzzeichen, Batch-/Gewichtsangaben und Rausch-Wörter raus. Damit
// überleben Instructions kleine Umbenennungen im KET-Export bzw. im Rezept-Baum
// (z.B. "Sauce - Marsala Sauce" ↔ "Marsala Sauce", "... Batch 160g" ↔ "...").
export function normalizeInstructionName(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\bbatch\b/g, " ")
    .replace(/\b\d+([.,]\d+)?\s*(g|kg|mg|ml|l|oz|lb|stk|pcs?|x)\b/g, " ")
    .replace(/\((use|rework|neu|new|final)\)/g, " ")
    .replace(/\b(rework|less\s*fat|low\s*fat|reg|regular|edit|v\d+|final)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

// Unscharfer Schlüssel: Rezeptcode + normalisierter Name. Stabiler als
// instructionCacheKey, weil der volatile mittlere Teil (subRecipeName aus dem
// CSV-Freitext) bei zusammengesetzten WOs wegfällt — der Komponentenname aus dem
// Rezept-Baum ist die verlässlichere Kennung. Nur als Fallback benutzen, wenn
// der exakte Cache-Key nichts findet.
export function fuzzyInstructionKey(row: Pick<KetRow, "recipeCode" | "subRecipeName">, componentName?: string): string {
  return `${row.recipeCode}##${normalizeInstructionName(componentName ?? row.subRecipeName)}`;
}

// Baut aus einem Instruction-Cache (Schlüssel = instructionCacheKey) einen Index
// nach fuzzyInstructionKey. Erster Treffer je Fuzzy-Key gewinnt (deterministisch
// über die Eingabereihenfolge).
export function buildFuzzyInstructionIndex<T>(cache: Record<string, T>): Map<string, T> {
  const index = new Map<string, T>();
  for (const [key, value] of Object.entries(cache)) {
    const parts = key.split("::");
    if (parts.length < 2) continue;
    const recipeCode = parts[0];
    const namePart = parts[parts.length - 1]; // component bei zusammengesetzt, sonst subRecipe
    const fk = `${recipeCode}##${normalizeInstructionName(namePart)}`;
    if (!index.has(fk)) index.set(fk, value);
  }
  return index;
}

// ── Instruktions-Vollständigkeit einer WO ───────────────────────────────────
// Eine einfache WO braucht genau eine Kochanweisung (Laufzeit-Key = row.key),
// eine zusammengesetzte WO (calc.components) je EINDEUTIGEM Komponentennamen
// eine eigene (Key = `${row.key}::${componentName}`) — dieselbe Ziel-Logik wie
// generationTargetsForRow in KetBreakdownView, hier nur auf der Prüf-Seite.
// `hasInstruction` entkoppelt von der Datenquelle (Record vs. Map).
export interface RowInstructionStatus {
  /** Benötigte Anweisungen: 1 bei einfacher WO, sonst je eindeutiger Komponente. */
  total: number;
  /** Wie viele davon vorhanden sind. */
  have: number;
  /** Alle vorhanden. */
  complete: boolean;
  /** Was fehlt — "ganze WO" bei einfacher WO, sonst die Komponentennamen. */
  missing: string[];
}

export function rowInstructionStatus(
  row: KetRow,
  calc: Pick<BatchCalc, "components"> | null | undefined,
  hasInstruction: (runtimeKey: string) => boolean,
): RowInstructionStatus {
  if (!calc || calc.components.length === 0) {
    const have = hasInstruction(row.key) ? 1 : 0;
    return { total: 1, have, complete: have === 1, missing: have === 1 ? [] : ["ganze WO"] };
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const component of calc.components) {
    if (seen.has(component.name)) continue;
    seen.add(component.name);
    names.push(component.name);
  }
  const missing = names.filter((name) => !hasInstruction(`${row.key}::${name}`));
  return {
    total: names.length,
    have: names.length - missing.length,
    complete: missing.length === 0,
    missing,
  };
}
