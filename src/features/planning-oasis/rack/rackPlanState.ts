// Persistenz- und Pool-Schicht für Rack V2: Storage-Keys, MultiLine-Excel-Laden,
// Plan-State parsen/serialisieren (localStorage, versioniert v2→v3).
import {
  deriveEntryKind, parseMultilineExcel, type RackEntry, type RackMarket,
} from "../../../lib/rack";
import {
  RACK_V2_LINES, RACK_V2_MARKET_TO_DATA, rackV2EntryFingerprint, rackV2HallLayoutWorkers, rackV2InitialLayout,
  type RackV2ActiveOverrides, type RackV2Line, type RackV2MarketId,
} from "../../../lib/rackV2";

export type StoredEntry = Pick<
  RackEntry,
  "recipe" | "line" | "flowRackPosition" | "quantity" | "sku" |
  "ingredient" | "scanRegEx" | "labelPos" | "uniCode" | "displayName" |
  "gramage" | "sort" | "source" | "tier"
>;

export type ReleaseStatus = "draft" | "released" | "rework";

export type LinePlanState = {
  market: RackV2MarketId;
  entries: RackEntry[];
  plannedWorkers: number;
  manualOverrides: RackV2ActiveOverrides;
  releaseStatus: ReleaseStatus;
  releasedAt?: number;
  releasedBy?: string;
  reworkAt?: number;
  reworkBy?: string;
};

export type SharedPlanState = {
  lines: Record<string, LinePlanState>;
};

export type DragPayload = {
  entryId: string;
  source: "board" | "pool";
  lineId: string;
};

export type EntriesByDataMarket = Record<RackMarket, RackEntry[]>;

const AUTO_MULTILINE_URL = "/data/rack/MultiLine-latest.xlsx";
export const ALL_MARKETS: RackV2MarketId[] = ["DE", "DKSE", "BENL"];

export function storageKey(week: string): string {
  return `rackV2.shared.${week}.v3`;
}

export function legacyStorageKey(week: string): string {
  return `rackV2.shared.${week}.v2`;
}

export function weekDocId(week: string): string {
  return week.replace(/[^A-Za-z0-9_-]+/g, "-");
}

export function actorName(): string {
  if (typeof window === "undefined") return "unknown";
  return window.location.hostname || "unknown";
}

export function dedupePoolEntries(entries: RackEntry[]): RackEntry[] {
  const seen = new Set<string>();
  const out: RackEntry[] = [];
  for (const entry of entries) {
    const key = `${rackV2EntryFingerprint(entry)}|${String(entry.flowRackPosition).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function rackV2EntryBelongsToMarket(entry: RackEntry, market: RackV2MarketId): boolean {
  const recipe = String(entry.recipe ?? "").trim();
  const kind = deriveEntryKind(entry);
  if (market === "DE") return true;
  if (kind !== "meal" && !/^\d/.test(recipe)) return true;
  if (market === "DKSE") return /^6\d*/.test(recipe);
  return /^7\d*/.test(recipe);
}

export function filterPoolForV2Market(entries: RackEntry[], market: RackV2MarketId): RackEntry[] {
  return entries.filter(entry => rackV2EntryBelongsToMarket(entry, market));
}

async function fetchAsFile(url: string): Promise<File> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} fuer ${url}`);
  const blob = await response.blob();
  return new File([blob], url.split("/").pop() ?? "MultiLine.xlsx", { type: blob.type });
}

export function slimEntries(entries: RackEntry[]): StoredEntry[] {
  return entries.map(({ id: _id, ...rest }) => rest);
}

export function restoreEntries(rows: StoredEntry[] | undefined, lineId: string): RackEntry[] {
  if (!rows) return [];
  return rows.map((entry, index) => ({
    ...entry,
    id: `${lineId}:${entry.recipe}:${entry.flowRackPosition}:${entry.tier ?? 0}:${index}`,
  }));
}

export function defaultLinePlanState(line: RackV2Line): LinePlanState {
  return {
    market: line.defaultMarket,
    entries: [],
    plannedWorkers: rackV2HallLayoutWorkers(line.defaultMarket),
    manualOverrides: {},
    releaseStatus: "draft",
  };
}

export function defaultSharedPlanState(): SharedPlanState {
  return {
    lines: Object.fromEntries(RACK_V2_LINES.map(line => [line.id, defaultLinePlanState(line)])) as Record<string, LinePlanState>,
  };
}

export function buildWeekSeedPlan(pool: EntriesByDataMarket): SharedPlanState {
  return {
    lines: Object.fromEntries(
      RACK_V2_LINES.map(line => {
        const market = line.defaultMarket;
        const dataPool = filterPoolForV2Market(pool[RACK_V2_MARKET_TO_DATA[market]] ?? [], market);
        return [line.id, { ...defaultLinePlanState(line), market, entries: rackV2InitialLayout(dataPool, market) }];
      }),
    ) as Record<string, LinePlanState>,
  };
}

export function coerceMarket(candidate: unknown, fallback: RackV2MarketId): RackV2MarketId {
  return typeof candidate === "string" && ALL_MARKETS.includes(candidate as RackV2MarketId)
    ? candidate as RackV2MarketId
    : fallback;
}

export function coercePlannedWorkers(candidate: unknown, market: RackV2MarketId): number {
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return rackV2HallLayoutWorkers(market);
  if (market === "DE" && candidate === 11) return 9;
  if (market !== "DE" && candidate === 8) return 7;
  return Math.max(1, Math.round(candidate));
}

export function parseStoredPlan(raw: string | null): SharedPlanState | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as {
      lines?: Record<string, Omit<LinePlanState, "entries"> & { entries?: StoredEntry[] }>;
      marketByLine?: Record<string, RackV2MarketId>;
      markets?: Record<RackV2MarketId, Omit<LinePlanState, "market" | "entries"> & { entries?: StoredEntry[] }>;
    };
    if (!data || typeof data !== "object") return null;
    const base = defaultSharedPlanState();

    if (data.lines && typeof data.lines === "object") {
      for (const line of RACK_V2_LINES) {
        const row = data.lines[line.id];
        if (!row) continue;
        const market = coerceMarket(row.market, line.defaultMarket);
        base.lines[line.id] = {
          market,
          entries: restoreEntries(row.entries, line.id),
          plannedWorkers: coercePlannedWorkers(row.plannedWorkers, market),
          manualOverrides: row.manualOverrides && typeof row.manualOverrides === "object" ? row.manualOverrides : {},
          releaseStatus: row.releaseStatus === "released" || row.releaseStatus === "rework" ? row.releaseStatus : "draft",
          releasedAt: row.releasedAt,
          releasedBy: row.releasedBy,
          reworkAt: row.reworkAt,
          reworkBy: row.reworkBy,
        };
      }
      return base;
    }

    if (data.markets && typeof data.markets === "object") {
      for (const line of RACK_V2_LINES) {
        const market = coerceMarket(data.marketByLine?.[line.id], line.defaultMarket);
        const row = data.markets[market];
        base.lines[line.id] = {
          market,
          entries: restoreEntries(row?.entries, line.id),
          plannedWorkers: coercePlannedWorkers(row?.plannedWorkers, market),
          manualOverrides: row?.manualOverrides && typeof row.manualOverrides === "object" ? row.manualOverrides : {},
          releaseStatus: row?.releaseStatus === "released" || row?.releaseStatus === "rework" ? row.releaseStatus : "draft",
          releasedAt: row?.releasedAt,
          releasedBy: row?.releasedBy,
          reworkAt: row?.reworkAt,
          reworkBy: row?.reworkBy,
        };
      }
      return base;
    }

    return null;
  } catch {
    return null;
  }
}

export function serializePlanState(plan: SharedPlanState): string {
  return JSON.stringify({
    lines: Object.fromEntries(
      RACK_V2_LINES.map(line => [line.id, { ...plan.lines[line.id], entries: slimEntries(plan.lines[line.id].entries) }]),
    ),
  });
}

export async function loadV2Entries(): Promise<EntriesByDataMarket> {
  const file = await fetchAsFile(AUTO_MULTILINE_URL);
  const out: EntriesByDataMarket = { de: [], nordics: [] };
  for (const dataMarket of ["de", "nordics"] as RackMarket[]) {
    const marketLineIds = RACK_V2_LINES
      .filter(line => RACK_V2_MARKET_TO_DATA[line.defaultMarket] === dataMarket)
      .map(line => line.id);
    const parsed = await parseMultilineExcel(file, dataMarket, marketLineIds);
    out[dataMarket] = dedupePoolEntries(parsed);
  }
  return out;
}
