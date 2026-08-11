// Rundmail – KET Plating-Präsentation (Print/PDF-Export, keine React-Abhängigkeit).
import type { AllergenDef, RundmailRow } from "./rundmailTypes";
import { daySortValue, parseDateNeeded } from "./rundmailParsing";
import { detectAllergens, escapeHtml, fmtInt, toSlack } from "./rundmailFormat";

// Print-Fidelity: wird sowohl hier als auch in rundmailPetMail.ts gebraucht, damit
// Bildschirm-Vorschau (Popup vor dem Drucken) und gespeichertes PDF identisch aussehen.
// Zwei Ursachen für "sieht im Popup gut aus, gespeichert wie Mist":
//  1) Hintergrundfarben/Badges verschwinden im PDF, wenn der Nutzer im Druckdialog
//     "Hintergrundgrafiken" nicht aktiviert hat -> print-color-adjust:exact erzwingt sie IMMER.
//  2) @page-Breite (A4, abzüglich Rand) ist schmaler als das 1200px-Vorschau-Popup ->
//     dichte Tabellen quetschen sich beim Drucken zusammen. Fix: Querformat + feste
//     Spaltenbreiten statt frei fließendem Text.
export const PRINT_COLOR_FIX = `*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}`;

export function buildKetPresentationHtml(allRows: RundmailRow[], sourceLabel: string, targetRun: 1 | 2): string {
  const runRows = allRows.filter((r) => parseDateNeeded(r.dateNeeded).run === targetRun);
  const days = Array.from(new Set(runRows.map((r) => r.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));
  const runLabel = `Run ${targetRun}`;
  const generatedAt = new Date().toLocaleString("de-DE");

  // Deduplizierte Totals
  const dedupedRows = Array.from(new Map(runRows.map((r) => [r.recipeId, r])).values());
  const totalTarget = dedupedRows.reduce((s, r) => s + r.targetPortions, 0);
  const totalCooked = dedupedRows.reduce((s, r) => s + r.woCookedPortions, 0);
  const totalOpen = dedupedRows.reduce((s, r) => s + toSlack(r.targetPortions - r.woCookedPortions), 0);
  const uniqueRecipes = new Set(runRows.map((r) => r.recipeId)).size;
  const completion = totalTarget > 0 ? Math.min(100, Math.round((totalCooked / totalTarget) * 100)) : 0;

  function statusColor(status: string): string {
    const s = status.toLowerCase();
    if (s.includes("post blast") || s.includes("done") || s.includes("complete")) return "#166534";
    if (s.includes("pre blast") || s.includes("in progress")) return "#92400e";
    if (s.includes("not started") || s.includes("open")) return "#991b1b";
    return "#334155";
  }

  const dayBlocks = days.map((day) => {
    const dayRows = runRows.filter((r) => r.dateNeeded === day);
    const recipeMap = new Map<string, { rows: RundmailRow[]; allergens: AllergenDef[] }>();
    dayRows.forEach((r) => {
      const existing = recipeMap.get(r.recipeId);
      if (existing) { existing.rows.push(r); }
      else recipeMap.set(r.recipeId, { rows: [r], allergens: [] });
    });
    recipeMap.forEach((entry) => {
      entry.allergens = detectAllergens([entry.rows[0].recipeName, ...entry.rows.map((r) => r.subRecipeName)]);
    });

    const dayTarget = Array.from(recipeMap.values()).reduce((s, e) => s + e.rows[0].targetPortions, 0);
    const { date, run } = parseDateNeeded(day);

    const recipeCards = Array.from(recipeMap.values()).map((recipe) => {
      const first = recipe.rows[0];
      const hue = (Array.from(first.recipeId).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) * 0.618033) % 1;
      const h = Math.round(hue * 360);
      const allergenHtml = recipe.allergens.length
        ? recipe.allergens.map((a) => `<span class="badge" style="background:${a.bg};color:${a.text};border:1px solid ${a.border};">${escapeHtml(a.label)}</span>`).join("")
        : `<span class="no-allergen">Keine bekannten Allergene</span>`;
      const hasFish = recipe.allergens.some((a) => a.label === "Fisch");

      const subRows = recipe.rows.map((r) => {
        const delta = r.woCookedPortions - r.targetPortions;
        return `<tr>
          <td class="mono">${escapeHtml(r.workOrderNumber)}</td>
          <td class="wrap">${escapeHtml(r.subRecipeName)}</td>
          <td class="wrap mono-sm">${escapeHtml(r.cookMethods || "–")}</td>
          <td class="r">${fmtInt(r.targetPortions)}</td>
          <td class="r">${r.kitchenKg != null ? fmtInt(r.kitchenKg) + " kg" : "–"}</td>
          <td class="r bold batches">${r.batchesNeeded != null ? fmtInt(r.batchesNeeded) : "–"}</td>
          <td class="wrap" style="color:${statusColor(r.kitchenStatus)};font-weight:700;">${escapeHtml(r.kitchenStatus || "–")}</td>
          <td class="r" style="color:${delta < 0 ? "#991b1b" : "#166534"};font-weight:700;">${delta >= 0 ? "+" : ""}${fmtInt(delta)}</td>
        </tr>`;
      }).join("");

      return `<div class="recipe-card" style="border-left-color:hsl(${h},60%,42%);">
        <div class="recipe-hdr" style="background:hsl(${h},44%,97%);">
          <div class="recipe-hdr-main">
            <span class="recipe-name">${escapeHtml(first.recipeName.replace(/\s*\[.*?\]/g, ""))}</span>
            <span class="recipe-id">${escapeHtml(first.recipeId)}</span>
            ${hasFish ? `<span class="fish-warn">&#9888;</span>` : ""}
          </div>
          <div class="recipe-meta">
            <span class="kpi-chip">${fmtInt(first.targetPortions)} Port.</span>
            <span class="kpi-chip">${recipe.rows.length} WOs</span>
            ${allergenHtml}
          </div>
        </div>
        <table class="sub-table">
          <colgroup>
            <col style="width:7%"><col style="width:26%"><col style="width:17%">
            <col style="width:8%"><col style="width:9%"><col style="width:8%">
            <col style="width:17%"><col style="width:8%">
          </colgroup>
          <thead><tr>
            <th>WO #</th><th>Sub-Rezept</th><th>Methode</th>
            <th class="r">Target</th><th class="r">Küche kg</th>
            <th class="r">Batches</th><th>Status</th><th class="r">Δ</th>
          </tr></thead>
          <tbody>${subRows}</tbody>
        </table>
      </div>`;
    }).join("");

    return `<div class="day-block">
      <div class="day-hdr">
        <span class="day-title">${escapeHtml(date)} &mdash; Run ${run}</span>
        <span class="day-meta">${recipeMap.size} Rezepte &middot; ${dayRows.length} WOs &middot; ${fmtInt(dayTarget)} Portionen</span>
      </div>
      ${recipeCards}
    </div>`;
  }).join("");

  const completionBar = `<div class="prog-track"><div class="prog-fill" style="width:${completion}%;"></div></div>`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>KET Plating Plan &mdash; ${runLabel}</title>
<style>
${PRINT_COLOR_FIX}
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4 landscape;margin:10mm 12mm}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#1e293b;background:#fff}
.cover{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#0369a1 100%);border-radius:10px;padding:20px 24px 16px;margin-bottom:14px}
.cover-eyebrow{font-size:9px;letter-spacing:.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:6px}
.cover-title{font-size:24px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-.02em}
.cover-sub{font-size:13px;color:#bae6fd;margin-top:5px}
.cover-meta{font-size:9px;color:#94a3b8;margin-top:10px;border-top:1px solid rgba(255,255,255,.18);padding-top:8px}
.kpi-row{display:flex;gap:8px;margin-bottom:12px}
.kpi-box{flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;text-align:center}
.kpi-lbl{font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:.1em}
.kpi-val{font-size:19px;font-weight:900;color:#0f172a;line-height:1.1;margin-top:2px}
.prog-track{height:5px;background:#e2e8f0;border-radius:9px;overflow:hidden;margin-bottom:14px}
.prog-fill{height:100%;background:linear-gradient(90deg,#0ea5e9,#10b981);border-radius:9px}
.day-block{border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:14px}
.day-hdr{background:#1e293b;padding:7px 12px;display:flex;justify-content:space-between;align-items:center}
.day-title{font-size:12px;font-weight:800;color:#fff}
.day-meta{font-size:9px;color:#94a3b8}
.recipe-card{border-left:4px solid #0369a1;margin:7px 8px;border-radius:0 6px 6px 0;overflow:hidden;page-break-inside:avoid;break-inside:avoid;border:1px solid #eef2f7;border-left-width:4px}
.recipe-hdr{padding:5px 9px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:4px}
.recipe-hdr-main{display:flex;align-items:baseline;gap:6px;min-width:0}
.recipe-name{font-size:11px;font-weight:800;color:#0f172a}
.recipe-id{font-size:9px;color:#64748b;font-family:monospace}
.fish-warn{color:#dc2626;font-weight:800}
.recipe-meta{display:flex;flex-wrap:wrap;gap:3px;align-items:center}
.kpi-chip{display:inline-block;background:#e2e8f0;color:#334155;border-radius:4px;padding:1px 6px;font-size:8px;font-weight:700;white-space:nowrap}
.no-allergen{font-size:8px;color:#94a3b8}
.badge{display:inline-block;border-radius:3px;padding:1px 6px;font-size:8px;font-weight:700;margin:1px}
.sub-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:9px}
.sub-table th{padding:3px 7px;background:#f8fafc;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:700;text-align:left;border-bottom:1px solid #e2e8f0}
.sub-table td{padding:3px 7px;border-bottom:1px solid #f8fafc;vertical-align:top}
.sub-table tr:last-child td{border-bottom:none}
.wrap{overflow-wrap:anywhere;word-break:break-word}
.r{text-align:right;white-space:nowrap}
.mono{font-family:monospace;color:#475569}
.mono-sm{font-family:monospace;font-size:8px;color:#64748b}
.batches{color:#4338ca}
.bold{font-weight:700}
.footer{margin-top:14px;font-size:9px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:8px;display:flex;justify-content:space-between}
</style>
</head>
<body>
<div class="cover">
  <div class="cover-eyebrow">Factor OPS &middot; Verden &middot; KET</div>
  <div class="cover-title">KET Plating &mdash; ${runLabel}</div>
  <div class="cover-sub">${fmtInt(uniqueRecipes)} Rezepte &middot; ${fmtInt(totalTarget)} Portionen &middot; ${days.length} Produktionstage</div>
  <div class="cover-meta">Erstellt: ${escapeHtml(generatedAt)} &nbsp;&middot;&nbsp; Quelle: ${escapeHtml(sourceLabel)}</div>
</div>
<div class="kpi-row">
  <div class="kpi-box"><div class="kpi-lbl">Rezepte</div><div class="kpi-val">${fmtInt(uniqueRecipes)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Portionen Ziel</div><div class="kpi-val">${fmtInt(totalTarget)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Portionen Ist</div><div class="kpi-val" style="color:#0369a1;">${fmtInt(totalCooked)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Offen</div><div class="kpi-val" style="color:${totalOpen > 0 ? "#b91c1c" : "#166534"};">${fmtInt(totalOpen)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Fertig</div><div class="kpi-val" style="color:${completion >= 80 ? "#166534" : completion >= 50 ? "#92400e" : "#991b1b"};">${completion}%</div></div>
</div>
${completionBar}
${dayBlocks}
<div class="footer"><span>Factor OPS Planner &middot; KET Plating Plan &middot; ${escapeHtml(runLabel)}</span><span>${escapeHtml(generatedAt)}</span></div>
</body>
</html>`;
}
