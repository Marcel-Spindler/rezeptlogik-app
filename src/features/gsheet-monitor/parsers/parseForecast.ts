// GSheet Monitor – Forecast-Parser ("F_VE Production Plan"-Sheet, Tab
// "Forecast"). Speist BENL/NORD/DE/Total im Production-Plan-Tab per FILTER()
// (siehe parseProductionPlan.ts-Kommentar) -- wird hier NICHT zum Ersatz
// geparst, sondern für den Live-Vergleich (productionPlanLiveCheck.ts). Der
// lokale Server (wms-local-server.ts, Endpunkt /forecast?week=...) filtert
// bereits serverseitig auf die passende HF-Woche (Spalte A) -- hier kommen
// nur noch deren Zeilen an, kein Header-Row-Handling nötig.
//
// Spalten (0-indiziert): A HF Week, B Code, C Preference, D Recipe Name,
// ... S(18) BENL "Verden Absolute", T(19) NORD, U(20) DE, V(21) Total Verden Volume.
import type { ForecastData, ForecastRow } from "../gsheetTypes";

function parseIntCell(raw: string): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export function parseForecast(rows: string[][], week: string): ForecastData {
  const result: ForecastRow[] = [];
  for (const row of rows) {
    const code = (row[1] ?? "").trim();
    if (!code) continue;
    result.push({
      hfWeek: (row[0] ?? "").trim(),
      code,
      preference: (row[2] ?? "").trim(),
      recipeName: (row[3] ?? "").trim(),
      benl: parseIntCell(row[18] ?? "") ?? 0,
      nordics: parseIntCell(row[19] ?? "") ?? 0,
      de: parseIntCell(row[20] ?? "") ?? 0,
      total: parseIntCell(row[21] ?? "") ?? 0,
    });
  }
  const byCode = new Map(result.map(r => [r.code, r] as const));
  return { week, rows: result, byCode, lastUpdated: Date.now() };
}
