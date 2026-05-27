import { useEffect, useMemo, useState } from "react";
import { loadData, refreshRampUpDataOnStart, refreshOperationalData, subscribeRampUpHashChanges } from "./dataSource";
import type { DataBundle, WeekRecipe } from "./types";
import { getBaseVerdenVolume } from "./equipment";
import { formatDateTime } from "./i18n";
import { RecipeDetail } from "./RecipeDetailView";
import { PackingScheduleView } from "./PackingScheduleView";
import { PlanningOasisView } from "./planning-oasis/PlanningOasisView";
import { BreakdownEquipmentView } from "./BreakdownEquipmentView";
import { WeekSelector } from "./components/WeekSelector";
import { RecipeList } from "./components/RecipeList";
import { DataHealthBanner } from "./components/DataHealthBanner";
import {
  adjustedPortions, fmtNum, lsGet, usePersistent,
  MARKETS, MARKET_LABEL,
  recipeSearchText,
  isProducedInVerden, resolveRecipeByCode, buildKitchenShareUrl
} from "./helpers";

// ─── Types ─────────────────────────────────────────────────────────────────

type AppView = "recipe" | "planning" | "packing";
type AppSurface = "full" | "kitchen";

const ALL_VIEWS: readonly AppView[] = ["recipe", "planning", "packing"];

// ─── URL helpers ───────────────────────────────────────────────────────────

function resolveSurfaceFromUrl(): AppSurface {
  return new URLSearchParams(window.location.search).get("surface") === "kitchen" ? "kitchen" : "full";
}

// ─── Micro components ──────────────────────────────────────────────────────

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

// ─── Sidebar nav tabs ──────────────────────────────────────────────────────

const NAV_TABS: { view: AppView; label: string }[] = [
  { view: "recipe",   label: "Rezept" },
  { view: "planning", label: "Planning OASE" },
  { view: "packing",  label: "Packing" },
];

// ─── Main App ──────────────────────────────────────────────────────────────

export default function App() {
  const surface = useMemo<AppSurface>(() => resolveSurfaceFromUrl(), []);
  const kitchenMode = surface === "kitchen";

  const [data, setData] = useState<DataBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedWeek, setSelectedWeek] = usePersistent<string>("week", "");
  const [selectedRecipe, setSelectedRecipe] = usePersistent<string | null>("recipe", null);
  const [view, setView] = usePersistent<AppView>("view", "recipe");
  const [upliftPercent, setUpliftPercent] = usePersistent<number>("uplift", 0);
  const [searchText, setSearchText] = useState<string>("");
  const [kitchenLinkCopied, setKitchenLinkCopied] = useState(false);

  // URL params override localStorage
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get("view");
    const weekParam = params.get("week");
    if (kitchenMode) {
      setView("recipe");
    } else if ((ALL_VIEWS as readonly string[]).includes(viewParam ?? "")) {
      setView(viewParam as AppView);
    }
    if (weekParam) {
      setSelectedWeek(weekParam);
      setSelectedRecipe(null);
      setSearchText("");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kitchenMode]);

  // Data loading + live refresh
  useEffect(() => {
    let disposed = false;
    let refreshTimer: number | null = null;
    let unsubscribeRampUp = () => {};

    const loadLatestData = async () => {
      const d = await loadData();
      if (disposed) return;
      setData(d);
      const saved = lsGet<string>("week", "");
      if (!saved || !d.weeks.includes(saved)) {
        const firstWithRecipes = d.weeks.find(w => d.weekRecipes.some(r => r.hfWeek === w));
        setSelectedWeek(firstWithRecipes ?? d.weeks[0] ?? "");
      }
    };

    (async () => {
      try {
        await refreshRampUpDataOnStart();
        void refreshOperationalData();
        await loadLatestData();
        refreshTimer = window.setInterval(() => { void refreshRampUpDataOnStart(); }, 60_000);
        unsubscribeRampUp = subscribeRampUpHashChanges(() => { void loadLatestData(); });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!disposed) setError(msg);
      }
    })();

    return () => {
      disposed = true;
      if (refreshTimer !== null) window.clearInterval(refreshTimer);
      unsubscribeRampUp();
    };
  }, []);

  // Derived data
  const weeks = data?.weeks ?? [];
  const weekRecipes = data?.weekRecipes ?? [];
  const recipesByCode = data?.recipes ?? {};

  const recipesOfWeek = useMemo(() =>
    weekRecipes
      .filter(r => r.hfWeek === selectedWeek)
      .filter(isProducedInVerden)
      .filter((r, i, arr) => arr.findIndex(x => x.code === r.code) === i)
      .sort((a, b) => adjustedPortions(getBaseVerdenVolume(b), upliftPercent) - adjustedPortions(getBaseVerdenVolume(a), upliftPercent)),
    [weekRecipes, selectedWeek, upliftPercent]
  );

  const searchNeedle = searchText.trim().toLowerCase();
  const filteredRecipes = useMemo(() =>
    searchNeedle
      ? recipesOfWeek.filter(r => recipeSearchText(r, recipesByCode[r.code]).includes(searchNeedle))
      : recipesOfWeek,
    [recipesOfWeek, searchNeedle, recipesByCode]
  );

  const totals = useMemo(() => recipesOfWeek.reduce((acc, r) => {
    acc.BENL += r.verdenVolume.BENL; acc.DKSE += r.verdenVolume.DKSE;
    acc.DE   += r.verdenVolume.DE;   acc.base += getBaseVerdenVolume(r);
    return acc;
  }, { BENL: 0, DKSE: 0, DE: 0, base: 0 }), [recipesOfWeek]);

  const plannedTotal = adjustedPortions(totals.base, upliftPercent);

  // Vorwochenvergleich: vorige KW in der sortierten Weeks-Liste
  const prevWeek = useMemo(() => {
    const idx = weeks.indexOf(selectedWeek);
    return idx > 0 ? weeks[idx - 1] : null;
  }, [weeks, selectedWeek]);

  const prevWeekRecipes = useMemo(() =>
    prevWeek
      ? weekRecipes.filter(r => r.hfWeek === prevWeek).filter(isProducedInVerden)
          .filter((r, i, arr) => arr.findIndex(x => x.code === r.code) === i)
      : [],
    [weekRecipes, prevWeek]
  );

  const weekDelta = useMemo(() => {
    if (!prevWeekRecipes.length) return null;
    const prevCodes = new Set(prevWeekRecipes.map(r => r.code));
    const currCodes = new Set(recipesOfWeek.map(r => r.code));
    const prevBase = prevWeekRecipes.reduce((s, r) => s + getBaseVerdenVolume(r), 0);
    const currBase = totals.base;
    return {
      deltaPortions: currBase - prevBase,
      newCodes:     recipesOfWeek.filter(r => !prevCodes.has(r.code)).map(r => r.code),
      droppedCodes: prevWeekRecipes.filter(r => !currCodes.has(r.code)).map(r => r.code),
    };
  }, [recipesOfWeek, prevWeekRecipes, totals.base]);

  const activeRecipe: WeekRecipe | undefined =
    filteredRecipes.find(r => r.code === selectedRecipe)
    ?? filteredRecipes[0]
    ?? recipesOfWeek.find(r => r.code === selectedRecipe)
    ?? recipesOfWeek[0];

  // ── Loading / error states ─────────────────────────────────────────────────

  if (error) return (
    <Shell>
      <div className="card p-6 text-red-700">
        <div className="font-semibold">Fehler beim Laden</div>
        <div className="mt-1 text-sm">{error}</div>
        <div className="mt-2 text-sm text-slate-500">Tipp: <code>npm run import:local</code> ausführen.</div>
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

  // ── Kitchen mode ───────────────────────────────────────────────────────────

  if (kitchenMode) {
    return (
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
                  onChange={e => { setSelectedWeek(e.target.value); setSelectedRecipe(null); setSearchText(""); }}
                >
                  {weeks.map(w => {
                    const n = weekRecipes.filter(r => r.hfWeek === w && isProducedInVerden(r)).length;
                    return <option key={w} value={w}>{w} ({n} Rezepte)</option>;
                  })}
                </select>
              </label>
              <button
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
  }

  // ── Full app ───────────────────────────────────────────────────────────────

  return (
    <Shell>
      <DataHealthBanner data={data} />
      <div className="grid grid-cols-12 gap-4">

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside className="col-span-12 md:col-span-4 lg:col-span-3 space-y-3">

          {/* Navigation */}
          <nav className="card p-1.5 flex flex-col gap-0.5">
            {NAV_TABS.map(({ view: v, label }) => (
              <button key={v} onClick={() => setView(v)}
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
            onWeekChange={w => { setSelectedWeek(w); setSelectedRecipe(null); setSearchText(""); }}
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

          {view === "packing" && (
            data.productionPlan
              ? <PackingScheduleView
                  plan={data.productionPlan}
                  onRecipeClick={code => { setSelectedRecipe(code); setView("recipe"); }}
                />
              : <div className="card p-8 text-center text-slate-400">
                  <div className="text-lg font-medium">Kein Fertigstellungszeitplan</div>
                  <div className="text-sm mt-1">
                    Sheet 6 noch nicht importiert —{" "}
                    <code className="bg-slate-100 px-1 rounded">npm run import:gsheet</code>
                  </div>
                </div>
          )}

        </main>
      </div>

      <footer className="mt-8 pb-6 text-xs text-slate-400 text-center">
        Daten: {formatDateTime("de", data.generatedAt)} ·
        Quelle: {(import.meta.env.VITE_DATA_SOURCE ?? "firestore")} ·
        Standort: Verden (VF)
      </footer>
    </Shell>
  );
}
