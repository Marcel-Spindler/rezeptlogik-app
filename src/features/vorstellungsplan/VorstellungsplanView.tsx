// Vorstellungsplan – 1:1-Spiegel von Marcels "F_VE Production Plan"-GSheet
// (Wochen-Tab "W{XX} - Plating Plan [WIP]") + App-weite KPIs. Standardansicht
// der Linienplanung seit 2026-08 (siehe LinePlanningView.tsx). Das GSheet
// bleibt Basiswert/Quelle der Wahrheit -- ein Pilot-Set an Zellen (Buffer,
// Allergene, Tages-Matrix, siehe ProductionPlanSheetTable) ist per Klick
// editierbar, die Edits landen als Overlay in Firestore statt im Sheet
// (productionPlanOverrides.ts). Grundlage für die geplante KI-/Live-View-
// Verknüpfung (Snowflake/WMS/Redzone/Postblast) -- jede Zelle wird so ein
// eigener, referenzierbarer Datenpunkt statt eines rohen Sheet-Werts.
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useForecastMonitor, useProductionPlanMonitor, useProductionPlanSelection, useProductionPlanWeeks, useRecipeProfilMonitor, type ProductionPlanSelection } from "../gsheet-monitor/useGSheetMonitor";
import { PRODUCTION_PLAN_DAYS, type ProductionPlanData, type ProductionPlanDay, type ProductionPlanWeekOption } from "../gsheet-monitor/gsheetTypes";
import { useBackfillsKpi, useRedzoneKpi, useWmsKpi } from "./vorstellungsplanKpis";
import { buildVorstellungsplanMailHtml } from "./vorstellungsplanMail";
import { ProductionPlanSheetTable } from "./ProductionPlanSheetTable";
import { applyProductionPlanOverrides, useProductionPlanOverrides } from "./productionPlanOverrides";
import { generateVorVorPlanungAI } from "./vorVorPlanungText";
import { generateFreitagsIstMailAI } from "./istPlanungText";
import { parseKetCsv } from "../ket-plan/ketLogic";
import { useKetRowsData, useSharedKetCsvRows } from "../ket-plan/useKetRowsData";
import type { KetRow } from "../ket-plan/ketTypes";
import type { DataBundle } from "../../core/types";

const DAY_SHORT: Record<ProductionPlanDay, string> = {
  Sunday: "So", Monday: "Mo", Tuesday: "Di", Wednesday: "Mi", Thursday: "Do", Friday: "Fr", Saturday: "Sa",
};

function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  return new Intl.NumberFormat("de-DE").format(Math.round(n));
}

// ─── Wochen-Pill-Selector ─────────────────────────────────────────────────
// Ersetzt die frühere manuelle gid-Eingabe: Wochen-Tabs werden live vom
// lokalen Server erkannt (useProductionPlanWeeks), die Vorauswahl springt
// automatisch auf "aktuelle KW + 1" (useProductionPlanSelection) mit.

function WeekPillSelector({
  weeks, selection, weeksLoading, weeksError, connected, lastUpdate, onRefresh,
}: {
  weeks: ProductionPlanWeekOption[];
  selection: ProductionPlanSelection;
  weeksLoading: boolean;
  weeksError: string | null;
  connected: boolean;
  lastUpdate: number | null;
  onRefresh: () => void;
}) {
  const lastUpdateLabel = lastUpdate
    ? new Date(lastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : "—";

  return (
    <div className="card p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold text-slate-500 uppercase tracking-wide text-[10px] shrink-0">Production Plan</span>
        <div className="flex flex-wrap gap-1.5">
          {weeks.map(w => {
            const active = selection.selected?.gid === w.gid;
            const isAutoTarget = selection.autoOption?.gid === w.gid;
            return (
              <button
                key={w.gid}
                type="button"
                onClick={() => selection.select(w.week)}
                title={w.title}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold ring-1 transition ${active ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50"}`}
              >
                KW{w.week}
                {isAutoTarget && <span className="ml-1 text-[9px] font-semibold opacity-80">nächste</span>}
              </button>
            );
          })}
          {!weeksLoading && weeks.length === 0 && <span className="text-xs text-slate-400">keine Wochen-Tabs gefunden</span>}
        </div>
        {!selection.isAuto && (
          <button type="button" onClick={selection.resetToAuto} className="text-[11px] px-2 py-1 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50">
            ⟲ Auto
          </button>
        )}
        <span className={`ml-auto text-[11px] font-mono ${connected ? "text-emerald-600" : "text-slate-400"}`}>
          {connected ? `● live · ${lastUpdateLabel}` : "○ wartet"}
        </span>
        <button type="button" onClick={onRefresh} className="text-[11px] px-2 py-0.5 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50">
          🔄 aktualisieren
        </button>
      </div>
      {weeksError && (
        <p className="text-[10px] text-red-600 mt-1.5">Wochenliste: {weeksError} — läuft der lokale Server (`npm run dev`/`npm run start`)?</p>
      )}
    </div>
  );
}

// ─── KPI-Kacheln ──────────────────────────────────────────────────────────────

function KpiTile({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "red" | "emerald" | "indigo" }) {
  const toneClass = { slate: "text-slate-800", red: "text-red-600", emerald: "text-emerald-600", indigo: "text-indigo-600" }[tone];
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm min-w-[7rem]">
      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wide">{label}</div>
      <div className={`text-lg font-black tabular-nums ${toneClass}`}>{value}</div>
    </div>
  );
}

// ─── Sheet-eigener KPI- + Utilization-Block ────────────────────────────────

function SheetKpiBlock({ data }: { data: ProductionPlanData }) {
  if (data.kpiRows.length === 0 && data.utilization.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-[11px] border-collapse">
        <thead className="bg-slate-100">
          <tr>
            <th className="px-2 py-1.5 text-left font-bold text-slate-600">Kennzahl</th>
            {PRODUCTION_PLAN_DAYS.map(d => <th key={d} className="px-2 py-1.5 font-bold text-slate-600">{DAY_SHORT[d]}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.kpiRows.map(k => (
            <tr key={k.label} className="border-t border-slate-100">
              <td className="px-2 py-1 font-semibold text-slate-700 capitalize">{k.label}</td>
              {PRODUCTION_PLAN_DAYS.map(d => <td key={d} className="px-2 py-1 text-right tabular-nums text-slate-600">{fmtInt(k.byDay[d])}</td>)}
            </tr>
          ))}
          {data.utilization.length > 0 && (
            <tr className="border-t-2 border-slate-200 bg-slate-50">
              <td className="px-2 py-1 font-black text-slate-500 uppercase text-[10px]" colSpan={PRODUCTION_PLAN_DAYS.length + 1}>Auslastung je Station</td>
            </tr>
          )}
          {data.utilization.map(u => (
            <tr key={u.station} className="border-t border-slate-100">
              <td className="px-2 py-1 font-semibold text-slate-700">{u.station}</td>
              {PRODUCTION_PLAN_DAYS.map(d => <td key={d} className="px-2 py-1 text-right tabular-nums text-slate-600">{fmtInt(u.byDay[d] ?? null)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Haupt-Ansicht ──────────────────────────────────────────────────────────

export function VorstellungsplanView({ week, appData }: { week: string; appData: DataBundle | null }) {
  const { weeks, currentHfWeek, sheetId, loading: weeksLoading, error: weeksError, forceRefresh: refreshWeeks } = useProductionPlanWeeks();
  const selection = useProductionPlanSelection(weeks, currentHfWeek);
  const gid = selection.selected?.gid ?? "";
  const prevWeekGid = useMemo(() => {
    if (!selection.selected) return "";
    const idx = weeks.findIndex(w => w.gid === selection.selected!.gid);
    return idx > 0 ? weeks[idx - 1].gid : "";
  }, [weeks, selection.selected]);
  const { data, lastUpdate, error, forceRefresh } = useProductionPlanMonitor(gid);
  const { data: prevWeekData } = useProductionPlanMonitor(prevWeekGid);
  const hfWeek = data?.week || week;
  const { overrides, saveCell, clearCell } = useProductionPlanOverrides(hfWeek);
  const mergedData = useMemo(() => (data ? applyProductionPlanOverrides(data, overrides) : data), [data, overrides]);
  const forecast = useForecastMonitor(hfWeek);
  const recipeProfil = useRecipeProfilMonitor();
  const backfillsKpi = useBackfillsKpi();
  const redzoneKpi = useRedzoneKpi();
  const wmsKpi = useWmsKpi(week);
  const [copyStatus, setCopyStatus] = useState<"idle" | "ok">("idle");
  const mailContainerRef = useRef<HTMLDivElement>(null);

  // Vor-Vor-Planung: KPI-Vergleich zur Vorwoche (Cup-Meals, Portionen, etc.)
  // Wenn Vorwochen-Daten verfügbar → automatische Deltas, sonst Fallback.
  const gsheetUrl = sheetId && gid ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=${gid}#gid=${gid}` : null;
  const [vorVorText, setVorVorText] = useState<string | null>(null);
  const [vorVorLoading, setVorVorLoading] = useState(false);
  const [vorVorCopyStatus, setVorVorCopyStatus] = useState<"idle" | "ok">("idle");

  async function handleGenerateVorVorText() {
    if (!mergedData) return;
    // Debug: Cup-Erkennung prüfen
    const cupMeals = mergedData.rows.filter(r => {
      if (r.stations.cup) return true;
      return Object.values(r.byDay).some(cell => cell.kind === "station" && /cup/i.test(cell.label));
    });
    const mealsWithCupLabel = mergedData.rows.filter(r =>
      Object.values(r.byDay).some(cell => cell.kind === "station" && /cup/i.test(cell.label))
    );
    console.log("[VorVorPlanung] Cup-Meals (Flag OR Label):", cupMeals.length, cupMeals.map(r => r.code));
    console.log("[VorVorPlanung] Meals mit 'Cup' im Day-Label:", mealsWithCupLabel.length, mealsWithCupLabel.map(r => ({ code: r.code, cupFlag: r.stations.cup, labels: Object.entries(r.byDay).filter(([, c]) => c.kind === "station").map(([d, c]) => `${d}:${(c as { label: string }).label}`) })));
    console.log("[VorVorPlanung] Alle Day-Labels im Plan:", [...new Set(mergedData.rows.flatMap(r => Object.values(r.byDay).filter(c => c.kind === "station").map(c => (c as { label: string }).label)))]);
    setVorVorLoading(true);
    setVorVorText(null);
    try {
      const text = await generateVorVorPlanungAI(mergedData, { gsheetUrl, prevWeekData });
      setVorVorText(text);
    } finally {
      setVorVorLoading(false);
    }
  }

  async function handleCopyVorVorText() {
    if (!vorVorText) return;
    try {
      await navigator.clipboard.writeText(vorVorText);
      setVorVorCopyStatus("ok");
      setTimeout(() => setVorVorCopyStatus("idle"), 3000);
    } catch { /* Clipboard-API evtl. ohne Berechtigung -- Text steht trotzdem im Feld zum manuellen Kopieren */ }
  }

  // Freitags-Ist-Mail: zweite Mail-Variante -- geht Freitags raus, wenn Run 1
  // final feststeht, mit den im KET-Plan geloggten Ist-Zahlen je WO statt der
  // Vorab-Schätzung. Quelle: dieselbe wie in "KET Plan / WO" (CSV falls dort/
  // in PostblastLiveView schon hochgeladen -> geteilter localStorage-Schlüssel,
  // sonst Firestore-Produktionsplan, sonst Live-WMS) -- kein erneuter Upload
  // noetig. Eigener CSV-Upload hier ist nur Fallback fuer den Fall, dass keine
  // der beiden Quellen etwas fuer die Woche hat.
  const sharedCsvRows = useSharedKetCsvRows();
  const [manualKetRows, setManualKetRows] = useState<KetRow[] | null>(null);
  const [ketFileName, setKetFileName] = useState<string | null>(null);
  const [ketWarnings, setKetWarnings] = useState<string[]>([]);
  const { ketRows, liveWeek: ketLiveWeek } = useKetRowsData(appData, hfWeek, manualKetRows ?? sharedCsvRows);
  const [istText, setIstText] = useState<string | null>(null);
  const [istLoading, setIstLoading] = useState(false);
  const [istCopyStatus, setIstCopyStatus] = useState<"idle" | "ok">("idle");

  async function handleKetFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    const { rows, warnings } = parseKetCsv(text);
    setManualKetRows(rows);
    setKetFileName(file.name);
    setKetWarnings(warnings);
    setIstText(null);
  }

  async function handleGenerateIstText() {
    if (!ketRows.length) return;
    setIstLoading(true);
    setIstText(null);
    try {
      const text = await generateFreitagsIstMailAI(ketRows, ketLiveWeek, { gsheetUrl, cookSchedules: appData?.cookSchedules });
      setIstText(text);
    } finally {
      setIstLoading(false);
    }
  }

  async function handleCopyIstText() {
    if (!istText) return;
    try {
      await navigator.clipboard.writeText(istText);
      setIstCopyStatus("ok");
      setTimeout(() => setIstCopyStatus("idle"), 3000);
    } catch { /* Clipboard-API evtl. ohne Berechtigung -- Text steht trotzdem im Feld zum manuellen Kopieren */ }
  }

  function handleCopyMail() {
    if (!mergedData || !mailContainerRef.current) return;
    const html = buildVorstellungsplanMailHtml(mergedData, week, { backfills: backfillsKpi, redzone: redzoneKpi, wms: wmsKpi });
    mailContainerRef.current.innerHTML = html;
    const range = document.createRange();
    range.selectNode(mailContainerRef.current);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.execCommand("copy");
    sel?.removeAllRanges();
    setCopyStatus("ok");
    setTimeout(() => setCopyStatus("idle"), 3000);
  }

  return (
    <div className="space-y-3">
      <WeekPillSelector
        weeks={weeks} selection={selection} weeksLoading={weeksLoading} weeksError={weeksError}
        connected={!!data} lastUpdate={lastUpdate}
        onRefresh={() => { void refreshWeeks(); void forceRefresh(); }}
      />

      <div className="flex flex-wrap gap-2">
        <KpiTile label="WMS · WO-Portionen" value={wmsKpi.status === "loading" ? "…" : fmtInt(wmsKpi.totalWoPortions)} tone="indigo" />
        <KpiTile label="WMS · Meals" value={wmsKpi.status === "loading" ? "…" : fmtInt(wmsKpi.uniqueMeals)} />
        <KpiTile
          label="Backfills kritisch"
          value={backfillsKpi ? fmtInt(backfillsKpi.criticalCount) : "–"}
          tone={backfillsKpi && backfillsKpi.criticalCount > 0 ? "red" : "emerald"}
        />
        <KpiTile label="Backfill-Empfehlung" value={backfillsKpi ? fmtInt(backfillsKpi.totalRecommendedPortions) : "–"} />
        <KpiTile label="Redzone · aktive Linien" value={redzoneKpi ? fmtInt(redzoneKpi.activeLineCount) : "–"} tone="indigo" />
        <KpiTile label="Redzone · geplatet" value={redzoneKpi ? fmtInt(redzoneKpi.totalPlated) : "–"} />
      </div>

      <div className="card p-3 shadow-sm space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-black text-slate-800">🧾 Freitags-Ist-Mail</h3>
            <p className="text-[11px] text-slate-500">Ist-Zahlen aus Run 1 je WO -- gleiche Quelle wie „KET Plan / WO“, kein erneuter Upload nötig. Sortiert nach Veggie/Protein Debox, dann nach dem je WO berechneten Muss-Start-Termin (Cook Schedule).</p>
          </div>
          <label className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white ring-1 ring-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer">
            📂 Fallback: eigene CSV hochladen
            <input type="file" accept=".csv" className="hidden" onChange={handleKetFileUpload} />
          </label>
        </div>
        <p className="text-[11px] text-slate-500">
          {manualKetRows ? `${ketFileName} (Fallback-Upload)` : sharedCsvRows ? "KET Plan / WO (hochgeladene CSV)" : "KET Plan / WO (Firestore/Live-WMS)"}
          {" "}· {ketRows.length} WOs
          {ketWarnings.length > 0 && <span className="text-amber-600"> · {ketWarnings.length} Warnung(en) im Fallback-Upload</span>}
        </p>
        {ketRows.length > 0 && (
          <button
            onClick={handleGenerateIstText}
            disabled={istLoading}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {istLoading ? "⏳ KI generiert…" : "🤖 Freitags-Ist-Mail generieren (KI)"}
          </button>
        )}
        {istText && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600">🤖 KI-generierte Freitags-Ist-Mail — Run-1-Ist-Zahlen je Departement, sortiert nach berechnetem Muss-Start-Termin</span>
              <button
                onClick={handleCopyIstText}
                className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
              >
                📋 Kopieren
              </button>
            </div>
            <textarea
              readOnly
              value={istText}
              onFocus={(e) => e.currentTarget.select()}
              rows={istText.split("\n").length + 1}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-mono text-slate-700"
            />
            {istCopyStatus === "ok" && <p className="text-[11px] text-emerald-600">✓ In Zwischenablage kopiert.</p>}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {error} — Wochen-Auswahl oben prüfen oder „aktualisieren" klicken.
        </div>
      )}

      {!weeksLoading && !weeksError && weeks.length === 0 && (
        <div className="card p-6 text-center text-slate-400 text-sm">
          Keine Wochen-Tabs ab {currentHfWeek ?? "der aktuellen KW"} im Sheet gefunden (Muster „W{"{NN}"} - Plating Plan [WIP]").
        </div>
      )}

      {!data && !error && weeks.length > 0 && (
        <div className="card p-6 text-center text-slate-400 text-sm">Lädt Production Plan …</div>
      )}

      {data && (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-slate-800">Vorstellungsplan {data.week || week}</h3>
            <div className="flex gap-2">
              <button
                onClick={handleGenerateVorVorText}
                disabled={vorVorLoading}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {vorVorLoading ? "⏳ KI generiert…" : "🤖 Vor-Vor-Planung (KI)"}
              </button>
              <button
                onClick={handleCopyMail}
                className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
              >
                📋 Als Email kopieren
              </button>
            </div>
          </div>
          {copyStatus === "ok" && <p className="text-[11px] text-emerald-600">✓ In Zwischenablage kopiert — direkt in Outlook/Gmail einfügen.</p>}
          {vorVorText && (
            <div className="card p-3 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-600">🤖 KI-generierter Vor-Vor-Planungstext — dazu Screenshot vom Plan + Sheet-Link an die Boss-Runde</span>
                <button
                  onClick={handleCopyVorVorText}
                  className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
                >
                  📋 Kopieren
                </button>
              </div>
              <textarea
                readOnly
                value={vorVorText}
                onFocus={(e) => e.currentTarget.select()}
                rows={vorVorText.split("\n").length + 1}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-mono text-slate-700"
              />
              {vorVorCopyStatus === "ok" && <p className="text-[11px] text-emerald-600">✓ In Zwischenablage kopiert.</p>}
            </div>
          )}
          <p className="text-[10px] text-slate-400">
            <span className="inline-block h-2 w-2 rounded-sm bg-amber-100 ring-1 ring-amber-300 align-middle mr-1" />
            Bearbeitet (weicht vom GSheet ab) ·{" "}
            <span className="inline-block h-2 w-2 rounded-sm bg-sky-100 ring-1 ring-sky-300 align-middle mr-1" />
            automatisch aus der Tages-Matrix berechnet ·{" "}
            <span className="inline-block rounded-full bg-amber-400 px-1 text-white text-[8px] font-bold align-middle mr-1">live</span>
            Sheet weicht von Forecast/Recipe Profil ab — Klick auf Zelle zum Ändern, ↺ beim Hover setzt zurück. Schreibt nicht ins Sheet.
          </p>
          <ProductionPlanSheetTable
            data={data}
            hfWeek={data.week || week}
            overrides={overrides}
            onSaveCell={saveCell}
            onClearCell={clearCell}
            forecastByCode={forecast.data?.byCode}
            recipeProfilByCode={recipeProfil.data?.byCode}
          />
          <SheetKpiBlock data={mergedData ?? data} />
        </>
      )}

      {/* Off-Screen-Container für den Rich-HTML-Copy (execCommand("copy") braucht ein
          gerendertes, nicht display:none-Element, um den Range/Selection-Trick zu erlauben). */}
      <div ref={mailContainerRef} style={{ position: "fixed", top: -99999, left: -99999, width: 1, height: 1, overflow: "hidden" }} aria-hidden />
    </div>
  );
}
