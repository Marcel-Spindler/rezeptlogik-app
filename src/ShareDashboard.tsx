/**
 * ShareDashboard.tsx – Interaktives Team-Dashboard (read-only)
 *
 * Primärinhalt:  KET / Küchenplanung (Kanban nach Tag, filterbar)
 * Sekundär:      ASL-Linienplan (informativ, nur lesbar)
 * Erweiterbar:   Neue Tabs in NAV_TABS ergänzen
 *
 * URL:   ?share=2026-W19
 * Embed: ?share=2026-W19&embed=1  (ohne TopBar / Footer-Links)
 */

import { useEffect, useMemo, useState } from "react";

import type { KetWO, LinePlanRecipe, ScheduleMap } from "./features/share-dashboard/shareDashboardTypes";
import { analyzeQuality, NAV_TABS, parseKet, parseLineplanning } from "./features/share-dashboard/shareDashboardLogic";
import type { NavKey } from "./features/share-dashboard/shareDashboardLogic";
import { KpiView, QualityView } from "./features/share-dashboard/ShareDashboardWidgets";
import { KitchenView } from "./features/share-dashboard/ShareKitchenViews";
import { AslView } from "./features/share-dashboard/ShareAslView";

export function ShareDashboard({ week }: { week: string }) {
  const weekStr  = week.split("-W")[1] ?? week;
  const isEmbed  = new URLSearchParams(window.location.search).has("embed");

  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [recipes,      setRecipes]      = useState<LinePlanRecipe[]>([]);
  const [schedule,     setSchedule]     = useState<ScheduleMap>({});
  const [ketWOs,       setKetWOs]       = useState<KetWO[]>([]);
  const [ketOverrides, setKetOverrides] = useState<Record<string, { day?: string; status?: string }>>({});
  const [weekNum,      setWeekNum]      = useState(0);
  const [savedAt,      setSavedAt]      = useState<string | null>(null);
  const [activeTab,    setActiveTab]    = useState<NavKey>("kitchen");
  const [copied,       setCopied]       = useState(false);

  const qualityIssues = useMemo(
    () => analyzeQuality(ketWOs, recipes, schedule),
    [ketWOs, recipes, schedule]
  );

  // ── Load ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/data/gsheet-dump-Kitchen_Priority_List-Verden-2026.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as {
          sheets: Array<{ title: string; sheetId: number; values: string[][] }>;
        };

        const lpSheet = data.sheets.find(s => s.title === "Lineplanning");
        if (lpSheet) {
          const { weekNum: wn, recipes: recs, initialSchedule } =
            parseLineplanning(lpSheet.values);
          setWeekNum(wn); setRecipes(recs); setSchedule(initialSchedule);
        }

        const ketSheet =
          data.sheets.find(s => s.title.includes(`W${weekStr}`) && s.title.startsWith("KET")) ??
          data.sheets.find(s => s.title.startsWith("KET"));
        if (ketSheet) setKetWOs(parseKet(ketSheet.values));

        // Firestore overrides (public read)
        const { getFirebase }           = await import("./core/firebase");
        const { doc, getDoc }           = await import("firebase/firestore");
        const { db }                    = getFirebase();
        const snap                      = await getDoc(doc(db, "apps/rezeptlogik/lineplanning", `de_W${weekStr}`));
        if (snap.exists()) {
          const d = snap.data() as {
            schedule?:     ScheduleMap;
            ketOverrides?: Record<string, { day?: string; status?: string }>;
            savedAt?:      string;
          };
          if (d.schedule)     setSchedule(d.schedule);
          if (d.ketOverrides) setKetOverrides(d.ketOverrides);
          if (d.savedAt)      setSavedAt(d.savedAt);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [weekStr]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const savedAtLabel = savedAt
    ? new Date(savedAt).toLocaleString("de-DE", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : null;

  function copyLink() {
    void navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4"
      style={{ background: "linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#0f172a 100%)" }}
    >
      <div className="w-14 h-14 rounded-full border-4 border-indigo-500/30 border-t-indigo-400 animate-spin" />
      <div className="text-center">
        <div className="text-white text-lg font-semibold">Lade Produktionsplan</div>
        <div className="text-indigo-300 text-sm mt-1">Factor Verden · KW {weekStr}</div>
      </div>
    </div>
  );

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error) return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#0f172a 100%)" }}
    >
      <div className="text-center">
        <div className="text-5xl mb-4">⚠️</div>
        <div className="text-rose-300 text-xl font-semibold">Plan konnte nicht geladen werden</div>
        <div className="text-slate-400 text-sm mt-2 font-mono">{error}</div>
        <a
          href={window.location.origin}
          className="mt-6 inline-block px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors"
        >
          → App öffnen
        </a>
      </div>
    </div>
  );

  // ── Main ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">

      {/* ── Top Bar ────────────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-50 border-b border-slate-200/60 shrink-0"
        style={{ backdropFilter: "blur(20px)", background: "rgba(248,250,252,0.92)" }}
      >
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6">
          <div className="flex items-center gap-4 py-2.5">

            {/* Brand */}
            <div className="flex items-center gap-2.5 shrink-0">
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-black"
                style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)" }}
              >
                F
              </div>
              <div className="hidden sm:block">
                <div className="text-xs font-bold text-slate-700 leading-none">Factor Verden</div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  KW {weekNum > 0 ? weekNum : weekStr}
                  {savedAtLabel && <> · {savedAtLabel}</>}
                </div>
              </div>
            </div>

            {/* Tabs */}
            <nav className="flex-1 flex items-center gap-2 overflow-x-auto">
              <div className="flex gap-1 p-1 rounded-xl bg-slate-100 ring-1 ring-slate-200">
                {NAV_TABS.map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap transition-all duration-150 ${
                      activeTab === tab.key
                        ? "bg-white shadow-sm ring-1 ring-slate-200 text-slate-800"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-50 border border-amber-100">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide">Nur Ansicht</span>
              </div>
            </nav>

            {/* Actions */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={copyLink}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all"
                style={copied
                  ? { borderColor: "#6ee7b7", background: "#d1fae5", color: "#065f46" }
                  : { borderColor: "#e2e8f0", background: "white",   color: "#475569" }
                }
              >
                <span>{copied ? "✓" : "🔗"}</span>
                <span className="hidden sm:inline">{copied ? "Kopiert!" : "Teilen"}</span>
              </button>
              {!isEmbed && (
                <a
                  href={window.location.origin}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                >
                  <span>↗</span>
                  <span className="hidden sm:inline">App</span>
                </a>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Subtitle bar ─────────────────────────────────────────────── */}
      <div
        className="shrink-0 border-b border-slate-100"
        style={{ background: "linear-gradient(90deg,#f8fafc,white)" }}
      >
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
            {NAV_TABS.find(t => t.key === activeTab)?.desc}
          </div>
          <h1 className="text-xl font-black text-slate-800 mt-0.5">
            {NAV_TABS.find(t => t.key === activeTab)?.label}
            <span className="ml-2.5 text-slate-300 font-normal text-base">
              KW {weekNum > 0 ? weekNum : weekStr}
            </span>
          </h1>
        </div>
      </div>

      {/* ── Main ─────────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-screen-2xl w-full mx-auto px-4 sm:px-6 py-6">
        {activeTab === "kitchen" && (
          <KitchenView
            ketWOs={ketWOs}
            ketOverrides={ketOverrides}
            weekNum={weekNum > 0 ? weekNum : parseInt(weekStr)}
          />
        )}
        {activeTab === "asl" && (
          <AslView
            schedule={schedule}
            recipes={recipes}
            weekNum={weekNum > 0 ? weekNum : parseInt(weekStr)}
          />
        )}
        {activeTab === "quality" && (
          <QualityView
            issues={qualityIssues}
            ketCount={ketWOs.length}
            aslCount={recipes.length}
          />
        )}
        {activeTab === "kpi" && (
          <KpiView
            ketWOs={ketWOs}
            ketOverrides={ketOverrides}
            recipes={recipes}
            schedule={schedule}
            weekNum={weekNum > 0 ? weekNum : parseInt(weekStr)}
          />
        )}
      </main>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="shrink-0 border-t border-slate-100">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <div
              className="w-4 h-4 rounded flex items-center justify-center text-white text-[9px] font-black"
              style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)" }}
            >F</div>
            <span>Factor · Verden · KW {weekNum > 0 ? weekNum : weekStr}</span>
            {savedAtLabel && (
              <><span className="text-slate-200">·</span><span>Stand: {savedAtLabel}</span></>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={copyLink} className="hover:text-slate-600 transition-colors">
              {copied ? "✓ Link kopiert" : "🔗 Link kopieren"}
            </button>
            {!isEmbed && (
              <>
                <span className="text-slate-200">·</span>
                <a href={window.location.origin} className="hover:text-slate-600 transition-colors">
                  ↗ Planer-App
                </a>
              </>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
