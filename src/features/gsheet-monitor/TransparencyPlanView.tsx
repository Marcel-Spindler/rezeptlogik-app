// Transparency Plan Live View — Produktionsanalyse über das gesamte "F_VE
// Transparency Plan"-GSheet: Wiegungen je Station, Status durch Staging ->
// Kitchen -> Post, und daraus abgeleitet, welches Meal/Submeal JETZT im
// Plaiting produzierbar ist (siehe transparencyProducibility.ts für die
// Regel). Ergänzt um WO-Status, Logistik-Readiness, Ausführung/Holding,
// Issue-Feed und einen Roh-Zugriff auf alle übrigen Tabs des Sheets.
import { useMemo, useState } from "react";
import {
  useTransparencyWeighing, useTransparencyFlow, useTransparencyPlanningCheck, useTransparencyRtem,
  useTransparencyForecast, useTransparencyWmsWo, useTransparencyEtStatus, useTransparencyInputKitchen,
  useTransparencySleeving, useTransparencyPrinting, useTransparencyBenlOutbound,
  useTransparencyPlatingExecution, useTransparencyPlatingHolding, useTransparencyKitchenKpis,
  useTransparencyIssueTracker, useTransparencyRawTab, TRANSPARENCY_RAW_FALLBACK_TABS,
} from "./useTransparencyMonitor";
import { computeTransparencyProducibility } from "./transparencyProducibility";
import type { MealProducibility, SubmealProducibilityStatus } from "./transparencyTypes";
import { fmt } from "../whatif/whatIfFormat";
import { weekNumFromHfWeek } from "../wms-overview/wmsWeeks";
import { currentHfWeek } from "../../lib/hfWeek";

// ─── Primitive Komponenten ───────────────────────────────────────────────────

function LiveDot({ ok, title }: { ok: boolean; title: string }) {
  return (
    <span title={title} className={`text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 ${ok ? "bg-emerald-400/20 text-emerald-200 ring-emerald-400/40" : "bg-white/10 text-teal-200/60 ring-white/20"}`}>
      {ok ? "● verbunden" : "○ wartet"}
    </span>
  );
}

function StatusBadge({ status }: { status: SubmealProducibilityStatus }) {
  const cfg: Record<SubmealProducibilityStatus, { label: string; cls: string }> = {
    ready: { label: "✓ PRODUZIERBAR", cls: "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200" },
    partial: { label: "◐ TEILWEISE", cls: "bg-amber-100 text-amber-700 ring-1 ring-amber-200" },
    blocked: { label: "⚠ BLOCKIERT", cls: "bg-red-100 text-red-700 ring-1 ring-red-200" },
    unknown: { label: "○ UNBEKANNT", cls: "bg-slate-100 text-slate-500 ring-1 ring-slate-200" },
  };
  const c = cfg[status];
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${c.cls}`}>{c.label}</span>;
}

function ProgressBar({ pct }: { pct: number | null }) {
  const v = pct == null ? 0 : Math.min(Math.max(pct, 0), 100);
  const color = pct == null ? "bg-slate-300" : pct >= 98 ? "bg-emerald-500" : pct >= 50 ? "bg-amber-500" : pct > 0 ? "bg-red-500" : "bg-slate-300";
  return (
    <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
      <div className={`h-2 rounded-full ${color} transition-all duration-500`} style={{ width: `${v}%` }} />
    </div>
  );
}

// ─── Hauptkomponente ─────────────────────────────────────────────────────────

type SecondaryTab = "wo-status" | "logistik" | "ausfuehrung" | "issues" | "andere-wochen" | "weitere-tabs";

export function TransparencyPlanView(): JSX.Element {
  const weighing = useTransparencyWeighing();
  const flow = useTransparencyFlow();
  const planningCheck = useTransparencyPlanningCheck();
  const rtem = useTransparencyRtem();
  const forecast = useTransparencyForecast();
  const wmsWo = useTransparencyWmsWo();
  const etStatus = useTransparencyEtStatus();
  const inputKitchen = useTransparencyInputKitchen();
  const sleeving = useTransparencySleeving();
  const printing = useTransparencyPrinting();
  const benlOutbound = useTransparencyBenlOutbound();
  const platingExecution = useTransparencyPlatingExecution();
  const platingHolding = useTransparencyPlatingHolding();
  const kitchenKpis = useTransparencyKitchenKpis();
  const issueTracker = useTransparencyIssueTracker();

  // "Planning Check" ist der einzig verlässlich wochen-scoped Tab (sein
  // eigener "W36"-Wert) -- "Transperancy Total Overview" kumuliert dagegen
  // WOs über viele Wochen/Runs. Deshalb ist Planning Checks Wochenangabe die
  // Referenz für "aktuell laufende KW"; ohne geladene Daten fällt das auf die
  // rechnerisch aktuelle HF-Woche zurück.
  const selectedWeekNum = useMemo(
    () => weekNumFromHfWeek(planningCheck.data?.week || currentHfWeek()),
    [planningCheck.data?.week]
  );

  const producibility = useMemo(
    () => computeTransparencyProducibility(flow.data, weighing.data, rtem.data, planningCheck.data, selectedWeekNum),
    [flow.data, weighing.data, rtem.data, planningCheck.data, selectedWeekNum]
  );

  const [statusFilter, setStatusFilter] = useState<"all" | SubmealProducibilityStatus>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [secondaryTab, setSecondaryTab] = useState<SecondaryTab | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const filteredMeals = useMemo(() => {
    let list = producibility.meals;
    if (statusFilter !== "all") list = list.filter((m) => m.status === statusFilter);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter((m) => m.recipeCode.toLowerCase().includes(s) || m.recipeName.toLowerCase().includes(s));
    }
    return list;
  }, [producibility.meals, statusFilter, search]);

  function toggle(code: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(code)) n.delete(code); else n.add(code);
      return n;
    });
  }

  async function handleRefreshAll() {
    setIsRefreshing(true);
    await Promise.all([
      weighing.forceRefresh(), flow.forceRefresh(), planningCheck.forceRefresh(), rtem.forceRefresh(), forecast.forceRefresh(),
    ]);
    setTimeout(() => setIsRefreshing(false), 800);
  }

  const totalWeighedPostKg = weighing.data ? [...weighing.data.postBlastKgByWorkOrder.values()].reduce((s, v) => s + v, 0) : 0;
  const openIssueCount = issueTracker.data?.rows.length ?? 0;
  const lastUpdate = flow.lastUpdate
    ? new Date(flow.lastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  return (
    <div className="space-y-4 pb-8">
      {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
      <div className="card p-6 bg-gradient-to-br from-indigo-700 to-violet-800 text-white border-0 shadow-lg">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <div className={`w-2.5 h-2.5 rounded-full ${flow.isPolling ? "bg-emerald-300 animate-pulse" : "bg-slate-400"}`} />
              <span className="text-sm font-medium text-indigo-100">{flow.isPolling ? `Live · ${lastUpdate}` : "Offline"}</span>
              <LiveDot ok={!!weighing.data} title="Importrange Weights (Wiegungen)" />
              <LiveDot ok={!!flow.data} title="Transperancy Total Overview (Stationsstatus)" />
              <LiveDot ok={!!planningCheck.data} title="Planning Check (Meal-Plan)" />
              <LiveDot ok={!!rtem.data} title="RTEM (RTI-Bestand)" />
              {producibility.otherWeekMeals.length > 0 && (
                <button
                  onClick={() => setSecondaryTab("andere-wochen")}
                  title="Rezepte, die nur über Work Orders anderer Wochen in Transperancy Total Overview auftauchen, aber nicht im Planning-Check-Tab dieser KW stehen — hier ausgeblendet, separat einsehbar"
                  className="text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 bg-amber-400/20 text-amber-100 ring-amber-400/40 hover:bg-amber-400/30 transition"
                >
                  ⚠ {producibility.otherWeekMeals.length} Meal{producibility.otherWeekMeals.length === 1 ? "" : "s"} andere KW ausgeblendet
                </button>
              )}
            </div>
            <h1 className="text-3xl font-bold">Transparency Plan Live</h1>
            <p className="mt-1 text-sm text-indigo-100/80">
              KW{selectedWeekNum ?? "—"} ({planningCheck.data?.week || "—"}) · {producibility.meals.length} Meals · Wiegungen &amp; Stationen bis Plaiting-Produzierbarkeit
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleRefreshAll()}
              disabled={isRefreshing}
              className="px-3 py-1.5 rounded-full text-xs bg-white/20 hover:bg-white/30 text-white ring-1 ring-white/30 transition disabled:opacity-50 font-medium"
            >
              {isRefreshing ? "⟳ Lädt…" : "⟳ Refresh"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 md:grid-cols-6 gap-2">
          {([
            { label: "Produzierbar", value: producibility.readyCount, color: "text-emerald-300", bg: "bg-emerald-500/20", onClick: () => setStatusFilter("ready") },
            { label: "Teilweise", value: producibility.partialCount, color: "text-amber-300", bg: "bg-amber-500/20", onClick: () => setStatusFilter("partial") },
            { label: "Blockiert", value: producibility.blockedCount, color: "text-red-300", bg: "bg-red-500/20", onClick: () => setStatusFilter("blocked") },
            { label: "Meals gesamt", value: producibility.meals.length, color: "text-white", bg: "bg-white/15", onClick: () => setStatusFilter("all") },
            { label: "kg Post-Blast", value: fmt(totalWeighedPostKg, 0), color: "text-sky-300", bg: "bg-sky-500/20", onClick: undefined as (() => void) | undefined },
            { label: "Offene Issues", value: openIssueCount, color: "text-orange-300", bg: "bg-orange-500/20", onClick: () => setSecondaryTab("issues") },
          ]).map((s) => (
            <button
              key={s.label}
              onClick={s.onClick}
              disabled={!s.onClick}
              className={`${s.bg} rounded-xl p-2.5 text-center ${s.onClick ? "hover:bg-white/25 transition cursor-pointer" : "cursor-default"}`}
            >
              <div className="text-[10px] text-white/60 uppercase font-bold tracking-wide">{s.label}</div>
              <div className={`text-xl font-bold font-mono ${s.color}`}>{s.value}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ══ HAUPTTABELLE: PRODUZIERBARKEIT ═════════════════════════════════ */}
      <div className="card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h2 className="font-bold text-slate-700 text-sm">Meals nach Plaiting-Produzierbarkeit</h2>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Recipe Code oder Name suchen…"
            className="ml-auto text-xs px-3 py-1.5 rounded-full bg-slate-100 ring-1 ring-slate-200 focus:outline-none focus:ring-indigo-300 w-56"
          />
          <div className="flex gap-1">
            {(["all", "ready", "partial", "blocked", "unknown"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`px-2.5 py-1 text-xs rounded-full font-medium transition ${statusFilter === f ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              >
                {f === "all" ? "Alle" : f === "ready" ? "Produzierbar" : f === "partial" ? "Teilweise" : f === "blocked" ? "Blockiert" : "Unbekannt"}
              </button>
            ))}
          </div>
        </div>

        {filteredMeals.length === 0 ? (
          <div className="text-center text-sm text-slate-400 py-8">Keine Meals für diesen Filter — warte auf erste Daten oder Filter zurücksetzen.</div>
        ) : (
          <div className="space-y-1.5">
            {filteredMeals.map((m) => (
              <MealRow key={m.recipeCode} meal={m} expanded={expanded.has(m.recipeCode)} onToggle={() => toggle(m.recipeCode)} />
            ))}
          </div>
        )}
      </div>

      {/* ══ SEKUNDÄR-PANELS ═════════════════════════════════════════════════ */}
      <div className="card p-4 shadow-sm">
        <div className="flex gap-1 mb-3 flex-wrap">
          {([
            ["wo-status", "WO-/Stations-Status"],
            ["logistik", "Logistik"],
            ["ausfuehrung", "Ausführung/Holding"],
            ["issues", "Issue Tracker"],
            ["andere-wochen", `Andere Wochen${producibility.otherWeekMeals.length ? ` (${producibility.otherWeekMeals.length})` : ""}`],
            ["weitere-tabs", "Weitere Tabs"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSecondaryTab((prev) => (prev === key ? null : key))}
              className={`px-3 py-1.5 text-xs rounded-full font-medium transition ${secondaryTab === key ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {secondaryTab === "wo-status" && <WoStatusPanel wmsWo={wmsWo.data} etStatus={etStatus.data} inputKitchen={inputKitchen.data} kitchenKpis={kitchenKpis.data} />}
        {secondaryTab === "logistik" && <LogistikPanel sleeving={sleeving.data} printing={printing.data} benlOutbound={benlOutbound.data} />}
        {secondaryTab === "ausfuehrung" && <AusfuehrungPanel platingExecution={platingExecution.data} platingHolding={platingHolding.data} />}
        {secondaryTab === "issues" && <IssuesPanel data={issueTracker.data} />}
        {secondaryTab === "andere-wochen" && <AndereWochenPanel meals={producibility.otherWeekMeals} weekNum={selectedWeekNum} />}
        {secondaryTab === "weitere-tabs" && <WeitereTabsPanel />}
        {secondaryTab === null && <div className="text-xs text-slate-400 text-center py-4">Panel auswählen, um Details zu sehen.</div>}
      </div>
    </div>
  );
}

// ─── Meal-Zeile mit Subrezept-Drilldown ──────────────────────────────────────

function MealRow({ meal, expanded, onToggle }: { meal: MealProducibility; expanded: boolean; onToggle: () => void }) {
  const doneCount = meal.subRecipes.filter((s) => s.weighedComplete).length;
  return (
    <div className="rounded-lg ring-1 ring-slate-200 overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-50 transition text-left">
        <span className="text-slate-400 text-xs w-3">{expanded ? "▼" : "▶"}</span>
        <span className="font-mono text-xs text-slate-500 w-20 shrink-0">{meal.recipeCode}</span>
        <span className="text-sm font-medium text-slate-800 flex-1 truncate">{meal.recipeName}</span>
        <span className="text-[10px] text-slate-400">{doneCount}/{meal.subRecipes.length} Subrezepte fertig</span>
        <StatusBadge status={meal.status} />
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 bg-slate-50">
          {meal.subRecipes.length === 0 ? (
            <div className="text-xs text-slate-400 py-2">{meal.blockedReasons[0] ?? "Keine Subrezept-Daten"}</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-slate-400 uppercase">
                  <th className="text-left font-bold py-1">Subrezept</th>
                  <th className="text-left font-bold py-1">Work Orders</th>
                  <th className="text-right font-bold py-1">Geplant kg</th>
                  <th className="text-right font-bold py-1">Gewogen kg</th>
                  <th className="text-left font-bold py-1 w-28">Fortschritt</th>
                  <th className="text-right font-bold py-1">RTI übrig</th>
                </tr>
              </thead>
              <tbody>
                {meal.subRecipes.map((s) => (
                  <tr key={s.subRecipeName} className="border-t border-slate-200">
                    <td className="py-1.5 pr-2">{s.subRecipeName}</td>
                    <td className="py-1.5 pr-2 font-mono text-[10px] text-slate-500">{s.workOrders.join(", ")}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmt(s.plannedPostKg, 1)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmt(s.weighedPostKg, 1)}</td>
                    <td className="py-1.5 pr-2">
                      <div className="flex items-center gap-1.5">
                        <ProgressBar pct={s.pct} />
                        <span className="font-mono text-[10px] w-9 text-right">{s.pct != null ? `${s.pct.toFixed(0)}%` : "—"}</span>
                      </div>
                    </td>
                    <td className="py-1.5 text-right font-mono">{s.actualRtiLeft ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sekundär-Panels ─────────────────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">{title}</h3>
      {children}
    </div>
  );
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: (string | number | null)[][] }) {
  if (rows.length === 0) return <div className="text-xs text-slate-400 py-3">Keine Daten.</div>;
  return (
    <div className="overflow-x-auto max-h-80 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-white">
          <tr className="text-[10px] text-slate-400 uppercase">
            {headers.map((h) => <th key={h} className="text-left font-bold py-1 pr-3">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((row, i) => (
            <tr key={i} className="border-t border-slate-100">
              {row.map((c, j) => <td key={j} className="py-1 pr-3 whitespace-nowrap">{c ?? "—"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 200 && <div className="text-[10px] text-slate-400 mt-1">… {rows.length - 200} weitere Zeilen ausgeblendet</div>}
    </div>
  );
}

function WoStatusPanel({ wmsWo, etStatus, inputKitchen, kitchenKpis }: {
  wmsWo: ReturnType<typeof useTransparencyWmsWo>["data"];
  etStatus: ReturnType<typeof useTransparencyEtStatus>["data"];
  inputKitchen: ReturnType<typeof useTransparencyInputKitchen>["data"];
  kitchenKpis: ReturnType<typeof useTransparencyKitchenKpis>["data"];
}) {
  return (
    <div className="space-y-4">
      {kitchenKpis && kitchenKpis.dates.length > 0 && (
        <Panel title="Kitchen KPIs">
          <SimpleTable
            headers={["Kennzahl", ...kitchenKpis.dates]}
            rows={kitchenKpis.series.map((s) => [s.label, ...kitchenKpis.dates.map((d) => s.valuesByDate[d])])}
          />
        </Panel>
      )}
      <Panel title={`WMS WO (${wmsWo?.rows.length ?? 0})`}>
        <SimpleTable headers={["WO", "Status", "Subrezept", "Staging Day", "Ziel"]} rows={(wmsWo?.rows ?? []).map((r) => [r.workOrder, r.status, r.subRecipeName, r.stagingDay, r.targetQty])} />
      </Panel>
      <Panel title={`ET (${etStatus?.rows.length ?? 0})`}>
        <SimpleTable headers={["Cooking Day", "WO", "Recipe", "Subrezept", "Staging", "Kitchen"]} rows={(etStatus?.rows ?? []).map((r) => [r.cookingDay, r.workOrder, r.recipeName, r.subRecipeName, r.stagingStatus, r.kitchenStatus])} />
      </Panel>
      <Panel title={`Input Kitchen (${inputKitchen?.rows.length ?? 0})`}>
        <SimpleTable headers={["Prio", "WO", "Recipe", "Subrezept", "Debox Day", "Staging", "Kitchen"]} rows={(inputKitchen?.rows ?? []).map((r) => [r.priority, r.workOrder, r.recipeName, r.subRecipeName, r.deboxDay, r.stagingStatus, r.kitchenStatus])} />
      </Panel>
    </div>
  );
}

function LogistikPanel({ sleeving, printing, benlOutbound }: {
  sleeving: ReturnType<typeof useTransparencySleeving>["data"];
  printing: ReturnType<typeof useTransparencyPrinting>["data"];
  benlOutbound: ReturnType<typeof useTransparencyBenlOutbound>["data"];
}) {
  return (
    <div className="space-y-4">
      <Panel title={`BENL Outbound (${benlOutbound?.rows.length ?? 0})`}>
        <SimpleTable
          headers={["Recipe", "Total", "Do Outbound", "Fr Outbound", "Sa Outbound"]}
          rows={(benlOutbound?.rows ?? []).map((r) => [`${r.recipeCode} ${r.recipeName}`, r.total, r.byDay.thu.outbound, r.byDay.fri.outbound, r.byDay.sat.outbound])}
        />
      </Panel>
      <Panel title={`Sleeving Output (${sleeving?.output.length ?? 0})`}>
        <SimpleTable headers={["Tag", "Recipe", "Von", "Zu", "Kisten", "Meals"]} rows={(sleeving?.output ?? []).map((r) => [r.day, `${r.recipeCode} ${r.recipeName}`, r.from, r.to, r.boxCount, r.meals])} />
      </Panel>
      <Panel title={`Printing Requirements (${printing?.requirements.length ?? 0})`}>
        <SimpleTable headers={["Meal", "Region", "Menge", "Fertig"]} rows={(printing?.requirements ?? []).map((r) => [`${r.mealCode} ${r.mealName}`, r.region, r.quantity, r.done ? "✓" : "—"])} />
      </Panel>
    </div>
  );
}

function AusfuehrungPanel({ platingExecution, platingHolding }: {
  platingExecution: ReturnType<typeof useTransparencyPlatingExecution>["data"];
  platingHolding: ReturnType<typeof useTransparencyPlatingHolding>["data"];
}) {
  return (
    <div className="space-y-4">
      <Panel title={`Plating Execution (${platingExecution?.rows.length ?? 0})`}>
        <SimpleTable
          headers={["WO", "Recipe", "Mapped", "Ziel", "Status"]}
          rows={(platingExecution?.rows ?? []).map((r) => [r.workOrder, r.recipeName, r.recipeWoMapped, r.recipeWoTarget, r.platingStatus])}
        />
      </Panel>
      <Panel title={`Counting Plating Holding (${platingHolding?.rows.length ?? 0})`}>
        <SimpleTable headers={["WO", "Subrezept", "Menge"]} rows={(platingHolding?.rows ?? []).map((r) => [r.workOrder, r.subRecipeName, r.quantity])} />
      </Panel>
    </div>
  );
}

function IssuesPanel({ data }: { data: ReturnType<typeof useTransparencyIssueTracker>["data"] }) {
  return (
    <Panel title={`Issue Tracker (${data?.rows.length ?? 0})`}>
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {(data?.rows ?? []).map((r, i) => (
          <div key={i} className="rounded-lg ring-1 ring-slate-200 p-2.5 text-xs">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-[10px] text-slate-400">{r.date}</span>
              <span className="font-bold text-slate-700">{r.issue}</span>
              {r.departments && <span className="ml-auto text-[10px] text-slate-400">{r.departments}</span>}
            </div>
            {r.description && <div className="text-slate-500 whitespace-pre-line">{r.description}</div>}
          </div>
        ))}
        {(data?.rows.length ?? 0) === 0 && <div className="text-xs text-slate-400 py-3">Keine Einträge.</div>}
      </div>
    </Panel>
  );
}

// Rezepte aus "Transperancy Total Overview", die NICHT im Planning-Check-Tab
// der aktuellen KW stehen (siehe transparencyProducibility.ts) — bewusst
// separat statt in der Haupt-Meal-Liste, damit die nicht mit veralteten
// Andere-Wochen-Resten verwässert wird.
function AndereWochenPanel({ meals, weekNum }: { meals: MealProducibility[]; weekNum: number | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  function toggle(code: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(code)) n.delete(code); else n.add(code);
      return n;
    });
  }

  return (
    <Panel title={`Nicht in KW${weekNum ?? "?"} (${meals.length})`}>
      <p className="text-[10px] text-slate-400 mb-2">
        Diese Rezepte stehen nicht im "Planning Check"-Tab der aktuellen Woche, tauchen aber über Work Orders anderer Wochen/Runs in "Transperancy Total Overview" auf — z.B. Nachzügler aus der Vorwoche oder Vorlauf für eine kommende KW.
      </p>
      {meals.length === 0 ? (
        <div className="text-xs text-slate-400 py-3">Keine — alle Rezepte in Total Overview passen zur aktuellen KW.</div>
      ) : (
        <div className="space-y-1.5">
          {meals.map((m) => (
            <MealRow key={m.recipeCode} meal={m} expanded={expanded.has(m.recipeCode)} onToggle={() => toggle(m.recipeCode)} />
          ))}
        </div>
      )}
    </Panel>
  );
}

// Für alle Registry-Tabs ohne dedizierten Parser: Roh-Tabelle bei Bedarf
// nachladen (eigener Hook-Aufruf je ausgewähltem Tab, nicht alle gleichzeitig
// pollen — spart unnötige Requests für Tabs, die kaum jemand ansieht).
function WeitereTabsPanel() {
  const [selected, setSelected] = useState<string | null>(null);
  const raw = useTransparencyRawTab(selected ?? TRANSPARENCY_RAW_FALLBACK_TABS[0].key);

  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-3">
        {TRANSPARENCY_RAW_FALLBACK_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setSelected(t.key)}
            className={`px-2.5 py-1 text-[10px] rounded-full font-medium transition ${selected === t.key ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {!selected ? (
        <div className="text-xs text-slate-400 py-3">Tab auswählen, um Rohdaten zu laden — diese Tabs sind kaputt/leer/reine Referenz-Tabs und haben keinen dedizierten Parser, bleiben aber über die Rohansicht zugänglich.</div>
      ) : raw.data ? (
        <SimpleTable headers={raw.data.rows[0]?.map((_, i) => `Spalte ${i + 1}`) ?? []} rows={raw.data.rows.slice(1)} />
      ) : (
        <div className="text-xs text-slate-400 py-3">Lädt…</div>
      )}
    </div>
  );
}
