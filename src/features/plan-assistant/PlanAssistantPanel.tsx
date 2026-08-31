import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../../app/AppContext";
import { useWoReconciliation } from "../wo-reconciliation/WoReconciliationContext";
import { useBackfillsOptional } from "../backfills/BackfillsContext";
import { runPlanAgent, type AgentStep, type GeminiContent } from "./planAssistantAgent";
import { applyDayPlatingMoves, applyPlanChanges, applyPlatingWeekPlan, undoPlanChanges } from "./planAssistantApi";
import { buildPlatingPlanWithMoves } from "./planAssistantTools";
import { subscribePlatingWeekPlan } from "../plating-plan/platingWeekPlanFirestore";
import type { PlatingWeekPlan } from "../plating-plan/platingPlanTypes";
import type {
  ChatMessage, ChatStep, DayPlatingProposal, PlanIssue, PlanProposal, PlatingProposal,
} from "./planAssistantTypes";

const STORE_KEY = "rezeptlogik-plan-assistant-v1";
const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `m${Date.now()}${Math.random()}`);

const SUGGESTIONS = [
  "Erstell den Wochen-Plating-Plan für diese KW.",
  "Prüf den Plan auf Risiken und Engpässe.",
  "Welche Meals sind diese KW noch ungeplant — und wo würdest du sie hinlegen?",
  "Was muss nachproduziert werden und reicht die Rohware?",
];

const SEV_STYLE: Record<PlanIssue["severity"], string> = {
  critical: "border-rose-300 bg-rose-50 text-rose-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  info: "border-sky-300 bg-sky-50 text-sky-800",
};

const TOOL_LABEL: Record<string, string> = {
  get_recipe_detail: "Rezept-Details",
  get_backfill_detail: "Backfill-Details",
  get_wo_trace: "WO-Abgleich",
  simulate_plan_change: "Änderung simuliert",
  suggest_assignments: "Auto-Vorschlag",
  get_capacity_overview: "Kapazitäts-Check",
  get_plating_plan: "Plating-Plan gelesen",
  generate_plating_plan: "Plating-Plan generiert",
  simulate_plating_change: "Plating simuliert",
  get_day_plating_plan: "Tages-Linienplan gelesen",
  generate_day_plating_plan: "Tages-Linienpläne generiert",
  simulate_day_plating_change: "Tagesplan-Umsortierung simuliert",
  __thinking__: "Zwischenüberlegung",
};

interface Persisted { messages: ChatMessage[]; contents: GeminiContent[] }
function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { const p = JSON.parse(raw) as Persisted; if (Array.isArray(p.messages)) return { messages: p.messages, contents: p.contents ?? [] }; }
  } catch { /* ignore */ }
  return { messages: [], contents: [] };
}

function StepList({ steps }: { steps: ChatStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="mb-1.5 space-y-0.5">
      {steps.map((s, i) => (
        <div key={i} className={`flex items-start gap-1 text-[10px] ${s.ok ? "text-slate-500" : "text-rose-600"}`}>
          <span aria-hidden>{s.tool === "__thinking__" ? "💭" : "🔧"}</span>
          <span><span className="font-semibold">{TOOL_LABEL[s.tool] ?? s.tool}</span>{s.summary ? ` · ${s.summary}` : ""}</span>
        </div>
      ))}
    </div>
  );
}

function IssueList({ issues }: { issues: PlanIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {issues.map((it, i) => (
        <div key={i} className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${SEV_STYLE[it.severity] ?? SEV_STYLE.info}`}>
          <div className="text-[9px] font-semibold uppercase tracking-wide opacity-70">{it.severity}</div>
          <div className="mt-0.5">{it.description}</div>
          {it.affectedRecipes?.length ? <div className="mt-0.5 font-mono opacity-80">{it.affectedRecipes.join(", ")}</div> : null}
          {it.suggestion ? <div className="mt-0.5 italic opacity-90">→ {it.suggestion}</div> : null}
        </div>
      ))}
    </div>
  );
}

function ProposalCard({ proposal, onApply, onUndo }: {
  proposal: PlanProposal;
  onApply: (newScenario: boolean) => void;
  onUndo: () => void;
}) {
  return (
    <div className="mt-2 rounded-lg border border-violet-300 bg-violet-50 p-2.5 text-[11px] text-violet-900">
      <div className="font-semibold">Planänderungs-Vorschlag</div>
      {proposal.summary ? <div className="mt-0.5 whitespace-pre-wrap">{proposal.summary}</div> : null}
      <ul className="mt-1.5 space-y-1">
        {proposal.changes.map((c, i) => {
          const r = proposal.results?.[i];
          return (
            <li key={i} className="rounded border border-violet-200 bg-white px-2 py-1">
              <span className="font-mono font-semibold">{c.recipeCode}</span>
              {c.subRecipeId ? <span className="font-mono opacity-70"> · {c.subRecipeId}</span> : null}
              {" → "}<strong>{c.day}/{c.shift}</strong>
              {c.targetPortions ? ` @${c.targetPortions}` : ""}
              {c.splitSpec ? ` · Split ${c.splitSpec}` : ""}
              <div className="opacity-80">{c.reason}</div>
              {r ? <div className={r.ok ? "text-emerald-700" : "text-rose-700"}>{r.ok ? "✓ " : "✗ "}{r.detail}</div> : null}
            </li>
          );
        })}
      </ul>
      {proposal.applied ? (
        <div className="mt-1.5 flex items-center justify-between">
          <span className="font-semibold text-emerald-700">
            ✓ Übernommen{proposal.appliedToNewScenario ? ` → Szenario „${proposal.appliedToNewScenario}"` : ""} · im Cockpit sichtbar
          </span>
          {proposal.undoSnapshot ? (
            <button type="button" onClick={onUndo} className="rounded border border-slate-300 px-2 py-0.5 text-[10px] text-slate-600 hover:bg-slate-100">
              Rückgängig
            </button>
          ) : null}
        </div>
      ) : proposal.applyError ? (
        <div className="mt-1.5 font-semibold text-rose-700">{proposal.applyError}</div>
      ) : (
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => onApply(false)} className="rounded-md bg-violet-600 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-500">
            Übernehmen
          </button>
          <button type="button" onClick={() => onApply(true)} className="rounded-md border border-violet-400 px-3 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-100">
            In neues Szenario
          </button>
        </div>
      )}
    </div>
  );
}

function PlatingProposalCard({ proposal, onApply }: { proposal: PlatingProposal; onApply: () => void }) {
  return (
    <div className="mt-2 rounded-lg border border-cyan-300 bg-cyan-50 p-2.5 text-[11px] text-cyan-900">
      <div className="font-semibold">Wochen-Plating-Plan-Vorschlag</div>
      <div className="mt-0.5">First Run {Math.round((proposal.firstRunPct ?? 0.7) * 100)}%{proposal.moves.length ? ` · ${proposal.moves.length} Tag-Anpassung(en)` : " · Auto-Verteilung"}{proposal.regenerateDailyPlans ? " · + tägliche Linienpläne" : ""}</div>
      {proposal.summary ? <div className="mt-0.5 whitespace-pre-wrap">{proposal.summary}</div> : null}
      {proposal.moves.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {proposal.moves.map((mv, i) => (
            <li key={i} className="font-mono">{mv.code} · R{mv.runIndex} → <strong>{mv.day}</strong></li>
          ))}
        </ul>
      )}
      {proposal.applied ? (
        <div className="mt-1.5 font-semibold text-emerald-700">✓ Gespeichert — in „Plating-Plan" sichtbar.</div>
      ) : proposal.applyError ? (
        <div className="mt-1.5 font-semibold text-rose-700">{proposal.applyError}</div>
      ) : (
        <button type="button" onClick={onApply} className="mt-2 rounded-md bg-cyan-600 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-500">
          Plating-Plan speichern
        </button>
      )}
    </div>
  );
}

function DayPlatingProposalCard({ proposal, onApply }: { proposal: DayPlatingProposal; onApply: () => void }) {
  return (
    <div className="mt-2 rounded-lg border border-cyan-300 bg-cyan-50 p-2.5 text-[11px] text-cyan-900">
      <div className="font-semibold">Tages-Linienplan umsortieren · {proposal.day}</div>
      {proposal.summary ? <div className="mt-0.5 whitespace-pre-wrap">{proposal.summary}</div> : null}
      {proposal.moves.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {proposal.moves.map((mv, i) => (
            <li key={i} className="font-mono">
              {mv.code}{mv.runIndex ? ` R${mv.runIndex}` : ""} → <strong>L{mv.toLine}</strong>
              {mv.toIndex != null ? ` @${mv.toIndex}` : ""}
            </li>
          ))}
        </ul>
      )}
      {proposal.applied ? (
        <div className="mt-1.5 font-semibold text-emerald-700">✓ Gespeichert — in „Plating Tag" sichtbar.</div>
      ) : proposal.applyError ? (
        <div className="mt-1.5 font-semibold text-rose-700">{proposal.applyError}</div>
      ) : (
        <button type="button" onClick={onApply} className="mt-2 rounded-md bg-cyan-600 px-3 py-1 text-xs font-semibold text-white hover:bg-cyan-500">
          Umsortierung speichern
        </button>
      )}
    </div>
  );
}

export function PlanAssistantPanel({ onClose }: { onClose: () => void }) {
  const { data, selectedWeek, upliftPercent } = useAppState();
  const reconciliation = useWoReconciliation();
  const backfills = useBackfillsOptional();

  const [{ messages, contents }, setState] = useState<Persisted>(load);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<"flash" | "pro">("flash");
  const [platingPlan, setPlatingPlan] = useState<PlatingWeekPlan | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribePlatingWeekPlan(selectedWeek, setPlatingPlan), [selectedWeek]);

  const setMessages = useCallback((fn: (m: ChatMessage[]) => ChatMessage[]) => {
    setState(prev => ({ ...prev, messages: fn(prev.messages) }));
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ messages, contents })); } catch { /* quota */ }
  }, [messages, contents]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || busy || !data) return;
    setInput("");
    setBusy(true);

    const pendingId = uid();
    setState(prev => ({
      ...prev,
      messages: [
        ...prev.messages,
        { id: uid(), role: "user", content: q },
        { id: pendingId, role: "assistant", content: "", pending: true, steps: [] },
      ],
    }));

    const liveSteps: ChatStep[] = [];
    const outcome = await runPlanAgent({
      data, week: selectedWeek, upliftPercent, reconciliation, backfills, platingPlan,
      priorContents: contents, userMessage: q, model,
      onStep: (s: AgentStep | { tool: "__thinking__"; args: Record<string, unknown>; ok: true; summary: string }) => {
        liveSteps.push({ tool: s.tool, summary: s.summary, ok: s.ok });
        setMessages(ms => ms.map(m => m.id === pendingId ? { ...m, steps: [...liveSteps] } : m));
      },
    });

    setState(prev => ({
      contents: outcome.error ? prev.contents : outcome.contents,
      messages: prev.messages.map(m => m.id === pendingId ? {
        ...m,
        pending: false,
        content: outcome.error ? `⚠ ${outcome.error}` : (outcome.text || "(keine Antwort)"),
        steps: liveSteps,
        issues: outcome.issues,
        proposal: outcome.proposal,
        platingProposal: outcome.platingProposal,
        dayPlatingProposal: outcome.dayPlatingProposal,
      } : m),
    }));
    setBusy(false);
  }, [busy, data, selectedWeek, upliftPercent, reconciliation, backfills, platingPlan, contents, model, setMessages]);

  const applyPlating = useCallback((msgId: string) => {
    const msg = messages.find(m => m.id === msgId);
    if (!data || !msg?.platingProposal) return;
    const pp = msg.platingProposal;
    const plan = buildPlatingPlanWithMoves(data, selectedWeek, pp.firstRunPct, pp.moves, pp.notes, platingPlan, pp.regenerateDailyPlans);
    void applyPlatingWeekPlan(plan).then(res => {
      setMessages(ms => ms.map(m => m.id === msgId && m.platingProposal
        ? { ...m, platingProposal: { ...m.platingProposal, applied: res.ok, applyError: res.error } }
        : m));
    });
  }, [messages, data, selectedWeek, platingPlan, setMessages]);

  const applyDayPlating = useCallback((msgId: string) => {
    const msg = messages.find(m => m.id === msgId);
    if (!msg?.dayPlatingProposal || !platingPlan) return;
    const dp = msg.dayPlatingProposal;
    void applyDayPlatingMoves(platingPlan, dp.day, dp.moves).then(res => {
      setMessages(ms => ms.map(m => m.id === msgId && m.dayPlatingProposal
        ? { ...m, dayPlatingProposal: { ...m.dayPlatingProposal, applied: res.ok, applyError: res.error } }
        : m));
    });
  }, [messages, platingPlan, setMessages]);

  const applyProposal = useCallback((msgId: string, newScenario: boolean) => {
    if (!data) return;
    setMessages(ms => ms.map(m => {
      if (m.id !== msgId || !m.proposal) return m;
      const name = newScenario ? `KI ${new Date().toLocaleDateString("de-DE")}` : undefined;
      const res = applyPlanChanges(m.proposal.changes, data, selectedWeek, { newScenarioName: name });
      return {
        ...m,
        proposal: {
          ...m.proposal,
          applied: res.ok,
          applyError: res.error,
          results: res.results,
          undoSnapshot: res.undoSnapshot,
          appliedToNewScenario: res.ok ? res.scenarioName : undefined,
        },
      };
    }));
  }, [data, selectedWeek, setMessages]);

  const undoProposal = useCallback((msgId: string) => {
    setMessages(ms => ms.map(m => {
      if (m.id !== msgId || !m.proposal?.undoSnapshot) return m;
      undoPlanChanges(m.proposal.undoSnapshot);
      return { ...m, proposal: { ...m.proposal, applied: false, results: undefined, appliedToNewScenario: undefined } };
    }));
  }, [setMessages]);

  const clearChat = useCallback(() => {
    setState({ messages: [], contents: [] });
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  }, []);

  const empty = messages.length === 0;
  const sources = useMemo(() => {
    const s = ["Wochenplan", "Board-Analyse"];
    if (data?.productionPlan?.rows?.length) s.push("Production Plan");
    if (reconciliation?.bySeverityRecipe.size) s.push("WO-Abgleich");
    if (backfills?.combined.length) s.push("Backfills");
    return s;
  }, [data, reconciliation, backfills]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/20" onClick={onClose} />
      <div className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[460px] flex-col border-l border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <span aria-hidden>🤖</span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-slate-900">Frag den Plan</div>
            <div className="truncate text-[10px] text-slate-400">KW {selectedWeek} · {sources.join(" · ")}</div>
          </div>
          <select
            value={model}
            onChange={e => setModel(e.target.value as "flash" | "pro")}
            className="rounded border border-slate-300 px-1.5 py-1 text-[10px] text-slate-600"
            title="Flash = schnell, Pro = gründlicher"
          >
            <option value="flash">Flash</option>
            <option value="pro">Pro</option>
          </select>
          {!empty && (
            <button type="button" onClick={clearChat} className="rounded p-1 text-[10px] text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Verlauf löschen">
              ⟲
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Schließen">✕</button>
        </div>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {empty && (
            <div className="text-xs text-slate-500">
              <p>Fragt frei über den Plan, die WO-Abgleiche, den Backfill-Bedarf und die Stations-Auslastung. Der Assistent lädt sich Details selbst nach, simuliert Änderungen vor dem Vorschlag und ändert nie ohne Bestätigung.</p>
              <div className="mt-3 space-y-1.5">
                {SUGGESTIONS.map(s => (
                  <button key={s} type="button" onClick={() => void send(s)}
                    className="block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-left text-[11px] text-slate-600 hover:border-emerald-300 hover:bg-verden-50">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(m => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              <div className={`max-w-[92%] rounded-2xl px-3 py-2 text-xs ${m.role === "user" ? "bg-verden-600 text-white" : "bg-slate-100 text-slate-800"}`}>
                {m.role === "assistant" && m.steps?.length ? <StepList steps={m.steps} /> : null}
                {m.pending && !m.content ? (
                  <span className="inline-flex items-center gap-1 text-slate-500">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "0ms" }} />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "120ms" }} />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "240ms" }} />
                  </span>
                ) : (
                  <div className="whitespace-pre-wrap">{m.content}</div>
                )}
                {m.issues ? <IssueList issues={m.issues} /> : null}
                {m.proposal ? (
                  <ProposalCard
                    proposal={m.proposal}
                    onApply={(newScenario) => applyProposal(m.id, newScenario)}
                    onUndo={() => undoProposal(m.id)}
                  />
                ) : null}
                {m.platingProposal ? (
                  <PlatingProposalCard proposal={m.platingProposal} onApply={() => applyPlating(m.id)} />
                ) : null}
                {m.dayPlatingProposal ? (
                  <DayPlatingProposalCard proposal={m.dayPlatingProposal} onApply={() => applyDayPlating(m.id)} />
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <form className="border-t border-slate-200 p-3" onSubmit={e => { e.preventDefault(); void send(input); }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            rows={2}
            placeholder="Frage zum Plan…  (Enter = senden)"
            className="w-full resize-none rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-emerald-400 focus:outline-none"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-slate-400">Gemini · liest den Live-Kontext, ändert nie ohne Bestätigung</span>
            <button type="submit" disabled={busy || !input.trim()}
              className="rounded-lg bg-verden-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-verden-500 disabled:opacity-40">
              {busy ? "…" : "Senden"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
