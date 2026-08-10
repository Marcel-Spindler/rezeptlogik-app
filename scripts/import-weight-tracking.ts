// Importiert das "Weight Tracking (Kitchen) | F_ EU" Sheet (manuelles Wiege-Log
// der Kueche) und pusht die vorberechneten Yield-/Goal-Tabs nach Firestore.
//
// Tabs:
//  - "Weekly Yield": vorberechnete Kitchen→Pre-Blast→Post-Blast Ausbeute pro
//    Sub-Rezept/Woche (vom Sheet selbst aggregiert, nicht aus den Einzel-
//    Wiegungen neu berechnet -- die "Raw weight"/"Pre Blast weight"/
//    "Post Blast weight" Tabs mit den Einzelmessungen werden hier bewusst
//    nicht gelesen, siehe unten).
//  - "Raw Weight - Goal" / "Pre Blast - Goal": Ziel- vs. getrackte Gewichte
//    pro Work Order fuer den jeweils aktuellen Snapshot-Tag, inkl. Shortage.
//
// Aufruf: npm run import:weight-tracking

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { google } from "googleapis";
import admin from "firebase-admin";
import type { YieldRow, WeightGoalRow } from "../src/core/types.ts";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";

const DEFAULT_SHEET_ID = "1-brEn6eKSMFDTubokqA7brq_BzjKP0RpmGw4A1RPspw";

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
function numOpt(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (v === "" || v == null) return undefined;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function parseWeeklyYield(rows: unknown[][]): YieldRow[] {
  if (!rows.length) return [];
  const year = new Date().getFullYear();
  const out: YieldRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const weekNum = row[0];
    const subRecipeName = String(row[1] ?? "").trim();
    if (typeof weekNum !== "number" || !subRecipeName) continue;
    out.push({
      week: `${year}-W${String(weekNum).padStart(2, "0")}`,
      subRecipeName,
      code: String(row[2] ?? "").trim(),
      workOrders: String(row[3] ?? "").trim(),
      kitchenKg: num(row[4]),
      preBlastKg: num(row[5]),
      postBlastKg: num(row[6]),
      kitchenToPreBlastRatio: numOpt(row[7]),
      preBlastToPostBlastRatio: numOpt(row[8]),
      totalRatio: numOpt(row[9]),
      readings: num(row[10]),
    });
  }
  return out;
}

// "Raw Weight - Goal" und "Pre Blast - Goal" teilen sich die Spaltenstruktur
// (Meta-Zeile 0, Header Zeile 1, Daten ab Zeile 2): Date, WO, Recipe,
// Subrecipe, Goal [kg], Tracked [kg], Shortage [kg], Post blast goal, ...
function parseGoalTab(rows: unknown[][], stage: WeightGoalRow["stage"]): WeightGoalRow[] {
  if (rows.length < 3) return [];
  const out: WeightGoalRow[] = [];
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const workOrder = String(row[1] ?? "").trim();
    if (!/^\d{2}-\d{1,4}$/.test(workOrder)) continue;
    const dateRaw = String(row[0] ?? "").trim();
    out.push({
      stage,
      date: dateRaw.replace(/\//g, "-"),
      workOrder,
      recipeName: String(row[2] ?? "").trim(),
      subRecipeName: String(row[3] ?? "").trim(),
      goalKg: num(row[4]),
      trackedKg: num(row[5]),
      shortageKg: numOpt(row[6]),
      postBlastGoalKg: numOpt(row[7]),
    });
  }
  return out;
}

async function readTab(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string, tab: string): Promise<unknown[][]> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `'${tab}'!A1:N3000`, valueRenderOption: "UNFORMATTED_VALUE",
  });
  return (res.data.values ?? []) as unknown[][];
}

async function main() {
  const spreadsheetId = process.env.SHEET_WEIGHT_TRACKING ?? DEFAULT_SHEET_ID;

  const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  console.log(`Lese Weight Tracking aus ${spreadsheetId} …`);
  const [weeklyYieldRows, rawGoalRows, preBlastGoalRows] = await Promise.all([
    readTab(sheets, spreadsheetId, "Weekly Yield"),
    readTab(sheets, spreadsheetId, "Raw Weight - Goal"),
    readTab(sheets, spreadsheetId, "Pre Blast - Goal"),
  ]);

  const weeklyYield = parseWeeklyYield(weeklyYieldRows);
  const weightGoals = [
    ...parseGoalTab(rawGoalRows, "raw"),
    ...parseGoalTab(preBlastGoalRows, "preBlast"),
  ];

  console.log(`  Weekly Yield: ${weeklyYield.length} Sub-Rezept/Wochen-Zeilen`);
  console.log(`  Weight Goals: ${weightGoals.length} (raw: ${weightGoals.filter(w => w.stage === "raw").length}, preBlast: ${weightGoals.filter(w => w.stage === "preBlast").length})`);

  if (!weeklyYield.length && !weightGoals.length) {
    console.warn("  Nichts gefunden -- Sheet-Layout hat sich vermutlich geaendert. Abbruch ohne Firestore-Push.");
    process.exit(1);
  }

  configureFirestoreWriterAuth();
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  const APP_ROOT = db.collection("apps").doc("rezeptlogik");

  const updatedAt = new Date().toISOString();
  await APP_ROOT.collection("weeklyYield").doc("current").set({ rows: weeklyYield, updatedAt, sourceSheetId: spreadsheetId });
  await APP_ROOT.collection("weightGoals").doc("current").set({ rows: weightGoals, updatedAt, sourceSheetId: spreadsheetId });

  console.log("\n✓ apps/rezeptlogik/{weeklyYield,weightGoals}/current aktualisiert");
  process.exit(0);
}

main().catch(e => { console.error("FEHLER:", e?.message ?? e); process.exit(1); });
