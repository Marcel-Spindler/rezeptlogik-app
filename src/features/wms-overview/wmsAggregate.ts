// WMS Übersicht – Aggregation je Station, SKU-Bilanz, Kettenbruch-Erkennung.
import type {
  AggInboundRow, AggSleevingRow, AggStoredRow, AggWorkorderMeal,
  InboundRow, SleevingRow, StoredRow, WorkorderRow,
} from "./wmsTypes";
import { cleanName, maxDate, minDate, skuKey } from "./wmsFormat";

// ─── Sleeving Signal ──────────────────────────────────────────────────────────

export type SleevSignal = "eingang" | "ausgang" | "lost" | "hold" | "cycle" | "intern";

export function sleevingSignal(r: SleevingRow): SleevSignal {
  const von  = String(r.von  ?? "").toUpperCase();
  const nach = String(r.nach ?? "").toUpperCase();
  const desc = String(r.description ?? "").toUpperCase();
  const type = String(r.tranType ?? "").toUpperCase();
  if (desc.includes("LOST") || nach.includes("LOST"))               return "lost";
  if (type === "800" || desc.includes("CYCLE COUNT"))               return "cycle";
  if (type === "721" || desc.includes("HOLD"))                      return "hold";
  if (nach.includes("SLEEV") && !von.includes("SLEEV"))             return "eingang";
  if (von.includes("SLEEV")  && !nach.includes("SLEEV"))            return "ausgang";
  return "intern";
}

// ─── Aggregation Functions ────────────────────────────────────────────────────

export function aggregateInbound(rows: InboundRow[]): AggInboundRow[] {
  const map = new Map<string, AggInboundRow>();
  for (const r of rows) {
    const sku = skuKey(r.itemNumber);
    if (!sku) continue;
    let agg = map.get(sku);
    if (!agg) {
      agg = { sku, totalReceived: 0, totalDamaged: 0, poCount: 0, lotCount: 0, huCount: 0, vendors: [], statuses: [], lastReceipt: null, nextExpiry: null, rawRows: [] };
      map.set(sku, agg);
    }
    agg.totalReceived += r.qtyReceived ?? 0;
    agg.totalDamaged  += r.qtyDamaged  ?? 0;
    agg.lastReceipt    = maxDate(agg.lastReceipt, r.receiptDate);
    agg.nextExpiry     = minDate(agg.nextExpiry,  r.expirationDate);
    if (r.vendorCode && !agg.vendors.includes(r.vendorCode)) agg.vendors.push(r.vendorCode);
    const st = [r.status, r.tranStatus].filter(Boolean).join("/");
    if (st && !agg.statuses.includes(st)) agg.statuses.push(st);
    agg.rawRows.push(r);
  }
  for (const agg of map.values()) {
    agg.poCount  = new Set(agg.rawRows.map(r => r.poNumber).filter(Boolean)).size;
    agg.lotCount = new Set(agg.rawRows.map(r => r.lotNumber).filter(Boolean)).size;
    agg.huCount  = new Set(agg.rawRows.map(r => r.huId).filter(Boolean)).size;
  }
  return [...map.values()].sort((a, b) => b.totalReceived - a.totalReceived);
}

export function aggregateStored(rows: StoredRow[]): AggStoredRow[] {
  const map = new Map<string, AggStoredRow>();
  for (const r of rows) {
    const sku = skuKey(r.itemNumber);
    const loc = String(r.locationId ?? "").trim();
    const key = `${loc}||${sku}`;
    if (!sku) continue;
    let agg = map.get(key);
    if (!agg) {
      agg = { key, sku, location: loc, totalQty: 0, lots: [], hus: [], statuses: [], firstFifo: null, firstExpiry: null, lastChange: null, rawRows: [] };
      map.set(key, agg);
    }
    agg.totalQty   += Math.abs(r.actualQty ?? 0);
    agg.firstFifo   = minDate(agg.firstFifo,  r.fifoDate);
    agg.firstExpiry = minDate(agg.firstExpiry, r.expirationDate);
    agg.lastChange  = maxDate(agg.lastChange,  r.dbChangeCommitTime);
    if (r.lotNumber && !agg.lots.includes(r.lotNumber)) agg.lots.push(r.lotNumber);
    if (r.huId      && !agg.hus.includes(r.huId))       agg.hus.push(r.huId);
    if (r.status    && !agg.statuses.includes(r.status)) agg.statuses.push(r.status);
    agg.rawRows.push(r);
  }
  return [...map.values()].sort((a, b) => {
    if (a.location < b.location) return -1;
    if (a.location > b.location) return 1;
    return b.totalQty - a.totalQty;
  });
}

export function aggregateSleeving(rows: SleevingRow[]): AggSleevingRow[] {
  const map = new Map<string, AggSleevingRow>();
  for (const r of rows) {
    const sku = skuKey(r.itemNumber);
    if (!sku) continue;
    let agg = map.get(sku);
    if (!agg) {
      agg = { sku, description: cleanName(r.description), eingang: 0, ausgang: 0, net: 0, lost: 0, hold: 0, cycleDelta: 0, transCount: 0, employees: [], lastChange: null, rawRows: [] };
      map.set(sku, agg);
    }
    const sig = sleevingSignal(r);
    const qty = Math.abs(r.tranQty ?? 0);
    if      (sig === "eingang") { agg.eingang += qty; agg.net += qty; }
    else if (sig === "ausgang") { agg.ausgang += qty; agg.net -= qty; }
    else if (sig === "lost")    { agg.lost    += qty; }
    else if (sig === "hold")    { agg.hold    += qty; }
    else if (sig === "cycle")   { agg.cycleDelta += r.tranQty ?? 0; }
    agg.transCount++;
    agg.lastChange = maxDate(agg.lastChange, r.endTranDate ?? r.startTranDate);
    if (r.employeeId && !agg.employees.includes(r.employeeId)) agg.employees.push(r.employeeId);
    if (!agg.description || agg.description === "–") agg.description = cleanName(r.description);
    agg.rawRows.push(r);
  }
  return [...map.values()].sort((a, b) => (b.eingang + b.ausgang) - (a.eingang + a.ausgang));
}

export function aggregateWorkorders(rows: WorkorderRow[]): AggWorkorderMeal[] {
  const map = new Map<string, AggWorkorderMeal>();
  for (const r of rows) {
    const sku = skuKey(r.mealItemNumber);
    if (!sku) continue;
    let agg = map.get(sku);
    if (!agg) {
      agg = { mealSku: sku, mealName: cleanName(r.mealItemDescription), totalQty: 0, totalPlates: 0, totalPreBlast: 0, statuses: [], nextExpiry: null, submeals: [], weeks: [] };
      map.set(sku, agg);
    }
    agg.totalQty     += r.quantity       ?? 0;
    agg.totalPlates   = Math.max(agg.totalPlates, r.plates ?? 0);
    agg.totalPreBlast += r.preBlastQuantity ?? 0;
    agg.nextExpiry     = minDate(agg.nextExpiry, r.expirationDate);
    if (r.status && !agg.statuses.includes(r.status)) agg.statuses.push(r.status);
    if (r.week && !agg.weeks.includes(r.week)) agg.weeks.push(r.week);
    agg.submeals.push(r);
  }
  return [...map.values()].sort((a, b) => b.totalQty - a.totalQty);
}

// ─── SKU Bilanz ───────────────────────────────────────────────────────────────

export type SkuBilanzEntry = {
  sku: string;
  woRequired: number;
  inboundQty: number;
  stagingQty: number;
  deboxQty: number;
  postblastQty: number;
  sleevingNet: number;
  sleevingLost: number;
  platingQty: number;
  totalStock: number;
  coverage: number;
  gap: number;
  unresolvedGap: number;
  woNumbers: string[];
  gapBreakdown: { documented: number; unresolved: number; sleevingPct: number };
};

export function buildSkuBilanz(
  rawWorkorders: WorkorderRow[],
  aggInbound: AggInboundRow[],
  aggStaging: AggStoredRow[],
  aggDebox: AggStoredRow[],
  aggPostblast: AggStoredRow[],
  aggSleeving: AggSleevingRow[],
  aggPlating: AggStoredRow[],
): SkuBilanzEntry[] {
  const woMap = new Map<string, { required: number; wos: Set<string> }>();
  for (const r of rawWorkorders) {
    const sku = skuKey(r.submealItemNumber);
    if (!sku) continue;
    if (!woMap.has(sku)) woMap.set(sku, { required: 0, wos: new Set() });
    const entry = woMap.get(sku)!;
    entry.required += r.quantity ?? 0;
    if (r.woNumber) entry.wos.add(r.woNumber);
  }
  const skuSum = (rows: AggStoredRow[], sku: string) =>
    rows.filter(r => r.sku === sku).reduce((s, r) => s + r.totalQty, 0);
  const inboundMap = new Map(aggInbound.map(r => [r.sku, r.totalReceived]));
  const sleevingMap = new Map(aggSleeving.map(r => [r.sku, r.net]));
  const sleevingLostMap = new Map(aggSleeving.map(r => [r.sku, r.lost]));
  return [...woMap.entries()].map(([sku, { required, wos }]) => {
    const stagingQty   = skuSum(aggStaging,   sku);
    const deboxQty     = skuSum(aggDebox,     sku);
    const postblastQty = skuSum(aggPostblast, sku);
    const sleevingNet  = sleevingMap.get(sku)      ?? 0;
    const sleevingLost = sleevingLostMap.get(sku)  ?? 0;
    const platingQty   = skuSum(aggPlating,   sku);
    const inboundQty   = inboundMap.get(sku)  ?? 0;
    const totalStock   = stagingQty + deboxQty + postblastQty + platingQty;
    const gap           = totalStock - required;
    const coverage      = required > 0 ? (totalStock / required) * 100 : 100;
    // items received but neither in stock nor confirmed lost
    const unresolvedGap = inboundQty > 0 ? Math.max(0, inboundQty - totalStock - sleevingLost) : 0;
    const gapBreakdown = {
      documented: sleevingLost,
      unresolved: unresolvedGap,
      sleevingPct: inboundQty > 0 ? sleevingLost / inboundQty : 0,
    };
    return { sku, woRequired: required, inboundQty, stagingQty, deboxQty, postblastQty, sleevingNet, sleevingLost, platingQty, totalStock, coverage, gap, unresolvedGap, woNumbers: [...wos], gapBreakdown };
  }).sort((a, b) => a.coverage - b.coverage);
}

// ─── Stationsbilanz ─────────────────────────────────────────────────────────

export type KettenbruchResult = { label: string; severity: "stuck" | "drop" | "yield_loss" };

export function detectKettenbruch(e: SkuBilanzEntry): KettenbruchResult | null {
  // Check for massive yield loss first (sleeving loss or unresolved gap > 15% of inbound)
  if (e.inboundQty > 50) {
    const totalLoss = e.sleevingLost + e.unresolvedGap;
    const lossRate = totalLoss / e.inboundQty;
    if (lossRate > 0.15 && totalLoss > 100) {
      return { label: `Yield-Verlust: ${Math.round(lossRate * 100)}% (${Math.round(totalLoss)} Stk)`, severity: "yield_loss" };
    }
  }

  const chain = [
    { name: "Staging",    qty: e.stagingQty },
    { name: "Debox",      qty: e.deboxQty },
    { name: "Post-Blast", qty: e.postblastQty },
    { name: "Plating",    qty: e.platingQty },
  ];
  // Item present in a station but all downstream stations empty — and sleeving isn't active (net near 0 means not actively processing)
  for (let i = 0; i < chain.length - 1; i++) {
    if (chain[i].qty > 30 && chain.slice(i + 1).every(s => s.qty === 0)) {
      // Don't flag as stuck if this is the last storage station before sleeving and sleeving has throughput
      if (i === chain.length - 2 && Math.abs(e.sleevingNet) > 0) continue;
      return { label: `Steckt in ${chain[i].name}`, severity: "stuck" };
    }
  }
  // Biggest relative drop (>20%) between consecutive non-zero stations
  let worstPct = 0;
  let worstLabel = "";
  for (let i = 0; i < chain.length - 1; i++) {
    const cur = chain[i].qty;
    const nxt = chain[i + 1].qty;
    if (cur > 10 && nxt > 0 && nxt < cur) {
      const pct = (cur - nxt) / cur;
      if (pct > 0.20 && pct > worstPct) {
        worstPct   = pct;
        worstLabel = `${chain[i].name}→${chain[i + 1].name}: -${Math.round(pct * 100)}%`;
      }
    }
  }
  return worstLabel ? { label: worstLabel, severity: "drop" } : null;
}

