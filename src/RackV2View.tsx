import { useEffect, useMemo, useRef, useState } from "react";
import {
  deriveEntryKind,
  exportRackfileCsv,
  parseMultilineExcel,
  type RackEntry,
  type RackMarket,
} from "./rack";
import {
  RACK_V2_LINES,
  RACK_V2_MARKET_LABEL,
  RACK_V2_MARKET_TONE,
  RACK_V2_MARKET_TO_DATA,
  assembleRackfileFromV2,
  rackV2AutoFillLayout,
  rackV2BlockSlotsForTier,
  rackV2BlocksForMarket,
  rackV2BuildAssignment,
  rackV2DynamicRoleLabels,
  rackV2EffectivePickQuantity,
  rackV2EntryFingerprint,
  rackV2ForezoneSlotsForTier,
  rackV2ForezoneForMarket,
  rackV2HallLayoutWorkers,
  rackV2InitialLayout,
  rackV2NormalizeSlot,
  rackV2PackagingAllowedSlots,
  rackV2PackagingZoneForEntry,
  rackV2RecommendedActiveBlockIds,
  rackV2ResolveActiveBlockIds,
  rackV2SlotTier,
  rackV2SlotNumber,
  validateV2Plan,
  type RackV2ActiveOverrides,
  type RackV2Block,
  type RackV2Layouts,
  type RackV2Line,
  type RackV2MarketId,
} from "./rackV2";
import type { UiLocale } from "./i18n";
import type { CookSchedule, ProcessSpec, Recipe, WeekRecipe } from "./types";

type Props = {
  week: string;
  locale: UiLocale;
  weekRecipes?: WeekRecipe[];
  recipes?: Record<string, Recipe>;
  cookSchedules?: Record<string, CookSchedule>;
  processSpecs?: Record<string, ProcessSpec>;
};

type StoredEntry = Pick<
  RackEntry,
  "recipe" | "line" | "flowRackPosition" | "quantity" | "sku" |
  "ingredient" | "scanRegEx" | "labelPos" | "uniCode" | "displayName" |
  "gramage" | "sort" | "source" | "tier"
>;

type ReleaseStatus = "draft" | "released" | "rework";

type LinePlanState = {
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

type SharedPlanState = {
  lines: Record<string, LinePlanState>;
};

type DragPayload = {
  entryId: string;
  source: "board" | "pool";
  lineId: string;
};

type EntriesByDataMarket = Record<RackMarket, RackEntry[]>;

const AUTO_MULTILINE_URL = "/data/rack/MultiLine-latest.xlsx";
const ALL_MARKETS: RackV2MarketId[] = ["DE", "DKSE", "BENL"];

function storageKey(week: string): string {
  return `rackV2.shared.${week}.v3`;
}

function legacyStorageKey(week: string): string {
  return `rackV2.shared.${week}.v2`;
}

function weekDocId(week: string): string {
  return week.replace(/[^A-Za-z0-9_-]+/g, "-");
}

function actorName(): string {
  if (typeof window === "undefined") return "unknown";
  return window.location.hostname || "unknown";
}

function dedupePoolEntries(entries: RackEntry[]): RackEntry[] {
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

async function fetchAsFile(url: string): Promise<File> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} fuer ${url}`);
  const blob = await response.blob();
  return new File([blob], url.split("/").pop() ?? "MultiLine.xlsx", { type: blob.type });
}

async function loadV2Entries(): Promise<EntriesByDataMarket> {
  const file = await fetchAsFile(AUTO_MULTILINE_URL);
  const out: EntriesByDataMarket = { de: [], nordics: [] };
  for (const dataMarket of ["de", "nordics"] as RackMarket[]) {
    const marketLineIds = RACK_V2_LINES
      .filter((line) => RACK_V2_MARKET_TO_DATA[line.defaultMarket] === dataMarket)
      .map((line) => line.id);
    const parsed = await parseMultilineExcel(file, dataMarket, marketLineIds);
    out[dataMarket] = dedupePoolEntries(parsed);
  }
  return out;
}

function slimEntries(entries: RackEntry[]): StoredEntry[] {
  return entries.map(({ id: _id, ...rest }) => rest);
}

function restoreEntries(rows: StoredEntry[] | undefined, lineId: string): RackEntry[] {
  if (!rows) return [];
  return rows.map((entry, index) => ({
    ...entry,
    id: `${lineId}:${entry.recipe}:${entry.flowRackPosition}:${entry.tier ?? 0}:${index}`,
  }));
}

function defaultLinePlanState(line: RackV2Line): LinePlanState {
  return {
    market: line.defaultMarket,
    entries: [],
    plannedWorkers: rackV2HallLayoutWorkers(line.defaultMarket),
    manualOverrides: {},
    releaseStatus: "draft",
  };
}

function defaultSharedPlanState(): SharedPlanState {
  return {
    lines: Object.fromEntries(RACK_V2_LINES.map((line) => [line.id, defaultLinePlanState(line)])) as Record<string, LinePlanState>,
  };
}

function buildWeekSeedPlan(pool: EntriesByDataMarket): SharedPlanState {
  return {
    lines: Object.fromEntries(
      RACK_V2_LINES.map((line) => {
        const market = line.defaultMarket;
        const dataPool = pool[RACK_V2_MARKET_TO_DATA[market]] ?? [];
        return [line.id, {
          ...defaultLinePlanState(line),
          market,
          entries: rackV2InitialLayout(dataPool, market),
        }];
      }),
    ) as Record<string, LinePlanState>,
  };
}

function coerceMarket(candidate: unknown, fallback: RackV2MarketId): RackV2MarketId {
  return typeof candidate === "string" && ALL_MARKETS.includes(candidate as RackV2MarketId)
    ? candidate as RackV2MarketId
    : fallback;
}

function parseStoredPlan(raw: string | null): SharedPlanState | null {
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
          plannedWorkers: typeof row.plannedWorkers === "number" ? row.plannedWorkers : rackV2HallLayoutWorkers(market),
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
          plannedWorkers: typeof row?.plannedWorkers === "number" ? row.plannedWorkers : rackV2HallLayoutWorkers(market),
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

function serializePlanState(plan: SharedPlanState): string {
  return JSON.stringify({
    lines: Object.fromEntries(
      RACK_V2_LINES.map((line) => [line.id, {
        ...plan.lines[line.id],
        entries: slimEntries(plan.lines[line.id].entries),
      }]),
    ),
  });
}

function marketChipTone(market: RackV2MarketId, active: boolean): string {
  if (!active) return "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50";
  if (market === "DE") return "bg-emerald-600 text-white ring-emerald-700";
  if (market === "DKSE") return "bg-sky-600 text-white ring-sky-700";
  return "bg-orange-600 text-white ring-orange-700";
}

function kindDot(entry: RackEntry): string {
  switch (deriveEntryKind(entry)) {
    case "meal":
      return "bg-emerald-500";
    case "ice":
      return "bg-cyan-500";
    case "loyalty":
      return "bg-amber-500";
    case "beverage":
      return "bg-fuchsia-500";
    case "protein":
      return "bg-rose-500";
    case "packaging":
      return "bg-slate-500";
    default:
      return "bg-violet-500";
  }
}

function tierTone(tier: 1 | 2 | 3): string {
  if (tier === 2) return "bg-emerald-50 text-emerald-900 ring-emerald-200";
  if (tier === 1) return "bg-amber-50 text-amber-900 ring-amber-200";
  return "bg-slate-100 text-slate-700 ring-slate-300";
}

function blockTone(active: boolean, recommended: boolean, area: string): string {
  if (!active && !recommended) return "bg-slate-50 text-slate-400 ring-slate-200";
  if (!active && recommended) return "bg-rose-50 text-rose-800 ring-rose-200";
  if (area === "gifts") return "bg-amber-50 text-amber-900 ring-amber-200";
  return "bg-sky-50 text-sky-900 ring-sky-200";
}

function isPackagingLike(entry: RackEntry): boolean {
  return deriveEntryKind(entry) === "packaging";
}

function buildBoardKey(slot: number, tier: 1 | 2 | 3): string {
  return `${slot}:${tier}`;
}

export function RackV2View({ week, locale, weekRecipes, recipes, cookSchedules, processSpecs }: Props) {
  const initialStored = typeof window === "undefined"
    ? null
    : parseStoredPlan(localStorage.getItem(storageKey(week))) ?? parseStoredPlan(localStorage.getItem(legacyStorageKey(week)));
  const [pool, setPool] = useState<EntriesByDataMarket>({ de: [], nordics: [] });
  const [sharedPlan, setSharedPlan] = useState<SharedPlanState>(() => initialStored ?? defaultSharedPlanState());
  const [editorLineId, setEditorLineId] = useState<string>(RACK_V2_LINES[0]?.id ?? "ASL1");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingPool, setLoadingPool] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"local" | "shared" | "saving">("local");
  const [hint, setHint] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyingRemoteRef = useRef(false);
  const lastRemoteSerializedRef = useRef<string>("");
  const firestoreAvailableRef = useRef(false);
  const hydratedWeekRef = useRef<string | null>(null);

  useEffect(() => {
    const poolReady = pool.de.length > 0 || pool.nordics.length > 0;
    const currentEmpty = RACK_V2_LINES.every((line) => (sharedPlan.lines[line.id]?.entries.length ?? 0) === 0);
    if (hydratedWeekRef.current === week && !(poolReady && currentEmpty)) return;

    const stored = typeof window === "undefined"
      ? null
      : parseStoredPlan(localStorage.getItem(storageKey(week))) ?? parseStoredPlan(localStorage.getItem(legacyStorageKey(week)));
    const nextPlan = stored ?? (poolReady ? buildWeekSeedPlan(pool) : defaultSharedPlanState());

    applyingRemoteRef.current = true;
    hydratedWeekRef.current = week;
    lastRemoteSerializedRef.current = stored ? serializePlanState(stored) : "";
    setSharedPlan(nextPlan);
    setEditorLineId(RACK_V2_LINES[0]?.id ?? "ASL1");
    setSelectedEntryId(null);
    setHint(null);
    setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 0);
  }, [pool, sharedPlan.lines, week]);

  useEffect(() => {
    if (hydratedWeekRef.current !== week) return;
    localStorage.setItem(storageKey(week), serializePlanState(sharedPlan));
  }, [sharedPlan, week]);

  useEffect(() => {
    let cancelled = false;
    setLoadingPool(true);
    setLoadError(null);
    loadV2Entries()
      .then((rows) => {
        if (cancelled) return;
        setPool(rows);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingPool(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSelectedEntryId(null);
    setHint(null);
  }, [editorLineId]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    (async () => {
      try {
        const [{ getFirebase }, fs] = await Promise.all([
          import("./firebase"),
          import("firebase/firestore"),
        ]);
        if (cancelled) return;
        firestoreAvailableRef.current = true;
        setSyncStatus("shared");
        const { db } = getFirebase();
        const ref = fs.doc(db, "apps", "rezeptlogik", "rackV2Plans", weekDocId(week));
        unsubscribe = fs.onSnapshot(ref, (snap) => {
          if (cancelled || !snap.exists()) return;
          const next = parseStoredPlan(JSON.stringify(snap.data()));
          if (!next) return;
          const serialized = serializePlanState(next);
          lastRemoteSerializedRef.current = serialized;
          applyingRemoteRef.current = true;
          setSharedPlan(next);
          setTimeout(() => {
            applyingRemoteRef.current = false;
          }, 0);
        });
      } catch {
        firestoreAvailableRef.current = false;
        setSyncStatus("local");
      }
    })();
    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [week]);

  useEffect(() => {
    if (!firestoreAvailableRef.current) return;
    if (applyingRemoteRef.current) return;
    const serialized = serializePlanState(sharedPlan);
    if (serialized === lastRemoteSerializedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSyncStatus("saving");
    saveTimerRef.current = setTimeout(() => {
      (async () => {
        try {
          const [{ getFirebase }, fs] = await Promise.all([
            import("./firebase"),
            import("firebase/firestore"),
          ]);
          const { db } = getFirebase();
          const ref = fs.doc(db, "apps", "rezeptlogik", "rackV2Plans", weekDocId(week));
          const payload = JSON.parse(serialized);
          await fs.setDoc(ref, {
            week,
            updatedAt: fs.serverTimestamp(),
            updatedBy: actorName(),
            ...payload,
          }, { merge: false });
          lastRemoteSerializedRef.current = serialized;
          setSyncStatus("shared");
        } catch {
          setSyncStatus("local");
        }
      })();
    }, 450);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [sharedPlan, week]);

  const weekRecipeMap = useMemo(() => {
    const map = new Map<string, WeekRecipe>();
    for (const recipe of weekRecipes ?? []) {
      if (recipe.hfWeek !== week) continue;
      map.set(recipe.code, recipe);
    }
    return map;
  }, [week, weekRecipes]);

  const assignments = useMemo(() => {
    return RACK_V2_LINES.map((line) => rackV2BuildAssignment(line, sharedPlan.lines[line.id]?.market ?? line.defaultMarket));
  }, [sharedPlan.lines]);

  const layoutsByLine = useMemo(() => {
    return Object.fromEntries(RACK_V2_LINES.map((line) => [line.id, sharedPlan.lines[line.id]?.entries ?? []])) as RackV2Layouts;
  }, [sharedPlan.lines]);

  const activeBlockIdsByLine = useMemo(() => {
    return Object.fromEntries(
      RACK_V2_LINES.map((line) => {
        const plan = sharedPlan.lines[line.id] ?? defaultLinePlanState(line);
        return [line.id, rackV2ResolveActiveBlockIds(plan.market, plan.plannedWorkers, plan.manualOverrides)];
      }),
    ) as Record<string, string[]>;
  }, [sharedPlan.lines]);

  const roleLabelsByLine = useMemo(() => {
    return Object.fromEntries(
      RACK_V2_LINES.map((line) => {
        const plan = sharedPlan.lines[line.id] ?? defaultLinePlanState(line);
        return [line.id, rackV2DynamicRoleLabels(activeBlockIdsByLine[line.id] ?? [], plan.market)];
      }),
    ) as Record<string, Record<string, string>>;
  }, [activeBlockIdsByLine, sharedPlan.lines]);

  const validation = useMemo(() => validateV2Plan(assignments, layoutsByLine), [assignments, layoutsByLine]);
  const rackfileEntries = useMemo(() => assembleRackfileFromV2(assignments, layoutsByLine), [assignments, layoutsByLine]);

  const currentLine = useMemo(() => RACK_V2_LINES.find((line) => line.id === editorLineId) ?? RACK_V2_LINES[0], [editorLineId]);
  const currentLinePlan = sharedPlan.lines[currentLine.id] ?? defaultLinePlanState(currentLine);
  const currentMarket = currentLinePlan.market;
  const currentBlocks = rackV2BlocksForMarket(currentMarket);
  const currentForezone = rackV2ForezoneForMarket(currentMarket);
  const currentActiveBlockIds = new Set(activeBlockIdsByLine[currentLine.id] ?? []);
  const currentRecommendedIds = new Set(rackV2RecommendedActiveBlockIds(currentMarket, currentLinePlan.plannedWorkers));
  const currentRoleLabels = roleLabelsByLine[currentLine.id] ?? {};
  const currentEntries = currentLinePlan.entries;
  const currentDataPool = useMemo(() => pool[RACK_V2_MARKET_TO_DATA[currentMarket]] ?? [], [pool, currentMarket]);
  const currentLocked = currentLinePlan.releaseStatus === "released";

  const boardByCell = useMemo(() => {
    const map = new Map<string, RackEntry>();
    for (const entry of currentEntries) {
      const slot = rackV2SlotNumber(entry.flowRackPosition);
      const tier = (entry.tier ?? 1) as 1 | 2 | 3;
      if (!Number.isFinite(slot)) continue;
      map.set(buildBoardKey(slot, tier), entry);
    }
    return map;
  }, [currentEntries]);

  const usedFingerprints = useMemo(() => new Set(currentEntries.map(rackV2EntryFingerprint)), [currentEntries]);

  const poolEntries = useMemo(() => {
    const term = search.trim().toLowerCase();
    return currentDataPool
      .filter((entry) => !usedFingerprints.has(rackV2EntryFingerprint(entry)))
      .filter((entry) => {
        if (!term) return true;
        const hay = `${entry.recipe} ${entry.sku} ${entry.ingredient} ${entry.displayName}`.toLowerCase();
        return hay.includes(term);
      })
      .sort((left, right) => (right.quantity ?? 0) - (left.quantity ?? 0));
  }, [currentDataPool, search, usedFingerprints]);

  const selectedEntry = useMemo(() => currentEntries.find((entry) => entry.id === selectedEntryId) ?? null, [currentEntries, selectedEntryId]);

  function setLinePlan(lineId: string, updater: (plan: LinePlanState) => LinePlanState) {
    const line = RACK_V2_LINES.find((candidate) => candidate.id === lineId);
    if (!line) return;
    setSharedPlan((prev) => ({
      ...prev,
      lines: {
        ...prev.lines,
        [lineId]: updater(prev.lines[lineId] ?? defaultLinePlanState(line)),
      },
    }));
  }

  function setLineMarket(lineId: string, market: RackV2MarketId) {
    const line = RACK_V2_LINES.find((candidate) => candidate.id === lineId);
    if (!line) return;
    const existing = sharedPlan.lines[lineId] ?? defaultLinePlanState(line);
    if (existing.releaseStatus === "released") return;
    const dataPool = pool[RACK_V2_MARKET_TO_DATA[market]] ?? [];
    setSharedPlan((prev) => ({
      ...prev,
      lines: {
        ...prev.lines,
        [lineId]: {
          market,
          entries: rackV2InitialLayout(dataPool, market),
          plannedWorkers: rackV2HallLayoutWorkers(market),
          manualOverrides: {},
          releaseStatus: existing.releaseStatus === "rework" ? "rework" : "draft",
          releasedAt: undefined,
          releasedBy: undefined,
          reworkAt: existing.releaseStatus === "rework" ? existing.reworkAt : undefined,
          reworkBy: existing.releaseStatus === "rework" ? existing.reworkBy : undefined,
        },
      },
    }));
  }

  function updatePlannedWorkers(delta: number) {
    if (currentLocked) return;
    setLinePlan(currentLine.id, (plan) => ({
      ...plan,
      plannedWorkers: Math.max(1, Math.round(plan.plannedWorkers + delta)),
    }));
  }

  function setPlannedWorkers(value: number) {
    if (currentLocked || !Number.isFinite(value)) return;
    setLinePlan(currentLine.id, (plan) => ({
      ...plan,
      plannedWorkers: Math.max(1, Math.round(value)),
    }));
  }

  function toggleBlock(block: RackV2Block) {
    if (currentLocked) return;
    const recommended = currentRecommendedIds.has(block.id);
    const active = currentActiveBlockIds.has(block.id);
    const desired = !active;
    setLinePlan(currentLine.id, (plan) => {
      const nextOverrides = { ...plan.manualOverrides };
      if (desired === recommended) delete nextOverrides[block.id];
      else nextOverrides[block.id] = desired;
      return { ...plan, manualOverrides: nextOverrides };
    });
  }

  function canPlaceEntry(entry: RackEntry, slot: number, tier: 1 | 2 | 3): string | null {
    const block = currentBlocks.find((candidate) => slot >= candidate.minSlot && slot <= candidate.maxSlot);
    const inForezone = currentForezone.some((zone) => slot >= zone.minSlot && slot <= zone.maxSlot);
    const expectedTier = rackV2SlotTier(slot, currentMarket);
    if (!block && !inForezone) return "Slot liegt ausserhalb des Hallenbilds.";
    if (inForezone && !isPackagingLike(entry)) return "In der Vorzone darf nur Packaging liegen.";
    if (block && isPackagingLike(entry)) return "Packaging darf nur in der Vorzone liegen.";
    if (expectedTier && tier !== expectedTier) return `F${slot} liegt fest auf Ebene ${expectedTier}.`;
    if (inForezone && isPackagingLike(entry)) {
      const packagingZone = rackV2PackagingZoneForEntry(entry);
        const allowedSlots = rackV2PackagingAllowedSlots(currentMarket, packagingZone);
        if (allowedSlots.length === 0) {
          if (packagingZone === "liner") return "Liner sind bei diesem Markt nicht erlaubt (nur DE).";
          return "Dieser Packaging-Typ ist auf diesem Markt nicht erlaubt.";
        }
        if (!allowedSlots.includes(slot)) {
          if (packagingZone === "box") return "Kartons duerfen nur auf die vorgesehenen Packaging-Faecher.";
          if (packagingZone === "liner") return "Liner duerfen nur auf die vorgesehenen Packaging-Faecher.";
          return "Packaging passt nicht auf dieses Fach.";
        }
    }
    if (block && !currentActiveBlockIds.has(block.id)) return `${block.label} ist nicht aktiv.`;
    if (block && tier > block.maxTier) return `Tier ${tier} ist in ${block.label} nicht erlaubt.`;
    return null;
  }

  function writeEntry(entry: RackEntry, slot: number, tier: 1 | 2 | 3) {
    if (currentLocked) return;
    const error = canPlaceEntry(entry, slot, tier);
    if (error) {
      setHint(error);
      return;
    }
    setLinePlan(currentLine.id, (plan) => {
      const nextEntries = plan.entries.filter((candidate) => {
        const candidateSlot = rackV2SlotNumber(candidate.flowRackPosition);
        const candidateTier = (candidate.tier ?? 1) as 1 | 2 | 3;
        if (candidate.id === entry.id) return false;
        return buildBoardKey(candidateSlot, candidateTier) !== buildBoardKey(slot, tier);
      });
      nextEntries.push({
        ...entry,
        flowRackPosition: rackV2NormalizeSlot(slot),
        tier,
        sort: slot,
        quantity: rackV2EffectivePickQuantity(entry),
        line: "",
      });
      return { ...plan, entries: nextEntries };
    });
    setSelectedEntryId(entry.id);
    setHint(null);
  }

  function removeEntry(entryId: string) {
    if (currentLocked) return;
    setLinePlan(currentLine.id, (plan) => ({
      ...plan,
      entries: plan.entries.filter((entry) => entry.id !== entryId),
    }));
    if (selectedEntryId === entryId) setSelectedEntryId(null);
  }

  function dropToPool() {
    if (currentLocked || !dragPayload || dragPayload.lineId !== currentLine.id || dragPayload.source !== "board") return;
    removeEntry(dragPayload.entryId);
    setDragPayload(null);
    setHint("Eintrag in die Ablage zurueckgelegt.");
  }

  function autoFillLine() {
    if (currentLocked) return;
    setLinePlan(currentLine.id, (plan) => ({
      ...plan,
      entries: rackV2AutoFillLayout(
        plan.entries,
        currentDataPool,
        currentMarket,
        Object.fromEntries(rackV2BlocksForMarket(currentMarket).map((block) => [block.id, currentActiveBlockIds.has(block.id)])),
      ),
    }));
  }

  function resetLine() {
    if (currentLocked) return;
    setLinePlan(currentLine.id, (plan) => ({
      ...plan,
      entries: rackV2InitialLayout(currentDataPool, currentMarket),
      manualOverrides: {},
      plannedWorkers: rackV2HallLayoutWorkers(currentMarket),
      releaseStatus: plan.releaseStatus === "rework" ? "rework" : "draft",
    }));
  }

  async function releaseLine() {
    if (currentLocked) return;
    const releasedAt = Date.now();
    const releasedBy = actorName();
    setLinePlan(currentLine.id, (plan) => {
      const nextPlan: LinePlanState = {
        ...plan,
        releaseStatus: "released",
        releasedAt,
        releasedBy,
      };
      delete nextPlan.reworkAt;
      delete nextPlan.reworkBy;
      return nextPlan;
    });
    try {
      const [{ getFirebase }, fs] = await Promise.all([
        import("./firebase"),
        import("firebase/firestore"),
      ]);
      const { db } = getFirebase();
      await fs.addDoc(fs.collection(db, "apps", "rezeptlogik", "rackV2PlanHistory"), {
        week,
        lineId: currentLine.id,
        lineCode: currentLine.code,
        market: currentMarket,
        releasedAt,
        releasedBy,
        plannedWorkers: currentLinePlan.plannedWorkers,
        entryCount: currentEntries.length,
      });
    } catch {
      // shared doc bleibt die Hauptquelle; History ist optional
    }
  }

  function openRework() {
    if (currentLinePlan.releaseStatus !== "released") return;
    setLinePlan(currentLine.id, (plan) => ({
      ...plan,
      releaseStatus: "rework",
      reworkAt: Date.now(),
      reworkBy: actorName(),
    }));
  }

  function downloadLineRackfile(lineId: string) {
    const line = RACK_V2_LINES.find((candidate) => candidate.id === lineId);
    if (!line) return;
    const linePlan = sharedPlan.lines[line.id] ?? defaultLinePlanState(line);
    if (linePlan.releaseStatus !== "released") {
      setEditorLineId(line.id);
      setHint("Rackfile CSV ist erst nach Freigabe dieser Linie verfuegbar.");
      return;
    }
    const assignment = rackV2BuildAssignment(line, linePlan.market);
    const csv = exportRackfileCsv(assembleRackfileFromV2([assignment], { [line.id]: linePlan.entries }));
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `Rackfile_${line.code}_KW${week}_${linePlan.market}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const totalErrors = validation.perLine.reduce((sum, line) => sum + line.issues.filter((issue) => issue.severity === "error").length, 0)
    + validation.global.filter((issue) => issue.severity === "error").length;

  return (
    <div className="space-y-5">
      <header className="card p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Rack v2</div>
            <h2 className="text-2xl font-black tracking-tight text-slate-900">KW {week} Hallenbild</h2>
            <p className="mt-1 text-sm text-slate-600">
              Alle sechs Linien separat planbar, inklusive DE, DKSE und BENL, mit geteilter Speicherung und Release-Workflow.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-300 font-semibold">
              Sprache: {locale.toUpperCase()}
            </span>
            <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-300 font-semibold">
              Sync: {syncStatus === "shared" ? "geteilt" : syncStatus === "saving" ? "speichert" : "lokal"}
            </span>
            <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-300 font-semibold">
              {rackfileEntries.length} Rackfile-Eintraege
            </span>
            {totalErrors > 0 && (
              <span className="rounded-full bg-rose-100 px-3 py-1 text-rose-800 ring-1 ring-rose-300 font-semibold">
                {totalErrors} Fehler
              </span>
            )}
          </div>
        </div>
        {loadError && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-900 ring-1 ring-rose-200">{loadError}</div>}
        {loadingPool && <div className="rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-sky-200">MultiLine wird geladen...</div>}
      </header>

      <section className="card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-bold text-slate-800">Linienplanung</div>
          <div className="text-[11px] text-slate-500">Jede Linie hat eigenes Layout, eigene MA, eigene Freigabe.</div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {RACK_V2_LINES.map((line) => {
            const plan = sharedPlan.lines[line.id] ?? defaultLinePlanState(line);
            const active = editorLineId === line.id;
            const isLocked = plan.releaseStatus === "released";
            return (
              <div
                key={line.id}
                onClick={() => setEditorLineId(line.id)}
                className={`rounded-xl p-3 text-left ring-1 transition cursor-pointer ${active ? `${RACK_V2_MARKET_TONE[plan.market]} shadow-sm` : "bg-white text-slate-800 ring-slate-200 hover:bg-slate-50"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-black">{line.code}</div>
                    <div className="text-[10px] opacity-70">Default {line.defaultMarket}</div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${isLocked ? "bg-slate-900 text-white ring-slate-700" : plan.releaseStatus === "rework" ? "bg-amber-100 text-amber-900 ring-amber-300" : "bg-white text-slate-600 ring-slate-300"}`}>
                    {plan.releaseStatus === "released" ? "freigegeben" : plan.releaseStatus === "rework" ? "Nacharbeit" : "Draft"}
                  </span>
                </div>
                <div className="mt-2 flex gap-1">
                  {ALL_MARKETS.map((candidate) => (
                    <span
                      key={candidate}
                      onClick={(event) => {
                        event.stopPropagation();
                        setLineMarket(line.id, candidate);
                      }}
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${marketChipTone(candidate, candidate === plan.market)} ${isLocked ? "opacity-50" : "cursor-pointer"}`}
                    >
                      {candidate}
                    </span>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-slate-600">
                  <span>{RACK_V2_MARKET_LABEL[plan.market]}</span>
                  <span>{plan.entries.length} Slots</span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-500">CSV je Linie, Upload einzeln</span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      downloadLineRackfile(line.id);
                    }}
                    disabled={plan.releaseStatus !== "released"}
                    className="rounded-full bg-slate-900 px-3 py-1 text-[11px] font-semibold text-white ring-1 ring-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-600 disabled:ring-slate-300"
                  >
                    Rackfile CSV
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="card p-4 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-slate-800">Editor {currentLine.code}</div>
              <div className="text-[11px] text-slate-500">
                {RACK_V2_MARKET_LABEL[currentMarket]} · Hallenbild {rackV2HallLayoutWorkers(currentMarket)} MA · {currentBlocks.length} Bloecke
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className={`rounded-full px-3 py-1 ring-1 font-semibold ${currentLocked ? "bg-slate-900 text-white ring-slate-700" : currentLinePlan.releaseStatus === "rework" ? "bg-amber-100 text-amber-900 ring-amber-300" : "bg-white text-slate-700 ring-slate-300"}`}>
                {currentLinePlan.releaseStatus === "released" ? "freigegeben" : currentLinePlan.releaseStatus === "rework" ? "Nacharbeit" : "Draft"}
              </span>
              <button type="button" onClick={autoFillLine} disabled={currentLocked} className="btn disabled:opacity-50">
                Automatik
              </button>
              <button type="button" onClick={resetLine} disabled={currentLocked} className="btn disabled:opacity-50">
                Zuruecksetzen
              </button>
              <button type="button" onClick={releaseLine} disabled={currentLocked} className="btn disabled:opacity-50">
                Plan freigeben
              </button>
              <button type="button" onClick={() => downloadLineRackfile(currentLine.id)} disabled={!currentLocked} className="btn disabled:opacity-50">
                Rackfile CSV
              </button>
              <button type="button" onClick={openRework} className="btn">
                Nacharbeit oeffnen
              </button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Geplante MA</div>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={() => updatePlannedWorkers(-1)} disabled={currentLocked} className="rounded-full bg-white px-2 py-1 ring-1 ring-slate-300 disabled:opacity-50">-1</button>
                <input
                  type="number"
                  value={currentLinePlan.plannedWorkers}
                  onChange={(event) => setPlannedWorkers(Number(event.target.value))}
                  disabled={currentLocked}
                  className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm font-semibold"
                />
                <button type="button" onClick={() => updatePlannedWorkers(1)} disabled={currentLocked} className="rounded-full bg-white px-2 py-1 ring-1 ring-slate-300 disabled:opacity-50">+1</button>
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Empfohlen aktiv</div>
              <div className="mt-2 text-lg font-black text-slate-900">{currentRecommendedIds.size}</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Aktiv real</div>
              <div className="mt-2 text-lg font-black text-slate-900">{currentActiveBlockIds.size}</div>
            </div>
            <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Eintraege</div>
              <div className="mt-2 text-lg font-black text-slate-900">{currentEntries.length}</div>
            </div>
          </div>

          <div className="rounded-xl bg-amber-50 p-3 text-[11px] text-amber-900 ring-1 ring-amber-200">
            Alle Bloecke bleiben testweise schaltbar. Die aktive Reihenfolge bildet automatisch P1, P2, P3 ... und laeuft je Linie separat.
          </div>

          <div className="space-y-3">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Vorzone</div>
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {currentForezone.map((zone) => (
                  <div key={zone.id} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
                    <div className="text-sm font-black text-slate-900">{zone.label}</div>
                    <div className="text-[11px] text-slate-500">{zone.subtitle} · F{zone.minSlot}-F{zone.maxSlot}</div>
                    <div className="mt-2 space-y-1">
                      {[2, 1].filter((tier) => rackV2ForezoneSlotsForTier(zone, tier as 1 | 2).length > 0).map((tierValue) => {
                        const tier = tierValue as 1 | 2;
                        const slots = rackV2ForezoneSlotsForTier(zone, tier);
                        return (
                          <div key={`${zone.id}-${tier}`} className={`rounded-md p-2 ring-1 ${tierTone(tier === 1 ? 1 : 2)}`}>
                            <div className="mb-1 text-[10px] font-bold">Tier {tier}</div>
                            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.max(slots.length, 1)}, minmax(0, 1fr))` }}>
                              {slots.map((slot) => {
                                const entry = boardByCell.get(buildBoardKey(slot, tier as 1 | 2 | 3));
                                return (
                                  <div
                                    key={`forezone-${slot}-${tier}`}
                                    onDragOver={(event) => {
                                      if (currentLocked) return;
                                      event.preventDefault();
                                    }}
                                    onDrop={(event) => {
                                      if (currentLocked) return;
                                      event.preventDefault();
                                      if (!dragPayload) return;
                                      const source = dragPayload.source === "board"
                                        ? currentEntries.find((candidate) => candidate.id === dragPayload.entryId)
                                        : poolEntries.find((candidate) => candidate.id === dragPayload.entryId);
                                      if (!source) return;
                                      writeEntry(source, slot, tier as 1 | 2 | 3);
                                      setDragPayload(null);
                                    }}
                                    className="min-h-[48px] rounded-md border border-dashed border-slate-300 bg-white px-1 py-1"
                                  >
                                    {entry ? (
                                      <button
                                        type="button"
                                        draggable={!currentLocked}
                                        onDragStart={() => setDragPayload({ entryId: entry.id, source: "board", lineId: currentLine.id })}
                                        onClick={() => setSelectedEntryId(entry.id)}
                                        className="w-full text-left"
                                      >
                                        <div className="flex items-center gap-1 text-[10px] font-bold">
                                          <span className={`h-2 w-2 rounded-full ${kindDot(entry)}`} />
                                          <span className="truncate">{entry.recipe}</span>
                                        </div>
                                        <div className="truncate text-[9px] text-slate-500">{entry.sku || entry.ingredient || "-"}</div>
                                      </button>
                                    ) : (
                                      <div className="text-[9px] text-slate-400">{rackV2NormalizeSlot(slot)}</div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Bloecke hinter der Vorzone</div>
              <div className="mt-2 flex gap-3 overflow-x-auto pb-2">
                {currentBlocks.map((block) => {
                  const active = currentActiveBlockIds.has(block.id);
                  const recommended = currentRecommendedIds.has(block.id);
                  const roleLabel = currentRoleLabels[block.id];
                  return (
                    <div key={block.id} className="flex items-stretch gap-3">
                      {block.wallBefore && <div className="w-3 rounded-full bg-slate-900/80" />}
                      <div className={`min-w-[250px] rounded-2xl p-3 ring-1 ${blockTone(active, recommended, block.area)}`}>
                        <button type="button" onClick={() => toggleBlock(block)} disabled={currentLocked} className="w-full text-left disabled:opacity-60">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="text-[10px] font-bold uppercase tracking-wide opacity-70">{block.label}</div>
                              <div className="text-sm font-black">{active ? roleLabel : "nicht aktiv"}</div>
                            </div>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${active ? "bg-white/70 ring-current" : "bg-slate-100 text-slate-500 ring-slate-300"}`}>
                              {active ? "aktiv" : "aus"}
                            </span>
                          </div>
                          <div className="mt-1 text-[11px] opacity-80">{block.subtitle}</div>
                        </button>
                        <div className="mt-2 text-[10px] text-slate-500">Empfehlung: {recommended ? "ein" : "aus"}</div>
                        <div className="mt-3 space-y-1">
                          {[3, 2, 1].filter((t) => t <= block.maxTier).map((tierValue) => {
                            const tier = tierValue as 1 | 2 | 3;
                            const blockSlots = rackV2BlockSlotsForTier(block, tier);
                            return (
                              <div key={`${block.id}-${tier}`} className={`rounded-md p-2 ring-1 ${tierTone(tier)}`}>
                                <div className="mb-1 text-[10px] font-bold">Tier {tier}</div>
                                <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.max(blockSlots.length, 1)}, minmax(0, 1fr))` }}>
                                  {blockSlots.map((slot) => {
                                    const entry = boardByCell.get(buildBoardKey(slot, tier));
                                    return (
                                      <div
                                        key={`${block.id}-${slot}-${tier}`}
                                        onDragOver={(event) => {
                                          if (currentLocked) return;
                                          event.preventDefault();
                                        }}
                                        onDrop={(event) => {
                                          if (currentLocked) return;
                                          event.preventDefault();
                                          if (!dragPayload) return;
                                          const source = dragPayload.source === "board"
                                            ? currentEntries.find((candidate) => candidate.id === dragPayload.entryId)
                                            : poolEntries.find((candidate) => candidate.id === dragPayload.entryId);
                                          if (!source) return;
                                          writeEntry(source, slot, tier);
                                          setDragPayload(null);
                                        }}
                                        className="min-h-[48px] rounded-md border border-dashed border-slate-300 bg-white px-1 py-1"
                                      >
                                        {entry ? (
                                          <button
                                            type="button"
                                            draggable={!currentLocked}
                                            onDragStart={() => setDragPayload({ entryId: entry.id, source: "board", lineId: currentLine.id })}
                                            onClick={() => setSelectedEntryId(entry.id)}
                                            className="w-full text-left"
                                          >
                                            <div className="flex items-center gap-1 text-[10px] font-bold">
                                              <span className={`h-2 w-2 rounded-full ${kindDot(entry)}`} />
                                              <span className="truncate">{entry.recipe}</span>
                                            </div>
                                            <div className="truncate text-[9px] text-slate-500">{entry.sku || entry.ingredient || "-"}</div>
                                          </button>
                                        ) : (
                                          <div className="text-[9px] text-slate-400">{rackV2NormalizeSlot(slot)}</div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div
            className="card p-3"
            onDragOver={(event) => {
              if (currentLocked) return;
              event.preventDefault();
            }}
            onDrop={(event) => {
              if (currentLocked) return;
              event.preventDefault();
              dropToPool();
            }}
          >
            <div className="text-sm font-bold text-slate-800">Ablage</div>
            <div className="mt-1 text-[11px] text-slate-600">Gezogene Board-Eintraege hier ablegen, um sie wieder aus dem Hallenbild der aktuellen Linie zu nehmen.</div>
            {hint && <div className="mt-3 rounded-md bg-sky-50 px-2 py-1 text-[11px] text-sky-900 ring-1 ring-sky-200">{hint}</div>}
          </div>

          <div className="card p-3 space-y-2">
            <div className="text-sm font-bold text-slate-800">Offener Pool {currentLine.code}</div>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Recipe, SKU, Ingredient"
              className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
            />
            <div className="max-h-[420px] overflow-auto space-y-1">
              {poolEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  draggable={!currentLocked}
                  onDragStart={() => setDragPayload({ entryId: entry.id, source: "pool", lineId: currentLine.id })}
                  className="w-full rounded-md bg-white px-2 py-2 text-left ring-1 ring-slate-200"
                >
                  <div className="flex items-center gap-1 text-[11px] font-bold text-slate-900">
                    <span className={`h-2 w-2 rounded-full ${kindDot(entry)}`} />
                    <span className="truncate">{entry.recipe}</span>
                    <span className="ml-auto text-slate-500">qty {entry.quantity}</span>
                  </div>
                  <div className="truncate text-[10px] text-slate-500">{entry.sku || entry.ingredient || "-"}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="card p-3 space-y-2">
            <div className="text-sm font-bold text-slate-800">Detail</div>
            {!selectedEntry && <div className="text-[11px] text-slate-500">Eintrag auswaehlen.</div>}
            {selectedEntry && (
              <div className="space-y-2 text-[11px] text-slate-700">
                <div><span className="font-semibold">Linie:</span> {currentLine.code}</div>
                <div><span className="font-semibold">Recipe:</span> {selectedEntry.recipe}</div>
                <div><span className="font-semibold">Slot:</span> {selectedEntry.flowRackPosition} / Tier {selectedEntry.tier ?? "-"}</div>
                <div><span className="font-semibold">SKU:</span> {selectedEntry.sku || "-"}</div>
                <div><span className="font-semibold">Ingredient:</span> {selectedEntry.ingredient || "-"}</div>
                <div><span className="font-semibold">Quantity:</span> {selectedEntry.quantity}</div>
                {weekRecipeMap.get(selectedEntry.recipe) && (
                  <div className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-900 ring-1 ring-emerald-200">
                    KW-Kontext: {weekRecipeMap.get(selectedEntry.recipe)?.recipeName}
                  </div>
                )}
                {recipes?.[selectedEntry.recipe] && (
                  <div className="rounded-md bg-slate-50 px-2 py-1 ring-1 ring-slate-200">
                    Rezeptbasis: {recipes[selectedEntry.recipe].baseName}
                  </div>
                )}
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md bg-slate-50 px-2 py-1 ring-1 ring-slate-200">Cook Schedules: {Object.keys(cookSchedules ?? {}).length}</div>
                  <div className="rounded-md bg-slate-50 px-2 py-1 ring-1 ring-slate-200">Process Specs: {Object.keys(processSpecs ?? {}).length}</div>
                </div>
                <button type="button" onClick={() => removeEntry(selectedEntry.id)} disabled={currentLocked} className="btn disabled:opacity-50">
                  Aus Board nehmen
                </button>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="card p-4 space-y-3">
        <div className="text-sm font-bold text-slate-800">Validierung</div>
        {validation.ok ? (
          <div className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">Plan ist valide.</div>
        ) : (
          <div className="space-y-2">
            {validation.perLine.filter((line) => line.issues.length > 0).map((line) => (
              <div key={line.lineId} className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-900 ring-1 ring-amber-200">
                <div className="font-semibold">{line.lineCode} · {line.market}</div>
                <ul className="mt-1 space-y-0.5">
                  {line.issues.slice(0, 4).map((issue, index) => <li key={`${line.lineId}-${index}`}>- {issue.message}</li>)}
                </ul>
              </div>
            ))}
            {validation.global.length > 0 && (
              <div className="rounded-xl bg-rose-50 px-3 py-2 text-[11px] text-rose-900 ring-1 ring-rose-200">
                <div className="font-semibold">Global</div>
                <ul className="mt-1 space-y-0.5">
                  {validation.global.slice(0, 6).map((issue, index) => <li key={`global-${index}`}>- {issue.message}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default RackV2View;