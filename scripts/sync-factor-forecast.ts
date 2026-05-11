// sync-factor-forecast.ts
// Lädt täglich die neueste Factor-Forecast-CSV aus Google Drive herunter.
// Erkennt die Kalenderwoche automatisch aus dem Dateiinhalt oder Dateinamen.
// Schreibt das Ergebnis nach public/data/gsheet-truth-export/Factor_Daily - PDL Forecast.csv
// und eine Metadatei nach public/data/factor-daily-meta.json.
//
// Voraussetzungen:
//   - secrets/service-account.json mit Google Drive API-Zugriff
//   - Der Drive-Ordner muss mit der Service-Account-Email geteilt sein
//   - Google Drive API im GCP-Projekt aktiviert
//
// Aufruf: npm run sync:factor:forecast
// Automatisch: Windows-Aufgabenplaner 07:30 Uhr (siehe schedule-factor-forecast.bat)

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { google } from "googleapis";
import Papa from "papaparse";

// Google Drive Ordner-ID aus .env.local oder fest kodiert
const FOLDER_ID =
  process.env.FACTOR_FORECAST_FOLDER_ID?.trim() ??
  "1Q2OTboR_X4tCGjsaag55C2WFURRpi-i2";

const OUT_DIR = resolve("public", "data", "gsheet-truth-export");
const OUT_CSV = join(OUT_DIR, "Factor_Daily - PDL Forecast.csv");
const META_FILE = join(resolve("public", "data"), "factor-daily-meta.json");

// ─── ISO-Woche aus Datum berechnen ───────────────────────────────────────────

function toIsoWeekString(date: Date): string {
  // ISO 8601: Woche beginnt am Montag, erste Woche enthält den 4. Januar
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // 1 = Mo, 7 = So
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Donnerstag dieser Woche
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ─── Woche aus Dateiname extrahieren ("Daily Export [2026.05.11 07_06].csv") ──

function weekFromFilename(name: string): string | null {
  const m = name.match(/\[(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return null;
  return toIsoWeekString(new Date(`${m[1]}-${m[2]}-${m[3]}`));
}

// ─── Woche aus CSV-Inhalt extrahieren (erste TZ-Zeile mit "2026-W20") ────────

function weekFromCsvText(csvText: string): string | null {
  // Sucht nach dem Muster YYYY-Wnn in den ersten paar Kilobytes
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

  // Neueste CSV-Datei im Ordner finden
  const listRes = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and mimeType='text/csv' and trashed=false`,
    orderBy: "createdTime desc",
    pageSize: 10,
    fields: "files(id,name,createdTime,size)",
  });

  const files = listRes.data.files ?? [];
  if (files.length === 0) {
    throw new Error(
      `Keine CSV-Dateien im Factor-Forecast-Ordner (${FOLDER_ID}) gefunden.\n` +
      `Stelle sicher, dass der Ordner mit der Service-Account-Email geteilt ist und die Drive API aktiviert ist.`
    );
  }

  const latest = files[0];
  console.log(`📂 Neueste Datei: ${latest.name}  (erstellt: ${latest.createdTime}, ${latest.size ?? "?"} Bytes)`);

  // Dateiinhalt herunterladen
  const fileRes = await drive.files.get(
    { fileId: latest.id!, alt: "media" },
    { responseType: "arraybuffer" }
  );

  const csvText = Buffer.from(fileRes.data as ArrayBuffer).toString("utf-8");

  // Kalenderwoche ermitteln – Priorität: CSV-Inhalt > Dateiname
  const week =
    weekFromCsvText(csvText) ??
    weekFromFilename(latest.name ?? "") ??
    null;

  if (!week) {
    throw new Error(
      `Konnte Kalenderwoche weder aus CSV-Inhalt noch aus Dateiname "${latest.name}" ermitteln.`
    );
  }
  console.log(`📅 Erkannte Kalenderwoche: ${week}`);

  // CSV parsen
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    const serious = parsed.errors.filter((e) => e.type !== "Delimiter");
    if (serious.length > 0) {
      console.warn(`⚠️  CSV-Parser-Warnungen: ${serious.map((e) => e.message).join("; ")}`);
    }
  }

  // Nur echte Box-Zeilen: meal_swap enthält "xxx:n"-Muster (keine Leerzeilen, keine Kopfzeilen)
  const dataRows = parsed.data.filter((row) => /\d+:\d+/.test(row.meal_swap ?? ""));
  console.log(`📦 Box-Zeilen: ${dataRows.length} (von ${parsed.data.length} geparsten Zeilen)`);

  if (dataRows.length === 0) {
    throw new Error("Keine gültigen Box-Zeilen in der CSV gefunden.");
  }

  // hellofresh_week-Spalte voraussetzen, damit parsePdlRows() die Zeilen versteht
  const enriched = dataRows.map((row) => ({
    hellofresh_week: week,
    ...row,
  }));

  // Ausgabeverzeichnis sicherstellen
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  // CSV schreiben
  const outCsv = Papa.unparse(enriched);
  writeFileSync(OUT_CSV, outCsv, "utf-8");
  console.log(`✅ Gespeichert: ${OUT_CSV} (${enriched.length} Zeilen)`);

  // Metadaten schreiben (wird im UI angezeigt)
  const meta = {
    week,
    sourceFile: latest.name,
    downloadedAt: new Date().toISOString(),
    rowCount: enriched.length,
  };
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2), "utf-8");
  console.log(`📝 Meta: ${JSON.stringify(meta)}`);
}

main().catch((err) => {
  console.error("❌ Fehler:", err instanceof Error ? err.message : err);
  process.exit(1);
});
