// Rundmail – PET-Mail/Präsentations-/Slack-Generatoren (HTML-Strings, keine React-Abhängigkeit).
import type { AllergenDef, PetRow, PlatingNote } from "./rundmailTypes";
import { daySortValue, parseBestByTimestamp, parseDateNeeded } from "./rundmailParsing";
import { detectAllergens, escapeHtml, fmtInt, petStatusTone, toSlack } from "./rundmailFormat";

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

export function buildPetHtmlMail(allPetRows: PetRow[], sourceLabel: string, targetRun: 1 | 2, platingNotes?: Record<string, PlatingNote>): string {
  type EnrichedPetRow = PetRow & {
    status: string;
    bestByText: string;
    bestByTs: number | null;
    open: number;
    ratio: number;
    allergens: AllergenDef[];
  };

  const runRows: EnrichedPetRow[] = allPetRows
    .filter((row) => parseDateNeeded(row.productionShift).run === targetRun)
    .map((row) => {
      const status = row.recipeManualPlatingStatus || row.recipePlatingStatus || "Not Started";
      const bestByText = row.actualBestByDate || row.expiringDatetime || "";
      const bestByTs = parseBestByTimestamp(bestByText);
      const open = toSlack(row.recipeWoTarget - row.recipeWoMapped);
      const ratio = row.recipeWoTarget > 0
        ? Math.max(0, Math.min(100, Math.round((row.recipeWoMapped / row.recipeWoTarget) * 100)))
        : 0;
      const allergens = detectAllergens([
        row.recipeName,
        row.bestBySubRecipeName,
        row.expiringSubRecipeName,
        row.comment,
      ]);
      return {
        ...row,
        status,
        bestByText,
        bestByTs,
        open,
        ratio,
        allergens,
      };
    });

  const shifts = Array.from(new Set(runRows.map((row) => row.productionShift)))
    .sort((a, b) => daySortValue(a) - daySortValue(b));
  const runLabel = `Run ${targetRun}`;
  const nowTs = Date.now();
  const soonLimit = nowTs + 48 * 60 * 60 * 1000;

  const totalTarget = runRows.reduce((sum, row) => sum + row.recipeWoTarget, 0);
  const totalMapped = runRows.reduce((sum, row) => sum + row.recipeWoMapped, 0);
  const totalOpen = runRows.reduce((sum, row) => sum + row.open, 0);
  const completion = totalTarget > 0 ? Math.max(0, Math.min(100, Math.round((totalMapped / totalTarget) * 100))) : 0;
  const doneCount = runRows.filter((row) => row.status.toLowerCase().includes("done") || row.status.toLowerCase().includes("complete")).length;
  const inProgress = runRows.filter((row) => row.status.toLowerCase().includes("in progress")).length;
  const notStarted = runRows.filter((row) => row.status.toLowerCase().includes("not started")).length;
  const urgentBestBy = runRows.filter((row) => row.bestByTs != null && row.bestByTs <= soonLimit).length;
  const globalAllergens = new Set(runRows.flatMap((row) => row.allergens.map((a) => a.label)));
  const generatedAt = new Date().toLocaleString("de-DE");
  const firstShiftDate = shifts.length ? parseDateNeeded(shifts[0]).date : "-";
  const totalSingleLineHours = totalTarget / PET_PORTIONS_PER_LINE_PER_SHIFT;

  const shiftLineNeeds = shifts.map((shift) => {
    const shiftTarget = runRows
      .filter((row) => row.productionShift === shift)
      .reduce((sum, row) => sum + row.recipeWoTarget, 0);
    return shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
  });
  const peakLinesNeeded = shiftLineNeeds.length ? Math.max(...shiftLineNeeds) : 0;
  const peakStaffNeeded = shifts.length
    ? Math.max(...shifts.map((shift) => {
      const shiftRows = runRows.filter((row) => row.productionShift === shift).length;
      const shiftTarget = runRows
        .filter((row) => row.productionShift === shift)
        .reduce((sum, row) => sum + row.recipeWoTarget, 0);
      const neededLines = shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
      const lineCount = neededLines > 2 ? 3 : 2;
      return shiftRows + lineCount;
    }))
    : 0;

  function allergenSignature(row: EnrichedPetRow): string {
    return row.allergens.map((a) => a.label).sort().join("|") || "none";
  }

  function linePlacementScore(
    lineRows: EnrichedPetRow[],
    allLineTargets: number[],
    lineIndex: number,
    candidate: EnrichedPetRow
  ): number {
    const last = lineRows.at(-1);
    const currentSig = last ? allergenSignature(last) : "";
    const nextSig = allergenSignature(candidate);
    const allergenSwitchPenalty = last && currentSig !== nextSig ? 3 : 0;

    const projectedTargets = allLineTargets.map((value, idx) =>
      idx === lineIndex ? value + candidate.recipeWoTarget : value
    );
    const projectedTarget = projectedTargets[lineIndex];
    const projectedGap = Math.max(...projectedTargets) - Math.min(...projectedTargets);
    const balancePenalty = projectedGap / PET_PORTIONS_PER_LINE_PER_SHIFT;

    const overflow = Math.max(0, projectedTarget - PET_PORTIONS_PER_LINE_PER_SHIFT);
    const overflowPenalty = (overflow / PET_PORTIONS_PER_LINE_PER_SHIFT) * 2;

    return allergenSwitchPenalty + balancePenalty + overflowPenalty;
  }

  function renderAllergenBadges(row: EnrichedPetRow): string {
    return row.allergens.map((a) =>
      `<span style="display:inline-block;background:${a.bg};color:${a.text};border:1px solid ${a.border};border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin:1px 2px;">${escapeHtml(a.label)}</span>`
    ).join("") || `<span style="font-size:10px;color:#94a3b8;">–</span>`;
  }

  function renderLineWithCleaning(lineRows: EnrichedPetRow[], color: string): { html: string; cleaningCount: number; totalMinutes: number } {
    let cleaningCount = 0;
    let cursorMinutes = PET_LINE_START_HOUR * 60;
    const html = lineRows.map((row, idx) => {
      const open = row.open;
      const tone = petStatusTone(row.status);
      const bestByUrgent = row.bestByTs != null && row.bestByTs <= soonLimit;
      const bestBy = row.bestByText || "-";
      const bestByName = row.bestBySubRecipeName || row.expiringSubRecipeName || "-";
      const mealCode = extractMealCode(row.recipeName);
      const mealTitle = row.recipeName.replace(/\s*\[.*?\]/g, "").replace(/^FV\d{4}[A-Z]\s*-\s*/i, "").trim();
      const durationHours = row.recipeWoTarget / PET_PORTIONS_PER_LINE_PER_SHIFT;
      const durationMinutes = Math.max(10, Math.round(durationHours * 60));
      const timeStart = cursorMinutes;
      const timeEnd = cursorMinutes + durationMinutes;
      cursorMinutes = timeEnd;
      const note = platingNotes?.[mealCode];
      const noteHtml = note?.instruction
        ? `<div style="margin-top:5px;padding:5px 8px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:0 4px 4px 0;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#166534;"><strong>Plating:</strong> ${escapeHtml(note.instruction)}</div>`
        : "";
      const imageHtml = note?.packSchemaImageDataUrl
        ? `<div style="margin-top:5px;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px;">Packschema</div><img src="${note.packSchemaImageDataUrl}" alt="Packschema ${escapeHtml(mealCode)}" style="max-width:100%;max-height:110px;object-fit:contain;border:1px solid #e2e8f0;border-radius:4px;"></div>`
        : "";
      const card = `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-left:3px solid ${color};border-radius:0 8px 8px 0;background:#ffffff;margin-bottom:6px;">
        <tr>
          <td width="84" style="padding:8px 6px 8px 8px;border-right:1px dashed #e2e8f0;vertical-align:top;background:#f8fafc;">
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;color:#0f172a;text-align:center;">${formatClock(timeStart)}</div>
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-align:center;">bis ${formatClock(timeEnd)}</div>
            <div style="margin-top:4px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:700;color:#0369a1;text-align:center;">${durationHours.toFixed(1)} h</div>
          </td>
          <td style="padding:8px 10px;vertical-align:top;">
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:800;color:#0f172a;">${escapeHtml(mealCode)} &middot; ${escapeHtml(mealTitle || row.recipeName)}</div>
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#475569;margin-top:3px;">WO ${escapeHtml(row.recipeWo)} &middot; SOLL ${fmtInt(row.recipeWoTarget)} &middot; IST ${fmtInt(row.recipeWoMapped)} &middot; Gap <strong style="color:${open > 0 ? "#92400e" : "#166534"};">${fmtInt(open)}</strong> &middot; Fill ${row.ratio}%</div>
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;margin-top:3px;">Best By: <span style="color:${bestByUrgent ? "#991b1b" : "#334155"};font-weight:${bestByUrgent ? "800" : "600"};">${bestByUrgent ? "⚠ " : ""}${escapeHtml(bestBy)}</span> &middot; Sub: ${escapeHtml(bestByName)}</div>
            <div style="margin-top:4px;">${renderAllergenBadges(row)}</div>
            <div style="margin-top:4px;"><span style="display:inline-block;background:${tone.bg};color:${tone.text};border:1px solid ${tone.border};border-radius:999px;padding:2px 8px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;white-space:nowrap;">${escapeHtml(row.status)}</span></div>
            ${noteHtml}${imageHtml}
          </td>
        </tr>
      </table>`;

      if (idx >= lineRows.length - 1) return card;

      const cur = new Set(row.allergens.map((a) => a.label));
      const nxt = new Set(lineRows[idx + 1].allergens.map((a) => a.label));
      const removed = [...cur].filter((label) => !nxt.has(label));
      const added = [...nxt].filter((label) => !cur.has(label));
      const hasChange = removed.length > 0 || added.length > 0;
      if (!hasChange) return card;

      cleaningCount += 1;
      const changeText = [
        removed.length ? `entfernt: <strong>${removed.join(", ")}</strong>` : "",
        added.length ? `neu: <strong>${added.join(", ")}</strong>` : "",
      ].filter(Boolean).join(" &middot; ");

      return card + `<div style="margin:3px 0 7px 0;padding:6px 10px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:6px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#78350f;font-weight:700;">⚠ LINIE REINIGEN &mdash; Allergen-Wechsel: ${changeText}</div>`;
    }).join("");

    return { html, cleaningCount, totalMinutes: Math.max(0, cursorMinutes - PET_LINE_START_HOUR * 60) };
  }

  const shiftTables = shifts.map((shift) => {
    const rows = runRows
      .filter((row) => row.productionShift === shift)
      .sort((a, b) => {
        if (a.bestByTs != null && b.bestByTs != null && a.bestByTs !== b.bestByTs) return a.bestByTs - b.bestByTs;
        if (a.bestByTs != null && b.bestByTs == null) return -1;
        if (a.bestByTs == null && b.bestByTs != null) return 1;
        return b.open - a.open;
      });

    const shiftTarget = rows.reduce((sum, row) => sum + row.recipeWoTarget, 0);
    const shiftMapped = rows.reduce((sum, row) => sum + row.recipeWoMapped, 0);
    const shiftOpen = rows.reduce((sum, row) => sum + row.open, 0);
    const shiftLinesNeeded = shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
    const lineCount = shiftLinesNeeded > 2 ? 3 : 2;
    const lines: EnrichedPetRow[][] = Array.from({ length: lineCount }, () => []);
    const lineTargets = Array.from({ length: lineCount }, () => 0);

    for (const row of rows) {
      let bestLine = 0;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let idx = 0; idx < lineCount; idx += 1) {
        const score = linePlacementScore(lines[idx], lineTargets, idx, row);
        const tieBreaker = lineTargets[idx] / PET_PORTIONS_PER_LINE_PER_SHIFT;
        const weightedScore = score + tieBreaker * 0.001;
        if (weightedScore < bestScore) {
          bestScore = weightedScore;
          bestLine = idx;
        }
      }
      lines[bestLine].push(row);
      lineTargets[bestLine] += row.recipeWoTarget;
    }
    const shiftStaffNeeded = rows.length + lineCount;
    const shiftAllergenSet = new Set(rows.flatMap((row) => row.allergens.map((a) => a.label)));
    const shiftUrgent = rows.filter((row) => row.bestByTs != null && row.bestByTs <= soonLimit).length;
    const shiftUtil = shiftLinesNeeded > 0
      ? Math.min(100, Math.round((shiftTarget / (shiftLinesNeeded * PET_PORTIONS_PER_LINE_PER_SHIFT)) * 100))
      : 0;

    const lineColors = ["#0ea5e9", "#10b981", "#f59e0b"];
    const renderedLines = lines.map((lineRows, idx) => ({
      rendered: renderLineWithCleaning(lineRows, lineColors[idx]),
      staffNeeded: lineRows.length + 1,
      target: lineTargets[idx],
    }));
    const cleaningTotal = renderedLines.reduce((sum, item) => sum + item.rendered.cleaningCount, 0);
    const parallelHours = renderedLines.length
      ? Math.max(...renderedLines.map((item) => item.rendered.totalMinutes)) / 60
      : 0;
    const avgLineHours = lineCount > 0 ? shiftTarget / (lineCount * PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
    const completedOn = oneDayBefore(parseDateNeeded(shift).date);
    const lineWidth = `${(100 / lineCount).toFixed(2)}%`;
    const lineColumns = renderedLines.map((item, idx) => `
                <td width="${lineWidth}" style="vertical-align:top;${idx < lineCount - 1 ? "padding-right:8px;border-right:1px solid #e2e8f0;" : "padding-left:8px;"}">
                  <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;color:${lineColors[idx]};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:2px;">Linie ${idx + 1} &mdash; ${fmtInt(item.target)} Portionen &mdash; ${(item.rendered.totalMinutes / 60).toFixed(1)} h &mdash; ~${fmtInt(item.staffNeeded)} MA</div>
                  <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;margin-bottom:6px;">Start ${formatClock(PET_LINE_START_HOUR * 60)} &middot; Ende ${formatClock(PET_LINE_START_HOUR * 60 + item.rendered.totalMinutes)}</div>
                  ${item.rendered.html || `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#94a3b8;">–</div>`}
                  <div style="margin-top:6px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;">Linie ${idx + 1} Auslastung</div>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:2px;"><tr><td width="${Math.max(0, Math.min(100, Math.round((item.target / PET_PORTIONS_PER_LINE_PER_SHIFT) * 100)))}%" style="height:5px;background:#10b981;border-radius:4px;"></td><td style="height:5px;background:#e2e8f0;"></td></tr></table>
                </td>`).join("");

    return `
    <tr><td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#ffffff;">
        <tr><td style="background:#1e293b;padding:10px 12px;">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;font-weight:900;color:#f8fafc;">Plating ab ${escapeHtml(parseDateNeeded(shift).date)} &mdash; ${runLabel}</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#fde68a;margin-top:3px;">Fertigstellung: ${escapeHtml(completedOn)} &middot; ${rows.length} Rezepte &middot; ${fmtInt(shiftTarget)} Portionen &middot; ~${fmtInt(shiftStaffNeeded)} MA empfohlen (${lineCount} Linien)</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;margin-top:3px;">Meal-WOs: ${rows.length} &middot; SOLL ${fmtInt(shiftTarget)} &middot; IST ${fmtInt(shiftMapped)} &middot; Gap ${fmtInt(shiftOpen)} &middot; Auslastung ${shiftUtil}% &middot; Parallel ${parallelHours.toFixed(1)} h statt ${avgLineHours.toFixed(1)} h / Linie</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#c7d2fe;margin-top:3px;">Linien n&ouml;tig: <strong style="color:#ffffff;">${shiftLinesNeeded}</strong> (${fmtInt(PET_PORTIONS_PER_LINE_PER_SHIFT)} Meals/Linie) &middot; Geplante Linien: <strong style="color:#ffffff;">${lineCount}</strong> (2 Standard, optional 3) &middot; MA-Bedarf Shift: <strong style="color:#ffffff;">${shiftStaffNeeded}</strong> (Submeals + 1 je Linie) &middot; Kritische Best-By: <strong style="color:${shiftUrgent > 0 ? "#fca5a5" : "#86efac"};">${shiftUrgent}</strong></div>
          ${shiftAllergenSet.size ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#e2e8f0;margin-top:3px;">Allergene im Shift: ${Array.from(shiftAllergenSet).join(", ")}</div>` : ""}
          <div style="margin-top:8px;padding:8px 10px;background:#fef3c7;border:1px solid #d97706;border-radius:8px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#78350f;font-weight:700;">⚠ ALLERGEN-SICHERHEIT: Bei jedem Meal-Wechsel mit anderen Allergenen Linie vollst&auml;ndig reinigen. Gleiche Allergene wurden geb&uuml;ndelt, um Wechsel zu minimieren.</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${cleaningTotal > 0 ? "#fcd34d" : "#86efac"};margin-top:3px;">${cleaningTotal > 0 ? `⚠ ${cleaningTotal} Reinigungswechsel eingeplant` : "✓ Keine Reinigungswechsel erforderlich"}</div>
        </td></tr>
        <tr>
          <td style="padding:10px 12px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                ${lineColumns}
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>`;
  }).join("");

  return `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>PET-Plating Plan ${runLabel}</title>
<style>@media print{body{background:#fff!important;padding:0!important}table{page-break-inside:avoid}@page{size:A4 landscape;margin:8mm}}</style>
</head>
<body style="margin:0;padding:16px;background:#cbd5e1;font-family:Segoe UI,Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:980px;margin:0 auto;">
  <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#0369a1 100%);border-radius:16px 16px 0 0;padding:28px 28px 22px 28px;">
    <div style="font-size:10px;letter-spacing:0.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:8px;">Factor OPS &middot; Verden &middot; PET</div>
    <div style="font-size:30px;font-weight:900;color:#ffffff;line-height:1.05;letter-spacing:-0.02em;">Plating ab ${escapeHtml(firstShiftDate)} &mdash; ${runLabel}</div>
    <div style="font-size:15px;color:#bae6fd;margin-top:6px;">${fmtInt(runRows.length)} Rezepte &middot; ${fmtInt(totalTarget)} Portionen &middot; Parallel ~${(totalSingleLineHours / Math.max(1, peakLinesNeeded || 2)).toFixed(1)} h ab ${formatClock(PET_LINE_START_HOUR * 60)}</div>
    <div style="margin-top:14px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.2);font-size:11px;color:#cbd5e1;">Erstellt: ${escapeHtml(generatedAt)} &nbsp;&middot;&nbsp; Quelle: ${escapeHtml(sourceLabel)}</div>
  </td></tr>

  <tr><td style="background:#ffffff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Meal-WOs</div><div style="font-size:26px;font-weight:900;color:#0f172a;">${runRows.length}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">SOLL</div><div style="font-size:26px;font-weight:900;color:#0f172a;">${fmtInt(totalTarget)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">IST</div><div style="font-size:26px;font-weight:900;color:#0369a1;">${fmtInt(totalMapped)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Gap</div><div style="font-size:26px;font-weight:900;color:${totalOpen > 0 ? "#92400e" : "#166534"};">${fmtInt(totalOpen)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Done</div><div style="font-size:26px;font-weight:900;color:#166534;">${fmtInt(doneCount)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">In Progress</div><div style="font-size:26px;font-weight:900;color:#92400e;">${fmtInt(inProgress)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Not Started</div><div style="font-size:26px;font-weight:900;color:#991b1b;">${fmtInt(notStarted)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Best-By &lt;48h</div><div style="font-size:26px;font-weight:900;color:${urgentBestBy > 0 ? "#b91c1c" : "#166534"};">${fmtInt(urgentBestBy)}</div></td>
        <td style="padding:14px 16px;text-align:center;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Peak Linien / MA</div><div style="font-size:20px;font-weight:900;color:#0f172a;">${fmtInt(peakLinesNeeded)} / ${fmtInt(peakStaffNeeded)}</div></td>
      </tr>
    </table>
    <div style="padding:0;"><table width="100%" cellspacing="0" cellpadding="0"><tr><td width="${completion}%" style="height:5px;background:linear-gradient(90deg,#0ea5e9,#10b981);"></td>${completion < 100 ? `<td style="height:5px;background:#e2e8f0;"></td>` : ""}</tr></table></div>
    <div style="padding:8px 16px 10px 16px;border-top:1px solid #e2e8f0;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;">Priorisierung: 1) fr&uuml;hestes Best By, 2) h&ouml;chster Gap &middot; Kapazit&auml;t je Linie: ${fmtInt(PET_PORTIONS_PER_LINE_PER_SHIFT)} Meals &middot; MA-Formel: Submeals + 1 &middot; Reinigungswechsel zwischen allergen-kritischen Meals automatisch markiert</div>
    ${globalAllergens.size ? `<div style="padding:0 16px 10px 16px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#334155;">Allergene (Run gesamt): <strong>${Array.from(globalAllergens).join(", ")}</strong></div>` : ""}
  </td></tr>

  <tr><td style="background:#ffffff;padding:18px 24px 8px 24px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;border-top:2px solid #e2e8f0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:14px;"><tr><td style="border-left:4px solid #0ea5e9;padding-left:10px;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;font-weight:800;color:#0f172a;text-transform:uppercase;letter-spacing:0.1em;">PET Plating Linienplan</div><div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#64748b;margin-top:2px;">Wie im KET-Plating: Linien, Allergene, Reinigungen, MA</div></td></tr></table>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${shiftTables || `<tr><td style="padding:16px 12px;border:1px dashed #cbd5e1;border-radius:10px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:#64748b;">Keine PET-Daten f&uuml;r ${runLabel} gefunden.</td></tr>`}</table>
  </td></tr>

  <tr><td style="background:#f1f5f9;border-radius:0 0 16px 16px;padding:16px 24px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="font-size:11px;color:#64748b;"><strong style="color:#0f172a;">Factor OPS Planner</strong> &middot; PET Plating Report</td><td align="right" style="font-size:10px;color:#94a3b8;white-space:nowrap;">${escapeHtml(sourceLabel)}</td></tr></table>
  </td></tr>
</table>
</body>
</html>`;
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

    const lineColumns = lines.map((lineRows, lineIdx) => {
      let cursorMin = PET_LINE_START_HOUR * 60;
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
          : `<span style="font-size:8px;color:#94a3b8;">–</span>`;

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

      return `<div class="line-col">
        <div class="line-title" style="border-bottom:3px solid ${lineColor};color:${lineColor};">
          ${LINE_NAMES[lineIdx] ?? `Linie ${lineIdx + 1}`}
          <span class="line-meta">${fmtInt(lineTargets[lineIdx])} Port.</span>
        </div>
        ${cards || `<div class="empty-line">Keine Rezepte</div>`}
      </div>`;
    }).join("");

    return `<div class="shift-block${shiftIdx > 0 ? " page-break" : ""}">
      <div class="shift-hdr">
        <div>
          <span class="shift-title">Plating ab ${escapeHtml(date)} &mdash; Fertigstellung: ${escapeHtml(completedOn)}</span>
          <span class="shift-meta">${rows.length} Rezepte &middot; ${fmtInt(shiftTarget)} Port. Soll &middot; ${fmtInt(shiftMapped)} Ist &middot; Offen ${fmtInt(shiftOpen)} &middot; ${shiftUtil}% Auslast.</span>
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
<title>PET Plating Präsentation &mdash; ${runLabel}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4 landscape;margin:10mm 12mm}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#1e293b;background:#fff}
.cover{background:linear-gradient(135deg,#0f172a 0%,#0c4a6e 60%,#0369a1 100%);border-radius:10px;padding:22px 24px 18px;margin-bottom:16px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover-eyebrow{font-size:9px;letter-spacing:.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:6px}
.cover-title{font-size:26px;font-weight:900;color:#fff;letter-spacing:-.02em}
.cover-sub{font-size:13px;color:#bae6fd;margin-top:5px}
.cover-meta{font-size:9px;color:#94a3b8;margin-top:10px;border-top:1px solid rgba(255,255,255,.15);padding-top:8px}
.kpi-row{display:flex;gap:8px;margin-bottom:14px}
.kpi-box{flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:8px 10px;text-align:center}
.kpi-lbl{font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:.1em}
.kpi-val{font-size:20px;font-weight:900;color:#0f172a;margin-top:2px}
.prog-track{height:4px;background:#e2e8f0;border-radius:9px;overflow:hidden;margin-bottom:14px}
.prog-fill{height:100%;background:linear-gradient(90deg,#0ea5e9,#10b981);-webkit-print-color-adjust:exact;print-color-adjust:exact}
.shift-block{margin-bottom:16px}
.page-break{page-break-before:always}
.shift-hdr{background:#0f172a;border-radius:8px 8px 0 0;padding:8px 14px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.shift-title{font-size:12px;font-weight:800;color:#fff;display:block}
.shift-meta{font-size:9px;color:#94a3b8;display:block;margin-top:2px}
.lines-grid{display:grid;gap:8px;align-items:start;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:10px;background:#f8fafc}
.line-col{background:#fff;border-radius:6px;border:1px solid #e2e8f0;padding:8px;min-height:60px}
.line-title{font-size:11px;font-weight:800;padding-bottom:5px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
.line-meta{font-size:9px;color:#64748b;font-weight:400}
.recipe-card{border-left:3px solid #0ea5e9;border-radius:0 5px 5px 0;background:#fff;border:1px solid #e2e8f0;border-left-width:3px;padding:6px 8px;margin-bottom:5px}
.time-row{display:flex;align-items:center;gap:4px;font-size:9px;color:#64748b;margin-bottom:3px}
.time-start{font-weight:800;color:#0f172a}
.time-sep{color:#94a3b8}
.time-end{color:#475569}
.time-dur{margin-left:auto;font-weight:700;color:#0369a1}
.meal-code{font-family:monospace;font-size:11px;font-weight:900;color:#0f172a}
.meal-title{font-size:10px;color:#334155;margin-bottom:3px}
.meta-row{display:flex;gap:8px;font-size:9px;color:#475569;margin-bottom:3px}
.best-by{font-size:9px;color:#475569;margin-bottom:3px}
.best-by.urgent{color:#991b1b;font-weight:800}
.allergen-row{margin-bottom:3px}
.badge{display:inline-block;border-radius:3px;padding:1px 5px;font-size:8px;font-weight:700;margin:1px 1px}
.status-chip{display:inline-block;border-radius:99px;padding:2px 7px;font-size:9px;font-weight:800;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.plating-note{margin-top:5px;padding:4px 7px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:0 3px 3px 0;font-size:9px;color:#166534;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.section-lbl{font-size:8px;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px}
.pack-img{max-width:100%;max-height:90px;object-fit:contain;border:1px solid #e2e8f0;border-radius:4px}
.cleaning-bar{margin:3px 0 6px;padding:4px 8px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:5px;font-size:9px;color:#78350f;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.empty-line{font-size:9px;color:#94a3b8;text-align:center;padding:12px}
.footer{margin-top:14px;font-size:9px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:8px}
@media print{body{background:#fff}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}.page-break{page-break-before:always}}
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
<div class="prog-track"><div class="prog-fill" style="width:${completion}%;"></div></div>
${shiftBlocks}
<div class="footer">Factor OPS Planner &middot; PET Plating Präsentation &middot; ${escapeHtml(runLabel)} &middot; ${escapeHtml(generatedAt)}</div>
</body>
</html>`;
}


export function buildPetSlackBlocks(petRows: PetRow[], sourceLabel: string, run: 1 | 2): object {
  const runRows = petRows.filter((r) => parseDateNeeded(r.productionShift).run === run);
  const totalTarget = runRows.reduce((s, r) => s + r.recipeWoTarget, 0);
  const totalMapped = runRows.reduce((s, r) => s + r.recipeWoMapped, 0);
  const totalOpen = runRows.reduce((s, r) => s + toSlack(r.recipeWoTarget - r.recipeWoMapped), 0);
  const doneCount = runRows.filter((r) => (r.recipeManualPlatingStatus || r.recipePlatingStatus || "").toLowerCase().includes("done")).length;
  const inProgressCount = runRows.filter((r) => (r.recipeManualPlatingStatus || r.recipePlatingStatus || "").toLowerCase().includes("in progress")).length;
  const notStartedCount = runRows.filter((r) => {
    const s = (r.recipeManualPlatingStatus || r.recipePlatingStatus || "Not Started").toLowerCase();
    return s.includes("not started") || (!s.includes("done") && !s.includes("in progress"));
  }).length;

  const shifts = Array.from(new Set(runRows.map((r) => r.productionShift))).sort((a, b) => daySortValue(a) - daySortValue(b));
  const generatedAt = new Date().toLocaleString("de-DE");

  const shiftSections = shifts.map((shift) => {
    const shiftRows = runRows.filter((r) => r.productionShift === shift);
    const { date } = parseDateNeeded(shift);
    const shiftTarget = shiftRows.reduce((s, r) => s + r.recipeWoTarget, 0);
    const shiftMapped = shiftRows.reduce((s, r) => s + r.recipeWoMapped, 0);
    const allergenSet = new Set(shiftRows.flatMap((r) => detectAllergens([r.recipeName, r.bestBySubRecipeName, r.expiringSubRecipeName]).map((a) => a.label)));
    const allergenStr = allergenSet.size ? [...allergenSet].join(", ") : "keine";
    const mealLines = shiftRows.map((r) => {
      const status = r.recipeManualPlatingStatus || r.recipePlatingStatus || "Not Started";
      const gap = toSlack(r.recipeWoTarget - r.recipeWoMapped);
      const emoji = status.toLowerCase().includes("done") ? "\u2705" : status.toLowerCase().includes("in progress") ? "\uD83D\uDD04" : "\u2B1C";
      return `${emoji} *${escapeHtml(r.recipeName)}* \u2014 SOLL ${r.recipeWoTarget.toLocaleString("de-DE")} | IST ${r.recipeWoMapped.toLocaleString("de-DE")} | Gap ${gap.toLocaleString("de-DE")}`;
    });
    const linesNeeded = shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
    const lineCount = linesNeeded > 2 ? 3 : 2;
    const staffNeeded = shiftRows.length + lineCount;

    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*\uD83D\uDCC5 Plating ab ${date} \u2014 Run ${run}*\nSoll ${shiftTarget.toLocaleString("de-DE")} | IST ${shiftMapped.toLocaleString("de-DE")} | Linien ${lineCount} | MA ~${staffNeeded}\nAllergene: ${allergenStr}`,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: mealLines.join("\n") || "_Keine Rezepte_" } },
      { type: "divider" },
    ];
  });

  return {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `PET Plating \u2014 Run ${run}`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*SOLL*\n${totalTarget.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*IST*\n${totalMapped.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*Gap*\n${totalOpen.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*Status*\n\u2705 ${doneCount} Done \u00B7 \uD83D\uDD04 ${inProgressCount} Running \u00B7 \u2B1C ${notStartedCount} Offen` },
        ],
      },
      { type: "divider" },
      ...shiftSections.flat(),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Erstellt: ${generatedAt} \u00B7 Quelle: ${sourceLabel}` }],
      },
    ],
  };
}

