// Verknüpft Rohstoff-Engpässe aus dem Shorts-Tracker-Sheet mit den aktuell
// geplanten Work Orders — beantwortet "welches Sub-Meal ist betroffen" und
// zeigt den im Sheet bereits hinterlegten Recovery-Stand (Status/Notes), statt
// selbst eine Lösung zu erfinden. Ist weder Recovery-Status noch eine Notiz
// eingetragen, gilt der Eintrag als "isNew" — noch nicht triagiert.
import type { ShortageEntry } from "./gsheetTypes";
import type { WoMatchedStatus } from "./postblastMatch";

export interface ShortageImpact {
  shortage: ShortageEntry;
  // null = die rekonstruierte WO-Nummer taucht im aktuellen Plan nicht (mehr)
  // auf (z.B. WO schon abgeschlossen/aus dem Plan gefallen, oder die KW-
  // Rekonstruktion aus "Staging Day" war falsch/nicht möglich).
  affectedWo: WoMatchedStatus | null;
  isNew: boolean;
}

const RECOVERY_STATUS_DE: Record<string, string> = {
  "shipment en route": "Versand auf dem Weg",
  "located in warehouse": "Im Lager",
  "partially recovered": "Teilweise wiederhergestellt",
  validating: "Wird geprüft",
  recovered: "Wiederhergestellt",
  "on route": "Auf dem Weg",
  "in transit": "Auf dem Weg",
};

export function formatRecoveryStatus(status: string): string {
  const normalized = status.replace(/\s+/g, " ").trim();
  if (!normalized) return "Noch keine Recovery-Info";
  const key = normalized.toLowerCase();
  return RECOVERY_STATUS_DE[key] ?? normalized;
}

export function correlateShortages(
  shortages: readonly ShortageEntry[],
  matched: readonly WoMatchedStatus[]
): ShortageImpact[] {
  const byWo = new Map(matched.map(w => [w.workOrder, w]));
  return shortages
    // "Filled" = im Sheet bereits als erledigt markiert -- keine offene Meldung mehr.
    .filter(s => !s.filled)
    .map(s => ({
      shortage: s,
      affectedWo: s.workOrder ? byWo.get(s.workOrder) ?? null : null,
      isNew: !s.recoveryStatus.trim() && !s.notes.trim(),
    }))
    .sort((a, b) => b.shortage.shortKg - a.shortage.shortKg);
}

export function describeShortageImpact(impact: ShortageImpact): string {
  const { shortage: s, affectedWo } = impact;
  const woLabel = s.workOrder ?? `WO-Nr. ${s.rawWorkOrderSuffix} (KW nicht bestimmbar)`;
  const mealPart = affectedWo
    ? `→ betrifft "${affectedWo.subRecipe}" (Meal ${affectedWo.recipeCode} "${affectedWo.recipeName}")`
    : "→ betroffenes Meal/Sub-Rezept nicht im aktuellen Plan gefunden (WO evtl. schon abgeschlossen oder andere Woche)";
  const recoveryStatusText = formatRecoveryStatus(s.recoveryStatus);
  const solution = s.recoveryStatus || s.notes
    ? `Stand laut Sheet: ${[recoveryStatusText, s.notes].filter(Boolean).join(" — ")}`
    : "⚠ Noch keine Recovery-Info im Sheet hinterlegt — braucht eine Entscheidung";
  return `${impact.isNew ? "🆕 NEU" : "⚠"} Mangel ${woLabel}: "${s.ingredient}" −${s.shortKg.toFixed(1)} kg ${mealPart}. ${solution}`;
}
