import { google } from "googleapis";

// CW23 = 1y3Dmd33eklNgbBwvbCyMXUlB7muvfMPNSjTQl_KnlrM
// CW22 = 1UvM_huQkDsi4xtUIenaEX9Z4S5G15CAY2vYBhRoRVsE
const CW23_ID = "1y3Dmd33eklNgbBwvbCyMXUlB7muvfMPNSjTQl_KnlrM";

async function readTab(sheets: any, id: string, tab: string, range: string) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: id, range: `'${tab}'!${range}`, valueRenderOption: "UNFORMATTED_VALUE",
  });
  return (res.data.values ?? []) as any[][];
}

async function main() {
  const auth = new google.auth.GoogleAuth({ keyFile: "secrets/service-account.json", scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const client = await auth.getClient() as any;
  const sheets = google.sheets({ version: "v4", auth: client });

  // Plan_VA - team headcounts
  console.log("\n=== CW23 Plan_VA Rows 1-28 ===");
  const va = await readTab(sheets, CW23_ID, "Plan_VA", "A1:P28");
  for (let i = 0; i < va.length; i++) {
    const cells = (va[i] ?? []).slice(0, 15).map((c: any) => String(c ?? "").substring(0, 12).padEnd(13));
    console.log(`R${String(i + 1).padStart(2)} | ${cells.join("|")}`);
  }

  // Plan_Schedule - box targets and hours/shift
  console.log("\n=== CW23 Plan_Schedule Rows 1-40 ===");
  const sched = await readTab(sheets, CW23_ID, "Plan_Schedule", "A1:L40");
  for (let i = 0; i < sched.length; i++) {
    const cells = (sched[i] ?? []).slice(0, 12).map((c: any) => String(c ?? "").substring(0, 18).padEnd(19));
    console.log(`R${String(i + 1).padStart(2)} | ${cells.join("|")}`);
  }

  // Review_Production - actual produced boxes per shift
  console.log("\n=== CW23 Review_Production Rows 1-80 ===");
  const rev = await readTab(sheets, CW23_ID, "Review_Production", "A1:P80");
  for (let i = 0; i < rev.length; i++) {
    const row = rev[i] ?? [];
    if (row.every((c: any) => !c && c !== 0)) continue; // skip empty rows
    const cells = row.slice(0, 14).map((c: any) => String(c ?? "").substring(0, 16).padEnd(17));
    console.log(`R${String(i + 1).padStart(2)} | ${cells.join("|")}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
