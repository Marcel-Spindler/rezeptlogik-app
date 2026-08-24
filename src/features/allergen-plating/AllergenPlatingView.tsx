import React, { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import type { DataBundle, DetailedSubRecipe } from "../../core/types";
import { currentHfWeek } from "../../lib/wmsCache";

// ─── Constants ────────────────────────────────────────────────────────────────

const AM: Record<string, string> = {
  "MILCH (EINSCHLIESSLICH LAKTOSE)": "Milch (Laktose)",
  "SCHWEFELDIOXIDE UND SULFITE":      "Sulfite / Schwefeldioxid",
  "FISCH":           "Fisch",
  "EIER":            "Eier",
  "SESAMSAMEN":      "Sesam",
  "SESAM":           "Sesam",
  "SELLERIE":        "Sellerie",
  "SENF":            "Senf",
  "SCHALENFRÜCHTE":  "Nüsse / Schalenfrüchte",
  "KASCHUNÜSSE":     "Nüsse / Schalenfrüchte",
  "MANDELN":         "Nüsse / Schalenfrüchte",
  "NÜSSE":           "Nüsse / Schalenfrüchte",
  "SOJA":            "Soja",
  "GLUTENHALTIGES GETREIDE": "Weizen / Gluten",
  "WEIZEN":          "Weizen / Gluten",
};

const COLS = [
  "Milch (Laktose)", "Sulfite / Schwefeldioxid", "Fisch", "Eier",
  "Sesam", "Sellerie", "Senf", "Nüsse / Schalenfrüchte", "Soja", "Weizen / Gluten",
];

const PALETTE = [
  "#FFE0E0","#FFE8CC","#FFF5CC","#E0F2D6","#D6EAF8",
  "#E8D6F8","#D6F2EE","#FDECEA","#E8F0FE","#F8D6E8",
  "#D6F0F8","#F0F8D6","#F8ECD6","#E0E8FF","#FFD6F0",
  "#D6FFE8","#FFF0D6","#E8FFD6","#D6D6FF","#FFE8E8",
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface SubResult {
  name:      string;
  allergens: Set<string>;
}

interface Result {
  name:       string;
  allergens:  Set<string>;  // union over all sub-recipes (from structures)
  found:      boolean;
  matchedTo?: string;
  recipeCode?: string;
  subs:       SubResult[];  // per-sub-recipe breakdown
}

interface IndexEntry {
  allergenRaw: string;
  displayName: string;
  recipeCode:  string;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function normStr(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

function cleanRecipeName(raw: string): string {
  return raw
    .replace(/^(?:FE|FV)\d{4}[A-Z0-9]?\s*-\s*/i, "")
    .replace(/\s*\[(?:DE|BENL|DKSE|BNL|NORDICS)\]\s*$/i, "")
    .trim();
}

function tokenScoreNorm(a: string, b: string): number {
  const ta = a.split(/\s+/).filter(x => x.length > 2);
  const tb = new Set(b.split(/\s+/).filter(x => x.length > 2));
  if (!ta.length || !tb.size) return 0;
  return ta.filter(t => tb.has(t)).length / Math.max(ta.length, tb.size);
}

/** Map a raw MSKU allergen string (comma-separated) to canonical column names */
function extractAllergens(raw: string): Set<string> {
  const s = new Set<string>();
  (raw || "").split(",").forEach(a => {
    const u = a.trim().toUpperCase();
    for (const [k, v] of Object.entries(AM)) {
      if (u.includes(k)) s.add(v);
    }
  });
  return s;
}

/** Map a single ingredient allergen value to canonical column names */
function mapIngAllergen(raw: string): Set<string> {
  const s = new Set<string>();
  const u = (raw || "").toUpperCase();
  for (const [k, v] of Object.entries(AM)) {
    if (u.includes(k)) s.add(v);
  }
  return s;
}

/** Recursively collect all ingredient allergen strings in a sub-recipe tree */
function collectIngredientAllergens(sub: DetailedSubRecipe, acc: Set<string>): void {
  for (const ing of sub.ingredients) if (ing.allergen) acc.add(ing.allergen.trim());
  for (const child of sub.subRecipes) collectIngredientAllergens(child, acc);
}

/** Compute canonical allergens for one sub-recipe (ingredient-level) */
function subRecipeAllergens(sub: DetailedSubRecipe): Set<string> {
  const raw = new Set<string>();
  collectIngredientAllergens(sub, raw);
  const mapped = new Set<string>();
  raw.forEach(r => mapIngAllergen(r).forEach(m => mapped.add(m)));
  return mapped;
}

// ─── Build recipe index ───────────────────────────────────────────────────────

function buildRecipeIndex(data: DataBundle): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();

  for (const [code, recipe] of Object.entries(data.recipes)) {
    const allergenRaw =
      recipe.markets["DE"]?.allergens ||
      recipe.markets["BENL"]?.allergens ||
      recipe.markets["DKSE"]?.allergens ||
      "";

    const entry: IndexEntry = { allergenRaw, displayName: recipe.baseName, recipeCode: code };

    const nameCandidates: string[] = [recipe.baseName];
    for (const mkt of Object.values(recipe.markets)) {
      if (mkt?.recipeNameLocal) {
        nameCandidates.push(mkt.recipeNameLocal);
        nameCandidates.push(cleanRecipeName(mkt.recipeNameLocal));
      }
    }

    for (const name of nameCandidates) {
      if (!name) continue;
      const key = normStr(name);
      if (key && !map.has(key)) map.set(key, entry);
    }
  }

  return map;
}

function findBestMatch(
  inputName: string,
  index: Map<string, IndexEntry>,
): { entry: IndexEntry; score: number } | null {
  const inputNorm = normStr(inputName);

  const exact = index.get(inputNorm);
  if (exact) return { entry: exact, score: 1.0 };

  let best: { entry: IndexEntry; score: number } | null = null;
  for (const [key, entry] of index) {
    let score = 0;
    if (key.includes(inputNorm) || inputNorm.includes(key)) {
      score = 0.9 + Math.min(inputNorm.length, key.length) / 10_000;
    } else {
      score = tokenScoreNorm(inputNorm, key);
    }
    if (score > 0.35 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }
  return best;
}

// ─── Color assignment ─────────────────────────────────────────────────────────

function buildColorMap(results: Result[]): Record<string, string> {
  const map: Record<string, string> = {};
  let idx = 0;
  for (const r of results) {
    const key = [...r.allergens].sort().join("|");
    if (key && !map[key]) { map[key] = PALETTE[idx % PALETTE.length]; idx++; }
  }
  return map;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AllergenPlatingView({ data }: { data: DataBundle }) {
  const [recipeText, setRecipeText] = useState("");
  const [weekLabel,  setWeekLabel]  = useState("W??");
  const [results,    setResults]    = useState<Result[]>([]);
  const [showResult, setShowResult] = useState(false);
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set());
  const [toast,      setToast]      = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recipeIndex = useMemo(() => buildRecipeIndex(data), [data]);

  // Aktuelle Woche aus weekRecipes (dynamisch statt hart kodiert)
  const currentWeekData = useMemo(() => {
    const hfWeek = currentHfWeek();
    const weekShort = hfWeek.replace(/^\d{4}-/, "");
    const meals = data.weekRecipes.filter(wr => wr.hfWeek === hfWeek);
    if (meals.length > 0) return { weekShort, meals };
    // Fallback: neueste vorhandene Woche
    const sorted = [...new Set(data.weekRecipes.map(wr => wr.hfWeek))].sort();
    const latest = sorted[sorted.length - 1];
    if (!latest) return { weekShort: "W??", meals: [] as typeof data.weekRecipes };
    return { weekShort: latest.replace(/^\d{4}-/, ""), meals: data.weekRecipes.filter(wr => wr.hfWeek === latest) };
  }, [data.weekRecipes]);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }

  function getRecipes() {
    return recipeText.split("\n").map(l => l.trim()).filter(l => l.length > 1);
  }

  const canProcess = getRecipes().length > 0;

  // ── Process ───────────────────────────────────────────────────────────────

  function processData() {
    const recipes = getRecipes();
    if (!recipes.length) return;

    const sorted: Result[] = recipes
      .map(name => {
        const match = findBestMatch(name, recipeIndex);
        if (!match) return { name, allergens: new Set<string>(), found: false, subs: [] };

        const code = match.entry.recipeCode;

        // Compute per-sub-recipe allergens from structures
        const subs: SubResult[] = [];
        const structure = data.structures?.[code];
        if (structure) {
          for (const market of ["DE", "BENL", "DKSE"] as const) {
            const marketSubs = structure.markets[market];
            if (marketSubs?.length) {
              for (const sub of marketSubs) {
                subs.push({ name: sub.name, allergens: subRecipeAllergens(sub) });
              }
              break;
            }
          }
        }

        // Union allergens over all sub-recipes; fallback to MSKU recipe-level
        const overallAllergens = new Set<string>();
        if (subs.length > 0) {
          subs.forEach(s => s.allergens.forEach(a => overallAllergens.add(a)));
        } else {
          extractAllergens(match.entry.allergenRaw).forEach(a => overallAllergens.add(a));
        }

        return {
          name,
          allergens: overallAllergens,
          found: true,
          matchedTo: match.entry.displayName,
          recipeCode: code,
          subs,
        };
      })
      .sort((a, b) => {
        if (a.allergens.size !== b.allergens.size) return a.allergens.size - b.allergens.size;
        return [...a.allergens].sort().join("|").localeCompare([...b.allergens].sort().join("|"));
      });

    setResults(sorted);
    setExpanded(new Set(sorted.map(r => r.name))); // expand all by default
    setShowResult(true);

    const notFound = sorted.filter(r => !r.found).length;
    if (notFound > 0) showToast(`${sorted.length - notFound} gefunden, ${notFound} nicht in App-Daten`);
    else showToast(`Alle ${sorted.length} Rezepte mit Sub-Meals geladen ✓`);
  }

  // ── Live preview ──────────────────────────────────────────────────────────

  function matchPreview() {
    const recipes = getRecipes();
    if (!recipes.length) return null;
    return recipes.slice(0, 8).map(name => {
      const m = findBestMatch(name, recipeIndex);
      const hasSubs = m ? !!(data.structures?.[m.entry.recipeCode]) : false;
      return (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 7px", borderRadius: 6, fontSize: 11, background: m ? "#E8F5E9" : "#FFF8E1" }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: m ? "#4CAF50" : "#FF9800" }} />
          <div style={{ flex: 1, fontWeight: 600, color: "#222" }}>{name}</div>
          <div style={{ color: "#888", fontSize: 10, display: "flex", gap: 5 }}>
            {m ? `→ ${m.entry.displayName.substring(0, 35)}` : "nicht in App-Daten"}
            {hasSubs && <span style={{ background: "#E3F2FD", color: "#1565C0", borderRadius: 4, padding: "0px 4px", fontSize: 9, fontWeight: 700 }}>Sub-Meals ✓</span>}
          </div>
        </div>
      );
    });
  }

  // ── Toggle expand ─────────────────────────────────────────────────────────

  function toggleExpanded(name: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  // ── Colors & Legend ───────────────────────────────────────────────────────

  const colorMap = buildColorMap(results);
  const getColor = (key: string) => key === "" ? "#FFFFFF" : (colorMap[key] ?? "#fff");

  function buildLegend() {
    const keys = [...new Set(results.map(r => [...r.allergens].sort().join("|")))];
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {keys.includes("") && <LegendItem color="#fff" label="Keine Allergene" />}
        {keys.filter(k => k !== "").map(k => (
          <LegendItem key={k} color={getColor(k)} label={k.split("|").join(" + ")} />
        ))}
      </div>
    );
  }

  // ── Export ────────────────────────────────────────────────────────────────

  function exportExcel() {
    if (!results.length) return;
    const wb = XLSX.utils.book_new();
    const rows: (string | number)[][] = [
      [`${weekLabel} – Allergenkennzeichnung (inkl. Sub-Meals)`],
      ["Code", "Rezept / Sub-Meal", ...COLS],
    ];
    results.forEach(r => {
      rows.push([r.recipeCode ?? "", `▶ ${r.name}`, ...COLS.map(c => r.allergens.has(c) ? "X" : "")]);
      r.subs.forEach(s => {
        rows.push(["", `    ↳ ${s.name}`, ...COLS.map(c => s.allergens.has(c) ? "x" : "")]);
      });
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 10 }, { wch: 50 }, ...COLS.map(() => ({ wch: 14 }))];
    XLSX.utils.book_append_sheet(wb, ws, `${weekLabel} Allergene`);
    XLSX.writeFile(wb, `${weekLabel}_Allergene_Plating.xlsx`);
    showToast("Detail-Export exportiert ✓");
  }

  /** Farbiger Export — nur Hauptmenüs (zugeklappt), als HTML-Tabelle die Excel öffnen kann */
  function exportExcelCollapsed() {
    if (!results.length) return;

    const headers = ["Code", "Rezeptname", ...COLS, "Allergen-Profil"];

    const headerCells = headers.map((h, i) =>
      `<th style="background:#1F3864;color:#fff;padding:7px 9px;border:1px solid #0d2347;font-size:10px;font-weight:bold;white-space:nowrap;${i > 1 && i < headers.length - 1 ? "text-align:center;" : "text-align:left;"}">${h}</th>`
    ).join("");

    const dataRows = results.map(r => {
      const key     = [...r.allergens].sort().join("|");
      const bg      = getColor(key);
      const profile = r.allergens.size > 0 ? [...r.allergens].sort().join(" + ") : "Keine Allergene";
      const cells = [r.recipeCode ?? "", r.name, ...COLS.map(c => r.allergens.has(c) ? "X" : ""), profile]
        .map((v, i) => {
          const center = i > 1 && i < headers.length - 1;
          const isX    = v === "X";
          return `<td style="background:${bg};padding:6px 8px;border:1px solid #ccc;font-size:${i === 1 ? 11 : 10}px;font-weight:${i <= 1 || isX ? "bold" : "normal"};${center ? "text-align:center;" : ""}${isX ? "color:#B71C1C;" : "color:#555;"}">${v}</td>`;
        }).join("");
      return `<tr>${cells}</tr>`;
    }).join("");

    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="UTF-8">
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
<x:Name>${weekLabel} Übersicht</x:Name>
<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
</head><body>
<table border="1" style="border-collapse:collapse;font-family:Arial,sans-serif;">
  <thead><tr>${headerCells}</tr></thead>
  <tbody>${dataRows}</tbody>
</table>
</body></html>`;

    const blob = new Blob(["﻿" + html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${weekLabel}_Allergene_Uebersicht_farbig.xls`;
    a.click();
    showToast("Farb-Export exportiert ✓ (als .xls mit Farben)");
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  const found = results.filter(r => r.found).length;

  const s = {
    card: { background: "#fff", borderRadius: 10, border: "0.5px solid #dde3ee", padding: 14 } as React.CSSProperties,
    btnPrimary: (disabled?: boolean) => ({ padding: "7px 14px", border: "none", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", background: disabled ? "#ccc" : "#2E5AAC", color: "#fff", opacity: disabled ? .4 : 1 } as React.CSSProperties),
    btnSm: (bg: string, color = "#444") => ({ padding: "4px 10px", border: "none", borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: "pointer", background: bg, color } as React.CSSProperties),
  };

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ fontFamily: "Arial, sans-serif", fontSize: 13, color: "#222" }}>

      {/* Header */}
      <div style={{ background: "#1F3864", color: "#fff", padding: "13px 20px", display: "flex", alignItems: "center", gap: 11, borderRadius: "10px 10px 0 0" }}>
        <div style={{ width: 32, height: 32, background: "rgba(255,255,255,.15)", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>🥗</div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            Allergen Plating Bot
            <span style={{ background: "rgba(255,255,255,.18)", borderRadius: 4, padding: "1px 7px", fontSize: 10, marginLeft: 8 }}>
              {recipeIndex.size} Rezepte in App-Daten
            </span>
          </div>
          <div style={{ fontSize: 11, opacity: .7, marginTop: 1 }}>
            Allergene pro Sub-Meal (Ingredient-Ebene aus MSKU-Struktur) · kein Datei-Upload nötig
          </div>
        </div>
      </div>

      <div style={{ padding: "14px 4px" }}>

        {/* Info banner */}
        <div style={{ marginBottom: 12, borderRadius: 9, border: "1px solid #A5D6A7", background: "#E8F5E9", padding: "10px 14px", fontSize: 11.5, color: "#1B5E20" }}>
          <strong>✓ Keine Datei-Uploads nötig</strong> — Allergene werden pro <strong>Sub-Meal</strong> aus der MSKU-Ingredient-Struktur berechnet. Das Haupt-Menü zeigt die Gesamt-Union, darunter siehst du jedes Sub-Meal mit seinen eigenen Allergenen.
        </div>

        {/* Two columns */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>

          {/* Recipe names */}
          <div style={s.card}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#1F3864", marginBottom: 9 }}>📋 Rezeptnamen einfügen (einen pro Zeile)</div>
            <textarea
              value={recipeText}
              onChange={e => setRecipeText(e.target.value)}
              rows={13}
              placeholder={"Cabbage in Cheese Sauce & Minced Beef\nSalmon and Sweet Soy Dressing\n…"}
              style={{ width: "100%", border: "1px solid #d0d8e8", borderRadius: 7, padding: 9, fontSize: 12, fontFamily: "Arial, sans-serif", resize: "vertical", color: "#333", outline: "none", boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button style={s.btnSm("#f0f2f5")} onClick={() => { setRecipeText(currentWeekData.meals.map(m => m.recipeName).join("\n")); setWeekLabel(currentWeekData.weekShort); }}>{currentWeekData.weekShort} laden</button>
              <button style={s.btnSm("#f0f2f5")} onClick={() => setRecipeText("")}>✕ Leeren</button>
              <span style={{ fontSize: 11, color: "#888", marginLeft: "auto" }}>{getRecipes().length} Rezepte</span>
            </div>
          </div>

          {/* Live preview */}
          <div style={s.card}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#1F3864", marginBottom: 9 }}>🔍 Matching-Vorschau (App-Daten)</div>
            {getRecipes().length > 0 ? (
              <>
                <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
                  {matchPreview()}
                  {getRecipes().length > 8 && (
                    <div style={{ fontSize: 10, color: "#888", padding: "4px 7px" }}>… +{getRecipes().length - 8} weitere</div>
                  )}
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "#888" }}>KW-Label:</span>
                  <input
                    value={weekLabel}
                    onChange={e => setWeekLabel(e.target.value)}
                    style={{ border: "1px solid #d0d8e8", borderRadius: 5, padding: "3px 7px", fontSize: 11, width: 70 }}
                  />
                </div>
              </>
            ) : (
              <div style={{ color: "#aaa", fontSize: 11, textAlign: "center", marginTop: 40 }}>
                Rezeptnamen links eingeben →<br/>Matching-Vorschau erscheint automatisch
              </div>
            )}
          </div>
        </div>

        {/* Process button */}
        <div style={{ textAlign: "center", marginBottom: 14 }}>
          <button style={s.btnPrimary(!canProcess)} onClick={processData} disabled={!canProcess}>
            ⚡ Allergene & Sub-Meals aus App-Daten laden
          </button>
        </div>

        {/* Results */}
        {showResult && (
          <>
            {/* Stats */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <StatBox label="Woche" value={weekLabel} />
              <StatBox label="Rezepte" value={String(results.length)} />
              <StatBox label="gefunden" value={String(found)} borderColor="#4CAF50" valueColor="#2E7D32" />
              <StatBox label="Sub-Meals gesamt" value={String(results.reduce((n, r) => n + r.subs.length, 0))} borderColor="#2E5AAC" valueColor="#1F3864" />
              {results.length - found > 0 && (
                <StatBox label="nicht gefunden" value={String(results.length - found)} borderColor="#FF9800" valueColor="#E65100" />
              )}
            </div>

            {buildLegend()}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={s.btnSm("#E3F2FD", "#1565C0")} onClick={() => setExpanded(new Set(results.map(r => r.name)))}>Alle aufklappen</button>
                <button style={s.btnSm("#f0f2f5")} onClick={() => setExpanded(new Set())}>Alle zuklappen</button>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button style={s.btnSm("#2E7D32", "#fff")} onClick={exportExcel}>📥 Detail-Export (mit Sub-Meals)</button>
                <button style={s.btnSm("#1F3864", "#fff")} onClick={exportExcelCollapsed}>🎨 Farb-Export (Übersicht)</button>
              </div>
            </div>

            {/* Table */}
            <div style={{ overflowX: "auto", borderRadius: 9, border: "0.5px solid #dde3ee" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 700, fontSize: 11.5 }}>
                <thead>
                  <tr>
                    <th style={{ background: "#1F3864", color: "#fff", padding: "7px 5px 7px 10px", fontSize: 10, fontWeight: 700, textAlign: "left", border: "0.5px solid rgba(255,255,255,.1)", minWidth: 220 }}>
                      Hauptmenü / Sub-Meal
                    </th>
                    {COLS.map(c => (
                      <th key={c} style={{ background: "#1F3864", color: "#fff", padding: "7px 5px", fontSize: 10, fontWeight: 700, textAlign: "center", border: "0.5px solid rgba(255,255,255,.1)", whiteSpace: "nowrap" }}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map(r => {
                    const key = [...r.allergens].sort().join("|");
                    const bg = getColor(key);
                    const isExpanded = expanded.has(r.name);
                    const hasSubs = r.subs.length > 0;

                    return (
                      <React.Fragment key={r.name}>
                        {/* ── Main recipe row ── */}
                        <tr
                          style={{ background: bg, cursor: hasSubs ? "pointer" : "default" }}
                          onClick={() => hasSubs && toggleExpanded(r.name)}
                        >
                          <td style={{ padding: "7px 10px", border: "0.5px solid rgba(0,0,0,.08)", verticalAlign: "middle" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              {hasSubs && (
                                <span style={{ fontSize: 10, color: "#1F3864", transition: "transform .15s", transform: isExpanded ? "rotate(90deg)" : "none", display: "inline-block", flexShrink: 0 }}>▶</span>
                              )}
                              <div>
                                <span style={{ fontSize: 12, fontWeight: 800, color: r.found ? "#1F3864" : "#999", fontStyle: r.found ? "normal" : "italic" }}>
                                  {r.recipeCode ? `${r.recipeCode} - ${r.name}` : r.name}
                                </span>
                                {r.matchedTo && r.matchedTo !== r.name && (
                                  <div style={{ fontSize: 9.5, color: "#888", marginTop: 1 }}>→ {r.matchedTo}</div>
                                )}
                                {hasSubs && (
                                  <div style={{ fontSize: 9.5, color: "#1F3864", opacity: .6, marginTop: 1 }}>
                                    {r.subs.length} Sub-Meal{r.subs.length !== 1 ? "s" : ""}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          {COLS.map(c => (
                            <td key={c} style={{ padding: "7px 5px", border: "0.5px solid rgba(0,0,0,.08)", textAlign: "center", fontWeight: r.allergens.has(c) ? 900 : 400, fontSize: r.allergens.has(c) ? 13 : 10, color: r.allergens.has(c) ? "#111" : "rgba(0,0,0,.18)" }}>
                              {r.allergens.has(c) ? "X" : "–"}
                            </td>
                          ))}
                        </tr>

                        {/* ── Sub-recipe rows ── */}
                        {isExpanded && r.subs.map((sub, si) => (
                          <tr key={`${r.name}-sub-${si}`} style={{ background: si % 2 === 0 ? "rgba(255,255,255,0.65)" : "rgba(240,243,252,0.65)" }}>
                            <td style={{ padding: "5px 10px 5px 30px", border: "0.5px solid rgba(0,0,0,.06)", verticalAlign: "middle", borderLeft: `3px solid ${bg === "#FFFFFF" ? "#ccc" : bg}` }}>
                              <div style={{ fontSize: 11, color: "#444", fontWeight: 600 }}>
                                ↳ {sub.name}
                              </div>
                              {sub.allergens.size === 0 && (
                                <div style={{ fontSize: 9.5, color: "#aaa" }}>Keine deklarierten Allergene</div>
                              )}
                            </td>
                            {COLS.map(c => (
                              <td key={c} style={{ padding: "5px", border: "0.5px solid rgba(0,0,0,.06)", textAlign: "center", fontSize: sub.allergens.has(c) ? 11 : 10, fontWeight: sub.allergens.has(c) ? 700 : 400, color: sub.allergens.has(c) ? "#333" : "rgba(0,0,0,.13)" }}>
                                {sub.allergens.has(c) ? "x" : "·"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Not found hint */}
            {results.some(r => !r.found) && (
              <div style={{ marginTop: 10, padding: "9px 12px", background: "#FFF8E1", border: "1px solid #FFD54F", borderRadius: 7, fontSize: 11, color: "#7B3F00" }}>
                <strong>Nicht gefundene Rezepte:</strong>
                <ul style={{ marginTop: 4, marginBottom: 0, paddingLeft: 18 }}>
                  {results.filter(r => !r.found).map(r => <li key={r.name}>{r.name}</li>)}
                </ul>
              </div>
            )}
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

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#333", background: "#fff", border: "0.5px solid #dde3ee", borderRadius: 6, padding: "3px 9px" }}>
      <div style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0, border: "0.5px solid rgba(0,0,0,.1)", background: color }} />
      {label}
    </div>
  );
}

function StatBox({ label, value, borderColor, valueColor }: { label: string; value: string; borderColor?: string; valueColor?: string }) {
  return (
    <div style={{ background: "#fff", border: `0.5px solid ${borderColor ?? "#dde3ee"}`, borderRadius: 7, padding: "6px 12px", fontSize: 11, color: "#555" }}>
      <strong style={{ color: valueColor ?? "#1F3864", fontSize: 13, display: "block" }}>{value}</strong>
      {label}
    </div>
  );
}
