import { useCallback, useEffect, useRef, useState } from "react";
import type { DataBundle } from "../../core/types";
import { buildDefaultParams, generatePlatingPlan } from "./platingPlanLogic";
import { generateAllDayPlans } from "./platingDayLogic";
import { savePlatingWeekPlan, subscribePlatingWeekPlan } from "./platingWeekPlanFirestore";
import {
  PLATING_PLAN_CHANGED_EVENT,
  type PlatingDay, type PlatingDayCapacity, type PlatingPlanParams, type PlatingWeekPlan,
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
      const next = { ...updater(prev), updatedAt: new Date().toISOString(), source: "edited" as const };
      setDirty(true);
      persist(next);
      return next;
    });
  }, [persist]);

  const regenerate = useCallback((opts?: {
    params?: Partial<PlatingPlanParams>;
    dayCapacity?: Partial<Record<PlatingDay, PlatingDayCapacity>>;
  }) => {
    if (!data) return;
    const base = plan?.params ?? buildDefaultParams(week);
    const dayCapacity = opts?.dayCapacity ?? plan?.dayCapacity ?? undefined;
    const fresh = generatePlatingPlan(data, week, { ...base, ...(opts?.params ?? {}) }, dayCapacity);
    // manuelle Notizen übernehmen
    if (plan) {
      const noteByCode = new Map(plan.meals.filter(m => m.note).map(m => [m.code, m.note]));
      for (const m of fresh.meals) if (noteByCode.has(m.code)) m.note = noteByCode.get(m.code);
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

  return { plan, loading, dirty, update, regenerate, regenerateDailyPlans };
}
