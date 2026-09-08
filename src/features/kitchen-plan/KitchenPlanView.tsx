import { useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle } from "../../core/types";
import { fmtNum } from "../../lib/helpers";
import type { PlatingDay } from "../plating-plan/platingPlanTypes";
import { useKitchenPlan } from "./useKitchenPlan";
import { summarizeKitchenPlan } from "./kitchenPlanLogic";
import { KITCHEN_AREA_COLORS } from "./kitchenAreas";
import {
  KITCHEN_DAYS, type KitchenBlock, type KitchenShift, type KitchenSubJob, type KitchenPlanParams,
} from "./kitchenPlanTypes";

const DAY_LABEL: Record<PlatingDay, string> = {
  So: "Sonntag", Mo: "Montag", Di: "Dienstag", Mi: "Mittwoch", Do: "Donnerstag", Fr: "Freitag", Sa: "Samstag",
};
const SHIFT_LABEL: Record<KitchenShift, string> = { früh: "Frühschicht", spät: "Spätschicht", tag: "Tag" };
const SHIFT_TONE: Record<KitchenShift, string> = {
  früh: "border-blue-300 bg-blue-50",
  spät: "border-amber-300 bg-amber-50",
  tag: "border-violet-300 bg-violet-50",
};

function fmtH(min: number): string {
  return `${Math.round(min / 6) / 10} h`;
}
function fmtClock(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

function ParamNum({ label, value, step, min, max, onCommit }: {
  label: string; value: number; step: number; min: number; max: number; onCommit: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1">
      <span className="text-slate-600">{label}</span>
      <input
        key={value} type="number" defaultValue={value} step={step} min={min} max={max}
        onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== value) onCommit(v); }}
        className="w-16 rounded border border-slate-200 px-1 text-right font-mono font-semibold"
      />
    </label>
  );
}

function AllergenChips({ raw }: { raw: string }) {
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (!list.length) return <span className="text-[9px] font-semibold text-emerald-600">allergenfrei</span>;
  return (
    <span className="flex flex-wrap gap-0.5">
      {list.map(a => (
        <span key={a} className="rounded bg-rose-50 px-1 text-[9px] font-semibold text-rose-700 ring-1 ring-rose-100">{a}</span>
      ))}
    </span>
  );
}

interface Dnd {
  dragSubId: string | null;
  dragArea: string | null;
  hint: string | null;
  start: (job: KitchenSubJob) => void;
  end: () => void;
  hover: (key: string | null) => void;
  dropReorder: (shift: KitchenShift, area: string, index: number) => void;
}

/** Schmale Ablage-Zone zwischen zwei Job-Zeilen (nur aktiv, wenn der gezogene
 *  Job zur selben Station gehört). */
function DropZone({ dnd, shift, area, index }: { dnd: Dnd; shift: KitchenShift; area: string; index: number }) {
  const active = !!dnd.dragSubId && dnd.dragArea === area;
  const key = `${shift}:${area}:${index}`;
  const hot = active && dnd.hint === key;
  return (
    <div
      onDragOver={e => { if (active) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; dnd.hover(key); } }}
      onDrop={e => { if (active) { e.preventDefault(); dnd.dropReorder(shift, area, index); } }}
      className={`h-1.5 rounded transition-all ${hot ? "h-3 bg-cyan-400" : active ? "bg-cyan-100" : ""}`}
      aria-hidden
    />
  );
}

function ChangeoverStrip({ job }: { job: KitchenSubJob }) {
  if (!job.changeoverBeforeMin) return null;
  const easy = job.changeoverKind === "easy";
  return (
    <div
      className={`ml-4 my-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold ${
        easy ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
          : "bg-[repeating-linear-gradient(45deg,#fee2e2,#fee2e2_4px,#fecaca_4px,#fecaca_8px)] text-rose-700 ring-1 ring-rose-300"
      }`}
      title={easy ? "Nur Allergen zugefügt — kurze Rüstzeit" : "Allergen weggefallen — volle Reinigung"}
    >
      {easy ? "~" : "🧽"} {job.changeoverBeforeMin} min {easy ? "Rüsten" : "Reinigung"}
    </div>
  );
}

function JobRow({ job, dnd, onClearOverride }: {
  job: KitchenSubJob; dnd: Dnd; onClearOverride: () => void;
}) {
  const beingDragged = dnd.dragSubId === job.subRecipeId;
  return (
    <div
      draggable
      onDragStart={e => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", job.subRecipeId); dnd.start(job); }}
      onDragEnd={dnd.end}
      className={`grid grid-cols-[1fr_auto] items-start gap-2 rounded border px-2 py-1.5 text-[11px] cursor-grab active:cursor-grabbing ${
        beingDragged ? "opacity-40 " : ""
      }${job.critical ? "border-rose-200 bg-rose-50/40" : "border-slate-200 bg-white"}`}
      title={`${job.subRecipeName}\n${job.cookMethod}${job.scheduleSteps.length ? "\n" + job.scheduleSteps.map(s => `−${s.shiftsBefore}: ${s.label}`).join("  ") : ""}\n${fmtClock(job.startMin)}–${fmtClock(job.endMin)}  ·  ziehen zum Verschieben`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-slate-300">⠿</span>
          <span className="font-semibold text-slate-800 truncate">{job.subRecipeName}</span>
          {job.critical && <span title="Seafood / komplexes Meal — harte Deadline">🐟</span>}
          {job.longPrep && <span className="rounded bg-violet-100 px-1 text-[8px] font-bold text-violet-700" title="Langer Vorlauf (Sauce/Marinade/Brine/Spice)">LANG</span>}
          {job.cookShifts > 1 && (
            <span className="rounded bg-slate-100 px-1 text-[8px] font-bold text-slate-500" title={`${job.cookShifts} Kochschichten Vorlauf`}>{job.cookShifts}S</span>
          )}
          {job.overridden && (
            <button
              type="button"
              onClick={onClearOverride}
              className="rounded bg-cyan-100 px-1 text-[8px] font-bold text-cyan-700 hover:bg-cyan-200"
              title="Von Hand verschoben — klicken zum Zurücksetzen"
            >✎ fix</button>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
          <span>für {job.feedsMeals.map(m => m.code).join(", ")}</span>
          <span className="text-slate-300">·</span>
          <span title="Plating-Tag(e)">→ Plating {job.platingDays.join("/")}</span>
          <span className="text-slate-300">·</span>
          <span className="font-mono">{fmtClock(job.startMin)}–{fmtClock(job.endMin)}</span>
        </div>
        <div className="mt-0.5"><AllergenChips raw={job.allergens} /></div>
      </div>
      <div className="text-right font-mono">
        <div className="font-semibold text-slate-800">{fmtNum(job.portions)} P</div>
        <div className="text-slate-500">{fmtNum(job.kg)} kg</div>
        <div className="text-slate-400">{job.batches}× Batch</div>
      </div>
    </div>
  );
}

function BlockCard({ block, dnd, onAutoSort, onClearOverride }: {
  block: KitchenBlock; dnd: Dnd;
  onAutoSort: () => void;
  onClearOverride: (subId: string) => void;
}) {
  const c = KITCHEN_AREA_COLORS[block.area];
  const anyManual = block.jobs.some(j => j.manualOrder);
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <div className={`flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-[11px] font-bold ${c.header}`}>
        <span className="flex items-center gap-2">
          {block.area}
          {block.cleanCount > 0
            ? <span className="rounded bg-white/25 px-1 text-[9px]" title="Volle Reinigungen (Allergen-Wegfall)">{block.cleanCount} 🧽</span>
            : <span className="rounded bg-white/25 px-1 text-[9px]">0 Reinig.</span>}
          {block.easyCount > 0 && <span className="rounded bg-white/25 px-1 text-[9px]">+{block.easyCount} ~</span>}
        </span>
        <span className="flex items-center gap-2 font-mono font-semibold">
          {fmtNum(block.kg)} kg · {block.batches} B · {fmtH(block.neededMin)}/{fmtH(block.availableMin)}
          {block.overCapacity ? " ⚠" : ""}
          {anyManual && (
            <button type="button" onClick={onAutoSort}
              className="rounded bg-white/25 px-1 text-[9px] font-bold hover:bg-white/40" title="Reihenfolge wieder allergen-automatisch">
              ↺ Auto
            </button>
          )}
        </span>
      </div>
      <div className="space-y-0.5 bg-slate-50/60 p-2">
        <DropZone dnd={dnd} shift={block.shift} area={block.area} index={0} />
        {block.jobs.map((job, i) => (
          <div key={job.key}>
            <ChangeoverStrip job={job} />
            <JobRow job={job} dnd={dnd} onClearOverride={() => onClearOverride(job.subRecipeId)} />
            <DropZone dnd={dnd} shift={block.shift} area={block.area} index={i + 1} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function KitchenPlanView({ data, week }: { data: DataBundle; week: string }) {
  const {
    kitchenPlan, platingPlan, params, loading, dirty,
    moveJob, reorderBlock, autoSortBlock, clearOverride, clearAllOverrides, setParams,
  } = useKitchenPlan(data, week);

  const [day, setDay] = useState<PlatingDay>("Mo");
  const [showParams, setShowParams] = useState(false);
  const [drag, setDrag] = useState<{ subId: string; area: string } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const dragRef = useRef<{ subId: string; area: string } | null>(null);

  const availableDays = useMemo(() => KITCHEN_DAYS.filter(d => kitchenPlan?.days[d]), [kitchenPlan]);
  useEffect(() => {
    if (availableDays.length && !availableDays.includes(day)) setDay(availableDays[0]);
  }, [availableDays, day]);

  const kpi = useMemo(() => (kitchenPlan ? summarizeKitchenPlan(kitchenPlan) : null), [kitchenPlan]);
  const overrideCount = kitchenPlan ? Object.keys(kitchenPlan.overrides).length : 0;
  const dp = kitchenPlan?.days[day];

  const reset = () => { dragRef.current = null; setDrag(null); setHint(null); };

  const dnd: Dnd = {
    dragSubId: drag?.subId ?? null,
    dragArea: drag?.area ?? null,
    hint,
    start: (job) => { const d = { subId: job.subRecipeId, area: job.area }; dragRef.current = d; setDrag(d); },
    end: reset,
    hover: setHint,
    dropReorder: (shift, area, index) => {
      const src = dragRef.current ?? drag;
      if (!src || !dp) { reset(); return; }
      const block = dp.shifts.find(s => s.shift === shift)?.blocks.find(b => b.area === area);
      const ids = (block?.jobs.map(j => j.subRecipeId) ?? []).filter(id => id !== src.subId);
      const clamped = Math.max(0, Math.min(index, ids.length));
      ids.splice(clamped, 0, src.subId);
      reorderBlock(day, shift, ids);
      reset();
    },
  };

  const dropOnDay = (target: PlatingDay) => {
    const src = dragRef.current ?? drag;
    reset();
    if (src) moveJob(src.subId, target);
  };
  const dropOnShift = (shift: KitchenShift) => {
    const src = dragRef.current ?? drag;
    reset();
    if (src) moveJob(src.subId, day, shift);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-cyan-800">Küche rückwärts geplant</div>
          <h1 className="text-xl font-bold text-slate-950">Kochplan · {week}</h1>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {dirty && <span className="text-amber-600">speichert…</span>}
          {overrideCount > 0 && (
            <button type="button" onClick={clearAllOverrides}
              className="rounded-lg border border-slate-300 px-2 py-1.5 font-semibold text-slate-600 hover:bg-slate-50">
              {overrideCount} Override{overrideCount === 1 ? "" : "s"} zurücksetzen
            </button>
          )}
          <button type="button" onClick={() => setShowParams(s => !s)}
            className={`rounded-lg border px-2 py-1.5 font-semibold ${showParams ? "border-cyan-400 bg-cyan-50 text-cyan-800" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
            ⚙ Parameter
          </button>
        </div>
      </div>

      <p className="text-[11px] text-slate-500">
        Küchentag = Plating-Tag − Vorlauf (aus dem Cook Schedule).
        {params.saucesToSunday && <> <b>Sonntag (eine Schicht)</b> = die längste Vorarbeit vorab: Mehrschicht-Prozesse (Brine / Marinade / Slow-Cook / Thaw) + Halt-Komponenten (Sauce / Butter / Spice), für Runs die bis <b>{params.sundayCutoffDay}</b> geplatet werden. Passt eine Station nicht mehr in die Sonntag-Schicht, wandert der kürzeste Rest auf Montag.</>}
        {" "}Sa ist die Küche zu. Innerhalb jeder Station <b>allergen-aufsteigend</b> sequenziert (wenig → viele Allergene) —
        <span className="text-amber-600"> ~ nur zufügen</span> = kurze Rüstzeit, <span className="text-rose-600">🧽 Allergen weg</span> = volle Reinigung.
        Sub-Meal ziehen: auf einen Tag / eine Schicht = verschieben, zwischen zwei Zeilen = Reihenfolge fixieren.
      </p>

      {showParams && (
        <div className="card space-y-2 border-cyan-200 bg-cyan-50/40 p-3 text-[11px]">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {([1, 2, 3] as const).map(s => (
              <ParamNum key={s} label={`Vorlauf ${s} Shift${s > 1 ? "s" : ""} (Tage)`} value={params.leadDaysByShift[s]} step={1} min={0} max={6}
                onCommit={v => setParams({ leadDaysByShift: { ...params.leadDaysByShift, [s]: v } as KitchenPlanParams["leadDaysByShift"] })} />
            ))}
            <ParamNum label="Lange Prozesse (3 Shifts) vorziehen (+Tage)" value={params.longPrepExtraLeadDays} step={1} min={0} max={5}
              onCommit={v => setParams({ longPrepExtraLeadDays: v })} />
            <ParamNum label="Reinigung Allergen weg (min)" value={params.changeoverCleanMin} step={5} min={0} max={120}
              onCommit={v => setParams({ changeoverCleanMin: v })} />
            <ParamNum label="Rüsten nur zufügen (min)" value={params.changeoverEasyMin} step={5} min={0} max={60}
              onCommit={v => setParams({ changeoverEasyMin: v })} />
            <ParamNum label="Aktive Min / Station / Werktag-Schicht" value={params.weekdayShiftMin} step={30} min={60} max={2000}
              onCommit={v => setParams({ weekdayShiftMin: v })} />
            <ParamNum label="Aktive Min / Station / Sonntag" value={params.sundayShiftMin} step={30} min={60} max={2000}
              onCommit={v => setParams({ sundayShiftMin: v })} />
            <label className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1">
              <span className="text-slate-600">Sonntag = längste Vorarbeit vorbereiten</span>
              <input type="checkbox" checked={params.saucesToSunday}
                onChange={e => setParams({ saucesToSunday: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1">
              <span className="text-slate-600">Sonntag nur für Runs bis Plating-Tag</span>
              <select value={params.sundayCutoffDay} disabled={!params.saucesToSunday}
                onChange={e => setParams({ sundayCutoffDay: e.target.value as typeof params.sundayCutoffDay })}
                className="rounded border border-slate-200 px-1 font-mono font-semibold disabled:opacity-40">
                {(["Mo", "Di", "Mi", "Do", "Fr"] as const).map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1">
              <span className="text-slate-600">Mo–Fr Früh + Spät</span>
              <input type="checkbox" checked={params.dualShiftWeekdays}
                onChange={e => setParams({ dualShiftWeekdays: e.target.checked })} />
            </label>
          </div>
          <div className="text-[10px] text-slate-500">
            „Aktive Min / Station / Schicht" ist nur die Überlast-Ampel je Bereich (Σ Minuten/Batch × Batches + Rüsten) — kein hartes Limit.
          </div>
        </div>
      )}

      {loading && <div className="card p-8 text-center text-slate-400">Lädt Kochplan…</div>}

      {!loading && !platingPlan && (
        <div className="card p-8 text-center text-slate-500">
          Noch kein Wochen-Plating-Plan für {week}. Erst im Tab „Plating-Plan" generieren — der Kochplan baut darauf auf.
        </div>
      )}

      {!loading && platingPlan && kitchenPlan && kpi && (
        <>
          <div className="flex flex-wrap gap-2 text-[11px]">
            {[
              ["Sub-Meals", kpi.jobs],
              ["kg gesamt", fmtNum(kpi.kg)],
              ["Batches", fmtNum(kpi.batches)],
            ].map(([l, v]) => (
              <div key={l} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5">
                <div className="text-[9px] font-bold uppercase text-slate-400">{l}</div>
                <div className="font-mono font-bold text-slate-800">{v}</div>
              </div>
            ))}
            <div className={`rounded-lg border px-3 py-1.5 ${kpi.cleanings > 0 ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-white"}`}>
              <div className={`text-[9px] font-bold uppercase ${kpi.cleanings > 0 ? "text-rose-500" : "text-slate-400"}`}>Reinigungen</div>
              <div className={`font-mono font-bold ${kpi.cleanings > 0 ? "text-rose-800" : "text-slate-800"}`}>{kpi.cleanings}</div>
            </div>
            {kpi.blocksOver > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5">
                <div className="text-[9px] font-bold uppercase text-rose-500">Stationen über Kapazität</div>
                <div className="font-mono font-bold text-rose-800">{kpi.blocksOver}</div>
              </div>
            )}
          </div>

          {kitchenPlan.unresolvedMeals.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
              Ohne Sub-Rezept-Stammdaten (nicht im Kochplan): {kitchenPlan.unresolvedMeals.join(", ")}
            </div>
          )}

          {availableDays.length === 0 && (
            <div className="card p-8 text-center text-slate-400">
              Der Plating-Plan hat noch keine verplanten Runs — im Tab „Plating-Plan" die Tage zuweisen.
            </div>
          )}

          {availableDays.length > 0 && (
            <>
              <div className="flex flex-wrap gap-1">
                {KITCHEN_DAYS.map(d => {
                  const pd = kitchenPlan.days[d];
                  const over = !!pd?.shifts.some(s => s.overCapacity);
                  const isDrop = hint === `day:${d}` && !!drag;
                  return (
                    <button
                      key={d} type="button" onClick={() => setDay(d)}
                      onDragOver={e => { if (drag) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setHint(`day:${d}`); } }}
                      onDragLeave={() => setHint(cur => (cur === `day:${d}` ? null : cur))}
                      onDrop={e => { if (drag) { e.preventDefault(); dropOnDay(d); } }}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        isDrop ? "border-cyan-500 bg-cyan-100 text-cyan-900"
                          : d === day ? "border-verden-500 bg-verden-50 text-verden-800"
                          : over ? "border-rose-300 bg-rose-50 text-rose-700"
                          : pd ? "border-slate-300 text-slate-600 hover:bg-slate-50"
                          : "border-slate-200 text-slate-400"
                      }`}
                    >
                      {d}{pd ? ` · ${fmtNum(pd.totalKg)} kg` : " · —"}
                      {pd && pd.cleanCount > 0 ? ` · ${pd.cleanCount}🧽` : ""}{over ? " ⚠" : ""}
                    </button>
                  );
                })}
                {drag && <span className="self-center text-[10px] font-semibold text-cyan-700">→ auf Tag / Schicht / zwischen Zeilen ziehen</span>}
              </div>

              {!dp && (
                <div className="card p-6 text-center text-slate-400">Kein Kochbedarf am {DAY_LABEL[day]}.</div>
              )}

              {dp && (
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold text-slate-600">
                    {DAY_LABEL[day]} · {dp.shiftModel === 2 ? "Früh + Spät" : "eine Schicht"} · {fmtNum(dp.totalKg)} kg · {dp.totalBatches} Batches · {dp.totalJobs} Sub-Meals · {dp.cleanCount} Reinigungen
                  </div>
                  <div className={`grid gap-3 ${dp.shiftModel === 2 ? "lg:grid-cols-2" : ""}`}>
                    {dp.shifts.map(sp => {
                      const isDrop = hint === `shift:${sp.shift}` && !!drag;
                      return (
                        <div
                          key={sp.shift}
                          onDragOver={e => { if (drag) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setHint(`shift:${sp.shift}`); } }}
                          onDragLeave={() => setHint(cur => (cur === `shift:${sp.shift}` ? null : cur))}
                          onDrop={e => { if (drag) { e.preventDefault(); dropOnShift(sp.shift); } }}
                          className={`space-y-2 rounded-xl border-2 p-2 transition-colors ${isDrop ? "border-cyan-400 bg-cyan-50" : SHIFT_TONE[sp.shift]}`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] font-bold text-slate-700">
                            <span>{SHIFT_LABEL[sp.shift]}</span>
                            <span className={`font-mono ${sp.overCapacity ? "text-rose-600" : "text-slate-500"}`}>
                              {fmtNum(sp.kg)} kg · {fmtH(sp.neededMin)} / {fmtH(sp.availableMin)}{sp.overCapacity ? " ⚠" : ""}
                            </span>
                          </div>
                          {sp.blocks.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-slate-300 bg-white/50 py-6 text-center text-[10px] text-slate-400">
                              leer — Sub-Meal auf diese Spalte ziehen
                            </div>
                          ) : sp.blocks.map(b => (
                            <BlockCard
                              key={`${sp.shift}:${b.area}`}
                              block={b} dnd={dnd}
                              onAutoSort={() => autoSortBlock(b.jobs.map(j => j.subRecipeId))}
                              onClearOverride={clearOverride}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
