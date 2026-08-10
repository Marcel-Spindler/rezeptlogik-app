// Rundmail – KET-Mail/Präsentations-/Slack-Generatoren (HTML-Strings, keine React-Abhängigkeit).
import { DAY_LABEL_TO_WEEKDAY } from "./rundmailTypes";
import type { AllergenDef, RundmailRow, WeeklyPlanningData } from "./rundmailTypes";
import { daySortValue, parseDateNeeded } from "./rundmailParsing";
import { detectAllergens, escapeHtml, fmtInt, toSlack } from "./rundmailFormat";

export function buildRun1Mail(run1Rows: RundmailRow[]): string {
  const run1Days = Array.from(new Set(run1Rows.map((row) => row.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));
  const totalTarget = run1Rows.reduce((sum, row) => sum + row.targetPortions, 0);
  const totalCooked = run1Rows.reduce((sum, row) => sum + row.woCookedPortions, 0);
  const totalOpen = run1Rows.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);
  const totalBatches = run1Rows.reduce((sum, row) => sum + (row.batchesNeeded ?? 0), 0);

  const lines: string[] = [];
  lines.push("# RUN1 Rundmail Produktion");
  lines.push("");
  lines.push("## Executive Summary");
  lines.push(`- RUN1 Work Orders: ${run1Rows.length}`);
  lines.push(`- RUN1 Ziel gesamt: ${fmtInt(totalTarget)}`);
  lines.push(`- RUN1 Gekocht gesamt: ${fmtInt(totalCooked)}`);
  lines.push(`- RUN1 Offener Bedarf: ${fmtInt(totalOpen)}`);
  lines.push(`- RUN1 Batches gesamt: ${fmtInt(totalBatches)}`);
  lines.push("");

  run1Days.forEach((day) => {
    const rows = run1Rows.filter((row) => row.dateNeeded === day);
    const target = rows.reduce((sum, row) => sum + row.targetPortions, 0);
    const cooked = rows.reduce((sum, row) => sum + row.woCookedPortions, 0);
    const open = rows.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);
    const dayBatches = rows.reduce((sum, row) => sum + (row.batchesNeeded ?? 0), 0);

    const critical = rows
      .map((row) => ({ row, deficit: toSlack(row.targetPortions - row.woCookedPortions) }))
      .filter((item) => item.deficit > 0)
      .sort((a, b) => b.deficit - a.deficit)
      .slice(0, 5);

    const blocked = rows.filter((row) => {
      const status = row.kitchenStatus.toLowerCase();
      return status.includes("not started") || status.includes("open") || status.includes("allocation");
    });

    lines.push(`## ${day}`);
    lines.push(`- Work Orders: ${rows.length}`);
    lines.push(`- Ziel: ${fmtInt(target)} | Gekocht: ${fmtInt(cooked)} | Offen: ${fmtInt(open)}`);
    lines.push(`- Batches: ${fmtInt(dayBatches)}`);
    lines.push(`- Blocked/Open Positionen: ${blocked.length}`);

    if (critical.length) {
      lines.push("- Kritische Defizite:");
      critical.forEach(({ row, deficit }) => {
        const hint = row.workOrderComment ? ` | Hinweis: ${row.workOrderComment}` : "";
        const batchesText = row.batchesNeeded != null ? ` | Batches ${fmtInt(row.batchesNeeded)}` : "";
        lines.push(`  - WO ${row.workOrderNumber} | ${row.subRecipeName} | Fehlmenge ${fmtInt(deficit)}${batchesText}${hint}`);
      });
    } else {
      lines.push("- Kritische Defizite: keine");
    }

    lines.push("");
  });

  lines.push(`_${new Date().toLocaleString("de-DE")}_`);

  return lines.join("\n");
}

// ── Colour palette (shared across sections) ──────────────────────────────────
export const C = {
  navy: "#0f172a", navyMid: "#1e293b", navyLight: "#334155",
  sky: "#0ea5e9", skyDark: "#0369a1",
  emerald: "#10b981", emeraldDark: "#166534", emeraldBg: "#f0fdf4",
  amber: "#f59e0b", amberDark: "#92400e", amberBg: "#fffbeb",
  red: "#ef4444", redDark: "#991b1b", redBg: "#fef2f2",
  slate: "#64748b", slateLight: "#94a3b8", slateBg: "#f8fafc",
  border: "#e2e8f0", white: "#ffffff",
};

export function buildRunHtmlMail(allRows: RundmailRow[], sourceLabel: string, weeklyPlanning: WeeklyPlanningData | null | undefined, targetRun: 1 | 2, toolLinks: { whatIf: string; breakdown: string } = { whatIf: "", breakdown: "" }): string {
  const isTargetRun = (dateNeeded: string) => parseDateNeeded(dateNeeded).run === targetRun;
  const targetRunRows = allRows.filter((row) => isTargetRun(row.dateNeeded));
  // Küchen-Plan nur für diesen Run; alle Tage/Runs für den kompletten Plan-Kontext
  const allDays = Array.from(new Set(allRows.filter(r => isTargetRun(r.dateNeeded)).map((row) => row.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));

  const timelineCards = allDays.map(day => {
    const dayRows = allRows.filter(r => r.dateNeeded === day);
    const seen = new Map<string, RundmailRow>();
    dayRows.forEach(row => {
      const prev = seen.get(row.recipeId);
      if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
    });
    const deduped = Array.from(seen.values());
    const target = deduped.reduce((s, r) => s + r.targetPortions, 0);
    const cooked = deduped.reduce((s, r) => s + r.woCookedPortions, 0);
    const open = deduped.reduce((s, r) => s + toSlack(r.targetPortions - r.woCookedPortions), 0);
    return { day, count: dayRows.length, target, cooked, open };
  });

  // Deduplizierung: Portionen nur einmal pro Rezept zählen
  const dedupedRun = Array.from(
    new Map(targetRunRows.map(r => [r.recipeId, r])).values()
  );
  const totalTarget = dedupedRun.reduce((sum, row) => sum + row.targetPortions, 0);
  const totalCooked = dedupedRun.reduce((sum, row) => sum + row.woCookedPortions, 0);
  const totalOpen = dedupedRun.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);
  const totalBatches = targetRunRows.reduce((sum, row) => sum + (row.batchesNeeded ?? 0), 0);
  const completion = totalTarget > 0 ? Math.max(0, Math.min(100, Math.round((totalCooked / totalTarget) * 100))) : 0;
  const generatedAt = new Date().toLocaleString("de-DE");
  const runLabel = `Run ${targetRun}`;

  const WHAT_IF_URL = toolLinks.whatIf || "#";
  const BREAKDOWN_URL = toolLinks.breakdown || "#";

  // Section A: Küchen-Plan (all days/runs)
  const kitchenPlanHtml = allDays.map((day) => {
    const dayRows = allRows.filter((row) => row.dateNeeded === day);
    const { date, run } = parseDateNeeded(day);

    // Deduplizierung: Target nur einmal pro Rezept zählen
    const recipeMap = new Map<string, { rows: typeof dayRows; target: number; allergens: ReturnType<typeof detectAllergens> }>();
    dayRows.forEach((row) => {
      const existing = recipeMap.get(row.recipeId);
      if (existing) {
        existing.rows.push(row);
      } else {
        recipeMap.set(row.recipeId, {
          rows: [row],
          target: row.targetPortions,
          allergens: detectAllergens([row.recipeName, row.subRecipeName]),
        });
      }
    });
    // Allergene über alle Sub-Rezepte eines Rezepts sammeln
    recipeMap.forEach((entry, id) => {
      entry.allergens = detectAllergens([entry.rows[0].recipeName, ...entry.rows.map(r => r.subRecipeName)]);
      recipeMap.set(id, entry);
    });

    const dayTarget = Array.from(recipeMap.values()).reduce((s, e) => s + e.target, 0);
    const dayBatches = dayRows.reduce((sum, row) => sum + (row.batchesNeeded ?? 0), 0);
    const uniqueRecipeCount = recipeMap.size;
    const totalSubCount = dayRows.length;

    const recipeSections = Array.from(recipeMap.values()).map((recipe, ri) => {
      const firstRow = recipe.rows[0];
      const allergenBadges = recipe.allergens.map(a =>
        `<span style="display:inline-block;background:${a.bg};color:${a.text};border:1px solid ${a.border};border-radius:3px;padding:1px 5px;font-size:10px;font-weight:700;margin:1px 2px;">${escapeHtml(a.label)}</span>`
      ).join("") || `<span style="font-size:10px;color:#94a3b8;">keine bekannten Allergene</span>`;
      const hasFish = recipe.allergens.some(a => a.label === "Fisch");
      const recipeHeaderBg = ri % 2 === 0 ? "#f8fafc" : "#f1f5f9";

      const subRows = recipe.rows.map((row) => `
        <tr>
          <td style="padding:5px 8px 5px 20px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#334155;white-space:nowrap;">WO&nbsp;${escapeHtml(row.workOrderNumber)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#0f172a;">${escapeHtml(row.subRecipeName)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#334155;text-align:right;white-space:nowrap;">${fmtInt(row.targetPortions)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#334155;text-align:right;white-space:nowrap;">${row.kitchenKg != null ? fmtInt(row.kitchenKg) : "–"}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#4338ca;font-weight:700;text-align:right;white-space:nowrap;">${row.batchesNeeded != null ? fmtInt(row.batchesNeeded) : "–"}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#64748b;">${escapeHtml(row.cookMethods || "–")}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:${row.kitchenStatus?.toLowerCase().includes("not started") ? "#991b1b" : row.kitchenStatus?.toLowerCase().includes("post blast") ? "#166534" : "#334155"};white-space:nowrap;">${escapeHtml(row.kitchenStatus || "–")}</td>
        </tr>`).join("");

      return `
        <tr style="background:${recipeHeaderBg};">
          <td colspan="7" style="padding:7px 10px 5px 10px;border-top:1px solid #e2e8f0;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
              <td>
                <span style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:800;color:#0f172a;">${escapeHtml(firstRow.recipeName.replace(/\s*\[.*?\]/g, ""))}</span>
                <span style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;margin-left:8px;">${escapeHtml(firstRow.recipeId)} &middot; ${fmtInt(recipe.target)} Portionen &middot; ${recipe.rows.length} Sub-Rezepte &middot; <strong style="color:#0f172a;">${recipe.rows.length + 1} MA</strong></span>
                ${hasFish ? `<span style="color:#dc2626;font-weight:800;margin-left:4px;">&#9888;</span>` : ""}
              </td>
              <td align="right" style="white-space:nowrap;">${allergenBadges}</td>
            </tr></table>
          </td>
        </tr>
        ${subRows}`;
    }).join("");

    return `
    <tr><td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#ffffff;">
        <tr><td style="background:#1e293b;padding:8px 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td>
              <span style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#ffffff;">${escapeHtml(date)} &mdash; Run&nbsp;${run}</span>
              <span style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#94a3b8;margin-left:12px;">${uniqueRecipeCount} Rezepte &middot; ${totalSubCount} WOs &middot; ${fmtInt(dayTarget)} Portionen &middot; ${fmtInt(dayBatches)} Batches &middot; <strong style="color:#fbbf24;">${totalSubCount + 1} MA</strong></span>
            </td>
          </tr></table>
        </td></tr>
        <tr><td>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">WO</th>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Sub-Rezept</th>
              <th align="right" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Target</th>
              <th align="right" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Kitchen kg</th>
              <th align="right" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#4338ca;text-transform:uppercase;letter-spacing:0.08em;">Batches</th>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Cook-Methoden</th>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Status</th>
            </tr>
            ${recipeSections}
          </table>
        </td></tr>
      </table>
    </td></tr>`;
  }).join("");

  // Section C: Kapazitäts- & Personalplan (aus Weekly Planning Sheet)
  const capacityHtml = weeklyPlanning ? (() => {
    const bpls2 = weeklyPlanning.boxesPerLinePerShift;
    const refNote = weeklyPlanning.referenceNote || `KW${weeklyPlanning.cw}`;
    const boxSched = weeklyPlanning.boxSchedule;
    const teamByDay = weeklyPlanning.teamByDay;

    const rows = boxSched.map((bd) => {
      const fullDay = DAY_LABEL_TO_WEEKDAY[bd.dayLabel] ?? "";
      const team = teamByDay.find((t) => t.dayLabel === fullDay);

      const linesEarly = team?.platingLinesEarly ?? 0;
      const linesLate = team?.platingLinesLate ?? 0;
      const totalLines = linesEarly + linesLate;
      const maxCap = totalLines * bpls2;
      const phEarly = team?.platingHeadcountEarly ?? 0;
      const phLate = team?.platingHeadcountLate ?? 0;
      const kEarly = team?.kitchenHeadcountEarly ?? 0;
      const kLate = team?.kitchenHeadcountLate ?? 0;
      const allEarly = team?.allStaffEarly ?? 0;
      const allLate = team?.allStaffLate ?? 0;

      const isOk = bd.boxes === 0 || maxCap >= bd.boxes;
      const isTight = !isOk && maxCap > 0 && maxCap >= bd.boxes * 0.75;

      // Area breakdown for tooltip-like details
      const areaDetails = team
        ? Object.entries(team.areas)
            .filter(([, v]) => v.early > 0 || v.late > 0)
            .map(([k, v]) => {
              const parts: string[] = [];
              if (v.early > 0) parts.push(`${v.early} früh`);
              if (v.late > 0) parts.push(`${v.late} spät`);
              return `${k}: ${parts.join("/")}`;
            })
            .join(" &middot; ")
        : "";

      const utilPct = maxCap > 0 && bd.boxes > 0 ? Math.min(100, Math.round((bd.boxes / maxCap) * 100)) : 0;
      const accentColor = bd.boxes === 0 ? "#94a3b8" : isOk ? "#10b981" : isTight ? "#f59e0b" : "#ef4444";
      const statusBadgeBg = bd.boxes === 0 ? "#f1f5f9" : isOk ? "#dcfce7" : isTight ? "#fef3c7" : "#fee2e2";
      const statusBadgeText = bd.boxes === 0 ? "#64748b" : isOk ? "#166534" : isTight ? "#92400e" : "#991b1b";
      const statusEmoji = bd.boxes === 0 ? "–" : isOk ? "✓ OK" : isTight ? "⚠ Eng" : "✗ Kritisch";
      const rowBg = bd.boxes === 0 ? C.white : isOk ? "#f0fdf4" : isTight ? "#fffbeb" : "#fef2f2";

      return `
      <tr style="background:${rowBg};border-left:3px solid ${accentColor};">
        <td style="padding:9px 12px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:800;color:${C.navy};white-space:nowrap;border-left:3px solid ${accentColor};">${escapeHtml(bd.dayLabel)}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:${C.navy};text-align:right;">${bd.boxes ? fmtInt(bd.boxes) : "<span style='color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:${C.slate};text-align:right;">${bd.meals ? fmtInt(bd.meals) : "<span style='color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};text-align:center;">
          ${linesEarly > 0 || linesLate > 0 ? `
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:#0369a1;background:#dbeafe;border-radius:4px;padding:2px 6px;">${linesEarly}F</span>
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#94a3b8;margin:0 2px;">/</span>
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:#6d28d9;background:#ede9fe;border-radius:4px;padding:2px 6px;">${linesLate}S</span>
          ` : `<span style="color:#cbd5e1">–</span>`}
        </td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:600;color:#0369a1;text-align:right;">${phEarly + phLate > 0 ? (phEarly + phLate).toFixed(0) : "<span style='color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:600;color:${C.emeraldDark};text-align:right;">${kEarly + kLate > 0 ? (kEarly + kLate).toFixed(0) : "<span style='color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:900;color:${C.navy};text-align:right;">${allEarly + allLate > 0 ? (allEarly + allLate).toFixed(0) : "<span style='font-weight:400;color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:${C.emeraldDark};font-weight:600;text-align:right;">${maxCap ? fmtInt(maxCap) : "<span style='color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};text-align:center;min-width:80px;">
          ${utilPct > 0 ? `
          <div style="background:#e2e8f0;border-radius:99px;height:6px;overflow:hidden;margin:0 4px 3px 4px;">
            <div style="background:${accentColor};height:6px;width:${utilPct}%;border-radius:99px;"></div>
          </div>
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:700;color:${accentColor};">${utilPct}%</span>
          ` : `<span style="color:#cbd5e1;font-family:Segoe UI,Arial,sans-serif;font-size:11px;">–</span>`}
        </td>
        <td style="padding:9px 12px;border-bottom:1px solid ${C.border};text-align:center;">
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;color:${statusBadgeText};background:${statusBadgeBg};border-radius:99px;padding:3px 10px;white-space:nowrap;">${statusEmoji}</span>
        </td>
      </tr>
      ${areaDetails ? `<tr style="background:#f8fafc;"><td colspan="10" style="padding:3px 12px 7px 15px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;border-bottom:1px solid ${C.border};border-left:3px solid ${accentColor};">${areaDetails}</td></tr>` : ""}`;
    }).join("");

    // KPI-Zusammenfassung
    const totalBoxes = boxSched.reduce((s, b) => s + b.boxes, 0);
    const peakDay = boxSched.reduce((best, b) => b.boxes > best.boxes ? b : best, boxSched[0] ?? { dayLabel: "–", boxes: 0, meals: 0 });
    const totalMA = teamByDay.reduce((s, t) => s + t.allStaffEarly + t.allStaffLate, 0);

    return `
    <tr><td style="padding:20px 24px 8px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
      ${sectionHeader("Kapazit&auml;ts- &amp; Personalplan", `Referenz ${escapeHtml(refNote)} &middot; ${fmtInt(bpls2)}&thinsp;Boxen/Linie/Schicht &middot; 1&thinsp;Linie&thinsp;=&thinsp;1.000 Boxen/h`, C.emerald)}

      <!-- KPI-Band -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:14px;">
        <tr>
          <td width="25%" style="padding:0 6px 0 0;">
            <div style="background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:10px;padding:12px 14px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:4px;">Boxen gesamt</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:22px;font-weight:900;color:#ffffff;line-height:1;">${fmtInt(totalBoxes)}</div>
            </div>
          </td>
          <td width="25%" style="padding:0 6px;">
            <div style="background:linear-gradient(135deg,#0c4a6e,#0369a1);border-radius:10px;padding:12px 14px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#bae6fd;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:4px;">Peak-Tag</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:18px;font-weight:900;color:#ffffff;line-height:1;">${escapeHtml(peakDay.dayLabel)}</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#7dd3fc;margin-top:2px;">${fmtInt(peakDay.boxes)} Boxen</div>
            </div>
          </td>
          <td width="25%" style="padding:0 6px;">
            <div style="background:linear-gradient(135deg,#064e3b,#065f46);border-radius:10px;padding:12px 14px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#6ee7b7;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:4px;">Ø MA / Tag</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:22px;font-weight:900;color:#ffffff;line-height:1;">${teamByDay.length > 0 ? Math.round(totalMA / teamByDay.length) : "–"}</div>
            </div>
          </td>
          <td width="25%" style="padding:0 0 0 6px;">
            <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);border-radius:10px;padding:12px 14px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#c7d2fe;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:4px;">Mahlzeiten</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:22px;font-weight:900;color:#ffffff;line-height:1;">${fmtInt(boxSched.reduce((s, b) => s + b.meals, 0))}</div>
            </div>
          </td>
        </tr>
      </table>

      <!-- Haupttabelle -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${C.border};border-radius:12px;overflow:hidden;">
        <tr>
          <th align="left"   style="padding:8px 12px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.1em;white-space:nowrap;">Tag</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.1em;">Boxen</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#7dd3fc;text-transform:uppercase;letter-spacing:0.1em;">Mahlzeiten</th>
          <th align="center" style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#7dd3fc;text-transform:uppercase;letter-spacing:0.1em;">Linien&nbsp;F/S</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.1em;">Plating-MA</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#6ee7b7;text-transform:uppercase;letter-spacing:0.1em;">Küchen-MA</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#ffffff;text-transform:uppercase;letter-spacing:0.1em;font-weight:900;">Ges.-MA</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#6ee7b7;text-transform:uppercase;letter-spacing:0.1em;">Max&nbsp;Kap.</th>
          <th align="center" style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.1em;">Auslastung</th>
          <th align="center" style="padding:8px 12px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#f8fafc;text-transform:uppercase;letter-spacing:0.1em;">Status</th>
        </tr>
        ${rows}
      </table>
      <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slateLight};margin-top:6px;">F = Fr&uuml;hschicht &middot; S = Sp&auml;tschicht &middot; MA = Mitarbeiter (FTE)</div>
    </td></tr>`;
  })() : "";

  // ── Extra KPIs from weekly planning ─────────────────────────────────────────
  const uniqueRecipes   = new Set(allRows.map(r => r.recipeId)).size;
  const totalSubRecipes = allRows.length;
  const totalKetPortions = dedupedRun.reduce((s, r) => s + r.targetPortions, 0);
  const maxDayStaff     = weeklyPlanning ? Math.max(...weeklyPlanning.teamByDay.map(d => d.allStaffEarly + d.allStaffLate), 0) : 0;
  const bpls = weeklyPlanning?.boxesPerLinePerShift ?? 6608;
  const refLabel = weeklyPlanning
    ? `${weeklyPlanning.isReference ? "Referenz " : ""}KW${weeklyPlanning.cw}`
    : "kein Wochenplan";

  // ── Section helpers ───────────────────────────────────────────────────────────
  function sectionHeader(title: string, sub: string, accentColor = C.navy) {
    return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:14px;">
      <tr>
        <td style="border-left:4px solid ${accentColor};padding-left:10px;">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;font-weight:800;color:${C.navy};text-transform:uppercase;letter-spacing:0.1em;">${title}</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:${C.slate};margin-top:2px;">${sub}</div>
        </td>
      </tr>
    </table>`;
  }

  function kpiCell(label: string, value: string, color: string, sub = "") {
    return `<td style="padding:14px 16px;text-align:center;border-right:1px solid ${C.border};">
      <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slate};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">${label}</div>
      <div style="font-family:Segoe UI,Arial,sans-serif;font-size:26px;font-weight:900;color:${color};line-height:1;">${value}</div>
      ${sub ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slateLight};margin-top:3px;">${sub}</div>` : ""}
    </td>`;
  }

  function capBar(used: number, max: number, height = 6) {
    if (max <= 0) return `<table width="100%" cellspacing="0" cellpadding="0"><tr><td style="height:${height}px;background:#e2e8f0;border-radius:3px;"></td></tr></table>`;
    const pct = Math.min(100, Math.round(used / max * 100));
    const barColor = pct <= 75 ? C.emerald : pct <= 100 ? C.amber : C.red;
    return `<table width="100%" cellspacing="0" cellpadding="0" style="border-radius:3px;overflow:hidden;"><tr>
      <td width="${pct}%" style="height:${height}px;background:${barColor};"></td>
      ${pct < 100 ? `<td style="height:${height}px;background:#e2e8f0;"></td>` : ""}
    </tr></table>`;
  }

  // ── SECTION: Wochenkalender ───────────────────────────────────────────────────
  const calendarCols = (weeklyPlanning?.boxSchedule ?? []).map((bd) => {
    const fullDay = DAY_LABEL_TO_WEEKDAY[bd.dayLabel] ?? "";
    const team = weeklyPlanning?.teamByDay.find((t) => t.dayLabel === fullDay);
    const linesEarly = team?.platingLinesEarly ?? 0;
    const linesLate = team?.platingLinesLate ?? 0;
    const lines = linesEarly + linesLate;
    const maxCap = lines * bpls;
    const pct = maxCap > 0 ? Math.min(100, Math.round(bd.boxes / maxCap * 100)) : 0;
    const totalStaff = (team?.allStaffEarly ?? 0) + (team?.allStaffLate ?? 0);
    const platingStaff = (team?.platingHeadcountEarly ?? 0) + (team?.platingHeadcountLate ?? 0);
    const kitchenStaff = (team?.kitchenHeadcountEarly ?? 0) + (team?.kitchenHeadcountLate ?? 0);
    const hasKet = allRows.some(r => {
      const { date } = parseDateNeeded(r.dateNeeded);
      const d = new Date(date + "T00:00:00Z");
      return ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].indexOf(bd.dayLabel.substring(0,3)) ===
             ((d.getUTCDay() + 6) % 7);
    });
    const isOk = bd.boxes === 0 || maxCap >= bd.boxes;
    const isTight = !isOk && maxCap > 0 && maxCap >= bd.boxes * 0.85;
    const cellBg = bd.boxes === 0 ? C.slateBg : isOk ? "#f0fdf4" : isTight ? "#fffbeb" : "#fef2f2";
    const borderColor = bd.boxes === 0 ? C.border : isOk ? "#86efac" : isTight ? "#fcd34d" : "#fca5a5";
    const statusLabel = bd.boxes === 0 ? "kein Versand" : isOk ? "&#10003; OK" : isTight ? "&#9888; Eng" : "&#10007; Kritisch";
    const statusColor = bd.boxes === 0 ? C.slateLight : isOk ? C.emeraldDark : isTight ? C.amberDark : C.redDark;
    const pctColor = pct <= 75 ? C.emeraldDark : pct <= 95 ? "#92400e" : C.redDark;
    return `<td style="padding:0 3px;vertical-align:top;width:12.5%;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:2px solid ${borderColor};border-radius:10px;overflow:hidden;background:${cellBg};">
        <!-- Day label -->
        <tr><td style="background:${bd.boxes === 0 ? C.slateBg : isOk ? "#dcfce7" : isTight ? "#fef3c7" : "#fee2e2"};padding:5px 8px;text-align:center;border-bottom:1px solid ${borderColor};">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:900;color:${C.navy};">${escapeHtml(bd.dayLabel)}</div>
          ${team?.date ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.slate};">${escapeHtml(team.date)}</div>` : ""}
        </td></tr>
        <!-- Boxes + Meals -->
        <tr><td style="padding:8px 8px 4px 8px;text-align:center;">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:22px;font-weight:900;color:${bd.boxes > 0 ? C.navy : C.slateLight};line-height:1;">${bd.boxes > 0 ? fmtInt(bd.boxes) : "–"}</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.slate};">Boxen</div>
          ${bd.meals > 0 ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:${C.skyDark};margin-top:2px;">${fmtInt(bd.meals)} Mahlzeiten</div>` : ""}
        </td></tr>
        <!-- Capacity bar -->
        <tr><td style="padding:4px 8px;">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${pctColor};font-weight:700;text-align:center;margin-bottom:2px;">${maxCap > 0 ? pct + "%" : "–"}</div>
          ${capBar(bd.boxes, maxCap, 7)}
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.slate};text-align:center;margin-top:2px;">${maxCap > 0 ? `Kap. ${fmtInt(maxCap)}` : "keine Kap."}</div>
        </td></tr>
        <!-- Lines -->
        <tr><td style="padding:4px 8px;border-top:1px solid ${C.border};">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.skyDark};text-align:center;">
            ${lines > 0 ? `${lines} Linie${lines > 1 ? "n" : ""} (${linesEarly}F/${linesLate}S)` : "kein Plating"}
          </div>
        </td></tr>
        <!-- Staff -->
        ${totalStaff > 0 ? `<tr><td style="padding:3px 8px 4px 8px;background:rgba(0,0,0,0.03);border-top:1px solid ${C.border};">
          <table width="100%" cellspacing="0" cellpadding="0"><tr>
            <td style="text-align:center;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;color:${C.navy};">${totalStaff.toFixed(0)}</div><div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:${C.slateLight};">Ges.</div></td>
            <td style="text-align:center;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:700;color:${C.skyDark};">${platingStaff > 0 ? platingStaff.toFixed(1) : "–"}</div><div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:${C.slateLight};">Plating</div></td>
            <td style="text-align:center;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:700;color:${C.emeraldDark};">${kitchenStaff > 0 ? kitchenStaff.toFixed(1) : "–"}</div><div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:${C.slateLight};">Küche</div></td>
          </tr></table>
        </td></tr>` : ""}
        <!-- Status + KET -->
        <tr><td style="padding:4px 8px 6px 8px;text-align:center;border-top:1px solid ${C.border};">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;color:${statusColor};">${statusLabel}</div>
          ${hasKet ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.sky};margin-top:2px;">&#128373; KET Kochtag</div>` : ""}
        </td></tr>
      </table>
    </td>`;
  }).join("");

  // ── SECTION: Staff matrix ─────────────────────────────────────────────────────
  const staffMatrixHtml = weeklyPlanning ? (() => {
    const days = weeklyPlanning.teamByDay;
    const allAreas = Array.from(new Set(days.flatMap(d => Object.keys(d.areas)))).sort();
    const areaGroups: Record<string, string[]> = {
      "Plating": allAreas.filter(a => /plating/i.test(a)),
      "Küche (K)": allAreas.filter(a => /^k\d/i.test(a)),
      "FFM": allAreas.filter(a => /^ffm/i.test(a)),
      "Wareneingang": allAreas.filter(a => /^w\d/i.test(a)),
      "Sonstige": allAreas.filter(a => !/plating|^k\d|^ffm|^w\d/i.test(a)),
    };


    const groupRows = Object.entries(areaGroups).filter(([, areas]) => areas.length > 0).map(([groupName, areas]) => {
      const groupHeader = `<tr><td colspan="${days.length + 1}" style="padding:5px 10px 2px 10px;background:${C.slateBg};font-family:Segoe UI,Arial,sans-serif;font-size:9px;font-weight:800;color:${C.slate};text-transform:uppercase;letter-spacing:0.12em;border-top:1px solid ${C.border};">${groupName}</td></tr>`;
      const areaRows = areas.map((area, idx) => {
        const bg = idx % 2 === 0 ? C.white : C.slateBg;
        const isPlating = /plating/i.test(area);
        const isKitchen = /^k\d/i.test(area);
        const labelColor = isPlating ? C.skyDark : isKitchen ? C.emeraldDark : C.navyLight;
        return `<tr style="background:${bg};">
          <td style="padding:5px 10px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:600;color:${labelColor};white-space:nowrap;">${escapeHtml(area)}</td>
          ${days.map(d => {
            const v = d.areas[area];
            const e = v?.early ?? 0;
            const l = v?.late ?? 0;
            const total = e + l;
            if (total === 0) return `<td style="padding:5px 8px;text-align:center;"><span style="color:#cbd5e1;font-size:10px;">–</span></td>`;
            return `<td style="padding:5px 8px;text-align:center;">
              <span style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:${labelColor};">${total.toFixed(1)}</span>
              <br/><span style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.slate};">${e > 0 ? `F${e.toFixed(1)}` : ""}${l > 0 ? `&nbsp;S${l.toFixed(1)}` : ""}</span>
            </td>`;
          }).join("")}
        </tr>`;
      }).join("");
      return groupHeader + areaRows;
    }).join("");

    return `<tr><td style="padding:20px 24px 8px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
      ${sectionHeader("Mitarbeiter-Matrix", `Besetzung je Bereich und Tag &mdash; Referenz ${escapeHtml(weeklyPlanning.referenceNote)}`, C.sky)}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${C.border};border-radius:12px;overflow:hidden;">

        <!-- Spalten-Header: Bereich + ein Tag pro Spalte -->
        <tr>
          <th align="left" style="padding:8px 14px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.12em;white-space:nowrap;min-width:130px;">Bereich</th>
          ${days.map(d => `<th style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#e2e8f0;text-align:center;letter-spacing:0.06em;font-weight:700;">${d.dayLabel.substring(0,3).toUpperCase()}<br/><span style="font-size:8px;color:#64748b;font-weight:400;">${d.date ? d.date.slice(5) : ""}</span></th>`).join("")}
        </tr>

        <!-- GESAMT-Zeile -->
        <tr style="background:linear-gradient(90deg,${C.navy} 0%,${C.navyMid} 100%);">
          <td style="padding:10px 14px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:900;color:#ffffff;letter-spacing:0.08em;text-transform:uppercase;border-right:1px solid rgba(255,255,255,0.1);">&#128101; GESAMT</td>
          ${days.map(d => {
            const total = d.allStaffEarly + d.allStaffLate;
            const heat = total > 150 ? "#f97316" : total > 100 ? "#fbbf24" : total > 50 ? "#34d399" : "#93c5fd";
            return `<td style="padding:10px 8px;text-align:center;border-right:1px solid rgba(255,255,255,0.06);">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:16px;font-weight:900;color:${heat};line-height:1;">${total > 0 ? Math.round(total) : "–"}</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:#475569;margin-top:2px;">${d.allStaffEarly > 0 ? `F${Math.round(d.allStaffEarly)}` : ""}${d.allStaffLate > 0 ? ` S${Math.round(d.allStaffLate)}` : ""}</div>
            </td>`;
          }).join("")}
        </tr>

        <!-- Plating-Zeile -->
        <tr style="background:#eff6ff;">
          <td style="padding:8px 14px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:${C.skyDark};border-left:3px solid ${C.sky};border-right:1px solid ${C.border};">
            &#9654; Plating
          </td>
          ${days.map(d => {
            const ph = d.platingHeadcountEarly + d.platingHeadcountLate;
            const lines = d.platingLinesEarly + d.platingLinesLate;
            return `<td style="padding:8px 6px;text-align:center;border-right:1px solid ${C.border};">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:800;color:${C.skyDark};">${ph > 0 ? Math.round(ph) : "–"}</div>
              ${lines > 0 ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.sky};margin-top:1px;">${lines} Linie${lines > 1 ? "n" : ""}</div>` : ""}
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:#94a3b8;">${d.platingHeadcountEarly > 0 ? `F${Math.round(d.platingHeadcountEarly)}` : ""}${d.platingHeadcountLate > 0 ? ` S${Math.round(d.platingHeadcountLate)}` : ""}</div>
            </td>`;
          }).join("")}
        </tr>

        <!-- Küche-Zeile -->
        <tr style="background:#f0fdf4;">
          <td style="padding:8px 14px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:${C.emeraldDark};border-left:3px solid ${C.emerald};border-right:1px solid ${C.border};">
            &#9654; K&uuml;che
          </td>
          ${days.map(d => {
            const kh = d.kitchenHeadcountEarly + d.kitchenHeadcountLate;
            return `<td style="padding:8px 6px;text-align:center;border-right:1px solid ${C.border};">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:800;color:${C.emeraldDark};">${kh > 0 ? Math.round(kh) : "–"}</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:#94a3b8;margin-top:2px;">${d.kitchenHeadcountEarly > 0 ? `F${Math.round(d.kitchenHeadcountEarly)}` : ""}${d.kitchenHeadcountLate > 0 ? ` S${Math.round(d.kitchenHeadcountLate)}` : ""}</div>
            </td>`;
          }).join("")}
        </tr>

        <!-- Bereichs-Gruppen -->
        ${groupRows}
      </table>
      <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slateLight};margin-top:6px;">
        F = Fr&uuml;hschicht &middot; S = Sp&auml;tschicht &middot; Zahlen = Mitarbeiter (FTE)
      </div>
    </td></tr>`;
  })() : "";

  return `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Produktions-Rundmail ${runLabel} KW${weeklyPlanning?.cw ?? ""}</title>
<style>@media print{body{background:#fff!important;padding:0!important}table{page-break-inside:avoid}@page{size:A4 landscape;margin:8mm}}</style>
</head>
<body style="margin:0;padding:16px;background:#cbd5e1;font-family:Segoe UI,Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:980px;margin:0 auto;">

  <!-- ═══════════════════ HEADER ═══════════════════ -->
  <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#0c4a6e 100%);border-radius:16px 16px 0 0;padding:28px 28px 24px 28px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td>
        <div style="font-size:10px;letter-spacing:0.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:8px;">Factor OPS &middot; Standort Verden &middot; Produktion</div>
        <div style="font-size:28px;font-weight:900;color:#ffffff;line-height:1.1;letter-spacing:-0.02em;">Produktions-Rundmail &mdash; ${runLabel}</div>
        <div style="font-size:16px;font-weight:400;color:#93c5fd;margin-top:4px;">K&uuml;chen-Plan &middot; Kapazit&auml;t &middot; Personal</div>
      </td>
      <td align="right" style="vertical-align:top;white-space:nowrap;">
        <div style="display:inline-block;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);border-radius:10px;padding:8px 16px;text-align:center;">
          <div style="font-size:10px;color:#7dd3fc;letter-spacing:0.1em;">PRODUKTIONSWOCHE</div>
          <div style="font-size:32px;font-weight:900;color:#ffffff;line-height:1;">KW${weeklyPlanning?.cw ?? "–"}</div>
          <div style="font-size:10px;color:#93c5fd;">${weeklyPlanning?.year ?? new Date().getFullYear()}</div>
        </div>
      </td>
    </tr></table>
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.12);font-size:11px;color:#64748b;">
      Erstellt: ${escapeHtml(generatedAt)} &nbsp;&middot;&nbsp; Quelle: ${escapeHtml(sourceLabel)}
      ${weeklyPlanning?.isReference ? `&nbsp;&middot;&nbsp; <span style="color:#f59e0b;font-weight:600;">&#9888; Wochenplanung: Referenz ${escapeHtml(weeklyPlanning.referenceNote)}</span>` : ""}
    </div>
  </td></tr>

  <!-- ═══════════════════ KPI BAND ═══════════════════ -->
  <tr><td style="background:#ffffff;border-left:1px solid ${C.border};border-right:1px solid ${C.border};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        ${kpiCell(`${runLabel} Work Orders`, String(targetRunRows.length), C.navy, `von ${allRows.length} gesamt`)}
        ${kpiCell("Ziel-Portionen", fmtInt(totalTarget), C.sky, runLabel)}
        ${kpiCell("Completion", completion + "%", completion >= 80 ? C.emerald : completion >= 50 ? C.amber : C.red, `${fmtInt(totalCooked)} gekocht`)}
        ${kpiCell("KET Tage", String(allDays.length), C.skyDark, `${runLabel} Produktionstage`) }
        ${kpiCell("WOs gesamt", String(targetRunRows.length), C.navyLight, "inkl. Sub-Rezepte")}
        ${kpiCell("Peak-Personal", maxDayStaff > 0 ? maxDayStaff.toFixed(0) : "–", C.navy, refLabel)}
        ${kpiCell("Rezepte / Sub-Rezepte", `${uniqueRecipes} / ${totalSubRecipes}`, C.navyLight, `${fmtInt(totalKetPortions)} Portionen Küche`)}
        ${kpiCell("Batches", fmtInt(totalBatches), "#4338ca", runLabel)}
        <td style="padding:14px 16px;text-align:center;">
          <div style="font-size:10px;color:${C.slate};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Offen</div>
          <div style="font-size:26px;font-weight:900;color:${totalOpen > 0 ? C.amber : C.emerald};line-height:1;">${fmtInt(totalOpen)}</div>
          <div style="font-size:10px;color:${C.slateLight};margin-top:3px;">Portionen</div>
        </td>
      </tr>
    </table>
    <!-- Completion bar -->
    <div style="padding:0 0 0 0;">
      <table width="100%" cellspacing="0" cellpadding="0"><tr>
        <td width="${completion}%" style="height:5px;background:linear-gradient(90deg,${C.emerald},${C.sky});"></td>
        ${completion < 100 ? `<td style="height:5px;background:#e2e8f0;"></td>` : ""}
      </tr></table>
    </div>
  </td></tr>

  <!-- ═══════════════════ TOOL-LINKS ═══════════════════ -->
  <tr><td style="background:#f8fafc;padding:12px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:1px solid ${C.border};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:${C.slate};vertical-align:middle;">
        &#128279;&nbsp;<strong>Tools direkt öffnen:</strong>
      </td>
      <td align="right" style="white-space:nowrap;">
        <a href="${WHAT_IF_URL}" style="display:inline-block;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 16px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:700;color:#1d4ed8;text-decoration:none;margin-left:8px;">&#128200;&nbsp;What-if Rechner</a>
        <a href="${BREAKDOWN_URL}" style="display:inline-block;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 16px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:700;color:#166534;text-decoration:none;margin-left:8px;">&#128203;&nbsp;Breakdown Rechner</a>
      </td>
    </tr></table>
  </td></tr>

  <!-- ═══════════════════ RUN TIMELINE ═══════════════════ -->
  <tr><td style="background:#f8fafc;padding:16px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
    ${sectionHeader(`${runLabel} Timeline`, `Offene Portionen je Fertigstellungstag`)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      ${timelineCards.map(card => {
        const { date, run } = parseDateNeeded(card.day);
        const isAllDone = card.open === 0;
        return `
        <td style="padding:0 6px 0 0;vertical-align:top;width:${Math.round(100 / timelineCards.length)}%;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${isAllDone ? '#bbf7d0' : C.border};border-radius:10px;overflow:hidden;background:${isAllDone ? '#f0fdf4' : C.white};">
            <tr><td style="background:${isAllDone ? '#166534' : C.navyMid};padding:7px 12px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:700;color:#cbd5e1;text-transform:uppercase;letter-spacing:0.08em;">${escapeHtml(date)} &mdash; Run ${run}</div>
            </td></tr>
            <tr><td style="padding:10px 12px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:24px;font-weight:900;color:${isAllDone ? '#166534' : card.open > 5000 ? C.red : C.amber};line-height:1;">${fmtInt(card.open)}</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slate};margin-top:2px;">${isAllDone ? '&#10003; Fertig' : 'Offen'}</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slateLight};margin-top:6px;">${card.count} ${runLabel} WOs &middot; Target ${fmtInt(card.target)}</div>
            </td></tr>
          </table>
        </td>`;
      }).join("")}
    </tr></table>
  </td></tr>

  <!-- ═══════════════════ KÜCHEN-PLAN ═══════════════════ -->
  <tr><td style="background:#ffffff;padding:20px 24px 8px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
    ${sectionHeader(`K&uuml;chen-Plan &mdash; ${runLabel}`, `${targetRunRows.length} Work Orders &middot; ${uniqueRecipes} Rezepte &middot; ${fmtInt(totalTarget)} Portionen`)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      ${kitchenPlanHtml}
    </table>
  </td></tr>

  <!-- ═══════════════════ WOCHENKALENDER ═══════════════════ -->
  ${weeklyPlanning ? `<tr><td style="background:#ffffff;padding:20px 20px 16px 20px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
    ${sectionHeader("Wochenkalender &amp; Kapazit&auml;t", `Boxen-Ziel je Tag vs. Plating-Kapazit&auml;t &middot; 1 Linie = ${fmtInt(bpls)} Boxen/Schicht &middot; ${fmtInt(bpls * 2)} bei 2 Linien`, C.sky)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="4">
      <tr>${calendarCols}</tr>
    </table>
    <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slateLight};margin-top:8px;">Balken = Box-Ziel als % der verf&uuml;gbaren Kapazit&auml;t &middot; &#128373; = KET Kochtag &middot; &#10003; = Kapazit&auml;t ausreichend &middot; ! = Kapazit&auml;t pr&uuml;fen</div>
  </td></tr>` : ""}

  <!-- ═══════════════════ KAPAZITÄT & PERSONAL (Ende) ═══════════════════ -->
  ${capacityHtml ? capacityHtml.replace(`<tr><td style="padding:20px 24px 8px 24px;border-top:2px solid #e2e8f0`, `<tr><td style="padding:20px 24px 8px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border}`) : ""}

  <!-- ═══════════════════ MITARBEITER-MATRIX ═══════════════════ -->
  ${staffMatrixHtml}

  <!-- ═══════════════════ FOOTER ═══════════════════ -->
  <tr><td style="background:#f1f5f9;border-radius:0 0 16px 16px;padding:16px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-bottom:1px solid ${C.border};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td style="font-size:11px;color:${C.slate};">
        <strong style="color:${C.navy};">Factor OPS Planner</strong> &middot; Standort Verden &middot; ${escapeHtml(generatedAt)}
      </td>
      <td align="right" style="font-size:10px;color:${C.slateLight};white-space:nowrap;">
        ${escapeHtml(sourceLabel)}
      </td>
    </tr></table>
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid ${C.border};font-size:10px;color:${C.slateLight};">
      Im Browser &ouml;ffnen &rarr; Strg+A &rarr; Strg+C &rarr; in neue E-Mail einf&uuml;gen
    </div>
  </td></tr>

</table>
</body>
</html>`;
}


// ─── KET Präsentation ────────────────────────────────────────────────────────

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
        : `<span style="font-size:9px;color:#94a3b8;">Keine bekannten Allergene</span>`;

      const subRows = recipe.rows.map((r) => {
        const delta = r.woCookedPortions - r.targetPortions;
        return `<tr>
          <td class="mono">${escapeHtml(r.workOrderNumber)}</td>
          <td>${escapeHtml(r.subRecipeName)}</td>
          <td class="mono">${escapeHtml(r.cookMethods || "–")}</td>
          <td class="r">${fmtInt(r.targetPortions)}</td>
          <td class="r">${r.kitchenKg != null ? fmtInt(r.kitchenKg) + " kg" : "–"}</td>
          <td class="r bold" style="color:#4338ca;">${r.batchesNeeded != null ? fmtInt(r.batchesNeeded) : "–"}</td>
          <td style="color:${statusColor(r.kitchenStatus)}; font-weight:600;">${escapeHtml(r.kitchenStatus || "–")}</td>
          <td style="color:${delta < 0 ? "#991b1b" : "#166534"};font-weight:600;">${delta >= 0 ? "+" : ""}${fmtInt(delta)}</td>
        </tr>`;
      }).join("");

      return `<div class="recipe-card" style="border-left-color:hsl(${h},60%,42%);">
        <div class="recipe-hdr" style="background:hsl(${h},44%,97%);">
          <div>
            <span class="recipe-name">${escapeHtml(first.recipeName.replace(/\s*\[.*?\]/g, ""))}</span>
            <span class="recipe-id">${escapeHtml(first.recipeId)}</span>
          </div>
          <div class="recipe-meta">
            <span class="kpi-chip">${fmtInt(first.targetPortions)} Port.</span>
            <span class="kpi-chip">${recipe.rows.length} WOs</span>
            ${allergenHtml}
          </div>
        </div>
        <table class="sub-table">
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
<title>KET Plating Präsentation &mdash; ${runLabel}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4 portrait;margin:12mm 14mm}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#1e293b;background:#fff}
.cover{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#0369a1 100%);border-radius:10px;padding:28px 28px 22px;margin-bottom:20px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover-eyebrow{font-size:9px;letter-spacing:.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:8px}
.cover-title{font-size:28px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-.02em}
.cover-sub{font-size:14px;color:#bae6fd;margin-top:6px}
.cover-meta{font-size:9px;color:#94a3b8;margin-top:12px;border-top:1px solid rgba(255,255,255,.18);padding-top:10px}
.kpi-row{display:flex;gap:10px;margin-bottom:18px}
.kpi-box{flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;text-align:center}
.kpi-lbl{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.1em}
.kpi-val{font-size:22px;font-weight:900;color:#0f172a;line-height:1.1;margin-top:2px}
.prog-track{height:5px;background:#e2e8f0;border-radius:9px;overflow:hidden;margin-bottom:18px}
.prog-fill{height:100%;background:linear-gradient(90deg,#0ea5e9,#10b981);border-radius:9px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.day-block{border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:18px;page-break-inside:avoid}
.day-hdr{background:#1e293b;padding:8px 14px;display:flex;justify-content:space-between;align-items:center;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.day-title{font-size:13px;font-weight:800;color:#fff}
.day-meta{font-size:10px;color:#94a3b8}
.recipe-card{border-left:4px solid #0369a1;margin:8px 10px;border-radius:0 6px 6px 0;overflow:hidden}
.recipe-hdr{padding:6px 10px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:4px}
.recipe-name{font-size:12px;font-weight:800;color:#0f172a}
.recipe-id{font-size:10px;color:#64748b;margin-left:8px;font-family:monospace}
.recipe-meta{display:flex;flex-wrap:wrap;gap:3px;align-items:center;margin-top:2px}
.kpi-chip{display:inline-block;background:#e2e8f0;color:#334155;border-radius:4px;padding:1px 6px;font-size:9px;font-weight:700}
.badge{display:inline-block;border-radius:3px;padding:1px 6px;font-size:9px;font-weight:700;margin:1px 2px}
.sub-table{width:100%;border-collapse:collapse;font-size:9px}
.sub-table th{padding:3px 8px;background:#f8fafc;color:#64748b;text-transform:uppercase;letter-spacing:.07em;font-weight:700;text-align:left;border-bottom:1px solid #e2e8f0}
.sub-table td{padding:3px 8px;border-bottom:1px solid #f8fafc;vertical-align:top}
.sub-table tr:last-child td{border-bottom:none}
.r{text-align:right;white-space:nowrap}
.mono{font-family:monospace;color:#475569}
.bold{font-weight:700}
.footer{margin-top:18px;font-size:9px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px}
@media print{body{background:#fff}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}.day-block{page-break-inside:avoid}}
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
<div class="footer">Factor OPS Planner &middot; KET Plating Präsentation &middot; ${escapeHtml(runLabel)} &middot; ${escapeHtml(generatedAt)}</div>
</body>
</html>`;
}


export function buildKetSlackBlocks(allRows: RundmailRow[], sourceLabel: string, run: 1 | 2): object {
  const runRows = allRows.filter((r) => parseDateNeeded(r.dateNeeded).run === run);
  const dedupedRun = Array.from(new Map(runRows.map((r) => [r.recipeId, r])).values());
  const totalTarget = dedupedRun.reduce((s, r) => s + r.targetPortions, 0);
  const totalCooked = dedupedRun.reduce((s, r) => s + r.woCookedPortions, 0);
  const totalOpen = dedupedRun.reduce((s, r) => s + toSlack(r.targetPortions - r.woCookedPortions), 0);
  const generatedAt = new Date().toLocaleString("de-DE");

  const days = Array.from(new Set(runRows.map((r) => r.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));

  const daySections = days.map((day) => {
    const dayRows = runRows.filter((r) => r.dateNeeded === day);
    const { date } = parseDateNeeded(day);
    const recipeMap = new Map<string, RundmailRow>();
    dayRows.forEach((r) => { if (!recipeMap.has(r.recipeId)) recipeMap.set(r.recipeId, r); });
    const dayTarget = Array.from(recipeMap.values()).reduce((s, r) => s + r.targetPortions, 0);
    const dayCooked = Array.from(recipeMap.values()).reduce((s, r) => s + r.woCookedPortions, 0);
    const recipeLines = Array.from(recipeMap.values()).map((r) => {
      const gap = toSlack(r.targetPortions - r.woCookedPortions);
      const ratio = r.targetPortions > 0 ? Math.round((r.woCookedPortions / r.targetPortions) * 100) : 0;
      const allergens = detectAllergens([r.recipeName, r.subRecipeName]).map((a) => a.label).join(", ");
      const allergenStr = allergens ? ` | \u26A0 ${allergens}` : "";
      return `\u2022 *${r.recipeName}* \u2014 SOLL ${r.targetPortions.toLocaleString("de-DE")} | IST ${r.woCookedPortions.toLocaleString("de-DE")} | Gap ${gap.toLocaleString("de-DE")} (${ratio}%)${allergenStr}`;
    });
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*\uD83C\uDF73 ${date} \u2014 KET Run ${run}*\nSoll ${dayTarget.toLocaleString("de-DE")} | IST ${dayCooked.toLocaleString("de-DE")} | ${recipeMap.size} Rezepte`,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: recipeLines.join("\n") || "_Keine Rezepte_" } },
      { type: "divider" },
    ];
  });

  return {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `KET K\u00FCchen-Plan \u2014 Run ${run}`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*SOLL*\n${totalTarget.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*IST*\n${totalCooked.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*Gap*\n${totalOpen.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*Rezepte*\n${dedupedRun.length}` },
        ],
      },
      { type: "divider" },
      ...daySections.flat(),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Erstellt: ${generatedAt} \u00B7 Quelle: ${sourceLabel}` }],
      },
    ],
  };
}

export async function sendToSlack(webhookUrl: string, payload: object): Promise<void> {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Slack HTTP ${resp.status}`);
}

