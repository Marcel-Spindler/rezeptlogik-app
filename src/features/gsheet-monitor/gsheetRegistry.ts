// GSheet Monitor – Zentrale Registry aller überwachten Google Sheets.
// Neue Sheets hier einfach hinzufügen — der Poller erkennt sie automatisch.
import type { GSheetConfig } from "./gsheetTypes";

export const GSHEET_REGISTRY: Record<string, GSheetConfig> = {
  postblast: {
    id: "1-brEn6eKSMFDTubokqA7brq_BzjKP0RpmGw4A1RPspw",
    name: "Postblast Wiegungen",
    sheetTab: "gid=0",
    pollIntervalMs: 30_000,
    parser: "postblast",
  },
  rti: {
    id: "1-brEn6eKSMFDTubokqA7brq_BzjKP0RpmGw4A1RPspw",
    name: "RTI Plating Tracker",
    sheetTab: "gid=1486350915",
    pollIntervalMs: 60_000,
    parser: "rti",
  },
  et: {
    id: "1-brEn6eKSMFDTubokqA7brq_BzjKP0RpmGw4A1RPspw",
    name: "ET Work-Order-Liste",
    sheetTab: "ET",
    pollIntervalMs: 60_000,
    parser: "et",
  },
  // Weitere Sheets hier ergänzen:
  // yield: { id: "...", name: "Weekly Yield", sheetTab: "gid=...", pollIntervalMs: 60_000, parser: "yield" },
};

export function buildSheetCsvUrl(config: GSheetConfig): string {
  // Unterstützt sowohl "gid=123" als auch Tab-Namen
  if (config.sheetTab.startsWith("gid=")) {
    return `https://docs.google.com/spreadsheets/d/${config.id}/gviz/tq?tqx=out:csv&${config.sheetTab}`;
  }
  return `https://docs.google.com/spreadsheets/d/${config.id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(config.sheetTab)}`;
}
