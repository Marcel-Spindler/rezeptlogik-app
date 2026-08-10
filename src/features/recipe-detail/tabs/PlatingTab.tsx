import type { Market, Recipe } from "../../../core/types";
import { matchesNeedle } from "../../../lib/helpers";

interface Props {
  md: NonNullable<Recipe["markets"][Market]>;
  detailSearch: string;
}

export function PlatingTab({ md, detailSearch }: Props) {
  const needle = detailSearch.trim().toLowerCase();
  const allBlocks = md.subRecipes
    .filter(s => matchesNeedle([s.name, s.id, s.instructions ?? ""], needle))
    .map(s => ({ name: s.name, id: s.id, text: s.instructions ?? "" }));
  const withText = allBlocks.filter(b => b.text);
  const withoutText = allBlocks.filter(b => !b.text);

  return (
    <div className="space-y-3">
      {allBlocks.length === 0 && (
        <div className="card p-4 text-slate-500">Keine Sub-Rezepte für diese Suche gefunden.</div>
      )}
      {withText.map(b => (
        <div key={b.id} className="card p-4">
          <div className="font-semibold">{b.name}</div>
          <div className="font-mono text-[10px] text-slate-400 mb-2">{b.id}</div>
          <pre className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{b.text}</pre>
        </div>
      ))}
      {withoutText.length > 0 && (
        <div className="card p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
            Sub-Rezepte ohne Plating-Anweisung ({withoutText.length})
          </div>
          <div className="space-y-1">
            {withoutText.map(b => (
              <div key={b.id} className="flex items-center gap-2 text-sm text-slate-500">
                <span className="font-mono text-[10px] text-slate-300 w-32 shrink-0">{b.id}</span>
                <span>{b.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
