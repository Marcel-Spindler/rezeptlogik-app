// Importiert die "Planning Calendar" GSheet-Tab (Deadlines + Eskalationskontakte
// fuer den woechentlichen Planungsprozess) und pusht sie nach Firestore.
// Quelle: F_VE Production Plan, Tab "Planning Calendar".
//
// Aufruf: npm run import:planning-calendar

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { google } from "googleapis";
import admin from "firebase-admin";
import type { PlanningCalendarDeadline, PlanningCalendarRule } from "../src/core/types.ts";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";

const DEFAULT_SHEET_ID = "1zaQjWKlNN4JNCMnE-lrdgf7iNgabfl9HGq5vdOyKedI";
const TAB_NAME = "Planning Calendar";

// Eskalations-/Deadline-Tabelle: Das Sheet enthaelt zwei Tabellen mit "Deadline"/
// "Days"-Spalten -- eine aeltere, unvollstaendige (Zeile 16, Spalten POC/1st level/
// 2nd level/Escelation) und die aktuell gepflegte "Calendar activity (reminder)"
// (Zeile 28, Spalten L1 (owner)/L2 (+1h)/L3 (+2h)). Nur letztere hat vollstaendige
// Eskalationskontakte -- am "l1"-Spaltenpraefix erkennbar.
function parseDeadlines(rows: string[][]): PlanningCalendarDeadline[] {
  const headerIdx = rows.findIndex(r => {
    const h = r.map(c => String(c ?? "").trim().toLowerCase());
    return h.some(c => c === "deadline") && h.some(c => c === "days") && h.some(c => c.startsWith("l1"));
  });
  if (headerIdx < 0) return [];

  const header = rows[headerIdx].map(c => String(c ?? "").trim().toLowerCase());
  const activityIdx = 0; // erste Spalte ist durchgehend die Aktivitaets-/Reminder-Bezeichnung
  const deadlineIdx = header.findIndex(c => c === "deadline");
  const daysIdx = header.findIndex(c => c === "days");
  const l1Idx = header.findIndex(c => c.startsWith("l1"));
  const l2Idx = header.findIndex(c => c.startsWith("l2"));
  const l3Idx = header.findIndex(c => c.startsWith("l3"));

  const out: PlanningCalendarDeadline[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const activity = String(row[activityIdx] ?? "").trim();
    if (!activity) continue;
    out.push({
      activity,
      time: deadlineIdx >= 0 ? String(row[deadlineIdx] ?? "").trim() : "",
      days: daysIdx >= 0 ? String(row[daysIdx] ?? "").trim() : "",
      owner: (l1Idx >= 0 ? String(row[l1Idx] ?? "").trim() : "") || undefined,
      escalation1: (l2Idx >= 0 ? String(row[l2Idx] ?? "").trim() : "") || undefined,
      escalation2: (l3Idx >= 0 ? String(row[l3Idx] ?? "").trim() : "") || undefined,
    });
  }
  return out;
}

// Freitext-Planungsregeln stehen in Spalte L ("Rules of 3 weeks planning"),
// Prioritaets-Tag optional in Spalte M ("must"/"can"/"info"/"optimal").
function parseRules(rows: string[][]): PlanningCalendarRule[] {
  const headerIdx = rows.findIndex(r => String(r[11] ?? "").trim() === "Rules of 3 weeks planning");
  if (headerIdx < 0) return [];

  const out: PlanningCalendarRule[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const note = String(row[11] ?? "").trim();
    if (!note) continue;
    out.push({ note, priority: String(row[12] ?? "").trim() || undefined });
  }
  return out;
}

async function main() {
  const spreadsheetId = process.env.SHEET_PLANNING_CALENDAR ?? DEFAULT_SHEET_ID;

  const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  console.log(`Lese Tab "${TAB_NAME}" aus ${spreadsheetId} …`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${TAB_NAME}'!A1:M60`,
  });
  const rows = (res.data.values ?? []) as string[][];

  const deadlines = parseDeadlines(rows);
  const rules = parseRules(rows);

  console.log(`  Deadlines/Eskalationskontakte: ${deadlines.length}`);
  console.log(`  Planungsregeln: ${rules.length}`);
  if (!deadlines.length && !rules.length) {
    console.warn("  Nichts gefunden -- Sheet-Layout hat sich vermutlich geaendert. Abbruch ohne Firestore-Push.");
    process.exit(1);
  }

  configureFirestoreWriterAuth();
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true }); // manche Aktivitaeten (z.B. "Create Draft Plan") haben keine L1/L2/L3-Kontakte
  const APP_ROOT = db.collection("apps").doc("rezeptlogik");

  await APP_ROOT.collection("planningCalendar").doc("current").set({
    deadlines,
    rules,
    updatedAt: new Date().toISOString(),
    sourceSheetId: spreadsheetId,
  });

  console.log("\n✓ apps/rezeptlogik/planningCalendar/current aktualisiert");
  process.exit(0);
}

main().catch(e => { console.error("FEHLER:", e?.message ?? e); process.exit(1); });
