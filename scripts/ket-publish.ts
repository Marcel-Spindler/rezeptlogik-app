// scripts/ket-publish.ts
// ─────────────────────────────────────────────────────────────────────────────
// KET-CSV → fehlende Kochanweisungen erzeugen → je WO ein PDF → sortiert in Google
// Drive ablegen.
//
//   npm run ket:publish -- "C:\Users\…\Downloads\KET-W37.csv"
//   npm run ket:publish                 (nimmt die neueste KET*.csv in ~/Downloads)
//
// Ablage (Wurzel aus KET_DRIVE_ROOT, gemountetes Drive-Laufwerk):
//   <KET_DRIVE_ROOT>/W37-Gemini/<Protein|Veggie>/<Mo 08.09.>/WO_37-101_FV....pdf
//
// Fallback ohne Laufwerk-Mount: KET_DRIVE_API=1 → Upload via Drive-API mit dem
// Writer-Service-Account (KET_DRIVE_CREDENTIALS bzw. FIRESTORE_WRITER_CREDENTIALS).
// KET_DRIVE_FOLDER_ID = Ziel-(Shared-)Drive/-Ordner (Default: der von Marcel
// genannte Ordner).
//
// Idempotent: gleiche WO → gleicher Pfad + Dateiname → wird überschrieben, nie
// dupliziert. Danach räumt der Lauf jede WO_*.pdf in den bearbeiteten
// "W<nn>-Gemini"-Ordnern weg, die er NICHT geschrieben hat (WO in anderen Tag/
// Station verschoben oder aus dem Plan raus) — `--no-prune` schaltet das ab.
// Der KET-Export kann nur die KOMPLETTE Woche liefern (kein Delta), deshalb ist
// „alles neu rendern + Reste wegräumen" der richtige Modus.
// Bereits in Firestore (apps/rezeptlogik/woInstructions) vorhandene Anweisungen
// werden wiederverwendet (exakter cacheKey + unscharfer Fallback), nur wirklich
// fehlende gehen an Gemini und werden zurückgeschrieben — die Web-App sieht sie
// dann auch.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import admin from "firebase-admin";
import { chromium } from "@playwright/test";
import { PDFDocument } from "pdf-lib";
import { google } from "googleapis";

import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";
import {
  generateGeminiInstructionBatch,
} from "./lib/gemini-instruction.mjs";

import type { DataBundle, EquipBibleEntry } from "../src/core/types.ts";
import type { BatchCalc, KetRow, WoComponent, WoInstruction } from "../src/features/ket-plan/ketTypes.ts";
import { EQUIP_DEFAULTS } from "../src/features/ket-plan/ketTypes.ts";
import {
  buildFuzzyInstructionIndex,
  calcBatch,
  classifyDeboxDepartment,
  EMPTY_GN_HINTS,
  fuzzyInstructionKey,
  instructionCacheKey,
  parseDateShift,
  parseKetCsv,
  type GnHints,
} from "../src/features/ket-plan/ketLogic.ts";
import { buildPdf } from "../src/features/ket-plan/ketPdf.ts";
import { buildWoInstructionContext } from "../src/features/ket-plan/woInstructionBot.ts";
import { wrBuildHintsFromDumps } from "../src/features/kitchen-mode/wrEquipmentHints.ts";
import { weekPrefixFromWoNumber } from "../src/features/wms-overview/wmsWeeks.ts";

// ── Konfiguration ────────────────────────────────────────────────────────────
const ROOT = resolve(".");
const BUNDLE_PATH = join(ROOT, "public", "data", "data.json");
const BIBLES_DUMP_PATH = join(ROOT, "public", "data", "gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json");
const A4 = { width: 595.28, height: 841.89 };
const WEEK_SUFFIX = "-Gemini";
const DOW = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const DEFAULT_DRIVE_FOLDER_ID = "0AE8ZxqLyfnjxUk9PVA";

const USE_DRIVE_API = process.env.KET_DRIVE_API === "1";
const DRIVE_ROOT = process.env.KET_DRIVE_ROOT ?? "";
const DRIVE_FOLDER_ID = process.env.KET_DRIVE_FOLDER_ID ?? DEFAULT_DRIVE_FOLDER_ID;
// Trockenlauf: keine Gemini-Aufrufe, keine Firestore-Schreibvorgänge — nur
// vorhandene Anweisungen lesen + PDFs rendern/ablegen. Zum Prüfen von Layout &
// Ordnerstruktur, ohne Kontingent/Firestore zu berühren.
const DRY_RUN = process.env.KET_DRY_RUN === "1" || process.argv.includes("--dry-run");
// Nach dem Lauf in den bearbeiteten "W<nn>-Gemini"-Ordnern jede WO_*.pdf löschen,
// die dieser Lauf NICHT geschrieben hat (WO in anderen Tag/Station verschoben oder
// aus dem Plan raus). Standard an — der KET-Export enthält immer die ganze Woche,
// also spiegelt der Ordner danach exakt den aktuellen Plan. `--no-prune` schaltet
// es ab. Wochen mit Render-/Upload-Fehler werden nie aufgeräumt.
const NO_PRUNE = process.env.KET_NO_PRUNE === "1" || process.argv.includes("--no-prune");

const INSTRUCTIONS_COLLECTION = ["apps", "rezeptlogik", "woInstructions"] as const;

// ── Hilfsfunktionen ─────────────────────────────────────────────────────────
function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function findLatestKetCsv(): string | null {
  const dl = join(homedir(), "Downloads");
  if (!existsSync(dl)) return null;
  const cands = readdirSync(dl)
    .filter((f) => /^KET.*\.csv$/i.test(f))
    .map((f) => ({ f: join(dl, f), t: statSync(join(dl, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return cands[0]?.f ?? null;
}

// Windows/Google-Drive-FUSE erlauben keine Namen, die auf "." oder Leerzeichen
// enden, und keine der reservierten Zeichen < > : " / \ | ? *.
function sanitizeSegment(name: string): string {
  return (name || "")
    .replace(/[<>:"/\\|?*]+/g, "_")
    .replace(/[^\wäöüßÄÖÜ.\- ]+/gi, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 80)
    .replace(/[. ]+$/g, "");
}

function encodeInstructionKey(cacheKey: string): string {
  return cacheKey.replace(/\//g, "__");
}

function weekFolder(row: KetRow): string {
  const n = weekPrefixFromWoNumber(row.woNumber);
  return n != null ? `W${n}${WEEK_SUFFIX}` : `Wunbekannt${WEEK_SUFFIX}`;
}

function dayFolder(row: KetRow): string {
  const { date } = parseDateShift(row.dateNeeded);
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "ohne Datum";
  // Kein abschließender Punkt — Windows/Drive-FUSE verbieten das (z.B. "Mo 08.09").
  return `${DOW[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function stationFolder(calc: BatchCalc): "Protein" | "Veggie" {
  // classifyDeboxDepartment: "protein" | "veggie" | null (RTI). RTI → Veggie.
  return classifyDeboxDepartment(calc) === "protein" ? "Protein" : "Veggie";
}

function woFileName(row: KetRow): string {
  const parts = [`WO_${row.woNumber}`];
  if (row.recipeCode) parts.push(row.recipeCode);
  parts.push(row.subRecipeName || row.recipeName);
  return `${sanitizeSegment(parts.join("_"))}.pdf`;
}

const relKey = (root: string, abs: string) => relative(root, abs).split(sep).join("/");
const IS_WO_PDF = /^WO_.*\.pdf$/i;

// Entfernt in einem "W<nn>-Gemini"-Ordner alle WO_*.pdf, die dieser Lauf nicht
// geschrieben hat, und danach leere Unterordner. Nur Dateien mit WO_-Präfix —
// alles andere im Ordner bleibt unangetastet.
function pruneStaleWeek(root: string, weekDirName: string, keep: Set<string>): string[] {
  const removed: string[] = [];
  const weekDir = join(root, weekDirName);
  if (!existsSync(weekDir)) return removed;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        try {
          if (readdirSync(p).filter((n) => n.toLowerCase() !== "desktop.ini").length === 0) {
            rmSync(p, { recursive: true, force: true });
          }
        } catch { /* Drive-FUSE zickt gelegentlich beim rmdir — nicht fatal */ }
      } else if (IS_WO_PDF.test(e.name) && !keep.has(relKey(root, p))) {
        try { rmSync(p, { force: true }); removed.push(relKey(root, p)); } catch { /* s.o. */ }
      }
    }
  };
  walk(weekDir);
  return removed;
}

// Drive-API-Pendant: veraltete WO_*.pdf unter den (per folderCache bekannten)
// Wochen-Unterordnern löschen.
async function pruneStaleWeekDrive(
  drive: DriveClient,
  folderCache: Map<string, string>,
  weekDirName: string,
  keep: Set<string>,
): Promise<string[]> {
  const removed: string[] = [];
  for (const [path, folderId] of folderCache) {
    if (path !== weekDirName && !path.startsWith(`${weekDirName}/`)) continue;
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "files(id,name)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (f.name && IS_WO_PDF.test(f.name) && !keep.has(`${path}/${f.name}`)) {
        await drive.files.delete({ fileId: f.id!, supportsAllDrives: true });
        removed.push(`${path}/${f.name}`);
      }
    }
  }
  return removed;
}

// ── Ziel-Ermittlung (WO bzw. je Komponente) — spiegelt generationTargetsForRow /
//    resolveInstructionsFromCache aus KetBreakdownView, aber cacheKey-basiert. ──
interface InstrTarget {
  row: KetRow;
  calc: BatchCalc;
  component?: WoComponent;
  cacheKey: string;
  runtimeKey: string; // Schlüssel, unter dem buildPdf die Anweisung erwartet
}

function targetsForRow(row: KetRow, calc: BatchCalc): InstrTarget[] {
  if (calc.components.length > 0) {
    const seen = new Set<string>();
    const out: InstrTarget[] = [];
    for (const component of calc.components) {
      if (seen.has(component.name)) continue;
      seen.add(component.name);
      out.push({
        row, calc, component,
        cacheKey: instructionCacheKey(row, component.name),
        runtimeKey: `${row.key}::${component.name}`,
      });
    }
    // Zusätzlich die evtl. vorhandene WO-weite Gesamt-/Zusammenbau-Anweisung
    // (nie neu generiert — nur aus dem Cache/Harvest gerendert; buildPdf zeigt
    // sie als "Gesamt-/Zusammenbau-Anweisung" über den Komponenten).
    out.push({ row, calc, cacheKey: instructionCacheKey(row), runtimeKey: row.key });
    return out;
  }
  return [{ row, calc, cacheKey: instructionCacheKey(row), runtimeKey: row.key }];
}

// ── Firestore ───────────────────────────────────────────────────────────────
async function loadFirestoreInstructions(db: admin.firestore.Firestore): Promise<Record<string, WoInstruction>> {
  const snap = await db.collection(INSTRUCTIONS_COLLECTION.join("/")).get();
  const cache: Record<string, WoInstruction> = {};
  snap.forEach((d) => {
    const data = d.data() as WoInstruction & { cacheKey?: string };
    const key = data.cacheKey ?? d.id;
    if (data.english && data.german) {
      cache[key] = { english: data.english, german: data.german, status: data.status, generatedAt: data.generatedAt, model: data.model };
    }
  });
  return cache;
}

async function saveFirestoreInstructions(
  db: admin.firestore.Firestore,
  entries: Array<[string, WoInstruction]>,
): Promise<void> {
  for (let i = 0; i < entries.length; i += 400) {
    const chunk = entries.slice(i, i + 400);
    const batch = db.batch();
    for (const [cacheKey, instruction] of chunk) {
      const ref = db.collection(INSTRUCTIONS_COLLECTION.join("/")).doc(encodeInstructionKey(cacheKey));
      batch.set(ref, { ...instruction, cacheKey }, { merge: true });
    }
    await batch.commit();
  }
}

async function loadEquipmentBible(db: admin.firestore.Firestore): Promise<EquipBibleEntry[] | undefined> {
  try {
    const doc = await db.collection("apps/rezeptlogik/equipmentBible").doc("current").get();
    const rows = (doc.data()?.rows ?? []) as EquipBibleEntry[];
    const clean = rows.filter((r) =>
      r && (r.source === "BRAISER" || r.source === "MIDDLE_KITCHEN" || r.source === "VEGGIE_DEBOX")
      && typeof r.itemName === "string" && typeof r.maxKg === "number" && Number.isFinite(r.maxKg) && r.maxKg > 0);
    return clean.length ? clean : undefined;
  } catch (e) {
    console.warn(`  ⚠ equipmentBible nicht ladbar (${e instanceof Error ? e.message : e}) — nutze Standard-Kapazitäten.`);
    return undefined;
  }
}

function loadGnHints(): GnHints {
  try {
    if (!existsSync(BIBLES_DUMP_PATH)) return EMPTY_GN_HINTS;
    const bibles = JSON.parse(readFileSync(BIBLES_DUMP_PATH, "utf8"));
    const { trayHints, pieceWeightKg } = wrBuildHintsFromDumps(null, bibles);
    return { trayHints, pieceWeightKg };
  } catch {
    return EMPTY_GN_HINTS;
  }
}

// ── PDF ─────────────────────────────────────────────────────────────────────
async function renderWoPdf(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  row: KetRow,
  calcMap: Map<string, BatchCalc>,
  woInstructions: Record<string, WoInstruction>,
): Promise<Buffer> {
  const html = buildPdf([row], calcMap, EQUIP_DEFAULTS, `WO ${row.woNumber}`, "CSV", woInstructions);
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    let pdf = Buffer.from(await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "8mm", right: "8mm", bottom: "8mm", left: "8mm" },
    }));
    // Gerade Seitenzahl erzwingen: ein Sammel-Duplex-Druck legt so nie zwei WOs
    // auf ein Blatt (eine WO = ein Zettel; lange WO darf auf Seite 2 laufen).
    const doc = await PDFDocument.load(pdf);
    if (doc.getPageCount() % 2 === 1) {
      doc.addPage([A4.width, A4.height]);
      pdf = Buffer.from(await doc.save());
    }
    return pdf;
  } finally {
    await page.close();
  }
}

// ── Drive-API-Fallback ──────────────────────────────────────────────────────
type DriveClient = ReturnType<typeof google.drive>;

async function driveFindOrCreateFolder(drive: DriveClient, parentId: string, name: string): Promise<string> {
  const q = `'${parentId}' in parents and name = ${JSON.stringify(name)} and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const found = await drive.files.list({ q, fields: "files(id)", supportsAllDrives: true, includeItemsFromAllDrives: true });
  const hit = found.data.files?.[0]?.id;
  if (hit) return hit;
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
    supportsAllDrives: true,
  });
  return created.data.id!;
}

async function driveUpsertPdf(drive: DriveClient, folderId: string, name: string, body: Buffer): Promise<void> {
  const { Readable } = await import("node:stream");
  const q = `'${folderId}' in parents and name = ${JSON.stringify(name)} and trashed = false`;
  const found = await drive.files.list({ q, fields: "files(id)", supportsAllDrives: true, includeItemsFromAllDrives: true });
  const existing = found.data.files?.[0]?.id;
  const media = { mimeType: "application/pdf", body: Readable.from(body) };
  if (existing) {
    await drive.files.update({ fileId: existing, media, supportsAllDrives: true });
  } else {
    await drive.files.create({ requestBody: { name, parents: [folderId] }, media, fields: "id", supportsAllDrives: true });
  }
}

function makeDrive(): DriveClient {
  const keyFile = process.env.KET_DRIVE_CREDENTIALS
    ?? process.env.FIRESTORE_WRITER_CREDENTIALS
    ?? process.env.GOOGLE_APPLICATION_CREDENTIALS
    ?? "./secrets/service-account.json";
  const auth = new google.auth.GoogleAuth({
    keyFile: resolve(keyFile),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

// Prüft, ob der Service Account in den Ziel-Drive-Ordner schreiben darf.
async function checkDriveAccess(): Promise<void> {
  const drive = makeDrive();
  try {
    const res = await drive.files.get({
      fileId: DRIVE_FOLDER_ID,
      fields: "id,name,driveId,capabilities/canAddChildren",
      supportsAllDrives: true,
    });
    const canWrite = res.data.capabilities?.canAddChildren;
    console.log(`Drive-Ordner: "${res.data.name}" (${res.data.id})`);
    console.log(res.data.driveId ? `Shared Drive: ${res.data.driveId}` : "kein Shared Drive (persönlicher Ordner)");
    if (canWrite) {
      console.log("✓ Service Account darf hier Ordner/Dateien anlegen.");
    } else {
      fail("Service Account hat KEIN Schreibrecht — als \"Inhaltsverwalter\"/Content-Manager freigeben.");
    }
  } catch (e) {
    fail(`Kein Zugriff auf ${DRIVE_FOLDER_ID}: ${e instanceof Error ? e.message : e}\n`
      + "→ Ordner mit dem Service-Account-Konto teilen (siehe README / .env.example).");
  }
}

// ── Hauptablauf ─────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes("--check-drive")) {
    if (!USE_DRIVE_API) fail("--check-drive braucht KET_DRIVE_API=1.");
    await checkDriveAccess();
    return;
  }
  const csvArg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const csvPath = csvArg ? resolve(csvArg) : findLatestKetCsv();
  if (!csvPath || !existsSync(csvPath)) {
    fail(csvArg ? `KET-CSV nicht gefunden: ${csvArg}` : "Keine KET*.csv im Downloads-Ordner gefunden. Pfad als Argument angeben.");
  }
  // Trockenlauf schreibt IMMER nur nach ./scratch/ket-publish — nie an das echte
  // Ziel (Drive-Mount oder API), auch wenn KET_DRIVE_ROOT/-API gesetzt sind.
  const scratchRoot = join(ROOT, "scratch", "ket-publish");
  const driveApi = USE_DRIVE_API && !DRY_RUN;
  const localRoot = DRY_RUN ? scratchRoot : DRIVE_ROOT;
  if (!driveApi && !localRoot) {
    fail("KET_DRIVE_ROOT nicht gesetzt (lokaler Drive-Mount-Pfad). Oder KET_DRIVE_API=1 für Upload via API.");
  }
  if (!driveApi && !DRY_RUN && !existsSync(localRoot)) {
    fail(`KET_DRIVE_ROOT existiert nicht: ${localRoot}`);
  }
  if (DRY_RUN) mkdirSync(scratchRoot, { recursive: true });
  if (!existsSync(BUNDLE_PATH)) {
    fail(`${BUNDLE_PATH} fehlt — 'npm run import:local' (bzw. sync:all) ausführen.`);
  }

  console.log(`KET-Publish${DRY_RUN ? "  [TROCKENLAUF]" : ""}\n  CSV:    ${csvPath}\n  Ziel:   ${driveApi ? `Drive-API (Ordner ${DRIVE_FOLDER_ID})` : localRoot}\n`);

  // Firestore
  configureFirestoreWriterAuth();
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  // Daten
  const bundle = JSON.parse(readFileSync(BUNDLE_PATH, "utf8")) as DataBundle;
  bundle.equipmentBible = await loadEquipmentBible(db);
  const gnHints = loadGnHints();

  const { rows, warnings } = parseKetCsv(readFileSync(csvPath, "utf8"));
  if (warnings.length) warnings.slice(0, 5).forEach((w) => console.warn(`  ⚠ ${w}`));
  if (!rows.length) fail("Keine gültigen WO-Zeilen im CSV.");
  console.log(`  ${rows.length} WOs im CSV.\n`);

  // Berechnungen
  const calcMap = new Map<string, BatchCalc>();
  for (const row of rows) calcMap.set(row.key, calcBatch(row, EQUIP_DEFAULTS, bundle, undefined, undefined, gnHints));

  // Anweisungen: vorhandene aus Firestore, fehlende erzeugen
  const fsCache = await loadFirestoreInstructions(db);
  const fuzzyIndex = buildFuzzyInstructionIndex(fsCache);
  const woInstructions: Record<string, WoInstruction> = {};
  const missing: InstrTarget[] = [];

  for (const row of rows) {
    const calc = calcMap.get(row.key)!;
    for (const t of targetsForRow(row, calc)) {
      const hit = fsCache[t.cacheKey] ?? fuzzyIndex.get(fuzzyInstructionKey(t.row, t.component?.name));
      if (hit) woInstructions[t.runtimeKey] = hit;
      // Die WO-weite Gesamt-Anweisung eines zusammengesetzten Sub-Rezepts wird
      // NUR gerendert, wenn sie im Cache/Harvest liegt — nie neu per Gemini
      // erzeugt (eine vermischte WO-Anweisung wäre irreführend).
      else if (!(calc.components.length > 0 && !t.component)) missing.push(t);
    }
  }

  const totalTargets = Object.keys(woInstructions).length + missing.length;
  console.log(`  Kochanweisungen: ${totalTargets - missing.length} aus Firestore, ${missing.length} fehlen.`);

  if (missing.length && DRY_RUN) {
    console.log(`  [Trockenlauf] ${missing.length} fehlende Anweisungen werden NICHT erzeugt.\n`);
  } else if (missing.length) {
    console.log(`  → erzeuge ${missing.length} via Gemini …`);
    const items = missing.map((t) => ({ key: t.cacheKey, context: buildWoInstructionContext(t.row, t.calc, t.component) }));
    const results = await generateGeminiInstructionBatch(items) as Record<string, { ok: boolean; instruction?: WoInstruction; error?: string }>;
    const toSave: Array<[string, WoInstruction]> = [];
    let genOk = 0, genFail = 0;
    for (const t of missing) {
      const r = results[t.cacheKey];
      if (r?.ok && r.instruction) {
        woInstructions[t.runtimeKey] = r.instruction;
        toSave.push([t.cacheKey, r.instruction]);
        genOk++;
      } else {
        genFail++;
        console.warn(`    ✗ WO ${t.row.woNumber}${t.component ? ` · ${t.component.name}` : ""}: ${r?.error ?? "unbekannt"}`);
      }
    }
    if (toSave.length) await saveFirestoreInstructions(db, toSave);
    console.log(`  ${genOk} erzeugt & in Firestore gesichert${genFail ? `, ${genFail} fehlgeschlagen` : ""}.\n`);
  } else {
    console.log("");
  }

  // PDFs rendern + ablegen
  const drive = driveApi ? makeDrive() : null;
  const folderCache = new Map<string, string>(); // API: Pfad → folderId
  const browser = await chromium.launch({ headless: true });
  const perFolder = new Map<string, number>();
  const writtenRel = new Set<string>();       // "W37-Gemini/Veggie/Mo 31.08/WO_….pdf"
  const touchedWeeks = new Set<string>();      // "W37-Gemini"
  const weeksWithErr = new Set<string>();
  let written = 0, errors = 0;

  try {
    for (const row of rows) {
      const calc = calcMap.get(row.key)!;
      const segs = [weekFolder(row), stationFolder(calc), dayFolder(row)];
      const fileName = woFileName(row);
      touchedWeeks.add(segs[0]);
      try {
        const pdf = await renderWoPdf(browser, row, calcMap, woInstructions);
        if (drive) {
          let parent = DRIVE_FOLDER_ID;
          let acc = "";
          for (const seg of segs) {
            acc = acc ? `${acc}/${seg}` : seg;
            let id = folderCache.get(acc);
            if (!id) { id = await driveFindOrCreateFolder(drive, parent, seg); folderCache.set(acc, id); }
            parent = id;
          }
          await driveUpsertPdf(drive, parent, fileName, pdf);
        } else {
          // Ordner Ebene für Ebene anlegen — auf dem Google-Drive-FUSE-Laufwerk
          // ist rekursives mkdir in einem Rutsch unzuverlässig.
          let dir = localRoot;
          for (const seg of segs) {
            dir = join(dir, seg);
            if (!existsSync(dir)) mkdirSync(dir);
          }
          writeFileSync(join(dir, fileName), pdf);
        }
        const key = segs.join("/");
        writtenRel.add(`${key}/${fileName}`);
        perFolder.set(key, (perFolder.get(key) ?? 0) + 1);
        written++;
        process.stdout.write(`\r  ${written}/${rows.length} PDFs …   `);
      } catch (e) {
        errors++;
        weeksWithErr.add(segs[0]);
        console.warn(`\n  ✗ WO ${row.woNumber}: ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n\nFertig: ${written} PDFs geschrieben${errors ? `, ${errors} Fehler` : ""}.`);
  for (const [folder, n] of [...perFolder.entries()].sort()) console.log(`  ${folder}  →  ${n}`);

  // Veraltete WO-PDFs entfernen — der KET-Export enthält immer die ganze Woche,
  // danach spiegelt der Ordner exakt den aktuellen Plan (keine Doppel/Reste).
  if (!NO_PRUNE) {
    const stale: string[] = [];
    for (const week of touchedWeeks) {
      if (weeksWithErr.has(week)) {
        console.warn(`  ⚠ ${week}: wegen Fehlern NICHT aufgeräumt.`);
        continue;
      }
      stale.push(...(drive
        ? await pruneStaleWeekDrive(drive, folderCache, week, writtenRel)
        : pruneStaleWeek(localRoot, week, writtenRel)));
    }
    if (stale.length) {
      console.log(`\n  ${stale.length} veraltete PDF(s) entfernt (WO verschoben/aus Plan raus):`);
      for (const s of stale) console.log(`    − ${s}`);
    }
  }
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
