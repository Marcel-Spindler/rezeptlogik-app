// PET Plan – reine Logik: CSV-Parsing, Datum/Format-Helper, Rezept-Lookups,
// Linien-Zuweisung (Allergen-bewusst), Status-Farben, Foto-Persistenz.
import Papa from "papaparse";
import type { Recipe, Market } from "../../core/types";
import { ALLERGEN_DEFS, LS_IMAGES_KEY, PORTIONS_PER_HOUR } from "./petTypes";
import type { AllergenDef, PetRow, PlatingImage } from "./petTypes";

export function detectAllergensFromText(texts: string[]): AllergenDef[] {
  const combined = texts.join(" ").toLowerCase();
  return ALLERGEN_DEFS.filter(({ keywords }) => keywords.some((kw) => combined.includes(kw)));
}

// ── CSV Parser ─────────────────────────────────────────────────────────────

export function parseNum(s: string): number | null {
  if (!s || !s.trim()) return null;
  const n = parseFloat(s.replace(",", "."));
  return isFinite(n) ? n : null;
}

export function extractCode(name: string): string {
  return (name ?? "").trim().match(/^([A-Z]{2}\d{4}[A-Z0-9]+)/)?.[1] ?? "";
}

export function extractMarket(name: string): string {
  const m = (name ?? "").match(/\[(DE|BNL|DKSE|BENL|NORD)\]/i);
  return m ? `[${m[1].toUpperCase()}]` : "";
}

export function cleanRecipeName(name: string): string {
  return (name ?? "")
    .replace(/^[A-Z]{2}\d{4}[A-Z0-9]+\s*[-–]\s*/, "")
    .replace(/\s*\[(?:DE|BNL|DKSE|BENL|NORD)\]\s*$/i, "")
    .trim();
}

export function parsePetCsv(text: string): PetRow[] {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  return result.data
    .filter((row) => (row["Type"] ?? "").trim().toLowerCase().includes("recipe"))
    .map((row, idx) => {
      const rawName = (row["Recipe Name"] ?? "").trim();
      const shiftKey = (row["Production Shift"] ?? "").trim();
      return {
        key: `pet::${idx}::${shiftKey}`,
        shiftKey,
        shiftTotalTarget: parseNum(row["Total Target"] ?? "") ?? 0,
        shiftTotalMapped: parseNum(row["Total Mapped"] ?? ""),
        _woNumber: (row["Recipe WO #"] ?? "").trim(),
        recipeName: cleanRecipeName(rawName),
        recipeCode: extractCode(rawName),
        market: extractMarket(rawName),
        mapped: parseNum(row["Recipe WO Mapped"] ?? ""),
        target: parseNum(row["Recipe WO Target"] ?? "") ?? 0,
        platingStatus: (row["Recipe Plating Status"] ?? "").trim(),
        manualStatus: (row["Recipe Manual Plating Status"] ?? "").trim(),
        weekUnlocked: parseNum(row["Total Week Unlocked Volume"] ?? ""),
        weekMapped: parseNum(row["Total Week Mapped"] ?? ""),
        minNeeds: parseNum(row["Production Min Needs"] ?? ""),
        expiringDatetime: (row["Expiring Datetime"] ?? "").trim(),
        expiringSubRecipe: (row["Expiring SubRecipe Name"] ?? "").trim(),
        expiringPortions: (row["Expiring Portions"] ?? "").trim(),
        expiringLp: (row["Expiring License Plate #"] ?? "").trim(),
        comment: (row["Comment"] ?? "").trim(),
        rolloverAmount: parseNum(row["Rollover Amount"] ?? ""),
        bestByDate: (row["Actual Best By Date"] ?? "").trim(),
        bestBySubRecipe: (row["Best By SubRecipe Name"] ?? "").trim(),
      } satisfies PetRow;
    });
}

// ── Date helpers ───────────────────────────────────────────────────────────

export function parseShift(shiftKey: string): { date: string; shift: string } {
  const m = shiftKey.match(/^(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d+)/);
  if (m) return { date: m[1], shift: m[2] };
  return { date: shiftKey, shift: "" };
}

export function shiftSortKey(shiftKey: string): number {
  const { date, shift } = parseShift(shiftKey);
  return Date.parse(date) * 10 + parseInt(shift || "0");
}

export function fmtShiftHeader(shiftKey: string): string {
  const { date, shift } = parseShift(shiftKey);
  const d = new Date(date);
  if (isNaN(d.getTime())) return shiftKey;
  const day = d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit" });
  return shift ? `${day} · Shift ${shift}` : day;
}

export function fmtShiftShort(shiftKey: string): string {
  const { date, shift } = parseShift(shiftKey);
  const d = new Date(date);
  if (isNaN(d.getTime())) return shiftKey;
  const day = d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
  return shift ? `${day} S${shift}` : day;
}

export function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("de-DE");
}

export function fmtClock(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(safe / 60).toString().padStart(2, "0");
  const m = (safe % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ── Instruction helpers ────────────────────────────────────────────────────

// Parst Freitext-Anweisungen in einzelne Arbeitsschritte
export function parseSteps(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.replace(/^\s*[-–•*]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
}

// ── Recipe helpers ─────────────────────────────────────────────────────────

export function marketKey(marketTag: string): Market | null {
  if (marketTag.includes("BNL") || marketTag.includes("BENL")) return "BENL";
  if (marketTag.includes("DKSE")) return "DKSE";
  if (marketTag.includes("DE")) return "DE";
  return null;
}

export function getMarketsToCheck(marketTag: string): Market[] {
  const mk = marketKey(marketTag);
  const all: Market[] = ["DE", "BENL", "DKSE"];
  return mk ? [mk, ...all.filter((m) => m !== mk)] : all;
}

export function getPlatingInstructions(
  recipe: Recipe | undefined,
  market: string,
): Array<{ name: string; id: string; text: string }> {
  if (!recipe) return [];
  for (const m of getMarketsToCheck(market)) {
    const md = recipe.markets[m];
    if (!md) continue;
    const result = md.subRecipes
      .filter((s) => s.instructions)
      .map((s) => ({ name: s.name, id: s.id, text: s.instructions ?? "" }));
    if (result.length > 0) return result;
  }
  return [];
}

export function getStructuredAllergens(recipe: Recipe | undefined, market: string): string {
  if (!recipe) return "";
  for (const m of getMarketsToCheck(market)) {
    const md = recipe.markets[m];
    if (md?.allergens) return md.allergens;
  }
  return "";
}

export function getSubmealCount(recipe: Recipe | undefined, market: string): number {
  if (!recipe) return 1;
  for (const m of getMarketsToCheck(market)) {
    const md = recipe.markets[m];
    if (md?.subRecipes?.length) return md.subRecipes.length;
  }
  return 1;
}

export function getMealAllergens(row: PetRow, recipe: Recipe | undefined): AllergenDef[] {
  const structured = getStructuredAllergens(recipe, row.market);
  if (structured) return detectAllergensFromText([structured]);
  return detectAllergensFromText([row.recipeName, row.comment, row.bestBySubRecipe, row.expiringSubRecipe]);
}

// ── Line Planning ──────────────────────────────────────────────────────────

export function getAllergenSignature(row: PetRow, recipes: Record<string, Recipe>): string {
  const recipe = recipes[row.recipeCode];
  const structured = getStructuredAllergens(recipe, row.market);
  if (structured) return structured;
  return detectAllergensFromText([row.recipeName]).map((a) => a.label).sort().join("|") || "none";
}

export function planLines(
  shiftRows: PetRow[],
  recipes: Record<string, Recipe>,
  capacities: number[] = [PORTIONS_PER_HOUR, PORTIONS_PER_HOUR, PORTIONS_PER_HOUR],
): { lines: PetRow[][]; lineTargets: number[] } {
  if (shiftRows.length === 0) return { lines: [[], []], lineTargets: [0, 0] };

  const shiftTarget = shiftRows.reduce((s, r) => s + r.target, 0);
  const avgCap = capacities.reduce((s, c) => s + c, 0) / capacities.length;
  const linesNeeded = shiftTarget > 0 ? Math.ceil(shiftTarget / avgCap) : 1;
  const lineCount = Math.min(capacities.length, Math.max(2, linesNeeded));

  // Sortiere: gleiche Allergen-Signaturen zusammen, dann nach Target absteigend
  const sorted = [...shiftRows].sort((a, b) => {
    const sigA = getAllergenSignature(a, recipes);
    const sigB = getAllergenSignature(b, recipes);
    if (sigA !== sigB) return sigA.localeCompare(sigB);
    return b.target - a.target;
  });

  const lines: PetRow[][] = Array.from({ length: lineCount }, () => []);
  const lineTargets = Array.from({ length: lineCount }, () => 0);

  for (const row of sorted) {
    let bestLine = 0;
    let bestScore = Infinity;
    for (let i = 0; i < lineCount; i++) {
      const last = lines[i].at(-1);
      const lastSig = last ? getAllergenSignature(last, recipes) : "";
      const curSig = getAllergenSignature(row, recipes);
      const switchPenalty = last && lastSig !== curSig ? 3 : 0;
      const cap = capacities[i] ?? PORTIONS_PER_HOUR;
      const balance = lineTargets[i] / cap;
      const overflow = Math.max(0, lineTargets[i] + row.target - cap) / cap * 2;
      const score = switchPenalty + balance + overflow + lineTargets[i] * 0.0001;
      if (score < bestScore) { bestScore = score; bestLine = i; }
    }
    lines[bestLine].push(row);
    lineTargets[bestLine] += row.target;
  }

  return { lines, lineTargets };
}

export function calcLineStaff(lineRows: PetRow[], recipes: Record<string, Recipe>): number {
  const submeals = lineRows.reduce((s, r) => s + getSubmealCount(recipes[r.recipeCode], r.market), 0);
  return submeals + 1;
}

// ── Status helpers ─────────────────────────────────────────────────────────

export function statusColors(status: string): { bg: string; text: string } {
  const s = status.toLowerCase();
  if (s.includes("complete") || s.includes("done") || s.includes("finished"))
    return { bg: "bg-emerald-100", text: "text-emerald-800" };
  if (s.includes("in progress") || s.includes("running"))
    return { bg: "bg-blue-100", text: "text-blue-800" };
  if (s.includes("not started") || !s)
    return { bg: "bg-slate-100", text: "text-slate-500" };
  if (s.includes("hold") || s.includes("blocked"))
    return { bg: "bg-red-100", text: "text-red-700" };
  return { bg: "bg-amber-100", text: "text-amber-800" };
}

export function statusColorsHtml(status: string): { bg: string; text: string } {
  const s = status.toLowerCase();
  if (s.includes("complete") || s.includes("done"))   return { bg: "#d1fae5", text: "#065f46" };
  if (s.includes("in progress") || s.includes("running")) return { bg: "#dbeafe", text: "#1e40af" };
  if (s.includes("not started") || !s)                return { bg: "#f1f5f9", text: "#475569" };
  return { bg: "#fef3c7", text: "#92400e" };
}

// ── Image helpers ──────────────────────────────────────────────────────────

export function loadImages(): Record<string, PlatingImage[]> {
  try {
    const raw = localStorage.getItem(LS_IMAGES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function saveImages(imgs: Record<string, PlatingImage[]>) {
  try { localStorage.setItem(LS_IMAGES_KEY, JSON.stringify(imgs)); } catch { /* quota */ }
}
