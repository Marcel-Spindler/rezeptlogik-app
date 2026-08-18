// GSheet-kompatible Plating-Plan-Tabelle (LinePlating W{XX} Stil).
// Darstellung + TSV-Export für Copy-Paste in Google Sheets.
import { useRef } from "react";
import { DAYS, type PlanDay, type ScheduleMap } from "./linePlanningDomain";
import { portionsInSlotByLineCapacity } from "./linePlanningLogic";

// GSheet verwendet 30-Min-Intervalle von 06:00 bis 15:00
const SHEET_SLOTS = [
  "06:00 - 06:30", "06:30 - 07:00", "07:00 - 07:30", "07:30 - 08:00",
  "08:00 - 08:30", "08:30 - 09:00", "09:00 - 09:30", "09:30 - 10:00",
  "10:00 - 10:30", "10:30 - 11:00", "11:00 - 11:30", "11:30 - 12:00",
  "12:00 - 12:30", "12:30 - 13:00", "13:00 - 13:30", "13:30 - 14:00",
  "14:00 - 14:30", "14:30 - 15:00",
];

const BREAK_SLOTS = new Set(["08:30 - 09:00", "11:30 - 12:00"]);
const PREP_SLOT = "06:00 - 06:30";
const CLEAN_SLOT = "14:30 - 15:00";

type SheetRow = {
  day: string;
  comms: string;
  time: string;
  line1: string;
  line2: string;
  line3: string;
  cupping: string;
  amount: string;
  run: string;
  code: string;
  meal: string;
  planned: string;
  comment: string;
};

function mapScheduleToSheet(
  schedule: ScheduleMap,
  lineCapacity: Record<string, number>,
  comments: Record<string, string>,
  dayLineCount: Record<PlanDay, number>,
  cuppingBySlot?: Record<string, string>,
): SheetRow[] {
  const rows: SheetRow[] = [];

  for (const day of DAYS) {
    const linesActive = dayLineCount[day] ?? 3;
    // Header row
    rows.push({
      day: "", comms: "Comms", time: "",
      line1: "Line 1", line2: "Line 2", line3: "Line 3",
      cupping: "Cupping/Slicing", amount: "Amount", run: "Run",
      code: "Code", meal: "Meal", planned: "Planned", comment: "Comment",
    });

    for (let si = 0; si < SHEET_SLOTS.length; si++) {
      const slotLabel = SHEET_SLOTS[si];
      const isBreak = BREAK_SLOTS.has(slotLabel);
      const isPrep = slotLabel === PREP_SLOT;
      const isClean = slotLabel === CLEAN_SLOT;

      // Map 30-min sheet slot → 60-min schedule slot
      const hour = parseInt(slotLabel.slice(0, 2), 10);
      const schedSlotKey = `${String(hour).padStart(2, "0")}:00-${String(hour + 1).padStart(2, "0")}:00`;

      const lineNames: string[] = [];
      for (let li = 0; li < 3; li++) {
        if (li >= linesActive) { lineNames.push(""); continue; }
        const cellKey = `${day}|${schedSlotKey}|${li}`;
        const recipe = schedule[cellKey];
        if (isBreak) {
          lineNames.push(li === 0 ? "30 min Break / Full Changeover" : "30 min Break");
        } else if (isPrep) {
          lineNames.push("Prepping");
        } else if (isClean) {
          lineNames.push("Clean Line");
        } else if (recipe) {
          lineNames.push(recipe.isBreak ? "Changeover" : recipe.name);
        } else {
          lineNames.push("");
        }
      }

      // Aggregate recipe info for the righthand columns
      let code = "";
      let meal = "";
      let planned = "";
      let amount = "";
      for (let li = 0; li < Math.min(3, linesActive); li++) {
        const cellKey = `${day}|${schedSlotKey}|${li}`;
        const r = schedule[cellKey];
        if (r && !r.isBreak && !code) {
          code = r.code;
          meal = r.name;
          const cap = lineCapacity[String(li)] ?? 0;
          planned = String(Math.round(portionsInSlotByLineCapacity(cap, schedSlotKey)));
          amount = String(r.totalPlanned);
        }
      }

      const slotComment = comments[`${day}|${schedSlotKey}`] ?? "";
      const cupValue = cuppingBySlot?.[`${day}|${schedSlotKey}`] ?? "";

      rows.push({
        day: si === 0 ? day : "",
        comms: isBreak ? "Break" : isPrep ? "Prep Line" : isClean ? "Clean Line" : "",
        time: slotLabel,
        line1: lineNames[0] ?? "",
        line2: lineNames[1] ?? "",
        line3: lineNames[2] ?? "",
        cupping: cupValue,
        amount,
        run: "",
        code,
        meal,
        planned,
        comment: slotComment,
      });
    }
  }

  return rows;
}

function rowsToTsv(rows: SheetRow[]): string {
  const headers = ["Day", "Comms", "Time", "P-Line 1", "P-Line 2", "P-Line 3", "Cupping/Slicing", "Amount", "Run", "Code", "Meal", "Planned", "Comment"];
  const lines = [headers.join("\t")];
  for (const r of rows) {
    lines.push([r.day, r.comms, r.time, r.line1, r.line2, r.line3, r.cupping, r.amount, r.run, r.code, r.meal, r.planned, r.comment].join("\t"));
  }
  return lines.join("\n");
}

export function LinePlatingSheet({
  schedule,
  lineCapacity,
  comments,
  dayLineCount,
  week,
  cuppingBySlot,
}: {
  schedule: ScheduleMap;
  lineCapacity: Record<string, number>;
  comments: Record<string, string>;
  dayLineCount: Record<PlanDay, number>;
  week: string;
  cuppingBySlot?: Record<string, string>;
}) {
  const tableRef = useRef<HTMLTableElement>(null);
  const rows = mapScheduleToSheet(schedule, lineCapacity, comments, dayLineCount, cuppingBySlot);

  const handleCopyTsv = () => {
    const tsv = rowsToTsv(rows);
    void navigator.clipboard.writeText(tsv).then(() => {
      alert("Tabelle in Zwischenablage kopiert – direkt in Google Sheets einfügen!");
    });
  };

  const handleCopyHtml = () => {
    if (!tableRef.current) return;
    const range = document.createRange();
    range.selectNode(tableRef.current);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand("copy");
    sel?.removeAllRanges();
    alert("Tabelle als formatierte Zellen kopiert!");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-black text-slate-800">LinePlating W{week.split("-W")[1] ?? week}</h3>
        <div className="flex gap-2">
          <button
            onClick={handleCopyTsv}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
          >
            📋 TSV kopieren (GSheets)
          </button>
          <button
            onClick={handleCopyHtml}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
          >
            📋 Tabelle kopieren
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table ref={tableRef} className="w-full text-[11px] border-collapse">
          <thead className="bg-slate-100 sticky top-0">
            <tr>
              {["Day", "Comms", "Time", "P-Line 1", "P-Line 2", "P-Line 3", "Cupping/Slicing", "Amount", "Run", "Code", "Meal", "Planned", "Comment"].map(h => (
                <th key={h} className="px-2 py-1.5 text-left font-bold text-slate-600 border-b border-slate-200 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isHeader = r.comms === "Comms" && r.line1 === "Line 1";
              const isBreak = r.comms === "Break";
              const isPrep = r.comms === "Prep Line";
              const isClean = r.comms === "Clean Line";
              const dayStart = r.day !== "";

              if (isHeader) {
                return (
                  <tr key={i} className="bg-indigo-50 border-t-2 border-indigo-200">
                    <td className="px-2 py-1.5 font-black text-indigo-900 text-sm" colSpan={13}>
                      {DAYS[Math.floor(rows.slice(0, i).filter(x => x.comms === "Comms" && x.line1 === "Line 1").length)] ?? ""}
                    </td>
                  </tr>
                );
              }

              const bgClass = isBreak
                ? "bg-amber-50"
                : isPrep
                  ? "bg-sky-50"
                  : isClean
                    ? "bg-rose-50"
                    : i % 2 === 0
                      ? "bg-white"
                      : "bg-slate-50/50";

              return (
                <tr key={i} className={`${bgClass} ${dayStart ? "border-t border-slate-200" : ""}`}>
                  <td className="px-2 py-1 font-bold text-slate-800 whitespace-nowrap">{r.day}</td>
                  <td className={`px-2 py-1 whitespace-nowrap ${isBreak ? "font-bold text-amber-700" : isPrep ? "font-bold text-sky-700" : isClean ? "font-bold text-rose-700" : "text-slate-500"}`}>{r.comms}</td>
                  <td className="px-2 py-1 font-mono text-slate-600 whitespace-nowrap">{r.time}</td>
                  <td className={`px-2 py-1 max-w-[12rem] truncate ${r.line1 && !isBreak ? "font-semibold text-slate-800" : "text-slate-400"}`} title={r.line1}>{r.line1}</td>
                  <td className={`px-2 py-1 max-w-[12rem] truncate ${r.line2 && !isBreak ? "font-semibold text-slate-800" : "text-slate-400"}`} title={r.line2}>{r.line2}</td>
                  <td className={`px-2 py-1 max-w-[12rem] truncate ${r.line3 && !isBreak ? "font-semibold text-slate-800" : "text-slate-400"}`} title={r.line3}>{r.line3}</td>
                  <td className="px-2 py-1 text-slate-500">{r.cupping}</td>
                  <td className="px-2 py-1 text-right font-semibold text-slate-700 tabular-nums">{r.amount}</td>
                  <td className="px-2 py-1 text-center font-bold text-indigo-700">{r.run}</td>
                  <td className="px-2 py-1 font-mono font-bold text-slate-800">{r.code}</td>
                  <td className="px-2 py-1 max-w-[14rem] truncate text-slate-700" title={r.meal}>{r.meal}</td>
                  <td className="px-2 py-1 text-right font-semibold text-slate-700 tabular-nums">{r.planned}</td>
                  <td className="px-2 py-1 text-slate-500 max-w-[10rem] truncate" title={r.comment}>{r.comment}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
