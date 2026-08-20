import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PlatingRunDisplay, RedzoneRun, RedzoneStatusResponse } from "./redzoneTypes";

const POLL_MS = 60_000;

function extractMealCode(name: string): string | null {
  const match = name.match(/\b(F[A-Z]\d{4}[A-Z])\b/);
  return match ? match[1] : null;
}

function durationMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return ms > 0 ? Math.round(ms / 60_000) : null;
}

function enrichRun(run: RedzoneRun): PlatingRunDisplay {
  // Ovens/Braisers melden outCount praktisch nie (immer 0) — dort ist endTime
  // das einzig verlässliche Signal. Für Plating zählt zusätzlich "noch kein
  // Output", weil ein Run dort schon vor dem ersten gezählten Stück beginnt.
  const isActive = run.areaName === "Plating"
    ? run.endTime === null || run.outCount === 0 || run.outCount === null
    : run.endTime === null;
  return {
    ...run,
    status: isActive ? "active" : "completed",
    mealCode: extractMealCode(run.productTypeName),
    durationMin: durationMinutes(run.startTime, run.endTime),
  };
}

export interface RedzoneState {
  runs: PlatingRunDisplay[];
  platingNow: Map<string, PlatingRunDisplay>;
  platingDone: PlatingRunDisplay[];
  cookingNow: PlatingRunDisplay[];
  totalPlated: number;
  activeLineCount: number;
  loading: boolean;
  error: string | null;
  lastUpdate: string | null;
  secondsUntilRefresh: number;
  isPlatingNow: (recipeCode: string) => boolean;
  refresh: () => void;
  setHours: (h: number) => void;
  hours: number;
}

const RedzoneContext = createContext<RedzoneState | null>(null);

export function useRedzone(): RedzoneState {
  const ctx = useContext(RedzoneContext);
  if (!ctx) throw new Error("useRedzone must be used within RedzoneProvider");
  return ctx;
}

export function useRedzoneOptional(): RedzoneState | null {
  return useContext(RedzoneContext);
}

export function RedzoneProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<PlatingRunDisplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [countdown, setCountdown] = useState(POLL_MS / 1000);
  const timerRef = useRef<number | null>(null);
  const countdownRef = useRef<number | null>(null);

  const fetchStatus = async (h: number) => {
    try {
      const res = await fetch(`/api/redzone-plating-status?hours=${h}`, { cache: "no-store" });
      const data: RedzoneStatusResponse = await res.json().catch(() => ({ ok: false }) as RedzoneStatusResponse);
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setRuns(data.rows.map(enrichRun));
      setLastUpdate(data.generatedAt);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const refresh = () => {
    setCountdown(POLL_MS / 1000);
    void fetchStatus(hours);
  };

  useEffect(() => {
    let disposed = false;
    void fetchStatus(hours);
    timerRef.current = window.setInterval(() => {
      if (!disposed) {
        setCountdown(POLL_MS / 1000);
        void fetchStatus(hours);
      }
    }, POLL_MS);
    countdownRef.current = window.setInterval(() => {
      if (!disposed) setCountdown(prev => Math.max(0, prev - 1));
    }, 1000);
    return () => {
      disposed = true;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      if (countdownRef.current !== null) window.clearInterval(countdownRef.current);
    };
  }, [hours]);

  const derived = useMemo(() => {
    const plating = runs.filter(r => r.areaName === "Plating");
    const active = plating.filter(r => r.status === "active");
    const done = plating.filter(r => r.status === "completed");
    const cooking = runs.filter(r => r.areaName !== "Plating" && r.status === "active");
    const total = done.reduce((sum, r) => sum + (r.outCount ?? 0), 0);

    const nowMap = new Map<string, PlatingRunDisplay>();
    for (const r of active) {
      if (r.mealCode) nowMap.set(r.mealCode, r);
      const sku = r.productTypeSKU;
      if (sku) nowMap.set(sku, r);
    }

    const activeLines = new Set(active.map(r => r.locationName)).size;

    return { platingNow: nowMap, platingDone: done, cookingNow: cooking, totalPlated: total, activeLineCount: activeLines };
  }, [runs]);

  const isPlatingNow = (recipeCode: string): boolean => {
    if (!recipeCode) return false;
    if (derived.platingNow.has(recipeCode)) return true;
    for (const [, run] of derived.platingNow) {
      if (run.productTypeName.includes(recipeCode)) return true;
    }
    return false;
  };

  const value: RedzoneState = {
    runs,
    ...derived,
    loading,
    error,
    lastUpdate,
    secondsUntilRefresh: countdown,
    isPlatingNow,
    refresh,
    setHours,
    hours,
  };

  return <RedzoneContext.Provider value={value}>{children}</RedzoneContext.Provider>;
}
