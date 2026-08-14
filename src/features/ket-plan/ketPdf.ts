// Baut das druckbare HTML/PDF für einen Satz Work Orders (Breakdown-Karten je WO).
import { EQUIP_DEFAULTS, EQUIP_LABELS, type BatchCalc, type KetRow, type WoInstruction } from "./ketTypes";
import { escHtml, fmtKg, fmtNum, parseDateShift } from "./ketLogic";
import { orderCookingMethods } from "./woInstructionBot";

export function buildPdf(
  rows: KetRow[],
  calcMap: Map<string, BatchCalc>,
  caps: Record<string, number>,
  title: string,
  source: "CSV" | "Firestore" | "LiveWMS" | "FirestoreStale" | null = null,
  woInstructions: Record<string, WoInstruction> = {},
): string {

  const cards = rows.map((row, i) => {
    const calc = calcMap.get(row.key);
    if (!calc) return "";

    const { date, shift } = parseDateShift(row.dateNeeded);
    const d = new Date(date);
    const dateStr = d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

    const done = row.woCookedPortions ?? 0;
    const remaining = Math.max(0, row.targetPortions - done);
    const donePct = row.targetPortions > 0 ? Math.round((done / row.targetPortions) * 100) : 0;
    const cookDisplay = orderCookingMethods(calc.resolvedCookMethods).join(" → ") || "—";

    const ING_CAT_ORDER: Record<string, number> = { SPI: 0, PHF: 1, DAI: 2, PRO: 3 };
    const ingRows = calc.ingredients
      .filter(ing => ing.totalKg > 0.0005)
      .sort((a, b) => {
        const ca = (a.category ?? "").trim().toUpperCase().slice(0, 3);
        const cb = (b.category ?? "").trim().toUpperCase().slice(0, 3);
        const oa = ING_CAT_ORDER[ca] ?? 99;
        const ob = ING_CAT_ORDER[cb] ?? 99;
        if (oa !== ob) return oa - ob;
        return b.totalKg - a.totalKg;
      })
      .map(ing => {
        const catBg =
          ing.category === "PRO" ? "#fee2e2" :
          ing.category === "PHF" ? "#dbeafe" :
          ing.category === "SPI" ? "#fef9c3" :
          ing.category === "DRY" ? "#f3f4f6" : "#fff";
        const yieldNote = ing.yieldPct && ing.yieldPct < 1
          ? `<br><span style="font-size:8px;color:#d97706;font-weight:700">${Math.round((1 - ing.yieldPct) * 100)}% Verlust</span>`
          : "";
        return `<tr style="background:${catBg}">
          <td>
            ${ing.category ? `<span class="cat">${ing.category}</span>` : ""}
            ${ing.name}${yieldNote}
          </td>
          <td class="num">${fmtKg(ing.totalKg)}</td>
          <td class="num hi">${fmtKg(ing.perBatchKg)}</td>
        </tr>`;
      }).join("");

    const equip = calc.primaryEquip ? (EQUIP_LABELS[calc.primaryEquip] ?? calc.primaryEquip) : "—";
    const cap = calc.capacityKg ? `${calc.capacityKg} kg` : "—";
    const capBibleNote = calc.primaryCapBibleMatch
      ? ` <span style="color:#b45309;font-weight:800;" title="Kuechenbible-Kapazität (provisorisch)">📖 Kuechenbible: ${escHtml(calc.primaryCapBibleMatch.itemName)}</span>`
      : "";

    // Per-Equipment Batch-Übersicht
    const equipBatchHtml = calc.equipBatches.length > 0
      ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0;">
          ${calc.equipBatches.map(eb => `
            <div style="background:#1e3a5f;color:#fff;border-radius:8px;padding:6px 10px;min-width:80px;text-align:center;">
              <div style="font-size:8px;color:#93c5fd;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px;">${eb.label}</div>
              <div style="font-size:20px;font-weight:900;line-height:1;">${eb.batches}×</div>
              <div style="font-size:8px;color:#93c5fd;margin-top:1px;">${eb.capacityKg} kg / Batch</div>
              <div style="font-size:8px;color:#7dd3fc;">à ${eb.perBatchKg.toFixed(1)} kg${eb.remainderKg > 0 ? ` + Rest ${eb.remainderKg.toFixed(1)} kg` : ""}</div>
              ${eb.bibleMatch ? `<div style="font-size:7px;color:#fde68a;font-weight:800;margin-top:2px;">📖 Kuechenbible: ${escHtml(eb.bibleMatch.itemName)}</div>` : ""}
            </div>`).join("")}
        </div>`
      : "";

    const generatedInstruction = woInstructions[row.key];
    const renderSteps = (text: string) => {
      const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
      if (lines.length === 0) return `<div style="font-size:9px;color:#1e293b;white-space:pre-wrap;">${escHtml(text)}</div>`;
      let stepNum = 0;
      return lines.map(line => {
        // Station header: "A. VEGGIE DEBOX" / "B. OFEN" etc.
        if (/^[A-D]\. /.test(line)) {
          stepNum = 0;
          return `<div style="margin-top:5px;margin-bottom:2px;font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:#166534;border-bottom:1px solid #d1fae5;padding-bottom:1px;">${escHtml(line)}</div>`;
        }
        const clean = line.replace(/^\s*[-–•*]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim();
        if (!clean) return "";
        stepNum++;
        return `<div style="display:flex;gap:4px;align-items:flex-start;margin-bottom:2px;"><span style="display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;background:#166534;color:#fff;border-radius:50%;font-size:7px;font-weight:900;flex-shrink:0;margin-top:1px;">${stepNum}</span><span style="font-size:9px;color:#1e293b;line-height:1.35;white-space:pre-wrap;">${escHtml(clean)}</span></div>`;
      }).join("");
    };
    const instrHtml = generatedInstruction
      ? `<div style="margin-top:8px;border:1px solid #d1fae5;border-radius:7px;overflow:hidden;">
          <div style="background:#f0fdf4;padding:4px 10px;border-bottom:1px solid #d1fae5;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:#166534;">Kochanweisung · ${escHtml(row.subRecipeName)}</span>
            ${generatedInstruction.status === "needs_review" ? '<span style="font-size:7px;color:#d97706;font-weight:700;">⚠ Review erforderlich</span>' : ""}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:6px 10px;">
            <div>
              <div style="font-size:8px;font-weight:900;color:#166534;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px;">English</div>
              ${renderSteps(generatedInstruction.english)}
            </div>
            <div>
              <div style="font-size:8px;font-weight:900;color:#1e40af;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px;">Deutsch</div>
              ${renderSteps(generatedInstruction.german)}
            </div>
          </div>
        </div>`
      : "";

    const unlockedEtaStr = row.unlockedEta
      ? (() => { try { return new Date(row.unlockedEta).toLocaleString("de-DE"); } catch { return row.unlockedEta; } })()
      : null;

    const progressBar = donePct > 0 ? `
    <div class="progress-wrap">
      <div class="progress-bar" style="width:${Math.min(100, donePct)}%;background:${donePct >= 100 ? "#10b981" : "#3b82f6"}"></div>
    </div>` : "";

    return `
<section class="card" style="page-break-before:${i > 0 ? "always" : "auto"};page-break-after:auto">
  <div class="card-top">
    <div>
      <div class="wo-num">WO ${row.woNumber}</div>
      <div class="date-tag">${dateStr}${shift ? ` · Shift ${shift}` : ""}</div>
    </div>
    <div class="recipe-tag">
      <div class="code">${row.recipeCode}</div>
      <div class="rname">${row.recipeName}</div>
    </div>
  </div>

  <div class="sub">${row.subRecipeName || "—"}</div>

  <div class="methods">${cookDisplay}</div>

  <div class="stats">
    <div class="stat">
      <div class="slabel">Ziel-Portionen</div>
      <div class="sval">${fmtNum(row.targetPortions)}</div>
    </div>
    <div class="stat">
      <div class="slabel">Gekocht / Rest</div>
      <div class="sval">${fmtNum(done)} <span style="font-size:12px;color:#6b7280">/ ${fmtNum(remaining)}</span></div>
      ${donePct > 0 ? `<div style="font-size:9px;color:#059669;font-weight:700;margin-top:1px">${donePct}% fertig</div>` : ""}
      ${progressBar}
    </div>
    <div class="stat">
      <div class="slabel">Total KG (Roh)</div>
      <div class="sval">${calc.totalKg > 0 ? fmtKg(calc.totalKg) : (calc.recipeFound ? "kein Sub" : "Rezept?")}</div>
    </div>
    <div class="stat">
      <div class="slabel">Primär-Equipment</div>
      <div class="sval" style="font-size:13px">${equip}</div>
      <div style="font-size:9px;color:#6b7280;margin-top:1px">${cap} / Batch${capBibleNote}</div>
    </div>
    <div class="stat hi-stat">
      <div class="slabel">BATCHE (${equip})${calc.primaryCapBibleMatch ? ` <span title="Kuechenbible-Kapazität (provisorisch)">📖</span>` : ""}</div>
      <div class="sval big">${calc.batches > 0 ? calc.batches : "—"}</div>
    </div>
    <div class="stat">
      <div class="slabel">Pro Batch</div>
      <div class="sval">${calc.perBatchKg > 0 ? fmtKg(calc.perBatchKg) : "—"}</div>
    </div>
    ${row.cookedPortionsExcess != null ? `
    <div class="stat ${(row.cookedPortionsExcess ?? 0) >= 0 ? "stat-green" : "stat-red"}">
      <div class="slabel">Excess Portionen</div>
      <div class="sval">${(row.cookedPortionsExcess ?? 0) > 0 ? "+" : ""}${fmtNum(row.cookedPortionsExcess ?? 0)}</div>
    </div>` : ""}
  </div>

  ${equipBatchHtml}

  <div class="badges">
    <span class="badge ${row.kitchenStatus === "Post Blast" ? "badge-green" : row.kitchenStatus === "Pre Blast" ? "badge-amber" : "badge-gray"}">
      Kitchen: ${row.kitchenStatus || "—"}
    </span>
    <span class="badge ${row.stagingStatus === "Staged" ? "badge-green" : row.stagingStatus === "Partially Staged" ? "badge-orange" : row.stagingStatus === "Picking" ? "badge-blue" : "badge-gray"}">
      Staging: ${row.stagingStatus || "—"}
    </span>
    ${unlockedEtaStr ? `<span class="badge badge-blue">🔓 Unlocked: ${unlockedEtaStr}</span>` : ""}
  </div>

  ${row.workOrderComment ? `<div class="comment warn">⚠ WO Kommentar: ${row.workOrderComment}</div>` : ""}
  ${row.stagingComment ? `<div class="comment info">💬 Staging: ${row.stagingComment}</div>` : ""}
  ${instrHtml}

  ${ingRows ? `
  <table class="ings">
    <thead><tr><th>Zutat</th><th class="num">Total</th><th class="num hi">Pro Batch</th></tr></thead>
    <tbody>${ingRows}</tbody>
    <tfoot><tr>
      <td><strong>GESAMT (${calc.batches > 1 ? `${calc.batches} Batche` : "1 Batch"})</strong></td>
      <td class="num"><strong>${fmtKg(calc.totalKg)}</strong></td>
      <td class="num hi"><strong>${fmtKg(calc.perBatchKg)}</strong></td>
    </tr></tfoot>
  </table>` : `
  <div class="no-data">${!calc.recipeFound ? "⚠ Rezept nicht in App-Daten — KG-Berechnung nicht möglich." : "⚠ Sub-Rezept in Zutaten nicht gefunden."}</div>`}
</section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:11px;color:#111;background:#fff}
.page-header{padding:14px 16px 8px;border-bottom:3px solid #1e3a5f;background:linear-gradient(135deg,#0f2240 0%,#1e3a5f 100%);color:#fff}
.page-title{font-size:20px;font-weight:900;color:#fff;letter-spacing:-.02em}
.page-meta{font-size:9px;color:#93c5fd;margin-top:3px}
.equip-section{display:flex;gap:16px;align-items:flex-start;padding:8px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb}
.equip-label{font-size:9px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
.equip-grid{display:flex;flex-wrap:wrap;gap:4px}
.equip-chip{background:#1e3a5f;color:#fff;font-size:9px;font-weight:700;padding:2px 8px;border-radius:10px}
.card{padding:14px 16px;border:1.5px solid #e2e8f0;border-radius:10px;margin:8px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.wo-num{font-size:28px;font-weight:900;color:#1e3a5f;line-height:1}
.date-tag{font-size:10px;color:#6b7280;margin-top:3px}
.recipe-tag{text-align:right}
.code{font-size:10px;font-weight:700;color:#9ca3af;font-family:monospace}
.rname{font-size:11px;font-weight:600;color:#374151;max-width:260px;text-align:right}
.sub{font-size:18px;font-weight:900;color:#111;border-bottom:2px solid #e2e8f0;padding-bottom:7px;margin-bottom:8px}
.methods{background:linear-gradient(135deg,#0f2240,#1e3a5f);color:#fff;border-radius:7px;padding:9px 14px;font-size:12px;font-weight:700;letter-spacing:.04em;margin-bottom:10px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px}
.stat{background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:7px 10px}
.hi-stat{background:#1e3a5f;border-color:#1e3a5f}
.stat-green{background:#f0fdf4;border-color:#bbf7d0}
.stat-red{background:#fef2f2;border-color:#fecaca}
.slabel{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:2px}
.hi-stat .slabel{color:#93c5fd}
.stat-green .slabel{color:#16a34a}
.stat-red .slabel{color:#dc2626}
.sval{font-size:19px;font-weight:900;color:#111;line-height:1.1}
.hi-stat .sval{color:#fff}
.stat-green .sval{color:#15803d}
.stat-red .sval{color:#b91c1c}
.sval.big{font-size:36px}
.progress-wrap{height:4px;background:#e5e7eb;border-radius:2px;margin-top:4px;overflow:hidden}
.progress-bar{height:100%;border-radius:2px;transition:width .3s}
.badges{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px}
.badge{font-size:9px;font-weight:700;padding:3px 8px;border-radius:5px}
.badge-green{background:#d1fae5;color:#065f46}
.badge-amber{background:#fef3c7;color:#92400e}
.badge-orange{background:#ffedd5;color:#9a3412}
.badge-blue{background:#dbeafe;color:#1e40af}
.badge-gray{background:#f1f5f9;color:#475569}
.badge-red{background:#fee2e2;color:#991b1b}
.comment{font-size:10px;padding:6px 10px;border-radius:6px;margin-bottom:5px;border-left:3px solid transparent}
.comment.warn{background:#fef3c7;color:#92400e;border-color:#fbbf24}
.comment.info{background:#f1f5f9;color:#374151;border-color:#94a3b8}
.comment.instr{background:#eff6ff;color:#1e40af;border-color:#93c5fd}
.ings{width:100%;border-collapse:collapse;margin-top:8px;font-size:10px}
.ings th{background:#f1f5f9;padding:5px 8px;text-align:left;font-weight:700;font-size:9px;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e2e8f0;color:#475569}
.ings td{padding:4px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top}
.ings tfoot td{border-top:2px solid #1e3a5f;padding-top:6px;background:#f8fafc}
.num{text-align:right;white-space:nowrap;font-weight:600}
.hi{color:#1e40af;font-weight:700}
.cat{display:inline-block;font-size:8px;font-weight:700;padding:1px 4px;border-radius:3px;background:#f1f5f9;color:#64748b;margin-right:4px}
.no-data{padding:10px;background:#fef3c7;border-radius:6px;font-size:10px;color:#92400e;margin-top:8px;border-left:3px solid #fbbf24}
@media print{
  body{font-size:9px}
  .page-header,.equip-section{display:none}
  .card{
    page-break-before:always;page-break-after:always;page-break-inside:avoid;
    break-before:page;break-after:page;break-inside:avoid;
    margin:0;border-width:1px;box-shadow:none;border-radius:6px;
    padding:10px 12px;
    max-height:281mm;overflow:hidden;
  }
  .card:first-of-type{page-break-before:auto;break-before:auto}
  .wo-num{font-size:22px}.sub{font-size:15px}
  .sval{font-size:15px}.sval.big{font-size:28px}
  .stat{padding:5px 8px}.slabel{font-size:7px}
  .methods{padding:6px 10px;font-size:11px}
  .methods,.hi-stat,.stat-green,.stat-red{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  @page{size:A4;margin:8mm}
}
</style>
</head>
<body>
${cards}
</body>
</html>`;
}
