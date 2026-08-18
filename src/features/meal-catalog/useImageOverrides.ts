import { useCallback, useState, useEffect } from "react";

const STORAGE_KEY = "meal-catalog-image-overrides";

export type ImageOverride = { url: string } | { hidden: true };
type OverrideMap = Record<string, ImageOverride>;

function load(): OverrideMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function save(map: OverrideMap) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function useImageOverrides() {
  const [overrides, setOverrides] = useState<OverrideMap>(load);

  useEffect(() => { save(overrides); }, [overrides]);

  const confirm = useCallback((mealId: string, url: string) => {
    setOverrides(prev => ({ ...prev, [mealId]: { url } }));
  }, []);

  const reject = useCallback((mealId: string) => {
    setOverrides(prev => ({ ...prev, [mealId]: { hidden: true } }));
  }, []);

  const reset = useCallback((mealId: string) => {
    setOverrides(prev => {
      const next = { ...prev };
      delete next[mealId];
      return next;
    });
  }, []);

  const getOverride = useCallback((mealId: string): ImageOverride | undefined => {
    return overrides[mealId];
  }, [overrides]);

  return { confirm, reject, reset, getOverride };
}
