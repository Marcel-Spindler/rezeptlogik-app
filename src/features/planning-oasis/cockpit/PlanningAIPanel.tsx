// KI-Planungsassistent-Panel: Chat-UI für den Browser-seitigen Claude-Assistent.
import { useEffect, useRef, useState } from "react";
import {
  type AIChatMessage,
  type ProposedAssignmentChange,
  type PlanIssue,
  callPlanningAI,
} from "./planningAI";

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function msgId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function severityStyle(s: PlanIssue["severity"]): string {
  if (s === "critical") return "bg-rose-50 text-rose-800 ring-1 ring-rose-200";
  if (s === "warning") return "bg-amber-50 text-amber-800 ring-1 ring-amber-200";
  return "bg-sky-50 text-sky-800 ring-1 ring-sky-200";
}

function severityLabel(s: PlanIssue["severity"]): string {
  if (s === "critical") return "⛔ Kritisch";
  if (s === "warning") return "⚠ Warnung";
  return "ℹ Info";
}

// ─── Proposed-Changes-Karte ───────────────────────────────────────────────────

function ProposedChangesCard({
  proposedChanges,
  accepted,
  rejected,
  onAccept,
  onReject,
}: {
  proposedChanges: { changes: ProposedAssignmentChange[]; summary: string };
  accepted?: boolean;
  rejected?: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 overflow-hidden">
      <div className="px-3 py-2 bg-emerald-100 border-b border-emerald-200">
        <div className="text-xs font-semibold text-emerald-800">Planvorschlag</div>
        <div className="text-[11px] text-emerald-700 mt-0.5">{proposedChanges.summary}</div>
      </div>
      <div className="divide-y divide-emerald-100">
        {proposedChanges.changes.map((c, i) => (
          <div key={i} className="px-3 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-slate-700">{c.recipeCode}</span>
              {c.subRecipeId && (
                <span className="text-[10px] text-slate-500">Sub: {c.subRecipeId}</span>
              )}
              <span className="text-slate-400">→</span>
              <span className="font-semibold text-emerald-800">{c.day} / {c.shift}</span>
              {c.targetPortions != null && (
                <span className="text-slate-500">{c.targetPortions.toLocaleString("de-DE")} Ptn.</span>
              )}
            </div>
            {c.splitSpec && (
              <div className="text-[10px] text-slate-500 mt-0.5">Split: {c.splitSpec}</div>
            )}
            <div className="text-[10px] text-slate-500 mt-0.5 italic">{c.reason}</div>
          </div>
        ))}
      </div>
      {!accepted && !rejected ? (
        <div className="flex gap-2 px-3 py-2 border-t border-emerald-200">
          <button
            className="flex-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 transition-colors"
            onClick={onAccept}
          >
            Anwenden
          </button>
          <button
            className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            onClick={onReject}
          >
            Ablehnen
          </button>
        </div>
      ) : (
        <div className={`px-3 py-2 border-t text-xs font-semibold ${accepted ? "border-emerald-200 text-emerald-700 bg-emerald-100" : "border-slate-200 text-slate-500 bg-slate-50"}`}>
          {accepted ? "✓ Angewendet" : "✕ Abgelehnt"}
        </div>
      )}
    </div>
  );
}

// ─── Issues-Karte ─────────────────────────────────────────────────────────────

function IssuesCard({ issues }: { issues: PlanIssue[] }) {
  return (
    <div className="mt-2 rounded-xl border border-amber-200 overflow-hidden">
      <div className="px-3 py-2 bg-amber-50 border-b border-amber-200">
        <div className="text-xs font-semibold text-amber-800">Plan-Analyse</div>
      </div>
      <div className="divide-y divide-slate-100">
        {issues.map((issue, i) => (
          <div key={i} className={`px-3 py-2 text-xs ${severityStyle(issue.severity)}`}>
            <div className="flex items-start gap-2">
              <span className="shrink-0 text-[10px] font-bold">{severityLabel(issue.severity)}</span>
              <span className="flex-1">{issue.description}</span>
            </div>
            {issue.affectedRecipes && issue.affectedRecipes.length > 0 && (
              <div className="mt-0.5 text-[10px] opacity-75">
                Betrifft: {issue.affectedRecipes.join(", ")}
              </div>
            )}
            {issue.suggestion && (
              <div className="mt-1 rounded bg-white/60 px-2 py-1 text-[10px]">
                💡 {issue.suggestion}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Haupt-Komponente ─────────────────────────────────────────────────────────

interface PlanningAIPanelProps {
  isOpen: boolean;
  onClose: () => void;
  planContext: string;
  recipeLookup: Record<string, string>;
  onApplyChanges: (changes: ProposedAssignmentChange[]) => void;
}

export function PlanningAIPanel({
  isOpen,
  onClose,
  planContext,
  recipeLookup: _recipeLookup,
  onApplyChanges,
}: PlanningAIPanelProps) {
  const [messages, setMessages] = useState<AIChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const contextRef = useRef(planContext);
  contextRef.current = planContext;

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 80);
  }, [isOpen]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setError(null);
    const userMsg: AIChatMessage = { id: msgId(), role: "user", text: text.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    const history = messages.map(m => ({
      role: m.role as "user" | "assistant",
      content: m.text || "(Planvorschlag / Analyse)",
    }));

    try {
      const result = await callPlanningAI(contextRef.current, history, text.trim());
      const assistantMsg: AIChatMessage = {
        id: msgId(),
        role: "assistant",
        text: result.text || (result.proposedChanges ? "" : "(Keine Antwort)"),
        proposedChanges: result.proposedChanges,
        issues: result.issues,
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleAccept(msgId_: string, changes: ProposedAssignmentChange[]) {
    onApplyChanges(changes);
    setMessages(prev =>
      prev.map(m => (m.id === msgId_ ? { ...m, accepted: true } : m)),
    );
  }

  function handleReject(msgId_: string) {
    setMessages(prev =>
      prev.map(m => (m.id === msgId_ ? { ...m, rejected: true } : m)),
    );
  }

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop (klickbar zum Schließen) */}
      <div
        className="fixed inset-0 z-[108] bg-slate-900/20"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 z-[109] flex h-screen w-[440px] max-w-full flex-col bg-white shadow-2xl ring-1 ring-slate-200">

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-gradient-to-r from-violet-700 to-indigo-700 px-4 py-3">
          <div>
            <div className="text-sm font-bold text-white">KI-Planungsassistent</div>
            <div className="text-[11px] text-violet-200">Gemini · Verden Wochenplanung</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="rounded-lg bg-white/20 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/30 transition-colors"
              onClick={() => send("Bitte analysiere den aktuellen Plan auf Probleme, Risiken und Verbesserungspotenziale.")}
              disabled={loading}
              title="KI prüft den Plan auf Konflikte und Risiken"
            >
              Probleme prüfen
            </button>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-lg text-white/80 hover:bg-white/20 transition-colors text-lg leading-none"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </div>

        {/* Nachrichten */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
          {messages.length === 0 && (
            <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-5 text-center text-sm text-slate-500">
              <div className="text-2xl mb-2">🤖</div>
              <div className="font-medium text-slate-700">Ich kenne den kompletten Planstand.</div>
              <div className="mt-1 text-xs">
                Stell mir eine Frage oder beschreib was umgeplant werden soll — z.B.
              </div>
              <div className="mt-2 space-y-1 text-left text-[11px] text-slate-500">
                <div className="rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200 cursor-pointer hover:ring-violet-300 transition-all" onClick={() => setInput("Warum steht FE1234A auf Donnerstag?")}>„Warum steht FE1234A auf Donnerstag?"</div>
                <div className="rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200 cursor-pointer hover:ring-violet-300 transition-all" onClick={() => setInput("Verschiebe alle ungeplanten Rezepte auf Montag, Subs 1 Tag davor.")}>„Verschiebe alle ungeplanten Rezepte auf Montag"</div>
                <div className="rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200 cursor-pointer hover:ring-violet-300 transition-all" onClick={() => send("Bitte analysiere den aktuellen Plan auf Probleme, Risiken und Verbesserungspotenziale.")}>„Plan auf Probleme prüfen" →</div>
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} className={msg.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div className={`max-w-[90%] ${msg.role === "user" ? "order-2" : "order-1"}`}>
                {msg.role === "user" ? (
                  <div className="rounded-2xl rounded-tr-sm bg-violet-700 px-3 py-2 text-xs text-white">
                    {msg.text}
                  </div>
                ) : (
                  <div>
                    {msg.text && (
                      <div className="rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 whitespace-pre-wrap">
                        {msg.text}
                      </div>
                    )}
                    {msg.proposedChanges && (
                      <ProposedChangesCard
                        proposedChanges={msg.proposedChanges}
                        accepted={msg.accepted}
                        rejected={msg.rejected}
                        onAccept={() => handleAccept(msg.id, msg.proposedChanges!.changes)}
                        onReject={() => handleReject(msg.id)}
                      />
                    )}
                    {msg.issues && msg.issues.length > 0 && (
                      <IssuesCard issues={msg.issues} />
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-4 py-3">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="inline-flex gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-violet-500 animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-violet-500 animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-violet-500 animate-bounce [animation-delay:300ms]" />
                  </span>
                  KI denkt nach …
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              <strong>Fehler:</strong> {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="shrink-0 border-t border-slate-200 bg-white px-3 py-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="Schreib eine Frage oder einen Befehl … (Enter = senden, Shift+Enter = Zeile)"
              rows={2}
              disabled={loading}
              className="flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-xs placeholder:text-slate-400 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400 disabled:opacity-50"
            />
            <button
              className="shrink-0 rounded-xl bg-violet-700 px-3 py-2.5 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-40 transition-colors"
              onClick={() => void send(input)}
              disabled={loading || !input.trim()}
            >
              Senden
            </button>
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-slate-400">
            <span>Gemini · gemini-2.5-flash</span>
            <button
              className="hover:text-slate-600 transition-colors"
              onClick={() => setMessages([])}
              disabled={loading}
            >
              Chat leeren
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
