import { useEffect, useRef, useState } from "react";
import type { RedzoneRun, RedzoneStatusResponse, PlatingRunDisplay } from "./redzoneTypes";

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
  const isActive = run.endTime === null || run.outCount === 0 || run.outCount === null;
  return {
    ...run,
    status: isActive ? "active" : "completed",
    mealCode: extractMealCode(run.productTypeName),
    durationMin: durationMinutes(run.startTime, run.endTime),
  };
}

export function useRedzoneStatus(hours = 24) {
  const [runs, setRuns] = useState<PlatingRunDisplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;

    const fetchStatus = async () => {
      try {
        const res = await fetch(`/api/redzone-plating-status?hours=${hours}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: RedzoneStatusResponse = await res.json();
        if (disposed) return;
        if (!data.ok) throw new Error(data.error ?? "Unbekannter Fehler");
        setRuns(data.rows.map(enrichRun));
        setLastUpdate(data.generatedAt);
        setError(null);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    void fetchStatus();
    timerRef.current = window.setInterval(fetchStatus, POLL_MS);

    return () => {
      disposed = true;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [hours]);

  return { runs, loading, error, lastUpdate };
}
