import { formatDateTime } from "../lib/i18n";
import { exportWeeklyCookPlanPDF } from "../lib/planExport";
import type { DataBundle } from "../core/types";

export function AppFooter({ data, selectedWeek, upliftPercent }: {
  data: DataBundle;
  selectedWeek: string;
  upliftPercent: number;
}) {
  return (
    <footer className="mt-8 pb-6 text-xs text-slate-400 text-center space-y-0.5">
      <div>
        Stand: {formatDateTime("de", data.generatedAt)} ·
        Quelle: {import.meta.env.VITE_DATA_SOURCE ?? "firestore"} ·
        Verden (VF)
      </div>
      <div className="text-slate-300 flex flex-wrap justify-center items-center gap-x-3 gap-y-1">
        <a href="/?surface=rundmail" className="hover:text-slate-500 underline">🔗 Rundmail</a>
        <a href="/?view=whatif" className="hover:text-slate-500 underline">What-If</a>
        <a href="/?view=wo" className="hover:text-slate-500 underline">KET Plan / WO</a>
        <a href="/?view=pet" className="hover:text-slate-500 underline">PET Plan / Plating</a>
        <button
          type="button"
          className="hover:text-slate-600 underline"
          onClick={() => exportWeeklyCookPlanPDF(data, selectedWeek, upliftPercent)}
          title="Cook-Timeline für aktuelle KW als PDF drucken"
        >
          🖨 Cook-Plan PDF
        </button>
      </div>
    </footer>
  );
}
