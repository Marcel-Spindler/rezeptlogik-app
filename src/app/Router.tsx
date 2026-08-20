// View-Dispatch: liest State aus AppContext und rendert die passende Oberfläche.
// Die 8 Fach-Views hängen unverändert dahinter — nur die Chrome drumherum ist neu.
import { useAppState, type AppView } from "./AppContext";
import { Shell, LoadingCard, ErrorCard } from "./Shell";
import { NavTabs } from "./NavTabs";
import { KitchenSurface } from "./KitchenSurface";
import { AppFooter } from "./AppFooter";
import { RecipeDetail } from "../features/recipe-detail/RecipeDetailShell";
import { CsvImportView } from "../CsvImportView";
import { PlanningOasisView } from "../planning-oasis/PlanningOasisView";
import { KetBreakdownView } from "../KetBreakdownView";
import { PetPlanView } from "../PetPlanView";
import { WhatIfView } from "../WhatIfView";
import { RundmailView } from "../RundmailView";
import { WmsKwOverviewView } from "../WmsKwOverviewView";
import { WeekSelector } from "../components/WeekSelector";
import { RecipeList } from "../components/RecipeList";
import { DataHealthBanner } from "../components/DataHealthBanner";
import { CapacityWarningBanner } from "../components/CapacityWarningBanner";
import { MealCatalogView } from "../features/meal-catalog/MealCatalogView";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { BlastChillerView } from "../features/blast-chiller/BlastChillerView";
import { AllergenPlatingView } from "../features/allergen-plating/AllergenPlatingView";
import { PostblastLiveView } from "../features/gsheet-monitor/PostblastLiveView";
import { RedzoneLiveView } from "../features/redzone-live/RedzoneLiveView";
import { resolveRecipeByCode } from "../lib/helpers";

function MainPane({ view }: { view: AppView }) {
  const {
    data, selectedWeek, selectedRecipe, upliftPercent,
    recipesByCode, recipesOfWeek, activeRecipe, setSelectedWeek, setSelectedRecipe, setView,
  } = useAppState();
  if (!data) return null;

  switch (view) {
    case "catalog":
      return (
        <ErrorBoundary>
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
        </ErrorBoundary>
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
            <MainPane view={view} />
          </main>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <DataHealthBanner data={data} />
      <CapacityWarningBanner data={data} week={selectedWeek} upliftPercent={upliftPercent} />
      <div className="grid grid-cols-12 gap-4">
        <aside className="col-span-12 md:col-span-4 lg:col-span-3 space-y-3">
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
        </aside>

        <main className="col-span-12 min-w-0 md:col-span-8 lg:col-span-9">
          <MainPane view={view} />
        </main>
      </div>

      <AppFooter data={data} selectedWeek={selectedWeek} upliftPercent={upliftPercent} />
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
        <RedzoneLiveView />
      </Shell>
    );
  }

  if (error) return <ErrorCard message={error} />;
  if (!data) return <LoadingCard />;

  if (rundmailMode) {
    return (
      <Shell>
        <RundmailView data={data} />
      </Shell>
    );
  }

  if (kitchenMode) {
    return (
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
    );
  }

  return <FullApp />;
}
