// Reine Allergen→Chiller-Zuteilungslogik des Blast Chiller Bots — extrahiert aus
// BlastChillerView.tsx, damit dieselbe Zuteilung auch pro einzelner KET-WO (ohne
// separaten CSV-Upload) berechnet werden kann, z.B. im KET Plan / WO Breakdown.
import type { DataBundle, DetailedSubRecipe } from "../../core/types";

export type ChillerKey = "1" | "3" | "4" | "5" | "6";

export interface ChillerCfg {
  label: string; sub: string;
  headBg: string; headColor: string; cntBg: string; cntColor: string;
}

export const CHILLER_CFG: Record<ChillerKey, ChillerCfg> = {
  "1": { label: "Chiller 1 & 2", sub: "Allergenfrei",   headBg: "#E8F5E9", headColor: "#1B5E20", cntBg: "#A5D6A7", cntColor: "#1B5E20" },
  "3": { label: "Chiller 3",     sub: "Sulfite",         headBg: "#FFF8E1", headColor: "#7B3F00", cntBg: "#FFD54F", cntColor: "#7B3F00" },
  "4": { label: "Chiller 4",     sub: "Milch",           headBg: "#E3F2FD", headColor: "#0D3780", cntBg: "#90CAF9", cntColor: "#0D3780" },
  "5": { label: "Chiller 5",     sub: "Milch + Sulfite", headBg: "#F3E5F5", headColor: "#4A148C", cntBg: "#CE93D8", cntColor: "#4A148C" },
  "6": { label: "Chiller 6",     sub: "Rest-Pool",       headBg: "#FFEBEE", headColor: "#B71C1C", cntBg: "#EF9A9A", cntColor: "#B71C1C" },
};

export const CHILLER_KEYS: ChillerKey[] = ["1", "3", "4", "5", "6"];

// allergen=null bedeutet "keinerlei Datenpunkt gefunden" (kein Struktur-Match, kein
// Rezept-Eintrag) — NICHT mit einer bestätigten "keine Allergene"-Aussage verwechseln.
// Sicherheitsregel: unbekannt wird NIE als allergenfrei (Chiller 1&2) gewertet, sondern
// vorsichtshalber in den Rest-Pool (Chiller 6) einsortiert.
export function assignChiller(allergen: string | null): ChillerKey {
  if (allergen == null || !allergen.trim()) return "6";
  if (allergen.trim().toUpperCase() === "KEINE") return "1";
  const u = allergen.toUpperCase();
  const m = u.includes("MILCH");
  const s = u.includes("SCHWEFELDIOXIDE") || u.includes("SULFITE");
  const rest = u
    .replace(/MILCH \(EINSCHLIESSLICH LAKTOSE\)/g, "")
    .replace(/SCHWEFELDIOXIDE UND SULFITE/g, "")
    .split(",").map(p => p.trim()).filter(p => p.length > 0);
  const x = rest.length > 0;
  if (x) return "6";
  if (m && s) return "5";
  if (s) return "3";
  if (m) return "4";
  return "6";
}

// Exportiert (statt privat), da BlastChillerView.tsx dieselbe Struktursuche
// zusätzlich für seine eigene "Quelle: Struktur vs. Rezept-Fallback"-Statistik braucht.
export function normStr(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

export function searchSubRec(subs: DetailedSubRecipe[], targetNorm: string): DetailedSubRecipe | null {
  for (const sub of subs) {
    if (normStr(sub.name) === targetNorm) return sub;
    const found = searchSubRec(sub.subRecipes, targetNorm);
    if (found) return found;
  }
  return null;
}

function collectIngredientAllergens(sub: DetailedSubRecipe, acc: Set<string>): void {
  for (const ing of sub.ingredients) if (ing.allergen) acc.add(ing.allergen.trim());
  for (const child of sub.subRecipes) collectIngredientAllergens(child, acc);
}

/**
 * Deklarierter Allergen-String für ein Sub-Rezept (WO), aus der bereits geladenen
 * Detailbaum-Struktur der App. Priorität: Ingredient-Ebene aus Struktur-Match >
 * Rezept-Ebene (RecipeMarketDetails) > null ("keine Daten gefunden" — ausdrücklich
 * NICHT "keine Allergene").
 */
export function computeWoAllergen(
  data: DataBundle,
  recipeCode: string,
  subRecipeName: string,
): string | null {
  const structure = data.structures?.[recipeCode];

  if (structure) {
    const targetNorm = normStr(subRecipeName);
    for (const market of ["DE", "BENL", "DKSE"] as const) {
      const subs = structure.markets[market];
      if (!subs?.length) continue;
      const found = searchSubRec(subs, targetNorm);
      if (found) {
        const acc = new Set<string>();
        collectIngredientAllergens(found, acc);
        if (acc.size > 0) return [...acc].join(", ");
        // Sub-Rezept gefunden, aber keine Ingredient-Allergene dort getaggt — das ist
        // eine Datenlücke, kein verlässliches "allergenfrei". NICHT hart "KEINE"
        // zurückgeben (Sicherheitsrisiko für die Chiller-Trennung), sondern wie die
        // CONTAINS-Anzeige in ketLogic.ts auf die Rezept-Ebene zurückfallen.
        break;
      }
    }
  }

  const recipe = data.recipes[recipeCode];
  if (recipe) {
    for (const market of ["DE", "BENL", "DKSE"] as const) {
      const a = recipe.markets[market]?.allergens;
      if (a && a.toLowerCase() !== "null") return a;
    }
  }

  return null;
}

export interface ChillerAssignment {
  key: ChillerKey;
  allergen: string | null;
  cfg: ChillerCfg;
  // true wenn die Zuteilung NICHT auf einer echten Allergen-Angabe beruht (keinerlei
  // Datenpunkt gefunden) — UI sollte das sichtbar als "bitte manuell prüfen" markieren.
  unknown: boolean;
}

// Gleiche Zuteilung wie der eigenständige Blast Chiller Bot, nur direkt aus den
// bereits geladenen App-Daten statt aus einem separat hochgeladenen KET-CSV.
export function computeWoChiller(
  data: DataBundle,
  recipeCode: string,
  subRecipeName: string,
): ChillerAssignment {
  const allergen = computeWoAllergen(data, recipeCode, subRecipeName);
  const key = assignChiller(allergen);
  return { key, allergen, cfg: CHILLER_CFG[key], unknown: allergen == null };
}
