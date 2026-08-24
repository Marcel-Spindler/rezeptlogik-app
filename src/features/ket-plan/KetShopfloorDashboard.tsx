// Shopfloor-Dashboards: Veggie Debox + Protein Debox — teilbar, mit allen
// relevanten Infos für den nächsten Tag (WOs, Equipment, Scoops, Racks,
// Wannen, Bleche), sortiert nach Allergen-Score (allergen-frei zuerst).
import { useMemo, useState } from "react";
import type { BatchCalc, KetRow, WoInstruction } from "./ketTypes";
import type { RunInfo } from "./ketRunLogic";
import { classifyDeboxDepartment, fmtKg, parseDateShift } from "./ketLogic";
import { allergenSortScore, computeFullResourceDemand } from "./ketEquipmentSummary";
import type { ShopfloorProgress } from "./useShopfloorProgress";
import { buildShopfloorShareUrl } from "../../lib/helpers";
import { titleCaseCookMethod } from "./KetSharedUi";

type Department = "veggie" | "protein";

const DEPT_CONFIG: Record<Department, { label: string; color: string; bg: string; border: string }> = {
  veggie: { label: "Veggie Debox", color: "text-green-700", bg: "bg-green-50", border: "border-green-200" },
  protein: { label: "Protein Debox", color: "text-rose-700", bg: "bg-rose-50", border: "border-rose-200" },
};

interface DeptWo {
  row: KetRow;
  calc: BatchCalc;
  allergenScore: number;
}

export function KetShopfloorDashboard({
  rows,
  calcMap,
  runAssignments,
  instructionCache,
  lockedDept,
  progress,
  onToggleDone,
  syncError,
  kiosk,
}: {
  rows: KetRow[];
  calcMap: Map<string, BatchCalc>;
  runAssignments: Map<string, RunInfo>;
  instructionCache?: Map<string, WoInstruction>;
  // Kiosk-Laptops sind physisch einer Küche zugeordnet (Veggie ODER Protein) —
  // mit lockedDept gesetzt wird die Department-Umschaltung ausgeblendet.
  lockedDept?: Department;
  progress?: ShopfloorProgress;
  onToggleDone?: (woNumber: string, dept: Department, done: boolean) => void;
  syncError?: string | null;
  // Größere Touch-Ziele, kein Detail-Drumherum — für den Kiosk-Vollbild-Modus.
  kiosk?: boolean;
}) {
  const [dept, setDept] = useState<Department>(lockedDept ?? "veggie");
  const cfg = DEPT_CONFIG[lockedDept ?? dept];
  const activeDept = lockedDept ?? dept;
  const [copiedLink, setCopiedLink] = useState<Department | null>(null);
  const copyDeptLink = (d: Department) => {
    navigator.clipboard.writeText(buildShopfloorShareUrl(d)).then(() => {
      setCopiedLink(d);
      setTimeout(() => setCopiedLink((cur) => (cur === d ? null : cur)), 2000);
    });
  };

  // Available dates
  const availableDays = useMemo(() => {
    const days = new Set<string>();
    for (const row of rows) days.add(parseDateShift(row.dateNeeded).date);
    return [...days].sort();
  }, [rows]);

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const activeDay = selectedDay ?? availableDays[0] ?? null;

  // Rows dieses Departments (+ Tag), nur solche mit erfolgreicher Berechnung
  const deptRows = useMemo(() => {
    return rows.filter(row => {
      if (activeDay && parseDateShift(row.dateNeeded).date !== activeDay) return false;
      const calc = calcMap.get(row.key);
      if (!calc) return false;
      return classifyDeboxDepartment(calc) === activeDept;
    });
  }, [rows, calcMap, activeDept, activeDay]);

  // WOs sortiert nach Allergen-Score (allergenfrei zuerst)
  const deptWos = useMemo(() => {
    const list: DeptWo[] = deptRows.map(row => {
      const calc = calcMap.get(row.key)!;
      return { row, calc, allergenScore: allergenSortScore(calc.allergensContains) };
    });
    list.sort((a, b) => a.allergenScore - b.allergenScore);
    return list;
  }, [deptRows, calcMap]);

  // Ressourcen-Bedarf über dieselbe Pipeline wie das Equipment-Panel, damit
  // Bleche/Wannen/Racks/Scoops nicht separat (und potenziell abweichend)
  // berechnet werden.
  const summary = useMemo(
    () => computeFullResourceDemand(deptRows, calcMap, runAssignments),
    [deptRows, calcMap, runAssignments],
  );

  const stats = useMemo(() => ({
    totalKg: summary.totalKgWeek,
    totalBleche: summary.totalGnTraysWeek,
    totalWannen: summary.totalWannenWeek,
    racks: summary.totalRacksNeededWeek,
    scoops: summary.scoopInventory,
  }), [summary]);

  const doneCount = useMemo(
    () => deptWos.filter(({ row }) => progress?.[row.woNumber]?.done).length,
    [deptWos, progress],
  );

  return (
    <div className={`h-full flex flex-col bg-gradient-to-b from-slate-50 to-white ${kiosk ? "text-[1.05rem]" : ""}`}>
      {/* Department Tabs */}
      <div className="shrink-0 px-4 pt-4 pb-2 flex items-center gap-3 flex-wrap">
        {!lockedDept && (["veggie", "protein"] as const).map(d => (
          <div key={d} className="flex items-stretch">
            <button
              type="button"
              onClick={() => setDept(d)}
              className={`px-4 py-2 rounded-l-xl text-xs font-black transition-all ${
                dept === d
                  ? `${DEPT_CONFIG[d].bg} ${DEPT_CONFIG[d].color} ${DEPT_CONFIG[d].border} border shadow-sm`
                  : "bg-white text-slate-400 border border-slate-200 hover:text-slate-600"
              }`}
            >
              {DEPT_CONFIG[d].label}
            </button>
            <button
              type="button"
              onClick={() => copyDeptLink(d)}
              title={`Kiosk-Link für ${DEPT_CONFIG[d].label} kopieren (für den Shopfloor-Laptop)`}
              className={`px-2 rounded-r-xl text-xs border border-l-0 transition-all ${
                dept === d
                  ? `${DEPT_CONFIG[d].bg} ${DEPT_CONFIG[d].color} ${DEPT_CONFIG[d].border}`
                  : "bg-white text-slate-300 border-slate-200 hover:text-slate-500"
              }`}
            >
              {copiedLink === d ? "✓" : "🔗"}
            </button>
          </div>
        ))}
        {lockedDept && (
          <span className={`px-4 py-2 rounded-xl text-xs font-black ${cfg.bg} ${cfg.color} ${cfg.border} border`}>
            {cfg.label}
          </span>
        )}

        {/* Day selector */}
        <div className="ml-auto flex items-center gap-1.5">
          {availableDays.map(day => (
            <button
              key={day}
              type="button"
              onClick={() => setSelectedDay(day)}
              className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all ${
                day === activeDay
                  ? "bg-[#1e3a5f] text-white shadow-md"
                  : "bg-white text-slate-500 border border-slate-200 hover:border-blue-300"
              }`}
            >
              {day.slice(5).replace("-", ".")}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Bar */}
      <div className="shrink-0 px-4 pb-3">
        <div className={`rounded-xl px-4 py-3 border ${cfg.bg} ${cfg.border}`}>
          <div className="flex items-center gap-5 text-[11px] flex-wrap">
            {onToggleDone && (
              <span className={`font-black ${doneCount === deptWos.length && deptWos.length > 0 ? "text-emerald-600" : cfg.color}`}>
                {doneCount} / {deptWos.length} erledigt
              </span>
            )}
            <span className={`font-black ${cfg.color}`}>{deptWos.length} WOs</span>
            <span className="font-bold text-slate-600">{stats.totalKg.toFixed(0)} kg</span>
            <span className="text-slate-500">{stats.totalBleche} Bleche</span>
            <span className="text-slate-500">{stats.totalWannen} Wannen</span>
            <span className="font-bold text-indigo-600">{stats.racks} Racks</span>
            {stats.scoops.length > 0 && (
              <span className="text-purple-600 font-bold">
                Scoops: {stats.scoops.map(s => `${s.methodType}${s.methodColor ? ` ${s.methodColor}` : ""} (×${s.count})`).join(", ")}
              </span>
            )}
          </div>
        </div>
        {syncError && (
          <div className="mt-2 rounded-lg px-3 py-2 text-[11px] font-bold bg-red-50 text-red-700 border border-red-200">
            ⚠ {syncError}
          </div>
        )}
      </div>

      {/* WO List sorted by allergen score */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {deptWos.length === 0 ? (
          <div className="text-center text-slate-400 text-sm mt-12">
            Keine WOs mit {cfg.label} für diesen Tag.
          </div>
        ) : (
          <div className="space-y-2">
            {deptWos.map(({ row, calc, allergenScore }, idx) => {
              const hasInstruction = instructionCache?.has(row.key) ?? false;
              const methods = calc.resolvedCookMethods.filter(m => m !== "VEGGIE DEBOX" && m !== "PROTEIN DEBOX" && m !== "SPICE PORTIONING" && m !== "BLAST CHILLER");
              const gnTotal = calc.gnTraySummary.reduce((s, t) => s + t.trays, 0);
              const isDone = progress?.[row.woNumber]?.done ?? false;

              return (
                <div
                  key={row.key}
                  className={`rounded-xl bg-white border shadow-sm overflow-hidden flex transition-opacity ${
                    isDone ? "opacity-50" : allergenScore === 0 ? "border-slate-200" : "border-amber-200"
                  }`}
                  style={{ borderLeft: `4px solid ${isDone ? "#94A3B8" : allergenScore === 0 ? "#10B981" : allergenScore >= 8 ? "#EF4444" : "#F59E0B"}` }}
                >
                  {/* Reihenfolge-Nummer */}
                  <div className={`shrink-0 w-12 flex items-center justify-center font-black text-2xl ${
                    isDone ? "text-slate-300" : allergenScore === 0 ? "text-emerald-600" : allergenScore >= 8 ? "text-red-600" : "text-amber-600"
                  }`}>
                    {idx + 1}
                  </div>
                  <div className="px-4 py-3 flex-1 min-w-0">
                    {/* Header */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-black text-[#1e3a5f]">WO {row.woNumber}</span>
                          {hasInstruction && (
                            <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">Anweisung</span>
                          )}
                          {allergenScore === 0 && (
                            <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">Allergen-frei</span>
                          )}
                        </div>
                        <div className="text-xs font-bold text-slate-800 leading-tight mt-0.5">{row.recipeName}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5">{row.subRecipeName || "—"}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 text-[10px]">
                        {calc.batches > 0 && (
                          <span className="font-black px-1.5 py-0.5 rounded-md bg-blue-100 text-blue-700">{calc.batches}×</span>
                        )}
                        <span className="text-slate-400 tabular-nums">{fmtKg(calc.totalKg)}</span>
                      </div>
                    </div>

                    {/* Equipment + GN */}
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                      {methods.map(m => (
                        <span key={m} className="text-[8px] font-semibold px-1 py-0.5 rounded bg-slate-100 text-slate-500">
                          {titleCaseCookMethod(m)}
                        </span>
                      ))}
                      {gnTotal > 0 && (
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">{gnTotal} Bleche</span>
                      )}
                      {calc.scoopInfo?.methodType && (
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                          Scoop {calc.scoopInfo.methodColor ?? calc.scoopInfo.methodType}
                        </span>
                      )}
                    </div>

                    {/* Allergene */}
                    {calc.allergensContains.length > 0 && (
                      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                        <span className="text-[8px] font-black text-red-600">CONTAINS:</span>
                        {calc.allergensContains.map(a => (
                          <span key={a} className="text-[7px] font-bold px-1 py-0.5 rounded bg-red-50 text-red-600 border border-red-200">
                            {a.split(" / ")[0]}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {onToggleDone && (
                    <button
                      type="button"
                      onClick={() => onToggleDone(row.woNumber, activeDept, !isDone)}
                      title={isDone ? "Als offen markieren" : "Als erledigt markieren"}
                      className={`shrink-0 w-16 flex items-center justify-center transition-colors ${
                        isDone ? "bg-emerald-500 text-white" : "bg-slate-50 text-slate-300 hover:bg-emerald-50 hover:text-emerald-500"
                      }`}
                    >
                      <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
