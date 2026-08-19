// Postblast Live View — Echtzeit-Dashboard: GSheet-Wiegungen vs. geplante Work Orders.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle } from "../../core/types";
import { usePostblastMonitor } from "./useGSheetMonitor";
import { matchPostblastToWorkOrders, type BackfillNeed } from "./postblastMatch";
import { generateBackfillPlan, exportBackfillPlanExcel } from "./backfillGenerator";
import { analyzeProduction, type AlertSeverity } from "./productionAgent";
import { respondToChat, type ChatMessage, type ChatContext } from "./postblastChat";
import { fmt, fmtMass } from "../whatif/whatIfFormat";

// ─── Primitive Komponenten ───────────────────────────────────────────────────

function ProgressBar({ pct, size = "md" }: { pct: number; size?: "sm" | "md" }) {
  const h = size === "sm" ? "h-2" : "h-3";
  const color =
    pct >= 95 ? "bg-emerald-500" :
    pct >= 60 ? "bg-sky-500" :
    pct >= 30 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className={`w-full ${h} rounded-full bg-slate-200 overflow-hidden`}>
      <div className={`${h} rounded-full ${color} transition-all duration-500`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

function PriorityBadge({ priority }: { priority: BackfillNeed["priority"] }) {
  const cls =
    priority === "critical" ? "bg-red-200 text-red-800" :
    priority === "behind" ? "bg-amber-200 text-amber-800" :
    "bg-emerald-100 text-emerald-700";
  const label = priority === "critical" ? "KRITISCH" : priority === "behind" ? "HINTER PLAN" : "OK";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${cls}`}>{label}</span>;
}

function AlertIcon({ severity }: { severity: AlertSeverity }) {
  if (severity === "critical") return <span className="text-red-600">●</span>;
  if (severity === "warning") return <span className="text-amber-500">●</span>;
  if (severity === "info") return <span className="text-sky-500">●</span>;
  return <span className="text-emerald-500">●</span>;
}

// ─── Hauptkomponente ─────────────────────────────────────────────────────────

export function PostblastLiveView({ data }: { data: DataBundle }): JSX.Element {
  const postblastMonitor = usePostblastMonitor();

  // ── State ──
  const [expandedMeals, setExpandedMeals] = useState<Set<string>>(new Set());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [liveFeedSearch, setLiveFeedSearch] = useState("");
  const [liveFeedToday, setLiveFeedToday] = useState(true);
  const [backfillFilter, setBackfillFilter] = useState<"all" | "critical" | "behind">("all");
  const [shiftEndHours, setShiftEndHours] = useState(8);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // ── Daten-Derivate ──
  const { matched, meals, backfill } = useMemo(
    () => matchPostblastToWorkOrders(postblastMonitor.data, data.productionPlan),
    [postblastMonitor.data, data.productionPlan]
  );

  const backfillPlan = useMemo(
    () => generateBackfillPlan(backfill, data),
    [backfill, data]
  );

  const intelligence = useMemo(
    () => analyzeProduction(postblastMonitor.data, meals, backfillPlan, data.productionPlan, shiftEndHours),
    [postblastMonitor.data, meals, backfillPlan, data.productionPlan, shiftEndHours]
  );

  const todayEntries = useMemo(
    () => (postblastMonitor.data?.entries ?? []).filter(e => e.date === todayStr),
    [postblastMonitor.data, todayStr]
  );

  const liveEntries = useMemo(() => {
    const all = postblastMonitor.data?.entries ?? [];
    let list = liveFeedToday ? all.filter(e => e.date === todayStr) : [...all];
    if (liveFeedSearch.trim()) {
      const s = liveFeedSearch.toLowerCase();
      list = list.filter(e =>
        e.workOrder.toLowerCase().includes(s) ||
        e.subRecipeName.toLowerCase().includes(s) ||
        e.subSubRecipe.toLowerCase().includes(s)
      );
    }
    return [...list].reverse().slice(0, 60);
  }, [postblastMonitor.data, liveFeedToday, liveFeedSearch, todayStr]);

  const filteredBackfill = useMemo(() => {
    if (backfillFilter === "critical") return backfill.filter(b => b.priority === "critical");
    if (backfillFilter === "behind") return backfill.filter(b => b.priority === "behind");
    return backfill;
  }, [backfill, backfillFilter]);

  // ── Abgeleitete Summary-Zahlen ──
  const totalPlanned = meals.reduce((s, m) => s + m.totalPlannedKg, 0);
  const totalActual = meals.reduce((s, m) => s + m.totalActualKg, 0);
  const overallPct = totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;
  const criticalCount = backfill.filter(b => b.priority === "critical").length;
  const behindCount = backfill.filter(b => b.priority === "behind").length;

  const lastUpdate = postblastMonitor.lastUpdate
    ? new Date(postblastMonitor.lastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  // ── Chat Auto-Scroll ──
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // ── Event-Handler ──
  function toggleMeal(code: string) {
    setExpandedMeals(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  function handleChat(e: React.FormEvent) {
    e.preventDefault();
    const input = chatInput.trim();
    if (!input) return;
    setChatInput("");
    const ctx: ChatContext = { meals, backfill, intelligence, matched, todayEntries };
    const response = respondToChat(input, ctx);
    setChatMessages(prev => [...prev, { role: "user", text: input }, { role: "agent", text: response }]);
    if (!chatOpen) setChatOpen(true);
  }

  function handleQuickChat(prompt: string) {
    const ctx: ChatContext = { meals, backfill, intelligence, matched, todayEntries };
    const response = respondToChat(prompt, ctx);
    setChatMessages(prev => [...prev, { role: "user", text: prompt }, { role: "agent", text: response }]);
    setChatOpen(true);
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    await postblastMonitor.forceRefresh();
    setTimeout(() => setIsRefreshing(false), 1000);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">

      {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
      <div className="card p-5 bg-gradient-to-r from-teal-50 to-cyan-50 border-2 border-teal-200">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Postblast Live Monitor</h1>
            <p className="mt-1 text-sm text-slate-600">Echtzeit-Wiegungen aus GSheet vs. geplante Work Orders</p>
          </div>

          <div className="flex flex-col items-end gap-2">
            {/* Live-Status + Refresh */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleRefresh()}
                disabled={isRefreshing}
                className="px-2.5 py-1 rounded-full text-xs bg-white ring-1 ring-teal-300 text-teal-700 hover:bg-teal-50 transition disabled:opacity-50"
                title="Jetzt neu laden"
              >
                {isRefreshing ? "⟳ Lädt…" : "⟳ Refresh"}
              </button>
              <div className={`px-3 py-1 rounded-full ring-1 text-xs ${postblastMonitor.isPolling ? "bg-emerald-100 ring-emerald-300 text-emerald-800" : "bg-slate-100 ring-slate-300"}`}>
                {postblastMonitor.isPolling ? `Live · ${lastUpdate}` : "Offline"}
              </div>
            </div>
            {postblastMonitor.error && (
              <div className="px-3 py-1 rounded-full bg-red-100 ring-1 ring-red-300 text-red-800 text-xs">
                {postblastMonitor.error}
              </div>
            )}
            {/* Schicht-Ende Einstellung */}
            <div className="flex items-center gap-1.5 text-xs text-slate-600">
              <span>Schicht-Ende:</span>
              <select
                value={shiftEndHours}
                onChange={e => setShiftEndHours(Number(e.target.value))}
                className="text-xs px-1.5 py-0.5 rounded border border-slate-300 bg-white"
              >
                {[6, 7, 8, 9, 10, 12].map(h => (
                  <option key={h} value={h}>{h} h</option>
                ))}
              </select>
              <span className="text-slate-400">(für Prognose)</span>
            </div>
          </div>
        </div>

        {/* Gesamtfortschritt */}
        <div className="mt-4">
          <div className="flex items-center justify-between text-sm mb-1">
            <span className="font-bold text-slate-700">Gesamtfortschritt</span>
            <span className="font-mono font-bold">{fmt(overallPct, 1)}% · {fmtMass(totalActual * 1000)} / {fmtMass(totalPlanned * 1000)}</span>
          </div>
          <ProgressBar pct={overallPct} />
        </div>

        <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          {[
            { label: "Meals", value: meals.length, color: "" },
            { label: "Work Orders", value: matched.length, color: "" },
            { label: "Fertig", value: matched.filter(m => m.isComplete).length, color: "text-emerald-700" },
            { label: "Kritisch", value: criticalCount, color: "text-red-700" },
            { label: "Hinter Plan", value: behindCount, color: "text-amber-700" },
          ].map(s => (
            <div key={s.label} className="bg-white/70 rounded-lg p-2 text-center">
              <div className="text-slate-500 uppercase font-bold">{s.label}</div>
              <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ══ KI PRODUKTIONS-AGENT ═══════════════════════════════════════════ */}
      {(intelligence.alerts.length > 0 || intelligence.recommendations.length > 0 || chatMessages.length > 0) && (
        <div className="card p-5 border-2 border-purple-200 bg-gradient-to-r from-purple-50/50 to-fuchsia-50/30">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-bold text-slate-800">KI Produktions-Agent</h3>
              {intelligence.shiftSummary && (
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                  intelligence.shiftSummary.overallHealth === "good" ? "bg-emerald-200 text-emerald-800" :
                  intelligence.shiftSummary.overallHealth === "warning" ? "bg-amber-200 text-amber-800" :
                  "bg-red-200 text-red-800"
                }`}>
                  {intelligence.shiftSummary.overallHealth === "good" ? "ON TRACK" :
                   intelligence.shiftSummary.overallHealth === "warning" ? "ACHTUNG" : "KRITISCH"}
                </span>
              )}
            </div>
            <button
              onClick={() => setChatOpen(o => !o)}
              className="text-xs px-3 py-1.5 rounded-full bg-purple-100 ring-1 ring-purple-300 text-purple-800 hover:bg-purple-200 transition font-medium"
            >
              {chatOpen ? "Chat ausblenden" : "💬 Chat öffnen"}
            </button>
          </div>

          {/* Schicht-Zusammenfassung */}
          {intelligence.shiftSummary && (
            <div className="mb-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div className="bg-white/70 rounded-lg p-2">
                <div className="text-slate-500 uppercase font-bold">Gewogen heute</div>
                <div className="text-sm font-bold font-mono">{fmt(intelligence.shiftSummary.totalWeighed, 1)} kg</div>
                <div className="text-[10px] text-slate-400">{intelligence.shiftSummary.totalEntries} Wiegungen</div>
              </div>
              <div className="bg-white/70 rounded-lg p-2">
                <div className="text-slate-500 uppercase font-bold">Tempo</div>
                <div className="text-sm font-bold font-mono">{fmt(intelligence.shiftSummary.kgPerHour, 1)} kg/h</div>
                <div className="text-[10px] text-slate-400">{fmt(intelligence.shiftSummary.entriesPerHour, 1)} Wieg./h · seit {fmt(intelligence.shiftSummary.shiftDurationHours, 1)} h</div>
              </div>
              <div className="bg-white/70 rounded-lg p-2">
                <div className="text-slate-500 uppercase font-bold">Prognose Schichtende</div>
                <div className="text-sm font-bold font-mono">{fmt(intelligence.shiftSummary.projectedEndOfShift, 0)} kg</div>
                <div className="text-[10px] text-slate-400">bei {shiftEndHours} h Schicht</div>
              </div>
              {intelligence.shiftSummary.shortfallAtEndOfShift > 0 ? (
                <div className="bg-red-100/70 rounded-lg p-2">
                  <div className="text-red-700 uppercase font-bold">Fehlprognose</div>
                  <div className="text-sm font-bold font-mono text-red-700">−{fmt(intelligence.shiftSummary.shortfallAtEndOfShift, 0)} kg</div>
                  <div className="text-[10px] text-red-500">Backfill nötig!</div>
                </div>
              ) : (
                <div className="bg-emerald-50/70 rounded-lg p-2">
                  <div className="text-emerald-700 uppercase font-bold">Prognose</div>
                  <div className="text-sm font-bold font-mono text-emerald-700">Plan erfüllt ✓</div>
                </div>
              )}
            </div>
          )}

          {/* Alerts */}
          {intelligence.alerts.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {intelligence.alerts.slice(0, 8).map(alert => (
                <div key={alert.id} className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
                  alert.severity === "critical" ? "bg-red-100/70 ring-1 ring-red-200" :
                  alert.severity === "warning" ? "bg-amber-100/70 ring-1 ring-amber-200" :
                  "bg-white/70 ring-1 ring-slate-200"
                }`}>
                  <AlertIcon severity={alert.severity} />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-800">{alert.title}</div>
                    <div className="text-slate-600 mt-0.5">{alert.message}</div>
                    {alert.suggestedAction && (
                      <div className="mt-1 text-purple-700 font-medium">→ {alert.suggestedAction}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empfehlungen */}
          {intelligence.recommendations.length > 0 && (
            <div className="bg-white/70 rounded-lg p-3 ring-1 ring-purple-200 mb-3">
              <div className="text-[10px] uppercase font-bold text-purple-700 mb-1.5">Empfehlungen</div>
              <ul className="space-y-1 text-xs text-slate-700">
                {intelligence.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-purple-500 shrink-0">▸</span>
                    <span>{rec}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Chat-Interface ── */}
          {chatOpen && (
            <div className="bg-white/80 rounded-xl ring-1 ring-purple-200 overflow-hidden">
              <div className="px-3 py-2 bg-purple-100/60 text-[10px] uppercase font-bold text-purple-700 flex items-center justify-between">
                <span>💬 Chat mit KI-Agent</span>
                <span className="text-purple-400 normal-case font-normal">Tippe 'hilfe' für alle Befehle</span>
              </div>

              {/* Quick-Actions */}
              <div className="px-3 pt-2 pb-1 flex flex-wrap gap-1.5">
                {["status", "was fehlt", "kritisch", "prognose", "empfehlung", "engpass"].map(q => (
                  <button
                    key={q}
                    onClick={() => handleQuickChat(q)}
                    className="text-[10px] px-2 py-1 rounded bg-purple-50 ring-1 ring-purple-200 text-purple-700 hover:bg-purple-100 transition"
                  >
                    {q}
                  </button>
                ))}
              </div>

              {/* Nachrichten */}
              {chatMessages.length > 0 && (
                <div className="px-3 py-2 max-h-64 overflow-y-auto space-y-2">
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[85%] px-3 py-1.5 rounded-xl text-xs leading-relaxed ${
                        msg.role === "user"
                          ? "bg-purple-600 text-white rounded-br-sm"
                          : "bg-slate-100 text-slate-800 rounded-bl-sm ring-1 ring-slate-200"
                      }`}>
                        {msg.role === "agent" && (
                          <span className="text-[10px] font-bold text-purple-600 block mb-0.5">KI-Agent</span>
                        )}
                        {msg.text}
                      </div>
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
              )}

              {chatMessages.length === 0 && (
                <div className="px-3 py-3 text-xs text-slate-400 text-center">
                  Stelle eine Frage zur Produktion — oder klicke einen Quick-Button oben.
                </div>
              )}

              {/* Eingabe */}
              <form onSubmit={handleChat} className="flex gap-2 px-3 pb-3 pt-1">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="Frage stellen… z.B. 'was fehlt', 'WO 123456'"
                  className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-1 focus:ring-purple-400"
                />
                <button
                  type="submit"
                  disabled={!chatInput.trim()}
                  className="px-3 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-medium hover:bg-purple-700 disabled:opacity-40 transition"
                >
                  Senden
                </button>
                {chatMessages.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setChatMessages([])}
                    className="px-2 py-1.5 rounded-lg bg-slate-100 text-slate-500 text-xs hover:bg-slate-200 transition"
                    title="Chat leeren"
                  >
                    ✕
                  </button>
                )}
              </form>
            </div>
          )}
        </div>
      )}

      {/* ══ MEAL-FORTSCHRITT ════════════════════════════════════════════════ */}
      {meals.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="text-lg font-bold text-slate-800">Fortschritt je Meal</h3>
            <div className="flex gap-1.5">
              <button
                onClick={() => setExpandedMeals(new Set(meals.map(m => m.recipeCode)))}
                className="text-[10px] px-2 py-1 rounded bg-slate-100 text-slate-600 hover:bg-slate-200 transition"
              >
                Alle aufklappen
              </button>
              <button
                onClick={() => setExpandedMeals(new Set())}
                className="text-[10px] px-2 py-1 rounded bg-slate-100 text-slate-600 hover:bg-slate-200 transition"
              >
                Alle zuklappen
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {meals.map(meal => {
              const expanded = expandedMeals.has(meal.recipeCode);
              return (
                <div
                  key={meal.recipeCode}
                  className={`rounded-xl border transition-colors ${meal.criticalWOs.length > 0 ? "border-red-300 bg-red-50/30" : "border-slate-200 hover:border-slate-300"}`}
                >
                  {/* Meal-Header — klickbar */}
                  <div
                    className="flex items-center justify-between gap-3 p-3 cursor-pointer"
                    onClick={() => toggleMeal(meal.recipeCode)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-400 select-none">{expanded ? "▼" : "▶"}</span>
                        <div className="font-bold text-sm text-slate-800 truncate">{meal.recipeCode} · {meal.recipeName}</div>
                      </div>
                      <div className="text-[11px] text-slate-500 ml-4">
                        {meal.completedWOs}/{meal.totalWOs} WOs fertig · {fmt(meal.plannedMeals)} Meals geplant
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm font-mono font-bold">{fmt(meal.progressPct, 0)}%</div>
                      <div className="text-[10px] text-slate-500">{fmtMass(meal.totalActualKg * 1000)} / {fmtMass(meal.totalPlannedKg * 1000)}</div>
                    </div>
                  </div>

                  {/* Fortschrittsbalken */}
                  <div className="px-3 pb-2">
                    <ProgressBar pct={meal.progressPct} size="sm" />
                  </div>

                  {/* Kritische WOs Hinweis */}
                  {meal.criticalWOs.length > 0 && !expanded && (
                    <div className="px-3 pb-2 text-[11px] text-red-700">
                      Kritisch: {meal.criticalWOs.map(w => w.subRecipe).join(", ")}
                    </div>
                  )}

                  {/* Aufgeklappte WO-Tabelle */}
                  {expanded && (
                    <div className="mx-3 mb-3 overflow-hidden rounded-lg ring-1 ring-slate-200">
                      <table className="min-w-full text-xs">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                          <tr>
                            <th className="px-2 py-1.5 text-left">WO</th>
                            <th className="px-2 py-1.5 text-left">Sub-Rezept</th>
                            <th className="px-2 py-1.5 text-right">Geplant</th>
                            <th className="px-2 py-1.5 text-right">Ist</th>
                            <th className="px-2 py-1.5 text-right">%</th>
                            <th className="px-2 py-1.5 text-center">Status</th>
                            <th className="px-2 py-1.5 text-left">Letzte Wiegung</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 bg-white">
                          {meal.workOrders.map(wo => (
                            <tr key={wo.workOrder} className={wo.isCritical ? "bg-red-50/40" : wo.isComplete ? "bg-emerald-50/30" : ""}>
                              <td className="px-2 py-1.5 font-mono font-bold text-slate-700">{wo.workOrder}</td>
                              <td className="px-2 py-1.5 font-medium truncate max-w-[160px]">{wo.subRecipe}</td>
                              <td className="px-2 py-1.5 text-right font-mono">{fmt(wo.plannedKg, 1)} kg</td>
                              <td className="px-2 py-1.5 text-right font-mono font-bold">{fmt(wo.actualKg, 1)} kg</td>
                              <td className="px-2 py-1.5 text-right font-mono">{fmt(wo.progressPct, 0)}%</td>
                              <td className="px-2 py-1.5 text-center">
                                {wo.isComplete ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">FERTIG</span>
                                ) : wo.isCritical ? (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-bold">KRITISCH</span>
                                ) : (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 font-bold">LÄUFT</span>
                                )}
                              </td>
                              <td className="px-2 py-1.5 text-[10px] text-slate-400">{wo.lastWeighing ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══ BACKFILL-BEDARF ═════════════════════════════════════════════════ */}
      {backfill.length > 0 && (
        <div className="card p-5 border-2 border-amber-200 bg-amber-50/30">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-1">
            <div>
              <h3 className="text-lg font-bold text-slate-800">Backfill-Bedarf</h3>
              <p className="text-sm text-slate-600">Work Orders die noch produziert werden müssen</p>
            </div>
            {/* Filter-Buttons */}
            <div className="flex gap-1.5 text-xs">
              {(["all", "critical", "behind"] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setBackfillFilter(f)}
                  className={`px-2.5 py-1 rounded-full ring-1 font-medium transition ${
                    backfillFilter === f
                      ? f === "critical" ? "bg-red-200 ring-red-300 text-red-800"
                        : f === "behind" ? "bg-amber-200 ring-amber-300 text-amber-800"
                        : "bg-slate-200 ring-slate-300 text-slate-700"
                      : "bg-white ring-slate-200 text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {f === "all" ? `Alle (${backfill.length})` : f === "critical" ? `Kritisch (${backfill.filter(b => b.priority === "critical").length})` : `Hinter Plan (${backfill.filter(b => b.priority === "behind").length})`}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl ring-1 ring-amber-200 mt-3">
            <div className="max-h-[500px] overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-amber-100 text-[10px] uppercase tracking-wide text-amber-800">
                  <tr>
                    <th className="px-3 py-2 text-left">WO</th>
                    <th className="px-3 py-2 text-left">Sub-Rezept</th>
                    <th className="px-3 py-2 text-left">Meal</th>
                    <th className="px-3 py-2 text-right">Fehlt (kg)</th>
                    <th className="px-3 py-2 text-right">Fehlt %</th>
                    <th className="px-3 py-2 text-right">~ Portionen</th>
                    <th className="px-3 py-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-100 bg-white">
                  {filteredBackfill.map(b => (
                    <tr key={b.workOrder} className={b.priority === "critical" ? "bg-red-50/50" : ""}>
                      <td className="px-3 py-2 font-mono font-bold">{b.workOrder}</td>
                      <td className="px-3 py-2 font-medium truncate max-w-[200px]">{b.subRecipe}</td>
                      <td className="px-3 py-2 text-slate-500 truncate max-w-[150px]">{b.recipeCode}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-red-700">{fmt(b.missingKg, 2)} kg</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(b.missingPct, 0)}%</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(b.estimatedPortions)}</td>
                      <td className="px-3 py-2 text-center"><PriorityBadge priority={b.priority} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="bg-white rounded-lg p-2 ring-1 ring-amber-200">
              <div className="text-amber-700 uppercase font-bold">Gesamt fehlt</div>
              <div className="text-lg font-bold font-mono">{fmtMass(backfill.reduce((s, b) => s + b.missingKg, 0) * 1000)}</div>
            </div>
            <div className="bg-white rounded-lg p-2 ring-1 ring-red-200">
              <div className="text-red-700 uppercase font-bold">Kritische WOs</div>
              <div className="text-lg font-bold font-mono text-red-700">{backfill.filter(b => b.priority === "critical").length}</div>
            </div>
            <div className="bg-white rounded-lg p-2 ring-1 ring-amber-200">
              <div className="text-amber-700 uppercase font-bold">Hinter Plan</div>
              <div className="text-lg font-bold font-mono text-amber-700">{backfill.filter(b => b.priority === "behind").length}</div>
            </div>
            <div className="bg-white rounded-lg p-2 ring-1 ring-slate-200">
              <div className="text-slate-600 uppercase font-bold">~ Portionen fehlen</div>
              <div className="text-lg font-bold font-mono">{fmt(backfill.reduce((s, b) => s + b.estimatedPortions, 0))}</div>
            </div>
          </div>
        </div>
      )}

      {/* ══ BACKFILL WO GENERATOR ═══════════════════════════════════════════ */}
      {backfill.length > 0 && backfillPlan.proposals.length > 0 && (
        <div className="card p-5 border-2 border-rose-200 bg-gradient-to-br from-rose-50/50 to-white">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h3 className="text-lg font-bold text-slate-800">Backfill Work Orders</h3>
              <p className="text-sm text-slate-600 mt-0.5">
                Automatisch generierte Nachproduktions-WOs mit Equipment-Zuordnung und Chargenberechnung
              </p>
            </div>
            <button
              onClick={() => void exportBackfillPlanExcel(backfillPlan, data.productionPlan?.week ?? "KW??")}
              className="btn btn-primary text-xs shrink-0"
            >
              Excel Export
            </button>
          </div>

          <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
            {[
              { label: "WOs", value: backfillPlan.proposals.length, color: "text-rose-700" },
              { label: "Chargen", value: backfillPlan.totalBatches, color: "text-rose-700" },
              { label: "Gesamt kg", value: `${fmt(backfillPlan.totalKg, 1)}`, color: "text-rose-700" },
              { label: "Portionen", value: `${fmt(backfillPlan.totalPortions)}`, color: "text-rose-700" },
              { label: "Kritisch", value: backfillPlan.criticalCount, color: "text-red-700" },
            ].map(s => (
              <div key={s.label} className="bg-white rounded-lg p-2 ring-1 ring-rose-200 text-center">
                <div className="text-rose-700 uppercase font-bold">{s.label}</div>
                <div className={`text-lg font-bold font-mono ${s.color}`}>{s.value}</div>
              </div>
            ))}
          </div>

          <div className="mt-4 overflow-hidden rounded-xl ring-1 ring-rose-200">
            <div className="max-h-[400px] overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-rose-100 text-[10px] uppercase tracking-wide text-rose-800">
                  <tr>
                    <th className="px-3 py-2 text-left">Backfill-WO</th>
                    <th className="px-3 py-2 text-left">Sub-Rezept</th>
                    <th className="px-3 py-2 text-left">Equipment</th>
                    <th className="px-3 py-2 text-right">Kapazität</th>
                    <th className="px-3 py-2 text-right">Chargen</th>
                    <th className="px-3 py-2 text-right">Fehlt</th>
                    <th className="px-3 py-2 text-right">Produziert</th>
                    <th className="px-3 py-2 text-right">Überschuss</th>
                    <th className="px-3 py-2 text-center">Prio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rose-100 bg-white">
                  {backfillPlan.proposals.map(p => (
                    <tr key={p.backfillWoNumber} className={p.priority === "critical" ? "bg-red-50/50" : ""}>
                      <td className="px-3 py-2">
                        <div className="font-mono font-bold">{p.backfillWoNumber}</div>
                        <div className="text-[10px] text-slate-400">← {p.originalWo}</div>
                      </td>
                      <td className="px-3 py-2 font-medium truncate max-w-[180px]" title={p.subRecipe}>{p.subRecipe}</td>
                      <td className="px-3 py-2">
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-bold text-[10px]">{p.equipment}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(p.capacityKg, 0)} kg</td>
                      <td className="px-3 py-2 text-right font-mono font-bold">{p.batchCount}×</td>
                      <td className="px-3 py-2 text-right font-mono text-red-700">{fmt(p.missingKg, 1)} kg</td>
                      <td className="px-3 py-2 text-right font-mono text-indigo-700">{fmt(p.totalProducedKg, 1)} kg</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-700">+{fmt(p.excessKg, 1)} kg</td>
                      <td className="px-3 py-2 text-center"><PriorityBadge priority={p.priority} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══ LIVE FEED ═══════════════════════════════════════════════════════ */}
      {postblastMonitor.data && postblastMonitor.data.entries.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h3 className="text-lg font-bold text-slate-800">
              Letzte Wiegungen
              {liveFeedToday && todayEntries.length > 0 && (
                <span className="ml-2 text-sm font-normal text-slate-500">({todayEntries.length} heute)</span>
              )}
            </h3>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Heute-Toggle */}
              <button
                onClick={() => setLiveFeedToday(t => !t)}
                className={`text-xs px-2.5 py-1 rounded-full ring-1 font-medium transition ${
                  liveFeedToday
                    ? "bg-teal-100 ring-teal-300 text-teal-800"
                    : "bg-white ring-slate-200 text-slate-500"
                }`}
              >
                {liveFeedToday ? "Nur heute ✓" : "Nur heute"}
              </button>
              {/* Suche */}
              <input
                type="text"
                value={liveFeedSearch}
                onChange={e => setLiveFeedSearch(e.target.value)}
                placeholder="WO / Sub-Rezept suchen…"
                className="text-xs px-2.5 py-1 rounded-full border border-slate-300 bg-white focus:outline-none focus:ring-1 focus:ring-teal-400 w-44"
              />
              {liveFeedSearch && (
                <button onClick={() => setLiveFeedSearch("")} className="text-xs text-slate-400 hover:text-slate-600">✕</button>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
            <div className="max-h-72 overflow-auto">
              {liveEntries.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400">
                  {liveFeedToday ? "Heute noch keine Wiegungen." : "Keine Einträge gefunden."}
                </div>
              ) : (
                <table className="min-w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100 text-[10px] uppercase tracking-wide text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">Zeitpunkt</th>
                      <th className="px-3 py-2 text-left">WO</th>
                      <th className="px-3 py-2 text-left">Sub-Rezept</th>
                      <th className="px-3 py-2 text-right">Gewicht (kg)</th>
                      <th className="px-3 py-2 text-left">Sub-Sub</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {liveEntries.map((e, idx) => (
                      <tr key={idx} className={idx === 0 ? "bg-emerald-50" : ""}>
                        <td className="px-3 py-2 font-mono text-slate-500">{e.timestamp}</td>
                        <td className="px-3 py-2 font-mono font-bold">{e.workOrder}</td>
                        <td className="px-3 py-2 font-medium">{e.subRecipeName}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-indigo-700">{fmt(e.rawWeightKg, 2)} kg</td>
                        <td className="px-3 py-2 text-slate-500">{e.subSubRecipe || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══ EMPTY STATES ════════════════════════════════════════════════════ */}
      {!postblastMonitor.data && !postblastMonitor.error && (
        <div className="card p-8 text-center text-slate-500">
          <div className="text-2xl mb-2">⏳</div>
          <div className="font-bold">Lade Postblast-Daten…</div>
          <div className="text-sm mt-1">Polling startet automatisch (alle 30 Sekunden)</div>
        </div>
      )}

      {!data.productionPlan && postblastMonitor.data && (
        <div className="card p-4 bg-amber-50 border border-amber-300 text-amber-900">
          <strong>Kein Produktionsplan geladen.</strong> Work-Order-Matching nicht möglich.
          Bitte <code>npm run import:local</code> mit aktuellem Transparency-Sheet ausführen.
        </div>
      )}
    </div>
  );
}
