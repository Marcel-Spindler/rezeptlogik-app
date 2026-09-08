import type { RedzoneState } from "./RedzoneContext";

/** Plaitierte Portionen je Meal-Code aus Redzone (abgeschlossene Runs der
 *  letzten 24h + laufende Runs). `platingNow` trägt jeden aktiven Run unter
 *  ZWEI Keys (mealCode UND productTypeSKU) auf demselben Objekt — über
 *  `.values()` dedupen wir per Set, sonst würde ein aktiver Run doppelt gezählt. */
export function buildPlatedByCodeMap(redzone: RedzoneState | null | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const run of redzone?.platingDone ?? []) {
    if (run.mealCode) map.set(run.mealCode, (map.get(run.mealCode) ?? 0) + (run.outCount ?? 0));
  }
  const activeRuns = redzone?.platingNow ? new Set(redzone.platingNow.values()) : [];
  for (const run of activeRuns) {
    if (run.mealCode && run.outCount) map.set(run.mealCode, (map.get(run.mealCode) ?? 0) + run.outCount);
  }
  return map;
}
