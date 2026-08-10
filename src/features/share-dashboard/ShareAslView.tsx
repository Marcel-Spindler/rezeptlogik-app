// Share Dashboard – ASL-Linienplan-Ansicht (informativ, nur lesbar).
import { useMemo } from "react";
import { DAYS, LINES, SLOTS } from "./shareDashboardTypes";
import type { LinePlanRecipe, ScheduleMap } from "./shareDashboardTypes";
import { fmtNum, nameShort, portionsInSlot, recipeHue } from "./shareDashboardLogic";

// ══════════════════════════════════════════════════════════════════════════════
//  ASL VIEW  (Linienplan — informativ, read-only)
// ══════════════════════════════════════════════════════════════════════════════

export function AslView({
  schedule,
  recipes,
  weekNum,
}: {
  schedule: ScheduleMap;
  recipes: LinePlanRecipe[];
  weekNum: number;
}) {
  const slotsFilled = Object.values(schedule).filter(Boolean).length;

  const scheduledPortions = useMemo(() => {
    const map = new Map<string, number>();
    for (const [key, r] of Object.entries(schedule)) {
      if (!r) continue;
      const slotKey = key.split("|")[1] ?? "";
      map.set(r.code, (map.get(r.code) ?? 0) + portionsInSlot(r, slotKey));
    }
    return map;
  }, [schedule]);

  if (slotsFilled === 0) return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center">
      <div className="text-4xl mb-3">📋</div>
      <div className="text-slate-500 font-medium">Kein ASL-Plan gespeichert für KW {weekNum}.</div>
      <div className="text-slate-400 text-sm mt-1">Der Plan wird sichtbar sobald der Planer ihn speichert.</div>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Info banner */}
      <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 flex items-center gap-3">
        <span className="text-lg">ℹ️</span>
        <div>
          <div className="text-sm font-semibold text-indigo-800">ASL-Linienplanung · KW {weekNum}</div>
          <div className="text-xs text-indigo-600 mt-0.5">
            Informative Ansicht. Den Plan pflegt der Planer in der internen App — er dient zur Erstellung der Rackfile.
          </div>
        </div>
      </div>

      {/* Volume balance */}
      {recipes.length > 0 && (
        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Volumen-Balance</div>
          <div className="grid gap-2">
            {recipes.map(r => {
              const scheduled = scheduledPortions.get(r.code) ?? 0;
              const pct = r.totalPlanned > 0 ? Math.min((scheduled / r.totalPlanned) * 100, 100) : 0;
              const h   = recipeHue(r.code);
              return (
                <div key={r.code}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ background: `hsl(${h},52%,52%)` }} />
                      <span className="font-mono text-slate-500 text-[10px]">{r.code}</span>
                      <span className="font-medium text-slate-700 truncate max-w-[10rem]">{nameShort(r.name, 18)}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-[10px] tabular-nums">
                      <span className="font-bold" style={{ color: `hsl(${h},52%,32%)` }}>{fmtNum(scheduled)}</span>
                      <span className="text-slate-300">/</span>
                      <span className="text-slate-400">{fmtNum(r.totalPlanned)}</span>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100">
                    <div
                      className="h-1.5 rounded-full transition-all"
                      style={{ width: `${pct}%`, background: `hsl(${h},52%,52%)` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Schedule grid */}
      <div className="rounded-2xl border border-slate-100 bg-white shadow-sm overflow-hidden">
        <div
          className="px-4 py-2.5 border-b border-slate-50 bg-slate-50/50 hidden sm:grid gap-2"
          style={{ gridTemplateColumns: "5rem 6.5rem repeat(3, 1fr) 5rem" }}
        >
          <div className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Tag</div>
          <div className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Zeit</div>
          {LINES.map(l => <div key={l} className="text-xs font-semibold text-slate-500 text-center">{l}</div>)}
          <div className="text-[10px] font-bold text-slate-300 uppercase tracking-wider text-right">Meals/h</div>
        </div>

        {DAYS.map(day => {
          const hasSomething = SLOTS.some(s =>
            LINES.some((_, li) => schedule[`${day}|${s.key}|${li}`])
          );
          if (!hasSomething) return null;
          return (
            <div key={day}>
              <div className="px-4 py-2 bg-gradient-to-r from-slate-50 to-white border-y border-slate-50">
                <span className="font-bold text-sm text-slate-700">{day}</span>
              </div>
              {SLOTS.map(slot => {
                const cells = LINES.map((_, li) => schedule[`${day}|${slot.key}|${li}`] ?? null);
                if (cells.every(c => !c)) return null;
                let totalP = 0;
                for (const r of cells) if (r) totalP += portionsInSlot(r, slot.key);
                const mh = slot.duration > 0 ? Math.round((totalP / slot.duration) * 60) : 0;

                return (
                  <div key={slot.key} className="px-4 py-2 border-b border-slate-50 last:border-0">
                    {/* Desktop */}
                    <div
                      className="hidden sm:grid gap-2 items-center"
                      style={{ gridTemplateColumns: "5rem 6.5rem repeat(3, 1fr) 5rem" }}
                    >
                      <div className="text-[10px] text-slate-300">{slot.duration < 60 ? `${slot.duration} min` : ""}</div>
                      <div className="text-xs font-mono text-slate-500 font-semibold">{slot.label}</div>
                      {cells.map((r, li) => {
                        if (!r) return <div key={li} className="h-7 rounded-lg border border-dashed border-slate-100" />;
                        const h = recipeHue(r.code);
                        return (
                          <div
                            key={li}
                            className="rounded-lg px-2 py-1.5 flex items-center gap-1.5 text-xs font-semibold"
                            style={{
                              background:       `hsl(${h},62%,90%)`,
                              borderLeft:       `3px solid hsl(${h},52%,52%)`,
                              color:            `hsl(${h},52%,22%)`,
                            }}
                          >
                            <span className="font-mono opacity-60 text-[10px] shrink-0">{r.code}</span>
                            <span className="truncate">{nameShort(r.name, 12)}</span>
                            <span className="ml-auto opacity-50 tabular-nums text-[10px] shrink-0">
                              {fmtNum(portionsInSlot(r, slot.key))}
                            </span>
                          </div>
                        );
                      })}
                      <div className={`text-right text-xs font-bold tabular-nums ${mh > 3000 ? "text-emerald-600" : "text-slate-400"}`}>
                        {mh > 0 ? fmtNum(mh) : "—"}
                      </div>
                    </div>

                    {/* Mobile */}
                    <div className="sm:hidden space-y-1">
                      <div className="text-[10px] text-slate-400 font-mono font-semibold">{slot.label}</div>
                      {cells.map((r, li) => {
                        if (!r) return null;
                        const h = recipeHue(r.code);
                        return (
                          <div
                            key={li}
                            className="rounded-lg px-2.5 py-1.5 flex items-center gap-2 text-xs font-semibold"
                            style={{
                              background:  `hsl(${h},62%,90%)`,
                              borderLeft:  `3px solid hsl(${h},52%,52%)`,
                              color:       `hsl(${h},52%,22%)`,
                            }}
                          >
                            <span className="font-mono opacity-60 text-[10px] shrink-0">{r.code}</span>
                            <span className="truncate">{nameShort(r.name, 22)}</span>
                            <span className="text-[9px] shrink-0 ml-auto">{LINES[li]}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROOT COMPONENT
// ══════════════════════════════════════════════════════════════════════════════

