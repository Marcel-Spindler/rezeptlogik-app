import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DataBundle } from "../../core/types";
import { cleanRecipeName } from "../../lib/helpers";
import {
  buildRecipeIdIndex,
  CHILLER_CFG,
  computeRecipeWideAllergen,
  computeWoAllergenDetailed,
  computeWoKg,
  type AllergenPrecision,
} from "./blastChillerLogic";
import { clearSeenWos, loadSeenWos, rememberWos } from "./blastChillerMemory";
import {
  aggregateWeekPlan,
  classicLayout,
  cyclesPerDay,
  DEFAULT_CHILLER_PLAN_PARAMS,
  planChillers,
  racksPerChillerDay,
  toChillerWo,
  type ChillerPlan,
  type ChillerPlanParams,
  type ChillerWo,
  type ClassicSection,
  type PlannedChiller,
  type RecipeGroup,
} from "./blastChillerPlan";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CsvRow {
  wo:       string;
  name:     string;   // sub-recipe name
  recipe:   string;   // "Recipe Name" (enthält meist den FV-Code)
  recipeId: string;   // "Recipe ID" (REC-…) — Fallback für die Zuordnung
  date:     string;
  shift:    string;   // "1" / "2" aus "Date Needed" (2-Schicht-Modell)
  portions: number;   // WO Cooked Portions (Ist), Fallback Target Portions
  blasted:  boolean;  // Kitchen Status = "Post Blast" → schon durch den Chiller
}

const PARAMS_STORAGE_KEY = "rezeptlogik-blast-chiller-params-v1";

// ─── Pure Logic ───────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const res: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if ((ch === "," || ch === ";") && !q) {
      res.push(cur); cur = "";
    } else cur += ch;
  }
  res.push(cur);
  return res;
}

function woNum(w: string) { return parseInt((w || "").split("-")[1] || "9999"); }

/** Extract recipe family code (e.g. "FV0849A") from any string */
function extractRecipeCode(raw: string): string | null {
  const m = (raw || "").match(/\b((?:FE|FV)\d{4}[A-Z0-9]?)\b/i);
  return m ? m[1].toUpperCase() : null;
}

function loadParams(): ChillerPlanParams {
  if (typeof window === "undefined") return { ...DEFAULT_CHILLER_PLAN_PARAMS };
  try {
    const raw = window.localStorage.getItem(PARAMS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CHILLER_PLAN_PARAMS };
    const p = JSON.parse(raw) as Partial<ChillerPlanParams>;
    const D = DEFAULT_CHILLER_PLAN_PARAMS;
    const numOr = (v: unknown, def: number) => (Number.isFinite(v) && (v as number) > 0 ? (v as number) : def);
    const hourOr = (v: unknown, def: number) => (Number.isFinite(v) && (v as number) >= 0 && (v as number) <= 24 ? (v as number) : def);
    return {
      racksPerCycle: Math.round(numOr(p.racksPerCycle, D.racksPerCycle)),
      cycleHours: numOr(p.cycleHours, D.cycleHours),
      firstLoadHour: hourOr(p.firstLoadHour, D.firstLoadHour),
      lastLoadHour: hourOr(p.lastLoadHour, D.lastLoadHour),
      rackKg: Math.round(numOr(p.rackKg, D.rackKg)),
      keepRecipesTogether: p.keepRecipesTogether ?? D.keepRecipesTogether,
      splitLargeRecipes: p.splitLargeRecipes ?? D.splitLargeRecipes,
    };
  } catch {
    return { ...DEFAULT_CHILLER_PLAN_PARAMS };
  }
}

function saveParams(p: ChillerPlanParams) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(PARAMS_STORAGE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

// ─── Styling helpers ──────────────────────────────────────────────────────────

const ALLERGEN_CHIP: Record<string, { bg: string; color: string; border: string }> = {
  Milch:      { bg: "#E3F2FD", color: "#0D3780", border: "#90CAF9" },
  Sulfite:    { bg: "#FFF8E1", color: "#7B3F00", border: "#FFD54F" },
  Fisch:      { bg: "#E0F2F1", color: "#00695C", border: "#80CBC4" },
  Krebstiere: { bg: "#FCE4EC", color: "#AD1457", border: "#F48FB1" },
  Weichtiere: { bg: "#EDE7F6", color: "#4527A0", border: "#B39DDB" },
  Gluten:     { bg: "#EFEBE9", color: "#4E342E", border: "#BCAAA4" },
  Ei:         { bg: "#FFFDE7", color: "#9E7D00", border: "#FFF59D" },
  Soja:       { bg: "#E8F5E9", color: "#2E7D32", border: "#A5D6A7" },
  Sesam:      { bg: "#F3E5AB33", color: "#7A5C00", border: "#E0C97F" },
  Senf:       { bg: "#FFF3E0", color: "#E65100", border: "#FFCC80" },
  Sellerie:   { bg: "#F1F8E9", color: "#558B2F", border: "#C5E1A5" },
  "Nüsse":    { bg: "#FBE9E7", color: "#BF360C", border: "#FFAB91" },
  "Erdnüsse": { bg: "#FFEBEE", color: "#B71C1C", border: "#EF9A9A" },
  Lupine:     { bg: "#ECEFF1", color: "#455A64", border: "#B0BEC5" },
};

function chip(a: string) {
  return ALLERGEN_CHIP[a] ?? { bg: "#ECEFF1", color: "#546E7A", border: "#B0BEC5" };
}

const ROLE_STYLE: Record<PlannedChiller["role"], { bg: string; color: string; label: string }> = {
  allergenfrei: { bg: "#E8F5E9", color: "#1B5E20", label: "Allergenfrei" },
  allergen:     { bg: "#E3F2FD", color: "#0D3780", label: "Allergen-Pool" },
  unbekannt:    { bg: "#ECEFF1", color: "#546E7A", label: "Unbekannt — prüfen" },
  leer:         { bg: "#F7F8FB", color: "#9AA3B2", label: "Frei" },
};

function barColor(pct: number): string {
  if (pct >= 100) return "#E53935";
  if (pct >= 80) return "#FB8C00";
  if (pct >= 50) return "#43A047";
  return "#66BB6A";
}

const PRECISION_NOTE: Record<AllergenPrecision, string | null> = {
  sub: null,
  "sub-fuzzy": "Allergene über Namensähnlichkeit gematcht",
  recipe: "Allergene rezeptweit geschätzt (Sub nicht gefunden)",
  "recipe-legacy": "Allergene aus Rezept-Stammdaten",
  none: "keine Allergen-Daten gefunden",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function BlastChillerView({ data }: { data: DataBundle }) {
  const [csvRows,    setCsvRows]    = useState<CsvRow[]>([]);
  const [wos,        setWos]        = useState<ChillerWo[]>([]);
  const [scopeFilter, setScopeFilter] = useState<"all" | "open" | "new">("all");
  const [mode,       setMode]       = useState<"dynamic" | "classic">("dynamic");
  const [focusUnit,  setFocusUnit]  = useState<number | null>(null);
  const [classicUseEmpty, setClassicUseEmpty] = useState(true);
  const [seenWos,    setSeenWos]    = useState<Set<string>>(new Set());
  const [daySel,     setDaySel]     = useState<string[]>([]);
  const [weekLabel,  setWeekLabel]  = useState("W??");
  const [collapsed,  setCollapsed]  = useState<Record<number, boolean>>({});
  const [showResult, setShowResult] = useState(false);
  const [csvLoaded,  setCsvLoaded]  = useState(false);
  const [drag,       setDrag]       = useState(false);
  const [toast,      setToast]      = useState<string | null>(null);
  const [params,     setParams]     = useState<ChillerPlanParams>(loadParams);
  const [showSettings, setShowSettings] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  function updateParams(patch: Partial<ChillerPlanParams>) {
    setParams(prev => { const next = { ...prev, ...patch }; saveParams(next); return next; });
  }

  // Merker für die KW laden, sobald das Wochenlabel aus dem CSV-Namen steht.
  useEffect(() => {
    if (/^W\d+$/.test(weekLabel)) setSeenWos(loadSeenWos(weekLabel));
  }, [weekLabel]);

  // ── KET CSV Handler ───────────────────────────────────────────────────────

  function handleCSV(file: File) {
    const wm = file.name.match(/[Ww](\d{2,})/);
    if (wm) setWeekLabel("W" + wm[1]);
    const reader = new FileReader();
    reader.onload = e => {
      const lines = (e.target!.result as string).split(/\r?\n/);
      const hdr = parseCSVLine(lines[0]).map(h => h.replace(/^"+|"+$/g, "").trim().toLowerCase());
      const fi = (n: string) => hdr.findIndex(h => h.includes(n));
      const iWo   = fi("work order");
      const iName = fi("sub recipe") >= 0 ? fi("sub recipe") : fi("sub rezept");
      const iDate = fi("date needed") >= 0 ? fi("date needed") : fi("datum");
      const iRec  = fi("recipe name");
      const iRecId = fi("recipe id");
      const iPortCooked = fi("cooked portions");
      const iPortTarget = fi("target portions");
      const iStatus = fi("kitchen status");
      if (iWo < 0 || iName < 0) { showToast("Spalten nicht gefunden — CSV prüfen"); return; }
      const cell = (row: string[], idx: number) =>
        idx >= 0 ? (row[idx] || "").replace(/^"+|"+$/g, "").trim() : "";
      const num = (v: string) => parseInt(v.replace(/[^\d-]/g, ""), 10) || 0;
      const rows: CsvRow[] = [];
      for (let i = 1; i < lines.length; i++) {
        const c = parseCSVLine(lines[i]);
        if (c.length < 2) continue;
        const wo   = cell(c, iWo);
        const name = cell(c, iName);
        if (!wo || !name) continue;
        const dateRaw = cell(c, iDate);                       // "2026-08-31 - 1"
        const date  = dateRaw.split(" ")[0];
        const shift = dateRaw.match(/-\s*(\d+)\s*$/)?.[1] ?? "";
        const recipe = cell(c, iRec);
        const recipeId = cell(c, iRecId).toUpperCase();
        // "WO Cooked Portions" ist der Ist-Wert und oft leer → auf "Target" ausweichen.
        const portions = num(cell(c, iPortCooked)) || num(cell(c, iPortTarget));
        const blasted = /post[\s-]*blast/i.test(cell(c, iStatus));
        rows.push({ wo, name, recipe, recipeId, date, shift, portions, blasted });
      }
      setCsvRows(rows);
      setCsvLoaded(true);
      showToast(`KET-CSV geladen: ${rows.length} Work Orders ✓`);
    };
    reader.readAsText(file, "UTF-8");
  }

  // ── Process (allergens + kg from data.structures) ─────────────────────────

  function processData() {
    if (!csvRows.length) return;

    let exact = 0, fuzzy = 0, recipeLvl = 0, unknown = 0, withKg = 0, viaId = 0;

    const recipeWideCache = new Map<string, string>();
    const recipeWide = (code: string) => {
      if (!code) return "";
      let v = recipeWideCache.get(code);
      if (v === undefined) { v = computeRecipeWideAllergen(data, code); recipeWideCache.set(code, v); }
      return v;
    };
    const idIndex = buildRecipeIdIndex(data);

    const processed: ChillerWo[] = csvRows.map(row => {
      let code = extractRecipeCode(row.recipe) ?? extractRecipeCode(row.name) ?? "";
      if (!code && row.recipeId) { code = idIndex.get(row.recipeId) ?? ""; if (code) viaId++; }
      const { allergen, precision } = code
        ? computeWoAllergenDetailed(data, code, row.name)
        : { allergen: null, precision: "none" as AllergenPrecision };
      const kg = code ? computeWoKg(data, code, row.name, row.portions) : 0;

      if (precision === "sub") exact++;
      else if (precision === "sub-fuzzy") fuzzy++;
      else if (precision === "recipe" || precision === "recipe-legacy") recipeLvl++;
      else unknown++;
      if (kg > 0) withKg++;

      return toChillerWo({
        wo: row.wo,
        name: row.name,
        recipeCode: code,
        recipeName: cleanRecipeName(row.recipe) || code || row.name,
        date: row.date,
        shift: row.shift,
        blasted: row.blasted,
        kg,
        allergen,
        precision,
        recipeAllergen: recipeWide(code),
      });
    });

    setWos(processed);
    setDaySel([]);
    setShowResult(true);
    setCollapsed({});

    const msgs: string[] = [];
    if (exact > 0)     msgs.push(`${exact} exakt`);
    if (fuzzy > 0)     msgs.push(`${fuzzy} über Namensähnlichkeit`);
    if (recipeLvl > 0) msgs.push(`${recipeLvl} rezeptweit`);
    if (unknown > 0)   msgs.push(`${unknown} unbekannt`);
    showToast(`Allergene: ${msgs.join(" · ")}${viaId ? ` · ${viaId}× via Recipe-ID` : ""} · kg für ${withKg}/${processed.length} WOs`);
  }

  // ── Computed ──────────────────────────────────────────────────────────────

  const blastedCount = useMemo(() => wos.filter(w => w.blasted).length, [wos]);
  const newWoCount   = useMemo(() => wos.filter(w => !seenWos.has(w.wo)).length, [wos, seenWos]);
  const seenWeekCount = seenWos.size;

  // "Nur offen" = schon geblastete WOs (Kitchen Status) ausblenden.
  // "Nur neu"   = WOs, die schon in einem früheren Handout dieser KW waren, ausblenden.
  // "Alle"      = kompletter Wochenplan.
  const planWos = useMemo(() => {
    if (scopeFilter === "open") return wos.filter(w => !w.blasted);
    if (scopeFilter === "new") return wos.filter(w => !seenWos.has(w.wo));
    return wos;
  }, [wos, scopeFilter, seenWos]);

  // Nach dem Verarbeiten automatisch auf "Nur neu" springen, wenn es für die KW
  // schon einen Merker gibt und tatsächlich neue WOs dabei sind.
  useEffect(() => {
    if (showResult && seenWeekCount > 0 && newWoCount > 0 && newWoCount < wos.length) {
      setScopeFilter("new");
    }
  }, [showResult, seenWeekCount, newWoCount, wos.length]);

  function markSeen() {
    const merged = rememberWos(weekLabel, wos.map(w => w.wo));
    setSeenWos(merged);
    showToast(`${wos.length} WOs für ${weekLabel} als bearbeitet gemerkt ✓`);
  }
  function resetSeen() {
    clearSeenWos(weekLabel);
    setSeenWos(new Set());
    setScopeFilter("all");
    showToast(`Merker für ${weekLabel} gelöscht`);
  }

  const days = useMemo(
    () => [...new Set(wos.map(d => d.date).filter(Boolean))].sort(),
    [wos],
  );

  const fmtDate = (d: string) => {
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
  };
  const fmtKg = (kg: number) => kg >= 100 ? `${Math.round(kg)} kg` : kg > 0 ? `${kg.toFixed(1)} kg` : "—";
  const prettyHint = (h: string) => h.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (_, d) => fmtDate(d));
  const capPerDay = racksPerChillerDay(params);

  // daySel = [] → ganze Woche · 1 Tag → Tagesplan · 2+ Tage → kombiniert (Kapazität × Anzahl,
  //  z.B. wenn Submeals vom Vortag erst am Folgetag in den Chiller kommen).
  const selDates = useMemo(() => daySel.filter(d => days.includes(d)).sort(), [daySel, days]);
  const weekView = selDates.length === 0;
  const selLabel = weekView ? "Ganze Woche" : selDates.map(fmtDate).join(" + ");

  // Immer pro Produktionstag planen — dort entsteht der Engpass.
  const dayPlans = useMemo(
    () => days.map(d => planChillers(planWos.filter(w => w.date === d), params, d, 1)),
    [planWos, days, params],
  );

  const plan: ChillerPlan = useMemo(() => {
    if (selDates.length === 1) {
      return dayPlans.find(p => p.scope === selDates[0])
        ?? planChillers(planWos.filter(w => w.date === selDates[0]), params, selDates[0], 1);
    }
    if (selDates.length >= 2) {
      const sel = planWos.filter(w => selDates.includes(w.date));
      return planChillers(sel, params, selDates.map(fmtDate).join(" + "), selDates.length);
    }
    if (days.length <= 1) return planChillers(planWos, params, "", Math.max(1, days.length));
    // Wochen-Übersicht: pro Chiller die SPITZENLAST eines Tages (bindend), plus
    // alle Tages-Hinweise gesammelt.
    return aggregateWeekPlan(dayPlans, params);
  }, [planWos, selDates, days, params, dayPlans]);

  // Klassik-Modus: WOs nach aktiver Tagesauswahl gefiltert, feste Allergen-Töpfe.
  const classicWos = useMemo(
    () => (weekView ? planWos : planWos.filter(w => selDates.includes(w.date))),
    [planWos, weekView, selDates],
  );
  const classicLay = useMemo(() => classicLayout(classicWos, classicUseEmpty), [classicWos, classicUseEmpty]);

  // ── Exports ───────────────────────────────────────────────────────────────

  // Für Export/Druck: im Wochen-Modus alle Tagespläne, sonst der aktive (kombinierte) Plan.
  const exportPlans: ChillerPlan[] = weekView && dayPlans.length > 0 ? dayPlans : [plan];

  function planRows(): (string | number)[][] {
    if (mode === "classic") {
      const rows: (string | number)[][] = [["Blast Chiller", "Untergruppe", "WO", "Sub-Rezept / Komponente", "Rezept", "Allergene", "kg"]];
      for (const sec of classicLay.sections) {
        for (const g of sec.groups) {
          for (const w of g.wos) {
            rows.push([
              `${sec.label} (${sec.sub})`, sec.chillerKey === "6" || sec.reassigned ? g.allergen : "",
              w.wo, w.name, cleanRecipeName(w.recipeName),
              w.unknown ? "UNBEKANNT" : (w.allergens.join(", ") || "KEINE"), w.kg > 0 ? Math.round(w.kg) : "",
            ]);
          }
        }
      }
      return rows;
    }
    const rows: (string | number)[][] = [["Tag", "Chiller", "Rolle / kann enthalten", "Racks", "WO", "Sub-Rezept / Komponente", "Rezept", "Allergene", "kg"]];
    for (const p of exportPlans) {
      const dayLabel = p.scope ? fmtDate(p.scope) : "Ganze Woche";
      for (const c of p.chillers) {
        if (c.groups.length === 0) continue;
        const role = c.role === "allergenfrei" ? "Allergenfrei"
          : c.role === "unbekannt" ? "Unbekannt — prüfen"
          : c.allergens.length ? `kann enthalten: ${c.allergens.join(", ")}` : "Allergen-Pool";
        for (const g of c.groups) {
          const nameLabel = g.recipeName && g.recipeName !== g.recipeCode ? g.recipeName : "";
          const base = [g.recipeCode, nameLabel].filter(Boolean).join(" ") || g.recipeName;
          const recipeLabel = g.partCount && g.partCount > 1 ? `${base} (Teil ${g.partIndex}/${g.partCount})` : base;
          for (const wo of [...g.wos].sort((a, b) => woNum(a.wo) - woNum(b.wo))) {
            rows.push([
              dayLabel, `Chiller ${c.unit}`, role, `${c.racks}/${c.capRacks}`,
              wo.wo, wo.name, recipeLabel, wo.unknown ? "UNBEKANNT" : (wo.allergens.join(", ") || "KEINE"),
              wo.kg > 0 ? Math.round(wo.kg) : "",
            ]);
          }
        }
      }
    }
    return rows;
  }

  async function exportExcel() {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([[`Blast Chiller ${weekLabel} — ${selLabel}`], [], ...planRows()]);
    ws["!cols"] = [{ wch: 12 }, { wch: 11 }, { wch: 34 }, { wch: 8 }, { wch: 10 }, { wch: 48 }, { wch: 30 }, { wch: 30 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, ws, "Blast Chiller " + weekLabel);
    XLSX.writeFile(wb, `Blast_Chiller_${weekLabel}.xlsx`);
    showToast("Excel exportiert ✓");
  }

  function exportGSheet() {
    const tsv = planRows().map(r => r.join("\t")).join("\n");
    const copy = (text: string) => {
      if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy");
      document.body.removeChild(ta); return Promise.resolve();
    };
    copy(tsv).then(() => showToast("In Zwischenablage → Strg+V in Google Sheets ✓"));
  }

  function exportCSV() {
    const esc = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = planRows().map(r => r.map(esc).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Blast_Chiller_${weekLabel}.csv`;
    a.click();
    showToast("CSV exportiert ✓");
  }

  // ── Print via window.open ────────────────────────────────────────────────

  const esc = (s: string) => (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

  function printClassic() {
    const dayLabel = selLabel;
    const printedAt = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const pages = classicLay.sections.filter(s => s.woCount > 0);
    if (!pages.length) { showToast("Keine Daten zum Drucken"); return; }
    const pageHtml = pages.map((sec, idx) => {
      const cfg = CHILLER_CFG[sec.chillerKey];
      const showGroupHeads = sec.chillerKey === "6" || sec.reassigned;
      const body = sec.groups.map(g => {
        const head = showGroupHeads ? `<tr><td colspan="4" style="padding:7px 9px;background:#EEF2F9;font-weight:800;font-size:11px;color:${g.unknown ? "#b45309" : "#1F3864"};border:1px solid #c5cde0">${g.unknown ? "⚠ UNBEKANNT — bitte prüfen" : esc(g.allergen)} · ${g.wos.length} WOs${g.kg > 0 ? ` · ${Math.round(g.kg)} kg` : ""}</td></tr>` : "";
        return head + g.wos.map((w, i) => `
          <tr style="background:${i % 2 ? "#f7f8fb" : "#fff"}">
            <td style="padding:6px 9px;font-weight:800;color:#1F3864;border:1px solid #c5cde0;white-space:nowrap">${esc(w.wo)}${w.shift ? ` <span style="font-weight:400;color:#999">S${w.shift}</span>` : ""}</td>
            <td style="padding:6px 9px;border:1px solid #c5cde0">${esc(w.name)} <span style="color:#999;font-size:10px">${esc(cleanRecipeName(w.recipeName))}</span></td>
            <td style="padding:6px 9px;border:1px solid #c5cde0;font-size:10px;color:${w.unknown ? "#b45309" : "#555"}">${w.unknown ? "UNBEKANNT" : esc(w.allergens.join(", ") || "keine")}</td>
            <td style="padding:6px 9px;border:1px solid #c5cde0;text-align:right;font-size:10px;white-space:nowrap">${w.kg > 0 ? Math.round(w.kg) + " kg" : "—"}</td>
          </tr>`).join("");
      }).join("");
      return `
      <div style="${idx > 0 ? "page-break-before:always;" : ""}font-family:Arial,sans-serif">
        <div style="background:${cfg.headBg};border-bottom:4px solid ${cfg.cntBg};padding:16px 20px 12px">
          <div style="font-size:11px;font-weight:700;color:${cfg.headColor};opacity:.7;text-transform:uppercase;letter-spacing:1px">HelloFresh Verden — Produktionsküche</div>
          <div style="font-size:27px;font-weight:900;color:${cfg.headColor}">❄️ ${esc(sec.label)}</div>
          <div style="font-size:15px;font-weight:700;color:${cfg.headColor};opacity:.9">${esc(sec.sub)} · ${weekLabel} — ${dayLabel} · ${sec.woCount} WOs</div>
        </div>
        <table style="border-collapse:collapse;width:100%;font-size:11px;margin-top:10px">
          <thead><tr>
            <th style="background:#1F3864;color:#fff;padding:8px 9px;text-align:left;font-size:10px;width:9%;border:1px solid #1F3864">WO</th>
            <th style="background:#1F3864;color:#fff;padding:8px 9px;text-align:left;font-size:10px;width:58%;border:1px solid #1F3864">Sub-Rezept / Komponente</th>
            <th style="background:#1F3864;color:#fff;padding:8px 9px;text-align:left;font-size:10px;width:22%;border:1px solid #1F3864">Allergene</th>
            <th style="background:#1F3864;color:#fff;padding:8px 9px;text-align:right;font-size:10px;width:11%;border:1px solid #1F3864">kg</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
        <div style="border-top:1px solid #dde3ee;padding:8px 20px;display:flex;justify-content:space-between;font-size:9px;color:#aaa;margin-top:10px">
          <span>Gedruckt: ${printedAt}</span><span>Blast Chiller Bot · Klassik-Modus · HelloFresh Verden</span><span>${weekLabel} — ${dayLabel}</span>
        </div>
      </div>`;
    }).join("");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Blast Chiller ${weekLabel} (Klassik)</title>
      <style>@page{margin:8mm 12mm;size:A4 portrait}*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{background:#fff}</style>
      </head><body>${pageHtml}</body></html>`;
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) { showToast("Popup blockiert — Popup-Blocker deaktivieren"); return; }
    w.document.write(html); w.document.close(); w.focus();
    w.onload = () => w.print();
  }

  function printChillers(onlyUnit?: number) {
    if (mode === "classic") { printClassic(); return; }
    const pages: { c: PlannedChiller; dayLabel: string }[] = [];
    for (const p of exportPlans) {
      const dl = p.scope ? fmtDate(p.scope) : "Ganze Woche";
      for (const c of p.chillers) {
        if (c.groups.length === 0) continue;
        if (onlyUnit != null && c.unit !== onlyUnit) continue;
        pages.push({ c, dayLabel: dl });
      }
    }
    if (!pages.length) { showToast("Keine Daten zum Drucken"); return; }
    const printedAt = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

    const pageHtml = pages.map(({ c, dayLabel }, idx) => {
      const role = ROLE_STYLE[c.role];
      const fvCodes = [...new Set(c.groups.map(g => g.recipeCode).filter(Boolean))];
      const contains = c.role === "allergenfrei" ? "Allergenfrei"
        : c.allergens.length ? `Kann enthalten: ${esc(c.allergens.join(", "))}`
        : c.role === "unbekannt" ? "Unbekannt — bitte prüfen" : "Allergen-Pool";
      const groupHtml = [...c.groups].map(g => {
        const woRows = [...g.wos].sort((a, b) => woNum(a.wo) - woNum(b.wo)).map((wo, i) => `
          <tr style="background:${i % 2 === 0 ? "#fff" : "#f7f8fb"}">
            <td style="padding:6px 9px;font-weight:800;color:#1F3864;font-size:11px;white-space:nowrap;border:1px solid #c5cde0">${esc(wo.wo)}</td>
            <td style="padding:6px 9px;border:1px solid #c5cde0;font-size:11px">${esc(wo.name)}</td>
            <td style="padding:6px 9px;border:1px solid #c5cde0;font-size:10px;color:${wo.unknown ? "#b45309" : "#555"}">${wo.unknown ? "UNBEKANNT" : esc(wo.allergens.join(", ") || "keine")}</td>
            <td style="padding:6px 9px;border:1px solid #c5cde0;font-size:10px;text-align:right;white-space:nowrap">${wo.kg > 0 ? Math.round(wo.kg) + " kg" : "—"}</td>
          </tr>`).join("");
        const partTag = g.partCount && g.partCount > 1 ? ` <span style="color:#6A1B9A;font-weight:800">[Teil ${g.partIndex}/${g.partCount}]</span>` : "";
        const codeTag = g.recipeCode ? `<span style="font-weight:900;font-size:13px">${esc(g.recipeCode)}</span> ` : "";
        const nameTag = g.recipeName && g.recipeName !== g.recipeCode ? `<span style="font-weight:600;color:#5a6b8a">${esc(g.recipeName)}</span>` : "";
        return `
          <tr><td colspan="4" style="padding:7px 9px;background:#EEF2F9;font-weight:800;font-size:11px;color:#1F3864;border:1px solid #c5cde0">
            ${codeTag}${nameTag}${partTag}${g.allergens.length ? ` · <span style="font-weight:600;color:#666">${esc(g.allergens.join(", "))}</span>` : ""}
            <span style="float:right;font-weight:700;color:#888">${g.racks} Rack${g.racks > 1 ? "s" : ""}${g.kg > 0 ? ` · ${Math.round(g.kg)} kg` : ""}</span>
          </td></tr>${woRows}`;
      }).join("");

      return `
        <div style="${idx > 0 ? "page-break-before:always;" : ""}width:100%;min-height:99vh;display:flex;flex-direction:column;font-family:Arial,sans-serif">
          <div style="background:${role.bg};border-bottom:4px solid #1F3864;padding:16px 20px 12px">
            <div style="display:flex;align-items:flex-start;justify-content:space-between">
              <div>
                <div style="font-size:11px;font-weight:700;color:${role.color};opacity:.7;text-transform:uppercase;letter-spacing:1px">HelloFresh Verden — Produktionsküche</div>
                <div style="font-size:27px;font-weight:900;color:${role.color};line-height:1.1">❄️ Blast Chiller ${c.unit}</div>
                ${fvCodes.length ? `<div style="font-size:20px;font-weight:900;color:${role.color};margin-top:4px;letter-spacing:.5px">${fvCodes.map(esc).join(" · ")}</div>` : ""}
                <div style="font-size:15px;font-weight:700;color:${role.color};margin-top:3px;opacity:.9">${contains}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:21px;font-weight:900;color:${role.color}">${weekLabel}</div>
                <div style="font-size:12px;color:${role.color};opacity:.75;margin-top:2px">${dayLabel}</div>
                <div style="margin-top:6px;display:inline-block;background:#1F3864;color:#fff;border-radius:20px;padding:3px 12px;font-size:12px;font-weight:800">${c.racks}/${c.capRacks} Racks · ${c.woCount} WOs</div>
              </div>
            </div>
          </div>
          <div style="flex:1;padding:0 20px">
            <table style="border-collapse:collapse;width:100%;font-size:11px;margin-top:12px">
              <thead><tr>
                <th style="background:#1F3864;color:#fff;padding:8px 9px;text-align:left;font-size:10px;width:9%;border:1px solid #1F3864">WO</th>
                <th style="background:#1F3864;color:#fff;padding:8px 9px;text-align:left;font-size:10px;width:52%;border:1px solid #1F3864">Sub-Rezept / Komponente</th>
                <th style="background:#1F3864;color:#fff;padding:8px 9px;text-align:left;font-size:10px;width:27%;border:1px solid #1F3864">Allergene</th>
                <th style="background:#1F3864;color:#fff;padding:8px 9px;text-align:right;font-size:10px;width:12%;border:1px solid #1F3864">kg</th>
              </tr></thead>
              <tbody>${groupHtml}</tbody>
            </table>
          </div>
          <div style="border-top:1px solid #dde3ee;padding:8px 20px;display:flex;justify-content:space-between;font-size:9px;color:#aaa;margin-top:12px">
            <span>Gedruckt: ${printedAt}</span><span>Blast Chiller Bot · HelloFresh Verden</span><span>${weekLabel} — ${dayLabel}</span>
          </div>
        </div>`;
    }).join("");

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Blast Chiller ${weekLabel}</title>
      <style>@page{margin:8mm 12mm;size:A4 portrait}*{box-sizing:border-box;margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{background:#fff}</style>
      </head><body>${pageHtml}</body></html>`;

    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) { showToast("Popup blockiert — Popup-Blocker deaktivieren"); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    w.onload = () => w.print();
  }

  // ── Drag & Drop ───────────────────────────────────────────────────────────

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) handleCSV(f);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Styles ────────────────────────────────────────────────────────────────

  const s = {
    card:  { background: "#fff", borderRadius: 10, border: "0.5px solid #dde3ee", padding: 14 } as React.CSSProperties,
    btnSm: (bg: string, color = "#fff") => ({ padding: "5px 11px", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", background: bg, color } as React.CSSProperties),
    num:   { width: 64, padding: "4px 7px", borderRadius: 6, border: "1px solid #cdd6e6", fontSize: 12, fontWeight: 700, color: "#1F3864" } as React.CSSProperties,
  };

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ fontFamily: "Arial, sans-serif", fontSize: 13, color: "#222" }}>

      {/* Header */}
      <div style={{ background: "#1F3864", color: "#fff", padding: "13px 20px", display: "flex", alignItems: "center", gap: 11, borderRadius: "10px 10px 0 0" }}>
        <div style={{ width: 32, height: 32, background: "rgba(255,255,255,.15)", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>❄️</div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            Blast Chiller Bot
            <span style={{ background: "rgba(255,255,255,.18)", borderRadius: 4, padding: "1px 7px", fontSize: 10, marginLeft: 8 }}>{weekLabel}</span>
          </div>
          <div style={{ fontSize: 11, opacity: .7, marginTop: 1 }}>KET-CSV → Rezepte gruppiert, allergen-nah &amp; kapazitätsbewusst auf 6 Chiller verteilt (Rack-Durchsatz)</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 2, background: "rgba(255,255,255,.12)", borderRadius: 8, padding: 2 }}>
          {([["dynamic", "Dynamisch"], ["classic", "Klassisch"]] as const).map(([v, lbl]) => (
            <button key={v} onClick={() => setMode(v)}
              style={{ padding: "4px 11px", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer",
                background: mode === v ? "#fff" : "transparent", color: mode === v ? "#1F3864" : "rgba(255,255,255,.8)" }}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "14px 4px" }}>

        {/* Info banner */}
        <div style={{ marginBottom: 12, borderRadius: 9, border: "1px solid #A5D6A7", background: "#E8F5E9", padding: "10px 14px", fontSize: 11.5, color: "#1B5E20" }}>
          {mode === "classic" ? (
            <><strong>Klassik-Modus (Backup):</strong> feste Töpfe wie früher — Chiller 1&amp;2 allergenfrei · 3 Sulfit · 4 Milch · 5 beides · 6 Rest-Pool. „Unbekannt" → immer Chiller 6. Keine Kapazitäts- oder Lastverteilung.</>
          ) : (
            <><strong>So plant der Bot:</strong> Ganze Rezepte bleiben zusammen (Fisch + seine Reis-Beilage in denselben Chiller). Verteilung pro Tag nach Rack-Last — kein fixes „3 = Sulfit" mehr. Seltene Allergene (Fisch, Nüsse, Ei …) werden gebündelt, damit die anderen Chiller ein enges „kann enthalten" behalten. Ein Chiller heißt nur dann <em>Allergenfrei</em>, wenn wirklich nur allergenfreie Rezepte drin sind; „Unbekannt" kommt nie in einen sauberen Chiller.</>
          )}
        </div>

        {/* CSV Upload */}
        <div style={{ ...s.card, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1F3864", marginBottom: 9 }}>📋 KET-CSV hochladen</div>
          <div
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={onDrop}
            style={{
              border: `2px ${csvLoaded ? "solid" : "dashed"} ${csvLoaded ? "#4CAF50" : drag ? "#2E5AAC" : "#BDD5FF"}`,
              borderRadius: 9, padding: "20px 14px", textAlign: "center", cursor: "pointer",
              position: "relative", background: csvLoaded ? "#E8F5E9" : drag ? "#EDF4FF" : "#F7FAFF",
            }}
          >
            <input type="file" accept=".csv" style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", height: "100%" }}
              onChange={e => e.target.files?.[0] && handleCSV(e.target.files[0])} />
            <div style={{ fontSize: 22, marginBottom: 4 }}>{csvLoaded ? "✅" : "📊"}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: csvLoaded ? "#2E7D32" : "#2E5AAC" }}>
              {csvLoaded ? `${csvRows.length} Work Orders eingelesen — ${weekLabel}` : "KET-CSV hier ablegen oder klicken"}
            </div>
            <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
              Spalten: Work Order · Sub Recipe · Date Needed · Recipe Name · WO Cooked Portions · Kitchen Status
            </div>
          </div>

          {csvLoaded && (
            <div style={{ marginTop: 8, maxHeight: 96, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
              {csvRows.slice(0, 5).map(r => (
                <div key={r.wo} style={{ display: "flex", alignItems: "center", gap: 7, padding: "3px 7px", borderRadius: 5, fontSize: 11, background: "#E8F5E9" }}>
                  <span style={{ fontWeight: 700, color: "#1F3864", minWidth: 50 }}>{r.wo}</span>
                  <span style={{ color: "#555" }}>{r.name.substring(0, 52)}</span>
                  <span style={{ color: "#aaa", fontSize: 10, marginLeft: "auto" }}>{extractRecipeCode(r.recipe) || ""}{r.portions ? ` · ${r.portions}P` : ""}</span>
                </div>
              ))}
              {csvRows.length > 5 && <div style={{ fontSize: 10, color: "#888", padding: "2px 7px" }}>… +{csvRows.length - 5} weitere</div>}
            </div>
          )}
        </div>

        {/* Settings — nur im dynamischen Modus */}
        {mode === "dynamic" && (
        <div style={{ ...s.card, marginBottom: 12, padding: "10px 14px" }}>
          <div
            onClick={() => setShowSettings(v => !v)}
            style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#1F3864", userSelect: "none" }}
          >
            ⚙️ Einstellungen
            <span style={{ fontWeight: 400, color: "#888", fontSize: 11 }}>
              {params.racksPerCycle} Racks/Zyklus · Beladung {params.firstLoadHour}–{params.lastLoadHour} Uhr → {cyclesPerDay(params)} Zyklen ≈ {capPerDay} Racks/Chiller/Tag · {params.rackKg} kg/Rack{params.splitLargeRecipes ? " · große aufteilen" : ""}
            </span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "rgba(0,0,0,.35)", transform: showSettings ? "rotate(180deg)" : "none" }}>▼</span>
          </div>
          {showSettings && (
            <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", fontSize: 12, color: "#444" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }} title="Wie viele Racks in EINEN Chiller pro Kühlzyklus passen.">
                Racks pro Kühlzyklus
                <input type="number" min={1} style={s.num} value={params.racksPerCycle}
                  onChange={e => updateParams({ racksPerCycle: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }} title="Dauer eines Kühlzyklus (Verden ~2–3 h).">
                Stunden pro Kühlzyklus
                <input type="number" min={0.5} step={0.5} style={s.num} value={params.cycleHours}
                  onChange={e => updateParams({ cycleHours: Math.max(0.5, parseFloat(e.target.value) || 0.5) })} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }} title="Uhrzeit der ersten Rack-Beladung am Tag (2-Schicht: 8 Uhr).">
                Erste Beladung (Uhr)
                <input type="number" min={0} max={24} style={s.num} value={params.firstLoadHour}
                  onChange={e => updateParams({ firstLoadHour: Math.min(24, Math.max(0, parseInt(e.target.value, 10) || 0)) })} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }} title="Uhrzeit der letzten Rack-Beladung am Tag (2-Schicht: 23 Uhr).">
                Letzte Beladung (Uhr)
                <input type="number" min={0} max={24} style={s.num} value={params.lastLoadHour}
                  onChange={e => updateParams({ lastLoadHour: Math.min(24, Math.max(0, parseInt(e.target.value, 10) || 0)) })} />
              </label>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#1F3864" }}>= {cyclesPerDay(params)} Zyklen → {capPerDay} Racks/Chiller/Tag</span>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                kg pro Rack
                <input type="number" min={1} style={s.num} value={params.rackKg}
                  onChange={e => updateParams({ rackKg: Math.max(1, parseInt(e.target.value, 10) || 1) })} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={params.keepRecipesTogether}
                  onChange={e => updateParams({ keepRecipesTogether: e.target.checked })} />
                Ganze Rezepte zusammenhalten
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
                title="Ein Rezept, das allein einen Chiller-Tag sprengt, auf mehrere Chiller verteilen (Teil 1/2 …).">
                <input type="checkbox" checked={params.splitLargeRecipes}
                  onChange={e => updateParams({ splitLargeRecipes: e.target.checked })} />
                Große Rezepte auf mehrere Chiller aufteilen
              </label>
              <button style={s.btnSm("#eef1f6", "#555")} onClick={() => { setParams({ ...DEFAULT_CHILLER_PLAN_PARAMS }); saveParams({ ...DEFAULT_CHILLER_PLAN_PARAMS }); }}>
                zurücksetzen
              </button>
            </div>
          )}
        </div>
        )}

        {/* Process button */}
        <div style={{ textAlign: "center", marginBottom: 14 }}>
          <button
            onClick={processData}
            disabled={!csvLoaded}
            style={{ padding: "7px 14px", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: csvLoaded ? "pointer" : "not-allowed", background: csvLoaded ? "#2E5AAC" : "#ccc", color: "#fff", opacity: csvLoaded ? 1 : .4 }}
          >⚡ Chiller-Verteilung berechnen</button>
        </div>

        {/* Results */}
        {showResult && (
          <>
            {/* Bottleneck banner */}
            {mode === "dynamic" && plan.hints.length > 0 && (
              <div style={{ marginBottom: 10, borderRadius: 9, border: `1px solid ${plan.over ? "#EF9A9A" : "#FFCC80"}`, background: plan.over ? "#FFEBEE" : "#FFF8E1", padding: "10px 14px", fontSize: 11.5, color: plan.over ? "#B71C1C" : "#7B3F00" }}>
                <strong>{plan.over ? "⚠ Engpass" : "Hinweis"}</strong>
                <ul style={{ margin: "5px 0 0", paddingLeft: 18 }}>
                  {plan.hints.map((h, i) => <li key={i} style={{ marginTop: 2 }}>{prettyHint(h)}</li>)}
                </ul>
              </div>
            )}

            {/* Umfang: Wochenplan / Live-Sicht / nur neue WOs seit letztem Handout */}
            {(blastedCount > 0 || seenWeekCount > 0) && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 11, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, color: "#1F3864" }}>Umfang:</span>
                {([
                  ["all", "Alle WOs (Wochenplan)", true],
                  ["open", `Nur offen (${wos.length - blastedCount})`, blastedCount > 0],
                  ["new", `Nur neu (${newWoCount})`, seenWeekCount > 0],
                ] as const).filter(([, , show]) => show).map(([v, lbl]) => (
                  <button key={v} onClick={() => setScopeFilter(v)}
                    style={{ padding: "4px 11px", borderRadius: 20, border: "1px solid #dde3ee", cursor: "pointer", fontWeight: 700,
                      background: scopeFilter === v ? "#1F3864" : "#fff", color: scopeFilter === v ? "#fff" : "#555" }}>
                    {lbl}
                  </button>
                ))}
                <button onClick={markSeen}
                  style={{ padding: "4px 11px", borderRadius: 20, border: "1px solid #A5D6A7", cursor: "pointer", fontWeight: 700, background: "#E8F5E9", color: "#1B5E20" }}>
                  ✓ diesen Stand merken
                </button>
                {seenWeekCount > 0 && (
                  <button onClick={resetSeen} style={{ padding: "3px 8px", border: "none", background: "none", color: "#999", cursor: "pointer", fontSize: 10.5, textDecoration: "underline" }}>
                    Merker für {weekLabel} löschen
                  </button>
                )}
                <span style={{ color: "#888", flexBasis: "100%", marginTop: 2 }}>
                  {scopeFilter === "new"
                    ? `${wos.length - newWoCount} WOs waren schon in einem früheren Handout dieser KW — nur die ${newWoCount} neuen werden geplant.`
                    : scopeFilter === "open"
                    ? `${blastedCount} bereits geblastete WOs (Kitchen Status „Post Blast") ausgeblendet.`
                    : `${blastedCount ? `${blastedCount} „Post Blast" · ` : ""}${seenWeekCount ? `${seenWeekCount} WOs gemerkt · ` : ""}kompletter Plan.`}
                </span>
              </div>
            )}

            {/* Stats */}
            {mode === "dynamic" && (
            <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <StatBox label={weekLabel} value={selLabel} />
              {plan.chillers.map(c => (
                <StatBox key={c.unit} label={`Chiller ${c.unit}${plan.byDay ? " (Spitze)" : ""}`} value={`${c.racks}/${c.capRacks}`} accent={barColor(c.pct)} />
              ))}
              {plan.unknownWoCount > 0 && <StatBox label="Unbekannt" value={String(plan.unknownWoCount)} accent="#E53935" />}
            </div>
            {plan.unknownWoCount > 0 && (
              <div style={{ fontSize: 10.5, color: "#8a5a00", background: "#FFF8E1", border: "1px solid #FFE0A3", borderRadius: 7, padding: "6px 10px", marginBottom: 10 }}>
                <strong>„Unbekannt"</strong> = WOs, zu denen der Bot kein Rezept findet — im CSV fehlt der FV-Code in „Recipe Name" <em>und</em> die „Recipe ID" passt zu keinem hinterlegten Rezept (oft neue/umbenannte Rezepte). Sie kommen sicherheitshalber <strong>nie</strong> in den Allergenfrei-Bereich, sind in den Chiller-Karten mit ⚠ markiert — bitte manuell den Chiller festlegen.
              </div>
            )}
            </>
            )}

            {/* Day tabs — mehrere Tage kombinierbar (Submeals vom Vortag) */}
            {days.length > 1 && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#1F3864", marginRight: 2 }}>Tag:</span>
                <button onClick={() => setDaySel([])}
                  style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, border: "1px solid #dde3ee", cursor: "pointer", fontWeight: 700,
                    background: weekView ? "#1F3864" : "#fff", color: weekView ? "#fff" : "#555" }}>
                  Ganze Woche
                </button>
                {days.map(d => {
                  const on = selDates.includes(d);
                  return (
                    <button key={d}
                      onClick={() => setDaySel(prev => on ? prev.filter(x => x !== d) : [...prev, d])}
                      style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, border: `1px solid ${on ? "#1F3864" : "#dde3ee"}`, cursor: "pointer", fontWeight: 700,
                        background: on ? "#1F3864" : "#fff", color: on ? "#fff" : "#555" }}>
                      {on ? "✓ " : ""}{fmtDate(d)}
                    </button>
                  );
                })}
                {selDates.length >= 2 && (
                  <span style={{ fontSize: 10.5, color: "#2E7D32", fontWeight: 700 }}>
                    {selDates.length} Tage kombiniert — Kapazität {capPerDay}×{selDates.length}
                  </span>
                )}
                <span style={{ fontSize: 10, color: "#999" }}>mehrere Tage = zusammen planen</span>
              </div>
            )}

            {/* Week matrix: Rack-Last je Chiller je Tag */}
            {mode === "dynamic" && plan.byDay && (
              <div style={{ marginBottom: 12, overflowX: "auto" }}>
                <div style={{ fontSize: 10.5, color: "#888", marginBottom: 6 }}>
                  Rack-Last je Chiller je Tag · Kapazität {capPerDay}/Chiller/Tag · Zeile anklicken für den Tagesplan
                </div>
                <table style={{ borderCollapse: "collapse", fontSize: 11, minWidth: 520 }}>
                  <thead>
                    <tr>
                      <th style={{ padding: "5px 9px", textAlign: "left", color: "#1F3864", fontSize: 10 }}>Tag</th>
                      {plan.chillers.map(c => (
                        <th key={c.unit} style={{ padding: "5px 9px", color: "#1F3864", fontSize: 10 }}>C{c.unit}</th>
                      ))}
                      <th style={{ padding: "5px 9px", color: "#1F3864", fontSize: 10 }}>Σ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.byDay.map(row => (
                      <tr key={row.date} onClick={() => setDaySel([row.date])}
                        style={{ cursor: "pointer", background: row.over ? "#FFF4F4" : "#fff" }}>
                        <td style={{ padding: "5px 9px", fontWeight: 700, color: "#1F3864", whiteSpace: "nowrap", borderTop: "1px solid #eef1f6" }}>
                          {fmtDate(row.date)}{row.over ? " ⚠" : ""}
                        </td>
                        {row.units.map(u => {
                          const pct = Math.round((u.racks / capPerDay) * 100);
                          const col = barColor(pct);
                          return (
                            <td key={u.unit} style={{ padding: "4px 6px", textAlign: "center", borderTop: "1px solid #eef1f6" }}>
                              <span style={{ display: "inline-block", minWidth: 34, padding: "2px 6px", borderRadius: 5, fontWeight: 700, fontSize: 10.5,
                                background: `${col}22`, color: pct >= 80 ? col : "#455A64" }}>
                                {u.racks}
                              </span>
                            </td>
                          );
                        })}
                        <td style={{ padding: "5px 9px", textAlign: "center", fontWeight: 700, color: row.over ? "#B71C1C" : "#555", borderTop: "1px solid #eef1f6" }}>{row.totalRacks}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Export bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 12, padding: "9px 13px", background: "#fff", borderRadius: 9, border: "0.5px solid #dde3ee" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#1F3864", marginRight: 3 }}>Exportieren:</span>
              <button style={s.btnSm("#2E7D32")} onClick={exportExcel}>📥 Excel</button>
              <button style={s.btnSm("#0F9D58")} onClick={exportGSheet}>🟩 Google Sheets</button>
              <button style={s.btnSm("#6D4C41")} onClick={exportCSV}>📄 CSV</button>
              <button style={s.btnSm("#37474F")} onClick={() => printChillers()}>🖨 Drucken / PDF</button>
            </div>

            {/* Ergebnis-Darstellung */}
            {mode === "classic" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, fontSize: 11, flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontWeight: 700, color: "#1F3864" }}
                    title="Wenn Chiller 3/4/5 an dem Tag leer sind, wandert die größte Rest-Allergen-Gruppe dorthin — entlastet Chiller 6.">
                    <input type="checkbox" checked={classicUseEmpty} onChange={e => setClassicUseEmpty(e.target.checked)} />
                    Leere Chiller mitnutzen
                  </label>
                  {classicLay.movedGroups > 0 && (
                    <span style={{ color: "#2E7D32" }}>{classicLay.movedGroups} Rest-Gruppe{classicLay.movedGroups > 1 ? "n" : ""} in sonst leere Chiller verschoben</span>
                  )}
                  {classicLay.restOverloaded && (
                    <span style={{ color: "#B71C1C", fontWeight: 700 }}>⚠ Chiller 6 trägt deutlich mehr als die anderen</span>
                  )}
                </div>
                <ClassicChillerSections layout={classicLay} fmtKg={fmtKg} />
              </>
            ) : plan.byDay ? (
              <div style={{ fontSize: 11.5, color: "#555", padding: "10px 14px", background: "#F7FAFF", borderRadius: 9, border: "0.5px solid #dde3ee", marginBottom: 14 }}>
                Wähle oben einen Tag für den vollständigen Chiller-Plan mit allen Work Orders.
                {plan.over
                  ? " Rot markierte Tage sind über Kapazität — dort die größten Rezepte auf einen ruhigeren Tag ziehen."
                  : " Alle Tage liegen im Rahmen."}
              </div>
            ) : (
              <>
                {/* Einzel-Chiller-Ansicht: einen Chiller auswählen, Rest ausblenden */}
                <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginBottom: 10, fontSize: 11 }}>
                  <span style={{ fontWeight: 700, color: "#1F3864", marginRight: 2 }}>Chiller-Ansicht:</span>
                  <button onClick={() => setFocusUnit(null)}
                    style={{ padding: "4px 11px", borderRadius: 20, border: "1px solid #dde3ee", cursor: "pointer", fontWeight: 700,
                      background: focusUnit == null ? "#1F3864" : "#fff", color: focusUnit == null ? "#fff" : "#555" }}>alle</button>
                  {plan.chillers.map(c => (
                    <button key={c.unit} onClick={() => setFocusUnit(focusUnit === c.unit ? null : c.unit)}
                      style={{ padding: "4px 11px", borderRadius: 20, border: "1px solid #dde3ee", cursor: "pointer", fontWeight: 700,
                        background: focusUnit === c.unit ? "#1F3864" : c.groups.length ? "#fff" : "#f3f4f7",
                        color: focusUnit === c.unit ? "#fff" : c.groups.length ? "#555" : "#aaa" }}>
                      ❄️ {c.unit}{c.groups.length ? ` · ${c.racks}/${c.capRacks}` : ""}
                    </button>
                  ))}
                  {focusUnit != null && (
                    <button style={s.btnSm("#37474F")} onClick={() => printChillers(focusUnit)}>🖨 nur Chiller {focusUnit}</button>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
                  {plan.chillers.filter(c => focusUnit == null || c.unit === focusUnit).map(c => (
                    <ChillerCard
                      key={c.unit}
                      c={c}
                      open={focusUnit === c.unit || !collapsed[c.unit]}
                      onToggle={() => setCollapsed(m => ({ ...m, [c.unit]: !m[c.unit] }))}
                      fmtKg={fmtKg}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 16, right: 16, background: "#1F3864", color: "#fff", padding: "10px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, boxShadow: "0 3px 16px rgba(0,0,0,.22)", zIndex: 9999, maxWidth: 420 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatBox({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ background: "#fff", border: "0.5px solid #dde3ee", borderRadius: 7, padding: "6px 12px", fontSize: 11, color: "#555", borderLeft: accent ? `3px solid ${accent}` : undefined }}>
      <strong style={{ color: "#1F3864", fontSize: 13, display: "block" }}>{value}</strong>
      {label}
    </div>
  );
}

function AllergenChips({ list }: { list: string[] }) {
  if (list.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", verticalAlign: "middle" }}>
      {list.map(a => {
        const p = chip(a);
        return (
          <span key={a} style={{ fontSize: 9.5, fontWeight: 700, padding: "1px 7px", borderRadius: 20, border: `1px solid ${p.border}`, background: p.bg, color: p.color }}>{a}</span>
        );
      })}
    </span>
  );
}

function ChillerCard({
  c, open, onToggle, fmtKg,
}: {
  c: PlannedChiller;
  open: boolean;
  onToggle: () => void;
  fmtKg: (kg: number) => string;
}) {
  const role = ROLE_STYLE[c.role];
  const empty = c.groups.length === 0;
  // FV-Nummer(n) der Rezepte in diesem Chiller — groß im Kopf, damit die Küche
  // auf einen Blick sieht "Chiller 1 = FV0849A", ohne aufklappen zu müssen.
  const fvCodes = [...new Set(c.groups.map(g => g.recipeCode).filter(Boolean))];
  return (
    <div style={{ borderRadius: 9, border: "0.5px solid #dde3ee", overflow: "hidden", opacity: empty ? .6 : 1 }}>
      <button
        type="button"
        onClick={empty ? undefined : onToggle}
        aria-expanded={empty ? undefined : open}
        disabled={empty}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", background: role.bg, color: role.color, cursor: empty ? "default" : "pointer", userSelect: "none", width: "100%", border: "none", textAlign: "left", font: "inherit" }}
      >
        <span style={{ fontSize: 13, fontWeight: 800 }}>❄️ Chiller {c.unit}</span>
        {fvCodes.length > 0 && (
          <span style={{ fontSize: 16, fontWeight: 900, letterSpacing: .5, padding: "2px 11px", borderRadius: 7, background: "rgba(255,255,255,.75)", color: role.color, border: `1px solid ${role.color}44`, whiteSpace: "nowrap" }}>
            {fvCodes.join(" · ")}
          </span>
        )}
        <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 8px", borderRadius: 20, background: "rgba(255,255,255,.55)" }}>{role.label}</span>
        {c.role !== "allergenfrei" && c.allergens.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, opacity: .9 }}>
            kann enthalten: <AllergenChips list={c.allergens} />
          </span>
        )}
        {!empty && (
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 120, height: 7, borderRadius: 4, background: "rgba(0,0,0,.10)", overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${Math.min(100, c.pct)}%`, background: barColor(c.pct) }} />
            </span>
            <span style={{ fontSize: 11, fontWeight: 800, color: c.over ? "#B71C1C" : role.color }}>{c.racks}/{c.capRacks} Racks</span>
            <span style={{ fontSize: 10, opacity: .7 }}>{c.woCount} WOs</span>
            <span style={{ fontSize: 11, color: "rgba(0,0,0,.35)", transform: open ? "rotate(180deg)" : "none" }}>▼</span>
          </span>
        )}
        {empty && <span style={{ marginLeft: "auto", fontSize: 10, opacity: .6 }}>frei</span>}
      </button>

      {open && !empty && (
        <div style={{ borderTop: "1px solid rgba(0,0,0,.07)" }}>
          {[...c.groups].map((g: RecipeGroup) => (
            <div key={g.key} style={{ borderBottom: "1px solid #eef1f6" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "#f7f8fb", fontSize: 11 }}>
                {g.recipeCode && (
                  <strong style={{ color: "#1F3864", fontSize: 13, letterSpacing: .3 }}>{g.recipeCode}</strong>
                )}
                {g.recipeName && g.recipeName !== g.recipeCode && (
                  <span style={{ color: "#5a6b8a", fontWeight: 600 }}>{g.recipeName}</span>
                )}
                {g.partCount && g.partCount > 1 && (
                  <span style={{ fontSize: 9.5, fontWeight: 800, padding: "1px 7px", borderRadius: 20, background: "#E1BEE7", color: "#6A1B9A" }}>
                    Teil {g.partIndex}/{g.partCount}
                  </span>
                )}
                <AllergenChips list={g.allergens} />
                {g.hasUnknown && <span style={{ fontSize: 9.5, fontWeight: 700, color: "#b45309" }}>⚠ prüfen</span>}
                <span style={{ marginLeft: "auto", color: "#888", fontWeight: 700 }}>{g.racks} Rack{g.racks > 1 ? "s" : ""}{g.kg > 0 ? ` · ${fmtKg(g.kg)}` : ""}</span>
              </div>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
                <tbody>
                  {[...g.wos].sort((a, b) => woNum(a.wo) - woNum(b.wo)).map((wo, wi) => (
                    <tr key={`${wo.wo}-${wi}`} style={wo.blasted ? { opacity: .55 } : undefined}>
                      <td style={{ padding: "5px 12px", borderTop: "1px solid #f0f2f6", fontWeight: 700, color: "#1F3864", whiteSpace: "nowrap", width: 60 }}>
                        {wo.wo}{wo.shift ? <span style={{ fontWeight: 400, color: "#9aa3b2", marginLeft: 3 }}>S{wo.shift}</span> : null}
                      </td>
                      <td style={{ padding: "5px 8px", borderTop: "1px solid #f0f2f6" }}>
                        {wo.name}
                        {wo.blasted && <span style={{ fontSize: 9, fontWeight: 700, color: "#2E7D32", marginLeft: 6 }}>✓ geblastet</span>}
                      </td>
                      <td style={{ padding: "5px 8px", borderTop: "1px solid #f0f2f6", width: 200 }}>
                        {wo.unknown
                          ? <span style={{ fontSize: 9.5, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: "#ECEFF1", color: "#546E7A", border: "1px solid #B0BEC5" }} title={PRECISION_NOTE[wo.precision] ?? undefined}>UNBEKANNT</span>
                          : wo.allergens.length ? <AllergenChips list={wo.allergens} />
                          : <span style={{ fontSize: 9.5, color: "#8a94a6" }}>keine</span>}
                        {!wo.unknown && wo.precision !== "sub" && (
                          <span style={{ fontSize: 9, color: "#b0879b", marginLeft: 4 }} title={PRECISION_NOTE[wo.precision] ?? undefined}>≈</span>
                        )}
                      </td>
                      <td style={{ padding: "5px 12px", borderTop: "1px solid #f0f2f6", textAlign: "right", color: "#777", whiteSpace: "nowrap", width: 70 }}>{fmtKg(wo.kg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Klassik-Modus: feste Allergen-Töpfe (Backup wie der alte Bot), Chiller 6 entlastet ──

function ClassicWoRow({ w, fmtKg }: { w: ChillerWo; fmtKg: (kg: number) => string }) {
  return (
    <tr style={w.blasted ? { opacity: .55 } : undefined}>
      <td style={{ padding: "5px 12px", borderTop: "1px solid #f0f2f6", fontWeight: 700, color: "#1F3864", whiteSpace: "nowrap", width: 62 }}>
        {w.wo}{w.shift ? <span style={{ fontWeight: 400, color: "#9aa3b2", marginLeft: 3 }}>S{w.shift}</span> : null}
      </td>
      <td style={{ padding: "5px 8px", borderTop: "1px solid #f0f2f6" }}>
        {w.name}
        {w.recipeCode && <span style={{ fontSize: 10.5, fontWeight: 800, color: "#1F3864", marginLeft: 6, letterSpacing: .3 }}>{w.recipeCode}</span>}
        <span style={{ fontSize: 9.5, color: "#9aa3b2", marginLeft: 6 }}>{cleanRecipeName(w.recipeName)}</span>
        {w.blasted && <span style={{ fontSize: 9, fontWeight: 700, color: "#2E7D32", marginLeft: 6 }}>✓ geblastet</span>}
      </td>
      <td style={{ padding: "5px 8px", borderTop: "1px solid #f0f2f6", width: 210 }}>
        {w.unknown
          ? <span style={{ fontSize: 9.5, fontWeight: 700, padding: "1px 7px", borderRadius: 20, background: "#ECEFF1", color: "#546E7A", border: "1px solid #B0BEC5" }}>UNBEKANNT</span>
          : w.allergens.length ? <AllergenChips list={w.allergens} />
          : <span style={{ fontSize: 9.5, color: "#8a94a6" }}>keine</span>}
      </td>
      <td style={{ padding: "5px 12px", borderTop: "1px solid #f0f2f6", textAlign: "right", color: "#777", whiteSpace: "nowrap", width: 70 }}>{fmtKg(w.kg)}</td>
    </tr>
  );
}

function ClassicChillerSections({
  layout, fmtKg,
}: {
  layout: { sections: ClassicSection[]; restOverloaded: boolean };
  fmtKg: (kg: number) => string;
}) {
  if (layout.sections.every(s => s.woCount === 0)) {
    return <div style={{ padding: 18, textAlign: "center", color: "#aaa", fontSize: 12 }}>Keine Work Orders für diese Auswahl.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
      {layout.sections.map(sec => {
        const cfg = CHILLER_CFG[sec.chillerKey];
        const showGroupHeads = sec.chillerKey === "6" || sec.reassigned;
        const over = sec.chillerKey === "6" && layout.restOverloaded;
        return (
          <div key={sec.chillerKey} style={{ borderRadius: 9, border: `0.5px solid ${over ? "#EF9A9A" : "#dde3ee"}`, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", fontSize: 12, fontWeight: 700, background: cfg.headBg, color: cfg.headColor }}>
              <span>{sec.label}</span>
              <span style={{ fontSize: 11, fontWeight: 400, opacity: .75 }}>— {sec.sub}</span>
              {over && <span style={{ fontSize: 10, fontWeight: 700, color: "#B71C1C" }}>⚠ voll</span>}
              <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: cfg.cntBg, color: cfg.cntColor }}>
                {sec.woCount} WOs{sec.kg > 0 ? ` · ${Math.round(sec.kg)} kg` : ""}
              </span>
            </div>
            {sec.woCount > 0 && (
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
                <tbody>
                  {sec.groups.flatMap(g => [
                    ...(showGroupHeads ? [(
                      <tr key={`h-${g.allergen}`}>
                        <td colSpan={4} style={{ padding: "5px 12px", background: "#f2f5fa", fontSize: 10.5, fontWeight: 800, color: g.unknown ? "#b45309" : "#1F3864", borderTop: "1px solid #e3e8f0" }}>
                          {g.unknown ? "⚠ UNBEKANNT — bitte prüfen" : g.allergen} · {g.wos.length} WO{g.wos.length !== 1 ? "s" : ""}{g.kg > 0 ? ` · ${Math.round(g.kg)} kg` : ""}
                        </td>
                      </tr>
                    )] : []),
                    ...g.wos.map(w => <ClassicWoRow key={`${g.allergen}-${w.wo}`} w={w} fmtKg={fmtKg} />),
                  ])}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
