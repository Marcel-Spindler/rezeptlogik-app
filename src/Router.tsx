// View-Dispatch: liest State aus AppContext und rendert die passende View.
import { useAppState, ALL_VIEWS, type AppView } from "./AppContext";
import { RecipeDetail } from "./RecipeDetailView";
import { CsvImportView } from "./CsvImportView";
import { PlanningOasisView } from "./planning-oasis/PlanningOasisView";
import { BreakdownEquipmentView } from "./BreakdownEquipmentView";
import { KetBreakdownView } from "./KetBreakdownView";
import { WhatIfView } from "./WhatIfView";
import { RundmailView } from "./RundmailView";
import { WeekSelector } from "./components/WeekSelector";
import { RecipeList } from "./components/RecipeList";
import { DataHealthBanner } from "./components/DataHealthBanner";
import { CapacityWarningBanner } from "./components/CapacityWarningBanner";
import { formatDateTime } from "./i18n";
import { buildKitchenShareUrl, resolveRecipeByCode, isProducedInVerden } from "./helpers";
import { exportWeeklyCookPlanPDF } from "./planExport";

const NAV_TABS: { view: AppView; label: string }[] = [
  { view: "recipe",    label: "Rezept" },
  { view: "planning",  label: "Planning OASE" },
  { view: "wo",        label: "KET Plan / WO" },
  { view: "whatif",    label: "What-If Rechner" },
  { view: "rundmail",  label: "Rundmail" },
  { view: "import",    label: "CSV Import" },
];

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="mx-auto max-w-screen-2xl px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-verden-600 flex items-center justify-center">
              <span className="text-white text-xs font-bold">F</span>
            </div>
            <div>
              <div className="text-sm font-bold tracking-tight text-slate-900 leading-none">Factor OPS Planner</div>
              <div className="text-[10px] text-slate-400 leading-none mt-0.5">Verden · Ramp-Up 2026</div>
            </div>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-screen-2xl px-4 py-4">{children}</div>
    </div>
  );
}

export function Router() {
  const state = useAppState();
  const {
    data, error, kitchenMode, rundmailMode,
    selectedWeek, selectedRecipe, view, upliftPercent, searchText,
    weeks, weekRecipes, recipesByCode, recipesOfWeek, filteredRecipes, activeRecipe,
    totals, plannedTotal, prevWeek, weekDelta, kitchenLinkCopied,
    setSelectedWeek, setSelectedRecipe, setView, setUpliftPercent,
    setSearchText, setKitchenLinkCopied,
  } = state;

  if (error) return (
    <Shell>
      <div className="card p-6 text-red-700">
        <div className="font-semibold">Fehler beim Laden</div>
        <div className="mt-1 text-sm">{error}</div>
        <div className="mt-2 text-sm text-slate-500">
          Tipp: <code>npm run import:local</code> ausführen.
        </div>
      </div>
    </Shell>
  );

  if (!data) return (
    <Shell>
      <div className="card p-8 flex items-center gap-3 text-slate-500">
        <svg className="animate-spin w-5 h-5 text-verden-600" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
        </svg>
        Lade Daten…
      </div>
    </Shell>
  );

  if (rundmailMode) return (
    <Shell><RundmailView data={data} /></Shell>
  );

  if (kitchenMode) return (
    <Shell>
      <div className="card p-4 mb-4 bg-gradient-to-r from-amber-50 via-white to-emerald-50 ring-1 ring-amber-200">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-amber-700">Küchenmodus</div>
            <div className="text-sm font-semibold text-slate-800">Breakdown-Rechner</div>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Kalenderwoche
              <select
                className="mt-1 block min-w-[16rem] rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm"
                value={selectedWeek}
                onChange={e => setSelectedWeek(e.target.value)}
              >
                {weeks.map(w => {
                  const n = weekRecipes.filter(r => r.hfWeek === w && isProducedInVerden(r)).length;
                  return <option key={w} value={w}>{w} ({n} Rezepte)</option>;
                })}
              </select>
            </label>
            <button
              type="button"
              className={`mb-0.5 rounded-lg px-3 py-2 text-xs font-semibold ring-1 ${kitchenLinkCopied ? "bg-emerald-100 text-emerald-800 ring-emerald-300" : "bg-white text-slate-700 ring-slate-300"}`}
              onClick={() => {
                navigator.clipboard.writeText(buildKitchenShareUrl(selectedWeek)).then(() => {
                  setKitchenLinkCopied(true);
                  setTimeout(() => setKitchenLinkCopied(false), 2000);
                });
              }}
            >
              {kitchenLinkCopied ? "✓ Link kopiert" : "Küchen-Link kopieren"}
            </button>
          </div>
        </div>
      </div>
      <BreakdownEquipmentView data={data} week={selectedWeek} upliftPercent={upliftPercent} locale="de" />
    </Shell>
  );

  // ── Full app ──────────────────────────────────────────────────────────────
  return (
    <Shell>
      <DataHealthBanner data={data} />
      <CapacityWarningBanner data={data} week={selectedWeek} upliftPercent={upliftPercent} />
      <div className="grid grid-cols-12 gap-4">

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside className="col-span-12 md:col-span-4 lg:col-span-3 space-y-3">

          <nav className="card p-1.5 flex flex-col gap-0.5">
            {NAV_TABS.map(({ view: v, label }) => (
              <button type="button" key={v} onClick={() => setView(v)}
                className={`w-full text-left px-3 py-2 text-sm rounded-lg font-medium transition-colors ${
                  view === v
                    ? "bg-verden-600 text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}>
                {label}
              </button>
            ))}
          </nav>

          <WeekSelector
            weeks={weeks}
            selectedWeek={selectedWeek}
            onWeekChange={setSelectedWeek}
            weekRecipes={weekRecipes}
            upliftPercent={upliftPercent}
            onUpliftChange={setUpliftPercent}
            totals={totals}
            plannedTotal={plannedTotal}
            prevWeek={prevWeek}
            weekDelta={weekDelta}
          />

          <RecipeList
            recipes={filteredRecipes}
            allRecipesCount={recipesOfWeek.length}
            recipesByCode={recipesByCode}
            activeCode={activeRecipe?.code}
            selectedWeek={selectedWeek}
            upliftPercent={upliftPercent}
            searchText={searchText}
            onSearchChange={setSearchText}
            onSelect={code => { setSelectedRecipe(code); if (view !== "recipe") setView("recipe"); }}
          />
        </aside>

        {/* ── Main content ─────────────────────────────────────────────────── */}
        <main className="col-span-12 md:col-span-8 lg:col-span-9">
          {view === "recipe" && (
            activeRecipe
              ? <RecipeDetail
                  wr={activeRecipe}
                  recipe={resolveRecipeByCode(recipesByCode, activeRecipe.code)}
                  data={data}
                  cookSchedules={data.cookSchedules}
                  processSpecs={data.processSpecs ?? {}}
                  upliftPercent={upliftPercent}
                />
              : <div className="card p-8 text-center text-slate-400">
                  <div className="text-lg font-medium">Kein Rezept ausgewählt</div>
                  <div className="text-sm mt-1">Wähle ein Rezept aus der Liste links.</div>
                </div>
          )}

          {view === "planning" && (
            <PlanningOasisView
              data={data}
              week={selectedWeek}
              locale="de"
              upliftPercent={upliftPercent}
              selectedRecipe={selectedRecipe}
              onSelectRecipe={code => { setSelectedRecipe(code); setView("recipe"); }}
              defaultSection="cockpit"
            />
          )}

{view === "wo" && (
            <KetBreakdownView data={data} />
          )}

          {view === "whatif" && (
            <WhatIfView data={data} week={selectedWeek} upliftPercent={upliftPercent} locale="de" />
          )}

          {view === "rundmail" && (
            <RundmailView data={data} onNavigate={v => {
              if ((ALL_VIEWS as readonly string[]).includes(v)) setView(v as AppView);
            }} />
          )}

          {view === "import" && <CsvImportView data={data} />}
        </main>
      </div>

      <footer className="mt-8 pb-6 text-xs text-slate-400 text-center space-y-0.5">
        <div>
          Stand: {formatDateTime("de", data.generatedAt)} ·
          Quelle: {(import.meta.env.VITE_DATA_SOURCE ?? "firestore")} ·
          Verden (VF)
        </div>
        <div className="text-slate-300 flex flex-wrap justify-center items-center gap-x-3 gap-y-1">
          <a href="/?surface=rundmail" className="hover:text-slate-500 underline">🔗 Rundmail</a>
          <a href="/?view=whatif" className="hover:text-slate-500 underline">What-If</a>
          <a href="/?view=wo" className="hover:text-slate-500 underline">KET Plan / WO</a>
          <button
            type="button"
            className="hover:text-slate-600 underline"
            onClick={() => exportWeeklyCookPlanPDF(data, selectedWeek, upliftPercent)}
            title="Cook-Timeline für aktuelle KW als PDF drucken"
          >
            🖨 Cook-Plan PDF
          </button>
        </div>
      </footer>
    </Shell>
  );
}
