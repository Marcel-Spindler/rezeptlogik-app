// Staging-Dashboard — WOs heute/morgen stagen. Zwei Ansichten:
// Karten (Detail) + Liste (kompakt, aufklappbar). Allergen-Sortierung,
// Firestore-Echtzeit-Sync, WMS Lagerplatz + Staging-Bestände.
import { useMemo, useState } from "react";
import type { BatchCalc, KetRow } from "./ketTypes";
import type { CookSchedule } from "../../core/types";
import type { StagingProgress } from "./useStagingProgress";
import type { IngredientStockMap } from "./useIngredientStock";
import { findStockForIngredient, findStagingStockForIngredient } from "./useIngredientStock";
import { parseDateShift, fmtKg, classifyDeboxDepartment } from "./ketLogic";
import { resolveCookSchedule } from "../../lib/helpers";
import { VF_COOK_SCHEDULES } from "../../data/cookSchedulesVF";
import { allergenSortScore, allergenGroupKey } from "./ketEquipmentSummary";
import type { PrintOptions } from "./stagingPrint";
import { DEFAULT_PRINT_OPTIONS, printStagingWo } from "./stagingPrint";

const DAY_MS = 24 * 60 * 60 * 1000;

type ViewMode = "card" | "list";
type WoEntry = { row: KetRow; calc: BatchCalc; staged: boolean; offset: number; stagingDate: string | null; aScore: number; aGroup: string; cookFlow: string[] };

// ── Staging-Datum ──────────────────────────────────────────────────────────────

function autoStagingDate(row: KetRow, cookSchedules: Record<string, CookSchedule>): string | null {
  const { date } = parseDateShift(row.dateNeeded);
  if (!date) return null;
  const joined = row.cookMethods.join("/");
  const vf = resolveCookSchedule(joined, VF_COOK_SCHEDULES);
  const cs = vf.schedule ?? resolveCookSchedule(joined, cookSchedules).schedule;
  const stagingStep = cs?.steps.find(s => /staging/i.test(s.label));
  const shiftsBefore = stagingStep?.shiftsBefore ?? (cs ? cs.cookShifts + 1 : 2);
  const deadlineMs = Date.parse(date);
  if (isNaN(deadlineMs)) return null;
  return new Date(deadlineMs - shiftsBefore * DAY_MS).toISOString().slice(0, 10);
}

function effectiveStagingDate(row: KetRow, cookSchedules: Record<string, CookSchedule>, offsetDays: number): string | null {
  const auto = autoStagingDate(row, cookSchedules);
  if (!auto) return null;
  if (!offsetDays) return auto;
  return new Date(Date.parse(auto) + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function cookFlowSteps(row: KetRow, cookSchedules: Record<string, CookSchedule>): string[] {
  const joined = row.cookMethods.join("/");
  const vf = resolveCookSchedule(joined, VF_COOK_SCHEDULES);
  const cs = vf.schedule ?? resolveCookSchedule(joined, cookSchedules).schedule;
  if (!cs?.steps.length) return [];
  return [...cs.steps].sort((a, b) => b.shiftsBefore - a.shiftsBefore).map(s => s.label);
}

// ── Farb-System ────────────────────────────────────────────────────────────────

function allergenTheme(score: number, staged: boolean) {
  if (staged) return { border: "#94A3B8", num: "bg-slate-200 text-slate-500", pill: "bg-slate-100 text-slate-500", badgeLabel: null };
  if (score === 0) return { border: "#10B981", num: "bg-emerald-500 text-white", pill: "bg-emerald-50 text-emerald-700 border border-emerald-200", badgeLabel: "ALLERGEN-FREI" };
  if (score <= 3)  return { border: "#F59E0B", num: "bg-amber-400 text-white",  pill: "bg-amber-50 text-amber-700 border border-amber-200",  badgeLabel: null };
  if (score <= 6)  return { border: "#F97316", num: "bg-orange-500 text-white", pill: "bg-orange-50 text-orange-700 border border-orange-200", badgeLabel: null };
  return              { border: "#EF4444", num: "bg-red-600 text-white",    pill: "bg-red-50 text-red-700 border border-red-200",       badgeLabel: null };
}

// ── Datum-Helfer ───────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function fmtMhd(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "–" : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function fmtQty(qty: number | null): string {
  if (qty == null) return "–";
  return (Math.round(qty * 10) / 10).toLocaleString("de-DE");
}

function todayIso()    { return new Date().toISOString().slice(0, 10); }
function tomorrowIso() { return new Date(Date.now() + DAY_MS).toISOString().slice(0, 10); }

function weekDaysFromIsoWeek(isoWeek: string | null): string[] {
  if (!isoWeek) return [];
  const m = isoWeek.match(/(\d{4})-?W(\d{2})/);
  if (!m) return [];
  const year = Number(m[1]);
  const week = Number(m[2]);
  // ISO: Jan 4 is always in week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dow = jan4.getUTCDay() || 7; // Mon=1..Sun=7
  const monday = new Date(Date.UTC(year, 0, 4 + (week - 1) * 7 - (dow - 1)));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}




// ── Abteilungs-Badge ───────────────────────────────────────────────────────────

function DeptBadge({ calc }: { calc: BatchCalc }) {
  const dept = classifyDeboxDepartment(calc);
  if (!dept) return null;
  if (dept === "protein") {
    return (
      <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200">
        🥩 Protein
      </span>
    );
  }
  return (
    <span className="text-[9px] font-black px-2 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">
      🥦 Veggie
    </span>
  );
}

// ── Print-Modal ───────────────────────────────────────────────────────────────

const PRINT_OPTION_LABELS: { key: keyof PrintOptions; label: string; hint?: string }[] = [
  { key: "lagerplatz",  label: "Regalplätze (A-XX-XX-X)" },
  { key: "mhd",         label: "MHD / FEFO" },
  { key: "stagingLocs", label: "Staging-Bestände (DEBOXWIP etc.)", hint: "Ware die schon in Staging-Bereichen liegt" },
  { key: "zutaten",     label: "Zutaten" },
  { key: "allergene",   label: "Allergene" },
  { key: "equipment",   label: "Equipment" },
  { key: "kochflow",    label: "Koch-Flow" },
];

function PrintModal({
  wo, calc, stagingDate, cookFlow, stockMap, stagingMap, onClose,
}: {
  wo: KetRow; calc: BatchCalc; stagingDate: string | null; cookFlow: string[];
  stockMap: IngredientStockMap; stagingMap: IngredientStockMap; onClose: () => void;
}) {
  const [opts, setOpts] = useState<PrintOptions>({ ...DEFAULT_PRINT_OPTIONS });
  const { date: platingDate } = parseDateShift(wo.dateNeeded);
  const toggle = (key: keyof PrintOptions) => setOpts(o => ({ ...o, [key]: !o[key] }));

  const handlePrint = () => {
    const allIng = [...calc.ingredients]
      .filter(i => i.totalKg > 0 || (i.totalPcs ?? 0) > 0)
      .sort((a, b) => b.totalKg - a.totalKg);
    printStagingWo(
      {
        woNumber: wo.woNumber, recipeName: wo.recipeName, subRecipeName: wo.subRecipeName,
        stagingDate, platingDate: platingDate ?? null,
        equipment: calc.equipBatches.map(e => `${e.label} ×${e.batches}`).join("  ·  "),
        cookFlow, allergens: calc.allergensContains,
        ingredients: allIng.map(ing => ({
          name: ing.name, isAllergen: !!ing.allergen,
          qty: ing.totalPcs != null && ing.totalPcs > 0 ? `${ing.totalPcs} Stk` : fmtKg(ing.totalKg),
        })),
        kg: fmtKg(calc.totalKg), batches: calc.batches,
      },
      opts, stockMap, stagingMap,
    );
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(15,34,64,0.55)" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl p-5 w-80 max-w-full">
        <div className="flex items-center justify-between mb-4">
          <span className="font-black text-slate-800 text-sm">🖨 Drucken — WO {wo.woNumber}</span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-lg leading-none">✕</button>
        </div>
        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Abschnitte wählen</div>
        <div className="space-y-1.5">
          {PRINT_OPTION_LABELS.map(({ key, label, hint }) => (
            <label key={key} className="flex items-start gap-2.5 cursor-pointer group">
              <input type="checkbox" checked={opts[key]} onChange={() => toggle(key)}
                className="w-4 h-4 rounded accent-indigo-600 mt-0.5 shrink-0" />
              <span className="text-sm text-slate-700 group-hover:text-slate-900 leading-tight">
                {label}
                {hint && <span className="block text-[10px] text-slate-400 font-normal">{hint}</span>}
              </span>
            </label>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={handlePrint}
            className="flex-1 py-2 rounded-xl text-sm font-bold bg-[#0f2240] text-white hover:bg-[#1a3a6b] transition-colors">
            Drucken
          </button>
          <button type="button" onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-bold bg-slate-100 text-slate-500 hover:bg-slate-200 transition-colors">
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Zutaten-Detail (geteilt zwischen Karte und Liste) ─────────────────────────

function IngredientsSection({
  allIngredients, stockMap, stagingMap, serverAvailable, expanded, setExpanded,
}: {
  allIngredients: BatchCalc["ingredients"];
  stockMap: IngredientStockMap; stagingMap: IngredientStockMap;
  serverAvailable: boolean; expanded: boolean; setExpanded: (v: boolean) => void;
}) {
  const visible = expanded ? allIngredients : allIngredients.slice(0, 5);
  const hasAllergenIngredients = allIngredients.some(i => !!i.allergen);

  return (
    <div className="border-t border-slate-100 bg-slate-50/60">
      <button type="button" onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 flex items-center justify-between text-[10px] font-bold text-slate-500 hover:text-slate-700 transition-colors">
        <div className="flex items-center gap-2">
          <span className="uppercase tracking-widest">Zutaten ({allIngredients.length})</span>
          {hasAllergenIngredients && <span className="text-[9px] font-bold text-orange-600 normal-case">⚠ Rot = Allergen</span>}
          {!serverAvailable && <span className="text-[9px] text-slate-300 normal-case font-normal">· WMS offline</span>}
        </div>
        <span className="text-slate-400">{expanded ? "▲ Weniger" : "▼ Alle anzeigen"}</span>
      </button>

      <div className="px-4 pb-3 space-y-1.5">
        {visible.map(ing => {
          const locs = findStockForIngredient(stockMap, ing.name);
          const sLocs = findStagingStockForIngredient(stagingMap, ing.name);
          const stagingGroups = new Map<string, number>();
          for (const l of sLocs) stagingGroups.set(l.locationId, (stagingGroups.get(l.locationId) ?? 0) + (l.actualQty ?? 0));

          return (
            <div key={ing.id}>
              <div className="flex items-center gap-2 py-0.5">
                <span className={`flex-1 min-w-0 text-[11px] ${ing.allergen ? "font-bold text-orange-700" : "text-slate-700"}`}>
                  {ing.allergen ? "⚠ " : "· "}{ing.name}
                </span>
                <div className="shrink-0 flex items-center gap-1.5">
                  {ing.separate && (
                    <span title="Separat: wird getrennt von anderen Zutaten verarbeitet"
                      className="text-[8px] font-black px-1 py-0.5 rounded bg-blue-100 text-blue-700 cursor-help">SEP</span>
                  )}
                  {ing.spiceRoom && (
                    <span title="Gewürzraum: kommt aus dem Gewürzraum, nicht dem Hauptlager"
                      className="text-[8px] font-black px-1 py-0.5 rounded bg-purple-100 text-purple-700 cursor-help">GEW</span>
                  )}
                  <span className="text-[11px] font-semibold text-slate-500 tabular-nums min-w-[4rem] text-right">
                    {ing.totalPcs != null && ing.totalPcs > 0 ? `${ing.totalPcs} Stk` : fmtKg(ing.totalKg)}
                  </span>
                </div>
              </div>
              {locs.length > 0 && (
                <div className="ml-3 mb-0.5 flex flex-wrap gap-1 items-center">
                  {(expanded ? locs : locs.slice(0, 3)).map((loc, li) => (
                    <div key={li} className="flex items-center gap-1">
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 tabular-nums whitespace-nowrap">
                        {loc.locationId}
                      </span>
                      {loc.expirationDate && (
                        <span className="text-[9px] text-slate-500 font-medium tabular-nums">MHD {fmtMhd(loc.expirationDate)}</span>
                      )}
                      {loc.actualQty != null && (
                        <span className="text-[9px] text-slate-400 tabular-nums">{fmtQty(loc.actualQty)}</span>
                      )}
                    </div>
                  ))}
                  {!expanded && locs.length > 3 && (
                    <span className="text-[9px] text-slate-400 cursor-pointer hover:text-indigo-500" onClick={() => setExpanded(true)}>
                      +{locs.length - 3} weitere
                    </span>
                  )}
                </div>
              )}
              {stagingGroups.size > 0 && (
                <div className="ml-3 mb-0.5 flex flex-wrap gap-1 items-center">
                  <span className="text-[8px] text-amber-600 font-bold whitespace-nowrap">🏭 auch:</span>
                  {[...stagingGroups.entries()].slice(0, expanded ? 20 : 3).map(([loc, qty]) => (
                    <div key={loc} className="flex items-center gap-1">
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 tabular-nums whitespace-nowrap">{loc}</span>
                      <span className="text-[9px] text-slate-400 tabular-nums">{fmtQty(qty)}</span>
                    </div>
                  ))}
                  {!expanded && stagingGroups.size > 3 && (
                    <span className="text-[9px] text-slate-400 cursor-pointer hover:text-indigo-500" onClick={() => setExpanded(true)}>
                      +{stagingGroups.size - 3} weitere
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!expanded && allIngredients.length > 5 && (
          <div className="text-[10px] text-slate-400 pt-0.5">+ {allIngredients.length - 5} weitere…</div>
        )}
      </div>
    </div>
  );
}

// ── Karten-Layout ─────────────────────────────────────────────────────────────

function WoCard({
  row, calc, staged, offset, stagingDate, allergenScore, seqNum, plannerMode, cookFlow,
  stockMap, stagingMap, serverAvailable, onToggleStaged, onOffsetChange,
}: WoItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  const theme = allergenTheme(allergenScore, staged);
  const { date: platingDate } = parseDateShift(row.dateNeeded);
  const allergens = calc.allergensContains;
  const allIngredients = useMemo(() =>
    [...calc.ingredients].filter(i => i.totalKg > 0 || (i.totalPcs ?? 0) > 0).sort((a, b) => b.totalKg - a.totalKg),
    [calc.ingredients]);
  const equipLabel = calc.equipBatches.map(e => `${e.label} ×${e.batches}`).join("  ·  ");

  return (
    <>
      {showPrint && (
        <PrintModal wo={row} calc={calc} stagingDate={stagingDate} cookFlow={cookFlow}
          stockMap={stockMap} stagingMap={stagingMap} onClose={() => setShowPrint(false)} />
      )}
      <div className={`rounded-2xl overflow-hidden shadow-sm transition-all duration-200 ${staged ? "opacity-60" : ""}`}
        style={{ border: `1.5px solid ${theme.border}20`, borderLeft: `5px solid ${theme.border}`, background: "#fff" }}>
        <div className="flex items-stretch">
          <div className={`shrink-0 w-12 flex items-center justify-center text-lg font-black select-none ${theme.num}`}>
            {staged ? "✓" : seqNum}
          </div>
          <div className="flex-1 min-w-0 px-4 py-3">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-black text-[#0f2240] tabular-nums tracking-tight">WO {row.woNumber}</span>
                  {theme.badgeLabel && <span className={`text-[9px] font-black px-2 py-0.5 rounded-full ${theme.pill}`}>{theme.badgeLabel}</span>}
                  {calc.chillerAssignment && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700 border border-sky-200">❄ Blast</span>}
                  {offset !== 0 && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">Verschoben {offset > 0 ? "+" : ""}{offset}d</span>}
                  <DeptBadge calc={calc} />
                </div>
                <div className="text-sm font-bold text-slate-800 leading-tight mt-0.5">{row.recipeName}</div>
                {row.subRecipeName && row.subRecipeName !== row.recipeName && (
                  <div className="text-[11px] text-slate-400 leading-tight">{row.subRecipeName}</div>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="text-sm font-black text-slate-700 tabular-nums">{fmtKg(calc.totalKg)}</div>
                {calc.batches > 0 && <div className="text-[10px] text-slate-400 tabular-nums">{calc.batches} Batches</div>}
              </div>
            </div>
            <div className="mt-2 flex items-center gap-3 text-[11px] flex-wrap">
              <div className="flex items-center gap-1">
                <span className="text-slate-400">📦</span>
                <span className={`font-bold ${offset !== 0 ? "text-amber-600" : "text-slate-700"}`}>
                  {stagingDate ? fmtDate(stagingDate) : "–"}
                </span>
              </div>
              <span className="text-slate-300">→</span>
              <div className="flex items-center gap-1">
                <span className="text-slate-400">🍽</span>
                <span className="text-slate-500 font-medium">{platingDate ? fmtDate(platingDate) : "–"}</span>
              </div>
              {equipLabel && <><span className="text-slate-200">·</span><span className="text-slate-400 font-medium text-[10px]">{equipLabel}</span></>}
            </div>
            {cookFlow.length > 0 && (
              <div className="mt-2 flex items-center gap-1 flex-wrap">
                {cookFlow.map((step, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-slate-300 text-[10px]">›</span>}
                    <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${/staging/i.test(step) ? "bg-indigo-100 text-indigo-700 border border-indigo-200" : "bg-slate-100 text-slate-500"}`}>{step}</span>
                  </span>
                ))}
              </div>
            )}
            {allergens.length > 0 && (
              <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] font-black text-red-600 uppercase tracking-wide">⚠ Enthält:</span>
                {allergens.map(a => <span key={a} className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">{a.split(" / ")[0]}</span>)}
              </div>
            )}
            {plannerMode && (
              <div className="mt-2.5 pt-2.5 border-t border-dashed border-amber-200 flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-amber-600 font-bold">✏ Datum verschieben:</span>
                {([-2, -1, 0, 1, 2] as const).map(d => (
                  <button key={d} type="button" onClick={() => onOffsetChange(d)}
                    className={`min-w-[2rem] h-7 rounded-lg text-[10px] font-bold transition-all border ${offset === d ? "bg-amber-500 text-white border-amber-500 shadow-sm" : "bg-white text-slate-500 border-slate-200 hover:border-amber-400 hover:text-amber-600"}`}>
                    {d === 0 ? "Auto" : d > 0 ? `+${d}d` : `${d}d`}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col" style={{ borderLeft: `1px solid ${staged ? "#10B98140" : "#e2e8f040"}` }}>
            <button type="button" onClick={() => setShowPrint(true)} title="Drucken"
              className="shrink-0 w-10 flex-1 flex items-center justify-center text-slate-300 hover:text-slate-500 hover:bg-slate-50 transition-all text-base"
              style={{ borderBottom: "1px solid #f1f5f9" }}>🖨</button>
            <button type="button" onClick={onToggleStaged} title={staged ? "Rückgängig" : "Als gestagt markieren"}
              className={`shrink-0 w-16 flex-1 flex flex-col items-center justify-center gap-1 text-[10px] font-black transition-all ${staged ? "bg-emerald-500 text-white" : "bg-slate-50 text-slate-300 hover:bg-emerald-50 hover:text-emerald-500"}`}>
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              <span>{staged ? "Gestagt" : "Stagen"}</span>
            </button>
          </div>
        </div>
        <IngredientsSection allIngredients={allIngredients} stockMap={stockMap} stagingMap={stagingMap}
          serverAvailable={serverAvailable} expanded={expanded} setExpanded={setExpanded} />
      </div>
    </>
  );
}

// ── Listen-Layout (kompakt, aufklappbar) ──────────────────────────────────────

function WoListRow({
  row, calc, staged, offset, stagingDate, allergenScore, seqNum, plannerMode, cookFlow,
  stockMap, stagingMap, serverAvailable, onToggleStaged, onOffsetChange,
}: WoItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  const theme = allergenTheme(allergenScore, staged);
  const { date: platingDate } = parseDateShift(row.dateNeeded);
  const allergens = calc.allergensContains;
  const allIngredients = useMemo(() =>
    [...calc.ingredients].filter(i => i.totalKg > 0 || (i.totalPcs ?? 0) > 0).sort((a, b) => b.totalKg - a.totalKg),
    [calc.ingredients]);

  return (
    <>
      {showPrint && (
        <PrintModal wo={row} calc={calc} stagingDate={stagingDate} cookFlow={cookFlow}
          stockMap={stockMap} stagingMap={stagingMap} onClose={() => setShowPrint(false)} />
      )}
      <div className={`rounded-xl overflow-hidden transition-all duration-150 ${staged ? "opacity-60" : ""}`}
        style={{ border: `1px solid ${theme.border}30`, borderLeft: `4px solid ${theme.border}`, background: "#fff" }}>
        {/* Kompakte Zeile */}
        <div className="flex items-center gap-2 px-3 py-2">
          {/* Nummer-Dot */}
          <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black select-none ${theme.num}`}>
            {staged ? "✓" : seqNum}
          </div>

          {/* WO + Name (aufklappbar) */}
          <button type="button" onClick={() => setExpanded(e => !e)}
            className="flex-1 min-w-0 flex items-center gap-2 text-left hover:opacity-80 transition-opacity">
            <span className="text-[11px] font-black text-[#0f2240] tabular-nums shrink-0">WO {row.woNumber}</span>
            <span className="text-[11px] font-semibold text-slate-700 truncate">{row.recipeName}</span>
            {row.subRecipeName && row.subRecipeName !== row.recipeName && (
              <span className="text-[10px] text-slate-400 truncate hidden sm:inline">{row.subRecipeName}</span>
            )}
          </button>

          {/* Badges */}
          <div className="shrink-0 flex items-center gap-1.5">
            {theme.badgeLabel && <span className={`text-[8px] font-black px-1.5 py-0.5 rounded-full ${theme.pill}`}>{theme.badgeLabel}</span>}
            {calc.chillerAssignment && <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700">❄</span>}
            {allergens.length > 0 && <span className="text-[8px] font-black text-red-600">⚠{allergens.length}</span>}
            <DeptBadge calc={calc} />
          </div>

          {/* Datum + kg */}
          <div className="shrink-0 hidden sm:flex items-center gap-2 text-[10px] text-slate-500">
            <span className={`font-bold ${offset !== 0 ? "text-amber-600" : ""}`}>📦 {stagingDate ? fmtDate(stagingDate) : "–"}</span>
            <span className="text-slate-300">→</span>
            <span>🍽 {platingDate ? fmtDate(platingDate) : "–"}</span>
          </div>
          <span className="shrink-0 text-[11px] font-black text-slate-600 tabular-nums hidden sm:inline">{fmtKg(calc.totalKg)}</span>

          {/* Expand-Toggle */}
          <button type="button" onClick={() => setExpanded(e => !e)}
            className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-300 hover:text-slate-500 transition-colors text-[10px]">
            {expanded ? "▲" : "▼"}
          </button>

          {/* Print */}
          <button type="button" onClick={() => setShowPrint(true)} title="Drucken"
            className="shrink-0 w-6 h-6 flex items-center justify-center text-slate-300 hover:text-slate-500 transition-colors text-sm">
            🖨
          </button>

          {/* Stagen-Toggle */}
          <button type="button" onClick={onToggleStaged}
            className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-all ${staged ? "bg-emerald-500 text-white" : "bg-slate-100 text-slate-300 hover:bg-emerald-50 hover:text-emerald-500"}`}
            title={staged ? "Rückgängig" : "Als gestagt markieren"}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </button>
        </div>

        {/* Ausgeklappter Inhalt */}
        {expanded && (
          <div>
            {/* Datum auf Mobile + Allergene */}
            <div className="px-3 pb-1 flex flex-wrap items-center gap-2 sm:hidden text-[10px] text-slate-500">
              <span className={`font-bold ${offset !== 0 ? "text-amber-600" : ""}`}>📦 {stagingDate ? fmtDate(stagingDate) : "–"}</span>
              <span>→ 🍽 {platingDate ? fmtDate(platingDate) : "–"}</span>
              <span className="font-black text-slate-600">{fmtKg(calc.totalKg)}</span>
            </div>
            {allergens.length > 0 && (
              <div className="px-3 pb-1.5 flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] font-black text-red-600 uppercase">⚠ Enthält:</span>
                {allergens.map(a => <span key={a} className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">{a.split(" / ")[0]}</span>)}
              </div>
            )}
            {cookFlow.length > 0 && (
              <div className="px-3 pb-1.5 flex items-center gap-1 flex-wrap">
                {cookFlow.map((step, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-slate-300 text-[10px]">›</span>}
                    <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${/staging/i.test(step) ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-500"}`}>{step}</span>
                  </span>
                ))}
              </div>
            )}
            {plannerMode && (
              <div className="px-3 pb-2 flex items-center gap-2 flex-wrap border-t border-dashed border-amber-200 pt-2">
                <span className="text-[10px] text-amber-600 font-bold">✏ Verschieben:</span>
                {([-2, -1, 0, 1, 2] as const).map(d => (
                  <button key={d} type="button" onClick={() => onOffsetChange(d)}
                    className={`min-w-[2rem] h-6 rounded-lg text-[9px] font-bold transition-all border ${offset === d ? "bg-amber-500 text-white border-amber-500" : "bg-white text-slate-500 border-slate-200 hover:border-amber-400"}`}>
                    {d === 0 ? "Auto" : d > 0 ? `+${d}d` : `${d}d`}
                  </button>
                ))}
              </div>
            )}
            <IngredientsSection allIngredients={allIngredients} stockMap={stockMap} stagingMap={stagingMap}
              serverAvailable={serverAvailable} expanded={true} setExpanded={() => {}} />
          </div>
        )}
      </div>
    </>
  );
}

// ── Gemeinsame Props ───────────────────────────────────────────────────────────

// ── Planer-Kommandozentrale ─────────────────────────────────────────────────

const SECTION_HELP: Record<string, string> = {
  overview: "Zeigt kg, WO-Anzahl und Staging-Fortschritt pro Tag. Klick auf einen Tag wechselt die Tagesansicht.",
  stations: "Batches pro Station und Tag. Rot = Spitzenlast, Gelb = mittel, Grün = niedrig. Sortiert nach Gesamt-Batches.",
  allergens: "Allergen-Gruppen pro Tag. Grün = allergen-frei, Rot = enthält Allergene. Zahl = Anzahl WOs.",
  wos: "Alle WOs der Woche. Sortierbar per Klick auf Spaltenheader. Verschieben ändert den Staging-Tag um ±1/2 Tage.",
};

function SectionHeader({ label, helpKey, open, onToggle }: { label: string; helpKey: string; open: boolean; onToggle: () => void }) {
  const [showHelp, setShowHelp] = useState(false);
  return (
    <div className="flex items-center gap-2 mb-1">
      <button type="button" onClick={onToggle} className="flex items-center gap-1.5 group">
        <span className="text-[9px] text-amber-500 transition-transform group-hover:text-amber-700" style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
        <span className="text-[10px] font-black text-amber-700 uppercase tracking-wider">{label}</span>
      </button>
      <button type="button" onClick={() => setShowHelp(h => !h)}
        className="w-4 h-4 rounded-full bg-amber-200/60 text-amber-700 text-[8px] font-black flex items-center justify-center hover:bg-amber-300/60 transition-colors" title="Hilfe">?</button>
      {showHelp && <span className="text-[9px] text-amber-600/80 italic">{SECTION_HELP[helpKey]}</span>}
    </div>
  );
}

function currentWeekRange(today: string): [string, string] {
  const d = new Date(`${today}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() - (dow - 1));
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  return [mon.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
}

function PlannerCommandCenter({
  woData, weekDays, activeDay, today, onSelectDay,
  onOffsetChange,
}: {
  woData: WoEntry[];
  weekDays: string[];
  activeDay: string;
  today: string;
  onSelectDay: (day: string) => void;
  onOffsetChange: (woNumber: string, offsetDays: number) => void;
}) {
  const [sortCol, setSortCol] = useState<"day" | "wo" | "kg" | "allergen">("day");
  const [sortAsc, setSortAsc] = useState(false);
  const [openSections, setOpenSections] = useState({ overview: true, stations: true, allergens: true, wos: true });
  const toggle = (key: keyof typeof openSections) => setOpenSections(s => ({ ...s, [key]: !s[key] }));

  const toggleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortAsc(a => !a);
    else { setSortCol(col); setSortAsc(true); }
  };

  // Filter to current calendar week only
  const [kwStart, kwEnd] = useMemo(() => currentWeekRange(today), [today]);

  // All unique staging days — only current week
  const allDays = useMemo(() => {
    const set = new Set(weekDays.filter(d => d >= kwStart && d <= kwEnd));
    for (const d of woData) {
      if (d.stagingDate && d.stagingDate >= kwStart && d.stagingDate <= kwEnd) set.add(d.stagingDate);
    }
    return [...set].sort();
  }, [woData, weekDays, kwStart, kwEnd]);

  // Per-day summary
  const daySummary = useMemo(() => allDays.map(day => {
    const wos = woData.filter(d => d.stagingDate === day);
    const totalKg = wos.reduce((s, d) => s + d.calc.totalKg, 0);
    const staged = wos.filter(d => d.staged).length;

    const stationBatches: Record<string, number> = {};
    for (const w of wos) {
      for (const eb of w.calc.equipBatches) {
        stationBatches[eb.label] = (stationBatches[eb.label] ?? 0) + eb.batches;
      }
      if (w.calc.components) {
        for (const comp of w.calc.components) {
          for (const eb of comp.equipBatches) {
            stationBatches[eb.label] = (stationBatches[eb.label] ?? 0) + eb.batches;
          }
        }
      }
    }

    const allergenCounts: Record<string, number> = {};
    for (const w of wos) {
      const g = w.aGroup || "allergen-frei";
      allergenCounts[g] = (allergenCounts[g] ?? 0) + 1;
    }

    return { day, count: wos.length, totalKg, staged, stationBatches, allergenCounts };
  }), [woData, allDays]);

  const daysWithData = useMemo(() => daySummary.filter(ds => ds.count > 0), [daySummary]);

  // WOs filtered to current week only
  const sortedWos = useMemo(() => {
    const all = woData.filter(d => d.stagingDate && d.stagingDate >= kwStart && d.stagingDate <= kwEnd);
    all.sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case "day": cmp = (a.stagingDate ?? "").localeCompare(b.stagingDate ?? ""); break;
        case "wo": cmp = a.row.woNumber.localeCompare(b.row.woNumber, undefined, { numeric: true }); break;
        case "kg": cmp = a.calc.totalKg - b.calc.totalKg; break;
        case "allergen": cmp = a.aScore - b.aScore; break;
      }
      return sortAsc ? cmp : -cmp;
    });
    return all;
  }, [woData, sortCol, sortAsc, kwStart, kwEnd]);

  const maxBatchesPerStation = useMemo(() => {
    const m: Record<string, number> = {};
    for (const ds of daysWithData) {
      for (const [s, b] of Object.entries(ds.stationBatches)) {
        m[s] = Math.max(m[s] ?? 0, b);
      }
    }
    return m;
  }, [daysWithData]);

  const activeStations = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const ds of daysWithData) {
      for (const [s, b] of Object.entries(ds.stationBatches)) {
        totals[s] = (totals[s] ?? 0) + b;
      }
    }
    return Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  }, [daysWithData]);

  return (
    <div className="mx-4 mb-3 rounded-2xl border border-amber-200 bg-amber-50/50 overflow-hidden">
      {/* Section 1: Week Grid */}
      <div className="px-4 pt-3 pb-2">
        <SectionHeader label="Wochen-Übersicht" helpKey="overview" open={openSections.overview} onToggle={() => toggle("overview")} />
        {openSections.overview && (
          daysWithData.length === 0 ? (
            <div className="text-[10px] text-slate-400 italic py-2">Keine Staging-Daten in dieser KW</div>
          ) : (
            <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(daysWithData.length, 7)}, 1fr)` }}>
              {daysWithData.map(ds => {
                const pct = ds.count > 0 ? Math.round((ds.staged / ds.count) * 100) : 0;
                const isActive = ds.day === activeDay;
                const isPast = ds.day < today;
                const allDone = ds.staged === ds.count && ds.count > 0;
                return (
                  <button key={ds.day} type="button" onClick={() => onSelectDay(ds.day)}
                    className={`rounded-xl p-2 text-center transition-all border ${
                      isActive ? "bg-[#0f2240] text-white border-[#0f2240] shadow-md"
                        : allDone ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : isPast && ds.count > 0 ? "bg-red-50 text-red-600 border-red-200"
                        : "bg-white text-slate-600 border-slate-200 hover:border-indigo-300"
                    }`}>
                    <div className="text-[10px] font-black">{fmtDate(ds.day)}</div>
                    <div className="text-[13px] font-black mt-1">{fmtKg(ds.totalKg)}</div>
                    <div className="text-[9px] font-bold">{ds.count} WOs</div>
                    <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ background: isActive ? "rgba(255,255,255,0.2)" : "#e2e8f0" }}>
                      <div className="h-full rounded-full transition-all" style={{
                        width: `${pct}%`,
                        background: allDone ? "#10B981" : pct > 0 ? "#6366F1" : "transparent"
                      }} />
                    </div>
                    <div className="text-[8px] font-bold mt-0.5">{ds.staged}/{ds.count}</div>
                  </button>
                );
              })}
            </div>
          )
        )}
      </div>

      {/* Section 2: Station Capacity */}
      <div className="px-4 pt-2 pb-2 border-t border-amber-200/60">
        <SectionHeader label="Stationen" helpKey="stations" open={openSections.stations} onToggle={() => toggle("stations")} />
        {openSections.stations && (
          activeStations.length === 0 ? (
            <div className="text-[10px] text-slate-400 italic py-1">Keine Equipment-Daten</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[9px]">
                <thead>
                  <tr>
                    <th className="text-left font-bold text-slate-500 pb-1 pr-2 w-24">Station</th>
                    {daysWithData.map(ds => (
                      <th key={ds.day} className="text-center font-bold text-slate-400 pb-1 px-0.5">{fmtDate(ds.day)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeStations.map(station => {
                    const peak = maxBatchesPerStation[station] ?? 0;
                    return (
                      <tr key={station}>
                        <td className="font-bold text-slate-600 py-0.5 pr-2 whitespace-nowrap">{station}</td>
                        {daysWithData.map(ds => {
                          const b = ds.stationBatches[station] ?? 0;
                          const intensity = peak > 0 ? b / peak : 0;
                          return (
                            <td key={ds.day} className="text-center py-0.5 px-0.5">
                              {b > 0 ? (
                                <span className="inline-block rounded px-1.5 py-0.5 font-black" style={{
                                  background: intensity > 0.8 ? "#FEE2E2" : intensity > 0.5 ? "#FEF3C7" : "#F0FDF4",
                                  color: intensity > 0.8 ? "#991B1B" : intensity > 0.5 ? "#92400E" : "#166534",
                                }}>{b}</span>
                              ) : <span className="text-slate-200">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      {/* Section 3: Allergen Heatmap */}
      <div className="px-4 pt-2 pb-2 border-t border-amber-200/60">
        <SectionHeader label="Allergene pro Tag" helpKey="allergens" open={openSections.allergens} onToggle={() => toggle("allergens")} />
        {openSections.allergens && (
          daysWithData.length === 0 ? (
            <div className="text-[10px] text-slate-400 italic py-1">Keine Daten</div>
          ) : (
            <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(daysWithData.length, 7)}, 1fr)` }}>
              {daysWithData.map(ds => (
                <div key={ds.day} className="text-center">
                  <div className="text-[9px] font-bold text-slate-400 mb-1">{fmtDate(ds.day)}</div>
                  <div className="flex flex-wrap gap-0.5 justify-center">
                    {Object.entries(ds.allergenCounts).sort(([a], [b]) => a.localeCompare(b)).map(([group, cnt]) => {
                      const isClean = group === "allergen-frei";
                      return (
                        <span key={group} className={`inline-flex w-5 h-5 rounded-full text-[7px] font-black items-center justify-center ${
                          isClean ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                        }`} title={`${group}: ${cnt} WOs`}>{cnt}</span>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {/* Section 4: WO Quick Table — no staged toggle (that's logistics) */}
      <div className="px-4 pt-2 pb-3 border-t border-amber-200/60">
        <SectionHeader label="Alle WOs — Schnellaktionen" helpKey="wos" open={openSections.wos} onToggle={() => toggle("wos")} />
        {openSections.wos && (
          <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-amber-50">
                <tr>
                  <th className="text-left py-1 pr-2 cursor-pointer select-none" onClick={() => toggleSort("day")}>
                    Tag {sortCol === "day" ? (sortAsc ? "↑" : "↓") : ""}
                  </th>
                  <th className="text-left py-1 pr-2 cursor-pointer select-none" onClick={() => toggleSort("wo")}>
                    WO {sortCol === "wo" ? (sortAsc ? "↑" : "↓") : ""}
                  </th>
                  <th className="text-left py-1 pr-2">Rezept</th>
                  <th className="text-right py-1 pr-2 cursor-pointer select-none" onClick={() => toggleSort("kg")}>
                    kg {sortCol === "kg" ? (sortAsc ? "↑" : "↓") : ""}
                  </th>
                  <th className="text-center py-1 pr-2 cursor-pointer select-none" onClick={() => toggleSort("allergen")}>
                    Allergen {sortCol === "allergen" ? (sortAsc ? "↑" : "↓") : ""}
                  </th>
                  <th className="text-center py-1">Verschieben</th>
                </tr>
              </thead>
              <tbody>
                {sortedWos.map(wo => {
                  const isActiveDay = wo.stagingDate === activeDay;
                  return (
                    <tr key={wo.row.key} className={`border-t border-amber-100 ${wo.staged ? "opacity-40" : ""} ${isActiveDay ? "bg-amber-100/40" : ""}`}>
                      <td className="py-1.5 pr-2">
                        <button type="button" onClick={() => onSelectDay(wo.stagingDate!)}
                          className="font-bold text-indigo-600 hover:underline">{fmtDate(wo.stagingDate!)}</button>
                      </td>
                      <td className="py-1.5 pr-2 font-black">{wo.row.woNumber}</td>
                      <td className="py-1.5 pr-2 max-w-[200px] truncate" title={wo.row.recipeName}>{wo.row.recipeName}</td>
                      <td className="py-1.5 pr-2 text-right font-bold">{fmtKg(wo.calc.totalKg)}</td>
                      <td className="py-1.5 pr-2 text-center">
                        {wo.aScore === 0 ? (
                          <span className="text-emerald-600 font-bold">✓</span>
                        ) : (
                          <span className={`inline-block px-1.5 py-0.5 rounded-full font-black text-[8px] ${
                            wo.aScore <= 3 ? "bg-amber-100 text-amber-700" : wo.aScore <= 6 ? "bg-orange-100 text-orange-700" : "bg-red-100 text-red-700"
                          }`}>{wo.aScore}</span>
                        )}
                      </td>
                      <td className="py-1.5 text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          {([-2, -1, 0, 1, 2] as const).map(d => (
                            <button key={d} type="button"
                              onClick={() => onOffsetChange(wo.row.woNumber, d)}
                              className={`w-6 h-5 rounded text-[8px] font-bold border transition-all ${
                                wo.offset === d ? "bg-amber-500 text-white border-amber-500" : "bg-white text-slate-400 border-slate-200 hover:border-amber-400"
                              }`}>{d === 0 ? "•" : d > 0 ? `+${d}` : d}</button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {sortedWos.length === 0 && (
                  <tr><td colSpan={6} className="py-3 text-center text-slate-400 italic text-[10px]">Keine WOs in der aktuellen KW</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Gemeinsame Props ───────────────────────────────────────────────────────────

interface WoItemProps {
  row: KetRow; calc: BatchCalc; staged: boolean; offset: number;
  stagingDate: string | null; allergenScore: number; seqNum: number;
  plannerMode: boolean; cookFlow: string[];
  stockMap: IngredientStockMap; stagingMap: IngredientStockMap; serverAvailable: boolean;
  onToggleStaged: () => void; onOffsetChange: (delta: number) => void;
}

// ── Haupt-Dashboard ────────────────────────────────────────────────────────────

export function StagingDashboard({
  rows, calcMap, cookSchedules, week, progress, stockMap, stagingMap, serverAvailable,
  onToggleStaged, onOffsetChange, syncError,
}: {
  rows: KetRow[];
  calcMap: Map<string, BatchCalc>;
  cookSchedules: Record<string, CookSchedule>;
  week: string | null;
  progress: StagingProgress;
  stockMap: IngredientStockMap;
  stagingMap: IngredientStockMap;
  serverAvailable: boolean;
  onToggleStaged: (woNumber: string, staged: boolean) => void;
  onOffsetChange: (woNumber: string, offsetDays: number) => void;
  syncError: string | null;
}) {
  const [plannerMode, setPlannerMode] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const today = todayIso();
  const tomorrow = tomorrowIso();

  const woData = useMemo(() => {
    return rows.map(row => {
      const calc = calcMap.get(row.key);
      if (!calc) return null;
      const entry = progress[row.woNumber] ?? {};
      const offset = entry.offsetDays ?? 0;
      const stagingDate = effectiveStagingDate(row, cookSchedules, offset);
      const aScore = allergenSortScore(calc.allergensContains);
      const aGroup = allergenGroupKey(calc.allergensContains);
      const cookFlow = cookFlowSteps(row, cookSchedules);
      return { row, calc, staged: entry.staged ?? false, offset, stagingDate, aScore, aGroup, cookFlow };
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  }, [rows, calcMap, progress, cookSchedules]);

  // Nur Tage der geladenen KW anzeigen (mit WO-Daten oder offenen WOs)
  const weekDays = useMemo(() => weekDaysFromIsoWeek(week), [week]);
  const availableDays = useMemo(() => {
    const daysWithData = new Set<string>();
    for (const d of woData) if (d.stagingDate) daysWithData.add(d.stagingDate);
    return weekDays.filter(day =>
      daysWithData.has(day) && (day >= today || woData.some(d => d.stagingDate === day && !d.staged))
    );
  }, [woData, today, weekDays]);

  const defaultDay = availableDays.includes(today)
    ? today : availableDays.includes(tomorrow)
    ? tomorrow : availableDays[0] ?? today;

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const activeDay = selectedDay ?? defaultDay;

  const visibleWos = useMemo(() => {
    return woData
      .filter(d => d.stagingDate === activeDay)
      .sort((a, b) => {
        if (a.staged !== b.staged) return a.staged ? 1 : -1;
        const gCmp = a.aGroup.localeCompare(b.aGroup);
        if (gCmp !== 0) return gCmp;
        if (a.aScore !== b.aScore) return a.aScore - b.aScore;
        return a.row.woNumber.localeCompare(b.row.woNumber, undefined, { numeric: true });
      });
  }, [woData, activeDay]);

  const stagedCount = visibleWos.filter(d => d.staged).length;
  const allDone = stagedCount === visibleWos.length && visibleWos.length > 0;

  const copyLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("surface", "staging");
    navigator.clipboard.writeText(url.toString()).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    });
  };

  return (
    <div className="min-h-full flex flex-col" style={{ background: "#f8fafc" }}>

      {/* ── HEADER ── */}
      <div style={{ background: "#0f2240" }} className="shrink-0 px-5 py-4">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-white text-base font-black tracking-tight leading-none">Staging</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {!serverAvailable && <span className="text-[10px] text-amber-300/70 font-medium">WMS offline</span>}

            {/* View Toggle */}
            <div className="flex rounded-lg overflow-hidden border border-white/20">
              <button type="button" onClick={() => setViewMode("list")}
                title="Listenansicht"
                className={`px-2.5 py-1.5 text-[11px] font-bold transition-all ${viewMode === "list" ? "bg-white/20 text-white" : "text-white/40 hover:text-white/70"}`}>
                ☰
              </button>
              <button type="button" onClick={() => setViewMode("card")}
                title="Kartenansicht"
                className={`px-2.5 py-1.5 text-[11px] font-bold transition-all ${viewMode === "card" ? "bg-white/20 text-white" : "text-white/40 hover:text-white/70"}`}>
                ▣
              </button>
            </div>

            <button type="button" onClick={() => setPlannerMode(m => !m)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${plannerMode ? "bg-amber-400 text-amber-900 shadow-sm" : "bg-white/10 text-white/60 hover:bg-white/20 hover:text-white"}`}>
              {plannerMode ? "✏ Planermodus aktiv" : "✏ Planer"}
            </button>
            <button type="button" onClick={copyLink}
              className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-all">
              {linkCopied ? "✓ Kopiert!" : "🔗 Teilen"}
            </button>
            <a href="https://rezeptlogik-verden-factor.web.app/" className="text-[10px] text-white/25 hover:text-white/50 ml-1 transition-colors">App ↗</a>
          </div>
        </div>

        {/* Progress */}
        {visibleWos.length > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className={`text-[12px] font-black ${allDone ? "text-emerald-300" : "text-white/70"}`}>
                {allDone ? "✓ Alles gestagt!" : `${stagedCount} / ${visibleWos.length} gestagt`}
              </span>
              <span className="text-[10px] text-white/30">{Math.round(visibleWos.length > 0 ? (stagedCount / visibleWos.length) * 100 : 0)}%</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.1)" }}>
              <div className="h-full rounded-full transition-all duration-500"
                style={{ width: `${visibleWos.length > 0 ? (stagedCount / visibleWos.length) * 100 : 0}%`, background: allDone ? "#10B981" : "#6366F1" }} />
            </div>
          </div>
        )}
      </div>

      {/* ── PLANER-KOMMANDOZENTRALE ── */}
      {plannerMode && (
        <PlannerCommandCenter
          woData={woData} weekDays={weekDays} activeDay={activeDay} today={today}
          onSelectDay={setSelectedDay} onOffsetChange={onOffsetChange}
        />
      )}

      {/* ── TAG-TABS ── */}
      <div className="shrink-0 px-4 pt-4 pb-2 flex items-center gap-2 flex-wrap">
        {availableDays.map(day => {
          const count = woData.filter(d => d.stagingDate === day).length;
          const done  = woData.filter(d => d.stagingDate === day && d.staged).length;
          const isActive = day === activeDay;
          const isToday    = day === today;
          const isTomorrow = day === tomorrow;
          const isPast     = day < today;
          const label = isToday ? "Heute" : isTomorrow ? "Morgen" : isPast ? "Offen" : fmtDate(day);
          return (
            <button key={day} type="button" onClick={() => setSelectedDay(day)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-sm ${
                isActive ? "bg-[#0f2240] text-white shadow-md"
                  : isPast ? "bg-amber-50 text-amber-700 border border-amber-200 hover:border-amber-400"
                  : "bg-white text-slate-500 border border-slate-200 hover:border-indigo-300 hover:text-indigo-600"
              }`}>
              <span>{label}</span>
              {!isPast && <span className="text-[10px] opacity-60">{fmtDate(day)}</span>}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-black ${
                done === count && count > 0 ? "bg-emerald-500 text-white"
                  : isActive ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"
              }`}>{done}/{count}</span>
            </button>
          );
        })}

        {/* Datums-Picker */}
        <input type="date" value={activeDay}
          onChange={e => { if (e.target.value) setSelectedDay(e.target.value); }}
          className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all shadow-sm cursor-pointer ${
            selectedDay && !availableDays.includes(selectedDay)
              ? "bg-[#0f2240] text-white border-[#0f2240]"
              : "bg-white text-slate-500 border-slate-200 hover:border-indigo-300"
          }`}
        />

        {availableDays.length === 0 && !selectedDay && (
          <span className="text-xs text-slate-400 italic">Keine Staging-WOs in den geladenen Daten</span>
        )}
      </div>

      {/* ── SORTIER-HINWEIS ── */}
      {visibleWos.length > 1 && (
        <div className="shrink-0 px-4 pb-2">
          <div className="flex items-center gap-2 text-[10px] text-slate-400">
            <span className="w-4 h-4 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[8px] font-black shrink-0">1</span>
            <span>Reihenfolge nach Allergen-Last — allergenarm zuerst, danach reinigen vor allergenreichen WOs</span>
            <span className="w-4 h-4 rounded-full bg-red-600 text-white flex items-center justify-center text-[8px] font-black shrink-0">N</span>
          </div>
        </div>
      )}

      {syncError && (
        <div className="shrink-0 mx-4 mb-2 rounded-xl px-4 py-2.5 text-[11px] font-bold bg-red-50 text-red-700 border border-red-200">⚠ {syncError}</div>
      )}

      {/* ── WO-LISTE ── */}
      <div className="flex-1 overflow-y-auto px-4 pb-8">
        {visibleWos.length === 0 ? (
          <div className="text-center text-slate-400 text-sm mt-16 space-y-1">
            <div className="text-3xl">📦</div>
            <div className="font-semibold">Keine WOs zu stagen</div>
            <div className="text-xs">für {activeDay === today ? "heute" : activeDay === tomorrow ? "morgen" : fmtDate(activeDay)}</div>
          </div>
        ) : (
          <div className={viewMode === "list" ? "space-y-1.5" : "space-y-3"}>
            {visibleWos.map(({ row, calc, staged, offset, stagingDate, aScore, cookFlow }, idx) => {
              const props: WoItemProps = {
                row, calc, staged, offset, stagingDate, allergenScore: aScore,
                seqNum: idx + 1, plannerMode, cookFlow, stockMap, stagingMap, serverAvailable,
                onToggleStaged: () => onToggleStaged(row.woNumber, !staged),
                onOffsetChange: delta => onOffsetChange(row.woNumber, delta),
              };
              return viewMode === "list"
                ? <WoListRow key={row.key} {...props} />
                : <WoCard key={row.key} {...props} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}
