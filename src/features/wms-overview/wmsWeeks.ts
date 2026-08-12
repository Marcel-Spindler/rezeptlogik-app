// WMS Übersicht – KW-Generierung und operative Wochen-Fallback-Logik.
// previousWmsWeekCandidates/resolveOperationalWmsWeekNum sind testabgedeckt,
// siehe src/__tests__/wmsKwOverviewWeekFallback.test.ts.
import { currentHfWeek as currentHfWeekLocal } from "../../lib/hfWeek";
export { currentHfWeekLocal };

// ─── KW Generation ────────────────────────────────────────────────────────────

export function generateWmsWeeks(startYear = 2026, startWeek = 1): string[] {
  const current = currentHfWeekLocal();
  const result: string[] = [];
  let year = startYear, week = startWeek;
  for (let i = 0; i < 500; i++) {
    const label = `${year}-W${String(week).padStart(2, "0")}`;
    result.push(label);
    if (label === current) break;
    week++;
    if (week > 52) { week = 1; year++; }
  }
  return result;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function hfWeekTokens(hfWeek: string): { full: string; short: string; week: string; weekUnpadded: string } | null {
  const m = String(hfWeek ?? "").trim().match(/^(20\d{2})-W(\d{2})$/);
  if (!m) return null;
  return {
    full: `${m[1]}${m[2]}`,
    short: `${m[1].slice(-2)}${m[2]}`,
    week: m[2],
    weekUnpadded: String(Number(m[2])),
  };
}

// WO-Nummern folgen serverseitig IMMER dem Muster "<KW>-<laufende Nummer>"
// (z.B. "34-62", "34-R1") — genau das Muster, mit dem wms-local-server.ts
// die SQL-Abfrage selbst filtert (WHERE wo_number LIKE '34-%'). Das macht die
// WO-Nummer die zuverlässigste Wochenquelle: anders als das freie "week"-Feld
// aus V_SUBMEAL_PRODUCTION kann sie nicht in einem unerwarteten Format
// ankommen, ohne dass der Server selbst schon leer zurückgegeben hätte.
export function weekPrefixFromWoNumber(woNumber: string): number | null {
  const m = String(woNumber ?? "").trim().match(/^(\d{1,2})-/);
  return m ? parseInt(m[1], 10) : null;
}

// Flexible WO week matcher — V_SUBMEAL_PRODUCTION "week" format varies.
// Prefer exact year+week matching where available and only fall back to the
// plain week number if the source omits any year information. woNumber is an
// optional, more reliable secondary signal (see weekPrefixFromWoNumber) —
// checked whenever the "week" field itself doesn't produce a match, so a
// surprising/malformed "week" value can never hide a WO the server already
// filtered correctly by its number.
// allowAdjacentWeekFallback (default true, matches historical behaviour):
// when the "week" field matches neither exactly nor via the WO-number
// prefix, fall back to accepting nearby weeks (-1..+2) so a lagging feed
// doesn't hide the whole section. Set to false for strict KW-only matching
// (the "🎯 Nur KW" toggle) - Marcel reported this fallback leaking KW32 rows
// into a KW33 view, which is exactly this window kicking in.
export function woMatchesSelectedWeek(woWeek: string, selectedHfWeek: string, woNumber?: string, allowAdjacentWeekFallback = false): boolean {
  const tokens = hfWeekTokens(selectedHfWeek);
  if (!tokens) return true;

  const selectedWeekNum = weekNumFromHfWeek(selectedHfWeek);
  if (woNumber && selectedWeekNum != null && weekPrefixFromWoNumber(woNumber) === selectedWeekNum) return true;

  const raw = String(woWeek ?? "").trim();
  if (!raw) return false;

  const upper = raw.toUpperCase();
  if (upper.includes(tokens.full) || upper.includes(tokens.short)) return true;

  const digits = raw.replace(/\D/g, "");
  if (!digits) return false;
  if (digits === tokens.full || digits === tokens.short || digits === tokens.week || digits === tokens.weekUnpadded) return true;

  if (!allowAdjacentWeekFallback) return false;

  const rowWeekNum = weekNumFromWmsWeek(raw);
  if (selectedWeekNum == null || rowWeekNum == null) return false;
  return rowWeekNum >= selectedWeekNum - 1 && rowWeekNum <= selectedWeekNum + 2;
}

export function weekNumFromHfWeek(hfWeek: string): number | null {
  const m = hfWeek.match(/W(\d{2})$/);
  return m ? parseInt(m[1]) : null;
}

export function previousWmsWeekCandidates(weekNum: number): number[] {
  if (weekNum === 1) return [52, 53];
  return [weekNum - 1];
}

// allowFallback=false disables the previous-week substitution entirely and
// always returns selectedWeekNum as-is - the strict "🎯 Nur KW" mode. With
// fallback on (default), an empty selected week silently substitutes the
// previous week's rows, which is exactly the "KW33 shows KW32" symptom.
type WeekRowLike = {
  kw?: number | null;
  week?: string | null;
  woNumber?: string | null;
};

export function resolveSelectedWeekFromStationRows(
  selectedWeekNum: number | null,
  datasets: Array<Array<WeekRowLike>>,
  allowFallback = false,
): number | null {
  if (selectedWeekNum == null) return null;
  if (!allowFallback) return selectedWeekNum;

  const hasSelectedWeek = datasets.some((rows) => rows.some((row) => {
    if (typeof row.kw === "number" && row.kw === selectedWeekNum) return true;
    const rowWeek = String(row.week ?? "").trim();
    if (rowWeek && weekNumFromWmsWeek(rowWeek) === selectedWeekNum) return true;
    const woNumber = String(row.woNumber ?? "").trim();
    return !!woNumber && weekPrefixFromWoNumber(woNumber) === selectedWeekNum;
  }));
  if (hasSelectedWeek) return selectedWeekNum;

  for (const candidate of previousWmsWeekCandidates(selectedWeekNum)) {
    const hasCandidateWeek = datasets.some((rows) => rows.some((row) => {
      if (typeof row.kw === "number" && row.kw === candidate) return true;
      const rowWeek = String(row.week ?? "").trim();
      if (rowWeek && weekNumFromWmsWeek(rowWeek) === candidate) return true;
      const woNumber = String(row.woNumber ?? "").trim();
      return !!woNumber && weekPrefixFromWoNumber(woNumber) === candidate;
    }));
    if (hasCandidateWeek) return candidate;
  }

  return selectedWeekNum;
}

export function resolveOperationalWmsWeekNum(
  selectedWeekNum: number | null,
  datasets: Array<Array<{ kw: number | null }>>,
  allowFallback = false,
): number | null {
  return resolveSelectedWeekFromStationRows(
    selectedWeekNum,
    datasets.map((rows) => rows.map((row) => ({ kw: row.kw }))),
    allowFallback,
  );
}

export function weekNumFromWmsWeek(woWeek: string): number | null {
  const digits = String(woWeek ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length >= 2) return parseInt(digits.slice(-2), 10);
  return null;
}

export function woMatchesWeekNum(woWeek: string, weekNum: number | null): boolean {
  if (weekNum == null) return true;
  const wn2 = String(weekNum).padStart(2, "0");
  return woWeek === String(weekNum)
    || woWeek === wn2
    || woWeek.endsWith(wn2)
    || woWeek.startsWith(`${wn2}-`)
    || woWeek.startsWith(`${String(weekNum)}-`);
}
