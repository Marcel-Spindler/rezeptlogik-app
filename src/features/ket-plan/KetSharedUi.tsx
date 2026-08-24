// Kleinere, wiederverwendete Bausteine für KET Plan / WO: leere Zustände,
// Datei-Upload-Bildschirm, die WO-Gesamtübersicht, Stat-/Status-Chips.
import { useState, Component, type RefObject, type ReactNode } from "react";
import { classifyDeboxDepartment, fmtDateHeader, fmtKg, fmtNum, statusColors } from "./ketLogic";
import type { BatchCalc, KetRow, WoInstruction } from "./ketTypes";
import type { RunInfo } from "./ketRunLogic";

// Cook-Method-Label fürs Chip-UI, z.B. "BRAISER PAN" → "Braiser Pan". Leere
// Segmente (Mehrfach-Leerzeichen in der Quelle) werden übersprungen statt
// als "undefined" gerendert.
export function titleCaseCookMethod(method: string): string {
  return method
    .split(" ")
    .filter(Boolean)
    .map(w => w[0] + w.slice(1).toLowerCase())
    .join(" ");
}

export function EmptyState() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center max-w-xs px-6">
        <div className="w-16 h-16 rounded-3xl bg-slate-100 flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
        </div>
        <p className="text-sm font-bold text-slate-600">Work Order wählen</p>
        <p className="text-xs text-slate-400 mt-1">Klicke links auf eine Work Order für den Breakdown</p>
      </div>
    </div>
  );
}

// ── Missing-data screen (groß, mit Auto-Upload) ────────────────────────────

export function MissingDataScreen({
  title,
  neededFile,
  hint,
  fileInputRef,
  onFile,
}: {
  title: string;
  neededFile: string;
  hint: string;
  fileInputRef: RefObject<HTMLInputElement>;
  onFile: (file: File) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div className="flex h-[calc(100vh-112px)] items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-lg">
      <div className="text-center max-w-lg px-8">
        <div className="w-20 h-20 rounded-3xl bg-amber-100 flex items-center justify-center mx-auto mb-5">
          <svg className="w-10 h-10 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>
        <h2 className="text-2xl font-black text-amber-700 mb-2">{title}</h2>
        <p className="text-sm font-bold text-slate-700 mb-1">
          Fehlender Datensatz: <span className="text-amber-700">{neededFile}</span>
        </p>
        <p className="text-sm text-slate-500 mb-6">
          Ohne Import dieser Datei kann diese Ansicht nicht berechnet werden. Bitte lade sie jetzt hoch.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          title={`${neededFile} hochladen`}
          aria-label={`${neededFile} hochladen`}
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}
        />
        <div
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => fileInputRef.current?.click()}
          className={`cursor-pointer rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-all select-none ${
            dragOver ? "border-blue-400 bg-blue-50 scale-[1.02]" : "border-amber-300 bg-amber-50 hover:border-blue-300 hover:bg-blue-50/50"
          }`}
        >
          <div className="text-sm font-bold text-slate-700 mb-1">📂 {neededFile} hochladen</div>
          <div className="text-xs text-slate-400">Der Dateidialog sollte sich bereits geöffnet haben · Klicken oder Datei hier ablegen · .csv</div>
        </div>
        <p className="text-[11px] text-slate-400 mt-4">{hint}</p>
      </div>
    </div>
  );
}

// ── WO Overview (Alle WOs) ─────────────────────────────────────────────────
// Full-width overview of ALL work orders in the main content area — the
// scalable counterpart to the narrow 280px sidebar list. Renders whatever
// filtering/sorting the sidebar already computed (filteredGroups); clicking
// a card selects that WO and switches back to the detail/breakdown view.

export function KetWoOverview({
  groups,
  calcMap,
  selectedKey,
  onSelect,
  printedWoNumbers,
  runAssignments,
  instructionCache,
  selectedWoKeys,
  onToggleWoSelection,
  onToggleDaySelection,
  onClearSelection,
  onPrintSelection,
  onSaveSelection,
  onGenerateInstructions,
  bulkBusy,
  bulkStatus,
  bulkError,
}: {
  groups: [string, KetRow[]][];
  calcMap: Map<string, BatchCalc>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  printedWoNumbers?: Record<string, string>;
  runAssignments?: Map<string, RunInfo>;
  instructionCache?: Map<string, WoInstruction>;
  // Massenauswahl (Checkboxen + Sticky-Aktionsleiste) — nur aktiv, wenn der
  // Aufrufer selectedWoKeys mitgibt. Ohne diese Props verhält sich die
  // Komponente wie zuvor (reines Durchklicken, keine Checkboxen).
  selectedWoKeys?: Set<string>;
  onToggleWoSelection?: (key: string) => void;
  onToggleDaySelection?: (dayRows: KetRow[]) => void;
  onClearSelection?: () => void;
  onPrintSelection?: () => void;
  onSaveSelection?: () => void;
  onGenerateInstructions?: () => void;
  bulkBusy?: boolean;
  bulkStatus?: string | null;
  bulkError?: string | null;
}) {
  const totalRows = groups.reduce((s, [, rows]) => s + rows.length, 0);
  const selectionCount = selectedWoKeys?.size ?? 0;

  if (totalRows === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-sm text-slate-400 py-16">Keine WOs gefunden</div>
      </div>
    );
  }

  return (
    <>
      {selectedWoKeys && selectionCount > 0 && (
        <div className="sticky top-0 z-20 flex flex-wrap items-center gap-3 px-4 py-2.5 bg-[#1e3a5f] shadow-md">
          <span className="text-xs font-black text-white">{selectionCount} WO{selectionCount !== 1 ? "s" : ""} ausgewählt</span>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            {bulkStatus && <span className="text-[10px] font-semibold text-blue-200">{bulkStatus}</span>}
            <button
              type="button"
              onClick={onPrintSelection}
              disabled={bulkBusy}
              className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-white text-[#1e3a5f] hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              🖨 Drucken
            </button>
            <button
              type="button"
              onClick={onSaveSelection}
              disabled={bulkBusy}
              className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              ⬇ Speichern
            </button>
            {onGenerateInstructions && (
              <button
                type="button"
                onClick={onGenerateInstructions}
                disabled={bulkBusy}
                className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ✎ Anweisungen erzeugen
              </button>
            )}
            <button
              type="button"
              onClick={onClearSelection}
              className="text-[10px] font-bold px-3 py-1.5 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors"
            >
              Auswahl aufheben
            </button>
          </div>
          {bulkError && <div className="w-full text-[10px] font-semibold text-red-200">{bulkError}</div>}
        </div>
      )}
      <div className="p-4 space-y-5">
      {groups.map(([date, rows]) => {
        const allDaySelected = !!selectedWoKeys && rows.length > 0 && rows.every(r => selectedWoKeys.has(r.key));
        return (
        <div key={date}>
          <div className="flex items-center gap-2 mb-2 px-1">
            {onToggleDaySelection && (
              <input
                type="checkbox"
                checked={allDaySelected}
                onChange={() => onToggleDaySelection(rows)}
                title="Alle WOs dieses Tages auswählen"
                className="h-3.5 w-3.5 rounded border-slate-300 text-blue-700 focus:ring-blue-500 cursor-pointer"
              />
            )}
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
              {fmtDateHeader(date)}
            </span>
            <span className="text-[10px] text-slate-300">{rows.length} WOs</span>
          </div>
          <div className="space-y-2">
            {rows.map(row => {
              const calc = calcMap.get(row.key);
              const isSelected = selectedKey === row.key;
              const kSc = statusColors(row.kitchenStatus);
              const sSc = statusColors(row.stagingStatus);
              const done = row.woCookedPortions ?? 0;
              const pct = row.targetPortions > 0 ? Math.round((done / row.targetPortions) * 100) : 0;
              const hasInstruction = instructionCache?.has(row.key) ?? false;
              const methods = calc?.resolvedCookMethods ?? row.cookMethods;
              const deboxDept = calc ? classifyDeboxDepartment(calc) : null;
              const hasVeggieDebox = deboxDept === "veggie";
              const hasProteinDebox = deboxDept === "protein";
              const gnTotal = calc?.gnTraySummary?.reduce((s, t) => s + t.trays, 0) ?? 0;
              const isChecked = selectedWoKeys?.has(row.key) ?? false;

              return (
                <div key={row.key} className="flex items-stretch gap-2">
                  {onToggleWoSelection && (
                    <label
                      className="flex w-9 shrink-0 items-center justify-center rounded-xl cursor-pointer hover:bg-slate-100 transition-colors"
                      title="Für Massenauswahl markieren"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => onToggleWoSelection(row.key)}
                        className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-500 cursor-pointer"
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => onSelect(row.key)}
                    className={`min-w-0 flex-1 text-left rounded-xl bg-white border shadow-sm hover:shadow transition-all overflow-hidden ${
                      isSelected ? "border-[#1e3a5f] ring-2 ring-[#1e3a5f]/20" : isChecked ? "border-blue-300 ring-2 ring-blue-200" : "border-slate-200"
                    }`}
                    style={{ borderLeft: `4px solid ${isSelected ? "#1e3a5f" : isChecked ? "#3b82f6" : "#cbd5e1"}` }}
                  >
                    <div className="px-4 py-3">
                    {/* Row 1: WO number + recipe info + kg/batches */}
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-black text-[#1e3a5f]">WO {row.woNumber}</span>
                          {printedWoNumbers?.[row.woNumber] && (
                            <span className="text-[10px] font-black text-emerald-600" title={`Bereits gedruckt/gespeichert am ${new Date(printedWoNumbers[row.woNumber]).toLocaleString("de-DE")}`}>✓</span>
                          )}
                          {hasInstruction && (
                            <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-emerald-100 text-emerald-700">Anweisung</span>
                          )}
                          {runAssignments?.get(row.key) && (
                            <span
                              className="text-[8px] font-black px-1 py-0.5 rounded bg-amber-100 text-amber-700"
                              title={runAssignments.get(row.key)!.isSplit
                                ? `Geschätzt: ${Math.round(runAssignments.get(row.key)!.cumulativeSharePct * 100)}% des Wochenvolumens dieses Meals bis einschließlich diesem Tag`
                                : "Nur ein Produktionstag diese Woche — kein echter Run-Split"}
                            >
                              Run {runAssignments.get(row.key)!.run}
                            </span>
                          )}
                          {row.recipeCode && (
                            <span className="text-[9px] font-mono text-slate-400">{row.recipeCode}</span>
                          )}
                        </div>
                        <div className="text-xs font-bold text-slate-800 leading-tight mt-0.5 truncate">
                          {row.recipeName}
                        </div>
                        <div className="text-[10px] text-slate-500 truncate mt-0.5">
                          {row.subRecipeName || "—"}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                        {calc && calc.batches > 0 && (
                          <span
                            className="text-[10px] font-black px-1.5 py-0.5 rounded-md bg-blue-100 text-blue-700"
                            title={calc.primaryCapBibleMatch
                              ? `Batche berechnet mit Kuechenbible-Kapazität "${calc.primaryCapBibleMatch.itemName}" (provisorisch)`
                              : undefined}
                          >
                            {calc.primaryCapBibleMatch && <span aria-hidden="true">📖 </span>}
                            {calc.batches}×
                          </span>
                        )}
                        {calc && calc.totalKg > 0 && (
                          <span className="text-[10px] text-slate-400 tabular-nums">{fmtKg(calc.totalKg)}</span>
                        )}
                      </div>
                    </div>

                    {/* Row 2: Debox + Stations + GN + Components */}
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                      {hasVeggieDebox && (
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-green-100 text-green-700">Veggie Debox</span>
                      )}
                      {hasProteinDebox && (
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">Protein Debox</span>
                      )}
                      {calc && calc.components.length > 1 && (
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
                          {calc.components.length} Komp.
                        </span>
                      )}
                      {methods.filter(m => m !== "VEGGIE DEBOX" && m !== "PROTEIN DEBOX" && m !== "SPICE PORTIONING" && m !== "BLAST CHILLER").map(m => (
                        <span key={m} className="text-[8px] font-semibold px-1 py-0.5 rounded bg-slate-100 text-slate-500">
                          {titleCaseCookMethod(m)}
                        </span>
                      ))}
                      {gnTotal > 0 && (
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-sky-100 text-sky-700">{gnTotal} Bleche</span>
                      )}
                      {calc?.scoopInfo?.methodType && (
                        <span className="text-[8px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                          Scoop {calc.scoopInfo.methodColor ?? ""}
                        </span>
                      )}
                    </div>

                    {/* Row 3: Allergene */}
                    {calc && calc.allergensContains.length > 0 && (
                      <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                        <span className="text-[8px] font-black text-red-600">CONTAINS:</span>
                        {calc.allergensContains.slice(0, 5).map(a => (
                          <span key={a} className="text-[7px] font-bold px-1 py-0.5 rounded bg-red-50 text-red-600 border border-red-200">
                            {a.split(" / ")[0]}
                          </span>
                        ))}
                        {calc.allergensContains.length > 5 && (
                          <span className="text-[7px] text-red-400">+{calc.allergensContains.length - 5}</span>
                        )}
                      </div>
                    )}

                    {/* Row 4: Portions progress + status */}
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <span className="text-sm font-black text-slate-900 tabular-nums">{fmtNum(done)}</span>
                      <span className="text-[9px] text-slate-400">/ {fmtNum(row.targetPortions)} Port.</span>
                      {pct > 0 && (
                        <div className="flex-1 min-w-[60px] max-w-[140px] h-1 rounded-full overflow-hidden bg-slate-100">
                          <div
                            className={`h-full rounded-full ${pct >= 100 ? "bg-emerald-500" : "bg-blue-400"}`}
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                      )}
                      <span className={`ml-auto text-[9px] font-semibold px-1.5 py-0.5 rounded-md ${kSc.bg} ${kSc.text}`}>
                        Kitchen: {row.kitchenStatus || "—"}
                      </span>
                      <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-md ${sSc.bg} ${sSc.text}`}>
                        Staging: {row.stagingStatus || "—"}
                      </span>
                    </div>
                  </div>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        );
      })}
      </div>
    </>
  );
}

// ── Micro components ───────────────────────────────────────────────────────

export function StatCard({
  label, value, sub, subGreen, highlight, warn, badge, badgeTitle, compact,
}: {
  label: string; value: string; sub?: string; subGreen?: boolean; highlight?: boolean; warn?: string;
  // Small, always-visible indicator (e.g. "📖" for a Kuechenbible-sourced
  // value) — shown next to the label so the source is clear without
  // requiring a hover, per label with an optional tooltip for detail.
  badge?: string; badgeTitle?: string;
  // Kleinere Variante — die WO-Kopfzeile (Ziel-Portionen/Total KG/Batche/…)
  // soll gegenüber den neuen Komponenten-Blöcken darunter optisch zurücktreten.
  compact?: boolean;
}) {
  return (
    <div className={`rounded-2xl border ${compact ? "px-3 py-2" : "px-4 py-3.5"} ${
      highlight
        ? "bg-[#1e3a5f] border-[#1e3a5f]"
        : warn
          ? "bg-amber-50 border-amber-200"
          : "bg-white border-slate-200 shadow-sm"
    }`}>
      <div className={`flex items-center gap-1 text-[7px] font-black uppercase tracking-[0.12em] ${compact ? "mb-1" : "mb-1.5"} ${
        highlight ? "text-blue-300" : warn ? "text-amber-500" : "text-slate-400"
      }`}>
        <span>{label}</span>
        {badge && (
          <span title={badgeTitle} aria-label={badgeTitle ?? "Kuechenbible"} className="cursor-help">{badge}</span>
        )}
      </div>
      <div className={`${compact ? "text-sm" : "text-xl"} font-black tabular-nums leading-tight ${
        highlight ? "text-white" : warn ? "text-amber-800" : "text-slate-900"
      }`}>{value}</div>
      {sub && (
        <div className={`text-[9px] font-medium mt-0.5 ${
          subGreen ? "text-emerald-600" : highlight ? "text-blue-300" : "text-slate-400"
        }`}>{sub}</div>
      )}
      {warn && <div className="text-[9px] text-amber-600 font-semibold mt-0.5">{warn}</div>}
    </div>
  );
}

export function StatusChip({ label, value }: { label: string; value: string }) {
  const { bg, text, dot } = statusColors(value);
  return (
    <div className={`flex items-center gap-1.5 text-[10px] font-bold px-3 py-1.5 rounded-xl border ${bg} ${text} border-transparent`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`}></span>
      <span className="text-[9px] font-medium opacity-70">{label}:</span>
      {value || "—"}
    </div>
  );
}

// ── Error Boundary ──────────────────────────────────────────────────────────

interface KetErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
}

interface KetErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class KetErrorBoundary extends Component<KetErrorBoundaryProps, KetErrorBoundaryState> {
  constructor(props: KetErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): KetErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-full p-8">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 rounded-3xl bg-red-100 flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-red-800 mb-2">
              {this.props.fallbackTitle ?? "Fehler in der KET-Plan-Ansicht"}
            </h3>
            <p className="text-sm text-slate-600 mb-4">
              {this.state.error?.message ?? "Ein unerwarteter Fehler ist aufgetreten."}
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              Erneut versuchen
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
