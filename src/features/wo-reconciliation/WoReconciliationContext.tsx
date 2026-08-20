// WO-Abgleich – globaler Provider. Führt App-Plan, KET-Plan, PET-Plan,
// Postblast-Wiegungen (und optional WMS-Submeals, on-demand nachgereicht)
// laufend zu einer Tabelle zusammen und schreibt periodisch einen Snapshot
// nach Firestore, damit später über den Verlauf ausgewertet werden kann
// (nicht nur der aktuelle Live-Zustand).
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppState } from "../../app/AppContext";
import { usePostblastMonitor } from "../gsheet-monitor/useGSheetMonitor";
import type { KetRow } from "../ket-plan/ketTypes";
import type { PetRow } from "../pet-plan/petTypes";
import type { RecipeWeightLookup } from "../gsheet-monitor/parsers/parseExportRecipes";
import type { WorkorderRow } from "../wms-overview/wmsTypes";
import { reconcileWorkOrders, severityByRecipe } from "./reconcileWorkOrders";
import type { ReconcileSource, WoReconciliationRow } from "./woReconcileTypes";
import { addDoc, collection, getFirebase } from "../../core/firebase";

// Gleiche Storage-Keys wie die Upload-Stellen selbst (PostblastLiveView /
// KetBreakdownView / PetPlanView) — bewusst identisch, damit ein dort einmal
// hochgeladener Plan hier automatisch mitgilt, ohne erneuten Upload.
const KET_CSV_STORAGE_KEY = "ket-csv-rows-v1";
const RECIPE_WEIGHTS_STORAGE_KEY = "pb_recipe_weights_v1";
export const PET_CSV_STORAGE_KEY = "pet-csv-rows-v1";

const LAST_SNAPSHOT_KEY = "wo_reconcile_last_snapshot_v1";
const SNAPSHOT_INTERVAL_MS = 15 * 60_000;

function useLocalStorageSource<T>(key: string, deserialize: (raw: string) => T): T | null {
  const read = () => {
    try { const raw = localStorage.getItem(key); return raw ? deserialize(raw) : null; }
    catch { return null; }
  };
  const [value, setValue] = useState<T | null>(read);
  useEffect(() => {
    const refresh = () => setValue(read());
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return value;
}

export interface WoReconciliationState {
  rows: WoReconciliationRow[];
  bySeverityRecipe: Map<string, { severity: "warn" | "critical"; count: number }>;
  sourcesAvailable: ReconcileSource[];
  ingestWmsWorkorders: (rows: WorkorderRow[]) => void;
}

const WoReconciliationContext = createContext<WoReconciliationState | null>(null);

export function useWoReconciliation(): WoReconciliationState | null {
  return useContext(WoReconciliationContext);
}

export function WoReconciliationProvider({ children }: { children: ReactNode }) {
  const { data, surface } = useAppState();
  const postblast = usePostblastMonitor();

  const ketRows = useLocalStorageSource<KetRow[]>(KET_CSV_STORAGE_KEY, raw => JSON.parse(raw));
  const weights = useLocalStorageSource<RecipeWeightLookup>(RECIPE_WEIGHTS_STORAGE_KEY, raw => {
    const parsed = JSON.parse(raw) as { entries: [string, number][]; recipeCount: number; rowCount: number };
    return { gramsPerPortion: new Map(parsed.entries), recipeCount: parsed.recipeCount, rowCount: parsed.rowCount };
  });
  const petRows = useLocalStorageSource<PetRow[]>(PET_CSV_STORAGE_KEY, raw => JSON.parse(raw));

  // WMS-Submeals kommen nicht global (Live-Snowflake, on-demand) — Views wie
  // der Rezept-Trace reichen ihr Ergebnis hier nach, wenn der Nutzer sie lädt.
  const [wmsWorkorders, setWmsWorkorders] = useState<WorkorderRow[]>([]);
  const ingestWmsWorkorders = (rows: WorkorderRow[]) => setWmsWorkorders(rows);

  const rows = useMemo(
    () => reconcileWorkOrders(data?.productionPlan, ketRows, petRows, postblast.data, weights, wmsWorkorders),
    [data?.productionPlan, ketRows, petRows, postblast.data, weights, wmsWorkorders],
  );

  const bySeverityRecipe = useMemo(
    () => severityByRecipe(rows) as Map<string, { severity: "warn" | "critical"; count: number }>,
    [rows],
  );

  const sourcesAvailable = useMemo<ReconcileSource[]>(() => {
    const s: ReconcileSource[] = [];
    if (data?.productionPlan) s.push("app");
    if (ketRows) s.push("ket");
    if (petRows) s.push("pet");
    if (wmsWorkorders.length > 0) s.push("wms");
    if (postblast.data) s.push("postblast");
    return s;
  }, [data?.productionPlan, ketRows, petRows, wmsWorkorders, postblast.data]);

  // Periodischer Snapshot nach Firestore (apps/rezeptlogik/woReconciliationLog,
  // gleiches offene Client-Write-Muster wie rackV2PlanHistory) — Rohmaterial
  // für spätere Auswertungen über den Verlauf, nicht nur den Live-Zustand.
  // Nur im vollen Surface (kein Kiosk/Kitchen/Redzone-Standalone), best effort,
  // frühestens alle 15 Minuten (Zeitstempel überlebt Reloads in localStorage).
  const writingRef = useRef(false);
  useEffect(() => {
    if (surface !== "full" || rows.length === 0 || writingRef.current) return;
    const lastRaw = localStorage.getItem(LAST_SNAPSHOT_KEY);
    const lastAt = lastRaw ? Date.parse(lastRaw) : 0;
    if (Date.now() - lastAt < SNAPSHOT_INTERVAL_MS) return;

    writingRef.current = true;
    void (async () => {
      try {
        const { db } = getFirebase();
        await addDoc(collection(db, "apps", "rezeptlogik", "woReconciliationLog"), {
          capturedAt: new Date().toISOString(),
          sourcesAvailable,
          rowCount: rows.length,
          criticalCount: rows.filter(r => r.severity === "critical").length,
          warnCount: rows.filter(r => r.severity === "warn").length,
          rows,
        });
        localStorage.setItem(LAST_SNAPSHOT_KEY, new Date().toISOString());
      } catch {
        // Snapshot ist optional — die Live-Ansicht bleibt die Hauptquelle.
      } finally {
        writingRef.current = false;
      }
    })();
  }, [rows, sourcesAvailable, surface]);

  const value: WoReconciliationState = { rows, bySeverityRecipe, sourcesAvailable, ingestWmsWorkorders };

  return <WoReconciliationContext.Provider value={value}>{children}</WoReconciliationContext.Provider>;
}
