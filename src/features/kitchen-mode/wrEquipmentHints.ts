// Kitchen Mode / Breakdown – Kuechenbible/Master-GSheet Parsing: Kapazitäts-, Stück-/Tray-Hints,
// ProcessSpec- und KET-Plan-Auflösung je Kochpfad.
import type { ProcessSpec } from "../../core/types";
import type { WRCapacityHint, WRTrayHint } from "./wrEquipmentTypes";
import { parseGnType } from "./wrEquipmentTypes";
import {
  detectHeaderRow, findHeaderIndex, norm, overlapScore, PTN_ID_TRAY_SPECS, toCells, tokenize,
} from "./wrEquipmentFormat";
import { wrParseKgLoose, wrParseNumberLoose, wrParsePcs } from "./wrEquipmentCalc";

export function wrFindHeader(rows: string[][], patterns: RegExp[]): number {
  return detectHeaderRow(rows, patterns);
}

export function wrCol(headers: string[], patterns: RegExp[]): number {
  return findHeaderIndex(headers, patterns);
}

export function wrSheetRows(sheet: { values?: unknown[] }): string[][] {
  if (!Array.isArray(sheet.values)) return [];
  return sheet.values.map((r) => toCells(r));
}

export function wrBuildHintsFromDumps(master: unknown, bibles: unknown): {
  capacityHints: Map<string, WRCapacityHint>;
  pieceWeightKg: Map<string, number>;
  trayHints: WRTrayHint[];
} {
  const capacityHints = new Map<string, WRCapacityHint>();
  const pieceWeightKg = new Map<string, number>();
  const trayHints: WRTrayHint[] = [];

  const upsertCapacity = (name: string, capacityKg: number | null, equipment: string | null) => {
    const key = norm(name);
    if (!key || !capacityKg || capacityKg <= 0) return;
    const next: WRCapacityHint = {
      subRecipeKey: key,
      subRecipeName: name,
      capacityKg,
      equipment,
    };
    const existing = capacityHints.get(key);
    if (!existing || next.capacityKg < existing.capacityKg) {
      capacityHints.set(key, next);
    }
  };

  const masterSheets = Array.isArray((master as { sheets?: unknown[] })?.sheets)
    ? ((master as { sheets: Array<{ title?: string; values?: unknown[] }> }).sheets)
    : [];

  for (const sheet of masterSheets) {
    const title = String(sheet.title ?? "");
    const rows = wrSheetRows(sheet);
    if (/bd_master|breakdown_sup|bd_supervisors/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 40), [/sub\s*recipe/i, /bible\s*ref/i, /kg/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const subIdx = wrCol(headers, [/sub\s*recipe/i]);
        const subSubIdx = wrCol(headers, [/sub\s*-?sub\s*recipe/i]);
        const totalIdx = wrCol(headers, [/total\s*size.*kg/i]);
        const refIdx = wrCol(headers, [/bible\s*ref/i]);
        const breakdownIdx = wrCol(headers, [/batch\s*breakdown.*kg/i]);
        const areaIdx = wrCol(headers, [/area\s*associated/i, /^area/i]);
        if (subIdx >= 0 || subSubIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            const sub = (subIdx >= 0 ? row[subIdx] : "") || (subSubIdx >= 0 ? row[subSubIdx] : "");
            const subKey = norm(sub);
            if (!subKey) continue;
            const refKg = refIdx >= 0 ? wrParseKgLoose(row[refIdx]) : null;
            const totalKg = totalIdx >= 0 ? wrParseKgLoose(row[totalIdx]) : null;
            const breakdownKg = breakdownIdx >= 0 ? wrParseKgLoose(row[breakdownIdx]) : null;
            const capacityKg = refKg ?? breakdownKg ?? totalKg;
            const equipment = areaIdx >= 0 ? (row[areaIdx] || null) : null;
            upsertCapacity(sub, capacityKg, equipment);
          }
        }
      }
    }

    if (/^bible$/i.test(title.trim())) {
      const headerIdx = wrFindHeader(rows.slice(0, 20), [/sku/i, /gewicht|weight/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const skuIdx = wrCol(headers, [/sku/i]);
        const wIdx = wrCol(headers, [/gewicht|weight/i]);
        if (skuIdx >= 0 && wIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            const skuRaw = row[skuIdx] ?? "";
            const skuKey = norm(skuRaw);
            if (!skuKey) continue;
            const grams = wrParseNumberLoose(row[wIdx]);
            if (!grams || grams <= 0) continue;
            const kg = grams / 1000;
            pieceWeightKg.set(skuKey, kg);
            const shortLabel = norm(String(skuRaw).split("/")[0]);
            if (shortLabel && !pieceWeightKg.has(shortLabel)) pieceWeightKg.set(shortLabel, kg);
          }
        }
      }
    }

    if (/middle-kitchen/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 30), [/sku\s*subrecipes/i, /max\s*capacity.*kg/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const skuIdx = wrCol(headers, [/sku\s*subrecipes/i]);
        const capIdx = wrCol(headers, [/max\s*capacity.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            upsertCapacity(row[skuIdx] ?? "", wrParseKgLoose(row[capIdx]), "MIDDLE-KITCHEN");
          }
        }
      }
    }

    if (/braiser/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 30), [/subrecipe\s*sku/i, /max\s*raw.*kg/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const skuIdx = wrCol(headers, [/subrecipe\s*sku/i]);
        const capIdx = wrCol(headers, [/max\s*raw.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            upsertCapacity(row[skuIdx] ?? "", wrParseKgLoose(row[capIdx]), "BRAISER");
          }
        }
      }
    }
  }

  const bibleSheets = Array.isArray((bibles as { sheets?: unknown[] })?.sheets)
    ? ((bibles as { sheets: Array<{ title?: string; values?: unknown[] }> }).sheets)
    : [];

  for (const sheet of bibleSheets) {
    const title = String(sheet.title ?? "");
    const rows = wrSheetRows(sheet);
    if (/protein-debox/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 30), [/protein\s*type/i, /cut/i, /est\.?\s*pieces/i, /tray\s*spec/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const proteinIdx = wrCol(headers, [/protein\s*type/i]);
        const cutIdx = wrCol(headers, [/^cut/i]);
        const trayIdx = wrCol(headers, [/tray\s*spec/i]);
        const piecesIdx = wrCol(headers, [/est\.?\s*pieces/i]);
        const weightIdx = wrCol(headers, [/weight.*kg/i]);
        for (let i = headerIdx + 1; i < rows.length; i += 1) {
          const row = rows[i];
          const cut = cutIdx >= 0 ? String(row[cutIdx] ?? "").trim() : "";
          const protein = proteinIdx >= 0 ? String(row[proteinIdx] ?? "").trim() : "";
          const label = cut || protein;
          if (!label) continue;

          const pieces = piecesIdx >= 0 ? wrParseNumberLoose(row[piecesIdx]) : null;
          const traySpecRaw = trayIdx >= 0 ? String(row[trayIdx] ?? "").trim() : "";
          const pcsFromTray = traySpecRaw ? wrParsePcs(traySpecRaw) : null;
          const gnFromTray = traySpecRaw ? parseGnType(traySpecRaw) : null;
          const trayPcs = pcsFromTray ?? pieces;
          if (trayPcs && trayPcs > 0) {
            const hint: WRTrayHint = { key: norm(label), pcsPerTray: trayPcs };
            if (gnFromTray) hint.gnType = gnFromTray;
            trayHints.push(hint);
            if (protein && cut) {
              const hint2: WRTrayHint = { key: norm(`${protein} ${cut}`), pcsPerTray: trayPcs };
              if (gnFromTray) hint2.gnType = gnFromTray;
              trayHints.push(hint2);
            }
          }

          const rowWeight = weightIdx >= 0 ? wrParseKgLoose(row[weightIdx]) : null;
          if (rowWeight && pieces && pieces > 0) {
            pieceWeightKg.set(norm(label), rowWeight / pieces);
          }
        }
      }
      continue;
    }

    if (/veggie-debox/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 30), [/item_/i, /capacity\s*wanne/i, /kg\s*product.*gn/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const itemIdx = wrCol(headers, [/item_/i]);
        const capIdx = wrCol(headers, [/capacity\s*wanne/i]);
        const kgPerGnIdx = wrCol(headers, [/kg\s*product.*gn/i]);
        const trayCntIdx = wrCol(headers, [/max\.?\s*tray/i]);
        for (let i = headerIdx + 1; i < rows.length; i += 1) {
          const row = rows[i];
          const item = itemIdx >= 0 ? String(row[itemIdx] ?? "").trim() : "";
          if (!item) continue;
          upsertCapacity(item, capIdx >= 0 ? wrParseKgLoose(row[capIdx]) : null, "VEGGIE-DEBOX");
          const trayPcs = trayCntIdx >= 0 ? wrParseNumberLoose(row[trayCntIdx]) : null;
          if (trayPcs && trayPcs > 0) trayHints.push({ key: norm(item), pcsPerTray: trayPcs, gnType: "GN 2/1" });
          const kgPerGn = kgPerGnIdx >= 0 ? wrParseKgLoose(row[kgPerGnIdx]) : null;
          if (kgPerGn && kgPerGn > 0) pieceWeightKg.set(norm(item), kgPerGn);
        }
      }
      continue;
    }

    if (/braiser\s*bible/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 20), [/subrecipe\s*sku/i, /max\s*raw.*kg/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const catIdx = wrCol(headers, [/^category/i]);
        const skuIdx = wrCol(headers, [/subrecipe\s*sku/i]);
        const capIdx = wrCol(headers, [/max\s*raw.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            const sku = String(row[skuIdx] ?? "").trim();
            const cap = wrParseKgLoose(row[capIdx]);
            // Register specific sub-recipe SKU if it's not just a dash placeholder
            const nameToUse = sku && sku !== "-" ? sku : catIdx >= 0 ? String(row[catIdx] ?? "").trim() : "";
            upsertCapacity(nameToUse, cap, "BRAISER");
            // Also register category as a separate fuzzy-matchable key
            if (catIdx >= 0) {
              const cat = String(row[catIdx] ?? "").trim();
              if (cat && cat !== nameToUse) upsertCapacity(cat, cap, "BRAISER");
            }
          }
        }
      }
      continue;
    }

    if (/middle-kitchen\s*bible/i.test(title)) {
      const headerIdx = wrFindHeader(rows.slice(0, 20), [/sku\s*subrecipes/i, /max\s*capacity.*kg/i]);
      if (headerIdx >= 0 && rows[headerIdx]) {
        const headers = rows[headerIdx];
        const skuIdx = wrCol(headers, [/sku\s*subrecipes/i]);
        const capIdx = wrCol(headers, [/max\s*capacity.*kg/i]);
        if (skuIdx >= 0 && capIdx >= 0) {
          for (let i = headerIdx + 1; i < rows.length; i += 1) {
            const row = rows[i];
            upsertCapacity(row[skuIdx] ?? "", wrParseKgLoose(row[capIdx]), "MIDDLE-KITCHEN");
          }
        }
      }
    }
  }

  return { capacityHints, pieceWeightKg, trayHints };
}

export function wrResolveCapacityHint(map: Map<string, WRCapacityHint>, sub1: string, sub2: string, sub3: string): WRCapacityHint | null {
  const keys = [norm(sub3), norm(sub2), norm(sub1)].filter(Boolean);
  for (const key of keys) {
    const direct = map.get(key);
    if (direct) return direct;
  }

  let bestHint: WRCapacityHint | null = null;
  let bestScore = 0;
  for (const key of keys) {
    for (const hint of map.values()) {
      const score = overlapScore(key, hint.subRecipeKey);
      if (score > bestScore) {
        bestScore = score;
        bestHint = hint;
      }
    }
  }

  return bestHint && bestScore >= 0.45 ? bestHint : null;
}

export function wrResolveProcessSpecHint(
  processSpecs: Record<string, ProcessSpec> | undefined,
  sub1: string,
  sub2: string,
  sub3: string,
): { batchSizeKg: number | null; equipment: string | null } {
  if (!processSpecs) return { batchSizeKg: null, equipment: null };
  const keys = [norm(sub3), norm(sub2), norm(sub1)].filter(Boolean);
  if (keys.length === 0) return { batchSizeKg: null, equipment: null };

  for (const key of keys) {
    for (const spec of Object.values(processSpecs)) {
      if (!spec?.name) continue;
      if (norm(spec.name) !== key) continue;
      const batchSizeKg = spec.batchSizeKg && spec.batchSizeKg > 0 ? spec.batchSizeKg : null;
      return { batchSizeKg, equipment: spec.primaryStation ?? null };
    }
  }

  let bestSpec: ProcessSpec | null = null;
  let bestScore = 0;
  for (const spec of Object.values(processSpecs)) {
    if (!spec?.name) continue;
    const specKey = norm(spec.name);
    if (!specKey) continue;
    for (const key of keys) {
      const score = overlapScore(key, specKey);
      if (score > bestScore) {
        bestScore = score;
        bestSpec = spec;
      }
    }
  }

  if (!bestSpec || bestScore < 0.5) return { batchSizeKg: null, equipment: null };
  return {
    batchSizeKg: bestSpec.batchSizeKg && bestSpec.batchSizeKg > 0 ? bestSpec.batchSizeKg : null,
    equipment: bestSpec.primaryStation ?? null,
  };
}

export function wrResolveKetPlanForPath(
  lookup: Map<string, { kitchenKg: number; batchSizeKg: number; batches: number }>,
  recipeCode: string,
  subRecipeName: string,
): { kitchenKg: number; batchSizeKg: number; batches: number } | null {
  const recipeKey = recipeCode.trim().toUpperCase();
  const subKey = norm(subRecipeName);
  if (!recipeKey || !subKey) return null;

  const exact = lookup.get(`${recipeKey}::${subKey}`);
  if (exact) return exact;

  let best: { kitchenKg: number; batchSizeKg: number; batches: number } | null = null;
  let bestScore = 0;
  const prefix = `${recipeKey}::`;
  for (const [key, value] of lookup.entries()) {
    if (!key.startsWith(prefix)) continue;
    const lookupSub = key.substring(prefix.length);
    const score = overlapScore(subKey, lookupSub);
    if (score > bestScore) {
      bestScore = score;
      best = value;
    }
  }

  return best && bestScore >= 0.45 ? best : null;
}

export function wrLookupPieceKg(pieceMap: Map<string, number>, ingredientName: string, ingredientId: string): number | null {
  // ID-based lookup first (most reliable)
  if (ingredientId && PTN_ID_TRAY_SPECS[ingredientId]) return PTN_ID_TRAY_SPECS[ingredientId].pieceKg;
  const keys = [norm(ingredientName), norm(ingredientId), norm(String(ingredientName).split("/")[0])].filter(Boolean);
  for (const key of keys) {
    const direct = pieceMap.get(key);
    if (direct) return direct;
  }
  for (const key of keys) {
    for (const [k, v] of pieceMap) {
      if (k.includes(key) || key.includes(k)) return v;
    }
  }
  return null;
}

export function wrLookupTrayPcs(trayHints: WRTrayHint[], ingredientName: string, ingredientId?: string): number | null {
  // ID-based lookup: exact match, no fuzzy logic needed
  if (ingredientId && PTN_ID_TRAY_SPECS[ingredientId]) return PTN_ID_TRAY_SPECS[ingredientId].pcsPerTray;
  const keyTokens = new Set(tokenize(ingredientName));
  if (keyTokens.size === 0) return null;
  // Containment match: all hint tokens must appear in the ingredient name.
  // Prefer the most-specific hint (most tokens) to avoid "breast" beating "chicken breast".
  let best: { hintSize: number; pcs: number } | null = null;
  for (const hint of trayHints) {
    const hintTokens = new Set(tokenize(hint.key));
    if (hintTokens.size === 0) continue;
    let overlap = 0;
    for (const t of hintTokens) { if (keyTokens.has(t)) overlap++; }
    if (overlap < hintTokens.size) continue; // require 100% containment
    if (!best || hintTokens.size > best.hintSize) best = { hintSize: hintTokens.size, pcs: hint.pcsPerTray };
  }
  return best ? best.pcs : null;
}

