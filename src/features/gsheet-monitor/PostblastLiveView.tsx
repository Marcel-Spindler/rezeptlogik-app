// Postblast Live View — Echtzeit-Dashboard: GSheet-Wiegungen vs. geplante Work Orders.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { DataBundle, WorkOrderEntry } from "../../core/types";
import { useEtMonitor, usePostblastMonitor, useRtiMonitor } from "./useGSheetMonitor";
import { matchPostblastToWorkOrders, type BackfillNeed, type WoMatchedStatus } from "./postblastMatch";
import { findEquipmentForSubRecipe } from "./backfillGenerator";
import { analyzeProduction, type AlertSeverity } from "./productionAgent";
import { respondToChat, type ChatMessage, type ChatContext } from "./postblastChat";
import { fmt, fmtMass } from "../whatif/whatIfFormat";
import { currentHfWeek } from "../../lib/hfWeek";
import { weekNumFromHfWeek, weekPrefixFromWoNumber } from "../wms-overview/wmsWeeks";
import { fetchWmsWorkorderCache, filterRowsToWeekWindow, wmsWorkorderRowToEntry } from "../../lib/wmsCache";
import { parseKetCsv } from "../ket-plan/ketLogic";
import type { KetRow } from "../ket-plan/ketTypes";
import { parseExportRecipesCsv, recipeWeightKey, type RecipeWeightLookup } from "./parsers/parseExportRecipes";

// ─── Typen ───────────────────────────────────────────────────────────────────

interface WoSnapshot { ts: string; actual: Record<string, number>; }

// ─── localStorage-Verlauf ────────────────────────────────────────────────────

function useWoHistory(matched: WoMatchedStatus[], week: string) {
  const key = `pb_hist_${week}`;
  const [snaps, setSnaps] = useState<WoSnapshot[]>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; }
  });
  const lastRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (matched.length === 0) return;
    const cur: Record<string, number> = {};
    let changed = Object.keys(lastRef.current).length === 0;
    for (const m of matched) {
      cur[m.workOrder] = m.actualKg;
      if (!changed && Math.abs((lastRef.current[m.workOrder] ?? -1) - m.actualKg) > 0.05) changed = true;
    }
    if (!changed) return;
    lastRef.current = cur;
    const snap: WoSnapshot = { ts: new Date().toISOString(), actual: cur };
    setSnaps(prev => {
      const next = [...prev.slice(-199), snap];
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [matched, key]);

  const firstSeen = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of snaps) {
      for (const [wo, kg] of Object.entries(s.actual)) {
        if (kg > 0 && !map.has(wo)) map.set(wo, s.ts);
      }
    }
    return map;
  }, [snaps]);

  const shiftStartActual = useMemo(() => snaps[0]?.actual ?? {}, [snaps]);

  const clear = () => { localStorage.removeItem(key); setSnaps([]); };

  return { firstSeen, shiftStartActual, snapCount: snaps.length, clear };
}

// ─── Primitive Komponenten ───────────────────────────────────────────────────

function ProgressBar({ pct, size = "md", color }: { pct: number; size?: "xs" | "sm" | "md" | "lg"; color?: string }) {
  const h = size === "lg" ? "h-4" : size === "sm" ? "h-2" : size === "xs" ? "h-1.5" : "h-3";
  const auto = pct >= 95 ? "bg-emerald-500" : pct >= 60 ? "bg-sky-500" : pct >= 30 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className={`w-full ${h} rounded-full bg-slate-200 overflow-hidden`}>
      <div
        className={`${h} rounded-full ${color ?? auto} transition-all duration-700`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

function PriorityBadge({ priority }: { priority: BackfillNeed["priority"] }) {
  const cls =
    priority === "critical" ? "bg-red-100 text-red-700 ring-1 ring-red-300" :
    priority === "behind" ? "bg-amber-100 text-amber-700 ring-1 ring-amber-300" :
    "bg-emerald-100 text-emerald-700";
  const label = priority === "critical" ? "⚠ KRITISCH" : priority === "behind" ? "HINTER PLAN" : "OK";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${cls}`}>{label}</span>;
}

function AlertIcon({ severity }: { severity: AlertSeverity }) {
  if (severity === "critical") return <span className="text-red-600 text-base leading-none">●</span>;
  if (severity === "warning") return <span className="text-amber-500 text-base leading-none">●</span>;
  if (severity === "info") return <span className="text-sky-500 text-base leading-none">●</span>;
  return <span className="text-emerald-500 text-base leading-none">●</span>;
}

function StatusBadge({ wo }: { wo: WoMatchedStatus }) {
  if (!wo.hasPlan)
    return (
      <span
        title="Diese WO ist im System (ET/WMS/KET), hat aber noch kein Mengen-Soll — Fortschritt kann nicht bewertet werden"
        className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 ring-1 ring-slate-300 font-bold"
      >
        ○ OHNE PLAN
      </span>
    );
  const estTitle = wo.isEstimated ? " — Sollmenge GESCHÄTZT aus Portionen × Rezept-Gewicht, kein echtes Firestore-Soll" : "";
  const estSuffix = wo.isEstimated ? " ≈" : "";
  if (wo.isComplete)
    return <span title={`Fertig${estTitle}`} className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200 font-bold">✓ FERTIG{estSuffix}</span>;
  if (wo.isCritical)
    return <span title={`Kritisch${estTitle}`} className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 ring-1 ring-red-200 font-bold">⚠ KRITISCH{estSuffix}</span>;
  return <span title={`Läuft${estTitle}`} className="text-[10px] px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 ring-1 ring-sky-200 font-bold">LÄUFT{estSuffix}</span>;
}

function WoDots({ wos }: { wos: WoMatchedStatus[] }) {
  return (
    <div className="flex flex-wrap gap-1 mt-1.5 ml-5">
      {wos.map(wo => (
        <div
          key={wo.workOrder}
          title={!wo.hasPlan ? `${wo.workOrder}: ${wo.subRecipe} (ohne Plan-Soll)` : `${wo.workOrder}: ${wo.subRecipe} (${Math.round(wo.progressPct)}%)`}
          className={`w-3 h-3 rounded-full border-2 border-white shadow-sm ${
            !wo.hasPlan ? "bg-white ring-1 ring-slate-300" :
            wo.isComplete ? "bg-emerald-400" :
            wo.isCritical ? "bg-red-500 animate-pulse" :
            wo.progressPct >= 60 ? "bg-sky-400" :
            wo.progressPct >= 20 ? "bg-amber-400" : "bg-slate-300"
          }`}
        />
      ))}
    </div>
  );
}

// Ziel-Portionen × Gramm/Portion (aus export-recipes.csv) = geschätzte Ziel-
// menge in kg. null, wenn für dieses Sub-Rezept kein Gewicht bekannt ist oder
// keine Portionenzahl vorliegt — dann bleibt die WO "OHNE PLAN" statt eine
// erfundene Zahl zu zeigen.
function estimatePlannedKg(
  recipeWeights: RecipeWeightLookup | null,
  recipeCode: string,
  subRecipe: string,
  targetPortions: number | undefined | null
): number | null {
  if (!recipeWeights || !targetPortions || targetPortions <= 0) return null;
  const grams = recipeWeights.gramsPerPortion.get(recipeWeightKey(recipeCode, subRecipe));
  if (grams == null) return null;
  return (grams * targetPortions) / 1000;
}

// ─── Hauptkomponente ─────────────────────────────────────────────────────────

export function PostblastLiveView({ data }: { data: DataBundle }): JSX.Element {
  const monitor = usePostblastMonitor();
  const rtiMonitor = useRtiMonitor();
  const etMonitor = useEtMonitor();

  // Live-WMS-Cache (wmsCache/workorders, siehe scripts/sync-wms-cache.ts) — der
  // gleiche Fallback, den KetBreakdownView schon nutzt, wenn der Firestore-Plan
  // für die aktuelle Woche leer ist. Liefert echte Portionen/Sub-Rezept-Namen
  // direkt aus dem WMS (Snowflake-Pull), nur eben (noch) ohne kg-Ziel — siehe
  // wmsWorkorderRowToEntry. Wird nur einmal beim Laden abgefragt, nicht gepollt.
  const [liveWmsRows, setLiveWmsRows] = useState<WorkOrderEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchWmsWorkorderCache().then(res => {
      if (cancelled || !res?.rows.length) return;
      const { kept } = filterRowsToWeekWindow(res.rows, currentHfWeek());
      const mapped = kept.reduce<WorkOrderEntry[]>((acc, row) => {
        try { acc.push(wmsWorkorderRowToEntry(row)); }
        catch (error) { console.warn("[PostblastLive] Skipping malformed WMS row:", error); }
        return acc;
      }, []);
      if (!cancelled && mapped.length) setLiveWmsRows(mapped);
    }).catch(error => {
      if (!cancelled) console.error("[PostblastLive] Failed to fetch WMS workorder cache:", error);
    });
    return () => { cancelled = true; };
  }, []);

  // ── Manuelle Datei-Uploads: schließen die kg-Lücke, die weder ET noch der
  // Live-WMS-Cache füllen können (beide liefern keine Zielmenge). Zwei Dateien:
  // 1) KET-CSV (dieselbe, die "KET Plan / WO" nutzt — Storage-Key bewusst
  //    identisch, damit ein dort schon hochgeladener Plan hier sofort mitgilt)
  //    liefert echte Ziel-Portionen je WO.
  // 2) "export-recipes*.csv" liefert Gramm/Portion je Sub-Rezept. Portionen ×
  //    Gramm/Portion = GESCHÄTZTE Ziel-Menge — keine echte Firestore-Zahl,
  //    daher überall als "isEstimated" markiert (siehe postblastMatch.ts).
  const KET_CSV_STORAGE_KEY = "ket-csv-rows-v1";
  const RECIPE_WEIGHTS_STORAGE_KEY = "pb_recipe_weights_v1";

  const [ketCsvRows, setKetCsvRows] = useState<KetRow[] | null>(() => {
    try { const raw = localStorage.getItem(KET_CSV_STORAGE_KEY); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  });
  const [ketCsvFileName, setKetCsvFileName] = useState("");
  const [recipeWeights, setRecipeWeights] = useState<RecipeWeightLookup | null>(() => {
    try {
      const raw = localStorage.getItem(RECIPE_WEIGHTS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { entries: [string, number][]; recipeCount: number; rowCount: number };
      return { gramsPerPortion: new Map(parsed.entries), recipeCount: parsed.recipeCount, rowCount: parsed.rowCount };
    } catch { return null; }
  });
  const [recipeWeightsFileName, setRecipeWeightsFileName] = useState("");
  const ketFileInputRef = useRef<HTMLInputElement>(null);
  const recipeWeightsFileInputRef = useRef<HTMLInputElement>(null);

  function handleKetCsvFile(file: File) {
    setKetCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = typeof e.target?.result === "string" ? e.target.result : "";
      if (!text) { alert("Fehler beim Lesen der Datei."); return; }
      try {
        const { rows } = parseKetCsv(text);
        if (!rows.length) { alert("Die CSV-Datei ist leer oder konnte nicht gelesen werden."); return; }
        setKetCsvRows(rows);
        try { localStorage.setItem(KET_CSV_STORAGE_KEY, JSON.stringify(rows)); } catch { /* quota */ }
      } catch (error) {
        alert(`Fehler beim Verarbeiten der KET-CSV: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    reader.onerror = () => alert("Fehler beim Lesen der Datei.");
    reader.readAsText(file, "utf-8");
  }

  function handleRecipeWeightsFile(file: File) {
    setRecipeWeightsFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = typeof e.target?.result === "string" ? e.target.result : "";
      if (!text) { alert("Fehler beim Lesen der Datei."); return; }
      try {
        const lookup = parseExportRecipesCsv(text);
        if (lookup.gramsPerPortion.size === 0) { alert("Keine Portions-Gewichte in dieser Datei gefunden."); return; }
        setRecipeWeights(lookup);
        try {
          localStorage.setItem(RECIPE_WEIGHTS_STORAGE_KEY, JSON.stringify({
            entries: [...lookup.gramsPerPortion.entries()],
            recipeCount: lookup.recipeCount,
            rowCount: lookup.rowCount,
          }));
        } catch { /* quota */ }
      } catch (error) {
        alert(`Fehler beim Verarbeiten der Rezept-Gewichte: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    reader.onerror = () => alert("Fehler beim Lesen der Datei.");
    reader.readAsText(file, "utf-8");
  }

  // ── Wochen-Auswahl ──
  // productionPlan.rows bündelt Work Orders aus ALLEN in Firestore vorhandenen
  // Wochen-Docs (siehe dataSource.ts) — kann aber hinterherhinken, wenn für die
  // aktuelle KW noch kein Plan-Doc importiert wurde. Tab "ET" (GSheet) und der
  // Live-WMS-Cache sind die vom WMS live gepflegten Master-WO-Listen über
  // mehrere Wochen hinweg und schließen genau diese Lücke. Alle drei Quellen
  // zusammen ergeben die tatsächlich im System vorhandenen Wochen. Die WO-
  // Nummer selbst trägt serverseitig immer die KW als Präfix ("35-222" =
  // KW35, siehe weekPrefixFromWoNumber) — zuverlässiger als jedes freie
  // "week"-Feld.
  const woCountByWeekNum = useMemo(() => {
    const byWeek = new Map<number, Set<string>>();
    const add = (wo: string) => {
      const n = weekPrefixFromWoNumber(wo);
      if (n == null) return;
      if (!byWeek.has(n)) byWeek.set(n, new Set());
      byWeek.get(n)!.add(wo);
    };
    for (const r of data.productionPlan?.rows ?? []) add(r.workOrder);
    for (const e of etMonitor.data?.entries ?? []) add(e.workOrder);
    for (const r of liveWmsRows ?? []) add(r.workOrder);
    for (const r of ketCsvRows ?? []) add(r.woNumber);
    const counts = new Map<number, number>();
    for (const [wk, set] of byWeek) counts.set(wk, set.size);
    return counts;
  }, [data.productionPlan, etMonitor.data, liveWmsRows, ketCsvRows]);

  // "Tote Karteileichen" (uralte WO-Reste, die irgendwo im Sheet hängen bleiben)
  // sollen die Wochenauswahl nicht zumüllen — nur ein plausibles Fenster um die
  // reale Kalenderwoche herum zulassen (2 Monate zurück, 3 Monate voraus).
  const allowedWeekNums = useMemo(() => {
    const center = weekNumFromHfWeek(currentHfWeek()) ?? 1;
    const set = new Set<number>();
    for (let d = -8; d <= 12; d++) set.add(((center - 1 + d) % 52 + 52) % 52 + 1);
    return set;
  }, []);

  const weekOptions = useMemo(() => {
    const labels = new Set<string>();
    for (const w of data.weeks) {
      const n = weekNumFromHfWeek(w);
      if (n != null && woCountByWeekNum.has(n) && allowedWeekNums.has(n)) labels.add(w);
    }
    // Wochen, die ET/Plan schon kennen, die aber noch nicht im "weeks"-Katalog
    // stehen (z.B. eine ganz frische KW) — Label mit dem Jahr der aktuellen
    // HF-Woche synthetisieren, damit sie trotzdem wählbar ist.
    const refYear = currentHfWeek().match(/^(\d{4})/)?.[1];
    for (const n of woCountByWeekNum.keys()) {
      if (!allowedWeekNums.has(n)) continue;
      if ([...labels].some(w => weekNumFromHfWeek(w) === n)) continue;
      if (refYear) labels.add(`${refYear}-W${String(n).padStart(2, "0")}`);
    }
    return [...labels].sort();
  }, [data.weeks, woCountByWeekNum, allowedWeekNums]);

  // Das RTI-Sheet trägt seine eigene, live vom Menschen im Sheet gepflegte KW
  // ("KW 34" in Spalte A) — das ist die verlässlichste Quelle dafür, welche
  // Woche gerade WIRKLICH auf der Schicht läuft, unabhängig davon, welcher
  // Firestore-Plan-Doc zufällig "der neueste" ist.
  const rtiWeekNum = useMemo(
    () => (rtiMonitor.data ? weekNumFromHfWeek(rtiMonitor.data.week) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur der week-Wert ist relevant, nicht die Objektidentität
    [rtiMonitor.data?.week]
  );

  // ET/RTI treffen erst nach ihrem ersten Poll ein (~1-2s nach dem Laden), der
  // Firestore-Plan dagegen sofort — ein Default, der beim allerersten Tick fix
  // "einrastet", würde also auf der (u.U. veralteten) Plan-Woche hängen bleiben,
  // sobald ET/RTI kurz danach eine bessere Woche liefern. Deshalb bleibt die
  // Auswahl im "Auto"-Modus (folgt RTI/aktueller KW), bis der Mensch selbst am
  // Dropdown dreht — erst dann "rastet" die Auswahl endgültig ein.
  const userPickedWeekRef = useRef(false);
  const [selectedWeek, setSelectedWeek] = useState("");
  useEffect(() => {
    if (weekOptions.length === 0) return;
    setSelectedWeek(prev => {
      if (userPickedWeekRef.current && prev && weekOptions.includes(prev)) return prev;
      if (rtiWeekNum != null) {
        const rtiMatch = weekOptions.find(w => weekNumFromHfWeek(w) === rtiWeekNum);
        if (rtiMatch) return rtiMatch;
      }
      const hf = currentHfWeek();
      if (weekOptions.includes(hf)) return hf;
      const planWeek = data.productionPlan?.week;
      if (planWeek && weekOptions.includes(planWeek)) return planWeek;
      if (prev && weekOptions.includes(prev)) return prev;
      return weekOptions[weekOptions.length - 1];
    });
  }, [weekOptions, rtiWeekNum, data.productionPlan?.week]);

  function handleSelectWeek(w: string) {
    userPickedWeekRef.current = true;
    setSelectedWeek(w);
  }

  const selectedWeekNum = selectedWeek ? weekNumFromHfWeek(selectedWeek) : null;

  // Effektiver Plan für die gewählte Woche, gestaffelt nach Vertrauenswürdigkeit
  // — genau die Kette, die KetBreakdownView für dasselbe Problem schon nutzt,
  // plus eine kg-Schätzung on top:
  // 1) Firestore-Plan-Zeilen (einzige Quelle mit echtem kg-Soll)
  // 2) Hochgeladene KET-CSV (echte Ziel-Portionen je WO, manuell aktuell gehalten)
  // 3) Live-WMS-Cache (echte Portionen/Sub-Rezept-Namen direkt aus dem WMS)
  // 4) ET-Master-Liste (nur Recipe/Sub-Rezept-Identität, keine Portionen)
  // Jede Stufe ergänzt nur WOs, die die vorherige noch nicht kennt, damit eine
  // schwächere Quelle eine stärkere nie überschreibt. Für Stufe 2+3 (mit
  // Portionen) wird — falls Rezept-Gewichte hochgeladen sind — eine kg-Schätzung
  // berechnet (Portionen × Gramm/Portion) und als "isEstimated" markiert; ohne
  // Portionen (Stufe 4) oder ohne Rezept-Gewichte bleibt die WO "OHNE PLAN".
  const { filteredProductionPlan, unplannedWorkOrders, estimatedWorkOrders } = useMemo(() => {
    const allRows = data.productionPlan?.rows ?? [];
    const baseRows = selectedWeekNum == null
      ? allRows
      : allRows.filter(r => weekPrefixFromWoNumber(r.workOrder) === selectedWeekNum);

    const known = new Set(baseRows.map(r => r.workOrder));
    const gapRows: WorkOrderEntry[] = [];
    const unplanned = new Set<string>();
    const estimated = new Set<string>();

    function addGapRow(row: WorkOrderEntry, targetPortions: number | undefined | null) {
      if (known.has(row.workOrder) || weekPrefixFromWoNumber(row.workOrder) !== selectedWeekNum) return;
      known.add(row.workOrder);
      const kgEstimate = estimatePlannedKg(recipeWeights, row.recipeCode, row.subRecipe, targetPortions);
      if (kgEstimate != null) {
        estimated.add(row.workOrder);
        gapRows.push({ ...row, postKg: kgEstimate });
      } else {
        unplanned.add(row.workOrder);
        gapRows.push(row);
      }
    }

    if (selectedWeekNum != null) {
      for (const r of ketCsvRows ?? []) {
        addGapRow({
          run: 1,
          kitchenDay: r.dateNeeded,
          workOrder: r.woNumber,
          recipeId: r.recipeId,
          recipeCode: r.recipeCode,
          recipeName: r.recipeName,
          subRecipe: r.subRecipeName,
          plannedMeals: r.targetPortions,
          targetPortions: r.targetPortions,
          stagingKg: 0,
          kitchenKg: 0,
          postKg: 0,
          yieldPct: 0,
          cookMethods: r.cookMethods.join(", "),
          stagingStatus: r.stagingStatus,
          kitchenStatus: r.kitchenStatus,
        }, r.targetPortions);
      }
      for (const r of liveWmsRows ?? []) {
        addGapRow(r, r.targetPortions ?? r.plannedMeals);
      }
      for (const e of etMonitor.data?.entries ?? []) {
        addGapRow({
          run: 1,
          kitchenDay: e.cookingDay,
          workOrder: e.workOrder,
          recipeCode: e.recipeCode,
          recipeName: e.recipeName,
          subRecipe: e.subRecipeName,
          plannedMeals: 0,
          stagingKg: 0,
          kitchenKg: 0,
          postKg: 0,
          yieldPct: 0,
        }, null);
      }
    }

    const plan = (baseRows.length === 0 && gapRows.length === 0)
      ? data.productionPlan
      : {
        week: selectedWeek || (data.productionPlan?.week ?? ""),
        generatedAt: data.productionPlan?.generatedAt ?? "",
        rows: [...baseRows, ...gapRows],
      };
    return { filteredProductionPlan: plan, unplannedWorkOrders: unplanned, estimatedWorkOrders: estimated };
  }, [data.productionPlan, etMonitor.data, liveWmsRows, ketCsvRows, recipeWeights, selectedWeek, selectedWeekNum]);

  const week = filteredProductionPlan?.week ?? "—";

  // Wiegungen, deren WO-Nummer auf eine ANDERE KW als die ausgewählte zeigt —
  // z.B. Nachzügler vom Vortag/Vorwoche im selben Sheet-Tab. Diese tauchen in
  // dieser Ansicht bewusst nicht als Fortschritt auf; wir zeigen aber, dass es
  // sie gibt, damit nichts "unsichtbar verschwindet".
  const offWeekWeighingCount = useMemo(() => {
    if (selectedWeekNum == null) return 0;
    let n = 0;
    for (const e of monitor.data?.entries ?? []) {
      const wn = weekPrefixFromWoNumber(e.workOrder);
      if (wn != null && wn !== selectedWeekNum) n++;
    }
    return n;
  }, [monitor.data, selectedWeekNum]);

  const rtiWeekMismatch = rtiWeekNum != null && selectedWeekNum != null && rtiWeekNum !== selectedWeekNum;

  // ── State ──
  const [expandedMeals, setExpandedMeals] = useState<Set<string>>(new Set());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [liveFeedSearch, setLiveFeedSearch] = useState("");
  const [liveFeedToday, setLiveFeedToday] = useState(true);
  const [backfillFilter, setBackfillFilter] = useState<"all" | "critical" | "behind">("all");
  const [mealFilter, setMealFilter] = useState<"all" | "critical" | "running" | "done">("all");
  const [shiftEndHours, setShiftEndHours] = useState(8);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // ── Daten ──
  const { matched, meals, backfill } = useMemo(
    () => matchPostblastToWorkOrders(monitor.data, filteredProductionPlan, rtiMonitor.data, unplannedWorkOrders, estimatedWorkOrders),
    [monitor.data, filteredProductionPlan, rtiMonitor.data, unplannedWorkOrders, estimatedWorkOrders]
  );
  const intelligence = useMemo(
    () => analyzeProduction(monitor.data, meals, backfill, filteredProductionPlan, shiftEndHours),
    [monitor.data, meals, backfill, filteredProductionPlan, shiftEndHours]
  );
  const todayEntries = useMemo(
    () => (monitor.data?.entries ?? []).filter(e => e.date === todayStr),
    [monitor.data, todayStr]
  );
  const liveEntries = useMemo(() => {
    const all = monitor.data?.entries ?? [];
    let list = liveFeedToday ? all.filter(e => e.date === todayStr) : [...all];
    if (liveFeedSearch.trim()) {
      const s = liveFeedSearch.toLowerCase();
      list = list.filter(e => e.workOrder.toLowerCase().includes(s) || e.subRecipeName.toLowerCase().includes(s));
    }
    return [...list].reverse().slice(0, 60);
  }, [monitor.data, liveFeedToday, liveFeedSearch, todayStr]);

  const filteredBackfill = useMemo(() => {
    if (backfillFilter === "critical") return backfill.filter(b => b.priority === "critical");
    if (backfillFilter === "behind") return backfill.filter(b => b.priority === "behind");
    return backfill;
  }, [backfill, backfillFilter]);

  // ── Verlauf ──
  const { firstSeen, shiftStartActual, snapCount, clear: clearHistory } = useWoHistory(matched, week);

  // ── Bündelungs-Gruppen: gleiche Sub-Rezepte fehlen in mehreren Meals ──
  const bundleGroups = useMemo(() => {
    const map = new Map<string, typeof backfill>();
    for (const b of backfill) {
      if (!map.has(b.subRecipe)) map.set(b.subRecipe, []);
      map.get(b.subRecipe)!.push(b);
    }
    return [...map.entries()]
      .filter(([, items]) => items.length > 1)
      .sort((a, b) => b[1].reduce((s, x) => s + x.missingKg, 0) - a[1].reduce((s, x) => s + x.missingKg, 0));
  }, [backfill]);

  // ── Chargen-Map: grobe Batch-Schätzung je bestehender WO (rein informativ) ──
  const batchMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of matched) {
      if (m.plannedKg <= 0) continue;
      const woEntry = filteredProductionPlan?.rows.find(r => r.workOrder === m.workOrder);
      const { capacityKg } = findEquipmentForSubRecipe(m.subRecipe, woEntry?.cookMethods, data.equipmentBible);
      map.set(m.workOrder, Math.max(1, Math.ceil(m.plannedKg / (capacityKg > 0 ? capacityKg : 100))));
    }
    return map;
  }, [matched, filteredProductionPlan, data.equipmentBible]);

  // ── Sets & Filter ──
  const backfillByWo = useMemo(() => new Map(backfill.map(b => [b.workOrder, b])), [backfill]);

  const filteredMeals = useMemo(() => {
    if (mealFilter === "critical") return meals.filter(m => m.criticalWOs.length > 0);
    if (mealFilter === "running") return meals.filter(m => m.completedWOs < m.totalWOs && m.criticalWOs.length === 0);
    if (mealFilter === "done") return meals.filter(m => m.completedWOs === m.totalWOs);
    return meals;
  }, [meals, mealFilter]);

  // ── Summary ──
  const totalPlanned = meals.reduce((s, m) => s + m.totalPlannedKg, 0);
  const totalActual = meals.reduce((s, m) => s + m.totalActualKg, 0);
  const overallPct = totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;
  const mealCritical = meals.filter(m => m.criticalWOs.length > 0).length;
  const mealDone = meals.filter(m => m.completedWOs === m.totalWOs).length;
  const mealRunning = meals.length - mealCritical - mealDone;
  const shiftDeltaKg = totalActual - Object.values(shiftStartActual).reduce((s, v) => s + v, 0);
  const unplannedCount = matched.filter(m => !m.hasPlan).length;
  const estimatedCount = matched.filter(m => m.isEstimated).length;

  const lastUpdate = monitor.lastUpdate
    ? new Date(monitor.lastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  // ── Chat Scroll ──
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);
  useEffect(() => {
    if (chatOpen) setTimeout(() => chatPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  }, [chatOpen]);

  // ── Handler ──
  function toggleMeal(code: string) {
    setExpandedMeals(prev => { const n = new Set(prev); n.has(code) ? n.delete(code) : n.add(code); return n; });
  }

  function buildCtx(): ChatContext {
    return { meals, backfill, intelligence, matched, todayEntries };
  }

  function handleChat(e: FormEvent) {
    e.preventDefault();
    const input = chatInput.trim();
    if (!input) return;
    setChatInput("");
    const response = respondToChat(input, buildCtx());
    setChatMessages(prev => [...prev, { role: "user", text: input }, { role: "agent", text: response }]);
    if (!chatOpen) setChatOpen(true);
  }

  function handleQuickChat(prompt: string) {
    const response = respondToChat(prompt, buildCtx());
    setChatMessages(prev => [...prev, { role: "user", text: prompt }, { role: "agent", text: response }]);
    setChatOpen(true);
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    await monitor.forceRefresh();
    setTimeout(() => setIsRefreshing(false), 1000);
  }

  function scrollToMeal(recipeCode: string) {
    setExpandedMeals(prev => new Set([...prev, recipeCode]));
    setMealFilter("all");
    setTimeout(() => {
      document.getElementById(`meal-${recipeCode}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 150);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 pb-8">

      {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
      <div className="card p-6 bg-gradient-to-br from-teal-600 to-cyan-700 text-white border-0 shadow-lg">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2.5 h-2.5 rounded-full ${monitor.isPolling ? "bg-emerald-300 animate-pulse" : "bg-slate-400"}`} />
              <span className="text-sm font-medium text-teal-100">{monitor.isPolling ? `Live · ${lastUpdate}` : "Offline"}</span>
              {snapCount > 0 && <span className="text-xs text-teal-200/70">· {snapCount} Snapshots</span>}
              <span
                title={rtiMonitor.data ? "RTI-Sheet verbunden — Status & vorbereitete Backfill-WOs werden abgeglichen" : "RTI-Sheet noch nicht geladen — Backfill-Logik nutzt nur Gewichts-Schätzung"}
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 ${
                  rtiMonitor.data ? "bg-emerald-400/20 text-emerald-200 ring-emerald-400/40" : "bg-white/10 text-teal-200/60 ring-white/20"
                }`}
              >
                {rtiMonitor.data ? "● RTI abgeglichen" : "○ RTI wartet"}
              </span>
              <span
                title={etMonitor.data ? "ET-Master-WO-Liste verbunden — liefert die live im WMS angelegten WOs über mehrere Wochen hinweg, auch wenn der Produktionsplan für eine Woche noch fehlt" : "ET-Sheet noch nicht geladen — Wochenauswahl nutzt bislang nur den Produktionsplan"}
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 ${
                  etMonitor.data ? "bg-emerald-400/20 text-emerald-200 ring-emerald-400/40" : "bg-white/10 text-teal-200/60 ring-white/20"
                }`}
              >
                {etMonitor.data ? "● ET abgeglichen" : "○ ET wartet"}
              </span>
              <span
                title={liveWmsRows ? "Live-WMS-Cache verbunden — ergänzt echte Portionen/Sub-Rezept-Namen für WOs, die im Produktionsplan noch fehlen" : "Live-WMS-Cache noch nicht geladen oder leer"}
                className={`text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 ${
                  liveWmsRows ? "bg-emerald-400/20 text-emerald-200 ring-emerald-400/40" : "bg-white/10 text-teal-200/60 ring-white/20"
                }`}
              >
                {liveWmsRows ? "● WMS abgeglichen" : "○ WMS wartet"}
              </span>
              {rtiWeekMismatch && (
                <button
                  onClick={() => {
                    const match = weekOptions.find(w => weekNumFromHfWeek(w) === rtiWeekNum);
                    if (match) setSelectedWeek(match);
                  }}
                  title="Das RTI-Sheet meldet aktuell eine andere Kalenderwoche als hier ausgewählt — anklicken zum Wechseln"
                  className="text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 bg-red-400/25 text-red-100 ring-red-300/50 hover:bg-red-400/40 transition"
                >
                  ⚠ RTI meldet KW{rtiWeekNum} — wechseln
                </button>
              )}
              {offWeekWeighingCount > 0 && (
                <span
                  title="Wiegungen mit einer WO-Nummer aus einer anderen Kalenderwoche als der ausgewählten — werden hier bewusst nicht mitgezählt"
                  className="text-[10px] px-2 py-0.5 rounded-full font-bold ring-1 bg-amber-400/20 text-amber-100 ring-amber-400/40"
                >
                  ⚠ {offWeekWeighingCount} Wiegung{offWeekWeighingCount === 1 ? "" : "en"} andere KW ausgeblendet
                </span>
              )}
            </div>
            <h1 className="text-3xl font-bold">Postblast Live Monitor</h1>
            <p className="mt-1 text-sm text-teal-100/80">
              {week} · {meals.length} Meals · {matched.length} WOs · Echtzeit-Wiegungen vs. Produktionsplan
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleRefresh()}
                disabled={isRefreshing}
                className="px-3 py-1.5 rounded-full text-xs bg-white/20 hover:bg-white/30 text-white ring-1 ring-white/30 transition disabled:opacity-50 font-medium"
              >
                {isRefreshing ? "⟳ Lädt…" : "⟳ Refresh"}
              </button>
              {weekOptions.length > 0 && (
                <select
                  value={selectedWeek}
                  onChange={e => handleSelectWeek(e.target.value)}
                  title="Angezeigte Woche — Produktionsplan enthält WOs aus mehreren Wochen, hier filtern"
                  className="text-xs px-2 py-1.5 rounded-full bg-white/20 text-white ring-1 ring-white/30 border-0 font-medium"
                >
                  {weekOptions.map(w => {
                    const n = weekNumFromHfWeek(w);
                    const count = n != null ? woCountByWeekNum.get(n) ?? 0 : 0;
                    return <option key={w} value={w} className="text-slate-900">{w} · {count} WOs</option>;
                  })}
                </select>
              )}
              <select
                value={shiftEndHours}
                onChange={e => setShiftEndHours(Number(e.target.value))}
                className="text-xs px-2 py-1.5 rounded-full bg-white/20 text-white ring-1 ring-white/30 border-0"
              >
                {[6, 7, 8, 9, 10, 12].map(h => <option key={h} value={h} className="text-slate-900">Schicht {h} h</option>)}
              </select>
            </div>
            {monitor.error && (
              <div className="px-3 py-1 rounded-full bg-red-400/30 ring-1 ring-red-300 text-red-100 text-xs">{monitor.error}</div>
            )}
          </div>
        </div>

        {/* Gesamtfortschritt */}
        <div className="mt-5">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="font-bold text-white">Gesamtfortschritt</span>
            <div className="flex items-center gap-3 text-teal-100">
              {shiftDeltaKg > 0.5 && snapCount > 1 && (
                <span className="text-emerald-300 font-medium text-xs">+{fmt(shiftDeltaKg, 1)} kg seit Schichtstart</span>
              )}
              <span className="font-mono font-bold text-white">
                {totalPlanned > 0 ? `${fmt(overallPct, 1)}%` : "— kein Soll"}
              </span>
              <span className="text-xs text-teal-200/70">{fmtMass(totalActual * 1000)} / {fmtMass(totalPlanned * 1000)}</span>
            </div>
          </div>
          <div className="w-full h-4 rounded-full bg-white/20 overflow-hidden">
            <div
              className={`h-4 rounded-full transition-all duration-700 ${
                overallPct >= 95 ? "bg-emerald-400" : overallPct >= 60 ? "bg-sky-300" : overallPct >= 30 ? "bg-amber-400" : "bg-red-400"
              }`}
              style={{ width: `${Math.min(overallPct, 100)}%` }}
            />
          </div>
        </div>

        {/* Stat-Tiles */}
        <div className="mt-4 grid grid-cols-4 md:grid-cols-8 gap-2">
          {([
            { label: "Meals", value: meals.length, sub: "gesamt", color: "text-white", bg: "bg-white/15", onClick: undefined as (() => void) | undefined },
            { label: "WOs", value: matched.length, sub: "gesamt", color: "text-white", bg: "bg-white/15", onClick: undefined as (() => void) | undefined },
            { label: "WO Fertig", value: matched.filter(m => m.isComplete).length, sub: `von ${matched.length}`, color: "text-emerald-300", bg: "bg-emerald-500/20", onClick: (() => setMealFilter("done")) as (() => void) | undefined },
            { label: "Kritisch", value: backfill.filter(b => b.priority === "critical").length, sub: "WOs", color: "text-red-300", bg: "bg-red-500/20", onClick: (() => setMealFilter("critical")) as (() => void) | undefined },
            { label: "Meals kritisch", value: mealCritical, sub: "Meals", color: "text-orange-300", bg: "bg-orange-500/20", onClick: (() => setMealFilter("critical")) as (() => void) | undefined },
            { label: "Meals fertig", value: mealDone, sub: `von ${meals.length}`, color: "text-emerald-300", bg: "bg-emerald-500/20", onClick: (() => setMealFilter("done")) as (() => void) | undefined },
            { label: "≈ Geschätzt", value: estimatedCount, sub: "Soll aus Portionen", color: "text-amber-300", bg: "bg-amber-500/20", onClick: undefined as (() => void) | undefined },
            { label: "Ohne Plan", value: unplannedCount, sub: "kein Soll bekannt", color: "text-slate-300", bg: "bg-white/10", onClick: undefined as (() => void) | undefined },
          ]).map(s => (
            <button
              key={s.label}
              onClick={s.onClick}
              disabled={!s.onClick}
              className={`${s.bg} rounded-xl p-2.5 text-center ${s.onClick ? "hover:bg-white/25 transition cursor-pointer" : "cursor-default"}`}
            >
              <div className="text-[10px] text-white/60 uppercase font-bold tracking-wide">{s.label}</div>
              <div className={`text-xl font-bold font-mono ${s.color}`}>{s.value}</div>
              <div className="text-[10px] text-white/40">{s.sub}</div>
            </button>
          ))}
        </div>
      </div>

      {/* ══ ZUSATZDATEN FÜR KG-SCHÄTZUNG ═══════════════════════════════════ */}
      <div className="card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-bold text-slate-500 uppercase tracking-wide text-[10px] shrink-0">Zusatzdaten für Schätzung</span>

          <input
            ref={ketFileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleKetCsvFile(f); e.target.value = ""; }}
          />
          <button
            onClick={() => ketFileInputRef.current?.click()}
            className={`px-3 py-1.5 rounded-full font-medium transition ${ketCsvRows ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            {ketCsvRows ? `✓ KET-CSV · ${ketCsvRows.length} Zeilen` : "KET-CSV hochladen"}
          </button>
          {ketCsvFileName && <span className="text-slate-400 text-[10px]">{ketCsvFileName}</span>}
          {ketCsvRows && (
            <button
              onClick={() => { setKetCsvRows(null); try { localStorage.removeItem(KET_CSV_STORAGE_KEY); } catch { /* quota */ } }}
              className="text-slate-300 hover:text-slate-500"
              title="KET-CSV entfernen"
            >
              ✕
            </button>
          )}

          <div className="w-px h-4 bg-slate-200 mx-1" />

          <input
            ref={recipeWeightsFileInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleRecipeWeightsFile(f); e.target.value = ""; }}
          />
          <button
            onClick={() => recipeWeightsFileInputRef.current?.click()}
            className={`px-3 py-1.5 rounded-full font-medium transition ${recipeWeights ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          >
            {recipeWeights ? `✓ Rezept-Gewichte · ${recipeWeights.recipeCount} Rezepte` : "export-recipes.csv hochladen"}
          </button>
          {recipeWeightsFileName && <span className="text-slate-400 text-[10px]">{recipeWeightsFileName}</span>}
          {recipeWeights && (
            <button
              onClick={() => { setRecipeWeights(null); try { localStorage.removeItem(RECIPE_WEIGHTS_STORAGE_KEY); } catch { /* quota */ } }}
              className="text-slate-300 hover:text-slate-500"
              title="Rezept-Gewichte entfernen"
            >
              ✕
            </button>
          )}
        </div>
        <p className="text-[10px] text-slate-400 mt-2">
          Beide zusammen ergeben eine <strong>geschätzte</strong> Ziel-Menge (Ziel-Portionen × Gewicht/Portion) für WOs ohne echten Produktionsplan — sichtbar als "≈ GESCHÄTZT", nie als echtes Soll. Die KET-CSV teilt sich den Upload mit "KET Plan / WO".
        </p>
      </div>

      {/* ══ KI PRODUKTIONS-AGENT ═══════════════════════════════════════════ */}
      <div className="card overflow-hidden border-0 shadow-md">
        {/* KI Header */}
        <div className="px-5 py-4 bg-gradient-to-r from-violet-700 to-purple-700 text-white flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-lg">🤖</div>
            <div>
              <div className="font-bold">KI Produktions-Agent</div>
              <div className="text-xs text-purple-200">Regel-basierte Produktionsanalyse</div>
            </div>
            {intelligence.shiftSummary && (
              <span className={`text-[10px] px-2.5 py-1 rounded-full font-bold ml-2 ${
                intelligence.shiftSummary.overallHealth === "good" ? "bg-emerald-400/30 text-emerald-200 ring-1 ring-emerald-400/40" :
                intelligence.shiftSummary.overallHealth === "warning" ? "bg-amber-400/30 text-amber-200 ring-1 ring-amber-400/40" :
                "bg-red-400/30 text-red-200 ring-1 ring-red-400/40"
              }`}>
                {intelligence.shiftSummary.overallHealth === "good" ? "ON TRACK ✓" :
                 intelligence.shiftSummary.overallHealth === "warning" ? "ACHTUNG ⚠" : "KRITISCH ●"}
              </span>
            )}
          </div>
          <button
            onClick={() => setChatOpen(o => !o)}
            className="text-xs px-4 py-2 rounded-full bg-white/20 hover:bg-white/30 text-white ring-1 ring-white/30 transition font-medium"
          >
            {chatOpen ? "▲ Chat schließen" : "💬 Chat öffnen"}
          </button>
        </div>

        <div className="p-5">
          {/* Schicht-Tiles */}
          {intelligence.shiftSummary ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="bg-slate-50 rounded-xl p-3 ring-1 ring-slate-200">
                <div className="text-[10px] text-slate-500 uppercase font-bold">Gewogen heute</div>
                <div className="text-xl font-bold font-mono mt-0.5">{fmt(intelligence.shiftSummary.totalWeighed, 1)} kg</div>
                <div className="text-[10px] text-slate-400">{intelligence.shiftSummary.totalEntries} Wiegungen</div>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 ring-1 ring-slate-200">
                <div className="text-[10px] text-slate-500 uppercase font-bold">Tempo</div>
                <div className="text-xl font-bold font-mono mt-0.5">{fmt(intelligence.shiftSummary.kgPerHour, 1)} <span className="text-sm font-normal text-slate-400">kg/h</span></div>
                <div className="text-[10px] text-slate-400">seit {fmt(intelligence.shiftSummary.shiftDurationHours, 1)} h</div>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 ring-1 ring-slate-200">
                <div className="text-[10px] text-slate-500 uppercase font-bold">Prognose Schichtende</div>
                <div className="text-xl font-bold font-mono mt-0.5">{fmt(intelligence.shiftSummary.projectedEndOfShift, 0)} <span className="text-sm font-normal text-slate-400">kg</span></div>
                <div className="text-[10px] text-slate-400">bei {shiftEndHours} h Schicht</div>
              </div>
              {intelligence.shiftSummary.shortfallAtEndOfShift > 0 ? (
                <div className="bg-red-50 rounded-xl p-3 ring-1 ring-red-200">
                  <div className="text-[10px] text-red-600 uppercase font-bold">Fehlprognose</div>
                  <div className="text-xl font-bold font-mono mt-0.5 text-red-700">−{fmt(intelligence.shiftSummary.shortfallAtEndOfShift, 0)} kg</div>
                  <div className="text-[10px] text-red-500 font-medium">Bei aktuellem Tempo droht Unterdeckung — noch keine bestätigte Backfill-Notwendigkeit</div>
                </div>
              ) : (
                <div className="bg-emerald-50 rounded-xl p-3 ring-1 ring-emerald-200">
                  <div className="text-[10px] text-emerald-600 uppercase font-bold">Prognose</div>
                  <div className="text-lg font-bold mt-0.5 text-emerald-700">Plan erfüllt ✓</div>
                </div>
              )}
            </div>
          ) : (
            <div className="mb-4 bg-slate-50 rounded-xl p-4 text-center text-xs text-slate-400 ring-1 ring-slate-200">
              Noch keine Schicht-Daten — starte Chat oder nutze Quick-Buttons für aktuelle Infos.
            </div>
          )}

          {/* Alerts */}
          {intelligence.alerts.length > 0 && (
            <div className="space-y-2 mb-4">
              {intelligence.alerts.slice(0, 6).map(alert => (
                <div key={alert.id} className={`flex items-start gap-3 px-4 py-3 rounded-xl text-xs ${
                  alert.severity === "critical" ? "bg-red-50 ring-1 ring-red-200" :
                  alert.severity === "warning" ? "bg-amber-50 ring-1 ring-amber-200" :
                  "bg-white ring-1 ring-slate-200"
                }`}>
                  <AlertIcon severity={alert.severity} />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-800">{alert.title}</div>
                    <div className="text-slate-600 mt-0.5">{alert.message}</div>
                    {alert.suggestedAction && (
                      <div className="mt-1.5 text-purple-700 font-medium">→ {alert.suggestedAction}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empfehlungen */}
          {intelligence.recommendations.length > 0 && (
            <div className="bg-purple-50 rounded-xl p-4 ring-1 ring-purple-200 mb-4">
              <div className="text-[10px] uppercase font-bold text-purple-700 mb-2 tracking-wide">Empfehlungen</div>
              <ul className="space-y-1.5 text-xs text-slate-700">
                {intelligence.recommendations.map((rec, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-purple-400 shrink-0 mt-0.5">▸</span>
                    <span>{rec}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Chat */}
          {chatOpen && (
            <div ref={chatPanelRef} className="bg-slate-50 rounded-2xl ring-1 ring-slate-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-white border-b border-slate-100 flex items-center justify-between">
                <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wide">Chat mit KI-Agent</span>
                <span className="text-[10px] text-slate-400">Tippe 'hilfe' für alle Befehle</span>
              </div>

              {/* Quick-Buttons */}
              <div className="px-4 py-2 flex flex-wrap gap-1.5 bg-white border-b border-slate-100">
                {["status", "was fehlt", "als nächstes", "runs", "kritisch", "prognose", "meals", "tempo", "fertig", "empfehlung"].map(q => (
                  <button
                    key={q}
                    onClick={() => handleQuickChat(q)}
                    className="text-[10px] px-2.5 py-1 rounded-full bg-purple-50 ring-1 ring-purple-200 text-purple-700 hover:bg-purple-100 transition font-medium"
                  >
                    {q}
                  </button>
                ))}
              </div>

              {/* Nachrichten */}
              <div className="px-4 py-3 max-h-80 overflow-y-auto space-y-2.5">
                {chatMessages.length === 0 ? (
                  <div className="py-6 text-xs text-slate-400 text-center">
                    Stelle eine Frage — z.B. "was fehlt", "runs", "als nächstes", "WO 35-209"
                  </div>
                ) : (
                  chatMessages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[88%] px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed ${
                        msg.role === "user"
                          ? "bg-purple-600 text-white rounded-br-sm shadow-sm"
                          : "bg-white text-slate-800 rounded-bl-sm ring-1 ring-slate-200 shadow-sm"
                      }`}>
                        {msg.role === "agent" && (
                          <span className="text-[10px] font-bold text-purple-600 block mb-1">🤖 KI-Agent</span>
                        )}
                        {msg.text.split("\n").map((line, j) => (
                          <span key={j} className="block">{line || " "}</span>
                        ))}
                      </div>
                    </div>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Eingabe */}
              <div className="px-4 py-3 bg-white border-t border-slate-100">
                <form onSubmit={handleChat} className="flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    placeholder="Frage… z.B. 'run 2', 'WO 35-209', 'als nächstes'"
                    className="flex-1 text-xs px-3.5 py-2 rounded-full border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:bg-white transition"
                  />
                  <button
                    type="submit"
                    disabled={!chatInput.trim()}
                    className="px-4 py-2 rounded-full bg-purple-600 text-white text-xs font-medium hover:bg-purple-700 disabled:opacity-40 transition shadow-sm"
                  >
                    Senden
                  </button>
                  {chatMessages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setChatMessages([])}
                      className="px-3 py-2 rounded-full bg-slate-100 text-slate-400 text-xs hover:bg-slate-200 transition"
                      title="Chat leeren"
                    >
                      ✕
                    </button>
                  )}
                </form>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ══ MEAL-FORTSCHRITT ════════════════════════════════════════════════ */}
      {meals.length > 0 && (
        <div className="card p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <h3 className="text-lg font-bold text-slate-800">Fortschritt je Meal</h3>
              <p className="text-xs text-slate-500 mt-0.5">{filteredMeals.length} von {meals.length} Meals · klicken zum Aufklappen</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {([
                { key: "all", label: `Alle · ${meals.length}`, active: "bg-slate-700 text-white", inactive: "bg-white ring-1 ring-slate-200 text-slate-600" },
                { key: "critical", label: `⚠ Kritisch · ${mealCritical}`, active: "bg-red-600 text-white", inactive: "bg-white ring-1 ring-red-200 text-red-600" },
                { key: "running", label: `◌ Laufend · ${mealRunning}`, active: "bg-sky-600 text-white", inactive: "bg-white ring-1 ring-sky-200 text-sky-600" },
                { key: "done", label: `✓ Fertig · ${mealDone}`, active: "bg-emerald-600 text-white", inactive: "bg-white ring-1 ring-emerald-200 text-emerald-700" },
              ] as const).map(f => (
                <button
                  key={f.key}
                  onClick={() => setMealFilter(f.key as typeof mealFilter)}
                  className={`text-[10px] px-3 py-1.5 rounded-full font-bold transition shadow-sm ${mealFilter === f.key ? f.active : f.inactive}`}
                >
                  {f.label}
                </button>
              ))}
              <div className="w-px bg-slate-200 mx-1" />
              <button
                onClick={() => setExpandedMeals(new Set(meals.map(m => m.recipeCode)))}
                className="text-[10px] px-2.5 py-1.5 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition"
              >
                Alle ▼
              </button>
              <button
                onClick={() => setExpandedMeals(new Set())}
                className="text-[10px] px-2.5 py-1.5 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition"
              >
                Alle ▲
              </button>
            </div>
          </div>

          <div className="space-y-2.5">
            {filteredMeals.map(meal => {
              const expanded = expandedMeals.has(meal.recipeCode);
              const mealBackfillNeeds = meal.workOrders.map(wo => backfillByWo.get(wo.workOrder)).filter((b): b is BackfillNeed => b != null);
              const mealBackfillPortions = mealBackfillNeeds.reduce((s, b) => s + b.estimatedPortions, 0);
              const isDone = meal.completedWOs === meal.totalWOs;
              const isCritical = meal.criticalWOs.length > 0;

              // Runs gruppieren
              const byRun = new Map<number, WoMatchedStatus[]>();
              for (const wo of meal.workOrders) {
                const r = wo.run ?? 1;
                if (!byRun.has(r)) byRun.set(r, []);
                byRun.get(r)!.push(wo);
              }
              const runEntries = [...byRun.entries()].sort(([a], [b]) => a - b);
              const hasRuns = runEntries.length > 1;

              const borderColor = isCritical ? "border-red-300" : isDone ? "border-emerald-300" : "border-slate-200";
              const bgColor = isCritical ? "bg-red-50/40" : isDone ? "bg-emerald-50/20" : "";

              return (
                <div
                  id={`meal-${meal.recipeCode}`}
                  key={meal.recipeCode}
                  className={`rounded-2xl border-2 overflow-hidden transition-shadow ${borderColor} ${bgColor} ${expanded ? "shadow-md" : "hover:shadow-sm"}`}
                >
                  {/* Füllstand-Leiste — läuft langsam voll, solange die Wiegungen reinkommen */}
                  <div className="h-2 bg-slate-100">
                    <div
                      className={`h-full transition-all duration-700 ${
                        isCritical ? "bg-red-400" :
                        meal.progressPct >= 95 ? "bg-emerald-400" :
                        meal.progressPct >= 60 ? "bg-sky-400" :
                        meal.progressPct >= 30 ? "bg-amber-400" : "bg-slate-300"
                      }`}
                      style={{ width: `${Math.min(meal.progressPct, 100)}%` }}
                    />
                  </div>
                  {/* Linke Statuslinie */}
                  <div className="flex">
                    <div className={`w-1.5 rounded-l-2xl shrink-0 ${isCritical ? "bg-red-400" : isDone ? "bg-emerald-400" : "bg-sky-300"}`} />
                    <div className="flex-1 min-w-0">
                      {/* Meal-Header */}
                      <div
                        className="flex items-center justify-between gap-3 px-4 pt-3 pb-2 cursor-pointer select-none"
                        onClick={() => toggleMeal(meal.recipeCode)}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-slate-400 text-xs">{expanded ? "▼" : "▶"}</span>
                            <span className="font-bold text-sm text-slate-900">{meal.recipeCode}</span>
                            <span className="text-slate-500 text-sm truncate">{meal.recipeName}</span>
                            {isDone && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200 font-bold shrink-0">✓ FERTIG</span>}
                            {mealBackfillNeeds.length > 0 && (
                              <span
                                title="Reguläre WOs durch, Plan nicht erreicht — Backfill im WMS anlegen"
                                className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 ring-1 ring-amber-200 font-bold shrink-0"
                              >
                                Backfill: −{fmt(mealBackfillPortions)} Stk
                              </span>
                            )}
                            {hasRuns && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200 font-bold shrink-0">
                                {runEntries.length} Runs
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-slate-500 ml-5 mt-0.5">
                            <span>{meal.completedWOs}/{meal.totalWOs} WOs fertig</span>
                            <span>·</span>
                            <span>{fmt(meal.plannedMeals)} Meals</span>
                            {hasRuns && runEntries.map(([r, wos]) => (
                              <span key={r} className={`font-medium ${wos.every(w => w.isComplete) ? "text-emerald-600" : wos.some(w => w.isCritical) ? "text-red-600" : "text-slate-400"}`}>
                                R{r}:{wos.filter(w => w.isComplete).length}/{wos.length}
                              </span>
                            ))}
                          </div>
                          {!expanded && <WoDots wos={meal.workOrders} />}
                        </div>
                        <div className="shrink-0 text-right">
                          <div className={`text-2xl font-bold font-mono ${isCritical ? "text-red-600" : isDone ? "text-emerald-600" : "text-slate-800"}`}>
                            {fmt(meal.progressPct, 0)}%
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {fmtMass(meal.totalActualKg * 1000)} / {fmtMass(meal.totalPlannedKg * 1000)}
                          </div>
                        </div>
                      </div>

                      {/* Fortschrittsbalken */}
                      <div className="px-4 pb-3">
                        <ProgressBar pct={meal.progressPct} size="sm" />
                      </div>

                      {/* Kritisch-Hinweis (collapsed) */}
                      {isCritical && !expanded && (
                        <div className="px-4 pb-3 text-[11px] text-red-700 font-medium">
                          ⚠ Kritisch: {meal.criticalWOs.map(w => w.subRecipe).join(" · ")}
                        </div>
                      )}

                      {/* Aufgeklappte WO-Tabelle */}
                      {expanded && (
                        <div className="mx-4 mb-4 overflow-hidden rounded-xl ring-1 ring-slate-200 shadow-sm">
                          <div className="overflow-x-auto">
                            <table className="min-w-full text-xs">
                              <thead className="bg-slate-100 text-[10px] uppercase tracking-wider text-slate-500">
                                <tr>
                                  <th className="px-3 py-2 text-left">WO</th>
                                  <th className="px-3 py-2 text-left">Sub-Rezept</th>
                                  <th className="px-3 py-2 text-right">Geplant</th>
                                  <th className="px-3 py-2 text-right">Ist</th>
                                  <th className="px-3 py-2 text-right">%</th>
                                  <th className="px-3 py-2 text-right">Chargen</th>
                                  <th className="px-3 py-2 text-center">Status</th>
                                  <th className="px-3 py-2 text-left">Verlauf</th>
                                  <th className="px-3 py-2 text-left">Letzte Wiegung</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100 bg-white">
                                {runEntries.flatMap(([runNum, runWos]) => {
                                  const runDone = runWos.filter(w => w.isComplete).length;
                                  const runHasCritical = runWos.some(w => w.isCritical);
                                  const runAllDone = runDone === runWos.length;

                                  const rows: ReactElement[] = [];

                                  // Run-Trennzeile (nur wenn mehrere Runs)
                                  if (hasRuns) {
                                    rows.push(
                                      <tr key={`sep-${runNum}`} className="bg-gradient-to-r from-indigo-50 to-slate-50">
                                        <td colSpan={9} className="px-3 py-2">
                                          <div className="flex items-center gap-3">
                                            <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 ${
                                              runAllDone ? "bg-emerald-500" : runHasCritical ? "bg-red-500" : "bg-indigo-500"
                                            }`}>
                                              {runNum}
                                            </span>
                                            <span className="text-[10px] font-bold text-indigo-700 uppercase tracking-wider">Run {runNum}</span>
                                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                                              runAllDone ? "bg-emerald-100 text-emerald-700" :
                                              runHasCritical ? "bg-red-100 text-red-700" :
                                              "bg-indigo-100 text-indigo-700"
                                            }`}>
                                              {runDone}/{runWos.length} fertig
                                              {runAllDone && " ✓"}
                                              {runHasCritical && " ⚠"}
                                            </span>
                                            <span className="text-[10px] text-slate-400">
                                              {fmtMass(runWos.reduce((s, w) => s + w.actualKg, 0) * 1000)} / {fmtMass(runWos.reduce((s, w) => s + w.plannedKg, 0) * 1000)}
                                            </span>
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  }

                                  // WO-Zeilen
                                  runWos.forEach(wo => {
                                    const fsTs = firstSeen.get(wo.workOrder);
                                    const fsTime = fsTs ? new Date(fsTs).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : null;
                                    const startKg = shiftStartActual[wo.workOrder] ?? 0;
                                    const delta = wo.actualKg - startKg;
                                    const backfillNeed = backfillByWo.get(wo.workOrder);
                                    const batchCount = batchMap.get(wo.workOrder);

                                    rows.push(
                                      <tr
                                        key={wo.workOrder}
                                        className={`transition-colors ${
                                          wo.isCritical ? "bg-red-50/60 hover:bg-red-50" :
                                          wo.isComplete ? "bg-emerald-50/30 hover:bg-emerald-50/50" :
                                          "hover:bg-slate-50/80"
                                        }`}
                                      >
                                        <td className="px-3 py-2 font-mono font-bold text-slate-700 whitespace-nowrap">{wo.workOrder}</td>
                                        <td className="px-3 py-2 max-w-[180px]">
                                          <div className="font-medium truncate" title={wo.subRecipe}>{wo.subRecipe}</div>
                                          {backfillNeed && (
                                            <span
                                              title="Reguläre WOs sind durch, Plan wird trotzdem nicht erreicht — Backfill im WMS anlegen"
                                              className="text-[9px] px-1.5 py-0.5 rounded-full font-bold ring-1 bg-amber-100 text-amber-700 ring-amber-200"
                                            >
                                              BACKFILL · −{fmt(backfillNeed.estimatedPortions)} Stk
                                            </span>
                                          )}
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono text-slate-500">
                                          {wo.isEstimated && (
                                            <span title="Geschätzt aus Portionen × Rezept-Gewicht — kein echtes Firestore-Soll" className="text-amber-500 mr-0.5">≈</span>
                                          )}
                                          {fmt(wo.plannedKg, 1)} kg
                                        </td>
                                        <td className="px-3 py-2 text-right font-mono font-bold">{fmt(wo.actualKg, 1)} kg</td>
                                        <td className="px-3 py-2 text-right">
                                          <div className="flex items-center justify-end gap-1.5">
                                            <div className="w-10">
                                              <ProgressBar pct={wo.progressPct} size="xs" />
                                            </div>
                                            <span className="font-mono font-bold text-slate-700 w-8 text-right">{fmt(wo.progressPct, 0)}%</span>
                                          </div>
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                          {batchCount != null ? (
                                            <span className={`font-mono font-bold ${batchCount >= 5 ? "text-amber-600" : "text-slate-600"}`}>
                                              {batchCount}×
                                            </span>
                                          ) : <span className="text-slate-300">—</span>}
                                        </td>
                                        <td className="px-3 py-2 text-center"><StatusBadge wo={wo} /></td>
                                        <td className="px-3 py-2 text-[10px] whitespace-nowrap">
                                          {fsTime ? (
                                            <span className={wo.isComplete ? "text-emerald-600 font-medium" : "text-teal-600"}>
                                              {wo.isComplete ? `✓ ${fsTime}` : `⏱ ab ${fsTime}`}
                                              {delta > 0.1 && <span className="ml-1 text-slate-400">+{fmt(delta, 1)} kg</span>}
                                            </span>
                                          ) : <span className="text-slate-300">—</span>}
                                        </td>
                                        <td className="px-3 py-2 text-[10px] text-slate-400 whitespace-nowrap">{wo.lastWeighing ?? "—"}</td>
                                      </tr>
                                    );
                                  });

                                  return rows;
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {filteredMeals.length === 0 && (
              <div className="py-10 text-center text-sm text-slate-400">
                Keine Meals in dieser Kategorie.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ BACKFILL-MELDUNGEN ══════════════════════════════════════════════ */}
      {backfill.length > 0 && (
        <div className="card overflow-hidden shadow-sm border-0">
          <div className="px-5 py-4 bg-gradient-to-r from-amber-500 to-orange-500 text-white">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h3 className="text-lg font-bold">Backfill-Meldungen</h3>
                <p className="text-sm text-amber-100 mt-0.5">
                  Reguläre WOs sind komplett durch, Plan wird trotzdem nicht erreicht — Stückzahl zum Anlegen des Backfills im WMS
                </p>
              </div>
              <div className="flex gap-1.5">
                {(["all", "critical", "behind"] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => setBackfillFilter(f)}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition ${
                      backfillFilter === f
                        ? "bg-white text-amber-700 shadow-sm"
                        : "bg-white/20 text-white hover:bg-white/30 ring-1 ring-white/30"
                    }`}
                  >
                    {f === "all" ? `Alle · ${backfill.length}` :
                     f === "critical" ? `⚠ Kritisch · ${backfill.filter(b => b.priority === "critical").length}` :
                     `Hinter Plan · ${backfill.filter(b => b.priority === "behind").length}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Summary-Tiles im Header — Stückzahl zuerst, kg nur als Zusatzinfo */}
            <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
              {[
                { label: "Fehlende Stück", val: fmt(backfill.reduce((s, b) => s + b.estimatedPortions, 0)) },
                { label: "Gesamt fehlt (kg)", val: fmtMass(backfill.reduce((s, b) => s + b.missingKg, 0) * 1000) },
                { label: "Kritisch", val: String(backfill.filter(b => b.priority === "critical").length) },
                { label: "Hinter Plan", val: String(backfill.filter(b => b.priority === "behind").length) },
              ].map(s => (
                <div key={s.label} className="bg-white/20 rounded-xl p-2.5 text-center backdrop-blur-sm">
                  <div className="text-[10px] text-amber-100 uppercase font-bold tracking-wide">{s.label}</div>
                  <div className="text-lg font-bold font-mono text-white">{s.val}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="overflow-hidden">
            <div className="max-h-[400px] overflow-auto">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-amber-50 text-[10px] uppercase tracking-wide text-amber-800 border-b border-amber-200">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Meal</th>
                    <th className="px-4 py-2.5 text-left">Sub-Rezept</th>
                    <th className="px-4 py-2.5 text-right">Fehlende Stück</th>
                    <th className="px-4 py-2.5 text-right">Fehlt (kg)</th>
                    <th className="px-4 py-2.5 text-right">%</th>
                    <th className="px-4 py-2.5 text-center">Status</th>
                    <th className="px-4 py-2.5 text-center">Meal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-50 bg-white">
                  {filteredBackfill.map(b => (
                    <tr key={b.workOrder} className={`hover:bg-amber-50/50 transition-colors ${b.priority === "critical" ? "border-l-4 border-l-red-400" : b.priority === "behind" ? "border-l-4 border-l-amber-400" : "border-l-4 border-l-emerald-300"}`}>
                      <td className="px-4 py-2.5 font-medium text-slate-600">{b.recipeCode}</td>
                      <td className="px-4 py-2.5 truncate max-w-[200px]" title={b.subRecipe}>
                        {b.subRecipe}
                        {b.rtiConfirmed && (
                          <span className="ml-1.5 text-[9px] text-emerald-600 font-medium" title="Status 'done' direkt aus dem RTI-Sheet übernommen">✓ RTI-bestätigt</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="font-mono font-bold text-lg text-red-700">{fmt(b.estimatedPortions)}</div>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="font-mono text-slate-500">{fmt(b.missingKg, 1)} kg</div>
                        {b.platingHoldingKg > 0 && (
                          <div className="text-[9px] text-sky-600" title="Bereits als Fertigware im Holding vorhanden laut RTI-Sheet">+{fmt(b.platingHoldingKg, 1)} kg in Holding</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-500">{fmt(b.missingPct, 0)}%</td>
                      <td className="px-4 py-2.5 text-center"><PriorityBadge priority={b.priority} /></td>
                      <td className="px-4 py-2.5 text-center">
                        <button
                          onClick={() => scrollToMeal(b.recipeCode)}
                          className="text-[10px] px-2.5 py-1 rounded-full bg-teal-50 text-teal-700 ring-1 ring-teal-200 hover:bg-teal-100 transition font-medium"
                        >
                          ↑ zeigen
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ══ BÜNDELUNGS-VORSCHLÄGE ═══════════════════════════════════════════ */}
      {bundleGroups.length > 0 && (
        <div className="card overflow-hidden shadow-sm border-0">
          <div className="px-5 py-4 bg-gradient-to-r from-violet-600 to-purple-600 text-white">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🔗</span>
              <div>
                <h3 className="text-lg font-bold">Bündelungs-Hinweis</h3>
                <p className="text-sm text-violet-100 mt-0.5">
                  {bundleGroups.length} Sub-Rezept{bundleGroups.length > 1 ? "e" : ""} fehlen in mehreren Meals — als einen gemeinsamen Backfill anlegen statt einzeln
                </p>
              </div>
              <div className="ml-auto text-right">
                <div className="text-3xl font-bold font-mono">{bundleGroups.length}</div>
                <div className="text-xs text-violet-200">Gruppen</div>
              </div>
            </div>
          </div>

          <div className="p-5 space-y-4">
            {/* Erklärungskasten */}
            <div className="flex gap-3 p-3 rounded-xl bg-violet-50 border border-violet-100 text-sm text-violet-800">
              <span className="text-violet-400 text-base shrink-0 mt-0.5">ℹ</span>
              <div>
                <span className="font-semibold">Was bedeutet das?</span> Dasselbe Sub-Rezept fehlt bei mehreren Meals gleichzeitig.
                Ein Backfill deckt dann mehrere Meals ab — beim Anlegen im WMS die Stückzahlen einfach zusammenzählen.
              </div>
            </div>

            {/* Gruppen */}
            <div className="grid gap-3 md:grid-cols-2">
              {bundleGroups.map(([subRecipe, items]) => {
                const totalKg = items.reduce((s, b) => s + b.missingKg, 0);
                const totalPortions = items.reduce((s, b) => s + b.estimatedPortions, 0);
                const hasCritical = items.some(b => b.priority === "critical");
                return (
                  <div
                    key={subRecipe}
                    className={`rounded-xl border p-4 ${hasCritical ? "border-red-200 bg-red-50/40" : "border-violet-200 bg-white"}`}
                  >
                    {/* Sub-Rezept Header */}
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div>
                        <div className="font-bold text-sm text-slate-900 leading-tight">{subRecipe}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          fehlt bei {items.length} Meals
                        </div>
                      </div>
                      {hasCritical && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 ring-1 ring-red-300 font-bold shrink-0">⚠ KRITISCH</span>
                      )}
                    </div>

                    {/* Meal-Liste */}
                    <div className="space-y-1.5 mb-3">
                      {items.map((b, i) => (
                        <div key={b.workOrder} className="flex items-center gap-2 text-xs">
                          <span className="text-slate-300 font-mono text-[10px] w-3 shrink-0">{i === items.length - 1 ? "└" : "├"}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0 ${b.priority === "critical" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                            {b.recipeCode}
                          </span>
                          <span className="font-mono font-bold text-red-700 shrink-0">−{fmt(b.estimatedPortions)} Stk</span>
                          <span className="text-slate-400 shrink-0">({b.missingKg.toFixed(1)} kg)</span>
                        </div>
                      ))}
                    </div>

                    {/* Zusammenfassung */}
                    <div className="pt-2.5 border-t border-slate-100">
                      <div className="flex items-center justify-between">
                        <div className="text-[11px] text-slate-500">
                          Zusammen: <span className="font-mono font-bold text-red-700">{fmt(totalPortions)} Stk</span>
                          {" · "}
                          <span className="font-mono font-bold text-slate-700">{totalKg.toFixed(1)} kg</span>
                        </div>
                        <div className="text-[10px] font-semibold text-violet-700 bg-violet-100 px-2 py-0.5 rounded-full">
                          {items.length} Meals → 1 Backfill ✓
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ══ LIVE FEED ═══════════════════════════════════════════════════════ */}
      {monitor.data && monitor.data.entries.length > 0 && (
        <div className="card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div>
              <h3 className="text-lg font-bold text-slate-800">
                Letzte Wiegungen
                {liveFeedToday && todayEntries.length > 0 && (
                  <span className="ml-2 text-sm font-normal text-slate-500">({todayEntries.length} heute)</span>
                )}
              </h3>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setLiveFeedToday(t => !t)}
                className={`text-xs px-3 py-1.5 rounded-full font-medium transition shadow-sm ${
                  liveFeedToday ? "bg-teal-600 text-white" : "bg-white ring-1 ring-slate-200 text-slate-500"
                }`}
              >
                {liveFeedToday ? "Nur heute ✓" : "Nur heute"}
              </button>
              <input
                type="text"
                value={liveFeedSearch}
                onChange={e => setLiveFeedSearch(e.target.value)}
                placeholder="WO / Sub-Rezept suchen…"
                className="text-xs px-3 py-1.5 rounded-full border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-teal-400 w-44"
              />
              {liveFeedSearch && (
                <button onClick={() => setLiveFeedSearch("")} className="text-xs text-slate-400 hover:text-slate-600">✕</button>
              )}
              {snapCount > 0 && (
                <button
                  onClick={clearHistory}
                  className="text-[10px] px-2.5 py-1.5 rounded-full bg-slate-100 text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition"
                  title="Schichtverlauf aus localStorage löschen"
                >
                  Verlauf löschen ({snapCount})
                </button>
              )}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
            <div className="max-h-72 overflow-auto">
              {liveEntries.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-400">
                  {liveFeedToday ? "Heute noch keine Wiegungen." : "Keine Einträge gefunden."}
                </div>
              ) : (
                <table className="min-w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100 text-[10px] uppercase tracking-wide text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">Zeitpunkt</th>
                      <th className="px-3 py-2 text-left">WO</th>
                      <th className="px-3 py-2 text-left">Sub-Rezept</th>
                      <th className="px-3 py-2 text-right">Gewicht</th>
                      <th className="px-3 py-2 text-left">Sub-Sub</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {liveEntries.map((e, idx) => (
                      <tr key={idx} className={`transition-colors ${idx === 0 ? "bg-emerald-50" : "hover:bg-slate-50"}`}>
                        <td className="px-3 py-2 font-mono text-slate-500">
                          {idx === 0 && <span className="mr-1 text-emerald-500 animate-pulse">●</span>}
                          {e.timestamp}
                        </td>
                        <td className="px-3 py-2 font-mono font-bold">{e.workOrder}</td>
                        <td className="px-3 py-2 font-medium">{e.subRecipeName}</td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-indigo-700">{fmt(e.rawWeightKg, 2)} kg</td>
                        <td className="px-3 py-2 text-slate-400">{e.subSubRecipe || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══ EMPTY STATES ════════════════════════════════════════════════════ */}
      {!monitor.data && !monitor.error && (
        <div className="card p-10 text-center text-slate-500 shadow-sm">
          <div className="text-4xl mb-3">⏳</div>
          <div className="font-bold text-lg">Lade Postblast-Daten…</div>
          <div className="text-sm mt-2 text-slate-400">Polling startet automatisch (alle 30 Sekunden)</div>
        </div>
      )}

      {!data.productionPlan && monitor.data && (
        <div className="card p-4 bg-amber-50 border-2 border-amber-300 text-amber-900 shadow-sm">
          <strong>Kein Produktionsplan geladen.</strong> Work-Order-Matching nicht möglich.
        </div>
      )}
    </div>
  );
}
