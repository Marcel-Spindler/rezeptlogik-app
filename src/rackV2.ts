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
  { number: 1, id: "de-b1", label: "Block 1", subtitle: "F13-F18", kind: "window", area: "rack", minSlot: 13, maxSlot: 18, maxTier: 3, defaultActive: false },
  { number: 2, id: "de-b2", label: "Block 2", subtitle: "F19-F27", kind: "window", area: "rack", minSlot: 19, maxSlot: 27, maxTier: 3, defaultActive: false },
  { number: 3, id: "de-b3", label: "Block 3", subtitle: "F28-F36", kind: "window", area: "rack", minSlot: 28, maxSlot: 36, maxTier: 3, defaultActive: false },
  { number: 4, id: "de-b4", label: "Block 4", subtitle: "F37-F45", kind: "window", area: "rack", minSlot: 37, maxSlot: 45, maxTier: 3, defaultActive: false },
  { number: 5, id: "de-b5", label: "Block 5", subtitle: "F46-F54", kind: "window", area: "rack", minSlot: 46, maxSlot: 54, maxTier: 3, defaultActive: false },
  { number: 6, id: "de-b6", label: "Block 6", subtitle: "F55-F63", kind: "window", area: "rack", minSlot: 55, maxSlot: 63, maxTier: 3, defaultActive: false },
  { number: 7, id: "de-b7", label: "Block 7", subtitle: "F64-F72", kind: "window", area: "rack", minSlot: 64, maxSlot: 72, maxTier: 3, defaultActive: false },
  { number: 8, id: "de-b8", label: "Block 8", subtitle: "F73-F78", kind: "window", area: "rack", minSlot: 73, maxSlot: 78, maxTier: 3, defaultActive: false },
  { number: 9, id: "de-b9", label: "Block 9", subtitle: "F79-F84", kind: "window", area: "rack", minSlot: 79, maxSlot: 84, maxTier: 3, defaultActive: false },
  { number: 10, id: "de-b10", label: "Block 10", subtitle: "F85-F90", kind: "window", area: "rack", minSlot: 85, maxSlot: 90, maxTier: 3, defaultActive: false },
  { number: 11, id: "de-b11", label: "Block 11", subtitle: "F91-F102", kind: "window", area: "rack", minSlot: 91, maxSlot: 102, maxTier: 3, wallBefore: true, defaultActive: false },
  { number: 12, id: "de-b12", label: "Block 12", subtitle: "F103-F112", kind: "window", area: "rack", minSlot: 103, maxSlot: 112, maxTier: 2, defaultActive: false },
  { number: 13, id: "de-b13", label: "Block 13", subtitle: "F113-F120", kind: "window", area: "rack", minSlot: 113, maxSlot: 120, maxTier: 2, defaultActive: false },
  { number: 14, id: "de-b14", label: "Block 14", subtitle: "F121-F128", kind: "window", area: "rack", minSlot: 121, maxSlot: 128, maxTier: 2, defaultActive: false },
  { number: 15, id: "de-b15", label: "Block 15", subtitle: "F129-F136", kind: "window", area: "rack", minSlot: 129, maxSlot: 136, maxTier: 2, defaultActive: false },
  { number: 16, id: "de-b16", label: "Block 16", subtitle: "F137-F144", kind: "gifts", area: "gifts", minSlot: 137, maxSlot: 144, maxTier: 2, defaultActive: false },
];

const NORDICS_BLOCKS: RackV2Block[] = [
  { number: 1, id: "nordics-b1", label: "Block 1", subtitle: "F13-F18", kind: "window", area: "rack", minSlot: 13, maxSlot: 18, maxTier: 3, defaultActive: false },
  { number: 2, id: "nordics-b2", label: "Block 2", subtitle: "F19-F27", kind: "window", area: "rack", minSlot: 19, maxSlot: 27, maxTier: 3, defaultActive: false },
  { number: 3, id: "nordics-b3", label: "Block 3", subtitle: "F28-F36", kind: "window", area: "rack", minSlot: 28, maxSlot: 36, maxTier: 3, defaultActive: false },
  { number: 4, id: "nordics-b4", label: "Block 4", subtitle: "F37-F45", kind: "window", area: "rack", minSlot: 37, maxSlot: 45, maxTier: 3, defaultActive: false },
  { number: 5, id: "nordics-b5", label: "Block 5", subtitle: "F46-F54", kind: "window", area: "rack", minSlot: 46, maxSlot: 54, maxTier: 3, defaultActive: false },
  { number: 6, id: "nordics-b6", label: "Block 6", subtitle: "F55-F63", kind: "window", area: "rack", minSlot: 55, maxSlot: 63, maxTier: 3, defaultActive: false },
  { number: 7, id: "nordics-b7", label: "Block 7", subtitle: "F64-F72", kind: "window", area: "rack", minSlot: 64, maxSlot: 72, maxTier: 3, defaultActive: false },
  { number: 8, id: "nordics-b8", label: "Block 8", subtitle: "F73-F78", kind: "window", area: "rack", minSlot: 73, maxSlot: 78, maxTier: 3, defaultActive: false },
  { number: 9, id: "nordics-b9", label: "Block 9", subtitle: "F79-F84", kind: "window", area: "rack", minSlot: 79, maxSlot: 84, maxTier: 3, defaultActive: false },
  { number: 10, id: "nordics-b10", label: "Block 10", subtitle: "F85-F90", kind: "window", area: "rack", minSlot: 85, maxSlot: 90, maxTier: 3, defaultActive: false },
  { number: 11, id: "nordics-b11", label: "Block 11", subtitle: "F91-F102", kind: "window", area: "rack", minSlot: 91, maxSlot: 102, maxTier: 3, wallBefore: true, defaultActive: false },
  { number: 12, id: "nordics-b12", label: "Block 12", subtitle: "F103-F112", kind: "window", area: "rack", minSlot: 103, maxSlot: 112, maxTier: 2, defaultActive: false },
  { number: 13, id: "nordics-b13", label: "Block 13", subtitle: "F113-F120", kind: "window", area: "rack", minSlot: 113, maxSlot: 120, maxTier: 2, defaultActive: false },
  { number: 14, id: "nordics-b14", label: "Block 14", subtitle: "F121-F128", kind: "window", area: "rack", minSlot: 121, maxSlot: 128, maxTier: 2, defaultActive: false },
  { number: 15, id: "nordics-b15", label: "Block 15", subtitle: "F129-F136", kind: "window", area: "rack", minSlot: 129, maxSlot: 136, maxTier: 2, defaultActive: false },
  { number: 16, id: "nordics-b16", label: "Block 16", subtitle: "F137-F144", kind: "window", area: "rack", minSlot: 137, maxSlot: 144, maxTier: 2, defaultActive: false },
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

export function rackV2PackagingZoneForEntry(entry: RackEntry): RackV2PackagingZone {
  const hay = `${entry.recipe} ${entry.sku} ${entry.ingredient} ${entry.displayName}`.toLowerCase();
  if (hay.includes("liner")) return "liner";
  if (hay.includes("factor box") || /(^|\s)(xs|s|m|l)(\s|$)/i.test(entry.recipe) || /(^|\s)(xs|s|m|l)(\s|$)/i.test(entry.sku)) return "box";
  return "packaging";
}

export function rackV2PackagingAllowedSlots(market: RackV2MarketId, zone: RackV2PackagingZone): number[] {
  if (market === "DE") {
    if (zone === "box") return [2, 3, 5];
    if (zone === "liner") return [6, 8, 10, 12];
    return [1];
  }
  if (zone === "box") return [2, 3, 4];
  if (zone === "liner") return [];
  return [1, 5];
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
  if (market === "DE") {
    const preferred = blocks.filter((block) => block.number >= 11).map((block) => block.id);
    if (preferred.length >= count) return preferred.slice(0, count);
    const rest = blocks.filter((block) => block.number < 11).map((block) => block.id);
    return [...preferred, ...rest].slice(0, count);
  }
  return blocks.slice(0, count).map((block) => block.id);
}

export function rackV2ResolveActiveBlockIds(
  market: RackV2MarketId,
  plannedWorkers: number,
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
    labels[block.id] = `P${roleIndex}`;
    roleIndex += 1;
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
  return hay.includes("smoothie") || hay.includes("drink");
}

export function rackV2IsIceLike(entry: RackEntry): boolean {
  const hay = rackV2EntryHaystack(entry);
  return deriveEntryKind(entry) === "ice" || hay.includes("icepack") || hay.includes("ice pack") || /\bice\d*\b/.test(hay);
}

function rackV2IsFlyerOrGiftLike(entry: RackEntry): boolean {
  const hay = rackV2EntryHaystack(entry);
  return hay.includes("flyer") || hay.includes("gift") || deriveEntryKind(entry) === "loyalty";
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

function rackV2AllocationTier(block: RackV2Block, preferredTier: 1 | 2 | 3): Array<1 | 2 | 3> {
  const order: Array<1 | 2 | 3> =
    preferredTier === 2 ? [2, 1, 3] :
    preferredTier === 3 ? [3, 2, 1] :
    [1, 2, 3];
  return order.filter((tier) => tier <= block.maxTier);
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
  const tailOnly: RackEntry[] = [];
  const meals: RackEntry[] = [];

  for (const entry of remaining) {
    if (rackV2IsIceLike(entry)) {
      ice.push(entry);
      continue;
    }
    if (market === "DE" && rackV2IsFlyerOrGiftLike(entry) && !rackV2IsSmoothieLike(entry)) {
      tailOnly.push(entry);
      continue;
    }
    meals.push(entry);
  }

  const sortedMeals = [...meals].sort((left, right) => rackV2EffectivePickQuantity(right) - rackV2EffectivePickQuantity(left));
  const highPickCutoff = sortedMeals.length > 0
    ? rackV2EffectivePickQuantity(sortedMeals[Math.max(0, Math.ceil(sortedMeals.length / 3) - 1)])
    : Number.POSITIVE_INFINITY;
  const lowPickCutoff = sortedMeals.length > 0
    ? rackV2EffectivePickQuantity(sortedMeals[Math.max(0, Math.floor(sortedMeals.length * 2 / 3) - 1)])
    : Number.POSITIVE_INFINITY;

  function ergonomicTierForEntry(entry: RackEntry): 1 | 2 | 3 {
    const picks = rackV2EffectivePickQuantity(entry);
    if (picks >= highPickCutoff) return 2;
    if (picks <= lowPickCutoff) return 3;
    return 1;
  }

  function allocate(blocks: RackV2Block[], preferredTier: 1 | 2 | 3): { slot: number; tier: 1 | 2 | 3 } | null {
    for (const block of blocks) {
      for (const tier of rackV2AllocationTier(block, preferredTier)) {
        for (const slot of rackV2BlockSlotsForTier(block, tier)) {
          const key = `${slot}:${tier}`;
          if (occupied.has(key)) continue;
          occupied.add(key);
          return { slot, tier };
        }
      }
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

  const descActive = [...activeBlocks].sort((a, b) => b.number - a.number);
  const ascActive = [...activeBlocks].sort((a, b) => a.number - b.number);

  if (market === "DE") {
    const giftBlocks = ascActive.filter((block) => block.area === "gifts");
    const tailBlocks = ascActive.filter((block) => block.number >= 15);

    for (const entry of tailOnly) {
      const target =
        allocate(giftBlocks, 1) ??
        allocate(tailBlocks, 1);
      place(entry, target);
    }

    for (const entry of ice) {
      const target = allocate(tailBlocks, 2);
      place(entry, target, 3);
    }

    for (const entry of sortedMeals) {
      const preferredTier = ergonomicTierForEntry(entry);
      const target = allocate(ascActive, preferredTier) ?? allocate(descActive, preferredTier);
      place(entry, target);
    }
  } else {
    for (const entry of ice) {
      const target = allocate(descActive, 2) ?? allocate(ascActive, 2);
      place(entry, target);
    }
    for (const entry of sortedMeals) {
      const preferredTier = ergonomicTierForEntry(entry);
      const target = allocate(ascActive, preferredTier) ?? allocate(descActive, preferredTier);
      place(entry, target);
    }
  }

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
