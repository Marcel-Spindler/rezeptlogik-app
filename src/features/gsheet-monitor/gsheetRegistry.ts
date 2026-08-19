// GSheet Monitor – Zentrale Registry aller überwachten Google Sheets.
// Neue Sheets hier einfach hinzufügen — der Poller erkennt sie automatisch.
import type { GSheetConfig } from "./gsheetTypes";

export const GSHEET_REGISTRY: Record<string, GSheetConfig> = {
  rti: {
    id: "1-brEn6eKSMFDTubokqA7brq_BzjKP0RpmGw4A1RPspw",
    name: "RTI Plating Tracker",
    sheetTab: "rti",
    pollIntervalMs: 30_000,
    parser: "rti",
  },
  // Weitere Sheets hier ergänzen:
  // yield: { id: "...", name: "Weekly Yield", sheetTab: "yield", pollIntervalMs: 60_000, parser: "yield" },
};

export function buildSheetCsvUrl(config: GSheetConfig): string {
  return `https://docs.google.com/spreadsheets/d/${config.id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(config.sheetTab)}`;
}
