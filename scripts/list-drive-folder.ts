import { google } from "googleapis";

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "secrets/service-account.json",
    scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const client = await auth.getClient() as any;
  const drive = google.drive({ version: "v3", auth: client });

  const FOLDER_ID = "1yOrBTIVQyz0V2iV4T9tE_tQkndoM2ora";

  console.log("=== Drive Folder Contents ===\n");
  try {
    const res = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed=false`,
      fields: "files(id,name,mimeType,modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: 50
    });
    const files = res.data.files ?? [];
    console.log(`Found ${files.length} files:\n`);
    for (const f of files) {
      console.log(`  ${f.name}`);
      console.log(`    id: ${f.id}`);
      console.log(`    type: ${f.mimeType}`);
      console.log(`    modified: ${f.modifiedTime}`);

      // If it's a Google Sheet, list its tabs
      if (f.mimeType === "application/vnd.google-apps.spreadsheet" && f.id) {
        try {
          const sheets = google.sheets({ version: "v4", auth: client });
          const meta = await sheets.spreadsheets.get({ spreadsheetId: f.id, fields: "sheets(properties(title,sheetId))" });
          const tabs = meta.data.sheets ?? [];
          console.log(`    tabs: ${tabs.map(t => `"${t.properties?.title}"`).join(", ")}`);
        } catch(e: any) {
          console.log(`    tabs: (Fehler: ${e?.message})`);
        }
      }
      console.log();
    }
  } catch(e: any) {
    console.error("Fehler:", e?.message ?? e);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
