import { useMemo, useState } from "react";
import type { DataBundle } from "../core/types";
import {
  computeWeekLoad,
  computeWeeklyStationLoads,
  loadStationDeviceCounts,
  type WeeklyStationLoad,
} from "../lib/equipment";
import { adjustedPortions, fmtNum } from "../lib/helpers";

const WARN_THRESHOLD = 80;   // %
const CRIT_THRESHOLD = 100;  // %
const GAUGE_MAX = 150;       // % — Nadel-Vollausschlag (Werte darüber bleiben am Anschlag)

interface Props {
  data: DataBundle;
  week: string;
  upliftPercent: number;
}

// Kurz-Labels für die Gauges (STATIONS sind teils englisch/technisch).
const STATION_LABELS: Partial<Record<string, string>> = {
  "Spice Portioning": "Spice Room",
  "Thaw": "Auftauen",
  "Oven": "Ofen",
};

const MODEL_NOTE: Record<WeeklyStationLoad["model"], string> = {
  "minutes": "Geräte-Minuten",
  "chiller-racks": "Rack-Durchsatz · 24 h",
  "thaw-room": "Kühlraum-kg",
};

function numColor(pct: number): string {
  if (pct >= CRIT_THRESHOLD) return "#dc2626";
  if (pct >= WARN_THRESHOLD) return "#d97706";
  return "#15803d";
}

// ── Tank-Anzeige (Auto-Benzinuhr) ──────────────────────────────────────────
// Halbkreis, E links (0 %) → F rechts (GAUGE_MAX). Dunkles Zifferblatt,
// Strich-Skala, rote Reservezone ab 100 %, kegelförmige Nadel.
const CX = 50, CY = 46, R = 38;

function polar(angleDeg: number, r: number): { x: number; y: number } {
  const a = (angleDeg * Math.PI) / 180;
  return { x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) };
}

// 0 % → 180° (links), GAUGE_MAX → 0° (rechts)
function angleForPct(pct: number): number {
  const clamped = Math.max(0, Math.min(pct, GAUGE_MAX));
  return 180 - (clamped / GAUGE_MAX) * 180;
}

const TICKS = Array.from({ length: 19 }, (_, i) => i / 18); // 0 … 1

function StationGauge({ load }: { load: WeeklyStationLoad }) {
  const pct = load.utilizationPct;
  const label = STATION_LABELS[load.label] ?? load.label;
  const warn = pct >= WARN_THRESHOLD;
  const tip = `${label} — ${MODEL_NOTE[load.model]}\n${load.basis}${load.extraDevicesNeeded > 0 ? `\n+${load.extraDevicesNeeded} Gerät/Platz nötig für ≤ 100 %` : ""}`;

  const a = (angleForPct(pct) * Math.PI) / 180;
  const px = CX, py = CY + 2;                     // Nadel-Drehpunkt
  const tip1 = { x: px + 34 * Math.cos(a), y: py - 34 * Math.sin(a) };
  const perp = { x: Math.sin(a), y: Math.cos(a) };
  const base = 2.4;

  return (
    <div className="flex w-[112px] shrink-0 flex-col items-center" title={tip}>
      <div className="w-full overflow-hidden rounded-lg bg-gradient-to-b from-[#2b2b2e] to-[#141416] px-1.5 pt-1.5 pb-1 ring-1 ring-black/40 shadow-sm">
        <svg viewBox="0 0 100 52" className="w-full" role="img" aria-label={`${label}: ${Math.round(pct)}% Auslastung`}>
          {TICKS.map((f, i) => {
            const ang = 180 - f * 180;
            const p = f * GAUGE_MAX;
            const long = i === 0 || i === TICKS.length - 1 || i === (TICKS.length - 1) / 2;
            const col = p >= CRIT_THRESHOLD ? "#ff453a" : p >= WARN_THRESHOLD ? "#ffd60a" : "#d1d1d6";
            const o = polar(ang, R);
            const inr = polar(ang, R - (long ? 8 : 5));
            return <line key={i} x1={o.x} y1={o.y} x2={inr.x} y2={inr.y} stroke={col} strokeWidth={long ? 1.8 : 1.1} strokeLinecap="round" />;
          })}
          <text x="6" y="49" fill="#8e8e93" fontSize="9" fontStyle="italic" fontWeight="700">E</text>
          <text x="94" y="49" fill="#8e8e93" fontSize="9" fontStyle="italic" fontWeight="700" textAnchor="end">F</text>
          {/* Nadel */}
          <polygon
            points={`${tip1.x.toFixed(1)},${tip1.y.toFixed(1)} ${(px + perp.x * base).toFixed(1)},${(py + perp.y * base).toFixed(1)} ${(px - perp.x * base).toFixed(1)},${(py - perp.y * base).toFixed(1)}`}
            fill={warn ? "#ff453a" : "#f2f2f7"}
          />
          <circle cx={px} cy={py} r={3.2} fill="#3a3a3c" stroke="#0a0a0a" strokeWidth={0.8} />
        </svg>
      </div>
      <div className="mt-1 text-[15px] font-black leading-none tabular-nums" style={{ color: numColor(pct) }}>
        {fmtNum(Math.round(pct))}%
      </div>
      <div className="text-center text-[11px] font-medium leading-tight text-slate-600">{label}</div>
      {load.extraDevicesNeeded > 0 && (
        <div className="text-[10px] font-semibold text-red-500">+{load.extraDevicesNeeded}</div>
      )}
    </div>
  );
}

function computeLoads(data: DataBundle, week: string, upliftPercent: number): WeeklyStationLoad[] {
  if (!data || !week) return [];
  const multiplier = adjustedPortions(1, upliftPercent);
  const weekLoad = computeWeekLoad(data, week, { portionMultiplier: multiplier });
  return computeWeeklyStationLoads(weekLoad, loadStationDeviceCounts());
}

export function CapacityWarningBanner({ data, week, upliftPercent }: Props) {
  const [dismissedKey, setDismissedKey] = useState<string>("");
  // Manuelles Auf-/Zuklappen; überschreibt den Default (offen, wenn Warnung).
  const [openOverride, setOpenOverride] = useState<{ key: string; open: boolean } | null>(null);

  const loads = useMemo(
    () => computeLoads(data, week, upliftPercent),
    [data, week, upliftPercent]
  );

  const key = `${week}-${upliftPercent}`;
  if (loads.length === 0 || dismissedKey === key) return null;

  const warn = loads.filter((l) => l.utilizationPct >= WARN_THRESHOLD);
  const hasCritical = loads.some((l) => l.utilizationPct >= CRIT_THRESHOLD);
  const open = openOverride?.key === key ? openOverride.open : warn.length > 0;

  const headTone = hasCritical
    ? { box: "bg-red-50 ring-red-300", text: "text-red-800" }
    : warn.length > 0
      ? { box: "bg-amber-50 ring-amber-300", text: "text-amber-800" }
      : { box: "bg-slate-50 ring-slate-200", text: "text-slate-600" };

  return (
    <div className={`mb-4 rounded-xl p-3 ring-1 ${headTone.box}`}>
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpenOverride({ key, open: !open })}
          className={`flex items-center gap-1 text-left text-xs font-bold uppercase tracking-wide ${headTone.text}`}
        >
          <span className="text-[10px] opacity-70">{open ? "▾" : "▸"}</span>
          {hasCritical ? "🔴" : warn.length > 0 ? "🟠" : "🟢"}{" "}
          {warn.length > 0
            ? `${warn.length} Station${warn.length > 1 ? "en" : ""} über ${WARN_THRESHOLD}% Wochen-Auslastung`
            : `Equipment-Auslastung alle < ${WARN_THRESHOLD}%`}{" "}
          — {week}
        </button>
        <button
          type="button"
          onClick={() => setDismissedKey(key)}
          className="shrink-0 text-xs font-semibold text-slate-400 hover:text-slate-800"
        >
          ✕ ausblenden
        </button>
      </div>

      {open && (
        <>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-2">
            {loads.map((load) => <StationGauge key={load.key} load={load} />)}
          </div>
          <div className="mt-1.5 text-[11px] text-slate-500">
            Fenster: 5 Produktionstage · Küche 2 Schichten, Blast Chiller 24 h · Rack 200 kg / 90 min · Auftauraum 8 t · Rechenbasis je Station im Tooltip
          </div>
        </>
      )}
    </div>
  );
}
