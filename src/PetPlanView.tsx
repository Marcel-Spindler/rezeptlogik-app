// PetPlanView.tsx – PET Plan → Plating / Portionierung → PDF
// Nimmt KitchenOS PET-CSV entgegen; flexibler Spalten-Parser.

import { useState, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";

// ── Types ──────────────────────────────────────────────────────────────────

interface PetRow {
  key: string;
  // Identifikation
  woNumber: string;
  recipeId: string;
  recipeCode: string;
  recipeName: string;
  // Zeitplanung
  dateNeeded: string;
  shift: string;
  // Portionen
  targetPortions: number;
  platedPortions: number | null;
  remainingPortions: number | null;
  portionsExcess: number | null;
  // Box / Verpackung
  boxType: string;
  boxCount: number | null;
  boxLabel: string;
  // Status
  platingStatus: string;
  kitchenStatus: string;
  packagingStatus: string;
  // Zutaten / Infos
  allergens: string;
  instructions: string;
  comment: string;
  lineStation: string;
  // Rohspalten für unbekannte Felder
  extra: Record<string, string>;
}

// ── CSV-Spalten-Mapping (flexibel) ─────────────────────────────────────────
// Jede Eigenschaft enthält mögliche Spaltenbezeichnungen (RegExp oder String)

const COL_MAP: Record<keyof Omit<PetRow, "key" | "recipeCode" | "shift" | "extra">, RegExp[]> = {
  woNumber:          [/work\s*order\s*(number|#|num)/i, /^wo\s*(number|#|num)/i, /^wo$/i],
  recipeId:          [/recipe\s*id/i, /^recipe_id$/i],
  recipeName:        [/recipe\s*name/i, /meal\s*name/i, /^recipe$/i],
  dateNeeded:        [/date\s*needed/i, /^date$/i, /plating\s*date/i, /pack.*date/i],
  targetPortions:    [/target\s*port/i, /planned\s*port/i, /portions\s*target/i, /qty\s*target/i],
  platedPortions:    [/plated\s*port/i, /packed\s*port/i, /done\s*port/i, /completed\s*port/i],
  remainingPortions: [/remaining\s*port/i, /open\s*port/i],
  portionsExcess:    [/excess/i, /surplus/i, /over.*port/i],
  boxType:           [/box\s*type/i, /pack.*type/i, /meal\s*kit\s*size/i, /serving\s*size/i, /^size$/i],
  boxCount:          [/box\s*count/i, /boxes/i, /carton/i, /unit\s*count/i, /^units$/i],
  boxLabel:          [/label/i, /sku\s*label/i, /pack.*label/i],
  platingStatus:     [/plating\s*status/i, /packing\s*status/i, /plate.*status/i],
  kitchenStatus:     [/kitchen\s*status/i],
  packagingStatus:   [/pack.*status/i, /packaging\s*status/i],
  allergens:         [/allergen/i, /allergy/i],
  instructions:      [/instruction/i, /notes/i, /^note$/i, /special.*note/i, /plating.*note/i],
  comment:           [/comment/i, /remark/i],
  lineStation:       [/line/i, /station/i, /plating\s*area/i],
};

function findCol(headers: string[], patterns: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].trim().toLowerCase();
    if (patterns.some((p) => p.test(h))) return i;
  }
  return -1;
}

function extractCode(name: string): string {
  return name.trim().match(/^([A-Z]{2}\d{4}[A-Z0-9]+)/)?.[1] ?? "";
}

function cleanName(name: string): string {
  return name
    .replace(/^[A-Z]{2}\d{4}[A-Z0-9]+\s*[-–]\s*/, "")
    .replace(/\s*\[(?:DE|BNL|DKSE|BENL|NORD)\]\s*$/i, "")
    .trim();
}

function parseDateShift(dateNeeded: string): { date: string; shift: string } {
  const m = dateNeeded.match(/^(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d+)/);
  if (m) return { date: m[1], shift: m[2] };
  // DD.MM.YYYY format
  const d = dateNeeded.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (d) return { date: `${d[3]}-${d[2].padStart(2,"0")}-${d[1].padStart(2,"0")}`, shift: "" };
  return { date: dateNeeded, shift: "" };
}

function parseSortKey(dateNeeded: string): number {
  const { date, shift } = parseDateShift(dateNeeded);
  return Date.parse(date) * 10 + parseInt(shift || "0");
}

function fmtDateHeader(dateNeeded: string): string {
  const { date, shift } = parseDateShift(dateNeeded);
  const d = new Date(date);
  if (isNaN(d.getTime())) return dateNeeded;
  const dayName = d.toLocaleDateString("de-DE", { weekday: "short" });
  const dateStr = d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  return shift ? `${dayName} ${dateStr} · Shift ${shift}` : `${dayName} ${dateStr}`;
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("de-DE");
}

// ── CSV Parser ─────────────────────────────────────────────────────────────

function parsePetCsv(text: string): PetRow[] {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const headers = result.meta.fields ?? [];

  // Build index per property
  const idx: Record<string, number> = {};
  for (const [prop, patterns] of Object.entries(COL_MAP)) {
    idx[prop] = findCol(headers, patterns);
  }

  function get(row: Record<string, string>, prop: string): string {
    const i = idx[prop];
    if (i < 0) return "";
    return (Object.values(row)[i] ?? "").trim();
  }

  function getNum(row: Record<string, string>, prop: string): number | null {
    const v = get(row, prop);
    if (!v) return null;
    const n = parseFloat(v.replace(",", "."));
    return isFinite(n) ? n : null;
  }

  return result.data
    .map((row, rowIdx) => {
      const recipeName = get(row, "recipeName");
      const recipeCode = extractCode(recipeName);
      const woNumber = get(row, "woNumber");
      const dateNeeded = get(row, "dateNeeded");
      const { shift } = parseDateShift(dateNeeded);

      // Collect extra columns not mapped
      const knownIndices = new Set(Object.values(idx).filter((i) => i >= 0));
      const extra: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (!knownIndices.has(i)) {
          const v = (Object.values(row)[i] ?? "").trim();
          if (v) extra[h] = v;
        }
      });

      return {
        key: `pet::${rowIdx}::${dateNeeded}::${woNumber}`,
        woNumber: woNumber || `Row-${rowIdx + 1}`,
        recipeId: get(row, "recipeId"),
        recipeCode,
        recipeName: cleanName(recipeName) || recipeName,
        dateNeeded,
        shift,
        targetPortions: getNum(row, "targetPortions") ?? 0,
        platedPortions: getNum(row, "platedPortions"),
        remainingPortions: getNum(row, "remainingPortions"),
        portionsExcess: getNum(row, "portionsExcess"),
        boxType: get(row, "boxType"),
        boxCount: getNum(row, "boxCount"),
        boxLabel: get(row, "boxLabel"),
        platingStatus: get(row, "platingStatus"),
        kitchenStatus: get(row, "kitchenStatus"),
        packagingStatus: get(row, "packagingStatus"),
        allergens: get(row, "allergens"),
        instructions: get(row, "instructions"),
        comment: get(row, "comment"),
        lineStation: get(row, "lineStation"),
        extra,
      } satisfies PetRow;
    })
    .filter((r) => r.woNumber);
}

// ── Status helpers ─────────────────────────────────────────────────────────

function statusColors(status: string): { bg: string; text: string; dot: string } {
  const s = status.toLowerCase();
  if (s.includes("complete") || s.includes("done") || s.includes("post blast") || s.includes("finished"))
    return { bg: "bg-emerald-100", text: "text-emerald-800", dot: "bg-emerald-500" };
  if (s.includes("in progress") || s.includes("running") || s.includes("plating"))
    return { bg: "bg-blue-100", text: "text-blue-800", dot: "bg-blue-500" };
  if (s.includes("staged") && !s.includes("partial"))
    return { bg: "bg-green-100", text: "text-green-800", dot: "bg-green-500" };
  if (s.includes("partial") || s.includes("pre blast"))
    return { bg: "bg-amber-100", text: "text-amber-800", dot: "bg-amber-500" };
  if (s.includes("not started") || s.includes("open"))
    return { bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400" };
  if (s.includes("hold") || s.includes("blocked"))
    return { bg: "bg-red-100", text: "text-red-800", dot: "bg-red-500" };
  return { bg: "bg-slate-100", text: "text-slate-500", dot: "bg-slate-300" };
}

// ── PDF Builder ────────────────────────────────────────────────────────────

function buildPetPdf(rows: PetRow[], title: string): string {
  const cards = rows.map((row, i) => {
    const { date, shift } = parseDateShift(row.dateNeeded);
    const d = new Date(date);
    const dateStr = isNaN(d.getTime())
      ? row.dateNeeded
      : d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

    const done = row.platedPortions ?? 0;
    const target = row.targetPortions;
    const remaining = row.remainingPortions ?? (target > 0 ? Math.max(0, target - done) : null);
    const donePct = target > 0 && done > 0 ? Math.round((done / target) * 100) : 0;

    const progressBar = donePct > 0
      ? `<div style="height:5px;background:#e5e7eb;border-radius:3px;margin-top:5px;overflow:hidden">
           <div style="height:100%;width:${Math.min(100,donePct)}%;background:${donePct>=100?"#10b981":"#3b82f6"};border-radius:3px"></div>
         </div>`
      : "";

    const statusBadge = (label: string, val: string) => {
      if (!val) return "";
      const col =
        val.toLowerCase().includes("complete") || val.toLowerCase().includes("done") || val.toLowerCase().includes("post blast") ? "#d1fae5;color:#065f46" :
        val.toLowerCase().includes("partial") || val.toLowerCase().includes("pre blast") ? "#fef3c7;color:#92400e" :
        val.toLowerCase().includes("progress") || val.toLowerCase().includes("plating") ? "#dbeafe;color:#1e40af" :
        "#f1f5f9;color:#475569";
      return `<span style="font-size:9px;font-weight:700;padding:3px 8px;border-radius:5px;background:${col}">${label}: ${val}</span>`;
    };

    const extraRows = Object.entries(row.extra)
      .filter(([, v]) => v)
      .map(([k, v]) => `<tr><td style="color:#6b7280;font-weight:600;white-space:nowrap;padding:3px 8px">${k}</td><td style="padding:3px 8px">${v}</td></tr>`)
      .join("");

    return `
<section style="padding:14px 16px;border:1.5px solid #e2e8f0;border-radius:10px;margin:8px;background:#fff;page-break-after:${i < rows.length-1?"always":"auto"}">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
    <div>
      <div style="font-size:28px;font-weight:900;color:#1e3a5f;line-height:1">WO ${row.woNumber}</div>
      <div style="font-size:10px;color:#6b7280;margin-top:3px">${dateStr}${shift ? ` · Shift ${shift}` : ""}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:10px;font-weight:700;color:#9ca3af;font-family:monospace">${row.recipeCode}</div>
      <div style="font-size:11px;font-weight:600;color:#374151;max-width:260px">${row.recipeName}</div>
    </div>
  </div>

  ${row.boxType || row.lineStation ? `
  <div style="background:linear-gradient(135deg,#0f2240,#1e3a5f);color:#fff;border-radius:7px;padding:9px 14px;font-size:12px;font-weight:700;letter-spacing:.04em;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">
    <span>${row.boxType || "Plating"}</span>
    ${row.lineStation ? `<span style="font-size:10px;font-weight:500;opacity:.8">${row.lineStation}</span>` : ""}
  </div>` : ""}

  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px">
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:7px 10px">
      <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:2px">Ziel-Portionen</div>
      <div style="font-size:19px;font-weight:900;color:#111">${target > 0 ? fmtNum(target) : "—"}</div>
    </div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:7px 10px">
      <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:2px">Geplated / Rest</div>
      <div style="font-size:19px;font-weight:900;color:#111">${done > 0 ? fmtNum(done) : "—"} ${remaining != null && remaining >= 0 ? `<span style="font-size:12px;color:#6b7280">/ ${fmtNum(remaining)}</span>` : ""}</div>
      ${donePct > 0 ? `<div style="font-size:9px;color:#059669;font-weight:700;margin-top:1px">${donePct}% fertig</div>` : ""}
      ${progressBar}
    </div>
    ${row.boxCount != null ? `
    <div style="background:#1e3a5f;border:1px solid #1e3a5f;border-radius:7px;padding:7px 10px">
      <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#93c5fd;margin-bottom:2px">BOXEN</div>
      <div style="font-size:36px;font-weight:900;color:#fff;line-height:1">${fmtNum(row.boxCount)}</div>
    </div>` : `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:7px 10px">
      <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:2px">Box-Typ</div>
      <div style="font-size:16px;font-weight:900;color:#111">${row.boxType || "—"}</div>
    </div>`}
    ${row.portionsExcess != null ? `
    <div style="background:${(row.portionsExcess??0)>=0?"#f0fdf4":"#fef2f2"};border:1px solid ${(row.portionsExcess??0)>=0?"#bbf7d0":"#fecaca"};border-radius:7px;padding:7px 10px">
      <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:${(row.portionsExcess??0)>=0?"#16a34a":"#dc2626"};margin-bottom:2px">Excess</div>
      <div style="font-size:19px;font-weight:900;color:${(row.portionsExcess??0)>=0?"#15803d":"#b91c1c"}">${(row.portionsExcess??0)>0?"+":""}${fmtNum(row.portionsExcess??0)}</div>
    </div>` : ""}
  </div>

  <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px">
    ${statusBadge("Plating", row.platingStatus)}
    ${statusBadge("Kitchen", row.kitchenStatus)}
    ${statusBadge("Packaging", row.packagingStatus)}
  </div>

  ${row.allergens ? `<div style="font-size:10px;padding:6px 10px;border-radius:6px;margin-bottom:5px;background:#fef3c7;color:#92400e;border-left:3px solid #fbbf24">⚠ <strong>Allergene:</strong> ${row.allergens}</div>` : ""}
  ${row.instructions ? `<div style="font-size:10px;padding:6px 10px;border-radius:6px;margin-bottom:5px;background:#eff6ff;color:#1e40af;border-left:3px solid #93c5fd">📋 <strong>Anweisungen:</strong> ${row.instructions}</div>` : ""}
  ${row.comment ? `<div style="font-size:10px;padding:6px 10px;border-radius:6px;margin-bottom:5px;background:#f1f5f9;color:#374151;border-left:3px solid #94a3b8">💬 ${row.comment}</div>` : ""}
  ${row.boxLabel ? `<div style="font-size:10px;padding:6px 10px;border-radius:6px;margin-bottom:5px;background:#f5f3ff;color:#5b21b6;border-left:3px solid #a78bfa">🏷 <strong>Label:</strong> ${row.boxLabel}</div>` : ""}

  ${extraRows ? `
  <table style="width:100%;border-collapse:collapse;font-size:10px;margin-top:8px;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
    <thead><tr style="background:#f1f5f9"><th style="padding:5px 8px;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;color:#475569;border-bottom:1px solid #e2e8f0" colspan="2">Weitere Felder</th></tr></thead>
    <tbody>${extraRows}</tbody>
  </table>` : ""}
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
@media print{
  body{font-size:10px}
  section{page-break-inside:avoid;margin:4px!important;border-width:1px!important;box-shadow:none!important}
  @page{size:A4;margin:8mm}
}
</style>
</head>
<body>
<div style="padding:14px 16px 8px;border-bottom:3px solid #1e3a5f;background:linear-gradient(135deg,#0f2240 0%,#1e3a5f 100%);color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact">
  <div style="font-size:20px;font-weight:900;letter-spacing:-.02em">🍽 ${title}</div>
  <div style="font-size:9px;color:#93c5fd;margin-top:3px">Generiert: ${new Date().toLocaleString("de-DE")} · ${rows.length} Work Orders</div>
</div>
${cards}
</body>
</html>`;
}

// ── Main Component ─────────────────────────────────────────────────────────

export function PetPlanView() {
  const [csvRows, setCsvRows] = useState<PetRow[] | null>(null);
  const [csvFileName, setCsvFileName] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [woSearch, setWoSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const groups = useMemo(() => {
    if (!csvRows) return [];
    const m = new Map<string, PetRow[]>();
    for (const row of csvRows) {
      if (!m.has(row.dateNeeded)) m.set(row.dateNeeded, []);
      m.get(row.dateNeeded)!.push(row);
    }
    return [...m.entries()].sort((a, b) => parseSortKey(a[0]) - parseSortKey(b[0]));
  }, [csvRows]);

  const needle = woSearch.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!needle) return groups;
    return groups
      .map(([k, rows]) => [k, rows.filter((r) =>
        [r.woNumber, r.recipeCode, r.recipeName, r.boxType, r.lineStation].join(" ").toLowerCase().includes(needle)
      )] as [string, PetRow[]])
      .filter(([, rows]) => rows.length > 0);
  }, [groups, needle]);

  const filteredRows = filteredGroups.flatMap(([, rows]) => rows);
  const selectedRow = csvRows?.find((r) => r.key === selectedKey) ?? null;

  function printPdf(rows: PetRow[]) {
    const title = `PET Plan – ${new Date().toLocaleDateString("de-DE")}`;
    const html = buildPetPdf(rows, title);
    const w = window.open("", "_blank", "width=960,height=750");
    if (!w) { alert("Popup blockiert – bitte für diese Seite erlauben."); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 450);
  }

  const totalBoxes = csvRows?.reduce((s, r) => s + (r.boxCount ?? 0), 0) ?? 0;
  const totalPortions = csvRows?.reduce((s, r) => s + r.targetPortions, 0) ?? 0;

  // ── Empty / Upload state ───────────────────────────────────────────────

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
            Lade deine PET-CSV (Plating Plan) hoch. Die Spalten werden automatisch erkannt.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            aria-label="PET CSV hochladen"
            title="PET CSV Datei hochladen"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
          <div
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            className={`cursor-pointer rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-all select-none ${
              dragOver ? "border-blue-400 bg-blue-50 scale-[1.02]" : "border-slate-300 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/50"
            }`}
          >
            <div className="text-sm font-bold text-slate-700 mb-1">PET CSV hochladen</div>
            <div className="text-xs text-slate-400">Klicken oder Datei hier ablegen · .csv</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-112px)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg">

      {/* ════════════════════════════════════════════════════
          LEFT SIDEBAR
      ════════════════════════════════════════════════════ */}
      <aside className="w-[280px] shrink-0 flex flex-col border-r border-slate-200 overflow-hidden">

        {/* Header */}
        <div className="px-4 pt-4 pb-3 bg-gradient-to-b from-[#0f2240] to-[#1e3a5f]">
          <div className="text-[9px] font-bold text-blue-300 uppercase tracking-[0.15em] mb-1">
            PET Plan · Plating Ausdruck
          </div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-2xl font-black text-white tabular-nums">{csvRows.length}</span>
            <span className="text-xs text-blue-300">WOs</span>
            {totalPortions > 0 && (
              <>
                <span className="text-blue-600">·</span>
                <span className="text-lg font-black text-blue-200 tabular-nums">{fmtNum(totalPortions)}</span>
                <span className="text-xs text-blue-300">Port.</span>
              </>
            )}
            {totalBoxes > 0 && (
              <>
                <span className="text-blue-600">·</span>
                <span className="text-lg font-black text-blue-200 tabular-nums">{fmtNum(totalBoxes)}</span>
                <span className="text-xs text-blue-300">Boxen</span>
              </>
            )}
          </div>
          <div className="text-[9px] text-blue-400 mt-1 font-mono truncate">✓ {csvFileName}</div>
        </div>

        {/* Replace / clear CSV */}
        <div className="px-3 py-2 border-b border-slate-100">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            title="Andere PET CSV hochladen"
            aria-label="Andere PET CSV hochladen"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full text-[10px] font-semibold text-slate-500 hover:text-blue-600 hover:bg-blue-50 py-1.5 rounded-lg transition-colors"
          >
            ↑ Andere CSV laden
          </button>
          <button
            type="button"
            onClick={() => { setCsvRows(null); setCsvFileName(""); setSelectedKey(null); }}
            className="w-full text-[9px] text-slate-400 hover:text-red-500 transition-colors py-0.5"
          >
            × CSV entfernen
          </button>
        </div>

        {/* Search */}
        <div className="px-3 py-2 border-b border-slate-100">
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path strokeLinecap="round" d="m21 21-4.35-4.35"/></svg>
            <input
              type="search"
              placeholder="WO, Rezept, Box …"
              value={woSearch}
              onChange={(e) => setWoSearch(e.target.value)}
              className="w-full pl-7 pr-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-400 focus:bg-white"
            />
          </div>
        </div>

        {/* WO List */}
        <div className="flex-1 overflow-y-auto py-1">
          {filteredGroups.length === 0 ? (
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
                    const isSelected = selectedKey === row.key;
                    const sc = statusColors(row.platingStatus || row.kitchenStatus);
                    const done = row.platedPortions ?? 0;
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
                          {row.boxType && (
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-md shrink-0 ${isSelected ? "bg-white/20 text-white" : "bg-blue-100 text-blue-700"}`}>
                              {row.boxType}
                            </span>
                          )}
                        </div>
                        <div className={`text-[10px] truncate leading-tight ${isSelected ? "text-blue-200" : "text-slate-600"}`}>
                          {row.recipeName}
                        </div>
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <span className={`text-[8px] font-semibold px-1.5 py-0.5 rounded-md ${sc.bg} ${sc.text}`}>
                            {row.platingStatus || row.kitchenStatus || "—"}
                          </span>
                          {pct > 0 && (
                            <div className={`flex-1 h-1 rounded-full overflow-hidden ${isSelected ? "bg-white/20" : "bg-slate-100"}`}>
                              <div
                                className={`h-full rounded-full ${pct >= 100 ? "bg-emerald-500" : "bg-blue-400"}`}
                                style={{ width: `${Math.min(100, pct)}%` }}
                              />
                            </div>
                          )}
                          {row.targetPortions > 0 && (
                            <span className={`text-[9px] tabular-nums ${isSelected ? "text-blue-300" : "text-slate-400"}`}>
                              {fmtNum(row.targetPortions)}
                            </span>
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
            onClick={() => printPdf(needle ? filteredRows : csvRows)}
            className="w-full text-xs font-bold bg-white hover:bg-slate-100 text-slate-600 py-2 rounded-xl transition-colors border border-slate-200"
          >
            PDF – Alle ({needle ? filteredRows.length : csvRows.length}) WOs
          </button>
        </div>
      </aside>

      {/* ════════════════════════════════════════════════════
          RIGHT DETAIL AREA
      ════════════════════════════════════════════════════ */}
      <main className="flex-1 overflow-y-auto min-w-0 bg-slate-50/30">
        {!selectedRow ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-xs px-6">
              <div className="w-16 h-16 rounded-3xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 0v10m0-10a2 2 0 012 2h2a2 2 0 012-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/>
                </svg>
              </div>
              <p className="text-sm font-bold text-slate-600">Work Order wählen</p>
              <p className="text-xs text-slate-400 mt-1">Klicke links auf eine Work Order für Details</p>
            </div>
          </div>
        ) : (
          <PetDetail row={selectedRow} onPrint={() => printPdf([selectedRow])} />
        )}
      </main>
    </div>
  );
}

// ── Detail View ────────────────────────────────────────────────────────────

function PetDetail({ row, onPrint }: { row: PetRow; onPrint: () => void }) {
  const { date, shift } = parseDateShift(row.dateNeeded);
  const d = new Date(date);
  const dateStr = isNaN(d.getTime())
    ? row.dateNeeded
    : d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

  const done = row.platedPortions ?? 0;
  const target = row.targetPortions;
  const remaining = row.remainingPortions ?? (target > 0 ? Math.max(0, target - done) : null);
  const donePct = target > 0 && done > 0 ? Math.round((done / target) * 100) : 0;

  const extraEntries = Object.entries(row.extra).filter(([, v]) => v);

  return (
    <div>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-gradient-to-r from-[#0f2240] via-[#1e3a5f] to-[#0f2240] px-6 py-4 shadow-lg">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap mb-0.5">
              <span className="text-2xl font-black text-white">WO {row.woNumber}</span>
              {row.recipeCode && <span className="font-mono text-xs text-blue-300">{row.recipeCode}</span>}
              <span className="text-xs text-blue-400">{dateStr}{shift ? ` · Shift ${shift}` : ""}</span>
            </div>
            <div className="text-sm font-bold text-blue-100 truncate">{row.recipeName}</div>
            {row.lineStation && <div className="text-xs text-blue-300/80 mt-0.5">{row.lineStation}</div>}
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

        {/* Box / Packaging */}
        {(row.boxType || row.lineStation) && (
          <div className="bg-[#0f2240] rounded-2xl px-5 py-4">
            <div className="text-[8px] font-black uppercase tracking-[0.15em] text-blue-400 mb-2.5">Plating Info</div>
            <div className="flex flex-wrap gap-2">
              {row.boxType && (
                <span className="inline-flex items-center text-xs font-bold px-3 py-1.5 rounded-xl bg-blue-500 text-white">
                  📦 {row.boxType}
                </span>
              )}
              {row.lineStation && (
                <span className="inline-flex items-center text-xs font-bold px-3 py-1.5 rounded-xl bg-white/10 text-blue-200">
                  🏭 {row.lineStation}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {target > 0 && (
            <div className="rounded-2xl px-4 py-3.5 border bg-white border-slate-200 shadow-sm">
              <div className="text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 text-slate-400">Ziel-Portionen</div>
              <div className="text-xl font-black tabular-nums text-slate-900">{fmtNum(target)}</div>
            </div>
          )}
          <div className="rounded-2xl px-4 py-3.5 border bg-white border-slate-200 shadow-sm">
            <div className="text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 text-slate-400">Geplated / Rest</div>
            <div className="text-xl font-black tabular-nums text-slate-900">
              {done > 0 ? fmtNum(done) : "—"}
              {remaining != null && remaining >= 0 && (
                <span className="text-sm font-semibold text-slate-400"> / {fmtNum(remaining)}</span>
              )}
            </div>
            {donePct > 0 && <div className="text-[10px] text-emerald-600 font-semibold mt-0.5">{donePct}% fertig</div>}
          </div>
          {row.boxCount != null && (
            <div className="rounded-2xl px-4 py-3.5 border bg-[#1e3a5f] border-[#1e3a5f]">
              <div className="text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 text-blue-300">BOXEN</div>
              <div className="text-xl font-black tabular-nums text-white">{fmtNum(row.boxCount)}</div>
            </div>
          )}
          {row.portionsExcess != null && (
            <div className={`rounded-2xl px-4 py-3.5 border ${(row.portionsExcess??0) >= 0 ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`}>
              <div className={`text-[8px] font-black uppercase tracking-[0.12em] mb-1.5 ${(row.portionsExcess??0) >= 0 ? "text-emerald-600" : "text-red-500"}`}>Excess</div>
              <div className={`text-xl font-black tabular-nums ${(row.portionsExcess??0) >= 0 ? "text-emerald-700" : "text-red-700"}`}>
                {(row.portionsExcess??0) > 0 ? "+" : ""}{fmtNum(row.portionsExcess??0)}
              </div>
            </div>
          )}
        </div>

        {/* Progress */}
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
          {[
            { label: "Plating", val: row.platingStatus },
            { label: "Kitchen", val: row.kitchenStatus },
            { label: "Packaging", val: row.packagingStatus },
          ].filter(({ val }) => val).map(({ label, val }) => {
            const { bg, text, dot } = statusColors(val);
            return (
              <div key={label} className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1.5 rounded-xl border ${bg} ${text} border-transparent`}>
                <span className={`w-1.5 h-1.5 rounded-full ${dot}`}></span>
                <span className="text-[9px] font-medium opacity-70">{label}:</span>
                {val}
              </div>
            );
          })}
        </div>

        {/* Comments / Info */}
        <div className="space-y-2">
          {row.allergens && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800">
              <span className="mt-0.5">⚠</span>
              <span><strong>Allergene:</strong> {row.allergens}</span>
            </div>
          )}
          {row.instructions && (
            <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 text-xs text-blue-800">
              <span>📋</span>
              <span><strong>Anweisungen:</strong> {row.instructions}</span>
            </div>
          )}
          {row.comment && (
            <div className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-xs text-slate-600">
              <span>💬</span>
              <span>{row.comment}</span>
            </div>
          )}
          {row.boxLabel && (
            <div className="flex items-start gap-2 bg-violet-50 border border-violet-200 rounded-xl px-4 py-2.5 text-xs text-violet-800">
              <span>🏷</span>
              <span><strong>Label:</strong> {row.boxLabel}</span>
            </div>
          )}
        </div>

        {/* Extra fields */}
        {extraEntries.length > 0 && (
          <div>
            <div className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400 mb-2">Weitere Felder</div>
            <div className="rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
              <table className="w-full text-xs">
                <tbody>
                  {extraEntries.map(([k, v]) => (
                    <tr key={k} className="border-b border-slate-50 last:border-0">
                      <td className="px-4 py-2 text-[10px] font-semibold text-slate-500 whitespace-nowrap w-1/3">{k}</td>
                      <td className="px-4 py-2 text-slate-800">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
