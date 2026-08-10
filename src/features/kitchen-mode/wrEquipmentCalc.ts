// Kitchen Mode / Breakdown – Berechnungslogik: kg-Umrechnung, Breakdown-Plan, Pfad-/Kochmethoden-
// Klassifikation, Work-Order-Auflösung je Pfad, Datei-/HTML-Escaping.
import type { Recipe, WorkOrderEntry } from "../../core/types";
import type { WR_IngRow, WR_PathAgg, WRBreakdownPlan, WRMatchedWorkOrder } from "./wrEquipmentTypes";
import { norm, overlapScore, parseLocaleNumber } from "./wrEquipmentFormat";

export function wrToKg(qty: number, uom: string): number | null {
  const u = uom.toLowerCase().trim();
  if (u === "g" || u === "grams" || u === "gram") return qty / 1000;
  if (u === "kg") return qty;
  if (u === "ml") return qty / 1000;
  if (u === "l" || u === "liter" || u === "litre") return qty;
  return null;
}

export function wrCatBadge(cat: string): string {
  const c = (cat || "").toUpperCase();
  if (c === "PRO") return "bg-amber-100 text-amber-800";
  if (c === "SPI") return "bg-red-100 text-red-800";
  if (c === "PHF") return "bg-sky-100 text-sky-800";
  if (c === "DRY") return "bg-lime-100 text-lime-800";
  return "bg-slate-100 text-slate-500";
}

export function wrTubCellCls(count: number): string {
  if (count <= 0) return "text-slate-300";
  if (count === 1) return "bg-emerald-50 text-emerald-700 font-semibold ring-1 ring-emerald-200 rounded-lg";
  if (count <= 3) return "bg-sky-50 text-sky-700 font-semibold ring-1 ring-sky-200 rounded-lg";
  if (count <= 6) return "bg-amber-50 text-amber-700 rounded-lg";
  return "bg-rose-50 text-rose-600 rounded-lg";
}

export function wrFmtKg(kg: number): string {
  return kg.toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " kg";
}

export function wrFmtQty(qty: number, uom: string): string {
  return Number(qty.toFixed(1)).toLocaleString("de-DE") + " " + uom;
}

export function wrCalcBreakdownPlan(path: WR_PathAgg): WRBreakdownPlan {
  const briningFactor = path.isBrining ? 2 : 1;
  const effectiveTubKg = path.totalKg * briningFactor;
  const capacityKg = path.capacityKgHint && path.capacityKgHint > 0 ? path.capacityKgHint : null;
  const count = capacityKg && effectiveTubKg > 0
    ? Math.max(1, Math.ceil(effectiveTubKg / capacityKg))
    : null;
  const woSizeKg = count && count > 0 ? path.totalKg / count : null;
  return { briningFactor, effectiveTubKg, capacityKg, count, woSizeKg };
}

export function wrFmtRowTotalSize(row: WR_IngRow): string {
  return row.totalKg != null ? wrFmtKg(row.totalKg) : wrFmtQty(row.totalQty, row.uom);
}

export function wrFmtRowWoSize(row: WR_IngRow, breakdownCount: number | null): string {
  if (!breakdownCount || breakdownCount <= 0) return "—";
  if (row.totalKg != null) return wrFmtKg(row.totalKg / breakdownCount);
  return wrFmtQty(row.totalQty / breakdownCount, row.uom);
}

export function wrResolvePathInstructions(recipe: Recipe, sub1: string, sub2: string, sub3: string): string | null {
  const names = [sub3, sub2, sub1].filter((value) => value && value !== "—" && value !== "Ohne Sub-Rezept");
  if (names.length === 0) return null;
  for (const needleRaw of names) {
    const needle = norm(needleRaw);
    for (const market of Object.values(recipe.markets)) {
      if (!market) continue;
      const match = market.subRecipes.find((sub) => norm(sub.name) === needle || norm(sub.id) === needle);
      if (match?.instructions) return match.instructions.trim();
    }
  }
  return null;
}

export function wrResolveWorkOrderForPath(
  rows: WorkOrderEntry[] | undefined,
  recipeCode: string,
  subRecipeName: string,
  portionsInput: number,
  preferredWorkOrder?: string,
): WRMatchedWorkOrder | null {
  if (!rows?.length) return null;
  const recipeKey = recipeCode.trim().toUpperCase();
  const subKey = norm(subRecipeName);
  if (!recipeKey || !subKey) return null;

  let best: { row: WorkOrderEntry; score: number; portionDelta: number } | null = null;
  for (const row of rows) {
    const rowRecipe = (row.recipeCode ?? "").trim().toUpperCase();
    if (!rowRecipe || rowRecipe !== recipeKey) continue;
    if (preferredWorkOrder && (row.workOrder ?? "").trim() !== preferredWorkOrder.trim()) continue;
    const rowSub = norm(row.subRecipe);
    if (!rowSub) continue;
    const score = overlapScore(subKey, rowSub);
    if (score < 0.45) continue;
    const rowTarget = row.targetPortions ?? row.plannedMeals ?? 0;
    const portionDelta = Math.abs(rowTarget - portionsInput);
    if (!best || score > best.score || (score === best.score && portionDelta < best.portionDelta)) {
      best = { row, score, portionDelta };
    }
  }

  if (!best) return null;
  const row = best.row;
  return {
    workOrder: row.workOrder,
    kitchenDay: row.kitchenDay,
    targetPortions: row.targetPortions ?? row.plannedMeals ?? null,
    woCookedPortions: row.woCookedPortions ?? null,
    cookedPortionsExcess: row.cookedPortionsExcess ?? null,
    cookMethods: row.cookMethods ?? "",
    kitchenStatus: row.kitchenStatus ?? "",
    stagingStatus: row.stagingStatus ?? "",
    unlockedEta: row.unlockedEta ?? "",
    workOrderComment: row.workOrderComment ?? "",
  };
}

/** Entfernt Market-Tags wie [BNL], [BENL], [DE], [DKSE], [NORD] aus Rezept-Namen. */
export function wrStripMarketTag(name: string): string {
  return name.replace(/\s*\[(?:BNL|BENL|DE|DKSE|NORD)\]\s*/gi, "").trim();
}

export function wrSafeFilePart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

export function wrTsvSafe(value: unknown): string {
  return String(value ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

export function wrHtmlSafe(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Brining-Erkennung ────────────────────────────────────────────────────────
export function wrSubRecipeCategory(recipe: Recipe, subName: string): string {
  if (!subName || subName === "—" || subName === "Ohne Sub-Rezept") return "";
  const needle = norm(subName);
  for (const market of Object.values(recipe.markets)) {
    if (!market) continue;
    for (const sub of market.subRecipes) {
      if (norm(sub.name) === needle) return sub.category || "";
    }
  }
  return "";
}

export function wrPathIsBrining(recipe: Recipe, sub1: string, sub2: string, sub3: string): boolean {
  return [sub1, sub2, sub3].some((n) => /brine/i.test(wrSubRecipeCategory(recipe, n)));
}

export function wrPathCookCategories(recipe: Recipe, sub1: string, sub2: string, sub3: string): string {
  return [sub1, sub2, sub3]
    .map((n) => wrSubRecipeCategory(recipe, n))
    .filter(Boolean)
    .join(" / ");
}

export function wrPathPrimaryCookingMethod(recipe: Recipe, sub1: string, sub2: string, sub3: string): string {
  const candidates = [sub3, sub2, sub1];
  for (const subName of candidates) {
    const category = wrSubRecipeCategory(recipe, subName);
    if (category) return category;
  }
  return "";
}

export function wrNormalizeCookingMethod(value: string): string {
  const token = String(value || "")
    .split(/[,+/|;→»·]+/)
    .map((part) => part.trim())
    .find(Boolean);
  return token ?? "";
}

export function wrEffectiveCookingMethod(path: WR_PathAgg, matchedWo?: WRMatchedWorkOrder | null): string {
  return path.cookingMethod || wrNormalizeCookingMethod(matchedWo?.cookMethods ?? "");
}

export function wrCookingMethodBadgeClass(method: string): string {
  const key = norm(method);
  if (!key) return "bg-slate-100 text-slate-500 ring-slate-200";
  if (/(brine|pickle|marin)/.test(key)) return "bg-cyan-100 text-cyan-800 ring-cyan-200";
  if (/(steam|dampf|boil|koch|sousvide|poach)/.test(key)) return "bg-sky-100 text-sky-800 ring-sky-200";
  if (/(bake|oven|roast|grill|bbq)/.test(key)) return "bg-amber-100 text-amber-800 ring-amber-200";
  if (/(fry|saute|pan|sear)/.test(key)) return "bg-rose-100 text-rose-800 ring-rose-200";
  if (/(mix|mixer|blend|stir)/.test(key)) return "bg-emerald-100 text-emerald-800 ring-emerald-200";
  if (/(chill|cool|blast)/.test(key)) return "bg-teal-100 text-teal-800 ring-teal-200";
  return "bg-indigo-100 text-indigo-800 ring-indigo-200";
}

export function wrParseNumberLoose(value: unknown): number | null {
  return parseLocaleNumber(value);
}

export function wrParseKgLoose(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const n = wrParseNumberLoose(text);
  if (n == null || n <= 0) return null;
  const token = text.toLowerCase();
  if (token.includes(" g") || token.includes("gram")) return n / 1000;
  return n;
}

export function wrParsePcs(value: unknown): number | null {
  const text = String(value ?? "").trim().toLowerCase();
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*pcs/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Extracts piece weight in kg from ingredient name, e.g. "Chicken Breast – 160g" → 0.16 */
export function wrExtractPieceWeightKgFromName(name: string): number | null {
  const m = (name || "").match(/\b(\d+(?:[.,]\d+)?)\s*(g|kg)\b/i);
  if (!m) return null;
  const val = parseFloat(m[1].replace(",", "."));
  const unit = m[2].toLowerCase();
  if (!isFinite(val) || val <= 0) return null;
  return unit === "kg" ? val : val / 1000;
}

