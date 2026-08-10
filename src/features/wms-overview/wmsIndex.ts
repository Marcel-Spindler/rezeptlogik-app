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
  for (const r of allData.inbound.rows)   add(r.lotNumber, "inbound");
  for (const r of allData.staging.rows)   add(r.lotNumber, "staging");
  for (const r of allData.debox.rows)     add(r.lotNumber, "debox");
  for (const r of allData.postblast.rows) add(r.lotNumber, "postblast");
  for (const r of allData.plating.rows)   add(r.lotNumber, "plating");
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
  const sumArr = (arr: Record<string, unknown>[], field: string) =>
    arr.reduce((s, r) => s + (Number(r[field]) || 0), 0);

  return multiSkus.map(sku => {
    const wo  = allData.workorders.rows.filter(r => woMatchesSelectedWeek(r.week, selectedWeek) && (skuKey(r.submealItemNumber) === sku || skuKey(r.mealItemNumber) === sku));
    const inb = allData.inbound.rows.filter(r => (weekNum == null || r.kw === weekNum) && skuKey(r.itemNumber) === sku);
    const stg = allData.staging.rows.filter(r => skuKey(r.itemNumber) === sku);
    const deb = allData.debox.rows.filter(r => skuKey(r.itemNumber) === sku);
    const pb  = allData.postblast.rows.filter(r => skuKey(r.itemNumber) === sku);
    const slv = allData.sleeving.rows.filter(r => (weekNum == null || r.kw === weekNum) && skuKey(r.itemNumber) === sku);
    const plt = allData.plating.rows.filter(r => skuKey(r.itemNumber) === sku);

    const sleevNet = slv.reduce((s, r) => {
      const sig = sleevingSignal(r);
      const q = Math.abs(r.tranQty ?? 0);
      return sig === "eingang" ? s + q : sig === "ausgang" ? s - q : s;
    }, 0);

    return {
      sku,
      woQty:        wo.length  ? sumArr(wo  as unknown as Record<string, unknown>[], "quantity")    : null,
      inboundQty:   inb.length ? sumArr(inb as unknown as Record<string, unknown>[], "qtyReceived") : null,
      stagingQty:   stg.length ? sumArr(stg as unknown as Record<string, unknown>[], "actualQty")   : null,
      deboxQty:     deb.length ? sumArr(deb as unknown as Record<string, unknown>[], "actualQty")   : null,
      postblastQty: pb.length  ? sumArr(pb  as unknown as Record<string, unknown>[], "actualQty")   : null,
      sleevingNet:  slv.length ? sleevNet : null,
      platingQty:   plt.length ? sumArr(plt as unknown as Record<string, unknown>[], "actualQty")   : null,
      stationCount: skuMap.get(sku)!.size,
    };
  }).sort((a, b) => b.stationCount - a.stationCount || (b.inboundQty ?? 0) - (a.inboundQty ?? 0));
}

