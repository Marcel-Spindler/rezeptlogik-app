// Backfill-Wächter – akustischer Alarm für frisch aufgetauchte Backfills.
// Web-Audio-Ton, kein Asset. Autoplay-Policy: der erste Ton kann stumm bleiben,
// bis der Nutzer die Seite einmal angeklickt hat — das visuelle Flackern greift
// immer.

const MUTE_KEY = "backfill-alarm-muted";

export function isAlarmMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
}

export function setAlarmMuted(muted: boolean): void {
  try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* ignore */ }
}

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = ctx ?? new AC();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch { return null; }
}

/** Drei kurze, harte Pieptöne (~1 s gesamt). */
export function playBackfillAlarm(): void {
  if (isAlarmMuted()) return;
  const ac = audioCtx();
  if (!ac) return;
  const now = ac.currentTime;
  for (let i = 0; i < 3; i++) {
    const t = now + i * 0.28;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(i === 2 ? 1320 : 988, t); // letzter Ton höher
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  }
}
