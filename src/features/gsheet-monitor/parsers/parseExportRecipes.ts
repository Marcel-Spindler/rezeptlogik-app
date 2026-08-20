// GSheet Monitor / Postblast Live – Parser für "export-recipes*.csv"
// (dasselbe Format, das scripts/import-sub-recipes.ts für die StructureTab
// nutzt). Wird hier NICHT für die volle Rezeptstruktur gebraucht, sondern nur
// für einen schmalen Ausschnitt: "wie viel Gramm/kg eines Sub-Rezepts steckt
// in einer Portion des Meals" — die fehlende Zutat, um aus einer bekannten
// Ziel-Portionenzahl (KET/WMS) eine Ziel-Menge in kg zu SCHÄTZEN, wenn der
// Firestore-Produktionsplan für eine Woche noch keine echte Zielmenge hat.
import Papa from "papaparse";
import { extractCode } from "../../../lib/helpers";

export interface RecipeWeightLookup {
  // key = `${recipeCode}||${subRecipeName}` → Gramm pro Portion
  gramsPerPortion: Map<string, number>;
  recipeCount: number;
  rowCount: number;
}

const GRAM_UOMS = new Set(["g", "gram", "grams"]);
const KG_UOMS = new Set(["kg", "kilogram", "kilograms"]);

export function recipeWeightKey(recipeCode: string, subRecipeName: string): string {
  return `${recipeCode}||${subRecipeName}`;
}

export function parseExportRecipesCsv(text: string): RecipeWeightLookup {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
  });

  const gramsPerPortion = new Map<string, number>();
  const codes = new Set<string>();

  for (const row of result.data) {
    const fullName = (row["Recipe name"] ?? "").trim();
    if (!fullName) continue;
    // Sowohl Sub-Rezept-Zeilen (Typ "S", z.B. "Sauce - ...") als auch Direkt-
    // Zutaten (Typ "I", z.B. "FA-DE Cheese, Shredded" oder vorportionierte
    // Nudeln) können im WMS eine eigene WO bekommen — beide Zeilentypen tragen
    // dieselbe Portionsmenge-Spalte, also beide für die kg-Schätzung nutzen.
    const type = (row["Ingredient Type"] ?? "").trim().toUpperCase();
    if (type !== "S" && type !== "I") continue;

    // extractCode erwartet den Code als Präfix ("FV1234A - Name [DE]"). Sehr
    // vereinzelt kommt aus dem Export auch "[DE] - FV1234A - Name" vorbei
    // (Markt-Klammer VOR statt nach dem Code, z.B. bei FV1351A durchgängig
    // beobachtet) — dann den Marker abstreifen und erneut versuchen.
    const code = extractCode(fullName) || extractCode(fullName.replace(/^\[[A-Z/]+\]\s*-?\s*/, ""));
    const subName = (row["Ingredient Name"] ?? "").trim();
    if (!code || !subName) continue;

    const uom = (row["Ingredient UOM"] ?? "").trim().toLowerCase();
    const qty = parseFloat((row["Ingredient Quantity"] ?? "0").replace(",", "."));
    if (!isFinite(qty) || qty <= 0) continue;

    let grams: number | null = null;
    if (GRAM_UOMS.has(uom)) grams = qty;
    else if (KG_UOMS.has(uom)) grams = qty * 1000;
    if (grams == null) continue; // "each"/"pcs"/... — keine Gewichtsangabe, überspringen

    const key = recipeWeightKey(code, subName);
    if (!gramsPerPortion.has(key)) gramsPerPortion.set(key, grams);
    codes.add(code);
  }

  return { gramsPerPortion, recipeCount: codes.size, rowCount: result.data.length };
}
