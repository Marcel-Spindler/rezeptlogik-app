// Modal zum Anlegen/Bearbeiten einer Work-Order-Zuweisung auf dem Wochenboard.
import type { WeekRecipe } from "../../../../core/types";
import type { analyzePlan, PlannerDay, PlannerShift } from "../../../../lib/planner";

export type WeekBoardEditorState = {
  recipeCode: string;
  day: PlannerDay;
  shift: PlannerShift;
  subRecipeId?: string;
  subRecipeName?: string;
};

export type WeekBoardEditorDraft = {
  shift: PlannerShift;
  targetPortions: number;
  reason: string;
  splitSpec: string;
  notes: string;
  createSubRecipeWOs: boolean;
};

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

interface Props {
  boardEditor: WeekBoardEditorState;
  boardDraft: WeekBoardEditorDraft;
  setBoardDraft: React.Dispatch<React.SetStateAction<WeekBoardEditorDraft>>;
  onClose: () => void;
  recipeLookup: Record<string, WeekRecipe>;
  analysisRecipes: ReturnType<typeof analyzePlan>["recipes"];
  portionMultiplier: number;
  activeShifts: readonly PlannerShift[];
  onRemoveAssignment: () => void;
  onSaveUnlocked: () => void;
  onSave: () => void;
}

export function BoardEditorModal({
  boardEditor, boardDraft, setBoardDraft, onClose, recipeLookup, analysisRecipes,
  portionMultiplier, activeShifts, onRemoveAssignment, onSaveUnlocked, onSave,
}: Props) {
  const editorRecipe = recipeLookup[boardEditor.recipeCode];
  const editorAnalysis = analysisRecipes.find(row => row.recipeCode === boardEditor.recipeCode);
  const demand = Math.max(0, Math.round((editorRecipe?.totalVerdenVolume ?? 0) * portionMultiplier));
  const mapped = editorAnalysis?.assigned?.targetPortions ?? 0;
  const unassignedSubCount = editorAnalysis?.subRecipes.filter(s => !s.assigned).length ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-xl bg-white shadow-2xl ring-1 ring-slate-300" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between rounded-t-xl bg-emerald-700 px-4 py-2 text-white">
          <div className="text-sm font-semibold">{boardEditor.subRecipeId ? "Create sub-recipe work order" : "Create recipe work order"}</div>
          <button className="text-lg leading-none" onClick={onClose}>×</button>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div className="rounded bg-slate-100 px-3 py-2">
            <div className="text-sm font-semibold text-slate-900">{boardEditor.recipeCode} – {editorAnalysis?.recipeName ?? editorRecipe?.recipeName ?? ""}</div>
            {boardEditor.subRecipeId && <div className="mt-0.5 text-xs text-slate-600">{boardEditor.subRecipeName ?? boardEditor.subRecipeId}</div>}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>Demand: <strong className="text-slate-700">{fmtNum(demand)}</strong></span>
              <span>Mapped: <strong className="text-slate-700">{fmtNum(Math.round(mapped))}</strong></span>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-semibold text-slate-600">
              Plating day
              <input className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm" value={boardEditor.day} readOnly />
            </label>
            <div>
              <div className="text-xs font-semibold text-slate-600">Shift</div>
              <div className="mt-1 grid grid-cols-3 gap-1">
                {activeShifts.map(shift => (
                  <button key={`edit-${shift}`} className={`rounded border px-2 py-2 text-sm font-semibold ${boardDraft.shift === shift ? "border-emerald-700 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-white text-slate-600"}`} onClick={() => setBoardDraft(prev => ({ ...prev, shift }))}>
                    {shift === "S1" ? "1st shift" : shift === "S2" ? "2nd shift" : "3rd shift"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-semibold text-slate-600">
              Target
              <input type="number" min={0} className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm" value={boardDraft.targetPortions} onChange={event => setBoardDraft(prev => ({ ...prev, targetPortions: Math.max(0, Number(event.target.value) || 0) }))} />
            </label>
            <label className="text-xs font-semibold text-slate-600">
              Reason
              <select className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm" value={boardDraft.reason} onChange={event => setBoardDraft(prev => ({ ...prev, reason: event.target.value }))}>
                <option value="Planned">Planned</option>
                <option value="Forecast">Forecast adjustment</option>
                <option value="Urgent">Urgent fix</option>
              </select>
            </label>
          </div>
          {!boardEditor.subRecipeId && (
            <label className="text-xs font-semibold text-slate-600">
              Split spec (optional, e.g. Fr:1200|Sa:900|So:700)
              <input
                className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
                placeholder="Fr:1200|Sa:900|So:700"
                value={boardDraft.splitSpec}
                onChange={event => setBoardDraft(prev => ({ ...prev, splitSpec: event.target.value.trim() }))}
              />
            </label>
          )}
          <label className="text-xs font-semibold text-slate-600">
            Notes
            <textarea className="mt-1 h-16 w-full resize-none rounded border border-slate-300 px-2 py-2 text-sm" placeholder="Add notes about this work order" value={boardDraft.notes} onChange={event => setBoardDraft(prev => ({ ...prev, notes: event.target.value }))} />
          </label>
          {!boardEditor.subRecipeId && unassignedSubCount > 0 && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={boardDraft.createSubRecipeWOs}
                onChange={e => setBoardDraft(prev => ({ ...prev, createSubRecipeWOs: e.target.checked }))}
              />
              Create sub-recipe WOs ({unassignedSubCount} unassigned)
            </label>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3">
          <button className="rounded border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-semibold text-rose-700" onClick={onRemoveAssignment}>Remove assignment</button>
          <div className="flex gap-2">
            <button className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700" onClick={onClose}>Cancel</button>
            <button className="rounded border border-emerald-600 bg-white px-3 py-1.5 text-sm font-semibold text-emerald-700" onClick={onSaveUnlocked}>Save as Unlocked</button>
            <button className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white" onClick={onSave}>Save & Lock</button>
          </div>
        </div>
      </div>
    </div>
  );
}
