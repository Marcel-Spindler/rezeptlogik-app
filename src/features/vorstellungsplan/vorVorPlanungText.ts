// Vor-Vor-Planung — Marcels erster Freigabeschritt, VOR der eigentlichen
// Vorstellung. Screenshot + GSheet-Link kommen von Marcel selbst dazu.
// Klartext zum Copy-Paste in Teams/Slack/Email.
//
// KPI-Vergleich: wenn Vorwochen-Daten verfügbar sind, zeigt der Text
// automatisch Week-over-Week Deltas (Cup-Meals, Portionen, Stationen).
// "Neue Meals" per Code-Diff mit Caveat bei starker Rotation (>50% neu).
import type { ProductionPlanData, ProductionPlanDay, ProductionPlanRow } from "../gsheet-monitor/gsheetTypes";
import { PRODUCTION_PLAN_DAYS } from "../gsheet-monitor/gsheetTypes";

const STATION_LABELS: ReadonlyArray<{ key: keyof ProductionPlanRow["stations"]; label: string; emoji: string }> = [
  { key: "cup", label: "Cup", emoji: "🥤" },
  { key: "slice", label: "Slicing", emoji: "🔪" },
  { key: "grill", label: "Grill", emoji: "🔥" },
  { key: "oven", label: "Oven", emoji: "🍳" },
  { key: "braiser", label: "Braiser", emoji: "🍲" },
  { key: "butter", label: "Butter", emoji: "🧈" },
];

function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return new Intl.NumberFormat("de-DE").format(Math.round(n));
}

function fmtDelta(current: number, prev: number): string {
  const diff = current - prev;
  if (diff === 0) return "(±0)";
  return diff > 0 ? `(+${fmtInt(diff)})` : `(${fmtInt(diff)})`;
}

function mealNeedsCup(row: ProductionPlanRow): boolean {
  if (row.stations.cup) return true;
  return Object.values(row.byDay).some(
    cell => cell.kind === "station" && /cup/i.test(cell.label),
  );
}

export interface WeekOverWeekKpis {
  mealCount: number;
  mealCountPrev: number;
  totalPortions: number;
  totalPortionsPrev: number;
  stationCounts: { key: string; label: string; emoji: string; count: number; countPrev: number; portions: number; portionsPrev: number }[];
  newMealCodes: string[];
}

export function computeWeekOverWeekKpis(current: ProductionPlanData, prev: ProductionPlanData): WeekOverWeekKpis {
  const prevCodes = new Set(prev.rows.map(r => r.code));
  const newMealCodes = current.rows.filter(r => !prevCodes.has(r.code)).map(r => r.code);

  const totalPortions = current.totals?.totalWithBuffer
    ?? current.rows.reduce((sum, r) => sum + r.totalWithBuffer, 0);
  const totalPortionsPrev = prev.totals?.totalWithBuffer
    ?? prev.rows.reduce((sum, r) => sum + r.totalWithBuffer, 0);

  const stationCounts = STATION_LABELS.map(s => {
    if (s.key === "cup") {
      const cupRows = current.rows.filter(mealNeedsCup);
      const cupRowsPrev = prev.rows.filter(mealNeedsCup);
      return {
        key: s.key, label: s.label, emoji: s.emoji,
        count: cupRows.length,
        countPrev: cupRowsPrev.length,
        portions: cupRows.reduce((sum, r) => sum + r.totalWithBuffer, 0),
        portionsPrev: cupRowsPrev.reduce((sum, r) => sum + r.totalWithBuffer, 0),
      };
    }
    return {
      key: s.key, label: s.label, emoji: s.emoji,
      count: current.rows.filter(r => r.stations[s.key]).length,
      countPrev: prev.rows.filter(r => r.stations[s.key]).length,
      portions: current.rows.filter(r => r.stations[s.key]).reduce((sum, r) => sum + r.totalWithBuffer, 0),
      portionsPrev: prev.rows.filter(r => r.stations[s.key]).reduce((sum, r) => sum + r.totalWithBuffer, 0),
    };
  });

  return {
    mealCount: current.rows.length,
    mealCountPrev: prev.rows.length,
    totalPortions,
    totalPortionsPrev,
    stationCounts,
    newMealCodes,
  };
}

export interface VorVorPlanungOptions {
  gsheetUrl?: string | null;
  prevWeekData?: ProductionPlanData | null;
}

const DAY_SHORT: Record<ProductionPlanDay, string> = {
  Sunday: "So", Monday: "Mo", Tuesday: "Di", Wednesday: "Mi", Thursday: "Do", Friday: "Fr", Saturday: "Sa",
};

// Bei Zweischicht-Wochen (ab W39): Hinweis aufs Schichtmodell + kompakte
// Küchenplan-Übersicht (Kochmengen je Tag, mit früh/spät-Split wo vorhanden).
function buildShiftKitchenLines(data: ProductionPlanData): string[] {
  if (data.shiftModel !== "dual") return [];
  const lines: string[] = [];
  lines.push("🕒 2-Schicht-Modell diese Woche (Mo–Fr je Früh-/Spätschicht) — Küchenplan separat unten.");

  const kitchenRows = data.kitchen?.rows ?? [];
  if (kitchenRows.length > 0) {
    // Kochmengen je Tag über alle Meals summieren (früh / spät getrennt).
    const perDay = new Map<ProductionPlanDay, { early: number; late: number; total: number }>();
    for (const d of PRODUCTION_PLAN_DAYS) perDay.set(d, { early: 0, late: 0, total: 0 });
    for (const row of kitchenRows) {
      for (const d of PRODUCTION_PLAN_DAYS) {
        const agg = perDay.get(d)!;
        const cell = row.byDay[d];
        if (cell.kind === "portions") agg.total += cell.portions;
        const shift = row.byShift?.[d];
        if (shift?.early.kind === "portions") agg.early += shift.early.portions;
        if (shift?.late.kind === "portions") agg.late += shift.late.portions;
      }
    }
    lines.push("");
    lines.push(`🍳 Küchenplan — geplante Kochmengen je Tag (${kitchenRows.length} Meals):`);
    for (const d of PRODUCTION_PLAN_DAYS) {
      const agg = perDay.get(d)!;
      if (agg.total <= 0) continue;
      const split = agg.late > 0 ? ` (früh ${fmtInt(agg.early)} / spät ${fmtInt(agg.late)})` : "";
      lines.push(`   ${DAY_SHORT[d]}: ${fmtInt(agg.total)}${split}`);
    }
  }
  return lines;
}

export function buildVorVorPlanungText(data: ProductionPlanData, options: VorVorPlanungOptions = {}): string {
  const { gsheetUrl, prevWeekData } = options;
  const lines: string[] = [];

  lines.push(`📅 Vor-Vor-Planung ${data.week} — Plating Plan (WIP)`);
  lines.push("");

  const mealCount = data.rows.length;
  const totalWithBuffer = data.totals?.totalWithBuffer
    ?? data.rows.reduce((sum, r) => sum + r.totalWithBuffer, 0);

  if (prevWeekData) {
    const kpis = computeWeekOverWeekKpis(data, prevWeekData);

    lines.push(`📊 KPIs vs. Vorwoche (${prevWeekData.week} → ${data.week}):`);
    lines.push(`   📦 Meals: ${fmtInt(kpis.mealCountPrev)} → ${fmtInt(kpis.mealCount)} ${fmtDelta(kpis.mealCount, kpis.mealCountPrev)}`);
    lines.push(`   📦 Portionen (inkl. Buffer): ${fmtInt(kpis.totalPortionsPrev)} → ${fmtInt(kpis.totalPortions)} ${fmtDelta(kpis.totalPortions, kpis.totalPortionsPrev)}`);
    lines.push("");

    lines.push("   Stationen (Meals / Portionen):");
    for (const s of kpis.stationCounts) {
      lines.push(`   ${s.emoji} ${s.label}: ${s.countPrev} Meals → ${s.count} Meals ${fmtDelta(s.count, s.countPrev)} · ${fmtInt(s.portionsPrev)} Port. → ${fmtInt(s.portions)} Port. ${fmtDelta(s.portions, s.portionsPrev)}`);
    }
    lines.push("");

    if (kpis.newMealCodes.length > 0) {
      const threshold = Math.ceil(kpis.mealCount * 0.5);
      if (kpis.newMealCodes.length >= threshold) {
        lines.push(`🆕 ${kpis.newMealCodes.length} Meals neu vs. Vorwoche (Karte rotiert stark — prüfen welche wirklich neu sind)`);
      } else {
        lines.push(`🆕 Neue Meals vs. Vorwoche (${kpis.newMealCodes.length}): ${kpis.newMealCodes.join(", ")}`);
      }
    } else {
      lines.push("🆕 Keine neuen Meals vs. Vorwoche");
    }
  } else {
    lines.push(`${fmtInt(mealCount)} Meals geplant, ${fmtInt(totalWithBuffer)} Portionen gesamt (inkl. Buffer).`);
    lines.push("");
    lines.push("🆕 Neue Meals: ___ (kein Vorwochen-Vergleich verfügbar)");
    lines.push("");
    const stationCounts = STATION_LABELS.map(s => {
      if (s.key === "cup") {
        const cupRows = data.rows.filter(mealNeedsCup);
        return { ...s, count: cupRows.length, portions: cupRows.reduce((sum, r) => sum + r.totalWithBuffer, 0) };
      }
      return {
        ...s,
        count: data.rows.filter(r => r.stations[s.key]).length,
        portions: data.rows.filter(r => r.stations[s.key]).reduce((sum, r) => sum + r.totalWithBuffer, 0),
      };
    });
    lines.push("Vorbereitung:");
    for (const s of stationCounts) {
      lines.push(`   ${s.emoji} ${s.label}: ${s.count} Meals, ${fmtInt(s.portions)} Portionen`);
    }
  }
  lines.push("");

  const shiftKitchenLines = buildShiftKitchenLines(data);
  if (shiftKitchenLines.length > 0) {
    lines.push(...shiftKitchenLines);
    lines.push("");
  }

  const allergenSet = new Set<string>();
  for (const r of data.rows) {
    for (const a of r.allergens.split(",")) {
      const trimmed = a.trim();
      if (trimmed) allergenSet.add(trimmed);
    }
  }
  if (allergenSet.size > 0) {
    lines.push(`⚠️ Allergene diese Woche: ${[...allergenSet].sort().join(", ")}`);
    lines.push("");
  }

  if (gsheetUrl) {
    lines.push(`🔗 Plan: ${gsheetUrl}`);
  }

  return lines.join("\n");
}

// Gemini-basierte KI-Generierung des Vor-Vor-Planungstexts.
// Fällt auf buildVorVorPlanungText zurück wenn der Server nicht erreichbar ist.
export async function generateVorVorPlanungAI(
  data: ProductionPlanData,
  options: VorVorPlanungOptions = {},
): Promise<string> {
  const { gsheetUrl, prevWeekData } = options;
  const baseUrl = import.meta.env.DEV ? "http://127.0.0.1:3142" : "";
  try {
    const res = await fetch(`${baseUrl}/api/local-db/gemini-vorplanung`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentWeek: data, prevWeek: prevWeekData ?? null, gsheetUrl: gsheetUrl ?? null }),
    });
    const body = await res.json() as { ok?: boolean; text?: string; error?: string };
    if (!res.ok || !body.ok || !body.text) {
      throw new Error(body.error || "Gemini-Vorplanung fehlgeschlagen");
    }
    return body.text;
  } catch {
    return buildVorVorPlanungText(data, options);
  }
}
