import { useCallback, useRef, useState } from "react";
import * as XLSX from "xlsx";
import type { DataBundle, DetailedSubRecipe } from "../../core/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CsvRow {
  wo:      string;
  name:    string;   // sub-recipe name
  recipe:  string;   // recipe code or raw recipe name column (FV0849A or "FV0849A - Zucchini …")
  date:    string;
}

interface DataRow extends CsvRow {
  allergen: string;
  chiller:  ChillerKey;
}

type ChillerKey = "1" | "3" | "4" | "5" | "6";

interface ChillerCfg {
  label: string; sub: string;
  headBg: string; headColor: string; cntBg: string; cntColor: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CHILLER_CFG: Record<ChillerKey, ChillerCfg> = {
  "1": { label:"Chiller 1 & 2", sub:"Allergenfrei",   headBg:"#E8F5E9", headColor:"#1B5E20", cntBg:"#A5D6A7", cntColor:"#1B5E20" },
  "3": { label:"Chiller 3",     sub:"Sulfite",         headBg:"#FFF8E1", headColor:"#7B3F00", cntBg:"#FFD54F", cntColor:"#7B3F00" },
  "4": { label:"Chiller 4",     sub:"Milch",           headBg:"#E3F2FD", headColor:"#0D3780", cntBg:"#90CAF9", cntColor:"#0D3780" },
  "5": { label:"Chiller 5",     sub:"Milch + Sulfite", headBg:"#F3E5F5", headColor:"#4A148C", cntBg:"#CE93D8", cntColor:"#4A148C" },
  "6": { label:"Chiller 6",     sub:"Rest-Pool",       headBg:"#FFEBEE", headColor:"#B71C1C", cntBg:"#EF9A9A", cntColor:"#B71C1C" },
};

const CHILLER_KEYS: ChillerKey[] = ["1", "3", "4", "5", "6"];

// ─── Pure Logic ───────────────────────────────────────────────────────────────

function assignChiller(allergen: string): ChillerKey {
  if (!allergen || allergen.trim().toUpperCase() === "KEINE") return "1";
  const u = allergen.toUpperCase();
  const m = u.includes("MILCH");
  const s = u.includes("SCHWEFELDIOXIDE") || u.includes("SULFITE");
  const rest = u
    .replace(/MILCH \(EINSCHLIESSLICH LAKTOSE\)/g, "")
    .replace(/SCHWEFELDIOXIDE UND SULFITE/g, "")
    .split(",").map(p => p.trim()).filter(p => p.length > 0);
  const x = rest.length > 0;
  if (x)      return "6";
  if (m && s) return "5";
  if (s)      return "3";
  if (m)      return "4";
  return "6";
}

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

// ─── Allergen from structures ─────────────────────────────────────────────────

function normStr(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

function searchSubRec(subs: DetailedSubRecipe[], targetNorm: string): DetailedSubRecipe | null {
  for (const sub of subs) {
    if (normStr(sub.name) === targetNorm) return sub;
    const found = searchSubRec(sub.subRecipes, targetNorm);
    if (found) return found;
  }
  return null;
}

function collectIngredientAllergens(sub: DetailedSubRecipe, acc: Set<string>): void {
  for (const ing of sub.ingredients) if (ing.allergen) acc.add(ing.allergen.trim());
  for (const child of sub.subRecipes) collectIngredientAllergens(child, acc);
}

/**
 * Compute the declared allergen string for a single sub-recipe (WO) using the
 * detailed structure tree already loaded in the app.
 *
 * Priority:
 *  1. Ingredient-level allergens from the matching sub-recipe node in the structure tree
 *  2. Recipe-level allergen from RecipeMarketDetails (union of all sub-recipes)
 *  3. "KEINE"
 */
function computeWoAllergen(
  data: DataBundle,
  recipeCode: string,
  subRecipeName: string,
): string {
  const structure = data.structures?.[recipeCode];

  if (structure) {
    const targetNorm = normStr(subRecipeName);
    for (const market of ["DE", "BENL", "DKSE"] as const) {
      const subs = structure.markets[market];
      if (!subs?.length) continue;
      const found = searchSubRec(subs, targetNorm);
      if (found) {
        const acc = new Set<string>();
        collectIngredientAllergens(found, acc);
        if (acc.size > 0) return [...acc].join(", ");
        // Sub-recipe found but has no ingredient-level allergens → KEINE
        return "KEINE";
      }
    }
  }

  // Fallback: recipe-level allergen (union of all sub-recipes for this recipe)
  const recipe = data.recipes[recipeCode];
  if (recipe) {
    for (const market of ["DE", "BENL", "DKSE"] as const) {
      const a = recipe.markets[market]?.allergens;
      if (a) return a;
    }
  }

  return "KEINE";
}

// ─── Pill styling ─────────────────────────────────────────────────────────────

function allergenPillStyle(a: string): { bg: string; color: string; border: string } {
  if (!a || a.toUpperCase() === "KEINE") return { bg: "#E8F5E9", color: "#1B5E20", border: "#A5D6A7" };
  const u = a.toUpperCase();
  const parts = a.split(",").map(p => p.trim()).filter(Boolean);
  if (parts.length > 1)          return { bg: "#F3E5F5", color: "#4A148C", border: "#CE93D8" };
  if (u.includes("MILCH"))       return { bg: "#E3F2FD", color: "#0D3780", border: "#90CAF9" };
  if (u.includes("SCHWEFELDIOXIDE")) return { bg: "#FFF8E1", color: "#7B3F00", border: "#FFD54F" };
  return { bg: "#FFEBEE", color: "#B71C1C", border: "#EF9A9A" };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BlastChillerView({ data }: { data: DataBundle }) {
  const [csvRows,    setCsvRows]    = useState<CsvRow[]>([]);
  const [allData,    setAllData]    = useState<DataRow[]>([]);
  const [activeDay,  setActiveDay]  = useState<"all" | string>("all");
  const [weekLabel,  setWeekLabel]  = useState("W??");
  const [collapsed,  setCollapsed]  = useState<Partial<Record<ChillerKey, boolean>>>({});
  const [showResult, setShowResult] = useState(false);
  const [csvLoaded,  setCsvLoaded]  = useState(false);
  const [drag,       setDrag]       = useState(false);
  const [toast,      setToast]      = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }

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
      if (iWo < 0 || iName < 0) { showToast("Spalten nicht gefunden — CSV prüfen"); return; }
      const rows: CsvRow[] = [];
      for (let i = 1; i < lines.length; i++) {
        const c = parseCSVLine(lines[i]);
        if (c.length < 2) continue;
        const wo   = (c[iWo]   || "").replace(/^"+|"+$/g, "").trim();
        const name = (c[iName] || "").replace(/^"+|"+$/g, "").trim();
        if (!wo || !name) continue;
        const date   = (iDate >= 0 ? c[iDate] : "").replace(/^"+|"+$/g, "").trim().split(" ")[0];
        const recipe = (iRec  >= 0 ? c[iRec]  : "").replace(/^"+|"+$/g, "").trim();
        rows.push({ wo, name, recipe, date });
      }
      setCsvRows(rows);
      setCsvLoaded(true);
      showToast(`KET-CSV geladen: ${rows.length} Work Orders ✓`);
    };
    reader.readAsText(file, "UTF-8");
  }

  // ── Process (allergens from data.structures) ──────────────────────────────

  function processData() {
    if (!csvRows.length) return;

    let fromStructure = 0, fromRecipe = 0, notFound = 0;

    const processed: DataRow[] = csvRows.map(row => {
      // Try to get recipe code from the recipe column, then from sub-recipe name
      const code = extractRecipeCode(row.recipe) ?? extractRecipeCode(row.name);

      let allergen = "KEINE";
      if (code) {
        const raw = computeWoAllergen(data, code, row.name);
        allergen = raw;
        // Track source for stats
        const structure = data.structures?.[code];
        if (structure) {
          const targetNorm = normStr(row.name);
          let found = false;
          for (const market of ["DE", "BENL", "DKSE"] as const) {
            const subs = structure.markets[market];
            if (subs && searchSubRec(subs, targetNorm)) { found = true; break; }
          }
          if (found) fromStructure++;
          else fromRecipe++;
        } else {
          fromRecipe++;
        }
      } else {
        notFound++;
      }

      return { ...row, allergen, chiller: assignChiller(allergen) };
    });

    setAllData(processed);
    setActiveDay("all");
    setShowResult(true);

    const msgs: string[] = [];
    if (fromStructure > 0) msgs.push(`${fromStructure} WOs aus Sub-Rezept-Struktur`);
    if (fromRecipe > 0)    msgs.push(`${fromRecipe} aus Rezept-Fallback`);
    if (notFound > 0)      msgs.push(`${notFound} ohne Code → KEINE`);
    showToast(msgs.join(" · ") || "Berechnet ✓");
  }

  // ── Computed ──────────────────────────────────────────────────────────────

  const filteredData = activeDay === "all" ? allData : allData.filter(d => d.date === activeDay);
  const byChiller = Object.fromEntries(
    CHILLER_KEYS.map(k => [k, filteredData.filter(d => d.chiller === k).sort((a, b) => woNum(a.wo) - woNum(b.wo))])
  ) as Record<ChillerKey, DataRow[]>;
  const days = [...new Set(allData.map(d => d.date).filter(Boolean))].sort();
  const fmtDate = (d: string) => { const dt = new Date(d); return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }); };

  // ── Exports ───────────────────────────────────────────────────────────────

  function exportExcel() {
    const wb = XLSX.utils.book_new();
    const wsData: (string | number)[][] = [[weekLabel, "", "", ""]];
    CHILLER_KEYS.forEach(k => {
      const it = byChiller[k]; if (!it?.length) return;
      const cfg = CHILLER_CFG[k];
      wsData.push(["Blast Chiller", "(WO's)", "Sub-Rezept / Komponente", "Allergene"]);
      it.forEach(d => wsData.push([`${cfg.label} (${cfg.sub})`, d.wo, d.name, d.allergen]));
    });
    wsData.push(["Blast Chiller", "(WO's)", "Sub-Rezept / Komponente", "Allergene"]);
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws["!cols"] = [{ wch: 36 }, { wch: 11 }, { wch: 60 }, { wch: 55 }];
    XLSX.utils.book_append_sheet(wb, ws, "Blast Chiller Handout " + weekLabel);
    XLSX.writeFile(wb, `Blast_Chiller_Handout_${weekLabel}.xlsx`);
    showToast("Excel exportiert ✓");
  }

  function exportCSV() {
    const esc = (v: string) => `"${(v || "").replace(/"/g, '""')}"`;
    const lines = [`${esc("Blast Chiller")},${esc("(WO's)")},${esc("Sub-Rezept / Komponente")},${esc("Allergene")}`];
    CHILLER_KEYS.forEach(k => {
      const it = byChiller[k]; if (!it?.length) return;
      const cfg = CHILLER_CFG[k];
      it.forEach(d => lines.push([esc(`${cfg.label} (${cfg.sub})`), esc(d.wo), esc(d.name), esc(d.allergen)].join(",")));
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `Blast_Chiller_Handout_${weekLabel}.csv`;
    a.click();
    showToast("CSV exportiert ✓");
  }

  function exportGSheet() {
    const lines = ["Blast Chiller\t(WO's)\tSub-Rezept / Komponente\tAllergene"];
    CHILLER_KEYS.forEach(k => {
      const it = byChiller[k]; if (!it?.length) return;
      const cfg = CHILLER_CFG[k];
      it.forEach(d => lines.push([`${cfg.label} (${cfg.sub})`, d.wo, d.name, d.allergen].join("\t")));
    });
    const copy = (text: string) => {
      if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy");
      document.body.removeChild(ta); return Promise.resolve();
    };
    copy(lines.join("\n")).then(() => showToast("In Zwischenablage → Strg+V in Google Sheets ✓"));
  }

  // ── Drag & Drop ───────────────────────────────────────────────────────────

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) handleCSV(f);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Styles ────────────────────────────────────────────────────────────────

  const s = {
    card:   { background: "#fff", borderRadius: 10, border: "0.5px solid #dde3ee", padding: 14 } as React.CSSProperties,
    btnSm:  (bg: string, color = "#fff") => ({ padding: "5px 11px", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", background: bg, color } as React.CSSProperties),
    pill:   (a: string) => { const p = allergenPillStyle(a); return { display: "inline-block", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, border: `1px solid ${p.border}`, background: p.bg, color: p.color, whiteSpace: "nowrap" as const, maxWidth: 230, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "middle" }; },
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
          <div style={{ fontSize: 11, opacity: .7, marginTop: 1 }}>KET-CSV hochladen → Allergen-Zuteilung auf Chiller 1–6 aus MSKU-Strukturdaten</div>
        </div>
      </div>

      <div style={{ padding: "14px 4px" }}>

        {/* Info banner */}
        <div style={{ marginBottom: 12, borderRadius: 9, border: "1px solid #A5D6A7", background: "#E8F5E9", padding: "10px 14px", fontSize: 11.5, color: "#1B5E20" }}>
          <strong>✓ Kein Excel-Upload nötig</strong> — Allergene werden direkt aus den MSKU-Strukturdaten berechnet (Ingredientebene je Sub-Rezept). Du brauchst nur noch den <strong>KET-CSV</strong> mit den Work Order Nummern und Sub-Rezept-Namen.
        </div>

        {/* CSV Upload */}
        <div style={{ ...s.card, marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#1F3864", marginBottom: 9 }}>📋 KET-CSV hochladen (Work Orders + Sub-Rezept-Namen)</div>
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
              Benötigte Spalten: Work Order · Sub Recipe · Date Needed · Recipe Name
            </div>
          </div>

          {/* Preview rows */}
          {csvLoaded && (
            <div style={{ marginTop: 8, maxHeight: 110, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
              {csvRows.slice(0, 5).map(r => (
                <div key={r.wo} style={{ display: "flex", alignItems: "center", gap: 7, padding: "3px 7px", borderRadius: 5, fontSize: 11, background: "#E8F5E9" }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4CAF50", flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, color: "#1F3864", minWidth: 50 }}>{r.wo}</span>
                  <span style={{ color: "#555" }}>{r.name.substring(0, 55)}</span>
                  {r.recipe && <span style={{ color: "#aaa", fontSize: 10, marginLeft: "auto" }}>{extractRecipeCode(r.recipe) || r.recipe.substring(0, 10)}</span>}
                </div>
              ))}
              {csvRows.length > 5 && <div style={{ fontSize: 10, color: "#888", padding: "2px 7px" }}>… +{csvRows.length - 5} weitere</div>}
            </div>
          )}
        </div>

        {/* Process button */}
        <div style={{ textAlign: "center", marginBottom: 14 }}>
          <button
            onClick={processData}
            disabled={!csvLoaded}
            style={{ padding: "7px 14px", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: csvLoaded ? "pointer" : "not-allowed", background: csvLoaded ? "#2E5AAC" : "#ccc", color: "#fff", opacity: csvLoaded ? 1 : .4 }}
          >⚡ Chiller-Zuteilung berechnen</button>
        </div>

        {/* Results */}
        {showResult && (
          <>
            {/* Stats */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <StatBox label="Woche" value={weekLabel} />
              {CHILLER_KEYS.map(k => <StatBox key={k} label={CHILLER_CFG[k].label} value={String(byChiller[k]?.length ?? 0)} />)}
              <StatBox label="WOs gesamt" value={String(filteredData.length)} />
            </div>

            {/* Day tabs */}
            {days.length > 1 && (
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#1F3864", marginRight: 2 }}>Tag:</span>
                {["all", ...days].map(d => (
                  <button key={d} onClick={() => setActiveDay(d)}
                    style={{ padding: "4px 12px", borderRadius: 20, fontSize: 11, border: "1px solid #dde3ee", cursor: "pointer", fontWeight: 700,
                      background: activeDay === d ? "#1F3864" : "#fff", color: activeDay === d ? "#fff" : "#555" }}>
                    {d === "all" ? "Alle" : fmtDate(d)}
                  </button>
                ))}
              </div>
            )}

            {/* Export bar */}
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", marginBottom: 12, padding: "9px 13px", background: "#fff", borderRadius: 9, border: "0.5px solid #dde3ee" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#1F3864", marginRight: 3 }}>Exportieren:</span>
              <button style={s.btnSm("#2E7D32")} onClick={exportExcel}>📥 Excel (.xlsx)</button>
              <button style={s.btnSm("#0F9D58")} onClick={exportGSheet}>🟩 Google Sheets</button>
              <button style={s.btnSm("#6D4C41")} onClick={exportCSV}>📄 CSV</button>
              <button style={s.btnSm("#37474F")} onClick={() => window.print()}>🖨 Drucken / PDF</button>
            </div>

            {/* Chiller sections */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
              {CHILLER_KEYS.map(k => {
                const cfg = CHILLER_CFG[k];
                const items = byChiller[k] ?? [];
                const open = !collapsed[k];
                return (
                  <div key={k} style={{ borderRadius: 9, border: "0.5px solid #dde3ee", overflow: "hidden" }}>
                    <div
                      onClick={() => setCollapsed(c => ({ ...c, [k]: !c[k] }))}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: cfg.headBg, color: cfg.headColor, userSelect: "none" }}
                    >
                      <span>{cfg.label}</span>
                      <span style={{ fontSize: 11, fontWeight: 400, opacity: .75 }}>&nbsp;— {cfg.sub}</span>
                      <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, padding: "2px 9px", borderRadius: 20, background: cfg.cntBg, color: cfg.cntColor }}>{items.length} WOs</span>
                      <span style={{ fontSize: 11, color: "rgba(0,0,0,.35)", transition: "transform .18s", transform: open ? "rotate(180deg)" : "none" }}>▼</span>
                    </div>
                    {open && (
                      <div style={{ borderTop: "1px solid rgba(0,0,0,.07)" }}>
                        {items.length === 0 ? (
                          <div style={{ textAlign: "center", padding: 18, color: "#aaa", fontSize: 11 }}>Keine Work Orders für diesen Tag</div>
                        ) : (
                          <div style={{ overflowX: "auto" }}>
                            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11.5 }}>
                              <thead>
                                <tr>
                                  {["WO", "Sub-Rezept / Komponente", "Allergene (aus MSKU-Struktur)"].map((h, i) => (
                                    <th key={i} style={{ background: "#1F3864", color: "#fff", padding: "7px 8px", fontSize: 10, fontWeight: 700, textAlign: "left", border: "0.5px solid rgba(255,255,255,.1)", whiteSpace: "nowrap" }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {items.map(d => (
                                  <tr key={d.wo}>
                                    <td style={{ padding: "6px 8px", border: "0.5px solid rgba(0,0,0,.07)", fontSize: 11, fontWeight: 700, color: "#1F3864", whiteSpace: "nowrap" }}>{d.wo}</td>
                                    <td style={{ padding: "6px 8px", border: "0.5px solid rgba(0,0,0,.07)" }}>
                                      <div style={{ fontSize: 11.5, fontWeight: 600 }}>{d.name}</div>
                                      {d.recipe && (
                                        <div style={{ fontSize: 10, color: "#888", marginTop: 1 }}>
                                          {extractRecipeCode(d.recipe) || d.recipe}
                                        </div>
                                      )}
                                    </td>
                                    <td style={{ padding: "6px 8px", border: "0.5px solid rgba(0,0,0,.07)" }}>
                                      <span style={s.pill(d.allergen)}>{d.allergen || "KEINE"}</span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 16, right: 16, background: "#1F3864", color: "#fff", padding: "10px 16px", borderRadius: 8, fontSize: 12, fontWeight: 700, boxShadow: "0 3px 16px rgba(0,0,0,.22)", zIndex: 9999 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: "#fff", border: "0.5px solid #dde3ee", borderRadius: 7, padding: "6px 12px", fontSize: 11, color: "#555" }}>
      <strong style={{ color: "#1F3864", fontSize: 13, display: "block" }}>{value}</strong>
      {label}
    </div>
  );
}
