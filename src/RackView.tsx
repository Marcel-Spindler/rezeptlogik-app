import React, { useEffect, useMemo, useRef, useState } from "react";
import { loadDynamicModule } from "./dynamicImport";
import type { UiLocale } from "./i18n";
import {
  RACK_MARKET_PROFILES,
  applyPdlFilter,
  deriveEntryKind,
  exportRackfileCsv,
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

type RackDisplayTab = "visual" | "line" | "detail";

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

type SlotColumn = Array<{ slotNumber: number; position: string; tier: 1 | 2 | 3 }>;

type BlueprintUnit = {
  kind: "column" | "gap";
  key: string;
  widthUnits: number;
  column?: SlotColumn;
};

type ColumnBand = {
  label: string;
  firstPosition: string;
  positions: string[];
  columnCount: number;
  occupiedColumns: number;
  totalDemand: number;
  highRunnerCount: number;
};

type AreaZoneTemplate = {
  id: string;
  label: string;
  subtitle: string;
  note: string;
  spanClass: string;
  shell: string;
  border: string;
  text: string;
};

type HallRoleRails = {
  left: string[];
  right: string[];
};

type PickfaceWindow = {
  id: string;
  min: number;
  max: number;
  pickerNumber?: number;
  maxTier?: 2 | 3;
  area?: "chilled" | "mealkit" | "gifts";
  /** Visueller Abstand (Pixel) vor diesem Pickface in der LineLaneBoard-Darstellung. */
  gapPx?: number;
  /** Hinweis für den Optimierer: hier dürfen Highrunner-Überläufer rein, falls Platz knapp wird. */
  highRunnerOverflow?: boolean;
  /** Pufferzone zwischen zwei Pickern – kein fester Picker, optional zuschaltbar. */
  zuschaltbar?: boolean;
  /** Laufende Nummer des zuschaltbaren Blocks (1–N, fortlaufend über alle Zuschaltbar-Blöcke). */
  blockNumber?: number;
  /** Physische Wand vor diesem Pickface – wird als dicke massive Säule dargestellt. */
  wallBefore?: boolean;
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
  if (!rackWorkbookModulePromise) {
    rackWorkbookModulePromise = loadDynamicModule("rack-workbook", () => import("./rackWorkbook")).catch((error) => {
      rackWorkbookModulePromise = null; // Reset so next call retries instead of returning cached rejection
      throw error;
    });
  }
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
  const bucket = new Map<number, SlotColumn>();

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

function buildBlueprintUnits(slotColumns: SlotColumn[], slotMeta: Map<string, RackSlotMeta>) {
  const units: BlueprintUnit[] = [];
  let previousLayoutColumn: number | null = null;

  slotColumns.forEach((column, index) => {
    const anchor = column[0]?.position;
    const layoutColumn = anchor ? slotMeta.get(anchor)?.layoutColumn ?? index + 1 : index + 1;
    if (previousLayoutColumn !== null && layoutColumn - previousLayoutColumn > 1) {
      units.push({
        kind: "gap",
        key: `gap-${previousLayoutColumn}-${layoutColumn}`,
        widthUnits: layoutColumn - previousLayoutColumn - 1,
      });
    }

    units.push({
      kind: "column",
      key: `column-${layoutColumn}-${index}`,
      widthUnits: 1,
      column,
    });

    previousLayoutColumn = layoutColumn;
  });

  return units;
}

function buildStationBandsForColumns(line: string, slotColumns: SlotColumn[], slotMeta: Map<string, RackSlotMeta>, locale: UiLocale) {
  const bands: Array<{ label: string; span: number; firstPosition: string }> = [];
  for (const column of slotColumns) {
    const anchor = pickColumnAnchor(column);
    const meta = column.map((slot) => slotMeta.get(slot.position)).find(Boolean);
    const label = meta?.station?.trim() || (locale === "de" ? "Ohne Station" : "No station");
    const previous = bands.at(-1);
    if (previous && previous.label === label) {
      previous.span += 1;
      continue;
    }
    bands.push({ label, span: 1, firstPosition: anchor || `${line}:${bands.length}` });
  }
  return bands;
}

function buildTypeBandsForColumns(slotColumns: SlotColumn[], slotMeta: Map<string, RackSlotMeta>, locale: UiLocale) {
  const bands: Array<{ label: string; span: number }> = [];
  for (const column of slotColumns) {
    const meta = column.map((slot) => slotMeta.get(slot.position)).find(Boolean);
    const label = meta?.type?.trim() || (locale === "de" ? "Leerzone" : "Empty zone");
    const previous = bands.at(-1);
    if (previous && previous.label === label) {
      previous.span += 1;
      continue;
    }
    bands.push({ label, span: 1 });
  }
  return bands;
}

function blueprintHeaderSegments(market: RackMarket, locale: UiLocale) {
  if (market === "de") {
    return {
      title: locale === "de" ? "DE Hallenbild" : "DE floor view",
      lanes: [
        { label: "MIT P2L", span: 18, tone: "bg-amber-50 text-amber-950 ring-amber-200" },
        { label: "OHNE P2L", span: 13, tone: "bg-slate-50 text-slate-950 ring-slate-200" },
      ],
      roles: [
        { label: locale === "de" ? "1 Box-Aufsteller" : "1 box setter", span: 2 },
        { label: locale === "de" ? "2 Liner MA" : "2 liner MA", span: 3 },
        { label: locale === "de" ? "1 Picker" : "1 picker", span: 6 },
        { label: locale === "de" ? "1 Picker" : "1 picker", span: 4 },
        { label: locale === "de" ? "1 Picker" : "1 picker", span: 4 },
        { label: locale === "de" ? "1 Picker" : "1 picker", span: 4 },
        { label: locale === "de" ? "1 Picker" : "1 picker", span: 4 },
        { label: locale === "de" ? "1 Picker" : "1 picker", span: 2 },
        { label: locale === "de" ? "1. Waage" : "1st scale", span: 2 },
      ],
    };
  }

  return {
    title: locale === "de" ? "Nordics (Dänemark/Schweden)" : "Nordics (Denmark/Sweden)",
    lanes: [
      { label: locale === "de" ? "Nordics (Dänemark/Schweden)" : "Nordics (Denmark/Sweden)", span: 22, tone: "bg-amber-50 text-amber-950 ring-amber-200" },
    ],
    roles: [
      { label: locale === "de" ? "1 Box-Aufsteller" : "1 box setter", span: 3 },
      { label: locale === "de" ? "1 Picker" : "1 picker", span: 5 },
      { label: locale === "de" ? "1 Picker" : "1 picker", span: 3 },
      { label: locale === "de" ? "1 Picker" : "1 picker", span: 3 },
      { label: locale === "de" ? "1 Picker" : "1 picker", span: 3 },
      { label: locale === "de" ? "1 Picker" : "1 picker", span: 3 },
      { label: locale === "de" ? "1 Picker" : "1 picker", span: 1 },
      { label: locale === "de" ? "1. Waage" : "1st scale", span: 1 },
    ],
  };
}

function slotTypeTone(type: string) {
  const normalized = type.trim().toLowerCase();
  if (normalized.includes("liner")) return "bg-blue-100 text-blue-900 ring-blue-200";
  if (normalized.includes("box")) return "bg-amber-100 text-amber-900 ring-amber-200";
  if (normalized.includes("meal")) return "bg-emerald-100 text-emerald-900 ring-emerald-200";
  if (normalized.includes("p2l")) return "bg-fuchsia-100 text-fuchsia-900 ring-fuchsia-200";
  return "bg-slate-100 text-slate-800 ring-slate-200";
}

function pickColumnAnchor(column: SlotColumn) {
  return column.find((slot) => slot.tier === 2)?.position ?? column[1]?.position ?? column[0]?.position ?? "";
}

function buildColumnBands(
  line: string,
  slotColumns: SlotColumn[],
  slotMeta: Map<string, RackSlotMeta>,
  entriesByLineAndSlot: Map<string, RackEntry[]>,
  highRunnerRecipes: Set<string>,
  key: "station" | "type",
  locale: UiLocale,
) {
  const bands: ColumnBand[] = [];

  for (const column of slotColumns) {
    const meta = column.map((slot) => slotMeta.get(slot.position)).find(Boolean);
    const rawLabel = key === "station"
      ? meta?.station?.trim() || (locale === "de" ? "Ohne Station" : "No station")
      : meta?.type?.trim() || (locale === "de" ? "Ohne Typ" : "No type");
    const positions = column.map((slot) => slot.position);
    const occupiedColumns = column.some((slot) => (entriesByLineAndSlot.get(`${line}:${slot.position}`) ?? []).length > 0) ? 1 : 0;
    const totalDemand = positions.reduce((sum, position) => sum + (slotMeta.get(position)?.demand ?? 0), 0);
    const highRunnerCount = positions.reduce((sum, position) => {
      return sum + (entriesByLineAndSlot.get(`${line}:${position}`) ?? []).filter((entry) => highRunnerRecipes.has(entry.recipe)).length;
    }, 0);
    const previous = bands.at(-1);

    if (previous && previous.label === rawLabel) {
      previous.positions.push(...positions);
      previous.columnCount += 1;
      previous.occupiedColumns += occupiedColumns;
      previous.totalDemand += totalDemand;
      previous.highRunnerCount += highRunnerCount;
      continue;
    }

    bands.push({
      label: rawLabel,
      firstPosition: pickColumnAnchor(column),
      positions: [...positions],
      columnCount: 1,
      occupiedColumns,
      totalDemand,
      highRunnerCount,
    });
  }

  return bands;
}

function areaZoneTemplates(market: RackMarket, locale: UiLocale): AreaZoneTemplate[] {
  if (market === "de") {
    return [
      {
        id: "packaging",
        label: "Packaging",
        subtitle: locale === "de" ? "Box-Aufsteller, Liner und Picker" : "Box setup, liner and pickers",
        note: locale === "de" ? "Vorlauf links wie im Hallenbild." : "Front staging on the left, matching the floor layout.",
        spanClass: "md:col-span-3",
        shell: "from-orange-200 via-amber-100 to-white",
        border: "border-orange-300",
        text: "text-orange-950",
      },
      {
        id: "chilled",
        label: locale === "de" ? "Chilled Area" : "Chilled Area",
        subtitle: locale === "de" ? "Liner/Box-Bestückung und Meal-Vorstufe" : "Liner/box staging and meal pre-stage",
        note: locale === "de" ? "Mittelfeld für Materialfluss und Vorbereitungen." : "Mid section for material flow and staging.",
        spanClass: "md:col-span-4",
        shell: "from-sky-200 via-indigo-100 to-white",
        border: "border-sky-300",
        text: "text-sky-950",
      },
      {
        id: "mealkit",
        label: locale === "de" ? "Pick & Pack Area" : "Pick & Pack Area",
        subtitle: locale === "de" ? "Waage, Pack-Out und EOL rechts" : "Scale, pack-out and EOL on the right",
        note: locale === "de" ? "Rechte Seite für Aussteuerung, Pack-Out und EOL. (Keine Mealkits mehr.)" : "Right side for output, pack-out and EOL. (No mealkits.)",
        spanClass: "md:col-span-5",
        shell: "from-emerald-200 via-lime-100 to-white",
        border: "border-emerald-300",
        text: "text-emerald-950",
      },
    ];
  }

  return [
    {
      id: "packaging",
      label: "Packaging",
      subtitle: locale === "de" ? "Box-Aufsteller und Picker" : "Box setup and pickers",
      note: locale === "de" ? "Nordics startet ohne Liner-Strang in die Linie." : "Nordics starts without a liner branch.",
      spanClass: "md:col-span-3",
      shell: "from-orange-200 via-amber-100 to-white",
      border: "border-orange-300",
      text: "text-orange-950",
    },
    {
      id: "chilled",
      label: locale === "de" ? "Chilled Area" : "Chilled Area",
      subtitle: locale === "de" ? "Bestückung und Meal-Vorstufe" : "Staging and meal pre-stage",
      note: locale === "de" ? "Mittlerer Korridor für gekühlte Vorstufen." : "Central corridor for chilled pre-stage work.",
      spanClass: "md:col-span-4",
      shell: "from-sky-200 via-indigo-100 to-white",
      border: "border-sky-300",
      text: "text-sky-950",
    },
    {
      id: "mealkit",
      label: locale === "de" ? "Pick & Pack Area" : "Pick & Pack Area",
      subtitle: locale === "de" ? "Waage, Pack-Out und EOL rechts" : "Scale, pack-out and EOL on the right",
      note: locale === "de" ? "Rechter Abschnitt – Linie voll in Betrieb, kein Mealkit-Betrieb mehr." : "Right section – line fully active, no mealkit production.",
      spanClass: "md:col-span-5",
      shell: "from-emerald-200 via-lime-100 to-white",
      border: "border-emerald-300",
      text: "text-emerald-950",
    },
  ];
}

function hallRoleRails(market: RackMarket, locale: UiLocale): HallRoleRails {
  if (market === "de") {
    return {
      left: [
        locale === "de" ? "1 Box-Aufsteller" : "1 box setter",
        locale === "de" ? "2 Liner MA" : "2 liner staff",
        locale === "de" ? "1 Picker" : "1 picker",
        locale === "de" ? "1 Liner / Box Bestücker" : "1 liner / box loader",
        locale === "de" ? "2 Bestücker Meals" : "2 meal loaders",
        locale === "de" ? "1 Läufer PCK und Meals" : "1 PCK and meals runner",
      ],
      right: [
        locale === "de" ? "1 Box-Schließer" : "1 box closer",
        locale === "de" ? "2 Abpacker" : "2 unpackers",
        locale === "de" ? "1 EOL Läufer" : "1 EOL runner",
        locale === "de" ? "1 PS" : "1 PS",
        locale === "de" ? "1. Waage" : "1st scale",
      ],
    };
  }

  return {
    left: [
      locale === "de" ? "1 Box-Aufsteller" : "1 box setter",
      locale === "de" ? "1 Picker" : "1 picker",
      locale === "de" ? "1 Box-Bestücker" : "1 box loader",
      locale === "de" ? "2 Bestücker Meals" : "2 meal loaders",
      locale === "de" ? "1 Läufer PCK und Meals" : "1 PCK and meals runner",
    ],
    right: [
      locale === "de" ? "1 Box-Schließer" : "1 box closer",
      locale === "de" ? "2 Abpacker" : "2 unpackers",
      locale === "de" ? "1 EOL Läufer" : "1 EOL runner",
      locale === "de" ? "1 PS" : "1 PS",
      locale === "de" ? "1. Waage" : "1st scale",
    ],
  };
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

function rackEntryHoverTitle(entry: RackEntry, slotMeta: Map<string, RackSlotMeta>, locale: UiLocale) {
  const position = entry.flowRackPosition.toUpperCase();
  const meta = slotMeta.get(position);
  const tier = meta?.level && meta.level >= 1 && meta.level <= 3 ? meta.level as 1 | 2 | 3 : 1;
  const kind = deriveEntryKind(entry);
  const kindLabel = locale === "de"
    ? kind === "meal" ? "Meal" : kind === "ice" ? "Eis" : kind === "packaging" ? "Verpackung" : kind
    : kind;
  const titleName = entry.displayName || entry.ingredient || "-";
  return [
    `${entry.recipe} · ${titleName}`,
    `${locale === "de" ? "Linie" : "Line"}: ${entry.line}`,
    `${locale === "de" ? "Fach" : "Slot"}: ${position} (${tierLabel(tier, locale)})`,
    `${locale === "de" ? "Station" : "Station"}: ${meta?.station || "-"}`,
    `${locale === "de" ? "Menge" : "Qty"}: ${entry.quantity}`,
    `${locale === "de" ? "Typ" : "Kind"}: ${kindLabel}`,
  ].join("\n");
}

// A: Farbcodierung nach Eintragstyp für das Rack-Band
function slotEntryKindColor(slotEntries: RackEntry[]): string {
  if (slotEntries.length === 0) return "bg-slate-100 text-slate-500";
  const counts = new Map<string, number>();
  for (const entry of slotEntries) {
    const k = deriveEntryKind(entry);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] as ReturnType<typeof deriveEntryKind>;
  switch (dominant) {
    case "meal": return "bg-emerald-500 text-white";
    case "packaging": return "bg-slate-500 text-white";
    case "ice": return "bg-cyan-400 text-white";
    case "loyalty": return "bg-amber-400 text-white";
    case "beverage": return "bg-fuchsia-500 text-white";
    case "protein": return "bg-rose-500 text-white";
    default: return "bg-violet-400 text-white";
  }
}

// C: Vorwoche berechnen
function isoWeeksInYear(year: number): number {
  // Ein Jahr hat 53 ISO-Wochen wenn der 31.12. oder der 01.01. ein Donnerstag ist
  const jan1 = new Date(year, 0, 1).getDay(); // 0=So, 4=Do
  const dec31 = new Date(year, 11, 31).getDay();
  return jan1 === 4 || dec31 === 4 ? 53 : 52;
}

function prevWeekString(week: string): string {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(week);
  if (!match) return "";
  const y = Number(match[1]);
  const w = Number(match[2]);
  if (w <= 1) return `${y - 1}-W${String(isoWeeksInYear(y - 1)).padStart(2, "0")}`;
  return `${y}-W${String(w - 1).padStart(2, "0")}`;
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

function frontTierForSlotNumber(slotNumber: number, market: RackMarket): 1 | 2 | 3 {
  if (slotNumber <= 5) return 1;
  // Vorzone 2-Tier: Slots 6–12 (beide Märkte identisch)
  if (slotNumber <= 12) return slotNumber % 2 === 1 ? 1 : 2;
  // 2-Tier-Pickfächer: DE ab Slot 103, Nordics ab Slot 105
  const twoTierCutoff = market === "de" ? 103 : 105;
  if (slotNumber >= twoTierCutoff) return slotNumber % 2 === 1 ? 1 : 2;
  // 3-Tier-Zone: Slots 13–102 (DE) / 13–104 (Nordics)
  const tier = ((slotNumber - 13) % 3 + 3) % 3;
  return (tier + 1) as 1 | 2 | 3;
}

function ergonomicTierRank(meta: RackSlotMeta | undefined, flowRackPosition?: string, market?: RackMarket) {
  if (meta?.preferredPick) return 0; // Greifzone = bestes Pick-Level
  if (meta?.level === 2) return 1;   // Mittelschiene = ergonomisch gut
  if (meta?.level === 3) return 2;   // Unterschiene = akzeptabel
  if (meta?.level === 1) return 3;   // Oberschiene = ergonomisch schlecht (Überkopf-Griff)
  if (flowRackPosition && market) {
    const slotNumber = rackPositionNumber(flowRackPosition);
    const tier = frontTierForSlotNumber(slotNumber, market);
    if (tier === 2) return 1;
    if (tier === 3) return 2;
    return 3; // tier 1 = Oberschiene = schlechtester Platz
  }
  return 2;
}

function articleZoneTarget(entry: RackEntry) {
  const kind = deriveEntryKind(entry);
  if (kind === "packaging") return 0.08;
  if (kind === "meal") return 0.45;
  if (kind === "protein") return 0.55;
  if (kind === "ice") return 0.62;
  if (kind === "beverage") return 0.72;
  if (kind === "loyalty") return 0.92;
  return 0.5;
}

function pickfaceWindowsForMarket(market: RackMarket): PickfaceWindow[] {
  if (market === "de") {
    return [
      // Zuschaltbare Liner-Vorzone (Slots 13–27) → Blöcke 1 & 2.
      { id: "zuschalt-liner-a", min: 13, max: 18, maxTier: 3, area: "chilled", gapPx: 14, zuschaltbar: true, blockNumber: 1 },
      { id: "zuschalt-liner-b", min: 19, max: 27, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 2 },
      // Chilled Area – 3 Ebenen, jeder Picker eigenständig.
      { id: "p1", min: 28, max: 36, pickerNumber: 1, maxTier: 3, area: "chilled", gapPx: 18 },
      // Zuschaltbare Pufferzonen zwischen P1 und P2 (Slots 37–54) → Blöcke 3 & 4.
      { id: "zuschalt-p1p2-a", min: 37, max: 45, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 3 },
      { id: "zuschalt-p1p2-b", min: 46, max: 54, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 4 },
      { id: "p2", min: 55, max: 63, pickerNumber: 2, maxTier: 3, area: "chilled", gapPx: 18 },
      // Zuschaltbare Pufferzonen zwischen P2 und P3 (Slots 64–84) → Blöcke 5, 6 & 7.
      { id: "zuschalt-p2p3-a", min: 64, max: 72, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 5 },
      { id: "zuschalt-p2p3-b", min: 73, max: 78, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 6 },
      { id: "zuschalt-p2p3-c", min: 79, max: 84, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 7 },
      // Picker 3: kleineres Fenster – darf bei Bedarf 1–2 Highrunner aufnehmen.
      { id: "p3", min: 85, max: 90, pickerNumber: 3, maxTier: 3, area: "chilled", gapPx: 18, highRunnerOverflow: true },
      // Physische Trennung Chilled → Mealkit.
      { id: "p4", min: 91, max: 102, pickerNumber: 4, maxTier: 3, area: "mealkit", gapPx: 28, wallBefore: true },
      // Mealkit-Bereich Picker 5–8: nur 2 Ebenen (Tier 1 + Tier 2, keine Oberschiene).
      { id: "p5", min: 103, max: 112, pickerNumber: 5, maxTier: 2, area: "mealkit", gapPx: 18 },
      // Zuschaltbarer Block 8 (Slots 113–120) zwischen P5 und P6.
      { id: "zuschalt-p5p6", min: 113, max: 120, maxTier: 2, area: "mealkit", gapPx: 12, zuschaltbar: true, blockNumber: 8 },
      { id: "p6", min: 121, max: 128, pickerNumber: 6, maxTier: 2, area: "mealkit", gapPx: 12 },
      // Picker 7–8: Gifts / Flyer / Eis – hinterer Bereich, 2 Ebenen.
      { id: "p7", min: 129, max: 136, pickerNumber: 7, maxTier: 2, area: "gifts", gapPx: 28 },
      { id: "p8", min: 137, max: 144, pickerNumber: 8, maxTier: 2, area: "gifts", gapPx: 18 },
    ];
  }

  // Nordics: 7 Picker + 7 zuschaltbare Pufferzonen = 14 Windows.
  // Gleiche Struktur wie DE – Liner-Vorzone + Picker + Zuschaltbar-Buffer.
  return [
    // Zuschaltbare Liner-Vorzone (Slots 13–27) → Blöcke 1 & 2.
    { id: "zuschalt-liner-a", min: 13, max: 18, maxTier: 3, area: "chilled", gapPx: 14, zuschaltbar: true, blockNumber: 1 },
    { id: "zuschalt-liner-b", min: 19, max: 27, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 2 },
    // Chilled Area – 3 Ebenen.
    { id: "p1", min: 28, max: 36, pickerNumber: 1, maxTier: 3, area: "chilled", gapPx: 18 },
    // Zuschaltbare Pufferzonen zwischen P1 und P2 (Slots 37–54) → Blöcke 3 & 4.
    { id: "zuschalt-p1p2-a", min: 37, max: 45, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 3 },
    { id: "zuschalt-p1p2-b", min: 46, max: 54, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 4 },
    { id: "p2", min: 55, max: 63, pickerNumber: 2, maxTier: 3, area: "chilled", gapPx: 18 },
    // Zuschaltbare Pufferzonen zwischen P2 und P3 (Slots 64–84) → Blöcke 5 & 6.
    { id: "zuschalt-p2p3-a", min: 64, max: 72, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 5 },
    { id: "zuschalt-p2p3-b", min: 73, max: 84, maxTier: 3, area: "chilled", gapPx: 12, zuschaltbar: true, blockNumber: 6 },
    // Picker 3: etwas breiter als in DE – übernimmt bei Bedarf Highrunner-Overflow.
    { id: "p3", min: 85, max: 93, pickerNumber: 3, maxTier: 3, area: "chilled", gapPx: 18, highRunnerOverflow: true },
    // Physische Trennung Chilled → Mealkit.
    { id: "p4", min: 94, max: 104, pickerNumber: 4, maxTier: 3, area: "mealkit", gapPx: 28, wallBefore: true },
    // Mealkit-Bereich: nur 2 Ebenen (twoTierCutoff = 105 für Nordics).
    { id: "p5", min: 105, max: 112, pickerNumber: 5, maxTier: 2, area: "mealkit", gapPx: 18 },
    // Zuschaltbarer Block 7 (Slots 113–118) zwischen P5 und P6.
    { id: "zuschalt-p5p6", min: 113, max: 118, maxTier: 2, area: "mealkit", gapPx: 12, zuschaltbar: true, blockNumber: 7 },
    { id: "p6", min: 119, max: 130, pickerNumber: 6, maxTier: 2, area: "mealkit", gapPx: 12 },
    // Picker 7: Gifts / Eis – hinterer Bereich, 2 Ebenen.
    { id: "p7", min: 131, max: 144, pickerNumber: 7, maxTier: 2, area: "gifts", gapPx: 28 },
  ];
}

function findPickfaceForSlotNumber(slotNumber: number, market: RackMarket): PickfaceWindow | undefined {
  return pickfaceWindowsForMarket(market).find((window) => slotNumber >= window.min && slotNumber <= window.max);
}

function pickfaceBaseWindowCount(market: RackMarket) {
  // Anzahl Pickfenster im Standard-Hallenbild (alle aktiv darstellen).
  // DE: 8 Picker + 8 zuschaltbare Pufferzonen = 16 Windows.
  // Nordics: 7 Picker + 7 zuschaltbare Pufferzonen = 14 Windows.
  return market === "de" ? 16 : 14;
}

function pickfaceWindowLabel(window: PickfaceWindow, locale: UiLocale) {
  if (window.zuschaltbar) {
    const block = window.blockNumber ? ` ${window.blockNumber}` : "";
    return locale === "de"
      ? `Zuschaltbar${block} (F${window.min}-F${window.max})`
      : `Add-on${block} (F${window.min}-F${window.max})`;
  }
  const picker = window.pickerNumber ? `P${window.pickerNumber}` : window.id.toUpperCase();
  return `${picker} (F${window.min}-F${window.max})`;
}

function pickfaceDelta(previous: PickfaceWindow[], next: PickfaceWindow[]) {
  const previousIds = new Set(previous.map((window) => window.id));
  const nextIds = new Set(next.map((window) => window.id));
  const opened = next.filter((window) => !previousIds.has(window.id));
  const closed = previous.filter((window) => !nextIds.has(window.id));
  return { opened, closed };
}

function buildActivePickfaceWindows(market: RackMarket, plannedWorkersRounded: number, hallLayoutWorkers: number): PickfaceWindow[] {
  const allWindows = pickfaceWindowsForMarket(market);
  if (allWindows.length === 0) return [];
  const baseCount = pickfaceBaseWindowCount(market);
  const deltaWorkers = plannedWorkersRounded - hallLayoutWorkers;
  const activeCount = Math.max(1, Math.min(allWindows.length, baseCount + deltaWorkers));
  return allWindows.slice(0, activeCount);
}

function isPositionInPickfaceWindows(position: string, activePickfaceWindows: PickfaceWindow[]) {
  if (activePickfaceWindows.length === 0) return false;
  const slotNumber = rackPositionNumber(position);
  if (!Number.isFinite(slotNumber) || slotNumber === Number.MAX_SAFE_INTEGER) return true;
  return activePickfaceWindows.some((window) => slotNumber >= window.min && slotNumber <= window.max);
}

function pickfaceStartSlot(market: RackMarket) {
  // DE: Box-Aufsteller (1–5) + 2 Liner MA (6–13) + zuschaltbare Liner-Vorzone bis Slot 27.
  // Nordics: Box-Aufsteller (1–5) + Lager-Vorzone (6–27) ohne festen Picker — Pickface startet bei 28.
  return market === "de" ? 28 : 28;
}

/**
 * Liefert alle physisch existierenden Slot-Nummern für den Markt:
 * - Vorzone 1 bis (pickfaceStartSlot - 1)
 * - Alle Slots in jedem Pickface-Fenster (auch Lücken zwischen Fenstern bleiben raus)
 */
function fullHallSlotsForMarket(market: RackMarket): number[] {
  const set = new Set<number>();
  const start = pickfaceStartSlot(market);
  for (let n = 1; n < start; n++) set.add(n);
  for (const window of pickfaceWindowsForMarket(market)) {
    for (let n = window.min; n <= window.max; n++) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

function isSlotNumberActiveByWorkers(slotNumber: number, market: RackMarket, activePickfaceWindows: PickfaceWindow[]) {
  if (!Number.isFinite(slotNumber) || slotNumber === Number.MAX_SAFE_INTEGER) return false;
  // Vorzone (Box/Liner etc.) bleibt immer planbar.
  if (slotNumber < pickfaceStartSlot(market)) return true;
  return activePickfaceWindows.some((window) => slotNumber >= window.min && slotNumber <= window.max);
}

function isPositionActiveByWorkers(position: string, market: RackMarket, activePickfaceWindows: PickfaceWindow[]) {
  return isSlotNumberActiveByWorkers(rackPositionNumber(position), market, activePickfaceWindows);
}

function isPickfaceManagedEntry(entry: RackEntry, highRunnerRecipes: Set<string>) {
  const kind = deriveEntryKind(entry);
  return kind === "meal" || kind === "ice" || highRunnerRecipes.has(entry.recipe);
}

function distanceToRange(value: number, min: number, max: number) {
  if (value < min) return min - value;
  if (value > max) return value - max;
  return 0;
}

function pickfacePenaltyForEntry(
  entry: RackEntry,
  candidatePosition: string,
  market: RackMarket,
  highRunnerRecipes: Set<string>,
  activePickfaceWindows: PickfaceWindow[],
) {
  const slotNumber = rackPositionNumber(candidatePosition);
  if (!Number.isFinite(slotNumber) || slotNumber === Number.MAX_SAFE_INTEGER) return 0;

  const kind = deriveEntryKind(entry);
  const isHighRunner = highRunnerRecipes.has(entry.recipe);
  let penalty = 0;

  if (isPickfaceManagedEntry(entry, highRunnerRecipes) && !isPositionInPickfaceWindows(candidatePosition, activePickfaceWindows)) {
    // Wenn ein Pickfenster wegen MA-Reduktion wegfällt, soll dort nicht automatisch neu verplant werden.
    penalty += 55;
  }

  if (market === "de") {
    // Picker 1 (F28-F36): Meal + Eis Kernbereich
    if (kind === "ice") {
      // Eis: Anfang (P1: F28-36), Mitte (P3: F85-90) ODER Ende (P7/P8: F129-144) – das Nächste gewinnt
      const iceDEtoStart  = distanceToRange(slotNumber, 28, 36);
      const iceDEtoMiddle = distanceToRange(slotNumber, 85, 90);
      const iceDEtoEnd    = distanceToRange(slotNumber, 129, 144);
      penalty += Math.min(iceDEtoStart, iceDEtoMiddle, iceDEtoEnd) * 0.45;
    } else if (kind === "meal") {
      penalty += distanceToRange(slotNumber, 28, 36) * 0.12;
    }

    // Picker 2 (F55-F63): nach Möglichkeit primär Meals
    if (kind === "meal") {
      penalty += distanceToRange(slotNumber, 55, 63) * 0.18;
    } else if (slotNumber >= 55 && slotNumber <= 63) {
      penalty += 1.9;
    }

    // Picker 3 (F85-F90): kompakt, gut für 1-2 Highrunner
    if (isHighRunner) {
      penalty += distanceToRange(slotNumber, 85, 90) * 0.22;
    } else if (slotNumber >= 85 && slotNumber <= 90) {
      penalty += kind === "meal" ? 0.65 : 1.35;
    }

    // Flyer, Gifts, Loyalties: bevorzugt am Ende der Halle (Gifts-Bereich P7/P8: F129-F144)
    if (kind === "loyalty" || kind === "other") {
      penalty += distanceToRange(slotNumber, 129, 144) * 0.30;
    }

    return penalty;
  }

  // Nordics: ähnliche Logik wie im Hallenbild, aber mit weichen Prioritäten.
  // Primäre Pickfaces je Picker-Zone.
  const nordicsMealPrimary: Array<[number, number, number]> = [
    [30, 36, 0.16],
    [57, 63, 0.18],
    [87, 90, 0.12],
  ];
  // Zusätzliche Meal-Zonen im rechten Bereich (leichter gewichtet).
  const nordicsMealSecondary: Array<[number, number, number]> = [
    [114, 120, 0.08],
    [122, 128, 0.08],
    [130, 136, 0.08],
    [138, 144, 0.08],
  ];

  if (kind === "ice") {
    // Nordics: Eis nur am Ende der Halle (P7: F131-F144)
    penalty += distanceToRange(slotNumber, 131, 144) * 0.42;
  }

  if (kind === "meal") {
    let mealPenalty = Number.POSITIVE_INFINITY;
    for (const [min, max, weight] of [...nordicsMealPrimary, ...nordicsMealSecondary]) {
      mealPenalty = Math.min(mealPenalty, distanceToRange(slotNumber, min, max) * weight);
    }
    if (Number.isFinite(mealPenalty)) penalty += mealPenalty;
  } else {
    // In den Meal-Kernzonen möglichst keine Nicht-Meal-Artikel bündeln.
    for (const [min, max] of nordicsMealPrimary) {
      if (slotNumber >= min && slotNumber <= max) penalty += 1.6;
    }
  }

  // Kompakte Highrunner-Nische im mittleren Bereich.
  if (isHighRunner) {
    penalty += distanceToRange(slotNumber, 87, 90) * 0.2;
  } else if (slotNumber >= 87 && slotNumber <= 90) {
    penalty += kind === "meal" ? 0.55 : 1.25;
  }

  // Flyer, Gifts, Loyalties: bevorzugt am Ende der Halle (P7: F131-F144)
  if (kind === "loyalty" || kind === "other") {
    penalty += distanceToRange(slotNumber, 131, 144) * 0.30;
  }

  return penalty;
}

function thirdTierPenalty(meta: RackSlotMeta | undefined) {
  // Etage 3 möglichst vermeiden, aber nicht sperren.
  return meta?.level === 3 ? 0.35 : 0;
}

/**
 * Berechnet je Linie und Pickface-Fenster, wie viele Artikel dort bereits liegen.
 * Wird für Picker-Load-Balancing genutzt: jeder aktive Picker soll gleich viele Picks haben.
 * Eis-Pickfaces bekommen einen Reduktionsfaktor (Eis dauert länger → weniger Ziel-Picks).
 */
function buildPickerLoadContext(
  entries: RackEntry[],
  market: RackMarket,
  activePickfaceWindows: PickfaceWindow[],
) {
  // key: `${line}:${pickfaceId}`
  const pickerPickCount = new Map<string, number>();
  const pickerHasIce = new Map<string, boolean>();

  const pickerHasSmoothie = new Map<string, boolean>();
  for (const entry of entries) {
    const slotNumber = rackPositionNumber(entry.flowRackPosition.toUpperCase());
    const window = activePickfaceWindows.find((w) => slotNumber >= w.min && slotNumber <= w.max);
    if (!window) continue;
    const key = `${entry.line}:${window.id}`;
    pickerPickCount.set(key, (pickerPickCount.get(key) ?? 0) + 1);
    const entryKind = deriveEntryKind(entry);
    if (entryKind === "ice") {
      pickerHasIce.set(key, true);
    }
    if (entryKind === "beverage") {
      // Smoothies: leicht + schnell → Picker kann mehr verarbeiten
      pickerHasSmoothie.set(key, true);
    }
  }

  return { pickerPickCount, pickerHasIce, pickerHasSmoothie };
}

/** Penalty wenn ein Picker-Fenster bereits überdurchschnittlich viele Picks hat.
 *  Eis-Fenster dürfen weniger Picks aufnehmen (Faktor 0.75). */
function pickerLoadPenalty(
  candidatePosition: string,
  line: string,
  activePickfaceWindows: PickfaceWindow[],
  pickerPickCount: Map<string, number>,
  pickerHasIce: Map<string, boolean>,
  avgPicksPerPicker: number,
  pickerHasSmoothie: Map<string, boolean> = new Map(),
): number {
  const slotNumber = rackPositionNumber(candidatePosition);
  const window = activePickfaceWindows.find((w) => slotNumber >= w.min && slotNumber <= w.max);
  if (!window) return 0;
  const key = `${line}:${window.id}`;
  const count = pickerPickCount.get(key) ?? 0;
  // Eis: kalt + schwer → 60 % Kapazität; Smoothies: leicht + schnell → 125 % Kapazität
  const capacityFactor = pickerHasIce.get(key) ? 0.60 : pickerHasSmoothie.get(key) ? 1.25 : 1.0;
  const target = avgPicksPerPicker * capacityFactor;
  // Penalty steigt überproportional wenn der Picker schon über Ziel liegt.
  const overshoot = count - target;
  return overshoot > 0 ? overshoot * 0.4 : 0;
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

function buildLinePlanningContext(entries: RackEntry[], slotMeta: Map<string, RackSlotMeta>) {
  const occupancy = new Map<string, number>();
  const stationDemand = new Map<string, number>();
  const lineDemand = new Map<string, number>();
  const lineStationCount = new Map<string, Set<string>>();
  const lineBounds = new Map<string, { min: number; max: number }>();

  for (const entry of entries) {
    const position = entry.flowRackPosition.toUpperCase();
    const key = `${entry.line}:${position}`;
    occupancy.set(key, (occupancy.get(key) ?? 0) + 1);

    const meta = slotMeta.get(position);
    const stationKey = `${entry.line}:${meta?.station ?? "unknown"}`;
    const weight = meta?.demand ?? entry.quantity;
    stationDemand.set(stationKey, (stationDemand.get(stationKey) ?? 0) + weight);
    lineDemand.set(entry.line, (lineDemand.get(entry.line) ?? 0) + weight);

    const stations = lineStationCount.get(entry.line) ?? new Set<string>();
    stations.add(meta?.station ?? "unknown");
    lineStationCount.set(entry.line, stations);

    const slotNumber = rackPositionNumber(position);
    const bounds = lineBounds.get(entry.line) ?? { min: slotNumber, max: slotNumber };
    bounds.min = Math.min(bounds.min, slotNumber);
    bounds.max = Math.max(bounds.max, slotNumber);
    lineBounds.set(entry.line, bounds);
  }

  return { occupancy, stationDemand, lineDemand, lineStationCount, lineBounds };
}

function buildDefaultSlotOrder(slotMeta: Map<string, RackSlotMeta>, market: RackMarket) {
  return [...slotMeta.entries()]
    .map(([position, meta]) => ({ position, meta }))
    .sort((a, b) => ergonomicTierRank(a.meta, a.position, market) - ergonomicTierRank(b.meta, b.position, market) || Number(b.meta.highRunner) - Number(a.meta.highRunner) || b.meta.demand - a.meta.demand || rackPositionNumber(a.position) - rackPositionNumber(b.position));
}

function buildLockedStationsByLine(entries: RackEntry[], slotMeta: Map<string, RackSlotMeta>) {
  const orderedStations = [...slotMeta.entries()]
    .sort((a, b) => rackPositionNumber(a[0]) - rackPositionNumber(b[0]))
    .map(([, meta]) => meta.station?.trim() || "unknown")
    .filter((station) => station !== "unknown");
  const firstTwoStations = [...new Set(orderedStations)].slice(0, 2);
  const byLine = new Map<string, Set<string>>();
  for (const line of uniqueRackLines(entries)) {
    byLine.set(line, new Set(firstTwoStations));
  }
  return byLine;
}

function findBestAutoSlot(
  entry: RackEntry,
  currentPosition: string,
  market: RackMarket,
  slotMeta: Map<string, RackSlotMeta>,
  preferredSlotsByRecipe: Map<string, string[]>,
  highRunnerRecipes: Set<string>,
  staffingMode: StaffingMode,
  occupancy: Map<string, number>,
  stationDemand: Map<string, number>,
  lineDemand: Map<string, number>,
  lineStationCount: Map<string, Set<string>>,
  lineBounds: Map<string, { min: number; max: number }>,
  defaultSlots: Array<{ position: string; meta: RackSlotMeta }>,
  lockedStationsByLine: Map<string, Set<string>>,
  activePickfaceWindows: PickfaceWindow[],
) {
  const prioritizedPositions = [
    ...(preferredSlotsByRecipe.get(entry.recipe) ?? []),
    ...defaultSlots.map((slot) => slot.position),
  ];
  const entryIsHighRunner = highRunnerRecipes.has(entry.recipe);
  const entryIsIce = deriveEntryKind(entry) === "ice";

  const bounds = lineBounds.get(entry.line) ?? { min: rackPositionNumber(currentPosition), max: rackPositionNumber(currentPosition) };
  const targetZone = articleZoneTarget(entry);
  const denom = Math.max(bounds.max - bounds.min, 1);
  const currentStation = slotMeta.get(currentPosition)?.station?.trim() || "unknown";
  const lockedStations = lockedStationsByLine.get(entry.line) ?? new Set<string>();
  const currentStationLocked = lockedStations.has(currentStation);

  const candidates = [...new Set(prioritizedPositions)]
    .map((position) => {
      const meta = slotMeta.get(position);
      const occ = occupancy.get(`${entry.line}:${position}`) ?? 0;
      const stationLoad = stationDemand.get(`${entry.line}:${meta?.station ?? "unknown"}`) ?? 0;
      const lineAverageLoad = (lineDemand.get(entry.line) ?? 0) / Math.max((lineStationCount.get(entry.line)?.size ?? 1), 1);
      const normalizedIndex = (rackPositionNumber(position) - bounds.min) / denom;
      return {
        position,
        meta,
        occupancy: occ,
        stationLoad,
        lineAverageLoad,
        preferredForRecipe: (preferredSlotsByRecipe.get(entry.recipe) ?? []).includes(position),
        distance: Math.abs(rackPositionNumber(position) - rackPositionNumber(currentPosition)),
        zonePenalty: Math.abs(normalizedIndex - targetZone),
        pickfacePenalty: pickfacePenaltyForEntry(entry, position, market, highRunnerRecipes, activePickfaceWindows),
        tierPenalty: thirdTierPenalty(meta),
      };
    })
    .filter((candidate) => candidate.meta)
    .filter((candidate) => {
      const candidateStation = candidate.meta?.station?.trim() || "unknown";
      if (currentStationLocked) return candidateStation === currentStation;
      return !lockedStations.has(candidateStation);
    })
    .filter((candidate) => candidate.occupancy === 0);

  // Eis: nie Oberschiene (level 1). Highrunner-Eis → Mittelschiene (level 2) bevorzugt.
  const highRunnerCandidates = (entryIsHighRunner && entryIsIce)
    // Highrunner-Eis: lieber level 2, dann level 3 — nie level 1
    ? candidates.filter((candidate) => (candidate.meta?.level ?? 2) !== 1)
    : entryIsHighRunner
      ? candidates.filter((candidate) => candidate.meta?.preferredPick)
      : entryIsIce
        ? candidates.filter((candidate) => (candidate.meta?.level ?? 2) !== 1)
        : candidates;
  // Fallback: Highrunner/Eis dürfen NIE auf die Oberschiene (level 1).
  const highRunnerFallback = (entryIsHighRunner || entryIsIce)
    ? candidates.filter((candidate) => (candidate.meta?.level ?? 2) !== 1)
    : candidates;
  const pool = highRunnerCandidates.length > 0 ? highRunnerCandidates : highRunnerFallback;
  // Harte Regel: Alle Einträge nur in aktiven/freigegebenen Pickfaces platzieren
  const finalPool = pool.filter((candidate) => isPositionInPickfaceWindows(candidate.position, activePickfaceWindows));

  return finalPool.sort((a, b) =>
    Number(b.preferredForRecipe) - Number(a.preferredForRecipe)
    // Highrunner-Eis: level 2 (Mittelschiene) vor level 3 (Unterschiene)
    || (entryIsIce ? (a.meta?.level === 2 ? -1 : b.meta?.level === 2 ? 1 : 0) : 0)
    || ergonomicTierRank(a.meta, a.position, market) - ergonomicTierRank(b.meta, b.position, market)
    || (a.pickfacePenalty + a.tierPenalty) - (b.pickfacePenalty + b.tierPenalty)
    || a.zonePenalty - b.zonePenalty
    || (b.meta?.demand ?? 0) - (a.meta?.demand ?? 0)
    || a.distance - b.distance
  )[0];
}

function enforceSingleSlotOccupancy(
  entries: RackEntry[],
  market: RackMarket,
  highRunnerRecipes: Set<string>,
  slotMeta: Map<string, RackSlotMeta>,
  preferredSlotsByRecipe: Map<string, string[]>,
  staffingMode: StaffingMode,
  lockedStationsByLine: Map<string, Set<string>>,
  activePickfaceWindows: PickfaceWindow[],
) {
  if (entries.length === 0 || slotMeta.size === 0) return entries;

  const nextEntries = entries.map((entry) => ({ ...entry }));
  const defaultSlots = buildDefaultSlotOrder(slotMeta, market);
  const { occupancy, stationDemand, lineDemand, lineStationCount, lineBounds } = buildLinePlanningContext(nextEntries, slotMeta);

  const conflicts = new Map<string, number[]>();
  for (let index = 0; index < nextEntries.length; index += 1) {
    const entry = nextEntries[index];
    const key = `${entry.line}:${entry.flowRackPosition.toUpperCase()}`;
    const rows = conflicts.get(key) ?? [];
    rows.push(index);
    conflicts.set(key, rows);
  }

  let changed = false;

  for (const [slotKey, indexes] of conflicts.entries()) {
    if (indexes.length <= 1) continue;

    const sortedIndexes = [...indexes].sort((a, b) => {
      const left = nextEntries[a];
      const right = nextEntries[b];
      const leftMeta = slotMeta.get(left.flowRackPosition.toUpperCase());
      const rightMeta = slotMeta.get(right.flowRackPosition.toUpperCase());
      return Number(highRunnerRecipes.has(right.recipe)) - Number(highRunnerRecipes.has(left.recipe))
        || (rightMeta?.demand ?? right.quantity) - (leftMeta?.demand ?? left.quantity)
        || right.quantity - left.quantity
        || left.recipe.localeCompare(right.recipe);
    });

    for (const index of sortedIndexes.slice(1)) {
      const entry = nextEntries[index];
      const currentPosition = entry.flowRackPosition.toUpperCase();
      const currentMeta = slotMeta.get(currentPosition);

      const target = findBestAutoSlot(
        entry,
        currentPosition,
        market,
        slotMeta,
        preferredSlotsByRecipe,
        highRunnerRecipes,
        staffingMode,
        occupancy,
        stationDemand,
        lineDemand,
        lineStationCount,
        lineBounds,
        defaultSlots,
        lockedStationsByLine,
        activePickfaceWindows,
      );

      if (!target || target.position === currentPosition) continue;

      occupancy.set(slotKey, Math.max((occupancy.get(slotKey) ?? 1) - 1, 0));
      occupancy.set(`${entry.line}:${target.position}`, (occupancy.get(`${entry.line}:${target.position}`) ?? 0) + 1);

      const currentStationKey = `${entry.line}:${currentMeta?.station ?? "unknown"}`;
      const targetStationKey = `${entry.line}:${target.meta?.station ?? "unknown"}`;
      const currentWeight = currentMeta?.demand ?? entry.quantity;
      const targetWeight = target.meta?.demand ?? entry.quantity;
      stationDemand.set(currentStationKey, Math.max((stationDemand.get(currentStationKey) ?? currentWeight) - currentWeight, 0));
      stationDemand.set(targetStationKey, (stationDemand.get(targetStationKey) ?? 0) + targetWeight);

      nextEntries[index] = updatedRackEntry(entry, entry.line, target.position);
      changed = true;
    }
  }

  return changed ? nextEntries.sort((a, b) => a.line.localeCompare(b.line) || a.sort - b.sort || a.recipe.localeCompare(b.recipe)) : entries;
}

function optimizeAutomaticRackPlan(
  entries: RackEntry[],
  market: RackMarket,
  highRunnerRecipes: Set<string>,
  slotMeta: Map<string, RackSlotMeta>,
  preferredSlotsByRecipe: Map<string, string[]>,
  staffingMode: StaffingMode,
  lockedStationsByLine: Map<string, Set<string>>,
  activePickfaceWindows: PickfaceWindow[],
) {
  const conflictResolved = enforceSingleSlotOccupancy(entries, market, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, staffingMode, lockedStationsByLine, activePickfaceWindows);
  // Picker-Load-Balancing: gleiche Picks pro aktivem Picker, Eis-Picker reduziert
  const activeWindows = activePickfaceWindows.filter((w) => !w.zuschaltbar);
  const avgPicksPerPicker = activeWindows.length > 0 ? conflictResolved.length / activeWindows.length : 0;
  const { pickerPickCount, pickerHasIce, pickerHasSmoothie } = buildPickerLoadContext(conflictResolved, market, activePickfaceWindows);
  return rebalanceErgonomicEntries(conflictResolved, market, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, staffingMode, lockedStationsByLine, activePickfaceWindows, pickerPickCount, pickerHasIce, avgPicksPerPicker, pickerHasSmoothie);
}

function rebalanceErgonomicEntries(
  entries: RackEntry[],
  market: RackMarket,
  highRunnerRecipes: Set<string>,
  slotMeta: Map<string, RackSlotMeta>,
  preferredSlotsByRecipe: Map<string, string[]>,
  staffingMode: StaffingMode,
  lockedStationsByLine: Map<string, Set<string>>,
  activePickfaceWindows: PickfaceWindow[],
  pickerPickCount: Map<string, number> = new Map(),
  pickerHasIce: Map<string, boolean> = new Map(),
  avgPicksPerPicker = 0,
  pickerHasSmoothie: Map<string, boolean> = new Map(),
) {
  if (entries.length === 0 || slotMeta.size === 0) return entries;

  const preferredSlots = buildDefaultSlotOrder(slotMeta, market);
  const { occupancy, stationDemand, lineDemand, lineStationCount, lineBounds } = buildLinePlanningContext(entries, slotMeta);

  let changed = false;
  const nextEntries = entries
    .map((entry) => ({ ...entry }))
    .sort((a, b) => a.line.localeCompare(b.line) || Number(highRunnerRecipes.has(b.recipe)) - Number(highRunnerRecipes.has(a.recipe)) || (slotMeta.get(b.flowRackPosition.toUpperCase())?.demand ?? b.quantity) - (slotMeta.get(a.flowRackPosition.toUpperCase())?.demand ?? a.quantity) || b.quantity - a.quantity || a.recipe.localeCompare(b.recipe));
  for (let index = 0; index < nextEntries.length; index += 1) {
    const entry = nextEntries[index];

    const currentPosition = entry.flowRackPosition.toUpperCase();
    const currentMeta = slotMeta.get(currentPosition);
    const entryIsHighRunner = highRunnerRecipes.has(entry.recipe);
    const entryIsIce = deriveEntryKind(entry) === "ice";
    const currentScore = ergonomicTierRank(currentMeta, currentPosition, market);
    const currentStation = currentMeta?.station?.trim() || "unknown";
    const lockedStations = lockedStationsByLine.get(entry.line) ?? new Set<string>();
    const currentStationLocked = lockedStations.has(currentStation);

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
        zonePenalty: (() => {
          const bounds = lineBounds.get(entry.line) ?? { min: rackPositionNumber(currentPosition), max: rackPositionNumber(currentPosition) };
          const denom = Math.max(bounds.max - bounds.min, 1);
          const targetZone = articleZoneTarget(entry);
          const normalizedIndex = (rackPositionNumber(position) - bounds.min) / denom;
          return Math.abs(normalizedIndex - targetZone);
        })(),
        pickfacePenalty: pickfacePenaltyForEntry(entry, position, market, highRunnerRecipes, activePickfaceWindows),
        tierPenalty: thirdTierPenalty(slotMeta.get(position)),
        loadPenalty: avgPicksPerPicker > 0 ? pickerLoadPenalty(position, entry.line, activePickfaceWindows, pickerPickCount, pickerHasIce, avgPicksPerPicker, pickerHasSmoothie) : 0,
      }))
      .filter((candidate) => {
        const candidateStation = candidate.meta?.station?.trim() || "unknown";
        if (currentStationLocked) return candidateStation === currentStation;
        return !lockedStations.has(candidateStation);
      })
      .filter((candidate) => {
        // Highrunner-Eis → Mittelschiene (level 2) bevorzugt, nie Oberschiene (level 1)
        if (entryIsHighRunner && entryIsIce) return (candidate.meta?.level ?? 2) !== 1;
        // Highrunner: preferredPick zuerst; Fallback auf non-level-1, wenn alle preferredPick besetzt
        if (entryIsHighRunner) return !!candidate.meta?.preferredPick || (candidate.meta?.level ?? 2) !== 1;
        if (entryIsIce) return (candidate.meta?.level ?? 2) !== 1; // Eis nie auf Oberschiene
        // Alle anderen: Oberschiene (level 1) als absolutes Last-Resort — nur wenn nichts anderes frei
        return true;
      });
    // Für Highrunner: preferredPick-Slots bevorzugen; für alle: level 1 wirklich nur als letzter Ausweg
    const preferredCandidates = entryIsHighRunner
      ? candidates.filter((c) => c.meta?.preferredPick)
      : null;
    const nonLevel1Candidates = candidates.filter((c) => (c.meta?.level ?? 2) !== 1);
    const candidatePool = (() => {
      // Highrunner: erst preferredPick, dann non-level-1 (Fallback), dann alles
      if (entryIsHighRunner) {
        const pref = (preferredCandidates ?? []).filter((c) => c.position === currentPosition || c.occupancy === 0);
        if (pref.length > 0) return pref;
        const fallback = nonLevel1Candidates.filter((c) => c.position === currentPosition || c.occupancy === 0);
        if (fallback.length > 0) return fallback;
      }
      // Alle anderen: level 2/3 first, level 1 nur wenn sonst nichts frei
      const nonL1 = nonLevel1Candidates.filter((c) => c.position === currentPosition || c.occupancy === 0);
      if (nonL1.length > 0) return nonL1;
      return candidates.filter((c) => c.position === currentPosition || c.occupancy === 0);
    })();
    // Harte Regel: Alle Einträge nur in aktiven/freigegebenen Pickfaces platzieren
    const finalCandidatePool = candidatePool.filter((candidate) =>
      candidate.position === currentPosition || isPositionInPickfaceWindows(candidate.position, activePickfaceWindows));

    const sortedCandidates = finalCandidatePool.sort((a, b) =>
        Number(b.preferredForRecipe) - Number(a.preferredForRecipe)
        // Highrunner-Eis: Mittelschiene (level 2) zuerst
        || (entryIsIce ? (a.meta?.level === 2 ? -1 : b.meta?.level === 2 ? 1 : 0) : 0)
        || ergonomicTierRank(a.meta, a.position, market) - ergonomicTierRank(b.meta, b.position, market)
        || (a.pickfacePenalty + a.tierPenalty + a.loadPenalty) - (b.pickfacePenalty + b.tierPenalty + b.loadPenalty)
        || a.zonePenalty - b.zonePenalty
        || a.occupancy - b.occupancy
        || Number(b.meta?.highRunner) - Number(a.meta?.highRunner)
        || (b.meta?.demand ?? 0) - (a.meta?.demand ?? 0)
        || a.distance - b.distance,
      );

    const target = sortedCandidates[0];
    if (!target || target.position === currentPosition) continue;
    const targetScore = ergonomicTierRank(target.meta, target.position, market);
    const currentOccupancy = occupancy.get(`${entry.line}:${currentPosition}`) ?? 0;
    const currentPickfacePenalty = pickfacePenaltyForEntry(entry, currentPosition, market, highRunnerRecipes, activePickfaceWindows) + thirdTierPenalty(currentMeta);
    const targetPickfacePenalty = target.pickfacePenalty + target.tierPenalty;
    const shouldMove = entryIsHighRunner
      ? !(currentMeta?.preferredPick) || (currentOccupancy > 1 && target.occupancy === 0)
      : entryIsIce
      ? currentMeta?.level === 1 || currentOccupancy > 1 || targetScore < currentScore
      : currentOccupancy > 1
        || targetScore < currentScore
        || targetPickfacePenalty + 0.2 < currentPickfacePenalty
        || (targetScore === currentScore && (target.occupancy < currentOccupancy || target.zonePenalty < 0.01));
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

    // Regel: Highrunner → IMMER Mittelschiene (level 2 / preferredPick), NIE Oberschiene (level 1)
    const highRunnersOnUpperShelf = lineEntries.filter((entry) => {
      if (!highRunnerRecipes.has(entry.recipe)) return false;
      return slotMeta.get(entry.flowRackPosition.toUpperCase())?.level === 1;
    });
    if (highRunnersOnUpperShelf.length > 0) {
      issues.push({
        severity: "error",
        message: `${line}: ${highRunnersOnUpperShelf.length} Highrunner auf der OBERSCHIENE – das ist nicht erlaubt! (${highRunnersOnUpperShelf.map((entry) => `${entry.recipe}@${entry.flowRackPosition}`).join(", ")}) → bitte auf Mittelschiene verlegen.`,
      });
    }
    const highRunnersOffMiddle = lineEntries.filter((entry) => {
      if (!highRunnerRecipes.has(entry.recipe)) return false;
      const meta = slotMeta.get(entry.flowRackPosition.toUpperCase());
      return !meta?.preferredPick && meta?.level !== 1; // nicht Mittelschiene, aber auch nicht schon als Error erfasst
    });
    if (highRunnersOffMiddle.length > 0) {
      issues.push({
        severity: "warning",
        message: `${line}: ${highRunnersOffMiddle.length} Highrunner liegen nicht auf der Mittelschiene (${highRunnersOffMiddle.map((entry) => `${entry.recipe}@${entry.flowRackPosition}`).join(", ")}).`,
      });
    }

    // Regel: Eis darf NIE auf die Oberschiene (level 1) – schwerster und ungemütlichster Pick
    const iceOnUpperShelf = lineEntries.filter((entry) => {
      if (deriveEntryKind(entry) !== "ice") return false;
      return slotMeta.get(entry.flowRackPosition.toUpperCase())?.level === 1;
    });
    if (iceOnUpperShelf.length > 0) {
      issues.push({
        severity: "error",
        message: `${line}: ${iceOnUpperShelf.length} Eis-Artikel auf der OBERSCHIENE – verboten! Eis nur auf Mittel- oder Unterschiene. (${iceOnUpperShelf.map((entry) => `${entry.recipe}@${entry.flowRackPosition}`).join(", ")})`,
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
    if (highRunnerRecipes.has(entry.recipe) && meta?.level === 1) {
      reasons.push("⛔ Highrunner auf Oberschiene – verboten!");
    } else if (highRunnerRecipes.has(entry.recipe) && !meta?.preferredPick) {
      reasons.push("Highrunner nicht auf Mittelschiene");
    }
    if (deriveEntryKind(entry) === "ice" && meta?.level === 1) {
      reasons.push("⛔ Eis auf Oberschiene – verboten! (schwerer Pick)");
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
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error(`Auto-Quelle nicht erreichbar: ${url}`);
  }
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
  // Ref auf ungefilterte MultiLine-Einträge – wird für PDL-Neuanwendung benötigt
  const rawEntriesRef = useRef<RackEntry[]>([]);
  const [pdlIds, setPdlIds] = useState<Set<string> | undefined>();
  const [boxfile, setBoxfile] = useState<RackBoxSnapshot | undefined>();
  const [co2MealIds, setCo2MealIds] = useState<Set<string> | undefined>();
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [status, setStatus] = useState<string>(locale === "de" ? "Noch keine Rackdaten geladen." : "No rack data loaded yet.");
  const [busy, setBusy] = useState<string | null>(null);
  const [picksPerWorker, setPicksPerWorker] = useState(120);
  const [plannedWorkersManual, setPlannedWorkersManual] = useState<number | null>(null);
  const [disabledPickfaceIds, setDisabledPickfaceIds] = useState<Set<string>>(
    () => new Set(pickfaceWindowsForMarket("de").filter((w) => !w.zuschaltbar).map((w) => w.id)),
  );
  const [enabledZuschaltbarPickfaceIds, setEnabledZuschaltbarPickfaceIds] = useState<Set<string>>(new Set());
  const [staffingMode, setStaffingMode] = useState<StaffingMode>("balanced");
  const [recommendationOnly, setRecommendationOnly] = useState(false);
  const [hasManualEdits, setHasManualEdits] = useState(false);
  const [comparison, setComparison] = useState<ComparisonSnapshot | null>(null);
  const [selectedFocus, setSelectedFocus] = useState<SelectedRackFocus | null>(null);
  const [activeLines, setActiveLines] = useState<string[]>(RACK_MARKET_PROFILES.de.lines);
  const [draggedEntryId, setDraggedEntryId] = useState<string | null>(null);
  const draggedEntryIdRef = useRef<string | null>(null);
  const [recentlyRelocatedEntryIds, setRecentlyRelocatedEntryIds] = useState<Set<string>>(new Set());
  const relocatedHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoveredSlotKey, setHoveredSlotKey] = useState<string | null>(null);
  const [slotMeta, setSlotMeta] = useState<Map<string, RackSlotMeta>>(new Map());
  const [rackZoomByLine, setRackZoomByLine] = useState<Record<string, number>>({});
  // G: Workbook-Veraltet-Hinweis
  const [workbookStale, setWorkbookStale] = useState(false);
  // C: Diff-Modus Template vs. aktuell
  const [showDiffFromTemplate, setShowDiffFromTemplate] = useState(false);
  // F: Koch-Plan-Abgleich
  const [cookScheduleRecipes, setCookScheduleRecipes] = useState<Set<string> | undefined>();
  // I: Engpass-Simulation
  const [bottleneckRecipe, setBottleneckRecipe] = useState("");
  // J: QR-Sharing
  const [showQrModal, setShowQrModal] = useState(false);
  const [displayTab, setDisplayTab] = useState<RackDisplayTab>("line");
  // Pre-Build-Validierung
  const [prebuildBlocker, setPrebuildBlocker] = useState<null | { errors: string[]; warnings: string[] }>(null);
  // H: Versionshistorie
  const [planHistoryItems, setPlanHistoryItems] = useState<Array<{ ts: number; market: string; week: string; entryCount: number }>>([]);
  // Upload-Panel: zugeklappt / Auto-Ladefehler
  const [uploadOpen, setUploadOpen] = useState(false);
  const [autoLoadFailed, setAutoLoadFailed] = useState(false);
  // K: Planung bereinigen – Bestätigungs-Modal
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearLogs, setClearLogs] = useState<Array<{ ts: number; market: string; week: string; entryCount: number; clearedBy: string }>>([]);
  // M: Manuelle Planung Filter
  const [filterText, setFilterText] = useState("");

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
    setShowDiffFromTemplate(false);
    setWorkbookStale(false);
    setCookScheduleRecipes(undefined);
    setBottleneckRecipe("");
    setPlanHistoryItems([]);
    setClearLogs([]);
    setHasManualEdits(false);
    setEnabledZuschaltbarPickfaceIds(new Set());
    // Alle regulären Picker beim Marktwechsel sperren – User schaltet manuell frei.
    setDisabledPickfaceIds(new Set(pickfaceWindowsForMarket(market).filter((w) => !w.zuschaltbar).map((w) => w.id)));
    if (relocatedHighlightTimerRef.current) {
      clearTimeout(relocatedHighlightTimerRef.current);
      relocatedHighlightTimerRef.current = null;
    }
    setRecentlyRelocatedEntryIds(new Set());
    setStatus(locale === "de" ? `Automatischer Rack-Start für ${week} wird vorbereitet …` : `Preparing automatic rack startup for ${week} …`);
    setAutoLoadFailed(false);
  }, [market, week, locale, profile.lines]);

  useEffect(() => {
    return () => {
      if (relocatedHighlightTimerRef.current) {
        clearTimeout(relocatedHighlightTimerRef.current);
      }
    };
  }, []);

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
          parsePdlCsv(pdlFile, week),  // Nur Mahlzeiten der aktuellen Woche
        ]);
        if (cancelled) return;

        const { entries: nextEntries, slotMeta: nextSlotMeta } = workbookData;

        // Rohe Einträge merken (für PDL-Neuanwendung bei manuell hochgeladenem PDL)
        rawEntriesRef.current = nextEntries;

        // Nur PDL-aktive Mahlzeiten dieser Woche + alle Festeinträge (Verpackung, Ice, usw.)
        const filteredEntries = applyPdlFilter(nextEntries, nextPdlIds);
        const mealCount = filteredEntries.filter((e) => deriveEntryKind(e) === "meal").length;
        const totalMeals = nextEntries.filter((e) => deriveEntryKind(e) === "meal").length;

        setActiveLines(profile.lines);
        setEntries(filteredEntries);
        setTemplateEntries(filteredEntries);
        setPicksPerWorker(picksPerWorkerForHallReference(filteredEntries, nextSlotMeta, market, 120));
        setPdlIds(nextPdlIds);
        setSlotMeta(nextSlotMeta);
        localStorage.setItem(`rack-workbook-loaded-at-${market}`, String(Date.now()));
        setWorkbookStale(false);
        setSourceLabel(`${multilineFile.name} · ${pdlFile.name}`);
        setStatus(locale === "de"
          ? `✓ Rackfile KW${week} bereit: ${mealCount} von ${totalMeals} Mahlzeiten aus PDL. Jetzt Export klicken.`
          : `✓ Rackfile ${week} ready: ${mealCount} of ${totalMeals} meals from PDL. Click export now.`);

        // Rezept-Manifest für LinePlanningView in Firestore schreiben (silent)
        try {
          const { getFirebase } = await import("./firebase");
          const { doc, setDoc } = await import("firebase/firestore");
          const { db } = getFirebase();
          const seen = new Set<string>();
          const meals = filteredEntries
            .filter((e) => deriveEntryKind(e) === "meal")
            .filter((e) => { if (seen.has(e.recipe)) return false; seen.add(e.recipe); return true; })
            .map((e) => ({ code: e.recipe, name: e.displayName || e.recipe }));
          await setDoc(
            doc(db, `apps/rezeptlogik/weekRecipes/${market}_${week.replace(/\W/g, "-")}`),
            { week, market, updatedAt: Date.now(), meals },
            { merge: false },
          );
        } catch { /* kein Firestore → still ignorieren */ }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setAutoLoadFailed(true);
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

  // G: Workbook älter als 7 Tage → Hinweis
  useEffect(() => {
    const loadedAt = localStorage.getItem(`rack-workbook-loaded-at-${market}`);
    if (!loadedAt) return;
    setWorkbookStale(Date.now() - Number(loadedAt) > 7 * 24 * 60 * 60 * 1000);
  }, [market, slotMeta.size]);

  // H: Freigabe-Verlauf + K: Clear-Logs bei Markt- oder KW-Wechsel laden
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadPlanHistory(); void loadClearLogs(); }, [market, week]);

  const baseValidation = useMemo(
    () => validateRackPlan(entries, { pdlIds, boxfile, co2MealIds }),
    [entries, pdlIds, boxfile, co2MealIds],
  );
  const summary = useMemo(() => rackSummary(entries), [entries]);
  const usedLines = useMemo(() => uniqueRackLines(entries), [entries]);
  const totalDemandPicks = useMemo(
    () => entries.reduce((sum, entry) => sum + Math.max(0, slotMeta.get(entry.flowRackPosition.toUpperCase())?.demand ?? entry.quantity ?? 0), 0),
    [entries, slotMeta],
  );
  const hallLayoutWorkers = useMemo(() => hallLayoutPickstationWorkers(market), [market]);
  const plannedWorkersFte = useMemo(
    () => (totalDemandPicks > 0 && picksPerWorker > 0 ? totalDemandPicks / picksPerWorker : 0),
    [totalDemandPicks, picksPerWorker],
  );
  const plannedWorkersRoundedFromDemand = useMemo(
    () => totalDemandPicks > 0
      ? Math.max(1, Math.round(plannedWorkersFte))
      : (plannedWorkersManual ?? hallLayoutWorkers),
    [plannedWorkersFte, hallLayoutWorkers, totalDemandPicks, plannedWorkersManual],
  );
  const plannedWorkersRounded = useMemo(
    () => plannedWorkersManual ?? plannedWorkersRoundedFromDemand,
    [plannedWorkersManual, plannedWorkersRoundedFromDemand],
  );
  const workersDrivenPickfaceWindows = useMemo(
    () => buildActivePickfaceWindows(market, plannedWorkersRounded, hallLayoutWorkers),
    [market, plannedWorkersRounded, hallLayoutWorkers],
  );
  const closedPickfaceIdsByWorkers = useMemo(() => {
    const activeIds = new Set(workersDrivenPickfaceWindows.map((window) => window.id));
    return new Set(
      pickfaceWindowsForMarket(market)
        .filter((window) => !activeIds.has(window.id) && !window.zuschaltbar)
        .map((window) => window.id),
    );
  }, [workersDrivenPickfaceWindows, market]);
  const activePickfaceWindows = useMemo(
    () => workersDrivenPickfaceWindows.filter((window) => {
      if (window.zuschaltbar && !enabledZuschaltbarPickfaceIds.has(window.id)) return false;
      return !disabledPickfaceIds.has(window.id);
    }),
    [workersDrivenPickfaceWindows, disabledPickfaceIds, enabledZuschaltbarPickfaceIds],
  );

  function toggleZuschaltbarPickface(id: string) {
    const window = pickfaceWindowsForMarket(market).find((candidate) => candidate.id === id);
    const willBeEnabled = !enabledZuschaltbarPickfaceIds.has(id);
    setEnabledZuschaltbarPickfaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Beim Entsperren: Einträge in diesem Pickface-Bereich leeren,
    // damit der Slot wirklich erst nach "Beste Linie bauen" befüllt wird.
    if (willBeEnabled && window) {
      setEntries((prev) => prev.filter((entry) => {
        const n = rackPositionNumber(entry.flowRackPosition.toUpperCase());
        return n < window.min || n > window.max;
      }));
    }
    const blockLabel = window?.blockNumber ? `Z${window.blockNumber}` : id.toUpperCase();
    setStatus(locale === "de"
      ? `${blockLabel} ${willBeEnabled ? "freigeschaltet" : "gesperrt"}. Gilt für alle Linien im ${market.toUpperCase()}-Markt. Belegung erst nach "Beste Linie bauen" oder manueller Verteilung.`
      : `${blockLabel} ${willBeEnabled ? "enabled" : "locked"}. Applies to all lines in ${market.toUpperCase()}. Fill after clicking Build best line or by manual placement.`);
  }

  function togglePickfaceDisabled(id: string) {
    const window = pickfaceWindowsForMarket(market).find((candidate) => candidate.id === id);
    const willBeEnabled = disabledPickfaceIds.has(id);
    setDisabledPickfaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Beim Entsperren: Einträge in diesem Pickface-Bereich leeren,
    // damit der Slot wirklich erst nach "Beste Linie bauen" befüllt wird.
    if (willBeEnabled && window) {
      setEntries((prev) => prev.filter((entry) => {
        const n = rackPositionNumber(entry.flowRackPosition.toUpperCase());
        return n < window.min || n > window.max;
      }));
    }
    const pickerLabel = window?.pickerNumber ? `P${window.pickerNumber}` : id.toUpperCase();
    setStatus(locale === "de"
      ? `${pickerLabel} ${willBeEnabled ? "freigeschaltet" : "gesperrt"}. Gilt für alle Linien im ${market.toUpperCase()}-Markt. Belegung erst nach "Beste Linie bauen" oder manueller Verteilung.`
      : `${pickerLabel} ${willBeEnabled ? "enabled" : "locked"}. Applies to all lines in ${market.toUpperCase()}. Fill after clicking Build best line or by manual placement.`);
  }

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
  const lockedStationsByLine = useMemo(
    () => buildLockedStationsByLine(entries, slotMeta),
    [entries, slotMeta],
  );

  const operationalIssues = useMemo(
    () => buildOperationalValidation(entries, slotMeta, highRunnerRecipes),
    [entries, slotMeta, highRunnerRecipes],
  );

  // Meals die keinem aktiven Pickface-Fenster zugeordnet sind → müssen manuell verteilt werden
  const unplacedMeals = useMemo(
    () => entries.filter(
      (entry) => deriveEntryKind(entry) === "meal" && !isPositionInPickfaceWindows(entry.flowRackPosition.toUpperCase(), activePickfaceWindows),
    ),
    [entries, activePickfaceWindows],
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
    () => recommendationOnly && slotMeta.size > 0 ? optimizeAutomaticRackPlan(entries, market, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, staffingMode, lockedStationsByLine, activePickfaceWindows) : null,
    [recommendationOnly, entries, market, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, staffingMode, lockedStationsByLine, activePickfaceWindows],
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
  const selectedPlannedPickCount = useMemo(
    () => selectedEntries.reduce((sum, entry) => sum + Math.max(0, entry.quantity || 0), 0),
    [selectedEntries],
  );
  const selectedDemandPickCount = useMemo(
    () => Math.max(0, selectedMeta?.demand ?? 0),
    [selectedMeta],
  );
  const selectedKindMix = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of selectedEntries) {
      const kind = deriveEntryKind(entry);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [selectedEntries]);

  // C: Geänderte Slots seit Template-Stand
  const changedSlots = useMemo(() => {
    if (!showDiffFromTemplate || templateEntries.length === 0) return new Set<string>();
    const tmpl = new Map<string, Set<string>>();
    for (const e of templateEntries) {
      const key = `${e.line}:${e.flowRackPosition.toUpperCase()}`;
      const s = tmpl.get(key) ?? new Set<string>();
      s.add(e.recipe);
      tmpl.set(key, s);
    }
    const curr = new Map<string, Set<string>>();
    for (const e of entries) {
      const key = `${e.line}:${e.flowRackPosition.toUpperCase()}`;
      const s = curr.get(key) ?? new Set<string>();
      s.add(e.recipe);
      curr.set(key, s);
    }
    const changed = new Set<string>();
    for (const key of new Set([...tmpl.keys(), ...curr.keys()])) {
      const t = tmpl.get(key);
      const c = curr.get(key);
      if (!t || !c || [...t].some((r) => !c.has(r)) || [...c].some((r) => !t.has(r))) changed.add(key);
    }
    return changed;
  }, [showDiffFromTemplate, entries, templateEntries]);

  // I: Engpass-Simulation
  const bottleneckSimEntries = useMemo(() => {
    const needle = bottleneckRecipe.trim().toLowerCase();
    if (!needle) return null;
    return entries.filter((e) => e.recipe.toLowerCase() !== needle);
  }, [entries, bottleneckRecipe]);

  // F: Koch-Plan Fehlende Rezepte
  const cookScheduleMissingCount = useMemo(() => {
    if (!cookScheduleRecipes) return 0;
    return entries.filter((e) => deriveEntryKind(e) === "meal" && !cookScheduleRecipes.has(e.recipe.toLowerCase())).length;
  }, [entries, cookScheduleRecipes]);

  // J: Share-URL
  const shareUrl = typeof window !== "undefined"
    ? `${window.location.origin}${window.location.pathname}?market=${market}&week=${encodeURIComponent(week)}&lines=${encodeURIComponent((usedLines.length > 0 ? usedLines : activeLines).join(","))}`
    : "";

  // Ref: verhindert doppelten Optimizer-Aufruf wenn updatePicksPerWorker bereits optimiert hat
  const skipNextAutoOptimizeRef = useRef(false);

  useEffect(() => {
    if (recommendationOnly) return;
    if (hasManualEdits) return;
    if (draggedEntryIdRef.current) return;
    if (skipNextAutoOptimizeRef.current) {
      skipNextAutoOptimizeRef.current = false;
      return;
    }
    const nextEntries = optimizeAutomaticRackPlan(entries, market, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, staffingMode, lockedStationsByLine, activePickfaceWindows);
    if (nextEntries === entries) return;
    const prevPositions = new Map(entries.map((e) => [e.id, e.flowRackPosition]));
    const movedCount = nextEntries.filter((e) => prevPositions.get(e.id) !== e.flowRackPosition).length;
    if (movedCount === 0) return;
    setEntries(nextEntries);
    setStatus(locale === "de"
      ? `${movedCount} Einträge automatisch neu verteilt: Ein Fach pro Eintrag als Standard, Modus ${staffingMode === "reduce" ? "Mitarbeiter senken" : staffingMode === "increase" ? "Mitarbeiter erhöhen" : "balanciert"}.`
      : `Rebalanced ${movedCount} entries with staffing mode ${staffingMode}.`);
  }, [entries, market, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, locale, staffingMode, recommendationOnly, hasManualEdits, lockedStationsByLine]);

  // Block-Freigaben/Sperren wirken nur als Regelrahmen.
  // Die tatsächliche Umplanung startet erst auf Nutzeraktion (Automatisch oder manuell).

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
      // Rohe Einträge merken und PDL-Filter anwenden (falls PDL bereits geladen)
      rawEntriesRef.current = nextEntries;
      const filteredEntries = pdlIds && pdlIds.size > 0
        ? applyPdlFilter(nextEntries, pdlIds)
        : nextEntries;
      setEntries(filteredEntries);
      setTemplateEntries(filteredEntries);
      setPicksPerWorker(picksPerWorkerForHallReference(filteredEntries, nextSlotMeta, market, 120));
      setSlotMeta(nextSlotMeta);
      localStorage.setItem(`rack-workbook-loaded-at-${market}`, String(Date.now()));
      setWorkbookStale(false);
      setSourceLabel(file.name);
      const mealCount = filteredEntries.filter((e) => deriveEntryKind(e) === "meal").length;
      setStatus(locale === "de"
        ? `MultiLine importiert: ${file.name} · ${mealCount} Mahlzeiten`
        : `MultiLine imported: ${file.name} · ${mealCount} meals`);
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
      const ids = await parsePdlCsv(file, week);
      setPdlIds(ids);
      // Einträge neu aus rohen MultiLine-Daten filtern (falls geladen)
      const base = rawEntriesRef.current.length > 0 ? rawEntriesRef.current : entries;
      const filtered = applyPdlFilter(base, ids);
      setEntries(filtered);
      setTemplateEntries(filtered);
      setPicksPerWorker(picksPerWorkerForHallReference(filtered, slotMeta, market, 120));
      const mealCount = filtered.filter((e) => deriveEntryKind(e) === "meal").length;
      setStatus(locale === "de"
        ? `PDL geladen: ${file.name} · ${mealCount} Mahlzeiten für ${week}`
        : `PDL loaded: ${file.name} · ${mealCount} meals for ${week}`);
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

  // F: Koch-Plan CSV einlesen
  async function handleCookScheduleUpload(file: File) {
    setBusy(locale === "de" ? "Koch-Plan wird eingelesen …" : "Loading cook schedule …");
    try {
      const text = await file.text();
      const rows = text.split("\n").slice(1);
      const ids = new Set<string>();
      for (const row of rows) {
        const cell = row.split(",")[0]?.trim().replace(/^"|"$/g, "");
        if (cell) ids.add(cell.toLowerCase());
      }
      setCookScheduleRecipes(ids);
      setStatus(locale === "de" ? `Koch-Plan: ${ids.size} Rezepte aus ${file.name}` : `Cook schedule: ${ids.size} recipes from ${file.name}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setBusy(null);
    }
  }

  // E: Plan in Firestore freigeben
  async function handleReleasePlan() {
    if (entries.length === 0) return;
    setBusy(locale === "de" ? "Plan wird freigegeben …" : "Releasing plan …");
    try {
      const { getFirebase } = await import("./firebase");
      const { doc, setDoc, collection, addDoc } = await import("firebase/firestore");
      const { db } = getFirebase();
      const payload = {
        week,
        market,
        entryCount: entries.length,
        releasedAt: Date.now(),
        entries: entries.map((e) => ({ recipe: e.recipe, line: e.line, flowRackPosition: e.flowRackPosition, quantity: e.quantity })),
      };
      await setDoc(doc(db, `apps/rezeptlogik/plans/${market}_${week.replace(/\W/g, "-")}`), payload);
      await addDoc(collection(db, "apps/rezeptlogik/planHistory"), payload);
      setPlanHistoryItems((prev) => [{ ts: payload.releasedAt, market, week, entryCount: entries.length }, ...prev].slice(0, 10));
      setStatus(locale === "de" ? `✓ Plan für ${week} freigegeben (${entries.length} Einträge).` : `✓ Plan for ${week} released (${entries.length} entries).`);
    } catch (error) {
      setStatus(locale === "de" ? `Freigabe fehlgeschlagen: ${String(error)}` : `Release failed: ${String(error)}`);
    } finally {
      setBusy(null);
    }
  }

  // K: Planung bereinigen + in Firestore dokumentieren
  async function handleClearPlan() {
    const snapshotCount = entries.length;
    const snapshotEntries = entries.map((e) => ({ recipe: e.recipe, line: e.line, flowRackPosition: e.flowRackPosition, quantity: e.quantity }));
    setEntries([]);
    // templateEntries und rawEntriesRef absichtlich NICHT leeren,
    // damit "Beste Linie bauen" nach der Bereinigung weiterhin als Datenquelle dienen kann.
    setComparison(null);
    setShowClearConfirm(false);
    setStatus(locale === "de" ? `Planung bereinigt (${snapshotCount} Einträge gelöscht).` : `Plan cleared (${snapshotCount} entries removed).`);
    try {
      const { getFirebase } = await import("./firebase");
      const { collection, addDoc } = await import("firebase/firestore");
      const { db } = getFirebase();
      const clearedBy = window.location.hostname || "unknown";
      const payload = {
        week,
        market,
        entryCount: snapshotCount,
        clearedAt: Date.now(),
        clearedBy,
        snapshot: snapshotEntries,
      };
      await addDoc(collection(db, "apps/rezeptlogik/planClearLog"), payload);
      setClearLogs((prev) => [{ ts: payload.clearedAt, market, week, entryCount: snapshotCount, clearedBy }, ...prev].slice(0, 20));
    } catch {
      // Log-Fehler still ignorieren – Plan ist bereits lokal bereinigt
    }
  }

  // K: Clear-Logs aus Firestore laden
  async function loadClearLogs() {
    try {
      const { getFirebase } = await import("./firebase");
      const { collection, query, where, orderBy, limit, getDocs } = await import("firebase/firestore");
      const { db } = getFirebase();
      const q = query(collection(db, "apps/rezeptlogik/planClearLog"), where("market", "==", market), orderBy("clearedAt", "desc"), limit(20));
      const snap = await getDocs(q);
      setClearLogs(snap.docs.map((d) => {
        const data = d.data() as { clearedAt: number; market: string; week: string; entryCount: number; clearedBy: string };
        return { ts: data.clearedAt, market: data.market, week: data.week, entryCount: data.entryCount, clearedBy: data.clearedBy };
      }));
    } catch {
      // ignorieren
    }
  }

  // H: Letzte freigegebene Pläne laden
  async function loadPlanHistory() {
    try {
      const { getFirebase } = await import("./firebase");
      const { collection, query, where, orderBy, limit, getDocs } = await import("firebase/firestore");
      const { db } = getFirebase();
      const q = query(collection(db, "apps/rezeptlogik/planHistory"), where("market", "==", market), orderBy("releasedAt", "desc"), limit(8));
      const snap = await getDocs(q);
      setPlanHistoryItems(snap.docs.map((d) => {
        const data = d.data() as { releasedAt: number; market: string; week: string; entryCount: number };
        return { ts: data.releasedAt, market: data.market, week: data.week, entryCount: data.entryCount };
      }));
    } catch {
      // Firestore not configured yet – ignore silently
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

  function updatePicksPerWorker(nextValue: number) {
    const safeNext = Math.max(1, Math.round(nextValue));
    let nextMode: StaffingMode = staffingMode;
    if (totalDemandPicks > 0) {
      const currentWorkers = totalDemandPicks / Math.max(1, picksPerWorker);
      const nextWorkers = totalDemandPicks / safeNext;
      if (nextWorkers > currentWorkers + 0.01) {
        nextMode = "increase";
      } else if (nextWorkers < currentWorkers - 0.01) {
        nextMode = "reduce";
      } else {
        nextMode = "balanced";
      }
    }
    setStaffingMode(nextMode);
    setPlannedWorkersManual(null);
    setComparison(null);
    setRecommendationOnly(false);
    setPicksPerWorker(safeNext);
    const nextEntries = optimizeAutomaticRackPlan(entries, market, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, nextMode, lockedStationsByLine, activePickfaceWindows);
    skipNextAutoOptimizeRef.current = true;
    setEntries(nextEntries);
    const prevPositions = new Map(entries.map((e) => [e.id, e.flowRackPosition]));
    const movedEntries = nextEntries.filter((e) => prevPositions.get(e.id) !== e.flowRackPosition).length;
    const nextWorkersFte = totalDemandPicks > 0 ? totalDemandPicks / safeNext : 0;
    setStatus(locale === "de"
      ? `Mitarbeiter-Schlüssel auf ${safeNext} gesetzt (${nextWorkersFte.toFixed(1)} FTE). Rack wurde mit Modus ${nextMode === "reduce" ? "Mitarbeiter senken" : nextMode === "increase" ? "Mitarbeiter erhöhen" : "balanciert"} neu geplant (${movedEntries} Verschiebungen).`
      : `Staffing factor set to ${safeNext} (${nextWorkersFte.toFixed(1)} FTE). Rack replanned in ${nextMode} mode (${movedEntries} moves).`);
  }

  function applyPlannedWorkersTarget(nextWorkers: number) {
    const safeWorkers = Math.max(1, Math.round(nextWorkers));
    const previousWindows = activePickfaceWindows;
    const nextWorkersDrivenWindows = buildActivePickfaceWindows(market, safeWorkers, hallLayoutWorkers);
    const nextActiveWindows = nextWorkersDrivenWindows.filter((window) => {
      if (window.zuschaltbar && !enabledZuschaltbarPickfaceIds.has(window.id)) return false;
      return !disabledPickfaceIds.has(window.id);
    });
    const windowChanges = pickfaceDelta(previousWindows, nextActiveWindows);

    let nextMode: StaffingMode = staffingMode;
    if (safeWorkers > plannedWorkersRounded) {
      nextMode = "increase";
    } else if (safeWorkers < plannedWorkersRounded) {
      nextMode = "reduce";
    } else {
      nextMode = "balanced";
    }

    const nextPicksPerWorker = totalDemandPicks > 0
      ? Math.max(1, Math.round(totalDemandPicks / safeWorkers))
      : picksPerWorker;

    setStaffingMode(nextMode);
    setPlannedWorkersManual(safeWorkers);
    setComparison(null);
    setRecommendationOnly(false);
    if (totalDemandPicks > 0) {
      setPicksPerWorker(nextPicksPerWorker);
    }

    const nextEntries = optimizeAutomaticRackPlan(
      entries,
      market,
      highRunnerRecipes,
      slotMeta,
      preferredSlotsByRecipe,
      nextMode,
      lockedStationsByLine,
      nextActiveWindows,
    );

    skipNextAutoOptimizeRef.current = true;
    setEntries(nextEntries);

    const movedEntries = nextEntries.filter((entry) => {
      const previous = entries.find((candidate) => candidate.id === entry.id);
      return previous && previous.flowRackPosition !== entry.flowRackPosition;
    }).length;

    const openedText = windowChanges.opened.map((window) => pickfaceWindowLabel(window, locale)).join(", ");
    const closedText = windowChanges.closed.map((window) => pickfaceWindowLabel(window, locale)).join(", ");
    const windowStatus = openedText
      ? (locale === "de" ? `geöffnet: ${openedText}` : `opened: ${openedText}`)
      : closedText
        ? (locale === "de" ? `geschlossen: ${closedText}` : `closed: ${closedText}`)
        : (locale === "de" ? "keine Pickface-Änderung" : "no pickface change");

    setStatus(locale === "de"
      ? `Planung auf ${safeWorkers} MA gesetzt (${nextPicksPerWorker} Picks/MA, ${nextActiveWindows.length} aktive Pickfenster): ${windowStatus}. ${movedEntries} Einträge wurden automatisch neu verteilt.`
      : `Planning set to ${safeWorkers} workers (${nextPicksPerWorker} picks/worker, ${nextActiveWindows.length} active pick windows): ${windowStatus}. ${movedEntries} entries were rebalanced.`);
  }

  function adjustPlannedWorkers(delta: number) {
    applyPlannedWorkersTarget(plannedWorkersRounded + delta);
  }

  function setPlannedWorkersAbsolute(nextWorkers: number) {
    applyPlannedWorkersTarget(nextWorkers);
  }

  function suggestBestPlan() {
    const errors   = validation.issues.filter((i) => i.severity === "error").map((i) => i.message);
    const warnings = validation.issues.filter((i) => i.severity === "warning").map((i) => i.message);
    if (errors.length > 0 || warnings.length > 0) {
      setPrebuildBlocker({ errors, warnings });
      return;
    }
    _doSuggestBestPlan();
  }

  function _doSuggestBestPlan() {
    setPrebuildBlocker(null);
    const source = templateEntries.length > 0 ? projectRackEntriesToLines(templateEntries, activeLines) : entries;
    if (source.length === 0) return;
    const nextEntries = optimizeAutomaticRackPlan(source, market, highRunnerRecipes, slotMeta, preferredSlotsByRecipe, staffingMode, lockedStationsByLine, activePickfaceWindows);
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
    draggedEntryIdRef.current = entryId;
    // kein setState hier – jeder Re-Render während dragstart bricht den Drag sofort ab
    console.log(`[RackView] dragstart: id="${entryId}"`);
  }

  function handlePillDragEnd() {
    draggedEntryIdRef.current = null;
    setDraggedEntryId(null); // hier ist State ok – Drag ist schon vorbei
    setHoveredSlotKey(null);
    console.log(`[RackView] dragend`);
    setStatus(`DEBUG dragend (kein drop gelandet)`);
  }

  function handleSlotDrop(line: string, flowRackPosition: string, event?: React.DragEvent) {
    if (!isPositionActiveByWorkers(flowRackPosition.toUpperCase(), market, activePickfaceWindows)) {
      setStatus(locale === "de"
        ? `${line}/${flowRackPosition.toUpperCase()} ist aktuell nicht planbar (Pickfenster durch MA-Modell deaktiviert).`
        : `${line}/${flowRackPosition.toUpperCase()} is currently not plannable (pick window disabled by staffing model).`);
      return;
    }
    const activeDraggedEntryId = (event ? event.dataTransfer.getData("text/plain") : "") || draggedEntryIdRef.current || draggedEntryId;
    console.log(`[RackView] drop: id="${activeDraggedEntryId}" → ${line}/${flowRackPosition}`);
    setStatus(`DEBUG drop: id="${activeDraggedEntryId}" → ${line}/${flowRackPosition}`);
    if (!activeDraggedEntryId) return;
    const draggedEntry = entries.find((entry) => entry.id === activeDraggedEntryId);
    const targetEntries = entries.filter((entry) => entry.line === line && entry.flowRackPosition.toUpperCase() === flowRackPosition.toUpperCase() && entry.id !== activeDraggedEntryId);
    const targetPosition = flowRackPosition.toUpperCase();
    const sourceSlotKey = draggedEntry ? `${draggedEntry.line}:${draggedEntry.flowRackPosition.toUpperCase()}` : null;
    let relocatedCount = 0;
    const relocatedEntryIds = new Set<string>();

    setEntries((current) => {
      let next = moveRackEntry(current, activeDraggedEntryId, line, targetPosition);
      if (targetEntries.length === 0) return next;

      const activeLineOrder = [line, ...activeLines.filter((candidate) => candidate !== line)];
      const orderedPositions = [...slotMeta.keys()].sort((a, b) =>
        Math.abs(rackPositionNumber(a) - rackPositionNumber(targetPosition))
        - Math.abs(rackPositionNumber(b) - rackPositionNumber(targetPosition))
        || rackPositionNumber(a) - rackPositionNumber(b)
      );

      const occupied = new Set<string>();
      for (const entry of next) {
        occupied.add(`${entry.line}:${entry.flowRackPosition.toUpperCase()}`);
      }

      for (const displaced of targetEntries) {
        const tryPlace = (allowSourceFallback: boolean) => {
          for (const candidateLine of activeLineOrder) {
            for (const candidatePosition of orderedPositions) {
              const slotKey = `${candidateLine}:${candidatePosition}`;
              if (!allowSourceFallback && sourceSlotKey && slotKey === sourceSlotKey) continue;
              if (occupied.has(slotKey)) continue;
              next = moveRackEntry(next, displaced.id, candidateLine, candidatePosition);
              occupied.add(slotKey);
              relocatedCount += 1;
              relocatedEntryIds.add(displaced.id);
              return true;
            }
          }
          return false;
        };

        const placedAwayFromSource = tryPlace(false);
        if (!placedAwayFromSource) {
          void tryPlace(true);
        }
      }

      return next;
    });

    if (draggedEntry) {
      setStatus(
        relocatedCount > 0
          ? `${draggedEntry.recipe} auf ${line}/${targetPosition} abgelegt. ${relocatedCount} bestehende Pill(en) wurden automatisch auf freie Fächer verteilt.`
          : `${draggedEntry.recipe} auf ${line}/${targetPosition} abgelegt.`
      );
    }

    if (relocatedEntryIds.size > 0) {
      setRecentlyRelocatedEntryIds(new Set(relocatedEntryIds));
      if (relocatedHighlightTimerRef.current) clearTimeout(relocatedHighlightTimerRef.current);
      relocatedHighlightTimerRef.current = setTimeout(() => {
        setRecentlyRelocatedEntryIds(new Set());
      }, 2600);
    } else {
      setRecentlyRelocatedEntryIds(new Set());
    }

    draggedEntryIdRef.current = null;
    setDraggedEntryId(null);
    setHoveredSlotKey(null);
    setHasManualEdits(true);
    skipNextAutoOptimizeRef.current = true;
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
                  <button className="btn btn-primary" onClick={suggestBestPlan} disabled={(entries.length === 0 && templateEntries.length === 0) || slotMeta.size === 0}>
                    {locale === "de" ? "Beste Linie bauen" : "Build best line"}
                  </button>
                  {/* C: Template-Vergleich */}
                  <button
                    className={`btn ${showDiffFromTemplate ? "btn-primary" : ""}`}
                    onClick={() => setShowDiffFromTemplate((v) => !v)}
                    disabled={templateEntries.length === 0}
                    title={locale === "de" ? "Zeigt violette Punkte an geänderten Slots" : "Shows violet dots on changed slots"}
                  >
                    {locale === "de" ? "Δ Vergleich" : "Δ Diff"}
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
              {/* I: Engpass-Simulation */}
              <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Engpass-Simulation (Rezept entfernen)" : "Bottleneck simulation (remove recipe)"}</div>
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-800 outline-none ring-1 ring-slate-100 focus:ring-2 focus:ring-slate-400"
                    placeholder={locale === "de" ? "Rezept-ID eingeben …" : "Enter recipe ID …"}
                    value={bottleneckRecipe}
                    onChange={(e) => setBottleneckRecipe(e.target.value)}
                  />
                  {bottleneckRecipe && (
                    <button className="btn" onClick={() => setBottleneckRecipe("")}>{locale === "de" ? "Zurücksetzen" : "Clear"}</button>
                  )}
                </div>
                {bottleneckSimEntries !== null && (
                  <div className="mt-2 text-sm text-rose-700">
                    {locale === "de"
                      ? `Simulation: ${entries.length - bottleneckSimEntries.length} Eintrag/Einträge entfernt. ${bottleneckSimEntries.length} Einträge verbleiben.`
                      : `Simulation: ${entries.length - bottleneckSimEntries.length} entry/entries removed. ${bottleneckSimEntries.length} remaining.`}
                  </div>
                )}
              </div>
            </div>

            {(() => {
              const hasData = entries.length > 0 || templateEntries.length > 0;
              const sources = [
                { key: "multiline", label: "MultiLine XLSX", loaded: hasData && slotMeta.size > 0, auto: true },
                { key: "rackfile",  label: "Rackfile CSV",  loaded: hasData, auto: false },
                { key: "pdl",       label: "PDL CSV",       loaded: pdlIds !== undefined, auto: true },
                { key: "boxfile",   label: "Boxfile CSV",   loaded: boxfile !== undefined, auto: false },
                { key: "co2",       label: "CO2 CSV",       loaded: co2MealIds !== undefined, auto: false },
                { key: "kochplan",  label: locale === "de" ? "Koch-Plan CSV" : "Cook schedule CSV", loaded: cookScheduleRecipes !== undefined, auto: false },
              ] as const;
              const loadedCount = sources.filter((s) => s.loaded).length;
              const allOk = !autoLoadFailed && loadedCount >= 3; // MultiLine + PDL + mindestens 1 optional
              const headerBg = autoLoadFailed
                ? "bg-rose-50 border-rose-300 ring-rose-200"
                : loadedCount >= 2
                ? "bg-emerald-50 border-emerald-300 ring-emerald-100"
                : "bg-slate-50 border-slate-200 ring-slate-100";
              const headerText = autoLoadFailed
                ? "text-rose-800"
                : loadedCount >= 2
                ? "text-emerald-800"
                : "text-slate-600";
              return (
                <div className="rounded-2xl border ring-1 overflow-hidden transition-all" style={{}}>
                  <button
                    type="button"
                    onClick={() => setUploadOpen((v) => !v)}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors ${headerBg}`}
                  >
                    <div className={`flex items-center gap-2 text-sm font-semibold ${headerText}`}>
                      <span className={`text-base ${autoLoadFailed ? "text-rose-600" : loadedCount >= 2 ? "text-emerald-600" : "text-slate-400"}`}>
                        {autoLoadFailed ? "✗" : loadedCount >= 2 ? "✓" : "○"}
                      </span>
                      <span>
                        {autoLoadFailed
                          ? (locale === "de" ? "Auto-Load fehlgeschlagen" : "Auto-load failed")
                          : locale === "de"
                          ? `Datenquellen · ${loadedCount} von ${sources.length} geladen`
                          : `Data sources · ${loadedCount} of ${sources.length} loaded`}
                      </span>
                      <div className="flex gap-1 ml-2">
                        {sources.map((s) => (
                          <span
                            key={s.key}
                            title={s.label}
                            className={`inline-block h-2 w-2 rounded-full ${s.loaded ? (autoLoadFailed && s.auto ? "bg-rose-500" : "bg-emerald-500") : "bg-slate-300"}`}
                          />
                        ))}
                      </div>
                    </div>
                    <span className={`text-xs font-bold transition-transform duration-200 ${uploadOpen ? "rotate-180" : ""} ${headerText}`}>▼</span>
                  </button>
                  {uploadOpen && (
                    <div className="p-3 border-t border-slate-200">
                      <div className="mb-3 rounded-xl border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-500">
                        {locale === "de"
                          ? "Standardquellen (MultiLine + PDL) werden automatisch geladen. Die folgenden Uploads sind nur für manuelle Overrides oder zusätzliche Validierung gedacht."
                          : "Default sources (MultiLine + PDL) are loaded automatically. The uploads below are for manual overrides or additional validation only."}
                      </div>
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        <UploadCard label="MultiLine XLSX" hint={locale === "de" ? `${profile.sheet} · optional überschreiben` : `${profile.sheet} · optional override`} onPick={handleMultilineUpload} accept=".xlsx" />
                        <UploadCard label="Rackfile CSV" hint={locale === "de" ? "optional: bestehendes Rackfile importieren" : "optional: import existing rackfile"} onPick={handleRackfileUpload} accept=".csv" />
                        <UploadCard label="PDL CSV" hint={locale === "de" ? "optional: Meal-Soll überschreiben" : "optional: override meal target"} onPick={handlePdlUpload} accept=".csv" />
                        <UploadCard label="Boxfile CSV" hint={locale === "de" ? "optional: ETL BOXFILE_VE für Zusatzchecks" : "optional: ETL BOXFILE_VE for extra checks"} onPick={handleBoxfileUpload} accept=".csv" />
                        <UploadCard label="CO2 CSV" hint={locale === "de" ? `optional: ETL CO_2 (${profile.boxPrefix})` : `optional: ETL CO_2 (${profile.boxPrefix})`} onPick={handleCo2Upload} accept=".csv" />
                        <UploadCard
                          label={locale === "de" ? "Koch-Plan CSV" : "Cook schedule CSV"}
                          hint={locale === "de"
                            ? `optional: Rezept-Abgleich${cookScheduleMissingCount > 0 ? ` · ${cookScheduleMissingCount} fehlend` : cookScheduleRecipes ? " · ok" : ""}`
                            : `optional: recipe cross-check${cookScheduleMissingCount > 0 ? ` · ${cookScheduleMissingCount} missing` : cookScheduleRecipes ? " · ok" : ""}`}
                          onPick={handleCookScheduleUpload}
                          accept=".csv"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="rounded-[28px] bg-[radial-gradient(circle_at_top_right,rgba(14,165,233,0.16),transparent_32%),linear-gradient(135deg,rgba(248,250,252,0.96),rgba(255,255,255,0.96))] p-4 ring-1 ring-slate-200 shadow-[0_24px_60px_-40px_rgba(14,165,233,0.35)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Status" : "Status"}</div>
                <div className="mt-1 inline-flex items-center rounded-full bg-slate-950 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white">{busy ? (locale === "de" ? "Lädt" : "Loading") : (locale === "de" ? "Bereit" : "Ready")}</div>
                <div className="mt-2 text-sm font-medium text-slate-800">{busy ?? status}</div>
                {sourceLabel && <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500"><span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">{locale === "de" ? "Quelle" : "Source"}</span><span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-slate-200">{sourceLabel}</span></div>}
                {/* G: Workbook-Veraltet-Hinweis */}
                {workbookStale && (
                  <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
                    ⚠ {locale === "de" ? "Workbook vor mehr als 7 Tagen geladen – bitte aktualisieren." : "Workbook loaded more than 7 days ago – please refresh."}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <button
                  className="btn btn-primary"
                  disabled={entries.length === 0}
                  onClick={() => downloadText(market === "de" ? `Rackfile_[${week}]_[F-DE]_[${usedLines.join("_") || activeLines.join("_")}].csv` : `Rackfile_KW${week.split("W").at(-1)}_[Fact-Nordics]_[ASL${(usedLines.length > 0 ? usedLines : activeLines).map((line) => line.replace("ASL", "")).join(",")}].csv`, exportRackfileCsv(entries))}
                >
                  {locale === "de" ? "Rackfile exportieren" : "Export rackfile"}
                </button>
                {/* E: Plan freigeben */}
                <button className="btn" disabled={entries.length === 0} onClick={() => { void handleReleasePlan(); }}>
                  {locale === "de" ? "Plan freigeben" : "Release plan"}
                </button>
                {/* K: Planung bereinigen */}
                <button
                  className="btn border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
                  disabled={entries.length === 0}
                  onClick={() => setShowClearConfirm(true)}
                >
                  {locale === "de" ? "Planung bereinigen" : "Clear plan"}
                </button>
                {/* J: QR-Sharing */}
                <button className="btn" onClick={() => setShowQrModal(true)}>QR / URL</button>
              </div>
            </div>
            <div className="mt-4 rounded-2xl bg-white/85 p-3 ring-1 ring-slate-200 backdrop-blur">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-900">{locale === "de" ? "Auto-Load aktiv" : "Auto-load active"}</span>
                <span className="rounded-full bg-sky-100 px-2.5 py-1 text-sky-900">{locale === "de" ? "Workbook getrennt nachgeladen" : "Workbook loaded separately"}</span>
                <span className="rounded-full bg-violet-100 px-2.5 py-1 text-violet-900">{locale === "de" ? `${usedLines.length || activeLines.length} Linien im Fokus` : `${usedLines.length || activeLines.length} lines in focus`}</span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 xl:grid-cols-7">
              <MiniStat label={locale === "de" ? "Mahlzeiten" : "Meals"} value={summary.meal} />
              <MiniStat label={locale === "de" ? "Verpackung" : "Packaging"} value={summary.packaging} />
              <MiniStat label="Ice" value={summary.ice} />
              <MiniStat label="Loyalty" value={summary.loyalty} />
              <MiniStat label={locale === "de" ? "Getränke" : "Beverage"} value={summary.beverage} />
              <MiniStat label={locale === "de" ? "Protein" : "Protein"} value={summary.protein} />
              <MiniStat label={locale === "de" ? "Validierung" : "Validation"} value={validation.ok ? "OK" : validation.issues.filter((issue) => issue.severity === "error").length} accent={!validation.ok} />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white p-3 ring-1 ring-slate-200">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locale === "de" ? "Mitarbeiter-Schlüssel" : "Staffing factor"}</div>
                <div className="mt-1 text-sm text-slate-600">{locale === "de" ? "Picks pro Mitarbeiter ist ein Planungs-Schlüssel (kein Zeitstempel): Gesamte Picksumme geteilt durch diesen Wert ergibt den geplanten MA-Bedarf." : "Picks per worker is a planning key (not a timestamp): total picks divided by this value equals planned staffing demand."}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em]">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">{locale === "de" ? `Picks gesamt ${Math.round(totalDemandPicks)}` : `Total picks ${Math.round(totalDemandPicks)}`}</span>
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-900">{locale === "de" ? `Geplant ${plannedWorkersRounded} MA` : `Planned ${plannedWorkersRounded} workers`}</span>
                  <span className="rounded-full bg-sky-100 px-2.5 py-1 text-sky-900">{locale === "de" ? `${plannedWorkersFte.toFixed(1)} FTE` : `${plannedWorkersFte.toFixed(1)} FTE`}</span>
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-900">{locale === "de" ? `Hallenbild ${hallLayoutWorkers} MA` : `Layout ${hallLayoutWorkers} workers`}</span>
                  <span className="rounded-full bg-violet-100 px-2.5 py-1 text-violet-900">{locale === "de" ? `Aktive Pickfenster ${activePickfaceWindows.length}` : `Active pick windows ${activePickfaceWindows.length}`}</span>
                </div>
                {plannedWorkersRounded < hallLayoutWorkers && (
                  <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                    {locale === "de"
                      ? `Hinweis: Das Hallenbild ist auf ${hallLayoutWorkers} MA ausgelegt, aktuell berechnet sind ${plannedWorkersRounded} MA.`
                      : `Note: The floor layout is sized for ${hallLayoutWorkers} workers, current model calculates ${plannedWorkersRounded}.`}
                  </div>
                )}
                <div className="mt-2 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
                  {locale === "de"
                    ? "Harte Regel aktiv: Die ersten zwei Stationen sind nicht verhandelbar. Dort wird bei der Neuplanung keine Last hinzugefügt oder entfernt."
                    : "Hard rule active: the first two stations are non-negotiable. Replanning does not add or remove workload there."}
                </div>
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
                      onClick={() => {
                        setComparison(null);
                        setRecommendationOnly(false);
                        setStaffingMode(option.id);
                      }}
                      className={`rounded-xl px-3 py-2 text-sm font-semibold ${staffingMode === option.id ? "bg-slate-900 text-white" : "text-slate-600"}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-800"
                    onClick={() => setPlannedWorkersAbsolute(hallLayoutWorkers)}
                    title={locale === "de" ? `Picks/MA so setzen, dass auf ${hallLayoutWorkers} Mitarbeiter geplant wird` : `Set picks/worker to plan with ${hallLayoutWorkers} workers`}
                  >
                    {locale === "de" ? `Auf ${hallLayoutWorkers} MA planen` : `Plan for ${hallLayoutWorkers} workers`}
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800"
                    onClick={() => adjustPlannedWorkers(-1)}
                    title={locale === "de" ? "1 Mitarbeiter weniger planen und Rack neu balancieren" : "Plan one fewer worker and rebalance rack"}
                  >
                    -1 MA
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-800"
                    onClick={() => adjustPlannedWorkers(1)}
                    title={locale === "de" ? "1 Mitarbeiter mehr planen und Rack neu balancieren" : "Plan one additional worker and rebalance rack"}
                  >
                    +1 MA
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold text-slate-700"
                    onClick={() => updatePicksPerWorker(Math.max(10, picksPerWorker - 10))}
                  >
                    -10
                  </button>
                  <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                    {locale === "de" ? "Picks / Mitarbeiter" : "Picks / worker"}
                    <input
                      type="number"
                      min={1}
                      value={picksPerWorker}
                      onChange={(event) => updatePicksPerWorker(Math.max(1, Number(event.target.value) || 1))}
                      className="w-28 rounded-xl border-slate-300 px-3 py-2 ring-1 ring-slate-300"
                    />
                  </label>
                  <button
                    type="button"
                    className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-bold text-slate-700"
                    onClick={() => updatePicksPerWorker(picksPerWorker + 10)}
                  >
                    +10
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={`grid gap-4 ${displayTab !== "detail" ? "xl:grid-cols-[0.78fr_1.22fr]" : ""}`}>
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
              <div className="px-4 pt-4">
                <div className="grid gap-3 xl:grid-cols-[1.15fr_0.85fr]">
                  <div className="relative overflow-hidden rounded-[26px] border border-slate-200 bg-[radial-gradient(circle_at_18%_20%,rgba(56,189,248,0.22),transparent_35%),radial-gradient(circle_at_85%_15%,rgba(167,139,250,0.2),transparent_40%),linear-gradient(135deg,rgba(15,23,42,0.95),rgba(15,118,110,0.86))] p-4 text-white shadow-[0_28px_55px_-34px_rgba(15,23,42,0.85)]">
                    <div className="text-[11px] font-black uppercase tracking-[0.2em] text-sky-100">{locale === "de" ? "3D Slot Twin" : "3D slot twin"}</div>
                    <div className="mt-2 text-lg font-black tracking-tight">{selectedFocus.line} · {selectedFocus.position.toUpperCase()}</div>
                    <div className="mt-1 text-xs text-sky-100/90">{selectedMeta?.station || (locale === "de" ? "ohne Station" : "no station")}</div>
                    <div className="mt-4 flex items-center gap-5">
                      <div className="[perspective:1100px]">
                        <div className="relative h-24 w-28" style={{ transform: "rotateX(18deg) rotateY(-28deg)", transformStyle: "preserve-3d" }}>
                          <div className="absolute inset-0 rounded-lg border border-emerald-200/60 bg-emerald-300/65 shadow-[0_10px_24px_-14px_rgba(16,185,129,0.95)]" style={{ transform: "translateZ(16px)" }} />
                          <div className="absolute inset-0 rounded-lg border border-cyan-200/50 bg-cyan-200/45" style={{ transform: "rotateY(90deg) translateZ(16px)", transformOrigin: "left center" }} />
                          <div className="absolute inset-0 rounded-lg border border-slate-200/40 bg-slate-100/40" style={{ transform: "rotateX(90deg) translateZ(16px)", transformOrigin: "center top" }} />
                          <div className="absolute inset-0 flex items-center justify-center text-sm font-black text-slate-900" style={{ transform: "translateZ(18px)" }}>{selectedEntries.length || 0}</div>
                        </div>
                      </div>
                      <div className="space-y-1.5 text-xs">
                        <div className="rounded-full bg-white/12 px-3 py-1.5 ring-1 ring-white/25">{locale === "de" ? "Aktive Pills" : "Active pills"}: <strong>{selectedEntries.length}</strong></div>
                        <div className="rounded-full bg-white/12 px-3 py-1.5 ring-1 ring-white/25">{locale === "de" ? "Plan-Picks" : "Planned picks"}: <strong>{selectedPlannedPickCount}</strong></div>
                        <div className="rounded-full bg-white/12 px-3 py-1.5 ring-1 ring-white/25">{locale === "de" ? "Soll-Demand" : "Target demand"}: <strong>{selectedDemandPickCount}</strong></div>
                      </div>
                    </div>
                  </div>
                  <div className="rounded-[24px] border border-slate-200 bg-slate-50 p-3 ring-1 ring-slate-200">
                    <div className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Fach-Mix" : "Slot mix"}</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {selectedKindMix.length === 0 && (
                        <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">{locale === "de" ? "Noch leer" : "Empty"}</span>
                      )}
                      {selectedKindMix.map(([kind, count]) => (
                        <span key={`${selectedFocus.line}-${selectedFocus.position}-${kind}`} className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${kindTone(kind as ReturnType<typeof deriveEntryKind>)}`}>
                          {kind} · {count}
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 text-xs text-slate-600">
                      {locale === "de"
                        ? "Direktmodus: Zieh eine Pill auf ein Fach. Ist es belegt, werden die bestehenden Pills automatisch auf freie Fächer verteilt."
                        : "Direct mode: drop a pill onto a slot. If occupied, existing pills are auto-relocated to free slots."}
                    </div>
                  </div>
                </div>
              </div>
              <div className="grid gap-3 p-4 xl:grid-cols-[0.95fr_1.05fr]">
                <div className="space-y-3">
                  <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                    <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Aktuell im Fach" : "Currently in slot"}</div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
                        <div className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{locale === "de" ? "Geplante Picks" : "Planned picks"}</div>
                        <div className="mt-1 text-xl font-black text-slate-900 tabular-nums">{selectedPlannedPickCount}</div>
                      </div>
                      <div className="rounded-xl bg-white px-3 py-2 ring-1 ring-slate-200">
                        <div className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">{locale === "de" ? "Soll-Picks (Sheet)" : "Sheet demand picks"}</div>
                        <div className="mt-1 text-xl font-black text-sky-900 tabular-nums">{selectedDemandPickCount}</div>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      {selectedEntries.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 px-3 py-3 text-sm text-slate-500">{locale === "de" ? "Kein Eintrag im aktuellen Plan." : "No entry in the current plan."}</div>}
                      {selectedEntries.map((entry) => (
                        <button key={entry.id} type="button" onClick={() => setSelectedFocus({ line: selectedFocus.line, position: selectedFocus.position, entryId: entry.id })} className={`flex w-full items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-left transition hover:-translate-y-0.5 hover:shadow-sm ${recentlyRelocatedEntryIds.has(entry.id) ? "ring-2 ring-amber-400 bg-amber-50" : ""}`} title={rackEntryHoverTitle(entry, slotMeta, locale)}>
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
                        <div key={entry.id} className={`rounded-2xl border border-sky-200 bg-white/90 px-3 py-3 shadow-sm ${recentlyRelocatedEntryIds.has(entry.id) ? "ring-2 ring-amber-400 bg-amber-50" : ""}`} title={rackEntryHoverTitle(entry, slotMeta, locale)}>
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
                      <span className="rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white">{item.moved} {locale === "de" ? "Verschiebungen" : "moves"}</span>
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
                    <th className="px-3 py-2">{locale === "de" ? "Rezept" : "Recipe"}</th>
                    <th className="px-3 py-2">{locale === "de" ? "Linie" : "Line"}</th>
                    <th className="px-3 py-2">{locale === "de" ? "Fach" : "Slot"}</th>
                    <th className="px-3 py-2">{locale === "de" ? "Menge" : "Qty"}</th>
                    <th className="px-3 py-2">{locale === "de" ? "Typ" : "Type"}</th>
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
              <h3 className="text-sm font-bold uppercase tracking-wide text-slate-600">{locale === "de" ? "Linienansicht" : "Line map"}</h3>
              <p className="mt-1 text-sm text-slate-500">{locale === "de" ? "Neue klare Etagenansicht: jedes Fach als echte 3er-Säule (z. B. 13, 14, 15 übereinander)." : "Clear tier view: each slot as a true 3-level stack."}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={`rounded-xl px-3 py-2 text-xs font-semibold ${displayTab === "line" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 ring-1 ring-slate-200"}`}
                onClick={() => setDisplayTab("line")}
              >
                {locale === "de" ? "Linien-Reiter" : "Line tab"}
              </button>
              <button
                type="button"
                className={`rounded-xl px-3 py-2 text-xs font-semibold ${displayTab === "visual" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 ring-1 ring-slate-200"}`}
                onClick={() => setDisplayTab("visual")}
              >
                {locale === "de" ? "Detail-Visualisierung" : "Detailed visual"}
              </button>
              <button
                type="button"
                className={`rounded-xl px-3 py-2 text-xs font-bold ring-2 ${displayTab === "detail" ? "bg-sky-700 text-white ring-sky-700" : "bg-sky-50 text-sky-800 ring-sky-300 hover:bg-sky-100"}`}
                onClick={() => setDisplayTab("detail")}
                title={locale === "de" ? "Fokus-Ansicht: Slot- und Rezeptdetails in der Mitte" : "Focus view: slot and recipe details center-stage"}
              >
                {locale === "de" ? "🔍 Detail-Reiter" : "🔍 Detail tab"}
              </button>
              <button
                type="button"
                className={`rounded-xl px-3 py-2 text-xs font-semibold ${validation.ok && entries.length > 0 ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-500"}`}
                onClick={() => downloadText(market === "de" ? `Rackfile_[${week}]_[F-DE]_[${usedLines.join("_") || activeLines.join("_")}].csv` : `Rackfile_KW${week.split("W").at(-1)}_[Fact-Nordics]_[ASL${(usedLines.length > 0 ? usedLines : activeLines).map((line) => line.replace("ASL", "")).join(",")}].csv`, exportRackfileCsv(entries))}
                disabled={!validation.ok || entries.length === 0}
                title={validation.ok ? (locale === "de" ? "Rackfile sofort aus der Linienansicht erstellen" : "Create rackfile directly from line view") : (locale === "de" ? "Erst Fehler beheben, dann Rackfile erstellen" : "Fix validation errors first")}
              >
                {locale === "de" ? "Jetzt Rackfile erstellen" : "Create rackfile now"}
              </button>
            </div>
          </div>

          {unplacedMeals.length > 0 && (
            <div className="mt-4 rounded-2xl border-2 border-dashed border-amber-400 bg-amber-50 px-4 py-4 ring-1 ring-amber-200">
              <div className="flex items-start gap-3">
                <span className="text-2xl" role="img" aria-label="Achtung">⚠️</span>
                <div className="flex-1">
                  <div className="text-sm font-black uppercase tracking-wide text-amber-800">
                    {locale === "de" ? `${unplacedMeals.length} Meal${unplacedMeals.length > 1 ? "s" : ""} ohne Pickplatz – manuell verteilen!` : `${unplacedMeals.length} meal${unplacedMeals.length > 1 ? "s" : ""} without a pickface slot – distribute manually!`}
                  </div>
                  <div className="mt-1 text-xs text-amber-700">
                    {locale === "de" ? "Diese Mahlzeiten liegen außerhalb aller aktiven Pickfaces und wurden nicht automatisch verplant. Bitte händisch einem freien Slot zuweisen." : "These meals are outside all active pickfaces and were not auto-assigned. Please assign them manually to a free slot."}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {unplacedMeals.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-center gap-1.5 rounded-full bg-amber-200 px-3 py-1.5 text-xs font-bold text-amber-900 ring-1 ring-amber-300"
                        title={`${entry.line} · ${entry.flowRackPosition} · ${entry.displayName || entry.ingredient}`}
                      >
                        <span className="rounded-full bg-amber-800 px-1.5 py-0.5 text-[10px] font-black text-amber-50">{entry.line}</span>
                        <span>{entry.recipe}</span>
                        <span className="text-amber-600">@{entry.flowRackPosition}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Per-Linie + Gesamt-Export-Leiste */}
          {entries.length > 0 && displayTab !== "detail" && (
            <div className="mt-4 flex flex-wrap gap-2">
              {(usedLines.length > 0 ? usedLines : activeLines).map((line) => {
                const lineEntries = entries.filter((e) => e.line === line);
                const filename = market === "de"
                  ? `Rackfile_[${week}]_[F-DE]_[${line}].csv`
                  : `Rackfile_KW${week.split("W").at(-1)}_[Fact-Nordics]_[${line}].csv`;
                return (
                  <button
                    key={line}
                    type="button"
                    className="flex items-center gap-1.5 rounded-xl bg-slate-800 px-3 py-2 text-xs font-bold text-white hover:bg-slate-700 disabled:opacity-40"
                    disabled={lineEntries.length === 0}
                    onClick={() => downloadText(filename, exportRackfileCsv(lineEntries))}
                    title={`${lineEntries.length} Einträge auf ${line}`}
                  >
                    <span>📄</span>
                    <span>{line}</span>
                  </button>
                );
              })}
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-xl bg-emerald-700 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-600 disabled:opacity-40"
                disabled={!validation.ok || entries.length === 0}
                onClick={() => downloadText(
                  market === "de"
                    ? `Rackfile_[${week}]_[F-DE]_[${(usedLines.length > 0 ? usedLines : activeLines).join("_")}].csv`
                    : `Rackfile_KW${week.split("W").at(-1)}_[Fact-Nordics]_[ASL${(usedLines.length > 0 ? usedLines : activeLines).map((l) => l.replace("ASL", "")).join(",")}].csv`,
                  exportRackfileCsv(entries),
                )}
                title={locale === "de" ? "Alle aktiven Linien zusammen exportieren" : "Export all active lines combined"}
              >
                <span>📦</span>
                <span>{market === "de" ? "Alle DE" : "Alle Nordics"}</span>
              </button>
            </div>
          )}

          <div className="mt-4 space-y-6">
            {displayTab !== "detail" && (usedLines.length > 0 ? usedLines : activeLines).map((line) => {
              // Physisches Hallenbild ist immer fix — nur die marktspezifischen Slots (keine
              // metaSlots aus dem Workbook), damit DE-Liner-Zone (37–54, 64–84) nicht als
              // Spalten erscheint und der Unterschied zu Nordics sichtbar bleibt.
              const slots = fullHallSlotsForMarket(market);
              if (displayTab === "line") {
                return (
                  <LineLaneBoard
                    key={`${line}-lane-board`}
                    market={market}
                    line={line}
                    slots={slots}
                    entriesByLineAndSlot={entriesByLineAndSlot}
                    slotMeta={slotMeta}
                    locale={locale}
                    selectedFocus={selectedFocus}
                    draggedEntryId={draggedEntryId}
                    highlightedEntryIds={recentlyRelocatedEntryIds}
                    hoveredSlotKey={hoveredSlotKey}
                    onHoverSlot={setHoveredSlotKey}
                    onDropToSlot={handleSlotDrop}
                    onSelectSlot={(selectedLine, position) => setSelectedFocus({ line: selectedLine, position })}
                    onSelectEntry={(entryId, selectedLine, position) => setSelectedFocus({ line: selectedLine, position, entryId })}
                    onPillDragStart={handlePillDragStart}
                    onPillDragEnd={handlePillDragEnd}
                    disabledPickfaceIds={disabledPickfaceIds}
                    enabledZuschaltbarPickfaceIds={enabledZuschaltbarPickfaceIds}
                    closedPickfaceIdsByWorkers={closedPickfaceIdsByWorkers}
                    onTogglePickfaceDisabled={togglePickfaceDisabled}
                    onToggleZuschaltbarPickface={toggleZuschaltbarPickface}
                  />
                );
              }

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
                  highlightedEntryIds={recentlyRelocatedEntryIds}
                  hoveredSlotKey={hoveredSlotKey}
                  onHoverSlot={setHoveredSlotKey}
                  onDropToSlot={handleSlotDrop}
                  onPillDragStart={handlePillDragStart}
                  onPillDragEnd={handlePillDragEnd}
                  onSelectSlot={(selectedLine, position) => setSelectedFocus({ line: selectedLine, position })}
                  onSelectEntry={(entryId, selectedLine, position) => setSelectedFocus({ line: selectedLine, position, entryId })}
                  pdlIds={pdlIds}
                  changedSlots={changedSlots}
                  bottleneckRecipe={bottleneckRecipe}
                  disabledPickfaceIds={disabledPickfaceIds}
                  enabledZuschaltbarPickfaceIds={enabledZuschaltbarPickfaceIds}
                  closedPickfaceIdsByWorkers={closedPickfaceIdsByWorkers}
                  onTogglePickfaceDisabled={togglePickfaceDisabled}
                  onToggleZuschaltbarPickface={toggleZuschaltbarPickface}
                />
              );
            })}
          </div>

          {displayTab === "detail" && (
            <div className="mt-6 rounded-2xl border-2 border-dashed border-sky-200 bg-sky-50 px-5 py-6 text-center text-sm text-sky-700">
              {locale === "de"
                ? "Detail-Modus aktiv – klicke einen Slot in der Linien- oder Visualisierungs-Ansicht, um hier die Details zu sehen."
                : "Detail mode active – click a slot in the line or visual view to inspect it here."}
            </div>
          )}
        </div>
      </section>

      {/* H: Freigabe-Verlauf */}
      {planHistoryItems.length > 0 && (
        <section className="mx-auto max-w-[1600px] px-4 pb-4">
          <div className="rounded-[28px] bg-white p-4 ring-1 ring-slate-200">
            <div className="text-sm font-bold uppercase tracking-wide text-slate-600">{locale === "de" ? "Freigabe-Verlauf" : "Release history"}</div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {planHistoryItems.map((item) => (
                <div key={item.ts} className="rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-800">{item.week}</span>
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-600">{item.market.toUpperCase()}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{item.entryCount} {locale === "de" ? "Einträge" : "entries"} · {new Date(item.ts).toLocaleDateString(locale === "de" ? "de-DE" : "en-GB")}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* K: Clear-Log-Panel */}
      {clearLogs.length > 0 && (
        <section className="mx-auto max-w-[1600px] px-4 pb-4">
          <div className="rounded-[28px] border border-rose-200 bg-rose-50 p-4 ring-1 ring-rose-200">
            <div className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-rose-700">
              <span>⚠</span>
              <span>{locale === "de" ? "Bereinigungen – Protokoll" : "Clear log"}</span>
            </div>
            <div className="mt-1 text-xs text-rose-600">{locale === "de" ? "Jedes Bereinigen wird hier dokumentiert. Snapshot der Einträge ist in Firestore gespeichert." : "Every clear is logged. A full snapshot of entries is stored in Firestore."}</div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {clearLogs.map((item) => (
                <div key={item.ts} className="rounded-xl bg-white px-3 py-2 ring-1 ring-rose-200">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-800">{item.week}</span>
                    <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold uppercase text-white">{item.market.toUpperCase()}</span>
                  </div>
                  <div className="mt-1 text-xs text-rose-700">{item.entryCount} {locale === "de" ? "Einträge gelöscht" : "entries cleared"}</div>
                  <div className="mt-0.5 text-[10px] text-slate-500">{new Date(item.ts).toLocaleString(locale === "de" ? "de-DE" : "en-GB")}</div>
                  <div className="mt-0.5 text-[10px] text-slate-400">{locale === "de" ? "Von:" : "By:"} {item.clearedBy}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* K: Bestätigungs-Modal Planung bereinigen */}
      {showClearConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowClearConfirm(false)}
        >
          <div
            className="w-full max-w-sm rounded-[28px] bg-white p-6 shadow-2xl ring-2 ring-rose-300"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-lg font-black text-rose-700">⚠ {locale === "de" ? "Planung wirklich bereinigen?" : "Really clear the plan?"}</div>
            <div className="mb-4 text-sm text-slate-600">
              {locale === "de"
                ? `Alle ${entries.length} Einträge für ${market.toUpperCase()} ${week} werden gelöscht. Ein vollständiger Snapshot wird in Firestore gespeichert, sodass jederzeit nachvollzogen werden kann, wer bereinigt hat.`
                : `All ${entries.length} entries for ${market.toUpperCase()} ${week} will be removed. A full snapshot is stored in Firestore so the action is always traceable.`}
            </div>
            <div className="flex gap-2">
              <button
                className="flex-1 rounded-xl border border-rose-300 bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700"
                onClick={() => { void handleClearPlan(); }}
              >
                {locale === "de" ? "Ja, bereinigen" : "Yes, clear"}
              </button>
              <button
                className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => setShowClearConfirm(false)}
              >
                {locale === "de" ? "Abbrechen" : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pre-Build-Validierungsmodal */}
      {prebuildBlocker && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setPrebuildBlocker(null)}
        >
          <div
            className="w-full max-w-lg rounded-[28px] bg-white p-6 shadow-2xl ring-1 ring-slate-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center gap-2">
              <span className="text-2xl" role="img" aria-label="Achtung">⚠️</span>
              <div className="text-sm font-black uppercase tracking-wide text-slate-800">
                {locale === "de" ? "Vorher prüfen – Probleme im Rackplan" : "Check first – Issues in rack plan"}
              </div>
            </div>
            <p className="mb-4 text-xs text-slate-500">
              {locale === "de"
                ? "Vor dem Optimieren wurden folgende Probleme erkannt. Fehler (rot) müssen behoben werden, Warnungen (gelb) sind optional."
                : "The following issues were found before optimizing. Errors (red) must be resolved; warnings (yellow) are optional."}
            </p>
            {prebuildBlocker.errors.length > 0 && (
              <div className="mb-3 rounded-2xl bg-red-50 p-3 ring-1 ring-red-200">
                <div className="mb-1 text-xs font-black uppercase tracking-wide text-red-700">{locale === "de" ? `${prebuildBlocker.errors.length} Fehler` : `${prebuildBlocker.errors.length} error${prebuildBlocker.errors.length > 1 ? "s" : ""}`}</div>
                <ul className="space-y-1">
                  {prebuildBlocker.errors.map((msg, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-red-800">
                      <span className="mt-px shrink-0 text-red-500">●</span>
                      <span>{msg}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {prebuildBlocker.warnings.length > 0 && (
              <div className="mb-4 rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-200">
                <div className="mb-1 text-xs font-black uppercase tracking-wide text-amber-700">{locale === "de" ? `${prebuildBlocker.warnings.length} Warnungen` : `${prebuildBlocker.warnings.length} warning${prebuildBlocker.warnings.length > 1 ? "s" : ""}`}</div>
                <ul className="space-y-1">
                  {prebuildBlocker.warnings.map((msg, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-xs text-amber-800">
                      <span className="mt-px shrink-0 text-amber-500">●</span>
                      <span>{msg}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex gap-2">
              <button
                className="btn btn-primary flex-1"
                onClick={_doSuggestBestPlan}
              >
                {locale === "de" ? "Trotzdem bauen" : "Build anyway"}
              </button>
              <button className="btn flex-1" onClick={() => setPrebuildBlocker(null)}>
                {locale === "de" ? "Abbrechen & prüfen" : "Cancel & review"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* J: QR-Modal */}
      {showQrModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setShowQrModal(false)}
        >
          <div
            className="w-full max-w-sm rounded-[28px] bg-white p-6 shadow-2xl ring-1 ring-slate-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-600">{locale === "de" ? "Plan teilen" : "Share plan"}</div>
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(shareUrl)}`}
              alt="QR Code"
              className="mx-auto rounded-xl"
              width={200}
              height={200}
            />
            <div className="mt-3 break-all rounded-xl bg-slate-50 p-2 text-xs text-slate-600 ring-1 ring-slate-200">{shareUrl}</div>
            <button
              className="btn btn-primary mt-3 w-full"
              onClick={() => { void navigator.clipboard.writeText(shareUrl); }}
            >
              {locale === "de" ? "URL kopieren" : "Copy URL"}
            </button>
            <button className="btn mt-2 w-full" onClick={() => setShowQrModal(false)}>
              {locale === "de" ? "Schließen" : "Close"}
            </button>
          </div>
        </div>
      )}
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

function frontColumnIndex(slotNumber: number, market: RackMarket) {
  if (slotNumber <= 5) return slotNumber;
  // Vorzone 2-Tier: Slots 6–12, Paare (6,7)→6, (8,9)→7 … (12,13)→9
  if (slotNumber <= 12) return 5 + Math.ceil((slotNumber - 5) / 2);
  // 2-Tier-Pickfächer: DE ab Slot 103 → Spalten ab 40; Nordics ab 105 → Spalten ab 41
  if (market === "de" && slotNumber >= 103) return 40 + Math.floor((slotNumber - 103) / 2);
  if (market !== "de" && slotNumber >= 105) return 41 + Math.floor((slotNumber - 105) / 2);
  // 3-Tier-Zone: Slots 13+ → Spalten 10+
  return 9 + Math.floor((slotNumber - 13) / 3) + 1;
}

function buildFrontColumns(slots: number[], slotMeta: Map<string, RackSlotMeta>, market: RackMarket) {
  const grouped = new Map<number, SlotColumn>();
  for (const slotNumber of slots) {
    const position = `F${String(slotNumber).padStart(2, "0")}`;
    const meta = slotMeta.get(position);
    const column = meta?.layoutColumn ?? frontColumnIndex(slotNumber, market);
    const tier = (meta?.level && meta.level >= 1 && meta.level <= 3
      ? meta.level
      : frontTierForSlotNumber(slotNumber, market)) as 1 | 2 | 3;
    const rows = grouped.get(column) ?? [];
    rows.push({ slotNumber, position, tier });
    grouped.set(column, rows);
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, column]) => column.sort((a, b) => a.tier - b.tier || a.slotNumber - b.slotNumber));
}

function FrontRackGrid({
  market,
  line,
  slots,
  entriesByLineAndSlot,
  slotMeta,
  locale,
  selectedFocus,
  draggedEntryId,
  highlightedEntryIds,
  hoveredSlotKey,
  onHoverSlot,
  onDropToSlot,
  onSelectSlot,
  onSelectEntry,
  onPillDragStart,
  onPillDragEnd,
  disabledPickfaceIds,
  enabledZuschaltbarPickfaceIds,
  closedPickfaceIdsByWorkers,
  onTogglePickfaceDisabled,
  onToggleZuschaltbarPickface,
}: {
  market: RackMarket;
  line: string;
  slots: number[];
  entriesByLineAndSlot: Map<string, RackEntry[]>;
  slotMeta: Map<string, RackSlotMeta>;
  locale: UiLocale;
  selectedFocus: SelectedRackFocus | null;
  draggedEntryId: string | null;
  highlightedEntryIds: Set<string>;
  hoveredSlotKey: string | null;
  onHoverSlot: (slotKey: string | null) => void;
  onDropToSlot: (line: string, flowRackPosition: string, event?: React.DragEvent) => void;
  onSelectSlot: (line: string, position: string) => void;
  onSelectEntry: (entryId: string, line: string, position: string) => void;
  onPillDragStart: (entryId: string) => void;
  onPillDragEnd: () => void;
  disabledPickfaceIds: Set<string>;
  enabledZuschaltbarPickfaceIds: Set<string>;
  closedPickfaceIdsByWorkers: Set<string>;
  onTogglePickfaceDisabled: (id: string) => void;
  onToggleZuschaltbarPickface: (id: string) => void;
}) {
  const columns = buildFrontColumns(slots, slotMeta, market);
  const headers = blueprintHeaderSegments(market, locale);
  const totalColumnCount = Math.max(columns.length, 1);

  return (
    <div className="overflow-x-auto pb-2">
      <div className="min-w-max space-y-3">
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200">
          <div className="text-center text-sm font-black tracking-wide text-slate-800">{headers.title}</div>
        </div>

        <div className="rounded-2xl border border-slate-300 bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-3 ring-1 ring-slate-200">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Linie von links nach rechts" : "Line from left to right"}</div>
            <div className="flex flex-wrap items-center gap-3">
              {/* Legende für Zuschaltbar-Pickfaces – nur wenn Markt solche hat */}
              {pickfaceWindowsForMarket(market).some((w) => w.zuschaltbar) && (
                <div className="flex items-center gap-2 rounded-lg bg-slate-100 px-2.5 py-1 ring-1 ring-slate-200 text-[11px] font-semibold text-slate-600">
                  <span className="flex items-center gap-1">
                    <span className="inline-block rounded bg-red-100 px-1.5 py-0.5 text-red-900 ring-1 ring-red-300">🔒 Z#</span>
                    <span>{locale === "de" ? "gesperrt" : "locked"}</span>
                  </span>
                  <span className="text-slate-300">|</span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-900 ring-1 ring-emerald-300">🔓 Z#</span>
                    <span>{locale === "de" ? "freigeschaltet" : "unlocked"}</span>
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="text-slate-500">{locale === "de" ? "klicken zum Umschalten" : "click to toggle"}</span>
                </div>
              )}
              <div className="text-xs text-slate-500">{locale === "de" ? "Drag-and-drop direkt auf das gewünschte Fach" : "Drag and drop directly onto the target slot"}</div>
            </div>
          </div>

          <div className="flex items-end gap-1.5" onDragOver={(e) => e.preventDefault()}>
            {columns.map((column, index) => {
              const anchorPosition = pickColumnAnchor(column);
              const anchorMeta = anchorPosition ? slotMeta.get(anchorPosition) : undefined;
              // Pickface-Zuordnung anhand der Slot-Nummern dieser Säule.
              const columnSlotNumbers = column.map((slot) => slot.slotNumber);
              const columnMinSlot = columnSlotNumbers.length > 0 ? Math.min(...columnSlotNumbers) : 0;
              const columnPickface = findPickfaceForSlotNumber(columnMinSlot, market);
              const isPackagingSlot = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(columnMinSlot);
              const isZuschaltbarBlock1 = [13, 14, 15, 16, 17, 18].includes(columnMinSlot);
              const isZuschaltbarBlock2 = [19, 20, 21, 22, 23, 24, 25, 26, 27].includes(columnMinSlot);
              const isZuschaltbarVorzone = isZuschaltbarBlock1 || isZuschaltbarBlock2;
              const previousColumn = columns[index - 1];
              const previousMinSlot = previousColumn ? Math.min(...previousColumn.map((slot) => slot.slotNumber)) : 0;
              const previousIsZuschaltbar = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27].includes(previousMinSlot);
              const showZuschaltbarGapBefore = isZuschaltbarVorzone && !previousIsZuschaltbar && index > 0;
              const showZuschaltbarGapAfter = !isZuschaltbarVorzone && previousIsZuschaltbar && index > 0;
              // Trennlinie zwischen Block 1 und Block 2
              const previousIsBlock1 = [13, 14, 15, 16, 17, 18].includes(previousMinSlot);
              const showBlock2GapBefore = isZuschaltbarBlock2 && previousIsBlock1;
              const previousPickface = previousColumn ? findPickfaceForSlotNumber(previousMinSlot, market) : undefined;
              const showSeparator = index > 0 && columnPickface && columnPickface.id !== previousPickface?.id;
              const gapPx = showSeparator ? (columnPickface?.gapPx ?? 16) : 0;
              const isZuschaltbarSeparator = !!showSeparator && !!(columnPickface?.zuschaltbar || previousPickface?.zuschaltbar);
              const isWallSeparator = !!showSeparator && !!columnPickface?.wallBefore;
              const maxTier = columnPickface?.maxTier ?? 3;
              const tiersToRender: (1 | 2 | 3)[] = maxTier === 2 ? [2, 1] : [3, 2, 1];
              const isZuschaltbarLocked = !!columnPickface?.zuschaltbar && !enabledZuschaltbarPickfaceIds.has(columnPickface.id);
              const isPickfaceClosedByWorkers = !!columnPickface && !columnPickface.zuschaltbar && closedPickfaceIdsByWorkers.has(columnPickface.id);
              const isPickfaceDisabledByOverride = !!columnPickface && !columnPickface.zuschaltbar && disabledPickfaceIds.has(columnPickface.id);
              const isPickfaceDisabled = isZuschaltbarLocked || isPickfaceClosedByWorkers || isPickfaceDisabledByOverride;

              return (
                <React.Fragment key={`${line}-front-col-${index}`}>
                  {(showSeparator || showZuschaltbarGapBefore || showZuschaltbarGapAfter || showBlock2GapBefore) && (
                    isWallSeparator ? (
                      <div
                        aria-hidden="true"
                        className="self-stretch mx-1 rounded-sm bg-slate-700 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25)]"
                        style={{ width: "18px" }}
                        title="Physische Wand (Bereichstrennung Chilled → Mealkit)"
                      />
                    ) : (
                      <div
                        aria-hidden="true"
                        className={`self-stretch border-l-2 border-dashed ${showZuschaltbarGapBefore || showZuschaltbarGapAfter || showBlock2GapBefore || isZuschaltbarSeparator ? "border-red-400" : "border-slate-300"}`}
                        style={{ width: `${showZuschaltbarGapBefore || showZuschaltbarGapAfter || showBlock2GapBefore ? 14 : gapPx}px` }}
                      />
                    )
                  )}
                  <div className="flex w-[56px] shrink-0 flex-col gap-1" onDragOver={(e) => e.preventDefault()}>
                    {/* Packaging-Badge (Slots 1–12): nur über erster Säule */}
                    {isPackagingSlot && index === 0 && (
                      <div
                        className="mb-1 rounded-md px-1 py-0.5 text-center text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-900 ring-1 ring-amber-300"
                        title="Packaging-Vorzone · 3 Mitarbeiter · Slots 1–12"
                      >
                        3 MA
                      </div>
                    )}
                    {/* Blöcke 1+2 werden jetzt als echte zuschaltbar-Fenster über den columnPickface-Branch gerendert */}
                    {/* Picker-Badge oben über der ersten Säule eines neuen Pickfaces */}
                    {columnPickface && (showSeparator || index === 0) && (
                      columnPickface.zuschaltbar ? (
                        <button
                          type="button"
                          onClick={() => onToggleZuschaltbarPickface(columnPickface.id)}
                          className={`mb-1 w-full rounded-md px-1 py-0.5 text-center text-[9px] font-bold uppercase tracking-wider ring-1 transition ${isZuschaltbarLocked ? "bg-red-100 text-red-900 ring-red-300" : "bg-emerald-100 text-emerald-900 ring-emerald-300"}`}
                          title={isZuschaltbarLocked
                            ? `Zuschaltbarer Block ${columnPickface.blockNumber} · gesperrt · Klick zum Freischalten (Slots ${columnPickface.min}–${columnPickface.max})`
                            : `Zuschaltbarer Block ${columnPickface.blockNumber} · freigeschaltet · Klick zum Sperren (Slots ${columnPickface.min}–${columnPickface.max})`}
                        >
                          {isZuschaltbarLocked ? `🔒 Z${columnPickface.blockNumber}` : `🔓 Z${columnPickface.blockNumber}`}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onTogglePickfaceDisabled(columnPickface.id)}
                          className={`mb-1 w-full rounded-md px-1 py-0.5 text-center text-[9px] font-bold uppercase tracking-wider ring-1 transition ${isPickfaceDisabledByOverride ? "bg-red-100 text-red-900 ring-red-300" : "bg-emerald-100 text-emerald-900 ring-emerald-300"}`}
                          title={isPickfaceDisabledByOverride
                            ? `P${columnPickface.pickerNumber} · gesperrt · Klick zum Freischalten (Slots ${columnPickface.min}–${columnPickface.max})`
                            : `P${columnPickface.pickerNumber} · aktiv · Klick zum Sperren (Slots ${columnPickface.min}–${columnPickface.max})`}
                        >
                          {isPickfaceDisabledByOverride ? `🔒 P${columnPickface.pickerNumber}` : `🔓 P${columnPickface.pickerNumber}`}
                        </button>
                      )
                    )}
                    {tiersToRender.map((tier) => {
                    const slot = column.find((candidate) => candidate.tier === tier);
                    const slotKey = slot ? `${line}:${slot.position}` : `${line}:empty-${index}-${tier}`;
                    const slotEntries = slot ? (entriesByLineAndSlot.get(slotKey) ?? []) : [];
                    const effectiveSlotEntries = isPickfaceDisabled ? [] : slotEntries;
                    const isSelected = !!slot && selectedFocus?.line === line && selectedFocus.position.toUpperCase() === slot.position.toUpperCase();
                    const isHovered = !!slot && hoveredSlotKey === slotKey;
                    const isMiddle = tier === 2;

                    return (
                      <div
                        key={`${line}-front-col-${index}-tier-${tier}`}
                        className={`min-h-[82px] rounded-lg border p-1.5 ${
                          slot
                            ? isPickfaceDisabled
                              ? "border-slate-300 bg-slate-100 opacity-40"
                              : isPackagingSlot
                                ? isMiddle ? "border-amber-300 bg-amber-100" : "border-amber-200 bg-amber-50"
                                : (isZuschaltbarVorzone || columnPickface?.zuschaltbar)
                                  ? isMiddle ? "border-red-400 bg-red-100" : "border-red-300 bg-red-50"
                                  : isMiddle ? "border-emerald-300 bg-emerald-50" : "border-slate-300 bg-white"
                            : "border-dashed border-slate-200 bg-slate-50/80"
                        } ${isSelected ? "ring-2 ring-slate-900" : ""} ${isHovered ? "ring-2 ring-sky-400" : ""}`}
                        onClick={() => slot && !isPickfaceDisabled && onSelectSlot(line, slot.position)}
                        onDragOver={(event) => {
                          if (!slot) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                        }}
                        onDragLeave={() => {}}
                        onDrop={(event) => {
                          if (!slot) return;
                          event.preventDefault();
                          onDropToSlot(line, slot.position, event);
                        }}
                      >
                        <div className="mb-1 flex items-center justify-between text-[10px] font-bold text-slate-600">
                          <span>{slot ? slot.position.replace("F", "") : ""}</span>
                          <span>{locale === "de" ? `E${tier}` : `T${tier}`}</span>
                        </div>
                        <div className="space-y-1">
                          {effectiveSlotEntries.length === 0 && slot && (
                            <div
                              className="rounded-md border border-dashed border-slate-300 px-1 py-1 text-center text-[10px] text-slate-400"
                              onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; }}
                              onDrop={(event) => { event.preventDefault(); event.stopPropagation(); onDropToSlot(line, slot.position, event); }}
                            >
                              {locale === "de" ? "frei" : "free"}
                            </div>
                          )}
                          {effectiveSlotEntries.map((entry) => {
                            const kind = deriveEntryKind(entry);
                            const isDragged = draggedEntryId === entry.id;
                            return (
                              <div
                                key={entry.id}
                                role="button"
                                tabIndex={0}
                                draggable
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onSelectEntry(entry.id, line, slot?.position ?? anchorPosition ?? "");
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.stopPropagation();
                                    onSelectEntry(entry.id, line, slot?.position ?? anchorPosition ?? "");
                                  }
                                }}
                                onDragStart={(event) => { event.dataTransfer.setData("text/plain", entry.id); event.dataTransfer.effectAllowed = "move"; onPillDragStart(entry.id); }}
                                onDragEnd={onPillDragEnd}
                                title={rackEntryHoverTitle(entry, slotMeta, locale)}
                                className={`w-full truncate rounded-full border px-1.5 py-1 text-left text-[9px] font-semibold cursor-grab active:cursor-grabbing select-none ${kindTone(kind)} ${isDragged ? "opacity-60" : ""} ${highlightedEntryIds.has(entry.id) ? "ring-2 ring-amber-400 animate-pulse shadow-[0_0_0_2px_rgba(251,191,36,0.35)]" : ""}`}
                              >
                                {entry.recipe}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                </div>
                </React.Fragment>
              );
            })}
          </div>

          <div className="mt-3 space-y-2">
            <div className="mt-2 inline-flex overflow-hidden rounded-lg border border-slate-200 bg-white text-[10px] font-semibold">
              <span className="px-2 py-1 ring-1 ring-slate-200">Meal</span>
              <span className="bg-cyan-100 px-2 py-1 text-cyan-900 ring-1 ring-cyan-200">Eis</span>
              <span className="bg-emerald-100 px-2 py-1 text-emerald-900 ring-1 ring-emerald-200">Smoothie</span>
              <span className="bg-violet-100 px-2 py-1 text-violet-900 ring-1 ring-violet-200">Flyer</span>
              <span className="bg-blue-100 px-2 py-1 text-blue-900 ring-1 ring-blue-200">Gifts</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LineLaneBoard({
  market,
  line,
  slots,
  entriesByLineAndSlot,
  slotMeta,
  locale,
  selectedFocus,
  draggedEntryId,
  highlightedEntryIds,
  hoveredSlotKey,
  onHoverSlot,
  onDropToSlot,
  onSelectSlot,
  onSelectEntry,
  onPillDragStart,
  onPillDragEnd,
  disabledPickfaceIds,
  enabledZuschaltbarPickfaceIds,
  closedPickfaceIdsByWorkers,
  onTogglePickfaceDisabled,
  onToggleZuschaltbarPickface,
}: {
  market: RackMarket;
  line: string;
  slots: number[];
  entriesByLineAndSlot: Map<string, RackEntry[]>;
  slotMeta: Map<string, RackSlotMeta>;
  locale: UiLocale;
  selectedFocus: SelectedRackFocus | null;
  draggedEntryId: string | null;
  highlightedEntryIds: Set<string>;
  hoveredSlotKey: string | null;
  onHoverSlot: (slotKey: string | null) => void;
  onDropToSlot: (line: string, flowRackPosition: string, event?: React.DragEvent) => void;
  onSelectSlot: (line: string, position: string) => void;
  onSelectEntry: (entryId: string, line: string, position: string) => void;
  onPillDragStart: (entryId: string) => void;
  onPillDragEnd: () => void;
  disabledPickfaceIds: Set<string>;
  enabledZuschaltbarPickfaceIds: Set<string>;
  closedPickfaceIdsByWorkers: Set<string>;
  onTogglePickfaceDisabled: (id: string) => void;
  onToggleZuschaltbarPickface: (id: string) => void;
}) {
  const occupiedSlots = slots.filter((slotNumber) => {
    const position = `F${String(slotNumber).padStart(2, "0")}`;
    return (entriesByLineAndSlot.get(`${line}:${position}`) ?? []).length > 0;
  }).length;
  const freeSlots = Math.max(slots.length - occupiedSlots, 0);

  return (
    <div className="rounded-[24px] border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{locale === "de" ? "Linien-Reiter" : "Line tab"}</div>
          <div className="mt-1 text-sm text-slate-700">
            {locale === "de" ? `${line}: horizontaler Hallenplan wie in deiner Vorlage, mit Etagen, Gruppen und direkter Bearbeitung.` : `${line}: horizontal floor plan with grouped tiers and drag-and-drop.`}
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.14em]">
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-900 ring-1 ring-emerald-200">
              {locale === "de" ? `Frei ${freeSlots}` : `Free ${freeSlots}`}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700 ring-1 ring-slate-200">
              {locale === "de" ? `Belegt ${occupiedSlots}` : `Occupied ${occupiedSlots}`}
            </span>
            <span className="rounded-full bg-sky-100 px-2.5 py-1 text-sky-900 ring-1 ring-sky-200">
              {locale === "de" ? `Gesamt ${slots.length}` : `Total ${slots.length}`}
            </span>
          </div>
        </div>
        <span className={lineBadge(line)}>{line}</span>
      </div>

      <div className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200">
        {locale === "de"
          ? "Logik: 1-5 sind Box-Aufsteller (eine Ebene). Danach im DE-Liner-Bereich zweietagig. Ab Pick-Zone sind die Fächer in 3 Ebenen gestapelt."
          : "Each card is one column: tier 1 bottom, tier 2 middle, tier 3 top."}
      </div>

      <FrontRackGrid
        market={market}
        line={line}
        slots={slots}
        entriesByLineAndSlot={entriesByLineAndSlot}
        slotMeta={slotMeta}
        locale={locale}
        selectedFocus={selectedFocus}
        draggedEntryId={draggedEntryId}
        highlightedEntryIds={highlightedEntryIds}
        hoveredSlotKey={hoveredSlotKey}
        onHoverSlot={onHoverSlot}
        onDropToSlot={onDropToSlot}
        onSelectSlot={onSelectSlot}
        onSelectEntry={onSelectEntry}
        onPillDragStart={onPillDragStart}
        onPillDragEnd={onPillDragEnd}
        disabledPickfaceIds={disabledPickfaceIds}
        enabledZuschaltbarPickfaceIds={enabledZuschaltbarPickfaceIds}
        closedPickfaceIdsByWorkers={closedPickfaceIdsByWorkers}
        onTogglePickfaceDisabled={onTogglePickfaceDisabled}
        onToggleZuschaltbarPickface={onToggleZuschaltbarPickface}
      />
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
  highlightedEntryIds,
  hoveredSlotKey,
  onHoverSlot,
  onDropToSlot,
  onPillDragStart,
  onPillDragEnd,
  onSelectSlot,
  onSelectEntry,
  pdlIds,
  changedSlots,
  bottleneckRecipe = "",
  disabledPickfaceIds,
  enabledZuschaltbarPickfaceIds,
  closedPickfaceIdsByWorkers,
  onTogglePickfaceDisabled,
  onToggleZuschaltbarPickface,
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
  highlightedEntryIds: Set<string>;
  hoveredSlotKey: string | null;
  onHoverSlot: (slotKey: string | null) => void;
  onDropToSlot: (line: string, flowRackPosition: string, event?: React.DragEvent) => void;
  onPillDragStart: (entryId: string) => void;
  onPillDragEnd: () => void;
  onSelectSlot: (line: string, position: string) => void;
  onSelectEntry: (entryId: string, line: string, position: string) => void;
  // new props for A,B,C,D,I
  pdlIds?: Set<string>;
  changedSlots: Set<string>;
  bottleneckRecipe?: string;
  disabledPickfaceIds: Set<string>;
  enabledZuschaltbarPickfaceIds: Set<string>;
  closedPickfaceIdsByWorkers: Set<string>;
  onTogglePickfaceDisabled: (id: string) => void;
  onToggleZuschaltbarPickface: (id: string) => void;
}) {
  const accent = lineAccent(line);
  const lineEntries = entries.filter((entry) => entry.line === line);
  const slotColumns = buildSlotColumns(slots, slotMeta);
  const slotViolations = summarizeSlotViolations(lineEntries, slotMeta, highRunnerRecipes);
  const stationBands = buildColumnBands(line, slotColumns, slotMeta, entriesByLineAndSlot, highRunnerRecipes, "station", locale);
  const typeBands = buildColumnBands(line, slotColumns, slotMeta, entriesByLineAndSlot, highRunnerRecipes, "type", locale);
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
  const blueprintZones = areaZoneTemplates(market, locale);
  const roleRails = hallRoleRails(market, locale);
  const areaSegments = blueprintZones.map((zone, index) => {
    const totalColumns = Math.max(slotColumns.length, blueprintZones.length);
    const start = index === 0 ? 0 : Math.floor((index / blueprintZones.length) * totalColumns);
    const end = index === blueprintZones.length - 1 ? Math.max(totalColumns - 1, 0) : Math.max(Math.floor(((index + 1) / blueprintZones.length) * totalColumns) - 1, start);
    const columns = slotColumns.slice(start, end + 1);
    const positions = columns.flatMap((column) => column.map((slot) => slot.position));
    const occupiedColumns = columns.filter((column) => column.some((slot) => (entriesByLineAndSlot.get(`${line}:${slot.position}`) ?? []).length > 0)).length;
    const demand = positions.reduce((sum, position) => sum + (slotMeta.get(position)?.demand ?? 0), 0);
    const firstPosition = columns[0] ? pickColumnAnchor(columns[0]) : "";
    const selected = !!selectedFocus && selectedFocus.line === line && positions.includes(selectedFocus.position.toUpperCase());

    return {
      ...zone,
      columns,
      occupiedColumns,
      demand,
      firstPosition,
      selected,
    };
  });
  const focusedMeta = selectedFocus?.line === line ? slotMeta.get(selectedFocus.position.toUpperCase()) : null;

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

        <div className="mb-4 rounded-[26px] border border-slate-200/90 bg-[linear-gradient(180deg,rgba(255,252,235,0.82),rgba(255,255,255,0.98))] p-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.6)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-black uppercase tracking-[0.24em] text-slate-500">{market === "de" ? "DE" : locale === "de" ? "Nordics" : "Nordics"}</div>
              <h5 className="mt-1 text-lg font-black tracking-tight text-slate-950">
                {market === "de"
                  ? (locale === "de" ? "Hallennachbau mit P2L-Logik" : "Floor reconstruction with P2L logic")
                  : (locale === "de" ? "Hallennachbau für Dänemark / Schweden" : "Floor reconstruction for Denmark / Sweden")}
              </h5>
              <p className="mt-1 max-w-3xl text-sm text-slate-600">
                {locale === "de"
                  ? "Die Linie wird jetzt nicht nur als Rack gezeigt, sondern als interaktiver Hallenriss mit Stationsbändern, Materialzonen und klickbaren Arbeitsbereichen wie in der Vorlage."
                  : "The lane now renders as an interactive floor blueprint with station bands, material zones and clickable work areas, aligned to the source layout."}
              </p>
            </div>
            <div className="rounded-[22px] bg-white px-3 py-2 text-right shadow-sm ring-1 ring-slate-200">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Fokus" : "Focus"}</div>
              <div className="mt-1 text-base font-black text-slate-950">{selectedFocus?.line === line ? selectedFocus.position.toUpperCase() : "-"}</div>
              <div className="text-xs text-slate-500">{focusedMeta?.station || (locale === "de" ? "Noch kein Fach gewählt" : "No slot selected yet")}</div>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            <div>
              <div className="mb-2 text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Arbeitsband" : "Work band"}</div>
              <div className="flex flex-wrap gap-2">
                {typeBands.map((band) => (
                  <button
                    key={`${line}-type-${band.label}-${band.firstPosition}`}
                    type="button"
                    onClick={() => band.firstPosition && onSelectSlot(line, band.firstPosition)}
                    className={`rounded-2xl px-3 py-2 text-left text-xs font-semibold ring-1 transition hover:-translate-y-0.5 ${slotTypeTone(band.label)}`}
                  >
                    <div>{band.label}</div>
                    <div className="mt-1 text-[10px] opacity-80">{band.columnCount} {locale === "de" ? "Säulen" : "columns"}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Stationsband" : "Station band"}</div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                {stationBands.map((band) => (
                  <button
                    key={`${line}-station-${band.label}-${band.firstPosition}`}
                    type="button"
                    onClick={() => band.firstPosition && onSelectSlot(line, band.firstPosition)}
                    className="rounded-[20px] border border-slate-200 bg-white px-3 py-3 text-left shadow-sm ring-1 ring-slate-100 transition hover:-translate-y-0.5 hover:border-slate-300"
                  >
                    <div className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{band.label}</div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide">
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-800">{band.columnCount} {locale === "de" ? "Säulen" : "cols"}</span>
                      <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-900">{band.occupiedColumns} {locale === "de" ? "aktiv" : "active"}</span>
                      <span className="rounded-full bg-sky-100 px-2.5 py-1 text-sky-900">{Math.round(band.totalDemand)} {locale === "de" ? "Picks" : "picks"}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* D: Stationslast-Balken */}
          {stationLoads.length > 0 && totalStationDemand > 0 && (
            <div className="mt-4 rounded-[24px] border border-slate-200 bg-white/90 p-4 ring-1 ring-slate-200/80">
              <div className="mb-3 text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Stationslast" : "Station load"}</div>
              <div className="space-y-2">
                {stationLoads.map((station) => {
                  const pct = Math.round((station.demand / totalStationDemand) * 100);
                  const workers = (station.demand / picksPerWorker).toFixed(1);
                  return (
                    <div key={`${line}-load-${station.station}`} className="flex items-center gap-2">
                      <div className="w-28 shrink-0 truncate text-[10px] font-semibold text-slate-600">{station.station}</div>
                      <div className="relative h-5 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${pct >= 40 ? "bg-rose-400" : pct >= 25 ? "bg-amber-400" : "bg-emerald-400"}`}
                          style={{ width: `${Math.min(pct, 100)}%` }}
                        />
                        <span className="absolute inset-0 flex items-center pl-2 text-[10px] font-bold text-slate-900">{pct}% · {workers} MA</span>
                      </div>
                      <div className="w-12 text-right text-[10px] font-semibold text-slate-500">{station.demand} P</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mt-4 grid gap-3 xl:grid-cols-[140px_minmax(0,1fr)_220px]">
            <div className="rounded-[24px] border border-slate-200 bg-slate-50/90 p-3 ring-1 ring-slate-200/80">
              <div className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Linke Rollen" : "Left roles"}</div>
              <div className="mt-3 space-y-2">
                {roleRails.left.map((role) => (
                  <div key={`${line}-left-role-${role}`} className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                    {role}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[24px] border border-slate-200 bg-white/90 p-3 ring-1 ring-slate-200/80">
              <div className="grid gap-3 md:grid-cols-12">
                {areaSegments.map((zone) => (
                  <button
                    key={`${line}-area-${zone.id}`}
                    type="button"
                    onClick={() => zone.firstPosition && onSelectSlot(line, zone.firstPosition)}
                    className={`rounded-[24px] border bg-gradient-to-br p-4 text-left transition hover:-translate-y-0.5 ${zone.spanClass} ${zone.border} ${zone.shell} ${zone.selected ? "ring-2 ring-slate-900 ring-offset-2" : "ring-1 ring-white/60"}`}
                  >
                    <div className={`text-xs font-black uppercase tracking-[0.2em] ${zone.text}`}>{zone.label}</div>
                    <div className={`mt-2 text-3xl font-black tracking-tight ${zone.text}`}>{zone.columns.length}</div>
                    <div className="mt-1 text-sm font-semibold text-slate-700">{zone.subtitle}</div>
                    <div className="mt-2 text-sm text-slate-600">{zone.note}</div>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-wide">
                      <span className="rounded-full bg-white/85 px-2.5 py-1 text-slate-800 ring-1 ring-white/90">{zone.occupiedColumns} {locale === "de" ? "belegt" : "occupied"}</span>
                      <span className="rounded-full bg-white/85 px-2.5 py-1 text-slate-800 ring-1 ring-white/90">{Math.round(zone.demand)} {locale === "de" ? "Picks" : "picks"}</span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-4 rounded-[24px] border border-slate-200 bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(248,250,252,0.98))] p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Rackband in Hallenansicht" : "Rack band inside floor view"}</div>
                  <div className="text-xs text-slate-500">{locale === "de" ? "Klick auf eine Säule setzt direkt den Fokus im Detail unten." : "Clicking a column directly moves focus to the detailed stack below."}</div>
                </div>
                <div className="mt-3 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.max(6, Math.min(slotColumns.length || 6, 18))}, minmax(0, 1fr))` }}>
                  {slotColumns.map((column, columnIndex) => {
                    const middle = column.find((slot) => slot.tier === 2)?.position ?? column[0]?.position ?? "";
                    return (
                      <button
                        key={`${line}-hall-column-${columnIndex}`}
                        type="button"
                        onClick={() => middle && onSelectSlot(line, middle)}
                        className="rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-sm transition hover:-translate-y-0.5"
                      >
                        <div className="space-y-1">
                          {[...column].reverse().map((slot) => {
                            const slotEntries = entriesByLineAndSlot.get(`${line}:${slot.position}`) ?? [];
                            const occupied = slotEntries.length > 0;
                            const selected = selectedFocus?.line === line && selectedFocus.position.toUpperCase() === slot.position.toUpperCase();
                            const slotKey = `${line}:${slot.position}`;
                            // A: Farbcodierung nach Eintragstyp
                            const cellColor = occupied ? slotEntryKindColor(slotEntries) : "bg-slate-100 text-slate-500";
                            // B: PDL-Warnung (Meal-Eintrag nicht in PDL)
                            const hasPdlWarning = !!pdlIds && slotEntries.some((e) => deriveEntryKind(e) === "meal" && !pdlIds.has(e.recipe));
                            // C: Geändert seit Template
                            const hasChange = changedSlots.has(slotKey);
                            // I: Engpass-Simulation — betroffener Slot
                            const isBottleneck = !!bottleneckRecipe && slotEntries.some((e) => e.recipe.toLowerCase() === bottleneckRecipe.trim().toLowerCase());
                            return (
                              <div
                                key={`${line}-hall-cell-${slot.position}`}
                                className={`relative rounded-lg px-1 py-1 text-center text-[10px] font-bold ${isBottleneck ? "bg-rose-200 text-rose-900 ring-2 ring-rose-400" : cellColor} ${selected ? "ring-2 ring-slate-900" : ""}`}
                              >
                                {slot.position.replace("F", "")}
                                {hasPdlWarning && <span className="absolute -top-1 -right-1 size-2 rounded-full bg-amber-400 ring-1 ring-white" title="PDL-Abweichung" />}
                                {hasChange && !hasPdlWarning && <span className="absolute -bottom-1 -left-1 size-2 rounded-full bg-violet-500 ring-1 ring-white" title="Geändert" />}
                              </div>
                            );
                          })}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="rounded-[24px] border border-slate-200 bg-slate-50/90 p-3 ring-1 ring-slate-200/80">
              <div className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Rechte Rollen / MA" : "Right roles / staffing"}</div>
              <div className="mt-3 space-y-2">
                {roleRails.right.map((role) => (
                  <div key={`${line}-right-role-${role}`} className="rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                    {role}
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-[22px] border border-slate-200 bg-white px-3 py-3 ring-1 ring-slate-100">
                <div className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-500">{locale === "de" ? "Interaktives Know-how" : "Interactive know-how"}</div>
                <div className="mt-2 space-y-2 text-sm text-slate-600">
                  <div>{locale === "de" ? "Klick auf Arbeitsband, Station oder Hallenzone springt direkt ins passende Fach." : "Click a work band, station or floor zone to jump into the matching slot."}</div>
                  <div>{locale === "de" ? "Doppelklick unten bleibt der Detailmodus für Fach und Rezept." : "Double click in the rack stays the detail mode for slot and recipe."}</div>
                </div>
              </div>
            </div>
          </div>
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

        <FrontRackGrid
          market={market}
          line={line}
          slots={slots}
          entriesByLineAndSlot={entriesByLineAndSlot}
          slotMeta={slotMeta}
          locale={locale}
          selectedFocus={selectedFocus}
          draggedEntryId={draggedEntryId}
          highlightedEntryIds={highlightedEntryIds}
          hoveredSlotKey={hoveredSlotKey}
          onHoverSlot={onHoverSlot}
          onDropToSlot={onDropToSlot}
          onSelectSlot={onSelectSlot}
          onSelectEntry={onSelectEntry}
          onPillDragStart={onPillDragStart}
          onPillDragEnd={onPillDragEnd}
          disabledPickfaceIds={disabledPickfaceIds}
          enabledZuschaltbarPickfaceIds={enabledZuschaltbarPickfaceIds}
          closedPickfaceIdsByWorkers={closedPickfaceIdsByWorkers}
          onTogglePickfaceDisabled={onTogglePickfaceDisabled}
          onToggleZuschaltbarPickface={onToggleZuschaltbarPickface}
        />
      </div>
    </div>
  );
}

function hallLayoutPickstationWorkers(market: RackMarket) {
  // Referenz aus dem Hallenbild oben (Picker-Zuteilung inkl. PS/Waage-Kontext je Markt)
  if (market === "de") return 11;
  return 8;
}

function estimateTotalDemandPicks(entries: RackEntry[], slotMeta: Map<string, RackSlotMeta>) {
  return entries.reduce(
    (sum, entry) => sum + Math.max(0, slotMeta.get(entry.flowRackPosition.toUpperCase())?.demand ?? entry.quantity ?? 0),
    0,
  );
}

function picksPerWorkerForHallReference(entries: RackEntry[], slotMeta: Map<string, RackSlotMeta>, market: RackMarket, fallback = 120) {
  const totalDemand = estimateTotalDemandPicks(entries, slotMeta);
  const targetWorkers = hallLayoutPickstationWorkers(market);
  if (totalDemand <= 0 || targetWorkers <= 0) return fallback;
  return Math.max(1, Math.round(totalDemand / targetWorkers));
}