// PetPlanView.tsx – PET Plan → Plating / Portionierung → PDF
// Liest das KitchenOS PET-CSV; zeigt Shift-Übersicht, Rezept-Detail,
// Plating-Anweisungen aus App-Daten und Bild-Upload für Packmuster.

import { useState, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";
import type { DataBundle, Recipe, Market } from "./types";

// ── Konstanten ──────────────────────────────────────────────────────────────

const LS_IMAGES_KEY = "pet_plating_images_v1";

// ── Types ──────────────────────────────────────────────────────────────────

interface PetRow {
  key: string;
  shiftKey: string;         // "2026-06-02 - 1"
  shiftTotalTarget: number;
  shiftTotalMapped: number | null;
  woNumber: string;         // "24-R2"
  recipeName: string;       // clean name
  recipeCode: string;       // "FV0713A"
  market: string;           // "[DE]", "[BNL]", "[DKSE]"
  mapped: number | null;    // Recipe WO Mapped
  target: number;           // Recipe WO Target
  platingStatus: string;    // "In Progress" | "Not Started"
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
        key: `pet::${idx}::${shiftKey}::${(row["Recipe WO #"] ?? idx).toString().trim()}`,
        shiftKey,
        shiftTotalTarget: parseNum(row["Total Target"] ?? "") ?? 0,
        shiftTotalMapped: parseNum(row["Total Mapped"] ?? ""),
        woNumber: (row["Recipe WO #"] ?? "").trim(),
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

// ── Recipe data helpers ────────────────────────────────────────────────────

function marketKey(marketTag: string): Market | null {
  if (marketTag.includes("BNL") || marketTag.includes("BENL")) return "BENL";
  if (marketTag.includes("DKSE")) return "DKSE";
  if (marketTag.includes("DE")) return "DE";
  return null;
}

function getPlatingInstructions(
  recipe: Recipe | undefined,
  market: string,
): Array<{ name: string; id: string; text: string }> {
  if (!recipe) return [];
  const mk = marketKey(market);
  const marketsToCheck: (Market | null)[] = mk ? [mk, ...["DE","BENL","DKSE"].filter(m => m !== mk) as Market[]] : ["DE","BENL","DKSE"];
  for (const m of marketsToCheck) {
    if (!m) continue;
    const md = recipe.markets[m];
    if (!md) continue;
    const result = md.subRecipes
      .filter((s) => s.instructions)
      .map((s) => ({ name: s.name, id: s.id, text: s.instructions ?? "" }));
    if (result.length > 0) return result;
  }
  return [];
}

function getAllergens(recipe: Recipe | undefined, market: string): string {
  if (!recipe) return "";
  const mk = marketKey(market);
  const marketsToCheck: (Market | null)[] = mk ? [mk] : ["DE","BENL","DKSE"];
  for (const m of marketsToCheck) {
    if (!m) continue;
    const md = recipe.markets[m];
    if (md?.allergens) return md.allergens;
  }
  return "";
}

// ── Status helpers ─────────────────────────────────────────────────────────

function statusStyle(status: string): { bg: string; text: string; dot: string } {
  const s = status.toLowerCase();
  if (s.includes("complete") || s.includes("done") || s.includes("finished"))
    return { bg: "bg-emerald-100", text: "text-emerald-800", dot: "bg-emerald-500" };
  if (s.includes("in progress") || s.includes("running"))
    return { bg: "bg-blue-100", text: "text-blue-800", dot: "bg-blue-500" };
  if (s.includes("not started") || s.includes("open") || !s)
    return { bg: "bg-slate-100", text: "text-slate-500", dot: "bg-slate-400" };
  if (s.includes("hold") || s.includes("blocked"))
    return { bg: "bg-red-100", text: "text-red-700", dot: "bg-red-500" };
  return { bg: "bg-amber-100", text: "text-amber-800", dot: "bg-amber-500" };
}

// ── PDF Builder ────────────────────────────────────────────────────────────

function buildPetPdf(
  rows: PetRow[],
  title: string,
  images: Record<string, PlatingImage[]>,
  recipeData: Record<string, Recipe>,
): string {
  // Group by shift
  const shiftMap = new Map<string, PetRow[]>();
  for (const row of rows) {
    if (!shiftMap.has(row.shiftKey)) shiftMap.set(row.shiftKey, []);
    shiftMap.get(row.shiftKey)!.push(row);
  }
  const shifts = [...shiftMap.entries()].sort((a, b) => shiftSortKey(a[0]) - shiftSortKey(b[0]));

  const shiftBlocks = shifts.map(([shiftKey, shiftRows], si) => {
    const first = shiftRows[0];
    const shiftTarget = first?.shiftTotalTarget ?? 0;
    const shiftMapped = first?.shiftTotalMapped ?? null;
    const shiftPct = shiftTarget > 0 && shiftMapped != null ? Math.round((shiftMapped / shiftTarget) * 100) : null;
    const shiftProgress = shiftPct != null
      ? `<div style="height:6px;background:#e5e7eb;border-radius:3px;margin-top:4px;overflow:hidden">
           <div style="height:100%;width:${Math.min(100, shiftPct)}%;background:${shiftPct >= 100 ? "#10b981" : "#3b82f6"};border-radius:3px"></div>
         </div>` : "";

    const recipeCards = shiftRows.map((row) => {
      const recipe = recipeData[row.recipeCode];
      const platInstr = getPlatingInstructions(recipe, row.market);
      const allergens = getAllergens(recipe, row.market);
      const imgs = images[row.recipeCode] ?? [];

      const mapped = row.mapped ?? 0;
      const pct = row.target > 0 && mapped > 0 ? Math.round((mapped / row.target) * 100) : 0;

      const statusCol =
        row.platingStatus.toLowerCase().includes("in progress") ? "background:#dbeafe;color:#1e40af" :
        row.platingStatus.toLowerCase().includes("complete") ? "background:#d1fae5;color:#065f46" :
        "background:#f1f5f9;color:#475569";

      const instrHtml = platInstr.length > 0
        ? `<div style="margin-top:10px">
            <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:4px">Plating Anweisungen</div>
            ${platInstr.map(b => `
              <div style="background:#eff6ff;border:1px solid #bfdbfe;border-left:3px solid #3b82f6;border-radius:5px;padding:7px 10px;margin-bottom:5px">
                <div style="font-size:9px;font-weight:700;color:#1e40af;margin-bottom:3px">${b.name}</div>
                <div style="font-size:10px;white-space:pre-wrap;color:#1e3a5f;line-height:1.5">${b.text.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>
              </div>`).join("")}
          </div>` : "";

      const imgHtml = imgs.length > 0
        ? `<div style="margin-top:10px">
            <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:4px">Packmuster</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px">
              ${imgs.map(img => `
                <div style="text-align:center">
                  <img src="${img.dataUrl}" alt="Packmuster" style="max-width:200px;max-height:160px;border-radius:5px;border:1px solid #e2e8f0;object-fit:contain"/>
                  <div style="font-size:8px;color:#6b7280;margin-top:2px">${img.name}</div>
                </div>`).join("")}
            </div>
          </div>` : "";

      const expiryHtml = row.expiringSubRecipe
        ? `<div style="background:#fef3c7;border:1px solid #fbbf24;border-left:3px solid #f59e0b;border-radius:5px;padding:6px 10px;margin-top:8px;font-size:9px;color:#92400e">
            ⚠ <strong>Ablauf:</strong> ${row.expiringSubRecipe} · ${row.expiringPortions ? fmtNum(parseFloat(row.expiringPortions)) + " Port." : ""} ${row.expiringDatetime ? `· ${row.expiringDatetime}` : ""} ${row.expiringLp ? `· LP# ${row.expiringLp}` : ""}
           </div>` : "";

      return `
      <div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#fff;page-break-inside:avoid">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
          <div>
            <div style="font-size:20px;font-weight:900;color:#1e3a5f;line-height:1">WO ${row.woNumber}</div>
            <div style="font-size:10px;color:#374151;font-weight:600;margin-top:2px">${row.recipeName} <span style="font-size:9px;font-weight:400;color:#9ca3af">${row.market}</span></div>
          </div>
          <div style="text-align:right">
            <span style="font-size:9px;font-weight:700;padding:3px 8px;border-radius:4px;${statusCol}">${row.platingStatus || "—"}</span>
            ${row.manualStatus ? `<div style="font-size:8px;color:#6b7280;margin-top:2px">${row.manualStatus}</div>` : ""}
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:8px">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:5px 7px">
            <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af">Ziel</div>
            <div style="font-size:16px;font-weight:900;color:#111">${row.target > 0 ? fmtNum(row.target) : "—"}</div>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:5px 7px">
            <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af">Geplated</div>
            <div style="font-size:16px;font-weight:900;color:#111">${mapped > 0 ? fmtNum(mapped) : "—"}</div>
            ${pct > 0 ? `<div style="font-size:8px;color:#059669;font-weight:700">${pct}%</div>
            <div style="height:3px;background:#e5e7eb;border-radius:2px;overflow:hidden;margin-top:2px">
              <div style="height:100%;width:${Math.min(100,pct)}%;background:${pct>=100?"#10b981":"#3b82f6"}"></div>
            </div>` : ""}
          </div>
          ${row.minNeeds != null ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:5px 7px">
            <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af">Min. Bedarf</div>
            <div style="font-size:16px;font-weight:900;color:#111">${fmtNum(row.minNeeds)}</div>
          </div>` : ""}
          ${row.rolloverAmount != null ? `<div style="background:#fef9c3;border:1px solid #fde68a;border-radius:5px;padding:5px 7px">
            <div style="font-size:7px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#92400e">Rollover</div>
            <div style="font-size:16px;font-weight:900;color:#92400e">${fmtNum(row.rolloverAmount)}</div>
          </div>` : ""}
        </div>
        ${allergens ? `<div style="background:#fef3c7;border:1px solid #fbbf24;border-left:3px solid #f59e0b;border-radius:5px;padding:5px 9px;font-size:9px;color:#92400e;margin-bottom:5px">⚠ <strong>Allergene:</strong> ${allergens}</div>` : ""}
        ${row.comment ? `<div style="background:#f1f5f9;border-left:3px solid #94a3b8;border-radius:5px;padding:5px 9px;font-size:9px;color:#374151;margin-bottom:5px">💬 ${row.comment}</div>` : ""}
        ${row.bestByDate ? `<div style="background:#f5f3ff;border-left:3px solid #a78bfa;border-radius:5px;padding:5px 9px;font-size:9px;color:#5b21b6;margin-bottom:5px">📅 <strong>Best By:</strong> ${row.bestByDate} ${row.bestBySubRecipe ? `· ${row.bestBySubRecipe}` : ""}</div>` : ""}
        ${expiryHtml}
        ${instrHtml}
        ${imgHtml}
      </div>`;
    }).join("\n");

    return `
    <div style="page-break-before:${si > 0 ? "always" : "auto"}">
      <div style="background:linear-gradient(135deg,#0f2240,#1e3a5f);color:#fff;padding:10px 14px;border-radius:8px 8px 0 0;-webkit-print-color-adjust:exact;print-color-adjust:exact">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:9px;font-weight:700;color:#93c5fd;text-transform:uppercase;letter-spacing:.1em">Production Shift</div>
            <div style="font-size:16px;font-weight:900;color:#fff;margin-top:1px">${fmtShiftHeader(shiftKey)}</div>
          </div>
          <div style="text-align:right">
            ${shiftTarget > 0 ? `<div style="font-size:11px;font-weight:700;color:#e0f2fe">Ziel: ${fmtNum(shiftTarget)}</div>` : ""}
            ${shiftMapped != null ? `<div style="font-size:11px;color:#93c5fd">Geplated: ${fmtNum(shiftMapped)}${shiftPct != null ? ` (${shiftPct}%)` : ""}</div>` : ""}
            ${shiftProgress}
          </div>
        </div>
        <div style="font-size:9px;color:#93c5fd;margin-top:3px">${shiftRows.length} Rezepte</div>
      </div>
      <div style="padding:8px 0">${recipeCards}</div>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;font-size:11px;color:#111;background:#fff}
@media print{
  body{font-size:10px}
  @page{size:A4;margin:8mm}
}
</style>
</head>
<body>
<div style="padding:12px 16px 8px;background:linear-gradient(135deg,#0f2240,#1e3a5f);color:#fff;margin-bottom:12px;-webkit-print-color-adjust:exact;print-color-adjust:exact">
  <div style="font-size:20px;font-weight:900;letter-spacing:-.02em">🍽 ${title}</div>
  <div style="font-size:9px;color:#93c5fd;margin-top:3px">Generiert: ${new Date().toLocaleString("de-DE")} · ${rows.length} Recipe WOs · ${shifts.length} Shifts</div>
</div>
${shiftBlocks}
</body>
</html>`;
}

// ── Image helpers ──────────────────────────────────────────────────────────

function loadImages(): Record<string, PlatingImage[]> {
  try {
    const raw = localStorage.getItem(LS_IMAGES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveImages(imgs: Record<string, PlatingImage[]>) {
  try { localStorage.setItem(LS_IMAGES_KEY, JSON.stringify(imgs)); } catch { /* */ }
}

// ── Main Component ─────────────────────────────────────────────────────────

export function PetPlanView({ data }: { data: DataBundle }) {
  const [csvRows, setCsvRows] = useState<PetRow[] | null>(null);
  const [csvFileName, setCsvFileName] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [search, setSearch] = useState("");
  const [images, setImages] = useState<Record<string, PlatingImage[]>>(loadImages);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);

  // ── CSV handling ──────────────────────────────────────────────────────────
  const handleFile = useCallback((file: File) => {
    setCsvFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parsePetCsv(text);
      setCsvRows(parsed);
      setSelectedKey(parsed[0]?.key ?? null);
    };
    reader.readAsText(file, "utf-8");
  }, []);

  // ── Image handling ────────────────────────────────────────────────────────
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

  // ── Data computations ─────────────────────────────────────────────────────
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
          [r.woNumber, r.recipeName, r.recipeCode, r.platingStatus, r.comment].join(" ").toLowerCase().includes(needle)
        ),
      }))
      .filter((g) => g.rows.length > 0);
  }, [shiftGroups, needle]);

  const filteredRows = filteredGroups.flatMap((g) => g.rows);
  const allRows = shiftGroups.flatMap((g) => g.rows);
  const selectedRow = csvRows?.find((r) => r.key === selectedKey) ?? null;

  // ── Print ─────────────────────────────────────────────────────────────────
  function printPdf(rows: PetRow[]) {
    const title = `PET Plan Plating – ${new Date().toLocaleDateString("de-DE")}`;
    const html = buildPetPdf(rows, title, images, data.recipes);
    const w = window.open("", "_blank", "width=960,height=750");
    if (!w) { alert("Popup blockiert – bitte für diese Seite erlauben."); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 450);
  }

  // ── Aggregate stats ───────────────────────────────────────────────────────
  const totalTarget = allRows.reduce((s, r) => s + r.target, 0);
  const totalMapped = allRows.reduce((s, r) => s + (r.mapped ?? 0), 0);
  const inProgressCount = allRows.filter((r) => r.platingStatus.toLowerCase().includes("progress")).length;

  // ════════════════════════════════════════════════════
  // UPLOAD SCREEN
  // ════════════════════════════════════════════════════
  if (!csvRows) {
    return (
      <div className="flex h-[calc(100vh-112px)] items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-lg">
        <div className="text-center max-w-sm px-6">
          <div className="w-20 h-20 rounded-3xl bg-slate-100 flex items-center justify-center mx-auto mb-5">
            <svg className="w-10 h-10 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 0v10m0-10a2 2 0 012 2h2a2 2 0 012-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/>
            </svg>
          </div>
          <h2 className="text-lg font-black text-slate-700 mb-2">PET Plan laden</h2>
          <p className="text-sm text-slate-500 mb-5">
            Lade deine PET-CSV hoch. Spalten werden automatisch erkannt.<br/>
            <span className="text-[11px] text-slate-400">Erwartet: Type, Production Shift, Recipe WO #, Recipe Name, Recipe WO Target …</span>
          </p>
          <input ref={fileInputRef} type="file" accept=".csv" aria-label="PET CSV hochladen" title="PET CSV hochladen" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          <div
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            className={`cursor-pointer rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-all select-none ${
              dragOver ? "border-blue-400 bg-blue-50 scale-[1.02]" : "border-slate-300 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/50"
            }`}
          >
            <div className="text-sm font-bold text-slate-700 mb-1">🍽 PET CSV hochladen</div>
            <div className="text-xs text-slate-400">Klicken oder Datei hier ablegen · .csv</div>
          </div>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════
  // MAIN VIEW
  // ════════════════════════════════════════════════════
  return (
    <div className="flex h-[calc(100vh-112px)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">

      {/* ════════ LEFT SIDEBAR ════════ */}
      <aside className="w-[290px] shrink-0 flex flex-col border-r border-slate-200 overflow-hidden">

        {/* Header */}
        <div className="px-4 pt-4 pb-3 bg-gradient-to-b from-[#0f2240] to-[#1e3a5f]">
          <div className="text-[9px] font-bold text-blue-300 uppercase tracking-[0.15em] mb-1">PET Plan · Plating</div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl font-black text-white tabular-nums">{allRows.length}</span>
            <span className="text-xs text-blue-300">WOs</span>
            {totalTarget > 0 && (
              <><span className="text-blue-600">·</span>
              <span className="text-lg font-black text-blue-200 tabular-nums">{fmtNum(totalTarget)}</span>
              <span className="text-xs text-blue-300">Port. Ziel</span></>
            )}
          </div>
          {totalMapped > 0 && (
            <div className="mt-1.5">
              <div className="flex justify-between text-[8px] text-blue-300 mb-0.5">
                <span>Geplated</span>
                <span>{totalTarget > 0 ? `${Math.round((totalMapped/totalTarget)*100)}%` : ""} · {fmtNum(totalMapped)}</span>
              </div>
              <div className="h-1.5 bg-white/20 rounded-full overflow-hidden">
                <div className="h-full bg-blue-400 rounded-full" style={{ width: `${Math.min(100, totalTarget > 0 ? (totalMapped/totalTarget)*100 : 0)}%` }}></div>
              </div>
            </div>
          )}
          {inProgressCount > 0 && (
            <div className="text-[9px] text-blue-400 mt-1">{inProgressCount} WOs laufen gerade</div>
          )}
          <div className="text-[9px] text-blue-400 mt-1 font-mono truncate">✓ {csvFileName}</div>
        </div>

        {/* CSV Replace */}
        <div className="px-3 py-2 border-b border-slate-100">
          <input ref={fileInputRef} type="file" accept=".csv" title="PET CSV ersetzen" aria-label="PET CSV ersetzen" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          <button type="button" onClick={() => fileInputRef.current?.click()}
            className="w-full text-[10px] font-semibold text-slate-500 hover:text-blue-600 hover:bg-blue-50 py-1.5 rounded-lg transition-colors">
            ↑ Andere CSV laden
          </button>
          <button type="button" onClick={() => { setCsvRows(null); setCsvFileName(""); setSelectedKey(null); }}
            className="w-full text-[9px] text-slate-400 hover:text-red-500 transition-colors py-0.5">
            × CSV entfernen
          </button>
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-slate-100">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" d="m21 21-4.35-4.35"/></svg>
            <input type="search" placeholder="WO, Rezept, Status …" value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 focus:bg-white" />
          </div>
        </div>

        {/* WO List grouped by shift */}
        <div className="flex-1 overflow-y-auto py-1">
          {filteredGroups.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400">Keine WOs gefunden</div>
          ) : filteredGroups.map(({ shiftKey, rows }) => {
            const first = rows[0];
            const shiftTarget = first?.shiftTotalTarget ?? 0;
            const shiftMapped = first?.shiftTotalMapped ?? null;
            const shiftPct = shiftTarget > 0 && shiftMapped != null ? Math.round((shiftMapped / shiftTarget) * 100) : null;
            return (
              <div key={shiftKey} className="mb-1">
                {/* Shift header */}
                <div className="sticky top-0 bg-slate-50/90 backdrop-blur-sm border-y border-slate-100 z-10 px-3 py-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-500">{fmtShiftShort(shiftKey)}</span>
                    <span className="text-[9px] text-slate-400">{rows.length} WOs</span>
                  </div>
                  {shiftTarget > 0 && (
                    <div className="mt-1 flex items-center gap-1.5">
                      <div className="flex-1 h-1 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(100, shiftPct ?? 0)}%` }}></div>
                      </div>
                      <span className="text-[8px] text-slate-400 tabular-nums">
                        {shiftMapped != null ? `${fmtNum(shiftMapped)} /` : ""} {fmtNum(shiftTarget)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Recipe WO rows */}
                <div className="px-2 py-1 space-y-1">
                  {rows.map((row) => {
                    const isSelected = selectedKey === row.key;
                    const ss = statusStyle(row.platingStatus);
                    const mapped = row.mapped ?? 0;
                    const pct = row.target > 0 && mapped > 0 ? (mapped / row.target) * 100 : 0;
                    const hasExpiry = !!row.expiringSubRecipe;
                    const hasImages = (images[row.recipeCode]?.length ?? 0) > 0;
                    return (
                      <button type="button" key={row.key} onClick={() => setSelectedKey(row.key)}
                        className={`w-full text-left rounded-xl px-3 py-2.5 transition-all ${
                          isSelected ? "bg-[#1e3a5f] shadow-md ring-2 ring-[#1e3a5f]/30"
                            : "bg-white hover:bg-slate-50 border border-slate-150 shadow-sm hover:shadow"
                        }`}>
                        <div className="flex items-start justify-between gap-1 mb-0.5">
                          <span className={`text-[11px] font-black leading-tight ${isSelected ? "text-white" : "text-[#1e3a5f]"}`}>
                            WO {row.woNumber}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            {hasExpiry && <span className="text-[8px]">⚠</span>}
                            {hasImages && <span className="text-[8px]">🖼</span>}
                            <span className={`text-[8px] font-semibold px-1.5 py-0.5 rounded-md ${ss.bg} ${ss.text}`}>
                              {row.platingStatus || "—"}
                            </span>
                          </div>
                        </div>
                        <div className={`text-[10px] truncate leading-tight ${isSelected ? "text-blue-200" : "text-slate-600"}`}>
                          {row.recipeName}
                          {row.market && <span className={`ml-1 text-[8px] ${isSelected ? "text-blue-400" : "text-slate-400"}`}>{row.market}</span>}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          {row.target > 0 && (
                            <span className={`text-[9px] tabular-nums ${isSelected ? "text-blue-300" : "text-slate-400"}`}>
                              {mapped > 0 ? `${fmtNum(mapped)} / ` : ""}{fmtNum(row.target)}
                            </span>
                          )}
                          {pct > 0 && (
                            <div className={`flex-1 h-1 rounded-full overflow-hidden ${isSelected ? "bg-white/20" : "bg-slate-100"}`}>
                              <div className={`h-full rounded-full ${pct >= 100 ? "bg-emerald-500" : "bg-blue-400"}`}
                                style={{ width: `${Math.min(100, pct)}%` }} />
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Print buttons */}
        <div className="px-3 py-2.5 border-t border-slate-100 space-y-1.5 bg-slate-50/50">
          <button type="button" onClick={() => selectedRow && printPdf([selectedRow])} disabled={!selectedRow}
            className="w-full flex items-center justify-center gap-2 text-xs font-bold bg-[#1e3a5f] hover:bg-[#162d4a] disabled:opacity-30 disabled:cursor-not-allowed text-white py-2.5 rounded-xl transition-colors shadow-sm">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
            PDF – Ausgewählte WO
          </button>
          <button type="button" onClick={() => printPdf(needle ? filteredRows : allRows)}
            className="w-full text-xs font-bold bg-white hover:bg-slate-100 text-slate-600 py-2 rounded-xl transition-colors border border-slate-200">
            PDF – Alle ({needle ? filteredRows.length : allRows.length}) WOs
          </button>
        </div>
      </aside>

      {/* ════════ RIGHT DETAIL ════════ */}
      <main className="flex-1 overflow-y-auto min-w-0 bg-slate-50/30">
        {!selectedRow ? (
          <EmptyDetailState />
        ) : (
          <PetDetail
            row={selectedRow}
            data={data}
            images={images[selectedRow.recipeCode] ?? []}
            onAddImage={(file) => addImage(selectedRow.recipeCode, file)}
            onRemoveImage={(idx) => removeImage(selectedRow.recipeCode, idx)}
            onPrint={() => printPdf([selectedRow])}
            imgInputRef={imgInputRef}
          />
        )}
      </main>
    </div>
  );
}

// ── Empty State ────────────────────────────────────────────────────────────

function EmptyDetailState() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-xs px-6">
        <div className="w-16 h-16 rounded-3xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 0v10m0-10a2 2 0 012 2h2a2 2 0 012-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/>
          </svg>
        </div>
        <p className="text-sm font-bold text-slate-600">Work Order wählen</p>
        <p className="text-xs text-slate-400 mt-1">Klicke links auf eine WO für Details</p>
      </div>
    </div>
  );
}

// ── Detail View ────────────────────────────────────────────────────────────

function PetDetail({
  row, data, images, onAddImage, onRemoveImage, onPrint, imgInputRef,
}: {
  row: PetRow;
  data: DataBundle;
  images: PlatingImage[];
  onAddImage: (f: File) => void;
  onRemoveImage: (idx: number) => void;
  onPrint: () => void;
  imgInputRef: React.RefObject<HTMLInputElement>;
}) {
  const recipe = data.recipes[row.recipeCode];
  const platingInstructions = getPlatingInstructions(recipe, row.market);
  const allergens = getAllergens(recipe, row.market);

  const mapped = row.mapped ?? 0;
  const target = row.target;
  const pct = target > 0 && mapped > 0 ? Math.round((mapped / target) * 100) : 0;

  const { date, shift } = parseShift(row.shiftKey);
  const d = new Date(date);
  const dateStr = isNaN(d.getTime())
    ? row.shiftKey
    : d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

  return (
    <div>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-gradient-to-r from-[#0f2240] via-[#1e3a5f] to-[#0f2240] px-6 py-4 shadow-lg">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap mb-0.5">
              <span className="text-2xl font-black text-white">WO {row.woNumber}</span>
              {row.recipeCode && <span className="font-mono text-xs text-blue-300">{row.recipeCode}</span>}
              {row.market && <span className="text-xs text-blue-400">{row.market}</span>}
            </div>
            <div className="text-sm font-bold text-blue-100 truncate">{row.recipeName}</div>
            <div className="text-xs text-blue-300/80 mt-0.5">{dateStr}{shift ? ` · Shift ${shift}` : ""}</div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onPrint}
              className="shrink-0 flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-colors border border-white/10">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
              PDF
            </button>
          </div>
        </div>
      </div>

      <div className="p-5 space-y-4">

        {/* Status */}
        <div className="bg-[#0f2240] rounded-2xl px-5 py-4">
          <div className="text-[8px] font-black uppercase tracking-[0.15em] text-blue-400 mb-2.5">Status</div>
          <div className="flex flex-wrap gap-2">
            {row.platingStatus && (() => {
              const ss = statusStyle(row.platingStatus);
              return (
                <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-xl ${ss.bg} ${ss.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${ss.dot}`}></span>
                  {row.platingStatus}
                </span>
              );
            })()}
            {row.manualStatus && (
              <span className="inline-flex items-center text-xs font-bold px-3 py-1.5 rounded-xl bg-white/10 text-blue-200">
                Manuell: {row.manualStatus}
              </span>
            )}
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {target > 0 && (
            <div className="rounded-2xl px-4 py-3.5 border bg-white border-slate-200 shadow-sm">
              <div className="text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 text-slate-400">Ziel-Portionen</div>
              <div className="text-xl font-black tabular-nums text-slate-900">{fmtNum(target)}</div>
            </div>
          )}
          <div className="rounded-2xl px-4 py-3.5 border bg-[#1e3a5f] border-[#1e3a5f]">
            <div className="text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 text-blue-300">Geplated</div>
            <div className="text-xl font-black tabular-nums text-white">{mapped > 0 ? fmtNum(mapped) : "—"}</div>
            {pct > 0 && <div className="text-[10px] text-blue-300 font-semibold mt-0.5">{pct}%</div>}
          </div>
          {row.minNeeds != null && (
            <div className="rounded-2xl px-4 py-3.5 border bg-white border-slate-200 shadow-sm">
              <div className="text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 text-slate-400">Min. Bedarf</div>
              <div className="text-xl font-black tabular-nums text-slate-900">{fmtNum(row.minNeeds)}</div>
            </div>
          )}
          {row.rolloverAmount != null && (
            <div className="rounded-2xl px-4 py-3.5 border bg-amber-50 border-amber-200">
              <div className="text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 text-amber-600">Rollover</div>
              <div className="text-xl font-black tabular-nums text-amber-800">{fmtNum(row.rolloverAmount)}</div>
            </div>
          )}
          {row.weekUnlocked != null && (
            <div className="rounded-2xl px-4 py-3.5 border bg-white border-slate-200 shadow-sm">
              <div className="text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 text-slate-400">Woche Unlocked</div>
              <div className="text-xl font-black tabular-nums text-slate-900">{fmtNum(row.weekUnlocked)}</div>
            </div>
          )}
          {row.weekMapped != null && (
            <div className="rounded-2xl px-4 py-3.5 border bg-white border-slate-200 shadow-sm">
              <div className="text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 text-slate-400">Woche Geplated</div>
              <div className="text-xl font-black tabular-nums text-slate-900">{fmtNum(row.weekMapped)}</div>
            </div>
          )}
        </div>

        {/* Progress */}
        {pct > 0 && (
          <div>
            <div className="flex justify-between text-[9px] font-bold text-slate-400 mb-1">
              <span>Fortschritt</span><span>{pct}%</span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-emerald-500" : "bg-blue-500"}`}
                style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </div>
        )}

        {/* Alerts */}
        <div className="space-y-2">
          {allergens && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800">
              <span className="mt-0.5 shrink-0">⚠</span>
              <span><strong>Allergene:</strong> {allergens}</span>
            </div>
          )}
          {row.expiringSubRecipe && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-2.5 text-xs text-red-800">
              <span className="mt-0.5 shrink-0">🕐</span>
              <span>
                <strong>Ablauf:</strong> {row.expiringSubRecipe}
                {row.expiringPortions && ` · ${fmtNum(parseFloat(row.expiringPortions))} Port.`}
                {row.expiringDatetime && ` · ${row.expiringDatetime}`}
                {row.expiringLp && ` · LP# ${row.expiringLp}`}
              </span>
            </div>
          )}
          {row.bestByDate && (
            <div className="flex items-start gap-2 bg-violet-50 border border-violet-200 rounded-xl px-4 py-2.5 text-xs text-violet-800">
              <span>📅</span>
              <span><strong>Best By:</strong> {row.bestByDate} {row.bestBySubRecipe && `· ${row.bestBySubRecipe}`}</span>
            </div>
          )}
          {row.comment && (
            <div className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-xs text-slate-600">
              <span>💬</span><span>{row.comment}</span>
            </div>
          )}
        </div>

        {/* Plating Instructions */}
        {platingInstructions.length > 0 ? (
          <div>
            <div className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400 mb-2">
              Plating Anweisungen · {row.recipeName}
            </div>
            <div className="space-y-2">
              {platingInstructions.map((b) => (
                <div key={b.id} className="rounded-2xl border border-blue-200 bg-blue-50/50 px-5 py-4">
                  <div className="text-xs font-bold text-blue-800 mb-1">{b.name}</div>
                  <div className="font-mono text-[9px] text-slate-400 mb-2">{b.id}</div>
                  <pre className="whitespace-pre-wrap text-xs leading-relaxed text-slate-700">{b.text}</pre>
                </div>
              ))}
            </div>
          </div>
        ) : (
          recipe ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-xs text-slate-500">
              <strong>Keine Plating-Anweisungen</strong> in App-Daten für {row.recipeCode} gefunden.
            </div>
          ) : (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-xs text-amber-700">
              ⚠ Rezept <strong>{row.recipeCode}</strong> nicht in App-Daten — Plating-Anweisungen nicht verfügbar.
            </div>
          )
        )}

        {/* Packing Pattern Images */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
              Packmuster {images.length > 0 ? `(${images.length})` : ""}
            </div>
            <div>
              <input
                ref={imgInputRef}
                type="file"
                accept="image/*"
                multiple
                title="Bild hochladen"
                aria-label="Packmuster-Bild hochladen"
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  files.forEach((f) => onAddImage(f));
                  e.target.value = "";
                }}
              />
              <button type="button"
                onClick={() => imgInputRef.current?.click()}
                className="flex items-center gap-1.5 text-[10px] font-bold bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M12 4v16m8-8H4"/></svg>
                Bild hinzufügen
              </button>
            </div>
          </div>
          {images.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {images.map((img, idx) => (
                <div key={idx} className="relative group rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-white">
                  <img src={img.dataUrl} alt="Packmuster" className="w-full h-36 object-contain p-2" />
                  <div className="px-3 py-2 bg-slate-50 border-t border-slate-100">
                    <div className="text-[9px] text-slate-500 truncate">{img.name}</div>
                  </div>
                  <button type="button" onClick={() => onRemoveImage(idx)}
                    className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div
              onClick={() => imgInputRef.current?.click()}
              className="cursor-pointer rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/50 px-6 py-8 text-center transition-all"
            >
              <div className="text-2xl mb-2">📸</div>
              <div className="text-xs font-semibold text-slate-500">Packmuster-Bild hochladen</div>
              <div className="text-[10px] text-slate-400 mt-1">Klicken oder Bild ablegen · jpg, png, webp</div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
