// WMS Übersicht – vollständiges WO-Detail-Panel (Transaktionshistorie je Work Order).
import type { AggSleevingRow, WoDetailPayload, WoTransactionRow, WorkorderRow } from "./wmsTypes";
import { fmtDate, fmtQty, skuKey } from "./wmsFormat";
import { buildWoPlausibilityChecks, buildWoStageChain, buildWoTransitions } from "./wmsWoLogic";
import { PlausibilityBadge, WoFlowGraph, WoPlausibilityPanel, WoStageChain, WoTransitionTable } from "./WmsWoFlowWidgets";

// ─── WO Detail Panel ─────────────────────────────────────────────────────────

export const WO_TRAN_TYPE_LABELS: Record<string, string> = {
  "370": "Allocation",
  "371": "Release Picking",
  "372": "Deallocation",
  "373": "Cancellation",
  "374": "Picking Hold",
  "380": "Picking (Pick)",
  "381": "Picking (Put)",
  "386": "Debox QC",
  "387": "→ DEBOXWIP",
  "393": "Staging → Debox",
  "650": "Postblast Update",
  "651": "Preblast LP Created",
  "652": "Preblast LP Deleted",
  "653": "Kitchen Decrement",
  "655": "Kitchen Increment",
  "656": "Prepped LP Created",
  "657": "Ingredient Decrement",
  "660": "KITCHENWIP Adjust",
  "661": "Close WO",
  "026": "Move to Lost",
  "084": "Return from WIP",
  "086": "WIP Reconciliation",
  "369": "WO Target Update",
};

export const WO_PHASE_ORDER = ["370", "371", "380", "381", "393", "386", "387", "086", "651", "653", "650", "660", "661"];

export function WoTranTypeBadge({ code }: { code: string }) {
  const label = WO_TRAN_TYPE_LABELS[code] ?? code;
  const isPickPhase = ["380", "381", "371"].includes(code);
  const isDeboxPhase = ["386", "387", "393"].includes(code);
  const isKitchenPhase = ["651", "653", "650", "660"].includes(code);
  const isClosePhase = code === "661";
  const isWarnPhase = ["086", "372", "373", "026"].includes(code);
  const cls = isClosePhase ? "bg-emerald-100 text-emerald-700 border-emerald-200"
    : isWarnPhase ? "bg-rose-100 text-rose-700 border-rose-200"
    : isPickPhase ? "bg-blue-100 text-blue-700 border-blue-200"
    : isDeboxPhase ? "bg-amber-100 text-amber-700 border-amber-200"
    : isKitchenPhase ? "bg-purple-100 text-purple-700 border-purple-200"
    : "bg-slate-100 text-slate-600 border-slate-200";
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>{label}</span>;
}

export function WoDetailPanel({ woNumber, transactions, workorders, detailMeta, aggSleeving, onClose, onTrace }: {
  woNumber: string;
  transactions: WoTransactionRow[];
  workorders: WorkorderRow[];
  detailMeta?: WoDetailPayload;
  aggSleeving?: AggSleevingRow[];
  onClose: () => void;
  onTrace: (sku: string) => void;
}) {
  const woRows = workorders.filter(r => r.woNumber === woNumber);
  const mealName = woRows[0]?.mealItemDescription || (transactions[0]?.description || "–");
  const woStatus = woRows[0]?.status || "";
  const woWeek = woRows[0]?.week || woNumber.split("-")[0] || "–";
  const isClosed = transactions.some(t => t.tranType === "661");

  // Expiry check — this is the processing deadline (Verarbeitungsfrist), NOT ingredient MHD
  const expiryDates = woRows.map(r => r.expirationDate).filter(Boolean) as string[];
  const earliestExpiry = expiryDates.length > 0 ? expiryDates.sort()[0] : null;
  const daysToExpiry = earliestExpiry ? Math.ceil((new Date(earliestExpiry).getTime() - Date.now()) / 86_400_000) : null;
  const fristOverdue = daysToExpiry !== null && daysToExpiry < 0 && !isClosed;
  const fristCritical = daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry < 1 && !isClosed;

  // Submeals
  const submeals = woRows.map(r => ({
    sku: r.submealItemNumber,
    name: r.submealItemDescription,
    qty: r.quantity ?? 0,
    uom: r.uom,
    plates: r.plates ?? 0,
    preBlast: r.preBlastQuantity ?? 0,
    preBlastLocation: r.preBlastLocation,
  }));

  // Timeline (grouped by tran type)
  const phaseGroups = new Map<string, WoTransactionRow[]>();
  for (const t of transactions) {
    if (!phaseGroups.has(t.tranType)) phaseGroups.set(t.tranType, []);
    phaseGroups.get(t.tranType)!.push(t);
  }

  // Quantities summary
  const totalAllocated = transactions.filter(t => t.tranType === "370").reduce((s, t) => s + (t.tranQty ?? 0), 0);
  const totalPicked = transactions.filter(t => t.tranType === "380").reduce((s, t) => s + Math.abs(t.tranQty ?? 0), 0);
  const totalDeboxed = transactions.filter(t => t.tranType === "386").reduce((s, t) => s + (t.tranQty ?? 0), 0);
  const totalPreblast = transactions.filter(t => t.tranType === "651").reduce((s, t) => s + (t.tranQty ?? 0), 0);
  const totalPostblast = transactions.filter(t => t.tranType === "650").reduce((s, t) => s + Math.abs(t.tranQty ?? 0), 0);
  const totalWipRecon = transactions.filter(t => t.tranType === "086").reduce((s, t) => s + Math.abs(t.tranQty ?? 0), 0);

  // Progress calculation
  const phases = ["370", "371", "380", "393", "386", "651", "650", "661"];
  const completedPhases = phases.filter(p => transactions.some(t => t.tranType === p));
  const progressPct = Math.round((completedPhases.length / phases.length) * 100);

  // Employees
  const employees = [...new Set(transactions.map(t => t.employeeId).filter(Boolean))];

  // Items involved
  const items = [...new Set(transactions.map(t => t.itemNumber).filter(Boolean))];

  // Lots
  const lots = [...new Set(transactions.map(t => t.lotNumber).filter(Boolean))];

  const preBlastLocations = [...new Set(woRows.map(r => String(r.preBlastLocation ?? "").trim()).filter(Boolean))].sort();
  const locations = [...new Set(transactions.flatMap(t => [t.locationId, t.locationId2]).map(v => String(v ?? "").trim()).filter(Boolean))].sort();
  const movementRows = transactions
    .map((t) => ({
      tranType: t.tranType,
      itemNumber: t.itemNumber,
      from: String(t.locationId ?? "").trim(),
      to: String(t.locationId2 ?? "").trim(),
      lot: String(t.lotNumber ?? "").trim(),
      hu: String(t.huId ?? "").trim(),
      qty: t.tranQty ?? 0,
      ts: t.endTranDate ?? t.startTranDate ?? "",
    }))
    .filter((row) => row.from || row.to || row.lot || row.hu)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const aggregatedTransitions = buildWoTransitions(transactions);
  const stageChain = buildWoStageChain(woRows, transactions);
  const woSleevingLost = aggSleeving
    ? aggSleeving.filter(r => woRows.some(w => skuKey(w.submealItemNumber) === r.sku)).reduce((s, r) => s + r.lost, 0)
    : 0;
  const plausibilityChecks = buildWoPlausibilityChecks(
    woRows.reduce((sum, row) => sum + (row.quantity ?? 0), 0),
    woRows.reduce((sum, row) => sum + (row.preBlastQuantity ?? 0), 0),
    totalPreblast,
    totalPostblast,
    woSleevingLost,
  );
  const worstPlausibility = plausibilityChecks.some((check) => check.level === "err")
    ? "err"
    : plausibilityChecks.some((check) => check.level === "warn")
      ? "warn"
      : plausibilityChecks.some((check) => check.level === "ok")
        ? "ok"
        : "offen";
  const itemLocationRows = items.map((itemNumber) => {
    const itemTrans = transactions.filter((row) => row.itemNumber === itemNumber);
    const itemLots = [...new Set(itemTrans.map((row) => row.lotNumber).filter(Boolean))];
    const itemLocations = [...new Set(itemTrans.flatMap((row) => [row.locationId, row.locationId2]).map((value) => String(value ?? "").trim()).filter(Boolean))];
    const itemStages = buildWoStageChain(woRows.filter((row) => row.submealItemNumber === itemNumber || row.mealItemNumber === itemNumber), itemTrans);
    const itemTransitions = buildWoTransitions(itemTrans);
    return { itemNumber, itemLots, itemLocations, itemStages, itemTransitions, tranCount: itemTrans.length };
  });
  const isCacheDerived = detailMeta?.source === "firestore-cache-derived";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-[900px] max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-bold text-slate-800">WO {woNumber}</span>
            <span className="text-sm text-slate-500">{mealName}</span>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${isClosed ? "bg-emerald-100 text-emerald-700" : woStatus ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
              {isClosed ? "CLOSED" : woStatus || (transactions.length > 0 ? "IN PROGRESS" : "UNKNOWN")}
            </span>
            <span className="text-xs text-slate-400">KW {woWeek}</span>
            {detailMeta?.source && (
              <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${isCacheDerived ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-slate-50 text-slate-600 border-slate-200"}`}>
                {isCacheDerived ? "CACHE-FALLBACK" : detailMeta.source}
              </span>
            )}
            {!isClosed && transactions.length > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="w-16 h-2 bg-slate-200 rounded-full overflow-hidden">
                  <span className={`block h-full rounded-full ${progressPct >= 80 ? "bg-emerald-500" : progressPct >= 50 ? "bg-blue-500" : "bg-amber-500"}`} style={{ width: `${progressPct}%` }} />
                </span>
                <span className="text-[10px] font-mono text-slate-500">{progressPct}%</span>
              </span>
            )}
          </div>
          {detailMeta?.cachedAt && isCacheDerived && (
            <div className="text-[10px] text-amber-700 mt-1">
              Detail aus Firestore-Cache abgeleitet · Cache-Stand {fmtDate(detailMeta.cachedAt)}
            </div>
          )}
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl font-bold px-2">✕</button>
        </div>

        {/* Verarbeitungsfrist Alert */}
        {(fristOverdue || fristCritical) && (
          <div className={`mx-5 mt-3 px-3 py-2 rounded-lg border text-sm font-medium ${
            fristOverdue ? "bg-rose-50 border-rose-300 text-rose-700" :
            "bg-amber-50 border-amber-300 text-amber-700"
          }`}>
            {fristOverdue
              ? `VERARBEITUNGSFRIST ÜBERSCHRITTEN seit ${Math.abs(daysToExpiry!)} Tag(en) — WO noch nicht abgeschlossen!`
              : `Verarbeitungsfrist läuft heute ab (${earliestExpiry?.slice(0, 10)})`}
          </div>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-6 gap-2 px-5 py-3">
          {[
            { label: "Allocated", value: totalAllocated.toLocaleString("de-DE"), color: "text-blue-600" },
            { label: "Picked", value: totalPicked.toLocaleString("de-DE"), color: "text-indigo-600" },
            { label: "Deboxed", value: totalDeboxed.toLocaleString("de-DE"), color: "text-amber-600" },
            { label: "Preblast", value: totalPreblast.toLocaleString("de-DE"), color: "text-purple-600" },
            { label: "Postblast", value: totalPostblast.toLocaleString("de-DE"), color: "text-emerald-600" },
            { label: "WIP Recon", value: totalWipRecon.toLocaleString("de-DE"), color: totalWipRecon > 0 ? "text-rose-600" : "text-slate-400" },
          ].map(k => (
            <div key={k.label} className="bg-slate-50 rounded-lg px-2 py-2 text-center">
              <div className="text-[10px] uppercase font-semibold text-slate-500">{k.label}</div>
              <div className={`font-mono font-bold text-lg ${k.color}`}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Submeals */}
        {submeals.length > 0 && (
          <div className="px-5 pb-3">
            <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Submeals ({submeals.length})</div>
            <div className="overflow-x-auto rounded border border-slate-200">
              <table className="w-full text-xs">
                <thead><tr className="bg-slate-50">
                  <th className="px-2 py-1 text-left font-semibold text-slate-500">SKU</th>
                  <th className="px-2 py-1 text-left font-semibold text-slate-500">Name</th>
                  <th className="px-2 py-1 text-right font-semibold text-slate-500">Menge</th>
                  <th className="px-2 py-1 text-center font-semibold text-slate-500">UOM</th>
                  <th className="px-2 py-1 text-right font-semibold text-slate-500">Plates</th>
                  <th className="px-2 py-1 text-right font-semibold text-slate-500">Pre-Blast</th>
                  <th className="px-2 py-1 text-left font-semibold text-slate-500">Pre-Blast Ort</th>
                </tr></thead>
                <tbody>
                  {submeals.map((s, i) => (
                    <tr key={i} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => onTrace(s.sku)}>
                      <td className="px-2 py-1 font-mono text-blue-600">{s.sku}</td>
                      <td className="px-2 py-1 truncate max-w-[200px]">{s.name}</td>
                      <td className="px-2 py-1 text-right font-mono">{s.qty.toLocaleString("de-DE")}</td>
                      <td className="px-2 py-1 text-center">{s.uom}</td>
                      <td className="px-2 py-1 text-right font-mono">{s.plates}</td>
                      <td className="px-2 py-1 text-right font-mono">{s.preBlast.toLocaleString("de-DE")}</td>
                      <td className="px-2 py-1 font-mono text-slate-600">{s.preBlastLocation || "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(preBlastLocations.length > 0 || locations.length > 0) && (
          <div className="grid grid-cols-2 gap-4 px-5 pb-3">
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Pre-Blast Stellplätze ({preBlastLocations.length})</div>
              <div className="flex flex-wrap gap-1">
                {preBlastLocations.length > 0 ? preBlastLocations.map((loc) => (
                  <span key={loc} className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-mono">
                    {loc}
                  </span>
                )) : <span className="text-[10px] text-slate-400">–</span>}
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Snowflake Stellplätze ({locations.length})</div>
              <div className="flex flex-wrap gap-1">
                {locations.length > 0 ? locations.map((loc) => (
                  <span key={loc} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-mono">
                    {loc}
                  </span>
                )) : <span className="text-[10px] text-slate-400">–</span>}
              </div>
            </div>
          </div>
        )}

        <div className="px-5 pb-3">
          <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Stationskette</div>
          <WoStageChain stages={stageChain} />
        </div>

        <details className="mx-5 rounded-lg border border-slate-200 bg-slate-50" open={false}>
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold uppercase text-slate-600">Extra: Flow-Ansicht</summary>
          <div className="border-t border-slate-200 p-3">
            <WoFlowGraph transitions={aggregatedTransitions} />
          </div>
        </details>

        <div className="px-5 pb-3">
          <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Echte Übergänge</div>
          <WoTransitionTable transitions={aggregatedTransitions} emptyLabel="Keine Von/Nach-Übergänge in Snowflake gefunden" />
        </div>

        <div className="px-5 pb-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
            <span>Plausibilitätscheck</span>
            <PlausibilityBadge level={worstPlausibility}>{worstPlausibility.toUpperCase()}</PlausibilityBadge>
          </div>
          <WoPlausibilityPanel checks={plausibilityChecks} />
        </div>

        {/* Sleeving-Bilanz für dieses WO */}
        {aggSleeving && aggSleeving.length > 0 && (() => {
          const woSkus = new Set(woRows.map(r => skuKey(r.submealItemNumber)).filter(Boolean));
          const relevantSleeving = aggSleeving.filter(r => woSkus.has(r.sku));
          if (relevantSleeving.length === 0) return null;
          const totalEin = relevantSleeving.reduce((s, r) => s + r.eingang, 0);
          const totalAus = relevantSleeving.reduce((s, r) => s + r.ausgang, 0);
          const totalLost = relevantSleeving.reduce((s, r) => s + r.lost, 0);
          const totalNet = relevantSleeving.reduce((s, r) => s + r.net, 0);
          const lossRate = totalEin > 0 ? totalLost / totalEin : 0;
          const isHigh = lossRate > 0.1;
          return (
            <div className="px-5 pb-3">
              <div className="text-xs font-semibold text-slate-500 uppercase mb-1">🔄 Sleeving-Bilanz (WO-Items)</div>
              <div className={`rounded-lg border p-3 space-y-2 ${isHigh ? "border-rose-300 bg-rose-50" : "border-sky-200 bg-sky-50"}`}>
                <div className="grid grid-cols-5 gap-2 text-center text-xs">
                  <div><div className="text-emerald-700 font-bold font-mono">{fmtQty(totalEin)}</div><div className="text-[9px] text-slate-500">Eingang</div></div>
                  <div><div className="text-orange-600 font-bold font-mono">{fmtQty(totalAus)}</div><div className="text-[9px] text-slate-500">Ausgang</div></div>
                  <div><div className={`font-bold font-mono ${totalNet >= 0 ? "text-emerald-700" : "text-rose-700"}`}>{fmtQty(totalNet)}</div><div className="text-[9px] text-slate-500">Netto</div></div>
                  <div><div className={`font-bold font-mono ${totalLost > 0 ? "text-rose-700" : "text-slate-300"}`}>{totalLost > 0 ? fmtQty(totalLost) : "–"}</div><div className="text-[9px] text-slate-500">Verlust</div></div>
                  <div><div className={`font-bold font-mono ${isHigh ? "text-rose-700" : "text-slate-600"}`}>{(lossRate * 100).toFixed(1)}%</div><div className="text-[9px] text-slate-500">Verlustrate</div></div>
                </div>
                {isHigh && <div className="text-[10px] text-rose-700 font-semibold text-center">⚠️ Hoher Yield-Verlust ({(lossRate * 100).toFixed(0)}%) für dieses WO!</div>}
                {relevantSleeving.length > 1 && (
                  <div className="border-t border-slate-200 pt-2 space-y-1">
                    {relevantSleeving.map(r => (
                      <div key={r.sku} className="flex items-center justify-between text-[10px]">
                        <span className="font-mono text-slate-700">{r.sku}</span>
                        <span className="flex gap-2">
                          <span className="text-emerald-600">↓{fmtQty(r.eingang)}</span>
                          <span className="text-orange-600">↑{fmtQty(r.ausgang)}</span>
                          {r.lost > 0 && <span className="text-rose-600 font-semibold">−{fmtQty(r.lost)}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        <div className="px-5 pb-3">
          <div className="text-xs font-semibold text-slate-500 uppercase mb-1">WO-Hierarchie</div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2 py-1 rounded bg-violet-100 text-violet-700 border border-violet-200 text-[11px] font-bold">WO {woNumber}</span>
              <span className="px-2 py-1 rounded bg-white border border-slate-200 text-[11px] font-mono text-slate-700">Meal {woRows[0]?.mealItemNumber || "–"}</span>
              <span className="text-[11px] text-slate-500">{mealName}</span>
            </div>
            <div className="pl-4 border-l-2 border-violet-200 space-y-2">
              {submeals.map((sub) => {
                const itemNode = itemLocationRows.find((row) => row.itemNumber === sub.sku);
                return (
                  <details key={`${sub.sku}-${sub.name}`} className="rounded border border-slate-200 bg-white p-2 group" open>
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
                      <span className="text-slate-400 group-open:rotate-90 transition-transform">▶</span>
                      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onTrace(sub.sku); }} className="font-mono text-[11px] font-semibold text-violet-700 hover:underline">
                        {sub.sku}
                      </button>
                      <span className="text-[11px] text-slate-700">{sub.name}</span>
                      <span className="text-[10px] font-mono text-slate-500">{fmtQty(sub.qty)} {sub.uom}</span>
                      {sub.preBlastLocation && <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 text-[9px] font-mono">{sub.preBlastLocation}</span>}
                    </summary>
                    {itemNode && (
                      <div className="mt-2 pl-3 border-l border-slate-200 space-y-2">
                        <WoStageChain stages={itemNode.itemStages} />
                        <div className="flex flex-wrap gap-1 text-[10px] text-slate-500">
                          <span className="font-mono">{itemNode.tranCount} Transaktionen</span>
                          {itemNode.itemLots.length > 0 && <span>Lose: {itemNode.itemLots.join(", ")}</span>}
                          {itemNode.itemLocations.length > 0 && <span>Stellplätze: {itemNode.itemLocations.join(", ")}</span>}
                        </div>
                        <WoTransitionTable transitions={itemNode.itemTransitions} emptyLabel="Keine echten Übergänge für dieses Submeal" />
                      </div>
                    )}
                  </details>
                );
              })}
            </div>
          </div>
        </div>

        {/* Timeline */}
        <div className="px-5 pb-3">
          <div className="text-xs font-semibold text-slate-500 uppercase mb-1">
            Lifecycle ({transactions.length} Transaktionen)
          </div>
          <div className="space-y-1">
            {WO_PHASE_ORDER.filter(code => phaseGroups.has(code)).map(code => {
              const rows = phaseGroups.get(code)!;
              const totalQty = rows.reduce((s, r) => s + Math.abs(r.tranQty ?? 0), 0);
              const firstDate = rows[0]?.startTranDate?.slice(0, 10) ?? "–";
              return (
                <div key={code} className="flex items-center gap-2 bg-slate-50 rounded px-2 py-1.5">
                  <WoTranTypeBadge code={code} />
                  <span className="font-mono text-xs font-semibold flex-1">{totalQty.toLocaleString("de-DE")}</span>
                  <span className="text-[10px] text-slate-400">{rows.length}×</span>
                  <span className="text-[10px] text-slate-500">{firstDate}</span>
                </div>
              );
            })}
            {/* Show remaining types not in phase order */}
            {[...phaseGroups.keys()].filter(k => !WO_PHASE_ORDER.includes(k)).map(code => {
              const rows = phaseGroups.get(code)!;
              const totalQty = rows.reduce((s, r) => s + Math.abs(r.tranQty ?? 0), 0);
              return (
                <div key={code} className="flex items-center gap-2 bg-slate-50 rounded px-2 py-1.5">
                  <WoTranTypeBadge code={code} />
                  <span className="font-mono text-xs font-semibold flex-1">{totalQty.toLocaleString("de-DE")}</span>
                  <span className="text-[10px] text-slate-400">{rows.length}×</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Items & Lots */}
        <div className="grid grid-cols-2 gap-4 px-5 pb-3">
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Items ({items.length})</div>
            <div className="flex flex-wrap gap-1">
              {items.slice(0, 20).map(item => (
                <button key={item} type="button" onClick={() => onTrace(item)}
                  className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-mono hover:bg-blue-100 cursor-pointer">
                  {item}
                </button>
              ))}
              {items.length > 20 && <span className="text-[10px] text-slate-400">+{items.length - 20} weitere</span>}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Lose ({lots.length})</div>
            <div className="flex flex-wrap gap-1">
              {lots.slice(0, 15).map(lot => (
                <span key={lot} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200 text-[10px] font-mono">
                  {lot}
                </span>
              ))}
              {lots.length > 15 && <span className="text-[10px] text-slate-400">+{lots.length - 15} weitere</span>}
            </div>
          </div>
        </div>

        {/* Employees */}
        {employees.length > 0 && (
          <div className="px-5 pb-4">
            <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Mitarbeiter ({employees.length})</div>
            <div className="flex flex-wrap gap-1">
              {employees.map(emp => (
                <span key={emp} className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px]">{emp}</span>
              ))}
            </div>
          </div>
        )}

        {movementRows.length > 0 && (
          <div className="px-5 pb-4">
            <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Stellplatz-Bewegungen ({movementRows.length})</div>
            <div className="overflow-x-auto rounded border border-slate-200">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="bg-slate-50">
                    <th className="px-2 py-1 text-left font-semibold text-slate-500">Zeit</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-500">Typ</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-500">Item</th>
                    <th className="px-2 py-1 text-right font-semibold text-slate-500">Menge</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-500">Von</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-500">Nach</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-500">Lot</th>
                    <th className="px-2 py-1 text-left font-semibold text-slate-500">HU</th>
                  </tr>
                </thead>
                <tbody>
                  {movementRows.slice(0, 80).map((row, i) => (
                    <tr key={`${row.tranType}-${row.itemNumber}-${row.ts}-${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-2 py-1 text-slate-500">{row.ts ? fmtDate(row.ts) : "–"}</td>
                      <td className="px-2 py-1"><WoTranTypeBadge code={row.tranType} /></td>
                      <td className="px-2 py-1 font-mono text-blue-700">{row.itemNumber || "–"}</td>
                      <td className="px-2 py-1 text-right font-mono">{fmtQty(row.qty)}</td>
                      <td className="px-2 py-1 font-mono text-slate-600">{row.from || "–"}</td>
                      <td className="px-2 py-1 font-mono text-slate-600">{row.to || "–"}</td>
                      <td className="px-2 py-1 font-mono text-slate-500">{row.lot || "–"}</td>
                      <td className="px-2 py-1 font-mono text-slate-500">{row.hu || "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {movementRows.length > 80 && <div className="pt-1 text-[10px] text-slate-400">Anzeige gekürzt auf 80 Bewegungen.</div>}
          </div>
        )}

        {/* Discrepancies */}
        {totalWipRecon > 0 && (
          <div className="mx-5 mb-4 px-3 py-2 rounded-lg border border-rose-200 bg-rose-50">
            <div className="text-xs font-semibold text-rose-700 uppercase mb-1">Missstände / Abweichungen</div>
            <div className="text-sm text-rose-600">
              WIP Reconciliation: {totalWipRecon.toLocaleString("de-DE")} Einheiten wurden als Differenz erfasst
            </div>
            {transactions.filter(t => t.tranType === "086").slice(0, 5).map((t, i) => (
              <div key={i} className="text-[10px] text-rose-500 mt-0.5">
                {t.itemNumber}: {t.tranQty?.toLocaleString("de-DE")} @ {t.startTranDate?.slice(0, 10)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

