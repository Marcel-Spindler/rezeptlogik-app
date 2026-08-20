// Rezept-Detail-Ansicht: Header, Markt-Switcher, Tab-Leiste + Such-Feld, Tab-Inhalt.
// 7 Tabs (Engpass-Analyse wurde entfernt).
import { useEffect, useRef, useState } from "react";
import type { CookSchedule, DataBundle, Market, ProcessSpec, Recipe, WeekRecipe } from "../../core/types";
import { marketVariantLabel, MARKET_LANGUAGE_LABEL } from "../../lib/i18n";
import { adjustedPortions, fmtNum, resolveStructureByCode, usePersistent, MARKETS, MARKET_COLOR } from "../../lib/helpers";
import { getBaseVerdenVolume } from "../../lib/equipment";
import { OverviewTab } from "./tabs/OverviewTab";
import { SubRecipesTab } from "./tabs/SubRecipesTab";
import { StructureTab } from "./tabs/StructureTab";
import { WorkflowTab } from "./tabs/WorkflowTab";
import { IngredientsTab } from "./tabs/IngredientsTab";
import { PlatingTab } from "./tabs/PlatingTab";
import { CookTab } from "./tabs/CookTab";
import { RecipeComparePanel } from "./RecipeComparePanel";

export { RampHistorySparkline } from "./shared";

type Tab = "overview" | "subrecipes" | "structure" | "workflow" | "ingredients" | "plating" | "cook";

const TABS: ReadonlyArray<[Tab, (subRecipeCount: number) => string]> = [
  ["overview", () => "Übersicht"],
  ["subrecipes", n => `Sub-Rezepte (${n})`],
  ["structure", () => "Rezeptstruktur"],
  ["workflow", () => "Workflow & Equipment"],
  ["ingredients", () => "Brutto-Zutaten"],
  ["plating", () => "Plating"],
  ["cook", () => "Cook-Schedule"],
];
const VALID_TABS: readonly Tab[] = TABS.map(([k]) => k);

function isValidTab(value: string): value is Tab {
  return (VALID_TABS as readonly string[]).includes(value);
}

interface Props {
  wr: WeekRecipe;
  recipe?: Recipe;
  data: DataBundle;
  cookSchedules: Record<string, CookSchedule>;
  processSpecs: Record<string, ProcessSpec>;
  upliftPercent: number;
  allRecipes?: WeekRecipe[];
  recipesByCode?: Record<string, Recipe>;
}

export function RecipeDetail({ wr, recipe, data, cookSchedules, processSpecs, upliftPercent, allRecipes, recipesByCode }: Props) {
  const [rawTab, setTab] = usePersistent<string>("detail_tab", "overview");
  // Migration: "engpass" (Tab wurde entfernt) oder sonstige Altwerte fallen auf "overview" zurück.
  const tab: Tab = isValidTab(rawTab) ? rawTab : "overview";
  const [market, setMarket] = usePersistent<Market>("detail_market", "BENL");
  const [detailSearch, setDetailSearch] = useState("");
  const [showCompare, setShowCompare] = useState(false);

  const prevCodeRef = useRef("");
  useEffect(() => {
    if (prevCodeRef.current === wr.code) return;
    prevCodeRef.current = wr.code;
    const preferredMarket = MARKETS.find(m => wr.verdenVolume[m] > 0) ?? "BENL";
    const marketsWithData = Object.keys(recipe?.markets ?? {}) as Market[];
    setMarket((marketsWithData.includes(preferredMarket) ? preferredMarket : marketsWithData[0]) ?? preferredMarket);
    setDetailSearch("");
  }, [wr.code, wr.hfWeek, wr.verdenVolume, recipe, setMarket]);

  const md = recipe?.markets[market] ?? recipe?.markets[Object.keys(recipe?.markets ?? {})[0] as Market];
  const structure = resolveStructureByCode(data.structures, wr.code, recipe?.code, recipe?.baseName ?? wr.recipeName);
  const basePortionsTotal = getBaseVerdenVolume(wr);
  const portionsTotal = adjustedPortions(basePortionsTotal, upliftPercent);

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-mono text-xs text-slate-500">{wr.code} · {wr.hfWeek}</div>
            <h2 className="text-xl font-bold leading-tight">{recipe?.baseName || wr.recipeName}</h2>
            <div className="mt-1 flex flex-wrap gap-1 text-xs">
              <span className="pill bg-slate-100 text-slate-700">{wr.preference}</span>
              {MARKETS.map(m => (
                <span key={m} className={`pill ${MARKET_COLOR[m]}`}>
                  {marketVariantLabel("de", m)} · {fmtNum(wr.verdenVolume[m])} {wr.slot[m] ? `(Slot ${wr.slot[m]})` : ""}
                </span>
              ))}
              <span className="pill bg-verden-600 text-white">Σ Verden {fmtNum(portionsTotal)}</span>
              {upliftPercent !== 0 && <span className="pill bg-verden-100 text-verden-700">Basis {fmtNum(basePortionsTotal)} · {upliftPercent > 0 ? "+" : ""}{upliftPercent}%</span>}
              {wr.productionBuffer > 0 && <span className="pill bg-amber-100 text-amber-800">Buffer +{fmtNum(wr.productionBuffer)}</span>}
            </div>
          </div>
          <div className="flex flex-col gap-2 items-end">
            <div className="flex items-center gap-2">
              <button
                onClick={() => window.print()}
                className="px-3 py-1.5 text-xs font-medium rounded-lg ring-1 ring-slate-300 bg-white hover:bg-slate-50 text-slate-700 print:hidden"
                title="Arbeitsblatt drucken"
              >
                Drucken
              </button>
              {allRecipes && allRecipes.length > 1 && (
                <button
                  onClick={() => setShowCompare(s => !s)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg ring-1 print:hidden ${showCompare ? "bg-indigo-600 text-white ring-indigo-700" : "ring-slate-300 bg-white hover:bg-slate-50 text-slate-700"}`}
                  title="Rezept vergleichen"
                >
                  Vergleichen
                </button>
              )}
              <div className="inline-flex rounded-lg ring-1 ring-slate-300 bg-white overflow-hidden">
              {MARKETS.map(m => {
                const has = !!recipe?.markets[m];
                return (
                  <button key={m} disabled={!has} onClick={() => setMarket(m)}
                    className={`px-3 py-1.5 text-xs font-medium ${market === m ? "bg-verden-600 text-white" : has ? "hover:bg-slate-50" : "text-slate-300"}`}>
                    {MARKET_LANGUAGE_LABEL[m]}
                  </button>
                );
              })}
            </div>
            </div>
            {md && <div className="font-mono text-[10px] text-slate-400">{md.msku}</div>}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ring-1 transition-colors ${tab === k ? "bg-slate-900 text-white ring-slate-900" : "bg-white ring-slate-300 hover:bg-slate-50 text-slate-700"}`}>
              {label(md?.subRecipes.length ?? 0)}
            </button>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input type="search" value={detailSearch} onChange={e => setDetailSearch(e.target.value)}
            placeholder="Im geöffneten Rezept suchen: Zutat, Sub-Rezept, Step, SKU ..."
            className="min-w-[18rem] flex-1 rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm" />
          {detailSearch && <button className="btn" onClick={() => setDetailSearch("")}>Leeren</button>}
        </div>
      </div>

      {!recipe && <div className="card p-4 text-amber-700">Keine Rezept-Stammdaten für {wr.code} gefunden (CSV-Export prüfen).</div>}

      {recipe && tab === "overview" && (
        <OverviewTab wr={wr} recipe={recipe} market={market} md={md} portionsTotal={portionsTotal} upliftPercent={upliftPercent} productionPlan={data.productionPlan} data={data} />
      )}
      {recipe && tab === "subrecipes" && md && (
        <SubRecipesTab recipeCode={wr.code} md={md} cookSchedules={cookSchedules} detailSearch={detailSearch} />
      )}
      {tab === "structure" && (
        <StructureTab code={wr.code} structure={structure} market={market} recipeName={recipe?.baseName ?? wr.code} />
      )}
      {recipe && tab === "workflow" && md && (
        <WorkflowTab wr={wr} recipe={recipe} md={md} processSpecs={processSpecs} detailSearch={detailSearch} />
      )}
      {recipe && tab === "ingredients" && (
        <IngredientsTab recipe={recipe} market={market} portionsTotal={portionsTotal} wr={wr} shelfLifeBySku={data.shelfLifeBySku ?? {}} generatedAt={data.generatedAt} detailSearch={detailSearch} data={data} selectedWeek={wr.hfWeek} upliftPercent={upliftPercent} />
      )}
      {recipe && tab === "plating" && md && <PlatingTab md={md} detailSearch={detailSearch} />}
      {recipe && tab === "cook" && md && (
        <CookTab wr={wr} md={md} cookSchedules={cookSchedules} portionsTotal={portionsTotal} recipe={recipe} processSpecs={processSpecs} detailSearch={detailSearch} />
      )}

      {showCompare && allRecipes && recipesByCode && (
        <RecipeComparePanel
          currentWr={wr}
          currentRecipe={recipe}
          allRecipes={allRecipes}
          recipesByCode={recipesByCode}
          upliftPercent={upliftPercent}
          market={market}
          onClose={() => setShowCompare(false)}
        />
      )}
    </div>
  );
}
