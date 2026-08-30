import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { MealCatalogEntry } from "../../core/types";

// Manuelle Bild-Auswahl im Meal-Katalog — als app-weiter Store, damit dieselbe
// effektive Bildwahl ueberall gilt (Meal-Katalog-Detail UND Rezeptliste) und
// eine Aenderung im Katalog sofort in der Rezeptliste durchschlaegt.
//
// Quelle der Wahrheit ist die committete public/data/meal-image-overrides.json
// (schreibt der Bild-Picker ueber /api/meal-image-override + /api/save-meal-image,
// respektiert der Auto-Import in scripts/import-meal-database.ts). localStorage
// ist nur ein Sofort-Cache, damit die UI zwischen Reloads nicht flackert.

const STORAGE_KEY = "meal-catalog-image-overrides";
const FILE_URL = "/data/meal-image-overrides.json";

export type ImageOverride = { url: string } | { hidden: true };
type OverrideMap = Record<string, ImageOverride>;

/** Dateiformat { file } | { hidden } -> UI-Format { url } | { hidden }. */
type FileOverride = { file: string; driveRel?: string } | { hidden: true };
function fromFileFormat(raw: Record<string, FileOverride>): OverrideMap {
  const out: OverrideMap = {};
  for (const [mealId, v] of Object.entries(raw)) {
    if (v && "hidden" in v && v.hidden) out[mealId.toUpperCase()] = { hidden: true };
    else if (v && "file" in v && v.file) out[mealId.toUpperCase()] = { url: `/data/meal-images/${v.file}` };
  }
  return out;
}

function loadCache(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCache(map: OverrideMap) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

// ── Modul-Store ──────────────────────────────────────────────────────────────
// Ein einziger Store fuer die ganze App. Alle Consumer (Katalog-Detail,
// Rezeptliste) haengen per useSyncExternalStore daran; eine Mutation
// benachrichtigt sofort alle.
let state: OverrideMap = loadCache();
const listeners = new Set<() => void>();

function emit() { listeners.forEach(l => l()); }
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function getSnapshot(): OverrideMap { return state; }
function setState(next: OverrideMap) {
  state = next;
  saveCache(next);
  emit();
}

// Committete Datei einmalig nachladen (Datei gewinnt ueber den Cache).
let fileLoaded = false;
function ensureFileLoaded() {
  if (fileLoaded) return;
  fileLoaded = true;
  fetch(`${FILE_URL}?ts=${Date.now()}`, { cache: "no-store" })
    .then(r => (r.ok ? r.json() : {}))
    .then((raw: Record<string, FileOverride>) => {
      if (!raw || typeof raw !== "object") return;
      setState({ ...state, ...fromFileFormat(raw) });
    })
    .catch(() => { /* offline / prod ohne Datei -> Cache reicht */ });
}

// Aenderungen aus anderen Tabs uebernehmen.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    state = loadCache();
    emit();
  });
}

const fileName = (url: string) => url.split("/").pop() ?? "";

// Best-effort-Persistenz in die committete Datei (nur Dev-Server). In der
// deployten Read-only-Version schlaegt der Call fehl -> egal, dort wird eh nur
// gelesen; der Bild-Tausch passiert lokal + Deploy.
function persist(mealId: string, op: "confirm" | "hide" | "reset", file?: string) {
  const qs = new URLSearchParams({ mealId, op, ...(file ? { file } : {}) });
  void fetch(`/api/meal-image-override?${qs}`).catch(() => {});
}

function mutate(mealId: string, next: ImageOverride | null, op: "confirm" | "hide" | "reset", file?: string) {
  const key = mealId.toUpperCase();
  const map = { ...state };
  if (next === null) delete map[key];
  else map[key] = next;
  setState(map);
  persist(key, op, file);
}

// ── Pure Resolver ────────────────────────────────────────────────────────────
const IMAGE_URL_RE = /\.(png|jpe?g|webp|gif|avif)(\?|$)/i;
function isDisplayableImageUrl(url: string): boolean {
  return url.startsWith("/data/meal-images/") || url.startsWith("/api/drive-image") || IMAGE_URL_RE.test(url);
}

/**
 * Effektive Meal-Bild-URL: manuelle Auswahl im Katalog schlaegt den rohen
 * Katalog-Wert. `{ hidden }` -> bewusst kein Bild. Leere/ungueltige URL ->
 * undefined. Ein Aufrufer bekommt damit exakt das Bild, das der Meal-Katalog
 * zeigt.
 */
export function resolveMealPhotoUrl(
  entry: Pick<MealCatalogEntry, "photoUrl"> | undefined,
  override: ImageOverride | undefined,
): string | undefined {
  if (override && "hidden" in override) return undefined;
  const url = (override && "url" in override ? override.url : undefined) ?? entry?.photoUrl;
  return url && isDisplayableImageUrl(url) ? url : undefined;
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export function useImageOverrides() {
  const overrides = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(ensureFileLoaded, []);

  const confirm = useCallback((mealId: string, url: string) => {
    mutate(mealId, { url }, "confirm", fileName(url));
  }, []);

  const reject = useCallback((mealId: string) => {
    mutate(mealId, { hidden: true }, "hide");
  }, []);

  const reset = useCallback((mealId: string) => {
    mutate(mealId, null, "reset");
  }, []);

  const getOverride = useCallback(
    (mealId: string): ImageOverride | undefined => overrides[mealId.toUpperCase()],
    [overrides],
  );

  return { confirm, reject, reset, getOverride };
}
