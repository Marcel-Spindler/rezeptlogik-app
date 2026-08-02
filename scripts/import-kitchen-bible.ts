// Importiert Equipment-Kapazitäten aus der "Küchenbible"-GSheet
// (Bibles_K_Operations_Manager_Supervisors) und pusht sie nach Firestore.
// Quelle ist explizit als "(Provisional)" markiert und enthält TBD/#VALUE!-
// Platzhalter -- diese werden beim Import herausgefiltert, nicht als 0
// interpretiert (0 kg Kapazität würde die Batch-Berechnung falsch auf
// "unendlich viele Batches" umbiegen).
//
// Aufruf: npm run import:kitchen-bible

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { google } from "googleapis";
import admin from "firebase-admin";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";

const SHEET_ID = "1jZXgFcnDhmALSbIlyDbzL-uKpDyLycwdxcVnFNPn32c";

export interface EquipBibleEntry {
  source: "BRAISER" | "MIDDLE_KITCHEN" | "VEGGIE_DEBOX";
  category: string;
  itemName: string;
  maxKg: number;
  notes?: string;
}

function parseKg(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "TBD" || trimmed.startsWith("#")) return null;
  const n = parseFloat(trimmed.replace(/[^\d.,]/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function readTab(sheets: ReturnType<typeof google.sheets>, title: string, range: string): Promise<string[][]> {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${title}'!${range}` });
  return (res.data.values ?? []) as string[][];
}

function parseBraiser(rows: string[][]): EquipBibleEntry[] {
  // Header bei Index 4 (Zeile 5): CATEGORY_, SUBRECIPE SKU_, MAX RAW_ (KG), ...
  const out: EquipBibleEntry[] = [];
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const category = (row[2] ?? "").trim();
    const itemName = (row[3] ?? "").trim();
    const maxKg = parseKg(row[4]);
    if (!category || !itemName || itemName === "-" || maxKg == null) continue;
    out.push({ source: "BRAISER", category, itemName, maxKg });
  }
  return out;
}

function parseMiddleKitchen(rows: string[][]): EquipBibleEntry[] {
  // Header bei Index 4 (Zeile 5): MACHINERY_, SKU SUBRECIPES_, MAX CAPACITY_ (KG), ...
  // MACHINERY_ ist nicht in jeder Zeile wiederholt -> forward-fill.
  const out: EquipBibleEntry[] = [];
  let lastMachine = "";
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const machine = (row[1] ?? "").trim();
    if (machine) lastMachine = machine;
    const itemName = (row[2] ?? "").trim();
    const maxKg = parseKg(row[3]);
    // Ab hier beginnt der PORTIONIERUNG-Abschnitt (kein Kapazitäts-Eintrag mehr).
    if (itemName.toUpperCase().includes("PORTIONING") || itemName.toUpperCase().includes("SCOOP")) break;
    if (!lastMachine || !itemName || maxKg == null) continue;
    out.push({ source: "MIDDLE_KITCHEN", category: lastMachine, itemName, maxKg });
  }
  return out;
}

function parseVeggieDebox(rows: string[][]): EquipBibleEntry[] {
  // Header bei Index 12 (Zeile 13): CATEGORY_, ITEM_, MAX. WEIGHT_ (LB), CAPACITY CHALUPA_ (KG), ...
  const out: EquipBibleEntry[] = [];
  for (let i = 13; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const category = (row[1] ?? "").trim();
    const itemName = (row[2] ?? "").trim();
    const maxKg = parseKg(row[4]);
    if (!category || !itemName || maxKg == null) continue;
    out.push({ source: "VEGGIE_DEBOX", category, itemName, maxKg });
  }
  return out;
}

async function main() {
  const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  console.log("Lese Küchenbible-Tabs …");
  const [braiserRows, middleRows, veggieRows] = await Promise.all([
    readTab(sheets, "BRAISER Bible_EN (Provisional)", "A1:K30"),
    readTab(sheets, "MIDDLE-KITCHEN Bible_EN (Provisional)", "A1:G20"),
    readTab(sheets, "VEGGIE-DEBOX Bible_EN (Provisional)", "A1:J70"),
  ]);

  const entries: EquipBibleEntry[] = [
    ...parseBraiser(braiserRows),
    ...parseMiddleKitchen(middleRows),
    ...parseVeggieDebox(veggieRows),
  ];

  console.log(`  BRAISER: ${entries.filter(e => e.source === "BRAISER").length} Einträge`);
  console.log(`  MIDDLE_KITCHEN: ${entries.filter(e => e.source === "MIDDLE_KITCHEN").length} Einträge`);
  console.log(`  VEGGIE_DEBOX: ${entries.filter(e => e.source === "VEGGIE_DEBOX").length} Einträge`);
  console.log(`  Gesamt: ${entries.length} Einträge (TBD/#VALUE!/leere Zeilen wurden übersprungen)`);

  configureFirestoreWriterAuth();
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const APP_ROOT = db.collection("apps").doc("rezeptlogik");

  await APP_ROOT.collection("equipmentBible").doc("current").set({
    rows: entries,
    updatedAt: new Date().toISOString(),
    sourceSheetId: SHEET_ID,
    note: "Quelle als (Provisional) markiert -- Kapazitäten stichprobenhaft gegen echte Produktion validieren.",
  });

  console.log("\n✓ apps/rezeptlogik/equipmentBible/current aktualisiert");
  process.exit(0);
}

main().catch((e) => { console.error("FEHLER:", e?.message ?? e); process.exit(1); });
