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
  { number: 1, id: "de-b1", label: "Block 1", subtitle: "F13-F18", kind: "window", area: "rack", minSlot: 13, maxSlot: 18, maxTier: 3, defaultActive: true },
  { number: 2, id: "de-b2", label: "Block 2", subtitle: "F19-F27", kind: "window", area: "rack", minSlot: 19, maxSlot: 27, maxTier: 3, defaultActive: true },
  { number: 3, id: "de-b3", label: "Block 3", subtitle: "F28-F36", kind: "window", area: "rack", minSlot: 28, maxSlot: 36, maxTier: 3, defaultActive: true },
  { number: 4, id: "de-b4", label: "Block 4", subtitle: "F37-F45", kind: "window", area: "rack", minSlot: 37, maxSlot: 45, maxTier: 3, defaultActive: true },
  { number: 5, id: "de-b5", label: "Block 5", subtitle: "F46-F54", kind: "window", area: "rack", minSlot: 46, maxSlot: 54, maxTier: 3, defaultActive: true },
  { number: 6, id: "de-b6", label: "Block 6", subtitle: "F55-F63", kind: "window", area: "rack", minSlot: 55, maxSlot: 63, maxTier: 3, defaultActive: true },
  { number: 7, id: "de-b7", label: "Block 7", subtitle: "F64-F72", kind: "window", area: "rack", minSlot: 64, maxSlot: 72, maxTier: 3, defaultActive: true },
  { number: 8, id: "de-b8", label: "Block 8", subtitle: "F73-F81", kind: "window", area: "rack", minSlot: 73, maxSlot: 81, maxTier: 3, defaultActive: true },
  { number: 9, id: "de-b9", label: "Block 9", subtitle: "F82-F90", kind: "window", area: "rack", minSlot: 82, maxSlot: 90, maxTier: 3, defaultActive: true },
  { number: 10, id: "de-b10", label: "Block 10", subtitle: "F91-F102", kind: "window", area: "rack", minSlot: 91, maxSlot: 102, maxTier: 3, wallBefore: true, defaultActive: true },
  { number: 11, id: "de-b11", label: "Block 11", subtitle: "F103-F114", kind: "window", area: "rack", minSlot: 103, maxSlot: 114, maxTier: 2, defaultActive: true },
  { number: 12, id: "de-b12", label: "Block 12", subtitle: "F115-F126", kind: "window", area: "rack", minSlot: 115, maxSlot: 126, maxTier: 2, defaultActive: true },
  { number: 13, id: "de-b13", label: "Block 13", subtitle: "F127-F136", kind: "window", area: "rack", minSlot: 127, maxSlot: 136, maxTier: 2, defaultActive: true },
  { number: 14, id: "de-b14", label: "Block 14", subtitle: "F137-F144", kind: "gifts", area: "gifts", minSlot: 137, maxSlot: 144, maxTier: 2, defaultActive: true },
];

const NORDICS_BLOCKS: RackV2Block[] = [
  { number: 1, id: "nordics-b1", label: "Block 1", subtitle: "F13-F18", kind: "window", area: "rack", minSlot: 13, maxSlot: 18, maxTier: 3, defaultActive: true },
  { number: 2, id: "nordics-b2", label: "Block 2", subtitle: "F19-F27", kind: "window", area: "rack", minSlot: 19, maxSlot: 27, maxTier: 3, defaultActive: true },
  { number: 3, id: "nordics-b3", label: "Block 3", subtitle: "F28-F36", kind: "window", area: "rack", minSlot: 28, maxSlot: 36, maxTier: 3, defaultActive: true },
  { number: 4, id: "nordics-b4", label: "Block 4", subtitle: "F37-F45", kind: "window", area: "rack", minSlot: 37, maxSlot: 45, maxTier: 3, defaultActive: true },
  { number: 5, id: "nordics-b5", label: "Block 5", subtitle: "F46-F54", kind: "window", area: "rack", minSlot: 46, maxSlot: 54, maxTier: 3, defaultActive: true },
  { number: 6, id: "nordics-b6", label: "Block 6", subtitle: "F55-F63", kind: "window", area: "rack", minSlot: 55, maxSlot: 63, maxTier: 3, defaultActive: true },
  { number: 7, id: "nordics-b7", label: "Block 7", subtitle: "F64-F72", kind: "window", area: "rack", minSlot: 64, maxSlot: 72, maxTier: 3, defaultActive: true },
  { number: 8, id: "nordics-b8", label: "Block 8", subtitle: "F73-F81", kind: "window", area: "rack", minSlot: 73, maxSlot: 81, maxTier: 3, defaultActive: true },
  { number: 9, id: "nordics-b9", label: "Block 9", subtitle: "F82-F90", kind: "window", area: "rack", minSlot: 82, maxSlot: 90, maxTier: 3, defaultActive: true },
  { number: 10, id: "nordics-b10", label: "Block 10", subtitle: "F91-F102", kind: "window", area: "rack", minSlot: 91, maxSlot: 102, maxTier: 3, wallBefore: true, defaultActive: true },
  { number: 11, id: "nordics-b11", label: "Block 11", subtitle: "F103-F114", kind: "window", area: "rack", minSlot: 103, maxSlot: 114, maxTier: 2, defaultActive: true },
  { number: 12, id: "nordics-b12", label: "Block 12", subtitle: "F115-F126", kind: "window", area: "rack", minSlot: 115, maxSlot: 126, maxTier: 2, defaultActive: true },
  { number: 13, id: "nordics-b13", label: "Block 13", subtitle: "F127-F136", kind: "window", area: "rack", minSlot: 127, maxSlot: 136, maxTier: 2, defaultActive: true },
  { number: 14, id: "nordics-b14", label: "Block 14", subtitle: "F137-F144", kind: "gifts", area: "gifts", minSlot: 137, maxSlot: 144, maxTier: 2, defaultActive: true },
];

const MARKET_LAYOUTS: Record<RackV2MarketId, RackV2MarketLayout> = {
  DE: { hallLayoutWorkers: 11, forezone: DE_FOREZONE, blocks: DE_BLOCKS },
  DKSE: { hallLayoutWorkers: 8, forezone: NORDICS_FOREZONE, blocks: NORDICS_BLOCKS },
  BENL: { hallLayoutWorkers: 8, forezone: NORDICS_FOREZONE, blocks: NORDICS_BLOCKS },
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
    if (zone === "box") return [2, 3, 5];          // DE: Kartons fest auf F2, F3, F5
    if (zone === "liner") return [6, 8, 10, 12];   // DE: Liner fest auf Tier-2-Positionen
    return [1];
  }
  if (zone === "box") return [2, 3, 4];            // Nordics: Kartonage fest auf F2, F3, F4
  if (zone === "liner") return [];                 // Nordics: kein Liner
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
  const hallWorkers = rackV2HallLayoutWorkers(market);
  const delta = Math.round(plannedWorkers) - hallWorkers;
  return Math.max(1, Math.min(blocks.length, blocks.length + delta));
}

export function rackV2RecommendedActiveBlockIds(market: RackV2MarketId, plannedWorkers: number): string[] {
  return rackV2BlocksForMarket(market)
    .slice(0, rackV2RecommendedActiveCount(market, plannedWorkers))
    .map((block) => block.id);
}

export function rackV2ResolveActiveBlockIds(
  market: RackV2MarketId,
  plannedWorkers: number,
  overrides?: RackV2ActiveOverrides,
): string[] {
  const recommended = new Set(rackV2RecommendedActiveBlockIds(market, plannedWorkers));
  return rackV2BlocksForMarket(market)
    .filter((block) => {
      const override = overrides?.[block.id];
      if (typeof override === "boolean") return override;
      return recommended.has(block.id);
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

function rackV2IsSmoothieLike(entry: RackEntry): boolean {
  const hay = [entry.recipe, entry.sku, entry.ingredient, entry.displayName]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  return hay.includes("smoothie") || hay.includes("drink");
}

export function rackV2EffectivePickQuantity(entry: RackEntry): number {
  const base = Math.max(1, Number(entry.quantity ?? 1));
  if (deriveEntryKind(entry) === "beverage" || rackV2IsSmoothieLike(entry)) {
    return Math.max(2, base);
  }
  return base;
}

export function rackV2EntryFingerprint(entry: RackEntry): string {
  return [
    entry.recipe,
    String(entry.sku ?? "").toLowerCase(),
    String(entry.uniCode ?? "").toLowerCase(),
    String(entry.ingredient ?? "").toLowerCase(),
  ].join("|");
}

function rackV2AllocationTier(block: RackV2Block, preferredTier: 1 | 2 | 3): Array<1 | 2 | 3> {
  // Tier-Reihenfolge: 2=Mittelschiene (ergonomisch best), 1=Unterschiene, 3=Oberschiene nur Not
  const order: Array<1 | 2 | 3> = preferredTier === 2 ? [2, 1, 3] : [1, 2, 3];
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
  const occupied = new Set<string>();
  const seen = new Set<string>();
  const merged: RackEntry[] = rackV2BuildFixedPackagingLayout([...existing, ...poolEntries], market);

  for (const entry of merged) {
    const slot = rackV2SlotNumber(entry.flowRackPosition);
    const tier = (entry.tier ?? (Number.isFinite(slot) && slot <= 12 ? inferForezoneTier(slot) : 1)) as 1 | 2 | 3;
    if (Number.isFinite(slot)) occupied.add(`${slot}:${tier}`);
    seen.add(rackV2EntryFingerprint(entry));
  }

  for (const entry of existing) {
    if (deriveEntryKind(entry) === "packaging") continue;
    const slot = rackV2SlotNumber(entry.flowRackPosition);
    if (Number.isFinite(slot) && slot <= 12) continue;
    const tier = (entry.tier ?? (Number.isFinite(slot) && slot <= 12 ? inferForezoneTier(slot) : 1)) as 1 | 2 | 3;
    if (Number.isFinite(slot)) occupied.add(`${slot}:${tier}`);
    seen.add(rackV2EntryFingerprint(entry));
    merged.push({ ...entry, tier });
  }

  const remaining = poolEntries.filter((entry) => {
    if (seen.has(rackV2EntryFingerprint(entry))) return false;
    if (deriveEntryKind(entry) === "packaging") return false;
    return true;
  });

  const ice: RackEntry[] = [];
  const gifts: RackEntry[] = [];
  const meals: RackEntry[] = [];
  for (const entry of remaining) {
    const kind = deriveEntryKind(entry);
    if (kind === "ice") ice.push(entry);
    else if (kind === "loyalty") gifts.push(entry);
    else meals.push(entry);
  }

  const sortedMeals = [...meals].sort((left, right) => (right.quantity ?? 0) - (left.quantity ?? 0));
  // Highrunner (oberstes Drittel nach Menge) → Tier 2 (Mittelschiene)
  // Alles andere (inkl. Mid + Low) → Tier 1 (Unterschiene), Tier 3 nur im Notfall
  const highCount = Math.ceil(sortedMeals.length / 3);
  const runnerClass = new Map<string, "high" | "low">();
  sortedMeals.forEach((entry, index) => {
    runnerClass.set(entry.id, index < highCount ? "high" : "low");
  });

  function allocate(block: RackV2Block | undefined, preferredTier: 1 | 2 | 3): { slot: number; tier: 1 | 2 | 3 } | null {
    if (!block) return null;
    for (const tier of rackV2AllocationTier(block, preferredTier)) {
      for (const slot of rackV2BlockSlotsForTier(block, tier)) {
        const key = `${slot}:${tier}`;
        if (occupied.has(key)) continue;
        occupied.add(key);
        return { slot, tier };
      }
    }
    return null;
  }

  function place(entry: RackEntry, slot: number, tier: 1 | 2 | 3) {
    merged.push({
      ...entry,
      flowRackPosition: rackV2NormalizeSlot(slot),
      tier,
      quantity: rackV2EffectivePickQuantity(entry),
      line: "",
      sort: slot,
    });
  }

  const firstBlock = activeBlocks[0];
  const lastBlock = activeBlocks[activeBlocks.length - 1];
  const midBlock = activeBlocks.find((block) => block.minSlot <= 90 && block.maxSlot >= 85) ?? activeBlocks[Math.floor(activeBlocks.length / 2)];

  ice.forEach((entry, index) => {
    // DE: Dreier Eis (qty 3) verteilt auf Vorne → Mitte → Hinten
    // Nordics: Eis immer ganz hinten
    const iceTargets = market === "DE"
      ? [firstBlock, midBlock, lastBlock]
      : [lastBlock, midBlock];
    const primary = iceTargets[index % iceTargets.length];
    const allocated =
      allocate(primary, 2) ??
      allocate(midBlock, 2) ??
      allocate(firstBlock, 2) ??
      allocate(lastBlock, 2);
    if (!allocated) return;
    merged.push({
      ...entry,
      flowRackPosition: rackV2NormalizeSlot(allocated.slot),
      tier: allocated.tier,
      quantity: market === "DE" ? 3 : 1, // Nordics: Eis = 1 Stück = 1 Fach
      line: "",
      sort: allocated.slot,
    });
  });

  const giftsTargets = activeBlocks.filter((block) => block.area === "gifts");
  for (const entry of gifts) {
    let placed = false;
    for (const block of giftsTargets) {
      const allocated = allocate(block, 1);
      if (!allocated) continue;
      place(entry, allocated.slot, allocated.tier);
      placed = true;
      break;
    }
    if (!placed) {
      const fallback = allocate(lastBlock, 1);
      if (fallback) place(entry, fallback.slot, fallback.tier);
    }
  }

  let cursor = 0;
  for (const entry of sortedMeals) {
    // Highrunner → Tier 2 (Mittelschiene), alle anderen → Tier 1 (Unterschiene)
    // Tier 3 (Oberschiene) nur als absoluter Notfall via rackV2AllocationTier-Fallback
    const preferredTier: 1 | 2 | 3 = runnerClass.get(entry.id) === "high" ? 2 : 1;
    let placed = false;
    for (let attempt = 0; attempt < activeBlocks.length && !placed; attempt += 1) {
      const block = activeBlocks[(cursor + attempt) % activeBlocks.length];
      const allocated = allocate(block, preferredTier);
      if (!allocated) continue;
      place(entry, allocated.slot, allocated.tier);
      // Block dicht befüllen ("so wenig Racks wie möglich") → Cursor bleibt auf
      // aktuellem Block bis er voll ist, erst dann Schritt zum nächsten
      cursor = (cursor + attempt) % Math.max(activeBlocks.length, 1);
      placed = true;
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
    if (existing && !(deriveEntryKind(existing) === "ice" && kind === "ice")) {
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
      out.push({ ...entry, line: assignment.line.code });
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
  const ok = perLine.every((line) => line.issues.every((issue) => issue.severity !== "error"))
    && global.every((issue) => issue.severity !== "error");

  return { ok, perLine, global };
}
