// Planning-OASE-Cockpit: Wochenplanung, Linienplanung und Rack in einem Bereich.
// Reduziert auf 3 Sections (cockpit/lines/rack) — Mfg-Kalender, Breakdown-intern,
// WMS-intern und Agent-Formular wurden entfernt, die Rezept-Fokus-Kachelansicht
// ebenfalls. Cockpit/Lines/Rack werden in eigenen Phasen komplett neu gebaut;
// hier hängen sie noch unverändert an PlanningView/LinePlanningView/RackV2View.
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type { DataBundle, WeekRecipe } from "../core/types";
import { PlanningView } from "../PlanningView";
import type { UiLocale } from "../lib/i18n";
import { usePlanningOasisData } from "../lib/planningOasisData";
import { loadFactorDailyMeta, type FactorDailyMeta } from "../lib/planningTruthData";
import { refreshRampUpDataOnStart } from "../core/dataSource";
import { recordRampUpSnapshot, type RampUpChangeEvent } from "../lib/rampUpHistory";
import { useOasisSourceHealth, sourceHealthTone } from "./oasisSourceHealth";
import { useGsheetRegistry, GsheetRegistryPanel } from "./GsheetRegistryPanel";

const LinePlanningSection = lazy(() => import("../LinePlanningView").then(m => ({ default: m.LinePlanningView })));
const RackSection = lazy(() => import("../RackV2View").then(m => ({ default: m.RackV2View })));

type OasisSection = "cockpit" | "lines" | "rack";
const OASIS_SECTIONS: readonly OasisSection[] = ["cockpit", "lines", "rack"];
const OASIS_TABS: ReadonlyArray<[OasisSection, string]> = [
  ["cockpit", "Cockpit"],
  ["lines", "Linienplanung"],
  ["rack", "Rack"],
];

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

function recipeDigitKey(raw: string | null | undefined): string {
  const match = String(raw ?? "").trim().toUpperCase().match(/(?:FE|FV)?(\d{4})[A-Z0-9]?/);
  return match?.[1] ?? String(raw ?? "").trim().toUpperCase();
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

function useWeekMeals(data: DataBundle, week: string, oasisData: ReturnType<typeof usePlanningOasisData>["data"]): WeekRecipe[] {
  return useMemo(() => {
    const weekShort = week.match(/W\d{1,2}/)?.[0] ?? week;
    const byCode = new Map<string, WeekRecipe>();
    for (const row of data.weekRecipes) {
      if (row.hfWeek !== week) continue;
      if (!byCode.has(row.code)) byCode.set(row.code, row);
    }
    const weekIntel = oasisData?.weeks[week] ?? null;
    return (weekIntel?.recipes ?? [])
      .map(code => {
        const existing = byCode.get(code);
        if (existing) return existing;
        const intel = oasisData?.recipes[code] ?? oasisData?.recipes[recipeDigitKey(code)] ?? null;
        return {
          hfWeek: week, weekShort, code, recipeName: intel?.recipeName ?? code, preference: "", slot: {},
          verdenVolume: { BENL: 0, DKSE: 0, DE: 0 }, totalVerdenVolume: 0, productionBuffer: 0,
        } satisfies WeekRecipe;
      })
      .sort((a, b) => b.totalVerdenVolume - a.totalVerdenVolume || a.code.localeCompare(b.code, "de"));
  }, [data.weekRecipes, oasisData, week]);
}

function useRampUpChanges(weekRecipes: DataBundle["weekRecipes"], week: string) {
  const [changes, setChanges] = useState<RampUpChangeEvent[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!weekRecipes?.length) return;
    const result = recordRampUpSnapshot(week, weekRecipes);
    if (result.changes.length > 0) {
      setChanges(result.changes);
      setDismissed(false);
    }
  }, [weekRecipes, week]);

  return { changes, dismissed, dismiss: () => setDismissed(true) };
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

function RampUpChangesBanner({ changes, onDismiss }: { changes: RampUpChangeEvent[]; onDismiss: () => void }) {
  return (
    <div className="mt-4 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm font-black tracking-wide text-amber-800">
            &#9888; {changes.length} {changes.length === 1 ? "Rezept hat" : "Rezepte haben"} neue Portionszahlen
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {changes.map(c => (
              <div key={c.code} className="rounded-lg border border-amber-200 bg-white px-3 py-1.5 text-xs flex items-center gap-2">
                <span className="font-mono font-bold text-slate-700">{c.code}</span>
                <span className="text-slate-500 tabular-nums">{fmtNum(c.oldTotal)} → {fmtNum(c.newTotal)}</span>
                <RampUpDeltaBadge delta={c.delta} />
              </div>
            ))}
          </div>
        </div>
        <button onClick={onDismiss} className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-amber-200 text-amber-800 text-[10px] font-bold hover:bg-amber-300 transition-colors">
          ✕
        </button>
      </div>
    </div>
  );
}

function OasisHeader({
  week, weekMeals, weekIntel, factorDailyMeta, sourceHealth, gsheetRegistry,
  section, onSectionChange, rampUpChanges, onRefreshRampUp,
}: {
  week: string;
  weekMeals: WeekRecipe[];
  weekIntel: { workOrderCount: number; forecastTotal: number } | null;
  factorDailyMeta: FactorDailyMeta | null;
  sourceHealth: ReturnType<typeof useOasisSourceHealth>;
  gsheetRegistry: ReturnType<typeof useGsheetRegistry>;
  section: OasisSection;
  onSectionChange: (s: OasisSection) => void;
  rampUpChanges: ReturnType<typeof useRampUpChanges>;
  onRefreshRampUp: () => void;
}) {
  return (
    <div className="card p-5 bg-gradient-to-r from-amber-50 via-white to-sky-50 border-2 border-amber-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-slate-900">Planning OASE</h2>
          <p className="mt-1 text-sm text-slate-600">Wochenplaner, Linienplanung und Spreadsheet-Realität in einem Cockpit.</p>
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

      <div className="mt-4 flex flex-wrap gap-2 items-center justify-between">
        <div className="flex flex-wrap gap-2">
          {OASIS_TABS.map(([key, label]) => (
            <button key={key} onClick={() => onSectionChange(key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold ring-1 ${section === key ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}>
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={onRefreshRampUp}
          className="px-3 py-1.5 rounded-lg text-sm font-semibold ring-1 bg-amber-50 text-amber-700 ring-amber-300 hover:bg-amber-100 flex items-center gap-2"
          title="Ramp Up Forecast Zahlen aktualisieren"
        >
          🔄 Ramp-Up aktualisieren
        </button>
      </div>

      {rampUpChanges.changes.length > 0 && !rampUpChanges.dismissed && (
        <RampUpChangesBanner changes={rampUpChanges.changes} onDismiss={rampUpChanges.dismiss} />
      )}

      <div className="mt-4 flex flex-wrap gap-1.5 text-[11px]">
        {sourceHealth.map(source => (
          <span key={source.key} title={source.detail} className={`rounded-full px-2 py-1 font-semibold ring-1 ${sourceHealthTone(source.status)}`}>
            {source.label}: {source.status === "ok" ? "ok" : source.status === "warn" ? "prüfen" : source.status === "missing" ? "fehlt" : "..."}
          </span>
        ))}
      </div>

      {gsheetRegistry && <GsheetRegistryPanel registry={gsheetRegistry} />}
    </div>
  );
}

function CockpitSection({ data, week, locale, upliftPercent, selectedRecipe, onSelectRecipe }: {
  data: DataBundle; week: string; locale: UiLocale; upliftPercent: number;
  selectedRecipe?: string | null; onSelectRecipe?: (code: string) => void;
}) {
  return (
    <PlanningView
      data={data} week={week} locale={locale} upliftPercent={upliftPercent}
      selectedRecipe={selectedRecipe} onSelectRecipe={onSelectRecipe}
      onPlanSnapshotSaved={() => {}}
    />
  );
}

export function PlanningOasisView({
  data, week, locale, upliftPercent, selectedRecipe, onSelectRecipe, defaultSection = "cockpit",
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
  useEffect(() => { setSection(oasisSectionFromUrl(defaultSection)); }, [defaultSection]);
  useEffect(() => { writeOasisSectionToUrl(section); }, [section]);

  const { data: oasisData } = usePlanningOasisData();
  const sourceHealth = useOasisSourceHealth();
  const gsheetRegistry = useGsheetRegistry();
  const weekMeals = useWeekMeals(data, week, oasisData);
  const rampUpChanges = useRampUpChanges(data.weekRecipes, week);

  const [factorDailyMeta, setFactorDailyMeta] = useState<FactorDailyMeta | null>(null);
  useEffect(() => {
    loadFactorDailyMeta().then(setFactorDailyMeta).catch(() => setFactorDailyMeta(null));
  }, []);

  const weekIntel = oasisData?.weeks[week] ?? null;

  return (
    <div className="space-y-4">
      <OasisHeader
        week={week} weekMeals={weekMeals} weekIntel={weekIntel} factorDailyMeta={factorDailyMeta}
        sourceHealth={sourceHealth} gsheetRegistry={gsheetRegistry} section={section} onSectionChange={setSection}
        rampUpChanges={rampUpChanges}
        onRefreshRampUp={async () => { await refreshRampUpDataOnStart(); window.location.reload(); }}
      />

      {section === "cockpit" && (
        <CockpitSection
          data={data} week={week} locale={locale} upliftPercent={upliftPercent}
          selectedRecipe={selectedRecipe} onSelectRecipe={onSelectRecipe}
        />
      )}

      {section === "lines" && (
        <Suspense fallback={<div className="card p-6 text-slate-500">Linienplanung wird geladen …</div>}>
          <LinePlanningSection week={week} locale={locale} upliftPercent={upliftPercent} />
        </Suspense>
      )}

      {section === "rack" && (
        <Suspense fallback={<div className="card p-6 text-slate-500">Rack wird geladen …</div>}>
          <RackSection
            week={week} locale={locale}
            weekRecipes={data.weekRecipes.filter(r => r.hfWeek === week)}
            recipes={data.recipes} cookSchedules={data.cookSchedules} processSpecs={data.processSpecs}
          />
        </Suspense>
      )}
    </div>
  );
}
