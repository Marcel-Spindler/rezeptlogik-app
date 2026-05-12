import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { DataBundle, WeekRecipe } from "./types";
import { PlanningView } from "./PlanningView";
import { BreakdownEquipmentView } from "./BreakdownEquipmentView";
import type { UiLocale } from "./i18n";
import { usePlanningOasisData } from "./planningOasisData";
import { loadFactorDailyMeta, type FactorDailyMeta } from "./planningTruthData";

const LinePlanningSection = lazy(() => import("./LinePlanningView").then((module) => ({ default: module.LinePlanningView })));
const RackSection = lazy(() => import("./RackV2View").then((module) => ({ default: module.RackV2View })));

type OasisSection = "cockpit" | "lines" | "rack" | "breakdown" | "recipes";
type SourceHealthStatus = "ok" | "warn" | "missing" | "checking";

const OASIS_SECTIONS: readonly OasisSection[] = ["cockpit", "lines", "rack", "breakdown", "recipes"] as const;
const OASIS_SOURCE_CHECKS: ReadonlyArray<{ key: string; label: string; path: string; optional?: boolean }> = [
  { key: "app-data", label: "App Data", path: "/data/data.json" },
  { key: "kpl", label: "KPL Dump", path: "/data/gsheet-dump-Kitchen_Priority_List-Verden-2026.json" },
  { key: "forecast", label: "Forecast", path: "/data/gsheet-truth-export/Running Forecast - All Markets.csv" },
  { key: "pdl-de", label: "PDL DE", path: "/data/gsheet-truth-export/Factor_DE - PDL Forecast.csv" },
  { key: "pdl-nor", label: "PDL NOR", path: "/data/gsheet-truth-export/Factor_Nor - PDL Forecast.csv" },
  { key: "daily", label: "Daily", path: "/data/gsheet-truth-export/Factor_Daily - PDL Forecast.csv", optional: true },
  { key: "rack", label: "Rack XLSX", path: "/data/rack/MultiLine-latest.xlsx" },
];

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

function isProducedInVerden(r: WeekRecipe): boolean {
  const c = (r.code ?? "").toUpperCase();
  if (!(c.startsWith("FE") || c.startsWith("FV"))) return false;
  const total = (r.verdenVolume.BENL ?? 0) + (r.verdenVolume.DKSE ?? 0) + (r.verdenVolume.DE ?? 0);
  return total > 0;
}

function recipeDigitKey(raw: string | null | undefined): string {
  const match = String(raw ?? "").trim().toUpperCase().match(/(?:FE|FV)?(\d{4})[A-Z0-9]?/);
  return match?.[1] ?? String(raw ?? "").trim().toUpperCase();
}

function planningRoleTone(role: "factory" | "hybrid" | "supplied" | undefined): string {
  if (role === "hybrid") return "bg-sky-50 text-sky-800 ring-sky-200";
  if (role === "supplied") return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-emerald-50 text-emerald-800 ring-emerald-200";
}

function planningRoleLabel(role: "factory" | "hybrid" | "supplied" | undefined): string {
  if (role === "hybrid") return "hybrid / Übergang";
  if (role === "supplied") return "zugeliefert";
  return "eigene Fabrikproduktion";
}

function isOasisSection(value: string | null): value is OasisSection {
  return OASIS_SECTIONS.includes(value as OasisSection);
}

function oasisSectionFromUrl(fallback: OasisSection): OasisSection {
  if (typeof window === "undefined") return fallback;
  const param = new URLSearchParams(window.location.search).get("oase");
  return isOasisSection(param) ? param : fallback;
}

function writeOasisSectionToUrl(section: OasisSection): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("oase", section);
  window.history.replaceState(null, "", url.toString());
}

function sourceHealthTone(status: SourceHealthStatus): string {
  if (status === "ok") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (status === "warn") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (status === "missing") return "bg-rose-50 text-rose-800 ring-rose-200";
  return "bg-slate-50 text-slate-500 ring-slate-200";
}

function useOasisSourceHealth(): Array<{ key: string; label: string; status: SourceHealthStatus; detail: string }> {
  const [health, setHealth] = useState<Array<{ key: string; label: string; status: SourceHealthStatus; detail: string }>>(
    () => OASIS_SOURCE_CHECKS.map(source => ({ key: source.key, label: source.label, status: "checking", detail: "prüft" }))
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all(OASIS_SOURCE_CHECKS.map(async (source) => {
      try {
        const response = await fetch(`${source.path}?ts=${Date.now()}`, { method: "HEAD", cache: "no-store" });
        if (response.ok) {
          const modified = response.headers.get("last-modified");
          return {
            key: source.key,
            label: source.label,
            status: "ok" as SourceHealthStatus,
            detail: modified ? new Date(modified).toLocaleDateString("de-DE") : "geladen",
          };
        }
        return {
          key: source.key,
          label: source.label,
          status: source.optional ? "warn" as SourceHealthStatus : "missing" as SourceHealthStatus,
          detail: source.optional ? "optional fehlt" : `HTTP ${response.status}`,
        };
      } catch {
        return {
          key: source.key,
          label: source.label,
          status: source.optional ? "warn" as SourceHealthStatus : "missing" as SourceHealthStatus,
          detail: source.optional ? "optional fehlt" : "nicht erreichbar",
        };
      }
    })).then((result) => {
      if (!cancelled) setHealth(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return health;
}

export function PlanningOasisView({
  data,
  week,
  locale,
  upliftPercent,
  selectedRecipe,
  onSelectRecipe,
  defaultSection = "cockpit"
}: {
  data: DataBundle;
  week: string;
  locale: UiLocale;
  upliftPercent: number;
  selectedRecipe?: string | null;
  onSelectRecipe?: (recipeCode: string) => void;
  defaultSection?: OasisSection;
}): JSX.Element {
  const [section, setSection] = useState<OasisSection>(() => oasisSectionFromUrl(defaultSection));
  useEffect(() => {
    setSection(oasisSectionFromUrl(defaultSection));
  }, [defaultSection]);
  useEffect(() => {
    writeOasisSectionToUrl(section);
  }, [section]);

  const { data: oasisData, loading, error } = usePlanningOasisData();
  const sourceHealth = useOasisSourceHealth();

  const [factorDailyMeta, setFactorDailyMeta] = useState<FactorDailyMeta | null>(null);
  useEffect(() => {
    loadFactorDailyMeta().then(setFactorDailyMeta).catch(() => setFactorDailyMeta(null));
  }, []);

  const weekMeals = useMemo(() => {
    return data.weekRecipes
      .filter(row => row.hfWeek === week)
      .filter(isProducedInVerden)
      .filter((row, index, all) => all.findIndex(other => other.code === row.code) === index)
      .sort((a, b) => b.totalVerdenVolume - a.totalVerdenVolume);
  }, [data.weekRecipes, week]);

  const weekIntel = oasisData?.weeks[week] ?? null;
  const weekForecastFallback = useMemo(
    () => weekMeals.reduce((sum, m) => sum + m.totalVerdenVolume, 0),
    [weekMeals]
  );
  const focusedCode = selectedRecipe && weekMeals.some(item => item.code === selectedRecipe)
    ? selectedRecipe
    : weekMeals[0]?.code ?? null;
  const focusedIntel = focusedCode ? oasisData?.recipes[focusedCode] ?? oasisData?.recipes[recipeDigitKey(focusedCode)] ?? null : null;

  const plannerRecipes = weekMeals.filter(meal => (weekIntel?.recipes ?? []).some(code => recipeDigitKey(code) === recipeDigitKey(meal.code)));
  const missingInSheet = weekMeals.filter(meal => !(weekIntel?.recipes ?? []).some(code => recipeDigitKey(code) === recipeDigitKey(meal.code)));

  return (
    <div className="space-y-4">
      <div className="card p-5 bg-gradient-to-r from-amber-50 via-white to-sky-50 border-2 border-amber-200">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black tracking-tight text-slate-900">Planning OASE</h2>
            <p className="mt-1 text-sm text-slate-600">
              Wochenplaner, Linienplanung und Spreadsheet-Realität in einem Cockpit.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-white px-3 py-1 ring-1 ring-amber-300 font-semibold">KW {week}</span>
            <span className="rounded-full bg-white px-3 py-1 ring-1 ring-sky-300 font-semibold">{fmtNum(weekMeals.length)} Meals Verden</span>
            {weekIntel && <span className="rounded-full bg-white px-3 py-1 ring-1 ring-emerald-300 font-semibold">{fmtNum(weekIntel.workOrderCount)} Work Orders</span>}
            {weekIntel && <span className="rounded-full bg-white px-3 py-1 ring-1 ring-violet-300 font-semibold">{fmtNum(weekIntel.forecastTotal)} Forecast</span>}
            {factorDailyMeta && (
              <span
                title={`Quelle: ${factorDailyMeta.sourceFile}\nHeruntergeladen: ${new Date(factorDailyMeta.downloadedAt).toLocaleString("de-DE")}`}
                className={`rounded-full px-3 py-1 ring-1 font-semibold ${factorDailyMeta.week === week ? "bg-teal-50 ring-teal-400 text-teal-800" : "bg-orange-50 ring-orange-300 text-orange-700"}`}
              >
                ⚡ Factor Daily {factorDailyMeta.week}{factorDailyMeta.week !== week ? " ≠ KW" : ""} · {fmtNum(factorDailyMeta.rowCount)} Boxen
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-9">
          <OasisStat label="Meals in KW" value={fmtNum(weekMeals.length)} tone="amber" />
          <OasisStat label="Rezepte im Sheet" value={fmtNum(weekIntel?.recipes.length ?? 0)} tone="sky" />
          <OasisStat label="WO Target Portions" value={fmtNum(weekIntel?.totalTargetPortions ?? 0)} tone="emerald" />
          <OasisStat label="LinePlating Σ" value={fmtNum(weekIntel?.platingTotal ?? 0)} tone="violet" />
          <OasisStat label="Forecast Σ" value={fmtNum(weekIntel?.forecastTotal ?? weekForecastFallback)} tone="sky" />
          <OasisStat label="PDL Portionen" value={fmtNum(weekIntel?.pdlPortions ?? 0)} tone="emerald" />
          <OasisStat label="Eigene PDL" value={fmtNum(weekIntel?.factoryPdlPortions ?? 0)} tone="emerald" />
          <OasisStat label="Hybrid PDL" value={fmtNum(weekIntel?.hybridPdlPortions ?? 0)} tone="sky" />
          <OasisStat label="Zulieferung" value={fmtNum(weekIntel?.suppliedPdlPortions ?? 0)} tone="amber" />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {([
            ["cockpit", "Cockpit"],
            ["lines", "Linienplanung"],
            ["rack", "Rack"],
            ["breakdown", "Breakdown+"],
            ["recipes", "Rezept-Fokus"]
          ] as [OasisSection, string][]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSection(key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold ring-1 ${section === key ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5 text-[11px]">
          {sourceHealth.map(source => (
            <span
              key={source.key}
              title={source.detail}
              className={`rounded-full px-2 py-1 font-semibold ring-1 ${sourceHealthTone(source.status)}`}
            >
              {source.label}: {source.status === "ok" ? "ok" : source.status === "warn" ? "prüfen" : source.status === "missing" ? "fehlt" : "..."}
            </span>
          ))}
        </div>
      </div>

      {section === "cockpit" && (
        <div className="grid xl:grid-cols-[1.2fr_0.8fr] gap-4">
          <div className="space-y-4">
            <PlanningView
              data={data}
              week={week}
              locale={locale}
              upliftPercent={upliftPercent}
              selectedRecipe={selectedRecipe}
              onSelectRecipe={onSelectRecipe}
            />
          </div>
          <div className="space-y-4">
            <div className="card p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-slate-800">Sheet-Abdeckung</h3>
                {loading && <span className="text-xs text-slate-400">lädt …</span>}
              </div>
              {error && <div className="mt-2 text-sm text-rose-700">{error}</div>}
              {!error && (
                <>
                  {weekIntel && (
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-lg bg-slate-50 p-2"><div className="text-slate-500">Truth-Rezepte</div><div className="font-bold text-slate-900">{fmtNum(weekIntel.truthRecipeCount)}</div></div>
                      <div className="rounded-lg bg-slate-50 p-2"><div className="text-slate-500">Gematcht</div><div className="font-bold text-slate-900">{fmtNum(weekIntel.matchedRecipeCount)}</div></div>
                      <div className="rounded-lg bg-slate-50 p-2"><div className="text-slate-500">PDL Boxen</div><div className="font-bold text-slate-900">{fmtNum(weekIntel.pdlBoxCount)}</div></div>
                      <div className="rounded-lg bg-slate-50 p-2"><div className="text-slate-500">Forecast DE</div><div className="font-bold text-slate-900">{fmtNum(weekIntel.forecastByMarket.germany)}</div></div>
                      <div className="rounded-lg bg-emerald-50 p-2 ring-1 ring-emerald-200"><div className="text-emerald-700">Eigene Meals</div><div className="font-bold text-emerald-900">{fmtNum(weekIntel.factoryRecipeCount)}</div></div>
                      <div className="rounded-lg bg-sky-50 p-2 ring-1 ring-sky-200"><div className="text-sky-700">Hybrid</div><div className="font-bold text-sky-900">{fmtNum(weekIntel.hybridRecipeCount)}</div></div>
                      <div className="rounded-lg bg-amber-50 p-2 ring-1 ring-amber-200"><div className="text-amber-700">Zugeliefert</div><div className="font-bold text-amber-900">{fmtNum(weekIntel.suppliedRecipeCount)}</div></div>
                      <div className="rounded-lg bg-emerald-50 p-2 ring-1 ring-emerald-200"><div className="text-emerald-700">Eigene PDL-Port.</div><div className="font-bold text-emerald-900">{fmtNum(weekIntel.factoryPdlPortions)}</div></div>
                      <div className="rounded-lg bg-sky-50 p-2 ring-1 ring-sky-200"><div className="text-sky-700">Hybrid-PDL</div><div className="font-bold text-sky-900">{fmtNum(weekIntel.hybridPdlPortions)}</div></div>
                      <div className="rounded-lg bg-amber-50 p-2 ring-1 ring-amber-200"><div className="text-amber-700">Zuliefer-PDL</div><div className="font-bold text-amber-900">{fmtNum(weekIntel.suppliedPdlPortions)}</div></div>
                    </div>
                  )}
                  {weekIntel && (
                    <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
                      Eigene Fabrik-Meals sind über Wochenrezepte, KET oder LinePlating abgesichert. Hybrid markiert Meals mit lokaler Produktionsfreigabe, die in dieser KW aber nur als PDL-Kontext ohne operative KET/LinePlating-Signale auftauchen.
                    </div>
                  )}
                  <div className="mt-3 text-xs text-slate-500">Im Spreadsheet bereits sichtbar</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {plannerRecipes.map(meal => (
                      <button key={meal.code} onClick={() => onSelectRecipe?.(meal.code)} className="rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-100">
                        {meal.code}
                      </button>
                    ))}
                    {plannerRecipes.length === 0 && <span className="text-sm text-slate-400">Keine gematchten Rezepte.</span>}
                  </div>
                  {missingInSheet.length > 0 && (
                    <>
                      <div className="mt-4 text-xs text-slate-500">Noch nicht im Sheet gespiegelt</div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {missingInSheet.map(meal => (
                          <button key={meal.code} onClick={() => onSelectRecipe?.(meal.code)} className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100">
                            {meal.code}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            <div className="card p-4">
              <h3 className="text-sm font-bold text-slate-800">Top Cook Methods dieser KW</h3>
              <div className="mt-3 space-y-2">
                {(weekIntel?.methods ?? []).slice(0, 8).map(method => (
                  <div key={method.name} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-slate-700">{method.name}</span>
                    <span className="font-mono font-bold text-slate-900">{fmtNum(method.count)}</span>
                  </div>
                ))}
                {(weekIntel?.methods ?? []).length === 0 && <div className="text-sm text-slate-400">Keine Methoden aus dem Sheet geladen.</div>}
              </div>
            </div>

            <div className="card p-4">
              <h3 className="text-sm font-bold text-slate-800">Rezept-Fokus</h3>
              {!focusedCode && <div className="mt-2 text-sm text-slate-400">Kein Rezept ausgewählt.</div>}
              {focusedCode && (
                <>
                  <div className="mt-2 text-xs text-slate-500">Aktuelles Fokus-Rezept</div>
                  <div className="mt-1 font-mono text-sm font-bold text-slate-900">{focusedCode}</div>
                  <div className="text-sm text-slate-600">{focusedIntel?.recipeName ?? data.recipes[focusedCode]?.markets.DE?.recipeNameLocal ?? data.recipes[focusedCode]?.baseName ?? ""}</div>
                  <div className={`mt-2 inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ${planningRoleTone(focusedIntel?.planningRole)}`}>
                    {planningRoleLabel(focusedIntel?.planningRole)}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-slate-50 p-2"><div className="text-slate-500">WO</div><div className="font-bold text-slate-900">{fmtNum(focusedIntel?.workOrders.length ?? 0)}</div></div>
                    <div className="rounded-lg bg-slate-50 p-2"><div className="text-slate-500">Sub-Rezepte</div><div className="font-bold text-slate-900">{fmtNum(focusedIntel?.uniqueSubRecipes.length ?? 0)}</div></div>
                    <div className="rounded-lg bg-slate-50 p-2"><div className="text-slate-500">LinePlating</div><div className="font-bold text-slate-900">{fmtNum(focusedIntel?.platingRows.reduce((sum, row) => sum + row.totalAmount, 0) ?? 0)}</div></div>
                    <div className="rounded-lg bg-slate-50 p-2"><div className="text-slate-500">Methoden</div><div className="font-bold text-slate-900">{fmtNum(focusedIntel?.methods.length ?? 0)}</div></div>
                    <div className="rounded-lg bg-sky-50 p-2 ring-1 ring-sky-200"><div className="text-sky-700">Forecast Σ</div><div className="font-bold text-sky-900">{fmtNum(focusedIntel?.forecastTotal ?? 0)}</div></div>
                    <div className="rounded-lg bg-emerald-50 p-2 ring-1 ring-emerald-200"><div className="text-emerald-700">PDL Portionen</div><div className="font-bold text-emerald-900">{fmtNum(focusedIntel?.pdlPortions ?? 0)}</div></div>
                    <div className="rounded-lg bg-amber-50 p-2 ring-1 ring-amber-200"><div className="text-amber-700">Gap Target vs Forecast</div><div className="font-bold text-amber-900">{fmtNum(focusedIntel?.gaps.targetVsForecast ?? 0)}</div></div>
                    <div className="rounded-lg bg-violet-50 p-2 ring-1 ring-violet-200"><div className="text-violet-700">PDL Boxen</div><div className="font-bold text-violet-900">{fmtNum(focusedIntel?.pdlBoxCount ?? 0)}</div></div>
                  </div>
                  {!!focusedIntel?.pdlLanes.length && (
                    <div className="mt-3">
                      <div className="text-xs text-slate-500">PDL-Lanes</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {focusedIntel.pdlLanes.slice(0, 6).map(lane => (
                          <span key={lane.name} className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 ring-1 ring-slate-300">
                            {lane.name}: {fmtNum(lane.count)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {section === "lines" && (
        <Suspense fallback={<div className="card p-6 text-slate-500">Linienplanung wird geladen …</div>}>
          <LinePlanningSection week={week} locale={locale} />
        </Suspense>
      )}

      {section === "rack" && (
        <Suspense fallback={<div className="card p-6 text-slate-500">Rack wird geladen …</div>}>
          <RackSection
            week={week}
            locale={locale}
            weekRecipes={data.weekRecipes}
            recipes={data.recipes}
            cookSchedules={data.cookSchedules}
            processSpecs={data.processSpecs}
          />
        </Suspense>
      )}

      {section === "breakdown" && (
        <BreakdownEquipmentView
          data={data}
          week={week}
          upliftPercent={upliftPercent}
          locale={locale}
        />
      )}

      {section === "recipes" && (
        <div className="card p-4">
          <h3 className="text-lg font-bold text-slate-800">Rezept-Fokus aus Planung + Linie</h3>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {weekMeals.map(meal => {
              const intel = oasisData?.recipes[meal.code] ?? null;
              return (
                <button
                  key={meal.code}
                  onClick={() => onSelectRecipe?.(meal.code)}
                  className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-slate-400 hover:shadow-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-bold text-slate-500">{meal.code}</span>
                    <span className="text-xs text-slate-400">{fmtNum(meal.totalVerdenVolume)} Port.</span>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-900 line-clamp-2">{meal.recipeName}</div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-slate-50 p-2"><div className="text-slate-500">WO</div><div className="font-bold">{fmtNum(intel?.workOrders.length ?? 0)}</div></div>
                    <div className="rounded-lg bg-slate-50 p-2"><div className="text-slate-500">Plating</div><div className="font-bold">{fmtNum(intel?.platingRows.reduce((sum, row) => sum + row.totalAmount, 0) ?? 0)}</div></div>
                    <div className="rounded-lg bg-sky-50 p-2"><div className="text-sky-700">Forecast</div><div className="font-bold text-sky-900">{fmtNum(intel?.forecastTotal ?? 0)}</div></div>
                    <div className="rounded-lg bg-emerald-50 p-2"><div className="text-emerald-700">PDL</div><div className="font-bold text-emerald-900">{fmtNum(intel?.pdlPortions ?? 0)}</div></div>
                  </div>
                  <div className={`mt-3 inline-flex rounded-full px-2 py-1 text-[10px] font-semibold ring-1 ${planningRoleTone(intel?.planningRole)}`}>
                    {planningRoleLabel(intel?.planningRole)}
                  </div>
                  {intel && intel.methods.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {intel.methods.slice(0, 4).map(method => (
                        <span key={method} className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800 ring-1 ring-sky-200">{method}</span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function OasisStat({ label, value, tone }: { label: string; value: string; tone: "amber" | "sky" | "emerald" | "violet" }): JSX.Element {
  const tones: Record<string, string> = {
    amber: "bg-amber-100 text-amber-900 ring-amber-300",
    sky: "bg-sky-100 text-sky-900 ring-sky-300",
    emerald: "bg-emerald-100 text-emerald-900 ring-emerald-300",
    violet: "bg-violet-100 text-violet-900 ring-violet-300"
  };
  return (
    <div className={`rounded-xl px-3 py-2 ring-1 ${tones[tone]}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70 font-bold">{label}</div>
      <div className="text-xl font-black tabular-nums">{value}</div>
    </div>
  );
}
