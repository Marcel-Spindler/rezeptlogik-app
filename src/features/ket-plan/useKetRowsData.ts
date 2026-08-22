// Lädt die KET-WO-Zeilen für die aktuelle Woche: bevorzugt den GSheet→
// Firestore-Produktionsplan, fällt bei fehlenden/veralteten Daten für die
// aktuelle Woche auf den Live-WMS/Snowflake-Cache zurück. Extrahiert aus
// KetBreakdownView, damit sie auch der Shopfloor-Kiosk (reine Lesesicht, kein
// CSV-Upload) ohne Logik-Duplikat nutzen kann — beide Aufrufer müssen exakt
// dieselbe Priorität (CSV > Produktionsplan > Live-WMS-Fallback) sehen, sonst
// zeigen Büro-Ansicht und Kiosk-Laptop unterschiedliche WOs für dieselbe Woche.
import { useEffect, useMemo, useState } from "react";
import type { DataBundle, WorkOrderEntry } from "../../core/types";
import { fetchWmsWorkorderCache, wmsWorkorderRowToEntry, filterRowsToWeekWindow, currentHfWeek } from "../../lib/wmsCache";
import { weekNumFromHfWeek, weekPrefixFromWoNumber } from "../wms-overview/wmsWeeks";
import { woEntriesToKetRows } from "./ketLogic";
import type { KetRow } from "./ketTypes";

export interface KetRowsDataResult {
  ketRows: KetRow[];
  liveWeek: string;
  liveWmsRows: WorkOrderEntry[] | null;
  productionPlanHasLiveWeek: boolean;
  wmsDroppedWeeks: string[];
}

export function useKetRowsData(
  data: DataBundle,
  selectedWeek: string | undefined,
  csvRows: KetRow[] | null,
): KetRowsDataResult {
  const liveWeek = selectedWeek || currentHfWeek();
  const [liveWmsRows, setLiveWmsRows] = useState<WorkOrderEntry[] | null>(null);
  const [wmsDroppedWeeks, setWmsDroppedWeeks] = useState<string[]>([]);

  // "Hat Zeilen" reicht nicht - der GSheet→Firestore-Plan kann 300+ Zeilen für
  // längst vergangene Wochen halten, während die aktuelle Woche darin komplett
  // fehlt. Ohne diesen Check würde der Live-Snowflake-Fallback unten nie
  // greifen, obwohl productionPlan für die aktuelle Woche leer ist.
  const productionPlanHasLiveWeek = useMemo(() => {
    const rows = data.productionPlan?.rows;
    if (!rows?.length) return false;
    const liveWeekNum = weekNumFromHfWeek(liveWeek);
    if (liveWeekNum == null) return true; // can't tell - don't second-guess the trusted source
    return rows.some((row) => weekPrefixFromWoNumber(row.workOrder) === liveWeekNum);
  }, [data.productionPlan?.rows, liveWeek]);

  // Lowest-priority fallback: only reach for the live WMS/Snowflake cache when
  // neither manual CSV nor the established GSheet→Firestore plan has rows for
  // the CURRENT week, so this unverified source can never silently override a
  // trusted one that's actually still current.
  useEffect(() => {
    if (csvRows !== null) return;
    if (productionPlanHasLiveWeek) return;
    let cancelled = false;

    fetchWmsWorkorderCache().then((res) => {
      if (cancelled || !res || !res.rows.length) return;
      const { kept, droppedWeeks } = filterRowsToWeekWindow(res.rows, liveWeek);

      // Map defensively: one malformed cache row must be skipped, not throw
      const mapped = kept.reduce<WorkOrderEntry[]>((acc, row) => {
        try {
          acc.push(wmsWorkorderRowToEntry(row));
        } catch (error) {
          console.warn("[useKetRowsData] Skipping malformed WMS row:", error);
        }
        return acc;
      }, []);

      if (cancelled) return;
      setWmsDroppedWeeks(droppedWeeks);
      if (mapped.length) setLiveWmsRows(mapped);
    }).catch((error) => {
      if (!cancelled) {
        console.error("[useKetRowsData] Failed to fetch WMS workorder cache:", error);
      }
    });

    return () => { cancelled = true; };
  }, [csvRows, productionPlanHasLiveWeek, liveWeek]);

  const ketRows = useMemo<KetRow[]>(() => {
    if (csvRows !== null) return csvRows;
    const rows = data.productionPlan?.rows;
    if (rows?.length && productionPlanHasLiveWeek) return woEntriesToKetRows(rows);
    if (liveWmsRows?.length) return woEntriesToKetRows(liveWmsRows);
    if (rows?.length) return woEntriesToKetRows(rows); // stale but still better than nothing
    return [];
  }, [csvRows, data.productionPlan?.rows, productionPlanHasLiveWeek, liveWmsRows]);

  return { ketRows, liveWeek, liveWmsRows, productionPlanHasLiveWeek, wmsDroppedWeeks };
}
