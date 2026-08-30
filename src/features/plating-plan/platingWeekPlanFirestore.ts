// Firestore-Anbindung des Wochen-Plating-Plans.
// Pfad: apps/rezeptlogik/platingWeekPlan/{week}   (getrennt von platingPlan/{week},
// das ist der importierte PET-Plan). Direkte Client-Writes wie im Rest der App.

import { getFirebase, doc, setDoc, onSnapshot } from "../../core/firebase";
import type { PlatingWeekPlan } from "./platingPlanTypes";

const COLLECTION = "apps/rezeptlogik/platingWeekPlan";

export async function savePlatingWeekPlan(plan: PlatingWeekPlan): Promise<void> {
  const { db } = getFirebase();
  await setDoc(doc(db, COLLECTION, plan.week), {
    ...plan,
    updatedAt: new Date().toISOString(),
  });
}

export function subscribePlatingWeekPlan(
  week: string,
  onData: (plan: PlatingWeekPlan | null) => void,
): () => void {
  let disposed = false;
  let unsub: (() => void) | undefined;
  try {
    const { db } = getFirebase();
    if (disposed) return () => { disposed = true; };
    unsub = onSnapshot(
      doc(db, COLLECTION, week),
      (snap) => onData(snap.exists() ? (snap.data() as PlatingWeekPlan) : null),
      () => onData(null),
    );
  } catch {
    onData(null);
  }
  return () => { disposed = true; unsub?.(); };
}
