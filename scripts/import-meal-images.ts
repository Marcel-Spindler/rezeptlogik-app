/**
 * Kopiert SA- (Schalen-) und Tray-Bilder aus dem lokalen Google-Drive-Ordner nach public/data/meal-images/.
 * Bevorzugung: _SA_*low > _SA_*high > _Tray_*low > _Tray_*high
 * Kein Fallback auf Teller/Bento-Bilder — Score < 4 wird übersprungen.
 *
 * Am Ende:
 * - Alle Dateien in public/data/meal-images/ die NICHT durch diesen Lauf kopiert wurden → gelöscht
 * - meal-catalog.json: photoUrl wird nur für tatsächlich vorhandene SA/Tray-Bilder gesetzt,
 *   alle anderen photoUrl-Einträge werden gelöscht (nicht geskippt, aktiv auf undefined gesetzt).
 */

import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { loadMealImageOverrides, isHidden, isPinned } from "./lib/mealImageOverrides.ts";

const SOURCE_DIR = "G:/.shortcut-targets-by-id/1tSHOPlJpN0vslaIY2JyAEa3gJQT603IF/Factor EU Meal Images";
const DEST_DIR = path.resolve("public/data/meal-images");
const CATALOG_PATH = path.resolve("public/data/meal-catalog.json");

// Die Drive-Originale sind 2–40 MB grosse Kamera-JPGs. Fuer die App (32px-Thumb
// bis Detailbild) reicht 1400px / q82 locker und spart ~90 % Deploy-/Ladegewicht.
const MAX_DIM = 1400;
const JPEG_QUALITY = 82;

async function writeResized(srcPath: string, destPath: string): Promise<void> {
  await sharp(srcPath, { failOn: "none" })
    .rotate()
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toFile(destPath);
}

// Manuell festgelegte Bild-Auswahl — gepinnte/ausgeblendete Meals fasst dieser
// Lauf NICHT an (weder Datei ersetzen noch photoUrl ändern noch aufräumen).
const OVERRIDES = loadMealImageOverrides();

function extractMealCode(folderName: string): string | null {
  const withLetter = folderName.match(/^([A-Z]{2}\d{4}[A-Z])/i);
  if (withLetter) return withLetter[1].toUpperCase();
  const noLetter = folderName.match(/^([A-Z]{2}\d{4})(?:\s|_|-|$)/i);
  if (noLetter) return noLetter[1].toUpperCase() + "A";
  return null;
}

function scoreFile(filename: string): number {
  const lower = filename.toLowerCase();
  const isSA = lower.includes("_sa_") || lower.includes("_sa ") || lower.endsWith("_sa_low.jpg") || lower.endsWith("_sa_high.jpg");
  const isTray = lower.includes("_tray_");
  const isLow = lower.includes("low");
  if (isSA && isLow) return 10;
  if (isSA && !isLow) return 8;
  if (isTray && isLow) return 6;
  if (isTray && !isLow) return 4;
  return 1;
}

function findBestImage(dir: string): string | null {
  let best: { score: number; filePath: string } | null = null;
  function scan(d: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fullPath = path.join(d, e.name);
      if (e.isDirectory()) {
        scan(fullPath);
      } else if (/\.(jpg|jpeg)$/i.test(e.name)) {
        const score = scoreFile(e.name);
        if (!best || score > best.score) {
          best = { score, filePath: fullPath };
        }
      }
    }
  }
  scan(dir);
  // Nur SA- oder Tray-Bilder (score >= 4) — kein Fallback auf Bento/Plated
  if (!best || best.score < 4) return null;
  return best.filePath;
}

async function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error("Quellordner nicht gefunden:", SOURCE_DIR);
    process.exit(1);
  }
  if (!fs.existsSync(DEST_DIR)) fs.mkdirSync(DEST_DIR, { recursive: true });

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  if (!catalog.mealCatalog) catalog.mealCatalog = {};

  const mealDirs = fs.readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  let copied = 0, skipped = 0, noSA = 0, pinned = 0;
  const copiedCodes = new Set<string>();
  // Gepinnte/ausgeblendete Meals gelten als "behandelt" → Aufräum-Schritt fasst
  // ihre Datei/photoUrl nicht an.
  const protectedCodes = new Set(Object.keys(OVERRIDES).map((c) => c.toUpperCase()));

  for (const dirName of mealDirs) {
    const code = extractMealCode(dirName);
    if (!code) { console.log(`  ⚠ Kein Code erkannt: "${dirName}"`); skipped++; continue; }

    if (OVERRIDES[code]) {
      console.log(`  ⏻ Manuell festgelegt, übersprungen: ${code}`);
      pinned++;
      continue;
    }

    const mealDir = path.join(SOURCE_DIR, dirName);
    const best = findBestImage(mealDir);
    if (!best) {
      console.log(`  ○ Kein SA/Tray-Bild: ${code}`);
      noSA++;
      continue;
    }

    const destPath = path.join(DEST_DIR, `${code}.jpg`);
    await writeResized(best, destPath);
    console.log(`  ✓ ${code} ← ${path.basename(best)}`);
    copied++;
    copiedCodes.add(code);

    if (!catalog.mealCatalog[code]) {
      catalog.mealCatalog[code] = { mealId: code, photoUrl: `/data/meal-images/${code}.jpg`, sheets: {} };
    } else {
      catalog.mealCatalog[code].photoUrl = `/data/meal-images/${code}.jpg`;
    }
  }

  // ── Bereinigung: Alle Bilddateien löschen die NICHT aus diesem Lauf stammen ──
  // (manuell festgelegte Meals ausgenommen)
  const existingFiles = fs.readdirSync(DEST_DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  let deleted = 0;
  for (const filename of existingFiles) {
    const code = filename.replace(/\.(jpe?g|png|webp)$/i, "").toUpperCase();
    if (!copiedCodes.has(code) && !protectedCodes.has(code)) {
      fs.unlinkSync(path.join(DEST_DIR, filename));
      console.log(`  🗑 Gelöscht (kein SA/Tray): ${filename}`);
      deleted++;
    }
  }

  // ── Bereinigung: photoUrl aus Katalog entfernen wenn kein Bild vorhanden ──
  // Gepinnte behalten ihr Bild; ausgeblendete ("hidden") bleiben ohne photoUrl.
  let cleared = 0;
  for (const [code, entry] of Object.entries(catalog.mealCatalog) as [string, Record<string, unknown>][]) {
    const ov = OVERRIDES[code.toUpperCase()];
    if (isPinned(ov)) {
      if (fs.existsSync(path.join(DEST_DIR, ov.file))) entry.photoUrl = `/data/meal-images/${ov.file}`;
      continue;
    }
    if (isHidden(ov)) { if (entry.photoUrl) { delete entry.photoUrl; cleared++; } continue; }
    if (entry.photoUrl && !copiedCodes.has(code)) {
      delete entry.photoUrl;
      cleared++;
    }
  }

  catalog.generatedAt = new Date().toISOString();
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2), "utf8");

  console.log(`\nFertig:`);
  console.log(`  ${copied} SA/Tray-Bilder kopiert`);
  console.log(`  ${pinned} manuell festgelegte Meals übersprungen`);
  console.log(`  ${deleted} alte/falsche Bilder gelöscht`);
  console.log(`  ${cleared} photoUrl-Einträge aus Katalog entfernt`);
  console.log(`  ${skipped} Ordner ohne erkennbaren Code`);
  console.log(`  ${noSA} Ordner ohne SA/Tray-Bild (übersprungen)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
