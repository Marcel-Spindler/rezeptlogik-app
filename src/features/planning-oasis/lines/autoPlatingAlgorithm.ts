// Auto-Plating-Algorithmus: Optimale Linienbelegung basierend auf Allergenen,
// Volumen und Cup-Detection. Minimiert Allergenwechsel, maximiert Durchsatz.
import type { DataBundle } from "../../../core/types";
import { DAYS, SLOTS, type PlanDay, type ScheduleMap } from "./linePlanningDomain";

// ─── Allergen-Kategorien (aus AllergenPlatingView) ───────────────────────────

const ALLERGEN_MAP: Record<string, string> = {
  "MILCH (EINSCHLIESSLICH LAKTOSE)": "Milch",
  "MILCH": "Milch",
  "SCHWEFELDIOXIDE UND SULFITE": "Sulfite",
  "FISCH": "Fisch",
  "EIER": "Eier",
  "SESAMSAMEN": "Sesam",
  "SESAM": "Sesam",
  "SELLERIE": "Sellerie",
  "SENF": "Senf",
  "SCHALENFRÜCHTE": "Nüsse",
  "KASCHUNÜSSE": "Nüsse",
  "MANDELN": "Nüsse",
  "NÜSSE": "Nüsse",
  "SOJA": "Soja",
  "GLUTENHALTIGES GETREIDE": "Gluten",
  "WEIZEN": "Gluten",
};

// ─── Types ───────────────────────────────────────────────────────────────────

export type PetDayRecipe = {
  code: string;
  name: string;
  target: number;
  day: PlanDay;
  allergens: Set<string>;
  hasCup: boolean;
  isSeafood: boolean;
};

export type AutoPlatingResult = {
  schedule: ScheduleMap;
  cuppingBySlot: Record<string, string>; // "day|slotKey" → cup recipe names
  summary: string;
};

// ─── PET CSV Parser ──────────────────────────────────────────────────────────

const DATE_TO_DAY: Record<number, PlanDay> = {
  1: "Montag", 2: "Dienstag", 3: "Mittwoch", 4: "Donnerstag",
  5: "Freitag", 6: "Samstag", 0: "Sonntag",
};

export function parsePetCsv(text: string): Map<PlanDay, PetDayRecipe[]> {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const headers = parseRow(lines[0] ?? "");
  const shiftIdx = headers.indexOf("Production Shift");
  const nameIdx = headers.indexOf("Recipe Name");
  const targetIdx = headers.indexOf("Recipe WO Target");

  const result = new Map<PlanDay, PetDayRecipe[]>();

  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    if (!row[shiftIdx] || !row[nameIdx]) continue;

    const dateStr = (row[shiftIdx] ?? "").split(" - ")[0]?.trim();
    if (!dateStr) continue;
    const date = new Date(dateStr);
    const dayOfWeek = date.getDay();
    const day = DATE_TO_DAY[dayOfWeek];
    if (!day) continue;

    const fullName = row[nameIdx] ?? "";
    const codeMatch = fullName.match(/[A-Z]{2}\d{4}[A-Z0-9]+/);
    const code = codeMatch ? codeMatch[0] : "";
    if (!code) continue;

    const target = Math.round(parseFloat(row[targetIdx] ?? "0") || 0);
    if (target <= 0) continue;

    const name = fullName
      .replace(/^.*?-\s*/, "")
      .replace(/\s*\[.*?\]\s*$/, "")
      .replace(/\s*\{.*?\}\s*$/, "")
      .trim();

    if (!result.has(day)) result.set(day, []);
    result.get(day)!.push({
      code, name, target, day,
      allergens: new Set(), // filled later
      hasCup: false, // filled later
      isSeafood: /salmon|shrimp|prawn|fish|seafood|cod|tuna|barramundi|lachs|garnele/i.test(fullName),
    });
  }

  return result;
}

function parseRow(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes; continue; }
    if (char === "," && !inQuotes) { result.push(current.trim()); current = ""; continue; }
    current += char;
  }
  result.push(current.trim());
  return result;
}

// ─── Allergen & Cup Extraction ───────────────────────────────────────────────

export function extractAllergenProfile(code: string, data: DataBundle): Set<string> {
  const allergens = new Set<string>();
  const recipe = data.recipes[code];
  if (!recipe) return allergens;

  // Primary: market-level allergen string
  const marketData = recipe.markets.DE ?? recipe.markets.BENL ?? recipe.markets.DKSE;
  if (marketData?.allergens) {
    for (const raw of marketData.allergens.split(",")) {
      const trimmed = raw.trim().toUpperCase();
      const mapped = ALLERGEN_MAP[trimmed];
      if (mapped) allergens.add(mapped);
      // Partial match
      for (const [key, val] of Object.entries(ALLERGEN_MAP)) {
        if (trimmed.includes(key) || key.includes(trimmed)) allergens.add(val);
      }
    }
  }

  // Fallback: structure-level ingredient allergens
  if (allergens.size === 0) {
    const struct = data.structures?.[code];
    if (struct) {
      const market = struct.markets?.DE ?? struct.markets?.BENL ?? struct.markets?.DKSE;
      if (Array.isArray(market)) {
        walkSubRecipes(market, allergens);
      }
    }
  }

  return allergens;
}

function walkSubRecipes(subs: any[], allergens: Set<string>): void {
  for (const sub of subs) {
    if (sub.ingredients) {
      for (const ing of sub.ingredients) {
        if (ing.allergen) {
          const upper = ing.allergen.trim().toUpperCase();
          const mapped = ALLERGEN_MAP[upper];
          if (mapped) allergens.add(mapped);
          for (const [key, val] of Object.entries(ALLERGEN_MAP)) {
            if (upper.includes(key)) allergens.add(val);
          }
        }
      }
    }
    if (sub.subRecipes?.length) walkSubRecipes(sub.subRecipes, allergens);
  }
}

export function detectCup(code: string, data: DataBundle): boolean {
  const recipe = data.recipes[code];
  if (!recipe) return false;
  const catalog = recipe.catalog;
  if (catalog?.sheets?.["Verden Meal Database"]?.["Cup"] === "Yes") return true;
  if (catalog?.sheets?.["Meal DB_Product"]?.["Cup"] === "Yes") return true;
  const market = recipe.markets.DE ?? recipe.markets.BENL ?? recipe.markets.DKSE;
  if (market?.compartmentName && /cup/i.test(market.compartmentName)) return true;
  return false;
}

// ─── Allergen Similarity ─────────────────────────────────────────────────────

function allergenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection++;
  return intersection / union.size; // Jaccard
}

function allergenChangeCost(prev: Set<string>, next: Set<string>): number {
  let newAllergens = 0;
  for (const a of next) if (!prev.has(a)) newAllergens++;
  return newAllergens;
}

// ─── Greedy TSP: Sort recipes to minimize allergen changes ───────────────────

function sortByMinAllergenChanges(recipes: PetDayRecipe[]): PetDayRecipe[] {
  if (recipes.length <= 1) return recipes;

  // Seafood always at the end (MHD compliance)
  const nonFish = recipes.filter(r => !r.isSeafood);
  const fish = recipes.filter(r => r.isSeafood);

  const sorted: PetDayRecipe[] = [];
  const remaining = [...nonFish];

  // Start with highest volume
  remaining.sort((a, b) => b.target - a.target);
  if (remaining.length > 0) {
    sorted.push(remaining.shift()!);
  }

  // Greedy nearest-neighbor
  while (remaining.length > 0) {
    const last = sorted[sorted.length - 1];
    let bestIdx = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cost = allergenChangeCost(last.allergens, remaining[i].allergens);
      // Tie-break: prefer higher volume
      const adjustedCost = cost - remaining[i].target / 100000;
      if (adjustedCost < bestCost) {
        bestCost = adjustedCost;
        bestIdx = i;
      }
    }
    sorted.push(remaining.splice(bestIdx, 1)[0]);
  }

  // Append fish at end
  fish.sort((a, b) => b.target - a.target);
  sorted.push(...fish);

  return sorted;
}

// ─── Main Algorithm ──────────────────────────────────────────────────────────

const LINE_CAPACITY_PER_HOUR = 1200; // default portions/hour
const THIRD_LINE_THRESHOLD = 16000; // daily target above which 3rd line activates

export function autoPlating(
  petByDay: Map<PlanDay, PetDayRecipe[]>,
  data: DataBundle,
  lineCapacity: Record<string, number>,
): AutoPlatingResult {
  const schedule: ScheduleMap = {};
  const cuppingBySlot: Record<string, string> = {};
  const summaryParts: string[] = [];

  // Enrich PET data with allergens and cup info
  for (const [, recipes] of petByDay) {
    for (const r of recipes) {
      r.allergens = extractAllergenProfile(r.code, data);
      r.hasCup = detectCup(r.code, data);
    }
  }

  for (const day of DAYS) {
    const dayRecipes = petByDay.get(day);
    if (!dayRecipes || dayRecipes.length === 0) continue;

    const dayTotal = dayRecipes.reduce((sum, r) => sum + r.target, 0);
    const useThirdLine = dayTotal > THIRD_LINE_THRESHOLD;
    const lineCount = useThirdLine ? 3 : 2;

    // ─── Cluster recipes into line groups ────────────────────────────────
    // Sort by volume desc
    const sorted = [...dayRecipes].sort((a, b) => b.target - a.target);

    // Group by allergen similarity
    const line1Recipes: PetDayRecipe[] = [];
    const line2Recipes: PetDayRecipe[] = [];
    const line3Recipes: PetDayRecipe[] = [];

    // Strategy: Line 1 = high-volume cluster with similar allergens
    // Pick the top recipe, then greedily add recipes with high similarity
    if (sorted.length > 0) {
      const anchor = sorted[0];
      line1Recipes.push(anchor);
      const remaining = sorted.slice(1);

      // Target: Line 1 gets ~50% of volume (highrunner)
      const line1Target = dayTotal * 0.5;
      let line1Volume = anchor.target;

      // Add recipes with high allergen similarity until target met
      const scored = remaining.map(r => ({
        recipe: r,
        similarity: allergenSimilarity(anchor.allergens, r.allergens),
        volume: r.target,
      }));
      scored.sort((a, b) => (b.similarity * 0.7 + b.volume / dayTotal * 0.3) - (a.similarity * 0.7 + a.volume / dayTotal * 0.3));

      for (const { recipe } of scored) {
        if (line1Volume >= line1Target) break;
        if (allergenSimilarity(anchor.allergens, recipe.allergens) >= 0.4) {
          line1Recipes.push(recipe);
          line1Volume += recipe.target;
        }
      }

      // Remaining go to line 2 (and line 3 if active)
      const assigned = new Set(line1Recipes.map(r => r.code));
      const rest = sorted.filter(r => !assigned.has(r.code));

      if (useThirdLine && rest.length > 3) {
        // Split rest: higher volume → line 2, lower → line 3
        const midpoint = Math.ceil(rest.length * 0.6);
        line2Recipes.push(...rest.slice(0, midpoint));
        line3Recipes.push(...rest.slice(midpoint));
      } else {
        line2Recipes.push(...rest);
      }
    }

    // ─── Sort each line for minimal allergen changes ─────────────────────
    const sortedLine1 = sortByMinAllergenChanges(line1Recipes);
    const sortedLine2 = sortByMinAllergenChanges(line2Recipes);
    const sortedLine3 = sortByMinAllergenChanges(line3Recipes);

    const lineGroups = [sortedLine1, sortedLine2, sortedLine3].slice(0, lineCount);

    // ─── Fill slots ──────────────────────────────────────────────────────
    for (let li = 0; li < lineGroups.length; li++) {
      const lineRecipes = lineGroups[li];
      const cap = lineCapacity[String(li)] ?? LINE_CAPACITY_PER_HOUR;
      let slotIdx = 0;
      let remainingInSlot = cap; // portions left in current slot

      for (const recipe of lineRecipes) {
        let portionsLeft = recipe.target;

        while (portionsLeft > 0 && slotIdx < SLOTS.length) {
          const slot = SLOTS[slotIdx];
          const key = `${day}|${slot.key}|${li}`;

          // Assign recipe to this slot
          schedule[key] = {
            code: recipe.code,
            name: recipe.name,
            totalPlanned: recipe.target,
            nordics: 0, bnl: 0, de: recipe.target,
            speedPerMin: Math.round(cap / 60),
            isSeafood: recipe.isSeafood,
          };

          const fill = Math.min(portionsLeft, remainingInSlot);
          portionsLeft -= fill;
          remainingInSlot -= fill;

          if (remainingInSlot <= 0) {
            slotIdx++;
            remainingInSlot = cap;
          }
        }

        // Cup recipes → cupping column
        if (recipe.hasCup && slotIdx < SLOTS.length) {
          const slotKey = SLOTS[Math.min(slotIdx, SLOTS.length - 1)].key;
          const cupKey = `${day}|${slotKey}`;
          const existing = cuppingBySlot[cupKey];
          cuppingBySlot[cupKey] = existing ? `${existing}, ${recipe.name}` : `(Cup) ${recipe.name}`;
        }
      }
    }

    const changes1 = countAllergenChanges(sortedLine1);
    const changes2 = countAllergenChanges(sortedLine2);
    summaryParts.push(`${day}: ${lineCount}L, L1=${sortedLine1.length} Meals (${changes1} Wechsel), L2=${sortedLine2.length} Meals (${changes2} Wechsel)${useThirdLine ? `, L3=${sortedLine3.length}` : ""}`);
  }

  return {
    schedule,
    cuppingBySlot,
    summary: summaryParts.join("\n"),
  };
}

function countAllergenChanges(recipes: PetDayRecipe[]): number {
  let changes = 0;
  for (let i = 1; i < recipes.length; i++) {
    if (allergenChangeCost(recipes[i - 1].allergens, recipes[i].allergens) > 0) changes++;
  }
  return changes;
}
