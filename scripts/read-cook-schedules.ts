import { google } from "googleapis";
import type { CookSchedule } from "../src/types.ts";

const DEFAULT_COOK_SCHEDULES_GSHEET_ID = "1jZXgFcnDhmALSbIlyDbzL-uKpDyLycwdxcVnFNPn32c";

function num(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

export async function readCookSchedulesFromGSheet(): Promise<Record<string, CookSchedule>> {
  const spreadsheetId = process.env.SHEET_COOK_SCHEDULES ?? DEFAULT_COOK_SCHEDULES_GSHEET_ID;

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  // Tab-Namen ermitteln
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
  const tabTitles = (meta.data.sheets ?? []).map(s => s.properties?.title ?? "");
  // Präferenz: Tab mit "VF" oder "Cook Schedules", sonst erster Tab
  const tabName = tabTitles.find(t => /vf|cook.schedule/i.test(t)) ?? tabTitles[0] ?? "Sheet1";

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A1:Z5000`,
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const rows = res.data.values ?? [];
  if (rows.length < 2) return {};

  // Header-Zeile: Spalten-Index-Map
  const headers: string[] = (rows[0] as any[]).map(h => String(h ?? "").trim());
  const col = (name: string) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());

  const siteIdx    = col("Site");
  const methodIdx  = col("COOK METHODS");
  const shiftsIdx  = col("Cook Shifts");
  const b4Idx      = col("4 Shifts Before");
  const b3Idx      = col("3 Shifts Before");
  const b2Idx      = col("2 Shifts Before");
  const b1Idx      = col("1 Shift Before");
  const sameDayIdx = col("Same Day/Shift");

  const out: Record<string, CookSchedule> = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as any[];
    if (siteIdx >= 0 && String(row[siteIdx] ?? "").trim().toUpperCase() !== "VF") continue;
    const method = String(row[methodIdx] ?? "").trim();
    if (!method) continue;

    const steps: CookSchedule["steps"] = [];
    const cells: [number, number][] = [
      [4, b4Idx], [3, b3Idx], [2, b2Idx], [1, b1Idx], [0, sameDayIdx]
    ];
    for (const [n, idx] of cells) {
      if (idx < 0) continue;
      const label = String(row[idx] ?? "").trim();
      if (label) steps.push({ shiftsBefore: n, label });
    }
    out[method] = {
      cookMethod: method,
      site: "VF",
      cookShifts: shiftsIdx >= 0 ? num(row[shiftsIdx]) || 1 : 1,
      steps
    };
  }
  console.log(`  Cook Schedules (GSheet): ${Object.keys(out).length} VF-Methoden importiert`);
  return out;
}
