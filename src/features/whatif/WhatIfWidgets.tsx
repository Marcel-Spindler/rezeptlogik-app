// What-If Rechner – KPI-Kachel sowie die (selbstrekursive) Sub-Rezept-Baum-Ansicht mit Zutatenzeilen.
import { useState } from "react";
import type { FlatIngredient, SubRecipeAggregate } from "./whatIfTypes";
import { fmt, fmtMass, parseNumInput } from "./whatIfFormat";

export function SummaryTile({ label, value, tone }: {
  label: string;
  value: string;
  tone: "indigo" | "emerald" | "red" | "amber" | "violet" | "slate" | "sky";
}): JSX.Element {
  const tones: Record<string, string> = {
    indigo: "bg-indigo-100 text-indigo-900 ring-indigo-300",
    emerald: "bg-emerald-100 text-emerald-900 ring-emerald-300",
    red: "bg-red-100 text-red-900 ring-red-300",
    amber: "bg-amber-100 text-amber-900 ring-amber-300",
    violet: "bg-violet-100 text-violet-900 ring-violet-300",
    sky: "bg-sky-100 text-sky-900 ring-sky-300",
    slate: "bg-slate-100 text-slate-900 ring-slate-300"
  };
  return (
    <div className={`rounded-xl ring-1 px-3 py-2 ${tones[tone]}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-xl font-extrabold font-mono tabular-nums">{value}</div>
    </div>
  );
}

export function SubRecipeAggregateView({
  agg,
  targetPortions,
  showForward,
  selectedSubRecipeId,
  onSelectSubRecipe,
  onOverride
}: {
  agg: SubRecipeAggregate;
  targetPortions: number;
  showForward: boolean;
  selectedSubRecipeId: string | null;
  onSelectSubRecipe: (subRecipeId: string) => void;
  onOverride: (ingredientId: string, subRecipeId: string, value: number | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const [showInstructions, setShowInstructions] = useState(false);

  const depthColors = ["border-l-indigo-500", "border-l-violet-500", "border-l-fuchsia-500", "border-l-rose-500"];
  const borderColor = depthColors[Math.min(agg.depth, depthColors.length - 1)];
  const isSelected = agg.subRecipeId === selectedSubRecipeId;

  const totalGrossForRun = agg.subtreeGrossPerPortion * targetPortions;
  const yieldDisplay = agg.avgYield !== undefined ? `Ø ${(agg.avgYield * 100).toFixed(2)}%` : "—";
  const totalNetForRun = agg.subtreeNetPerPortion * targetPortions;

  return (
    <div className={`rounded-xl border border-slate-200 border-l-4 ${borderColor} bg-white ${isSelected ? "ring-2 ring-sky-300" : ""}`}>
      <button
        onClick={() => {
          onSelectSubRecipe(agg.subRecipeId);
          setOpen(o => !o);
        }}
        className="w-full flex items-start gap-3 p-3 text-left hover:bg-slate-50 rounded-t-xl"
      >
        <span className="text-xs font-bold text-slate-400 mt-1 shrink-0">
          {open ? "▼" : "▶"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-sm text-slate-800">{agg.name}</div>
          {agg.categories && (
            <div className="text-[11px] text-slate-500 mt-0.5">{agg.categories}</div>
          )}
          {agg.path.length > 1 && (
            <div className="text-[10px] text-slate-400 mt-0.5">
              Pfad: {agg.path.slice(0, -1).join(" → ")}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 text-right">
          <div className="text-[10px] uppercase font-bold text-slate-400">Direkte Zutaten</div>
          <div className="text-xs font-bold">{agg.ingredients.length}</div>
          {showForward && agg.totalGrossPerPortion > 0 && (
            <>
              <div className="text-[10px] uppercase font-bold text-slate-400 mt-1">Brutto/Portion direkt</div>
              <div className="text-xs font-mono">{fmt(agg.totalGrossPerPortion, 1)} g</div>
              <div className="text-[10px] uppercase font-bold text-slate-400 mt-1">Brutto inkl. Kinder</div>
              <div className="text-xs font-mono text-indigo-700">{fmt(agg.subtreeGrossPerPortion, 1)} g</div>
              <div className="text-[10px] text-emerald-600 font-mono">@ {yieldDisplay}</div>
            </>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-100 p-3 space-y-2">
          {agg.instructions && (
            <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-2">
              <button
                onClick={() => setShowInstructions(s => !s)}
                className="flex items-center gap-2 text-xs font-bold text-yellow-900"
              >
                <span>{showInstructions ? "▼" : "▶"}</span>
                <span>📋 Plating- / Cook-Anweisungen</span>
              </button>
              {showInstructions && (
                <pre className="mt-2 text-[11px] text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">
                  {agg.instructions}
                </pre>
              )}
            </div>
          )}

          {showForward && agg.subtreeGrossPerPortion > 0 && targetPortions > 0 && (
            <div className="bg-indigo-50/50 rounded-lg p-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Σ Brutto inkl. Kinder · {fmt(targetPortions)} P.</div>
                <div className="font-mono font-bold text-indigo-700">{fmtMass(totalGrossForRun)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Σ Netto (nach Yield)</div>
                <div className="font-mono font-bold text-emerald-700">{fmtMass(totalNetForRun)}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-slate-500 font-bold">Verlust</div>
                <div className="font-mono font-bold text-red-600">{fmtMass(totalGrossForRun - totalNetForRun)}</div>
              </div>
            </div>
          )}

          {agg.ingredients.length > 0 && (
            <div className="space-y-1">
              {agg.ingredients.map((ing, i) => (
                <IngredientYieldRow
                  key={`${ing.ingredientId}-${i}`}
                  ing={ing}
                  targetPortions={targetPortions}
                  showForward={showForward}
                  onOverride={onOverride}
                />
              ))}
            </div>
          )}

          {agg.childSubRecipes.length > 0 && (
            <div className="ml-4 space-y-2 mt-2">
              {agg.childSubRecipes.map(child => (
                <SubRecipeAggregateView
                  key={child.subRecipeId}
                  agg={child}
                  targetPortions={targetPortions}
                  showForward={showForward}
                  selectedSubRecipeId={selectedSubRecipeId}
                  onSelectSubRecipe={onSelectSubRecipe}
                  onOverride={onOverride}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function IngredientYieldRow({
  ing,
  targetPortions,
  showForward,
  onOverride
}: {
  ing: FlatIngredient;
  targetPortions: number;
  showForward: boolean;
  onOverride: (ingredientId: string, subRecipeId: string, value: number | null) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [tempValue, setTempValue] = useState<string>((ing.effectiveYield * 100).toFixed(2));

  const totalGross = ing.grossQty * (showForward ? targetPortions : 1);
  const totalNet = totalGross * ing.effectiveYield;
  const lossGrams = totalGross - totalNet;

  function commit(): void {
    const pct = parseNumInput(tempValue);
    if (pct < 0.01 || pct > 200) {
      setTempValue((ing.effectiveYield * 100).toFixed(2));
      setEditing(false);
      return;
    }
    onOverride(ing.ingredientId, ing.subRecipeId, pct / 100);
    setEditing(false);
  }

  function reset(): void {
    onOverride(ing.ingredientId, ing.subRecipeId, null);
    setEditing(false);
  }

  return (
    <div
      id={`ing-row-${ing.ingredientId}__${ing.subRecipeId}`}
      className={`rounded-lg px-3 py-2 grid grid-cols-12 gap-2 items-center text-xs transition-shadow ${
        ing.hasOverride ? "bg-amber-50 ring-1 ring-amber-300" : "bg-slate-50"
      }`}
    >
      <div className="col-span-5 min-w-0">
        <div className="font-medium text-slate-800 truncate" title={ing.ingredientName}>
          {ing.ingredientName}
        </div>
        <div className="text-[10px] text-slate-400 font-mono truncate">
          {ing.ingredientId}
        </div>
      </div>

      <div className="col-span-2 text-right">
        <div className="text-[10px] uppercase text-slate-400 font-bold">Brutto/P.</div>
        <div className="font-mono">{fmt(ing.grossQty, 2)} {ing.uom}</div>
      </div>

      <div className="col-span-2 text-center">
        {editing ? (
          <div className="flex gap-1 items-center justify-center">
            <input
              type="number"
              value={tempValue}
              onChange={e => setTempValue(e.target.value)}
              onBlur={commit}
              onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
              autoFocus
              min="0.01"
              max="200"
              step="0.01"
              className="w-16 rounded border border-amber-400 px-1 py-0.5 text-xs font-mono"
            />
            <span className="text-xs">%</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-0.5">
            <button
              onClick={() => { setTempValue((ing.effectiveYield * 100).toFixed(2)); setEditing(true); }}
              className={`px-2 py-1 rounded font-mono font-bold ${
                ing.hasOverride
                  ? "bg-amber-200 text-amber-900 ring-1 ring-amber-400"
                  : ing.yieldSource === "csv"
                    ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                    : ing.yieldSource === "computed"
                      ? "bg-blue-100 text-blue-800 hover:bg-blue-200"
                      : "bg-red-100 text-red-600 hover:bg-red-200"
              }`}
              title={ing.hasOverride
                ? `Override aktiv. Default war: ${ing.defaultYield !== undefined ? (ing.defaultYield * 100).toFixed(2) + "%" : "—"}`
                : ing.yieldSource === "csv"
                  ? "Yield aus CSV (klick zum Überschreiben)"
                  : ing.yieldSource === "computed"
                    ? `Berechnet aus netQty/grossQty (${ing.netQty.toFixed(1)}/${ing.grossQty.toFixed(1)})`
                    : "Kein Yield in Daten → Fallback 100% (klick zum Setzen)"
              }
            >
              {(ing.effectiveYield * 100).toFixed(2)}%
              {ing.hasOverride && " ✏"}
            </button>
            {ing.effectiveYield > 1 && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 font-bold">Quell</span>
            )}
            {ing.yieldMissing && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-bold">!Fehlt</span>
            )}
            {ing.yieldSource === "computed" && !ing.hasOverride && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 font-bold">~Berechnet</span>
            )}
          </div>
        )}
      </div>

      <div className="col-span-2 text-right">
        {showForward && targetPortions > 0 && (
          <>
            <div className="text-[10px] uppercase text-slate-400 font-bold">Σ Rohware</div>
            <div className="font-mono font-bold text-indigo-700">{fmtMass(totalGross)}</div>
            <div className="text-[10px] text-red-600 font-mono">−{fmtMass(lossGrams)} Verlust</div>
          </>
        )}
        {!showForward && (
          <>
            <div className="text-[10px] uppercase text-slate-400 font-bold">Netto/P.</div>
            <div className="font-mono">{fmt(totalNet, 2)} {ing.uom}</div>
          </>
        )}
      </div>

      <div className="col-span-1 text-right">
        {ing.hasOverride && !editing && (
          <button
            onClick={reset}
            className="text-[10px] text-red-600 hover:text-red-800 underline"
            title="Override entfernen, zurück zu CSV-Default"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
