// Druckfunktion für einzelne Staging-WO-Karten.
// Öffnet neues Fenster, schreibt A4-HTML, ruft window.print() auf.
import type { StockLocation, IngredientStockMap } from "./useIngredientStock";
import { findStockForIngredient, findStagingStockForIngredient } from "./useIngredientStock";

export interface PrintOptions {
  lagerplatz: boolean;   // Regalplätze (A-01-04-1)
  mhd: boolean;          // MHD-Datum
  stagingLocs: boolean;  // Staging-Bereiche (DEBOXWIP etc.)
  zutaten: boolean;
  allergene: boolean;
  equipment: boolean;
  kochflow: boolean;
}

export const DEFAULT_PRINT_OPTIONS: PrintOptions = {
  lagerplatz: true,
  mhd: true,
  stagingLocs: true,
  zutaten: true,
  allergene: true,
  equipment: true,
  kochflow: false,
};

export interface PrintIngredient {
  name: string;
  isAllergen: boolean;
  qty: string;
}

export interface PrintWoData {
  woNumber: string;
  recipeName: string;
  subRecipeName?: string;
  stagingDate: string | null;
  platingDate: string | null;
  equipment: string;
  cookFlow: string[];
  allergens: string[];
  ingredients: PrintIngredient[];
  kg: string;
  batches: number;
}

function fmtMhd(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "–" : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function fmtDate(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(`${iso}T00:00:00Z`);
  return isNaN(d.getTime()) ? "–" : d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function rackRows(locs: StockLocation[], showMhd: boolean): string {
  if (locs.length === 0) return "";
  return locs.slice(0, 5).map(loc => {
    const mhd = showMhd && loc.expirationDate ? `<span style='color:#64748b;font-size:9px'> MHD ${fmtMhd(loc.expirationDate)}</span>` : "";
    const qty = loc.actualQty != null ? `<span style='color:#64748b;font-size:9px'> (${Math.round(loc.actualQty * 10) / 10})</span>` : "";
    return `<span style='display:inline-block;background:#e0f2fe;color:#0369a1;border-radius:4px;padding:1px 6px;margin:1px 1px;font-size:10px;font-weight:700'>${loc.locationId}</span>${qty}${mhd}`;
  }).join(" ");
}

function stagingRows(locs: StockLocation[]): string {
  if (locs.length === 0) return "";
  const grouped = new Map<string, number>();
  for (const l of locs) grouped.set(l.locationId, (grouped.get(l.locationId) ?? 0) + (l.actualQty ?? 0));
  return `<div style='margin-top:2px;font-size:9px;color:#92400e'>🏭 auch in Staging: ${
    [...grouped.entries()].slice(0, 4).map(([loc, qty]) =>
      `<span style='background:#fef3c7;color:#92400e;border-radius:3px;padding:1px 5px;font-weight:700;margin:0 1px'>${loc}</span> ${Math.round(qty * 10) / 10}`
    ).join(" · ")
  }</div>`;
}

export function buildPrintHtml(
  wo: PrintWoData,
  options: PrintOptions,
  stockMap: IngredientStockMap,
  stagingMap?: IngredientStockMap,
): string {
  const hasLager = options.lagerplatz || options.mhd;

  const zutatenHtml = (options.zutaten || hasLager) ? `
    <section class="section">
      <h3>Zutaten</h3>
      <table class="ing-table">
        <thead>
          <tr>
            <th style="width:38%">Zutat</th>
            <th style="width:12%">Menge</th>
            ${hasLager ? `<th>Lagerplatz${options.mhd ? " / MHD" : ""}${options.stagingLocs ? " / Staging" : ""}</th>` : ""}
          </tr>
        </thead>
        <tbody>
          ${wo.ingredients.map(ing => {
            const locs = hasLager ? findStockForIngredient(stockMap, ing.name) : [];
            const sLocs = (hasLager && options.stagingLocs && stagingMap) ? findStagingStockForIngredient(stagingMap, ing.name) : [];
            const locHtml = rackRows(locs, options.mhd) + (sLocs.length > 0 ? stagingRows(sLocs) : "");
            return `<tr${ing.isAllergen ? ' class="allergen-row"' : ""}>
              <td>${ing.isAllergen ? "⚠ " : ""}${ing.name}</td>
              <td class="num">${ing.qty}</td>
              ${hasLager ? `<td>${locHtml || '<span style="color:#94a3b8;font-size:10px">–</span>'}</td>` : ""}
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </section>` : "";

  const allergenHtml = options.allergene && wo.allergens.length > 0 ? `
    <section class="section">
      <h3>⚠ Enthält Allergene</h3>
      <div class="pills">${wo.allergens.map(a => `<span class="pill-red">${a.split(" / ")[0]}</span>`).join("")}</div>
    </section>` : "";

  const equipHtml = options.equipment && wo.equipment ? `
    <section class="section">
      <h3>Equipment</h3>
      <p style="font-size:12px;color:#334155">${wo.equipment}</p>
    </section>` : "";

  const kochHtml = options.kochflow && wo.cookFlow.length > 0 ? `
    <section class="section">
      <h3>Koch-Flow</h3>
      <div class="pills">${wo.cookFlow.map((s, i) => `${i > 0 ? "<span style='color:#94a3b8'>›</span> " : ""}<span class="pill-${/staging/i.test(s) ? "indigo" : "slate"}">${s}</span>`).join(" ")}</div>
    </section>` : "";

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>WO ${wo.woNumber} — Staging</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Arial, sans-serif; font-size: 12px; color: #1e293b; margin: 0; }
  .header { border-bottom: 3px solid #0f2240; padding-bottom: 10px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: flex-start; }
  .wo-num { font-size: 22px; font-weight: 900; color: #0f2240; }
  .recipe { font-size: 14px; font-weight: 700; color: #1e293b; margin-top: 2px; }
  .sub-recipe { font-size: 11px; color: #64748b; }
  .meta { text-align: right; }
  .meta-val { font-size: 13px; font-weight: 700; }
  .meta-label { font-size: 9px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
  .dates { display: flex; gap: 20px; margin: 8px 0; }
  .date-block { border: 1px solid #e2e8f0; border-radius: 6px; padding: 4px 10px; }
  .date-label { font-size: 9px; color: #94a3b8; text-transform: uppercase; }
  .date-val { font-size: 13px; font-weight: 800; color: #0f2240; }
  .section { margin-bottom: 12px; }
  h3 { font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin: 0 0 5px; border-bottom: 1px solid #f1f5f9; padding-bottom: 3px; }
  .ing-table { width: 100%; border-collapse: collapse; }
  .ing-table th { font-size: 9px; font-weight: 700; text-align: left; color: #64748b; padding: 3px 6px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
  .ing-table td { padding: 4px 6px; border-bottom: 1px solid #f1f5f9; font-size: 11px; vertical-align: top; }
  .ing-table .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; vertical-align: middle; }
  .allergen-row td { background: #fff7ed; color: #c2410c; font-weight: 700; }
  .pills { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .pill-red { background: #fee2e2; color: #b91c1c; border-radius: 4px; padding: 2px 8px; font-size: 10px; font-weight: 700; }
  .pill-slate { background: #f1f5f9; color: #475569; border-radius: 4px; padding: 2px 8px; font-size: 10px; font-weight: 700; }
  .pill-indigo { background: #eef2ff; color: #4338ca; border-radius: 4px; padding: 2px 8px; font-size: 10px; font-weight: 700; }
  .footer { margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 6px; font-size: 9px; color: #94a3b8; display: flex; justify-content: space-between; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="wo-num">WO ${wo.woNumber}</div>
    <div class="recipe">${wo.recipeName}</div>
    ${wo.subRecipeName && wo.subRecipeName !== wo.recipeName ? `<div class="sub-recipe">${wo.subRecipeName}</div>` : ""}
    <div class="dates">
      <div class="date-block">
        <div class="date-label">📦 Staging</div>
        <div class="date-val">${fmtDate(wo.stagingDate)}</div>
      </div>
      <div class="date-block">
        <div class="date-label">🍽 Plating</div>
        <div class="date-val">${fmtDate(wo.platingDate)}</div>
      </div>
    </div>
  </div>
  <div class="meta">
    <div class="meta-val">${wo.kg}</div>
    <div class="meta-label">Gesamt</div>
    ${wo.batches > 0 ? `<div class="meta-val" style="margin-top:4px">${wo.batches}</div><div class="meta-label">Batches</div>` : ""}
  </div>
</div>

${allergenHtml}
${zutatenHtml}
${equipHtml}
${kochHtml}

<div class="footer">
  <span>Staging-Dashboard · Rezeptlogik</span>
  <span>Gedruckt: ${new Date().toLocaleString("de-DE")}</span>
</div>
<script>window.onload = function() { window.print(); };<\/script>
</body>
</html>`;
}

export function printStagingWo(
  wo: PrintWoData,
  options: PrintOptions,
  stockMap: IngredientStockMap,
  stagingMap?: IngredientStockMap,
): void {
  const html = buildPrintHtml(wo, options, stockMap, stagingMap);
  const win = window.open("", "_blank");
  if (!win) {
    alert("Pop-up blockiert – bitte für diese Seite erlauben und nochmal klicken.");
    return;
  }
  win.document.write(html);
  win.document.close();
}
