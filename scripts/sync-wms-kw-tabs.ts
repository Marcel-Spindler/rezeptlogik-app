/**
 * sync-wms-kw-tabs.ts
 *
 * Liest den Transaction_Log.xlsx, erkennt alle enthaltenen KWs automatisch
 * und schreibt pro KW einen eigenen Tab "KW19", "KW20", ... ins GSheet.
 *
 * Verhalten:
 *  - Tab existiert noch nicht → wird neu angelegt und befüllt
 *  - Tab existiert → Daten werden aktualisiert (clear + write NUR diesen Tab)
 *  - Tabs die NICHT im Transaction Log sind → bleiben vollständig unberührt
 *
 * Ausführen:
 *   npm run sync:wms:kw-tabs              (Dry-Run, kein Schreiben)
 *   WMS_PUSH_DRY_RUN=false npm run sync:wms:kw-tabs
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { google } from "googleapis";

const SHEET_ID = process.env.GSHEET_ID?.trim();
if (!SHEET_ID) {
  console.error("GSHEET_ID fehlt (.env.local)");
  process.exit(1);
}

const DRY_RUN = (process.env.WMS_PUSH_DRY_RUN ?? "true").toLowerCase() !== "false";
const MIN_WEEK = parseInt(process.env.WMS_MIN_WEEK?.trim() || "202619", 10);
const TEMPLATE_TAB = (process.env.WMS_TEMPLATE_TAB?.trim() || "W20");

// Spalten die im KW-Tab angezeigt werden sollen
const DISPLAY_COLUMNS = [
  "Week", "Wh Id", "Tran Type", "Arrive Date", "Start Tran Date", "Start Tran Time",
  "End Tran Date", "End Tran Time", "Description", "Employee Id", "Name",
  "Item Number", "Item Desc", "Tran Qty", "Location Id", "Location Id 2",
  "License Plate", "Reason", "Control Number", "Expiration Date", "Local Time"
];

function resolveTransactionLogPath(): string {
  const configured = process.env.WMS_TRANSACTION_LOG_PATH?.trim();
  if (configured && existsSync(configured)) return configured;

  const candidates = [
    resolve("WMS Wahrheit", "Transaction_Log.xlsx"),
    "C:\\WMS Wahrheit\\Transaction_Log.xlsx",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/** Liest alle Zeilen aus dem Transaction Log via Python/openpyxl */
function loadAllRowsFromWorkbook(filePath: string): { headers: string[]; rowsByWeek: Map<string, string[][]> } {
  const helperScript = resolve("scripts", "_read_tx_log.py");

  const raw = execFileSync("python", [helperScript, filePath], {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });

  const parsed = JSON.parse(raw) as { headers: string[]; rows: string[][] };
  const headers = parsed.headers;

  const weekIdx = headers.findIndex(h => h.toLowerCase() === "week");
  if (weekIdx < 0) throw new Error("Spalte 'Week' nicht gefunden");

  const rowsByWeek = new Map<string, string[][]>();
  for (const row of parsed.rows) {
    const w = (row[weekIdx] ?? "").trim().replace(/\.0$/, "");
    if (!w || !/^\d{6}$/.test(w)) continue;
    const weekNum = parseInt(w, 10);
    if (weekNum < MIN_WEEK) continue;
    if (!rowsByWeek.has(w)) rowsByWeek.set(w, []);
    rowsByWeek.get(w)!.push(row);
  }

  return { headers, rowsByWeek };
}

/** Gibt Spaltenindizes zurück für DISPLAY_COLUMNS (fehlende werden als -1 markiert) */
function buildColIdxMap(headers: string[]): number[] {
  const lower = headers.map(h => h.toLowerCase());
  return DISPLAY_COLUMNS.map(col => lower.indexOf(col.toLowerCase()));
}

/** Filtert eine Zeile auf die DISPLAY_COLUMNS */
function filterRow(row: string[], idxMap: number[]): string[] {
  return idxMap.map(i => (i >= 0 && i < row.length ? row[i] : "(fehlt)"));
}

/** Formatiert die KW-Nummer: 202619 → "KW 19 / 2026" */
function formatKwTitle(week: string): string {
  const kw = week.slice(4);
  const year = week.slice(0, 4);
  return `KW ${parseInt(kw, 10)} / ${year}`;
}

async function main() {
  const txPath = resolveTransactionLogPath();
  console.log(`Lese Transaction Log: ${txPath}`);

  const { headers, rowsByWeek } = loadAllRowsFromWorkbook(txPath);
  const idxMap = buildColIdxMap(headers);

  const weeks = [...rowsByWeek.keys()].sort();
  console.log(`Gefundene KWs (ab ${MIN_WEEK}): ${weeks.join(", ")}`);

  if (DRY_RUN) {
    console.log(`\n[DRY-RUN] Folgende Tabs würden im Layout von '${TEMPLATE_TAB}' angelegt/aktualisiert:`);
    for (const w of weeks) {
      console.log(`  → W${parseInt(w.slice(4), 10)} (${rowsByWeek.get(w)!.length} Zeilen)`);
    }
    console.log(`\nSetze WMS_PUSH_DRY_RUN=false zum echten Ausführen.`);
    return;
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  // Bestehende Tabs laden
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: "sheets.properties",
  });
  const existingTabs = new Map<string, number>(); // title → sheetId
  for (const s of meta.data.sheets ?? []) {
    existingTabs.set(s.properties!.title!, s.properties!.sheetId!);
  }

  const displayHeader = DISPLAY_COLUMNS.map((col, i) =>
    idxMap[i] < 0 ? `${col} ⚠️ INPUT FEHLT` : col
  );

  const templateSheetId = existingTabs.get(TEMPLATE_TAB);
  if (!templateSheetId) {
    throw new Error(`Template-Tab '${TEMPLATE_TAB}' nicht gefunden. Bitte im GSheet anlegen.`);
  }

  for (const week of weeks) {
    const tabName = `W${parseInt(week.slice(4), 10)}`;
    const kwRows = rowsByWeek.get(week)!;
    const titleRow = [`${formatKwTitle(week)} — ${kwRows.length} Transaktionen`];
    const sheetRows: string[][] = [titleRow, displayHeader, ...kwRows.map(r => filterRow(r, idxMap))];

    if (!existingTabs.has(tabName)) {
      const dupResp = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [{
            duplicateSheet: {
              sourceSheetId: templateSheetId,
              newSheetName: tabName,
            },
          }],
        },
      });
      const newId = dupResp.data.replies?.[0]?.duplicateSheet?.properties?.sheetId;
      if (newId == null) throw new Error(`Konnte Tab '${tabName}' nicht aus Template duplizieren`);
      existingTabs.set(tabName, newId);
      console.log(`✓ Tab '${tabName}' aus Template '${TEMPLATE_TAB}' dupliziert`);
    } else {
      console.log(`↻ Tab '${tabName}' existiert bereits (Layout bleibt erhalten)`);
    }

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `'${tabName}'!A1:V20000`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${tabName}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: sheetRows },
    });

    console.log(`  ${kwRows.length} Zeilen → '${tabName}'`);
  }

  console.log(`\n✓ Fertig. ${weeks.length} KW-Tabs synchronisiert.`);
  console.log(`  Nicht betroffene Tabs (manuelle Inhalte etc.) wurden nicht verändert.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
