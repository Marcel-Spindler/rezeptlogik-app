// PetPlanView.tsx – PET Plaiting Linienplan
// CSV laden → allergen-bewusste Linienzuweisung → variable Kapazität/h → Submeals+1 MA → Anweisungen → PDF

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";
import type { DataBundle, Recipe, Market } from "./types";

// ── Konstanten ──────────────────────────────────────────────────────────────

const LS_IMAGES_KEY = "pet_plating_images_v1";
const PORTIONS_PER_HOUR = 1000;
const LINE_START_HOUR = 7;
const LINE_COLORS = ["#0ea5e9", "#10b981", "#f59e0b"] as const;
const LINE_COLORS_BG = ["#eff6ff", "#f0fdf4", "#fffbeb"] as const;
const LINE_COLORS_BORDER = ["#bfdbfe", "#bbf7d0", "#fde68a"] as const;
const LINE_COLORS_DARK = ["#0369a1", "#059669", "#b45309"] as const;

// ── Types ──────────────────────────────────────────────────────────────────

interface PetRow {
  key: string;
  shiftKey: string;
  shiftTotalTarget: number;
  shiftTotalMapped: number | null;
  _woNumber: string;
  recipeName: string;
  recipeCode: string;
  market: string;
  mapped: number | null;
  target: number;
  platingStatus: string;
  manualStatus: string;
  weekUnlocked: number | null;
  weekMapped: number | null;
  minNeeds: number | null;
  expiringDatetime: string;
  expiringSubRecipe: string;
  expiringPortions: string;
  expiringLp: string;
  comment: string;
  rolloverAmount: number | null;
  bestByDate: string;
  bestBySubRecipe: string;
}

interface PlatingImage {
  dataUrl: string;
  name: string;
  addedAt: string;
}

type WoSortMode = "auto" | "name" | "target" | "status" | "code";
type ViewMode = "lines" | "list";

// ── Allergen Definitionen ──────────────────────────────────────────────────

interface AllergenDef {
  label: string;
  color: string;
  bg: string;
  border: string;
  keywords: string[];
}

const ALLERGEN_DEFS: AllergenDef[] = [
  { label: "Fisch",    color: "#1e40af", bg: "#dbeafe", border: "#93c5fd", keywords: ["salmon","lachs","fish","fisch","tuna","forelle","trout","seabass","bass","cod","kabeljau"] },
  { label: "Milch",    color: "#0c4a6e", bg: "#e0f2fe", border: "#7dd3fc", keywords: ["butter","cream","cheese","käse","kase","parmesan","mozzarella","mascarpone","cheddar","gratin","milch","milk","dairy","rahm","quark","ricotta","feta","gouda"] },
  { label: "Eier",     color: "#713f12", bg: "#fef9c3", border: "#fde047", keywords: ["egg","eier"," ei ","eggs"] },
  { label: "Gluten",   color: "#92400e", bg: "#fef3c7", border: "#fcd34d", keywords: ["burger","meatball","breadcrumb","gluten","weizen","wheat","panko","crispy"] },
  { label: "Senf",     color: "#14532d", bg: "#f0fdf4", border: "#86efac", keywords: ["mustard","ranch","senf","mustard"] },
  { label: "Sellerie", color: "#166534", bg: "#dcfce7", border: "#6ee7b7", keywords: ["celery","sellerie"] },
  { label: "Sesam",    color: "#581c87", bg: "#fdf4ff", border: "#d8b4fe", keywords: ["sesame","sesam"] },
  { label: "Soja",     color: "#881337", bg: "#fff1f2", border: "#fda4af", keywords: ["soy","soja","tofu","edamame"] },
  { label: "Nüsse",    color: "#7c2d12", bg: "#fff7ed", border: "#fdba74", keywords: ["nut","cashew","walnut","almond","peanut","nuss","pistachio","pistazien"] },
];

function detectAllergensFromText(texts: string[]): AllergenDef[] {
  const combined = texts.join(" ").toLowerCase();
  return ALLERGEN_DEFS.filter(({ keywords }) => keywords.some((kw) => combined.includes(kw)));
}

// ── CSV Parser ─────────────────────────────────────────────────────────────

function parseNum(s: string): number | null {
  if (!s || !s.trim()) return null;
  const n = parseFloat(s.replace(",", "."));
  return isFinite(n) ? n : null;
}

function extractCode(name: string): string {
  return (name ?? "").trim().match(/^([A-Z]{2}\d{4}[A-Z0-9]+)/)?.[1] ?? "";
}

function extractMarket(name: string): string {
  const m = (name ?? "").match(/\[(DE|BNL|DKSE|BENL|NORD)\]/i);
  return m ? `[${m[1].toUpperCase()}]` : "";
}

function cleanRecipeName(name: string): string {
  return (name ?? "")
    .replace(/^[A-Z]{2}\d{4}[A-Z0-9]+\s*[-–]\s*/, "")
    .replace(/\s*\[(?:DE|BNL|DKSE|BENL|NORD)\]\s*$/i, "")
    .trim();
}

function parsePetCsv(text: string): PetRow[] {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  return result.data
    .filter((row) => (row["Type"] ?? "").trim().toLowerCase().includes("recipe"))
    .map((row, idx) => {
      const rawName = (row["Recipe Name"] ?? "").trim();
      const shiftKey = (row["Production Shift"] ?? "").trim();
      return {
        key: `pet::${idx}::${shiftKey}`,
        shiftKey,
        shiftTotalTarget: parseNum(row["Total Target"] ?? "") ?? 0,
        shiftTotalMapped: parseNum(row["Total Mapped"] ?? ""),
        _woNumber: (row["Recipe WO #"] ?? "").trim(),
        recipeName: cleanRecipeName(rawName),
        recipeCode: extractCode(rawName),
        market: extractMarket(rawName),
        mapped: parseNum(row["Recipe WO Mapped"] ?? ""),
        target: parseNum(row["Recipe WO Target"] ?? "") ?? 0,
        platingStatus: (row["Recipe Plating Status"] ?? "").trim(),
        manualStatus: (row["Recipe Manual Plating Status"] ?? "").trim(),
        weekUnlocked: parseNum(row["Total Week Unlocked Volume"] ?? ""),
        weekMapped: parseNum(row["Total Week Mapped"] ?? ""),
        minNeeds: parseNum(row["Production Min Needs"] ?? ""),
        expiringDatetime: (row["Expiring Datetime"] ?? "").trim(),
        expiringSubRecipe: (row["Expiring SubRecipe Name"] ?? "").trim(),
        expiringPortions: (row["Expiring Portions"] ?? "").trim(),
        expiringLp: (row["Expiring License Plate #"] ?? "").trim(),
        comment: (row["Comment"] ?? "").trim(),
        rolloverAmount: parseNum(row["Rollover Amount"] ?? ""),
        bestByDate: (row["Actual Best By Date"] ?? "").trim(),
        bestBySubRecipe: (row["Best By SubRecipe Name"] ?? "").trim(),
      } satisfies PetRow;
    });
}

// ── Date helpers ───────────────────────────────────────────────────────────

function parseShift(shiftKey: string): { date: string; shift: string } {
  const m = shiftKey.match(/^(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d+)/);
  if (m) return { date: m[1], shift: m[2] };
  return { date: shiftKey, shift: "" };
}

function shiftSortKey(shiftKey: string): number {
  const { date, shift } = parseShift(shiftKey);
  return Date.parse(date) * 10 + parseInt(shift || "0");
}

function fmtShiftHeader(shiftKey: string): string {
  const { date, shift } = parseShift(shiftKey);
  const d = new Date(date);
  if (isNaN(d.getTime())) return shiftKey;
  const day = d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit" });
  return shift ? `${day} · Shift ${shift}` : day;
}

function fmtShiftShort(shiftKey: string): string {
  const { date, shift } = parseShift(shiftKey);
  const d = new Date(date);
  if (isNaN(d.getTime())) return shiftKey;
  const day = d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
  return shift ? `${day} S${shift}` : day;
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("de-DE");
}

function fmtClock(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(safe / 60).toString().padStart(2, "0");
  const m = (safe % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ── Instruction helpers ────────────────────────────────────────────────────

// Parst Freitext-Anweisungen in einzelne Arbeitsschritte
function parseSteps(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.replace(/^\s*[-–•*]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean);
}

// ── Recipe helpers ─────────────────────────────────────────────────────────

function marketKey(marketTag: string): Market | null {
  if (marketTag.includes("BNL") || marketTag.includes("BENL")) return "BENL";
  if (marketTag.includes("DKSE")) return "DKSE";
  if (marketTag.includes("DE")) return "DE";
  return null;
}

function getMarketsToCheck(marketTag: string): Market[] {
  const mk = marketKey(marketTag);
  const all: Market[] = ["DE", "BENL", "DKSE"];
  return mk ? [mk, ...all.filter((m) => m !== mk)] : all;
}

function getPlatingInstructions(
  recipe: Recipe | undefined,
  market: string,
): Array<{ name: string; id: string; text: string }> {
  if (!recipe) return [];
  for (const m of getMarketsToCheck(market)) {
    const md = recipe.markets[m];
    if (!md) continue;
    const result = md.subRecipes
      .filter((s) => s.instructions)
      .map((s) => ({ name: s.name, id: s.id, text: s.instructions ?? "" }));
    if (result.length > 0) return result;
  }
  return [];
}

function getStructuredAllergens(recipe: Recipe | undefined, market: string): string {
  if (!recipe) return "";
  for (const m of getMarketsToCheck(market)) {
    const md = recipe.markets[m];
    if (md?.allergens) return md.allergens;
  }
  return "";
}

function getSubmealCount(recipe: Recipe | undefined, market: string): number {
  if (!recipe) return 1;
  for (const m of getMarketsToCheck(market)) {
    const md = recipe.markets[m];
    if (md?.subRecipes?.length) return md.subRecipes.length;
  }
  return 1;
}

function getMealAllergens(row: PetRow, recipe: Recipe | undefined): AllergenDef[] {
  const structured = getStructuredAllergens(recipe, row.market);
  if (structured) return detectAllergensFromText([structured]);
  return detectAllergensFromText([row.recipeName, row.comment, row.bestBySubRecipe, row.expiringSubRecipe]);
}

// ── Line Planning ──────────────────────────────────────────────────────────

function getAllergenSignature(row: PetRow, recipes: Record<string, Recipe>): string {
  const recipe = recipes[row.recipeCode];
  const structured = getStructuredAllergens(recipe, row.market);
  if (structured) return structured;
  return detectAllergensFromText([row.recipeName]).map((a) => a.label).sort().join("|") || "none";
}

function planLines(
  shiftRows: PetRow[],
  recipes: Record<string, Recipe>,
  capacities: number[] = [PORTIONS_PER_HOUR, PORTIONS_PER_HOUR, PORTIONS_PER_HOUR],
): { lines: PetRow[][]; lineTargets: number[] } {
  if (shiftRows.length === 0) return { lines: [[], []], lineTargets: [0, 0] };

  const shiftTarget = shiftRows.reduce((s, r) => s + r.target, 0);
  const avgCap = capacities.reduce((s, c) => s + c, 0) / capacities.length;
  const linesNeeded = shiftTarget > 0 ? Math.ceil(shiftTarget / avgCap) : 1;
  const lineCount = Math.min(capacities.length, Math.max(2, linesNeeded));

  // Sortiere: gleiche Allergen-Signaturen zusammen, dann nach Target absteigend
  const sorted = [...shiftRows].sort((a, b) => {
    const sigA = getAllergenSignature(a, recipes);
    const sigB = getAllergenSignature(b, recipes);
    if (sigA !== sigB) return sigA.localeCompare(sigB);
    return b.target - a.target;
  });

  const lines: PetRow[][] = Array.from({ length: lineCount }, () => []);
  const lineTargets = Array.from({ length: lineCount }, () => 0);

  for (const row of sorted) {
    let bestLine = 0;
    let bestScore = Infinity;
    for (let i = 0; i < lineCount; i++) {
      const last = lines[i].at(-1);
      const lastSig = last ? getAllergenSignature(last, recipes) : "";
      const curSig = getAllergenSignature(row, recipes);
      const switchPenalty = last && lastSig !== curSig ? 3 : 0;
      const cap = capacities[i] ?? PORTIONS_PER_HOUR;
      const balance = lineTargets[i] / cap;
      const overflow = Math.max(0, lineTargets[i] + row.target - cap) / cap * 2;
      const score = switchPenalty + balance + overflow + lineTargets[i] * 0.0001;
      if (score < bestScore) { bestScore = score; bestLine = i; }
    }
    lines[bestLine].push(row);
    lineTargets[bestLine] += row.target;
  }

  return { lines, lineTargets };
}

function calcLineStaff(lineRows: PetRow[], recipes: Record<string, Recipe>): number {
  const submeals = lineRows.reduce((s, r) => s + getSubmealCount(recipes[r.recipeCode], r.market), 0);
  return submeals + 1;
}

// ── Status helpers ─────────────────────────────────────────────────────────

function statusColors(status: string): { bg: string; text: string } {
  const s = status.toLowerCase();
  if (s.includes("complete") || s.includes("done") || s.includes("finished"))
    return { bg: "bg-emerald-100", text: "text-emerald-800" };
  if (s.includes("in progress") || s.includes("running"))
    return { bg: "bg-blue-100", text: "text-blue-800" };
  if (s.includes("not started") || !s)
    return { bg: "bg-slate-100", text: "text-slate-500" };
  if (s.includes("hold") || s.includes("blocked"))
    return { bg: "bg-red-100", text: "text-red-700" };
  return { bg: "bg-amber-100", text: "text-amber-800" };
}

function statusColorsHtml(status: string): { bg: string; text: string } {
  const s = status.toLowerCase();
  if (s.includes("complete") || s.includes("done"))   return { bg: "#d1fae5", text: "#065f46" };
  if (s.includes("in progress") || s.includes("running")) return { bg: "#dbeafe", text: "#1e40af" };
  if (s.includes("not started") || !s)                return { bg: "#f1f5f9", text: "#475569" };
  return { bg: "#fef3c7", text: "#92400e" };
}

// ── Image helpers ──────────────────────────────────────────────────────────

function loadImages(): Record<string, PlatingImage[]> {
  try {
    const raw = localStorage.getItem(LS_IMAGES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveImages(imgs: Record<string, PlatingImage[]>) {
  try { localStorage.setItem(LS_IMAGES_KEY, JSON.stringify(imgs)); } catch { /* quota */ }
}

// ── PDF Builder ────────────────────────────────────────────────────────────

function buildLinePlanPdf(
  shiftKey: string,
  rows: PetRow[],
  title: string,
  allImages: Record<string, PlatingImage[]>,
  recipes: Record<string, Recipe>,
  capacities: number[] = [PORTIONS_PER_HOUR, PORTIONS_PER_HOUR, PORTIONS_PER_HOUR],
): string {
  const { lines, lineTargets } = planLines(rows, recipes, capacities);
  const lineCount = lines.length;
  const shiftTarget = rows.reduce((s, r) => s + r.target, 0);
  const shiftMapped = rows.reduce((s, r) => s + (r.mapped ?? 0), 0);
  const pct = shiftTarget > 0 && shiftMapped > 0 ? Math.round(shiftMapped / shiftTarget * 100) : 0;
  const parallelHours = lineCount > 0
    ? Math.max(...lineTargets.map((t, i) => t / (capacities[i] ?? PORTIONS_PER_HOUR)))
    : 0;
  const staffByLine = lines.map((l) => calcLineStaff(l, recipes));
  const staffTotal = staffByLine.reduce((s, n) => s + n, 0);
  const allAllergens = new Set(rows.flatMap((r) => getMealAllergens(r, recipes[r.recipeCode]).map((a) => a.label)));

  const lc = ["#0ea5e9", "#10b981", "#f59e0b"];
  const lb = ["#eff6ff", "#f0fdf4", "#fffbeb"];

  const lineHtmls = lines.map((lineRows, li) => {
    const lineColor = lc[li] ?? "#94a3b8";
    const lineBg = lb[li] ?? "#f8fafc";
    const lineTarget = lineTargets[li];
    const lineCap = capacities[li] ?? PORTIONS_PER_HOUR;
    const lineHours = lineTarget / lineCap;
    const lineStaff = staffByLine[li];
    const utilPct = Math.min(100, Math.round(lineTarget / lineCap * 100));
    let cursorMin = LINE_START_HOUR * 60;

    const mealCards = lineRows.map((row, mi) => {
      const recipe = recipes[row.recipeCode];
      const allergens = getMealAllergens(row, recipe);
      const instr = getPlatingInstructions(recipe, row.market);
      const imgs = allImages[row.recipeCode] ?? [];
      const structured = getStructuredAllergens(recipe, row.market);
      const submeals = getSubmealCount(recipe, row.market);

      const durationMin = Math.max(10, Math.round((row.target / lineCap) * 60));
      const startMin = cursorMin;
      const endMin = cursorMin + durationMin;
      cursorMin = endMin;

      const allergenHtml = allergens.length > 0
        ? allergens.map((a) =>
            `<span style="display:inline-block;background:${a.bg};color:${a.color};border:1px solid ${a.border};border-radius:3px;padding:1px 5px;font-size:9px;font-weight:700;margin:1px 2px;">${a.label}</span>`
          ).join("")
        : `<span style="font-size:9px;color:#94a3b8;">keine bekannten Allergene</span>`;

      // Nummerierte Schritt-für-Schritt Anweisungen je Sub-Meal
      const instrHtml = instr.length > 0
        ? instr.map((b) => {
            const steps = parseSteps(b.text);
            const stepsHtml = steps.length === 0
              ? `<div style="font-size:9px;color:#64748b;">${b.text.replace(/</g,"&lt;")}</div>`
              : steps.map((s, si) =>
                  `<div style="display:flex;gap:5px;margin-bottom:2px;align-items:flex-start;">
                     <span style="font-weight:800;color:#166534;min-width:16px;font-size:9px;flex-shrink:0;">${si + 1}.</span>
                     <span style="font-size:9px;color:#1a2e1a;">${s.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</span>
                   </div>`
                ).join("");
            return `<div style="margin-top:5px;padding:6px 8px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:0 4px 4px 0;">
                      <div style="font-size:9px;font-weight:800;color:#166534;margin-bottom:3px;border-bottom:1px solid #bbf7d0;padding-bottom:2px;">
                        Sub-Meal: ${b.name.replace(/</g,"&lt;")}
                      </div>
                      ${stepsHtml}
                    </div>`;
          }).join("")
        : (recipe
            ? `<div style="font-size:9px;color:#94a3b8;margin-top:4px;">Keine Anweisungen in App-Daten</div>`
            : `<div style="font-size:9px;color:#f97316;margin-top:4px;">⚠ ${row.recipeCode} nicht in App-Daten</div>`);

      const imgHtml = imgs.length > 0
        ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
             ${imgs.map((img) => `<div style="text-align:center"><img src="${img.dataUrl}" alt="Foto" style="max-width:130px;max-height:100px;object-fit:contain;border:1px solid #e2e8f0;border-radius:4px;"/><div style="font-size:8px;color:#64748b;">${img.name}</div></div>`).join("")}
           </div>`
        : "";

      const sc = statusColorsHtml(row.platingStatus);

      const next = lineRows[mi + 1];
      const nextAllergens = next ? getMealAllergens(next, recipes[next.recipeCode]) : [];
      const curSet = new Set(allergens.map((a) => a.label));
      const nxtSet = new Set(nextAllergens.map((a) => a.label));
      const removed = [...curSet].filter((l) => !nxtSet.has(l));
      const added = [...nxtSet].filter((l) => !curSet.has(l));
      const hasChange = next && (removed.length > 0 || added.length > 0);

      const cleaningHtml = hasChange
        ? `<div style="margin:3px 0 6px;padding:5px 8px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:5px;font-size:9px;color:#78350f;font-weight:700;">
             ⚠ LINIE REINIGEN – Allergen-Wechsel:${removed.length ? ` entfernt: ${removed.join(", ")}` : ""}${added.length ? ` · neu: ${added.join(", ")}` : ""}
           </div>`
        : "";

      return `
        <div style="border:1px solid #e2e8f0;border-left:3px solid ${lineColor};border-radius:0 6px 6px 0;background:#fff;padding:8px 10px;margin-bottom:4px;page-break-inside:avoid;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
            <div>
              <div style="font-size:12px;font-weight:800;color:#0f172a;">${row.recipeName}${row.market ? `&nbsp;<span style="font-size:9px;font-weight:400;color:#94a3b8;">${row.market}</span>` : ""}</div>
              ${row.recipeCode ? `<div style="font-family:monospace;font-size:9px;color:#64748b;">${row.recipeCode} · ${submeals} Sub-Meals · ${instr.length} Anweisungsblöcke</div>` : ""}
            </div>
            <div style="text-align:right;font-size:9px;color:#64748b;white-space:nowrap;margin-left:8px;">
              <div style="font-weight:700;color:#0369a1;">${fmtClock(startMin)} – ${fmtClock(endMin)}</div>
              <div>${(row.target / lineCap).toFixed(1)} h · ${fmtNum(lineCap)}/h</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:700;color:#0f172a;">${fmtNum(row.target)}</span>
            <span style="font-size:9px;color:#64748b;">Port.</span>
            ${row.platingStatus ? `<span style="padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;background:${sc.bg};color:${sc.text};">${row.platingStatus}</span>` : ""}
            ${row.rolloverAmount != null ? `<span style="padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;background:#fef3c7;color:#92400e;">↩ ${fmtNum(row.rolloverAmount)} Rollover</span>` : ""}
          </div>
          <div style="margin-bottom:5px;">${allergenHtml}</div>
          ${structured ? `<div style="font-size:9px;color:#92400e;background:#fef3c7;border:1px solid #fbbf24;padding:3px 7px;border-radius:4px;margin-bottom:4px;">⚠ <strong>Allergene:</strong> ${structured}</div>` : ""}
          ${row.bestByDate ? `<div style="font-size:9px;color:#5b21b6;background:#f5f3ff;border-left:2px solid #a78bfa;padding:3px 7px;margin-bottom:3px;">📅 <strong>Best By:</strong> ${row.bestByDate}${row.bestBySubRecipe ? ` · ${row.bestBySubRecipe}` : ""}</div>` : ""}
          ${row.expiringSubRecipe ? `<div style="font-size:9px;color:#991b1b;background:#fef2f2;border-left:2px solid #fca5a5;padding:3px 7px;margin-bottom:3px;">🕐 <strong>Ablauf:</strong> ${row.expiringSubRecipe}${row.expiringPortions ? ` · ${fmtNum(parseFloat(row.expiringPortions))} Port.` : ""}${row.expiringDatetime ? ` · ${row.expiringDatetime}` : ""}</div>` : ""}
          ${row.comment ? `<div style="font-size:9px;color:#374151;background:#f1f5f9;border-left:2px solid #94a3b8;padding:3px 7px;margin-bottom:3px;">💬 ${row.comment}</div>` : ""}
          ${instrHtml}
          ${imgHtml}
        </div>
        ${cleaningHtml}`;
    }).join("");

    return `
    <td style="width:${(100 / lineCount).toFixed(1)}%;vertical-align:top;${li < lineCount - 1 ? "padding-right:10px;" : ""}">
      <div style="background:${lineColor};color:#fff;padding:7px 10px;border-radius:6px 6px 0 0;font-size:10px;font-weight:800;">
        Linie ${li + 1} &mdash; ${fmtNum(lineTarget)} Port. &mdash; ${lineHours.toFixed(1)} h &mdash; ${lineStaff} MA &mdash; ${fmtNum(lineCap)}/h
      </div>
      <div style="background:${lineBg};border:1px solid ${lineColor}33;border-radius:0 0 6px 6px;padding:6px;">
        <div style="font-size:9px;color:#64748b;margin-bottom:4px;">
          Start ${fmtClock(LINE_START_HOUR * 60)} · Ende est. ${fmtClock(LINE_START_HOUR * 60 + lineHours * 60)} · Auslastung ${utilPct}%
        </div>
        <table width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:6px;"><tr>
          <td width="${utilPct}%" style="height:4px;background:${lineColor};border-radius:3px;"></td>
          ${utilPct < 100 ? `<td style="height:4px;background:#e2e8f0;"></td>` : ""}
        </tr></table>
        ${mealCards || `<div style="font-size:11px;color:#94a3b8;padding:8px 0;">Keine Meals zugewiesen</div>`}
      </div>
    </td>`;
  }).join("");

  const shiftHeader = fmtShiftHeader(shiftKey);

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#0f172a;background:#fff}
@media print{body{font-size:10px}@page{size:A4 landscape;margin:8mm}table{page-break-inside:avoid}}
</style>
</head>
<body>
<!-- Header -->
<div style="background:linear-gradient(135deg,#0f2240,#1e3a5f);color:#fff;padding:14px 18px;margin-bottom:10px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <div style="font-size:8px;letter-spacing:.15em;color:#7dd3fc;text-transform:uppercase;margin-bottom:4px;">Factor OPS · Verden · PET Plaiting</div>
  <div style="font-size:22px;font-weight:900;">${title}</div>
  <div style="font-size:10px;color:#93c5fd;margin-top:4px;">${shiftHeader} · ${rows.length} Meals · ${fmtNum(shiftTarget)} Portionen · ${lineCount} Linien · ${staffTotal} MA gesamt</div>
  <div style="font-size:9px;color:#64748b;margin-top:2px;">Generiert: ${new Date().toLocaleString("de-DE")}</div>
</div>

<!-- KPI Zeile -->
<table width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 10px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
  <tr>
    <td style="padding:10px 14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
      <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:2px;">Portionen Ziel</div>
      <div style="font-size:22px;font-weight:900;color:#0f172a;">${fmtNum(shiftTarget)}</div>
      ${pct > 0 ? `<div style="font-size:9px;color:#059669;">${pct}% geplated</div>` : ""}
    </td>
    <td style="padding:10px 14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
      <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:2px;">Linien</div>
      <div style="font-size:22px;font-weight:900;color:#0f172a;">${lineCount}</div>
      <div style="font-size:9px;color:#64748b;">${capacities.slice(0, lineCount).map((c, i) => `L${i+1}:${fmtNum(c)}/h`).join(" · ")}</div>
    </td>
    <td style="padding:10px 14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
      <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:2px;">Parallel-Zeit</div>
      <div style="font-size:22px;font-weight:900;color:#0f172a;">${parallelHours.toFixed(1)} h</div>
      <div style="font-size:9px;color:#64748b;">ab ${fmtClock(LINE_START_HOUR * 60)}</div>
    </td>
    <td style="padding:10px 14px;text-align:center;border-right:1px solid #e2e8f0;background:#f8fafc;">
      <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:2px;">MA Gesamt</div>
      <div style="font-size:22px;font-weight:900;color:#0f172a;">${staffTotal}</div>
      <div style="font-size:9px;color:#64748b;">Submeals + 1 je Linie</div>
    </td>
    ${allAllergens.size > 0 ? `
    <td style="padding:10px 14px;background:#fffbeb;border-right:1px solid #fde68a;">
      <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#92400e;margin-bottom:3px;">Allergene im Shift</div>
      <div style="font-size:10px;font-weight:700;color:#78350f;">${Array.from(allAllergens).join(" · ")}</div>
    </td>` : ""}
    <td style="padding:10px 14px;background:#fef3c7;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      <div style="font-size:9px;font-weight:700;color:#78350f;">⚠ ALLERGEN-SICHERHEIT</div>
      <div style="font-size:8px;color:#92400e;margin-top:2px;">Bei Allergen-Wechsel Linie reinigen. Gleiche Allergene wurden gebündelt, um Wechsel zu minimieren.</div>
    </td>
  </tr>
</table>

<!-- Linienplan -->
<table width="100%" cellspacing="0" cellpadding="0">
  <tr style="vertical-align:top;">
    ${lineHtmls}
  </tr>
</table>

</body>
</html>`;
}

// ── Main Component ─────────────────────────────────────────────────────────

export function PetPlanView({ data }: { data: DataBundle }) {
  const [csvRows, setCsvRows] = useState<PetRow[] | null>(null);
  const [csvFileName, setCsvFileName] = useState("");
  const [selectedShift, setSelectedShift] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [search, setSearch] = useState("");
  const [images, setImages] = useState<Record<string, PlatingImage[]>>(loadImages);
  const [lineCapacities, setLineCapacities] = useState<number[]>([PORTIONS_PER_HOUR, PORTIONS_PER_HOUR, PORTIONS_PER_HOUR]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoOpenedRef = useRef(false);

  useEffect(() => {
    if (!csvRows && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      fileInputRef.current?.click();
    }
  }, [csvRows]);

  const handleFile = useCallback((file: File) => {
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parsePetCsv(text);
      setCsvRows(parsed);
      if (parsed.length > 0) {
        const firstShift = parsed.reduce((min, r) =>
          shiftSortKey(r.shiftKey) < shiftSortKey(min.shiftKey) ? r : min
        ).shiftKey;
        setSelectedShift(firstShift);
      }
    };
    reader.readAsText(file, "utf-8");
  }, []);

  function addImage(recipeCode: string, file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const next = { ...images };
      if (!next[recipeCode]) next[recipeCode] = [];
      next[recipeCode] = [...next[recipeCode], { dataUrl, name: file.name, addedAt: new Date().toISOString() }];
      setImages(next);
      saveImages(next);
    };
    reader.readAsDataURL(file);
  }

  function removeImage(recipeCode: string, idx: number) {
    const next = { ...images };
    next[recipeCode] = (next[recipeCode] ?? []).filter((_, i) => i !== idx);
    if (next[recipeCode].length === 0) delete next[recipeCode];
    setImages(next);
    saveImages(next);
  }

  const shiftGroups = useMemo(() => {
    if (!csvRows) return [];
    const m = new Map<string, PetRow[]>();
    for (const row of csvRows) {
      if (!m.has(row.shiftKey)) m.set(row.shiftKey, []);
      m.get(row.shiftKey)!.push(row);
    }
    return [...m.entries()]
      .sort((a, b) => shiftSortKey(a[0]) - shiftSortKey(b[0]))
      .map(([shiftKey, rows]) => ({ shiftKey, rows }));
  }, [csvRows]);

  const needle = search.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!needle) return shiftGroups;
    return shiftGroups
      .map(({ shiftKey, rows }) => ({
        shiftKey,
        rows: rows.filter((r) =>
          [r.recipeName, r.recipeCode, r.platingStatus, r.comment].join(" ").toLowerCase().includes(needle)
        ),
      }))
      .filter((g) => g.rows.length > 0);
  }, [shiftGroups, needle]);

  const selectedShiftRows = useMemo(() => {
    if (!selectedShift || !csvRows) return [];
    return csvRows.filter((r) => r.shiftKey === selectedShift);
  }, [csvRows, selectedShift]);

  function printPdf() {
    if (!selectedShift || selectedShiftRows.length === 0) return;
    const title = `Plaiting Plan – ${fmtShiftHeader(selectedShift)}`;
    const html = buildLinePlanPdf(selectedShift, selectedShiftRows, title, images, data.recipes, lineCapacities);
    const w = window.open("", "_blank", "width=1200,height=850");
    if (!w) { alert("Popup blockiert – bitte für diese Seite erlauben."); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 500);
  }

  const allRows = shiftGroups.flatMap((g) => g.rows);
  const totalTarget = allRows.reduce((s, r) => s + r.target, 0);

  // ════════════════════════════════════════════════════
  // UPLOAD SCREEN
  // ════════════════════════════════════════════════════
  if (!csvRows) {
    return (
      <div className="flex h-[calc(100vh-112px)] items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-lg">
        <div className="text-center max-w-lg px-8">
          <div className="w-20 h-20 rounded-3xl bg-amber-100 flex items-center justify-center mx-auto mb-5">
            <svg className="w-10 h-10 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <h2 className="text-2xl font-black text-amber-700 mb-2">PET-Plan Daten fehlen</h2>
          <p className="text-sm font-bold text-slate-700 mb-1">
            Fehlender Datensatz: <span className="text-amber-700">KitchenOS PET-CSV</span>
          </p>
          <p className="text-sm text-slate-500 mb-6">
            Ohne Import dieser Datei kann kein Linienplan berechnet werden. Bitte lade sie jetzt hoch.
          </p>
          <input ref={fileInputRef} type="file" accept=".csv" aria-label="PET CSV hochladen" title="PET CSV hochladen" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          <div
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            className={`cursor-pointer rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-all select-none ${
              dragOver ? "border-blue-400 bg-blue-50 scale-[1.02]" : "border-amber-300 bg-amber-50 hover:border-blue-300 hover:bg-blue-50/50"
            }`}
          >
            <div className="text-sm font-bold text-slate-700 mb-1">📂 KitchenOS PET-CSV hochladen</div>
            <div className="text-xs text-slate-400">Der Dateidialog sollte sich bereits geöffnet haben · Klicken oder Datei hier ablegen · .csv</div>
          </div>
          <p className="text-[11px] text-slate-400 mt-4">Erwartet: Type, Production Shift, Recipe Name, Recipe WO Target …</p>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════
  // MAIN VIEW
  // ════════════════════════════════════════════════════
  return (
    <div className="flex h-[calc(100vh-112px)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">

      {/* ════════ LEFT SIDEBAR: Shift-Liste ════════ */}
      <aside className="w-[260px] shrink-0 flex flex-col border-r border-slate-200 overflow-hidden">

        {/* Header */}
        <div className="px-4 pt-4 pb-3 bg-gradient-to-b from-[#0f2240] to-[#1e3a5f]">
          <div className="text-[9px] font-bold text-blue-300 uppercase tracking-[.15em] mb-1">PET Plan · Plaiting</div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl font-black text-white tabular-nums">{shiftGroups.length}</span>
            <span className="text-xs text-blue-300">Shifts</span>
            <span className="text-blue-600">·</span>
            <span className="text-lg font-black text-blue-200 tabular-nums">{allRows.length}</span>
            <span className="text-xs text-blue-300">Meals</span>
          </div>
          {totalTarget > 0 && (
            <div className="text-[9px] text-blue-300 mt-1">
              <span className="font-black text-white">{fmtNum(totalTarget)}</span> Port. Ziel
            </div>
          )}
          <div className="text-[9px] text-blue-400 mt-1 font-mono truncate">✓ {csvFileName}</div>
        </div>

        {/* CSV Controls */}
        <div className="px-3 py-2 border-b border-slate-100">
          <input ref={fileInputRef} type="file" accept=".csv" title="PET CSV ersetzen" aria-label="PET CSV ersetzen" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          <button type="button" onClick={() => fileInputRef.current?.click()}
            className="w-full text-[10px] font-semibold text-slate-500 hover:text-blue-600 hover:bg-blue-50 py-1.5 rounded-lg transition-colors">
            ↑ Andere CSV laden
          </button>
          <button type="button" onClick={() => { setCsvRows(null); setCsvFileName(""); setSelectedShift(null); }}
            className="w-full text-[9px] text-slate-400 hover:text-red-500 transition-colors py-0.5">
            × CSV entfernen
          </button>
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-slate-100">
          <input type="search" placeholder="Meal, Code, Status …" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 focus:bg-white" />
        </div>

        {/* Shift-Liste */}
        <div className="flex-1 overflow-y-auto py-1.5 px-2 space-y-1">
          {filteredGroups.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400">Keine Shifts gefunden</div>
          ) : filteredGroups.map(({ shiftKey, rows }) => {
            const isSelected = selectedShift === shiftKey;
            const shiftTarget = rows.reduce((s, r) => s + r.target, 0);
            const shiftMapped = rows.reduce((s, r) => s + (r.mapped ?? 0), 0);
            const shiftPct = shiftTarget > 0 && shiftMapped > 0 ? Math.round(shiftMapped / shiftTarget * 100) : 0;
            const { lines } = planLines(rows, data.recipes, lineCapacities);
            const staffTotal = lines.reduce((s, l) => s + calcLineStaff(l, data.recipes), 0);
            const allAllergens = new Set(rows.flatMap((r) => getMealAllergens(r, data.recipes[r.recipeCode]).map((a) => a.label)));
            const doneCount = rows.filter((r) => r.platingStatus.toLowerCase().includes("complete") || r.platingStatus.toLowerCase().includes("done")).length;
            const inProgressCount = rows.filter((r) => r.platingStatus.toLowerCase().includes("progress")).length;

            return (
              <button type="button" key={shiftKey} onClick={() => setSelectedShift(shiftKey)}
                className={`w-full text-left rounded-xl px-3 py-2.5 transition-all ${
                  isSelected
                    ? "bg-[#1e3a5f] shadow-md ring-2 ring-[#1e3a5f]/30"
                    : "bg-white hover:bg-slate-50 border border-slate-100 shadow-sm hover:shadow"
                }`}>
                <div className={`text-[12px] font-black leading-tight mb-0.5 ${isSelected ? "text-white" : "text-[#1e3a5f]"}`}>
                  {fmtShiftShort(shiftKey)}
                </div>
                <div className={`text-[9px] tabular-nums ${isSelected ? "text-blue-300" : "text-slate-400"}`}>
                  {rows.length} Meals · {fmtNum(shiftTarget)} Port. · {lines.length} Lin. · {staffTotal} MA
                </div>
                {shiftPct > 0 && (
                  <div className="mt-1.5 flex items-center gap-1">
                    <div className={`flex-1 h-1 rounded-full overflow-hidden ${isSelected ? "bg-white/20" : "bg-slate-100"}`}>
                      <div className={`h-full rounded-full ${shiftPct >= 100 ? "bg-emerald-400" : "bg-blue-400"}`}
                        style={{ width: `${Math.min(100, shiftPct)}%` }} />
                    </div>
                    <span className={`text-[8px] tabular-nums ${isSelected ? "text-blue-300" : "text-slate-400"}`}>{shiftPct}%</span>
                  </div>
                )}
                <div className={`flex gap-1.5 mt-1 flex-wrap text-[8px] ${isSelected ? "text-blue-300" : "text-slate-400"}`}>
                  {doneCount > 0 && <span className={`px-1.5 py-0.5 rounded-sm font-semibold ${isSelected ? "bg-white/10" : "bg-emerald-50 text-emerald-700"}`}>{doneCount} Done</span>}
                  {inProgressCount > 0 && <span className={`px-1.5 py-0.5 rounded-sm font-semibold ${isSelected ? "bg-white/10" : "bg-blue-50 text-blue-700"}`}>{inProgressCount} laufen</span>}
                </div>
                {allAllergens.size > 0 && (
                  <div className={`text-[8px] mt-1 truncate ${isSelected ? "text-amber-300" : "text-amber-600"}`}>
                    ⚠ {Array.from(allAllergens).join(", ")}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* PDF Button */}
        <div className="px-3 py-2.5 border-t border-slate-100 bg-slate-50/50">
          <button type="button" onClick={printPdf} disabled={!selectedShift}
            className="w-full flex items-center justify-center gap-2 text-xs font-bold bg-[#1e3a5f] hover:bg-[#162d4a] disabled:opacity-30 disabled:cursor-not-allowed text-white py-2.5 rounded-xl transition-colors shadow-sm">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
            </svg>
            PDF Linienplan
          </button>
        </div>
      </aside>

      {/* ════════ RIGHT: Shift-Detail / Linienplan ════════ */}
      <main className="flex-1 overflow-y-auto min-w-0 bg-slate-50/30">
        {!selectedShift ? (
          <EmptyState />
        ) : (
          <ShiftDetail
            shiftKey={selectedShift}
            rows={selectedShiftRows}
            data={data}
            images={images}
            lineCapacities={lineCapacities}
            onLineCapacityChange={(idx, cap) => {
              const next = [...lineCapacities];
              next[idx] = cap;
              setLineCapacities(next);
            }}
            onAddImage={addImage}
            onRemoveImage={removeImage}
            onPrint={printPdf}
          />
        )}
      </main>
    </div>
  );
}

// ── Empty State ────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-xs px-6">
        <div className="w-16 h-16 rounded-3xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 0v10m0-10a2 2 0 012 2h2a2 2 0 012-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/>
          </svg>
        </div>
        <p className="text-sm font-bold text-slate-600">Shift wählen</p>
        <p className="text-xs text-slate-400 mt-1">Klicke links auf einen Shift für den Linienplan</p>
      </div>
    </div>
  );
}

// ── ShiftDetail ────────────────────────────────────────────────────────────

function ShiftDetail({
  shiftKey, rows, data, images, lineCapacities, onLineCapacityChange, onAddImage, onRemoveImage, onPrint,
}: {
  shiftKey: string;
  rows: PetRow[];
  data: DataBundle;
  images: Record<string, PlatingImage[]>;
  lineCapacities: number[];
  onLineCapacityChange: (idx: number, cap: number) => void;
  onAddImage: (code: string, f: File) => void;
  onRemoveImage: (code: string, idx: number) => void;
  onPrint: () => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("lines");
  const [woSort, setWoSort] = useState<WoSortMode>("auto");

  const { lines, lineTargets } = useMemo(
    () => planLines(rows, data.recipes, lineCapacities),
    [rows, data.recipes, lineCapacities]
  );
  const lineCount = lines.length;
  const shiftTarget = rows.reduce((s, r) => s + r.target, 0);
  const shiftMapped = rows.reduce((s, r) => s + (r.mapped ?? 0), 0);
  const pct = shiftTarget > 0 && shiftMapped > 0 ? Math.round(shiftMapped / shiftTarget * 100) : 0;
  const parallelHours = lineCount > 0
    ? Math.max(...lineTargets.map((t, i) => t / (lineCapacities[i] ?? PORTIONS_PER_HOUR)))
    : 0;
  const staffByLine = lines.map((l) => calcLineStaff(l, data.recipes));
  const staffTotal = staffByLine.reduce((s, n) => s + n, 0);
  const allAllergens = useMemo(
    () => new Set(rows.flatMap((r) => getMealAllergens(r, data.recipes[r.recipeCode]).map((a) => a.label))),
    [rows, data.recipes]
  );
  const cleaningCount = useMemo(() => {
    let total = 0;
    for (const lineRows of lines) {
      for (let i = 0; i < lineRows.length - 1; i++) {
        const cur = new Set(getMealAllergens(lineRows[i], data.recipes[lineRows[i].recipeCode]).map((a) => a.label));
        const nxt = new Set(getMealAllergens(lineRows[i + 1], data.recipes[lineRows[i + 1].recipeCode]).map((a) => a.label));
        const diff = [...cur].some((l) => !nxt.has(l)) || [...nxt].some((l) => !cur.has(l));
        if (diff) total++;
      }
    }
    return total;
  }, [lines, data.recipes]);

  // Sortierte WO-Liste für Listenansicht
  const sortedRows = useMemo(() => {
    const copy = [...rows];
    switch (woSort) {
      case "name":   return copy.sort((a, b) => a.recipeName.localeCompare(b.recipeName));
      case "target": return copy.sort((a, b) => b.target - a.target);
      case "status": return copy.sort((a, b) => a.platingStatus.localeCompare(b.platingStatus));
      case "code":   return copy.sort((a, b) => a.recipeCode.localeCompare(b.recipeCode));
      default:       return copy; // "auto" = Reihenfolge aus CSV
    }
  }, [rows, woSort]);

  return (
    <div>
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-gradient-to-r from-[#0f2240] via-[#1e3a5f] to-[#0f2240] px-6 py-4 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[9px] font-bold text-blue-400 uppercase tracking-[.15em] mb-0.5">PET Plaiting Linienplan</div>
            <div className="text-xl font-black text-white leading-tight">{fmtShiftHeader(shiftKey)}</div>
            <div className="text-xs text-blue-300/80 mt-0.5">
              {rows.length} Meals · {fmtNum(shiftTarget)} Port. · {lineCount} Linien · {staffTotal} MA
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* View Toggle */}
            <div className="flex rounded-xl overflow-hidden border border-white/20">
              <button type="button" onClick={() => setViewMode("lines")}
                className={`text-[10px] font-bold px-3 py-2 transition-colors ${viewMode === "lines" ? "bg-white/20 text-white" : "text-white/60 hover:text-white hover:bg-white/10"}`}>
                Linienplan
              </button>
              <button type="button" onClick={() => setViewMode("list")}
                className={`text-[10px] font-bold px-3 py-2 transition-colors ${viewMode === "list" ? "bg-white/20 text-white" : "text-white/60 hover:text-white hover:bg-white/10"}`}>
                WO Liste
              </button>
            </div>
            <button type="button" onClick={onPrint}
              className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-colors border border-white/10">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
              </svg>
              PDF
            </button>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-4">

        {/* KPI Zeile */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <KpiCard label="Portionen" value={fmtNum(shiftTarget)}
            sub={pct > 0 ? `${pct}% geplated` : undefined} accent="blue" />
          <KpiCard label="Linien" value={String(lineCount)}
            sub={`${fmtNum(PORTIONS_PER_HOUR)} Port./h`} accent="blue" />
          <KpiCard label="Parallel-Zeit" value={`${parallelHours.toFixed(1)} h`}
            sub={`ab ${fmtClock(LINE_START_HOUR * 60)} Uhr`} accent="blue" />
          <KpiCard label="Mitarbeiter" value={String(staffTotal)}
            sub="Submeals + 1 je Linie" accent="blue" />
          <KpiCard label="Reinigungen" value={String(cleaningCount)}
            sub={cleaningCount === 0 ? "Allergen-optimiert" : "Allergen-Wechsel"}
            accent={cleaningCount === 0 ? "green" : "amber"} />
        </div>

        {/* Progress */}
        {pct > 0 && (
          <div>
            <div className="flex justify-between text-[9px] font-bold text-slate-400 mb-1">
              <span>Gesamtfortschritt</span>
              <span>{pct}% · {fmtNum(shiftMapped)} / {fmtNum(shiftTarget)}</span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${pct >= 100 ? "bg-emerald-500" : "bg-blue-500"}`}
                style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </div>
        )}

        {/* Allergen-Übersicht */}
        {allAllergens.size > 0 && (
          <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3">
            <div className="text-[9px] font-black uppercase tracking-[.12em] text-amber-700 mb-2">
              ⚠ Allergene in diesem Shift
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ALLERGEN_DEFS.filter((a) => allAllergens.has(a.label)).map((a) => (
                <span key={a.label} style={{ background: a.bg, color: a.color, borderColor: a.border }}
                  className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold border">
                  {a.label}
                </span>
              ))}
            </div>
            <div className="text-[9px] text-amber-700 mt-2 font-medium">
              Gleiche Allergene wurden gebündelt · Bei Wechsel Linie reinigen
            </div>
          </div>
        )}

        {viewMode === "lines" ? (
          /* ── Linienplan ── */
          <div>
            <div className="text-[9px] font-black uppercase tracking-[.12em] text-slate-400 mb-3">Linienplan</div>
            <div className={`grid gap-4 ${lineCount === 2 ? "grid-cols-2" : "grid-cols-3"}`}>
              {lines.map((lineRows, li) => (
                <LineColumn
                  key={li}
                  lineIndex={li}
                  rows={lineRows}
                  lineTarget={lineTargets[li]}
                  lineStaff={staffByLine[li]}
                  capacity={lineCapacities[li] ?? PORTIONS_PER_HOUR}
                  onCapacityChange={(cap) => onLineCapacityChange(li, cap)}
                  recipes={data.recipes}
                  images={images}
                  onAddImage={onAddImage}
                  onRemoveImage={onRemoveImage}
                />
              ))}
            </div>
          </div>
        ) : (
          /* ── WO Liste ── */
          <WoListView
            rows={sortedRows}
            allRows={rows}
            recipes={data.recipes}
            woSort={woSort}
            onSortChange={setWoSort}
            lines={lines}
          />
        )}

      </div>
    </div>
  );
}

// ── WO List View ───────────────────────────────────────────────────────────

function WoListView({
  rows, allRows, recipes, woSort, onSortChange, lines,
}: {
  rows: PetRow[];
  allRows: PetRow[];
  recipes: Record<string, Recipe>;
  woSort: WoSortMode;
  onSortChange: (s: WoSortMode) => void;
  lines: PetRow[][];
}) {
  // Linienzuordnung: recipeKey → Linienindex
  const lineByKey = useMemo(() => {
    const m = new Map<string, number>();
    lines.forEach((lineRows, li) => lineRows.forEach((r) => m.set(r.key, li)));
    return m;
  }, [lines]);

  const sortLabels: { mode: WoSortMode; label: string }[] = [
    { mode: "auto",   label: "Standard" },
    { mode: "code",   label: "Code A–Z" },
    { mode: "name",   label: "Name A–Z" },
    { mode: "target", label: "Portionen ↓" },
    { mode: "status", label: "Status" },
  ];

  const totalTarget = allRows.reduce((s, r) => s + r.target, 0);
  const doneCount = allRows.filter((r) => r.platingStatus.toLowerCase().includes("complete") || r.platingStatus.toLowerCase().includes("done")).length;

  return (
    <div>
      {/* Sort bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="text-[9px] font-black uppercase tracking-[.12em] text-slate-400 mr-1">Sortierung:</span>
        {sortLabels.map(({ mode, label }) => (
          <button key={mode} type="button" onClick={() => onSortChange(mode)}
            className={`text-[10px] font-bold px-3 py-1.5 rounded-lg border transition-colors ${
              woSort === mode
                ? "bg-[#1e3a5f] text-white border-[#1e3a5f]"
                : "bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-700"
            }`}>
            {label}
          </button>
        ))}
        <span className="ml-auto text-[9px] text-slate-400 tabular-nums">
          {rows.length} WOs · {fmtNum(totalTarget)} Port. · {doneCount} Done
        </span>
      </div>

      {/* WO Karten */}
      <div className="space-y-2">
        {rows.map((row) => {
          const recipe = recipes[row.recipeCode];
          const allergens = getMealAllergens(row, recipe);
          const instr = getPlatingInstructions(recipe, row.market);
          const submeals = getSubmealCount(recipe, row.market);
          const li = lineByKey.get(row.key) ?? 0;
          const lineColor = LINE_COLORS[li] ?? "#94a3b8";
          const lineBg = LINE_COLORS_BG[li] ?? "#f8fafc";
          const { bg: stBg, text: stText } = statusColors(row.platingStatus);
          const mappedPct = row.target > 0 && (row.mapped ?? 0) > 0 ? Math.round((row.mapped ?? 0) / row.target * 100) : 0;

          return (
            <div key={row.key}
              className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden flex"
              style={{ borderLeft: `4px solid ${lineColor}` }}>

              {/* Linien-Badge links */}
              <div className="w-8 shrink-0 flex items-center justify-center text-[9px] font-black text-white"
                style={{ background: lineColor }}>
                L{li + 1}
              </div>

              <div className="flex-1 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  {/* Name + Meta */}
                  <div className="min-w-0">
                    <div className="text-xs font-black text-slate-900 leading-tight">{row.recipeName}</div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {row.recipeCode && (
                        <span className="text-[9px] font-mono text-slate-400">{row.recipeCode}</span>
                      )}
                      {row.market && (
                        <span className="text-[8px] text-slate-400">{row.market}</span>
                      )}
                      <span className="text-[9px] text-slate-400">{submeals} Sub-Meals</span>
                      {instr.length > 0 && (
                        <span className="text-[8px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 font-semibold">
                          {instr.length} Anw.
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Portionen + Status */}
                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    <span className="text-sm font-black text-slate-900 tabular-nums">{fmtNum(row.target)}</span>
                    <span className="text-[9px] text-slate-400">Port.</span>
                    {row.platingStatus && (
                      <span className={`text-[9px] font-bold px-2 py-0.5 rounded-lg ${stBg} ${stText}`}>
                        {row.platingStatus}
                      </span>
                    )}
                    {row.rolloverAmount != null && (
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800">
                        ↩ {fmtNum(row.rolloverAmount)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Progress bar */}
                {mappedPct > 0 && (
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <div className="flex-1 h-1 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full rounded-full ${mappedPct >= 100 ? "bg-emerald-500" : "bg-blue-400"}`}
                        style={{ width: `${Math.min(100, mappedPct)}%` }} />
                    </div>
                    <span className="text-[8px] text-slate-400 tabular-nums">{mappedPct}%</span>
                  </div>
                )}

                {/* Allergen-Badges */}
                {allergens.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {allergens.map((a) => (
                      <span key={a.label} style={{ background: a.bg, color: a.color, borderColor: a.border }}
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[8px] font-bold border">
                        {a.label}
                      </span>
                    ))}
                  </div>
                )}

                {/* Ablauf / Best By Hinweise */}
                <div className="flex gap-2 mt-1 flex-wrap">
                  {row.bestByDate && (
                    <span className="text-[8px] text-violet-700 bg-violet-50 border border-violet-200 rounded px-1.5 py-0.5">
                      📅 {row.bestByDate}
                    </span>
                  )}
                  {row.expiringSubRecipe && (
                    <span className="text-[8px] text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">
                      🕐 {row.expiringSubRecipe}
                    </span>
                  )}
                  {row.comment && (
                    <span className="text-[8px] text-slate-500 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 truncate max-w-[200px]">
                      💬 {row.comment}
                    </span>
                  )}
                </div>

                {/* Anweisungs-Vorschau */}
                {instr.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {instr.map((b) => {
                      const steps = parseSteps(b.text);
                      return (
                        <div key={b.id} className="rounded-lg border border-green-200 overflow-hidden"
                          style={{ background: lineBg }}>
                          <div className="px-2.5 py-1 bg-green-50 border-b border-green-200 text-[9px] font-bold text-green-800">
                            Sub-Meal: {b.name}
                          </div>
                          <div className="px-2.5 py-2 space-y-0.5">
                            {steps.map((step, si) => (
                              <div key={si} className="flex gap-2 text-[9px]">
                                <span className="font-black text-green-700 min-w-[14px] shrink-0">{si + 1}.</span>
                                <span className="text-slate-700 leading-tight">{step}</span>
                              </div>
                            ))}
                            {steps.length === 0 && (
                              <div className="text-[9px] text-slate-400">{b.text}</div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── KPI Card ───────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, accent }: {
  label: string;
  value: string;
  sub?: string;
  accent: "blue" | "green" | "amber" | "red";
}) {
  const colors = {
    blue: "bg-[#1e3a5f] border-[#1e3a5f]",
    green: "bg-white border-emerald-200",
    amber: "bg-amber-50 border-amber-200",
    red: "bg-red-50 border-red-200",
  };
  const valueColors = {
    blue: "text-white",
    green: "text-emerald-800",
    amber: "text-amber-800",
    red: "text-red-800",
  };
  const subColors = {
    blue: "text-blue-300",
    green: "text-emerald-600",
    amber: "text-amber-600",
    red: "text-red-600",
  };
  const labelColors = {
    blue: "text-blue-400",
    green: "text-slate-400",
    amber: "text-amber-600",
    red: "text-red-600",
  };
  return (
    <div className={`rounded-2xl px-4 py-3.5 border ${colors[accent]}`}>
      <div className={`text-[8px] font-black uppercase tracking-[.12em] mb-1.5 ${labelColors[accent]}`}>{label}</div>
      <div className={`text-xl font-black tabular-nums ${valueColors[accent]}`}>{value}</div>
      {sub && <div className={`text-[9px] mt-0.5 ${subColors[accent]}`}>{sub}</div>}
    </div>
  );
}

// ── Line Column ────────────────────────────────────────────────────────────

function LineColumn({
  lineIndex, rows, lineTarget, lineStaff, capacity, onCapacityChange, recipes, images, onAddImage, onRemoveImage,
}: {
  lineIndex: number;
  rows: PetRow[];
  lineTarget: number;
  lineStaff: number;
  capacity: number;
  onCapacityChange: (n: number) => void;
  recipes: Record<string, Recipe>;
  images: Record<string, PlatingImage[]>;
  onAddImage: (code: string, f: File) => void;
  onRemoveImage: (code: string, idx: number) => void;
}) {
  const [editingCap, setEditingCap] = useState(false);
  const [capDraft, setCapDraft] = useState(String(capacity));
  const capInputRef = useRef<HTMLInputElement>(null);

  const color = LINE_COLORS[lineIndex] ?? "#94a3b8";
  const bg = LINE_COLORS_BG[lineIndex] ?? "#f8fafc";
  const border = LINE_COLORS_BORDER[lineIndex] ?? "#e2e8f0";
  const darkColor = LINE_COLORS_DARK[lineIndex] ?? "#475569";
  const lineHours = lineTarget / capacity;
  const utilPct = Math.min(100, Math.round(lineTarget / capacity * 100));

  function commitCapacity() {
    const n = parseInt(capDraft.replace(/\D/g, ""), 10);
    if (n >= 100 && n <= 9999) onCapacityChange(n);
    else setCapDraft(String(capacity));
    setEditingCap(false);
  }

  return (
    <div className="rounded-2xl overflow-hidden border" style={{ borderColor: border }}>
      {/* Linien-Header */}
      <div className="px-4 py-3 text-white font-bold text-xs" style={{ background: color }}>
        <div className="flex items-center justify-between">
          <div className="font-black text-sm">Linie {lineIndex + 1}</div>
          {/* Editierbare Kapazität */}
          <div className="flex items-center gap-1">
            {editingCap ? (
              <input
                ref={capInputRef}
                type="number"
                min={100}
                max={9999}
                title={`Kapazität Linie ${lineIndex + 1} (Port./h)`}
                aria-label={`Kapazität Linie ${lineIndex + 1} in Portionen pro Stunde`}
                value={capDraft}
                onChange={(e) => setCapDraft(e.target.value)}
                onBlur={commitCapacity}
                onKeyDown={(e) => { if (e.key === "Enter") commitCapacity(); if (e.key === "Escape") { setCapDraft(String(capacity)); setEditingCap(false); } }}
                className="w-16 text-xs text-center font-bold text-slate-900 bg-white rounded px-1 py-0.5 border-0 outline-none focus:ring-1 focus:ring-white/50"
                autoFocus
              />
            ) : (
              <button
                type="button"
                onClick={() => { setCapDraft(String(capacity)); setEditingCap(true); setTimeout(() => capInputRef.current?.select(), 10); }}
                title="Kapazität bearbeiten"
                className="flex items-center gap-1 text-white/80 hover:text-white hover:bg-white/20 rounded px-1.5 py-0.5 transition-colors text-[10px] font-bold group"
              >
                <span>{fmtNum(capacity)}/h</span>
                <svg className="w-3 h-3 opacity-50 group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-3 mt-0.5 text-white/80 text-[10px]">
          <span>{fmtNum(lineTarget)} Port.</span>
          <span>{lineHours.toFixed(1)} h</span>
          <span>{lineStaff} MA</span>
        </div>
      </div>

      {/* Auslastungsbalken + Meta */}
      <div className="px-3 py-2" style={{ background: bg }}>
        <div className="flex justify-between text-[9px] mb-1" style={{ color: darkColor }}>
          <span>Start {fmtClock(LINE_START_HOUR * 60)} · Ende ~{fmtClock(LINE_START_HOUR * 60 + lineHours * 60)}</span>
          <span className="font-bold">{utilPct}% Auslastung</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden bg-white/60">
          <div className="h-full rounded-full" style={{ width: `${utilPct}%`, background: color }} />
        </div>
      </div>

      {/* Meal Cards */}
      <div className="p-2 space-y-1" style={{ background: bg }}>
        {rows.length === 0 ? (
          <div className="text-center py-4 text-xs text-slate-400">Keine Meals</div>
        ) : rows.map((row, mi) => {
          const next = rows[mi + 1];
          const curAllergens = getMealAllergens(row, recipes[row.recipeCode]);
          const nxtAllergens = next ? getMealAllergens(next, recipes[next.recipeCode]) : [];
          const curSet = new Set(curAllergens.map((a) => a.label));
          const nxtSet = new Set(nxtAllergens.map((a) => a.label));
          const removed = [...curSet].filter((l) => !nxtSet.has(l));
          const added = [...nxtSet].filter((l) => !curSet.has(l));
          const hasChange = next && (removed.length > 0 || added.length > 0);

          const prevTarget = rows.slice(0, mi).reduce((s, r) => s + r.target, 0);
          const startMin = LINE_START_HOUR * 60 + Math.round(prevTarget / capacity * 60);
          const endMin = startMin + Math.max(10, Math.round(row.target / capacity * 60));

          return (
            <div key={row.key}>
              <MealCard
                row={row}
                recipe={recipes[row.recipeCode]}
                allergens={curAllergens}
                timeStart={startMin}
                timeEnd={endMin}
                lineColor={color}
                images={images[row.recipeCode] ?? []}
                onAddImage={(f) => onAddImage(row.recipeCode, f)}
                onRemoveImage={(idx) => onRemoveImage(row.recipeCode, idx)}
              />
              {hasChange && (
                <div className="mx-1 my-1 px-3 py-1.5 rounded-lg border border-dashed border-amber-400 bg-amber-50 text-[9px] text-amber-800 font-bold">
                  ⚠ LINIE REINIGEN
                  {removed.length > 0 && <span className="font-normal"> · entfernt: {removed.join(", ")}</span>}
                  {added.length > 0 && <span className="font-normal"> · neu: {added.join(", ")}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Meal Card ──────────────────────────────────────────────────────────────

function MealCard({
  row, recipe, allergens, timeStart, timeEnd, lineColor, images, onAddImage, onRemoveImage,
}: {
  row: PetRow;
  recipe: Recipe | undefined;
  allergens: AllergenDef[];
  timeStart: number;
  timeEnd: number;
  lineColor: string;
  images: PlatingImage[];
  onAddImage: (f: File) => void;
  onRemoveImage: (idx: number) => void;
}) {
  const imgInputRef = useRef<HTMLInputElement>(null);
  const platingInstr = getPlatingInstructions(recipe, row.market);
  const structuredAllergens = getStructuredAllergens(recipe, row.market);
  const submeals = getSubmealCount(recipe, row.market);
  const hours = (timeEnd - timeStart) / 60;
  const { bg: stBg, text: stText } = statusColors(row.platingStatus);
  const mapped = row.mapped ?? 0;
  const mappedPct = row.target > 0 && mapped > 0 ? Math.round(mapped / row.target * 100) : 0;

  // Gesamtzahl Schritte über alle Sub-Meals
  const totalSteps = platingInstr.reduce((s, b) => s + parseSteps(b.text).length, 0);

  return (
    <div className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden"
      style={{ borderLeft: `3px solid ${lineColor}` }}>
      <div className="px-3 py-2.5">
        {/* Kopfzeile: Name + Zeitfenster */}
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-black text-slate-900 leading-tight">{row.recipeName}</div>
            {row.recipeCode && (
              <div className="text-[9px] font-mono text-slate-400 mt-0.5">
                {row.recipeCode}{row.market && ` · ${row.market}`} · {submeals} Subm.
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="text-[10px] font-black tabular-nums" style={{ color: lineColor }}>
              {fmtClock(timeStart)}–{fmtClock(timeEnd)}
            </div>
            <div className="text-[9px] text-slate-400">{hours.toFixed(1)} h</div>
          </div>
        </div>

        {/* Portionen + Status */}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className="text-sm font-black text-slate-900 tabular-nums">{fmtNum(row.target)}</span>
          <span className="text-[9px] text-slate-400">Port.</span>
          {row.platingStatus && (
            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-lg ${stBg} ${stText}`}>
              {row.platingStatus}
            </span>
          )}
          {row.rolloverAmount != null && (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800">
              ↩ {fmtNum(row.rolloverAmount)} Rollover
            </span>
          )}
        </div>

        {/* Fortschritt */}
        {mappedPct > 0 && (
          <div className="mb-2">
            <div className="flex justify-between text-[8px] text-slate-400 mb-0.5">
              <span>Geplated</span>
              <span>{mappedPct}% · {fmtNum(mapped)}</span>
            </div>
            <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${mappedPct >= 100 ? "bg-emerald-500" : "bg-blue-400"}`}
                style={{ width: `${Math.min(100, mappedPct)}%` }} />
            </div>
          </div>
        )}

        {/* Allergen-Badges */}
        <div className="flex flex-wrap gap-1 mb-2">
          {allergens.length > 0 ? allergens.map((a) => (
            <span key={a.label} style={{ background: a.bg, color: a.color, borderColor: a.border }}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold border">
              {a.label}
            </span>
          )) : <span className="text-[9px] text-slate-300">keine Allergene</span>}
        </div>

        {/* Allergen-Text aus App-Daten */}
        {structuredAllergens && (
          <div className="flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 text-[9px] text-amber-800 mb-2">
            <span className="shrink-0 mt-0.5">⚠</span>
            <span><strong>Allergene:</strong> {structuredAllergens}</span>
          </div>
        )}

        {/* Hinweise */}
        {row.bestByDate && (
          <div className="flex items-start gap-1.5 bg-violet-50 border border-violet-200 rounded-lg px-2.5 py-1.5 text-[9px] text-violet-800 mb-1.5">
            <span>📅</span>
            <span><strong>Best By:</strong> {row.bestByDate}{row.bestBySubRecipe ? ` · ${row.bestBySubRecipe}` : ""}</span>
          </div>
        )}
        {row.expiringSubRecipe && (
          <div className="flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 text-[9px] text-red-800 mb-1.5">
            <span>🕐</span>
            <span>
              <strong>Ablauf:</strong> {row.expiringSubRecipe}
              {row.expiringPortions && ` · ${fmtNum(parseFloat(row.expiringPortions))} Port.`}
              {row.expiringDatetime && ` · ${row.expiringDatetime}`}
            </span>
          </div>
        )}
        {row.comment && (
          <div className="flex items-start gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-[9px] text-slate-600 mb-1.5">
            <span>💬</span><span>{row.comment}</span>
          </div>
        )}

        {/* Plating-Anweisungen – immer sichtbar, nummerierte Schritte je Sub-Meal */}
        {platingInstr.length > 0 && (
          <div className="space-y-2">
            <div className="text-[8px] font-black uppercase tracking-[.1em] text-green-700">
              Anweisungen · {platingInstr.length} Sub-Meals · {totalSteps} Schritte
            </div>
            {platingInstr.map((b) => {
              const steps = parseSteps(b.text);
              return (
                <div key={b.id} className="rounded-xl border border-green-200 overflow-hidden">
                  <div className="px-3 py-1.5 bg-green-50 border-b border-green-200 flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" d="M9 5l7 7-7 7"/>
                      </svg>
                    </div>
                    <div className="text-[9px] font-bold text-green-800">{b.name}</div>
                    <span className="ml-auto text-[8px] text-green-600">{steps.length} Schritte</span>
                  </div>
                  <div className="px-3 py-2 bg-green-50/40 space-y-1.5">
                    {steps.length > 0 ? steps.map((step, si) => (
                      <div key={si} className="flex gap-2.5 items-start">
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-600 text-white text-[8px] font-black shrink-0 mt-0.5">
                          {si + 1}
                        </span>
                        <span className="text-[10px] leading-snug text-slate-700 flex-1">{step}</span>
                      </div>
                    )) : (
                      <pre className="whitespace-pre-wrap text-[10px] leading-relaxed text-slate-700">{b.text}</pre>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!recipe && (
          <div className="text-[9px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1">
            ⚠ Rezept {row.recipeCode} nicht in App-Daten
          </div>
        )}

        {/* Fotos */}
        <div className="mt-2">
          <input ref={imgInputRef} type="file" accept="image/*" multiple
            title="Foto hochladen" aria-label="Foto hochladen" className="hidden"
            onChange={(e) => { Array.from(e.target.files ?? []).forEach((f) => onAddImage(f)); e.target.value = ""; }} />

          {images.length > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[9px] font-black uppercase tracking-[.1em] text-slate-400">
                  Fotos ({images.length})
                </div>
                <button type="button" onClick={() => imgInputRef.current?.click()}
                  className="text-[9px] font-bold text-blue-600 hover:text-blue-800">
                  + Foto
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {images.map((img, idx) => (
                  <div key={idx} className="relative group rounded-lg overflow-hidden border border-slate-200 bg-white">
                    <img src={img.dataUrl} alt="Foto" className="w-full h-20 object-contain p-1" />
                    <div className="px-2 py-1 bg-slate-50 border-t border-slate-100">
                      <div className="text-[8px] text-slate-400 truncate">{img.name}</div>
                    </div>
                    <button type="button" onClick={() => onRemoveImage(idx)}
                      className="absolute top-1 right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => imgInputRef.current?.click()}
              className="w-full rounded-xl border border-dashed border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/40 px-3 py-2 text-center transition-all">
              <div className="text-[9px] font-semibold text-slate-400">📸 Foto hinzufügen</div>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
