// Shared HF-week (Factor-KW) calendar math. Single source of truth for the
// "HF week = true ISO week + 1" convention used across the app — this used
// to be implemented independently in both src/lib/wmsCache.ts and
// src/features/wms-overview/wmsWeeks.ts (verified byte-for-byte identical
// at the time of dedup, but duplicated non-trivial date math is exactly the
// kind of thing that silently diverges the next time only one copy gets
// touched — see project memory on the WMS "KW" week convention).

export function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function currentHfWeek(): string {
  const iso = isoWeekLabel(new Date());
  const m = iso.match(/^(20\d{2})-W(\d{2})$/);
  if (!m) return iso;
  const week = Number(m[2]) + 1;
  if (week <= 52) return `${m[1]}-W${String(week).padStart(2, "0")}`;
  return `${Number(m[1]) + 1}-W01`;
}
