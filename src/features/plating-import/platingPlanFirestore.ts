// Firestore-Lese- und Schreiboperationen für Plating-Plan-Daten.
// Pfad: apps/rezeptlogik/platingPlan/{week}  (z.B. "2026-W36")
import type { PlatingPlanData } from "../../core/types";
import { getFirebase } from "../../core/firebase";
import { doc, setDoc, onSnapshot } from "firebase/firestore";

export async function savePlatingPlanToFirestore(
  data: PlatingPlanData,
  log: (msg: string) => void
): Promise<void> {
  const { db } = getFirebase();

  const docRef = doc(db, "apps/rezeptlogik/platingPlan", data.week);
  await setDoc(docRef, {
    week: data.week,
    importedAt: data.importedAt,
    recipes: data.recipes,
  });

  log(`✓ Plating-Plan für ${data.week} gespeichert (${data.recipes.length} Rezepte)`);
}

export function subscribePlatingPlan(
  week: string,
  onData: (data: PlatingPlanData | null) => void
): () => void {
  let unsubscribe: (() => void) | undefined;
  let disposed = false;

  try {
    const { db } = getFirebase();
    if (disposed) return () => { disposed = true; };

    unsubscribe = onSnapshot(
      doc(db, "apps/rezeptlogik/platingPlan", week),
      (snap) => {
        if (snap.exists()) {
          onData(snap.data() as PlatingPlanData);
        } else {
          onData(null);
        }
      },
      () => onData(null)
    );
  } catch {
    onData(null);
  }

  return () => { disposed = true; unsubscribe?.(); };
}
