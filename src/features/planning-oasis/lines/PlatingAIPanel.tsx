// Plating-KI-Panel: Chat-UI spezialisiert auf Linienplanung, Allergen-Optimierung.
import { useEffect, useRef, useState } from "react";
import { type PlatingAIMessage, type PlatingMove, type PlatingSequenceChange, type PlatingIssue, callPlatingAI } from "./platingAI";

function msgId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function MovesCard({
  moves, summary, accepted, rejected, onAccept, onReject,
}: {
  moves: PlatingMove[]; summary: string;
  accepted?: boolean; rejected?: boolean;
  onAccept: () => void; onReject: () => void;
}) {
  return (
    <div className="mt-2 rounded-xl border border-cyan-200 bg-cyan-50 overflow-hidden">
      <div className="px-3 py-2 bg-cyan-100 border-b border-cyan-200">
        <div className="text-xs font-semibold text-cyan-800">Plating-Vorschlag</div>
        <div className="text-[11px] text-cyan-700 mt-0.5">{summary}</div>
      </div>
      <div className="divide-y divide-cyan-100">
        {moves.map((m, i) => (
          <div key={i} className="px-3 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-slate-700">{m.recipeCode}</span>
              <span className="text-slate-400">L{m.fromLine + 1}/{m.fromSlot}</span>
              <span className="text-cyan-600 font-bold">→</span>
              <span className="font-semibold text-cyan-800">L{m.toLine + 1}/{m.toSlot}</span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5 italic">{m.reason}</div>
          </div>
        ))}
      </div>
      {!accepted && !rejected ? (
        <div className="flex gap-2 px-3 py-2 border-t border-cyan-200">
          <button className="flex-1 rounded-lg bg-cyan-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-800" onClick={onAccept}>Anwenden</button>
          <button className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={onReject}>Ablehnen</button>
        </div>
      ) : (
        <div className={`px-3 py-2 border-t text-xs font-semibold ${accepted ? "border-cyan-200 text-cyan-700 bg-cyan-100" : "border-slate-200 text-slate-500 bg-slate-50"}`}>
          {accepted ? "✓ Angewendet" : "✕ Abgelehnt"}
        </div>
      )}
    </div>
  );
}

function SequenceCard({
  changes, summary, accepted, rejected, onAccept, onReject,
}: {
  changes: PlatingSequenceChange[]; summary: string;
  accepted?: boolean; rejected?: boolean;
  onAccept: () => void; onReject: () => void;
}) {
  return (
    <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 overflow-hidden">
      <div className="px-3 py-2 bg-emerald-100 border-b border-emerald-200">
        <div className="text-xs font-semibold text-emerald-800">Reihenfolge-Optimierung</div>
        <div className="text-[11px] text-emerald-700 mt-0.5">{summary}</div>
      </div>
      <div className="divide-y divide-emerald-100">
        {changes.map((c, i) => (
          <div key={i} className="px-3 py-1.5 text-xs">
            <div className="font-semibold text-emerald-800">{c.day} · Linie {c.line + 1}</div>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {c.newOrder.map((code, j) => (
                <span key={j} className="rounded bg-white px-1.5 py-0.5 text-[10px] font-mono font-bold ring-1 ring-emerald-200">{code}</span>
              ))}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5 italic">{c.reason}</div>
          </div>
        ))}
      </div>
      {!accepted && !rejected ? (
        <div className="flex gap-2 px-3 py-2 border-t border-emerald-200">
          <button className="flex-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800" onClick={onAccept}>Anwenden</button>
          <button className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={onReject}>Ablehnen</button>
        </div>
      ) : (
        <div className={`px-3 py-2 border-t text-xs font-semibold ${accepted ? "border-emerald-200 text-emerald-700 bg-emerald-100" : "border-slate-200 text-slate-500 bg-slate-50"}`}>
          {accepted ? "✓ Angewendet" : "✕ Abgelehnt"}
        </div>
      )}
    </div>
  );
}

function IssuesCard({ issues }: { issues: PlatingIssue[] }) {
  return (
    <div className="mt-2 rounded-xl border border-amber-200 overflow-hidden">
      <div className="px-3 py-2 bg-amber-50 border-b border-amber-200">
        <div className="text-xs font-semibold text-amber-800">Plating-Analyse</div>
      </div>
      <div className="divide-y divide-slate-100">
        {issues.map((issue, i) => (
          <div key={i} className={`px-3 py-2 text-xs ${issue.severity === "critical" ? "bg-rose-50 text-rose-800" : issue.severity === "warning" ? "bg-amber-50 text-amber-800" : "bg-sky-50 text-sky-800"}`}>
            <div className="flex items-start gap-2">
              <span className="shrink-0 text-[10px] font-bold">{issue.severity === "critical" ? "⛔" : issue.severity === "warning" ? "⚠" : "ℹ"}</span>
              <span className="flex-1">{issue.description}</span>
            </div>
            {issue.suggestion && <div className="mt-1 rounded bg-white/60 px-2 py-1 text-[10px]">💡 {issue.suggestion}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Haupt-Komponente ────────────────────────────────────────────────────────

interface PlatingAIPanelProps {
  isOpen: boolean;
  onClose: () => void;
  planContext: string;
  onApplyMoves: (moves: PlatingMove[]) => void;
  onApplySequence: (changes: PlatingSequenceChange[]) => void;
}

export function PlatingAIPanel({ isOpen, onClose, planContext, onApplyMoves, onApplySequence }: PlatingAIPanelProps) {
  const [messages, setMessages] = useState<PlatingAIMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const contextRef = useRef(planContext);
  contextRef.current = planContext;

  useEffect(() => { if (isOpen) setTimeout(() => inputRef.current?.focus(), 80); }, [isOpen]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setError(null);
    const userMsg: PlatingAIMessage = { id: msgId(), role: "user", text: text.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    const history = messages.map(m => ({ role: m.role as "user" | "assistant", content: m.text || "(Vorschlag)" }));
    try {
      const result = await callPlatingAI(contextRef.current, history, text.trim());
      const assistantMsg: PlatingAIMessage = {
        id: msgId(), role: "assistant",
        text: result.text || "",
        proposedMoves: result.proposedMoves,
        proposedSequence: result.proposedSequence,
        issues: result.issues,
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  }

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-[108] bg-slate-900/20" onClick={onClose} />
      <div className="fixed right-0 top-0 z-[109] flex h-screen w-[460px] max-w-full flex-col bg-white shadow-2xl ring-1 ring-slate-200">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-gradient-to-r from-cyan-700 to-teal-700 px-4 py-3">
          <div>
            <div className="text-sm font-bold text-white">Plating-KI</div>
            <div className="text-[11px] text-cyan-200">Allergen-Optimierung · Linienplanung</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="rounded-lg bg-white/20 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/30"
              onClick={() => send("Analysiere den aktuellen Plating-Plan: Wo gibt es zu viele Allergen-Wechsel? Wo ist die Reihenfolge suboptimal?")}
              disabled={loading}
            >
              Analyse
            </button>
            <button
              className="rounded-lg bg-white/20 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/30"
              onClick={() => send("Optimiere alle Linien für minimale Allergen-Wechsel. Schlage die beste Reihenfolge pro Linie und Tag vor.")}
              disabled={loading}
            >
              Optimieren
            </button>
            <button className="flex h-7 w-7 items-center justify-center rounded-lg text-white/80 hover:bg-white/20 text-lg" onClick={onClose}>×</button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
          {messages.length === 0 && (
            <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-5 text-center text-sm text-slate-500">
              <div className="text-2xl mb-2">🧬</div>
              <div className="font-medium text-slate-700">Plating-Experte für Allergen-Optimierung</div>
              <div className="mt-2 space-y-1 text-left text-[11px] text-slate-500">
                <div className="rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200 cursor-pointer hover:ring-cyan-300" onClick={() => setInput("Optimiere Linie 1 für minimale Allergen-Wechsel")}>„Optimiere Linie 1 für minimale Wechsel"</div>
                <div className="rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200 cursor-pointer hover:ring-cyan-300" onClick={() => setInput("Tausche FV0713A und FV0472A auf Linie 2")}>„Tausche FV0713A und FV0472A auf Linie 2"</div>
                <div className="rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200 cursor-pointer hover:ring-cyan-300" onClick={() => send("Prüfe den Plan auf Allergen-Kollisionen und MHD-Verstöße")}>„Allergen-Kollisionen prüfen" →</div>
                <div className="rounded-lg bg-white px-2.5 py-1.5 ring-1 ring-slate-200 cursor-pointer hover:ring-cyan-300" onClick={() => send("Welche Rezepte haben einen Cup? Plane die Cupping-Spalte optimal.")}>„Cup-Rezepte identifizieren & planen" →</div>
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} className={msg.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div className={`max-w-[90%]`}>
                {msg.role === "user" ? (
                  <div className="rounded-2xl rounded-tr-sm bg-cyan-700 px-3 py-2 text-xs text-white">{msg.text}</div>
                ) : (
                  <div>
                    {msg.text && <div className="rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 whitespace-pre-wrap">{msg.text}</div>}
                    {msg.proposedMoves && (
                      <MovesCard
                        moves={msg.proposedMoves.moves} summary={msg.proposedMoves.summary}
                        accepted={msg.accepted} rejected={msg.rejected}
                        onAccept={() => { onApplyMoves(msg.proposedMoves!.moves); setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, accepted: true } : m)); }}
                        onReject={() => setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, rejected: true } : m))}
                      />
                    )}
                    {msg.proposedSequence && (
                      <SequenceCard
                        changes={msg.proposedSequence.changes} summary={msg.proposedSequence.summary}
                        accepted={msg.accepted} rejected={msg.rejected}
                        onAccept={() => { onApplySequence(msg.proposedSequence!.changes); setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, accepted: true } : m)); }}
                        onReject={() => setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, rejected: true } : m))}
                      />
                    )}
                    {msg.issues && msg.issues.length > 0 && <IssuesCard issues={msg.issues} />}
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
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-bounce [animation-delay:300ms]" />
                  </span>
                  Plating-KI analysiert …
                </div>
              </div>
            </div>
          )}
          {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"><strong>Fehler:</strong> {error}</div>}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="shrink-0 border-t border-slate-200 bg-white px-3 py-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef} value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
              placeholder="Frage zur Linienplanung oder Befehl … (Enter = senden)"
              rows={2} disabled={loading}
              className="flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-xs placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
            />
            <button
              className="shrink-0 rounded-xl bg-cyan-700 px-3 py-2.5 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-40"
              onClick={() => void send(input)} disabled={loading || !input.trim()}
            >Senden</button>
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-slate-400">
            <span>Gemini · Plating-Spezialist</span>
            <button className="hover:text-slate-600" onClick={() => setMessages([])} disabled={loading}>Chat leeren</button>
          </div>
        </div>
      </div>
    </>
  );
}
