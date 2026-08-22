// Live-synchronisierter "erledigt"-Status je WO für die Shopfloor-Ansicht
// (Area Manager klicken eine WO als fertig, sobald abgearbeitet — z.B. auf
// zwei getrennten Kiosk-Laptops, einer je Debox-Küche). Firestore statt
// localStorage, damit der Fortschritt geräteübergreifend sichtbar ist (z.B.
// auch im Büro auf KetBreakdownView) und Laptop-Wechsel/-Reset übersteht.
// Ein Dokument pro Woche (wie apps/rezeptlogik/ketPlan/{week}) — startet
// jede Woche automatisch wieder leer, kein manuelles Aufräumen nötig.
import { useCallback, useEffect, useState } from "react";
import { doc, getFirebase, onSnapshot, setDoc } from "../../core/firebase";

export type DeboxDepartment = "veggie" | "protein";

export interface ShopfloorProgressEntry {
  done: boolean;
  doneAt: string | null;
  dept: DeboxDepartment;
}

export type ShopfloorProgress = Record<string, ShopfloorProgressEntry>; // key: woNumber

export function useShopfloorProgress(week: string | null): {
  progress: ShopfloorProgress;
  setDone: (woNumber: string, dept: DeboxDepartment, done: boolean) => void;
  // Sichtbar machen, wenn der Klick zwar lokal übernommen wurde, aber NICHT
  // gespeichert/synchronisiert werden konnte — sonst denkt der Area Manager,
  // eine WO sei erledigt vermerkt, obwohl der Haken beim nächsten Laden (oder
  // auf dem anderen Küchen-Laptop) wieder verschwindet.
  syncError: string | null;
} {
  const [progress, setProgress] = useState<ShopfloorProgress>({});
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    if (!week) { setProgress({}); return; }
    const { db } = getFirebase();
    const ref = doc(db, "apps/rezeptlogik/shopfloorProgress", week);
    const unsub = onSnapshot(ref, (snap) => {
      const data = snap.data() as { entries?: ShopfloorProgress } | undefined;
      setProgress(data?.entries ?? {});
      setSyncError(null);
    }, (error) => {
      console.error("[useShopfloorProgress] Live-Sync fehlgeschlagen:", error);
      setSyncError("Fortschritt konnte nicht geladen werden — Verbindung prüfen.");
    });
    return () => unsub();
  }, [week]);

  const setDone = useCallback((woNumber: string, dept: DeboxDepartment, done: boolean) => {
    if (!week) return;
    const entry: ShopfloorProgressEntry = { done, doneAt: done ? new Date().toISOString() : null, dept };
    // Optimistisch: sofort lokal setzen, damit der Klick nicht auf den
    // Firestore-Roundtrip/onSnapshot-Echo warten muss.
    setProgress((prev) => ({ ...prev, [woNumber]: entry }));
    const { db } = getFirebase();
    const ref = doc(db, "apps/rezeptlogik/shopfloorProgress", week);
    setDoc(ref, { entries: { [woNumber]: entry } }, { merge: true })
      .then(() => setSyncError(null))
      .catch((error) => {
        console.error("[useShopfloorProgress] Speichern fehlgeschlagen:", error);
        setSyncError(`WO ${woNumber} nicht gespeichert — bitte erneut klicken.`);
      });
  }, [week]);

  return { progress, setDone, syncError };
}
