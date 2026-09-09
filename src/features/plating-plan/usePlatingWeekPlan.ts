import { useCallback, useEffect, useRef, useState } from "react";
import type { DataBundle } from "../../core/types";
import {
  buildDefaultParams, assignRunsToShifts, generatePlatingPlan, nextRunIndex,
  splitUnfinishedRun, clearUnfinishedRun,
} from "./platingPlanLogic";
import { generateAllDayPlans, recomputeDayPlan } from "./platingDayLogic";
import { savePlatingWeekPlan, subscribePlatingWeekPlan } from "./platingWeekPlanFirestore";
import {
  PLATING_PLAN_CHANGED_EVENT,
  type PlatingDay, type PlatingDayCapacity, type PlatingDayPlan,
  type PlatingPlanParams, type PlatingWeekPlan,
} from "./platingPlanTypes";

/** Lädt den Wochen-Plating-Plan aus Firestore, hält lokale Edits und speichert
 *  (debounced). Der KI-Assistent schreibt über dieselbe Collection + feuert
 *  PLATING_PLAN_CHANGED_EVENT — darauf hört dieser Hook. */
export function usePlatingWeekPlan(data: DataBundle | null, week: string) {
  const [plan, setPlan] = useState<PlatingWeekPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNext = useRef(false);

  useEffect(() => {
    setLoading(true);
    const unsub = subscribePlatingWeekPlan(week, (p) => {
      if (suppressNext.current) { suppressNext.current = false; return; }
      setPlan(p);
      setDirty(false);
      setLoading(false);
    });
    return unsub;
  }, [week]);

  // externe Änderung (KI) → neu laden erzwingen
  useEffect(() => {
    const reload = () => {
      const unsub = subscribePlatingWeekPlan(week, (p) => { setPlan(p); setDirty(false); unsub(); });
    };
    window.addEventListener(PLATING_PLAN_CHANGED_EVENT, reload);
    return () => window.removeEventListener(PLATING_PLAN_CHANGED_EVENT, reload);
  }, [week]);

  const persist = useCallback((next: PlatingWeekPlan) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      suppressNext.current = true;
      void savePlatingWeekPlan(next).then(() => setDirty(false));
    }, 800);
  }, []);

  const update = useCallback((updater: (prev: PlatingWeekPlan) => PlatingWeekPlan) => {
    setPlan(prev => {
      if (!prev) return prev;
      const edited = { ...updater(prev), updatedAt: new Date().toISOString(), source: "edited" as const };
      const next = assignRunsToShifts(edited);
      setDirty(true);
      persist(next);
      return next;
    });
  }, [persist]);

  /** Einen Run auf einen anderen Tag verschieben (Drag-and-Drop im Plating-
   *  Linien-Bot / Tag-Dropdown in PlatingPlanView) — Schicht wird über update()
   *  automatisch neu zugewiesen, NIE hier manuell setzen. */
  const moveRun = useCallback((code: string, runIndex: number, toDay: PlatingDay) => {
    update(prev => ({
      ...prev,
      meals: prev.meals.map(m => m.code !== code ? m : {
        ...m, runs: m.runs.map(r => r.runIndex === runIndex ? { ...r, day: toDay } : r),
      }),
    }));
  }, [update]);

  /** Einen erkannten Backfill-Bedarf (Plating-Linien-Bot) als neuen Run an ein
   *  Meal anhängen. Der Live-Bedarf selbst bleibt unverändert — nur der Plan
   *  bekommt einen zusätzlichen, als Backfill markierten Run. */
  const addBackfillRun = useCallback((code: string, portions: number, day: PlatingDay) => {
    update(prev => ({
      ...prev,
      meals: prev.meals.map(m => {
        if (m.code !== code) return m;
        const runs = [...m.runs, { runIndex: nextRunIndex(m), portions, day, isBackfill: true }];
        return { ...m, runs, runCount: runs.length };
      }),
    }));
  }, [update]);

  /** „An dem Tag nicht geschafft": `producedPortions` bleiben am Ursprungstag
   *  (Run wird als erledigt markiert), der Rest wandert als Nachhol-Run auf
   *  `toDay`. Schicht wird über update() neu zugewiesen. */
  const markRunUnfinished = useCallback(
    (code: string, runIndex: number, producedPortions: number, toDay: PlatingDay) => {
      update(prev => ({
        ...prev,
        meals: prev.meals.map(m => {
          if (m.code !== code) return m;
          const runs = splitUnfinishedRun(m, runIndex, producedPortions, toDay);
          return { ...m, runs, runCount: runs.filter(r => r.portions > 0).length };
        }),
      }));
    }, [update]);

  /** „nicht geschafft" zurücknehmen — Ursprungs-Run zurück auf die geplante
   *  Menge, Nachhol-Run entfernen. */
  const clearRunUnfinished = useCallback((code: string, runIndex: number) => {
    update(prev => ({
      ...prev,
      meals: prev.meals.map(m => {
        if (m.code !== code) return m;
        const runs = clearUnfinishedRun(m, runIndex);
        return { ...m, runs, runCount: runs.filter(r => r.portions > 0).length };
      }),
    }));
  }, [update]);

  const regenerate = useCallback((opts?: {
    params?: Partial<PlatingPlanParams>;
    dayCapacity?: Partial<Record<PlatingDay, PlatingDayCapacity>>;
  }) => {
    if (!data) return;
    const base = plan?.params ?? buildDefaultParams(week);
    const dayCapacity = opts?.dayCapacity ?? plan?.dayCapacity ?? undefined;
    let fresh = generatePlatingPlan(data, week, { ...base, ...(opts?.params ?? {}) }, dayCapacity);
    if (plan) {
      // manuelle Notizen übernehmen
      const noteByCode = new Map(plan.meals.filter(m => m.note).map(m => [m.code, m.note]));
      for (const m of fresh.meals) if (noteByCode.has(m.code)) m.note = noteByCode.get(m.code);

      // Backfill-Runs (manuell via Drag-and-Drop hinzugefügt) über eine
      // Neu-Generierung hinweg erhalten — sonst geht diese Arbeit bei jedem
      // Parameter-Feintuning verloren.
      let hasBackfillRuns = false;
      fresh = {
        ...fresh,
        meals: fresh.meals.map(m => {
          const oldBackfillRuns = plan.meals.find(om => om.code === m.code)?.runs.filter(r => r.isBackfill) ?? [];
          if (!oldBackfillRuns.length) return m;
          hasBackfillRuns = true;
          let idx = nextRunIndex(m);
          const runs = [...m.runs, ...oldBackfillRuns.map(r => ({ ...r, runIndex: idx++ }))];
          return { ...m, runs, runCount: runs.length };
        }),
      };
      // generatePlatingPlan hat die Schichten schon VOR dem Anhängen zugewiesen.
      if (hasBackfillRuns) fresh = assignRunsToShifts(fresh);
    }
    setPlan(fresh);
    setDirty(true);
    persist(fresh);
  }, [data, week, plan, persist]);

  /** Phase 2: die täglichen Linienpläne aus dem aktuellen Wochenplan neu bauen. */
  const regenerateDailyPlans = useCallback(() => {
    setPlan(prev => {
      if (!prev) return prev;
      const next: PlatingWeekPlan = {
        ...prev,
        dailyPlans: generateAllDayPlans(prev),
        updatedAt: new Date().toISOString(),
      };
      setDirty(true);
      persist(next);
      return next;
    });
  }, [persist]);

  /** Phase 2.5: den Tagesplan eines Tages ändern (Slots umsortieren / Linie wechseln)
   *  und Zeiten/Umrüsten/Carry-over neu berechnen. */
  const updateDayPlan = useCallback((day: PlatingDay, mutate: (dp: PlatingDayPlan) => PlatingDayPlan) => {
    setPlan(prev => {
      if (!prev?.dailyPlans?.[day]) return prev;
      const edited = recomputeDayPlan(mutate(structuredClone(prev.dailyPlans[day]!)), prev);
      const next: PlatingWeekPlan = {
        ...prev,
        dailyPlans: { ...prev.dailyPlans, [day]: edited },
        updatedAt: new Date().toISOString(),
        source: "edited",
      };
      setDirty(true);
      persist(next);
      return next;
    });
  }, [persist]);

  return {
    plan, loading, dirty, update, moveRun, addBackfillRun,
    markRunUnfinished, clearRunUnfinished,
    regenerate, regenerateDailyPlans, updateDayPlan,
  };
}
