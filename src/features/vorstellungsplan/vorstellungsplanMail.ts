// Vorstellungsplan – Email-Vorschau als Copy-Paste-HTML (kein Gmail-Draft).
// Anders als rundmailKetMail.ts (dessen HTML für window.open()+print()
// gedacht ist und deshalb ein <style>-Block nutzt) wird dieses HTML per
// document.execCommand("copy") direkt in die Zwischenablage kopiert und in
// Outlook/Gmail eingefügt — Email-Clients ignorieren <style>-Blöcke beim
// Einfügen fast immer, deshalb ausschließlich Inline-Styles je Element.
import { escapeHtml, fmtInt as fmtIntRundmail } from "../rundmail/rundmailFormat";
import type { ProductionPlanData, ProductionPlanDay, ProductionPlanDayCell, ProductionPlanRow } from "../gsheet-monitor/gsheetTypes";
import { PRODUCTION_PLAN_DAYS } from "../gsheet-monitor/gsheetTypes";
import type { BackfillsKpi, RedzoneKpi, WmsKpi } from "./vorstellungsplanKpis";

const DAY_SHORT: Record<ProductionPlanDay, string> = {
  Sunday: "So", Monday: "Mo", Tuesday: "Di", Wednesday: "Mi", Thursday: "Do", Friday: "Fr", Saturday: "Sa",
};

function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return fmtIntRundmail(n);
}

function cellText(cell: ProductionPlanDayCell | undefined): string {
  if (!cell || cell.kind === "empty") return "";
  if (cell.kind === "station") return escapeHtml(cell.label);
  return fmtInt(cell.portions);
}

function dayCellHtml(row: ProductionPlanRow, day: ProductionPlanDay): string {
  const cell = row.byDay[day];
  const td = (inner: string, extra: string) =>
    `<td style="padding:4px 6px;border:1px solid #e2e8f0;text-align:center;font-size:11px;${extra}">${inner}</td>`;
  // Zweischicht: früh/spät-Aufteilung als kleine Zweitzeile, wenn die Spätschicht befüllt ist.
  const shift = row.byShift?.[day];
  const splitNote = shift && shift.late.kind !== "empty"
    ? `<div style="font-size:8px;color:#94a3b8;font-weight:400;">${cellText(shift.early) || "–"} / ${cellText(shift.late)}</div>`
    : "";
  if (cell.kind === "empty") return td("·", "color:#cbd5e1;");
  if (cell.kind === "station") return td(escapeHtml(cell.label) + splitNote, "font-weight:700;color:#0369a1;background:#f0f9ff;");
  return td(fmtInt(cell.portions) + splitNote, "font-weight:700;color:#1e293b;text-align:right;");
}

function kpiCardHtml(label: string, value: string, color: string): string {
  return `<td style="padding:0 4px;">
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;text-align:center;min-width:96px;">
      <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">${escapeHtml(label)}</div>
      <div style="font-size:17px;font-weight:900;color:${color};line-height:1.2;margin-top:2px;">${value}</div>
    </div>
  </td>`;
}

export interface VorstellungsplanMailKpis {
  backfills: BackfillsKpi | null;
  redzone: RedzoneKpi | null;
  wms: WmsKpi;
}

function kitchenTableHtml(data: ProductionPlanData): string {
  const kitchen = data.kitchen;
  if (!kitchen || kitchen.rows.length === 0) return "";

  const dayHeaders = PRODUCTION_PLAN_DAYS.map(d =>
    `<th style="padding:4px 6px;border:1px solid #e2e8f0;background:#7c2d12;color:#fff;font-size:10px;">${DAY_SHORT[d]}</th>`
  ).join("");

  const rows = kitchen.rows.map(row => {
    const dayCells = PRODUCTION_PLAN_DAYS.map(d => {
      const cell = row.byDay[d];
      const shift = row.byShift?.[d];
      const split = shift && shift.late.kind !== "empty"
        ? `<div style="font-size:8px;color:#94a3b8;font-weight:400;">${cellText(shift.early) || "–"} / ${cellText(shift.late)}</div>`
        : "";
      const inner = cell.kind === "empty" ? "·" : cell.kind === "station" ? escapeHtml(cell.label) : fmtInt(cell.portions);
      const extra = cell.kind === "empty" ? "color:#cbd5e1;" : cell.kind === "station" ? "font-weight:700;color:#0369a1;background:#f0f9ff;" : "font-weight:700;color:#1e293b;text-align:right;";
      return `<td style="padding:4px 6px;border:1px solid #e2e8f0;text-align:center;font-size:11px;${extra}">${inner}${split}</td>`;
    }).join("");
    return `<tr>
      <td style="padding:4px 6px;border:1px solid #e2e8f0;font-family:monospace;font-size:10px;color:#475569;">${escapeHtml(row.code)}</td>
      <td style="padding:4px 6px;border:1px solid #e2e8f0;font-size:11px;font-weight:600;color:#0f172a;">${escapeHtml(row.recipeName)}</td>
      ${dayCells}
    </tr>`;
  }).join("");

  return `<div style="font-size:11px;font-weight:900;color:#7c2d12;margin:14px 0 6px;">🍳 Küchenplan — geplante Kochmengen je Tag (bei 2 Schichten: früh / spät)</div>
  <table style="border-collapse:collapse;width:100%;margin-bottom:14px;">
    <thead><tr>
      <th style="padding:4px 6px;border:1px solid #e2e8f0;background:#7c2d12;color:#fff;font-size:10px;text-align:left;">Code</th>
      <th style="padding:4px 6px;border:1px solid #e2e8f0;background:#7c2d12;color:#fff;font-size:10px;text-align:left;">Meal</th>
      ${dayHeaders}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function buildVorstellungsplanMailHtml(data: ProductionPlanData, weekLabel: string, kpis: VorstellungsplanMailKpis): string {
  const generatedAt = new Date().toLocaleString("de-DE");
  const weekTitle = data.week || weekLabel;
  const shiftNote = data.shiftModel === "dual" ? " &middot; 2-Schicht-Modell (früh/spät)" : "";

  // "unique meals" je Tag über die Woche zu summieren würde Meals doppelt
  // zählen, die an mehreren Tagen geplatet werden — die Zeilenzahl der
  // Plan-Tabelle selbst ist die korrekte Wochen-Gesamtzahl. "lines" ist ein
  // Tages-Spitzenwert (wie viele Linien an diesem Tag laufen), kein additiver
  // Wert — hier zählt das Maximum über die Woche. Nur Zeit-Kennzahlen wie
  // "cupping time" sind über die Tage sinnvoll addierbar (Gesamtstunden).
  const linesRow = data.kpiRows.find(k => k.label === "lines");
  const peakLines = linesRow ? Math.max(0, ...PRODUCTION_PLAN_DAYS.map(d => linesRow.byDay[d] ?? 0)) : null;
  const cuppingRow = data.kpiRows.find(k => k.label === "cupping time");
  const cuppingHoursTotal = cuppingRow ? PRODUCTION_PLAN_DAYS.reduce((s, d) => s + (cuppingRow.byDay[d] ?? 0), 0) : null;

  const sheetKpiCards = [
    kpiCardHtml("Unique Meals", fmtInt(data.rows.length), "#0f172a"),
    peakLines != null ? kpiCardHtml("Linien (Spitze)", fmtInt(peakLines), "#0f172a") : "",
    cuppingHoursTotal != null ? kpiCardHtml("Cupping Time (Σ)", fmtInt(cuppingHoursTotal), "#0f172a") : "",
  ].join("");

  const kpiCards = [
    kpiCardHtml("WMS · WO-Portionen", kpis.wms.status === "loading" ? "…" : fmtInt(kpis.wms.totalWoPortions), "#4338ca"),
    kpis.backfills ? kpiCardHtml("Backfills kritisch", fmtInt(kpis.backfills.criticalCount), kpis.backfills.criticalCount > 0 ? "#b91c1c" : "#166534") : "",
    kpis.redzone ? kpiCardHtml("Redzone · aktive Linien", fmtInt(kpis.redzone.activeLineCount), "#4338ca") : "",
    sheetKpiCards,
  ].join("");

  const rows = data.rows.map(row => {
    const dayCells = PRODUCTION_PLAN_DAYS.map(d => dayCellHtml(row, d)).join("");
    return `<tr>
      <td style="padding:4px 6px;border:1px solid #e2e8f0;font-family:monospace;font-size:10px;color:#475569;">${escapeHtml(row.code)}</td>
      <td style="padding:4px 6px;border:1px solid #e2e8f0;font-size:11px;font-weight:600;color:#0f172a;">${escapeHtml(row.recipeName)}</td>
      <td style="padding:4px 6px;border:1px solid #e2e8f0;font-size:11px;text-align:right;font-weight:700;color:#0f172a;">${fmtInt(row.totalWithBuffer)}</td>
      ${dayCells}
      <td style="padding:4px 6px;border:1px solid #e2e8f0;font-size:9px;color:#64748b;">${escapeHtml(row.allergens || "–")}</td>
    </tr>`;
  }).join("");

  const dayHeaders = PRODUCTION_PLAN_DAYS.map(d =>
    `<th style="padding:4px 6px;border:1px solid #e2e8f0;background:#1e293b;color:#fff;font-size:10px;">${DAY_SHORT[d]}</th>`
  ).join("");

  return `<div style="font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;max-width:960px;">
  <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#0369a1 100%);border-radius:10px;padding:16px 20px;margin-bottom:12px;">
    <div style="font-size:9px;letter-spacing:.2em;color:#7dd3fc;text-transform:uppercase;">Factor OPS &middot; Verden &middot; Vorstellungsplan</div>
    <div style="font-size:20px;font-weight:900;color:#fff;margin-top:4px;">Plating-Plan ${escapeHtml(weekTitle)}${shiftNote}</div>
    <div style="font-size:9px;color:#94a3b8;margin-top:8px;">Erstellt: ${escapeHtml(generatedAt)} &middot; Quelle: F_VE Production Plan (GSheet)</div>
  </div>
  <table style="border-collapse:collapse;margin-bottom:14px;"><tr>${kpiCards}</tr></table>
  <table style="border-collapse:collapse;width:100%;">
    <thead>
      <tr>
        <th style="padding:4px 6px;border:1px solid #e2e8f0;background:#1e293b;color:#fff;font-size:10px;text-align:left;">Code</th>
        <th style="padding:4px 6px;border:1px solid #e2e8f0;background:#1e293b;color:#fff;font-size:10px;text-align:left;">Meal</th>
        <th style="padding:4px 6px;border:1px solid #e2e8f0;background:#1e293b;color:#fff;font-size:10px;">Total+Buffer</th>
        ${dayHeaders}
        <th style="padding:4px 6px;border:1px solid #e2e8f0;background:#1e293b;color:#fff;font-size:10px;text-align:left;">Allergene</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  ${kitchenTableHtml(data)}
  <div style="margin-top:10px;font-size:9px;color:#94a3b8;">Factor OPS Planner &middot; Vorstellungsplan &middot; ${escapeHtml(generatedAt)}</div>
</div>`;
}
