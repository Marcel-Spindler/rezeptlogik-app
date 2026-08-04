import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DataBundle } from "./types";
import { buildSkuInfoIndex, getSkuDisplayLabel, type WmsSkuInfo } from "./wmsSkuEnrichment";

// ─── Raw Row Types ────────────────────────────────────────────────────────────

type StoredRow = {
  locationId: string;
  itemNumber: string;
  actualQty: number | null;
  lotNumber: string;
  huId: string;
  status: string;
  fifoDate: string | null;
  expirationDate: string | null;
  dbChangeCommitTime: string | null;
  kw: number | null;
};

type SleevingRow = {
  von: string;
  nach: string;
  tranType: string;
  itemNumber: string;
  tranQty: number | null;
  startTranDate: string | null;
  endTranDate: string | null;
  kw: number | null;
  employeeId: string;
  description: string;
};

type InboundRow = {
  poNumber: string;
  itemNumber: string;
  qtyReceived: number | null;
  qtyDamaged: number | null;
  receiptDate: string | null;
  vendorCode: string;
  huId: string;
  lotNumber: string;
  expirationDate: string | null;
  shipmentNumber: string;
  tranStatus: string;
  status: string;
  dbChangeCommitTime: string | null;
  kw: number | null;
};

type WoTransactionRow = {
  woNumber: string;
  tranType: string;
  description: string;
  itemNumber: string;
  tranQty: number | null;
  lotNumber: string;
  locationId: string;
  locationId2: string;
  huId: string;
  startTranDate: string | null;
  endTranDate: string | null;
  employeeId: string;
};

type WorkorderRow = {
  woNumber: string;
  week: string;
  submealItemNumber: string;
  submealItemDescription: string;
  mealItemNumber: string;
  mealItemDescription: string;
  quantity: number | null;
  uom: string;
  plates: number | null;
  targetPerPlate: number | null;
  preBlastQuantity: number | null;
  preBlastLocation: string;
  status: string;
  expirationDate: string | null;
  productionTime: string | null;
  lastUpdated: string | null;
};

// ─── Aggregated Row Types ─────────────────────────────────────────────────────

type AggInboundRow = {
  sku: string;
  totalReceived: number;
  totalDamaged: number;
  poCount: number;
  lotCount: number;
  huCount: number;
  vendors: string[];
  statuses: string[];
  lastReceipt: string | null;
  nextExpiry: string | null;
  rawRows: InboundRow[];
};

type AggStoredRow = {
  key: string;
  sku: string;
  location: string;
  totalQty: number;
  lots: string[];
  hus: string[];
  statuses: string[];
  firstFifo: string | null;
  firstExpiry: string | null;
  lastChange: string | null;
  rawRows: StoredRow[];
};

type AggSleevingRow = {
  sku: string;
  description: string;
  eingang: number;
  ausgang: number;
  net: number;
  lost: number;
  hold: number;
  cycleDelta: number;
  transCount: number;
  employees: string[];
  lastChange: string | null;
  rawRows: SleevingRow[];
};

type AggWorkorderMeal = {
  mealSku: string;
  mealName: string;
  totalQty: number;
  totalPlates: number;
  totalPreBlast: number;
  statuses: string[];
  nextExpiry: string | null;
  submeals: WorkorderRow[];
  weeks: string[];
};

// ─── Payload Types ────────────────────────────────────────────────────────────

type BasePayload = {
  ok: boolean;
  rangeStart?: string;
  rangeEnd?: string;
  generatedAt?: string;
  error?: string;
};

type StoredPayload    = BasePayload & { rows: StoredRow[] };
type SleevingPayload  = BasePayload & { rows: SleevingRow[] };
type InboundPayload   = BasePayload & { rows: InboundRow[] };
type WorkordersPayload = { ok: boolean; rows: WorkorderRow[]; error?: string };
type WoDetailPayload   = { ok: boolean; rows: WoTransactionRow[]; error?: string; source?: string; cachedAt?: string; week?: string; wmsWeek?: string; controlPattern?: string };

type AllData = {
  plating:    StoredPayload;
  staging:    StoredPayload;
  debox:      StoredPayload;
  postblast:  StoredPayload;
  sleeving:   SleevingPayload;
  inbound:    InboundPayload;
  workorders: WorkordersPayload;
  woDetail:   WoDetailPayload;
};

type StationKey = "workorders" | "inbound" | "staging" | "debox" | "postblast" | "sleeving" | "plating";
type LoadState  = "idle" | "loading" | "ready" | "error";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATION_ORDER: StationKey[] = [
  "inbound", "workorders", "staging", "debox", "postblast", "plating", "sleeving",
];

const STATION_META: Record<StationKey, { label: string; bgColor: string; textColor: string; borderColor: string; icon: string }> = {
  workorders: { label: "Work Orders",               bgColor: "bg-violet-50",  textColor: "text-violet-700",  borderColor: "border-violet-200",  icon: "📋" },
  inbound:    { label: "Inbound (Wareneingang)",    bgColor: "bg-emerald-50", textColor: "text-emerald-700", borderColor: "border-emerald-200", icon: "📦" },
  staging:    { label: "Staging",                   bgColor: "bg-amber-50",   textColor: "text-amber-700",   borderColor: "border-amber-200",   icon: "🗄️" },
  debox:      { label: "Debox",                     bgColor: "bg-orange-50",  textColor: "text-orange-700",  borderColor: "border-orange-200",  icon: "📂" },
  postblast:  { label: "Post-Blast",                bgColor: "bg-rose-50",    textColor: "text-rose-700",    borderColor: "border-rose-200",    icon: "❄️" },
  sleeving:   { label: "Sleeving",                  bgColor: "bg-sky-50",     textColor: "text-sky-700",     borderColor: "border-sky-200",     icon: "🔄" },
  plating:    { label: "Plating (Linie & Holding)", bgColor: "bg-blue-50",    textColor: "text-blue-700",    borderColor: "border-blue-200",    icon: "🍽️" },
};

// ─── KW Generation ────────────────────────────────────────────────────────────

function isoWeekLabelLocal(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function currentHfWeekLocal(): string {
  const iso = isoWeekLabelLocal(new Date());
  const m = iso.match(/^(20\d{2})-W(\d{2})$/);
  if (!m) return iso;
  const week = Number(m[2]) + 1;
  if (week <= 52) return `${m[1]}-W${String(week).padStart(2, "0")}`;
  return `${Number(m[1]) + 1}-W01`;
}

function generateWmsWeeks(startYear = 2026, startWeek = 1): string[] {
  const current = currentHfWeekLocal();
  const result: string[] = [];
  let year = startYear, week = startWeek;
  for (let i = 0; i < 500; i++) {
    const label = `${year}-W${String(week).padStart(2, "0")}`;
    result.push(label);
    if (label === current) break;
    week++;
    if (week > 52) { week = 1; year++; }
  }
  return result;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function hfWeekTokens(hfWeek: string): { full: string; short: string; week: string; weekUnpadded: string } | null {
  const m = String(hfWeek ?? "").trim().match(/^(20\d{2})-W(\d{2})$/);
  if (!m) return null;
  return {
    full: `${m[1]}${m[2]}`,
    short: `${m[1].slice(-2)}${m[2]}`,
    week: m[2],
    weekUnpadded: String(Number(m[2])),
  };
}

// Flexible WO week matcher — V_SUBMEAL_PRODUCTION "week" format varies.
// Prefer exact year+week matching where available and only fall back to the
// plain week number if the source omits any year information.
function woMatchesSelectedWeek(woWeek: string, selectedHfWeek: string): boolean {
  const tokens = hfWeekTokens(selectedHfWeek);
  if (!tokens) return true;
  const raw = String(woWeek ?? "").trim();
  if (!raw) return false;

  const upper = raw.toUpperCase();
  if (upper.includes(tokens.full) || upper.includes(tokens.short)) return true;

  const digits = raw.replace(/\D/g, "");
  if (!digits) return false;
  if (digits.length >= 6 && digits.includes(tokens.full)) return true;
  if (digits.length === 4 && digits === tokens.short) return true;
  if (digits === tokens.week || digits === tokens.weekUnpadded) return true;

  // If the live WMS feed lags the selected HF week, keep the adjacent
  // operational weeks instead of hiding the whole Workorders section.
  const selectedWeekNum = weekNumFromHfWeek(selectedHfWeek);
  const rowWeekNum = weekNumFromWmsWeek(raw);
  if (selectedWeekNum == null || rowWeekNum == null) return false;
  return rowWeekNum >= selectedWeekNum - 1 && rowWeekNum <= selectedWeekNum + 2;
}

function weekNumFromHfWeek(hfWeek: string): number | null {
  const m = hfWeek.match(/W(\d{2})$/);
  return m ? parseInt(m[1]) : null;
}

export function previousWmsWeekCandidates(weekNum: number): number[] {
  if (weekNum === 1) return [52, 53];
  return [weekNum - 1];
}

export function resolveOperationalWmsWeekNum(
  selectedWeekNum: number | null,
  datasets: Array<Array<{ kw: number | null }>>,
): number | null {
  if (selectedWeekNum == null) return null;
  const hasSelectedWeek = datasets.some((rows) => rows.some((row) => row.kw === selectedWeekNum));
  if (hasSelectedWeek) return selectedWeekNum;

  for (const candidate of previousWmsWeekCandidates(selectedWeekNum)) {
    const hasCandidateWeek = datasets.some((rows) => rows.some((row) => row.kw === candidate));
    if (hasCandidateWeek) return candidate;
  }

  return selectedWeekNum;
}

function weekNumFromWmsWeek(woWeek: string): number | null {
  const digits = String(woWeek ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length >= 2) return parseInt(digits.slice(-2), 10);
  return null;
}

function woMatchesWeekNum(woWeek: string, weekNum: number | null): boolean {
  if (weekNum == null) return true;
  const wn2 = String(weekNum).padStart(2, "0");
  return woWeek === String(weekNum)
    || woWeek === wn2
    || woWeek.endsWith(wn2)
    || woWeek.startsWith(`${wn2}-`)
    || woWeek.startsWith(`${String(weekNum)}-`);
}

function fmtQty(v: number | null | undefined, unit = ""): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const abs = Math.abs(v);
  const dec = abs >= 1000 ? 0 : 1;
  const s = v.toLocaleString("de-DE", { maximumFractionDigits: dec });
  return unit ? `${s} ${unit}` : s;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "–";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function daysUntil(exp: string): number {
  // Compare calendar dates (ignoring time-of-day) to avoid timezone drift
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(exp);
  d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

function mhdClass(exp: string | null | undefined): string {
  if (!exp) return "text-slate-400";
  const days = daysUntil(exp);
  if (days < 0)  return "text-slate-500 line-through bg-slate-100 px-1 rounded"; // abgelaufen
  if (days < 3)  return "text-rose-700 font-bold bg-rose-100 px-1 rounded";      // kritisch
  if (days < 7)  return "text-amber-600 font-semibold";                           // warnung
  return "text-emerald-700";
}

function skuKey(s: string): string {
  return String(s ?? "").trim().toUpperCase();
}

function cleanName(s: string): string {
  return String(s ?? "").replace(/\s+\[PENDING CULINARY REVIEW\]/gi, "").replace(/\s+/g, " ").trim() || "–";
}

function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

// ─── Sleeving Signal ──────────────────────────────────────────────────────────

type SleevSignal = "eingang" | "ausgang" | "lost" | "hold" | "cycle" | "intern";

function sleevingSignal(r: SleevingRow): SleevSignal {
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

function aggregateInbound(rows: InboundRow[]): AggInboundRow[] {
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

function aggregateStored(rows: StoredRow[]): AggStoredRow[] {
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

function aggregateSleeving(rows: SleevingRow[]): AggSleevingRow[] {
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

function aggregateWorkorders(rows: WorkorderRow[]): AggWorkorderMeal[] {
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

type SkuBilanzEntry = {
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

function buildSkuBilanz(
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

// ─── Snapshot System ─────────────────────────────────────────────────────────

const SNAPSHOT_KEY = "wms-snapshots-v2";
const MAX_SNAPSHOTS = 15;

type WmsSnapshot = {
  id: string;
  week: string;
  timestamp: string;
  label: string;
  bilanz: SkuBilanzEntry[];
};

function loadSnapshots(): WmsSnapshot[] {
  try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? "[]") as WmsSnapshot[]; }
  catch { return []; }
}

function persistSnapshot(week: string, bilanz: SkuBilanzEntry[]): void {
  const snap: WmsSnapshot = {
    id: String(Date.now()),
    week,
    timestamp: new Date().toISOString(),
    label: `${week} · ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`,
    bilanz,
  };
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify([snap, ...loadSnapshots()].slice(0, MAX_SNAPSHOTS))); }
  catch (_e) { /* localStorage not available or quota exceeded */ }
}

function removeSnapshot(id: string): void {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(loadSnapshots().filter(s => s.id !== id))); }
  catch (_e) { /* localStorage not available */ }
}

// ─── Cross-Station Index ──────────────────────────────────────────────────────

type SkuStationMap = Map<string, Set<StationKey>>;
type LotStationMap = Map<string, Set<StationKey>>;

function buildSkuStationMap(allData: AllData, selectedWeek: string, weekNum: number | null): SkuStationMap {
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

function buildLotStationMap(allData: AllData): LotStationMap {
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

// ─── UI Primitives ────────────────────────────────────────────────────────────

function StationBadges({ sku, stationMap, currentStation, onTrace }: {
  sku: string; stationMap: SkuStationMap; currentStation: StationKey; onTrace: (sku: string) => void;
}) {
  const stations = stationMap.get(skuKey(sku));
  if (!stations || stations.size <= 1) return null;
  const others = STATION_ORDER.filter(s => s !== currentStation && stations.has(s));
  if (others.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-0.5 ml-1">
      {others.map(s => {
        const m = STATION_META[s];
        return (
          <button key={s} type="button"
            title={`Trace: ${sku} → ${m.label}`}
            className={`text-[9px] px-1 py-0.5 rounded font-semibold ${m.bgColor} ${m.textColor} border ${m.borderColor} hover:brightness-90 cursor-pointer`}
            onClick={e => { e.stopPropagation(); onTrace(sku); }}
          >
            {m.icon}
          </button>
        );
      })}
    </span>
  );
}

function LotCrossStations({ lots, lotMap, currentStation }: {
  lots: string[]; lotMap: LotStationMap; currentStation: StationKey;
}) {
  const cross = new Set<StationKey>();
  for (const lot of lots) {
    const stns = lotMap.get(lot);
    if (stns) for (const s of stns) if (s !== currentStation) cross.add(s);
  }
  if (cross.size === 0) return null;
  return (
    <span className="inline-flex gap-0.5">
      {STATION_ORDER.filter(s => cross.has(s)).map(s => {
        const m = STATION_META[s];
        return (
          <span key={s} title={`Los auch in: ${m.label}`} className={`text-[9px] px-1 py-0.5 rounded ${m.bgColor} ${m.textColor} border ${m.borderColor}`}>
            {m.icon}
          </span>
        );
      })}
    </span>
  );
}

function SkuLabel({ sku, skuInfoIndex }: { sku: string; skuInfoIndex: Map<string, WmsSkuInfo> }) {
  const label = getSkuDisplayLabel(sku, skuInfoIndex);
  const isFallback = label === skuKey(sku) || label === "–";
  return (
    <div className="leading-tight">
      <div className={`font-medium ${isFallback ? "text-slate-700" : "text-slate-800"}`}>{label}</div>
      {sku && sku !== label && (
        <div className={`text-[10px] font-mono ${isFallback ? "text-slate-400" : "text-slate-500"}`}>{sku}</div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    ["AVAILABLE","RECEIVED","ACTIVE"].includes(status) ? "bg-emerald-100 text-emerald-700" :
    status === "CLOSED"  ? "bg-slate-100 text-slate-500"  :
    status === "HOLD"    ? "bg-amber-100 text-amber-700"  :
    status === "DAMAGED" ? "bg-rose-100 text-rose-700"    :
    "bg-slate-100 text-slate-600";
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>{status || "–"}</span>;
}

function Th({ children, right }: { children?: ReactNode; right?: boolean }) {
  return (
    <th className={`px-2 py-2 text-[10px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap bg-slate-50 sticky top-0 ${right ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function Td({ children, right, mono, cls, title }: { children?: ReactNode; right?: boolean; mono?: boolean; cls?: string; title?: string }) {
  return (
    <td title={title} className={`px-2 py-1.5 text-xs whitespace-nowrap ${right ? "text-right" : ""} ${mono ? "font-mono" : ""} ${cls ?? "text-slate-700"}`}>
      {children}
    </td>
  );
}

function SectionCard({ stationKey, totalCount, filteredCount, children, defaultOpen = true }: {
  stationKey: StationKey; totalCount: number; filteredCount?: number; children: ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const m = STATION_META[stationKey];
  const isFiltered = filteredCount !== undefined && filteredCount !== totalCount;

  return (
    <div className={`rounded-xl border ${m.borderColor} overflow-hidden shadow-sm`}>
      <button
        type="button"
        className={`w-full flex items-center justify-between px-4 py-3 ${m.bgColor} hover:brightness-95 transition-all`}
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <span className="text-base">{m.icon}</span>
          <span className={`font-bold text-sm ${m.textColor}`}>{m.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {isFiltered ? (
            <span className="text-xs font-mono font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
              {filteredCount} / {totalCount.toLocaleString("de-DE")} SKUs
            </span>
          ) : (
            <span className={`text-xs font-mono font-semibold ${m.textColor} bg-white/60 px-2 py-0.5 rounded-full`}>
              {totalCount.toLocaleString("de-DE")} SKUs
            </span>
          )}
          <span className={`text-xs ${m.textColor}`}>{open ? "▲" : "▼"}</span>
        </div>
      </button>
      {open && <div className="bg-white">{children}</div>}
    </div>
  );
}

function ShowMoreBar({ total, shown, expanded, onExpand, onCollapse }: {
  total: number; shown: number; expanded: boolean; onExpand: () => void; onCollapse: () => void;
}) {
  if (total <= shown && !expanded) return null;
  return (
    <div className="px-4 py-2 border-t border-slate-100 text-center">
      {expanded
        ? <button type="button" className="text-xs text-slate-500 hover:text-slate-800 font-medium" onClick={onCollapse}>▲ Weniger anzeigen</button>
        : <button type="button" className="text-xs text-slate-500 hover:text-slate-800 font-medium" onClick={onExpand}>▼ Alle {total.toLocaleString("de-DE")} anzeigen</button>
      }
    </div>
  );
}

// ─── Funnel ───────────────────────────────────────────────────────────────────

type FunnelRow = {
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

function buildFunnel(allData: AllData, skuMap: SkuStationMap, selectedWeek: string, weekNum: number | null): FunnelRow[] {
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

function SkuFunnelSection({ funnel, skuMap, skuInfoIndex, onTrace }: {
  funnel: FunnelRow[]; skuMap: SkuStationMap; skuInfoIndex: Map<string, WmsSkuInfo>; onTrace: (sku: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? funnel : funnel.slice(0, 30);
  if (funnel.length === 0) return null;

  const cell = (v: number | null) =>
    v == null
      ? <span className="text-slate-300">–</span>
      : <span className="font-mono text-slate-700">{fmtQty(v)}</span>;

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-4 py-3 bg-slate-800 text-white">
        <div className="flex items-center gap-2">
          <span>🔍</span>
          <span className="font-bold text-sm">SKU-Querschnitt durch alle Stationen</span>
          <span className="text-xs text-slate-400">— Zeile anklicken zum Trace</span>
        </div>
        <span className="text-xs font-mono bg-white/20 px-2 py-0.5 rounded-full">{funnel.length} SKUs in ≥2 Stationen</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-slate-200">
              <Th>SKU</Th>
              <Th right>📦 Inbound</Th>
              <Th right>📋 WO</Th>
              <Th right>🗄️ Staging</Th>
              <Th right>📂 Debox</Th>
              <Th right>❄️ Post-Blast</Th>
              <Th right>🍽️ Plating</Th>
              <Th right>🔄 Sleeving</Th>
              <Th>Stationen</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(row => {
              const stations = skuMap.get(row.sku);
              return (
                <tr key={row.sku} className="hover:bg-amber-50/60 cursor-pointer" onClick={() => onTrace(row.sku)}>
                  <Td cls="max-w-[260px] whitespace-normal"><SkuLabel sku={row.sku} skuInfoIndex={skuInfoIndex} /></Td>
                  <Td right>{cell(row.inboundQty)}</Td>
                  <Td right>{cell(row.woQty)}</Td>
                  <Td right>{cell(row.stagingQty)}</Td>
                  <Td right>{cell(row.deboxQty)}</Td>
                  <Td right>{cell(row.postblastQty)}</Td>
                  <Td right>{cell(row.platingQty)}</Td>
                  <Td right>{cell(row.sleevingNet)}</Td>
                  <Td>
                    <span className="inline-flex gap-0.5">
                      {STATION_ORDER.filter(s => stations?.has(s)).map(s => (
                        <span key={s} title={STATION_META[s].label} className={`text-[10px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>
                          {STATION_META[s].icon}
                        </span>
                      ))}
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ShowMoreBar total={funnel.length} shown={shown.length} expanded={expanded} onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)} />
    </div>
  );
}

// ─── Trace Panel ──────────────────────────────────────────────────────────────

function TracePanel({ sku, funnel, skuInfoIndex, onClear }: { sku: string; funnel: FunnelRow[]; skuInfoIndex: Map<string, WmsSkuInfo>; onClear: () => void }) {
  const row = funnel.find(f => f.sku === sku.toUpperCase().trim());

  const cell = (label: string, v: number | null, sk: StationKey) => {
    const m = STATION_META[sk];
    return (
      <div className={`flex flex-col items-center px-3 py-2 rounded-lg border ${m.borderColor} ${m.bgColor} min-w-[80px]`}>
        <span className="text-base leading-none">{m.icon}</span>
        <span className={`text-[10px] font-semibold ${m.textColor} mt-0.5 whitespace-nowrap`}>{label}</span>
        <span className="font-mono font-bold text-slate-800 text-sm mt-1">
          {v == null ? <span className="text-slate-300 font-normal">–</span> : fmtQty(v)}
        </span>
      </div>
    );
  };

  return (
    <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 shadow-md">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔎</span>
          <span className="font-bold text-amber-800">Trace:</span>
          <div className="rounded-lg border border-amber-300 bg-amber-100 px-2 py-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">SKU</div>
            <div className="font-mono text-amber-900 font-semibold">{sku}</div>
          </div>
          <div className="max-w-[260px] rounded-lg border border-amber-300 bg-white/70 px-2 py-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">Name</div>
            <div className="text-sm text-amber-900 font-medium">{getSkuDisplayLabel(sku, skuInfoIndex)}</div>
          </div>
          <span className="text-xs text-amber-600">— Mengenfluss durch alle Stationen</span>
        </div>
        <button type="button"
          className="text-xs text-amber-700 hover:text-amber-900 font-semibold px-2 py-1 rounded hover:bg-amber-100 border border-amber-300"
          onClick={onClear}
        >
          ✕ Trace beenden
        </button>
      </div>
      {row ? (
        <div className="flex flex-wrap gap-2 items-center">
          {cell("Inbound", row.inboundQty, "inbound")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("WO", row.woQty, "workorders")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("Staging", row.stagingQty, "staging")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("Debox", row.deboxQty, "debox")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("Post-Blast", row.postblastQty, "postblast")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("Plating", row.platingQty, "plating")}
          <span className="text-slate-300 text-xl">→</span>
          {cell("Sleeving Net", row.sleevingNet, "sleeving")}
        </div>
      ) : (
        <div className="text-sm text-amber-700 italic">SKU in weniger als 2 Stationen vorhanden — kein Funnel-Eintrag</div>
      )}
    </div>
  );
}

// ─── SKU Detail Panel ─────────────────────────────────────────────────────────

function SkuDetailPanel({ sku, allData, funnel, selectedWeek, weekNum, skuInfoIndex, onClose, onTrace }: {
  sku: string; allData: AllData; funnel: FunnelRow[]; selectedWeek: string; weekNum: number | null; skuInfoIndex: Map<string, WmsSkuInfo>;
  onClose: () => void; onTrace: (sku: string) => void;
}) {
  const k = skuKey(sku);
  const woRows  = allData.workorders.rows.filter(r => woMatchesSelectedWeek(r.week, selectedWeek) && (skuKey(r.mealItemNumber) === k || skuKey(r.submealItemNumber) === k));
  const inbRows = allData.inbound.rows.filter(r => (weekNum == null || r.kw === weekNum) && skuKey(r.itemNumber) === k);
  const stagRows = allData.staging.rows.filter(r => skuKey(r.itemNumber) === k);
  const debRows  = allData.debox.rows.filter(r => skuKey(r.itemNumber) === k);
  const pbRows   = allData.postblast.rows.filter(r => skuKey(r.itemNumber) === k);
  const slvRows  = allData.sleeving.rows.filter(r => (weekNum == null || r.kw === weekNum) && skuKey(r.itemNumber) === k);
  const pltRows  = allData.plating.rows.filter(r => skuKey(r.itemNumber) === k);
  const fRow = funnel.find(f => f.sku === k);
  const allLots = [...new Set([...inbRows, ...stagRows, ...debRows, ...pbRows, ...pltRows].map(r => (r as InboundRow & StoredRow).lotNumber).filter(Boolean))];

  const SectionHead = ({ icon, label, count, cls }: { icon: string; label: string; count: number; cls: string }) => (
    <h3 className={`text-xs font-bold uppercase tracking-wider mb-2 ${cls}`}>{icon} {label} <span className="font-mono normal-case opacity-60">({count})</span></h3>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-3xl bg-white shadow-2xl overflow-y-auto flex flex-col">
        <div className="sticky top-0 bg-slate-900 text-white px-5 py-3 flex items-center justify-between z-10 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-mono font-bold text-lg text-amber-400">{sku}</span>
            <span className="text-slate-300 text-sm truncate">{getSkuDisplayLabel(sku, skuInfoIndex)}</span>
            <span className="text-slate-400 text-sm">— vollständiger Eintrag</span>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => onTrace(sku)} className="text-xs bg-amber-500 hover:bg-amber-400 text-white px-3 py-1 rounded font-semibold">🔍 Trace</button>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-xl font-bold px-2 leading-none">✕</button>
          </div>
        </div>

        <div className="p-5 space-y-6 flex-1">
          {fRow && (
            <section>
              <SectionHead icon="📊" label="Mengenstrom" count={0} cls="text-slate-500" />
              <div className="flex flex-wrap gap-1.5 items-center">
                {([ ["inbound","Inbound",fRow.inboundQty], ["workorders","WO",fRow.woQty], ["staging","Staging",fRow.stagingQty], ["debox","Debox",fRow.deboxQty], ["postblast","Post-Blast",fRow.postblastQty], ["plating","Plating",fRow.platingQty], ["sleeving","Sleeving Net",fRow.sleevingNet] ] as [StationKey,string,number|null][]).map(([sk, lbl, qty], i) => {
                  const m = STATION_META[sk];
                  return (
                    <React.Fragment key={sk}>
                      {i > 0 && <span className="text-slate-300 text-lg">→</span>}
                      <div className={`flex flex-col items-center px-2.5 py-2 rounded-lg border ${m.borderColor} ${m.bgColor} min-w-[64px]`}>
                        <span>{m.icon}</span>
                        <span className={`text-[9px] font-semibold ${m.textColor} whitespace-nowrap`}>{lbl}</span>
                        <span className="font-mono font-bold text-sm text-slate-800 mt-0.5">{qty == null ? <span className="text-slate-300 font-normal text-xs">–</span> : fmtQty(qty)}</span>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </section>
          )}

          {woRows.length > 0 && (
            <section>
              <SectionHead icon="📋" label="Work Orders" count={woRows.length} cls="text-violet-700" />
              <div className="overflow-x-auto rounded-lg border border-violet-100">
                <table className="text-xs border-collapse w-full">
                  <thead><tr className="border-b border-violet-100 bg-violet-50/60 text-slate-500 text-[10px]">
                    {["WO-Nr","Meal","Submeal","Menge","Platten","Status","MHD"].map(h => <td key={h} className="px-2 py-1.5 font-semibold">{h}</td>)}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {woRows.map((r, i) => (
                      <tr key={i} className="hover:bg-violet-50/30">
                        <td className="px-2 py-1 font-mono">{r.woNumber}</td>
                        <td className="px-2 font-mono text-violet-600">{r.mealItemNumber}</td>
                        <td className="px-2 font-mono text-slate-600">{r.submealItemNumber}</td>
                        <td className="px-2 font-mono font-semibold text-right">{fmtQty(r.quantity)}</td>
                        <td className="px-2 font-mono text-right">{fmtQty(r.plates)}</td>
                        <td className="px-2"><StatusBadge status={r.status} /></td>
                        <td className={`px-2 ${mhdClass(r.expirationDate)}`}>{fmtDate(r.expirationDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {inbRows.length > 0 && (
            <section>
              <SectionHead icon="📦" label="Wareneingang" count={inbRows.length} cls="text-emerald-700" />
              <div className="overflow-x-auto rounded-lg border border-emerald-100">
                <table className="text-xs border-collapse w-full">
                  <thead><tr className="border-b border-emerald-100 bg-emerald-50/60 text-slate-500 text-[10px]">
                    {["PO-Nr","Los-Nr","HU","Erhalten","Defekt","Lieferant","MHD","Eingang"].map(h => <td key={h} className="px-2 py-1.5 font-semibold">{h}</td>)}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {inbRows.map((r, i) => (
                      <tr key={i} className="hover:bg-emerald-50/30">
                        <td className="px-2 py-1 font-mono">{r.poNumber||"–"}</td>
                        <td className="px-2 font-mono">{r.lotNumber||"–"}</td>
                        <td className="px-2 font-mono">{r.huId||"–"}</td>
                        <td className="px-2 font-mono font-semibold text-right">{fmtQty(r.qtyReceived)}</td>
                        <td className={`px-2 font-mono text-right ${(r.qtyDamaged??0)>0?"text-rose-600 font-semibold":"text-slate-300"}`}>{fmtQty(r.qtyDamaged)}</td>
                        <td className="px-2">{r.vendorCode||"–"}</td>
                        <td className={`px-2 ${mhdClass(r.expirationDate)}`}>{fmtDate(r.expirationDate)}</td>
                        <td className="px-2">{fmtDate(r.receiptDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {([ ["staging","🗄️ Staging",stagRows], ["debox","📂 Debox",debRows], ["postblast","❄️ Post-Blast",pbRows], ["plating","🍽️ Plating",pltRows] ] as [StationKey, string, StoredRow[]][]).map(([sk, lbl, rws]) => rws.length > 0 && (
            <section key={sk}>
              <SectionHead icon="" label={lbl} count={rws.length} cls={STATION_META[sk].textColor} />
              <div className={`overflow-x-auto rounded-lg border ${STATION_META[sk].borderColor}`}>
                <table className="text-xs border-collapse w-full">
                  <thead><tr className={`border-b ${STATION_META[sk].borderColor} ${STATION_META[sk].bgColor} text-slate-500 text-[10px]`}>
                    {["Ort","Menge","Los-Nr","HU","Status","FIFO","MHD"].map(h => <td key={h} className="px-2 py-1.5 font-semibold">{h}</td>)}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {rws.map((r, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="px-2 py-1 font-mono">{r.locationId||"–"}</td>
                        <td className="px-2 font-mono font-semibold text-right">{fmtQty(r.actualQty)}</td>
                        <td className="px-2 font-mono">{r.lotNumber||"–"}</td>
                        <td className="px-2 font-mono">{r.huId||"–"}</td>
                        <td className="px-2">{r.status||"–"}</td>
                        <td className="px-2">{fmtDate(r.fifoDate)}</td>
                        <td className={`px-2 ${mhdClass(r.expirationDate)}`}>{fmtDate(r.expirationDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          {slvRows.length > 0 && (
            <section>
              <SectionHead icon="🔄" label="Sleeving-Verlauf" count={slvRows.length} cls="text-sky-700" />
              <div className="overflow-x-auto rounded-lg border border-sky-100">
                <table className="text-xs border-collapse w-full">
                  <thead><tr className="border-b border-sky-100 bg-sky-50/60 text-slate-500 text-[10px]">
                    {["Signal","Von","Nach","Menge","Art","Start","Ende","MA"].map(h => <td key={h} className="px-2 py-1.5 font-semibold">{h}</td>)}
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {slvRows.map((r, i) => {
                      const sig = sleevingSignal(r);
                      const sigCls = sig==="eingang"?"text-emerald-600 font-semibold":sig==="ausgang"?"text-orange-600 font-semibold":sig==="lost"?"text-rose-600 font-semibold":sig==="hold"?"text-amber-600 font-semibold":sig==="cycle"?"text-purple-600 font-semibold":"text-slate-400";
                      return (
                        <tr key={i} className="hover:bg-sky-50/30">
                          <td className={`px-2 py-1 ${sigCls}`}>{sig}</td>
                          <td className="px-2 font-mono">{r.von||"–"}</td>
                          <td className="px-2 font-mono">{r.nach||"–"}</td>
                          <td className="px-2 font-mono font-semibold text-right">{fmtQty(r.tranQty)}</td>
                          <td className="px-2">{r.tranType||"–"}</td>
                          <td className="px-2">{fmtDate(r.startTranDate)}</td>
                          <td className="px-2">{fmtDate(r.endTranDate)}</td>
                          <td className="px-2 font-mono">{r.employeeId||"–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {allLots.length > 0 && (
            <section>
              <SectionHead icon="🗺️" label="Los-Journey" count={allLots.length} cls="text-slate-600" />
              <div className="flex flex-wrap gap-2">
                {allLots.map(lot => {
                  const stations: StationKey[] = [];
                  if (inbRows.some(r => r.lotNumber === lot)) stations.push("inbound");
                  if (stagRows.some(r => r.lotNumber === lot)) stations.push("staging");
                  if (debRows.some(r => r.lotNumber === lot)) stations.push("debox");
                  if (pbRows.some(r => r.lotNumber === lot)) stations.push("postblast");
                  if (pltRows.some(r => r.lotNumber === lot)) stations.push("plating");
                  return (
                    <div key={lot} className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5">
                      <span className="font-mono text-[11px] font-semibold text-slate-700">{lot}</span>
                      <span className="text-slate-300">→</span>
                      <span className="inline-flex gap-0.5">
                        {STATION_ORDER.filter(s => stations.includes(s)).map(s => (
                          <span key={s} title={STATION_META[s].label} className={`text-[9px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>{STATION_META[s].icon}</span>
                        ))}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {woRows.length===0 && inbRows.length===0 && stagRows.length===0 && debRows.length===0 && pbRows.length===0 && slvRows.length===0 && pltRows.length===0 && (
            <div className="text-slate-400 text-sm text-center py-10">Keine Daten für {sku} in dieser KW.</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard KPI ────────────────────────────────────────────────────────────

function DashboardKpi({ aggInbound, aggStaging, aggDebox, aggPostblast, aggPlating, aggSleeving, skuMap }: {
  aggInbound: AggInboundRow[]; aggStaging: AggStoredRow[]; aggDebox: AggStoredRow[];
  aggPostblast: AggStoredRow[]; aggPlating: AggStoredRow[]; aggSleeving: AggSleevingRow[]; skuMap: SkuStationMap;
}) {
  const totalInbound = aggInbound.reduce((s, r) => s + r.totalReceived, 0);
  const allStored = [...aggStaging, ...aggDebox, ...aggPostblast, ...aggPlating];
  const stockSkus  = new Set(allStored.map(r => r.sku)).size;
  const stockTotal = allStored.reduce((s, r) => s + r.totalQty, 0);

  const mhdAlarm = allStored.filter(r => { if (!r.firstExpiry) return false; const d = daysUntil(r.firstExpiry); return d >= 0 && d < 3; }).length;
  const mhdWarn  = allStored.filter(r => { if (!r.firstExpiry) return false; const d = daysUntil(r.firstExpiry); return d >= 3 && d < 7; }).length;
  const sleevNet = aggSleeving.reduce((s, r) => s + r.net, 0);
  const sleevLost = aggSleeving.reduce((s, r) => s + r.lost, 0);
  const crossCount = [...skuMap.values()].filter(s => s.size >= 2).length;
  const lossRate = totalInbound > 0 ? sleevLost / totalInbound : 0;

  const tiles = [
    { label: "Wareneingang",  value: fmtQty(totalInbound), sub: `${aggInbound.length} SKUs`,   icon: "📦", cls: "border-emerald-200 bg-emerald-50 text-emerald-800" },
    { label: "Lagerbestand",  value: fmtQty(stockTotal),   sub: `${stockSkus} SKUs`,           icon: "🗄️", cls: "border-amber-200 bg-amber-50 text-amber-800" },
    { label: "MHD Kritisch",  value: String(mhdAlarm),     sub: "0–2 Tage",                    icon: "🚨", cls: mhdAlarm > 0 ? "border-rose-300 bg-rose-50 text-rose-800" : "border-slate-200 bg-slate-50 text-slate-400" },
    { label: "MHD Warnung",   value: String(mhdWarn),      sub: "3–6 Tage",                    icon: "⚠️", cls: mhdWarn  > 0 ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-200 bg-slate-50 text-slate-400" },
    { label: "Sleeving Net",  value: fmtQty(sleevNet),     sub: `${aggSleeving.length} SKUs`,  icon: "🔄", cls: sleevNet >= 0 ? "border-sky-200 bg-sky-50 text-sky-800" : "border-rose-200 bg-rose-50 text-rose-700" },
    { label: "Schwund",       value: fmtQty(sleevLost),    sub: lossRate > 0 ? `${(lossRate * 100).toFixed(1)}% v. Inbound` : "0%", icon: "🗑️", cls: sleevLost > 0 ? (lossRate > 0.05 ? "border-rose-300 bg-rose-50 text-rose-800" : "border-amber-300 bg-amber-50 text-amber-800") : "border-slate-200 bg-slate-50 text-slate-400" },
    { label: "Cross-Station", value: String(crossCount),   sub: "SKUs in ≥2 Stationen",        icon: "🔍", cls: "border-slate-600 bg-slate-800 text-white" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
      {tiles.map(t => (
        <div key={t.label} className={`rounded-xl border px-3 py-3 ${t.cls}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-base leading-none">{t.icon}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{t.label}</span>
          </div>
          <div className="font-mono font-bold text-xl leading-none">{t.value}</div>
          <div className="text-[10px] opacity-55 mt-1">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ─── WO Detail Panel ─────────────────────────────────────────────────────────

const WO_TRAN_TYPE_LABELS: Record<string, string> = {
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

const WO_PHASE_ORDER = ["370", "371", "380", "381", "393", "386", "387", "086", "651", "653", "650", "660", "661"];

function WoTranTypeBadge({ code }: { code: string }) {
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

function WoDetailPanel({ woNumber, transactions, workorders, detailMeta, aggSleeving, onClose, onTrace }: {
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

// ─── WO Badge (for station tables) ──────────────────────────────────────────

function WoBadge({ itemNumber, itemToWoMap, onWoDetail }: {
  itemNumber: string; itemToWoMap: Map<string, Set<string>>; onWoDetail: (wo: string) => void;
}) {
  const wos = itemToWoMap.get(itemNumber.toUpperCase());
  if (!wos || wos.size === 0) return null;
  const woList = [...wos];
  return (
    <span className="inline-flex flex-wrap gap-0.5 ml-1">
      {woList.slice(0, 3).map(wo => (
        <button key={wo} type="button" onClick={e => { e.stopPropagation(); onWoDetail(wo); }}
          className="px-1 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200 text-[9px] font-mono font-semibold hover:bg-violet-100 cursor-pointer">
          {wo}
        </button>
      ))}
      {woList.length > 3 && <span className="text-[9px] text-slate-400">+{woList.length - 3}</span>}
    </span>
  );
}

// ─── MHD Alert Banner ─────────────────────────────────────────────────────────

function MhdAlertBanner({ allStored }: { allStored: AggStoredRow[] }) {
  const [dismissed, setDismissed] = useState(false);

  const withDays = allStored
    .filter(r => r.firstExpiry)
    .map(r => ({ ...r, days: daysUntil(r.firstExpiry!) }));

  const critical = withDays.filter(r => r.days >= 0 && r.days < 3).sort((a, b) => a.days - b.days);
  const warning  = withDays.filter(r => r.days >= 3 && r.days < 7).sort((a, b) => a.days - b.days);
  const total    = critical.length + warning.length;

  if (total === 0 || dismissed) return null;

  const Item = ({ r, cls, borderCls }: { r: typeof critical[0]; cls: string; borderCls: string }) => (
    <div className={`flex items-center gap-1.5 bg-white border ${borderCls} rounded-lg px-2 py-1`}>
      <span className={`font-mono text-xs font-semibold ${cls}`}>{r.sku}</span>
      <span className="text-[10px] text-slate-400">{r.location}</span>
      <span className={`text-[10px] font-bold ${cls}`}>{fmtDate(r.firstExpiry)}</span>
      <span className={`text-[9px] font-mono ${cls}`}>{r.days === 0 ? "heute" : `${r.days}T`}</span>
    </div>
  );

  return (
    <div className="rounded-xl border-2 border-rose-400 bg-rose-50 px-4 py-3 shadow-md space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🚨</span>
          <span className="font-bold text-rose-800 text-sm">
            MHD-Alarm: {critical.length > 0 && <span className="text-rose-700">{critical.length} kritisch (0–2 Tage)</span>}
            {critical.length > 0 && warning.length > 0 && <span className="text-rose-400 mx-1">·</span>}
            {warning.length > 0 && <span className="text-amber-700">{warning.length} Warnung (3–6 Tage)</span>}
          </span>
        </div>
        <button type="button" onClick={() => setDismissed(true)} className="text-rose-400 hover:text-rose-700 font-bold text-lg leading-none px-2">✕</button>
      </div>
      {critical.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {critical.slice(0, 15).map(r => <Item key={r.key} r={r} cls="text-rose-800" borderCls="border-rose-300" />)}
          {critical.length > 15 && <span className="text-xs text-rose-600 self-center">+{critical.length - 15}</span>}
        </div>
      )}
      {warning.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {warning.slice(0, 10).map(r => <Item key={r.key} r={r} cls="text-amber-700" borderCls="border-amber-200" />)}
          {warning.length > 10 && <span className="text-xs text-amber-600 self-center">+{warning.length - 10}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Yield Alert Banner ──────────────────────────────────────────────────────

function YieldAlertBanner({ aggSleeving, bilanz, itemToWoMap }: {
  aggSleeving: AggSleevingRow[];
  bilanz: SkuBilanzEntry[];
  itemToWoMap: Map<string, Set<string>>;
}) {
  const [dismissed, setDismissed] = useState(false);

  const yieldIssues = useMemo(() => {
    const issues: { sku: string; lost: number; rate: number; wos: string[]; type: "sleeving" | "unresolved" }[] = [];
    for (const r of aggSleeving) {
      if (r.lost > 0 && r.eingang > 0) {
        const rate = r.lost / r.eingang;
        if (rate > 0.15 || r.lost > 500) {
          const wos = [...(itemToWoMap.get(r.sku.toUpperCase()) ?? [])];
          issues.push({ sku: r.sku, lost: r.lost, rate, wos, type: "sleeving" });
        }
      }
    }
    for (const e of bilanz) {
      if (e.unresolvedGap > 500 || (e.inboundQty > 0 && e.unresolvedGap / e.inboundQty > 0.15)) {
        const wos = [...(itemToWoMap.get(e.sku.toUpperCase()) ?? [])];
        if (!issues.some(i => i.sku === e.sku)) {
          issues.push({ sku: e.sku, lost: e.unresolvedGap, rate: e.inboundQty > 0 ? e.unresolvedGap / e.inboundQty : 0, wos, type: "unresolved" });
        }
      }
    }
    return issues.sort((a, b) => b.lost - a.lost);
  }, [aggSleeving, bilanz, itemToWoMap]);

  if (yieldIssues.length === 0 || dismissed) return null;

  const totalLost = yieldIssues.reduce((s, i) => s + i.lost, 0);

  return (
    <div className="rounded-xl border-2 border-orange-400 bg-orange-50 px-4 py-3 shadow-md space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">⚠️</span>
          <span className="font-bold text-orange-800 text-sm">
            Yield-Alarm: {yieldIssues.length} SKU{yieldIssues.length > 1 ? "s" : ""} mit massivem Verlust ({fmtQty(totalLost)} Einheiten gesamt)
          </span>
        </div>
        <button type="button" onClick={() => setDismissed(true)} className="text-orange-400 hover:text-orange-700 font-bold text-lg leading-none px-2">✕</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {yieldIssues.slice(0, 12).map(i => (
          <div key={i.sku} className={`flex items-center gap-1.5 bg-white border ${i.type === "sleeving" ? "border-orange-300" : "border-rose-300"} rounded-lg px-2 py-1`}>
            <span className="font-mono text-xs font-semibold text-slate-800">{i.sku}</span>
            <span className={`text-[10px] font-bold ${i.rate > 0.25 ? "text-rose-700" : "text-orange-700"}`}>−{fmtQty(i.lost)}</span>
            <span className="text-[9px] font-mono text-orange-600">({(i.rate * 100).toFixed(0)}%)</span>
            {i.type === "sleeving" && <span className="text-[9px] text-sky-600">Sleev</span>}
            {i.type === "unresolved" && <span className="text-[9px] text-rose-600">Schwund</span>}
            {i.wos.length > 0 && <span className="text-[9px] text-violet-600">WO:{i.wos.slice(0, 2).join(",")}</span>}
          </div>
        ))}
        {yieldIssues.length > 12 && <span className="text-xs text-orange-600 self-center">+{yieldIssues.length - 12}</span>}
      </div>
    </div>
  );
}

// ─── Raw Detail Row ───────────────────────────────────────────────────────────

function RawDetailRow({ children }: { children: ReactNode }) {
  return (
    <tr className="bg-slate-50/80">
      <td colSpan={99} className="px-6 py-2 border-t border-slate-100">
        {children}
      </td>
    </tr>
  );
}

// ─── Station: Work Orders ─────────────────────────────────────────────────────

const STORAGE_STATIONS: StationKey[] = ["inbound", "staging", "debox", "postblast", "plating"];

type WoFlowStageKey = "workorders" | "inbound" | "staging" | "debox" | "preblast" | "postblast" | "sleeving" | "plating" | "kitchen" | "other";

const WO_FLOW_META: Record<WoFlowStageKey, { label: string; icon: string; className: string; rank: number }> = {
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

function classifyWoLocation(location: string): WoFlowStageKey {
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

type WoTransitionAgg = {
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

type PlausibilityLevel = "ok" | "warn" | "err" | "offen";

type WoPlausibilityCheck = {
  key: string;
  label: string;
  planned: number;
  actual: number;
  delta: number;
  pct: number | null;
  level: PlausibilityLevel;
};

function buildWoTransitions(transactions: WoTransactionRow[]): WoTransitionAgg[] {
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

function buildWoStageChain(woRows: WorkorderRow[], transactions: WoTransactionRow[]): WoFlowStageKey[] {
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

function WoStageChain({ stages }: { stages: WoFlowStageKey[] }) {
  if (stages.length === 0) return <span className="text-slate-300">–</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {stages.map((stage, index) => {
        const meta = WO_FLOW_META[stage];
        return (
          <React.Fragment key={stage}>
            {index > 0 && <span className="text-slate-300 text-[10px]">→</span>}
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${meta.className}`}>
              <span>{meta.icon}</span>
              <span>{meta.label}</span>
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function WoTransitionTable({ transitions, emptyLabel }: { transitions: WoTransitionAgg[]; emptyLabel: string }) {
  if (transitions.length === 0) return <div className="text-[11px] text-slate-400">{emptyLabel}</div>;
  return (
    <div className="overflow-x-auto rounded border border-slate-200 bg-white">
      <table className="w-full text-[10px]">
        <thead>
          <tr className="bg-slate-50 text-slate-500">
            <th className="px-2 py-1 text-left font-semibold">Von</th>
            <th className="px-2 py-1 text-left font-semibold">Nach</th>
            <th className="px-2 py-1 text-right font-semibold">Menge</th>
            <th className="px-2 py-1 text-right font-semibold">Beweg.</th>
            <th className="px-2 py-1 text-left font-semibold">Items</th>
            <th className="px-2 py-1 text-left font-semibold">Lose</th>
          </tr>
        </thead>
        <tbody>
          {transitions.map((row) => (
            <tr key={row.key} className="border-t border-slate-100 hover:bg-slate-50">
              <td className="px-2 py-1 font-mono text-slate-700">{row.from || "–"}</td>
              <td className="px-2 py-1 font-mono text-slate-700">{row.to || "–"}</td>
              <td className="px-2 py-1 text-right font-mono font-semibold">{fmtQty(row.totalQty)}</td>
              <td className="px-2 py-1 text-right font-mono text-slate-500">{row.count}</td>
              <td className="px-2 py-1 text-slate-600">{row.items.slice(0, 3).join(", ") || "–"}{row.items.length > 3 ? ` +${row.items.length - 3}` : ""}</td>
              <td className="px-2 py-1 text-slate-600">{row.lots.slice(0, 2).join(", ") || "–"}{row.lots.length > 2 ? ` +${row.lots.length - 2}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function buildWoPlausibilityChecks(plannedQty: number, plannedPreblast: number, totalPreblast: number, totalPostblast: number, sleevingLost?: number): WoPlausibilityCheck[] {
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

function PlausibilityBadge({ level, children }: { level: PlausibilityLevel; children: ReactNode }) {
  const cls = level === "ok"
    ? "bg-emerald-100 text-emerald-700 border-emerald-200"
    : level === "warn"
      ? "bg-amber-100 text-amber-700 border-amber-200"
      : level === "err"
        ? "bg-rose-100 text-rose-700 border-rose-200"
        : "bg-slate-100 text-slate-500 border-slate-200";
  return <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-semibold ${cls}`}>{children}</span>;
}

function WoPlausibilityPanel({ checks }: { checks: WoPlausibilityCheck[] }) {
  return (
    <div className="grid gap-2 md:grid-cols-3">
      {checks.map((check) => (
        <div key={check.key} className="rounded-lg border border-slate-200 bg-white p-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase text-slate-500">{check.label}</div>
            <PlausibilityBadge level={check.level}>{check.level.toUpperCase()}</PlausibilityBadge>
          </div>
          <div className="space-y-1 text-[10px] text-slate-600">
            <div className="flex justify-between gap-2"><span>Plan</span><span className="font-mono">{fmtQty(check.planned)}</span></div>
            <div className="flex justify-between gap-2"><span>Ist</span><span className="font-mono">{fmtQty(check.actual)}</span></div>
            <div className="flex justify-between gap-2"><span>Delta</span><span className={`font-mono ${check.level === "err" ? "text-rose-600" : check.level === "warn" ? "text-amber-600" : "text-slate-700"}`}>{fmtQty(check.delta)}</span></div>
            <div className="flex justify-between gap-2"><span>Abw.</span><span className="font-mono">{check.pct == null ? "–" : `${check.pct.toFixed(1)}%`}</span></div>
          </div>
        </div>
      ))}
    </div>
  );
}

function WoFlowGraph({ transitions }: { transitions: WoTransitionAgg[] }) {
  if (transitions.length === 0) return <div className="text-[11px] text-slate-400">Keine gerichteten Flüsse verfügbar</div>;
  const maxQty = Math.max(1, ...transitions.map((row) => row.totalQty));
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2">
      {transitions.map((row, index) => {
        const fromMeta = WO_FLOW_META[row.fromStage];
        const toMeta = WO_FLOW_META[row.toStage];
        const width = Math.max(8, Math.round((row.totalQty / maxQty) * 100));
        const prevQty = index > 0 ? transitions[index - 1].totalQty : null;
        const deltaPct = prevQty && prevQty > 0 ? ((row.totalQty - prevQty) / prevQty) * 100 : null;
        const absDeltaPct = Math.abs(deltaPct ?? 0);
        const breakLevel: PlausibilityLevel = deltaPct == null
          ? "offen"
          : absDeltaPct <= 10
            ? "ok"
            : absDeltaPct <= 25
              ? "warn"
              : "err";
        const trackCls = breakLevel === "err"
          ? "bg-rose-500"
          : breakLevel === "warn"
            ? "bg-amber-500"
            : breakLevel === "ok"
              ? "bg-emerald-500"
              : "bg-violet-500";
        const rowCls = breakLevel === "err"
          ? "border-rose-200 bg-rose-50/40"
          : breakLevel === "warn"
            ? "border-amber-200 bg-amber-50/40"
            : "border-transparent bg-transparent";
        return (
          <div key={row.key} className={`grid gap-2 rounded-lg border p-2 md:grid-cols-[180px_1fr_180px] md:items-center ${rowCls}`}>
            <div className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-semibold ${fromMeta.className}`}>
              <span>{fromMeta.icon}</span><span className="truncate">{row.from || fromMeta.label}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2 flex-1 rounded-full bg-slate-100 overflow-hidden">
                <div className={`h-full rounded-full ${trackCls}`} style={{ width: `${width}%` }} />
              </div>
              <div className="flex flex-col items-end text-[10px] font-mono text-slate-600 whitespace-nowrap">
                <span>{fmtQty(row.totalQty)} · {row.count}x</span>
                {deltaPct != null && (
                  <span className={breakLevel === "err" ? "text-rose-600" : breakLevel === "warn" ? "text-amber-600" : "text-slate-400"}>
                    Bruch {deltaPct > 0 ? "+" : ""}{deltaPct.toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-1">
              {deltaPct != null && breakLevel !== "offen" && <PlausibilityBadge level={breakLevel}>{breakLevel.toUpperCase()}</PlausibilityBadge>}
              <div className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-semibold ${toMeta.className}`}>
                <span>{toMeta.icon}</span><span className="truncate">{row.to || toMeta.label}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function woReadiness(submeals: WorkorderRow[], skuMap: SkuStationMap): { available: number; inSleeving: number; total: number; pct: number } {
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

function ReadinessBadge({ available, inSleeving, total, pct }: { available: number; inSleeving?: number; total: number; pct: number }) {
  if (total === 0) return <span className="text-slate-300 text-xs">–</span>;
  const cls = pct >= 100 ? "bg-emerald-100 text-emerald-700 border-emerald-200"
             : pct >= 60  ? "bg-amber-100 text-amber-700 border-amber-200"
             :               "bg-rose-100 text-rose-700 border-rose-200";
  const icon = pct >= 100 ? "✓" : pct >= 60 ? "△" : "✗";
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${cls}`}>
      <span>{icon}</span>
      <span className="font-mono">{available}{inSleeving ? `+${inSleeving}🔄` : ""}/{total}</span>
      <span className="opacity-60">{pct}%</span>
    </span>
  );
}

// ─── WO-zentrierte Liste (alle WOs der KW) ──────────────────────────────────

type WoSummary = {
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

function buildWoSummaries(workorders: WorkorderRow[], woTransactionMap: Map<string, WoTransactionRow[]>): WoSummary[] {
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

function WoProgressDots({ wo }: { wo: WoSummary }) {
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

function WoListTable({ workorders, woTransactionMap, search, onWoDetail, onTrace }: {
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

function WorkordersMealTable({ meals, skuMap, search, weekNum, onTrace, onDetail, onWoDetail, skuInfoIndex }: {
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

// ─── Station: Inbound ─────────────────────────────────────────────────────────

function InboundAggTable({ rows, skuMap, lotMap, search, onTrace, onDetail, skuInfoIndex }: {
  rows: AggInboundRow[]; skuMap: SkuStationMap; lotMap: LotStationMap; search: string; onTrace: (sku: string) => void; onDetail: (sku: string) => void; skuInfoIndex: Map<string, WmsSkuInfo>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const needle = search.trim().toUpperCase();

  const filtered = needle
    ? rows.filter(r =>
        r.sku.includes(needle) ||
        r.vendors.some(v => v.toUpperCase().includes(needle)) ||
        r.rawRows.some(raw =>
          [raw.poNumber, raw.lotNumber, raw.huId, raw.shipmentNumber].some(f => String(f ?? "").toUpperCase().includes(needle))
        )
      )
    : rows;

  const shown = expanded ? filtered : filtered.slice(0, 20);
  const toggleRow = (sku: string) =>
    setOpenRows(prev => {
      const s = new Set(prev);
      if (s.has(sku)) s.delete(sku);
      else s.add(sku);
      return s;
    });

  if (rows.length === 0) return <div className="px-4 py-5 text-slate-400 text-sm text-center">Kein Wareneingang für diese KW</div>;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="border-b border-slate-200">
            <tr>
              <Th></Th>
              <Th>SKU</Th>
              <Th right>Erhalten</Th>
              <Th right>Defekt</Th>
              <Th>POs</Th>
              <Th>Lose</Th>
              <Th>HUs</Th>
              <Th>Lieferant</Th>
              <Th>Status</Th>
              <Th>MHD (nächste)</Th>
              <Th>Letzter Eingang</Th>
              <Th>Los auch in…</Th>
              <Th>Stationen</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(row => {
              const isOpen  = openRows.has(row.sku);
              const isMatch = needle && row.sku.includes(needle);
              const allLots = [...new Set(row.rawRows.map(r => r.lotNumber).filter(Boolean))];
              return (
                <React.Fragment key={row.sku}>
                  <tr className={`hover:bg-emerald-50/30 ${isMatch ? "bg-amber-50/60 ring-1 ring-amber-300 ring-inset" : ""}`}>
                    <Td>
                      <button type="button" onClick={() => toggleRow(row.sku)} className="text-slate-400 hover:text-slate-700 w-4 text-center font-mono text-[11px]">
                        {isOpen ? "▼" : "▶"}
                      </button>
                    </Td>
                    <Td mono cls="font-semibold text-slate-800">
                      <span className="hover:underline cursor-pointer" title="Details anzeigen" onClick={() => onDetail(row.sku)}>
                        <SkuLabel sku={row.sku} skuInfoIndex={skuInfoIndex} />
                      </span>
                      {skuMap.get(row.sku)?.has("workorders") && (
                        <span title="Zutat in Work Order dieser KW" className="ml-1 text-[9px] px-1 py-0.5 rounded bg-violet-100 text-violet-700 border border-violet-200 font-semibold">WO</span>
                      )}
                      <StationBadges sku={row.sku} stationMap={skuMap} currentStation="inbound" onTrace={onTrace} />
                    </Td>
                    <Td right mono cls="font-bold text-slate-800">{fmtQty(row.totalReceived)}</Td>
                    <Td right mono cls={row.totalDamaged > 0 ? "text-rose-700 font-bold" : "text-slate-300"}>{fmtQty(row.totalDamaged)}</Td>
                    <Td mono cls="text-slate-500">{row.poCount}x</Td>
                    <Td mono cls="text-slate-500">{row.lotCount}x</Td>
                    <Td mono cls="text-slate-500">{row.huCount}x</Td>
                    <Td cls="text-slate-600 text-[11px]">{row.vendors.join(", ") || "–"}</Td>
                    <Td><div className="flex flex-wrap gap-0.5">{row.statuses.map(s => <StatusBadge key={s} status={s} />)}</div></Td>
                    <Td cls={mhdClass(row.nextExpiry)}>{fmtDate(row.nextExpiry)}</Td>
                    <Td>{fmtDate(row.lastReceipt)}</Td>
                    <Td><LotCrossStations lots={allLots} lotMap={lotMap} currentStation="inbound" /></Td>
                    <Td>
                      <span className="inline-flex gap-0.5">
                        {STATION_ORDER.filter(s => s !== "inbound" && skuMap.get(row.sku)?.has(s)).map(s => (
                          <span key={s} title={STATION_META[s].label} className={`text-[9px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>
                            {STATION_META[s].icon}
                          </span>
                        ))}
                      </span>
                    </Td>
                  </tr>
                  {isOpen && (
                    <RawDetailRow>
                      <div className="overflow-x-auto">
                        <table className="text-[10px] border-collapse w-full">
                          <thead>
                            <tr className="text-slate-400 border-b border-slate-200">
                              {["PO-Nr", "Los-Nr", "HU", "Erhalten", "Defekt", "Status", "MHD", "Eingang", "Lieferant", "Sendung"].map(h => (
                                <td key={h} className={`pb-1 pr-4 font-semibold ${["Erhalten","Defekt"].includes(h) ? "text-right" : ""}`}>{h}</td>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {row.rawRows.map((r, i) => (
                              <tr key={i} className="hover:bg-white">
                                <td className="pr-4 font-mono py-0.5">{r.poNumber || "–"}</td>
                                <td className="pr-4 font-mono">{r.lotNumber || "–"}</td>
                                <td className="pr-4 font-mono">{r.huId || "–"}</td>
                                <td className="pr-4 text-right font-mono font-semibold">{fmtQty(r.qtyReceived)}</td>
                                <td className={`pr-4 text-right font-mono ${(r.qtyDamaged ?? 0) > 0 ? "text-rose-600 font-semibold" : "text-slate-300"}`}>{fmtQty(r.qtyDamaged)}</td>
                                <td className="pr-4">{r.status}</td>
                                <td className={`pr-4 ${mhdClass(r.expirationDate)}`}>{fmtDate(r.expirationDate)}</td>
                                <td className="pr-4">{fmtDate(r.receiptDate)}</td>
                                <td className="pr-4 font-mono">{r.vendorCode || "–"}</td>
                                <td className="font-mono">{r.shipmentNumber || "–"}</td>
                              </tr>
                            ))}
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

// ─── Stationsbilanz ─────────────────────────────────────────────────────────

type KettenbruchResult = { label: string; severity: "stuck" | "drop" | "yield_loss" };

function detectKettenbruch(e: SkuBilanzEntry): KettenbruchResult | null {
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

// ─── Bilanz-Rechnung (expandable detail per SKU) ──────────────────────────────

function BilanzRechnung({ e, snapEntry }: { e: SkuBilanzEntry; snapEntry: SkuBilanzEntry | null }) {
  const kb = detectKettenbruch(e);
  const R = ({ label, value, cls, sub }: { label: string; value: number; cls?: string; sub?: boolean }) => (
    <div className={`flex justify-between py-0.5 ${sub ? "pl-3 text-[11px]" : "text-xs"}`}>
      <span className={sub ? "text-slate-500" : "text-slate-700"}>{label}</span>
      <span className={`font-mono font-semibold ${cls ?? "text-slate-700"}`}>{fmtQty(value)}</span>
    </div>
  );
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Differenzrechnung</div>
        <div className="bg-white rounded-lg border border-slate-200 px-3 py-2 space-y-0.5">
          <R label="WO Bedarf (geplant)" value={e.woRequired} cls="font-bold text-slate-800" />
          <R label="Inbound erhalten" value={e.inboundQty}
            cls={e.inboundQty === 0 ? "text-slate-300" : e.inboundQty < e.woRequired ? "text-amber-600" : "text-emerald-700"} />
          <div className="border-t border-slate-100 my-1" />
          <R label="\u2211 Lager (alle Stationen)" value={e.totalStock} cls="font-bold text-slate-800" />
          {e.stagingQty   > 0 && <R label="davon Staging"    value={e.stagingQty}   cls="text-amber-700"  sub />}
          {e.deboxQty     > 0 && <R label="davon Debox"      value={e.deboxQty}     cls="text-orange-700" sub />}
          {e.postblastQty > 0 && <R label="davon Post-Blast" value={e.postblastQty} cls="text-rose-700"   sub />}
          {e.platingQty   > 0 && <R label="davon Plating"    value={e.platingQty}   cls="text-blue-700"   sub />}
          <div className="border-t border-slate-100 my-1" />
          <R label="Sleeving Verlust (dok.)" value={e.sleevingLost}
            cls={e.sleevingLost > 0 ? "text-rose-600" : "text-slate-300"} />
          {e.inboundQty > 0 && (
            <div className={`flex justify-between text-xs py-0.5 border-t border-dashed mt-1 pt-1 ${e.unresolvedGap > 0 ? "border-rose-300" : "border-slate-200"}`}>
              <span className={e.unresolvedGap > 0 ? "text-rose-700 font-semibold" : "text-slate-500"}>Unerklärter Schwund (Inb. − Lager − Verlust)</span>
              <span className={`font-mono font-bold ${e.unresolvedGap > 0 ? "text-rose-700" : "text-emerald-600"}`}>
                {e.unresolvedGap > 0 ? fmtQty(e.unresolvedGap) : "0"}
              </span>
            </div>
          )}
          <div className={`flex justify-between text-sm font-bold py-1 border-t mt-1 ${e.gap < 0 ? "border-rose-300 text-rose-700" : "border-emerald-200 text-emerald-700"}`}>
            <span>\u0394 Lager vs. WO</span>
            <span className="font-mono">{e.gap >= 0 ? `+${fmtQty(e.gap)}` : fmtQty(e.gap)}</span>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        {e.unresolvedGap > 0 && (
          <div className="rounded-lg border-2 border-rose-500 bg-rose-50 px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-rose-400 mb-1">🚨 Unerklärte Fehlmenge</div>
            <div className="text-sm font-bold text-rose-800">{fmtQty(e.unresolvedGap)} Einheiten ohne Buchungsbeleg</div>
            <div className="text-[11px] text-rose-500 mt-0.5 font-mono">
              {fmtQty(e.inboundQty)} − {fmtQty(e.totalStock)} − {fmtQty(e.sleevingLost)} = {fmtQty(e.unresolvedGap)}
            </div>
          </div>
        )}
        {kb && (
        <div className={`rounded-lg border px-3 py-2 ${kb.severity === "stuck" ? "border-amber-300 bg-amber-50" : kb.severity === "yield_loss" ? "border-rose-300 bg-rose-50" : "border-rose-200 bg-rose-50"}`}>
          <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">{kb.severity === "yield_loss" ? "🗑️ Yield-Verlust" : "⚡ Engpass erkannt"}</div>
          <div className={`text-sm font-semibold ${kb.severity === "stuck" ? "text-amber-800" : "text-rose-700"}`}>{kb.label}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {kb.severity === "stuck" ? "Ware liegt hier — kein Weitertransport erkennbar" : kb.severity === "yield_loss" ? "Massiver Verlust zwischen Inbound und aktuellem Bestand" : "Mengendifferenz zwischen zwei Stationen"}
            </div>
          </div>
        )}
        {e.sleevingLost > 0 && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">🗑️ Dokumentierter Verlust</div>
            <div className="text-sm font-semibold text-rose-700">{fmtQty(e.sleevingLost)} als Sleeving-Verlust gebucht</div>
          </div>
        )}
        {snapEntry && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[10px] font-bold uppercase text-slate-400 mb-1">📸 Snapshot-\u0394</div>
            <div className="space-y-0.5 text-xs">
              <div className="flex justify-between"><span className="text-slate-500">Lager damals</span><span className="font-mono">{fmtQty(snapEntry.totalStock)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Lager jetzt</span><span className="font-mono">{fmtQty(e.totalStock)}</span></div>
              <div className={`flex justify-between font-bold ${e.totalStock >= snapEntry.totalStock ? "text-emerald-700" : "text-rose-700"}`}>
                <span>Netto-\u0394</span>
                <span className="font-mono">{e.totalStock >= snapEntry.totalStock ? "+" : ""}{fmtQty(e.totalStock - snapEntry.totalStock)}</span>
              </div>
            </div>
          </div>
        )}
        {!kb && e.sleevingLost === 0 && e.unresolvedGap === 0 && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 font-semibold">
            \u2713 Keine Auffälligkeiten \u00b7 Deckung: {e.coverage.toFixed(1)}%
          </div>
        )}
      </div>
    </div>
  );
}

function StationsBilanz({ bilanz, compareSnap, week, onTrace, onWoDetail, skuInfoIndex }: {
  bilanz: SkuBilanzEntry[];
  compareSnap: WmsSnapshot | null;
  week: string;
  onTrace: (sku: string) => void;
  onWoDetail: (wo: string) => void;
  skuInfoIndex: Map<string, WmsSkuInfo>;
}) {
  const [filter, setFilter] = useState<"all" | "deficit" | "surplus" | "ok" | "unresolved">("all");
  const [showAll, setShowAll] = useState(false);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);

  const deficitCount    = bilanz.filter(e => e.gap < -10).length;
  const surplusCount    = bilanz.filter(e => e.gap > 100).length;
  const okCount         = bilanz.filter(e => e.gap >= -10 && e.gap <= 100).length;
  const unresolvedCount = bilanz.filter(e => e.unresolvedGap > 0).length;

  const filtered = bilanz.filter(e => {
    if (filter === "deficit")    return e.gap < -10;
    if (filter === "surplus")    return e.gap > 100;
    if (filter === "ok")         return e.gap >= -10 && e.gap <= 100;
    if (filter === "unresolved") return e.unresolvedGap > 0;
    return true;
  });

  const shown = showAll ? filtered : filtered.slice(0, 40);
  const snapMap = compareSnap ? new Map(compareSnap.bilanz.map(e => [e.sku, e])) : null;

  const coverageCls = (cov: number) =>
    cov >= 100 ? "text-emerald-700 font-bold" :
    cov >= 75  ? "text-amber-600 font-semibold" :
    cov >= 50  ? "text-orange-600 font-semibold" :
                 "text-rose-700 font-bold";

  const gapCls = (gap: number) =>
    gap >= 0   ? "text-emerald-700" :
    gap >= -50 ? "text-amber-600"   :
                 "text-rose-700 font-bold";

  if (bilanz.length === 0) return null;

  return (
    <div className="rounded-xl border border-slate-700 overflow-hidden shadow-md">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-slate-900 text-white">
        <div className="flex items-center gap-2">
          <span>🎛️</span>
          <span className="font-bold text-sm">Stationsbilanz</span>
          <span className="text-xs text-slate-400">Fehlbestand & Überproduktion · {week}</span>
          {compareSnap && (
            <span className="text-[10px] font-semibold bg-amber-500/30 text-amber-300 px-2 py-0.5 rounded-full">∆ vs {compareSnap.label}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {(["all", "deficit", "surplus", "ok", "unresolved"] as const).map(f => {
            const count = f === "all" ? bilanz.length : f === "deficit" ? deficitCount : f === "surplus" ? surplusCount : f === "ok" ? okCount : unresolvedCount;
            const labels = { all: `Alle (${count})`, deficit: `⚠️ Fehlbestand (${count})`, surplus: `📈 Überschuss (${count})`, ok: `✓ OK (${count})`, unresolved: `🚨 Unerklärt (${count})` };
            const activeCls = f === "deficit" ? "bg-rose-600 text-white" : f === "surplus" ? "bg-amber-600 text-white" : f === "ok" ? "bg-emerald-600 text-white" : f === "unresolved" ? "bg-rose-900 text-white" : "bg-slate-600 text-white";
            return (
              <button key={f} type="button"
                className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-opacity ${filter === f ? activeCls : "bg-white/10 text-slate-300 hover:bg-white/20"}`}
                onClick={() => setFilter(f)}>
                {labels[f]}
              </button>
            );
          })}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200">
              <Th>SKU</Th>
              <Th right>Inbound</Th>
              <Th right>WO Bedarf</Th>
              <Th right>🗄️ Staging</Th>
              <Th right>📂 Debox</Th>
              <Th right>❄️ Post-Blast</Th>
              <Th right>🍽️ Plating</Th>
              <Th right>🔄 Sleeving</Th>
              <Th right>Gesamt Lager</Th>
              <Th right>Deckung</Th>
              <Th right>Delta</Th>
              {snapMap && <Th right>Δ Snapshot</Th>}
              <Th right>🗑️ Schwund</Th>
              <Th>⚡ Engpass</Th>
              <Th>WOs</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(e => {
              const snapEntry = snapMap?.get(e.sku);
              const snapDelta = snapEntry != null ? e.totalStock - snapEntry.totalStock : null;
              const rowCls = e.gap < -10 ? "bg-rose-50/50" : e.gap > 100 ? "bg-emerald-50/30" : "";
              const isExpanded = expandedSku === e.sku;
              const kb = detectKettenbruch(e);
              return (
                <React.Fragment key={e.sku}>
                  <tr className={`${rowCls} hover:bg-slate-50/80`}>
                    <Td mono cls="font-semibold text-slate-800">
                      <span className="inline-flex items-center gap-1">
                        <button type="button"
                          onClick={() => setExpandedSku(s => s === e.sku ? null : e.sku)}
                          className="text-slate-400 hover:text-slate-700 text-[10px] w-3 shrink-0 text-center">
                          {isExpanded ? "▼" : "▶"}
                        </button>
                        <span className="cursor-pointer hover:underline" onClick={() => onTrace(e.sku)}><SkuLabel sku={e.sku} skuInfoIndex={skuInfoIndex} /></span>
                        {e.unresolvedGap > 0 && <span className="w-1.5 h-1.5 rounded-full bg-rose-500 inline-block shrink-0" title="Unerklärte Fehlmenge" />}
                      </span>
                    </Td>
                    <Td right mono cls={e.inboundQty === 0 ? "text-slate-300" : "text-emerald-700"}>{e.inboundQty > 0 ? fmtQty(e.inboundQty) : "–"}</Td>
                    <Td right mono cls="font-bold text-slate-700">{fmtQty(e.woRequired)}</Td>
                    <Td right mono cls={e.stagingQty === 0 ? "text-slate-300" : "text-amber-700"}>{e.stagingQty > 0 ? fmtQty(e.stagingQty) : "–"}</Td>
                    <Td right mono cls={e.deboxQty === 0 ? "text-slate-300" : "text-orange-700"}>{e.deboxQty > 0 ? fmtQty(e.deboxQty) : "–"}</Td>
                    <Td right mono cls={e.postblastQty === 0 ? "text-slate-300" : "text-rose-700"}>{e.postblastQty > 0 ? fmtQty(e.postblastQty) : "–"}</Td>
                    <Td right mono cls={e.platingQty === 0 ? "text-slate-300" : "text-blue-700"}>{e.platingQty > 0 ? fmtQty(e.platingQty) : "–"}</Td>
                    <Td right mono cls={e.sleevingNet === 0 ? "text-slate-300" : e.sleevingNet > 0 ? "text-sky-700" : "text-rose-600"}>{e.sleevingNet !== 0 ? fmtQty(e.sleevingNet) : "–"}</Td>
                    <Td right mono cls="font-bold text-slate-800">{fmtQty(e.totalStock)}</Td>
                    <Td right>
                      <div className="flex items-center gap-1 justify-end">
                        <span className={`font-mono font-bold ${coverageCls(e.coverage)}`}>{e.coverage.toFixed(0)}%</span>
                        <span className="w-10 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                          <span className={`block h-full rounded-full ${e.coverage >= 100 ? "bg-emerald-500" : e.coverage >= 75 ? "bg-amber-500" : "bg-rose-500"}`}
                            style={{ width: `${Math.min(100, e.coverage).toFixed(0)}%` }} />
                        </span>
                      </div>
                    </Td>
                    <Td right mono cls={gapCls(e.gap)}>
                      {e.gap >= 0 ? `+${fmtQty(e.gap)}` : fmtQty(e.gap)}
                    </Td>
                    {snapMap && (
                      <Td right mono cls={snapDelta == null ? "text-slate-300" : snapDelta > 0 ? "text-emerald-600 font-semibold" : snapDelta < 0 ? "text-rose-600 font-semibold" : "text-slate-400"}>
                        {snapDelta == null ? "–" : snapDelta > 0 ? `+${fmtQty(snapDelta)}` : fmtQty(snapDelta)}
                      </Td>
                    )}
                    <Td right mono cls={e.sleevingLost > 0 ? "text-rose-600 font-semibold" : "text-slate-300"}>
                      {e.sleevingLost > 0 ? fmtQty(e.sleevingLost) : "–"}
                    </Td>
                    <Td>
                      {kb && (
                        <span className={`inline-block px-1.5 py-0.5 rounded border text-[9px] font-semibold ${kb.severity === "stuck" ? "bg-amber-100 text-amber-800 border-amber-300" : "bg-rose-100 text-rose-700 border-rose-200"}`}>
                          {kb.label}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-0.5">
                        {e.woNumbers.slice(0, 2).map(wo => (
                          <button key={wo} type="button" onClick={ev => { ev.stopPropagation(); onWoDetail(wo); }}
                            className="px-1 py-0.5 rounded bg-violet-50 text-violet-700 border border-violet-200 text-[9px] font-mono font-semibold hover:bg-violet-100">
                            {wo}
                          </button>
                        ))}
                        {e.woNumbers.length > 2 && <span className="text-[9px] text-slate-400">+{e.woNumbers.length - 2}</span>}
                      </div>
                    </Td>
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={snapMap ? 14 : 13} className="px-5 py-4 bg-slate-50 border-t border-b border-slate-200">
                        <BilanzRechnung e={e} snapEntry={snapEntry ?? null} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > 40 && (
        <div className="px-4 py-2 border-t border-slate-100 text-center">
          {showAll
            ? <button type="button" className="text-xs text-slate-500 hover:text-slate-800 font-medium" onClick={() => setShowAll(false)}>▲ Weniger</button>
            : <button type="button" className="text-xs text-slate-500 hover:text-slate-800 font-medium" onClick={() => setShowAll(true)}>▼ Alle {filtered.length} anzeigen</button>
          }
        </div>
      )}
    </div>
  );
}

// ─── Snapshot Panel ───────────────────────────────────────────────────────────

function SnapshotPanel({ snapshots, currentWeek, onCompare, compareId, onDelete, onSave }: {
  snapshots: WmsSnapshot[];
  currentWeek: string;
  onCompare: (id: string | null) => void;
  compareId: string | null;
  onDelete: (id: string) => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <button type="button"
        className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-100 hover:bg-slate-200 transition-colors"
        onClick={() => setOpen(o => !o)}>
        <div className="flex items-center gap-2">
          <span>💾</span>
          <span className="font-semibold text-sm text-slate-700">Snapshots & Verlauf</span>
          {snapshots.length > 0 && (
            <span className="text-[10px] font-mono bg-slate-300 text-slate-700 px-1.5 py-0.5 rounded-full">{snapshots.length}</span>
          )}
          {compareId && <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Vergleich aktiv</span>}
        </div>
        <span className="text-xs text-slate-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="bg-white p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button"
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold"
              onClick={onSave}>
              💾 Aktuellen Stand speichern ({currentWeek})
            </button>
            {compareId && (
              <button type="button" onClick={() => onCompare(null)}
                className="px-3 py-1.5 rounded-lg bg-amber-100 text-amber-700 border border-amber-300 text-xs font-semibold hover:bg-amber-200">
                ✕ Vergleich beenden
              </button>
            )}
            <span className="text-[10px] text-slate-400">Bis zu {MAX_SNAPSHOTS} Snapshots · wird im Browser gespeichert</span>
          </div>
          {snapshots.length === 0 ? (
            <div className="text-xs text-slate-400 text-center py-4">Noch keine Snapshots. Stand speichern um Verläufe zu vergleichen.</div>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {snapshots.map(snap => {
                const isComparing = compareId === snap.id;
                const defCount = snap.bilanz.filter(e => e.gap < -10).length;
                const surpCount = snap.bilanz.filter(e => e.gap > 100).length;
                return (
                  <div key={snap.id} className={`flex items-center gap-2 p-2 rounded-lg border text-xs ${isComparing ? "border-amber-400 bg-amber-50" : "border-slate-200 bg-slate-50 hover:bg-slate-100"}`}>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-slate-700 truncate">{snap.label}</div>
                      <div className="flex gap-2 text-[10px] text-slate-400 mt-0.5 flex-wrap">
                        <span>{new Date(snap.timestamp).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                        <span className="font-mono">{snap.bilanz.length} SKUs</span>
                        {defCount > 0 && <span className="text-rose-500 font-semibold">{defCount} Fehlbestände</span>}
                        {surpCount > 0 && <span className="text-emerald-600 font-semibold">{surpCount} Überschüsse</span>}
                      </div>
                    </div>
                    <button type="button"
                      className={`px-2 py-1 rounded text-[10px] font-semibold shrink-0 ${isComparing ? "bg-amber-500 text-white" : "bg-slate-200 text-slate-600 hover:bg-amber-100 hover:text-amber-700"}`}
                      onClick={() => onCompare(isComparing ? null : snap.id)}>
                      {isComparing ? "✓ Aktiv" : "Vergleichen"}
                    </button>
                    <button type="button" className="text-slate-300 hover:text-rose-500 text-xs px-1 shrink-0"
                      onClick={() => onDelete(snap.id)}>✕</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Station: Stored (Staging / Debox / Post-Blast / Plating) ─────────────────

function StoredAggTable({ rows, stationKey, skuMap, lotMap, search, onTrace, onDetail, itemToWoMap, onWoDetail, skuInfoIndex }: {
  rows: AggStoredRow[]; stationKey: StationKey; skuMap: SkuStationMap; lotMap: LotStationMap; search: string; onTrace: (sku: string) => void; onDetail: (sku: string) => void;
  itemToWoMap?: Map<string, Set<string>>; onWoDetail?: (wo: string) => void; skuInfoIndex: Map<string, WmsSkuInfo>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [groupMode, setGroupMode] = useState<"location" | "sku">("location");
  const needle = search.trim().toUpperCase();

  // Merge rows by SKU when groupMode === "sku"
  const displayRows = useMemo<AggStoredRow[]>(() => {
    if (groupMode === "location") return rows;
    const map = new Map<string, AggStoredRow>();
    for (const r of rows) {
      let agg = map.get(r.sku);
      if (!agg) {
        agg = { key: r.sku, sku: r.sku, location: "", totalQty: 0, lots: [], hus: [], statuses: [], firstFifo: null, firstExpiry: null, lastChange: null, rawRows: [] };
        map.set(r.sku, agg);
      }
      agg.totalQty   += r.totalQty;
      agg.firstFifo   = minDate(agg.firstFifo,  r.firstFifo);
      agg.firstExpiry = minDate(agg.firstExpiry, r.firstExpiry);
      agg.lastChange  = maxDate(agg.lastChange,  r.lastChange);
      if (r.location) agg.location = agg.location ? `${agg.location}, ${r.location}` : r.location;
      for (const l of r.lots)     if (!agg.lots.includes(l))     agg.lots.push(l);
      for (const h of r.hus)      if (!agg.hus.includes(h))      agg.hus.push(h);
      for (const s of r.statuses) if (!agg.statuses.includes(s)) agg.statuses.push(s);
      agg.rawRows.push(...r.rawRows);
    }
    return [...map.values()].sort((a, b) => b.totalQty - a.totalQty);
  }, [rows, groupMode]);

  const filtered = needle
    ? displayRows.filter(r =>
        r.sku.includes(needle) ||
        r.location.toUpperCase().includes(needle) ||
        r.lots.some(l => l.toUpperCase().includes(needle))
      )
    : displayRows;

  const shown = expanded ? filtered : filtered.slice(0, 20);
  const toggleRow = (key: string) =>
    setOpenRows(prev => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      return s;
    });

  if (rows.length === 0) return <div className="px-4 py-5 text-slate-400 text-sm text-center">Keine Daten für diese KW</div>;

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border-b border-slate-100">
        <span className="text-[10px] font-semibold text-slate-500">Ansicht:</span>
        <button type="button" onClick={() => setGroupMode("location")}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${groupMode === "location" ? "bg-slate-700 text-white" : "text-slate-500 hover:bg-slate-200"}`}>
          Nach Stellplatz
        </button>
        <button type="button" onClick={() => setGroupMode("sku")}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${groupMode === "sku" ? "bg-slate-700 text-white" : "text-slate-500 hover:bg-slate-200"}`}>
          Nach SKU (zusammengefasst)
        </button>
        {groupMode === "sku" && (
          <span className="text-[10px] text-slate-400 ml-1">{displayRows.length} SKUs über alle Stellplätze</span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="border-b border-slate-200">
            <tr>
              <Th></Th>
              <Th>SKU</Th>
              <Th>{groupMode === "sku" ? "Stellplätze" : "Ort / Location"}</Th>
              <Th right>Menge</Th>
              <Th>Lose</Th>
              <Th>HUs</Th>
              <Th>Status</Th>
              <Th>FIFO</Th>
              <Th>MHD</Th>
              <Th>Letzte Änd.</Th>
              <Th>Los auch in…</Th>
              <Th>Stationen</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(row => {
              const isOpen  = openRows.has(row.key);
              const isMatch = needle && (row.sku.includes(needle) || row.location.toUpperCase().includes(needle) || row.lots.some(l => l.toUpperCase().includes(needle)));
              return (
                <React.Fragment key={row.key}>
                  <tr className={`hover:bg-slate-50/60 ${isMatch ? "bg-amber-50/60 ring-1 ring-amber-300 ring-inset" : ""}`}>
                    <Td>
                      <button type="button" onClick={() => toggleRow(row.key)} className="text-slate-400 hover:text-slate-700 w-4 text-center font-mono text-[11px]">
                        {isOpen ? "▼" : "▶"}
                      </button>
                    </Td>
                    <Td mono cls="font-semibold text-slate-800">
                      <span className="hover:underline cursor-pointer" title="Details anzeigen" onClick={() => onDetail(row.sku)}>
                        <SkuLabel sku={row.sku} skuInfoIndex={skuInfoIndex} />
                      </span>
                      {itemToWoMap && onWoDetail && <WoBadge itemNumber={row.sku} itemToWoMap={itemToWoMap} onWoDetail={onWoDetail} />}
                      <StationBadges sku={row.sku} stationMap={skuMap} currentStation={stationKey} onTrace={onTrace} />
                    </Td>
                    <Td mono cls="text-slate-600 font-medium">{row.location || "–"}</Td>
                    <Td right mono cls={`font-bold ${row.rawRows.some(r => (r.actualQty ?? 0) < 0) ? "text-rose-600" : "text-slate-800"}`}>
                      {fmtQty(row.totalQty)}
                      {row.rawRows.some(r => (r.actualQty ?? 0) < 0) && <span className="ml-1 text-[9px] bg-rose-100 text-rose-600 border border-rose-200 px-1 rounded">neg</span>}
                    </Td>
                    <Td cls="text-slate-500 text-[10px] max-w-[120px] truncate" title={row.lots.join(", ")}>
                      {row.lots.length > 0
                        ? row.lots.slice(0, 2).join(", ") + (row.lots.length > 2 ? ` +${row.lots.length - 2}` : "")
                        : "–"}
                    </Td>
                    <Td mono cls="text-slate-500">{row.hus.length}x</Td>
                    <Td><div className="flex flex-wrap gap-0.5">{row.statuses.map(s => <StatusBadge key={s} status={s} />)}</div></Td>
                    <Td>{fmtDate(row.firstFifo)}</Td>
                    <Td cls={mhdClass(row.firstExpiry)}>{fmtDate(row.firstExpiry)}</Td>
                    <Td>{fmtDate(row.lastChange)}</Td>
                    <Td><LotCrossStations lots={row.lots} lotMap={lotMap} currentStation={stationKey} /></Td>
                    <Td>
                      <span className="inline-flex gap-0.5">
                        {STATION_ORDER.filter(s => s !== stationKey && skuMap.get(row.sku)?.has(s)).map(s => (
                          <span key={s} title={STATION_META[s].label} className={`text-[9px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>
                            {STATION_META[s].icon}
                          </span>
                        ))}
                      </span>
                    </Td>
                  </tr>
                  {isOpen && (
                    <RawDetailRow>
                      <div className="overflow-x-auto">
                        <table className="text-[10px] border-collapse w-full">
                          <thead>
                            <tr className="text-slate-400 border-b border-slate-200">
                              {["Los-Nr", "HU", "Menge", "Status", "FIFO", "MHD", "Letzte Änd."].map((h, i) => (
                                <td key={h} className={`pb-1 pr-4 font-semibold ${i === 2 ? "text-right" : ""}`}>{h}</td>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {row.rawRows.map((r, i) => (
                              <tr key={i} className="hover:bg-white">
                                <td className="pr-4 font-mono py-0.5">{r.lotNumber || "–"}</td>
                                <td className="pr-4 font-mono">{r.huId || "–"}</td>
                                <td className="pr-4 text-right font-mono font-semibold">{fmtQty(r.actualQty)}</td>
                                <td className="pr-4">{r.status || "–"}</td>
                                <td className="pr-4">{fmtDate(r.fifoDate)}</td>
                                <td className={`pr-4 ${mhdClass(r.expirationDate)}`}>{fmtDate(r.expirationDate)}</td>
                                <td>{fmtDate(r.dbChangeCommitTime)}</td>
                              </tr>
                            ))}
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

// ─── Station: Sleeving ────────────────────────────────────────────────────────

function SleevingAggTable({ rows, skuMap, search, onTrace, onDetail, skuInfoIndex, itemToWoMap, onWoDetail }: {
  rows: AggSleevingRow[]; skuMap: SkuStationMap; search: string; onTrace: (sku: string) => void; onDetail: (sku: string) => void; skuInfoIndex: Map<string, WmsSkuInfo>;
  itemToWoMap?: Map<string, Set<string>>; onWoDetail?: (wo: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const needle = search.trim().toUpperCase();

  const filtered = needle
    ? rows.filter(r =>
        r.sku.includes(needle) ||
        r.description.toUpperCase().includes(needle) ||
        r.employees.some(e => e.toUpperCase().includes(needle))
      )
    : rows;

  const shown = expanded ? filtered : filtered.slice(0, 20);
  const toggleRow = (sku: string) =>
    setOpenRows(prev => {
      const s = new Set(prev);
      if (s.has(sku)) s.delete(sku);
      else s.add(sku);
      return s;
    });

  if (rows.length === 0) return <div className="px-4 py-5 text-slate-400 text-sm text-center">Keine Sleeving-Daten für diese KW</div>;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead className="border-b border-slate-200">
            <tr>
              <Th></Th>
              <Th>SKU</Th>
              <Th>Bezeichnung</Th>
              <Th right>Eingang ↓</Th>
              <Th right>Ausgang ↑</Th>
              <Th right>Net</Th>
              <Th right>Lost</Th>
              <Th right>Hold</Th>
              <Th right>Transakt.</Th>
              <Th>Mitarbeiter</Th>
              <Th>Letzte Änd.</Th>
              <Th>Stationen</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map(row => {
              const isOpen  = openRows.has(row.sku);
              const isMatch = needle && row.sku.includes(needle);
              return (
                <React.Fragment key={row.sku}>
                  <tr className={`hover:bg-sky-50/30 ${isMatch ? "bg-amber-50/60 ring-1 ring-amber-300 ring-inset" : ""}`}>
                    <Td>
                      <button type="button" onClick={() => toggleRow(row.sku)} className="text-slate-400 hover:text-slate-700 w-4 text-center font-mono text-[11px]">
                        {isOpen ? "▼" : "▶"}
                      </button>
                    </Td>
                    <Td mono cls="font-semibold text-slate-800">
                      <span className="hover:underline cursor-pointer" title="Details anzeigen" onClick={() => onDetail(row.sku)}>
                        <SkuLabel sku={row.sku} skuInfoIndex={skuInfoIndex} />
                      </span>
                      <StationBadges sku={row.sku} stationMap={skuMap} currentStation="sleeving" onTrace={onTrace} />
                      {itemToWoMap && onWoDetail && <WoBadge itemNumber={row.sku} itemToWoMap={itemToWoMap} onWoDetail={onWoDetail} />}
                    </Td>
                    <Td cls="max-w-[150px] truncate text-slate-600" title={row.description}>{row.description}</Td>
                    <Td right mono cls="text-emerald-700 font-semibold">{fmtQty(row.eingang)}</Td>
                    <Td right mono cls="text-orange-600 font-semibold">{fmtQty(row.ausgang)}</Td>
                    <Td right mono cls={row.net >= 0 ? "text-emerald-700 font-bold" : "text-rose-700 font-bold"}>{fmtQty(row.net)}</Td>
                    <Td right mono cls={row.lost > 0 ? "text-rose-600 font-semibold" : "text-slate-300"}>{row.lost > 0 ? fmtQty(row.lost) : "–"}</Td>
                    <Td right mono cls={row.hold > 0 ? "text-amber-600 font-semibold" : "text-slate-300"}>{row.hold > 0 ? fmtQty(row.hold) : "–"}</Td>
                    <Td right mono cls="text-slate-500">{row.transCount}</Td>
                    <Td cls="text-slate-500 text-[10px]">
                      {row.employees.length > 0
                        ? row.employees.slice(0, 3).join(", ") + (row.employees.length > 3 ? ` +${row.employees.length - 3}` : "")
                        : "–"}
                    </Td>
                    <Td>{fmtDate(row.lastChange)}</Td>
                    <Td>
                      <span className="inline-flex gap-0.5">
                        {STATION_ORDER.filter(s => s !== "sleeving" && skuMap.get(row.sku)?.has(s)).map(s => (
                          <span key={s} title={STATION_META[s].label} className={`text-[9px] px-1 py-0.5 rounded ${STATION_META[s].bgColor} ${STATION_META[s].textColor} border ${STATION_META[s].borderColor}`}>
                            {STATION_META[s].icon}
                          </span>
                        ))}
                      </span>
                    </Td>
                  </tr>
                  {isOpen && (
                    <RawDetailRow>
                      <div className="overflow-x-auto">
                        <table className="text-[10px] border-collapse w-full">
                          <thead>
                            <tr className="text-slate-400 border-b border-slate-200">
                              {["Signal", "Von", "Nach", "Menge", "Art", "Start", "Ende", "MA"].map((h, i) => (
                                <td key={h} className={`pb-1 pr-4 font-semibold ${i === 3 ? "text-right" : ""}`}>{h}</td>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {row.rawRows.map((r, i) => {
                              const sig = sleevingSignal(r);
                              const sigCls =
                                sig === "eingang" ? "text-emerald-600 font-semibold" :
                                sig === "ausgang" ? "text-orange-600 font-semibold" :
                                sig === "lost"    ? "text-rose-600 font-semibold"   :
                                sig === "hold"    ? "text-amber-600 font-semibold"  :
                                sig === "cycle"   ? "text-purple-600 font-semibold" :
                                "text-slate-400";
                              return (
                                <tr key={i} className="hover:bg-white">
                                  <td className={`pr-4 py-0.5 ${sigCls}`}>{sig}</td>
                                  <td className="pr-4 font-mono">{r.von  || "–"}</td>
                                  <td className="pr-4 font-mono">{r.nach || "–"}</td>
                                  <td className="pr-4 text-right font-mono font-semibold">{fmtQty(r.tranQty)}</td>
                                  <td className="pr-4">{r.tranType || "–"}</td>
                                  <td className="pr-4">{fmtDate(r.startTranDate)}</td>
                                  <td className="pr-4">{fmtDate(r.endTranDate)}</td>
                                  <td className="font-mono">{r.employeeId || "–"}</td>
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

// ─── Main Component ───────────────────────────────────────────────────────────

export function WmsKwOverviewView({ data }: { data: DataBundle }): JSX.Element {
  const allWmsWeeks = useMemo(() => generateWmsWeeks(2026, 1), []);

  const [selectedWeek, setSelectedWeek] = useState<string>(() => allWmsWeeks[allWmsWeeks.length - 1] ?? "");
  const [allData,      setAllData]      = useState<AllData | null>(null);
  const [loadState,    setLoadState]    = useState<LoadState>("idle");
  const [loadError,    setLoadError]    = useState<string | null>(null);
  const [generatedAt,  setGeneratedAt]  = useState<string | null>(null);
  const [rangeStart,   setRangeStart]   = useState<string | null>(null);
  const [rangeEnd,     setRangeEnd]     = useState<string | null>(null);
  const [search,       setSearch]       = useState("");
  const [detailSku,    setDetailSku]    = useState<string | null>(null);
  const [detailWo,     setDetailWo]     = useState<string | null>(null);
  const [woViewMode,   setWoViewMode]   = useState<"list" | "meal">("list");
  type CmdTab = "command" | "bilanz" | "inbound" | "workorders" | "staging" | "debox" | "postblast" | "plating" | "sleeving";
  const [activeTab, setActiveTab] = useState<CmdTab>("command");
  const [liveMode,     setLiveMode]     = useState(false);
  const [liveCountdown, setLiveCountdown] = useState(30);
  const [snapshots,    setSnapshots]    = useState<WmsSnapshot[]>(() => loadSnapshots());
  const [compareSnapId, setCompareSnapId] = useState<string | null>(null);
  const liveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveTickRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const selectedWeekRef = useRef(selectedWeek);
  const doLoadRef       = useRef<((week: string) => Promise<void>) | null>(null);

  const selectedWeekNum = useMemo(() => weekNumFromHfWeek(selectedWeek), [selectedWeek]);
  const skuInfoIndex = useMemo(() => buildSkuInfoIndex(data, selectedWeek), [data, selectedWeek]);

  const doLoad = async (week: string) => {
    setLoadState("loading");
    setLoadError(null);
    setAllData(null);
    try {
      const p   = new URLSearchParams({ whId: "VF", week, limit: "50000", ts: String(Date.now()) });
      const pwo = new URLSearchParams({ whId: "VF", week, limit: "50000", ts: String(Date.now()) });
      const [plR, stgR, debR, pbR, slR, inR, woR, wodR] = await Promise.all([
        fetch(`/api/wms-plating?${p}`,    { cache: "no-store" }),
        fetch(`/api/wms-staging?${p}`,    { cache: "no-store" }),
        fetch(`/api/wms-debox?${p}`,      { cache: "no-store" }),
        fetch(`/api/wms-postblast?${p}`,  { cache: "no-store" }),
        fetch(`/api/wms-sleeving?${p}`,   { cache: "no-store" }),
        fetch(`/api/wms-inbound?${p}`,    { cache: "no-store" }),
        fetch(`/api/wms-workorders?${pwo}`,{ cache: "no-store" }),
        fetch(`/api/wms-wo-detail?${p}`,  { cache: "no-store" }),
      ]);
      const ct = plR.headers.get("content-type") ?? "";
      if (!ct.includes("application/json") && !ct.includes("text/json")) {
        throw new Error(`WMS-Server nicht erreichbar (HTTP ${plR.status}). Lokalen Server starten: npm run wms:server`);
      }
      const [pl, stg, deb, pb, sl, inb, wo, wod] = await Promise.all([
        plR.json()  as Promise<StoredPayload>,
        stgR.json() as Promise<StoredPayload>,
        debR.json() as Promise<StoredPayload>,
        pbR.json()  as Promise<StoredPayload>,
        slR.json()  as Promise<SleevingPayload>,
        inR.json()  as Promise<InboundPayload>,
        woR.ok ? woR.json() as Promise<WorkordersPayload> : Promise.resolve({ ok: true, rows: [] } as WorkordersPayload),
        wodR.ok ? wodR.json() as Promise<WoDetailPayload> : Promise.resolve({ ok: true, rows: [] } as WoDetailPayload),
      ]);
      for (const [label, pay] of [["Plating", pl], ["Staging", stg], ["Debox", deb], ["Post-Blast", pb], ["Sleeving", sl], ["Inbound", inb]] as [string, BasePayload][]) {
        if (!pay.ok) throw new Error(`${label}: ${pay.error ?? "Unbekannter Fehler"}`);
      }
      setAllData({ plating: pl, staging: stg, debox: deb, postblast: pb, sleeving: sl, inbound: inb, workorders: wo, woDetail: wod });
      setGeneratedAt(pl.generatedAt ?? sl.generatedAt ?? inb.generatedAt ?? null);
      setRangeStart(pl.rangeStart ?? inb.rangeStart ?? null);
      setRangeEnd(pl.rangeEnd ?? inb.rangeEnd ?? null);
      setLoadState("ready");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setLoadState("error");
    }
  };

  doLoadRef.current = doLoad;

  useEffect(() => { selectedWeekRef.current = selectedWeek; }, [selectedWeek]);

  useEffect(() => {
    if (selectedWeek) void doLoad(selectedWeek);
  }, [selectedWeek]);

  useEffect(() => {
    if (!liveMode) {
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);
      if (liveTickRef.current)     clearInterval(liveTickRef.current);
      liveIntervalRef.current = null;
      liveTickRef.current = null;
      setLiveCountdown(30);
      return;
    }
    setLiveCountdown(30);
    liveIntervalRef.current = setInterval(() => {
      if (doLoadRef.current) void doLoadRef.current(selectedWeekRef.current);
      setLiveCountdown(30);
    }, 30_000);
    liveTickRef.current = setInterval(() => {
      setLiveCountdown(c => Math.max(0, c - 1));
    }, 1_000);
    return () => {
      if (liveIntervalRef.current) clearInterval(liveIntervalRef.current);
      if (liveTickRef.current)     clearInterval(liveTickRef.current);
    };
  }, [liveMode]);

  const wmsWeekNum = useMemo(
    () => resolveOperationalWmsWeekNum(selectedWeekNum, [
      allData?.sleeving.rows ?? [],
      allData?.inbound.rows ?? [],
    ]),
    [allData, selectedWeekNum],
  );

  // ── Filtered raw rows per station ─────────────────────────────────────────
  const rawPlating   = useMemo(() =>  allData?.plating.rows    ?? [], [allData]);
  const rawStaging   = useMemo(() =>  allData?.staging.rows    ?? [], [allData]);
  const rawDebox     = useMemo(() =>  allData?.debox.rows      ?? [], [allData]);
  const rawPostblast = useMemo(() =>  allData?.postblast.rows  ?? [], [allData]);
  const rawSleeving  = useMemo(() => (allData?.sleeving.rows   ?? []).filter(r => wmsWeekNum == null || r.kw === wmsWeekNum), [allData, wmsWeekNum]);
  const rawInbound   = useMemo(() => (allData?.inbound.rows    ?? []).filter(r => wmsWeekNum == null || r.kw === wmsWeekNum), [allData, wmsWeekNum]);
  const rawWorkorders = useMemo(
    () => (allData?.workorders.rows ?? []).filter((row) => woMatchesSelectedWeek(row.week, selectedWeek)),
    [allData, selectedWeek],
  );

  // ── Aggregated rows ───────────────────────────────────────────────────────
  const aggWorkorders = useMemo(() => aggregateWorkorders(rawWorkorders), [rawWorkorders]);
  const aggInbound    = useMemo(() => aggregateInbound(rawInbound),       [rawInbound]);
  const aggStaging    = useMemo(() => aggregateStored(rawStaging),        [rawStaging]);
  const aggDebox      = useMemo(() => aggregateStored(rawDebox),          [rawDebox]);
  const aggPostblast  = useMemo(() => aggregateStored(rawPostblast),      [rawPostblast]);
  const aggSleeving   = useMemo(() => aggregateSleeving(rawSleeving),     [rawSleeving]);
  const aggPlating    = useMemo(() => aggregateStored(rawPlating),        [rawPlating]);

  // ── Cross-station indices ─────────────────────────────────────────────────
  const skuMap = useMemo(
    () => allData ? buildSkuStationMap(allData, selectedWeek, wmsWeekNum) : new Map<string, Set<StationKey>>(),
    [allData, selectedWeek, wmsWeekNum],
  );
  const lotMap = useMemo(
    () => allData ? buildLotStationMap(allData) : new Map<string, Set<StationKey>>(),
    [allData],
  );

  // ── Funnel ────────────────────────────────────────────────────────────────
  const funnel = useMemo(
    () => allData ? buildFunnel(allData, skuMap, selectedWeek, wmsWeekNum) : [],
    [allData, skuMap, selectedWeek, wmsWeekNum],
  );

  const filteredWoDetails = useMemo(() => {
    const woNumbers = new Set(rawWorkorders.map((row) => row.woNumber).filter(Boolean));
    return (allData?.woDetail.rows ?? []).filter((row) => woNumbers.has(row.woNumber));
  }, [allData, rawWorkorders]);

  // ── WO Transaction Index ──────────────────────────────────────────────────
  const woTransactionMap = useMemo(() => {
    const map = new Map<string, WoTransactionRow[]>();
    for (const r of filteredWoDetails) {
      if (!r.woNumber) continue;
      if (!map.has(r.woNumber)) map.set(r.woNumber, []);
      map.get(r.woNumber)!.push(r);
    }
    return map;
  }, [filteredWoDetails]);

  // WO → Items index (for badges in station tables)
  const itemToWoMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (itemNumber: string, woNumber: string) => {
      const itemKey = itemNumber.toUpperCase();
      if (!itemKey || !woNumber) return;
      if (!map.has(itemKey)) map.set(itemKey, new Set());
      map.get(itemKey)!.add(woNumber);
    };
    for (const r of rawWorkorders) {
      add(r.submealItemNumber, r.woNumber);
      add(r.mealItemNumber, r.woNumber);
    }
    for (const r of filteredWoDetails) {
      if (!r.itemNumber || !r.woNumber) continue;
      add(r.itemNumber, r.woNumber);
    }
    return map;
  }, [filteredWoDetails, rawWorkorders]);

  const bilanz = useMemo(
    () => allData ? buildSkuBilanz(rawWorkorders, aggInbound, aggStaging, aggDebox, aggPostblast, aggSleeving, aggPlating) : [],
    [allData, rawWorkorders, aggInbound, aggStaging, aggDebox, aggPostblast, aggSleeving, aggPlating],
  );

  const compareSnap = useMemo(
    () => snapshots.find(s => s.id === compareSnapId) ?? null,
    [snapshots, compareSnapId],
  );

  // ── Trace / Detail ───────────────────────────────────────────────────────
  const handleTrace  = (sku: string) => {
    if (/^\d{1,2}-\d+$/.test(sku.trim()) && woTransactionMap.has(sku.trim())) {
      setDetailWo(sku.trim());
    } else {
      setSearch(sku);
    }
  };
  const handleDetail = (sku: string) => setDetailSku(sku);
  const handleWoDetail = (wo: string) => setDetailWo(wo);
  const handleSaveSnapshot = () => { persistSnapshot(selectedWeek, bilanz); setSnapshots(loadSnapshots()); };
  const handleDeleteSnapshot = (id: string) => { removeSnapshot(id); setSnapshots(loadSnapshots()); };
  const needle   = search.trim().toUpperCase();
  const isTrace  = needle.length > 0;

  const allStored = useMemo(
    () => [...aggStaging, ...aggDebox, ...aggPostblast, ...aggPlating],
    [aggStaging, aggDebox, aggPostblast, aggPlating],
  );

  // Filtered counts for headers
  const filtCounts = useMemo(() => ({
    workorders: isTrace ? aggWorkorders.filter(m => m.mealSku.includes(needle) || m.submeals.some(s => s.submealItemNumber.toUpperCase().includes(needle))).length : aggWorkorders.length,
    inbound:    isTrace ? aggInbound.filter(r => r.sku.includes(needle) || r.rawRows.some(raw => [raw.poNumber, raw.lotNumber].some(f => String(f ?? "").toUpperCase().includes(needle)))).length : aggInbound.length,
    staging:    isTrace ? aggStaging.filter(r => r.sku.includes(needle)   || r.location.toUpperCase().includes(needle) || r.lots.some(l => l.toUpperCase().includes(needle))).length : aggStaging.length,
    debox:      isTrace ? aggDebox.filter(r => r.sku.includes(needle)     || r.location.toUpperCase().includes(needle) || r.lots.some(l => l.toUpperCase().includes(needle))).length : aggDebox.length,
    postblast:  isTrace ? aggPostblast.filter(r => r.sku.includes(needle) || r.location.toUpperCase().includes(needle) || r.lots.some(l => l.toUpperCase().includes(needle))).length : aggPostblast.length,
    sleeving:   isTrace ? aggSleeving.filter(r => r.sku.includes(needle)).length : aggSleeving.length,
    plating:    isTrace ? aggPlating.filter(r => r.sku.includes(needle)   || r.location.toUpperCase().includes(needle) || r.lots.some(l => l.toUpperCase().includes(needle))).length : aggPlating.length,
  }), [isTrace, needle, aggWorkorders, aggInbound, aggStaging, aggDebox, aggPostblast, aggSleeving, aggPlating]);

  const totalCounts: Record<StationKey, number> = {
    workorders: aggWorkorders.length, inbound: aggInbound.length,
    staging: aggStaging.length, debox: aggDebox.length, postblast: aggPostblast.length,
    sleeving: aggSleeving.length, plating: aggPlating.length,
  };

  const TAB_DEFS: { key: CmdTab; label: string; icon: string; count?: number; color?: string }[] = [
    { key: "command", label: "Leitwarte", icon: "🎯" },
    { key: "bilanz", label: "Bilanz", icon: "📊" },
    { key: "inbound", label: "Inbound", icon: "📦", count: totalCounts.inbound, color: "emerald" },
    { key: "workorders", label: "WO", icon: "📋", count: totalCounts.workorders, color: "violet" },
    { key: "staging", label: "Staging", icon: "🗄️", count: totalCounts.staging, color: "amber" },
    { key: "debox", label: "Debox", icon: "📂", count: totalCounts.debox, color: "orange" },
    { key: "postblast", label: "Post-Blast", icon: "❄️", count: totalCounts.postblast, color: "rose" },
    { key: "plating", label: "Plating", icon: "🍽️", count: totalCounts.plating, color: "blue" },
    { key: "sleeving", label: "Sleeving", icon: "🔄", count: totalCounts.sleeving, color: "sky" },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">

      {/* ══ COMMAND BAR (sticky dark header) ══════════════════════════════ */}
      <div className="sticky top-0 z-40 bg-slate-900 text-white shadow-xl px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-lg">🎯</span>
            <span className="font-bold text-sm tracking-wide">WMS KOMMANDOZENTRALE</span>
            <span className="text-[10px] text-slate-400 font-mono">VF</span>
          </div>

          <select
            className="rounded bg-slate-800 border border-slate-600 px-2 py-1 text-xs font-mono text-slate-200"
            value={selectedWeek}
            onChange={e => setSelectedWeek(e.target.value)}
          >
            {allWmsWeeks.map(w => <option key={w} value={w}>{w}</option>)}
          </select>

          <button
            type="button"
            className={`rounded px-2.5 py-1 text-[11px] font-bold transition-colors ${liveMode ? "bg-emerald-500 text-white animate-pulse" : "bg-slate-700 text-slate-300 hover:bg-slate-600"}`}
            onClick={() => setLiveMode(m => !m)}
          >
            {liveMode ? `⏺ LIVE ${liveCountdown}s` : "◯ Live"}
          </button>

          <button
            type="button"
            className="rounded bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 text-[11px] font-bold disabled:opacity-40"
            onClick={() => void doLoad(selectedWeek)}
            disabled={loadState === "loading" || !selectedWeek}
          >
            {loadState === "loading" ? "Lädt…" : "⟳ Laden"}
          </button>

          {loadState === "ready" && (
            <div className="relative ml-auto">
              <input
                type="search"
                placeholder="⌘K  SKU / Ort / Los / WO…"
                className="rounded bg-slate-800 border border-slate-600 px-3 py-1 text-xs text-slate-200 w-64 placeholder:text-slate-500"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-xs" onClick={() => setSearch("")}>✕</button>}
            </div>
          )}

          {loadState === "ready" && generatedAt && (
            <div className="text-[10px] text-slate-500 font-mono">
              {rangeStart && rangeEnd && <span className="mr-2">{rangeStart}→{rangeEnd}</span>}
              {new Date(generatedAt).toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit" })}
            </div>
          )}
        </div>
      </div>

      {/* ══ ALERT STRIP ════════════════════════════════════════════════════ */}
      {loadState === "ready" && (
        <div className="px-3 pt-2 space-y-1.5">
          <MhdAlertBanner allStored={allStored} />
          <YieldAlertBanner aggSleeving={aggSleeving} bilanz={bilanz} itemToWoMap={itemToWoMap} />
        </div>
      )}

      {/* ══ KPI BAR (always visible when data loaded) ═════════════════════ */}
      {loadState === "ready" && allData && (
        <div className="px-3 pt-2">
          <DashboardKpi
            aggInbound={aggInbound} aggStaging={aggStaging} aggDebox={aggDebox}
            aggPostblast={aggPostblast} aggPlating={aggPlating} aggSleeving={aggSleeving}
            skuMap={skuMap}
          />
        </div>
      )}

      {/* ══ TAB NAVIGATION ═════════════════════════════════════════════════ */}
      {loadState === "ready" && allData && (
        <div className="sticky top-[52px] z-30 bg-white border-b border-slate-200 px-3 pt-2 shadow-sm">
          <div className="flex gap-0.5 overflow-x-auto">
            {TAB_DEFS.map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={`flex items-center gap-1 px-3 py-2 text-[11px] font-semibold rounded-t-lg whitespace-nowrap transition-colors ${
                  activeTab === t.key
                    ? "bg-slate-100 text-slate-900 border border-b-0 border-slate-200"
                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span>{t.icon}</span>
                <span>{t.label}</span>
                {t.count != null && t.count > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-slate-200 text-[9px] font-mono">{t.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ══ CONTENT AREA ═══════════════════════════════════════════════════ */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">

        {/* ── Idle ──── */}
        {loadState === "idle" && (
          <div className="card p-10 text-center text-slate-400">
            <div className="text-3xl mb-3">🎯</div>
            <div className="text-xl font-semibold mb-2">WMS Kommandozentrale</div>
            <div className="text-sm">KW auswählen und auf „Laden" klicken um alle Stationen zu laden.</div>
          </div>
        )}

        {/* ── Loading ──── */}
        {loadState === "loading" && (
          <div className="card p-10 flex items-center justify-center gap-3 text-slate-500">
            <svg className="animate-spin w-6 h-6 text-emerald-600" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <span>Lade alle Stationen für <strong>{selectedWeek}</strong>…</span>
          </div>
        )}

        {loadState === "error" && (
          <div className="card border-rose-300 bg-rose-50 p-4 text-rose-800 text-sm">{loadError}</div>
        )}

        {/* ── Data Tabs ──── */}
        {loadState === "ready" && allData && (
          <>
            {/* Trace Panel (always visible when tracing) */}
            {isTrace && <TracePanel sku={search} funnel={funnel} skuInfoIndex={skuInfoIndex} onClear={() => setSearch("")} />}

            {/* ─── TAB: Leitwarte (Command) ─── */}
            {activeTab === "command" && (
              <div className="space-y-3">
                {/* Gesamtfluss: Aggregierte Mengen pro Station */}
                <div className="card p-4">
                  <div className="text-xs font-bold uppercase text-slate-500 mb-3">Aktiver Mengenstrom (Gesamt)</div>
                  <div className="flex items-center gap-1 overflow-x-auto">
                    {(STATION_ORDER.map(sk => ({ sk, qty: sk === "workorders" ? rawWorkorders.reduce((s, r) => s + (r.quantity ?? 0), 0)
                      : sk === "inbound" ? aggInbound.reduce((s, r) => s + r.totalReceived, 0)
                      : sk === "sleeving" ? aggSleeving.reduce((s, r) => s + r.net, 0)
                      : [...aggStaging, ...aggDebox, ...aggPostblast, ...aggPlating].filter(r => {
                        if (sk === "staging") return aggStaging.includes(r);
                        if (sk === "debox") return aggDebox.includes(r);
                        if (sk === "postblast") return aggPostblast.includes(r);
                        return aggPlating.includes(r);
                      }).reduce((s, r) => s + r.totalQty, 0)
                    }))).map((item, i) => {
                      const m = STATION_META[item.sk];
                      return (
                        <React.Fragment key={item.sk}>
                          {i > 0 && <span className="text-slate-300 text-sm">→</span>}
                          <button type="button" onClick={() => setActiveTab(item.sk as CmdTab)} className={`flex flex-col items-center px-3 py-2 rounded-lg border ${m.borderColor} ${m.bgColor} min-w-[70px] hover:shadow-md transition-shadow cursor-pointer`}>
                            <span>{m.icon}</span>
                            <span className={`text-[9px] font-semibold ${m.textColor}`}>{m.label.split(" ")[0]}</span>
                            <span className="font-mono font-bold text-sm text-slate-800">{fmtQty(item.qty)}</span>
                          </button>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>

                {/* Engpässe & Yield Alerts */}
                {bilanz.length > 0 && (() => {
                  const issues = bilanz.map(e => ({ e, kb: detectKettenbruch(e) })).filter(x => x.kb != null).sort((a, b) => {
                    const sev = { yield_loss: 0, stuck: 1, drop: 2 };
                    return (sev[a.kb!.severity] ?? 9) - (sev[b.kb!.severity] ?? 9);
                  }).slice(0, 8);
                  if (issues.length === 0) return (
                    <div className="card p-4 border-emerald-200 bg-emerald-50 text-emerald-800 text-sm font-semibold text-center">
                      ✓ Keine Engpässe erkannt — alle Stationen laufen
                    </div>
                  );
                  return (
                    <div className="card p-4">
                      <div className="text-xs font-bold uppercase text-slate-500 mb-2">⚡ Engpässe & Risiken ({issues.length})</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {issues.map(({ e, kb }) => (
                          <div key={e.sku} className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer hover:shadow-sm ${kb!.severity === "yield_loss" ? "border-rose-300 bg-rose-50" : kb!.severity === "stuck" ? "border-amber-300 bg-amber-50" : "border-orange-200 bg-orange-50"}`}
                            onClick={() => handleTrace(e.sku)}>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${kb!.severity === "yield_loss" ? "bg-rose-200 text-rose-800" : kb!.severity === "stuck" ? "bg-amber-200 text-amber-800" : "bg-orange-200 text-orange-800"}`}>
                              {kb!.severity === "yield_loss" ? "YIELD" : kb!.severity === "stuck" ? "STUCK" : "DROP"}
                            </span>
                            <span className="font-mono text-xs text-slate-800 font-semibold">{e.sku}</span>
                            <span className="text-[10px] text-slate-600 truncate flex-1">{kb!.label}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* WO Readiness Overview */}
                {aggWorkorders.length > 0 && (
                  <div className="card p-4">
                    <div className="text-xs font-bold uppercase text-slate-500 mb-2">📋 WO-Readiness ({aggWorkorders.length} Meals)</div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                      {aggWorkorders.slice(0, 8).map(meal => {
                        const readiness = woReadiness(meal.submeals, skuMap);
                        return (
                          <div key={meal.mealSku} className="rounded-lg border border-slate-200 px-3 py-2 cursor-pointer hover:bg-slate-50" onClick={() => handleTrace(meal.mealSku)}>
                            <div className="font-mono text-[10px] text-slate-600 truncate">{meal.mealSku}</div>
                            <div className="flex items-center justify-between mt-1">
                              <ReadinessBadge {...readiness} />
                              <span className="text-[10px] font-mono text-slate-500">{fmtQty(meal.totalQty)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* SKU Funnel (cross-station) */}
                {!isTrace && funnel.length > 0 && (
                  <SkuFunnelSection funnel={funnel} skuMap={skuMap} skuInfoIndex={skuInfoIndex} onTrace={handleTrace} />
                )}

                {/* Snapshots */}
                <SnapshotPanel
                  snapshots={snapshots}
                  currentWeek={selectedWeek}
                  onCompare={setCompareSnapId}
                  compareId={compareSnapId}
                  onDelete={handleDeleteSnapshot}
                  onSave={handleSaveSnapshot}
                />
              </div>
            )}

            {/* ─── TAB: Bilanz ─── */}
            {activeTab === "bilanz" && bilanz.length > 0 && (
              <StationsBilanz
                bilanz={bilanz}
                compareSnap={compareSnap}
                week={selectedWeek}
                onTrace={handleTrace}
                onWoDetail={handleWoDetail}
                skuInfoIndex={skuInfoIndex}
              />
            )}

            {/* ─── TAB: Inbound ─── */}
            {activeTab === "inbound" && (
              <SectionCard stationKey="inbound" totalCount={totalCounts.inbound} filteredCount={isTrace ? filtCounts.inbound : undefined}>
                <InboundAggTable rows={aggInbound} skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {/* ─── TAB: Work Orders ─── */}
            {activeTab === "workorders" && (
              <SectionCard stationKey="workorders" totalCount={totalCounts.workorders} filteredCount={isTrace ? filtCounts.workorders : undefined}>
                <div className="flex items-center gap-1 px-3 pt-2 pb-1">
                  <button type="button" onClick={() => setWoViewMode("list")}
                    className={`px-2 py-1 rounded text-[10px] font-semibold cursor-pointer ${woViewMode === "list" ? "bg-violet-100 text-violet-700 border border-violet-300" : "text-slate-500 hover:bg-slate-100"}`}>
                    WO-Liste
                  </button>
                  <button type="button" onClick={() => setWoViewMode("meal")}
                    className={`px-2 py-1 rounded text-[10px] font-semibold cursor-pointer ${woViewMode === "meal" ? "bg-violet-100 text-violet-700 border border-violet-300" : "text-slate-500 hover:bg-slate-100"}`}>
                    Nach Meal
                  </button>
                </div>
                {woViewMode === "list" ? (
                  <WoListTable workorders={rawWorkorders} woTransactionMap={woTransactionMap} search={search} onWoDetail={handleWoDetail} onTrace={handleTrace} />
                ) : (
                  <WorkordersMealTable meals={aggWorkorders} skuMap={skuMap} search={search} weekNum={selectedWeekNum} onTrace={handleTrace} onDetail={handleDetail} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
                )}
              </SectionCard>
            )}

            {/* ─── TAB: Staging ─── */}
            {activeTab === "staging" && (
              <SectionCard stationKey="staging" totalCount={totalCounts.staging} filteredCount={isTrace ? filtCounts.staging : undefined}>
                <StoredAggTable rows={aggStaging} stationKey="staging" skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {/* ─── TAB: Debox ─── */}
            {activeTab === "debox" && (
              <SectionCard stationKey="debox" totalCount={totalCounts.debox} filteredCount={isTrace ? filtCounts.debox : undefined}>
                <StoredAggTable rows={aggDebox} stationKey="debox" skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {/* ─── TAB: Post-Blast ─── */}
            {activeTab === "postblast" && (
              <SectionCard stationKey="postblast" totalCount={totalCounts.postblast} filteredCount={isTrace ? filtCounts.postblast : undefined}>
                <StoredAggTable rows={aggPostblast} stationKey="postblast" skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {/* ─── TAB: Plating ─── */}
            {activeTab === "plating" && (
              <SectionCard stationKey="plating" totalCount={totalCounts.plating} filteredCount={isTrace ? filtCounts.plating : undefined}>
                <StoredAggTable rows={aggPlating} stationKey="plating" skuMap={skuMap} lotMap={lotMap} search={search} onTrace={handleTrace} onDetail={handleDetail} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} skuInfoIndex={skuInfoIndex} />
              </SectionCard>
            )}

            {/* ─── TAB: Sleeving ─── */}
            {activeTab === "sleeving" && (
              <SectionCard stationKey="sleeving" totalCount={totalCounts.sleeving} filteredCount={isTrace ? filtCounts.sleeving : undefined}>
                <SleevingAggTable rows={aggSleeving} skuMap={skuMap} search={search} onTrace={handleTrace} onDetail={handleDetail} skuInfoIndex={skuInfoIndex} itemToWoMap={itemToWoMap} onWoDetail={handleWoDetail} />
              </SectionCard>
            )}
          </>
        )}
      </div>

      {/* ══ OVERLAY PANELS ════════════════════════════════════════════════ */}
      {detailSku && allData && (
        <SkuDetailPanel
          sku={detailSku}
          allData={allData}
          funnel={funnel}
          selectedWeek={selectedWeek}
          weekNum={wmsWeekNum}
          onClose={() => setDetailSku(null)}
          onTrace={handleTrace}
          skuInfoIndex={skuInfoIndex}
        />
      )}

      {detailWo && allData && (
        <WoDetailPanel
          woNumber={detailWo}
          transactions={woTransactionMap.get(detailWo) ?? []}
          workorders={rawWorkorders}
          detailMeta={allData.woDetail}
          aggSleeving={aggSleeving}
          onClose={() => setDetailWo(null)}
          onTrace={(sku) => { setDetailWo(null); handleTrace(sku); }}
        />
      )}
    </div>
  );
}
