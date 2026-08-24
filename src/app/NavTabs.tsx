import type { AppView } from "./AppContext";
import { LiveCount } from "../features/redzone-live/LiveBadge";
import { BackfillNavBadge } from "../features/backfills/BackfillAlertBanner";

const NAV_TABS: ReadonlyArray<{ view: AppView; label: string; localOnly?: boolean }> = [
  { view: "recipe", label: "Rezept" },
  { view: "catalog", label: "Meal Katalog" },
  { view: "planning", label: "Planning OASE" },
  { view: "wo", label: "KET Plan / WO" },
  { view: "pet", label: "PET Plan / Plating" },
  { view: "wms", label: "WMS Übersicht" },
  { view: "whatif", label: "What-If Rechner" },
  { view: "rundmail", label: "Rundmail" },
  { view: "import", label: "CSV Import" },
  { view: "blast-chiller", label: "Blast Chiller Bot" },
  { view: "allergen-plating", label: "Allergen Plating Bot" },
  { view: "postblast-live", label: "Postblast Live" },
  { view: "backfills", label: "Backfills" },
  // Redzone Live braucht den lokalen WMS-Server (Browser-SSO-Auth zu Snowflake) —
  // die deployte Cloud Function hat aktuell keinen gültigen Snowflake-Key und
  // keinen Cache-Fallback, deshalb online ausgeblendet, lokal aber sichtbar.
  { view: "redzone-live", label: "Redzone Live", localOnly: true },
];

export function NavTabs({ view, onChange }: { view: AppView; onChange: (v: AppView) => void }) {
  const tabs = NAV_TABS.filter((t) => !t.localOnly || import.meta.env.DEV);
  return (
    <nav className="card p-1.5 flex flex-col gap-0.5">
      {tabs.map(({ view: v, label }) => (
        <button
          type="button"
          key={v}
          onClick={() => onChange(v)}
          className={`w-full text-left px-3 py-2 text-sm rounded-lg font-medium transition-colors flex items-center gap-2 ${
            view === v
              ? "bg-verden-600 text-white shadow-sm"
              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          }`}
        >
          {label}
          {v === "redzone-live" && <LiveCount />}
          {v === "backfills" && <BackfillNavBadge />}
        </button>
      ))}
    </nav>
  );
}
