// Reine Allergen→Chiller-Zuteilungslogik des Blast Chiller Bots — extrahiert aus
// BlastChillerView.tsx, damit dieselbe Zuteilung auch pro einzelner KET-WO (ohne
// separaten CSV-Upload) berechnet werden kann, z.B. im KET Plan / WO Breakdown.
import type { DataBundle, DetailedSubRecipe } from "../../core/types";
import { computeStatedOutputG } from "../whatif/whatIfAggregate";

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
  const hasOtherAllergens = rest.length > 0;
  if (hasOtherAllergens) return "6";
  if (m && s) return "5";
  if (s) return "3";
  if (m) return "4";
  return "6";
}

// Exportiert (statt privat), da BlastChillerView.tsx dieselbe Struktursuche
// zusätzlich für seine eigene "Quelle: Struktur vs. Rezept-Fallback"-Statistik braucht.
export function normStr(s: string): string {
  return (s || "").toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Map "Recipe ID" (REC-013937-4-004, wie im KET-CSV) → FV-Struktur-Schlüssel.
 * Fallback, wenn im CSV kein FV-Code in "Recipe Name" steht, aber die "Recipe ID"
 * gefüllt ist — verhindert vermeidbare UNBEKANNT-Fälle.
 */
export function buildRecipeIdIndex(data: DataBundle): Map<string, string> {
  const m = new Map<string, string>();
  for (const [key, s] of Object.entries(data.structures ?? {})) {
    const id = s.recipeId?.trim().toUpperCase();
    if (id) m.set(id, key);
  }
  return m;
}

export function searchSubRec(subs: DetailedSubRecipe[], targetNorm: string): DetailedSubRecipe | null {
  for (const sub of subs) {
    if (normStr(sub.name) === targetNorm) return sub;
    const found = searchSubRec(sub.subRecipes, targetNorm);
    if (found) return found;
  }
  return null;
}

// ── Unschärfe-Match: Sub-Rezept-Namen im KET-CSV weichen oft leicht von den
// Strukturnamen ab ("S&P Roasted Green Beans 1" vs "S&P Roasted Green Beans LESS
// FAT 1", "Batch 160g", "- REWORK", "- Fresh"). Ohne Fuzzy-Fallback landen die
// betroffenen WOs fälschlich als UNBEKANNT im Rest-Pool. Wir vergleichen daher
// zusätzlich token-basiert: identifizierende Wörter der einen Seite müssen ~alle
// in der anderen vorkommen. Rein additiv — der exakte Match läuft immer zuerst.
const SUB_NOISE_TOKENS = new Set([
  "batch", "less", "fat", "oil", "salt", "fresh", "iqf", "ph", "rework", "use",
  "new", "old", "g", "kg", "ml", "pcs", "fa", "the", "and", "with", "of", "a",
]);

export function subKeyTokens(name: string): string[] {
  return normStr(name)
    .split(" ")
    .filter((t) => t.length > 1 && !SUB_NOISE_TOKENS.has(t) && !/^\d+$/.test(t));
}

export function searchSubRecLoose(subs: DetailedSubRecipe[], targetName: string): DetailedSubRecipe | null {
  const target = new Set(subKeyTokens(targetName));
  if (target.size === 0) return null;
  let best: DetailedSubRecipe | null = null;
  let bestScore = 0;
  const walk = (list: DetailedSubRecipe[]): void => {
    for (const sub of list) {
      const st = subKeyTokens(sub.name);
      let inter = 0;
      for (const t of st) if (target.has(t)) inter++;
      const smaller = Math.min(st.length, target.size);
      const subsetMatch = smaller >= 2 && inter >= smaller;
      const overlapMatch = inter >= 3 && smaller > 0 && inter / smaller >= 0.8;
      if ((subsetMatch || overlapMatch) && inter > bestScore) {
        best = sub;
        bestScore = inter;
      }
      walk(sub.subRecipes);
    }
  };
  walk(subs);
  return best;
}

function collectIngredientAllergens(sub: DetailedSubRecipe, acc: Set<string>): void {
  for (const ing of sub.ingredients) if (ing.allergen) acc.add(ing.allergen.trim());
  for (const child of sub.subRecipes) collectIngredientAllergens(child, acc);
}

const ALLERGEN_MARKETS = ["DE", "BENL", "DKSE"] as const;

/** Woher die Allergen-Angabe stammt — steuert die "bitte prüfen"-Markierung im Bot.
 *  "sub"            = exakter Sub-Rezept-Treffer in der Struktur (bestmöglich)
 *  "sub-fuzzy"      = Sub-Rezept token-basiert gematcht (leichte Namensabweichung)
 *  "recipe"         = rezeptweite Union aller Struktur-Allergene (Sub nicht auffindbar)
 *  "recipe-legacy"  = Allergen-Feld aus data.recipes (schwächste Quelle)
 *  "none"           = keinerlei Datenpunkt — echter Unbekannt-Fall */
export type AllergenPrecision = "sub" | "sub-fuzzy" | "recipe" | "recipe-legacy" | "none";

function subAllergenString(found: DetailedSubRecipe): string {
  const acc = new Set<string>();
  collectIngredientAllergens(found, acc);
  // Sub-Rezept gefunden, keine Ingredient-Allergene getaggt — bei vorhandener
  // Struktur vertrauen wir den Daten: das Sub-Rezept ist allergenfrei.
  return acc.size > 0 ? [...acc].join(", ") : "KEINE";
}

/**
 * Deklarierter Allergen-String für ein Sub-Rezept (WO) + Angabe der Quelle.
 * Priorität: exakter Sub-Treffer > Fuzzy-Sub-Treffer > rezeptweite Struktur-Union >
 * data.recipes-Allergenfeld > null ("keine Daten gefunden").
 */
export function computeWoAllergenDetailed(
  data: DataBundle,
  recipeCode: string,
  subRecipeName: string,
): { allergen: string | null; precision: AllergenPrecision } {
  const structure = data.structures?.[recipeCode];

  if (structure) {
    const targetNorm = normStr(subRecipeName);
    // 1) Exakter Sub-Rezept-Treffer.
    for (const market of ALLERGEN_MARKETS) {
      const subs = structure.markets[market];
      if (!subs?.length) continue;
      const found = searchSubRec(subs, targetNorm);
      if (found) return { allergen: subAllergenString(found), precision: "sub" };
    }
    // 2) Fuzzy-Sub-Rezept-Treffer (leichte Namensabweichung im KET-CSV).
    for (const market of ALLERGEN_MARKETS) {
      const subs = structure.markets[market];
      if (!subs?.length) continue;
      const found = searchSubRecLoose(subs, subRecipeName);
      if (found) return { allergen: subAllergenString(found), precision: "sub-fuzzy" };
    }
    // 3) Sub nicht auffindbar — rezeptweite Allergen-Union aus der Struktur.
    //    Sicher konservativ (eher zu breit als "unbekannt → Rest-Pool").
    for (const market of ALLERGEN_MARKETS) {
      const subs = structure.markets[market];
      if (!subs?.length) continue;
      const acc = new Set<string>();
      for (const s of subs) collectIngredientAllergens(s, acc);
      return { allergen: acc.size > 0 ? [...acc].join(", ") : "KEINE", precision: "recipe" };
    }
  }

  const recipe = data.recipes[recipeCode];
  if (recipe) {
    for (const market of ALLERGEN_MARKETS) {
      const a = recipe.markets[market]?.allergens;
      if (a && a.toLowerCase() !== "null") return { allergen: a, precision: "recipe-legacy" };
    }
  }

  return { allergen: null, precision: "none" };
}

/**
 * Rezeptweiter Allergen-String: Union ALLER Struktur-Allergene des Rezepts plus
 * das Allergen-Feld aus data.recipes. Dient als Sicherheitsnetz — eine Komponente,
 * die "KEINE" meldet, darf trotzdem nicht in den Allergenfrei-Chiller, wenn das
 * Rezept insgesamt ein Allergen führt (Struktur-Tagging kann lückenhaft sein).
 * "" = das Rezept ist laut allen Quellen allergenfrei.
 */
export function computeRecipeWideAllergen(data: DataBundle, recipeCode: string): string {
  const acc = new Set<string>();
  const structure = data.structures?.[recipeCode];
  if (structure) {
    for (const market of ALLERGEN_MARKETS) {
      const subs = structure.markets[market];
      if (!subs?.length) continue;
      for (const s of subs) collectIngredientAllergens(s, acc);
    }
  }
  const recipe = data.recipes[recipeCode];
  if (recipe) {
    for (const market of ALLERGEN_MARKETS) {
      const a = recipe.markets[market]?.allergens;
      if (a && a.toLowerCase() !== "null" && a.trim().toUpperCase() !== "KEINE") acc.add(a.trim());
    }
  }
  return [...acc].join(", ");
}

/**
 * Deklarierter Allergen-String für ein Sub-Rezept (WO), aus der bereits geladenen
 * Detailbaum-Struktur der App. Dünner Wrapper um computeWoAllergenDetailed für
 * bestehende Aufrufer.
 */
export function computeWoAllergen(
  data: DataBundle,
  recipeCode: string,
  subRecipeName: string,
): string | null {
  return computeWoAllergenDetailed(data, recipeCode, subRecipeName).allergen;
}

/**
 * Grobe kg-Menge einer WO an der Blast-Chiller-Station: gekochte Portionen ×
 * g/Portion des Sub-Rezepts (MSKU-Menge bzw. aus den Zutaten hochgerechnet,
 * `computeStatedOutputG`). 0 = keine Struktur-/Mengendaten gefunden.
 */
export function computeWoKg(
  data: DataBundle,
  recipeCode: string,
  subRecipeName: string,
  portions: number,
): number {
  if (!portions || portions <= 0) return 0;
  const structure = data.structures?.[recipeCode];
  if (!structure) return 0;
  const targetNorm = normStr(subRecipeName);
  for (const market of ALLERGEN_MARKETS) {
    const subs = structure.markets[market];
    if (!subs?.length) continue;
    const found = searchSubRec(subs, targetNorm) ?? searchSubRecLoose(subs, subRecipeName);
    if (found) {
      const gPerPortion = computeStatedOutputG(found).statedOutputG;
      if (gPerPortion > 0) return (portions * gPerPortion) / 1000;
    }
  }
  return 0;
}

export interface ChillerAssignment {
  key: ChillerKey;
  allergen: string | null;
  cfg: ChillerCfg;
  // true wenn die Zuteilung NICHT auf einer echten Allergen-Angabe beruht (keinerlei
  // Datenpunkt gefunden) — UI sollte das sichtbar als "bitte manuell prüfen" markieren.
  unknown: boolean;
  precision: AllergenPrecision;
}

// Gleiche Zuteilung wie der eigenständige Blast Chiller Bot, nur direkt aus den
// bereits geladenen App-Daten statt aus einem separat hochgeladenen KET-CSV.
export function computeWoChiller(
  data: DataBundle,
  recipeCode: string,
  subRecipeName: string,
): ChillerAssignment {
  const { allergen, precision } = computeWoAllergenDetailed(data, recipeCode, subRecipeName);
  let key = assignChiller(allergen);

  // Sicherheitsnetz: Sub-Rezept sagt "KEINE", aber das Gesamtrezept führt Allergene
  // → konservativ in den Rest-Pool (Chiller 6) statt allergenfrei (Chiller 1&2).
  if (key === "1" && recipeCode) {
    const recipeWide = computeRecipeWideAllergen(data, recipeCode);
    if (recipeWide.length > 0) key = "6";
  }

  return { key, allergen, cfg: CHILLER_CFG[key], unknown: allergen == null, precision };
}
