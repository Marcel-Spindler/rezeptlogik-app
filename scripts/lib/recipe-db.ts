// Persistente Rezept-Datenbank: akkumuliert alle je gesehenen Rezept- und Strukturdaten.
// Wird in SOURCE_DIR (z.B. C:\Rezeptlogik\recipe-db.json) gespeichert, damit sie
// über Git-Pulls hinaus erhalten bleibt.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Recipe, RecipeStructure } from "../../src/types.ts";

export interface RecipeDbEntry {
  recipe?: Recipe;
  structure?: RecipeStructure;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
}

export interface RecipeDb {
  lastUpdatedAt: string;
  recipes: Record<string, RecipeDbEntry>;
}

const DB_FILE = "recipe-db.json";

export function loadRecipeDb(sourceDir: string): RecipeDb {
  const path = join(sourceDir, DB_FILE);
  if (!existsSync(path)) return { lastUpdatedAt: new Date().toISOString(), recipes: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RecipeDb;
  } catch {
    console.warn("  recipe-db.json konnte nicht gelesen werden — neu erstellen.");
    return { lastUpdatedAt: new Date().toISOString(), recipes: {} };
  }
}

function countStructureIngredients(structure: RecipeStructure): number {
  let n = 0;
  for (const mkt of Object.values(structure.markets ?? {})) {
    if (Array.isArray(mkt)) {
      (mkt as any[]).forEach((sr: any) => {
        n += sr.ingredients?.length ?? 0;
        (sr.subRecipes ?? []).forEach((c: any) => { n += c.ingredients?.length ?? 0; });
      });
    }
  }
  return n;
}

// Mergt neue Rezepte und Strukturen in die DB. Strukturen werden nur überschrieben
// wenn die neuen Daten mehr oder gleich viele Zutaten enthalten (kein Datenverlust).
export function mergeIntoDb(
  db: RecipeDb,
  recipes: Record<string, Recipe>,
  structures: Record<string, RecipeStructure>
): { added: number; updated: number } {
  const now = new Date().toISOString();
  let added = 0, updated = 0;

  const allCodes = new Set([...Object.keys(recipes), ...Object.keys(structures)]);
  for (const code of allCodes) {
    if (!db.recipes[code]) {
      db.recipes[code] = { firstSeenAt: now, lastSeenAt: now, seenCount: 1 };
      added++;
    } else {
      db.recipes[code].lastSeenAt = now;
      db.recipes[code].seenCount = (db.recipes[code].seenCount ?? 0) + 1;
      updated++;
    }

    if (recipes[code]) {
      db.recipes[code].recipe = recipes[code];
    }

    if (structures[code]) {
      const newStr = structures[code];
      const existingStr = db.recipes[code].structure;
      if (!existingStr || countStructureIngredients(newStr) >= countStructureIngredients(existingStr)) {
        db.recipes[code].structure = newStr;
      }
    }
  }

  db.lastUpdatedAt = now;
  return { added, updated };
}

export function saveRecipeDb(sourceDir: string, db: RecipeDb): void {
  const path = join(sourceDir, DB_FILE);
  writeFileSync(path, JSON.stringify(db));
  const count = Object.keys(db.recipes).length;
  console.log(`  recipe-db.json: ${count} Rezepte gesamt → ${path}`);
}

// Ergänzt recipes/structures aus der DB für weekRecipe-Codes die in den aktuellen
// CSVs fehlen (z.B. weil ein Rezept diese Woche nicht im Export enthalten ist).
export function supplementFromDb(
  db: RecipeDb,
  recipes: Record<string, Recipe>,
  structures: Record<string, RecipeStructure>,
  weekRecipeCodes: string[]
): { supplementedRecipes: number; supplementedStructures: number } {
  let supplementedRecipes = 0, supplementedStructures = 0;
  for (const code of weekRecipeCodes) {
    const entry = db.recipes[code];
    if (!entry) continue;
    if (!recipes[code] && entry.recipe) {
      recipes[code] = entry.recipe;
      supplementedRecipes++;
    }
    if (!structures[code] && entry.structure) {
      structures[code] = entry.structure;
      supplementedStructures++;
    }
  }
  return { supplementedRecipes, supplementedStructures };
}
