// Detailansicht für eine einzelne Work Order: Cook Methods, Batch-Kapazitäten
// (inline editierbar), Zutaten-Tabelle, Kochanweisungen.
import { useEffect, useState } from "react";
import { EQUIP_LABELS, type BatchCalc, type GnTraySummary, type KetRow, type ManualEquipmentOverride, type WoComponent, type WoInstruction } from "./ketTypes";
import { catColor, fmtDateHeader, fmtKg, fmtNum, sortIngredients } from "./ketLogic";
import { StatCard, StatusChip } from "./KetSharedUi";
import { orderCookingMethods, parseInstructionLines, splitInstructionKeywords } from "./woInstructionBot";

const INSTRUCTION_VARIANTS = {
  en: { text: "text-emerald-700", bg: "bg-emerald-700", border: "border-emerald-200" },
  de: { text: "text-blue-700", bg: "bg-blue-700", border: "border-blue-200" },
} as const;

// Zeigt Kochanweisungs-Text stationsweise: jede "A. STATION:"-Zeile als eigener
// Abschnitt mit eigener Zeile, Schritt-Sätze darunter nummeriert, bekannte
// Stationsnamen (SPICE ROOM, GRILL, OFEN, …) farblich hervorgehoben.
function InstructionBlocks({ text, variant }: { text: string; variant: "en" | "de" }) {
  const v = INSTRUCTION_VARIANTS[variant];
  const lines = parseInstructionLines(text);
  if (lines.length === 0) return <span className="whitespace-pre-wrap">{text}</span>;
  return (
    <div className="space-y-1">
      {lines.map((line, i) =>
        line.isHeader ? (
          <div key={i} className={`mt-2 border-b pb-0.5 text-[9px] font-black uppercase tracking-widest first:mt-0 ${v.border} ${v.text}`}>
            {line.text}
          </div>
        ) : (
          <div key={i} className="flex items-start gap-1.5">
            <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[7px] font-black text-white ${v.bg}`}>
              {line.stepNum}
            </span>
            <span className="leading-relaxed">
              {splitInstructionKeywords(line.text).map((seg, j) =>
                seg.isKeyword
                  ? <span key={j} className={`font-black ${v.text}`}>{seg.text}</span>
                  : <span key={j}>{seg.text}</span>,
              )}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

// Kleines Allergen-Tag direkt an der Zutat — zeigt, WELCHE Zutat das WO-weite
// "CONTAINS"-Badge auslöst (statt nur die aggregierte Liste am WO-Kopf).
function AllergenTag({ allergen }: { allergen?: string }) {
  if (!allergen) return null;
  return (
    <span
      title={`Allergen: ${allergen}`}
      className="ml-1.5 inline-flex items-center text-[7px] font-black uppercase tracking-wide text-red-700 bg-red-100 rounded-md px-1 py-0.5 align-middle"
    >
      ⚠ {allergen}
    </span>
  );
}

// GN-Blech-Bedarf dieser einen Zutat (siehe ketLogic.resolveGnTrays) — null,
// wenn für diese Zutat keine Kapazitäts-/Tray-Quelle bekannt ist (z.B. Saucen,
// die nur in die Wanne gehen, nie geraten).
function GnTag({ trays, gnType }: { trays: number | null; gnType: string | null }) {
  if (!trays || !gnType) return null;
  return (
    <span
      title={`${trays}× ${gnType} für diese Zutat`}
      className="ml-1.5 inline-flex items-center text-[7px] font-black uppercase tracking-wide text-sky-700 bg-sky-100 rounded-md px-1 py-0.5 align-middle"
    >
      📦 {trays}× {gnType}
    </span>
  );
}

// Zusammenfassung des GN-Blech-Bedarfs, gruppiert nach GN-Größe — nie zu einer
// Zahl verschmelzen, unterschiedliche Größen sind nicht austauschbar.
function GnTraySummaryLine({ summary }: { summary: GnTraySummary[] }) {
  if (summary.length === 0) return null;
  return (
    <div className="text-[10px] font-bold text-sky-700 tabular-nums">
      📦 {summary.map((s) => `${s.trays}× ${s.gnType}`).join(" · ")}
    </div>
  );
}

// Eine eigenständige Zubereitungskomponente innerhalb einer WO (siehe
// ketTypes.WoComponent) — eigene Zutatentabelle, eigenes Equipment/Batche,
// eigene, unabhängig generierte Kochanweisung. Eigener lokaler State pro
// Instanz (React hält das automatisch pro component.name/key auseinander).
function ComponentSection({
  component,
  instruction,
  onGenerate,
  onEdit,
  manualEquipment,
  onManualEquipmentChange,
}: {
  component: WoComponent;
  instruction?: WoInstruction;
  onGenerate: () => Promise<void>;
  onEdit?: (updated: WoInstruction) => void;
  manualEquipment?: ManualEquipmentOverride;
  onManualEquipmentChange?: (override: ManualEquipmentOverride | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [enDraft, setEnDraft] = useState("");
  const [deDraft, setDeDraft] = useState("");
  const [showEquipOverride, setShowEquipOverride] = useState(false);
  const [equipDraft, setEquipDraft] = useState(manualEquipment?.equipment ?? "");
  const [capDraft, setCapDraft] = useState(manualEquipment ? String(manualEquipment.capacityKg) : "");

  useEffect(() => {
    setEquipDraft(manualEquipment?.equipment ?? "");
    setCapDraft(manualEquipment ? String(manualEquipment.capacityKg) : "");
  }, [component.name, manualEquipment]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await onGenerate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const visibleIngredients = [...component.ingredients]
    .filter((i) => i.totalKg > 0.0005 || i.totalPcs > 0)
    .sort(sortIngredients);

  return (
    <div className="rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0f2240] px-4 py-2.5">
        <div className="min-w-0">
          <div className="text-[7px] font-black uppercase tracking-[0.12em] text-blue-400">Komponente</div>
          <div className="text-sm font-black text-white leading-tight truncate">{component.name}</div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 justify-end">
          {orderCookingMethods(component.resolvedCookMethods).map((m) => (
            <span key={m} className={`text-[9px] font-bold px-2 py-1 rounded-lg ${m === component.primaryEquip ? "bg-blue-500 text-white" : "bg-white/10 text-blue-200"}`}>
              {EQUIP_LABELS[m] ?? m}
            </span>
          ))}
        </div>
      </div>

      {component.equipBatches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 bg-slate-50 border-b border-slate-100">
          {component.equipBatches.map((eb) => (
            <div key={eb.equip} className="rounded-lg px-2.5 py-1.5 bg-white border border-slate-200 text-center">
              <div className="text-[7px] font-bold text-slate-400 uppercase tracking-wide">{eb.label}</div>
              <div className="text-xs font-black text-[#1e3a5f] tabular-nums">
                {eb.batches}× <span className="text-[9px] font-semibold text-slate-500">à {fmtKg(eb.perBatchKg)}</span>
              </div>
            </div>
          ))}
          <div className="ml-auto text-[10px] font-bold text-slate-500 tabular-nums">{fmtKg(component.totalKg)} gesamt</div>
        </div>
      )}

      {component.gnTraySummary.length > 0 && (
        <div className="px-4 py-1.5 border-b border-slate-100 bg-sky-50/60">
          <GnTraySummaryLine summary={component.gnTraySummary} />
        </div>
      )}

      {/* Equipment-Ausnahme NUR für diese Komponente — z.B. wenn gar kein
          Equipment erkannt wurde ("Concentrated Tomatoes" o.ä.). Standardmäßig
          eingeklappt, damit Komponenten mit korrekt erkanntem Equipment nicht
          unnötig Platz verlieren. */}
      {onManualEquipmentChange && (
        <div className="px-4 py-1.5 border-b border-slate-100 bg-slate-50/60">
          {!showEquipOverride ? (
            <button type="button" onClick={() => setShowEquipOverride(true)}
              className="text-[9px] font-semibold text-slate-400 hover:text-slate-600">
              ⚙ Equipment-Ausnahme{manualEquipment ? `: ${manualEquipment.equipment} (${manualEquipment.capacityKg} kg/Batch)` : " (nur für diese Komponente)"}
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5 py-0.5">
              <input value={equipDraft} onChange={(e) => setEquipDraft(e.target.value)} placeholder="Equipment, z. B. OVEN"
                aria-label={`Manuelles Equipment für ${component.name}`}
                className="min-w-[140px] flex-1 rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-800 outline-none" />
              <input type="number" min={0.1} step={0.1} value={capDraft} onChange={(e) => setCapDraft(e.target.value)} placeholder="kg/Batch"
                aria-label={`Manuelle Kapazität für ${component.name}`}
                className="w-20 rounded-md border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-800 outline-none" />
              <button type="button" onClick={() => {
                const equipment = equipDraft.trim().toUpperCase();
                const capacityKg = Number(capDraft.replace(",", "."));
                if (equipment && Number.isFinite(capacityKg) && capacityKg > 0) onManualEquipmentChange({ equipment, capacityKg });
              }} className="rounded-md bg-blue-500 px-2 py-1 text-[9px] font-bold text-white hover:bg-blue-400">Anwenden</button>
              {manualEquipment && (
                <button type="button" onClick={() => onManualEquipmentChange(null)}
                  className="rounded-md px-1.5 py-1 text-[9px] font-bold text-slate-400 hover:text-red-600">Löschen</button>
              )}
              <button type="button" onClick={() => setShowEquipOverride(false)}
                className="rounded-md px-1.5 py-1 text-[9px] font-bold text-slate-400 hover:text-slate-600">Zu</button>
            </div>
          )}
        </div>
      )}

      {/* Factor-Produktionsregeln für DIESE Komponente (eigener Name, siehe
          ketLogic.buildWoComponents) — z.B. "Ground Beef - cooked" ist
          neverBatch, auch wenn der WO-Name selbst kein Fleisch-Keyword trifft. */}
      {(component.rti || component.neverBatch || component.readyMade || component.factorCapacityKg != null) && (
        <div className="px-4 py-2 border-b border-slate-100 space-y-1">
          {component.rti && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1 text-[10px] font-bold text-amber-800">
              RTI · Ready to Eat → direkt zum Plating (kein Batch)
            </div>
          )}
          {component.neverBatch && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-2.5 py-1 text-[10px] font-bold text-red-700">
              ⚠ Kein Batch — wird als Gesamtmenge produziert (Fleisch/Fisch-Regel)
            </div>
          )}
          {component.readyMade && (
            <div className="rounded-lg bg-purple-50 border border-purple-200 px-2.5 py-1 text-[10px] font-bold text-purple-700">
              Fertigprodukt — wöchentlich vorbereitet, nicht expandieren
            </div>
          )}
          {!component.rti && !component.neverBatch && component.factorCapacityKg != null && (
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-2.5 py-1 text-[10px] font-bold text-emerald-700">
              Batch (Factor-Regel): {component.factorBatches ?? "—"}× {component.factorBatchQtyKg != null ? fmtKg(component.factorBatchQtyKg) : "—"}
              {" "}(Kapazität {component.factorCapacityKg} kg{component.factorFallbackCapacity ? " · Fallback" : ""})
            </div>
          )}
        </div>
      )}

      {/* Reihenfolge bewusst: Sub-Rezept (Kopf oben) → Kochanweisung → Zutaten,
          dann erst der nächste Komponenten-Block — nicht umgekehrt. */}
      <div className="p-3 border-b border-slate-100">
        {error && <div className="mb-2 rounded-lg bg-rose-50 border border-rose-200 px-2.5 py-1.5 text-[10px] font-semibold text-rose-700">{error}</div>}
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-[9px] font-black uppercase tracking-widest text-emerald-700">Kochanweisung</div>
          <div className="flex gap-1.5">
            {instruction && onEdit && !editing && (
              <button type="button" onClick={() => { setEnDraft(instruction.english); setDeDraft(instruction.german); setEditing(true); }}
                className="rounded-lg bg-slate-200 px-2 py-1 text-[9px] font-bold text-slate-700 hover:bg-slate-300">
                Bearbeiten
              </button>
            )}
            <button type="button" onClick={() => void generate()} disabled={busy}
              className="rounded-lg bg-emerald-700 px-2.5 py-1 text-[9px] font-bold text-white hover:bg-emerald-800 disabled:opacity-50">
              {busy ? "Erzeuge …" : instruction ? "Neu erzeugen" : "Erzeugen"}
            </button>
          </div>
        </div>
        {editing && instruction ? (
          <div className="space-y-2">
            <textarea value={enDraft} onChange={(e) => setEnDraft(e.target.value)} rows={4}
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-800 resize-y" />
            <textarea value={deDraft} onChange={(e) => setDeDraft(e.target.value)} rows={4}
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-800 resize-y" />
            <div className="flex gap-2">
              <button type="button" onClick={() => { onEdit?.({ ...instruction, english: enDraft, german: deDraft }); setEditing(false); }}
                className="rounded-lg bg-emerald-700 px-2.5 py-1 text-[9px] font-bold text-white hover:bg-emerald-800">
                Speichern
              </button>
              <button type="button" onClick={() => setEditing(false)}
                className="rounded-lg bg-slate-100 px-2.5 py-1 text-[9px] font-bold text-slate-600 hover:bg-slate-200">
                Abbrechen
              </button>
            </div>
          </div>
        ) : instruction ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <div><div className="text-[8px] font-black uppercase tracking-widest text-emerald-700 mb-1">English</div><div className="text-[11px] leading-relaxed text-slate-700"><InstructionBlocks text={instruction.english} variant="en" /></div></div>
            <div><div className="text-[8px] font-black uppercase tracking-widest text-blue-700 mb-1">Deutsch</div><div className="text-[11px] leading-relaxed text-slate-700"><InstructionBlocks text={instruction.german} variant="de" /></div></div>
          </div>
        ) : (
          <div className="text-[10px] text-slate-400 italic">Noch keine Kochanweisung erzeugt.</div>
        )}
      </div>

      {visibleIngredients.length > 0 && (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-100">
              <th className="text-left px-4 py-1.5 text-[8px] font-black uppercase tracking-wide text-slate-400">Zutat</th>
              <th className="text-right px-4 py-1.5 text-[8px] font-black uppercase tracking-wide text-slate-400">Total</th>
              <th className="text-right px-4 py-1.5 text-[8px] font-black uppercase tracking-wide text-blue-600">Pro Batch</th>
            </tr>
          </thead>
          <tbody>
            {visibleIngredients.map((ing, idx) => (
              <tr key={idx} className="border-b border-slate-50">
                <td className="px-4 py-1.5">
                  {ing.category && <span className={`text-[7px] font-black px-1 py-0.5 rounded mr-1 ${catColor(ing.category)}`}>{ing.category}</span>}
                  <span className="font-medium text-slate-700">{ing.name}</span>
                  <AllergenTag allergen={ing.allergen} />
                  <GnTag trays={ing.gnTrays} gnType={ing.gnType} />
                </td>
                <td className="px-4 py-1.5 text-right font-semibold tabular-nums text-slate-600">{ing.totalPcs > 0 ? `${Math.round(ing.totalPcs)} Stk` : fmtKg(ing.totalKg)}</td>
                <td className="px-4 py-1.5 text-right font-black tabular-nums text-blue-700">{ing.totalPcs > 0 ? `${Math.round(ing.totalPcs)} Stk` : fmtKg(ing.perBatchKg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function WoDetail({
  row,
  calc,
  onPrint,
  onCapChange,
  instruction,
  onGenerateInstruction,
  onInstructionEdit,
  componentInstructions,
  onGenerateComponentInstruction,
  onComponentInstructionEdit,
  onGenerateAllComponentInstructions,
  onDownload,
  manualEquipment,
  onManualEquipmentChange,
  componentManualEquipment,
  onComponentManualEquipmentChange,
}: {
  row: KetRow;
  calc: BatchCalc | null;
  onPrint: () => void;
  onCapChange: (equip: string, raw: string) => void;
  instruction?: WoInstruction;
  onGenerateInstruction: () => Promise<void>;
  onInstructionEdit?: (updated: WoInstruction) => void;
  // Zusammengesetzte Sub-Rezepte (calc.components, siehe ketTypes.WoComponent):
  // eine eigene Instruction je Komponente statt einer für die ganze WO.
  componentInstructions?: Record<string, WoInstruction>;
  onGenerateComponentInstruction?: (component: WoComponent) => Promise<void>;
  onComponentInstructionEdit?: (component: WoComponent, updated: WoInstruction) => void;
  // Erzeugt in einem Klick alle (noch fehlenden) Komponenten-Instructions dieser WO.
  onGenerateAllComponentInstructions?: () => Promise<void>;
  onDownload: () => Promise<void>;
  manualEquipment?: ManualEquipmentOverride;
  onManualEquipmentChange: (override: ManualEquipmentOverride | null) => void;
  // Equipment-Ausnahme je Komponente (keyed by component.name) — unabhängig von
  // manualEquipment oben, das nur für die WO-Gesamtansicht gilt.
  componentManualEquipment?: Record<string, ManualEquipmentOverride>;
  onComponentManualEquipmentChange?: (componentName: string, override: ManualEquipmentOverride | null) => void;
}) {
  const [editingEquip, setEditingEquip] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState("");
  const [manualEquipmentDraft, setManualEquipmentDraft] = useState("");
  const [manualCapacityDraft, setManualCapacityDraft] = useState("");
  const [instructionBusy, setInstructionBusy] = useState(false);
  const [instructionError, setInstructionError] = useState<string | null>(null);
  const [allComponentsBusy, setAllComponentsBusy] = useState(false);
  const [allComponentsError, setAllComponentsError] = useState<string | null>(null);
  const [editingInstruction, setEditingInstruction] = useState(false);
  const [instrEnDraft, setInstrEnDraft] = useState("");
  const [instrDeDraft, setInstrDeDraft] = useState("");
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    setManualEquipmentDraft(manualEquipment?.equipment ?? "");
    setManualCapacityDraft(manualEquipment ? String(manualEquipment.capacityKg) : "");
  }, [row.key, manualEquipment]);

  if (!calc) return null;

  const done = row.woCookedPortions ?? 0;
  const remaining = Math.max(0, row.targetPortions - done);
  const donePct = row.targetPortions > 0 ? Math.round((done / row.targetPortions) * 100) : 0;
  const equip = calc.primaryEquip ? (EQUIP_LABELS[calc.primaryEquip] ?? calc.primaryEquip) : null;

  function commitCap(e: string) {
    if (capDraft.trim()) onCapChange(e, capDraft);
    setEditingEquip(null);
  }

  async function generateInstruction() {
    setInstructionBusy(true);
    setInstructionError(null);
    try {
      await onGenerateInstruction();
    } catch (error) {
      setInstructionError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstructionBusy(false);
    }
  }

  async function generateAllComponents() {
    setAllComponentsBusy(true);
    setAllComponentsError(null);
    try {
      await onGenerateAllComponentInstructions?.();
    } catch (error) {
      setAllComponentsError(error instanceof Error ? error.message : String(error));
    } finally {
      setAllComponentsBusy(false);
    }
  }

  return (
    <div>
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-gradient-to-r from-[#0f2240] via-[#1e3a5f] to-[#0f2240] px-6 py-4 shadow-lg">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 flex-wrap mb-0.5">
              <span className="text-2xl font-black text-white">WO {row.woNumber}</span>
              <span className="font-mono text-xs text-blue-300">{row.recipeCode}</span>
              <span className="text-xs text-blue-400">{fmtDateHeader(row.dateNeeded)}</span>
            </div>
            <div className="text-sm font-bold text-blue-100 truncate">{row.recipeName}</div>
            <div className="text-xs text-blue-300/80 mt-0.5 truncate">{row.subRecipeName}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={downloadBusy}
              onClick={async () => {
                setDownloadBusy(true);
                setDownloadStatus(null);
                try {
                  await onDownload();
                  setDownloadStatus({ ok: true, msg: "Gespeichert ✓" });
                  setTimeout(() => setDownloadStatus(null), 4000);
                } catch (err) {
                  setDownloadStatus({ ok: false, msg: err instanceof Error ? err.message : String(err) });
                } finally {
                  setDownloadBusy(false);
                }
              }}
              title={downloadStatus && !downloadStatus.ok ? downloadStatus.msg : "Als PDF-Datei speichern (ohne Druckdialog)"}
              className={`flex items-center gap-1.5 text-xs font-bold px-3 py-2.5 rounded-xl transition-colors border disabled:opacity-50 ${
                downloadStatus?.ok
                  ? "bg-emerald-500/20 border-emerald-400/40 text-emerald-200"
                  : downloadStatus && !downloadStatus.ok
                    ? "bg-red-500/20 border-red-400/40 text-red-200"
                    : "bg-white/10 hover:bg-white/20 text-white border-white/10"
              }`}
            >
              {downloadBusy ? (
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              )}
              {downloadStatus ? downloadStatus.msg : "Speichern"}
            </button>
            <button
              type="button"
              onClick={onPrint}
              className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-colors border border-white/10"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
              Drucken
            </button>
          </div>
        </div>
      </div>

      <div className="p-5 space-y-4">

        {/* Factor-Produktionsregeln (RTI / nie-batchen-Fleisch / Batch nach Rezeptname / Allergene).
            Bei zusammengesetzten Sub-Rezepten (calc.components) werden RTI/neverBatch/
            readyMade/Kapazität NICHT hier gezeigt — sie würden nach dem zusammengesetzten
            WO-Namen klassifiziert (z.B. "Stuffed PEPPER Casserole Base-V2" träfe zufällig
            die Paprika-Regel, obwohl es um Rindfleisch + Gemüse geht) und stattdessen pro
            Komponente unten korrekt angezeigt (siehe ComponentSection). */}
        {((!calc.components.length && (calc.rti || calc.neverBatch || calc.readyMade || calc.factorCapacityKg != null)) || calc.allergensContains.length > 0 || calc.chillerAssignment) && (
          <div className="space-y-2">
            {!calc.components.length && calc.rti && (
              <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs font-bold text-amber-200">
                RTI · Ready to Eat → direkt zum Plating (kein Batch)
              </div>
            )}
            {!calc.components.length && calc.neverBatch && (
              <div className="rounded-xl border border-red-400/40 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-200">
                ⚠ Kein Batch — wird als Gesamtmenge produziert (Fleisch/Fisch-Regel)
              </div>
            )}
            {!calc.components.length && calc.readyMade && (
              <div className="rounded-xl border border-purple-400/40 bg-purple-500/10 px-3 py-2 text-xs font-bold text-purple-200">
                Fertigprodukt — wöchentlich vorbereitet, nicht expandieren
              </div>
            )}
            {!calc.components.length && !calc.rti && !calc.neverBatch && calc.factorCapacityKg != null && (
              <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-200">
                Batch (Factor-Regel): {calc.factorBatches ?? "—"}× {calc.factorBatchQtyKg != null ? fmtKg(calc.factorBatchQtyKg) : "—"}
                {" "}(Kapazität {calc.factorCapacityKg} kg{calc.factorFallbackCapacity ? " · Fallback" : ""})
              </div>
            )}
            {calc.allergensContains.length > 0 && (
              <div className="rounded-xl border border-red-400/30 bg-red-500/5 px-3 py-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-black text-red-300 underline">⚠ CONTAINS</span>
                {calc.allergensContains.map(a => (
                  <span key={a} className="text-[9px] font-bold text-white bg-red-600 rounded-full px-2 py-0.5">{a}</span>
                ))}
              </div>
            )}
            {calc.chillerAssignment && (
              <div
                className="rounded-xl border px-3 py-2 flex items-center gap-2 text-xs font-bold"
                style={{
                  borderColor: `${calc.chillerAssignment.cfg.cntBg}40`,
                  background: `${calc.chillerAssignment.cfg.cntBg}1a`,
                  color: calc.chillerAssignment.cfg.cntBg,
                }}
                title={calc.chillerAssignment.unknown
                  ? "Keine Allergen-Daten gefunden — Zuteilung ungesichert, bitte manuell prüfen"
                  : `Allergen-Basis: ${calc.chillerAssignment.allergen} · gleiche Zuteilung wie Blast Chiller Bot`}
              >
                <span>❄️ {calc.chillerAssignment.cfg.label}</span>
                <span className="opacity-70 font-semibold">· {calc.chillerAssignment.cfg.sub}</span>
                {calc.chillerAssignment.unknown && (
                  <span className="text-amber-300 font-black">⚠ unbekannt, bitte prüfen</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Cook Methods + Per-Equipment Batche — bewusst klein: die Details stehen
            unten je Zubereitungskomponente, das hier ist nur der Kopf-Überblick. */}
        <div className="bg-[#0f2240] rounded-2xl px-4 py-3">
          <div className="text-[7px] font-black uppercase tracking-[0.15em] text-blue-400 mb-1.5">
            Cook Methods
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {orderCookingMethods(calc.resolvedCookMethods).length > 0 ? orderCookingMethods(calc.resolvedCookMethods).map(m => (
              <span key={m}
                className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg ${
                  m === calc.primaryEquip ? "bg-blue-500 text-white ring-1 ring-blue-300/40" : "bg-white/10 text-blue-200"
                }`}>
                {m === calc.primaryEquip && <span className="w-1 h-1 rounded-full bg-blue-300"></span>}
                {EQUIP_LABELS[m] ?? m}
              </span>
            )) : <span className="text-blue-400/60 text-xs italic">Keine Cook Methods</span>}
          </div>

          {/* Per-Equipment Batche mit editierbarer Kapazität */}
          {calc.equipBatches.length > 0 && (
            <div>
              <div className="text-[7px] font-black uppercase tracking-[0.12em] text-blue-400 mb-1.5">
                Batche je Equipment — {fmtKg(calc.totalKg)} Gesamt{calc.components.length > 0 ? " (aus Komponenten)" : ""}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {calc.equipBatches.map(eb => (
                  <div key={eb.equip}
                    className={`rounded-lg px-2.5 py-2 border ${eb.equip === calc.primaryEquip ? "bg-blue-600/30 border-blue-400/40" : "bg-white/10 border-white/10"}`}>
                    <div className="text-[8px] font-bold text-blue-200 mb-0.5">{eb.label}</div>
                    <div className="text-base font-black text-white tabular-nums">{eb.batches}×</div>
                    <div className="text-[8px] text-blue-300 mt-0.5">
                      à {fmtKg(eb.perBatchKg)}
                      {eb.remainderKg > 0 && <span className="text-amber-300"> · Rest {fmtKg(eb.remainderKg)} ({eb.utilizationPct}%)</span>}
                    </div>
                    {/* Inline Kapazitäts-Edit */}
                    {editingEquip === eb.equip ? (
                      <div className="flex items-center gap-1 mt-1.5">
                        <input
                          type="number" min={1} step={5}
                          title={`Kapazität ${eb.label} (kg/Batch)`}
                          aria-label={`Kapazität ${eb.label} in kg pro Batch`}
                          value={capDraft}
                          onChange={e => setCapDraft(e.target.value)}
                          onBlur={() => commitCap(eb.equip)}
                          onKeyDown={e => { if (e.key === "Enter") commitCap(eb.equip); if (e.key === "Escape") setEditingEquip(null); }}
                          className="w-14 text-center text-xs font-bold text-slate-900 bg-white rounded px-1 py-0.5 border-0 outline-none"
                          autoFocus
                        />
                        <span className="text-[9px] text-blue-300">kg</span>
                      </div>
                    ) : (
                      <button type="button"
                        onClick={() => { setCapDraft(String(eb.capacityKg)); setEditingEquip(eb.equip); }}
                        title={eb.bibleMatch
                          ? `Ändert die globale ${eb.label}-Standardkapazität — wirkt auf ALLE ${eb.label}-Rezepte (auch andere Kuechenbible-Treffer und Rezepte ohne Treffer), nicht nur auf diese Zeile`
                          : `Globale ${eb.label}-Standardkapazität ändern — wirkt auf alle ${eb.label}-Rezepte`}
                        className="flex items-center gap-1 mt-1.5 text-[9px] text-blue-300 hover:text-white transition-colors group">
                        <span>{eb.capacityKg} kg/Batch</span>
                        <svg className="w-2.5 h-2.5 opacity-50 group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
                        </svg>
                      </button>
                    )}
                    {eb.bibleMatch && (
                      <>
                        <div
                          title={`Kuechenbible-Kapazität: "${eb.bibleMatch.itemName}" → ${eb.bibleMatch.maxKg} kg (provisorisch, noch nicht vollständig produktionsvalidiert). Aktiv, solange keine manuelle ${eb.label}-Kapazität gesetzt ist.`}
                          className="inline-flex items-center gap-1 mt-1.5 text-[8px] font-black text-amber-200 bg-amber-500/20 border border-amber-400/30 rounded-md px-1.5 py-0.5 cursor-help"
                        >
                          <span aria-hidden="true">📖</span>
                          <span className="truncate max-w-[90px]">Kuechenbible: {eb.bibleMatch.itemName}</span>
                        </div>
                        <div className="text-[7px] text-amber-200/70 mt-1 leading-tight">
                          ⚠ Bearbeiten ändert den globalen Standard für alle {eb.label}-Rezepte
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {calc.gnTraySummary.length > 0 && (
            <div className="mt-1.5 text-[10px] font-bold text-sky-300 tabular-nums">
              📦 {calc.gnTraySummary.map((s) => `${s.trays}× ${s.gnType}`).join(" · ")}
              {calc.components.length > 0 ? " (aus Komponenten)" : ""}
            </div>
          )}
          {equip && calc.equipBatches.length === 0 && (
            <div className="mt-1 text-[10px] text-blue-300">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block mr-1.5"></span>
              <strong>{equip}</strong> — Kapazität in Equipment-Einstellungen (Sidebar) setzen
            </div>
          )}
          {!calc.primaryEquip && (
            <div className="mt-1 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[10px] font-semibold text-amber-100">
              Kein Equipment automatisch erkannt. Für eine belastbare Batch- und PDF-Berechnung bitte unten einmal Equipment und kg/Batch eintragen.
            </div>
          )}
          <div className="mt-3 border-t border-white/10 pt-3">
            <div className="text-[8px] font-black uppercase tracking-[0.12em] text-blue-400 mb-1">
              Equipment-Ausnahme
            </div>
            <div className="text-[10px] text-blue-200/70 mb-2">
              Nur verwenden, wenn WO, ProcessSpec und Bible kein Equipment liefern.
              {calc.components.length > 0 && (
                <span className="text-amber-200"> Wirkt nur auf diese WO-Gesamtansicht — nicht auf die einzelnen Komponenten unten, auch nicht auf eine ohne erkanntes Equipment.</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={manualEquipmentDraft}
                onChange={(event) => setManualEquipmentDraft(event.target.value)}
                placeholder="Equipment, z. B. BRAISER"
                aria-label="Manuelles Equipment"
                className="min-w-[180px] flex-1 rounded-lg border-0 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900 outline-none"
              />
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={manualCapacityDraft}
                onChange={(event) => setManualCapacityDraft(event.target.value)}
                placeholder="kg/Batch"
                aria-label="Manuelle Equipment-Kapazität in kg"
                className="w-24 rounded-lg border-0 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-900 outline-none"
              />
              <button
                type="button"
                onClick={() => {
                  const equipment = manualEquipmentDraft.trim().toUpperCase();
                  const capacityKg = Number(manualCapacityDraft.replace(",", "."));
                  if (equipment && Number.isFinite(capacityKg) && capacityKg > 0) {
                    onManualEquipmentChange({ equipment, capacityKg });
                  }
                }}
                className="rounded-lg bg-blue-500 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-blue-400 transition-colors"
              >
                Anwenden
              </button>
              {manualEquipment && (
                <button
                  type="button"
                  onClick={() => onManualEquipmentChange(null)}
                  className="rounded-lg px-2 py-1.5 text-[10px] font-bold text-blue-200 hover:bg-white/10 transition-colors"
                >
                  Ausnahme löschen
                </button>
              )}
            </div>
          </div>
        </div>

        {/* UoM-Warnungen */}
        {calc.uomWarnings.length > 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2">
            <div className="text-[9px] font-black text-amber-700 uppercase mb-1">Einheiten-Warnungen</div>
            {calc.uomWarnings.map((w, i) => (
              <div key={i} className="text-[10px] text-amber-600">{w}</div>
            ))}
          </div>
        )}

        {/* Zusammengesetztes Sub-Rezept: eigene Sektion je Komponente statt der
            einen WO-weiten Instruction — jede braucht ihre eigene Anweisung
            (siehe ketLogic.buildWoComponents / Diagnose "WO 35-169"). */}
        {calc.components.length > 0 ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
                Zubereitungskomponenten ({calc.components.length}) — jede mit eigener Kochanweisung
              </div>
              {onGenerateAllComponentInstructions && (() => {
                const missingCount = calc.components.filter((c) => !componentInstructions?.[c.name]).length;
                return (
                  <button type="button" onClick={() => void generateAllComponents()} disabled={allComponentsBusy}
                    className="rounded-lg bg-emerald-700 px-3 py-1.5 text-[10px] font-black text-white hover:bg-emerald-800 disabled:opacity-50">
                    {allComponentsBusy
                      ? "Erzeuge alle …"
                      : missingCount > 0
                        ? `Alle ${missingCount} fehlenden erzeugen`
                        : `Alle ${calc.components.length} neu erzeugen`}
                  </button>
                );
              })()}
            </div>
            {allComponentsError && (
              <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-[10px] font-semibold text-rose-700">{allComponentsError}</div>
            )}
            {calc.components.map((component, index) => (
              <ComponentSection
                // Manche Rezepte (z.B. FV0401A) wiederholen denselben Zubereitungsschritt
                // (gleicher Name) an mehreren Stellen im Baum — Index hält den React-Key
                // eindeutig, auch wenn component.name kollidiert.
                key={`${component.name}-${index}`}
                component={component}
                instruction={componentInstructions?.[component.name]}
                onGenerate={async () => { await onGenerateComponentInstruction?.(component); }}
                onEdit={onComponentInstructionEdit ? (updated) => onComponentInstructionEdit(component, updated) : undefined}
                manualEquipment={componentManualEquipment?.[component.name]}
                onManualEquipmentChange={onComponentManualEquipmentChange ? (override) => onComponentManualEquipmentChange(component.name, override) : undefined}
              />
            ))}
          </div>
        ) : (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-emerald-200">
              <div>
                <div className="text-[10px] font-black uppercase tracking-[.12em] text-emerald-800">Google Gemini WO Instruction Bot</div>
                <div className="text-[10px] text-emerald-700 mt-0.5">Individuelle Arbeitsanweisung für diese WO und dieses Sub-Rezept</div>
              </div>
              <div className="flex gap-1.5">
                {instruction && onInstructionEdit && !editingInstruction && (
                  <button type="button" onClick={() => { setInstrEnDraft(instruction.english); setInstrDeDraft(instruction.german); setEditingInstruction(true); }}
                    className="rounded-lg bg-slate-200 px-2.5 py-2 text-[10px] font-bold text-slate-700 hover:bg-slate-300">
                    Bearbeiten
                  </button>
                )}
                <button type="button" onClick={() => void generateInstruction()} disabled={instructionBusy}
                  className="rounded-lg bg-emerald-700 px-3 py-2 text-[10px] font-bold text-white hover:bg-emerald-800 disabled:opacity-50">
                  {instructionBusy ? "Erzeuge …" : instruction ? "Neu erzeugen" : "Instruction erzeugen"}
                </button>
              </div>
            </div>
            {instructionError && <div className="px-4 py-2 text-[10px] font-semibold text-rose-700 bg-rose-50 border-b border-rose-200">{instructionError}</div>}
            {editingInstruction && instruction && (
              <div className="p-4 space-y-3 border-b border-emerald-200 bg-white">
                <div>
                  <label className="text-[9px] font-black uppercase tracking-widest text-emerald-700 mb-1 block">English</label>
                  <textarea value={instrEnDraft} onChange={e => setInstrEnDraft(e.target.value)} rows={6}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs leading-relaxed text-slate-800 resize-y" />
                </div>
                <div>
                  <label className="text-[9px] font-black uppercase tracking-widest text-blue-700 mb-1 block">Deutsch</label>
                  <textarea value={instrDeDraft} onChange={e => setInstrDeDraft(e.target.value)} rows={6}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs leading-relaxed text-slate-800 resize-y" />
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => {
                    onInstructionEdit?.({ ...instruction, english: instrEnDraft, german: instrDeDraft });
                    setEditingInstruction(false);
                  }} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-emerald-800">
                    Speichern
                  </button>
                  <button type="button" onClick={() => setEditingInstruction(false)}
                    className="rounded-lg bg-slate-100 px-3 py-1.5 text-[10px] font-bold text-slate-600 hover:bg-slate-200">
                    Abbrechen
                  </button>
                </div>
              </div>
            )}
            {instruction && !editingInstruction && (
              <div className="grid gap-3 p-4 lg:grid-cols-2">
                <div><div className="text-[9px] font-black uppercase tracking-widest text-emerald-700 mb-1">Instructions (EN)</div><div className="text-xs leading-relaxed text-slate-700"><InstructionBlocks text={instruction.english} variant="en" /></div></div>
                <div><div className="text-[9px] font-black uppercase tracking-widest text-blue-700 mb-1">Anleitung (DE) · {instruction.status === "needs_review" ? "Review erforderlich" : "Gemini"}</div><div className="text-xs leading-relaxed text-slate-700"><InstructionBlocks text={instruction.german} variant="de" /></div></div>
              </div>
            )}
          </section>
        )}

        {/* Stats Grid — bewusst kompakt, siehe StatCard compact-Variante */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <StatCard compact label="Ziel-Portionen" value={fmtNum(row.targetPortions)} />
          <StatCard
            compact
            label="Gekocht / Rest"
            value={`${fmtNum(done)} / ${fmtNum(remaining)}`}
            sub={donePct > 0 ? `${donePct}% fertig` : undefined}
            subGreen={donePct > 0}
          />
          <StatCard
            compact
            label="Total KG (Roh)"
            value={calc.totalKg > 0 ? fmtKg(calc.totalKg) : "—"}
            warn={!calc.recipeFound ? "Rezept nicht gefunden" : !calc.subRecipeFound ? "Sub-Rezept ?" : undefined}
          />
          {equip && (
            <StatCard compact label="Primär-Equipment" value={equip}
              sub={calc.batches > 0 ? `${calc.batches} Batche à ${fmtKg(calc.perBatchKg)}` : undefined}
              badge={calc.primaryCapBibleMatch ? "📖" : undefined}
              badgeTitle={calc.primaryCapBibleMatch ? `Kapazität aus Kuechenbible: "${calc.primaryCapBibleMatch.itemName}" (provisorisch)` : undefined} />
          )}
          <StatCard compact label="Batche" value={calc.batches > 0 ? String(calc.batches) : "—"} highlight
            sub={calc.perBatchKg > 0 ? `à ${fmtKg(calc.perBatchKg)}${calc.remainderKg > 0 ? ` + Rest ${fmtKg(calc.remainderKg)}` : ""}` : undefined}
            badge={calc.primaryCapBibleMatch ? "📖" : undefined}
            badgeTitle={calc.primaryCapBibleMatch ? `Batch-Anzahl basiert auf Kuechenbible-Kapazität: "${calc.primaryCapBibleMatch.itemName}" (provisorisch, noch nicht vollständig produktionsvalidiert)` : undefined} />
          <StatCard compact label="Pro Batch" value={calc.perBatchKg > 0 ? fmtKg(calc.perBatchKg) : "—"}
            sub={calc.remainderKg > 0 ? `Rest: ${fmtKg(calc.remainderKg)}` : undefined} />
        </div>

        {/* Progress bar */}
        {donePct > 0 && (
          <div>
            <div className="flex justify-between text-[9px] font-bold text-slate-400 mb-1">
              <span>Fortschritt</span>
              <span>{donePct}%</span>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${donePct >= 100 ? "bg-emerald-500" : "bg-blue-500"}`}
                style={{ width: `${Math.min(100, donePct)}%` }}
              />
            </div>
          </div>
        )}

        {/* Status row */}
        <div className="flex flex-wrap gap-2">
          <StatusChip label="Kitchen" value={row.kitchenStatus} />
          <StatusChip label="Staging" value={row.stagingStatus} />
          {row.cookedPortionsExcess != null && (
            <div className={`flex items-center gap-1 text-[10px] font-bold px-3 py-1.5 rounded-xl border ${
              (row.cookedPortionsExcess ?? 0) >= 0
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : "bg-red-50 border-red-200 text-red-700"
            }`}>
              Excess: {(row.cookedPortionsExcess ?? 0) > 0 ? "+" : ""}{fmtNum(row.cookedPortionsExcess ?? 0)}
            </div>
          )}
        </div>

        {/* Comments */}
        {(row.workOrderComment || row.stagingComment || row.unlockedEta) && (
          <div className="space-y-2">
            {row.workOrderComment && (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-xs text-amber-800">
                <span className="mt-0.5">⚠</span>
                <span><strong>WO Kommentar:</strong> {row.workOrderComment}</span>
              </div>
            )}
            {row.stagingComment && (
              <div className="flex items-start gap-2 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-xs text-slate-600">
                <span>💬</span>
                <span><strong>Staging:</strong> {row.stagingComment}</span>
              </div>
            )}
            {row.unlockedEta && (
              <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 text-xs text-blue-800">
                <span>🔓</span>
                <span><strong>Unlocked ETA:</strong> {new Date(row.unlockedEta).toLocaleString("de-DE")}</span>
              </div>
            )}
          </div>
        )}

        {/* Batch visualization */}
        {calc.batches > 1 && calc.perBatchKg > 0 && (
          <div>
            <div className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400 mb-2">
              Batch-Übersicht ({calc.batches} Batche)
            </div>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: Math.min(calc.batches, 20) }, (_, i) => {
                const isRest = calc.remainderKg > 0 && i === calc.batches - 1;
                const batchKg = isRest ? calc.remainderKg : calc.perBatchKg;
                return (
                  <div key={i} className={`flex flex-col items-center rounded-xl px-3 py-2 min-w-[64px] shadow-sm border ${isRest ? "bg-amber-50 border-amber-200" : "bg-white border-slate-200"}`}>
                    <span className={`text-[8px] font-bold uppercase ${isRest ? "text-amber-600" : "text-slate-400"}`}>{isRest ? "Rest" : "Batch"}</span>
                    <span className={`text-lg font-black ${isRest ? "text-amber-700" : "text-[#1e3a5f]"}`}>{i + 1}</span>
                    <span className={`text-[9px] font-semibold tabular-nums ${isRest ? "text-amber-600" : "text-slate-500"}`}>{fmtKg(batchKg)}</span>
                  </div>
                );
              })}
              {calc.batches > 20 && (
                <div className="flex items-center px-3 text-xs text-slate-400 font-semibold">
                  +{calc.batches - 20} weitere
                </div>
              )}
            </div>
          </div>
        )}

        {/* Ingredient Table */}
        {calc.ingredients.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">
                {calc.components.length > 0 ? "Alle Zutaten (gesamt)" : "Zutaten"}{calc.batches > 0 ? ` · ${calc.batches} Batche` : ""}
              </div>
              <div className="text-[9px] font-bold text-slate-500 tabular-nums">
                {fmtKg(calc.totalKg)} gesamt
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-4 py-3 text-[9px] font-black uppercase tracking-wide text-slate-500">Zutat</th>
                    <th className="text-right px-4 py-3 text-[9px] font-black uppercase tracking-wide text-slate-500">Total</th>
                    <th className="text-right px-4 py-3 text-[9px] font-black uppercase tracking-wide text-blue-600">Pro Batch</th>
                  </tr>
                </thead>
                <tbody>
                  {[...calc.ingredients]
                    .filter(i => i.totalKg > 0.0005 || i.totalPcs > 0)
                    .sort(sortIngredients)
                    .map((ing, idx) => (
                      <tr key={idx} className={`border-b border-slate-50 hover:bg-slate-50/50 transition-colors ${
                        ing.category === "PRO" ? "bg-red-50/30" :
                        ing.category === "PHF" ? "bg-blue-50/30" :
                        ing.category === "SPI" ? "bg-amber-50/20" : ""
                      }`}>
                        <td className="px-4 py-2.5">
                          {ing.category && (
                            <span className={`text-[8px] font-black px-1.5 py-0.5 rounded-md mr-1.5 ${catColor(ing.category)}`}>
                              {ing.category}
                            </span>
                          )}
                          <span className="font-medium text-slate-800">{ing.name}</span>
                          <AllergenTag allergen={ing.allergen} />
                  <GnTag trays={ing.gnTrays} gnType={ing.gnType} />
                          {ing.yieldPct && ing.yieldPct < 1 && (
                            <span className="ml-1.5 text-[8px] text-amber-600 font-bold">
                              {Math.round((1 - ing.yieldPct) * 100)}% Verlust
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-700">
                          {ing.totalPcs > 0 ? `${Math.round(ing.totalPcs)} Stk` : fmtKg(ing.totalKg)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-black tabular-nums text-blue-700">
                          {ing.totalPcs > 0 ? `${Math.round(ing.totalPcs)} Stk` : fmtKg(ing.perBatchKg)}
                        </td>
                      </tr>
                    ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 border-t-2 border-slate-200">
                    <td className="px-4 py-3 font-black text-slate-800 text-[11px] uppercase tracking-wide">Gesamt</td>
                    <td className="px-4 py-3 text-right font-black tabular-nums text-slate-800">{fmtKg(calc.totalKg)}</td>
                    <td className="px-4 py-3 text-right font-black tabular-nums text-blue-700">{fmtKg(calc.batches > 0 ? calc.totalKg / calc.batches : 0)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ) : (
          <div className={`rounded-2xl px-5 py-4 text-xs border ${
            !calc.recipeFound
              ? "bg-amber-50 border-amber-200 text-amber-700"
              : "bg-slate-50 border-slate-200 text-slate-500"
          }`}>
            <div className="font-bold mb-1">
              {!calc.recipeFound ? "⚠ Rezept nicht in App-Daten" : "⚠ Sub-Rezept nicht gefunden"}
            </div>
            <div className="text-[10px]">
              {!calc.recipeFound
                ? `Rezept "${row.recipeCode}" wurde nicht in den App-Daten gefunden. Zutaten-Berechnung nicht möglich.`
                : `Sub-Rezept "${row.subRecipeName}" konnte in den Gross-Ingredients nicht gematcht werden.`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
