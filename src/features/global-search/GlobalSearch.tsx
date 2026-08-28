// Übergeordnete Suche — Suchfeld mit Autovervollständigung + Flow-Overlay.
//
// Bewusst NICHT in "KET Plan / WO" gedacht (dort hat die WO-Ansicht eine eigene
// Funktion) — die Suche ist app-weit und wird aktuell im Kopfbereich von FullApp
// gerendert. Könnte später in Shell.tsx in den echten Header wandern.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../../app/AppContext";
import { useWoReconciliation } from "../wo-reconciliation/WoReconciliationContext";
import { useRedzoneOptional } from "../redzone-live/RedzoneContext";
import type { DataBundle, WorkOrderEntry } from "../../core/types";
import type { WoReconciliationRow } from "../wo-reconciliation/woReconcileTypes";
import { buildSearchIndex, groupHits, searchIndex } from "./globalSearchIndex";
import { buildWoFlow, resolveWoNumbers } from "./woFlow";
import { WoFlowCard } from "./WoFlowCard";
import type { SearchEntry, SearchHit } from "./searchTypes";

const KIND_LABEL: Record<SearchEntry["kind"], string> = {
  wo: "Work Orders",
  submeal: "Submeals (Name / SKU)",
  sku: "SKU-Codes",
  meal: "Meals",
};
const KIND_ICON: Record<SearchEntry["kind"], string> = { wo: "📋", submeal: "🧩", sku: "🏷️", meal: "🍽️" };

const MAX_FLOW_CARDS = 8;

export function GlobalSearch() {
  const { data, setView, setSelectedRecipe } = useAppState();
  const recon = useWoReconciliation();
  const redzone = useRedzoneOptional();

  const reconRows = useMemo(() => recon?.rows ?? [], [recon?.rows]);
  const planRows = useMemo(() => data?.productionPlan?.rows ?? [], [data?.productionPlan?.rows]);
  const index = useMemo(() => buildSearchIndex(data, reconRows), [data, reconRows]);
  const reconByWo = useMemo(() => new Map(reconRows.map((r) => [r.workOrder, r])), [reconRows]);
  const platedCodes = useMemo(
    () => new Set((redzone?.platingDone ?? []).map((r) => r.mealCode).filter(Boolean) as string[]),
    [redzone?.platingDone],
  );

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeHit, setActiveHit] = useState(0);
  const [target, setTarget] = useState<{ entry: SearchEntry; woNumbers: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => searchIndex(index, query), [index, query]);
  const groups = useMemo(() => groupHits(hits), [hits]);
  const flatHits = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  useEffect(() => setActiveHit(0), [query]);

  const selectHit = useCallback(
    (hit: SearchHit) => {
      setTarget({ entry: hit.entry, woNumbers: resolveWoNumbers(hit.entry, planRows, reconRows) });
      setOpen(false);
      setQuery("");
      inputRef.current?.blur();
    },
    [planRows, reconRows],
  );

  // Tastatur: Cmd/Ctrl+K fokussiert, Esc schließt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      } else if (e.key === "Escape") {
        if (target) setTarget(null);
        else setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  // Klick außerhalb schließt das Dropdown.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveHit((i) => Math.min(i + 1, flatHits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveHit((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && flatHits[activeHit]) {
      e.preventDefault();
      selectHit(flatHits[activeHit]);
    }
  };

  const openRecipe = (code: string) => {
    setSelectedRecipe(code);
    setView("recipe");
    setTarget(null);
  };

  const showDropdown = open && query.trim().length >= 2;

  return (
    <>
      <div ref={boxRef} className="relative">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 shadow-sm ring-1 ring-slate-200 focus-within:ring-verden-400">
          <span className="text-slate-400">🔎</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onInputKey}
            placeholder="Übergeordnet suchen: WO-Nummer, Submeal (SKU/Name), Mealcode, Rezept …"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
          <kbd className="hidden shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-400 sm:block">
            ⌘K
          </kbd>
        </div>

        {showDropdown && (
          <div className="absolute z-40 mt-1 max-h-[60vh] w-full overflow-y-auto rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-slate-200">
            {flatHits.length === 0 ? (
              <div className="px-3 py-4 text-sm text-slate-400">Kein Treffer für „{query}".</div>
            ) : (
              groups.map((group) => (
                <div key={group.kind} className="mb-1 last:mb-0">
                  <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                    {KIND_ICON[group.kind]} {KIND_LABEL[group.kind]}
                  </div>
                  {group.hits.map((hit) => {
                    const flatIdx = flatHits.indexOf(hit);
                    return (
                      <button
                        type="button"
                        key={`${hit.entry.kind}-${hit.entry.title}-${hit.entry.woNumber ?? hit.entry.sku ?? hit.entry.subRecipe ?? ""}`}
                        onClick={() => selectHit(hit)}
                        onMouseEnter={() => setActiveHit(flatIdx)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${
                          flatIdx === activeHit ? "bg-verden-50 ring-1 ring-verden-200" : "hover:bg-slate-50"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-800">{hit.entry.title}</span>
                          <span className="block truncate text-[11px] text-slate-400">{hit.entry.subtitle}</span>
                        </span>
                        {hit.entry.sku && hit.entry.kind === "submeal" && (
                          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">{hit.entry.sku}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {target && (
        <FlowOverlay
          entry={target.entry}
          woNumbers={target.woNumbers}
          planRows={planRows}
          reconByWo={reconByWo}
          data={data!}
          redzoneFor={(code) =>
            redzone ? { platingNow: redzone.isPlatingNow(code), platingDone: platedCodes.has(code) } : undefined
          }
          onClose={() => setTarget(null)}
          onOpenRecipe={openRecipe}
        />
      )}
    </>
  );
}

function FlowOverlay({
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
              <WoFlowCard key={flow.woNumber} flow={flow} onOpenRecipe={onOpenRecipe} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
