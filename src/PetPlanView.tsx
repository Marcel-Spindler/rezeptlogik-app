// PetPlanView.tsx – PET Plaiting Linienplan
// CSV laden → allergen-bewusste Linienzuweisung → variable Kapazität/h → Submeals+1 MA → Anweisungen → PDF

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type { DataBundle } from "./core/types";
import { PORTIONS_PER_HOUR } from "./features/pet-plan/petTypes";
import type { PetRow, PlatingImage } from "./features/pet-plan/petTypes";
import {
  calcLineStaff, fmtNum, fmtShiftHeader, fmtShiftShort, getMealAllergens, loadImages, parsePetCsv, planLines,
  saveImages, shiftSortKey,
} from "./features/pet-plan/petLogic";
import { buildLinePlanPdf } from "./features/pet-plan/petPdf";
import { EmptyState } from "./features/pet-plan/PetSharedUi";
import { ShiftDetail } from "./features/pet-plan/PetShiftDetail";

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
