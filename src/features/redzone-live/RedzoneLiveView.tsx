import { useMemo, useState, type ReactNode } from "react";
import { useRedzone } from "./RedzoneContext";
import { buildRedzoneCodeResolver } from "./redzoneResolve";
import { useAppState } from "../../app/AppContext";
import type { PlatingRunDisplay } from "./redzoneTypes";

// ─── Categorical palette (CVD-safe, fixed order) ──────────────────────────────
const CAT_COLORS = [
  "#0d9488", "#4f46e5", "#d97706", "#e11d48",
  "#7c3aed", "#0891b2", "#ea580c", "#65a30d",
];
function hashColor(code: string): string {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (code.charCodeAt(i) + ((h << 5) - h)) | 0;
  return CAT_COLORS[Math.abs(h) % CAT_COLORS.length];
}

// Manche Rezeptnamen in der Datenquelle enthalten den Code bereits ("FV4039A -
// Salmon ..."); wird der Code daneben schon separat angezeigt, sonst doppelt.
function stripLeadingCode(name: string): string {
  return name.replace(/^F[A-Z]\d{4}[A-Z]?\s*[-–]\s*/, "");
}

// ─── Recipe enrichment from app DataBundle ────────────────────────────────────

interface RecipeInfo { name: string; photoUrl?: string; weeks: string[] }

const norm = (s: string): string => s.trim().toUpperCase();

function useRecipeEnrichment() {
  const { data, setSelectedRecipe, setView, surface } = useAppState();

  const recipeMap = useMemo(() => {
    const m = new Map<string, RecipeInfo>();
    if (!data?.recipes) return m;
    for (const [code, r] of Object.entries(data.recipes)) {
      const weeks: string[] = [];
      m.set(norm(code), {
        name: stripLeadingCode(r.markets?.DE?.recipeNameLocal ?? r.baseName),
        photoUrl: r.catalog?.photoUrl,
        weeks,
      });
    }
    // Fill weeks from weekRecipes
    for (const wr of data?.weekRecipes ?? []) {
      const entry = m.get(norm(wr.code));
      if (entry && !entry.weeks.includes(wr.weekShort)) entry.weeks.push(wr.weekShort);
    }
    return m;
  }, [data]);

  // Redzone liefert productTypeSKU oft als MSKU statt als Rezept-Code im Freitext
  // — der Resolver deckt Regex-Treffer + MSKU-Fallback ab (siehe redzoneResolve.ts).
  const resolveCode = useMemo(() => buildRedzoneCodeResolver(data), [data]);

  const canNavigate = surface === "full";
  const openRecipe = (code: string) => {
    if (!canNavigate || !data?.recipes[code]) return;
    setSelectedRecipe(code);
    setView("recipe");
  };

  return { recipeMap, resolveCode, canNavigate, openRecipe };
}

// ─── Wochen-Kontingent (Planning OASE) ↔ Redzone-Output verdrahten ────────────
// Kontingent = Verden-Zielmenge der Woche (alle Märkte) aus data.weekRecipes.
interface MealTarget { target: number; week: string }

function useMealTargets(): Map<string, MealTarget> {
  const { data, selectedWeek } = useAppState();
  return useMemo(() => {
    const m = new Map<string, MealTarget>();
    for (const wr of data?.weekRecipes ?? []) {
      const key = norm(wr.code);
      const isSelected = wr.hfWeek === selectedWeek;
      // Bevorzugt die gewählte KW; sonst die erste gefundene (z.B. Vorproduktion).
      if (!m.has(key) || isSelected) m.set(key, { target: wr.totalVerdenVolume, week: wr.weekShort });
    }
    return m;
  }, [data, selectedWeek]);
}

interface MealProdEntry { produced: number; active: boolean; runs: number; lastActivity: string | null }

function useMealProduced(plating: PlatingRunDisplay[]): Map<string, MealProdEntry> {
  return useMemo(() => {
    const m = new Map<string, MealProdEntry>();
    for (const r of plating) {
      if (!r.mealCode) continue;
      const e = m.get(r.mealCode) ?? { produced: 0, active: false, runs: 0, lastActivity: null };
      e.produced += r.outCount ?? 0;
      e.runs += 1;
      if (r.status === "active") e.active = true;
      const t = r.endTime ?? r.startTime;
      if (t && (!e.lastActivity || t > e.lastActivity)) e.lastActivity = t;
      m.set(r.mealCode, e);
    }
    return m;
  }, [plating]);
}

export interface MealProgressRow {
  code: string; name?: string; photoUrl?: string; color: string;
  target: number | null; produced: number; pct: number | null;
  active: boolean; runs: number; week: string | null;
}

function useMealProgressRows(
  targets: Map<string, MealTarget>,
  produced: Map<string, MealProdEntry>,
  recipeMap: Map<string, RecipeInfo>,
  colorMap: Map<string, string>,
): MealProgressRow[] {
  return useMemo(() => {
    const codes = new Set<string>([...targets.keys(), ...produced.keys()]);
    const rows: MealProgressRow[] = [...codes].map(code => {
      const t = targets.get(code);
      const p = produced.get(code);
      const info = recipeMap.get(code);
      const target = t?.target ?? null;
      const prod = p?.produced ?? 0;
      return {
        code,
        name: info?.name,
        photoUrl: info?.photoUrl,
        color: colorMap.get(code) ?? hashColor(code),
        target,
        produced: prod,
        pct: target ? (prod / target) * 100 : null,
        active: p?.active ?? false,
        runs: p?.runs ?? 0,
        week: t?.week ?? null,
      };
    });
    // Reihenfolge fürs "wo stehen wir": zuerst was gerade läuft, dann was heute
    // schon Output hatte (nach Menge), erst danach noch nicht gestartete Meals
    // (nach Kontingent-Größe) — sonst verdrängen große Fern-KW-Kontingente ohne
    // jede heutige Aktivität die eigentlich relevanten Zeilen aus der Top-8-Liste.
    rows.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      const aStarted = a.produced > 0, bStarted = b.produced > 0;
      if (aStarted !== bStarted) return aStarted ? -1 : 1;
      if (aStarted) return b.produced - a.produced;
      return (b.target ?? 0) - (a.target ?? 0);
    });
    return rows;
  }, [targets, produced, recipeMap, colorMap]);
}

// ─── Color map (stable hash) ──────────────────────────────────────────────────
function useMealColorMap(runs: PlatingRunDisplay[]) {
  return useMemo(() => {
    const codes = [...new Set(runs.map(r => r.mealCode).filter((c): c is string => !!c))];
    const m = new Map<string, string>();
    codes.forEach(c => m.set(c, hashColor(c)));
    return m;
  }, [runs]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(iso: string | null) {
  if (!iso) return "–";
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}
function fmtDur(min: number | null) {
  if (min === null) return "–";
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

// "Plating Line 1" → "Line 1" — der gemeinsame Präfix frisst sonst genau die
// Ziffer, an der sich die Lines in schmalen Labels unterscheiden lassen.
function shortLine(name: string): string {
  return name.replace(/^Plating\s+/i, "");
}

// ─── Line Speed ────────────────────────────────────────────────────────────────
// Portionen/Minute. Für abgeschlossene Runs aus outCount/durationMin, für einen
// laufenden Run (falls Redzone schon einen Teil-Count liefert) aus verstrichener Zeit.
function ratePerMinForRun(run: PlatingRunDisplay, nowMs: number): number | null {
  if (!run.outCount || run.outCount <= 0 || !run.startTime) return null;
  const elapsed = run.status === "completed"
    ? run.durationMin
    : Math.max(1, Math.round((nowMs - new Date(run.startTime).getTime()) / 60_000));
  return elapsed && elapsed > 0 ? run.outCount / elapsed : null;
}

function fmtRate(rate: number | null): string {
  return rate === null ? "–" : rate.toFixed(1);
}

function useLineSpeeds(platingDone: PlatingRunDisplay[]) {
  return useMemo(() => {
    const byLine = new Map<string, { out: number; min: number; runs: number }>();
    for (const r of platingDone) {
      if (!r.outCount || !r.durationMin || r.durationMin <= 0) continue;
      const e = byLine.get(r.locationName) ?? { out: 0, min: 0, runs: 0 };
      e.out += r.outCount; e.min += r.durationMin; e.runs++;
      byLine.set(r.locationName, e);
    }
    const rates = new Map<string, number>();
    for (const [line, v] of byLine) rates.set(line, v.out / v.min);
    let totalOut = 0; let totalMin = 0;
    for (const v of byLine.values()) { totalOut += v.out; totalMin += v.min; }
    const overall = totalMin > 0 ? totalOut / totalMin : null;
    return { rates, overall };
  }, [platingDone]);
}

function LineSpeedPanel({ rates }: { rates: Map<string, number> }) {
  const sorted = useMemo(() => [...rates.entries()].sort((a, b) => b[1] - a[1]), [rates]);
  if (sorted.length === 0) return null;
  const max = sorted[0][1];
  return (
    <div className="card overflow-hidden h-full flex flex-col">
      <div className="px-4 py-3 border-b border-slate-100 shrink-0">
        <h3 className="text-sm font-semibold text-slate-800">Line Speed</h3>
        <p className="text-[10px] text-slate-400 mt-0.5">Ø Portionen/Min · abgeschlossene Runs</p>
      </div>
      <div className="p-4 space-y-2.5">
        {sorted.map(([line, rate]) => {
          const pct = (rate / max) * 100;
          return (
            <div key={line} className="flex items-center gap-2.5 min-w-0">
              <span className="w-14 shrink-0 text-[11px] font-mono text-slate-600 truncate" title={line}>{shortLine(line)}</span>
              <div className="relative h-4 flex-1 bg-slate-100 rounded overflow-hidden min-w-0">
                <div className="h-full rounded bg-teal-500 transition-all duration-700" style={{ width: `${Math.max(pct, 4)}%` }} />
              </div>
              <span className="w-16 shrink-0 text-right font-mono text-[11px] font-semibold text-slate-700 tabular-nums">
                {rate.toFixed(1)}/min
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Primitive components ─────────────────────────────────────────────────────
function Pulse() {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
    </span>
  );
}
function KpiTile({ value, label, sub, accent = "text-white" }: {
  value: string | number; label: string; sub?: string; accent?: string;
}) {
  return (
    <div className="rounded-xl bg-white/10 ring-1 ring-white/15 p-4 flex flex-col gap-1 backdrop-blur-sm min-w-0">
      <div className={`text-2xl font-bold font-mono tabular-nums leading-none truncate ${accent}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-widest text-white/50">{label}</div>
      {sub && <div className="text-[10px] text-white/35">{sub}</div>}
    </div>
  );
}

function ProgressBar({ pct, color, height = 8 }: { pct: number | null; color: string; height?: number }) {
  const clamped = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const over = pct !== null && pct > 100;
  const width = pct === null ? 0 : clamped > 0 ? Math.max(clamped, 2.5) : 0;
  return (
    <div className="relative rounded-full bg-slate-100 overflow-hidden" style={{ height }}>
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{ width: `${width}%`, backgroundColor: over ? "#dc2626" : color }}
      />
    </div>
  );
}

// ─── Meal-Fortschritt: Kontingent (Planning OASE) vs. produziert (Redzone) ────
function MealProgressPanel({ rows, canNavigate, openRecipe }: {
  rows: MealProgressRow[]; canNavigate: boolean; openRecipe: (c: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) return null;
  const withTarget = rows.filter(r => r.target !== null).length;
  const visible = expanded ? rows : rows.slice(0, 8);

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-800">Meal-Fortschritt</h3>
          <p className="text-[10px] text-slate-400 mt-0.5">
            Wochen-Kontingent (Planning OASE) vs. Plating-Output (Redzone) · {withTarget}/{rows.length} mit Kontingent
          </p>
        </div>
        {rows.length > 8 && (
          <button type="button" onClick={() => setExpanded(e => !e)}
            className="text-[11px] text-slate-500 hover:text-emerald-700 font-medium transition-colors shrink-0">
            {expanded ? "Weniger ↑" : `Alle ${rows.length} →`}
          </button>
        )}
      </div>
      <div className="divide-y divide-slate-50">
        {visible.map(r => {
          const remaining = r.target !== null ? Math.max(0, r.target - r.produced) : null;
          const over = r.pct !== null && r.pct > 100;
          return (
            <button
              key={r.code}
              type="button"
              onClick={() => openRecipe(r.code)}
              disabled={!canNavigate}
              className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors min-w-0 ${canNavigate ? "hover:bg-slate-50 cursor-pointer" : "cursor-default"}`}
            >
              {r.photoUrl ? (
                <img src={r.photoUrl} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
              ) : (
                <div className="w-9 h-9 rounded-lg shrink-0" style={{ backgroundColor: r.color, opacity: 0.75 }} />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 mb-1 min-w-0">
                  {r.active && <Pulse />}
                  <span className="font-mono text-[11px] font-bold shrink-0" style={{ color: r.color }}>{r.code}</span>
                  {r.name && <span className="text-[11px] text-slate-600 truncate min-w-0">{r.name}</span>}
                  {r.week && <span className="text-[9px] text-slate-400 font-mono shrink-0 ml-auto pl-2">{r.week}</span>}
                </div>
                <ProgressBar pct={r.pct} color={r.color} />
              </div>
              <div className="w-36 text-right shrink-0">
                <div className="font-mono text-[12px] font-bold tabular-nums" style={{ color: over ? "#dc2626" : "#0f172a" }}>
                  {r.produced.toLocaleString("de-DE")}
                  {r.target !== null && <span className="text-slate-400 font-normal"> / {r.target.toLocaleString("de-DE")}</span>}
                </div>
                <div className="text-[10px] font-mono mt-0.5 truncate" style={{ color: over ? "#dc2626" : "#64748b" }}>
                  {r.pct === null
                    ? "kein Kontingent"
                    : over
                      ? `+${Math.round(r.pct - 100)}% über Plan`
                      : `${Math.round(r.pct)}% · Rest ${remaining!.toLocaleString("de-DE")}`}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Active meals strip (hero) ────────────────────────────────────────────────
function ActiveMealsStrip({ runs, colorMap, recipeMap, progressByCode, openRecipe, canNavigate }: {
  runs: PlatingRunDisplay[]; colorMap: Map<string, string>;
  recipeMap: Map<string, RecipeInfo>; progressByCode: Map<string, MealProgressRow>;
  openRecipe: (c: string) => void; canNavigate: boolean;
}) {
  const active = [...new Map(
    runs.filter(r => r.status === "active" && r.mealCode)
      .map(r => [r.mealCode!, r])
  ).values()];
  if (active.length === 0) return null;

  return (
    <div className="mt-4 pt-4 border-t border-white/10">
      <div className="text-[10px] uppercase tracking-widest text-white/40 mb-2">Aktuell geplated</div>
      <div className="flex flex-wrap gap-2">
        {active.map(r => {
          const col = r.mealCode ? (colorMap.get(r.mealCode) ?? "#94a3b8") : "#94a3b8";
          const info = r.mealCode ? recipeMap.get(r.mealCode) : undefined;
          const photo = info?.photoUrl;
          const prog = r.mealCode ? progressByCode.get(r.mealCode) : undefined;
          return (
            <button
              key={r.mealCode}
              type="button"
              onClick={() => r.mealCode && openRecipe(r.mealCode)}
              disabled={!canNavigate}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/10 ring-1 ring-white/20 text-left transition-colors min-w-0 ${canNavigate ? "hover:bg-white/20 cursor-pointer" : "cursor-default"}`}
            >
              {photo ? (
                <img src={photo} alt="" className="w-7 h-7 rounded object-cover shrink-0 opacity-90" />
              ) : (
                <div className="w-7 h-7 rounded shrink-0" style={{ backgroundColor: col, opacity: 0.7 }} />
              )}
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-bold leading-none" style={{ color: col }}>
                  {r.mealCode}
                </div>
                {info?.name && (
                  <div className="text-[10px] text-white/70 leading-tight mt-0.5 max-w-[160px] truncate">
                    {info.name}
                  </div>
                )}
                {prog?.target != null && (
                  <div className="mt-1 flex items-center gap-1.5 w-[140px]">
                    <div className="h-1 flex-1 rounded-full bg-white/15 overflow-hidden min-w-0">
                      <div className="h-full rounded-full" style={{
                        width: `${Math.min(100, Math.max(3, prog.pct ?? 0))}%`,
                        backgroundColor: (prog.pct ?? 0) > 100 ? "#f87171" : "#34d399",
                      }} />
                    </div>
                    <span className="text-[9px] font-mono text-white/50 shrink-0">{Math.round(prog.pct ?? 0)}%</span>
                  </div>
                )}
              </div>
              {canNavigate && (
                <svg className="w-3 h-3 text-white/30 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Throughput sparkline ─────────────────────────────────────────────────────
function ThroughputSpark({ runs, hours }: { runs: PlatingRunDisplay[]; hours: number }) {
  const buckets = useMemo(() => {
    const nowMs = Date.now();
    const n = Math.min(hours, 24);
    const bMs = (hours * 3_600_000) / n;
    return Array.from({ length: n }, (_, i) => {
      const s = nowMs - (n - i) * bMs;
      const e = s + bMs;
      return runs.filter(r => r.endTime && r.outCount)
        .filter(r => { const t = new Date(r.endTime!).getTime(); return t >= s && t < e; })
        .reduce((a, r) => a + (r.outCount ?? 0), 0);
    });
  }, [runs, hours]);
  const max = Math.max(...buckets, 1);
  const W = 160; const H = 32; const bw = W / buckets.length - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-24 h-6 opacity-70" aria-hidden>
      {buckets.map((v, i) => {
        const bh = Math.max(2, (v / max) * H);
        return <rect key={i} x={i * (bw + 1)} y={H - bh} width={bw} height={bh} rx={1}
          fill={v > 0 ? "rgba(255,255,255,0.8)" : "rgba(255,255,255,0.15)"} />;
      })}
    </svg>
  );
}

// ─── Gantt Timeline ───────────────────────────────────────────────────────────
function GanttTimeline({ runs, hours, colorMap, recipeMap }: {
  runs: PlatingRunDisplay[]; hours: number;
  colorMap: Map<string, string>; recipeMap: Map<string, RecipeInfo>;
}) {
  const nowMs = Date.now();
  const windowMs = hours * 3_600_000;
  const startMs = nowMs - windowMs;
  const plating = runs.filter(r => r.areaName === "Plating" && r.startTime);
  const lines = [...new Set(plating.map(r => r.locationName))].sort();
  if (lines.length === 0) return null;

  const LW = 110; const CW = 1000 - LW;
  const RH = 40; const AH = 28;
  const SVG_H = lines.length * RH + AH;
  const tx = (t: number) => LW + ((t - startMs) / windowMs) * CW;
  const nowX = tx(nowMs);
  const tickN = hours <= 8 ? hours : hours <= 24 ? 6 : 8;
  const ticks = Array.from({ length: tickN + 1 }, (_, i) => {
    const t = startMs + (i / tickN) * windowMs;
    return { x: tx(t), label: new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) };
  });

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
        <Pulse />
        <h3 className="text-sm font-semibold text-slate-800">Production Timeline</h3>
        <span className="ml-auto text-[10px] text-slate-400 font-mono">letzte {hours}h</span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 1000 ${SVG_H}`} className="w-full"
          style={{ minWidth: 560, height: Math.min(SVG_H * 0.85, 320) }}
          role="img" aria-label="Produktions-Timeline je Plating-Line">
          {lines.map((_, i) => (
            <rect key={i} x={0} y={i * RH} width={1000} height={RH}
              fill={i % 2 === 0 ? "#f8fafc" : "#f1f5f9"} />
          ))}
          {ticks.map((t, i) => (
            <line key={i} x1={t.x} y1={0} x2={t.x} y2={lines.length * RH}
              stroke="#e2e8f0" strokeWidth={1} />
          ))}
          {plating.map((run, i) => {
            const li = lines.indexOf(run.locationName);
            const s = new Date(run.startTime!).getTime();
            const e = run.endTime ? new Date(run.endTime).getTime() : (run.status === "active" ? nowMs : null);
            if (!e) return null;
            const x1 = Math.max(LW, tx(s));
            const x2 = Math.min(LW + CW, tx(e));
            const bw = Math.max(3, x2 - x1);
            const y = li * RH + 7; const bh = RH - 14;
            const col = run.mealCode ? (colorMap.get(run.mealCode) ?? "#94a3b8") : "#94a3b8";
            const info = run.mealCode ? recipeMap.get(run.mealCode) : undefined;
            const active = run.status === "active";
            return (
              <g key={`${run.locationName}-${run.startTime ?? i}`}>
                <rect x={x1} y={y} width={bw} height={bh} rx={3}
                  fill={col} opacity={active ? 0.92 : 0.6}>
                  <title>
                    {info?.name ?? run.productTypeName}
                    {run.mealCode ? `\nCode: ${run.mealCode}` : ""}
                    {`\nLine: ${run.locationName}\nStart: ${fmt(run.startTime)}`}
                    {active ? "\n▶ läuft gerade" : `\nEnde: ${fmt(run.endTime)}\nOutput: ${run.outCount?.toLocaleString("de-DE")} Portionen`}
                    {info?.weeks.length ? `\nKW: ${info.weeks.join(", ")}` : ""}
                  </title>
                </rect>
                {active && bw > 6 && (
                  <rect x={x2 - 4} y={y} width={4} height={bh} rx={2} fill="white" opacity={0.45} />
                )}
                {bw > 44 && run.mealCode && (
                  <text x={x1 + 5} y={y + bh / 2 + 3.5} fontSize={9} fill="white" fontWeight="600"
                    style={{ pointerEvents: "none" }}>
                    {run.mealCode}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={nowX} y1={0} x2={nowX} y2={lines.length * RH}
            stroke="#10b981" strokeWidth={1.5} strokeDasharray="5 3" />
          <text x={nowX + 3} y={11} fontSize={8} fill="#10b981" fontWeight="700">JETZT</text>
          {lines.map((line, i) => {
            const label = shortLine(line);
            return (
              <text key={line} x={LW - 7} y={i * RH + RH / 2 + 4}
                textAnchor="end" fontSize={10} fill="#475569" fontWeight="500">
                {label.length > 13 ? label.slice(0, 13) + "…" : label}
              </text>
            );
          })}
          {ticks.map((t, i) => (
            <text key={i} x={t.x} y={lines.length * RH + 17}
              textAnchor="middle" fontSize={9} fill="#94a3b8">{t.label}</text>
          ))}
        </svg>
      </div>
    </div>
  );
}

// ─── Line Card ────────────────────────────────────────────────────────────────
function LineCard({ line, runs, colorMap, recipeMap, avgDuration, lineSpeed, progressByCode, onOpenRecipe, canNavigate }: {
  line: string; runs: PlatingRunDisplay[];
  colorMap: Map<string, string>; recipeMap: Map<string, RecipeInfo>;
  avgDuration: number | null; lineSpeed: number | null;
  progressByCode: Map<string, MealProgressRow>;
  onOpenRecipe: (c: string) => void; canNavigate: boolean;
}) {
  const active = runs.find(r => r.status === "active");
  const done = runs.filter(r => r.status === "completed").slice(0, 4);
  const elapsedMin = active?.startTime
    ? Math.round((Date.now() - new Date(active.startTime).getTime()) / 60_000) : null;
  const pct = elapsedMin !== null && avgDuration ? Math.min(100, (elapsedMin / avgDuration) * 100) : null;
  const col = active?.mealCode ? (colorMap.get(active.mealCode) ?? "#10b981") : "#10b981";
  const activeInfo = active?.mealCode ? recipeMap.get(active.mealCode) : undefined;
  const activeName = activeInfo?.name
    ?? active?.productTypeName.replace(active?.mealCode ?? "", "").replace(/^\s*[-–]?\s*/, "");
  const liveRate = active ? ratePerMinForRun(active, Date.now()) : null;
  const activeProgress = active?.mealCode ? progressByCode.get(active.mealCode) : undefined;
  // r=16 → circumference ≈ 100.53
  const circ = 100.53;
  const dash = pct !== null ? (pct / 100) * circ : 0;

  return (
    <div className={`rounded-xl ring-1 overflow-hidden bg-white transition-shadow min-w-0 ${active ? "ring-emerald-200 shadow-md shadow-emerald-50" : "ring-slate-200"}`}>
      {/* Header */}
      <div className={`px-4 py-2.5 flex items-center justify-between gap-2 ${active ? "bg-gradient-to-r from-emerald-50 to-teal-50/40" : "bg-slate-50"}`}>
        <div className="flex items-center gap-2 min-w-0">
          {active ? <Pulse /> : <span className="w-2.5 h-2.5 rounded-full border-2 border-slate-300 shrink-0" />}
          <span className="font-semibold text-sm text-slate-800 truncate">{line}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {lineSpeed !== null && (
            <span className="text-[9px] font-mono font-semibold px-2 py-0.5 rounded-full bg-teal-100 text-teal-700" title="Ø Portionen/Min (abgeschlossene Runs)">
              Ø {lineSpeed.toFixed(1)}/min
            </span>
          )}
          <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"}`}>
            {active ? "AKTIV" : "IDLE"}
          </span>
        </div>
      </div>

      {/* Active run */}
      {active && (
        <div className="px-4 py-3 border-b border-slate-100 min-w-0">
          <div className="flex items-start gap-3 min-w-0">
            {/* Photo or progress arc */}
            <div className="shrink-0 relative">
              {activeInfo?.photoUrl ? (
                <div className="relative w-12 h-12">
                  <img src={activeInfo.photoUrl} alt="" className="w-12 h-12 rounded-lg object-cover" />
                  {/* mini arc overlay */}
                  <svg viewBox="0 0 40 40" className="absolute inset-0 w-full h-full -rotate-90 opacity-90">
                    <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(0,0,0,0.3)" strokeWidth="2.5" />
                    {pct !== null && (
                      <circle cx="20" cy="20" r="18" fill="none" stroke="white" strokeWidth="2.5"
                        strokeDasharray={`${(pct / 100) * 113.1} 113.1`} strokeLinecap="round" />
                    )}
                  </svg>
                </div>
              ) : (
                <div className="w-12 h-12">
                  <svg viewBox="0 0 40 40" className="w-12 h-12 -rotate-90">
                    <circle cx="20" cy="20" r="16" fill="none" stroke="#e2e8f0" strokeWidth="3.5" />
                    {pct !== null && (
                      <circle cx="20" cy="20" r="16" fill="none" stroke={col} strokeWidth="3.5"
                        strokeDasharray={`${dash} ${circ - dash}`} strokeLinecap="round" />
                    )}
                    <circle cx="20" cy="20" r="5.5" fill={col} />
                  </svg>
                </div>
              )}
            </div>
            {/* Info */}
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-1 min-w-0">
                <div className="min-w-0 flex-1">
                  {active.mealCode && (
                    <div className="text-[10px] font-bold font-mono leading-none mb-0.5 truncate" style={{ color: col }}>
                      {active.mealCode}
                      {activeInfo?.weeks.length ? (
                        <span className="ml-1 font-normal text-slate-400">· {activeInfo.weeks.slice(-1)[0]}</span>
                      ) : null}
                    </div>
                  )}
                  <div className="text-[12px] font-semibold text-slate-800 leading-tight line-clamp-2">
                    {activeName}
                  </div>
                </div>
                {canNavigate && active.mealCode && (
                  <button type="button" onClick={() => onOpenRecipe(active.mealCode!)}
                    className="shrink-0 p-1 rounded hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 transition-colors" title="Rezept öffnen">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2.5 mt-1.5 text-[10px] text-slate-500 flex-wrap">
                <span>Start {fmt(active.startTime)}</span>
                {elapsedMin !== null && <span className="font-mono">{elapsedMin}m laufend</span>}
                {pct !== null && <span className="font-mono text-slate-400">{Math.round(pct)}% von Ø</span>}
                {liveRate !== null && (
                  <span className="font-mono font-semibold text-emerald-600">{fmtRate(liveRate)}/min live</span>
                )}
                {active.outCount ? (
                  <span className="font-mono font-semibold" style={{ color: col }}>
                    {active.outCount.toLocaleString("de-DE")} Stk.
                  </span>
                ) : null}
              </div>
              {activeProgress?.target != null && (
                <div className="mt-2 min-w-0">
                  <div className="flex items-center justify-between text-[10px] mb-1 gap-2">
                    <span className="text-slate-400 shrink-0">Wochen-Kontingent {activeProgress.week ?? ""}</span>
                    <span className="font-mono font-semibold text-slate-600 truncate">
                      {activeProgress.produced.toLocaleString("de-DE")} / {activeProgress.target.toLocaleString("de-DE")}
                      {" · "}{Math.round(activeProgress.pct ?? 0)}%
                    </span>
                  </div>
                  <ProgressBar pct={activeProgress.pct} color={col} height={5} />
                </div>
              )}
            </div>
          </div>
          <div className="mt-2.5 h-1 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full animate-pulse" style={{ width: "100%", backgroundColor: col, opacity: 0.55 }} />
          </div>
        </div>
      )}

      {/* Recent done */}
      {done.length > 0 && (
        <div className="px-4 py-2.5 space-y-1.5">
          {done.map((r, i) => {
            const c = r.mealCode ? (colorMap.get(r.mealCode) ?? "#94a3b8") : "#94a3b8";
            const info = r.mealCode ? recipeMap.get(r.mealCode) : undefined;
            return (
              <div key={`${r.startTime ?? i}`} className="flex items-center gap-2 text-[11px] min-w-0">
                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: c }} />
                <div className="min-w-0 flex-1 flex items-baseline gap-1.5">
                  <span className="font-mono text-[10px] font-semibold shrink-0" style={{ color: c }}>{r.mealCode}</span>
                  {info?.name && (
                    <span className="text-slate-500 truncate min-w-0 flex-1">{info.name}</span>
                  )}
                </div>
                <span className="text-slate-400 font-mono shrink-0 text-[10px]">
                  {r.outCount?.toLocaleString("de-DE")} · {fmt(r.endTime)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {!active && done.length === 0 && (
        <div className="px-4 py-5 text-center text-[11px] text-slate-400">Keine Aktivität</div>
      )}
    </div>
  );
}

// ─── Cooking Grid ─────────────────────────────────────────────────────────────
function CookingGrid({ runs }: { runs: PlatingRunDisplay[] }) {
  const active = useMemo(() => runs.filter(r => r.status === "active"), [runs]);

  const grouped = useMemo(() => {
    const m = new Map<string, PlatingRunDisplay[]>();
    for (const r of active) {
      if (!m.has(r.locationName)) m.set(r.locationName, []);
      m.get(r.locationName)!.push(r);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [active]);

  const recentFinished = useMemo(() => {
    return [...runs]
      .filter(r => r.status === "completed" && r.endTime)
      .sort((a, b) => b.endTime!.localeCompare(a.endTime!))
      .slice(0, 8);
  }, [runs]);

  if (runs.length === 0) return null;

  return (
    <div className="card overflow-hidden h-full flex flex-col">
      <div className="px-4 py-3 bg-gradient-to-r from-amber-50 to-orange-50/60 border-b border-amber-100 flex items-center gap-2 shrink-0">
        <svg className="w-4 h-4 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
        </svg>
        <h3 className="text-sm font-semibold text-amber-900">Küche</h3>
        <span className={`ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full shrink-0 ${active.length > 0 ? "text-amber-700 bg-amber-100" : "text-slate-500 bg-slate-100"}`}>
          {active.length > 0 ? `${active.length} aktiv` : "gerade nichts im Ofen/Braiser"}
        </span>
      </div>

      {active.length > 0 ? (
        <div className="p-3 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
          {grouped.map(([loc, locRuns]) => (
            <div key={loc} className="rounded-lg bg-amber-50 ring-1 ring-amber-200 p-2.5 min-w-0">
              <div className="text-[10px] font-bold text-amber-800 uppercase tracking-wide mb-1.5 truncate">{loc}</div>
              {locRuns.slice(0, 2).map((r, i) => (
                <div key={i} className="text-[10px] text-slate-600 truncate leading-tight" title={r.productTypeName}>
                  {r.productTypeName}
                </div>
              ))}
              <div className="mt-1.5 h-0.5 rounded-full bg-amber-200 overflow-hidden">
                <div className="h-full bg-amber-500 animate-pulse w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-4 flex-1">
          {recentFinished.length > 0 ? (
            <>
              <div className="text-[10px] text-slate-400 mb-2">Zuletzt fertig</div>
              <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
                {recentFinished.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] min-w-0 rounded-lg bg-slate-50 px-2.5 py-1.5 ring-1 ring-slate-100">
                    <span className="font-mono text-[10px] font-semibold text-slate-500 shrink-0">{r.locationName}</span>
                    <span className="text-slate-500 truncate min-w-0 flex-1" title={r.productTypeName}>{r.productTypeName}</span>
                    <span className="text-slate-400 font-mono shrink-0 text-[10px]">{fmt(r.endTime)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="text-center text-[11px] text-slate-400 py-6">Keine Aktivität im gewählten Zeitraum</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sortable Completed Table ─────────────────────────────────────────────────
type SortKey = "locationName" | "outCount" | "durationMin" | "endTime";

function SortTh({ sk, current, desc, onSort, right, children }: {
  sk: SortKey; current: SortKey; desc: boolean; onSort: (k: SortKey) => void;
  right?: boolean; children: ReactNode;
}) {
  const active = sk === current;
  return (
    <th className={`px-4 py-2.5 ${right ? "text-right" : "text-left"} cursor-pointer select-none transition-colors text-[10px] uppercase tracking-wide font-semibold
      ${active ? "text-emerald-700 bg-emerald-50/50" : "text-slate-500 hover:bg-slate-100"}`}
      onClick={() => onSort(sk)}>
      <span className={`inline-flex items-center gap-1 ${right ? "flex-row-reverse" : ""}`}>
        {children}
        {active && <span className="text-[9px]">{desc ? "↓" : "↑"}</span>}
      </span>
    </th>
  );
}

function CompletedTable({ runs, colorMap, recipeMap, onOpenRecipe, canNavigate }: {
  runs: PlatingRunDisplay[]; colorMap: Map<string, string>; recipeMap: Map<string, RecipeInfo>;
  onOpenRecipe: (c: string) => void; canNavigate: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("endTime");
  const [sortDesc, setSortDesc] = useState(true);

  const sorted = useMemo(() => [...runs].sort((a, b) => {
    const get = (r: PlatingRunDisplay): string | number => {
      if (sortKey === "locationName") return r.locationName;
      if (sortKey === "outCount") return r.outCount ?? -1;
      if (sortKey === "durationMin") return r.durationMin ?? -1;
      return r.endTime ?? "";
    };
    const va = get(a); const vb = get(b);
    if (typeof va === "string" && typeof vb === "string")
      return sortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
    return sortDesc ? (vb as number) - (va as number) : (va as number) - (vb as number);
  }), [runs, sortKey, sortDesc]);

  const visible = expanded ? sorted : sorted.slice(0, 16);
  if (runs.length === 0) return null;
  const onSort = (k: SortKey) => {
    if (sortKey === k) setSortDesc(d => !d);
    else { setSortKey(k); setSortDesc(true); }
  };

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">
          Abgeschlossen
          <span className="ml-2 text-[11px] font-normal text-slate-400">{runs.length} Runs</span>
        </h3>
        {runs.length > 16 && (
          <button type="button" onClick={() => setExpanded(e => !e)}
            className="text-[11px] text-slate-500 hover:text-emerald-700 font-medium transition-colors">
            {expanded ? "Weniger ↑" : `Alle ${runs.length} →`}
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="border-b border-slate-100">
              <SortTh sk="locationName" current={sortKey} desc={sortDesc} onSort={onSort}>Line</SortTh>
              <th className="px-4 py-2.5 text-left text-[10px] uppercase tracking-wide font-semibold text-slate-500">Rezept</th>
              <SortTh sk="outCount" current={sortKey} desc={sortDesc} onSort={onSort} right>Output</SortTh>
              <th className="px-4 py-2.5 text-left text-[10px] uppercase tracking-wide font-semibold text-slate-500">Start</th>
              <SortTh sk="endTime" current={sortKey} desc={sortDesc} onSort={onSort}>Ende</SortTh>
              <SortTh sk="durationMin" current={sortKey} desc={sortDesc} onSort={onSort} right>Dauer</SortTh>
              {canNavigate && <th className="px-2 py-2.5" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {visible.map((run, i) => {
              const col = run.mealCode ? (colorMap.get(run.mealCode) ?? "#94a3b8") : "#94a3b8";
              const info = run.mealCode ? recipeMap.get(run.mealCode) : undefined;
              return (
                <tr key={`${run.locationName}-${run.startTime ?? i}`}
                  className="hover:bg-slate-50/80 transition-colors group">
                  <td className="px-4 py-2 font-mono text-[11px] text-slate-600">{run.locationName}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: col }} />
                      <div className="min-w-0">
                        <span className="font-mono text-[11px] font-bold" style={{ color: col }}>
                          {run.mealCode ?? run.productTypeSKU}
                        </span>
                        {info?.name && (
                          <span className="ml-2 text-slate-500 text-[11px] truncate max-w-[220px] inline-block align-bottom">
                            {info.name}
                          </span>
                        )}
                        {info?.weeks.length ? (
                          <span className="ml-1.5 text-[9px] text-slate-400 font-mono">{info.weeks.slice(-1)[0]}</span>
                        ) : null}
                        {!info?.name && (
                          <span className="ml-2 text-slate-400 text-[11px] truncate max-w-[200px] inline-block align-bottom">
                            {run.productTypeName.replace(run.mealCode ?? "", "").replace(/^\s*[-–]?\s*/, "")}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-bold text-slate-900 tabular-nums">
                    {run.outCount?.toLocaleString("de-DE") ?? "–"}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-slate-400">{fmt(run.startTime)}</td>
                  <td className="px-4 py-2 font-mono text-[11px] text-slate-500">{fmt(run.endTime)}</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-500">{fmtDur(run.durationMin)}</td>
                  {canNavigate && (
                    <td className="px-2 py-2">
                      {run.mealCode && (
                        <button type="button" onClick={() => onOpenRecipe(run.mealCode!)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-emerald-600"
                          title={`${info?.name ?? run.mealCode} öffnen`}>
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────
export function RedzoneLiveView() {
  const rz = useRedzone();
  const { recipeMap, resolveCode, canNavigate, openRecipe } = useRecipeEnrichment();

  // Meal-Codes gegen Rezept-Code UND MSKU auflösen, damit auch dann ein
  // echter Name erscheint, wenn Redzones productTypeName-Regex nicht 1:1 trifft.
  const resolvedRuns = useMemo(
    () => rz.runs.map(r => {
      const code = resolveCode(r);
      return code !== r.mealCode ? { ...r, mealCode: code } : r;
    }),
    [rz.runs, resolveCode],
  );

  const plating = useMemo(() => resolvedRuns.filter(r => r.areaName === "Plating"), [resolvedRuns]);
  const platingDone = useMemo(() => plating.filter(r => r.status === "completed"), [plating]);
  const cooking = useMemo(() => resolvedRuns.filter(r => r.areaName !== "Plating"), [resolvedRuns]);
  const colorMap = useMealColorMap(plating);

  // Planning OASE (Wochen-Kontingent) ↔ Redzone (Ist-Produktion) verdrahten.
  const mealTargets = useMealTargets();
  const mealProduced = useMealProduced(plating);
  const progressRows = useMealProgressRows(mealTargets, mealProduced, recipeMap, colorMap);
  const progressByCode = useMemo(() => new Map(progressRows.map(r => [r.code, r])), [progressRows]);

  const lineRuns = useMemo(() => {
    const m = new Map<string, PlatingRunDisplay[]>();
    for (const r of plating) {
      if (!m.has(r.locationName)) m.set(r.locationName, []);
      m.get(r.locationName)!.push(r);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [plating]);

  const avgDuration = useMemo(() => {
    const ds = platingDone.map(r => r.durationMin).filter((d): d is number => d !== null && d > 0);
    return ds.length ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) : null;
  }, [platingDone]);

  const lineSpeeds = useLineSpeeds(platingDone);
  const cookingActiveCount = useMemo(() => cooking.filter(r => r.status === "active").length, [cooking]);

  if (rz.loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin mx-auto" />
        <div className="text-sm text-slate-500 mt-3">Lade Redzone-Daten…</div>
      </div>
    </div>
  );

  if (rz.error) return (
    <div className="card p-8 text-center">
      <div className="text-4xl mb-3">⚡</div>
      <div className="text-lg font-bold text-red-800">Verbindung fehlgeschlagen</div>
      <div className="text-sm text-red-600 mt-1">{rz.error}</div>
      <button type="button" onClick={rz.refresh} className="btn btn-primary mt-4">Erneut versuchen</button>
      <div className="text-[10px] text-slate-400 mt-3">WMS-Server (Port 3141) muss laufen</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* ═══ HERO ═══ */}
      <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-emerald-950 to-teal-900 p-5 text-white shadow-xl relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: [
            "radial-gradient(ellipse at 75% 15%, rgba(16,185,129,0.18) 0%, transparent 55%)",
            "radial-gradient(ellipse at 20% 85%, rgba(6,182,212,0.12) 0%, transparent 55%)",
          ].join(", ")
        }} />
        <div className="relative">
          <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <Pulse />
              <div>
                <h1 className="text-2xl font-bold tracking-tight leading-none">Redzone Live</h1>
                <p className="text-[11px] text-white/45 mt-1">Factor Verden · Echtzeit-Produktionsstatus</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <ThroughputSpark runs={platingDone} hours={rz.hours} />
              <select value={rz.hours} onChange={e => rz.setHours(Number(e.target.value))}
                className="text-xs bg-white/10 border border-white/20 rounded-lg px-2.5 py-1.5 text-white appearance-none cursor-pointer">
                {[8, 24, 48, 72, 120].map(h => (
                  <option key={h} value={h} className="text-slate-900">{h}h</option>
                ))}
              </select>
              <button type="button" onClick={rz.refresh}
                className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors" title="Jetzt aktualisieren">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
              <div className="text-[10px] text-white/35 font-mono tabular-nums w-8 text-right">{rz.secondsUntilRefresh}s</div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
            <KpiTile value={rz.activeLineCount} label="Aktive Lines" accent="text-emerald-400" />
            <KpiTile value={platingDone.length} label="Meals fertig" accent="text-white" />
            <KpiTile value={rz.totalPlated.toLocaleString("de-DE")} label="Total Output" sub="Portionen" accent="text-cyan-300" />
            <KpiTile value={fmtDur(avgDuration)} label="Ø Laufzeit" sub="pro Run" accent="text-white" />
            <KpiTile value={fmtRate(lineSpeeds.overall)} label="Ø Line Speed" sub="Stk/min" accent="text-teal-300" />
            <KpiTile value={cookingActiveCount} label="In Küche" sub="Ovens & Braisers" accent="text-amber-300" />
            <KpiTile
              value={rz.lastUpdate
                ? new Date(rz.lastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "–"}
              label="Letztes Update" accent="text-white/65" />
          </div>

          {/* Active meals strip with names + photos + Kontingent-Fortschritt */}
          <ActiveMealsStrip
            runs={plating} colorMap={colorMap} recipeMap={recipeMap} progressByCode={progressByCode}
            openRecipe={openRecipe} canNavigate={canNavigate} />
        </div>
      </div>

      {/* ═══ MEAL-FORTSCHRITT: Kontingent (Planning OASE) ↔ Redzone-Output ═══ */}
      <MealProgressPanel rows={progressRows} canNavigate={canNavigate} openRecipe={openRecipe} />

      {/* ═══ GANTT ═══ */}
      <GanttTimeline runs={resolvedRuns} hours={rz.hours} colorMap={colorMap} recipeMap={recipeMap} />

      {/* ═══ PLATING LINES ═══ */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
          </svg>
          <h2 className="text-sm font-semibold text-slate-700">Plating Lines</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {lineRuns.map(([line, runs]) => (
            <LineCard key={line} line={line} runs={runs} colorMap={colorMap} recipeMap={recipeMap}
              avgDuration={avgDuration} lineSpeed={lineSpeeds.rates.get(line) ?? null}
              progressByCode={progressByCode}
              onOpenRecipe={openRecipe} canNavigate={canNavigate} />
          ))}
          {lineRuns.length === 0 && (
            <div className="sm:col-span-2 xl:col-span-3 card p-8 text-center text-sm text-slate-400">
              Keine Plating-Lines im gewählten Zeitraum
            </div>
          )}
        </div>
      </div>

      {/* ═══ LINE SPEED + KÜCHE ═══ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
        <div className="lg:col-span-1">
          <LineSpeedPanel rates={lineSpeeds.rates} />
        </div>
        <div className="lg:col-span-2">
          <CookingGrid runs={cooking} />
        </div>
      </div>

      {/* ═══ TABLE ═══ */}
      <CompletedTable runs={platingDone} colorMap={colorMap} recipeMap={recipeMap}
        onOpenRecipe={openRecipe} canNavigate={canNavigate} />
    </div>
  );
}
