import { type CSSProperties, useMemo } from "react";
import type { CookSchedule, Market, Recipe } from "../../../core/types";
import {
  matchesNeedle, methodColorToCSS, resolveCookSchedule,
  subRecipeTone, subRecipeUrgency, subRecipeUrgencyLabel,
} from "../../../lib/helpers";

interface Props {
  recipeCode: string;
  md: NonNullable<Recipe["markets"][Market]>;
  cookSchedules: Record<string, CookSchedule>;
  detailSearch: string;
}

const URGENCY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function methodColorStyles(methodColor: string | undefined, tonePanel: CSSProperties): { panel: CSSProperties; text: CSSProperties } {
  const colorCSS = methodColorToCSS(methodColor);
  if (!colorCSS) return { panel: tonePanel, text: { color: "#334155" } };
  const darkened = colorCSS.replace(/#([0-9a-f]{6})/i, (_, hex: string) => {
    const r = parseInt(hex.slice(0, 2), 16) * 0.4;
    const g = parseInt(hex.slice(2, 4), 16) * 0.4;
    const b = parseInt(hex.slice(4, 6), 16) * 0.4;
    return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
  });
  return {
    panel: { backgroundColor: colorCSS + "33", borderColor: colorCSS + "88" },
    text: { color: darkened },
  };
}

export function SubRecipesTab({ recipeCode, md, cookSchedules, detailSearch }: Props) {
  const needle = detailSearch.trim().toLowerCase();

  const items = useMemo(() =>
    md.subRecipes
      .filter(s => matchesNeedle([s.id, s.name, s.category, s.methodType, s.methodColor, s.instructions], needle))
      .sort((a, b) => {
        const csA = resolveCookSchedule(a.category, cookSchedules).schedule;
        const csB = resolveCookSchedule(b.category, cookSchedules).schedule;
        return URGENCY_ORDER[subRecipeUrgency(csA?.cookShifts)] - URGENCY_ORDER[subRecipeUrgency(csB?.cookShifts)];
      }),
    [md.subRecipes, needle, cookSchedules]
  );

  return (
    <div className="space-y-3">
      {items.map((s, idx) => {
        const resolved = resolveCookSchedule(s.category, cookSchedules);
        const cs = resolved.schedule;
        const tone = subRecipeTone(recipeCode, cs?.cookShifts);
        const urgencyLabel = subRecipeUrgencyLabel(cs?.cookShifts);
        const isNext = idx === 0;
        const colorCSS = methodColorToCSS(s.methodColor);
        const { panel: colorPanelStyle, text: colorTextStyle } = methodColorStyles(s.methodColor, tone.panel);

        return (
          <div key={s.id} className="overflow-hidden rounded-2xl border shadow-sm" style={tone.frame}>
            <div className="px-4 py-3" style={tone.header}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center justify-center rounded-full text-xs font-bold w-6 h-6 shrink-0 shadow-sm"
                  style={{ backgroundColor: isNext ? "#1e293b" : "#64748b", color: "#fff" }}>{idx + 1}</span>
                {isNext && <span className="pill bg-slate-800 text-white text-[10px] font-semibold px-2 py-0.5">→ Als Nächstes</span>}
                <span className="font-mono text-xs text-slate-500">{s.id}</span>
                <h4 className="font-semibold" style={tone.headerText}>{s.name}</h4>
                {s.category && <span className="pill" style={tone.badge}>{s.category}</span>}
                {cs && <span className="pill" style={tone.urgency}>VF · {cs.cookShifts} Shift{cs.cookShifts > 1 ? "s" : ""}</span>}
                {cs && resolved.matchType !== "exact" && resolved.matchedMethod && (
                  <span className="pill bg-blue-100 text-blue-800">VF-Match via {resolved.matchedMethod}</span>
                )}
                <span className="pill" style={tone.urgency}>Dringlichkeit: {urgencyLabel}</span>
                {!cs && s.category && <span className="pill bg-amber-100 text-amber-800">kein VF-Schedule</span>}
              </div>
            </div>
            <div className="space-y-2 px-4 py-3">
              <div className="grid gap-2 md:grid-cols-2 text-xs">
                <div className="rounded-xl px-3 py-2 ring-1" style={tone.panel}>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">Method-Typ</div>
                  <div className="mt-1 font-medium text-slate-700">{s.methodType || "-"}</div>
                </div>
                <div className="rounded-xl px-3 py-2 ring-1" style={colorPanelStyle}>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">Method-Color</div>
                  <div className="mt-1 flex items-center gap-2 font-semibold" style={colorTextStyle}>
                    {colorCSS && <span className="inline-block h-4 w-4 shrink-0 rounded-full border border-white shadow" style={{ backgroundColor: colorCSS }} />}
                    {s.methodColor || "-"}
                  </div>
                </div>
              </div>
              {s.instructions && (
                <div className="rounded-xl px-3 py-3 text-sm leading-relaxed text-slate-700 ring-1" style={tone.panel}>{s.instructions}</div>
              )}
            </div>
          </div>
        );
      })}
      {items.length === 0 && <div className="card p-4 text-slate-500">Keine Sub-Rezepte für diese Suche gefunden.</div>}
    </div>
  );
}
