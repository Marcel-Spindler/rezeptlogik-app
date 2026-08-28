// Hilfe-System für KET Plan / WO:
//  - KetHelpProvider / useKetHelp: öffnet das Handbuch aus beliebiger Tiefe
//  - HelpButton: kleines ?-Icon mit zweisprachigem Kurztext + Link ins Handbuch
//  - KetManualDialog: das vollständige zweisprachige Handbuch (Vollbild-Modal)
//  - BiLabel: zweisprachiges Label "DE / EN" für Buttons und Überschriften
//
// Help system for KET Plan / WO. See German comment above.
import {
  createContext, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { KET_HELP_SECTIONS, type HelpSection } from "./ketHelpContent";

// ── Context ────────────────────────────────────────────────────────────────

type OpenManual = (sectionId?: string) => void;
const KetHelpContext = createContext<OpenManual>(() => {});

export function KetHelpProvider({ onOpen, children }: { onOpen: OpenManual; children: ReactNode }) {
  return <KetHelpContext.Provider value={onOpen}>{children}</KetHelpContext.Provider>;
}

export function useKetHelp(): OpenManual {
  return useContext(KetHelpContext);
}

// ── BiLabel ────────────────────────────────────────────────────────────────
// Zweisprachiges Label: Deutsch normal, Englisch gedämpft dahinter.

export function BiLabel({ de, en, className }: { de: string; en: string; className?: string }) {
  return (
    <span className={className}>
      {de}
      <span className="font-normal opacity-60"> / {en}</span>
    </span>
  );
}

// ── HelpButton ─────────────────────────────────────────────────────────────

export function HelpButton({
  section,
  className,
  label,
  align = "right",
}: {
  section: string;
  className?: string;
  /** Optionaler Zusatztext neben dem Icon (z. B. "Hilfe / Help"). */
  label?: { de: string; en: string };
  /** Auf welcher Seite des Icons der Popover aufklappt (Default: nach links). */
  align?: "left" | "right";
}) {
  const openManual = useKetHelp();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const sec = useMemo(() => KET_HELP_SECTIONS.find((s) => s.id === section), [section]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className={`relative inline-flex items-center ${className ?? ""}`}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="Hilfe / Help"
        aria-label="Hilfe / Help"
        className={`inline-flex items-center gap-1 rounded-full border border-current text-current opacity-60 hover:opacity-100 transition-opacity ${
          label ? "px-1.5 py-0.5 text-[10px] font-bold" : "h-4 w-4 justify-center text-[10px] font-black leading-none"
        }`}
      >
        {label ? <><span aria-hidden>ℹ</span><BiLabel de={label.de} en={label.en} /></> : "?"}
      </button>

      {open && sec && (
        <div
          className={`absolute top-full z-[70] mt-1.5 w-72 max-w-[80vw] rounded-xl border border-slate-200 bg-white p-3 text-left shadow-2xl ${align === "right" ? "right-0" : "left-0"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-black text-slate-800">
            <span aria-hidden>{sec.icon}</span>
            <BiLabel de={sec.titleDe} en={sec.titleEn} />
          </div>
          <p className="text-[11px] leading-relaxed text-slate-600">{sec.shortDe}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{sec.shortEn}</p>
          <button
            type="button"
            onClick={() => { setOpen(false); openManual(section); }}
            className="mt-2 w-full rounded-lg bg-[#1e3a5f] px-2 py-1.5 text-[10px] font-bold text-white hover:bg-[#162d4a] transition-colors"
          >
            <BiLabel de="Vollständiges Handbuch" en="Full manual" /> →
          </button>
        </div>
      )}
    </span>
  );
}

// ── Handbuch-Renderer ──────────────────────────────────────────────────────

function HelpBody({ lines }: { lines: string[] }) {
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        if (line.startsWith("## ")) {
          return (
            <h4 key={i} className="pt-1.5 text-[11px] font-black uppercase tracking-wide text-slate-500">
              {line.slice(3)}
            </h4>
          );
        }
        if (line.startsWith("- ")) {
          return (
            <div key={i} className="flex gap-1.5 text-[12px] leading-relaxed text-slate-700">
              <span className="shrink-0 text-slate-400">•</span>
              <span>{line.slice(2)}</span>
            </div>
          );
        }
        return (
          <p key={i} className="text-[12px] leading-relaxed text-slate-700">
            {line}
          </p>
        );
      })}
    </div>
  );
}

function matchesQuery(sec: HelpSection, q: string): boolean {
  if (!q) return true;
  const hay = [
    sec.titleDe, sec.titleEn, sec.shortDe, sec.shortEn,
    ...sec.bodyDe, ...sec.bodyEn,
  ].join(" \n ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

// ── KetManualDialog ────────────────────────────────────────────────────────

export function KetManualDialog({
  open,
  initialSection,
  onClose,
}: {
  open: boolean;
  initialSection: string | null;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState<string>(initialSection ?? KET_HELP_SECTIONS[0].id);
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setActiveId(initialSection ?? KET_HELP_SECTIONS[0].id);
      setQuery("");
    }
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [activeId]);

  const visibleSections = useMemo(
    () => KET_HELP_SECTIONS.filter((s) => matchesQuery(s, query)),
    [query],
  );

  const active = useMemo(
    () => KET_HELP_SECTIONS.find((s) => s.id === activeId) ?? KET_HELP_SECTIONS[0],
    [activeId],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-300"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Kopfleiste */}
        <div className="flex shrink-0 items-center justify-between gap-3 bg-gradient-to-r from-[#0f2240] to-[#1e3a5f] px-4 py-2.5 text-white">
          <div className="text-sm font-black">
            <BiLabel de="KET Plan / WO — Handbuch" en="Manual" />
          </div>
          <button type="button" onClick={onClose} aria-label="Schließen / Close" className="text-xl leading-none opacity-80 hover:opacity-100">
            ×
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Navigation */}
          <nav className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-slate-50/70">
            <div className="p-2">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Suche / Search …"
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {visibleSections.length === 0 && (
                <div className="px-2 py-3 text-[11px] text-slate-400">Nichts gefunden / No match</div>
              )}
              {visibleSections.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveId(s.id)}
                  className={`mb-0.5 flex w-full items-start gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold transition-colors ${
                    s.id === activeId ? "bg-[#1e3a5f] text-white" : "text-slate-600 hover:bg-slate-200/70"
                  }`}
                >
                  <span aria-hidden className="mt-px">{s.icon}</span>
                  <span className="leading-tight">
                    {s.titleDe}
                    <span className={`block text-[10px] font-normal ${s.id === activeId ? "text-blue-200" : "text-slate-400"}`}>
                      {s.titleEn}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </nav>

          {/* Inhalt: DE und EN nebeneinander */}
          <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="mb-3 flex items-center gap-2 text-lg font-black text-slate-900">
              <span aria-hidden>{active.icon}</span>
              <span>
                {active.titleDe}
                <span className="ml-2 text-sm font-semibold text-slate-400">{active.titleEn}</span>
              </span>
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <section>
                <div className="mb-2 inline-block rounded bg-blue-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-blue-700">
                  Deutsch
                </div>
                <HelpBody lines={active.bodyDe} />
              </section>
              <section className="lg:border-l lg:border-slate-100 lg:pl-6">
                <div className="mb-2 inline-block rounded bg-slate-200 px-2 py-0.5 text-[10px] font-black uppercase tracking-widest text-slate-600">
                  English
                </div>
                <HelpBody lines={active.bodyEn} />
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
