// Frischeliste-Tab im KET Plan:
// V1: Zwei Ansichten: Küche (nach Mahlzeit gruppiert) und Einkauf (Gesamtmengen je Zutat).
//     Plus: Middle-Kitchen-Vorschau für Spezial-Artikel (componentlose WOs) der Folge-KW.
// V2: Frischeliste 2.0 – Live Google Sheets + Rezept-Daten, alle Stationen, Tag-Spalten.
import { useState, useMemo } from "react";
import type { DataBundle } from "../../core/types";
import type { KetRow, BatchCalc } from "./ketTypes";
import { FrischelisteV2Panel } from "./FrischelisteV2Panel";
import {
  buildFrischeliste,
  buildFrischelisteEinkauf,
  buildSpezialArtikelWeek,
  frischelisteToCsvString,
  frischelisteToCsvStringByPtn,
  buildFrischelistePdfHtml,
  buildFrischelistePdfHtmlByPtn,
  type FrischeMealGroup,
  type Frischeliste,
  type FrischeIngredientTotal,
  type FrischelisteEinkauf,
  type SpezialArtikelSummary,
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
const ROW_COLORS = [
  "bg-blue-50/50", "bg-teal-50/50", "bg-violet-50/50", "bg-amber-50/50",
  "bg-rose-50/50", "bg-emerald-50/50", "bg-orange-50/50", "bg-cyan-50/50",
];

interface Props {
  rows: KetRow[];           // aktuelle KW (weekFilteredRows)
  nextWeekRows: KetRow[];   // Folge-KW (für Middle Kitchen Spezial-Artikel)
  calcMap: Map<string, BatchCalc>;
  weekLabel: string;
  data: DataBundle;         // für Frischeliste 2.0
}

type TabMode = "v1" | "v2";
type ViewMode = "kueche" | "einkauf";

export function KetFrischelistePanel({ rows, nextWeekRows, calcMap, weekLabel, data }: Props) {
  const [tabMode, setTabMode] = useState<TabMode>("v1");
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([0, 1]);
  const [viewMode, setViewMode] = useState<ViewMode>("kueche");
  const [spezialOpen, setSpezialOpen] = useState(true);

  // ── Küche-Daten ────────────────────────────────────────────────────────────
  const liste: Frischeliste = useMemo(
    () => buildFrischeliste(rows, calcMap, selectedWeekdays),
    [rows, calcMap, selectedWeekdays],
  );

  // ── Einkauf-Daten ──────────────────────────────────────────────────────────
  const einkauf: FrischelisteEinkauf = useMemo(
    () => buildFrischelisteEinkauf(rows, calcMap, selectedWeekdays),
    [rows, calcMap, selectedWeekdays],
  );

  // ── Middle Kitchen / Spezial-Artikel (ganze Folge-KW, keine Tagesfilterung) ─
  const spezial: SpezialArtikelSummary = useMemo(
    () => buildSpezialArtikelWeek(nextWeekRows, calcMap),
    [nextWeekRows, calcMap],
  );
  const hasSpezial = spezial.protein.length > 0 || spezial.veggie.length > 0;

  const availableDays = liste.availableDays;

  useMemo(() => {
    if (availableDays.length === 0) return;
    const inPlan = selectedWeekdays.filter((d) => availableDays.some((a) => a.weekday === d));
    if (inPlan.length === 0) setSelectedWeekdays(availableDays.map((d) => d.weekday));
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

  // ── Exports Küche ──────────────────────────────────────────────────────────
  function downloadCsv(ptnMode = false) {
    const csv = ptnMode
      ? frischelisteToCsvStringByPtn(liste, weekLabel, dayLabel)
      : frischelisteToCsvString(liste, weekLabel, dayLabel);
    triggerDownload(
      "﻿" + csv,
      "text/csv;charset=utf-8;",
      ptnMode ? `${weekLabel}_PHF-Frischeliste-PTN.csv` : `${weekLabel}_PHF-Frischeliste.csv`,
    );
  }

  async function downloadExcel(ptnMode = false) {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    if (ptnMode) {
      XLSX.utils.book_append_sheet(wb, makePtnSheet(XLSX, liste.protein, "Protein Debox"), "Protein PTN");
      XLSX.utils.book_append_sheet(wb, makePtnSheet(XLSX, liste.veggie, "Veggie Debox"), "Veggie PTN");
      XLSX.writeFile(wb, `${weekLabel}_PHF-Frischeliste-PTN.xlsx`);
    } else {
      XLSX.utils.book_append_sheet(wb, makeMealSheet(XLSX, liste.protein, "Protein Debox"), "Protein Debox");
      XLSX.utils.book_append_sheet(wb, makeMealSheet(XLSX, liste.veggie, "Veggie Debox"), "Veggie Debox");
      XLSX.writeFile(wb, `${weekLabel}_PHF-Frischeliste.xlsx`);
    }
  }

  function mealGroupToRows(g: FrischeMealGroup): (string | number)[][] {
    const rows: (string | number)[][] = [];
    if (g.components.length > 0) {
      for (const comp of g.components) {
        for (const item of comp.items) {
          rows.push([g.portions, g.mealName, comp.componentName, item.name, parseFloat(item.totalKg.toFixed(2)), item.woNumbers.join(", ")]);
        }
        rows.push(["", "", `↳ Gesamt ${comp.componentName}`, "", parseFloat(comp.totalKg.toFixed(2)), ""]);
      }
    } else {
      for (const item of g.items) {
        rows.push([g.portions, g.mealName, "", item.name, parseFloat(item.totalKg.toFixed(2)), item.woNumbers.join(", ")]);
      }
    }
    rows.push(["", "", "", "GESAMT Mahlzeit", parseFloat(g.totalKg.toFixed(2)), ""]);
    return rows;
  }

  function makeMealSheet(XLSX: typeof import("xlsx"), groups: FrischeMealGroup[], dept: string) {
    const sheetRows: (string | number)[][] = [
      [`PHF-Frischeliste ${weekLabel} – ${dept} – ${dayLabel}`],
      ["PTN", "Mahlzeit", "Komponente", "Artikel", "Menge (kg)", "WOs"],
    ];
    for (const g of groups) sheetRows.push(...mealGroupToRows(g));
    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    ws["!cols"] = [{ wch: 6 }, { wch: 40 }, { wch: 35 }, { wch: 38 }, { wch: 12 }, { wch: 22 }];
    return ws;
  }

  function makePtnSheet(XLSX: typeof import("xlsx"), groups: FrischeMealGroup[], dept: string) {
    const sorted = [...groups].sort((a, b) => a.portions - b.portions || b.totalKg - a.totalKg);
    const sheetRows: (string | number)[][] = [
      [`PHF-Frischeliste ${weekLabel} – ${dept} – ${dayLabel} – nach PTN`],
      ["PTN", "Mahlzeit", "Komponente", "Artikel", "Menge (kg)", "WOs"],
    ];
    let lastPtn = -1;
    for (const g of sorted) {
      if (g.portions !== lastPtn) {
        sheetRows.push([`=== ${g.portions} Portionen ===`, "", "", "", "", ""]);
        lastPtn = g.portions;
      }
      sheetRows.push(...mealGroupToRows(g));
    }
    const ws = XLSX.utils.aoa_to_sheet(sheetRows);
    ws["!cols"] = [{ wch: 6 }, { wch: 40 }, { wch: 35 }, { wch: 38 }, { wch: 12 }, { wch: 22 }];
    return ws;
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

  // ── Exports Einkauf ────────────────────────────────────────────────────────
  function downloadEinkaufCsv() {
    const lines = [
      `# PHF-Gesamtübersicht Einkauf ${weekLabel} – ${dayLabel}`,
      "Abteilung,Artikel,Menge (kg),WOs",
    ];
    for (const item of einkauf.protein) {
      lines.push(`Protein Debox,"${item.name.replace(/"/g, '""')}",${item.totalKg.toFixed(2)},${item.woCount}`);
    }
    for (const item of einkauf.veggie) {
      lines.push(`Veggie Debox,"${item.name.replace(/"/g, '""')}",${item.totalKg.toFixed(2)},${item.woCount}`);
    }
    triggerDownload("﻿" + lines.join("\n"), "text/csv;charset=utf-8;", `${weekLabel}_PHF-Einkauf.csv`);
  }

  async function downloadEinkaufExcel() {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    function makeSheet(items: FrischeIngredientTotal[], dept: string) {
      const sheetRows: (string | number)[][] = [
        [`PHF-Gesamtübersicht Einkauf ${weekLabel} – ${dept} – ${dayLabel}`],
        ["Artikel", "Menge (kg)", "WO-Anzahl"],
      ];
      for (const item of items) {
        sheetRows.push([item.name, parseFloat(item.totalKg.toFixed(2)), item.woCount]);
      }
      sheetRows.push(["GESAMT", parseFloat(items.reduce((s, i) => s + i.totalKg, 0).toFixed(2)), ""]);
      const ws = XLSX.utils.aoa_to_sheet(sheetRows);
      ws["!cols"] = [{ wch: 50 }, { wch: 14 }, { wch: 12 }];
      return ws;
    }
    XLSX.utils.book_append_sheet(wb, makeSheet(einkauf.protein, "Protein Debox"), "Protein Debox");
    XLSX.utils.book_append_sheet(wb, makeSheet(einkauf.veggie, "Veggie Debox"), "Veggie Debox");
    XLSX.writeFile(wb, `${weekLabel}_PHF-Einkauf.xlsx`);
  }

  // ── Spezial-Artikel Export ─────────────────────────────────────────────────
  async function downloadSpezialExcel() {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    function makeSheet(items: FrischeIngredientTotal[], dept: string) {
      const sheetRows: (string | number)[][] = [
        [`Middle Kitchen – Spezial-Artikel Folge-KW – ${dept}`],
        ["Artikel", "Menge (kg)", "WO-Anzahl"],
      ];
      for (const item of items) {
        sheetRows.push([item.name, parseFloat(item.totalKg.toFixed(2)), item.woCount]);
      }
      sheetRows.push(["GESAMT", parseFloat(items.reduce((s, i) => s + i.totalKg, 0).toFixed(2)), ""]);
      const ws = XLSX.utils.aoa_to_sheet(sheetRows);
      ws["!cols"] = [{ wch: 50 }, { wch: 14 }, { wch: 12 }];
      return ws;
    }
    if (spezial.protein.length) XLSX.utils.book_append_sheet(wb, makeSheet(spezial.protein, "Protein Debox"), "Protein Debox");
    if (spezial.veggie.length)  XLSX.utils.book_append_sheet(wb, makeSheet(spezial.veggie, "Veggie Debox"), "Veggie Debox");
    XLSX.writeFile(wb, `Folge-KW_Middle-Kitchen-Spezial.xlsx`);
  }

  // ── Shared ─────────────────────────────────────────────────────────────────
  function triggerDownload(content: string, mime: string, filename: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const isEmpty = liste.protein.length === 0 && liste.veggie.length === 0;
  const einkaufIsEmpty = einkauf.protein.length === 0 && einkauf.veggie.length === 0;

  return (
    <div className="flex flex-col h-full min-h-0 bg-white">
      {/* ── Tab-Umschalter V1 / V2 ── */}
      <div className="shrink-0 flex gap-0 border-b border-slate-200 bg-white px-5 pt-2">
        <button
          type="button"
          onClick={() => setTabMode("v1")}
          className={`px-4 py-2 text-[11px] font-black uppercase tracking-wide border-b-2 transition-colors ${
            tabMode === "v1"
              ? "border-[#1e3a5f] text-[#1e3a5f]"
              : "border-transparent text-slate-400 hover:text-slate-600"
          }`}
        >
          V1 · WMS / Work Orders
        </button>
        <button
          type="button"
          onClick={() => setTabMode("v2")}
          className={`px-4 py-2 text-[11px] font-black uppercase tracking-wide border-b-2 transition-colors ${
            tabMode === "v2"
              ? "border-emerald-600 text-emerald-700"
              : "border-transparent text-slate-400 hover:text-slate-600"
          }`}
        >
          V2 · Frischeliste 2.0 · Live Sheet
        </button>
      </div>

      {/* ── Frischeliste 2.0 ── */}
      {tabMode === "v2" && (
        <div className="flex-1 min-h-0">
          <FrischelisteV2Panel data={data} weekLabel={weekLabel} />
        </div>
      )}

      {/* ── V1 ── */}
      {tabMode === "v1" && <>
      {/* ── Toolbar ── */}
      <div className="shrink-0 px-5 pt-4 pb-3 border-b border-slate-100 bg-slate-50">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/* Tage + View-Toggle */}
          <div className="flex flex-col gap-2">
            <div>
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1.5">Tage</div>
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
            {/* View-Toggle */}
            <div className="flex items-center gap-1">
              <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mr-1">Ansicht</div>
              <button
                type="button"
                onClick={() => setViewMode("kueche")}
                className={`text-[10px] font-bold px-3 py-1.5 rounded-lg border transition-colors ${
                  viewMode === "kueche"
                    ? "bg-[#1e3a5f] text-white border-[#1e3a5f]"
                    : "bg-white text-slate-500 border-slate-200 hover:border-blue-300 hover:text-blue-700"
                }`}
              >
                Küche (nach Mahlzeit)
              </button>
              <button
                type="button"
                onClick={() => setViewMode("einkauf")}
                className={`text-[10px] font-bold px-3 py-1.5 rounded-lg border transition-colors ${
                  viewMode === "einkauf"
                    ? "bg-emerald-700 text-white border-emerald-700"
                    : "bg-white text-slate-500 border-slate-200 hover:border-emerald-400 hover:text-emerald-700"
                }`}
              >
                Einkauf (Gesamtübersicht)
              </button>
            </div>
          </div>

          {/* Export-Buttons */}
          {viewMode === "kueche" ? (
            <div className="flex flex-col gap-1.5 shrink-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 w-8 shrink-0">PHF</span>
                <button type="button" onClick={() => downloadCsv(false)} disabled={isEmpty}
                  className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700 transition-colors disabled:opacity-40">CSV</button>
                <button type="button" onClick={() => downloadExcel(false)} disabled={isEmpty}
                  className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors disabled:opacity-40">Excel</button>
                <button type="button" onClick={() => openPreview(false)} disabled={isEmpty}
                  className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-40">Vorschau</button>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-400 w-8 shrink-0">PTN</span>
                <button type="button" onClick={() => downloadCsv(true)} disabled={isEmpty}
                  className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700 transition-colors disabled:opacity-40">CSV</button>
                <button type="button" onClick={() => downloadExcel(true)} disabled={isEmpty}
                  className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors disabled:opacity-40">Excel</button>
                <button type="button" onClick={() => openPreview(true)} disabled={isEmpty}
                  className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors disabled:opacity-40">Vorschau</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 shrink-0">
              <button type="button" onClick={downloadEinkaufCsv} disabled={einkaufIsEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-emerald-400 hover:text-emerald-700 transition-colors disabled:opacity-40">CSV</button>
              <button type="button" onClick={downloadEinkaufExcel} disabled={einkaufIsEmpty}
                className="text-[10px] font-bold px-2.5 py-1 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 transition-colors disabled:opacity-40">Excel</button>
            </div>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {viewMode === "kueche" ? (
          <div className="p-5">
            {isEmpty ? (
              <EmptyPlaceholder />
            ) : (
              <div className="grid grid-cols-2 gap-5">
                <DeboxColumn
                  title="Protein Debox"
                  icon="🥩"
                  titleCls="text-red-800"
                  badgeCls="text-red-600 bg-red-50 border-red-100"
                  groups={liste.protein}
                  totalKg={liste.protein.reduce((s, g) => s + g.totalKg, 0)}
                />
                <DeboxColumn
                  title="Veggie Debox"
                  icon="🥦"
                  titleCls="text-green-800"
                  badgeCls="text-green-600 bg-green-50 border-green-100"
                  groups={liste.veggie}
                  totalKg={liste.veggie.reduce((s, g) => s + g.totalKg, 0)}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="p-5">
            {einkaufIsEmpty ? (
              <EmptyPlaceholder />
            ) : (
              <div className="grid grid-cols-2 gap-5">
                <EinkaufColumn
                  title="Protein Debox"
                  icon="🥩"
                  titleCls="text-red-800"
                  items={einkauf.protein}
                  totalKg={einkauf.totalProteinKg}
                />
                <EinkaufColumn
                  title="Veggie Debox"
                  icon="🥦"
                  titleCls="text-green-800"
                  items={einkauf.veggie}
                  totalKg={einkauf.totalVeggieKg}
                />
              </div>
            )}
          </div>
        )}

        {/* ── Middle Kitchen – Spezial-Artikel Folge-KW ── */}
        {hasSpezial && (
          <div className="mx-5 mb-5 border border-orange-200 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setSpezialOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2.5 bg-orange-50 hover:bg-orange-100 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm">🏭</span>
                <span className="text-[11px] font-black text-orange-900 uppercase tracking-wide">
                  Middle Kitchen – Spezial-Artikel Folge-KW
                </span>
                <span className="text-[10px] text-orange-600 bg-orange-100 border border-orange-200 px-2 py-0.5 rounded-full font-bold">
                  ganze KW · {spezial.protein.length + spezial.veggie.length} Artikel
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); downloadSpezialExcel(); }}
                  className="text-[10px] font-bold px-2 py-0.5 rounded border border-orange-300 bg-white text-orange-700 hover:bg-orange-50 transition-colors"
                >
                  Excel
                </button>
                <span className="text-[10px] text-orange-500">{spezialOpen ? "▲" : "▼"}</span>
              </div>
            </button>

            {spezialOpen && (
              <div className="grid grid-cols-2 gap-4 p-4 bg-white">
                <SpezialColumn title="Protein Debox" icon="🥩" titleCls="text-red-700"
                  items={spezial.protein} totalKg={spezial.totalProteinKg} />
                <SpezialColumn title="Veggie Debox" icon="🥦" titleCls="text-green-700"
                  items={spezial.veggie} totalKg={spezial.totalVeggieKg} />
              </div>
            )}
          </div>
        )}
      </div>
      </>}
    </div>
  );
}

// ── Sub-Komponenten ────────────────────────────────────────────────────────

function EmptyPlaceholder() {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-slate-400">
      <div className="text-3xl mb-3">🥗</div>
      <div className="text-sm font-semibold">Keine PHF-Frischware für die gewählten Tage</div>
      <div className="text-xs mt-1">Tage auswählen, für die Daten vorliegen</div>
    </div>
  );
}

function DeboxColumn({
  title, icon, titleCls, badgeCls, groups, totalKg,
}: {
  title: string; icon: string; titleCls: string; badgeCls: string;
  groups: FrischeMealGroup[]; totalKg: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-base">{icon}</span>
          <span className={`text-xs font-black uppercase tracking-wide ${titleCls}`}>{title}</span>
          <span className={`text-[10px] font-bold border px-2 py-0.5 rounded-full ${badgeCls}`}>
            {groups.length} Mahlzeiten
          </span>
        </div>
        <span className="text-[10px] font-bold text-slate-500">{totalKg.toFixed(1)} kg PHF</span>
      </div>
      <MealGroupList groups={groups} />
    </div>
  );
}

function MealGroupList({ groups }: { groups: FrischeMealGroup[] }) {
  if (!groups.length) return <p className="text-xs text-slate-400 py-4 text-center">Keine PHF-Einträge</p>;
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
          {group.components.length > 0 && (
            <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded bg-black/5 text-current opacity-70">
              {group.components.length} Submeals
            </span>
          )}
        </div>
        <span className="text-[10px] font-bold whitespace-nowrap ml-2 opacity-80">
          {group.totalKg.toFixed(1)} kg
        </span>
      </div>

      {/* Body: entweder Submeals oder direkte Zutaten */}
      {group.components.length > 0 ? (
        <div className="border border-slate-200 rounded-b-lg overflow-hidden divide-y divide-slate-100">
          {group.components.map((comp) => (
            <div key={comp.componentName}>
              {/* Submeal-Header */}
              <div className="flex items-center justify-between px-3 py-1 bg-slate-50">
                <span className="text-[10px] font-bold text-slate-600 truncate">{comp.componentName}</span>
                <span className="text-[9px] font-bold text-slate-400 whitespace-nowrap ml-2">{comp.totalKg.toFixed(1)} kg</span>
              </div>
              {/* Zutaten dieser Komponente */}
              <table className="w-full text-xs">
                <tbody>
                  {comp.items.map((item, idx) => (
                    <tr key={item.name} className={`border-b border-slate-100 last:border-0 ${idx % 2 === 0 ? "bg-white" : rowAccent}`}>
                      <td className="px-3 py-1.5 pl-5 font-medium text-slate-700">{item.name}</td>
                      <td className="px-3 py-1.5 text-right font-bold tabular-nums text-slate-700 whitespace-nowrap">
                        {item.totalKg.toFixed(2)} kg
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-b-lg border border-slate-200 overflow-hidden">
          <table className="w-full text-xs">
            <tbody>
              {group.items.map((item, idx) => (
                <tr key={item.name} className={`border-b border-slate-100 last:border-0 ${idx % 2 === 0 ? "bg-white" : rowAccent}`}>
                  <td className="px-3 py-1.5 font-medium text-slate-800">{item.name}</td>
                  <td className="px-3 py-1.5 text-right font-bold tabular-nums text-slate-700 whitespace-nowrap">
                    {item.totalKg.toFixed(2)} kg
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EinkaufColumn({
  title, icon, titleCls, items, totalKg,
}: {
  title: string; icon: string; titleCls: string;
  items: FrischeIngredientTotal[]; totalKg: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-base">{icon}</span>
          <span className={`text-xs font-black uppercase tracking-wide ${titleCls}`}>{title}</span>
          <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">
            {items.length} Artikel
          </span>
        </div>
        <span className="text-[10px] font-bold text-slate-500">{totalKg.toFixed(1)} kg PHF</span>
      </div>
      {!items.length ? (
        <p className="text-xs text-slate-400 py-4 text-center">Keine PHF-Einträge</p>
      ) : (
        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-3 py-2 text-left font-bold text-slate-600">Artikel</th>
                <th className="px-3 py-2 text-right font-bold text-slate-600 whitespace-nowrap">Menge (kg)</th>
                <th className="px-3 py-2 text-right font-bold text-slate-400 whitespace-nowrap">WOs</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => (
                <tr key={item.name} className={`border-b border-slate-100 last:border-0 ${idx % 2 === 0 ? "bg-white" : "bg-slate-50/50"}`}>
                  <td className="px-3 py-1.5 font-medium text-slate-800">{item.name}</td>
                  <td className="px-3 py-1.5 text-right font-bold tabular-nums text-slate-700">{item.totalKg.toFixed(2)} kg</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-400">{item.woCount}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-100 border-t border-slate-300">
                <td className="px-3 py-1.5 font-black text-slate-700 text-[11px]">GESAMT</td>
                <td className="px-3 py-1.5 text-right font-black tabular-nums text-slate-800">{totalKg.toFixed(2)} kg</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function SpezialColumn({
  title, icon, titleCls, items, totalKg,
}: {
  title: string; icon: string; titleCls: string;
  items: FrischeIngredientTotal[]; totalKg: number;
}) {
  if (!items.length) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <span>{icon}</span>
          <span className={`text-[11px] font-black uppercase tracking-wide ${titleCls}`}>{title}</span>
        </div>
        <span className="text-[10px] font-bold text-orange-600">{totalKg.toFixed(1)} kg</span>
      </div>
      <div className="rounded-lg border border-orange-100 overflow-hidden">
        <table className="w-full text-xs">
          <tbody>
            {items.map((item, idx) => (
              <tr key={item.name} className={`border-b border-orange-50 last:border-0 ${idx % 2 === 0 ? "bg-white" : "bg-orange-50/40"}`}>
                <td className="px-3 py-1.5 font-medium text-slate-800">{item.name}</td>
                <td className="px-3 py-1.5 text-right font-bold tabular-nums text-orange-700">{item.totalKg.toFixed(2)} kg</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-orange-50 border-t border-orange-200">
              <td className="px-3 py-1.5 font-black text-orange-800 text-[11px]">GESAMT</td>
              <td className="px-3 py-1.5 text-right font-black tabular-nums text-orange-900">{totalKg.toFixed(2)} kg</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
