import { useEffect, useMemo, useState } from "react";
import type { DataBundle } from "../../core/types";
import { fmtNum } from "../../lib/helpers";
import { usePlatingWeekPlan } from "./usePlatingWeekPlan";
import { summarizeDayPlan } from "./platingDayLogic";
import {
  PLATING_DAYS,
  type PlatingDay, type PlatingDayPlan, type PlatingLinePlan, type PlatingSlot, type ProteinType,
} from "./platingPlanTypes";

const PROD_DAYS: PlatingDay[] = ["Mo", "Di", "Mi", "Do", "Fr", "Sa"];

const PROTEIN_TONE: Record<ProteinType, string> = {
  chicken: "bg-amber-100 text-amber-800",
  beef:    "bg-rose-100 text-rose-800",
  pork:    "bg-pink-100 text-pink-800",
  seafood: "bg-sky-100 text-sky-800",
  veggie:  "bg-lime-100 text-lime-800",
  other:   "bg-slate-100 text-slate-600",
};

const ROLE_LABEL: Record<PlatingLinePlan["role"], string> = {
  highrunner: "HIGHRUNNER", flex: "FLEX", overload: "OVERLOAD",
};
const ROLE_TONE: Record<PlatingLinePlan["role"], string> = {
  highrunner: "bg-verden-100 text-verden-800",
  flex: "bg-slate-100 text-slate-600",
  overload: "bg-orange-100 text-orange-700",
};

function fmtClock(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

interface SlotEdit {
  lineCount: number;
  isFirst: boolean;
  isLast: boolean;
  onMove: (dir: -1 | 1) => void;
  onToLine: (line: number) => void;
}

/** Ein Slot als proportional breiter Block; davor ggf. der Changeover-Streifen. */
function SlotBlock({ slot, pxPerMin, edit }: { slot: PlatingSlot; pxPerMin: number; edit?: SlotEdit }) {
  const w = Math.max(edit ? 62 : 46, Math.round((slot.endMin - slot.startMin) * pxPerMin));
  return (
    <div className="flex items-stretch">
      {slot.changeoverBeforeMin > 0 && (
        <div
          className="flex items-center justify-center border-y border-dashed border-slate-300 bg-[repeating-linear-gradient(45deg,#f1f5f9,#f1f5f9_4px,#e2e8f0_4px,#e2e8f0_8px)] text-[8px] font-bold text-slate-500"
          style={{ width: Math.max(18, Math.round(slot.changeoverBeforeMin * pxPerMin)) }}
          title={`${slot.changeoverReason === "protein" ? "Protein-Wechsel" : "Allergen-Wechsel"} — ${slot.changeoverBeforeMin} min`}
        >
          +{slot.changeoverBeforeMin}
        </div>
      )}
      <div
        className={`rounded border px-1 py-0.5 text-[9px] leading-tight ${slot.carryOver ? "border-amber-400 bg-amber-50" : "border-slate-200 bg-white"}`}
        style={{ width: w }}
        title={`${slot.code} ${slot.name}\n${fmtClock(slot.startMin)}–${fmtClock(slot.endMin)} · ${fmtNum(slot.portions)} P${slot.allergens ? `\nAllergene: ${slot.allergens}` : ""}`}
      >
        <div className="flex items-center gap-0.5">
          <span className="font-mono font-semibold text-slate-700">{slot.code}</span>
          {slot.seafood && <span>🐟</span>}
        </div>
        <div className="truncate text-slate-500">{slot.name}</div>
        <div className="flex items-center justify-between font-mono">
          <span className="font-semibold text-blue-800">{fmtNum(slot.portions)}</span>
          <span className={`rounded px-0.5 ${PROTEIN_TONE[slot.proteinType]}`}>{slot.proteinType.slice(0, 4)}</span>
        </div>
        {slot.carryOver ? <div className="font-semibold text-amber-700">→ {fmtNum(slot.carryOver)}</div> : null}
        {edit && (
          <div className="mt-0.5 flex items-center justify-between border-t border-slate-100 pt-0.5">
            <button type="button" disabled={edit.isFirst} onClick={() => edit.onMove(-1)}
              className="px-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-20" title="nach vorne">◀</button>
            {edit.lineCount > 1 && (
              <select
                value={""}
                onChange={e => { const v = Number(e.target.value); if (v) edit.onToLine(v); }}
                className="bg-transparent text-[8px] text-slate-400"
                title="auf andere Linie"
              >
                <option value="">L…</option>
                {Array.from({ length: edit.lineCount }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>→L{n}</option>
                ))}
              </select>
            )}
            <button type="button" disabled={edit.isLast} onClick={() => edit.onMove(1)}
              className="px-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-20" title="nach hinten">▶</button>
          </div>
        )}
      </div>
    </div>
  );
}

function LineRow({ line, lineCount, onMoveSlot, onSlotToLine }: {
  line: PlatingLinePlan;
  lineCount: number;
  onMoveSlot?: (seq: number, dir: -1 | 1) => void;
  onSlotToLine?: (seq: number, toLine: number) => void;
}) {
  const usedMin = line.platingMin + line.changeoverMin;
  const pct = line.availableMin > 0 ? Math.round((usedMin / line.availableMin) * 100) : 0;
  const pxPerMin = 900 / Math.max(line.availableMin, usedMin, 60); // Zeitachse auf ~900px normieren
  return (
    <div className={`rounded-lg border p-2 ${line.overCapacity ? "border-rose-300 bg-rose-50/40" : "border-slate-200 bg-white"}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px]">
        <span className="font-bold text-slate-700">Linie {line.line}</span>
        <span className={`rounded px-1 py-0.5 font-semibold ${ROLE_TONE[line.role]}`}>{ROLE_LABEL[line.role]}</span>
        <span className="text-slate-500">
          {line.slots.length} Meals · {line.changeovers} Wechsel ({line.changeoverMin} min)
        </span>
        <span className={`ml-auto font-mono font-semibold ${line.overCapacity ? "text-rose-600" : pct > 90 ? "text-amber-600" : "text-slate-600"}`}>
          {fmtClock(usedMin)} / {fmtClock(line.availableMin)} ({pct}%){line.overCapacity ? " ⚠" : ""}
        </span>
      </div>
      {line.slots.length ? (
        <div className="flex items-stretch gap-0.5 overflow-x-auto pb-1">
          {line.slots.map((s, i) => (
            <SlotBlock
              key={`${s.code}-${s.runIndex}-${i}`}
              slot={s}
              pxPerMin={pxPerMin}
              edit={onMoveSlot && onSlotToLine ? {
                lineCount, isFirst: i === 0, isLast: i === line.slots.length - 1,
                onMove: dir => onMoveSlot(i, dir),
                onToLine: toLine => onSlotToLine(i, toLine),
              } : undefined}
            />
          ))}
        </div>
      ) : (
        <div className="py-2 text-center text-[10px] text-slate-400">leer</div>
      )}
    </div>
  );
}

export function PlatingDayView({ data, week }: { data: DataBundle; week: string }) {
  const { plan, loading, dirty, regenerateDailyPlans, updateDayPlan } = usePlatingWeekPlan(data, week);
  const [day, setDay] = useState<PlatingDay>("Di");
  const [editMode, setEditMode] = useState(false);

  /** Slot innerhalb einer Linie um eine Position verschieben. */
  const moveSlot = (lineNo: number, seq: number, dir: -1 | 1) => {
    updateDayPlan(day, dp => {
      const lines = dp.lines.map(l => {
        if (l.line !== lineNo) return l;
        const slots = [...l.slots];
        const j = seq + dir;
        if (j < 0 || j >= slots.length) return l;
        [slots[seq], slots[j]] = [slots[j], slots[seq]];
        return { ...l, slots };
      });
      return { ...dp, lines };
    });
  };
  /** Slot auf eine andere Linie ans Ende verschieben. */
  const slotToLine = (fromLine: number, seq: number, toLine: number) => {
    if (fromLine === toLine) return;
    updateDayPlan(day, dp => {
      const moved = dp.lines.find(l => l.line === fromLine)?.slots[seq];
      if (!moved) return dp;
      const lines = dp.lines.map(l => {
        if (l.line === fromLine) return { ...l, slots: l.slots.filter((_, i) => i !== seq) };
        if (l.line === toLine) return { ...l, slots: [...l.slots, moved] };
        return l;
      });
      return { ...dp, lines };
    });
  };

  const availableDays = useMemo(
    () => PROD_DAYS.filter(d => (plan?.dayCapacity[d]?.lines ?? 0) > 0 || plan?.dailyPlans?.[d]),
    [plan],
  );
  useEffect(() => {
    if (availableDays.length && !availableDays.includes(day)) setDay(availableDays[0]);
  }, [availableDays, day]);

  const daily = useMemo(() => plan?.dailyPlans ?? {}, [plan]);
  const dp = daily[day];
  const hasAnyDaily = Object.keys(daily).length > 0;
  const runsOnDay = useMemo(
    () => (plan?.meals ?? []).reduce((n, m) => n + m.runs.filter(r => r.day === day && r.portions > 0).length, 0),
    [plan, day],
  );

  const totalCarryOut = useMemo(
    () => PLATING_DAYS.reduce((n, d) => n + (daily[d]?.carryOutToNext.reduce((s, c) => s + c.portions, 0) ?? 0), 0),
    [daily],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-cyan-800">Täglicher Linienplan</div>
          <h1 className="text-xl font-bold text-slate-950">Plating Tag · {week}</h1>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {dirty && <span className="text-amber-600">speichert…</span>}
          {hasAnyDaily && (
            <button
              type="button"
              onClick={() => setEditMode(e => !e)}
              className={`rounded-lg border px-2 py-1.5 font-semibold ${editMode ? "border-cyan-400 bg-cyan-50 text-cyan-800" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
            >
              {editMode ? "✓ Sortieren" : "✎ Sortieren"}
            </button>
          )}
          <button
            type="button"
            onClick={regenerateDailyPlans}
            disabled={!plan}
            className="rounded-lg bg-verden-600 px-3 py-1.5 font-semibold text-white hover:bg-verden-500 disabled:opacity-40"
          >
            {hasAnyDaily ? "Tagespläne neu generieren" : "Tagespläne generieren"}
          </button>
        </div>
      </div>

      <p className="text-[11px] text-slate-500">
        Aus den im Wochenplan verplanten Runs: je Tag auf die Plating-Linien sequenziert, Umrüsten minimiert
        (Allergen {plan?.params.changeoverAllergenMin ?? 30} min · Protein-Typ {plan?.params.changeoverProteinMin ?? 60} min).
        Linie 1 = Highrunner (Volumen zuerst), Linie 2 = Flex, Linie 3 = nur bei Overload. Was nicht in die
        Schicht passt, wandert als Carry-over auf den Folgetag. Sequenz/Params im Wochenplan-Tab ändern, dann neu generieren.
      </p>

      {loading && <div className="card p-8 text-center text-slate-400">Lädt…</div>}

      {!loading && !plan && (
        <div className="card p-8 text-center text-slate-500">
          Noch kein Wochen-Plating-Plan für {week}. Erst im Tab „Plating-Plan" generieren.
        </div>
      )}

      {plan && !hasAnyDaily && (
        <div className="card p-8 text-center text-slate-500">
          „Tagespläne generieren" baut aus dem Wochenplan die Linienpläne für alle Produktionstage.
        </div>
      )}

      {plan && hasAnyDaily && (
        <>
          <div className="flex flex-wrap gap-1">
            {availableDays.map(d => {
              const s = daily[d] ? summarizeDayPlan(daily[d]!) : null;
              const over = s && s.linesOver > 0;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDay(d)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                    d === day ? "border-verden-500 bg-verden-50 text-verden-800"
                      : over ? "border-rose-300 bg-rose-50 text-rose-700"
                      : "border-slate-300 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {d}{s ? ` · ${fmtNum(s.totalPortions)}` : ""}{over ? " ⚠" : ""}
                </button>
              );
            })}
            {totalCarryOut > 0 && (
              <span className="ml-auto self-center text-[11px] font-semibold text-amber-600">
                Woche gesamt Carry-over: {fmtNum(totalCarryOut)} P
              </span>
            )}
          </div>

          {!dp && (
            <div className="card p-6 text-center text-slate-400">
              {runsOnDay ? "Für diesen Tag noch nicht generiert." : "Keine Runs an diesem Tag."}
            </div>
          )}

          {dp && (
            <div className="space-y-2">
              {dp.carryInFromPrev.length > 0 && (
                <div className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-[11px] text-sky-800">
                  <span className="font-semibold">Carry-in vom Vortag:</span>{" "}
                  {dp.carryInFromPrev.map(c => `${c.code} ${fmtNum(c.portions)} P`).join(" · ")}
                </div>
              )}

              {dp.lines.length === 0 && (
                <div className="card p-6 text-center text-slate-400">Keine Linien-Kapazität an diesem Tag.</div>
              )}
              {editMode && (
                <div className="text-[10px] text-cyan-700">
                  Sortier-Modus: ◀ ▶ verschiebt einen Slot in der Linie, „→L…" auf eine andere Linie.
                  Zeiten, Umrüsten und Carry-over rechnen sich neu. Für die Tag-zu-Tag-Weitergabe „Tagespläne neu generieren".
                </div>
              )}
              {dp.lines.map(l => (
                <LineRow
                  key={l.line}
                  line={l}
                  lineCount={dp.lines.length}
                  onMoveSlot={editMode ? (seq, dir) => moveSlot(l.line, seq, dir) : undefined}
                  onSlotToLine={editMode ? (seq, to) => slotToLine(l.line, seq, to) : undefined}
                />
              ))}

              {dp.carryOutToNext.length > 0 && (
                <div className={`rounded-lg border p-2 text-[11px] ${
                  day === "Sa" ? "border-rose-300 bg-rose-50 text-rose-800" : "border-amber-300 bg-amber-50 text-amber-800"
                }`}>
                  <span className="font-semibold">
                    {day === "Sa" ? "⚠ Carry-over am Samstag — kein Folgetag:" : "Carry-over → Folgetag:"}
                  </span>{" "}
                  {dp.carryOutToNext.map(c => `${c.code} ${fmtNum(c.portions)} P`).join(" · ")}
                </div>
              )}

              <DaySummary dp={dp} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DaySummary({ dp }: { dp: PlatingDayPlan }) {
  const s = summarizeDayPlan(dp);
  return (
    <div className="rounded-lg bg-slate-50 p-2 text-[10px] text-slate-500">
      {fmtNum(s.totalPortions)} Portionen · {s.slots} Slots · {s.changeovers} Umrüstungen ({s.changeoverMin} min gesamt)
      {s.linesOver > 0 && <span className="font-semibold text-rose-600"> · {s.linesOver} Linie(n) über Kapazität</span>}
      {s.carryOut > 0 && <span className="font-semibold text-amber-600"> · {fmtNum(s.carryOut)} P Carry-over</span>}
    </div>
  );
}
