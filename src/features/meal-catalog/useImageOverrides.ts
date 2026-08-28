import { useCallback, useState, useEffect } from "react";

// Manuelle Bild-Auswahl im Meal-Katalog.
//
// Quelle der Wahrheit ist die committete public/data/meal-image-overrides.json
// (wird vom Bild-Picker über /api/meal-image-override + /api/save-meal-image
// geschrieben und vom Auto-Import respektiert). localStorage ist nur ein
// Sofort-Cache, damit die UI zwischen Reloads nicht flackert.

const STORAGE_KEY = "meal-catalog-image-overrides";
const FILE_URL = "/data/meal-image-overrides.json";

export type ImageOverride = { url: string } | { hidden: true };
type OverrideMap = Record<string, ImageOverride>;

/** Dateiformat { file } | { hidden } → UI-Format { url } | { hidden }. */
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

const fileName = (url: string) => url.split("/").pop() ?? "";

// Best-effort-Persistenz in die committete Datei (nur Dev-Server). In der
// deployten Read-only-Version schlägt der Call fehl → egal, dort wird eh nur
// gelesen; der Bild-Tausch passiert lokal + Deploy.
function persist(mealId: string, op: "confirm" | "hide" | "reset", file?: string) {
  const qs = new URLSearchParams({ mealId, op, ...(file ? { file } : {}) });
  void fetch(`/api/meal-image-override?${qs}`).catch(() => {});
}

export function useImageOverrides() {
  const [overrides, setOverrides] = useState<OverrideMap>(loadCache);

  // Committete Datei nachladen und über den Cache legen (Datei gewinnt).
  useEffect(() => {
    let cancelled = false;
    fetch(`${FILE_URL}?ts=${Date.now()}`, { cache: "no-store" })
      .then(r => (r.ok ? r.json() : {}))
      .then((raw: Record<string, FileOverride>) => {
        if (cancelled || !raw || typeof raw !== "object") return;
        setOverrides(prev => {
          const merged = { ...prev, ...fromFileFormat(raw) };
          saveCache(merged);
          return merged;
        });
      })
      .catch(() => { /* offline / prod ohne Datei → Cache reicht */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { saveCache(overrides); }, [overrides]);

  const confirm = useCallback((mealId: string, url: string) => {
    const key = mealId.toUpperCase();
    setOverrides(prev => ({ ...prev, [key]: { url } }));
    persist(key, "confirm", fileName(url));
  }, []);

  const reject = useCallback((mealId: string) => {
    const key = mealId.toUpperCase();
    setOverrides(prev => ({ ...prev, [key]: { hidden: true } }));
    persist(key, "hide");
  }, []);

  const reset = useCallback((mealId: string) => {
    const key = mealId.toUpperCase();
    setOverrides(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    persist(key, "reset");
  }, []);

  const getOverride = useCallback((mealId: string): ImageOverride | undefined => {
    return overrides[mealId.toUpperCase()];
  }, [overrides]);

  return { confirm, reject, reset, getOverride };
}
