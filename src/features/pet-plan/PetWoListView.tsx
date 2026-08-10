// PET Plan – sortierbare WO-Listenansicht (Alternative zur Linienplan-Ansicht).
import { useMemo } from "react";
import type { Recipe } from "../../core/types";
import { LINE_COLORS, LINE_COLORS_BG } from "./petTypes";
import type { PetRow, WoSortMode } from "./petTypes";
import { fmtNum, getMealAllergens, getPlatingInstructions, getSubmealCount, parseSteps, statusColors } from "./petLogic";

export function WoListView({
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
