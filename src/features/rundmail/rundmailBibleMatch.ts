// Rundmail – Kuechenbible/Master-GSheet Header-Erkennung und Batch-Kapazitäts-Matching.
import type { ProcessSpec, WorkOrderEntry } from "../../core/types";
import type { BatchHint, RundmailRow } from "./rundmailTypes";
import { normalizeText, overlapScore, parseFloatSafe, toCells } from "./rundmailFormat";

export function detectHeaderRow(rows: string[][], expected: RegExp[]): number {
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

export function findHeaderIndex(headers: string[], candidates: RegExp[]): number {
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i].toLowerCase();
    if (candidates.some((regex) => regex.test(header))) return i;
  }
  return -1;
}

export function parseBibleBatchHints(master: unknown, bibles: unknown): Map<string, BatchHint> {
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

export function resolveBatchSizeKg(
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

export function resolveKitchenKgForRow(
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

