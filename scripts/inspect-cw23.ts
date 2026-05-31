import { google } from "googleapis";

const CW23_ID = "1UvM_huQkDsi4xtUIenaEX9Z4S5G15CAY2vYBhRoRVsE";

async function readTab(sheets: any, spreadsheetId: string, tab: string, range: string) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab}'!${range}`,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return (res.data.values ?? []) as any[][];
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "secrets/service-account.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const client = await auth.getClient() as any;
  const sheets = google.sheets({ version: "v4", auth: client });

  // Plan_VA - full staff assignments
  console.log("\n=== CW23 Plan_VA - Rows 1-30 ===");
  const va = await readTab(sheets, CW23_ID, "Plan_VA", "A1:P35");
  for (let i = 0; i < Math.min(va.length, 35); i++) {
    const cells = (va[i] ?? []).slice(0, 15).map((c: any) => String(c ?? "").substring(0, 18).padEnd(19));
    console.log(`R${String(i + 1).padStart(2)} | ${cells.join("|")}`);
  }

  // Plan_Schedule - box/hour data
  console.log("\n=== CW23 Plan_Schedule - Rows 1-30 ===");
  const sched = await readTab(sheets, CW23_ID, "Plan_Schedule", "A1:L35");
  for (let i = 0; i < Math.min(sched.length, 35); i++) {
    const cells = (sched[i] ?? []).slice(0, 12).map((c: any) => String(c ?? "").substring(0, 22).padEnd(23));
    console.log(`R${String(i + 1).padStart(2)} | ${cells.join("|")}`);
  }

  // Overview - worked hours + MPB
  console.log("\n=== CW23 Overview - Rows 1-20 ===");
  const ov = await readTab(sheets, CW23_ID, "Overview", "A1:P20");
  for (let i = 0; i < Math.min(ov.length, 20); i++) {
    const cells = (ov[i] ?? []).slice(0, 16).map((c: any) => String(c ?? "").substring(0, 18).padEnd(19));
    console.log(`R${String(i + 1).padStart(2)} | ${cells.join("|")}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
