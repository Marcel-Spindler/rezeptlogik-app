import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { google } from "googleapis";

loadEnv({ path: ".env.local" });
loadEnv();

type DumpSheet = {
  title: string;
  sheetId: number;
  index?: number;
  hidden?: boolean;
  rowCount?: number;
  columnCount?: number;
  values: string[][];
};

type DumpFile = {
  generatedAt: string;
  spreadsheetId: string;
  spreadsheetTitle?: string;
  locale?: string;
  timeZone?: string;
  sheetCount: number;
  sheets: DumpSheet[];
};

function parseSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const m = trimmed.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (m?.[1]) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) return trimmed;
  throw new Error("Ungueltige Spreadsheet-ID oder URL");
}

async function main() {
  const arg = process.argv[2] ?? process.env.GSHEET_ID;
  if (!arg) {
    throw new Error("Bitte Spreadsheet-URL oder ID als Argument uebergeben");
  }

  const spreadsheetId = parseSpreadsheetId(arg);

  const keyFile = resolve("secrets", "service-account.json");
  if (!existsSync(keyFile)) {
    throw new Error(`Service-Account-Datei fehlt: ${keyFile}`);
  }

  // Use explicit key file so the script works regardless of shell env settings.
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    keyFile
  });

  const client = await auth.getClient();
  const sheetsApi = google.sheets({ version: "v4", auth: client as any });

  const metaRes = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    includeGridData: false
  });

  const spreadsheetTitle = metaRes.data.properties?.title ?? undefined;
  const locale = metaRes.data.properties?.locale ?? undefined;
  const timeZone = metaRes.data.properties?.timeZone ?? undefined;

  const metaSheets = metaRes.data.sheets ?? [];
  const outSheets: DumpSheet[] = [];

  for (const sh of metaSheets) {
    const p = sh.properties;
    if (!p?.title || p.sheetId == null) continue;

    const range = `'${p.title.replace(/'/g, "''")}'`;
    let values: string[][] = [];

    try {
      const valuesRes = await sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range
      });
      values = (valuesRes.data.values as string[][] | undefined) ?? [];
    } catch (err: any) {
      // Keep metadata even when a single tab read fails.
      values = [[`__READ_ERROR__: ${err?.message ?? String(err)}`]];
    }

    outSheets.push({
      title: p.title,
      sheetId: p.sheetId,
      index: p.index ?? undefined,
      hidden: p.hidden ?? undefined,
      rowCount: p.gridProperties?.rowCount ?? undefined,
      columnCount: p.gridProperties?.columnCount ?? undefined,
      values
    });
  }

  const dump: DumpFile = {
    generatedAt: new Date().toISOString(),
    spreadsheetId,
    spreadsheetTitle,
    locale,
    timeZone,
    sheetCount: outSheets.length,
    sheets: outSheets
  };

  const outDir = resolve("public", "data");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const safeName = (spreadsheetTitle ?? "gsheet").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const outFile = join(outDir, `gsheet-dump-${safeName || "sheet"}.json`);

  writeFileSync(outFile, JSON.stringify(dump));

  const totalRows = outSheets.reduce((acc, s) => acc + s.values.length, 0);
  console.log(`Spreadsheet: ${spreadsheetTitle ?? spreadsheetId}`);
  console.log(`Tabs: ${outSheets.length}`);
  console.log(`Rows (sum): ${totalRows}`);
  console.log(`Output: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
