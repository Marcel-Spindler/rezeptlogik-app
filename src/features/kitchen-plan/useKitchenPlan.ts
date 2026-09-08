import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle } from "../../core/types";
import type { PlatingDay } from "../plating-plan/platingPlanTypes";
import { usePlatingWeekPlan } from "../plating-plan/usePlatingWeekPlan";
import { generateKitchenPlan, resolveKitchenParams } from "./kitchenPlanLogic";
import { saveKitchenPlanDoc, subscribeKitchenPlanDoc, type KitchenPlanDoc } from "./kitchenPlanFirestore";
import type { KitchenOverride, KitchenPlanParams, KitchenShift, KitchenWeekPlan } from "./kitchenPlanTypes";

/** Lädt den gespeicherten Wochen-Plating-Plan (read-only) + den persistenten
 *  Kochplan-Teil (Params + Sub-Meal-Overrides) und rechnet daraus jedes Mal den
 *  vollständigen Kochplan neu. Overrides/Params werden debounced gespeichert. */
export function useKitchenPlan(data: DataBundle | null, week: string) {
  const { plan: platingPlan, loading: platingLoading } = usePlatingWeekPlan(data, week);

  const [docState, setDocState] = useState<KitchenPlanDoc | null>(null);
  const [docLoaded, setDocLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNext = useRef(false);

  useEffect(() => {
    setDocLoaded(false);
    const unsub = subscribeKitchenPlanDoc(week, (d) => {
      if (suppressNext.current) { suppressNext.current = false; return; }
      setDocState(d);
      setDocLoaded(true);
      setDirty(false);
    });
    return unsub;
  }, [week]);

  const params: KitchenPlanParams = useMemo(
    () => resolveKitchenParams(docState?.params),
    [docState],
  );
  const overrides = useMemo(() => docState?.overrides ?? {}, [docState]);

  const kitchenPlan: KitchenWeekPlan | null = useMemo(() => {
    if (!data || !platingPlan) return null;
    const kp = generateKitchenPlan(data, platingPlan, params, overrides);
    return { ...kp, source: docState?.source === "edited" || Object.keys(overrides).length ? "edited" : "generated" };
  }, [data, platingPlan, params, overrides, docState?.source]);

  const persist = useCallback((next: KitchenPlanDoc) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      suppressNext.current = true;
      void saveKitchenPlanDoc(next).then(() => setDirty(false)).catch(() => setDirty(false));
    }, 700);
  }, []);

  const mutateDoc = useCallback((updater: (prev: KitchenPlanDoc) => KitchenPlanDoc) => {
    setDocState(prev => {
      const base: KitchenPlanDoc = prev ?? {
        week, params: resolveKitchenParams(), overrides: {},
        updatedAt: new Date().toISOString(), source: "generated",
      };
      const next = { ...updater(base), week, updatedAt: new Date().toISOString() };
      setDirty(true);
      persist(next);
      return next;
    });
  }, [week, persist]);

  const mergeOverride = useCallback((subId: string, patch: Partial<KitchenOverride>) => {
    mutateDoc(prev => {
      const cur = prev.overrides[subId] ?? {};
      const merged: KitchenOverride = { ...cur, ...patch };
      // undefined-Felder entfernen (nicht als Firestore-Wert schreiben)
      for (const k of Object.keys(merged) as (keyof KitchenOverride)[]) {
        if (merged[k] === undefined) delete merged[k];
      }
      const nextOv = { ...prev.overrides };
      if (merged.cookDay || merged.shift || merged.order != null) nextOv[subId] = merged;
      else delete nextOv[subId];
      return { ...prev, source: "edited", overrides: nextOv };
    });
  }, [mutateDoc]);

  /** Sub-Meal auf einen anderen Küchentag (und optional eine Schicht) legen. */
  const moveJob = useCallback((subId: string, cookDay: PlatingDay, shift?: KitchenShift) => {
    mergeOverride(subId, {
      cookDay,
      shift: shift && shift !== "tag" ? shift : undefined,
      order: undefined, // Tag/Schicht wechseln → Position neu auto-sequenzieren
    });
  }, [mergeOverride]);

  /** Reihenfolge einer Station × Schicht fixieren (Drag&Drop in-Block). */
  const reorderBlock = useCallback((
    day: PlatingDay, shift: KitchenShift, orderedSubIds: string[],
  ) => {
    mutateDoc(prev => {
      const nextOv = { ...prev.overrides };
      orderedSubIds.forEach((subId, i) => {
        const cur = nextOv[subId] ?? {};
        nextOv[subId] = {
          ...cur,
          cookDay: day,
          shift: shift !== "tag" ? shift : undefined,
          order: i * 100,
        };
        if (nextOv[subId].shift === undefined) delete nextOv[subId].shift;
      });
      return { ...prev, source: "edited", overrides: nextOv };
    });
  }, [mutateDoc]);

  /** Position-Fixierung einer Station × Schicht aufheben → allergen-Auto. */
  const autoSortBlock = useCallback((subIds: string[]) => {
    mutateDoc(prev => {
      const nextOv = { ...prev.overrides };
      for (const subId of subIds) {
        const cur = nextOv[subId];
        if (!cur) continue;
        const { order: _drop, ...rest } = cur;
        if (rest.cookDay || rest.shift) nextOv[subId] = rest;
        else delete nextOv[subId];
      }
      return { ...prev, source: "edited", overrides: nextOv };
    });
  }, [mutateDoc]);

  const clearOverride = useCallback((subId: string) => {
    mutateDoc(prev => {
      const nextOv = { ...prev.overrides };
      delete nextOv[subId];
      return { ...prev, source: "edited", overrides: nextOv };
    });
  }, [mutateDoc]);

  const clearAllOverrides = useCallback(() => {
    mutateDoc(prev => ({ ...prev, source: "generated", overrides: {} }));
  }, [mutateDoc]);

  const setParams = useCallback((patch: Partial<KitchenPlanParams>) => {
    mutateDoc(prev => ({
      ...prev,
      source: "edited",
      params: resolveKitchenParams({ ...prev.params, ...patch }),
    }));
  }, [mutateDoc]);

  return {
    kitchenPlan,
    platingPlan,
    params,
    loading: platingLoading || !docLoaded,
    dirty,
    moveJob,
    reorderBlock,
    autoSortBlock,
    clearOverride,
    clearAllOverrides,
    setParams,
  };
}
