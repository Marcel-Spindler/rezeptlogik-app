// Share Dashboard – KPI-Kacheln und Quality-Issue-Liste (Übersichts-Tab).
import { DAYS } from "./shareDashboardTypes";
import type { KetWO, LinePlanRecipe, ScheduleMap } from "./shareDashboardTypes";
import { fmtNum, qualityTone } from "./shareDashboardLogic";
import type { QualityIssue } from "./shareDashboardLogic";

export function KpiView({
  ketWOs,
  ketOverrides,
  recipes,
  schedule,
  weekNum,
}: {
  ketWOs: KetWO[];
  ketOverrides: Record<string, { day?: string; status?: string }>;
  recipes: LinePlanRecipe[];
  schedule: ScheduleMap;
  weekNum: number;
}) {
  const totalWOs = ketWOs.length;
  const doneWOs = ketWOs.filter(wo => /done|fertig/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)).length;
  const progressWOs = ketWOs.filter(wo => /progress|aktiv/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)).length;
  const openWOs = Math.max(0, totalWOs - doneWOs - progressWOs);
  const totalPortions = ketWOs.reduce((s, wo) => s + wo.targetPortions, 0);

  const perDay = DAYS.map(day => {
    const count = ketWOs.filter(wo => (ketOverrides[wo.woNumber]?.day ?? wo.hotKitchenDay) === day).length;
    return { day, count };
  }).filter(x => x.count > 0);

  const topKetRecipes = Array.from(
    ketWOs.reduce((m, wo) => {
      const key = wo.recipeId || wo.recipeName || "Unbekannt";
      const cur = m.get(key) ?? { key, portions: 0, jobs: 0 };
      cur.portions += wo.targetPortions;
      cur.jobs += 1;
      m.set(key, cur);
      return m;
    }, new Map<string, { key: string; portions: number; jobs: number }>())
      .values()
  ).sort((a, b) => b.portions - a.portions).slice(0, 8);

  const slotsFilled = Object.values(schedule).filter(Boolean).length;
  const aslPlannedTotal = recipes.reduce((s, r) => s + r.totalPlanned, 0);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">KPI Übersicht · KW {weekNum}</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">KET WOs</div><div className="text-xl font-bold">{fmtNum(totalWOs)}</div></div>
          <div className="rounded-xl bg-emerald-50 p-3"><div className="text-xs text-emerald-700">Fertig</div><div className="text-xl font-bold text-emerald-800">{fmtNum(doneWOs)}</div></div>
          <div className="rounded-xl bg-amber-50 p-3"><div className="text-xs text-amber-700">In Arbeit</div><div className="text-xl font-bold text-amber-800">{fmtNum(progressWOs)}</div></div>
          <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Offen</div><div className="text-xl font-bold">{fmtNum(openWOs)}</div></div>
          <div className="rounded-xl bg-indigo-50 p-3"><div className="text-xs text-indigo-700">KET Portionen</div><div className="text-xl font-bold text-indigo-800">{fmtNum(totalPortions)}</div></div>
          <div className="rounded-xl bg-sky-50 p-3"><div className="text-xs text-sky-700">ASL Rezepte</div><div className="text-xl font-bold text-sky-800">{fmtNum(recipes.length)}</div></div>
          <div className="rounded-xl bg-violet-50 p-3"><div className="text-xs text-violet-700">ASL Planmenge</div><div className="text-xl font-bold text-violet-800">{fmtNum(aslPlannedTotal)}</div></div>
          <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">ASL Slots belegt</div><div className="text-xl font-bold">{fmtNum(slotsFilled)}</div></div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">KET Verteilung nach Tag</div>
          <div className="space-y-2">
            {perDay.length === 0 && <div className="text-sm text-slate-400">Keine Tagesdaten vorhanden.</div>}
            {perDay.map(row => (
              <div key={row.day} className="flex items-center gap-3">
                <div className="w-24 text-sm text-slate-600">{row.day}</div>
                <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-2 bg-indigo-500" style={{ width: `${(row.count / Math.max(1, totalWOs)) * 100}%` }} />
                </div>
                <div className="w-10 text-right text-sm font-semibold text-slate-700">{row.count}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Top Rezepte (KET nach Portionen)</div>
          <div className="space-y-2">
            {topKetRecipes.length === 0 && <div className="text-sm text-slate-400">Keine KET-Daten vorhanden.</div>}
            {topKetRecipes.map((r, i) => (
              <div key={r.key} className="flex items-center justify-between rounded-xl border border-slate-100 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs text-slate-400">#{i + 1}</div>
                  <div className="text-sm font-semibold text-slate-800 truncate">{r.key}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-indigo-700 tabular-nums">{fmtNum(r.portions)}</div>
                  <div className="text-[11px] text-slate-500">{r.jobs} WO</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function QualityView({
  issues,
  ketCount,
  aslCount,
}: {
  issues: QualityIssue[];
  ketCount: number;
  aslCount: number;
}) {
  const critical = issues.filter(i => i.severity === "critical").length;
  const warn = issues.filter(i => i.severity === "warn").length;
  const info = issues.filter(i => i.severity === "info").length;
  const scoreBase = Math.max(1, ketCount + aslCount);
  const score = Math.max(0, Math.round(100 - ((critical * 12 + warn * 5 + info * 1) / scoreBase) * 10));

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Datenqualität</div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-sm">
          <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Quality Score</div><div className="text-xl font-bold">{score}/100</div></div>
          <div className="rounded-xl bg-rose-50 p-3"><div className="text-xs text-rose-700">Critical</div><div className="text-xl font-bold text-rose-800">{critical}</div></div>
          <div className="rounded-xl bg-amber-50 p-3"><div className="text-xs text-amber-700">Warn</div><div className="text-xl font-bold text-amber-800">{warn}</div></div>
          <div className="rounded-xl bg-slate-50 p-3"><div className="text-xs text-slate-500">Info</div><div className="text-xl font-bold">{info}</div></div>
          <div className="rounded-xl bg-sky-50 p-3"><div className="text-xs text-sky-700">Datensätze</div><div className="text-xl font-bold text-sky-800">{ketCount + aslCount}</div></div>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Issues</div>
        <div className="space-y-2">
          {issues.length === 0 && <div className="text-sm text-emerald-700 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">Keine Datenqualitätsprobleme gefunden.</div>}
          {issues.map(issue => (
            <div key={issue.id} className={`rounded-xl border px-3 py-2 ${qualityTone(issue.severity)}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold text-sm">{issue.title}</div>
                <span className="text-[10px] uppercase tracking-wide">{issue.domain} · {issue.severity}</span>
              </div>
              <div className="text-xs mt-1 opacity-90">{issue.detail}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

