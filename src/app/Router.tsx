// View-Dispatch: liest State aus AppContext und rendert die passende Oberfläche.
// Die 8 Fach-Views hängen unverändert dahinter — nur die Chrome drumherum ist neu.
import { Suspense } from "react";
import { useAppState, type AppView } from "./AppContext";
import { Shell, LoadingCard, ErrorCard } from "./Shell";
import { NavTabs, GroupSubTabs } from "./NavTabs";
import { KitchenSurface } from "./KitchenSurface";
import { AppFooter } from "./AppFooter";
import { RecipeDetail } from "../features/recipe-detail/RecipeDetailShell";
import { PlanningOasisView } from "../planning-oasis/PlanningOasisView";
import { ShopfloorKioskSurface } from "./ShopfloorKioskSurface";
import { WeekSelector } from "../components/WeekSelector";
import { RecipeList } from "../components/RecipeList";
import { DataHealthBanner } from "../components/DataHealthBanner";
import { CapacityWarningBanner } from "../components/CapacityWarningBanner";
import { MealCatalogView } from "../features/meal-catalog/MealCatalogView";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { BackfillAlertBanner } from "../features/backfills/BackfillAlertBanner";
import { GlobalSearch } from "../features/global-search/GlobalSearch";
import { resolveRecipeByCode } from "../lib/helpers";
import { lazyWithRetry } from "../lib/lazyWithRetry";

// Schwergewichtige Fach-Views nur bei Bedarf laden — hält den Initial-Bundle
// klein (wichtig für die Kiosk-Laptops). recipe/catalog bleiben eager, weil sie
// die üblichen Landeansichten sind.
const CsvImportView       = lazyWithRetry(() => import("../CsvImportView").then(m => ({ default: m.CsvImportView })), "csv-import");
const KetBreakdownView    = lazyWithRetry(() => import("../KetBreakdownView").then(m => ({ default: m.KetBreakdownView })), "ket-breakdown");
const PetPlanView         = lazyWithRetry(() => import("../PetPlanView").then(m => ({ default: m.PetPlanView })), "pet-plan");
const WhatIfView          = lazyWithRetry(() => import("../WhatIfView").then(m => ({ default: m.WhatIfView })), "what-if");
const RundmailView        = lazyWithRetry(() => import("../RundmailView").then(m => ({ default: m.RundmailView })), "rundmail");
const WmsKwOverviewView   = lazyWithRetry(() => import("../WmsKwOverviewView").then(m => ({ default: m.WmsKwOverviewView })), "wms-kw");
const BlastChillerView    = lazyWithRetry(() => import("../features/blast-chiller/BlastChillerView").then(m => ({ default: m.BlastChillerView })), "blast-chiller");
const AllergenPlatingView = lazyWithRetry(() => import("../features/allergen-plating/AllergenPlatingView").then(m => ({ default: m.AllergenPlatingView })), "allergen-plating");
const PostblastLiveView   = lazyWithRetry(() => import("../features/gsheet-monitor/PostblastLiveView").then(m => ({ default: m.PostblastLiveView })), "postblast-live");
const TransparencyPlanView = lazyWithRetry(() => import("../features/gsheet-monitor/TransparencyPlanView").then(m => ({ default: m.TransparencyPlanView })), "transparency-plan");
const BackfillsView       = lazyWithRetry(() => import("../features/backfills/BackfillsView").then(m => ({ default: m.BackfillsView })), "backfills");
const ArtikelWocheView    = lazyWithRetry(() => import("../features/artikel-woche/ArtikelWocheView").then(m => ({ default: m.ArtikelWocheView })), "artikel-woche");
const FullInventoryView   = lazyWithRetry(() => import("../features/full-inventory/FullInventoryView").then(m => ({ default: m.FullInventoryView })), "full-inventory");
const RedzoneLiveView     = lazyWithRetry(() => import("../features/redzone-live/RedzoneLiveView").then(m => ({ default: m.RedzoneLiveView })), "redzone-live");

function ViewLoading() {
  return <div className="card p-8 text-center text-slate-400 text-sm">Lade Ansicht …</div>;
}

function MainPane({ view }: { view: AppView }) {
  return (
    <Suspense fallback={<ViewLoading />}>
      <MainPaneSwitch view={view} />
    </Suspense>
  );
}

function MainPaneSwitch({ view }: { view: AppView }) {
  const {
    data, selectedWeek, selectedRecipe, upliftPercent,
    recipesByCode, recipesOfWeek, activeRecipe, setSelectedWeek, setSelectedRecipe, setView,
  } = useAppState();
  if (!data) return null;

  switch (view) {
    case "catalog":
      return (
        <MealCatalogView
          catalog={data.mealCatalog ?? {}}
          data={data}
          selectedWeek={selectedWeek}
          upliftPercent={upliftPercent}
          onSelectWeek={setSelectedWeek}
          onOpenRecipe={code => { setSelectedRecipe(code); setView("recipe"); }}
          onOpenPlanning={code => { setSelectedRecipe(code); setView("planning"); }}
          onOpenWms={() => setView("wms")}
        />
      );

    case "recipe":
      return activeRecipe ? (
        <RecipeDetail
          wr={activeRecipe}
          recipe={resolveRecipeByCode(recipesByCode, activeRecipe.code)}
          data={data}
          cookSchedules={data.cookSchedules}
          processSpecs={data.processSpecs ?? {}}
          upliftPercent={upliftPercent}
          allRecipes={recipesOfWeek}
          recipesByCode={recipesByCode}
        />
      ) : (
        <div className="card p-8 text-center text-slate-400">
          <div className="text-lg font-medium">Kein Rezept ausgewählt</div>
          <div className="text-sm mt-1">Wähle ein Rezept aus der Liste links.</div>
        </div>
      );

    case "planning":
      return (
        <PlanningOasisView
          data={data}
          week={selectedWeek}
          locale="de"
          upliftPercent={upliftPercent}
          selectedRecipe={selectedRecipe}
          onSelectRecipe={code => { setSelectedRecipe(code); setView("recipe"); }}
          defaultSection="cockpit"
        />
      );

    case "wo":
      return <KetBreakdownView data={data} selectedWeek={selectedWeek} />;

    case "pet":
      return <PetPlanView data={data} />;

    case "whatif":
      return <WhatIfView data={data} week={selectedWeek} upliftPercent={upliftPercent} locale="de" />;

    case "rundmail":
      return <RundmailView data={data} />;

    case "import":
      return <CsvImportView data={data} />;

    case "wms":
      return <WmsKwOverviewView data={data} />;

    case "blast-chiller":
      return <BlastChillerView data={data} />;

    case "allergen-plating":
      return <AllergenPlatingView data={data} />;

    case "postblast-live":
      return <PostblastLiveView data={data} />;

    case "backfills":
      return <BackfillsView />;

    case "transparency-plan":
      return <TransparencyPlanView />;

    case "redzone-live":
      if (!import.meta.env.DEV) {
        return (
          <div className="card p-8 text-center text-slate-500">
            <div className="text-lg font-semibold text-slate-700">Redzone Live ist online nicht verfügbar</div>
            <div className="text-sm mt-1">Bitte lokal starten (Desktop-Verknüpfung „Rezeptlogik App starten").</div>
          </div>
        );
      }
      return <RedzoneLiveView />;

    case "artikel-woche":
      return (
        <ArtikelWocheView
          data={data}
          selectedWeek={selectedWeek}
          upliftPercent={upliftPercent}
        />
      );

    case "full-inventory":
      return <FullInventoryView data={data} week={selectedWeek} />;
  }
}

const BOT_VIEWS = new Set<AppView>(["blast-chiller", "allergen-plating"]);

function FullApp() {
  const state = useAppState();
  const {
    data, selectedWeek, view, upliftPercent, searchText,
    weeks, weekRecipes, recipesByCode, recipesOfWeek, filteredRecipes, activeRecipe,
    totals, plannedTotal, prevWeek, weekDelta,
    setSelectedWeek, setSelectedRecipe, setView, setUpliftPercent, setSearchText,
  } = state;
  if (!data) return null;

  // Bot-Views: nur NavTabs + vollbreiter Inhalt, kein WeekSelector/RecipeList
  if (BOT_VIEWS.has(view)) {
    return (
      <Shell>
        <div className="flex gap-4">
          <div className="w-48 shrink-0">
            <NavTabs view={view} onChange={setView} />
          </div>
          <main className="flex-1 min-w-0">
            <GroupSubTabs view={view} onChange={setView} />
            <ErrorBoundary resetKey={view} label={view}><MainPane view={view} /></ErrorBoundary>
          </main>
        </div>
      </Shell>
    );
  }

  // KET Plan / WO braucht die volle Bildschirmbreite (WO-Liste + Kochanweisungen
  // + Breakdown nebeneinander) — breiterer Rahmen, schmalere Sidebar, und keine
  // Rezept-Liste (die KET-Ansicht nutzt sie nicht und ihre Länge würde sonst die
  // Grid-Zeile strecken → grauer Leerraum unter der Karte).
  const woView = view === "wo";

  return (
    <Shell wide={woView}>
      <ErrorBoundary label="banners" fallback={null}>
        <DataHealthBanner data={data} />
        <CapacityWarningBanner data={data} week={selectedWeek} upliftPercent={upliftPercent} />
        <BackfillAlertBanner onOpen={() => setView("backfills")} />
        {/* Übergeordnete Suche (WO / Submeal / SKU / Meal → Flow-Verlauf). Nicht in
            "KET Plan / WO" — dort hat die WO-Ansicht eine eigene Funktion. */}
        {!woView && <div className="mb-4"><GlobalSearch /></div>}
      </ErrorBoundary>
      <div className={`grid grid-cols-12 gap-4 ${woView ? "items-start" : ""}`}>
        <aside className={`col-span-12 space-y-3 ${woView ? "md:col-span-4 lg:col-span-3 xl:col-span-2" : "md:col-span-4 lg:col-span-3"}`}>
          <NavTabs view={view} onChange={setView} />

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

          {!woView && (
            <ErrorBoundary label="recipe-list">
              <RecipeList
                recipes={filteredRecipes}
                allRecipesCount={recipesOfWeek.length}
                recipesByCode={recipesByCode}
                mealCatalog={data.mealCatalog}
                activeCode={activeRecipe?.code}
                selectedWeek={selectedWeek}
                upliftPercent={upliftPercent}
                searchText={searchText}
                onSearchChange={setSearchText}
                onSelect={code => { setSelectedRecipe(code); if (view !== "recipe") setView("recipe"); }}
              />
            </ErrorBoundary>
          )}
        </aside>

        <main className={`col-span-12 min-w-0 ${woView ? "md:col-span-8 lg:col-span-9 xl:col-span-10" : "md:col-span-8 lg:col-span-9"}`}>
          <GroupSubTabs view={view} onChange={setView} />
          <ErrorBoundary resetKey={view} label={view}><MainPane view={view} /></ErrorBoundary>
        </main>
      </div>

      <ErrorBoundary label="footer" fallback={null}>
        <AppFooter data={data} selectedWeek={selectedWeek} upliftPercent={upliftPercent} />
      </ErrorBoundary>
    </Shell>
  );
}

export function Router() {
  const {
    data, error, kitchenMode, rundmailMode, surface,
    weeks, weekRecipes, selectedWeek, upliftPercent, kitchenLinkCopied,
    setSelectedWeek, setKitchenLinkCopied,
  } = useAppState();

  // Redzone surface: standalone, no DataBundle required.
  // Braucht den lokalen WMS-Server (Snowflake-Browser-SSO) — die deployte Cloud
  // Function hat aktuell keinen gültigen Snowflake-Key, deshalb online gesperrt.
  if (surface === "redzone") {
    if (!import.meta.env.DEV) {
      return (
        <Shell>
          <div className="card p-8 text-center text-slate-500">
            <div className="text-lg font-semibold text-slate-700">Redzone Live ist online nicht verfügbar</div>
            <div className="text-sm mt-1">Bitte lokal starten (Desktop-Verknüpfung „Rezeptlogik App starten").</div>
          </div>
        </Shell>
      );
    }
    return (
      <Shell>
        <ErrorBoundary label="redzone">
          <Suspense fallback={<LoadingCard />}>
            <RedzoneLiveView />
          </Suspense>
        </ErrorBoundary>
      </Shell>
    );
  }

  if (error) return <ErrorCard message={error} />;
  if (!data) return <LoadingCard />;

  if (rundmailMode) {
    return (
      <Shell>
        <ErrorBoundary label="rundmail"><RundmailView data={data} /></ErrorBoundary>
      </Shell>
    );
  }

  if (kitchenMode) {
    return (
      <ErrorBoundary label="kitchen">
        <KitchenSurface
          data={data}
          weeks={weeks}
          weekRecipes={weekRecipes}
          selectedWeek={selectedWeek}
          onWeekChange={setSelectedWeek}
          upliftPercent={upliftPercent}
          kitchenLinkCopied={kitchenLinkCopied}
          onLinkCopiedChange={setKitchenLinkCopied}
        />
      </ErrorBoundary>
    );
  }

  if (surface === "shopfloor") {
    return (
      <ErrorBoundary label="shopfloor">
        <ShopfloorKioskSurface data={data} selectedWeek={selectedWeek} />
      </ErrorBoundary>
    );
  }

  return <FullApp />;
}
