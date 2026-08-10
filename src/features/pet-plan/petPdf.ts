// PET Plan – HTML/Print-PDF-Generator für den Linienplan eines Shifts.
import type { Recipe } from "../../core/types";
import { LINE_START_HOUR, PORTIONS_PER_HOUR } from "./petTypes";
import type { PetRow, PlatingImage } from "./petTypes";
import {
  calcLineStaff, fmtClock, fmtNum, fmtShiftHeader, getMealAllergens, getPlatingInstructions,
  getStructuredAllergens, getSubmealCount, parseSteps, planLines, statusColorsHtml,
} from "./petLogic";

export function buildLinePlanPdf(
  shiftKey: string,
  rows: PetRow[],
  title: string,
  allImages: Record<string, PlatingImage[]>,
  recipes: Record<string, Recipe>,
  capacities: number[] = [PORTIONS_PER_HOUR, PORTIONS_PER_HOUR, PORTIONS_PER_HOUR],
): string {
  const { lines, lineTargets } = planLines(rows, recipes, capacities);
  const lineCount = lines.length;
  const shiftTarget = rows.reduce((s, r) => s + r.target, 0);
  const shiftMapped = rows.reduce((s, r) => s + (r.mapped ?? 0), 0);
  const pct = shiftTarget > 0 && shiftMapped > 0 ? Math.round(shiftMapped / shiftTarget * 100) : 0;
  const parallelHours = lineCount > 0
    ? Math.max(...lineTargets.map((t, i) => t / (capacities[i] ?? PORTIONS_PER_HOUR)))
    : 0;
  const staffByLine = lines.map((l) => calcLineStaff(l, recipes));
  const staffTotal = staffByLine.reduce((s, n) => s + n, 0);
  const allAllergens = new Set(rows.flatMap((r) => getMealAllergens(r, recipes[r.recipeCode]).map((a) => a.label)));

  const lc = ["#0ea5e9", "#10b981", "#f59e0b"];
  const lb = ["#eff6ff", "#f0fdf4", "#fffbeb"];

  const lineHtmls = lines.map((lineRows, li) => {
    const lineColor = lc[li] ?? "#94a3b8";
    const lineBg = lb[li] ?? "#f8fafc";
    const lineTarget = lineTargets[li];
    const lineCap = capacities[li] ?? PORTIONS_PER_HOUR;
    const lineHours = lineTarget / lineCap;
    const lineStaff = staffByLine[li];
    const utilPct = Math.min(100, Math.round(lineTarget / lineCap * 100));
    let cursorMin = LINE_START_HOUR * 60;

    const mealCards = lineRows.map((row, mi) => {
      const recipe = recipes[row.recipeCode];
      const allergens = getMealAllergens(row, recipe);
      const instr = getPlatingInstructions(recipe, row.market);
      const imgs = allImages[row.recipeCode] ?? [];
      const structured = getStructuredAllergens(recipe, row.market);
      const submeals = getSubmealCount(recipe, row.market);

      const durationMin = Math.max(10, Math.round((row.target / lineCap) * 60));
      const startMin = cursorMin;
      const endMin = cursorMin + durationMin;
      cursorMin = endMin;

      const allergenHtml = allergens.length > 0
        ? allergens.map((a) =>
            `<span style="display:inline-block;background:${a.bg};color:${a.color};border:1px solid ${a.border};border-radius:3px;padding:1px 5px;font-size:9px;font-weight:700;margin:1px 2px;">${a.label}</span>`
          ).join("")
        : `<span style="font-size:9px;color:#94a3b8;">keine bekannten Allergene</span>`;

      // Nummerierte Schritt-für-Schritt Anweisungen je Sub-Meal
      const instrHtml = instr.length > 0
        ? instr.map((b) => {
            const steps = parseSteps(b.text);
            const stepsHtml = steps.length === 0
              ? `<div style="font-size:9px;color:#64748b;">${b.text.replace(/</g,"&lt;")}</div>`
              : steps.map((s, si) =>
                  `<div style="display:flex;gap:5px;margin-bottom:2px;align-items:flex-start;">
                     <span style="font-weight:800;color:#166534;min-width:16px;font-size:9px;flex-shrink:0;">${si + 1}.</span>
                     <span style="font-size:9px;color:#1a2e1a;">${s.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</span>
                   </div>`
                ).join("");
            return `<div style="margin-top:5px;padding:6px 8px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:0 4px 4px 0;">
                      <div style="font-size:9px;font-weight:800;color:#166534;margin-bottom:3px;border-bottom:1px solid #bbf7d0;padding-bottom:2px;">
                        Sub-Meal: ${b.name.replace(/</g,"&lt;")}
                      </div>
                      ${stepsHtml}
                    </div>`;
          }).join("")
        : (recipe
            ? `<div style="font-size:9px;color:#94a3b8;margin-top:4px;">Keine Anweisungen in App-Daten</div>`
            : `<div style="font-size:9px;color:#f97316;margin-top:4px;">⚠ ${row.recipeCode} nicht in App-Daten</div>`);

      const imgHtml = imgs.length > 0
        ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
             ${imgs.map((img) => `<div style="text-align:center"><img src="${img.dataUrl}" alt="Foto" style="max-width:130px;max-height:100px;object-fit:contain;border:1px solid #e2e8f0;border-radius:4px;"/><div style="font-size:8px;color:#64748b;">${img.name}</div></div>`).join("")}
           </div>`
        : "";

      const sc = statusColorsHtml(row.platingStatus);

      const next = lineRows[mi + 1];
      const nextAllergens = next ? getMealAllergens(next, recipes[next.recipeCode]) : [];
      const curSet = new Set(allergens.map((a) => a.label));
      const nxtSet = new Set(nextAllergens.map((a) => a.label));
      const removed = [...curSet].filter((l) => !nxtSet.has(l));
      const added = [...nxtSet].filter((l) => !curSet.has(l));
      const hasChange = next && (removed.length > 0 || added.length > 0);

      const cleaningHtml = hasChange
        ? `<div style="margin:3px 0 6px;padding:5px 8px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:5px;font-size:9px;color:#78350f;font-weight:700;">
             ⚠ LINIE REINIGEN – Allergen-Wechsel:${removed.length ? ` entfernt: ${removed.join(", ")}` : ""}${added.length ? ` · neu: ${added.join(", ")}` : ""}
           </div>`
        : "";

      return `
        <div style="border:1px solid #e2e8f0;border-left:3px solid ${lineColor};border-radius:0 6px 6px 0;background:#fff;padding:8px 10px;margin-bottom:4px;page-break-inside:avoid;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
            <div>
              <div style="font-size:12px;font-weight:800;color:#0f172a;">${row.recipeName}${row.market ? `&nbsp;<span style="font-size:9px;font-weight:400;color:#94a3b8;">${row.market}</span>` : ""}</div>
              ${row.recipeCode ? `<div style="font-family:monospace;font-size:9px;color:#64748b;">${row.recipeCode} · ${submeals} Sub-Meals · ${instr.length} Anweisungsblöcke</div>` : ""}
            </div>
            <div style="text-align:right;font-size:9px;color:#64748b;white-space:nowrap;margin-left:8px;">
              <div style="font-weight:700;color:#0369a1;">${fmtClock(startMin)} – ${fmtClock(endMin)}</div>
              <div>${(row.target / lineCap).toFixed(1)} h · ${fmtNum(lineCap)}/h</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:700;color:#0f172a;">${fmtNum(row.target)}</span>
            <span style="font-size:9px;color:#64748b;">Port.</span>
            ${row.platingStatus ? `<span style="padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;background:${sc.bg};color:${sc.text};">${row.platingStatus}</span>` : ""}
            ${row.rolloverAmount != null ? `<span style="padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;background:#fef3c7;color:#92400e;">↩ ${fmtNum(row.rolloverAmount)} Rollover</span>` : ""}
          </div>
          <div style="margin-bottom:5px;">${allergenHtml}</div>
          ${structured ? `<div style="font-size:9px;color:#92400e;background:#fef3c7;border:1px solid #fbbf24;padding:3px 7px;border-radius:4px;margin-bottom:4px;">⚠ <strong>Allergene:</strong> ${structured}</div>` : ""}
          ${row.bestByDate ? `<div style="font-size:9px;color:#5b21b6;background:#f5f3ff;border-left:2px solid #a78bfa;padding:3px 7px;margin-bottom:3px;">📅 <strong>Best By:</strong> ${row.bestByDate}${row.bestBySubRecipe ? ` · ${row.bestBySubRecipe}` : ""}</div>` : ""}
          ${row.expiringSubRecipe ? `<div style="font-size:9px;color:#991b1b;background:#fef2f2;border-left:2px solid #fca5a5;padding:3px 7px;margin-bottom:3px;">🕐 <strong>Ablauf:</strong> ${row.expiringSubRecipe}${row.expiringPortions ? ` · ${fmtNum(parseFloat(row.expiringPortions))} Port.` : ""}${row.expiringDatetime ? ` · ${row.expiringDatetime}` : ""}</div>` : ""}
          ${row.comment ? `<div style="font-size:9px;color:#374151;background:#f1f5f9;border-left:2px solid #94a3b8;padding:3px 7px;margin-bottom:3px;">💬 ${row.comment}</div>` : ""}
          ${instrHtml}
          ${imgHtml}
        </div>
        ${cleaningHtml}`;
    }).join("");

    return `
    <td style="width:${(100 / lineCount).toFixed(1)}%;vertical-align:top;${li < lineCount - 1 ? "padding-right:10px;" : ""}">
      <div style="background:${lineColor};color:#fff;padding:7px 10px;border-radius:6px 6px 0 0;font-size:10px;font-weight:800;">
        Linie ${li + 1} &mdash; ${fmtNum(lineTarget)} Port. &mdash; ${lineHours.toFixed(1)} h &mdash; ${lineStaff} MA &mdash; ${fmtNum(lineCap)}/h
      </div>
      <div style="background:${lineBg};border:1px solid ${lineColor}33;border-radius:0 0 6px 6px;padding:6px;">
        <div style="font-size:9px;color:#64748b;margin-bottom:4px;">
          Start ${fmtClock(LINE_START_HOUR * 60)} · Ende est. ${fmtClock(LINE_START_HOUR * 60 + lineHours * 60)} · Auslastung ${utilPct}%
        </div>
        <table width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:6px;"><tr>
          <td width="${utilPct}%" style="height:4px;background:${lineColor};border-radius:3px;"></td>
          ${utilPct < 100 ? `<td style="height:4px;background:#e2e8f0;"></td>` : ""}
        </tr></table>
        ${mealCards || `<div style="font-size:11px;color:#94a3b8;padding:8px 0;">Keine Meals zugewiesen</div>`}
      </div>
    </td>`;
  }).join("");

  const shiftHeader = fmtShiftHeader(shiftKey);

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#0f172a;background:#fff}
@media print{body{font-size:10px}@page{size:A4 landscape;margin:8mm}table{page-break-inside:avoid}}
</style>
</head>
<body>
<!-- Header -->
<div style="background:linear-gradient(135deg,#0f2240,#1e3a5f);color:#fff;padding:14px 18px;margin-bottom:10px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <div style="font-size:8px;letter-spacing:.15em;color:#7dd3fc;text-transform:uppercase;margin-bottom:4px;">Factor OPS · Verden · PET Plaiting</div>
  <div style="font-size:22px;font-weight:900;">${title}</div>
  <div style="font-size:10px;color:#93c5fd;margin-top:4px;">${shiftHeader} · ${rows.length} Meals · ${fmtNum(shiftTarget)} Portionen · ${lineCount} Linien · ${staffTotal} MA gesamt</div>
  <div style="font-size:9px;color:#64748b;margin-top:2px;">Generiert: ${new Date().toLocaleString("de-DE")}</div>
</div>

<!-- KPI Zeile -->
<table width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 10px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <tr>
    <td style="padding:10px 14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
      <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:2px;">Portionen Ziel</div>
      <div style="font-size:22px;font-weight:900;color:#0f172a;">${fmtNum(shiftTarget)}</div>
      ${pct > 0 ? `<div style="font-size:9px;color:#059669;">${pct}% geplated</div>` : ""}
    </td>
    <td style="padding:10px 14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
      <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:2px;">Linien</div>
      <div style="font-size:22px;font-weight:900;color:#0f172a;">${lineCount}</div>
      <div style="font-size:9px;color:#64748b;">${capacities.slice(0, lineCount).map((c, i) => `L${i+1}:${fmtNum(c)}/h`).join(" · ")}</div>
    </td>
    <td style="padding:10px 14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
      <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:2px;">Parallel-Zeit</div>
      <div style="font-size:22px;font-weight:900;color:#0f172a;">${parallelHours.toFixed(1)} h</div>
      <div style="font-size:9px;color:#64748b;">ab ${fmtClock(LINE_START_HOUR * 60)}</div>
    </td>
    <td style="padding:10px 14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
      <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:2px;">MA Gesamt</div>
      <div style="font-size:22px;font-weight:900;color:#0f172a;">${staffTotal}</div>
      <div style="font-size:9px;color:#64748b;">Submeals + 1 je Linie</div>
    </td>
    ${allAllergens.size > 0 ? `
    <td style="padding:10px 14px;background:#fffbeb;border-right:1px solid #fde68a;">
      <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#92400e;margin-bottom:3px;">Allergene im Shift</div>
      <div style="font-size:10px;font-weight:700;color:#78350f;">${Array.from(allAllergens).join(" · ")}</div>
    </td>` : ""}
    <td style="padding:10px 14px;background:#fef3c7;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="font-size:9px;font-weight:700;color:#78350f;">⚠ ALLERGEN-SICHERHEIT</div>
      <div style="font-size:8px;color:#92400e;margin-top:2px;">Bei Allergen-Wechsel Linie reinigen. Gleiche Allergene wurden gebündelt, um Wechsel zu minimieren.</div>
    </td>
  </tr>
</table>

<!-- Linienplan -->
<table width="100%" cellspacing="0" cellpadding="0">
  <tr style="vertical-align:top;">
    ${lineHtmls}
  </tr>
</table>

</body>
</html>`;
}
