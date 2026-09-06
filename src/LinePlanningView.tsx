/**
 * LinePlanningView – Linienplanung.
 *
 * Spiegelt Marcels von Hand gepflegten Plating-Plan (Google Sheet
 * "F_VE Production Plan") 1:1 statt ihn app-intern zu berechnen — siehe
 * VorstellungsplanView. Die frühere interaktive Drag&Drop-Planung samt
 * Auto-Plan/Smart-Plating/Plating-KI und der Verbindung zum Cockpit-
 * Manufacturing-Snapshot wurde entfernt (2026-08-24, auf Wunsch): das GSheet
 * ist jetzt die einzige Quelle der Wahrheit für die Linienplanung.
 */
import type { UiLocale } from "./lib/i18n";
import type { DataBundle } from "./core/types";
import { VorstellungsplanView } from "./features/vorstellungsplan/VorstellungsplanView";

export function LinePlanningView({ week, data }: { week: string; data: DataBundle | null; locale?: UiLocale; upliftPercent?: number }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-slate-800">Plating Linien Planung</h2>
      <VorstellungsplanView week={week} appData={data} />
    </div>
  );
}
