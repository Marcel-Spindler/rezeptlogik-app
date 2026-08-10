// WMS Übersicht – WO-zentrierte Tabellen: Fortschrittspunkte, WO-Liste, Meal-Tabelle.
import React, { useMemo, useState } from "react";
import { STATION_META } from "./wmsTypes";
import type { AggWorkorderMeal, WoTransactionRow, WorkorderRow } from "./wmsTypes";
import { cleanName, fmtDate, fmtQty, mhdClass, skuKey } from "./wmsFormat";
import { woMatchesWeekNum } from "./wmsWeeks";
import type { SkuStationMap } from "./wmsIndex";
import { buildWoSummaries, STORAGE_STATIONS, woReadiness } from "./wmsWoLogic";
import type { WoSummary } from "./wmsWoLogic";
import { ShowMoreBar, SkuLabel, StationBadges, StatusBadge, Td, Th } from "./WmsPrimitives";
import { PlausibilityBadge, ReadinessBadge, WoStageChain } from "./WmsWoFlowWidgets";
import { RawDetailRow } from "./WmsAlertBanners";
import type { WmsSkuInfo } from "../../lib/wmsSkuEnrichment";

export function WoProgressDots({ wo }: { wo: WoSummary }) {
  const steps = [
    { done: wo.hasAllocation, label: "Alloc", color: "bg-blue-500" },
    { done: wo.hasPicking, label: "Pick", color: "bg-indigo-500" },
    { done: wo.hasDebox, label: "Debox", color: "bg-amber-500" },
    { done: wo.hasPreblast, label: "Pre-B", color: "bg-purple-500" },
    { done: wo.hasPostblast, label: "Post-B", color: "bg-emerald-500" },
    { done: wo.isClosed, label: "Close", color: "bg-slate-700" },
  ];
  return (
    <span className="inline-flex items-center gap-0.5" title={steps.filter(s => s.done).map(s => s.label).join(" → ") || "Noch keine Phase"}>
      {steps.map((s, i) => (
        <span key={i} className={`w-2 h-2 rounded-full ${s.done ? s.color : "bg-slate-200"}`} title={s.label} />
      ))}
    </span>
  );
}

export function WoListTable({ workorders, woTransactionMap, search, onWoDetail, onTrace }: {
  workorders: WorkorderRow[];
  woTransactionMap: Map<string, WoTransactionRow[]>;
  search: string;
  onWoDetail: (wo: string) => void;
  onTrace: (sku: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const needle = search.trim().toUpperCase();

  const allWos = useMemo(() => buildWoSummaries(workorders, woTransactionMap), [workorders, woTransactionMap]);

  const filtered = needle
    ? allWos.filter(wo =>
        wo.woNumber.toUpperCase().includes(needle) ||
        wo.mealSku.toUpperCase().includes(needle) ||
        wo.mealName.toUpperCase().includes(needle) ||
        wo.submeals.some(s => s.sku.toUpperCase().includes(needle) || s.name.toUpperCase().includes(needle))
      )
    : allWos;

  const shown = expanded ? filtered : filtered.slice(0, 40);

  if (allWos.length === 0) return <div className="px-4 py-5 text-slate-400 text-sm text-center">Keine Work Orders geladen</div>;

  return (
    <>
      <div className="px-3 py-2 flex items-center gap-3 text-[10px]">
        <span className="font-semibold text-slate-600">{allWos.length} WOs</span>
        <span className="text-slate-400">|</span>
        <span className="text-emerald-600 font-medium">{allWos.filter(w => w.isClosed).length} closed</span>
        <span className="text-blue-600 font-medium">{allWos.filter(w => !w.isClosed && w.tranCount > 0).length} in progress</span>
        <span className="text-slate-400 font-medium">{allWos.filter(w => w.tranCount === 0).length} pending</span>
        {allWos.some(w => w.wipRecon > 0) && (
          <span className="text-rose-600 font-medium">{allWos.filter(w => w.wipRecon > 0).length} mit Abweichungen</span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="border-b border-slate-200">
            <tr>
              <Th>WO-Nr</Th>
              <Th>Meal</Th>
              <Th>Submeals</Th>
              <Th right>Menge</Th>
              <Th right>Plates</Th>
              <Th>Fortschritt</Th>
              <Th>Status</Th>
              <Th>Frist</Th>
              <Th right>Transaktionen</Th>
              <Th>Kette</Th>
              <Th>Checks</Th>
              <Th>Stellplätze</Th>
              <Th>Abweichung</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(wo => {
              const isMatch = needle && wo.woNumber.toUpperCase().includes(needle);
              const expiryDays = wo.expiry ? Math.ceil((new Date(wo.expiry).getTime() - Date.now()) / 86_400_000) : null;
              const fristOverdue = expiryDays !== null && expiryDays < 0 && !wo.isClosed;
              const fristCritical = expiryDays !== null && expiryDays >= 0 && expiryDays < 1 && !wo.isClosed;
              const fristCls = fristOverdue ? "text-rose-700 font-bold"
                : fristCritical ? "text-amber-600 font-semibold"
                : "text-slate-500";
              return (
                <tr key={wo.woNumber} className={`hover:bg-violet-50/40 cursor-pointer ${isMatch ? "bg-amber-50/60 ring-1 ring-amber-300 ring-inset" : ""}`}
                  onClick={() => onWoDetail(wo.woNumber)}>
                  <Td mono cls="font-bold text-violet-700 text-sm">{wo.woNumber}</Td>
                  <Td cls="max-w-[200px] truncate">
                    <span className="font-mono text-[10px] text-slate-500">{wo.mealSku}</span>
                    <br />
                    <span className="text-slate-700">{wo.mealName}</span>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-0.5 max-w-[180px]">
                      {wo.submeals.slice(0, 3).map((s, i) => (
                        <span key={i} title={`${s.sku}: ${s.name}`}
                          className="px-1 py-0.5 rounded bg-slate-100 text-slate-600 text-[9px] font-mono truncate max-w-[80px]"
                          onClick={e => { e.stopPropagation(); onTrace(s.sku); }}>
                          {s.sku.replace(/^SUB-/, "").slice(0, 10)}
                        </span>
                      ))}
                      {wo.submeals.length > 3 && <span className="text-[9px] text-slate-400">+{wo.submeals.length - 3}</span>}
                    </div>
                  </Td>
                  <Td right mono cls="font-semibold">{wo.totalQty.toLocaleString("de-DE")}</Td>
                  <Td right mono>{wo.plates}</Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <WoProgressDots wo={wo} />
                      <span className="text-[9px] font-mono text-slate-500">{wo.progressPct}%</span>
                    </div>
                  </Td>
                  <Td>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                      wo.isClosed ? "bg-emerald-100 text-emerald-700" :
                      wo.tranCount > 0 ? "bg-blue-100 text-blue-700" :
                      "bg-slate-100 text-slate-500"
                    }`}>
                      {wo.isClosed ? "CLOSED" : wo.tranCount > 0 ? "ACTIVE" : "PENDING"}
                    </span>
                  </Td>
                  <Td cls={fristCls} title="Verarbeitungsfrist (nicht Rohware-MHD)">{wo.expiry ? wo.expiry.slice(0, 10) : "–"}{fristOverdue && " !"}</Td>
                  <Td right mono cls="text-slate-500">{wo.tranCount}</Td>
                  <Td><WoStageChain stages={wo.stageChain} /></Td>
                  <Td>
                    <div className="flex flex-wrap gap-0.5">
                      <PlausibilityBadge level={wo.worstPlausibility}>{wo.worstPlausibility.toUpperCase()}</PlausibilityBadge>
                      {wo.plausibilityChecks.filter((check) => check.level !== "offen").slice(0, 2).map((check) => (
                        <PlausibilityBadge key={check.key} level={check.level}>{check.label}</PlausibilityBadge>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-0.5 max-w-[180px]">
                      {wo.preBlastLocations.slice(0, 2).map((loc) => (
                        <span key={`pb-${loc}`} className="px-1 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 text-[9px] font-mono">
                          {loc}
                        </span>
                      ))}
                      {wo.locations.slice(0, Math.max(0, 3 - wo.preBlastLocations.length)).map((loc) => (
                        <span key={loc} className="px-1 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200 text-[9px] font-mono">
                          {loc}
                        </span>
                      ))}
                      {wo.preBlastLocations.length + wo.locations.length > 3 && <span className="text-[9px] text-slate-400">+{wo.preBlastLocations.length + wo.locations.length - 3}</span>}
                    </div>
                  </Td>
                  <Td>
                    {wo.wipRecon > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[9px] font-mono font-semibold">
                        {wo.wipRecon.toLocaleString("de-DE")}
                      </span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > 40 && !expanded && (
        <div className="px-4 py-2 text-center">
          <button type="button" onClick={() => setExpanded(true)}
            className="text-xs text-violet-600 hover:text-violet-800 font-medium cursor-pointer">
            Alle {filtered.length} WOs anzeigen
          </button>
        </div>
      )}
      {expanded && filtered.length > 40 && (
        <div className="px-4 py-2 text-center">
          <button type="button" onClick={() => setExpanded(false)}
            className="text-xs text-slate-500 hover:text-slate-700 font-medium cursor-pointer">
            Weniger anzeigen
          </button>
        </div>
      )}
    </>
  );
}

export function WorkordersMealTable({ meals, skuMap, search, weekNum, onTrace, onDetail, onWoDetail, skuInfoIndex }: {
  meals: AggWorkorderMeal[]; skuMap: SkuStationMap; search: string;
  weekNum: number | null;
  onTrace: (sku: string) => void; onDetail: (sku: string) => void; onWoDetail: (wo: string) => void; skuInfoIndex: Map<string, WmsSkuInfo>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openMeals, setOpenMeals] = useState<Set<string>>(new Set());
  const [showMissingOnly, setShowMissingOnly] = useState(false);
  const needle = search.trim().toUpperCase();

  const filtered = (needle
    ? meals.filter(m =>
        m.mealSku.includes(needle) ||
        m.mealName.toUpperCase().includes(needle) ||
        m.statuses.some(s => s.toUpperCase().includes(needle)) ||
        m.submeals.some(s => s.submealItemNumber.toUpperCase().includes(needle) || s.woNumber.toUpperCase().includes(needle))
      )
    : meals
  ).filter(m => !showMissingOnly || woReadiness(m.submeals, skuMap).pct < 100);

  const shown = expanded ? filtered : filtered.slice(0, 20);
  const toggleMeal = (sku: string) =>
    setOpenMeals(prev => {
      const s = new Set(prev);
      if (s.has(sku)) s.delete(sku);
      else s.add(sku);
      return s;
    });

  if (meals.length === 0) return <div className="px-4 py-5 text-slate-400 text-sm text-center">Keine Work Orders geladen — Server starten oder KW laden</div>;

  const missingCount = meals.filter(m => woReadiness(m.submeals, skuMap).pct < 100).length;
  const distinctWeeks = [...new Set(meals.flatMap(m => m.weeks))].sort();

  return (
    <>
      <div className="px-4 pt-3 flex items-center gap-2 flex-wrap">
        {missingCount > 0 && (
          <button
            type="button"
            onClick={() => setShowMissingOnly(m => !m)}
            className={`text-xs px-3 py-1 rounded-full font-semibold border transition-colors ${showMissingOnly ? "bg-rose-600 text-white border-rose-600" : "bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100"}`}
          >
            {showMissingOnly ? "✕ Alle anzeigen" : `Nur unvollständig (${missingCount})`}
          </button>
        )}
        {distinctWeeks.length > 0 && (
          <span className="text-[11px] text-slate-400 font-mono">
            KW in DB: {distinctWeeks.join(", ")}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="border-b border-slate-200">
            <tr>
              <Th></Th>
              <Th>Meal-SKU</Th>
              <Th>Meal-Name</Th>
              <Th>KW</Th>
              <Th right>Menge</Th>
              <Th right>Platten</Th>
              <Th right>Pre-Blast</Th>
              <Th>Bereitschaft</Th>
              <Th>Status</Th>
              <Th>Frist</Th>
              <Th>WO-Nr</Th>
              <Th>Submeals</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(meal => {
              const isOpen    = openMeals.has(meal.mealSku);
              const isMatch   = needle && (meal.mealSku.includes(needle) || meal.mealName.toUpperCase().includes(needle));
              const readiness = woReadiness(meal.submeals, skuMap);
              return (
                <React.Fragment key={meal.mealSku}>
                  <tr className={`hover:bg-violet-50/30 ${isMatch ? "bg-amber-50/60 ring-1 ring-amber-300 ring-inset" : ""}`}>
                    <Td>
                      <button type="button" onClick={() => toggleMeal(meal.mealSku)} className="text-slate-400 hover:text-slate-700 w-4 text-center font-mono text-[11px]">
                        {isOpen ? "▼" : "▶"}
                      </button>
                    </Td>
                    <Td mono cls="font-semibold text-violet-700">
                      <span className="hover:underline cursor-pointer" title="Details anzeigen" onClick={() => onDetail(meal.mealSku)}>
                        <SkuLabel sku={meal.mealSku} skuInfoIndex={skuInfoIndex} />
                      </span>
                      <StationBadges sku={meal.mealSku} stationMap={skuMap} currentStation="workorders" onTrace={onTrace} />
                    </Td>
                    <Td cls="max-w-[240px] truncate text-slate-700" title={meal.mealName}>{meal.mealName}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-0.5">
                        {meal.weeks.slice(0, 3).map(w => (
                          <span key={w} className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-semibold border ${
                            woMatchesWeekNum(w, weekNum)
                              ? "bg-violet-100 text-violet-700 border-violet-300"
                              : "bg-slate-100 text-slate-500 border-slate-200"
                          }`}>{w}</span>
                        ))}
                        {meal.weeks.length > 3 && <span className="text-[9px] text-slate-400">+{meal.weeks.length - 3}</span>}
                      </div>
                    </Td>
                    <Td right mono cls="font-bold text-slate-800">{fmtQty(meal.totalQty)}</Td>
                    <Td right mono>{fmtQty(meal.totalPlates)}</Td>
                    <Td right mono cls={meal.totalPreBlast > 0 ? "text-rose-600 font-semibold" : "text-slate-300"}>{meal.totalPreBlast > 0 ? fmtQty(meal.totalPreBlast) : "–"}</Td>
                    <Td><ReadinessBadge {...readiness} /></Td>
                    <Td>
                      {meal.statuses.length > 0
                        ? <div className="flex flex-wrap gap-0.5">{meal.statuses.map(s => <StatusBadge key={s} status={s} />)}</div>
                        : <span className="text-slate-300 text-xs">–</span>
                      }
                    </Td>
                    <Td cls={mhdClass(meal.nextExpiry)}>{fmtDate(meal.nextExpiry)}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-0.5">
                        {[...new Set(meal.submeals.map(s => s.woNumber).filter(Boolean))].slice(0, 4).map(wo => (
                          <button key={wo} type="button" onClick={() => onWoDetail(wo)}
                            className="px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200 text-[9px] font-mono font-semibold hover:bg-violet-100 cursor-pointer">
                            {wo}
                          </button>
                        ))}
                        {[...new Set(meal.submeals.map(s => s.woNumber).filter(Boolean))].length > 4 && (
                          <span className="text-[9px] text-slate-400">+{[...new Set(meal.submeals.map(s => s.woNumber).filter(Boolean))].length - 4}</span>
                        )}
                      </div>
                    </Td>
                    <Td><span className="text-xs text-slate-500 font-mono">{meal.submeals.length}x</span></Td>
                  </tr>
                  {isOpen && (
                    <RawDetailRow>
                      <div className="text-[10px] font-semibold text-violet-600 mb-1.5">Zutaten — {meal.submeals.length} Submeals</div>
                      <div className="overflow-x-auto">
                        <table className="text-[10px] border-collapse w-full">
                          <thead>
                            <tr className="text-slate-400 border-b border-slate-200">
                              {["Verfügbar","Submeal-SKU","Bezeichnung","Menge","Platten","Pre-Blast","Pre-Blast Ort","Status","MHD","WO-Nr","Lager-Stationen"].map((h,i) => (
                                <td key={h} className={`pb-1 pr-3 font-semibold ${[3,4,5].includes(i)?"text-right":""}`}>{h}</td>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {meal.submeals.map((sub, i) => {
                              const subSku = skuKey(sub.submealItemNumber);
                              const subStations = skuMap.get(subSku);
                              const inStorage = subStations && STORAGE_STATIONS.some(s => subStations.has(s));
                              const storageIcons = STORAGE_STATIONS.filter(s => subStations?.has(s));
                              return (
                                <tr key={i} className={`hover:bg-white ${!inStorage ? "bg-rose-50/40" : ""}`}>
                                  <td className="pr-3 py-0.5">
                                    {inStorage
                                      ? <span className="text-emerald-600 font-bold">✓</span>
                                      : <span className="text-rose-600 font-bold">✗</span>
                                    }
                                  </td>
                                  <td className="pr-3 font-mono font-semibold text-violet-600">
                                    <span className="cursor-pointer hover:underline" onClick={() => onTrace(sub.submealItemNumber)}>{sub.submealItemNumber}</span>
                                  </td>
                                  <td className="pr-3 max-w-[180px] truncate" title={cleanName(sub.submealItemDescription)}>{cleanName(sub.submealItemDescription)}</td>
                                  <td className="pr-3 text-right font-mono font-semibold">{fmtQty(sub.quantity)}</td>
                                  <td className="pr-3 text-right font-mono">{fmtQty(sub.plates)}</td>
                                  <td className={`pr-3 text-right font-mono ${sub.preBlastQuantity ? "text-rose-600 font-semibold" : "text-slate-300"}`}>
                                    {sub.preBlastQuantity ? fmtQty(sub.preBlastQuantity) : "–"}
                                  </td>
                                  <td className="pr-3 font-mono text-slate-600">{sub.preBlastLocation || "–"}</td>
                                  <td className="pr-3"><StatusBadge status={sub.status} /></td>
                                  <td className={`pr-3 ${mhdClass(sub.expirationDate)}`}>{fmtDate(sub.expirationDate)}</td>
                                  <td className="pr-3 font-mono">
                                    <button type="button" onClick={() => onWoDetail(sub.woNumber)}
                                      className="text-violet-600 hover:text-violet-800 hover:underline cursor-pointer font-semibold">
                                      {sub.woNumber}
                                    </button>
                                  </td>
                                  <td>
                                    <span className="inline-flex gap-0.5">
                                      {storageIcons.length > 0
                                        ? storageIcons.map(s => (
                                            <span key={s} title={STATION_META[s].label} className={`text-[9px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>
                                              {STATION_META[s].icon}
                                            </span>
                                          ))
                                        : <span className="text-rose-400 font-semibold">nicht im Lager</span>
                                      }
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </RawDetailRow>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <ShowMoreBar total={filtered.length} shown={shown.length} expanded={expanded} onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)} />
    </>
  );
}

