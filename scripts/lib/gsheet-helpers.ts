// Gemeinsame Google-Sheets-Hilfsfunktionen für Import-Scripts.
import { google } from "googleapis";

export async function getAuthClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return auth.getClient();
}

export async function getAllTabNames(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
): Promise<string[]> {
  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(title))",
    });
    return (meta.data.sheets ?? []).map(s => s.properties?.title ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

// Sucht den Tab der aktuellen Kalenderwoche anhand von Mustern wie
// "{XX}" (zero-padded), "{KW}" (Zahl), "{YEAR}".
// delta = [0, 1, -1, 2] → aktuelle KW zuerst, dann Vor-/Folgewochen.
export function findCurrentWeekTab(
  tabs: string[],
  patterns: string[],
  fallbackToLatest = true,
): string | undefined {
  const now = new Date();
  const year = now.getFullYear();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const kw = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

  for (const delta of [0, 1, -1, 2]) {
    const weekNum = kw + delta;
    for (const pattern of patterns) {
      const needle = pattern
        .replace("{XX}", String(weekNum).padStart(2, "0"))
        .replace("{KW}", String(weekNum))
        .replace("{YEAR}", String(year));
      const found = tabs.find(t => t.toLowerCase().includes(needle.toLowerCase()));
      if (found) return found;
    }
  }

  if (fallbackToLatest) {
    // Pick the tab whose own week number is closest to the current week —
    // NOT the last matching tab in sheet order. Tabs get added out of
    // chronological order (e.g. a current "W33" tab sitting before a
    // stale "W21" tab left over from an earlier snapshot), so "last in
    // the array" silently picks stale data whenever that happens.
    const candidates = tabs
      .map(t => ({ tab: t, weekNum: extractTabWeekNum(t) }))
      .filter((c): c is { tab: string; weekNum: number } => c.weekNum !== null);
    if (candidates.length) {
      candidates.sort((a, b) => Math.abs(a.weekNum - kw) - Math.abs(b.weekNum - kw) || b.weekNum - a.weekNum);
      return candidates[0].tab;
    }
  }
  return undefined;
}

function extractTabWeekNum(tab: string): number | null {
  const m = tab.match(/(\d{4})-W(\d{2})/) ?? tab.match(/PW(\d{2})/) ?? tab.match(/W(\d{2})/);
  if (!m) return null;
  const weekStr = m.length === 3 ? m[2] : m[1];
  return parseInt(weekStr, 10);
}
