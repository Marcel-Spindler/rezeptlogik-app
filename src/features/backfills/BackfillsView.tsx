// Backfills – pro Meal EIN Satz ("X Stk nachproduzieren") + EINE Ampel (reicht
// die Rohware im Lager). Alles andere hinter "Details". Zahl kommt aus dem
// RTI Plating Tracker (Planned Target − Actuals), siehe combineBackfills.ts.
import { useRef, useState, type FormEvent } from "react";
import { useBackfills } from "./BackfillsContext";
import { useRedzoneOptional } from "../redzone-live/RedzoneContext";
import type { BackfillAlert, BackfillFeasibility, CombinedBackfillNeed } from "./backfillTypes";
import { fmt } from "../whatif/whatIfFormat";

// Bestandsmenge mit passender Einheit (Rezept-uom): grams → kg, ml → l, sonst roh.
function fmtInv(qty: number, uom: string): string {
  if (!isFinite(qty)) return "∞";
  const u = String(uom ?? "").toLowerCase();
  if (u === "grams" || u === "gram" || u === "g") return qty >= 1000 ? `${fmt(qty / 1000, 1)} kg` : `${fmt(qty)} g`;
  if (u === "ml") return qty >= 1000 ? `${fmt(qty / 1000, 1)} l` : `${fmt(qty)} ml`;
  return `${fmt(qty)} ${uom}`;
}

const SOURCE_LABEL: Record<CombinedBackfillNeed["recommendedSource"], string> = {
  lineplating: 'LinePlating „{Tag} needs" (Kitchen Priority)',
  plating: "LinePlating Planned − Actual (Σ KW)",
  rti: "RTI-Wiegung (Rückfall)",
  kitchen: "Küchen-Gewichts-Schätzung",
  none: "—",
};

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

// ─── LinePlaiting-Tab (Auto aus KW, Override möglich) ────────────────────────

function LinePlaitingGidUpdater() {
  const {
    linePlaitingSource, linePlaitingActiveTab, linePlaitingWeek, linePlaitingStale,
    linePlaitingConnected, linePlaitingLastUpdate, linePlaitingForceRefresh,
  } = useBackfills();
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const ok = linePlaitingSource.setGidOverride(input);
    setStatus(ok ? "ok" : "error");
    if (ok) { setInput(""); inputRef.current?.blur(); }
    setTimeout(() => setStatus("idle"), 3000);
  }

  const lastUpdate = linePlaitingLastUpdate
    ? new Date(linePlaitingLastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : "—";
  const isStale = linePlaitingLastUpdate != null && Date.now() - linePlaitingLastUpdate > 2 * 60 * 60 * 1000;
  const isOverride = linePlaitingSource.gidOverride !== "";

  return (
    <div className="card p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-bold text-slate-500 uppercase tracking-wide text-[10px] shrink-0">LinePlaiting-Tab</span>
        <span className={`text-[11px] font-mono ${isStale || linePlaitingStale ? "text-amber-600" : "text-slate-400"}`}>
          {linePlaitingActiveTab || "—"}
          {isOverride ? " (manuell)" : " (auto)"}
          {linePlaitingWeek && ` · geladen: ${linePlaitingWeek}`}
          {linePlaitingStale
            ? ` · ⚠ Tab zeigt noch ${linePlaitingWeek} → ignoriert`
            : linePlaitingConnected
              ? ` · ${lastUpdate}${isStale ? " · ⚠ >2h alt" : ""}`
              : " · wartet"}
        </span>
        {isOverride && (
          <button
            type="button"
            onClick={() => linePlaitingSource.clearOverride()}
            className="px-2 py-1 rounded-lg text-[11px] bg-amber-100 hover:bg-amber-200 text-amber-800 transition shrink-0"
          >
            ↩ zurück auf auto
          </button>
        )}
        <form onSubmit={handleSubmit} className="flex items-center gap-2 ml-auto">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Anderer Tab: Link oder gid…"
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
      {status === "ok" && <p className="text-[10px] text-emerald-600 mt-1.5">✓ Override übernommen.</p>}
      {status === "error" && <p className="text-[10px] text-red-600 mt-1.5">Konnte keine gid lesen — bitte den kompletten Link oder nur die Zahl einfügen.</p>}
    </div>
  );
}

// ─── Summary-Zeile ───────────────────────────────────────────────────────────

function SummaryStrip({
  combined, feasibilityByMeal, wmsConnected, generatedAt,
}: {
  combined: CombinedBackfillNeed[];
  feasibilityByMeal: Map<string, BackfillFeasibility>;
  wmsConnected: boolean;
  generatedAt: string | null;
}) {
  const needs = combined.filter(c => c.recommendedBackfillPortions > 0);
  const total = needs.reduce((s, c) => s + c.recommendedBackfillPortions, 0);

  let green = 0, yellow = 0, red = 0;
  if (wmsConnected) {
    for (const c of needs) {
      const v = feasibilityByMeal.get(c.recipeCode)?.verdict;
      if (v === "feasible") green++;
      else if (v === "partial") yellow++;
      else if (v === "blocked") red++;
    }
  }

  const ts = generatedAt ? new Date(generatedAt) : null;
  const stale = ts != null && Date.now() - ts.getTime() > 3 * 60 * 60 * 1000;

  return (
    <div className="card p-4 flex flex-wrap items-baseline gap-x-8 gap-y-2">
      <span className="text-sm text-slate-500">
        <b className="text-xl font-mono text-slate-900">{needs.length}</b> Meals mit Backfill
      </span>
      <span className="text-sm text-slate-500">
        <b className="text-xl font-mono text-slate-900">{fmt(total)}</b> Stk nachproduzieren
      </span>
      {wmsConnected
        ? needs.length > 0 && (
          <span className="text-sm text-slate-600 ml-auto">
            Rohware: <b className="text-emerald-700">🟢 {green}</b> <b className="text-amber-700">🟡 {yellow}</b> <b className="text-red-700">🔴 {red}</b>
            {ts && <span className={`ml-3 text-[11px] ${stale ? "text-amber-600 font-semibold" : "text-slate-400"}`}>
              Bestand-Stand {ts.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}{stale && " · alt"}
            </span>}
          </span>
        )
        : <span className="text-[11px] text-slate-400 ml-auto">Rohware-Ampel: lokalen WMS-Server starten (npm run wms:server)</span>}
    </div>
  );
}

// ─── Ampel (eine Zeile) ──────────────────────────────────────────────────────

function Ampel({ feasibility, wmsConnected }: { feasibility: BackfillFeasibility | undefined; wmsConnected: boolean }) {
  let dot = "⚪", text: string;
  if (!wmsConnected) text = "Rohware: Lager offline";
  else if (!feasibility || feasibility.verdict === "unknown") text = `Rohware: nicht prüfbar${feasibility?.reason ? ` (${feasibility.reason})` : ""}`;
  else if (feasibility.verdict === "feasible") { dot = "🟢"; text = "Rohware im Lager reicht"; }
  else if (feasibility.verdict === "partial") { dot = "🟡"; text = `Rohware reicht für ${fmt(feasibility.maxProduciblePortions)} Stk`; }
  else { dot = "🔴"; text = `Rohware fehlt${feasibility.bottleneck[0] ? ` — ${feasibility.bottleneck[0].ingredientName}` : ""}`; }

  return <div className="mt-1.5 text-sm font-medium text-slate-700">{dot} {text}</div>;
}

// ─── Details (aufklappbar) ───────────────────────────────────────────────────

function DetailsBlock({ c, feasibility }: { c: CombinedBackfillNeed; feasibility: BackfillFeasibility | undefined }) {
  return (
    <div className="mt-2 pt-2 border-t border-slate-100 space-y-2 text-[11px] text-slate-600">
      {/* Signal-Zeile aller Quellen */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {c.rtiPlannedTarget != null && <span>RTI-Wiegung: <b className="text-slate-800">{fmt(c.rtiActuals ?? 0)} / {fmt(c.rtiPlannedTarget)} Stk</b></span>}
        {c.minNeededPortions != null && <span>Tagesbedarf (LinePlating „needs"): <b className="text-violet-700">{fmt(c.minNeededPortions)} Stk</b></span>}
        {c.lpShortfallPortions > 0 && <span>LinePlating Σ Plan−Ist: <b className="text-orange-700">{fmt(c.lpShortfallPortions)} Stk</b></span>}
        {c.platingShortagePortions > 0 && <span className="text-slate-400">davon Di–Do: {fmt(c.platingShortagePortions)} Stk</span>}
        {c.kitchenPriority && <span>Küche: <b className="text-sky-700">−{fmt(c.kitchenMissingKg, 1)} kg</b></span>}
        {c.liveWmsHoldingKg != null && <span>WMS PLH: <b className="text-indigo-600">{fmt(c.liveWmsHoldingKg, 1)} kg</b></span>}
        {c.rtiHoldingKg > 0 && <span className="text-slate-400">RTI-Holding: {fmt(c.rtiHoldingKg, 1)} kg</span>}
        {c.liveRedzonePortions != null && (
          <span className="text-red-600 font-semibold">Redzone {c.liveRedzoneStatus === "active" ? "läuft" : "fertig"}: {fmt(c.liveRedzonePortions)} Stk (24h)</span>
        )}
      </div>

      {c.platingShortageReasons.length > 0 && (
        <div className="text-slate-500">Grund (LinePlaiting): {c.platingShortageReasons.join(" · ")}</div>
      )}
      {c.rtiBackfillCandidateSubs.length > 0 && (
        <div className="text-slate-500">Vorbereitete Backfill-WOs im RTI-Sheet: {c.rtiBackfillCandidateSubs.join(", ")}</div>
      )}
      {c.backfillResultPortions != null && (
        <div className="bg-slate-50 rounded px-2 py-0.5 text-slate-400">
          Sa. geplated: {fmt(c.backfillResultPortions)} Stk
          {c.backfillResultComments.length > 0 && ` (${c.backfillResultComments.join(", ")})`}
        </div>
      )}

      {/* Zutaten-Tabelle der Rohware-Prüfung */}
      {feasibility && feasibility.ingredients.length > 0 && (
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          <table className="w-full text-[10px]">
            <thead className="bg-slate-50 text-slate-400">
              <tr>
                <th className="text-left font-medium px-2 py-1">Zutat</th>
                <th className="text-right font-medium px-2 py-1">Bedarf</th>
                <th className="text-right font-medium px-2 py-1">Im Lager</th>
                <th className="text-right font-medium px-2 py-1">max Stk</th>
              </tr>
            </thead>
            <tbody>
              {feasibility.ingredients.map(ing => (
                <tr key={`${ing.ingredientId}__${ing.uom}`} className={`border-t border-slate-100 ${ing.isBottleneck ? "bg-red-50/40" : ""}`}>
                  <td className="px-2 py-1">
                    <div className="text-slate-700">{ing.ingredientName}</div>
                    <div className="text-slate-400">
                      {ing.subRecipeName}
                      {ing.notInWms ? " · nicht im WMS" : ing.expiredQty > 0 ? ` · ${fmtInv(ing.expiredQty, ing.uom)} abgelaufen` : ""}
                    </div>
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-slate-600">{fmtInv(ing.neededTotal, ing.uom)}</td>
                  <td className={`px-2 py-1 text-right font-mono ${ing.notInWms ? "text-red-500" : "text-slate-600"}`}>
                    {ing.notInWms ? "—" : fmtInv(ing.availableQty, ing.uom)}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono font-semibold ${ing.isBottleneck ? "text-red-600" : "text-slate-500"}`}>
                    {isFinite(ing.maxPortions) ? fmt(ing.maxPortions) : "∞"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[9px] text-slate-400 px-2 py-1 bg-slate-50 border-t border-slate-100">
            {feasibility.scope === "full-meal" && "geprüft: ganzes Meal (kein einzelnes Sub-Rezept gemeldet). "}
            Bedarf = Brutto-Rohware × {fmt(c.recommendedBackfillPortions)} Portionen. Reservierte/verplante Mengen nicht abgezogen.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Backfill Card ──────────────────────────────────────────────────────────

function statusChip(c: CombinedBackfillNeed): { label: string; cls: string } | null {
  if (c.rtiVetoed) return { label: "KEIN BACKFILL", cls: "bg-slate-200 text-slate-600" };
  if (c.recommendedBackfillPortions === 0) return null;
  if (c.rtiKitchenDone) return { label: "KÜCHE FERTIG", cls: "bg-emerald-100 text-emerald-700" };
  if (c.rtiHasOpenSubs || c.liveRedzoneStatus === "active") return { label: "LÄUFT NOCH", cls: "bg-amber-100 text-amber-700" };
  return null;
}

function BackfillCard({ c, feasibility, wmsConnected }: {
  c: CombinedBackfillNeed;
  feasibility: BackfillFeasibility | undefined;
  wmsConnected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const resolved = c.recommendedBackfillPortions === 0;
  const chip = statusChip(c);
  const lpDelta = c.platingPlannedPortions > 0 || c.lpShortfallPortions > 0;
  const context = (c.recommendedSource === "lineplating" || c.recommendedSource === "plating") && lpDelta
    ? `${c.lpWeek || "LinePlating"} · Σ Planned − Actual: ${fmt(c.lpShortfallPortions)}${c.minNeededPortions != null ? ` · „{Tag} needs": ${fmt(c.minNeededPortions)}` : ""}${c.lpStatusText ? ` · ${c.lpStatusText}` : ""}`
    : c.recommendedSource === "rti" && c.rtiPlannedTarget != null
      ? `RTI-Wiegung: ${fmt(c.rtiActuals ?? 0)} von ${fmt(c.rtiPlannedTarget)} Stk produziert`
      : `Quelle: ${SOURCE_LABEL[c.recommendedSource]}`;

  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-4 pl-5 shadow-sm hover:shadow-md transition-shadow">
      <PriorityStripe priority={c.priority} />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="font-mono font-bold text-sm text-slate-900">{c.recipeCode}</span>
          {c.codeVariants.length > 1 && (
            <span
              className="font-mono text-[10px] text-amber-600 ml-1"
              title={`Quellen nutzen unterschiedliche Code-Varianten (SKU-/Sleeve-Änderung): ${c.codeVariants.join(", ")} — als dasselbe Meal zusammengeführt.`}
            >
              (= {c.codeVariants.filter(v => v !== c.recipeCode).join(", ")})
            </span>
          )}
          <span className="text-xs text-slate-500 ml-2">{c.recipeName}</span>
        </div>
        {chip && <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded font-bold ${chip.cls}`}>{chip.label}</span>}
      </div>

      <div className={`mt-2 text-lg font-bold ${resolved ? "text-emerald-700" : "text-slate-900"}`}>
        {resolved ? "Kein Backfill nötig" : `${fmt(c.recommendedBackfillPortions)} Stk nachproduzieren`}
      </div>

      {!resolved && <Ampel feasibility={feasibility} wmsConnected={wmsConnected} />}

      <div className="mt-1.5 text-[11px] text-slate-500">{context}</div>

      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="mt-2 text-[11px] font-medium text-slate-500 hover:text-slate-800 transition-colors"
      >
        {open ? "▲ Weniger" : "▼ Details"}
      </button>
      {open && <DetailsBlock c={c} feasibility={feasibility} />}
    </div>
  );
}

// ─── Haupt-Ansicht ───────────────────────────────────────────────────────────

export function BackfillsView() {
  const {
    combined, alerts, totalRecommendedPortions,
    feasibilityByMeal, fullInventoryConnected, fullInventoryGeneratedAt,
    postblastConnected, preblastConnected, rtiConnected, linePlaitingConnected, wmsHoldingConnected,
    selectedWeekNum, setSelectedWeekNum, availableWeekNums, isStaleWeek,
  } = useBackfills();
  const redzone = useRedzoneOptional();
  const redzoneConnected = !!redzone && !redzone.error && !redzone.loading;
  const [filter, setFilter] = useState<"all" | "tight" | "open">("all");

  const isTight = (c: CombinedBackfillNeed) => {
    const v = feasibilityByMeal.get(c.recipeCode)?.verdict;
    return v === "partial" || v === "blocked";
  };

  const filtered = combined.filter(c => {
    if (filter === "tight") return !fullInventoryConnected || isTight(c);
    if (filter === "open") return c.rtiHasOpenSubs;
    return true;
  });

  return (
    <div className="space-y-4 pb-8">
      {/* Header */}
      <div className="card p-5 bg-gradient-to-br from-violet-700 to-fuchsia-800 text-white border-0 shadow-lg">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <ConnDot label="RTI" connected={rtiConnected} />
              <ConnDot label="Post-Blast" connected={postblastConnected} />
              <ConnDot label="Pre-Blast" connected={preblastConnected} />
              <ConnDot label="LinePlaiting" connected={linePlaitingConnected} />
              <ConnDot label="Redzone" connected={redzoneConnected} />
              <ConnDot label="WMS PLH" connected={wmsHoldingConnected} />
              <ConnDot label="Lager" connected={fullInventoryConnected} />
            </div>
            <h1 className="text-2xl font-bold">Backfills</h1>
            <p className="mt-0.5 text-sm text-violet-100/70">
              Zahl aus dem RTI Plating Tracker (Planned − Actuals) · {fmt(totalRecommendedPortions)} Stk gesamt
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

      {isStaleWeek && (
        <div className="rounded-xl p-3 bg-amber-50 ring-1 ring-amber-300 flex items-center gap-2">
          <span className="text-amber-600 text-sm">⚠</span>
          <div className="text-xs text-amber-800">
            <b>Daten der letzten Woche (KW {selectedWeekNum})</b> — für die aktuelle KW ist noch kein Produktionsplan importiert.
          </div>
        </div>
      )}

      <SummaryStrip
        combined={combined}
        feasibilityByMeal={feasibilityByMeal}
        wmsConnected={fullInventoryConnected}
        generatedAt={fullInventoryGeneratedAt}
      />

      {/* Filter */}
      <div className="flex gap-2 flex-wrap">
        {([
          { key: "all" as const, label: "Alle", count: combined.length },
          { key: "tight" as const, label: "Bestand knapp", count: combined.filter(isTight).length },
          { key: "open" as const, label: "Küche noch nicht durch", count: combined.filter(c => c.rtiHasOpenSubs).length },
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
          <h3 className="text-sm font-bold text-slate-800 mb-2">Meldungen</h3>
          <div>{alerts.map(a => <AlertRow key={a.id} alert={a} />)}</div>
        </div>
      )}

      {/* LinePlaiting-Tab (nur noch Kontext / Gegenprobe — Wartung des wöchentlichen gid) */}
      <LinePlaitingGidUpdater />

      {/* Meal Cards */}
      {filtered.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-400">
          {combined.length === 0
            ? "Kein Backfill-Bedarf — RTI-Sheet zeigt keine Meals unter Planned Target."
            : "Keine Meals in dieser Kategorie."}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map(c => (
            <BackfillCard
              key={c.recipeCode}
              c={c}
              feasibility={feasibilityByMeal.get(c.recipeCode)}
              wmsConnected={fullInventoryConnected}
            />
          ))}
        </div>
      )}
    </div>
  );
}
