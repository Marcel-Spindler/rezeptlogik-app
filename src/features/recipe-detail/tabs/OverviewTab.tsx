import { useEffect, useMemo, useState } from "react";
import type { Market, ProductionPlan, Recipe, WeekRecipe } from "../../../core/types";
import { getBaseVerdenVolume } from "../../../lib/equipment";
import { marketVariantLabel } from "../../../lib/i18n";
import { useRecipePlanningIntel } from "../../../lib/planningOasisData";
import { getRampUpHistory } from "../../../lib/rampUpHistory";
import { fmtNum, MARKETS, MARKET_COLOR } from "../../../lib/helpers";
import { IntelMiniStat, RampHistoryDeltaPill, RampHistorySparkline, Row } from "../shared";

interface Props {
  wr: WeekRecipe;
  recipe: Recipe;
  market: Market;
  md?: Recipe["markets"][Market];
  portionsTotal: number;
  upliftPercent: number;
  productionPlan?: ProductionPlan;
}

function useRampHistory(wr: WeekRecipe) {
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setHistoryVersion(v => v + 1);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("storage", refresh); };
  }, [wr.hfWeek]);

  const snapshots = useMemo(
    () => getRampUpHistory(wr.hfWeek).filter(s => Object.prototype.hasOwnProperty.call(s.volumes, wr.code)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyVersion, wr.code, wr.hfWeek]
  );

  const entries = useMemo(() => snapshots.map((snapshot, index) => ({
    snapshot,
    current: snapshot.volumes[wr.code] ?? 0,
    previous: index > 0 ? (snapshots[index - 1]?.volumes[wr.code] ?? 0) : null,
    delta: index > 0 ? (snapshot.volumes[wr.code] ?? 0) - (snapshots[index - 1]?.volumes[wr.code] ?? 0) : null,
  })).reverse(), [snapshots, wr.code]);

  return { snapshots, entries, latest: snapshots[snapshots.length - 1] ?? null };
}

function ProductionCard({ wr, portionsTotal, upliftPercent }: { wr: WeekRecipe; portionsTotal: number; upliftPercent: number }) {
  const baseTotal = getBaseVerdenVolume(wr);
  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold text-slate-700 mb-2">Produktion (alle Märkte werden gemeinsam gekocht)</h3>
      <table className="w-full text-sm">
        <tbody>
          {MARKETS.map(m => (
            <tr key={m} className="border-b last:border-0">
              <td className="py-1"><span className={`pill ${MARKET_COLOR[m]}`}>{marketVariantLabel("de", m)}</span></td>
              <td className="py-1 text-right tabular-nums">{fmtNum(wr.verdenVolume[m])}</td>
              <td className="py-1 text-right text-xs text-slate-500">{wr.slot[m] ? `Slot ${wr.slot[m]}` : ""}</td>
            </tr>
          ))}
          <tr className="font-semibold bg-verden-50">
            <td className="py-1.5 px-1">Σ Verden Basis</td>
            <td className="py-1.5 text-right tabular-nums">{fmtNum(baseTotal)}</td>
            <td />
          </tr>
          <tr className="font-semibold bg-verden-100">
            <td className="py-1.5 px-1">Σ Plan Verden</td>
            <td className="py-1.5 text-right tabular-nums">{fmtNum(portionsTotal)}</td>
            <td className="py-1.5 text-right text-xs text-verden-700">{upliftPercent > 0 ? "+" : ""}{upliftPercent}%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MarketVariantCard({ market, md, recipe }: { market: Market; md?: Recipe["markets"][Market]; recipe: Recipe }) {
  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold text-slate-700 mb-2">Markt-Variante: {marketVariantLabel("de", market)}</h3>
      {md ? (
        <dl className="text-sm space-y-1.5">
          <Row k="MSKU" v={md.msku} />
          <Row k="Lokaler Name" v={md.recipeNameLocal} />
          <Row k="Yield" v={md.recipeYield ? `${md.recipeYield} ${md.recipeYieldUom ?? ""}` : "-"} />
          <Row k="Allergene" v={md.allergens || "-"} />
          <Row k="Primäre Verpackung" v={md.primaryPackagingSku || "-"} />
          <Row k="Compartment" v={md.compartmentName || "-"} />
          <Row k="Sek. Verpackungen" v={md.secondaryPackagingSkus || "-"} />
          <Row k="Märkte verfügbar" v={Object.keys(recipe.markets).map(m => marketVariantLabel("de", m as Market)).join(", ")} />
        </dl>
      ) : <div className="text-slate-500 text-sm">Keine Daten für diesen Markt.</div>}
    </div>
  );
}

function PlanningIntelCard({ wr, planningIntel }: { wr: WeekRecipe; planningIntel: ReturnType<typeof useRecipePlanningIntel> }) {
  return (
    <div className="card p-4 md:col-span-2 bg-gradient-to-r from-sky-50 via-white to-emerald-50 border border-sky-200">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-slate-700">Factory Live Intel aus Planning-Sheet</h3>
        <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-300">{wr.hfWeek}</span>
      </div>
      {!planningIntel ? (
        <div className="mt-3 text-sm text-slate-500">Für dieses Rezept gibt es im aktuellen Planning-Sheet noch keine Work-Order- oder LinePlating-Zuordnung.</div>
      ) : (
        <div className="mt-3 grid lg:grid-cols-[0.9fr_1.1fr] gap-4">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-2 gap-2">
            <IntelMiniStat label="Work Orders" value={fmtNum(planningIntel.workOrders.length)} />
            <IntelMiniStat label="Sub-Rezepte" value={fmtNum(planningIntel.uniqueSubRecipes.length)} />
            <IntelMiniStat label="WO Target Σ" value={fmtNum(planningIntel.totalTargetPortions)} />
            <IntelMiniStat label="LinePlating Σ" value={fmtNum(planningIntel.platingRows.reduce((s, r) => s + r.totalAmount, 0))} />
            <IntelMiniStat label="Forecast Σ" value={fmtNum(planningIntel.forecastTotal)} />
            <IntelMiniStat label="PDL Σ" value={fmtNum(planningIntel.pdlPortions)} />
          </div>
          <div className="space-y-3">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Rolle</div>
              <div className={`mt-1 inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ${planningIntel.planningRole === "hybrid" ? "bg-sky-50 text-sky-800 ring-sky-200" : planningIntel.planningRole === "supplied" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-emerald-50 text-emerald-800 ring-emerald-200"}`}>
                {planningIntel.planningRole === "hybrid" ? "Hybrid / Übergang" : planningIntel.planningRole === "supplied" ? "Zugeliefertes Meal" : "Eigene Fabrikproduktion"}
              </div>
            </div>
            {planningIntel.platingRows.length > 0 && (
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">LinePlating</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  {planningIntel.platingRows.map(row => (
                    <span key={`${row.sourceTab}-${row.platingDay}`} className="rounded-full bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-800 ring-1 ring-violet-200">
                      {row.platingDay}: {fmtNum(row.totalAmount)}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {planningIntel.statuses.length > 0 && (
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Status-Mix</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  {planningIntel.statuses.map(item => (
                    <span key={item.status} className="rounded-full bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">
                      {item.status}: {fmtNum(item.count)}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {planningIntel.methods.length > 0 && (
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Cook Methods</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  {planningIntel.methods.slice(0, 10).map(method => (
                    <span key={method} className="rounded-full bg-sky-50 px-2 py-1 text-[11px] font-semibold text-sky-800 ring-1 ring-sky-200">{method}</span>
                  ))}
                </div>
              </div>
            )}
            {planningIntel.uniqueSubRecipes.length > 0 && (
              <div>
                <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Sheet-Sub-Rezepte</div>
                <div className="mt-1 text-sm text-slate-700">
                  {planningIntel.uniqueSubRecipes.slice(0, 8).join(" · ")}
                  {planningIntel.uniqueSubRecipes.length > 8 ? ` · +${planningIntel.uniqueSubRecipes.length - 8} weitere` : ""}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProductionPlanCard({ wr, productionPlan }: { wr: WeekRecipe; productionPlan: ProductionPlan }) {
  const entries = productionPlan.rows.filter(e => e.recipeCode === wr.code);
  if (!entries.length) return null;

  const byDay = new Map<string, typeof entries>();
  for (const e of entries) {
    if (!byDay.has(e.kitchenDay)) byDay.set(e.kitchenDay, []);
    byDay.get(e.kitchenDay)!.push(e);
  }
  const days = [...byDay.keys()].sort();
  const totalMeals = entries.reduce((s, e) => s + e.plannedMeals, 0);

  return (
    <div className="card p-4 md:col-span-2 border border-emerald-200 bg-gradient-to-r from-emerald-50 via-white to-teal-50">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <h3 className="text-sm font-semibold text-slate-700">Produktionsplan (Fertigstellungszeitplan)</h3>
        <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-300">
          {productionPlan.week} · {totalMeals.toLocaleString("de-DE")} Portionen
        </span>
      </div>
      <div className="grid gap-2">
        {days.map(day => (
          <div key={day} className="rounded-lg bg-white ring-1 ring-slate-200 p-2.5">
            <div className="text-xs font-semibold text-slate-600 mb-1.5">{day}</div>
            <div className="space-y-1">
              {byDay.get(day)!.map((e, i) => (
                <div key={i} className="flex items-center gap-3 text-xs text-slate-700">
                  <span className="font-mono text-slate-500 w-14 shrink-0">{e.workOrder}</span>
                  <span className="flex-1 truncate text-slate-600">{e.subRecipe}</span>
                  <span className="tabular-nums font-semibold">{e.plannedMeals.toLocaleString("de-DE")} Port.</span>
                  <span className="tabular-nums text-slate-500 w-20 text-right">{e.stagingKg.toLocaleString("de-DE", { maximumFractionDigits: 1 })} kg</span>
                  {e.yieldPct > 0 && <span className="text-slate-400 w-14 text-right">{e.yieldPct.toFixed(1)}% Yield</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RampUpHistoryCard({ wr, history }: { wr: WeekRecipe; history: ReturnType<typeof useRampHistory> }) {
  const { snapshots, entries, latest } = history;
  return (
    <div className="card p-4 md:col-span-2 border border-violet-200 bg-gradient-to-r from-violet-50 via-white to-cyan-50">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Ramp-up / Forecast Historie</h3>
          <div className="text-xs text-slate-500">Wie sich die Meal-Zahl im Wochenverlauf geändert hat.</div>
        </div>
        {latest && (
          <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-300">
            Letztes Update {latest.label}
          </span>
        )}
      </div>
      {entries.length === 0 ? (
        <div className="mt-3 rounded-xl bg-white px-3 py-3 text-sm text-slate-500 ring-1 ring-slate-200">
          Noch keine Ramp-up-Historie für dieses Meal in dieser Woche vorhanden.
        </div>
      ) : (
        <div className="mt-3 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
            <div className="grid grid-cols-2 gap-2">
              <IntelMiniStat label="Aktuell" value={fmtNum(latest?.volumes[wr.code] ?? wr.totalVerdenVolume)} />
              <IntelMiniStat label="Änderung zuletzt" value={entries[0]?.delta === null ? "Basis" : `${(entries[0].delta ?? 0) > 0 ? "+" : ""}${fmtNum(entries[0]?.delta ?? 0)}`} />
              <IntelMiniStat label="Snapshots" value={fmtNum(entries.length)} />
              <IntelMiniStat label="Von → Bis" value={`${fmtNum(entries[entries.length - 1]?.current ?? 0)} → ${fmtNum(entries[0]?.current ?? 0)}`} />
            </div>
            {snapshots.length >= 2 && (
              <div className="mt-3 rounded-lg bg-slate-50 p-3">
                <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Trend</div>
                <div className="mt-2"><RampHistorySparkline values={snapshots.map(s => s.volumes[wr.code] ?? 0)} /></div>
              </div>
            )}
          </div>
          <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Letzte Änderungen</div>
            <div className="mt-2 space-y-2">
              {entries.slice(0, 6).map(({ snapshot, current, previous, delta }) => (
                <div key={snapshot.ts} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-slate-700">
                      {previous === null ? "Basiswert gespeichert" : `Geändert am ${snapshot.label}`}
                    </div>
                    <RampHistoryDeltaPill delta={delta ?? 0} />
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {previous === null ? `Basis ${fmtNum(current)}` : `${fmtNum(previous)} → ${fmtNum(current)}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AllergenSummaryCard({ recipe, md }: { recipe: Recipe; market: Market; md?: Recipe["markets"][Market] }) {
  const allergensByMarket = useMemo(() => {
    const result: { market: string; allergens: string[] }[] = [];
    for (const [m, details] of Object.entries(recipe.markets)) {
      if (!details?.allergens) continue;
      const list = details.allergens.split(/[,;/]/).map(s => s.trim()).filter(Boolean);
      if (list.length > 0) result.push({ market: m, allergens: list });
    }
    return result;
  }, [recipe]);

  const allAllergens = useMemo(() => {
    const set = new Set<string>();
    for (const entry of allergensByMarket) for (const a of entry.allergens) set.add(a.toLowerCase());
    return [...set].sort();
  }, [allergensByMarket]);

  if (allAllergens.length === 0) {
    return (
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Allergene</h3>
        <div className="text-sm text-slate-500">Keine Allergen-Daten vorhanden.</div>
      </div>
    );
  }

  const currentAllergens = md?.allergens?.split(/[,;/]/).map(s => s.trim()).filter(Boolean) ?? allAllergens;

  return (
    <div className="card p-4 border border-amber-200 bg-gradient-to-r from-amber-50 via-white to-orange-50">
      <h3 className="text-sm font-semibold text-slate-700 mb-2">Allergene</h3>
      <div className="flex flex-wrap gap-1.5">
        {currentAllergens.map(a => (
          <span key={a} className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300">
            ⚠ {a}
          </span>
        ))}
      </div>
      {allergensByMarket.length > 1 && (
        <div className="mt-3 space-y-1">
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Pro Markt</div>
          {allergensByMarket.map(({ market: m, allergens }) => (
            <div key={m} className="flex items-start gap-2 text-xs">
              <span className="font-semibold text-slate-600 w-12 shrink-0">{m}</span>
              <span className="text-slate-600">{allergens.join(", ")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function OverviewTab({ wr, recipe, market, md, portionsTotal, upliftPercent, productionPlan }: Props) {
  const planningIntel = useRecipePlanningIntel(wr.code);
  const rampHistory = useRampHistory(wr);

  return (
    <div className="grid md:grid-cols-2 gap-3">
      <ProductionCard wr={wr} portionsTotal={portionsTotal} upliftPercent={upliftPercent} />
      <MarketVariantCard market={market} md={md} recipe={recipe} />
      <AllergenSummaryCard recipe={recipe} market={market} md={md} />
      <PlanningIntelCard wr={wr} planningIntel={planningIntel} />
      {productionPlan && <ProductionPlanCard wr={wr} productionPlan={productionPlan} />}
      <RampUpHistoryCard wr={wr} history={rampHistory} />
    </div>
  );
}
