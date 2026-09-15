// Live-synchronisierter "gestagt"-Status + Planungsoverrides je WO für das
// Staging-Dashboard. Lager-Mitarbeiter klicken eine WO ab, sobald sie ins
// Staging-Bereich gebracht wurde; Planer können das Staging-Datum per Offset
// verschieben falls sich der Kochplan ändert. Firestore → geräteübergreifend
// in Echtzeit sichtbar. Ein Dokument pro Woche, startet leer.
import { useCallback, useEffect, useState } from "react";
import { doc, getFirebase, onSnapshot, setDoc } from "../../core/firebase";

export interface StagingProgressEntry {
  staged: boolean;
  stagedAt: string | null;
  /** Offset in vollen Tagen relativ zum automatisch berechneten Staging-Datum.
   *  0 = kein Override, -1 = einen Tag früher, +1 = einen Tag später usw. */
  offsetDays?: number;
  /** Lager meldet: Zutat(en) nicht auf Lager. Key = Zutat-Name. */
  outOfStock?: Record<string, string> | null;
}

export type StagingProgress = Record<string, StagingProgressEntry>; // key: woNumber

export function useStagingProgress(week: string | null): {
  progress: StagingProgress;
  setStaged: (woNumber: string, staged: boolean) => void;
  setOffset: (woNumber: string, offsetDays: number) => void;
  setOutOfStock: (woNumber: string, ingredientName: string, isOos: boolean) => void;
  syncError: string | null;
} {
  const [progress, setProgress] = useState<StagingProgress>({});
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    if (!week) { setProgress({}); return; }
    const { db } = getFirebase();
    const ref = doc(db, "apps/rezeptlogik/stagingProgress", week);
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.data() as { entries?: StagingProgress } | undefined;
      setProgress(data?.entries ?? {});
      setSyncError(null);
    }, (error) => {
      console.error("[useStagingProgress] Live-Sync fehlgeschlagen:", error);
      setSyncError("Fortschritt konnte nicht geladen werden — Verbindung prüfen.");
    });
    return () => unsub();
  }, [week]);

  const writeEntry = useCallback((woNumber: string, patch: Partial<StagingProgressEntry>) => {
    if (!week) return;
    const mergeEntry = (existing: StagingProgressEntry | undefined): StagingProgressEntry =>
      Object.assign({ staged: false, stagedAt: null } as StagingProgressEntry, existing, patch);
    setProgress((prev) => ({ ...prev, [woNumber]: mergeEntry(prev[woNumber]) }));
    const { db } = getFirebase();
    const ref = doc(db, "apps/rezeptlogik/stagingProgress", week);
    const entry = mergeEntry(progress[woNumber]);
    setDoc(ref, { entries: { [woNumber]: entry } }, { merge: true })
      .then(() => setSyncError(null))
      .catch((error) => {
        console.error("[useStagingProgress] Speichern fehlgeschlagen:", error);
        setSyncError(`WO ${woNumber} nicht gespeichert — bitte erneut klicken.`);
      });
  }, [week, progress]);

  const setStaged = useCallback((woNumber: string, staged: boolean) => {
    writeEntry(woNumber, { staged, stagedAt: staged ? new Date().toISOString() : null });
  }, [writeEntry]);

  const setOffset = useCallback((woNumber: string, offsetDays: number) => {
    writeEntry(woNumber, { offsetDays });
  }, [writeEntry]);

  const setOutOfStock = useCallback((woNumber: string, ingredientName: string, isOos: boolean) => {
    const current = progress[woNumber]?.outOfStock ?? {};
    const next = { ...current };
    if (isOos) next[ingredientName] = new Date().toISOString();
    else delete next[ingredientName];
    writeEntry(woNumber, { outOfStock: Object.keys(next).length > 0 ? next : null });
  }, [writeEntry, progress]);

  return { progress, setStaged, setOffset, setOutOfStock, syncError };
}
