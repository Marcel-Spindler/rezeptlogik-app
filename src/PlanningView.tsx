import { useEffect, useMemo, useState } from "react";
import type { DataBundle, ShelfLifeInfo, WeekRecipe } from "./types";
import { STATIONS } from "./types";
import { DEFAULT_SHIFT_MIN, fmtMin, getStationCapacityView, loadStationDeviceCounts, loadStationPools } from "./equipment";
import {
  assignmentKey,
  PLANNER_DAYS,
  PLANNER_SHIFTS,
  SHIFT_CAPACITY_MIN,
  analyzePlan,
  assignRecipe,
  computeBatchSplitPlan,
  createScenario,
  getActiveScenario,
  getWeekState,
  loadPlannerStorage,
  resetScenario,
  removeAssignment,
  savePlannerStorage,
  setActiveScenario,
  suggestAssignments,
  type PlannerDay,
  type PlannerShift,
  type PlannerPoolConflict,
  type PlannerStationConflict
} from "./planner";
import { tl, type UiLocale } from "./i18n";
import { usePlanningOasisData } from "./planningOasisData";

const PLANNER_UI_SETTINGS_STORAGE_KEY = "rezeptlogik-planner-ui-settings-v1";

type PlannerUiSettings = {
  shiftPresetId: string;
  shiftCount: number;
  showAutoSuggestions: boolean;
  showStationConflicts: boolean;
  showPoolConflicts: boolean;
};

const SHIFT_MODEL_PRESETS = [
  {
    id: "single-current",
    label: "Aktuell: Einschicht",
    shortLabel: "Einschicht",
    shiftCount: 1,
    tone: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    note: "Produktivbetrieb heute. Das ist der sichere Default und bleibt beim Neuladen aktiv.",
    areas: ["Kitchen", "Plating", "Fulfilment"],
    areaShiftPlan: {
      Warehouse: 0,
      Kitchen: 1,
      Printing: 0,
      Plating: 1,
      Fulfilment: 1,
      FSQA: 0
    }
  },
  {
    id: "double-ready",
    label: "Vorbereitet: 2 Schichten",
    shortLabel: "2 Schichten",
    shiftCount: 2,
    tone: "bg-amber-50 text-amber-900 ring-amber-200",
    note: "Ein Klick schaltet zusätzliche Slots zu, ohne die restliche Planung umzubauen.",
    areas: ["Warehouse", "Kitchen", "Plating", "Fulfilment"],
    areaShiftPlan: {
      Warehouse: 1,
      Kitchen: 2,
      Printing: 1,
      Plating: 2,
      Fulfilment: 2,
      FSQA: 1
    }
  },
  {
    id: "triple-ready",
    label: "Vorbereitet: 3 Schichten",
    shortLabel: "3 Schichten",
    shiftCount: 3,
    tone: "bg-sky-50 text-sky-900 ring-sky-200",
    note: "Für späteren Mehrschichtbetrieb vorbereitet, inkl. 3 Assembly Lines im Fulfilment.",
    areas: ["Warehouse", "Kitchen", "Plating", "Fulfilment", "FSQA"],
    areaShiftPlan: {
      Warehouse: 2,
      Kitchen: 3,
      Printing: 1,
      Plating: 3,
      Fulfilment: 3,
      FSQA: 2
    }
  }
] as const;

const SHIFT_MODEL_AREAS = [
  { key: "Warehouse", sheets: ["W1", "W2", "W3", "W4"] },
  { key: "Kitchen", sheets: ["K1", "K2", "K3", "K4"] },
  { key: "Printing", sheets: ["Printing"] },
  { key: "Plating", sheets: ["P1", "P2", "P3", "P4"] },
  { key: "Fulfilment", sheets: ["FFM1", "FFM2", "FFM3", "FFM4"] },
  { key: "FSQA", sheets: ["QA1", "QA2", "QA3", "QA4", "QA5"] }
] as const;

function fmtNum(n: number, digits = 0): string {

  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

function slotValue(day: PlannerDay, shift: PlannerShift): string {
  return `${day}__${shift}`;
}

function parseSlot(value: string): { day: PlannerDay; shift: PlannerShift } | null {
  const [day, shift] = value.split("__");
  if (!day || !shift) return null;
  if (!(PLANNER_DAYS as readonly string[]).includes(day)) return null;
  if (!(PLANNER_SHIFTS as readonly string[]).includes(shift)) return null;
  return { day: day as PlannerDay, shift: shift as PlannerShift };
}

function pickLowestLoadSlot(
  slotLoads: Map<string, number>,
  activeShifts: readonly PlannerShift[]
): { day: PlannerDay; shift: PlannerShift } | null {
  let best: { day: PlannerDay; shift: PlannerShift; load: number } | null = null;
  for (const day of PLANNER_DAYS) {
    for (const shift of activeShifts) {
      const key = slotValue(day, shift);
      const load = slotLoads.get(key) ?? 0;
      if (!best || load < best.load) {
        best = { day, shift, load };
      }
    }
  }
  return best ? { day: best.day, shift: best.shift } : null;
}

function topConflictLabel(conflict: PlannerStationConflict): string {
  if (conflict.totalMin > conflict.capacityMin) {
    return `Überlast ${fmtMin(conflict.totalMin)} / ${fmtMin(conflict.capacityMin)}`;
  }
  return `teilt ${fmtNum(conflict.deviceCount)} Gerät(e) · ${fmtNum(conflict.requiredDevices)} gebraucht`;
}

function topPoolConflictLabel(conflict: PlannerPoolConflict): string {
  if (conflict.totalMin > conflict.capacityMin) {
    return `Pool überlast ${fmtMin(conflict.totalMin)} / ${fmtMin(conflict.capacityMin)}`;
  }
  return `${fmtNum(conflict.requiredDevices)} Geräte im Pool nötig`;
}

function loadPlannerUiSettings(): PlannerUiSettings {
  if (typeof window === "undefined") {
    return {
      shiftPresetId: "single-current",
      shiftCount: 1,
      showAutoSuggestions: true,
      showStationConflicts: true,
      showPoolConflicts: true
    };
  }
  try {
    const raw = window.localStorage.getItem(PLANNER_UI_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        shiftPresetId: "single-current",
        shiftCount: 1,
        showAutoSuggestions: true,
        showStationConflicts: true,
        showPoolConflicts: true
      };
    }
    const parsed = JSON.parse(raw) as Partial<PlannerUiSettings>;
    const shiftCount = Number(parsed.shiftCount ?? 1);
    const preset = SHIFT_MODEL_PRESETS.find(item => item.id === parsed.shiftPresetId)
      ?? SHIFT_MODEL_PRESETS.find(item => item.shiftCount === shiftCount)
      ?? SHIFT_MODEL_PRESETS[0];
    return {
      shiftPresetId: preset.id,
      shiftCount: shiftCount >= 1 && shiftCount <= 3 ? shiftCount : 1,
      showAutoSuggestions: parsed.showAutoSuggestions ?? true,
      showStationConflicts: parsed.showStationConflicts ?? true,
      showPoolConflicts: parsed.showPoolConflicts ?? true
    };
  } catch {
    return {
      shiftPresetId: "single-current",
      shiftCount: 1,
      showAutoSuggestions: true,
      showStationConflicts: true,
      showPoolConflicts: true
    };
  }
}

function shiftCountLabel(shiftCount: number): string {
  if (shiftCount === 1) return "1 Schicht";
  return `${shiftCount} Schichten`;
}

function getShiftPreset(presetId: string, shiftCount: number) {
  return SHIFT_MODEL_PRESETS.find(item => item.id === presetId)
    ?? SHIFT_MODEL_PRESETS.find(item => item.shiftCount === shiftCount)
    ?? SHIFT_MODEL_PRESETS[0];
}

function shiftPresetLabel(locale: UiLocale, presetId: string): string {
  void locale;
  if (presetId === "single-current") return "Aktuell: Einschicht";
  if (presetId === "double-ready") return "Vorbereitet: 2 Schichten";
  return "Vorbereitet: 3 Schichten";
}

function shiftPresetShortLabel(locale: UiLocale, presetId: string): string {
  void locale;
  if (presetId === "single-current") return "Einschicht";
  if (presetId === "double-ready") return "2 Schichten";
  return "3 Schichten";
}

function shiftPresetNote(locale: UiLocale, presetId: string): string {
  void locale;
  if (presetId === "single-current") return "Produktivbetrieb heute. Das ist der sichere Default und bleibt beim Neuladen aktiv.";
  if (presetId === "double-ready") return "Ein Klick schaltet zusätzliche Slots zu, ohne die restliche Planung umzubauen.";
  return "Für späteren Mehrschichtbetrieb vorbereitet, inkl. 3 Assembly Lines im Fulfilment.";
}

function shelfTone(status: ShelfLifeInfo["status"]): string {
  if (status === "critical") return "bg-rose-100 text-rose-800";
  if (status === "risk") return "bg-amber-100 text-amber-800";
  if (status === "ok") return "bg-emerald-100 text-emerald-800";
  return "bg-slate-100 text-slate-700";
}

function getWeekSplit(data: DataBundle, week: string) {
  const rows = data.weekRecipes.filter(r => r.hfWeek === week);
  const dkse = rows.reduce((sum, row) => sum + row.verdenVolume.DKSE, 0);
  const de = rows.reduce((sum, row) => sum + row.verdenVolume.DE, 0);
  const benl = rows.reduce((sum, row) => sum + row.verdenVolume.BENL, 0);
  const deFriday = Math.round(de / 2);
  return {
    dkse,
    de,
    benl,
    benlFriday: benl,
    deFriday,
    deSunday: Math.max(0, de - deFriday)
  };
}

function planningRoleTone(role: "factory" | "hybrid" | "supplied" | undefined): string {
  if (role === "hybrid") return "bg-sky-50 text-sky-800 ring-sky-200";
  if (role === "supplied") return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-emerald-50 text-emerald-800 ring-emerald-200";
}

function planningRoleLabel(role: "factory" | "hybrid" | "supplied" | undefined): string {
  if (role === "hybrid") return "Hybrid";
  if (role === "supplied") return "Zulieferung";
  return "Eigene Produktion";
}

export function PlanningView(
  { data, week, locale, upliftPercent = 0, selectedRecipe, onSelectRecipe }:
  { data: DataBundle; week: string; locale: UiLocale; upliftPercent?: number; selectedRecipe?: string | null; onSelectRecipe?: (recipeCode: string) => void }
) {
  const { data: planningOasis } = usePlanningOasisData();
  const [storage, setStorage] = useState(() => loadPlannerStorage());
  const [newScenarioName, setNewScenarioName] = useState("");
  const [stationDeviceCounts] = useState(() => loadStationDeviceCounts());
  const [stationPools] = useState(() => loadStationPools());
  const [uiSettings, setUiSettings] = useState<PlannerUiSettings>(() => loadPlannerUiSettings());
  const [draggingCode, setDraggingCode] = useState<string | null>(null);
  const [draggingSubId, setDraggingSubId] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null);
  const [dragOverUnplanned, setDragOverUnplanned] = useState(false);
  const [expandedRecipes, setExpandedRecipes] = useState<Set<string>>(new Set());
  useEffect(() => {
    savePlannerStorage(storage);
  }, [storage]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PLANNER_UI_SETTINGS_STORAGE_KEY, JSON.stringify(uiSettings));
  }, [uiSettings]);

  const weekState = useMemo(() => getWeekState(storage, week), [storage, week]);
  const scenario = useMemo(() => getActiveScenario(storage, week), [storage, week]);
  const portionMultiplier = 1 + upliftPercent / 100;
  const activePreset = useMemo(() => getShiftPreset(uiSettings.shiftPresetId, uiSettings.shiftCount), [uiSettings.shiftPresetId, uiSettings.shiftCount]);
  const activeShifts = useMemo(() => PLANNER_SHIFTS.slice(0, uiSettings.shiftCount), [uiSettings.shiftCount]);
  const analysis = useMemo(() => analyzePlan(data, week, scenario, {
    portionMultiplier,
    shiftCapacityMin: DEFAULT_SHIFT_MIN,
    stationDeviceCounts,
    stationPools
  }), [data, week, scenario, portionMultiplier, stationDeviceCounts, stationPools]);
  const suggestions = useMemo(() => {
    if (!uiSettings.showAutoSuggestions) return {};
    return suggestAssignments(data, week, scenario, activeShifts, {
      portionMultiplier,
      shiftCapacityMin: DEFAULT_SHIFT_MIN,
      stationDeviceCounts,
      stationPools
    });
  }, [data, week, scenario, activeShifts, portionMultiplier, stationDeviceCounts, stationPools, uiSettings.showAutoSuggestions]);
  const split = useMemo(() => getWeekSplit(data, week), [data, week]);
  const batchSplitPlan = useMemo(() => computeBatchSplitPlan(data, week), [data, week]);
  const weekIntel = planningOasis?.weeks[week] ?? null;
  const shelfRisk = useMemo(() => {
    const seen = new Set<string>();
    const rows: ShelfLifeInfo[] = [];
    for (const row of data.weekRecipes.filter(r => r.hfWeek === week)) {
      const recipe = data.recipes[row.code];
      if (!recipe) continue;
      for (const marketGross of Object.values(recipe.grossIngredients)) {
        for (const gi of marketGross ?? []) {
          if (!gi.ingredientId || seen.has(gi.ingredientId)) continue;
          seen.add(gi.ingredientId);
          const shelf = data.shelfLifeBySku?.[gi.ingredientId];
          if (shelf) rows.push(shelf);
        }
      }
    }
    return {
      total: rows.length,
      critical: rows.filter(r => r.status === "critical"),
      risk: rows.filter(r => r.status === "risk")
    };
  }, [data, week]);
  const recipeLookup = useMemo(() => Object.fromEntries(
    data.weekRecipes.filter(r => r.hfWeek === week).map(r => [r.code, r])
  ) as Record<string, WeekRecipe>, [data.weekRecipes, week]);

  const assignmentsBySlot = useMemo(() => {
    const buckets: Record<string, Array<{ code: string; name: string; activeMin: number }>> = {};
    for (const recipe of analysis.recipes) {
      if (!recipe.assigned) continue;
      const key = slotValue(recipe.assigned.day, recipe.assigned.shift);
      (buckets[key] ??= []).push({ code: recipe.recipeCode, name: recipe.recipeName, activeMin: recipe.activeMin });
    }
    for (const rows of Object.values(buckets)) rows.sort((a, b) => b.activeMin - a.activeMin);
    return buckets;
  }, [analysis.recipes]);

  /** Wochenboard-Zuordnungen ohne Uhrzeit: nur Tag + Schicht. */
  const assignmentsByDayShift = useMemo(() => {
    type Tile = {
      key: string;
      code: string;
      subRecipeId?: string;
      name: string;
      activeMin: number;
      order: number;
      shift: PlannerShift;
      kind: "main" | "sub";
      subCount: number; // für main-tile: Anzahl noch enthaltener Subs
    };
    const buckets: Record<string, Tile[]> = {};
    for (const recipe of analysis.recipes) {
      if (recipe.assigned && recipe.activeMin > 0) {
        const remainingSubs = recipe.subRecipes.filter(s => !s.assigned).length;
        (buckets[slotValue(recipe.assigned.day, recipe.assigned.shift)] ??= []).push({
          key: recipe.recipeCode,
          code: recipe.recipeCode,
          name: recipe.recipeName,
          activeMin: Math.max(15, recipe.activeMin),
          order: recipe.assigned.order ?? Number.MAX_SAFE_INTEGER,
          shift: recipe.assigned.shift,
          kind: "main",
          subCount: remainingSubs
        });
      }
      for (const sub of recipe.subRecipes) {
        if (!sub.assigned) continue;
        (buckets[slotValue(sub.assigned.day, sub.assigned.shift)] ??= []).push({
          key: `${recipe.recipeCode}::${sub.subRecipeId}`,
          code: recipe.recipeCode,
          subRecipeId: sub.subRecipeId,
          name: `${sub.subRecipeName} (${recipe.recipeName})`,
          activeMin: Math.max(15, sub.activeMin),
          order: sub.assigned.order ?? Number.MAX_SAFE_INTEGER,
          shift: sub.assigned.shift,
          kind: "sub",
          subCount: 0
        });
      }
    }
    for (const rows of Object.values(buckets)) {
      rows.sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        if (a.kind !== b.kind) return a.kind === "sub" ? -1 : 1;
        return b.activeMin - a.activeMin || a.name.localeCompare(b.name);
      });
    }
    return buckets;
  }, [analysis.recipes]);

  const stationsBySlot = useMemo(() => {
    return Object.fromEntries(
      Object.entries(analysis.stationLoadBySlot).map(([slot, loads]) => [
        slot,
        STATIONS
          .map(station => {
            const minutes = loads[station] ?? 0;
            const capacity = getStationCapacityView(minutes, stationDeviceCounts[station] ?? 1, DEFAULT_SHIFT_MIN);
            return { station, minutes, utilizationPct: capacity.utilizationPct, deviceCount: capacity.deviceCount };
          })
          .filter(row => row.minutes > 0)
          .sort((a, b) => b.utilizationPct - a.utilizationPct || b.minutes - a.minutes)
          .slice(0, 3)
      ])
    ) as Record<string, Array<{ station: string; minutes: number; utilizationPct: number; deviceCount: number }>>;
  }, [analysis.stationLoadBySlot, stationDeviceCounts]);

  // "Verfügbar" = Hauptrezept noch nicht geplant ODER es gibt noch ungeplante Subs
  const unplanned = analysis.recipes.filter(r => !r.assigned || r.subRecipes.some(s => !s.assigned && s.activeMin > 0));
  const visibleStationConflicts = uiSettings.showStationConflicts ? analysis.conflicts : [];
  const visiblePoolConflicts = uiSettings.showPoolConflicts ? analysis.poolConflicts : [];
  const visibleConflictCount = visibleStationConflicts.length + visiblePoolConflicts.length;
  const suggestionCount = Object.keys(suggestions).length;
  const activeShiftSummary = activeShifts.join(" / ");
  const areaRows = useMemo(() => SHIFT_MODEL_AREAS.map(area => ({
    ...area,
    shiftCount: activePreset.areaShiftPlan[area.key] ?? 0
  })), [activePreset]);

  function applyShiftPreset(presetId: string) {
    const preset = SHIFT_MODEL_PRESETS.find(item => item.id === presetId);
    if (!preset) return;
    setUiSettings(prev => ({
      ...prev,
      shiftPresetId: preset.id,
      shiftCount: preset.shiftCount
    }));
  }

  function updateAssignment(recipeCode: string, value: string) {
    const recipe = recipeLookup[recipeCode];
    if (!recipe) return;
    if (!value) {
      setStorage(prev => assignRecipe(prev, week, scenario.id, recipe));
      return;
    }
    const slot = parseSlot(value);
    if (!slot) return;
    setStorage(prev => assignRecipe(prev, week, scenario.id, recipe, slot));
  }

  function handleCreateScenario() {
    setStorage(prev => createScenario(prev, week, newScenarioName, scenario.id));
    setNewScenarioName("");
  }

  function applySuggestion(recipeCode: string) {
    const suggestion = suggestions[recipeCode];
    const recipe = recipeLookup[recipeCode];
    if (!suggestion || !recipe) return;
    setStorage(prev => assignRecipe(prev, week, scenario.id, recipe, { day: suggestion.day, shift: suggestion.shift }));
  }

  function handleDragStart(event: React.DragEvent, recipeCode: string, subRecipeId?: string) {
    const payload = subRecipeId ? `${recipeCode}::${subRecipeId}` : recipeCode;
    event.dataTransfer.setData("text/recipe-code", payload);
    event.dataTransfer.setData("text/plain", payload);
    event.dataTransfer.effectAllowed = "move";
    setDraggingCode(recipeCode);
    setDraggingSubId(subRecipeId ?? null);
  }

  function handleDragEnd() {
    setDraggingCode(null);
    setDraggingSubId(null);
    setDragOverSlot(null);
    setDragOverUnplanned(false);
  }

  /** Liest Drop-Payload und löst Code+ggf. SubId auf. */
  function parseDropPayload(event: React.DragEvent): { recipe: WeekRecipe; subRecipeId?: string; subRecipeName?: string } | null {
    const raw = event.dataTransfer.getData("text/recipe-code")
      || event.dataTransfer.getData("text/plain")
      || (draggingSubId ? `${draggingCode}::${draggingSubId}` : draggingCode ?? "");
    if (!raw) return null;
    const [code, subId] = raw.split("::");
    const recipe = recipeLookup[code];
    if (!recipe) return null;
    let subName: string | undefined;
    if (subId) {
      const summary = analysis.recipes.find(r => r.recipeCode === code);
      subName = summary?.subRecipes.find(s => s.subRecipeId === subId)?.subRecipeName;
    }
    return { recipe, subRecipeId: subId || undefined, subRecipeName: subName };
  }

  function handleDropOnSlot(event: React.DragEvent, day: PlannerDay, shift: PlannerShift) {
    event.preventDefault();
    const parsed = parseDropPayload(event);
    setDragOverSlot(null);
    handleDragEnd();
    if (!parsed) return;
    const key = parsed.subRecipeId ? `${parsed.recipe.code}::${parsed.subRecipeId}` : parsed.recipe.code;
    const current = scenario.assignments[key];
    if (current && current.day === day && current.shift === shift) return;
    setStorage(prev => assignRecipe(prev, week, scenario.id, parsed.recipe, {
      day, shift,
      subRecipeId: parsed.subRecipeId,
      subRecipeName: parsed.subRecipeName
    }));
  }

  function handleDropOnUnplanned(event: React.DragEvent) {
    event.preventDefault();
    const parsed = parseDropPayload(event);
    setDragOverUnplanned(false);
    handleDragEnd();
    if (!parsed) return;
    setStorage(prev => removeAssignment(prev, week, scenario.id, parsed.recipe.code, parsed.subRecipeId));
  }

  function handleAutoplanRecipe(targetCode: string) {
    if (activeShifts.length === 0) return;
    setStorage((prev) => {
      const weekState = getWeekState(prev, week);
      const currentScenario = getActiveScenario(prev, week);
      const analysisNow = analyzePlan(data, week, currentScenario, {
        portionMultiplier,
        shiftCapacityMin: DEFAULT_SHIFT_MIN,
        stationDeviceCounts,
        stationPools
      });

      const slotLoads = new Map<string, number>();
      const slotOrders = new Map<string, number>();

      const registerOrder = (day: PlannerDay, shift: PlannerShift, order?: number) => {
        const key = slotValue(day, shift);
        const current = slotOrders.get(key) ?? 0;
        if (typeof order === "number" && Number.isFinite(order)) {
          slotOrders.set(key, Math.max(current, Math.round(order)));
          return;
        }
        slotOrders.set(key, current + 1);
      };

      const nextOrder = (day: PlannerDay, shift: PlannerShift) => {
        const key = slotValue(day, shift);
        const value = (slotOrders.get(key) ?? 0) + 1;
        slotOrders.set(key, value);
        return value;
      };

      const addLoad = (day: PlannerDay, shift: PlannerShift) => {
        const key = slotValue(day, shift);
        slotLoads.set(key, (slotLoads.get(key) ?? 0) + 1);
      };
      // Seed loads with all currently planned items
      for (const recipe of analysisNow.recipes) {
        if (recipe.assigned) {
          addLoad(recipe.assigned.day, recipe.assigned.shift);
          registerOrder(recipe.assigned.day, recipe.assigned.shift, recipe.assigned.order);
        }
        for (const sub of recipe.subRecipes) {
          if (sub.assigned) {
            addLoad(sub.assigned.day, sub.assigned.shift);
            registerOrder(sub.assigned.day, sub.assigned.shift, sub.assigned.order);
          }
        }
      }

      const targetRecipe = analysisNow.recipes.find(r => r.recipeCode === targetCode);
      if (!targetRecipe) return prev;

      const nextAssignments = { ...currentScenario.assignments };

      // First assign unplanned subs (longest first)
      const openSubs = targetRecipe.subRecipes
        .filter(s => !s.assigned && s.activeMin > 0)
        .sort((a, b) => b.activeMin - a.activeMin);
      for (const sub of openSubs) {
        const slot = pickLowestLoadSlot(slotLoads, activeShifts);
        if (!slot) continue;
        nextAssignments[assignmentKey(targetCode, sub.subRecipeId)] = {
          recipeCode: targetCode,
          subRecipeId: sub.subRecipeId,
          subRecipeName: sub.subRecipeName,
          day: slot.day,
          shift: slot.shift,
          order: nextOrder(slot.day, slot.shift)
        };
        addLoad(slot.day, slot.shift);
      }

      // Then assign main if unplanned
      if (!targetRecipe.assigned) {
        const slot = pickLowestLoadSlot(slotLoads, activeShifts);
        if (slot) {
          nextAssignments[assignmentKey(targetCode)] = {
            recipeCode: targetCode,
            day: slot.day,
            shift: slot.shift,
            order: nextOrder(slot.day, slot.shift)
          };
          addLoad(slot.day, slot.shift);
        }
      }

      return {
        ...prev,
        weeks: {
          ...prev.weeks,
          [week]: {
            ...weekState,
            scenarios: weekState.scenarios.map((s) =>
              s.id === currentScenario.id ? { ...s, assignments: nextAssignments } : s
            )
          }
        }
      };
    });
  }

  function handleAutoPlanWeekBoard() {
    if (activeShifts.length === 0) return;
    setStorage((prev) => {
      const weekState = getWeekState(prev, week);
      const currentScenario = getActiveScenario(prev, week);
      const analysisNow = analyzePlan(data, week, currentScenario, {
        portionMultiplier,
        shiftCapacityMin: DEFAULT_SHIFT_MIN,
        stationDeviceCounts,
        stationPools
      });

      const nextAssignments = { ...currentScenario.assignments };
      const slotLoads = new Map<string, number>();
      const slotOrders = new Map<string, number>();

      const registerOrder = (day: PlannerDay, shift: PlannerShift, order?: number) => {
        const key = slotValue(day, shift);
        const current = slotOrders.get(key) ?? 0;
        if (typeof order === "number" && Number.isFinite(order)) {
          slotOrders.set(key, Math.max(current, Math.round(order)));
          return;
        }
        slotOrders.set(key, current + 1);
      };

      const nextOrder = (day: PlannerDay, shift: PlannerShift) => {
        const key = slotValue(day, shift);
        const value = (slotOrders.get(key) ?? 0) + 1;
        slotOrders.set(key, value);
        return value;
      };

      const addLoad = (day: PlannerDay, shift: PlannerShift) => {
        const key = slotValue(day, shift);
        slotLoads.set(key, (slotLoads.get(key) ?? 0) + 1);
      };

      for (const recipe of analysisNow.recipes) {
        if (recipe.assigned) {
          addLoad(recipe.assigned.day, recipe.assigned.shift);
          registerOrder(recipe.assigned.day, recipe.assigned.shift, recipe.assigned.order);
        }
        for (const sub of recipe.subRecipes) {
          if (!sub.assigned) continue;
          addLoad(sub.assigned.day, sub.assigned.shift);
          registerOrder(sub.assigned.day, sub.assigned.shift, sub.assigned.order);
        }
      }

      const unassignedSubs = analysisNow.recipes
        .flatMap((recipe) =>
          recipe.subRecipes
            .filter((sub) => !sub.assigned && sub.activeMin > 0)
            .map((sub) => ({
              recipeCode: recipe.recipeCode,
              subRecipeId: sub.subRecipeId,
              subRecipeName: sub.subRecipeName,
              activeMin: sub.activeMin
            }))
        )
        .sort((a, b) => b.activeMin - a.activeMin || a.recipeCode.localeCompare(b.recipeCode));

      for (const sub of unassignedSubs) {
        const slot = pickLowestLoadSlot(slotLoads, activeShifts);
        if (!slot) continue;
        nextAssignments[assignmentKey(sub.recipeCode, sub.subRecipeId)] = {
          recipeCode: sub.recipeCode,
          subRecipeId: sub.subRecipeId,
          subRecipeName: sub.subRecipeName,
          day: slot.day,
          shift: slot.shift,
          order: nextOrder(slot.day, slot.shift)
        };
        addLoad(slot.day, slot.shift);
      }

      const refreshedAnalysis = analyzePlan(data, week, {
        ...currentScenario,
        assignments: nextAssignments
      }, {
        portionMultiplier,
        shiftCapacityMin: DEFAULT_SHIFT_MIN,
        stationDeviceCounts,
        stationPools
      });

      const unassignedMains = refreshedAnalysis.recipes
        .filter((recipe) => !recipe.assigned && recipe.activeMin > 0)
        .sort((a, b) => b.activeMin - a.activeMin || a.recipeCode.localeCompare(b.recipeCode));

      for (const main of unassignedMains) {
        const slot = pickLowestLoadSlot(slotLoads, activeShifts);
        if (!slot) continue;
        nextAssignments[assignmentKey(main.recipeCode)] = {
          recipeCode: main.recipeCode,
          day: slot.day,
          shift: slot.shift,
          order: nextOrder(slot.day, slot.shift)
        };
        addLoad(slot.day, slot.shift);
      }

      return {
        ...prev,
        weeks: {
          ...prev.weeks,
          [week]: {
            ...weekState,
            scenarios: weekState.scenarios.map((s) =>
              s.id === currentScenario.id ? { ...s, assignments: nextAssignments } : s
            )
          }
        }
      };
    });
  }

  return (
    <div className="space-y-3">
      {/* ── TOP: Wochenboard mit Drag & Drop ──────────────────────────────── */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Wochenboard · {week}</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Rezepte oben in Tag/Schicht-Karten ziehen · zwischen Slots verschieben · zurück nach 'Offen' zum Entfernen
            </p>
            {weekIntel && (
              <div className="mt-2 flex flex-wrap gap-2">
                {weekIntel.hasTruthData ? (
                  <>
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-emerald-200">Eigene PDL {fmtNum(weekIntel.factoryPdlPortions)}</span>
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800 ring-1 ring-sky-200">Hybrid {fmtNum(weekIntel.hybridPdlPortions)}</span>
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-amber-200">Zulieferung {fmtNum(weekIntel.suppliedPdlPortions)}</span>
                  </>
                ) : (
                  <>
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 ring-1 ring-emerald-200">Work Orders {fmtNum(weekIntel.workOrderCount)}</span>
                    <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-800 ring-1 ring-violet-200">WO Target {fmtNum(weekIntel.totalTargetPortions)}</span>
                    <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800 ring-1 ring-sky-200">LinePlating {fmtNum(weekIntel.platingTotal)}</span>
                  </>
                )}
              </div>
            )}
            {weekIntel && !weekIntel.hasTruthData && (
              <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">
                Für diese KW fehlen aktuell Truth-/PDL-Daten im Export. KET- und LinePlating-Zahlen werden trotzdem angezeigt, PDL bleibt bis zum passenden KW-Export 0.
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700 ring-1 ring-slate-200">
              {analysis.plannedCount} geplant
            </span>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">
              {unplanned.length} offen
            </span>
            <span className="rounded-full bg-verden-50 px-2 py-0.5 text-[10px] font-semibold text-verden-700 ring-1 ring-verden-200">
              {shiftPresetShortLabel(locale, activePreset.id)}
            </span>
            <button
              className="rounded-lg bg-verden-600 text-white ring-1 ring-verden-700 hover:bg-verden-700 px-3 py-1 text-xs font-semibold"
              onClick={handleAutoPlanWeekBoard}
              title={locale === "de"
                ? "Verplant offene Sub-Meals zuerst nach Dauer (lang -> kurz), danach offene Haupt-Meals."
                : "Plans open sub-meals first by duration (long -> short), then open main meals."}
            >
              {locale === "de" ? "Auto: Meals + Subs" : "Auto: Meals + Subs"}
            </button>
            <button
              className="rounded-lg bg-rose-50 text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100 px-3 py-1 text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => {
                if (analysis.plannedCount === 0) return;
                if (window.confirm(`Kalender für Szenario '${scenario.name}' wirklich leeren? ${analysis.plannedCount} Zuordnung(en) gehen verloren.`)) {
                  setStorage(prev => resetScenario(prev, week, scenario.id));
                }
              }}
              disabled={analysis.plannedCount === 0}
              title="Alle Rezepte aus dem Kalender entfernen"
            >
              🗑 Kalender leeren
            </button>
          </div>
        </div>

        {/* Verfügbare Rezepte – horizontale Drag-Leiste */}
        <div
          className={`rounded-xl ring-1 p-2 mb-3 transition-all ${dragOverUnplanned ? "ring-2 ring-rose-400 bg-rose-50" : "ring-slate-200 bg-slate-50"}`}
          onDragOver={e => {
            const code = draggingCode;
            if (!code) return;
            const key = draggingSubId ? `${code}::${draggingSubId}` : code;
            if (!scenario.assignments[key]) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!dragOverUnplanned) setDragOverUnplanned(true);
          }}
          onDragLeave={() => setDragOverUnplanned(false)}
          onDrop={handleDropOnUnplanned}
        >
          <div className="flex items-center justify-between gap-2 mb-1.5 px-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Verfügbare Rezepte · {unplanned.length}
            </div>
            <div className="text-[10px] text-slate-400">
              {dragOverUnplanned ? "Loslassen -> aus Plan nehmen" : "↓ in Tag/Schicht ziehen"}
            </div>
          </div>
          {unplanned.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-emerald-700 bg-emerald-50 rounded-md ring-1 ring-emerald-200">
              ✓ Alle Rezepte verplant
            </div>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {unplanned.map(recipe => {
                const isExpanded = expandedRecipes.has(recipe.recipeCode);
                const openSubs = recipe.subRecipes.filter(s => !s.assigned && s.activeMin > 0);
                const hasMain = !recipe.assigned;
                const recipeIntel = planningOasis?.recipes[recipe.recipeCode] ?? null;
                const totalRemaining = (hasMain ? recipe.activeMin : 0)
                  + (recipe.assigned ? 0 : 0); // activeMin already excludes standalone subs
                return (
                  <div
                    key={recipe.recipeCode}
                    className={`shrink-0 w-48 rounded-lg border bg-white transition-all ${draggingCode === recipe.recipeCode && !draggingSubId ? "opacity-40" : ""} ${selectedRecipe === recipe.recipeCode ? "border-verden-500 bg-verden-50 shadow" : "border-slate-200 hover:border-verden-300 hover:shadow-sm"}`}
                  >
                    {/* Hauptrezept-Karte */}
                    <div className="px-2 py-1.5">
                      <button
                        draggable={hasMain}
                        onDragStart={hasMain ? (e => handleDragStart(e, recipe.recipeCode)) : undefined}
                        onDragEnd={handleDragEnd}
                        onClick={() => onSelectRecipe?.(recipe.recipeCode)}
                        title={hasMain
                          ? `${recipe.recipeName}${openSubs.length < recipe.subRecipes.length ? ` (${recipe.subRecipes.length - openSubs.length} Sub bereits geplant)` : ""}`
                          : `${recipe.recipeName} · Hauptrezept geplant – nur noch Subs offen`}
                        className={`w-full text-left ${hasMain ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-mono text-[10px] text-slate-500">{hasMain ? "⋮⋮" : "✓"} {recipe.recipeCode}</span>
                          <span className="text-[10px] font-semibold text-slate-500">{openSubs.length} Subs offen</span>
                        </div>
                        <div className="text-xs font-medium leading-tight text-slate-800 line-clamp-2">{recipe.recipeName}</div>
                        <div className={`mt-1 inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-semibold ring-1 ${planningRoleTone(recipeIntel?.planningRole)}`}>
                          {planningRoleLabel(recipeIntel?.planningRole)}
                        </div>
                        <div className="mt-0.5 text-[10px] text-slate-500 truncate">
                          {recipe.topStations.map(s => s.station).join(" · ") || "—"}
                        </div>
                      </button>
                      <div className="mt-1 flex gap-1">
                        <button
                          className="flex-1 text-[10px] font-semibold text-amber-700 hover:text-amber-900 bg-amber-50 hover:bg-amber-100 rounded px-1 py-0.5 ring-1 ring-amber-300"
                          title={`Dieses Rezept + ${openSubs.length} Sub(s) automatisch verplanen`}
                          onClick={() => handleAutoplanRecipe(recipe.recipeCode)}
                        >
                          ⚡ Auto
                        </button>
                        {recipe.subRecipes.length > 0 && (
                          <button
                            className="flex-1 text-[10px] font-semibold text-verden-700 hover:text-verden-900 bg-verden-50 hover:bg-verden-100 rounded px-1 py-0.5 ring-1 ring-verden-200"
                            onClick={() => setExpandedRecipes(prev => {
                              const next = new Set(prev);
                              if (next.has(recipe.recipeCode)) next.delete(recipe.recipeCode);
                              else next.add(recipe.recipeCode);
                              return next;
                            })}
                          >
                            {isExpanded ? "▾" : "▸"} {openSubs.length}/{recipe.subRecipes.length} Subs
                          </button>
                        )}
                      </div>
                    </div>
                    {/* Sub-Rezept-Pillen */}
                    {isExpanded && recipe.subRecipes.length > 0 && (
                      <div className="border-t border-slate-200 bg-slate-50/50 px-1.5 py-1.5 space-y-1 max-h-48 overflow-y-auto">
                        {recipe.subRecipes.map(sub => {
                          const isPlanned = !!sub.assigned;
                          return (
                            <button
                              key={sub.subRecipeId}
                              draggable={!isPlanned}
                              onDragStart={!isPlanned ? (e => { e.stopPropagation(); handleDragStart(e, recipe.recipeCode, sub.subRecipeId); }) : undefined}
                              onDragEnd={handleDragEnd}
                              title={isPlanned
                                ? `${sub.subRecipeName} bereits in ${sub.assigned!.day} ${sub.assigned!.shift} geplant – aus Kalender ziehen zum Entfernen`
                                : `${sub.subRecipeName} · ${sub.category} – ziehen, um Sub separat zu planen`}
                              className={`w-full text-left rounded px-1.5 py-1 text-[10px] ring-1 transition-all ${isPlanned ? "bg-emerald-50 ring-emerald-200 text-emerald-800 cursor-not-allowed" : draggingSubId === sub.subRecipeId ? "opacity-40 bg-amber-50 ring-amber-300" : "bg-white ring-slate-200 hover:ring-amber-400 hover:bg-amber-50 cursor-grab active:cursor-grabbing"}`}
                            >
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-semibold leading-tight line-clamp-1">{isPlanned ? "✓ " : "⋮⋮ "}{sub.subRecipeName}</span>
                                <span className="font-mono tabular-nums shrink-0">{sub.category || "Sub"}</span>
                              </div>
                              <div className="text-[9px] text-slate-500 truncate">{sub.category}</div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Wochenboard ohne Zeitachse: nur Tag + Schicht + Reihenfolge */}
        <div className="grid gap-2 overflow-x-auto md:grid-cols-4 xl:grid-cols-7">
          {PLANNER_DAYS.map(day => {
            const dayTotal = activeShifts.reduce((sum, shift) => sum + (assignmentsByDayShift[slotValue(day, shift)]?.length ?? 0), 0);
            return (
              <div key={day} className="min-w-[180px] rounded-lg bg-slate-50 ring-1 ring-slate-200 p-1.5">
                <div className="text-center text-xs font-bold uppercase tracking-wide text-slate-700 bg-white rounded-md py-1 mb-1 ring-1 ring-slate-200">
                  {day} <span className="text-[10px] font-normal text-slate-500">· {dayTotal}</span>
                </div>
                <div className="space-y-1.5">
                  {activeShifts.map(shift => {
                    const slot = slotValue(day, shift);
                    const items = assignmentsByDayShift[slot] ?? [];
                    const isDragOver = dragOverSlot === slot;
                    const isDragActive = draggingCode !== null;
                    return (
                      <div
                        key={slot}
                        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverSlot !== slot) setDragOverSlot(slot); }}
                        onDragLeave={() => { if (dragOverSlot === slot) setDragOverSlot(null); }}
                        onDrop={e => handleDropOnSlot(e, day, shift)}
                        className={`rounded-md p-1 ring-1 min-h-[74px] transition-all ${isDragOver ? "ring-2 ring-verden-500 bg-verden-50" : isDragActive ? "ring-dashed ring-slate-300 bg-white" : "ring-slate-200 bg-white"}`}
                      >
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{shift} · {items.length}</div>
                        <div className="space-y-1">
                          {items.map(item => {
                            const isSelected = selectedRecipe === item.code;
                            const isSub = item.kind === "sub";
                            const isDragging = draggingCode === item.code && (draggingSubId ?? null) === (item.subRecipeId ?? null);
                            const recipeIntel = planningOasis?.recipes[item.code] ?? null;
                            return (
                              <button
                                key={item.key}
                                draggable
                                onDragStart={e => { e.stopPropagation(); handleDragStart(e, item.code, item.subRecipeId); }}
                                onDragEnd={handleDragEnd}
                                onClick={() => onSelectRecipe?.(item.code)}
                                title={`${item.name} · ${isSub ? "Sub-Rezept" : `Hauptkachel (${item.subCount} Sub${item.subCount === 1 ? "" : "s"} enthalten)`} · ${fmtMin(item.activeMin)}`}
                                className={`w-full rounded-md px-1.5 py-1 text-left ring-1 cursor-grab active:cursor-grabbing transition-opacity ${isDragging ? "opacity-30" : ""} ${isSub
                                  ? (isSelected ? "bg-amber-600 text-white ring-amber-700 shadow" : "bg-amber-50 ring-amber-300 hover:ring-amber-500 text-amber-900")
                                  : (isSelected ? "bg-verden-600 text-white ring-verden-700 shadow" : "bg-white ring-verden-300 hover:ring-verden-500 text-slate-800")}`}
                              >
                                <div className="flex items-center justify-between gap-1 leading-none">
                                  <span className="font-mono text-[9px] opacity-70">#{item.order} · {isSub ? "▸" : "⋮⋮"} {item.code}</span>
                                  <span className="text-[9px] font-mono opacity-70">{fmtMin(item.activeMin)}</span>
                                </div>
                                <div className="text-[10px] font-semibold leading-tight mt-0.5 line-clamp-2">{item.name}</div>
                                <div className={`mt-1 inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-semibold ring-1 ${planningRoleTone(recipeIntel?.planningRole)}`}>
                                  {planningRoleLabel(recipeIntel?.planningRole)}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                        {items.length === 0 && (
                          <div className="text-[10px] text-slate-300 text-center py-2 pointer-events-none">
                            {isDragOver ? "hier ablegen" : "leer"}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">{tl(locale, "Wochenplaner")} · {week}</h2>
            <p className="mt-1 text-sm text-slate-500">
              Lokaler Szenario-Planer im Browser. Keine Firestore-Schreibvorgänge, keine Live-Risiken.
              {upliftPercent !== 0 ? ` Aktiver Planfaktor: ${upliftPercent > 0 ? "+" : ""}${upliftPercent}%.` : ""}
            </p>
          </div>
          <div className="rounded-full bg-verden-50 px-3 py-1 text-xs font-semibold text-verden-700 ring-1 ring-verden-200">
            {tl(locale, "Planungsmodus")}: {shiftPresetLabel(locale, activePreset.id)}
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">

          {/* ── Linke Spalte: Schichtmodell ───────────────────────────── */}
          <div className="space-y-3">
            <div className="rounded-2xl bg-slate-50 ring-1 ring-slate-200 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">{tl(locale, "Schichtmodell")}</div>
              <div className="grid gap-2 sm:grid-cols-3">
                {SHIFT_MODEL_PRESETS.map(preset => {
                  const selected = preset.id === activePreset.id;
                  return (
                    <button
                      key={preset.id}
                      className={`rounded-xl px-3 py-2.5 text-left ring-1 transition-colors ${selected ? preset.tone : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}
                      onClick={() => applyShiftPreset(preset.id)}
                    >
                      <div className="flex items-start justify-between gap-1.5">
                        <span className="text-sm font-semibold leading-tight">{shiftPresetLabel(locale, preset.id)}</span>
                        <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${selected ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-600"}`}>
                          {selected ? (locale === "de" ? "aktiv" : locale === "nl" ? "actief" : "active") : (locale === "de" ? "1 Klick" : locale === "nl" ? "1 klik" : "1 click")}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] leading-snug opacity-75">{shiftPresetNote(locale, preset.id)}</div>
                      <div className="mt-1.5 text-[10px] opacity-60 leading-tight">{locale === "de" ? "Bereiche" : locale === "nl" ? "Gebieden" : "Areas"}: {preset.areas.join(" · ")}</div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 text-[11px] text-slate-500">
                {locale === "de" ? "Aktiv im Planner" : locale === "nl" ? "Actief in planner" : "Active in planner"}: <span className="font-medium">{activeShiftSummary}</span> · {locale === "de" ? "Fulfilment kann im 3-Schicht-Modell auf 3 Assembly Lines laufen." : locale === "nl" ? "Fulfilment kan in het 3-ploegenmodel op 3 assembly lines draaien." : "Fulfilment can run on 3 assembly lines in the 3-shift model."}
              </div>
            </div>

            {/* Bereich-Schichten-Tabelle */}
            <div className="overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2">{locale === "de" ? "Bereich" : locale === "nl" ? "Gebied" : "Area"}</th>
                    <th className="text-left px-3 py-2">{locale === "de" ? "Schichten" : locale === "nl" ? "Ploegen" : "Shifts"}</th>
                    <th className="text-left px-3 py-2">{locale === "de" ? "Excel-Gruppen" : locale === "nl" ? "Excel-groepen" : "Excel groups"}</th>
                  </tr>
                </thead>
                <tbody>
                  {areaRows.map(area => (
                    <tr key={area.key} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 font-medium text-slate-700 whitespace-nowrap">{area.key}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <span className={`inline-flex rounded-full px-2 py-0.5 font-semibold ${area.shiftCount > 0 ? "bg-verden-50 text-verden-700 ring-1 ring-verden-200" : "bg-slate-100 text-slate-500"}`}>
                          {area.shiftCount > 0 ? shiftCountLabel(area.shiftCount) : tl(locale, "aus")}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-slate-500">{area.sheets.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Rechte Spalte: Kapazität / Automatik / Szenarien ─────── */}
          <div className="space-y-3">
            <div className="rounded-2xl bg-slate-50 ring-1 ring-slate-200 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">{tl(locale, "Kapazitätsprüfungen")}</div>
              <div className="space-y-2">
                <ToggleChip
                  label={tl(locale, "Stationskonflikte")}
                  enabled={uiSettings.showStationConflicts}
                  locale={locale}
                  onClick={() => setUiSettings(prev => ({ ...prev, showStationConflicts: !prev.showStationConflicts }))}
                />
                <ToggleChip
                  label={tl(locale, "Poolkonflikte")}
                  enabled={uiSettings.showPoolConflicts}
                  locale={locale}
                  onClick={() => setUiSettings(prev => ({ ...prev, showPoolConflicts: !prev.showPoolConflicts }))}
                />
              </div>
            </div>

            <div className="rounded-2xl bg-slate-50 ring-1 ring-slate-200 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">{tl(locale, "Automatik")}</div>
              <ToggleChip
                label={tl(locale, "Auto-Vorschläge")}
                enabled={uiSettings.showAutoSuggestions}
                locale={locale}
                onClick={() => setUiSettings(prev => ({ ...prev, showAutoSuggestions: !prev.showAutoSuggestions }))}
              />
              <div className="mt-2 text-[11px] text-slate-500">
                {locale === "de" ? "Offene Rezepte bekommen nur dann Slot-Empfehlungen, wenn diese Automatik aktiv ist." : locale === "nl" ? "Open recepten krijgen alleen slotvoorstellen als deze automatiek actief is." : "Open recipes only receive slot suggestions when this automation is enabled."}
              </div>
            </div>

            <div className="rounded-2xl bg-slate-50 ring-1 ring-slate-200 p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">{tl(locale, "Szenarioverwaltung")}</div>
              <div className="space-y-2">
                <select
                  className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm"
                  value={scenario.id}
                  onChange={e => setStorage(prev => setActiveScenario(prev, week, e.target.value))}
                >
                  {weekState.scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input
                  className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm"
                  value={newScenarioName}
                  placeholder={locale === "de" ? "Neues Szenario..." : locale === "nl" ? "Nieuw scenario..." : "New scenario..."}
                  onChange={e => setNewScenarioName(e.target.value)}
                />
                <div className="flex gap-2">
                  <button className="btn flex-1" onClick={handleCreateScenario}>{tl(locale, "Klonen")}</button>
                  <button className="btn flex-1" onClick={() => setStorage(prev => resetScenario(prev, week, scenario.id))}>{tl(locale, "Leeren")}</button>
                </div>
              </div>
            </div>
          </div>

        </div>
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <PlannerStat label={tl(locale, "Geplant")} value={fmtNum(analysis.plannedCount)} accent />
          <PlannerStat label={tl(locale, "Offen")} value={fmtNum(analysis.unplannedCount)} />
          <PlannerStat label={tl(locale, "Konflikte")} value={fmtNum(visibleConflictCount)} accent={visibleConflictCount > 0} />
          <PlannerStat label={tl(locale, "Szenario")} value={scenario.name} />
        </div>
        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <PlannerStat label={tl(locale, "Schichten aktiv")} value={fmtNum(activeShifts.length)} />
          <PlannerStat label={tl(locale, "Slots/Woche")} value={fmtNum(PLANNER_DAYS.length * activeShifts.length)} />
          <PlannerStat label={tl(locale, "Vorschläge")} value={fmtNum(suggestionCount)} accent={uiSettings.showAutoSuggestions && suggestionCount > 0} />
          <PlannerStat label={tl(locale, "Modell")} value={shiftPresetShortLabel(locale, activePreset.id)} />
        </div>
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-700">{tl(locale, "Shelf-Life-Risiko der Woche")}</span>
            <span className="pill bg-slate-200 text-slate-700">{locale === "de" ? "Kundenziel: 7 Tage Rest" : locale === "nl" ? "Klantdoel: 7 dagen restant" : "Customer target: 7 days remaining"}</span>
            <span className="pill bg-slate-200 text-slate-700">{locale === "de" ? "Sheet-Matches" : locale === "nl" ? "Sheet-matches" : "Sheet matches"}: {fmtNum(shelfRisk.total)}</span>
            <span className={`pill ${shelfTone(shelfRisk.critical.length > 0 ? "critical" : shelfRisk.risk.length > 0 ? "risk" : "ok")}`}>
              {tl(locale, "kritisch")} {fmtNum(shelfRisk.critical.length)} · {locale === "de" ? "knapp" : locale === "nl" ? "krap" : "tight"} {fmtNum(shelfRisk.risk.length)}
            </span>
          </div>
          {(shelfRisk.critical.length > 0 || shelfRisk.risk.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {shelfRisk.critical.slice(0, 6).map(item => (
                <span key={`critical-${item.skuCode}`} className={`pill ${shelfTone(item.status)}`}>
                  {item.skuCode} · MLOR {item.mlorRaw ?? "-"} · Open {item.openShelfLifeRaw ?? "-"}
                </span>
              ))}
              {shelfRisk.risk.slice(0, Math.max(0, 6 - shelfRisk.critical.length)).map(item => (
                <span key={`risk-${item.skuCode}`} className={`pill ${shelfTone(item.status)}`}>
                  {item.skuCode} · MLOR {item.mlorRaw ?? "-"} · Open {item.openShelfLifeRaw ?? "-"}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-semibold text-slate-700">{tl(locale, "Wochenrhythmus Montag bis Sonntag")}</h3>
          <span className="text-xs text-slate-500">{shiftPresetShortLabel(locale, activePreset.id)} {locale === "de" ? "aktiv" : locale === "nl" ? "actief" : "active"} · {activeShiftSummary}</span>
        </div>
        <div className="text-[11px] text-slate-500 mb-2">
          {locale === "de"
            ? "Backward-Plan: Plating Fr (DK/SE + BENL + DE Split 1) und So (DE Split 2). Subrezepte werden rueckwaerts ueber Lead-Zeit eingeplant. MHD: Fisch 9 Tage, sonst 13 Tage."
            : locale === "nl"
              ? "Backward-plan: plating Vr (DK/SE + BENL + DE Split 1) en Zo (DE Split 2). Sub-recepten via lead time rugwaarts. THT: vis 9 d, anders 13 d."
              : "Backward plan: plating Fri (DK/SE + BENL + DE Split 1) and Sun (DE Split 2). Sub-recipes scheduled backwards by lead time. Shelf life: fish 9d, else 13d."}
        </div>
        <div className="grid md:grid-cols-7 gap-2 text-sm">
          <div className="rounded-xl bg-amber-50 ring-1 ring-amber-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-amber-700">Mo · S1</div>
            <div className="mt-1 font-semibold">Inbound KW-1</div>
            <div className="mt-1 text-[11px] text-slate-700">Rohwarenannahme &amp; Quality-Gate fuer die laufende KW.</div>
            <div className="mt-1 text-[11px] text-slate-600">Lange Vorlaeufe: Brining, Curing, Marinade ueber Nacht.</div>
          </div>
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Di · S1</div>
            <div className="mt-1 font-semibold">Subrezepte L3</div>
            <div className="mt-1 text-[11px] text-slate-600">Saucen, Bruehen, Slow-Cook, Butter-Family. Liquide in Schalen vorbereiten.</div>
          </div>
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Mi · S1</div>
            <div className="mt-1 font-semibold">Subrezepte L2</div>
            <div className="mt-1 text-[11px] text-slate-600">Blast-Chiller, chilled Hold, Portionierung mit Vorlauf.</div>
          </div>
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Do · S1</div>
            <div className="mt-1 font-semibold">Wochenstart Plating-Prep</div>
            <div className="mt-1 text-[11px] text-slate-600">Vortags-Prep fuer Fr (Cutting, chilled Prep, Hot-Cook-Setup).</div>
          </div>
          <div className="rounded-xl bg-verden-50 ring-1 ring-verden-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-verden-700">Fr · S1</div>
            <div className="mt-1 font-semibold">Plating + Fulfillment 1</div>
            <div className="mt-1 text-xs text-slate-700">DK/SE komplett: <b>{fmtNum(split.dkse)}</b></div>
            <div className="text-xs text-slate-700">BENL komplett: <b>{fmtNum(split.benlFriday)}</b></div>
            <div className="text-xs text-slate-700">DE Split 1: <b>{fmtNum(split.deFriday)}</b></div>
          </div>
          <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 p-3 relative">
            <div className="text-[10px] uppercase tracking-wide text-rose-600">Sa</div>
            <div className="mt-1 font-semibold text-rose-700">Kueche nicht besetzt</div>
            <div className="mt-1 text-[11px] text-rose-700/80">Keine Produktion. Vorprod fuer So muss spaetestens Fr abgeschlossen sein.</div>
            <span className="absolute top-2 right-2 pill bg-rose-100 text-rose-700">geschlossen</span>
          </div>
          <div className="rounded-xl bg-blue-50 ring-1 ring-blue-200 p-3 relative">
            <div className="text-[10px] uppercase tracking-wide text-blue-700">So</div>
            <div className="mt-1 font-semibold">Fulfillment 2 (nur Versand)</div>
            <div className="mt-1 text-xs text-slate-700">DE Split 2: <b>{fmtNum(split.deSunday)}</b></div>
            <div className="mt-1 text-[11px] text-slate-600">Kueche zu — Plating-Ware kommt aus Fr-Vorprod (gekuehlt gehalten).</div>
            <span className="absolute top-2 right-2 pill bg-rose-100 text-rose-700">Kueche zu</span>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-slate-700">Batch-Split nach MHD &amp; Fulfillment-Tag</h3>
          <span className="text-[11px] text-slate-500">Kunde: 7 Tage Rest · Fisch MHD 9d, sonst 13d</span>
        </div>
        <div className="text-[11px] text-slate-500 mb-3">
          Sa &amp; So ist die Kueche in Verden nicht besetzt — produziert wird ausschliesslich Mo–Fr.
          Wenn DE am Sonntag gefulfillt wird, muss dieselbe SKU oft auf zwei Produktionstage gesplittet
          werden, damit beim Kunden noch 7 Tage Rest-MHD ankommen. Die Empfehlung unten zeigt pro Rezept
          die zwei Chargen mit Fenster und empfohlenem Produktionstag (immer Mo–Fr).
        </div>
        {batchSplitPlan.length === 0 ? (
          <div className="rounded-lg bg-slate-50 ring-1 ring-slate-200 px-3 py-2 text-xs text-slate-500">
            Keine Rezepte mit Volumen in dieser KW.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr className="border-b border-slate-200">
                  <th className="text-left py-1.5 pr-2">Rezept</th>
                  <th className="text-left py-1.5 pr-2">MHD</th>
                  <th className="text-left py-1.5 pr-2">Charge</th>
                  <th className="text-right py-1.5 pr-2">Portionen</th>
                  <th className="text-left py-1.5 pr-2">Fenster</th>
                  <th className="text-left py-1.5 pr-2">Empfohlen</th>
                  <th className="text-left py-1.5 pr-2">Begruendung</th>
                </tr>
              </thead>
              <tbody>
                {batchSplitPlan.slice(0, 30).map(plan => plan.batches.map((batch, idx) => (
                  <tr
                    key={`${plan.recipeCode}-${batch.fulfillmentDay}`}
                    className={`border-b border-slate-100 ${plan.batches.length > 1 ? "bg-amber-50/40" : ""}`}
                  >
                    {idx === 0 ? (
                      <td className="py-1.5 pr-2 align-top" rowSpan={plan.batches.length}>
                        <div className="font-mono font-semibold text-slate-800">{plan.recipeCode}</div>
                        <div className="text-[11px] text-slate-500">{plan.recipeName}</div>
                        {plan.batches.length > 1 && (
                          <span className="pill bg-amber-100 text-amber-800 mt-1">Split-Pflicht</span>
                        )}
                      </td>
                    ) : null}
                    {idx === 0 ? (
                      <td className="py-1.5 pr-2 align-top" rowSpan={plan.batches.length}>
                        <span className={`pill ${plan.isSeafood ? "bg-cyan-100 text-cyan-800" : "bg-slate-100 text-slate-700"}`}>
                          {plan.isSeafood ? "Fisch · 9d" : "Standard · 13d"}
                        </span>
                      </td>
                    ) : null}
                    <td className="py-1.5 pr-2">
                      <div className="font-semibold text-slate-800">{batch.fulfillmentDay}</div>
                      <div className="text-[10px] text-slate-500">{batch.fulfillmentLabel}</div>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{fmtNum(batch.portions)}</td>
                    <td className="py-1.5 pr-2">{batch.earliestProductionDay}–{batch.latestProductionDay}</td>
                    <td className="py-1.5 pr-2">
                      <span className="pill bg-emerald-100 text-emerald-800">{batch.recommendedProductionDay}</span>
                    </td>
                    <td className="py-1.5 pr-2 text-[11px] text-slate-600">{batch.reason}</td>
                  </tr>
                )))}
              </tbody>
            </table>
            {batchSplitPlan.length > 30 && (
              <div className="mt-2 text-[11px] text-slate-500">
                … {batchSplitPlan.length - 30} weitere Rezepte ohne Splitanforderung ausgeblendet.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">{tl(locale, "Konflikte & Engpässe")}</h3>
        <div className="space-y-2">
          {visibleStationConflicts.length === 0 && visiblePoolConflicts.length === 0 && (
            <div className="rounded-lg bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 px-3 py-2 text-sm">
              {locale === "de" ? "Aktuell keine Konflikte im aktiven Szenario." : locale === "nl" ? "Momenteel geen conflicten in het actieve scenario." : "Currently no conflicts in the active scenario."}
            </div>
          )}
          {visibleStationConflicts.slice(0, 8).map(conflict => (
            <div key={`${conflict.day}-${conflict.shift}-${conflict.station}`} className="rounded-lg bg-amber-50 ring-1 ring-amber-200 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-amber-900">
                  {conflict.day} · {conflict.shift} · {conflict.station}
                </div>
                <div className="text-xs font-medium text-amber-800">{topConflictLabel(conflict)}</div>
              </div>
              <div className="mt-1 text-[11px] text-amber-800">
                Geräte: {fmtNum(conflict.deviceCount)} · Kapazität: {fmtMin(conflict.capacityMin)} · Auslastung: {fmtNum(conflict.utilizationPct, 0)}%
              </div>
              <div className="mt-1 space-y-1 text-xs text-amber-900">
                {conflict.assignments.map(row => (
                  <div key={row.recipeCode} className="flex items-center justify-between gap-2">
                    <span>{row.recipeCode} · {row.recipeName}</span>
                    <span className="font-semibold tabular-nums">{fmtMin(row.minutes)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {visiblePoolConflicts.slice(0, 6).map(conflict => (
            <div key={`${conflict.day}-${conflict.shift}-${conflict.poolName}`} className="rounded-lg bg-rose-50 ring-1 ring-rose-200 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-rose-900">
                  {conflict.day} · {conflict.shift} · Pool {conflict.poolName}
                </div>
                <div className="text-xs font-medium text-rose-800">{topPoolConflictLabel(conflict)}</div>
              </div>
              <div className="mt-1 text-[11px] text-rose-800">
                Geräte im Pool: {fmtNum(conflict.deviceCount)} · Kapazität: {fmtMin(conflict.capacityMin)} · Auslastung: {fmtNum(conflict.utilizationPct, 0)}%
              </div>
              <div className="mt-1 space-y-1 text-xs text-rose-900">
                {conflict.assignments.slice(0, 6).map((row, index) => (
                  <div key={`${row.recipeCode}-${row.station}-${index}`} className="flex items-center justify-between gap-2">
                    <span>{row.recipeCode} · {row.station} · {row.recipeName}</span>
                    <span className="font-semibold tabular-nums">{fmtMin(row.minutes)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold text-slate-700">{tl(locale, "Rezept-Zuordnung")}</h3>
          <span className="text-xs text-slate-500">{locale === "de" ? "Direkt in Tag/Schicht legen oder wieder entfernen" : locale === "nl" ? "Direct in dag/ploeg zetten of weer verwijderen" : "Assign directly to day/shift or remove again"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="text-left py-1.5 pr-2">{tl(locale, "Code")}</th>
                <th className="text-left py-1.5 pr-2">{tl(locale, "Rezept")}</th>
                <th className="text-right py-1.5 pr-2">Σ {locale === "de" ? "aktiv" : locale === "nl" ? "actief" : "active"}</th>
                <th className="text-left py-1.5 pr-2">{tl(locale, "Top-Stationen")}</th>
                {uiSettings.showAutoSuggestions && <th className="text-left py-1.5 pr-2">{tl(locale, "Vorschlag")}</th>}
                <th className="text-left py-1.5">{tl(locale, "Plan-Slot")}</th>
              </tr>
            </thead>
            <tbody>
              {analysis.recipes.map(recipe => {
                const current = recipe.assigned ? slotValue(recipe.assigned.day, recipe.assigned.shift) : "";
                return (
                  <tr key={recipe.recipeCode} className={`border-b last:border-0 ${selectedRecipe === recipe.recipeCode ? "bg-verden-50" : ""}`}>
                    <td className="py-1.5 pr-2 font-mono text-xs text-slate-500">{recipe.recipeCode}</td>
                    <td className="py-1.5 pr-2">
                      <button className="text-left hover:text-verden-700" onClick={() => onSelectRecipe?.(recipe.recipeCode)}>
                        {recipe.recipeName}
                      </button>
                    </td>
                    <td className="py-1.5 pr-2 text-right font-semibold tabular-nums">{fmtMin(recipe.activeMin)}</td>
                    <td className="py-1.5 pr-2 text-xs text-slate-600">
                      {recipe.topStations.map(s => `${s.station} ${fmtMin(s.minutes)}`).join(" · ") || "—"}
                    </td>
                    {uiSettings.showAutoSuggestions && (
                      <td className="py-1.5 pr-2 text-xs text-slate-600">
                        {suggestions[recipe.recipeCode] ? (
                          <div className="space-y-1">
                            <button className="btn" onClick={() => applySuggestion(recipe.recipeCode)}>
                              {suggestions[recipe.recipeCode].day} · {suggestions[recipe.recipeCode].shift}
                            </button>
                            <div className="text-[10px] text-slate-500">{suggestions[recipe.recipeCode].reason}</div>
                          </div>
                        ) : <span className="text-slate-400">—</span>}
                      </td>
                    )}
                    <td className="py-1.5">
                      <select
                        className="w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-1.5 text-sm"
                        value={current}
                        onChange={e => updateAssignment(recipe.recipeCode, e.target.value)}
                      >
                        <option value="">{tl(locale, "nicht geplant")}</option>
                        {PLANNER_DAYS.map(day => activeShifts.map(shift => {
                          const value = slotValue(day, shift);
                          return <option key={value} value={value}>{day} · {shift}</option>;
                        }))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PlannerStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg px-2 py-1 ${accent ? "bg-verden-50 ring-1 ring-verden-500" : "bg-slate-50"}`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function ToggleChip({ label, enabled, onClick, locale }: { label: string; enabled: boolean; onClick: () => void; locale: UiLocale }) {
  return (
    <button
      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm ring-1 ${enabled ? "bg-verden-50 text-verden-800 ring-verden-200" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-100"}`}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${enabled ? "bg-verden-600 text-white" : "bg-slate-200 text-slate-600"}`}>
        {enabled ? tl(locale, "an") : tl(locale, "aus")}
      </span>
    </button>
  );
}