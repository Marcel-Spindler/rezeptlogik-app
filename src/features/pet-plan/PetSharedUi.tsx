// PET Plan – kleine wiederverwendete Bausteine: Leerzustand, KPI-Kachel.

export function EmptyState() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-xs px-6">
        <div className="w-16 h-16 rounded-3xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 0v10m0-10a2 2 0 012 2h2a2 2 0 012-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/>
          </svg>
        </div>
        <p className="text-sm font-bold text-slate-600">Shift wählen</p>
        <p className="text-xs text-slate-400 mt-1">Klicke links auf einen Shift für den Linienplan</p>
      </div>
    </div>
  );
}

// ── KPI Card ───────────────────────────────────────────────────────────────

export function KpiCard({ label, value, sub, accent }: {
  label: string;
  value: string;
  sub?: string;
  accent: "blue" | "green" | "amber" | "red";
}) {
  const colors = {
    blue: "bg-[#1e3a5f] border-[#1e3a5f]",
    green: "bg-white border-emerald-200",
    amber: "bg-amber-50 border-amber-200",
    red: "bg-red-50 border-red-200",
  };
  const valueColors = {
    blue: "text-white",
    green: "text-emerald-800",
    amber: "text-amber-800",
    red: "text-red-800",
  };
  const subColors = {
    blue: "text-blue-300",
    green: "text-emerald-600",
    amber: "text-amber-600",
    red: "text-red-600",
  };
  const labelColors = {
    blue: "text-blue-400",
    green: "text-slate-400",
    amber: "text-amber-600",
    red: "text-red-600",
  };
  return (
    <div className={`rounded-2xl px-4 py-3.5 border ${colors[accent]}`}>
      <div className={`text-[8px] font-black uppercase tracking-[.12em] mb-1.5 ${labelColors[accent]}`}>{label}</div>
      <div className={`text-xl font-black tabular-nums ${valueColors[accent]}`}>{value}</div>
      {sub && <div className={`text-[9px] mt-0.5 ${subColors[accent]}`}>{sub}</div>}
    </div>
  );
}
