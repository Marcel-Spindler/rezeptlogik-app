// Erinnerung an Marcels Blast-Chiller-Routine: Mo–Do lädt er um ~14 Uhr den
// KET-Plan neu und erstellt das Handout für morgen. Der Banner erscheint an
// diesen Tagen ab 14 Uhr, ist pro Tag wegklickbar (localStorage).
import { useEffect, useState } from "react";

const DISMISS_KEY = "rezeptlogik-blast-chiller-reminder-dismissed";
const REMIND_HOUR = 14;
const REMIND_WEEKDAYS = new Set([1, 2, 3, 4]); // Mo–Do

function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function shouldShow(now: Date): boolean {
  if (!REMIND_WEEKDAYS.has(now.getDay())) return false;
  if (now.getHours() < REMIND_HOUR) return false;
  try {
    return window.localStorage.getItem(DISMISS_KEY) !== todayKey(now);
  } catch {
    return true;
  }
}

export function BlastChillerReminderBanner({ onOpen }: { onOpen: () => void }) {
  const [visible, setVisible] = useState(() => shouldShow(new Date()));

  // Falls die App vor 14 Uhr offen war: minütlich nachsehen.
  useEffect(() => {
    if (visible) return;
    const t = setInterval(() => { if (shouldShow(new Date())) setVisible(true); }, 60_000);
    return () => clearInterval(t);
  }, [visible]);

  if (!visible) return null;

  const dismiss = () => {
    try { window.localStorage.setItem(DISMISS_KEY, todayKey()); } catch { /* ignore */ }
    setVisible(false);
  };

  return (
    <div className="mb-3 rounded-lg border border-sky-300 bg-sky-50 px-4 py-2.5 flex items-center gap-3 text-sm text-sky-900">
      <span className="text-base" aria-hidden>⏰</span>
      <div className="flex-1">
        <span className="font-semibold">14 Uhr — Blast Chiller aktualisieren.</span>{" "}
        KET-Plan neu einlesen und das Handout für morgen erstellen.
      </div>
      <button
        onClick={onOpen}
        className="shrink-0 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700"
      >
        Zum Blast Chiller Bot
      </button>
      <button
        onClick={dismiss}
        className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-sky-700 hover:bg-sky-100"
        aria-label="Erinnerung für heute ausblenden"
      >
        ✕
      </button>
    </div>
  );
}
