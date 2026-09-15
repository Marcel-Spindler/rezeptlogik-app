// Lagerbestand (Lagerplatz + MHD) für Zutaten im Staging-Dashboard.
// Nutzt fetchFullInventory (IndexedDB-Cache 10 min) — keine eigene Snowflake-
// Query, kein Netzwerk-Overhead wenn "Lager Komplett" schon geöffnet war.
//
// Zwei Maps werden gleichzeitig aufgebaut:
//  stockMap    → echte Kühlhaus-Regalplätze (A-01-04-1 etc.)  → für Stapler
//  stagingMap  → Staging-/Prozessbereiche (DEBOXWIP etc.)     → nur zur Info
import { useEffect, useRef, useState } from "react";
import { fetchFullInventory } from "../wms-overview/wmsFetch";
import type { FullInventoryRow } from "../wms-overview/wmsTypes";

export interface StockLocation {
  locationId: string;
  itemNumber: string;
  description: string;
  uom: string;
  actualQty: number | null;
  lotNumber: string;
  fifoDate: string | null;
  expirationDate: string | null;
  status: string;
}

export type IngredientStockMap = Record<string, StockLocation[]>;

// Nur echte Kühlhaus-Regalplätze — Format: Buchstabe-2Ziffern-2Ziffern-Ziffer(n)
// z.B. A-01-04-1 oder D-06-39-3. Alles andere (PROTEIN, BULKLIQUID, DEBOXWIP,
// LOST, PS WIP …) ist ein Prozessbereich — nicht für den Stapler geeignet.
const RACK_LOCATION = /^[A-Za-z]-\d{2}-\d{2}-\d+$/;

function isRealStorageLocation(locationId: string): boolean {
  return RACK_LOCATION.test(locationId.trim());
}

// Bedeutungslose Präfixe entfernen bevor Wörter extrahiert werden.
// "FA-DE", "FA-GB" etc. sind Land-Codes und stehen in beiden Quellen unterschiedlich.
const STRIP_PREFIX = /^(?:FA-[A-Z]{2}|MAT-[A-Z-]*\d+)\s*/i;

function toWords(s: string): string[] {
  return s.replace(STRIP_PREFIX, "").toLowerCase()
    .replace(/[/(),\-]/g, " ").split(/\s+/)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w)); // keine reinen Zahlen
}

function partialMatch(descWords: string[], ingWords: string[]): boolean {
  if (descWords.length === 0 || ingWords.length === 0) return false;
  const [shorter, longer] = ingWords.length <= descWords.length
    ? [ingWords, descWords]
    : [descWords, ingWords];
  let hits = 0;
  for (const w of shorter) {
    if (longer.some(lw => lw === w || lw.startsWith(w) || w.startsWith(lw))) hits++;
  }
  // 60% Treffer reichen — Zutaten-Namen sind oft länger als WMS-Beschreibungen
  return hits >= Math.max(1, Math.ceil(shorter.length * 0.6));
}

// Zweisprachige Zutaten-Namen (vor / nach "/") werden separat gegen die
// WMS-Beschreibung geprüft. "FA-DE Onion ... / Zwiebel ..." → beide Seiten testen.
function namesMatch(description: string, ingredientName: string): boolean {
  const descWords = toWords(description);
  const parts = ingredientName.split("/").map(p => p.trim());
  return parts.some(part => partialMatch(descWords, toWords(part)));
}

function sortByMhd(locs: StockLocation[]): StockLocation[] {
  return locs.sort((a, b) => {
    if (!a.expirationDate && !b.expirationDate) return 0;
    if (!a.expirationDate) return 1;
    if (!b.expirationDate) return -1;
    return a.expirationDate.localeCompare(b.expirationDate);
  });
}

function toStockLocation(row: FullInventoryRow): StockLocation {
  return {
    locationId: row.locationId,
    itemNumber: row.itemNumber,
    description: row.description ?? "",
    uom: "",
    actualQty: row.actualQty,
    lotNumber: row.lotNumber,
    fifoDate: row.fifoDate ?? null,
    expirationDate: row.expirationDate,
    status: row.status,
  };
}

function buildMapsFromInventory(rows: FullInventoryRow[]): {
  rackMap: IngredientStockMap;
  stagingMap: IngredientStockMap;
} {
  const rackMap: IngredientStockMap = {};
  const stagingMap: IngredientStockMap = {};
  for (const row of rows) {
    if (!row.description) continue;
    if ((row.actualQty ?? 0) <= 0) continue;
    const key = row.description;
    const loc = toStockLocation(row);
    if (isRealStorageLocation(row.locationId)) {
      if (!rackMap[key]) rackMap[key] = [];
      rackMap[key].push(loc);
    } else {
      if (!stagingMap[key]) stagingMap[key] = [];
      stagingMap[key].push(loc);
    }
  }
  for (const locs of Object.values(rackMap)) sortByMhd(locs);
  for (const locs of Object.values(stagingMap)) sortByMhd(locs);
  return { rackMap, stagingMap };
}

/** Echte Kühlhaus-Regalplätze (A-01-04-1 etc.), sortiert nach MHD ASC = FEFO. */
export function findStockForIngredient(stockMap: IngredientStockMap, ingredientName: string): StockLocation[] {
  const result: StockLocation[] = [];
  for (const [desc, locs] of Object.entries(stockMap)) {
    if (namesMatch(desc, ingredientName)) result.push(...locs);
  }
  return sortByMhd(result);
}

/** Staging-/Prozessbereiche (DEBOXWIP etc.) — schon abgelegt, trotzdem anfahrbar. */
export function findStagingStockForIngredient(stagingMap: IngredientStockMap, ingredientName: string): StockLocation[] {
  const result: StockLocation[] = [];
  for (const [desc, locs] of Object.entries(stagingMap)) {
    if (namesMatch(desc, ingredientName)) result.push(...locs);
  }
  return result;
}

// Modul-Level-Cache — überlebt Re-Mounts, teilen alle Hook-Instanzen
const MAP_TTL_MS = 10 * 60 * 1000;
let cachedMaps: { rackMap: IngredientStockMap; stagingMap: IngredientStockMap; builtAt: number } | null = null;
let inflight: Promise<{ rackMap: IngredientStockMap; stagingMap: IngredientStockMap }> | null = null;

async function getMaps(): Promise<{ rackMap: IngredientStockMap; stagingMap: IngredientStockMap }> {
  if (cachedMaps && Date.now() - cachedMaps.builtAt < MAP_TTL_MS) return cachedMaps;
  if (inflight) return inflight;
  inflight = fetchFullInventory({ limit: 200_000, maxRetries: 1 })
    .then(({ rows }) => {
      const { rackMap, stagingMap } = buildMapsFromInventory(rows);
      cachedMaps = { rackMap, stagingMap, builtAt: Date.now() };
      return { rackMap, stagingMap };
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useIngredientStock(_ingredientNames: string[]): {
  stockMap: IngredientStockMap;
  stagingMap: IngredientStockMap;
  loading: boolean;
  serverAvailable: boolean;
} {
  const [stockMap, setStockMap] = useState<IngredientStockMap>(cachedMaps?.rackMap ?? {});
  const [stagingMap, setStagingMap] = useState<IngredientStockMap>(cachedMaps?.stagingMap ?? {});
  const [loading, setLoading] = useState(!cachedMaps);
  const [serverAvailable, setServerAvailable] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (cachedMaps && Date.now() - cachedMaps.builtAt < MAP_TTL_MS) {
      setStockMap(cachedMaps.rackMap);
      setStagingMap(cachedMaps.stagingMap);
      setLoading(false);
      return;
    }
    setLoading(true);
    getMaps()
      .then(({ rackMap, stagingMap: sm }) => {
        if (!mounted.current) return;
        setStockMap(rackMap);
        setStagingMap(sm);
        setServerAvailable(true);
        setLoading(false);
      })
      .catch(err => {
        if (!mounted.current) return;
        console.info("[useIngredientStock] Inventory nicht erreichbar:", (err as Error).message);
        setServerAvailable(false);
        setLoading(false);
      });
    return () => { mounted.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { stockMap, stagingMap, loading, serverAvailable };
}
