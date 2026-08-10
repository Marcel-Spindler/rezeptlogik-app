import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import type { DataBundle, ProcessSpec, WorkOrderEntry } from "./core/types";

type RundmailRow = {
  id: string;
  dateNeeded: string;
  workOrderNumber: string;
  recipeId: string;
  recipeName: string;
  subRecipeName: string;
  minimumNeeds: number;
  cookMethods: string;
  woCookedPortions: number;
  targetPortions: number;
  cookedExcess: number;
  stagingStatus: string;
  stagingComment: string;
  kitchenStatus: string;
  unlockedEta: string;
  workOrderComment: string;
  kitchenKg?: number | null;
  batchSizeKg?: number | null;
  batchesNeeded?: number | null;
};

type BatchHint = {
  capacityKg: number;
};

type StatusFilter = "all" | "Not Started" | "Pre Blast" | "Post Blast";

type DeficitItem = {
  row: RundmailRow;
  deficit: number;
};

type PetRow = {
  id: string;
  type: string;
  productionShift: string;
  totalTarget: number;
  totalMapped: number;
  recipeWo: string;
  recipeName: string;
  recipeWoMapped: number;
  recipeWoTarget: number;
  recipePlatingStatus: string;
  recipeManualPlatingStatus: string;
  totalWeekUnlockedVolume: number;
  totalWeekMapped: number;
  productionMinNeeds: number;
  expiringDatetime: string;
  expiringSubRecipeName: string;
  expiringPortions: number;
  expiringLicensePlate: string;
  comment: string;
  rolloverAmount: number;
  actualBestByDate: string;
  bestBySubRecipeName: string;
};

type PlatingNote = {
  instruction: string;
  packSchemaImageDataUrl?: string;
};

const PLATING_NOTES_KEY = "rezeptlogik-plating-notes-v1";

function loadPlatingNotes(): Record<string, PlatingNote> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PLATING_NOTES_KEY) : null;
    return raw ? (JSON.parse(raw) as Record<string, PlatingNote>) : {};
  } catch {
    return {};
  }
}

function savePlatingNotes(notes: Record<string, PlatingNote>): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(PLATING_NOTES_KEY, JSON.stringify(notes));
  } catch { /* quota exceeded – silent */ }
}

function parseDateNeeded(value: string): { date: string; run: number } {
  const [rawDate, rawRun] = (value ?? "").split(" - ");
  return {
    date: (rawDate ?? "").trim(),
    run: Number(rawRun ?? "0") || 0,
  };
}

function isRun1(value: string): boolean {
  return parseDateNeeded(value).run === 1;
}

function toNumber(raw: string): number {
  const normalized = (raw ?? "").toString().trim().replace(/,/g, "");
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseSeedCsv(csvText: string): RundmailRow[] {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const rows: RundmailRow[] = [];
  parsed.data.forEach((raw, idx) => {
    const wo = (raw["Work Order Number"] ?? "").trim();
    const dateNeeded = (raw["Date Needed"] ?? "").trim();
    if (!wo || !dateNeeded) return;

    rows.push({
      id: `${wo}-${idx}`,
      dateNeeded,
      workOrderNumber: wo,
      recipeId: (raw["Recipe ID"] ?? "").trim(),
      recipeName: (raw["Recipe Name"] ?? "").trim(),
      subRecipeName: (raw["Sub Recipe Name"] ?? "").trim(),
      minimumNeeds: toNumber(raw["Production Minimum Needs Amount"] ?? ""),
      cookMethods: (raw["Cook Methods"] ?? "").trim(),
      woCookedPortions: toNumber(raw["WO Cooked Portions"] ?? ""),
      targetPortions: toNumber(raw["Target Portions"] ?? ""),
      cookedExcess: toNumber(raw["Cooked Portions Excess"] ?? ""),
      stagingStatus: (raw["Staging Status"] ?? "").trim(),
      stagingComment: (raw["Staging Comment"] ?? "").trim(),
      kitchenStatus: (raw["Kitchen Status"] ?? "").trim(),
      unlockedEta: (raw["Unlocked ETA"] ?? "").trim(),
      workOrderComment: (raw["Work Order Comment"] ?? "").trim(),
    });
  });

  return rows;
}

function parsePetCsv(csvText: string): PetRow[] {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const rows: PetRow[] = [];
  parsed.data.forEach((raw, idx) => {
    const productionShift = (raw["Production Shift"] ?? "").trim();
    const recipeWo = (raw["Recipe WO #"] ?? "").trim();
    const recipeName = (raw["Recipe Name"] ?? "").trim();
    if (!productionShift || !recipeWo || !recipeName) return;

    rows.push({
      id: `${recipeWo}-${idx}`,
      type: (raw["Type"] ?? "").trim(),
      productionShift,
      totalTarget: toNumber(raw["Total Target"] ?? ""),
      totalMapped: toNumber(raw["Total Mapped"] ?? ""),
      recipeWo,
      recipeName,
      recipeWoMapped: toNumber(raw["Recipe WO Mapped"] ?? ""),
      recipeWoTarget: toNumber(raw["Recipe WO Target"] ?? ""),
      recipePlatingStatus: (raw["Recipe Plating Status"] ?? "").trim(),
      recipeManualPlatingStatus: (raw["Recipe Manual Plating Status"] ?? "").trim(),
      totalWeekUnlockedVolume: toNumber(raw["Total Week Unlocked Volume"] ?? ""),
      totalWeekMapped: toNumber(raw["Total Week Mapped"] ?? ""),
      productionMinNeeds: toNumber(raw["Production Min Needs"] ?? ""),
      expiringDatetime: (raw["Expiring Datetime"] ?? "").trim(),
      expiringSubRecipeName: (raw["Expiring SubRecipe Name"] ?? "").trim(),
      expiringPortions: toNumber(raw["Expiring Portions"] ?? ""),
      expiringLicensePlate: (raw["Expiring License Plate #"] ?? "").trim(),
      comment: (raw["Comment"] ?? "").trim(),
      rolloverAmount: toNumber(raw["Rollover Amount"] ?? ""),
      actualBestByDate: (raw["Actual Best By Date"] ?? "").trim(),
      bestBySubRecipeName: (raw["Best By SubRecipe Name"] ?? "").trim(),
    });
  });

  return rows;
}

function detectCsvType(csvText: string): "ket" | "pet" | "unknown" {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    preview: 3,
  });
  const first = parsed.data?.[0] ?? {};
  const keys = new Set(Object.keys(first));
  if (keys.has("Date Needed") && keys.has("Work Order Number")) return "ket";
  if (keys.has("Production Shift") && keys.has("Recipe WO #")) return "pet";
  return "unknown";
}

function parseBestByTimestamp(value: string): number | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  const iso = Date.parse(raw);
  if (Number.isFinite(iso)) return iso;

  const m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (!day || !month || !year) return null;
  const ts = Date.UTC(year, month - 1, day);
  return Number.isFinite(ts) ? ts : null;
}

function daySortValue(day: string): number {
  const [rawDate, rawSlot] = day.split(" - ");
  const ts = Date.parse(`${rawDate}T00:00:00Z`);
  const slot = Number(rawSlot ?? "0") || 0;
  return ts * 10 + slot;
}

function fmtInt(value: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value);
}

function toSlack(value: number): number {
  return value >= 0 ? value : 0;
}

function escapeHtml(value: string): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeText(value: string): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value).split(" ").filter((token) => token.length > 1);
}

function overlapScore(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function parseFloatSafe(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function toCells(rowValues: unknown): string[] {
  if (!Array.isArray(rowValues)) return [];
  return rowValues.map((cell) => String(cell ?? "").trim());
}

function detectHeaderRow(rows: string[][], expected: RegExp[]): number {
  let bestIndex = -1;
  let bestScore = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const nonEmpty = row.filter((cell) => cell.length > 0).length;
    if (nonEmpty < 2) continue;
    const text = row.join(" | ").toLowerCase();
    const hitScore = expected.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
    const score = hitScore * 10 + nonEmpty;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function findHeaderIndex(headers: string[], candidates: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i].toLowerCase();
    if (candidates.some((regex) => regex.test(header))) return i;
  }
  return -1;
}

function parseBibleBatchHints(master: unknown, bibles: unknown): Map<string, BatchHint> {
  const map = new Map<string, BatchHint>();

  const consider = (subRecipeName: string, capacityKg: number | null): void => {
    if (!subRecipeName || !capacityKg || capacityKg <= 0) return;
    const key = normalizeText(subRecipeName);
    if (!key) return;
    if (!map.has(key)) map.set(key, { capacityKg });
  };

  const collectFromRows = (rows: string[][]): void => {
    if (!rows.length) return;
    const headerIdx = detectHeaderRow(rows.slice(0, 40), [/sub\s*recipe/i, /kg|batch|capacit/i]);
    if (headerIdx < 0) return;
    const headers = rows[headerIdx] ?? [];
    const nameIdx = findHeaderIndex(headers, [/sub\s*recipe/i, /component/i, /name/i]);
    const capacityIdx = findHeaderIndex(headers, [/batch\s*breakdown.*kg/i, /capacity/i, /max.*kg/i, /kg/i]);
    if (nameIdx < 0 || capacityIdx < 0) return;
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const cells = rows[i] ?? [];
      const name = cells[nameIdx] ?? "";
      const capacityKg = parseFloatSafe(cells[capacityIdx]);
      consider(name, capacityKg);
    }
  };

  const masterSheets = Array.isArray((master as { sheets?: unknown[] })?.sheets)
    ? ((master as { sheets: Array<{ values?: unknown[] }> }).sheets)
    : [];
  for (const sheet of masterSheets) {
    const rawRows = Array.isArray(sheet?.values) ? sheet.values : [];
    const rows = rawRows.map(toCells).filter((row) => row.some((cell) => cell.length > 0));
    collectFromRows(rows);
  }

  const bibleSheets = Array.isArray((bibles as { sheets?: unknown[] })?.sheets)
    ? ((bibles as { sheets: Array<{ values?: unknown[] }> }).sheets)
    : [];
  for (const sheet of bibleSheets) {
    const rawRows = Array.isArray(sheet?.values) ? sheet.values : [];
    const rows = rawRows.map(toCells).filter((row) => row.some((cell) => cell.length > 0));
    collectFromRows(rows);
  }

  return map;
}

function resolveBatchSizeKg(
  subRecipeName: string,
  processSpecsByName: Map<string, ProcessSpec>,
  bibleHints: Map<string, BatchHint>,
): number | null {
  const normalized = normalizeText(subRecipeName);
  if (!normalized) return null;

  const exactSpec = processSpecsByName.get(normalized);
  if (exactSpec?.batchSizeKg && exactSpec.batchSizeKg > 0) return exactSpec.batchSizeKg;

  let bestSpec: ProcessSpec | null = null;
  let bestScore = 0;
  for (const [key, spec] of processSpecsByName.entries()) {
    if (!spec.batchSizeKg || spec.batchSizeKg <= 0) continue;
    const score = overlapScore(normalized, key);
    if (score > bestScore) {
      bestScore = score;
      bestSpec = spec;
    }
  }
  if (bestSpec && bestSpec.batchSizeKg && bestScore >= 0.6) return bestSpec.batchSizeKg;

  const bibleHint = bibleHints.get(normalized);
  return bibleHint?.capacityKg ?? null;
}

function resolveKitchenKgForRow(
  row: RundmailRow,
  productionByWorkOrder: Map<string, WorkOrderEntry[]>,
): number | null {
  const candidates = productionByWorkOrder.get(row.workOrderNumber) ?? [];
  if (!candidates.length) return null;

  const rowSub = normalizeText(row.subRecipeName);
  if (!rowSub) return null;

  const exact = candidates.find((candidate) => normalizeText(candidate.subRecipe) === rowSub);
  if (exact && exact.kitchenKg > 0) return exact.kitchenKg;

  let best: WorkOrderEntry | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = overlapScore(rowSub, candidate.subRecipe);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best && best.kitchenKg > 0 && bestScore >= 0.5) return best.kitchenKg;

  return null;
}

// ── Weekly Planning (from Google Drive via import:weekly-planning) ──────────

type BoxDay = {
  dayLabel: string;
  boxes: number;
  meals: number;
};

type TeamDay = {
  dayLabel: string;
  date: string;
  platingLinesEarly: number;
  platingLinesLate: number;
  platingHeadcountEarly: number;
  platingHeadcountLate: number;
  kitchenHeadcountEarly: number;
  kitchenHeadcountLate: number;
  allStaffEarly: number;
  allStaffLate: number;
  areas: Record<string, { early: number; late: number }>;
};

type WeeklyPlanningData = {
  cw: number;
  year: number;
  isReference: boolean;
  referenceNote: string;
  spreadsheetName: string;
  generatedAt: string;
  boxesPerLinePerShift: number;
  boxSchedule: BoxDay[];
  teamByDay: TeamDay[];
};

const DAY_LABEL_TO_WEEKDAY: Record<string, string> = {
  Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday",
};

// ── Allergen Detection ───────────────────────────────────────────────────────

type AllergenDef = {
  label: string;
  bg: string;
  text: string;
  border: string;
  keywords: string[];
};

const ALLERGEN_DEFS: AllergenDef[] = [
  { label: "Fisch", bg: "#dbeafe", text: "#1e40af", border: "#93c5fd", keywords: ["salmon", "lachs", "fish", "fisch", "tuna"] },
  { label: "Milch/Laktose", bg: "#e0f2fe", text: "#0c4a6e", border: "#7dd3fc", keywords: ["butter", "cream", "cheese", "käse", "kase", "parmesan", "mozzarella", "mascarpone", "cheddar", "gratin"] },
  { label: "Eier", bg: "#fef9c3", text: "#713f12", border: "#fde047", keywords: ["egg", " ei "] },
  { label: "Gluten", bg: "#fef3c7", text: "#92400e", border: "#fcd34d", keywords: ["burger", "meatball", "breadcrumb"] },
  { label: "Senf", bg: "#f0fdf4", text: "#14532d", border: "#86efac", keywords: ["mustard", "ranch", "senf"] },
  { label: "Sellerie", bg: "#dcfce7", text: "#166534", border: "#6ee7b7", keywords: ["celery", "sellerie"] },
  { label: "Sesam", bg: "#fdf4ff", text: "#581c87", border: "#d8b4fe", keywords: ["sesame", "sesam"] },
  { label: "Soja", bg: "#fff1f2", text: "#881337", border: "#fda4af", keywords: ["soy", "soja", "tofu"] },
];

function detectAllergens(texts: string[]): AllergenDef[] {
  const combined = texts.join(" ").toLowerCase();
  return ALLERGEN_DEFS.filter(({ keywords }) => keywords.some((kw) => combined.includes(kw)));
}

function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("not started")) return "bg-rose-100 text-rose-700 ring-rose-200";
  if (normalized.includes("pre blast"))   return "bg-amber-100 text-amber-800 ring-amber-200";
  if (normalized.includes("post blast"))  return "bg-emerald-100 text-emerald-700 ring-emerald-200";
  if (normalized.includes("open"))        return "bg-orange-100 text-orange-700 ring-orange-200";
  if (normalized.includes("picking"))     return "bg-sky-100 text-sky-700 ring-sky-200";
  if (normalized.includes("staged"))      return "bg-violet-100 text-violet-700 ring-violet-200";
  if (normalized.includes("allocation"))  return "bg-pink-100 text-pink-700 ring-pink-200";
  return "bg-slate-200 text-slate-700 ring-slate-300";
}

function petStatusTone(status: string): { bg: string; text: string; border: string } {
  const normalized = status.toLowerCase();
  if (normalized.includes("in progress")) return { bg: "#fef3c7", text: "#92400e", border: "#fcd34d" };
  if (normalized.includes("not started")) return { bg: "#fee2e2", text: "#991b1b", border: "#fca5a5" };
  if (normalized.includes("done") || normalized.includes("complete")) return { bg: "#dcfce7", text: "#166534", border: "#86efac" };
  return { bg: "#e2e8f0", text: "#334155", border: "#cbd5e1" };
}

const PET_PORTIONS_PER_LINE_PER_SHIFT = 1000;
const PET_LINE_START_HOUR = 7;

function formatClock(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  const hh = Math.floor(safe / 60).toString().padStart(2, "0");
  const mm = (safe % 60).toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function extractMealCode(recipeName: string): string {
  const match = recipeName.match(/(FV\d{4}[A-Z])/i);
  if (match) return match[1].toUpperCase();
  return recipeName.split(/\s+/).slice(0, 1).join("");
}

function oneDayBefore(isoDate: string): string {
  const ts = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(ts)) return isoDate;
  return new Date(ts - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function buildPetHtmlMail(allPetRows: PetRow[], sourceLabel: string, targetRun: 1 | 2, platingNotes?: Record<string, PlatingNote>): string {
  type EnrichedPetRow = PetRow & {
    status: string;
    bestByText: string;
    bestByTs: number | null;
    open: number;
    ratio: number;
    allergens: AllergenDef[];
  };

  const runRows: EnrichedPetRow[] = allPetRows
    .filter((row) => parseDateNeeded(row.productionShift).run === targetRun)
    .map((row) => {
      const status = row.recipeManualPlatingStatus || row.recipePlatingStatus || "Not Started";
      const bestByText = row.actualBestByDate || row.expiringDatetime || "";
      const bestByTs = parseBestByTimestamp(bestByText);
      const open = toSlack(row.recipeWoTarget - row.recipeWoMapped);
      const ratio = row.recipeWoTarget > 0
        ? Math.max(0, Math.min(100, Math.round((row.recipeWoMapped / row.recipeWoTarget) * 100)))
        : 0;
      const allergens = detectAllergens([
        row.recipeName,
        row.bestBySubRecipeName,
        row.expiringSubRecipeName,
        row.comment,
      ]);
      return {
        ...row,
        status,
        bestByText,
        bestByTs,
        open,
        ratio,
        allergens,
      };
    });

  const shifts = Array.from(new Set(runRows.map((row) => row.productionShift)))
    .sort((a, b) => daySortValue(a) - daySortValue(b));
  const runLabel = `Run ${targetRun}`;
  const nowTs = Date.now();
  const soonLimit = nowTs + 48 * 60 * 60 * 1000;

  const totalTarget = runRows.reduce((sum, row) => sum + row.recipeWoTarget, 0);
  const totalMapped = runRows.reduce((sum, row) => sum + row.recipeWoMapped, 0);
  const totalOpen = runRows.reduce((sum, row) => sum + row.open, 0);
  const completion = totalTarget > 0 ? Math.max(0, Math.min(100, Math.round((totalMapped / totalTarget) * 100))) : 0;
  const doneCount = runRows.filter((row) => row.status.toLowerCase().includes("done") || row.status.toLowerCase().includes("complete")).length;
  const inProgress = runRows.filter((row) => row.status.toLowerCase().includes("in progress")).length;
  const notStarted = runRows.filter((row) => row.status.toLowerCase().includes("not started")).length;
  const urgentBestBy = runRows.filter((row) => row.bestByTs != null && row.bestByTs <= soonLimit).length;
  const globalAllergens = new Set(runRows.flatMap((row) => row.allergens.map((a) => a.label)));
  const generatedAt = new Date().toLocaleString("de-DE");
  const firstShiftDate = shifts.length ? parseDateNeeded(shifts[0]).date : "-";
  const totalSingleLineHours = totalTarget / PET_PORTIONS_PER_LINE_PER_SHIFT;

  const shiftLineNeeds = shifts.map((shift) => {
    const shiftTarget = runRows
      .filter((row) => row.productionShift === shift)
      .reduce((sum, row) => sum + row.recipeWoTarget, 0);
    return shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
  });
  const peakLinesNeeded = shiftLineNeeds.length ? Math.max(...shiftLineNeeds) : 0;
  const peakStaffNeeded = shifts.length
    ? Math.max(...shifts.map((shift) => {
      const shiftRows = runRows.filter((row) => row.productionShift === shift).length;
      const shiftTarget = runRows
        .filter((row) => row.productionShift === shift)
        .reduce((sum, row) => sum + row.recipeWoTarget, 0);
      const neededLines = shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
      const lineCount = neededLines > 2 ? 3 : 2;
      return shiftRows + lineCount;
    }))
    : 0;

  function allergenSignature(row: EnrichedPetRow): string {
    return row.allergens.map((a) => a.label).sort().join("|") || "none";
  }

  function linePlacementScore(
    lineRows: EnrichedPetRow[],
    allLineTargets: number[],
    lineIndex: number,
    candidate: EnrichedPetRow
  ): number {
    const last = lineRows.at(-1);
    const currentSig = last ? allergenSignature(last) : "";
    const nextSig = allergenSignature(candidate);
    const allergenSwitchPenalty = last && currentSig !== nextSig ? 3 : 0;

    const projectedTargets = allLineTargets.map((value, idx) =>
      idx === lineIndex ? value + candidate.recipeWoTarget : value
    );
    const projectedTarget = projectedTargets[lineIndex];
    const projectedGap = Math.max(...projectedTargets) - Math.min(...projectedTargets);
    const balancePenalty = projectedGap / PET_PORTIONS_PER_LINE_PER_SHIFT;

    const overflow = Math.max(0, projectedTarget - PET_PORTIONS_PER_LINE_PER_SHIFT);
    const overflowPenalty = (overflow / PET_PORTIONS_PER_LINE_PER_SHIFT) * 2;

    return allergenSwitchPenalty + balancePenalty + overflowPenalty;
  }

  function renderAllergenBadges(row: EnrichedPetRow): string {
    return row.allergens.map((a) =>
      `<span style="display:inline-block;background:${a.bg};color:${a.text};border:1px solid ${a.border};border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;margin:1px 2px;">${escapeHtml(a.label)}</span>`
    ).join("") || `<span style="font-size:10px;color:#94a3b8;">–</span>`;
  }

  function renderLineWithCleaning(lineRows: EnrichedPetRow[], color: string): { html: string; cleaningCount: number; totalMinutes: number } {
    let cleaningCount = 0;
    let cursorMinutes = PET_LINE_START_HOUR * 60;
    const html = lineRows.map((row, idx) => {
      const open = row.open;
      const tone = petStatusTone(row.status);
      const bestByUrgent = row.bestByTs != null && row.bestByTs <= soonLimit;
      const bestBy = row.bestByText || "-";
      const bestByName = row.bestBySubRecipeName || row.expiringSubRecipeName || "-";
      const mealCode = extractMealCode(row.recipeName);
      const mealTitle = row.recipeName.replace(/\s*\[.*?\]/g, "").replace(/^FV\d{4}[A-Z]\s*-\s*/i, "").trim();
      const durationHours = row.recipeWoTarget / PET_PORTIONS_PER_LINE_PER_SHIFT;
      const durationMinutes = Math.max(10, Math.round(durationHours * 60));
      const timeStart = cursorMinutes;
      const timeEnd = cursorMinutes + durationMinutes;
      cursorMinutes = timeEnd;
      const note = platingNotes?.[mealCode];
      const noteHtml = note?.instruction
        ? `<div style="margin-top:5px;padding:5px 8px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:0 4px 4px 0;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#166534;"><strong>Plating:</strong> ${escapeHtml(note.instruction)}</div>`
        : "";
      const imageHtml = note?.packSchemaImageDataUrl
        ? `<div style="margin-top:5px;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:2px;">Packschema</div><img src="${note.packSchemaImageDataUrl}" alt="Packschema ${escapeHtml(mealCode)}" style="max-width:100%;max-height:110px;object-fit:contain;border:1px solid #e2e8f0;border-radius:4px;"></div>`
        : "";
      const card = `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-left:3px solid ${color};border-radius:0 8px 8px 0;background:#ffffff;margin-bottom:6px;">
        <tr>
          <td width="84" style="padding:8px 6px 8px 8px;border-right:1px dashed #e2e8f0;vertical-align:top;background:#f8fafc;">
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;color:#0f172a;text-align:center;">${formatClock(timeStart)}</div>
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-align:center;">bis ${formatClock(timeEnd)}</div>
            <div style="margin-top:4px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:700;color:#0369a1;text-align:center;">${durationHours.toFixed(1)} h</div>
          </td>
          <td style="padding:8px 10px;vertical-align:top;">
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:800;color:#0f172a;">${escapeHtml(mealCode)} &middot; ${escapeHtml(mealTitle || row.recipeName)}</div>
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#475569;margin-top:3px;">WO ${escapeHtml(row.recipeWo)} &middot; SOLL ${fmtInt(row.recipeWoTarget)} &middot; IST ${fmtInt(row.recipeWoMapped)} &middot; Gap <strong style="color:${open > 0 ? "#92400e" : "#166534"};">${fmtInt(open)}</strong> &middot; Fill ${row.ratio}%</div>
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;margin-top:3px;">Best By: <span style="color:${bestByUrgent ? "#991b1b" : "#334155"};font-weight:${bestByUrgent ? "800" : "600"};">${bestByUrgent ? "⚠ " : ""}${escapeHtml(bestBy)}</span> &middot; Sub: ${escapeHtml(bestByName)}</div>
            <div style="margin-top:4px;">${renderAllergenBadges(row)}</div>
            <div style="margin-top:4px;"><span style="display:inline-block;background:${tone.bg};color:${tone.text};border:1px solid ${tone.border};border-radius:999px;padding:2px 8px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;white-space:nowrap;">${escapeHtml(row.status)}</span></div>
            ${noteHtml}${imageHtml}
          </td>
        </tr>
      </table>`;

      if (idx >= lineRows.length - 1) return card;

      const cur = new Set(row.allergens.map((a) => a.label));
      const nxt = new Set(lineRows[idx + 1].allergens.map((a) => a.label));
      const removed = [...cur].filter((label) => !nxt.has(label));
      const added = [...nxt].filter((label) => !cur.has(label));
      const hasChange = removed.length > 0 || added.length > 0;
      if (!hasChange) return card;

      cleaningCount += 1;
      const changeText = [
        removed.length ? `entfernt: <strong>${removed.join(", ")}</strong>` : "",
        added.length ? `neu: <strong>${added.join(", ")}</strong>` : "",
      ].filter(Boolean).join(" &middot; ");

      return card + `<div style="margin:3px 0 7px 0;padding:6px 10px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:6px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#78350f;font-weight:700;">⚠ LINIE REINIGEN &mdash; Allergen-Wechsel: ${changeText}</div>`;
    }).join("");

    return { html, cleaningCount, totalMinutes: Math.max(0, cursorMinutes - PET_LINE_START_HOUR * 60) };
  }

  const shiftTables = shifts.map((shift) => {
    const rows = runRows
      .filter((row) => row.productionShift === shift)
      .sort((a, b) => {
        if (a.bestByTs != null && b.bestByTs != null && a.bestByTs !== b.bestByTs) return a.bestByTs - b.bestByTs;
        if (a.bestByTs != null && b.bestByTs == null) return -1;
        if (a.bestByTs == null && b.bestByTs != null) return 1;
        return b.open - a.open;
      });

    const shiftTarget = rows.reduce((sum, row) => sum + row.recipeWoTarget, 0);
    const shiftMapped = rows.reduce((sum, row) => sum + row.recipeWoMapped, 0);
    const shiftOpen = rows.reduce((sum, row) => sum + row.open, 0);
    const shiftLinesNeeded = shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
    const lineCount = shiftLinesNeeded > 2 ? 3 : 2;
    const lines: EnrichedPetRow[][] = Array.from({ length: lineCount }, () => []);
    const lineTargets = Array.from({ length: lineCount }, () => 0);

    for (const row of rows) {
      let bestLine = 0;
      let bestScore = Number.POSITIVE_INFINITY;
      for (let idx = 0; idx < lineCount; idx += 1) {
        const score = linePlacementScore(lines[idx], lineTargets, idx, row);
        const tieBreaker = lineTargets[idx] / PET_PORTIONS_PER_LINE_PER_SHIFT;
        const weightedScore = score + tieBreaker * 0.001;
        if (weightedScore < bestScore) {
          bestScore = weightedScore;
          bestLine = idx;
        }
      }
      lines[bestLine].push(row);
      lineTargets[bestLine] += row.recipeWoTarget;
    }
    const shiftStaffNeeded = rows.length + lineCount;
    const shiftAllergenSet = new Set(rows.flatMap((row) => row.allergens.map((a) => a.label)));
    const shiftUrgent = rows.filter((row) => row.bestByTs != null && row.bestByTs <= soonLimit).length;
    const shiftUtil = shiftLinesNeeded > 0
      ? Math.min(100, Math.round((shiftTarget / (shiftLinesNeeded * PET_PORTIONS_PER_LINE_PER_SHIFT)) * 100))
      : 0;

    const lineColors = ["#0ea5e9", "#10b981", "#f59e0b"];
    const renderedLines = lines.map((lineRows, idx) => ({
      rendered: renderLineWithCleaning(lineRows, lineColors[idx]),
      staffNeeded: lineRows.length + 1,
      target: lineTargets[idx],
    }));
    const cleaningTotal = renderedLines.reduce((sum, item) => sum + item.rendered.cleaningCount, 0);
    const parallelHours = renderedLines.length
      ? Math.max(...renderedLines.map((item) => item.rendered.totalMinutes)) / 60
      : 0;
    const avgLineHours = lineCount > 0 ? shiftTarget / (lineCount * PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
    const completedOn = oneDayBefore(parseDateNeeded(shift).date);
    const lineWidth = `${(100 / lineCount).toFixed(2)}%`;
    const lineColumns = renderedLines.map((item, idx) => `
                <td width="${lineWidth}" style="vertical-align:top;${idx < lineCount - 1 ? "padding-right:8px;border-right:1px solid #e2e8f0;" : "padding-left:8px;"}">
                  <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;color:${lineColors[idx]};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:2px;">Linie ${idx + 1} &mdash; ${fmtInt(item.target)} Portionen &mdash; ${(item.rendered.totalMinutes / 60).toFixed(1)} h &mdash; ~${fmtInt(item.staffNeeded)} MA</div>
                  <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;margin-bottom:6px;">Start ${formatClock(PET_LINE_START_HOUR * 60)} &middot; Ende ${formatClock(PET_LINE_START_HOUR * 60 + item.rendered.totalMinutes)}</div>
                  ${item.rendered.html || `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#94a3b8;">–</div>`}
                  <div style="margin-top:6px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;">Linie ${idx + 1} Auslastung</div>
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:2px;"><tr><td width="${Math.max(0, Math.min(100, Math.round((item.target / PET_PORTIONS_PER_LINE_PER_SHIFT) * 100)))}%" style="height:5px;background:#10b981;border-radius:4px;"></td><td style="height:5px;background:#e2e8f0;"></td></tr></table>
                </td>`).join("");

    return `
    <tr><td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#ffffff;">
        <tr><td style="background:#1e293b;padding:10px 12px;">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;font-weight:900;color:#f8fafc;">Plating ab ${escapeHtml(parseDateNeeded(shift).date)} &mdash; ${runLabel}</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#fde68a;margin-top:3px;">Fertigstellung: ${escapeHtml(completedOn)} &middot; ${rows.length} Rezepte &middot; ${fmtInt(shiftTarget)} Portionen &middot; ~${fmtInt(shiftStaffNeeded)} MA empfohlen (${lineCount} Linien)</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;margin-top:3px;">Meal-WOs: ${rows.length} &middot; SOLL ${fmtInt(shiftTarget)} &middot; IST ${fmtInt(shiftMapped)} &middot; Gap ${fmtInt(shiftOpen)} &middot; Auslastung ${shiftUtil}% &middot; Parallel ${parallelHours.toFixed(1)} h statt ${avgLineHours.toFixed(1)} h / Linie</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#c7d2fe;margin-top:3px;">Linien n&ouml;tig: <strong style="color:#ffffff;">${shiftLinesNeeded}</strong> (${fmtInt(PET_PORTIONS_PER_LINE_PER_SHIFT)} Meals/Linie) &middot; Geplante Linien: <strong style="color:#ffffff;">${lineCount}</strong> (2 Standard, optional 3) &middot; MA-Bedarf Shift: <strong style="color:#ffffff;">${shiftStaffNeeded}</strong> (Submeals + 1 je Linie) &middot; Kritische Best-By: <strong style="color:${shiftUrgent > 0 ? "#fca5a5" : "#86efac"};">${shiftUrgent}</strong></div>
          ${shiftAllergenSet.size ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#e2e8f0;margin-top:3px;">Allergene im Shift: ${Array.from(shiftAllergenSet).join(", ")}</div>` : ""}
          <div style="margin-top:8px;padding:8px 10px;background:#fef3c7;border:1px solid #d97706;border-radius:8px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#78350f;font-weight:700;">⚠ ALLERGEN-SICHERHEIT: Bei jedem Meal-Wechsel mit anderen Allergenen Linie vollst&auml;ndig reinigen. Gleiche Allergene wurden geb&uuml;ndelt, um Wechsel zu minimieren.</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${cleaningTotal > 0 ? "#fcd34d" : "#86efac"};margin-top:3px;">${cleaningTotal > 0 ? `⚠ ${cleaningTotal} Reinigungswechsel eingeplant` : "✓ Keine Reinigungswechsel erforderlich"}</div>
        </td></tr>
        <tr>
          <td style="padding:10px 12px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              <tr>
                ${lineColumns}
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td></tr>`;
  }).join("");

  return `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>PET-Plating Plan ${runLabel}</title>
<style>@media print{body{background:#fff!important;padding:0!important}table{page-break-inside:avoid}@page{size:A4 landscape;margin:8mm}}</style>
</head>
<body style="margin:0;padding:16px;background:#cbd5e1;font-family:Segoe UI,Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:980px;margin:0 auto;">
  <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#0369a1 100%);border-radius:16px 16px 0 0;padding:28px 28px 22px 28px;">
    <div style="font-size:10px;letter-spacing:0.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:8px;">Factor OPS &middot; Verden &middot; PET</div>
    <div style="font-size:30px;font-weight:900;color:#ffffff;line-height:1.05;letter-spacing:-0.02em;">Plating ab ${escapeHtml(firstShiftDate)} &mdash; ${runLabel}</div>
    <div style="font-size:15px;color:#bae6fd;margin-top:6px;">${fmtInt(runRows.length)} Rezepte &middot; ${fmtInt(totalTarget)} Portionen &middot; Parallel ~${(totalSingleLineHours / Math.max(1, peakLinesNeeded || 2)).toFixed(1)} h ab ${formatClock(PET_LINE_START_HOUR * 60)}</div>
    <div style="margin-top:14px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.2);font-size:11px;color:#cbd5e1;">Erstellt: ${escapeHtml(generatedAt)} &nbsp;&middot;&nbsp; Quelle: ${escapeHtml(sourceLabel)}</div>
  </td></tr>

  <tr><td style="background:#ffffff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Meal-WOs</div><div style="font-size:26px;font-weight:900;color:#0f172a;">${runRows.length}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">SOLL</div><div style="font-size:26px;font-weight:900;color:#0f172a;">${fmtInt(totalTarget)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">IST</div><div style="font-size:26px;font-weight:900;color:#0369a1;">${fmtInt(totalMapped)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Gap</div><div style="font-size:26px;font-weight:900;color:${totalOpen > 0 ? "#92400e" : "#166534"};">${fmtInt(totalOpen)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Done</div><div style="font-size:26px;font-weight:900;color:#166534;">${fmtInt(doneCount)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">In Progress</div><div style="font-size:26px;font-weight:900;color:#92400e;">${fmtInt(inProgress)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Not Started</div><div style="font-size:26px;font-weight:900;color:#991b1b;">${fmtInt(notStarted)}</div></td>
        <td style="padding:14px 16px;text-align:center;border-right:1px solid #e2e8f0;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Best-By &lt;48h</div><div style="font-size:26px;font-weight:900;color:${urgentBestBy > 0 ? "#b91c1c" : "#166534"};">${fmtInt(urgentBestBy)}</div></td>
        <td style="padding:14px 16px;text-align:center;"><div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">Peak Linien / MA</div><div style="font-size:20px;font-weight:900;color:#0f172a;">${fmtInt(peakLinesNeeded)} / ${fmtInt(peakStaffNeeded)}</div></td>
      </tr>
    </table>
    <div style="padding:0;"><table width="100%" cellspacing="0" cellpadding="0"><tr><td width="${completion}%" style="height:5px;background:linear-gradient(90deg,#0ea5e9,#10b981);"></td>${completion < 100 ? `<td style="height:5px;background:#e2e8f0;"></td>` : ""}</tr></table></div>
    <div style="padding:8px 16px 10px 16px;border-top:1px solid #e2e8f0;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;">Priorisierung: 1) fr&uuml;hestes Best By, 2) h&ouml;chster Gap &middot; Kapazit&auml;t je Linie: ${fmtInt(PET_PORTIONS_PER_LINE_PER_SHIFT)} Meals &middot; MA-Formel: Submeals + 1 &middot; Reinigungswechsel zwischen allergen-kritischen Meals automatisch markiert</div>
    ${globalAllergens.size ? `<div style="padding:0 16px 10px 16px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#334155;">Allergene (Run gesamt): <strong>${Array.from(globalAllergens).join(", ")}</strong></div>` : ""}
  </td></tr>

  <tr><td style="background:#ffffff;padding:18px 24px 8px 24px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;border-top:2px solid #e2e8f0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:14px;"><tr><td style="border-left:4px solid #0ea5e9;padding-left:10px;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;font-weight:800;color:#0f172a;text-transform:uppercase;letter-spacing:0.1em;">PET Plating Linienplan</div><div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#64748b;margin-top:2px;">Wie im KET-Plating: Linien, Allergene, Reinigungen, MA</div></td></tr></table>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${shiftTables || `<tr><td style="padding:16px 12px;border:1px dashed #cbd5e1;border-radius:10px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:#64748b;">Keine PET-Daten f&uuml;r ${runLabel} gefunden.</td></tr>`}</table>
  </td></tr>

  <tr><td style="background:#f1f5f9;border-radius:0 0 16px 16px;padding:16px 24px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="font-size:11px;color:#64748b;"><strong style="color:#0f172a;">Factor OPS Planner</strong> &middot; PET Plating Report</td><td align="right" style="font-size:10px;color:#94a3b8;white-space:nowrap;">${escapeHtml(sourceLabel)}</td></tr></table>
  </td></tr>
</table>
</body>
</html>`;
}

function buildRun1Mail(run1Rows: RundmailRow[]): string {
  const run1Days = Array.from(new Set(run1Rows.map((row) => row.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));
  const totalTarget = run1Rows.reduce((sum, row) => sum + row.targetPortions, 0);
  const totalCooked = run1Rows.reduce((sum, row) => sum + row.woCookedPortions, 0);
  const totalOpen = run1Rows.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);
  const totalBatches = run1Rows.reduce((sum, row) => sum + (row.batchesNeeded ?? 0), 0);

  const lines: string[] = [];
  lines.push("# RUN1 Rundmail Produktion");
  lines.push("");
  lines.push("## Executive Summary");
  lines.push(`- RUN1 Work Orders: ${run1Rows.length}`);
  lines.push(`- RUN1 Ziel gesamt: ${fmtInt(totalTarget)}`);
  lines.push(`- RUN1 Gekocht gesamt: ${fmtInt(totalCooked)}`);
  lines.push(`- RUN1 Offener Bedarf: ${fmtInt(totalOpen)}`);
  lines.push(`- RUN1 Batches gesamt: ${fmtInt(totalBatches)}`);
  lines.push("");

  run1Days.forEach((day) => {
    const rows = run1Rows.filter((row) => row.dateNeeded === day);
    const target = rows.reduce((sum, row) => sum + row.targetPortions, 0);
    const cooked = rows.reduce((sum, row) => sum + row.woCookedPortions, 0);
    const open = rows.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);
    const dayBatches = rows.reduce((sum, row) => sum + (row.batchesNeeded ?? 0), 0);

    const critical = rows
      .map((row) => ({ row, deficit: toSlack(row.targetPortions - row.woCookedPortions) }))
      .filter((item) => item.deficit > 0)
      .sort((a, b) => b.deficit - a.deficit)
      .slice(0, 5);

    const blocked = rows.filter((row) => {
      const status = row.kitchenStatus.toLowerCase();
      return status.includes("not started") || status.includes("open") || status.includes("allocation");
    });

    lines.push(`## ${day}`);
    lines.push(`- Work Orders: ${rows.length}`);
    lines.push(`- Ziel: ${fmtInt(target)} | Gekocht: ${fmtInt(cooked)} | Offen: ${fmtInt(open)}`);
    lines.push(`- Batches: ${fmtInt(dayBatches)}`);
    lines.push(`- Blocked/Open Positionen: ${blocked.length}`);

    if (critical.length) {
      lines.push("- Kritische Defizite:");
      critical.forEach(({ row, deficit }) => {
        const hint = row.workOrderComment ? ` | Hinweis: ${row.workOrderComment}` : "";
        const batchesText = row.batchesNeeded != null ? ` | Batches ${fmtInt(row.batchesNeeded)}` : "";
        lines.push(`  - WO ${row.workOrderNumber} | ${row.subRecipeName} | Fehlmenge ${fmtInt(deficit)}${batchesText}${hint}`);
      });
    } else {
      lines.push("- Kritische Defizite: keine");
    }

    lines.push("");
  });

  lines.push(`_${new Date().toLocaleString("de-DE")}_`);

  return lines.join("\n");
}

// ── Colour palette (shared across sections) ──────────────────────────────────
const C = {
  navy: "#0f172a", navyMid: "#1e293b", navyLight: "#334155",
  sky: "#0ea5e9", skyDark: "#0369a1",
  emerald: "#10b981", emeraldDark: "#166534", emeraldBg: "#f0fdf4",
  amber: "#f59e0b", amberDark: "#92400e", amberBg: "#fffbeb",
  red: "#ef4444", redDark: "#991b1b", redBg: "#fef2f2",
  slate: "#64748b", slateLight: "#94a3b8", slateBg: "#f8fafc",
  border: "#e2e8f0", white: "#ffffff",
};

function buildRunHtmlMail(allRows: RundmailRow[], sourceLabel: string, weeklyPlanning: WeeklyPlanningData | null | undefined, targetRun: 1 | 2, toolLinks: { whatIf: string; breakdown: string } = { whatIf: "", breakdown: "" }): string {
  const isTargetRun = (dateNeeded: string) => parseDateNeeded(dateNeeded).run === targetRun;
  const targetRunRows = allRows.filter((row) => isTargetRun(row.dateNeeded));
  // Küchen-Plan nur für diesen Run; alle Tage/Runs für den kompletten Plan-Kontext
  const allDays = Array.from(new Set(allRows.filter(r => isTargetRun(r.dateNeeded)).map((row) => row.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));

  const timelineCards = allDays.map(day => {
    const dayRows = allRows.filter(r => r.dateNeeded === day);
    const seen = new Map<string, RundmailRow>();
    dayRows.forEach(row => {
      const prev = seen.get(row.recipeId);
      if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
    });
    const deduped = Array.from(seen.values());
    const target = deduped.reduce((s, r) => s + r.targetPortions, 0);
    const cooked = deduped.reduce((s, r) => s + r.woCookedPortions, 0);
    const open = deduped.reduce((s, r) => s + toSlack(r.targetPortions - r.woCookedPortions), 0);
    return { day, count: dayRows.length, target, cooked, open };
  });

  // Deduplizierung: Portionen nur einmal pro Rezept zählen
  const dedupedRun = Array.from(
    new Map(targetRunRows.map(r => [r.recipeId, r])).values()
  );
  const totalTarget = dedupedRun.reduce((sum, row) => sum + row.targetPortions, 0);
  const totalCooked = dedupedRun.reduce((sum, row) => sum + row.woCookedPortions, 0);
  const totalOpen = dedupedRun.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);
  const totalBatches = targetRunRows.reduce((sum, row) => sum + (row.batchesNeeded ?? 0), 0);
  const completion = totalTarget > 0 ? Math.max(0, Math.min(100, Math.round((totalCooked / totalTarget) * 100))) : 0;
  const generatedAt = new Date().toLocaleString("de-DE");
  const runLabel = `Run ${targetRun}`;

  const WHAT_IF_URL = toolLinks.whatIf || "#";
  const BREAKDOWN_URL = toolLinks.breakdown || "#";

  // Section A: Küchen-Plan (all days/runs)
  const kitchenPlanHtml = allDays.map((day) => {
    const dayRows = allRows.filter((row) => row.dateNeeded === day);
    const { date, run } = parseDateNeeded(day);

    // Deduplizierung: Target nur einmal pro Rezept zählen
    const recipeMap = new Map<string, { rows: typeof dayRows; target: number; allergens: ReturnType<typeof detectAllergens> }>();
    dayRows.forEach((row) => {
      const existing = recipeMap.get(row.recipeId);
      if (existing) {
        existing.rows.push(row);
      } else {
        recipeMap.set(row.recipeId, {
          rows: [row],
          target: row.targetPortions,
          allergens: detectAllergens([row.recipeName, row.subRecipeName]),
        });
      }
    });
    // Allergene über alle Sub-Rezepte eines Rezepts sammeln
    recipeMap.forEach((entry, id) => {
      entry.allergens = detectAllergens([entry.rows[0].recipeName, ...entry.rows.map(r => r.subRecipeName)]);
      recipeMap.set(id, entry);
    });

    const dayTarget = Array.from(recipeMap.values()).reduce((s, e) => s + e.target, 0);
    const dayBatches = dayRows.reduce((sum, row) => sum + (row.batchesNeeded ?? 0), 0);
    const uniqueRecipeCount = recipeMap.size;
    const totalSubCount = dayRows.length;

    const recipeSections = Array.from(recipeMap.values()).map((recipe, ri) => {
      const firstRow = recipe.rows[0];
      const allergenBadges = recipe.allergens.map(a =>
        `<span style="display:inline-block;background:${a.bg};color:${a.text};border:1px solid ${a.border};border-radius:3px;padding:1px 5px;font-size:10px;font-weight:700;margin:1px 2px;">${escapeHtml(a.label)}</span>`
      ).join("") || `<span style="font-size:10px;color:#94a3b8;">keine bekannten Allergene</span>`;
      const hasFish = recipe.allergens.some(a => a.label === "Fisch");
      const recipeHeaderBg = ri % 2 === 0 ? "#f8fafc" : "#f1f5f9";

      const subRows = recipe.rows.map((row) => `
        <tr>
          <td style="padding:5px 8px 5px 20px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#334155;white-space:nowrap;">WO&nbsp;${escapeHtml(row.workOrderNumber)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#0f172a;">${escapeHtml(row.subRecipeName)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#334155;text-align:right;white-space:nowrap;">${fmtInt(row.targetPortions)}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#334155;text-align:right;white-space:nowrap;">${row.kitchenKg != null ? fmtInt(row.kitchenKg) : "–"}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#4338ca;font-weight:700;text-align:right;white-space:nowrap;">${row.batchesNeeded != null ? fmtInt(row.batchesNeeded) : "–"}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#64748b;">${escapeHtml(row.cookMethods || "–")}</td>
          <td style="padding:5px 8px;border-bottom:1px solid #f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:${row.kitchenStatus?.toLowerCase().includes("not started") ? "#991b1b" : row.kitchenStatus?.toLowerCase().includes("post blast") ? "#166534" : "#334155"};white-space:nowrap;">${escapeHtml(row.kitchenStatus || "–")}</td>
        </tr>`).join("");

      return `
        <tr style="background:${recipeHeaderBg};">
          <td colspan="7" style="padding:7px 10px 5px 10px;border-top:1px solid #e2e8f0;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
              <td>
                <span style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:800;color:#0f172a;">${escapeHtml(firstRow.recipeName.replace(/\s*\[.*?\]/g, ""))}</span>
                <span style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;margin-left:8px;">${escapeHtml(firstRow.recipeId)} &middot; ${fmtInt(recipe.target)} Portionen &middot; ${recipe.rows.length} Sub-Rezepte &middot; <strong style="color:#0f172a;">${recipe.rows.length + 1} MA</strong></span>
                ${hasFish ? `<span style="color:#dc2626;font-weight:800;margin-left:4px;">&#9888;</span>` : ""}
              </td>
              <td align="right" style="white-space:nowrap;">${allergenBadges}</td>
            </tr></table>
          </td>
        </tr>
        ${subRows}`;
    }).join("");

    return `
    <tr><td style="padding:0 0 14px 0;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#ffffff;">
        <tr><td style="background:#1e293b;padding:8px 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
            <td>
              <span style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:#ffffff;">${escapeHtml(date)} &mdash; Run&nbsp;${run}</span>
              <span style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#94a3b8;margin-left:12px;">${uniqueRecipeCount} Rezepte &middot; ${totalSubCount} WOs &middot; ${fmtInt(dayTarget)} Portionen &middot; ${fmtInt(dayBatches)} Batches &middot; <strong style="color:#fbbf24;">${totalSubCount + 1} MA</strong></span>
            </td>
          </tr></table>
        </td></tr>
        <tr><td>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">WO</th>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Sub-Rezept</th>
              <th align="right" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Target</th>
              <th align="right" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Kitchen kg</th>
              <th align="right" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#4338ca;text-transform:uppercase;letter-spacing:0.08em;">Batches</th>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Cook-Methoden</th>
              <th align="left" style="padding:5px 8px;background:#f8fafc;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Status</th>
            </tr>
            ${recipeSections}
          </table>
        </td></tr>
      </table>
    </td></tr>`;
  }).join("");

  // Section C: Kapazitäts- & Personalplan (aus Weekly Planning Sheet)
  const capacityHtml = weeklyPlanning ? (() => {
    const bpls2 = weeklyPlanning.boxesPerLinePerShift;
    const refNote = weeklyPlanning.referenceNote || `KW${weeklyPlanning.cw}`;
    const boxSched = weeklyPlanning.boxSchedule;
    const teamByDay = weeklyPlanning.teamByDay;

    const rows = boxSched.map((bd) => {
      const fullDay = DAY_LABEL_TO_WEEKDAY[bd.dayLabel] ?? "";
      const team = teamByDay.find((t) => t.dayLabel === fullDay);

      const linesEarly = team?.platingLinesEarly ?? 0;
      const linesLate = team?.platingLinesLate ?? 0;
      const totalLines = linesEarly + linesLate;
      const maxCap = totalLines * bpls2;
      const phEarly = team?.platingHeadcountEarly ?? 0;
      const phLate = team?.platingHeadcountLate ?? 0;
      const kEarly = team?.kitchenHeadcountEarly ?? 0;
      const kLate = team?.kitchenHeadcountLate ?? 0;
      const allEarly = team?.allStaffEarly ?? 0;
      const allLate = team?.allStaffLate ?? 0;

      const isOk = bd.boxes === 0 || maxCap >= bd.boxes;
      const isTight = !isOk && maxCap > 0 && maxCap >= bd.boxes * 0.75;

      // Area breakdown for tooltip-like details
      const areaDetails = team
        ? Object.entries(team.areas)
            .filter(([, v]) => v.early > 0 || v.late > 0)
            .map(([k, v]) => {
              const parts: string[] = [];
              if (v.early > 0) parts.push(`${v.early} früh`);
              if (v.late > 0) parts.push(`${v.late} spät`);
              return `${k}: ${parts.join("/")}`;
            })
            .join(" &middot; ")
        : "";

      const utilPct = maxCap > 0 && bd.boxes > 0 ? Math.min(100, Math.round((bd.boxes / maxCap) * 100)) : 0;
      const accentColor = bd.boxes === 0 ? "#94a3b8" : isOk ? "#10b981" : isTight ? "#f59e0b" : "#ef4444";
      const statusBadgeBg = bd.boxes === 0 ? "#f1f5f9" : isOk ? "#dcfce7" : isTight ? "#fef3c7" : "#fee2e2";
      const statusBadgeText = bd.boxes === 0 ? "#64748b" : isOk ? "#166534" : isTight ? "#92400e" : "#991b1b";
      const statusEmoji = bd.boxes === 0 ? "–" : isOk ? "✓ OK" : isTight ? "⚠ Eng" : "✗ Kritisch";
      const rowBg = bd.boxes === 0 ? C.white : isOk ? "#f0fdf4" : isTight ? "#fffbeb" : "#fef2f2";

      return `
      <tr style="background:${rowBg};border-left:3px solid ${accentColor};">
        <td style="padding:9px 12px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:800;color:${C.navy};white-space:nowrap;border-left:3px solid ${accentColor};">${escapeHtml(bd.dayLabel)}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:700;color:${C.navy};text-align:right;">${bd.boxes ? fmtInt(bd.boxes) : "<span style='color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:${C.slate};text-align:right;">${bd.meals ? fmtInt(bd.meals) : "<span style='color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};text-align:center;">
          ${linesEarly > 0 || linesLate > 0 ? `
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:#0369a1;background:#dbeafe;border-radius:4px;padding:2px 6px;">${linesEarly}F</span>
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#94a3b8;margin:0 2px;">/</span>
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:#6d28d9;background:#ede9fe;border-radius:4px;padding:2px 6px;">${linesLate}S</span>
          ` : `<span style="color:#cbd5e1">–</span>`}
        </td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:600;color:#0369a1;text-align:right;">${phEarly + phLate > 0 ? (phEarly + phLate).toFixed(0) : "<span style='color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:600;color:${C.emeraldDark};text-align:right;">${kEarly + kLate > 0 ? (kEarly + kLate).toFixed(0) : "<span style='color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:900;color:${C.navy};text-align:right;">${allEarly + allLate > 0 ? (allEarly + allLate).toFixed(0) : "<span style='font-weight:400;color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};font-family:Segoe UI,Arial,sans-serif;font-size:12px;color:${C.emeraldDark};font-weight:600;text-align:right;">${maxCap ? fmtInt(maxCap) : "<span style='color:#cbd5e1'>–</span>"}</td>
        <td style="padding:9px 10px;border-bottom:1px solid ${C.border};text-align:center;min-width:80px;">
          ${utilPct > 0 ? `
          <div style="background:#e2e8f0;border-radius:99px;height:6px;overflow:hidden;margin:0 4px 3px 4px;">
            <div style="background:${accentColor};height:6px;width:${utilPct}%;border-radius:99px;"></div>
          </div>
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:700;color:${accentColor};">${utilPct}%</span>
          ` : `<span style="color:#cbd5e1;font-family:Segoe UI,Arial,sans-serif;font-size:11px;">–</span>`}
        </td>
        <td style="padding:9px 12px;border-bottom:1px solid ${C.border};text-align:center;">
          <span style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;color:${statusBadgeText};background:${statusBadgeBg};border-radius:99px;padding:3px 10px;white-space:nowrap;">${statusEmoji}</span>
        </td>
      </tr>
      ${areaDetails ? `<tr style="background:#f8fafc;"><td colspan="10" style="padding:3px 12px 7px 15px;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#64748b;border-bottom:1px solid ${C.border};border-left:3px solid ${accentColor};">${areaDetails}</td></tr>` : ""}`;
    }).join("");

    // KPI-Zusammenfassung
    const totalBoxes = boxSched.reduce((s, b) => s + b.boxes, 0);
    const peakDay = boxSched.reduce((best, b) => b.boxes > best.boxes ? b : best, boxSched[0] ?? { dayLabel: "–", boxes: 0, meals: 0 });
    const totalMA = teamByDay.reduce((s, t) => s + t.allStaffEarly + t.allStaffLate, 0);

    return `
    <tr><td style="padding:20px 24px 8px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
      ${sectionHeader("Kapazit&auml;ts- &amp; Personalplan", `Referenz ${escapeHtml(refNote)} &middot; ${fmtInt(bpls2)}&thinsp;Boxen/Linie/Schicht &middot; 1&thinsp;Linie&thinsp;=&thinsp;1.000 Boxen/h`, C.emerald)}

      <!-- KPI-Band -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:14px;">
        <tr>
          <td width="25%" style="padding:0 6px 0 0;">
            <div style="background:linear-gradient(135deg,#0f172a,#1e293b);border-radius:10px;padding:12px 14px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:4px;">Boxen gesamt</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:22px;font-weight:900;color:#ffffff;line-height:1;">${fmtInt(totalBoxes)}</div>
            </div>
          </td>
          <td width="25%" style="padding:0 6px;">
            <div style="background:linear-gradient(135deg,#0c4a6e,#0369a1);border-radius:10px;padding:12px 14px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#bae6fd;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:4px;">Peak-Tag</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:18px;font-weight:900;color:#ffffff;line-height:1;">${escapeHtml(peakDay.dayLabel)}</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#7dd3fc;margin-top:2px;">${fmtInt(peakDay.boxes)} Boxen</div>
            </div>
          </td>
          <td width="25%" style="padding:0 6px;">
            <div style="background:linear-gradient(135deg,#064e3b,#065f46);border-radius:10px;padding:12px 14px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#6ee7b7;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:4px;">Ø MA / Tag</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:22px;font-weight:900;color:#ffffff;line-height:1;">${teamByDay.length > 0 ? Math.round(totalMA / teamByDay.length) : "–"}</div>
            </div>
          </td>
          <td width="25%" style="padding:0 0 0 6px;">
            <div style="background:linear-gradient(135deg,#1e3a5f,#0f172a);border-radius:10px;padding:12px 14px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#c7d2fe;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:4px;">Mahlzeiten</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:22px;font-weight:900;color:#ffffff;line-height:1;">${fmtInt(boxSched.reduce((s, b) => s + b.meals, 0))}</div>
            </div>
          </td>
        </tr>
      </table>

      <!-- Haupttabelle -->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${C.border};border-radius:12px;overflow:hidden;">
        <tr>
          <th align="left"   style="padding:8px 12px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.1em;white-space:nowrap;">Tag</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.1em;">Boxen</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#7dd3fc;text-transform:uppercase;letter-spacing:0.1em;">Mahlzeiten</th>
          <th align="center" style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#7dd3fc;text-transform:uppercase;letter-spacing:0.1em;">Linien&nbsp;F/S</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.1em;">Plating-MA</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#6ee7b7;text-transform:uppercase;letter-spacing:0.1em;">Küchen-MA</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#ffffff;text-transform:uppercase;letter-spacing:0.1em;font-weight:900;">Ges.-MA</th>
          <th align="right"  style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#6ee7b7;text-transform:uppercase;letter-spacing:0.1em;">Max&nbsp;Kap.</th>
          <th align="center" style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.1em;">Auslastung</th>
          <th align="center" style="padding:8px 12px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#f8fafc;text-transform:uppercase;letter-spacing:0.1em;">Status</th>
        </tr>
        ${rows}
      </table>
      <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slateLight};margin-top:6px;">F = Fr&uuml;hschicht &middot; S = Sp&auml;tschicht &middot; MA = Mitarbeiter (FTE)</div>
    </td></tr>`;
  })() : "";

  // ── Extra KPIs from weekly planning ─────────────────────────────────────────
  const uniqueRecipes   = new Set(allRows.map(r => r.recipeId)).size;
  const totalSubRecipes = allRows.length;
  const totalKetPortions = dedupedRun.reduce((s, r) => s + r.targetPortions, 0);
  const maxDayStaff     = weeklyPlanning ? Math.max(...weeklyPlanning.teamByDay.map(d => d.allStaffEarly + d.allStaffLate), 0) : 0;
  const bpls = weeklyPlanning?.boxesPerLinePerShift ?? 6608;
  const refLabel = weeklyPlanning
    ? `${weeklyPlanning.isReference ? "Referenz " : ""}KW${weeklyPlanning.cw}`
    : "kein Wochenplan";

  // ── Section helpers ───────────────────────────────────────────────────────────
  function sectionHeader(title: string, sub: string, accentColor = C.navy) {
    return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:14px;">
      <tr>
        <td style="border-left:4px solid ${accentColor};padding-left:10px;">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;font-weight:800;color:${C.navy};text-transform:uppercase;letter-spacing:0.1em;">${title}</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:${C.slate};margin-top:2px;">${sub}</div>
        </td>
      </tr>
    </table>`;
  }

  function kpiCell(label: string, value: string, color: string, sub = "") {
    return `<td style="padding:14px 16px;text-align:center;border-right:1px solid ${C.border};">
      <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slate};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">${label}</div>
      <div style="font-family:Segoe UI,Arial,sans-serif;font-size:26px;font-weight:900;color:${color};line-height:1;">${value}</div>
      ${sub ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slateLight};margin-top:3px;">${sub}</div>` : ""}
    </td>`;
  }

  function capBar(used: number, max: number, height = 6) {
    if (max <= 0) return `<table width="100%" cellspacing="0" cellpadding="0"><tr><td style="height:${height}px;background:#e2e8f0;border-radius:3px;"></td></tr></table>`;
    const pct = Math.min(100, Math.round(used / max * 100));
    const barColor = pct <= 75 ? C.emerald : pct <= 100 ? C.amber : C.red;
    return `<table width="100%" cellspacing="0" cellpadding="0" style="border-radius:3px;overflow:hidden;"><tr>
      <td width="${pct}%" style="height:${height}px;background:${barColor};"></td>
      ${pct < 100 ? `<td style="height:${height}px;background:#e2e8f0;"></td>` : ""}
    </tr></table>`;
  }

  // ── SECTION: Wochenkalender ───────────────────────────────────────────────────
  const calendarCols = (weeklyPlanning?.boxSchedule ?? []).map((bd) => {
    const fullDay = DAY_LABEL_TO_WEEKDAY[bd.dayLabel] ?? "";
    const team = weeklyPlanning?.teamByDay.find((t) => t.dayLabel === fullDay);
    const linesEarly = team?.platingLinesEarly ?? 0;
    const linesLate = team?.platingLinesLate ?? 0;
    const lines = linesEarly + linesLate;
    const maxCap = lines * bpls;
    const pct = maxCap > 0 ? Math.min(100, Math.round(bd.boxes / maxCap * 100)) : 0;
    const totalStaff = (team?.allStaffEarly ?? 0) + (team?.allStaffLate ?? 0);
    const platingStaff = (team?.platingHeadcountEarly ?? 0) + (team?.platingHeadcountLate ?? 0);
    const kitchenStaff = (team?.kitchenHeadcountEarly ?? 0) + (team?.kitchenHeadcountLate ?? 0);
    const hasKet = allRows.some(r => {
      const { date } = parseDateNeeded(r.dateNeeded);
      const d = new Date(date + "T00:00:00Z");
      return ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].indexOf(bd.dayLabel.substring(0,3)) ===
             ((d.getUTCDay() + 6) % 7);
    });
    const isOk = bd.boxes === 0 || maxCap >= bd.boxes;
    const isTight = !isOk && maxCap > 0 && maxCap >= bd.boxes * 0.85;
    const cellBg = bd.boxes === 0 ? C.slateBg : isOk ? "#f0fdf4" : isTight ? "#fffbeb" : "#fef2f2";
    const borderColor = bd.boxes === 0 ? C.border : isOk ? "#86efac" : isTight ? "#fcd34d" : "#fca5a5";
    const statusLabel = bd.boxes === 0 ? "kein Versand" : isOk ? "&#10003; OK" : isTight ? "&#9888; Eng" : "&#10007; Kritisch";
    const statusColor = bd.boxes === 0 ? C.slateLight : isOk ? C.emeraldDark : isTight ? C.amberDark : C.redDark;
    const pctColor = pct <= 75 ? C.emeraldDark : pct <= 95 ? "#92400e" : C.redDark;
    return `<td style="padding:0 3px;vertical-align:top;width:12.5%;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:2px solid ${borderColor};border-radius:10px;overflow:hidden;background:${cellBg};">
        <!-- Day label -->
        <tr><td style="background:${bd.boxes === 0 ? C.slateBg : isOk ? "#dcfce7" : isTight ? "#fef3c7" : "#fee2e2"};padding:5px 8px;text-align:center;border-bottom:1px solid ${borderColor};">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:900;color:${C.navy};">${escapeHtml(bd.dayLabel)}</div>
          ${team?.date ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.slate};">${escapeHtml(team.date)}</div>` : ""}
        </td></tr>
        <!-- Boxes + Meals -->
        <tr><td style="padding:8px 8px 4px 8px;text-align:center;">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:22px;font-weight:900;color:${bd.boxes > 0 ? C.navy : C.slateLight};line-height:1;">${bd.boxes > 0 ? fmtInt(bd.boxes) : "–"}</div>
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.slate};">Boxen</div>
          ${bd.meals > 0 ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:${C.skyDark};margin-top:2px;">${fmtInt(bd.meals)} Mahlzeiten</div>` : ""}
        </td></tr>
        <!-- Capacity bar -->
        <tr><td style="padding:4px 8px;">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${pctColor};font-weight:700;text-align:center;margin-bottom:2px;">${maxCap > 0 ? pct + "%" : "–"}</div>
          ${capBar(bd.boxes, maxCap, 7)}
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.slate};text-align:center;margin-top:2px;">${maxCap > 0 ? `Kap. ${fmtInt(maxCap)}` : "keine Kap."}</div>
        </td></tr>
        <!-- Lines -->
        <tr><td style="padding:4px 8px;border-top:1px solid ${C.border};">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.skyDark};text-align:center;">
            ${lines > 0 ? `${lines} Linie${lines > 1 ? "n" : ""} (${linesEarly}F/${linesLate}S)` : "kein Plating"}
          </div>
        </td></tr>
        <!-- Staff -->
        ${totalStaff > 0 ? `<tr><td style="padding:3px 8px 4px 8px;background:rgba(0,0,0,0.03);border-top:1px solid ${C.border};">
          <table width="100%" cellspacing="0" cellpadding="0"><tr>
            <td style="text-align:center;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;color:${C.navy};">${totalStaff.toFixed(0)}</div><div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:${C.slateLight};">Ges.</div></td>
            <td style="text-align:center;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:700;color:${C.skyDark};">${platingStaff > 0 ? platingStaff.toFixed(1) : "–"}</div><div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:${C.slateLight};">Plating</div></td>
            <td style="text-align:center;"><div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:700;color:${C.emeraldDark};">${kitchenStaff > 0 ? kitchenStaff.toFixed(1) : "–"}</div><div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:${C.slateLight};">Küche</div></td>
          </tr></table>
        </td></tr>` : ""}
        <!-- Status + KET -->
        <tr><td style="padding:4px 8px 6px 8px;text-align:center;border-top:1px solid ${C.border};">
          <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:800;color:${statusColor};">${statusLabel}</div>
          ${hasKet ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.sky};margin-top:2px;">&#128373; KET Kochtag</div>` : ""}
        </td></tr>
      </table>
    </td>`;
  }).join("");

  // ── SECTION: Staff matrix ─────────────────────────────────────────────────────
  const staffMatrixHtml = weeklyPlanning ? (() => {
    const days = weeklyPlanning.teamByDay;
    const allAreas = Array.from(new Set(days.flatMap(d => Object.keys(d.areas)))).sort();
    const areaGroups: Record<string, string[]> = {
      "Plating": allAreas.filter(a => /plating/i.test(a)),
      "Küche (K)": allAreas.filter(a => /^k\d/i.test(a)),
      "FFM": allAreas.filter(a => /^ffm/i.test(a)),
      "Wareneingang": allAreas.filter(a => /^w\d/i.test(a)),
      "Sonstige": allAreas.filter(a => !/plating|^k\d|^ffm|^w\d/i.test(a)),
    };


    const groupRows = Object.entries(areaGroups).filter(([, areas]) => areas.length > 0).map(([groupName, areas]) => {
      const groupHeader = `<tr><td colspan="${days.length + 1}" style="padding:5px 10px 2px 10px;background:${C.slateBg};font-family:Segoe UI,Arial,sans-serif;font-size:9px;font-weight:800;color:${C.slate};text-transform:uppercase;letter-spacing:0.12em;border-top:1px solid ${C.border};">${groupName}</td></tr>`;
      const areaRows = areas.map((area, idx) => {
        const bg = idx % 2 === 0 ? C.white : C.slateBg;
        const isPlating = /plating/i.test(area);
        const isKitchen = /^k\d/i.test(area);
        const labelColor = isPlating ? C.skyDark : isKitchen ? C.emeraldDark : C.navyLight;
        return `<tr style="background:${bg};">
          <td style="padding:5px 10px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:600;color:${labelColor};white-space:nowrap;">${escapeHtml(area)}</td>
          ${days.map(d => {
            const v = d.areas[area];
            const e = v?.early ?? 0;
            const l = v?.late ?? 0;
            const total = e + l;
            if (total === 0) return `<td style="padding:5px 8px;text-align:center;"><span style="color:#cbd5e1;font-size:10px;">–</span></td>`;
            return `<td style="padding:5px 8px;text-align:center;">
              <span style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:${labelColor};">${total.toFixed(1)}</span>
              <br/><span style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.slate};">${e > 0 ? `F${e.toFixed(1)}` : ""}${l > 0 ? `&nbsp;S${l.toFixed(1)}` : ""}</span>
            </td>`;
          }).join("")}
        </tr>`;
      }).join("");
      return groupHeader + areaRows;
    }).join("");

    return `<tr><td style="padding:20px 24px 8px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
      ${sectionHeader("Mitarbeiter-Matrix", `Besetzung je Bereich und Tag &mdash; Referenz ${escapeHtml(weeklyPlanning.referenceNote)}`, C.sky)}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${C.border};border-radius:12px;overflow:hidden;">

        <!-- Spalten-Header: Bereich + ein Tag pro Spalte -->
        <tr>
          <th align="left" style="padding:8px 14px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.12em;white-space:nowrap;min-width:130px;">Bereich</th>
          ${days.map(d => `<th style="padding:8px 10px;background:${C.navyMid};font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#e2e8f0;text-align:center;letter-spacing:0.06em;font-weight:700;">${d.dayLabel.substring(0,3).toUpperCase()}<br/><span style="font-size:8px;color:#64748b;font-weight:400;">${d.date ? d.date.slice(5) : ""}</span></th>`).join("")}
        </tr>

        <!-- GESAMT-Zeile -->
        <tr style="background:linear-gradient(90deg,${C.navy} 0%,${C.navyMid} 100%);">
          <td style="padding:10px 14px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:900;color:#ffffff;letter-spacing:0.08em;text-transform:uppercase;border-right:1px solid rgba(255,255,255,0.1);">&#128101; GESAMT</td>
          ${days.map(d => {
            const total = d.allStaffEarly + d.allStaffLate;
            const heat = total > 150 ? "#f97316" : total > 100 ? "#fbbf24" : total > 50 ? "#34d399" : "#93c5fd";
            return `<td style="padding:10px 8px;text-align:center;border-right:1px solid rgba(255,255,255,0.06);">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:16px;font-weight:900;color:${heat};line-height:1;">${total > 0 ? Math.round(total) : "–"}</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:#475569;margin-top:2px;">${d.allStaffEarly > 0 ? `F${Math.round(d.allStaffEarly)}` : ""}${d.allStaffLate > 0 ? ` S${Math.round(d.allStaffLate)}` : ""}</div>
            </td>`;
          }).join("")}
        </tr>

        <!-- Plating-Zeile -->
        <tr style="background:#eff6ff;">
          <td style="padding:8px 14px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:${C.skyDark};border-left:3px solid ${C.sky};border-right:1px solid ${C.border};">
            &#9654; Plating
          </td>
          ${days.map(d => {
            const ph = d.platingHeadcountEarly + d.platingHeadcountLate;
            const lines = d.platingLinesEarly + d.platingLinesLate;
            return `<td style="padding:8px 6px;text-align:center;border-right:1px solid ${C.border};">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:800;color:${C.skyDark};">${ph > 0 ? Math.round(ph) : "–"}</div>
              ${lines > 0 ? `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:${C.sky};margin-top:1px;">${lines} Linie${lines > 1 ? "n" : ""}</div>` : ""}
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:#94a3b8;">${d.platingHeadcountEarly > 0 ? `F${Math.round(d.platingHeadcountEarly)}` : ""}${d.platingHeadcountLate > 0 ? ` S${Math.round(d.platingHeadcountLate)}` : ""}</div>
            </td>`;
          }).join("")}
        </tr>

        <!-- Küche-Zeile -->
        <tr style="background:#f0fdf4;">
          <td style="padding:8px 14px;font-family:Segoe UI,Arial,sans-serif;font-size:11px;font-weight:700;color:${C.emeraldDark};border-left:3px solid ${C.emerald};border-right:1px solid ${C.border};">
            &#9654; K&uuml;che
          </td>
          ${days.map(d => {
            const kh = d.kitchenHeadcountEarly + d.kitchenHeadcountLate;
            return `<td style="padding:8px 6px;text-align:center;border-right:1px solid ${C.border};">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:800;color:${C.emeraldDark};">${kh > 0 ? Math.round(kh) : "–"}</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:#94a3b8;margin-top:2px;">${d.kitchenHeadcountEarly > 0 ? `F${Math.round(d.kitchenHeadcountEarly)}` : ""}${d.kitchenHeadcountLate > 0 ? ` S${Math.round(d.kitchenHeadcountLate)}` : ""}</div>
            </td>`;
          }).join("")}
        </tr>

        <!-- Bereichs-Gruppen -->
        ${groupRows}
      </table>
      <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slateLight};margin-top:6px;">
        F = Fr&uuml;hschicht &middot; S = Sp&auml;tschicht &middot; Zahlen = Mitarbeiter (FTE)
      </div>
    </td></tr>`;
  })() : "";

  return `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Produktions-Rundmail ${runLabel} KW${weeklyPlanning?.cw ?? ""}</title>
<style>@media print{body{background:#fff!important;padding:0!important}table{page-break-inside:avoid}@page{size:A4 landscape;margin:8mm}}</style>
</head>
<body style="margin:0;padding:16px;background:#cbd5e1;font-family:Segoe UI,Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:980px;margin:0 auto;">

  <!-- ═══════════════════ HEADER ═══════════════════ -->
  <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#0c4a6e 100%);border-radius:16px 16px 0 0;padding:28px 28px 24px 28px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td>
        <div style="font-size:10px;letter-spacing:0.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:8px;">Factor OPS &middot; Standort Verden &middot; Produktion</div>
        <div style="font-size:28px;font-weight:900;color:#ffffff;line-height:1.1;letter-spacing:-0.02em;">Produktions-Rundmail &mdash; ${runLabel}</div>
        <div style="font-size:16px;font-weight:400;color:#93c5fd;margin-top:4px;">K&uuml;chen-Plan &middot; Kapazit&auml;t &middot; Personal</div>
      </td>
      <td align="right" style="vertical-align:top;white-space:nowrap;">
        <div style="display:inline-block;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);border-radius:10px;padding:8px 16px;text-align:center;">
          <div style="font-size:10px;color:#7dd3fc;letter-spacing:0.1em;">PRODUKTIONSWOCHE</div>
          <div style="font-size:32px;font-weight:900;color:#ffffff;line-height:1;">KW${weeklyPlanning?.cw ?? "–"}</div>
          <div style="font-size:10px;color:#93c5fd;">${weeklyPlanning?.year ?? new Date().getFullYear()}</div>
        </div>
      </td>
    </tr></table>
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.12);font-size:11px;color:#64748b;">
      Erstellt: ${escapeHtml(generatedAt)} &nbsp;&middot;&nbsp; Quelle: ${escapeHtml(sourceLabel)}
      ${weeklyPlanning?.isReference ? `&nbsp;&middot;&nbsp; <span style="color:#f59e0b;font-weight:600;">&#9888; Wochenplanung: Referenz ${escapeHtml(weeklyPlanning.referenceNote)}</span>` : ""}
    </div>
  </td></tr>

  <!-- ═══════════════════ KPI BAND ═══════════════════ -->
  <tr><td style="background:#ffffff;border-left:1px solid ${C.border};border-right:1px solid ${C.border};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        ${kpiCell(`${runLabel} Work Orders`, String(targetRunRows.length), C.navy, `von ${allRows.length} gesamt`)}
        ${kpiCell("Ziel-Portionen", fmtInt(totalTarget), C.sky, runLabel)}
        ${kpiCell("Completion", completion + "%", completion >= 80 ? C.emerald : completion >= 50 ? C.amber : C.red, `${fmtInt(totalCooked)} gekocht`)}
        ${kpiCell("KET Tage", String(allDays.length), C.skyDark, `${runLabel} Produktionstage`) }
        ${kpiCell("WOs gesamt", String(targetRunRows.length), C.navyLight, "inkl. Sub-Rezepte")}
        ${kpiCell("Peak-Personal", maxDayStaff > 0 ? maxDayStaff.toFixed(0) : "–", C.navy, refLabel)}
        ${kpiCell("Rezepte / Sub-Rezepte", `${uniqueRecipes} / ${totalSubRecipes}`, C.navyLight, `${fmtInt(totalKetPortions)} Portionen Küche`)}
        ${kpiCell("Batches", fmtInt(totalBatches), "#4338ca", runLabel)}
        <td style="padding:14px 16px;text-align:center;">
          <div style="font-size:10px;color:${C.slate};text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Offen</div>
          <div style="font-size:26px;font-weight:900;color:${totalOpen > 0 ? C.amber : C.emerald};line-height:1;">${fmtInt(totalOpen)}</div>
          <div style="font-size:10px;color:${C.slateLight};margin-top:3px;">Portionen</div>
        </td>
      </tr>
    </table>
    <!-- Completion bar -->
    <div style="padding:0 0 0 0;">
      <table width="100%" cellspacing="0" cellpadding="0"><tr>
        <td width="${completion}%" style="height:5px;background:linear-gradient(90deg,${C.emerald},${C.sky});"></td>
        ${completion < 100 ? `<td style="height:5px;background:#e2e8f0;"></td>` : ""}
      </tr></table>
    </div>
  </td></tr>

  <!-- ═══════════════════ TOOL-LINKS ═══════════════════ -->
  <tr><td style="background:#f8fafc;padding:12px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:1px solid ${C.border};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:${C.slate};vertical-align:middle;">
        &#128279;&nbsp;<strong>Tools direkt öffnen:</strong>
      </td>
      <td align="right" style="white-space:nowrap;">
        <a href="${WHAT_IF_URL}" style="display:inline-block;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:8px 16px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:700;color:#1d4ed8;text-decoration:none;margin-left:8px;">&#128200;&nbsp;What-if Rechner</a>
        <a href="${BREAKDOWN_URL}" style="display:inline-block;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 16px;font-family:Segoe UI,Arial,sans-serif;font-size:12px;font-weight:700;color:#166534;text-decoration:none;margin-left:8px;">&#128203;&nbsp;Breakdown Rechner</a>
      </td>
    </tr></table>
  </td></tr>

  <!-- ═══════════════════ RUN TIMELINE ═══════════════════ -->
  <tr><td style="background:#f8fafc;padding:16px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
    ${sectionHeader(`${runLabel} Timeline`, `Offene Portionen je Fertigstellungstag`)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      ${timelineCards.map(card => {
        const { date, run } = parseDateNeeded(card.day);
        const isAllDone = card.open === 0;
        return `
        <td style="padding:0 6px 0 0;vertical-align:top;width:${Math.round(100 / timelineCards.length)}%;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${isAllDone ? '#bbf7d0' : C.border};border-radius:10px;overflow:hidden;background:${isAllDone ? '#f0fdf4' : C.white};">
            <tr><td style="background:${isAllDone ? '#166534' : C.navyMid};padding:7px 12px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;font-weight:700;color:#cbd5e1;text-transform:uppercase;letter-spacing:0.08em;">${escapeHtml(date)} &mdash; Run ${run}</div>
            </td></tr>
            <tr><td style="padding:10px 12px;">
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:24px;font-weight:900;color:${isAllDone ? '#166534' : card.open > 5000 ? C.red : C.amber};line-height:1;">${fmtInt(card.open)}</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slate};margin-top:2px;">${isAllDone ? '&#10003; Fertig' : 'Offen'}</div>
              <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slateLight};margin-top:6px;">${card.count} ${runLabel} WOs &middot; Target ${fmtInt(card.target)}</div>
            </td></tr>
          </table>
        </td>`;
      }).join("")}
    </tr></table>
  </td></tr>

  <!-- ═══════════════════ KÜCHEN-PLAN ═══════════════════ -->
  <tr><td style="background:#ffffff;padding:20px 24px 8px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
    ${sectionHeader(`K&uuml;chen-Plan &mdash; ${runLabel}`, `${targetRunRows.length} Work Orders &middot; ${uniqueRecipes} Rezepte &middot; ${fmtInt(totalTarget)} Portionen`)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      ${kitchenPlanHtml}
    </table>
  </td></tr>

  <!-- ═══════════════════ WOCHENKALENDER ═══════════════════ -->
  ${weeklyPlanning ? `<tr><td style="background:#ffffff;padding:20px 20px 16px 20px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border};">
    ${sectionHeader("Wochenkalender &amp; Kapazit&auml;t", `Boxen-Ziel je Tag vs. Plating-Kapazit&auml;t &middot; 1 Linie = ${fmtInt(bpls)} Boxen/Schicht &middot; ${fmtInt(bpls * 2)} bei 2 Linien`, C.sky)}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="4">
      <tr>${calendarCols}</tr>
    </table>
    <div style="font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:${C.slateLight};margin-top:8px;">Balken = Box-Ziel als % der verf&uuml;gbaren Kapazit&auml;t &middot; &#128373; = KET Kochtag &middot; &#10003; = Kapazit&auml;t ausreichend &middot; ! = Kapazit&auml;t pr&uuml;fen</div>
  </td></tr>` : ""}

  <!-- ═══════════════════ KAPAZITÄT & PERSONAL (Ende) ═══════════════════ -->
  ${capacityHtml ? capacityHtml.replace(`<tr><td style="padding:20px 24px 8px 24px;border-top:2px solid #e2e8f0`, `<tr><td style="padding:20px 24px 8px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-top:2px solid ${C.border}`) : ""}

  <!-- ═══════════════════ MITARBEITER-MATRIX ═══════════════════ -->
  ${staffMatrixHtml}

  <!-- ═══════════════════ FOOTER ═══════════════════ -->
  <tr><td style="background:#f1f5f9;border-radius:0 0 16px 16px;padding:16px 24px;border-left:1px solid ${C.border};border-right:1px solid ${C.border};border-bottom:1px solid ${C.border};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      <td style="font-size:11px;color:${C.slate};">
        <strong style="color:${C.navy};">Factor OPS Planner</strong> &middot; Standort Verden &middot; ${escapeHtml(generatedAt)}
      </td>
      <td align="right" style="font-size:10px;color:${C.slateLight};white-space:nowrap;">
        ${escapeHtml(sourceLabel)}
      </td>
    </tr></table>
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid ${C.border};font-size:10px;color:${C.slateLight};">
      Im Browser &ouml;ffnen &rarr; Strg+A &rarr; Strg+C &rarr; in neue E-Mail einf&uuml;gen
    </div>
  </td></tr>

</table>
</body>
</html>`;
}

// ─── KET Präsentation ────────────────────────────────────────────────────────

function buildKetPresentationHtml(allRows: RundmailRow[], sourceLabel: string, targetRun: 1 | 2): string {
  const runRows = allRows.filter((r) => parseDateNeeded(r.dateNeeded).run === targetRun);
  const days = Array.from(new Set(runRows.map((r) => r.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));
  const runLabel = `Run ${targetRun}`;
  const generatedAt = new Date().toLocaleString("de-DE");

  // Deduplizierte Totals
  const dedupedRows = Array.from(new Map(runRows.map((r) => [r.recipeId, r])).values());
  const totalTarget = dedupedRows.reduce((s, r) => s + r.targetPortions, 0);
  const totalCooked = dedupedRows.reduce((s, r) => s + r.woCookedPortions, 0);
  const totalOpen = dedupedRows.reduce((s, r) => s + toSlack(r.targetPortions - r.woCookedPortions), 0);
  const uniqueRecipes = new Set(runRows.map((r) => r.recipeId)).size;
  const completion = totalTarget > 0 ? Math.min(100, Math.round((totalCooked / totalTarget) * 100)) : 0;

  function statusColor(status: string): string {
    const s = status.toLowerCase();
    if (s.includes("post blast") || s.includes("done") || s.includes("complete")) return "#166534";
    if (s.includes("pre blast") || s.includes("in progress")) return "#92400e";
    if (s.includes("not started") || s.includes("open")) return "#991b1b";
    return "#334155";
  }

  const dayBlocks = days.map((day) => {
    const dayRows = runRows.filter((r) => r.dateNeeded === day);
    const recipeMap = new Map<string, { rows: RundmailRow[]; allergens: AllergenDef[] }>();
    dayRows.forEach((r) => {
      const existing = recipeMap.get(r.recipeId);
      if (existing) { existing.rows.push(r); }
      else recipeMap.set(r.recipeId, { rows: [r], allergens: [] });
    });
    recipeMap.forEach((entry) => {
      entry.allergens = detectAllergens([entry.rows[0].recipeName, ...entry.rows.map((r) => r.subRecipeName)]);
    });

    const dayTarget = Array.from(recipeMap.values()).reduce((s, e) => s + e.rows[0].targetPortions, 0);
    const { date, run } = parseDateNeeded(day);

    const recipeCards = Array.from(recipeMap.values()).map((recipe) => {
      const first = recipe.rows[0];
      const hue = (Array.from(first.recipeId).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) * 0.618033) % 1;
      const h = Math.round(hue * 360);
      const allergenHtml = recipe.allergens.length
        ? recipe.allergens.map((a) => `<span class="badge" style="background:${a.bg};color:${a.text};border:1px solid ${a.border};">${escapeHtml(a.label)}</span>`).join("")
        : `<span style="font-size:9px;color:#94a3b8;">Keine bekannten Allergene</span>`;

      const subRows = recipe.rows.map((r) => {
        const delta = r.woCookedPortions - r.targetPortions;
        return `<tr>
          <td class="mono">${escapeHtml(r.workOrderNumber)}</td>
          <td>${escapeHtml(r.subRecipeName)}</td>
          <td class="mono">${escapeHtml(r.cookMethods || "–")}</td>
          <td class="r">${fmtInt(r.targetPortions)}</td>
          <td class="r">${r.kitchenKg != null ? fmtInt(r.kitchenKg) + " kg" : "–"}</td>
          <td class="r bold" style="color:#4338ca;">${r.batchesNeeded != null ? fmtInt(r.batchesNeeded) : "–"}</td>
          <td style="color:${statusColor(r.kitchenStatus)}; font-weight:600;">${escapeHtml(r.kitchenStatus || "–")}</td>
          <td style="color:${delta < 0 ? "#991b1b" : "#166534"};font-weight:600;">${delta >= 0 ? "+" : ""}${fmtInt(delta)}</td>
        </tr>`;
      }).join("");

      return `<div class="recipe-card" style="border-left-color:hsl(${h},60%,42%);">
        <div class="recipe-hdr" style="background:hsl(${h},44%,97%);">
          <div>
            <span class="recipe-name">${escapeHtml(first.recipeName.replace(/\s*\[.*?\]/g, ""))}</span>
            <span class="recipe-id">${escapeHtml(first.recipeId)}</span>
          </div>
          <div class="recipe-meta">
            <span class="kpi-chip">${fmtInt(first.targetPortions)} Port.</span>
            <span class="kpi-chip">${recipe.rows.length} WOs</span>
            ${allergenHtml}
          </div>
        </div>
        <table class="sub-table">
          <thead><tr>
            <th>WO #</th><th>Sub-Rezept</th><th>Methode</th>
            <th class="r">Target</th><th class="r">Küche kg</th>
            <th class="r">Batches</th><th>Status</th><th class="r">Δ</th>
          </tr></thead>
          <tbody>${subRows}</tbody>
        </table>
      </div>`;
    }).join("");

    return `<div class="day-block">
      <div class="day-hdr">
        <span class="day-title">${escapeHtml(date)} &mdash; Run ${run}</span>
        <span class="day-meta">${recipeMap.size} Rezepte &middot; ${dayRows.length} WOs &middot; ${fmtInt(dayTarget)} Portionen</span>
      </div>
      ${recipeCards}
    </div>`;
  }).join("");

  const completionBar = `<div class="prog-track"><div class="prog-fill" style="width:${completion}%;"></div></div>`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>KET Plating Präsentation &mdash; ${runLabel}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4 portrait;margin:12mm 14mm}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#1e293b;background:#fff}
.cover{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 55%,#0369a1 100%);border-radius:10px;padding:28px 28px 22px;margin-bottom:20px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover-eyebrow{font-size:9px;letter-spacing:.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:8px}
.cover-title{font-size:28px;font-weight:900;color:#fff;line-height:1.1;letter-spacing:-.02em}
.cover-sub{font-size:14px;color:#bae6fd;margin-top:6px}
.cover-meta{font-size:9px;color:#94a3b8;margin-top:12px;border-top:1px solid rgba(255,255,255,.18);padding-top:10px}
.kpi-row{display:flex;gap:10px;margin-bottom:18px}
.kpi-box{flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;text-align:center}
.kpi-lbl{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.1em}
.kpi-val{font-size:22px;font-weight:900;color:#0f172a;line-height:1.1;margin-top:2px}
.prog-track{height:5px;background:#e2e8f0;border-radius:9px;overflow:hidden;margin-bottom:18px}
.prog-fill{height:100%;background:linear-gradient(90deg,#0ea5e9,#10b981);border-radius:9px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.day-block{border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:18px;page-break-inside:avoid}
.day-hdr{background:#1e293b;padding:8px 14px;display:flex;justify-content:space-between;align-items:center;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.day-title{font-size:13px;font-weight:800;color:#fff}
.day-meta{font-size:10px;color:#94a3b8}
.recipe-card{border-left:4px solid #0369a1;margin:8px 10px;border-radius:0 6px 6px 0;overflow:hidden}
.recipe-hdr{padding:6px 10px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:4px}
.recipe-name{font-size:12px;font-weight:800;color:#0f172a}
.recipe-id{font-size:10px;color:#64748b;margin-left:8px;font-family:monospace}
.recipe-meta{display:flex;flex-wrap:wrap;gap:3px;align-items:center;margin-top:2px}
.kpi-chip{display:inline-block;background:#e2e8f0;color:#334155;border-radius:4px;padding:1px 6px;font-size:9px;font-weight:700}
.badge{display:inline-block;border-radius:3px;padding:1px 6px;font-size:9px;font-weight:700;margin:1px 2px}
.sub-table{width:100%;border-collapse:collapse;font-size:9px}
.sub-table th{padding:3px 8px;background:#f8fafc;color:#64748b;text-transform:uppercase;letter-spacing:.07em;font-weight:700;text-align:left;border-bottom:1px solid #e2e8f0}
.sub-table td{padding:3px 8px;border-bottom:1px solid #f8fafc;vertical-align:top}
.sub-table tr:last-child td{border-bottom:none}
.r{text-align:right;white-space:nowrap}
.mono{font-family:monospace;color:#475569}
.bold{font-weight:700}
.footer{margin-top:18px;font-size:9px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px}
@media print{body{background:#fff}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}.day-block{page-break-inside:avoid}}
</style>
</head>
<body>
<div class="cover">
  <div class="cover-eyebrow">Factor OPS &middot; Verden &middot; KET</div>
  <div class="cover-title">KET Plating &mdash; ${runLabel}</div>
  <div class="cover-sub">${fmtInt(uniqueRecipes)} Rezepte &middot; ${fmtInt(totalTarget)} Portionen &middot; ${days.length} Produktionstage</div>
  <div class="cover-meta">Erstellt: ${escapeHtml(generatedAt)} &nbsp;&middot;&nbsp; Quelle: ${escapeHtml(sourceLabel)}</div>
</div>
<div class="kpi-row">
  <div class="kpi-box"><div class="kpi-lbl">Rezepte</div><div class="kpi-val">${fmtInt(uniqueRecipes)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Portionen Ziel</div><div class="kpi-val">${fmtInt(totalTarget)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Portionen Ist</div><div class="kpi-val" style="color:#0369a1;">${fmtInt(totalCooked)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Offen</div><div class="kpi-val" style="color:${totalOpen > 0 ? "#b91c1c" : "#166534"};">${fmtInt(totalOpen)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Fertig</div><div class="kpi-val" style="color:${completion >= 80 ? "#166534" : completion >= 50 ? "#92400e" : "#991b1b"};">${completion}%</div></div>
</div>
${completionBar}
${dayBlocks}
<div class="footer">Factor OPS Planner &middot; KET Plating Präsentation &middot; ${escapeHtml(runLabel)} &middot; ${escapeHtml(generatedAt)}</div>
</body>
</html>`;
}

// ─── PET Präsentation ─────────────────────────────────────────────────────────

function buildPetPresentationHtml(
  allPetRows: PetRow[],
  sourceLabel: string,
  targetRun: 1 | 2,
  platingNotes?: Record<string, PlatingNote>,
): string {
  const runLabel = `Run ${targetRun}`;
  const generatedAt = new Date().toLocaleString("de-DE");
  const soonLimit = Date.now() + 48 * 60 * 60 * 1000;

  type EnrichedRow = PetRow & {
    status: string; bestByText: string; bestByTs: number | null;
    open: number; ratio: number; allergens: AllergenDef[];
    expiringSubRecipeName: string;
  };

  const runRows: EnrichedRow[] = allPetRows
    .filter((r) => parseDateNeeded(r.productionShift).run === targetRun)
    .map((r) => {
      const status = r.recipeManualPlatingStatus || r.recipePlatingStatus || "Not Started";
      const bestByText = r.actualBestByDate || r.expiringDatetime || "";
      const bestByTs = parseBestByTimestamp(bestByText);
      const open = toSlack(r.recipeWoTarget - r.recipeWoMapped);
      const ratio = r.recipeWoTarget > 0 ? Math.min(100, Math.round((r.recipeWoMapped / r.recipeWoTarget) * 100)) : 0;
      const allergens = detectAllergens([r.recipeName, r.expiringSubRecipeName || ""]);
      return { ...r, status, bestByText, bestByTs, open, ratio, allergens };
    });

  const shifts = Array.from(new Set(runRows.map((r) => r.productionShift))).sort((a, b) => daySortValue(a) - daySortValue(b));
  const totalTarget = runRows.reduce((s, r) => s + r.recipeWoTarget, 0);
  const totalMapped = runRows.reduce((s, r) => s + r.recipeWoMapped, 0);
  const totalOpen = runRows.reduce((s, r) => s + r.open, 0);
  const completion = totalTarget > 0 ? Math.min(100, Math.round((totalMapped / totalTarget) * 100)) : 0;
  const firstShiftDate = shifts.length ? parseDateNeeded(shifts[0]).date : "–";

  function allergenSig(row: EnrichedRow): string {
    return row.allergens.map((a) => a.label).sort().join("|") || "none";
  }

  function placementScore(lineRows: EnrichedRow[], lineTargets: number[], lineIdx: number, candidate: EnrichedRow): number {
    const last = lineRows.at(-1);
    const switchPenalty = last && allergenSig(last) !== allergenSig(candidate) ? 3 : 0;
    const projected = lineTargets.map((v, i) => i === lineIdx ? v + candidate.recipeWoTarget : v);
    const max = Math.max(...projected, 1);
    const min = Math.min(...projected);
    const balancePenalty = (max - min) / PET_PORTIONS_PER_LINE_PER_SHIFT;
    const overflowPenalty = Math.max(0, (projected[lineIdx] - PET_PORTIONS_PER_LINE_PER_SHIFT) / PET_PORTIONS_PER_LINE_PER_SHIFT) * 2;
    return switchPenalty + balancePenalty + overflowPenalty;
  }

  const LINE_COLORS = ["#0ea5e9", "#10b981", "#f59e0b"];
  const LINE_NAMES = ["Linie 1", "Linie 2", "Linie 3"];

  const shiftBlocks = shifts.map((shift, shiftIdx) => {
    const rows = runRows
      .filter((r) => r.productionShift === shift)
      .sort((a, b) => {
        if (a.bestByTs != null && b.bestByTs != null && a.bestByTs !== b.bestByTs) return a.bestByTs - b.bestByTs;
        if (a.bestByTs != null && b.bestByTs == null) return -1;
        if (a.bestByTs == null && b.bestByTs != null) return 1;
        return b.open - a.open;
      });

    const shiftTarget = rows.reduce((s, r) => s + r.recipeWoTarget, 0);
    const shiftMapped = rows.reduce((s, r) => s + r.recipeWoMapped, 0);
    const linesNeeded = shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
    const lineCount = linesNeeded > 2 ? 3 : 2;
    const lines: EnrichedRow[][] = Array.from({ length: lineCount }, () => []);
    const lineTargets = Array.from({ length: lineCount }, () => 0);

    for (const row of rows) {
      let bestLine = 0, bestScore = Infinity;
      for (let i = 0; i < lineCount; i++) {
        const s = placementScore(lines[i], lineTargets, i, row) + (lineTargets[i] / PET_PORTIONS_PER_LINE_PER_SHIFT) * 0.001;
        if (s < bestScore) { bestScore = s; bestLine = i; }
      }
      lines[bestLine].push(row);
      lineTargets[bestLine] += row.recipeWoTarget;
    }

    const { date } = parseDateNeeded(shift);
    const completedOn = oneDayBefore(date);
    const shiftUtil = linesNeeded > 0 ? Math.min(100, Math.round((shiftTarget / (linesNeeded * PET_PORTIONS_PER_LINE_PER_SHIFT)) * 100)) : 0;
    const shiftOpen = rows.reduce((s, r) => s + r.open, 0);

    const lineColumns = lines.map((lineRows, lineIdx) => {
      let cursorMin = PET_LINE_START_HOUR * 60;
      const lineColor = LINE_COLORS[lineIdx] ?? "#0ea5e9";

      const cards = lineRows.map((row, rowIdx) => {
        const mealCode = extractMealCode(row.recipeName);
        const mealTitle = row.recipeName.replace(/\s*\[.*?\]/g, "").replace(/^FV\d{4}[A-Z]\s*-\s*/i, "").trim();
        const durationMin = Math.max(10, Math.round((row.recipeWoTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) * 60));
        const timeStart = cursorMin;
        const timeEnd = cursorMin + durationMin;
        cursorMin = timeEnd;

        const bestByUrgent = row.bestByTs != null && row.bestByTs <= soonLimit;
        const tone = petStatusTone(row.status);
        const allergenBadges = row.allergens.length
          ? row.allergens.map((a) => `<span class="badge" style="background:${a.bg};color:${a.text};border:1px solid ${a.border};">${escapeHtml(a.label)}</span>`).join("")
          : `<span style="font-size:8px;color:#94a3b8;">–</span>`;

        const note = platingNotes?.[mealCode];
        const noteHtml = note?.instruction
          ? `<div class="plating-note"><strong>Plating:</strong> ${escapeHtml(note.instruction)}</div>`
          : "";
        const imageHtml = note?.packSchemaImageDataUrl
          ? `<div style="margin-top:4px;"><div class="section-lbl">Packschema</div><img src="${note.packSchemaImageDataUrl}" alt="Packschema ${escapeHtml(mealCode)}" class="pack-img"></div>`
          : "";

        // Reinigungsblock zwischen Rezepten bei Allergen-Wechsel
        let cleanHtml = "";
        if (rowIdx < lineRows.length - 1) {
          const cur = new Set(row.allergens.map((a) => a.label));
          const nxt = new Set((lineRows[rowIdx + 1]?.allergens ?? []).map((a) => a.label));
          const removed = [...cur].filter((l) => !nxt.has(l));
          const added = [...nxt].filter((l) => !cur.has(l));
          if (removed.length > 0 || added.length > 0) {
            const parts = [
              removed.length ? `entfernt: <strong>${removed.map(escapeHtml).join(", ")}</strong>` : "",
              added.length ? `neu: <strong>${added.map(escapeHtml).join(", ")}</strong>` : "",
            ].filter(Boolean).join(" &middot; ");
            cleanHtml = `<div class="cleaning-bar">&#9888; REINIGEN &mdash; ${parts}</div>`;
          }
        }

        return `<div class="recipe-card" style="border-left-color:${lineColor};">
          <div class="time-row">
            <span class="time-start">${formatClock(timeStart)}</span>
            <span class="time-sep">→</span>
            <span class="time-end">${formatClock(timeEnd)}</span>
            <span class="time-dur">${(durationMin / 60).toFixed(1)} h</span>
          </div>
          <div class="meal-code">${escapeHtml(mealCode)}</div>
          <div class="meal-title">${escapeHtml(mealTitle)}</div>
          <div class="meta-row">
            <span>SOLL <strong>${fmtInt(row.recipeWoTarget)}</strong></span>
            <span>IST <strong>${fmtInt(row.recipeWoMapped)}</strong></span>
            <span style="color:${row.open > 0 ? "#b91c1c" : "#166534"};">Gap <strong>${fmtInt(row.open)}</strong></span>
          </div>
          ${row.bestByText ? `<div class="best-by${bestByUrgent ? " urgent" : ""}">Best By: ${escapeHtml(row.bestByText)}</div>` : ""}
          <div class="allergen-row">${allergenBadges}</div>
          <div><span class="status-chip" style="background:${tone.bg};color:${tone.text};border:1px solid ${tone.border};">${escapeHtml(row.status)}</span></div>
          ${noteHtml}${imageHtml}
        </div>${cleanHtml}`;
      }).join("");

      return `<div class="line-col">
        <div class="line-title" style="border-bottom:3px solid ${lineColor};color:${lineColor};">
          ${LINE_NAMES[lineIdx] ?? `Linie ${lineIdx + 1}`}
          <span class="line-meta">${fmtInt(lineTargets[lineIdx])} Port.</span>
        </div>
        ${cards || `<div class="empty-line">Keine Rezepte</div>`}
      </div>`;
    }).join("");

    return `<div class="shift-block${shiftIdx > 0 ? " page-break" : ""}">
      <div class="shift-hdr">
        <div>
          <span class="shift-title">Plating ab ${escapeHtml(date)} &mdash; Fertigstellung: ${escapeHtml(completedOn)}</span>
          <span class="shift-meta">${rows.length} Rezepte &middot; ${fmtInt(shiftTarget)} Port. Soll &middot; ${fmtInt(shiftMapped)} Ist &middot; Offen ${fmtInt(shiftOpen)} &middot; ${shiftUtil}% Auslast.</span>
        </div>
      </div>
      <div class="lines-grid" style="grid-template-columns:repeat(${lineCount},1fr);">
        ${lineColumns}
      </div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>PET Plating Präsentation &mdash; ${runLabel}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4 landscape;margin:10mm 12mm}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#1e293b;background:#fff}
.cover{background:linear-gradient(135deg,#0f172a 0%,#0c4a6e 60%,#0369a1 100%);border-radius:10px;padding:22px 24px 18px;margin-bottom:16px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.cover-eyebrow{font-size:9px;letter-spacing:.2em;color:#7dd3fc;text-transform:uppercase;margin-bottom:6px}
.cover-title{font-size:26px;font-weight:900;color:#fff;letter-spacing:-.02em}
.cover-sub{font-size:13px;color:#bae6fd;margin-top:5px}
.cover-meta{font-size:9px;color:#94a3b8;margin-top:10px;border-top:1px solid rgba(255,255,255,.15);padding-top:8px}
.kpi-row{display:flex;gap:8px;margin-bottom:14px}
.kpi-box{flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:8px 10px;text-align:center}
.kpi-lbl{font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:.1em}
.kpi-val{font-size:20px;font-weight:900;color:#0f172a;margin-top:2px}
.prog-track{height:4px;background:#e2e8f0;border-radius:9px;overflow:hidden;margin-bottom:14px}
.prog-fill{height:100%;background:linear-gradient(90deg,#0ea5e9,#10b981);-webkit-print-color-adjust:exact;print-color-adjust:exact}
.shift-block{margin-bottom:16px}
.page-break{page-break-before:always}
.shift-hdr{background:#0f172a;border-radius:8px 8px 0 0;padding:8px 14px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.shift-title{font-size:12px;font-weight:800;color:#fff;display:block}
.shift-meta{font-size:9px;color:#94a3b8;display:block;margin-top:2px}
.lines-grid{display:grid;gap:8px;align-items:start;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:10px;background:#f8fafc}
.line-col{background:#fff;border-radius:6px;border:1px solid #e2e8f0;padding:8px;min-height:60px}
.line-title{font-size:11px;font-weight:800;padding-bottom:5px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center}
.line-meta{font-size:9px;color:#64748b;font-weight:400}
.recipe-card{border-left:3px solid #0ea5e9;border-radius:0 5px 5px 0;background:#fff;border:1px solid #e2e8f0;border-left-width:3px;padding:6px 8px;margin-bottom:5px}
.time-row{display:flex;align-items:center;gap:4px;font-size:9px;color:#64748b;margin-bottom:3px}
.time-start{font-weight:800;color:#0f172a}
.time-sep{color:#94a3b8}
.time-end{color:#475569}
.time-dur{margin-left:auto;font-weight:700;color:#0369a1}
.meal-code{font-family:monospace;font-size:11px;font-weight:900;color:#0f172a}
.meal-title{font-size:10px;color:#334155;margin-bottom:3px}
.meta-row{display:flex;gap:8px;font-size:9px;color:#475569;margin-bottom:3px}
.best-by{font-size:9px;color:#475569;margin-bottom:3px}
.best-by.urgent{color:#991b1b;font-weight:800}
.allergen-row{margin-bottom:3px}
.badge{display:inline-block;border-radius:3px;padding:1px 5px;font-size:8px;font-weight:700;margin:1px 1px}
.status-chip{display:inline-block;border-radius:99px;padding:2px 7px;font-size:9px;font-weight:800;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.plating-note{margin-top:5px;padding:4px 7px;background:#f0fdf4;border-left:3px solid #22c55e;border-radius:0 3px 3px 0;font-size:9px;color:#166534;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.section-lbl{font-size:8px;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px}
.pack-img{max-width:100%;max-height:90px;object-fit:contain;border:1px solid #e2e8f0;border-radius:4px}
.cleaning-bar{margin:3px 0 6px;padding:4px 8px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:5px;font-size:9px;color:#78350f;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.empty-line{font-size:9px;color:#94a3b8;text-align:center;padding:12px}
.footer{margin-top:14px;font-size:9px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:8px}
@media print{body{background:#fff}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}.page-break{page-break-before:always}}
</style>
</head>
<body>
<div class="cover">
  <div class="cover-eyebrow">Factor OPS &middot; Verden &middot; PET</div>
  <div class="cover-title">PET Plating &mdash; ${runLabel}</div>
  <div class="cover-sub">ab ${escapeHtml(firstShiftDate)} &middot; ${fmtInt(runRows.length)} Rezepte &middot; ${fmtInt(totalTarget)} Portionen</div>
  <div class="cover-meta">Erstellt: ${escapeHtml(generatedAt)} &nbsp;&middot;&nbsp; Quelle: ${escapeHtml(sourceLabel)}</div>
</div>
<div class="kpi-row">
  <div class="kpi-box"><div class="kpi-lbl">Meal-WOs</div><div class="kpi-val">${fmtInt(runRows.length)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Soll</div><div class="kpi-val">${fmtInt(totalTarget)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Ist</div><div class="kpi-val" style="color:#0369a1;">${fmtInt(totalMapped)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Offen</div><div class="kpi-val" style="color:${totalOpen > 0 ? "#b91c1c" : "#166534"};">${fmtInt(totalOpen)}</div></div>
  <div class="kpi-box"><div class="kpi-lbl">Fertig</div><div class="kpi-val" style="color:${completion >= 80 ? "#166534" : completion >= 50 ? "#92400e" : "#991b1b"};">${completion}%</div></div>
</div>
<div class="prog-track"><div class="prog-fill" style="width:${completion}%;"></div></div>
${shiftBlocks}
<div class="footer">Factor OPS Planner &middot; PET Plating Präsentation &middot; ${escapeHtml(runLabel)} &middot; ${escapeHtml(generatedAt)}</div>
</body>
</html>`;
}

function downloadFile(name: string, content: string, mime = "text/plain;charset=utf-8") {
  const blob = new Blob(["\uFEFF", content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function printHtmlAsPdf(html: string): void {
  const w = window.open("", "_blank", "width=1200,height=900");
  if (!w) { alert("Popup blockiert – bitte für diese Seite erlauben."); return; }
  w.document.write(html);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 450);
}

async function copyHtmlToClipboard(html: string): Promise<void> {
  if (typeof navigator?.clipboard?.write === "function") {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([html.replace(/<[^>]+>/g, " ")], { type: "text/plain" }),
      }),
    ]);
  } else {
    // Fallback: neuen Tab \u00F6ffnen, User kann dort manuell kopieren
    const blob = new Blob(["\uFEFF", html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    throw new Error("clipboard-fallback");
  }
}

function buildPetSlackBlocks(petRows: PetRow[], sourceLabel: string, run: 1 | 2): object {
  const runRows = petRows.filter((r) => parseDateNeeded(r.productionShift).run === run);
  const totalTarget = runRows.reduce((s, r) => s + r.recipeWoTarget, 0);
  const totalMapped = runRows.reduce((s, r) => s + r.recipeWoMapped, 0);
  const totalOpen = runRows.reduce((s, r) => s + toSlack(r.recipeWoTarget - r.recipeWoMapped), 0);
  const doneCount = runRows.filter((r) => (r.recipeManualPlatingStatus || r.recipePlatingStatus || "").toLowerCase().includes("done")).length;
  const inProgressCount = runRows.filter((r) => (r.recipeManualPlatingStatus || r.recipePlatingStatus || "").toLowerCase().includes("in progress")).length;
  const notStartedCount = runRows.filter((r) => {
    const s = (r.recipeManualPlatingStatus || r.recipePlatingStatus || "Not Started").toLowerCase();
    return s.includes("not started") || (!s.includes("done") && !s.includes("in progress"));
  }).length;

  const shifts = Array.from(new Set(runRows.map((r) => r.productionShift))).sort((a, b) => daySortValue(a) - daySortValue(b));
  const generatedAt = new Date().toLocaleString("de-DE");

  const shiftSections = shifts.map((shift) => {
    const shiftRows = runRows.filter((r) => r.productionShift === shift);
    const { date } = parseDateNeeded(shift);
    const shiftTarget = shiftRows.reduce((s, r) => s + r.recipeWoTarget, 0);
    const shiftMapped = shiftRows.reduce((s, r) => s + r.recipeWoMapped, 0);
    const allergenSet = new Set(shiftRows.flatMap((r) => detectAllergens([r.recipeName, r.bestBySubRecipeName, r.expiringSubRecipeName]).map((a) => a.label)));
    const allergenStr = allergenSet.size ? [...allergenSet].join(", ") : "keine";
    const mealLines = shiftRows.map((r) => {
      const status = r.recipeManualPlatingStatus || r.recipePlatingStatus || "Not Started";
      const gap = toSlack(r.recipeWoTarget - r.recipeWoMapped);
      const emoji = status.toLowerCase().includes("done") ? "\u2705" : status.toLowerCase().includes("in progress") ? "\uD83D\uDD04" : "\u2B1C";
      return `${emoji} *${escapeHtml(r.recipeName)}* \u2014 SOLL ${r.recipeWoTarget.toLocaleString("de-DE")} | IST ${r.recipeWoMapped.toLocaleString("de-DE")} | Gap ${gap.toLocaleString("de-DE")}`;
    });
    const linesNeeded = shiftTarget > 0 ? Math.ceil(shiftTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) : 0;
    const lineCount = linesNeeded > 2 ? 3 : 2;
    const staffNeeded = shiftRows.length + lineCount;

    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*\uD83D\uDCC5 Plating ab ${date} \u2014 Run ${run}*\nSoll ${shiftTarget.toLocaleString("de-DE")} | IST ${shiftMapped.toLocaleString("de-DE")} | Linien ${lineCount} | MA ~${staffNeeded}\nAllergene: ${allergenStr}`,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: mealLines.join("\n") || "_Keine Rezepte_" } },
      { type: "divider" },
    ];
  });

  return {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `PET Plating \u2014 Run ${run}`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*SOLL*\n${totalTarget.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*IST*\n${totalMapped.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*Gap*\n${totalOpen.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*Status*\n\u2705 ${doneCount} Done \u00B7 \uD83D\uDD04 ${inProgressCount} Running \u00B7 \u2B1C ${notStartedCount} Offen` },
        ],
      },
      { type: "divider" },
      ...shiftSections.flat(),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Erstellt: ${generatedAt} \u00B7 Quelle: ${sourceLabel}` }],
      },
    ],
  };
}

function buildKetSlackBlocks(allRows: RundmailRow[], sourceLabel: string, run: 1 | 2): object {
  const runRows = allRows.filter((r) => parseDateNeeded(r.dateNeeded).run === run);
  const dedupedRun = Array.from(new Map(runRows.map((r) => [r.recipeId, r])).values());
  const totalTarget = dedupedRun.reduce((s, r) => s + r.targetPortions, 0);
  const totalCooked = dedupedRun.reduce((s, r) => s + r.woCookedPortions, 0);
  const totalOpen = dedupedRun.reduce((s, r) => s + toSlack(r.targetPortions - r.woCookedPortions), 0);
  const generatedAt = new Date().toLocaleString("de-DE");

  const days = Array.from(new Set(runRows.map((r) => r.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));

  const daySections = days.map((day) => {
    const dayRows = runRows.filter((r) => r.dateNeeded === day);
    const { date } = parseDateNeeded(day);
    const recipeMap = new Map<string, RundmailRow>();
    dayRows.forEach((r) => { if (!recipeMap.has(r.recipeId)) recipeMap.set(r.recipeId, r); });
    const dayTarget = Array.from(recipeMap.values()).reduce((s, r) => s + r.targetPortions, 0);
    const dayCooked = Array.from(recipeMap.values()).reduce((s, r) => s + r.woCookedPortions, 0);
    const recipeLines = Array.from(recipeMap.values()).map((r) => {
      const gap = toSlack(r.targetPortions - r.woCookedPortions);
      const ratio = r.targetPortions > 0 ? Math.round((r.woCookedPortions / r.targetPortions) * 100) : 0;
      const allergens = detectAllergens([r.recipeName, r.subRecipeName]).map((a) => a.label).join(", ");
      const allergenStr = allergens ? ` | \u26A0 ${allergens}` : "";
      return `\u2022 *${r.recipeName}* \u2014 SOLL ${r.targetPortions.toLocaleString("de-DE")} | IST ${r.woCookedPortions.toLocaleString("de-DE")} | Gap ${gap.toLocaleString("de-DE")} (${ratio}%)${allergenStr}`;
    });
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*\uD83C\uDF73 ${date} \u2014 KET Run ${run}*\nSoll ${dayTarget.toLocaleString("de-DE")} | IST ${dayCooked.toLocaleString("de-DE")} | ${recipeMap.size} Rezepte`,
        },
      },
      { type: "section", text: { type: "mrkdwn", text: recipeLines.join("\n") || "_Keine Rezepte_" } },
      { type: "divider" },
    ];
  });

  return {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `KET K\u00FCchen-Plan \u2014 Run ${run}`, emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*SOLL*\n${totalTarget.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*IST*\n${totalCooked.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*Gap*\n${totalOpen.toLocaleString("de-DE")}` },
          { type: "mrkdwn", text: `*Rezepte*\n${dedupedRun.length}` },
        ],
      },
      { type: "divider" },
      ...daySections.flat(),
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Erstellt: ${generatedAt} \u00B7 Quelle: ${sourceLabel}` }],
      },
    ],
  };
}

async function sendToSlack(webhookUrl: string, payload: object): Promise<void> {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`Slack HTTP ${resp.status}`);
}

export function RundmailView({ data, onNavigate }: { data?: DataBundle; onNavigate?: (view: string) => void } = {}) {
  const [rows, setRows] = useState<RundmailRow[]>([]);
  const [petRows, setPetRows] = useState<PetRow[]>([]);
  const [platingNotes, setPlatingNotes] = useState<Record<string, PlatingNote>>(() => loadPlatingNotes());
  const [platingEditorOpen, setPlatingEditorOpen] = useState(false);
  const platingImageInputRef = useRef<HTMLInputElement | null>(null);
  const [platingImageTargetCode, setPlatingImageTargetCode] = useState<string | null>(null);
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [isDragging, setIsDragging] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("Seed: public/data/rundmail-seed.csv");
  const [petSourceLabel, setPetSourceLabel] = useState("PET CSV noch nicht geladen");
  const [mailText, setMailText] = useState("");
  const [weeklyPlanning, setWeeklyPlanning] = useState<WeeklyPlanningData | null>(null);
  const [slackWebhookUrl, setSlackWebhookUrl] = useState<string>(
    () => (typeof localStorage !== "undefined" ? localStorage.getItem("slackWebhookUrl") ?? "" : "")
  );
  const [slackWebhookInput, setSlackWebhookInput] = useState<string>(
    () => (typeof localStorage !== "undefined" ? localStorage.getItem("slackWebhookUrl") ?? "" : "")
  );
  const [copyToast, setCopyToast] = useState<string>("");
  const [bibleHints, setBibleHints] = useState<Map<string, BatchHint>>(new Map());
  // Basis-URL für interne Tool-Links im HTML-Export.
  // Im Build: VITE_APP_URL setzen (z.B. https://myapp.example.com). Fallback: aktuelle Origin.
  const appOrigin = ((import.meta.env.VITE_APP_URL as string) || "").replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const petFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/data/rundmail-seed.csv", { cache: "no-store" });
        if (!response.ok) throw new Error(`Seed CSV konnte nicht geladen werden: ${response.status}`);
        const csvText = await response.text();
        if (cancelled) return;
        const parsedRows = parseSeedCsv(csvText);
        setRows(parsedRows);
      } catch {
        if (!cancelled) {
          setRows([]);
          setSourceLabel("⚠ Seed-CSV konnte nicht geladen werden — bitte CSV manuell hochladen.");
        }
      }
    })();

    (async () => {
      try {
        const res = await fetch("/data/weekly-planning.json", { cache: "no-store" });
        if (!res.ok) return;
        const data: WeeklyPlanningData = await res.json();
        if (!cancelled) setWeeklyPlanning(data);
      } catch {
        // weekly-planning.json optional – kein Fehler
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [masterRes, biblesRes] = await Promise.all([
          fetch("/data/gsheet-dump-NEW_MASTER_SUPERVISORS_WORKLOAD_PLANNING.json"),
          fetch("/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json"),
        ]);
        if (!masterRes.ok || !biblesRes.ok) return;
        const [masterDump, biblesDump] = await Promise.all([masterRes.json(), biblesRes.json()]);
        if (!active) return;
        setBibleHints(parseBibleBatchHints(masterDump, biblesDump));
      } catch {
        // Optional fallback source for capacities.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const processSpecsByName = useMemo(() => {
    const map = new Map<string, ProcessSpec>();
    for (const spec of Object.values((data?.processSpecs ?? {}) as Record<string, ProcessSpec>)) {
      if (!spec?.name) continue;
      const key = normalizeText(spec.name);
      if (!key || map.has(key)) continue;
      map.set(key, spec);
    }
    return map;
  }, [data]);

  const productionByWorkOrder = useMemo(() => {
    const map = new Map<string, WorkOrderEntry[]>();
    const productionRows = data?.productionPlan?.rows ?? [];
    for (const row of productionRows) {
      const workOrder = (row.workOrder ?? "").trim();
      if (!workOrder) continue;
      const list = map.get(workOrder) ?? [];
      list.push(row);
      map.set(workOrder, list);
    }
    return map;
  }, [data]);

  const enrichedRows = useMemo(() => {
    return rows.map((row) => {
      const kitchenKg = resolveKitchenKgForRow(row, productionByWorkOrder) ?? null;
      const fallbackMinimumKg = row.minimumNeeds > 0 ? row.minimumNeeds : null;
      const demandKg = kitchenKg ?? fallbackMinimumKg;
      const batchSizeKg = resolveBatchSizeKg(row.subRecipeName, processSpecsByName, bibleHints);
      const batchesNeeded = demandKg && batchSizeKg && batchSizeKg > 0
        ? Math.ceil(demandKg / batchSizeKg)
        : null;
      return {
        ...row,
        kitchenKg,
        batchSizeKg,
        batchesNeeded,
      };
    });
  }, [rows, productionByWorkOrder, processSpecsByName, bibleHints]);

  const days = useMemo(() => {
    const run1Days = Array.from(new Set(enrichedRows.filter((row) => isRun1(row.dateNeeded)).map((row) => row.dateNeeded))).sort(
      (a, b) => daySortValue(a) - daySortValue(b)
    );
    if (run1Days.length) return run1Days;
    return Array.from(new Set(enrichedRows.map((row) => row.dateNeeded))).sort((a, b) => daySortValue(a) - daySortValue(b));
  }, [enrichedRows]);

  const run1Rows = useMemo(() => enrichedRows.filter((row) => isRun1(row.dateNeeded)), [enrichedRows]);

  useEffect(() => {
    if (!days.length) {
      setSelectedDays(new Set());
      return;
    }
    // Beim ersten Laden alle Tage vorauswählen; ungültige Tage rauswerfen
    setSelectedDays((prev) => {
      if (prev.size === 0) return new Set(days);
      const valid = days.filter((d) => prev.has(d));
      return valid.length ? new Set(valid) : new Set(days);
    });
  }, [days]);

  const rowsByDay = useMemo(() => {
    const map = new Map<string, RundmailRow[]>();
    enrichedRows.forEach((row) => {
      const list = map.get(row.dateNeeded) ?? [];
      list.push(row);
      map.set(row.dateNeeded, list);
    });
    return map;
  }, [enrichedRows]);

  const visibleRows = useMemo(() => {
    const base = selectedDays.size > 0 ? enrichedRows.filter((row) => selectedDays.has(row.dateNeeded)) : enrichedRows;

    return base.filter((row) => {
      const haystack = [
        row.workOrderNumber,
        row.recipeName,
        row.subRecipeName,
        row.workOrderComment,
        row.stagingComment,
        row.kitchenStatus,
      ]
        .join(" ")
        .toLowerCase();

      const needle = searchText.trim().toLowerCase();
      const searchPass = !needle || haystack.includes(needle);
      const statusPass = statusFilter === "all" || row.kitchenStatus === statusFilter;
      return searchPass && statusPass;
    });
  }, [enrichedRows, searchText, selectedDays, statusFilter]);

  const summary = useMemo(() => {
    // Deduplizierung: Target und Cooked nur einmal pro Rezept zählen,
    // da alle Sub-Rezepte desselben Rezepts identische Portionszahlen haben.
    const seen = new Map<string, RundmailRow>();
    visibleRows.forEach((row) => {
      const prev = seen.get(row.recipeId);
      if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
    });
    const deduped = Array.from(seen.values());
    return deduped.reduce(
      (acc, row) => {
        acc.target += row.targetPortions;
        acc.cooked += row.woCookedPortions;
        acc.open += toSlack(row.targetPortions - row.woCookedPortions);
        acc.minNeeds += row.minimumNeeds;
        return acc;
      },
      { target: 0, cooked: 0, open: 0, minNeeds: 0 }
    );
  }, [visibleRows]);

  const run1Summary = useMemo(() => {
    const seen = new Map<string, RundmailRow>();
    run1Rows.forEach((row) => {
      const prev = seen.get(row.recipeId);
      if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
    });
    return Array.from(seen.values()).reduce(
      (acc, row) => {
        acc.target += row.targetPortions;
        acc.cooked += row.woCookedPortions;
        return acc;
      },
      { target: 0, cooked: 0 }
    );
  }, [run1Rows]);

  const selectedDayRows = useMemo(() => {
    if (!selectedDays.size) return [];
    return enrichedRows.filter((row) => selectedDays.has(row.dateNeeded));
  }, [enrichedRows, selectedDays]);

  const selectedDayStatus = useMemo(() => {
    return selectedDayRows.reduce<Record<string, number>>((acc, row) => {
      const key = row.kitchenStatus || "Unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  }, [selectedDayRows]);

  const selectedDayTopDeficits = useMemo<DeficitItem[]>(() => {
    return selectedDayRows
      .map((row) => ({ row, deficit: toSlack(row.targetPortions - row.woCookedPortions) }))
      .filter((item) => item.deficit > 0)
      .sort((a, b) => b.deficit - a.deficit)
      .slice(0, 6);
  }, [selectedDayRows]);

  const completionRate = useMemo(() => {
    if (run1Summary.target <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((run1Summary.cooked / run1Summary.target) * 100)));
  }, [run1Summary.cooked, run1Summary.target]);

  const dayCards = useMemo(() => {
    return days.map((day) => {
      const dayRows = rowsByDay.get(day) ?? [];
      const seen = new Map<string, RundmailRow>();
      dayRows.forEach((row) => {
        const prev = seen.get(row.recipeId);
        if (!prev || row.targetPortions > prev.targetPortions) seen.set(row.recipeId, row);
      });
      const deduped = Array.from(seen.values());
      const target = deduped.reduce((sum, row) => sum + row.targetPortions, 0);
      const cooked = deduped.reduce((sum, row) => sum + row.woCookedPortions, 0);
      const open = deduped.reduce((sum, row) => sum + toSlack(row.targetPortions - row.woCookedPortions), 0);
      return { day, count: dayRows.length, target, cooked, open };
    });
  }, [days, rowsByDay]);

  useEffect(() => {
    if (!run1Rows.length) {
      setMailText("");
      return;
    }
    setMailText(buildRun1Mail(run1Rows));
  }, [run1Rows]);

  function applyCsvText(csvText: string, label: string) {
    const parsedRows = parseSeedCsv(csvText);
    setRows(parsedRows);
    setSourceLabel(label);
  }

  function applyPetCsvText(csvText: string, label: string) {
    const parsedRows = parsePetCsv(csvText);
    setPetRows(parsedRows);
    setPetSourceLabel(label);
  }

  function onFileSelected(file: File | null) {
    if (!file) return;
    file
      .text()
      .then((csvText) => {
        const detected = detectCsvType(csvText);
        if (detected === "pet") {
          applyPetCsvText(csvText, `PET Upload (auto erkannt): ${file.name}`);
          return;
        }
        applyCsvText(csvText, `Upload: ${file.name}`);
      })
      .catch(() => {
        setSourceLabel(`Upload fehlgeschlagen: ${file.name}`);
      });
  }

  function onPetFileSelected(file: File | null) {
    if (!file) return;
    file
      .text()
      .then((csvText) => {
        const detected = detectCsvType(csvText);
        if (detected === "ket") {
          applyCsvText(csvText, `KET Upload (auto erkannt): ${file.name}`);
          return;
        }
        applyPetCsvText(csvText, `PET Upload: ${file.name}`);
      })
      .catch(() => {
        setPetSourceLabel(`PET Upload fehlgeschlagen: ${file.name}`);
      });
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    if (!file) return;
    file
      .text()
      .then((csvText) => {
        const detected = detectCsvType(csvText);
        if (detected === "pet") {
          applyPetCsvText(csvText, `PET Drag&Drop: ${file.name}`);
          return;
        }
        applyCsvText(csvText, `Drag&Drop: ${file.name}`);
      })
      .catch(() => {
        setSourceLabel(`Upload fehlgeschlagen: ${file.name}`);
      });
  }

  function updateRow(id: string, patch: Partial<Pick<RundmailRow, "kitchenStatus" | "stagingStatus" | "workOrderComment" | "stagingComment">>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function copyCurrentMail() {
    if (!mailText) return;
    void navigator.clipboard.writeText(mailText);
  }

  // @ts-expect-error unused
  const _run1Mail = useMemo(() => buildRun1Mail(run1Rows), [run1Rows]);
  const toolLinks = useMemo(() => ({
    whatIf: appOrigin + "?view=whatif",
    breakdown: appOrigin + "?view=breakdown",
  }), [appOrigin]);
  const run1HtmlMail = useMemo(() => buildRunHtmlMail(enrichedRows, sourceLabel, weeklyPlanning, 1, toolLinks), [enrichedRows, sourceLabel, weeklyPlanning, toolLinks]);
  const run2HtmlMail = useMemo(() => buildRunHtmlMail(enrichedRows, sourceLabel, weeklyPlanning, 2, toolLinks), [enrichedRows, sourceLabel, weeklyPlanning, toolLinks]);
  const petRun1Rows = useMemo(() => petRows.filter((row) => parseDateNeeded(row.productionShift).run === 1), [petRows]);
  const petRun2Rows = useMemo(() => petRows.filter((row) => parseDateNeeded(row.productionShift).run === 2), [petRows]);
  const petRun1HtmlMail = useMemo(() => buildPetHtmlMail(petRows, petSourceLabel, 1, platingNotes), [petRows, petSourceLabel, platingNotes]);
  const petRun2HtmlMail = useMemo(() => buildPetHtmlMail(petRows, petSourceLabel, 2, platingNotes), [petRows, petSourceLabel, platingNotes]);
  const ketPraesi1Html = useMemo(() => buildKetPresentationHtml(enrichedRows, sourceLabel, 1), [enrichedRows, sourceLabel]);
  const ketPraesi2Html = useMemo(() => buildKetPresentationHtml(enrichedRows, sourceLabel, 2), [enrichedRows, sourceLabel]);
  const petPraesi1Html = useMemo(() => buildPetPresentationHtml(petRows, petSourceLabel, 1, platingNotes), [petRows, petSourceLabel, platingNotes]);
  const petPraesi2Html = useMemo(() => buildPetPresentationHtml(petRows, petSourceLabel, 2, platingNotes), [petRows, petSourceLabel, platingNotes]);

  const kitchenStatuses = useMemo(() => {
    const set = new Set<string>();
    enrichedRows.forEach((row) => {
      if (row.kitchenStatus) set.add(row.kitchenStatus);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [enrichedRows]);

  function showToast(msg: string) {
    setCopyToast(msg);
    setTimeout(() => setCopyToast(""), 4000);
  }

  return (
    <>
    {copyToast && (
      <div className="fixed bottom-6 right-6 z-50 bg-emerald-600 text-white text-sm font-semibold px-5 py-3 rounded-xl shadow-xl flex items-center gap-2 animate-fade-in">
        <span>{copyToast}</span>
      </div>
    )}
    <div className="space-y-4 rundmail-page">
      <section className="card p-4 rundmail-hero">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* ── Titel & Status-Chips ── */}
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em] text-orange-700">Factor OPS · Verden · Produktionsplanung</div>
            <h2 className="text-2xl font-black text-slate-900 tracking-tight mt-0.5">Tägliche Produktions-Rundmail</h2>
            <p className={`text-xs mt-1 ${sourceLabel.startsWith("⚠") ? "text-red-600 font-semibold" : "text-slate-500"}`}>{sourceLabel}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="rundmail-chip">RUN1: {run1Rows.length} WOs</span>
              <span className="rundmail-chip-soft">Completion: {completionRate}%</span>
              {weeklyPlanning ? (
                <span className="rundmail-chip-soft" title={weeklyPlanning.referenceNote}>
                  {weeklyPlanning.isReference ? "⚠ " : "✓ "}KW{weeklyPlanning.cw} geladen
                </span>
              ) : (
                <span className="rundmail-chip-soft text-slate-400">Wochenplan fehlt</span>
              )}
            </div>
          </div>

          {/* ── Button-Gruppen ── */}
          <div className="flex flex-col gap-2 shrink-0">
            {/* Gruppe 1: Daten */}
            <div className="flex flex-wrap gap-1.5">
              <button className="btn" onClick={() => fileInputRef.current?.click()}>
                📂 CSV auswählen
              </button>
              <button className="btn" onClick={() => petFileInputRef.current?.click()}>
                📂 PET CSV auswählen
              </button>
              <button className="btn" onClick={copyCurrentMail} disabled={!mailText}>
                📋 Markdown
              </button>
            </div>
            {/* Gruppe 2: Tools */}
            <div className="flex flex-wrap gap-1.5">
              <button
                className="btn text-blue-700 bg-blue-50 border-blue-200"
                onClick={() => onNavigate?.("whatif")}
              >
                📈 What-If
              </button>
              <button
                className="btn text-emerald-700 bg-emerald-50 border-emerald-200"
                onClick={() => onNavigate?.("breakdown")}
              >
                🔢 Breakdown
              </button>
            </div>
            {/* Gruppe 3: Mail-Export */}
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 self-center">Email:</span>
              <button type="button" className="btn text-rose-700 bg-rose-50 border-rose-200" onClick={() => printHtmlAsPdf(run1HtmlMail)} disabled={!run1Rows.length} title="Als PDF drucken / speichern">
                📄 KET R1 PDF
              </button>
              <button type="button" className="btn" onClick={() => downloadFile("Run1_Rundmail.html", run1HtmlMail, "text/html;charset=utf-8")} disabled={!run1Rows.length} title="HTML-Datei herunterladen (Fallback)">
                KET R1 ↓
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!run1Rows.length}
                title="HTML in Zwischenablage kopieren → in Gmail/Outlook einfügen"
                onClick={() => copyHtmlToClipboard(run1HtmlMail).then(() => showToast("✓ KET R1 kopiert! Gmail öffnen → Neue Mail → Strg+V einfügen.")).catch((e: Error) => { if (e.message !== "clipboard-fallback") showToast("⚠ Kopieren fehlgeschlagen — Fallback-Tab geöffnet."); })}
              >
                📋 KET R1 kopieren
              </button>
              <button
                type="button"
                className="btn"
                disabled={!run1Rows.length || !slackWebhookUrl}
                title={slackWebhookUrl ? "KET Run 1 Zusammenfassung an Slack senden" : "Slack Webhook URL unten eingeben"}
                onClick={() => sendToSlack(slackWebhookUrl, buildKetSlackBlocks(rows, sourceLabel, 1)).then(() => showToast("✓ KET R1 → Slack gesendet!")).catch(() => showToast("⚠ Slack-Versand fehlgeschlagen — Webhook URL prüfen."))}
              >
                📨 KET R1 → Slack
              </button>
              <button type="button" className="btn text-rose-700 bg-rose-50 border-rose-200" onClick={() => printHtmlAsPdf(run2HtmlMail)} disabled={!rows.length} title="Als PDF drucken / speichern">
                📄 KET R2 PDF
              </button>
              <button type="button" className="btn" onClick={() => downloadFile("Run2_Rundmail.html", run2HtmlMail, "text/html;charset=utf-8")} disabled={!rows.length} title="HTML-Datei herunterladen (Fallback)">
                KET R2 ↓
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!rows.length}
                title="HTML in Zwischenablage kopieren → in Gmail/Outlook einfügen"
                onClick={() => copyHtmlToClipboard(run2HtmlMail).then(() => showToast("✓ KET R2 kopiert! Gmail öffnen → Neue Mail → Strg+V einfügen.")).catch((e: Error) => { if (e.message !== "clipboard-fallback") showToast("⚠ Kopieren fehlgeschlagen — Fallback-Tab geöffnet."); })}
              >
                📋 KET R2 kopieren
              </button>
              <button
                type="button"
                className="btn"
                disabled={!rows.length || !slackWebhookUrl}
                title={slackWebhookUrl ? "KET Run 2 Zusammenfassung an Slack senden" : "Slack Webhook URL unten eingeben"}
                onClick={() => sendToSlack(slackWebhookUrl, buildKetSlackBlocks(rows, sourceLabel, 2)).then(() => showToast("✓ KET R2 → Slack gesendet!")).catch(() => showToast("⚠ Slack-Versand fehlgeschlagen — Webhook URL prüfen."))}
              >
                📨 KET R2 → Slack
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 self-center">PET:</span>
              <button type="button" className="btn text-rose-700 bg-rose-50 border-rose-200" onClick={() => printHtmlAsPdf(petRun1HtmlMail)} disabled={!petRun1Rows.length} title="Als PDF drucken / speichern">
                📄 PET R1 PDF
              </button>
              <button type="button" className="btn" onClick={() => downloadFile("PET_Run1_Plan.html", petRun1HtmlMail, "text/html;charset=utf-8")} disabled={!petRun1Rows.length} title="HTML-Datei herunterladen (Fallback)">
                PET R1 ↓
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!petRun1Rows.length}
                title="PET Plan HTML in Zwischenablage kopieren → in Gmail/Outlook einfügen"
                onClick={() => copyHtmlToClipboard(petRun1HtmlMail).then(() => showToast("✓ PET R1 kopiert! Gmail öffnen → Neue Mail → Strg+V einfügen.")).catch((e: Error) => { if (e.message !== "clipboard-fallback") showToast("⚠ Kopieren fehlgeschlagen — Fallback-Tab geöffnet."); })}
              >
                📋 PET R1 kopieren
              </button>
              <button
                type="button"
                className="btn"
                disabled={!petRun1Rows.length || !slackWebhookUrl}
                title={slackWebhookUrl ? "PET Run 1 Zusammenfassung an Slack senden" : "Slack Webhook URL unten eingeben"}
                onClick={() => sendToSlack(slackWebhookUrl, buildPetSlackBlocks(petRows, petSourceLabel, 1)).then(() => showToast("✓ PET R1 → Slack gesendet!")).catch(() => showToast("⚠ Slack-Versand fehlgeschlagen — Webhook URL prüfen."))}
              >
                📨 PET R1 → Slack
              </button>
              <button type="button" className="btn text-rose-700 bg-rose-50 border-rose-200" onClick={() => printHtmlAsPdf(petRun2HtmlMail)} disabled={!petRun2Rows.length} title="Als PDF drucken / speichern">
                📄 PET R2 PDF
              </button>
              <button type="button" className="btn" onClick={() => downloadFile("PET_Run2_Plan.html", petRun2HtmlMail, "text/html;charset=utf-8")} disabled={!petRun2Rows.length} title="HTML-Datei herunterladen (Fallback)">
                PET R2 ↓
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!petRun2Rows.length}
                title="PET Plan HTML in Zwischenablage kopieren → in Gmail/Outlook einfügen"
                onClick={() => copyHtmlToClipboard(petRun2HtmlMail).then(() => showToast("✓ PET R2 kopiert! Gmail öffnen → Neue Mail → Strg+V einfügen.")).catch((e: Error) => { if (e.message !== "clipboard-fallback") showToast("⚠ Kopieren fehlgeschlagen — Fallback-Tab geöffnet."); })}
              >
                📋 PET R2 kopieren
              </button>
              <button
                type="button"
                className="btn"
                disabled={!petRun2Rows.length || !slackWebhookUrl}
                title={slackWebhookUrl ? "PET Run 2 Zusammenfassung an Slack senden" : "Slack Webhook URL unten eingeben"}
                onClick={() => sendToSlack(slackWebhookUrl, buildPetSlackBlocks(petRows, petSourceLabel, 2)).then(() => showToast("✓ PET R2 → Slack gesendet!")).catch(() => showToast("⚠ Slack-Versand fehlgeschlagen — Webhook URL prüfen."))}
              >
                📨 PET R2 → Slack
              </button>
            </div>
            {/* Gruppe 4: Präsentation PDF */}
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-500 self-center">Präsi:</span>
              <button
                type="button"
                className="btn text-violet-700 bg-violet-50 border-violet-200 font-bold"
                disabled={!run1Rows.length}
                title="KET Run 1 als saubere Präsentations-PDF öffnen und drucken"
                onClick={() => printHtmlAsPdf(ketPraesi1Html)}
              >
                📊 KET R1 Präsi
              </button>
              <button
                type="button"
                className="btn text-violet-700 bg-violet-50 border-violet-200 font-bold"
                disabled={!rows.length}
                title="KET Run 2 als saubere Präsentations-PDF öffnen und drucken"
                onClick={() => printHtmlAsPdf(ketPraesi2Html)}
              >
                📊 KET R2 Präsi
              </button>
              <button
                type="button"
                className="btn text-indigo-700 bg-indigo-50 border-indigo-200 font-bold"
                disabled={!petRun1Rows.length}
                title="PET Run 1 als saubere Präsentations-PDF öffnen und drucken (inkl. Plating-Anweisungen & Packschema)"
                onClick={() => printHtmlAsPdf(petPraesi1Html)}
              >
                📊 PET R1 Präsi
              </button>
              <button
                type="button"
                className="btn text-indigo-700 bg-indigo-50 border-indigo-200 font-bold"
                disabled={!petRun2Rows.length}
                title="PET Run 2 als saubere Präsentations-PDF öffnen und drucken (inkl. Plating-Anweisungen & Packschema)"
                onClick={() => printHtmlAsPdf(petPraesi2Html)}
              >
                📊 PET R2 Präsi
              </button>
            </div>
            {/* Gruppe 5: Slack Webhook Konfiguration */}
            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-200">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">🔗 Slack Webhook:</span>
              <input
                type="url"
                title="Slack Incoming Webhook URL"
                placeholder="https://hooks.slack.com/services/..."
                className="flex-1 min-w-[220px] rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-sky-400"
                value={slackWebhookInput}
                onChange={(e) => setSlackWebhookInput(e.target.value)}
              />
              <button
                type="button"
                className="btn text-sky-700 bg-sky-50 border-sky-200"
                onClick={() => {
                  localStorage.setItem("slackWebhookUrl", slackWebhookInput);
                  setSlackWebhookUrl(slackWebhookInput);
                  showToast(slackWebhookInput ? "✓ Slack Webhook gespeichert." : "Slack Webhook entfernt.");
                }}
              >
                Speichern
              </button>
              {slackWebhookUrl && <span className="text-[10px] text-emerald-600 font-semibold">✓ aktiv</span>}
            </div>
          </div>
        </div>
        <input title="KET CSV hochladen" ref={fileInputRef} className="hidden" type="file" accept=".csv,text/csv" onChange={(event) => onFileSelected(event.target.files?.[0] ?? null)} />
        <input title="PET CSV hochladen" ref={petFileInputRef} className="hidden" type="file" accept=".csv,text/csv" onChange={(event) => onPetFileSelected(event.target.files?.[0] ?? null)} />

        <div
          className={`mt-3 rounded-xl border-2 border-dashed p-4 text-sm transition-colors ${
            isDragging ? "border-cyan-500 bg-cyan-50 text-cyan-900" : "border-slate-300 bg-slate-50 text-slate-600"
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
        >
          CSV per Drag-and-Drop hier ablegen. Danach wird die RUN1 Rundmail automatisch erzeugt.
        </div>

        <div className="mt-2 text-xs text-slate-500">
          PET-Quelle: <span className="font-semibold text-slate-700">{petSourceLabel}</span>
        </div>

        {/* ── Plating-Anweisungen & Packschema-Editor ── */}
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50">
          <button
            type="button"
            className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-semibold text-emerald-900 hover:bg-emerald-100 rounded-xl transition-colors"
            onClick={() => setPlatingEditorOpen((v) => !v)}
          >
            <span>📋 Plating-Anweisungen &amp; Packschema ({Object.keys(platingNotes).length} gespeichert)</span>
            <span className="text-emerald-600">{platingEditorOpen ? "▲" : "▼"}</span>
          </button>
          {platingEditorOpen && (
            <div className="px-4 pb-4">
              <p className="text-[11px] text-emerald-700 mb-3">
                Anweisungen und Packschema-Bilder werden pro Rezept-Code gespeichert und erscheinen automatisch im PET-PDF-Ausdruck.
                Bilder kannst du einfach per Datei-Upload hinzufügen — sie werden lokal im Browser gespeichert.
              </p>
              {/* Neu-Hinzufügen für Rezept-Codes die nicht im PET sind */}
              {(() => {
                const petCodes = Array.from(new Set(petRows.map((r) => extractMealCode(r.recipeName)))).filter(Boolean).sort();
                const allCodes = Array.from(new Set([...petCodes, ...Object.keys(platingNotes)])).sort();
                return allCodes.map((code) => {
                  const note = platingNotes[code] ?? { instruction: "" };
                  const recipeRow = petRows.find((r) => extractMealCode(r.recipeName) === code);
                  const displayName = recipeRow
                    ? recipeRow.recipeName.replace(/\s*\[.*?\]/g, "").replace(/^FV\d{4}[A-Z]\s*-\s*/i, "").trim()
                    : "";
                  return (
                    <div key={code} className="mb-3 rounded-lg border border-emerald-200 bg-white p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <span className="font-mono text-xs font-bold text-emerald-800">{code}</span>
                          {displayName && <span className="ml-2 text-xs text-slate-500">{displayName}</span>}
                        </div>
                        {note.packSchemaImageDataUrl && (
                          <button
                            type="button"
                            className="text-[10px] text-rose-500 hover:text-rose-700"
                            onClick={() => {
                              const updated = { ...platingNotes, [code]: { ...note, packSchemaImageDataUrl: undefined } };
                              setPlatingNotes(updated);
                              savePlatingNotes(updated);
                            }}
                          >
                            Bild entfernen
                          </button>
                        )}
                      </div>
                      <textarea
                        title={`Plating-Anweisung für ${code}`}
                        placeholder="Plating-Anweisung eingeben (z.B. Sauce links, Protein rechts, Garnitur oben)…"
                        rows={2}
                        className="w-full rounded border border-slate-300 px-2 py-1.5 text-xs text-slate-800 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-400"
                        value={note.instruction}
                        onChange={(e) => {
                          const updated = { ...platingNotes, [code]: { ...note, instruction: e.target.value } };
                          setPlatingNotes(updated);
                          savePlatingNotes(updated);
                        }}
                      />
                      <div className="mt-2 flex items-center gap-2">
                        {note.packSchemaImageDataUrl ? (
                          <img
                            src={note.packSchemaImageDataUrl}
                            alt={`Packschema ${code}`}
                            className="h-16 w-auto rounded border border-slate-200 object-contain cursor-pointer"
                            onClick={() => {
                              setPlatingImageTargetCode(code);
                              platingImageInputRef.current?.click();
                            }}
                          />
                        ) : (
                          <button
                            type="button"
                            className="btn text-[11px] py-1"
                            onClick={() => {
                              setPlatingImageTargetCode(code);
                              platingImageInputRef.current?.click();
                            }}
                          >
                            🖼 Packschema-Bild hochladen
                          </button>
                        )}
                        {!petCodes.includes(code) && (
                          <button
                            type="button"
                            className="text-[10px] text-slate-400 hover:text-rose-500 ml-auto"
                            onClick={() => {
                              const { [code]: _removed, ...rest } = platingNotes;
                              setPlatingNotes(rest);
                              savePlatingNotes(rest);
                            }}
                          >
                            Eintrag löschen
                          </button>
                        )}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>
        <input
          ref={platingImageInputRef}
          type="file"
          accept="image/*"
          title="Packschema-Bild hochladen"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file || !platingImageTargetCode) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
              const dataUrl = ev.target?.result as string;
              if (!dataUrl) return;
              const img = new Image();
              img.onload = () => {
                const maxDim = 600;
                const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext("2d");
                if (!ctx) return;
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const compressed = canvas.toDataURL("image/jpeg", 0.82);
                setPlatingNotes((prev) => {
                  const updated = { ...prev, [platingImageTargetCode]: { ...(prev[platingImageTargetCode] ?? { instruction: "" }), packSchemaImageDataUrl: compressed } };
                  savePlatingNotes(updated);
                  return updated;
                });
              };
              img.src = dataUrl;
            };
            reader.readAsDataURL(file);
            e.target.value = "";
          }}
        />

        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
            <span>RUN1 Fertigstellungsquote (Cooked zu Target)</span>
            <span className="font-semibold text-slate-900">{completionRate}%</span>
          </div>
          <div className="h-2 rounded-full bg-white/70 ring-1 ring-slate-200 overflow-hidden">
            <div className="h-full rundmail-progress" style={{ width: `${completionRate}%` }} />
          </div>
        </div>
      </section>

      <section className="card p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 mb-2">RUN1 Timeline</div>
        <div className="grid gap-2 grid-cols-1 md:grid-cols-2 xl:grid-cols-4">
          {dayCards.map((card) => (
            <button
              key={card.day}
              onClick={() => setSelectedDays((prev) => {
                const next = new Set(prev);
                if (next.has(card.day)) next.delete(card.day); else next.add(card.day);
                return next;
              })}
              className={`text-left rounded-xl p-3 ring-1 transition-all hover:-translate-y-0.5 ${
                selectedDays.has(card.day)
                  ? "bg-slate-900 text-white ring-slate-800 shadow-lg"
                  : "bg-gradient-to-br from-white to-slate-50 ring-slate-200 text-slate-800"
              }`}
            >
              <div className="text-[11px] uppercase tracking-wide opacity-80">{card.day}</div>
              <div className="mt-1 text-xl font-bold">{fmtInt(card.open)}</div>
              <div className="text-[11px] opacity-80">Offen</div>
              <div className="mt-2 text-[11px] opacity-80">{card.count} RUN1 WOs · Target {fmtInt(card.target)}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Tag / Date Needed</div>
            <div className="flex flex-wrap gap-1.5">
              <button
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 transition-colors ${
                  selectedDays.size === days.length
                    ? "bg-slate-900 text-white ring-slate-800"
                    : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50"
                }`}
                onClick={() => setSelectedDays(new Set(days))}
              >
                Alle
              </button>
              {days.map((day) => (
                <button
                  key={day}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ring-1 transition-colors ${
                    selectedDays.has(day)
                      ? "bg-slate-900 text-white ring-slate-800"
                      : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50"
                  }`}
                  onClick={() => setSelectedDays((prev) => {
                    const next = new Set(prev);
                    if (next.has(day)) next.delete(day); else next.add(day);
                    return next;
                  })}
                >
                  {day} <span className="opacity-60">({rowsByDay.get(day)?.length ?? 0})</span>
                </button>
              ))}
            </div>
          </div>

          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Kitchen Status
            <select
              className="mt-1 block min-w-[12rem] rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-2 py-2 text-sm"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            >
              <option value="all">Alle</option>
              {kitchenStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 flex-1 min-w-[16rem]">
            Suche
            <input
              className="mt-1 w-full rounded-lg border-slate-300 ring-1 ring-slate-300 bg-white px-3 py-2 text-sm"
              placeholder="WO, Rezept, Sub-Rezept, Kommentar"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </label>
        </div>

        <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <div className="rounded-xl bg-gradient-to-br from-slate-50 to-white ring-1 ring-slate-200 p-3">
            <div className="text-xs text-slate-500">Target Portions</div>
            <div className="text-2xl font-bold text-slate-900">{fmtInt(summary.target)}</div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-emerald-50 to-white ring-1 ring-emerald-200 p-3">
            <div className="text-xs text-slate-500">Cooked Portions</div>
            <div className="text-2xl font-bold text-emerald-700">{fmtInt(summary.cooked)}</div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-amber-50 to-white ring-1 ring-amber-200 p-3">
            <div className="text-xs text-amber-700">Offen (Defizit)</div>
            <div className="text-2xl font-bold text-amber-800">{fmtInt(summary.open)}</div>
          </div>
          <div className="rounded-xl bg-gradient-to-br from-cyan-50 to-white ring-1 ring-cyan-200 p-3">
            <div className="text-xs text-cyan-700">Minimum Needs</div>
            <div className="text-2xl font-bold text-cyan-900">{fmtInt(summary.minNeeds)}</div>
          </div>
        </div>

        <div className="mt-3 rounded-xl bg-gradient-to-br from-indigo-50 to-white ring-1 ring-indigo-200 p-3">
          <div className="text-xs text-indigo-700">Batches gesamt (sichtbare Zeilen)</div>
          <div className="text-2xl font-bold text-indigo-800">
            {fmtInt(visibleRows.reduce((sum, row) => sum + (row.batchesNeeded ?? 0), 0))}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 xl:grid-cols-2 gap-3">
          <div className="rounded-xl bg-slate-50 ring-1 ring-slate-200 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 mb-2">Status-Verteilung</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(selectedDayStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <span key={status} className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${statusTone(status)}`}>
                    {status}: {count}
                  </span>
                ))}
            </div>
          </div>

          <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 p-3">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-rose-700 mb-2">Top-Defizite des Tages</div>
            <div className="space-y-1.5">
              {selectedDayTopDeficits.length ? selectedDayTopDeficits.map(({ row, deficit }) => (
                <div key={row.id} className="flex items-start justify-between gap-3 rounded-lg bg-white/80 ring-1 ring-rose-100 px-2 py-1.5 text-xs">
                  <div>
                    <div className="font-semibold text-slate-800">WO {row.workOrderNumber}</div>
                    <div className="text-slate-600 line-clamp-1">{row.subRecipeName}</div>
                  </div>
                  <div className="font-bold text-rose-700">-{fmtInt(deficit)}</div>
                </div>
              )) : <div className="text-xs text-slate-600">Keine offenen Defizite fuer den ausgewaehlten Tag.</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-100 text-slate-700">
              <tr>
                <th className="px-2 py-2 text-left">WO</th>
                <th className="px-2 py-2 text-left">Recipe</th>
                <th className="px-2 py-2 text-left">Sub Recipe</th>
                <th className="px-2 py-2 text-right">Target</th>
                <th className="px-2 py-2 text-right">Cooked</th>
                <th className="px-2 py-2 text-right">Delta</th>
                <th className="px-2 py-2 text-right">Kitchen kg</th>
                <th className="px-2 py-2 text-right">Batch kg</th>
                <th className="px-2 py-2 text-right">Batches</th>
                <th className="px-2 py-2 text-left">Kitchen</th>
                <th className="px-2 py-2 text-left">Staging</th>
                <th className="px-2 py-2 text-left">ETA</th>
                <th className="px-2 py-2 text-left">Kommentar</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const delta = row.woCookedPortions - row.targetPortions;
                return (
                  <tr key={row.id} className="border-t border-slate-100 align-top">
                    <td className="px-2 py-2 whitespace-nowrap font-medium text-slate-800">{row.workOrderNumber}</td>
                    <td className="px-2 py-2 text-slate-700">{row.recipeName}</td>
                    <td className="px-2 py-2 text-slate-700">{row.subRecipeName}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{fmtInt(row.targetPortions)}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{fmtInt(row.woCookedPortions)}</td>
                    <td className={`px-2 py-2 text-right font-semibold ${delta < 0 ? "text-amber-700" : "text-emerald-700"}`}>
                      {fmtInt(delta)}
                    </td>
                    <td className="px-2 py-2 text-right text-slate-700">{row.kitchenKg != null ? fmtInt(row.kitchenKg) : "-"}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{row.batchSizeKg != null ? fmtInt(row.batchSizeKg) : "-"}</td>
                    <td className="px-2 py-2 text-right font-semibold text-indigo-700">{row.batchesNeeded != null ? fmtInt(row.batchesNeeded) : "-"}</td>
                    <td className="px-2 py-2 min-w-[10rem]">
                      <input
                        title="Kitchen Status"
                        placeholder="Kitchen Status"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                        value={row.kitchenStatus}
                        onChange={(event) => updateRow(row.id, { kitchenStatus: event.target.value })}
                      />
                      <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusTone(row.kitchenStatus || "")}`}>
                        {row.kitchenStatus || "Unknown"}
                      </span>
                    </td>
                    <td className="px-2 py-2 min-w-[10rem]">
                      <input
                        title="Staging Status"
                        placeholder="Staging Status"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                        value={row.stagingStatus}
                        onChange={(event) => updateRow(row.id, { stagingStatus: event.target.value })}
                      />
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-slate-600">{row.unlockedEta || "-"}</td>
                    <td className="px-2 py-2 min-w-[15rem]">
                      <input
                        title="Work Order Comment"
                        placeholder="Kommentar…"
                        className="w-full rounded border border-slate-300 px-2 py-1"
                        value={row.workOrderComment}
                        onChange={(event) => updateRow(row.id, { workOrderComment: event.target.value })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-4 bg-gradient-to-br from-slate-950 to-slate-900 text-slate-100">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-white">Mail Vorschau (Markdown)</h3>
          <span className="text-xs text-slate-300">Markdown + Premium HTML Export bereit fuer Versand</span>
        </div>
        <textarea
          title="Mail Vorschau"
          placeholder="Mail-Inhalt wird hier angezeigt…"
          className="mt-3 w-full min-h-[18rem] rounded-lg border border-slate-700 bg-slate-900 p-3 font-mono text-xs text-slate-100"
          value={mailText}
          onChange={(event) => setMailText(event.target.value)}
        />
      </section>
    </div>
    </>
  );
}
