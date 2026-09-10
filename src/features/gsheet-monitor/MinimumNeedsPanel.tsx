// Minimum Needs — je Meal die Do → Fr → Sa-Checkpoint-Kette aus dem
// „Volume Overview"-Tab (alle Märkte zusammengerechnet). Plus VolumeSummary:
// die kompakte „was fehlt zum Gesamtvolumen"-Aufstellung.
//
// Geteilt zwischen Postblast Live Monitor und dem Plating Dashboard.
import { useMemo, useState } from "react";
import type { RedzoneState } from "../redzone-live/RedzoneContext";
import type { VolumeOverviewData } from "./parsers/parseVolumeOverview";
import { platedForMeal } from "./plateableNet";

const VOLUME_OVERVIEW_URL =
  "https://docs.google.com/spreadsheets/d/1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY/edit?gid=1602943717#gid=1602943717";

const DAYS = [
  { key: "thu" as const, label: "Do" },
  { key: "fri" as const, label: "Fr" },
  { key: "sat" as const, label: "Sa" },
];

const gapVal = (g: number | null): number => g ?? 0;

interface MinNeedsMeal {
  code: string;
  recipeName: string;
  forecastTotal: number;
  production: number;
  gaps: { thu: number | null; fri: number | null; sat: number | null };
  cum: { thu: number; fri: number; sat: number };
  holdingMeals: number;
  comment: string;
  activePlating: boolean;
  worst: number;
  reachedThrough: "sat" | "fri" | "thu" | null;
}

function buildMeals(
  volumeOverview: VolumeOverviewData | null,
  holdingMealsByCode: Map<string, number> | undefined,
  redzone: RedzoneState | null | undefined,
): MinNeedsMeal[] {
  const out: MinNeedsMeal[] = [];
  for (const row of volumeOverview?.rows ?? []) {
    const cum = {
      thu: row.forecastByDay.thu,
      fri: row.forecastByDay.thu + row.forecastByDay.fri,
      sat: row.forecastByDay.thu + row.forecastByDay.fri + row.forecastByDay.sat,
    };
    if (cum.sat <= 0 && row.production <= 0) continue;
    const gaps = row.gapByDay;
    const reachedThrough: MinNeedsMeal["reachedThrough"] =
      gapVal(gaps.sat) >= 0 ? "sat"
      : gapVal(gaps.fri) >= 0 ? "fri"
      : gapVal(gaps.thu) >= 0 ? "thu"
      : null;
    out.push({
      code: row.code,
      recipeName: row.recipeName,
      forecastTotal: row.forecastTotal,
      production: row.production,
      gaps,
      cum,
      holdingMeals: platedForMeal(holdingMealsByCode, row.code),
      comment: row.comment,
      activePlating: redzone?.isPlatingNow(row.code) ?? false,
      worst: Math.min(gapVal(gaps.thu), gapVal(gaps.fri), gapVal(gaps.sat)),
      reachedThrough,
    });
  }
  out.sort((a, b) => a.worst - b.worst);
  return out;
}

// ── Eine Quelle für alle „wie weit sind wir"-Zahlen ─────────────────────────
// Header-KPIs, Gesamtvolumen-Karte und Minimum-Needs-Kacheln lesen ALLE hier —
// damit die Zahlen zusammenpassen. „komplett" = Forecast-Nachfrage aller Märkte
// bis Samstag ist gedeckt (Volume-Overview „Actual Target" Sa ≥ 0).
export interface VolumeStats {
  total: number;
  forecast: number;
  production: number;
  pct: number;
  complete: number;
  open: number;
  missByDay: { thu: number; fri: number; sat: number };
  okByDay: { thu: number; fri: number; sat: number };
}

export function volumeStats(volumeOverview: VolumeOverviewData | null): VolumeStats | null {
  const meals = buildMeals(volumeOverview, undefined, undefined);
  if (meals.length === 0) return null;
  const forecast = meals.reduce((s, m) => s + m.forecastTotal, 0);
  const production = meals.reduce((s, m) => s + m.production, 0);
  const missByDay = { thu: 0, fri: 0, sat: 0 };
  const okByDay = { thu: 0, fri: 0, sat: 0 };
  for (const m of meals) for (const { key } of DAYS) {
    const g = gapVal(m.gaps[key]);
    if (g >= 0) okByDay[key]++; else missByDay[key] += -g;
  }
  const complete = meals.filter(m => m.reachedThrough === "sat").length;
  return {
    total: meals.length,
    forecast,
    production,
    pct: forecast > 0 ? Math.min(100, (production / forecast) * 100) : 0,
    complete,
    open: meals.length - complete,
    missByDay,
    okByDay,
  };
}

// ── Kompakte Gesamtvolumen-Aufstellung ──────────────────────────────────────
export function VolumeSummary({ volumeOverview }: { volumeOverview: VolumeOverviewData | null }) {
  const st = useMemo(() => volumeStats(volumeOverview), [volumeOverview]);
  if (!st) return null;
  const { total, forecast, production, pct } = st;

  return (
    <div className="card p-5 border-0 shadow-md">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="font-bold text-slate-900 text-sm">
          Gesamtvolumen{volumeOverview?.week ? ` · ${volumeOverview.week}` : ""}
        </div>
        <a href={VOLUME_OVERVIEW_URL} target="_blank" rel="noopener noreferrer"
          className="text-[11px] px-3 py-1.5 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition font-medium ring-1 ring-slate-200">
          ↗ Volume Overview
        </a>
      </div>

      <div className="flex items-end gap-4 flex-wrap mb-3">
        <div>
          <div className={`text-4xl font-black font-mono ${pct >= 95 ? "text-emerald-600" : pct >= 60 ? "text-sky-600" : "text-amber-600"}`}>
            {Math.round(pct)}%
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {production.toLocaleString("de-DE")} von {forecast.toLocaleString("de-DE")} Portionen plaitiert
          </div>
        </div>
        <div className="text-[11px] text-slate-600 flex flex-col gap-0.5">
          <span><span className="font-bold text-emerald-600">{st.complete}</span> / {total} Meals decken die Wochen-Nachfrage</span>
          <span><span className="font-bold text-red-600">{st.open}</span> brauchen noch Menge</span>
        </div>
      </div>

      <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden mb-3">
        <div className={`h-full rounded-full ${pct >= 95 ? "bg-emerald-500" : pct >= 60 ? "bg-sky-500" : "bg-amber-500"}`} style={{ width: `${pct}%` }} />
      </div>

      <div className="grid grid-cols-3 gap-2">
        {DAYS.map(({ key, label }) => {
          const miss = st.missByDay[key];
          const ok = st.okByDay[key];
          return (
          <div key={label} className={`rounded-xl px-3 py-2 ring-1 text-center ${miss === 0 ? "bg-emerald-50 ring-emerald-200" : "bg-red-50 ring-red-200"}`}>
            <div className="text-[10px] font-bold uppercase text-slate-500">bis {label}</div>
            <div className={`text-lg font-black font-mono ${miss === 0 ? "text-emerald-600" : "text-red-600"}`}>
              {miss === 0 ? "✓" : `−${Math.round(miss).toLocaleString("de-DE")}`}
            </div>
            <div className="text-[9px] text-slate-400">{ok}/{total} Meals ok</div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Voll-Panel: je Meal die Do → Fr → Sa-Kette ──────────────────────────────
export function MinimumNeedsPanel({
  volumeOverview,
  redzone,
  holdingMealsByCode,
}: {
  volumeOverview: VolumeOverviewData | null;
  redzone?: RedzoneState | null;
  holdingMealsByCode?: Map<string, number>;
}) {
  const [hideDone, setHideDone] = useState(true);
  const meals = useMemo(() => buildMeals(volumeOverview, holdingMealsByCode, redzone), [volumeOverview, holdingMealsByCode, redzone]);

  const daySummary = useMemo(() => {
    const s = { thu: { ok: 0, miss: 0 }, fri: { ok: 0, miss: 0 }, sat: { ok: 0, miss: 0 } };
    for (const m of meals) for (const { key } of DAYS) {
      const g = gapVal(m.gaps[key]);
      if (g >= 0) s[key].ok++;
      else s[key].miss += -g;
    }
    return s;
  }, [meals]);

  const shown = hideDone ? meals.filter(m => m.reachedThrough !== "sat") : meals;
  const doneCount = meals.filter(m => m.reachedThrough === "sat").length;

  return (
    <div className="card p-5 shadow-md border-0">
      <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
        <div>
          <div className="font-bold text-slate-900 text-sm">
            Minimum Needs{volumeOverview?.week ? ` · ${volumeOverview.week}` : ""}
          </div>
          <div className="text-[10px] text-slate-400">
            je Meal: plaitiert vs. Forecast-Nachfrage aller Märkte bis Do → Fr → Sa (Sheet „Volume Overview", Spalten L/M/N). −X = fehlt bis zu dem Tag · 🔎 = evtl. im Holding, prüfen
          </div>
        </div>
        <a href={VOLUME_OVERVIEW_URL} target="_blank" rel="noopener noreferrer"
          className="text-[11px] px-3 py-1.5 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition font-medium ring-1 ring-slate-200 shrink-0">
          ↗ Volume Overview
        </a>
      </div>

      {meals.length === 0 ? (
        <div className="text-[11px] text-slate-400 italic py-6 text-center">Volume-Overview-Tab noch nicht geladen …</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {DAYS.map(({ key, label }) => {
              const d = daySummary[key];
              const total = meals.length;
              const all = d.ok === total;
              return (
                <div key={key} className={`rounded-xl px-3 py-2 ring-1 ${all ? "bg-emerald-50 ring-emerald-200" : d.ok === 0 ? "bg-red-50 ring-red-200" : "bg-amber-50 ring-amber-200"}`}>
                  <div className="flex items-baseline justify-between">
                    <span className={`text-[11px] font-bold uppercase ${all ? "text-emerald-700" : d.ok === 0 ? "text-red-700" : "text-amber-700"}`}>{label}</span>
                    <span className={`text-[11px] font-bold font-mono ${all ? "text-emerald-700" : "text-slate-500"}`}>{d.ok}/{total}</span>
                  </div>
                  <div className="w-full h-1 rounded-full bg-white/70 overflow-hidden my-1">
                    <div className={`h-1 rounded-full ${all ? "bg-emerald-500" : d.ok === 0 ? "bg-red-400" : "bg-amber-400"}`} style={{ width: `${total > 0 ? (d.ok / total) * 100 : 0}%` }} />
                  </div>
                  <div className={`text-[10px] font-mono ${d.miss > 0 ? "text-red-600 font-bold" : "text-emerald-600"}`}>
                    {d.miss > 0 ? `−${Math.round(d.miss).toLocaleString("de-DE")} fehlen` : "erreicht ✓"}
                  </div>
                </div>
              );
            })}
          </div>

          {doneCount > 0 && (
            <button
              onClick={() => setHideDone(v => !v)}
              className="text-[10px] mb-2 px-2.5 py-1 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 transition font-medium"
            >
              {hideDone ? `▸ ${doneCount} fertige einblenden` : `▾ ${doneCount} fertige ausblenden`}
            </button>
          )}

          <div className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-1">
            {shown.map(m => {
              const behind = m.reachedThrough !== "sat";
              return (
                <div key={m.code} className={`rounded-xl px-3 py-2 ring-1 ${
                  m.reachedThrough === "sat" ? "bg-emerald-50/60 ring-emerald-200"
                  : m.reachedThrough == null ? "bg-red-50 ring-red-200"
                  : "bg-amber-50/60 ring-amber-200"
                }`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] font-bold text-slate-900">{m.code}</span>
                    {m.activePlating && (
                      <span className="flex items-center gap-1 text-[9px] font-bold text-red-600 uppercase">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />wird platiert
                      </span>
                    )}
                    <span className="text-[10px] text-slate-500 truncate flex-1 min-w-0">{m.recipeName}</span>
                    {behind && (
                      <span className="text-[11px] font-bold font-mono text-red-600 shrink-0">
                        −{Math.abs(Math.round(m.worst)).toLocaleString("de-DE")} <span className="font-normal text-[9px] text-red-400">fehlt</span>
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 mt-1.5">
                    {DAYS.map(({ key, label }, i) => {
                      const g = m.gaps[key];
                      const ok = gapVal(g) >= 0;
                      return (
                        <div key={key} className="flex items-center gap-1">
                          {i > 0 && <span className="text-slate-300 text-[10px]">›</span>}
                          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                            ok ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700 font-bold"
                          }`} title={`Nachfrage bis ${label}: ${Math.round(m.cum[key]).toLocaleString("de-DE")} · plaitiert ${m.production.toLocaleString("de-DE")}`}>
                            {label} {ok ? "✓" : g == null ? "?" : `−${Math.abs(Math.round(g)).toLocaleString("de-DE")}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-2 mt-1 text-[9px] text-slate-400 flex-wrap">
                    <span>{Math.round(m.forecastTotal).toLocaleString("de-DE")} Nachfrage · {m.production.toLocaleString("de-DE")} plaitiert</span>
                    {behind && m.holdingMeals > 0 && (
                      <span className="text-slate-500 font-medium" title="Fertigware, die laut RTI evtl. schon platierfertig im Holding steht — vor dem Nachkochen prüfen">
                        🔎 ~{Math.round(m.holdingMeals).toLocaleString("de-DE")} im Holding
                      </span>
                    )}
                    {m.comment && (
                      <span className="text-slate-400 italic truncate max-w-[240px]" title={m.comment}>„{m.comment}"</span>
                    )}
                  </div>
                </div>
              );
            })}
            {shown.length === 0 && (
              <div className="text-[11px] text-emerald-600 font-medium py-4 text-center">Alle Meals haben den Samstag-Checkpoint erreicht ✓</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
