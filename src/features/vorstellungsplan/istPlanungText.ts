// Freitags-Ist-Planung — zweite Planungsmail neben der Vor-Vor-Planung: geht
// Freitags raus, wenn der erste Lauf final feststeht, und zeigt die im KET-Plan
// bereits GELOGGTEN Ist-Zahlen (woCookedPortions) statt Vorab-Schätzungen.
//
// Sortierung ist bewusst KEIN fester Kochmethoden-Rang: welche WO zuerst
// angefasst werden muss, hängt davon ab, wann sie laut Cook Schedule (siehe
// VF_COOK_SCHEDULES / frischeV2Logic) tatsächlich starten muss, relativ zu
// ihrem eigenen "Date Needed" -- eine Thaw-WO die laut Plan erst Dienstag
// starten muss, darf eine Montags-WO nicht überholen, nur weil "Thaw" drin
// vorkommt.
import type { CookSchedule } from "../../core/types";
import type { KetRow } from "../ket-plan/ketTypes";
import { classify, NO_BATCH, ONE_BATCH } from "../ket-plan/factorRules";
import { orderCookingMethods } from "../ket-plan/woInstructionBot";
import { fmtDateHeader, parseDateShift } from "../ket-plan/ketLogic";
import { resolveCookSchedule } from "../../lib/helpers";
import { VF_COOK_SCHEDULES } from "../../data/cookSchedulesVF";

export type IstDepartment = "veggie" | "protein";

const DEPT_ORDER: Record<IstDepartment, number> = { veggie: 0, protein: 1 };

const DAY_MS = 24 * 60 * 60 * 1000;

// Gleiche Heuristik wie ketLogic.classifyDeboxDepartment, aber ohne den vollen
// BatchCalc/DataBundle -- reicht für die Mail, die nur Name + Cook Methods aus
// dem KET-CSV kennt (siehe factorRules.classify).
export function classifyIstDepartment(row: KetRow): IstDepartment {
  const cls = classify(row.subRecipeName, row.cookMethods);
  const isProtein = !cls.rti && (cls.capacityKg === NO_BATCH || cls.capacityKg === ONE_BATCH);
  return isProtein ? "protein" : "veggie";
}

// Vorlauf in Tagen für die Kochkette dieser WO (Staging bis fertig). Der
// zusätzliche Tag für die Warenanlieferung gehört ausschließlich zum Einkauf,
// nicht zum Küchenstart (siehe frischeV2Logic.shiftsToDays).
function leadDaysForRow(row: KetRow, cookSchedules: Record<string, CookSchedule>): number {
  const joined = row.cookMethods.join("/");
  if (!joined) return 1;
  const vf = resolveCookSchedule(joined, VF_COOK_SCHEDULES);
  if (vf.schedule) return vf.schedule.cookShifts;
  const fs = resolveCookSchedule(joined, cookSchedules);
  if (fs.schedule) return fs.schedule.cookShifts;
  return 1;
}

// Zeitpunkt (ms), zu dem die WO laut Cook Schedule tatsächlich starten muss --
// "Date Needed" (Fälligkeit) minus berechnetem Vorlauf. Das ist der Sortier-
// Schlüssel: kleinerer Wert = muss früher angefasst werden.
function mustStartMs(row: KetRow, cookSchedules: Record<string, CookSchedule>): number {
  const { date } = parseDateShift(row.dateNeeded);
  const deadlineMs = Date.parse(date);
  if (Number.isNaN(deadlineMs)) return Number.MAX_SAFE_INTEGER;
  return deadlineMs - leadDaysForRow(row, cookSchedules) * DAY_MS;
}

function woSortKey(woNumber: string): number {
  const m = woNumber.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

function fmtStartDate(ms: number): string {
  if (!Number.isFinite(ms) || ms === Number.MAX_SAFE_INTEGER) return "–";
  return new Date(ms).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

export function formatIstCookingStart(row: KetRow, cookSchedules: Record<string, CookSchedule> = {}): string {
  return fmtStartDate(mustStartMs(row, cookSchedules));
}

export function istCookingStartDate(row: KetRow, cookSchedules: Record<string, CookSchedule> = {}): string | null {
  const ms = mustStartMs(row, cookSchedules);
  if (!Number.isFinite(ms) || ms === Number.MAX_SAFE_INTEGER) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function startDayKey(row: KetRow, cookSchedules: Record<string, CookSchedule>): string {
  const ms = mustStartMs(row, cookSchedules);
  if (!Number.isFinite(ms) || ms === Number.MAX_SAFE_INTEGER) return "Ungeplant";
  return new Date(ms).toISOString().slice(0, 10);
}

function sundayFirstWeekStart(rows: KetRow[], cookSchedules: Record<string, CookSchedule>): number | null {
  const starts = rows
    .map(row => mustStartMs(row, cookSchedules))
    .filter((ms): ms is number => Number.isFinite(ms) && ms !== Number.MAX_SAFE_INTEGER);
  if (!starts.length) return null;
  const first = new Date(Math.min(...starts));
  first.setUTCHours(0, 0, 0, 0);
  first.setUTCDate(first.getUTCDate() - first.getUTCDay());
  return first.getTime();
}

function fmtCookingDay(dayKey: string): string {
  if (dayKey === "Ungeplant") return dayKey;
  return new Date(`${dayKey}T00:00:00Z`).toLocaleDateString("de-DE", {
    weekday: "long", day: "2-digit", month: "2-digit",
  });
}

// Departement zuerst (physisch getrennte Küchenbereiche), dann tatsächlicher
// Muss-Start-Zeitpunkt (berechnet, kein Hardcode), dann WO-Nummer als Tiebreak.
export function sortIstRows(rows: KetRow[], cookSchedules: Record<string, CookSchedule> = {}): KetRow[] {
  return [...rows].sort((a, b) => {
    const deptDiff = DEPT_ORDER[classifyIstDepartment(a)] - DEPT_ORDER[classifyIstDepartment(b)];
    if (deptDiff !== 0) return deptDiff;
    const startDiff = mustStartMs(a, cookSchedules) - mustStartMs(b, cookSchedules);
    if (startDiff !== 0) return startDiff;
    return woSortKey(a.woNumber) - woSortKey(b.woNumber);
  });
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return new Intl.NumberFormat("de-DE").format(Math.round(n));
}

export interface FreitagsIstOptions {
  gsheetUrl?: string | null;
  cookSchedules?: Record<string, CookSchedule>;
}

export function buildFreitagsIstMailText(rows: KetRow[], week: string, options: FreitagsIstOptions = {}): string {
  const { gsheetUrl, cookSchedules = {} } = options;
  const sorted = [...rows].sort((a, b) => {
    const startDiff = mustStartMs(a, cookSchedules) - mustStartMs(b, cookSchedules);
    if (startDiff !== 0) return startDiff;
    return woSortKey(a.woNumber) - woSortKey(b.woNumber);
  });
  const lines: string[] = [];

  lines.push(`Freitags-Ist-Planung KW${week} | Kochreihenfolge Run 1`);
  lines.push("");

  const totalActual = sorted.reduce((s, r) => s + (r.woCookedPortions ?? 0), 0);
  const totalTarget = sorted.reduce((s, r) => s + r.targetPortions, 0);
  const pct = totalTarget > 0 ? Math.round((totalActual / totalTarget) * 100) : 0;
  lines.push(`Gesamt: ${fmtInt(totalActual)} / ${fmtInt(totalTarget)} Portionen (${pct}%)`);
  lines.push("Kochstart = aus Cook Schedule berechnet | Fällig = Date Needed im KET-Plan");
  lines.push("");

  const weekStart = sundayFirstWeekStart(sorted, cookSchedules);
  const dayGroups = new Map<string, KetRow[]>();
  for (const row of sorted) {
    const dayKey = startDayKey(row, cookSchedules);
    const dayRows = dayGroups.get(dayKey) ?? [];
    dayRows.push(row);
    dayGroups.set(dayKey, dayRows);
  }

  const orderedDays = [
    ...(weekStart == null ? [] : Array.from({ length: 7 }, (_, dayOffset) => new Date(weekStart + dayOffset * DAY_MS).toISOString().slice(0, 10))),
    ...[...dayGroups.keys()].filter(dayKey => dayKey === "Ungeplant" || !weekStart || dayKey < new Date(weekStart).toISOString().slice(0, 10) || dayKey > new Date(weekStart + 6 * DAY_MS).toISOString().slice(0, 10)),
  ];

  for (const dayKey of orderedDays) {
    const dayRows = dayGroups.get(dayKey);
    if (!dayRows?.length) continue;
    lines.push(`${fmtCookingDay(dayKey)} | ${dayRows.length} WO${dayRows.length === 1 ? "" : "s"}`);
    for (const r of dayRows) {
      const actual = r.woCookedPortions ?? 0;
      const target = r.targetPortions;
      const delta = actual - target;
      const deltaLabel = delta === 0 ? "±0" : delta > 0 ? `+${fmtInt(delta)}` : fmtInt(delta);
      const ordered = orderCookingMethods(r.cookMethods).join(" → ") || "—";
      const startLabel = fmtStartDate(mustStartMs(r, cookSchedules));
      const dueLabel = fmtDateHeader(r.dateNeeded);
      lines.push(`  WO ${r.woNumber} | ${r.subRecipeName} (${r.recipeName})`);
      lines.push(`  Kochstart: ${startLabel} | Fällig: ${dueLabel} | ${classifyIstDepartment(r) === "veggie" ? "Veggie Debox" : "Protein Debox"}`);
      lines.push(`  ${ordered} | Ist/Soll: ${fmtInt(actual)} / ${fmtInt(target)} (${deltaLabel})`);
    }
    lines.push("");
  }

  if (gsheetUrl) lines.push(`🔗 Plan: ${gsheetUrl}`);
  return lines.join("\n");
}

// Gemini-basierte KI-Generierung der Freitags-Ist-Mail. Fällt auf
// buildFreitagsIstMailText zurück wenn der lokale Server nicht erreichbar ist.
export async function generateFreitagsIstMailAI(rows: KetRow[], week: string, options: FreitagsIstOptions = {}): Promise<string> {
  return buildFreitagsIstMailText(rows, week, options);
}

