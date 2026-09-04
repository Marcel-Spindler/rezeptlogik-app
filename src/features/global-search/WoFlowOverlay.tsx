// Grafisches Flow-/Verlaufs-Overlay für einen Suchtreffer (WO / Submeal / SKU /
// Meal) — eine oder mehrere Work Orders als Stufen-Schiene + Submeal-Breakdown.
//
// Früher inline in GlobalSearch.tsx; ausgelagert, damit die Command-Palette
// (features/command-palette/) dieselbe Ansicht wiederverwenden kann.
import { useEffect, useMemo, useState } from "react";
import type { DataBundle, WorkOrderEntry } from "../../core/types";
import { collection, getDocs, getFirebase, limit, orderBy, query } from "../../core/firebase";
import type { WoReconciliationRow } from "../wo-reconciliation/woReconcileTypes";
import { buildWoFlow } from "./woFlow";
import { WoFlowCard } from "./WoFlowCard";
import type { SearchEntry } from "./searchTypes";
import { buildWoHistory, type WoHistoryPoint, woHistoryDocId } from "./woHistory";

export const KIND_LABEL: Record<SearchEntry["kind"], string> = {
  wo: "Work Orders",
  submeal: "Submeals (Name / SKU)",
  sku: "SKU-Codes",
  meal: "Meals",
};

const MAX_FLOW_CARDS = 8;

export function WoFlowOverlay({
  entry,
  woNumbers,
  planRows,
  reconByWo,
  data,
  redzoneFor,
  onClose,
  onOpenRecipe,
}: {
  entry: SearchEntry;
  woNumbers: string[];
  planRows: WorkOrderEntry[];
  reconByWo: Map<string, WoReconciliationRow>;
  data: DataBundle;
  redzoneFor: (recipeCode: string) => { platingNow: boolean; platingDone: boolean } | undefined;
  onClose: () => void;
  onOpenRecipe: (recipeCode: string) => void;
}) {
  const [historyByWo, setHistoryByWo] = useState<Map<string, WoHistoryPoint[]> | null>(null);
  const flows = useMemo(
    () =>
      woNumbers.slice(0, MAX_FLOW_CARDS).map((wo) => {
        const recon = reconByWo.get(wo);
        return buildWoFlow({
          woNumber: wo,
          planRows,
          recon,
          data,
          redzone: redzoneFor(recon?.recipeCode || entry.recipeCode),
        });
      }),
    [woNumbers, planRows, reconByWo, data, redzoneFor, entry.recipeCode],
  );

  useEffect(() => {
    let cancelled = false;
    setHistoryByWo(null);
    void (async () => {
      try {
        const { db } = getFirebase();
        const history = new Map<string, WoHistoryPoint[]>();
        const histories = await Promise.all(woNumbers.map(async (woNumber) => {
          const snapshots = (await getDocs(query(
            collection(db, "apps", "rezeptlogik", "woReconciliationHistory", woHistoryDocId(woNumber), "snapshots"),
            orderBy("capturedAt", "desc"),
            limit(48),
          ))).docs.map((doc) => doc.data() as { capturedAt?: string; rows?: WoReconciliationRow[] });
          return { woNumber, snapshots };
        }));
        for (const { woNumber, snapshots } of histories) {
          const validSnapshots = snapshots
            .filter((snapshot) => typeof snapshot.capturedAt === "string" && Array.isArray(snapshot.rows))
            .map((snapshot) => ({ capturedAt: snapshot.capturedAt!, rows: snapshot.rows! }));
          history.set(woNumber, buildWoHistory(woNumber, validSnapshots as Parameters<typeof buildWoHistory>[1]));
        }
        if ([...history.values()].some((points) => points.length > 0)) {
          if (!cancelled) setHistoryByWo(history);
          return;
        }

        const snapshots = (await getDocs(query(
          collection(db, "apps", "rezeptlogik", "woReconciliationLog"),
          orderBy("capturedAt", "desc"),
          limit(96),
        ))).docs.map((doc) => doc.data() as { capturedAt?: string; rows?: WoReconciliationRow[] });
        if (cancelled) return;
        for (const woNumber of woNumbers) {
          const validSnapshots = snapshots
            .filter((snapshot) => typeof snapshot.capturedAt === "string" && Array.isArray(snapshot.rows))
            .map((snapshot) => ({ capturedAt: snapshot.capturedAt!, rows: snapshot.rows! }));
          history.set(woNumber, buildWoHistory(woNumber, validSnapshots as Parameters<typeof buildWoHistory>[1]));
        }
        setHistoryByWo(history);
      } catch {
        if (!cancelled) setHistoryByWo(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [woNumbers]);

  const allDone = flows.length > 0 && flows.every((f) => f.stages[f.stages.length - 1]?.status === "done");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="my-8 w-full max-w-4xl space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3 shadow-lg ring-1 ring-slate-200">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{KIND_LABEL[entry.kind]}</div>
            <div className="truncate text-lg font-black text-slate-900">{entry.title}</div>
            <div className="truncate text-xs text-slate-500">{entry.subtitle}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200"
          >
            ✕
          </button>
        </div>

        {woNumbers.length === 0 ? (
          <div className="card p-6 text-center text-sm text-slate-500">
            Für „{entry.title}" liegt aktuell keine Work Order im Produktionsplan.
            {entry.recipeCode && (
              <div className="mt-3">
                <button type="button" onClick={() => onOpenRecipe(entry.recipeCode)} className="btn btn-primary">
                  Rezept {entry.recipeCode} öffnen
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {woNumbers.length > 1 && (
              <div className="rounded-xl bg-white px-4 py-2.5 text-sm shadow-sm ring-1 ring-slate-200">
                <span className="font-semibold text-slate-800">{woNumbers.length} Work Orders</span>
                <span className="text-slate-500">
                  {" "}
                  · Meal ist fertig, wenn alle durch sind —{" "}
                  {allDone ? (
                    <span className="font-semibold text-emerald-600">alle erledigt ✅</span>
                  ) : (
                    <span className="font-semibold text-amber-600">noch offen</span>
                  )}
                </span>
                {woNumbers.length > MAX_FLOW_CARDS && (
                  <span className="text-slate-400"> · zeige die ersten {MAX_FLOW_CARDS}</span>
                )}
              </div>
            )}
            {flows.map((flow) => (
              <WoFlowCard key={flow.woNumber} flow={flow} history={historyByWo?.get(flow.woNumber)} onOpenRecipe={onOpenRecipe} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
