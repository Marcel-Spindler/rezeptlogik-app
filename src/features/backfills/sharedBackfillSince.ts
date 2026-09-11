// Geteilter "seit wann offen"-Zeitstempel für den Backfill-Wächter.
//
// Die Cloud Function `rtiBackfillWatch` schreibt alle 10 min pro offenem
// Engpass (Key "<WO>|<SubRezeptName>") einen `since`-Zeitstempel nach
// Firestore (apps/rezeptlogik/backfillWatch/state, Feld `subs`) — das ist die
// EINE echte, für alle Geräte gleiche Quelle dafür, wann ein Backfill zuerst
// aufgetaucht ist (siehe functions/rtiBackfillWatch.js, nextSubs[key].since).
// Ohne das würde jeder Browser sein eigenes rein lokales "zuerst gesehen"
// führen (localStorage) — bei einem Reload oder auf einem anderen Rechner
// sähe derselbe Engpass dann plötzlich "gerade eben entdeckt" aus, obwohl er
// schon Stunden offen ist. Analog zu sharedBackfillFlash.ts / rtiTargetsRelay.ts.
import { useEffect, useState } from "react";
import { getFirebase, doc, onSnapshot } from "../../core/firebase";

/** Key "<WO>|<SubRezeptName>" → since (ms epoch), aus dem Sheet-Rechner-State. */
export function useSharedBackfillSince(): Map<string, number> {
  const [subs, setSubs] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let unsub = () => {};
    try {
      const { db } = getFirebase();
      const ref = doc(db, "apps", "rezeptlogik", "backfillWatch", "state");
      unsub = onSnapshot(
        ref,
        snap => {
          const raw = (snap.data() as { subs?: Record<string, { since?: unknown }> } | undefined)?.subs;
          if (!raw) { setSubs(new Map()); return; }
          const m = new Map<string, number>();
          for (const [k, v] of Object.entries(raw)) {
            const since = Number(v?.since);
            if (Number.isFinite(since)) m.set(k, since);
          }
          setSubs(m);
        },
        () => {},
      );
    } catch {
      /* Firestore nicht konfiguriert (reiner data.json-Modus) → nur lokaler Fallback */
    }
    return () => unsub();
  }, []);

  return subs;
}
