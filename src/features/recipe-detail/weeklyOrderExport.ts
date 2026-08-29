/**
 * weeklyOrderExport.ts
 * Excel-Export der Wochenbestellung: aggregierte Brutto-Zutaten über alle
 * Verden-Rezepte einer Woche, in voller Summe (kein Top-100-Limit).
 */
import type { Market } from "../../core/types";
import { MARKET_LABEL } from "../../lib/helpers";

export interface WeeklyOrderRow {
  ingredientId: string;
  name: string;
  category: string;
  uom: string;
  perMarket: Record<Market, number>;
  totalQty: number;
  recipeCount: number;
  recipes: string[];
}

export interface WeeklyOrderMeta {
  week: string;
  marketFilter: Market | "ALL";
  upliftPercent: number;
  recipeCount: number;
  generatedAt: string;
}

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } } as const;

function normalizeQty(qty: number, uom: string): { value: number; unit: string } {
  const u = uom.trim().toLowerCase();
  if (u === "grams" || u === "gram" || u === "g") return { value: qty / 1000, unit: "kg" };
  if (u === "ml" || u === "milliliter") return { value: qty / 1000, unit: "L" };
  return { value: qty, unit: uom || "Stk" };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function exportWeeklyOrderXlsx(rows: WeeklyOrderRow[], meta: WeeklyOrderMeta): Promise<void> {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();

  const marketLabel = meta.marketFilter === "ALL" ? "Alle Märkte (Summe)" : MARKET_LABEL[meta.marketFilter];
  const stamp = meta.generatedAt ? new Date(meta.generatedAt).toLocaleString("de-DE") : "—";
  const upliftLabel = `${meta.upliftPercent > 0 ? "+" : ""}${meta.upliftPercent} %`;

  // ── Sheet 1: alle Zutaten (volle Summe) ──────────────────────────────────
  const ws = wb.addWorksheet("Wochenbestellung");
  ws.addRow([`Wochenbestellung ${meta.week}`]).font = { bold: true, size: 14 };
  ws.addRow([`Markt: ${marketLabel}  ·  Uplift: ${upliftLabel}  ·  Rezepte: ${meta.recipeCount}  ·  Datenstand: ${stamp}`]);
  ws.addRow([]);

  const HEADER_ROW = 4;
  ws.addRow([
    "Zutat", "SKU", "Kategorie", "Einheit",
    "Gesamt (Einheit)", "Gesamt (kg/L)",
    "BENL", "DK/SE", "DE",
    "In # Rezepten", "Rezept-Codes",
  ]);

  for (const r of rows) {
    const norm = normalizeQty(r.totalQty, r.uom);
    ws.addRow([
      r.name,
      r.ingredientId || "",
      r.category || "",
      r.uom,
      round(r.totalQty, 1),
      round(norm.value, 3),
      round(r.perMarket.BENL, 1),
      round(r.perMarket.DKSE, 1),
      round(r.perMarket.DE, 1),
      r.recipeCount,
      r.recipes.join(", "),
    ]);
  }

  ws.getRow(HEADER_ROW).font = { bold: true };
  ws.getRow(HEADER_ROW).fill = { ...HEADER_FILL };
  ws.views = [{ state: "frozen", ySplit: HEADER_ROW }];
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW + rows.length, column: 11 } };
  }
  [38, 12, 12, 9, 15, 13, 12, 12, 12, 13, 44].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // ── Sheet 2: Summe je Kategorie ─────────────────────────────────────────
  const catMap = new Map<string, { category: string; unit: string; qty: number; ingredients: number }>();
  for (const r of rows) {
    const norm = normalizeQty(r.totalQty, r.uom);
    const category = r.category || "ohne Kategorie";
    const key = `${category}::${norm.unit}`;
    const e = catMap.get(key) ?? { category, unit: norm.unit, qty: 0, ingredients: 0 };
    e.qty += norm.value;
    e.ingredients += 1;
    catMap.set(key, e);
  }
  const cs = wb.addWorksheet("Nach Kategorie");
  cs.addRow(["Kategorie", "Einheit", "Gesamt", "# Zutaten"]);
  cs.getRow(1).font = { bold: true };
  cs.getRow(1).fill = { ...HEADER_FILL };
  [...catMap.values()]
    .sort((a, b) => a.category.localeCompare(b.category) || a.unit.localeCompare(b.unit))
    .forEach(v => cs.addRow([v.category, v.unit, round(v.qty, 3), v.ingredients]));
  [28, 10, 14, 10].forEach((w, i) => { cs.getColumn(i + 1).width = w; });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  triggerDownload(blob, `Wochenbestellung-${meta.week}-${meta.marketFilter}.xlsx`);
}
