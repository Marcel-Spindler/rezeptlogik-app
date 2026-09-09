import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { DataBundle } from "../../core/types";
import { useAppState } from "../../app/AppContext";
import { fmtNum } from "../../lib/helpers";
import { usePlatingWeekPlan } from "../plating-plan/usePlatingWeekPlan";
import {
  buildDefaultParams, computeDayLoads, computeOpenBackfills, computeRunFeasibility, countUnfinishedMarkers,
  DEFAULT_DAY_CAPACITY, suggestCarryForwardDay,
  type PlatingDayLoad, type RunFeasibility,
} from "../plating-plan/platingPlanLogic";
import {
  PLATING_DAYS, PRODUCTION_SHIFT_HOURS, type PlatingDay, type PlatingDayCapacity,
  type PlatingPlanParams,
} from "../plating-plan/platingPlanTypes";
import { PLATING_OPTIMIZE_EVENT } from "../plan-assistant/PlanAssistant";
import { useRedzoneOptional } from "../redzone-live/RedzoneContext";
import { buildPlatedByCodeMap } from "../redzone-live/redzoneHelpers";
import { useBackfillsOptional } from "../backfills/BackfillsContext";
import {
  useTransparencyWeighing, useTransparencyFlow, useTransparencyPlanningCheck, useTransparencyRtem,
} from "../gsheet-monitor/useTransparencyMonitor";
import { computeTransparencyProducibility } from "../gsheet-monitor/transparencyProducibility";
import type { SubmealProducibilityStatus } from "../gsheet-monitor/transparencyTypes";
import { weekNumFromHfWeek } from "../wms-overview/wmsWeeks";

/** Was gerade gezogen wird: ein bestehender Run (Tag wechseln) oder ein
 *  offener Backfill-Bedarf (neuer Run wird beim Drop erzeugt). */
type DragPayload =
  | { kind: "run"; code: string; runIndex: number; fromDay: PlatingDay }
  | { kind: "backfill"; code: string; portions: number };

const DAY_LABELS: Record<PlatingDay, string> = {
  Mo: "Montag", Di: "Dienstag", Mi: "Mittwoch", Do: "Donnerstag",
  Fr: "Freitag", Sa: "Samstag", So: "Sonntag",
};

const PROD_STATUS_TONE: Record<SubmealProducibilityStatus, string> = {
  ready: "text-emerald-500", partial: "text-amber-500", blocked: "text-rose-500", unknown: "text-slate-300",
};

function KpiCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const border = tone === "blue" ? "border-blue-200 bg-blue-50" : tone === "amber" ? "border-amber-200 bg-amber-50" : tone === "rose" ? "border-rose-200 bg-rose-50" : tone === "green" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white";
  const text = tone === "blue" ? "text-blue-800" : tone === "amber" ? "text-amber-800" : tone === "rose" ? "text-rose-800" : tone === "green" ? "text-emerald-800" : "text-slate-800";
  const sub = tone === "blue" ? "text-blue-500" : tone === "amber" ? "text-amber-500" : tone === "rose" ? "text-rose-500" : tone === "green" ? "text-emerald-500" : "text-slate-400";
  return (
    <div className={`rounded-lg border px-3 py-2 ${border}`}>
      <div className={`text-[9px] font-bold uppercase ${sub}`}>{label}</div>
      <div className={`font-mono text-sm font-bold ${text}`}>{value}</div>
    </div>
  );
}

/** Auslastung EINER Schicht als Prozent gegen ihre eigene availableHours (fix
 *  7,5h bei 2-Schicht-Tagen, siehe PRODUCTION_SHIFT_HOURS) — nie gegen einen
 *  verdoppelten/abgeleiteten Wert, sonst zeigt der Balken bei 100% Auslastung
 *  nur einen Bruchteil an. */
function shiftPct(sl: { neededHours: number; availableHours: number } | undefined): number {
  if (!sl || sl.availableHours <= 0) return 0;
  return Math.min(100, (sl.neededHours / sl.availableHours) * 100);
}

function ShiftBar({ load }: { load: PlatingDayLoad }) {
  if (!load.shiftLoads) {
    const pct = shiftPct(load);
    return (
      <div className="h-5 w-full rounded bg-slate-100">
        <div className={`h-full rounded ${load.overCapacity ? "bg-rose-400" : "bg-blue-400"}`} style={{ width: `${pct}%` }} />
      </div>
    );
  }
  const frueh = load.shiftLoads.find(s => s.shift === "früh");
  const spaet = load.shiftLoads.find(s => s.shift === "spät");
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className="w-8 shrink-0 text-[8px] font-bold text-blue-500">Früh</span>
        <div className="h-3.5 flex-1 rounded bg-slate-100">
          <div className={`h-full rounded ${frueh?.overCapacity ? "bg-rose-400" : "bg-blue-400"}`}
            style={{ width: `${shiftPct(frueh)}%` }} title={`${frueh?.neededHours ?? 0}h / ${frueh?.availableHours ?? PRODUCTION_SHIFT_HOURS}h`} />
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-8 shrink-0 text-[8px] font-bold text-amber-600">Spät</span>
        <div className="h-3.5 flex-1 rounded bg-slate-100">
          <div className={`h-full rounded ${spaet?.overCapacity ? "bg-rose-400" : "bg-amber-400"}`}
            style={{ width: `${shiftPct(spaet)}%` }} title={`${spaet?.neededHours ?? 0}h / ${spaet?.availableHours ?? PRODUCTION_SHIFT_HOURS}h`} />
        </div>
      </div>
    </div>
  );
}

/** „An diesem Tag nicht geschafft" — Ist-Menge erfassen, Rest auf einen anderen
 *  Tag legen. Eigener Input-State, initialisiert aus Redzone-Hinweis + Vorschlag. */
function UnfinishedPanel({
  code, runIndex, fromDay, plannedPortions, platedHint, suggestedDay, onCancel, onSubmit,
}: {
  code: string; runIndex: number; fromDay: PlatingDay; plannedPortions: number;
  platedHint: number; suggestedDay: PlatingDay;
  onCancel: () => void; onSubmit: (producedPortions: number, toDay: PlatingDay) => void;
}) {
  const [done, setDone] = useState<number>(() => Math.max(0, Math.min(Math.round(platedHint), plannedPortions)));
  const [toDay, setToDay] = useState<PlatingDay>(suggestedDay);
  const clamped = Math.max(0, Math.min(done, plannedPortions));
  const remainder = plannedPortions - clamped;
  return (
    <div className="mt-0.5 rounded border border-rose-200 bg-rose-50/70 p-1.5 text-[9px]">
      <div className="mb-1 font-bold text-rose-700">
        {code} R{runIndex} · {DAY_LABELS[fromDay]} nicht geschafft
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label className="flex items-center gap-1">
          <span className="text-slate-500">geplatet</span>
          <input type="number" min={0} max={plannedPortions} value={done}
            onChange={e => setDone(Math.max(0, Math.round(Number(e.target.value) || 0)))}
            className="w-16 rounded border border-slate-300 px-1 text-right font-mono" />
          <span className="text-slate-400">/ {fmtNum(plannedPortions)}</span>
        </label>
        {platedHint > 0 && Math.round(platedHint) !== done && (
          <button type="button" onClick={() => setDone(Math.max(0, Math.min(Math.round(platedHint), plannedPortions)))}
            className="text-[8px] text-slate-400 underline hover:text-slate-600">
            Redzone: {fmtNum(platedHint)}
          </button>
        )}
        <span className="text-slate-500">
          Rest <span className="font-bold text-rose-700">{fmtNum(remainder)}</span> P →
        </span>
        <select value={toDay} onChange={e => setToDay(e.target.value as PlatingDay)}
          className="rounded border border-slate-300 px-1 font-mono">
          {(["Mo", "Di", "Mi", "Do", "Fr", "Sa"] as PlatingDay[]).map(dd => (
            <option key={dd} value={dd}>{DAY_LABELS[dd]}{dd === suggestedDay ? " · Vorschlag" : ""}</option>
          ))}
        </select>
        <button type="button" onClick={onCancel}
          className="rounded border border-slate-300 px-1.5 py-0.5 font-semibold text-slate-500 hover:bg-white">
          Abbrechen
        </button>
        <button type="button" onClick={() => onSubmit(clamped, toDay)} disabled={remainder <= 0}
          className="rounded bg-rose-600 px-1.5 py-0.5 font-semibold text-white hover:bg-rose-500 disabled:opacity-40">
          Rest auf {DAY_LABELS[toDay]}
        </button>
      </div>
    </div>
  );
}

export function PlatingLineBotView({ data }: { data: DataBundle }) {
  const { selectedWeek } = useAppState();
  const week = selectedWeek;
  const {
    plan, loading, dirty, moveRun, addBackfillRun, regenerate,
    markRunUnfinished, clearRunUnfinished,
  } = usePlatingWeekPlan(data, week);

  const [editMode, setEditMode] = useState(false);
  // Run, für den gerade das „nicht geschafft"-Panel offen ist.
  const [splitRun, setSplitRun] = useState<{ code: string; runIndex: number } | null>(null);
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dropTarget, setDropTarget] = useState<PlatingDay | null>(null);
  // Ref, damit onDrop die Quelle auch kennt, wenn zwischen dragstart und drop
  // kein Re-Render lag (synchrone Events) — Muster wie in PlatingDayView.tsx.
  const dragSrc = useRef<DragPayload | null>(null);

  const [draftParams, setDraftParams] = useState<PlatingPlanParams>(() => buildDefaultParams(week));
  const [draftCap, setDraftCap] = useState<Partial<Record<PlatingDay, PlatingDayCapacity>>>(() => ({ ...DEFAULT_DAY_CAPACITY }));

  useEffect(() => {
    setDraftParams(plan?.params ?? buildDefaultParams(week));
    setDraftCap(plan?.dayCapacity ?? { ...DEFAULT_DAY_CAPACITY });
  }, [plan, week]);

  const loads = useMemo(() => (plan ? computeDayLoads(plan) : []), [plan]);
  const activeDays = useMemo(
    () => PLATING_DAYS.filter(d => {
      const l = loads.find(x => x.day === d);
      return l && (l.lines > 0 || l.portions > 0);
    }),
    [loads],
  );

  const setParam = (k: keyof PlatingPlanParams, v: number) => setDraftParams(p => ({ ...p, [k]: v }));
  const setCap = (d: PlatingDay, k: keyof PlatingDayCapacity, v: number) =>
    setDraftCap(c => {
      const next: PlatingDayCapacity = { lines: c[d]?.lines ?? 0, hours: c[d]?.hours ?? 0, shifts: c[d]?.shifts ?? 1, [k]: v };
      // 2 Schichten = fix 2×7,5h — das Stundenfeld wird dafür nicht mehr frei getippt.
      if (k === "shifts" && v === 2) next.hours = 2 * PRODUCTION_SHIFT_HOURS;
      return { ...c, [d]: next };
    });
  const applyAndGenerate = () => {
    // „Neu generieren" baut den Wochenplan frisch — die Ist-Nachführung
    // (nicht geschafft / Nachhol-Runs) geht dabei verloren.
    if (plan && countUnfinishedMarkers(plan) > 0
      && !window.confirm("Der Plan enthält „nicht geschafft\"-Markierungen und Nachhol-Runs.\nNeu generieren verwirft sie. Fortfahren?")) return;
    regenerate({ params: draftParams, dayCapacity: draftCap });
  };

  // Kapazitäts-Ampel je Run (Teil des KI-unabhängigen Dashboards, reine Ableitung
  // aus plan/loads — läuft bei jedem Render neu, kein zusätzliches Polling nötig).
  const feasibilityByDay = useMemo(() => {
    const m = new Map<PlatingDay, Map<string, RunFeasibility>>();
    if (!plan) return m;
    for (const d of activeDays) m.set(d, computeRunFeasibility(plan, d));
    return m;
  }, [plan, activeDays]);

  // Drag-and-Drop (nur im Edit-Modus aktiv): Run auf einen anderen Tag ziehen
  // verschiebt ihn (moveRun), einen Backfill-Chip auf einen Tag ziehen legt
  // dafür einen neuen, als Backfill markierten Run an (addBackfillRun).
  const onDragStart = useCallback((payload: DragPayload) => (e: DragEvent) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", payload.code); // Firefox startet sonst keinen Drag
    dragSrc.current = payload;
    setDragging(payload);
  }, []);
  const onDragEnd = useCallback(() => {
    dragSrc.current = null;
    setDragging(null);
    setDropTarget(null);
  }, []);
  const onDayDrop = useCallback((day: PlatingDay) => (e: DragEvent) => {
    e.preventDefault();
    const src = dragSrc.current ?? dragging;
    if (src) {
      if (src.kind === "run") {
        if (src.fromDay !== day) moveRun(src.code, src.runIndex, day);
      } else {
        addBackfillRun(src.code, src.portions, day);
      }
    }
    dragSrc.current = null;
    setDragging(null);
    setDropTarget(null);
  }, [dragging, moveRun, addBackfillRun]);

  // Offene Backfill-Bedarfe (live aus Postblast/LinePlating/RTI zusammengeführt,
  // src/features/backfills) für Meals dieser KW — Grundlage der Backfill-Chips.
  const backfills = useBackfillsOptional();
  const backfillsCombined = backfills?.combined;
  const openBackfills = useMemo(
    () => (plan ? computeOpenBackfills(plan, backfillsCombined ?? []) : []),
    [plan, backfillsCombined],
  );

  // Redzone Live: app-weit gemountet (auch in Prod erreichbar), Live-Feed selbst
  // ist aktuell aber nur lokal/dev sauber befüllt — degradiert sonst einfach zu "nichts anzeigen".
  const redzone = useRedzoneOptional();
  const rzPlatingDone = redzone?.platingDone;
  const rzPlatingNow = redzone?.platingNow;
  const platedByCode = useMemo(
    () => buildPlatedByCodeMap(redzone),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rzPlatingDone, rzPlatingNow],
  );

  // Transparency Plan: "ist das Meal JETZT wirklich produzierbar" je Rezept-Code
  // (Weighing/Flow/RTEM/Planning-Check) — nur lokal befüllt, degradiert sonst leise.
  const twWeighing = useTransparencyWeighing();
  const twFlow = useTransparencyFlow();
  const twPlanningCheck = useTransparencyPlanningCheck();
  const twRtem = useTransparencyRtem();
  const transparencyWeekNum = useMemo(
    () => weekNumFromHfWeek(twPlanningCheck.data?.week || week),
    [twPlanningCheck.data?.week, week],
  );
  const producibility = useMemo(
    () => computeTransparencyProducibility(twFlow.data, twWeighing.data, twRtem.data, twPlanningCheck.data, transparencyWeekNum),
    [twFlow.data, twWeighing.data, twRtem.data, twPlanningCheck.data, transparencyWeekNum],
  );

  const triggerAI = useCallback((mode: "fill" | "optimize") => {
    const p = plan?.params ?? draftParams;
    const paramInfo = `Parameter: First Run ${Math.round(p.firstRunPct * 100)}%, Puffer 1-Run +${Math.round(p.singleRunBuffer * 100)}%, Puffer 2-Runs +${Math.round(p.multiRunBuffer * 100)}%, Rate ${p.platingRatePerLineHour}/L/h.`;
    const shiftInfo = Object.entries(plan?.dayCapacity ?? draftCap)
      .filter(([, c]) => c && (c.shifts ?? 1) >= 2)
      .map(([d]) => d);
    const shiftNote = shiftInfo.length ? ` Tage mit 2 Schichten: ${shiftInfo.join(", ")}.` : "";

    const prompt = mode === "fill"
      ? `Erstelle den vollständigen Wochen-Plating-Plan für ${week}. ${paramInfo}${shiftNote} `
        + `Gehe systematisch vor: 1) generate_plating_plan aufrufen, 2) das Ergebnis auf ALLE Regeln prüfen `
        + `(Seafood so spät wie möglich, komplexe Meals früh, Tage gleichmäßig, keine Überkapazität, Schichtbalance), `
        + `3) simulate_plating_change mit Verbesserungen wo nötig, 4) propose_plating_plan mit detaillierter Zusammenfassung inkl. Schichtaufteilung. `
        + `Der Plan muss 100% regelkonform sein.`
      : `Optimiere den bestehenden Wochen-Plating-Plan für ${week}. ${paramInfo}${shiftNote} `
        + `Prüfe: 1) Tagesverteilung balanciert? 2) Seafood so spät wie möglich? 3) Komplexe Meals (cx≥1.15) früh genug? `
        + `4) Keine Überkapazität pro Schicht? 5) Alle Meals verplant? `
        + `Simuliere Verbesserungen und schlage den optimierten Plan mit Schichtaufteilung vor.`;
    window.dispatchEvent(new CustomEvent(PLATING_OPTIMIZE_EVENT, { detail: prompt }));
  }, [plan, draftParams, draftCap, week]);

  // Summaries
  const totalMeals = plan?.meals.length ?? 0;
  const totalPortions = plan?.meals.reduce((s, m) => s + m.bufferedTotal, 0) ?? 0;
  const seafoodCount = plan?.meals.filter(m => m.seafood).length ?? 0;
  const overDays = loads.filter(l => l.overCapacity).length;
  const shiftDays = loads.filter(l => l.shifts > 1).length;
  const carryForwardRuns = plan?.meals.reduce((n, m) => n + m.runs.filter(r => r.isCarryForward && r.portions > 0).length, 0) ?? 0;
  const carryForwardPortions = plan?.meals.reduce((s, m) => s + m.runs.filter(r => r.isCarryForward).reduce((x, r) => x + r.portions, 0), 0) ?? 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-amber-700">Plating-Linien Bot</div>
          <h1 className="text-xl font-bold text-slate-950">Plating Vorplanung {week}</h1>
          <p className="text-xs text-slate-500">Automatische Verteilung der Meals auf Plating-Tage mit Früh-/Spätschicht-Aufteilung</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          {plan && (
            <button type="button" onClick={() => setEditMode(v => !v)}
              className={`rounded-lg border px-3 py-1.5 font-semibold ${editMode ? "border-cyan-400 bg-cyan-50 text-cyan-800" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
              ✎ Plan bearbeiten
            </button>
          )}
          <button type="button" onClick={applyAndGenerate}
            className="rounded-lg bg-verden-600 px-3 py-1.5 font-semibold text-white hover:bg-verden-500">
            {plan ? "Neu generieren" : "Plan generieren"}
          </button>
          <button type="button" onClick={() => triggerAI(plan ? "optimize" : "fill")}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500">
            {plan ? "KI optimieren" : "KI befüllen"}
          </button>
          {dirty && <span className="text-amber-600 text-[10px]">speichert…</span>}
        </div>
      </div>

      {/* Parameter-Leiste (immer sichtbar) */}
      <div className="card border-slate-200 p-3">
        <div className="mb-2 text-[10px] font-bold uppercase text-slate-400">Stellschrauben</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px]">
            <span className="text-slate-600">First Run %</span>
            <input type="number" value={Math.round(draftParams.firstRunPct * 100)} step={1} min={40} max={95}
              onChange={e => setParam("firstRunPct", Number(e.target.value) / 100)}
              className="w-14 rounded border border-slate-200 px-1 text-right font-mono font-bold" />
          </label>
          <label className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px]">
            <span className="text-slate-600">Puffer 1 Run %</span>
            <input type="number" value={Math.round(draftParams.singleRunBuffer * 100)} step={1} min={0} max={50}
              onChange={e => setParam("singleRunBuffer", Number(e.target.value) / 100)}
              className="w-14 rounded border border-slate-200 px-1 text-right font-mono font-bold" />
          </label>
          <label className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px]">
            <span className="text-slate-600">Puffer 2 Runs %</span>
            <input type="number" value={Math.round(draftParams.multiRunBuffer * 100)} step={1} min={0} max={50}
              onChange={e => setParam("multiRunBuffer", Number(e.target.value) / 100)}
              className="w-14 rounded border border-slate-200 px-1 text-right font-mono font-bold" />
          </label>
          <label className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-[11px]">
            <span className="text-slate-600">Rate P/L/h</span>
            <input type="number" value={draftParams.platingRatePerLineHour} step={25} min={1}
              onChange={e => setParam("platingRatePerLineHour", Number(e.target.value))}
              className="w-14 rounded border border-slate-200 px-1 text-right font-mono font-bold" />
          </label>
        </div>
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-bold uppercase text-slate-400">Kapazität je Tag (Linien · Stunden gesamt · Schichten)</div>
          <div className="flex flex-wrap gap-2">
            {(["Mo","Di","Mi","Do","Fr","Sa","So"] as PlatingDay[]).map(d => (
              <div key={d} className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px]">
                <div className="text-center text-[9px] font-bold text-slate-500">{d}</div>
                <div className="flex items-center gap-1">
                  <input type="number" min={0} value={draftCap[d]?.lines ?? 0}
                    onChange={e => setCap(d, "lines", Math.max(0, Number(e.target.value) || 0))}
                    className="w-8 rounded border border-slate-200 px-0.5 text-right font-mono" title="Linien" />
                  <span className="text-slate-300">·</span>
                  {(draftCap[d]?.shifts ?? 1) === 2 ? (
                    <span className="w-14 text-right font-mono text-[10px] font-bold text-amber-700"
                      title="2 Schichten à fix 7,5h — Produktionsmitarbeiter-Schichtlänge, nicht editierbar">
                      2×7,5h
                    </span>
                  ) : (
                    <input type="number" min={0} step={0.1} value={draftCap[d]?.hours ?? 0}
                      onChange={e => setCap(d, "hours", Math.max(0, Number(e.target.value) || 0))}
                      className="w-10 rounded border border-slate-200 px-0.5 text-right font-mono" title="Stunden gesamt" />
                  )}
                  <span className="text-slate-300">·</span>
                  <select value={draftCap[d]?.shifts ?? 1}
                    onChange={e => setCap(d, "shifts", Number(e.target.value) as 1 | 2)}
                    className={`w-10 rounded border px-0.5 font-mono text-[10px] ${(draftCap[d]?.shifts ?? 1) === 2 ? "border-amber-300 bg-amber-50 font-bold text-amber-700" : "border-slate-200"}`}
                    title="Schichten">
                    <option value={1}>1S</option>
                    <option value={2}>2S</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {loading && <div className="card p-8 text-center text-slate-400">Lädt Plating-Plan…</div>}

      {/* Leerer Zustand */}
      {!loading && !plan && (
        <div className="card space-y-4 p-8 text-center">
          <div className="text-lg text-slate-500">Noch kein Plating-Plan für {week}</div>
          <div className="flex justify-center gap-3">
            <button type="button" onClick={applyAndGenerate}
              className="rounded-lg bg-verden-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-verden-500">
              Plan generieren (Algorithmus)
            </button>
            <button type="button" onClick={() => triggerAI("fill")}
              className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500">
              KI befüllen (Gemini)
            </button>
          </div>
          <p className="text-xs text-slate-400">
            Algorithmus = schnell, deterministisch. KI = prüft alle Regeln, optimiert Seafood/Complexity/Balance.
          </p>
        </div>
      )}

      {/* Plan vorhanden */}
      {plan && (
        <>
          {/* KPI-Dashboard */}
          <div className="flex flex-wrap gap-2">
            <KpiCard label="Meals" value={String(totalMeals)} />
            <KpiCard label="Portionen" value={fmtNum(totalPortions)} />
            <KpiCard label="First Run" value={`${Math.round(plan.params.firstRunPct * 100)}%`} tone="blue" />
            <KpiCard label="Puffer 1R" value={`+${Math.round(plan.params.singleRunBuffer * 100)}%`} />
            <KpiCard label="Puffer 2R" value={`+${Math.round(plan.params.multiRunBuffer * 100)}%`} />
            {seafoodCount > 0 && <KpiCard label="Seafood" value={`${seafoodCount} Meals`} tone="blue" />}
            {shiftDays > 0 && <KpiCard label="2 Schichten" value={`${shiftDays} Tage`} tone="amber" />}
            {carryForwardRuns > 0 && <KpiCard label="Nachhol-Runs" value={`${carryForwardRuns} · ${fmtNum(carryForwardPortions)} P`} tone="amber" />}
            {overDays > 0 && <KpiCard label="Über Kapazität" value={`${overDays} Tage`} tone="rose" />}
            {overDays === 0 && <KpiCard label="Status" value="OK" tone="green" />}
          </div>

          {/* Offene Backfills — Chips zum Auf-einen-Tag-Ziehen (nur im Edit-Modus) */}
          {editMode && openBackfills.length > 0 && (
            <div className="card border-violet-200 bg-violet-50/40 p-3">
              <div className="mb-2 text-[10px] font-bold uppercase text-violet-700">
                Offene Backfills — auf einen Tag ziehen
              </div>
              <div className="flex flex-wrap gap-2">
                {openBackfills.map(({ meal, entry, openPortions }) => {
                  const tone = entry.priority === "critical" ? "border-rose-300 bg-rose-50 text-rose-800"
                    : entry.priority === "behind" ? "border-amber-300 bg-amber-50 text-amber-800"
                    : "border-slate-300 bg-white text-slate-700";
                  const reasons = [...entry.platingShortageReasons, ...entry.kitchenSubRecipes].join(", ");
                  const isDragged = dragging?.kind === "backfill" && dragging.code === meal.code;
                  return (
                    <div key={meal.code}
                      draggable
                      onDragStart={onDragStart({ kind: "backfill", code: meal.code, portions: openPortions })}
                      onDragEnd={onDragEnd}
                      className={`cursor-grab rounded-lg border px-2 py-1 text-[11px] font-semibold active:cursor-grabbing ${tone} ${isDragged ? "opacity-40" : ""}`}
                      title={`Quelle: ${entry.recommendedSource} (${entry.priority})${reasons ? `\n${reasons}` : ""}`}
                    >
                      <span className="mr-1 text-slate-300">⠿</span>
                      {meal.code} {meal.name} · +{fmtNum(openPortions)} P
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tagesübersicht mit Schicht-Breakdown */}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {activeDays.map(d => {
              const l = loads.find(x => x.day === d)!;
              const frueh = l.shiftLoads?.find(s => s.shift === "früh");
              const spaet = l.shiftLoads?.find(s => s.shift === "spät");
              const dayMeals = plan.meals.flatMap(m =>
                m.runs.filter(r => r.day === d && r.portions > 0).map(r => ({ ...m, run: r })),
              ).sort((a, b) => b.run.portions - a.run.portions);

              const isDropTarget = editMode && dragging && dropTarget === d;
              return (
                <div key={d}
                  onDragOver={editMode && dragging ? e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dropTarget !== d) setDropTarget(d); } : undefined}
                  onDragLeave={editMode && dragging ? () => setDropTarget(t => t === d ? null : t) : undefined}
                  onDrop={editMode && dragging ? onDayDrop(d) : undefined}
                  className={`card border p-3 ${isDropTarget ? "border-cyan-400 ring-2 ring-cyan-300" : l.overCapacity ? "border-rose-300 bg-rose-50/30" : "border-slate-200"}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold text-slate-800">{DAY_LABELS[d]} ({d})</div>
                      <div className="text-[10px] text-slate-500">{l.lines}L · {l.availableHours}h · {fmtNum(l.portions)} P</div>
                    </div>
                    <div className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${l.overCapacity ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
                      {l.neededHours}h / {l.availableHours}h
                    </div>
                  </div>

                  <ShiftBar load={l} />

                  {l.shiftLoads && (
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                      <div className="rounded border border-blue-200 bg-blue-50/50 p-1.5">
                        <div className="font-bold text-blue-700">Frühschicht</div>
                        <div className="font-mono text-blue-900">{fmtNum(frueh?.portions ?? 0)} P · {frueh?.neededHours ?? 0}h/{frueh?.availableHours ?? 0}h</div>
                      </div>
                      <div className="rounded border border-amber-200 bg-amber-50/50 p-1.5">
                        <div className="font-bold text-amber-700">Spätschicht</div>
                        <div className="font-mono text-amber-900">{fmtNum(spaet?.portions ?? 0)} P · {spaet?.neededHours ?? 0}h/{spaet?.availableHours ?? 0}h</div>
                      </div>
                    </div>
                  )}

                  <div className="mt-2 space-y-0.5">
                    {dayMeals.map(({ code, name, run, seafood, subMealCount }) => {
                      const shiftTone = run.shift === "spät" ? "border-amber-200 bg-amber-50" : run.shift === "früh" ? "border-blue-200 bg-blue-50" : "border-slate-100 bg-slate-50";
                      const shiftLabel = run.shift === "früh" ? "F" : run.shift === "spät" ? "S" : "";
                      const feas = feasibilityByDay.get(d)?.get(`${code}-R${run.runIndex}`);
                      const plated = platedByCode.get(code) ?? 0;
                      const isActive = redzone?.isPlatingNow(code) ?? false;
                      const prod = producibility.byRecipeCode.get(code);
                      const headcount = subMealCount > 0 ? subMealCount + 1 : null;
                      const isDragged = dragging?.kind === "run" && dragging.code === code && dragging.runIndex === run.runIndex;
                      const isDone = run.donePortions != null;
                      const isCF = run.isCarryForward === true;
                      const panelOpen = editMode && splitRun?.code === code && splitRun.runIndex === run.runIndex;
                      return (
                        <div key={`${code}-R${run.runIndex}`}>
                          <div
                            draggable={editMode}
                            onDragStart={editMode ? onDragStart({ kind: "run", code, runIndex: run.runIndex, fromDay: d }) : undefined}
                            onDragEnd={editMode ? onDragEnd : undefined}
                            className={`flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[10px] ${shiftTone} ${editMode ? "cursor-grab active:cursor-grabbing" : ""} ${isDragged ? "opacity-40" : ""}`}>
                            {editMode && <span className="text-slate-300">⠿</span>}
                            {shiftLabel && <span className={`rounded px-1 py-0.5 text-[8px] font-bold ${run.shift === "spät" ? "bg-amber-200 text-amber-800" : "bg-blue-200 text-blue-800"}`}>{shiftLabel}</span>}
                            {run.isBackfill && <span className="rounded bg-violet-200 px-1 py-0.5 text-[8px] font-bold text-violet-800" title="Aus einem Backfill-Bedarf angelegt">BF</span>}
                            {isCF && <span className="rounded bg-amber-200 px-1 py-0.5 text-[8px] font-bold text-amber-800" title={`Nachhol-Run${run.carryFromDay ? ` — aus ${DAY_LABELS[run.carryFromDay]} nicht geschafft` : ""}`}>↪</span>}
                            <span className="font-bold text-blue-500 text-[8px]">R{run.runIndex}</span>
                            <span className="font-mono font-semibold">{code}</span>
                            <span className="truncate text-slate-600">{name}</span>
                            {seafood && <span className="text-sky-500">🐟</span>}
                            {isDone ? (
                              <span className="ml-auto font-mono" title={`Ist ${fmtNum(run.portions)} von ${fmtNum(run.plannedPortions ?? run.portions)} geplant`}>
                                <span className="font-bold text-emerald-600">{fmtNum(run.portions)}</span>
                                {run.plannedPortions != null && run.plannedPortions !== run.portions && (
                                  <span className="ml-0.5 text-slate-300 line-through">{fmtNum(run.plannedPortions)}</span>
                                )}
                              </span>
                            ) : (
                              <span className="ml-auto font-mono font-bold">{fmtNum(run.portions)}</span>
                            )}
                            {headcount != null && (
                              <span className="font-mono text-slate-500" title={`Besetzung: ${subMealCount} Sub-Meals + 1 Person = ${headcount}`}>
                                👤{headcount}
                              </span>
                            )}
                            {feas && (feas.fits
                              ? <span className="text-emerald-600" title="Passt in die Kapazität dieser Schicht/dieses Tages">✓</span>
                              : <span className="font-bold text-rose-600" title={`${fmtNum(feas.overflowPortions)} Portionen sprengen die Kapazität dieser Schicht/dieses Tages`}>⚠−{fmtNum(feas.overflowPortions)}</span>
                            )}
                            {isActive && <span className="animate-pulse text-rose-500" title="Wird laut Redzone Live gerade plaitiert">🔴</span>}
                            {!isActive && plated > 0 && (
                              <span className="font-mono text-slate-400" title="Laut Redzone Live heute bereits plaitiert">{fmtNum(plated)}✓</span>
                            )}
                            {prod && (
                              <span className={PROD_STATUS_TONE[prod.status]}
                                title={`Transparency Plan: ${prod.status}${prod.blockedReasons.length ? " — " + prod.blockedReasons.join(", ") : ""}`}>●</span>
                            )}
                            {editMode && !isCF && !isDone && (
                              <button type="button" onClick={() => setSplitRun({ code, runIndex: run.runIndex })}
                                className="rounded border border-slate-300 px-1 text-[8px] font-semibold text-slate-500 hover:border-rose-300 hover:text-rose-600"
                                title="An diesem Tag nicht geschafft — Rest auf einen anderen Tag legen">
                                nicht geschafft
                              </button>
                            )}
                            {editMode && isDone && (
                              <button type="button" onClick={() => clearRunUnfinished(code, run.runIndex)}
                                className="rounded border border-slate-300 px-1 text-[8px] font-semibold text-slate-500 hover:text-slate-700"
                                title="Nicht-geschafft-Markierung zurücknehmen — Run zurück auf die geplante Menge">
                                ↩
                              </button>
                            )}
                            {editMode && isCF && run.carryFromRun != null && (
                              <button type="button" onClick={() => clearRunUnfinished(code, run.carryFromRun!)}
                                className="rounded border border-amber-300 px-1 text-[8px] font-semibold text-amber-700 hover:bg-amber-100"
                                title={`Nachhol-Run auflösen — zurück auf ${run.carryFromDay ? DAY_LABELS[run.carryFromDay] : "den Ursprungstag"}`}>
                                ↩ auflösen
                              </button>
                            )}
                          </div>
                          {panelOpen && (
                            <UnfinishedPanel
                              code={code} runIndex={run.runIndex} fromDay={d}
                              plannedPortions={run.plannedPortions ?? run.portions}
                              platedHint={plated}
                              suggestedDay={suggestCarryForwardDay(plan, d, run.portions)}
                              onCancel={() => setSplitRun(null)}
                              onSubmit={(produced, toDay) => { markRunUnfinished(code, run.runIndex, produced, toDay); setSplitRun(null); }}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Regeln-Info */}
          <div className="text-[10px] text-slate-400 leading-relaxed">
            Regeln: Demand = BENL+NORD+DE · ≤{fmtNum(plan.params.singleRunMaxDemand)} → 1 Run (+{Math.round(plan.params.singleRunBuffer * 100)}%) · &gt;{fmtNum(plan.params.singleRunMaxDemand)} → 2 Runs (+{Math.round(plan.params.multiRunBuffer * 100)}%), Run 1 = {Math.round(plan.params.firstRunPct * 100)}%.
            Seafood so spät wie möglich · Komplex (cx≥1.15) → früh · Einfach (cx≤0.80) → flexibel/Mo.
            Bei 2 Schichten: Frühschicht füllen bis Kapazität, Spätschicht = Differenz.
            <br />
            <span className="text-amber-600">„nicht geschafft"</span> (Bearbeiten-Modus): Ist-Menge am Tag erfassen, der Rest wandert als <span className="font-bold text-amber-700">↪ Nachhol-Run</span> auf den gewählten Tag. „Neu generieren" verwirft diese Ist-Nachführung.
          </div>
        </>
      )}
    </div>
  );
}
