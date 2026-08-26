// Frischeliste-Tab im KET Plan:
// Nur PHF-Frischware für wählbare Tage,
// gruppiert nach Mahlzeit + PTN, aufgeteilt in Veggie Debox / Protein Debox.
import { useState, useMemo } from "react";
import * as XLSX from "xlsx";
import type { KetRow, BatchCalc } from "./ketTypes";
import {
  buildFrischeliste,
  frischelisteToCsvString,
  frischelisteToCsvStringByPtn,
  buildFrischelistePdfHtml,
  buildFrischelistePdfHtmlByPtn,
  type FrischeMealGroup,
  type Frischeliste,
} from "./frischelisteLogic";

// Zyklische Farbpalette für Mahlzeiten-Gruppen
const MEAL_COLORS = [
  "bg-blue-100/80 border-blue-200 text-blue-900",
  "bg-teal-100/80 border-teal-200 text-teal-900",
  "bg-violet-100/80 border-violet-200 text-violet-900",
  "bg-amber-100/80 border-amber-200 text-amber-900",
  "bg-rose-100/80 border-rose-200 text-rose-900",
  "bg-emerald-100/80 border-emerald-200 text-emerald-900",
  "bg-orange-100/80 border-orange-200 text-orange-900",
  "bg-cyan-100/80 border-cyan-200 text-cyan-900",
];

// Passende Zutaten-Zeilen-Farbe zur Header-Farbe
const ROW_COLORS = [
  "bg-blue-50/50",
  "bg-teal-50/50",
  "bg-violet-50/50",
  "bg-amber-50/50",
  "bg-rose-50/50",
  "bg-emerald-50/50",
  "bg-orange-50/50",
  "bg-cyan-50/50",
];

interface Props {
  rows: KetRow[];
  calcMap: Map<string, BatchCalc>;
  weekLabel: string;
}

export function KetFrischelistePanel({ rows, calcMap, weekLabel }: Props) {
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([0, 1]);

  const liste: Frischeliste = useMemo(
    () => buildFrischeliste(rows, calcMap, selectedWeekdays),
    [rows, calcMap, selectedWeekdays],
  );

  const availableDays = liste.availableDays;

  useMemo(() => {
    if (availableDays.length === 0) return;
    const inPlan = selectedWeekdays.filter((d) => availableDays.some((a) => a.weekday === d));
    if (inPlan.length === 0) {
      setSelectedWeekdays(availableDays.map((d) => d.weekday));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableDays.length]);

  function toggleDay(wd: number) {
    setSelectedWeekdays((prev) =>
      prev.includes(wd) ? prev.filter((d) => d !== wd) : [...prev, wd].sort(),
    );
  }

  const dayLabel = availableDays
    .filter((d) => selectedWeekdays.includes(d.weekday))
    .map((d) => d.label)
    .join(", ") || "–";

  function downloadCsv(ptnMode = false) {
    const csv = ptnMode
      ? frischelisteToCsvStringByPtn(liste, weekLabel, dayLabel)
      : frischelisteToCsvString(liste, weekLabel, dayLabel);
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ptnMode
      ? `${weekLabel}_PHF-Frischeliste-PTN.csv`
      : `${weekLabel}_PHF-Frischeliste.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadExcel(ptnMode = false) {
    const wb = XLSX.utils.book_new();

    function makeMealSheet(groups: FrischeMealGroup[], dept: string) {
      const sheetRows: (string | number)[][] = [
        [`PHF-Frischeliste ${weekLabel} – ${dept} – ${dayLabel}`],
        ["PTN", "Mahlzeit", "Artikel", "Menge (kg)", "WOs"],
      ];
      for (const g of groups) {
        for (const item of g.items) {
          sheetRows.push([g.portions, g.mealName, item.name, parseFloat(item.totalKg.toFixed(2)), item.woNumbers.join(", ")]);
        }
        sheetRows.push(["", "", "GESAMT Mahlzeit", parseFloat(g.totalKg.toFixed(2)), ""]);
      }
      const ws = XLSX.utils.aoa_to_sheet(sheetRows);
      ws["!cols"] = [{ wch: 6 }, { wch: 48 }, { wch: 42 }, { wch: 12 }, { wch: 25 }];
      return ws;
    }

    function makePtnSheet(groups: FrischeMealGroup[], dept: string) {
      const sorted = [...groups].sort((a, b) => a.portions - b.portions || b.totalKg - a.totalKg);
      const sheetRows: (string | number)[][] = [
        [`PHF-Frischeliste ${weekLabel} – ${dept} – ${dayLabel} – nach PTN`],
        ["PTN", "Mahlzeit", "Artikel", "Menge (kg)", "WOs"],
      ];
      let lastPtn = -1;
      for (const g of sorted) {
        if (g.portions !== lastPtn) {
          sheetRows.push([`=== ${g.portions} Portionen ===`, "", "", "", ""]);
          lastPtn = g.portions;
        }
        for (const item of g.items) {
          sheetRows.push([g.portions, g.mealName, item.name, parseFloat(item.totalKg.toFixed(2)), item.woNumbers.join(", ")]);
        }
        sheetRows.push(["", "", `Gesamt ${g.mealName}`, parseFloat(g.totalKg.toFixed(2)), ""]);
      }
      const ws = XLSX.utils.aoa_to_sheet(sheetRows);
      ws["!cols"] = [{ wch: 6 }, { wch: 48 }, { wch: 42 }, { wch: 12 }, { wch: 25 }];
      return ws;
    }

    if (ptnMode) {
      XLSX.utils.book_append_sheet(wb, makePtnSheet(liste.protein, "Protein Debox"), "Protein PTN");
      XLSX.utils.book_append_sheet(wb, makePtnSheet(liste.veggie, "Veggie Debox"), "Veggie PTN");
      XLSX.writeFile(wb, `${weekLabel}_PHF-Frischeliste-PTN.xlsx`);
    } else {
      XLSX.utils.book_append_sheet(wb, makeMealSheet(liste.protein, "Protein Debox"), "Protein Debox");
      XLSX.utils.book_append_sheet(wb, makeMealSheet(liste.veggie, "Veggie Debox"), "Veggie Debox");
      XLSX.writeFile(wb, `${weekLabel}_PHF-Frischeliste.xlsx`);
    }
  }

  function openPreview(ptnMode = false) {
    const html = ptnMode
      ? buildFrischelistePdfHtmlByPtn(liste, weekLabel, dayLabel)
      : buildFrischelistePdfHtml(liste, weekLabel, dayLabel);
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
  }

  const totalProtein = liste.protein.reduce((s, g) => s + g.totalKg, 0);
  const totalVeggie  = liste.veggie.reduce((s, g) => s + g.totalKg, 0);
  const isEmpty = liste.protein.length === 0 && liste.veggie.length === 0;

  return (
    <div className="flex flex-col h-full min-h-0 bg-white">
      {/* Toolbar */}
      <div className="shrink-0 px-5 pt-4 pb-3 border-b border-slate-100 bg-slate-50">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">
              Tage
            </div>
            <div className="flex flex-wrap gap-1.5">
              {availableDays.length === 0 ? (
                <span className="text-xs text-slate-400">Keine Daten</span>
              ) : (
                availableDays.map((day) => {
                  const active = selectedWeekdays.includes(day.weekday);
                  return (
                    <button
                      key={day.weekday}
                      type="button"
                      onClick={() => toggleDay(day.weekday)}
                      className={`text-[10px] font-bold px-2.5 py-1.5 rounded-lg border transition-colors ${
                        active
                          ? "bg-[#1e3a5f] text-white border-[#1e3a5f]"
                          : "bg-white text-slate-500 border-slate-200 hover:border-blue-300 hover:text-blue-700"
                      }`}
                    >
                      {day.label}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Export-Gruppen */}
          <div className="flex flex-col gap-1.5 shrink-0">
            {/* PHF nach Mahlzeit */}
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 w-8 shrink-0">PHF</span>
              <button
                type="button"
                onClick={() => downloadCsv(false)}
                disabled={isEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700 transition-colors disabled:opacity-40"
              >CSV</button>
              <button
                type="button"
                onClick={() => downloadExcel(false)}
                disabled={isEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors disabled:opacity-40"
              >Excel</button>
              <button
                type="button"
                onClick={() => openPreview(false)}
                disabled={isEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40"
              >Vorschau</button>
            </div>
            {/* PHF nach PTN */}
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 w-8 shrink-0">PTN</span>
              <button
                type="button"
                onClick={() => downloadCsv(true)}
                disabled={isEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700 transition-colors disabled:opacity-40"
              >CSV</button>
              <button
                type="button"
                onClick={() => downloadExcel(true)}
                disabled={isEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors disabled:opacity-40"
              >Excel</button>
              <button
                type="button"
                onClick={() => openPreview(true)}
                disabled={isEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors disabled:opacity-40"
              >Vorschau</button>
            </div>
          </div>
        </div>
      </div>

      {/* Content: two columns */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400">
            <div className="text-3xl mb-3">🥗</div>
            <div className="text-sm font-semibold">Keine PHF-Frischware für die gewählten Tage</div>
            <div className="text-xs mt-1">Tage auswählen, für die Daten vorliegen</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-5">
            {/* Protein */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-base">🥩</span>
                  <span className="text-xs font-black text-red-800 uppercase tracking-wide">
                    Protein Debox
                  </span>
                  <span className="text-[10px] font-bold text-red-600 bg-red-50 border border-red-100 px-2 py-0.5 rounded-full">
                    {liste.protein.length} Mahlzeiten
                  </span>
                </div>
                <span className="text-[10px] font-bold text-slate-500">
                  {totalProtein.toFixed(1)} kg PHF
                </span>
              </div>
              <MealGroupList groups={liste.protein} />
            </div>

            {/* Veggie */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-base">🥦</span>
                  <span className="text-xs font-black text-green-800 uppercase tracking-wide">
                    Veggie Debox
                  </span>
                  <span className="text-[10px] font-bold text-green-600 bg-green-50 border border-green-100 px-2 py-0.5 rounded-full">
                    {liste.veggie.length} Mahlzeiten
                  </span>
                </div>
                <span className="text-[10px] font-bold text-slate-500">
                  {totalVeggie.toFixed(1)} kg PHF
                </span>
              </div>
              <MealGroupList groups={liste.veggie} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MealGroupList({ groups }: { groups: FrischeMealGroup[] }) {
  if (!groups.length) {
    return <p className="text-xs text-slate-400 py-4 text-center">Keine PHF-Einträge</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g, idx) => (
        <MealGroupSection key={`${g.mealName}__${g.portions}`} group={g} colorIdx={idx} />
      ))}
    </div>
  );
}

function MealGroupSection({ group, colorIdx }: { group: FrischeMealGroup; colorIdx: number }) {
  const headerCls = MEAL_COLORS[colorIdx % MEAL_COLORS.length];
  const rowAccent = ROW_COLORS[colorIdx % ROW_COLORS.length];

  return (
    <div>
      {/* Mahlzeit-Header */}
      <div className={`flex items-center justify-between px-3 py-1.5 border border-b-0 rounded-t-lg ${headerCls}`}>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[11px] font-bold truncate">{group.mealName}</span>
          {group.portions > 0 && (
            <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded bg-black/10">
              {group.portions} PTN
            </span>
          )}
        </div>
        <span className="text-[10px] font-bold whitespace-nowrap ml-2 opacity-80">
          {group.totalKg.toFixed(1)} kg
        </span>
      </div>
      {/* Zutaten-Tabelle */}
      <div className="rounded-b-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-xs">
          <tbody>
            {group.items.map((item, idx) => (
              <tr
                key={item.name}
                className={`border-b border-slate-100 last:border-0 ${idx % 2 === 0 ? "bg-white" : rowAccent}`}
              >
                <td className="px-3 py-1.5 font-medium text-slate-800">{item.name}</td>
                <td className="px-3 py-1.5 text-right font-bold tabular-nums text-slate-700 whitespace-nowrap">
                  {item.totalKg.toFixed(2)} kg
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
