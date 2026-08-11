// Rundmail – PET Plating-Präsentation (Print/PDF-Export, keine React-Abhängigkeit).
import type { AllergenDef, PetRow, PlatingNote } from "./rundmailTypes";
import { daySortValue, parseBestByTimestamp, parseDateNeeded } from "./rundmailParsing";
import { detectAllergens, escapeHtml, fmtInt, petStatusTone, toSlack } from "./rundmailFormat";
import { PRINT_COLOR_FIX } from "./rundmailKetMail";

export const PET_PORTIONS_PER_LINE_PER_SHIFT = 1000;
export const PET_LINE_START_HOUR = 7;

export function formatClock(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const hh = Math.floor(safe / 60).toString().padStart(2, "0");
  const mm = (safe % 60).toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

export function extractMealCode(recipeName: string): string {
  const match = recipeName.match(/(FV\d{4}[A-Z])/i);
  if (match) return match[1].toUpperCase();
  return recipeName.split(/\s+/).slice(0, 1).join("");
}

export function oneDayBefore(isoDate: string): string {
  const ts = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(ts)) return isoDate;
  return new Date(ts - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ─── PET Präsentation ─────────────────────────────────────────────────────────

export function buildPetPresentationHtml(
  allPetRows: PetRow[],
  sourceLabel: string,
  targetRun: 1 | 2,
  platingNotes?: Record<string, PlatingNote>,
): string {
  const runLabel = `Run ${targetRun}`;
  const generatedAt = new Date().toLocaleString("de-DE");
  const soonLimit = Date.now() + 48 * 60 * 60 * 1000;

  type EnrichedRow = PetRow & {
    status: string; bestByText: string; bestByTs: number | null;
    open: number; ratio: number; allergens: AllergenDef[];
    expiringSubRecipeName: string;
  };

  const runRows: EnrichedRow[] = allPetRows
    .filter((r) => parseDateNeeded(r.productionShift).run === targetRun)
    .map((r) => {
      const status = r.recipeManualPlatingStatus || r.recipePlatingStatus || "Not Started";
      const bestByText = r.actualBestByDate || r.expiringDatetime || "";
      const bestByTs = parseBestByTimestamp(bestByText);
      const open = toSlack(r.recipeWoTarget - r.recipeWoMapped);
      const ratio = r.recipeWoTarget > 0 ? Math.min(100, Math.round((r.recipeWoMapped / r.recipeWoTarget) * 100)) : 0;
      const allergens = detectAllergens([r.recipeName, r.expiringSubRecipeName || ""]);
      return { ...r, status, bestByText, bestByTs, open, ratio, allergens };
    });

  const shifts = Array.from(new Set(runRows.map((r) => r.productionShift))).sort((a, b) => daySortValue(a) - daySortValue(b));
  const totalTarget = runRows.reduce((s, r) => s + r.recipeWoTarget, 0);
  const totalMapped = runRows.reduce((s, r) => s + r.recipeWoMapped, 0);
  const totalOpen = runRows.reduce((s, r) => s + r.open, 0);
  const completion = totalTarget > 0 ? Math.min(100, Math.round((totalMapped / totalTarget) * 100)) : 0;
  const firstShiftDate = shifts.length ? parseDateNeeded(shifts[0]).date : "–";

  // Kapazitäts-/Personal-Kennzahlen — nur aus PET-CSV selbst abgeleitet (keine externe Quelle nötig).
  const doneCount = runRows.filter((r) => r.status.toLowerCase().includes("done") || r.status.toLowerCase().includes("complete")).length;
  const inProgressCount = runRows.filter((r) => r.status.toLowerCase().includes("in progress")).length;
  const notStartedCount = runRows.filter((r) => r.status.toLowerCase().includes("not started")).length;
  const urgentBestByCount = runRows.filter((r) => r.bestByTs != null && r.bestByTs <= soonLimit).length;
  const globalAllergens = new Set(runRows.flatMap((r) => r.allergens.map((a) => a.label)));
  const shiftLineNeeds = shifts.map((shift) => {
    const shiftTarget = runRows.filter((r) => r.productionShift === shift).reduce((s, r) => s + r.recipeWoTarget, 0);
    return shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
  });
  const peakLinesNeeded = shiftLineNeeds.length ? Math.max(...shiftLineNeeds) : 0;
  const peakStaffNeeded = shifts.length
    ? Math.max(...shifts.map((shift) => {
      const shiftRows = runRows.filter((r) => r.productionShift === shift).length;
      const shiftTarget = runRows.filter((r) => r.productionShift === shift).reduce((s, r) => s + r.recipeWoTarget, 0);
      const neededLines = shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
      const lineCount = neededLines > 2 ? 3 : 2;
      return shiftRows + lineCount;
    }))
    : 0;

  function allergenSig(row: EnrichedRow): string {
    return row.allergens.map((a) => a.label).sort().join("|") || "none";
  }

  function placementScore(lineRows: EnrichedRow[], lineTargets: number[], lineIdx: number, candidate: EnrichedRow): number {
    const last = lineRows.at(-1);
    const switchPenalty = last && allergenSig(last) !== allergenSig(candidate) ? 3 : 0;
    const projected = lineTargets.map((v, i) => i === lineIdx ? v + candidate.recipeWoTarget : v);
    const max = Math.max(...projected, 1);
    const min = Math.min(...projected);
    const balancePenalty = (max - min) / PET_PORTIONS_PER_LINE_PER_SHIFT;
    const overflowPenalty = Math.max(0, (projected[lineIdx] - PET_PORTIONS_PER_LINE_PER_SHIFT) / PET_PORTIONS_PER_LINE_PER_SHIFT) * 2;
    return switchPenalty + balancePenalty + overflowPenalty;
  }

  const LINE_COLORS = ["#0ea5e9", "#10b981", "#f59e0b"];
  const LINE_NAMES = ["Linie 1", "Linie 2", "Linie 3"];

  const shiftBlocks = shifts.map((shift, shiftIdx) => {
    const rows = runRows
      .filter((r) => r.productionShift === shift)
      .sort((a, b) => {
        if (a.bestByTs != null && b.bestByTs != null && a.bestByTs !== b.bestByTs) return a.bestByTs - b.bestByTs;
        if (a.bestByTs != null && b.bestByTs == null) return -1;
        if (a.bestByTs == null && b.bestByTs != null) return 1;
        return b.open - a.open;
      });

    const shiftTarget = rows.reduce((s, r) => s + r.recipeWoTarget, 0);
    const shiftMapped = rows.reduce((s, r) => s + r.recipeWoMapped, 0);
    const linesNeeded = shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
    const lineCount = linesNeeded > 2 ? 3 : 2;
    const lines: EnrichedRow[][] = Array.from({ length: lineCount }, () => []);
    const lineTargets = Array.from({ length: lineCount }, () => 0);

    for (const row of rows) {
      let bestLine = 0, bestScore = Infinity;
      for (let i = 0; i < lineCount; i++) {
        const s = placementScore(lines[i], lineTargets, i, row) + (lineTargets[i] / PET_PORTIONS_PER_LINE_PER_SHIFT) * 0.001;
        if (s < bestScore) { bestScore = s; bestLine = i; }
      }
      lines[bestLine].push(row);
      lineTargets[bestLine] += row.recipeWoTarget;
    }

    const { date } = parseDateNeeded(shift);
    const completedOn = oneDayBefore(date);
    const shiftUtil = linesNeeded > 0 ? Math.min(100, Math.round((shiftTarget / (linesNeeded * PET_PORTIONS_PER_LINE_PER_SHIFT)) * 100)) : 0;
    const shiftOpen = rows.reduce((s, r) => s + r.open, 0);
    const shiftStaffNeeded = rows.length + lineCount;
    const shiftAllergenSet = new Set(rows.flatMap((r) => r.allergens.map((a) => a.label)));
    const shiftUrgent = rows.filter((r) => r.bestByTs != null && r.bestByTs <= soonLimit).length;
    const avgLineHours = lineCount > 0 ? shiftTarget / (lineCount * PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;

    const lineResults = lines.map((lineRows, lineIdx) => {
      let cursorMin = PET_LINE_START_HOUR * 60;
      let cleaningCount = 0;
      const lineColor = LINE_COLORS[lineIdx] ?? "#0ea5e9";

      const cards = lineRows.map((row, rowIdx) => {
        const mealCode = extractMealCode(row.recipeName);
        const mealTitle = row.recipeName.replace(/\s*\[.*?\]/g, "").replace(/^FV\d{4}[A-Z]\s*-\s*/i, "").trim();
        const durationMin = Math.max(10, Math.round((row.recipeWoTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) * 60));
        const timeStart = cursorMin;
        const timeEnd = cursorMin + durationMin;
        cursorMin = timeEnd;

        const bestByUrgent = row.bestByTs != null && row.bestByTs <= soonLimit;
        const tone = petStatusTone(row.status);
        const allergenBadges = row.allergens.length
          ? row.allergens.map((a) => `<span class="badge" style="background:${a.bg};color:${a.text};border:1px solid ${a.border};">${escapeHtml(a.label)}</span>`).join("")
          : `<span class="no-allergen">–</span>`;

        const note = platingNotes?.[mealCode];
        const noteHtml = note?.instruction
          ? `<div class="plating-note"><strong>Plating:</strong> ${escapeHtml(note.instruction)}</div>`
          : "";
        const imageHtml = note?.packSchemaImageDataUrl
          ? `<div style="margin-top:4px;"><div class="section-lbl">Packschema</div><img src="${note.packSchemaImageDataUrl}" alt="Packschema ${escapeHtml(mealCode)}" class="pack-img"></div>`
          : "";

        // Reinigungsblock zwischen Rezepten bei Allergen-Wechsel
        let cleanHtml = "";
        if (rowIdx < lineRows.length - 1) {
          const cur = new Set(row.allergens.map((a) => a.label));
          const nxt = new Set((lineRows[rowIdx + 1]?.allergens ?? []).map((a) => a.label));
          const removed = [...cur].filter((l) => !nxt.has(l));
          const added = [...nxt].filter((l) => !cur.has(l));
          if (removed.length > 0 || added.length > 0) {
            const parts = [
              removed.length ? `entfernt: <strong>${removed.map(escapeHtml).join(", ")}</strong>` : "",
              added.length ? `neu: <strong>${added.map(escapeHtml).join(", ")}</strong>` : "",
            ].filter(Boolean).join(" &middot; ");
            cleanHtml = `<div class="cleaning-bar">&#9888; REINIGEN &mdash; ${parts}</div>`;
            cleaningCount += 1;
          }
        }

        return `<div class="recipe-card" style="border-left-color:${lineColor};">
          <div class="time-row">
            <span class="time-start">${formatClock(timeStart)}</span>
            <span class="time-sep">→</span>
            <span class="time-end">${formatClock(timeEnd)}</span>
            <span class="time-dur">${(durationMin / 60).toFixed(1)} h</span>
          </div>
          <div class="meal-code">${escapeHtml(mealCode)}</div>
          <div class="meal-title">${escapeHtml(mealTitle)}</div>
          <div class="meta-row">
            <span>SOLL <strong>${fmtInt(row.recipeWoTarget)}</strong></span>
            <span>IST <strong>${fmtInt(row.recipeWoMapped)}</strong></span>
            <span style="color:${row.open > 0 ? "#b91c1c" : "#166534"};">Gap <strong>${fmtInt(row.open)}</strong></span>
          </div>
          ${row.bestByText ? `<div class="best-by${bestByUrgent ? " urgent" : ""}">Best By: ${escapeHtml(row.bestByText)}</div>` : ""}
          <div class="allergen-row">${allergenBadges}</div>
          <div><span class="status-chip" style="background:${tone.bg};color:${tone.text};border:1px solid ${tone.border};">${escapeHtml(row.status)}</span></div>
          ${noteHtml}${imageHtml}
        </div>${cleanHtml}`;
      }).join("");

      const durationMin = Math.max(0, cursorMin - PET_LINE_START_HOUR * 60);
      const staffNeeded = lineRows.length + 1;

      const html = `<div class="line-col">
        <div class="line-title" style="border-bottom:3px solid ${lineColor};color:${lineColor};">
          <span>${LINE_NAMES[lineIdx] ?? `Linie ${lineIdx + 1}`}</span>
          <span class="line-meta">${fmtInt(lineTargets[lineIdx])} Port. &middot; ${(durationMin / 60).toFixed(1)} h &middot; ~${fmtInt(staffNeeded)} MA</span>
        </div>
        <div class="line-time">Start ${formatClock(PET_LINE_START_HOUR * 60)} &middot; Ende ${formatClock(PET_LINE_START_HOUR * 60 + durationMin)}</div>
        ${cards || `<div class="empty-line">Keine Rezepte</div>`}
      </div>`;

      return { html, durationMin, staffNeeded, cleaningCount };
    });

    const lineColumns = lineResults.map((r) => r.html).join("");
    const cleaningTotal = lineResults.reduce((s, r) => s + r.cleaningCount, 0);
    const parallelHours = lineResults.length ? Math.max(...lineResults.map((r) => r.durationMin)) / 60 : 0;

    return `<div class="shift-block${shiftIdx > 0 ? " page-break" : ""}">
      <div class="shift-hdr">
        <div>
          <span class="shift-title">Plating ab ${escapeHtml(date)} &mdash; Fertigstellung: ${escapeHtml(completedOn)}</span>
          <span class="shift-meta">${rows.length} Rezepte &middot; ${fmtInt(shiftTarget)} Port. Soll &middot; ${fmtInt(shiftMapped)} Ist &middot; Offen ${fmtInt(shiftOpen)} &middot; ${shiftUtil}% Auslast.</span>
          <span class="shift-meta">Linien n&ouml;tig: <strong style="color:#fff;">${linesNeeded}</strong> (${fmtInt(PET_PORTIONS_PER_LINE_PER_SHIFT)} Meals/Linie) &middot; Geplante Linien: <strong style="color:#fff;">${lineCount}</strong> &middot; MA-Bedarf Shift: <strong style="color:#fff;">~${fmtInt(shiftStaffNeeded)}</strong> (Submeals&nbsp;+&nbsp;1/Linie) &middot; Parallel ${parallelHours.toFixed(1)}&thinsp;h statt ${avgLineHours.toFixed(1)}&thinsp;h/Linie &middot; Kritische Best-By: <strong style="color:${shiftUrgent > 0 ? "#fca5a5" : "#86efac"};">${shiftUrgent}</strong></span>
          ${shiftAllergenSet.size ? `<span class="shift-meta">Allergene im Shift: ${Array.from(shiftAllergenSet).join(", ")}</span>` : ""}
          <span class="allergen-safety">&#9888; ALLERGEN-SICHERHEIT: bei jedem Meal-Wechsel mit anderen Allergenen Linie vollst&auml;ndig reinigen &middot; ${cleaningTotal > 0 ? `${cleaningTotal} Reinigungswechsel eingeplant` : "keine Reinigungswechsel erforderlich"}</span>
        </div>
      </div>
      <div class="lines-grid" style="grid-template-columns:repeat(${lineCount},1fr);">
        ${lineColumns}
      </div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>PET Plating Plan &mdash; ${runLabel}</title>
<style>
${PRINT_COLOR_FIX}
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4 landscape;margin:10mm 12mm}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#1e293b;background:#fff}
.cover{background:linear-gradient(135deg,#0f172a 0%,#0c4a6e 60%,#0369a1 100%);border-radius:10px;padding:22px 24px 18px;margin-bottom:16px}
.cover-eyebrow{font-size:9px;letter-spacing:.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:6px}
.cover-title{font-size:26px;font-weight:900;color:#fff;letter-spacing:-.02em}
.cover-sub{font-size:13px;color:#bae6fd;margin-top:5px}
.cover-meta{font-size:9px;color:#94a3b8;margin-top:10px;border-top:1px solid rgba(255,255,255,.15);padding-top:8px}
.kpi-row{display:flex;gap:8px;margin-bottom:14px}
.kpi-box{flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:8px 10px;text-align:center}
.kpi-lbl{font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:.1em}
.kpi-val{font-size:20px;font-weight:900;color:#0f172a;margin-top:2px}
.prog-track{height:4px;background:#e2e8f0;border-radius:9px;overflow:hidden;margin-bottom:6px}
.prog-fill{height:100%;background:linear-gradient(90deg,#0ea5e9,#10b981)}
.global-allergens{font-size:9px;color:#334155;margin-bottom:12px}
.shift-block{margin-bottom:16px}
.page-break{page-break-before:always}
.shift-hdr{background:#0f172a;border-radius:8px 8px 0 0;padding:8px 14px}
.shift-title{font-size:12px;font-weight:800;color:#fff;display:block}
.shift-meta{font-size:9px;color:#94a3b8;display:block;margin-top:2px}
.allergen-safety{display:block;margin-top:5px;font-size:9px;color:#fcd34d;font-weight:700}
.lines-grid{display:grid;gap:8px;align-items:start;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:10px;background:#f8fafc}
.line-col{background:#fff;border-radius:6px;border:1px solid #e2e8f0;padding:8px;min-height:60px}
.line-title{font-size:11px;font-weight:800;padding-bottom:3px;display:flex;justify-content:space-between;align-items:baseline;gap:6px;flex-wrap:wrap}
.line-meta{font-size:9px;color:#64748b;font-weight:400;white-space:nowrap}
.line-time{font-size:8px;color:#94a3b8;margin-bottom:6px}
.recipe-card{border-left:3px solid #0ea5e9;border-radius:0 5px 5px 0;background:#fff;border:1px solid #e2e8f0;border-left-width:3px;padding:6px 8px;margin-bottom:5px;page-break-inside:avoid;break-inside:avoid}
.time-row{display:flex;align-items:center;gap:4px;font-size:9px;color:#64748b;margin-bottom:3px}
.time-start{font-weight:800;color:#0f172a}
.time-sep{color:#94a3b8}
.time-end{color:#475569}
.time-dur{margin-left:auto;font-weight:700;color:#0369a1}
.meal-code{font-family:monospace;font-size:11px;font-weight:900;color:#0f172a}
.meal-title{font-size:10px;color:#334155;margin-bottom:3px;overflow-wrap:anywhere}
.meta-row{display:flex;gap:8px;font-size:9px;color:#475569;margin-bottom:3px;flex-wrap:wrap}
.best-by{font-size:9px;color:#475569;margin-bottom:3px}
.best-by.urgent{color:#991b1b;font-weight:800}
.allergen-row{margin-bottom:3px}
.no-allergen{font-size:8px;color:#94a3b8}
.badge{display:inline-block;border-radius:3px;padding:1px 5px;font-size:8px;font-weight:700;margin:1px 1px}
.status-chip{display:inline-block;border-radius:99px;padding:2px 7px;font-size:9px;font-weight:800}
.plating-note{margin-top:5px;padding:4px 7px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:0 3px 3px 0;font-size:9px;color:#166534}
.section-lbl{font-size:8px;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px}
.pack-img{max-width:100%;max-height:90px;object-fit:contain;border:1px solid #e2e8f0;border-radius:4px}
.cleaning-bar{margin:3px 0 6px;padding:4px 8px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:5px;font-size:9px;color:#78350f;font-weight:700}
.empty-line{font-size:9px;color:#94a3b8;text-align:center;padding:12px}
.footer{margin-top:14px;font-size:9px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:8px;display:flex;justify-content:space-between}
</style>
</head>
<body>
<div class="cover">
  <div class="cover-eyebrow">Factor OPS &middot; Verden &middot; PET</div>
  <div class="cover-title">PET Plating &mdash; ${runLabel}</div>
  <div class="cover-sub">ab ${escapeHtml(firstShiftDate)} &middot; ${fmtInt(runRows.length)} Rezepte &middot; ${fmtInt(totalTarget)} Portionen</div>
  <div class="cover-meta">Erstellt: ${escapeHtml(generatedAt)} &nbsp;&middot;&nbsp; Quelle: ${escapeHtml(sourceLabel)}</div>
</div>
<div class="kpi-row">
  <div class="kpi-box"><div class="kpi-lbl">Meal-WOs</div><div class="kpi-val">${fmtInt(runRows.length)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Soll</div><div class="kpi-val">${fmtInt(totalTarget)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Ist</div><div class="kpi-val" style="color:#0369a1;">${fmtInt(totalMapped)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Offen</div><div class="kpi-val" style="color:${totalOpen > 0 ? "#b91c1c" : "#166534"};">${fmtInt(totalOpen)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Fertig</div><div class="kpi-val" style="color:${completion >= 80 ? "#166534" : completion >= 50 ? "#92400e" : "#991b1b"};">${completion}%</div></div>
</div>
<div class="kpi-row">
  <div class="kpi-box"><div class="kpi-lbl">Done</div><div class="kpi-val" style="color:#166534;">${fmtInt(doneCount)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">In Progress</div><div class="kpi-val" style="color:#92400e;">${fmtInt(inProgressCount)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Not Started</div><div class="kpi-val" style="color:#991b1b;">${fmtInt(notStartedCount)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Best-By &lt;48h</div><div class="kpi-val" style="color:${urgentBestByCount > 0 ? "#b91c1c" : "#166534"};">${fmtInt(urgentBestByCount)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Peak Linien / MA</div><div class="kpi-val">${fmtInt(peakLinesNeeded)} / ${fmtInt(peakStaffNeeded)}</div></div>
</div>
<div class="prog-track"><div class="prog-fill" style="width:${completion}%;"></div></div>
${globalAllergens.size ? `<div class="global-allergens">Allergene (Run gesamt): <strong>${Array.from(globalAllergens).join(", ")}</strong></div>` : ""}
${shiftBlocks || `<div class="empty-line">Keine PET-Daten für ${escapeHtml(runLabel)} gefunden.</div>`}
<div class="footer"><span>Factor OPS Planner &middot; PET Plating Plan &middot; ${escapeHtml(runLabel)}</span><span>${escapeHtml(generatedAt)}</span></div>
</body>
</html>`;
}
