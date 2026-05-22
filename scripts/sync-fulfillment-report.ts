/**
 * sync-fulfillment-report.ts
 *
 * Liest den OUTPUT - [F_ x HF] Weekly Fulfillment Report (GSheet) und
 * pusht drei Datensätze nach Firestore:
 *
 *  1. maitreRampup/{week}__{market}__{code}
 *     ← Tab "Maitre Inputs DE/NO_Stamm"
 *     Volumen-Snapshots je Rezept/Markt/Woche (wed-4wk … order)
 *
 *  2. produktionsplanung/{week}__DE  und  /{week}__NORDICS
 *     ← Tabs "Produktionsvorbereitung_DE" und "_Nordics"
 *     Geplante Mengen je Rezept und Liefertag (Run 1 / Run 2)
 *
 *  3. fcmsInbound/{week}
 *     ← Tab "Logistik - FCMS Meals"
 *     Tatsächlich eingegangene PO-Positionen aus dem FCMS/WMS
 *
 * Ausführen:
 *   npm run sync:fulfillment:report
 *
 * Optionen (env):
 *   FULFILLMENT_REPORT_REFRESH=true   → Dump live neu laden (Standard: false, nimmt vorhandenen Dump)
 *   FULFILLMENT_REPORT_SHEET_ID       → Override Sheet-ID (Standard: hardcoded OUTPUT-Sheet)
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { google } from "googleapis";
import admin from "firebase-admin";
import type {
  MaitreRampupEntry, MaitreSnapshotLabel,
  ProduktionsplanungEntry, ProduktionsplanungSlot,
  FcmsInboundData, FcmsInboundRow,
} from "../src/types.ts";

// ─── Konfiguration ─────────────────────────────────────────────────────────────

const FULFILLMENT_SHEET_ID =
  process.env.FULFILLMENT_REPORT_SHEET_ID?.trim() ??
  "1YscgiuKYVI2pGcMJ3RcJwWGQEkG46RnVnji8q8a4AeE";

const REFRESH_DUMP = (process.env.FULFILLMENT_REPORT_REFRESH ?? "false").toLowerCase() === "true";
const KEY_FILE = resolve("secrets", "service-account.json");
const OUT_DIR = resolve("public", "data");
const DUMP_PREFIX = "gsheet-dump-OUTPUT_-_F__x_HF_Weekly_Fulfillment_Report";

// ─── Typen für Dump-Format ──────────────────────────────────────────────────

type DumpSheet = { title: string; values: string[][] };
type DumpFile  = { spreadsheetId: string; spreadsheetTitle?: string; generatedAt: string; sheets: DumpSheet[] };

// ─── Dump laden / refreshen ──────────────────────────────────────────────────

function findDumpFile(): string | null {
  if (!existsSync(OUT_DIR)) return null;
  for (const f of readdirSync(OUT_DIR)) {
    if (f.startsWith(DUMP_PREFIX) && f.endsWith(".json")) return join(OUT_DIR, f);
  }
  return null;
}

async function refreshDump(): Promise<DumpFile> {
  console.log("Refreshe Dump vom GSheet API …");
  process.env.GOOGLE_APPLICATION_CREDENTIALS = KEY_FILE;
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    keyFile: KEY_FILE,
  });
  const sheetsApi = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId: FULFILLMENT_SHEET_ID, includeGridData: false });
  const title = meta.data.properties?.title ?? FULFILLMENT_SHEET_ID;
  const outSheets: DumpSheet[] = [];

  for (const sh of meta.data.sheets ?? []) {
    const shTitle = sh.properties?.title;
    if (!shTitle) continue;
    let values: string[][] = [];
    try {
      const res = await sheetsApi.spreadsheets.values.get({ spreadsheetId: FULFILLMENT_SHEET_ID, range: `'${shTitle.replace(/'/g, "''")}'` });
      values = (res.data.values as string[][] | undefined) ?? [];
    } catch { values = []; }
    outSheets.push({ title: shTitle, values });
  }

  const dump: DumpFile = {
    spreadsheetId: FULFILLMENT_SHEET_ID,
    spreadsheetTitle: title,
    generatedAt: new Date().toISOString(),
    sheets: outSheets,
  };
  const outPath = join(OUT_DIR, `${DUMP_PREFIX}.json`);
  writeFileSync(outPath, JSON.stringify(dump));
  console.log(`  Dump gespeichert: ${outPath}`);
  return dump;
}

async function loadDump(): Promise<DumpFile> {
  if (REFRESH_DUMP) return refreshDump();
  const existing = findDumpFile();
  if (existing) {
    console.log(`Nutze vorhandenen Dump: ${existing}`);
    return JSON.parse(readFileSync(existing, "utf8")) as DumpFile;
  }
  console.log("Kein Dump vorhanden – lade neu …");
  return refreshDump();
}

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────

function parseNum(v: string | undefined): number {
  if (!v || v === "" || v === "#N/A" || v === "#REF!" || v === "#DIV/0!" || v === "---") return 0;
  return parseFloat(v.replace(/[,\s]/g, "")) || 0;
}

function getSheet(dump: DumpFile, title: string): DumpSheet | undefined {
  return dump.sheets.find(s => s.title === title);
}

// ─── Parser: Maitre Inputs DE/NO ──────────────────────────────────────────────

const SNAPSHOT_LABELS: MaitreSnapshotLabel[] = [
  "wed-4wk", "wed-3wk", "wed-2wk", "wed-1wk", "fri-1wk", "mon", "tue", "wed", "thu",
];

function parseMaitreInputs(dump: DumpFile): MaitreRampupEntry[] {
  const sheet = getSheet(dump, "Maitre Inputs DE/NO_Stamm");
  if (!sheet) { console.warn("  Tab 'Maitre Inputs DE/NO_Stamm' nicht gefunden"); return []; }

  const entries: MaitreRampupEntry[] = [];
  for (const row of sheet.values) {
    const market = row[0]?.trim();
    if (market !== "DE" && market !== "NORDICS") continue; // Header / Summary überspringen
    const slotRaw = row[2]?.trim();
    const slot = parseInt(slotRaw, 10);
    if (!slotRaw || isNaN(slot)) continue; // Summenzeilen überspringen

    const week       = row[1]?.trim() ?? "";
    const skuCode    = row[3]?.trim() ?? "";
    const recipeCode = row[6]?.trim() ?? "";
    const maitreCode = row[7]?.trim() ?? "";
    const recipeName = row[5]?.trim() || row[4]?.trim() || "";

    const snapshots: Partial<Record<MaitreSnapshotLabel, number>> = {};
    for (let i = 0; i < SNAPSHOT_LABELS.length; i++) {
      const val = parseNum(row[9 + i]);
      if (val > 0) snapshots[SNAPSHOT_LABELS[i]] = val;
    }
    // "order" ist die letzte Spalte (Index 18, nach einer leeren bei Index 17 oder 18)
    const orderVal = parseNum(row[row.length - 1]);

    entries.push({ week, market, slot, recipeCode, maitreCode, skuCode, recipeName, snapshots, orderVolume: orderVal });
  }
  console.log(`  Maitre Inputs: ${entries.length} Einträge geparst`);
  return entries;
}

// ─── Parser: Produktionsvorbereitung_DE ──────────────────────────────────────

function parseProduktionsvorbereitungDE(dump: DumpFile): ProduktionsplanungEntry[] {
  const sheet = getSheet(dump, "Produktionsvorbereitung_DE");
  if (!sheet) { console.warn("  Tab 'Produktionsvorbereitung_DE' nicht gefunden"); return []; }

  const entries: ProduktionsplanungEntry[] = [];
  let currentEntry: ProduktionsplanungEntry | null = null;
  let boxVolFri = 0, boxVolMon = 0;

  for (const row of sheet.values) {
    // Zeile: "Box Volumen | 1717 | | 606 | 2323"
    if (row[0]?.trim() === "Box Volumen") {
      boxVolFri = parseNum(row[1]);
      boxVolMon = parseNum(row[3]);
      continue;
    }
    // Datensatz-Zeile: col 0 = "2026-W22"
    if (/^20\d{2}-W\d{1,2}$/.test(row[0]?.trim())) {
      const week = row[0].trim();
      if (!currentEntry || currentEntry.week !== week) {
        currentEntry = {
          week,
          market: "DE",
          boxVolRun1: boxVolFri,
          boxVolRun2: boxVolMon,
          maxKapaPerDay: 0,
          startTime: "09:00",
          endTime: "15:00",
          slots: [],
          generatedAt: dump.generatedAt,
        };
        entries.push(currentEntry);
      }
      const slotNum = parseInt(row[1], 10);
      if (!isNaN(slotNum)) {
        const s: ProduktionsplanungSlot = {
          slot: slotNum,
          maitreCode: row[2] === "#N/A" ? "" : (row[2]?.trim() ?? ""),
          recipeCode: row[3]?.trim() ?? "",
          skuCode:    row[4]?.trim() ?? "",
          recipeName: row[5]?.trim() ?? "",
          volRun1:    parseNum(row[6]),
          volRun2:    parseNum(row[7]),
          totalVol:   parseNum(row[8]),
          paletten:   row[9]?.trim() || undefined,
        };
        currentEntry.slots.push(s);
      }
    }
    // Max-Kapazität
    if (row.some(c => c?.trim() === "Max Kapa pro Tag:")) {
      const kapaIdx = row.findIndex(c => c?.trim() === "Max Kapa pro Tag:");
      const kapa = parseNum(row[kapaIdx + 1]);
      if (kapa > 0 && currentEntry) currentEntry.maxKapaPerDay = kapa;
    }
  }
  console.log(`  Produktionsvorbereitung DE: ${entries.length} Wochen, ${entries.reduce((n, e) => n + e.slots.length, 0)} Slots`);
  return entries;
}

// ─── Parser: Produktionsvorbereitung_Nordics ─────────────────────────────────

function parseProduktionsvorbereitungNordics(dump: DumpFile): ProduktionsplanungEntry[] {
  const sheet = getSheet(dump, "Produktionsvorbereitung_Nordics");
  if (!sheet) { console.warn("  Tab 'Produktionsvorbereitung_Nordics' nicht gefunden"); return []; }

  const entries: ProduktionsplanungEntry[] = [];
  let currentEntry: ProduktionsplanungEntry | null = null;
  let boxVolDK = 0, boxVolSE = 0;

  for (const row of sheet.values) {
    // "Box Volumen | | 1755 | 1622 | 3377"
    if (row[0]?.trim() === "Box Volumen") {
      boxVolDK = parseNum(row[2]);
      boxVolSE = parseNum(row[3]);
      continue;
    }
    if (/^20\d{2}-W\d{1,2}$/.test(row[0]?.trim())) {
      const week = row[0].trim();
      if (!currentEntry || currentEntry.week !== week) {
        currentEntry = {
          week,
          market: "NORDICS",
          boxVolRun1: boxVolDK,
          boxVolRun2: boxVolSE,
          maxKapaPerDay: 0,
          startTime: "09:00",
          endTime: "15:00",
          slots: [],
          generatedAt: dump.generatedAt,
        };
        entries.push(currentEntry);
      }
      const slotNum = parseInt(row[1], 10);
      if (!isNaN(slotNum)) {
        const s: ProduktionsplanungSlot = {
          slot: slotNum,
          maitreCode: row[2] === "#N/A" ? "" : (row[2]?.trim() ?? ""),
          recipeCode: row[3]?.trim() ?? "",
          skuCode:    row[4]?.trim() ?? "",
          recipeName: row[5]?.trim() ?? "",
          volRun1:    parseNum(row[6]),
          volRun2:    parseNum(row[7]),
          totalVol:   parseNum(row[8]),
          paletten:   row[9]?.trim() || undefined,
        };
        currentEntry.slots.push(s);
      }
    }
    if (row.some(c => c?.trim() === "Max Kapa pro Tag:")) {
      const kapaIdx = row.findIndex(c => c?.trim() === "Max Kapa pro Tag:");
      const kapa = parseNum(row[kapaIdx + 1]);
      if (kapa > 0 && currentEntry) currentEntry.maxKapaPerDay = kapa;
    }
  }
  console.log(`  Produktionsvorbereitung Nordics: ${entries.length} Wochen, ${entries.reduce((n, e) => n + e.slots.length, 0)} Slots`);
  return entries;
}

// ─── Parser: Logistik - FCMS Meals ──────────────────────────────────────────

function parseFcmsMeals(dump: DumpFile, currentWeek: string): FcmsInboundData {
  const sheet = getSheet(dump, "Logistik - FCMS Meals");
  if (!sheet) { console.warn("  Tab 'Logistik - FCMS Meals' nicht gefunden"); return { week: currentWeek, generatedAt: dump.generatedAt, rows: [] }; }

  const rows: FcmsInboundRow[] = [];
  for (const row of sheet.values) {
    if (row[0]?.trim() !== "VF") continue; // Nur Waren-Eingang-Zeilen (nicht Header)
    rows.push({
      poNumber:       row[1]?.trim() ?? "",
      unloadDateLocal: row[4]?.trim() ?? "",
      itemNumber:     row[5]?.trim() ?? "",
      description:    row[6]?.trim() ?? "",
      uom:            row[7]?.trim() ?? "",
      poExpected:     parseNum(row[12]),
      totalReceived:  parseNum(row[14]),
      variancePct:    row[15]?.trim() ?? "",
    });
  }
  console.log(`  FCMS Meals: ${rows.length} Inbound-Positionen geparst`);
  return { week: currentWeek, generatedAt: dump.generatedAt, rows };
}

// ─── Firestore Push ──────────────────────────────────────────────────────────

async function batchedSet(
  db: admin.firestore.Firestore,
  appRoot: admin.firestore.DocumentReference,
  collName: string,
  docs: { id: string; data: Record<string, unknown> }[]
) {
  if (docs.length === 0) return;
  const coll = appRoot.collection(collName);
  const CHUNK = 400;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch();
    for (const { id, data } of docs.slice(i, i + CHUNK)) {
      batch.set(coll.doc(id), data, { merge: true });
    }
    await batch.commit();
  }
  console.log(`  ✓ ${collName}: ${docs.length} Docs gepusht`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(KEY_FILE)) throw new Error(`Service-Account fehlt: ${KEY_FILE}`);

  const dump = await loadDump();

  // Aktuelle Woche aus Maitre Inputs ableiten (neueste im Dump)
  const maitreInputsSheet = getSheet(dump, "Maitre Inputs DE/NO_Stamm");
  const allWeeks = new Set<string>();
  for (const row of maitreInputsSheet?.values ?? []) {
    if ((row[0] === "DE" || row[0] === "NORDICS") && /^W\d{1,2}$/.test(row[1]?.trim())) {
      allWeeks.add(row[1].trim());
    }
  }
  const latestWeek = [...allWeeks].sort().at(-1) ?? "W22";
  const prodTab = getSheet(dump, "Produktionsvorbereitung_DE");
  let currentFullWeek = "2026-W22";
  for (const row of prodTab?.values ?? []) {
    if (/^20\d{2}-W\d{1,2}$/.test(row[0]?.trim())) { currentFullWeek = row[0].trim(); break; }
  }
  console.log(`Aktuelle KW: ${currentFullWeek} (Maitre: ${latestWeek})`);

  // Daten parsen
  console.log("\nParse Maitre Inputs …");
  const maitreEntries = parseMaitreInputs(dump);

  console.log("Parse Produktionsvorbereitung DE …");
  const prodDE = parseProduktionsvorbereitungDE(dump);

  console.log("Parse Produktionsvorbereitung Nordics …");
  const prodNO = parseProduktionsvorbereitungNordics(dump);

  console.log("Parse FCMS Inbound …");
  const fcms = parseFcmsMeals(dump, currentFullWeek);

  // Firestore init
  process.env.GOOGLE_APPLICATION_CREDENTIALS = KEY_FILE;
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  const appRoot = db.collection("apps").doc("rezeptlogik");

  // Push maitreRampup
  console.log(`\nPush maitreRampup (${maitreEntries.length}) …`);
  await batchedSet(db, appRoot, "maitreRampup", maitreEntries.map(e => ({
    id: `${e.week}__${e.market}__${e.recipeCode || e.maitreCode || e.slot}`,
    data: e as unknown as Record<string, unknown>,
  })));

  // Push produktionsplanung
  const allProd = [...prodDE, ...prodNO];
  console.log(`Push produktionsplanung (${allProd.length}) …`);
  await batchedSet(db, appRoot, "produktionsplanung", allProd.map(e => ({
    id: `${e.week}__${e.market}`,
    data: e as unknown as Record<string, unknown>,
  })));

  // Push fcmsInbound
  console.log(`Push fcmsInbound (${fcms.rows.length} rows) …`);
  await batchedSet(db, appRoot, "fcmsInbound", [{
    id: fcms.week,
    data: fcms as unknown as Record<string, unknown>,
  }]);

  console.log("\n✓ sync-fulfillment-report abgeschlossen");
}

main().catch(e => { console.error(e); process.exit(1); });
