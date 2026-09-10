// Relay der Ersatz-Kopfzahlen (Planned Target / Actuals) an die Cloud Function.
//
// Die Function `rtiBackfillWatch` schreibt Planned Target / Actuals in den
// RTI-Sheet-Kopf, wenn sie fehlen. Ihre eigene Ist-Quelle (Online-Redzone) ist
// aber an den Snowflake-JWT gebunden und fällt zeitweise aus. Dann liest sie
// stattdessen diesen Firestore-Doc, den jede offene App mit funktionierender
// Redzone-Verbindung (lokaler WMS-Server) füllt — analog zu sharedBackfillFlash.
//
//   apps/rezeptlogik/backfillWatch/rtiTargets
//     { updatedAt, updatedIso, targets: { "0780": {plannedTarget, actuals, source}, … } }
import { getFirebase, doc, setDoc } from "../../core/firebase";
import type { RtiExternalTarget } from "./rtiBackfillCalculator";

function hash(targets: Map<string, RtiExternalTarget>): string {
  return [...targets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v.plannedTarget}/${v.actuals}`)
    .join("|");
}

let lastPushedHash = "";
let lastPushedAt = 0;

/**
 * Schreibt die aktuelle externalTargets-Map nach Firestore — nur wenn sie sich
 * geändert hat und der letzte Schreibvorgang > 60 s her ist (mehrere offene Apps
 * schreiben last-write-wins, das ist ok). Leise bei jedem Fehler.
 */
export function pushRtiTargets(targets: Map<string, RtiExternalTarget>): void {
  if (targets.size === 0) return;
  const h = hash(targets);
  const now = Date.now();
  if (h === lastPushedHash && now - lastPushedAt < 5 * 60 * 1000) return;
  if (now - lastPushedAt < 60 * 1000) return;

  let ref;
  try {
    const { db } = getFirebase();
    ref = doc(db, "apps", "rezeptlogik", "backfillWatch", "rtiTargets");
  } catch {
    return; // Firestore nicht konfiguriert (reiner data.json-Modus)
  }

  const obj: Record<string, RtiExternalTarget> = {};
  for (const [k, v] of targets) obj[k] = v;

  lastPushedHash = h;
  lastPushedAt = now;
  void setDoc(ref, { targets: obj, updatedAt: now, updatedIso: new Date(now).toISOString() }, { merge: false })
    .catch(() => { lastPushedHash = ""; /* nächster Versuch darf wieder */ });
}
