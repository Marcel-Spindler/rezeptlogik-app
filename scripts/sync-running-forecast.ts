import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { google } from "googleapis";
import Papa from "papaparse";

const SHEET_ID = "1IEi_CB9KylW2MgjNiGax5EIvhhAtkIzm57uO1sSESj8";
const RANGE = "OUTPUT >>!A:S"; // The exact sheet name is likely 'OUTPUT >>' or similar, we'll try to find it dynamically or just download the first sheet. Wait, GID=1436441958.

const OUT_DIR = resolve("public", "data", "gsheet-truth-export");
const OUT_CSV = join(OUT_DIR, "Running Forecast - All Markets.csv");

async function main() {
  console.log(`Starte Sync von Running Forecast (${SHEET_ID})...`);
  
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: resolve("secrets", "service-account.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  // Zuerst Metadaten abrufen, um den genauen Namen des Tabs mit GID=1436441958 zu finden
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = meta.data.sheets?.find((s) => s.properties?.sheetId === 1436441958);
  
  if (!sheet || !sheet.properties?.title) {
    throw new Error(`Konnte Tab mit GID=1436441958 nicht in Spreadsheet finden.`);
  }

  const tabName = sheet.properties.title;
  console.log(`Lese Tab: "${tabName}"`);

  // Lade die Werte
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${tabName}'!A:Z`,
  });

  const rows = res.data.values;
  if (!rows || rows.length === 0) {
    throw new Error(`Keine Daten im Tab "${tabName}" gefunden.`);
  }

  // Wandle in CSV um
  const csv = Papa.unparse(rows);
  
  writeFileSync(OUT_CSV, csv, "utf-8");
  console.log(`✓ Gespeichert nach ${OUT_CSV} (${rows.length} Zeilen)`);
}

main().catch((error) => {
  console.error("FEHLER beim Sync Running Forecast:", error);
  process.exit(1);
});
