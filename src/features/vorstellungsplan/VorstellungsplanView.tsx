// Vorstellungsplan – schreibgeschützter 1:1-Spiegel von Marcels "F_VE
// Production Plan"-GSheet (Wochen-Tab "W{XX} - Plating Plan [WIP]") +
// App-weite KPIs. Standardansicht der Linienplanung seit 2026-08 (siehe
// LinePlanningView.tsx viewTab) — gedacht, um den Plan der kommenden Woche
// live vor Publikum vorzustellen, deshalb: kein Editieren, nur Anzeige +
// Copy-as-Email.
import { useRef, useState, type FormEvent } from "react";
import { useProductionPlanGid, useProductionPlanMonitor } from "../gsheet-monitor/useGSheetMonitor";
import { PRODUCTION_PLAN_DAYS, type ProductionPlanData, type ProductionPlanDay, type ProductionPlanRow } from "../gsheet-monitor/gsheetTypes";
import { useBackfillsKpi, useRedzoneKpi, useWmsKpi } from "./vorstellungsplanKpis";
import { buildVorstellungsplanMailHtml } from "./vorstellungsplanMail";

const DAY_SHORT: Record<ProductionPlanDay, string> = {
  Sunday: "So", Monday: "Mo", Tuesday: "Di", Wednesday: "Mi", Thursday: "Do", Friday: "Fr", Saturday: "Sa",
};

function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return new Intl.NumberFormat("de-DE").format(Math.round(n));
}

// ─── GID-Updater (gleiches Muster wie LinePlaitingGidUpdater in BackfillsView.tsx) ──

function ProductionPlanGidUpdater({
  gid, setGid, connected, lastUpdate, forceRefresh,
}: {
  gid: string;
  setGid: (input: string) => boolean;
  connected: boolean;
  lastUpdate: number | null;
  forceRefresh: () => Promise<void>;
}) {
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = setGid(input);
    setStatus(ok ? "ok" : "error");
    if (ok) { setInput(""); inputRef.current?.blur(); }
    setTimeout(() => setStatus("idle"), 3000);
  }

  const lastUpdateLabel = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <div className="card p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-bold text-slate-500 uppercase tracking-wide text-[10px] shrink-0">Production Plan</span>
        <span className="text-[11px] font-mono text-slate-400">
          gid={gid}{connected ? ` · ${lastUpdateLabel}` : " · wartet"}
        </span>
        <button
          type="button"
          onClick={() => void forceRefresh()}
          className="text-[11px] px-2 py-0.5 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50"
        >
          🔄 aktualisieren
        </button>
        <form onSubmit={handleSubmit} className="flex items-center gap-2 ml-auto">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Neuer Wochen-Tab: Link oder gid…"
            className="text-xs px-3 py-1 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400 w-64"
          />
          <button type="submit" disabled={!input.trim()} className="px-2.5 py-1 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40 transition font-medium shrink-0">
            Übernehmen
          </button>
        </form>
      </div>
      {status === "ok" && <p className="text-[10px] text-emerald-600 mt-1.5">✓ Neuer Tab übernommen.</p>}
      {status === "error" && <p className="text-[10px] text-red-600 mt-1.5">Konnte keine gid lesen — bitte den kompletten Link oder nur die Zahl einfügen.</p>}
    </div>
  );
}

// ─── KPI-Kacheln ──────────────────────────────────────────────────────────────

function KpiTile({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "red" | "emerald" | "indigo" }) {
  const toneClass = { slate: "text-slate-800", red: "text-red-600", emerald: "text-emerald-600", indigo: "text-indigo-600" }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm min-w-[7rem]">
      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-black tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

// ─── Tages-Matrix ───────────────────────────────────────────────────────────

function DayCell({ cell }: { cell: ProductionPlanRow["byDay"][ProductionPlanDay] }) {
  if (cell.kind === "empty") return <td className="px-2 py-1 text-slate-300 text-center">·</td>;
  if (cell.kind === "station") return <td className="px-2 py-1 text-center text-[11px] font-semibold text-sky-700 bg-sky-50">{cell.label}</td>;
  return <td className="px-2 py-1 text-right font-semibold text-slate-800 tabular-nums">{fmtInt(cell.portions)}</td>;
}

function PlanTable({ data }: { data: ProductionPlanData }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-[11px] border-collapse">
        <thead className="bg-slate-800 text-white sticky top-0">
          <tr>
            <th className="px-2 py-1.5 text-left font-bold whitespace-nowrap">Code</th>
            <th className="px-2 py-1.5 text-left font-bold">Meal</th>
            <th className="px-2 py-1.5 text-right font-bold whitespace-nowrap">Total+Buffer</th>
            {PRODUCTION_PLAN_DAYS.map(d => <th key={d} className="px-2 py-1.5 font-bold">{DAY_SHORT[d]}</th>)}
            <th className="px-2 py-1.5 text-left font-bold">Allergene</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={row.code} className={i % 2 === 0 ? "bg-white" : "bg-slate-50/50"}>
              <td className="px-2 py-1 font-mono text-slate-600 whitespace-nowrap">{row.code}</td>
              <td className="px-2 py-1 font-semibold text-slate-800 max-w-[16rem] truncate" title={row.recipeName}>{row.recipeName}</td>
              <td className="px-2 py-1 text-right font-bold text-slate-800 tabular-nums">{fmtInt(row.totalWithBuffer)}</td>
              {PRODUCTION_PLAN_DAYS.map(d => <DayCell key={d} cell={row.byDay[d]} />)}
              <td className="px-2 py-1 text-slate-500 max-w-[10rem] truncate" title={row.allergens}>{row.allergens || "–"}</td>
            </tr>
          ))}
        </tbody>
        {data.totals && (
          <tfoot>
            <tr className="bg-indigo-50 border-t-2 border-indigo-200 font-black text-indigo-900">
              <td className="px-2 py-1.5" colSpan={2}>Wochensumme</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(data.totals.totalWithBuffer)}</td>
              <td className="px-2 py-1.5" colSpan={PRODUCTION_PLAN_DAYS.length + 1} />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

// ─── Sheet-eigener KPI- + Utilization-Block ────────────────────────────────

function SheetKpiBlock({ data }: { data: ProductionPlanData }) {
  if (data.kpiRows.length === 0 && data.utilization.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-[11px] border-collapse">
        <thead className="bg-slate-100">
          <tr>
            <th className="px-2 py-1.5 text-left font-bold text-slate-600">Kennzahl</th>
            {PRODUCTION_PLAN_DAYS.map(d => <th key={d} className="px-2 py-1.5 font-bold text-slate-600">{DAY_SHORT[d]}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.kpiRows.map(k => (
            <tr key={k.label} className="border-t border-slate-100">
              <td className="px-2 py-1 font-semibold text-slate-700 capitalize">{k.label}</td>
              {PRODUCTION_PLAN_DAYS.map(d => <td key={d} className="px-2 py-1 text-right tabular-nums text-slate-600">{fmtInt(k.byDay[d])}</td>)}
            </tr>
          ))}
          {data.utilization.length > 0 && (
            <tr className="border-t-2 border-slate-200 bg-slate-50">
              <td className="px-2 py-1 font-black text-slate-500 uppercase text-[10px]" colSpan={PRODUCTION_PLAN_DAYS.length + 1}>Auslastung je Station</td>
            </tr>
          )}
          {data.utilization.map(u => (
            <tr key={u.station} className="border-t border-slate-100">
              <td className="px-2 py-1 font-semibold text-slate-700">{u.station}</td>
              {PRODUCTION_PLAN_DAYS.map(d => <td key={d} className="px-2 py-1 text-right tabular-nums text-slate-600">{fmtInt(u.byDay[d] ?? null)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Haupt-Ansicht ──────────────────────────────────────────────────────────

export function VorstellungsplanView({ week }: { week: string }) {
  const [gid, setGid] = useProductionPlanGid();
  const { data, lastUpdate, error, forceRefresh } = useProductionPlanMonitor(gid);
  const backfillsKpi = useBackfillsKpi();
  const redzoneKpi = useRedzoneKpi();
  const wmsKpi = useWmsKpi(week);
  const [copyStatus, setCopyStatus] = useState<"idle" | "ok">("idle");
  const mailContainerRef = useRef<HTMLDivElement>(null);

  function handleCopyMail() {
    if (!data || !mailContainerRef.current) return;
    const html = buildVorstellungsplanMailHtml(data, week, { backfills: backfillsKpi, redzone: redzoneKpi, wms: wmsKpi });
    mailContainerRef.current.innerHTML = html;
    const range = document.createRange();
    range.selectNode(mailContainerRef.current);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand("copy");
    sel?.removeAllRanges();
    setCopyStatus("ok");
    setTimeout(() => setCopyStatus("idle"), 3000);
  }

  return (
    <div className="space-y-3">
      <ProductionPlanGidUpdater gid={gid} setGid={setGid} connected={!!data} lastUpdate={lastUpdate} forceRefresh={forceRefresh} />

      <div className="flex flex-wrap gap-2">
        <KpiTile label="WMS · WO-Portionen" value={wmsKpi.status === "loading" ? "…" : fmtInt(wmsKpi.totalWoPortions)} tone="indigo" />
        <KpiTile label="WMS · Meals" value={wmsKpi.status === "loading" ? "…" : fmtInt(wmsKpi.uniqueMeals)} />
        <KpiTile
          label="Backfills kritisch"
          value={backfillsKpi ? fmtInt(backfillsKpi.criticalCount) : "–"}
          tone={backfillsKpi && backfillsKpi.criticalCount > 0 ? "red" : "emerald"}
        />
        <KpiTile label="Backfill-Empfehlung" value={backfillsKpi ? fmtInt(backfillsKpi.totalRecommendedPortions) : "–"} />
        <KpiTile label="Redzone · aktive Linien" value={redzoneKpi ? fmtInt(redzoneKpi.activeLineCount) : "–"} tone="indigo" />
        <KpiTile label="Redzone · geplatet" value={redzoneKpi ? fmtInt(redzoneKpi.totalPlated) : "–"} />
      </div>

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {error} — gid oben prüfen oder „aktualisieren" klicken.
        </div>
      )}

      {!data && !error && (
        <div className="card p-6 text-center text-slate-400 text-sm">Lädt Production Plan …</div>
      )}

      {data && (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-slate-800">Vorstellungsplan {data.week || week}</h3>
            <button
              onClick={handleCopyMail}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
            >
              📋 Als Email kopieren
            </button>
          </div>
          {copyStatus === "ok" && <p className="text-[11px] text-emerald-600">✓ In Zwischenablage kopiert — direkt in Outlook/Gmail einfügen.</p>}
          <PlanTable data={data} />
          <SheetKpiBlock data={data} />
        </>
      )}

      {/* Off-Screen-Container für den Rich-HTML-Copy (execCommand("copy") braucht ein
          gerendertes, nicht display:none-Element, um den Range/Selection-Trick zu erlauben). */}
      <div ref={mailContainerRef} style={{ position: "fixed", top: -99999, left: -99999, width: 1, height: 1, overflow: "hidden" }} aria-hidden />
    </div>
  );
}
