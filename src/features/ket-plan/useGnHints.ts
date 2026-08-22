// Lädt die GN-Blech-Hints aus dem Kuechenbible-GSheet-Dump (PROTEIN-DEBOX/
// VEGGIE-DEBOX Bible-Tabs) — einmalig, geteilt zwischen KetBreakdownView und
// dem Shopfloor-Kiosk. Ohne Treffer bleibt für viele Zutaten trotzdem die fest
// codierte kg-Kapazitäts-Tabelle als Fallback aktiv (siehe ketLogic.resolveGnTrays),
// daher hier kein harter Fehlerzustand nötig.
import { useEffect, useState } from "react";
import { wrBuildHintsFromDumps } from "../kitchen-mode/wrEquipmentHints";
import { EMPTY_GN_HINTS, type GnHints } from "./ketLogic";

export function useGnHints(): GnHints {
  const [gnHints, setGnHints] = useState<GnHints>(EMPTY_GN_HINTS);
  useEffect(() => {
    let cancelled = false;
    fetch("/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json")
      .then((res) => (res.ok ? res.json() : null))
      .then((bibles) => {
        if (cancelled || !bibles) return;
        const { trayHints, pieceWeightKg } = wrBuildHintsFromDumps(null, bibles);
        setGnHints({ trayHints, pieceWeightKg });
      })
      .catch((error) => console.warn("[useGnHints] GN-Blech-Hints konnten nicht geladen werden:", error));
    return () => { cancelled = true; };
  }, []);
  return gnHints;
}
