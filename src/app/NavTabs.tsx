import type { AppView } from "./AppContext";

const NAV_TABS: ReadonlyArray<{ view: AppView; label: string }> = [
  { view: "recipe", label: "Rezept" },
  { view: "planning", label: "Planning OASE" },
  { view: "wo", label: "KET Plan / WO" },
  { view: "pet", label: "PET Plan / Plating" },
  { view: "wms", label: "WMS Übersicht" },
  { view: "whatif", label: "What-If Rechner" },
  { view: "rundmail", label: "Rundmail" },
  { view: "import", label: "CSV Import" },
];

export function NavTabs({ view, onChange }: { view: AppView; onChange: (v: AppView) => void }) {
  return (
    <nav className="card p-1.5 flex flex-col gap-0.5">
      {NAV_TABS.map(({ view: v, label }) => (
        <button
          type="button"
          key={v}
          onClick={() => onChange(v)}
          className={`w-full text-left px-3 py-2 text-sm rounded-lg font-medium transition-colors ${
            view === v
              ? "bg-verden-600 text-white shadow-sm"
              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          }`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
