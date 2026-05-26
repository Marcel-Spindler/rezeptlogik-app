import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { DataBundle, WeekRecipe } from "./types";
import { PlanningView } from "./PlanningView";
import { BreakdownEquipmentView } from "./BreakdownEquipmentView";
import { WmsLiveView } from "./WmsLiveView";
import type { UiLocale } from "./i18n";
import { usePlanningOasisData } from "./planningOasisData";
import { loadFactorDailyMeta, type FactorDailyMeta } from "./planningTruthData";
import { PlanningOasisAgentForm } from "./PlanningOasisAgentForm";
import { runSplitForRecipeLike } from "./runPlanning";
import { refreshRampUpDataOnStart } from "./dataSource";
import { recordRampUpSnapshot, getRampUpHistory, type RampUpSnapshot, type RampUpChangeEvent } from "./rampUpHistory";

const LinePlanningSection = lazy(() => import("./LinePlanningView").then((module) => ({ default: module.LinePlanningView })));
const RackSection = lazy(() => import("./RackV2View").then((module) => ({ default: module.RackV2View })));

type OasisSection = "cockpit" | "lines" | "rack" | "breakdown" | "wms" | "recipes" | "agent";
type SourceHealthStatus = "ok" | "warn" | "missing" | "checking";
type GsheetRegistry = {
  generatedAt: string;
  spreadsheetCount: number;
  spreadsheets: Array<{
    spreadsheetId: string;
    title: string;
    purpose: string;
    aliases: string[];
    tags: string[];
    envKey?: string;
    tabHint?: string;
    dumpFile: string;
    generatedAt: string;
    sheetCount: number;
    totalRows: number;
    sheets: Array<{
      title: string;
      rowCount: number;
      columnCount: number;
      hidden: boolean;
    }>;
  }>;
  extraSources?: Array<{
    type: string;
    label: string;
    sourceId: string;
    purpose: string;
    outputFiles: string[];
  }>;
};

const OASIS_SECTIONS: readonly OasisSection[] = ["cockpit", "lines", "rack", "breakdown", "wms", "recipes", "agent"] as const;
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

function getFulfillmentSplit(recipe: WeekRecipe): { dkseFriday: number; deFriday: number; deSunday: number; benl: number } {
  const deFriday = Math.round((recipe.verdenVolume.DE ?? 0) / 2);
  const deSunday = Math.max(0, (recipe.verdenVolume.DE ?? 0) - deFriday);
  return {
    dkseFriday: recipe.verdenVolume.DKSE ?? 0,
    deFriday,
    deSunday,
    benl: recipe.verdenVolume.BENL ?? 0,
  };
}

function inferMhdDays(recipeName: string): number {
  const fishMarkers = ["lachs", "salmon", "fisch", "cod", "kabeljau", "shrimp", "garnele", "tuna", "thunfisch"];
  const normalized = recipeName.toLowerCase();
  return fishMarkers.some((marker) => normalized.includes(marker)) ? 9 : 13;
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

function gsheetTagTone(tag: string): string {
  if (tag === "truth" || tag === "forecast") return "bg-sky-50 text-sky-700 ring-sky-200";
  if (tag === "equipment" || tag === "batch" || tag === "process") return "bg-violet-50 text-violet-700 ring-violet-200";
  if (tag === "planning-oase" || tag === "kpl" || tag === "ops") return "bg-amber-50 text-amber-700 ring-amber-200";
  if (tag === "quality" || tag === "shelf-life") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  return "bg-slate-50 text-slate-600 ring-slate-200";
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
    }).catch(() => {
      // Promise.all kann theoretisch nicht ablehnen (jeder Mapper hat try/catch),
      // aber .catch() verhindert unhandled-rejection-Warnungen.
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return health;
}

function useGsheetRegistry(): GsheetRegistry | null {
  const [registry, setRegistry] = useState<GsheetRegistry | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/data/gsheet-sources.json?ts=${Date.now()}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<GsheetRegistry>;
      })
      .then((payload) => {
        if (!cancelled) setRegistry(payload);
      })
      .catch(() => {
        if (!cancelled) setRegistry(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return registry;
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

  const { data: oasisData } = usePlanningOasisData();
  const sourceHealth = useOasisSourceHealth();
  const gsheetRegistry = useGsheetRegistry();

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
  const batchSplitWeekList = useMemo(() => {
    return weekMeals.map((meal) => ({
      meal,
      mhdDays: inferMhdDays(meal.recipeName),
      split: getFulfillmentSplit(meal),
    }));
  }, [weekMeals]);
  const [rampUpHistoryMap, setRampUpHistoryMap] = useState<Map<string, RampUpSnapshot[]>>(new Map());
  const [rampUpChanges, setRampUpChanges] = useState<RampUpChangeEvent[]>([]);
  const [rampUpBannerDismissed, setRampUpBannerDismissed] = useState(false);

  useEffect(() => {
    if (!data.weekRecipes?.length) return;
    const { changes, history } = recordRampUpSnapshot(week, data.weekRecipes);
    const allCodes = new Set(data.weekRecipes.filter(r => r.hfWeek === week).map(r => r.code));
    const histMap = new Map<string, RampUpSnapshot[]>();
    for (const code of allCodes) histMap.set(code, history.filter(s => code in s.volumes));
    setRampUpHistoryMap(histMap);
    if (changes.length > 0) {
      setRampUpChanges(changes);
      setRampUpBannerDismissed(false);
    }
  }, [data.weekRecipes, week]);

  const recipeIntelByDigit = useMemo(() => {
    const map = new Map<string, NonNullable<(typeof oasisData)>["recipes"][string]>();
    for (const intel of Object.values(oasisData?.recipes ?? {})) {
      map.set(intel.recipeDigitKey, intel);
    }
    return map;
  }, [oasisData]);
  const cockpitLineV2 = useMemo(() => {
    return weekMeals.map((meal) => {
      const split = getFulfillmentSplit(meal);
      const mhdDays = inferMhdDays(meal.recipeName);
      const runSplit = runSplitForRecipeLike({
        verdenVolume: meal.verdenVolume,
      });
      let run1Target = Math.max(0, runSplit.firstRun.total);
      let run2Target = Math.max(0, runSplit.secondRun);
      const totalTarget = Math.max(0, runSplit.upliftTotal);

      const normalizedMealName = meal.recipeName.toLowerCase().replace(/\[[^\]]*\]/g, "").trim();
      const intelByName = Object.values(oasisData?.recipes ?? {}).find((entry) => {
        const n = entry.recipeName.toLowerCase();
        return n.includes(normalizedMealName) || normalizedMealName.includes(n);
      }) ?? null;
      const intel = oasisData?.recipes[meal.code] ?? recipeIntelByDigit.get(recipeDigitKey(meal.code)) ?? intelByName;
      const subOrders = (intel?.workOrders ?? []).filter((wo) => wo.subRecipeName.trim().length > 0);
      const hasSubMeals = subOrders.length > 0 || (intel?.uniqueSubRecipes.length ?? 0) > 0;

      // Harte Cockpit-V2-Regel: Submeal-Rezepte laufen immer in 2 Runs.
      if (hasSubMeals && totalTarget > 1) {
        run2Target = Math.max(1, Math.round(totalTarget * 0.35));
        if (run2Target >= totalTarget) run2Target = totalTarget - 1;
        run1Target = totalTarget - run2Target;
      }

      const observedSubTotal = subOrders.reduce((sum, wo) => sum + Math.max(0, Math.round(wo.targetPortions || 0)), 0);
      const boundedObserved = observedSubTotal > 0 && observedSubTotal <= Math.round(totalTarget * 1.15)
        ? observedSubTotal
        : 0;
      const subTotal = hasSubMeals ? Math.max(1, boundedObserved || Math.round(intel?.totalTargetPortions ?? 0) || totalTarget) : 0;
      let subRun1 = 0;
      let subRun2 = 0;
      if (subTotal > 0) {
        const run2Share = totalTarget > 0 ? run2Target / totalTarget : 0.35;
        subRun2 = Math.max(1, Math.round(subTotal * Math.max(0.2, Math.min(0.8, run2Share))));
        if (subRun2 >= subTotal) subRun2 = subTotal - 1;
        subRun1 = Math.max(0, subTotal - subRun2);
      }

      return {
        meal,
        split,
        mhdDays,
        run1Target,
        run2Target,
        subRun1,
        subRun2,
        subCount: Math.max(subOrders.length, intel?.uniqueSubRecipes.length ?? 0),
      };
    });
  }, [weekMeals, oasisData, recipeIntelByDigit]);

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

        <div className="mt-4 flex flex-wrap gap-2 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            {([
              ["cockpit", "Cockpit"],
              ["lines", "Linienplanung"],
              ["rack", "Rack"],
              ["breakdown", "Breakdown+"],
              ["wms", "WMS Live"],
              ["recipes", "Rezept-Fokus"],
              ["agent", "Agent Setup"]
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
          <button
            onClick={async () => {
              await refreshRampUpDataOnStart();
              window.location.reload();
            }}
            className="px-3 py-1.5 rounded-lg text-sm font-semibold ring-1 bg-amber-50 text-amber-700 ring-amber-300 hover:bg-amber-100 flex items-center gap-2"
            title="Ramp Up Forecast Zahlen aktualisieren"
          >
            🔄 Ramp-Up aktualisieren
          </button>
        </div>

        {rampUpChanges.length > 0 && !rampUpBannerDismissed && (
          <div className="mt-4 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-black tracking-wide text-amber-800">
                  &#9888; {rampUpChanges.length} {rampUpChanges.length === 1 ? "Rezept hat" : "Rezepte haben"} neue Portionszahlen
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {rampUpChanges.map(c => (
                    <div key={c.code} className="rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-xs flex items-center gap-2">
                      <span className="font-mono font-bold text-slate-700">{c.code}</span>
                      <span className="text-slate-500 tabular-nums">{fmtNum(c.oldTotal)} → {fmtNum(c.newTotal)}</span>
                      <RampUpDeltaBadge delta={c.delta} />
                    </div>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setRampUpBannerDismissed(true)}
                className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-amber-200 text-amber-800 text-[10px] font-bold hover:bg-amber-300 transition-colors"
              >
                ✕
              </button>
            </div>
          </div>
        )}

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

        {gsheetRegistry && (
          <details className="mt-4 rounded-2xl border border-slate-200 bg-white/80 p-4">
            <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-black text-slate-900">GSheet Register</div>
                <div className="text-[11px] text-slate-500">
                  {fmtNum(gsheetRegistry.spreadsheetCount)} Sheets sichtbar · letzter Registry-Sync{" "}
                  {new Date(gsheetRegistry.generatedAt).toLocaleString("de-DE")}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700 ring-1 ring-slate-200">
                  Inventory live in OASE
                </span>
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700 ring-1 ring-amber-200">
                  alle bekannten GSheets gelistet
                </span>
              </div>
            </summary>

            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {gsheetRegistry.spreadsheets.map((sheet) => (
                <div key={sheet.spreadsheetId} className="rounded-2xl border border-slate-200 bg-slate-50/80 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-black text-slate-900">{sheet.title}</div>
                      <div className="mt-1 font-mono text-[11px] text-slate-500">{sheet.spreadsheetId}</div>
                    </div>
                    <a
                      href={sheet.dumpFile}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
                    >
                      Dump
                    </a>
                  </div>

                  <div className="mt-2 text-[12px] leading-5 text-slate-600">{sheet.purpose}</div>

                  <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-semibold">
                    {sheet.tags.map((tag) => (
                      <span key={tag} className={`rounded-full px-2 py-1 ring-1 ${gsheetTagTone(tag)}`}>
                        {tag}
                      </span>
                    ))}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-600">
                    <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
                      <div className="font-semibold text-slate-800">{fmtNum(sheet.sheetCount)} Tabs</div>
                      <div>gesamt {fmtNum(sheet.totalRows)} gelesene Zeilen</div>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
                      <div className="font-semibold text-slate-800">{new Date(sheet.generatedAt).toLocaleString("de-DE")}</div>
                      <div>{sheet.envKey ?? "Registry / Dump"}</div>
                    </div>
                  </div>

                  <div className="mt-3 text-[11px] text-slate-500">
                    {sheet.tabHint ? `Tab-Hinweis: ${sheet.tabHint} · ` : ""}
                    Alias: {sheet.aliases.join(", ")}
                  </div>

                  <div className="mt-3 max-h-28 overflow-auto rounded-xl bg-white p-2 ring-1 ring-slate-200">
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">Tabs</div>
                    <div className="space-y-1 text-[11px] text-slate-600">
                      {sheet.sheets.map((tab) => (
                        <div key={`${sheet.spreadsheetId}-${tab.title}`} className="flex items-center justify-between gap-2">
                          <span className="truncate">{tab.title}{tab.hidden ? " (hidden)" : ""}</span>
                          <span className="shrink-0 font-semibold text-slate-500">{fmtNum(tab.rowCount)} Zeilen</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {!!gsheetRegistry.extraSources?.length && (
              <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-[12px] text-slate-600">
                {gsheetRegistry.extraSources.map((source) => (
                  <div key={source.sourceId}>
                    <span className="font-bold text-slate-800">{source.label}</span>
                    {" · "}
                    {source.sourceId}
                    {" · "}
                    {source.purpose}
                  </div>
                ))}
              </div>
            )}
          </details>
        )}
      </div>

      {section === "cockpit" && (
        <div className="space-y-4">
          <PlanningView
            data={data}
            week={week}
            locale={locale}
            upliftPercent={upliftPercent}
            selectedRecipe={selectedRecipe}
            onSelectRecipe={onSelectRecipe}
            onPlanSnapshotSaved={() => {
              // Snapshot bleibt live verfügbar; die Plating-Automatik startet erst per Klick.
            }}
          />

          <div className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-800">Cockpit-Linie V2 (Vollansicht)</h3>
              <span className="text-[11px] font-semibold text-slate-500">Regelwerk fix: Batch-Split MHD/Fulfillment + 2 Runs inkl. Submeals</span>
            </div>
            <div className="mt-3 overflow-x-auto rounded-lg ring-1 ring-slate-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-2 py-2 text-left">Rezept</th>
                    <th className="px-2 py-2 text-right">MHD</th>
                    <th className="px-2 py-2 text-right">Fr DK/SE</th>
                    <th className="px-2 py-2 text-right">Fr DE-1</th>
                    <th className="px-2 py-2 text-right">So DE-2</th>
                    <th className="px-2 py-2 text-right">BENL</th>
                    <th className="px-2 py-2 text-right text-indigo-700">Run1 Ziel</th>
                    <th className="px-2 py-2 text-right text-teal-700">Run2 Ziel</th>
                    <th className="px-2 py-2 text-right">Submeals</th>
                    <th className="px-2 py-2 text-right text-indigo-700">Sub R1</th>
                    <th className="px-2 py-2 text-right text-teal-700">Sub R2</th>
                  </tr>
                </thead>
                <tbody>
                  {cockpitLineV2.map((row) => (
                    <tr
                      key={row.meal.code}
                      onClick={() => onSelectRecipe?.(row.meal.code)}
                      className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                    >
                      <td className="px-2 py-2">
                        <div className="font-mono font-bold text-slate-700">{row.meal.code}</div>
                        <div className="line-clamp-1 text-[11px] text-slate-500">{row.meal.recipeName}</div>
                      </td>
                      <td className={`px-2 py-2 text-right font-semibold ${row.mhdDays <= 9 ? "text-blue-700" : "text-slate-700"}`}>{row.mhdDays}d</td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-700">{fmtNum(row.split.dkseFriday)}</td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-700">{fmtNum(row.split.deFriday)}</td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-700">{fmtNum(row.split.deSunday)}</td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-700">{fmtNum(row.split.benl)}</td>
                      <td className="px-2 py-2 text-right">
                        <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-bold text-indigo-700">{fmtNum(row.run1Target)}</span>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <span className="inline-flex rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 font-bold text-teal-700">{fmtNum(row.run2Target)}</span>
                      </td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-600">{fmtNum(row.subCount)}</td>
                      <td className="px-2 py-2 text-right">
                        <span className="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-semibold text-indigo-700">{fmtNum(row.subRun1)}</span>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <span className="inline-flex rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 font-semibold text-teal-700">{fmtNum(row.subRun2)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600 ring-1 ring-slate-200">
              Submeal-Regel aktiv: Wenn ein Rezept Submeals hat, wird Run2 immer mitgeplant (mindestens 35%), auch wenn Rohdaten keinen Run2-Eintrag liefern.
            </div>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-800">Batch-Split Automatik (alle Rezepte)</h3>
              <span className="text-[11px] font-semibold text-slate-500">Nur MHD + Fulfillment-Tag</span>
            </div>
            <div className="mt-3 max-h-[32rem] overflow-auto rounded-lg ring-1 ring-slate-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-2 py-2 text-left">Rezept</th>
                    <th className="px-2 py-2 text-right">MHD</th>
                    <th className="px-2 py-2 text-right">Fr DK/SE</th>
                    <th className="px-2 py-2 text-right">Fr DE-1</th>
                    <th className="px-2 py-2 text-right">So DE-2</th>
                    <th className="px-2 py-2 text-right">BENL</th>
                  </tr>
                </thead>
                <tbody>
                  {batchSplitWeekList.map((entry) => (
                    <tr
                      key={entry.meal.code}
                      onClick={() => onSelectRecipe?.(entry.meal.code)}
                      className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                    >
                      <td className="px-2 py-2">
                        <div className="font-mono font-bold text-slate-700">{entry.meal.code}</div>
                        <div className="line-clamp-1 text-[11px] text-slate-500">{entry.meal.recipeName}</div>
                      </td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-700">{entry.mhdDays}d</td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-700">{fmtNum(entry.split.dkseFriday)}</td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-700">{fmtNum(entry.split.deFriday)}</td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-700">{fmtNum(entry.split.deSunday)}</td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-700">{fmtNum(entry.split.benl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {batchSplitWeekList.length === 0 && <div className="mt-2 text-sm text-slate-400">Keine Rezepte für diese KW gefunden.</div>}
            <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600 ring-1 ring-slate-200">
              Regelwerk aktiv: Fisch 9 Tage, sonst 13 Tage. Fulfillment-Split: Fr = DK/SE komplett + DE Split 1, So = DE Split 2, BENL separat ohne feste Packregel.
            </div>
          </div>

          <div className="card p-4">
            <h3 className="text-sm font-bold text-slate-800">Schema-Planung (einheitlich)</h3>
            <ol className="mt-2 space-y-2 text-xs text-slate-700">
              <li className="rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
                <span className="font-semibold">Do / S1:</span> Vorproduktion nach MHD-Fenster starten.
              </li>
              <li className="rounded-lg bg-emerald-50 px-3 py-2 ring-1 ring-emerald-200">
                <span className="font-semibold">Fr / S1:</span> DK/SE komplett + DE Split 1 fulfillment-ready.
              </li>
              <li className="rounded-lg bg-sky-50 px-3 py-2 ring-1 ring-sky-200">
                <span className="font-semibold">So / S1:</span> DE Split 2 fulfillment-ready.
              </li>
            </ol>
          </div>
        </div>
      )}

      {section === "lines" && (
        <Suspense fallback={<div className="card p-6 text-slate-500">Linienplanung wird geladen …</div>}>
          <LinePlanningSection week={week} locale={locale} upliftPercent={upliftPercent} />
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

      {section === "wms" && (
        <WmsLiveView
          data={data}
          week={week}
        />
      )}

      {section === "recipes" && (
        <div className="card p-4">
          <h3 className="text-lg font-bold text-slate-800">Rezept-Fokus aus Planung + Linie</h3>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {weekMeals.map(meal => {
              const intel = oasisData?.recipes[meal.code] ?? null;
              const snaps = rampUpHistoryMap.get(meal.code) ?? [];
              const vals = snaps.map(s => s.volumes[meal.code] ?? 0);
              const delta = rampUpChanges.find(c => c.code === meal.code)?.delta ?? 0;
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
                    <div className="rounded-lg bg-slate-50 p-2 relative">
                      <div className="text-slate-500">Plating</div>
                      <div className="font-bold">{fmtNum(intel?.platingRows.reduce((sum, row) => sum + row.totalAmount, 0) ?? 0)}</div>
                      <div className="absolute bottom-2 right-2 flex items-center gap-1">
                        {delta !== 0 && <RampUpDeltaBadge delta={delta} />}
                        {vals.length >= 2 && <RampUpSparkline values={vals} width={32} height={12} />}
                      </div>
                    </div>
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

      {section === "agent" && (
        <PlanningOasisAgentForm week={week} />
      )}
    </div>
  );
}

function RampUpSparkline({ values, width = 50, height = 14 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + ((max - v) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = values[values.length - 1];
  const first = values[0];
  const stroke = last > first ? "#10b981" : last < first ? "#f43f5e" : "#94a3b8";
  const lastPt = pts.split(" ").pop()!.split(",");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "inline-block", verticalAlign: "middle" }}>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      <circle cx={lastPt[0]} cy={lastPt[1]} r="2" fill={stroke} />
    </svg>
  );
}

function RampUpDeltaBadge({ delta }: { delta: number }) {
  if (delta === 0) return null;
  const up = delta > 0;
  return (
    <span className={`inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold ${up ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
      {up ? "▲" : "▼"} {Math.abs(delta)}
    </span>
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
