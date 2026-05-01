import { useEffect, useMemo, useState } from "react";
import { loadDynamicModule } from "./dynamicImport";
import type { UiLocale } from "./i18n";
import {
  RACK_MARKET_PROFILES,
  deriveEntryKind,
  exportRackfileCsv,
  lineSlotRange,
  parseBoxfileCsv,
  parseCo2Csv,
  parsePdlCsv,
  parseRackfileCsv,
  projectRackEntriesToLines,
  rackSummary,
  type RackBoxSnapshot,
  type RackEntry,
  type RackMarket,
  type RackValidationIssue,
  type RackValidationResult,
  uniqueRackLines,
  updateRackEntry,
  validateRackPlan,
} from "./rack";
import type { RackSlotMeta } from "./rackWorkbook";

type Props = {
  week: string;
  locale: UiLocale;
};

type LineScenario = {
  id: string;
  label: string;
  lines: string[];
  note: string;
};

type StaffingMode = "reduce" | "balanced" | "increase";

type ComparisonSnapshot = {
  label: string;
  before: RackEntry[];
  after: RackEntry[];
};

type SelectedRackFocus = {
  line: string;
  position: string;
  entryId?: string;
};

function clampRackZoom(value: number) {
  return Math.min(1.45, Math.max(0.65, Number(value.toFixed(2))));
}

const AUTO_MULTILINE_URL = "/data/rack/MultiLine-latest.xlsx";
const AUTO_PDL_URL: Record<RackMarket, string> = {
  de: "/data/gsheet-truth-export/Factor_DE - PDL Forecast.csv",
  nordics: "/data/gsheet-truth-export/Factor_Nor - PDL Forecast.csv",
};

let rackWorkbookModulePromise: Promise<typeof import("./rackWorkbook")> | null = null;

async function loadRackWorkbookModule() {
  rackWorkbookModulePromise ??= loadDynamicModule("rack-workbook", () => import("./rackWorkbook"));
  return rackWorkbookModulePromise;
}

function scenarioOptions(market: RackMarket, locale: UiLocale): LineScenario[] {
  if (market === "de") {
    return [
      {
        id: "dual",
        label: locale === "de" ? "Dual: ASL3 + ASL4" : "Dual: ASL3 + ASL4",
        lines: ["ASL3", "ASL4"],
        note: locale === "de" ? "Standardbetrieb mit beiden Linien vorbereitet." : "Prepared dual-line operation.",
      },
      {
        id: "primary-4",
        label: locale === "de" ? "Primär: nur ASL4" : "Primary: ASL4 only",
        lines: ["ASL4"],
        note: locale === "de" ? "DE läuft komplett auf ASL4." : "Run DE fully on ASL4.",
      },
      {
        id: "backup-3",
        label: locale === "de" ? "Backup: nur ASL3" : "Backup: ASL3 only",
        lines: ["ASL3"],
        note: locale === "de" ? "Schneller Fallback wenn ASL4 ausfällt." : "Fast fallback if ASL4 fails.",
      },
    ];
  }

  return [
    {
      id: "dual",
      label: locale === "de" ? "Dual: ASL1 + ASL5" : "Dual: ASL1 + ASL5",
      lines: ["ASL1", "ASL5"],
      note: locale === "de" ? "Standardbetrieb mit beiden Nordics-Linien." : "Prepared dual-line operation.",
    },
    {
      id: "primary-5",
      label: locale === "de" ? "Primär: nur ASL5" : "Primary: ASL5 only",
      lines: ["ASL5"],
      note: locale === "de" ? "Nordics läuft komplett auf ASL5." : "Run Nordics fully on ASL5.",
    },
    {
      id: "backup-1",
      label: locale === "de" ? "Backup: nur ASL1" : "Backup: ASL1 only",
      lines: ["ASL1"],
      note: locale === "de" ? "Schneller Fallback wenn ASL5 ausfällt." : "Fast fallback if ASL5 fails.",
    },
  ];
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function issueTone(severity: RackValidationResult["issues"][number]["severity"]) {
  if (severity === "error") return "bg-rose-50 text-rose-800 ring-rose-200";
  if (severity === "warning") return "bg-amber-50 text-amber-900 ring-amber-200";
  return "bg-sky-50 text-sky-800 ring-sky-200";
}

function kindTone(kind: ReturnType<typeof deriveEntryKind>) {
  switch (kind) {
    case "meal": return "bg-emerald-100 text-emerald-900 border-emerald-300";
    case "packaging": return "bg-slate-100 text-slate-900 border-slate-300";
    case "ice": return "bg-cyan-100 text-cyan-900 border-cyan-300";
    case "loyalty": return "bg-amber-100 text-amber-900 border-amber-300";
    case "beverage": return "bg-fuchsia-100 text-fuchsia-900 border-fuchsia-300";
    case "protein": return "bg-rose-100 text-rose-900 border-rose-300";
    default: return "bg-violet-100 text-violet-900 border-violet-300";
  }
}

function lineBadge(line: string) {
  const hue = line.endsWith("1") ? "bg-sky-100 text-sky-900" : line.endsWith("3") ? "bg-emerald-100 text-emerald-900" : line.endsWith("4") ? "bg-orange-100 text-orange-900" : "bg-violet-100 text-violet-900";
  return `rounded-full px-2 py-0.5 text-xs font-semibold ${hue}`;
}

function lineAccent(line: string) {
  if (line.endsWith("1")) {
    return {
      shell: "from-sky-500/18 via-cyan-500/10 to-white",
      rail: "from-sky-500 via-cyan-500 to-sky-300",
      glow: "shadow-[0_20px_60px_-28px_rgba(14,165,233,0.75)]",
      slot: "border-sky-200 bg-sky-50/80",
      slotEmpty: "border-sky-100 bg-white/70",
      chip: "bg-sky-600 text-white",
      text: "text-sky-900",
    };
  }
  if (line.endsWith("3")) {
    return {
      shell: "from-emerald-500/18 via-teal-500/10 to-white",
      rail: "from-emerald-500 via-teal-500 to-emerald-300",
      glow: "shadow-[0_20px_60px_-28px_rgba(16,185,129,0.7)]",
      slot: "border-emerald-200 bg-emerald-50/80",
      slotEmpty: "border-emerald-100 bg-white/70",
      chip: "bg-emerald-600 text-white",
      text: "text-emerald-900",
    };
  }
  if (line.endsWith("4")) {
    return {
      shell: "from-orange-500/18 via-amber-500/10 to-white",
      rail: "from-orange-500 via-amber-500 to-orange-300",
      glow: "shadow-[0_20px_60px_-28px_rgba(249,115,22,0.72)]",
      slot: "border-orange-200 bg-orange-50/80",
      slotEmpty: "border-orange-100 bg-white/70",
      chip: "bg-orange-600 text-white",
      text: "text-orange-900",
    };
  }

  return {
    shell: "from-violet-500/18 via-fuchsia-500/10 to-white",
    rail: "from-violet-500 via-fuchsia-500 to-violet-300",
    glow: "shadow-[0_20px_60px_-28px_rgba(139,92,246,0.72)]",
    slot: "border-violet-200 bg-violet-50/80",
    slotEmpty: "border-violet-100 bg-white/70",
    chip: "bg-violet-600 text-white",
    text: "text-violet-900",
  };
}

function buildSlotColumns(slots: number[], slotMeta: Map<string, RackSlotMeta>) {
  const bucket = new Map<number, Array<{ slotNumber: number; position: string; tier: 1 | 2 | 3 }>>();

  for (const slotNumber of slots) {
    const position = `F${String(slotNumber).padStart(2, "0")}`;
    const meta = slotMeta.get(position);
    const layoutColumn = meta?.layoutColumn ?? (1000 + slotNumber);
    const tier = meta?.level && meta.level >= 1 && meta.level <= 3 ? meta.level as 1 | 2 | 3 : 1;
    const rows = bucket.get(layoutColumn) ?? [];
    rows.push({ slotNumber, position, tier });
    bucket.set(layoutColumn, rows);
  }

  return [...bucket.entries()]
    .sort((a, b) => Math.min(...a[1].map((slot) => slot.slotNumber)) - Math.min(...b[1].map((slot) => slot.slotNumber)))
    .map(([, column]) => column.sort((a, b) => a.tier - b.tier || a.slotNumber - b.slotNumber));
}

function tierTone(tier: 1 | 2 | 3) {
  if (tier === 1) return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (tier === 2) return "border-sky-200 bg-sky-50 text-sky-900";
  return "border-rose-200 bg-rose-50 text-rose-900";
}

function tierLabel(tier: 1 | 2 | 3, locale: UiLocale) {
  if (locale === "de") return tier === 1 ? "Etage 1" : tier === 2 ? "Etage 2" : "Etage 3";
  return tier === 1 ? "Tier 1" : tier === 2 ? "Tier 2" : "Tier 3";
}

function moveRackEntry(entries: RackEntry[], entryId: string, line: string, flowRackPosition: string): RackEntry[] {
  return updateRackEntry(entries, entryId, { line, flowRackPosition });
}

function swapRackEntries(entries: RackEntry[], draggedEntryId: string, targetEntryId: string, line: string, flowRackPosition: string): RackEntry[] {
  const draggedEntry = entries.find((entry) => entry.id === draggedEntryId);
  const targetEntry = entries.find((entry) => entry.id === targetEntryId);
  if (!draggedEntry || !targetEntry) return entries;

  const sourceLine = draggedEntry.line;
  const sourcePosition = draggedEntry.flowRackPosition.toUpperCase();
  const targetPosition = flowRackPosition.toUpperCase();

  return entries.map((entry) => {
    if (entry.id === draggedEntryId) return updatedRackEntry(entry, line, targetPosition);
    if (entry.id === targetEntryId) return updatedRackEntry(entry, sourceLine, sourcePosition);
    return entry;
  }).sort((a, b) => a.line.localeCompare(b.line) || a.sort - b.sort || a.recipe.localeCompare(b.recipe));
}

function rackPositionNumber(position: string) {
  const match = /^F(\d+)$/i.exec(position.trim());
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function ergonomicTierRank(meta?: RackSlotMeta) {
  if (!meta) return 3;
  if (meta.preferredPick) return 0;
  if (meta.level === 1) return 1;
  if (meta.level === 3) return 2;
  return 3;
}

function stationPreferenceScore(staffingMode: StaffingMode, stationLoad: number, lineAverageLoad: number) {
  if (staffingMode === "reduce") return -(stationLoad - lineAverageLoad);
  if (staffingMode === "increase") return stationLoad - lineAverageLoad;
  return Math.abs(stationLoad - lineAverageLoad);
}

function updatedRackEntry(entry: RackEntry, line: string, flowRackPosition: string): RackEntry {
  const normalizedPosition = flowRackPosition.toUpperCase();
  const sort = rackPositionNumber(normalizedPosition);
  const labelPos = `${line}${normalizedPosition}`;
  const suffix = entry.recipe.includes("_") ? entry.recipe.split("_", 2)[1] : "";
  return {
    ...entry,
    line,
    flowRackPosition: normalizedPosition,
    sort,
    labelPos,
    uniCode: suffix ? `${labelPos}${suffix}` : labelPos,
  };
}

function buildPreferredSlotsByRecipe(entries: RackEntry[], slotMeta: Map<string, RackSlotMeta>) {
  const bucket = new Map<string, Array<{ position: string; demand: number; highRunner: boolean }>>();
  for (const entry of entries) {
    const meta = slotMeta.get(entry.flowRackPosition.toUpperCase());
    if (!meta?.preferredPick) continue;
    const rows = bucket.get(entry.recipe) ?? [];
    rows.push({ position: entry.flowRackPosition.toUpperCase(), demand: meta.demand, highRunner: meta.highRunner });
    bucket.set(entry.recipe, rows);
  }

  const ordered = new Map<string, string[]>();
  for (const [recipe, rows] of bucket.entries()) {
    ordered.set(recipe, [...new Map(rows
      .sort((a, b) => Number(b.highRunner) - Number(a.highRunner) || b.demand - a.demand || rackPositionNumber(a.position) - rackPositionNumber(b.position))
      .map((row) => [row.position, row.position])).values()]);
  }
  return ordered;
}

function rebalanceErgonomicEntries(
  entries: RackEntry[],
  highRunnerRecipes: Set<string>,
  slotMeta: Map<string, RackSlotMeta>,
  preferredSlotsByRecipe: Map<string, string[]>,
  staffingMode: StaffingMode,
) {
  if (entries.length === 0 || highRunnerRecipes.size === 0 || slotMeta.size === 0) return entries;

  const preferredSlots = [...slotMeta.entries()]
    .map(([position, meta]) => ({ position, meta }))
    .sort((a, b) => ergonomicTierRank(a.meta) - ergonomicTierRank(b.meta) || Number(b.meta.highRunner) - Number(a.meta.highRunner) || b.meta.demand - a.meta.demand || rackPositionNumber(a.position) - rackPositionNumber(b.position));

  const occupancy = new Map<string, number>();
  const stationDemand = new Map<string, number>();
  const lineDemand = new Map<string, number>();
  const lineStationCount = new Map<string, Set<string>>();
  for (const entry of entries) {
    const key = `${entry.line}:${entry.flowRackPosition.toUpperCase()}`;
    occupancy.set(key, (occupancy.get(key) ?? 0) + 1);
    const meta = slotMeta.get(entry.flowRackPosition.toUpperCase());
    const stationKey = `${entry.line}:${meta?.station ?? "unknown"}`;
    stationDemand.set(stationKey, (stationDemand.get(stationKey) ?? 0) + (meta?.demand ?? entry.quantity));
    lineDemand.set(entry.line, (lineDemand.get(entry.line) ?? 0) + (meta?.demand ?? entry.quantity));
    const stations = lineStationCount.get(entry.line) ?? new Set<string>();
    stations.add(meta?.station ?? "unknown");
    lineStationCount.set(entry.line, stations);
  }

  let changed = false;
  const nextEntries = entries
    .map((entry) => ({ ...entry }))
    .sort((a, b) => a.line.localeCompare(b.line) || Number(highRunnerRecipes.has(b.recipe)) - Number(highRunnerRecipes.has(a.recipe)) || (slotMeta.get(b.flowRackPosition.toUpperCase())?.demand ?? b.quantity) - (slotMeta.get(a.flowRackPosition.toUpperCase())?.demand ?? a.quantity) || b.quantity - a.quantity || a.recipe.localeCompare(b.recipe));
  for (let index = 0; index < nextEntries.length; index += 1) {
    const entry = nextEntries[index];

    const currentPosition = entry.flowRackPosition.toUpperCase();
    const currentMeta = slotMeta.get(currentPosition);
    const entryIsHighRunner = highRunnerRecipes.has(entry.recipe);
    const currentScore = ergonomicTierRank(currentMeta);

    const prioritizedPositions = [
      ...(preferredSlotsByRecipe.get(entry.recipe) ?? []),
      ...preferredSlots.map((slot) => slot.position),
    ];

    const candidates = [...new Set(prioritizedPositions)]
      .map((position) => ({
        position,
        meta: slotMeta.get(position),
        occupancy: occupancy.get(`${entry.line}:${position}`) ?? 0,
        stationLoad: stationDemand.get(`${entry.line}:${slotMeta.get(position)?.station ?? "unknown"}`) ?? 0,
        lineAverageLoad: (lineDemand.get(entry.line) ?? 0) / Math.max((lineStationCount.get(entry.line)?.size ?? 1), 1),
        preferredForRecipe: (preferredSlotsByRecipe.get(entry.recipe) ?? []).includes(position),
        distance: Math.abs(rackPositionNumber(position) - rackPositionNumber(currentPosition)),
      }))
      .filter((candidate) => entryIsHighRunner ? candidate.meta?.preferredPick : true)
      .sort((a, b) =>
        Number(b.preferredForRecipe) - Number(a.preferredForRecipe)
        || ergonomicTierRank(a.meta) - ergonomicTierRank(b.meta)
        || stationPreferenceScore(staffingMode, a.stationLoad, a.lineAverageLoad) - stationPreferenceScore(staffingMode, b.stationLoad, b.lineAverageLoad)
        || (staffingMode === "reduce" ? b.occupancy - a.occupancy : a.occupancy - b.occupancy)
        || Number(b.meta?.highRunner) - Number(a.meta?.highRunner)
        || (b.meta?.demand ?? 0) - (a.meta?.demand ?? 0)
        || a.distance - b.distance,
      );

    const target = candidates[0];
    if (!target || target.position === currentPosition) continue;
    const targetScore = ergonomicTierRank(target.meta);
    const shouldMove = entryIsHighRunner
      ? !(currentMeta?.preferredPick)
      : targetScore < currentScore || (targetScore === currentScore && target.occupancy < (occupancy.get(`${entry.line}:${currentPosition}`) ?? 0));
    if (!shouldMove) continue;

    occupancy.set(`${entry.line}:${currentPosition}`, Math.max((occupancy.get(`${entry.line}:${currentPosition}`) ?? 1) - 1, 0));
    occupancy.set(`${entry.line}:${target.position}`, (occupancy.get(`${entry.line}:${target.position}`) ?? 0) + 1);
    const currentStationKey = `${entry.line}:${currentMeta?.station ?? "unknown"}`;
    const targetStationKey = `${entry.line}:${target.meta?.station ?? "unknown"}`;
    const weight = currentMeta?.demand ?? entry.quantity;
    stationDemand.set(currentStationKey, Math.max((stationDemand.get(currentStationKey) ?? weight) - weight, 0));
    stationDemand.set(targetStationKey, (stationDemand.get(targetStationKey) ?? 0) + (target.meta?.demand ?? entry.quantity));
    nextEntries[index] = updatedRackEntry(entry, entry.line, target.position);
    changed = true;
  }

  return changed ? nextEntries.sort((a, b) => a.line.localeCompare(b.line) || a.sort - b.sort || a.recipe.localeCompare(b.recipe)) : entries;
}

function buildOperationalValidation(
  entries: RackEntry[],
  slotMeta: Map<string, RackSlotMeta>,
  highRunnerRecipes: Set<string>,
): RackValidationIssue[] {
  const issues: RackValidationIssue[] = [];
  const lines = uniqueRackLines(entries);

  for (const line of lines) {
    const lineEntries = entries.filter((entry) => entry.line === line);
    if (lineEntries.length === 0) continue;

    const offMiddleHighRunners = lineEntries.filter((entry) => {
      if (!highRunnerRecipes.has(entry.recipe)) return false;
      return !slotMeta.get(entry.flowRackPosition.toUpperCase())?.preferredPick;
    });
    if (offMiddleHighRunners.length > 0) {
      issues.push({
        severity: "warning",
        message: `${line}: ${offMiddleHighRunners.length} Highrunner liegen nicht auf der Mittelschiene (${offMiddleHighRunners.map((entry) => `${entry.recipe}@${entry.flowRackPosition}`).join(", ")}).`,
      });
    }

    const emptyErgonomicSlots = [...slotMeta.entries()].filter(([, meta]) => meta.preferredPick || meta.level === 1).filter(([position]) => !lineEntries.some((entry) => entry.flowRackPosition.toUpperCase() === position)).length;
    const topTierEntries = lineEntries.filter((entry) => slotMeta.get(entry.flowRackPosition.toUpperCase())?.level === 3);
    if (topTierEntries.length > 0 && emptyErgonomicSlots > 0) {
      issues.push({
        severity: "info",
        message: `${line}: ${topTierEntries.length} Einträge liegen auf Etage 3, obwohl ${emptyErgonomicSlots} ergonomisch bessere Plätze frei sind.`,
      });
    }

    const stationLoad = lineEntries.reduce((bucket, entry) => {
      const station = slotMeta.get(entry.flowRackPosition.toUpperCase())?.station || "unknown";
      bucket.set(station, (bucket.get(station) ?? 0) + (slotMeta.get(entry.flowRackPosition.toUpperCase())?.demand ?? entry.quantity));
      return bucket;
    }, new Map<string, number>());
    const loads = [...stationLoad.entries()].filter(([station]) => station !== "unknown").sort((a, b) => b[1] - a[1]);
    if (loads.length > 1) {
      const total = loads.reduce((sum, [, demand]) => sum + demand, 0);
      const [station, demand] = loads[0];
      if (total > 0 && demand / total >= 0.45) {
        issues.push({
          severity: "warning",
          message: `${line}: Station ${station} trägt ${Math.round((demand / total) * 100)}% der Picksumme. Prüfe Verteilung und Ergonomie.`,
        });
      }
    }
  }

  return issues;
}

function summarizeSlotViolations(
  lineEntries: RackEntry[],
  slotMeta: Map<string, RackSlotMeta>,
  highRunnerRecipes: Set<string>,
) {
  const slotReasons = new Map<string, string[]>();
  const emptyErgonomicSlots = [...slotMeta.entries()]
    .filter(([, meta]) => meta.preferredPick || meta.level === 1)
    .filter(([position]) => !lineEntries.some((entry) => entry.flowRackPosition.toUpperCase() === position))
    .length;

  const stationLoad = lineEntries.reduce((bucket, entry) => {
    const station = slotMeta.get(entry.flowRackPosition.toUpperCase())?.station || "unknown";
    bucket.set(station, (bucket.get(station) ?? 0) + (slotMeta.get(entry.flowRackPosition.toUpperCase())?.demand ?? entry.quantity));
    return bucket;
  }, new Map<string, number>());
  const totalStationDemand = [...stationLoad.values()].reduce((sum, value) => sum + value, 0);

  for (const entry of lineEntries) {
    const position = entry.flowRackPosition.toUpperCase();
    const meta = slotMeta.get(position);
    const reasons = slotReasons.get(position) ?? [];
    if (highRunnerRecipes.has(entry.recipe) && !meta?.preferredPick) {
      reasons.push("Highrunner nicht auf Mittelschiene");
    }
    if (meta?.level === 3 && emptyErgonomicSlots > 0) {
      reasons.push("Etage 3 trotz besserer freier Plätze");
    }
    const station = meta?.station || "unknown";
    const stationShare = totalStationDemand > 0 ? (stationLoad.get(station) ?? 0) / totalStationDemand : 0;
    if (station !== "unknown" && stationShare >= 0.45) {
      reasons.push(`Station ${station} trägt ${Math.round(stationShare * 100)}% der Last`);
    }
    if (reasons.length > 0) slotReasons.set(position, [...new Set(reasons)]);
  }

  return slotReasons;
}

function buildComparisonSummary(before: RackEntry[], after: RackEntry[], slotMeta: Map<string, RackSlotMeta>) {
  const lines = [...new Set([...before.map((entry) => entry.line), ...after.map((entry) => entry.line)])].sort((a, b) => a.localeCompare(b));
  return lines.map((line) => {
    const beforeEntries = before.filter((entry) => entry.line === line);
    const afterEntries = after.filter((entry) => entry.line === line);
    const moved = afterEntries.filter((entry) => {
      const previous = beforeEntries.find((candidate) => candidate.id === entry.id);
      return previous && previous.flowRackPosition !== entry.flowRackPosition;
    }).length;
    const beforeMiddle = beforeEntries.filter((entry) => slotMeta.get(entry.flowRackPosition.toUpperCase())?.preferredPick).length;
    const afterMiddle = afterEntries.filter((entry) => slotMeta.get(entry.flowRackPosition.toUpperCase())?.preferredPick).length;
    const beforeTop = beforeEntries.filter((entry) => slotMeta.get(entry.flowRackPosition.toUpperCase())?.level === 3).length;
    const afterTop = afterEntries.filter((entry) => slotMeta.get(entry.flowRackPosition.toUpperCase())?.level === 3).length;
    return {
      line,
      moved,
      middleDelta: afterMiddle - beforeMiddle,
      topDelta: afterTop - beforeTop,
    };
  });
}

function buildRecommendationOverlay(before: RackEntry[], after: RackEntry[]) {
  const bySlot = new Map<string, RackEntry[]>();
  const movedEntries = new Map<string, { before: RackEntry; after: RackEntry }>();

  for (const candidate of after) {
    const previous = before.find((entry) => entry.id === candidate.id);
    if (!previous) continue;
    if (previous.flowRackPosition === candidate.flowRackPosition && previous.line === candidate.line) continue;
    movedEntries.set(candidate.id, { before: previous, after: candidate });
    const key = `${candidate.line}:${candidate.flowRackPosition.toUpperCase()}`;
    const rows = bySlot.get(key) ?? [];
    rows.push(candidate);
    bySlot.set(key, rows);
  }

  return { bySlot, movedEntries };
}

async function fetchPublicFile(url: string, fallbackName: string): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Auto-Quelle nicht gefunden: ${url}`);
  }
  const blob = await response.blob();
  const name = decodeURIComponent(url.split("/").at(-1) ?? fallbackName) || fallbackName;
  return new File([blob], name, { type: blob.type || undefined });
}

export function RackView({ week, locale }: Props) {
  const [market, setMarket] = useState<RackMarket>("de");
  const [entries, setEntries] = useState<RackEntry[]>([]);
  const [templateEntries, setTemplateEntries] = useState<RackEntry[]>([]);
  const [pdlIds, setPdlIds] = useState<Set<string> | undefined>();
  const [boxfile, setBoxfile] = useState<RackBoxSnapshot | undefined>();
  const [co2MealIds, setCo2MealIds] = useState<Set<string> | undefined>();
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [status, setStatus] = useState<string>(locale === "de" ? "Noch keine Rackdaten geladen." : "No rack data loaded yet.");
  const [busy, setBusy] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [picksPerWorker, setPicksPerWorker] = useState(120);
  const [staffingMode, setStaffingMode] = useState<StaffingMode>("balanced");
  const [recommendationOnly, setRecommendationOnly] = useState(false);
  const [comparison, setComparison] = useState<ComparisonSnapshot | null>(null);
  const [selectedFocus, setSelectedFocus] = useState<SelectedRackFocus | null>(null);
  const [activeLines, setActiveLines] = useState<string[]>(RACK_MARKET_PROFILES.de.lines);
  const [draggedEntryId, setDraggedEntryId] = useState<string | null>(null);
  const [hoveredSlotKey, setHoveredSlotKey] = useState<string | null>(null);
  const [slotMeta, setSlotMeta] = useState<Map<string, RackSlotMeta>>(new Map());
  const [rackZoomByLine, setRackZoomByLine] = useState<Record<string, number>>({});

  const profile = RACK_MARKET_PROFILES[market];
  const scenarios = useMemo(() => scenarioOptions(market, locale), [market, locale]);

  useEffect(() => {
    setActiveLines(profile.lines);
    setEntries([]);
    setTemplateEntries([]);
    setPdlIds(undefined);
    setBoxfile(undefined);
    setCo2MealIds(undefined);
    setSlotMeta(new Map());
    setRecommendationOnly(false);
    setComparison(null);
    setSelectedFocus(null);
    setRackZoomByLine({});
    setSourceLabel("");
    setStatus(locale === "de" ? `Automatischer Rack-Start für ${week} wird vorbereitet …` : `Preparing automatic rack startup for ${week} …`);
  }, [market, week, locale, profile.lines]);

  useEffect(() => {
    let cancelled = false;

    async function loadAutomaticSources() {
      setBusy(locale === "de" ? `Lade Standardquellen für ${week} …` : `Loading default sources for ${week} …`);
      try {
        const [multilineFile, pdlFile] = await Promise.all([
          fetchPublicFile(AUTO_MULTILINE_URL, "MultiLine-latest.xlsx"),
          fetchPublicFile(AUTO_PDL_URL[market], market === "de" ? "Factor_DE - PDL Forecast.csv" : "Factor_Nor - PDL Forecast.csv"),
        ]);
        if (cancelled) return;

        const { parseRackWorkbook } = await loadRackWorkbookModule();

        const [workbookData, nextPdlIds] = await Promise.all([
          parseRackWorkbook(multilineFile, market, profile.lines),
          parsePdlCsv(pdlFile),
        ]);
        if (cancelled) return;

        const { entries: nextEntries, slotMeta: nextSlotMeta } = workbookData;

        setActiveLines(profile.lines);
        setEntries(nextEntries);
        setTemplateEntries(nextEntries);
        setPdlIds(nextPdlIds);
        setSlotMeta(nextSlotMeta);
        setSourceLabel(`${multilineFile.name} · ${pdlFile.name}`);
        setStatus(locale === "de"
          ? `Rackfile-Basis für ${week} automatisch geladen. Export ist direkt möglich, Boxfile und CO2 sind nur noch optional für Zusatzchecks.`
          : `Rackfile base for ${week} loaded automatically. You can export immediately; boxfile and CO2 are only optional extra checks.`);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setStatus(locale === "de"
          ? `Automatischer Rack-Start fehlgeschlagen: ${message}. Du kannst die Dateien unten weiterhin manuell überschreiben.`
          : `Automatic rack startup failed: ${message}. You can still override files manually below.`);
      } finally {
        if (!cancelled) setBusy(null);
      }
    }

    void loadAutomaticSources();
    return () => {
      cancelled = true;
    };
  }, [market, week, locale, profile.lines]);

  const baseValidation = useMemo(
    () => validateRackPlan(entries, { pdlIds, boxfile, co2MealIds }),
    [entries, pdlIds, boxfile, co2MealIds],
  );
  const summary = useMemo(() => rackSummary(entries), [entries]);
  const usedLines = useMemo(() => uniqueRackLines(entries), [entries]);

  const filteredEntries = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      [entry.recipe, entry.line, entry.flowRackPosition, entry.sku, entry.ingredient, entry.displayName]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [entries, filterText]);

  const highRunnerRecipes = useMemo(() => {
    const source = templateEntries.length > 0 ? templateEntries : entries;
    const next = new Set<string>();
    for (const entry of source) {
      if (slotMeta.get(entry.flowRackPosition.toUpperCase())?.highRunner) {
        next.add(entry.recipe);
      }
    }
    return next;
  }, [templateEntries, entries, slotMeta]);

  const preferredSlotsByRecipe = useMemo(() => {
    const source = templateEntries.length > 0 ? templateEntries : entries;
    return buildPreferredSlotsByRecipe(source, slotMeta);
  }, [templateEntries, entries, slotMeta]);

  const operationalIssues = useMemo(
    () => buildOperationalValidation(entries, slotMeta, highRunnerRecipes),
    [entries, slotMeta, highRunnerRecipes],
  );

  const validation = useMemo<RackValidationResult>(() => ({
    ok: baseValidation.ok,
    issues: [...operationalIssues, ...baseValidation.issues],
  }), [baseValidation, operationalIssues]);
  const comparisonSummary = useMemo(
    () => comparison ? buildComparisonSummary(comparison.before, comparison.after, slotMeta) : [],
    [comparison, slotMeta],
  );
  const recommendationPreview = useMemo(
    () => recommendationOnly && slotMeta.size > 0 ? rebalanceErgonomicEntries(entries, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, staffingMode) : null,
    [recommendationOnly, entries, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, staffingMode],
  );
  const activeComparison = useMemo<ComparisonSnapshot | null>(() => {
    if (comparison) return comparison;
    if (recommendationOnly && recommendationPreview) {
      return {
        label: locale === "de" ? "Live-Empfehlung ohne Überschreiben" : "Live recommendation without overwrite",
        before: entries,
        after: recommendationPreview,
      };
    }
    return null;
  }, [comparison, recommendationOnly, recommendationPreview, locale, entries]);
  const activeComparisonSummary = useMemo(
    () => activeComparison ? buildComparisonSummary(activeComparison.before, activeComparison.after, slotMeta) : [],
    [activeComparison, slotMeta],
  );
  const recommendationOverlay = useMemo(
    () => recommendationPreview ? buildRecommendationOverlay(entries, recommendationPreview) : { bySlot: new Map<string, RackEntry[]>(), movedEntries: new Map<string, { before: RackEntry; after: RackEntry }>() },
    [entries, recommendationPreview],
  );
  const selectedEntries = useMemo(
    () => selectedFocus ? entries.filter((entry) => entry.line === selectedFocus.line && entry.flowRackPosition.toUpperCase() === selectedFocus.position.toUpperCase()) : [],
    [entries, selectedFocus],
  );
  const selectedRecommendedEntries = useMemo(
    () => selectedFocus ? (recommendationOverlay.bySlot.get(`${selectedFocus.line}:${selectedFocus.position.toUpperCase()}`) ?? []) : [],
    [recommendationOverlay, selectedFocus],
  );
  const selectedViolations = useMemo(
    () => selectedFocus ? summarizeSlotViolations(entries.filter((entry) => entry.line === selectedFocus.line), slotMeta, highRunnerRecipes).get(selectedFocus.position.toUpperCase()) ?? [] : [],
    [entries, selectedFocus, slotMeta, highRunnerRecipes],
  );
  const selectedMeta = useMemo(
    () => selectedFocus ? slotMeta.get(selectedFocus.position.toUpperCase()) : undefined,
    [selectedFocus, slotMeta],
  );
  const selectedMovedEntry = useMemo(
    () => selectedFocus?.entryId ? recommendationOverlay.movedEntries.get(selectedFocus.entryId) : undefined,
    [selectedFocus, recommendationOverlay],
  );

  useEffect(() => {
    if (recommendationOnly) return;
    const nextEntries = rebalanceErgonomicEntries(entries, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, staffingMode);
    if (nextEntries === entries) return;
    const movedEntries = nextEntries.filter((entry, index) => entry.flowRackPosition !== entries[index]?.flowRackPosition).length;
    setEntries(nextEntries);
    setStatus(locale === "de"
      ? `${movedEntries} Einträge ergonomisch nachgezogen: Modus ${staffingMode === "reduce" ? "Mitarbeiter senken" : staffingMode === "increase" ? "Mitarbeiter erhöhen" : "balanciert"}.`
      : `Rebalanced ${movedEntries} entries with staffing mode ${staffingMode}.`);
  }, [entries, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, locale, staffingMode, recommendationOnly]);

  const entriesByLineAndSlot = useMemo(() => {
    const bucket = new Map<string, RackEntry[]>();
    for (const entry of entries) {
      const key = `${entry.line}:${entry.flowRackPosition}`;
      const rows = bucket.get(key) ?? [];
      rows.push(entry);
      bucket.set(key, rows);
    }
    return bucket;
  }, [entries]);

  function lineZoom(line: string) {
    return rackZoomByLine[line] ?? 0.9;
  }

  function updateLineZoom(line: string, nextZoom: number) {
    setRackZoomByLine((current) => ({
      ...current,
      [line]: clampRackZoom(nextZoom),
    }));
  }

  async function handleMultilineUpload(file: File) {
    setBusy(locale === "de" ? "MultiLine wird geladen …" : "Loading MultiLine …");
    try {
      const { parseRackWorkbook } = await loadRackWorkbookModule();
      const { entries: nextEntries, slotMeta: nextSlotMeta } = await parseRackWorkbook(file, market, activeLines);
      setEntries(nextEntries);
      setTemplateEntries(nextEntries);
      setSlotMeta(nextSlotMeta);
      setSourceLabel(file.name);
      setStatus(locale === "de" ? `MultiLine importiert: ${file.name}` : `MultiLine imported: ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleRackfileUpload(file: File) {
    setBusy(locale === "de" ? "Rackfile wird geladen …" : "Loading rackfile …");
    try {
      const nextEntries = await parseRackfileCsv(file);
      setEntries(nextEntries);
      setTemplateEntries(nextEntries);
      setActiveLines(uniqueRackLines(nextEntries));
      setSourceLabel(file.name);
      setStatus(locale === "de" ? `Rackfile importiert: ${file.name}` : `Rackfile imported: ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function handlePdlUpload(file: File) {
    setBusy(locale === "de" ? "PDL wird geprüft …" : "Loading PDL …");
    try {
      setPdlIds(await parsePdlCsv(file));
      setStatus(locale === "de" ? `PDL geladen: ${file.name}` : `PDL loaded: ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleBoxfileUpload(file: File) {
    setBusy(locale === "de" ? "Boxfile wird geprüft …" : "Loading boxfile …");
    try {
      setBoxfile(await parseBoxfileCsv(file));
      setStatus(locale === "de" ? `Boxfile geladen: ${file.name}` : `Boxfile loaded: ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleCo2Upload(file: File) {
    setBusy(locale === "de" ? "CO2 wird geprüft …" : "Loading CO2 …");
    try {
      setCo2MealIds(await parseCo2Csv(file, profile.boxPrefix));
      setStatus(locale === "de" ? `CO2 geladen: ${file.name}` : `CO2 loaded: ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  function applyScenario(lines: string[]) {
    const source = templateEntries.length > 0 ? templateEntries : entries;
    if (source.length === 0) {
      setStatus(locale === "de" ? "Noch keine Rack-Basis geladen. Warte kurz auf den Auto-Import oder wähle unten Dateien manuell aus." : "No rack base loaded yet. Wait for the automatic import or choose files manually below.");
      return;
    }
    const nextEntries = projectRackEntriesToLines(source, lines);
    setActiveLines(lines);
    setEntries(nextEntries);
    setRecommendationOnly(false);
    setComparison(null);
    setStatus(locale === "de" ? `Szenario aktiv: ${lines.join(", ")}` : `Scenario active: ${lines.join(", ")}`);
  }

  function handleActiveLineChange(line: string, enabled: boolean) {
    const next = enabled
      ? [...new Set([...activeLines, line])].sort((a, b) => a.localeCompare(b))
      : activeLines.filter((candidate) => candidate !== line);
    if (next.length === 0) return;
    setActiveLines(next);
  }

  function rebuildForSelectedLines() {
    applyScenario(activeLines);
  }

  function suggestBestPlan() {
    const source = templateEntries.length > 0 ? projectRackEntriesToLines(templateEntries, activeLines) : entries;
    if (source.length === 0) return;
    const nextEntries = rebalanceErgonomicEntries(source, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, staffingMode);
    setComparison({
      label: locale === "de" ? "Vorher / nach Optimierung" : "Before / after optimization",
      before: source,
      after: nextEntries,
    });
    setRecommendationOnly(false);
    setEntries(nextEntries);
    setStatus(locale === "de"
      ? `Optimierung angewendet: beste Linienbelegung für Modus ${staffingMode === "reduce" ? "Mitarbeiter senken" : staffingMode === "increase" ? "Mitarbeiter erhöhen" : "balanciert"}.`
      : `Applied best-line optimization for staffing mode ${staffingMode}.`);
  }

  function handlePillDragStart(entryId: string) {
    setDraggedEntryId(entryId);
  }

  function handlePillDragEnd() {
    setDraggedEntryId(null);
    setHoveredSlotKey(null);
  }

  function handleSlotDrop(line: string, flowRackPosition: string) {
    if (!draggedEntryId) return;
    const draggedEntry = entries.find((entry) => entry.id === draggedEntryId);
    const targetEntries = entries.filter((entry) => entry.line === line && entry.flowRackPosition.toUpperCase() === flowRackPosition.toUpperCase() && entry.id !== draggedEntryId);
    const targetMeta = slotMeta.get(flowRackPosition.toUpperCase());
    if (draggedEntry && highRunnerRecipes.has(draggedEntry.recipe) && targetMeta && !targetMeta.preferredPick) {
      setStatus(locale === "de"
        ? `Highrunner ${draggedEntry.recipe} bitte nur auf der mittleren Schiene platzieren.`
        : `Place high runner ${draggedEntry.recipe} on the middle rail only.`);
      setDraggedEntryId(null);
      setHoveredSlotKey(null);
      return;
    }
    const swapCandidate = targetEntries.find((entry) => deriveEntryKind(entry) !== "ice") ?? targetEntries[0];
    if (draggedEntry && swapCandidate) {
      const draggedTargetMeta = slotMeta.get(swapCandidate.flowRackPosition.toUpperCase());
      if (highRunnerRecipes.has(swapCandidate.recipe) && !slotMeta.get(draggedEntry.flowRackPosition.toUpperCase())?.preferredPick) {
        setStatus(locale === "de"
          ? `Swap blockiert: Highrunner ${swapCandidate.recipe} würde die Mittelschiene verlassen.`
          : `Swap blocked: high runner ${swapCandidate.recipe} would leave the middle rail.`);
      } else {
        setEntries((current) => swapRackEntries(current, draggedEntryId, swapCandidate.id, line, flowRackPosition));
        setStatus(locale === "de"
          ? `Slots getauscht: ${draggedEntry.flowRackPosition} mit ${swapCandidate.flowRackPosition}.`
          : `Swapped ${draggedEntry.flowRackPosition} with ${swapCandidate.flowRackPosition}.`);
      }
    } else {
      setEntries((current) => moveRackEntry(current, draggedEntryId, line, flowRackPosition));
      setStatus(locale === "de"
        ? `Verschoben auf ${line} / ${flowRackPosition}. Mittlere Schiene bevorzugen, Highrunner bleiben in Level 2.`
        : `Moved to ${line} / ${flowRackPosition}. Prefer the middle rail and keep high runners on level 2.`);
    }
    setDraggedEntryId(null);
    setHoveredSlotKey(null);
  }

  return (
    <div className="space-y-4">
      <section className="card overflow-hidden">
        <div className="border-b border-slate-200 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.18),_transparent_28%),linear-gradient(135deg,_#0f172a,_#1e293b_45%,_#334155)] p-5 text-white">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-200">{locale === "de" ? "Rack Orchestrator" : "Rack orchestrator"}</div>
              <h2 className="text-2xl font-bold tracking-tight">{locale === "de" ? "Rack-Planung, Visualisierung und Validierung" : "Rack planning, visualization and validation"}</h2>
              <p className="max-w-3xl text-sm text-slate-200">
                {locale === "de"
                  ? "Beim Öffnen lädt das Tool die Standardquellen selbst und baut daraus direkt die Rackfile-Basis für die gewählte KW. MultiLine, PDL, Boxfile, CO2 oder ein bestehendes Rackfile kannst du unten nur noch optional als Override nachladen."
                  : "On open, the tool loads the default sources automatically and builds the rackfile base for the selected week. MultiLine, PDL, boxfile, CO2 or an existing rackfile below are optional overrides only."}
              </p>
            </div>
            <div className="min-w-[220px] rounded-2xl bg-white/10 p-3 ring-1 ring-white/15 backdrop-blur">
              <div className="text-[11px] uppercase tracking-wide text-sky-200">{locale === "de" ? "Woche / Markt" : "Week / market"}</div>
              <div className="mt-1 text-lg font-semibold">{week}</div>
              <div className="mt-3 flex gap-2">
                {(["de", "nordics"] as RackMarket[]).map((candidate) => (
                  <button
                    key={candidate}
                    onClick={() => setMarket(candidate)}
                    className={`rounded-xl px-3 py-2 text-sm font-semibold ${market === candidate ? "bg-white text-slate-950" : "bg-white/10 text-white ring-1 ring-white/15"}`}
                  >
                    {candidate === "de" ? "DE" : "Nordics"}
                  </button>
                ))}
              </div>
              <div className="mt-3 rounded-xl bg-white/10 p-2 ring-1 ring-white/10">
                <div className="text-[11px] uppercase tracking-wide text-sky-200">{locale === "de" ? "Aktive Linien" : "Active lines"}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {profile.lines.map((line) => (
                    <label key={line} className={`inline-flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs font-semibold ring-1 ${activeLines.includes(line) ? "bg-white text-slate-950 ring-white" : "bg-white/10 text-white ring-white/15"}`}>
                      <input
                        type="checkbox"
                        checked={activeLines.includes(line)}
                        onChange={(event) => handleActiveLineChange(line, event.target.checked)}
                      />
                      {line}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-4 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4">
            <div className="rounded-[28px] bg-[radial-gradient(circle_at_top_left,rgba(148,163,184,0.14),transparent_38%),linear-gradient(135deg,rgba(255,255,255,0.98),rgba(248,250,252,0.94))] p-4 ring-1 ring-slate-200 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.35)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Linien-Szenarien" : "Line scenarios"}</div>
                  <div className="mt-1 text-sm text-slate-700">{locale === "de" ? "Plane Primär- und Backup-Linien vor. Ein Klick baut die Rackfile sofort für die Ersatzlinie neu auf." : "Pre-plan primary and backup lines. One click rebuilds the rackfile for the backup line."}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn" onClick={rebuildForSelectedLines} disabled={activeLines.length === 0 || (entries.length === 0 && templateEntries.length === 0)}>
                    {locale === "de" ? "Mit aktiven Linien neu aufbauen" : "Rebuild with active lines"}
                  </button>
                  <button className={`btn ${recommendationOnly ? "btn-primary" : ""}`} onClick={() => setRecommendationOnly((current) => !current)} disabled={entries.length === 0 || slotMeta.size === 0}>
                    {recommendationOnly ? (locale === "de" ? "Empfehlung ausblenden" : "Hide recommendation") : (locale === "de" ? "Nur Empfehlungen" : "Recommendations only")}
                  </button>
                  <button className="btn btn-primary" onClick={suggestBestPlan} disabled={entries.length === 0 || slotMeta.size === 0}>
                    {locale === "de" ? "Beste Linie bauen" : "Build best line"}
                  </button>
                </div>
              </div>
              <div className="mt-3 grid gap-2 md:grid-cols-3">
                <div className="rounded-2xl bg-slate-950 px-3 py-3 text-white shadow-[0_18px_35px_-24px_rgba(15,23,42,0.9)]">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-300">{locale === "de" ? "Lazy Load" : "Lazy load"}</div>
                  <div className="mt-1 text-sm font-semibold">{locale === "de" ? "RackView + Workbook getrennt geladen" : "RackView + workbook load separately"}</div>
                </div>
                <div className="rounded-2xl bg-[linear-gradient(135deg,rgba(16,185,129,0.14),rgba(255,255,255,0.96))] px-3 py-3 ring-1 ring-emerald-200">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-emerald-700">{locale === "de" ? "Workbook-Metadaten" : "Workbook metadata"}</div>
                  <div className="mt-1 text-sm font-semibold text-emerald-950">{slotMeta.size > 0 ? `${slotMeta.size} ${locale === "de" ? "Slots mit Layout-Semantik" : "slots with layout semantics"}` : (locale === "de" ? "Wird nach dem XLSX-Ladevorgang ergänzt" : "Filled after XLSX load")}</div>
                </div>
                <div className="rounded-2xl bg-[linear-gradient(135deg,rgba(14,165,233,0.14),rgba(255,255,255,0.96))] px-3 py-3 ring-1 ring-sky-200">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-sky-700">{locale === "de" ? "Planungsmodus" : "Planning mode"}</div>
                  <div className="mt-1 text-sm font-semibold text-sky-950">{recommendationOnly ? (locale === "de" ? "Nur Empfehlungen sichtbar" : "Recommendations overlay only") : (locale === "de" ? "Direktes Planen auf Live-Stand" : "Planning directly on live state")}</div>
                </div>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-3">
                {scenarios.map((scenario) => (
                  <button
                    key={scenario.id}
                    className={`rounded-[24px] border p-3 text-left transition-all duration-300 ${activeLines.join("|") === scenario.lines.join("|") ? "border-slate-900 bg-slate-900 text-white shadow-[0_22px_40px_-28px_rgba(15,23,42,0.95)]" : "border-slate-200 bg-white/90 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_20px_32px_-28px_rgba(15,23,42,0.45)]"}`}
                    onClick={() => applyScenario(scenario.lines)}
                  >
                    <div className="font-semibold">{scenario.label}</div>
                    <div className={`mt-1 text-sm ${activeLines.join("|") === scenario.lines.join("|") ? "text-slate-300" : "text-slate-500"}`}>{scenario.note}</div>
                    <div className="mt-3 flex flex-wrap gap-1">
                      {scenario.lines.map((line) => <span key={line} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${activeLines.join("|") === scenario.lines.join("|") ? "bg-white/15 text-white" : lineBadge(line)}`}>{line}</span>)}
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Aktuell geplant auf" : "Currently planned on"}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {usedLines.length > 0 ? usedLines.map((line) => <span key={line} className={lineBadge(line)}>{line}</span>) : <span className="text-sm text-slate-500">{locale === "de" ? "noch keine Daten" : "no data yet"}</span>}
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <div className="md:col-span-2 xl:col-span-3 rounded-2xl border border-dashed border-slate-300 bg-white p-3 text-sm text-slate-600">
                {locale === "de"
                  ? "Standardquellen werden automatisch geladen. Die folgenden Uploads sind nur für manuelle Overrides oder zusätzliche Validierung gedacht."
                  : "Default sources are loaded automatically. The uploads below are only for manual overrides or additional validation."}
              </div>
              <UploadCard label="MultiLine XLSX" hint={locale === "de" ? `${profile.sheet} · optional überschreiben` : `${profile.sheet} · optional override`} onPick={handleMultilineUpload} accept=".xlsx" />
              <UploadCard label="Rackfile CSV" hint={locale === "de" ? "optional: bestehendes Rackfile importieren" : "optional: import existing rackfile"} onPick={handleRackfileUpload} accept=".csv" />
              <UploadCard label="PDL CSV" hint={locale === "de" ? "optional: Meal-Soll überschreiben" : "optional: override meal target"} onPick={handlePdlUpload} accept=".csv" />
              <UploadCard label="Boxfile CSV" hint={locale === "de" ? "optional: ETL BOXFILE_VE für Zusatzchecks" : "optional: ETL BOXFILE_VE for extra checks"} onPick={handleBoxfileUpload} accept=".csv" />
              <UploadCard label="CO2 CSV" hint={locale === "de" ? `optional: ETL CO_2 (${profile.boxPrefix})` : `optional: ETL CO_2 (${profile.boxPrefix})`} onPick={handleCo2Upload} accept=".csv" />
            </div>
          </div>

          <div className="rounded-[28px] bg-[radial-gradient(circle_at_top_right,rgba(14,165,233,0.16),transparent_32%),linear-gradient(135deg,rgba(248,250,252,0.96),rgba(255,255,255,0.96))] p-4 ring-1 ring-slate-200 shadow-[0_24px_60px_-40px_rgba(14,165,233,0.35)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Status" : "Status"}</div>
                <div className="mt-1 inline-flex items-center rounded-full bg-slate-950 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white">{busy ? (locale === "de" ? "Lädt" : "Loading") : (locale === "de" ? "Bereit" : "Ready")}</div>
                <div className="mt-2 text-sm font-medium text-slate-800">{busy ?? status}</div>
                {sourceLabel && <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500"><span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">{locale === "de" ? "Quelle" : "Source"}</span><span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">{sourceLabel}</span></div>}
              </div>
              <button
                className="btn btn-primary"
                disabled={entries.length === 0}
                onClick={() => downloadText(market === "de" ? `Rackfile_[${week}]_[F-DE]_[${usedLines.join("_") || activeLines.join("_")}].csv` : `Rackfile_KW${week.split("W").at(-1)}_[Fact-Nordics]_[ASL${(usedLines.length > 0 ? usedLines : activeLines).map((line) => line.replace("ASL", "")).join(",")}].csv`, exportRackfileCsv(entries))}
              >
                {locale === "de" ? "Rackfile exportieren" : "Export rackfile"}
              </button>
            </div>
            <div className="mt-4 rounded-2xl bg-white/85 p-3 ring-1 ring-slate-200 backdrop-blur">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-900">{locale === "de" ? "Auto-Load aktiv" : "Auto-load active"}</span>
                <span className="rounded-full bg-sky-100 px-2.5 py-1 text-sky-900">{locale === "de" ? "Workbook getrennt nachgeladen" : "Workbook loaded separately"}</span>
                <span className="rounded-full bg-violet-100 px-2.5 py-1 text-violet-900">{locale === "de" ? `${usedLines.length || activeLines.length} Linien im Fokus` : `${usedLines.length || activeLines.length} lines in focus`}</span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 xl:grid-cols-7">
              <MiniStat label="Meals" value={summary.meal} />
              <MiniStat label="Packaging" value={summary.packaging} />
              <MiniStat label="Ice" value={summary.ice} />
              <MiniStat label="Loyalty" value={summary.loyalty} />
              <MiniStat label="Beverage" value={summary.beverage} />
              <MiniStat label="Protein" value={summary.protein} />
              <MiniStat label={locale === "de" ? "Validierung" : "Validation"} value={validation.ok ? "OK" : validation.issues.filter((issue) => issue.severity === "error").length} accent={!validation.ok} />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Mitarbeiter-Schlüssel" : "Staffing factor"}</div>
                <div className="mt-1 text-sm text-slate-600">{locale === "de" ? "Picks pro Mitarbeiter für die Linienstatistik und Stationsabschätzung." : "Picks per worker for line and station staffing estimates."}</div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 rounded-2xl bg-slate-50 p-1 ring-1 ring-slate-200">
                  {([
                    { id: "reduce", label: locale === "de" ? "MA senken" : "Reduce workers" },
                    { id: "balanced", label: locale === "de" ? "Balanciert" : "Balanced" },
                    { id: "increase", label: locale === "de" ? "MA erhöhen" : "Increase workers" },
                  ] as Array<{ id: StaffingMode; label: string }>).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => setStaffingMode(option.id)}
                      className={`rounded-xl px-3 py-2 text-sm font-semibold ${staffingMode === option.id ? "bg-slate-900 text-white" : "text-slate-600"}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold text-slate-700"
                    onClick={() => setPicksPerWorker((current) => Math.max(10, current - 10))}
                  >
                    -10
                  </button>
                  <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                    {locale === "de" ? "Picks / Mitarbeiter" : "Picks / worker"}
                    <input
                      type="number"
                      min={1}
                      value={picksPerWorker}
                      onChange={(event) => setPicksPerWorker(Math.max(1, Number(event.target.value) || 1))}
                      className="w-28 rounded-xl border-slate-300 px-3 py-2 ring-1 ring-slate-300"
                    />
                  </label>
                  <button
                    type="button"
                    className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold text-slate-700"
                    onClick={() => setPicksPerWorker((current) => current + 10)}
                  >
                    +10
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.78fr_1.22fr]">
        <div className="space-y-4">
          {selectedFocus && (
            <div className="card overflow-hidden p-0">
              <div className="border-b border-slate-200 bg-[linear-gradient(135deg,#0f172a,#1e293b_55%,#0369a1)] px-4 py-3 text-white">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-200">{locale === "de" ? "Slot / Rezept Fokus" : "Slot / recipe focus"}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className={lineBadge(selectedFocus.line)}>{selectedFocus.line}</span>
                  <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold ring-1 ring-white/15">{selectedFocus.position}</span>
                  {selectedMeta?.station && <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold ring-1 ring-white/15">{selectedMeta.station}</span>}
                </div>
              </div>
              <div className="grid gap-3 p-4 xl:grid-cols-[0.95fr_1.05fr]">
                <div className="space-y-3">
                  <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                    <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Aktuell im Fach" : "Currently in slot"}</div>
                    <div className="mt-3 space-y-2">
                      {selectedEntries.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-500">{locale === "de" ? "Kein Eintrag im aktuellen Plan." : "No entry in the current plan."}</div>}
                      {selectedEntries.map((entry) => (
                        <button key={entry.id} type="button" onClick={() => setSelectedFocus({ line: selectedFocus.line, position: selectedFocus.position, entryId: entry.id })} className="flex w-full items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-left transition hover:-translate-y-0.5 hover:shadow-sm">
                          <div>
                            <div className="font-semibold text-slate-900">{entry.recipe}</div>
                            <div className="text-xs text-slate-500">{entry.displayName || entry.ingredient}</div>
                          </div>
                          <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${kindTone(deriveEntryKind(entry))}`}>x{entry.quantity}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                    <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Regeln & Metadaten" : "Rules & metadata"}</div>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide">
                      <span className={`rounded-full px-2.5 py-1 ${selectedMeta?.preferredPick ? "bg-emerald-100 text-emerald-900" : "bg-slate-100 text-slate-700"}`}>{selectedMeta?.preferredPick ? (locale === "de" ? "Mittelschiene" : "Middle rail") : tierLabel((selectedMeta?.level as 1 | 2 | 3) || 1, locale)}</span>
                      {selectedMeta?.highRunner && <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-900">Highrunner</span>}
                      {selectedMeta?.demand ? <span className="rounded-full bg-sky-100 px-2.5 py-1 text-sky-900">Demand {selectedMeta.demand}</span> : null}
                      {selectedMeta?.type ? <span className="rounded-full bg-violet-100 px-2.5 py-1 text-violet-900">{selectedMeta.type}</span> : null}
                    </div>
                    <div className="mt-3 space-y-2 text-sm">
                      {selectedViolations.length === 0 && <div className="rounded-xl bg-emerald-50 px-3 py-3 text-emerald-900 ring-1 ring-emerald-200">{locale === "de" ? "Für dieses Fach liegen aktuell keine Regelverletzungen vor." : "No rule violations for this slot right now."}</div>}
                      {selectedViolations.map((reason) => <div key={reason} className="rounded-xl bg-rose-50 px-3 py-3 text-rose-900 ring-1 ring-rose-200">{reason}</div>)}
                    </div>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="rounded-2xl bg-[linear-gradient(135deg,rgba(14,165,233,0.14),rgba(255,255,255,0.96)),radial-gradient(circle_at_top_right,rgba(59,130,246,0.18),transparent_40%)] p-4 ring-1 ring-sky-200">
                    <div className="text-xs font-black uppercase tracking-[0.18em] text-sky-800">{locale === "de" ? "Empfohlene Belegung" : "Recommended occupancy"}</div>
                    <div className="mt-3 space-y-2">
                      {selectedRecommendedEntries.length === 0 && <div className="rounded-xl border border-dashed border-sky-200 bg-white/80 px-3 py-3 text-sm text-slate-500">{locale === "de" ? "Keine zusätzliche Empfehlung für dieses Fach." : "No additional recommendation for this slot."}</div>}
                      {selectedRecommendedEntries.map((entry) => (
                        <div key={entry.id} className="rounded-2xl border border-sky-200 bg-white/90 px-3 py-3 shadow-sm">
                          <div className="font-semibold text-slate-900">{entry.recipe}</div>
                          <div className="mt-1 text-xs text-slate-500">{entry.displayName || entry.ingredient}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {selectedMovedEntry && (
                    <div className="rounded-2xl bg-slate-900 p-4 text-white ring-1 ring-slate-900">
                      <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-300">{locale === "de" ? "Empfohlener Move" : "Recommended move"}</div>
                      <div className="mt-2 text-sm text-slate-100">{selectedMovedEntry.after.recipe}</div>
                      <div className="mt-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide">
                        <span className="rounded-full bg-white/10 px-2.5 py-1">{selectedMovedEntry.before.line} {selectedMovedEntry.before.flowRackPosition}</span>
                        <span>→</span>
                        <span className="rounded-full bg-sky-500/20 px-2.5 py-1 text-sky-100">{selectedMovedEntry.after.line} {selectedMovedEntry.after.flowRackPosition}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {activeComparison && (
            <div className="card overflow-hidden p-0">
              <div className="border-b border-slate-200 bg-[linear-gradient(135deg,#111827,#1f2937_55%,#0f766e)] px-4 py-3 text-white">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-teal-200">{locale === "de" ? "Vorher / Nachher" : "Before / after"}</div>
                    <div className="mt-1 text-sm text-slate-200">{activeComparison.label}</div>
                  </div>
                  <button type="button" className="rounded-xl bg-white/10 px-3 py-2 text-sm font-semibold text-white ring-1 ring-white/15" onClick={() => setComparison(null)}>
                    {locale === "de" ? "Ausblenden" : "Hide"}
                  </button>
                </div>
              </div>
              <div className="grid gap-3 p-4 md:grid-cols-3">
                {activeComparisonSummary.map((item) => (
                  <div key={item.line} className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                    <div className="flex items-center justify-between gap-2">
                      <span className={lineBadge(item.line)}>{item.line}</span>
                      <span className="rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white">{item.moved} {locale === "de" ? "Moves" : "moves"}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <MiniStat label={locale === "de" ? "Mitte Δ" : "Middle Δ"} value={item.middleDelta > 0 ? `+${item.middleDelta}` : item.middleDelta} accent={item.middleDelta > 0} />
                      <MiniStat label={locale === "de" ? "Etage 3 Δ" : "Tier 3 Δ"} value={item.topDelta > 0 ? `+${item.topDelta}` : item.topDelta} accent={item.topDelta > 0} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold uppercase tracking-wide text-slate-600">{locale === "de" ? "Validierungsreport" : "Validation report"}</h3>
              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${validation.ok ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>{validation.ok ? "OK" : `${validation.issues.filter((issue) => issue.severity === "error").length} Errors`}</span>
            </div>
            <div className="mt-3 max-h-[34rem] space-y-2 overflow-auto pr-1">
              {validation.issues.length === 0 && (
                <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 ring-1 ring-emerald-200">{locale === "de" ? "Noch keine Abweichungen. Sobald Daten geladen sind, erscheinen hier alle Checks." : "No deviations yet. Checks appear here once data is loaded."}</div>
              )}
              {validation.issues.map((issue, index) => (
                <div key={`${issue.severity}-${index}`} className={`rounded-xl p-3 text-sm ring-1 ${issueTone(issue.severity)}`}>
                  <div className="font-semibold uppercase tracking-wide">{issue.severity}</div>
                  <div className="mt-1">{issue.message}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold uppercase tracking-wide text-slate-600">{locale === "de" ? "Manuelle Planung" : "Manual planning"}</h3>
              <input
                value={filterText}
                onChange={(event) => setFilterText(event.target.value)}
                placeholder={locale === "de" ? "Recipe, Linie, Slot …" : "Recipe, line, slot …"}
                className="w-52 rounded-lg border-slate-300 px-3 py-2 text-sm ring-1 ring-slate-300"
              />
            </div>
            <div className="mt-3 max-h-[42rem] overflow-auto rounded-xl ring-1 ring-slate-200">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Recipe</th>
                    <th className="px-3 py-2">Line</th>
                    <th className="px-3 py-2">Slot</th>
                    <th className="px-3 py-2">Qty</th>
                    <th className="px-3 py-2">Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filteredEntries.map((entry) => {
                    const kind = deriveEntryKind(entry);
                    return (
                      <tr key={entry.id}>
                        <td className="px-3 py-2 align-top">
                          <div className="font-semibold text-slate-900">{entry.recipe}</div>
                          <div className="text-xs text-slate-500">{entry.displayName || entry.ingredient}</div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <select
                            className="w-full rounded-lg border-slate-300 px-2 py-1.5 ring-1 ring-slate-300"
                            value={entry.line}
                            onChange={(event) => setEntries((current) => updateRackEntry(current, entry.id, { line: event.target.value }))}
                          >
                            {[...new Set([...profile.lines, ...usedLines, ...activeLines])].sort((a, b) => a.localeCompare(b)).map((line) => <option key={line} value={line}>{line}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2 align-top">
                          <input
                            value={entry.flowRackPosition}
                            onChange={(event) => setEntries((current) => updateRackEntry(current, entry.id, { flowRackPosition: event.target.value.toUpperCase() }))}
                            className="w-24 rounded-lg border-slate-300 px-2 py-1.5 ring-1 ring-slate-300"
                          />
                        </td>
                        <td className="px-3 py-2 align-top">
                          <input
                            type="number"
                            min={0}
                            value={entry.quantity}
                            onChange={(event) => setEntries((current) => updateRackEntry(current, entry.id, { quantity: Number(event.target.value) || 0 }))}
                            className="w-20 rounded-lg border-slate-300 px-2 py-1.5 ring-1 ring-slate-300"
                          />
                        </td>
                        <td className="px-3 py-2 align-top">
                          <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${kindTone(kind)}`}>{kind}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold uppercase tracking-wide text-slate-600">{locale === "de" ? "Linienbild" : "Line map"}</h3>
              <p className="mt-1 text-sm text-slate-500">{locale === "de" ? "Die ASLs bleiben exakt dreietagig gestapelt. Mit Zoom kannst du dichter für den Überblick oder näher für den Nachbau arbeiten." : "The ASLs stay stacked in exact three-tier columns. Use zoom for overview or closer reconstruction."}</p>
            </div>
            <div className="rounded-[22px] bg-slate-50 px-3 py-2 ring-1 ring-slate-200 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              {locale === "de" ? "Zoom jetzt je Linie separat" : "Zoom is now per line"}
            </div>
          </div>

          <div className="mt-4 space-y-6">
            {(usedLines.length > 0 ? usedLines : activeLines).map((line) => {
              const slots = lineSlotRange(entries, line);
              return (
                <LineVisual
                  key={line}
                  line={line}
                  market={market}
                  slots={slots}
                  entries={entries}
                  entriesByLineAndSlot={entriesByLineAndSlot}
                  slotMeta={slotMeta}
                  highRunnerRecipes={highRunnerRecipes}
                  picksPerWorker={picksPerWorker}
                  staffingMode={staffingMode}
                  rackZoom={lineZoom(line)}
                  onRackZoomChange={(nextZoom) => updateLineZoom(line, nextZoom)}
                  selectedFocus={selectedFocus}
                  recommendedEntriesBySlot={recommendationOverlay.bySlot}
                  movedRecommendationByEntryId={recommendationOverlay.movedEntries}
                  locale={locale}
                  draggedEntryId={draggedEntryId}
                  hoveredSlotKey={hoveredSlotKey}
                  onHoverSlot={setHoveredSlotKey}
                  onDropToSlot={handleSlotDrop}
                  onPillDragStart={handlePillDragStart}
                  onPillDragEnd={handlePillDragEnd}
                  onSelectSlot={(selectedLine, position) => setSelectedFocus({ line: selectedLine, position })}
                  onSelectEntry={(entryId, selectedLine, position) => setSelectedFocus({ line: selectedLine, position, entryId })}
                />
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function UploadCard({ label, hint, accept, onPick }: { label: string; hint: string; accept: string; onPick: (file: File) => Promise<void> }) {
  return (
    <label className="group cursor-pointer overflow-hidden rounded-[24px] border border-slate-200 bg-[linear-gradient(135deg,rgba(255,255,255,1),rgba(248,250,252,0.98))] p-4 transition-all duration-300 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_20px_38px_-28px_rgba(15,23,42,0.45)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
          <div className="mt-1 text-sm text-slate-700">{hint}</div>
        </div>
        <div className="rounded-2xl bg-slate-950 px-3 py-2 text-lg font-black text-white shadow-[0_18px_30px_-24px_rgba(15,23,42,0.9)]">{label[0]}</div>
      </div>
      <div className="mt-4 inline-flex rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white">Datei wählen</div>
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void onPick(file);
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

function MiniStat({ label, value, accent = false }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div className={`rounded-xl px-3 py-2 ring-1 ${accent ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-900 ring-slate-200"}`}>
      <div className={`text-[11px] uppercase tracking-wide ${accent ? "text-slate-300" : "text-slate-500"}`}>{label}</div>
      <div className="mt-1 text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}

function LineVisual({
  line,
  market,
  slots,
  entries,
  entriesByLineAndSlot,
  slotMeta,
  highRunnerRecipes,
  picksPerWorker,
  staffingMode,
  rackZoom,
  onRackZoomChange,
  selectedFocus,
  recommendedEntriesBySlot,
  movedRecommendationByEntryId,
  locale,
  draggedEntryId,
  hoveredSlotKey,
  onHoverSlot,
  onDropToSlot,
  onPillDragStart,
  onPillDragEnd,
  onSelectSlot,
  onSelectEntry,
}: {
  line: string;
  market: RackMarket;
  slots: number[];
  entries: RackEntry[];
  entriesByLineAndSlot: Map<string, RackEntry[]>;
  slotMeta: Map<string, RackSlotMeta>;
  highRunnerRecipes: Set<string>;
  picksPerWorker: number;
  staffingMode: StaffingMode;
  rackZoom: number;
  onRackZoomChange: (nextZoom: number) => void;
  selectedFocus: SelectedRackFocus | null;
  recommendedEntriesBySlot: Map<string, RackEntry[]>;
  movedRecommendationByEntryId: Map<string, { before: RackEntry; after: RackEntry }>;
  locale: UiLocale;
  draggedEntryId: string | null;
  hoveredSlotKey: string | null;
  onHoverSlot: (slotKey: string | null) => void;
  onDropToSlot: (line: string, flowRackPosition: string) => void;
  onPillDragStart: (entryId: string) => void;
  onPillDragEnd: () => void;
  onSelectSlot: (line: string, position: string) => void;
  onSelectEntry: (entryId: string, line: string, position: string) => void;
}) {
  const accent = lineAccent(line);
  const lineEntries = entries.filter((entry) => entry.line === line);
  const slotColumns = buildSlotColumns(slots, slotMeta);
  const slotViolations = summarizeSlotViolations(lineEntries, slotMeta, highRunnerRecipes);
  const stationLoads = [...lineEntries.reduce((bucket, entry) => {
    const meta = slotMeta.get(entry.flowRackPosition.toUpperCase());
    const station = meta?.station || (locale === "de" ? "Ohne Station" : "No station");
    const current = bucket.get(station) ?? { station, demand: 0, entries: 0, middleRail: 0, highRunner: 0 };
    current.demand += meta?.demand || entry.quantity;
    current.entries += 1;
    current.middleRail += meta?.preferredPick ? 1 : 0;
    current.highRunner += highRunnerRecipes.has(entry.recipe) ? 1 : 0;
    bucket.set(station, current);
    return bucket;
  }, new Map<string, { station: string; demand: number; entries: number; middleRail: number; highRunner: number }>()).values()]
    .sort((a, b) => b.demand - a.demand || a.station.localeCompare(b.station));
  const totalStationDemand = stationLoads.reduce((sum, station) => sum + station.demand, 0);
  const estimatedWorkers = totalStationDemand > 0 ? totalStationDemand / picksPerWorker : 0;
  const occupiedSlots = slots.filter((slotNumber) => {
    const position = `F${String(slotNumber).padStart(2, "0")}`;
    return (entriesByLineAndSlot.get(`${line}:${position}`) ?? []).length > 0;
  }).length;
  const emptySlots = Math.max(slots.length - occupiedSlots, 0);
  const density = slots.length > 0 ? Math.round((occupiedSlots / slots.length) * 100) : 0;
  const topTierOccupied = slotColumns.filter((column) => {
    const topSlot = column.at(2);
    if (!topSlot) return false;
    return (entriesByLineAndSlot.get(`${line}:${topSlot.position}`) ?? []).length > 0;
  }).length;
  const middleRailUsed = slots.filter((slotNumber) => {
    const position = `F${String(slotNumber).padStart(2, "0")}`;
    return slotMeta.get(position)?.preferredPick && (entriesByLineAndSlot.get(`${line}:${position}`) ?? []).length > 0;
  }).length;
  const highRunnerOffMiddle = lineEntries.filter((entry) => {
    if (!highRunnerRecipes.has(entry.recipe)) return false;
    const meta = slotMeta.get(entry.flowRackPosition.toUpperCase());
    return meta ? !meta.preferredPick : true;
  }).length;
  const matrixColumnMinWidth = Math.round(148 * rackZoom);
  const miniMapMinWidth = Math.round(30 + rackZoom * 18);
  const miniMapCols = rackZoom <= 0.75 ? 14 : rackZoom <= 0.9 ? 12 : rackZoom <= 1.05 ? 10 : rackZoom <= 1.2 ? 8 : 6;
  const slotPadding = `${Math.max(8, Math.round(10 * rackZoom))}px`;
  const pillFontSize = `${Math.max(9, Math.round(10 * rackZoom))}px`;
  const metaFontSize = `${Math.max(9, Math.round(10 * rackZoom))}px`;

  return (
    <div className={`overflow-hidden rounded-[28px] border border-slate-200 bg-gradient-to-br ${accent.shell} p-4 sm:p-5 ${accent.glow}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className={lineBadge(line)}>{line}</span>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${accent.chip}`}>{locale === "de" ? "Aktive Förderlinie" : "Active conveyor line"}</span>
          </div>
          <div>
            <h4 className={`text-xl font-black tracking-tight ${accent.text}`}>{locale === "de" ? `${line} Rack-Linie` : `${line} rack lane`}</h4>
            <p className="mt-1 text-sm text-slate-600">
              {locale === "de"
                ? `Von ${slots.length > 0 ? `F${String(slots[0]).padStart(2, "0")}` : "-"} bis ${slots.length > 0 ? `F${String(slots[slots.length - 1]).padStart(2, "0")}` : "-"}. Die Fächer werden wie im Staffing echt dreietagig gebaut, also z. B. 13, 14, 15 übereinander.`
                : `From ${slots.length > 0 ? `F${String(slots[0]).padStart(2, "0")}` : "-"} to ${slots.length > 0 ? `F${String(slots[slots.length - 1]).padStart(2, "0")}` : "-"}. Compartments are rendered as real three-tier stacks, for example 13, 14, 15 vertically.`}
            </p>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide">
              <span className={`rounded-full px-2.5 py-1 ${accent.chip}`}>
                {market === "de" ? (locale === "de" ? "DE mit Liner-Bühne" : "DE with liner stage") : (locale === "de" ? "Nordics ohne Liner" : "Nordics without liner")}
              </span>
              <span className="rounded-full bg-white/70 px-2.5 py-1 text-slate-700 ring-1 ring-slate-200">
                {locale === "de" ? "Drag-and-drop Planung" : "Drag-and-drop planning"}
              </span>
            </div>
            <div className="mt-3 max-w-xl rounded-[24px] bg-white/78 p-3 ring-1 ring-white/75 backdrop-blur">
              <div className="flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                <span>{locale === "de" ? "Linienauslastung" : "Lane utilization"}</span>
                <span>{density}%</span>
              </div>
              <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-200">
                <div className={`h-full rounded-full bg-gradient-to-r ${accent.rail}`} style={{ width: `${Math.min(density, 100)}%` }} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide">
                <span className="rounded-full bg-white px-2.5 py-1 text-slate-700 ring-1 ring-slate-200">{locale === "de" ? `${occupiedSlots} belegt` : `${occupiedSlots} occupied`}</span>
                <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-900">{locale === "de" ? `${middleRailUsed} Mitte` : `${middleRailUsed} middle`}</span>
                <span className="rounded-full bg-sky-100 px-2.5 py-1 text-sky-900">{locale === "de" ? `${estimatedWorkers.toFixed(1)} MA Bedarf` : `${estimatedWorkers.toFixed(1)} worker load`}</span>
              </div>
            </div>
            <div className="mt-3 rounded-[22px] bg-white/78 p-2 ring-1 ring-white/75 backdrop-blur max-w-xl">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700"
                  onClick={() => onRackZoomChange(rackZoom - 0.1)}
                >
                  -
                </button>
                <div className="min-w-[140px] flex-1 px-1">
                  <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    <span>{locale === "de" ? `${line} Zoom` : `${line} zoom`}</span>
                    <span>{Math.round(rackZoom * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={65}
                    max={145}
                    step={5}
                    value={Math.round(rackZoom * 100)}
                    onChange={(event) => onRackZoomChange(Number(event.target.value) / 100)}
                    className="mt-1 w-full"
                  />
                </div>
                <button
                  type="button"
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700"
                  onClick={() => onRackZoomChange(rackZoom + 0.1)}
                >
                  +
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                  onClick={() => onRackZoomChange(0.9)}
                >
                  {locale === "de" ? "Reset" : "Reset"}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="grid min-w-[260px] grid-cols-3 gap-2 text-sm">
          <MiniStat label={locale === "de" ? "Slots" : "Slots"} value={slots.length} />
          <MiniStat label={locale === "de" ? "Belegt" : "Occupied"} value={occupiedSlots} />
          <MiniStat label={locale === "de" ? "Leer" : "Empty"} value={emptySlots} />
          <MiniStat label={locale === "de" ? "Items" : "Items"} value={lineEntries.length} />
          <MiniStat label={locale === "de" ? "Mittelschiene" : "Middle rail"} value={middleRailUsed} accent={middleRailUsed === 0 && lineEntries.length > 0} />
          <MiniStat label={locale === "de" ? "Highrunner falsch" : "High runners off"} value={highRunnerOffMiddle} accent={highRunnerOffMiddle > 0} />
          <MiniStat label={locale === "de" ? "Dichte" : "Density"} value={`${density}%`} accent={density >= 85} />
          <MiniStat label={locale === "de" ? "Etage 3 belegt" : "Tier 3 used"} value={topTierOccupied} accent={topTierOccupied > 0} />
          <MiniStat label={locale === "de" ? "Mitarbeiter" : "Workers"} value={estimatedWorkers > 0 ? estimatedWorkers.toFixed(1) : "0.0"} accent={estimatedWorkers >= 1} />
        </div>
      </div>

      <div className="mt-5 rounded-[24px] border border-white/60 bg-white/75 p-3 ring-1 ring-white/50 backdrop-blur">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "ASL Überblick" : "ASL overview"}</div>
          <div className="text-xs text-slate-500">{locale === "de" ? "Kompakte Säulenmatrix statt langer Scroll-Achse" : "Compact stacked matrix instead of a long scroll axis"}</div>
        </div>

        <div className="mb-4 grid gap-3 xl:grid-cols-[0.95fr_1.05fr]">
          <div className="rounded-[24px] border border-emerald-200 bg-[linear-gradient(135deg,rgba(16,185,129,0.18),rgba(255,255,255,0.96)),radial-gradient(circle_at_top_right,rgba(5,150,105,0.22),transparent_38%)] p-4 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.15)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-black uppercase tracking-[0.2em] text-emerald-800">{locale === "de" ? "Pick-Korridor" : "Pick corridor"}</div>
                <div className="mt-1 text-sm text-emerald-950">{locale === "de" ? "Mittelschiene priorisieren, obere Etage nur wenn nötig." : "Prioritize the middle rail and use the top tier only when needed."}</div>
              </div>
              <div className="rounded-2xl bg-emerald-700 px-3 py-2 text-right text-white shadow-sm">
                <div className="text-[11px] uppercase tracking-wide text-emerald-100">{locale === "de" ? "Mittelschiene genutzt" : "Middle rail used"}</div>
                <div className="text-2xl font-black tabular-nums">{middleRailUsed}</div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-2xl bg-white/85 px-3 py-2 ring-1 ring-emerald-200">
                <div className="font-semibold uppercase tracking-wide text-emerald-800">{locale === "de" ? "Highrunner korrekt" : "High runners on rail"}</div>
                <div className="mt-1 text-lg font-black text-emerald-950">{Math.max(lineEntries.filter((entry) => highRunnerRecipes.has(entry.recipe)).length - highRunnerOffMiddle, 0)}</div>
              </div>
              <div className="rounded-2xl bg-white/85 px-3 py-2 ring-1 ring-emerald-200">
                <div className="font-semibold uppercase tracking-wide text-emerald-800">{locale === "de" ? "Außerhalb Mitte" : "Off middle"}</div>
                <div className="mt-1 text-lg font-black text-rose-700">{highRunnerOffMiddle}</div>
              </div>
              <div className="rounded-2xl bg-white/85 px-3 py-2 ring-1 ring-emerald-200">
                <div className="font-semibold uppercase tracking-wide text-emerald-800">{locale === "de" ? "Obere Etage" : "Top tier used"}</div>
                <div className="mt-1 text-lg font-black text-slate-900">{topTierOccupied}</div>
              </div>
            </div>
            <div className="mt-3 rounded-2xl bg-white/85 px-3 py-3 ring-1 ring-emerald-200">
              <div className="text-[11px] font-black uppercase tracking-[0.18em] text-emerald-800">{locale === "de" ? "Optimierungsmodus" : "Optimization mode"}</div>
              <div className="mt-1 text-sm text-emerald-950">{staffingMode === "reduce" ? (locale === "de" ? "Mitarbeiter senken: Last bündeln und Wege reduzieren." : "Reduce workers: consolidate load and shorten travel.") : staffingMode === "increase" ? (locale === "de" ? "Mitarbeiter erhöhen: Last breiter über Stationen verteilen." : "Increase workers: spread load across more stations.") : (locale === "de" ? "Balanciert: Ergonomie und Stationslast ausgleichen." : "Balanced: even out ergonomics and station load.")}</div>
            </div>
          </div>

          <div className="rounded-[24px] border border-slate-200 bg-slate-50/90 p-4 ring-1 ring-slate-200/80">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">{locale === "de" ? "Stationslast" : "Station load"}</div>
                <div className="mt-1 text-sm text-slate-600">{locale === "de" ? "Echte Picksumme je Station aus dem Visualization-Sheet." : "Actual pick sum per station from the visualization sheet."}</div>
              </div>
              <div className="rounded-2xl bg-slate-900 px-3 py-2 text-right text-white">
                <div className="text-[11px] uppercase tracking-wide text-slate-300">{locale === "de" ? "Gesamtsumme" : "Total sum"}</div>
                <div className="text-2xl font-black tabular-nums">{Math.round(totalStationDemand)}</div>
              </div>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {stationLoads.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-300 px-3 py-4 text-sm text-slate-500">
                  {locale === "de" ? "Noch keine Stationslast verfügbar." : "No station load available yet."}
                </div>
              )}
              {stationLoads.map((station) => (
                <div key={`${line}-${station.station}`} className="rounded-2xl bg-white px-3 py-3 shadow-sm ring-1 ring-slate-200">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">{station.station}</div>
                      <div className="mt-1 text-2xl font-black tabular-nums text-slate-950">{Math.round(station.demand)}</div>
                    </div>
                    <div className="space-y-2 text-right">
                      <div className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
                        {station.entries} {locale === "de" ? "Einträge" : "entries"}
                      </div>
                      <div className="rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white">
                        {locale === "de" ? `${(station.demand / picksPerWorker).toFixed(1)} MA` : `${(station.demand / picksPerWorker).toFixed(1)} FTE`}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide">
                    <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-900">{locale === "de" ? `Mitte ${station.middleRail}` : `Middle ${station.middleRail}`}</span>
                    <span className="rounded-full bg-sky-100 px-2.5 py-1 text-sky-900">{locale === "de" ? `Anteil ${totalStationDemand > 0 ? Math.round((station.demand / totalStationDemand) * 100) : 0}%` : `Share ${totalStationDemand > 0 ? Math.round((station.demand / totalStationDemand) * 100) : 0}%`}</span>
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-900">{locale === "de" ? `Highrunner ${station.highRunner}` : `High runner ${station.highRunner}`}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mb-4 grid gap-2 md:grid-cols-3">
          {[1, 2, 3].map((tier) => (
            <div key={tier} className={`rounded-2xl border px-3 py-2 text-xs ${tierTone(tier as 1 | 2 | 3)}`}>
              <div className="font-bold uppercase tracking-wide">{tierLabel(tier as 1 | 2 | 3, locale)}</div>
              <div className="mt-1 opacity-80">
                {tier < 3
                  ? (locale === "de" ? "Direkte Arbeitszone in der Säule." : "Primary working zone in the column.")
                  : (locale === "de" ? "Obere Etage, möglichst sparsam belegen." : "Top tier, use sparingly when possible.")}
              </div>
            </div>
          ))}
        </div>

        <div className="pb-3">
          <div className="relative px-2 pt-4">
            <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-white/70 bg-white/70 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 shadow-[0_18px_30px_-28px_rgba(15,23,42,0.45)] backdrop-blur">
              <span>{locale === "de" ? "Förderachse" : "Conveyor axis"}</span>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-900">{locale === "de" ? "Mitte = Pick-Korridor" : "Middle = pick corridor"}</span>
                <span className="rounded-full bg-rose-100 px-2 py-1 text-rose-900">{locale === "de" ? "Oben = Reserve" : "Top = reserve"}</span>
              </div>
            </div>
            <div className="mb-4 rounded-[24px] border border-slate-200 bg-[linear-gradient(135deg,rgba(255,255,255,0.9),rgba(241,245,249,0.95))] p-3 shadow-[inset_0_0_0_1px_rgba(148,163,184,0.08)]">
              <div className="flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                <span>{locale === "de" ? "Linienfluss" : "Line flow"}</span>
                <span>{locale === "de" ? `${slotColumns.length} Säulen kompakt umgebrochen` : `${slotColumns.length} wrapped columns`}</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                <div className={`h-full rounded-full bg-gradient-to-r ${accent.rail}`} style={{ width: "100%" }} />
              </div>
              <div
                className="mt-3 grid gap-1"
                style={{ gridTemplateColumns: `repeat(${miniMapCols}, minmax(${miniMapMinWidth}px, 1fr))` }}
              >
                {slotColumns.map((column, columnIndex) => {
                  const columnActive = column.some((slot) => (entriesByLineAndSlot.get(`${line}:${slot.position}`) ?? []).length > 0);
                  return (
                    <button
                      key={`${line}-minimap-${columnIndex}`}
                      type="button"
                      onClick={() => onSelectSlot(line, column[1]?.position ?? column[0]?.position ?? "")}
                      className={`rounded-xl px-2 py-2 text-[10px] font-bold transition ${columnActive ? `${accent.chip} shadow-sm` : "bg-white text-slate-500 ring-1 ring-slate-200"}`}
                    >
                      {column.map((slot) => slot.position.replace("F", "")).join("/")}
                    </button>
                  );
                })}
              </div>
            </div>
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${matrixColumnMinWidth}px, 1fr))` }}
            >
              {slotColumns.map((column, columnIndex) => {
                return (
                  <div key={`${line}-column-${columnIndex}`} className="relative min-w-0">
                    <div className={`absolute left-1/2 top-[-0.3rem] h-3.5 w-1 -translate-x-1/2 rounded-full ${column.some((slot) => (entriesByLineAndSlot.get(`${line}:${slot.position}`) ?? []).length > 0) ? accent.chip : "bg-slate-300"}`} />
                    <div className="rounded-[20px] border border-slate-200/80 bg-white/82 p-2.5 shadow-sm backdrop-blur">
                      <div className="mb-2 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                        <span>{locale === "de" ? "Säule" : "Column"} {columnIndex + 1}</span>
                        <span>{column.map((slot) => slot.position.replace("F", "")).join(" / ")}</span>
                      </div>
                      <div className="space-y-1.5">
                        {[...column].reverse().map((slot) => {
                          const slotEntries = entriesByLineAndSlot.get(`${line}:${slot.position}`) ?? [];
                          const occupied = slotEntries.length > 0;
                          const slotKey = `${line}:${slot.position}`;
                          const isHovered = hoveredSlotKey === slotKey;
                          const meta = slotMeta.get(slot.position);
                          const isMiddleRail = meta?.preferredPick ?? slot.tier === 2;
                          const violationReasons = slotViolations.get(slot.position) ?? [];
                          const recommendedEntries = recommendedEntriesBySlot.get(slotKey) ?? [];
                          const isSelected = selectedFocus?.line === line && selectedFocus.position.toUpperCase() === slot.position.toUpperCase();
                          return (
                            <button
                              type="button"
                              key={slotKey}
                              className={`relative overflow-hidden rounded-[18px] border p-2.5 text-left transition-all duration-300 ${occupied ? `${accent.slot} shadow-sm` : accent.slotEmpty} ${slot.tier === 3 ? "ring-1 ring-rose-200" : ""} ${isMiddleRail ? "border-emerald-300 bg-[linear-gradient(135deg,rgba(16,185,129,0.16),rgba(255,255,255,0.92))] ring-2 ring-emerald-400 shadow-[0_14px_24px_-22px_rgba(5,150,105,0.95)]" : ""} ${violationReasons.length > 0 ? "border-rose-300 bg-[linear-gradient(135deg,rgba(251,113,133,0.18),rgba(255,255,255,0.95))] ring-2 ring-rose-400 shadow-[0_14px_24px_-22px_rgba(225,29,72,0.85)]" : ""} ${isSelected ? "-translate-y-0.5 ring-2 ring-slate-900 ring-offset-2 shadow-[0_18px_28px_-24px_rgba(15,23,42,0.85)]" : ""} ${isHovered ? "ring-2 ring-slate-900 ring-offset-2" : ""}`}
                              style={{ padding: slotPadding }}
                              onClick={() => onSelectSlot(line, slot.position)}
                              onDoubleClick={() => {
                                onSelectSlot(line, slot.position);
                                onRackZoomChange(Math.max(rackZoom, 1.1));
                              }}
                              onDragOver={(event) => {
                                event.preventDefault();
                                onHoverSlot(slotKey);
                              }}
                              onDragLeave={() => onHoverSlot(null)}
                              onDrop={(event) => {
                                event.preventDefault();
                                onDropToSlot(line, slot.position);
                              }}
                            >
                              {isMiddleRail && <div className="pointer-events-none absolute inset-y-0 left-0 w-1.5 bg-emerald-500" />}
                              {recommendedEntries.length > 0 && <div className="pointer-events-none absolute inset-x-2 top-1 h-1 rounded-full bg-sky-400/90 animate-pulse" />}
                              <div className="flex items-center justify-between gap-2">
                                <div>
                                  <div className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">{slot.position}</div>
                                  <div className="mt-0.5 text-slate-500" style={{ fontSize: metaFontSize }}>{meta?.preferredPick ? (locale === "de" ? `${tierLabel(slot.tier, locale)} · Mittelschiene` : `${tierLabel(slot.tier, locale)} · Middle rail`) : tierLabel(slot.tier, locale)}</div>
                                </div>
                                <div className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${meta?.highRunner ? "bg-emerald-600 text-white" : slot.tier === 3 ? "bg-rose-600 text-white" : occupied ? accent.chip : "bg-slate-200 text-slate-600"}`}>{slotEntries.length}</div>
                              </div>

                              <div className="mt-2 space-y-1">
                                {recommendedEntries.length > 0 && (
                                  <div className="rounded-xl border border-sky-200 bg-sky-50 px-2 py-1.5 text-[10px] font-semibold text-sky-900 shadow-[0_8px_18px_-12px_rgba(14,165,233,0.9)] animate-[pulse_3s_ease-in-out_infinite]">
                                    <div className="uppercase tracking-wide text-sky-700">{locale === "de" ? "Empfohlener Zielslot" : "Recommended target slot"}</div>
                                    <div className="mt-1 space-y-1">
                                      {recommendedEntries.map((entry) => <div key={`${slotKey}-${entry.id}`}>{entry.recipe}</div>)}
                                    </div>
                                  </div>
                                )}
                                {violationReasons.length > 0 && (
                                  <div className="rounded-xl border border-rose-200 bg-rose-50 px-2 py-1.5 text-[10px] font-semibold text-rose-900">
                                    <div className="uppercase tracking-wide text-rose-700">{locale === "de" ? "Regelverstoß" : "Rule violation"}</div>
                                    <div className="mt-1 space-y-1">
                                      {violationReasons.map((reason) => <div key={`${slot.position}-${reason}`}>{reason}</div>)}
                                    </div>
                                  </div>
                                )}
                                {meta?.highRunner && (
                                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[10px] font-semibold text-emerald-900">
                                    {locale === "de" ? `Highrunner · Demand ${meta.demand}` : `High runner · demand ${meta.demand}`}
                                  </div>
                                )}
                                {slotEntries.map((entry) => {
                                  const kind = deriveEntryKind(entry);
                                  const isDragged = draggedEntryId === entry.id;
                                  const isHighRunner = highRunnerRecipes.has(entry.recipe);
                                  return (
                                    <button
                                      key={entry.id}
                                      type="button"
                                      draggable
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        onSelectEntry(entry.id, line, slot.position);
                                      }}
                                      onDoubleClick={(event) => {
                                        event.stopPropagation();
                                        onSelectEntry(entry.id, line, slot.position);
                                        onRackZoomChange(Math.max(rackZoom, 1.1));
                                      }}
                                      onDragStart={() => onPillDragStart(entry.id)}
                                      onDragEnd={onPillDragEnd}
                                      className={`flex w-full items-center justify-between gap-1.5 rounded-full border px-2.5 py-1.5 text-left text-[10px] font-semibold transition-all duration-300 ${kindTone(kind)} ${isHighRunner ? "ring-2 ring-emerald-300" : ""} ${movedRecommendationByEntryId.has(entry.id) ? "shadow-[0_10px_24px_-16px_rgba(14,165,233,0.9)] ring-2 ring-sky-300" : ""} ${isDragged ? "scale-[0.98] opacity-60" : "hover:-translate-y-0.5 hover:shadow-sm"}`}
                                      style={{ fontSize: pillFontSize }}
                                      title={locale === "de" ? "Zum Verschieben ziehen" : "Drag to move"}
                                    >
                                      <span className="truncate">{entry.recipe}</span>
                                      <span className="flex items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 text-[9px] font-bold">
                                        {movedRecommendationByEntryId.has(entry.id) && <span className="text-sky-700">↗</span>}
                                        <span>x{entry.quantity}</span>
                                      </span>
                                    </button>
                                  );
                                })}
                                {!occupied && (
                                  <div className="rounded-full border border-dashed border-slate-200 px-2.5 py-1.5 text-center text-[10px] text-slate-400">
                                    {locale === "de" ? "frei" : "free"}
                                  </div>
                                )}
                              </div>
                            </button>
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
    </div>
  );
}