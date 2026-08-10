// WMS Übersicht – KW-Generierung und operative Wochen-Fallback-Logik.
// previousWmsWeekCandidates/resolveOperationalWmsWeekNum sind testabgedeckt,
// siehe src/__tests__/wmsKwOverviewWeekFallback.test.ts.

// ─── KW Generation ────────────────────────────────────────────────────────────

export function isoWeekLabelLocal(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function currentHfWeekLocal(): string {
  const iso = isoWeekLabelLocal(new Date());
  const m = iso.match(/^(20\d{2})-W(\d{2})$/);
  if (!m) return iso;
  const week = Number(m[2]) + 1;
  if (week <= 52) return `${m[1]}-W${String(week).padStart(2, "0")}`;
  return `${Number(m[1]) + 1}-W01`;
}

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

// Flexible WO week matcher — V_SUBMEAL_PRODUCTION "week" format varies.
// Prefer exact year+week matching where available and only fall back to the
// plain week number if the source omits any year information.
export function woMatchesSelectedWeek(woWeek: string, selectedHfWeek: string): boolean {
  const tokens = hfWeekTokens(selectedHfWeek);
  if (!tokens) return true;
  const raw = String(woWeek ?? "").trim();
  if (!raw) return false;

  const upper = raw.toUpperCase();
  if (upper.includes(tokens.full) || upper.includes(tokens.short)) return true;

  const digits = raw.replace(/\D/g, "");
  if (!digits) return false;
  if (digits.length >= 6 && digits.includes(tokens.full)) return true;
  if (digits.length === 4 && digits === tokens.short) return true;
  if (digits === tokens.week || digits === tokens.weekUnpadded) return true;

  // If the live WMS feed lags the selected HF week, keep the adjacent
  // operational weeks instead of hiding the whole Workorders section.
  const selectedWeekNum = weekNumFromHfWeek(selectedHfWeek);
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

export function resolveOperationalWmsWeekNum(
  selectedWeekNum: number | null,
  datasets: Array<Array<{ kw: number | null }>>,
): number | null {
  if (selectedWeekNum == null) return null;
  const hasSelectedWeek = datasets.some((rows) => rows.some((row) => row.kw === selectedWeekNum));
  if (hasSelectedWeek) return selectedWeekNum;

  for (const candidate of previousWmsWeekCandidates(selectedWeekNum)) {
    const hasCandidateWeek = datasets.some((rows) => rows.some((row) => row.kw === candidate));
    if (hasCandidateWeek) return candidate;
  }

  return selectedWeekNum;
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
