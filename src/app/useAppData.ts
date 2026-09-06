// Lädt das DataBundle und hält es per Live-Refresh (Firestore-Listener + minütlicher
// Ramp-Up-Poll) aktuell. Kapselt ausschließlich das Laden — abgeleitete Werte leben
// in useRecipeSelection.
import { useEffect, useState } from "react";
import {
  dataSourceStatus,
  loadData,
  refreshRampUpDataOnStart,
  refreshOperationalData,
  subscribeRampUpHashChanges,
} from "../core/dataSource";
import { lsGet } from "../lib/helpers";
import type { DataBundle } from "../core/types";

const RAMP_UP_POLL_MS = 60_000;

export interface AppDataState {
  data: DataBundle | null;
  error: string | null;
  source: typeof dataSourceStatus;
}

export function useAppData(onWeekResolved: (week: string) => void): AppDataState {
  const [data, setData] = useState<DataBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<typeof dataSourceStatus>(dataSourceStatus);

  useEffect(() => {
    let disposed = false;
    let pollTimer: number | null = null;
    let unsubscribe = () => {};

    const loadLatest = async () => {
      const bundle = await loadData();
      if (disposed) return;
      setData(bundle);
      setSource({ ...dataSourceStatus });

      const savedWeek = lsGet<string>("week", "");
      if (!savedWeek || !bundle.weeks.includes(savedWeek)) {
        const firstWithRecipes = bundle.weeks.find(w => bundle.weekRecipes.some(r => r.hfWeek === w));
        onWeekResolved(firstWithRecipes ?? bundle.weeks[0] ?? "");
      }
    };

    const reloadHandler = () => { void loadLatest(); };

    (async () => {
      try {
        await refreshRampUpDataOnStart();
        void refreshOperationalData();
        await loadLatest();
        pollTimer = window.setInterval(() => { void refreshRampUpDataOnStart(); }, RAMP_UP_POLL_MS);
        unsubscribe = subscribeRampUpHashChanges(reloadHandler);
        window.addEventListener("rezeptlogik:ket-plan-saved", reloadHandler);
        window.addEventListener("rezeptlogik:plating-plan-saved", reloadHandler);
        window.addEventListener("rezeptlogik:csv-import-saved", reloadHandler);
      } catch (e: unknown) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      disposed = true;
      if (pollTimer !== null) window.clearInterval(pollTimer);
      unsubscribe();
      window.removeEventListener("rezeptlogik:ket-plan-saved", reloadHandler);
      window.removeEventListener("rezeptlogik:plating-plan-saved", reloadHandler);
      window.removeEventListener("rezeptlogik:csv-import-saved", reloadHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, error, source };
}
