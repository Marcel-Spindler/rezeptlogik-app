// PET Plan – Linienspalte + Meal-Karte (Zeitfenster, Allergene, Anweisungen, Fotos).
import { useRef, useState } from "react";
import type { Recipe } from "../../core/types";
import { LINE_COLORS, LINE_COLORS_BG, LINE_COLORS_BORDER, LINE_COLORS_DARK, LINE_START_HOUR } from "./petTypes";
import type { AllergenDef, PetRow, PlatingImage } from "./petTypes";
import { fmtClock, fmtNum, getMealAllergens, getPlatingInstructions, getStructuredAllergens, getSubmealCount, parseSteps, statusColors } from "./petLogic";

export function LineColumn({
  lineIndex, rows, lineTarget, lineStaff, capacity, onCapacityChange, recipes, images, onAddImage, onRemoveImage,
}: {
  lineIndex: number;
  rows: PetRow[];
  lineTarget: number;
  lineStaff: number;
  capacity: number;
  onCapacityChange: (n: number) => void;
  recipes: Record<string, Recipe>;
  images: Record<string, PlatingImage[]>;
  onAddImage: (code: string, f: File) => void;
  onRemoveImage: (code: string, idx: number) => void;
}) {
  const [editingCap, setEditingCap] = useState(false);
  const [capDraft, setCapDraft] = useState(String(capacity));
  const capInputRef = useRef<HTMLInputElement>(null);

  const color = LINE_COLORS[lineIndex] ?? "#94a3b8";
  const bg = LINE_COLORS_BG[lineIndex] ?? "#f8fafc";
  const border = LINE_COLORS_BORDER[lineIndex] ?? "#e2e8f0";
  const darkColor = LINE_COLORS_DARK[lineIndex] ?? "#475569";
  const lineHours = lineTarget / capacity;
  const utilPct = Math.min(100, Math.round(lineTarget / capacity * 100));

  function commitCapacity() {
    const n = parseInt(capDraft.replace(/\D/g, ""), 10);
    if (n >= 100 && n <= 9999) onCapacityChange(n);
    else setCapDraft(String(capacity));
    setEditingCap(false);
  }

  return (
    <div className="rounded-2xl overflow-hidden border" style={{ borderColor: border }}>
      {/* Linien-Header */}
      <div className="px-4 py-3 text-white font-bold text-xs" style={{ background: color }}>
        <div className="flex items-center justify-between">
          <div className="font-black text-sm">Linie {lineIndex + 1}</div>
          {/* Editierbare Kapazität */}
          <div className="flex items-center gap-1">
            {editingCap ? (
              <input
                ref={capInputRef}
                type="number"
                min={100}
                max={9999}
                title={`Kapazität Linie ${lineIndex + 1} (Port./h)`}
                aria-label={`Kapazität Linie ${lineIndex + 1} in Portionen pro Stunde`}
                value={capDraft}
                onChange={(e) => setCapDraft(e.target.value)}
                onBlur={commitCapacity}
                onKeyDown={(e) => { if (e.key === "Enter") commitCapacity(); if (e.key === "Escape") { setCapDraft(String(capacity)); setEditingCap(false); } }}
                className="w-16 text-xs text-center font-bold text-slate-900 bg-white rounded px-1 py-0.5 border-0 outline-none focus:ring-1 focus:ring-white/50"
                autoFocus
              />
            ) : (
              <button
                type="button"
                onClick={() => { setCapDraft(String(capacity)); setEditingCap(true); setTimeout(() => capInputRef.current?.select(), 10); }}
                title="Kapazität bearbeiten"
                className="flex items-center gap-1 text-white/80 hover:text-white hover:bg-white/20 rounded px-1.5 py-0.5 transition-colors text-[10px] font-bold group"
              >
                <span>{fmtNum(capacity)}/h</span>
                <svg className="w-3 h-3 opacity-50 group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-3 mt-0.5 text-white/80 text-[10px]">
          <span>{fmtNum(lineTarget)} Port.</span>
          <span>{lineHours.toFixed(1)} h</span>
          <span>{lineStaff} MA</span>
        </div>
      </div>

      {/* Auslastungsbalken + Meta */}
      <div className="px-3 py-2" style={{ background: bg }}>
        <div className="flex justify-between text-[9px] mb-1" style={{ color: darkColor }}>
          <span>Start {fmtClock(LINE_START_HOUR * 60)} · Ende ~{fmtClock(LINE_START_HOUR * 60 + lineHours * 60)}</span>
          <span className="font-bold">{utilPct}% Auslastung</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden bg-white/60">
          <div className="h-full rounded-full" style={{ width: `${utilPct}%`, background: color }} />
        </div>
      </div>

      {/* Meal Cards */}
      <div className="p-2 space-y-1" style={{ background: bg }}>
        {rows.length === 0 ? (
          <div className="text-center py-4 text-xs text-slate-400">Keine Meals</div>
        ) : rows.map((row, mi) => {
          const next = rows[mi + 1];
          const curAllergens = getMealAllergens(row, recipes[row.recipeCode]);
          const nxtAllergens = next ? getMealAllergens(next, recipes[next.recipeCode]) : [];
          const curSet = new Set(curAllergens.map((a) => a.label));
          const nxtSet = new Set(nxtAllergens.map((a) => a.label));
          const removed = [...curSet].filter((l) => !nxtSet.has(l));
          const added = [...nxtSet].filter((l) => !curSet.has(l));
          const hasChange = next && (removed.length > 0 || added.length > 0);

          const prevTarget = rows.slice(0, mi).reduce((s, r) => s + r.target, 0);
          const startMin = LINE_START_HOUR * 60 + Math.round(prevTarget / capacity * 60);
          const endMin = startMin + Math.max(10, Math.round(row.target / capacity * 60));

          return (
            <div key={row.key}>
              <MealCard
                row={row}
                recipe={recipes[row.recipeCode]}
                allergens={curAllergens}
                timeStart={startMin}
                timeEnd={endMin}
                lineColor={color}
                images={images[row.recipeCode] ?? []}
                onAddImage={(f) => onAddImage(row.recipeCode, f)}
                onRemoveImage={(idx) => onRemoveImage(row.recipeCode, idx)}
              />
              {hasChange && (
                <div className="mx-1 my-1 px-3 py-1.5 rounded-lg border border-dashed border-amber-400 bg-amber-50 text-[9px] text-amber-800 font-bold">
                  ⚠ LINIE REINIGEN
                  {removed.length > 0 && <span className="font-normal"> · entfernt: {removed.join(", ")}</span>}
                  {added.length > 0 && <span className="font-normal"> · neu: {added.join(", ")}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Meal Card ──────────────────────────────────────────────────────────────

export function MealCard({
  row, recipe, allergens, timeStart, timeEnd, lineColor, images, onAddImage, onRemoveImage,
}: {
  row: PetRow;
  recipe: Recipe | undefined;
  allergens: AllergenDef[];
  timeStart: number;
  timeEnd: number;
  lineColor: string;
  images: PlatingImage[];
  onAddImage: (f: File) => void;
  onRemoveImage: (idx: number) => void;
}) {
  const imgInputRef = useRef<HTMLInputElement>(null);
  const platingInstr = getPlatingInstructions(recipe, row.market);
  const structuredAllergens = getStructuredAllergens(recipe, row.market);
  const submeals = getSubmealCount(recipe, row.market);
  const hours = (timeEnd - timeStart) / 60;
  const { bg: stBg, text: stText } = statusColors(row.platingStatus);
  const mapped = row.mapped ?? 0;
  const mappedPct = row.target > 0 && mapped > 0 ? Math.round(mapped / row.target * 100) : 0;

  // Gesamtzahl Schritte über alle Sub-Meals
  const totalSteps = platingInstr.reduce((s, b) => s + parseSteps(b.text).length, 0);

  return (
    <div className="rounded-xl bg-white border border-slate-200 shadow-sm overflow-hidden"
      style={{ borderLeft: `3px solid ${lineColor}` }}>
      <div className="px-3 py-2.5">
        {/* Kopfzeile: Name + Zeitfenster */}
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-black text-slate-900 leading-tight">{row.recipeName}</div>
            {row.recipeCode && (
              <div className="text-[9px] font-mono text-slate-400 mt-0.5">
                {row.recipeCode}{row.market && ` · ${row.market}`} · {submeals} Subm.
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="text-[10px] font-black tabular-nums" style={{ color: lineColor }}>
              {fmtClock(timeStart)}–{fmtClock(timeEnd)}
            </div>
            <div className="text-[9px] text-slate-400">{hours.toFixed(1)} h</div>
          </div>
        </div>

        {/* Portionen + Status */}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className="text-sm font-black text-slate-900 tabular-nums">{fmtNum(row.target)}</span>
          <span className="text-[9px] text-slate-400">Port.</span>
          {row.platingStatus && (
            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-lg ${stBg} ${stText}`}>
              {row.platingStatus}
            </span>
          )}
          {row.rolloverAmount != null && (
            <span className="text-[9px] font-bold px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800">
              ↩ {fmtNum(row.rolloverAmount)} Rollover
            </span>
          )}
        </div>

        {/* Fortschritt */}
        {mappedPct > 0 && (
          <div className="mb-2">
            <div className="flex justify-between text-[8px] text-slate-400 mb-0.5">
              <span>Geplated</span>
              <span>{mappedPct}% · {fmtNum(mapped)}</span>
            </div>
            <div className="h-1 bg-slate-100 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${mappedPct >= 100 ? "bg-emerald-500" : "bg-blue-400"}`}
                style={{ width: `${Math.min(100, mappedPct)}%` }} />
            </div>
          </div>
        )}

        {/* Allergen-Badges */}
        <div className="flex flex-wrap gap-1 mb-2">
          {allergens.length > 0 ? allergens.map((a) => (
            <span key={a.label} style={{ background: a.bg, color: a.color, borderColor: a.border }}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold border">
              {a.label}
            </span>
          )) : <span className="text-[9px] text-slate-300">keine Allergene</span>}
        </div>

        {/* Allergen-Text aus App-Daten */}
        {structuredAllergens && (
          <div className="flex items-start gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 text-[9px] text-amber-800 mb-2">
            <span className="shrink-0 mt-0.5">⚠</span>
            <span><strong>Allergene:</strong> {structuredAllergens}</span>
          </div>
        )}

        {/* Hinweise */}
        {row.bestByDate && (
          <div className="flex items-start gap-1.5 bg-violet-50 border border-violet-200 rounded-lg px-2.5 py-1.5 text-[9px] text-violet-800 mb-1.5">
            <span>📅</span>
            <span><strong>Best By:</strong> {row.bestByDate}{row.bestBySubRecipe ? ` · ${row.bestBySubRecipe}` : ""}</span>
          </div>
        )}
        {row.expiringSubRecipe && (
          <div className="flex items-start gap-1.5 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 text-[9px] text-red-800 mb-1.5">
            <span>🕐</span>
            <span>
              <strong>Ablauf:</strong> {row.expiringSubRecipe}
              {row.expiringPortions && ` · ${fmtNum(parseFloat(row.expiringPortions))} Port.`}
              {row.expiringDatetime && ` · ${row.expiringDatetime}`}
            </span>
          </div>
        )}
        {row.comment && (
          <div className="flex items-start gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 text-[9px] text-slate-600 mb-1.5">
            <span>💬</span><span>{row.comment}</span>
          </div>
        )}

        {/* Plating-Anweisungen – immer sichtbar, nummerierte Schritte je Sub-Meal */}
        {platingInstr.length > 0 && (
          <div className="space-y-2">
            <div className="text-[8px] font-black uppercase tracking-[.1em] text-green-700">
              Anweisungen · {platingInstr.length} Sub-Meals · {totalSteps} Schritte
            </div>
            {platingInstr.map((b) => {
              const steps = parseSteps(b.text);
              return (
                <div key={b.id} className="rounded-xl border border-green-200 overflow-hidden">
                  <div className="px-3 py-1.5 bg-green-50 border-b border-green-200 flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" d="M9 5l7 7-7 7"/>
                      </svg>
                    </div>
                    <div className="text-[9px] font-bold text-green-800">{b.name}</div>
                    <span className="ml-auto text-[8px] text-green-600">{steps.length} Schritte</span>
                  </div>
                  <div className="px-3 py-2 bg-green-50/40 space-y-1.5">
                    {steps.length > 0 ? steps.map((step, si) => (
                      <div key={si} className="flex gap-2.5 items-start">
                        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-600 text-white text-[8px] font-black shrink-0 mt-0.5">
                          {si + 1}
                        </span>
                        <span className="text-[10px] leading-snug text-slate-700 flex-1">{step}</span>
                      </div>
                    )) : (
                      <pre className="whitespace-pre-wrap text-[10px] leading-relaxed text-slate-700">{b.text}</pre>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!recipe && (
          <div className="text-[9px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1">
            ⚠ Rezept {row.recipeCode} nicht in App-Daten
          </div>
        )}

        {/* Fotos */}
        <div className="mt-2">
          <input ref={imgInputRef} type="file" accept="image/*" multiple
            title="Foto hochladen" aria-label="Foto hochladen" className="hidden"
            onChange={(e) => { Array.from(e.target.files ?? []).forEach((f) => onAddImage(f)); e.target.value = ""; }} />

          {images.length > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[9px] font-black uppercase tracking-[.1em] text-slate-400">
                  Fotos ({images.length})
                </div>
                <button type="button" onClick={() => imgInputRef.current?.click()}
                  className="text-[9px] font-bold text-blue-600 hover:text-blue-800">
                  + Foto
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {images.map((img, idx) => (
                  <div key={idx} className="relative group rounded-lg overflow-hidden border border-slate-200 bg-white">
                    <img src={img.dataUrl} alt="Foto" className="w-full h-20 object-contain p-1" />
                    <div className="px-2 py-1 bg-slate-50 border-t border-slate-100">
                      <div className="text-[8px] text-slate-400 truncate">{img.name}</div>
                    </div>
                    <button type="button" onClick={() => onRemoveImage(idx)}
                      className="absolute top-1 right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => imgInputRef.current?.click()}
              className="w-full rounded-xl border border-dashed border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50/40 px-3 py-2 text-center transition-all">
              <div className="text-[9px] font-semibold text-slate-400">📸 Foto hinzufügen</div>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
