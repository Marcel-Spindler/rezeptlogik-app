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
import { parseDateShift } from "../ket-plan/ketLogic";
import { resolveCookSchedule } from "../../lib/helpers";
import { VF_COOK_SCHEDULES } from "../../data/cookSchedulesVF";

export type IstDepartment = "veggie" | "protein";

const DEPT_LABEL: Record<IstDepartment, string> = {
  veggie: "🥦 Veggie Debox",
  protein: "🥩 Protein Debox",
};
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

// Vorlauf in Tagen für die komplette Kochkette dieser WO (Staging bis fertig).
// Gleiche Umrechnung wie frischeV2Logic.shiftsToDays: +1, weil die Anlieferung
// einen Tag VOR Staging-Start erfolgen muss. VF-Statik zuerst, Firestore-
// cookSchedules als Fallback, sonst 1 Tag (siehe frischeV2Logic.detectCookShifts).
function leadDaysForRow(row: KetRow, cookSchedules: Record<string, CookSchedule>): number {
  const joined = row.cookMethods.join("/");
  if (!joined) return 1;
  const vf = resolveCookSchedule(joined, VF_COOK_SCHEDULES);
  if (vf.schedule) return vf.schedule.cookShifts + 1;
  const fs = resolveCookSchedule(joined, cookSchedules);
  if (fs.schedule) return fs.schedule.cookShifts + 1;
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
  const sorted = sortIstRows(rows, cookSchedules);
  const lines: string[] = [];

  lines.push(`📅 Freitags-Ist-Planung KW${week} — Run 1 Ist-Zahlen`);
  lines.push("");

  const totalActual = sorted.reduce((s, r) => s + (r.woCookedPortions ?? 0), 0);
  const totalTarget = sorted.reduce((s, r) => s + r.targetPortions, 0);
  const pct = totalTarget > 0 ? Math.round((totalActual / totalTarget) * 100) : 0;
  lines.push(`📊 Gesamt: ${fmtInt(totalActual)} / ${fmtInt(totalTarget)} Portionen (${pct}%)`);
  lines.push("");

  for (const dept of ["veggie", "protein"] as const) {
    const deptRows = sorted.filter(r => classifyIstDepartment(r) === dept);
    if (deptRows.length === 0) continue;
    lines.push(`${DEPT_LABEL[dept]} (${deptRows.length} WOs, Reihenfolge = berechneter Muss-Start-Termin aus Cook Schedule):`);
    for (const r of deptRows) {
      const actual = r.woCookedPortions ?? 0;
      const target = r.targetPortions;
      const delta = actual - target;
      const deltaLabel = delta === 0 ? "±0" : delta > 0 ? `+${fmtInt(delta)}` : fmtInt(delta);
      const ordered = orderCookingMethods(r.cookMethods).join(" → ") || "—";
      const startLabel = fmtStartDate(mustStartMs(r, cookSchedules));
      lines.push(`   WO ${r.woNumber} · ${r.subRecipeName} (${r.recipeName}) — Ist: ${fmtInt(actual)} / Soll: ${fmtInt(target)} (${deltaLabel}) · muss ab ${startLabel} laufen · ${ordered}`);
    }
    lines.push("");
  }

  if (gsheetUrl) lines.push(`🔗 Plan: ${gsheetUrl}`);
  return lines.join("\n");
}

// Gemini-basierte KI-Generierung der Freitags-Ist-Mail. Fällt auf
// buildFreitagsIstMailText zurück wenn der lokale Server nicht erreichbar ist.
export async function generateFreitagsIstMailAI(rows: KetRow[], week: string, options: FreitagsIstOptions = {}): Promise<string> {
  const cookSchedules = options.cookSchedules ?? {};
  const sorted = sortIstRows(rows, cookSchedules);
  const baseUrl = import.meta.env.DEV ? "http://127.0.0.1:3142" : "";
  try {
    const res = await fetch(`${baseUrl}/api/local-db/gemini-ist-planung`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        week,
        gsheetUrl: options.gsheetUrl ?? null,
        rows: sorted.map(r => ({
          woNumber: r.woNumber,
          recipeName: r.recipeName,
          subRecipeName: r.subRecipeName,
          department: classifyIstDepartment(r),
          cookMethods: orderCookingMethods(r.cookMethods),
          mustStartDate: fmtStartDate(mustStartMs(r, cookSchedules)),
          woCookedPortions: r.woCookedPortions ?? 0,
          targetPortions: r.targetPortions,
        })),
      }),
    });
    const body = await res.json() as { ok?: boolean; text?: string; error?: string };
    if (!res.ok || !body.ok || !body.text) {
      throw new Error(body.error || "Gemini-Ist-Planung fehlgeschlagen");
    }
    return body.text;
  } catch {
    return buildFreitagsIstMailText(rows, week, options);
  }
}

