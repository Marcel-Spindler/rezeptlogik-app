// Backfills – app-weite Meldung. Bei frisch aufgetauchten Backfills: hartes
// rotes Flackern + Alarmton (abschaltbar). Sonst normales Banner + Stale-Warnung.
import { useEffect, useRef, useState } from "react";
import { useBackfillsOptional } from "./BackfillsContext";
import { isAlarmMuted, setAlarmMuted, playBackfillAlarm } from "./backfillAlarm";

export function BackfillNavBadge() {
  const backfills = useBackfillsOptional();
  if (!backfills) return null;
  const count = backfills.actionableAlertCount;
  const fresh = backfills.freshAlertCount > 0;
  if (count === 0 && !backfills.isStaleWeek) return null;
  return (
    <span className="relative flex h-2 w-2 shrink-0" role="status" aria-label={count > 0 ? `${count} Meal(s) brauchen einen Backfill` : "Backfills zeigt veraltete Daten"}>
      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${count > 0 ? "bg-red-400" : "bg-amber-400"}`} />
      <span className={`relative inline-flex rounded-full h-2 w-2 ${fresh ? "bg-red-600" : count > 0 ? "bg-red-500" : "bg-amber-500"}`} />
    </span>
  );
}

export function BackfillAlertBanner({ onOpen }: { onOpen: () => void }) {
  const backfills = useBackfillsOptional();
  const [dismissedKey, setDismissedKey] = useState("");
  const [muted, setMuted] = useState(isAlarmMuted);
  const lastSeqRef = useRef(0);

  const freshCount = backfills?.freshAlertCount ?? 0;
  const freshSeq = backfills?.freshAlertSeq ?? 0;

  // Alarmton bei jedem neuen frischen Alert (freshAlertSeq steigt).
  useEffect(() => {
    if (freshSeq > lastSeqRef.current) {
      lastSeqRef.current = freshSeq;
      if (freshSeq > 0 && !muted) playBackfillAlarm();
    }
  }, [freshSeq, muted]);

  if (!backfills) return null;

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

  const dismissKey = critical.map(a => `${a.recipeCode}|${a.severity}`).sort().join(",");
  if (dismissedKey === dismissKey) return null;

  const flashing = freshCount > 0 && !muted;
  const toggleMute = () => { const next = !muted; setMuted(next); setAlarmMuted(next); };

  return (
    <div className={`mb-4 rounded-xl p-3 ring-1 ${flashing ? "backfill-flash ring-red-500" : "bg-red-50 ring-red-300"}`}>
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onOpen} className="text-left flex-1">
          <div className={`text-xs font-bold uppercase tracking-wide ${flashing ? "backfill-flash-ink" : "text-red-800"}`}>
            {freshCount > 0 && "🚨 "}
            {critical.length === 1 ? "1 Meal braucht einen Backfill" : `${critical.length} Meals brauchen einen Backfill`}
            {freshCount > 0 && ` · ${freshCount} NEU`}
          </div>
          <div className={`mt-1 text-[11px] ${flashing ? "backfill-flash-ink" : "text-red-700"}`}>
            {critical.slice(0, 3).map(a => a.recipeName).join(" · ")}
            {critical.length > 3 ? ` +${critical.length - 3} weitere` : ""} — klicken für Details
          </div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={toggleMute}
            title={muted ? "Alarmton ist aus — einschalten" : "Alarmton aus"}
            aria-label={muted ? "Alarmton einschalten" : "Alarmton ausschalten"}
            className={`text-sm px-1 ${flashing ? "backfill-flash-ink" : "text-red-500 hover:text-red-800"}`}
          >
            {muted ? "🔇" : "🔔"}
          </button>
          <button
            type="button"
            onClick={() => setDismissedKey(dismissKey)}
            title="Bis zur nächsten Änderung ausblenden"
            aria-label="Backfill-Banner ausblenden"
            className={`text-xs font-semibold ${flashing ? "backfill-flash-ink" : "text-red-400 hover:text-red-800"}`}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
