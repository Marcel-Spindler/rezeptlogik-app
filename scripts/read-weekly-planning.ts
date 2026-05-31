/**
 * Reads the current (or most recent filled) Weekly Planning sheet from the Google Drive folder.
 * Extracts: box/meal targets per day + team headcounts per area/shift (Plating, Kitchen, etc.)
 * Outputs: public/data/weekly-planning.json
 *
 * Usage: npm run import:weekly-planning
 * Drive folder: https://drive.google.com/drive/folders/1yOrBTIVQyz0V2iV4T9tE_tQkndoM2ora
 */

import { google } from "googleapis";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FOLDER_ID = "1yOrBTIVQyz0V2iV4T9tE_tQkndoM2ora";
const BOXES_PER_LINE_PER_SHIFT = 6608; // 1000 boxes/h × ~6.6 effective hours

// ── Types ────────────────────────────────────────────────────────────────────

export type WeeklyPlanningData = {
  cw: number;
  year: number;
  isReference: boolean;
  referenceNote: string;
  spreadsheetName: string;
  spreadsheetId: string;
  generatedAt: string;
  boxesPerLinePerShift: number;
  boxSchedule: BoxDay[];
  teamByDay: TeamDay[];
};

export type BoxDay = {
  dayLabel: string;   // "Thu","Fri","Sat","Sun","Mon","Tue","Wed"
  boxes: number;
  meals: number;
};

export type TeamDay = {
  dayLabel: string;   // "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"
  date: string;       // "2026-06-02" ISO
  platingLinesEarly: number;
  platingLinesLate: number;
  platingHeadcountEarly: number;
  platingHeadcountLate: number;
  kitchenHeadcountEarly: number;
  kitchenHeadcountLate: number;
  allStaffEarly: number;
  allStaffLate: number;
  areas: Record<string, { early: number; late: number }>;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseNum(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function extractCW(filename: string): number {
  const m = /CW\s*(\d{1,2})/i.exec(filename);
  return m ? parseInt(m[1], 10) : 0;
}

function currentISOWeek(): number {
  const now = new Date();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/** Convert Excel serial date to ISO string */
function excelSerialToISO(serial: number): string {
  if (!serial || serial < 1) return "";
  // Excel epoch: Jan 0, 1900 = serial 0 (with Lotus leap year bug: serial 60 = Feb 29, 1900)
  const msFromEpoch = (serial - 1) * 86400000;
  // Adjust: serial 1 = Jan 1, 1900 → Unix: 1900-01-01T00:00:00Z
  const excelEpoch = Date.UTC(1900, 0, 1); // Jan 1 1900 = serial 1
  // Subtract 1 from serial for the off-by-one with serial 1 = Jan 1
  const d = new Date(excelEpoch + (serial - 1) * 86400000);
  // Fix the Lotus 1900 leap year bug: Excel serial 60 = fake Feb 29 1900, adds 1 day
  const adjusted = new Date(d.getTime() - (serial >= 60 ? 0 : 0));
  // Actually just use the standard formula
  return adjusted.toISOString().split("T")[0];
}

/** Parse box schedule from Plan_Schedule rows */
function extractBoxSchedule(rows: unknown[][]): BoxDay[] {
  let boxLabelRow = -1;
  let mealLabelRow = -1;

  for (let i = 0; i < rows.length; i++) {
    const text = (rows[i] ?? []).map(c => String(c ?? "").toLowerCase()).join(" ");
    if (text.includes("box level") || (text.includes("basecamp") && boxLabelRow < 0)) {
      boxLabelRow = i + 1; // next row = day headers, row after = values
    }
    if (text.includes("mealkit") || text.includes("mealkitlevel") || (text.includes("basecamp") && boxLabelRow > 0 && mealLabelRow < 0)) {
      mealLabelRow = i + 1;
    }
  }

  if (boxLabelRow < 0) return [];

  const dayNames = (rows[boxLabelRow] ?? []) as unknown[];
  const boxCounts = (rows[boxLabelRow + 1] ?? []) as unknown[];
  const mealCounts = mealLabelRow >= 0 ? ((rows[mealLabelRow + 1] ?? []) as unknown[]) : [];

  const result: BoxDay[] = [];
  for (let col = 0; col < dayNames.length; col++) {
    const day = String(dayNames[col] ?? "").trim();
    if (!day || day.toLowerCase() === "total") continue;
    result.push({
      dayLabel: day,
      boxes: parseNum(boxCounts[col]),
      meals: parseNum(mealCounts[col] ?? 0),
    });
  }
  return result;
}

const WEEKDAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Parse team headcounts from Plan_VA rows */
function extractTeamByDay(rows: unknown[][]): TeamDay[] {
  if (rows.length < 3) return [];

  // Row 0 = day headers: [area_label | Monday | "" | Tuesday | "" | ...]
  // Row 1 = dates (Excel serials): [monSerial | monSerial | monSerial | tueSerial | ...]
  // Row 2 = shift labels: ["Shift" | "early shift" | "late shift" | ...]
  const dayRow = (rows[0] ?? []) as unknown[];
  const dateRow = (rows[1] ?? []) as unknown[];

  // Build column mapping: which col index corresponds to which day (early/late)
  type ColMap = { day: string; earlyCol: number; lateCol: number; date: string };
  const colMap: ColMap[] = [];
  let col = 1;
  while (col < dayRow.length) {
    const dayLabel = String(dayRow[col] ?? "").trim();
    if (!dayLabel) { col++; continue; }
    // Date from row 1 (Excel serial or text)
    const rawDate = dateRow[col];
    let dateISO = "";
    if (typeof rawDate === "number" && rawDate > 40000) {
      dateISO = excelSerialToISO(rawDate);
    }
    colMap.push({ day: dayLabel, earlyCol: col, lateCol: col + 1, date: dateISO });
    col += 2;
  }

  if (!colMap.length) return [];

  // Collect all area rows (skip rows 0-2 = header)
  const areaRows = rows.slice(3);

  // Find "total" row to cross-check
  const totalRowIdx = areaRows.findIndex(r => String((r as any[])[0] ?? "").toLowerCase() === "total");

  const result: TeamDay[] = colMap.map(({ day, earlyCol, lateCol, date }) => {
    const areas: Record<string, { early: number; late: number }> = {};
    let allStaffEarly = 0;
    let allStaffLate = 0;
    let platingLinesEarly = 0;
    let platingLinesLate = 0;
    let platingHeadcountEarly = 0;
    let platingHeadcountLate = 0;
    let kitchenHeadcountEarly = 0;
    let kitchenHeadcountLate = 0;

    for (const row of areaRows) {
      const r = row as unknown[];
      const areaName = String(r[0] ?? "").trim();
      if (!areaName || areaName.toLowerCase() === "total") continue;

      const early = parseNum(r[earlyCol]);
      const late = parseNum(r[lateCol]);
      if (early === 0 && late === 0) continue;

      areas[areaName] = { early, late };

      const areaLower = areaName.toLowerCase();
      if (areaLower.startsWith("plating")) {
        if (early > 0) { platingLinesEarly++; platingHeadcountEarly += early; }
        if (late > 0) { platingLinesLate++; platingHeadcountLate += late; }
      } else if (/^k\d/.test(areaLower)) {
        kitchenHeadcountEarly += early;
        kitchenHeadcountLate += late;
      }
    }

    // Use total row if available
    if (totalRowIdx >= 0) {
      const totRow = areaRows[totalRowIdx] as unknown[];
      allStaffEarly = parseNum(totRow[earlyCol]) || Object.values(areas).reduce((s, a) => s + a.early, 0);
      allStaffLate = parseNum(totRow[lateCol]) || Object.values(areas).reduce((s, a) => s + a.late, 0);
    } else {
      allStaffEarly = Object.values(areas).reduce((s, a) => s + a.early, 0);
      allStaffLate = Object.values(areas).reduce((s, a) => s + a.late, 0);
    }

    return {
      dayLabel: day,
      date,
      platingLinesEarly,
      platingLinesLate,
      platingHeadcountEarly: Math.round(platingHeadcountEarly * 10) / 10,
      platingHeadcountLate: Math.round(platingHeadcountLate * 10) / 10,
      kitchenHeadcountEarly: Math.round(kitchenHeadcountEarly * 10) / 10,
      kitchenHeadcountLate: Math.round(kitchenHeadcountLate * 10) / 10,
      allStaffEarly: Math.round(allStaffEarly * 10) / 10,
      allStaffLate: Math.round(allStaffLate * 10) / 10,
      areas,
    };
  });

  return result.sort((a, b) => WEEKDAY_ORDER.indexOf(a.dayLabel) - WEEKDAY_ORDER.indexOf(b.dayLabel));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: join(__dirname, "../secrets/service-account.json"),
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });
  const client = await auth.getClient() as any;
  const drive = google.drive({ version: "v3", auth: client });
  const sheets = google.sheets({ version: "v4", auth: client });

  // 1. List all weekly planning sheets in the folder
  console.log("Listing Drive folder...");
  const filesRes = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`,
    fields: "files(id,name,modifiedTime)",
    orderBy: "name desc",
    pageSize: 20,
  });
  const files = (filesRes.data.files ?? []).filter(f => /weekly.planning/i.test(f.name ?? ""));
  console.log(`Found ${files.length} weekly planning sheets`);
  for (const f of files) console.log(`  CW${extractCW(f.name ?? "")} → ${f.name} (${f.id})`);

  const currentKW = currentISOWeek();
  console.log(`Current ISO week: ${currentKW}`);

  // Sort by CW descending so we check current week first, then go back
  const sorted = [...files].sort((a, b) => extractCW(b.name ?? "") - extractCW(a.name ?? ""));

  let selectedFile: typeof files[0] | null = null;
  let isReference = false;
  let referenceNote = "";

  for (const file of sorted) {
    const cw = extractCW(file.name ?? "");
    if (cw < currentKW - 3 || cw > currentKW + 1) continue; // only look ±3 weeks

    // Check if Plan_VA has actual data (look at the "total" row)
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: file.id!,
        range: "'Plan_VA'!A1:P35",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const rows = (res.data.values ?? []) as unknown[][];
      const totalRow = rows.find(r => String((r as any[])[0] ?? "").toLowerCase() === "total");
      const hasData = totalRow ? (totalRow as number[]).slice(1).some(v => typeof v === "number" && v > 0) : false;

      if (hasData) {
        selectedFile = file;
        if (cw < currentKW) {
          isReference = true;
          referenceNote = `KW${cw} als Referenz verwendet (KW${currentKW} noch nicht befüllt)`;
        } else {
          referenceNote = `KW${cw} Daten`;
        }
        console.log(`✓ Using ${file.name} (has data, isReference=${isReference})`);
        break;
      } else {
        console.log(`  ${file.name}: kein Daten in Plan_VA (übersprungen)`);
      }
    } catch (e: any) {
      console.warn(`  ${file.name}: Fehler beim Lesen — ${e?.message}`);
    }
  }

  if (!selectedFile) {
    console.error("Kein passendes Sheet mit Daten gefunden.");
    process.exit(1);
  }

  const spreadsheetId = selectedFile.id!;
  const spreadsheetName = selectedFile.name ?? "";
  const cw = extractCW(spreadsheetName);

  // 2. Read Plan_Schedule (box + meal targets)
  console.log("Reading Plan_Schedule...");
  const schedRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Plan_Schedule'!A1:L35",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const schedRows = (schedRes.data.values ?? []) as unknown[][];
  const boxSchedule = extractBoxSchedule(schedRows);
  console.log(`  Box schedule: ${boxSchedule.length} days extracted`);
  boxSchedule.forEach(d => console.log(`    ${d.dayLabel}: ${d.boxes} boxes, ${d.meals} meals`));

  // 3. Read Plan_VA (team headcounts)
  console.log("Reading Plan_VA...");
  const vaRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Plan_VA'!A1:P35",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const vaRows = (vaRes.data.values ?? []) as unknown[][];
  const teamByDay = extractTeamByDay(vaRows);
  console.log(`  Team plan: ${teamByDay.length} days extracted`);
  teamByDay.forEach(d => {
    const totalLines = d.platingLinesEarly + d.platingLinesLate;
    const totalKitchen = d.kitchenHeadcountEarly + d.kitchenHeadcountLate;
    console.log(`    ${d.dayLabel}: Plating ${totalLines} Linien (${d.platingHeadcountEarly + d.platingHeadcountLate} MA), Küche ${totalKitchen} MA, Gesamt ${d.allStaffEarly + d.allStaffLate} MA`);
  });

  const result: WeeklyPlanningData = {
    cw,
    year: new Date().getFullYear(),
    isReference,
    referenceNote,
    spreadsheetName,
    spreadsheetId,
    generatedAt: new Date().toISOString(),
    boxesPerLinePerShift: BOXES_PER_LINE_PER_SHIFT,
    boxSchedule,
    teamByDay,
  };

  const outPath = join(__dirname, "../public/data/weekly-planning.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`\n✓ Saved to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
