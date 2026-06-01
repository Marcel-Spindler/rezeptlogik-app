import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

type RundmailRow = {
  id: string;
  dateNeeded: string;
  workOrderNumber: string;
  recipeId: string;
  recipeName: string;
  subRecipeName: string;
  minimumNeeds: number;
  cookMethods: string;
  woCookedPortions: number;
  targetPortions: number;
  cookedExcess: number;
  stagingStatus: string;
  stagingComment: string;
  kitchenStatus: string;
  unlockedEta: string;
  workOrderComment: string;
};

type StatusFilter = "all" | "Not Started" | "Pre Blast" | "Post Blast";

type DeficitItem = {
  row: RundmailRow;
  deficit: number;
};

function parseDateNeeded(value: string): { date: string; run: number } {
  const [rawDate, rawRun] = (value ?? "").split(" - ");
  return {
    date: (rawDate ?? "").trim(),
    run: Number(rawRun ?? "0") || 0,
  };
}

function isRun1(value: string): boolean {
  return parseDateNeeded(value).run === 1;
}

function toNumber(raw: string): number {
  const normalized = (raw ?? "").toString().trim().replace(/,/g, "");
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSeedCsv(csvText: string): RundmailRow[] {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const rows: RundmailRow[] = [];
  parsed.data.forEach((raw, idx) => {
    const wo = (raw["Work Order Number"] ?? "").trim();
    const dateNeeded = (raw["Date Needed"] ?? "").trim();
    if (!wo || !dateNeeded) return;

    rows.push({
      id: `${wo}-${idx}`,
      dateNeeded,
      workOrderNumber: wo,
      recipeId: (raw["Recipe ID"] ?? "").trim(),
      recipeName: (raw["Recipe Name"] ?? "").trim(),
      subRecipeName: (raw["Sub Recipe Name"] ?? "").trim(),
      minimumNeeds: toNumber(raw["Production Minimum Needs Amount"] ?? ""),
      cookMethods: (raw["Cook Methods"] ?? "").trim(),
      woCookedPortions: toNumber(raw["WO Cooked Portions"] ?? ""),
      targetPortions: toNumber(raw["Target Portions"] ?? ""),
      cookedExcess: toNumber(raw["Cooked Portions Excess"] ?? ""),
      stagingStatus: (raw["Staging Status"] ?? "").trim(),
      stagingComment: (raw["Staging Comment"] ?? "").trim(),
      kitchenStatus: (raw["Kitchen Status"] ?? "").trim(),
      unlockedEta: (raw["Unlocked ETA"] ?? "").trim(),
      workOrderComment: (raw["Work Order Comment"] ?? "").trim(),
    });
  });

  return rows;
}

function daySortValue(day: string): number {
  const [rawDate, rawSlot] = day.split(" - ");
  const ts = Date.parse(`${rawDate}T00:00:00Z`);
  const slot = Number(rawSlot ?? "0") || 0;
  return ts * 10 + slot;
}

function fmtInt(value: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value);
}

function toSlack(value: number): number {
  return value >= 0 ? value : 0;
}

function escapeHtml(value: string): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Weekly Planning (from Google Drive via import:weekly-planning) ──────────

type BoxDay = {
  dayLabel: string;
  boxes: number;
  meals: number;
};

type TeamDay = {
  dayLabel: string;
  date: string;
  platingLinesEarly: number;
  platingLinesLate: number;
  platingHeadcountEarly: number;
  platingHeadcountLate: number;
  kitchenHeadcountEarly: number;
  kitchenHeadcountLate: number;
  allStaffEarly: number;
  allStaffLate: number;
  areas: Record<string, { early: number; late: number }>;
};

type WeeklyPlanningData = {
  cw: number;
  year: number;
  isReference: boolean;
  referenceNote: string;
  spreadsheetName: string;
  generatedAt: string;
  boxesPerLinePerShift: number;
  boxSchedule: BoxDay[];
  teamByDay: TeamDay[];
};

const DAY_LABEL_TO_WEEKDAY: Record<string, string> = {
  Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday",
};

// ── Allergen Detection ───────────────────────────────────────────────────────

type AllergenDef = {
  label: string;
  bg: string;
  text: string;
  border: string;
  keywords: string[];
};

const ALLERGEN_DEFS: AllergenDef[] = [
  { label: "Fisch", bg: "#dbeafe", text: "#1e40af", border: "#93c5fd", keywords: ["salmon", "lachs", "fish", "fisch", "tuna"] },
  { label: "Milch/Laktose", bg: "#e0f2fe", text: "#0c4a6e", border: "#7dd3fc", keywords: ["butter", "cream", "cheese", "käse", "kase", "parmesan", "mozzarella", "mascarpone", "cheddar", "gratin"] },
  { label: "Eier", bg: "#fef9c3", text: "#713f12", border: "#fde047", keywords: ["egg", " ei "] },
  { label: "Gluten", bg: "#fef3c7", text: "#92400e", border: "#fcd34d", keywords: ["burger", "meatball", "breadcrumb"] },
  { label: "Senf", bg: "#f0fdf4", text: "#14532d", border: "#86efac", keywords: ["mustard", "ranch", "senf"] },
  { label: "Sellerie", bg: "#dcfce7", text: "#166534", border: "#6ee7b7", keywords: ["celery", "sellerie"] },
  { label: "Sesam", bg: "#fdf4ff", text: "#581c87", border: "#d8b4fe", keywords: ["sesame", "sesam"] },
  { label: "Soja", bg: "#fff1f2", text: "#881337", border: "#fda4af", keywords: ["soy", "soja", "tofu"] },
];

function detectAllergens(texts: string[]): AllergenDef[] {
  const combined = texts.join(" ").toLowerCase();
  return ALLERGEN_DEFS.filter(({ keywords }) => keywords.some((kw) => combined.includes(kw)));
}

const PLATING_RATE = 1000;          // Portionen pro Linie pro Stunde
const PLATING_STAFF_PER_LINE = 8;   // Empfohlene MA pro aktiver Plating-Linie

// Plating-Startdatum = Fertigstellungsdatum + 1 Produktionstag
function addOneDay(dateNeeded: string): string {
  const { date, run } = parseDateNeeded(dateNeeded);
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 10)} - ${run}`;
}

type PlatingEntry = {
  recipeId: string;
  recipeName: string;
  platingAfter: string;       // letztes Sub-Rezept gesamt
  platingAfterRun1: string;   // letzter Run-1-Abschluss → Plating-Trigger
  subRecipes: string[];
  targetPortions: number;
  allergens: AllergenDef[];
};

type PlatingLineSlot = {
  startDate: string;
  line1: PlatingEntry[];
  line2: PlatingEntry[];
  line1Portions: number;
  line2Portions: number;
  line1Hours: number;
  line2Hours: number;
};

function buildPlatingPlan(allRows: RundmailRow[]): PlatingEntry[] {
  const recipeMap = new Map<string, PlatingEntry>();

  allRows.forEach((row) => {
    const { run } = parseDateNeeded(row.dateNeeded);
    const entry = recipeMap.get(row.recipeId);
    if (!entry) {
      recipeMap.set(row.recipeId, {
        recipeId: row.recipeId,
        recipeName: row.recipeName,
        platingAfter: row.dateNeeded,
        platingAfterRun1: run === 1 ? row.dateNeeded : "",
        subRecipes: [row.subRecipeName],
        targetPortions: row.targetPortions,
        allergens: [],
      });
    } else {
      if (daySortValue(row.dateNeeded) > daySortValue(entry.platingAfter)) {
        entry.platingAfter = row.dateNeeded;
      }
      if (run === 1 && (entry.platingAfterRun1 === "" || daySortValue(row.dateNeeded) > daySortValue(entry.platingAfterRun1))) {
        entry.platingAfterRun1 = row.dateNeeded;
      }
      if (!entry.subRecipes.includes(row.subRecipeName)) {
        entry.subRecipes.push(row.subRecipeName);
      }
      entry.targetPortions = Math.max(entry.targetPortions, row.targetPortions);
    }
  });

  recipeMap.forEach((entry) => {
    entry.allergens = detectAllergens([entry.recipeName, ...entry.subRecipes]);
    if (!entry.platingAfterRun1) entry.platingAfterRun1 = entry.platingAfter;
  });

  return Array.from(recipeMap.values()).sort((a, b) => daySortValue(a.platingAfterRun1) - daySortValue(b.platingAfterRun1));
}

/** Verteilt Rezepte auf 2 Plating-Linien je Run-1-Abschluss-Datum (Load-Balancing) */
/**
 * Gruppiert Rezepte nach Plating-Startdatum für einen bestimmten Run.
 * Ein Rezept kommt in Run-N-Mail wenn sein letztes Sub-Rezept in Run N liegt.
 */
function buildPlatingLineSchedule(platingPlan: PlatingEntry[], targetRun: 1 | 2): PlatingLineSlot[] {
  const byDate = new Map<string, PlatingEntry[]>();
  for (const entry of platingPlan) {
    const { run } = parseDateNeeded(entry.platingAfter);
    if (run !== targetRun) continue;
    const key = entry.platingAfter;
    const list = byDate.get(key) ?? [];
    list.push(entry);
    byDate.set(key, list);
  }

  // Sortiert Einträge nach Allergen-Profil, um Wechsel zu minimieren
  const sortByAllergen = (arr: PlatingEntry[]) =>
    [...arr].sort((a, b) =>
      a.allergens.map(x => x.label).sort().join("|")
        .localeCompare(b.allergens.map(x => x.label).sort().join("|"))
    );

  const result: PlatingLineSlot[] = [];
  for (const [date, entries] of byDate) {
    const sorted = [...entries].sort((a, b) => b.targetPortions - a.targetPortions);
    const line1: PlatingEntry[] = [], line2: PlatingEntry[] = [];
    let p1 = 0, p2 = 0;
    for (const e of sorted) {
      if (p1 <= p2) { line1.push(e); p1 += e.targetPortions; }
      else { line2.push(e); p2 += e.targetPortions; }
    }
    result.push({
      startDate: date,
      line1: sortByAllergen(line1),
      line2: sortByAllergen(line2),
      line1Portions: p1, line2Portions: p2,
      line1Hours: Math.round((p1 / PLATING_RATE) * 10) / 10,
      line2Hours: Math.round((p2 / PLATING_RATE) * 10) / 10,
    });
  }

  return result.sort((a, b) => daySortValue(a.startDate) - daySortValue(b.startDate));
}

function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("not started")) return "bg-rose-100 text-rose-700 ring-rose-200";
  if (normalized.includes("pre blast"))   return "bg-amber-100 text-amber-800 ring-amber-200";
  if (normalized.includes("post blast"))  return "bg-emerald-100 text-emerald-700 ring-emerald-200";
  if (normalized.includes("open"))        return "bg-orange-100 text-orange-700 ring-orange-200";
  if (normalized.includes("picking"))     return "bg-sky-100 text-sky-700 ring-sky-200";
  if (normalized.includes("staged"))      return "bg-violet-100 text-violet-700 ring-violet-200";
  if (normalized.includes("allocation"))  return "bg-pink-100 text-pink-700 ring-pink-200";
  return "bg-slate-200 text-slate-700 ring-slate-300";
}

function buildRun1Mail(run1Rows: RundmailRow[]): string {
  const run1Days = Array.from(new Set(run1Rows.map((row) => row.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));
  const totalTarget = run1Rows.reduce((sum, row) => sum + row.targetPortions, 0);
  const totalCooked = run1Rows.reduce((sum, row) => sum + row.woCookedPortions, 0);
  const totalOpen = run1Rows.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);

  const lines: string[] = [];
  lines.push("# RUN1 Rundmail Produktion");
  lines.push("");
  lines.push("## Executive Summary");
  lines.push(`- RUN1 Work Orders: ${run1Rows.length}`);
  lines.push(`- RUN1 Ziel gesamt: ${fmtInt(totalTarget)}`);
  lines.push(`- RUN1 Gekocht gesamt: ${fmtInt(totalCooked)}`);
  lines.push(`- RUN1 Offener Bedarf: ${fmtInt(totalOpen)}`);
  lines.push("");

  run1Days.forEach((day) => {
    const rows = run1Rows.filter((row) => row.dateNeeded === day);
    const target = rows.reduce((sum, row) => sum + row.targetPortions, 0);
    const cooked = rows.reduce((sum, row) => sum + row.woCookedPortions, 0);
    const open = rows.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);

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
    lines.push(`- Blocked/Open Positionen: ${blocked.length}`);

    if (critical.length) {
      lines.push("- Kritische Defizite:");
      critical.forEach(({ row, deficit }) => {
        const hint = row.workOrderComment ? ` | Hinweis: ${row.workOrderComment}` : "";
        lines.push(`  - WO ${row.workOrderNumber} | ${row.subRecipeName} | Fehlmenge ${fmtInt(deficit)}${hint}`);
      });
    } else {
      lines.push("- Kritische Defizite: keine");
    }

    lines.push("");
  });

  const platingPlan = buildPlatingPlan(run1Rows);
  if (platingPlan.length) {
    lines.push("## Plating-Plan");
    lines.push("(Fruehester Plating-Start je Rezept — nach letztem Sub-Rezept)");
    lines.push("");
    platingPlan.forEach((entry) => {
      const allergenText = entry.allergens.map((a) => a.label).join(", ") || "keine bekannten";
      lines.push(`- **${entry.recipeName}** → Plating ab: ${entry.platingAfter} | Allergene: ${allergenText}`);
    });
    lines.push("");
  }

  lines.push(`_${new Date().toLocaleString("de-DE")}_`);

  return lines.join("\n");
}

// ── Colour palette (shared across sections) ──────────────────────────────────
const C = {
  navy: "#0f172a", navyMid: "#1e293b", navyLight: "#334155",
  sky: "#0ea5e9", skyDark: "#0369a1",
  emerald: "#10b981", emeraldDark: "#166534", emeraldBg: "#f0fdf4",
  amber: "#f59e0b", amberDark: "#92400e", amberBg: "#fffbeb",
  red: "#ef4444", redDark: "#991b1b", redBg: "#fef2f2",
  slate: "#64748b", slateLight: "#94a3b8", slateBg: "#f8fafc",
  border: "#e2e8f0", white: "#ffffff",
};

function buildRunHtmlMail(allRows: RundmailRow[], sourceLabel: string, weeklyPlanning: WeeklyPlanningData | null | undefined, targetRun: 1 | 2, toolLinks: { whatIf: string; breakdown: string } = { whatIf: "", breakdown: "" }): string {
  const isTargetRun = (dateNeeded: string) => parseDateNeeded(dateNeeded).run === targetRun;
  const targetRunRows = allRows.filter((row) => isTargetRun(row.dateNeeded));
  // Küchen-Plan nur für diesen Run; alle Tage/Runs für den kompletten Plan-Kontext
  const allDays = Array.from(new Set(allRows.filter(r => isTargetRun(r.dateNeeded)).map((row) => row.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));
  const platingPlan = buildPlatingPlan(allRows);

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
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#64748b;">${escapeHtml(row.cookMethods || "–")}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:${row.kitchenStatus?.toLowerCase().includes("not started") ? "#991b1b" : row.kitchenStatus?.toLowerCase().includes("post blast") ? "#166534" : "#334155"};white-space:nowrap;">${escapeHtml(row.kitchenStatus || "–")}</td>
        </tr>`).join("");

      return `
        <tr style="background:${recipeHeaderBg};">
          <td colspan="5" style="padding:7px 10px 5px 10px;border-top:1px solid #e2e8f0;">
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

    const platingFrom = addOneDay(day);
    const { date: platingDate } = parseDateNeeded(platingFrom);

    return `
    <tr><td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#ffffff;">
        <tr><td style="background:#1e293b;padding:8px 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td>
              <span style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#ffffff;">${escapeHtml(date)} &mdash; Run&nbsp;${run}</span>
              <span style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#94a3b8;margin-left:12px;">${uniqueRecipeCount} Rezepte &middot; ${totalSubCount} WOs &middot; ${fmtInt(dayTarget)} Portionen &middot; <strong style="color:#fbbf24;">${totalSubCount + 1} MA</strong></span>
            </td>
            <td align="right" style="white-space:nowrap;">
              <span style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#7dd3fc;">&#128197; Plating ab: ${escapeHtml(platingDate)}</span>
            </td>
          </tr></table>
        </td></tr>
        <tr><td>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">WO</th>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Sub-Rezept</th>
              <th align="right" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Target</th>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Cook-Methoden</th>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Status</th>
            </tr>
            ${recipeSections}
          </table>
        </td></tr>
      </table>
    </td></tr>`;
  }).join("");

  // Section B: Plating-Plan — 2 Linien, je 1.000 Portionen/h, verteilt nach Run-1-Abschluss
  const platingSchedule = buildPlatingLineSchedule(platingPlan, targetRun);

  function recipeCard(entry: PlatingEntry, lineColor: string) {
    const badges = entry.allergens.map((a) =>
      `<span style="display:inline-block;background:${a.bg};color:${a.text};border:1px solid ${a.border};border-radius:3px;padding:1px 5px;font-size:10px;font-weight:700;margin:1px 2px;">${escapeHtml(a.label)}</span>`
    ).join("") || `<span style="font-size:10px;color:${C.slateLight};">–</span>`;
    const hours = (entry.targetPortions / PLATING_RATE).toFixed(1);
    return `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${C.border};border-left:3px solid ${lineColor};border-radius:0 8px 8px 0;background:${C.white};margin-bottom:6px;">
        <tr><td style="padding:8px 10px;">
          <div style="font-size:12px;font-weight:700;color:${C.navy};">${escapeHtml(entry.recipeName.replace(/\s*\[.*?\]/g, ""))}</div>
          <div style="font-size:10px;color:${C.slate};margin-top:2px;">
            ${escapeHtml(entry.recipeId)} &middot; <strong style="color:${C.navy};">${fmtInt(entry.targetPortions)}</strong> Portionen &middot; ${entry.subRecipes.length} Sub-Rezepte &middot; <strong style="color:${lineColor};">${hours} h</strong>
          </div>
          <div style="margin-top:4px;">
            <span style="display:inline-block;background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:4px;padding:2px 8px;font-size:10px;font-weight:800;">&#128101; ${entry.subRecipes.length + 1} MA ben&ouml;tigt</span>
          </div>
          <div style="margin-top:4px;">${badges}</div>
        </td></tr>
      </table>`;
  }

  const platingPlanHtml = platingSchedule.map((slot) => {
    const { date: completionDate, run } = parseDateNeeded(slot.startDate);
    const platingDate = parseDateNeeded(addOneDay(slot.startDate)).date;
    const totalPortions = slot.line1Portions + slot.line2Portions;
    const maxHours = Math.max(slot.line1Hours, slot.line2Hours);
    const parallelHours = Math.round((totalPortions / (2 * PLATING_RATE)) * 10) / 10;
    const activeLinesCount = (slot.line1.length > 0 ? 1 : 0) + (slot.line2.length > 0 ? 1 : 0);
    const recommendedStaff = activeLinesCount * PLATING_STAFF_PER_LINE;
    // MA-Bedarf nach Sub-Rezept-Formel: jedes Rezept braucht (sub_rezepte + 1) MA
    const maBySubRecipe = [...slot.line1, ...slot.line2].reduce((s, e) => s + e.subRecipes.length + 1, 0);

    // Reinigungsmarker zwischen Rezepten mit unterschiedlichem Allergen-Profil
    function renderLineWithMarkers(entries: PlatingEntry[], lineColor: string): string {
      return entries.map((entry, idx) => {
        const card = recipeCard(entry, lineColor);
        if (idx >= entries.length - 1) return card;
        const next = entries[idx + 1];
        const cur = new Set(entry.allergens.map(a => a.label));
        const nxt = new Set(next.allergens.map(a => a.label));
        const removed = [...cur].filter(l => !nxt.has(l));
        const added = [...nxt].filter(l => !cur.has(l));
        if (removed.length === 0 && added.length === 0) return card;
        const details = [
          removed.length > 0 ? `entfernt: <strong>${removed.join(", ")}</strong>` : "",
          added.length > 0 ? `kommt: <strong>${added.join(", ")}</strong>` : "",
        ].filter(Boolean).join(" &middot; ");
        return card + `<div style="margin:3px 0 5px 0;padding:5px 10px;background:#fef9c3;border:1px dashed #f59e0b;border-radius:6px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#78350f;font-weight:600;">
          &#9888;&nbsp;<strong>LINIE REINIGEN</strong> — Allergen-Wechsel: ${details}
        </div>`;
      }).join("");
    }

    // Zähle Allergen-Wechsel pro Linie für den Header
    const countSwitches = (entries: PlatingEntry[]) => entries.reduce((n, e, i) => {
      if (i === 0) return n;
      const prev = new Set(entries[i-1].allergens.map(a => a.label));
      const cur = new Set(e.allergens.map(a => a.label));
      return n + ([...cur].some(l => !prev.has(l)) || [...prev].some(l => !cur.has(l)) ? 1 : 0);
    }, 0);
    const switches1 = countSwitches(slot.line1);
    const switches2 = countSwitches(slot.line2);
    const totalSwitches = switches1 + switches2;

    const line1Cards = renderLineWithMarkers(slot.line1, C.sky);
    const line2Cards = renderLineWithMarkers(slot.line2, C.emerald);
    return `
    <tr><td style="padding:0 0 16px 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${C.border};border-radius:10px;overflow:hidden;background:${C.slateBg};">
        <!-- Slot Header -->
        <tr><td colspan="2" style="background:${C.navy};padding:10px 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td>
              <div style="font-size:13px;font-weight:800;color:${C.white};">&#128197; Plating ab ${escapeHtml(platingDate)} &mdash; Run ${run}</div>
              <div style="font-size:11px;color:#93c5fd;margin-top:2px;">
                Fertigstellung: ${escapeHtml(completionDate)} &middot; ${slot.line1.length + slot.line2.length} Rezepte &middot; ${fmtInt(totalPortions)} Portionen &middot; <strong style="color:#fbbf24;">&#128101; ${maBySubRecipe} MA (Sub-Rezept-Formel)</strong> &middot; Plating-Linien: ~${recommendedStaff} MA (${activeLinesCount}&times;${PLATING_STAFF_PER_LINE}) &middot; ${totalSwitches > 0 ? `<span style="color:#fcd34d;">&#9888; ${totalSwitches} Allergen-Wechsel</span>` : `<span style="color:#6ee7b7;">&#10003; keine Allergen-Wechsel</span>`}
              </div>
              ${totalSwitches > 0 ? `<div style="margin-top:6px;padding:5px 10px;background:rgba(251,191,36,0.15);border:1px solid rgba(251,191,36,0.4);border-radius:6px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#fef3c7;font-weight:600;">&#9888;&nbsp;ALLERGEN-SICHERHEIT: Bei jedem Meal-Wechsel mit anderen Allergenen Linie vollst&auml;ndig reinigen. Gleiche Allergene wurden gebündelt um Wechsel zu minimieren.</div>` : ""}
            </td>
            <td align="right" style="white-space:nowrap;vertical-align:middle;">
              <div style="display:inline-block;background:rgba(255,255,255,0.12);border-radius:8px;padding:6px 12px;text-align:center;">
                <div style="font-size:9px;color:#93c5fd;letter-spacing:0.1em;text-transform:uppercase;">Parallel (${activeLinesCount} Linien)</div>
                <div style="font-size:18px;font-weight:900;color:${C.white};">${parallelHours} h</div>
                <div style="font-size:9px;color:#93c5fd;">statt ${maxHours} h / Linie</div>
              </div>
            </td>
          </tr></table>
        </td></tr>
        <!-- Two Lines -->
        <tr>
          <td width="50%" style="padding:10px 10px 10px 14px;vertical-align:top;border-right:1px solid ${C.border};">
            <div style="font-size:10px;font-weight:800;color:${C.sky};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">
              Linie 1 &mdash; ${fmtInt(slot.line1Portions)} Portionen &mdash; ${slot.line1Hours} h &mdash; ~${slot.line1.length > 0 ? PLATING_STAFF_PER_LINE : 0} MA
            </div>
            ${line1Cards || `<div style="font-size:11px;color:${C.slateLight};padding:8px 0;">–</div>`}
          </td>
          <td width="50%" style="padding:10px 14px 10px 10px;vertical-align:top;">
            <div style="font-size:10px;font-weight:800;color:${C.emerald};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">
              Linie 2 &mdash; ${fmtInt(slot.line2Portions)} Portionen &mdash; ${slot.line2Hours} h &mdash; ~${slot.line2.length > 0 ? PLATING_STAFF_PER_LINE : 0} MA
            </div>
            ${line2Cards || `<div style="font-size:11px;color:${C.slateLight};padding:8px 0;">–</div>`}
          </td>
        </tr>
        <!-- Progress bars -->
        <tr><td colspan="2" style="padding:8px 14px 10px 14px;">
          <table width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td width="50%" style="padding-right:6px;">
                <div style="font-size:9px;color:${C.slate};margin-bottom:2px;">Linie 1 Auslastung</div>
                ${capBar(slot.line1Portions, totalPortions, 5)}
              </td>
              <td width="50%" style="padding-left:6px;">
                <div style="font-size:9px;color:${C.slate};margin-bottom:2px;">Linie 2 Auslastung</div>
                ${capBar(slot.line2Portions, totalPortions, 5)}
              </td>
            </tr>
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

  // Section D: Allergen summary table
  // @ts-expect-error unused
  const _allergenTableHtml = platingPlan.map((entry) => {
    const allergenText = entry.allergens.map((a) => a.label).join(", ") || "–";
    const hasHighRisk = entry.allergens.some((a) => a.label === "Fisch");
    return `
    <tr>
      <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#0f172a;">${escapeHtml(entry.recipeName.split(" - ")[0] ?? entry.recipeName)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-family:Segoe UI,Arial,sans-serif;font-size:11px;text-align:right;color:#334155;">${fmtInt(entry.targetPortions)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #f1f5f9;font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:600;color:${hasHighRisk ? "#991b1b" : "#334155"};">${escapeHtml(allergenText)}</td>
    </tr>`;
  }).join("");

  // ── Extra KPIs from weekly planning ─────────────────────────────────────────
  const uniqueRecipes   = new Set(allRows.map(r => r.recipeId)).size;
  const totalSubRecipes = allRows.length;
  const totalKetPortions = dedupedRun.reduce((s, r) => s + r.targetPortions, 0);
  const uniqueAllergens = new Set(platingPlan.flatMap(p => p.allergens.map(a => a.label))).size;
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
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Produktions-Rundmail ${runLabel} KW${weeklyPlanning?.cw ?? ""}</title></head>
<body style="margin:0;padding:16px;background:#cbd5e1;font-family:Segoe UI,Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:980px;margin:0 auto;">

  <!-- ═══════════════════ HEADER ═══════════════════ -->
  <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#0c4a6e 100%);border-radius:16px 16px 0 0;padding:28px 28px 24px 28px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td>
        <div style="font-size:10px;letter-spacing:0.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:8px;">Factor OPS &middot; Standort Verden &middot; Produktion</div>
        <div style="font-size:28px;font-weight:900;color:#ffffff;line-height:1.1;letter-spacing:-0.02em;">Produktions-Rundmail &mdash; ${runLabel}</div>
        <div style="font-size:16px;font-weight:400;color:#93c5fd;margin-top:4px;">K&uuml;chen-Plan &middot; Plating (2 Linien) &middot; Kapazit&auml;t &middot; Allergene</div>
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
        ${kpiCell("Nächstes Plating", platingPlan.length > 0 ? escapeHtml(parseDateNeeded(addOneDay(platingPlan[0].platingAfterRun1)).date) : "–", C.skyDark, platingPlan.length > 0 ? `${platingPlan.length} Rezepte ab diesem Tag` : "kein Plating")}
        ${kpiCell("Allergene erkannt", String(uniqueAllergens), uniqueAllergens > 0 ? C.red : C.emeraldDark, uniqueAllergens > 0 ? `${platingPlan.filter(p => p.allergens.length > 0).length} betroffene Rezepte` : "keine Allergene")}
        ${kpiCell("Peak-Personal", maxDayStaff > 0 ? maxDayStaff.toFixed(0) : "–", C.navy, refLabel)}
        ${kpiCell("Rezepte / Sub-Rezepte", `${uniqueRecipes} / ${totalSubRecipes}`, C.navyLight, `${fmtInt(totalKetPortions)} Portionen Küche`)}
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

  <!-- ═══════════════════ PLATING-PLAN ═══════════════════ -->
  <tr><td style="background:#ffffff;padding:20px 24px 8px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
    ${sectionHeader(`Plating-Plan &mdash; ${runLabel} &mdash; 2 Linien`, `Plating startet immer am n&auml;chsten Produktionstag nach Fertigstellung &middot; ${PLATING_RATE.toLocaleString()} Portionen/Linie/h &middot; ~${PLATING_STAFF_PER_LINE} MA/Linie`, C.sky)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      ${platingPlanHtml}
    </table>
  </td></tr>

  <!-- ═══════════════════ ALLERGEN-ÜBERSICHT ═══════════════════ -->
  <tr><td style="background:#ffffff;padding:20px 24px 20px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
    ${sectionHeader("Allergen-&Uuml;bersicht", "Automatisch erkannte Hauptallergene je Rezept (EU-Verordnung 1169/2011)", C.red)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #fecaca;border-radius:10px;overflow:hidden;">
      <tr>
        <th align="left" style="padding:8px 12px;background:#fef2f2;font-size:10px;color:${C.redDark};text-transform:uppercase;letter-spacing:0.08em;">Rezept</th>
        <th align="left" style="padding:8px 12px;background:#fef2f2;font-size:10px;color:${C.redDark};text-transform:uppercase;letter-spacing:0.08em;">Plating ab (n&auml;chster Tag)</th>
        <th align="right" style="padding:8px 12px;background:#fef2f2;font-size:10px;color:${C.redDark};text-transform:uppercase;letter-spacing:0.08em;">Portionen</th>
        <th align="left" style="padding:8px 12px;background:#fef2f2;font-size:10px;color:${C.redDark};text-transform:uppercase;letter-spacing:0.08em;">Allergene</th>
      </tr>
      ${platingPlan.map((entry, idx) => {
        const hasFish = entry.allergens.some(a => a.label === "Fisch");
        const badges = entry.allergens.map(a =>
          `<span style="display:inline-block;background:${a.bg};color:${a.text};border:1px solid ${a.border};border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin:1px 2px;">${a.label}</span>`
        ).join("") || `<span style="font-size:10px;color:${C.slateLight};">–</span>`;
        const bg = idx % 2 === 0 ? C.white : C.slateBg;
        const platingDate = parseDateNeeded(addOneDay(entry.platingAfterRun1)).date;
        return `<tr style="background:${bg};">
          <td style="padding:8px 12px;font-size:11px;font-weight:600;color:${C.navy};">${escapeHtml(entry.recipeName.split(" - ")[0] ?? entry.recipeName)}</td>
          <td style="padding:8px 12px;font-size:11px;color:${C.sky};font-weight:700;white-space:nowrap;">&#128197; ${escapeHtml(platingDate)}</td>
          <td style="padding:8px 12px;font-size:11px;color:${C.navyLight};text-align:right;">${fmtInt(entry.targetPortions)}</td>
          <td style="padding:8px 12px;">${hasFish ? `<span style="color:${C.red};font-size:11px;font-weight:800;margin-right:4px;">&#9888;</span>` : ""}${badges}</td>
        </tr>`;
      }).join("")}
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

function downloadFile(name: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob(["\uFEFF", content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function RundmailView({ onNavigate }: { onNavigate?: (view: string) => void } = {}) {
  const [rows, setRows] = useState<RundmailRow[]>([]);
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [isDragging, setIsDragging] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("Seed: public/data/rundmail-seed.csv");
  const [mailText, setMailText] = useState("");
  const [weeklyPlanning, setWeeklyPlanning] = useState<WeeklyPlanningData | null>(null);
  // Basis-URL für interne Tool-Links im HTML-Export.
  // Im Build: VITE_APP_URL setzen (z.B. https://myapp.example.com). Fallback: aktuelle Origin.
  const appOrigin = ((import.meta.env.VITE_APP_URL as string) || "").replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/data/rundmail-seed.csv", { cache: "no-store" });
        if (!response.ok) throw new Error(`Seed CSV konnte nicht geladen werden: ${response.status}`);
        const csvText = await response.text();
        if (cancelled) return;
        const parsedRows = parseSeedCsv(csvText);
        setRows(parsedRows);
      } catch {
        if (!cancelled) {
          setRows([]);
          setSourceLabel("⚠ Seed-CSV konnte nicht geladen werden — bitte CSV manuell hochladen.");
        }
      }
    })();

    (async () => {
      try {
        const res = await fetch("/data/weekly-planning.json", { cache: "no-store" });
        if (!res.ok) return;
        const data: WeeklyPlanningData = await res.json();
        if (!cancelled) setWeeklyPlanning(data);
      } catch {
        // weekly-planning.json optional – kein Fehler
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const days = useMemo(() => {
    const run1Days = Array.from(new Set(rows.filter((row) => isRun1(row.dateNeeded)).map((row) => row.dateNeeded))).sort(
      (a, b) => daySortValue(a) - daySortValue(b)
    );
    if (run1Days.length) return run1Days;
    return Array.from(new Set(rows.map((row) => row.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));
  }, [rows]);

  const run1Rows = useMemo(() => rows.filter((row) => isRun1(row.dateNeeded)), [rows]);

  useEffect(() => {
    if (!days.length) {
      setSelectedDays(new Set());
      return;
    }
    // Beim ersten Laden alle Tage vorauswählen; ungültige Tage rauswerfen
    setSelectedDays((prev) => {
      if (prev.size === 0) return new Set(days);
      const valid = days.filter((d) => prev.has(d));
      return valid.length ? new Set(valid) : new Set(days);
    });
  }, [days]);

  const rowsByDay = useMemo(() => {
    const map = new Map<string, RundmailRow[]>();
    rows.forEach((row) => {
      const list = map.get(row.dateNeeded) ?? [];
      list.push(row);
      map.set(row.dateNeeded, list);
    });
    return map;
  }, [rows]);

  const visibleRows = useMemo(() => {
    const base = selectedDays.size > 0 ? rows.filter((row) => selectedDays.has(row.dateNeeded)) : rows;

    return base.filter((row) => {
      const haystack = [
        row.workOrderNumber,
        row.recipeName,
        row.subRecipeName,
        row.workOrderComment,
        row.stagingComment,
        row.kitchenStatus,
      ]
        .join(" ")
        .toLowerCase();

      const needle = searchText.trim().toLowerCase();
      const searchPass = !needle || haystack.includes(needle);
      const statusPass = statusFilter === "all" || row.kitchenStatus === statusFilter;
      return searchPass && statusPass;
    });
  }, [rows, searchText, selectedDays, statusFilter]);

  const summary = useMemo(() => {
    // Deduplizierung: Target und Cooked nur einmal pro Rezept zählen,
    // da alle Sub-Rezepte desselben Rezepts identische Portionszahlen haben.
    const seen = new Map<string, RundmailRow>();
    visibleRows.forEach((row) => {
      const prev = seen.get(row.recipeId);
      if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
    });
    const deduped = Array.from(seen.values());
    return deduped.reduce(
      (acc, row) => {
        acc.target += row.targetPortions;
        acc.cooked += row.woCookedPortions;
        acc.open += toSlack(row.targetPortions - row.woCookedPortions);
        acc.minNeeds += row.minimumNeeds;
        return acc;
      },
      { target: 0, cooked: 0, open: 0, minNeeds: 0 }
    );
  }, [visibleRows]);

  const run1Summary = useMemo(() => {
    const seen = new Map<string, RundmailRow>();
    run1Rows.forEach((row) => {
      const prev = seen.get(row.recipeId);
      if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
    });
    return Array.from(seen.values()).reduce(
      (acc, row) => {
        acc.target += row.targetPortions;
        acc.cooked += row.woCookedPortions;
        return acc;
      },
      { target: 0, cooked: 0 }
    );
  }, [run1Rows]);

  const selectedDayRows = useMemo(() => {
    if (!selectedDays.size) return [];
    return rows.filter((row) => selectedDays.has(row.dateNeeded));
  }, [rows, selectedDays]);

  const selectedDayStatus = useMemo(() => {
    return selectedDayRows.reduce<Record<string, number>>((acc, row) => {
      const key = row.kitchenStatus || "Unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  }, [selectedDayRows]);

  const selectedDayTopDeficits = useMemo<DeficitItem[]>(() => {
    return selectedDayRows
      .map((row) => ({ row, deficit: toSlack(row.targetPortions - row.woCookedPortions) }))
      .filter((item) => item.deficit > 0)
      .sort((a, b) => b.deficit - a.deficit)
      .slice(0, 6);
  }, [selectedDayRows]);

  const completionRate = useMemo(() => {
    if (run1Summary.target <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((run1Summary.cooked / run1Summary.target) * 100)));
  }, [run1Summary.cooked, run1Summary.target]);

  const dayCards = useMemo(() => {
    return days.map((day) => {
      const dayRows = rowsByDay.get(day) ?? [];
      const seen = new Map<string, RundmailRow>();
      dayRows.forEach((row) => {
        const prev = seen.get(row.recipeId);
        if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
      });
      const deduped = Array.from(seen.values());
      const target = deduped.reduce((sum, row) => sum + row.targetPortions, 0);
      const cooked = deduped.reduce((sum, row) => sum + row.woCookedPortions, 0);
      const open = deduped.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);
      return { day, count: dayRows.length, target, cooked, open };
    });
  }, [days, rowsByDay]);

  useEffect(() => {
    if (!run1Rows.length) {
      setMailText("");
      return;
    }
    setMailText(buildRun1Mail(run1Rows));
  }, [run1Rows]);

  function applyCsvText(csvText: string, label: string) {
    const parsedRows = parseSeedCsv(csvText);
    setRows(parsedRows);
    setSourceLabel(label);
  }

  function onFileSelected(file: File | null) {
    if (!file) return;
    file
      .text()
      .then((csvText) => applyCsvText(csvText, `Upload: ${file.name}`))
      .catch(() => {
        setSourceLabel(`Upload fehlgeschlagen: ${file.name}`);
      });
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    onFileSelected(file);
  }

  function updateRow(id: string, patch: Partial<Pick<RundmailRow, "kitchenStatus" | "stagingStatus" | "workOrderComment" | "stagingComment">>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function copyCurrentMail() {
    if (!mailText) return;
    void navigator.clipboard.writeText(mailText);
  }

  // @ts-expect-error unused
  const _run1Mail = useMemo(() => buildRun1Mail(run1Rows), [run1Rows]);
  const toolLinks = useMemo(() => ({
    whatIf: appOrigin + "?view=whatif",
    breakdown: appOrigin + "?view=breakdown",
  }), [appOrigin]);
  const run1HtmlMail = useMemo(() => buildRunHtmlMail(rows, sourceLabel, weeklyPlanning, 1, toolLinks), [rows, sourceLabel, weeklyPlanning, toolLinks]);
  const run2HtmlMail = useMemo(() => buildRunHtmlMail(rows, sourceLabel, weeklyPlanning, 2, toolLinks), [rows, sourceLabel, weeklyPlanning, toolLinks]);

  const kitchenStatuses = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((row) => {
      if (row.kitchenStatus) set.add(row.kitchenStatus);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  return (
    <div className="space-y-4 rundmail-page">
      <section className="card p-4 rundmail-hero">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* ── Titel & Status-Chips ── */}
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em] text-orange-700">Factor OPS · Verden · Produktionsplanung</div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight mt-0.5">Tägliche Produktions-Rundmail</h2>
            <p className={`text-xs mt-1 ${sourceLabel.startsWith("⚠") ? "text-red-600 font-semibold" : "text-slate-500"}`}>{sourceLabel}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="rundmail-chip">RUN1: {run1Rows.length} WOs</span>
              <span className="rundmail-chip-soft">Completion: {completionRate}%</span>
              {weeklyPlanning ? (
                <span className="rundmail-chip-soft" title={weeklyPlanning.referenceNote}>
                  {weeklyPlanning.isReference ? "⚠ " : "✓ "}KW{weeklyPlanning.cw} geladen
                </span>
              ) : (
                <span className="rundmail-chip-soft text-slate-400">Wochenplan fehlt</span>
              )}
            </div>
          </div>

          {/* ── Button-Gruppen ── */}
          <div className="flex flex-col gap-2 shrink-0">
            {/* Gruppe 1: Daten */}
            <div className="flex flex-wrap gap-1.5">
              <button className="btn" onClick={() => fileInputRef.current?.click()}>
                📂 CSV auswählen
              </button>
              <button className="btn" onClick={copyCurrentMail} disabled={!mailText}>
                📋 Markdown
              </button>
            </div>
            {/* Gruppe 2: Tools */}
            <div className="flex flex-wrap gap-1.5">
              <button
                className="btn text-blue-700 bg-blue-50 border-blue-200"
                onClick={() => onNavigate?.("whatif")}
              >
                📈 What-If
              </button>
              <button
                className="btn text-emerald-700 bg-emerald-50 border-emerald-200"
                onClick={() => onNavigate?.("breakdown")}
              >
                🔢 Breakdown
              </button>
            </div>
            {/* Gruppe 3: Mail-Export */}
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 self-center">Export:</span>
              <button className="btn" onClick={() => downloadFile("Run1_Rundmail.html", run1HtmlMail, "text/html;charset=utf-8")} disabled={!run1Rows.length}>
                R1 HTML
              </button>
              <button
                className="btn btn-primary"
                onClick={() => { if (!run1Rows.length) return; const blob = new Blob(["﻿", run1HtmlMail], { type: "text/html;charset=utf-8" }); const url = URL.createObjectURL(blob); window.open(url, "_blank"); setTimeout(() => URL.revokeObjectURL(url), 10000); }}
                disabled={!run1Rows.length}
                title="Im Browser öffnen → Strg+A → Strg+C → in Gmail"
              >
                R1 → Gmail
              </button>
              <button className="btn" onClick={() => downloadFile("Run2_Rundmail.html", run2HtmlMail, "text/html;charset=utf-8")} disabled={!rows.length}>
                R2 HTML
              </button>
              <button
                className="btn btn-primary"
                onClick={() => { if (!rows.length) return; const blob = new Blob(["﻿", run2HtmlMail], { type: "text/html;charset=utf-8" }); const url = URL.createObjectURL(blob); window.open(url, "_blank"); setTimeout(() => URL.revokeObjectURL(url), 10000); }}
                disabled={!rows.length}
                title="Im Browser öffnen → Strg+A → Strg+C → in Gmail"
              >
                R2 → Gmail
              </button>
            </div>
          </div>
        </div>
        <input ref={fileInputRef} className="hidden" type="file" accept=".csv,text/csv" onChange={(event) => onFileSelected(event.target.files?.[0] ?? null)} />

        <div
          className={`mt-3 rounded-xl border-2 border-dashed p-4 text-sm transition-colors ${
            isDragging ? "border-cyan-500 bg-cyan-50 text-cyan-900" : "border-slate-300 bg-slate-50 text-slate-600"
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
        >
          CSV per Drag-and-Drop hier ablegen. Danach wird die RUN1 Rundmail automatisch erzeugt.
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
            <span>RUN1 Fertigstellungsquote (Cooked zu Target)</span>
            <span className="font-semibold text-slate-900">{completionRate}%</span>
          </div>
          <div className="h-2 rounded-full bg-white/70 ring-1 ring-slate-200 overflow-hidden">
            <div className="h-full rundmail-progress" style={{ width: `${completionRate}%` }} />
          </div>
        </div>
      </section>

      <section className="card p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 mb-2">RUN1 Timeline</div>
        <div className="grid gap-2 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
          {dayCards.map((card) => (
            <button
              key={card.day}
              onClick={() => setSelectedDays((prev) => {
                const next = new Set(prev);
                if (next.has(card.day)) next.delete(card.day); else next.add(card.day);
                return next;
              })}
              className={`text-left rounded-xl p-3 ring-1 transition-all hover:-translate-y-0.5 ${
                selectedDays.has(card.day)
                  ? "bg-slate-900 text-white ring-slate-800 shadow-lg"
                  : "bg-gradient-to-br from-white to-slate-50 ring-slate-200 text-slate-800"
              }`}
            >
              <div className="text-[11px] uppercase tracking-wide opacity-80">{card.day}</div>
              <div className="mt-1 text-xl font-bold">{fmtInt(card.open)}</div>
              <div className="text-[11px] opacity-80">Offen</div>
              <div className="mt-2 text-[11px] opacity-80">{card.count} RUN1 WOs · Target {fmtInt(card.target)}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Tag / Date Needed</div>
            <div className="flex flex-wrap gap-1.5">
              <button
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 transition-colors ${
                  selectedDays.size === days.length
                    ? "bg-slate-900 text-white ring-slate-800"
                    : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50"
                }`}
                onClick={() => setSelectedDays(new Set(days))}
              >
                Alle
              </button>
              {days.map((day) => (
                <button
                  key={day}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 transition-colors ${
                    selectedDays.has(day)
                      ? "bg-slate-900 text-white ring-slate-800"
                      : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50"
                  }`}
                  onClick={() => setSelectedDays((prev) => {
                    const next = new Set(prev);
                    if (next.has(day)) next.delete(day); else next.add(day);
                    return next;
                  })}
                >
                  {day} <span className="opacity-60">({rowsByDay.get(day)?.length ?? 0})</span>
                </button>
              ))}
            </div>
          </div>

          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Kitchen Status
            <select
              className="mt-1 block min-w-[12rem] rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            >
              <option value="all">Alle</option>
              {kitchenStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex-1 min-w-[16rem]">
            Suche
            <input
              className="mt-1 w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
              placeholder="WO, Rezept, Sub-Rezept, Kommentar"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </label>
        </div>

        <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <div className="rounded-xl bg-gradient-to-br from-slate-50 to-white ring-1 ring-slate-200 p-3">
            <div className="text-xs text-slate-500">Target Portions</div>
            <div className="text-2xl font-bold text-slate-900">{fmtInt(summary.target)}</div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-emerald-50 to-white ring-1 ring-emerald-200 p-3">
            <div className="text-xs text-slate-500">Cooked Portions</div>
            <div className="text-2xl font-bold text-emerald-700">{fmtInt(summary.cooked)}</div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-amber-50 to-white ring-1 ring-amber-200 p-3">
            <div className="text-xs text-amber-700">Offen (Defizit)</div>
            <div className="text-2xl font-bold text-amber-800">{fmtInt(summary.open)}</div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-cyan-50 to-white ring-1 ring-cyan-200 p-3">
            <div className="text-xs text-cyan-700">Minimum Needs</div>
            <div className="text-2xl font-bold text-cyan-900">{fmtInt(summary.minNeeds)}</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 mb-2">Status-Verteilung</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(selectedDayStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <span key={status} className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${statusTone(status)}`}>
                    {status}: {count}
                  </span>
                ))}
            </div>
          </div>

          <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-rose-700 mb-2">Top-Defizite des Tages</div>
            <div className="space-y-1.5">
              {selectedDayTopDeficits.length ? selectedDayTopDeficits.map(({ row, deficit }) => (
                <div key={row.id} className="flex items-start justify-between gap-3 rounded-lg bg-white/80 ring-1 ring-rose-100 px-2 py-1.5 text-xs">
                  <div>
                    <div className="font-semibold text-slate-800">WO {row.workOrderNumber}</div>
                    <div className="text-slate-600 line-clamp-1">{row.subRecipeName}</div>
                  </div>
                  <div className="font-bold text-rose-700">-{fmtInt(deficit)}</div>
                </div>
              )) : <div className="text-xs text-slate-600">Keine offenen Defizite fuer den ausgewaehlten Tag.</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className="px-2 py-2 text-left">WO</th>
                <th className="px-2 py-2 text-left">Recipe</th>
                <th className="px-2 py-2 text-left">Sub Recipe</th>
                <th className="px-2 py-2 text-right">Target</th>
                <th className="px-2 py-2 text-right">Cooked</th>
                <th className="px-2 py-2 text-right">Delta</th>
                <th className="px-2 py-2 text-left">Kitchen</th>
                <th className="px-2 py-2 text-left">Staging</th>
                <th className="px-2 py-2 text-left">ETA</th>
                <th className="px-2 py-2 text-left">Kommentar</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const delta = row.woCookedPortions - row.targetPortions;
                return (
                  <tr key={row.id} className="border-t border-slate-100 align-top">
                    <td className="px-2 py-2 whitespace-nowrap font-medium text-slate-800">{row.workOrderNumber}</td>
                    <td className="px-2 py-2 text-slate-700">{row.recipeName}</td>
                    <td className="px-2 py-2 text-slate-700">{row.subRecipeName}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{fmtInt(row.targetPortions)}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{fmtInt(row.woCookedPortions)}</td>
                    <td className={`px-2 py-2 text-right font-semibold ${delta < 0 ? "text-amber-700" : "text-emerald-700"}`}>
                      {fmtInt(delta)}
                    </td>
                    <td className="px-2 py-2 min-w-[10rem]">
                      <input
                        className="w-full rounded border border-slate-300 px-2 py-1"
                        value={row.kitchenStatus}
                        onChange={(event) => updateRow(row.id, { kitchenStatus: event.target.value })}
                      />
                      <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusTone(row.kitchenStatus || "")}`}>
                        {row.kitchenStatus || "Unknown"}
                      </span>
                    </td>
                    <td className="px-2 py-2 min-w-[10rem]">
                      <input
                        className="w-full rounded border border-slate-300 px-2 py-1"
                        value={row.stagingStatus}
                        onChange={(event) => updateRow(row.id, { stagingStatus: event.target.value })}
                      />
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-slate-600">{row.unlockedEta || "-"}</td>
                    <td className="px-2 py-2 min-w-[15rem]">
                      <input
                        className="w-full rounded border border-slate-300 px-2 py-1"
                        value={row.workOrderComment}
                        onChange={(event) => updateRow(row.id, { workOrderComment: event.target.value })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-4 bg-gradient-to-br from-slate-950 to-slate-900 text-slate-100">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-white">Mail Vorschau (Markdown)</h3>
          <span className="text-xs text-slate-300">Markdown + Premium HTML Export bereit fuer Versand</span>
        </div>
        <textarea
          className="mt-3 w-full min-h-[18rem] rounded-lg border border-slate-700 bg-slate-900 p-3 font-mono text-xs text-slate-100"
          value={mailText}
          onChange={(event) => setMailText(event.target.value)}
        />
      </section>
    </div>
  );
}
