// WMS Übersicht – Cross-Station SKU/Lot-Index, Funnel-Aufbau.
import type { AllData, StationKey } from "./wmsTypes";
import { skuKey } from "./wmsFormat";
import { sleevingSignal } from "./wmsAggregate";
import { woMatchesSelectedWeek } from "./wmsWeeks";

// ─── Cross-Station Index ──────────────────────────────────────────────────────

export type SkuStationMap = Map<string, Set<StationKey>>;
export type LotStationMap = Map<string, Set<StationKey>>;

export function buildSkuStationMap(allData: AllData, selectedWeek: string, weekNum: number | null): SkuStationMap {
  const map: SkuStationMap = new Map();
  function add(sku: string, station: StationKey) {
    const k = skuKey(sku);
    if (!k) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k)!.add(station);
  }
  for (const r of allData.workorders.rows) {
    if (woMatchesSelectedWeek(r.week, selectedWeek)) { add(r.submealItemNumber, "workorders"); add(r.mealItemNumber, "workorders"); }
  }
  for (const r of allData.inbound.rows)   { if (weekNum == null || r.kw === weekNum) add(r.itemNumber, "inbound"); }
  for (const r of allData.staging.rows)   { add(r.itemNumber, "staging");   }
  for (const r of allData.debox.rows)     { add(r.itemNumber, "debox");     }
  for (const r of allData.postblast.rows) { add(r.itemNumber, "postblast"); }
  for (const r of allData.platingHolding.rows) { add(r.itemNumber, "platingHolding"); }
  for (const r of allData.sleeving.rows)  { if (weekNum == null || r.kw === weekNum) add(r.itemNumber, "sleeving"); }
  for (const r of allData.plating.rows)   { add(r.itemNumber, "plating"); }
  return map;
}

export function buildLotStationMap(allData: AllData): LotStationMap {
  const map: LotStationMap = new Map();
  function add(lot: string, station: StationKey) {
    const k = String(lot ?? "").trim();
    if (!k || k === "–") return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k)!.add(station);
  }
  for (const r of allData.inbound.rows)        add(r.lotNumber, "inbound");
  for (const r of allData.staging.rows)        add(r.lotNumber, "staging");
  for (const r of allData.debox.rows)          add(r.lotNumber, "debox");
  for (const r of allData.postblast.rows)      add(r.lotNumber, "postblast");
  for (const r of allData.platingHolding.rows) add(r.lotNumber, "platingHolding");
  for (const r of allData.plating.rows)        add(r.lotNumber, "plating");
  return map;
}

// ─── Funnel ───────────────────────────────────────────────────────────────────

export type FunnelRow = {
  sku: string;
  woQty:        number | null;
  inboundQty:   number | null;
  stagingQty:   number | null;
  deboxQty:     number | null;
  postblastQty: number | null;
  sleevingNet:  number | null;
  platingQty:   number | null;
  stationCount: number;
};

export function buildFunnel(allData: AllData, skuMap: SkuStationMap, selectedWeek: string, weekNum: number | null): FunnelRow[] {
  const multiSkus = [...skuMap.entries()].filter(([, s]) => s.size >= 2).map(([sku]) => sku);

  // Pre-index rows by SKU for O(1) lookup instead of O(n) per-SKU filter
  const woIndex = new Map<string, { qty: number }>();
  for (const r of allData.workorders.rows) {
    if (!woMatchesSelectedWeek(r.week, selectedWeek)) continue;
    for (const field of [r.submealItemNumber, r.mealItemNumber]) {
      const k = skuKey(field);
      if (!k) continue;
      woIndex.set(k, { qty: (woIndex.get(k)?.qty ?? 0) + (Number(r.quantity) || 0) });
    }
  }
  const inbIndex = new Map<string, number>();
  for (const r of allData.inbound.rows) {
    if (weekNum != null && r.kw !== weekNum) continue;
    const k = skuKey(r.itemNumber);
    if (k) inbIndex.set(k, (inbIndex.get(k) ?? 0) + (Number(r.qtyReceived) || 0));
  }
  const storedIndex = (rows: { itemNumber: string; actualQty: number | null }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) { const k = skuKey(r.itemNumber); if (k) m.set(k, (m.get(k) ?? 0) + (Number(r.actualQty) || 0)); }
    return m;
  };
  const stgIndex = storedIndex(allData.staging.rows);
  const debIndex = storedIndex(allData.debox.rows);
  const pbIndex = storedIndex(allData.postblast.rows);
  const pltIndex = storedIndex(allData.plating.rows);
  const slvIndex = new Map<string, number>();
  for (const r of allData.sleeving.rows) {
    if (weekNum != null && r.kw !== weekNum) continue;
    const k = skuKey(r.itemNumber);
    if (!k) continue;
    const sig = sleevingSignal(r);
    const q = Math.abs(r.tranQty ?? 0);
    const delta = sig === "eingang" ? q : sig === "ausgang" ? -q : 0;
    slvIndex.set(k, (slvIndex.get(k) ?? 0) + delta);
  }

  return multiSkus.map(sku => {
    const woQty = woIndex.get(sku)?.qty ?? null;
    const inbQty = inbIndex.has(sku) ? inbIndex.get(sku)! : null;
    const stagingQty = stgIndex.has(sku) ? stgIndex.get(sku)! : null;
    const deboxQty = debIndex.has(sku) ? debIndex.get(sku)! : null;
    const postblastQty = pbIndex.has(sku) ? pbIndex.get(sku)! : null;
    const platingQty = pltIndex.has(sku) ? pltIndex.get(sku)! : null;
    const sleevingNet = slvIndex.has(sku) ? slvIndex.get(sku)! : null;

    return {
      sku,
      woQty:        woQty != null ? woQty : null,
      inboundQty:   inbQty,
      stagingQty:   stagingQty,
      deboxQty:     deboxQty,
      postblastQty: postblastQty,
      sleevingNet:  sleevingNet,
      platingQty:   platingQty,
      stationCount: skuMap.get(sku)!.size,
    };
  }).sort((a, b) => b.stationCount - a.stationCount || (b.inboundQty ?? 0) - (a.inboundQty ?? 0));
}

