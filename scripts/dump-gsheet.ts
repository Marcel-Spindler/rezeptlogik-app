/**
 * Liest ein Google Sheet komplett aus und speichert alle Tabs als JSON.
 * Output: public/data/gsheet-dump-{SpreadsheetName}.json
 *
 * Usage: npx tsx scripts/dump-gsheet.ts <spreadsheetId>
 * Beispiel: npx tsx scripts/dump-gsheet.ts 13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U
 */

import { google } from "googleapis";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const spreadsheetId = process.argv[2];
  if (!spreadsheetId) {
    console.error("Usage: npx tsx scripts/dump-gsheet.ts <spreadsheetId>");
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: join(__dirname, "../secrets/service-account.json"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const client = await auth.getClient() as any;
  const sheets = google.sheets({ version: "v4", auth: client });

  // Spreadsheet-Metadaten lesen (Name + Tab-Liste)
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "properties(title),sheets(properties(title,sheetId,index))",
  });

  const spreadsheetName = (meta.data.properties?.title ?? spreadsheetId)
    .replace(/[^\w\s\-]/g, "")
    .replace(/\s+/g, "_");
  const tabs = meta.data.sheets ?? [];
  console.log(`Spreadsheet: ${meta.data.properties?.title}`);
  console.log(`Tabs: ${tabs.length}`);

  const dumpSheets: { title: string; sheetId: number; values: string[][] }[] = [];

  for (const tab of tabs) {
    const title = tab.properties?.title ?? "";
    const sheetId = tab.properties?.sheetId ?? 0;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${title}'!A1:ZZ5000`,
        valueRenderOption: "FORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      });
      const values = (res.data.values ?? []) as string[][];
      dumpSheets.push({ title, sheetId, values });
    } catch (e: any) {
      console.warn(`  Tab "${title}" übersprungen: ${e?.message}`);
    }
  }

  const outDir = join(__dirname, "../public/data");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `gsheet-dump-${spreadsheetName}.json`);
  writeFileSync(outPath, JSON.stringify({ id: spreadsheetId, name: meta.data.properties?.title, sheets: dumpSheets }, null, 2), "utf-8");
  console.log(`Output: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
