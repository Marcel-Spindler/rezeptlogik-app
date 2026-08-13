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
import { resolveRecipeByCode } from "../lib/helpers";

function MainPane({ view }: { view: AppView }) {
  const {
    data, selectedWeek, selectedRecipe, upliftPercent,
    recipesByCode, activeRecipe, setSelectedWeek, setSelectedRecipe, setView,
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
      return <KetBreakdownView data={data} />;

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
  }
}

function FullApp() {
  const state = useAppState();
  const {
    data, selectedWeek, view, upliftPercent, searchText,
    weeks, weekRecipes, recipesByCode, recipesOfWeek, filteredRecipes, activeRecipe,
    totals, plannedTotal, prevWeek, weekDelta,
    setSelectedWeek, setSelectedRecipe, setView, setUpliftPercent, setSearchText,
  } = state;
  if (!data) return null;

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
            activeCode={activeRecipe?.code}
            selectedWeek={selectedWeek}
            upliftPercent={upliftPercent}
            searchText={searchText}
            onSearchChange={setSearchText}
            onSelect={code => { setSelectedRecipe(code); if (view !== "recipe") setView("recipe"); }}
          />
        </aside>

        <main className="col-span-12 md:col-span-8 lg:col-span-9">
          <MainPane view={view} />
        </main>
      </div>

      <AppFooter data={data} selectedWeek={selectedWeek} upliftPercent={upliftPercent} />
    </Shell>
  );
}

export function Router() {
  const {
    data, error, kitchenMode, rundmailMode,
    weeks, weekRecipes, selectedWeek, upliftPercent, kitchenLinkCopied,
    setSelectedWeek, setKitchenLinkCopied,
  } = useAppState();

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
