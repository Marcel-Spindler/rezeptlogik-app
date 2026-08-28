// Manuelle Meal-Bild-Auswahl — dauerhafte, committete Quelle der Wahrheit.
//
// Der Auto-Import (import-meal-database, import-meal-images) wählt Bilder per
// Score-Heuristik. Wo die Heuristik daneben liegt, pinnt der Bild-Picker in der
// App das richtige Bild hier fest. Der Import respektiert diese Datei und fasst
// gepinnte / ausgeblendete Meals NICHT mehr an.
//
// Bewusst ohne Fremd-Deps (nur node:fs / node:path), damit sowohl die
// tsx-Skripte als auch vite.config.ts das importieren können.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Auf ein bestimmtes Bild festgelegt. */
export interface PinnedImageOverride {
  /** Dateiname in public/data/meal-images/ (z. B. "FV4075A.jpg"). */
  file: string;
  /** Pfad des Quellbilds relativ zum Drive-Bildordner, mit "/" getrennt.
   *  Erlaubt dem Import, die exakte Wahl neu zu materialisieren. Optional. */
  driveRel?: string;
}

/** Für dieses Meal ist bewusst KEIN Bild gewünscht. */
export interface HiddenImageOverride {
  hidden: true;
}

export type MealImageOverride = PinnedImageOverride | HiddenImageOverride;
export type MealImageOverrideMap = Record<string, MealImageOverride>;

export const MEAL_IMAGE_OVERRIDES_PATH = resolve("public", "data", "meal-image-overrides.json");
export const MEAL_IMAGES_DIR = resolve("public", "data", "meal-images");

export function isHidden(o: MealImageOverride | undefined): o is HiddenImageOverride {
  return !!o && "hidden" in o && o.hidden === true;
}
export function isPinned(o: MealImageOverride | undefined): o is PinnedImageOverride {
  return !!o && "file" in o && typeof o.file === "string" && o.file.length > 0;
}

export function loadMealImageOverrides(path = MEAL_IMAGE_OVERRIDES_PATH): MealImageOverrideMap {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: MealImageOverrideMap = {};
    for (const [mealId, value] of Object.entries(raw as Record<string, unknown>)) {
      const key = mealId.trim().toUpperCase();
      if (!key) continue;
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>;
        if (v.hidden === true) out[key] = { hidden: true };
        else if (typeof v.file === "string" && v.file) {
          out[key] = { file: v.file, ...(typeof v.driveRel === "string" && v.driveRel ? { driveRel: v.driveRel } : {}) };
        }
      }
    }
    return out;
  } catch {
    console.warn("  meal-image-overrides.json konnte nicht gelesen werden — ignoriere.");
    return {};
  }
}

export function saveMealImageOverrides(map: MealImageOverrideMap, path = MEAL_IMAGE_OVERRIDES_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  // Sortiert schreiben → stabile Diffs.
  const sorted: MealImageOverrideMap = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

/** Lädt, mutiert einen Eintrag, speichert. `null` löscht den Eintrag. */
export function setMealImageOverride(mealId: string, override: MealImageOverride | null, path = MEAL_IMAGE_OVERRIDES_PATH): MealImageOverrideMap {
  const map = loadMealImageOverrides(path);
  const key = mealId.trim().toUpperCase();
  if (!key) return map;
  if (override === null) delete map[key];
  else map[key] = override;
  saveMealImageOverrides(map, path);
  return map;
}

/** "a/b/c.jpg" → betriebssystem-korrekter absoluter Pfad unter `driveDir`. */
export function resolveDriveRel(driveDir: string, driveRel: string): string {
  return join(driveDir, ...driveRel.split("/").filter(Boolean));
}

/** Absoluter Drive-Pfad → "/"-getrennter Pfad relativ zu `driveDir` (für driveRel). */
export function toDriveRel(driveDir: string, absPath: string): string {
  const rel = resolve(absPath).slice(resolve(driveDir).length).replace(/^[\\/]+/, "");
  return rel.split(sep).join("/");
}

/**
 * Materialisiert einen gepinnten Override in public/data/meal-images/ und gibt
 * die photoUrl zurück ("/data/meal-images/…"), oder undefined wenn nichts
 * Brauchbares gefunden wurde.
 */
export function materializePinnedOverride(
  override: PinnedImageOverride,
  mealId: string,
  driveDir: string,
  copyFileSync: (src: string, dest: string) => void,
): string | undefined {
  // 1) Wenn die exakte Quelle noch im Drive-Ordner liegt: neu kopieren.
  if (override.driveRel) {
    const src = resolveDriveRel(driveDir, override.driveRel);
    if (existsSync(src)) {
      const ext = (src.match(/\.[a-z0-9]+$/i)?.[0] ?? ".jpg").toLowerCase();
      const destName = `${mealId}${ext}`;
      mkdirSync(MEAL_IMAGES_DIR, { recursive: true });
      copyFileSync(src, join(MEAL_IMAGES_DIR, destName));
      return `/data/meal-images/${destName}`;
    }
  }
  // 2) Sonst: die bereits committete Datei behalten, falls vorhanden.
  if (override.file && existsSync(join(MEAL_IMAGES_DIR, override.file))) {
    return `/data/meal-images/${override.file}`;
  }
  return undefined;
}
