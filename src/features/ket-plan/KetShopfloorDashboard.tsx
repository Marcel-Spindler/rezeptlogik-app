// Shopfloor-Dashboards: Veggie Debox + Protein Debox — teilbar, mit allen
// relevanten Infos für den nächsten Tag (WOs, Equipment, Scoops, Racks,
// Wannen, Bleche), sortiert nach Allergen-Score (allergen-frei zuerst).
import { useMemo, useState } from "react";
import type { BatchCalc, KetRow, WoInstruction } from "./ketTypes";
import type { RunInfo } from "./ketRunLogic";
import { fmtKg, parseDateShift } from "./ketLogic";
import { allergenSortScore, computeFullResourceDemand } from "./ketEquipmentSummary";

type Department = "veggie" | "protein";

const DEPT_CONFIG: Record<Department, { label: string; method: string; color: string; bg: string; border: string }> = {
  veggie: { label: "Veggie Debox", method: "VEGGIE DEBOX", color: "text-green-700", bg: "bg-green-50", border: "border-green-200" },
  protein: { label: "Protein Debox", method: "PROTEIN DEBOX", color: "text-rose-700", bg: "bg-rose-50", border: "border-rose-200" },
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
}: {
  rows: KetRow[];
  calcMap: Map<string, BatchCalc>;
  runAssignments: Map<string, RunInfo>;
  instructionCache?: Map<string, WoInstruction>;
}) {
  const [dept, setDept] = useState<Department>("veggie");
  const cfg = DEPT_CONFIG[dept];

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
      return calc.resolvedCookMethods.includes(cfg.method);
    });
  }, [rows, calcMap, cfg.method, activeDay]);

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

  return (
    <div className="h-full flex flex-col bg-gradient-to-b from-slate-50 to-white">
      {/* Department Tabs */}
      <div className="shrink-0 px-4 pt-4 pb-2 flex items-center gap-3 flex-wrap">
        {(["veggie", "protein"] as const).map(d => (
          <button
            key={d}
            type="button"
            onClick={() => setDept(d)}
            className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${
              dept === d
                ? `${DEPT_CONFIG[d].bg} ${DEPT_CONFIG[d].color} ${DEPT_CONFIG[d].border} border shadow-sm scale-105`
                : "bg-white text-slate-400 border border-slate-200 hover:text-slate-600"
            }`}
          >
            {DEPT_CONFIG[d].label}
          </button>
        ))}

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
      </div>

      {/* WO List sorted by allergen score */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {deptWos.length === 0 ? (
          <div className="text-center text-slate-400 text-sm mt-12">
            Keine WOs mit {cfg.label} für diesen Tag.
          </div>
        ) : (
          <div className="space-y-2">
            {deptWos.map(({ row, calc, allergenScore }) => {
              const hasInstruction = instructionCache?.has(row.key) ?? false;
              const methods = calc.resolvedCookMethods.filter(m => m !== cfg.method && m !== "SPICE PORTIONING" && m !== "BLAST CHILLER");
              const gnTotal = calc.gnTraySummary.reduce((s, t) => s + t.trays, 0);

              return (
                <div
                  key={row.key}
                  className={`rounded-xl bg-white border shadow-sm overflow-hidden ${
                    allergenScore === 0 ? "border-slate-200" : "border-amber-200"
                  }`}
                  style={{ borderLeft: `4px solid ${allergenScore === 0 ? "#10B981" : allergenScore >= 8 ? "#EF4444" : "#F59E0B"}` }}
                >
                  <div className="px-4 py-3">
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
                          {m.split(" ").map(w => w[0] + w.slice(1).toLowerCase()).join(" ")}
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
