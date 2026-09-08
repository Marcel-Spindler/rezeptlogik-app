import { Suspense, useEffect, useState } from "react";
import { lazyWithRetry } from "../../lib/lazyWithRetry";

export const PLATING_OPTIMIZE_EVENT = "rezeptlogik:plating-optimize";

// Der Launcher-Button ist winzig und bleibt eager im Header. Panel + Agent +
// Kontext-Assembler + Werkzeuge kommen erst beim ersten Öffnen als eigener Chunk.
const PlanAssistantPanel = lazyWithRetry(
  () => import("./PlanAssistantPanel").then(m => ({ default: m.PlanAssistantPanel })),
  "plan-assistant",
);

export function PlanAssistantLauncher({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Frag den Plan — KI-Assistent auf den Live-Daten"
      className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-verden-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
    >
      <span aria-hidden>🤖</span>
      <span className="hidden sm:inline">Frag den Plan</span>
    </button>
  );
}

export function PlanAssistant() {
  const [open, setOpen] = useState(false);
  const [initialPrompt, setInitialPrompt] = useState<string | undefined>();

  useEffect(() => {
    const handler = (e: Event) => {
      const prompt = (e as CustomEvent<string>).detail;
      setInitialPrompt(prompt);
      setOpen(true);
    };
    window.addEventListener(PLATING_OPTIMIZE_EVENT, handler);
    return () => window.removeEventListener(PLATING_OPTIMIZE_EVENT, handler);
  }, []);

  return (
    <>
      <PlanAssistantLauncher onOpen={() => setOpen(true)} />
      {open && (
        <Suspense fallback={<div className="fixed right-4 top-16 z-50 rounded-lg bg-white px-3 py-2 text-xs text-slate-500 shadow-lg">Assistent lädt …</div>}>
          <PlanAssistantPanel onClose={() => { setOpen(false); setInitialPrompt(undefined); }} initialPrompt={initialPrompt} onPromptConsumed={() => setInitialPrompt(undefined)} />
        </Suspense>
      )}
    </>
  );
}
