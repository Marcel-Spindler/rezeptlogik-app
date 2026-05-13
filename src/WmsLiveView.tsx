import { useEffect, useMemo, useState } from "react";
import type { DataBundle, DetailedSubRecipe, Market, WeekRecipe } from "./types";

type WmsStation = {
  station: string;
  label: string;
  status: string;
  qty: number;
  skuCount: number;
  locationCount: number;
};

type WmsItem = {
  station: string;
  stationLabel: string;
  locationId: string;
  itemNumber: string;
  itemName?: string;
  itemUom?: string;
  inventoryType?: string;
  inventoryCategory?: string;
  inventoryClass?: string;
  itemMasterStatus?: string;
  mealNumber?: string;
  shelfLife?: number | null;
  itemPrefix?: string;
  itemType?: string;
  isMeal?: boolean;
  status: string;
  qty: number;
  earliestMhd: string | null;
};

type WmsLivePayload = {
  ok: boolean;
  configured?: boolean;
  week?: string;
  generatedAt?: string;
  stations?: WmsStation[];
  items?: WmsItem[];
  error?: string;
  requiredEnv?: string[];
};

type Props = {
  data: DataBundle;
  week: string;
};

const WMS_CLIENT_CACHE_MS = 45_000;
const wmsClientCache = new Map<string, { createdAt: number; payload: WmsLivePayload }>();
const wmsClientInflight = new Map<string, Promise<{ payload: WmsLivePayload; source: "api" | "cache" | "local" }>>();

const LS_KEY = "wms-live-persisted";

function lsSave(payload: WmsLivePayload): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch {
    // localStorage voll oder nicht verfügbar — ignorieren
  }
}

function lsLoad(): WmsLivePayload | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WmsLivePayload;
  } catch {
    return null;
  }
}

type SkuIntel = {
  sku: string;
  name: string;
  source: "recipe" | "structure" | "shelf-life" | "bom" | "wms";
  category?: string;
};

type EnrichedItem = WmsItem & {
  sku: string;
  name: string;
  source: SkuIntel["source"];
  category?: string;
  mhdDate: Date | null;
  daysToMhd: number | null;
  mhdRisk: "expired" | "today" | "soon" | "ok" | "unknown";
};

type RecipeContext = {
  code: string;
  digit: string;
  recipeId: string | null;
  name: string;
  planned: number;
  row: WeekRecipe;
};

type SkuDemandLink = {
  code: string;
  name: string;
  recipeId: string | null;
  planned: number;
  requiredQty: number;
  uom: string;
  source: "gross" | "structure" | "recipe";
  path?: string;
};

type SkuDemand = {
  sku: string;
  name: string;
  requiredQty: number;
  uom: string;
  links: SkuDemandLink[];
};

const MARKET_ORDER: Market[] = ["BENL", "DKSE", "DE"];

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

function fmtCompact(n: number): string {
  return Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${Math.round(n)}%`;
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

function wmsRecipeId(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  return value.startsWith("REC-") ? value : null;
}

function recipeDigitKey(raw: string | null | undefined): string {
  const match = String(raw ?? "").toUpperCase().match(/(?:FE|FV|REC-)?(\d{4})/);
  return match?.[1] ?? "";
}

function extractRecipeRefs(raw: string | null | undefined): string[] {
  const text = String(raw ?? "").toUpperCase();
  const refs = new Set<string>();
  for (const match of text.matchAll(/\b(?:FE|FV)\s*-?\s*(\d{4})([A-Z])?\b/g)) {
    refs.add(`${match[1]}${match[2] ?? ""}`);
  }
  for (const match of text.matchAll(/\((?:FE|FV)?\s*(\d{4})([A-Z])?\)/g)) {
    refs.add(`${match[1]}${match[2] ?? ""}`);
  }
  return Array.from(refs);
}

function isProducedInVerden(r: WeekRecipe): boolean {
  const c = (r.code ?? "").toUpperCase();
  if (!(c.startsWith("FE") || c.startsWith("FV"))) return false;
  return (r.verdenVolume.BENL ?? 0) + (r.verdenVolume.DKSE ?? 0) + (r.verdenVolume.DE ?? 0) > 0;
}

function cleanName(raw: string | null | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const afterSlash = value.includes("/") ? value.split("/").slice(1).join("/").trim() : value;
  return afterSlash
    .replace(/^FA-DE\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMhd(raw: string | null): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function mhdRisk(date: Date | null): EnrichedItem["mhdRisk"] {
  if (!date) return "unknown";
  const diffDays = Math.floor((startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / 86_400_000);
  if (diffDays < 0) return "expired";
  if (diffDays === 0) return "today";
  if (diffDays <= 2) return "soon";
  return "ok";
}

function daysToMhd(date: Date | null): number | null {
  if (!date) return null;
  return Math.floor((startOfDay(date).getTime() - startOfDay(new Date()).getTime()) / 86_400_000);
}

function stationTone(station: string): string {
  if (station === "Z_BLOCKED") return "bg-rose-50 text-rose-950 ring-rose-200";
  if (station === "4_REDZONE") return "bg-indigo-50 text-indigo-950 ring-indigo-200";
  if (station === "8_LINE") return "bg-emerald-50 text-emerald-950 ring-emerald-200";
  if (station.includes("PLATING") || station.includes("POSTBLAST")) return "bg-sky-50 text-sky-950 ring-sky-200";
  if (station.includes("ASSEMBLY") || station.includes("PREP")) return "bg-violet-50 text-violet-950 ring-violet-200";
  return "bg-slate-50 text-slate-800 ring-slate-200";
}

function riskTone(risk: EnrichedItem["mhdRisk"]): string {
  if (risk === "expired" || risk === "today") return "bg-rose-50 text-rose-800 ring-rose-200";
  if (risk === "soon") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (risk === "ok") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  return "bg-slate-50 text-slate-600 ring-slate-200";
}

function sourceLabel(source: SkuIntel["source"]): string {
  if (source === "recipe") return "Rezept";
  if (source === "structure") return "Struktur";
  if (source === "shelf-life") return "Shelf-Life";
  if (source === "bom") return "BOM";
  return "WMS";
}

function itemTypeLabel(prefix: string | undefined, fallback: string | undefined): string {
  const key = String(prefix || "").toUpperCase();
  if (key === "REC") return "Recipe";
  if (key === "SUB") return "Sub-Rezept";
  if (key === "PHF") return "Fresh";
  if (key === "PTN") return "Protein";
  if (key === "CON") return "Container";
  if (key === "PCK") return "Pack";
  if (key === "SPI") return "Spice";
  if (key === "DRY") return "Dry";
  if (key === "DAI") return "Dairy";
  if (key === "PRO") return "Raw Protein";
  return fallback || key || "Unbekannt";
}

function collectStructureNames(node: DetailedSubRecipe, map: Map<string, SkuIntel>): void {
  if (node.id) {
    map.set(node.id.toUpperCase(), {
      sku: node.id.toUpperCase(),
      name: cleanName(node.name) || node.id,
      source: "structure",
      category: node.categories,
    });
  }
  for (const ingredient of node.ingredients ?? []) {
    if (!ingredient.id) continue;
    map.set(ingredient.id.toUpperCase(), {
      sku: ingredient.id.toUpperCase(),
      name: cleanName(ingredient.name) || ingredient.id,
      source: "structure",
      category: ingredient.uom,
    });
  }
  for (const child of node.subRecipes ?? []) collectStructureNames(child, map);
}

function collectStructureDemand(
  node: DetailedSubRecipe,
  volume: number,
  linkBase: Omit<SkuDemandLink, "requiredQty" | "uom" | "source" | "path">,
  add: (sku: string, name: string, link: SkuDemandLink) => void,
  parentPath = "",
): void {
  const path = parentPath ? `${parentPath} > ${cleanName(node.name) || node.name}` : cleanName(node.name) || node.name;
  if (node.id) {
    add(node.id.toUpperCase(), cleanName(node.name) || node.id, {
      ...linkBase,
      requiredQty: (node.quantity ?? 0) * volume,
      uom: node.uom || "portions",
      source: "structure",
      path,
    });
  }
  for (const ingredient of node.ingredients ?? []) {
    if (!ingredient.id) continue;
    add(ingredient.id.toUpperCase(), cleanName(ingredient.name) || ingredient.id, {
      ...linkBase,
      requiredQty: (ingredient.grossQty || ingredient.netQty || 0) * volume,
      uom: ingredient.uom || "",
      source: "structure",
      path,
    });
  }
  for (const child of node.subRecipes ?? []) collectStructureDemand(child, volume, linkBase, add, path);
}

function buildSkuIntel(data: DataBundle): Map<string, SkuIntel> {
  const map = new Map<string, SkuIntel>();

  for (const [sku, row] of Object.entries(data.shelfLifeBySku ?? {})) {
    const key = sku.toUpperCase();
    map.set(key, {
      sku: key,
      name: cleanName(row.skuName) || key,
      source: "shelf-life",
      category: row.category || row.tempCategory,
    });
  }

  for (const recipe of Object.values(data.recipes ?? {})) {
    for (const market of MARKET_ORDER) {
      for (const ingredient of recipe.grossIngredients[market] ?? []) {
        const key = ingredient.ingredientId?.toUpperCase();
        if (!key || map.has(key)) continue;
        map.set(key, {
          sku: key,
          name: cleanName(ingredient.ingredient) || key,
          source: "bom",
          category: ingredient.ingredientCategory,
        });
      }
    }
  }

  for (const [code, structure] of Object.entries(data.structures ?? {})) {
    const recipeId = structure.recipeId?.toUpperCase();
    if (recipeId) {
      map.set(recipeId, {
        sku: recipeId,
        name: `${code} - ${cleanName(structure.name) || structure.name || code}`,
        source: "recipe",
        category: "REC",
      });
    }
    for (const market of MARKET_ORDER) {
      for (const root of structure.markets[market] ?? []) collectStructureNames(root, map);
    }
  }

  return map;
}

function buildRecipeContexts(data: DataBundle, week: string): RecipeContext[] {
  return data.weekRecipes
    .filter(row => row.hfWeek === week)
    .filter(isProducedInVerden)
    .filter((row, index, all) => all.findIndex(other => other.code === row.code) === index)
    .map(row => ({
      code: row.code,
      digit: recipeDigitKey(row.code),
      recipeId: data.structures?.[row.code]?.recipeId?.toUpperCase() ?? null,
      name: row.recipeName,
      planned: row.totalVerdenVolume,
      row,
    }));
}

function buildSkuDemand(data: DataBundle, recipes: RecipeContext[], skuIntel: Map<string, SkuIntel>): Map<string, SkuDemand> {
  const out = new Map<string, SkuDemand>();
  const add = (sku: string, fallbackName: string, link: SkuDemandLink) => {
    const key = sku.toUpperCase();
    if (!key) return;
    const existing = out.get(key) ?? {
      sku: key,
      name: skuIntel.get(key)?.name ?? cleanName(fallbackName) ?? key,
      requiredQty: 0,
      uom: link.uom,
      links: [],
    };
    existing.requiredQty += link.requiredQty;
    if (!existing.uom && link.uom) existing.uom = link.uom;
    existing.links.push(link);
    out.set(key, existing);
  };

  for (const ctx of recipes) {
    const structure = data.structures?.[ctx.code];
    const recipe = data.recipes[ctx.code] || (structure?.code ? data.recipes[structure.code] : undefined);
    const linkBase = {
      code: ctx.code,
      name: ctx.name,
      recipeId: ctx.recipeId,
      planned: ctx.planned,
    };

    if (ctx.recipeId) {
      add(ctx.recipeId, ctx.name, { ...linkBase, requiredQty: ctx.planned, uom: "portions", source: "recipe" });
    }

    for (const market of MARKET_ORDER) {
      const volume = ctx.row.verdenVolume[market] ?? 0;
      if (volume <= 0) continue;
      for (const ingredient of recipe?.grossIngredients[market] ?? []) {
        if (!ingredient.ingredientId) continue;
        add(ingredient.ingredientId.toUpperCase(), ingredient.ingredient, {
          ...linkBase,
          requiredQty: (ingredient.grossQuantityPerPortion || 0) * volume,
          uom: ingredient.uom || "",
          source: "gross",
          path: [ingredient.subRecipe1, ingredient.subRecipe2, ingredient.subRecipe3].filter(Boolean).join(" > "),
        });
      }
      for (const root of structure?.markets[market] ?? []) {
        collectStructureDemand(root, volume, linkBase, add);
      }
    }
  }

  return out;
}

async function loadWmsLiveFromApi(week: string): Promise<WmsLivePayload> {
  const response = await fetch(`/api/wms-live?week=${encodeURIComponent(week)}`, { cache: "no-store" });
  const text = await response.text();
  let payload: WmsLivePayload;
  try {
    payload = JSON.parse(text) as WmsLivePayload;
  } catch {
    throw new Error("WMS API nicht erreichbar (kein JSON).");
  }
  return payload;
}

async function loadWmsLiveFromCache(): Promise<WmsLivePayload> {
  const response = await fetch(`/data/wms-live-cache.json?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Kein WMS-Cache vorhanden.");
  return response.json() as Promise<WmsLivePayload>;
}

async function loadWmsLive(week: string, forceRefresh = false): Promise<{ payload: WmsLivePayload; source: "api" | "cache" | "local" }> {
  if (!forceRefresh) {
    const cached = wmsClientCache.get(week);
    if (cached && Date.now() - cached.createdAt < WMS_CLIENT_CACHE_MS) return { payload: cached.payload, source: "api" };
  }
  const existing = wmsClientInflight.get(week);
  if (existing && !forceRefresh) return existing;

  const request: Promise<{ payload: WmsLivePayload; source: "api" | "cache" | "local" }> = (async () => {
    // 1. Live-API versuchen
    try {
      const payload = await loadWmsLiveFromApi(week);
      if (payload.ok) {
        wmsClientCache.set(week, { createdAt: Date.now(), payload });
        lsSave(payload);
        return { payload, source: "api" as const };
      }
      // API erreichbar aber Fehler (z.B. Snowflake-Auth) → trotzdem zurückgeben
      return { payload, source: "api" as const };
    } catch {
      // API nicht erreichbar → auf statischen Cache fallen
    }
    // 2. Statischer Deploy-Cache (npm run wms:sync generiert ihn)
    try {
      const payload = await loadWmsLiveFromCache();
      lsSave(payload);
      return { payload, source: "cache" as const };
    } catch {
      // Auch kein Deploy-Cache
    }
    // 3. localStorage — letzter bekannter Stand
    const persisted = lsLoad();
    if (persisted) return { payload: persisted, source: "local" as const };
    throw new Error("Keine WMS-Daten verfügbar.");
  })().finally(() => {
    wmsClientInflight.delete(week);
  });

  wmsClientInflight.set(week, request);
  return request;
}

export function WmsLiveView({ data, week }: Props): JSX.Element {
  const [payload, setPayload] = useState<WmsLivePayload | null>(() => lsLoad());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataSource, setDataSource] = useState<"api" | "cache" | "local" | null>(() => lsLoad() ? "local" : null);
  const [reloadTick, setReloadTick] = useState(0);
  const [prefixFilter, setPrefixFilter] = useState("ALL");
  const [stationFilter, setStationFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [selectedRecipeCode, setSelectedRecipeCode] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadWmsLive(week, reloadTick > 0)
      .then(({ payload: result, source }) => {
        if (cancelled) return;
        setPayload(result);
        setDataSource(source);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        // Bei Fehler: vorhandene Daten aus localStorage behalten
        const persisted = lsLoad();
        if (persisted) {
          setPayload(persisted);
          setDataSource("local");
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [week, reloadTick]);

  const skuIntel = useMemo(() => buildSkuIntel(data), [data]);
  const recipeContexts = useMemo(() => buildRecipeContexts(data, week), [data, week]);
  const skuDemand = useMemo(() => buildSkuDemand(data, recipeContexts, skuIntel), [data, recipeContexts, skuIntel]);

  const items = useMemo<EnrichedItem[]>(() => {
    return (payload?.items ?? []).map((item) => {
      const sku = item.itemNumber.toUpperCase();
      const intel = skuIntel.get(sku);
      const mhdDate = parseMhd(item.earliestMhd);
      const wmsName = cleanName(item.itemName);
      return {
        ...item,
        sku,
        name: wmsName || intel?.name || itemTypeLabel(item.itemPrefix, item.itemType),
        source: wmsName ? "wms" : intel?.source ?? "wms",
        category: item.inventoryCategory || item.inventoryClass || item.inventoryType || intel?.category,
        mhdDate,
        daysToMhd: daysToMhd(mhdDate),
        mhdRisk: mhdRisk(mhdDate),
      };
    });
  }, [payload?.items, skuIntel]);

  const liveBySku = useMemo(() => {
    const map = new Map<string, { qty: number; items: EnrichedItem[]; stations: Set<string>; blockedQty: number; riskCount: number }>();
    for (const item of items) {
      const row = map.get(item.sku) ?? { qty: 0, items: [], stations: new Set<string>(), blockedQty: 0, riskCount: 0 };
      row.qty += item.qty;
      row.items.push(item);
      row.stations.add(item.stationLabel);
      if (item.station === "Z_BLOCKED") row.blockedQty += item.qty;
      if (item.mhdRisk === "expired" || item.mhdRisk === "today" || item.mhdRisk === "soon") row.riskCount += 1;
      map.set(item.sku, row);
    }
    return map;
  }, [items]);

  const planRows = useMemo(() => {
    const actualByRecipeId = new Map<string, number>();
    const locationsByRecipeId = new Map<string, Set<string>>();
    for (const item of items) {
      const recipeId = wmsRecipeId(item.itemNumber);
      if (!recipeId) continue;
      actualByRecipeId.set(recipeId, (actualByRecipeId.get(recipeId) ?? 0) + item.qty);
      const locationSet = locationsByRecipeId.get(recipeId) ?? new Set<string>();
      if (item.locationId) locationSet.add(item.locationId);
      locationsByRecipeId.set(recipeId, locationSet);
    }

    return data.weekRecipes
      .filter(row => row.hfWeek === week)
      .filter(isProducedInVerden)
      .filter((row, index, all) => all.findIndex(other => other.code === row.code) === index)
      .map(row => {
        const recipeId = data.structures?.[row.code]?.recipeId?.toUpperCase() ?? null;
        const planned = row.totalVerdenVolume;
        const actual = recipeId ? actualByRecipeId.get(recipeId) ?? 0 : 0;
        const delta = actual - planned;
        const progressPct = planned > 0 ? actual / planned * 100 : 0;
        return {
          code: row.code,
          recipeId,
          name: row.recipeName,
          planned,
          actual,
          delta,
          progressPct,
          mapped: Boolean(recipeId),
          locations: recipeId ? Array.from(locationsByRecipeId.get(recipeId) ?? []) : [],
        };
      })
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [data.structures, data.weekRecipes, items, week]);

  const recipeSignals = useMemo(() => {
    const byCode = new Map(recipeContexts.map(ctx => [ctx.code, {
      ...ctx,
      recQty: 0,
      labelQty: 0,
      componentQty: 0,
      blockedQty: 0,
      riskCount: 0,
      liveSkuCount: 0,
      stations: new Set<string>(),
      skus: new Map<string, { sku: string; name: string; qty: number; role: "REC" | "Label" | "Komponente"; blockedQty: number; riskCount: number }>(),
      stationQty: new Map<string, { station: string; label: string; qty: number }>(),
      locations: new Map<string, { locationId: string; station: string; label: string; qty: number; skuSet: Set<string> }>(),
    }]));
    const byRecipeId = new Map(recipeContexts.filter(ctx => ctx.recipeId).map(ctx => [ctx.recipeId, ctx.code]));
    const byDigit = new Map(recipeContexts.map(ctx => [ctx.digit, ctx.code]));

    const addSku = (code: string, item: EnrichedItem, role: "REC" | "Label" | "Komponente") => {
      const signal = byCode.get(code);
      if (!signal) return;
      if (role === "REC") signal.recQty += item.qty;
      if (role === "Label") signal.labelQty += item.qty;
      if (role === "Komponente") signal.componentQty += item.qty;
      if (item.station === "Z_BLOCKED") signal.blockedQty += item.qty;
      if (item.mhdRisk === "expired" || item.mhdRisk === "today" || item.mhdRisk === "soon") signal.riskCount += 1;
      signal.stations.add(item.stationLabel);
      const stationRow = signal.stationQty.get(item.station) ?? { station: item.station, label: item.stationLabel, qty: 0 };
      stationRow.qty += item.qty;
      signal.stationQty.set(item.station, stationRow);
      const locationKey = `${item.station}__${item.locationId}`;
      const locationRow = signal.locations.get(locationKey) ?? {
        locationId: item.locationId,
        station: item.station,
        label: item.stationLabel,
        qty: 0,
        skuSet: new Set<string>(),
      };
      locationRow.qty += item.qty;
      locationRow.skuSet.add(item.sku);
      signal.locations.set(locationKey, locationRow);
      const existing = signal.skus.get(item.sku) ?? { sku: item.sku, name: item.name, qty: 0, role, blockedQty: 0, riskCount: 0 };
      existing.qty += item.qty;
      if (item.station === "Z_BLOCKED") existing.blockedQty += item.qty;
      if (item.mhdRisk === "expired" || item.mhdRisk === "today" || item.mhdRisk === "soon") existing.riskCount += 1;
      if (existing.role !== "REC") existing.role = role;
      signal.skus.set(item.sku, existing);
    };

    for (const item of items) {
      const recipeId = wmsRecipeId(item.sku);
      if (recipeId && byRecipeId.has(recipeId)) {
        addSku(byRecipeId.get(recipeId)!, item, "REC");
      }

      const refs = extractRecipeRefs(`${item.itemName ?? ""} ${item.name}`);
      for (const ref of refs) {
        const code = byDigit.get(ref.slice(0, 4));
        if (code) addSku(code, item, "Label");
      }

      const demand = skuDemand.get(item.sku);
      if (demand) {
        const seenCodes = new Set<string>();
        for (const link of demand.links) {
          if (seenCodes.has(link.code)) continue;
          seenCodes.add(link.code);
          addSku(link.code, item, link.source === "recipe" ? "REC" : "Komponente");
        }
      }
    }

    return Array.from(byCode.values()).map(signal => {
      const outputQty = signal.recQty + signal.labelQty;
      const progressPct = signal.planned > 0 ? outputQty / signal.planned * 100 : 0;
      const topSkus = Array.from(signal.skus.values()).sort((a, b) => b.qty - a.qty);
      signal.liveSkuCount = topSkus.length;
      return {
        ...signal,
        outputQty,
        progressPct,
        delta: outputQty - signal.planned,
        topSkus,
        stationList: Array.from(signal.stations),
        stationFlow: Array.from(signal.stationQty.values()).sort((a, b) => a.station.localeCompare(b.station)),
        locationFlow: Array.from(signal.locations.values()).sort((a, b) => b.qty - a.qty),
      };
    }).sort((a, b) => (b.blockedQty + b.riskCount * 1000 + Math.abs(b.delta)) - (a.blockedQty + a.riskCount * 1000 + Math.abs(a.delta)));
  }, [items, recipeContexts, skuDemand]);

  const componentCoverageRows = useMemo(() => {
    return Array.from(skuDemand.values()).map(demand => {
      const live = liveBySku.get(demand.sku);
      const liveQty = live?.qty ?? 0;
      const coveragePct = demand.requiredQty > 0 ? liveQty / demand.requiredQty * 100 : 0;
      return {
        ...demand,
        liveQty,
        coveragePct,
        stations: Array.from(live?.stations ?? []),
        blockedQty: live?.blockedQty ?? 0,
        riskCount: live?.riskCount ?? 0,
        recipes: Array.from(new Set(demand.links.map(link => link.code))),
      };
    })
      .filter(row => row.liveQty > 0 || row.requiredQty > 0)
      .sort((a, b) => (b.blockedQty + b.riskCount * 1000 + b.liveQty) - (a.blockedQty + a.riskCount * 1000 + a.liveQty));
  }, [liveBySku, skuDemand]);

  const selectedRecipeSignal = useMemo(() => {
    return recipeSignals.find(row => row.code === selectedRecipeCode) ?? recipeSignals[0] ?? null;
  }, [recipeSignals, selectedRecipeCode]);

  const productionFlowRows = useMemo(() => {
    const flowQty = (signal: (typeof recipeSignals)[number], stations: string[]) =>
      signal.stationFlow
        .filter(row => stations.includes(row.station))
        .reduce((sum, row) => sum + row.qty, 0);

    return recipeSignals.map(signal => {
      const platingQty = flowQty(signal, ["4_PLATING"]);
      const redzoneQty = flowQty(signal, ["4_REDZONE"]);
      const postblastQty = flowQty(signal, ["5_POSTBLAST"]);
      const sleevingQty = flowQty(signal, ["6_SLEEVING"]);
      const lineQty = flowQty(signal, ["8_LINE"]);
      const bestLiveQty = Math.max(signal.outputQty, platingQty, redzoneQty, postblastQty, sleevingQty, lineQty);
      const flowPct = signal.planned > 0 ? bestLiveQty / signal.planned * 100 : 0;
      return {
        ...signal,
        platingQty,
        redzoneQty,
        postblastQty,
        sleevingQty,
        lineQty,
        bestLiveQty,
        flowPct,
      };
    }).sort((a, b) => (b.redzoneQty + b.sleevingQty + b.lineQty + Math.abs(b.planned - b.bestLiveQty)) - (a.redzoneQty + a.sleevingQty + a.lineQty + Math.abs(a.planned - a.bestLiveQty)));
  }, [recipeSignals]);

  const subMealRows = useMemo(() => {
    const map = new Map<string, {
      sku: string;
      name: string;
      qty: number;
      requiredQty: number;
      uom: string;
      blockedQty: number;
      riskCount: number;
      earliestDays: number | null;
      stations: Set<string>;
      locations: Map<string, { locationId: string; station: string; label: string; qty: number }>;
      recipes: Set<string>;
    }>();

    for (const item of items.filter(row => row.sku.startsWith("SUB-"))) {
      const demand = skuDemand.get(item.sku);
      const existing = map.get(item.sku) ?? {
        sku: item.sku,
        name: item.name,
        qty: 0,
        requiredQty: demand?.requiredQty ?? 0,
        uom: demand?.uom ?? item.itemUom ?? "",
        blockedQty: 0,
        riskCount: 0,
        earliestDays: null,
        stations: new Set<string>(),
        locations: new Map<string, { locationId: string; station: string; label: string; qty: number }>(),
        recipes: new Set<string>(),
      };
      existing.qty += item.qty;
      if (item.station === "Z_BLOCKED") existing.blockedQty += item.qty;
      if (item.mhdRisk === "expired" || item.mhdRisk === "today" || item.mhdRisk === "soon") existing.riskCount += 1;
      if (item.daysToMhd != null) existing.earliestDays = existing.earliestDays == null ? item.daysToMhd : Math.min(existing.earliestDays, item.daysToMhd);
      existing.stations.add(item.stationLabel);
      const location = existing.locations.get(item.locationId) ?? { locationId: item.locationId, station: item.station, label: item.stationLabel, qty: 0 };
      location.qty += item.qty;
      existing.locations.set(item.locationId, location);
      for (const link of demand?.links ?? []) existing.recipes.add(link.code);
      map.set(item.sku, existing);
    }

    return Array.from(map.values()).map(row => ({
      ...row,
      coveragePct: row.requiredQty > 0 ? row.qty / row.requiredQty * 100 : 0,
      stationList: Array.from(row.stations),
      locationList: Array.from(row.locations.values()).sort((a, b) => b.qty - a.qty),
      recipeList: Array.from(row.recipes),
    })).sort((a, b) => (b.blockedQty + b.riskCount * 1000 + b.qty) - (a.blockedQty + a.riskCount * 1000 + a.qty));
  }, [items, skuDemand]);

  const stationRows = useMemo(() => {
    const stations = payload?.stations ?? [];
    const maxQty = Math.max(1, ...stations.map(row => row.qty));
    return stations.map(station => {
      const stationItems = items.filter(item => item.station === station.station);
      const top = stationItems.slice().sort((a, b) => b.qty - a.qty)[0] ?? null;
      const mhdCritical = stationItems.filter(item => item.mhdRisk === "expired" || item.mhdRisk === "today").length;
      return {
        ...station,
        top,
        mhdCritical,
        widthPct: station.qty / maxQty * 100,
      };
    });
  }, [items, payload?.stations]);

  const typeRows = useMemo(() => {
    const map = new Map<string, { prefix: string; label: string; qty: number; skuSet: Set<string>; risk: number }>();
    for (const item of items) {
      const prefix = (item.itemPrefix || item.sku.slice(0, 3) || "UNK").toUpperCase();
      const row = map.get(prefix) ?? {
        prefix,
        label: itemTypeLabel(prefix, item.itemType),
        qty: 0,
        skuSet: new Set<string>(),
        risk: 0,
      };
      row.qty += item.qty;
      row.skuSet.add(item.sku);
      if (item.mhdRisk === "expired" || item.mhdRisk === "today") row.risk += 1;
      map.set(prefix, row);
    }
    return Array.from(map.values()).sort((a, b) => b.qty - a.qty);
  }, [items]);

  const filteredItems = useMemo(() => {
    const needle = search.trim().toUpperCase();
    return items
      .filter(item => prefixFilter === "ALL" || (item.itemPrefix || item.sku.slice(0, 3)).toUpperCase() === prefixFilter)
      .filter(item => stationFilter === "ALL" || item.station === stationFilter)
      .filter(item => {
        if (!needle) return true;
        const demandText = skuDemand.get(item.sku)?.links.map(link => `${link.code} ${link.name} ${link.path ?? ""}`).join(" ") ?? "";
        return `${item.sku} ${item.name} ${item.locationId} ${item.stationLabel} ${item.itemName ?? ""} ${demandText}`.toUpperCase().includes(needle);
      })
      .sort((a, b) => b.qty - a.qty);
  }, [items, prefixFilter, search, skuDemand, stationFilter]);

  const kpis = useMemo(() => {
    const planned = planRows.reduce((sum, row) => sum + row.planned, 0);
    const actualMatched = recipeSignals.reduce((sum, row) => sum + row.outputQty, 0);
    const totalWms = stationRows.reduce((sum, row) => sum + row.qty, 0);
    const blocked = stationRows.find(row => row.station === "Z_BLOCKED")?.qty ?? 0;
    const plating = stationRows.find(row => row.station === "4_PLATING")?.qty ?? 0;
    const redzone = stationRows.find(row => row.station === "4_REDZONE")?.qty ?? 0;
    const sleeving = stationRows.find(row => row.station === "6_SLEEVING")?.qty ?? 0;
    const line = stationRows.find(row => row.station === "8_LINE")?.qty ?? 0;
    const subLiveQty = subMealRows.reduce((sum, row) => sum + row.qty, 0);
    const subBlockedQty = subMealRows.reduce((sum, row) => sum + row.blockedQty, 0);
    const subSkuCount = subMealRows.length;
    const mhdCritical = items.filter(item => item.mhdRisk === "expired" || item.mhdRisk === "today").length;
    const named = items.filter(item => item.name !== itemTypeLabel(item.itemPrefix, item.itemType)).length;
    const criticalMeals = recipeSignals.filter(row => row.planned > 0 && row.progressPct < 90).length;
    const mapped = planRows.filter(row => row.mapped).length;
    return { planned, actualMatched, totalWms, blocked, plating, redzone, sleeving, line, subLiveQty, subBlockedQty, subSkuCount, mhdCritical, named, criticalMeals, mapped };
  }, [items, planRows, recipeSignals, stationRows, subMealRows]);

  const alerts = useMemo(() => {
    const out: Array<{ tone: "rose" | "amber" | "emerald" | "sky"; title: string; detail: string; value: string }> = [];
    if (kpis.mhdCritical > 0) {
      out.push({ tone: "rose", title: "MHD jetzt pruefen", detail: "Artikel abgelaufen oder heute faellig", value: fmtNum(kpis.mhdCritical) });
    }
    if (kpis.blocked > 0) {
      out.push({ tone: "amber", title: "Blocked / Verlust", detail: "Menge in LOST, PROD RTN oder Sperrlager", value: fmtCompact(kpis.blocked) });
    }
    if (kpis.subBlockedQty > 0) {
      out.push({ tone: "rose", title: "SUB blocked", detail: "Sub-Meals liegen in gesperrten Locations", value: fmtCompact(kpis.subBlockedQty) });
    }
    if (kpis.criticalMeals > 0) {
      out.push({ tone: "rose", title: "Nacharbeit", detail: "Geplante REC-Meals unter 90 Prozent", value: fmtNum(kpis.criticalMeals) });
    }
    if (kpis.redzone > 0) {
      out.push({ tone: "sky", title: "Redzone Signal", detail: "Live-Menge in Redzone/Scan-Locations", value: fmtCompact(kpis.redzone) });
    }
    if (kpis.line > 0) {
      out.push({ tone: "emerald", title: "Output sichtbar", detail: "Menge in VF-LINE / SPI Output Locations", value: fmtCompact(kpis.line) });
    }
    if (out.length === 0 && payload?.configured) {
      out.push({ tone: "emerald", title: "Keine roten Signale", detail: "WMS liefert Daten ohne akute MHD- oder Blocked-Auffaelligkeit", value: "OK" });
    }
    return out;
  }, [kpis, payload?.configured]);

  const notConfigured = payload && payload.configured === false;
  const topRiskItems = items
    .filter(item => item.mhdRisk === "expired" || item.mhdRisk === "today" || item.mhdRisk === "soon")
    .sort((a, b) => (a.daysToMhd ?? 999) - (b.daysToMhd ?? 999) || b.qty - a.qty)
    .slice(0, 8);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-emerald-700">Snowflake HighJump Live</div>
              <h3 className="text-xl font-black text-slate-900">WMS Control Tower</h3>
              <p className="mt-1 text-sm text-slate-600">
                Live-Bestand, Recipe-Fortschritt, SKU-Namen, MHD-Risiken und Sperrbestand direkt in der Planning OASE.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setReloadTick(tick => tick + 1)}
              className="btn"
              disabled={loading}
            >
              {loading ? "Aktualisiere ..." : "Aktualisieren"}
            </button>
          </div>

          {payload?.generatedAt && (
            <div className="mt-2 text-xs text-slate-500">
              WMS Stand: {new Date(payload.generatedAt).toLocaleString("de-DE")}
              {dataSource === "cache" && (
                <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-700 font-medium">
                  Offline-Cache · für Live-Daten: <code className="font-mono">npm run wms:sync</code>
                </span>
              )}
              {dataSource === "local" && (
                <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-slate-500 font-medium">
                  Gespeicherter Stand · Aktualisieren für neue Daten
                </span>
              )}
            </div>
          )}

          {notConfigured && (
            <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
              Snowflake ist noch nicht fuer die Firebase Function konfiguriert:
              <span className="ml-1 font-mono">{payload.requiredEnv?.join(", ") ?? "SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD"}</span>.
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700 ring-1 ring-slate-200">
              <p className="font-medium mb-1">Keine Live-Verbindung zu Snowflake</p>
              <p className="text-xs text-slate-500">{error}</p>
              <p className="mt-2 text-xs text-slate-600">
                Für aktuelle Daten: <code className="bg-slate-100 px-1 rounded font-mono">npm run wms:sync</code> im Terminal ausführen. Ein Browser-Fenster für die SSO-Anmeldung öffnet sich automatisch.
              </p>
            </div>
          )}

          {payload?.configured && payload.error && (
            <div className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">
              Snowflake-Fehler: {payload.error}
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            <LiveStat label="Plan Verden" value={fmtNum(kpis.planned)} />
            <LiveStat label="Output Ist" value={fmtNum(kpis.actualMatched)} accent="emerald" />
            <LiveStat label="WMS Gesamt" value={fmtCompact(kpis.totalWms)} />
            <LiveStat label="Live-Matches" value={`${fmtNum(recipeSignals.filter(row => row.liveSkuCount > 0).length)} / ${fmtNum(recipeSignals.length)}`} accent="sky" />
            <LiveStat label="Plating live" value={fmtCompact(kpis.plating)} />
            <LiveStat label="Redzone live" value={fmtCompact(kpis.redzone)} accent="sky" />
            <LiveStat label="Sleeving live" value={fmtCompact(kpis.sleeving)} />
            <LiveStat label="Line Output" value={fmtCompact(kpis.line)} accent="emerald" />
            <LiveStat label="SUB live" value={fmtCompact(kpis.subLiveQty)} accent="sky" />
            <LiveStat label="SUB SKUs" value={fmtNum(kpis.subSkuCount)} />
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
          {alerts.slice(0, 4).map(alert => (
            <AlertCard key={alert.title} {...alert} />
          ))}
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">Live-Rezeptlogik Match</h3>
              <div className="text-xs text-slate-500">REC-Output, CON/Label-Hinweise und Komponenten aus Gross Ingredients und Sub-Rezept-Struktur zusammengeführt.</div>
            </div>
            <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-800 ring-1 ring-sky-200">
              Namen erkannt {fmtNum(kpis.named)} / {fmtNum(items.length)}
            </span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {recipeSignals.slice(0, 9).map(signal => {
              const isSelected = selectedRecipeSignal?.code === signal.code;
              const outputTone = signal.outputQty >= signal.planned && signal.planned > 0 ? "bg-emerald-500" : signal.outputQty > 0 ? "bg-amber-500" : "bg-rose-500";
              return (
                <button
                  type="button"
                  key={signal.code}
                  onClick={() => {
                    setSelectedRecipeCode(signal.code);
                    setSearch(signal.code);
                    setPrefixFilter("ALL");
                    setStationFilter("ALL");
                  }}
                  className={`rounded-lg p-3 text-left ring-1 transition ${isSelected ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-800 ring-slate-200 hover:bg-slate-50"}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-xs font-black">{signal.code}</div>
                      <div className="truncate text-sm font-bold">{signal.name}</div>
                      <div className="mt-0.5 font-mono text-[10px] opacity-70">{signal.recipeId ?? "kein REC"}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-black tabular-nums">{pct(signal.progressPct)}</div>
                      <div className="text-[10px] opacity-70">Output</div>
                    </div>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className={`h-full rounded-full ${outputTone}`} style={{ width: `${clamp(signal.progressPct)}%` }} />
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1 text-[10px]">
                    <MiniPill label="REC" value={fmtCompact(signal.recQty)} />
                    <MiniPill label="Label" value={fmtCompact(signal.labelQty)} />
                    <MiniPill label="Komp." value={fmtCompact(signal.componentQty)} />
                  </div>
                  <div className="mt-2 truncate text-[11px] opacity-75">
                    {signal.liveSkuCount > 0 ? `${fmtNum(signal.liveSkuCount)} SKUs · ${signal.stationList.join(", ")}` : "noch kein Live-Signal"}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-slate-800">Drilldown</h3>
            {selectedRecipeSignal && <span className="font-mono text-xs font-bold text-slate-500">{selectedRecipeSignal.code}</span>}
          </div>
          {selectedRecipeSignal ? (
            <div className="mt-3 space-y-2">
              <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
                <div className="text-sm font-black text-slate-900">{selectedRecipeSignal.name}</div>
                <div className="mt-1 text-xs text-slate-500">
                  Plan {fmtNum(selectedRecipeSignal.planned)} · Output {fmtNum(selectedRecipeSignal.outputQty)} · Komponenten live {fmtCompact(selectedRecipeSignal.componentQty)}
                </div>
              </div>
              {selectedRecipeSignal.locationFlow.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {selectedRecipeSignal.locationFlow.slice(0, 4).map(location => (
                    <button
                      type="button"
                      key={`${location.station}-${location.locationId}`}
                      onClick={() => {
                        setStationFilter(location.station);
                        setSearch(location.locationId);
                      }}
                      className="rounded-lg bg-white p-2 text-left ring-1 ring-slate-200 hover:bg-slate-50"
                    >
                      <div className="truncate font-mono text-[10px] font-bold text-slate-700">{location.locationId || location.label}</div>
                      <div className="mt-0.5 text-sm font-black tabular-nums text-slate-900">{fmtCompact(location.qty)}</div>
                      <div className="truncate text-[10px] text-slate-500">{location.label} · {fmtNum(location.skuSet.size)} SKUs</div>
                    </button>
                  ))}
                </div>
              )}
              {selectedRecipeSignal.topSkus.slice(0, 8).map(sku => (
                <button
                  type="button"
                  key={sku.sku}
                  onClick={() => setSearch(sku.sku)}
                  className="w-full rounded-lg bg-white p-2 text-left ring-1 ring-slate-200 hover:bg-slate-50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-slate-800">{sku.name}</div>
                      <div className="font-mono text-[10px] text-slate-500">{sku.sku} · {sku.role}</div>
                    </div>
                    <div className="text-right text-xs font-black tabular-nums text-slate-900">{fmtCompact(sku.qty)}</div>
                  </div>
                  {(sku.blockedQty > 0 || sku.riskCount > 0) && (
                    <div className="mt-1 text-[10px] font-semibold text-rose-700">
                      {sku.blockedQty > 0 ? `${fmtCompact(sku.blockedQty)} blocked` : ""}{sku.blockedQty > 0 && sku.riskCount > 0 ? " · " : ""}{sku.riskCount > 0 ? `${sku.riskCount} MHD` : ""}
                    </div>
                  )}
                </button>
              ))}
              {selectedRecipeSignal.topSkus.length === 0 && (
                <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-amber-200">
                  Fuer dieses Meal ist im aktuellen WMS-Schnitt noch kein zuordenbarer Artikel sichtbar.
                </div>
              )}
            </div>
          ) : (
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-500 ring-1 ring-slate-200">Keine Rezeptsignale geladen.</div>
          )}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-800">Redzone / Plating / Sleeving Live-Flow</h3>
            <div className="text-xs text-slate-500">Meal-Signale werden je Produktionsstufe aus WMS-Locations, CON-Labels, REC-IDs und Komponentenmatches zusammengezogen.</div>
          </div>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
            {fmtNum(productionFlowRows.filter(row => row.bestLiveQty > 0).length)} Meals live sichtbar
          </span>
        </div>
        <div className="mt-3 grid gap-2 xl:grid-cols-2">
          {productionFlowRows.slice(0, 10).map(row => {
            const isSelected = selectedRecipeSignal?.code === row.code;
            const flowTone = row.flowPct >= 100 ? "bg-emerald-500" : row.flowPct >= 80 ? "bg-amber-500" : "bg-rose-500";
            return (
              <button
                type="button"
                key={row.code}
                onClick={() => {
                  setSelectedRecipeCode(row.code);
                  setSearch(row.code);
                  setPrefixFilter("ALL");
                  setStationFilter("ALL");
                }}
                className={`rounded-lg p-3 text-left ring-1 transition ${isSelected ? "bg-slate-900 text-white ring-slate-900" : "bg-white text-slate-800 ring-slate-200 hover:bg-slate-50"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-black">{row.code}</div>
                    <div className="truncate text-sm font-bold">{row.name}</div>
                    <div className="mt-0.5 truncate text-[11px] opacity-70">
                      {row.locationFlow.slice(0, 3).map(location => `${location.locationId || location.label}: ${fmtCompact(location.qty)}`).join(" · ") || "noch keine Produktionslocation"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-black tabular-nums">{pct(row.flowPct)}</div>
                    <div className="text-[10px] opacity-70">{fmtCompact(row.bestLiveQty)} / {fmtCompact(row.planned)}</div>
                  </div>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${flowTone}`} style={{ width: `${clamp(row.flowPct)}%` }} />
                </div>
                <div className="mt-2 grid grid-cols-5 gap-1 text-[10px]">
                  <MiniPill label="Plate" value={fmtCompact(row.platingQty)} />
                  <MiniPill label="Redzone" value={fmtCompact(row.redzoneQty)} />
                  <MiniPill label="PostB" value={fmtCompact(row.postblastQty)} />
                  <MiniPill label="Sleeve" value={fmtCompact(row.sleevingQty)} />
                  <MiniPill label="Line" value={fmtCompact(row.lineQty)} />
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-800">SUB-Meals Live</h3>
            <div className="text-xs text-slate-500">Alle sichtbaren SUB-Rezepte mit Menge, Location, MHD, Blocked-Status und Rezeptbezug.</div>
          </div>
          <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-800 ring-1 ring-sky-200">
            {fmtNum(subMealRows.length)} SUB-Codes · {fmtCompact(kpis.subLiveQty)} Einheiten
          </span>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {subMealRows.slice(0, 12).map(row => {
            const hasDemand = row.requiredQty > 0;
            const isBlocked = row.blockedQty > 0;
            const hasRisk = row.riskCount > 0 || (row.earliestDays != null && row.earliestDays <= 2);
            const tone = isBlocked ? "bg-rose-50 ring-rose-200 hover:bg-rose-100" : hasRisk ? "bg-amber-50 ring-amber-200 hover:bg-amber-100" : "bg-white ring-slate-200 hover:bg-slate-50";
            return (
              <button
                type="button"
                key={row.sku}
                onClick={() => {
                  setSearch(row.sku);
                  setPrefixFilter("SUB");
                  setStationFilter("ALL");
                }}
                className={`rounded-lg p-3 text-left ring-1 transition ${tone}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-black text-slate-800">{row.sku}</div>
                    <div className="truncate text-sm font-bold text-slate-900">{row.name}</div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-500">
                      {row.recipeList.length ? row.recipeList.slice(0, 4).join(", ") : "noch kein Rezeptlink"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-black tabular-nums text-slate-900">{fmtCompact(row.qty)}</div>
                    <div className="text-[10px] font-semibold text-slate-500">{hasDemand ? `${pct(row.coveragePct)} Soll` : "Live"}</div>
                  </div>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white ring-1 ring-slate-200">
                  <div
                    className={`h-full rounded-full ${isBlocked ? "bg-rose-500" : hasRisk ? "bg-amber-500" : "bg-emerald-500"}`}
                    style={{ width: `${hasDemand ? clamp(row.coveragePct) : row.qty > 0 ? 100 : 0}%` }}
                  />
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1 text-[10px]">
                  <MiniPill label="Soll" value={hasDemand ? `${fmtCompact(row.requiredQty)} ${row.uom}` : "-"} />
                  <MiniPill label="Blocked" value={fmtCompact(row.blockedQty)} />
                  <MiniPill label="MHD" value={row.earliestDays == null ? "?" : row.earliestDays < 0 ? `${Math.abs(row.earliestDays)}d ueber` : `D+${row.earliestDays}`} />
                </div>
                <div className="mt-2 truncate text-[11px] text-slate-600">
                  {row.locationList.slice(0, 3).map(location => `${location.locationId || location.label}: ${fmtCompact(location.qty)}`).join(" · ")}
                </div>
                <div className="mt-1 truncate text-[10px] text-slate-500">
                  {row.stationList.join(", ")}
                </div>
              </button>
            );
          })}
          {subMealRows.length === 0 && (
            <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500 ring-1 ring-slate-200">
              In der aktuellen WMS-Woche sind keine SUB-Meals sichtbar.
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-slate-800">Produktionsfluss nach Zone</h3>
            <span className="text-xs font-semibold text-slate-500">{fmtNum(stationRows.length)} Zonen</span>
          </div>
          <div className="mt-3 space-y-2">
            {stationRows.map(station => (
              <div key={station.station} className={`rounded-lg p-3 ring-1 ${stationTone(station.station)}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-wide opacity-70">{station.station}</div>
                    <div className="text-sm font-black">{station.label}</div>
                    <div className="mt-1 truncate text-[11px] opacity-80">
                      Top: {station.top ? `${station.top.sku} - ${station.top.name}` : "keine Artikel"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-black tabular-nums">{fmtCompact(station.qty)}</div>
                    <div className="text-[11px] opacity-80">{fmtNum(station.skuCount)} SKUs</div>
                  </div>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/70">
                  <div className="h-full rounded-full bg-current opacity-60" style={{ width: `${clamp(station.widthPct)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-slate-800">SKU-Typen im Bestand</h3>
            <span className="text-xs font-semibold text-slate-500">Top nach Menge</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {typeRows.slice(0, 10).map((row) => {
              const share = kpis.totalWms > 0 ? row.qty / kpis.totalWms * 100 : 0;
              return (
                <button
                  type="button"
                  key={row.prefix}
                  onClick={() => setPrefixFilter(row.prefix)}
                  className={`rounded-lg p-3 text-left ring-1 transition ${prefixFilter === row.prefix ? "bg-slate-900 text-white ring-slate-900" : "bg-slate-50 text-slate-800 ring-slate-200 hover:bg-white"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono text-xs font-black">{row.prefix}</div>
                    <div className="text-lg font-black tabular-nums">{fmtCompact(row.qty)}</div>
                  </div>
                  <div className="mt-1 truncate text-xs font-semibold opacity-80">{row.label}</div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/50">
                    <div className="h-full rounded-full bg-emerald-500" style={{ width: `${clamp(share)}%` }} />
                  </div>
                  <div className="mt-1 text-[11px] opacity-75">{fmtNum(row.skuSet.size)} SKUs · {pct(share)}</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">REC-ID Rohsignal</h3>
              <div className="text-xs text-slate-500">Nur echte REC-Artikel aus WMS; der vollstaendige Output steht oben im Live-Rezeptlogik-Match.</div>
            </div>
            <span className="text-xs font-semibold text-slate-500">{fmtNum(kpis.mapped)} / {fmtNum(planRows.length)} REC-IDs gemappt</span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {planRows.slice(0, 12).map(row => {
              const isLow = row.mapped && row.planned > 0 && row.progressPct < 90;
              const isOver = row.progressPct > 110;
              const tone = !row.mapped ? "ring-slate-200 bg-slate-50" : isLow ? "ring-rose-200 bg-rose-50" : isOver ? "ring-amber-200 bg-amber-50" : "ring-emerald-200 bg-emerald-50";
              return (
                <div key={row.code} className={`rounded-lg p-3 ring-1 ${tone}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-xs font-black text-slate-600">{row.code}</div>
                      <div className="truncate text-sm font-bold text-slate-900">{row.name}</div>
                      <div className="font-mono text-[10px] text-slate-500">{row.recipeId ?? "kein REC-Mapping"}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-black tabular-nums text-slate-900">{pct(row.progressPct)}</div>
                      <div className="text-[11px] text-slate-500">{fmtNum(row.actual)} / {fmtNum(row.planned)}</div>
                    </div>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
                    <div
                      className={`h-full rounded-full ${isLow ? "bg-rose-500" : isOver ? "bg-amber-500" : "bg-emerald-500"}`}
                      style={{ width: `${clamp(row.progressPct)}%` }}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-semibold text-slate-700">{row.delta > 0 ? "+" : ""}{fmtNum(row.delta)} Delta</span>
                    <span className="truncate text-slate-500">{row.locations.length ? row.locations.join(", ") : "noch kein WMS-Output"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-bold text-slate-800">MHD & Blocker</h3>
            <span className="text-xs font-semibold text-slate-500">{fmtNum(topRiskItems.length)} Signale</span>
          </div>
          <div className="mt-3 space-y-2">
            {topRiskItems.map(item => (
              <div key={`${item.station}-${item.locationId}-${item.sku}`} className={`rounded-lg p-3 ring-1 ${riskTone(item.mhdRisk)}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold">{item.name}</div>
                    <div className="font-mono text-[10px] opacity-75">{item.sku} · {item.locationId}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-black tabular-nums">{fmtCompact(item.qty)}</div>
                    <div className="text-[10px] font-semibold">{item.daysToMhd == null ? "MHD ?" : item.daysToMhd < 0 ? `${Math.abs(item.daysToMhd)}d ueber` : `D+${item.daysToMhd}`}</div>
                  </div>
                </div>
              </div>
            ))}
            {topRiskItems.length === 0 && (
              <div className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
                Keine kritischen MHD-Signale in den geladenen WMS-Toppositionen.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-800">Komponenten-Coverage gegen Rezeptlogik</h3>
            <div className="text-xs text-slate-500">Live-SKUs werden gegen Bedarf aus Gross Ingredients und detaillierten Sub-Rezepten gerechnet.</div>
          </div>
          <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
            {fmtNum(componentCoverageRows.length)} verknuepfte SKUs
          </span>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {componentCoverageRows.slice(0, 16).map(row => {
            const hasComparableDemand = row.requiredQty > 0;
            const isCritical = row.blockedQty > 0 || row.riskCount > 0 || (row.liveQty === 0 && row.requiredQty > 0);
            return (
              <button
                type="button"
                key={row.sku}
                onClick={() => {
                  setSearch(row.sku);
                  setPrefixFilter("ALL");
                  setStationFilter("ALL");
                }}
                className={`rounded-lg p-3 text-left ring-1 transition ${isCritical ? "bg-amber-50 ring-amber-200 hover:bg-amber-100" : "bg-white ring-slate-200 hover:bg-slate-50"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-bold text-slate-900">{row.name}</div>
                    <div className="font-mono text-[10px] text-slate-500">{row.sku}</div>
                  </div>
                  <div className="text-right text-sm font-black tabular-nums text-slate-900">{fmtCompact(row.liveQty)}</div>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white ring-1 ring-slate-200">
                  <div
                    className={`h-full rounded-full ${row.liveQty === 0 ? "bg-rose-500" : row.coveragePct < 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                    style={{ width: `${hasComparableDemand ? clamp(row.coveragePct) : row.liveQty > 0 ? 100 : 0}%` }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-600">
                  <span>{hasComparableDemand ? `${pct(row.coveragePct)} Coverage` : "Live ohne Planbedarf"}</span>
                  <span className="truncate">{row.recipes.slice(0, 3).join(", ")}</span>
                </div>
                <div className="mt-1 truncate text-[10px] text-slate-500">
                  Bedarf {fmtCompact(row.requiredQty)} {row.uom} · {row.stations.join(", ") || "nicht live"}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-800">WMS Artikel-Explorer</h3>
            <div className="text-xs text-slate-500">Codes werden automatisch mit Rezept-, BOM- und Shelf-Life-Namen angereichert.</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <select className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs" value={stationFilter} onChange={event => setStationFilter(event.target.value)}>
              <option value="ALL">Alle Zonen</option>
              {stationRows.map(row => <option key={row.station} value={row.station}>{row.label}</option>)}
            </select>
            <select className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs" value={prefixFilter} onChange={event => setPrefixFilter(event.target.value)}>
              <option value="ALL">Alle Typen</option>
              {typeRows.map(row => <option key={row.prefix} value={row.prefix}>{row.prefix} - {row.label}</option>)}
            </select>
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="SKU, Name, Location"
              className="w-52 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
            />
          </div>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="py-2 pr-2 text-left">Artikel</th>
                <th className="py-2 pr-2 text-left">Name</th>
                <th className="py-2 pr-2 text-left">Zone</th>
                <th className="py-2 pr-2 text-left">Location</th>
                <th className="py-2 pr-2 text-right">Menge</th>
                <th className="py-2 pr-2 text-left">MHD</th>
                <th className="py-2 text-left">Quelle</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.slice(0, 250).map((item, index) => (
                <tr key={`${item.station}-${item.locationId}-${item.sku}-${index}`} className="border-b last:border-0">
                  <td className="py-2 pr-2">
                    <div className="font-mono text-[11px] font-bold text-slate-800">{item.sku}</div>
                    <div className="text-[10px] text-slate-500">{itemTypeLabel(item.itemPrefix, item.itemType)}</div>
                  </td>
                  <td className="max-w-sm py-2 pr-2">
                    <div className="truncate font-semibold text-slate-800">{item.name}</div>
                    {item.category && <div className="truncate text-[10px] text-slate-500">{item.category}</div>}
                  </td>
                  <td className="py-2 pr-2 text-slate-700">{item.stationLabel}</td>
                  <td className="py-2 pr-2 font-mono text-[10px] text-slate-500">{item.locationId}</td>
                  <td className="py-2 pr-2 text-right tabular-nums font-semibold">{fmtNum(item.qty)}</td>
                  <td className="py-2 pr-2">
                    <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ring-1 ${riskTone(item.mhdRisk)}`}>
                      {item.mhdDate ? item.mhdDate.toLocaleDateString("de-DE") : "-"}
                    </span>
                  </td>
                  <td className="py-2 text-slate-500">{sourceLabel(item.source)}</td>
                </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr>
                  <td className="py-4 text-slate-500" colSpan={7}>Keine WMS-Artikel fuer diesen Filter.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function LiveStat({ label, value, accent }: { label: string; value: string; accent?: "emerald" | "sky" }): JSX.Element {
  const tone = accent === "emerald"
    ? "bg-emerald-50 ring-emerald-300"
    : accent === "sky"
      ? "bg-sky-50 ring-sky-300"
      : "bg-slate-50 ring-slate-200";
  return (
    <div className={`rounded-lg px-3 py-2 ring-1 ${tone}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-xl font-black tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

function MiniPill({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-md bg-white/70 px-2 py-1 ring-1 ring-black/5">
      <div className="text-[9px] font-bold uppercase tracking-wide opacity-60">{label}</div>
      <div className="font-mono text-[11px] font-black tabular-nums">{value}</div>
    </div>
  );
}

function AlertCard({ tone, title, detail, value }: { tone: "rose" | "amber" | "emerald" | "sky"; title: string; detail: string; value: string }): JSX.Element {
  const tones = {
    rose: "bg-rose-50 text-rose-900 ring-rose-200",
    amber: "bg-amber-50 text-amber-900 ring-amber-200",
    emerald: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    sky: "bg-sky-50 text-sky-900 ring-sky-200",
  };
  return (
    <div className={`rounded-lg p-3 ring-1 ${tones[tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-black">{title}</div>
          <div className="mt-1 text-[11px] opacity-80">{detail}</div>
        </div>
        <div className="text-xl font-black tabular-nums">{value}</div>
      </div>
    </div>
  );
}
