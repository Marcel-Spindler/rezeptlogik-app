import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DataBundle, ShelfLifeInfo, WeekRecipe } from "./core/types";
import { getFirebase, doc, setDoc, onSnapshot } from "./core/firebase";
import { STATIONS } from "./core/types";
import { DEFAULT_SHIFT_MIN, fmtMin, getStationCapacityView, loadStationDeviceCounts, loadStationPools } from "./lib/equipment";
import {
  assignmentKey,
  PLANNER_DAYS,
  PLANNER_SHIFTS,
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
  type PlannerScenario,
  type LinePlatingSummary,
  type LinePlatingEntry,
  type SpecialDeliveryOrder,
} from "./lib/planner";
import { tl, type UiLocale } from "./lib/i18n";
import { usePlanningOasisData } from "./lib/planningOasisData";
import { exportAsTSV, exportAsExcel, exportAsPDF } from "./lib/planExport";
import type { RunSplitPlan } from "./lib/runPlanning";
import { calculateRunSplit } from "./lib/runPlanning";
import { recordRampUpSnapshot, type RampUpSnapshot, type RampUpChangeEvent } from "./lib/rampUpHistory";
import {
  type PlannerUiSettings,
  PLANNER_UI_SETTINGS_STORAGE_KEY,
  SHIFT_MODEL_PRESETS,
  SHIFT_MODEL_AREAS,
  loadPlannerUiSettings,
  shiftCountLabel,
  getShiftPreset,
  shiftPresetLabel,
  shiftPresetShortLabel,
  shiftPresetNote,
} from "./features/planning-oasis/cockpit/plannerUiSettings";
import {
  type SpecialDeliveryDraft,
  loadSpecialDeliveries,
  saveSpecialDeliveries,
} from "./features/planning-oasis/cockpit/specialDelivery";
import {
  type ManufacturingDaySummary,
  MANUFACTURING_DAYS,
  REGULAR_SUB_DAYS,
  slotValue,
  parseSlot,
  pickLowestLoadSlotWithFallback,
  pickLowestRegularSubSlotWithFallback,
  pickLowestLoadSlotForDayWithFallback,
  topConflictLabel,
  topPoolConflictLabel,
  extraDevicesLabel,
  serializeBatchesForNote,
  normalizeBatches,
  runSubBatchesForAssignment,
  isSundayPrepSub,
  subLeadDaysBeforeNeed,
  preferredSubProductionDay,
  parseBoardNote,
  buildBoardNote,
  extractSplitSpecFromNotes,
  stripSplitSpecFromNotes,
  composeBoardNotes,
  parseSplitSpecToBatches,
} from "./features/planning-oasis/cockpit/slotScheduling";
import {
  resolvePlanningRecipe,
  shelfTone,
  weekBoardRecipeTone,
  buildInfoHintsFromDumps,
  getSubRecipeInfo,
  type InfoHints,
} from "./features/planning-oasis/cockpit/recipeInfoHints";
import {
  type PlanningRulesConfig,
  loadPlanningRules,
  savePlanningRules,
  resolveMarketFulfillmentBatches,
  isFishRecipe,
} from "./features/planning-oasis/cockpit/planningRules";
import {
  buildPlanningContext,
  type ProposedAssignmentChange,
} from "./features/planning-oasis/cockpit/planningAI";
import { PlanningAIPanel } from "./features/planning-oasis/cockpit/PlanningAIPanel";
import { RampUpSparkline, RampUpDeltaBadge, PlannerStat, ToggleChip } from "./features/planning-oasis/cockpit/CockpitMiniWidgets";
import { BoardEditorModal, type WeekBoardEditorState, type WeekBoardEditorDraft } from "./features/planning-oasis/cockpit/modals/BoardEditorModal";
import { DayDetailModal } from "./features/planning-oasis/cockpit/modals/DayDetailModal";
import { SubRecipeInfoModal, type SubRecipeInfoRequest } from "./features/planning-oasis/cockpit/modals/SubRecipeInfoModal";

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

type ManufacturingSnapshotPayload = {
  savedAtIso: string;
  savedAtLabel: string;
  week: string;
  scenarioId: string;
  scenarioName: string;
  assignments: PlannerScenario["assignments"];
  stats: {
    plannedCount: number;
    unplannedCount: number;
  };
  syncMode: "live" | "manual";
};

export function PlanningView(
  { data, week, locale, upliftPercent = 0, selectedRecipe, onSelectRecipe, onPlanSnapshotSaved }:
  { data: DataBundle; week: string; locale: UiLocale; upliftPercent?: number; selectedRecipe?: string | null; onSelectRecipe?: (recipeCode: string) => void; onPlanSnapshotSaved?: () => void }
) {
  const { data: planningOasis } = usePlanningOasisData();
  const [storage, setStorage] = useState(() => loadPlannerStorage());
  const [newScenarioName, setNewScenarioName] = useState("");
  const [stationDeviceCounts] = useState(() => loadStationDeviceCounts());
  const [stationPools] = useState(() => loadStationPools());
  const [uiSettings, setUiSettings] = useState<PlannerUiSettings>(() => loadPlannerUiSettings());
  const [planningRules, setPlanningRules] = useState<PlanningRulesConfig>(() => loadPlanningRules());
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [draggingCode, setDraggingCode] = useState<string | null>(null);
  const [_draggingSubId, setDraggingSubId] = useState<string | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<string | null>(null);
  // Refs für synchronen Zugriff in dragover-Handlern (State wäre stale wegen Closure)
  const draggingCodeRef = useRef<string | null>(null);
  const draggingSubIdRef = useRef<string | null>(null);
  const [dragOverUnplanned, setDragOverUnplanned] = useState(false);
  const [_expandedRecipes, _setExpandedRecipes] = useState<Set<string>>(new Set());
  const [expandedBoardRecipes, setExpandedBoardRecipes] = useState<Set<string>>(new Set());
  const [boardEditor, setBoardEditor] = useState<WeekBoardEditorState | null>(null);
  const [dayDetailModal, setDayDetailModal] = useState<PlannerDay | null>(null);
  const [subRecipeInfoRequest, setSubRecipeInfoRequest] = useState<SubRecipeInfoRequest | null>(null);
  const [infoHints, setInfoHints] = useState<InfoHints>(() => ({
    capacityHints: new Map(),
    pieceWeightKg: new Map(),
    trayHints: []
  }));
  const [boardDraft, setBoardDraft] = useState<WeekBoardEditorDraft>({
    shift: "S1",
    targetPortions: 0,
    reason: "Planned",
    splitSpec: "",
    notes: "",
    createSubRecipeWOs: false,
  });
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  // Bewusst NICHT breiten-basiert automatisch aktiviert: der Vollansicht-Overlay
  // ist "fixed inset-2 z-[120]" und deckt damit auch die Planning-OASE-Tableiste
  // (Cockpit/Linienplanung/Rack) ab, die außerhalb dieser Komponente liegt — bei
  // < 1700px (praktisch jeder normale Monitor) wirkte "Rack" dadurch verschwunden.
  const [calendarFullView, setCalendarFullView] = useState(false);
  const [savePlanStamp, setSavePlanStamp] = useState<string | null>(null);
  const [rampUpHistoryMap, setRampUpHistoryMap] = useState<Map<string, RampUpSnapshot[]>>(new Map());
  const [rampUpChanges, setRampUpChanges] = useState<RampUpChangeEvent[]>([]);
  const [rampUpBannerDismissed, setRampUpBannerDismissed] = useState(false);
  const [specialDeliveries, setSpecialDeliveries] = useState<SpecialDeliveryOrder[]>(() => loadSpecialDeliveries(week));
  const [specialDeliveryDraft, setSpecialDeliveryDraft] = useState<SpecialDeliveryDraft>({
    recipeCode: "",
    fulfillmentDay: "Do",
    portions: 0,
    market: "",
    note: "",
  });

  /** Plating-Plan aus Firestore (apps/rezeptlogik/platingPlan/{week}) */
  const [platingPlan, setPlatingPlan] = useState<import("./core/types").PlatingPlanData | null>(null);

  /** Raw schedule aus dem Linienplan (Firestore), keyed als "{PlanDay}|{slotKey}|{lineIdx}" */
  const [linePlanSchedule, setLinePlanSchedule] = useState<Record<string, { code: string; speedPerMin: number } | null>>({});
  const [linePlanCapacityByLane, setLinePlanCapacityByLane] = useState<Record<string, number>>({});
  const [linePlanRunSplitByRecipe, setLinePlanRunSplitByRecipe] = useState<Record<string, RunSplitPlan>>({});
  const lastPublishedManufacturingSignatureRef = useRef<string>("");
  const lastManufacturingReconcileRequestRef = useRef<string>("");
  // "Latest ref" für handleAutoPlanWeekBoard: der Reconcile-Listener-Effect
  // unten abonniert absichtlich nur bei week/activeShifts.length-Wechsel neu
  // (nicht bei jedem Render, sonst würde der Firestore-onSnapshot-Listener
  // ständig ab-/wieder angemeldet). Damit ein extern (Cross-Tab/Firestore)
  // ausgelöster Reconcile-Request trotzdem immer mit aktuellen data/
  // portionMultiplier/activeShifts-Werten rechnet statt mit dem Stand vom
  // letzten Resubscribe, wird hier bei jedem Render die neueste Funktion
  // nachgezogen, statt sie in die Dependency-Liste aufzunehmen.
  const handleAutoPlanWeekBoardRef = useRef<() => void>(() => {});

  useEffect(() => {
    setSpecialDeliveries(loadSpecialDeliveries(week));
  }, [week]);

  useEffect(() => {
    saveSpecialDeliveries(week, specialDeliveries);
  }, [specialDeliveries, week]);

  useEffect(() => {
    savePlannerStorage(storage);
  }, [storage]);

  // Ramp-Up Snapshot bei Datenwechsel aufzeichnen
  useEffect(() => {
    if (!data.weekRecipes?.length) return;
    const { changes, history } = recordRampUpSnapshot(week, data.weekRecipes);
    const allCodes = new Set(data.weekRecipes.filter(r => r.hfWeek === week).map(r => r.code));
    const histMap = new Map<string, RampUpSnapshot[]>();
    for (const code of allCodes) histMap.set(code, history.filter(s => code in s.volumes));
    setRampUpHistoryMap(histMap);
    if (changes.length > 0) {
      setRampUpChanges(changes);
      setRampUpBannerDismissed(false);
    }
  }, [data.weekRecipes, week]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PLANNER_UI_SETTINGS_STORAGE_KEY, JSON.stringify(uiSettings));
  }, [uiSettings]);

  useEffect(() => {
    savePlanningRules(planningRules);
  }, [planningRules]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!calendarFullView) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCalendarFullView(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [calendarFullView]);

  // Kapazitäts- und Tray-Hinweise aus den GSheet-Dumps laden (für Info-Modal)
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [masterRes, biblesRes] = await Promise.all([
          fetch("/data/gsheet-dump-NEW_MASTER_SUPERVISORS_WORKLOAD_PLANNING.json"),
          fetch("/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json"),
        ]);
        if (!masterRes.ok || !biblesRes.ok) return;
        const [masterDump, biblesDump] = await Promise.all([masterRes.json(), biblesRes.json()]);
        if (!active) return;
        setInfoHints(buildInfoHintsFromDumps(masterDump, biblesDump));
      } catch {
        // Hinweise optional – Berechnung arbeitet auch ohne
      }
    })();
    return () => { active = false; };
  }, []);

  // Linienplan aus Firestore laden – selbe Datenquelle wie LinePlanningView
  useEffect(() => {
    let unsub: (() => void) | undefined;
    void (async () => {
      try {        const { db } = getFirebase();
        // Wochenformat "2026-W19" → weekStr "19"
        const weekStr = week.includes("-W") ? week.split("-W")[1] : week;
        unsub = onSnapshot(
          doc(db, "apps/rezeptlogik/lineplanning", `de_W${weekStr}`),
          (snap) => {
            if (snap.exists()) {
              const data = snap.data() as {
                schedule?: Record<string, { code: string; speedPerMin: number } | null>;
                cockpitPlan?: Record<string, Array<{ slot: string; line: number; code: string }>>;
                lineCapacityByLane?: Record<string, number>;
                runSplitByRecipe?: Record<string, RunSplitPlan>;
              };

              const fromSchedule = data.schedule ?? {};
              const hasSchedule = Object.keys(fromSchedule).length > 0;
              const fromCockpit: Record<string, { code: string; speedPerMin: number } | null> = {};
              if (!hasSchedule && data.cockpitPlan) {
                for (const [day, rows] of Object.entries(data.cockpitPlan)) {
                  for (const row of rows ?? []) {
                    const lineIdx = Math.max(0, Number(row.line ?? 1) - 1);
                    const slot = String(row.slot ?? "").trim();
                    const code = String(row.code ?? "").trim();
                    if (!day || !slot || !code) continue;
                    fromCockpit[`${day}|${slot}|${lineIdx}`] = { code, speedPerMin: 10 };
                  }
                }
              }

              setLinePlanSchedule(hasSchedule ? fromSchedule : fromCockpit);
              setLinePlanCapacityByLane(data.lineCapacityByLane ?? {});
              setLinePlanRunSplitByRecipe(data.runSplitByRecipe ?? {});
            } else {
              setLinePlanSchedule({});
              setLinePlanCapacityByLane({});
              setLinePlanRunSplitByRecipe({});
            }
          },
          () => { /* Fehler ignorieren – Linienplan ist optional */ }
        );
      } catch {
        // Firestore nicht verfügbar – Linienplan-Integration deaktiviert
      }
    })();
    return () => unsub?.();
  }, [week]);

  // Plating-Plan aus Firestore laden (apps/rezeptlogik/platingPlan/{week})
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const { subscribePlatingPlan } = await import("./features/plating-import/platingPlanFirestore");
        if (disposed) return;
        const unsub = subscribePlatingPlan(week, data => { if (!disposed) setPlatingPlan(data); });
        return () => { disposed = true; unsub(); };
      } catch {
        // Plating-Plan optional
      }
    })();
    return () => { disposed = true; };
  }, [week]);

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

  // Englische Tagesnamen (aus Plating-Plan CSV) → PlannerDay
  const PLAT_DAY_TO_PLANNER: Record<string, PlannerDay> = {
    "Sunday": "So", "Monday": "Mo", "Tuesday": "Di",
    "Wednesday": "Mi", "Thursday": "Do", "Friday": "Fr", "Saturday": "Sa",
  };

  // Frühester Plating-Tag pro Rezept (aus importiertem Plating-Plan)
  const platingDayByRecipe = useMemo((): Record<string, PlannerDay> => {
    if (!platingPlan) return {};
    const result: Record<string, PlannerDay> = {};
    for (const r of platingPlan.recipes) {
      const days = r.platingDays
        .map(pd => PLAT_DAY_TO_PLANNER[pd.day])
        .filter((d): d is PlannerDay => !!d);
      const earliest = [...days].sort((a, b) => PLANNER_DAYS.indexOf(a) - PLANNER_DAYS.indexOf(b))[0];
      if (earliest) result[r.recipeCode] = earliest;
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platingPlan]);

  // Plating-Gesamtmenge pro Tag (für Column-Header-Badge)
  const platingQtyByDay = useMemo((): Partial<Record<PlannerDay, number>> => {
    if (!platingPlan) return {};
    const result: Partial<Record<PlannerDay, number>> = {};
    for (const r of platingPlan.recipes) {
      for (const pd of r.platingDays) {
        const day = PLAT_DAY_TO_PLANNER[pd.day];
        if (day) result[day] = (result[day] ?? 0) + pd.qty;
      }
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platingPlan]);

  // Auto-Fill: wenn ein neuer Plating-Plan importiert wurde, Calendar automatisch befüllen
  const needsAutoFillRef = useRef(false);
  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent<{ week: string }>).detail?.week === week) needsAutoFillRef.current = true;
    };
    window.addEventListener("rezeptlogik:plating-plan-saved", handler);
    return () => window.removeEventListener("rezeptlogik:plating-plan-saved", handler);
  }, [week]);
  useEffect(() => {
    if (!platingPlan || !needsAutoFillRef.current) return;
    needsAutoFillRef.current = false;
    setTimeout(() => handleAutoPlanWeekBoardRef.current(), 80);
  }, [platingPlan]);

  /**
   * Berechnet pro Rezept und Tag, welche Kapazität die Plating-Linien haben.
   * Schichten-Durations entsprechen den SLOTS aus LinePlanningView.
   * Muss VOR suggestions berechnet werden, da suggestAssignments den platDay
   * aus dem Linienplan als Anker für die rückwärtige Küchenplanung nutzt.
   */
  const linePlatingSummary = useMemo((): LinePlatingSummary => {
    const SLOT_DURATIONS: Record<string, number> = {
      "06:00-07:00": 60, "07:00-08:00": 60, "08:00-08:30": 30,
      "09:00-10:00": 60, "10:00-11:00": 60, "11:30-12:00": 30,
      "12:00-13:00": 60, "13:00-14:00": 60, "14:00-15:00": 60,
    };
    // Linienplan-Tagesbezeichnungen → PlannerDay
    const DAY_MAP: Record<string, PlannerDay> = {
      "Freitag": "Fr", "Samstag": "Sa", "Sonntag": "So",
      "Montag": "Mo", "Dienstag": "Di", "Mittwoch": "Mi", "Donnerstag": "Do",
    };
    const byRecipe: Record<string, LinePlatingEntry[]> = {};
    for (const [key, recipe] of Object.entries(linePlanSchedule)) {
      if (!recipe) continue;
      // Format: "{PlanDay}|{slotKey}|{lineIdx}"
      const parts = key.split("|");
      if (parts.length !== 3) continue;
      const [dayDE, slotKey, lineIdx] = parts;
      const platDay = DAY_MAP[dayDE ?? ""];
      if (!platDay) continue;
      const duration = SLOT_DURATIONS[slotKey ?? ""] ?? 60;
      const laneCapacity = linePlanCapacityByLane[lineIdx ?? ""];
      const portions = laneCapacity != null
        ? Math.round((Math.max(0, laneCapacity) / 60) * duration)
        : (recipe.speedPerMin ?? 10) * duration;
      const entries = (byRecipe[recipe.code] ??= []);
      const existing = entries.find(e => e.platDay === platDay);
      if (existing) {
        existing.capacityPortions += portions;
        existing.slotCount += 1;
      } else {
        entries.push({ platDay, capacityPortions: portions, slotCount: 1 });
      }
    }

    // Plating-Plan als Fallback: Rezepte die noch keinen Linienplan-Eintrag haben
    // bekommen ihre Plating-Tage aus dem importierten Plating-Plan (CSV-Upload).
    if (platingPlan) {
      const PLAT_DAY_MAP: Record<string, PlannerDay> = {
        "Sunday": "So", "Monday": "Mo", "Tuesday": "Di",
        "Wednesday": "Mi", "Thursday": "Do", "Friday": "Fr", "Saturday": "Sa",
      };
      for (const recipe of platingPlan.recipes) {
        if (byRecipe[recipe.recipeCode]) continue; // Linienplan hat Vorrang
        const entries: LinePlatingEntry[] = [];
        for (const pd of recipe.platingDays) {
          const platDay = PLAT_DAY_MAP[pd.day];
          if (!platDay) continue;
          const existing = entries.find(e => e.platDay === platDay);
          if (existing) {
            existing.capacityPortions += pd.qty;
            existing.slotCount += 1;
          } else {
            entries.push({ platDay, capacityPortions: pd.qty, slotCount: 1 });
          }
        }
        if (entries.length > 0) byRecipe[recipe.recipeCode] = entries;
      }
    }

    return { byRecipe };
  }, [linePlanSchedule, linePlanCapacityByLane, platingPlan]);

  const suggestions = useMemo(() => {
    if (!uiSettings.showAutoSuggestions) return {};
    return suggestAssignments(data, week, scenario, activeShifts, {
      portionMultiplier,
      shiftCapacityMin: DEFAULT_SHIFT_MIN,
      stationDeviceCounts,
      stationPools,
      lineSummary: linePlatingSummary,
    });
  }, [data, week, scenario, activeShifts, portionMultiplier, stationDeviceCounts, stationPools, uiSettings.showAutoSuggestions, linePlatingSummary]);

  // @ts-expect-error unused
  const _weekIntel = planningOasis?.weeks[week] ?? null;
  const shelfRisk = useMemo(() => {
    const seen = new Set<string>();
    const rows: ShelfLifeInfo[] = [];
    for (const row of data.weekRecipes.filter(r => r.hfWeek === week)) {
      const recipe = resolvePlanningRecipe(data, row.code);
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
  const specialDeliveryTotalsByCode = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of specialDeliveries) {
      totals.set(row.recipeCode, (totals.get(row.recipeCode) ?? 0) + row.portions);
    }
    return totals;
  }, [specialDeliveries]);
  const invalidSpecialDeliveries = useMemo(() => {
    return specialDeliveries.filter((row) => {
      const forecast = Math.max(0, Math.round((recipeLookup[row.recipeCode]?.totalVerdenVolume ?? 0) * portionMultiplier));
      const requested = specialDeliveryTotalsByCode.get(row.recipeCode) ?? 0;
      return !recipeLookup[row.recipeCode] || requested > forecast;
    });
  }, [portionMultiplier, recipeLookup, specialDeliveries, specialDeliveryTotalsByCode]);
  const specialDeliveryStatusById = useMemo(() => {
    const out = new Map<string, { state: "offen" | "eingeplant" | "erledigt"; detail: string }>();
    for (const row of specialDeliveries) {
      if (row.manualStatus === "done") {
        out.set(row.id, { state: "erledigt", detail: "Manuell als erledigt markiert" });
        continue;
      }
      const recipeSummary = analysis.recipes.find((item) => item.recipeCode === row.recipeCode);
      const hasMain = !!recipeSummary?.assigned;
      const allSubsPlanned = !!recipeSummary && recipeSummary.subRecipes.every((sub) => !!sub.assigned);
      if (hasMain && allSubsPlanned) {
        out.set(row.id, { state: "eingeplant", detail: "Komplett im Wochenplan abgedeckt" });
      } else {
        out.set(row.id, {
          state: "offen",
          detail: !hasMain
            ? "Hauptrezept noch nicht im Plan"
            : "Sub-Rezepte noch nicht vollstaendig verplant",
        });
      }
    }
    return out;
  }, [analysis.recipes, specialDeliveries]);
  const subRecipeInfo = useMemo(() => {
    if (!subRecipeInfoRequest) return null;
    return getSubRecipeInfo(
      data,
      subRecipeInfoRequest.recipeCode,
      subRecipeInfoRequest.subRecipeId,
      subRecipeInfoRequest.targetPortions,
      infoHints
    );
  }, [data, subRecipeInfoRequest, infoHints]);

  // @ts-expect-error unused
  const _assignmentsBySlot = useMemo(() => {
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
      targetPortions?: number;
      order: number;
      shift: PlannerShift;
      kind: "main" | "sub";
      subCount: number; // für main-tile: Anzahl noch enthaltener Subs
      batchLabel?: string;
      /** Batch-Index 0-basiert (nur bei Split-Rezepten) */
      batchIndex?: number;
      /** Gesamt-Batch-Anzahl dieses Rezepts in der Woche */
      batchTotal?: number;
      /** Lead-Zeit in Küchentagen (nur kind=sub) */
      leadDays?: number;
      /** Bedarfstag des Haupt-Rezepts (= Ausgabe/Fulfillment-Start, kind=sub) */
      mainDay?: PlannerDay;
      category?: string;
    };
    const buckets: Record<string, Tile[]> = {};
    for (const recipe of analysis.recipes) {
      if (recipe.assigned) {
        const mainAssignment = recipe.assigned;
        const remainingSubs = recipe.subRecipes.filter(s => !s.assigned).length;
        const targetPortions = Math.max(0, Math.round(mainAssignment.targetPortions ?? 0));
        const parsedNote = parseBoardNote(mainAssignment.note);
        const splitSpec = extractSplitSpecFromNotes(parsedNote.notes);
        const batches = parseSplitSpecToBatches(splitSpec, mainAssignment.day, targetPortions);
        const allBatches = batches.length > 0
          ? batches
          : [{ day: mainAssignment.day, portions: targetPortions > 0 ? targetPortions : Math.max(1, Math.round(recipe.activeMin)) }];
        const visibleBatches = allBatches;
        // For 2-batch splits: R2 pill should show Ziel-based value (upliftTotal - R1.total)
        if (visibleBatches.length === 2) {
          const wr = recipeLookup[recipe.recipeCode];
          if (wr) {
            const rawVol = wr.verdenVolume ?? { BENL: 0, DKSE: 0, DE: 0 };
            const rs = calculateRunSplit({
              bnl: Math.round((rawVol.BENL ?? 0) * portionMultiplier),
              nordics: Math.round((rawVol.DKSE ?? 0) * portionMultiplier),
              de: Math.round((rawVol.DE ?? 0) * portionMultiplier),
            });
            visibleBatches[1]!.portions = rs.secondRun;
          }
        }
        const totalBatchPortions = Math.max(1, visibleBatches.reduce((sum, batch) => sum + batch.portions, 0));

        visibleBatches.forEach((batch, index) => {
          const slot = slotValue(batch.day, mainAssignment.shift);
          const weight = Math.max(0.15, batch.portions / totalBatchPortions);
          (buckets[slot] ??= []).push({
            key: `${recipe.recipeCode}::batch-${index + 1}-${batch.day}`,
            code: recipe.recipeCode,
            name: recipe.recipeName,
            activeMin: recipe.activeMin > 0 ? Math.max(15, Math.round(recipe.activeMin * weight)) : 0,
            targetPortions: batch.portions,
            order: (mainAssignment.order ?? Number.MAX_SAFE_INTEGER) + index * 0.01,
            shift: mainAssignment.shift,
            kind: "main",
            subCount: remainingSubs,
            batchLabel: visibleBatches.length > 1 ? `R${index + 1}` : undefined,
            batchIndex: visibleBatches.length > 1 ? index : undefined,
            batchTotal: visibleBatches.length > 1 ? visibleBatches.length : undefined
          });
        });
      }
      for (const sub of recipe.subRecipes) {
        if (!sub.assigned) continue;
        const subLeadDays = subLeadDaysBeforeNeed(sub.category, data.processSpecs?.[sub.subRecipeId]);
        (buckets[slotValue(sub.assigned.day, sub.assigned.shift)] ??= []).push({
          key: `${recipe.recipeCode}::${sub.subRecipeId}`,
          code: recipe.recipeCode,
          subRecipeId: sub.subRecipeId,
          name: `${sub.subRecipeName} (${recipe.recipeName})`,
          activeMin: Math.max(15, sub.activeMin),
          targetPortions: sub.assigned.targetPortions,
          order: sub.assigned.order ?? Number.MAX_SAFE_INTEGER,
          shift: sub.assigned.shift,
          kind: "sub",
          subCount: 0,
          leadDays: subLeadDays,
          mainDay: recipe.assigned?.day,
          category: sub.category
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
  }, [analysis.recipes, recipeLookup, portionMultiplier, data.processSpecs]);

  // @ts-expect-error unused
  const _stationsBySlot = useMemo(() => {
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
  const unplanned = analysis.recipes.filter(r => !r.assigned || r.subRecipes.some(s => !s.assigned));
  const visibleStationConflicts = uiSettings.showStationConflicts ? analysis.conflicts : [];
  const visiblePoolConflicts = uiSettings.showPoolConflicts ? analysis.poolConflicts : [];
  const visibleConflictCount = visibleStationConflicts.length + visiblePoolConflicts.length;
  const suggestionCount = Object.keys(suggestions).length;
  const activeShiftSummary = activeShifts.join(" / ");
  const manufacturingDaySummaries = useMemo((): ManufacturingDaySummary[] => {
    const rows = MANUFACTURING_DAYS.map((column) => ({
      column,
      mainCount: 0,
      subRunCount: 0,
      mainPortions: 0,
      subPortions: 0,
      items: [] as string[],
    }));
    const byColumnId = new Map(rows.map((row) => [row.column.id, row]));
    const addMain = (day: PlannerDay, portions: number, label: string) => {
      const column = MANUFACTURING_DAYS.find((item) => item.day === day && item.lane === "regular");
      const row = column ? byColumnId.get(column.id) : undefined;
      if (!row) return;
      row.mainCount += 1;
      row.mainPortions += portions;
      if (row.items.length < 6) row.items.push(label);
    };
    const addSub = (day: PlannerDay, portions: number, label: string, prepSunday: boolean) => {
      const column = MANUFACTURING_DAYS.find((item) => item.day === day && (day === "So" && prepSunday ? item.lane === "prep" : item.lane === "regular"));
      const row = column ? byColumnId.get(column.id) : undefined;
      if (!row) return;
      row.subRunCount += 1;
      row.subPortions += portions;
      if (row.items.length < 6) row.items.push(label);
    };

    for (const recipe of analysis.recipes) {
      const forecast = recipeLookup[recipe.recipeCode]?.totalVerdenVolume ?? 0;
      if (recipe.assigned && activeShifts.includes(recipe.assigned.shift)) {
        addMain(
          recipe.assigned.day,
          Math.max(0, Math.round(recipe.assigned.targetPortions ?? forecast)),
          `${recipe.recipeCode} Main`
        );
      }
      recipe.subRecipes.forEach((sub, subIndex) => {
        if (!sub.assigned || !activeShifts.includes(sub.assigned.shift)) return;
        const spec = data.processSpecs?.[sub.subRecipeId];
        const isPrepSub = isSundayPrepSub(sub.category, spec);
        const splitBatches = recipe.assigned
          ? runSubBatchesForAssignment(recipe.assigned, sub.assigned, forecast, subIndex)
          : [];
        if (splitBatches.length > 0) {
          for (const batch of splitBatches) {
            addSub(
              batch.day,
              batch.portions,
              `${recipe.recipeCode} ${batch.label} ${sub.subRecipeName}`,
              batch.day === "So" || isPrepSub
            );
          }
          return;
        }
        addSub(
          sub.assigned.day,
          Math.max(0, Math.round(sub.assigned.targetPortions ?? forecast)),
          `${recipe.recipeCode} ${sub.subRecipeName}`,
          sub.assigned.day === "So" && isPrepSub
        );
      });
    }
    return rows;
  }, [activeShifts, analysis.recipes, data.processSpecs, recipeLookup]);
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
    draggingCodeRef.current = recipeCode;
    draggingSubIdRef.current = subRecipeId ?? null;
    setDraggingCode(recipeCode);
    setDraggingSubId(subRecipeId ?? null);
  }

  function handleDragEnd() {
    draggingCodeRef.current = null;
    draggingSubIdRef.current = null;
    setDraggingCode(null);
    setDraggingSubId(null);
    setDragOverSlot(null);
    setDragOverUnplanned(false);
  }

  /** Liest Drop-Payload und löst Code+ggf. SubId auf. */
  function parseDropPayload(event: React.DragEvent): { recipe: WeekRecipe; subRecipeId?: string; subRecipeName?: string } | null {
    const raw = event.dataTransfer.getData("text/recipe-code")
      || event.dataTransfer.getData("text/plain")
      || (draggingSubIdRef.current ? `${draggingCodeRef.current}::${draggingSubIdRef.current}` : draggingCodeRef.current ?? "");
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
    if (day === "Sa") {
      setDragOverSlot(null);
      handleDragEnd();
      return;
    }
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

  function handleAutoPlanWeekBoard() {
    setStorage((prev) => {
      const planningShifts = activeShifts.length > 0 ? activeShifts : PLANNER_SHIFTS;
      const isShiftActive = (shift: PlannerShift | undefined): boolean => {
        return !!shift && planningShifts.includes(shift);
      };
      const isPlannerDay = (day: unknown): day is PlannerDay => {
        return typeof day === "string" && (PLANNER_DAYS as readonly string[]).includes(day);
      };
      const safePlannerDay = (day: unknown, fallback: PlannerDay = "Fr"): PlannerDay => {
        return isPlannerDay(day) ? day : fallback;
      };
      const weekState = getWeekState(prev, week);
      const currentScenario = getActiveScenario(prev, week);
      const analysisNow = analyzePlan(data, week, currentScenario, {
        portionMultiplier,
        shiftCapacityMin: DEFAULT_SHIFT_MIN,
        stationDeviceCounts,
        stationPools
      });

      const nextAssignments = { ...currentScenario.assignments };
      const autoTouchedKeys = new Set<string>();
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

      const rebuildSlotState = (assignments: Record<string, typeof nextAssignments[string]>) => {
        slotLoads.clear();
        slotOrders.clear();
        for (const row of Object.values(assignments)) {
          if (!row || !isShiftActive(row.shift)) continue;
          addLoad(row.day, row.shift);
          registerOrder(row.day, row.shift, row.order);
        }
      };

      rebuildSlotState(nextAssignments);

      const recipesByLoad = [...analysisNow.recipes]
        .sort((a, b) => b.totalActiveMin - a.totalActiveMin || a.recipeCode.localeCompare(b.recipeCode));

      for (const recipeSummary of recipesByLoad) {
        const weekRecipe = recipeLookup[recipeSummary.recipeCode]
          ?? data.weekRecipes.find((row) => row.hfWeek === week && row.code === recipeSummary.recipeCode)
          ?? ({ code: recipeSummary.recipeCode } as WeekRecipe);
        const mainKey = assignmentKey(recipeSummary.recipeCode);
        const existingMain = nextAssignments[mainKey] ?? recipeSummary.assigned;
        const keepExistingMain = !!existingMain && existingMain.day !== "Sa" && isShiftActive(existingMain.shift);
        const mainTarget = Math.max(0, Math.round((weekRecipe.totalVerdenVolume ?? 0) * portionMultiplier));
        const rawBatches = resolveMarketFulfillmentBatches(weekRecipe, portionMultiplier, planningRules);
        // Plating-Plan-Override: wenn CSV importiert, hat dieser Vorrang vor markt-basierten Batches
        const overridePlatingDay = platingDayByRecipe[recipeSummary.recipeCode];
        const batches = overridePlatingDay
          ? [{ day: overridePlatingDay, portions: mainTarget }]
          : rawBatches.length === 0
            ? [{ day: "Fr" as PlannerDay, portions: mainTarget }]
            : mainTarget <= planningRules.singleRunMaxPortions && rawBatches.length > 1
              ? [{ day: rawBatches[0]!.day, portions: mainTarget }]
              : normalizeBatches(rawBatches, mainTarget);
        const platingDay = safePlannerDay(batches[0]?.day ?? existingMain?.day ?? "Fr");

        if (!keepExistingMain) {
          const slot = pickLowestLoadSlotForDayWithFallback(slotLoads, platingDay, planningShifts)
            ?? pickLowestLoadSlotWithFallback(slotLoads, planningShifts);
          if (slot) {
            nextAssignments[mainKey] = {
              recipeCode: recipeSummary.recipeCode,
              day: slot.day,
              shift: slot.shift,
              order: nextOrder(slot.day, slot.shift),
              targetPortions: mainTarget,
              note: buildBoardNote("Auto/MainFirst", `split=${serializeBatchesForNote(batches)}`)
            };
            autoTouchedKeys.add(mainKey);
            addLoad(slot.day, slot.shift);
          }
        } else if (existingMain) {
          nextAssignments[mainKey] = {
            ...existingMain,
            targetPortions: mainTarget,
            note: buildBoardNote("Auto/MainFirst", `split=${serializeBatchesForNote(batches)}`)
          };
          autoTouchedKeys.add(mainKey);
        }
      }

      rebuildSlotState(nextAssignments);
      const refreshedAnalysis2 = analyzePlan(data, week, {
        ...currentScenario,
        assignments: nextAssignments
      }, {
        portionMultiplier,
        shiftCapacityMin: DEFAULT_SHIFT_MIN,
        stationDeviceCounts,
        stationPools
      });

      for (const recipeSummary of refreshedAnalysis2.recipes) {
        const mainAssigned = nextAssignments[assignmentKey(recipeSummary.recipeCode)];
        if (!mainAssigned) continue;
        const mainTarget = Math.max(0, Math.round(mainAssigned.targetPortions ?? 0));
        const isFish = isFishRecipe(recipeSummary.recipeCode, planningRules);
        const batchNotes = parseBoardNote(mainAssigned.note);
        const batches = parseSplitSpecToBatches(
          extractSplitSpecFromNotes(batchNotes.notes),
          safePlannerDay(mainAssigned.day),
          mainTarget,
        );
        const needDay = safePlannerDay(
          isFish
            ? (batches[batches.length - 1]?.day ?? mainAssigned.day)
            : (batches[0]?.day ?? mainAssigned.day),
        );

        const subsToAssign = recipeSummary.subRecipes
          .filter((sub) => !sub.assigned || sub.assigned.day === "Sa" || !isShiftActive(sub.assigned.shift))
          .sort((a, b) => b.activeMin - a.activeMin);

        for (const sub of subsToAssign) {
          const spec = data.processSpecs?.[sub.subRecipeId];
          const leadDays = subLeadDaysBeforeNeed(sub.category, spec);
          const preferredSubDay = preferredSubProductionDay(sub.category, spec, needDay, leadDays);
          const slot = pickLowestLoadSlotForDayWithFallback(slotLoads, preferredSubDay, planningShifts)
            ?? pickLowestRegularSubSlotWithFallback(slotLoads, planningShifts)
            ?? pickLowestLoadSlotWithFallback(slotLoads, planningShifts);
          if (!slot) continue;
          const subKey = assignmentKey(recipeSummary.recipeCode, sub.subRecipeId);
          nextAssignments[subKey] = {
            recipeCode: recipeSummary.recipeCode,
            subRecipeId: sub.subRecipeId,
            subRecipeName: sub.subRecipeName,
            day: slot.day,
            shift: slot.shift,
            order: nextOrder(slot.day, slot.shift),
            targetPortions: mainTarget,
            note: buildBoardNote("Auto/SubFromMain", `main=${mainTarget}||split=${serializeBatchesForNote(batches)}`)
          };
          autoTouchedKeys.add(subKey);
          addLoad(slot.day, slot.shift);
        }
      }

      // Sicherheitsnetz: wirklich jedes Rezept muss nach Auto-Plan ein Main-Assignment haben.
      for (const recipeSummary of recipesByLoad) {
        const weekRecipe = recipeLookup[recipeSummary.recipeCode]
          ?? data.weekRecipes.find((row) => row.hfWeek === week && row.code === recipeSummary.recipeCode)
          ?? ({ code: recipeSummary.recipeCode } as WeekRecipe);
        const mainKey = assignmentKey(recipeSummary.recipeCode);
        const currentMain = nextAssignments[mainKey];
        const hasValidMain = !!currentMain
          && isPlannerDay(currentMain.day)
          && isShiftActive(currentMain.shift);
        if (hasValidMain) continue;

        const fallbackTarget = Math.max(0, Math.round((weekRecipe.totalVerdenVolume ?? 0) * portionMultiplier));
        const rawFallbackBatches = resolveMarketFulfillmentBatches(weekRecipe, portionMultiplier, planningRules);
        const fallbackBatches = rawFallbackBatches.length > 0
          ? normalizeBatches(rawFallbackBatches, fallbackTarget)
          : [{ day: "Fr" as PlannerDay, portions: fallbackTarget }];
        const fallbackDay = safePlannerDay(fallbackBatches[0]?.day ?? currentMain?.day ?? "Fr");
        const slot = pickLowestLoadSlotForDayWithFallback(slotLoads, fallbackDay, planningShifts)
          ?? pickLowestLoadSlotWithFallback(slotLoads, planningShifts);
        if (!slot) continue;

        nextAssignments[mainKey] = {
          recipeCode: recipeSummary.recipeCode,
          day: slot.day,
          shift: slot.shift,
          order: nextOrder(slot.day, slot.shift),
          targetPortions: fallbackTarget,
          note: buildBoardNote("Auto/MainSafetyNet", `split=${serializeBatchesForNote(fallbackBatches)}`)
        };
        autoTouchedKeys.add(mainKey);
        addLoad(slot.day, slot.shift);
      }

      // Mo/Di sind echte Produktionstage: nach der Lead-Time-Planung verteilen wir
      // automatisch gesetzte Submeal-Arbeit aus den vollen Folgetagen zurück.
      const loadByAssignmentKey = new Map<string, number>();
      const categoryByAssignmentKey = new Map<string, string>();
      for (const recipeSummary of refreshedAnalysis2.recipes) {
        loadByAssignmentKey.set(assignmentKey(recipeSummary.recipeCode), recipeSummary.activeMin);
        for (const sub of recipeSummary.subRecipes) {
          loadByAssignmentKey.set(assignmentKey(recipeSummary.recipeCode, sub.subRecipeId), sub.activeMin);
          categoryByAssignmentKey.set(assignmentKey(recipeSummary.recipeCode, sub.subRecipeId), sub.category);
        }
      }

      const assignmentCountForDay = (day: PlannerDay): number => {
        return Object.values(nextAssignments)
          .filter((row) => row.day === day && isShiftActive(row.shift))
          .length;
      };

      const dayBalanceTargets: readonly PlannerDay[] = ["Mo", "Di"];
      for (const targetDay of dayBalanceTargets) {
        if (assignmentCountForDay(targetDay) > 0) continue;
        const candidate = [...autoTouchedKeys]
          .map((key) => ({ key, row: nextAssignments[key], activeMin: loadByAssignmentKey.get(key) ?? 0 }))
          .filter((item) => {
            if (!item.row || item.row.day === targetDay || !isShiftActive(item.row.shift)) return false;
            if (!item.row.subRecipeId) return false;
            if (!REGULAR_SUB_DAYS.includes(item.row.day)) return false;
            if (assignmentCountForDay(item.row.day) <= 1) return false;
            return !isSundayPrepSub(categoryByAssignmentKey.get(item.key) ?? "", data.processSpecs?.[item.row.subRecipeId]);
          })
          .sort((a, b) => {
            const sourceLoadDelta = assignmentCountForDay(b.row.day) - assignmentCountForDay(a.row.day);
            return sourceLoadDelta || b.activeMin - a.activeMin || a.key.localeCompare(b.key);
          })[0];

        const slot = pickLowestLoadSlotForDayWithFallback(slotLoads, targetDay, planningShifts);
        if (!candidate || !slot) continue;
        const parsedNote = parseBoardNote(candidate.row.note);
        nextAssignments[candidate.key] = {
          ...candidate.row,
          day: targetDay,
          shift: slot.shift,
          order: nextOrder(targetDay, slot.shift),
          note: buildBoardNote(`Auto/${targetDay}Balance`, parsedNote.notes)
        };
        addLoad(targetDay, slot.shift);
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
  handleAutoPlanWeekBoardRef.current = handleAutoPlanWeekBoard;

  function handleApplyAIChanges(changes: ProposedAssignmentChange[]) {
    setStorage(prev => {
      const weekSt = getWeekState(prev, week);
      const currentScenario = getActiveScenario(prev, week);
      const nextAssignments = { ...currentScenario.assignments };
      for (const change of changes) {
        const key = assignmentKey(change.recipeCode, change.subRecipeId);
        const existing = nextAssignments[key];
        nextAssignments[key] = {
          recipeCode: change.recipeCode,
          subRecipeId: change.subRecipeId,
          subRecipeName: existing?.subRecipeName ?? change.subRecipeId,
          day: change.day,
          shift: change.shift,
          order: existing?.order ?? Object.keys(nextAssignments).length + 1,
          targetPortions: change.targetPortions ?? existing?.targetPortions ?? 0,
          note: buildBoardNote(
            "KI-Assistent",
            change.splitSpec
              ? `${change.reason} split=${change.splitSpec}`.trim()
              : (change.reason ?? ""),
          ),
        };
      }
      const updatedScenario = { ...currentScenario, assignments: nextAssignments };
      return {
        ...prev,
        weeks: {
          ...prev.weeks,
          [week]: {
            ...weekSt,
            scenarios: weekSt.scenarios.map(s => s.id === currentScenario.id ? updatedScenario : s),
          },
        },
      };
    });
  }

  const aiPlanContext = useMemo(() => buildPlanningContext(
    week, data, planningRules, portionMultiplier, analysis.recipes,
  ), [week, data, planningRules, portionMultiplier, analysis.recipes]);

  const aiRecipeLookup = useMemo(() =>
    Object.fromEntries(analysis.recipes.map(r => [r.recipeCode, r.recipeName])),
  [analysis.recipes]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const weekStr = week.includes("-W") ? week.split("-W")[1] : week;

    const handlePayload = (payload: unknown) => {
      const row = payload as { week?: string; requestedAt?: string; reason?: string } | null;
      if (!row || row.week !== week) return;
      const signature = `${row.requestedAt ?? ""}|${row.reason ?? ""}`;
      if (!signature.trim() || lastManufacturingReconcileRequestRef.current === signature) return;
      lastManufacturingReconcileRequestRef.current = signature;
      handleAutoPlanWeekBoardRef.current();
    };

    try {
      const raw = window.localStorage.getItem(`rezeptlogik-manufacturing-reconcile-${week}`);
      if (raw) handlePayload(JSON.parse(raw));
    } catch {
      // Ignore stale local reconcile requests.
    }

    const onRequest = (event: Event) => {
      handlePayload((event as CustomEvent).detail);
    };
    window.addEventListener("rezeptlogik:manufacturing-reconcile-request", onRequest);

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void (async () => {
      try {        const { db } = getFirebase();
        if (cancelled) return;
        unsubscribe = onSnapshot(doc(db, "apps/rezeptlogik/planningRequests", `de_W${weekStr}`), (snapshot) => {
          if (!snapshot.exists()) return;
          handlePayload(snapshot.data());
        });
      } catch {
        // Local event/localStorage keep same-browser reconciliation working.
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("rezeptlogik:manufacturing-reconcile-request", onRequest);
      unsubscribe?.();
    };
  }, [week, activeShifts.length]);

  function openWeekBoardEditor(input: WeekBoardEditorState) {
    const key = assignmentKey(input.recipeCode, input.subRecipeId);
    const existing = scenario.assignments[key];
    const recipe = recipeLookup[input.recipeCode];
    const fallbackTarget = Math.max(0, Math.round((recipe?.totalVerdenVolume ?? 0) * portionMultiplier));
    const parsedNote = parseBoardNote(existing?.note);
    const splitSpec = extractSplitSpecFromNotes(parsedNote.notes);
    setBoardDraft({
      shift: existing?.shift ?? input.shift,
      targetPortions: existing?.targetPortions ?? fallbackTarget,
      reason: parsedNote.reason,
      splitSpec,
      notes: stripSplitSpecFromNotes(parsedNote.notes),
      createSubRecipeWOs: false,
    });
    setBoardEditor(input);
  }

  function saveWeekBoardEditorWith(reasonOverride?: string) {
    if (!boardEditor) return;
    const recipe = recipeLookup[boardEditor.recipeCode];
    if (!recipe) {
      setBoardEditor(null);
      return;
    }
    const targetPortions = Math.max(0, Math.round(boardDraft.targetPortions || 0));
    const splitForNote = boardEditor.subRecipeId ? "" : boardDraft.splitSpec;
    const effectiveReason = reasonOverride ?? boardDraft.reason;
    setStorage((prev) => {
      let state = assignRecipe(prev, week, scenario.id, recipe, {
        day: boardEditor.day,
        shift: boardDraft.shift,
        subRecipeId: boardEditor.subRecipeId,
        subRecipeName: boardEditor.subRecipeName,
        targetPortions,
        note: buildBoardNote(effectiveReason, composeBoardNotes(boardDraft.notes, splitForNote))
      });
      if (boardDraft.createSubRecipeWOs && !boardEditor.subRecipeId) {
        const recipeAnalysis = analysis.recipes.find(r => r.recipeCode === boardEditor.recipeCode);
        const platingDay = boardEditor.day;
        for (const sub of recipeAnalysis?.subRecipes ?? []) {
          if (sub.assigned) continue;
          const spec = data.processSpecs?.[sub.subRecipeId];
          const leadDays = subLeadDaysBeforeNeed(sub.category, spec);
          const subDay = isSundayPrepSub(sub.category, spec)
            ? "So" as PlannerDay
            : preferredSubProductionDay(sub.category, spec, platingDay, leadDays);
          state = assignRecipe(state, week, scenario.id, recipe, {
            day: subDay,
            shift: boardDraft.shift,
            subRecipeId: sub.subRecipeId,
            subRecipeName: sub.subRecipeName,
            targetPortions,
            note: buildBoardNote("Auto/SubFromMain", ""),
          });
        }
      }
      return state;
    });
    setBoardEditor(null);
  }

  function saveWeekBoardEditor() {
    saveWeekBoardEditorWith();
  }

  function clearWeekBoardEditorAssignment() {
    if (!boardEditor) return;
    setStorage((prev) => removeAssignment(prev, week, scenario.id, boardEditor.recipeCode, boardEditor.subRecipeId));
    setBoardEditor(null);
  }

  function addSpecialDelivery() {
    const recipeCode = specialDeliveryDraft.recipeCode.trim().toUpperCase();
    const portions = Math.max(0, Math.round(Number(specialDeliveryDraft.portions) || 0));
    if (!recipeCode || portions <= 0) return;
    setSpecialDeliveries((prev) => ([
      ...prev,
      {
        id: `sd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        recipeCode,
        fulfillmentDay: specialDeliveryDraft.fulfillmentDay,
        portions,
        market: specialDeliveryDraft.market.trim() || undefined,
        note: specialDeliveryDraft.note.trim() || undefined,
      }
    ]));
    setSpecialDeliveryDraft((prev) => ({ ...prev, recipeCode: "", portions: 0, market: "", note: "" }));
  }

  function removeSpecialDelivery(id: string) {
    setSpecialDeliveries((prev) => prev.filter((row) => row.id !== id));
  }

  function setSpecialDeliveryManualStatus(id: string, manualStatus: "open" | "done") {
    setSpecialDeliveries((prev) => prev.map((row) => row.id === id ? { ...row, manualStatus } : row));
  }

  function buildManufacturingSnapshot(syncMode: "live" | "manual"): ManufacturingSnapshotPayload {
    const now = new Date();
    const stamp = now.toLocaleString("de-DE");
    return {
      savedAtIso: now.toISOString(),
      savedAtLabel: stamp,
      week,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      assignments: scenario.assignments,
      stats: {
        plannedCount: analysis.plannedCount,
        unplannedCount: analysis.unplannedCount
      },
      syncMode,
    };
  }

  async function publishManufacturingSnapshot(syncMode: "live" | "manual") {
    if (typeof window === "undefined") return;
    const snapshot = buildManufacturingSnapshot(syncMode);
    window.localStorage.setItem(`rezeptlogik-plan-snapshot-${week}`, JSON.stringify(snapshot));
    window.dispatchEvent(new CustomEvent("rezeptlogik:plan-snapshot-saved", {
      detail: {
        week,
        scenarioId: scenario.id,
        savedAtIso: snapshot.savedAtIso,
      }
    }));
    try {      const { db } = getFirebase();
      const weekStr = week.includes("-W") ? week.split("-W")[1] : week;
      await setDoc(doc(db, "apps/rezeptlogik/manufacturingPlans", `de_W${weekStr}`), snapshot, { merge: true });
    } catch {
      // Local snapshot still keeps the same-tab feedback loop alive when Firestore is unavailable.
    }
    setSavePlanStamp(snapshot.savedAtLabel);
    onPlanSnapshotSaved?.();
  }

  function handleSavePlanSnapshot() {
    void publishManufacturingSnapshot("manual");
  }

  const manufacturingLiveSignature = useMemo(() => JSON.stringify({
    week,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    assignments: scenario.assignments,
    plannedCount: analysis.plannedCount,
    unplannedCount: analysis.unplannedCount,
  }), [analysis.plannedCount, analysis.unplannedCount, scenario.assignments, scenario.id, scenario.name, week]);

  // publishManufacturingSnapshot bewusst NICHT in den Deps: die Signature oben
  // kapselt bereits jeden Wert, den die Funktion liest (week/scenario.*/analysis.*),
  // daher läuft dieser Effect ohnehin bei jeder relevanten Änderung neu und ruft
  // dabei immer die zum selben Render gehörende (aktuelle) Funktion auf. Sie
  // aufzunehmen würde den 650ms-Debounce brechen, da publishManufacturingSnapshot
  // bei jedem Render neu erzeugt wird (kein useCallback).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (lastPublishedManufacturingSignatureRef.current === manufacturingLiveSignature) return;
    const timer = window.setTimeout(() => {
      lastPublishedManufacturingSignatureRef.current = manufacturingLiveSignature;
      void publishManufacturingSnapshot("live");
    }, 650);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manufacturingLiveSignature]);

  function exportDayKitchenPlan(day: PlannerDay) {
    const DAY_LABELS: Record<PlannerDay, string> = { Mo: "Montag", Di: "Dienstag", Mi: "Mittwoch", Do: "Donnerstag", Fr: "Freitag", Sa: "Samstag", So: "Sonntag" };
    const dayLabel = DAY_LABELS[day] ?? day;

    // Recipes with main assignment on this day
    const mainRecipes = analysis.recipes
      .filter(r => r.assigned?.day === day)
      .sort((a, b) => (a.assigned!.order ?? 999) - (b.assigned!.order ?? 999));

    // Sub-recipe assignments on this day (for any recipe)
    const allSubsToday = analysis.recipes.flatMap(r =>
      r.subRecipes
        .filter(s => s.assigned?.day === day)
        .map(s => ({ recipeCode: r.recipeCode, recipeName: r.recipeName, sub: s }))
    );

    // Collect allergens from recipe
    const getAllergens = (code: string): string[] => {
      const recipe = data.recipes?.[code];
      if (!recipe) return [];
      const all = Object.values(recipe.markets)
        .flatMap(m => (m?.allergens ?? "").split(/[,;/]/).map(a => a.trim()).filter(Boolean));
      return [...new Set(all)];
    };

    const allergenSet = new Set<string>();
    mainRecipes.forEach(r => getAllergens(r.recipeCode).forEach(a => allergenSet.add(a)));

    // Build HTML
    let html = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<title>Küchenplan ${dayLabel} – KW ${week}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; margin: 20px; color: #111; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 14px; margin-top: 20px; margin-bottom: 6px; border-bottom: 2px solid #333; padding-bottom: 4px; }
  h3 { font-size: 12px; margin: 12px 0 4px; color: #1a4; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
  th { background: #1e6b3d; color: white; padding: 4px 8px; text-align: left; font-size: 11px; }
  td { border: 1px solid #ccc; padding: 4px 8px; vertical-align: top; }
  .allergen { background: #fff3cd; border: 1px solid #e6ac00; border-radius: 3px; padding: 1px 5px; margin: 1px; display: inline-block; font-size: 10px; font-weight: bold; }
  .alarm { background: #f8d7da; border: 1px solid #c00; border-radius: 3px; padding: 2px 6px; margin: 4px 0; font-weight: bold; font-size: 11px; }
  .sub { font-size: 11px; color: #444; }
  .method { display: inline-block; background: #e8f0fe; border-radius: 3px; padding: 1px 5px; font-size: 10px; margin: 1px; }
  .instruction { font-size: 10px; color: #555; margin-top: 2px; font-style: italic; }
  @media print { body { margin: 10px; } }
</style></head><body>`;

    html += `<h1>Küchenplan: ${dayLabel}, ${week}</h1>`;
    html += `<p style="color:#555;font-size:11px;">Exportiert: ${new Date().toLocaleString("de-DE")}</p>`;

    if (allergenSet.size > 0) {
      html += `<div style="margin:8px 0;padding:8px;background:#fff3cd;border:1px solid #e6ac00;border-radius:4px;">`;
      html += `<strong>Allergene heute:</strong> `;
      allergenSet.forEach(a => { html += `<span class="allergen">${a}</span> `; });
      html += `</div>`;
    }

    // Zeitplan / Main recipes
    html += `<h2>Zeitplan – Hauptrezepte (${mainRecipes.length})</h2>`;
    html += `<table><tr><th>Reihenfolge</th><th>Code</th><th>Rezept</th><th>Schicht</th><th>Portionen</th><th>Allergene</th></tr>`;
    mainRecipes.forEach((r, idx) => {
      const allergens = getAllergens(r.recipeCode);
      const portions = r.assigned?.targetPortions ?? 0;
      html += `<tr>
        <td>${r.assigned?.order ?? (idx + 1)}</td>
        <td><strong>${r.recipeCode}</strong></td>
        <td>${r.recipeName}</td>
        <td>${r.assigned?.shift ?? "-"}</td>
        <td><strong>${fmtNum(Math.round(portions))}</strong></td>
        <td>${allergens.map(a => `<span class="allergen">${a}</span>`).join(" ") || "-"}</td>
      </tr>`;
    });
    html += `</table>`;

    // Allergen-Wechsel-Alarm
    let prevAllergens: string[] = [];
    const alarms: string[] = [];
    mainRecipes.forEach(r => {
      const curAllergens = getAllergens(r.recipeCode);
      const removed = prevAllergens.filter(a => !curAllergens.includes(a));
      const added = curAllergens.filter(a => !prevAllergens.includes(a));
      if (removed.length > 0 && prevAllergens.length > 0) {
        alarms.push(`⚠ Allergen-Wechsel vor ${r.recipeName}: ${removed.join(", ")} entfernt → Linie reinigen!`);
      }
      if (added.length > 0 && prevAllergens.length > 0) {
        alarms.push(`⚠ Neues Allergen bei ${r.recipeName}: ${added.join(", ")} neu eingeführt`);
      }
      prevAllergens = curAllergens;
    });
    if (alarms.length > 0) {
      html += `<h2>Allergen-Alarme</h2>`;
      alarms.forEach(alarm => { html += `<div class="alarm">${alarm}</div>`; });
    }

    // Sub-Rezepte / Produktionsanweisungen
    html += `<h2>Produktionsanweisungen – Sub-Rezepte heute (${allSubsToday.length})</h2>`;
    if (allSubsToday.length === 0) {
      html += `<p style="color:#888">Keine Sub-Rezepte für heute verplant.</p>`;
    } else {
      const grouped = new Map<string, typeof allSubsToday>();
      allSubsToday.forEach(entry => {
        const key = entry.recipeCode;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(entry);
      });
      grouped.forEach((entries, code) => {
        const rName = entries[0]!.recipeName;
        html += `<h3>${code} – ${rName}</h3><table><tr><th>Sub-Rezept</th><th>Methode</th><th>Schicht</th><th>Portionen</th><th>Anweisungen</th></tr>`;
        entries.forEach(({ sub }) => {
          const subDef = (data.recipes?.[code]?.markets?.DE?.subRecipes ?? data.recipes?.[code]?.markets?.BENL?.subRecipes ?? [])
            .find(s => s.id === sub.subRecipeId);
          const instructions = subDef?.instructions ?? "-";
          const methods = sub.category.split(/[/,]/).map(m => `<span class="method">${m.trim()}</span>`).join(" ");
          html += `<tr>
            <td class="sub">${sub.subRecipeName}</td>
            <td>${methods}</td>
            <td>${sub.assigned?.shift ?? "-"}</td>
            <td>${fmtNum(Math.round(sub.assigned?.targetPortions ?? 0))}</td>
            <td class="instruction">${instructions}</td>
          </tr>`;
        });
        html += `</table>`;
      });
    }

    html += `</body></html>`;
    const win = window.open("", "_blank", "width=900,height=800");
    if (win) {
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(() => win.print(), 500);
    }
  }

  return (
    <div className="space-y-3 w-full max-w-none">
      <div className={calendarFullView
        ? "fixed inset-2 z-[120] flex h-[calc(100vh-1rem)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl ring-2 ring-slate-300"
        : "card p-0"
      }>
        <div className="border-b border-slate-200 bg-[linear-gradient(130deg,_rgba(241,245,249,1),_rgba(255,255,255,1)_40%,_rgba(236,253,245,0.65))] px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-[30px] leading-none font-semibold tracking-tight text-slate-900">Manufacturing Planning Calendar</h2>
              <p className="mt-2 text-xs text-slate-500">Wochenboard für Main- und Sub-Rezepte. Klick auf eine Zelle öffnet den Stückzahl-Dialog.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-300">{analysis.plannedCount} geplant</span>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-300">{unplanned.length} offen</span>
              {platingPlan && (
                <span
                  className="rounded-full bg-orange-50 px-3 py-1 text-[11px] font-semibold text-orange-800 ring-1 ring-orange-300"
                  title={`Importiert: ${platingPlan.importedAt}`}
                >
                  Plating-Plan {platingPlan.week} · {platingPlan.recipes.length} Rezepte
                </span>
              )}
              {Object.keys(linePlanRunSplitByRecipe).length > 0 && (
                <span className="rounded-full bg-cyan-50 px-3 py-1 text-[11px] font-semibold text-cyan-800 ring-1 ring-cyan-300">
                  Plating Runs: {Object.keys(linePlanRunSplitByRecipe).length} Meals · Ziel 110%
                </span>
              )}
              <button className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800" onClick={handleAutoPlanWeekBoard}>
                Auto: Meals + Subs
              </button>
              <button
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ring-1 transition-colors ${uiSettings.shiftCount >= 2 ? "bg-violet-700 text-white ring-violet-700" : "bg-white text-slate-700 ring-slate-300 hover:bg-violet-50 hover:ring-violet-300"}`}
                onClick={() => applyShiftPreset(uiSettings.shiftCount >= 2 ? "single-current" : "double-ready")}
                title="Frühschicht + Spätschicht aktivieren — geplant ab nächstem Monat"
              >
                {uiSettings.shiftCount >= 2 ? "2-Schicht ✓" : "2-Schicht"}
              </button>
              <button
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ring-1 transition-colors ${aiPanelOpen ? "bg-indigo-700 text-white ring-indigo-700" : "bg-white text-indigo-700 ring-indigo-300 hover:bg-indigo-50"}`}
                onClick={() => setAiPanelOpen(prev => !prev)}
                title="KI-Planungsassistent öffnen"
              >
                KI-Assistent
              </button>
              <button
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ring-1 ${calendarFullView ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-100"}`}
                onClick={() => setCalendarFullView((prev) => !prev)}
                title="Schaltet den Manufacturing Planning Calendar in die Vollansicht"
              >
                {calendarFullView ? "Vollansicht schließen" : "Vollansicht"}
              </button>
              <button
                className="rounded-md bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-40"
                onClick={handleSavePlanSnapshot}
                disabled={analysis.plannedCount === 0}
                title="Speichert den aktuellen Wochenplan als Snapshot für die Rundmail-Weitergabe"
              >
                Plan sichern
              </button>
              <button
                className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100 disabled:opacity-40"
                onClick={() => {
                  if (analysis.plannedCount === 0) return;
                  if (window.confirm(`Kalender für Szenario '${scenario.name}' wirklich leeren? ${analysis.plannedCount} Zuordnung(en) gehen verloren.`)) {
                    setStorage(prev => resetScenario(prev, week, scenario.id));
                  }
                }}
                disabled={analysis.plannedCount === 0}
              >
                Kalender leeren
              </button>
              {savePlanStamp && (
                <span className="rounded-full bg-sky-50 px-3 py-1 text-[11px] font-semibold text-sky-800 ring-1 ring-sky-300">
                  Plan gesichert: {savePlanStamp}
                </span>
              )}
              {/* Export-Dropdown */}
              <div className="relative">
                <button
                  className="rounded-md bg-verde-600 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 flex items-center gap-1 disabled:opacity-40"
                  disabled={analysis.plannedCount === 0}
                  onClick={() => setExportMenuOpen(prev => !prev)}
                >
                  ↓ Export
                </button>
                {exportMenuOpen && (
                  <div
                    className="absolute right-0 top-full z-50 mt-1 w-44 rounded-md border border-slate-200 bg-white shadow-lg"
                    onMouseLeave={() => setExportMenuOpen(false)}
                  >
                    <button
                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => { setExportMenuOpen(false); exportAsTSV(analysis, data, week, portionMultiplier); }}
                    >
                      📄 TSV (Excel-kompatibel)
                    </button>
                    <button
                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => { setExportMenuOpen(false); exportAsExcel(analysis, data, week, portionMultiplier); }}
                    >
                      📊 Excel (.xls, 3 Tabs)
                    </button>
                    <button
                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                      onClick={() => { setExportMenuOpen(false); exportAsPDF(analysis, data, week, portionMultiplier); }}
                    >
                      🖨 PDF / Drucken
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {visibleConflictCount > 0 && (
          <div className="border-b border-rose-200 bg-rose-50 px-4 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-black tracking-wide text-rose-800">
                Kollisionen direkt bearbeiten: {fmtNum(visibleConflictCount)}
              </div>
              <button
                className="rounded-md bg-rose-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-800"
                onClick={handleAutoPlanWeekBoard}
              >
                Auto: neu abstimmen
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {visibleStationConflicts.slice(0, 4).map((conflict) => (
                <span
                  key={`station-top-${conflict.day}-${conflict.shift}-${conflict.station}`}
                  className="rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-900"
                  title={`${conflict.station}: ${extraDevicesLabel(conflict.deviceCount, conflict.requiredDevices)}`}
                >
                  {conflict.day} · {conflict.shift} · {conflict.station}: {topConflictLabel(conflict)}
                </span>
              ))}
              {visiblePoolConflicts.slice(0, 4).map((conflict) => (
                <span
                  key={`pool-top-${conflict.day}-${conflict.shift}-${conflict.poolName}`}
                  className="rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-900"
                  title={`Pool ${conflict.poolName}: ${extraDevicesLabel(conflict.deviceCount, conflict.requiredDevices)}`}
                >
                  {conflict.day} · {conflict.shift} · Pool {conflict.poolName}: {topPoolConflictLabel(conflict)}
                </span>
              ))}
            </div>
          </div>
        )}

        {rampUpChanges.length > 0 && !rampUpBannerDismissed && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <span className="text-xs font-black text-amber-800">
                  &#9888; Portionszahlen ge&auml;ndert&nbsp;&mdash;&nbsp;
                </span>
                <span className="text-xs text-amber-700">
                  {rampUpChanges.length} {rampUpChanges.length === 1 ? "Rezept" : "Rezepte"} betroffen:
                </span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {rampUpChanges.map(c => (
                    <span key={c.code} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-white px-2.5 py-1 text-[11px]">
                      <span className="font-black text-amber-900">{c.code}</span>
                      <span className="tabular-nums text-slate-500">{fmtNum(c.oldTotal)} → {fmtNum(c.newTotal)}</span>
                      <RampUpDeltaBadge delta={c.delta} />
                    </span>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setRampUpBannerDismissed(true)}
                className="shrink-0 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-amber-200 text-amber-800 text-[10px] font-bold hover:bg-amber-300 transition-colors"
                title="Schlie&szlig;en"
              >&#x2715;</button>
            </div>
          </div>
        )}

        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-black uppercase tracking-wide text-slate-700">Sonderlieferungen / Bestellschein</div>
              <div className="mt-0.5 text-[11px] text-slate-500">Ist bereits im Forecast enthalten, wird hier aber auf einen festen Versandtag gezogen und von der Automatik bevorzugt eingeplant.</div>
            </div>
            <div className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 ring-1 ring-slate-300">
              {specialDeliveries.length} Auftrag{specialDeliveries.length !== 1 ? "e" : ""}
            </div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-[120px_90px_110px_120px_minmax(180px,1fr)_auto]">
            <input
              className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs font-semibold uppercase text-slate-700"
              placeholder="FV4048A"
              value={specialDeliveryDraft.recipeCode}
              onChange={(event) => setSpecialDeliveryDraft((prev) => ({ ...prev, recipeCode: event.target.value.toUpperCase() }))}
            />
            <select
              className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs font-semibold text-slate-700"
              value={specialDeliveryDraft.fulfillmentDay}
              onChange={(event) => setSpecialDeliveryDraft((prev) => ({ ...prev, fulfillmentDay: event.target.value as PlannerDay }))}
            >
              {PLANNER_DAYS.map((day) => <option key={`special-day-${day}`} value={day}>{day}</option>)}
            </select>
            <input
              type="number"
              min={0}
              className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs font-semibold text-slate-700"
              placeholder="Portionen"
              value={specialDeliveryDraft.portions || ""}
              onChange={(event) => setSpecialDeliveryDraft((prev) => ({ ...prev, portions: Math.max(0, Number(event.target.value) || 0) }))}
            />
            <input
              className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs text-slate-700"
              placeholder="Markt z.B. BENL"
              value={specialDeliveryDraft.market}
              onChange={(event) => setSpecialDeliveryDraft((prev) => ({ ...prev, market: event.target.value }))}
            />
            <input
              className="rounded-md border border-slate-300 bg-white px-2 py-2 text-xs text-slate-700"
              placeholder="Notiz / Empfänger / egal"
              value={specialDeliveryDraft.note}
              onChange={(event) => setSpecialDeliveryDraft((prev) => ({ ...prev, note: event.target.value }))}
            />
            <button
              className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
              onClick={addSpecialDelivery}
            >
              Auftrag anlegen
            </button>
          </div>
          {invalidSpecialDeliveries.length > 0 && (
            <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-800">
              Achtung: Mindestens ein Sonderauftrag passt noch nicht sauber zum Forecast dieser KW. Bitte Portionszahl oder Rezeptcode prüfen.
            </div>
          )}
          {specialDeliveries.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Rezept</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-left">Versandtag</th>
                    <th className="px-3 py-2 text-right">Portionen</th>
                    <th className="px-3 py-2 text-left">Markt / Notiz</th>
                    <th className="px-3 py-2 text-right">Forecast</th>
                    <th className="px-3 py-2 text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {specialDeliveries.map((row) => {
                    const forecast = Math.max(0, Math.round((recipeLookup[row.recipeCode]?.totalVerdenVolume ?? 0) * portionMultiplier));
                    const requested = specialDeliveryTotalsByCode.get(row.recipeCode) ?? 0;
                    const invalid = !recipeLookup[row.recipeCode] || requested > forecast;
                    const status = specialDeliveryStatusById.get(row.id) ?? { state: "offen" as const, detail: "Noch nicht eingeplant" };
                    const statusTone = status.state === "erledigt"
                      ? "bg-emerald-100 text-emerald-800"
                      : status.state === "eingeplant"
                        ? "bg-blue-100 text-blue-800"
                        : "bg-amber-100 text-amber-800";
                    return (
                      <tr key={row.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">
                          <div className="font-mono font-semibold text-slate-800">{row.recipeCode}</div>
                          <div className="text-[10px] text-slate-500">{recipeLookup[row.recipeCode]?.recipeName ?? "Rezept nicht gefunden"}</div>
                        </td>
                        <td className="px-3 py-2">
                          <div className={`inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ${statusTone}`}>{status.state}</div>
                          <div className="mt-1 text-[10px] text-slate-500">{status.detail}</div>
                        </td>
                        <td className="px-3 py-2 font-semibold text-slate-700">{row.fulfillmentDay}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{fmtNum(row.portions)}</td>
                        <td className="px-3 py-2 text-slate-600">{[row.market, row.note].filter(Boolean).join(" · ") || "—"}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${invalid ? "font-bold text-rose-700" : "text-slate-600"}`}>{fmtNum(forecast)}</td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex justify-end gap-2">
                            {status.state === "erledigt" ? (
                              <button className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100" onClick={() => setSpecialDeliveryManualStatus(row.id, "open")}>Wieder offen</button>
                            ) : (
                              <button className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100" onClick={() => setSpecialDeliveryManualStatus(row.id, "done")}>Erledigt</button>
                            )}
                            <button className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-100" onClick={() => removeSpecialDelivery(row.id)}>Entfernen</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Offene Rezepte: ziehen in Kalender-Zelle ── */}
        {unplanned.some(r => !r.assigned) && (
          <div
            className={`border-b border-slate-200 px-3 py-2 transition-colors ${dragOverUnplanned ? "bg-amber-50" : "bg-white"}`}
            onDragOver={(e) => {
              if (draggingCodeRef.current) { e.preventDefault(); setDragOverUnplanned(true); }
            }}
            onDragLeave={() => setDragOverUnplanned(false)}
            onDrop={(e) => { handleDropOnUnplanned(e); }}
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                {unplanned.filter(r => !r.assigned).length} offen – hier ablegen zum Entplanen
              </span>
              {dragOverUnplanned && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">⟵ Loslassen zum Entplanen</span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {unplanned.filter(r => !r.assigned).map(recipe => {
                const tone = weekBoardRecipeTone(recipe.recipeCode);
                const wr = recipeLookup[recipe.recipeCode];
                const forecast = wr?.totalVerdenVolume ?? 0;
                const upliftedForecast = Math.round(forecast * portionMultiplier);
                return (
                  <div
                    key={recipe.recipeCode}
                    draggable
                    onDragStart={(e) => handleDragStart(e, recipe.recipeCode)}
                    onDragEnd={handleDragEnd}
                    className="flex cursor-grab items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold select-none active:cursor-grabbing hover:opacity-80 transition-opacity"
                    style={tone.mainPill}
                    title={`${recipe.recipeName} · ${fmtNum(upliftedForecast)} Portionen – in Kalender-Zelle ziehen`}
                  >
                    <span>{recipe.recipeCode}</span>
                    <span style={{ opacity: 0.7 }}>{fmtNum(upliftedForecast)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className={`w-full min-w-0 max-w-full overflow-auto pb-3 pr-2 [scrollbar-gutter:stable] ${calendarFullView ? "flex-1" : ""}`}>
          <table className="w-max min-w-[1540px] border-collapse text-xs">
            <thead>
              <tr className="bg-white border-b border-slate-300">
                <th className="sticky left-0 z-20 bg-white px-3 py-2 text-left font-semibold text-slate-700 min-w-[260px]" rowSpan={2}>Recipes</th>
                <th className="sticky left-[260px] z-20 bg-white px-2 py-2 text-right font-semibold text-slate-700 min-w-[90px]" rowSpan={2}>Forecast / Runs</th>
                <th className="sticky left-[350px] z-20 bg-white px-2 py-2 text-right font-semibold text-slate-700 min-w-[76px]" rowSpan={2}>Mapped</th>
                {MANUFACTURING_DAYS.map((column) => (
                  <th
                    key={column.id}
                    colSpan={activeShifts.length}
                    className={`border-l border-slate-300 px-2 py-2 text-center font-semibold text-slate-700 min-w-[136px] ${column.lane === "regular" ? "cursor-pointer hover:bg-emerald-50 hover:text-emerald-800 select-none" : ""}`}
                    onClick={column.lane === "regular" ? () => setDayDetailModal(column.day) : undefined}
                    title={column.lane === "regular" ? `${column.label} anklicken für Tages-Details & Export` : undefined}
                  >
                    {column.label}{column.lane === "regular" ? " ↓" : ""}
                    {column.lane === "regular" && platingQtyByDay[column.day] != null && (
                      <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded bg-orange-100 text-orange-700 align-middle">
                        {(platingQtyByDay[column.day]! / 1000).toFixed(1)}k
                      </span>
                    )}
                  </th>
                ))}
              </tr>
              <tr className="bg-white border-b border-slate-300">
                {MANUFACTURING_DAYS.flatMap((column) => activeShifts.map((shift) => (
                  <th key={`${column.id}-${shift}`} className="border-l border-slate-200 px-1 py-1 text-center font-medium text-slate-500">
                    {shift === "S1" ? "1st Shift" : shift === "S2" ? "2nd Shift" : "3rd Shift"}
                  </th>
                )))}
              </tr>
            </thead>
            <tbody>
              <tr className="bg-[linear-gradient(90deg,_rgba(226,232,240,0.85),_rgba(241,245,249,0.9))]">
                <td colSpan={4 + MANUFACTURING_DAYS.length * activeShifts.length} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                  {week} (Current) Recipes
                </td>
              </tr>
              {analysis.recipes.map((recipe) => {
                const wr = recipeLookup[recipe.recipeCode];
                const forecast = wr?.totalVerdenVolume ?? 0;
                const upliftedForecast = Math.round(forecast * portionMultiplier);
                const isExpanded = expandedBoardRecipes.has(recipe.recipeCode);
                const mainMapped = recipe.assigned?.targetPortions ?? (recipe.assigned ? forecast : 0);
                const tone = weekBoardRecipeTone(recipe.recipeCode);
                return (
                  <Fragment key={recipe.recipeCode}>
                    <tr key={recipe.recipeCode} className="border-b border-slate-300" style={tone.row}>
                      <td className="sticky left-0 z-10 border-r border-slate-200 px-3 py-2 align-top" style={tone.sticky}>
                        <div className="flex items-start gap-2">
                          <button
                            className="mt-0.5 rounded border border-slate-300 bg-white px-1 text-[10px] leading-4 text-slate-600 hover:bg-slate-100"
                            onClick={() => setExpandedBoardRecipes((prev) => {
                              const next = new Set(prev);
                              if (next.has(recipe.recipeCode)) next.delete(recipe.recipeCode);
                              else next.add(recipe.recipeCode);
                              return next;
                            })}
                          >
                            {isExpanded ? "▾" : "▸"}
                          </button>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1 flex-wrap">
                              <div
                                draggable
                                onDragStart={(e) => handleDragStart(e, recipe.recipeCode)}
                                onDragEnd={handleDragEnd}
                                className="inline-flex cursor-grab items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] select-none active:cursor-grabbing"
                                style={tone.badge}
                                title="Ziehen um Rezept zu verplanen"
                              >
                                ⠿ {recipe.recipeCode}
                                <span style={{ opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>· {fmtNum(upliftedForecast)}</span>
                              </div>
                              <RampUpDeltaBadge delta={rampUpChanges.find(c => c.code === recipe.recipeCode)?.delta ?? 0} />
                            </div>
                            <button className="mt-1 block text-left text-sm font-semibold hover:text-verden-700" style={tone.title} onClick={() => onSelectRecipe?.(recipe.recipeCode)}>{recipe.recipeName}</button>
                            <div className="mt-0.5 text-[10px] text-slate-500">
                              {recipe.subRecipes.length} Sub-Rezepte
                              {!isExpanded && recipe.subRecipes.some(s => !s.assigned) && (
                                <span className="ml-1 font-bold text-amber-500" title="Unverplante Sub-Rezepte">!</span>
                              )}
                            </div>
                            {(() => {
                              const snaps = rampUpHistoryMap.get(recipe.recipeCode) ?? [];
                              const vals = snaps.map(s => s.volumes[recipe.recipeCode] ?? 0);
                              if (vals.length < 1) return null;
                              if (vals.length === 1) return (
                                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3 }}>
                                  <span style={{ fontSize: 9, color: "#94a3b8" }}>Basis</span>
                                  <span style={{ fontSize: 9, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>{fmtNum(vals[0])}</span>
                                </div>
                              );
                              return (
                                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3 }}>
                                  <RampUpSparkline values={vals} width={48} height={14} />
                                  <span style={{ fontSize: 9, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                                    {fmtNum(vals[0])} → {fmtNum(vals[vals.length - 1])}
                                  </span>
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      </td>
                      <td className="sticky left-[260px] z-10 border-r border-slate-200 px-2 py-2 align-top" style={tone.sticky}>
                        {(() => {
                          const rawVol = wr?.verdenVolume ?? { BENL: 0, DKSE: 0, DE: 0 };
                          const upliftedBnl     = Math.round((rawVol.BENL ?? 0) * portionMultiplier);
                          const upliftedNordics  = Math.round((rawVol.DKSE ?? 0) * portionMultiplier);
                          const upliftedDe      = Math.round((rawVol.DE   ?? 0) * portionMultiplier);
                          const rs = calculateRunSplit({ bnl: upliftedBnl, nordics: upliftedNordics, de: upliftedDe });
                          const upliftedTotal = upliftedBnl + upliftedNordics + upliftedDe;
                          const snaps = rampUpHistoryMap.get(recipe.recipeCode) ?? [];
                          return (
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                              {/* Forecast (with uplift) */}
                              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                                <span className="font-semibold tabular-nums text-sm">{fmtNum(upliftedTotal)}</span>
                                {upliftPercent !== 0 && (
                                  <span style={{ fontSize: 9, color: upliftPercent > 0 ? "#16a34a" : "#dc2626", fontWeight: 700 }}>
                                    {upliftPercent > 0 ? "+" : ""}{upliftPercent}%
                                  </span>
                                )}
                              </div>
                              {/* Run 1 / Run 2 */}
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, marginTop: 2, borderTop: "1px solid #e2e8f0", paddingTop: 3 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  <span style={{ fontSize: 9, color: "#64748b", fontWeight: 600 }}>R1</span>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: "#1d4ed8", fontVariantNumeric: "tabular-nums" }}>{fmtNum(rs.firstRun.total)}</span>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                  <span style={{ fontSize: 9, color: "#64748b", fontWeight: 600 }}>R2</span>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", fontVariantNumeric: "tabular-nums" }}>{fmtNum(rs.secondRun)}</span>
                                </div>
                                <div style={{ fontSize: 9, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                                  Ziel {fmtNum(rs.upliftTotal)} (+10%)
                                </div>
                              </div>
                              {/* Ramp-up history */}
                              {snaps.length >= 1 && snaps.slice(-4).reverse().map((snap, idx, arr) => {
                                const isLatest = idx === 0;
                                const isBasis = idx === arr.length - 1 && arr.length === 1;
                                return (
                                  <div key={snap.ts} style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                                    <span style={{ fontSize: 9, color: isLatest ? "#475569" : "#94a3b8", fontVariantNumeric: "tabular-nums", fontWeight: isLatest ? 600 : 400 }}>
                                      {isBasis ? "Basis" : snap.label}
                                    </span>
                                    <span style={{ fontSize: 9, color: isLatest ? "#475569" : "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                                      {fmtNum(snap.volumes[recipe.recipeCode] ?? 0)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="sticky left-[350px] z-10 border-r border-slate-200 px-2 py-2 text-right font-semibold tabular-nums" style={tone.sticky}>{mainMapped > 0 ? fmtNum(mainMapped) : ""}</td>

                      {MANUFACTURING_DAYS.flatMap((column) => activeShifts.map((shift) => {
                        const day = column.day;
                        const slot = slotValue(day, shift);
                        const rows = assignmentsByDayShift[slot] ?? [];
                        const mainTiles = column.lane === "prep"
                          ? []
                          : rows.filter((row) => row.code === recipe.recipeCode && row.kind === "main");
                        // @ts-expect-error unused
                        const _subTiles = rows.filter((row) => row.code === recipe.recipeCode && row.kind === "sub");
                        const hasAny = mainTiles.length > 0;
                        const isDragOverThis = dragOverSlot === slot;
                        const isValidDropTarget = !!draggingCode && !hasAny && day !== "Sa";
                        return (
                          <td
                            key={`${recipe.recipeCode}-${column.id}-${shift}`}
                            className={`border-l border-slate-200 p-1 align-top transition-colors ${isValidDropTarget && !isDragOverThis ? "bg-emerald-50/40" : ""}`}
                            onClick={() => openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift })}
                            onDragOver={(e) => {
                              if (day === "Sa") return;
                              const hasRecipe = !!(e.dataTransfer.getData("text/recipe-code") || e.dataTransfer.getData("text/plain") || draggingCodeRef.current);
                              if (hasRecipe) {
                                e.preventDefault();
                                setDragOverSlot(slot);
                              }
                            }}
                            onDragLeave={() => { if (dragOverSlot === slot) setDragOverSlot(null); }}
                            onDrop={(e) => {
                              const hasRecipe = !!(e.dataTransfer.getData("text/recipe-code") || e.dataTransfer.getData("text/plain") || draggingCodeRef.current);
                              if (!hasRecipe) return;
                              e.preventDefault();
                              handleDropOnSlot(e, day, shift);
                            }}
                          >
                            <div className="min-h-[66px] cursor-pointer rounded border p-1 hover:border-slate-300" style={isDragOverThis ? { ...tone.slotActive, outline: '2px dashed currentColor' } : hasAny ? tone.slotActive : tone.slotIdle} onClick={() => openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift })}>
                              <div className="space-y-1">
                                {mainTiles.map((mainTile) => {
                                  const isSplit = !!mainTile.batchLabel;
                                  const bIdx = mainTile.batchIndex ?? 0;
                                  const bTotal = mainTile.batchTotal ?? 1;
                                  const isFirst = bIdx === 0;
                                  const isLast = bIdx === bTotal - 1;
                                  const pillStyle = isSplit ? (bIdx === 0 ? tone.r1Pill : tone.r2Pill) : tone.mainPill;
                                  // Richtungspfeil: zeigt woher/wohin der Batch geht
                                  const chevronLeft  = !isFirst ? "‹ " : "";
                                  const chevronRight = !isLast  ? " ›" : "";
                                  // Connector-Bar: horizontaler farbiger Streifen über dem Pill
                                  const connBarHue = bIdx === 0 ? tone.hue : (tone.hue + 200) % 360;
                                  const connBar: CSSProperties | null = isSplit ? {
                                    background: isFirst
                                      ? `linear-gradient(90deg, hsl(${connBarHue} 68% 52%) 55%, transparent 100%)`
                                      : isLast
                                        ? `linear-gradient(90deg, transparent 0%, hsl(${connBarHue} 68% 52%) 45%)`
                                        : `hsl(${connBarHue} 68% 52%)`,
                                    opacity: 0.55,
                                  } : null;
                                  const isBeingDragged = draggingCode === recipe.recipeCode;
                                  return (
                                    <div key={mainTile.key} className={`space-y-0.5 transition-opacity ${isBeingDragged ? "opacity-40" : ""}`}>
                                      {connBar && <div className="-mx-1 h-0.5 rounded-full" style={connBar} />}
                                      <button
                                        draggable
                                        onDragStart={(event) => handleDragStart(event, recipe.recipeCode)}
                                        onDragEnd={handleDragEnd}
                                        onClick={(event) => { event.stopPropagation(); openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift }); }}
                                        className="w-full rounded-full px-2 py-0.5 text-left text-[10px] font-bold cursor-grab active:cursor-grabbing"
                                        style={pillStyle}
                                        title={isSplit ? `Batch ${bIdx + 1} von ${bTotal} · ${mainTile.batchLabel}` : "Ziehen um Tag zu ändern"}
                                      >
                                        <span className="opacity-60">{chevronLeft}</span>
                                        {mainTile.batchLabel ? `${mainTile.batchLabel} ` : ""}Plan:{fmtNum(mainTile.targetPortions ?? forecast)} | Min:{fmtMin(mainTile.activeMin)}
                                        <span className="opacity-60">{chevronRight}</span>
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                              {!hasAny && <div className="pt-4 text-center text-[10px] text-slate-200"></div>}
                            </div>
                          </td>
                        );
                      }))}
                    </tr>

                    {isExpanded && [...recipe.subRecipes]
                      .sort((a, b) => {
                        const specA = data.processSpecs?.[a.subRecipeId];
                        const specB = data.processSpecs?.[b.subRecipeId];
                        return subLeadDaysBeforeNeed(b.category, specB) - subLeadDaysBeforeNeed(a.category, specA);
                      })
                      .map((sub) => {
                      const subMapped = sub.assigned?.targetPortions ?? (sub.assigned ? forecast : 0);
                      const subSpec = data.processSpecs?.[sub.subRecipeId];
                      const subLeadDays = subLeadDaysBeforeNeed(sub.category, subSpec);
                      const leadLabel = subLeadDays > 0 ? `D-${subLeadDays}` : null;
                      const leadTooltip = leadLabel && recipe.assigned?.day
                        ? `${sub.category} → ${leadLabel} vor Bedarfstag ${recipe.assigned.day}`
                        : undefined;
                      return (
                        <tr key={`${recipe.recipeCode}-${sub.subRecipeId}`} className="border-b border-slate-200" style={tone.subRow}>
                          <td className="sticky left-0 z-10 border-r border-slate-200 px-3 py-1.5" style={tone.subSticky}>
                            <div className="pl-8">
                              <div className="font-mono text-[10px]" style={tone.code}>{sub.subRecipeId}</div>
                              <div className="text-xs font-semibold" style={tone.title}>{sub.subRecipeName}</div>
                              <div className="text-[10px] text-slate-500">{sub.category}</div>
                            </div>
                          </td>
                          <td className="sticky left-[260px] z-10 border-r border-slate-200 px-2 py-1.5 text-right tabular-nums" style={tone.subSticky}>{fmtNum(forecast)}</td>
                          <td className="sticky left-[350px] z-10 border-r border-slate-200 px-2 py-1.5 text-right tabular-nums" style={tone.subSticky}>{subMapped > 0 ? fmtNum(subMapped) : ""}</td>
                          {MANUFACTURING_DAYS.flatMap((column) => activeShifts.map((shift) => {
                            const day = column.day;
                            const slot = slotValue(day, shift);
                            const isAssigned = sub.assigned?.day === day && sub.assigned?.shift === shift;
                            const isActive = isAssigned;
                            const isDragOverThis = dragOverSlot === slot;
                            return (
                              <td
                                key={`${sub.subRecipeId}-${column.id}-${shift}`}
                                className="border-l border-slate-200 p-1 align-top"
                                onClick={() => openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift, subRecipeId: sub.subRecipeId, subRecipeName: sub.subRecipeName })}
                                onDragOver={(e) => {
                                  if (day === "Sa") return;
                                  const hasRecipe = !!(e.dataTransfer.getData("text/recipe-code") || e.dataTransfer.getData("text/plain") || draggingCodeRef.current);
                                  if (hasRecipe) {
                                    e.preventDefault();
                                    setDragOverSlot(slot);
                                  }
                                }}
                                onDragLeave={() => { if (dragOverSlot === slot) setDragOverSlot(null); }}
                                onDrop={(e) => {
                                  const hasRecipe = !!(e.dataTransfer.getData("text/recipe-code") || e.dataTransfer.getData("text/plain") || draggingCodeRef.current);
                                  if (!hasRecipe) return;
                                  e.preventDefault();
                                  handleDropOnSlot(e, day, shift);
                                }}
                              >
                                <div
                                  className={`min-h-[50px] cursor-pointer rounded border p-1 hover:border-slate-300 transition-opacity ${draggingCode === recipe.recipeCode && isActive ? "opacity-40" : ""}`}
                                  style={isDragOverThis ? { ...tone.slotActive, outline: "2px dashed currentColor" } : isActive ? tone.slotActive : tone.slotIdle}
                                  onClick={() => openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift, subRecipeId: sub.subRecipeId, subRecipeName: sub.subRecipeName })}
                                >
                                  {isAssigned ? (
                                    <div className="flex items-center gap-1">
                                      <button
                                        draggable
                                        onDragStart={(event) => handleDragStart(event, recipe.recipeCode, sub.subRecipeId)}
                                        onDragEnd={handleDragEnd}
                                        onClick={(event) => { event.stopPropagation(); openWeekBoardEditor({ recipeCode: recipe.recipeCode, day, shift, subRecipeId: sub.subRecipeId, subRecipeName: sub.subRecipeName }); }}
                                        className="min-w-0 flex-1 rounded-full px-2 py-0.5 text-left text-[10px] font-bold cursor-grab active:cursor-grabbing"
                                        style={tone.subPill}
                                        title={leadTooltip}
                                      >
                                        {fmtNum(sub.assigned?.targetPortions ?? forecast)}
                                        {leadLabel && <span className="ml-1 rounded-full bg-white/50 px-1 text-[9px] font-bold opacity-80">{leadLabel}</span>}
                                      </button>
                                      <button
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setSubRecipeInfoRequest({
                                            recipeCode: recipe.recipeCode,
                                            recipeName: recipe.recipeName,
                                            subRecipeId: sub.subRecipeId,
                                            subRecipeName: sub.subRecipeName,
                                            day,
                                            shift,
                                            targetPortions: sub.assigned?.targetPortions ?? forecast,
                                            leadDays: subLeadDays,
                                            mainDay: recipe.assigned?.day,
                                            category: sub.category
                                          });
                                        }}
                                        className="h-5 w-5 shrink-0 rounded-full text-[10px] font-bold"
                                        style={tone.infoButton}
                                        title={leadTooltip ?? "Sub-Info"}
                                      >
                                        i
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="pt-3 text-center text-[10px] text-slate-200"></div>
                                  )}
                                </div>
                              </td>
                            );
                          }))}
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-base font-black text-slate-900">Tages-Zusammenrechnung Manufacturing</h3>
              <p className="mt-0.5 text-xs text-slate-500">Summe pro Tag und Schicht aller geplanten Positionen.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-right text-xs sm:grid-cols-3">
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-400">Jobs</div>
                <div className="text-base font-black text-slate-800">{fmtNum(manufacturingDaySummaries.reduce((sum, row) => sum + row.mainCount + row.subRunCount, 0))}</div>
              </div>
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-400">Main Port.</div>
                <div className="text-base font-black text-slate-800">{fmtNum(manufacturingDaySummaries.reduce((sum, row) => sum + row.mainPortions, 0))}</div>
              </div>
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase text-slate-400">Sub Port.</div>
                <div className="text-base font-black text-slate-800">{fmtNum(manufacturingDaySummaries.reduce((sum, row) => sum + row.subPortions, 0))}</div>
              </div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {manufacturingDaySummaries.map((row) => {
              const totalPortions = row.mainPortions + row.subPortions;
              const jobCount = row.mainCount + row.subRunCount;
              const subShare = totalPortions > 0 ? Math.round((row.subPortions / totalPortions) * 100) : 0;
              return (
                <div key={`mfg-summary-${row.column.id}`} className={`rounded-lg border p-3 ${jobCount > 0 ? "border-emerald-200 bg-emerald-50/70" : "border-slate-200 bg-slate-50"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-black text-slate-900">{row.column.label}</div>
                      <div className="text-[10px] font-semibold uppercase text-slate-400">{row.column.lane === "prep" ? "Prep-Fenster R1" : row.column.day === "Sa" ? "frei halten" : "Reguläre Produktion"}</div>
                    </div>
                    <div className={`rounded-full px-2 py-1 text-xs font-black ${jobCount > 0 ? "bg-emerald-700 text-white" : "bg-slate-200 text-slate-500"}`}>{jobCount} Jobs</div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded bg-white/80 px-2 py-1.5 ring-1 ring-slate-200">
                      <div className="text-[10px] font-semibold uppercase text-slate-400">Total</div>
                      <div className="text-sm font-black text-slate-900">{fmtNum(totalPortions)}</div>
                    </div>
                    <div className="rounded bg-white/80 px-2 py-1.5 ring-1 ring-slate-200">
                      <div className="text-[10px] font-semibold uppercase text-slate-400">Main</div>
                      <div className="text-sm font-black text-slate-900">{fmtNum(row.mainPortions)}</div>
                    </div>
                    <div className="rounded bg-white/80 px-2 py-1.5 ring-1 ring-slate-200">
                      <div className="text-[10px] font-semibold uppercase text-slate-400">Sub</div>
                      <div className="text-sm font-black text-slate-900">{fmtNum(row.subPortions)}</div>
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-emerald-600" style={{ width: `${subShare}%` }} />
                  </div>
                  <div className="mt-2 flex justify-between text-[10px] font-semibold text-slate-500">
                    <span>Main-Jobs {fmtNum(row.mainCount)}</span>
                    <span>Sub-Run-Jobs {fmtNum(row.subRunCount)}</span>
                  </div>
                  <div className="mt-3 min-h-[92px] rounded border border-white/70 bg-white/70 px-2 py-2">
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Was wird gemacht</div>
                    <div className="space-y-1 text-[11px] leading-tight text-slate-600">
                      {row.items.length > 0 ? row.items.slice(0, 8).map((item, index) => (
                        <div key={`${row.column.id}-${index}-${item}`} className="truncate" title={item}>
                          <span className="mr-1 font-mono text-[10px] text-slate-400">{index + 1}.</span>{item}
                        </div>
                      )) : <div className="pt-4 text-center italic text-slate-400">{row.column.day === "Sa" ? "frei, nichts einplanen" : "keine Jobs geplant"}</div>}
                      {row.items.length > 8 && <div className="font-semibold text-slate-400">+ {fmtNum(row.items.length - 8)} weitere Jobs</div>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      {boardEditor && (
        <BoardEditorModal
          boardEditor={boardEditor}
          boardDraft={boardDraft}
          setBoardDraft={setBoardDraft}
          onClose={() => setBoardEditor(null)}
          recipeLookup={recipeLookup}
          analysisRecipes={analysis.recipes}
          portionMultiplier={portionMultiplier}
          activeShifts={activeShifts}
          onRemoveAssignment={clearWeekBoardEditorAssignment}
          onSaveUnlocked={() => saveWeekBoardEditorWith("Unlocked")}
          onSave={saveWeekBoardEditor}
        />
      )}

      {dayDetailModal && (
        <DayDetailModal
          day={dayDetailModal}
          week={week}
          data={data}
          analysisRecipes={analysis.recipes}
          onClose={() => setDayDetailModal(null)}
          onExport={exportDayKitchenPlan}
        />
      )}

      {subRecipeInfoRequest && (
        <SubRecipeInfoModal
          request={subRecipeInfoRequest}
          info={subRecipeInfo}
          onClose={() => setSubRecipeInfoRequest(null)}
        />
      )}

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
          <PlannerStat label={tl(locale, "Slots/Woche")} value={fmtNum(MANUFACTURING_DAYS.length * activeShifts.length)} />
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
              <div className="mt-1 text-[11px] font-semibold text-amber-900">
                Bedarf: {fmtNum(conflict.requiredDevices)} Gerät(e) · Zusatzbedarf: {Math.max(0, conflict.requiredDevices - conflict.deviceCount)}
              </div>
              <div className="mt-1 space-y-1 text-xs text-amber-900">
                {conflict.assignments.map((row, index) => {
                  const tone = weekBoardRecipeTone(row.recipeCode);
                  return (
                  <div key={`${row.recipeCode}-${index}`} className="flex items-center justify-between gap-2">
                    <span>
                      <span className="mr-1 inline-flex rounded-full px-1.5 py-0.5 font-mono text-[10px]" style={tone.badge}>{row.recipeCode}</span>
                      <span>{row.recipeName}</span>
                    </span>
                    <span className="font-semibold tabular-nums">{fmtMin(row.minutes)}</span>
                  </div>
                );})}
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
              <div className="mt-1 text-[11px] font-semibold text-rose-900">
                Bedarf: {fmtNum(conflict.requiredDevices)} Gerät(e) · Zusatzbedarf: {Math.max(0, conflict.requiredDevices - conflict.deviceCount)}
              </div>
              <div className="mt-1 space-y-1 text-xs text-rose-900">
                {conflict.assignments.slice(0, 6).map((row, index) => (
                  <div key={`${row.recipeCode}-${row.station}-${index}`} className="flex items-center justify-between gap-2">
                    <span>
                      <span className="mr-1 inline-flex rounded-full px-1.5 py-0.5 font-mono text-[10px]" style={weekBoardRecipeTone(row.recipeCode).badge}>{row.recipeCode}</span>
                      {row.station} · {row.recipeName}
                    </span>
                    <span className="font-semibold tabular-nums">{fmtMin(row.minutes)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Planungsregeln</h3>
            <p className="text-xs text-slate-500 mt-0.5">Markt-Splits, Schicht-Konfiguration und Fisch-Rezepte · wird lokal gespeichert</p>
          </div>
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
            2-Schicht: {uiSettings.shiftCount >= 2 ? "aktiv" : "inaktiv"}
          </span>
        </div>

        <div className="grid gap-5 md:grid-cols-2">

          {/* ── Schicht-Betrieb ─── */}
          <div className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Schicht-Betrieb</div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={uiSettings.shiftCount >= 2}
                onChange={() => applyShiftPreset(uiSettings.shiftCount >= 2 ? "single-current" : "double-ready")}
                className="h-4 w-4 rounded accent-violet-700"
              />
              <span className="text-sm text-slate-700">2-Schicht-Betrieb (Früh + Spät)</span>
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">ab nächstem Monat</span>
            </label>
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-slate-500">
                <span>Run 1 / Frühschicht-Anteil</span>
                <strong className="text-slate-700">{planningRules.firstRunPct}%</strong>
              </div>
              <input
                type="range" min={50} max={90} step={5}
                value={planningRules.firstRunPct}
                onChange={e => setPlanningRules(prev => ({ ...prev, firstRunPct: Number(e.target.value) }))}
                className="w-full accent-violet-700"
              />
              <div className="text-[11px] text-slate-400">Run 2 / Spätschicht: {100 - planningRules.firstRunPct}%</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 whitespace-nowrap">1 Run bis maximal</span>
              <input
                type="number" min={0} max={9999} step={100}
                value={planningRules.singleRunMaxPortions}
                onChange={e => setPlanningRules(prev => ({ ...prev, singleRunMaxPortions: Math.max(0, Number(e.target.value) || 0) }))}
                className="w-24 rounded border border-slate-300 px-2 py-1 text-xs text-right"
              />
              <span className="text-xs text-slate-400">Portionen</span>
            </div>
          </div>

          {/* ── Markt-Fulfillment-Splits ─── */}
          <div className="space-y-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Markt-Fulfillment</div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs text-slate-500">
                <span>BENL</span>
                <span>Do: <strong>{planningRules.benlThuPct}%</strong> · Fr: <strong>{planningRules.benlFriPct}%</strong></span>
              </div>
              <input
                type="range" min={0} max={100} step={5}
                value={planningRules.benlThuPct}
                onChange={e => {
                  const thu = Number(e.target.value);
                  setPlanningRules(prev => ({ ...prev, benlThuPct: thu, benlFriPct: 100 - thu }));
                }}
                className="w-full accent-emerald-600"
              />
              <div className="text-[11px] text-slate-400">Do {planningRules.benlThuPct}% Plating-fertig · Fr {planningRules.benlFriPct}% Plating-fertig</div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-xs text-slate-500">
                <span>Nordics (DK/SE)</span>
                <span>Fr: <strong>{planningRules.nordicsFriPct}%</strong> · Sa: <strong>{planningRules.nordicsSatPct}%</strong></span>
              </div>
              <input
                type="range" min={0} max={100} step={5}
                value={planningRules.nordicsFriPct}
                onChange={e => {
                  const fri = Number(e.target.value);
                  setPlanningRules(prev => ({ ...prev, nordicsFriPct: fri, nordicsSatPct: 100 - fri }));
                }}
                className="w-full accent-sky-600"
              />
              <div className="text-[11px] text-slate-400">Fr {planningRules.nordicsFriPct}% Koch-fertig · Sa {planningRules.nordicsSatPct}% Koch-fertig</div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 whitespace-nowrap">DE: fertig bis</span>
              <select
                value={planningRules.deLatestCookDay}
                onChange={e => setPlanningRules(prev => ({ ...prev, deLatestCookDay: e.target.value as import("./lib/planner").PlannerDay }))}
                className="rounded border border-slate-300 px-2 py-1 text-xs bg-white"
              >
                {(["Mi", "Do", "Fr", "Sa"] as const).map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <span className="text-[11px] text-slate-400">Samstag der Produktionswoche</span>
            </div>
          </div>

          {/* ── Fisch-Rezepte ─── */}
          <div className="space-y-2 md:col-span-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Fisch-Rezepte
              <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700 normal-case">Lead-Time = 0 · so spät wie möglich kochen</span>
            </div>
            <textarea
              value={planningRules.fishRecipeCodes.join("\n")}
              onChange={e => setPlanningRules(prev => ({
                ...prev,
                fishRecipeCodes: e.target.value.split("\n").map(s => s.trim()).filter(Boolean),
              }))}
              placeholder={"Je Zeile ein Rezept-Code, z.B.\nFE1234A\nFV5678B"}
              rows={3}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs font-mono resize-none"
            />
            <div className="text-[11px] text-slate-400">
              {planningRules.fishRecipeCodes.length === 0
                ? "Keine Fisch-Rezepte konfiguriert"
                : `${planningRules.fishRecipeCodes.length} Rezept-Code${planningRules.fishRecipeCodes.length > 1 ? "s" : ""} als Fisch markiert`}
            </div>
          </div>

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
                const tone = weekBoardRecipeTone(recipe.recipeCode);
                return (
                  <tr key={recipe.recipeCode} className="border-b last:border-0" style={selectedRecipe === recipe.recipeCode ? tone.row : tone.subRow}>
                    <td className="py-1.5 pr-2">
                      <span className="inline-flex rounded-full px-1.5 py-0.5 font-mono text-[10px]" style={tone.badge}>{recipe.recipeCode}</span>
                    </td>
                    <td className="py-1.5 pr-2">
                      <button className="text-left hover:text-verden-700" style={tone.title} onClick={() => onSelectRecipe?.(recipe.recipeCode)}>
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
                            <button className="btn" style={tone.subPill} onClick={() => applySuggestion(recipe.recipeCode)}>
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
                        {MANUFACTURING_DAYS.filter((column) => column.lane === "regular").map(column => activeShifts.map(shift => {
                          const value = slotValue(column.day, shift);
                          return <option key={value} value={value}>{column.label} · {shift}</option>;
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

      <PlanningAIPanel
        isOpen={aiPanelOpen}
        onClose={() => setAiPanelOpen(false)}
        planContext={aiPlanContext}
        recipeLookup={aiRecipeLookup}
        onApplyChanges={handleApplyAIChanges}
      />
    </div>
  );
}


