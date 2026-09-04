// Grafische Flow-/Verlaufs-Ansicht EINER Work Order: Stufen-Schiene oben,
// aufklappbares Stufen-Detail, Submeal-Aufschlüsselung, verknüpfte Datenpunkte.
import { useMemo, useState } from "react";
import type { WoFlow, WoStageStatus } from "./searchTypes";
import type { WoHistoryPoint } from "./woHistory";

const STATUS_TONE: Record<WoStageStatus, { node: string; ring: string; line: string; dot: string; label: string }> = {
  done:    { node: "bg-emerald-500 text-white",   ring: "ring-emerald-200", line: "bg-emerald-400", dot: "bg-emerald-500",  label: "erledigt" },
  active:  { node: "bg-amber-400 text-white animate-pulse", ring: "ring-amber-200", line: "bg-amber-300", dot: "bg-amber-500", label: "läuft" },
  pending: { node: "bg-slate-100 text-slate-400", ring: "ring-slate-200", line: "bg-slate-200", dot: "bg-slate-300",   label: "ausstehend" },
  blocked: { node: "bg-rose-500 text-white",      ring: "ring-rose-200",  line: "bg-rose-300",  dot: "bg-rose-500",    label: "blockiert" },
  unknown: { node: "bg-slate-100 text-slate-400", ring: "ring-slate-200", line: "bg-slate-200", dot: "bg-slate-300",   label: "unbekannt" },
};

const SEVERITY_TONE: Record<string, string> = {
  ok: "bg-emerald-100 text-emerald-700",
  warn: "bg-amber-100 text-amber-700",
  critical: "bg-rose-100 text-rose-700",
};

function fmtKg(n: number): string {
  if (!n) return "–";
  return n >= 100 ? `${Math.round(n)} kg` : `${n.toFixed(1)} kg`;
}

export function WoFlowCard({
  flow,
  history,
  onOpenRecipe,
}: {
  flow: WoFlow;
  history?: WoHistoryPoint[];
  onOpenRecipe?: (recipeCode: string) => void;
}) {
  const defaultStage = useMemo(() => {
    const active = flow.stages.findIndex((s) => s.status === "active");
    if (active >= 0) return active;
    const lastDone = flow.stages.reduce((acc, s, i) => (s.status === "done" ? i : acc), 0);
    return Math.min(lastDone + 1, flow.stages.length - 1);
  }, [flow.stages]);
  const [activeIdx, setActiveIdx] = useState(defaultStage);
  const stage = flow.stages[activeIdx] ?? flow.stages[0];

  return (
    <div className="card p-4 space-y-4">
      {/* Kopf */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-lg font-black tracking-tight text-slate-900">WO {flow.woNumber}</span>
            {flow.weekLabel && <span className="pill bg-slate-100 text-slate-600">{flow.weekLabel}</span>}
            {flow.severity && (
              <span className={`pill ${SEVERITY_TONE[flow.severity] ?? "bg-slate-100 text-slate-600"}`}>
                Abgleich: {flow.severity}
              </span>
            )}
            {flow.platingNow && <span className="pill bg-rose-100 text-rose-700">🔴 wird platiert</span>}
          </div>
          <div className="mt-1 text-sm text-slate-600">
            {onOpenRecipe && flow.recipeCode ? (
              <button
                type="button"
                onClick={() => onOpenRecipe(flow.recipeCode)}
                className="font-mono font-semibold text-verden-700 hover:underline"
              >
                {flow.recipeCode}
              </button>
            ) : (
              <span className="font-mono font-semibold">{flow.recipeCode || "–"}</span>
            )}
            {flow.recipeName && <span> · {flow.recipeName}</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
            {flow.sources.map((s) => (
              <span key={s} className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">{s}</span>
            ))}
            {!flow.hasPlanRows && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700">
                kein Produktionsplan – Flow aus Rezeptdaten
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-black tabular-nums text-slate-900">{flow.progressPct ?? 0}%</div>
          <div className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-verden-500" style={{ width: `${Math.min(100, flow.progressPct ?? 0)}%` }} />
          </div>
          {flow.eta && <div className="mt-1 text-[11px] text-slate-400">ETA {flow.eta}</div>}
        </div>
      </div>

      {/* Stufen-Schiene */}
      <div className="overflow-x-auto">
        <div className="flex min-w-[560px] items-start">
          {flow.stages.map((s, i) => {
            const tone = STATUS_TONE[s.status];
            const prevDone = i > 0 && ["done", "active"].includes(flow.stages[i - 1].status);
            return (
              <div key={s.key} className="flex flex-1 flex-col items-center">
                <div className="flex w-full items-center">
                  <div className={`h-1 flex-1 rounded ${i === 0 ? "bg-transparent" : prevDone ? STATUS_TONE.done.line : "bg-slate-200"}`} />
                  <button
                    type="button"
                    onClick={() => setActiveIdx(i)}
                    title={`${s.label} – ${tone.label}`}
                    className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-base ring-4 transition ${tone.node} ${
                      i === activeIdx ? "ring-verden-300 scale-110" : tone.ring
                    }`}
                  >
                    {s.icon}
                  </button>
                  <div className={`h-1 flex-1 rounded ${i === flow.stages.length - 1 ? "bg-transparent" : ["done", "active"].includes(s.status) ? STATUS_TONE.done.line : "bg-slate-200"}`} />
                </div>
                <div className="mt-1.5 text-center">
                  <div className={`text-[11px] font-semibold ${i === activeIdx ? "text-slate-900" : "text-slate-500"}`}>{s.label}</div>
                  <div className="flex items-center justify-center gap-1">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                    <span className="text-[10px] text-slate-400">{tone.label}</span>
                  </div>
                  {s.when && <div className="text-[10px] text-slate-400">{s.when}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Stufen-Detail */}
      <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
        <div className="flex items-center gap-2">
          <span className="text-lg">{stage.icon}</span>
          <span className="font-semibold text-slate-800">{stage.label}</span>
          <span className={`pill ${STATUS_TONE[stage.status].node}`}>{STATUS_TONE[stage.status].label}</span>
        </div>
        {stage.metrics.length > 0 && (
          <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
            {stage.metrics.map((m, i) => (
              <div key={i} className="flex justify-between gap-2 text-xs">
                <span className="text-slate-500">{m.label}</span>
                <span className="font-medium text-slate-800 text-right">{m.value}</span>
              </div>
            ))}
          </div>
        )}
        {stage.notes.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-[11px] text-slate-500">
            {stage.notes.map((n, i) => <li key={i}>· {n}</li>)}
          </ul>
        )}
      </div>

      {/* Submeals */}
      {flow.submeals.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {history && history.length > 0 && (
          <div className="border-t border-slate-100 pt-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Abgleichsverlauf</div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {history.map((point) => (
                <div key={point.capturedAt} className="min-w-32 border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px]">
                  <div className="font-semibold text-slate-700">
                    {new Date(point.capturedAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </div>
                  <div className={point.severity === "critical" ? "text-rose-700" : point.severity === "warn" ? "text-amber-700" : "text-emerald-700"}>
                    {point.severity === "critical" ? "kritisch" : point.severity === "warn" ? "Warnung" : "ok"} · {point.progressPct ?? 0}%
                  </div>
                  <div className="text-slate-500">{point.weighingCount} Wiegungen{point.complete ? " · fertig" : ""}</div>
                </div>
              ))}
            </div>
          </div>
        )}

            Submeals ({flow.submeals.length})
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="py-1 pr-2 font-medium">Sub-Rezept</th>
                  <th className="py-1 pr-2 font-medium">Cook</th>
                  <th className="py-1 pr-2 font-medium text-right">Staging</th>
                  <th className="py-1 pr-2 font-medium text-right">Küche</th>
                  <th className="py-1 pr-2 font-medium text-right">Post</th>
                  <th className="py-1 pr-2 font-medium text-right">Yield</th>
                  <th className="py-1 pr-2 font-medium">Chiller</th>
                </tr>
              </thead>
              <tbody>
                {flow.submeals.map((s) => (
                  <tr key={s.name} className="border-t border-slate-100">
                    <td className="py-1 pr-2 font-medium text-slate-800">{s.name}</td>
                    <td className="py-1 pr-2 text-slate-500">{s.cookMethods.join(" / ") || "–"}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-slate-600">{fmtKg(s.stagingKg)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-slate-600">{fmtKg(s.kitchenKg)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-slate-600">{fmtKg(s.postKg)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums text-slate-600">{s.yieldPct != null ? `${Math.round(s.yieldPct)} %` : "–"}</td>
                    <td className="py-1 pr-2">
                      {s.chillerKey ? (
                        <span
                          title={s.allergen ?? (s.allergenUnknown ? "keine Allergen-Daten – Rest-Pool" : "allergenfrei")}
                          className={`pill ${s.allergenUnknown ? "bg-slate-100 text-slate-500" : "bg-sky-100 text-sky-700"}`}
                        >
                          {s.chillerLabel}
                        </span>
                      ) : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Verknüpfte Datenpunkte */}
      <div className="flex flex-wrap gap-1.5 border-t border-slate-100 pt-3 text-[11px]">
        {flow.allergens.length > 0 && (
          <span className="rounded bg-amber-50 px-2 py-1 font-medium text-amber-700">⚠ {flow.allergens.join(", ")}</span>
        )}
        {flow.cookMethods.length > 0 && (
          <span className="rounded bg-slate-100 px-2 py-1 font-medium text-slate-600">🔧 {flow.cookMethods.join(" / ")}</span>
        )}
        {flow.weighingCount > 0 && (
          <span className="rounded bg-rose-50 px-2 py-1 font-medium text-rose-700">
            ⚖ {flow.weighingCount} Wiegungen{flow.lastWeighing ? ` · zuletzt ${flow.lastWeighing}` : ""}
          </span>
        )}
        {flow.comments.map((c, i) => (
          <span key={i} className="rounded bg-slate-100 px-2 py-1 text-slate-500">💬 {c}</span>
        ))}
      </div>
    </div>
  );
}
