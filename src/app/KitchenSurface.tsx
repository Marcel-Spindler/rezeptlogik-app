// Reduzierte Oberfläche für ?surface=kitchen — nur KW-Wahl + Breakdown-Rechner,
// gedacht zum Teilen mit der Küche per Link.
import { BreakdownEquipmentView } from "../BreakdownEquipmentView";
import { buildKitchenShareUrl, isProducedInVerden } from "../lib/helpers";
import { Shell } from "./Shell";
import type { DataBundle, WeekRecipe } from "../core/types";

interface Props {
  data: DataBundle;
  weeks: string[];
  weekRecipes: WeekRecipe[];
  selectedWeek: string;
  onWeekChange: (week: string) => void;
  upliftPercent: number;
  kitchenLinkCopied: boolean;
  onLinkCopiedChange: (copied: boolean) => void;
}

export function KitchenSurface({
  data, weeks, weekRecipes, selectedWeek, onWeekChange, upliftPercent, kitchenLinkCopied, onLinkCopiedChange,
}: Props) {
  const copyKitchenLink = () => {
    navigator.clipboard.writeText(buildKitchenShareUrl(selectedWeek)).then(() => {
      onLinkCopiedChange(true);
      setTimeout(() => onLinkCopiedChange(false), 2000);
    });
  };

  return (
    <Shell>
      <div className="card p-4 mb-4 bg-gradient-to-r from-amber-50 via-white to-emerald-50 ring-1 ring-amber-200">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-amber-700">Küchenmodus</div>
            <div className="text-sm font-semibold text-slate-800">Breakdown-Rechner</div>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Kalenderwoche
              <select
                className="mt-1 block min-w-[16rem] rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm"
                value={selectedWeek}
                onChange={e => onWeekChange(e.target.value)}
              >
                {weeks.map(w => {
                  const n = weekRecipes.filter(r => r.hfWeek === w && isProducedInVerden(r)).length;
                  return <option key={w} value={w}>{w} ({n} Rezepte)</option>;
                })}
              </select>
            </label>
            <button
              type="button"
              className={`mb-0.5 rounded-lg px-3 py-2 text-xs font-semibold ring-1 ${
                kitchenLinkCopied ? "bg-emerald-100 text-emerald-800 ring-emerald-300" : "bg-white text-slate-700 ring-slate-300"
              }`}
              onClick={copyKitchenLink}
            >
              {kitchenLinkCopied ? "✓ Link kopiert" : "Küchen-Link kopieren"}
            </button>
          </div>
        </div>
      </div>
      <BreakdownEquipmentView data={data} week={selectedWeek} upliftPercent={upliftPercent} locale="de" />
    </Shell>
  );
}
