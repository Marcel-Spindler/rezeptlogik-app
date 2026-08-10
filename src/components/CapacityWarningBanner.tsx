import { useMemo, useState } from "react";
import type { DataBundle } from "../core/types";
import { STATIONS } from "../core/types";
import {
  computeWeekLoad,
  getStationCapacityView,
  loadStationDeviceCounts,
  DEFAULT_SHIFT_MIN,
} from "../lib/equipment";
import { adjustedPortions, fmtNum } from "../lib/helpers";

interface CapacityIssue {
  station: string;
  utilizationPct: number;
  requiredDevices: number;
  deviceCount: number;
}

const WARN_THRESHOLD = 80;   // %
const CRIT_THRESHOLD = 100;  // %

interface Props {
  data: DataBundle;
  week: string;
  upliftPercent: number;
}

function computeCapacityIssues(data: DataBundle, week: string, upliftPercent: number): CapacityIssue[] {
  if (!data || !week) return [];
  const multiplier = adjustedPortions(1, upliftPercent);
  const weekLoad = computeWeekLoad(data, week, { portionMultiplier: multiplier });
  const deviceCounts = loadStationDeviceCounts();

  const issues: CapacityIssue[] = [];
  for (const station of STATIONS) {
    const totalMin = weekLoad.perStationMin[station] ?? 0;
    if (totalMin === 0) continue;
    const deviceCount = deviceCounts[station] ?? 1;
    const view = getStationCapacityView(totalMin, deviceCount, DEFAULT_SHIFT_MIN);
    if (view.utilizationPct >= WARN_THRESHOLD) {
      issues.push({ station, utilizationPct: view.utilizationPct, requiredDevices: view.requiredDevices, deviceCount });
    }
  }
  return issues.sort((a, b) => b.utilizationPct - a.utilizationPct);
}

function StationBadge({ issue }: { issue: CapacityIssue }) {
  const isCrit = issue.utilizationPct >= CRIT_THRESHOLD;
  const missing = issue.requiredDevices - issue.deviceCount;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-semibold ring-1 ${
        isCrit ? "bg-red-100 text-red-800 ring-red-300" : "bg-orange-100 text-orange-800 ring-orange-300"
      }`}
      title={`Benötigt ${issue.requiredDevices} Geräte, verfügbar: ${issue.deviceCount}`}
    >
      {issue.station}
      <span className="font-bold">{fmtNum(Math.round(issue.utilizationPct))}%</span>
      {missing > 0 && <span className="opacity-75">({missing} fehlen)</span>}
    </span>
  );
}

export function CapacityWarningBanner({ data, week, upliftPercent }: Props) {
  const [dismissedKey, setDismissedKey] = useState<string>("");

  const issues = useMemo(
    () => computeCapacityIssues(data, week, upliftPercent),
    [data, week, upliftPercent]
  );

  const dismissKey = `${week}-${upliftPercent}`;
  if (issues.length === 0 || dismissedKey === dismissKey) return null;

  const hasCritical = issues.some(i => i.utilizationPct >= CRIT_THRESHOLD);

  return (
    <div className={`mb-4 rounded-xl p-3 ring-1 ${hasCritical ? "bg-red-50 ring-red-300" : "bg-orange-50 ring-orange-300"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className={`text-xs font-bold uppercase tracking-wide ${hasCritical ? "text-red-800" : "text-orange-800"}`}>
          {hasCritical ? "🔴" : "🟠"} {issues.length} Station{issues.length > 1 ? "en" : ""} über {WARN_THRESHOLD}% Auslastung — {week}
        </div>
        <button
          type="button"
          onClick={() => setDismissedKey(dismissKey)}
          className={`text-xs font-semibold shrink-0 ${hasCritical ? "text-red-400 hover:text-red-800" : "text-orange-400 hover:text-orange-800"}`}
        >
          ✕ ausblenden
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {issues.map(issue => <StationBadge key={issue.station} issue={issue} />)}
      </div>
      <div className={`mt-1.5 text-[11px] ${hasCritical ? "text-red-700" : "text-orange-700"}`}>
        Breakdown-Rechner öffnen für Details · Geräteanzahl in den Stationseinstellungen anpassen
      </div>
    </div>
  );
}
