import { useRef } from "react";
import type { AppView } from "./AppContext";
import { LiveCount } from "../features/redzone-live/LiveBadge";
import { BackfillNavBadge } from "../features/backfills/BackfillAlertBanner";
import { useWoReconciliation } from "../features/wo-reconciliation/WoReconciliationContext";

interface NavGroup {
  label: string;
  views: readonly AppView[];
  localOnly?: boolean;
}

// Menüpunkte, die mehrere Views bündeln (z.B. "Bots"), zeigen intern eine
// Sub-Tab-Leiste (siehe GroupSubTabs) statt eigener NavTabs-Zeilen — spart
// Platz im linken Menü, ohne dass eine der Views ihre eigene Identität/URL
// (?view=...) verliert.
const NAV_GROUPS: readonly NavGroup[] = [
  { label: "Rezept", views: ["recipe"] },
  { label: "Meal Katalog", views: ["catalog"] },
  { label: "Planning OASE", views: ["planning"] },
  { label: "KET Plan / WO", views: ["wo"] },
  { label: "PET Plan / Plating", views: ["pet"] },
  { label: "WMS Übersicht", views: ["wms"] },
  { label: "Lager Komplett", views: ["full-inventory"] },
  { label: "What-If Rechner", views: ["whatif"] },
  { label: "Rundmail", views: ["rundmail"] },
  { label: "CSV Import", views: ["import"] },
  { label: "Artikel / KW", views: ["artikel-woche"] },
  { label: "Bots", views: ["blast-chiller", "allergen-plating"] },
  { label: "Monitoring", views: ["postblast-live", "backfills", "transparency-plan"] },
  // Redzone Live braucht den lokalen WMS-Server (Browser-SSO-Auth zu Snowflake) —
  // die deployte Cloud Function hat aktuell keinen gültigen Snowflake-Key und
  // keinen Cache-Fallback, deshalb online ausgeblendet, lokal aber sichtbar.
  { label: "Redzone Live", views: ["redzone-live"], localOnly: true },
];

/** Menschenlesbare Labels für die einzelnen Views innerhalb einer Menügruppe (Sub-Tabs). */
const VIEW_LABELS: Partial<Record<AppView, string>> = {
  "blast-chiller": "Blast Chiller",
  "allergen-plating": "Allergen Plating",
  "postblast-live": "Postblast Live",
  "backfills": "Backfills",
  "transparency-plan": "Transparency Plan",
};

/** Alle Views derselben Menügruppe wie `view` (nur `view` selbst, wenn sie allein steht). */
export function siblingViews(view: AppView): readonly AppView[] {
  return NAV_GROUPS.find((g) => g.views.includes(view))?.views ?? [view];
}

export function NavTabs({ view, onChange }: { view: AppView; onChange: (v: AppView) => void }) {
  const groups = NAV_GROUPS.filter((g) => !g.localOnly || import.meta.env.DEV);
  const woRecon = useWoReconciliation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <nav className="card p-1.5 flex flex-col gap-0.5">
      {groups.map((g) => {
        const active = g.views.includes(view);
        const target = active ? view : g.views[0];
        return (
          <button
            type="button"
            key={g.label}
            onClick={() => onChange(target)}
            className={`w-full text-left px-3 py-2 text-sm rounded-lg font-medium transition-colors flex items-center gap-2 ${
              active
                ? "bg-verden-600 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            {g.label}
            {g.views.includes("redzone-live") && <LiveCount />}
            {g.views.includes("backfills") && <BackfillNavBadge />}
          </button>
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

/** Sub-Tab-Leiste zum Umschalten innerhalb einer zusammengelegten Menügruppe (z.B. "Bots", "Monitoring"). */
export function GroupSubTabs({ view, onChange }: { view: AppView; onChange: (v: AppView) => void }) {
  const siblings = siblingViews(view);
  if (siblings.length < 2) return null;
  return (
    <div className="flex gap-1 mb-3">
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
