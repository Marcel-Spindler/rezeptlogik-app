// WMS Übersicht – geteilte Roh-/Aggregat-/Payload-Typen, Stations-Konstanten.

// ─── Raw Row Types ────────────────────────────────────────────────────────────

export type StoredRow = {
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

export type SleevingRow = {
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

export type InboundRow = {
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

export type WoTransactionRow = {
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

export type WorkorderRow = {
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

export type AggInboundRow = {
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

export type AggStoredRow = {
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

export type AggSleevingRow = {
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

export type AggWorkorderMeal = {
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

export type BasePayload = {
  ok: boolean;
  rangeStart?: string;
  rangeEnd?: string;
  generatedAt?: string;
  error?: string;
};

export type StoredPayload    = BasePayload & { rows: StoredRow[] };
export type SleevingPayload  = BasePayload & { rows: SleevingRow[] };
export type InboundPayload   = BasePayload & { rows: InboundRow[] };
export type WorkordersPayload = { ok: boolean; rows: WorkorderRow[]; error?: string };
export type WoDetailPayload   = { ok: boolean; rows: WoTransactionRow[]; error?: string; source?: string; cachedAt?: string; week?: string; wmsWeek?: string; controlPattern?: string };

export type AllData = {
  plating:    StoredPayload;
  staging:    StoredPayload;
  debox:      StoredPayload;
  postblast:  StoredPayload;
  sleeving:   SleevingPayload;
  inbound:    InboundPayload;
  workorders: WorkordersPayload;
  woDetail:   WoDetailPayload;
};

export type StationKey = "workorders" | "inbound" | "staging" | "debox" | "postblast" | "sleeving" | "plating";
export type LoadState  = "idle" | "loading" | "ready" | "error";

// ─── Constants ────────────────────────────────────────────────────────────────

export const STATION_ORDER: StationKey[] = [
  "inbound", "workorders", "staging", "debox", "postblast", "plating", "sleeving",
];

export const STATION_META: Record<StationKey, { label: string; bgColor: string; textColor: string; borderColor: string; icon: string }> = {
  workorders: { label: "Work Orders",               bgColor: "bg-violet-50",  textColor: "text-violet-700",  borderColor: "border-violet-200",  icon: "📋" },
  inbound:    { label: "Inbound (Wareneingang)",    bgColor: "bg-emerald-50", textColor: "text-emerald-700", borderColor: "border-emerald-200", icon: "📦" },
  staging:    { label: "Staging",                   bgColor: "bg-amber-50",   textColor: "text-amber-700",   borderColor: "border-amber-200",   icon: "🗄️" },
  debox:      { label: "Debox",                     bgColor: "bg-orange-50",  textColor: "text-orange-700",  borderColor: "border-orange-200",  icon: "📂" },
  postblast:  { label: "Post-Blast",                bgColor: "bg-rose-50",    textColor: "text-rose-700",    borderColor: "border-rose-200",    icon: "❄️" },
  sleeving:   { label: "Sleeving",                  bgColor: "bg-sky-50",     textColor: "text-sky-700",     borderColor: "border-sky-200",     icon: "🔄" },
  plating:    { label: "Plating (Linie & Holding)", bgColor: "bg-blue-50",    textColor: "text-blue-700",    borderColor: "border-blue-200",    icon: "🍽️" },
};
