// Geteiltes Flacker-Signal für den Backfill-Wächter.
//
// Damit ein frisch aufgetauchter Backfill bei ALLEN offenen Apps gleichzeitig
// flackert — egal wann sie geöffnet wurden oder ob der Nutzer WMS-/Snowflake-
// Zugang hat (der Backfill kommt rein aus dem Google-Sheet):
//   • wessen App ihn zuerst lokal erkennt, schreibt `flash` nach Firestore
//     (apps/rezeptlogik/backfillWatch/state)
//   • die Cloud Function `rtiBackfillWatch` schreibt dasselbe alle 10 min
//   • alle Apps lesen es per onSnapshot und flackern mit
import { useCallback, useEffect, useRef, useState } from "react";
import { getFirebase, doc, onSnapshot, setDoc } from "../../core/firebase";

type DocRef = ReturnType<typeof doc>;

const FRESH_MS = 15 * 60 * 1000;

interface SharedFlash { at: number; keys: string[] }

export interface SharedBackfillFlash {
  /** true = irgendwo wurde in den letzten 15 min ein neuer Backfill gemeldet. */
  active: boolean;
  /** Zeitstempel des letzten geteilten Signals (0 = nie). */
  at: number;
  /** Alert-Keys des letzten geteilten Signals. */
  keys: string[];
  broadcast: (keys: string[]) => void;
}

export function useSharedBackfillFlash(): SharedBackfillFlash {
  const [remote, setRemote] = useState<SharedFlash | null>(null);
  const refRef = useRef<DocRef | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    let unsub = () => {};
    try {
      const { db } = getFirebase();
      const ref = doc(db, "apps", "rezeptlogik", "backfillWatch", "state");
      refRef.current = ref;
      unsub = onSnapshot(
        ref,
        snap => {
          const f = (snap.data() as { flash?: { at?: unknown; keys?: unknown } } | undefined)?.flash;
          if (f && typeof f.at === "number") {
            setRemote({ at: f.at, keys: Array.isArray(f.keys) ? (f.keys as string[]) : [] });
          }
        },
        () => {},
      );
    } catch {
      /* Firestore nicht konfiguriert (reiner data.json-Modus) → nur lokales Flackern */
    }
    return () => unsub();
  }, []);

  // "active" muss ablaufen, auch ohne neues Snapshot-Event.
  useEffect(() => {
    if (!remote) return;
    const t = window.setInterval(() => tick(n => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [remote]);

  const broadcast = useCallback((keys: string[]) => {
    const ref = refRef.current;
    if (!ref || keys.length === 0) return;
    const at = Date.now();
    // Optimistisch lokal setzen, damit die eigene Erkennung nicht als "fremdes
    // Signal" doppelt zählt, wenn das Snapshot-Echo zurückkommt.
    setRemote({ at, keys });
    void setDoc(ref, { flash: { at, keys, meals: [] } }, { merge: true }).catch(() => {});
  }, []);

  const active = remote != null && Date.now() - remote.at < FRESH_MS;
  return { active, at: remote?.at ?? 0, keys: remote?.keys ?? [], broadcast };
}
