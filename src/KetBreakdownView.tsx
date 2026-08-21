// KetBreakdownView.tsx – KET Plan → WO Breakdown → PDF
// Upload KET CSV directly; falls back to data.productionPlan.
// Equipment capacities are user-editable, saved to localStorage.

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { DataBundle, WorkOrderEntry } from "./core/types";
import { fetchWmsWorkorderCache, wmsWorkorderRowToEntry, filterRowsToWeekWindow, currentHfWeek } from "./lib/wmsCache";
import { weekNumFromHfWeek, weekPrefixFromWoNumber } from "./features/wms-overview/wmsWeeks";
import { LiveBadge } from "./features/redzone-live/LiveBadge";
import { EQUIP_DEFAULTS, EQUIP_LABELS, LS_CAPS_KEY, type BatchCalc, type KetRow, type ManualEquipmentOverride, type WoComponent, type WoInstruction, type WoSortMode } from "./features/ket-plan/ketTypes";
import {
  calcBatch, EMPTY_GN_HINTS, fmtDateHeader, fmtKg, instructionCacheKey, parseKetCsv, parseSortKey, statusColors, woEntriesToKetRows,
  type GnHints,
} from "./features/ket-plan/ketLogic";
import { buildPdf } from "./features/ket-plan/ketPdf";
import { EmptyState, KetWoOverview, MissingDataScreen } from "./features/ket-plan/KetSharedUi";
import { WoDetail } from "./features/ket-plan/KetWoDetail";
import { generateWoInstruction, generateWoInstructionsBatch } from "./features/ket-plan/woInstructionBot";
import { computeRunAssignments, shiftLabel } from "./features/ket-plan/ketRunLogic";
import { KetEquipmentPanel } from "./features/ket-plan/KetEquipmentPanel";
import { wrBuildHintsFromDumps } from "./features/kitchen-mode/wrEquipmentHints";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

const STORAGE_KEYS = {
  csvRows: "ket-csv-rows-v1",
  csvFilename: "ket-csv-filename-v1",
  woInstructions: "ket-wo-instructions-v1",
  printedWoNumbers: "ket-printed-wo-numbers-v1",
} as const;

const PRINTED_WO_MAX = 2000; // Deckelt den localStorage-Eintrag; älteste zuerst raus.

const INSTRUCTION_CACHE_MAX = 500;

const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})/;
const SHIFT_PATTERN = /[-–]\s*(\d+)$/;
const SAFE_FILENAME_PATTERN = /[^\wäöüßÄÖÜ\-\.]+/gi;


const PDF_PRINT_DELAY_MS = 300; // ms to wait for PDF to render before printing
// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS (Pure, Testable)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract ISO date (YYYY-MM-DD) from dateNeeded string.
 * Handles strings like "2026-08-15 – 2" → "2026-08-15"
 */
function extractDate(dateStr: string): string {
  return dateStr.match(DATE_PATTERN)?.[1] ?? dateStr;
}

/**
 * Extract shift number from dateNeeded string.
 * Handles "2026-08-15 – 2" → "2"
 */
function extractShift(dateStr: string): string {
  return dateStr.match(SHIFT_PATTERN)?.[1] ?? "—";
}

/**
 * Detect which data source to display (CSV > Firestore > LiveWMS > FirestoreStale > null)
 */
function detectSource(
  csvRows: KetRow[] | null,
  productionPlanHasLiveWeek: boolean,
  liveWmsRows: WorkOrderEntry[] | null,
  productionPlanHasRows: boolean,
): "CSV" | "Firestore" | "LiveWMS" | "FirestoreStale" | null {
  if (csvRows !== null) return "CSV";
  if (productionPlanHasRows && productionPlanHasLiveWeek) return "Firestore";
  if (liveWmsRows?.length) return "LiveWMS";
  if (productionPlanHasRows) return "FirestoreStale";
  return null;
}

/**
 * Sanitize filename: handle German umlauts, remove special chars
 */
function sanitizeFilename(name: string): string {
  return name.replace(SAFE_FILENAME_PATTERN, "_");
}

/**
 * Dateiname einer einzelnen WO-PDF: WO-Nummer + Mealcode (recipeCode, z.B.
 * FV1234A) + Sub-Rezept-/Rezeptname — damit sich die abgelegte Datei ohne
 * Öffnen genauso identifizieren lässt wie die WO selbst.
 */
function woFilename(row: KetRow): string {
  const parts = [`WO_${row.woNumber}`];
  if (row.recipeCode) parts.push(row.recipeCode);
  parts.push(row.subRecipeName || row.recipeName);
  return parts.join("_");
}

/**
 * Ein Ziel für die Gemini-Instruction-Generierung: normalerweise die ganze WO
 * (component=undefined), bei zusammengesetzten Sub-Rezepten (calc.components,
 * siehe ketLogic.buildWoComponents) je ein Ziel PRO Komponente — jede braucht
 * ihre eigene, unabhängig generierte Kochanweisung statt einer vermischten.
 * `key` adressiert den Laufzeit-State (woInstructions), `cacheKey` den
 * localStorage-Cache (bleibt über Wochen stabil, siehe instructionCacheKey).
 */
interface GenerationTarget {
  key: string;
  cacheKey: string;
  row: KetRow;
  calc: BatchCalc;
  component?: WoComponent;
}

function generationTargetsForRow(row: KetRow, calc: BatchCalc): GenerationTarget[] {
  if (calc.components.length > 0) {
    // Manche Rezepte (z.B. FV0401A "Keto Crack Chicken Thigh") wiederholen
    // denselben Zubereitungsschritt (identischer Name, identische Zutaten) an
    // mehreren Stellen im Baum — die WoDetail-Ansicht zeigt bewusst jedes
    // Vorkommen (die Küche muss es ggf. mehrfach physisch tun), aber für die
    // Gemini-Generierung wäre ein zweiter Aufruf für exakt denselben Namen nur
    // verschwendetes Kontingent, da beide ohnehin denselben Cache-Eintrag
    // (instructionCacheKey ist name-basiert) teilen würden. Pro Zeile also nur
    // ein Ziel je eindeutigem Komponentennamen erzeugen.
    const seen = new Set<string>();
    const targets: GenerationTarget[] = [];
    for (const component of calc.components) {
      if (seen.has(component.name)) continue;
      seen.add(component.name);
      targets.push({
        key: `${row.key}::${component.name}`,
        cacheKey: instructionCacheKey(row, component.name),
        row,
        calc,
        component,
      });
    }
    return targets;
  }
  return [{ key: row.key, cacheKey: instructionCacheKey(row), row, calc }];
}

/**
 * Type-safe FileReader result extraction
 */
function getFileReaderText(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (result instanceof ArrayBuffer) {
    return new TextDecoder().decode(result);
  }
  return null;
}

/**
 * Safe localStorage get/set with proper error handling
 */
const storage = {
  getItem<T>(key: string, parse = true): T | null {
    try {
      const item = localStorage.getItem(key);
      if (!item) return null;
      return parse ? (JSON.parse(item) as T) : (item as T);
    } catch (error) {
      console.warn(`[KetBreakdown] Failed to read localStorage.${key}:`, error);
      return null;
    }
  },
  setItem<T>(key: string, value: T | null, stringify = true): boolean {
    try {
      if (value === null) {
        localStorage.removeItem(key);
      } else {
        const data = stringify ? JSON.stringify(value) : (value as string);
        localStorage.setItem(key, data);
      }
      return true;
    } catch (error) {
      console.error(`[KetBreakdown] Failed to write localStorage.${key}:`, error);
      // TODO: Show user error toast here
      return false;
    }
  },
} as const;

// ── Instruction-Cache: persistiert generierte Instructions über Neuimporte hinweg ──
type InstructionCache = Record<string, WoInstruction>;

function loadInstructionCache(): InstructionCache {
  return storage.getItem<InstructionCache>(STORAGE_KEYS.woInstructions, true) ?? {};
}

function saveInstructionCache(cache: InstructionCache): void {
  // Limitiere auf INSTRUCTION_CACHE_MAX Einträge (älteste zuerst raus, via generatedAt)
  const entries = Object.entries(cache);
  if (entries.length > INSTRUCTION_CACHE_MAX) {
    entries.sort((a, b) => (a[1].generatedAt ?? "").localeCompare(b[1].generatedAt ?? ""));
    const trimmed = Object.fromEntries(entries.slice(entries.length - INSTRUCTION_CACHE_MAX));
    storage.setItem(STORAGE_KEYS.woInstructions, trimmed, true);
  } else {
    storage.setItem(STORAGE_KEYS.woInstructions, cache, true);
  }
}

// ── "Bereits gedruckt/gespeichert"-Cache: überlebt CSV-Neu-Uploads ──────────
// Marcel kann vom WMS nur den KOMPLETTEN aktuellen Stand exportieren (neue +
// bereits abgearbeitete WOs gemischt), nicht nur die neuen. Damit ein erneuter
// Upload nicht versehentlich alle schon gedruckten WOs erneut in den Bulk-
// Druck/-Speicher-Lauf mit reinzieht, merken wir uns "gedruckt am" je
// woNumber — stabil über Re-Uploads hinweg (anders als row.key, das den
// CSV-Zeilenindex enthält und sich bei jedem Upload ändert).
type PrintedWoCache = Record<string, string>; // woNumber -> ISO-Zeitstempel

function loadPrintedWoCache(): PrintedWoCache {
  return storage.getItem<PrintedWoCache>(STORAGE_KEYS.printedWoNumbers, true) ?? {};
}

function savePrintedWoCache(cache: PrintedWoCache): void {
  const entries = Object.entries(cache);
  if (entries.length > PRINTED_WO_MAX) {
    entries.sort((a, b) => a[1].localeCompare(b[1]));
    storage.setItem(STORAGE_KEYS.printedWoNumbers, Object.fromEntries(entries.slice(entries.length - PRINTED_WO_MAX)), true);
  } else {
    storage.setItem(STORAGE_KEYS.printedWoNumbers, cache, true);
  }
}

// Löst aktuelle Generierungsziele (WO oder — bei zusammengesetzten Sub-Rezepten
// — einzelne Komponenten, siehe generationTargetsForRow) → cache-basierte
// Instructions auf.
function resolveInstructionsFromCache(rows: KetRow[], calcMap: Map<string, BatchCalc>, cache: InstructionCache): Record<string, WoInstruction> {
  const resolved: Record<string, WoInstruction> = {};
  for (const row of rows) {
    const calc = calcMap.get(row.key);
    if (!calc) continue;
    for (const target of generationTargetsForRow(row, calc)) {
      if (cache[target.cacheKey]) resolved[target.key] = cache[target.cacheKey];
    }
  }
  return resolved;
}


export function KetBreakdownView({ data, selectedWeek }: { data: DataBundle; selectedWeek?: string }) {
  const liveWeek = selectedWeek || currentHfWeek();
  const [csvRows, setCsvRows] = useState<KetRow[] | null>(() =>
    storage.getItem<KetRow[]>(STORAGE_KEYS.csvRows, true) ?? null,
  );
  const [csvFileName, setCsvFileName] = useState<string>(() =>
    storage.getItem<string>(STORAGE_KEYS.csvFilename, false) ?? "",
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showEquip, setShowEquip] = useState(false);
  const [woSearch, setWoSearch] = useState("");
  const [mainViewMode, setMainViewMode] = useState<"detail" | "list" | "equipment">("detail");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [woSortMode, setWoSortMode] = useState<WoSortMode>("date");
  const [liveWmsRows, setLiveWmsRows] = useState<WorkOrderEntry[] | null>(null);
  const [wmsDroppedWeeks, setWmsDroppedWeeks] = useState<string[]>([]);
  const [weekFilterEnabled, setWeekFilterEnabled] = useState(true);
  // Schicht-/Run-Anzeige — beide bewusst standardmäßig aus ("später zuschaltbar",
  // Marcel 2026-08-21): Schicht ist eine reine Uhrzeit-Anzeige (unverändert
  // korrekt), Run ist eine SCHÄTZUNG (kumulierte Wochen-Portionen je Meal, siehe
  // ketRunLogic.ts) — keine WMS-verifizierte Tatsache, daher als Vorschau/Toggle.
  const [showShifts, setShowShifts] = useState(false);
  const [showRuns, setShowRuns] = useState(false);

  const [caps, setCaps] = useState<Record<string, number>>(() => {
    const saved = storage.getItem<Record<string, number>>(LS_CAPS_KEY, true);
    return saved ? { ...EQUIP_DEFAULTS, ...saved } : { ...EQUIP_DEFAULTS };
  });
  const [capInputs, setCapInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(EQUIP_DEFAULTS).map(([k, v]) => [k, String(v)]),
    ),
  );
  const [manualEquipment, setManualEquipment] = useState<Record<string, ManualEquipmentOverride>>({});
  // Equipment-Ausnahme je Komponente einer zusammengesetzten WO: row.key → componentName → Override.
  const [componentManualEquipment, setComponentManualEquipment] = useState<Record<string, Record<string, ManualEquipmentOverride>>>({});
  // GN-Blech-Hints aus dem Kuechenbible-GSheet-Dump (PROTEIN-DEBOX/VEGGIE-DEBOX
  // Bible-Tabs) — derselbe Dump, den auch der Kitchen-Mode-Rechner nutzt (siehe
  // src/features/kitchen-mode/). Einmalig geladen; ohne Treffer bleibt für viele
  // Zutaten trotzdem die fest codierte kg-Kapazitäts-Tabelle als Fallback aktiv
  // (siehe ketLogic.resolveGnTrays), daher hier kein harter Fehlerzustand nötig.
  const [gnHints, setGnHints] = useState<GnHints>(EMPTY_GN_HINTS);
  useEffect(() => {
    let cancelled = false;
    fetch("/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json")
      .then((res) => (res.ok ? res.json() : null))
      .then((bibles) => {
        if (cancelled || !bibles) return;
        const { trayHints, pieceWeightKg } = wrBuildHintsFromDumps(null, bibles);
        setGnHints({ trayHints, pieceWeightKg });
      })
      .catch((error) => console.warn("[KetBreakdown] GN-Blech-Hints konnten nicht geladen werden:", error));
    return () => { cancelled = true; };
  }, []);
  const instructionCacheRef = useRef<InstructionCache>(loadInstructionCache());
  const [woInstructions, setWoInstructions] = useState<Record<string, WoInstruction>>({});
  const printedWoCacheRef = useRef<PrintedWoCache>(loadPrintedWoCache());
  const [printedWoNumbers, setPrintedWoNumbers] = useState<Record<string, string>>(() => ({ ...printedWoCacheRef.current }));
  const [includeAlreadyPrinted, setIncludeAlreadyPrinted] = useState(false);
  const [selectedDayFilter, setSelectedDayFilter] = useState<Set<string> | null>(null);
  const [selectedInstructionDays, setSelectedInstructionDays] = useState<Set<string> | null>(null);
  const [selectedWoKeys, setSelectedWoKeys] = useState<Set<string>>(new Set());
  const [batchInstructionBusy, setBatchInstructionBusy] = useState(false);
  const [batchInstructionStatus, setBatchInstructionStatus] = useState<string | null>(null);
  const [failedInstructions, setFailedInstructions] = useState<Array<{ key: string; woNumber: string; componentName?: string; error: string }>>([]);
  const [bulkDlBusy, setBulkDlBusy] = useState(false);
  const [bulkDlStatus, setBulkDlStatus] = useState<string | null>(null);

  const [bulkDlError, setBulkDlError] = useState<string | null>(null);
  // "Hat Zeilen" reicht nicht - der GSheet→Firestore-Plan kann 300+ Zeilen für
  // längst vergangene Wochen halten, während die aktuelle Woche darin komplett
  // fehlt (das GSheet "Fertigstellungszeitplan" wurde für sie noch nicht
  // befüllt). Ohne diesen Check würde der Live-Snowflake-Fallback unten nie
  // greifen, obwohl productionPlan für die aktuelle Woche leer ist.
  const productionPlanHasLiveWeek = useMemo(() => {
    const rows = data.productionPlan?.rows;
    if (!rows?.length) return false;
    const liveWeekNum = weekNumFromHfWeek(liveWeek);
    if (liveWeekNum == null) return true; // can't tell - don't second-guess the trusted source
    return rows.some((row) => weekPrefixFromWoNumber(row.workOrder) === liveWeekNum);
  }, [data.productionPlan?.rows, liveWeek]);

  const ketRows = useMemo<KetRow[]>(() => {
    if (csvRows !== null) return csvRows;
    const rows = data.productionPlan?.rows;
    if (rows?.length && productionPlanHasLiveWeek) return woEntriesToKetRows(rows);
    if (liveWmsRows?.length) return woEntriesToKetRows(liveWmsRows);
    if (rows?.length) return woEntriesToKetRows(rows); // stale but still better than nothing
    return [];
  }, [csvRows, data.productionPlan?.rows, productionPlanHasLiveWeek, liveWmsRows]);

  // Lowest-priority fallback: only reach for the live WMS/Snowflake cache when
  // neither manual CSV nor the established GSheet→Firestore plan has rows for
  // the CURRENT week, so this unverified source can never silently override a
  // trusted one that's actually still current.
  useEffect(() => {
    if (csvRows !== null) return;
    if (productionPlanHasLiveWeek) return;
    let cancelled = false;
    
    fetchWmsWorkorderCache().then((res) => {
      if (cancelled || !res || !res.rows.length) return;
      const { kept, droppedWeeks } = filterRowsToWeekWindow(res.rows, liveWeek);
      
      // Map defensively: one malformed cache row must be skipped, not throw
      const mapped = kept.reduce<WorkOrderEntry[]>((acc, row) => {
        try {
          acc.push(wmsWorkorderRowToEntry(row));
        } catch (error) {
          console.warn("[KetBreakdown] Skipping malformed WMS row:", error);
        }
        return acc;
      }, []);
      
      if (cancelled) return;
      setWmsDroppedWeeks(droppedWeeks);
      if (mapped.length) setLiveWmsRows(mapped);
    }).catch((error) => {
      if (!cancelled) {
        console.error("[KetBreakdown] Failed to fetch WMS workorder cache:", error);
      }
    });
    
    return () => { cancelled = true; };
  }, [csvRows, productionPlanHasLiveWeek, liveWeek]);

  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (ketRows.length === 0 && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      fileInputRef.current?.click();
    }
  }, [ketRows.length]);

  const calcMap = useMemo(() => {
    const m = new Map<string, BatchCalc>();
    for (const row of ketRows) m.set(row.key, calcBatch(row, caps, data, manualEquipment[row.key], componentManualEquipment[row.key], gnHints));
    return m;
  }, [ketRows, caps, data, manualEquipment, componentManualEquipment, gnHints]);

  // Bei Rows-/Berechnungsänderung: gecachte Instructions aus localStorage auflösen
  // (inkl. Komponenten-Instructions zusammengesetzter Sub-Rezepte, siehe calcMap oben).
  useEffect(() => {
    if (!ketRows.length) return;
    const cached = resolveInstructionsFromCache(ketRows, calcMap, instructionCacheRef.current);
    if (Object.keys(cached).length > 0) {
      setWoInstructions((prev) => ({ ...cached, ...prev }));
    }
  }, [ketRows, calcMap]);

  const liveWeekNum = useMemo(() => weekNumFromHfWeek(liveWeek), [liveWeek]);
  const weekFilteredRows = useMemo(() => {
    if (!weekFilterEnabled || liveWeekNum == null) return ketRows;
    return ketRows.filter((row) => weekPrefixFromWoNumber(row.woNumber) === liveWeekNum);
  }, [ketRows, weekFilterEnabled, liveWeekNum]);

  // Run-Zuteilung ist eine SCHÄTZUNG (kumulierte Wochen-Portionen je Meal,
  // siehe ketRunLogic.ts) — nur berechnet, wenn showRuns aktiv ist. Bewusst auf
  // Basis von weekFilteredRows (nicht ketRows): Runs sind ein Innerhalb-der-
  // Woche-Konzept; bei deaktiviertem Wochenfilter ("Alle Wochen") würden sich
  // sonst Portionen verschiedener Wochen fälschlich zu einem Run summieren.
  const runAssignments = useMemo(
    () => (showRuns ? computeRunAssignments(weekFilteredRows) : new Map()),
    [weekFilteredRows, showRuns],
  );

  const groups = useMemo(() => {
    const m = new Map<string, KetRow[]>();
    for (const row of weekFilteredRows) {
      const day = extractDate(row.dateNeeded);
      if (!m.has(day)) m.set(day, []);
      m.get(day)!.push(row);
    }
    return [...m.entries()]
      .map(([day, rows]) => [day, [...rows].sort((a, b) => {
        const shiftA = Number(extractShift(a.dateNeeded));
        const shiftB = Number(extractShift(b.dateNeeded));
        if (shiftA !== shiftB) return shiftA - shiftB;
        const ra = (a.subRecipeName || a.recipeName).toLowerCase();
        const rb = (b.subRecipeName || b.recipeName).toLowerCase();
        return ra.localeCompare(rb, "de") || a.woNumber.localeCompare(b.woNumber, "de", { numeric: true });
      })] as [string, KetRow[]])
      // Neuester Tag immer oben — unabhängig von woSortMode, der nur innerhalb eines Tages sortiert.
      .sort((a, b) => parseSortKey(b[0]) - parseSortKey(a[0]));
  }, [weekFilteredRows]);

  const dayFilteredGroups = useMemo(() => {
    if (!selectedDayFilter || selectedDayFilter.size === 0) return groups;
    return groups.filter(([day]) => selectedDayFilter.has(day));
  }, [groups, selectedDayFilter]);

  const needle = useMemo(
    () => woSearch.trim().toLowerCase(),
    [woSearch],
  );
  
  const filteredGroups = useMemo(() => {
    const base = !needle
      ? dayFilteredGroups
      : dayFilteredGroups
          .map(([k, rows]) => [k, rows.filter((r) =>
            [r.woNumber, r.recipeCode, r.recipeName, r.subRecipeName].join(" ").toLowerCase().includes(needle)
          )] as [string, KetRow[]])
          .filter(([, rows]) => rows.length > 0);

    if (woSortMode === "date") return base;

    return base.map(([date, rows]) => {
      const sorted = [...rows].sort((a, b) => {
        switch (woSortMode) {
          case "wo":      return a.woNumber.localeCompare(b.woNumber, "de", { numeric: true });
          case "recipe":  return (a.subRecipeName || a.recipeName).localeCompare(b.subRecipeName || b.recipeName);
          case "status":  return a.kitchenStatus.localeCompare(b.kitchenStatus);
          case "batches": return (calcMap.get(b.key)?.batches ?? 0) - (calcMap.get(a.key)?.batches ?? 0);
          case "kg":      return (calcMap.get(b.key)?.totalKg ?? 0) - (calcMap.get(a.key)?.totalKg ?? 0);
          default:        return 0;
        }
      });
      return [date, sorted] as [string, KetRow[]];
    });
  }, [dayFilteredGroups, needle, woSortMode, calcMap]);


  const filteredRows = filteredGroups.flatMap(([, rows]) => rows);
  // Sidebar-Reihenfolge zeigt bewusst den neuesten Tag zuerst (siehe `groups` oben),
  // aber ein gedruckter/gespeicherter Mehrtages-Stapel soll chronologisch (ältester
  // Tag zuerst) sein — wie eine Küche einen Papierstapel der Reihe nach abarbeitet.
  const bulkPrintRows = useMemo(
    () => [...(filteredRows.length > 0 ? filteredRows : weekFilteredRows)].sort(
      (a, b) => parseSortKey(a.dateNeeded) - parseSortKey(b.dateNeeded)
        || a.woNumber.localeCompare(b.woNumber, "de", { numeric: true }),
    ),
    [filteredRows, weekFilteredRows],
  );
  const availableInstructionDays = groups.map(([day]) => day);
  const activeInstructionDays = useMemo(
    () => selectedInstructionDays ?? new Set(availableInstructionDays),
    [selectedInstructionDays, availableInstructionDays],
  );
  const instructionRows = useMemo(
    () => weekFilteredRows.filter((row) => {
      const day = extractDate(row.dateNeeded);
      return activeInstructionDays.has(day);
    }),
    [weekFilteredRows, activeInstructionDays],
  );
  const selectedRow = ketRows.find((r) => r.key === selectedKey) ?? null;
  const selectedCalc = selectedKey ? (calcMap.get(selectedKey) ?? null) : null;

  const handleFile = useCallback((file: File) => {
    setCsvFileName(file.name);
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const text = getFileReaderText(e.target?.result);
      if (!text) {
        alert("Fehler beim Lesen der Datei – bitte versuchen Sie es erneut.");
        return;
      }
      
      try {
        const { rows: parsed, warnings } = parseKetCsv(text);
        if (warnings.length) console.warn("[KetBreakdown] CSV warnings:", warnings);
        if (!parsed || parsed.length === 0) {
          alert("Die CSV-Datei ist leer oder konnte nicht gelesen werden.");
          return;
        }
        setCsvRows(parsed);
        setSelectedWoKeys(new Set());
        storage.setItem(STORAGE_KEYS.csvRows, parsed, true);
        storage.setItem(STORAGE_KEYS.csvFilename, file.name, false);
        setSelectedKey(parsed[0]?.key ?? null);
      } catch (error) {
        console.error("[KetBreakdown] CSV parsing failed:", error);
        alert(`Fehler beim Verarbeiten der CSV-Datei: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    
    reader.onerror = () => {
      alert("Fehler beim Lesen der Datei – bitte versuchen Sie es erneut.");
      console.error("[KetBreakdown] FileReader error:", reader.error);
    };
    
    reader.readAsText(file, "utf-8");
  }, []);

  const saveCap = useCallback((equip: string, raw: string) => {
    const val = parseFloat(raw.replace(",", ".")) || 0;
    const next = { ...caps, [equip]: val };
    setCaps(next);
    storage.setItem(LS_CAPS_KEY, next, true);
  }, [caps]);

  const persistCsvRows = useCallback((next: KetRow[] | null) => {
    setCsvRows(next);
    storage.setItem(STORAGE_KEYS.csvRows, next, true);
  }, []);

  const deleteDay = useCallback((date: string) => {
    const removedKeys = new Set((csvRows ?? []).filter(r => extractDate(r.dateNeeded) === date).map(r => r.key));
    const next = (csvRows ?? []).filter(r => !removedKeys.has(r.key));
    // Always check if selectedKey is still valid after deletion
    if (selectedKey && !next.some(r => r.key === selectedKey)) {
      setSelectedKey(null);
    }
    setSelectedWoKeys((current) => {
      if (![...removedKeys].some(k => current.has(k))) return current;
      const nextSel = new Set(current);
      for (const k of removedKeys) nextSel.delete(k);
      return nextSel;
    });
    persistCsvRows(next.length > 0 ? next : null);
  }, [csvRows, selectedKey, persistCsvRows]);

  const deleteWo = useCallback((key: string) => {
    const next = (csvRows ?? []).filter(r => r.key !== key);
    if (selectedKey === key) setSelectedKey(null);
    setSelectedWoKeys((current) => {
      if (!current.has(key)) return current;
      const nextSel = new Set(current);
      nextSel.delete(key);
      return nextSel;
    });
    persistCsvRows(next.length > 0 ? next : null);
  }, [csvRows, selectedKey, persistCsvRows]);

  const toggleWoSelection = useCallback((key: string) => {
    setSelectedWoKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const source = useMemo(
    () => detectSource(
      csvRows,
      productionPlanHasLiveWeek,
      liveWmsRows,
      (data.productionPlan?.rows?.length ?? 0) > 0,
    ),
    [csvRows, productionPlanHasLiveWeek, liveWmsRows, data.productionPlan?.rows?.length],
  );


  // Markiert WOs als "gedruckt/gespeichert" — übersteht CSV-Re-Uploads (siehe
  // PrintedWoCache oben), damit "Alle sichtbaren WOs" nicht versehentlich
  // längst abgearbeitete WOs erneut mit ausdruckt.
  const markAsPrinted = useCallback((rows: KetRow[]) => {
    if (rows.length === 0) return;
    const cache = printedWoCacheRef.current;
    const now = new Date().toISOString();
    for (const row of rows) cache[row.woNumber] = now;
    printedWoCacheRef.current = cache;
    savePrintedWoCache(cache);
    setPrintedWoNumbers({ ...cache });
  }, []);

  // Löscht alle "gedruckt"-Markierungen (z.B. wenn eine neue Produktionswoche beginnt).
  const clearPrintedWoCache = useCallback(() => {
    printedWoCacheRef.current = {};
    storage.setItem(STORAGE_KEYS.printedWoNumbers, null, true);
    setPrintedWoNumbers({});
  }, []);

  const printPdf = useCallback((rows: KetRow[]) => {
    try {
      const title = `KET Breakdown – ${new Date().toLocaleDateString("de-DE")}`;
      const html = buildPdf(rows, calcMap, caps, title, source, woInstructions);
      const w = window.open("", "_blank", "width=960,height=750");
      if (!w) {
        alert("Popup-Blocker hat das Fenster blockiert – bitte erlauben Sie Popups für diese Seite.");
        return;
      }
      w.document.write(html);
      w.document.close();
      setTimeout(() => { w.focus(); w.print(); }, PDF_PRINT_DELAY_MS);
      // Optimistisch markiert (window.print() liefert keinen Abschluss-Callback,
      // dasselbe Limit gilt bereits für den bestehenden Druck-Flow).
      markAsPrinted(rows);
    } catch (error) {
      console.error("[KetBreakdown] Print PDF failed:", error);
      alert(`Fehler beim Drucken: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [calcMap, caps, source, woInstructions, markAsPrinted]);

  const downloadPdf = useCallback(async (rows: KetRow[], suggestedName: string) => {
    let url: string | null = null;
    try {
      const title = suggestedName;
      const html = buildPdf(rows, calcMap, caps, title, source, woInstructions);
      const safe = sanitizeFilename(suggestedName);
      
      const resp = await fetch("/api/local-db/generate-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, filename: safe + ".pdf" }),
      });
      
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` })) as { error?: string };
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      
      const blob = await resp.blob();
      url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = safe + ".pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      markAsPrinted(rows);
    } catch (error) {
      console.error("[KetBreakdown] Download PDF failed:", error);
      setBulkDlError(error instanceof Error ? error.message : String(error));
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }, [calcMap, caps, source, woInstructions, markAsPrinted]);

  // Persistiert neue Instructions im localStorage-Cache und aktualisiert State
  // (targets: WO-Ebene oder einzelne Komponenten, siehe generationTargetsForRow).
  const persistInstructions = useCallback((generated: Record<string, WoInstruction>, targets: GenerationTarget[]) => {
    const cache = instructionCacheRef.current;
    for (const target of targets) {
      const inst = generated[target.key];
      if (inst) cache[target.cacheKey] = inst;
    }
    instructionCacheRef.current = cache;
    saveInstructionCache(cache);
    setWoInstructions((current) => ({ ...current, ...generated }));
  }, []);

  // Löscht den gesamten Instruction-Cache
  const clearInstructionCache = useCallback(() => {
    instructionCacheRef.current = {};
    storage.setItem(STORAGE_KEYS.woInstructions, null, true);
    setWoInstructions({});
    setBatchInstructionStatus("Instruction-Cache geleert");
  }, []);


  // Baut alle Generierungsziele für eine Menge Zeilen — bei zusammengesetzten
  // Sub-Rezepten ein Ziel pro Komponente statt eines pro WO (siehe
  // generationTargetsForRow).
  const targetsForRows = useCallback((rows: KetRow[]): GenerationTarget[] =>
    rows.flatMap((row) => {
      const calc = calcMap.get(row.key);
      return calc ? generationTargetsForRow(row, calc) : [];
    }), [calcMap]);

  const generateInstructionsForSelectedDays = useCallback(async (forceAll = false) => {
    if (instructionRows.length === 0) return;
    const allTargets = targetsForRows(instructionRows);
    // Delta-Logik: nur Ziele ohne bestehende Instruction generieren
    const targetsToGenerate = forceAll ? allTargets : allTargets.filter((t) => !woInstructions[t.key]);
    if (targetsToGenerate.length === 0) {
      setBatchInstructionStatus("Alle WOs haben bereits Instructions (aus Cache)");
      return;
    }
    setBatchInstructionBusy(true);
    const skipped = allTargets.length - targetsToGenerate.length;
    const skipNote = skipped > 0 ? ` (${skipped} aus Cache)` : "";
    setBatchInstructionStatus(`Erzeuge ${targetsToGenerate.length} WO-Instructions${skipNote} …`);
    setFailedInstructions([]);
    try {
      const result = await generateWoInstructionsBatch(targetsToGenerate, (chunkResult, done, total) => {
        persistInstructions(chunkResult.generated, targetsToGenerate);
        setBatchInstructionStatus(`${done} von ${total} WO-Instructions verarbeitet${skipNote} …`);
      });
      persistInstructions(result.generated, targetsToGenerate);
      const genCount = Object.keys(result.generated).length;
      if (result.failed.length > 0) {
        setFailedInstructions(result.failed);
        setBatchInstructionStatus(`${genCount} von ${targetsToGenerate.length} erzeugt · ${result.failed.length} fehlgeschlagen${skipNote}`);
      } else {
        setBatchInstructionStatus(`${genCount} WO-Instructions erzeugt${skipNote}`);
      }
    } catch (error) {
      console.error("[KetBreakdown] Batch instruction generation failed:", error);
      setBatchInstructionStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchInstructionBusy(false);
    }
  }, [instructionRows, targetsForRows, woInstructions, persistInstructions]);

  // Gezielte Instruction-Generierung für per Checkbox ausgewählte WOs (unabhängig von der
  // Tage-Auswahl oben) — gleicher Ablauf wie generateInstructionsForSelectedDays, nur mit
  // selectedWoKeys statt activeInstructionDays als Quelle der zu erzeugenden Zeilen.
  const generateInstructionsForSelection = useCallback(async () => {
    const rowsToGenerate = ketRows.filter((row) => selectedWoKeys.has(row.key));
    const targetsToGenerate = targetsForRows(rowsToGenerate);
    if (targetsToGenerate.length === 0) return;
    setBatchInstructionBusy(true);
    setBatchInstructionStatus(`Erzeuge ${targetsToGenerate.length} WO-Instructions für Auswahl …`);
    setFailedInstructions([]);
    try {
      const result = await generateWoInstructionsBatch(targetsToGenerate, (chunkResult, done, total) => {
        persistInstructions(chunkResult.generated, targetsToGenerate);
        setBatchInstructionStatus(`${done} von ${total} ausgewählten WO-Instructions verarbeitet …`);
      });
      persistInstructions(result.generated, targetsToGenerate);
      const genCount = Object.keys(result.generated).length;
      if (result.failed.length > 0) {
        setFailedInstructions(result.failed);
        setBatchInstructionStatus(`${genCount} von ${targetsToGenerate.length} erzeugt · ${result.failed.length} fehlgeschlagen`);
      } else {
        setBatchInstructionStatus(`${genCount} WO-Instructions für Auswahl erzeugt`);
      }
    } catch (error) {
      console.error("[KetBreakdown] Selection instruction generation failed:", error);
      setBatchInstructionStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchInstructionBusy(false);
    }
  }, [ketRows, selectedWoKeys, targetsForRows, persistInstructions]);

  const retryFailedInstructions = useCallback(async () => {
    if (failedInstructions.length === 0) return;
    setBatchInstructionBusy(true);
    const retryKeys = new Set(failedInstructions.map((f) => f.key));
    const retryItems = targetsForRows(instructionRows).filter((t) => retryKeys.has(t.key));
    setBatchInstructionStatus(`Wiederhole ${retryItems.length} fehlgeschlagene WOs …`);
    try {
      const result = await generateWoInstructionsBatch(retryItems, (chunkResult, done, total) => {
        persistInstructions(chunkResult.generated, retryItems);
        setBatchInstructionStatus(`${done} von ${total} Wiederholungen verarbeitet …`);
      });
      persistInstructions(result.generated, retryItems);
      const genCount = Object.keys(result.generated).length;
      if (result.failed.length > 0) {
        setFailedInstructions(result.failed);
        setBatchInstructionStatus(`${genCount} nachgeholt · ${result.failed.length} weiterhin fehlgeschlagen`);
      } else {
        setFailedInstructions([]);
        setBatchInstructionStatus(`Alle ${genCount} fehlgeschlagenen WOs erfolgreich nachgeholt`);
      }
    } catch (error) {
      setBatchInstructionStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchInstructionBusy(false);
    }
  }, [failedInstructions, instructionRows, targetsForRows, persistInstructions]);
  const totalBatches = weekFilteredRows.reduce((s, row) => s + (calcMap.get(row.key)?.batches ?? 0), 0);

  if (ketRows.length === 0) {
    return (
      <MissingDataScreen
        title="KET-Plan Daten fehlen"
        neededFile="KitchenOS KET-CSV"
        hint="Erwartet: Work Order Number, Recipe Name, Date Needed, Target Portions, Kitchen Status, Staging Status …"
        fileInputRef={fileInputRef}
        onFile={handleFile}
      />
    );
  }

  return (
    <div className="flex min-h-[620px] h-[calc(100vh-64px)] min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">

      {/* ════════════════════════════════════════════════════
          LEFT SIDEBAR
      ════════════════════════════════════════════════════ */}
      <aside className="flex min-h-0 w-[280px] shrink-0 flex-col border-r border-slate-200 overflow-hidden">

        {/* Header */}
        <div className="px-4 pt-4 pb-3 bg-gradient-to-b from-[#0f2240] to-[#1e3a5f]">
          <div className="text-[9px] font-bold text-blue-300 uppercase tracking-[0.15em] mb-1">
            KET Plan · WO Ausdruck
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-white tabular-nums">{weekFilteredRows.length}</span>
            <span className="text-xs text-blue-300">WOs</span>
            {totalBatches > 0 && (
              <>
                <span className="text-blue-600">·</span>
                <span className="text-lg font-black text-blue-200 tabular-nums">{totalBatches}</span>
                <span className="text-xs text-blue-300">Batche</span>
              </>
            )}
          </div>
          {liveWeekNum != null && (
            <button
              type="button"
              title={weekFilterEnabled
                ? `Nur Work Orders mit "${liveWeekNum}-…"-Präfix zeigen (KW ${liveWeek})`
                : "Ungefiltert: Work Orders aller Wochen zeigen"}
              className={`mt-2 w-full rounded-lg px-2 py-1.5 text-[10px] font-bold transition-colors ${weekFilterEnabled ? "bg-blue-600 text-white" : "bg-white/10 text-blue-200 hover:bg-white/20"}`}
              onClick={() => setWeekFilterEnabled((v) => !v)}
            >
              {weekFilterEnabled
                ? `🎯 Nur KW ${liveWeekNum} (${ketRows.length - weekFilteredRows.length} ausgeblendet)`
                : `◯ Alle Wochen (${ketRows.length})`}
            </button>
          )}
          {/* Schicht/Run — beide "später zuschaltbar" (siehe ketRunLogic.ts),
              standardmäßig aus. Run ist eine Schätzung, kein WMS-Fakt. */}
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              title="Schicht-Uhrzeiten (Frühschicht 06-14 / Spätschicht 14-22 Uhr) anzeigen"
              className={`flex-1 rounded-lg px-2 py-1 text-[9px] font-bold transition-colors ${showShifts ? "bg-blue-600 text-white" : "bg-white/10 text-blue-200 hover:bg-white/20"}`}
              onClick={() => setShowShifts((v) => !v)}
            >
              🕒 Schicht
            </button>
            <button
              type="button"
              title="Run 1/2 anzeigen — geschätzt aus kumulierten Wochen-Portionen je Meal, keine WMS-verifizierte Tatsache"
              className={`flex-1 rounded-lg px-2 py-1 text-[9px] font-bold transition-colors ${showRuns ? "bg-amber-600 text-white" : "bg-white/10 text-blue-200 hover:bg-white/20"}`}
              onClick={() => setShowRuns((v) => !v)}
            >
              🔁 Run (Schätzung)
            </button>
          </div>
          {source && (
            <div
              className={`text-[9px] mt-1 font-mono truncate ${source === "LiveWMS" ? "text-amber-300 font-bold" : source === "FirestoreStale" ? "text-red-400 font-bold" : "text-blue-400"}`}
            >
              {source === "CSV"
                ? `✓ ${csvFileName}`
                : source === "Firestore"
                  ? "Quelle: Firestore"
                  : source === "FirestoreStale"
                    ? `⚠ Quelle: Firestore (veraltet – ohne ${liveWeek})`
                    : "Quelle: Live WMS (Snowflake) – Feldzuordnung ungeprüft"}
            </div>
          )}
          {source === "LiveWMS" && wmsDroppedWeeks.length > 0 && (
            <div className="text-[9px] mt-0.5 text-blue-400/70 truncate" title={`Ausgeblendete KWs: ${wmsDroppedWeeks.join(", ")}`}>
              Gefiltert auf {liveWeek}{"/"}Folge-KW · {wmsDroppedWeeks.length} andere KW{wmsDroppedWeeks.length > 1 ? "s" : ""} ausgeblendet
            </div>
          )}
        </div>

        {/* CSV Upload */}
        <div className="px-3 py-2.5 border-b border-slate-100">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            title="KET CSV Datei hochladen"
            aria-label="KET CSV Datei hochladen"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
          <div
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            className={`cursor-pointer rounded-xl border-2 border-dashed px-3 py-2.5 text-center transition-all select-none ${
              dragOver
                ? "border-blue-400 bg-blue-50 scale-[1.01]"
                : csvRows
                  ? "border-emerald-300 bg-emerald-50 hover:bg-emerald-100"
                  : "border-slate-300 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/50"
            }`}
          >
            <div className="text-xs font-bold text-slate-700">
              {csvRows ? `✓ ${csvFileName}` : "KET CSV hochladen"}
            </div>
            <div className="text-[9px] text-slate-400 mt-0.5">
              {csvRows
                ? <span className="text-emerald-600">{csvRows.length} Work Orders geladen</span>
                : "Klicken oder Datei ablegen · .csv"}
            </div>
          </div>
          {csvRows && (
            <button
              type="button"
              onClick={() => {
                setCsvRows(null); setCsvFileName(""); setSelectedKey(null);
                setSelectedWoKeys(new Set());
                try { localStorage.removeItem("ket-csv-rows-v1"); } catch { /* */ }
                try { localStorage.removeItem("ket-csv-filename-v1"); } catch { /* */ }
              }}
              className="mt-1 w-full text-[9px] text-slate-400 hover:text-red-500 transition-colors"
            >
              × CSV entfernen (zurück zu Firestore)
            </button>
          )}
        </div>

        {/* Equipment capacities (collapsible) */}
        <div className="border-b border-slate-100">
          <button
            type="button"
            onClick={() => setShowEquip(!showEquip)}
            className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-bold text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
              Equipment-Kapazitäten
            </span>
            <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${showEquip ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          </button>
          {showEquip && (
            <div className="px-3 pb-3 space-y-1">
              <p className="text-[9px] text-slate-400 mb-2">Effektive Kapazität pro Batch. Bestimmt Anzahl Batche.</p>
              {Object.entries(EQUIP_DEFAULTS).map(([equip]) => (
                <div key={equip} className="flex items-center gap-2">
                  <span className="flex-1 text-[10px] font-semibold text-slate-600 truncate">{EQUIP_LABELS[equip] ?? equip}</span>
                  <input
                    type="number"
                    min={0}
                    step={5}
                    value={capInputs[equip] ?? String(caps[equip] ?? "")}
                    onChange={(e) => setCapInputs((p) => ({ ...p, [equip]: e.target.value }))}
                    onBlur={(e) => saveCap(equip, e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveCap(equip, (e.target as HTMLInputElement).value)}
                    aria-label={`${equip} capacity kg`}
                    className="w-14 text-right text-xs font-bold border border-slate-200 rounded-lg px-1.5 py-1 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                  />
                  <span className="text-[9px] text-slate-400 w-4">kg</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-slate-100">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" d="m21 21-4.35-4.35"/></svg>
            <input
              type="search"
              placeholder="WO, Rezept, Sub-Rezept …"
              value={woSearch}
              onChange={(e) => setWoSearch(e.target.value)}
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 focus:bg-white"
            />
          </div>
        </div>

        {/* WO Sort */}
        <div className="px-3 py-1.5 border-b border-slate-100 flex flex-wrap gap-1">
          {([ ["date","Datum"], ["wo","WO Nr"], ["recipe","Rezept"], ["status","Status"], ["batches","Batche↓"], ["kg","KG↓"] ] as [WoSortMode, string][]).map(([mode, label]) => (
            <button key={mode} type="button" onClick={() => setWoSortMode(mode)}
              className={`text-[9px] font-bold px-2 py-0.5 rounded-md border transition-colors ${
                woSortMode === mode
                  ? "bg-[#1e3a5f] text-white border-[#1e3a5f]"
                  : "bg-white text-slate-500 border-slate-200 hover:border-blue-300 hover:text-blue-700"
              }`}>
              {label}
            </button>
          ))}
        </div>

        {/* Tag-Filter für WO-Liste */}
        {groups.length > 1 && (
          <div className="border-b border-slate-100 px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Tag-Filter</span>
              {selectedDayFilter && (
                <button type="button" onClick={() => setSelectedDayFilter(null)} className="text-[9px] font-bold text-blue-600 hover:text-blue-800">Alle</button>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {groups.map(([day]) => {
                const active = !selectedDayFilter || selectedDayFilter.has(day);
                return (
                  <button key={day} type="button"
                    onClick={() => setSelectedDayFilter((current) => {
                      if (!current) {
                        // Erster Klick: nur diesen Tag auswählen
                        return new Set([day]);
                      }
                      const next = new Set(current);
                      if (next.has(day)) {
                        next.delete(day);
                        // Wenn alle abgewählt: Filter aufheben
                        return next.size === 0 ? null : next;
                      } else {
                        next.add(day);
                        return next;
                      }
                    })}
                    className={`rounded-md px-1.5 py-1 text-[9px] font-bold transition-colors ${
                      active
                        ? "bg-[#1e3a5f] text-white"
                        : "bg-white text-slate-400 ring-1 ring-slate-200 hover:ring-blue-300"
                    }`}>
                    {day.slice(8)}.{day.slice(5, 7)}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Instruction-Tage */}
        <div className="border-b border-slate-100 bg-emerald-50/60 px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[9px] font-black uppercase tracking-widest text-emerald-800">Instruction-Tage</span>
            <button type="button" onClick={() => setSelectedInstructionDays(null)} className="text-[9px] font-bold text-emerald-700 hover:text-emerald-900">Alle</button>
          </div>
          <div className="flex flex-wrap gap-1">
            {availableInstructionDays.map((day) => {
              const selected = !selectedInstructionDays || selectedInstructionDays.has(day);
              return <button key={day} type="button" onClick={() => setSelectedInstructionDays((current) => {
                if (!current) return new Set([day]);
                const next = new Set(current);
                if (next.has(day)) {
                  next.delete(day);
                  return next.size === 0 ? null : next;
                }
                next.add(day);
                return next;
              })} className={`rounded-md px-1.5 py-1 text-[9px] font-bold ${selected ? "bg-emerald-700 text-white" : "bg-white text-slate-400 ring-1 ring-slate-200"}`}>
                {day.slice(8)}.{day.slice(5, 7)}
              </button>;
            })}
          </div>
          <button type="button" disabled={batchInstructionBusy || instructionRows.length === 0} onClick={() => void generateInstructionsForSelectedDays()} className="mt-2 w-full rounded-lg bg-emerald-700 px-2 py-2 text-[10px] font-black text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50">
            {batchInstructionBusy
              ? "Instructions werden erzeugt …"
              : (() => {
                  // Zählt Ziele (targets), nicht WO-Zeilen: eine zusammengesetzte
                  // WO hat mehrere Instructions (eine je Komponente) — row.key
                  // allein trägt für sie nie eine Instruction (siehe woInstructions).
                  const targets = targetsForRows(instructionRows);
                  const cached = targets.filter((t) => woInstructions[t.key]).length;
                  const newCount = targets.length - cached;
                  return newCount > 0
                    ? `${newCount} neue Kochanweisungen erzeugen${cached > 0 ? ` (${cached} aus Cache)` : ""}`
                    : `Alle ${targets.length} Kochanweisungen vorhanden`;
                })()
            }
          </button>
          {!batchInstructionBusy && Object.keys(woInstructions).length > 0 && (
            <div className="mt-1 flex gap-1">
              <button type="button" onClick={() => void generateInstructionsForSelectedDays(true)} className="flex-1 rounded bg-slate-200 px-1.5 py-1 text-[9px] font-semibold text-slate-600 hover:bg-slate-300">
                Alle neu generieren
              </button>
              <button type="button" onClick={clearInstructionCache} className="rounded bg-red-100 px-1.5 py-1 text-[9px] font-semibold text-red-700 hover:bg-red-200">
                Cache leeren
              </button>
            </div>
          )}
          {batchInstructionStatus && <div className="mt-1 text-[9px] font-semibold text-emerald-800">{batchInstructionStatus}</div>}
          {failedInstructions.length > 0 && !batchInstructionBusy && (
            <div className="mt-1">
              <button type="button" onClick={() => void retryFailedInstructions()} className="w-full rounded-lg bg-amber-600 px-2 py-1.5 text-[10px] font-bold text-white hover:bg-amber-700">
                {failedInstructions.length} fehlgeschlagene WOs erneut versuchen
              </button>
              <details className="mt-1">
                <summary className="cursor-pointer text-[9px] text-red-700 font-semibold">Fehlgeschlagene WOs anzeigen</summary>
                <ul className="mt-0.5 space-y-0.5 text-[8px] text-red-600 max-h-24 overflow-y-auto">
                  {failedInstructions.map((f) => <li key={f.key}>WO {f.woNumber}{f.componentName ? ` · ${f.componentName}` : ""}: {f.error}</li>)}
                </ul>
              </details>
            </div>
          )}
        </div>

        {/* WO-Mehrfachauswahl (Checkboxen unten in der Liste) — unabhängig von Instruction-Tagen */}
        {selectedWoKeys.size > 0 && (
          <div className="border-b border-slate-100 bg-blue-50/60 px-3 py-2 flex items-center gap-2">
            <span className="flex-1 text-[10px] font-black text-blue-800">{selectedWoKeys.size} WOs ausgewählt</span>
            <button
              type="button"
              disabled={batchInstructionBusy}
              onClick={() => void generateInstructionsForSelection()}
              className="rounded-lg bg-blue-700 px-2 py-1.5 text-[9px] font-black text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Instructions für Auswahl erzeugen
            </button>
            <button
              type="button"
              onClick={() => setSelectedWoKeys(new Set())}
              className="rounded-lg bg-slate-200 px-2 py-1.5 text-[9px] font-bold text-slate-600 hover:bg-slate-300"
            >
              Auswahl aufheben
            </button>
          </div>
        )}

        {/* WO List */}
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {filteredGroups.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400">Keine WOs gefunden</div>
          ) : (
            filteredGroups.map(([date, rows]) => (
              <div key={date} className="mb-1">
                <div className="sticky top-0 px-3 py-1.5 bg-slate-50/90 backdrop-blur-sm border-y border-slate-100 z-10 flex items-center justify-between gap-1">
                  <div>
                    <span className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
                      {fmtDateHeader(date)}
                    </span>
                    <span className="ml-2 text-[9px] text-slate-300">{rows.length} WOs</span>
                  </div>
                  {csvRows !== null && (
                    <button type="button" onClick={() => deleteDay(date)}
                      title="Alle WOs dieses Tages löschen"
                      className="text-[9px] font-bold text-red-400 hover:text-red-600 transition-colors px-1 shrink-0">
                      Tag ×
                    </button>
                  )}
                </div>
                <div className="px-2 py-1 space-y-1">
                  {rows.map((row) => {
                    const calc = calcMap.get(row.key);
                    const isSelected = selectedKey === row.key;
                    const isChecked = selectedWoKeys.has(row.key);
                    const sc = statusColors(row.kitchenStatus);
                    const done = row.woCookedPortions ?? 0;
                    const pct = row.targetPortions > 0 ? (done / row.targetPortions) * 100 : 0;
                    return (
                      <div key={row.key} className="flex items-stretch gap-1">
                        <label
                          className="flex shrink-0 items-center px-1 cursor-pointer"
                          title="Für Mehrfachauswahl markieren"
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleWoSelection(row.key)}
                            className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700 focus:ring-blue-500"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => setSelectedKey(row.key)}
                          className={`min-w-0 flex-1 text-left rounded-xl px-3 py-2.5 transition-all ${
                            isSelected
                              ? "bg-[#1e3a5f] shadow-md ring-2 ring-[#1e3a5f]/30"
                              : "bg-white hover:bg-slate-50 border border-slate-150 shadow-sm hover:shadow"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-1 mb-1">
                            <span className={`text-[11px] font-black leading-tight ${isSelected ? "text-white" : "text-[#1e3a5f]"}`}>
                              WO {row.woNumber}
                              {printedWoNumbers[row.woNumber] && (
                                <span
                                  className={`ml-1 text-[9px] font-black ${isSelected ? "text-emerald-300" : "text-emerald-600"}`}
                                  title={`Bereits gedruckt/gespeichert am ${new Date(printedWoNumbers[row.woNumber]).toLocaleString("de-DE")}`}
                                >
                                  ✓
                                </span>
                              )}
                            </span>
                            <div className="flex items-center gap-1 shrink-0">
                              {calc && calc.batches > 0 && (
                                <span
                                  className={`text-[9px] font-black px-1.5 py-0.5 rounded-md ${isSelected ? "bg-white/20 text-white" : "bg-blue-100 text-blue-700"}`}
                                  title={calc.primaryCapBibleMatch
                                    ? `Batche berechnet mit Kuechenbible-Kapazität "${calc.primaryCapBibleMatch.itemName}" (provisorisch)`
                                    : undefined}
                                >
                                  {calc.primaryCapBibleMatch && <span aria-hidden="true">📖 </span>}
                                  {calc.batches}×
                                </span>
                              )}
                              {calc && calc.totalKg > 0 && (
                                <span className={`text-[9px] tabular-nums ${isSelected ? "text-blue-300" : "text-slate-400"}`}>
                                  {fmtKg(calc.totalKg)}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className={`text-[10px] truncate leading-tight ${isSelected ? "text-blue-200" : "text-slate-600"} flex items-center gap-1`}>
                            {row.subRecipeName || row.recipeName}
                            <LiveBadge recipeCode={row.recipeCode} />
                            {showRuns && runAssignments.get(row.key) && (
                              <span
                                className="shrink-0 text-[8px] font-black px-1 py-0.5 rounded bg-amber-500/20 text-amber-700"
                                title={runAssignments.get(row.key)!.isSplit
                                  ? `Geschätzt: ${Math.round(runAssignments.get(row.key)!.cumulativeSharePct * 100)}% des Wochenvolumens dieses Meals bis einschließlich diesem Tag — keine WMS-verifizierte Tatsache`
                                  : "Nur ein Produktionstag diese Woche — kein echter Run-Split"}
                              >
                                🔁 Run {runAssignments.get(row.key)!.run}
                              </span>
                            )}
                            {calc?.chillerAssignment && (
                              <span
                                className="shrink-0 text-[8px] font-black px-1 py-0.5 rounded"
                                style={{ background: `${calc.chillerAssignment.cfg.cntBg}30`, color: calc.chillerAssignment.cfg.cntBg }}
                                title={calc.chillerAssignment.unknown
                                  ? "Blast Chiller: keine Allergen-Daten gefunden — Zuteilung ungesichert, bitte manuell prüfen"
                                  : `Blast Chiller: ${calc.chillerAssignment.cfg.label} (${calc.chillerAssignment.cfg.sub})`}
                              >
                                ❄️{calc.chillerAssignment.key}{calc.chillerAssignment.unknown ? "⚠" : ""}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span
                              className={`text-[8px] font-semibold ${isSelected ? "text-blue-300" : "text-slate-400"}`}
                              title={showShifts ? shiftLabel(row.shift) ?? undefined : undefined}
                            >
                              {showShifts && shiftLabel(row.shift) ? shiftLabel(row.shift) : `Shift ${row.dateNeeded.match(/[-–]\s*(\d+)$/)?.[1] ?? "—"}`}
                            </span>
                            <span className={`text-[8px] font-semibold px-1.5 py-0.5 rounded-md ${isSelected ? `${sc.bg} ${sc.text}` : `${sc.bg} ${sc.text}`}`}>
                              {row.kitchenStatus || "—"}
                            </span>
                            {pct > 0 && (
                              <div className={`flex-1 h-1 rounded-full overflow-hidden ${isSelected ? "bg-white/20" : "bg-slate-100"}`}>
                                <div
                                  className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-emerald-500" : "bg-blue-400"}`}
                                  style={{ width: `${Math.min(100, pct)}%` }}
                                />
                              </div>
                            )}
                          </div>
                        </button>
                        {csvRows !== null && (
                          <button
                            type="button"
                            onClick={() => deleteWo(row.key)}
                            title="Diese WO löschen"
                            className="shrink-0 self-center w-6 h-6 flex items-center justify-center rounded-lg bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 transition-colors text-sm font-bold"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Drucken + Speichern */}
        <div className="px-3 py-2.5 border-t border-slate-100 space-y-1.5 bg-slate-50/50">
          {/* Ausgewählte WO */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => selectedRow && printPdf([selectedRow])}
              disabled={!selectedRow}
              title="Druckdialog öffnen"
              className="flex items-center justify-center gap-1.5 text-[10px] font-bold bg-[#1e3a5f] hover:bg-[#162d4a] disabled:opacity-30 disabled:cursor-not-allowed text-white py-2 rounded-xl transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
              Drucken
            </button>
            <button
              type="button"
              disabled={!selectedRow}
              title="Als PDF-Datei speichern (1 WO = 1 Seite)"
              onClick={() => {
                if (!selectedRow) return;
                void downloadPdf([selectedRow], woFilename(selectedRow));
              }}
              className="flex items-center justify-center gap-1.5 text-[10px] font-bold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-30 disabled:cursor-not-allowed text-white py-2 rounded-xl transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              Speichern
            </button>
          </div>
          <div className="text-[8px] text-slate-400 text-center -mt-0.5">Ausgewählte WO</div>

          {/* Alle / gefilterte WOs — bereits gedruckte/gespeicherte WOs werden
              standardmäßig übersprungen (siehe markAsPrinted), damit ein
              erneuter CSV-Upload (der immer alte + neue WOs gemischt enthält)
              nicht versehentlich alles nochmal ausdruckt. Nur nach explizitem
              Häkchen werden sie erneut mit eingeschlossen. */}
          {(() => {
            const newBulkRows = bulkPrintRows.filter((r) => !printedWoNumbers[r.woNumber]);
            const alreadyPrintedCount = bulkPrintRows.length - newBulkRows.length;
            const effectiveBulkRows = includeAlreadyPrinted ? bulkPrintRows : newBulkRows;
            return (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => printPdf(effectiveBulkRows)}
                    disabled={effectiveBulkRows.length === 0}
                    title="Druckdialog – alle sichtbaren, noch nicht gedruckten WOs (je WO eine Seite)"
                    className="flex items-center justify-center gap-1.5 text-[10px] font-bold bg-white hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed text-slate-600 py-2 rounded-xl transition-colors border border-slate-200"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
                    Drucken
                  </button>
                  <button
                    type="button"
                    disabled={effectiveBulkRows.length === 0 || bulkDlBusy}
                    title="Jede sichtbare, noch nicht gedruckte WO als eigene PDF-Datei speichern"
                    onClick={async () => {
                      const rows = effectiveBulkRows;
                      setBulkDlBusy(true);
                      setBulkDlError(null);
                      setBulkDlStatus(null);
                      const failed: string[] = [];
                      for (let i = 0; i < rows.length; i++) {
                        const row = rows[i];
                        setBulkDlStatus(`${i + 1} von ${rows.length} gespeichert …`);
                        try {
                          await downloadPdf([row], woFilename(row));
                        } catch (error) {
                          console.error(`[KetBreakdown] Download failed for WO ${row.woNumber}:`, error);
                          failed.push(row.woNumber);
                        }
                      }
                      setBulkDlStatus(null);
                      setBulkDlError(failed.length > 0 ? `${failed.length} von ${rows.length} fehlgeschlagen: WO ${failed.join(", ")}` : null);
                      setBulkDlBusy(false);
                    }}
                    className="flex items-center justify-center gap-1.5 text-[10px] font-bold bg-emerald-50 hover:bg-emerald-100 disabled:opacity-30 disabled:cursor-not-allowed text-emerald-800 py-2 rounded-xl transition-colors border border-emerald-200"
                  >
                    {bulkDlBusy ? (
                      <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                    ) : (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
                    )}
                    Speichern
                  </button>
                </div>
                <div className="text-[8px] text-slate-400 text-center -mt-0.5">
                  {alreadyPrintedCount > 0
                    ? `${newBulkRows.length} neue WOs${includeAlreadyPrinted ? ` + ${alreadyPrintedCount} bereits gedruckte` : ""}`
                    : `Alle sichtbaren (${bulkPrintRows.length}) WOs`}
                </div>
                {alreadyPrintedCount > 0 && (
                  <label className="flex items-center justify-center gap-1.5 text-[9px] font-semibold text-slate-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeAlreadyPrinted}
                      onChange={(e) => setIncludeAlreadyPrinted(e.target.checked)}
                      className="h-3 w-3 rounded border-slate-300"
                    />
                    {alreadyPrintedCount} bereits gedruckte auch einschließen
                  </label>
                )}
                {alreadyPrintedCount > 0 && (
                  <button type="button" onClick={clearPrintedWoCache}
                    className="w-full text-[8px] text-slate-300 hover:text-red-500 transition-colors">
                    × Alle "gedruckt"-Markierungen zurücksetzen
                  </button>
                )}
              </>
            );
          })()}
          {bulkDlStatus && (
            <div className="text-[9px] text-emerald-700 font-semibold text-center">
              {bulkDlStatus}
            </div>
          )}
          {bulkDlError && (
            <div className="text-[9px] text-red-600 font-semibold bg-red-50 rounded-lg px-2 py-1.5 border border-red-200">
              {bulkDlError}
            </div>
          )}
        </div>
      </aside>

      {/* ════════════════════════════════════════════════════
          RIGHT DETAIL AREA
      ════════════════════════════════════════════════════ */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50/30 overflow-hidden">
        {/* Detail / Alle WOs toggle — its own bar so it stays visible
            regardless of mode and survives selecting/deselecting a WO. */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-2 bg-gradient-to-r from-[#0f2240] via-[#1e3a5f] to-[#0f2240] border-b border-white/10">
          <div className="flex rounded-xl overflow-hidden border border-white/20">
            <button
              type="button"
              onClick={() => setMainViewMode("detail")}
              className={`text-[10px] font-bold px-3 py-2 transition-colors ${mainViewMode === "detail" ? "bg-white/20 text-white" : "text-white/60 hover:text-white hover:bg-white/10"}`}
            >
              Detail
            </button>
            <button
              type="button"
              onClick={() => setMainViewMode("list")}
              className={`text-[10px] font-bold px-3 py-2 transition-colors ${mainViewMode === "list" ? "bg-white/20 text-white" : "text-white/60 hover:text-white hover:bg-white/10"}`}
            >
              Alle WOs
            </button>
            <button
              type="button"
              onClick={() => setMainViewMode("equipment")}
              className={`text-[10px] font-bold px-3 py-2 transition-colors ${mainViewMode === "equipment" ? "bg-white/20 text-white" : "text-white/60 hover:text-white hover:bg-white/10"}`}
            >
              Equipment
            </button>
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {mainViewMode === "equipment" ? (
            <KetEquipmentPanel
              rows={ketRows}
              calcMap={calcMap}
              runAssignments={runAssignments}
            />
          ) : mainViewMode === "list" ? (
            <KetWoOverview
              groups={filteredGroups}
              calcMap={calcMap}
              selectedKey={selectedKey}
              onSelect={(key) => { setSelectedKey(key); setMainViewMode("detail"); }}
              printedWoNumbers={printedWoNumbers}
              runAssignments={showRuns ? runAssignments : undefined}
            />
          ) : !selectedRow ? (
            <EmptyState />
          ) : (
            <WoDetail
              row={selectedRow}
              calc={selectedCalc}
              onPrint={() => printPdf([selectedRow])}
              onCapChange={saveCap}
              instruction={woInstructions[selectedRow.key]}
              onGenerateInstruction={async () => {
                if (!selectedCalc) throw new Error("Keine Berechnung für diese WO vorhanden");
                const instruction = await generateWoInstruction(selectedRow, selectedCalc);
                persistInstructions({ [selectedRow.key]: instruction }, [{ key: selectedRow.key, cacheKey: instructionCacheKey(selectedRow), row: selectedRow, calc: selectedCalc }]);
              }}
              onInstructionEdit={(updated) => {
                if (!selectedCalc) return;
                persistInstructions({ [selectedRow.key]: updated }, [{ key: selectedRow.key, cacheKey: instructionCacheKey(selectedRow), row: selectedRow, calc: selectedCalc }]);
              }}
              componentInstructions={Object.fromEntries(
                (selectedCalc?.components ?? [])
                  .map((c) => [c.name, woInstructions[`${selectedRow.key}::${c.name}`]] as const)
                  .filter((entry): entry is [string, WoInstruction] => !!entry[1]),
              )}
              onGenerateComponentInstruction={async (component) => {
                if (!selectedCalc) throw new Error("Keine Berechnung für diese WO vorhanden");
                const instruction = await generateWoInstruction(selectedRow, selectedCalc, component);
                const target: GenerationTarget = {
                  key: `${selectedRow.key}::${component.name}`,
                  cacheKey: instructionCacheKey(selectedRow, component.name),
                  row: selectedRow,
                  calc: selectedCalc,
                  component,
                };
                persistInstructions({ [target.key]: instruction }, [target]);
              }}
              onComponentInstructionEdit={(component, updated) => {
                if (!selectedCalc) return;
                const target: GenerationTarget = {
                  key: `${selectedRow.key}::${component.name}`,
                  cacheKey: instructionCacheKey(selectedRow, component.name),
                  row: selectedRow,
                  calc: selectedCalc,
                  component,
                };
                persistInstructions({ [target.key]: updated }, [target]);
              }}
              onGenerateAllComponentInstructions={async () => {
                if (!selectedCalc) throw new Error("Keine Berechnung für diese WO vorhanden");
                // Dedupliziert bereits gleichnamige Komponenten (z.B. wiederholte
                // Zubereitungsschritte im selben Baum, siehe generationTargetsForRow).
                const allTargets = generationTargetsForRow(selectedRow, selectedCalc);
                const missing = allTargets.filter((t) => !woInstructions[t.key]);
                // Sind schon alle erzeugt, erzeugt der Button bewusst ALLE neu
                // (gleiche "erneut erzeugen"-Konvention wie die Einzel-Buttons).
                const toGenerate = missing.length > 0 ? missing : allTargets;
                const result = await generateWoInstructionsBatch(toGenerate);
                persistInstructions(result.generated, toGenerate);
                if (result.failed.length > 0) {
                  throw new Error(`${result.failed.length} von ${toGenerate.length} Kochanweisungen fehlgeschlagen: ${result.failed.map((f) => f.componentName ?? f.woNumber).join(", ")}`);
                }
              }}
              onDownload={async () => {
                if (!selectedRow) return;
                await downloadPdf([selectedRow], woFilename(selectedRow));
              }}
              manualEquipment={manualEquipment[selectedRow.key]}
              onManualEquipmentChange={(override) => {
                setManualEquipment((current) => {
                  const next = { ...current };
                  if (override) next[selectedRow.key] = override;
                  else delete next[selectedRow.key];
                  return next;
                });
              }}
              componentManualEquipment={componentManualEquipment[selectedRow.key]}
              onComponentManualEquipmentChange={(componentName, override) => {
                setComponentManualEquipment((current) => {
                  const rowMap = { ...(current[selectedRow.key] ?? {}) };
                  if (override) rowMap[componentName] = override;
                  else delete rowMap[componentName];
                  const next = { ...current };
                  if (Object.keys(rowMap).length > 0) next[selectedRow.key] = rowMap;
                  else delete next[selectedRow.key];
                  return next;
                });
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────
