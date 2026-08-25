// 1:1-Spiegel der "F_VE Production Plan"-Tabelle -- gleiche Spaltenreihenfolge
// wie im Sheet (siehe parseProductionPlan.ts Kommentar: Code, Präferenz, Name,
// Markt-Split, Total(+Buffer), Komplexität-Block, Stationsflags, Allergene,
// Tages-Matrix So-Sa, Ready Do/Fr/Sa, Min Needs Do/Fr/Sa), nur modern gestylt
// (sticky Code+Meal, gruppierte Kopfzeile, Badges statt roher X-Flags) statt
// strukturell umgebaut -- eine eigene Tages-Kalender-Ansicht (Board mit einer
// Spalte pro Wochentag) hat genau das kaputt gemacht, was diese Tabelle
// eigentlich zeigen soll: Cup/Slicing-Vorbereitung und Plating-Menge für EIN
// Meal in einer durchgehenden Zeile über die Woche zu lesen.
//
// Pilot-Set editierbar (2026-08-24, siehe productionPlanOverrides.ts): Buffer,
// Allergene, Tages-Matrix. Das GSheet bleibt Basiswert -- Edits landen als
// Overlay in Firestore (amber = weicht vom GSheet ab, ↺ setzt zurück), nicht
// im Sheet selbst. Grundlage für die spätere KI-/Live-View-Verknüpfung: jede
// Zelle wird ein eigener editier- und referenzierbarer Datenpunkt.
import { useState, type ReactNode } from "react";
import { PRODUCTION_PLAN_DAYS, type ForecastRow, type ProductionPlanData, type ProductionPlanDay, type ProductionPlanDayCell, type ProductionPlanRow, type RecipeProfilRow } from "../gsheet-monitor/gsheetTypes";
import { formatShortDate, hfWeekDayDate } from "./productionPlanDates";
import { mergeRowOverride, type ProductionPlanOverrideRows, type ProductionPlanRowOverride } from "./productionPlanOverrides";
import { crossCheckProductionPlanRow } from "./productionPlanLiveCheck";

const DAY_SHORT: Record<ProductionPlanDay, string> = {
  Sunday: "So", Monday: "Mo", Tuesday: "Di", Wednesday: "Mi", Thursday: "Do", Friday: "Fr", Saturday: "Sa",
};

const READY_DAYS: ReadonlyArray<{ day: ProductionPlanDay; key: "thu" | "fri" | "sat" }> = [
  { day: "Thursday", key: "thu" }, { day: "Friday", key: "fri" }, { day: "Saturday", key: "sat" },
];

const STATION_KEYS: ReadonlyArray<{ key: keyof ProductionPlanRow["stations"]; label: string }> = [
  { key: "grill", label: "Grill" }, { key: "cup", label: "Cup" }, { key: "butter", label: "Butter" },
  { key: "oven", label: "Oven" }, { key: "braiser", label: "Braiser" }, { key: "slice", label: "Slice" },
];

// Spalten nach Code+Meal (2 sticky) -- fuer den "Wochensumme"-Footer, der nur
// ueber Markt-Split/Total/+Buffer echte Summen hat (aus data.totals) und den
// Rest (Komplexitaet...Allergene) in einer Leerzelle ueberspannt.
const TRAILING_COLSPAN = 5 /* Komplexitaet-Block */ + 1 /* Stationen-Badges */
  + PRODUCTION_PLAN_DAYS.length + READY_DAYS.length + READY_DAYS.length + 1 /* Allergene */;

function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

// Sheet-Zahlen nutzen "," als Tausendertrenner (siehe parseProductionPlan.ts
// parseIntCell) -- beim Editieren werden zusätzlich "." und Leerzeichen als
// Gruppierung toleriert, damit deutsche Eingabegewohnheiten nicht scheitern.
function parseEditableNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed.replace(/[.,\s]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function dayCellToEditText(cell: ProductionPlanDayCell): string {
  if (cell.kind === "portions") return String(cell.portions);
  if (cell.kind === "station") return cell.label;
  return "";
}

function editTextToDayCell(raw: string): ProductionPlanDayCell {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };
  if (/^-?[\d.,\s]+$/.test(trimmed)) {
    const n = parseEditableNumber(trimmed);
    if (n != null) return { kind: "portions", portions: n };
  }
  return { kind: "station", label: trimmed };
}

function StationBadges({ row }: { row: ProductionPlanRow }) {
  const active = STATION_KEYS.filter(s => row.stations[s.key]);
  if (!active.length) return <span className="text-slate-300">–</span>;
  return (
    <div className="flex flex-wrap justify-center gap-0.5">
      {active.map(s => (
        <span key={s.key} className="rounded px-1 py-px text-[9px] font-semibold bg-slate-100 text-slate-500">{s.label}</span>
      ))}
    </div>
  );
}

// Click-to-edit Tabellenzelle: zeigt `children` an, wechselt per Klick zu
// einem <input>, committet bei Enter/Blur, verwirft bei Escape. `state`
// steuert die Hervorhebung: "overridden" (amber + Reset-Button ↺, jemand hat
// die Zelle explizit bearbeitet) vs. "computed" (sky, App-seitig aus einer
// anderen bearbeiteten Zelle hergeleitet -- z.B. Ready nach Tages-Matrix-Edit
// -- kein eigener Reset, da nichts Eigenes zum Löschen existiert, siehe
// productionPlanOverrides.ts). Die eigentliche Diff-Logik liegt beim Aufrufer.
function EditableCell({
  editValue, children, align = "right", state = "none", onCommit, onReset, className = "", title,
}: {
  editValue: string;
  children: ReactNode;
  align?: "left" | "right" | "center";
  state?: "none" | "overridden" | "computed";
  onCommit: (raw: string) => void;
  onReset?: () => void;
  className?: string;
  title?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(editValue);
  const alignClass = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  const bgClass = state === "overridden" ? "bg-amber-50" : state === "computed" ? "bg-sky-50" : "";

  function commit() {
    setEditing(false);
    if (draft.trim() !== editValue.trim()) onCommit(draft);
  }

  if (editing) {
    return (
      <td className={`${className} p-0.5`}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setDraft(editValue); setEditing(false); }
          }}
          className="w-full min-w-[3.5rem] rounded border border-indigo-400 px-1 py-0.5 text-right text-[11px] tabular-nums focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />
      </td>
    );
  }

  const defaultTitle = state === "overridden" ? "Bearbeitet — weicht vom GSheet ab. Klick zum Ändern."
    : state === "computed" ? "Automatisch aus der bearbeiteten Tages-Matrix berechnet. Klick zum Überschreiben."
    : "Klick zum Bearbeiten";

  return (
    <td
      className={`group relative ${alignClass} cursor-text ${bgClass} ${className}`}
      onClick={() => { setDraft(editValue); setEditing(true); }}
      title={title ?? defaultTitle}
    >
      {children}
      {state === "overridden" && onReset && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onReset(); }}
          className="absolute -top-1 -right-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[8px] leading-none text-white group-hover:flex"
          title="Zurücksetzen auf GSheet-Wert"
        >
          ↺
        </button>
      )}
    </td>
  );
}

function GroupHeader({ label, span, borderStart = true }: { label: string; span: number; borderStart?: boolean }) {
  // Eigene bg-slate-900 statt Vererbung von <tr>: bei sticky Nachbarspalten
  // (Code/Meal) reicht die Zeilenfarbe allein nicht zuverlaessig bis an den
  // Zellenrand -- feine Textreste der Nachbarspalte blieben sonst sichtbar.
  return (
    <th colSpan={span} className={`bg-slate-900 px-2 py-1 text-center font-bold text-[10px] uppercase tracking-wide text-slate-300 ${borderStart ? "border-l border-slate-700" : ""}`}>
      {label}
    </th>
  );
}

export function ProductionPlanSheetTable({
  data, hfWeek, overrides, onSaveCell, onClearCell, forecastByCode, recipeProfilByCode,
}: {
  data: ProductionPlanData;
  hfWeek: string;
  overrides: ProductionPlanOverrideRows;
  onSaveCell: (code: string, patch: ProductionPlanRowOverride) => void;
  onClearCell: (code: string, fieldPath: string) => void;
  forecastByCode?: Map<string, ForecastRow>;
  recipeProfilByCode?: Map<string, RecipeProfilRow>;
}) {
  const totals = data.totals;

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* border-separate statt -collapse: bei border-collapse "bluten" nicht-
          sticky Zellen (Chromium) beim horizontalen Scrollen durch die sticky
          Code/Meal-Spalten hindurch. */}
      <table className="border-separate border-spacing-0 text-[11px] w-max">
        <thead>
          <tr className="bg-slate-900 text-white">
            <th rowSpan={2} className="sticky left-0 z-20 w-24 bg-slate-900 px-2 py-1.5 text-left font-bold">Code</th>
            <th rowSpan={2} className="sticky left-24 z-20 min-w-[12rem] bg-slate-900 px-2 py-1.5 text-left font-bold border-r border-slate-700">Meal</th>
            <GroupHeader label="Markt-Split" span={3} />
            <th rowSpan={2} className="bg-slate-900 px-2 py-1.5 text-right font-bold border-l border-slate-700 whitespace-nowrap">Total</th>
            <th rowSpan={2} className="bg-slate-900 px-2 py-1.5 text-right font-bold whitespace-nowrap">+Buffer</th>
            <GroupHeader label="Komplexität" span={5} />
            <th rowSpan={2} className="bg-slate-900 px-2 py-1.5 text-center font-bold border-l border-slate-700 whitespace-nowrap">Stationen</th>
            <GroupHeader label="Tages-Matrix" span={PRODUCTION_PLAN_DAYS.length} />
            <GroupHeader label="Ready" span={READY_DAYS.length} />
            <GroupHeader label="Min Needs" span={READY_DAYS.length} />
            <th rowSpan={2} className="bg-slate-900 px-2 py-1.5 text-left font-bold border-l border-slate-700">Allergene</th>
          </tr>
          <tr className="bg-slate-800 text-white text-[10px]">
            <th className="bg-slate-800 px-1.5 py-1 text-right font-semibold border-l border-slate-700">BENL</th>
            <th className="bg-slate-800 px-1.5 py-1 text-right font-semibold">NORD</th>
            <th className="bg-slate-800 px-1.5 py-1 text-right font-semibold">DE</th>
            <th className="bg-slate-800 px-1.5 py-1 text-right font-semibold border-l border-slate-700">Cplx</th>
            <th className="bg-slate-800 px-1.5 py-1 text-right font-semibold">Subs</th>
            <th className="bg-slate-800 px-1.5 py-1 text-right font-semibold">Stat.#</th>
            <th className="bg-slate-800 px-1.5 py-1 text-right font-semibold whitespace-nowrap">Aktiv Min</th>
            <th className="bg-slate-800 px-1.5 py-1 text-right font-semibold whitespace-nowrap">Passiv Min</th>
            {PRODUCTION_PLAN_DAYS.map((d, i) => (
              <th key={d} className={`bg-slate-800 px-1.5 py-1 font-semibold ${i === 0 ? "border-l border-slate-700" : ""}`}>
                {DAY_SHORT[d]}
                <div className="font-normal text-[8px] text-slate-400">{formatShortDate(hfWeekDayDate(hfWeek, d))}</div>
              </th>
            ))}
            {READY_DAYS.map((r, i) => (
              <th key={`ready-${r.key}`} className={`bg-slate-800 px-1.5 py-1 font-semibold ${i === 0 ? "border-l border-slate-700" : ""}`}>{DAY_SHORT[r.day]}</th>
            ))}
            {READY_DAYS.map((r, i) => (
              <th key={`min-${r.key}`} className={`bg-slate-800 px-1.5 py-1 font-semibold ${i === 0 ? "border-l border-slate-700" : ""}`}>{DAY_SHORT[r.day]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => {
            // Volldeckende Farben (kein bg-*/50) -- sonst "blutet" gescrollter
            // Inhalt bei sticky Code/Meal-Spalten durch die Zeilenfarbe durch.
            const rowBg = i % 2 === 0 ? "bg-white" : "bg-slate-50";
            const override = overrides[row.code];
            const effRow = mergeRowOverride(row, override);
            const mismatches = crossCheckProductionPlanRow(row, forecastByCode, recipeProfilByCode);
            return (
              <tr key={row.code} className={rowBg}>
                <td className={`sticky left-0 z-10 ${rowBg} px-2 py-1 font-mono text-slate-600 whitespace-nowrap`}>
                  {row.code}
                  {mismatches.length > 0 && (
                    <span
                      className="ml-1 inline-block cursor-help rounded-full bg-amber-400 px-1 align-middle text-[8px] font-bold text-white"
                      title={`Live-Check weicht vom Sheet ab:\n${mismatches.map(m => `${m.label}: Sheet=${m.sheetValue} · Live (${m.source})=${m.liveValue}`).join("\n")}`}
                    >
                      live
                    </span>
                  )}
                  {row.preference && <div className="text-[9px] font-sans font-semibold text-indigo-500">{row.preference}</div>}
                </td>
                <td className={`sticky left-24 z-10 ${rowBg} px-2 py-1 font-semibold text-slate-800 max-w-[16rem] truncate border-r border-slate-100`} title={row.recipeName}>
                  {row.recipeName}
                </td>
                <td className="px-1.5 py-1 text-right tabular-nums text-slate-600 border-l border-slate-100">{fmtNum(row.benl)}</td>
                <td className="px-1.5 py-1 text-right tabular-nums text-slate-600">{fmtNum(row.nordics)}</td>
                <td className="px-1.5 py-1 text-right tabular-nums text-slate-600">{fmtNum(row.de)}</td>
                <td className="px-2 py-1 text-right font-semibold tabular-nums text-slate-800 border-l border-slate-100">{fmtNum(row.total)}</td>
                <EditableCell
                  editValue={String(row.totalWithBuffer ?? "")}
                  align="right"
                  state={override?.totalWithBuffer != null ? "overridden" : "none"}
                  onCommit={(raw) => {
                    const n = parseEditableNumber(raw);
                    if (n != null) onSaveCell(row.code, { totalWithBuffer: n });
                  }}
                  onReset={() => onClearCell(row.code, "totalWithBuffer")}
                  className="px-2 py-1 font-bold tabular-nums text-slate-900"
                >
                  {fmtNum(effRow.totalWithBuffer)}
                </EditableCell>
                <td className="px-1.5 py-1 text-right tabular-nums text-slate-500 border-l border-slate-100">{fmtNum(row.complexityScore, 1)}</td>
                <td className="px-1.5 py-1 text-right tabular-nums text-slate-500">{fmtNum(row.subCount)}</td>
                <td className="px-1.5 py-1 text-right tabular-nums text-slate-500">{fmtNum(row.cookStationCount)}</td>
                <td className="px-1.5 py-1 text-right tabular-nums text-slate-500">{fmtNum(row.activeCookMin)}</td>
                <td className="px-1.5 py-1 text-right tabular-nums text-slate-500">{fmtNum(row.passiveHoldMin)}</td>
                <td className="px-2 py-1 border-l border-slate-100"><StationBadges row={row} /></td>
                {PRODUCTION_PLAN_DAYS.map((d, di) => {
                  const cell = effRow.byDay[d];
                  const borderClass = di === 0 ? "border-l border-slate-100" : "";
                  let content: ReactNode;
                  let kindClass = "px-1.5 py-1";
                  let align: "left" | "right" | "center" = "center";
                  if (cell.kind === "empty") {
                    content = <span className="text-slate-300">·</span>;
                  } else if (cell.kind === "station") {
                    content = <span className="text-[10px] font-bold text-sky-700">{cell.label}</span>;
                    kindClass += " bg-sky-50 whitespace-nowrap";
                  } else {
                    content = <span className="font-semibold text-slate-800 tabular-nums">{fmtNum(cell.portions)}</span>;
                    align = "right";
                  }
                  return (
                    <EditableCell
                      key={d}
                      editValue={dayCellToEditText(cell)}
                      align={align}
                      state={override?.byDay?.[d] != null ? "overridden" : "none"}
                      onCommit={(raw) => onSaveCell(row.code, { byDay: { [d]: editTextToDayCell(raw) } })}
                      onReset={() => onClearCell(row.code, `byDay.${d}`)}
                      className={`${kindClass} ${borderClass}`}
                    >
                      {content}
                    </EditableCell>
                  );
                })}
                {READY_DAYS.map((r, ri) => {
                  const readyOverridden = override?.readyByDay?.[r.key] != null;
                  const readyComputed = !readyOverridden && !!override?.byDay;
                  return (
                    <EditableCell
                      key={`ready-${r.key}`}
                      editValue={String(row.readyByDay[r.key] ?? "")}
                      align="right"
                      state={readyOverridden ? "overridden" : readyComputed ? "computed" : "none"}
                      onCommit={(raw) => {
                        const n = parseEditableNumber(raw);
                        if (n != null) onSaveCell(row.code, { readyByDay: { [r.key]: n } });
                      }}
                      onReset={() => onClearCell(row.code, `readyByDay.${r.key}`)}
                      className={`px-1.5 py-1 text-slate-600 ${ri === 0 ? "border-l border-slate-100" : ""}`}
                    >
                      {fmtNum(effRow.readyByDay[r.key])}
                    </EditableCell>
                  );
                })}
                {READY_DAYS.map((r, ri) => {
                  const value = effRow.minNeedsByDay[r.key];
                  const minNeedsOverridden = override?.minNeedsByDay?.[r.key] != null;
                  const minNeedsComputed = !minNeedsOverridden && (!!override?.byDay || override?.readyByDay?.[r.key] != null);
                  return (
                    <EditableCell
                      key={`min-${r.key}`}
                      editValue={String(row.minNeedsByDay[r.key] ?? "")}
                      align="right"
                      state={minNeedsOverridden ? "overridden" : minNeedsComputed ? "computed" : "none"}
                      onCommit={(raw) => {
                        const n = parseEditableNumber(raw);
                        if (n != null) onSaveCell(row.code, { minNeedsByDay: { [r.key]: n } });
                      }}
                      onReset={() => onClearCell(row.code, `minNeedsByDay.${r.key}`)}
                      className={`px-1.5 py-1 ${ri === 0 ? "border-l border-slate-100" : ""} ${value != null && value < 0 ? "text-rose-600 font-bold" : "text-slate-600"}`}
                    >
                      {fmtNum(value)}
                    </EditableCell>
                  );
                })}
                <EditableCell
                  editValue={row.allergens}
                  align="left"
                  state={override?.allergens != null ? "overridden" : "none"}
                  onCommit={(raw) => onSaveCell(row.code, { allergens: raw.trim() })}
                  onReset={() => onClearCell(row.code, "allergens")}
                  className="px-2 py-1 text-slate-500 max-w-[11rem] truncate border-l border-slate-100"
                  title={effRow.allergens || "–"}
                >
                  {effRow.allergens || "–"}
                </EditableCell>
              </tr>
            );
          })}
        </tbody>
        {totals && (
          <tfoot>
            <tr className="bg-indigo-50 border-t-2 border-indigo-200 font-black text-indigo-900">
              <td className="sticky left-0 z-10 bg-indigo-50 px-2 py-1.5">Wochensumme</td>
              <td className="sticky left-24 z-10 bg-indigo-50 px-2 py-1.5 border-r border-indigo-100" />
              <td className="px-1.5 py-1.5 text-right tabular-nums border-l border-indigo-100">{fmtNum(totals.benl)}</td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">{fmtNum(totals.nordics)}</td>
              <td className="px-1.5 py-1.5 text-right tabular-nums">{fmtNum(totals.de)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums border-l border-indigo-100">{fmtNum(totals.total)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{fmtNum(totals.totalWithBuffer)}</td>
              <td colSpan={TRAILING_COLSPAN} className="border-l border-indigo-100" />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
