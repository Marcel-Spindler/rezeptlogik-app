// Reine Logik für KET Plan / WO Breakdown: CSV-/WorkOrder-Parsing, Rezeptbaum-
// Suche, Batch-/Kapazitätsberechnung (inkl. Kuechenbible-Fallback für BRAISER).
import Papa from "papaparse";
import type {
  DataBundle, DetailedIngredient, DetailedSubRecipe, EquipBibleEntry, GrossIngredient,
  Recipe, RecipeStructure, WorkOrderEntry,
} from "../../core/types";
import { EQUIP_DEFAULTS, EQUIP_LABELS, EQUIP_PRIORITY, type BatchCalc, type EquipBatch, type IngCalc, type KetRow } from "./ketTypes";
import { cleanRecipeName, extractCode, fmtNum, parseSteps } from "../../lib/helpers";

export { cleanRecipeName, extractCode, fmtNum, parseSteps };

export function normStr(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ── Kuechenbible (equipmentBible) matching — BRAISER only ──────────────────
// Normalize per spec: uppercase, strip everything except letters/digits/spaces.
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
  return Date.parse(date) * 10 + parseInt(shift || "0");
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
function findSubRecipeInstructions(recipe: Recipe | undefined, subName: string): string | null {
  if (!recipe) return null;
  const norm = normStr(subName);
  for (const mkt of ["DE", "BENL", "DKSE"] as const) {
    const md = recipe.markets[mkt];
    if (!md?.subRecipes) continue;
    for (const sub of md.subRecipes) {
      if (normStr(sub.name) === norm && sub.instructions) return sub.instructions;
    }
  }
  return null;
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

// ── Batch calculation ──────────────────────────────────────────────────────

export function calcBatch(row: KetRow, caps: Record<string, number>, data: DataBundle): BatchCalc {
  const recipe = data.recipes[row.recipeCode];
  const structure = data.structures?.[row.recipeCode];
  const ingredients: IngCalc[] = [];
  let totalKg = 0;
  let subRecipeFound = false;
  let cookingInstructions: string | null = null;

  if (recipe || structure) {
    // Try detailed structure first (more accurate)
    if (structure) {
      const sub = findDetailedSub(structure, row.subRecipeName);
      if (sub) {
        subRecipeFound = true;
        cookingInstructions = sub.categories ?? null;
        const ings = collectDetailedIngredients(sub);
        for (const ing of ings) {
          const uomLc = (ing.uom ?? "").toLowerCase();
          const kgPer =
            uomLc === "g" || uomLc === "gram" || uomLc === "grams"
              ? ing.grossQty / 1000
              : uomLc === "kg"
                ? ing.grossQty
                : ing.grossQty / 1000; // default assume grams
          const ingKg = kgPer * row.targetPortions;
          totalKg += ingKg;
          ingredients.push({
            name: ing.name,
            id: ing.id,
            category: "", // DetailedIngredient has no category; fill from gross below
            uom: ing.uom,
            totalKg: ingKg,
            perBatchKg: 0,
            yieldPct: ing.yieldPct ?? null,
          });
        }
      }
    }

    // Fallback: grossIngredients (adds category info)
    if (!subRecipeFound && recipe) {
      const grossHits = matchGrossIngredients(recipe.grossIngredients, row.subRecipeName);
      if (grossHits.length) {
        subRecipeFound = true;
        for (const g of grossHits) {
          const uomLc = (g.uom ?? "").toLowerCase();
          const kgPer =
            uomLc === "g" || uomLc === "gram" || uomLc === "grams"
              ? g.grossQuantityPerPortion / 1000
              : g.grossQuantityPerPortion;
          const ingKg = kgPer * row.targetPortions;
          totalKg += ingKg;
          ingredients.push({
            name: g.ingredient,
            id: g.ingredientId,
            category: g.ingredientCategory ?? "",
            uom: g.uom,
            totalKg: ingKg,
            perBatchKg: 0,
            yieldPct: null,
          });
        }
      }
    }

    // Merge categories from gross into structure-sourced ingredients
    if (subRecipeFound && structure && recipe) {
      const grossHits = matchGrossIngredients(recipe.grossIngredients, row.subRecipeName);
      const catLookup = new Map(grossHits.map(g => [normStr(g.ingredient), g.ingredientCategory ?? ""]));
      for (const ing of ingredients) {
        if (!ing.category) ing.category = catLookup.get(normStr(ing.name)) ?? "";
      }
    }
  }

  // BRAISER-only Kuechenbible lookup: matches row.subRecipeName against
  // data.equipmentBible BRAISER entries (see findBraiserBibleMatch). Never
  // touches OVEN/PLANETARY MIXER/etc., and never mutates the global caps map —
  // it only supplies a per-row override for BRAISER's effective capacity.
  const braiserBibleMatch = findBraiserBibleMatch(row.subRecipeName, data.equipmentBible);

  const effectiveCap = (e: string) => {
    // An explicit manual cap — including an intentional "0" to disable this
    // equipment entirely, a supported value in the sidebar — always wins.
    // The Kuechenbible match only fills in when the user hasn't set anything
    // for this equipment; it must never silently override a manual choice.
    if (caps[e] !== undefined) return caps[e];
    if (e === "BRAISER" && braiserBibleMatch) return braiserBibleMatch.maxKg;
    return EQUIP_DEFAULTS[e] ?? 0;
  };

  // Whether the Bible match is actually the value effectiveCap("BRAISER") used
  // (i.e. no manual override is set) — the UI must only show the "📖
  // Kuechenbible" tag when that entry is truly the active capacity, not
  // whenever a match merely exists but a manual cap has taken precedence.
  const braiserBibleActive = !!braiserBibleMatch && caps["BRAISER"] === undefined;

  // Per-Equipment Batche: jede Cook Method mit bekannter Kapazität berechnet eigenständig
  const equipBatches: EquipBatch[] = row.cookMethods
    .filter(m => effectiveCap(m) > 0)
    .map(m => {
      const cap = effectiveCap(m);
      const b = totalKg > 0 ? Math.max(1, Math.ceil(totalKg / cap)) : 0;
      return {
        equip: m,
        label: EQUIP_LABELS[m] ?? m,
        capacityKg: cap,
        batches: b,
        perBatchKg: b > 0 ? totalKg / b : 0,
        bibleMatch: m === "BRAISER" && braiserBibleActive ? braiserBibleMatch : null,
      };
    });

  // Primär-Equipment für Ingredient-Aufschlüsselung = erstes aus EQUIP_PRIORITY
  const primaryEquip =
    EQUIP_PRIORITY.find(e => row.cookMethods.includes(e) && effectiveCap(e) > 0) ??
    row.cookMethods.find(m => effectiveCap(m) > 0) ??
    null;

  const capacityKg = primaryEquip ? effectiveCap(primaryEquip) : null;
  const primaryCapBibleMatch = primaryEquip === "BRAISER" && braiserBibleActive ? braiserBibleMatch : null;
  const primaryBatch = equipBatches.find(eb => eb.equip === primaryEquip);
  const batches = primaryBatch?.batches ?? (totalKg > 0 ? 1 : 0);
  const perBatchKg = primaryBatch?.perBatchKg ?? (batches > 0 ? totalKg / batches : 0);

  for (const ing of ingredients) {
    ing.perBatchKg = batches > 0 ? ing.totalKg / batches : 0;
  }

  const subRecipeInstructions = findSubRecipeInstructions(recipe, row.subRecipeName);

  return {
    totalKg, equipBatches, primaryEquip, capacityKg, primaryCapBibleMatch, batches, perBatchKg,
    ingredients, recipeFound: !!(recipe || structure), subRecipeFound, cookingInstructions, subRecipeInstructions,
  };
}

// ── CSV parsers ────────────────────────────────────────────────────────────

export function parseKetCsv(text: string): KetRow[] {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  });

  return result.data
    .map((row, idx) => {
      const recipeName = (row["Recipe Name"] ?? "").trim();
      const recipeCode = extractCode(recipeName);
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
