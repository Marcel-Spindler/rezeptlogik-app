import { useEffect, useMemo, useState } from "react";
import type { DataBundle, Market, ProductionPlan, Recipe, WeekRecipe } from "../../../core/types";
import { getBaseVerdenVolume } from "../../../lib/equipment";
import { marketVariantLabel } from "../../../lib/i18n";
import { useRecipePlanningIntel } from "../../../lib/planningOasisData";
import { getRampUpHistory } from "../../../lib/rampUpHistory";
import { fmtNum, MARKETS, MARKET_COLOR } from "../../../lib/helpers";
import { buildSkuInfoIndex } from "../../../lib/wmsSkuEnrichment";
import { IntelMiniStat, RampHistoryDeltaPill, RampHistorySparkline, Row } from "../shared";
import { useRedzoneOptional } from "../../redzone-live/RedzoneContext";
import type { PlatingRunDisplay } from "../../redzone-live/redzoneTypes";
import { useAppState } from "../../../app/AppContext";
import { usePostblastMonitor } from "../../gsheet-monitor/useGSheetMonitor";
import { useWoReconciliation } from "../../wo-reconciliation/WoReconciliationContext";
import type { ReconcileSource } from "../../wo-reconciliation/woReconcileTypes";
import { buildFunnel, buildSkuStationMap } from "../../wms-overview/wmsIndex";
import { weekNumFromHfWeek } from "../../wms-overview/wmsWeeks";
import { fetchAllWmsStations } from "../../wms-overview/wmsFetch";
import { SkuDetailPanel } from "../../wms-overview/WmsSkuDetailPanel";
import { TracePanel } from "../../wms-overview/WmsFunnelAndTrace";
import type { AllData } from "../../wms-overview/wmsTypes";

interface Props {
  wr: WeekRecipe;
  recipe: Recipe;
  market: Market;
  md?: Recipe["markets"][Market];
  portionsTotal: number;
  upliftPercent: number;
  productionPlan?: ProductionPlan;
  data: DataBundle;
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
                  {/* "Staging"-Spalte im Fertigstellungssheet ist praktisch immer leer (0) —
                      gleicher Fallback wie in postblastMatch.ts's plannedKg (post → kitchen → staging). */}
                  <span className="tabular-nums text-slate-500 w-20 text-right">{(e.postKg || e.kitchenKg || e.stagingKg).toLocaleString("de-DE", { maximumFractionDigits: 1 })} kg</span>
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

// ─── Meal-Historie: Redzone Live (Plating + Küche) ────────────────────────────
function fmtClock(iso: string | null): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}
function fmtRunDuration(min: number | null): string {
  if (min === null) return "–";
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

function useRecipeMskus(recipe: Recipe): Set<string> {
  return useMemo(() => {
    const set = new Set<string>();
    for (const m of MARKETS) {
      const msku = recipe.markets[m]?.msku;
      if (msku) set.add(msku.trim().toUpperCase());
    }
    return set;
  }, [recipe]);
}

function useRedzoneMealRuns(code: string, mskus: Set<string>): PlatingRunDisplay[] {
  const rz = useRedzoneOptional();
  return useMemo(() => {
    if (!rz) return [];
    const normCode = code.trim().toUpperCase();
    return rz.runs
      .filter(r => (r.mealCode && r.mealCode.trim().toUpperCase() === normCode) || mskus.has(r.productTypeSKU?.trim().toUpperCase() ?? ""))
      .slice()
      .sort((a, b) => (b.startTime ?? "").localeCompare(a.startTime ?? ""));
  }, [rz, code, mskus]);
}

function RedzoneMealHistoryCard({ wr, recipe }: { wr: WeekRecipe; recipe: Recipe }) {
  const rz = useRedzoneOptional();
  const mskus = useRecipeMskus(recipe);
  const runs = useRedzoneMealRuns(wr.code, mskus);
  if (!rz) return null;

  return (
    <div className="card overflow-hidden md:col-span-2 border border-teal-200">
      <div className="px-4 py-3 border-b border-teal-100 bg-gradient-to-r from-teal-50 to-emerald-50/40 flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Redzone Live · Produktionshistorie</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {rz.loading ? "Lädt…" : `${runs.length} Runs · letzte ${rz.hours}h`}
            {runs.some(r => r.status === "active") && " · läuft gerade"}
          </p>
        </div>
        <button type="button" onClick={rz.refresh} className="text-[11px] text-slate-500 hover:text-emerald-700 font-medium transition-colors">
          ↻ Aktualisieren
        </button>
      </div>
      {rz.error ? (
        <div className="px-4 py-4 text-sm text-red-600">{rz.error}</div>
      ) : runs.length === 0 ? (
        <div className="px-4 py-4 text-sm text-slate-500">Keine Redzone-Aktivität für dieses Meal in den letzten {rz.hours}h.</div>
      ) : (
        <div className="divide-y divide-slate-50 max-h-96 overflow-y-auto">
          {runs.map((r, i) => (
            <div key={i} className="px-4 py-2 flex items-center gap-3 text-xs">
              {r.status === "active" ? (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
              ) : (
                <span className="w-2 h-2 rounded-full bg-slate-300 shrink-0" />
              )}
              <span className="w-14 shrink-0 font-mono text-slate-400">{r.areaName}</span>
              <span className="w-24 shrink-0 font-mono text-slate-600 truncate">{r.locationName}</span>
              <span className="flex-1 truncate text-slate-500" title={r.productTypeName}>{r.productTypeName}</span>
              <span className="w-12 text-right font-mono text-slate-400">{fmtClock(r.startTime)}</span>
              <span className="w-12 text-right font-mono text-slate-400">{fmtClock(r.endTime)}</span>
              <span className="w-14 text-right font-mono text-slate-400">{fmtRunDuration(r.durationMin)}</span>
              <span className="w-16 text-right font-mono font-semibold text-slate-700">
                {r.outCount != null ? r.outCount.toLocaleString("de-DE") : "–"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProgressBar({ pct, color, height = 8 }: { pct: number | null; color: string; height?: number }) {
  const clamped = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const width = pct === null ? 0 : clamped > 0 ? Math.max(clamped, 2.5) : 0;
  return (
    <div className="relative rounded-full bg-slate-100 overflow-hidden" style={{ height }}>
      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${width}%`, backgroundColor: color }} />
    </div>
  );
}

function fmtKg(v: number | null): string {
  return v == null ? "–" : v.toLocaleString("de-DE", { maximumFractionDigits: 1 });
}
function fmtPortions(v: number | null): string {
  return v == null ? "–" : v.toLocaleString("de-DE");
}

const SOURCE_LABEL: Record<ReconcileSource, string> = { app: "App", ket: "KET", pet: "PET", wms: "WMS", postblast: "Postblast" };

// ─── Meal-Historie: WO-Abgleich (App-Plan · KET · PET · WMS · Postblast) ──────
// Konsumiert den globalen WoReconciliationContext (gleiche Engine wie die
// Unstimmigkeits-Badges in der Rezeptliste) statt den Soll/Ist-Abgleich hier
// nochmal separat zu rechnen — ein Modell für Liste und Detailansicht.
function WoReconciliationCard({ wr }: { wr: WeekRecipe }) {
  const reconciliation = useWoReconciliation();
  const postblast = usePostblastMonitor();
  const { setView } = useAppState();

  const rows = useMemo(
    () => (reconciliation?.rows ?? []).filter(r => r.recipeCode === wr.code).sort((a, b) => (a.workOrder < b.workOrder ? -1 : 1)),
    [reconciliation, wr.code],
  );

  const woSet = useMemo(() => new Set(rows.map(r => r.workOrder)), [rows]);
  const weighings = useMemo(() => {
    const list: { workOrder: string; timestamp: string; subSubRecipe: string; subRecipeName: string; rawWeightKg: number }[] = [];
    for (const wo of woSet) {
      for (const w of postblast.data?.byWorkOrder.get(wo) ?? []) list.push(w);
    }
    return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [postblast.data, woSet]);

  if (!reconciliation || rows.length === 0) return null;

  const sources = reconciliation.sourcesAvailable;
  const totalApp = rows.reduce((s, r) => s + (r.appKg ?? 0), 0);
  const totalKet = rows.reduce((s, r) => s + (r.ketKg ?? 0), 0);
  const totalActual = rows.reduce((s, r) => s + (r.actualKg ?? 0), 0);
  const missingKet = !sources.includes("ket");
  const missingPet = !sources.includes("pet");

  return (
    <div className="card overflow-hidden md:col-span-2 border border-rose-200">
      <div className="px-4 py-3 border-b border-rose-100 bg-gradient-to-r from-rose-50 to-orange-50/40 flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">WO-Abgleich · App-Plan · KET · PET · Postblast</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {rows.length} Work Orders · App {fmtKg(totalApp)} kg · KET ≈ {fmtKg(totalKet)} kg · Gewogen {fmtKg(totalActual)} kg
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {(["app", "ket", "pet", "wms", "postblast"] as ReconcileSource[]).map(s => (
            <span key={s} className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${sources.includes(s) ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>
              {SOURCE_LABEL[s]}
            </span>
          ))}
        </div>
      </div>
      {(missingKet || missingPet) && (
        <div className="px-4 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 bg-amber-50 border-b border-amber-100 text-[11px] text-amber-800">
          {missingKet && <span>Keine KET-CSV geladen — Spalte "KET ≈" bleibt leer. <button type="button" onClick={() => setView("wo")} className="font-semibold underline">Hochladen →</button></span>}
          {missingPet && <span>Kein PET-Plan geladen — PET-Portionen fehlen im Abgleich. <button type="button" onClick={() => setView("pet")} className="font-semibold underline">Hochladen →</button></span>}
        </div>
      )}
      <div className="p-3 grid gap-2 md:grid-cols-2">
        {rows.map(r => (
          <div key={r.workOrder} className={`rounded-lg bg-white ring-1 p-2.5 ${r.severity === "critical" ? "ring-red-300" : r.severity === "warn" ? "ring-amber-300" : "ring-slate-200"}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] font-semibold text-slate-600">{r.workOrder}</span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${r.severity === "critical" ? "bg-red-100 text-red-700" : r.severity === "warn" ? "bg-amber-100 text-amber-700" : r.isComplete ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"}`}>
                {r.severity === "critical" ? "⚠ KRITISCH" : r.severity === "warn" ? "⚠ ABWEICHUNG" : r.isComplete ? "FERTIG" : "LÄUFT"}
              </span>
            </div>
            <div className="text-xs text-slate-600 truncate mt-0.5">{r.subRecipe}</div>
            <div className="mt-1.5"><ProgressBar pct={r.progressPct} color={r.severity === "critical" ? "#dc2626" : r.isComplete ? "#10b981" : "#0ea5e9"} height={5} /></div>
            <div className="mt-1.5 grid grid-cols-3 gap-1.5 text-center">
              <div className="rounded bg-slate-50 px-1.5 py-1">
                <div className="text-[8px] uppercase tracking-wide text-slate-400">App-Plan</div>
                <div className="font-mono text-[11px] font-semibold text-slate-700">{fmtKg(r.appKg)}</div>
              </div>
              <div className={`rounded px-1.5 py-1 ${r.kgMismatch ? "bg-amber-50 ring-1 ring-amber-300" : "bg-slate-50"}`} title={r.kgMismatch ? "Weicht > 15% vom App-Plan ab" : undefined}>
                <div className="text-[8px] uppercase tracking-wide text-slate-400">KET ≈</div>
                <div className={`font-mono text-[11px] font-semibold ${r.kgMismatch ? "text-amber-700" : "text-slate-700"}`}>{fmtKg(r.ketKg)}{r.kgMismatch ? " ⚠" : ""}</div>
              </div>
              <div className="rounded bg-emerald-50 px-1.5 py-1">
                <div className="text-[8px] uppercase tracking-wide text-emerald-500">Gewogen</div>
                <div className="font-mono text-[11px] font-semibold text-emerald-700">{fmtKg(r.actualKg)}</div>
              </div>
            </div>
            {(r.appPortions != null || r.ketPortions != null || r.petTarget != null) && (
              <div className={`mt-1.5 flex items-center justify-between gap-2 text-[10px] rounded px-1.5 py-1 ${r.portionsMismatch ? "bg-amber-50 ring-1 ring-amber-300" : "bg-slate-50"}`}
                title={r.portionsMismatch ? "Portionen weichen > 15% voneinander ab" : undefined}>
                <span className="text-slate-400">Portionen</span>
                <span className={`font-mono ${r.portionsMismatch ? "text-amber-700 font-semibold" : "text-slate-600"}`}>
                  App {fmtPortions(r.appPortions)} · KET {fmtPortions(r.ketPortions)} · PET {fmtPortions(r.petTarget)}{r.portionsMismatch ? " ⚠" : ""}
                </span>
              </div>
            )}
            {r.missingPetAssignment && (
              <div className="mt-1 text-[10px] text-amber-600">Keine PET-Linienzuordnung gefunden</div>
            )}
            <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400">
              <span>{r.presentIn.map(s => SOURCE_LABEL[s]).join(" · ")}</span>
              <span>{r.weighingCount} Wiegungen{r.lastWeighing ? ` · ${fmtClock(r.lastWeighing)}` : ""}</span>
            </div>
          </div>
        ))}
      </div>
      {weighings.length > 0 && (
        <div className="border-t border-slate-100 px-3 py-2">
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1.5">Alle Wiegungen ({weighings.length})</div>
          <div className="max-h-56 overflow-y-auto space-y-1">
            {weighings.map((w, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px] font-mono text-slate-500">
                <span className="w-12 shrink-0">{fmtClock(w.timestamp)}</span>
                <span className="w-14 shrink-0 text-slate-400">{w.workOrder}</span>
                <span className="flex-1 truncate text-slate-600">{w.subSubRecipe || w.subRecipeName}</span>
                <span className="w-16 text-right font-semibold text-slate-700">{w.rawWeightKg.toLocaleString("de-DE", { maximumFractionDigits: 2 })} kg</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Meal-Historie: WMS-Übersicht (voller Stationen-Trace, on-demand) ─────────
// Live-Snowflake-Abfrage (9 Stationen) — bewusst NICHT automatisch beim Öffnen
// des Rezepts geladen (braucht laufenden WMS-Lokalserver + SSO), sondern nur
// auf Klick, damit das Rezept-Tab auch ohne WMS-Verbindung schnell bleibt.
function WmsMealTraceCard({ wr, recipe, data }: { wr: WeekRecipe; recipe: Recipe; data: DataBundle }) {
  const reconciliation = useWoReconciliation();
  const [allData, setAllData] = useState<AllData | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailSku, setDetailSku] = useState<string | null>(null);
  const [traceSku, setTraceSku] = useState<string | null>(null);

  const candidateSkus = useMemo(() => {
    const seen = new Set<string>();
    const list: { sku: string; label: string }[] = [];
    const recipeId = data.structures?.[wr.code]?.recipeId;
    if (recipeId && !seen.has(recipeId)) { seen.add(recipeId); list.push({ sku: recipeId, label: "Recipe ID" }); }
    for (const m of MARKETS) {
      const msku = recipe.markets[m]?.msku;
      if (msku && !seen.has(msku)) { seen.add(msku); list.push({ sku: msku, label: `MSKU ${m}` }); }
    }
    return list;
  }, [data, wr.code, recipe]);

  const weekNum = useMemo(() => weekNumFromHfWeek(wr.hfWeek), [wr.hfWeek]);
  const skuInfoIndex = useMemo(() => allData ? buildSkuInfoIndex(data, wr.hfWeek) : new Map(), [allData, data, wr.hfWeek]);
  const skuMap = useMemo(() => allData ? buildSkuStationMap(allData, wr.hfWeek, weekNum) : new Map(), [allData, wr.hfWeek, weekNum]);
  const funnel = useMemo(() => allData ? buildFunnel(allData, skuMap, wr.hfWeek, weekNum) : [], [allData, skuMap, wr.hfWeek, weekNum]);

  const load = async () => {
    setLoadState("loading");
    setLoadError(null);
    try {
      const result = await fetchAllWmsStations(wr.hfWeek, { onRetry: (_attempt, message) => setLoadError(message) });
      setAllData(result.data);
      // Wochen-Submeals stehen jetzt eh geladen im Speicher — gleich in den
      // globalen WO-Abgleich einspeisen, nicht nur für dieses eine Rezept.
      reconciliation?.ingestWmsWorkorders(result.data.workorders.rows);
      setLoadState("ready");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setLoadState("error");
    }
  };

  return (
    <div className="card overflow-hidden md:col-span-2 border border-indigo-200">
      <div className="px-4 py-3 border-b border-indigo-100 bg-gradient-to-r from-indigo-50 to-violet-50/40 flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">WMS-Übersicht · Vollständige Historie</h3>
          <p className="text-[11px] text-slate-500 mt-0.5">Wareneingang, Staging, Debox, Post-Blast, Plating, Sleeving — live aus Snowflake</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loadState === "loading"}
          className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold transition-colors shrink-0">
          {loadState === "loading" ? "Lädt…" : loadState === "ready" ? "↻ Neu laden" : "WMS-Daten laden"}
        </button>
      </div>
      {loadState === "error" && <div className="px-4 py-3 text-sm text-red-600">{loadError}</div>}
      {loadState === "loading" && loadError && <div className="px-4 py-3 text-sm text-slate-500">{loadError}</div>}
      {loadState === "ready" && (
        candidateSkus.some(c => skuMap.has(c.sku.trim().toUpperCase())) ? (
          <div className="p-3 flex flex-wrap gap-2">
            {candidateSkus.map(c => {
              const has = skuMap.has(c.sku.trim().toUpperCase());
              return (
                <button key={c.sku} type="button" disabled={!has} onClick={() => setDetailSku(c.sku)}
                  className={`text-xs px-3 py-2 rounded-lg ring-1 text-left transition-colors ${has ? "ring-indigo-300 bg-indigo-50 hover:bg-indigo-100 text-indigo-800" : "ring-slate-200 bg-slate-50 text-slate-400"}`}>
                  <div className="font-mono font-semibold">{c.sku}</div>
                  <div className="text-[10px]">{c.label}{!has ? " · keine Daten in dieser KW" : ""}</div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-4 py-4 text-sm text-slate-500">Keine WMS-Stationsdaten für dieses Meal in {wr.hfWeek} gefunden.</div>
        )
      )}

      {detailSku && allData && (
        <SkuDetailPanel
          sku={detailSku}
          allData={allData}
          funnel={funnel}
          selectedWeek={wr.hfWeek}
          weekNum={weekNum}
          skuInfoIndex={skuInfoIndex}
          onClose={() => setDetailSku(null)}
          onTrace={(sku) => { setDetailSku(null); setTraceSku(sku); }}
        />
      )}
      {traceSku && (
        <div className="px-3 pb-3">
          <TracePanel sku={traceSku} funnel={funnel} skuInfoIndex={skuInfoIndex} onClear={() => setTraceSku(null)} />
        </div>
      )}
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

export function OverviewTab({ wr, recipe, market, md, portionsTotal, upliftPercent, productionPlan, data }: Props) {
  const planningIntel = useRecipePlanningIntel(wr.code);
  const rampHistory = useRampHistory(wr);

  return (
    <div className="grid md:grid-cols-2 gap-3">
      <ProductionCard wr={wr} portionsTotal={portionsTotal} upliftPercent={upliftPercent} />
      <MarketVariantCard market={market} md={md} recipe={recipe} />
      <AllergenSummaryCard recipe={recipe} market={market} md={md} />
      <PlanningIntelCard wr={wr} planningIntel={planningIntel} />
      {productionPlan && <ProductionPlanCard wr={wr} productionPlan={productionPlan} />}
      <RedzoneMealHistoryCard wr={wr} recipe={recipe} />
      <WoReconciliationCard wr={wr} />
      <WmsMealTraceCard wr={wr} recipe={recipe} data={data} />
      <RampUpHistoryCard wr={wr} history={rampHistory} />
    </div>
  );
}
