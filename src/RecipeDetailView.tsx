import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DataBundle, Market, WeekRecipe, Recipe, CookSchedule, ProcessSpec, ShelfLifeInfo, DetailedSubRecipe, RecipeStructure } from "./types";
import { getBaseVerdenVolume, getSubRecipeMassProfile, workflowSteps } from "./equipment";
import { marketVariantLabel, MARKET_LANGUAGE_LABEL } from "./i18n";
import { useRecipePlanningIntel } from "./planningOasisData";
import { getRampUpHistory } from "./rampUpHistory";
import {
  fmtNum, fmtMin, fmtIngName, scaleQty, adjustedPortions, resolveStructureByCode,
  resolveCookSchedule, matchedScheduleSteps, oneShiftLabel, oneShiftShortLabel, getFulfillmentSplit,
  shelfLifeTone, findShelfLifeNameHint, isPreproductionRecommended, methodColorToCSS,
  subRecipeTone, subRecipeUrgency, subRecipeUrgencyLabel, ingredientSectionTone, categoryRiskTone,
  matchesNeedle, engpassStatus, engpassStatusLabel, engpassStatusColor,
  engpassScenarioText, recipeHue, usePersistent, MARKETS, MARKET_COLOR, MARKET_LABEL
} from "./helpers";

// ─── Types ─────────────────────────────────────────────────────────────────

type Tab = "overview" | "subrecipes" | "structure" | "ingredients" | "engpass" | "plating" | "cook" | "workflow";

interface EngpassRow {
  sub: string; subCategory: string; ingredient: string; ingredientId: string;
  uom: string; perPortion: number; perPortionWithYield: number; yieldLossPct: number;
  totalNeeded: number; totalNeededWithYield: number;
  available: number | null; availableDisplay: number | null;
  displayUom: string; convFactor: number;
  maxPortions: number | null; shortfall: number | null;
  status: "ok" | "warn" | "critical" | "unknown";
}

// ─── Micro-components ──────────────────────────────────────────────────────

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg px-2 py-1 ${accent ? "bg-verden-50 ring-1 ring-verden-500" : "bg-slate-50"}`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function IntelMiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-lg font-black tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{k}</dt>
      <dd className="col-span-2">{v}</dd>
    </div>
  );
}

export function RampHistorySparkline({ values, width = 96, height = 24 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;
  const points = values.map((value, index) => {
    const x = pad + (index / (values.length - 1)) * (width - pad * 2);
    const y = pad + ((max - value) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const first = values[0];
  const last = values[values.length - 1];
  const stroke = last > first ? "#059669" : last < first ? "#e11d48" : "#64748b";
  const lastPoint = points.split(" ").pop()?.split(",") ?? ["0", "0"];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
      <circle cx={lastPoint[0]} cy={lastPoint[1]} r="2" fill={stroke} />
    </svg>
  );
}

function RampHistoryDeltaPill({ delta }: { delta: number }) {
  if (delta === 0) return <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">0</span>;
  const up = delta > 0;
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${up ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>
      {up ? "+" : ""}{fmtNum(delta)}
    </span>
  );
}

// ─── OverviewTab ───────────────────────────────────────────────────────────

function OverviewTab({ wr, recipe, market, md, portionsTotal, upliftPercent, productionPlan }:
  { wr: WeekRecipe; recipe: Recipe; market: Market; md?: Recipe["markets"][Market]; portionsTotal: number; upliftPercent: number; productionPlan?: import("./types").ProductionPlan }) {
  const baseTotal = getBaseVerdenVolume(wr);
  const planningIntel = useRecipePlanningIntel(wr.code);
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setHistoryVersion(v => v + 1);
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("storage", refresh); };
  }, [wr.hfWeek]);

  const rampSnapshots = useMemo(
    () => getRampUpHistory(wr.hfWeek).filter(s => Object.prototype.hasOwnProperty.call(s.volumes, wr.code)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyVersion, wr.code, wr.hfWeek]
  );
  const latestRampSnapshot = rampSnapshots[rampSnapshots.length - 1] ?? null;
  const rampEntries = useMemo(() => rampSnapshots.map((snapshot, index) => ({
    snapshot,
    current: snapshot.volumes[wr.code] ?? 0,
    previous: index > 0 ? (rampSnapshots[index - 1]?.volumes[wr.code] ?? 0) : null,
    delta: index > 0 ? (snapshot.volumes[wr.code] ?? 0) - (rampSnapshots[index - 1]?.volumes[wr.code] ?? 0) : null,
  })).reverse(), [rampSnapshots, wr.code]);

  return (
    <div className="grid md:grid-cols-2 gap-3">
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

      {productionPlan && (() => {
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
      })()}

      <div className="card p-4 md:col-span-2 border border-violet-200 bg-gradient-to-r from-violet-50 via-white to-cyan-50">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Ramp-up / Forecast Historie</h3>
            <div className="text-xs text-slate-500">Wie sich die Meal-Zahl im Wochenverlauf geändert hat.</div>
          </div>
          {latestRampSnapshot && (
            <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 ring-1 ring-slate-300">
              Letztes Update {latestRampSnapshot.label}
            </span>
          )}
        </div>
        {rampEntries.length === 0 ? (
          <div className="mt-3 rounded-xl bg-white px-3 py-3 text-sm text-slate-500 ring-1 ring-slate-200">
            Noch keine Ramp-up-Historie für dieses Meal in dieser Woche vorhanden.
          </div>
        ) : (
          <div className="mt-3 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
              <div className="grid grid-cols-2 gap-2">
                <IntelMiniStat label="Aktuell" value={fmtNum(latestRampSnapshot?.volumes[wr.code] ?? wr.totalVerdenVolume)} />
                <IntelMiniStat label="Änderung zuletzt" value={rampEntries[0]?.delta === null ? "Basis" : `${(rampEntries[0].delta ?? 0) > 0 ? "+" : ""}${fmtNum(rampEntries[0]?.delta ?? 0)}`} />
                <IntelMiniStat label="Snapshots" value={fmtNum(rampEntries.length)} />
                <IntelMiniStat label="Von → Bis" value={`${fmtNum(rampEntries[rampEntries.length - 1]?.current ?? 0)} → ${fmtNum(rampEntries[0]?.current ?? 0)}`} />
              </div>
              {rampSnapshots.length >= 2 && (
                <div className="mt-3 rounded-lg bg-slate-50 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Trend</div>
                  <div className="mt-2"><RampHistorySparkline values={rampSnapshots.map(s => s.volumes[wr.code] ?? 0)} /></div>
                </div>
              )}
            </div>
            <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Letzte Änderungen</div>
              <div className="mt-2 space-y-2">
                {rampEntries.slice(0, 6).map(({ snapshot, current, previous, delta }) => (
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
    </div>
  );
}

// ─── Sub-Recipe Tree (SVG) ─────────────────────────────────────────────────

const TW = 220; const TH = 62; const TGX = 72; const TGY = 14; const TPAD = 32;

const CATEGORY_COLOR: Record<string, string> = {
  GRILL: "bg-rose-100 text-rose-800 border-rose-300",
  OVEN: "bg-orange-100 text-orange-800 border-orange-300",
  BRAISER: "bg-amber-100 text-amber-800 border-amber-300",
  BRINE: "bg-cyan-100 text-cyan-800 border-cyan-300",
  MARINADE: "bg-violet-100 text-violet-800 border-violet-300",
  "BLAST CHILLER": "bg-sky-100 text-sky-800 border-sky-300",
  "PLANETARY MIXER": "bg-emerald-100 text-emerald-800 border-emerald-300",
  "HAND MIX": "bg-lime-100 text-lime-800 border-lime-300",
  "IMMERSION BLENDER": "bg-teal-100 text-teal-800 border-teal-300",
  STAGING: "bg-slate-100 text-slate-700 border-slate-300",
};

function categoryBadges(categories: string) {
  if (!categories) return null;
  const cats = categories.split(/[,/]/).map(s => s.trim()).filter(Boolean);
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {cats.map(c => {
        const cls = Object.entries(CATEGORY_COLOR).find(([k]) => c.toUpperCase().includes(k))?.[1] ?? "bg-slate-100 text-slate-600 border-slate-200";
        return <span key={c} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${cls}`}>{c}</span>;
      })}
    </div>
  );
}

function IngredientRow({ ing }: { ing: DetailedSubRecipe["ingredients"][number] }) {
  return (
    <div className="flex items-start gap-2 py-1 border-b border-dashed border-slate-100 last:border-0">
      <span className="mt-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-400 w-7 shrink-0">ING</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-700 font-medium truncate">{fmtIngName(ing.name)}</div>
        <div className="text-[10px] text-slate-400 tabular-nums">
          {ing.grossQty > 0 ? `Brutto ${ing.grossQty} ${ing.uom}` : ""}
          {ing.netQty > 0 && ing.netQty !== ing.grossQty ? ` / Netto ${ing.netQty}` : ""}
          {ing.allergen ? ` · ⚠ ${ing.allergen}` : ""}
        </div>
      </div>
    </div>
  );
}

function countIngredients(node: DetailedSubRecipe): number {
  return node.ingredients.length + node.subRecipes.reduce((s, c) => s + countIngredients(c), 0);
}

function SubRecipeNode({ node, depth }: { node: DetailedSubRecipe; depth: number }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.subRecipes.length > 0 || node.ingredients.length > 0;
  const totalIng = countIngredients(node);
  const borderCols = ["border-l-indigo-400", "border-l-violet-400", "border-l-fuchsia-400", "border-l-rose-400"];
  const borderClass = borderCols[Math.min(depth, borderCols.length - 1)];
  return (
    <div className={`ml-${depth === 0 ? "0" : "5"} mt-2`}>
      <div className={`rounded-xl border border-slate-200 border-l-4 ${borderClass} bg-white shadow-sm`}>
        <button onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 p-3 text-left">
          <span className={`mt-0.5 text-[9px] font-bold uppercase tracking-widest shrink-0 ${depth === 0 ? "text-indigo-500" : depth === 1 ? "text-violet-500" : "text-fuchsia-500"}`}>SUB{depth + 1}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-800 leading-snug">{node.name}</div>
            {categoryBadges(node.categories)}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {node.quantity != null && <span className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full tabular-nums">{node.quantity} {node.uom ?? ""}</span>}
            <span className="text-[10px] text-slate-400">{totalIng} Zutat{totalIng !== 1 ? "en" : ""}</span>
            <span className="text-slate-400 text-xs">{open ? "▾" : "▸"}</span>
          </div>
        </button>
        {open && hasChildren && (
          <div className="border-t border-slate-100 px-3 pb-3 pt-2">
            {node.ingredients.length > 0 && (
              <div className="mb-2 rounded-lg bg-slate-50 px-2 py-1">
                {node.ingredients.map((ing, i) => <IngredientRow key={i} ing={ing} />)}
              </div>
            )}
            {node.subRecipes.map((sub, i) => <SubRecipeNode key={sub.id || i} node={sub} depth={depth + 1} />)}
          </div>
        )}
      </div>
    </div>
  );
}

interface FlatTreeNode {
  id: string; label: string; categories: string; ingCount: number; depth: number;
  cx: number; cy: number; parentId: string | null; hasChildren: boolean; expanded: boolean;
  node: DetailedSubRecipe;
}

function subtreeLeafCount(nodes: DetailedSubRecipe[], exp: Set<string>): number {
  return nodes.reduce((s, n) => {
    const id = n.id || n.name;
    return s + (exp.has(id) && n.subRecipes.length > 0 ? subtreeLeafCount(n.subRecipes, exp) : 1);
  }, 0);
}

function buildFlatTree(roots: DetailedSubRecipe[], expanded: Set<string>): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  function layout(nodes: DetailedSubRecipe[], depth: number, leafStart: number, parentId: string | null): number {
    let li = leafStart;
    for (const node of nodes) {
      const id = node.id || node.name;
      const isExpanded = expanded.has(id) && node.subRecipes.length > 0;
      const leaves = isExpanded ? subtreeLeafCount(node.subRecipes, expanded) : 1;
      result.push({
        id, label: node.name, categories: node.categories ?? "", ingCount: node.ingredients.length,
        depth, cx: TPAD + depth * (TW + TGX), cy: TPAD + (li + (leaves - 1) / 2) * (TH + TGY),
        parentId, hasChildren: node.subRecipes.length > 0, expanded: isExpanded, node
      });
      if (isExpanded) li = layout(node.subRecipes, depth + 1, li, id);
      else li += 1;
    }
    return li;
  }
  layout(roots, 0, 0, null);
  return result;
}

function TreeCanvas({ roots, code }: { roots: DetailedSubRecipe[]; code: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const all = new Set<string>();
    function collect(nodes: DetailedSubRecipe[]) { for (const n of nodes) { all.add(n.id || n.name); collect(n.subRecipes); } }
    collect(roots);
    return all;
  });
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const flatNodes = useMemo(() => buildFlatTree(roots, expanded), [roots, expanded]);

  const maxDepth = flatNodes.reduce((m, n) => Math.max(m, n.depth), 0);
  const maxLeaf = flatNodes.reduce((m, n) => Math.max(m, n.cy + TH / 2 + TPAD), 0);
  const svgW = TPAD * 2 + (maxDepth + 1) * (TW + TGX) - TGX;
  const svgH = maxLeaf;
  const hue = recipeHue(code);

  function toggleNode(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function collapseAll() { setExpanded(new Set()); }
  function expandAll() {
    const all = new Set<string>();
    function collect(nodes: DetailedSubRecipe[]) { for (const n of nodes) { all.add(n.id || n.name); collect(n.subRecipes); } }
    collect(roots);
    setExpanded(all);
  }

  const nodeById = new Map(flatNodes.map(n => [n.id, n]));
  const selectedNode = selected ? nodeById.get(selected) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <button onClick={expandAll} className="btn text-xs">Alle aufklappen</button>
        <button onClick={collapseAll} className="btn text-xs">Alle einklappen</button>
        <span className="text-xs text-slate-500">{flatNodes.length} Sub-Rezepte · {flatNodes.reduce((s, n) => s + n.ingCount, 0)} Zutaten gesamt</span>
      </div>
      <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm" style={{ maxHeight: "60vh" }}>
        <svg width={svgW} height={svgH} style={{ minWidth: svgW }}>
          {flatNodes.map(node => {
            const parent = node.parentId ? nodeById.get(node.parentId) : null;
            if (!parent) return null;
            const x1 = parent.cx + TW;
            const y1 = parent.cy + TH / 2;
            const x2 = node.cx;
            const y2 = node.cy + TH / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path key={`edge-${node.id}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                fill="none" stroke={`hsl(${hue} 40% 74%)`} strokeWidth="1.5" opacity="0.8" />
            );
          })}
          {flatNodes.map(node => {
            const isHover = hover === node.id;
            const isSel = selected === node.id;
            const cats = node.categories.split(/[,/]/).map(s => s.trim()).filter(Boolean);
            const mainCat = cats[0] ?? "";
            const catEntry = Object.entries(CATEGORY_COLOR).find(([k]) => mainCat.toUpperCase().includes(k));
            return (
              <foreignObject key={node.id} x={node.cx} y={node.cy} width={TW} height={TH}
                style={{ cursor: node.hasChildren ? "pointer" : "default" }}
                onClick={() => { if (node.hasChildren) toggleNode(node.id); setSelected(isSel ? null : node.id); }}
                onMouseEnter={() => setHover(node.id)} onMouseLeave={() => setHover(null)}>
                <div className={`h-full w-full rounded-xl border text-xs flex flex-col justify-center px-2 py-1 transition-all ${
                  isSel ? "shadow-md ring-2" : isHover ? "shadow-sm ring-1" : "shadow-sm"
                }`} style={{
                  borderColor: isSel ? `hsl(${hue} 70% 46%)` : isHover ? `hsl(${hue} 52% 62%)` : `hsl(${hue} 40% 78%)`,
                  background: isSel ? `hsl(${hue} 78% 92%)` : isHover ? `hsl(${hue} 60% 96%)` : `hsl(${hue} 38% 97%)`,
                }}>
                  <div className="font-semibold text-slate-800 truncate leading-tight" title={node.label}>{node.label}</div>
                  {catEntry && <span className={`mt-0.5 self-start rounded px-1 text-[9px] font-semibold border ${catEntry[1]}`}>{mainCat}</span>}
                  <div className="mt-0.5 text-[9px] text-slate-400 flex items-center gap-1">
                    <span>{node.ingCount} Zut.</span>
                    {node.hasChildren && <span>{node.expanded ? "▾" : "▸"} {node.node.subRecipes.length} Sub</span>}
                  </div>
                </div>
              </foreignObject>
            );
          })}
        </svg>
      </div>
      {selectedNode && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm text-sm space-y-2">
          <div className="font-semibold text-slate-800">{selectedNode.label}</div>
          {categoryBadges(selectedNode.categories)}
          {selectedNode.node.ingredients.length > 0 && (
            <div className="rounded-lg bg-slate-50 px-2 py-1 divide-y divide-slate-100">
              {selectedNode.node.ingredients.map((ing, i) => <IngredientRow key={i} ing={ing} />)}
            </div>
          )}
          {selectedNode.node.ingredients.length === 0 && <div className="text-slate-400">Keine direkten Zutaten.</div>}
        </div>
      )}
    </div>
  );
}

// ─── StructureTab ──────────────────────────────────────────────────────────

function StructureTab({ code, structure, market, recipeName, portionsTotal: _portionsTotal, upliftPercent: _upliftPercent }:
  { code: string; structure?: RecipeStructure; market: Market; week: string; recipeName: string; wr: WeekRecipe; portionsTotal: number; upliftPercent: number; data: DataBundle }) {
  const [treeMode, setTreeMode] = useState<"svg" | "list">("svg");

  if (!structure) {
    return (
      <div className="card p-4 text-slate-500">
        <div className="font-semibold mb-1">Kein Detailed-Export für {code} vorhanden.</div>
        <div className="text-xs">Exportiere <code>export-sub-recipes-by-recipe-detailed.csv</code> und führe <code>npm run import:gsheet</code> aus.</div>
      </div>
    );
  }

  const roots = structure.markets[market] ?? [];

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">{recipeName} — Rezeptbaum</h3>
            <div className="text-xs text-slate-500 mt-0.5">{roots.length} Top-Level-Sub-Rezepte · Markt: {MARKET_LABEL[market]}</div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setTreeMode("svg")} className={`btn text-xs ${treeMode === "svg" ? "bg-slate-900 text-white" : ""}`}>SVG-Baum</button>
            <button onClick={() => setTreeMode("list")} className={`btn text-xs ${treeMode === "list" ? "bg-slate-900 text-white" : ""}`}>Liste</button>
          </div>
        </div>
      </div>
      {treeMode === "svg" && roots.length > 0 && <TreeCanvas roots={roots} code={code} />}
      {treeMode === "list" && roots.map((sub, i) => <SubRecipeNode key={sub.id || i} node={sub} depth={0} />)}
      {roots.length === 0 && <div className="card p-4 text-slate-500">Keine Sub-Rezepte im Detailed Export für dieses Rezept.</div>}
    </div>
  );
}

// ─── SubRecipesTab ─────────────────────────────────────────────────────────

function SubRecipesTab({ recipeCode, md, cookSchedules, detailSearch }:
  { recipeCode: string; md: NonNullable<Recipe["markets"][Market]>; cookSchedules: Record<string, CookSchedule>; detailSearch: string }) {
  const needle = detailSearch.trim().toLowerCase();
  const urgencyOrder = { critical: 0, high: 1, medium: 2, low: 3 };

  const items = md.subRecipes
    .filter(s => matchesNeedle([s.id, s.name, s.category, s.methodType, s.methodColor, s.instructions], needle))
    .sort((a, b) => {
      const csA = resolveCookSchedule(a.category, cookSchedules).schedule;
      const csB = resolveCookSchedule(b.category, cookSchedules).schedule;
      return urgencyOrder[subRecipeUrgency(csA?.cookShifts)] - urgencyOrder[subRecipeUrgency(csB?.cookShifts)];
    });

  return (
    <div className="space-y-3">
      {items.map((s, idx) => {
        const resolved = resolveCookSchedule(s.category, cookSchedules);
        const cs = resolved.schedule;
        const tone = subRecipeTone(recipeCode, cs?.cookShifts);
        const urgencyLabel = subRecipeUrgencyLabel(cs?.cookShifts);
        const isNext = idx === 0;
        const colorCSS = methodColorToCSS(s.methodColor);
        const colorPanelStyle: CSSProperties = colorCSS
          ? { backgroundColor: colorCSS + "33", borderColor: colorCSS + "88" }
          : tone.panel;
        const colorTextStyle: CSSProperties = colorCSS
          ? { color: colorCSS.replace(/#([0-9a-f]{6})/i, (_, h) => {
              const r = parseInt(h.slice(0,2),16)*0.4, g = parseInt(h.slice(2,4),16)*0.4, b = parseInt(h.slice(4,6),16)*0.4;
              return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
            })}
          : { color: "#334155" };
        return (
          <div key={s.id} className="overflow-hidden rounded-2xl border shadow-sm" style={tone.frame}>
            <div className="px-4 py-3" style={tone.header}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center justify-center rounded-full text-xs font-bold w-6 h-6 shrink-0 shadow-sm"
                  style={{ backgroundColor: isNext ? "#1e293b" : "#64748b", color: "#fff" }}>{idx + 1}</span>
                {isNext && <span className="pill bg-slate-800 text-white text-[10px] font-semibold px-2 py-0.5">→ Als Nächstes</span>}
                <span className="font-mono text-xs text-slate-500">{s.id}</span>
                <h4 className="font-semibold" style={tone.headerText}>{s.name}</h4>
                {s.category && <span className="pill" style={tone.badge}>{s.category}</span>}
                {cs && <span className="pill" style={tone.urgency}>VF · {cs.cookShifts} Shift{cs.cookShifts > 1 ? "s" : ""}</span>}
                {cs && resolved.matchType !== "exact" && resolved.matchedMethod && (
                  <span className="pill bg-blue-100 text-blue-800">VF-Match via {resolved.matchedMethod}</span>
                )}
                <span className="pill" style={tone.urgency}>Dringlichkeit: {urgencyLabel}</span>
                {!cs && s.category && <span className="pill bg-amber-100 text-amber-800">kein VF-Schedule</span>}
              </div>
            </div>
            <div className="space-y-2 px-4 py-3">
              <div className="grid gap-2 md:grid-cols-2 text-xs">
                <div className="rounded-xl px-3 py-2 ring-1" style={tone.panel}>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">Method-Typ</div>
                  <div className="mt-1 font-medium text-slate-700">{s.methodType || "-"}</div>
                </div>
                <div className="rounded-xl px-3 py-2 ring-1" style={colorPanelStyle}>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">Method-Color</div>
                  <div className="mt-1 flex items-center gap-2 font-semibold" style={colorTextStyle}>
                    {colorCSS && <span className="inline-block h-4 w-4 shrink-0 rounded-full border border-white shadow" style={{ backgroundColor: colorCSS }} />}
                    {s.methodColor || "-"}
                  </div>
                </div>
              </div>
              {s.instructions && (
                <div className="rounded-xl px-3 py-3 text-sm leading-relaxed text-slate-700 ring-1" style={tone.panel}>{s.instructions}</div>
              )}
            </div>
          </div>
        );
      })}
      {items.length === 0 && <div className="card p-4 text-slate-500">Keine Sub-Rezepte für diese Suche gefunden.</div>}
    </div>
  );
}

// ─── IngredientsTab ────────────────────────────────────────────────────────

const INGREDIENT_COLLAPSE_STORAGE_PREFIX = "rezeptlogik-ingredient-collapse-v1";

function IngredientsTab({ recipe, market, portionsTotal, wr, shelfLifeBySku, generatedAt, detailSearch }:
  { recipe: Recipe; market: Market; portionsTotal: number; wr: WeekRecipe; shelfLifeBySku: Record<string, ShelfLifeInfo>; generatedAt: string; detailSearch: string }) {
  const list = recipe.grossIngredients[market] ?? [];

  const grouped = useMemo(() => {
    const m = new Map<string, { sub: string; ingredient: string; ingredientId: string; uom: string; perPortion: number; cat?: string }>();
    for (const g of list) {
      const sub = g.subRecipe1 || g.subRecipe2 || g.subRecipe3 || "—";
      const k = `${sub}::${g.ingredientId}::${g.uom}`;
      const cur = m.get(k);
      if (cur) cur.perPortion += g.grossQuantityPerPortion;
      else m.set(k, { sub, ingredient: g.ingredient, ingredientId: g.ingredientId, uom: g.uom, perPortion: g.grossQuantityPerPortion, cat: g.ingredientCategory });
    }
    return [...m.values()].map(row => {
      const shelfLife = shelfLifeBySku[row.ingredientId];
      const suggested = shelfLife ? undefined : findShelfLifeNameHint(row.ingredient, shelfLifeBySku);
      return {
        ...row, shelfLife, suggested,
        matchReason: shelfLife ? `exakter SKU-Match: ${row.ingredientId}` : !row.ingredientId ? "keine Ingredient-ID im Gross-Export" : suggested ? `kein ID-Match, aber ähnliche Sheet-SKU: ${suggested.skuCode}` : `SKU ${row.ingredientId} nicht im Shelf-Life-Sheet`
      };
    }).sort((a, b) => a.sub === b.sub ? b.perPortion - a.perPortion : a.sub.localeCompare(b.sub));
  }, [list, shelfLifeBySku]);

  const needle = detailSearch.trim().toLowerCase();
  const filteredGrouped = useMemo(() => grouped.filter(g => matchesNeedle([g.sub, g.ingredient, g.ingredientId, g.cat, g.shelfLife?.skuCode, g.shelfLife?.skuName], needle)), [grouped, needle]);

  const groupedSections = useMemo(() => {
    const sections = new Map<string, typeof filteredGrouped>();
    for (const row of filteredGrouped) {
      const bucket = sections.get(row.sub) ?? [];
      bucket.push(row);
      sections.set(row.sub, bucket);
    }
    return [...sections.entries()].map(([sub, rows]) => ({
      sub, rows,
      totalPerPortion: rows.reduce((s, r) => s + r.perPortion, 0),
      categoryTotals: [...rows.reduce((acc, row) => {
        const key = row.cat?.trim() || "ohne Kategorie";
        const bucket = acc.get(key) ?? new Map<string, number>();
        bucket.set(row.uom, (bucket.get(row.uom) ?? 0) + row.perPortion);
        acc.set(key, bucket);
        return acc;
      }, new Map<string, Map<string, number>>()).entries()].map(([category, totals]) => {
        const rowsInCat = rows.filter(r => (r.cat?.trim() || "ohne Kategorie") === category);
        const riskStatus: ShelfLifeInfo["status"] | "unknown" = rowsInCat.some(r => r.shelfLife?.status === "critical") ? "critical" : rowsInCat.some(r => r.shelfLife?.status === "risk") ? "risk" : rowsInCat.some(r => r.shelfLife?.status === "ok") ? "ok" : "unknown";
        return { category, riskStatus, totals: [...totals.entries()].map(([uom, total]) => ({ uom, total })) };
      }).sort((a, b) => a.category.localeCompare(b.category)),
      unitTotals: [...rows.reduce((acc, row) => { acc.set(row.uom, (acc.get(row.uom) ?? 0) + row.perPortion); return acc; }, new Map<string, number>()).entries()].map(([uom, total]) => ({ uom, total })).sort((a, b) => a.uom.localeCompare(b.uom))
    })).sort((a, b) => a.sub.localeCompare(b.sub));
  }, [filteredGrouped]);

  const shelfSummary = useMemo(() => {
    const known = filteredGrouped.filter(g => !!g.shelfLife);
    return { known: known.length, critical: known.filter(g => g.shelfLife?.status === "critical").length, risk: known.filter(g => g.shelfLife?.status === "risk").length };
  }, [filteredGrouped]);

  const collapseStorageKey = useMemo(() => `${INGREDIENT_COLLAPSE_STORAGE_PREFIX}:${wr.code}:${market}`, [wr.code, market]);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(window.localStorage.getItem(collapseStorageKey) ?? "{}"); } catch { return {}; }
  });

  useEffect(() => {
    setCollapsedSections(() => { try { return JSON.parse(window.localStorage.getItem(collapseStorageKey) ?? "{}"); } catch { return {}; } });
  }, [collapseStorageKey]);

  useEffect(() => {
    try { window.localStorage.setItem(collapseStorageKey, JSON.stringify(collapsedSections)); } catch { /* quota */ }
  }, [collapseStorageKey, collapsedSections]);

  const allCollapsed = groupedSections.length > 0 && groupedSections.every(s => collapsedSections[s.sub]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-slate-700">
          Brutto-Zutaten ({MARKET_LABEL[market]}) — hochgerechnet auf <b>{fmtNum(portionsTotal)}</b> Portionen Verden gesamt
        </h3>
        <div className="text-right">
          <div className="text-xs text-slate-500">{list.length} Zeilen aus Gross-Export</div>
          <div className="text-[11px] text-slate-400">Datenstand: {new Date(generatedAt).toLocaleString("de-DE")}</div>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <Stat label="Sheet-Matches" value={fmtNum(shelfSummary.known)} />
        <Stat label="kritisch < 7d" value={fmtNum(shelfSummary.critical)} accent={shelfSummary.critical > 0} />
        <Stat label="knapp" value={fmtNum(shelfSummary.risk)} accent={shelfSummary.risk > 0} />
        <Stat label="Kundenziel" value="7 Tage" />
      </div>
      {groupedSections.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
          <div className="text-xs text-slate-500">{fmtNum(groupedSections.length)} Sub-Rezept-Blöcke sichtbar.</div>
          <button className="btn" onClick={() => setCollapsedSections(Object.fromEntries(groupedSections.map(s => [s.sub, !allCollapsed])))}>
            {allCollapsed ? "Alle aufklappen" : "Alle einklappen"}
          </button>
        </div>
      )}
      {list.length === 0 && <div className="text-slate-500 text-sm">Keine Brutto-Daten für {MARKET_LABEL[market]}.</div>}
      <div className="space-y-4">
        {groupedSections.map((section, index) => {
          const tone = ingredientSectionTone(index);
          const isCollapsed = !!collapsedSections[section.sub];
          return (
            <div key={section.sub} className={`rounded-2xl border bg-white shadow-sm overflow-hidden ${tone.frame}`}>
              <button className={`flex w-full flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-left ${tone.header} ${tone.frame}`}
                onClick={() => setCollapsedSections(prev => ({ ...prev, [section.sub]: !prev[section.sub] }))}>
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Sub-Rezept</div>
                  <h4 className={`text-base font-semibold ${tone.headerText}`}>{section.sub}</h4>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
                  <span className={tone.badge}>{fmtNum(section.rows.length)} Zutaten</span>
                  {section.unitTotals.map(t => <span key={`${section.sub}-${t.uom}`} className={tone.badge}>Σ {scaleQty(t.total, 1, t.uom)} / Portion</span>)}
                  <span className={`rounded-full px-2.5 py-1 font-semibold uppercase tracking-wide ${isCollapsed ? "bg-slate-200 text-slate-600" : "bg-slate-800 text-white"}`}>{isCollapsed ? "zu" : "offen"}</span>
                </div>
              </button>
              {!isCollapsed && (
                <>
                  <div className="border-b border-slate-100 bg-white px-4 py-3">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Kategorien im Block</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {section.categoryTotals.map(cat => (
                        <span key={`${section.sub}-${cat.category}`} className={`pill text-xs ${categoryRiskTone(cat.riskStatus)}`}>
                          {cat.category}: {cat.totals.map(t => scaleQty(t.total, 1, t.uom)).join(" · ")}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs uppercase tracking-wide text-slate-500 bg-white">
                        <tr className="border-b border-slate-100">
                          <th className="text-left py-2 pr-2 pl-4">Zutat</th>
                          <th className="text-left py-2 pr-2">Cat</th>
                          <th className="text-right py-2 pr-2">/ Portion</th>
                          <th className="text-right py-2 pr-2">Σ {fmtNum(portionsTotal)} Portionen</th>
                          <th className="text-left py-2 pr-4 pl-2">Shelf / MLOR</th>
                        </tr>
                      </thead>
                      <tbody>
                        {section.rows.map((g, i) => (
                          <tr key={`${section.sub}-${g.ingredientId}-${i}`} className="border-b border-slate-100 last:border-0 align-top hover:bg-slate-50/80">
                            <td className="py-2 pr-2 pl-4">
                              <div className="font-medium text-slate-800">{g.ingredient}</div>
                              <div className="font-mono text-[10px] text-slate-400">{g.ingredientId || "ohne SKU"}</div>
                            </td>
                            <td className="py-2 pr-2"><span className="pill bg-slate-100 text-slate-700">{g.cat ?? "-"}</span></td>
                            <td className="py-2 pr-2 text-right tabular-nums">{fmtNum(g.perPortion, 2)} {g.uom}</td>
                            <td className="py-2 pr-2 text-right tabular-nums font-semibold">{scaleQty(g.perPortion, portionsTotal, g.uom)}</td>
                            <td className="py-2 pl-2 pr-4 text-xs">
                              {g.shelfLife ? (
                                <div className="space-y-1">
                                  <span className={`pill ${shelfLifeTone(g.shelfLife.status)}`}>{g.shelfLife.status === "critical" ? "kritisch" : g.shelfLife.status === "risk" ? "knapp" : g.shelfLife.status === "ok" ? "ok" : "unbekannt"}</span>
                                  <div className="font-mono text-[10px] text-slate-500">{g.matchReason}</div>
                                  <div className="text-slate-600">MLOR: {g.shelfLife.mlorRaw ?? "-"}</div>
                                  <div className="text-slate-600">Open: {g.shelfLife.openShelfLifeRaw ?? "-"}</div>
                                </div>
                              ) : (
                                <div className="space-y-1">
                                  <span className="text-slate-400">kein Sheet-Match</span>
                                  <div className="font-mono text-[10px] text-slate-500">{g.matchReason}</div>
                                  {g.suggested && <div className="text-[10px] text-blue-700">Namenshinweis: {g.suggested.skuCode} · {g.suggested.skuName}</div>}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className={`flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs ${tone.header} ${tone.frame}`}>
                    <div className="font-semibold text-slate-600">Summen für {section.sub}</div>
                    <div className="flex flex-wrap gap-2">
                      {section.unitTotals.map(t => (
                        <span key={`${section.sub}-footer-${t.uom}`} className={tone.badge}>
                          {t.uom}: {scaleQty(t.total, 1, t.uom)} / Portion · {scaleQty(t.total, portionsTotal, t.uom)} gesamt
                        </span>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {list.length > 0 && filteredGrouped.length === 0 && <div className="mt-3 text-sm text-slate-500">Keine Zutaten-Treffer für diese Suche.</div>}
    </div>
  );
}

// ─── EngpassTab ────────────────────────────────────────────────────────────

function EngpassTab({ recipe, market, portionsTotal, wr, md }:
  { recipe: Recipe; market: Market; portionsTotal: number; wr: WeekRecipe; md?: Recipe["markets"][Market] }) {
  const list = recipe.grossIngredients[market] ?? [];
  const [yieldEnabled, setYieldEnabled] = usePersistent<boolean>("engpass_yield_enabled", true);
  const [yieldLossByProcess, setYieldLossByProcess] = usePersistent<Record<string, number>>("engpass_yield_loss_v1", {
    "Grill": 8, "Oven": 6, "Braiser": 10, "Blast Chiller": 2, "Drain": 3, "Hand Mix": 2
  });
  const subCategoryByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of md?.subRecipes ?? []) { const k = s.name.trim().toLowerCase(); if (k) m.set(k, s.category ?? ""); }
    return m;
  }, [md?.subRecipes]);

  function calcYieldLossPct(subCategory: string): number {
    if (!yieldEnabled || !subCategory) return 0;
    const low = subCategory.toLowerCase();
    const matched = Object.entries(yieldLossByProcess).filter(([name, pct]) => Number.isFinite(pct) && pct > 0 && low.includes(name.toLowerCase())).map(([, pct]) => Math.max(0, Math.min(40, pct)));
    if (!matched.length) return 0;
    return Math.max(0, Math.min(90, (1 - matched.reduce((acc, pct) => acc * (1 - pct / 100), 1)) * 100));
  }

  function dispUom(uom: string): { displayUom: string; convFactor: number } {
    const u = uom.toLowerCase();
    if (u === "grams" || u === "g") return { displayUom: "kg", convFactor: 1000 };
    if (u === "ml") return { displayUom: "L", convFactor: 1000 };
    return { displayUom: uom, convFactor: 1 };
  }

  const baseRows = useMemo(() => {
    const m = new Map<string, { sub: string; subCategory: string; ingredient: string; ingredientId: string; uom: string; perPortion: number }>();
    for (const g of list) {
      const sub = g.subRecipe1 || g.subRecipe2 || g.subRecipe3 || "—";
      const subCategory = subCategoryByName.get(sub.trim().toLowerCase()) ?? "";
      const k = `${sub}::${g.ingredientId}::${g.uom}`;
      const cur = m.get(k);
      if (cur) cur.perPortion += g.grossQuantityPerPortion;
      else m.set(k, { sub, subCategory, ingredient: g.ingredient, ingredientId: g.ingredientId, uom: g.uom, perPortion: g.grossQuantityPerPortion });
    }
    return [...m.values()].sort((a, b) => a.sub === b.sub ? b.perPortion - a.perPortion : a.sub.localeCompare(b.sub));
  }, [list, subCategoryByName]);

  const storageKey = `rezeptlogik_v1_engpass_${wr.code}_${market}`;
  const [availableMap, setAvailableMap] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { return {}; } });
  const [engpassSort, setEngpassSort] = useState<"default"|"status"|"shortfall"|"name">("default");
  const [copied, setCopied] = useState(false);

  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(availableMap)); } catch { /* quota */ } }, [availableMap, storageKey]);

  const rows: EngpassRow[] = useMemo(() => {
    const base = baseRows.map(r => {
      const key = `${r.sub}::${r.ingredientId}::${r.uom}`;
      const { displayUom: du, convFactor } = dispUom(r.uom);
      const totalNeeded = r.perPortion * portionsTotal;
      const yieldLossPct = calcYieldLossPct(r.subCategory);
      const yieldFactor = Math.max(0.1, 1 - (yieldLossPct / 100));
      const perPortionWithYield = r.perPortion / yieldFactor;
      const totalNeededWithYield = totalNeeded / yieldFactor;
      const rawInput = availableMap[key];
      const availableDisplay = rawInput !== undefined && rawInput !== "" ? parseFloat(rawInput) : null;
      const available = availableDisplay !== null && !isNaN(availableDisplay) ? availableDisplay * convFactor : null;
      const maxPortions = available !== null && perPortionWithYield > 0 ? Math.floor(available / perPortionWithYield) : null;
      const shortfall = available !== null ? Math.max(0, totalNeededWithYield - available) : null;
      return { ...r, perPortionWithYield, yieldLossPct, totalNeeded, totalNeededWithYield, available, availableDisplay, displayUom: du, convFactor, maxPortions, shortfall, status: engpassStatus(maxPortions, portionsTotal) } as EngpassRow;
    });
    const statusOrder = { critical: 0, warn: 1, ok: 2, unknown: 3 };
    if (engpassSort === "status") return [...base].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
    if (engpassSort === "shortfall") return [...base].sort((a, b) => (b.shortfall ?? -1) - (a.shortfall ?? -1));
    if (engpassSort === "name") return [...base].sort((a, b) => a.ingredient.localeCompare(b.ingredient, "de"));
    return base;
  }, [baseRows, portionsTotal, availableMap, engpassSort, yieldEnabled, yieldLossByProcess]);

  const configured = rows.filter(r => r.available !== null);
  const bottleneck = configured.length > 0 ? configured.reduce((min, r) => (r.maxPortions ?? Infinity) < (min.maxPortions ?? Infinity) ? r : min) : null;
  const criticalRows = rows.filter(r => r.status === "critical");
  const warnRows = rows.filter(r => r.status === "warn");
  const effectivePortions = bottleneck?.maxPortions ?? portionsTotal;
  const portionScale = portionsTotal > 0 ? effectivePortions / portionsTotal : 1;

  function exportToClipboard() {
    const header = ["Zutat","SKU","Sub-Rezept","/ Portion","Yield-Verlust %","Einheit","Σ Bedarf","Σ inkl. Yield","Verfügbar","Max. Portionen","Fehlmenge","Status"].join("\t");
    const tsv = rows.map(r => [r.ingredient,r.ingredientId,r.sub,String(r.perPortion/r.convFactor).replace(".",","),String(r.yieldLossPct.toFixed(1)).replace(".",","),r.displayUom,String((r.totalNeeded/r.convFactor).toFixed(3)).replace(".",","),String((r.totalNeededWithYield/r.convFactor).toFixed(3)).replace(".",","),r.availableDisplay!==null?String(r.availableDisplay.toFixed(3)).replace(".",","):"",r.maxPortions!==null?String(r.maxPortions):"",r.shortfall!==null?String((r.shortfall/r.convFactor).toFixed(3)).replace(".",","):"",engpassStatusLabel(r.status)].join("\t")).join("\n");
    navigator.clipboard.writeText(header + "\n" + tsv).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); });
  }

  if (list.length === 0) return <div className="card p-4 text-slate-500">Keine Brutto-Zutaten für {MARKET_LABEL[market]} vorhanden.</div>;

  return (
    <div className="space-y-4">
      <div className={`card p-4 ${criticalRows.length > 0 ? "ring-2 ring-rose-300" : warnRows.length > 0 ? "ring-2 ring-amber-300" : "ring-1 ring-slate-200"}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Engpass-Analyse</div>
            <div className="text-lg font-bold text-slate-900 mt-0.5">
              {configured.length === 0 ? "Verfügbare Mengen eingeben →" : criticalRows.length > 0 ? `${criticalRows.length} Engpass${criticalRows.length > 1 ? "pässe" : ""} erkannt` : warnRows.length > 0 ? `${warnRows.length} Zutat${warnRows.length > 1 ? "en" : ""} knapp` : "Alle eingegebenen Mengen ausreichend ✓"}
            </div>
            <div className="mt-1 text-sm text-slate-600">
              Geplante Portionen: <b>{fmtNum(portionsTotal)}</b>
              {bottleneck && bottleneck.status !== "ok" && <> · Erreichbar mit Engpass: <b className={criticalRows.length > 0 ? "text-rose-700" : "text-amber-700"}>{fmtNum(effectivePortions)}</b> <span className="text-slate-400">({fmtNum(portionScale * 100, 1)}%)</span></>}
            </div>
            <div className="mt-2 max-w-3xl text-xs leading-5 text-slate-500">
              Du trägst pro Zutat ein, wie viel wirklich da ist. Das Tool rechnet dann: <b>Mit dieser Menge kommen wir bis X Portionen.</b>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            {(["critical","warn","ok"] as const).map(s => (
              <div key={s} className={`rounded-lg px-3 py-2 ${engpassStatusColor(s)}`}>
                <div className="font-semibold">{s === "critical" ? criticalRows.length : s === "warn" ? warnRows.length : configured.filter(r => r.status === "ok").length}</div>
                <div>{s === "critical" ? "Engpass" : s === "warn" ? "Knapp" : "OK"}</div>
              </div>
            ))}
          </div>
        </div>
        {bottleneck && bottleneck.status !== "ok" && (
          <div className={`mt-3 rounded-xl px-4 py-3 ${engpassStatusColor(bottleneck.status)}`}>
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">Kritischster Engpass</div>
            <div className="font-bold mt-0.5">{bottleneck.ingredient}</div>
            <div className="text-sm mt-1">
              Verfügbar: <b>{fmtNum(bottleneck.availableDisplay ?? 0, 2)} {bottleneck.displayUom}</b>
              {" · "}Benötigt: <b>{fmtNum(bottleneck.totalNeededWithYield / bottleneck.convFactor, 2)} {bottleneck.displayUom}</b>
              {" · "}Reicht für: <b>{fmtNum(bottleneck.maxPortions ?? 0)} Portionen</b>
              {bottleneck.shortfall != null && <> · Fehlend: <b>{fmtNum(bottleneck.shortfall / bottleneck.convFactor, 2)} {bottleneck.displayUom}</b></>}
            </div>
          </div>
        )}
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={yieldEnabled} onChange={e => setYieldEnabled(e.target.checked)} />
            Yield-Verlust nach Kochprozess berücksichtigen
          </label>
        </div>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          {Object.entries(yieldLossByProcess).map(([process, pct]) => (
            <label key={process} className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-2 py-2 text-xs">
              <div className="font-semibold text-slate-700 truncate">{process}</div>
              <div className="mt-1 flex items-center gap-1">
                <input type="number" min={0} max={40} step={0.5} value={pct}
                  onChange={e => { const n = Number(e.target.value); setYieldLossByProcess(prev => ({ ...prev, [process]: Number.isFinite(n) ? Math.max(0, Math.min(40, n)) : 0 })); }}
                  className="w-16 rounded border border-slate-300 px-1.5 py-1 text-right" />
                <span className="text-slate-500">%</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-slate-700 flex-1">Zutaten — {MARKET_LABEL[market]} · {fmtNum(portionsTotal)} Portionen</div>
          <select value={engpassSort} onChange={e => setEngpassSort(e.target.value as typeof engpassSort)} className="rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1.5 text-xs">
            <option value="default">Sortierung: Standard (Sub-Rezept)</option>
            <option value="status">Sortierung: Status (kritisch zuerst)</option>
            <option value="shortfall">Sortierung: Fehlmenge ↓</option>
            <option value="name">Sortierung: Name A–Z</option>
          </select>
          <button onClick={() => setAvailableMap(prev => { const next = { ...prev }; for (const r of rows) { const key = `${r.sub}::${r.ingredientId}::${r.uom}`; next[key] = String((r.totalNeededWithYield / r.convFactor).toFixed(3)); } return next; })} className="btn text-xs">↓ Alle befüllen</button>
          <button onClick={exportToClipboard} className={`btn text-xs ${copied ? "bg-emerald-100 text-emerald-800" : ""}`}>{copied ? "✓ Kopiert!" : "📋 Export TSV"}</button>
          {configured.length > 0 && <button className="btn text-xs" onClick={() => setAvailableMap({})}>Alle zurücksetzen</button>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-slate-400 bg-white border-b border-slate-100">
              <tr>
                <th className="text-left py-2 pl-4 pr-2">Zutat · Sub-Rezept</th>
                <th className="text-right py-2 pr-2">/ Portion</th>
                <th className="text-right py-2 pr-2">Σ Bedarf</th>
                <th className="text-right py-2 pr-2">Yield</th>
                <th className="text-right py-2 pr-2">Σ inkl. Yield</th>
                <th className="py-2 pr-2" style={{ minWidth: 180 }}>Verfügbar eingeben</th>
                <th className="text-right py-2 pr-2">Max. Portionen</th>
                <th className="text-left py-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const key = `${r.sub}::${r.ingredientId}::${r.uom}`;
                const exactNeeded = parseFloat((r.totalNeededWithYield / r.convFactor).toFixed(3));
                return (
                  <tr key={i} className={`border-b border-slate-100 last:border-0 align-top hover:bg-slate-50/80 ${r.status === "critical" ? "bg-rose-50/40" : r.status === "warn" ? "bg-amber-50/30" : ""}`}>
                    <td className="py-2 pl-4 pr-2">
                      <div className="font-medium text-slate-800">{r.ingredient}</div>
                      <div className="text-[10px] text-slate-400">{r.sub} · <span className="font-mono">{r.ingredientId || "—"}</span></div>
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums text-slate-600">{fmtNum(r.perPortion / r.convFactor, 2)} {r.displayUom}</td>
                    <td className="py-2 pr-2 text-right tabular-nums font-semibold">{fmtNum(r.totalNeeded / r.convFactor, 2)} {r.displayUom}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{r.yieldLossPct > 0 ? <span className="text-rose-700 font-semibold">+{fmtNum(r.yieldLossPct, 1)}%</span> : <span className="text-slate-300">—</span>}</td>
                    <td className="py-2 pr-2 text-right tabular-nums font-semibold text-rose-700">{fmtNum(r.totalNeededWithYield / r.convFactor, 2)} {r.displayUom}</td>
                    <td className="py-2 pr-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        <input type="number" min="0" step="0.001" placeholder={`${fmtNum(r.totalNeededWithYield / r.convFactor, 3)}`}
                          value={availableMap[key] ?? ""}
                          onChange={e => setAvailableMap(prev => ({ ...prev, [key]: e.target.value }))}
                          className={`w-24 rounded-lg border px-2 py-1 text-sm tabular-nums text-right focus:outline-none focus:ring-2 ${r.status === "critical" ? "border-rose-300 focus:ring-rose-300 bg-rose-50" : r.status === "warn" ? "border-amber-300 focus:ring-amber-300 bg-amber-50" : r.status === "ok" ? "border-emerald-300 focus:ring-emerald-300 bg-emerald-50" : "border-slate-300 focus:ring-indigo-300 bg-white"}`} />
                        <span className="text-xs text-slate-500">{r.displayUom}</span>
                        <button onClick={() => setAvailableMap(prev => ({ ...prev, [key]: String(exactNeeded) }))} className="text-[10px] text-indigo-500 hover:text-indigo-700 font-medium px-1 leading-none" title={`Genau ${exactNeeded} ${r.displayUom} eintragen`}>=Bedarf</button>
                        {availableMap[key] && <button onClick={() => setAvailableMap(prev => ({ ...prev, [key]: "" }))} className="text-slate-300 hover:text-slate-500 text-xs leading-none" title="Zurücksetzen">✕</button>}
                      </div>
                      <div className="mt-1 text-[10px] leading-4 text-slate-500">
                        {engpassScenarioText(r.available, r.availableDisplay, r.displayUom, r.convFactor, r.maxPortions, r.shortfall, portionsTotal)}
                      </div>
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">
                      {r.maxPortions !== null ? <span className={`font-bold ${r.status === "critical" ? "text-rose-700" : r.status === "warn" ? "text-amber-700" : "text-emerald-700"}`}>{fmtNum(r.maxPortions)}</span> : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 pr-4">
                      <span className={`pill text-[10px] font-semibold ${engpassStatusColor(r.status)}`}>{engpassStatusLabel(r.status)}</span>
                      {r.shortfall != null && r.shortfall > 0 && <div className="text-[10px] text-rose-600 mt-0.5">Fehlend: {fmtNum(r.shortfall / r.convFactor, 2)} {r.displayUom}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── PlatingTab ────────────────────────────────────────────────────────────

function PlatingTab({ md, detailSearch }: { md: NonNullable<Recipe["markets"][Market]>; detailSearch: string }) {
  const needle = detailSearch.trim().toLowerCase();
  const allBlocks = md.subRecipes
    .filter(s => matchesNeedle([s.name, s.id, s.instructions ?? ""], needle))
    .map(s => ({ name: s.name, id: s.id, text: s.instructions ?? "" }));
  const withText = allBlocks.filter(b => b.text);
  const withoutText = allBlocks.filter(b => !b.text);
  return (
    <div className="space-y-3">
      {allBlocks.length === 0 && (
        <div className="card p-4 text-slate-500">Keine Sub-Rezepte für diese Suche gefunden.</div>
      )}
      {withText.map(b => (
        <div key={b.id} className="card p-4">
          <div className="font-semibold">{b.name}</div>
          <div className="font-mono text-[10px] text-slate-400 mb-2">{b.id}</div>
          <pre className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{b.text}</pre>
        </div>
      ))}
      {withoutText.length > 0 && (
        <div className="card p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            Sub-Rezepte ohne Plating-Anweisung ({withoutText.length})
          </div>
          <div className="space-y-1">
            {withoutText.map(b => (
              <div key={b.id} className="flex items-center gap-2 text-sm text-slate-500">
                <span className="font-mono text-[10px] text-slate-300 w-32 shrink-0">{b.id}</span>
                <span>{b.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Timeline ──────────────────────────────────────────────────────────────

function Timeline({ cs }: { cs: CookSchedule }) {
  const stepsByShift = new Map(cs.steps.map(s => [s.shiftsBefore, s.label]));
  return (
    <div className="grid grid-cols-5 gap-2">
      {[4, 3, 2, 1, 0].map(n => {
        const lbl = stepsByShift.get(n);
        return (
          <div key={n} className={`rounded-lg p-3 ring-1 ${lbl ? (n === 0 ? "bg-verden-600 text-white ring-verden-700" : "bg-slate-100 ring-slate-200") : "bg-slate-50 ring-slate-100 text-slate-300"}`}>
            <div className="text-[10px] uppercase tracking-wide opacity-80">{oneShiftShortLabel(n)} · {oneShiftLabel(n)}</div>
            <div className="text-sm font-semibold mt-1 leading-tight">{lbl ?? "—"}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── CookTab ───────────────────────────────────────────────────────────────

function CookTab({ wr, md, cookSchedules, portionsTotal, recipe, processSpecs, detailSearch }:
  { wr: WeekRecipe; md: NonNullable<Recipe["markets"][Market]>; cookSchedules: Record<string, CookSchedule>; portionsTotal: number; recipe: Recipe; processSpecs: Record<string, ProcessSpec>; detailSearch: string }) {
  const needle = detailSearch.trim().toLowerCase();
  const split = getFulfillmentSplit(wr);
  const methods = [...new Set(md.subRecipes.map(s => s.category).filter(Boolean))].filter(m => {
    const subs = md.subRecipes.filter(s => s.category === m);
    return matchesNeedle([m, ...subs.flatMap(s => [s.id, s.name, s.category, s.instructions])], needle);
  });

  return (
    <div className="space-y-3">
      <div className="card p-4 text-sm text-slate-600">
        Plan für <b>Verden (VF)</b> · gesamt <b>{fmtNum(portionsTotal)}</b> Portionen. Einschicht-Modell: 1 Shift = 1 Tag.
      </div>
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Wochenlogik ab Donnerstag</h3>
        <div className="grid md:grid-cols-4 gap-3 text-sm">
          {[
            { label: "Donnerstag", color: "bg-slate-50 ring-slate-200", text: "text-slate-500", title: "Wochenstart Produktion", desc: "Vorproduktion und chilled Prep für alles, was Freitag ins Fulfillment muss." },
            { label: "Freitag", color: "bg-verden-50 ring-verden-200", text: "text-verden-700", title: "Fulfillment-Tag 1", desc: `DK/SE komplett: ${fmtNum(split.dkseFriday)} · DE Split 1: ${fmtNum(split.deFriday)}` },
            { label: "Samstag", color: "bg-slate-50 ring-slate-200", text: "text-slate-500", title: "Zwischenlauf / Vorproduktion", desc: "Vorbereitung für den Sonntagssplit Deutschland." },
            { label: "Sonntag", color: "bg-blue-50 ring-blue-200", text: "text-blue-700", title: "Fulfillment-Tag 2", desc: `DE Split 2: ${fmtNum(split.deSunday)}${split.benl > 0 ? ` · BENL: ${fmtNum(split.benl)}` : ""}` },
          ].map(d => (
            <div key={d.label} className={`rounded-xl ${d.color} ring-1 p-3`}>
              <div className={`text-[10px] uppercase tracking-wide ${d.text}`}>{d.label}</div>
              <div className="mt-1 font-semibold">{d.title}</div>
              <div className="mt-1 text-xs text-slate-600">{d.desc}</div>
            </div>
          ))}
        </div>
      </div>
      {methods.map((m, index) => {
        const resolved = resolveCookSchedule(m, cookSchedules);
        const cs = resolved.schedule;
        const subs = md.subRecipes.filter(s => s.category === m);
        const tone = ingredientSectionTone(index);
        return (
          <div key={m} className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${tone.frame}`}>
            <div className={`px-4 py-3 ${tone.header}`}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <h4 className={`font-semibold ${tone.headerText}`}>{m}</h4>
                {cs ? <span className="pill bg-verden-100 text-verden-700">VF · {cs.cookShifts} Shift{cs.cookShifts > 1 ? "s" : ""}</span>
                     : <span className="pill bg-amber-100 text-amber-800">kein VF-Schedule definiert</span>}
              </div>
              <div className="text-xs text-slate-600">Sub-Rezepte: {subs.map(s => s.name).join(" · ")}</div>
            </div>
            <div className="p-4">
              {cs && resolved.matchType !== "exact" && resolved.matchedMethod && (
                <div className="mb-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-900 ring-1 ring-blue-200">
                  VF-Schedule gematcht über <b>{resolved.matchedMethod}</b>.
                </div>
              )}
              {cs && <Timeline cs={cs} />}
              {cs && (
                <div className="mt-3 space-y-3">
                  {subs.map(sub => {
                    const spec = processSpecs[sub.id];
                    const steps = workflowSteps(sub, spec);
                    const mass = getSubRecipeMassProfile(sub, recipe);
                    const grossKg = (portionsTotal * (mass.grossInputGramsPerPortion || mass.planningGramsPerPortion)) / 1000;
                    const outputKg = (portionsTotal * mass.outputGramsPerPortion) / 1000;
                    const batches = spec?.batchSizeKg && spec.batchSizeKg > 0 ? Math.max(1, Math.ceil(grossKg / spec.batchSizeKg)) : (grossKg > 0 ? 1 : 0);
                    const recommendPreproduction = isPreproductionRecommended(spec) && /blast chiller/i.test(sub.category);
                    return (
                      <div key={sub.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                        <div className="mb-3">
                          <div className="font-semibold text-slate-800">{sub.name}</div>
                          <div className="font-mono text-[10px] text-slate-400">{sub.id}</div>
                          <div className="mt-1 text-[11px] text-slate-500">
                            Input {grossKg ? fmtNum(grossKg, 1) : "—"} kg · Output {outputKg ? fmtNum(outputKg, 1) : "—"} kg
                            {mass.lossPercent !== undefined ? ` · Verlust ${fmtNum(mass.lossPercent, 1)}%` : ""}
                            {batches > 0 ? ` · ${fmtNum(batches)} Batch` : ""}
                          </div>
                        </div>
                        {recommendPreproduction && (
                          <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-900 ring-1 ring-amber-200">
                            Empfehlung: spätestens <b>am Vortag (D-1)</b> abschliessen.
                          </div>
                        )}
                        <div className="grid gap-2 md:grid-cols-5">
                          {[4, 3, 2, 1, 0].map(n => {
                            const scheduleLabel = cs.steps.find(step => step.shiftsBefore === n)?.label;
                            const matches = scheduleLabel ? matchedScheduleSteps(scheduleLabel, steps) : [];
                            return (
                              <div key={n} className={`rounded-lg ring-1 p-2 ${matches.length > 0 ? "bg-white ring-verden-200" : "bg-slate-100 ring-slate-200"}`}>
                                <div className="text-[10px] uppercase tracking-wide text-slate-500">{scheduleLabel ?? "—"}</div>
                                <div className="text-[10px] text-slate-400">{oneShiftLabel(n)}</div>
                                <div className="mt-1 space-y-1">
                                  {matches.length === 0 && <div className="text-[11px] text-slate-400">kein direkter Step-Match</div>}
                                  {matches.map(step => (
                                    <div key={`${step.index}-${step.rawLabel}`} className="rounded bg-white px-2 py-1 text-[11px] ring-1 ring-slate-200">
                                      <div className="font-semibold text-slate-700">#{step.index} {step.station ?? step.rawLabel}</div>
                                      <div className="text-slate-500">
                                        {step.minutesPerBatch ? `${fmtMin(step.minutesPerBatch)} / Batch` : "ohne Zeit"}
                                        {step.holdMin ? ` · Hold ${fmtMin(step.holdMin)}` : ""}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {methods.length === 0 && <div className="card p-4 text-slate-500">Keine Cook-Methoden in den Sub-Rezepten.</div>}
    </div>
  );
}

// ─── WorkflowTab ───────────────────────────────────────────────────────────

function WorkflowTab({ wr, recipe, md, processSpecs, detailSearch }:
  { wr: WeekRecipe; recipe: Recipe; md: NonNullable<Recipe["markets"][Market]>; processSpecs: Record<string, ProcessSpec>; detailSearch: string }) {
  const portions = getBaseVerdenVolume(wr);
  const needle = detailSearch.trim().toLowerCase();
  const rows = useMemo(() => md.subRecipes.map(s => {
    const spec = processSpecs[s.id];
    const steps = workflowSteps(s, spec);
    const mass = getSubRecipeMassProfile(s, recipe);
    const gpp = mass.planningGramsPerPortion;
    const totalKg = portions * gpp / 1000;
    const batchSize = spec?.batchSizeKg ?? 0;
    const batches = batchSize > 0 ? Math.max(1, Math.ceil(totalKg / batchSize)) : (totalKg > 0 ? 1 : 0);
    const outputKg = portions * mass.outputGramsPerPortion / 1000;
    return { sub: s, spec, steps, gpp, totalKg, outputKg, batchSize, batches, mass };
  }).filter(row => matchesNeedle([row.sub.id, row.sub.name, row.sub.category, row.spec?.primaryStation, row.spec?.productFamily, ...row.steps.flatMap(step => [step.station ?? undefined, step.rawLabel])], needle)), [md, processSpecs, recipe, portions, needle]);

  return (
    <div className="space-y-3">
      <div className="card p-4 text-sm text-slate-600">
        Reihenfolge aus <code>Sub-Rezept-Cook-Method</code>, Equipment-Zeiten aus PFEI (gerechnet auf <b>{fmtNum(portions)}</b> Portionen Verden gesamt).
      </div>
      {rows.map(({ sub, spec, steps, gpp, totalKg, outputKg, batchSize: _batchSize, batches, mass }) => (
        <div key={sub.id} className="card p-4">
          <div className="flex flex-wrap items-baseline gap-2 mb-2">
            <span className="font-mono text-xs text-slate-500">{sub.id}</span>
            <h4 className="font-semibold">{sub.name}</h4>
            {sub.category && <span className="pill bg-slate-100 text-slate-700">{sub.category}</span>}
            {!spec && <span className="pill bg-amber-100 text-amber-800">keine PFEI-Daten</span>}
            {spec?.primaryStation && <span className="pill bg-verden-100 text-verden-700">Constraint: {spec.primaryStation}</span>}
            {spec?.hygienic && <span className="pill bg-rose-100 text-rose-800">hygienic</span>}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2 text-xs mb-3">
            <Stat label="Input g / Portion" value={gpp ? fmtNum(gpp, 1) : "—"} />
            <Stat label="Output g / Portion" value={mass.outputGramsPerPortion ? fmtNum(mass.outputGramsPerPortion, 1) : "—"} />
            <Stat label="Input kg gesamt" value={totalKg ? fmtNum(totalKg, 1) : "—"} accent />
            <Stat label="Output kg gesamt" value={outputKg ? fmtNum(outputKg, 1) : "—"} />
            <Stat label="Verlust" value={mass.lossPercent !== undefined ? `${fmtNum(mass.lossPercent, 1)} %` : "—"} />
            <Stat label="Batches" value={batches ? fmtNum(batches) : "—"} accent />
          </div>
          {steps.length === 0 ? <div className="text-sm text-slate-500">Keine Cook-Method-Schritte hinterlegt.</div> : (
            <ol className="space-y-1.5">
              {steps.map(st => (
                <li key={st.index} className="flex items-center gap-3 rounded-lg ring-1 ring-slate-200 bg-white px-3 py-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-white text-xs font-bold tabular-nums">{st.index}</div>
                  <div className="flex-1">
                    <div className="text-sm font-semibold">
                      {st.station ?? st.rawLabel}
                      {st.station == null && <span className="ml-2 pill bg-amber-100 text-amber-800">unbekannte Station</span>}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {st.minutesPerBatch ? `${fmtMin(st.minutesPerBatch)} / Batch` : "keine Zeit hinterlegt"}
                      {st.holdMin ? ` · Hold: ${fmtMin(st.holdMin)}` : ""}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-slate-500">Σ aktiv</div>
                    <div className="text-sm font-bold tabular-nums">{fmtMin((st.minutesPerBatch ?? 0) * batches)}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── RecipeDetail (main export) ────────────────────────────────────────────

export function RecipeDetail({ wr, recipe, data, cookSchedules, processSpecs, upliftPercent }:
  { wr: WeekRecipe; recipe?: Recipe; data: DataBundle; cookSchedules: Record<string, CookSchedule>; processSpecs: Record<string, ProcessSpec>; upliftPercent: number }) {
  const [tab, setTab] = usePersistent<Tab>("detail_tab", "overview");
  const [market, setMarket] = usePersistent<Market>("detail_market", "BENL");
  const [detailSearch, setDetailSearch] = useState<string>("");

  const prevCodeRef = useRef<string>("");
  useEffect(() => {
    if (prevCodeRef.current === wr.code) return;
    prevCodeRef.current = wr.code;
    const def = MARKETS.find(m => wr.verdenVolume[m] > 0) ?? "BENL";
    const withData = (Object.keys(recipe?.markets ?? {}) as Market[]);
    const resolved = (withData.includes(def) ? def : withData[0]) ?? def;
    setMarket(resolved);
    setDetailSearch("");
  }, [wr.code, wr.hfWeek, recipe]);

  const md = recipe?.markets[market] ?? recipe?.markets[(Object.keys(recipe?.markets ?? {})[0] as Market)];
  const structure = useMemo(() => resolveStructureByCode(data.structures, wr.code, recipe?.code, recipe?.baseName ?? wr.recipeName), [data.structures, wr.code, recipe?.code, recipe?.baseName, wr.recipeName]);
  const basePortionsTotal = getBaseVerdenVolume(wr);
  const portionsTotal = adjustedPortions(basePortionsTotal, upliftPercent);

  const TABS: [Tab, string][] = [
    ["overview",    "Übersicht"],
    ["subrecipes",  `Sub-Rezepte (${md?.subRecipes.length ?? 0})`],
    ["structure",   "Rezeptstruktur"],
    ["workflow",    "Workflow & Equipment"],
    ["ingredients", "Brutto-Zutaten"],
    ["engpass",     "Engpass-Analyse"],
    ["plating",     "Plating"],
    ["cook",        "Cook-Schedule"],
  ];

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
            {md && <div className="font-mono text-[10px] text-slate-400">{md.msku}</div>}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
          {TABS.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium ring-1 transition-colors ${tab === k ? "bg-slate-900 text-white ring-slate-900" : "bg-white ring-slate-300 hover:bg-slate-50 text-slate-700"}`}>
              {l}
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

      {recipe && tab === "overview"    && <OverviewTab wr={wr} recipe={recipe} market={market} md={md} portionsTotal={portionsTotal} upliftPercent={upliftPercent} productionPlan={data.productionPlan} />}
      {recipe && tab === "subrecipes"  && md && <SubRecipesTab recipeCode={wr.code} md={md} cookSchedules={cookSchedules} detailSearch={detailSearch} />}
      {tab === "structure" && <StructureTab code={wr.code} structure={structure} market={market} week={wr.hfWeek} recipeName={recipe?.baseName ?? wr.code} wr={wr} portionsTotal={portionsTotal} upliftPercent={upliftPercent} data={data} />}
      {recipe && tab === "workflow"    && md && <WorkflowTab wr={wr} recipe={recipe} md={md} processSpecs={processSpecs} detailSearch={detailSearch} />}
      {recipe && tab === "ingredients" && <IngredientsTab recipe={recipe} market={market} portionsTotal={portionsTotal} wr={wr} shelfLifeBySku={data.shelfLifeBySku ?? {}} generatedAt={data.generatedAt} detailSearch={detailSearch} />}
      {recipe && tab === "engpass"     && <EngpassTab recipe={recipe} market={market} portionsTotal={portionsTotal} wr={wr} md={md} />}
      {recipe && tab === "plating"     && md && <PlatingTab md={md} detailSearch={detailSearch} />}
      {recipe && tab === "cook"        && md && <CookTab wr={wr} md={md} cookSchedules={cookSchedules} portionsTotal={portionsTotal} recipe={recipe} processSpecs={processSpecs} detailSearch={detailSearch} />}
    </div>
  );
}
