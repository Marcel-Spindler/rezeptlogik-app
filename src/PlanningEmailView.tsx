/**
 * PlanningEmailView – Planungsrundmail Generator
 *
 * Kombiniert Linienplanung (Firestore) + Küchenplanung (localStorage/BatchSplitPlan)
 * zu einer vollständigen Planungsrundmail für alle Abteilungen.
 *
 * Enthält: Plating-Plan, Küchen-Deadlines, Personalbedarf, Allergene, Anmerkungen.
 */

import { useEffect, useMemo, useState } from "react";
import type { DataBundle } from "./types";
import { computeBatchSplitPlan, loadPlannerStorage, getActiveScenario, type PlannerDay, type LinePlatingSummary, type LinePlatingEntry } from "./planner";
import { usePlanningOasisData } from "./planningOasisData";

// ── Konstanten ──────────────────────────────────────────────────────────────

const SLOT_DURATIONS: Record<string, number> = {
  "06:00-07:00": 60, "07:00-08:00": 60, "08:00-08:30": 30,
  "09:00-10:00": 60, "10:00-11:00": 60, "11:30-12:00": 30,
  "12:00-13:00": 60, "13:00-14:00": 60, "14:00-15:00": 60,
};
// Linienplan-Tage → PlannerDay
const DAY_MAP: Record<string, PlannerDay> = {
  "Freitag": "Fr", "Samstag": "Sa", "Sonntag": "So",
  "Montag": "Mo", "Dienstag": "Di", "Mittwoch": "Mi", "Donnerstag": "Do",
};
// PlannerDay → Volltext
const DAY_LONG: Record<PlannerDay, string> = {
  Mo: "Montag", Di: "Dienstag", Mi: "Mittwoch", Do: "Donnerstag",
  Fr: "Freitag", Sa: "Samstag", So: "Sonntag",
};
// ── Typen ───────────────────────────────────────────────────────────────────

type LinePlanRec = { code: string; name: string; speedPerMin: number };
type ScheduleMap = Record<string, LinePlanRec | null>;

interface SlotBlock {
  slotKey: string;
  recipe: LinePlanRec;
  lineIdx: number;
  portions: number;
}

interface DayPlatingSummary {
  day: PlannerDay;
  dayLong: string;
  blocks: SlotBlock[];
  activeLines: Set<number>;
  /** MA-Bedarf Plating: 4 pro aktiver Linie, +1 bei Speed > 15 Port/min */
  staffNeeded: number;
  totalPortions: number;
}

// ── Helfer ───────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  return n.toLocaleString("de-DE");
}

function fmtDate(week: string): string {
  // "2026-W19" → Datum des Montags dieser Woche
  try {
    const [yearStr, wStr] = week.split("-W");
    const year = parseInt(yearStr ?? "2026");
    const w = parseInt(wStr ?? "1");
    // ISO Week → Datum
    const jan4 = new Date(year, 0, 4);
    const startOfWeek = new Date(jan4);
    startOfWeek.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (w - 1) * 7);
    return startOfWeek.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return week;
  }
}

/** Berechnet Datum des Wochentags basierend auf ISO-Wochennummer */
function dayDate(week: string, day: PlannerDay): string {
  try {
    const [yearStr, wStr] = week.split("-W");
    const year = parseInt(yearStr ?? "2026");
    const w = parseInt(wStr ?? "1");
    const jan4 = new Date(year, 0, 4);
    const monday = new Date(jan4);
    monday.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7) + (w - 1) * 7);
    // Factor-Woche beginnt Fr vor dem ISO-Montag → Fr = Mo - 3 Tage
    const offsets: Record<PlannerDay, number> = {
      Fr: -3, Sa: -2, So: -1, Mo: 0, Di: 1, Mi: 2, Do: 3
    };
    const d = new Date(monday);
    d.setDate(monday.getDate() + (offsets[day] ?? 0));
    return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
  } catch {
    return day;
  }
}

/** Personalbedarf Plating pro Linie */
function staffPerLine(recipes: LinePlanRec[]): number {
  const hasHighSpeed = recipes.some(r => r.speedPerMin > 15);
  return 4 + (hasHighSpeed ? 1 : 0);
}

// ── Hauptkomponente ──────────────────────────────────────────────────────────

export function PlanningEmailView({
  data,
  week,
}: {
  data: DataBundle;
  week: string;
}) {
  const { data: oasis } = usePlanningOasisData();

  // Linienplan aus Firestore
  const [linePlanRaw, setLinePlanRaw] = useState<ScheduleMap>({});
  const [, setLineCapacityByLane] = useState<Record<string, number>>({ "0": 1200, "1": 1200, "2": 1200 });
  const [platingLineCount, setPlatingLineCount] = useState<number>(3);
  const [linePlanComments, setLinePlanComments] = useState<Record<string, string>>({});
  const [linePlanLoaded, setLinePlanLoaded] = useState(false);
  const [linePlanSavedAt, setLinePlanSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    void (async () => {
      try {
        const { getFirebase } = await import("./firebase");
        const { doc, onSnapshot } = await import("firebase/firestore");
        const { db } = getFirebase();
        const weekStr = week.includes("-W") ? week.split("-W")[1] : week;
        unsub = onSnapshot(
          doc(db, "apps/rezeptlogik/lineplanning", `de_W${weekStr}`),
          (snap) => {
            if (snap.exists()) {
              const d = snap.data() as {
                schedule?: ScheduleMap;
                lineCapacityByLane?: Record<string, number>;
                platingLineCount?: number;
                comments?: Record<string, string>;
                savedAt?: string;
              };
              setLinePlanRaw(d.schedule ?? {});
              if (d.lineCapacityByLane) setLineCapacityByLane(prev => ({ ...prev, ...d.lineCapacityByLane }));
              if (d.platingLineCount && d.platingLineCount >= 1) setPlatingLineCount(d.platingLineCount);
              setLinePlanComments(d.comments ?? {});
              setLinePlanSavedAt(d.savedAt ?? null);
            } else {
              setLinePlanRaw({});
              setLinePlanComments({});
              setLinePlanSavedAt(null);
            }
            setLinePlanLoaded(true);
          },
          () => { setLinePlanLoaded(true); }
        );
      } catch {
        setLinePlanLoaded(true);
      }
    })();
    return () => unsub?.();
  }, [week]);

  // Rack-Status aus Firestore (alle Linien released?)
  const [rackAllReleased, setRackAllReleased] = useState<boolean>(false);
  const [rackLoaded, setRackLoaded] = useState(false);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    void (async () => {
      try {
        const { getFirebase } = await import("./firebase");
        const { doc, onSnapshot } = await import("firebase/firestore");
        const { db } = getFirebase();
        const docId = week.replace(/[^A-Za-z0-9_-]+/g, "-");
        unsub = onSnapshot(
          doc(db, "apps/rezeptlogik/rackV2Plans", docId),
          (snap) => {
            if (snap.exists()) {
              const d = snap.data() as { lines?: Record<string, { releaseStatus?: string }> };
              const lines = d.lines ?? {};
              const requiredLineIds = ["ASL1", "ASL2", "ASL3", "ASL4", "ASL5", "ASL6"];
              const allReleased = requiredLineIds.every((lineId) => lines[lineId]?.releaseStatus === "released");
              setRackAllReleased(allReleased);
            } else {
              setRackAllReleased(false);
            }
            setRackLoaded(true);
          },
          () => { setRackLoaded(true); }
        );
      } catch {
        setRackLoaded(true);
      }
    })();
    return () => unsub?.();
  }, [week]);

  // Küchenplan (localStorage)
  const plannerStorage = useMemo(() => loadPlannerStorage(), []);
  const scenario = useMemo(() => getActiveScenario(plannerStorage, week), [plannerStorage, week]);

  // Cockpit-Bestätigung: Wochenplaner hat mindestens 1 Rezept zugewiesen
  const cockpitHasAssignments = useMemo(
    () => Object.keys(scenario.assignments).length > 0,
    [scenario]
  );

  // Freigabe-Gate: alle 3 Quellen bestätigt?
  const linePlanConfirmed = linePlanLoaded && linePlanSavedAt !== null;
  const rackConfirmed = rackLoaded && rackAllReleased;
  const allConfirmed = linePlanConfirmed && rackConfirmed && cockpitHasAssignments;

  // LinePlatingSummary (für computeBatchSplitPlan)
  const linePlatingSummary = useMemo((): LinePlatingSummary => {
    const byRecipe: Record<string, LinePlatingEntry[]> = {};
    for (const [key, recipe] of Object.entries(linePlanRaw)) {
      if (!recipe) continue;
      const parts = key.split("|");
      if (parts.length !== 3) continue;
      const [dayDE, slotKey] = parts;
      const platDay = DAY_MAP[dayDE ?? ""];
      if (!platDay) continue;
      const duration = SLOT_DURATIONS[slotKey ?? ""] ?? 60;
      const portions = (recipe.speedPerMin ?? 10) * duration;
      const entries = (byRecipe[recipe.code] ??= []);
      const existing = entries.find(e => e.platDay === platDay);
      if (existing) { existing.capacityPortions += portions; existing.slotCount += 1; }
      else entries.push({ platDay, capacityPortions: portions, slotCount: 1 });
    }
    return { byRecipe };
  }, [linePlanRaw]);

  const batchSplitPlan = useMemo(
    () => computeBatchSplitPlan(data, week, linePlatingSummary),
    [data, week, linePlatingSummary]
  );

  // ── Plating-Tagesübersicht aufbauen ───────────────────────────────────────
  const dayPlatingSummaries = useMemo((): DayPlatingSummary[] => {
    const byDay = new Map<PlannerDay, SlotBlock[]>();
    for (const [key, recipe] of Object.entries(linePlanRaw)) {
      if (!recipe) continue;
      const parts = key.split("|");
      if (parts.length !== 3) continue;
      const [dayDE, slotKey, lineIdxStr] = parts;
      const day = DAY_MAP[dayDE ?? ""];
      if (!day) continue;
      const lineIdx = parseInt(lineIdxStr ?? "0");
      const duration = SLOT_DURATIONS[slotKey ?? ""] ?? 60;
      const portions = (recipe.speedPerMin ?? 10) * duration;
      const blocks = byDay.get(day) ?? [];
      blocks.push({ slotKey: slotKey ?? "", recipe, lineIdx, portions });
      byDay.set(day, blocks);
    }
    // Alle Tage durchgehen, auch leere (wo Küche trotzdem arbeitet)
    const allDays: PlannerDay[] = ["Fr", "Sa", "So", "Mo", "Di", "Mi", "Do"];
    return allDays
      .filter(day => byDay.has(day))
      .map(day => {
        const blocks = (byDay.get(day) ?? []).sort((a, b) => {
          if (a.lineIdx !== b.lineIdx) return a.lineIdx - b.lineIdx;
          return a.slotKey.localeCompare(b.slotKey);
        });
        const activeLines = new Set(blocks.map(b => b.lineIdx));
        const staff = Array.from(activeLines).reduce((sum, li) => {
          const recipesOnLine = blocks.filter(b => b.lineIdx === li).map(b => b.recipe);
          return sum + staffPerLine(recipesOnLine);
        }, 0);
        return {
          day,
          dayLong: DAY_LONG[day],
          blocks,
          activeLines,
          staffNeeded: staff,
          totalPortions: blocks.reduce((s, b) => s + b.portions, 0),
        };
      });
  }, [linePlanRaw]);

  // ── Allergene aus PlanningOasis ───────────────────────────────────────────
  const allergensByRecipe = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const plan of batchSplitPlan) {
      const intel = oasis?.recipes[plan.recipeCode];
      if (intel?.allergens?.length) result[plan.recipeCode] = intel.allergens;
    }
    return result;
  }, [batchSplitPlan, oasis]);

  // ── Kommentare (nur gefüllte) ─────────────────────────────────────────────
  const filledComments = useMemo(() =>
    Object.entries(linePlanComments).filter(([, v]) => v.trim()),
    [linePlanComments]
  );

  // ── Küchen-Assignments aus Scenario ───────────────────────────────────────
  const assignedByRecipe = useMemo(() => {
    const result: Record<string, PlannerDay> = {};
    for (const [key, assignment] of Object.entries(scenario.assignments)) {
      const code = key.split("::")[0] ?? "";
      if (code && assignment?.day) result[code] = assignment.day;
    }
    return result;
  }, [scenario]);

  // ── Gesamt-Portionen aus Forecast ─────────────────────────────────────────
  const totalPortionsForecast = useMemo(() =>
    batchSplitPlan.reduce((s, p) => s + p.totalPortions, 0),
    [batchSplitPlan]
  );
  const totalPortionsLine = useMemo(() =>
    dayPlatingSummaries.reduce((s, d) => s + d.totalPortions, 0),
    [dayPlatingSummaries]
  );
  const hasSeafood = batchSplitPlan.some(p => p.isSeafood);

  // ── Export-Funktionen ─────────────────────────────────────────────────────
  const [copyState, setCopyState] = useState<"idle" | "ok">("idle");
  const [htmlCopyState, setHtmlCopyState] = useState<"idle" | "ok">("idle");

  function buildPlainText(): string {
    const kw = week.split("-W")[1] ?? week;
    const lines: string[] = [];
    const h = (s: string) => lines.push(s);
    const sep = () => lines.push("─".repeat(60));

    h(`PLANUNGSRUNDMAIL – KW ${kw} / ${fmtDate(week)}`);
    h(`Standort: Verden (VF)  |  Erstellt: ${new Date().toLocaleString("de-DE")}`);
    sep();
    h("ZUSAMMENFASSUNG");
    h(`Rezepte gesamt:        ${batchSplitPlan.length}`);
    h(`Forecast Portionen:    ${fmtNum(totalPortionsForecast)}`);
    h(`Linienkapazität (Plan):${fmtNum(totalPortionsLine)}`);
    h(`Aktive Plating-Linien: ${platingLineCount}`);
    if (hasSeafood) h("⚠  Enthält Fisch-Rezepte (MHD 9 Tage – Küchen-Deadline beachten!)");
    sep();

    if (dayPlatingSummaries.length > 0) {
      h("PLATING-PLAN");
      for (const ds of dayPlatingSummaries) {
        h(`\n${ds.dayLong.toUpperCase()} (${dayDate(week, ds.day)})  –  ${fmtNum(ds.totalPortions)} Port. | Personal: ${ds.staffNeeded} MA`);
        // Gruppiert nach Linie
        const lineNums = Array.from(ds.activeLines).sort();
        for (const li of lineNums) {
          const lineBlocks = ds.blocks.filter(b => b.lineIdx === li).sort((a, b) => a.slotKey.localeCompare(b.slotKey));
          h(`  P-Linie ${li + 1}:`);
          for (const block of lineBlocks) {
            h(`    ${block.slotKey}  ${block.recipe.code} „${block.recipe.name.replace(/\[.*?\]/g, "").trim().slice(0, 40)}"  →  ${fmtNum(block.portions)} Port.`);
          }
        }
      }
      sep();
    }

    h("KÜCHEN-DEADLINES");
    h(`${"Rezept".padEnd(12)} ${"Name".padEnd(30)} ${"Plating".padEnd(10)} ${"Versand".padEnd(9)} ${"Küche bis".padEnd(12)} ${"Portionen".padStart(10)}`);
    h("-".repeat(85));
    for (const plan of batchSplitPlan) {
      for (const batch of plan.batches) {
        const kitchenDay = assignedByRecipe[plan.recipeCode] ?? batch.recommendedProductionDay;
        const flag = plan.isSeafood ? "🐟 " : "   ";
        const versand = batch.fulfillmentDay !== batch.platDay ? String(batch.fulfillmentDay) : "-";
        h(`${flag}${plan.recipeCode.padEnd(10)} ${(plan.recipeName.replace(/\[.*?\]/g, "").trim()).slice(0, 28).padEnd(30)} ${String(batch.platDay).padEnd(10)} ${versand.padEnd(9)} ${String(kitchenDay).padEnd(12)} ${fmtNum(batch.portions).padStart(10)}`);
      }
    }
    sep();

    h("PERSONALBEDARF PLATING (pro Tag)");
    for (const ds of dayPlatingSummaries) {
      h(`  ${ds.dayLong}: ${ds.staffNeeded} MA (${ds.activeLines.size} Linie${ds.activeLines.size !== 1 ? "n" : ""} × ~4 MA)`);
    }
    if (dayPlatingSummaries.length === 0) h("  Kein Linienplan hinterlegt.");
    sep();

    const recipesWithAllergens = batchSplitPlan.filter(p => (allergensByRecipe[p.recipeCode] ?? []).length > 0);
    if (recipesWithAllergens.length > 0) {
      h("ALLERGENE (FSQA-Hinweis)");
      for (const plan of recipesWithAllergens) {
        const a = allergensByRecipe[plan.recipeCode] ?? [];
        h(`  ${plan.recipeCode}  „${plan.recipeName.replace(/\[.*?\]/g, "").trim().slice(0, 40)}":`);
        h(`    ${a.join(", ")}`);
      }
      sep();
    }

    if (filledComments.length > 0) {
      h("ANMERKUNGEN AUS LINIENPLANUNG");
      for (const [key, comment] of filledComments) {
        const [dayDE, slot, li] = key.split("|");
        h(`  ${dayDE ?? ""} | ${slot ?? ""} | Linie ${parseInt(li ?? "0") + 1}: ${comment}`);
      }
      sep();
    }

    h("Diese Mail wurde automatisch aus dem Rezeptlogik-Planungssystem generiert.");
    return lines.join("\n");
  }

  function buildHtmlEmail(): string {
    const kwNum = week.split("-W")[1] ?? week;
    const accent = "#1e40af";
    const lightBlue = "#eff6ff";
    const lightGray = "#f8fafc";
    const border = "#e2e8f0";

    const css = `
      body{font-family:Calibri,Arial,sans-serif;font-size:14px;color:#1e293b;margin:0;padding:0;background:#fff}
      .wrap{max-width:900px;margin:0 auto;padding:24px}
      h1{font-size:20px;font-weight:700;color:${accent};margin:0 0 4px 0}
      .meta{font-size:12px;color:#64748b;margin-bottom:20px}
      h2{font-size:15px;font-weight:700;color:#1e293b;margin:24px 0 8px 0;padding-bottom:4px;border-bottom:2px solid ${accent}}
      h3{font-size:13px;font-weight:700;color:#334155;margin:12px 0 4px 0}
      table{width:100%;border-collapse:collapse;margin-bottom:12px}
      th{background:${accent};color:#fff;text-align:left;padding:6px 10px;font-size:12px;font-weight:600}
      td{padding:5px 10px;border-bottom:1px solid ${border};font-size:13px;vertical-align:top}
      tr:nth-child(even) td{background:${lightGray}}
      .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:700}
      .badge-blue{background:#dbeafe;color:#1d4ed8}
      .badge-red{background:#fee2e2;color:#b91c1c}
      .badge-green{background:#dcfce7;color:#166534}
      .badge-amber{background:#fef3c7;color:#92400e}
      .summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:12px 0}
      .stat{background:${lightBlue};border:1px solid #bfdbfe;border-radius:8px;padding:12px;text-align:center}
      .stat-val{font-size:22px;font-weight:800;color:${accent}}
      .stat-lbl{font-size:11px;color:#64748b;margin-top:2px}
      .day-card{border:1px solid ${border};border-radius:8px;margin-bottom:12px;overflow:hidden}
      .day-header{background:${accent};color:#fff;padding:8px 14px;font-weight:700;font-size:14px;display:flex;justify-content:space-between;align-items:center}
      .day-body{padding:8px 14px}
      .line-block{margin:4px 0}
      .line-label{font-weight:600;color:#475569;font-size:12px;margin-bottom:2px}
      .slot-row{display:flex;gap:8px;align-items:center;padding:3px 0;border-bottom:1px solid #f1f5f9}
      .slot-time{font-size:11px;color:#94a3b8;min-width:110px}
      .slot-recipe{font-size:12px;font-weight:600;color:#1e3a8a}
      .slot-portions{font-size:11px;color:#64748b;margin-left:auto}
      .warn{background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:8px 12px;margin:8px 0;font-size:13px;color:#92400e}
      .info{background:#eff6ff;border:1px solid #93c5fd;border-radius:6px;padding:8px 12px;margin:8px 0;font-size:13px;color:#1e40af}
      .footer{margin-top:24px;padding-top:12px;border-top:1px solid ${border};font-size:11px;color:#94a3b8}
    `;

    const recipesHtml = batchSplitPlan.map(plan => {
      const allergens = allergensByRecipe[plan.recipeCode] ?? [];
      const batches = plan.batches.map(b => {
        const kitchenDay = assignedByRecipe[plan.recipeCode] ?? b.recommendedProductionDay;
        const gapVal = plan.lineCoverageGap;
        const gapHtml = gapVal !== undefined
          ? gapVal > 0
            ? `<span class="badge badge-red">⚠ ${fmtNum(gapVal)} Port. Lücke</span>`
            : `<span class="badge badge-green">✓ Linie gedeckt</span>`
          : "";
        const versandCell = b.fulfillmentDay !== b.platDay
          ? `<span style="color:#64748b;font-size:12px">${b.fulfillmentDay}</span>`
          : `<span style="color:#94a3b8;font-size:11px">–</span>`;
        return `<tr>
          <td>${plan.recipeCode}${plan.isSeafood ? " 🐟" : ""}</td>
          <td>${plan.recipeName.replace(/\[.*?\]/g, "").trim().slice(0, 45)}</td>
          <td><strong>${b.platDay}</strong></td>
          <td>${versandCell}</td>
          <td>${kitchenDay !== b.recommendedProductionDay ? `<strong>${kitchenDay}</strong> <span style="color:#94a3b8;font-size:11px">(geplant)</span>` : b.recommendedProductionDay}</td>
          <td style="text-align:right">${fmtNum(b.portions)}</td>
          <td>${gapHtml}${allergens.length > 0 ? ` <span class="badge badge-amber" title="${allergens.join(", ")}">⚡ Allergene</span>` : ""}</td>
        </tr>`;
      }).join("");
      return batches;
    }).join("");

    const daysHtml = dayPlatingSummaries.map(ds => {
      const lineNums = Array.from(ds.activeLines).sort();
      const linesHtml = lineNums.map(li => {
        const blocks = ds.blocks.filter(b => b.lineIdx === li).sort((a, b) => a.slotKey.localeCompare(b.slotKey));
        const slotsHtml = blocks.map(block =>
          `<div class="slot-row">
            <span class="slot-time">${block.slotKey}</span>
            <span class="slot-recipe">${block.recipe.code} &nbsp;${block.recipe.name.replace(/\[.*?\]/g, "").trim().slice(0, 40)}</span>
            <span class="slot-portions">${fmtNum(block.portions)} Port.</span>
          </div>`
        ).join("");
        const staff = staffPerLine(blocks.map(b => b.recipe));
        return `<div class="line-block">
          <div class="line-label">P-Linie ${li + 1} &nbsp;·&nbsp; ${staff} MA</div>
          ${slotsHtml}
        </div>`;
      }).join("");
      return `<div class="day-card">
        <div class="day-header">
          <span>${ds.dayLong} &nbsp;(${dayDate(week, ds.day)})</span>
          <span style="font-size:13px;font-weight:400">${fmtNum(ds.totalPortions)} Port. &nbsp;|&nbsp; ${ds.staffNeeded} MA Plating</span>
        </div>
        <div class="day-body">${linesHtml || "<em style='color:#94a3b8'>Kein Linienplan für diesen Tag</em>"}</div>
      </div>`;
    }).join("");

    const allergenHtml = batchSplitPlan
      .filter(p => (allergensByRecipe[p.recipeCode] ?? []).length > 0)
      .map(p => {
        const a = allergensByRecipe[p.recipeCode] ?? [];
        return `<tr>
          <td>${p.recipeCode}</td>
          <td>${p.recipeName.replace(/\[.*?\]/g, "").trim().slice(0, 45)}</td>
          <td>${a.map(al => `<span class="badge badge-amber">${al}</span>`).join(" ")}</td>
        </tr>`;
      }).join("");

    const commentHtml = filledComments.length > 0
      ? filledComments.map(([key, comment]) => {
          const [dayDE, slot, li] = key.split("|");
          return `<div class="info"><strong>${dayDE ?? ""} | ${slot ?? ""} | Linie ${parseInt(li ?? "0") + 1}:</strong> ${comment}</div>`;
        }).join("")
      : `<p style="color:#94a3b8;font-size:13px">Keine Anmerkungen vorhanden.</p>`;

    return `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="wrap">
  <h1>📋 Planungsrundmail – KW ${kwNum}</h1>
  <div class="meta">Standort: Verden (VF) &nbsp;·&nbsp; ${fmtDate(week)} &nbsp;·&nbsp; Erstellt: ${new Date().toLocaleString("de-DE")}</div>

  ${hasSeafood ? `<div class="warn">⚠ Diese Woche enthält <strong>Fisch-Rezepte</strong> – MHD 9 Tage! Küchen-Deadlines besonders beachten.</div>` : ""}

  <h2>Zusammenfassung</h2>
  <div class="summary-grid">
    <div class="stat"><div class="stat-val">${batchSplitPlan.length}</div><div class="stat-lbl">Rezepte</div></div>
    <div class="stat"><div class="stat-val">${fmtNum(totalPortionsForecast)}</div><div class="stat-lbl">Forecast-Portionen</div></div>
    <div class="stat"><div class="stat-val">${fmtNum(totalPortionsLine)}</div><div class="stat-lbl">Linienplan-Kapazität</div></div>
    <div class="stat"><div class="stat-val">${platingLineCount}</div><div class="stat-lbl">Aktive Plating-Linien</div></div>
  </div>

  <h2>Plating-Plan (Linienübersicht)</h2>
  ${dayPlatingSummaries.length > 0 ? daysHtml : `<p style="color:#94a3b8;font-size:13px">Kein Linienplan für diese Woche hinterlegt (Linienplanung öffnen und befüllen).</p>`}

  <h2>Küchen-Deadlines</h2>
  <table>
    <thead><tr>
      <th>Rezept</th><th>Name</th><th>Plating</th><th>Versand</th><th>Küche bis</th><th style="text-align:right">Portionen</th><th>Status</th>
    </tr></thead>
    <tbody>${recipesHtml || `<tr><td colspan="6" style="color:#94a3b8;text-align:center">Keine Rezepte für diese Woche</td></tr>`}</tbody>
  </table>

  <h2>Personalbedarf Plating</h2>
  <table>
    <thead><tr><th>Tag</th><th>Datum</th><th>Aktive Linien</th><th>MA Plating</th><th style="text-align:right">Portionen</th></tr></thead>
    <tbody>
      ${dayPlatingSummaries.length > 0
        ? dayPlatingSummaries.map(ds =>
            `<tr>
              <td><strong>${ds.dayLong}</strong></td>
              <td>${dayDate(week, ds.day)}</td>
              <td>${ds.activeLines.size} Linie${ds.activeLines.size !== 1 ? "n" : ""} (${Array.from(ds.activeLines).map(i => `P-Linie ${i + 1}`).join(", ")})</td>
              <td><strong>${ds.staffNeeded}</strong> <span style="color:#64748b;font-size:11px">(je ~4 MA / Linie)</span></td>
              <td style="text-align:right">${fmtNum(ds.totalPortions)}</td>
            </tr>`
          ).join("")
        : `<tr><td colspan="5" style="color:#94a3b8;text-align:center">Linienplan nicht gefüllt</td></tr>`}
    </tbody>
  </table>
  <div class="info" style="font-size:12px">Plating-Besetzung: 1 Maschinenführer + 2 Bestücker/Packer + 1 Flex/Endkontrolle pro Linie. Bei Rezepten mit Speed &gt; 15 Port./min +1 MA.</div>

  ${allergenHtml ? `<h2>Allergene – FSQA-Hinweis</h2>
  <table>
    <thead><tr><th>Rezept</th><th>Name</th><th>Allergene</th></tr></thead>
    <tbody>${allergenHtml}</tbody>
  </table>` : ""}

  <h2>Anmerkungen aus Linienplanung</h2>
  ${commentHtml}

  <div class="footer">
    Automatisch generiert aus Rezeptlogik-Planungssystem &nbsp;·&nbsp; Woche ${week} &nbsp;·&nbsp; ${new Date().toLocaleString("de-DE")}
  </div>
</div></body></html>`;
  }

  async function copyPlainText() {
    await navigator.clipboard.writeText(buildPlainText());
    setCopyState("ok");
    setTimeout(() => setCopyState("idle"), 2500);
  }

  async function copyHtml() {
    try {
      const html = buildHtmlEmail();
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) })
      ]);
    } catch {
      // Fallback: Plain HTML-Code kopieren
      await navigator.clipboard.writeText(buildHtmlEmail());
    }
    setHtmlCopyState("ok");
    setTimeout(() => setHtmlCopyState("idle"), 2500);
  }

  // ── Kapazitätslücken-Warnung ───────────────────────────────────────────────
  const coverageWarnings = useMemo(() =>
    batchSplitPlan.filter(p => p.lineCoverageGap !== undefined && p.lineCoverageGap > 0),
    [batchSplitPlan]
  );

  return (
    <div className="space-y-4">
      {/* Freigabe-Checkliste */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Freigabe-Status</p>
        <div className="flex flex-wrap gap-3">
          {[
            {
              label: "Linienplanung",
              ok: linePlanConfirmed,
              loading: !linePlanLoaded,
              hint: linePlanConfirmed
                ? `Gespeichert ${new Date(linePlanSavedAt!).toLocaleString("de-DE")}`
                : "Noch nicht gespeichert – bitte ‘💾 Plan sichern’ in Linienplanung klicken",
            },
            {
              label: "Rack freigegeben",
              ok: rackConfirmed,
              loading: !rackLoaded,
              hint: rackConfirmed
                ? "Alle sechs Linien freigegeben"
                : "Noch nicht alle Linien freigegeben - bitte jede Linie im Rack freigeben",
            },
            {
              label: "Wochenplaner",
              ok: cockpitHasAssignments,
              loading: false,
              hint: cockpitHasAssignments
                ? `${Object.keys(scenario.assignments).length} Küchen-Zuordnungen vorhanden`
                : "Kein Küchenplan – bitte im Cockpit Rezepte zuordnen",
            },
          ].map(({ label, ok, loading, hint }) => (
            <div
              key={label}
              title={hint}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold ring-1 ${
                loading
                  ? "bg-slate-50 text-slate-400 ring-slate-200"
                  : ok
                  ? "bg-emerald-50 text-emerald-800 ring-emerald-300"
                  : "bg-rose-50 text-rose-700 ring-rose-300"
              }`}
            >
              <span>{loading ? "⏳" : ok ? "✅" : "❌"}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>
        {!allConfirmed && (
          <p className="mt-3 text-xs text-slate-500">
            ⚠ Bitte alle drei Quellen bestätigen, bevor die Rundmail versendet wird.
          </p>
        )}
      </div>

      {/* Toolbar */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <h2 className="text-base font-bold text-slate-800">Planungsrundmail – {week}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {linePlanLoaded
                ? Object.keys(linePlanRaw).length > 0
                  ? `Linienplan geladen: ${Object.values(linePlanRaw).filter(Boolean).length} Slots befüllt`
                  : "Kein Linienplan für diese Woche – bitte Linienplanung befüllen"
                : "Linienplan wird geladen …"}
            </p>
          </div>
          <button
            onClick={() => void copyPlainText()}
            disabled={!allConfirmed}
            title={!allConfirmed ? "Bitte zuerst alle 3 Quellen bestätigen" : undefined}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ring-1 transition-colors ${
              copyState === "ok"
                ? "bg-emerald-100 text-emerald-800 ring-emerald-300"
                : allConfirmed
                ? "bg-slate-100 text-slate-700 ring-slate-300 hover:bg-slate-200"
                : "bg-slate-100 text-slate-400 ring-slate-200 cursor-not-allowed"
            }`}
          >
            {copyState === "ok" ? "✓ Text kopiert" : "Als Text kopieren"}
          </button>
          <button
            onClick={() => void copyHtml()}
            disabled={!allConfirmed}
            title={!allConfirmed ? "Bitte zuerst alle 3 Quellen bestätigen" : undefined}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ring-1 transition-colors ${
              htmlCopyState === "ok"
                ? "bg-emerald-100 text-emerald-800 ring-emerald-300"
                : allConfirmed
                ? "bg-blue-600 text-white ring-blue-700 hover:bg-blue-700"
                : "bg-blue-200 text-blue-400 ring-blue-200 cursor-not-allowed"
            }`}
          >
            {htmlCopyState === "ok" ? "✓ HTML kopiert" : "Als HTML kopieren (Outlook)"}
          </button>
        </div>
      </div>

      {/* Kapazitätslücken-Warnungen */}
      {coverageWarnings.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-bold text-amber-800 mb-2">⚠ Kapazitätslücken im Linienplan</p>
          <div className="space-y-1">
            {coverageWarnings.map(p => (
              <div key={p.recipeCode} className="text-xs text-amber-700">
                <span className="font-mono font-bold">{p.recipeCode}</span> – {p.recipeName.replace(/\[.*?\]/g, "").trim().slice(0, 45)}:
                &nbsp;Forecast {fmtNum(p.totalPortions)} Port., Linie {fmtNum(p.totalLineCapacity ?? 0)} Port.
                &nbsp;→ <span className="font-bold text-red-700">−{fmtNum(p.lineCoverageGap ?? 0)} Port. Lücke</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mail-Vorschau */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mail-Vorschau</span>
          <span className="text-xs text-slate-400">· In Outlook einfügen via HTML kopieren</span>
        </div>

        <div className="p-6 space-y-6 font-sans text-sm text-slate-800">
          {/* Header */}
          <div>
            <h1 className="text-xl font-bold text-blue-800">📋 Planungsrundmail – KW {week.split("-W")[1] ?? week}</h1>
            <p className="text-xs text-slate-500 mt-1">Standort: Verden (VF) · {fmtDate(week)} · {new Date().toLocaleString("de-DE")}</p>
          </div>

          {hasSeafood && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              ⚠ Diese Woche enthält <strong>Fisch-Rezepte</strong> – MHD 9 Tage! Küchen-Deadlines besonders beachten.
            </div>
          )}

          {/* Summary */}
          <div>
            <h2 className="text-base font-bold text-slate-800 border-b-2 border-blue-700 pb-1 mb-3">Zusammenfassung</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { val: batchSplitPlan.length, lbl: "Rezepte" },
                { val: fmtNum(totalPortionsForecast), lbl: "Forecast-Portionen" },
                { val: fmtNum(totalPortionsLine), lbl: "Linienplan-Kapazität" },
                { val: platingLineCount, lbl: "Aktive Plating-Linien" },
              ].map(({ val, lbl }) => (
                <div key={lbl} className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-center">
                  <div className="text-2xl font-black text-blue-800">{val}</div>
                  <div className="text-xs text-slate-500 mt-1">{lbl}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Plating-Plan */}
          <div>
            <h2 className="text-base font-bold text-slate-800 border-b-2 border-blue-700 pb-1 mb-3">Plating-Plan</h2>
            {dayPlatingSummaries.length === 0 ? (
              <p className="text-sm text-slate-400 italic">Kein Linienplan hinterlegt – bitte Linienplanung befüllen.</p>
            ) : (
              <div className="space-y-3">
                {dayPlatingSummaries.map(ds => {
                  const lineNums = Array.from(ds.activeLines).sort();
                  return (
                    <div key={ds.day} className="rounded-lg border border-slate-200 overflow-hidden">
                      <div className="bg-blue-800 text-white px-4 py-2 flex justify-between items-center">
                        <span className="font-bold">{ds.dayLong} · {dayDate(week, ds.day)}</span>
                        <span className="text-sm font-normal">{fmtNum(ds.totalPortions)} Port. · <strong>{ds.staffNeeded} MA</strong> Plating</span>
                      </div>
                      <div className="p-3 space-y-3">
                        {lineNums.map(li => {
                          const blocks = ds.blocks.filter(b => b.lineIdx === li).sort((a, b) => a.slotKey.localeCompare(b.slotKey));
                          const staff = staffPerLine(blocks.map(b => b.recipe));
                          return (
                            <div key={li}>
                              <div className="text-xs font-bold text-slate-500 mb-1">P-Linie {li + 1} · {staff} MA</div>
                              <table className="w-full text-xs">
                                <tbody>
                                  {blocks.map(block => (
                                    <tr key={`${block.slotKey}-${li}`} className="border-b border-slate-100 last:border-0">
                                      <td className="py-1 pr-3 text-slate-400 font-mono w-28">{block.slotKey}</td>
                                      <td className="py-1 pr-3 font-bold text-blue-900">{block.recipe.code}</td>
                                      <td className="py-1 pr-3 text-slate-600">{block.recipe.name.replace(/\[.*?\]/g, "").trim().slice(0, 40)}</td>
                                      <td className="py-1 text-right text-slate-500 tabular-nums">{fmtNum(block.portions)} Port.</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Küchen-Deadlines */}
          <div>
            <h2 className="text-base font-bold text-slate-800 border-b-2 border-blue-700 pb-1 mb-3">Küchen-Deadlines</h2>
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-blue-800 text-white">
                  <th className="p-2 text-left">Rezept</th>
                  <th className="p-2 text-left">Name</th>
                  <th className="p-2 text-center">Plating</th>
                  <th className="p-2 text-center">Versand</th>
                  <th className="p-2 text-center">Küche bis</th>
                  <th className="p-2 text-right">Portionen</th>
                  <th className="p-2 text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {batchSplitPlan.length === 0 ? (
                  <tr><td colSpan={7} className="p-4 text-center text-slate-400">Keine Rezepte</td></tr>
                ) : batchSplitPlan.flatMap(plan =>
                  plan.batches.map((batch, bi) => {
                    const kitchenDay = assignedByRecipe[plan.recipeCode] ?? batch.recommendedProductionDay;
                    const gapVal = plan.lineCoverageGap;
                    const isAssigned = !!assignedByRecipe[plan.recipeCode];
                    return (
                      <tr key={`${plan.recipeCode}-${bi}`} className={bi % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                        <td className="p-2 font-mono font-bold text-blue-900">
                          {plan.recipeCode}{plan.isSeafood ? " 🐟" : ""}
                        </td>
                        <td className="p-2 text-slate-700">{plan.recipeName.replace(/\[.*?\]/g, "").trim().slice(0, 40)}</td>
                        <td className="p-2 text-center font-bold">{batch.platDay}</td>
                        <td className="p-2 text-center text-slate-500 text-[11px]">
                          {batch.fulfillmentDay !== batch.platDay ? batch.fulfillmentDay : "–"}
                        </td>
                        <td className="p-2 text-center">
                          <span className={`font-bold ${isAssigned ? "text-emerald-700" : "text-blue-700"}`}>{kitchenDay}</span>
                          {isAssigned && <span className="ml-1 text-[10px] text-slate-400">(geplant)</span>}
                        </td>
                        <td className="p-2 text-right tabular-nums">{fmtNum(batch.portions)}</td>
                        <td className="p-2 text-center text-[10px]">
                          {gapVal !== undefined && gapVal > 0 && (
                            <span className="rounded bg-red-100 text-red-700 px-1.5 py-0.5 font-bold">⚠ {fmtNum(gapVal)} fehlen</span>
                          )}
                          {gapVal !== undefined && gapVal <= 0 && (
                            <span className="rounded bg-emerald-100 text-emerald-700 px-1.5 py-0.5 font-bold">✓ gedeckt</span>
                          )}
                          {gapVal === undefined && (
                            <span className="text-slate-400">Kein Plan</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Personalbedarf */}
          <div>
            <h2 className="text-base font-bold text-slate-800 border-b-2 border-blue-700 pb-1 mb-3">Personalbedarf Plating</h2>
            {dayPlatingSummaries.length === 0 ? (
              <p className="text-sm text-slate-400 italic">Linienplan nicht gefüllt – kein Personalbedarf berechenbar.</p>
            ) : (
              <>
                <table className="w-full text-xs border-collapse mb-2">
                  <thead>
                    <tr className="bg-blue-800 text-white">
                      <th className="p-2 text-left">Tag</th>
                      <th className="p-2 text-left">Datum</th>
                      <th className="p-2 text-left">Aktive Linien</th>
                      <th className="p-2 text-right">MA Plating</th>
                      <th className="p-2 text-right">Portionen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayPlatingSummaries.map((ds, i) => (
                      <tr key={ds.day} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                        <td className="p-2 font-bold">{ds.dayLong}</td>
                        <td className="p-2 text-slate-500">{dayDate(week, ds.day)}</td>
                        <td className="p-2">
                          {Array.from(ds.activeLines).sort().map(li => (
                            <span key={li} className="mr-1 rounded bg-blue-100 text-blue-800 text-[10px] px-1.5 py-0.5 font-semibold">P-Linie {li + 1}</span>
                          ))}
                        </td>
                        <td className="p-2 text-right font-bold text-blue-900">{ds.staffNeeded}</td>
                        <td className="p-2 text-right tabular-nums text-slate-600">{fmtNum(ds.totalPortions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-700">
                  Besetzung pro Linie: 1 Maschinenführer + 2 Bestücker/Packer + 1 Flex/Endkontrolle = <strong>4 MA</strong>. Bei Speed &gt; 15 Port./min: +1 MA.
                </div>
              </>
            )}
          </div>

          {/* Allergene */}
          {batchSplitPlan.some(p => (allergensByRecipe[p.recipeCode] ?? []).length > 0) && (
            <div>
              <h2 className="text-base font-bold text-slate-800 border-b-2 border-blue-700 pb-1 mb-3">Allergene – FSQA-Hinweis</h2>
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-blue-800 text-white">
                    <th className="p-2 text-left">Rezept</th>
                    <th className="p-2 text-left">Name</th>
                    <th className="p-2 text-left">Allergene</th>
                  </tr>
                </thead>
                <tbody>
                  {batchSplitPlan.filter(p => (allergensByRecipe[p.recipeCode] ?? []).length > 0).map((plan, i) => (
                    <tr key={plan.recipeCode} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                      <td className="p-2 font-mono font-bold text-blue-900">{plan.recipeCode}</td>
                      <td className="p-2 text-slate-700">{plan.recipeName.replace(/\[.*?\]/g, "").trim().slice(0, 40)}</td>
                      <td className="p-2">
                        {(allergensByRecipe[plan.recipeCode] ?? []).map(al => (
                          <span key={al} className="mr-1 rounded bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.5 font-semibold">{al}</span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Anmerkungen */}
          <div>
            <h2 className="text-base font-bold text-slate-800 border-b-2 border-blue-700 pb-1 mb-3">Anmerkungen aus Linienplanung</h2>
            {filledComments.length === 0 ? (
              <p className="text-sm text-slate-400 italic">Keine Anmerkungen vorhanden.</p>
            ) : (
              <div className="space-y-2">
                {filledComments.map(([key, comment]) => {
                  const [dayDE, slot, li] = key.split("|");
                  return (
                    <div key={key} className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-800">
                      <strong>{dayDE ?? ""} · {slot ?? ""} · Linie {parseInt(li ?? "0") + 1}:</strong> {comment}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-slate-200 pt-3 text-xs text-slate-400">
            Automatisch generiert · Rezeptlogik-Planungssystem · {week} · {new Date().toLocaleString("de-DE")}
          </div>
        </div>
      </div>
    </div>
  );
}
