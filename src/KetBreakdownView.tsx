// KetBreakdownView.tsx – KET Plan → WO Breakdown → PDF
// Upload KET CSV directly; falls back to data.productionPlan.
// Equipment capacities are user-editable, saved to localStorage.

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { DataBundle, WorkOrderEntry } from "./core/types";
import { fetchWmsWorkorderCache, wmsWorkorderRowToEntry, filterRowsToWeekWindow, currentHfWeek } from "./lib/wmsCache";
import { weekNumFromHfWeek, weekPrefixFromWoNumber } from "./features/wms-overview/wmsWeeks";
import { EQUIP_DEFAULTS, EQUIP_LABELS, LS_CAPS_KEY, type BatchCalc, type KetRow, type ManualEquipmentOverride, type WoInstruction, type WoSortMode } from "./features/ket-plan/ketTypes";
import {
  calcBatch, fmtDateHeader, fmtKg, parseKetCsv, parseSortKey, statusColors, woEntriesToKetRows,
} from "./features/ket-plan/ketLogic";
import { buildPdf } from "./features/ket-plan/ketPdf";
import { EmptyState, KetWoOverview, MissingDataScreen } from "./features/ket-plan/KetSharedUi";
import { WoDetail } from "./features/ket-plan/KetWoDetail";
import { generateWoInstruction, generateWoInstructionsBatch } from "./features/ket-plan/woInstructionBot";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

const STORAGE_KEYS = {
  csvRows: "ket-csv-rows-v1",
  csvFilename: "ket-csv-filename-v1",
} as const;

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
  const [mainViewMode, setMainViewMode] = useState<"detail" | "list">("detail");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [woSortMode, setWoSortMode] = useState<WoSortMode>("date");
  const [liveWmsRows, setLiveWmsRows] = useState<WorkOrderEntry[] | null>(null);
  const [wmsDroppedWeeks, setWmsDroppedWeeks] = useState<string[]>([]);
  const [weekFilterEnabled, setWeekFilterEnabled] = useState(true);

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
  const [woInstructions, setWoInstructions] = useState<Record<string, WoInstruction>>({});
  const [selectedDayFilter, setSelectedDayFilter] = useState<Set<string> | null>(null);
  const [selectedInstructionDays, setSelectedInstructionDays] = useState<Set<string> | null>(null);
  const [batchInstructionBusy, setBatchInstructionBusy] = useState(false);
  const [batchInstructionStatus, setBatchInstructionStatus] = useState<string | null>(null);
  const [failedInstructions, setFailedInstructions] = useState<Array<{ key: string; woNumber: string; error: string }>>([]);
  const [bulkDlBusy, setBulkDlBusy] = useState(false);

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
    for (const row of ketRows) m.set(row.key, calcBatch(row, caps, data, manualEquipment[row.key]));
    return m;
  }, [ketRows, caps, data, manualEquipment]);

  const liveWeekNum = useMemo(() => weekNumFromHfWeek(liveWeek), [liveWeek]);
  const weekFilteredRows = useMemo(() => {
    if (!weekFilterEnabled || liveWeekNum == null) return ketRows;
    return ketRows.filter((row) => weekPrefixFromWoNumber(row.woNumber) === liveWeekNum);
  }, [ketRows, weekFilterEnabled, liveWeekNum]);

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
      .sort((a, b) => parseSortKey(a[0]) - parseSortKey(b[0]));
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
        const parsed = parseKetCsv(text);
        if (!parsed || parsed.length === 0) {
          alert("Die CSV-Datei ist leer oder konnte nicht gelesen werden.");
          return;
        }
        setCsvRows(parsed);
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
    const next = (csvRows ?? []).filter(r => extractDate(r.dateNeeded) !== date);
    // Always check if selectedKey is still valid after deletion
    if (selectedKey && !next.some(r => r.key === selectedKey)) {
      setSelectedKey(null);
    }
    persistCsvRows(next.length > 0 ? next : null);
  }, [csvRows, selectedKey, persistCsvRows]);

  const deleteWo = useCallback((key: string) => {
    const next = (csvRows ?? []).filter(r => r.key !== key);
    if (selectedKey === key) setSelectedKey(null);
    persistCsvRows(next.length > 0 ? next : null);
  }, [csvRows, selectedKey, persistCsvRows]);

  const source = useMemo(
    () => detectSource(
      csvRows,
      productionPlanHasLiveWeek,
      liveWmsRows,
      (data.productionPlan?.rows?.length ?? 0) > 0,
    ),
    [csvRows, productionPlanHasLiveWeek, liveWmsRows, data.productionPlan?.rows?.length],
  );


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
    } catch (error) {
      console.error("[KetBreakdown] Print PDF failed:", error);
      alert(`Fehler beim Drucken: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [calcMap, caps, source, woInstructions]);

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
    } catch (error) {
      console.error("[KetBreakdown] Download PDF failed:", error);
      setBulkDlError(error instanceof Error ? error.message : String(error));
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }, [calcMap, caps, source, woInstructions]);

  const generateInstructionsForSelectedDays = useCallback(async () => {
    if (instructionRows.length === 0) return;
    setBatchInstructionBusy(true);
    setBatchInstructionStatus(`Erzeuge ${instructionRows.length} WO-Instructions …`);
    setFailedInstructions([]);
    try {
      const result = await generateWoInstructionsBatch(instructionRows.map((row) => ({
        key: row.key,
        row,
        calc: calcMap.get(row.key)!,
      })).filter((item) => item.calc), (chunkResult, done, total) => {
        setWoInstructions((current) => ({ ...current, ...chunkResult.generated }));
        setBatchInstructionStatus(`${done} von ${total} WO-Instructions verarbeitet …`);
      });
      const genCount = Object.keys(result.generated).length;
      if (result.failed.length > 0) {
        setFailedInstructions(result.failed);
        setBatchInstructionStatus(`${genCount} von ${instructionRows.length} erzeugt · ${result.failed.length} fehlgeschlagen`);
      } else {
        setBatchInstructionStatus(`Alle ${genCount} WO-Instructions erfolgreich erzeugt`);
      }
    } catch (error) {
      console.error("[KetBreakdown] Batch instruction generation failed:", error);
      setBatchInstructionStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchInstructionBusy(false);
    }
  }, [instructionRows, calcMap]);

  const retryFailedInstructions = useCallback(async () => {
    if (failedInstructions.length === 0) return;
    setBatchInstructionBusy(true);
    const retryKeys = new Set(failedInstructions.map((f) => f.key));
    const retryItems = instructionRows
      .filter((row) => retryKeys.has(row.key))
      .map((row) => ({ key: row.key, row, calc: calcMap.get(row.key)! }))
      .filter((item) => item.calc);
    setBatchInstructionStatus(`Wiederhole ${retryItems.length} fehlgeschlagene WOs …`);
    try {
      const result = await generateWoInstructionsBatch(retryItems, (chunkResult, done, total) => {
        setWoInstructions((current) => ({ ...current, ...chunkResult.generated }));
        setBatchInstructionStatus(`${done} von ${total} Wiederholungen verarbeitet …`);
      });
      setWoInstructions((current) => ({ ...current, ...result.generated }));
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
  }, [failedInstructions, instructionRows, calcMap]);
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
            {batchInstructionBusy ? "Instructions werden erzeugt …" : `Instructions für ${instructionRows.length} WOs erzeugen`}
          </button>
          {batchInstructionStatus && <div className="mt-1 text-[9px] font-semibold text-emerald-800">{batchInstructionStatus}</div>}
          {failedInstructions.length > 0 && !batchInstructionBusy && (
            <div className="mt-1">
              <button type="button" onClick={() => void retryFailedInstructions()} className="w-full rounded-lg bg-amber-600 px-2 py-1.5 text-[10px] font-bold text-white hover:bg-amber-700">
                {failedInstructions.length} fehlgeschlagene WOs erneut versuchen
              </button>
              <details className="mt-1">
                <summary className="cursor-pointer text-[9px] text-red-700 font-semibold">Fehlgeschlagene WOs anzeigen</summary>
                <ul className="mt-0.5 space-y-0.5 text-[8px] text-red-600 max-h-24 overflow-y-auto">
                  {failedInstructions.map((f) => <li key={f.key}>WO {f.woNumber}: {f.error}</li>)}
                </ul>
              </details>
            </div>
          )}
        </div>

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
                    const sc = statusColors(row.kitchenStatus);
                    const done = row.woCookedPortions ?? 0;
                    const pct = row.targetPortions > 0 ? (done / row.targetPortions) * 100 : 0;
                    return (
                      <div key={row.key} className="flex items-stretch gap-1">
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
                          <div className={`text-[10px] truncate leading-tight ${isSelected ? "text-blue-200" : "text-slate-600"}`}>
                            {row.subRecipeName || row.recipeName}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className={`text-[8px] font-semibold ${isSelected ? "text-blue-300" : "text-slate-400"}`}>
                              Shift {row.dateNeeded.match(/[-–]\s*(\d+)$/)?.[1] ?? "—"}
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
                const name = `WO_${selectedRow.woNumber}_${selectedRow.subRecipeName || selectedRow.recipeName}`;
                void downloadPdf([selectedRow], name);
              }}
              className="flex items-center justify-center gap-1.5 text-[10px] font-bold bg-emerald-700 hover:bg-emerald-800 disabled:opacity-30 disabled:cursor-not-allowed text-white py-2 rounded-xl transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              Speichern
            </button>
          </div>
          <div className="text-[8px] text-slate-400 text-center -mt-0.5">Ausgewählte WO</div>

          {/* Alle / gefilterte WOs */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => printPdf(filteredRows.length > 0 ? filteredRows : weekFilteredRows)}
              disabled={weekFilteredRows.length === 0}
              title="Druckdialog – alle sichtbaren WOs (je WO eine Seite)"
              className="flex items-center justify-center gap-1.5 text-[10px] font-bold bg-white hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed text-slate-600 py-2 rounded-xl transition-colors border border-slate-200"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
              Drucken
            </button>
            <button
              type="button"
              disabled={weekFilteredRows.length === 0 || bulkDlBusy}
              title="Alle sichtbaren WOs als eine mehrseitige PDF speichern (je WO = 1 Seite)"
              onClick={async () => {
                const rows = filteredRows.length > 0 ? filteredRows : weekFilteredRows;
                setBulkDlBusy(true);
                setBulkDlError(null);
                try {
                  const dateTag = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }).replace(".", "");
                  await downloadPdf(rows, `KET_Breakdown_${dateTag}_${rows.length}WOs`);
                } catch (error) {
                  setBulkDlError(error instanceof Error ? error.message : String(error));
                } finally {
                  setBulkDlBusy(false);
                }
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
            Alle sichtbaren ({filteredRows.length > 0 ? filteredRows.length : weekFilteredRows.length}) WOs
          </div>
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
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {mainViewMode === "list" ? (
            <KetWoOverview
              groups={filteredGroups}
              calcMap={calcMap}
              selectedKey={selectedKey}
              onSelect={(key) => { setSelectedKey(key); setMainViewMode("detail"); }}
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
                setWoInstructions((current) => ({ ...current, [selectedRow.key]: instruction }));
              }}
              onDownload={async () => {
                if (!selectedRow) return;
                const name = `WO_${selectedRow.woNumber}_${selectedRow.subRecipeName || selectedRow.recipeName}`;
                await downloadPdf([selectedRow], name);
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
            />
          )}
        </div>
      </main>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────
