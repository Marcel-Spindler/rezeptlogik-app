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
import { analyzePlan, computeBatchSplitPlan, loadPlannerStorage, getActiveScenario, type PlannerDay, type LinePlatingSummary, type LinePlatingEntry } from "./planner";
import { usePlanningOasisData } from "./planningOasisData";

// ── Konstanten ──────────────────────────────────────────────────────────────

const SLOT_DURATIONS: Record<string, number> = {
  "07:00-08:00": 60, "08:00-08:30": 30,
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

type ManufacturingMailDay = {
  id: string;
  day: PlannerDay;
  label: string;
  lane: "prep" | "regular";
};

const MANUFACTURING_MAIL_DAYS: readonly ManufacturingMailDay[] = [
  { id: "prep-so", day: "So", label: "Sonntag Prep", lane: "prep" },
  { id: "mo", day: "Mo", label: "Montag", lane: "regular" },
  { id: "di", day: "Di", label: "Dienstag", lane: "regular" },
  { id: "mi", day: "Mi", label: "Mittwoch", lane: "regular" },
  { id: "do", day: "Do", label: "Donnerstag", lane: "regular" },
  { id: "fr", day: "Fr", label: "Freitag", lane: "regular" },
  { id: "sa", day: "Sa", label: "Samstag", lane: "regular" },
  { id: "so", day: "So", label: "Sonntag", lane: "regular" },
];

const RUN_ONE_SUB_DAYS: readonly PlannerDay[] = ["So", "Mo", "Di", "Mi"];
const RUN_TWO_SUB_DAYS: readonly PlannerDay[] = ["Mo", "Di", "Mi", "Do"];
const RACK_REQUIRED_LINE_IDS = ["ASL1", "ASL2", "ASL3", "ASL4", "ASL5", "ASL6"] as const;

type ManufacturingMailSummary = {
  column: ManufacturingMailDay;
  mainCount: number;
  subRunCount: number;
  mainPortions: number;
  subPortions: number;
  items: string[];
};
type ManufacturingActionRow = {
  dayLabel: string;
  areaLabel: string;
  totalPortions: number;
  instruction: string;
};
type MailAudience = "management" | "shift";
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

interface LineOperationsSummary {
  lineIdx: number;
  planned: number;
  capacity: number;
  utilization: number;
  blocks: SlotBlock[];
}

interface DayOperationsSummary {
  day: PlannerDay;
  dayLong: string;
  dateLabel: string;
  planned: number;
  capacity: number;
  utilization: number;
  staffNeeded: number;
  lineSummaries: LineOperationsSummary[];
  recipeCodes: string[];
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

function pct(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${Math.round(n * 100)}%`;
}

function cleanName(name: string, max = 45): string {
  return name.replace(/\[.*?\]/g, "").trim().slice(0, max);
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clampPlatingLineCount(value: number | undefined): number {
  if (value === 1 || value === 2 || value === 3) return value;
  return 3;
}

function slotPortionsFromLineCapacity(lineCapacityByLane: Record<string, number>, lineIdx: number, slotKey: string): number {
  const capacityPerHour = Math.max(0, Number(lineCapacityByLane[String(lineIdx)] ?? 0));
  const duration = SLOT_DURATIONS[slotKey];
  if (!duration) return 0;
  return Math.round((capacityPerHour / 60) * duration);
}

function parseBoardNote(note?: string): { notes: string } {
  const raw = String(note ?? "").trim();
  if (!raw) return { notes: "" };
  const notesPart = raw.split("||").find((part) => part.startsWith("notes=")) ?? "";
  return { notes: notesPart ? notesPart.slice(6).trim() : "" };
}

function extractSplitSpecFromNotes(notes: string): string {
  const match = /(?:^|\s)split=([^\s]+)/i.exec(String(notes ?? "").trim());
  return match?.[1]?.trim() ?? "";
}

function distributedRunSubDay(runIndex: number, subIndex: number): PlannerDay {
  const window = runIndex === 0 ? RUN_ONE_SUB_DAYS : RUN_TWO_SUB_DAYS;
  const offset = runIndex === 0 ? 0 : 2;
  return window[(subIndex + offset) % window.length] ?? window[0];
}

function parseSplitSpecToBatches(splitSpec: string, fallbackDay: PlannerDay, totalTarget: number): Array<{ day: PlannerDay; portions: number }> {
  const tokens = splitSpec.split("|").map((part) => part.trim()).filter(Boolean);
  if (tokens.length === 0) return totalTarget > 0 ? [{ day: fallbackDay, portions: totalTarget }] : [];
  const parsed: Array<{ day: PlannerDay; portions: number }> = [];
  for (const token of tokens) {
    const [rawDay, rawPortions] = token.split(":");
    if (!rawDay || !rawPortions) continue;
    const day = rawDay.trim() as PlannerDay;
    if (!DAY_LONG[day]) continue;
    const portions = Math.max(0, Math.round(Number(rawPortions) || 0));
    if (portions > 0) parsed.push({ day, portions });
  }
  return parsed.length > 0 ? parsed : totalTarget > 0 ? [{ day: fallbackDay, portions: totalTarget }] : [];
}

function runSubBatchesForMail(
  mainAssignment: { day: PlannerDay; targetPortions?: number; note?: string },
  subAssignment: { targetPortions?: number },
  fallbackPortions: number,
  subIndex: number
): Array<{ label: string; portions: number; day: PlannerDay }> {
  const mainPortions = Math.max(0, Math.round(mainAssignment.targetPortions ?? 0));
  const splitSpec = extractSplitSpecFromNotes(parseBoardNote(mainAssignment.note).notes);
  const mainBatches = parseSplitSpecToBatches(splitSpec, mainAssignment.day, mainPortions);
  if (mainBatches.length <= 1) return [];
  const mainTotal = mainBatches.reduce((sum, batch) => sum + batch.portions, 0);
  if (mainTotal <= 0) return [];
  const subTotal = subAssignment.targetPortions ?? fallbackPortions;
  return mainBatches.map((batch, index) => ({
    label: `Run ${index + 1}`,
    portions: Math.max(0, Math.round(subTotal * batch.portions / mainTotal)),
    day: distributedRunSubDay(index, subIndex),
  }));
}

function isSundayPrepSub(category: string): boolean {
  return /thaw|marinade|marinated|mariniert|hand marinade|patty maker|spice|gewürz|gewuerz|butter/i.test(String(category ?? ""));
}
function manufacturingInstruction(row: ManufacturingMailSummary): string {
  const total = row.mainPortions + row.subPortions;
  if (total <= 0) {
    return "Keine aktive Produktion. Slot fuer Hygiene, Setup und Materialvorbereitung nutzen.";
  }
  if (row.mainCount > 0 && row.subRunCount > 0) {
    return "Main-Rezepte zuerst stabil fahren, danach Sub-Runs sequenziell abarbeiten und Rueckmeldung bei Engpaessen geben.";
  }
  if (row.mainCount > 0) {
    return "Fokus auf Main-Produktion; Zielmengen pro Rezept vollstaendig auf Tagesende absichern.";
  }
  return "Fokus auf Submeal-Runs; Chargen sauber nach Reihenfolge fertigstellen und fuer Plating bereitstellen.";
}

function platingInstruction(row: DayOperationsSummary): string {
  if (row.planned <= 0) return "Keine aktive Plating-Produktion. Linie auf Reinigung, Wartung und Materialbereitstellung setzen.";
  if (row.utilization > 1) return "Ueberlast erkannt. Prioritaet auf Run 1, Slot-Folge strikt halten und Engpass sofort an Schichtfuehrung melden.";
  if (row.utilization >= 0.85) return "Hohe Auslastung. Team eng takten, Slot-Wechsel ohne Wartezeit fahren, Qualitaetskontrollen engmaschig.";
  return "Stabile Last. Linie gemaess Slot-Plan fahren und freie Zeit fuer Vorruestung des Folgeslots nutzen.";
}

function rackInstruction(releaseStatus: string): string {
  if (releaseStatus === "released") return "Freigegeben. Pick/Pack im Standardmodus fahren und Bestand laufend rueckmelden.";
  if (releaseStatus === "ready") return "Befuellung abgeschlossen, finale Freigabe durch Schichtleitung erforderlich.";
  if (releaseStatus === "blocked") return "Blockiert. Prioritaet auf Stoerungsbehebung und unmittelbare Eskalation an OPS Lead.";
  return "In Arbeit. Rack vervollstaendigen und anschliessend auf released setzen.";
}

// ── SVG-Chart-Helfer ─────────────────────────────────────────────────────────

function buildSvgBarChart(
  items: Array<{ label: string; value: number }>,
  opts: { width?: number; height?: number; color?: string; title?: string }
): string {
  const W = opts.width ?? 580;
  const H = opts.height ?? 150;
  const color = opts.color ?? "#1e40af";
  const padLeft = 8;
  const padRight = 8;
  const padTop = opts.title ? 28 : 8;
  const padBottom = 30;
  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;
  const maxVal = Math.max(...items.map(i => i.value), 1);
  const colW = Math.floor(chartW / Math.max(items.length, 1));
  const barW = Math.max(4, colW - 8);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="font-family:Calibri,Arial,sans-serif;background:#f8fafc;border-radius:8px">`;
  if (opts.title) {
    svg += `<text x="12" y="18" font-size="12" font-weight="bold" fill="#1e293b">${escapeHtml(opts.title)}</text>`;
  }
  items.forEach((item, i) => {
    const barH = maxVal > 0 ? Math.max(2, Math.round((item.value / maxVal) * chartH)) : 0;
    const x = padLeft + i * colW + Math.floor((colW - barW) / 2);
    const y = padTop + chartH - barH;
    svg += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="${color}" opacity="0.85"/>`;
    if (item.value > 0) {
      svg += `<text x="${x + barW / 2}" y="${y - 3}" text-anchor="middle" font-size="9" fill="#1e3a8a" font-weight="bold">${fmtNum(item.value)}</text>`;
    }
    const labelLines = item.label.split(" ");
    labelLines.forEach((line, li) => {
      svg += `<text x="${x + barW / 2}" y="${H - padBottom + 12 + li * 11}" text-anchor="middle" font-size="9" fill="#64748b">${escapeHtml(line)}</text>`;
    });
  });
  svg += `</svg>`;
  return svg;
}

function buildRackStatusSvg(rows: Array<{ lineId: string; status: string }>): string {
  const W = 580;
  const count = rows.length || 1;
  const tileW = Math.floor((W - 24 - (count - 1) * 6) / count);
  const H = 66;
  const colors: Record<string, string> = { released: "#16a34a", ready: "#2563eb", blocked: "#dc2626", open: "#94a3b8" };
  const bgColors: Record<string, string> = { released: "#dcfce7", ready: "#dbeafe", blocked: "#fee2e2", open: "#f1f5f9" };
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="font-family:Calibri,Arial,sans-serif;background:#f8fafc;border-radius:8px">`;
  rows.forEach((row, i) => {
    const x = 12 + i * (tileW + 6);
    const fill = bgColors[row.status] ?? "#f1f5f9";
    const stroke = colors[row.status] ?? "#94a3b8";
    svg += `<rect x="${x}" y="6" width="${tileW}" height="${H - 12}" rx="6" fill="${fill}" stroke="${stroke}" stroke-opacity="0.5" stroke-width="1.5"/>`;
    svg += `<text x="${x + tileW / 2}" y="26" text-anchor="middle" font-size="13" font-weight="800" fill="#0f172a">${escapeHtml(row.lineId)}</text>`;
    svg += `<text x="${x + tileW / 2}" y="44" text-anchor="middle" font-size="9" font-weight="700" fill="${stroke}">${row.status.toUpperCase()}</text>`;
    if (row.status === "released") {
      svg += `<text x="${x + tileW / 2}" y="57" text-anchor="middle" font-size="10" fill="${stroke}">✓</text>`;
    }
  });
  svg += `</svg>`;
  return svg;
}

function buildPlatingUtilSvg(dayRows: Array<{ dayLong: string; utilization: number; planned: number }>): string {
  const W = 580;
  const rowH = 26;
  const labelW = 72;
  const valW = 50;
  const barMaxW = W - labelW - valW - 20;
  const H = 24 + dayRows.length * rowH + 8;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="font-family:Calibri,Arial,sans-serif;background:#f8fafc;border-radius:8px">`;
  svg += `<text x="8" y="16" font-size="11" font-weight="bold" fill="#1e293b">Plating-Auslastung je Tag</text>`;
  dayRows.forEach((row, i) => {
    const y = 24 + i * rowH;
    const pctVal = Math.min(1, row.utilization);
    const barW = Math.max(0, Math.round(pctVal * barMaxW));
    const barColor = row.utilization > 1 ? "#dc2626" : row.utilization >= 0.85 ? "#f59e0b" : "#2563eb";
    svg += `<text x="8" y="${y + 15}" font-size="10" fill="#475569">${escapeHtml(row.dayLong)}</text>`;
    svg += `<rect x="${labelW}" y="${y + 4}" width="${barMaxW}" height="16" rx="4" fill="#e2e8f0"/>`;
    if (barW > 0) svg += `<rect x="${labelW}" y="${y + 4}" width="${barW}" height="16" rx="4" fill="${barColor}"/>`;
    const pctLabel = `${Math.round(row.utilization * 100)}%`;
    svg += `<text x="${labelW + barMaxW + 6}" y="${y + 15}" font-size="10" font-weight="bold" fill="#334155">${pctLabel}</text>`;
  });
  svg += `</svg>`;
  return svg;
}

function svgToDataUri(svgContent: string): string {
  try {
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgContent)))}`;
  } catch {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;
  }
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
  const [lineCapacityByLane, setLineCapacityByLane] = useState<Record<string, number>>({ "0": 1200, "1": 1200, "2": 1200 });
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
              setLineCapacityByLane({ "0": 1200, "1": 1200, "2": 1200, ...(d.lineCapacityByLane ?? {}) });
              setPlatingLineCount(clampPlatingLineCount(d.platingLineCount));
              setLinePlanComments(d.comments ?? {});
              setLinePlanSavedAt(d.savedAt ?? null);
            } else {
              setLinePlanRaw({});
              setLineCapacityByLane({ "0": 1200, "1": 1200, "2": 1200 });
              setPlatingLineCount(3);
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
  const [rackReleaseByLine, setRackReleaseByLine] = useState<Record<string, string>>({
    ASL1: "open",
    ASL2: "open",
    ASL3: "open",
    ASL4: "open",
    ASL5: "open",
    ASL6: "open",
  });

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
              const releaseByLine = Object.fromEntries(
                RACK_REQUIRED_LINE_IDS.map((lineId) => [lineId, String(lines[lineId]?.releaseStatus ?? "open")])
              ) as Record<string, string>;
              const allReleased = RACK_REQUIRED_LINE_IDS.every((lineId) => releaseByLine[lineId] === "released");
              setRackReleaseByLine(releaseByLine);
              setRackAllReleased(allReleased);
            } else {
              setRackReleaseByLine({ ASL1: "open", ASL2: "open", ASL3: "open", ASL4: "open", ASL5: "open", ASL6: "open" });
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
  const manufacturingAnalysis = useMemo(() => analyzePlan(data, week, scenario), [data, week, scenario]);

  // Cockpit-Bestätigung: Wochenplaner hat mindestens 1 Rezept zugewiesen
  const cockpitHasAssignments = useMemo(
    () => Object.keys(scenario.assignments).length > 0,
    [scenario]
  );
  const [manufacturingSnapshotSavedAt, setManufacturingSnapshotSavedAt] = useState<string | null>(null);
  const [manufacturingSnapshotLoaded, setManufacturingSnapshotLoaded] = useState(false);

  useEffect(() => {
    const refreshSnapshotStatus = () => {
      try {
        const raw = window.localStorage.getItem(`rezeptlogik-plan-snapshot-${week}`);
        if (!raw) {
          setManufacturingSnapshotSavedAt(null);
          setManufacturingSnapshotLoaded(true);
          return;
        }
        const parsed = JSON.parse(raw) as { savedAtLabel?: string; savedAtIso?: string };
        setManufacturingSnapshotSavedAt(parsed.savedAtLabel ?? parsed.savedAtIso ?? null);
      } catch {
        setManufacturingSnapshotSavedAt(null);
      } finally {
        setManufacturingSnapshotLoaded(true);
      }
    };

    refreshSnapshotStatus();
    window.addEventListener("focus", refreshSnapshotStatus);
    window.addEventListener("storage", refreshSnapshotStatus);
    window.addEventListener("rezeptlogik:plan-snapshot-saved", refreshSnapshotStatus as EventListener);
    return () => {
      window.removeEventListener("focus", refreshSnapshotStatus);
      window.removeEventListener("storage", refreshSnapshotStatus);
      window.removeEventListener("rezeptlogik:plan-snapshot-saved", refreshSnapshotStatus as EventListener);
    };
  }, [week]);

  const targetPortionsByRecipe = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of data.weekRecipes) {
      if (row.hfWeek !== week) continue;
      const total = Math.max(0, Math.round(row.totalVerdenVolume ?? ((row.verdenVolume.BENL ?? 0) + (row.verdenVolume.DKSE ?? 0) + (row.verdenVolume.DE ?? 0))));
      if (total > 0) map.set(row.code, total);
    }
    return map;
  }, [data.weekRecipes, week]);

  const allocatedLinePortionsByCell = useMemo(() => {
    const allocated = new Map<string, number>();
    const producedByRecipe = new Map<string, number>();
    const entries = Object.entries(linePlanRaw)
      .filter(([, recipe]) => !!recipe)
      .sort(([left], [right]) => {
        const [leftDay, leftSlot, leftLine] = left.split("|");
        const [rightDay, rightSlot, rightLine] = right.split("|");
        const leftPlannerDay = DAY_MAP[leftDay ?? ""];
        const rightPlannerDay = DAY_MAP[rightDay ?? ""];
        const dayOrder: PlannerDay[] = ["Di", "Mi", "Do", "Fr", "Sa", "So", "Mo"];
        const dayDelta = (leftPlannerDay ? dayOrder.indexOf(leftPlannerDay) : 99)
          - (rightPlannerDay ? dayOrder.indexOf(rightPlannerDay) : 99);
        if (dayDelta !== 0) return dayDelta;
        const slotDelta = Object.keys(SLOT_DURATIONS).indexOf(leftSlot ?? "") - Object.keys(SLOT_DURATIONS).indexOf(rightSlot ?? "");
        if (slotDelta !== 0) return slotDelta;
        return Number(leftLine ?? 0) - Number(rightLine ?? 0);
      });

    for (const [key, recipe] of entries) {
      if (!recipe || recipe.code === "__BREAK__") continue;
      const [, slotKey, lineIdxStr] = key.split("|");
      const lineIdx = parseInt(lineIdxStr ?? "0");
      if (!Number.isFinite(lineIdx) || lineIdx < 0 || lineIdx >= platingLineCount) continue;
      const target = targetPortionsByRecipe.get(recipe.code) ?? Number.MAX_SAFE_INTEGER;
      const alreadyProduced = producedByRecipe.get(recipe.code) ?? 0;
      const slotPortions = slotPortionsFromLineCapacity(lineCapacityByLane, lineIdx, slotKey ?? "");
      const portions = Math.max(0, Math.min(slotPortions, target - alreadyProduced));
      allocated.set(key, portions);
      producedByRecipe.set(recipe.code, alreadyProduced + portions);
    }
    return allocated;
  }, [lineCapacityByLane, linePlanRaw, platingLineCount, targetPortionsByRecipe]);

  // Freigabe-Gate: Rundmail basiert auf gesichertem Plating-Plan + Küchenplan.
  const linePlanConfirmed = linePlanLoaded && linePlanSavedAt !== null;
  const manufacturingPlanConfirmed = manufacturingSnapshotLoaded && manufacturingSnapshotSavedAt !== null && cockpitHasAssignments;
  const rackConfirmed = rackLoaded && rackAllReleased;
  const allConfirmed = linePlanConfirmed && manufacturingPlanConfirmed && rackConfirmed;

  // LinePlatingSummary (für computeBatchSplitPlan)
  const linePlatingSummary = useMemo((): LinePlatingSummary => {
    const byRecipe: Record<string, LinePlatingEntry[]> = {};
    for (const [key, recipe] of Object.entries(linePlanRaw)) {
      if (!recipe || recipe.code === "__BREAK__") continue;
      const parts = key.split("|");
      if (parts.length !== 3) continue;
      const [dayDE, slotKey, lineIdxStr] = parts;
      const platDay = DAY_MAP[dayDE ?? ""];
      if (!platDay) continue;
      const lineIdx = parseInt(lineIdxStr ?? "0");
      if (!Number.isFinite(lineIdx) || lineIdx < 0 || lineIdx >= platingLineCount) continue;
      const portions = allocatedLinePortionsByCell.get(key) ?? slotPortionsFromLineCapacity(lineCapacityByLane, lineIdx, slotKey ?? "");
      if (portions <= 0) continue;
      const entries = (byRecipe[recipe.code] ??= []);
      const existing = entries.find(e => e.platDay === platDay);
      if (existing) { existing.capacityPortions += portions; existing.slotCount += 1; }
      else entries.push({ platDay, capacityPortions: portions, slotCount: 1 });
    }
    return { byRecipe };
  }, [allocatedLinePortionsByCell, lineCapacityByLane, linePlanRaw, platingLineCount]);

  const batchSplitPlan = useMemo(
    () => computeBatchSplitPlan(data, week, linePlatingSummary),
    [data, week, linePlatingSummary]
  );

  // ── Plating-Tagesübersicht aufbauen ───────────────────────────────────────
  const dayPlatingSummaries = useMemo((): DayPlatingSummary[] => {
    const byDay = new Map<PlannerDay, SlotBlock[]>();
    for (const [key, recipe] of Object.entries(linePlanRaw)) {
      if (!recipe || recipe.code === "__BREAK__") continue;
      const parts = key.split("|");
      if (parts.length !== 3) continue;
      const [dayDE, slotKey, lineIdxStr] = parts;
      const day = DAY_MAP[dayDE ?? ""];
      if (!day) continue;
      const lineIdx = parseInt(lineIdxStr ?? "0");
      if (!Number.isFinite(lineIdx) || lineIdx < 0 || lineIdx >= platingLineCount) continue;
      const portions = allocatedLinePortionsByCell.get(key) ?? slotPortionsFromLineCapacity(lineCapacityByLane, lineIdx, slotKey ?? "");
      if (portions <= 0) continue;
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
  }, [allocatedLinePortionsByCell, lineCapacityByLane, linePlanRaw, platingLineCount]);

  const activePlatingLineIdx = useMemo(
    () => Array.from({ length: platingLineCount }, (_, index) => index),
    [platingLineCount]
  );

  const operationsDaySummaries = useMemo((): DayOperationsSummary[] => {
    return dayPlatingSummaries.map((daySummary) => {
      const lineSummaries = activePlatingLineIdx.map((lineIdx) => {
        const blocks = daySummary.blocks
          .filter((block) => block.lineIdx === lineIdx)
          .sort((a, b) => a.slotKey.localeCompare(b.slotKey));
        const planned = blocks.reduce((sum, block) => sum + block.portions, 0);
        const capacity = Object.keys(SLOT_DURATIONS).reduce(
          (sum, slotKey) => sum + slotPortionsFromLineCapacity(lineCapacityByLane, lineIdx, slotKey),
          0
        );
        return {
          lineIdx,
          planned,
          capacity,
          utilization: capacity > 0 ? planned / capacity : 0,
          blocks,
        };
      });
      const planned = lineSummaries.reduce((sum, line) => sum + line.planned, 0);
      const capacity = lineSummaries.reduce((sum, line) => sum + line.capacity, 0);
      const recipeCodes = Array.from(new Set(daySummary.blocks.map((block) => block.recipe.code))).sort();
      return {
        day: daySummary.day,
        dayLong: daySummary.dayLong,
        dateLabel: dayDate(week, daySummary.day),
        planned,
        capacity,
        utilization: capacity > 0 ? planned / capacity : 0,
        staffNeeded: daySummary.staffNeeded,
        lineSummaries,
        recipeCodes,
      };
    });
  }, [activePlatingLineIdx, dayPlatingSummaries, lineCapacityByLane, week]);

  // ── Allergene aus PlanningOasis ───────────────────────────────────────────
  const allergensByRecipe = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const plan of batchSplitPlan) {
      const intel = oasis?.recipes[plan.recipeCode];
      if (intel?.allergens?.length) result[plan.recipeCode] = intel.allergens;
    }
    return result;
  }, [batchSplitPlan, oasis]);

  // ── Plating-Prio-Reihenfolge: alle belegten Slots nach Prio sortiert ────────
  type PrioPlatingRow =
    | { kind: "recipe"; priority: number; code: string; name: string; dayLong: string; lineLabel: string; slotKey: string; portions: number }
    | { kind: "break"; dayLong: string; lineLabel: string; slotKey: string };

  const prioPlatingRows = useMemo((): PrioPlatingRow[] => {
    const rows: PrioPlatingRow[] = [];
    const DAY_ORDER: PlannerDay[] = ["Di", "Mi", "Do", "Fr", "Sa", "So", "Mo"];

    // Priority for each recipe from oasis work orders (lowest number = highest prio)
    const prioByCode = new Map<string, number>();
    if (oasis) {
      for (const [code, intel] of Object.entries(oasis.recipes)) {
        const wos = intel.workOrders;
        if (wos.length > 0) {
          const minPrio = Math.min(...wos.map(wo => wo.priority).filter(p => p > 0));
          if (isFinite(minPrio)) prioByCode.set(code, minPrio);
        }
      }
    }

    const allEntries = Object.entries(linePlanRaw)
      .filter(([, r]) => !!r)
      .sort(([a], [b]) => {
        const [aDay, aSlot, aLine] = a.split("|");
        const [bDay, bSlot, bLine] = b.split("|");
        const aDayIdx = DAY_ORDER.indexOf(DAY_MAP[aDay ?? ""] ?? "Di");
        const bDayIdx = DAY_ORDER.indexOf(DAY_MAP[bDay ?? ""] ?? "Di");
        if (aDayIdx !== bDayIdx) return aDayIdx - bDayIdx;
        const slotOrder = Object.keys(SLOT_DURATIONS);
        const aSlotIdx = slotOrder.indexOf(aSlot ?? "");
        const bSlotIdx = slotOrder.indexOf(bSlot ?? "");
        if (aSlotIdx !== bSlotIdx) return aSlotIdx - bSlotIdx;
        return Number(aLine ?? 0) - Number(bLine ?? 0);
      });

    for (const [key, recipe] of allEntries) {
      if (!recipe) continue;
      const [dayDE, slotKey, lineIdxStr] = key.split("|");
      const dayLong = dayDE ?? "";
      const lineIdx = parseInt(lineIdxStr ?? "0");
      const lineLabel = `P-Linie ${lineIdx + 1}`;
      if (recipe.code === "__BREAK__") {
        rows.push({ kind: "break", dayLong, lineLabel, slotKey: slotKey ?? "" });
      } else {
        const portions = allocatedLinePortionsByCell.get(key) ?? 0;
        rows.push({
          kind: "recipe",
          priority: prioByCode.get(recipe.code) ?? 999,
          code: recipe.code,
          name: recipe.name,
          dayLong,
          lineLabel,
          slotKey: slotKey ?? "",
          portions,
        });
      }
    }

    // Sort recipe rows by priority, keeping breaks attached to their day/line/slot position
    // Strategy: group by (day+line), sort recipes within the full list by prio, preserve breaks in place
    rows.sort((a, b) => {
      if (a.kind === "recipe" && b.kind === "recipe") return a.priority - b.priority;
      return 0;
    });

    return rows;
  }, [allocatedLinePortionsByCell, linePlanRaw, oasis]);

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

  const manufacturingDaySummaries = useMemo((): ManufacturingMailSummary[] => {
    const rows = MANUFACTURING_MAIL_DAYS.map((column) => ({
      column,
      mainCount: 0,
      subRunCount: 0,
      mainPortions: 0,
      subPortions: 0,
      items: [] as string[],
    }));
    const byColumnId = new Map(rows.map((row) => [row.column.id, row]));
    const forecastByCode = new Map(data.weekRecipes.filter(row => row.hfWeek === week).map(row => [row.code, row.totalVerdenVolume ?? 0]));
    const addMain = (day: PlannerDay, portions: number, label: string) => {
      const column = MANUFACTURING_MAIL_DAYS.find((item) => item.day === day && item.lane === "regular");
      const row = column ? byColumnId.get(column.id) : undefined;
      if (!row) return;
      row.mainCount += 1;
      row.mainPortions += portions;
      if (row.items.length < 7) row.items.push(label);
    };
    const addSub = (day: PlannerDay, portions: number, label: string, prepSunday: boolean) => {
      const column = MANUFACTURING_MAIL_DAYS.find((item) => item.day === day && (day === "So" && prepSunday ? item.lane === "prep" : item.lane === "regular"));
      const row = column ? byColumnId.get(column.id) : undefined;
      if (!row) return;
      row.subRunCount += 1;
      row.subPortions += portions;
      if (row.items.length < 7) row.items.push(label);
    };

    for (const recipe of manufacturingAnalysis.recipes) {
      const forecast = forecastByCode.get(recipe.recipeCode) ?? 0;
      if (recipe.assigned) {
        addMain(recipe.assigned.day, Math.max(0, Math.round(recipe.assigned.targetPortions ?? forecast)), `${recipe.recipeCode} Main`);
      }
      recipe.subRecipes.forEach((sub, subIndex) => {
        if (!sub.assigned) return;
        const splitBatches = recipe.assigned ? runSubBatchesForMail(recipe.assigned, sub.assigned, forecast, subIndex) : [];
        if (splitBatches.length > 0) {
          for (const batch of splitBatches) {
            addSub(batch.day, batch.portions, `${recipe.recipeCode} ${batch.label} ${sub.subRecipeName}`, batch.day === "So" || isSundayPrepSub(sub.category));
          }
          return;
        }
        addSub(
          sub.assigned.day,
          Math.max(0, Math.round(sub.assigned.targetPortions ?? forecast)),
          `${recipe.recipeCode} ${sub.subRecipeName}`,
          sub.assigned.day === "So" && isSundayPrepSub(sub.category)
        );
      });
    }
    return rows;
  }, [data.weekRecipes, manufacturingAnalysis.recipes, week]);

  // ── Gesamt-Portionen aus Forecast ─────────────────────────────────────────
  const totalPortionsForecast = useMemo(() =>
    batchSplitPlan.reduce((s, p) => s + p.totalPortions, 0),
    [batchSplitPlan]
  );
  const totalPortionsLine = useMemo(() =>
    dayPlatingSummaries.reduce((s, d) => s + d.totalPortions, 0),
    [dayPlatingSummaries]
  );
  const totalAvailableLineCapacity = useMemo(
    () => operationsDaySummaries.reduce((sum, day) => sum + day.capacity, 0),
    [operationsDaySummaries]
  );
  const totalLineUtilization = totalAvailableLineCapacity > 0 ? totalPortionsLine / totalAvailableLineCapacity : 0;
  const hasSeafood = batchSplitPlan.some(p => p.isSeafood);
  const allergenRecipeCount = batchSplitPlan.filter(p => (allergensByRecipe[p.recipeCode] ?? []).length > 0).length;
  const totalManufacturingJobs = manufacturingDaySummaries.reduce((sum, row) => sum + row.mainCount + row.subRunCount, 0);
    const totalManufacturingPortions = manufacturingDaySummaries.reduce((sum, row) => sum + row.mainPortions + row.subPortions, 0);
    const manufacturingActionRows = useMemo<ManufacturingActionRow[]>(() => {
      return manufacturingDaySummaries.map((row) => ({
        dayLabel: row.column.label,
        areaLabel: row.column.lane === "prep" ? "Sunday Prep" : "Kueche Regular",
        totalPortions: row.mainPortions + row.subPortions,
        instruction: manufacturingInstruction(row),
      }));
    }, [manufacturingDaySummaries]);
  const maxPlatingStaff = dayPlatingSummaries.reduce((max, day) => Math.max(max, day.staffNeeded), 0);
  const rackActionRows = useMemo(() => {
    return RACK_REQUIRED_LINE_IDS.map((lineId) => {
      const status = rackReleaseByLine[lineId] ?? "open";
      return {
        lineId,
        status,
        done: status === "released",
        instruction: rackInstruction(status),
      };
    });
  }, [rackReleaseByLine]);
  const rackReleasedCount = rackActionRows.filter((row) => row.done).length;

  const coverageWarnings = useMemo(
    () => batchSplitPlan.filter(p => p.lineCoverageGap !== undefined && p.lineCoverageGap > 0),
    [batchSplitPlan]
  );

  const liveLinks = useMemo(() => {
    const build = (view: string, kitchen = false) => {
      const url = new URL(window.location.href);
      url.searchParams.set("week", week);
      url.searchParams.set("view", view);
      if (kitchen) url.searchParams.set("surface", "kitchen");
      else url.searchParams.delete("surface");
      url.searchParams.delete("mode");
      url.searchParams.delete("kitchen");
      return url.toString();
    };
    return {
      cockpit: build("planning"),
      plating: build("ket"),
      rack: build("rack"),
      rundmail: build("rundmail"),
      kitchenShare: build("breakdown", true),
    };
  }, [week]);

  // ── Export-Funktionen ─────────────────────────────────────────────────────
  const [copyState, setCopyState] = useState<"idle" | "ok">("idle");
  const [htmlCopyState, setHtmlCopyState] = useState<"idle" | "ok">("idle");
  const [mailAudience, setMailAudience] = useState<MailAudience>("shift");

  function buildPlainText(audience: MailAudience): string {
    const managementMode = audience === "management";
    const kw = week.split("-W")[1] ?? week;
    const lines: string[] = [];
    const h = (s: string) => lines.push(s);
    const sep = () => lines.push("─".repeat(60));

    h(`PLANUNGSRUNDMAIL – KW ${kw} / ${fmtDate(week)}`);
    h(`Standort: Verden (VF)  |  Erstellt: ${new Date().toLocaleString("de-DE")}`);
    h(`Version: ${managementMode ? "Management" : "Schichtleitung"}`);
    h("Factor OPS Edition: Manufacturing + Rack + Plating in einem operativen Auftrag.");
    sep();
    h("ZUSAMMENFASSUNG");
    h("Operative Empfehlung: Fokus auf stabilem Run-1-Durchsatz, Forecast-Differenzen werden als Run-2-Anpassung gefahren. Kritische Abweichungen im Tagesverlauf sofort rueckmelden.");
    h(`Rezepte gesamt:        ${batchSplitPlan.length}`);
    h(`Forecast Portionen:    ${fmtNum(totalPortionsForecast)}`);
    h(`Plating geplant:       ${fmtNum(totalPortionsLine)}`);
    h(`Plating Tageskapa:     ${fmtNum(totalAvailableLineCapacity)} (${pct(totalLineUtilization)} Auslastung)`);
    h(`Aktive Plating-Linien: ${platingLineCount}`);
    h(`Max. MA Plating/Tag:   ${maxPlatingStaff}`);
    h(`Küchenjobs:            ${totalManufacturingJobs}`);
      h(`Kuechen-Portionen:     ${fmtNum(totalManufacturingPortions)}`);
    if (hasSeafood) h("HINWEIS: Enthält Fisch-Rezepte (MHD 9 Tage - Küchen-Deadline beachten!)");
    sep();

    if (!managementMode && prioPlatingRows.length > 0) {
      h("PLATING-REIHENFOLGE NACH PRIO");
      h("(Alle belegten Slots nach Rezept-Priorität – Zeilen mit [PAUSE] = 1h Reinigung nach Rezeptwechsel)");
      h(`${"Prio".padEnd(6)} ${"Rezept".padEnd(12)} ${"Name".padEnd(35)} ${"Tag".padEnd(12)} ${"Linie".padEnd(12)} ${"Zeitslot".padEnd(16)} ${"Portionen".padStart(10)}`);
      h("-".repeat(103));
      for (const row of prioPlatingRows) {
        if (row.kind === "break") {
          h(`${"[PAUSE]".padEnd(6)} ${"--".padEnd(12)} ${"Reinigung & Zählung (1h)".padEnd(35)} ${row.dayLong.padEnd(12)} ${row.lineLabel.padEnd(12)} ${row.slotKey.padEnd(16)} ${"–".padStart(10)}`);
        } else {
          const prioLabel = row.priority < 900 ? `#${row.priority}` : "–";
          h(`${prioLabel.padEnd(6)} ${row.code.padEnd(12)} ${row.name.replace(/\[.*?\]/g, "").trim().slice(0, 33).padEnd(35)} ${row.dayLong.padEnd(12)} ${row.lineLabel.padEnd(12)} ${row.slotKey.padEnd(16)} ${fmtNum(row.portions).padStart(10)}`);
        }
      }
      sep();
    }

    if (!managementMode && dayPlatingSummaries.length > 0) {
      h("PLATING-AUSHANG: WAS IST ZU TUN?");
      for (const ops of operationsDaySummaries) {
        h(`\n${ops.dayLong.toUpperCase()} (${ops.dateLabel})  -  ${fmtNum(ops.planned)} Port. | ${pct(ops.utilization)} Auslastung | Personal: ${ops.staffNeeded} MA`);
        h(`  Auftragston: ${platingInstruction(ops)}`);
        h(`  Fokus: ${ops.recipeCodes.length > 0 ? ops.recipeCodes.join(", ") : "keine Rezepte"}`);
        // Gruppiert nach Linie
        for (const line of ops.lineSummaries) {
          if (line.blocks.length === 0) continue;
          h(`  P-Linie ${line.lineIdx + 1}: ${fmtNum(line.planned)}/${fmtNum(line.capacity)} Port. (${pct(line.utilization)})`);
          const dayDE = Object.entries(DAY_MAP).find(([, v]) => v === ops.day)?.[0] ?? ops.dayLong;
          for (const slotKey of Object.keys(SLOT_DURATIONS)) {
            const cellKey = `${dayDE}|${slotKey}|${line.lineIdx}`;
            const rawCell = linePlanRaw[cellKey];
            if (rawCell?.code === "__BREAK__") {
              h(`    ${slotKey}  [PAUSE] Reinigung & Zählung (1h)`);
              continue;
            }
            const block = line.blocks.find(b => b.slotKey === slotKey);
            if (block) h(`    ${block.slotKey}  ${block.recipe.code} "${cleanName(block.recipe.name, 40)}"  ->  ${fmtNum(block.portions)} Port.`);
          }
        }
      }
      sep();
    }

    if (!managementMode) {
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
    } else {
      h("MANAGEMENT-KURZLAGE");
      h(`  Rack-Freigabe:          ${fmtNum(rackReleasedCount)} / ${fmtNum(RACK_REQUIRED_LINE_IDS.length)} Linien`);
      h(`  Kapazitaetsluecken:     ${fmtNum(coverageWarnings.length)} Rezepte`);
      h(`  Allergen-Rezepte:       ${fmtNum(allergenRecipeCount)}`);
      h(`  Seafood-Risiko aktiv:   ${hasSeafood ? "JA" : "NEIN"}`);
      sep();
    }

    h("MANUFACTURING-TAGESZUSAMMENRECHNUNG");
    h("Regel fixiert: Run-1-Submeals laufen von Sonntag Prep bis Mittwoch; Run-2-Submeals von Montag bis Donnerstag. Freitag/Samstag bleiben frei für Submeal-Runs.");
    for (const row of manufacturingDaySummaries) {
      const totalJobs = row.mainCount + row.subRunCount;
      h(`  ${row.column.label.padEnd(14)} ${String(totalJobs).padStart(3)} Jobs | Main ${String(row.mainCount).padStart(2)} / ${fmtNum(row.mainPortions).padStart(8)} Port. | Sub-Runs ${String(row.subRunCount).padStart(2)} / ${fmtNum(row.subPortions).padStart(8)} Port.`);
      for (const item of row.items.slice(0, 5)) h(`    - ${item}`);
    }
    h("\nARBEITSAUFTRAG JE TAG (Manufacturing)");
    for (const row of manufacturingActionRows) {
      h(`  ${row.dayLabel} [${row.areaLabel}] -> ${fmtNum(row.totalPortions)} Port. | ${row.instruction}`);
    }
    h("\nRACK + PLATING EINSATZAUFTRAG (Bereichston)");
    h("PLATING - pro Tag");
    for (const ops of operationsDaySummaries) {
      h(`  ${ops.dayLong.padEnd(10)} | ${fmtNum(ops.planned).padStart(8)} Port. | ${pct(ops.utilization).padStart(5)} | ${platingInstruction(ops)}`);
    }
    h("RACK - Linienstatus");
    for (const row of rackActionRows) {
      h(`  ${row.lineId}: ${row.status.toUpperCase()} | ${row.instruction}`);
    }
    h("\nMANUFACTURING-CALENDAR (kompakt)");
    h(`${"Tag".padEnd(14)} ${"Main Jobs".padStart(9)} ${"Sub Jobs".padStart(9)} ${"Main Port.".padStart(11)} ${"Sub Port.".padStart(11)}`);
    h("-".repeat(65));
    for (const row of manufacturingDaySummaries) {
      h(`${row.column.label.padEnd(14)} ${String(row.mainCount).padStart(9)} ${String(row.subRunCount).padStart(9)} ${fmtNum(row.mainPortions).padStart(11)} ${fmtNum(row.subPortions).padStart(11)}`);
    }
    sep();

    if (!managementMode) {
      h("PERSONALBEDARF PLATING (pro Tag)");
      for (const ds of dayPlatingSummaries) {
        h(`  ${ds.dayLong}: ${ds.staffNeeded} MA (${ds.activeLines.size} Linie${ds.activeLines.size !== 1 ? "n" : ""} × ~4 MA)`);
      }
      if (dayPlatingSummaries.length === 0) h("  Kein Linienplan hinterlegt.");
      sep();
    }

    const recipesWithAllergens = batchSplitPlan.filter(p => (allergensByRecipe[p.recipeCode] ?? []).length > 0);
    if (!managementMode && recipesWithAllergens.length > 0) {
      h("ALLERGENE (FSQA-Hinweis)");
      for (const plan of recipesWithAllergens) {
        const a = allergensByRecipe[plan.recipeCode] ?? [];
        h(`  ${plan.recipeCode}  „${plan.recipeName.replace(/\[.*?\]/g, "").trim().slice(0, 40)}":`);
        h(`    ${a.join(", ")}`);
      }
      sep();
    }

    if (!managementMode && filledComments.length > 0) {
      h("ANMERKUNGEN AUS LINIENPLANUNG");
      for (const [key, comment] of filledComments) {
        const [dayDE, slot, li] = key.split("|");
        h(`  ${dayDE ?? ""} | ${slot ?? ""} | Linie ${parseInt(li ?? "0") + 1}: ${comment}`);
      }
      sep();
    }

    h("LIVE-LINKS INS TOOL");
    h(`  Cockpit (Manufacturing): ${liveLinks.cockpit}`);
    h(`  Plating Line (KET):      ${liveLinks.plating}`);
    h(`  Rack:                    ${liveLinks.rack}`);
    h(`  Kitchen Surface:         ${liveLinks.kitchenShare}`);
    h(`  Rundmail:                ${liveLinks.rundmail}`);
    sep();

    h("Diese Mail wurde automatisch aus dem Rezeptlogik-Planungssystem generiert.");
    return lines.join("\n");
  }

  function buildHtmlEmail(audience: MailAudience): string {
    const managementMode = audience === "management";
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
      .ops-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:10px 0 14px}
      .ops-box{border:1px solid ${border};border-radius:8px;background:#fff;padding:10px}
      .ops-title{font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.03em;margin-bottom:5px}
      .ops-main{font-size:16px;font-weight:800;color:#0f172a}
      .bar{height:8px;border-radius:999px;background:#e2e8f0;overflow:hidden;margin-top:6px}
      .bar-fill{height:100%;border-radius:999px;background:#2563eb}
      .bar-fill.warn{background:#f59e0b}
      .bar-fill.danger{background:#dc2626}
      .recipe-chip{display:inline-block;margin:2px 3px 2px 0;padding:2px 6px;border-radius:5px;background:#eef2ff;color:#3730a3;font-size:11px;font-weight:800}
      .day-card{border:1px solid ${border};border-radius:8px;margin-bottom:12px;overflow:hidden}
      .day-header{background:${accent};color:#fff;padding:8px 14px;font-weight:700;font-size:14px;display:flex;justify-content:space-between;align-items:center}
      .day-body{padding:8px 14px}
      .line-block{margin:4px 0}
      .line-label{font-weight:600;color:#475569;font-size:12px;margin-bottom:2px}
      .slot-row{display:flex;gap:8px;align-items:center;padding:3px 0;border-bottom:1px solid #f1f5f9}
      .slot-time{font-size:11px;color:#94a3b8;min-width:110px}
      .slot-recipe{font-size:12px;font-weight:600;color:#1e3a8a}
      .slot-portions{font-size:11px;color:#64748b;margin-left:auto}
      .mfg-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0}
      .mfg-card{border:1px solid ${border};border-radius:8px;padding:8px;background:${lightGray}}
      .mfg-card.active{background:#ecfdf5;border-color:#a7f3d0}
      .mfg-day{font-weight:800;font-size:12px;color:#0f172a;margin-bottom:4px}
      .mfg-line{font-size:11px;color:#475569;line-height:1.35}
      .pro-note{background:#f8fafc;border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px;color:#334155;font-size:13px;line-height:1.45}

      .quick-links{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 2px}
      .quick-link{display:inline-block;padding:6px 10px;border-radius:8px;background:#e2e8f0;color:#0f172a;font-size:12px;font-weight:700;text-decoration:none}
      .quick-link:hover{background:#cbd5e1}
      .mgmt-only{display:none}
      .management .mgmt-only{display:block}
      .management .detail-only{display:none !important}
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
          <td>${escapeHtml(plan.recipeCode)}${plan.isSeafood ? " Fisch" : ""}</td>
          <td>${escapeHtml(cleanName(plan.recipeName, 45))}</td>
          <td><strong>${b.platDay}</strong></td>
          <td>${versandCell}</td>
          <td>${kitchenDay !== b.recommendedProductionDay ? `<strong>${kitchenDay}</strong> <span style="color:#94a3b8;font-size:11px">(geplant)</span>` : b.recommendedProductionDay}</td>
          <td style="text-align:right">${fmtNum(b.portions)}</td>
          <td>${gapHtml}${allergens.length > 0 ? ` <span class="badge badge-amber" title="${allergens.join(", ")}">⚡ Allergene</span>` : ""}</td>
        </tr>`;
      }).join("");
      return batches;
    }).join("");

    const platingUtilSvg = buildPlatingUtilSvg(
      operationsDaySummaries.map(d => ({ dayLong: d.dayLong, utilization: d.utilization, planned: d.planned }))
    );
    const mfgBarSvg = buildSvgBarChart(
      manufacturingDaySummaries
        .filter(r => r.mainPortions + r.subPortions > 0)
        .map(r => ({ label: r.column.label, value: r.mainPortions + r.subPortions })),
      { width: 580, height: 150, color: "#1e40af", title: "Manufacturing-Portionen je Tag" }
    );
    const rackStatusSvg = buildRackStatusSvg(rackActionRows.map(r => ({ lineId: r.lineId, status: r.status })));

    const daysHtml = operationsDaySummaries.map(ds => {
      const dayBarClass = ds.utilization > 1 ? "danger" : ds.utilization >= 0.85 ? "warn" : "";
      const linesHtml = ds.lineSummaries.map(line => {
        const blocks = line.blocks;
        if (blocks.length === 0) {
          return `<div class="line-block">
            <div class="line-label">P-Linie ${line.lineIdx + 1} &nbsp;·&nbsp; frei</div>
            <div class="bar"><div class="bar-fill" style="width:0%"></div></div>
          </div>`;
        }
        const lineBarClass = line.utilization > 1 ? "danger" : line.utilization >= 0.85 ? "warn" : "";
        // Build slot rows including break markers from linePlanRaw
        const dayDE = Object.entries(DAY_MAP).find(([, v]) => v === ds.day)?.[0] ?? ds.dayLong;
        const allSlotsHtml = Object.keys(SLOT_DURATIONS).map(slotKey => {
          const cellKey = `${dayDE}|${slotKey}|${line.lineIdx}`;
          const rawCell = linePlanRaw[cellKey];
          if (rawCell?.code === "__BREAK__") {
            return `<div class="slot-row" style="background:#fef3c7;border-radius:4px;margin:2px 0">
              <span class="slot-time" style="color:#92400e">${escapeHtml(slotKey)}</span>
              <span class="slot-recipe" style="color:#92400e">🧹 Reinigungspause &nbsp;·&nbsp; 1h Zählung + Sauber-machen</span>
              <span class="slot-portions" style="color:#b45309">–</span>
            </div>`;
          }
          const block = blocks.find(b => b.slotKey === slotKey);
          if (!block) return "";
          return `<div class="slot-row">
            <span class="slot-time">${escapeHtml(slotKey)}</span>
            <span class="slot-recipe">${escapeHtml(block.recipe.code)} &nbsp;${escapeHtml(cleanName(block.recipe.name, 40))}</span>
            <span class="slot-portions">${fmtNum(block.portions)} Port.</span>
          </div>`;
        }).join("");
        return `<div class="line-block">
          <div class="line-label">P-Linie ${line.lineIdx + 1} &nbsp;·&nbsp; ${fmtNum(line.planned)}/${fmtNum(line.capacity)} Port. &nbsp;·&nbsp; ${pct(line.utilization)}</div>
          <div class="bar"><div class="bar-fill ${lineBarClass}" style="width:${Math.min(100, Math.round(line.utilization * 100))}%"></div></div>
          ${allSlotsHtml}
        </div>`;
      }).join("");
      const chips = ds.recipeCodes.map(code => `<span class="recipe-chip">${escapeHtml(code)}</span>`).join("");
      return `<div class="day-card">
        <div class="day-header">
          <span>${ds.dayLong} &nbsp;(${ds.dateLabel})</span>
          <span style="font-size:13px;font-weight:400">${fmtNum(ds.planned)} Port. &nbsp;|&nbsp; ${pct(ds.utilization)} Auslastung &nbsp;|&nbsp; ${ds.staffNeeded} MA</span>
        </div>
        <div class="day-body">
          <div style="font-size:12px;color:#475569;margin-bottom:6px"><strong>Auftrag:</strong> ${chips || "Keine Rezepte"} sauber nach Slot-Reihenfolge abarbeiten, Kommentare am Linienplan beachten.</div>
          <div class="bar"><div class="bar-fill ${dayBarClass}" style="width:${Math.min(100, Math.round(ds.utilization * 100))}%"></div></div>
          ${linesHtml || "<em style='color:#94a3b8'>Kein Linienplan für diesen Tag</em>"}
        </div>
      </div>`;
    }).join("");

    const allergenHtml = batchSplitPlan
      .filter(p => (allergensByRecipe[p.recipeCode] ?? []).length > 0)
      .map(p => {
        const a = allergensByRecipe[p.recipeCode] ?? [];
        return `<tr>
          <td>${escapeHtml(p.recipeCode)}</td>
          <td>${escapeHtml(cleanName(p.recipeName, 45))}</td>
          <td>${a.map(al => `<span class="badge badge-amber">${escapeHtml(al)}</span>`).join(" ")}</td>
        </tr>`;
      }).join("");

    const commentHtml = filledComments.length > 0
      ? filledComments.map(([key, comment]) => {
          const [dayDE, slot, li] = key.split("|");
          return `<div class="info"><strong>${escapeHtml(dayDE ?? "")} | ${escapeHtml(slot ?? "")} | Linie ${parseInt(li ?? "0") + 1}:</strong> ${escapeHtml(comment)}</div>`;
        }).join("")
      : `<p style="color:#94a3b8;font-size:13px">Keine Anmerkungen vorhanden.</p>`;

    const manufacturingSummaryHtml = manufacturingDaySummaries.map(row => {
      const totalJobs = row.mainCount + row.subRunCount;
      const itemHtml = row.items.slice(0, 4).map(item => `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#64748b">${escapeHtml(item)}</div>`).join("");
      return `<div class="mfg-card ${totalJobs > 0 ? "active" : ""}">
        <div class="mfg-day">${row.column.label} <span style="float:right;border-radius:999px;background:${totalJobs > 0 ? "#047857" : "#e2e8f0"};color:${totalJobs > 0 ? "#fff" : "#64748b"};padding:1px 6px">${totalJobs}</span></div>
        <div class="mfg-line">Main: <strong>${row.mainCount}</strong> · ${fmtNum(row.mainPortions)} Port.</div>
        <div class="mfg-line">Sub-Runs: <strong>${row.subRunCount}</strong> · ${fmtNum(row.subPortions)} Port.</div>
        <div class="mfg-line" style="margin-top:4px">${itemHtml || "<em>keine Jobs</em>"}</div>
      </div>`;
    }).join("");
    const manufacturingCalendarRowsHtml = manufacturingDaySummaries.map((row) => {
      return `<tr>
        <td><strong>${escapeHtml(row.column.label)}</strong></td>
        <td style="text-align:right">${fmtNum(row.mainCount)}</td>
        <td style="text-align:right">${fmtNum(row.subRunCount)}</td>
        <td style="text-align:right">${fmtNum(row.mainPortions)}</td>
        <td style="text-align:right">${fmtNum(row.subPortions)}</td>
        <td>${row.items.slice(0, 4).map((item) => escapeHtml(item)).join("<br/>") || "<span style=\"color:#94a3b8\">keine Jobs</span>"}</td>
      </tr>`;
    }).join("");

    const rackRowsHtml = rackActionRows.map((row) => {
      const badgeClass = row.done ? "badge-green" : row.status === "blocked" ? "badge-red" : row.status === "ready" ? "badge-blue" : "badge-amber";
      return `<tr>
        <td><strong>${escapeHtml(row.lineId)}</strong></td>
        <td><span class="badge ${badgeClass}">${escapeHtml(row.status.toUpperCase())}</span></td>
        <td>${escapeHtml(row.instruction)}</td>
      </tr>`;
    }).join("");

    const platingMissionRowsHtml = operationsDaySummaries.map((row) => `<tr>
      <td><strong>${escapeHtml(`${row.dayLong} (${row.dateLabel})`)}</strong></td>
      <td style="text-align:right">${fmtNum(row.planned)}</td>
      <td style="text-align:right">${pct(row.utilization)}</td>
      <td>${escapeHtml(platingInstruction(row))}</td>
    </tr>`).join("");

    return `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="wrap">
  <div style="border-left:6px solid #1e40af;padding:12px 20px;background:linear-gradient(135deg,#eff6ff,#f0fdf4);margin-bottom:18px;border-radius:0 8px 8px 0">
    <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#1e40af;letter-spacing:.08em;margin-bottom:4px">FACTOR OPS &nbsp;·&nbsp; VERDEN &nbsp;·&nbsp; ${managementMode ? "MANAGEMENT" : "SCHICHTLEITUNG"}</div>
    <div style="font-size:22px;font-weight:900;color:#0f172a;line-height:1.1">Planungsrundmail &nbsp;<span style="color:#1e40af">KW ${kwNum}</span></div>
    <div style="font-size:12px;color:#334155;margin-top:4px">${fmtDate(week)} &nbsp;·&nbsp; Erstellt: ${new Date().toLocaleString("de-DE")}</div>
    <div style="margin-top:8px;font-size:12px;color:#475569;line-height:1.5">Was in dieser Mail steht ist <strong>verbindlich</strong>. Manufacturing, Rack und Plating arbeiten auf derselben Zahlengrundlage. Run&nbsp;1 läuft stabil; Run&nbsp;2 absorbiert Forecast-Schwankungen kontrolliert.</div>
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
      <span style="background:#1e40af;color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px">Run 1 · So–Mi</span>
      <span style="background:#4f46e5;color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px">Run 2 · Mo–Do</span>
      <span style="background:#0f766e;color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px">Plating</span>
      <span style="background:#c2410c;color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px">Rack</span>
    </div>
  </div>
  <div class="quick-links">
    <a class="quick-link" href="${liveLinks.cockpit}">Manufacturing Live</a>
    <a class="quick-link" href="${liveLinks.plating}">Plating Live</a>
    <a class="quick-link" href="${liveLinks.rack}">Rack Live</a>
    <a class="quick-link" href="${liveLinks.kitchenShare}">Kitchen Surface</a>
    <a class="quick-link" href="${liveLinks.rundmail}">Rundmail Live</a>
  </div>

  ${hasSeafood ? `<div class="warn">Diese Woche enthält <strong>Fisch-Rezepte</strong> - MHD 9 Tage. Küchen-Deadlines besonders beachten.</div>` : ""}

  <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:20px 0 8px 0;padding:6px 10px;border-left:4px solid #1e40af;background:#eff6ff">Operations-Lage</h2>
  <div class="summary-grid">
    <div class="stat"><div class="stat-val">${batchSplitPlan.length}</div><div class="stat-lbl">Rezepte</div></div>
    <div class="stat"><div class="stat-val">${fmtNum(totalPortionsForecast)}</div><div class="stat-lbl">Forecast-Portionen</div></div>
    <div class="stat"><div class="stat-val">${fmtNum(totalPortionsLine)}</div><div class="stat-lbl">Geplante Plating-Portionen</div></div>
    <div class="stat"><div class="stat-val">${platingLineCount}</div><div class="stat-lbl">Aktive Plating-Linien</div></div>
  </div>
  <div class="ops-strip">
    <div class="ops-box"><div class="ops-title">Plating-Auslastung</div><div class="ops-main">${pct(totalLineUtilization)}</div><div class="bar"><div class="bar-fill ${totalLineUtilization > 1 ? "danger" : totalLineUtilization >= 0.85 ? "warn" : ""}" style="width:${Math.min(100, Math.round(totalLineUtilization * 100))}%"></div></div><div style="font-size:11px;color:#64748b;margin-top:4px">${fmtNum(totalPortionsLine)} von ${fmtNum(totalAvailableLineCapacity)} Tageskapa geplant</div></div>
    <div class="ops-box"><div class="ops-title">Küche</div><div class="ops-main">${totalManufacturingJobs} Jobs</div><div style="font-size:11px;color:#64748b;margin-top:4px">Main + Sub-Runs aus dem Wochenplan</div></div>
    <div class="ops-box"><div class="ops-title">Besetzung / Risiko</div><div class="ops-main">${maxPlatingStaff} MA Peak</div><div style="font-size:11px;color:#64748b;margin-top:4px">${coverageWarnings.length} Kapalücken · ${allergenRecipeCount} Allergen-Rezepte</div></div>
  </div>
  ${operationsDaySummaries.length > 0 ? `<img src="${svgToDataUri(platingUtilSvg)}" alt="Plating-Auslastung" style="width:100%;max-width:580px;display:block;margin:12px 0;border-radius:8px"/>` : ""}

  <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:20px 0 8px 0;padding:6px 10px;border-left:4px solid #1e40af;background:#eff6ff">Management-Kurzlage (KPIs)</h2>
  <table>
    <thead><tr><th>KPI</th><th>Wert</th></tr></thead>
    <tbody>
      <tr><td>Rack-Freigabe</td><td>${fmtNum(rackReleasedCount)} / ${fmtNum(RACK_REQUIRED_LINE_IDS.length)} Linien released</td></tr>
      <tr><td>Kapazitaetsluecken</td><td>${fmtNum(coverageWarnings.length)} Rezepte</td></tr>
      <tr><td>Allergen-Rezepte</td><td>${fmtNum(allergenRecipeCount)}</td></tr>
      <tr><td>Seafood-Risiko (MHD 9)</td><td>${hasSeafood ? "Aktiv" : "Nicht aktiv"}</td></tr>
    </tbody>
  </table>

  ${managementMode ? "" : `
  <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:20px 0 8px 0;padding:6px 10px;border-left:4px solid #0f766e;background:#f0fdfa">Plating-Reihenfolge nach Prio</h2>
  <div class="info" style="font-size:12px">Alle belegten Plating-Slots nach Rezept-Priorität sortiert. 🧹-Zeilen = 1h Reinigungspause nach Rezeptwechsel (Zählung + Sauber-machen).</div>
  ${prioPlatingRows.length > 0 ? `<table>
    <thead><tr>
      <th>Prio</th><th>Rezept</th><th>Name</th><th>Tag</th><th>P-Linie</th><th>Zeitslot</th><th style="text-align:right">Portionen</th>
    </tr></thead>
    <tbody>
      ${prioPlatingRows.map(row => {
        if (row.kind === "break") {
          return `<tr style="background:#fef3c7">
            <td colspan="7" style="color:#92400e;font-size:12px;padding:6px 10px">🧹 &nbsp;<strong>Reinigungspause 1h</strong> &nbsp;·&nbsp; ${escapeHtml(row.dayLong)} &nbsp;·&nbsp; ${escapeHtml(row.lineLabel)} &nbsp;·&nbsp; ab ${escapeHtml(row.slotKey)}</td>
          </tr>`;
        }
        const prioLabel = row.priority < 900 ? `#${row.priority}` : "–";
        const prioColor = row.priority <= 3 ? "badge-red" : row.priority <= 6 ? "badge-amber" : "badge-blue";
        return `<tr>
          <td><span class="badge ${prioColor}">${escapeHtml(prioLabel)}</span></td>
          <td><strong>${escapeHtml(row.code)}</strong></td>
          <td>${escapeHtml(cleanName(row.name, 40))}</td>
          <td>${escapeHtml(row.dayLong)}</td>
          <td>${escapeHtml(row.lineLabel)}</td>
          <td style="font-size:11px;color:#475569">${escapeHtml(row.slotKey)}</td>
          <td style="text-align:right">${fmtNum(row.portions)}</td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>` : `<p style="color:#94a3b8;font-size:13px">Kein Linienplan vorhanden.</p>`}

  <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:20px 0 8px 0;padding:6px 10px;border-left:4px solid #0f766e;background:#f0fdfa">Plating-Aushang: Was ist zu tun?</h2>
  ${dayPlatingSummaries.length > 0 ? daysHtml : `<p style="color:#94a3b8;font-size:13px">Kein Linienplan für diese Woche hinterlegt (Linienplanung öffnen und befüllen).</p>`}

  <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:20px 0 8px 0;padding:6px 10px;border-left:4px solid #0f766e;background:#f0fdfa">Küchen-Deadlines</h2>
  <table>
    <thead><tr>
      <th>Rezept</th><th>Name</th><th>Plating</th><th>Versand</th><th>Küche bis</th><th style="text-align:right">Portionen</th><th>Status</th>
    </tr></thead>
    <tbody>${recipesHtml || `<tr><td colspan="7" style="color:#94a3b8;text-align:center">Keine Rezepte für diese Woche</td></tr>`}</tbody>
  </table>
  `}

  <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:20px 0 8px 0;padding:6px 10px;border-left:4px solid #1e40af;background:#eff6ff">Manufacturing-Kalender</h2>
  <div class="info">Fixe Küchenregel: Run-1-Submeals werden von Sonntag Prep bis Mittwoch verteilt. Run-2-Submeals werden von Montag bis Donnerstag verteilt. Freitag/Samstag bleiben frei für Submeal-Runs.</div>
  <div class="mfg-grid">${manufacturingSummaryHtml}</div>
  <h3>Manufacturing Calendar</h3>
  <table>
    <thead><tr><th>Tag</th><th style="text-align:right">Main Jobs</th><th style="text-align:right">Sub-Runs</th><th style="text-align:right">Main Portionen</th><th style="text-align:right">Sub Portionen</th><th>Top Items</th></tr></thead>
    <tbody>${manufacturingCalendarRowsHtml}</tbody>
  </table>
  <h3>Arbeitsauftrag je Tag (Was / Wann / Wo / Wieviel)</h3>
  <table>
    <thead><tr><th>Tag</th><th>Bereich</th><th style="text-align:right">Gesamt Portionen</th><th>Auftrag</th></tr></thead>
    <tbody>
      ${manufacturingActionRows.map((row) => `<tr><td><strong>${escapeHtml(row.dayLabel)}</strong></td><td>${escapeHtml(row.areaLabel)}</td><td style="text-align:right">${fmtNum(row.totalPortions)}</td><td>${escapeHtml(row.instruction)}</td></tr>`).join("")}
    </tbody>
  </table>

  <img src="${svgToDataUri(mfgBarSvg)}" alt="Manufacturing-Portionen" style="width:100%;max-width:580px;display:block;margin:12px 0;border-radius:8px"/>

  <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:20px 0 8px 0;padding:6px 10px;border-left:4px solid #c2410c;background:#fff7ed">Rack-Status</h2>
  <img src="${svgToDataUri(rackStatusSvg)}" alt="Rack-Status" style="width:100%;max-width:580px;display:block;margin:8px 0 12px;border-radius:8px"/>
  <h3>Rack Auftrag pro Linie</h3>
  <table>
    <thead><tr><th>Rack-Linie</th><th>Status</th><th>Auftrag</th></tr></thead>
    <tbody>${rackRowsHtml}</tbody>
  </table>
  <div class="info">Rack Freigabe: ${fmtNum(rackReleasedCount)} / ${fmtNum(RACK_REQUIRED_LINE_IDS.length)} Linien sind auf released.</div>

  <h3>Plating Auftrag pro Tag</h3>
  <table>
    <thead><tr><th>Tag</th><th style="text-align:right">Portionen</th><th style="text-align:right">Auslastung</th><th>Auftrag</th></tr></thead>
    <tbody>${platingMissionRowsHtml || `<tr><td colspan="4" style="color:#94a3b8;text-align:center">Keine Plating-Daten vorhanden</td></tr>`}</tbody>
  </table>

  ${managementMode ? "" : `
  <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:20px 0 8px 0;padding:6px 10px;border-left:4px solid #0f766e;background:#f0fdfa">Personalbedarf Plating</h2>
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

  ${allergenHtml ? `<h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:20px 0 8px 0;padding:6px 10px;border-left:4px solid #b45309;background:#fffbeb">Allergene – FSQA-Hinweis</h2>
  <table>
    <thead><tr><th>Rezept</th><th>Name</th><th>Allergene</th></tr></thead>
    <tbody>${allergenHtml}</tbody>
  </table>` : ""}

  <h2 style="font-size:15px;font-weight:700;color:#1e293b;margin:20px 0 8px 0;padding:6px 10px;border-left:4px solid #475569;background:#f8fafc">Anmerkungen aus Linienplanung</h2>
  ${commentHtml}
  `}

  <div class="footer">
    Automatisch generiert aus Rezeptlogik-Planungssystem &nbsp;·&nbsp; Woche ${week} &nbsp;·&nbsp; ${new Date().toLocaleString("de-DE")}
  </div>
</div></body></html>`;
  }

  async function copyPlainText() {
    await navigator.clipboard.writeText(buildPlainText(mailAudience));
    setCopyState("ok");
    setTimeout(() => setCopyState("idle"), 2500);
  }

  async function copyHtml() {
    try {
      const html = buildHtmlEmail(mailAudience);
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) })
      ]);
    } catch {
      // Fallback: Plain HTML-Code kopieren
      await navigator.clipboard.writeText(buildHtmlEmail(mailAudience));
    }
    setHtmlCopyState("ok");
    setTimeout(() => setHtmlCopyState("idle"), 2500);
  }

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
              label: "Manufacturing Calendar",
              ok: manufacturingPlanConfirmed,
              loading: !manufacturingSnapshotLoaded,
              hint: manufacturingPlanConfirmed
                ? `Gespeichert ${manufacturingSnapshotSavedAt}`
                : cockpitHasAssignments
                ? "Küchenplan vorhanden, aber nicht gesichert – bitte im Manufacturing Calendar auf 'Plan sichern' klicken"
                : "Kein Küchenplan – bitte im Manufacturing Calendar zuerst Rezepte zuordnen",
            },
            {
              label: "Rack",
              ok: rackConfirmed,
              loading: !rackLoaded,
              hint: rackConfirmed
                ? "Alle Rack-Linien freigegeben"
                : "Rack-Plan noch nicht komplett freigegeben (ASL1-ASL6)",
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
            Rundmail-Export ist gesperrt, bis alle drei Bereiche bestaetigt sind: Linienplanung gespeichert, Manufacturing Calendar gespeichert und Rack vollstaendig freigegeben.
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
            <p className="text-[11px] text-slate-400 mt-1">
              Live-Links: <a className="text-blue-700 underline" href={liveLinks.cockpit} target="_blank" rel="noreferrer">Manufacturing</a> · <a className="text-blue-700 underline" href={liveLinks.plating} target="_blank" rel="noreferrer">Plating</a> · <a className="text-blue-700 underline" href={liveLinks.rack} target="_blank" rel="noreferrer">Rack</a>
            </p>
            <div className="mt-2 inline-flex overflow-hidden rounded-lg border border-slate-200">
              <button
                onClick={() => setMailAudience("management")}
                className={`px-3 py-1.5 text-xs font-semibold ${mailAudience === "management" ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                Management-Version
              </button>
              <button
                onClick={() => setMailAudience("shift")}
                className={`px-3 py-1.5 text-xs font-semibold ${mailAudience === "shift" ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                Schichtleiter-Version
              </button>
            </div>
          </div>
          <button
            onClick={() => void copyPlainText()}
            disabled={!allConfirmed}
            title={!allConfirmed ? "Bitte zuerst Linienplanung, Manufacturing Calendar und Rack bestaetigen" : undefined}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ring-1 transition-colors ${
              copyState === "ok"
                ? "bg-emerald-100 text-emerald-800 ring-emerald-300"
                : allConfirmed
                ? "bg-slate-100 text-slate-700 ring-slate-300 hover:bg-slate-200"
                : "bg-slate-100 text-slate-400 ring-slate-200 cursor-not-allowed"
            }`}
          >
            {copyState === "ok" ? "✓ Text kopiert" : `Als Text kopieren (${mailAudience === "management" ? "Management" : "Schichtleitung"})`}
          </button>
          <button
            onClick={() => void copyHtml()}
            disabled={!allConfirmed}
            title={!allConfirmed ? "Bitte zuerst Linienplanung, Manufacturing Calendar und Rack bestaetigen" : undefined}
            className={`rounded-lg px-4 py-2 text-sm font-semibold ring-1 transition-colors ${
              htmlCopyState === "ok"
                ? "bg-emerald-100 text-emerald-800 ring-emerald-300"
                : allConfirmed
                ? "bg-blue-600 text-white ring-blue-700 hover:bg-blue-700"
                : "bg-blue-200 text-blue-400 ring-blue-200 cursor-not-allowed"
            }`}
          >
            {htmlCopyState === "ok" ? "✓ HTML kopiert" : `Als HTML kopieren (${mailAudience === "management" ? "Management" : "Schichtleitung"})`}
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
          <span className="text-xs text-slate-400">· {mailAudience === "management" ? "Management-Kurzlage" : "Schichtleiter-Detail"} · via HTML kopieren in Gmail/Outlook</span>
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
            <h2 className="text-base font-bold text-slate-800 border-b-2 border-blue-700 pb-1 mb-3">Operations-Lage</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { val: batchSplitPlan.length, lbl: "Rezepte" },
                { val: fmtNum(totalPortionsForecast), lbl: "Forecast-Portionen" },
                { val: fmtNum(totalPortionsLine), lbl: "Geplante Plating-Portionen" },
                { val: platingLineCount, lbl: "Aktive Plating-Linien" },
              ].map(({ val, lbl }) => (
                <div key={lbl} className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-center">
                  <div className="text-2xl font-black text-blue-800">{val}</div>
                  <div className="text-xs text-slate-500 mt-1">{lbl}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {[
                {
                  label: "Plating-Auslastung",
                  value: pct(totalLineUtilization),
                  detail: `${fmtNum(totalPortionsLine)} von ${fmtNum(totalAvailableLineCapacity)} Tageskapa geplant`,
                  bar: totalLineUtilization,
                },
                {
                  label: "Küche",
                  value: `${totalManufacturingJobs} Jobs`,
                  detail: `Main + Sub-Runs · ${fmtNum(totalManufacturingPortions)} Port.`,
                  bar: null,
                },
                {
                  label: "Besetzung / Risiko",
                  value: `${maxPlatingStaff} MA Peak`,
                  detail: `${coverageWarnings.length} Kapalücken · ${allergenRecipeCount} Allergen-Rezepte`,
                  bar: null,
                },
              ].map((item) => {
                const barTone = item.bar !== null && item.bar > 1 ? "bg-red-600" : item.bar !== null && item.bar >= 0.85 ? "bg-amber-500" : "bg-blue-600";
                return (
                  <div key={item.label} className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="text-[11px] font-black uppercase tracking-wide text-slate-500">{item.label}</div>
                    <div className="mt-1 text-lg font-black text-slate-900">{item.value}</div>
                    {item.bar !== null && (
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                        <div className={`h-full rounded-full ${barTone}`} style={{ width: `${Math.min(100, Math.round(item.bar * 100))}%` }} />
                      </div>
                    )}
                    <div className="mt-1 text-[11px] text-slate-500">{item.detail}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Plating-Plan */}
          <div>
            <h2 className="text-base font-bold text-slate-800 border-b-2 border-blue-700 pb-1 mb-3">Plating-Aushang: Was ist zu tun?</h2>
            {dayPlatingSummaries.length === 0 ? (
              <p className="text-sm text-slate-400 italic">Kein Linienplan hinterlegt – bitte Linienplanung befüllen.</p>
            ) : (
              <div className="space-y-3">
                {operationsDaySummaries.map(ds => {
                  const dayTone = ds.utilization > 1 ? "bg-red-600" : ds.utilization >= 0.85 ? "bg-amber-500" : "bg-blue-600";
                  return (
                    <div key={ds.day} className="rounded-lg border border-slate-200 overflow-hidden">
                      <div className="bg-blue-800 text-white px-4 py-2 flex justify-between items-center">
                        <span className="font-bold">{ds.dayLong} · {ds.dateLabel}</span>
                        <span className="text-sm font-normal">{fmtNum(ds.planned)} Port. · {pct(ds.utilization)} Auslastung · <strong>{ds.staffNeeded} MA</strong></span>
                      </div>
                      <div className="p-3 space-y-3">
                        <div className="rounded-md bg-slate-50 px-3 py-2">
                          <div className="text-xs text-slate-600">
                            <strong>Auftrag:</strong>{" "}
                            {ds.recipeCodes.length > 0 ? ds.recipeCodes.map(code => (
                              <span key={code} className="mr-1 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-black text-indigo-800">{code}</span>
                            )) : "Keine Rezepte"}
                          </div>
                          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                            <div className={`h-full rounded-full ${dayTone}`} style={{ width: `${Math.min(100, Math.round(ds.utilization * 100))}%` }} />
                          </div>
                        </div>
                        {ds.lineSummaries.map(line => {
                          const blocks = line.blocks;
                          const lineTone = line.utilization > 1 ? "bg-red-600" : line.utilization >= 0.85 ? "bg-amber-500" : "bg-blue-600";
                          return (
                            <div key={line.lineIdx}>
                              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                                <span className="font-bold text-slate-500">P-Linie {line.lineIdx + 1}</span>
                                <span className="font-semibold tabular-nums text-slate-500">{fmtNum(line.planned)}/{fmtNum(line.capacity)} Port. · {pct(line.utilization)}</span>
                              </div>
                              <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-slate-200">
                                <div className={`h-full rounded-full ${lineTone}`} style={{ width: `${Math.min(100, Math.round(line.utilization * 100))}%` }} />
                              </div>
                              {blocks.length === 0 ? (
                                <div className="rounded-md bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-400">frei</div>
                              ) : (
                                <table className="w-full text-xs">
                                  <tbody>
                                    {blocks.map(block => (
                                      <tr key={`${block.slotKey}-${line.lineIdx}`} className="border-b border-slate-100 last:border-0">
                                        <td className="py-1 pr-3 text-slate-400 font-mono w-28">{block.slotKey}</td>
                                        <td className="py-1 pr-3 font-bold text-blue-900">{block.recipe.code}</td>
                                        <td className="py-1 pr-3 text-slate-600">{cleanName(block.recipe.name, 40)}</td>
                                        <td className="py-1 text-right text-slate-500 tabular-nums">{fmtNum(block.portions)} Port.</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
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

          <div>
            <h2 className="text-base font-bold text-slate-800 border-b-2 border-blue-700 pb-1 mb-3">Manufacturing-Tageszusammenrechnung</h2>
            <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              Fixe Küchenregel: Run-1-Submeals von Sonntag Prep bis Mittwoch, Run-2-Submeals von Montag bis Donnerstag. Freitag/Samstag bleiben frei für Submeal-Runs.
            </div>
            <div className="grid gap-2 md:grid-cols-4">
              {manufacturingDaySummaries.map(row => {
                const totalJobs = row.mainCount + row.subRunCount;
                return (
                  <div key={`mail-mfg-${row.column.id}`} className={`rounded-lg border p-2 ${totalJobs > 0 ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-slate-800">{row.column.label}</span>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${totalJobs > 0 ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-500"}`}>{totalJobs}</span>
                    </div>
                    <div className="mt-1 text-[11px] text-slate-600">Main: <strong>{row.mainCount}</strong> · {fmtNum(row.mainPortions)} Port.</div>
                    <div className="text-[11px] text-slate-600">Sub-Runs: <strong>{row.subRunCount}</strong> · {fmtNum(row.subPortions)} Port.</div>
                    <div className="mt-2 space-y-0.5">
                      {row.items.length > 0 ? row.items.slice(0, 5).map(item => {
                        const isRun1 = item.includes("Run 1");
                        const isRun2 = item.includes("Run 2");
                        return (
                          <div key={`${row.column.id}-${item}`} className={`truncate rounded px-1 text-[10px] font-medium ${
                            isRun1 ? "bg-blue-50 text-blue-700"
                            : isRun2 ? "bg-indigo-50 text-indigo-700"
                            : "bg-slate-50 text-slate-600"
                          }`}>{item}</div>
                        );
                      }) : <em className="text-[10px] text-slate-400">keine Jobs</em>}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-3">
              <h3 className="mb-2 text-sm font-bold text-slate-700">Arbeitsauftrag je Tag (Was / Wann / Wo / Wieviel)</h3>
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-blue-800 text-white">
                    <th className="p-2 text-left">Tag</th>
                    <th className="p-2 text-left">Bereich</th>
                    <th className="p-2 text-right">Gesamt Portionen</th>
                    <th className="p-2 text-left">Auftrag</th>
                  </tr>
                </thead>
                <tbody>
                  {manufacturingActionRows.map((row, index) => (
                    <tr key={`mail-mfg-action-${row.dayLabel}-${index}`} className={index % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                      <td className="p-2 font-bold text-slate-800">{row.dayLabel}</td>
                      <td className="p-2 text-slate-600">{row.areaLabel}</td>
                      <td className="p-2 text-right tabular-nums text-slate-700">{fmtNum(row.totalPortions)}</td>
                      <td className="p-2 text-slate-700">{row.instruction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Rack-Status */}
          <div>
            <h2 className="text-base font-bold text-slate-800 border-b-2 border-blue-700 pb-1 mb-3">Rack-Status (ASL1–ASL6)</h2>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-3">
              {rackActionRows.map(row => (
                <div
                  key={row.lineId}
                  title={row.instruction}
                  className={`rounded-lg border p-3 text-center ${
                    row.done
                      ? "border-emerald-300 bg-emerald-50"
                      : row.status === "blocked"
                      ? "border-red-300 bg-red-50"
                      : row.status === "ready"
                      ? "border-blue-300 bg-blue-50"
                      : "border-amber-200 bg-amber-50"
                  }`}
                >
                  <div className="text-sm font-black text-slate-900">{row.lineId}</div>
                  <div className={`mt-1 text-[10px] font-bold uppercase tracking-wide ${
                    row.done ? "text-emerald-700"
                    : row.status === "blocked" ? "text-red-700"
                    : row.status === "ready" ? "text-blue-700"
                    : "text-amber-700"
                  }`}>{row.status}</div>
                  {row.done && <div className="text-emerald-600 text-sm">✓</div>}
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-700">
              Freigabe: <strong>{rackReleasedCount}</strong> / <strong>{RACK_REQUIRED_LINE_IDS.length}</strong> Linien released
              {rackReleasedCount < RACK_REQUIRED_LINE_IDS.length && (
                <span className="ml-2 text-amber-700 font-semibold">
                  — {RACK_REQUIRED_LINE_IDS.length - rackReleasedCount} Linie{RACK_REQUIRED_LINE_IDS.length - rackReleasedCount !== 1 ? "n" : ""} noch offen
                </span>
              )}
            </div>
            <table className="w-full text-xs border-collapse mt-3">
              <thead>
                <tr className="bg-blue-800 text-white">
                  <th className="p-2 text-left">Rack-Linie</th>
                  <th className="p-2 text-left">Status</th>
                  <th className="p-2 text-left">Auftrag</th>
                </tr>
              </thead>
              <tbody>
                {rackActionRows.map((row, i) => (
                  <tr key={row.lineId} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                    <td className="p-2 font-bold text-slate-800">{row.lineId}</td>
                    <td className="p-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                        row.done ? "bg-emerald-100 text-emerald-800"
                        : row.status === "blocked" ? "bg-red-100 text-red-800"
                        : row.status === "ready" ? "bg-blue-100 text-blue-800"
                        : "bg-amber-100 text-amber-800"
                      }`}>{row.status}</span>
                    </td>
                    <td className="p-2 text-slate-600">{row.instruction}</td>
                  </tr>
                ))}
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
