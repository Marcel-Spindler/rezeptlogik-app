import { useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle } from "../../core/types";
import { fmtNum } from "../../lib/helpers";
import { usePlatingWeekPlan } from "./usePlatingWeekPlan";
import { summarizeDayPlan } from "./platingDayLogic";
import {
  PLATING_DAYS,
  type PlatingDay, type PlatingDayPlan, type PlatingLinePlan, type PlatingSlot,
} from "./platingPlanTypes";

const PROD_DAYS: PlatingDay[] = ["Mo", "Di", "Mi", "Do", "Fr", "Sa"];

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

const CHANGEOVER_LABEL: Record<string, string> = {
  easy: "Easy Changeover (nur Allergen zufügen)",
  allergen: "Reinigung — Allergen weggefallen",
};

/** Drag-&-Drop-Kontext für den „✎ Sortieren"-Modus. */
interface Dnd {
  dragging: { line: number; seq: number } | null;
  dropTarget: { line: number; index: number } | null;
  onSlotDragStart: (line: number, seq: number) => void;
  onSlotDragEnd: () => void;
  onZoneOver: (line: number, index: number) => void;
  onZoneDrop: (line: number, index: number) => void;
}

/** Schmale Ablauf-Zone zwischen zwei Slots (bzw. am Linien-Rand). Nimmt den Drop
 *  an und fügt den gezogenen Slot an genau dieser Position ein. */
function DropZone({ dnd, line, index, full }: { dnd: Dnd; line: number; index: number; full?: boolean }) {
  const active = !!dnd.dragging;
  const hot = active && dnd.dropTarget?.line === line && dnd.dropTarget?.index === index;
  return (
    <div
      onDragOver={e => { if (active) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; dnd.onZoneOver(line, index); } }}
      onDrop={e => { if (active) { e.preventDefault(); dnd.onZoneDrop(line, index); } }}
      className={`shrink-0 self-stretch rounded transition-colors ${
        full ? "flex-1 min-h-[42px]" : active ? "w-3" : "w-1"
      } ${hot ? "bg-cyan-400" : active ? "bg-cyan-100" : ""}`}
      aria-hidden
    />
  );
}

/** Ein Slot als proportional breiter Block; davor ggf. der Changeover-Streifen. */
function SlotBlock({ slot, pxPerMin, dnd, line, seq }: {
  slot: PlatingSlot; pxPerMin: number; dnd?: Dnd; line: number; seq: number;
}) {
  const w = Math.max(46, Math.round((slot.endMin - slot.startMin) * pxPerMin));
  const easy = slot.changeoverReason === "easy";
  const draggable = !!dnd;
  const beingDragged = dnd?.dragging?.line === line && dnd.dragging?.seq === seq;
  return (
    <div className={`flex items-stretch ${beingDragged ? "opacity-40" : ""}`}>
      {slot.changeoverBeforeMin > 0 && (
        <div
          className={`flex items-center justify-center border-y text-[8px] font-bold ${
            easy
              ? "border-dashed border-amber-300 bg-amber-50 text-amber-600"
              : "border-rose-300 bg-[repeating-linear-gradient(45deg,#fee2e2,#fee2e2_4px,#fecaca_4px,#fecaca_8px)] text-rose-700"
          }`}
          style={{ width: Math.max(easy ? 14 : 20, Math.round(slot.changeoverBeforeMin * pxPerMin)) }}
          title={`${CHANGEOVER_LABEL[slot.changeoverReason ?? ""] ?? "Umrüsten"} — ${slot.changeoverBeforeMin} min`}
        >
          {easy ? "~" : "🧽"}{slot.changeoverBeforeMin}
        </div>
      )}
      <div
        draggable={draggable}
        onDragStart={draggable ? e => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", slot.code); // Firefox startet sonst keinen Drag
          dnd!.onSlotDragStart(line, seq);
        } : undefined}
        onDragEnd={draggable ? () => dnd!.onSlotDragEnd() : undefined}
        className={`rounded border px-1 py-0.5 text-[9px] leading-tight ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${
          slot.carryOver ? "border-amber-400 bg-amber-50" : "border-slate-200 bg-white"
        }`}
        style={{ width: w }}
        title={`${slot.code} ${slot.name}\n${fmtClock(slot.startMin)}–${fmtClock(slot.endMin)} · ${fmtNum(slot.portions)} P${slot.allergens ? `\nAllergene: ${slot.allergens}` : ""}${slot.subMeals ? `\n${slot.subMeals} Sub-Meals → ${slot.headcount} MA` : ""}${draggable ? "\n(ziehen zum Umsortieren)" : ""}`}
      >
        <div className="flex items-center gap-0.5">
          {draggable && <span className="text-slate-300">⠿</span>}
          <span className="font-mono font-semibold text-slate-700">{slot.code}</span>
          {slot.seafood && <span>🐟</span>}
        </div>
        <div className="truncate text-slate-500">{slot.name}</div>
        <div className="flex items-center justify-between font-mono">
          <span className="font-semibold text-blue-800">{fmtNum(slot.portions)}</span>
          {slot.headcount > 0 && (
            <span className="rounded bg-slate-100 px-0.5 text-slate-600" title={`${slot.subMeals} Sub-Meals → ${slot.headcount} MA (inkl. Helfer je Linie)`}>
              {slot.headcount}👤
            </span>
          )}
        </div>
        {slot.carryOver ? <div className="font-semibold text-amber-700">→ {fmtNum(slot.carryOver)}</div> : null}
      </div>
    </div>
  );
}

function LineRow({ line, dnd }: { line: PlatingLinePlan; dnd?: Dnd }) {
  const usedMin = line.platingMin + line.changeoverMin;
  const pct = line.availableMin > 0 ? Math.round((usedMin / line.availableMin) * 100) : 0;
  const pxPerMin = 900 / Math.max(line.availableMin, usedMin, 60); // Zeitachse auf ~900px normieren
  const clean = line.changeovers === 0 && line.slots.length > 0;
  return (
    <div className={`rounded-lg border p-2 ${line.overCapacity ? "border-rose-300 bg-rose-50/40" : "border-slate-200 bg-white"}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px]">
        <span className="font-bold text-slate-700">Linie {line.line}</span>
        <span className={`rounded px-1 py-0.5 font-semibold ${ROLE_TONE[line.role]}`}>{ROLE_LABEL[line.role]}</span>
        <span className="text-slate-500">{line.slots.length} Meals</span>
        <span
          className={`rounded px-1 py-0.5 font-semibold ${
            clean ? "bg-emerald-100 text-emerald-700"
              : line.changeovers > 0 ? "bg-rose-100 text-rose-700" : "text-slate-400"
          }`}
          title="Saubermach-Aktionen: Allergen-Wegfall"
        >
          {clean ? "0 Reinigungen" : `${line.changeovers} Reinigung${line.changeovers === 1 ? "" : "en"}`}
        </span>
        {line.easyChangeovers > 0 && (
          <span className="text-amber-600" title="Easy Changeover — nur Allergene zugefügt">
            +{line.easyChangeovers} easy
          </span>
        )}
        <span className="text-slate-400">{line.changeoverMin} min Rüsten</span>
        {line.peakHeadcount > 0 && (
          <span className="text-slate-500" title="Spitzenbesetzung der Linie (Plater je Sub-Meal + feste Helfer)">
            👤 {line.peakHeadcount} MA
          </span>
        )}
        <span className={`ml-auto font-mono font-semibold ${line.overCapacity ? "text-rose-600" : pct > 90 ? "text-amber-600" : "text-slate-600"}`}>
          {fmtClock(usedMin)} / {fmtClock(line.availableMin)} ({pct}%){line.overCapacity ? " ⚠" : ""}
        </span>
      </div>
      {line.slots.length ? (
        <div className="flex items-stretch gap-0.5 overflow-x-auto pb-1">
          {line.slots.map((s, i) => (
            <div key={`${s.code}-${s.runIndex}-${i}`} className="flex items-stretch">
              {dnd && <DropZone dnd={dnd} line={line.line} index={i} />}
              <SlotBlock slot={s} pxPerMin={pxPerMin} dnd={dnd} line={line.line} seq={i} />
            </div>
          ))}
          {dnd && <DropZone dnd={dnd} line={line.line} index={line.slots.length} />}
        </div>
      ) : dnd ? (
        <div className="flex min-h-[44px] items-stretch">
          <DropZone dnd={dnd} line={line.line} index={0} full />
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
  const [dragging, setDragging] = useState<{ line: number; seq: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ line: number; index: number } | null>(null);
  // Ref, damit onZoneDrop die Quelle auch dann kennt, wenn zwischen dragstart und
  // drop noch kein Re-Render lag (synchrone Events, Tests).
  const dragSrc = useRef<{ line: number; seq: number } | null>(null);

  /** Slot an eine beliebige Position (Linie + Einfüge-Index) verschieben; danach
   *  rechnet recomputeDayPlan Zeiten/Umrüsten/Carry-over neu. */
  const moveSlotTo = (fromLine: number, fromSeq: number, toLine: number, toIndex: number) => {
    updateDayPlan(day, dp => {
      const moved = dp.lines.find(l => l.line === fromLine)?.slots[fromSeq];
      if (!moved) return dp;
      let lines = dp.lines.map(l =>
        l.line === fromLine ? { ...l, slots: l.slots.filter((_, i) => i !== fromSeq) } : l,
      );
      lines = lines.map(l => {
        if (l.line !== toLine) return l;
        let idx = toIndex;
        if (fromLine === toLine && fromSeq < idx) idx -= 1;
        idx = Math.max(0, Math.min(idx, l.slots.length));
        const slots = [...l.slots];
        slots.splice(idx, 0, moved);
        return { ...l, slots };
      });
      return { ...dp, lines };
    });
  };

  const dnd: Dnd = {
    dragging, dropTarget,
    onSlotDragStart: (line, seq) => { dragSrc.current = { line, seq }; setDragging({ line, seq }); },
    onSlotDragEnd: () => { dragSrc.current = null; setDragging(null); setDropTarget(null); },
    onZoneOver: (line, index) => setDropTarget({ line, index }),
    onZoneDrop: (line, index) => {
      const src = dragSrc.current ?? dragging;
      if (src) {
        const noop = src.line === line && (index === src.seq || index === src.seq + 1);
        if (!noop) moveSlotTo(src.line, src.seq, line, index);
      }
      dragSrc.current = null;
      setDragging(null);
      setDropTarget(null);
    },
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
        Aus den im Wochenplan verplanten Runs: je Linie aufsteigend nach Allergenen sequenziert (kein Allergen → viele).
        Changeover ist rein allergen-getrieben — Allergen nur zufügen = <span className="text-amber-600">~ easy</span> ({plan?.params.changeoverEasyMin ?? 10} min);
        Allergen weg = <span className="text-rose-600">🧽 Reinigung</span> ({plan?.params.changeoverAllergenMin ?? 30} min).
        Linie 1 = Highrunner (größter sauberer Block, 0 Reinigungen), Linie 2 = Flex (nimmt die Reinigungen auf),
        Linie 3 = nur wenn L1+L2 das Volumen nicht fassen. Rest → Carry-over Folgetag (Seafood/komplex = ⚠ Deadline).
        Besetzung <span className="text-slate-600">👤</span> = ⌈Sub-Meals × {plan?.params.platerFactor ?? 0.7}⌉ + {plan?.params.platingHelpers ?? 2} Helfer je Linie.
        Sequenz/Params im Wochenplan-Tab ändern, dann neu generieren.
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
                  Sortier-Modus: Slot per Drag &amp; Drop an eine andere Position oder Linie ziehen — die cyan Zonen
                  zwischen den Blöcken sind die Ablage-Punkte. Zeiten, Umrüsten und Carry-over rechnen sich neu.
                  Für die Tag-zu-Tag-Weitergabe „Tagespläne neu generieren".
                </div>
              )}
              {dp.lines.map(l => (
                <LineRow key={l.line} line={l} dnd={editMode ? dnd : undefined} />
              ))}

              {dp.carryOutToNext.length > 0 && (() => {
                const anyCritical = dp.carryOutToNext.some(c => c.critical);
                return (
                  <div className={`rounded-lg border p-2 text-[11px] ${
                    day === "Sa" || anyCritical ? "border-rose-300 bg-rose-50 text-rose-800" : "border-amber-300 bg-amber-50 text-amber-800"
                  }`}>
                    <span className="font-semibold">
                      {day === "Sa" ? "⚠ Carry-over am Samstag — kein Folgetag:"
                        : anyCritical ? "⚠ Carry-over → Folgetag (Deadline-kritisch!):"
                        : "Carry-over → Folgetag:"}
                    </span>{" "}
                    {dp.carryOutToNext.map(c => `${c.code} ${fmtNum(c.portions)} P${c.critical ? " 🐟/komplex" : ""}`).join(" · ")}
                  </div>
                );
              })()}

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
      {fmtNum(s.totalPortions)} Portionen · {s.slots} Slots · <span className={s.cleaningActions > 0 ? "font-semibold text-rose-600" : ""}>{s.cleaningActions} Reinigungen</span>
      {s.easyChangeovers > 0 && <span className="text-amber-600"> · +{s.easyChangeovers} easy</span>}
      {" "}· {s.changeoverMin} min Rüsten gesamt
      {s.peakHeadcount > 0 && <span className="text-slate-600"> · 👤 ~{s.peakHeadcount} MA Spitze / {s.manHours} Pers.-h</span>}
      {s.linesOver > 0 && <span className="font-semibold text-rose-600"> · {s.linesOver} Linie(n) über Kapazität</span>}
      {s.carryOut > 0 && <span className="font-semibold text-amber-600"> · {fmtNum(s.carryOut)} P Carry-over</span>}
      {s.carryOutCritical > 0 && <span className="font-semibold text-rose-600"> ({fmtNum(s.carryOutCritical)} P kritisch)</span>}
    </div>
  );
}
