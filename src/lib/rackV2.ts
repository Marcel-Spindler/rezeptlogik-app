import {
  deriveEntryKind,
  validateRackPlan,
  type RackBoxSnapshot,
  type RackEntry,
  type RackMarket,
  type RackValidationIssue,
} from "./rack";

export type RackV2MarketId = "DE" | "DKSE" | "BENL";

export const RACK_V2_MARKET_TO_DATA: Record<RackV2MarketId, RackMarket> = {
  DE: "de",
  DKSE: "nordics",
  BENL: "nordics",
};

export const RACK_V2_MARKET_LABEL: Record<RackV2MarketId, string> = {
  DE: "Deutschland",
  DKSE: "Daenemark / Schweden",
  BENL: "Benelux",
};

export const RACK_V2_MARKET_TONE: Record<RackV2MarketId, string> = {
  DE: "bg-emerald-50 text-emerald-900 ring-emerald-200",
  DKSE: "bg-sky-50 text-sky-900 ring-sky-200",
  BENL: "bg-orange-50 text-orange-900 ring-orange-200",
};

export type RackV2Line = {
  id: string;
  code: string;
  defaultMarket: RackV2MarketId;
};

export const RACK_V2_LINES: RackV2Line[] = [
  { id: "ASL1", code: "ASL1", defaultMarket: "DKSE" },
  { id: "ASL2", code: "ASL2", defaultMarket: "BENL" },
  { id: "ASL3", code: "ASL3", defaultMarket: "DE" },
  { id: "ASL4", code: "ASL4", defaultMarket: "DE" },
  { id: "ASL5", code: "ASL5", defaultMarket: "DKSE" },
  { id: "ASL6", code: "ASL6", defaultMarket: "BENL" },
];

/** Jede Linie ist mit ihrer Schwester-Linie identisch beplant (immer paarweise). */
export const RACK_V2_LINE_PAIRS: Record<string, string> = {
  ASL1: "ASL5", ASL5: "ASL1",
  ASL2: "ASL6", ASL6: "ASL2",
  ASL3: "ASL4", ASL4: "ASL3",
};

export type RackV2LineGroup = {
  market: RackV2MarketId;
  primaryLineId: string;
  secondaryLineId: string;
};

/** DE = ASL3+4, Nordics = ASL1+5, Benelux = ASL2+6. Planung immer pro Gruppe. */
export const RACK_V2_LINE_GROUPS: RackV2LineGroup[] = [
  { market: "DE",   primaryLineId: "ASL3", secondaryLineId: "ASL4" },
  { market: "DKSE", primaryLineId: "ASL1", secondaryLineId: "ASL5" },
  { market: "BENL", primaryLineId: "ASL2", secondaryLineId: "ASL6" },
];

export type RackV2LineAssignment = {
  line: RackV2Line;
  market: RackV2MarketId;
  packagingHasLiner: boolean;
  dataMarket: RackMarket;
};

export function rackV2MarketHasLiner(market: RackV2MarketId): boolean {
  return market === "DE";
}

export function rackV2BuildAssignment(line: RackV2Line, market: RackV2MarketId): RackV2LineAssignment {
  return {
    line,
    market,
    packagingHasLiner: rackV2MarketHasLiner(market),
    dataMarket: RACK_V2_MARKET_TO_DATA[market],
  };
}

export type RackV2BlockKind = "window" | "gifts";
export type RackV2BlockArea = "rack" | "gifts";

export type RackV2Block = {
  number: number;
  id: string;
  label: string;
  subtitle: string;
  kind: RackV2BlockKind;
  area: RackV2BlockArea;
  minSlot: number;
  maxSlot: number;
  maxTier: 2 | 3;
  pLabel?: string;
  wallBefore?: boolean;
  defaultActive: boolean;
};

export type RackV2ForezoneSlot = {
  id: string;
  minSlot: number;
  maxSlot: number;
  slotsByTier: Partial<Record<1 | 2, number[]>>;
  label: string;
  subtitle: string;
};

export type RackV2MarketLayout = {
  hallLayoutWorkers: number;
  forezone: RackV2ForezoneSlot[];
  blocks: RackV2Block[];
};

const DE_FOREZONE: RackV2ForezoneSlot[] = [
  { id: "de-packaging-box", minSlot: 1, maxSlot: 5, slotsByTier: { 1: [1, 2, 3, 4, 5] }, label: "Packaging", subtitle: "Box / Kartonage" },
  { id: "de-packaging-liner", minSlot: 6, maxSlot: 12, slotsByTier: { 1: [7, 9, 11], 2: [6, 8, 10, 12] }, label: "Packaging", subtitle: "Liner / Packaging" },
];

const NORDICS_FOREZONE: RackV2ForezoneSlot[] = [
  { id: "nordics-packaging-box", minSlot: 1, maxSlot: 5, slotsByTier: { 1: [1, 2, 3, 4, 5] }, label: "Packaging", subtitle: "Box / Kartonage" },
  { id: "nordics-packaging-other", minSlot: 6, maxSlot: 12, slotsByTier: { 1: [7, 9, 11], 2: [6, 8, 10, 12] }, label: "Packaging", subtitle: "Packaging / Reserve" },
];

const DE_BLOCKS: RackV2Block[] = [
  { number: 1,  id: "de-b1",  label: "Block 1",  subtitle: "F13-F18",   kind: "window", area: "rack",  minSlot: 13,  maxSlot: 18,  maxTier: 3, defaultActive: false },
  { number: 2,  id: "de-b2",  label: "Block 2",  subtitle: "F19-F27",   kind: "window", area: "rack",  minSlot: 19,  maxSlot: 27,  maxTier: 3, defaultActive: false },
  { number: 3,  id: "de-b3",  label: "Block 3",  subtitle: "F28-F36",   kind: "window", area: "rack",  minSlot: 28,  maxSlot: 36,  maxTier: 3, defaultActive: true },
  { number: 4,  id: "de-b4",  label: "Block 4",  subtitle: "F37-F45",   kind: "window", area: "rack",  minSlot: 37,  maxSlot: 45,  maxTier: 3, defaultActive: false },
  { number: 5,  id: "de-b5",  label: "Block 5",  subtitle: "F46-F54",   kind: "window", area: "rack",  minSlot: 46,  maxSlot: 54,  maxTier: 3, pLabel: "P1", defaultActive: true },
  { number: 6,  id: "de-b6",  label: "Block 6",  subtitle: "F55-F63",   kind: "window", area: "rack",  minSlot: 55,  maxSlot: 63,  maxTier: 3, defaultActive: false },
  { number: 7,  id: "de-b7",  label: "Block 7",  subtitle: "F64-F72",   kind: "window", area: "rack",  minSlot: 64,  maxSlot: 72,  maxTier: 3, pLabel: "P2", defaultActive: true },
  { number: 8,  id: "de-b8",  label: "Block 8",  subtitle: "F73-F78",   kind: "window", area: "rack",  minSlot: 73,  maxSlot: 78,  maxTier: 3, defaultActive: false },
  { number: 9,  id: "de-b9",  label: "Block 9",  subtitle: "F79-F84",   kind: "window", area: "rack",  minSlot: 79,  maxSlot: 84,  maxTier: 3, defaultActive: false },
  { number: 10, id: "de-b10", label: "Block 10", subtitle: "F85-F90",   kind: "window", area: "rack",  minSlot: 85,  maxSlot: 90,  maxTier: 3, pLabel: "P3", defaultActive: true },
  { number: 11, id: "de-b11", label: "Block 11", subtitle: "F91-F102",  kind: "window", area: "rack",  minSlot: 91,  maxSlot: 102, maxTier: 3, pLabel: "P4", wallBefore: true, defaultActive: true },
  { number: 12, id: "de-b12", label: "Block 12", subtitle: "F103-F112", kind: "window", area: "rack",  minSlot: 103, maxSlot: 112, maxTier: 2, pLabel: "P5", defaultActive: true },
  { number: 13, id: "de-b13", label: "Block 13", subtitle: "F113-F120", kind: "window", area: "rack",  minSlot: 113, maxSlot: 120, maxTier: 2, defaultActive: false },
  { number: 14, id: "de-b14", label: "Block 14", subtitle: "F121-F128", kind: "window", area: "rack",  minSlot: 121, maxSlot: 128, maxTier: 2, pLabel: "P6", defaultActive: true },
  { number: 15, id: "de-b15", label: "Block 15", subtitle: "F129-F136", kind: "window", area: "rack",  minSlot: 129, maxSlot: 136, maxTier: 2, pLabel: "P7", defaultActive: true },
  { number: 16, id: "de-b16", label: "Block 16", subtitle: "F137-F144", kind: "gifts",  area: "gifts", minSlot: 137, maxSlot: 144, maxTier: 2, pLabel: "P8", defaultActive: true },
];

const NORDICS_BLOCKS: RackV2Block[] = [
  { number: 1,  id: "nordics-b1",  label: "Block 1",  subtitle: "F13-F18",   kind: "window", area: "rack", minSlot: 13,  maxSlot: 18,  maxTier: 3, defaultActive: false },
  { number: 2,  id: "nordics-b2",  label: "Block 2",  subtitle: "F19-F27",   kind: "window", area: "rack", minSlot: 19,  maxSlot: 27,  maxTier: 3, defaultActive: false },
  { number: 3,  id: "nordics-b3",  label: "Block 3",  subtitle: "F28-F36",   kind: "window", area: "rack", minSlot: 28,  maxSlot: 36,  maxTier: 3, pLabel: "P1", defaultActive: true },
  { number: 4,  id: "nordics-b4",  label: "Block 4",  subtitle: "F37-F45",   kind: "window", area: "rack", minSlot: 37,  maxSlot: 45,  maxTier: 3, defaultActive: false },
  { number: 5,  id: "nordics-b5",  label: "Block 5",  subtitle: "F46-F54",   kind: "window", area: "rack", minSlot: 46,  maxSlot: 54,  maxTier: 3, pLabel: "P2", defaultActive: true },
  { number: 6,  id: "nordics-b6",  label: "Block 6",  subtitle: "F55-F63",   kind: "window", area: "rack", minSlot: 55,  maxSlot: 63,  maxTier: 3, defaultActive: false },
  { number: 7,  id: "nordics-b7",  label: "Block 7",  subtitle: "F64-F72",   kind: "window", area: "rack", minSlot: 64,  maxSlot: 72,  maxTier: 3, pLabel: "P3", defaultActive: true },
  { number: 8,  id: "nordics-b8",  label: "Block 8",  subtitle: "F73-F78",   kind: "window", area: "rack", minSlot: 73,  maxSlot: 78,  maxTier: 3, defaultActive: false },
  { number: 9,  id: "nordics-b9",  label: "Block 9",  subtitle: "F79-F84",   kind: "window", area: "rack", minSlot: 79,  maxSlot: 84,  maxTier: 3, defaultActive: false },
  { number: 10, id: "nordics-b10", label: "Block 10", subtitle: "F85-F90",   kind: "window", area: "rack", minSlot: 85,  maxSlot: 90,  maxTier: 3, pLabel: "P4", defaultActive: true },
  { number: 11, id: "nordics-b11", label: "Block 11", subtitle: "F91-F102",  kind: "window", area: "rack", minSlot: 91,  maxSlot: 102, maxTier: 3, wallBefore: true, defaultActive: false },
  { number: 12, id: "nordics-b12", label: "Block 12", subtitle: "F103-F112", kind: "window", area: "rack", minSlot: 103, maxSlot: 112, maxTier: 2, pLabel: "P5", defaultActive: true },
  { number: 13, id: "nordics-b13", label: "Block 13", subtitle: "F113-F120", kind: "window", area: "rack", minSlot: 113, maxSlot: 120, maxTier: 2, defaultActive: false },
  { number: 14, id: "nordics-b14", label: "Block 14", subtitle: "F121-F128", kind: "window", area: "rack", minSlot: 121, maxSlot: 128, maxTier: 2, pLabel: "P6", defaultActive: true },
  { number: 15, id: "nordics-b15", label: "Block 15", subtitle: "F129-F136", kind: "window", area: "rack", minSlot: 129, maxSlot: 136, maxTier: 2, defaultActive: true },
  { number: 16, id: "nordics-b16", label: "Block 16", subtitle: "F137-F144", kind: "window", area: "rack", minSlot: 137, maxSlot: 144, maxTier: 2, pLabel: "P7", defaultActive: true },
];

const MARKET_LAYOUTS: Record<RackV2MarketId, RackV2MarketLayout> = {
  DE: { hallLayoutWorkers: 9, forezone: DE_FOREZONE, blocks: DE_BLOCKS },
  DKSE: { hallLayoutWorkers: 7, forezone: NORDICS_FOREZONE, blocks: NORDICS_BLOCKS },
  BENL: { hallLayoutWorkers: 7, forezone: NORDICS_FOREZONE, blocks: NORDICS_BLOCKS },
};

export const RACK_V2_BLUEPRINT = DE_BLOCKS;

export type RackV2ActiveOverrides = Record<string, boolean>;
export type RackV2Layouts = Partial<Record<string, RackEntry[]>>;

export function rackV2MarketLayout(market: RackV2MarketId): RackV2MarketLayout {
  return MARKET_LAYOUTS[market];
}

export function rackV2BlocksForMarket(market: RackV2MarketId): RackV2Block[] {
  return rackV2MarketLayout(market).blocks;
}

export function rackV2ForezoneForMarket(market: RackV2MarketId): RackV2ForezoneSlot[] {
  return rackV2MarketLayout(market).forezone;
}

export function rackV2HallLayoutWorkers(market: RackV2MarketId): number {
  return rackV2MarketLayout(market).hallLayoutWorkers;
}

export function rackV2SlotNumber(position: string): number {
  const match = /^F(\d+)$/i.exec((position ?? "").trim());
  return match ? Number(match[1]) : Number.NaN;
}

export function rackV2NormalizeSlot(slot: number): string {
  return `F${String(slot).padStart(2, "0")}`;
}

export function rackV2BlockForSlot(slotNumber: number, market: RackV2MarketId): RackV2Block | undefined {
  return rackV2BlocksForMarket(market).find((block) => slotNumber >= block.minSlot && slotNumber <= block.maxSlot);
}

export function rackV2IsForezoneSlot(slotNumber: number, market: RackV2MarketId): boolean {
  return rackV2ForezoneForMarket(market).some((zone) => slotNumber >= zone.minSlot && slotNumber <= zone.maxSlot);
}

export function rackV2ForezoneSlotsForTier(zone: RackV2ForezoneSlot, tier: 1 | 2): number[] {
  return zone.slotsByTier[tier] ?? [];
}

export function rackV2BlockSlotsForTier(block: RackV2Block, tier: 1 | 2 | 3): number[] {
  if (tier > block.maxTier) return [];
  const modBase = block.maxTier;
  return Array.from({ length: block.maxSlot - block.minSlot + 1 }, (_, index) => block.minSlot + index)
    .filter((slot) => ((slot - block.minSlot) % modBase) + 1 === tier);
}

export function rackV2SlotTier(slotNumber: number, market: RackV2MarketId): 1 | 2 | 3 | null {
  for (const zone of rackV2ForezoneForMarket(market)) {
    for (const [tierKey, slots] of Object.entries(zone.slotsByTier)) {
      if ((slots ?? []).includes(slotNumber)) return Number(tierKey) as 1 | 2 | 3;
    }
  }
  const block = rackV2BlockForSlot(slotNumber, market);
  if (!block) return null;
  const modBase = block.maxTier;
  return ((((slotNumber - block.minSlot) % modBase) + modBase) % modBase + 1) as 1 | 2 | 3;
}

export type RackV2PackagingZone = "box" | "liner" | "packaging";
export type RackV2SlotPurpose = "meal" | "ice" | "smoothie" | "flyer" | "gift" | "emergency" | "reserve";
export type RackV2EntryPurpose = Exclude<RackV2SlotPurpose, "emergency" | "reserve">;

type RackV2CellRef = `${number}:${1 | 2 | 3}`;
type RackV2PurposeMap = Partial<Record<RackV2SlotPurpose, RackV2CellRef[]>>;

const DE_SLOT_PURPOSES: RackV2PurposeMap = {
  meal: [
    // Block 5 (P1): F46-F54
    "47:2", "49:1", "50:2", "52:1", "53:2",
    // Block 7 (P2): F64-F72
    "64:1", "65:2", "67:1", "68:2", "70:1", "71:2",
    // Block 10 (P3): F85-F90
    "85:1", "86:2", "88:1", "89:2",
    // Block 11 (P4): F91-F102
    "94:1", "97:1", "100:1", "101:2",
    // Block 12 (P5): F103-F112
    "107:1",
    // Block 14 (P6): F121-F128
    "123:1", "124:2", "125:1",
  ],
  ice: ["28:1", "105:1", "133:1"],  // vorne (Block3/F28), mitte (P5/F105), hinten (P7/F133)
  smoothie: ["98:2", "106:2", "108:2", "126:2", "128:2", "132:2", "134:2"],
  flyer: ["136:2", "137:1", "140:2", "141:1"],
  gift: ["135:1", "138:2", "139:1", "142:2", "143:1", "144:2"],
  emergency: [
    // Vorzone Reserve
    "1:1", "4:1", "9:1",
    // Block 5 T3
    "48:3", "51:3", "54:3",
    // Block 7 T3
    "66:3", "69:3", "72:3",
    // Block 10 T3
    "87:3", "90:3",
    // Block 11 T3
    "93:3", "96:3", "99:3", "102:3",
  ],
};

const NORDICS_SLOT_PURPOSES: RackV2PurposeMap = {
  meal: [
    // Block 3 (P1): F28-F36
    "31:1", "32:2", "34:1", "35:2",
    // Block 5 (P2): F46-F54
    "49:1", "50:2", "52:1", "53:2",
    // Block 7 (P3): F64-F72
    "67:1", "68:2", "70:1", "71:2",
    // Block 10 (P4): F85-F90
    "85:1", "86:2", "88:1", "89:2",
    // Block 12 (P5): F103-F112
    "105:1", "107:1", "109:1",
    // Block 14 (P6): F121-F128
    "123:1", "124:2", "125:1",
  ],
  ice: ["135:1"],
  smoothie: ["106:2", "108:2", "122:2"],
  flyer: ["140:2", "141:1", "142:2", "143:1", "144:2"],  // bis zu 5 Loyalty-Slots
  emergency: [
    // Vorzone Reserve (F06-F12 ungenutzt in Nordics)
    "1:1", "6:2", "7:1", "8:2", "9:1", "10:2", "11:1", "12:2",
    // Block 3 T3
    "30:3", "33:3", "36:3",
    // Block 5 T3
    "48:3", "51:3", "54:3",
    // Block 7 T3
    "66:3", "69:3", "72:3",
    // Block 10 T3
    "87:3", "90:3",
  ],
};

function purposeMapForMarket(market: RackV2MarketId): RackV2PurposeMap {
  return market === "DE" ? DE_SLOT_PURPOSES : NORDICS_SLOT_PURPOSES;
}

function cellKey(slot: number, tier: 1 | 2 | 3): RackV2CellRef {
  return `${slot}:${tier}`;
}

export function rackV2SlotPurpose(slot: number, tier: 1 | 2 | 3, market: RackV2MarketId): RackV2SlotPurpose {
  const key = cellKey(slot, tier);
  const purposeMap = purposeMapForMarket(market);
  for (const [purpose, cells] of Object.entries(purposeMap) as Array<[RackV2SlotPurpose, RackV2CellRef[] | undefined]>) {
    if ((cells ?? []).includes(key)) return purpose;
  }
  return "reserve";
}

export function rackV2PurposeSlots(market: RackV2MarketId, purpose: RackV2EntryPurpose): Array<{ slot: number; tier: 1 | 2 | 3 }> {
  return (purposeMapForMarket(market)[purpose] ?? []).map((cell) => {
    const [slot, tier] = cell.split(":").map(Number) as [number, 1 | 2 | 3];
    return { slot, tier };
  });
}

export function rackV2EntryPurpose(entry: RackEntry, market: RackV2MarketId): RackV2EntryPurpose {
  if (rackV2IsIceLike(entry)) return "ice";
  if (rackV2IsSmoothieLike(entry)) return "smoothie";
  const hay = rackV2EntryHaystack(entry);
  if (hay.includes("flyer")) return "flyer";
  if (hay.includes("gift") || deriveEntryKind(entry) === "loyalty") return market === "DE" ? "gift" : "flyer";
  return "meal";
}

export function rackV2SlotPurposeLabel(purpose: RackV2SlotPurpose): string {
  switch (purpose) {
    case "meal": return "Meal";
    case "ice": return "Eis";
    case "smoothie": return "Smoothie";
    case "flyer": return "Flyer";
    case "gift": return "Gifts";
    case "emergency": return "Nur im Notfall";
    default: return "Reserve";
  }
}

export function rackV2PackagingZoneForEntry(entry: RackEntry): RackV2PackagingZone {
  const hay = `${entry.recipe} ${entry.sku} ${entry.ingredient} ${entry.displayName}`.toLowerCase();
  if (hay.includes("liner")) return "liner";
  if (hay.includes("factor box") || /(^|\s)(xs|s|m|l)(\s|$)/i.test(entry.recipe) || /(^|\s)(xs|s|m|l)(\s|$)/i.test(entry.sku)) return "box";
  return "packaging";
}

export function rackV2PackagingAllowedSlots(market: RackV2MarketId, zone: RackV2PackagingZone): number[] {
  if (market === "DE") {
    if (zone === "box") return [2, 3, 5];
    if (zone === "liner") return [6, 7, 8, 10, 11, 12];
    return [1];
  }
  // Nordics/BENL: L, M, S, XS → F02-F05; kein Liner
  if (zone === "box") return [2, 3, 4, 5];
  if (zone === "liner") return [];
  return [1];
}

function inferForezoneTier(slotNumber: number): 1 | 2 {
  if (slotNumber <= 5) return 1;
  if (slotNumber === 6 || slotNumber === 8 || slotNumber === 10 || slotNumber === 12) return 2;
  return 1;
}

function rackV2PackagingSizeRank(entry: RackEntry): number {
  const hay = ` ${entry.recipe} ${entry.sku} ${entry.displayName} `.toLowerCase();
  if (/\bxs\b/.test(hay)) return 3;
  if (/\bs\b/.test(hay)) return 2;
  if (/\bm\b/.test(hay)) return 1;
  if (/\bl\b/.test(hay)) return 0;
  return 99;
}

function rackV2PackagingPlacementTier(slot: number): 1 | 2 {
  return inferForezoneTier(slot);
}

function rackV2UniqueEntries(entries: RackEntry[]): RackEntry[] {
  const seen = new Set<string>();
  const out: RackEntry[] = [];
  for (const entry of entries) {
    const fingerprint = rackV2EntryFingerprint(entry);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(entry);
  }
  return out;
}

function rackV2BuildFixedPackagingLayout(entries: RackEntry[], market: RackV2MarketId): RackEntry[] {
  const packagingEntries = rackV2UniqueEntries(entries.filter((entry) => deriveEntryKind(entry) === "packaging"));
  const boxes = packagingEntries
    .filter((entry) => rackV2PackagingZoneForEntry(entry) === "box")
    .sort((left, right) => rackV2PackagingSizeRank(left) - rackV2PackagingSizeRank(right));
  const liners = packagingEntries.filter((entry) => rackV2PackagingZoneForEntry(entry) === "liner");
  const genericPackaging = packagingEntries.filter((entry) => rackV2PackagingZoneForEntry(entry) === "packaging");

  const planned: RackEntry[] = [];
  const occupied = new Set<string>();

  function place(entry: RackEntry, slot: number) {
    const tier = rackV2PackagingPlacementTier(slot);
    const key = `${slot}:${tier}`;
    if (occupied.has(key)) return;
    occupied.add(key);
    planned.push({
      ...entry,
      flowRackPosition: rackV2NormalizeSlot(slot),
      tier,
      line: "",
      sort: slot,
      quantity: rackV2EffectivePickQuantity(entry),
    });
  }

  const boxSlots = rackV2PackagingAllowedSlots(market, "box");
  boxes.forEach((entry, index) => {
    const slot = boxSlots[index];
    if (slot !== undefined) place(entry, slot);
  });

  const linerSlots = rackV2PackagingAllowedSlots(market, "liner");
  liners.forEach((entry, index) => {
    const slot = linerSlots[index];
    if (slot !== undefined) place(entry, slot);
  });

  const genericSlots = rackV2PackagingAllowedSlots(market, "packaging");
  genericPackaging.forEach((entry, index) => {
    const slot = genericSlots[index];
    if (slot !== undefined) place(entry, slot);
  });

  return planned;
}

export function rackV2IsBlockActive(block: RackV2Block, overrides?: RackV2ActiveOverrides): boolean {
  if (!overrides) return block.defaultActive;
  const override = overrides[block.id];
  return typeof override === "boolean" ? override : block.defaultActive;
}

export function rackV2RecommendedActiveCount(market: RackV2MarketId, plannedWorkers: number): number {
  const blocks = rackV2BlocksForMarket(market);
  return Math.max(1, Math.min(blocks.length, Math.round(plannedWorkers)));
}

export function rackV2RecommendedActiveBlockIds(market: RackV2MarketId, plannedWorkers: number): string[] {
  const blocks = rackV2BlocksForMarket(market);
  if (plannedWorkers <= 0) return [];
  const count = rackV2RecommendedActiveCount(market, plannedWorkers);
  const pBlocks = blocks.filter((block) => block.pLabel).map((block) => block.id);
  if (pBlocks.length >= count) return pBlocks.slice(0, count);
  return [...pBlocks, ...blocks.filter((block) => !block.pLabel).map((block) => block.id)].slice(0, count);
}

export function rackV2ResolveActiveBlockIds(
  market: RackV2MarketId,
  _plannedWorkers: number,
  overrides?: RackV2ActiveOverrides,
): string[] {
  return rackV2BlocksForMarket(market)
    .filter((block) => {
      const override = overrides?.[block.id];
      if (typeof override === "boolean") return override;
      return block.defaultActive;
    })
    .map((block) => block.id);
}

export function rackV2DynamicRoleLabels(activeBlockIds: string[], market: RackV2MarketId): Record<string, string> {
  const active = new Set(activeBlockIds);
  const labels: Record<string, string> = {};
  let roleIndex = 1;
  for (const block of rackV2BlocksForMarket(market)) {
    if (!active.has(block.id)) continue;
    labels[block.id] = block.pLabel ?? `P${roleIndex}`;
    if (!block.pLabel) roleIndex += 1;
  }
  return labels;
}

function rackV2EntryHaystack(entry: RackEntry): string {
  return [entry.recipe, entry.sku, entry.ingredient, entry.displayName]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
}

function rackV2IsSmoothieLike(entry: RackEntry): boolean {
  const hay = rackV2EntryHaystack(entry);
  if (hay.includes("smoothie") || hay.includes("drink") || hay.includes("shot")) return true;
  return String(entry.sku ?? "").toLowerCase().startsWith("bev-");
}

export function rackV2IsIceLike(entry: RackEntry): boolean {
  const hay = rackV2EntryHaystack(entry);
  return deriveEntryKind(entry) === "ice" || hay.includes("icepack") || hay.includes("ice pack") || /\bice\d*\b/.test(hay);
}

export function rackV2EffectivePickQuantity(entry: RackEntry): number {
  const base = Math.max(1, Number(entry.quantity ?? 1));
  if (rackV2IsIceLike(entry)) {
    return base;
  }
  if (deriveEntryKind(entry) === "beverage" || rackV2IsSmoothieLike(entry)) {
    return Math.max(2, base);
  }
  return base;
}

export function rackV2EntryFingerprint(entry: RackEntry): string {
  return [
    entry.recipe,
    String(entry.sku ?? "").toLowerCase(),
    String(entry.ingredient ?? "").toLowerCase(),
  ].join("|");
}

export function rackV2InitialLayout(poolEntries: RackEntry[], market: RackV2MarketId): RackEntry[] {
  return rackV2BuildFixedPackagingLayout(poolEntries, market);
}

export function rackV2AutoFillLayout(
  existing: RackEntry[],
  poolEntries: RackEntry[],
  market: RackV2MarketId,
  activeOverrides?: RackV2ActiveOverrides,
): RackEntry[] {
  const activeBlocks = rackV2BlocksForMarket(market).filter((block) => rackV2IsBlockActive(block, activeOverrides));
  if (activeBlocks.length === 0) {
    return rackV2BuildFixedPackagingLayout([...existing, ...poolEntries], market);
  }

  const occupied = new Set<string>();
  const seen = new Set<string>();
  const merged: RackEntry[] = rackV2BuildFixedPackagingLayout([...existing, ...poolEntries], market);

  for (const entry of merged) {
    const slot = rackV2SlotNumber(entry.flowRackPosition);
    const tier = (entry.tier ?? (Number.isFinite(slot) && slot <= 12 ? inferForezoneTier(slot) : 1)) as 1 | 2 | 3;
    if (Number.isFinite(slot)) occupied.add(`${slot}:${tier}`);
    seen.add(rackV2EntryFingerprint(entry));
  }

  function isSlotInActiveBlocks(slot: number): boolean {
    return activeBlocks.some((block) => slot >= block.minSlot && slot <= block.maxSlot);
  }

  for (const entry of existing) {
    if (deriveEntryKind(entry) === "packaging") continue;
    const slot = rackV2SlotNumber(entry.flowRackPosition);
    if (Number.isFinite(slot) && slot <= 12) continue;
    if (!Number.isFinite(slot) || !isSlotInActiveBlocks(slot)) continue;
    const tier = (entry.tier ?? 1) as 1 | 2 | 3;
    occupied.add(`${slot}:${tier}`);
    seen.add(rackV2EntryFingerprint(entry));
    merged.push({ ...entry, tier });
  }

  const remaining = rackV2UniqueEntries(poolEntries.filter((entry) => {
    if (seen.has(rackV2EntryFingerprint(entry))) return false;
    if (deriveEntryKind(entry) === "packaging") return false;
    return true;
  }));

  const ice: RackEntry[] = [];
  const smoothies: RackEntry[] = [];
  const flyers: RackEntry[] = [];
  const gifts: RackEntry[] = [];
  const meals: RackEntry[] = [];

  for (const entry of remaining) {
    switch (rackV2EntryPurpose(entry, market)) {
      case "ice":
        ice.push(entry);
        break;
      case "smoothie":
        smoothies.push(entry);
        break;
      case "flyer":
        flyers.push(entry);
        break;
      case "gift":
        gifts.push(entry);
        break;
      default:
        meals.push(entry);
    }
  }

  const sortedMeals = [...meals].sort((left, right) => rackV2EffectivePickQuantity(right) - rackV2EffectivePickQuantity(left));

  function allocatePurpose(purpose: RackV2EntryPurpose): { slot: number; tier: 1 | 2 | 3 } | null {
    for (const target of rackV2PurposeSlots(market, purpose)) {
      // Meal-Slots beachten aktive Bloecke; Ice/Smoothie/Flyer/Gift immer platzieren
      if (purpose === "meal" && !isSlotInActiveBlocks(target.slot)) continue;
      const key = `${target.slot}:${target.tier}`;
      if (occupied.has(key)) continue;
      occupied.add(key);
      return target;
    }
    return null;
  }

  function place(entry: RackEntry, target: { slot: number; tier: 1 | 2 | 3 } | null, quantity?: number) {
    if (!target) return;
    merged.push({
      ...entry,
      flowRackPosition: rackV2NormalizeSlot(target.slot),
      tier: target.tier,
      quantity: quantity ?? rackV2EffectivePickQuantity(entry),
      line: "",
      sort: target.slot,
    });
  }

  function placeIceEntries() {
    if (market !== "DE") {
      for (const entry of ice) place(entry, allocatePurpose("ice"));
      return;
    }
    for (let index = 0; index < ice.length; index += 3) {
      const target = allocatePurpose("ice");
      if (!target) return;
      for (const entry of ice.slice(index, index + 3)) {
        place(entry, target);
      }
    }
  }

  // Meal-Slots pro Pickface gruppieren.
  // Innerhalb jedes Pickfaces: T2 zuerst (Mitte = ergonomisch + schneller Griff), dann T1.
  const mealSlotsByPickface = new Map<string, Array<{ slot: number; tier: 1 | 2 | 3 }>>();
  for (const target of rackV2PurposeSlots(market, "meal")) {
    if (!isSlotInActiveBlocks(target.slot)) continue;
    const block = rackV2BlockForSlot(target.slot, market);
    if (!block) continue;
    const pfKey = block.pLabel ?? block.id;
    if (!mealSlotsByPickface.has(pfKey)) mealSlotsByPickface.set(pfKey, []);
    mealSlotsByPickface.get(pfKey)!.push(target);
  }
  for (const slots of mealSlotsByPickface.values()) {
    slots.sort((a, b) => (a.tier === 2 ? -1 : b.tier === 2 ? 1 : 0) || (a.slot - b.slot));
  }

  // Initiale Last aus bereits platzierten Existing-Meals berücksichtigen (manuelle Vorbelegung).
  const loadByPickface = new Map<string, number>(
    [...mealSlotsByPickface.keys()].map((k) => [k, 0]),
  );
  for (const entry of existing) {
    const slot = rackV2SlotNumber(entry.flowRackPosition);
    if (!Number.isFinite(slot) || slot <= 12) continue;
    const tier = (entry.tier ?? 1) as 1 | 2 | 3;
    if (rackV2SlotPurpose(slot, tier, market) !== "meal") continue;
    const block = rackV2BlockForSlot(slot, market);
    if (!block) continue;
    const pfKey = block.pLabel ?? block.id;
    loadByPickface.set(pfKey, (loadByPickface.get(pfKey) ?? 0) + rackV2EffectivePickQuantity(entry));
  }

  // Nächstes Meal immer dem Pickface mit der geringsten aktuellen Picklast zuweisen.
  // Gleiche Last → erster Pickface gewinnt (stabile Reihenfolge).
  function allocateMealBalanced(qty: number): { slot: number; tier: 1 | 2 | 3 } | null {
    let bestKey: string | null = null;
    let bestLoad = Infinity;
    for (const [pfKey, slots] of mealSlotsByPickface.entries()) {
      if (!slots.some(({ slot, tier }) => !occupied.has(`${slot}:${tier}`))) continue;
      const load = loadByPickface.get(pfKey) ?? 0;
      if (load < bestLoad) { bestLoad = load; bestKey = pfKey; }
    }
    if (!bestKey) return null;
    const target = mealSlotsByPickface.get(bestKey)!.find(({ slot, tier }) => !occupied.has(`${slot}:${tier}`));
    if (!target) return null;
    occupied.add(`${target.slot}:${target.tier}`);
    loadByPickface.set(bestKey, (loadByPickface.get(bestKey) ?? 0) + qty);
    return target;
  }

  placeIceEntries();
  for (const entry of [...smoothies].sort((left, right) => rackV2EffectivePickQuantity(right) - rackV2EffectivePickQuantity(left))) {
    place(entry, allocatePurpose("smoothie"));
  }
  for (const entry of gifts) place(entry, allocatePurpose("gift"));
  for (const entry of flyers) place(entry, allocatePurpose("flyer"));

  // Basislast: Shots/Smoothies an festen Pickface-Slots in Ausgangslast einrechnen.
  // Eis ist ausgenommen (gleichmäßige Last, kein Ausgleich nötig).
  for (const entry of merged) {
    const kind = deriveEntryKind(entry);
    if (kind === "packaging" || kind === "meal" || kind === "protein" || kind === "ice") continue;
    const slot = rackV2SlotNumber(entry.flowRackPosition);
    if (!Number.isFinite(slot) || slot <= 12) continue;
    const block = rackV2BlockForSlot(slot, market);
    if (!block?.pLabel || !loadByPickface.has(block.pLabel)) continue;
    loadByPickface.set(block.pLabel, (loadByPickface.get(block.pLabel) ?? 0) + (entry.quantity ?? 1));
  }

  for (const entry of sortedMeals) place(entry, allocateMealBalanced(rackV2EffectivePickQuantity(entry)));

  return merged;
}

export type RackV2PlanValidation = {
  ok: boolean;
  perLine: { lineId: string; lineCode: string; market: RackV2MarketId; issues: RackValidationIssue[] }[];
  global: RackValidationIssue[];
};

function validateLineV2(assignment: RackV2LineAssignment, entries: RackEntry[]): RackValidationIssue[] {
  const issues: RackValidationIssue[] = [];
  const seen = new Map<string, RackEntry>();
  const seenPills = new Map<string, RackEntry>();

  for (const entry of entries) {
    if (entry.line !== assignment.line.code && entry.line !== assignment.line.id) continue;
    const slot = rackV2SlotNumber(entry.flowRackPosition);
    const tier = (entry.tier ?? (Number.isFinite(slot) && slot <= 12 ? inferForezoneTier(slot) : 1)) as 1 | 2 | 3;
    const kind = deriveEntryKind(entry);
    if (!Number.isFinite(slot)) {
      issues.push({ severity: "error", message: `${assignment.line.code}: ungueltiger Slot ${entry.flowRackPosition} (${entry.recipe}).` });
      continue;
    }
    if (!rackV2IsForezoneSlot(slot, assignment.market) && !rackV2BlockForSlot(slot, assignment.market)) {
      issues.push({ severity: "error", message: `${assignment.line.code}: ${entry.flowRackPosition} liegt ausserhalb des Hallenbilds.` });
      continue;
    }
    if (kind === "packaging" && slot > 12) {
      issues.push({ severity: "error", message: `${assignment.line.code}: Packaging darf nur in F1-F12 liegen (${entry.recipe} @ ${entry.flowRackPosition}).` });
    }
    if (kind !== "packaging" && rackV2IsForezoneSlot(slot, assignment.market)) {
      issues.push({ severity: "error", message: `${assignment.line.code}: ${entry.recipe} liegt in der Vorzone; dort darf nur Packaging liegen.` });
    }
    if (kind === "packaging") {
      const zone = rackV2PackagingZoneForEntry(entry);
      const allowedSlots = rackV2PackagingAllowedSlots(assignment.market, zone);
      if (allowedSlots.length > 0 && !allowedSlots.includes(slot)) {
        issues.push({ severity: "error", message: `${assignment.line.code}: ${entry.recipe} passt nicht auf ${entry.flowRackPosition}. Erwartet ${zone === "box" ? "Kartonage" : zone === "liner" ? "Liner" : "Packaging"}-Slot.` });
      }
    }
    if (kind !== "packaging" && !rackV2IsIceLike(entry)) {
      const pillKey = rackV2EntryFingerprint(entry);
      const existingPill = seenPills.get(pillKey);
      if (existingPill) {
        issues.push({ severity: "error", message: `${assignment.line.code}: ${entry.recipe} ist doppelt auf der Linie (${existingPill.flowRackPosition} und ${entry.flowRackPosition}).` });
      } else {
        seenPills.set(pillKey, entry);
      }
    }
    const block = rackV2BlockForSlot(slot, assignment.market);
    const expectedTier = rackV2SlotTier(slot, assignment.market);
    if (block && tier > block.maxTier) {
      issues.push({ severity: "error", message: `${assignment.line.code}: Tier ${tier} ist in ${block.label} nicht erlaubt.` });
    }
    if (expectedTier && tier !== expectedTier) {
      issues.push({ severity: "error", message: `${assignment.line.code}: ${entry.flowRackPosition} muss auf Ebene ${expectedTier} liegen, nicht Ebene ${tier}.` });
    }
    if (block && kind !== "packaging") {
      const expectedPurpose = rackV2EntryPurpose(entry, assignment.market);
      const actualPurpose = rackV2SlotPurpose(slot, tier, assignment.market);
      if (actualPurpose !== expectedPurpose) {
        issues.push({
          severity: "error",
          message: `${assignment.line.code}: ${entry.recipe} passt nicht auf ${entry.flowRackPosition} Tier ${tier}. Erwartet ${rackV2SlotPurposeLabel(expectedPurpose)}, Platz ist ${rackV2SlotPurposeLabel(actualPurpose)}.`,
        });
      }
    }
    const key = `${slot}:${tier}`;
    const existing = seen.get(key);
    if (existing && !(rackV2IsIceLike(existing) && rackV2IsIceLike(entry))) {
      issues.push({ severity: "error", message: `${assignment.line.code}: ${entry.flowRackPosition} Tier ${tier} ist doppelt belegt.` });
    } else if (!existing) {
      seen.set(key, entry);
    }
  }

  return issues;
}

export function assembleRackfileFromV2(assignments: RackV2LineAssignment[], layouts: RackV2Layouts): RackEntry[] {
  const out: RackEntry[] = [];
  for (const assignment of assignments) {
    const source = layouts[assignment.line.id] ?? [];
    for (const entry of source) {
      const labelPos = `${assignment.line.code}${entry.flowRackPosition}`;
      const portionSuffix = entry.recipe.includes("_") ? entry.recipe.split("_", 2)[1] : "";
      out.push({
        ...entry,
        line: assignment.line.code,
        labelPos,
        uniCode: `${labelPos}${portionSuffix}`,
      });
    }
  }
  return out;
}

export function validateV2Plan(
  assignments: RackV2LineAssignment[],
  layouts: RackV2Layouts,
  options?: { pdlIds?: Set<string>; boxfile?: RackBoxSnapshot; co2MealIds?: Set<string> },
): RackV2PlanValidation {
  const perLine: RackV2PlanValidation["perLine"] = [];
  const allEntries = assembleRackfileFromV2(assignments, layouts);
  const marketByLine = new Map(assignments.map((assignment) => [assignment.line.code, assignment.market]));

  for (const assignment of assignments) {
    const issues = validateLineV2(assignment, allEntries);
    perLine.push({
      lineId: assignment.line.id,
      lineCode: assignment.line.code,
      market: assignment.market,
      issues,
    });
  }

  const global = validateRackPlan(allEntries, options).issues.filter((issue) => !/^Mehrfachbelegung in /.test(issue.message));
  const seenByMarket = new Map<string, RackEntry>();
  for (const entry of allEntries) {
    if (deriveEntryKind(entry) === "packaging" || rackV2IsIceLike(entry)) continue;
    const market = marketByLine.get(entry.line);
    if (!market) continue;
    const key = `${market}:${rackV2EntryFingerprint(entry)}`;
    const existing = seenByMarket.get(key);
    if (existing) {
      global.push({
        severity: "error",
        message: `Doppelte Pille im Markt ${market}: ${entry.recipe} liegt auf ${existing.line}/${existing.flowRackPosition} und ${entry.line}/${entry.flowRackPosition}.`,
      });
    } else {
      seenByMarket.set(key, entry);
    }
  }
  const ok = perLine.every((line) => line.issues.every((issue) => issue.severity !== "error"))
    && global.every((issue) => issue.severity !== "error");

  return { ok, perLine, global };
}
