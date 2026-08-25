// Kalenderdaten fuer die Production-Plan-Tage (So-Sa je HF-Woche).
// Die Sheet-Tage laufen So->Sa, waehrend das HF-Wochen-Modell (src/lib/hfWeek.ts)
// Wochen als Mo->So definiert (HF-Woche N = echte ISO-Woche N-1, siehe dortiger
// Kommentar). Der "Sonntag" einer HF-Woche N ist deshalb der Tag VOR ihrem
// Montag (=letzter Tag der ISO-Woche N-2 / der HF-Woche N-1) -- Montag..Samstag
// sind Montag..Samstag von ISO-Woche (N-1) selbst.
import { isoWeekLabel } from "../../lib/hfWeek";
import type { ProductionPlanDay } from "../gsheet-monitor/gsheetTypes";

const DAY_OFFSET_FROM_MONDAY: Record<ProductionPlanDay, number> = {
  Sunday: -1, Monday: 0, Tuesday: 1, Wednesday: 2, Thursday: 3, Friday: 4, Saturday: 5,
};

function isoWeeksInYear(year: number): number {
  const dec31 = new Date(Date.UTC(year, 11, 31));
  const label = isoWeekLabel(dec31);
  const match = /-W(\d{2})$/.exec(label);
  // Dec 31 kann bereits in KW01 des Folgejahres liegen (wenn Dec31 ein Mo/Di/Mi ist)
  // -- dann traegt Dec 24 die letzte echte Woche des Jahres.
  if (match && Number(match[1]) === 1) {
    const dec24 = new Date(Date.UTC(year, 11, 24));
    return Number(/-W(\d{2})$/.exec(isoWeekLabel(dec24))?.[1] ?? "52");
  }
  return match ? Number(match[1]) : 52;
}

function mondayOfIsoWeek(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const monday = new Date(week1Monday);
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return monday;
}

// Liefert das Kalenderdatum eines Wochentags innerhalb einer HF-Woche, z.B.
// hfWeekDayDate("2026-W37", "Monday") -> 2026-08-31.
export function hfWeekDayDate(hfWeek: string, day: ProductionPlanDay): Date | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(hfWeek.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const hfWeekNum = Number(match[2]);

  let isoYear = year;
  let isoWeek = hfWeekNum - 1;
  if (isoWeek < 1) {
    isoYear -= 1;
    isoWeek = isoWeeksInYear(isoYear);
  }

  const monday = mondayOfIsoWeek(isoYear, isoWeek);
  const result = new Date(monday);
  result.setUTCDate(monday.getUTCDate() + DAY_OFFSET_FROM_MONDAY[day]);
  return result;
}

export function formatShortDate(date: Date | null): string {
  if (!date) return "";
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
}
