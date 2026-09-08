// scripts/ket-harvest-instructions.ts
// ─────────────────────────────────────────────────────────────────────────────
// Erntet die ECHTEN Factor-Kochanweisungen aus den Wochen-PDFs ("Recipes
// <Tag> <Datum>.pdf") und legt sie in den Firestore-Instruction-Cache
// (apps/rezeptlogik/woInstructions), sodass die App sie direkt zieht statt sie
// per Gemini zu approximieren.
//
//   npm run ket:harvest -- --dir "C:\…\Rezept daten" --dry-run
//   npm run ket:harvest -- --dir "C:\…\Rezept daten"            (schreibt Firestore)
//   npm run ket:harvest -- --dir "…" --purge-gemini             (vorher alle
//                                                                Nicht-manual/
//                                                                Nicht-factor-pdf
//                                                                Einträge löschen)
//
// Schlüssel = `recipeCode::subRecipeName[::componentName]` (identisch zu
// ketLogic.instructionCacheKey) — wochenunabhängig, damit wiederkehrende
// Gerichte über Wochen hinweg getroffen werden.
//
// PDF-Text: `pdftotext -enc UTF-8 -nopgbrk` (DEFAULT-Modus, nicht -layout).
// Reihenfolge der Dateien: italienische Varianten zuerst, dann nach mtime
// aufsteigend → der neuste (deutsche) Stand einer Woche gewinnt; ein späteres
// REWORK überschreibt.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import admin from "firebase-admin";

import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";
import { parseFactorRecipePdfText, type FactorInstruction } from "../src/features/ket-plan/factorInstructionParse.ts";
import type { WoInstruction } from "../src/features/ket-plan/ketTypes.ts";

const INSTRUCTIONS_COLLECTION = "apps/rezeptlogik/woInstructions";
const DEFAULT_DIR = "C:\\Users\\MarcelSpindler\\OneDrive - HelloFresh Group\\Desktop\\Rezept daten";
const ROOT = resolve(".");
const SCRATCH = join(ROOT, "scratch", "ket-harvest");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run") || process.env.KET_HARVEST_DRY === "1";
const PURGE_GEMINI = argv.includes("--purge-gemini");
const dirArg = ((): string => {
  const i = argv.indexOf("--dir");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : (process.env.KET_HARVEST_DIR ?? DEFAULT_DIR);
})();

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// `pdftotext` liegt unter Windows meist in Git-for-Windows' mingw64/bin und ist
// NICHT auf dem Node-PATH. Reihenfolge: KET_PDFTOTEXT → PATH → bekannte Pfade.
function resolvePdftotext(): string {
  // Absolute Pfade: existsSync reicht. `pdftotext -v` beendet mit Code 99
  // (xpdf) → taugt nicht als Probe.
  const paths = [
    process.env.KET_PDFTOTEXT,
    "C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe",
    "C:\\Program Files (x86)\\Git\\mingw64\\bin\\pdftotext.exe",
    `${process.env.LOCALAPPDATA ?? ""}\\Programs\\Git\\mingw64\\bin\\pdftotext.exe`,
    "/usr/bin/pdftotext",
    "/opt/homebrew/bin/pdftotext",
    "/usr/local/bin/pdftotext",
  ].filter(Boolean) as string[];
  for (const p of paths) {
    try { if (existsSync(p)) return p; } catch { /* nächster */ }
  }
  // Bare command über PATH — nur ENOENT bedeutet "fehlt".
  try {
    execFileSync("pdftotext", [], { stdio: "ignore" });
    return "pdftotext";
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return "pdftotext";
  }
  fail("`pdftotext` nicht gefunden. poppler-utils/xpdf installieren oder KET_PDFTOTEXT=<pfad> setzen.");
}
const PDFTOTEXT = resolvePdftotext();

function encodeInstructionKey(cacheKey: string): string {
  return cacheKey.replace(/\//g, "__");
}

function cacheKeyOf(e: FactorInstruction): string {
  const base = `${e.recipeCode}::${e.subRecipeName}`.trim();
  return e.componentName ? `${base}::${e.componentName}` : base;
}

// ZIPs im Quellordner (Google-Drive-Download liefert je KW ein .zip) in einen
// Temp-Ordner entpacken, damit sie mitgeerntet werden. Gibt die Extra-Suchpfade
// zurück; Aufräumen via `cleanup()`.
let zipTmp: string | null = null;
function unzipOne(zip: string, dest: string): void {
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath ${JSON.stringify(zip)} -DestinationPath ${JSON.stringify(dest)} -Force`],
      { stdio: "ignore" });
  } else {
    execFileSync("unzip", ["-o", "-q", zip, "-d", dest]);
  }
}
function extractZips(dir: string): string[] {
  const zips = readdirSync(dir).filter((f) => /\.zip$/i.test(f));
  if (!zips.length) return [];
  zipTmp = join(tmpdir(), `ket-harvest-${Date.now()}`);
  mkdirSync(zipTmp, { recursive: true });
  let ok = 0;
  for (const z of zips) {
    try { unzipOne(join(dir, z), zipTmp); ok++; }
    catch (e) { console.warn(`  ⚠ ${z}: ${e instanceof Error ? e.message : e}`); }
  }
  console.log(`  ${ok}/${zips.length} ZIP(s) entpackt → ${zipTmp}`);
  return [zipTmp];
}
function cleanup() {
  if (zipTmp) { try { rmSync(zipTmp, { recursive: true, force: true }); } catch { /* egal */ } }
}

// Rekursiv alle Recipe-PDFs sammeln; Allergen-Listen raus.
function collectPdfs(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!/\.pdf$/i.test(entry.name)) continue;
      if (/^Allerg|Allergen List|Allergeni/i.test(entry.name)) continue;
      out.push(p);
    }
  };
  for (const d of dirs) walk(d);
  return out;
}

// Sortier-Priorität: italienische Tagesnamen zuerst (werden von deutschen
// überschrieben), dann nach mtime aufsteigend (neuster gewinnt), REWORK zuletzt.
const IT_DAYS = /\b(Luned[iì]|Marted[iì]|Mercoled[iì]|Gioved[iì]|Venerd[iì]|Sabato|Domenica)\b/i;
function sortForHarvest(files: string[]): string[] {
  return files
    .map((f) => ({ f, mtime: statSync(f).mtimeMs, it: IT_DAYS.test(f) ? 0 : 1, rework: /REWORK/i.test(f) ? 1 : 0 }))
    .sort((a, b) => a.it - b.it || a.rework - b.rework || a.mtime - b.mtime)
    .map((x) => x.f);
}

function pdfToText(pdfPath: string): string {
  try {
    return execFileSync(PDFTOTEXT, ["-enc", "UTF-8", "-nopgbrk", pdfPath, "-"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    console.warn(`  ⚠ pdftotext fehlgeschlagen für ${pdfPath}: ${e instanceof Error ? e.message : e}`);
    return "";
  }
}

async function main() {
  if (!existsSync(dirArg)) fail(`Ordner nicht gefunden: ${dirArg}`);
  console.log(`KET-Harvest${DRY_RUN ? "  [TROCKENLAUF]" : ""}\n  Quelle: ${dirArg}\n  pdftotext: ${PDFTOTEXT}\n`);

  const searchDirs = [dirArg, ...extractZips(dirArg)];
  const files = sortForHarvest(collectPdfs(searchDirs));
  if (!files.length) { cleanup(); fail("Keine Recipe-PDFs gefunden (auch nicht in ZIPs)."); }
  console.log(`  ${files.length} PDF(s).`);

  // Ernten: letzter Schreiber je cacheKey gewinnt (Dateireihenfolge = Priorität).
  const harvested = new Map<string, WoInstruction & { cacheKey: string; woNumber: string }>();
  let totalEntries = 0;
  const perFile: Array<{ file: string; entries: number }> = [];
  for (const file of files) {
    const rel = file.split(sep).slice(-2).join("/");
    const text = pdfToText(file);
    if (!text.trim()) { perFile.push({ file: rel, entries: 0 }); continue; }
    let entries: FactorInstruction[] = [];
    try {
      entries = parseFactorRecipePdfText(text, rel);
    } catch (e) {
      console.warn(`  ⚠ Parser-Fehler in ${rel}: ${e instanceof Error ? e.message : e}`);
    }
    perFile.push({ file: rel, entries: entries.length });
    for (const e of entries) {
      if (!e.recipeCode || !e.subRecipeName || (!e.english && !e.german)) continue;
      const cacheKey = cacheKeyOf(e);
      harvested.set(cacheKey, {
        cacheKey,
        woNumber: e.woNumber,
        english: e.english,
        german: e.german,
        status: "generated",
        source: "factor-pdf",
        sourceFile: rel,
        generatedAt: new Date().toISOString(),
      });
      totalEntries++;
    }
  }

  console.log(`  ${totalEntries} Anweisungs-Segmente geparst → ${harvested.size} eindeutige Rezept/Sub-Schlüssel.\n`);

  // Report + JSON-Dump immer.
  mkdirSync(SCRATCH, { recursive: true });
  const dump = [...harvested.values()].sort((a, b) => a.cacheKey.localeCompare(b.cacheKey));
  writeFileSync(join(SCRATCH, "harvest.json"), JSON.stringify(dump, null, 2), "utf8");
  writeFileSync(
    join(SCRATCH, "harvest-keys.txt"),
    dump.map((d) => `${d.cacheKey}\t(${d.woNumber}, ${d.sourceFile})`).join("\n"),
    "utf8",
  );
  writeFileSync(
    join(SCRATCH, "harvest-per-file.txt"),
    perFile.map((p) => `${String(p.entries).padStart(4)}  ${p.file}`).join("\n"),
    "utf8",
  );
  console.log(`  Dump: ${join("scratch", "ket-harvest", "harvest.json")} (+ harvest-keys.txt, harvest-per-file.txt)`);

  if (DRY_RUN) {
    console.log("\n  [Trockenlauf] Nichts nach Firestore geschrieben.");
    console.log("  Stichprobe (3):");
    for (const d of dump.slice(0, 3)) {
      console.log(`\n  ── ${d.cacheKey}`);
      console.log(d.english.split("\n").map((l) => `     ${l}`).join("\n"));
    }
    cleanup();
    return;
  }

  // ── Firestore ─────────────────────────────────────────────────────────────
  configureFirestoreWriterAuth();
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const col = db.collection(INSTRUCTIONS_COLLECTION);

  // Bestehende Einträge laden (für Merge-Politik + optionales Purge).
  const snap = await col.get();
  const existing = new Map<string, { source?: string }>();
  snap.forEach((doc) => existing.set(doc.id, doc.data() as { source?: string }));

  if (PURGE_GEMINI) {
    const toDelete = [...existing.entries()].filter(([, d]) => d.source !== "manual" && d.source !== "factor-pdf");
    console.log(`  --purge-gemini: ${toDelete.length} Nicht-manual/Nicht-factor-pdf-Einträge löschen …`);
    for (let i = 0; i < toDelete.length; i += 400) {
      const batch = db.batch();
      for (const [id] of toDelete.slice(i, i + 400)) batch.delete(col.doc(id));
      await batch.commit();
    }
  }

  const writes = [...harvested.values()].filter((w) => {
    const cur = existing.get(encodeInstructionKey(w.cacheKey));
    return cur?.source !== "manual"; // handbearbeitete nie überschreiben
  });
  const skippedManual = harvested.size - writes.length;
  console.log(`  ${writes.length} schreiben${skippedManual ? `, ${skippedManual} manuell bearbeitete übersprungen` : ""} …`);
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + 400)) {
      const { cacheKey, woNumber, ...rest } = w;
      void woNumber;
      batch.set(col.doc(encodeInstructionKey(cacheKey)), { ...rest, cacheKey }, { merge: true });
    }
    await batch.commit();
    process.stdout.write(`\r  ${Math.min(i + 400, writes.length)}/${writes.length}`);
  }
  console.log(`\n\n✓ Fertig. ${writes.length} Factor-Anweisungen in Firestore.`);
  cleanup();
}

main().catch((e) => { cleanup(); fail(e instanceof Error ? (e.stack ?? e.message) : String(e)); });
