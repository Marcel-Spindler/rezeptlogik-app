// Command-Palette (⌘K) — eager Launcher + globaler Hotkey; das Modal kommt lazy.
//
// Löst die frühere Inline-Suchleiste (features/global-search/GlobalSearch.tsx)
// ab und sitzt im Shell-Header, damit sie in jeder Ansicht erreichbar ist.
import { Suspense, useEffect, useState } from "react";
import { lazyWithRetry } from "../../lib/lazyWithRetry";

const CommandPaletteModal = lazyWithRetry(
  () => import("./CommandPaletteModal").then((m) => ({ default: m.CommandPaletteModal })),
  "command-palette",
);

export function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Capture + stop: vor View-lokalen ⌘K-Handlern (z.B. Lager Komplett).
        e.stopImmediatePropagation();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Command-Palette — Ansichten, Rezepte, Work Orders, Kommandos (⌘K / Strg+K)"
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
      >
        <span aria-hidden>🔎</span>
        <span className="hidden sm:inline">Suche</span>
        <kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[10px] font-normal text-slate-400 sm:block">
          ⌘K
        </kbd>
      </button>
      {open && (
        <Suspense fallback={null}>
          <CommandPaletteModal onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
