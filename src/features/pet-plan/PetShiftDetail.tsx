// PET Plan – Shift-Detailansicht: KPIs, Allergen-Übersicht, Linienplan/WO-Liste-Umschalter.
import { useMemo, useState } from "react";
import type { DataBundle } from "../../core/types";
import { ALLERGEN_DEFS, LINE_START_HOUR, PORTIONS_PER_HOUR } from "./petTypes";
import type { PetRow, PlatingImage, ViewMode, WoSortMode } from "./petTypes";
import { calcLineStaff, fmtClock, fmtNum, fmtShiftHeader, getMealAllergens, planLines } from "./petLogic";
import { KpiCard } from "./PetSharedUi";
import { LineColumn } from "./PetMealWidgets";
import { WoListView } from "./PetWoListView";

export function ShiftDetail({
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
