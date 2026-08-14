// Reine Logik für KET Plan / WO Breakdown: CSV-/WorkOrder-Parsing, Rezeptbaum-
// Suche, Batch-/Kapazitätsberechnung (inkl. Kuechenbible-Fallback für BRAISER).
import Papa from "papaparse";
import type {
  DataBundle, DetailedIngredient, DetailedSubRecipe, EquipBibleEntry, GrossIngredient,
  Recipe, RecipeStructure, WorkOrderEntry,
} from "../../core/types";
import { EQUIP_DEFAULTS, EQUIP_LABELS, EQUIP_PRIORITY, type BatchCalc, type EquipBatch, type IngCalc, type KetRow, type ManualEquipmentOverride } from "./ketTypes";
import { cleanRecipeName, codeDigits, extractCode, fmtNum, parseSteps } from "../../lib/helpers";

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

// ── Batch calculation ──────────────────────────────────────────────────────

export function calcBatch(
  row: KetRow,
  caps: Record<string, number>,
  data: DataBundle,
  manualEquipment?: ManualEquipmentOverride | null,
): BatchCalc {
  const recipe = data.recipes[row.recipeCode];
  const structure = data.structures?.[row.recipeCode];
  const processSpec = findProcessSpec(data, row.subRecipeName);
  const resolvedCookMethods = resolveCookMethods(row, data, structure, recipe);
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

    // Merge categories from gross into structure-sourced ingredients.
    // Structure ingredient names often carry a country prefix ("FA-DE Spice, Sea Salt")
    // while gross ingredients may not ("Spice, Sea Salt") — index both forms so the
    // lookup succeeds regardless of which side has the prefix.
    if (subRecipeFound && structure && recipe) {
      const grossHits = matchGrossIngredients(recipe.grossIngredients, row.subRecipeName);
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

  const bibleMatches = new Map<string, EquipBibleEntry>();
  for (const equipment of resolvedCookMethods) {
    const match = equipment === "BRAISER"
      ? findBraiserBibleMatch(row.subRecipeName, data.equipmentBible)
      : findBibleCapacity(row.subRecipeName, equipment, data.equipmentBible);
    if (match) bibleMatches.set(equipment, match);
  }

  if (manualEquipment?.equipment && manualEquipment.capacityKg > 0) {
    const manualName = manualEquipment.equipment.trim().toUpperCase();
    if (manualName) resolvedCookMethods.push(manualName);
  }

  const effectiveCap = (e: string) => {
    // An explicit manual cap — including an intentional "0" to disable this
    // equipment entirely, a supported value in the sidebar — always wins.
    // The Kuechenbible match only fills in when the user hasn't set anything
    // for this equipment; it must never silently override a manual choice.
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

  // Whether the Bible match is actually the value effectiveCap("BRAISER") used
  // (i.e. no manual override is set) — the UI must only show the "📖
  // Kuechenbible" tag when that entry is truly the active capacity, not
  // whenever a match merely exists but a manual cap has taken precedence.
  const bibleActive = (equipment: string) => !!bibleMatches.get(equipment) && caps[equipment] === undefined;

  // Per-Equipment Batche: jede Cook Method mit bekannter Kapazität berechnet eigenständig
  const equipBatches: EquipBatch[] = resolvedCookMethods
    .filter(m => effectiveCap(m) > 0)
    .map(m => {
      const cap = effectiveCap(m);
      const fullBatches = totalKg > 0 ? Math.floor(totalKg / cap) : 0;
      const remainder = totalKg > 0 ? +(totalKg - fullBatches * cap).toFixed(3) : 0;
      const b = fullBatches + (remainder > 0 ? 1 : 0);
      return {
        equip: m,
        label: EQUIP_LABELS[m] ?? m,
        capacityKg: cap,
        batches: Math.max(b, totalKg > 0 ? 1 : 0),
        perBatchKg: cap,
        remainderKg: remainder,
        bibleMatch: bibleActive(m) ? bibleMatches.get(m) ?? null : null,
      };
    });

  // Primär-Equipment für Ingredient-Aufschlüsselung = erstes aus EQUIP_PRIORITY
  const primaryEquip =
    EQUIP_PRIORITY.find(e => resolvedCookMethods.includes(e) && effectiveCap(e) > 0) ??
    resolvedCookMethods.find(m => effectiveCap(m) > 0) ??
    null;

  const capacityKg = primaryEquip ? effectiveCap(primaryEquip) : null;
  const primaryCapBibleMatch = primaryEquip && bibleActive(primaryEquip) ? bibleMatches.get(primaryEquip) ?? null : null;
  const primaryBatch = equipBatches.find(eb => eb.equip === primaryEquip);
  const batches = primaryBatch?.batches ?? 0;
  const perBatchKg = primaryBatch?.perBatchKg ?? (capacityKg ?? 0);
  const remainderKg = primaryBatch?.remainderKg ?? 0;

  const ING_CAT_ORDER: Record<string, number> = { SPI: 0, PHF: 1, DAI: 2, PRO: 3 };
  for (const ing of ingredients) {
    // Zutaten-Menge für einen vollen Batch (proportional zur Batch-Kapazität)
    ing.perBatchKg = totalKg > 0 && perBatchKg > 0
      ? +(ing.totalKg / totalKg * perBatchKg).toFixed(3)
      : 0;
  }
  ingredients.sort((a, b) => {
    const ao = ING_CAT_ORDER[a.category.trim().toUpperCase().slice(0, 3)] ?? 99;
    const bo = ING_CAT_ORDER[b.category.trim().toUpperCase().slice(0, 3)] ?? 99;
    if (ao !== bo) return ao - bo;
    return b.totalKg - a.totalKg; // innerhalb Kategorie: schwerste zuerst
  });

  const instructionPair = findSubRecipeInstructions(recipe, data.mealCatalog, data.instructions, row.subRecipeName);

  return {
    totalKg, equipBatches, primaryEquip, capacityKg, primaryCapBibleMatch, batches, perBatchKg, remainderKg,
    resolvedCookMethods, manualEquipment: manualEquipment ?? null,
    ingredients, recipeFound: !!(recipe || structure), subRecipeFound, cookingInstructions,
    subRecipeInstructions: instructionPair.english,
    subRecipeInstructionsDE: instructionPair.german,
    subRecipeInstructionsGermanFallback: instructionPair.germanIsFallback,
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
