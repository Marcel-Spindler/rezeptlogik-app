// Kleine, wiederverwendete Anzeige-Bausteine im Cockpit-Planer.
import type { UiLocale } from "../../../lib/i18n";
import { tl } from "../../../lib/i18n";

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

export function RampUpSparkline({ values, width = 50, height = 14 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = pad + ((max - v) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const last = values[values.length - 1];
  const first = values[0];
  const stroke = last > first ? "#10b981" : last < first ? "#f43f5e" : "#94a3b8";
  const lastPt = pts.split(" ").pop()!.split(",");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "inline-block", verticalAlign: "middle" }}>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
      <circle cx={lastPt[0]} cy={lastPt[1]} r="2" fill={stroke} />
    </svg>
  );
}

export function RampUpDeltaBadge({ delta }: { delta: number }) {
  if (delta === 0) return null;
  const up = delta > 0;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      fontSize: "9px", fontWeight: 700,
      padding: "0 4px", borderRadius: "9999px",
      background: up ? "#ecfdf5" : "#fff1f2",
      color: up ? "#059669" : "#e11d48",
      border: `1px solid ${up ? "#a7f3d0" : "#fecdd3"}`,
    }}>
      {up ? "+" : ""}{fmtNum(delta)}
    </span>
  );
}

export function PlannerStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg px-2 py-1 ${accent ? "bg-verden-50 ring-1 ring-verden-500" : "bg-slate-50"}`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

export function ToggleChip({ label, enabled, onClick, locale }: { label: string; enabled: boolean; onClick: () => void; locale: UiLocale }) {
  return (
    <button
      className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm ring-1 ${enabled ? "bg-verden-50 text-verden-800 ring-verden-200" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-100"}`}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${enabled ? "bg-verden-600 text-white" : "bg-slate-200 text-slate-600"}`}>
        {enabled ? tl(locale, "an") : tl(locale, "aus")}
      </span>
    </button>
  );
}
