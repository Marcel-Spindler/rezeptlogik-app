import { useEffect, useRef, useState } from "react";
import type { AppView } from "./AppContext";
import { LiveCount } from "../features/redzone-live/LiveBadge";
import { BackfillNavBadge } from "../features/backfills/BackfillAlertBanner";
import { useWoReconciliation } from "../features/wo-reconciliation/WoReconciliationContext";

interface NavItem {
  view: AppView;
  label: string;
  /** Nur im lokalen Dev-Build sichtbar (braucht den lokalen WMS-/Snowflake-Server). */
  localOnly?: boolean;
}

interface NavCategory {
  label: string;
  items: readonly NavItem[];
}

// Linkes Menü: wenige Haupt-Kategorien, die beim Drüberfahren (Hover / Fokus)
// ein Flyout-Panel mit ihren Unterfunktionen ausklappen. Jede View behält ihre
// eigene Identität/URL (?view=...) — die Kategorie bündelt nur die Navigation.
// Views derselben Kategorie erscheinen zusätzlich als Sub-Tab-Leiste über dem
// Inhalt (siehe GroupSubTabs).
const NAV_CATEGORIES: readonly NavCategory[] = [
  {
    label: "Rezepte & Meals",
    items: [
      { view: "recipe", label: "Rezept" },
      { view: "catalog", label: "Meal Katalog" },
    ],
  },
  {
    label: "Wochenplanung",
    items: [
      { view: "planning", label: "Planning OASE" },
      { view: "plating-plan", label: "Plating-Plan" },
      { view: "plating-day", label: "Plating Tag" },
      { view: "artikel-woche", label: "Artikel / KW" },
      { view: "whatif", label: "What-If Rechner" },
    ],
  },
  {
    label: "Produktion",
    items: [
      { view: "wo", label: "KET Plan / WO" },
      { view: "pet", label: "PET Plan / Plating" },
    ],
  },
  {
    label: "Lager & WMS",
    items: [
      { view: "wms", label: "WMS Übersicht" },
      { view: "full-inventory", label: "Lager Komplett" },
    ],
  },
  {
    label: "Live-Monitoring",
    items: [
      { view: "postblast-live", label: "Postblast Live" },
      { view: "backfills", label: "Backfills" },
      { view: "transparency-plan", label: "Transparency Plan" },
      // Redzone Live braucht den lokalen WMS-Server (Browser-SSO-Auth zu Snowflake) —
      // die deployte Cloud Function hat aktuell keinen gültigen Snowflake-Key und
      // keinen Cache-Fallback, deshalb online ausgeblendet, lokal aber sichtbar.
      { view: "redzone-live", label: "Redzone Live", localOnly: true },
    ],
  },
  {
    label: "Bots",
    items: [
      { view: "blast-chiller", label: "Blast Chiller" },
      { view: "allergen-plating", label: "Allergen Plating" },
    ],
  },
  {
    label: "Kommunikation",
    items: [
      { view: "rundmail", label: "Rundmail" },
      { view: "import", label: "CSV Import" },
    ],
  },
];

/** Kategorien mit ihren im aktuellen Build sichtbaren Views (leere Kategorien fallen weg). */
function visibleCategories(): NavCategory[] {
  return NAV_CATEGORIES.map((c) => ({
    ...c,
    items: c.items.filter((i) => !i.localOnly || import.meta.env.DEV),
  })).filter((c) => c.items.length > 0);
}

/** Menschenlesbare Labels für jede View (aus den Kategorien abgeleitet). */
export const VIEW_LABELS: Partial<Record<AppView, string>> = Object.fromEntries(
  NAV_CATEGORIES.flatMap((c) => c.items.map((i) => [i.view, i.label] as const)),
);

export interface NavViewInfo {
  view: AppView;
  label: string;
  /** Menü-Kategorie, unter der die View hängt. */
  category: string;
  localOnly: boolean;
}

/** Flache Liste aller Views mit Label + Kategorie — für die Command-Palette. */
export function allNavViews(): NavViewInfo[] {
  return NAV_CATEGORIES.flatMap((c) =>
    c.items.map((i) => ({ view: i.view, label: i.label, category: c.label, localOnly: !!i.localOnly })),
  );
}

/** Alle Views derselben Kategorie wie `view` (nur `view` selbst, wenn sie allein steht). */
export function siblingViews(view: AppView): readonly AppView[] {
  const cat = NAV_CATEGORIES.find((c) => c.items.some((i) => i.view === view));
  return cat ? cat.items.map((i) => i.view) : [view];
}

/** Badge (Live-Punkt / Backfill-Warnung) für eine einzelne View, falls zutreffend. */
function ViewBadge({ view }: { view: AppView }) {
  if (view === "redzone-live") return <LiveCount />;
  if (view === "backfills") return <BackfillNavBadge />;
  return null;
}

export function NavTabs({ view, onChange }: { view: AppView; onChange: (v: AppView) => void }) {
  const categories = visibleCategories();
  const woRecon = useWoReconciliation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [openCat, setOpenCat] = useState<string | null>(null);
  // Per Klick/Tap geöffnete Menüs bleiben "gepinnt" offen (für Touch & Tastatur),
  // bis man erneut klickt, daneben klickt oder einen Eintrag wählt — ein reines
  // Maus-Verlassen schließt sie dann nicht.
  const [pinned, setPinned] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const close = () => {
    cancelClose();
    setOpenCat(null);
    setPinned(false);
  };
  const hoverOpen = (label: string) => {
    if (pinned) return;
    cancelClose();
    setOpenCat(label);
  };
  const hoverClose = () => {
    if (pinned) return;
    cancelClose();
    closeTimer.current = setTimeout(() => setOpenCat(null), 120);
  };

  // Außerhalb klicken / Escape schließt ein offenes Menü.
  useEffect(() => {
    if (!openCat) return;
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCat]);

  return (
    <nav ref={navRef} className="card p-1.5 flex flex-col gap-0.5">
      {categories.map((cat) => {
        const activeCat = cat.items.some((i) => i.view === view);
        const open = openCat === cat.label;
        return (
          <div
            key={cat.label}
            className="relative"
            onMouseEnter={() => hoverOpen(cat.label)}
            onMouseLeave={hoverClose}
            onFocusCapture={() => {
              cancelClose();
              setOpenCat(cat.label);
            }}
            onBlurCapture={(e) => {
              if (!pinned && !e.currentTarget.contains(e.relatedTarget as Node)) hoverClose();
            }}
          >
            <button
              type="button"
              aria-haspopup="true"
              aria-expanded={open}
              onClick={() => {
                if (open && pinned) close();
                else {
                  cancelClose();
                  setOpenCat(cat.label);
                  setPinned(true);
                }
              }}
              className={`w-full text-left px-3 py-2 text-sm rounded-lg font-medium transition-colors flex items-center gap-2 ${
                activeCat
                  ? "bg-verden-600 text-white shadow-sm"
                  : open
                    ? "bg-slate-100 text-slate-900"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <span className="flex-1 truncate">{cat.label}</span>
              {cat.items.map((i) => (
                <ViewBadge key={i.view} view={i.view} />
              ))}
              <span
                className={`text-xs leading-none transition-transform ${open ? "translate-x-0.5" : ""} ${
                  activeCat ? "text-white/70" : "text-slate-400"
                }`}
                aria-hidden="true"
              >
                ›
              </span>
            </button>

            {/* Flyout: ab md rechts neben dem Button (pl-2 hält die Hover-Brücke,
                damit der Mauszeiger die Lücke überqueren kann); auf schmalen
                Screens klappt es stattdessen eingerückt unter dem Button auf. */}
            <div
              className={`${open ? "block" : "hidden"} md:block pl-3 pt-0.5
                md:absolute md:left-full md:top-0 md:z-50 md:pl-2 md:pt-0
                md:transition md:duration-150 md:origin-left ${
                  open
                    ? "md:opacity-100 md:translate-x-0 md:pointer-events-auto"
                    : "md:opacity-0 md:-translate-x-1 md:pointer-events-none"
                }`}
            >
              <div className="card p-1.5 min-w-[13rem] flex flex-col gap-0.5">
                <div className="px-2 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  {cat.label}
                </div>
                {cat.items.map((item) => {
                  const activeItem = item.view === view;
                  return (
                    <button
                      type="button"
                      key={item.view}
                      onClick={() => {
                        onChange(item.view);
                        close();
                      }}
                      className={`w-full text-left px-3 py-2 text-sm rounded-lg font-medium transition-colors flex items-center gap-2 ${
                        activeItem
                          ? "bg-verden-600 text-white shadow-sm"
                          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                      }`}
                    >
                      <span className="flex-1 truncate">{item.label}</span>
                      <ViewBadge view={item.view} />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}

      {/* KET Plan (export-recipes.csv) — global für genaue Platier-Berechnung */}
      <div className="mt-1 pt-1.5 border-t border-slate-100">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f && woRecon) woRecon.uploadRecipeWeightsFile(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="export-recipes.csv hochladen — ermöglicht genaue platierbare Meal-Berechnung in Postblast Live"
          className={`w-full text-left px-3 py-2 text-xs rounded-lg font-medium transition-colors flex items-center gap-2 ${
            woRecon?.recipeWeights
              ? "text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
              : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          }`}
        >
          <span className="text-sm leading-none">{woRecon?.recipeWeights ? "✓" : "↑"}</span>
          <span className="truncate">
            {woRecon?.recipeWeights
              ? `${woRecon.recipeWeights.recipeCount} Rezepte geladen`
              : "KET Plan hochladen"}
          </span>
          {woRecon?.recipeWeights && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); woRecon.clearRecipeWeights(); }}
              title="Rezept-Gewichte entfernen"
              className="ml-auto text-slate-300 hover:text-slate-500 leading-none"
            >
              ✕
            </button>
          )}
        </button>
      </div>
    </nav>
  );
}

/** Sub-Tab-Leiste zum Umschalten innerhalb einer Menü-Kategorie (z.B. "Produktion", "Bots"). */
export function GroupSubTabs({ view, onChange }: { view: AppView; onChange: (v: AppView) => void }) {
  const siblings = siblingViews(view).filter((v) => v !== "redzone-live" || import.meta.env.DEV);
  if (siblings.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-3">
      {siblings.map((v) => (
        <button
          type="button"
          key={v}
          onClick={() => onChange(v)}
          className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
            view === v
              ? "bg-verden-600 text-white shadow-sm"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          {VIEW_LABELS[v] ?? v}
        </button>
      ))}
    </div>
  );
}
