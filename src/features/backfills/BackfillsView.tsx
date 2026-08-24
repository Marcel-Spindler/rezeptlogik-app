// Backfills – Neue Ansicht: Summary-Dashboard + kompakte Cards + KW-Auswahl.
import { useRef, useState, type FormEvent } from "react";
import { useBackfills } from "./BackfillsContext";
import { useRedzoneOptional } from "../redzone-live/RedzoneContext";
import type { BackfillAlert, CombinedBackfillNeed } from "./backfillTypes";
import { fmt } from "../whatif/whatIfFormat";

// ─── Kleine Hilfs-Komponenten ────────────────────────────────────────────────

function ConnDot({ label, connected }: { label: string; connected: boolean }) {
  return (
    <span
      title={`${label}: ${connected ? "verbunden" : "wartet"}`}
      className={`inline-flex items-center gap-1 text-[10px] font-medium ${connected ? "text-emerald-300" : "text-white/40"}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-white/30"}`} />
      {label}
    </span>
  );
}

function PriorityStripe({ priority }: { priority: CombinedBackfillNeed["priority"] }) {
  const cls =
    priority === "critical" ? "bg-red-500" :
    priority === "behind" ? "bg-amber-400" :
    "bg-emerald-400";
  return <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-xl ${cls}`} />;
}

function ConfidenceChip({ confidence }: { confidence: CombinedBackfillNeed["confidence"] }) {
  if (confidence === "confirmed")
    return <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-violet-100 text-violet-700">BEIDE</span>;
  if (confidence === "kitchen-only")
    return <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-sky-100 text-sky-700">KÜCHE</span>;
  return <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-orange-100 text-orange-700">PLATING</span>;
}

function AlertRow({ alert }: { alert: BackfillAlert }) {
  const dot = alert.severity === "critical" ? "text-red-500" : alert.severity === "warning" ? "text-amber-500" : "text-sky-400";
  return (
    <div className="flex items-start gap-2 py-2 border-b border-slate-100 last:border-0">
      <span className={`text-sm leading-none mt-0.5 ${dot}`}>●</span>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-slate-800">{alert.title}</div>
        <div className="text-[11px] text-slate-500 mt-0.5">{alert.message}</div>
      </div>
    </div>
  );
}

// ─── LinePlaiting GID-Updater ────────────────────────────────────────────────

function LinePlaitingGidUpdater() {
  const { linePlaitingGid, setLinePlaitingGid, linePlaitingConnected, linePlaitingLastUpdate, linePlaitingForceRefresh } = useBackfills();
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = setLinePlaitingGid(input);
    setStatus(ok ? "ok" : "error");
    if (ok) { setInput(""); inputRef.current?.blur(); }
    setTimeout(() => setStatus("idle"), 3000);
  }

  const lastUpdate = linePlaitingLastUpdate
    ? new Date(linePlaitingLastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : "—";

  const isStale = linePlaitingLastUpdate != null && Date.now() - linePlaitingLastUpdate > 2 * 60 * 60 * 1000;

  return (
    <div className="card p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-bold text-slate-500 uppercase tracking-wide text-[10px] shrink-0">LinePlaiting</span>
        <span className={`text-[11px] font-mono ${isStale ? "text-amber-600" : "text-slate-400"}`}>
          gid={linePlaitingGid}{linePlaitingConnected ? ` · ${lastUpdate}` : " · wartet"}
          {isStale && " · ⚠ >2h alt"}
        </span>
        <form onSubmit={handleSubmit} className="flex items-center gap-2 ml-auto">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Neuer Tab: Link oder gid…"
            className="text-xs px-3 py-1 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-teal-400 w-56"
          />
          <button type="submit" disabled={!input.trim()} className="px-2.5 py-1 rounded-lg text-xs bg-teal-600 hover:bg-teal-700 text-white disabled:opacity-40 transition font-medium shrink-0">
            OK
          </button>
          <button type="button" onClick={() => void linePlaitingForceRefresh()} className="px-2 py-1 rounded-lg text-xs bg-slate-100 hover:bg-slate-200 text-slate-600 transition shrink-0">
            ⟳
          </button>
        </form>
      </div>
      {status === "ok" && <p className="text-[10px] text-emerald-600 mt-1.5">✓ Neuer Tab übernommen.</p>}
      {status === "error" && <p className="text-[10px] text-red-600 mt-1.5">Konnte keine gid lesen — bitte den kompletten Link oder nur die Zahl einfügen.</p>}
    </div>
  );
}

// ─── Summary Dashboard ───────────────────────────────────────────────────────

function SummaryDashboard({ combined, criticalCount, totalPortions }: { combined: CombinedBackfillNeed[]; criticalCount: number; totalPortions: number }) {
  const behindCount = combined.filter(c => c.priority === "behind").length;
  const withResult = combined.filter(c => c.backfillResultPortions != null).length;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div className="rounded-xl bg-slate-900 p-4 text-center">
        <div className="text-[10px] uppercase font-bold text-slate-400 tracking-wide">Nachproduktion</div>
        <div className="text-2xl font-bold font-mono text-white mt-1">{fmt(totalPortions)}</div>
        <div className="text-[10px] text-slate-500">Portionen gesamt</div>
      </div>
      <div className="rounded-xl bg-red-50 p-4 text-center ring-1 ring-red-200">
        <div className="text-[10px] uppercase font-bold text-red-500 tracking-wide">Kritisch</div>
        <div className="text-2xl font-bold font-mono text-red-700 mt-1">{criticalCount}</div>
        <div className="text-[10px] text-red-400">Meals</div>
      </div>
      <div className="rounded-xl bg-amber-50 p-4 text-center ring-1 ring-amber-200">
        <div className="text-[10px] uppercase font-bold text-amber-500 tracking-wide">Hinter Plan</div>
        <div className="text-2xl font-bold font-mono text-amber-700 mt-1">{behindCount}</div>
        <div className="text-[10px] text-amber-400">Meals</div>
      </div>
      <div className="rounded-xl bg-emerald-50 p-4 text-center ring-1 ring-emerald-200">
        <div className="text-[10px] uppercase font-bold text-emerald-500 tracking-wide">Sa. Ergebnis</div>
        <div className="text-2xl font-bold font-mono text-emerald-700 mt-1">{withResult}/{combined.length}</div>
        <div className="text-[10px] text-emerald-400">Meals mit Ergebnis</div>
      </div>
    </div>
  );
}

// ─── Backfill Card (kompakt) ─────────────────────────────────────────────────

const SOURCE_LABEL: Record<CombinedBackfillNeed["recommendedSource"], string> = {
  "min-needs": "Fr. Min Needs",
  plating: "Plating-Fehlmenge",
  kitchen: "Küchen-Gewichte",
  none: "—",
};

function BackfillCard({ c }: { c: CombinedBackfillNeed }) {
  const resolved = c.recommendedBackfillPortions === 0;
  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-3 pl-4 shadow-sm hover:shadow-md transition-shadow">
      <PriorityStripe priority={c.priority} />

      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-xs font-bold text-slate-900 font-mono">{c.recipeCode}</span>
          <span className="text-xs text-slate-500 truncate">{c.recipeName}</span>
        </div>
        <ConfidenceChip confidence={c.confidence} />
      </div>

      {/* Hauptzahl */}
      <div className={`rounded-lg px-3 py-2 flex items-center justify-between ${resolved ? "bg-emerald-50" : "bg-slate-900"}`}>
        <div>
          <div className={`text-[10px] uppercase font-bold tracking-wide ${resolved ? "text-emerald-600" : "text-slate-400"}`}>
            {resolved ? "Kein Bedarf" : "Nachproduktion"}
          </div>
          <div className={`text-xl font-bold font-mono ${resolved ? "text-emerald-700" : "text-white"}`}>
            {resolved ? "✓ 0" : fmt(c.recommendedBackfillPortions)} <span className="text-sm font-normal">Stk</span>
          </div>
        </div>
        {c.recommendedSource !== "none" && (
          <div className={`text-[10px] text-right max-w-[100px] ${resolved ? "text-emerald-500" : "text-slate-400"}`}>
            {SOURCE_LABEL[c.recommendedSource]}
          </div>
        )}
      </div>

      {/* Redzone Live */}
      {c.liveRedzonePortions != null && (
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-red-600 mt-2">
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            {c.liveRedzoneStatus === "active" && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />}
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-red-500" />
          </span>
          Redzone {c.liveRedzoneStatus === "active" ? "läuft" : "fertig"}: {fmt(c.liveRedzonePortions)} Stk
        </div>
      )}

      {/* Kompakte Signal-Zeile */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-600">
        {c.kitchenPriority && <span>Küche: <b className="text-sky-700">{fmt(c.kitchenMissingKg, 1)} kg</b></span>}
        {c.platingShortagePortions > 0 && <span>Plating: <b className="text-orange-700">{fmt(c.platingShortagePortions)} Stk</b></span>}
        {c.minNeededPortions != null && <span>Min Needs: <b className="text-violet-700">{fmt(c.minNeededPortions)} Stk</b></span>}
        {c.liveWmsHoldingKg != null && <span>WMS PLH: <b className="text-indigo-600">{fmt(c.liveWmsHoldingKg, 1)} kg</b></span>}
        {c.rtiHoldingKg > 0 && <span className="text-slate-400">RTI: {fmt(c.rtiHoldingKg, 1)} kg</span>}
      </div>

      {/* Gründe */}
      {c.platingShortageReasons.length > 0 && (
        <div className="text-[11px] text-slate-500 mt-1.5">Grund: {c.platingShortageReasons.join(" · ")}</div>
      )}

      {/* Sa-Ergebnis */}
      {c.backfillResultPortions != null && (
        <div className="text-[11px] text-slate-400 mt-1.5 bg-slate-50 rounded px-2 py-0.5">
          Sa. geplated: {fmt(c.backfillResultPortions)} Stk
          {c.backfillResultComments.length > 0 && ` (${c.backfillResultComments.join(", ")})`}
        </div>
      )}
    </div>
  );
}

// ─── Haupt-Ansicht ───────────────────────────────────────────────────────────

export function BackfillsView() {
  const {
    combined, alerts, criticalCount, totalRecommendedPortions,
    postblastConnected, preblastConnected, rtiConnected, linePlaitingConnected, wmsHoldingConnected,
    selectedWeekNum, setSelectedWeekNum, availableWeekNums, isStaleWeek,
  } = useBackfills();
  const redzone = useRedzoneOptional();
  const redzoneConnected = !!redzone && !redzone.error && !redzone.loading;
  const [filter, setFilter] = useState<"all" | "critical" | "behind" | "confirmed">("all");

  const filtered = combined.filter(c => {
    if (filter === "critical") return c.priority === "critical";
    if (filter === "behind") return c.priority === "behind" || c.priority === "critical";
    if (filter === "confirmed") return c.confidence === "confirmed";
    return true;
  });

  return (
    <div className="space-y-4 pb-8">
      {/* Header */}
      <div className="card p-5 bg-gradient-to-br from-violet-700 to-fuchsia-800 text-white border-0 shadow-lg">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <ConnDot label="Post-Blast" connected={postblastConnected} />
              <ConnDot label="Pre-Blast" connected={preblastConnected} />
              <ConnDot label="RTI" connected={rtiConnected} />
              <ConnDot label="LinePlaiting" connected={linePlaitingConnected} />
              <ConnDot label="Redzone" connected={redzoneConnected} />
              <ConnDot label="WMS" connected={wmsHoldingConnected} />
            </div>
            <h1 className="text-2xl font-bold">Backfills</h1>
            <p className="mt-0.5 text-sm text-violet-100/70">
              {combined.length} Meals · {criticalCount} kritisch · {fmt(totalRecommendedPortions)} Stk Nachproduktion
            </p>
          </div>

          {/* KW-Auswahl */}
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase font-bold text-violet-200 tracking-wide">KW</label>
            <select
              value={selectedWeekNum ?? ""}
              onChange={e => {
                const v = e.target.value;
                setSelectedWeekNum(v === "" ? null : Number(v));
              }}
              className="text-xs px-2 py-1 rounded-lg bg-white/20 text-white border border-white/30 focus:outline-none focus:ring-2 focus:ring-white/50"
            >
              <option value="" className="text-slate-800">Auto</option>
              {availableWeekNums.map(n => (
                <option key={n} value={n} className="text-slate-800">KW {n}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Stale-Week-Warnung */}
      {isStaleWeek && (
        <div className="rounded-xl p-3 bg-amber-50 ring-1 ring-amber-300 flex items-center gap-2">
          <span className="text-amber-600 text-sm">⚠</span>
          <div className="text-xs text-amber-800">
            <b>Daten der letzten Woche (KW {selectedWeekNum})</b> — für die aktuelle KW ist noch kein Produktionsplan importiert.
          </div>
        </div>
      )}

      {/* LinePlaiting GID */}
      <LinePlaitingGidUpdater />

      {/* Summary Dashboard */}
      <SummaryDashboard combined={combined} criticalCount={criticalCount} totalPortions={totalRecommendedPortions} />

      {/* Filter-Buttons */}
      <div className="flex gap-2 flex-wrap">
        {([
          { key: "all" as const, label: "Alle", count: combined.length },
          { key: "critical" as const, label: "Kritisch", count: combined.filter(c => c.priority === "critical").length },
          { key: "behind" as const, label: "Hinter Plan", count: combined.filter(c => c.priority === "behind" || c.priority === "critical").length },
          { key: "confirmed" as const, label: "Beide Quellen", count: combined.filter(c => c.confidence === "confirmed").length },
        ]).map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition ${
              filter === f.key
                ? "bg-violet-600 text-white shadow-sm"
                : "bg-white text-slate-600 hover:bg-slate-100 ring-1 ring-slate-200"
            }`}
          >
            {f.label} <span className="font-mono ml-1 opacity-70">{f.count}</span>
          </button>
        ))}
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="card p-4 shadow-sm">
          <h3 className="text-sm font-bold text-slate-800 mb-2">Früherkennung</h3>
          <div>{alerts.map(a => <AlertRow key={a.id} alert={a} />)}</div>
        </div>
      )}

      {/* Meal Cards */}
      {filtered.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-400">
          {combined.length === 0 ? "Noch keine Daten — warte auf Wiegungen/Plating-Einträge." : "Keine Meals in dieser Kategorie."}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map(c => <BackfillCard key={c.recipeCode} c={c} />)}
        </div>
      )}
    </div>
  );
}
