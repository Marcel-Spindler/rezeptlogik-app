import { useEffect, useMemo, useState } from "react";
import { isProducedInVerden } from "./lib/helpers";
import type { DataBundle, GrossIngredient, WeekRecipe, ProcessSpec, CookSchedule, ShelfLifeInfo, WorkOrderEntry } from "./core/types";
import type { UiLocale } from "./lib/i18n";

import { fmtNum, norm, isEachUom, wrIngredientYieldMap } from "./features/kitchen-mode/wrEquipmentFormat";
import {
  BREAKDOWN_OVERRIDE_STORAGE_KEY, MARKET_PRIO_NEW, WANNEN, wrLookupGnType,
} from "./features/kitchen-mode/wrEquipmentTypes";
import type {
  WR_RecipeEntry, WR_IngRow, WR_PathAgg, WR_MealAgg,
  WREntryMode, WRCapacityHint, WRTrayHint, WROverride,
} from "./features/kitchen-mode/wrEquipmentTypes";
import {
  wrToKg, wrCatBadge, wrTubCellCls, wrFmtKg, wrCalcBreakdownPlan, wrFmtRowTotalSize,
  wrFmtRowWoSize, wrResolvePathInstructions, wrResolveWorkOrderForPath, wrStripMarketTag,
  wrSafeFilePart, wrTsvSafe, wrHtmlSafe, wrPathIsBrining, wrPathCookCategories,
  wrPathPrimaryCookingMethod, wrEffectiveCookingMethod,
  wrCookingMethodBadgeClass, wrParseNumberLoose,
  wrExtractPieceWeightKgFromName,
} from "./features/kitchen-mode/wrEquipmentCalc";
import {
  wrBuildHintsFromDumps, wrResolveCapacityHint,
  wrResolveProcessSpecHint, wrResolveKetPlanForPath, wrLookupPieceKg, wrLookupTrayPcs,
} from "./features/kitchen-mode/wrEquipmentHints";
import { equipmentColorScheme, wrScenarioTone } from "./features/kitchen-mode/wrEquipmentTone";

export function BreakdownEquipmentView({
  data,
  week,
  upliftPercent,
  locale: _locale,
  entryMode = "recipe",
}: {
  data: DataBundle;
  week: string;
  upliftPercent: number;
  locale: UiLocale;
  entryMode?: WREntryMode;
}) {
  const [search, setSearch] = useState("");
  const [woSearch, setWoSearch] = useState("");
  const [entries, setEntries] = useState<WR_RecipeEntry[]>([]);
  const [_panelOpen, _setPanelOpen] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, WROverride>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(BREAKDOWN_OVERRIDE_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, WROverride>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const [capacityHints, setCapacityHints] = useState<Map<string, WRCapacityHint>>(new Map());
  const [pieceWeightKg, setPieceWeightKg] = useState<Map<string, number>>(new Map());
  const [trayHints, setTrayHints] = useState<WRTrayHint[]>([]);
  const [pathRawInputs, setPathRawInputs] = useState<Record<string, string>>({});
  const [pathDirectKg, setPathDirectKg] = useState<Record<string, { mode: "fertig" | "roh"; kg: string }>>({});

  // Welche Wannengrößen in den Spalten anzeigen (Default: 40/60/80/120 kg)
  const [activeWannen, setActiveWannen] = useState<Set<number>>(
    () => new Set([40, 60, 80, 120])
  );

  // Welche Ingredient-Zeilen haben die Override-Eingaben offen
  const [expandedOverrides, setExpandedOverrides] = useState<Set<string>>(new Set());

  function toggleOverrideRow(key: string) {
    setExpandedOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Sidebar: welches Meal gerade rechts angezeigt wird
  const [selectedMealKey, setSelectedMealKey] = useState<string | null>(null);
  // Welche Path-Cards aufgeklappt sind (Zutaten-Tabelle sichtbar)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  // Slide-in zum Hinzufügen von Meals
  const [addMealOpen, setAddMealOpen] = useState(false);

  function togglePath(pathKey: string) {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  }

  function toggleWanne(kg: number) {
    setActiveWannen((prev) => {
      const next = new Set(prev);
      if (next.has(kg)) next.delete(kg);
      else next.add(kg);
      return next;
    });
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(BREAKDOWN_OVERRIDE_STORAGE_KEY, JSON.stringify(overrides));
    } catch {
      // ignore quota/private mode issues
    }
  }, [overrides]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [masterRes, biblesRes] = await Promise.all([
          fetch("/data/gsheet-dump-NEW_MASTER_SUPERVISORS_WORKLOAD_PLANNING.json"),
          fetch("/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json"),
        ]);
        if (!masterRes.ok || !biblesRes.ok) return;
        const [masterDump, biblesDump] = await Promise.all([masterRes.json(), biblesRes.json()]);
        if (!active) return;
        const parsed = wrBuildHintsFromDumps(masterDump, biblesDump);
        setCapacityHints(parsed.capacityHints);
        setPieceWeightKg(parsed.pieceWeightKg);
        setTrayHints(parsed.trayHints);
      } catch {
        // optional hints only; calculator still works without these files
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const weekRecipes = useMemo(
    () => data.weekRecipes.filter((r) => r.hfWeek === week && isProducedInVerden(r)),
    [data.weekRecipes, week],
  );

  const workOrderEntries = useMemo<WR_RecipeEntry[]>(() => {
    const rows = data.productionPlan?.rows ?? [];
    const grouped = new Map<string, WorkOrderEntry[]>();
    for (const row of rows) {
      const recipeCode = (row.recipeCode ?? "").trim().toUpperCase();
      const workOrder = (row.workOrder ?? "").trim();
      const kitchenDay = (row.kitchenDay ?? "").trim();
      if (!recipeCode || !workOrder) continue;
      const key = `${kitchenDay}::${recipeCode}::${workOrder}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

    const parseKitchenDay = (value?: string): number => {
      if (!value) return Number.MAX_SAFE_INTEGER;
      const raw = value.trim();
      const dotMatch = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
      if (dotMatch) {
        const day = Number(dotMatch[1]);
        const month = Number(dotMatch[2]);
        let year = Number(dotMatch[3]);
        if (year < 100) year += 2000;
        const ts = new Date(year, month - 1, day).getTime();
        if (Number.isFinite(ts)) return ts;
      }
      const ts = Date.parse(raw);
      return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
    };

    return [...grouped.entries()]
      .map(([key, group]) => {
        const first = group[0];
        const target = group.find((row) => (row.targetPortions ?? 0) > 0)?.targetPortions
          ?? group.find((row) => (row.plannedMeals ?? 0) > 0)?.plannedMeals
          ?? 0;
        return {
          key,
          code: first.recipeCode,
          name: wrStripMarketTag(first.recipeName.replace(/^([A-Z]{2}\d{4}[A-Z0-9]+)\s+-\s+/, "")),
          portions: target > 0 ? target : 500,
          mode: "roh" as const,
          workOrder: first.workOrder,
          kitchenDay: first.kitchenDay,
        };
      })
      .sort((a, b) => {
        const dayCmp = parseKitchenDay(a.kitchenDay) - parseKitchenDay(b.kitchenDay);
        if (dayCmp !== 0) return dayCmp;
        return String(a.workOrder ?? "").localeCompare(String(b.workOrder ?? ""), undefined, { numeric: true });
      });
  }, [data.productionPlan?.rows]);

  // Pre-fill entries with all Verden produced recipes of the selected week by default
  useEffect(() => {
    if (entryMode === "wo") {
      setEntries(workOrderEntries);
      return;
    }
    const uniqueRecipes: WeekRecipe[] = [];
    const seen = new Set<string>();
    for (const r of weekRecipes) {
      if (!seen.has(r.code)) {
        seen.add(r.code);
        uniqueRecipes.push(r);
      }
    }
    setEntries(
      uniqueRecipes.map((wr) => ({
        key: wr.code,
        code: wr.code,
        name: wrStripMarketTag(wr.recipeName),
        portions: wr.totalVerdenVolume > 0 ? wr.totalVerdenVolume : 500,
        mode: "roh",
      }))
    );
  }, [entryMode, weekRecipes, workOrderEntries]);

  const woNeedle = woSearch.trim().toLowerCase();
  const woEntries = useMemo(() => {
    if (entryMode !== "wo") return entries;
    if (!woNeedle) return entries;
    return entries.filter((entry) => {
      const haystack = [
        entry.workOrder ?? "",
        entry.code,
        entry.name,
        entry.kitchenDay ?? "",
      ].join(" ").toLowerCase();
      return haystack.includes(woNeedle);
    });
  }, [entries, entryMode, woNeedle]);

  const selectedCodes = useMemo(() => new Set(entries.map((e) => e.code)), [entries]);

  const needle = search.trim().toLowerCase();
  const suggestions = useMemo(() => {
    const unselected = weekRecipes.filter((r) => !selectedCodes.has(r.code));
    if (!needle) return unselected.slice(0, 12);
    return unselected
      .filter(
        (r) =>
          r.recipeName.toLowerCase().includes(needle) ||
          r.code.toLowerCase().includes(needle) ||
          (r.preference || "").toLowerCase().includes(needle),
      )
      .slice(0, 12);
  }, [needle, weekRecipes, selectedCodes]);

  function addRecipe(wr: WeekRecipe) {
    setEntries((prev) => [
      ...prev,
      {
        key: wr.code,
        code: wr.code,
        name: wrStripMarketTag(wr.recipeName),
        portions: wr.totalVerdenVolume > 0 ? wr.totalVerdenVolume : 500,
        mode: "roh",
      },
    ]);
    setSearch("");
  }

  function removeRecipe(entryKey: string) {
    setEntries((prev) => prev.filter((e) => e.key !== entryKey));
  }

  function patchEntry(entryKey: string, patch: Partial<WR_RecipeEntry>) {
    setEntries((prev) => prev.map((e) => (e.key === entryKey ? { ...e, ...patch } : e)));
  }

  function patchOverride(overrideKey: string, patch: Partial<WROverride>) {
    setOverrides((prev) => {
      const existing = prev[overrideKey] ?? {};
      const next = { ...existing, ...patch };

      const hasQty = typeof next.qty === "number" && Number.isFinite(next.qty) && next.qty >= 0;
      const hasKg = typeof next.kg === "number" && Number.isFinite(next.kg) && next.kg >= 0;
      const hasPcs = typeof next.pcsPerTray === "number" && Number.isFinite(next.pcsPerTray) && next.pcsPerTray > 0;

      if (!hasQty) delete next.qty;
      if (!hasKg) delete next.kg;
      if (!hasPcs) delete next.pcsPerTray;

      if (!next.qty && next.qty !== 0 && !next.kg && next.kg !== 0 && !next.pcsPerTray) {
        if (!prev[overrideKey]) return prev;
        const clone = { ...prev };
        delete clone[overrideKey];
        return clone;
      }

      return { ...prev, [overrideKey]: next };
    });
  }

  function downloadTextFile(fileName: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadBinaryFile(fileName: string, content: ArrayBuffer, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  function rowTrayCount(row: WR_IngRow): number | null {
    if (!row.inferredPcsPerTray || row.inferredPcsPerTray <= 0) return null;
    // EA case: piece count is totalQty directly
    if (row.totalKg == null && isEachUom(row.uom) && row.totalQty > 0) {
      return Math.ceil(row.totalQty / row.inferredPcsPerTray);
    }
    // kg case: piece items measured in g/kg — derive piece count via piece weight
    if (row.totalKg != null && row.totalKg > 0 && row.pieceKgHint != null && row.pieceKgHint > 0) {
      const pieces = row.totalKg / row.pieceKgHint;
      return Math.ceil(pieces / row.inferredPcsPerTray);
    }
    return null;
  }

  function rowTubCountByWanne(row: WR_IngRow, wanneKg: number, briningFactor = 1): number | null {
    if (row.totalKg == null || row.totalKg <= 0) return null;
    return Math.ceil((row.totalKg * briningFactor) / wanneKg);
  }

  function wrFindSubRecipeSpec(subRecipeName: string): { spec?: ProcessSpec; schedule?: CookSchedule } {
    if (!subRecipeName) return {};
    const normalized = norm(subRecipeName);
    for (const spec of Object.values(data.processSpecs ?? {})) {
      if (spec && norm(spec.name) === normalized) return { spec };
    }
    return {};
  }

  function wrFindShelfLife(ingredientName: string): ShelfLifeInfo | undefined {
    if (!ingredientName || !data.shelfLifeBySku) return undefined;
    const normalized = norm(ingredientName);
    for (const info of Object.values(data.shelfLifeBySku)) {
      if (info && (norm(info.skuName) === normalized || norm(info.skuCode) === normalized)) return info;
    }
    return undefined;
  }

  function wrShelfLifeStatus(info?: ShelfLifeInfo): string {
    if (!info) return "";
    const days = info.totalShelfLifeDays ?? 0;
    if (info.skuName && info.skuName.toLowerCase().includes("fisch")) return `Fisch: ${days} Tage`;
    return `${days} Tage`;
  }

  function mealExportRows(meal: WR_MealAgg): Array<Record<string, string | number>> {
    const rows: Array<Record<string, string | number>> = [];
    for (const path of meal.paths) {
      const { spec } = wrFindSubRecipeSpec(path.sub1);
      const breakdownPlan = wrCalcBreakdownPlan(path);
      const matchedWo = wrResolveWorkOrderForPath(data.productionPlan?.rows, meal.code, path.sub1, meal.portionsInput, meal.workOrder);
      const effectiveCookingMethod = wrEffectiveCookingMethod(path, matchedWo);
      for (const row of path.rows) {
        const shelfLife = wrFindShelfLife(row.name);
        const out: Record<string, string | number> = {
          week,
          mealCode: meal.code,
          mealName: meal.name,
          mode: meal.mode,
          portionsInput: meal.portionsInput,
          portionsEffective: Number(meal.portionsEffective.toFixed(2)),
          mealTotalKg: Number(meal.totalKg.toFixed(3)),
          sub1: path.sub1,
          sub2: path.sub2,
          sub3: path.sub3,
          cookingMethod: effectiveCookingMethod,
          cookingPath: path.cookCategories,
          pathTotalKg: Number(path.totalKg.toFixed(3)),
          bibleCapacityKg: path.capacityKgHint ?? "",
          breakdownCount: breakdownPlan.count ?? "",
          woPathSizeKg: breakdownPlan.woSizeKg == null ? "" : Number(breakdownPlan.woSizeKg.toFixed(3)),
          equipmentHint: path.equipmentHint ?? "",
          ingredientId: row.ingredientId,
          ingredientName: row.name,
          category: row.category,
          uom: row.uom,
          woSizeQty: Number((row.totalQty / Math.max(1, breakdownPlan.count ?? 1)).toFixed(3)),
          woSizeKg: row.totalKg == null || !breakdownPlan.count ? "" : Number((row.totalKg / breakdownPlan.count).toFixed(3)),
          totalQty: Number(row.totalQty.toFixed(3)),
          totalKg: row.totalKg == null ? "" : Number(row.totalKg.toFixed(3)),
          pcsPerTray: row.inferredPcsPerTray ?? "",
          trayCount: rowTrayCount(row) ?? "",
          batchSizeKg: spec?.batchSizeKg ?? "",
          batchUom: spec?.batchUom ?? "",
          shelfLifeDays: shelfLife?.totalShelfLifeDays ?? "",
          shelfLifeStatus: wrShelfLifeStatus(shelfLife),
          overrideKey: row.overrideKey,
          overrideQty: overrides[row.overrideKey]?.qty ?? "",
          overrideKg: overrides[row.overrideKey]?.kg ?? "",
          overridePcsPerTray: overrides[row.overrideKey]?.pcsPerTray ?? "",
        };
        for (const w of WANNEN) {
          out[`wannen_${w.label}`] = rowTubCountByWanne(row, w.kg) ?? "";
        }
        rows.push(out);
      }
    }
    return rows;
  }

  async function importMealJson(file: File): Promise<void> {
    try {
      const text = await file.text();
      const payload = JSON.parse(text);

      // Validierung
      if (payload.exportType !== "rezeptlogik-breakdown-meal") {
        throw new Error("Ungültiger Export-Typ");
      }
      if (!payload.meal?.code || !payload.overrides) {
        throw new Error("Ungültige Export-Struktur (Meal oder Overrides fehlen)");
      }

      const mealCode = payload.meal.code;
      const importedOverrides = payload.overrides as Record<string, WROverride>;

      // Woche prüfen (nur Warnung, kein Fehler)
      if (payload.week && payload.week !== week) {
        const msg = `⚠️ Export ist von Woche ${payload.week}, aktuell: ${week}. Trotzdem laden?`;
        if (!window.confirm(msg)) return;
      }

      // Overrides in State übernehmen (nur für das Meal)
      setOverrides((prev) => {
        const next = { ...prev };
        for (const [key, val] of Object.entries(importedOverrides)) {
          next[key] = val;
        }
        return next;
      });

      alert(`✅ ${mealCode} geladen: ${Object.keys(importedOverrides).length} Einstellungen wiederhergestellt`);
    } catch (err) {
      alert(`❌ Fehler beim Importieren: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleImportJsonClick(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        await importMealJson(file);
      }
    };
    input.click();
  }

  function mealExportPayload(meal: WR_MealAgg) {
    const mealOverrides = Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key.startsWith(`${meal.key}::`)),
    );

    return {
      exportType: "rezeptlogik-breakdown-meal",
      exportedAt: new Date().toISOString(),
      week,
      upliftPercent,
      meal: {
        code: meal.code,
        name: meal.name,
        mode: meal.mode,
        portionsInput: meal.portionsInput,
        portionsEffective: meal.portionsEffective,
        totalKg: meal.totalKg,
      },
      settings: {
        wannen: WANNEN,
      },
      overrides: mealOverrides,
      rows: mealExportRows(meal),
      paths: meal.paths.map((path) => {
        const matchedWo = wrResolveWorkOrderForPath(data.productionPlan?.rows, meal.code, path.sub1, meal.portionsInput, meal.workOrder);
        return {
          sub1: path.sub1,
          sub2: path.sub2,
          sub3: path.sub3,
          cookingMethod: wrEffectiveCookingMethod(path, matchedWo),
          cookingPath: path.cookCategories,
          totalKg: path.totalKg,
          capacityKgHint: path.capacityKgHint,
          equipmentHint: path.equipmentHint,
          rows: path.rows.map((row) => ({
            ingredientId: row.ingredientId,
            name: row.name,
            category: row.category,
            uom: row.uom,
            overrideKey: row.overrideKey,
            totalQty: row.totalQty,
            totalKg: row.totalKg,
            pcsPerTray: row.inferredPcsPerTray,
            trayCount: rowTrayCount(row),
            tubsBySize: Object.fromEntries(
              WANNEN.map((w) => [
                w.label,
                rowTubCountByWanne(row, w.kg),
              ]),
            ),
          })),
        };
      }),
    };
  }

  function exportMealJson(meal: WR_MealAgg): void {
    const payload = mealExportPayload(meal);
    const fileName = `breakdown-${week}-${wrSafeFilePart(meal.code)}-${wrSafeFilePart(meal.name)}.json`;
    downloadTextFile(fileName, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  }

  function exportAllMealsJson(): void {
    const payload = {
      exportType: "rezeptlogik-breakdown-all-meals",
      exportedAt: new Date().toISOString(),
      week,
      upliftPercent,
      meals: mealAggs.map((meal) => mealExportPayload(meal)),
    };
    const fileName = `breakdown-${week}-all-meals.json`;
    downloadTextFile(fileName, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
  }

  function exportMealsTsv(meals: WR_MealAgg[], fileName: string): void {
    const tsvHeaders = [
      "Week",
      "Meal Code",
      "Meal Name",
      "Mode",
      "Portions Input",
      "Portions Effective",
      "Meal Total Kg",
      "Sub1",
      "Sub2",
      "Sub3",
      "Cooking Method",
      "Cooking Path",
      "Path Total Kg",
      "Bible Capacity Kg",
      "Breakdown Count",
      "WO Size Path (Kg)",
      "Equipment",
      "Ingredient ID",
      "Ingredient",
      "Category",
      "UOM",
      "WO Size Qty",
      "WO Size Kg",
      "Total Qty",
      "Total Kg",
      "PCS/Tray",
      "Tray Count",
      "Batch Size (Kg)",
      "Shelf Life (Days)",
      "Shelf Life Info",
      ...WANNEN.map((w) => `Wannen ${w.label}`),
      "Override Qty",
      "Override Kg",
      "Override PCS/Tray",
    ];

    const tsvRows: string[] = [];
    for (const meal of meals) {
      for (const row of mealExportRows(meal)) {
        const values = [
          wrTsvSafe(row.week),
          wrTsvSafe(row.mealCode),
          wrTsvSafe(row.mealName),
          wrTsvSafe(row.mode),
          wrTsvSafe(row.portionsInput),
          wrTsvSafe(row.portionsEffective),
          wrTsvSafe(row.mealTotalKg),
          wrTsvSafe(row.sub1),
          wrTsvSafe(row.sub2),
          wrTsvSafe(row.sub3),
          wrTsvSafe(row.cookingMethod),
          wrTsvSafe(row.cookingPath),
          wrTsvSafe(row.pathTotalKg),
          wrTsvSafe(row.bibleCapacityKg),
          wrTsvSafe(row.breakdownCount),
          wrTsvSafe(row.woPathSizeKg),
          wrTsvSafe(row.equipmentHint),
          wrTsvSafe(row.ingredientId),
          wrTsvSafe(row.ingredientName),
          wrTsvSafe(row.category),
          wrTsvSafe(row.uom),
          wrTsvSafe(row.woSizeQty),
          wrTsvSafe(row.woSizeKg),
          wrTsvSafe(row.totalQty),
          wrTsvSafe(row.totalKg),
          wrTsvSafe(row.pcsPerTray),
          wrTsvSafe(row.trayCount),
          wrTsvSafe(row.batchSizeKg),
          wrTsvSafe(row.shelfLifeDays),
          wrTsvSafe(row.shelfLifeStatus),
          ...WANNEN.map((w) => wrTsvSafe(row[`wannen_${w.label}`])),
          wrTsvSafe(row.overrideQty),
          wrTsvSafe(row.overrideKg),
          wrTsvSafe(row.overridePcsPerTray),
        ];
        tsvRows.push(values.join("\t"));
      }
    }

    const tsv = [tsvHeaders.join("\t"), ...tsvRows].join("\n");
    downloadTextFile(fileName, "\uFEFF" + tsv, "text/tab-separated-values;charset=utf-8");
  }

  async function exportMealsExcel(meals: WR_MealAgg[], fileName: string): Promise<void> {
    const exceljs = await import("exceljs");
    const WorkbookClass = exceljs.Workbook || (exceljs as any).default?.Workbook;
    const wb = new WorkbookClass();
    wb.creator = "rezeptlogik-app";
    wb.created = new Date();
    const ws = wb.addWorksheet("Breakdown");

    const headers = [
      "Week",
      "Meal Code",
      "Meal Name",
      "Mode",
      "Portions Input",
      "Portions Effective",
      "Meal Total Kg",
      "Sub1",
      "Sub2",
      "Sub3",
      "Cooking Method",
      "Cooking Path",
      "Path Total Kg",
      "Bible Capacity Kg",
      "Breakdown Count",
      "WO Size Path (Kg)",
      "Equipment",
      "Ingredient ID",
      "Ingredient",
      "Category",
      "UOM",
      "WO Size Qty",
      "WO Size Kg",
      "Total Qty",
      "Total Kg",
      "PCS/Tray",
      "Tray Count",
      "Batch Size (Kg)",
      "Shelf Life (Days)",
      "Shelf Life Info",
      ...WANNEN.map((w) => `Wannen ${w.label}`),
      "Override Qty",
      "Override Kg",
      "Override PCS/Tray",
    ];

    ws.addRow(headers);

    for (const meal of meals) {
      for (const row of mealExportRows(meal)) {
        ws.addRow([
          row.week,
          row.mealCode,
          row.mealName,
          row.mode,
          row.portionsInput,
          row.portionsEffective,
          row.mealTotalKg,
          row.sub1,
          row.sub2,
          row.sub3,
          row.cookingMethod,
          row.cookingPath,
          row.pathTotalKg,
          row.bibleCapacityKg,
          row.breakdownCount,
          row.woPathSizeKg,
          row.equipmentHint,
          row.ingredientId,
          row.ingredientName,
          row.category,
          row.uom,
          row.woSizeQty,
          row.woSizeKg,
          row.totalQty,
          row.totalKg,
          row.pcsPerTray,
          row.trayCount,
          row.batchSizeKg,
          row.shelfLifeDays,
          row.shelfLifeStatus,
          ...WANNEN.map((w) => row[`wannen_${w.label}`]),
          row.overrideQty,
          row.overrideKg,
          row.overridePcsPerTray,
        ]);
      }
    }

    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.columns.forEach((col, idx) => {
      if (idx === 1) col.width = 12;
      else if (idx === 2 || idx === 3) col.width = 18;
      else if (idx >= 8 && idx <= 15) col.width = 16;
      else col.width = 13;
    });

    const buffer = await wb.xlsx.writeBuffer();
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const out = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    downloadBinaryFile(fileName, out, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  function exportMealsPdf(meals: WR_MealAgg[], title: string, printMode: "all" | "per-meal" | "per-sub" = "all"): void {
    // Build sections: one card per Sub-Rezept (path) sorted by meal
    const buildPathSection = (meal: WR_MealAgg, path: WR_PathAgg, pathIdx: number): string => {
      const breakdownPlan = wrCalcBreakdownPlan(path);
      const effectiveTubKg = breakdownPlan.effectiveTubKg;
      const batchCount = breakdownPlan.count;
      const recipe = data.recipes[meal.code];
      const matchedWo = wrResolveWorkOrderForPath(data.productionPlan?.rows, meal.code, path.sub1, meal.portionsInput, meal.workOrder);
      const instructions = recipe ? wrResolvePathInstructions(recipe, path.sub1, path.sub2, path.sub3) : null;

      const crumbs = [path.sub1, path.sub2, path.sub3]
        .filter((s) => s && s !== "—" && s !== "Ohne Sub-Rezept");
      const subTitle = crumbs[crumbs.length - 1] || path.sub1 || "Sub-Rezept";
      const processPath = path.cookCategories || path.equipmentHint || "—";
      const cookingMethod = wrEffectiveCookingMethod(path, matchedWo) || "—";

      const ingRows = path.rows.map((row) => {
        const isFish = wrFindShelfLife(row.name)?.skuName?.toLowerCase().includes("fisch") ?? false;
        const rowBg = isFish ? "background:#fef9c3;" : "";
        const woSizeDisplay = wrFmtRowWoSize(row, batchCount);
        const totalSizeDisplay = wrFmtRowTotalSize(row);
        const lossCell = (row.lossKg != null && row.lossKg > 0)
          ? `<td class="loss-cell">\u2212${row.lossKg.toFixed(2)} kg<br><span class="loss-pct">${Math.round((1 - (row.yieldPct ?? 1)) * 100)}%</span></td>`
          : `<td class="loss-cell" style="color:#cbd5e1">\u2014</td>`;

        return `<tr style="${rowBg}">
          <td><span class="cat-badge cat-${(row.category || "").toLowerCase()}">${row.category || "—"}</span> ${wrTsvSafe(row.name)}<br><span class="id-small">${row.ingredientId !== "-" ? row.ingredientId : ""}</span></td>
          <td style="text-align:right;white-space:nowrap">${woSizeDisplay}</td>
          <td style="text-align:right;white-space:nowrap">${totalSizeDisplay}</td>
          ${lossCell}
        </tr>`;
      }).join("");

      const briningNote = path.isBrining ? `
        <div class="brining-box">
          💧 <strong>Brining 1:1 Wasser</strong>:
          ${path.totalKg.toFixed(2)} kg Rohware + ${path.totalKg.toFixed(2)} kg Wasser
          = <strong>${effectiveTubKg.toFixed(2)} kg</strong> Wannenvolumen
          ${path.capacityKgHint ? `→ <strong>${batchCount} Wannen</strong> à ${path.capacityKgHint} kg` : ""}
        </div>` : "";

      return `
      <section class="recipe-card" style="page-break-before: ${pathIdx > 0 ? "always" : "auto"}">
        <div class="card-header">
          <div class="card-header-left">
            <div class="meal-code">${meal.code}</div>
            <div class="meal-name">${meal.name}</div>
          </div>
          <div class="card-header-right">
            <div class="week-label">KW ${week.replace("2026-", "")}</div>
            <div class="date-label">${new Date().toLocaleDateString("de-DE")}</div>
          </div>
        </div>
        <div class="card-sub-header">
          <h2 class="sub-name">${wrTsvSafe(subTitle)}</h2>
          <div class="meta-row">
            ${matchedWo?.workOrder ? `<div class="meta-item"><span class="meta-label">WO</span><span class="meta-value">${wrTsvSafe(matchedWo.workOrder)}</span></div>` : ""}
            <div class="meta-item"><span class="meta-label">Portionen</span><span class="meta-value">${Math.round(meal.portionsEffective).toLocaleString("de-DE")}</span></div>
            <div class="meta-item"><span class="meta-label">Total (${meal.mode === "fertig" ? "Fertig" : "Roh"})</span><span class="meta-value">${path.totalKg.toFixed(2)} kg</span></div>
            ${path.capacityKgHint ? `<div class="meta-item"><span class="meta-label">Kapazität/Batch</span><span class="meta-value">${path.capacityKgHint} kg</span></div>` : ""}
            ${batchCount ? `<div class="meta-item"><span class="meta-label">Breakdowns</span><span class="meta-value batch-count">${batchCount}</span></div>` : ""}
            ${breakdownPlan.woSizeKg != null ? `<div class="meta-item"><span class="meta-label">WO Size</span><span class="meta-value">${breakdownPlan.woSizeKg.toFixed(2)} kg</span></div>` : ""}
            <div class="meta-item"><span class="meta-label">Cooking Method</span><span class="meta-value">${wrTsvSafe(cookingMethod)}</span></div>
            <div class="meta-item"><span class="meta-label">Prozess</span><span class="meta-value">${wrTsvSafe(processPath)}</span></div>
            ${path.equipmentHint ? `<div class="meta-item"><span class="meta-label">Equipment</span><span class="meta-value">${wrTsvSafe(path.equipmentHint)}</span></div>` : ""}
            ${matchedWo?.kitchenDay ? `<div class="meta-item"><span class="meta-label">Date Needed</span><span class="meta-value">${wrTsvSafe(matchedWo.kitchenDay)}</span></div>` : ""}
            ${matchedWo?.cookMethods ? `<div class="meta-item"><span class="meta-label">Cooking Method (WO)</span><span class="meta-value">${wrTsvSafe(matchedWo.cookMethods)}</span></div>` : ""}
          </div>
          ${crumbs.length > 1 ? `<div class="breadcrumbs">${crumbs.join(" › ")}</div>` : ""}
        </div>
        ${instructions ? `<div class="card-sub-header" style="padding-top:6px"><div class="meta-label">Instructions</div><div class="meta-value" style="font-size:11px;white-space:pre-wrap">${wrHtmlSafe(instructions)}</div></div>` : ""}
        ${briningNote}
        <table class="ing-table">
          <thead>
            <tr>
              <th>Zutat</th>
              <th style="text-align:right">WO Size</th>
              <th style="text-align:right">Total Size</th>
              <th style="text-align:right;color:#d97706">Verlust</th>
            </tr>
          </thead>
          <tbody>${ingRows}</tbody>
          <tfoot>
            <tr class="total-row">
              <td><strong>GESAMT</strong></td>
              <td style="text-align:right"><strong>${breakdownPlan.woSizeKg != null ? `${breakdownPlan.woSizeKg.toFixed(2)} kg` : "—"}</strong></td>
              <td style="text-align:right"><strong>${path.totalKg.toFixed(2)} kg${path.isBrining ? ` + ${path.totalKg.toFixed(2)} kg H₂O` : ""}</strong></td>
              <td style="text-align:right">
                ${path.totalLossKg > 0
                  ? `<strong style="color:#d97706">\u2212${path.totalLossKg.toFixed(2)} kg</strong><br><span style="font-size:9px;color:#92400e">${Math.round((path.totalLossKg / path.totalKg) * 100)}% Verlust</span>`
                  : `<span style="color:#cbd5e1">\u2014</span>`
                }
              </td>
            </tr>
          </tfoot>
        </table>
      </section>`;
    };

    const sections: string[] = [];
    for (const meal of meals) {
      for (let pi = 0; pi < meal.paths.length; pi++) {
        sections.push(buildPathSection(meal, meal.paths[pi], printMode === "all" ? sections.length : pi));
      }
    }

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${wrTsvSafe(title)}</title>
<style>
  * { box-sizing: border-box; }
  @page { size: A4 portrait; margin: 12mm 10mm; }
  body { font-family: 'Arial', sans-serif; font-size: 11px; color: #0f172a; margin: 0; }
  .recipe-card { margin-bottom: 16px; border: 1.5px solid #1e293b; border-radius: 6px; overflow: hidden; }
  .card-header { background: #1e293b; color: white; display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; }
  .meal-code { font-size: 9px; font-family: monospace; color: #94a3b8; letter-spacing: 0.08em; }
  .meal-name { font-size: 13px; font-weight: 900; line-height: 1.2; }
  .card-header-right { text-align: right; }
  .week-label { font-size: 13px; font-weight: bold; color: #f1f5f9; }
  .date-label { font-size: 9px; color: #94a3b8; }
  .card-sub-header { padding: 8px 12px 6px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
  .sub-name { font-size: 15px; font-weight: 900; margin: 0 0 6px 0; color: #0f172a; }
  .meta-row { display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .meta-item { display: flex; flex-direction: column; }
  .meta-label { font-size: 7px; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; font-weight: bold; }
  .meta-value { font-size: 12px; font-weight: 700; color: #0f172a; }
  .batch-count { font-size: 18px; font-weight: 900; color: #1d4ed8; }
  .breadcrumbs { font-size: 9px; color: #64748b; margin-top: 4px; }
  .brining-box { background: #eff6ff; border: 1px solid #93c5fd; padding: 6px 10px; font-size: 10px; color: #1e40af; margin: 0; }
  .ing-table { width: 100%; border-collapse: collapse; font-size: 10px; }
  .ing-table th, .ing-table td { border: 1px solid #e2e8f0; padding: 4px 6px; vertical-align: top; }
  .ing-table th { background: #f1f5f9; font-weight: bold; font-size: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  .ing-table .total-row td { background: #f8fafc; border-top: 2px solid #334155; }
  .tub-cell { font-weight: 700; }
  .loss-cell { text-align: right; font-size: 10px; color: #d97706; font-weight: 700; white-space: nowrap; }
  .loss-pct { font-size: 8px; color: #92400e; font-weight: normal; }
  .cat-badge { display: inline-block; font-size: 7px; font-weight: 900; padding: 1px 4px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.05em; }
  .cat-pro { background: #fef3c7; color: #92400e; }
  .cat-spi { background: #fee2e2; color: #991b1b; }
  .cat-phf { background: #dbeafe; color: #1e40af; }
  .cat-dry { background: #dcfce7; color: #166534; }
  .id-small { font-family: monospace; font-size: 8px; color: #94a3b8; }
  @media print { .recipe-card { page-break-inside: avoid; } }
</style>
</head>
<body>
  ${sections.join("\n")}
</body>
</html>`;

    // Popup ohne noopener öffnen, damit wir document.write + print() aufrufen können
    const win = window.open("about:blank", "_blank");
    if (!win) {
      // Fallback: als HTML-Datei herunterladen
      downloadTextFile(
        `breakdown-${week}-print.html`,
        html,
        "text/html;charset=utf-8"
      );
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    setTimeout(() => {
      win.focus();
      win.print();
    }, 250);
  }

  function exportMealSettings(meal: WR_MealAgg): void {
    exportMealJson(meal);
  }

  function exportMealGsheet(meal: WR_MealAgg): void {
    const fileName = `breakdown-${week}-${wrSafeFilePart(meal.code)}-${wrSafeFilePart(meal.name)}.tsv`;
    exportMealsTsv([meal], fileName);
  }

  async function exportMealExcel(meal: WR_MealAgg): Promise<void> {
    const fileName = `breakdown-${week}-${wrSafeFilePart(meal.code)}-${wrSafeFilePart(meal.name)}.xlsx`;
    await exportMealsExcel([meal], fileName);
  }

  function exportMealPdf(meal: WR_MealAgg): void {
    exportMealsPdf([meal], `Breakdown ${week} ${meal.code} ${meal.name}`);
  }

  function exportAllMealsSettings(): void {
    exportAllMealsJson();
  }

  function exportAllMealsGsheet(): void {
    const fileName = `breakdown-${week}-all-meals.tsv`;
    exportMealsTsv(mealAggs, fileName);
  }

  async function exportAllMealsExcel(): Promise<void> {
    const fileName = `breakdown-${week}-all-meals.xlsx`;
    await exportMealsExcel(mealAggs, fileName);
  }

  function exportAllMealsPdf(): void {
    exportMealsPdf(mealAggs, `Breakdown ${week} Alle Meals`);
  }

  const mealAggs = useMemo<WR_MealAgg[]>(() => {
    const result: WR_MealAgg[] = [];

    for (const entry of entries) {
      const recipe = data.recipes[entry.code];
      if (!recipe) continue;

      const portionsEffective =
        entry.mode === "fertig"
          ? entry.portions * (1 + upliftPercent / 100)
          : entry.portions;

      let grossList: GrossIngredient[] | undefined;
      for (const mkt of MARKET_PRIO_NEW) {
        const list = recipe.grossIngredients?.[mkt];
        if (list && list.length > 0) {
          grossList = list;
          break;
        }
      }
      if (!grossList) {
        result.push({
          key: entry.key,
          code: entry.code,
          name: wrStripMarketTag(entry.name),
          mode: entry.mode,
          workOrder: entry.workOrder,
          kitchenDay: entry.kitchenDay,
          portionsInput: entry.portions,
          portionsEffective,
          paths: [],
          totalKg: 0,
          totalLossKg: 0,
        });
        continue;
      }

      // Yield-Karte für dieses Rezept (ingredientId → yieldPct)
      const yieldMap = wrIngredientYieldMap(data.structures?.[entry.code]);

      const pathMap = new Map<string, Map<string, WR_IngRow>>();
      for (const item of grossList) {
        const sub1 = item.subRecipe1?.trim() || "Ohne Sub-Rezept";
        const sub2 = item.subRecipe2?.trim() || "—";
        const sub3 = item.subRecipe3?.trim() || "—";
        const pathKey = `${sub1}||${sub2}||${sub3}`;
        if (!pathMap.has(pathKey)) pathMap.set(pathKey, new Map());

        const ingMap = pathMap.get(pathKey)!;
        const ingKey = `${item.ingredientId || item.ingredient}||${item.uom}`;
        const overrideKey = `${entry.key}::${pathKey}::${ingKey}`;
        const addQ = (item.grossQuantityPerPortion || 0) * portionsEffective;
        const baseKg = wrToKg(addQ, item.uom);
        // Piece weight for EA items (to derive kg)
        const pieceKg = baseKg == null && isEachUom(item.uom)
          ? wrLookupPieceKg(pieceWeightKg, item.ingredient || "", item.ingredientId || "")
          : null;
        // Tray hint for ALL items (proteins may be in g/kg UOM, not EA)
        const trayPcsHint = wrLookupTrayPcs(trayHints, item.ingredient || "", item.ingredientId || "");
        const gnTypeHint = wrLookupGnType(trayHints, item.ingredient || "", item.ingredientId || "");
        // Piece weight for kg-based piece items (needed to compute piece count → GN tray count)
        const gnPieceKg = baseKg != null && trayPcsHint != null
          ? (wrLookupPieceKg(pieceWeightKg, item.ingredient || "", item.ingredientId || "")
             ?? wrExtractPieceWeightKgFromName(item.ingredient || ""))
          : null;
        const addK = baseKg ?? (pieceKg != null ? addQ * pieceKg : null);
        const prev = ingMap.get(ingKey);
        if (prev) {
          prev.totalQty += addQ;
          if (prev.totalKg !== null && addK !== null) prev.totalKg += addK;
          else if (addK === null) prev.totalKg = null;
          // lossKg neu berechnen (yieldPct bleibt konstant)
          if (prev.yieldPct != null && prev.totalKg != null && prev.yieldPct < 1) {
            prev.lossKg = prev.totalKg * (1 - prev.yieldPct);
          }
        } else {
          const ingYield = yieldMap.get(item.ingredientId || "") ?? null;
          const ingLossKg = (addK != null && ingYield != null && ingYield < 1)
            ? addK * (1 - ingYield) : null;
          ingMap.set(ingKey, {
            ingredientId: item.ingredientId || "-",
            name: item.ingredient || "-",
            category: item.ingredientCategory || "—",
            uom: item.uom,
            overrideKey,
            totalQty: addQ,
            totalKg: addK,
            pieceKgHint: pieceKg ?? gnPieceKg,
            inferredPcsPerTray: trayPcsHint,
            inferredGnType: gnTypeHint,
            yieldPct: ingYield,
            lossKg: ingLossKg,
          });
        }
      }

      const paths: WR_PathAgg[] = [];
      for (const [pathKey, ingMap] of pathMap) {
        const [sub1, sub2, sub3] = pathKey.split("||");
        const rows = Array.from(ingMap.values()).map((row) => {
          const ov = overrides[row.overrideKey];
          const qty = ov?.qty != null && ov.qty >= 0 ? ov.qty : row.totalQty;

          let kg = row.totalKg;
          if (ov?.qty != null && ov.qty >= 0) {
            const fromUom = wrToKg(qty, row.uom);
            if (fromUom != null) kg = fromUom;
            else if (row.pieceKgHint != null) kg = qty * row.pieceKgHint;
          }
          if (ov?.kg != null && ov.kg >= 0) kg = ov.kg;

          const yieldPct = row.yieldPct;
          const lossKg = (kg != null && yieldPct != null && yieldPct < 1)
            ? kg * (1 - yieldPct) : null;
          return {
            ...row,
            totalQty: qty,
            totalKg: kg,
            lossKg,
            inferredPcsPerTray: ov?.pcsPerTray != null && ov.pcsPerTray > 0
              ? ov.pcsPerTray
              : row.inferredPcsPerTray,
          };
        }).sort(
          (a, b) => (b.totalKg ?? 0) - (a.totalKg ?? 0),
        );
        const totalKg = rows.reduce((sum, row) => sum + (row.totalKg ?? 0), 0);
        const totalLossKg = rows.reduce((sum, row) => sum + (row.lossKg ?? 0), 0);
        const hint = wrResolveCapacityHint(capacityHints, sub1, sub2, sub3);
        const processSpecHint = wrResolveProcessSpecHint(data.processSpecs, sub1, sub2, sub3);
        paths.push({
          sub1,
          sub2,
          sub3,
          rows,
          totalKg,
          totalLossKg,
          capacityKgHint: hint?.capacityKg ?? processSpecHint.batchSizeKg ?? null,
          equipmentHint: hint?.equipment ?? processSpecHint.equipment ?? null,
          isBrining: wrPathIsBrining(recipe, sub1, sub2, sub3),
          cookingMethod: wrPathPrimaryCookingMethod(recipe, sub1, sub2, sub3),
          cookCategories: wrPathCookCategories(recipe, sub1, sub2, sub3),
        });
      }

      paths.sort((a, b) => b.totalKg - a.totalKg);
      const totalKg = paths.reduce((sum, p) => sum + p.totalKg, 0);
      const totalLossKg = paths.reduce((sum, p) => sum + p.totalLossKg, 0);
      result.push({
        key: entry.key,
        code: entry.code,
        name: wrStripMarketTag(entry.name),
        mode: entry.mode,
        workOrder: entry.workOrder,
        kitchenDay: entry.kitchenDay,
        portionsInput: entry.portions,
        portionsEffective,
        paths,
        totalKg,
        totalLossKg,
      });
    }

    return result.sort((a, b) => b.totalKg - a.totalKg);
  }, [entries, data.recipes, data.structures, data.processSpecs, upliftPercent, capacityHints, pieceWeightKg, trayHints, overrides]);

  const totalKgAll = mealAggs.reduce((sum, meal) => sum + meal.totalKg, 0);
  const totalPathCount = mealAggs.reduce((sum, meal) => sum + meal.paths.length, 0);

  // Auto-select erstes Meal wenn mealAggs sich ändert
  useEffect(() => {
    if (mealAggs.length > 0 && (selectedMealKey === null || !mealAggs.find((m) => m.key === selectedMealKey))) {
      setSelectedMealKey(mealAggs[0].key);
    }
  }, [mealAggs, selectedMealKey]);

  const selectedMeal = mealAggs.find((m) => m.key === selectedMealKey) ?? null;

  const ketBatchLookup = useMemo(() => {
    const out = new Map<string, { kitchenKg: number; batchSizeKg: number; batches: number }>();
    const totals = new Map<string, number>();

    const processBatchSizeBySub = new Map<string, number>();
    for (const spec of Object.values(data.processSpecs ?? {})) {
      if (!spec?.name || !spec.batchSizeKg || spec.batchSizeKg <= 0) continue;
      const key = norm(spec.name);
      if (!key || processBatchSizeBySub.has(key)) continue;
      processBatchSizeBySub.set(key, spec.batchSizeKg);
    }

    const bibleBatchSizeBySub = new Map<string, number>();
    for (const hint of capacityHints.values()) {
      if (!hint?.subRecipeName || !hint.capacityKg || hint.capacityKg <= 0) continue;
      const key = norm(hint.subRecipeName);
      if (!key || bibleBatchSizeBySub.has(key)) continue;
      bibleBatchSizeBySub.set(key, hint.capacityKg);
    }

    const rows = data.productionPlan?.rows ?? [];
    for (const row of rows) {
      const recipeCode = (row.recipeCode ?? "").trim().toUpperCase();
      const subKey = norm(row.subRecipe);
      if (!recipeCode || !subKey) continue;
      if (!Number.isFinite(row.kitchenKg) || row.kitchenKg <= 0) continue;
      const key = `${recipeCode}::${subKey}`;
      totals.set(key, (totals.get(key) ?? 0) + row.kitchenKg);
    }

    for (const [key, kitchenKg] of totals.entries()) {
      const [, subKey = ""] = key.split("::");
      const batchSizeKg = processBatchSizeBySub.get(subKey) ?? bibleBatchSizeBySub.get(subKey) ?? 0;
      if (!batchSizeKg || batchSizeKg <= 0) continue;
      out.set(key, {
        kitchenKg,
        batchSizeKg,
        batches: Math.max(1, Math.ceil(kitchenKg / batchSizeKg)),
      });
    }

    return out;
  }, [data.processSpecs, data.productionPlan?.rows, capacityHints]);

  const noIngredientData = !data.structures || Object.keys(data.structures).length === 0;

  return (
    // Escape the Shell's px-4 py-4 padding so the sidebar goes edge-to-edge
    <div className="-mx-4 -mt-4 flex flex-col overflow-hidden bg-slate-100 h-[calc(100vh-64px)]">
      {noIngredientData && (
        <div className="shrink-0 mx-4 mt-2 p-3 bg-amber-50 border border-amber-300 rounded-lg text-amber-900 flex items-center gap-2 text-sm shadow z-50">
          <span>⚠</span>
          <span><strong>Zutaten-Daten fehlen</strong> — bitte <code className="bg-amber-100 px-1 rounded">npm run import:local</code> ausführen und Seite neu laden.</span>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">

      {/* ═══════════════════════════════════════════════════════════════════
          LEFT SIDEBAR — Meal-Navigation
      ════════════════════════════════════════════════════════════════════ */}
      <aside className="relative flex w-[300px] shrink-0 flex-col h-full border-r border-slate-200 bg-white shadow-xl z-10">

        {/* Sidebar-Header */}
        <div className="px-4 py-3.5 bg-gradient-to-br from-slate-900 to-slate-800 border-b border-slate-700/50">
          <div className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">{entryMode === "wo" ? "WO Ausdruck" : "Breakdown Rechner"}</div>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="text-xl font-black text-white tabular-nums">{wrFmtKg(totalKgAll)}</span>
            <span className="text-xs text-slate-400">{mealAggs.length} {entryMode === "wo" ? "WOs" : "Meals"} · {totalPathCount} Pfade</span>
          </div>
        </div>

        {/* Meal-Liste */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {entryMode === "wo" && entries.length > 0 && (
            <div className="px-1 pb-1">
              <input
                type="search"
                value={woSearch}
                onChange={(e) => setWoSearch(e.target.value)}
                placeholder="WO, Code oder Name suchen"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:bg-white focus:outline-none"
              />
            </div>
          )}
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="text-3xl mb-3">📋</div>
              <p className="text-xs font-semibold text-slate-500">Noch kein {entryMode === "wo" ? "Work Order" : "Meal"} ausgewählt</p>
              <p className="text-[10px] text-slate-400 mt-1">{entryMode === "wo" ? "KET-Plan importieren oder Woche wechseln" : "Klicke \"+ Mahlzeit\" um zu starten"}</p>
            </div>
          ) : entryMode === "wo" && woEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="text-3xl mb-3">🔎</div>
              <p className="text-xs font-semibold text-slate-500">Keine WO gefunden</p>
              <p className="text-[10px] text-slate-400 mt-1">Filter anpassen</p>
            </div>
          ) : entryMode === "wo" ? (
            woEntries.map((entry) => {
              const meal = mealAggs.find((m) => m.key === entry.key);
              const isSelected = selectedMealKey === entry.key;
              return (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => setSelectedMealKey(entry.key)}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition-all ${
                    isSelected
                      ? "border-indigo-300 bg-indigo-50 ring-1 ring-indigo-200 shadow-sm"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">WO {entry.workOrder ?? "-"}</div>
                    <div className="text-[10px] font-mono text-slate-400">{entry.code}</div>
                  </div>
                  <div className={`mt-1 text-xs font-bold leading-snug ${isSelected ? "text-indigo-900" : "text-slate-800"}`}>{entry.name}</div>
                  <div className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-500 tabular-nums flex-wrap">
                    {entry.kitchenDay && <span>{entry.kitchenDay}</span>}
                    {meal && (
                      <>
                        <span>·</span>
                        <span>{wrFmtKg(meal.totalKg)}</span>
                        <span>·</span>
                        <span>{meal.paths.length} Pfade</span>
                      </>
                    )}
                  </div>
                </button>
              );
            })
          ) : (
            entries.map((entry) => {
              const meal = mealAggs.find((m) => m.key === entry.key);
              const isSelected = selectedMealKey === entry.key;
              const effective = entry.mode === "fertig"
                ? Math.round(entry.portions * (1 + upliftPercent / 100))
                : entry.portions;
              return (
                <div
                  key={entry.key}
                  onClick={() => setSelectedMealKey(entry.key)}
                  className={`relative rounded-xl border cursor-pointer transition-all select-none ${
                    isSelected
                      ? "border-indigo-300 bg-indigo-50 ring-1 ring-indigo-200 shadow-sm"
                      : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
                  }`}
                >
                  {/* Aktiv-Indikator-Balken */}
                  {isSelected && (
                    <div className="absolute left-0 inset-y-0 w-1 rounded-l-xl bg-indigo-500" />
                  )}
                  <div className="px-3 py-2.5 pl-4">
                    {/* Zeile 1: Code + Name + Remove */}
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0 flex-1">
                        <div className="text-[9px] font-mono text-slate-400 leading-none">{entry.code}</div>
                        {entry.workOrder && <div className="text-[9px] font-black uppercase tracking-widest text-slate-500 mt-0.5">WO {entry.workOrder}</div>}
                        <div className={`text-sm font-bold leading-snug mt-0.5 break-words ${isSelected ? "text-indigo-900" : "text-slate-800"}`}>
                          {entry.name}
                        </div>
                        {entry.kitchenDay && <div className="text-[10px] text-slate-400 mt-0.5">{entry.kitchenDay}</div>}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeRecipe(entry.key); }}
                        className="text-slate-300 hover:text-rose-400 text-xl leading-none shrink-0 transition-colors mt-0.5 ml-1"
                      >×</button>
                    </div>

                    {/* KG + Modus-Badges */}
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                      {meal && (
                        <span className={`text-xs font-black tabular-nums px-2 py-0.5 rounded-lg ${isSelected ? "bg-indigo-100 text-indigo-800" : "bg-slate-100 text-slate-700"}`}>
                          {wrFmtKg(meal.totalKg)}
                        </span>
                      )}
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md uppercase tracking-wide ${
                        entry.mode === "fertig" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-700"
                      }`}>
                        {entry.mode === "fertig" ? "Fertig" : "Roh"}
                      </span>
                      {effective !== entry.portions && (
                        <span className="text-[9px] text-slate-400 tabular-nums">eff. {effective.toLocaleString("de-DE")}</span>
                      )}
                    </div>

                    {/* Portionen-Controls */}
                    <div className="mt-2.5" onClick={(e) => e.stopPropagation()}>
                      <div className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">Portionen</div>
                      {/* Preset-Chips */}
                      <div className="flex gap-1 mb-2 flex-wrap">
                        {[100, 200, 500, 1000, 2000].map((preset) => (
                          <button
                            key={preset}
                            onClick={() => patchEntry(entry.key, { portions: preset })}
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-md border transition-all ${
                              entry.portions === preset
                                ? "bg-indigo-600 text-white border-indigo-600"
                                : "bg-white text-slate-500 border-slate-200 hover:border-indigo-300 hover:text-indigo-600"
                            }`}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                      {/* +/- Stepper */}
                      <div className="flex items-center rounded-lg ring-1 ring-slate-200 overflow-hidden w-full">
                        <button
                          onClick={() => patchEntry(entry.key, { portions: Math.max(0, entry.portions - 100) })}
                          className="px-2.5 py-1.5 text-slate-500 hover:bg-slate-100 text-sm font-bold transition-colors shrink-0 border-r border-slate-200"
                        >−</button>
                        <input
                          type="number"
                          min={0}
                          step={100}
                          value={entry.portions}
                          onChange={(e) => patchEntry(entry.key, { portions: Math.max(0, Number(e.target.value)) })}
                          aria-label={`Portions for ${entry.name}`}
                          title="Portions"
                          className="flex-1 text-center text-sm font-semibold tabular-nums bg-white py-1.5 focus:outline-none focus:ring-inset focus:ring-1 focus:ring-indigo-300 min-w-0 w-full"
                        />
                        <button
                          onClick={() => patchEntry(entry.key, { portions: entry.portions + 100 })}
                          className="px-2.5 py-1.5 text-slate-500 hover:bg-slate-100 text-sm font-bold transition-colors shrink-0 border-l border-slate-200"
                        >+</button>
                      </div>
                      {/* Modus-Toggle */}
                      <div className="flex mt-1.5 rounded-lg ring-1 ring-slate-200 overflow-hidden text-xs">
                        <button
                          onClick={() => patchEntry(entry.key, { mode: "fertig" })}
                          className={`flex-1 py-1 transition-colors ${entry.mode === "fertig" ? "bg-indigo-600 text-white font-semibold" : "bg-white text-slate-500 hover:bg-slate-50"}`}
                        >Fertigware</button>
                        <button
                          onClick={() => patchEntry(entry.key, { mode: "roh" })}
                          className={`flex-1 py-1 border-l border-slate-200 transition-colors ${entry.mode === "roh" ? "bg-indigo-600 text-white font-semibold" : "bg-white text-slate-500 hover:bg-slate-50"}`}
                        >Rohware</button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* "+ Mahlzeit hinzufügen"-Button */}
        {entryMode !== "wo" && (
          <div className="px-3 pt-2 pb-1 border-t border-slate-100">
            <button
              onClick={() => setAddMealOpen(true)}
              className="w-full rounded-xl bg-indigo-600 text-white text-sm font-bold py-2.5 hover:bg-indigo-700 active:bg-indigo-800 transition-colors flex items-center justify-center gap-2"
            >
              <span className="text-base leading-none">+</span>
              Mahlzeit hinzufügen
            </button>
          </div>
        )}

        {/* Export-Strip */}
        <div className="px-3 py-2.5 flex gap-1.5 flex-wrap">
          {entryMode === "wo" ? (
            <>
              <button
                onClick={() => selectedMeal && exportMealPdf(selectedMeal)}
                disabled={!selectedMeal}
                className="text-[10px] bg-indigo-100 hover:bg-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed text-indigo-700 px-2 py-1 rounded-lg border border-indigo-200 transition-colors font-medium"
              >
                PDF ausgewählte WO
              </button>
              <button onClick={exportAllMealsPdf} className="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded-lg transition-colors font-medium">PDF alle WOs</button>
              <button onClick={() => selectedMeal && exportMealGsheet(selectedMeal)} disabled={!selectedMeal} className="text-[10px] bg-slate-100 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed text-slate-600 px-2 py-1 rounded-lg transition-colors font-medium">GSheet WO</button>
              <button onClick={() => { if (selectedMeal) void exportMealExcel(selectedMeal); }} disabled={!selectedMeal} className="text-[10px] bg-slate-100 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed text-slate-600 px-2 py-1 rounded-lg transition-colors font-medium">Excel WO</button>
            </>
          ) : (
            <>
              <button onClick={exportAllMealsSettings} className="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded-lg transition-colors font-medium">JSON</button>
              <button onClick={() => { void exportAllMealsExcel(); }} className="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded-lg transition-colors font-medium">Excel</button>
              <button onClick={exportAllMealsGsheet} className="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded-lg transition-colors font-medium">GSheet</button>
              <button onClick={exportAllMealsPdf} className="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-2 py-1 rounded-lg transition-colors font-medium">PDF alle</button>
              <button onClick={handleImportJsonClick} className="text-[10px] bg-emerald-100 hover:bg-emerald-200 text-emerald-700 px-2 py-1 rounded-lg border border-emerald-200 transition-colors font-medium">↑ Import</button>
            </>
          )}
        </div>
      </aside>

      {/* ═══════════════════════════════════════════════════════════════════
          RIGHT CONTENT — Meal-Detail
      ════════════════════════════════════════════════════════════════════ */}
      <main className="flex-1 overflow-y-auto min-w-0 relative">
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-center p-8">
            <div>
              <div className="text-5xl mb-4">👈</div>
              <p className="text-sm font-semibold text-slate-600">{entryMode === "wo" ? "Work Order aus der linken Liste wählen" : "Meal aus der linken Leiste wählen"}</p>
              <p className="text-xs text-slate-400 mt-1">{entryMode === "wo" ? "oder KET-Plan/Woche prüfen" : "oder \"+ Mahlzeit hinzufügen\" klicken"}</p>
            </div>
          </div>
        ) : !selectedMeal ? (
          <div className="flex items-center justify-center h-full text-center p-8">
            <div>
              <div className="text-4xl mb-3">🔍</div>
              <p className="text-sm font-semibold text-slate-600">Keine Zutaten-Daten gefunden</p>
              <p className="text-xs text-slate-400 mt-1">Die ausgewählten Rezepte haben für diese Woche keine Einträge.</p>
            </div>
          </div>
        ) : (
          <div>
            {/* ── Meal-Header (sticky) ── */}
            <div className="sticky top-0 z-10 px-6 py-4 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 flex flex-wrap items-start gap-4 justify-between shadow-lg">
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-mono text-slate-400 tracking-widest">{selectedMeal.code}</div>
                {entryMode === "wo" && selectedMeal.workOrder && (
                  <div className="text-[10px] font-black uppercase tracking-widest text-indigo-300 mt-0.5">WO {selectedMeal.workOrder}{selectedMeal.kitchenDay ? ` · ${selectedMeal.kitchenDay}` : ""}</div>
                )}
                <div className="text-xl font-black text-white leading-tight break-words">{selectedMeal.name}</div>
                <div className="text-xs text-slate-400 mt-1 tabular-nums">
                  {selectedMeal.mode === "fertig" ? "Fertigware" : "Rohware"}
                  <span className="mx-1.5 text-slate-600">·</span>
                  Input: <span className="text-slate-300">{selectedMeal.portionsInput.toLocaleString("de-DE")}</span>
                  <span className="mx-1.5 text-slate-600">·</span>
                  Eff.: <span className="text-slate-300">{Math.round(selectedMeal.portionsEffective).toLocaleString("de-DE")}</span> Port.
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <div className="text-2xl font-black text-white tabular-nums">{wrFmtKg(selectedMeal.totalKg)}</div>
                {selectedMeal.totalLossKg > 0 && (
                  <div className="text-sm font-bold text-amber-400 tabular-nums">
                    −{wrFmtKg(selectedMeal.totalLossKg)} ({Math.round((selectedMeal.totalLossKg / selectedMeal.totalKg) * 100)}% Verlust)
                  </div>
                )}
                <div className="flex items-center gap-1 mt-0.5 flex-wrap justify-end">
                  <button onClick={() => exportMealSettings(selectedMeal)} className="text-[9px] bg-white/10 hover:bg-white/20 text-white px-1.5 py-0.5 rounded transition-colors">JSON</button>
                  <button onClick={() => { void exportMealExcel(selectedMeal); }} className="text-[9px] bg-white/10 hover:bg-white/20 text-white px-1.5 py-0.5 rounded transition-colors">Excel</button>
                  <button onClick={() => exportMealGsheet(selectedMeal)} className="text-[9px] bg-white/10 hover:bg-white/20 text-white px-1.5 py-0.5 rounded transition-colors">GSheet</button>
                  <button onClick={() => exportMealPdf(selectedMeal)} className="text-[9px] bg-white/10 hover:bg-white/20 text-white px-1.5 py-0.5 rounded transition-colors">PDF</button>
                </div>
              </div>
            </div>

            {/* ── Wannen-Selector (sticky unter Header) ── */}
            <div className="sticky top-[88px] z-10 px-5 py-2.5 bg-white border-b border-slate-200 flex items-center gap-2 flex-wrap shadow-sm">
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mr-1">Container:</span>
              {WANNEN.map((w) => {
                const active = activeWannen.has(w.kg);
                return (
                  <button
                    key={w.kg}
                    onClick={() => toggleWanne(w.kg)}
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg ring-1 transition-all ${
                      active
                        ? "bg-indigo-600 text-white ring-indigo-600 shadow-sm"
                        : "bg-white text-slate-400 ring-slate-200 hover:ring-indigo-300 hover:text-indigo-600"
                    }`}
                  >
                    {w.label}
                  </button>
                );
              })}
            </div>

            {/* ── Path-Cards ── */}
            {selectedMeal.paths.length === 0 ? (
              <div className="px-6 py-10 text-sm text-slate-400 italic text-center">Keine Zutaten-Daten gefunden.</div>
            ) : (
              <div className="p-4 space-y-3">
                {selectedMeal.paths.map((path, idx) => {
                  const visibleWannen = WANNEN.filter((w) => activeWannen.has(w.kg));
                  const breakdownPlan = wrCalcBreakdownPlan(path);
                  const briningFactor = breakdownPlan.briningFactor;
                  const bibleKg = breakdownPlan.capacityKg;
                  const ketPlan = wrResolveKetPlanForPath(ketBatchLookup, selectedMeal.code, path.sub1);
                  const effectiveTubKg = breakdownPlan.effectiveTubKg;
                  const batchCount = breakdownPlan.count;
                  const woPathSizeKg = breakdownPlan.woSizeKg;
                  const recipe = data.recipes[selectedMeal.code];
                  const matchedWo = wrResolveWorkOrderForPath(data.productionPlan?.rows, selectedMeal.code, path.sub1, selectedMeal.portionsInput, selectedMeal.workOrder);
                  const effectiveCookingMethod = wrEffectiveCookingMethod(path, matchedWo);
                  const cookingBadgeCls = wrCookingMethodBadgeClass(effectiveCookingMethod);
                  const pathInstructions = recipe ? wrResolvePathInstructions(recipe, path.sub1, path.sub2, path.sub3) : null;
                  const crumbs = [path.sub1, path.sub2, path.sub3]
                    .filter((s) => s && s !== "—" && s !== "Ohne Sub-Rezept")
                    .filter(Boolean);
                  const pathKey = `${selectedMeal.key}-path-${idx}`;
                  const rawStr = pathRawInputs[pathKey] ?? "";
                  const rawKg = rawStr !== "" ? (wrParseNumberLoose(rawStr) ?? null) : null;
                  const rawCoverage = rawKg != null && path.totalKg > 0 ? rawKg / path.totalKg : null;
                  const rawPortions = rawCoverage != null ? Math.floor(selectedMeal.portionsEffective * rawCoverage) : null;
                  const pathYieldFactor = path.totalKg > 0 ? (path.totalKg - path.totalLossKg) / path.totalKg : 1;
                  const rawNetKg = rawKg != null ? rawKg * pathYieldFactor : null;
                  const rawCoveragePct = rawCoverage != null ? Math.round(rawCoverage * 100) : null;
                  const pathNetKg = Math.max(0, path.totalKg - path.totalLossKg);

                  // Direkte kg-Eingabe für Equipment-Berechnung
                  const directEntry = pathDirectKg[pathKey];
                  const directMode = directEntry?.mode ?? "fertig";
                  const directKgStr = directEntry?.kg ?? "";
                  const directKgInput = directKgStr !== "" ? (wrParseNumberLoose(directKgStr) ?? null) : null;
                  // Rohware → Fertigware via Yield; Fertigware direkt
                  const directFertigKg = directKgInput != null
                    ? (directMode === "roh" ? directKgInput * pathYieldFactor : directKgInput)
                    : null;
                  const directBatchCount = directFertigKg != null && bibleKg && bibleKg > 0
                    ? Math.ceil(directFertigKg * briningFactor / bibleKg)
                    : null;
                  const directWannenSums = directFertigKg != null
                    ? visibleWannen.map(w => ({ label: w.label, kg: w.kg, total: Math.ceil(directFertigKg * briningFactor / w.kg) })).filter(ws => ws.total > 0)
                    : [];
                  const pathLossPct = path.totalKg > 0 ? Math.round((path.totalLossKg / path.totalKg) * 100) : 0;
                  const scenarioTone = wrScenarioTone(rawCoverage);
                  const eq = path.equipmentHint;
                  const colors = equipmentColorScheme(eq);
                  const isExpanded = expandedPaths.has(pathKey);

                  return (
                    <div key={pathKey} className={`rounded-2xl border overflow-hidden shadow-sm ${colors.border}`}>

                      {/* Equipment-Header */}
                      <div className={`border-l-[6px] ${colors.border} ${colors.headerBg}`}>
                        <div className="px-5 py-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              {/* Equipment-Icon + Name */}
                              <div className="flex items-center gap-2.5 mb-3 flex-wrap">
                                <span className="text-2xl leading-none">{colors.icon}</span>
                                <div>
                                  <div className={`text-xs font-black uppercase tracking-widest ${colors.text}`}>
                                    {eq ?? "Equipment unbekannt"}
                                  </div>
                                  {effectiveCookingMethod && (
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                      <span className="text-[10px] text-slate-500 font-semibold">Cooking Method:</span>
                                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ring-1 ${cookingBadgeCls}`}>
                                        {effectiveCookingMethod}
                                      </span>
                                    </div>
                                  )}
                                  {path.cookCategories && (
                                    <div className="text-[10px] text-slate-500 font-semibold">{path.cookCategories}</div>
                                  )}
                                </div>
                                {path.isBrining && (
                                  <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-sky-700 ring-1 ring-sky-200">
                                    💧 Brining 1:1
                                  </span>
                                )}
                                <div className="flex items-center gap-1.5 ml-auto">
                                  {matchedWo?.workOrder && (
                                    <span className="rounded-md px-2 py-1 text-[9px] font-black uppercase tracking-widest bg-white/80 text-slate-700 ring-1 ring-white/80">
                                      WO {matchedWo.workOrder}
                                    </span>
                                  )}
                                  <span className={`rounded-md px-2 py-1 text-[9px] font-black uppercase tracking-widest ${scenarioTone.badge} ring-1`}>
                                    {scenarioTone.label}
                                  </span>
                                  <span className={`rounded-md px-2 py-1 text-[9px] font-black uppercase tracking-widest ${colors.badge}`}>
                                    Pfad {idx + 1}
                                  </span>
                                </div>
                              </div>

                              {/* Breadcrumb */}
                              <div className="flex items-center gap-1.5 flex-wrap text-[12px] mb-3">
                                {crumbs.length === 0 ? (
                                  <span className="text-slate-500 italic text-xs">Ohne Sub-Rezept</span>
                                ) : crumbs.map((crumb, ci) => (
                                  <span key={ci} className="flex items-center gap-1.5">
                                    {ci > 0 && <span className="text-slate-300 font-bold">›</span>}
                                    <span className={`font-semibold ${ci === crumbs.length - 1 ? "text-slate-900 bg-white px-2 py-0.5 rounded-md ring-1 ring-slate-200 shadow-sm" : "text-slate-500"}`}>
                                      {crumb}
                                    </span>
                                  </span>
                                ))}
                              </div>

                              {/* Equipment-Pills */}
                              <div className="flex flex-wrap items-center gap-1.5">
                                {eq && eq.split(",").map((e, ei) => (
                                  <span key={ei} className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${colors.badge}`}>
                                    {e.trim()}
                                  </span>
                                ))}
                              </div>
                            </div>

                            {/* Rechts: KG + Batch + PDF */}
                            <div className="shrink-0 text-right flex flex-col gap-1 items-end">
                              <div className="text-2xl font-black tabular-nums text-slate-900">{wrFmtKg(path.totalKg)}</div>
                              {bibleKg && (
                                <div className="text-xs font-semibold text-slate-500 tabular-nums">
                                  {batchCount}× à {bibleKg} kg
                                </div>
                              )}
                              {woPathSizeKg != null && (
                                <div className="text-[11px] font-semibold text-slate-500 tabular-nums">
                                  WO Size: {wrFmtKg(woPathSizeKg)}
                                </div>
                              )}
                              {ketPlan && (
                                <div className="text-xs font-semibold text-sky-600 tabular-nums">
                                  KET: {ketPlan.batches}× à {wrFmtKg(ketPlan.batchSizeKg)} kg
                                </div>
                              )}
                              {path.totalLossKg > 0 && (
                                <div className="text-xs font-bold text-amber-600 tabular-nums">
                                  −{wrFmtKg(path.totalLossKg)} ({pathLossPct}%)
                                </div>
                              )}
                              <button
                                onClick={() => exportMealsPdf([{ ...selectedMeal, paths: [path] }], `${selectedMeal.code} · ${crumbs[crumbs.length - 1] ?? path.sub1}`)}
                                title="Sub-Pfad drucken"
                                className={`mt-1 rounded-lg px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors ${colors.badge} hover:opacity-80`}
                              >
                                PDF
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Brining-Banner */}
                      {path.isBrining && (
                        <div className="px-5 py-2 bg-sky-50 border-b border-sky-100 flex items-center gap-2 text-xs text-sky-700">
                          <span className="text-base">💧</span>
                          <span>
                            <strong>Brining 1:1:</strong>{" "}
                            {wrFmtKg(path.totalKg)} Rohware + {wrFmtKg(path.totalKg)} Wasser ={" "}
                            <strong>{wrFmtKg(effectiveTubKg)} Wannenvolumen</strong>
                            {bibleKg ? ` → ${batchCount} Wannen à ${bibleKg} kg` : ""}
                          </span>
                        </div>
                      )}

                      {pathInstructions && (
                        <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-100">
                          <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">Instructions</div>
                          <div className="text-xs leading-relaxed text-slate-700 whitespace-pre-wrap">{pathInstructions}</div>
                        </div>
                      )}

                      {/* ══ EQUIPMENT-BEDARF ═══════════════════════════════════════════════
                          Aggregiert alle Wannen + GN-Bleche für diesen Pfad — sofort sichtbar
                      ══════════════════════════════════════════════════════════════════════ */}
                      {(() => {
                        // GN-Bleche: gruppiert nach GN-Typ
                        const gnByType = new Map<string, number>();
                        for (const row of path.rows) {
                          const n = rowTrayCount(row);
                          if (!n) continue;
                          const gnType = row.inferredGnType ?? "GN (unbekannt)";
                          gnByType.set(gnType, (gnByType.get(gnType) ?? 0) + n);
                        }
                        const totalGnTrays = Array.from(gnByType.values()).reduce((s, v) => s + v, 0);

                        // Wannen pro aktiver Größe summieren (über alle Zutaten)
                        const wannenSums = visibleWannen.map((w) => ({
                          label: w.label,
                          kg: w.kg,
                          total: path.rows.reduce((sum, row) => {
                            // Nur Zeilen die kg haben (keine reinen Stückware-Zeilen)
                            if (row.totalKg == null || row.totalKg <= 0) return sum;
                            const gnC = rowTrayCount(row);
                            if (gnC != null) return sum; // GN-Items nicht in Wannen zählen
                            const n = rowTubCountByWanne(row, w.kg, briningFactor);
                            return sum + (n ?? 0);
                          }, 0),
                        })).filter((ws) => ws.total > 0);

                        const hasEquipment = batchCount != null || ketPlan != null || wannenSums.length > 0 || totalGnTrays > 0;
                        if (!hasEquipment) return null;

                        return (
                          <div className={`border-b px-4 py-4 ${colors.headerBg}`}>
                            <div className="text-[9px] font-black uppercase tracking-widest text-slate-500 mb-3">
                              Equipment-Bedarf · {Math.round(selectedMeal.portionsEffective).toLocaleString("de-DE")} Portionen {selectedMeal.mode === "fertig" ? "(Fertigware)" : "(Rohware)"}
                            </div>
                            <div className="flex flex-wrap gap-2.5">

                              {/* Haupt-Equipment: Batches aus Bible-Daten */}
                              {batchCount != null && (
                                <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 bg-white shadow-sm ring-1 ${colors.border} min-w-[140px]`}>
                                  <span className="text-3xl leading-none">{colors.icon}</span>
                                  <div>
                                    <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 leading-none">
                                      {eq?.split(",")[0]?.trim() ?? "Equipment"}
                                    </div>
                                    <div className={`text-3xl font-black tabular-nums leading-none mt-0.5 ${colors.text}`}>
                                      {batchCount}×
                                    </div>
                                    <div className="text-[10px] font-semibold text-slate-500 mt-0.5 tabular-nums">
                                      à {wrFmtKg(bibleKg!)} Batch
                                    </div>
                                  </div>
                                </div>
                              )}

                              {ketPlan && (
                                <div className="flex items-center gap-3 rounded-xl border px-4 py-3 bg-sky-50 shadow-sm ring-1 ring-sky-200 border-sky-200 min-w-[160px]">
                                  <span className="text-3xl leading-none">🗓️</span>
                                  <div>
                                    <div className="text-[9px] font-black uppercase tracking-widest text-sky-500 leading-none">
                                      KET-Plan
                                    </div>
                                    <div className="text-3xl font-black tabular-nums leading-none mt-0.5 text-sky-700">
                                      {ketPlan.batches}×
                                    </div>
                                    <div className="text-[10px] font-semibold text-sky-600 mt-0.5 tabular-nums">
                                      à {wrFmtKg(ketPlan.batchSizeKg)} Batch
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* GN-Bleche — pro Typ eine Card */}
                              {Array.from(gnByType.entries()).map(([gnType, count]) => (
                                <div key={gnType} className="flex items-center gap-3 rounded-xl border px-4 py-3 bg-white shadow-sm ring-1 border-violet-300 min-w-[130px]">
                                  <span className="text-3xl leading-none">🍽️</span>
                                  <div>
                                    <div className="text-[9px] font-black uppercase tracking-widest text-violet-500 leading-none">GN-Blech</div>
                                    <div className="text-3xl font-black tabular-nums leading-none mt-0.5 text-violet-700">
                                      {count}×
                                    </div>
                                    <div className="text-[10px] font-bold text-violet-600 mt-0.5">
                                      {gnType}
                                    </div>
                                  </div>
                                </div>
                              ))}

                              {/* Wannen nach Größe */}
                              {wannenSums.map((ws) => (
                                <div key={ws.kg} className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 bg-white shadow-sm ring-1 ring-slate-200 min-w-[120px]">
                                  <span className="text-3xl leading-none">🫙</span>
                                  <div>
                                    <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 leading-none">{ws.label} Wanne</div>
                                    <div className={`text-3xl font-black tabular-nums leading-none mt-0.5 ${
                                      ws.total <= 1 ? "text-emerald-700"
                                      : ws.total <= 3 ? "text-sky-700"
                                      : ws.total <= 6 ? "text-amber-700"
                                      : "text-rose-700"
                                    }`}>
                                      {ws.total}×
                                    </div>
                                    <div className="text-[10px] font-semibold text-slate-500 mt-0.5">
                                      {path.isBrining ? "inkl. Wasser" : "Wannen"}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>

                            {/* Direkte kg-Eingabe: Equipment aus Fertig- / Rohware */}
                            <div className="mt-3 pt-3 border-t border-dashed border-slate-200">
                              <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-2">
                                Direkt berechnen — Fertig- oder Rohware
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <select
                                  value={directMode}
                                  onChange={e => setPathDirectKg(prev => ({ ...prev, [pathKey]: { mode: e.target.value as "fertig" | "roh", kg: directKgStr } }))}
                                  aria-label="Direktberechnung Modus"
                                  title="Direktberechnung Modus"
                                  className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                                >
                                  <option value="fertig">Fertigware (kg)</option>
                                  <option value="roh">Rohware (kg)</option>
                                </select>
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  placeholder="kg eingeben …"
                                  value={directKgStr}
                                  onChange={e => setPathDirectKg(prev => ({ ...prev, [pathKey]: { mode: directMode, kg: e.target.value } }))}
                                  className="w-28 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs tabular-nums text-slate-700 focus:bg-white focus:ring-1 focus:ring-indigo-300 focus:outline-none"
                                />
                                {directKgInput != null && (
                                  <span className="text-[10px] text-slate-500">
                                    {directMode === "roh"
                                      ? `→ ~${wrFmtKg(directFertigKg!)} Fertigware`
                                      : `→ direkt`}
                                  </span>
                                )}
                                {directKgStr && (
                                  <button
                                    onClick={() => setPathDirectKg(prev => { const n = { ...prev }; delete n[pathKey]; return n; })}
                                    className="text-[10px] text-slate-400 hover:text-rose-500 px-1"
                                  >✕</button>
                                )}
                              </div>
                              {directFertigKg != null && (
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {directBatchCount != null && (
                                    <div className="flex items-center gap-2 rounded-lg bg-indigo-50 border border-indigo-200 px-3 py-2">
                                      <span className="text-lg">{colors.icon}</span>
                                      <div>
                                        <div className="text-[9px] font-black uppercase text-indigo-400">Batches</div>
                                        <div className="text-xl font-black tabular-nums text-indigo-700">{directBatchCount}×</div>
                                        <div className="text-[9px] text-indigo-400">à {wrFmtKg(bibleKg!)} kg</div>
                                      </div>
                                    </div>
                                  )}
                                  {directWannenSums.map(ws => (
                                    <div key={ws.kg} className="flex items-center gap-2 rounded-lg bg-indigo-50 border border-indigo-200 px-3 py-2">
                                      <span className="text-lg">🫙</span>
                                      <div>
                                        <div className="text-[9px] font-black uppercase text-indigo-400">{ws.label} Wanne</div>
                                        <div className="text-xl font-black tabular-nums text-indigo-700">{ws.total}×</div>
                                        <div className="text-[9px] text-indigo-400">Wannen</div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Stats-Grid */}
                      <div className="grid gap-2 border-b border-slate-100 bg-white px-4 py-3 sm:grid-cols-3 xl:grid-cols-7">
                        {([
                          { label: "WO", value: matchedWo?.workOrder ? `WO ${matchedWo.workOrder}` : "offen", tone: matchedWo?.workOrder ? "text-slate-900" : "text-slate-400" },
                          { label: "Cooking Method", value: effectiveCookingMethod || "open", tone: effectiveCookingMethod ? "text-indigo-700" : "text-slate-400" },
                          { label: "Breakdowns", value: batchCount != null ? `${batchCount}×` : "offen", tone: batchCount != null ? "text-indigo-700" : "text-slate-400" },
                          { label: "WO Size", value: woPathSizeKg != null ? wrFmtKg(woPathSizeKg) : "offen", tone: woPathSizeKg != null ? "text-indigo-700" : "text-slate-400" },
                          { label: "Ziel-Rohware", value: wrFmtKg(path.totalKg), tone: "text-slate-900" },
                          { label: "Wannenvolumen", value: wrFmtKg(effectiveTubKg), tone: path.isBrining ? "text-sky-700" : "text-slate-900" },
                          { label: "Bible / Batch", value: bibleKg ? `${wrFmtKg(bibleKg)} / ${batchCount ?? 0}×` : "offen", tone: bibleKg ? "text-indigo-700" : "text-slate-400" },
                          { label: "KET / Batch", value: ketPlan ? `${wrFmtKg(ketPlan.batchSizeKg)} / ${ketPlan.batches}×` : "kein KET", tone: ketPlan ? "text-sky-700" : "text-slate-400" },
                          { label: "KET Target", value: matchedWo?.targetPortions ? fmtNum(matchedWo.targetPortions, 0) : "offen", tone: matchedWo?.targetPortions ? "text-slate-900" : "text-slate-400" },
                          { label: "Yield Netto", value: wrFmtKg(pathNetKg), tone: "text-emerald-700" },
                          { label: "Verlust", value: path.totalLossKg > 0 ? `${wrFmtKg(path.totalLossKg)} (${pathLossPct}%)` : "kein Verlust", tone: path.totalLossKg > 0 ? "text-amber-700" : "text-emerald-700" },
                          { label: "Roh-Szenario", value: rawCoveragePct != null ? `${rawCoveragePct}% Deckung` : "noch kein Ist", tone: rawCoverage != null && rawCoverage < 1 ? "text-rose-700" : "text-slate-900" },
                        ] as Array<{ label: string; value: string; tone: string }>).map((item) => (
                          <div key={item.label} className="rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
                            <div className="text-[9px] font-black uppercase tracking-widest text-slate-400">{item.label}</div>
                            <div className={`mt-1 text-sm font-black tabular-nums ${item.tone}`}>{item.value}</div>
                          </div>
                        ))}
                      </div>

                      {/* Rohwaren-Szenario */}
                      <div className={`px-4 py-3 border-b flex flex-wrap items-center gap-x-3 gap-y-2 transition-colors ${
                        rawCoverage != null && rawCoverage < 0.8
                          ? "bg-rose-50/60 border-rose-100"
                          : rawCoverage != null && rawCoverage < 1
                          ? "bg-amber-50/60 border-amber-100"
                          : rawCoverage != null && rawCoverage >= 1
                          ? "bg-emerald-50/50 border-emerald-100"
                          : "bg-slate-50/80 border-slate-100"
                      }`}>
                        <span className="text-[9px] font-black uppercase tracking-widest text-slate-500 shrink-0">Rohwaren-Szenario</span>
                        <div className="flex items-center gap-1.5 rounded-lg bg-white px-2 py-1 ring-1 ring-slate-200">
                          <input
                            type="number"
                            min={0}
                            step={1}
                            placeholder="kg eingeben …"
                            value={rawStr}
                            onChange={(e) =>
                              setPathRawInputs((prev) => ({ ...prev, [pathKey]: e.target.value }))
                            }
                            className="w-28 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 tabular-nums focus:bg-white focus:ring-1 focus:ring-indigo-300 focus:outline-none"
                          />
                          <span className="text-[10px] text-slate-400">kg verfügbar</span>
                        </div>
                        {rawKg != null && (
                          <>
                            <div className="h-3 w-px bg-slate-200 shrink-0" />
                            <div className="flex items-center gap-2 flex-wrap">
                              <div className="flex items-center gap-1">
                                <span className={`text-sm font-black tabular-nums leading-none ${
                                  rawCoverage != null && rawCoverage >= 1 ? "text-emerald-600"
                                  : rawCoverage != null && rawCoverage >= 0.8 ? "text-amber-600"
                                  : "text-rose-600"
                                }`}>
                                  {rawCoverage != null ? Math.round(rawCoverage * 100) : 0}%
                                </span>
                                <span className="text-[9px] text-slate-400">Deckung</span>
                              </div>
                              <div className="flex items-center gap-1">
                                <span className={`text-[11px] font-bold tabular-nums ${
                                  rawCoverage != null && rawCoverage >= 1 ? "text-emerald-700" : "text-amber-700"
                                }`}>
                                  {rawPortions?.toLocaleString("de-DE")}
                                </span>
                                <span className="text-[9px] text-slate-400">/ {Math.round(selectedMeal.portionsEffective).toLocaleString("de-DE")} Port.</span>
                              </div>
                              {rawNetKg != null && path.totalLossKg > 0 && (
                                <div className="flex items-center gap-1">
                                  <span className="text-[9px] text-slate-400">Netto-Ertrag:</span>
                                  <span className="text-[10px] font-bold text-emerald-600 tabular-nums">{wrFmtKg(rawNetKg)}</span>
                                </div>
                              )}
                              {rawCoverage != null && rawCoverage < 1 && (
                                <span className={`text-[9px] font-bold px-2 py-0.5 rounded-lg ring-1 ${
                                  rawCoverage < 0.8
                                    ? "text-rose-700 bg-rose-50 ring-rose-200"
                                    : "text-amber-700 bg-amber-50 ring-amber-200"
                                }`}>
                                  ⚠ Engpass: −{Math.round((1 - rawCoverage) * selectedMeal.portionsEffective).toLocaleString("de-DE")} Port. fehlen
                                </span>
                              )}
                              {rawCoverage != null && rawCoverage >= 1 && (
                                <span className="text-[9px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-lg ring-1 ring-emerald-200">
                                  ✓ Volldeckung{rawCoverage > 1
                                    ? ` (+${Math.round((rawCoverage - 1) * selectedMeal.portionsEffective).toLocaleString("de-DE")} Port. Überschuss)`
                                    : ""}
                                </span>
                              )}
                            </div>
                          </>
                        )}
                      </div>

                      {/* Collapse-Toggle */}
                      <button
                        onClick={() => togglePath(pathKey)}
                        className="w-full px-5 py-2.5 flex items-center justify-between bg-slate-50 hover:bg-slate-100 border-t border-slate-100 transition-colors"
                      >
                        <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">
                          {isExpanded ? "Zutaten ausblenden" : `Zutaten anzeigen (${path.rows.length} Positionen)`}
                        </span>
                        <span className="text-slate-400 text-sm">{isExpanded ? "▴" : "▾"}</span>
                      </button>

                      {/* Zutaten-Tabelle (collapsible) */}
                      {isExpanded && (
                        <div className="overflow-x-auto bg-white">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-slate-100">
                                <th className="text-left px-4 py-2 text-[9px] font-bold uppercase tracking-widest text-slate-400">Zutat</th>
                                <th className="text-right px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-slate-400 whitespace-nowrap">WO Size</th>
                                <th className="text-right px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-slate-400 whitespace-nowrap">Total Size</th>
                                <th className="text-right px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-amber-500 whitespace-nowrap">Verlust</th>
                                {visibleWannen.map((w) => (
                                  <th key={w.kg} className={`text-center px-2 py-2 text-[9px] font-bold uppercase tracking-widest whitespace-nowrap ${path.isBrining ? "text-sky-500" : "text-slate-400"}`}>
                                    {w.label}{path.isBrining ? " 💧" : ""}
                                  </th>
                                ))}
                                <th className="w-8" />
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                              {path.rows.map((row, ri) => {
                                const rowKey = row.overrideKey || `${row.ingredientId}-${ri}`;
                                const overrideOpen = expandedOverrides.has(rowKey);
                                const hasOverride = overrides[row.overrideKey]?.qty != null
                                  || overrides[row.overrideKey]?.kg != null
                                  || overrides[row.overrideKey]?.pcsPerTray != null;
                                return (
                                  <tr key={rowKey} className="hover:bg-slate-50/80 transition-colors">
                                    <td className="px-4 py-2.5">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <span className={`text-[8px] font-black px-1.5 py-0.5 rounded shrink-0 uppercase tracking-wide ${wrCatBadge(row.category)}`}>
                                          {row.category}
                                        </span>
                                        <span className="text-sm text-slate-800 font-medium leading-snug truncate">{row.name}</span>
                                        <span className="text-[9px] font-mono text-slate-300 shrink-0">{row.ingredientId !== "-" ? row.ingredientId : ""}</span>
                                      </div>
                                      {overrideOpen && (
                                        <div className="mt-2 flex flex-wrap gap-2 pl-1 pt-2 border-t border-slate-100">
                                          <div className="flex flex-col gap-0.5">
                                            <label className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide">Menge ({row.uom})</label>
                                            <input type="number" min={0} step={0.1} value={overrides[row.overrideKey]?.qty ?? ""} placeholder="—"
                                              onChange={(e) => { const v = e.target.value.trim(); patchOverride(row.overrideKey, { qty: v === "" ? undefined : Number(v) }); }}
                                              className="w-28 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 focus:ring-1 focus:ring-indigo-300 focus:outline-none" />
                                          </div>
                                          <div className="flex flex-col gap-0.5">
                                            <label className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide">kg Override</label>
                                            <input type="number" min={0} step={0.1} value={overrides[row.overrideKey]?.kg ?? ""} placeholder="—"
                                              onChange={(e) => { const v = e.target.value.trim(); patchOverride(row.overrideKey, { kg: v === "" ? undefined : Number(v) }); }}
                                              className="w-24 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 focus:ring-1 focus:ring-indigo-300 focus:outline-none" />
                                          </div>
                                          <div className="flex flex-col gap-0.5">
                                            <label className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide">PCS/Tray</label>
                                            <input type="number" min={1} step={1} value={overrides[row.overrideKey]?.pcsPerTray ?? ""} placeholder="—"
                                              onChange={(e) => { const v = e.target.value.trim(); patchOverride(row.overrideKey, { pcsPerTray: v === "" ? undefined : Number(v) }); }}
                                              className="w-24 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 focus:ring-1 focus:ring-indigo-300 focus:outline-none" />
                                          </div>
                                        </div>
                                      )}
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-700 whitespace-nowrap">
                                      {wrFmtRowWoSize(row, batchCount)}
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-700 whitespace-nowrap">
                                      {wrFmtRowTotalSize(row)}
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                                      {row.lossKg != null && row.lossKg > 0 ? (
                                        <div className="flex flex-col items-end gap-0.5">
                                          <span className="text-[10px] font-bold text-amber-600">−{wrFmtKg(row.lossKg)}</span>
                                          {row.yieldPct != null && (
                                            <span className="text-[9px] text-slate-400">{Math.round((1 - row.yieldPct) * 100)}%</span>
                                          )}
                                        </div>
                                      ) : (
                                        <span className="text-[10px] text-slate-200">—</span>
                                      )}
                                    </td>
                                    {(() => {
                                      const gnCount = rowTrayCount(row);
                                      if (gnCount != null) {
                                        return (
                                          <td colSpan={visibleWannen.length} className="px-2 py-2.5 text-center">
                                            <span className={`inline-flex items-center gap-1.5 justify-center min-w-[80px] h-7 px-3 text-sm font-bold tabular-nums rounded-lg ${wrTubCellCls(gnCount)}`}>
                                              <span className="text-[10px]">🍽️</span>
                                              ×{gnCount}
                                              <span className="text-[9px] font-semibold opacity-70 ml-0.5">GN</span>
                                            </span>
                                            {row.inferredPcsPerTray != null && (
                                              <div className="text-[8px] text-slate-400 mt-0.5">{row.inferredPcsPerTray} pcs/Blech</div>
                                            )}
                                          </td>
                                        );
                                      }
                                      return visibleWannen.map((w) => {
                                        const count = rowTubCountByWanne(row, w.kg, briningFactor);
                                        if (count === null) {
                                          return (
                                            <td key={w.kg} className="px-2 py-2.5 text-center">
                                              <span className="text-[10px] text-slate-300">—</span>
                                            </td>
                                          );
                                        }
                                        return (
                                          <td key={w.kg} className={`px-2 py-2.5 text-center ${path.isBrining ? "bg-sky-50/50" : ""}`}>
                                            <span className={`inline-flex items-center justify-center min-w-[40px] h-7 px-2 text-sm font-bold tabular-nums rounded-lg ${wrTubCellCls(count)}`}>
                                              ×{count}
                                            </span>
                                          </td>
                                        );
                                      });
                                    })()}
                                    <td className="px-2 py-2.5 text-center">
                                      <button
                                        onClick={() => toggleOverrideRow(rowKey)}
                                        title="Werte anpassen"
                                        className={`inline-flex items-center justify-center w-6 h-6 rounded-md text-[11px] transition-colors ${
                                          hasOverride ? "bg-indigo-100 text-indigo-600 ring-1 ring-indigo-300"
                                          : overrideOpen ? "bg-slate-100 text-slate-600"
                                          : "text-slate-200 hover:text-slate-500 hover:bg-slate-100"
                                        }`}
                                      >✎</button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                            <tfoot>
                              <tr className="border-t-2 border-slate-200 bg-slate-50">
                                <td className="px-4 py-2 text-[10px] font-bold text-slate-600 uppercase tracking-wide">Gesamt</td>
                                <td className="px-3 py-2 text-right tabular-nums font-bold text-slate-800 whitespace-nowrap">{woPathSizeKg != null ? wrFmtKg(woPathSizeKg) : "—"}</td>
                                <td className="px-3 py-2 text-right tabular-nums font-bold text-slate-800 whitespace-nowrap">{wrFmtKg(path.totalKg)}</td>
                                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                                  {path.totalLossKg > 0 ? (
                                    <div className="flex flex-col items-end">
                                      <span className="text-[10px] font-bold text-amber-600">−{wrFmtKg(path.totalLossKg)}</span>
                                      {path.totalKg > 0 && (
                                        <span className="text-[9px] text-slate-400">{Math.round((path.totalLossKg / path.totalKg) * 100)}% Verlust</span>
                                      )}
                                    </div>
                                  ) : <span className="text-[10px] text-slate-300">—</span>}
                                </td>
                                <td colSpan={visibleWannen.length + 1} />
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>

      {/* ═══════════════════════════════════════════════════════════════════
          ADD MEAL SLIDE-IN
      ════════════════════════════════════════════════════════════════════ */}
      {addMealOpen && (
        <div
          className="absolute inset-0 z-30 flex"
          onClick={() => setAddMealOpen(false)}
        >
          <div
            className="w-[340px] h-full bg-white shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-slate-900 to-slate-800">
              <span className="text-sm font-bold text-white">Mahlzeit hinzufügen</span>
              <button
                onClick={() => setAddMealOpen(false)}
                className="text-slate-400 hover:text-white text-xl leading-none transition-colors"
              >×</button>
            </div>
            <div className="px-4 py-3 flex-1 overflow-y-auto space-y-3">
              {weekRecipes.length === 0 ? (
                <p className="text-sm text-slate-500">Keine Rezepte für Woche {week}.</p>
              ) : (
                <>
                  <input
                    type="search"
                    placeholder="Rezept oder Code suchen …"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:bg-white focus:ring-2 focus:ring-indigo-300 focus:outline-none transition"
                  />
                  {suggestions.length > 0 ? (
                    <div className="space-y-1.5">
                      {suggestions.map((wr) => (
                        <button
                          key={wr.code}
                          onClick={() => { addRecipe(wr); setAddMealOpen(false); }}
                          className="group w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left hover:border-indigo-400 hover:shadow-sm transition-all"
                        >
                          <div className="text-[10px] font-mono text-slate-400 group-hover:text-indigo-500 transition-colors">{wr.code}</div>
                          <div className="text-sm font-semibold text-slate-800 leading-snug">{wrStripMarketTag(wr.recipeName)}</div>
                          <div className="text-[11px] text-slate-400 tabular-nums mt-0.5">
                            {wr.totalVerdenVolume.toLocaleString("de-DE")} Port.{wr.preference ? ` · ${wr.preference}` : ""}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : needle ? (
                    <p className="text-sm text-slate-400 italic">Kein Rezept gefunden.</p>
                  ) : null}
                </>
              )}
            </div>
          </div>
          <div className="flex-1 bg-black/20 backdrop-blur-sm" />
        </div>
      )}
      </div>
    </div>
  );
}
