// sync-factor-forecast.ts
// Lädt die neuesten Factor-Forecast-CSVs aus Google Drive herunter.
// Deckt die letzten WEEKS_TO_KEEP Produktions-KWs ab (dedupliziert nach KW).
// Schreibt das Ergebnis nach public/data/gsheet-truth-export/Factor_Daily - PDL Forecast.csv
// und eine Metadatei nach public/data/factor-daily-meta.json.
//
// Voraussetzungen:
//   - secrets/service-account.json mit Google Drive API-Zugriff
//   - Der Drive-Ordner muss mit der Service-Account-Email geteilt sein
//   - Google Drive API im GCP-Projekt aktiviert
//
// Aufruf: npm run sync:factor:forecast
// Automatisch: Windows-Aufgabenplaner alle 2h (sync-all-and-deploy.bat)

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { google } from "googleapis";
import Papa from "papaparse";

const FOLDER_ID =
  process.env.FACTOR_FORECAST_FOLDER_ID?.trim() ??
  "1Q2OTboR_X4tCGjsaag55C2WFURRpi-i2";

// Wie viele verschiedene Produktions-KWs sollen gesammelt werden
const WEEKS_TO_KEEP = 4;

const OUT_DIR = resolve("public", "data", "gsheet-truth-export");
const OUT_CSV = join(OUT_DIR, "Factor_Daily - PDL Forecast.csv");
const META_FILE = join(resolve("public", "data"), "factor-daily-meta.json");

// ─── ISO-Woche aus Datum berechnen ───────────────────────────────────────────

function toIsoWeekString(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function weekFromFilename(name: string): string | null {
  const m = name.match(/\[(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return null;
  return toIsoWeekString(new Date(`${m[1]}-${m[2]}-${m[3]}`));
}

function weekFromCsvText(csvText: string): string | null {
  const snippet = csvText.slice(0, 4096);
  const m = snippet.match(/\b(20\d{2}-W\d{1,2})\b/);
  if (!m) return null;
  const parts = m[1].split("-W");
  return `${parts[0]}-W${parts[1].padStart(2, "0")}`;
}

// ─── Hauptlogik ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const keyFile = resolve("secrets", "service-account.json");
  if (!existsSync(keyFile)) {
    throw new Error(`Service-Account-Datei fehlt: ${keyFile}`);
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    keyFile,
  });

  const drive = google.drive({ version: "v3", auth: (await auth.getClient()) as Parameters<typeof google.drive>[0]["auth"] });

  // Alle CSV-Dateien auflisten (neueste zuerst)
  const listRes = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and mimeType='text/csv' and trashed=false`,
    orderBy: "createdTime desc",
    pageSize: 50,
    fields: "files(id,name,createdTime,size)",
  });

  const files = listRes.data.files ?? [];
  if (files.length === 0) {
    throw new Error(
      `Keine CSV-Dateien im Factor-Forecast-Ordner (${FOLDER_ID}) gefunden.\n` +
      `Stelle sicher, dass der Ordner mit der Service-Account-Email geteilt ist.`
    );
  }

  // Pro KW nur die neueste Datei nehmen, bis WEEKS_TO_KEEP verschiedene KWs gesammelt
  const seenWeeks = new Map<string, typeof files[0]>(); // week → newest file for that week
  for (const file of files) {
    const week = weekFromFilename(file.name ?? "");
    if (!week) continue;
    if (!seenWeeks.has(week)) seenWeeks.set(week, file);
    if (seenWeeks.size >= WEEKS_TO_KEEP) break;
  }

  if (seenWeeks.size === 0) {
    throw new Error("Konnte keine Kalenderwochen aus den Dateinamen extrahieren.");
  }

  console.log(`📅 Gefundene KWs: ${[...seenWeeks.keys()].join(", ")}`);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  // Alle relevanten Dateien herunterladen und zusammenführen
  const allRows: Array<Record<string, string>> = [];
  let latestWeek = "";
  let latestFile = "";

  for (const [week, file] of seenWeeks) {
    console.log(`📂 Lade ${file.name} (${week}) …`);
    const fileRes = await drive.files.get(
      { fileId: file.id!, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const csvText = Buffer.from(fileRes.data as ArrayBuffer).toString("utf-8");
    const detectedWeek = weekFromCsvText(csvText) ?? week;

    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
    });

    const dataRows = parsed.data
      .filter((row) => /\d+:\d+/.test(row.meal_swap ?? ""))
      .map((row) => ({ hellofresh_week: detectedWeek, ...row }));

    console.log(`   → ${dataRows.length} Box-Zeilen (KW ${detectedWeek})`);
    allRows.push(...dataRows);

    if (!latestWeek || detectedWeek > latestWeek) {
      latestWeek = detectedWeek;
      latestFile = file.name ?? "";
    }
  }

  if (allRows.length === 0) {
    throw new Error("Keine gültigen Box-Zeilen in den heruntergeladenen CSVs gefunden.");
  }

  // Gesamte CSV schreiben
  const outCsv = Papa.unparse(allRows);
  writeFileSync(OUT_CSV, outCsv, "utf-8");
  console.log(`✅ Gespeichert: ${OUT_CSV} (${allRows.length} Zeilen, ${seenWeeks.size} KWs)`);

  const meta = {
    week: latestWeek,
    sourceFile: latestFile,
    downloadedAt: new Date().toISOString(),
    rowCount: allRows.length,
    weeksIncluded: [...seenWeeks.keys()],
  };
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf-8");
  console.log(`📝 Meta: ${JSON.stringify(meta)}`);
}

main().catch((err) => {
  console.error("❌ Fehler:", err instanceof Error ? err.message : err);
  process.exit(1);
});
