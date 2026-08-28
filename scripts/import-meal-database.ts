import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { google } from "googleapis";
import type { MealCatalogEntry } from "../src/core/types.ts";
import {
  loadMealImageOverrides, isHidden, isPinned, materializePinnedOverride,
} from "./lib/mealImageOverrides.ts";

const DEFAULT_FILE = "C:\\Users\\MarcelSpindler\\Downloads\\F_EU_Verden Meal Database_v1_March 2026.xlsx";
const DEFAULT_IMAGE_DIR = "G:\\.shortcut-targets-by-id\\1tSHOPlJpN0vslaIY2JyAEa3gJQT603IF\\Factor EU Meal Images";
const SOURCE_SHEETS = [
  "Verden Meal Database",
  "Meal DB_Product",
  "Meal DB_Culinary",
  "Meal DB_Nutrition",
  "NL",
  "FR",
  "DE",
  "DKSE",
] as const;

function valueOf(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object" && "result" in value) return valueOf(value.result as ExcelJS.CellValue);
  if (typeof value === "object" && "richText" in value) return value.richText.map(part => part.text).join("").trim();
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  return String(value).trim();
}

function hyperlinkOf(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (typeof value === "object" && value && "hyperlink" in value && typeof value.hyperlink === "string") return value.hyperlink;
  return cell.hyperlink ?? valueOf(value);
}

function driveId(url: string): { id: string; kind: "file" | "folder" } | undefined {
  const match = /drive\.google\.com\/drive\/(folders|u\/\d+\/folders|file\/d)\/([^/?#]+)/i.exec(url)
    ?? /drive\.google\.com\/file\/d\/([^/?#]+)/i.exec(url);
  if (!match) return undefined;
  const isFolder = /folders/i.test(match[1] ?? "");
  return { id: match[2] ?? match[1], kind: isFolder ? "folder" : "file" };
}

function extensionFor(name: string, mimeType: string): string {
  const ext = extname(name).toLowerCase();
  if (ext && /^\.(jpe?g|png|webp|gif|avif)$/i.test(ext)) return ext;
  return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif" } as Record<string, string>)[mimeType] ?? ".jpg";
}

type DriveImage = { id: string; name: string; mimeType: string };

type LocalImage = { path: string; name: string; size: number };

function imageScore(image: LocalImage): number {
  const name = image.name.toLowerCase();
  let score = 0;
  if (/(main|meal|plated|hero|web)/.test(name)) score += 100;
  if (/\blow\b|_low/.test(name)) score += 40;
  if (/(tray|\bsa\b|side)/.test(name)) score -= 30;
  if (/(high|print)/.test(name)) score -= 10;
  // Prefer a compact image even when the naming convention ties.
  score -= Math.min(30, Math.round(image.size / 5_000_000));
  return score;
}

function collectLocalImages(root: string): Map<string, LocalImage[]> {
  const byDigits = new Map<string, LocalImage[]>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(entry.name)) continue;
      const matches = `${path} ${entry.name}`.matchAll(/F[EV](\d{4,5})[A-Z0-9]*/gi);
      const digits = new Set(Array.from(matches, match => match[1]));
      for (const key of digits) {
        const images = byDigits.get(key) ?? [];
        images.push({ path, name: entry.name, size: statSync(path).size });
        byDigits.set(key, images);
      }
    }
  };
  if (existsSync(root)) visit(root);
  return byDigits;
}

const MAX_AUTO_IMAGE_BYTES = 12 * 1024 * 1024;

function mirrorLocalImage(images: Map<string, LocalImage[]>, mealId: string, outputDir: string): string | undefined {
  const digits = /(\d{4,5})/.exec(mealId)?.[1];
  const candidates = digits ? images.get(digits) : undefined;
  if (!candidates?.length) return undefined;
  // Riesige "high"/Export-Bilder (30 MB+) nur nehmen, wenn es nichts Kleineres gibt —
  // für die Auto-Wahl reicht die Web-Auflösung, den Rest pinnt Marcel im Picker.
  const pool = candidates.some(c => c.size <= MAX_AUTO_IMAGE_BYTES)
    ? candidates.filter(c => c.size <= MAX_AUTO_IMAGE_BYTES)
    : candidates;
  const image = [...pool].sort((a, b) => imageScore(b) - imageScore(a) || a.size - b.size)[0];
  const extension = extname(image.name).toLowerCase();
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(image.path, resolve(outputDir, `${mealId}${extension}`));
  return `/data/meal-images/${mealId}${extension}`;
}

class DriveImageMirror {
  private readonly outputDir = resolve("public", "data", "meal-images");
  private readonly cache = new Map<string, string | undefined>();
  private drive?: ReturnType<typeof google.drive>;

  private async getDrive() {
    if (this.drive) return this.drive;
    const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
    this.drive = google.drive({ version: "v3", auth: await auth.getClient() as any });
    return this.drive;
  }

  async mirror(sourceUrl: string, mealId: string): Promise<string | undefined> {
    const source = driveId(sourceUrl);
    if (!source) return undefined;
    const cached = this.cache.get(source.id);
    if (cached !== undefined || this.cache.has(source.id)) return cached;

    try {
      const drive = await this.getDrive();
      let image: DriveImage | undefined;
      if (source.kind === "folder") {
        const response = await drive.files.list({
          q: `'${source.id}' in parents and trashed = false and mimeType contains 'image/'`,
          fields: "files(id,name,mimeType,createdTime)",
          orderBy: "createdTime desc",
          pageSize: 1,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        image = response.data.files?.[0] as DriveImage | undefined;
      } else {
        const response = await drive.files.get({ fileId: source.id, fields: "id,name,mimeType", supportsAllDrives: true });
        image = response.data as DriveImage;
      }
      if (!image?.id || !image.mimeType?.startsWith("image/")) throw new Error("Keine Bilddatei gefunden");

      const binary = await drive.files.get({ fileId: image.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
      mkdirSync(this.outputDir, { recursive: true });
      const path = resolve(this.outputDir, `${mealId}${extensionFor(image.name, image.mimeType)}`);
      writeFileSync(path, Buffer.from(binary.data as ArrayBuffer));
      const localUrl = `/data/meal-images/${mealId}${extensionFor(image.name, image.mimeType)}`;
      this.cache.set(source.id, localUrl);
      return localUrl;
    } catch (error: any) {
      console.warn(`  Meal-Bild ${mealId} nicht gespiegelt: ${error?.message ?? error}`);
      this.cache.set(source.id, undefined);
      return undefined;
    }
  }
}

const MEAL_ID_RE = /^[A-Z]{2}\d{4,5}[A-Z0-9]*$/i;

// Findet Header-Zeile + Meal-ID-Spalte (1-basiert).
// Primär: Zelle mit Text "Meal ID". Fallback: falls die Kopfzelle im Sheet
// kaputt ist (z. B. versehentlich auf eine Zahl überschrieben, wie im
// "Meal DB_Nutrition"-Tab gesehen), gilt die Zeile als Header, ab der eine der
// ersten Spalten fortlaufend Meal-ID-Codes enthält.
function findHeader(sheet: ExcelJS.Worksheet): { row: number; mealIdCol: number } | undefined {
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 8); rowNumber++) {
    const values = sheet.getRow(rowNumber).values as ExcelJS.CellValue[];
    const textIdx = values.findIndex(value => /^meal\s*id$/i.test(valueOf(value)));
    if (textIdx >= 1) return { row: rowNumber, mealIdCol: textIdx };

    for (let col = 1; col <= 3; col++) {
      const self = valueOf(sheet.getRow(rowNumber).getCell(col).value);
      if (MEAL_ID_RE.test(self)) continue; // diese Zeile ist selbst schon Daten
      const below = [rowNumber + 1, rowNumber + 2]
        .map(r => valueOf(sheet.getRow(r).getCell(col).value))
        .filter(Boolean);
      if (below.length > 0 && below.every(v => MEAL_ID_RE.test(v))) {
        return { row: rowNumber, mealIdCol: col };
      }
    }
  }
  return undefined;
}

function headersOf(sheet: ExcelJS.Worksheet, headerRow: number): string[] {
  const values = sheet.getRow(headerRow).values as ExcelJS.CellValue[];
  const used = new Map<string, number>();
  return Array.from({ length: sheet.columnCount }, (_, index) => {
    const label = valueOf(values[index + 1]) || `Column ${index + 1}`;
    const count = (used.get(label) ?? 0) + 1;
    used.set(label, count);
    return count === 1 ? label : `${label} (${count})`;
  });
}

/**
 * Loads all meal metadata from the downloaded Verden Meal Database workbook.
 * The catalog retains every populated source column, including localization and
 * legal-label data, keyed by its original sheet name.
 */
export async function loadMealDatabase(file = process.env.MEAL_DATABASE_XLSX?.trim() || DEFAULT_FILE): Promise<Record<string, MealCatalogEntry>> {
  const path = resolve(file);
  if (!existsSync(path)) {
    console.warn(`  Meal Database: XLSX nicht gefunden (${path})`);
    return {};
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const catalog: Record<string, MealCatalogEntry> = {};
  const imageMirror = new DriveImageMirror();
  const imageOutputDir = resolve("public", "data", "meal-images");
  const localImageDir = process.env.MEAL_IMAGES_DIR?.trim() || DEFAULT_IMAGE_DIR;
  const localImages = collectLocalImages(localImageDir);
  console.log(`  Meal-Bilder lokal: ${[...localImages.values()].reduce((total, images) => total + images.length, 0)} Dateien für ${localImages.size} Rezeptnummern gefunden`);
  let localImageMatches = 0;

  // Manuell festgelegte Bild-Auswahl (Picker in der App) — hat Vorrang vor der
  // Auto-Score-Heuristik und wird hier NIE überschrieben.
  const imageOverrides = loadMealImageOverrides();
  const overrideCount = Object.keys(imageOverrides).length;
  if (overrideCount) console.log(`  Bild-Overrides: ${overrideCount} Meals manuell festgelegt (werden nicht auto-gewählt)`);
  let overrideApplied = 0;

  for (const sheetName of SOURCE_SHEETS) {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) continue;
    const header = findHeader(sheet);
    if (!header) {
      console.warn(`  Meal Database: Header "Meal ID" fehlt in "${sheetName}"`);
      continue;
    }
    const headerRow = header.row;

    const headers = headersOf(sheet, headerRow);
    const mealIdIndex = header.mealIdCol - 1;
    if (!/^meal\s*id$/i.test(headers[mealIdIndex] ?? "")) headers[mealIdIndex] = "Meal ID";
    let imported = 0;

    for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const mealId = valueOf(row.getCell(mealIdIndex + 1).value);
      if (!/^[A-Z]{2}\d{4,5}[A-Z0-9]*$/i.test(mealId)) continue;

      const fields: Record<string, string> = {};
      for (let column = 1; column <= headers.length; column++) {
        const value = valueOf(row.getCell(column).value);
        if (value) fields[headers[column - 1]] = value;
      }
      if (Object.keys(fields).length === 1) continue;

      const entry = catalog[mealId] ??= { mealId, sheets: {} };
      entry.sheets[sheetName] = fields;
      const instructionFields = Object.entries(fields).filter(([key, value]) =>
        /instruction|koch|anweisung/i.test(key) && value.trim(),
      );
      if (instructionFields.length > 0) {
        entry.instructionsBySubRecipe ??= {};
        const english = instructionFields.find(([key]) => /english|\ben\b/i.test(key))?.[1]
          ?? instructionFields.find(([key]) => !/german|deutsch|\bde\b/i.test(key))?.[1];
        const german = instructionFields.find(([key]) => /german|deutsch|\bde\b/i.test(key))?.[1];
        const instructionName = fields["Sub Recipe Name"] || fields["Sub-Recipe Name"] || fields["Subrecipe Name"] || sheetName;
        const instructionId = fields["Sub Recipe ID"] || fields["Sub-Recipe ID"];
        entry.instructionsBySubRecipe[`${instructionId || instructionName}::${sheetName}`] = {
          subRecipeName: instructionName,
          subRecipeId: instructionId,
          english,
          german,
          germanIsFallback: !german && !!english,
        };
      }
      if (sheetName === "Meal DB_Culinary") {
        const sourceUrl = hyperlinkOf(row.getCell(headers.indexOf("Photo Link") + 1));
        if (sourceUrl) entry.photoSourceUrl = sourceUrl;

        const override = imageOverrides[mealId.toUpperCase()];
        if (isHidden(override)) {
          delete entry.photoUrl;                    // bewusst kein Bild
          overrideApplied++;
        } else if (isPinned(override)) {
          const pinned = materializePinnedOverride(override, mealId, localImageDir, copyFileSync);
          if (pinned) { entry.photoUrl = pinned; localImageMatches++; overrideApplied++; }
          else console.warn(`  Bild-Override für ${mealId} nicht auffindbar (file="${override.file}", driveRel="${override.driveRel ?? ""}")`);
        } else if (sourceUrl) {
          entry.photoUrl = mirrorLocalImage(localImages, mealId, imageOutputDir)
            ?? await imageMirror.mirror(sourceUrl, mealId)
            ?? sourceUrl;
          if (entry.photoUrl.startsWith("/data/meal-images/")) localImageMatches++;
        }
      }
      imported++;
    }
    console.log(`  Meal Database: ${imported} Meals aus "${sheetName}" importiert`);
  }

  console.log(`  Meal Database: ${Object.keys(catalog).length} eindeutige Meals, ${Object.values(catalog).filter(entry => entry.photoUrl).length} mit Photo Link, ${localImageMatches} lokale Bilder verknüpft${overrideApplied ? `, ${overrideApplied} manuelle Overrides angewandt` : ""}`);
  return catalog;
}

async function main() {
  const catalog = await loadMealDatabase();
  const outputPath = resolve("public", "data", "meal-catalog.json");
  mkdirSync(resolve("public", "data"), { recursive: true });
  writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), mealCatalog: catalog }));
  console.log(`✓ ${outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exit(1); });
}