import { useRef, useState } from "react";

type State = "idle" | "running" | "done" | "error";

export function DeployButton() {
  const [state, setState] = useState<State>("idle");
  const [log, setLog] = useState("");
  const [showLog, setShowLog] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function handleDeploy() {
    if (state === "running") return;
    setState("running");
    setLog("");
    setShowLog(true);
    abortRef.current = new AbortController();
    try {
      const res = await fetch("/api/deploy", { method: "POST", signal: abortRef.current.signal });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("Kein Stream");
      let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        full += chunk;
        setLog(full);
        if (chunk.includes("__DONE:0__")) { setState("done"); break; }
        if (chunk.includes("__DONE:")) { setState("error"); break; }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") { setState("error"); setLog(l => l + `\nFehler: ${String(e)}`); }
    }
  }

  const label = state === "running" ? "Deploying…" : state === "done" ? "Deployed ✓" : state === "error" ? "Fehler ✗" : "Deploy";
  const cls = state === "running" ? "bg-amber-50 border-amber-300 text-amber-800" :
    state === "done" ? "bg-green-50 border-green-300 text-green-800" :
    state === "error" ? "bg-red-50 border-red-300 text-red-800" :
    "bg-cyan-50 border-cyan-300 text-cyan-800 hover:bg-cyan-100";

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => void handleDeploy()}
          disabled={state === "running"}
          className={`btn border text-xs px-2 py-0.5 ${cls} disabled:opacity-60`}
        >
          {label}
        </button>
        {(state === "running" || state === "done" || state === "error") && (
          <button
            type="button"
            onClick={() => setShowLog(v => !v)}
            className="text-[10px] text-slate-400 hover:text-slate-700 underline"
          >
            {showLog ? "Log ▲" : "Log ▼"}
          </button>
        )}
        {state !== "idle" && (
          <button
            type="button"
            onClick={() => { setState("idle"); setLog(""); setShowLog(false); abortRef.current?.abort(); }}
            className="text-[10px] text-slate-400 hover:text-slate-700"
            aria-label="Zurücksetzen"
          >
            ✕
          </button>
        )}
      </div>
      {showLog && log && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[480px] max-h-[300px] overflow-y-auto rounded border border-slate-300 bg-slate-950 p-3 shadow-xl">
          <pre className="whitespace-pre-wrap font-mono text-[10px] text-green-400">{log.replace(/__DONE:\d+__/, "")}</pre>
        </div>
      )}
    </div>
  );
}
