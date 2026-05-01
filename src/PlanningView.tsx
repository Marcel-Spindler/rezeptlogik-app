import { useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle, ShelfLifeInfo, WeekRecipe } from "./types";
import { STATIONS } from "./types";
import { DEFAULT_SHIFT_MIN, fmtMin, getStationCapacityView, loadStationDeviceCounts, loadStationPools } from "./equipment";
import {
  PLANNER_DAYS,
  PLANNER_SHIFTS,
  SHIFT_CAPACITY_MIN,
  DAY_VISIBLE_MIN,
  SHIFT_LENGTH_MIN,
  getShiftStartMin,
  getShiftFromStartMin,
  formatDayMin,
  analyzePlan,
  assignRecipe,
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

const PLANNER_UI_SETTINGS_STORAGE_KEY = "rezeptlogik-planner-ui-settings-v1";

/** Pixel-Höhe der Tages-Timeline (24h). 720px ≈ 30px / Stunde. */
const TIMELINE_HEIGHT_PX = 720;

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
  if (presetId === "single-current") return locale === "de" ? "Aktuell: Einschicht" : locale === "nl" ? "Actueel: 1 ploeg" : "Current: single shift";
  if (presetId === "double-ready") return locale === "de" ? "Vorbereitet: 2 Schichten" : locale === "nl" ? "Voorbereid: 2 ploegen" : "Prepared: 2 shifts";
  return locale === "de" ? "Vorbereitet: 3 Schichten" : locale === "nl" ? "Voorbereid: 3 ploegen" : "Prepared: 3 shifts";
}

function shiftPresetShortLabel(locale: UiLocale, presetId: string): string {
  if (presetId === "single-current") return locale === "de" ? "Einschicht" : locale === "nl" ? "1 ploeg" : "Single shift";
  if (presetId === "double-ready") return locale === "de" ? "2 Schichten" : locale === "nl" ? "2 ploegen" : "2 shifts";
  return locale === "de" ? "3 Schichten" : locale === "nl" ? "3 ploegen" : "3 shifts";
}

function shiftPresetNote(locale: UiLocale, presetId: string): string {
  if (presetId === "single-current") return locale === "de" ? "Produktivbetrieb heute. Das ist der sichere Default und bleibt beim Neuladen aktiv." : locale === "nl" ? "Huidige productie. Dit is de veilige standaard en blijft actief na herladen." : "Current production setup. This is the safe default and stays active after reload.";
  if (presetId === "double-ready") return locale === "de" ? "Ein Klick schaltet zusätzliche Slots zu, ohne die restliche Planung umzubauen." : locale === "nl" ? "Eén klik schakelt extra slots in zonder de rest van de planning om te bouwen." : "One click enables additional slots without rebuilding the rest of the plan.";
  return locale === "de" ? "Für späteren Mehrschichtbetrieb vorbereitet, inkl. 3 Assembly Lines im Fulfilment." : locale === "nl" ? "Voorbereid op later meerploegenbedrijf, inclusief 3 assembly lines in fulfilment." : "Prepared for future multi-shift operation, including 3 assembly lines in fulfilment.";
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
    deFriday,
    deSunday: Math.max(0, de - deFriday)
  };
}

export function PlanningView(
  { data, week, locale, upliftPercent = 0, selectedRecipe, onSelectRecipe }:
  { data: DataBundle; week: string; locale: UiLocale; upliftPercent?: number; selectedRecipe?: string | null; onSelectRecipe?: (recipeCode: string) => void }
) {
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
  const dayColumnRefs = useRef<Record<string, HTMLDivElement | null>>({});

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

  /** Tageszuordnungen mit Start- und Dauer-Minuten für die Timeline. */
  const timelineByDay = useMemo(() => {
    type Tile = {
      key: string;
      code: string;
      subRecipeId?: string;
      name: string;
      activeMin: number;
      startMin: number;
      shift: PlannerShift;
      kind: "main" | "sub";
      subCount: number; // für main-tile: Anzahl noch enthaltener Subs
    };
    const buckets: Record<string, Tile[]> = {};
    for (const recipe of analysis.recipes) {
      if (recipe.assigned && recipe.activeMin > 0) {
        const start = recipe.assigned.startMin ?? getShiftStartMin(recipe.assigned.shift);
        const remainingSubs = recipe.subRecipes.filter(s => !s.assigned).length;
        (buckets[recipe.assigned.day] ??= []).push({
          key: recipe.recipeCode,
          code: recipe.recipeCode,
          name: recipe.recipeName,
          activeMin: Math.max(15, recipe.activeMin),
          startMin: start,
          shift: recipe.assigned.shift,
          kind: "main",
          subCount: remainingSubs
        });
      }
      for (const sub of recipe.subRecipes) {
        if (!sub.assigned) continue;
        const start = sub.assigned.startMin ?? getShiftStartMin(sub.assigned.shift);
        (buckets[sub.assigned.day] ??= []).push({
          key: `${recipe.recipeCode}::${sub.subRecipeId}`,
          code: recipe.recipeCode,
          subRecipeId: sub.subRecipeId,
          name: `${sub.subRecipeName} (${recipe.recipeName})`,
          activeMin: Math.max(15, sub.activeMin),
          startMin: start,
          shift: sub.assigned.shift,
          kind: "sub",
          subCount: 0
        });
      }
    }
    for (const rows of Object.values(buckets)) rows.sort((a, b) => a.startMin - b.startMin);
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
    if (current && current.day === day && current.shift === shift && current.startMin === undefined) return;
    setStorage(prev => assignRecipe(prev, week, scenario.id, parsed.recipe, {
      day, shift,
      subRecipeId: parsed.subRecipeId,
      subRecipeName: parsed.subRecipeName
    }));
  }

  /** Drop on a day's timeline at pixel offset → compute startMin (snap to 15 min). */
  function handleDropOnTimeline(event: React.DragEvent, day: PlannerDay, columnEl: HTMLElement) {
    event.preventDefault();
    const parsed = parseDropPayload(event);
    setDragOverSlot(null);
    handleDragEnd();
    if (!parsed) return;
    const rect = columnEl.getBoundingClientRect();
    const offsetY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const minPerPx = DAY_VISIBLE_MIN / rect.height;
    const rawMin = offsetY * minPerPx;
    const SNAP = 15;
    const startMin = Math.max(0, Math.min(DAY_VISIBLE_MIN - SNAP, Math.round(rawMin / SNAP) * SNAP));
    const shift = getShiftFromStartMin(startMin);
    setStorage(prev => assignRecipe(prev, week, scenario.id, parsed.recipe, {
      day, shift, startMin,
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

  return (
    <div className="space-y-3">
      {/* ── TOP: Wochenboard mit Drag & Drop ──────────────────────────────── */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-slate-800">{locale === "de" ? "Wochenboard" : locale === "nl" ? "Weekboard" : "Week board"} · {week}</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {locale === "de" ? "Rezepte oben in Tag/Schicht-Karten ziehen · zwischen Slots verschieben · zurück nach 'Offen' zum Entfernen" : locale === "nl" ? "Recepten naar dag-/ploegkaarten slepen · tussen slots verplaatsen · terug naar 'Open' om te verwijderen" : "Drag recipes into day/shift cards · move between slots · drag back to 'Open' to remove"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-700 ring-1 ring-slate-200">
              {analysis.plannedCount} {locale === "de" ? "geplant" : locale === "nl" ? "gepland" : "planned"}
            </span>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-200">
              {unplanned.length} {locale === "de" ? "offen" : locale === "nl" ? "open" : "open"}
            </span>
            <span className="rounded-full bg-verden-50 px-2 py-0.5 text-[10px] font-semibold text-verden-700 ring-1 ring-verden-200">
              {shiftPresetShortLabel(locale, activePreset.id)}
            </span>
            <button
              className="rounded-lg bg-rose-50 text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100 px-3 py-1 text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={() => {
                if (analysis.plannedCount === 0) return;
                if (window.confirm(locale === "de" ? `Kalender für Szenario '${scenario.name}' wirklich leeren? ${analysis.plannedCount} Zuordnung(en) gehen verloren.` : locale === "nl" ? `Kalender voor scenario '${scenario.name}' echt leegmaken? ${analysis.plannedCount} toewijzing(en) gaan verloren.` : `Clear the calendar for scenario '${scenario.name}'? ${analysis.plannedCount} assignment(s) will be lost.`)) {
                  setStorage(prev => resetScenario(prev, week, scenario.id));
                }
              }}
              disabled={analysis.plannedCount === 0}
              title={locale === "de" ? "Alle Rezepte aus dem Kalender entfernen" : locale === "nl" ? "Alle recepten uit de kalender verwijderen" : "Remove all recipes from the calendar"}
            >
              {locale === "de" ? "🗑 Kalender leeren" : locale === "nl" ? "🗑 Kalender leegmaken" : "🗑 Clear calendar"}
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
              {locale === "de" ? "Verfügbare Rezepte" : locale === "nl" ? "Beschikbare recepten" : "Available recipes"} · {unplanned.length}
            </div>
            <div className="text-[10px] text-slate-400">
              {dragOverUnplanned ? (locale === "de" ? "Loslassen -> aus Plan nehmen" : locale === "nl" ? "Loslaten -> uit plan halen" : "Release -> remove from plan") : (locale === "de" ? "↓ in Tag/Schicht ziehen" : locale === "nl" ? "↓ naar dag/ploeg slepen" : "↓ drag into day/shift")}
            </div>
          </div>
          {unplanned.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-emerald-700 bg-emerald-50 rounded-md ring-1 ring-emerald-200">
              {locale === "de" ? "✓ Alle Rezepte verplant" : locale === "nl" ? "✓ Alle recepten ingepland" : "✓ All recipes scheduled"}
            </div>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {unplanned.map(recipe => {
                const isExpanded = expandedRecipes.has(recipe.recipeCode);
                const openSubs = recipe.subRecipes.filter(s => !s.assigned && s.activeMin > 0);
                const hasMain = !recipe.assigned;
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
                          ? `${recipe.recipeName} · Σ verbleibend ${fmtMin(totalRemaining)}${openSubs.length < recipe.subRecipes.length ? ` (${recipe.subRecipes.length - openSubs.length} Sub bereits geplant)` : ""}`
                          : `${recipe.recipeName} · Hauptrezept geplant – nur noch Subs offen`}
                        className={`w-full text-left ${hasMain ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-mono text-[10px] text-slate-500">{hasMain ? "⋮⋮" : "✓"} {recipe.recipeCode}</span>
                          <span className="text-[10px] font-semibold text-slate-700 tabular-nums">{fmtMin(recipe.activeMin)}</span>
                        </div>
                        <div className="text-xs font-medium leading-tight text-slate-800 line-clamp-2">{recipe.recipeName}</div>
                        <div className="mt-0.5 text-[10px] text-slate-500 truncate">
                          {recipe.topStations.map(s => s.station).join(" · ") || "—"}
                        </div>
                      </button>
                      {recipe.subRecipes.length > 0 && (
                        <button
                          className="mt-1 w-full text-[10px] font-semibold text-verden-700 hover:text-verden-900 bg-verden-50 hover:bg-verden-100 rounded px-1 py-0.5 ring-1 ring-verden-200"
                          onClick={() => setExpandedRecipes(prev => {
                            const next = new Set(prev);
                            if (next.has(recipe.recipeCode)) next.delete(recipe.recipeCode);
                            else next.add(recipe.recipeCode);
                            return next;
                          })}
                        >
                          {isExpanded ? "▾" : "▸"} {openSubs.length}/{recipe.subRecipes.length} {tl(locale, "Sub-Rezepte")}
                        </button>
                      )}
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
                                : `${sub.subRecipeName} · ${sub.category} · ${fmtMin(sub.activeMin)} – ziehen, um Sub separat zu planen`}
                              className={`w-full text-left rounded px-1.5 py-1 text-[10px] ring-1 transition-all ${isPlanned ? "bg-emerald-50 ring-emerald-200 text-emerald-800 cursor-not-allowed" : draggingSubId === sub.subRecipeId ? "opacity-40 bg-amber-50 ring-amber-300" : "bg-white ring-slate-200 hover:ring-amber-400 hover:bg-amber-50 cursor-grab active:cursor-grabbing"}`}
                            >
                              <div className="flex items-center justify-between gap-1">
                                <span className="font-semibold leading-tight line-clamp-1">{isPlanned ? "✓ " : "⋮⋮ "}{sub.subRecipeName}</span>
                                <span className="font-mono tabular-nums shrink-0">{fmtMin(sub.activeMin)}</span>
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

        {/* Tages-Timeline – jede Spalte ist ein voller Tag mit Zeitachse */}
        <div className="flex gap-2 overflow-x-auto">
          {/* Zeitachsen-Beschriftung links */}
          <div className="shrink-0 w-12 pt-7 pb-1">
            <div className="relative" style={{ height: `${TIMELINE_HEIGHT_PX}px` }}>
              {Array.from({ length: 9 }).map((_, i) => {
                const hour = i * 3; // alle 3h: 06,09,12,15,18,21,00,03,06
                const min = hour * 60;
                const top = (min / DAY_VISIBLE_MIN) * TIMELINE_HEIGHT_PX;
                return (
                  <div key={hour} className="absolute right-1 -translate-y-1/2 text-[10px] font-mono text-slate-400 tabular-nums" style={{ top: `${top}px` }}>
                    {formatDayMin(min)}
                  </div>
                );
              })}
            </div>
          </div>

          {PLANNER_DAYS.map(day => {
            const dayItems = timelineByDay[day] ?? [];
            const isAnyDragOver = dragOverSlot?.startsWith(`${day}__`);
            const isDragActive = draggingCode !== null;
            return (
              <div key={day} className="flex-1 min-w-[140px]">
                <div className="text-center text-xs font-bold uppercase tracking-wide text-slate-700 bg-slate-100 rounded-md py-1 mb-1">
                  {day} <span className="text-[10px] font-normal text-slate-500">· {dayItems.length}</span>
                </div>
                <div
                  ref={el => { dayColumnRefs.current[day] = el; }}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverSlot !== `${day}__TL`) setDragOverSlot(`${day}__TL`); }}
                  onDragLeave={() => { if (dragOverSlot === `${day}__TL`) setDragOverSlot(null); }}
                  onDrop={e => { const el = dayColumnRefs.current[day]; if (el) handleDropOnTimeline(e, day, el); }}
                  className={`relative rounded-lg ring-1 transition-all bg-white ${isAnyDragOver ? "ring-2 ring-verden-500 bg-verden-50" : isDragActive ? "ring-dashed ring-slate-300" : "ring-slate-200"}`}
                  style={{ height: `${TIMELINE_HEIGHT_PX}px` }}
                >
                  {/* Schicht-Hintergrundbänder */}
                  {(["S1", "S2", "S3"] as const).map((shift, idx) => {
                    const top = (getShiftStartMin(shift) / DAY_VISIBLE_MIN) * TIMELINE_HEIGHT_PX;
                    const height = (SHIFT_LENGTH_MIN / DAY_VISIBLE_MIN) * TIMELINE_HEIGHT_PX;
                    const tones = ["bg-emerald-50/40", "bg-amber-50/40", "bg-sky-50/40"];
                    return (
                      <div key={shift} className={`absolute inset-x-0 ${tones[idx]} pointer-events-none`} style={{ top: `${top}px`, height: `${height}px` }}>
                        <div className="text-[9px] font-bold text-slate-400 px-1 pt-0.5">{shift}</div>
                      </div>
                    );
                  })}
                  {/* Stunden-Gitterlinien */}
                  {Array.from({ length: 8 }).map((_, i) => {
                    const min = (i + 1) * 3 * 60;
                    const top = (min / DAY_VISIBLE_MIN) * TIMELINE_HEIGHT_PX;
                    return <div key={i} className="absolute inset-x-0 border-t border-dashed border-slate-200 pointer-events-none" style={{ top: `${top}px` }} />;
                  })}

                  {/* Rezept-/Sub-Kacheln absolut positioniert */}
                  {dayItems.map(item => {
                    const top = (item.startMin / DAY_VISIBLE_MIN) * TIMELINE_HEIGHT_PX;
                    const heightRaw = (item.activeMin / DAY_VISIBLE_MIN) * TIMELINE_HEIGHT_PX;
                    const height = Math.max(28, heightRaw);
                    const isSelected = selectedRecipe === item.code;
                    const isSub = item.kind === "sub";
                    const isDragging = draggingCode === item.code && (draggingSubId ?? null) === (item.subRecipeId ?? null);
                    return (
                      <button
                        key={item.key}
                        draggable
                        onDragStart={e => { e.stopPropagation(); handleDragStart(e, item.code, item.subRecipeId); }}
                        onDragEnd={handleDragEnd}
                        onClick={() => onSelectRecipe?.(item.code)}
                        title={`${item.name} · ${isSub ? "Sub-Rezept" : `Hauptkachel (${item.subCount} Sub${item.subCount === 1 ? "" : "s"} enthalten)`} · ${fmtMin(item.activeMin)} · Start ${formatDayMin(item.startMin)}`}
                        className={`absolute rounded-md px-1.5 py-1 text-left ring-1 cursor-grab active:cursor-grabbing transition-opacity overflow-hidden ${isDragging ? "opacity-30" : ""} ${isSub
                          ? (isSelected ? "bg-amber-600 text-white ring-amber-700 z-10 shadow-lg" : "bg-amber-50 ring-amber-400 hover:ring-amber-600 hover:shadow-md text-amber-900")
                          : (isSelected ? "bg-verden-600 text-white ring-verden-700 z-10 shadow-lg" : "bg-white ring-verden-300 hover:ring-verden-500 hover:shadow-md text-slate-800")}`}
                        style={{
                          top: `${top}px`,
                          height: `${height}px`,
                          // Subs etwas eingerückt, damit man sie visuell von Mains unterscheiden kann
                          left: isSub ? "12px" : "4px",
                          right: isSub ? "4px" : "4px"
                        }}
                      >
                        <div className="flex items-center justify-between gap-1 leading-none">
                          <span className="font-mono text-[9px] opacity-70">{isSub ? "▸" : "⋮⋮"} {item.code}</span>
                          <span className="text-[9px] font-mono opacity-70">{formatDayMin(item.startMin)}</span>
                        </div>
                        <div className="text-[10px] font-semibold leading-tight mt-0.5 line-clamp-2">{item.name}</div>
                        {height >= 50 && (
                          <div className="text-[9px] opacity-70 mt-0.5">
                            {fmtMin(item.activeMin)}{!isSub && item.subCount > 0 ? ` · ${item.subCount} Subs inkl.` : ""}
                          </div>
                        )}
                      </button>
                    );
                  })}

                  {/* Leer-Hint */}
                  {dayItems.length === 0 && !isAnyDragOver && (
                    <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-300 pointer-events-none">
                      {isDragActive ? (locale === "de" ? "hier ablegen" : locale === "nl" ? "hier neerzetten" : "drop here") : (locale === "de" ? "leer" : locale === "nl" ? "leeg" : "empty")}
                    </div>
                  )}
                  {isAnyDragOver && (
                    <div className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-verden-700 pointer-events-none">
                      {locale === "de" ? "ablegen -> Uhrzeit ergibt sich aus Position" : locale === "nl" ? "neerzetten -> starttijd volgt uit positie" : "drop -> start time follows from position"}
                    </div>
                  )}
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
              {locale === "de" ? "Lokaler Szenario-Planer im Browser. Keine Firestore-Schreibvorgänge, keine Live-Risiken." : locale === "nl" ? "Lokale scenarioplanner in de browser. Geen Firestore-schrijfacties, geen live-risico's." : "Local scenario planner in the browser. No Firestore writes, no live risks."}
              {upliftPercent !== 0 ? ` ${locale === "de" ? "Aktiver Planfaktor" : locale === "nl" ? "Actieve planfactor" : "Active plan factor"}: ${upliftPercent > 0 ? "+" : ""}${upliftPercent}%.` : ""}
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
          <h3 className="text-sm font-semibold text-slate-700">{tl(locale, "Wochenrhythmus Donnerstag bis Sonntag")}</h3>
          <span className="text-xs text-slate-500">{shiftPresetShortLabel(locale, activePreset.id)} {locale === "de" ? "aktiv" : locale === "nl" ? "actief" : "active"} · {activeShiftSummary}</span>
        </div>
        <div className="grid md:grid-cols-4 gap-3 text-sm">
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Do · S1</div>
            <div className="mt-1 font-semibold">Wochenstart Produktion</div>
            <div className="mt-1 text-xs text-slate-600">Alle Prep-/Chiller-Teile für Freitag nach vorne ziehen.</div>
          </div>
          <div className="rounded-xl bg-verden-50 ring-1 ring-verden-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-verden-700">Fr · S1</div>
            <div className="mt-1 font-semibold">Fulfillment 1</div>
            <div className="mt-1 text-xs text-slate-700">DK/SE komplett: <b>{fmtNum(split.dkse)}</b></div>
            <div className="text-xs text-slate-700">DE Split 1: <b>{fmtNum(split.deFriday)}</b></div>
          </div>
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Sa · S1</div>
            <div className="mt-1 font-semibold">Vorproduktion Sonntag</div>
            <div className="mt-1 text-xs text-slate-600">Restliche Deutschland-Mengen fuer Sonntag vorbereiten.</div>
          </div>
          <div className="rounded-xl bg-blue-50 ring-1 ring-blue-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-blue-700">So · S1</div>
            <div className="mt-1 font-semibold">Fulfillment 2</div>
            <div className="mt-1 text-xs text-slate-700">DE Split 2: <b>{fmtNum(split.deSunday)}</b></div>
            {split.benl > 0 && <div className="mt-1 text-xs text-slate-600">BENL: <b>{fmtNum(split.benl)}</b> ohne festen Packsplit im Modell.</div>}
          </div>
        </div>
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