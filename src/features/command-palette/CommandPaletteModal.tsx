// Command-Palette — das Modal (lazy geladen beim ersten ⌘K).
//
// Baut den Item-Index (Views / KWs / Rezepte / WO-Submeal-SKU + Kommandos),
// rankt gegen den Suchbegriff und führt den gewählten Eintrag aus. WO/Submeal/
// SKU-Treffer öffnen dasselbe Flow-Overlay wie früher die Inline-Suche.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../../app/AppContext";
import { useWoReconciliation } from "../wo-reconciliation/WoReconciliationContext";
import { useRedzoneOptional } from "../redzone-live/RedzoneContext";
import { resolveWoNumbers, WoFlowOverlay } from "../global-search";
import type { SearchEntry } from "../global-search/searchTypes";
import { GROUP_ICON } from "./paletteTypes";
import type { PaletteItem } from "./paletteTypes";
import {
  buildRecipeItems,
  buildSearchEntryItems,
  buildViewItems,
  buildWeekItems,
  rankPaletteItems,
} from "./paletteSource";
import { buildCommandItems } from "./paletteCommands";

const CLOSE_AFTER_FLASH_MS = 950;

export function CommandPaletteModal({ onClose }: { onClose: () => void }) {
  const {
    data, view, selectedWeek, upliftPercent,
    setView, setSelectedRecipe, setSelectedWeek, setUpliftPercent,
  } = useAppState();
  const recon = useWoReconciliation();
  const redzone = useRedzoneOptional();
  const isDev = import.meta.env.DEV;

  const reconRows = useMemo(() => recon?.rows ?? [], [recon?.rows]);
  const planRows = useMemo(() => data?.productionPlan?.rows ?? [], [data?.productionPlan?.rows]);
  const reconByWo = useMemo(() => new Map(reconRows.map((r) => [r.workOrder, r])), [reconRows]);
  const platedCodes = useMemo(
    () => new Set((redzone?.platingDone ?? []).map((r) => r.mealCode).filter(Boolean) as string[]),
    [redzone?.platingDone],
  );
  const weekRecipeCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const wr of data?.weekRecipes ?? []) m.set(wr.hfWeek, (m.get(wr.hfWeek) ?? 0) + 1);
    return (week: string) => m.get(week) ?? 0;
  }, [data?.weekRecipes]);

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<{ entry: SearchEntry; woNumbers: string[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const openRecipe = useCallback(
    (code: string) => {
      setSelectedRecipe(code);
      setView("recipe");
    },
    [setSelectedRecipe, setView],
  );

  // ── Item-Index ───────────────────────────────────────────────────────────
  // Die schweren Quellen (Rezepte + WO/Submeal/SKU-Index) hängen nur an
  // data/recon → einmal beim Öffnen gebaut, nicht bei jedem Tastendruck.
  const heavyItems = useMemo(
    () => [...buildRecipeItems(data, openRecipe), ...buildSearchEntryItems(data, reconRows)],
    [data, reconRows, openRecipe],
  );
  // Views + KWs sind billig (≈30 Einträge) — dürfen pro Render neu entstehen.
  const lightItems = useMemo(
    () => [...buildViewItems(setView, isDev), ...buildWeekItems(data, weekRecipeCount, setSelectedWeek)],
    [data, weekRecipeCount, isDev, setView, setSelectedWeek],
  );
  const commandItems = useMemo(
    () => buildCommandItems({ view, selectedWeek, upliftPercent, setUpliftPercent }),
    [view, selectedWeek, upliftPercent, setUpliftPercent],
  );
  const allItems = useMemo(
    () => [...commandItems, ...lightItems, ...heavyItems],
    [commandItems, lightItems, heavyItems],
  );

  const groups = useMemo(() => rankPaletteItems(allItems, query), [allItems, query]);
  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => setActiveIndex(0), [query]);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc schließt — auch wenn der Fokus auf einem Eintrag (statt im Feld) sitzt
  // oder das Flow-Overlay offen ist. onClose unmountet das Modal samt Overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Aktiven Eintrag in den sichtbaren Bereich scrollen.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const runItem = useCallback(
    async (item: PaletteItem | undefined) => {
      if (!item || busy) return;
      if (item.action.type === "flow") {
        setTarget({ entry: item.action.entry, woNumbers: resolveWoNumbers(item.action.entry, planRows, reconRows) });
        return;
      }
      setBusy(true);
      try {
        const res = await item.action.run();
        if (typeof res === "string" && res) {
          setFlash(res);
          window.setTimeout(onClose, CLOSE_AFTER_FLASH_MS);
        } else {
          onClose();
        }
      } catch (e) {
        setFlash("⚠ " + (e instanceof Error ? e.message : String(e)));
        window.setTimeout(onClose, 1400);
      } finally {
        setBusy(false);
      }
    },
    [busy, onClose, planRows, reconRows],
  );

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      void runItem(flatItems[activeIndex]);
    }
  };

  // ── Flow-Overlay statt Palette, sobald ein WO/Submeal/SKU-Treffer gewählt ist ──
  if (target && data) {
    return (
      <WoFlowOverlay
        entry={target.entry}
        woNumbers={target.woNumbers}
        planRows={planRows}
        reconByWo={reconByWo}
        data={data}
        redzoneFor={(code) =>
          redzone ? { platingNow: redzone.isPlatingNow(code), platingDone: platedCodes.has(code) } : undefined
        }
        onClose={() => { setTarget(null); onClose(); }}
        onOpenRecipe={(code) => { openRecipe(code); setTarget(null); onClose(); }}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[10vh] backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command-Palette"
      >
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <span className="text-slate-400" aria-hidden>🔎</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Ansicht, Rezept, Work Order, KW oder Kommando …"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            aria-label="Suche"
          />
          <kbd className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-1.5">
          {flatItems.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-slate-400">
              {query.trim() ? `Kein Treffer für „${query}".` : "Tippen zum Suchen …"}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.group} className="mb-1 last:mb-0">
                <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  {GROUP_ICON[group.group]} {group.label}
                </div>
                {group.items.map((item) => {
                  const idx = flatItems.indexOf(item);
                  return (
                    <button
                      type="button"
                      key={item.key}
                      data-idx={idx}
                      onClick={() => void runItem(item)}
                      onMouseEnter={() => setActiveIndex(idx)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${
                        idx === activeIndex ? "bg-verden-50 ring-1 ring-verden-200" : "hover:bg-slate-50"
                      }`}
                    >
                      <span className="shrink-0 text-base" aria-hidden>{item.icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-800">{item.title}</span>
                        {item.subtitle && (
                          <span className="block truncate text-[11px] text-slate-400">{item.subtitle}</span>
                        )}
                      </span>
                      {item.hint && (
                        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                          {item.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
          <span>{flash ?? "↑↓ wählen · ⏎ öffnen · Esc schließen"}</span>
          <span className="tabular-nums">{flatItems.length}</span>
        </div>
      </div>
    </div>
  );
}
