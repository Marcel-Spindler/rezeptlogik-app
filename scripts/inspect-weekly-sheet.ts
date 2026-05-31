import { google } from "googleapis";

const CW24_ID = "1GNc4MpsHDg8kz03Hmdhkw9t-KKiBWU2cFJDbOZNIO6w";
const TABS_TO_INSPECT = ["Plan_Schedule", "Overview", "Review_Production", "Plan_VA"];

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "secrets/service-account.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const client = await auth.getClient() as any;
  const sheets = google.sheets({ version: "v4", auth: client });

  for (const tab of TABS_TO_INSPECT) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`TAB: ${tab}`);
    console.log("=".repeat(60));
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: CW24_ID,
        range: `'${tab}'!A1:Z40`,
        valueRenderOption: "FORMATTED_VALUE"
      });
      const rows = res.data.values ?? [];
      for (let i = 0; i < Math.min(rows.length, 30); i++) {
        const cells = rows[i].slice(0, 16).map((c: any) => String(c ?? "").substring(0, 30).padEnd(31));
        console.log(`R${String(i+1).padStart(2)} | ${cells.join("|")}`);
      }
    } catch(e: any) {
      console.error(`  Fehler: ${e?.message}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
