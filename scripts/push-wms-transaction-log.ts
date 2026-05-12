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

const INPUT_TAB_NAME = process.env.GSHEET_INPUT_TAB?.trim() || "Input ";
const MIN_WEEK = parseInt(process.env.WMS_MIN_WEEK?.trim() || "202619", 10);
const DRY_RUN = (process.env.WMS_PUSH_DRY_RUN ?? "true").toLowerCase() !== "false";

function resolveTransactionLogPath(): string {
  const configured = process.env.WMS_TRANSACTION_LOG_PATH?.trim();
  if (configured) return configured;

  const candidates = [
    resolve("WMS Wahrheit", "Transaction_Log.xlsx"),
    "C:\\WMS Wahrheit\\Transaction_Log.xlsx",
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

function cellToValue(v: unknown): string | number {
  if (v == null) return "";
  if (typeof v === "object" && v !== null && "result" in (v as any)) {
    const r = (v as any).result;
    return r == null ? "" : (typeof r === "number" ? r : String(r));
  }
  if (typeof v === "object" && v !== null && "richText" in (v as any)) {
    return ((v as any).richText as Array<{ text: string }>).map(t => t.text).join("");
  }
  return typeof v === "number" ? v : String(v);
}

function toWeekNumber(v: string | number): number {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function loadRowsFromWorkbook(filePath: string): (string | number)[][] {
  const py = [
    "import json, sys",
    "from openpyxl import load_workbook",
    "min_week = int(sys.argv[2])",
    "wb = load_workbook(sys.argv[1], read_only=True, data_only=True)",
    "ws = wb[wb.sheetnames[0]]",
    "rows = [list(r) for r in ws.iter_rows(values_only=True)]",
    "headers = rows[0] if rows else []",
    "week_idx = next((i for i, h in enumerate(headers) if str(h or '').strip().lower() == 'week'), -1)",
    "body = rows[1:] if len(rows) > 1 else []",
    "out = [headers] + [r for r in body if week_idx >= 0 and int(str((r[week_idx] if week_idx < len(r) else '') or '').strip() or 0) >= min_week]",
    "print(json.dumps(out))",
  ].join("; ");

  const raw = execFileSync("python", ["-c", py, filePath, String(MIN_WEEK)], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const rawRows = JSON.parse(raw) as unknown[][];
  if (!rawRows.length) throw new Error("Transaction-Workbook ist leer");

  const headers = rawRows[0].map(cellToValue).map(v => String(v).trim());

  const weekIdx = headers.findIndex(h => h.toLowerCase() === "week");
  if (weekIdx < 0) {
    throw new Error("Spalte 'Week' nicht gefunden");
  }

  const out: (string | number)[][] = [];
  out.push(headers);

  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r] ?? [];
    const values = headers.map((_, i) => cellToValue(row[i]));
    const week = toWeekNumber(values[weekIdx]);
    if (week < MIN_WEEK) continue;
    if (values.every(v => String(v).trim() === "")) continue;
    out.push(values);
  }

  return out;
}

// Felder die zusammen einen eindeutigen Schlüssel pro Transaktion bilden
const TX_KEY_FIELDS = [
  "week",
  "tran type",
  "start tran date",
  "start tran time",
  "employee id",
  "item number",
  "location id",
  "tran qty",
];

function buildKeyFn(headers: string[]): (row: (string | number)[]) => string {
  const lower = headers.map(h => h.toLowerCase());
  const idxs = TX_KEY_FIELDS.map(f => lower.indexOf(f));
  return (row) => idxs.map(i => (i >= 0 ? String(row[i] ?? "").trim() : "")).join("\0");
}

async function upsertRowsToInput(txRows: (string | number)[][]): Promise<void> {
  // txRows[0] = Header-Zeile, txRows[1..] = Datenzeilen
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  // 1. Bestehenden Sheet-Inhalt lesen
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${INPUT_TAB_NAME}'!A:ZZ`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const sheetData = (resp.data.values ?? []) as string[][];
  const sheetIsEmpty =
    sheetData.length === 0 ||
    (sheetData.length === 1 && sheetData[0].every(c => !c));

  const txHeaders = txRows[0].map(h => String(h).trim());
  const txKeyFn = buildKeyFn(txHeaders);

  // 2. Index der bestehenden Sheet-Zeilen aufbauen (Key → vorhanden)
  const sheetKeySet = new Set<string>();
  if (!sheetIsEmpty && sheetData.length > 1) {
    const sheetKeyFn = buildKeyFn(sheetData[0].map(h => String(h ?? "").trim()));
    for (let i = 1; i < sheetData.length; i++) {
      const k = sheetKeyFn(sheetData[i]);
      if (k && !k.match(/^\0+$/)) sheetKeySet.add(k);
    }
  }

  // 3. Neue Zeilen ermitteln (die noch nicht im Sheet sind)
  const toAppend: (string | number)[][] = [];
  for (let i = 1; i < txRows.length; i++) {
    const k = txKeyFn(txRows[i]);
    if (!sheetKeySet.has(k)) {
      toAppend.push(txRows[i]);
    }
  }

  const existingCount = sheetIsEmpty ? 0 : Math.max(0, sheetData.length - 1);
  console.log(`Sheet hat ${existingCount} bestehende Zeilen.`);
  console.log(`Transaction Log: ${txRows.length - 1} Zeilen (ab Week ${MIN_WEEK}).`);
  console.log(`Neue Zeilen zum Einfügen: ${toAppend.length}`);

  if (DRY_RUN) {
    console.log(`[DRY-RUN] Kein Schreibvorgang. Setze WMS_PUSH_DRY_RUN=false zum echten Ausführen.`);
    if (toAppend.length > 0) {
      console.log(`[DRY-RUN] Erste neue Zeile: ${toAppend[0].join(" | ")}`);
    }
    return;
  }

  if (sheetIsEmpty) {
    // Sheet komplett leer → Header + alle Daten initial schreiben
    const allRows = [txHeaders, ...toAppend];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${INPUT_TAB_NAME}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: allRows.map(r => r.map(v => String(v))) },
    });
    console.log(`✓ ${toAppend.length} Zeilen initial in '${INPUT_TAB_NAME}' geschrieben (inkl. Header).`);
  } else if (toAppend.length > 0) {
    // Nur neue Zeilen anhängen — bestehende bleiben unberührt
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `'${INPUT_TAB_NAME}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: toAppend.map(r => r.map(v => String(v))) },
    });
    console.log(`✓ ${toAppend.length} neue Zeilen in '${INPUT_TAB_NAME}' angehängt. ${existingCount} bestehende Zeilen unberührt.`);
  } else {
    console.log(`✓ Keine neuen Zeilen. ${existingCount} bestehende Zeilen unberührt.`);
  }
}

async function main() {
  const txPath = resolveTransactionLogPath();
  console.log(`Lese Transaction Log: ${txPath}`);
  const rows = loadRowsFromWorkbook(txPath);
  console.log(`Gefilterte Zeilen (ab Week ${MIN_WEEK}): ${Math.max(0, rows.length - 1)}`);
  await upsertRowsToInput(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
