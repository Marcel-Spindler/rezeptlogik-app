// Transparency Plan – KPI/Log: "Kitchen KPIs" (Datums-Spalten-Matrix),
// "Issue Tracker" (Freitext-Log).
import type { TransparencyKitchenKpiData, TransparencyIssueTrackerData, TransparencyIssueRow } from "../../transparencyTypes";
import { cell, parseFloatCell } from "./transparencyCellHelpers";

const DATE_COL_RE = /^\d{4}\/\d{2}\/\d{2}$/;

// Header-Zeile ist die erste, deren zweite Spalte wie ein Datum aussieht
// ("2026/08/18") — danach folgt je Zeile ein Label (Spalte 0) mit einem Wert
// je Datums-Spalte.
export function parseKitchenKpis(rows: string[][]): TransparencyKitchenKpiData {
  const headerIdx = rows.findIndex((r) => DATE_COL_RE.test(cell(r, 1)));
  if (headerIdx === -1) return { dates: [], series: [], lastUpdated: Date.now() };

  const header = rows[headerIdx] ?? [];
  const dateCols: { col: number; date: string }[] = [];
  header.forEach((h, i) => { if (i > 0 && DATE_COL_RE.test((h ?? "").trim())) dateCols.push({ col: i, date: (h ?? "").trim() }); });

  const series = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const label = cell(row, 0);
    if (!label) continue;
    const valuesByDate: Record<string, number | null> = {};
    for (const { col, date } of dateCols) valuesByDate[date] = parseFloatCell(row, col);
    series.push({ label, valuesByDate });
  }

  return { dates: dateCols.map((d) => d.date), series, lastUpdated: Date.now() };
}

// "Date","Issue","Descirption","Root Cause","Action","Departments" (Tippfehler
// "Descirption" im Original-Sheet-Header, hier nur als Spaltenindex genutzt).
export function parseIssueTracker(rows: string[][]): TransparencyIssueTrackerData {
  const headerIdx = rows.findIndex((r) => cell(r, 0) === "Date" && cell(r, 1) === "Issue");
  const parsed: TransparencyIssueRow[] = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const issue = cell(row, 1);
      if (!issue) continue;
      parsed.push({
        date: cell(row, 0),
        issue,
        description: cell(row, 2),
        rootCause: cell(row, 3),
        action: cell(row, 4),
        departments: cell(row, 5),
      });
    }
  }

  return { rows: parsed, lastUpdated: Date.now() };
}
