// Kitchen Mode / Breakdown – generische Format-/Parsing-Helper sowie Ingredient-Yield-Lookup.
import type { DetailedSubRecipe, RecipeStructure } from "../../core/types";

export function fmtNum(value: number, digits = 0) {
  return value.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

/** Known protein ingredient IDs with their GN-tray specs. Extend when new PTN items are added. */
export const PTN_ID_TRAY_SPECS: Record<string, { pcsPerTray: number; pieceKg: number }> = {
  "PTN-00-139317-3": { pcsPerTray: 30, pieceKg: 0.160 }, // Chicken Breast B/S 160g
  "PTN-00-139968-1": { pcsPerTray: 28, pieceKg: 0.140 }, // Salmon Skinless Boneless 140g
};

export function norm(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function parseLocaleNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const cleaned = raw.replace(/\s+/g, "").replace(/[^0-9,.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === ",") return null;

  const hasDot = cleaned.includes(".");
  const hasComma = cleaned.includes(",");

  const normalizeSeparators = (text: string): string => {
    if (hasDot && hasComma) {
      const lastDot = text.lastIndexOf(".");
      const lastComma = text.lastIndexOf(",");
      // Last separator is assumed to be the decimal separator.
      if (lastComma > lastDot) {
        return text.replace(/\./g, "").replace(",", ".");
      }
      return text.replace(/,/g, "");
    }

    if (hasComma) {
      const parts = text.split(",");
      if (parts.length > 2) return text.replace(/,/g, "");
      return text.replace(",", ".");
    }

    if (hasDot) {
      const parts = text.split(".");
      if (parts.length > 2) return text.replace(/\./g, "");
      const decimals = parts[1] ?? "";
      // Treat "1.234" as thousands separator, but keep "60.0" / "12.50" as decimals.
      if (decimals.length === 3 && parts[0].length >= 1) {
        return text.replace(/\./g, "");
      }
    }

    return text;
  };

  const normalized = normalizeSeparators(cleaned);
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isEachUom(uom: string): boolean {
  const token = norm(uom);
  return token === "ea" || token === "each" || token === "pcs" || token === "pc" || token === "piece" || token === "pieces";
}

// Yield-Lookup rein nach ingredientId (nicht subRecipeId-gebunden) für den Breakdown-Rechner.
// Mehrfache Vorkommen: erster gefundener Wert gewinnt.
export function wrCollectIngYield(node: DetailedSubRecipe, target: Map<string, number>): void {
  for (const ing of node.ingredients) {
    if (!ing.id || !ing.yieldPct || !Number.isFinite(ing.yieldPct) || ing.yieldPct <= 0 || ing.yieldPct > 1) continue;
    if (!target.has(ing.id)) target.set(ing.id, ing.yieldPct);
  }
  for (const child of node.subRecipes) wrCollectIngYield(child, target);
}

export function wrIngredientYieldMap(structure: RecipeStructure | undefined): Map<string, number> {
  const map = new Map<string, number>();
  if (!structure) return map;
  for (const roots of Object.values(structure.markets)) {
    if (!roots) continue;
    for (const root of roots) wrCollectIngYield(root, map);
  }
  return map;
}

export function tokenize(value: string): string[] {
  return norm(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export function overlapScore(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

export function toCells(rowValues: unknown): string[] {
  if (!Array.isArray(rowValues)) return [];
  return rowValues.map((cell) => String(cell ?? "").trim());
}

export function detectHeaderRow(rows: string[][], expected: RegExp[]): number {
  let bestIndex = -1;
  let bestScore = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const nonEmpty = row.filter((cell) => cell.length > 0).length;
    if (nonEmpty < 3) continue;
    const text = row.join(" | ").toLowerCase();
    const hitScore = expected.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
    const score = hitScore * 10 + nonEmpty;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export function findHeaderIndex(headers: string[], candidates: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i].toLowerCase();
    if (candidates.some((regex) => regex.test(header))) return i;
  }
  return -1;
}

