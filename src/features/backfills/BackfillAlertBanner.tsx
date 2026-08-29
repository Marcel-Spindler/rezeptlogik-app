// Backfills – app-weite Meldung + Stale-Data-Warnung.
import { useState } from "react";
import { useBackfillsOptional } from "./BackfillsContext";

export function BackfillNavBadge() {
  const backfills = useBackfillsOptional();
  if (!backfills) return null;
  const count = backfills.actionableAlertCount;
  if (count === 0 && !backfills.isStaleWeek) return null;
  return (
    <span className="relative flex h-2 w-2 shrink-0" title={count > 0 ? `${count} Meal(s) brauchen einen Backfill` : "Backfills zeigt veraltete Daten"}>
      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${count > 0 ? "bg-red-400" : "bg-amber-400"}`} />
      <span className={`relative inline-flex rounded-full h-2 w-2 ${count > 0 ? "bg-red-500" : "bg-amber-500"}`} />
    </span>
  );
}

export function BackfillAlertBanner({ onOpen }: { onOpen: () => void }) {
  const backfills = useBackfillsOptional();
  const [dismissedKey, setDismissedKey] = useState("");

  if (!backfills) return null;

  // Stale-Warnung hat niedrigere Prio als handlungsrelevante Alerts
  // (critical + warning) — v.a. die "Backfill nötig"-Meldungen aus dem
  // Redzone-Rückstand.
  const critical = backfills.alerts.filter(a => a.severity === "critical" || a.severity === "warning");

  if (critical.length === 0 && !backfills.isStaleWeek) return null;

  // Stale-only Banner (kein handlungsrelevanter Alert, aber alte Daten)
  if (critical.length === 0 && backfills.isStaleWeek) {
    const staleKey = `stale_${backfills.selectedWeekNum}`;
    if (dismissedKey === staleKey) return null;
    return (
      <div className="mb-4 rounded-xl p-3 ring-1 bg-amber-50 ring-amber-300">
        <div className="flex items-start justify-between gap-2">
          <button type="button" onClick={onOpen} className="text-left flex-1">
            <div className="text-xs font-bold text-amber-800">
              ⚠ Backfills zeigt KW {backfills.selectedWeekNum} — neuer Plan noch nicht importiert
            </div>
          </button>
          <button type="button" onClick={() => setDismissedKey(staleKey)} className="text-xs font-semibold shrink-0 text-amber-400 hover:text-amber-800">
            ✕
          </button>
        </div>
      </div>
    );
  }

  // Handlungsrelevante Alerts
  const dismissKey = critical.map(a => a.recipeCode).sort().join(",");
  if (dismissedKey === dismissKey) return null;

  return (
    <div className="mb-4 rounded-xl p-3 ring-1 bg-red-50 ring-red-300">
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onOpen} className="text-left flex-1">
          <div className="text-xs font-bold uppercase tracking-wide text-red-800">
            {critical.length === 1 ? "1 Meal braucht einen Backfill" : `${critical.length} Meals brauchen einen Backfill`}
          </div>
          <div className="mt-1 text-[11px] text-red-700">
            {critical.slice(0, 3).map(a => a.recipeName).join(" · ")}
            {critical.length > 3 ? ` +${critical.length - 3} weitere` : ""} — klicken für Details
          </div>
        </button>
        <button type="button" onClick={() => setDismissedKey(dismissKey)} className="text-xs font-semibold shrink-0 text-red-400 hover:text-red-800">
          ✕
        </button>
      </div>
    </div>
  );
}
