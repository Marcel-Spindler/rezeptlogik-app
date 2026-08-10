// Share Dashboard – KET/Küchenplanung Kanban: einzelne WO-Karte + Tages-Spalten-Ansicht.
import { useMemo, useState } from "react";
import { DAYS } from "./shareDashboardTypes";
import type { KetWO } from "./shareDashboardTypes";
import { fmtNum, nameShort, pillStyle, recipeHue, statusStyle } from "./shareDashboardLogic";

// ══════════════════════════════════════════════════════════════════════════════
//  KET / KITCHEN  — Card
// ══════════════════════════════════════════════════════════════════════════════

export function KitchenCard({
  wo,
  effectiveStatus,
}: {
  wo: KetWO;
  effectiveStatus: string;
}) {
  const code = wo.recipeId.match(/FV\d+[A-Z]/)?.[0] ?? "";
  const h = code ? recipeHue(code) : 210;

  return (
    <div
      className="rounded-xl border bg-white p-2.5 shadow-sm"
      style={{
        borderColor:      `hsl(${h},38%,82%)`,
        borderLeftColor:  `hsl(${h},52%,52%)`,
        borderLeftWidth:  3,
      }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-1.5 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <div
            className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
            style={{ background: `hsl(${h},55%,88%)`, color: `hsl(${h},52%,22%)` }}
          >
            {wo.priority}
          </div>
          <span className="font-semibold text-xs text-slate-800 leading-tight line-clamp-2">
            {wo.subRecipeName || wo.recipeName}
          </span>
        </div>
        <span
          className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border"
          style={statusStyle(effectiveStatus)}
        >
          {effectiveStatus.length > 12 ? effectiveStatus.substring(0, 10) + "…" : effectiveStatus}
        </span>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap gap-2 items-center mb-1">
        {code && (
          <span className="text-[10px] font-bold" style={{ color: `hsl(${h},52%,32%)` }}>{code}</span>
        )}
        {wo.woNumber && (
          <span className="text-[10px] font-mono text-slate-400">{wo.woNumber}</span>
        )}
        {wo.woReady && (
          <span className="ml-auto text-[9px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-1 rounded">
            ✓ WO
          </span>
        )}
        {wo.targetPortions > 0 && (
          <span className="text-[10px] font-bold tabular-nums text-slate-500 shrink-0">
            {fmtNum(wo.targetPortions)}
          </span>
        )}
      </div>

      {/* Cook methods */}
      {wo.cookMethods.length > 0 && (
        <div className="flex flex-wrap gap-0.5 mb-1.5">
          {wo.cookMethods.slice(0, 3).map(m => (
            <span key={m} className="px-1 py-0.5 rounded text-[9px] font-medium bg-slate-100 text-slate-600">{m}</span>
          ))}
          {wo.cookMethods.length > 3 && (
            <span className="text-[9px] text-slate-400">+{wo.cookMethods.length - 3}</span>
          )}
        </div>
      )}

      {/* Allergens */}
      {wo.allergens.length > 0 && (
        <div className="flex flex-wrap gap-0.5 mb-1">
          {wo.allergens.slice(0, 2).map(a => (
            <span key={a} className="px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-amber-50 text-amber-700 border border-amber-100">
              ⚠ {a.substring(0, 12)}
            </span>
          ))}
          {wo.allergens.length > 2 && (
            <span className="text-[9px] text-slate-400">+{wo.allergens.length - 2}</span>
          )}
        </div>
      )}

      {/* Comment */}
      {wo.comments && (
        <div className="mt-1 text-[10px] text-slate-400 italic border-t border-slate-50 pt-1 leading-tight">
          {wo.comments}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  KET / KITCHEN  — View  (Kanban, filterbar)
// ══════════════════════════════════════════════════════════════════════════════

export function KitchenView({
  ketWOs,
  ketOverrides,
  weekNum,
}: {
  ketWOs: KetWO[];
  ketOverrides: Record<string, { day?: string; status?: string }>;
  weekNum: number;
}) {
  const [search, setSearch]     = useState("");
  const [statusF, setStatusF]   = useState<"all" | "open" | "done">("all");
  const [activeDay, setActiveDay] = useState<string>("all");

  const recipeLegend = useMemo(() => {
    const m = new Map<string, { code: string; name: string; count: number }>();
    for (const wo of ketWOs) {
      const code = wo.recipeId.match(/FV\d+[A-Z]/)?.[0] ?? "";
      if (!code) continue;
      if (!m.has(code)) m.set(code, { code, name: wo.recipeName, count: 0 });
      m.get(code)!.count++;
    }
    return Array.from(m.values());
  }, [ketWOs]);

  const allDays = useMemo(() => {
    const days: string[] = [];
    for (const d of DAYS) {
      const has = ketWOs.some(wo => {
        const day = ketOverrides[wo.woNumber]?.day ?? wo.hotKitchenDay;
        return day === d;
      });
      if (has) days.push(d);
    }
    return days;
  }, [ketWOs, ketOverrides]);

  const columns = useMemo(() => {
    let wos = ketWOs;
    if (search) {
      const q = search.toLowerCase();
      wos = wos.filter(wo =>
        wo.recipeName.toLowerCase().includes(q) ||
        wo.subRecipeName.toLowerCase().includes(q) ||
        wo.woNumber.toLowerCase().includes(q)
      );
    }
    if (statusF === "open") wos = wos.filter(wo =>
      !/done|fertig/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)
    );
    if (statusF === "done") wos = wos.filter(wo =>
      /done|fertig/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)
    );

    const map: Record<string, KetWO[]> = {};
    for (const wo of wos) {
      const day = ketOverrides[wo.woNumber]?.day ?? wo.hotKitchenDay;
      const key = day || "__unassigned__";
      if (!map[key]) map[key] = [];
      map[key].push(wo);
    }

    const cols: Array<{ day: string; label: string; wos: KetWO[] }> = [];
    if ((map["__unassigned__"] ?? []).length > 0)
      cols.push({ day: "__unassigned__", label: "Nicht geplant", wos: map["__unassigned__"] ?? [] });
    for (const d of DAYS) cols.push({ day: d, label: d, wos: map[d] ?? [] });

    if (activeDay !== "all")
      return cols.filter(c => c.day === activeDay || c.day === "__unassigned__");
    return cols;
  }, [ketWOs, ketOverrides, search, statusF, activeDay]);

  const totalWOs      = ketWOs.length;
  const doneWOs       = ketWOs.filter(wo => /done|fertig/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)).length;
  const progressWOs   = ketWOs.filter(wo => /progress|aktiv/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)).length;
  const totalPortions = ketWOs.reduce((s, wo) => s + wo.targetPortions, 0);

  return (
    <div className="flex gap-4 items-start">

      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      <aside className="w-48 shrink-0 space-y-3">

        {/* KW Stats Card */}
        <div
          className="rounded-2xl p-4 text-white"
          style={{ background: "linear-gradient(135deg,#312e81,#4338ca)" }}
        >
          <div className="text-[10px] font-bold uppercase tracking-widest opacity-60 mb-1">Küchenplanung</div>
          <div className="text-3xl font-black leading-none">KW {weekNum}</div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="bg-white/10 rounded-xl p-2">
              <div className="text-xs font-bold tabular-nums">{fmtNum(totalWOs)}</div>
              <div className="text-[9px] opacity-60 uppercase tracking-wide">Aufträge</div>
            </div>
            <div className="bg-white/10 rounded-xl p-2">
              <div className="text-xs font-bold tabular-nums">{fmtNum(totalPortions)}</div>
              <div className="text-[9px] opacity-60 uppercase tracking-wide">Portionen</div>
            </div>
          </div>
          <div className="mt-3">
            <div className="flex justify-between text-[10px] opacity-70 mb-1">
              <span>{doneWOs} fertig</span>
              <span>{Math.round((doneWOs / Math.max(totalWOs, 1)) * 100)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/20">
              <div
                className="h-1.5 rounded-full bg-emerald-400 transition-all"
                style={{ width: `${(doneWOs / Math.max(totalWOs, 1)) * 100}%` }}
              />
            </div>
            {progressWOs > 0 && (
              <div className="text-[9px] mt-1 opacity-60">{progressWOs} in Arbeit</div>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Suche</div>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Rezept, WO-Nr …"
            className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>

        {/* Status filter */}
        <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Status</div>
          <div className="flex flex-col gap-1">
            {([ ["all","Alle"], ["open","Offen"], ["done","Fertig"] ] as const).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setStatusF(k)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-xl text-left transition-all ${
                  statusF === k
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-500 hover:bg-slate-50"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Day filter */}
        {allDays.length > 1 && (
          <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Tag</div>
            <div className="flex flex-col gap-1">
              <button
                onClick={() => setActiveDay("all")}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-xl text-left transition-all ${
                  activeDay === "all"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-500 hover:bg-slate-50"
                }`}
              >
                Alle Tage
              </button>
              {allDays.map(d => (
                <button
                  key={d}
                  onClick={() => setActiveDay(d === activeDay ? "all" : d)}
                  className={`px-2.5 py-1.5 text-xs font-semibold rounded-xl text-left transition-all ${
                    activeDay === d
                      ? "bg-indigo-600 text-white shadow-sm"
                      : "text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {d.substring(0, 2)}.
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Recipe legend */}
        {recipeLegend.length > 0 && (
          <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Rezepte</div>
            <div className="space-y-1.5">
              {recipeLegend.map(({ code, name, count }) => (
                <div key={code} style={pillStyle(code)} className="rounded-xl border px-2 py-1.5">
                  <div className="text-xs font-bold">{code}</div>
                  <div className="text-[10px] opacity-70 truncate">{nameShort(name, 20)}</div>
                  <div className="text-[9px] opacity-50 tabular-nums">{count} Sub-Rezepte</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* ── Kanban board ────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-x-auto pb-2">
        <div
          className="flex gap-3"
          style={{ minWidth: `${columns.length * 212}px` }}
        >
          {columns.map(({ day, label, wos }) => {
            const totalP = wos.reduce((s, wo) => s + wo.targetPortions, 0);
            const done   = wos.filter(wo =>
              /done|fertig/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)
            ).length;

            return (
              <div key={day} className="w-52 shrink-0">
                {/* Column header */}
                <div className="rounded-t-2xl border border-b-0 border-slate-100 bg-white px-3 py-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-bold text-sm text-slate-700">{label}</div>
                      {totalP > 0 && (
                        <div className="text-[10px] text-slate-400 tabular-nums mt-0.5">
                          ∑ {fmtNum(totalP)}
                        </div>
                      )}
                    </div>
                    <span className={`text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full ${
                      wos.length > 0 ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-400"
                    }`}>
                      {wos.length}
                    </span>
                  </div>
                  {wos.length > 0 && (
                    <div className="mt-2 h-1 rounded-full bg-slate-100">
                      <div
                        className="h-1 rounded-full bg-emerald-400 transition-all"
                        style={{ width: `${(done / wos.length) * 100}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Cards */}
                <div className="border border-t-0 border-slate-100 rounded-b-2xl bg-slate-50/50 p-2 space-y-2 min-h-28">
                  {wos.map(wo => (
                    <KitchenCard
                      key={`${wo.woNumber}-${wo.subRecipeName}`}
                      wo={wo}
                      effectiveStatus={ketOverrides[wo.woNumber]?.status ?? wo.status}
                    />
                  ))}
                  {wos.length === 0 && (
                    <div className="flex items-center justify-center h-12 text-xs text-slate-200">
                      Leer
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {columns.every(c => c.wos.length === 0) && (
            <div className="flex-1 rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-slate-400">
              {search ? "Keine Treffer für diese Suche." : "Keine KET-Daten vorhanden."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

