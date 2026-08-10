// WMS Übersicht – reine WO-Flow-Logik: Standort-Klassifikation, Übergänge,
// Plausibilitätsprüfungen, Bereitschaft, WO-Zusammenfassungen.
import type { StationKey, WoTransactionRow, WorkorderRow } from "./wmsTypes";
import { maxDate, skuKey } from "./wmsFormat";
import type { SkuStationMap } from "./wmsIndex";

// ─── Station: Work Orders ─────────────────────────────────────────────────────

export const STORAGE_STATIONS: StationKey[] = ["inbound", "staging", "debox", "postblast", "plating"];

export type WoFlowStageKey = "workorders" | "inbound" | "staging" | "debox" | "preblast" | "postblast" | "sleeving" | "plating" | "kitchen" | "other";

export const WO_FLOW_META: Record<WoFlowStageKey, { label: string; icon: string; className: string; rank: number }> = {
  inbound: { label: "Inbound", icon: "📦", className: "bg-emerald-50 text-emerald-700 border-emerald-200", rank: 0 },
  workorders: { label: "WO", icon: "📋", className: "bg-violet-50 text-violet-700 border-violet-200", rank: 1 },
  staging: { label: "Staging", icon: "🗄️", className: "bg-amber-50 text-amber-700 border-amber-200", rank: 2 },
  debox: { label: "Debox", icon: "📂", className: "bg-orange-50 text-orange-700 border-orange-200", rank: 3 },
  preblast: { label: "Pre-Blast", icon: "🧊", className: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200", rank: 4 },
  postblast: { label: "Post-Blast", icon: "❄️", className: "bg-rose-50 text-rose-700 border-rose-200", rank: 5 },
  plating: { label: "Plating", icon: "🍽️", className: "bg-blue-50 text-blue-700 border-blue-200", rank: 6 },
  sleeving: { label: "Sleeving", icon: "🔄", className: "bg-sky-50 text-sky-700 border-sky-200", rank: 7 },
  kitchen: { label: "Kitchen", icon: "🏭", className: "bg-indigo-50 text-indigo-700 border-indigo-200", rank: 8 },
  other: { label: "Other", icon: "•", className: "bg-slate-100 text-slate-600 border-slate-200", rank: 9 },
};

export function classifyWoLocation(location: string): WoFlowStageKey {
  const loc = String(location ?? "").trim().toUpperCase();
  if (!loc) return "other";
  if (loc.includes("POSTB")) return "postblast";
  if (loc.includes("PREB")) return "preblast";
  if (loc.includes("DEBOX")) return "debox";
  if (loc.includes("PHSTG") || loc.includes("STG")) return "staging";
  if (loc.includes("SLEEV")) return "sleeving";
  if (loc.includes("PLAT") || loc.includes("PLH") || loc.includes("LINE")) return "plating";
  if (loc.includes("KITCHEN") || loc.includes("WIP") || loc.includes("PRODUCTION") || loc.includes("ASSEMBLY")) return "kitchen";
  return "other";
}

export type WoTransitionAgg = {
  key: string;
  from: string;
  to: string;
  fromStage: WoFlowStageKey;
  toStage: WoFlowStageKey;
  totalQty: number;
  count: number;
  items: string[];
  lots: string[];
  hus: string[];
  lastTs: string;
};

export type PlausibilityLevel = "ok" | "warn" | "err" | "offen";

export type WoPlausibilityCheck = {
  key: string;
  label: string;
  planned: number;
  actual: number;
  delta: number;
  pct: number | null;
  level: PlausibilityLevel;
};

export function buildWoTransitions(transactions: WoTransactionRow[]): WoTransitionAgg[] {
  const map = new Map<string, WoTransitionAgg>();
  for (const row of transactions) {
    const from = String(row.locationId ?? "").trim();
    const to = String(row.locationId2 ?? "").trim();
    if (!from && !to) continue;
    const key = `${from}=>${to}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        key,
        from,
        to,
        fromStage: classifyWoLocation(from),
        toStage: classifyWoLocation(to),
        totalQty: 0,
        count: 0,
        items: [],
        lots: [],
        hus: [],
        lastTs: "",
      };
      map.set(key, agg);
    }
    agg.totalQty += Math.abs(row.tranQty ?? 0);
    agg.count += 1;
    agg.lastTs = maxDate(agg.lastTs || null, row.endTranDate ?? row.startTranDate ?? null) ?? agg.lastTs;
    if (row.itemNumber && !agg.items.includes(row.itemNumber)) agg.items.push(row.itemNumber);
    if (row.lotNumber && !agg.lots.includes(row.lotNumber)) agg.lots.push(row.lotNumber);
    if (row.huId && !agg.hus.includes(row.huId)) agg.hus.push(row.huId);
  }
  return [...map.values()].sort((a, b) => {
    const byFrom = WO_FLOW_META[a.fromStage].rank - WO_FLOW_META[b.fromStage].rank;
    if (byFrom !== 0) return byFrom;
    const byTo = WO_FLOW_META[a.toStage].rank - WO_FLOW_META[b.toStage].rank;
    if (byTo !== 0) return byTo;
    return String(a.lastTs).localeCompare(String(b.lastTs));
  });
}

export function buildWoStageChain(woRows: WorkorderRow[], transactions: WoTransactionRow[]): WoFlowStageKey[] {
  const stages = new Set<WoFlowStageKey>(["workorders"]);
  if (woRows.some((row) => row.preBlastLocation)) stages.add("preblast");
  const transitions = buildWoTransitions(transactions);
  for (const hop of transitions) {
    if (hop.fromStage !== "other") stages.add(hop.fromStage);
    if (hop.toStage !== "other") stages.add(hop.toStage);
  }
  if (transitions.length === 0) {
    for (const row of transactions) {
      const tranType = String(row.tranType ?? "").trim();
      if (tranType === "370" || tranType === "371") stages.add("inbound");
      if (tranType === "393") stages.add("staging");
      if (["386", "387"].includes(tranType)) stages.add("debox");
      if (tranType === "651") stages.add("preblast");
      if (tranType === "650") stages.add("postblast");
      if (["653", "655", "656", "657", "660", "661"].includes(tranType)) stages.add("kitchen");
    }
  }
  return [...stages].sort((a, b) => WO_FLOW_META[a].rank - WO_FLOW_META[b].rank);
}


export function buildWoPlausibilityChecks(plannedQty: number, plannedPreblast: number, totalPreblast: number, totalPostblast: number, sleevingLost?: number): WoPlausibilityCheck[] {
  const checks: WoPlausibilityCheck[] = [];
  const mk = (key: string, label: string, planned: number, actual: number): WoPlausibilityCheck => {
    const delta = actual - planned;
    const pct = planned > 0 ? (delta / planned) * 100 : null;
    const absPct = Math.abs(pct ?? 0);
    const level: PlausibilityLevel = planned <= 0 && actual <= 0
      ? "offen"
      : planned <= 0
        ? "warn"
        : absPct <= 10
          ? "ok"
          : absPct <= 25
            ? "warn"
            : "err";
    return { key, label, planned, actual, delta, pct, level };
  };

  checks.push(mk("wo-preblast", "WO vs Pre-Blast", plannedQty, totalPreblast));
  checks.push(mk("preblast-postblast", "Pre-Blast vs Post-Blast", plannedPreblast || totalPreblast, totalPostblast));
  checks.push(mk("wo-postblast", "WO vs Post-Blast", plannedQty, totalPostblast));
  if (sleevingLost != null && sleevingLost > 0) {
    checks.push(mk("sleeving-yield", "Sleeving Yield-Verlust", plannedQty, plannedQty - sleevingLost));
  }
  return checks;
}


export function woReadiness(submeals: WorkorderRow[], skuMap: SkuStationMap): { available: number; inSleeving: number; total: number; pct: number } {
  const uniqueSkus = [...new Set(submeals.map(s => skuKey(s.submealItemNumber)).filter(Boolean))];
  let available = 0;
  let inSleeving = 0;
  for (const sku of uniqueSkus) {
    const stations = skuMap.get(sku);
    if (stations && STORAGE_STATIONS.some(s => stations.has(s))) { available++; }
    else if (stations?.has("sleeving")) { inSleeving++; }
  }
  const effectiveAvail = available + inSleeving;
  return { available, inSleeving, total: uniqueSkus.length, pct: uniqueSkus.length > 0 ? Math.round(effectiveAvail / uniqueSkus.length * 100) : 0 };
}


// ─── WO-zentrierte Liste (alle WOs der KW) ──────────────────────────────────

export type WoSummary = {
  woNumber: string;
  mealSku: string;
  mealName: string;
  submeals: { sku: string; name: string; qty: number; uom: string }[];
  totalQty: number;
  plates: number;
  preBlast: number;
  status: string;
  expiry: string | null;
  // from transactions
  tranCount: number;
  hasAllocation: boolean;
  hasPicking: boolean;
  hasDebox: boolean;
  hasPreblast: boolean;
  hasPostblast: boolean;
  isClosed: boolean;
  wipRecon: number;
  progressPct: number;
  locations: string[];
  preBlastLocations: string[];
  stageChain: WoFlowStageKey[];
  plausibilityChecks: WoPlausibilityCheck[];
  worstPlausibility: PlausibilityLevel;
};

export function buildWoSummaries(workorders: WorkorderRow[], woTransactionMap: Map<string, WoTransactionRow[]>): WoSummary[] {
  const map = new Map<string, WoSummary>();
  for (const r of workorders) {
    if (!r.woNumber) continue;
    let wo = map.get(r.woNumber);
    if (!wo) {
      const trans = woTransactionMap.get(r.woNumber) ?? [];
      const phases = ["370", "371", "380", "393", "386", "651", "650", "661"];
      const completed = phases.filter(p => trans.some(t => t.tranType === p));
      wo = {
        woNumber: r.woNumber,
        mealSku: r.mealItemNumber,
        mealName: r.mealItemDescription,
        submeals: [],
        totalQty: 0,
        plates: 0,
        preBlast: 0,
        status: r.status,
        expiry: r.expirationDate,
        tranCount: trans.length,
        hasAllocation: trans.some(t => t.tranType === "370"),
        hasPicking: trans.some(t => t.tranType === "380"),
        hasDebox: trans.some(t => t.tranType === "386"),
        hasPreblast: trans.some(t => t.tranType === "651"),
        hasPostblast: trans.some(t => t.tranType === "650"),
        isClosed: trans.some(t => t.tranType === "661"),
        wipRecon: trans.filter(t => t.tranType === "086").reduce((s, t) => s + Math.abs(t.tranQty ?? 0), 0),
        progressPct: Math.round((completed.length / phases.length) * 100),
        locations: [...new Set(trans.flatMap(t => [t.locationId, t.locationId2]).map(v => String(v ?? "").trim()).filter(Boolean))].sort(),
        preBlastLocations: [],
        stageChain: buildWoStageChain([r], trans),
        plausibilityChecks: buildWoPlausibilityChecks(0, 0, trans.filter(t => t.tranType === "651").reduce((s, t) => s + (t.tranQty ?? 0), 0), trans.filter(t => t.tranType === "650").reduce((s, t) => s + Math.abs(t.tranQty ?? 0), 0)),
        worstPlausibility: "offen",
      };
      map.set(r.woNumber, wo);
    }
    wo.totalQty += r.quantity ?? 0;
    wo.plates = Math.max(wo.plates, r.plates ?? 0);
    wo.preBlast += r.preBlastQuantity ?? 0;
    if (r.preBlastLocation && !wo.preBlastLocations.includes(r.preBlastLocation)) wo.preBlastLocations.push(r.preBlastLocation);
    wo.stageChain = buildWoStageChain(workorders.filter((w) => w.woNumber === r.woNumber), woTransactionMap.get(r.woNumber) ?? []);
    const trans = woTransactionMap.get(r.woNumber) ?? [];
    wo.plausibilityChecks = buildWoPlausibilityChecks(
      wo.totalQty,
      wo.preBlast,
      trans.filter(t => t.tranType === "651").reduce((s, t) => s + (t.tranQty ?? 0), 0),
      trans.filter(t => t.tranType === "650").reduce((s, t) => s + Math.abs(t.tranQty ?? 0), 0),
    );
    wo.worstPlausibility = wo.plausibilityChecks.some((check) => check.level === "err")
      ? "err"
      : wo.plausibilityChecks.some((check) => check.level === "warn")
        ? "warn"
        : wo.plausibilityChecks.some((check) => check.level === "ok")
          ? "ok"
          : "offen";
    wo.submeals.push({ sku: r.submealItemNumber, name: r.submealItemDescription, qty: r.quantity ?? 0, uom: r.uom });
  }
  return [...map.values()].sort((a, b) => {
    const na = parseInt(a.woNumber.split("-")[1] ?? "0");
    const nb = parseInt(b.woNumber.split("-")[1] ?? "0");
    return na - nb;
  });
}

