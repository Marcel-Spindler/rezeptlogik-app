// KetBreakdownView.tsx – KET Plan → WO Breakdown → PDF
// Upload KET CSV directly; falls back to data.productionPlan.
// Equipment capacities are user-editable, saved to localStorage.

import { useState, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";
import type {
  DataBundle,
  GrossIngredient,
  WorkOrderEntry,
  DetailedSubRecipe,
  DetailedIngredient,
  RecipeStructure,
} from "./types";

// ── Equipment priorities & defaults ───────────────────────────────────────

const EQUIP_PRIORITY = [
  "BRAISER",
  "OVEN",
  "PLANETARY MIXER",
  "HORIZONTAL MIXER",
  "PATTY MAKER",
  "HOT SHREDDER",
  "CUPPING",
  "BRINE",
];

const EQUIP_DEFAULTS: Record<string, number> = {
  BRAISER: 80,
  OVEN: 60,
  "PLANETARY MIXER": 30,
  "HORIZONTAL MIXER": 50,
  "PATTY MAKER": 400,
  "HOT SHREDDER": 20,
  CUPPING: 50,
};

const EQUIP_LABELS: Record<string, string> = {
  BRAISER: "Braiser",
  OVEN: "Ofen",
  "PLANETARY MIXER": "Planetary Mixer",
  "HORIZONTAL MIXER": "Horizontal Mixer",
  "PATTY MAKER": "Patty Maker",
  "HOT SHREDDER": "Hot Shredder",
  CUPPING: "Cupping",
  BRINE: "Brine",
};

const LS_CAPS_KEY = "ket_breakdown_caps_v2";

// ── Types ──────────────────────────────────────────────────────────────────

interface KetRow {
  key: string;
  dateNeeded: string;
  shift: string;
  woNumber: string;
  recipeId: string;
  recipeCode: string;
  recipeName: string;
  subRecipeName: string;
  cookMethods: string[];
  woCookedPortions: number | null;
  targetPortions: number;
  cookedPortionsExcess: number | null;
  stagingStatus: string;
  stagingComment: string;
  kitchenStatus: string;
  unlockedEta: string;
  workOrderComment: string;
}

interface IngCalc {
  name: string;
  id: string;
  category: string;
  uom: string;
  totalKg: number;
  perBatchKg: number;
  yieldPct: number | null;
}

interface BatchCalc {
  totalKg: number;
  primaryEquip: string | null;
  capacityKg: number | null;
  batches: number;
  perBatchKg: number;
  ingredients: IngCalc[];
  recipeFound: boolean;
  subRecipeFound: boolean;
  cookingInstructions: string | null;
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function extractCode(name: string): string {
  return name.trim().match(/^([A-Z]{2}\d{4}[A-Z0-9]+)/)?.[1] ?? "";
}

function cleanRecipeName(name: string): string {
  return name
    .replace(/^[A-Z]{2}\d{4}[A-Z0-9]+\s*[-–]\s*/, "")
    .replace(/\s*\[(?:DE|BNL|DKSE|BENL)\]\s*$/i, "")
    .trim();
}

function normStr(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fmtKg(kg: number): string {
  if (kg === 0) return "0 kg";
  if (kg < 0.1) return `${(kg * 1000).toFixed(0)} g`;
  if (kg < 1) return `${(kg * 1000).toFixed(0)} g`;
  return `${kg.toFixed(1).replace(".", ",")} kg`;
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("de-DE");
}

function parseDateShift(dateNeeded: string): { date: string; shift: string } {
  const m = dateNeeded.match(/^(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d+)/);
  if (m) return { date: m[1], shift: m[2] };
  return { date: dateNeeded, shift: "" };
}

function parseSortKey(dateNeeded: string): number {
  const { date, shift } = parseDateShift(dateNeeded);
  return Date.parse(date) * 10 + parseInt(shift || "0");
}

function fmtDateHeader(dateNeeded: string): string {
  const { date, shift } = parseDateShift(dateNeeded);
  const d = new Date(date);
  const dayName = d.toLocaleDateString("de-DE", { weekday: "short" });
  const dateStr = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  return shift ? `${dayName} ${dateStr} · Shift ${shift}` : `${dayName} ${dateStr}`;
}

// ── Recipe structure helpers ───────────────────────────────────────────────

function findDetailedSub(
  structure: RecipeStructure,
  subName: string,
): DetailedSubRecipe | null {
  const norm = normStr(subName);
  for (const mkt of ["DE", "BENL", "DKSE"] as const) {
    const roots = structure.markets[mkt];
    if (!roots) continue;
    for (const root of roots) {
      const found = searchSubRec(root, norm);
      if (found) return found;
    }
  }
  return null;
}

function searchSubRec(node: DetailedSubRecipe, normTarget: string): DetailedSubRecipe | null {
  if (normStr(node.name) === normTarget) return node;
  for (const child of node.subRecipes) {
    const f = searchSubRec(child, normTarget);
    if (f) return f;
  }
  return null;
}

function collectDetailedIngredients(sub: DetailedSubRecipe): DetailedIngredient[] {
  return [
    ...sub.ingredients,
    ...sub.subRecipes.flatMap(collectDetailedIngredients),
  ];
}

// ── Gross-ingredient fallback ──────────────────────────────────────────────

function matchGrossIngredients(
  grossMap: Partial<Record<"DE" | "BENL" | "DKSE", GrossIngredient[]>>,
  subName: string,
): GrossIngredient[] {
  const norm = normStr(subName);
  for (const mkt of ["DE", "BENL", "DKSE"] as const) {
    const list = grossMap[mkt];
    if (!list?.length) continue;
    const hits = list.filter((g) => {
      return (
        normStr(g.subRecipe1 ?? "") === norm ||
        normStr(g.subRecipe2 ?? "") === norm ||
        normStr(g.subRecipe3 ?? "") === norm
      );
    });
    if (hits.length) return hits;
  }
  return [];
}

// ── Batch calculation ──────────────────────────────────────────────────────

function calcBatch(
  row: KetRow,
  caps: Record<string, number>,
  data: DataBundle,
): BatchCalc {
  const recipe = data.recipes[row.recipeCode];
  const structure = data.structures?.[row.recipeCode];
  let ingredients: IngCalc[] = [];
  let totalKg = 0;
  let subRecipeFound = false;
  let cookingInstructions: string | null = null;

  if (recipe || structure) {
    // Try detailed structure first (more accurate)
    if (structure) {
      const sub = findDetailedSub(structure, row.subRecipeName);
      if (sub) {
        subRecipeFound = true;
        cookingInstructions = sub.categories ?? null;
        const ings = collectDetailedIngredients(sub);
        for (const ing of ings) {
          const uomLc = (ing.uom ?? "").toLowerCase();
          const kgPer =
            uomLc === "g" || uomLc === "gram" || uomLc === "grams"
              ? ing.grossQty / 1000
              : uomLc === "kg"
                ? ing.grossQty
                : ing.grossQty / 1000; // default assume grams
          const ingKg = kgPer * row.targetPortions;
          totalKg += ingKg;
          ingredients.push({
            name: ing.name,
            id: ing.id,
            category: "", // DetailedIngredient has no category; fill from gross below
            uom: ing.uom,
            totalKg: ingKg,
            perBatchKg: 0,
            yieldPct: ing.yieldPct ?? null,
          });
        }
      }
    }

    // Fallback: grossIngredients (adds category info)
    if (!subRecipeFound && recipe) {
      const grossHits = matchGrossIngredients(recipe.grossIngredients, row.subRecipeName);
      if (grossHits.length) {
        subRecipeFound = true;
        for (const g of grossHits) {
          const uomLc = (g.uom ?? "").toLowerCase();
          const kgPer =
            uomLc === "g" || uomLc === "gram" || uomLc === "grams"
              ? g.grossQuantityPerPortion / 1000
              : g.grossQuantityPerPortion;
          const ingKg = kgPer * row.targetPortions;
          totalKg += ingKg;
          ingredients.push({
            name: g.ingredient,
            id: g.ingredientId,
            category: g.ingredientCategory ?? "",
            uom: g.uom,
            totalKg: ingKg,
            perBatchKg: 0,
            yieldPct: null,
          });
        }
      }
    }

    // Merge categories from gross into structure-sourced ingredients
    if (subRecipeFound && structure && recipe) {
      const grossHits = matchGrossIngredients(recipe.grossIngredients, row.subRecipeName);
      const catLookup = new Map(grossHits.map((g) => [normStr(g.ingredient), g.ingredientCategory ?? ""]));
      for (const ing of ingredients) {
        if (!ing.category) ing.category = catLookup.get(normStr(ing.name)) ?? "";
      }
    }
  }

  // Determine primary capacity-limiting equipment
  const effectiveCap = (e: string) =>
    caps[e] !== undefined ? caps[e] : (EQUIP_DEFAULTS[e] ?? 0);

  const primaryEquip =
    EQUIP_PRIORITY.find((e) => row.cookMethods.includes(e) && effectiveCap(e) > 0) ??
    row.cookMethods.find((m) => effectiveCap(m) > 0) ??
    null;

  const capacityKg = primaryEquip ? effectiveCap(primaryEquip) : null;

  const batches =
    capacityKg && capacityKg > 0 && totalKg > 0
      ? Math.max(1, Math.ceil(totalKg / capacityKg))
      : totalKg > 0
        ? 1
        : 0;

  const perBatchKg = batches > 0 ? totalKg / batches : 0;

  for (const ing of ingredients) {
    ing.perBatchKg = batches > 0 ? ing.totalKg / batches : 0;
  }

  return {
    totalKg,
    primaryEquip,
    capacityKg,
    batches,
    perBatchKg,
    ingredients,
    recipeFound: !!(recipe || structure),
    subRecipeFound,
    cookingInstructions,
  };
}

// ── CSV parsers ────────────────────────────────────────────────────────────

function parseKetCsv(text: string): KetRow[] {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  return result.data
    .map((row, idx) => {
      const recipeName = (row["Recipe Name"] ?? "").trim();
      const recipeCode = extractCode(recipeName);
      const woNumber = (row["Work Order Number"] ?? "").trim();
      const dateNeeded = (row["Date Needed"] ?? "").trim();
      const { shift } = parseDateShift(dateNeeded);
      const cookRaw = (row["Cook Methods"] ?? "").trim();
      const cookMethods = cookRaw
        ? cookRaw.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean)
        : [];
      const targetPortions = parseFloat(row["Target Portions"] ?? "0") || 0;
      const woCookedPortions =
        row["WO Cooked Portions"] ? parseFloat(row["WO Cooked Portions"]) || null : null;
      const cookedPortionsExcess =
        row["Cooked Portions Excess"] ? parseFloat(row["Cooked Portions Excess"]) || null : null;

      return {
        key: `csv::${idx}::${dateNeeded}::${woNumber}`,
        dateNeeded,
        shift,
        woNumber,
        recipeId: (row["Recipe ID"] ?? "").trim(),
        recipeCode,
        recipeName: cleanRecipeName(recipeName),
        subRecipeName: (row["Sub Recipe Name"] ?? "").trim(),
        cookMethods,
        woCookedPortions,
        targetPortions,
        cookedPortionsExcess,
        stagingStatus: (row["Staging Status"] ?? "").trim(),
        stagingComment: (row["Staging Comment"] ?? "").trim(),
        kitchenStatus: (row["Kitchen Status"] ?? "").trim(),
        unlockedEta: (row["Unlocked ETA"] ?? "").trim(),
        workOrderComment: (row["Work Order Comment"] ?? "").trim(),
      } satisfies KetRow;
    })
    .filter((r) => r.woNumber);
}

function woEntriesToKetRows(rows: WorkOrderEntry[]): KetRow[] {
  return rows
    .filter((r) => r.workOrder && r.recipeCode)
    .map((r, idx) => {
      const dateNeeded = r.kitchenDay ?? "";
      const { shift } = parseDateShift(dateNeeded);
      return {
        key: `wo::${idx}::${dateNeeded}::${r.workOrder}`,
        dateNeeded,
        shift,
        woNumber: r.workOrder,
        recipeId: r.recipeId ?? "",
        recipeCode: r.recipeCode,
        recipeName: cleanRecipeName(r.recipeName),
        subRecipeName: r.subRecipe ?? "",
        cookMethods: r.cookMethods
          ? r.cookMethods.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean)
          : [],
        woCookedPortions: r.woCookedPortions ?? null,
        targetPortions: r.targetPortions ?? r.plannedMeals ?? 0,
        cookedPortionsExcess: r.cookedPortionsExcess ?? null,
        stagingStatus: r.stagingStatus ?? "",
        stagingComment: r.stagingComment ?? "",
        kitchenStatus: r.kitchenStatus ?? "",
        unlockedEta: r.unlockedEta ?? "",
        workOrderComment: r.workOrderComment ?? "",
      };
    });
}

// ── Status helpers ─────────────────────────────────────────────────────────

function statusColors(status: string): { bg: string; text: string; dot: string } {
  if (status === "Post Blast")    return { bg: "bg-emerald-100", text: "text-emerald-800", dot: "bg-emerald-500" };
  if (status === "Pre Blast")     return { bg: "bg-amber-100",   text: "text-amber-800",   dot: "bg-amber-500"   };
  if (status === "Staged")        return { bg: "bg-green-100",   text: "text-green-800",   dot: "bg-green-500"   };
  if (status === "Partially Staged") return { bg: "bg-orange-100", text: "text-orange-800", dot: "bg-orange-500" };
  if (status === "Picking")       return { bg: "bg-blue-100",    text: "text-blue-800",    dot: "bg-blue-500"    };
  if (status === "Released")      return { bg: "bg-purple-100",  text: "text-purple-800",  dot: "bg-purple-500"  };
  if (status === "Open")          return { bg: "bg-violet-100",  text: "text-violet-800",  dot: "bg-violet-500"  };
  if (status === "Not Started")   return { bg: "bg-slate-100",   text: "text-slate-600",   dot: "bg-slate-400"   };
  return { bg: "bg-slate-100", text: "text-slate-500", dot: "bg-slate-300" };
}

function catColor(cat: string): string {
  const c = cat.toUpperCase();
  if (c === "PRO") return "text-red-700 bg-red-50";
  if (c === "PHF") return "text-blue-700 bg-blue-50";
  if (c === "SPI") return "text-amber-700 bg-amber-50";
  if (c === "DRY") return "text-slate-600 bg-slate-100";
  return "text-slate-500 bg-slate-50";
}

// ── PDF builder ────────────────────────────────────────────────────────────

function buildPdf(rows: KetRow[], calcMap: Map<string, BatchCalc>, caps: Record<string, number>, title: string): string {

  const cards = rows.map((row, i) => {
    const calc = calcMap.get(row.key);
    if (!calc) return "";

    const { date, shift } = parseDateShift(row.dateNeeded);
    const d = new Date(date);
    const dateStr = d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

    const done = row.woCookedPortions ?? 0;
    const remaining = Math.max(0, row.targetPortions - done);
    const donePct = row.targetPortions > 0 ? Math.round((done / row.targetPortions) * 100) : 0;
    const cookDisplay = row.cookMethods.join(" · ") || "—";

    const ingRows = calc.ingredients
      .filter((ing) => ing.totalKg > 0.0005)
      .sort((a, b) => b.totalKg - a.totalKg)
      .map((ing) => {
        const catBg =
          ing.category === "PRO" ? "#fee2e2" :
          ing.category === "PHF" ? "#dbeafe" :
          ing.category === "SPI" ? "#fef9c3" :
          ing.category === "DRY" ? "#f3f4f6" : "#fff";
        return `<tr style="background:${catBg}">
          <td>
            ${ing.category ? `<span class="cat">${ing.category}</span>` : ""}
            ${ing.name}
          </td>
          <td class="num">${fmtKg(ing.totalKg)}</td>
          <td class="num hi">${fmtKg(ing.perBatchKg)}</td>
        </tr>`;
      }).join("");

    const equip = calc.primaryEquip ? (EQUIP_LABELS[calc.primaryEquip] ?? calc.primaryEquip) : "—";
    const cap = calc.capacityKg ? `${calc.capacityKg} kg` : "—";

    return `
<section class="card" style="page-break-after:${i < rows.length - 1 ? "always" : "auto"}">
  <div class="card-top">
    <div>
      <div class="wo-num">WO ${row.woNumber}</div>
      <div class="date-tag">${dateStr}${shift ? ` · Shift ${shift}` : ""}</div>
    </div>
    <div class="recipe-tag">
      <div class="code">${row.recipeCode}</div>
      <div class="rname">${row.recipeName}</div>
    </div>
  </div>

  <div class="sub">${row.subRecipeName || "—"}</div>

  <div class="methods">${cookDisplay}</div>

  <div class="stats">
    <div class="stat">
      <div class="slabel">Ziel-Portionen</div>
      <div class="sval">${fmtNum(row.targetPortions)}</div>
    </div>
    <div class="stat">
      <div class="slabel">Gekocht / Rest</div>
      <div class="sval">${fmtNum(done)} <span style="font-size:12px;color:#6b7280">/ ${fmtNum(remaining)}</span></div>
      ${donePct > 0 ? `<div style="font-size:9px;color:#059669;font-weight:700;margin-top:1px">${donePct}% fertig</div>` : ""}
    </div>
    <div class="stat">
      <div class="slabel">Total KG</div>
      <div class="sval">${calc.totalKg > 0 ? fmtKg(calc.totalKg) : (calc.recipeFound ? "kein Sub" : "Rezept?")}</div>
    </div>
    <div class="stat">
      <div class="slabel">Equipment</div>
      <div class="sval" style="font-size:13px">${equip}</div>
      <div style="font-size:9px;color:#6b7280;margin-top:1px">${cap} / Batch</div>
    </div>
    <div class="stat hi-stat">
      <div class="slabel">BATCHE</div>
      <div class="sval big">${calc.batches > 0 ? calc.batches : "—"}</div>
    </div>
    <div class="stat">
      <div class="slabel">Pro Batch</div>
      <div class="sval">${calc.perBatchKg > 0 ? fmtKg(calc.perBatchKg) : "—"}</div>
    </div>
  </div>

  <div class="badges">
    <span class="badge ${row.kitchenStatus === "Post Blast" ? "badge-green" : row.kitchenStatus === "Pre Blast" ? "badge-amber" : "badge-gray"}">
      Kitchen: ${row.kitchenStatus || "—"}
    </span>
    <span class="badge ${row.stagingStatus === "Staged" ? "badge-green" : row.stagingStatus === "Partially Staged" ? "badge-orange" : row.stagingStatus === "Picking" ? "badge-blue" : "badge-gray"}">
      Staging: ${row.stagingStatus || "—"}
    </span>
    ${row.cookedPortionsExcess != null ? `<span class="badge ${(row.cookedPortionsExcess ?? 0) >= 0 ? "badge-green" : "badge-red"}">Excess: ${(row.cookedPortionsExcess ?? 0) > 0 ? "+" : ""}${fmtNum(row.cookedPortionsExcess ?? 0)}</span>` : ""}
  </div>

  ${row.workOrderComment ? `<div class="comment warn">⚠ ${row.workOrderComment}</div>` : ""}
  ${row.stagingComment ? `<div class="comment info">💬 ${row.stagingComment}</div>` : ""}

  ${ingRows ? `
  <table class="ings">
    <thead><tr><th>Zutat</th><th class="num">Total</th><th class="num hi">Pro Batch</th></tr></thead>
    <tbody>${ingRows}</tbody>
    <tfoot><tr>
      <td><strong>GESAMT</strong></td>
      <td class="num"><strong>${fmtKg(calc.totalKg)}</strong></td>
      <td class="num hi"><strong>${fmtKg(calc.perBatchKg)}</strong></td>
    </tr></tfoot>
  </table>` : `
  <div class="no-data">${!calc.recipeFound ? "⚠ Rezept nicht in App-Daten — KG-Berechnung nicht möglich." : "⚠ Sub-Rezept in Zutaten nicht gefunden."}</div>`}
</section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:11px;color:#111;background:#fff}
.page-header{padding:14px 16px 6px;border-bottom:2px solid #1e3a5f}
.page-title{font-size:18px;font-weight:900;color:#1e3a5f}
.page-meta{font-size:9px;color:#9ca3af;margin-top:2px}
.equip-section{display:flex;gap:16px;align-items:flex-start;padding:8px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb}
.equip-label{font-size:9px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
.equip-grid{display:flex;flex-wrap:wrap;gap:4px}
.equip-chip{background:#1e3a5f;color:#fff;font-size:9px;font-weight:700;padding:2px 7px;border-radius:10px}
.card{padding:14px 16px;border:2px solid #e2e8f0;border-radius:10px;margin:10px;background:#fff}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.wo-num{font-size:26px;font-weight:900;color:#1e3a5f;line-height:1}
.date-tag{font-size:10px;color:#6b7280;margin-top:3px}
.recipe-tag{text-align:right}
.code{font-size:10px;font-weight:700;color:#9ca3af;font-family:monospace}
.rname{font-size:11px;font-weight:600;color:#374151;max-width:260px}
.sub{font-size:17px;font-weight:900;color:#111;border-bottom:2px solid #e2e8f0;padding-bottom:7px;margin-bottom:8px}
.methods{background:#1e3a5f;color:#fff;border-radius:7px;padding:8px 13px;font-size:12px;font-weight:700;letter-spacing:.02em;margin-bottom:10px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px}
.stat{background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:7px 10px}
.hi-stat{background:#1e3a5f;border-color:#1e3a5f}
.slabel{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:2px}
.hi-stat .slabel{color:#93c5fd}
.sval{font-size:19px;font-weight:900;color:#111;line-height:1.1}
.hi-stat .sval{color:#fff}
.sval.big{font-size:34px}
.badges{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}
.badge{font-size:9px;font-weight:700;padding:2px 7px;border-radius:5px}
.badge-green{background:#d1fae5;color:#065f46}
.badge-amber{background:#fef3c7;color:#92400e}
.badge-orange{background:#ffedd5;color:#9a3412}
.badge-blue{background:#dbeafe;color:#1e40af}
.badge-gray{background:#f1f5f9;color:#475569}
.badge-red{background:#fee2e2;color:#991b1b}
.comment{font-size:10px;padding:5px 8px;border-radius:5px;margin-bottom:4px}
.comment.warn{background:#fef3c7;color:#92400e}
.comment.info{background:#f1f5f9;color:#374151}
.ings{width:100%;border-collapse:collapse;margin-top:8px;font-size:10px}
.ings th{background:#f1f5f9;padding:5px 8px;text-align:left;font-weight:700;font-size:9px;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e2e8f0}
.ings td{padding:4px 8px;border-bottom:1px solid #f1f5f9}
.ings tfoot td{border-top:2px solid #e2e8f0;padding-top:5px}
.num{text-align:right;white-space:nowrap;font-weight:600}
.hi{color:#1e40af;font-weight:700}
.cat{display:inline-block;font-size:8px;font-weight:700;padding:1px 4px;border-radius:3px;background:#f1f5f9;color:#64748b;margin-right:4px}
.no-data{padding:8px;background:#fef3c7;border-radius:6px;font-size:10px;color:#92400e;margin-top:8px}
@media print{
  body{font-size:10px}
  .card{page-break-inside:avoid;margin:4px;border-width:1px}
  @page{size:A4;margin:10mm}
}
</style>
</head>
<body>
<div class="page-header">
  <div class="page-title">${title}</div>
  <div class="page-meta">Generiert: ${new Date().toLocaleString("de-DE")} · ${rows.length} Work Orders</div>
</div>
<div class="equip-section">
  <div>
    <div class="equip-label">Equipment-Kapazitäten</div>
    <div class="equip-grid">
      ${Object.entries({ ...EQUIP_DEFAULTS, ...caps }).filter(([, v]) => v > 0)
        .map(([k, v]) => `<span class="equip-chip">${EQUIP_LABELS[k] ?? k}: ${v} kg</span>`).join("")}
    </div>
  </div>
</div>
${cards}
</body>
</html>`;
}

// ── Main Component ─────────────────────────────────────────────────────────

export function KetBreakdownView({ data }: { data: DataBundle }) {
  const [csvRows, setCsvRows] = useState<KetRow[] | null>(null);
  const [csvFileName, setCsvFileName] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [showEquip, setShowEquip] = useState(false);
  const [woSearch, setWoSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [caps, setCaps] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem(LS_CAPS_KEY);
      return saved ? { ...EQUIP_DEFAULTS, ...JSON.parse(saved) } : { ...EQUIP_DEFAULTS };
    } catch {
      return { ...EQUIP_DEFAULTS };
    }
  });
  const [capInputs, setCapInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries({ ...EQUIP_DEFAULTS }).map(([k, v]) => [k, String(v)]),
    ),
  );

  const ketRows = useMemo<KetRow[]>(() => {
    if (csvRows !== null) return csvRows;
    const rows = data.productionPlan?.rows;
    if (rows?.length) return woEntriesToKetRows(rows);
    return [];
  }, [csvRows, data.productionPlan?.rows]);

  const calcMap = useMemo(() => {
    const m = new Map<string, BatchCalc>();
    for (const row of ketRows) m.set(row.key, calcBatch(row, caps, data));
    return m;
  }, [ketRows, caps, data]);

  const groups = useMemo(() => {
    const m = new Map<string, KetRow[]>();
    for (const row of ketRows) {
      if (!m.has(row.dateNeeded)) m.set(row.dateNeeded, []);
      m.get(row.dateNeeded)!.push(row);
    }
    return [...m.entries()].sort((a, b) => parseSortKey(a[0]) - parseSortKey(b[0]));
  }, [ketRows]);

  const needle = woSearch.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!needle) return groups;
    return groups
      .map(([k, rows]) => [k, rows.filter((r) =>
        [r.woNumber, r.recipeCode, r.recipeName, r.subRecipeName].join(" ").toLowerCase().includes(needle)
      )] as [string, KetRow[]])
      .filter(([, rows]) => rows.length > 0);
  }, [groups, needle]);

  const filteredRows = filteredGroups.flatMap(([, rows]) => rows);

  const selectedRow = ketRows.find((r) => r.key === selectedKey) ?? null;
  const selectedCalc = selectedKey ? (calcMap.get(selectedKey) ?? null) : null;

  const handleFile = useCallback((file: File) => {
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseKetCsv(text);
      setCsvRows(parsed);
      setSelectedKey(parsed[0]?.key ?? null);
    };
    reader.readAsText(file, "utf-8");
  }, []);

  function saveCap(equip: string, raw: string) {
    const val = parseFloat(raw.replace(",", ".")) || 0;
    const next = { ...caps, [equip]: val };
    setCaps(next);
    try { localStorage.setItem(LS_CAPS_KEY, JSON.stringify(next)); } catch { /* */ }
  }

  function printPdf(rows: KetRow[]) {
    const title = `KET Breakdown – ${new Date().toLocaleDateString("de-DE")}`;
    const html = buildPdf(rows, calcMap, caps, title);
    const w = window.open("", "_blank", "width=960,height=750");
    if (!w) { alert("Popup blockiert – bitte für diese Seite erlauben."); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 450);
  }

  const source = csvRows !== null ? "CSV" : data.productionPlan ? "Firestore" : null;
  const totalBatches = [...calcMap.values()].reduce((s, c) => s + c.batches, 0);

  return (
    <div className="flex h-[calc(100vh-112px)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">

      {/* ════════════════════════════════════════════════════
          LEFT SIDEBAR
      ════════════════════════════════════════════════════ */}
      <aside className="w-[280px] shrink-0 flex flex-col border-r border-slate-200 overflow-hidden">

        {/* Header */}
        <div className="px-4 pt-4 pb-3 bg-gradient-to-b from-[#0f2240] to-[#1e3a5f]">
          <div className="text-[9px] font-bold text-blue-300 uppercase tracking-[0.15em] mb-1">
            KET Plan · WO Ausdruck
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-white tabular-nums">{ketRows.length}</span>
            <span className="text-xs text-blue-300">WOs</span>
            {totalBatches > 0 && (
              <>
                <span className="text-blue-600">·</span>
                <span className="text-lg font-black text-blue-200 tabular-nums">{totalBatches}</span>
                <span className="text-xs text-blue-300">Batche</span>
              </>
            )}
          </div>
          {source && (
            <div className="text-[9px] text-blue-400 mt-1 font-mono truncate">
              {source === "CSV" ? `✓ ${csvFileName}` : "Quelle: Firestore"}
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
              onClick={() => { setCsvRows(null); setCsvFileName(""); setSelectedKey(null); }}
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

        {/* WO List */}
        <div className="flex-1 overflow-y-auto py-1">
          {ketRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-4">
              <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mb-3">
                <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              </div>
              <p className="text-xs font-semibold text-slate-500">Kein KET-Plan geladen</p>
              <p className="text-[10px] text-slate-400 mt-1">CSV hochladen oder Woche mit Produktionsplan wählen</p>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400">Keine WOs gefunden</div>
          ) : (
            filteredGroups.map(([date, rows]) => (
              <div key={date} className="mb-1">
                <div className="sticky top-0 px-3 py-1.5 bg-slate-50/90 backdrop-blur-sm border-y border-slate-100 z-10">
                  <span className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
                    {fmtDateHeader(date)}
                  </span>
                  <span className="ml-2 text-[9px] text-slate-300">{rows.length} WOs</span>
                </div>
                <div className="px-2 py-1 space-y-1">
                  {rows.map((row) => {
                    const calc = calcMap.get(row.key);
                    const isSelected = selectedKey === row.key;
                    const sc = statusColors(row.kitchenStatus);
                    const done = row.woCookedPortions ?? 0;
                    const pct = row.targetPortions > 0 ? (done / row.targetPortions) * 100 : 0;
                    return (
                      <button
                        type="button"
                        key={row.key}
                        onClick={() => setSelectedKey(row.key)}
                        className={`w-full text-left rounded-xl px-3 py-2.5 transition-all ${
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
                              <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-md ${isSelected ? "bg-white/20 text-white" : "bg-blue-100 text-blue-700"}`}>
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
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Print buttons */}
        <div className="px-3 py-2.5 border-t border-slate-100 space-y-1.5 bg-slate-50/50">
          <button
            type="button"
            onClick={() => selectedRow && printPdf([selectedRow])}
            disabled={!selectedRow}
            className="w-full flex items-center justify-center gap-2 text-xs font-bold bg-[#1e3a5f] hover:bg-[#162d4a] disabled:opacity-30 disabled:cursor-not-allowed text-white py-2.5 rounded-xl transition-colors shadow-sm"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
            PDF – Ausgewählte WO
          </button>
          <button
            type="button"
            onClick={() => printPdf(needle ? filteredRows : ketRows)}
            disabled={ketRows.length === 0}
            className="w-full text-xs font-bold bg-white hover:bg-slate-100 disabled:opacity-30 text-slate-600 py-2 rounded-xl transition-colors border border-slate-200"
          >
            PDF – Alle ({needle ? filteredRows.length : ketRows.length}) WOs
          </button>
        </div>
      </aside>

      {/* ════════════════════════════════════════════════════
          RIGHT DETAIL AREA
      ════════════════════════════════════════════════════ */}
      <main className="flex-1 overflow-y-auto min-w-0 bg-slate-50/30">
        {!selectedRow ? (
          <EmptyState hasData={ketRows.length > 0} />
        ) : (
          <WoDetail
            row={selectedRow}
            calc={selectedCalc}
            caps={caps}
            onPrint={() => printPdf([selectedRow])}
          />
        )}
      </main>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────

function EmptyState({ hasData }: { hasData: boolean }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-xs px-6">
        <div className="w-16 h-16 rounded-3xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
        </div>
        <p className="text-sm font-bold text-slate-600">
          {hasData ? "Work Order wählen" : "KET Plan laden"}
        </p>
        <p className="text-xs text-slate-400 mt-1">
          {hasData
            ? "Klicke links auf eine Work Order für den Breakdown"
            : "Lade deine KET CSV hoch oder wähle eine Woche mit Produktionsplan"}
        </p>
      </div>
    </div>
  );
}

// ── WO Detail ──────────────────────────────────────────────────────────────

function WoDetail({
  row,
  calc,
  caps,
  onPrint,
}: {
  row: KetRow;
  calc: BatchCalc | null;
  caps: Record<string, number>;
  onPrint: () => void;
}) {
  if (!calc) return null;

  const done = row.woCookedPortions ?? 0;
  const remaining = Math.max(0, row.targetPortions - done);
  const donePct = row.targetPortions > 0 ? Math.round((done / row.targetPortions) * 100) : 0;
  const equip = calc.primaryEquip ? (EQUIP_LABELS[calc.primaryEquip] ?? calc.primaryEquip) : null;
  const cap = calc.primaryEquip
    ? (caps[calc.primaryEquip] ?? EQUIP_DEFAULTS[calc.primaryEquip] ?? null)
    : null;

  return (
    <div>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-gradient-to-r from-[#0f2240] via-[#1e3a5f] to-[#0f2240] px-6 py-4 shadow-lg">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap mb-0.5">
              <span className="text-2xl font-black text-white">WO {row.woNumber}</span>
              <span className="font-mono text-xs text-blue-300">{row.recipeCode}</span>
              <span className="text-xs text-blue-400">{fmtDateHeader(row.dateNeeded)}</span>
            </div>
            <div className="text-sm font-bold text-blue-100 truncate">{row.recipeName}</div>
            <div className="text-xs text-blue-300/80 mt-0.5 truncate">{row.subRecipeName}</div>
          </div>
          <button
            type="button"
            onClick={onPrint}
            className="shrink-0 flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-colors border border-white/10"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
            PDF drucken
          </button>
        </div>
      </div>

      <div className="p-5 space-y-4">

        {/* Cook Methods */}
        <div className="bg-[#0f2240] rounded-2xl px-5 py-4">
          <div className="text-[8px] font-black uppercase tracking-[0.15em] text-blue-400 mb-2.5">
            Cook Methods
          </div>
          <div className="flex flex-wrap gap-2">
            {row.cookMethods.length > 0 ? row.cookMethods.map((m) => (
              <span
                key={m}
                className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-xl transition-colors ${
                  m === calc.primaryEquip
                    ? "bg-blue-500 text-white ring-2 ring-blue-300/40"
                    : "bg-white/10 text-blue-200"
                }`}
              >
                {m === calc.primaryEquip && <span className="w-1.5 h-1.5 rounded-full bg-blue-300"></span>}
                {m}
              </span>
            )) : (
              <span className="text-blue-400/60 text-sm italic">Keine Cook Methods</span>
            )}
          </div>
          {calc.primaryEquip && (
            <div className="mt-2.5 text-[10px] text-blue-300">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block mr-1.5"></span>
              <strong>{equip}</strong> ist kapazitätsbestimmendes Equipment
              {cap ? ` · ${cap} kg/Batch` : ""}
            </div>
          )}
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <StatCard label="Ziel-Portionen" value={fmtNum(row.targetPortions)} />
          <StatCard
            label="Gekocht / Rest"
            value={`${fmtNum(done)} / ${fmtNum(remaining)}`}
            sub={donePct > 0 ? `${donePct}% fertig` : undefined}
            subGreen={donePct > 0}
          />
          <StatCard
            label="Total KG (Roh)"
            value={calc.totalKg > 0 ? fmtKg(calc.totalKg) : "—"}
            warn={!calc.recipeFound ? "Rezept nicht gefunden" : !calc.subRecipeFound ? "Sub-Rezept ?" : undefined}
          />
          {equip && (
            <StatCard
              label="Equipment"
              value={equip}
              sub={cap ? `${cap} kg Kapazität/Batch` : undefined}
            />
          )}
          <StatCard label="Batche" value={calc.batches > 0 ? String(calc.batches) : "—"} highlight sub={calc.perBatchKg > 0 ? `à ${fmtKg(calc.perBatchKg)}` : undefined} />
          <StatCard label="Pro Batch" value={calc.perBatchKg > 0 ? fmtKg(calc.perBatchKg) : "—"} />
        </div>

        {/* Progress bar */}
        {donePct > 0 && (
          <div>
            <div className="flex justify-between text-[9px] font-bold text-slate-400 mb-1">
              <span>Fortschritt</span>
              <span>{donePct}%</span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${donePct >= 100 ? "bg-emerald-500" : "bg-blue-500"}`}
                style={{ width: `${Math.min(100, donePct)}%` }}
              />
            </div>
          </div>
        )}

        {/* Status row */}
        <div className="flex flex-wrap gap-2">
          <StatusChip label="Kitchen" value={row.kitchenStatus} />
          <StatusChip label="Staging" value={row.stagingStatus} />
          {row.cookedPortionsExcess != null && (
            <div className={`flex items-center gap-1 text-[10px] font-bold px-3 py-1.5 rounded-xl border ${
              (row.cookedPortionsExcess ?? 0) >= 0
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : "bg-red-50 border-red-200 text-red-700"
            }`}>
              Excess: {(row.cookedPortionsExcess ?? 0) > 0 ? "+" : ""}{fmtNum(row.cookedPortionsExcess ?? 0)}
            </div>
          )}
        </div>

        {/* Comments */}
        {(row.workOrderComment || row.stagingComment || row.unlockedEta) && (
          <div className="space-y-2">
            {row.workOrderComment && (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800">
                <span className="mt-0.5">⚠</span>
                <span><strong>WO Kommentar:</strong> {row.workOrderComment}</span>
              </div>
            )}
            {row.stagingComment && (
              <div className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-xs text-slate-600">
                <span>💬</span>
                <span><strong>Staging:</strong> {row.stagingComment}</span>
              </div>
            )}
            {row.unlockedEta && (
              <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 text-xs text-blue-800">
                <span>🔓</span>
                <span><strong>Unlocked ETA:</strong> {new Date(row.unlockedEta).toLocaleString("de-DE")}</span>
              </div>
            )}
          </div>
        )}

        {/* Batch visualization */}
        {calc.batches > 1 && calc.perBatchKg > 0 && (
          <div>
            <div className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400 mb-2">
              Batch-Übersicht ({calc.batches} Batche)
            </div>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: Math.min(calc.batches, 20) }, (_, i) => (
                <div key={i} className="flex flex-col items-center bg-white border border-slate-200 rounded-xl px-3 py-2 min-w-[64px] shadow-sm">
                  <span className="text-[8px] font-bold text-slate-400 uppercase">Batch</span>
                  <span className="text-lg font-black text-[#1e3a5f]">{i + 1}</span>
                  <span className="text-[9px] font-semibold text-slate-500 tabular-nums">{fmtKg(calc.perBatchKg)}</span>
                </div>
              ))}
              {calc.batches > 20 && (
                <div className="flex items-center px-3 text-xs text-slate-400 font-semibold">
                  +{calc.batches - 20} weitere
                </div>
              )}
            </div>
          </div>
        )}

        {/* Ingredient Table */}
        {calc.ingredients.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
                Zutaten{calc.batches > 0 ? ` · ${calc.batches} Batche` : ""}
              </div>
              <div className="text-[9px] font-bold text-slate-500 tabular-nums">
                {fmtKg(calc.totalKg)} gesamt
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-4 py-3 text-[9px] font-black uppercase tracking-wide text-slate-500">Zutat</th>
                    <th className="text-right px-4 py-3 text-[9px] font-black uppercase tracking-wide text-slate-500">Total</th>
                    <th className="text-right px-4 py-3 text-[9px] font-black uppercase tracking-wide text-blue-600">Pro Batch</th>
                  </tr>
                </thead>
                <tbody>
                  {calc.ingredients
                    .filter((i) => i.totalKg > 0.0005)
                    .sort((a, b) => b.totalKg - a.totalKg)
                    .map((ing, idx) => (
                      <tr key={idx} className={`border-b border-slate-50 hover:bg-slate-50/50 transition-colors ${
                        ing.category === "PRO" ? "bg-red-50/30" :
                        ing.category === "PHF" ? "bg-blue-50/30" :
                        ing.category === "SPI" ? "bg-amber-50/20" : ""
                      }`}>
                        <td className="px-4 py-2.5">
                          {ing.category && (
                            <span className={`text-[8px] font-black px-1.5 py-0.5 rounded-md mr-1.5 ${catColor(ing.category)}`}>
                              {ing.category}
                            </span>
                          )}
                          <span className="font-medium text-slate-800">{ing.name}</span>
                          {ing.yieldPct && ing.yieldPct < 1 && (
                            <span className="ml-1.5 text-[8px] text-amber-600 font-bold">
                              {Math.round((1 - ing.yieldPct) * 100)}% Verlust
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-700">
                          {fmtKg(ing.totalKg)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-black tabular-nums text-blue-700">
                          {fmtKg(ing.perBatchKg)}
                        </td>
                      </tr>
                    ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 border-t-2 border-slate-200">
                    <td className="px-4 py-3 font-black text-slate-800 text-[11px] uppercase tracking-wide">Gesamt</td>
                    <td className="px-4 py-3 text-right font-black tabular-nums text-slate-800">{fmtKg(calc.totalKg)}</td>
                    <td className="px-4 py-3 text-right font-black tabular-nums text-blue-700">{fmtKg(calc.perBatchKg)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : (
          <div className={`rounded-2xl px-5 py-4 text-xs border ${
            !calc.recipeFound
              ? "bg-amber-50 border-amber-200 text-amber-700"
              : "bg-slate-50 border-slate-200 text-slate-500"
          }`}>
            <div className="font-bold mb-1">
              {!calc.recipeFound ? "⚠ Rezept nicht in App-Daten" : "⚠ Sub-Rezept nicht gefunden"}
            </div>
            <div className="text-[10px]">
              {!calc.recipeFound
                ? `Rezept "${row.recipeCode}" wurde nicht in den App-Daten gefunden. Zutaten-Berechnung nicht möglich.`
                : `Sub-Rezept "${row.subRecipeName}" konnte in den Gross-Ingredients nicht gematcht werden.`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Micro components ───────────────────────────────────────────────────────

function StatCard({
  label, value, sub, subGreen, highlight, warn,
}: {
  label: string; value: string; sub?: string; subGreen?: boolean; highlight?: boolean; warn?: string;
}) {
  return (
    <div className={`rounded-2xl px-4 py-3.5 border ${
      highlight
        ? "bg-[#1e3a5f] border-[#1e3a5f]"
        : warn
          ? "bg-amber-50 border-amber-200"
          : "bg-white border-slate-200 shadow-sm"
    }`}>
      <div className={`text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 ${
        highlight ? "text-blue-300" : warn ? "text-amber-500" : "text-slate-400"
      }`}>{label}</div>
      <div className={`text-xl font-black tabular-nums leading-tight ${
        highlight ? "text-white" : warn ? "text-amber-800" : "text-slate-900"
      }`}>{value}</div>
      {sub && (
        <div className={`text-[10px] font-medium mt-0.5 ${
          subGreen ? "text-emerald-600" : highlight ? "text-blue-300" : "text-slate-400"
        }`}>{sub}</div>
      )}
      {warn && <div className="text-[9px] text-amber-600 font-semibold mt-0.5">{warn}</div>}
    </div>
  );
}

function StatusChip({ label, value }: { label: string; value: string }) {
  const { bg, text, dot } = statusColors(value);
  return (
    <div className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1.5 rounded-xl border ${bg} ${text} border-transparent`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`}></span>
      <span className="text-[9px] font-medium opacity-70">{label}:</span>
      {value || "—"}
    </div>
  );
}
