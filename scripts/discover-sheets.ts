// Listet Tab-Namen + GIDs für alle 6 konfigurierten Google Sheets.
// Voraussetzung: GOOGLE_APPLICATION_CREDENTIALS gesetzt, Sheets mit Service Account geteilt.
// Aufruf: npm run discover:sheets

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { google } from "googleapis";

const SHEET_DEFS = [
  { name: "Wochenstart",          id: process.env.SHEET_WOCHENSTART   ?? "1YscgiuKYVI2pGcMJ3RcJwWGQEkG46RnVnji8q8a4AeE" },
  { name: "Print Orders (Sleeven)", id: process.env.SHEET_PRINT_ORDERS ?? "1fpEHBWmd_zk74wbu78unPoTV_u860smNlxTuioEdq-4" },
  { name: "Kitchen Priority",     id: process.env.SHEET_KITCHEN_PRIORITY ?? "13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U" },
  { name: "Ramp-Up Plan (primär)", id: process.env.GSHEET_ID ?? "" },
  { name: "Ramp-Up Plan 2",       id: (process.env.GSHEET_IDS ?? "").split(",")[0]?.trim() ?? "1cQtoL4aYHfc_44mfQQty8-EFKPZoYPLBQ2ojmO8hgzg" },
  { name: "Fertigstellungszeitplan", id: process.env.SHEET_FERTIGSTELLUNG ?? "1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY" },
].filter(s => s.id);

async function main() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  console.log("=== Sheet-Tab Discovery ===\n");

  for (const def of SHEET_DEFS) {
    console.log(`📋 ${def.name}`);
    console.log(`   ID: ${def.id}`);
    try {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: def.id,
        fields: "sheets(properties(title,sheetId,index))"
      });
      const tabs = meta.data.sheets ?? [];
      if (!tabs.length) {
        console.log("   (keine Tabs gefunden)\n");
        continue;
      }
      for (const tab of tabs) {
        const p = tab.properties;
        console.log(`   [${String(p?.index).padStart(2)}] gid=${String(p?.sheetId).padEnd(12)}  "${p?.title}"`);
      }
    } catch (e: any) {
      console.error(`   ❌ Fehler: ${e?.message ?? e}`);
    }
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
