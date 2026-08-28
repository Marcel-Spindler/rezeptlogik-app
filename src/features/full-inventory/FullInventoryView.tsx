import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FullInventoryRow, WmsSearchResult } from "../wms-overview/wmsTypes";
import { fetchFullInventory, fetchWmsSearch } from "../wms-overview/wmsFetch";

type SortKey = "locationId" | "itemNumber" | "actualQty" | "status" | "fifoDate" | "expirationDate" | "dbChangeCommitTime" | "lotNumber";
type SortDir = "asc" | "desc";
type GroupBy = "none" | "location" | "item" | "status";

const LOCATION_ZONES: Record<string, { label: string; color: string }> = {
  "PLH":           { label: "Plating Holding",  color: "bg-indigo-100 text-indigo-800" },
  "PLATING-LINE":  { label: "Plating Linie",    color: "bg-blue-100 text-blue-800" },
  "PLSTG":         { label: "Plating Staging",  color: "bg-blue-50 text-blue-700" },
  "PHSTG":         { label: "Staging",           color: "bg-amber-100 text-amber-800" },
  "DEBOX":         { label: "Debox",             color: "bg-orange-100 text-orange-800" },
  "POSTB":         { label: "Post-Blast",        color: "bg-rose-100 text-rose-800" },
  "POST-BLAST":    { label: "Post-Blast",        color: "bg-rose-100 text-rose-800" },
  "SLEEV":         { label: "Sleeving",          color: "bg-sky-100 text-sky-800" },
  "RCV":           { label: "Receiving",         color: "bg-emerald-100 text-emerald-800" },
  "BULK":          { label: "Bulk Storage",      color: "bg-slate-100 text-slate-700" },
  "PICK":          { label: "Pick",              color: "bg-purple-100 text-purple-800" },
};

function classifyZone(loc: string): { label: string; color: string } {
  const upper = loc.toUpperCase();
  for (const [prefix, meta] of Object.entries(LOCATION_ZONES)) {
    if (upper.includes(prefix)) return meta;
  }
  return { label: "Sonstige", color: "bg-gray-100 text-gray-700" };
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
}

function fmtQty(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("de-DE", { maximumFractionDigits: 2 });
}

function isExpiringSoon(row: FullInventoryRow): boolean {
  if (!row.expirationDate) return false;
  const diff = new Date(row.expirationDate).getTime() - Date.now();
  return diff > 0 && diff < 3 * 24 * 60 * 60 * 1000;
}

function isExpired(row: FullInventoryRow): boolean {
  if (!row.expirationDate) return false;
  return new Date(row.expirationDate).getTime() < Date.now();
}

const PAGE_SIZE = 100;

export function FullInventoryView() {
  const [rows, setRows] = useState<FullInventoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [totalRows, setTotalRows] = useState(0);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("locationId");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [zoneFilter, setZoneFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [showExpiredOnly, setShowExpiredOnly] = useState(false);
  const [showExpiringSoon, setShowExpiringSoon] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [deepSearch, setDeepSearch] = useState("");
  const [deepResult, setDeepResult] = useState<WmsSearchResult | null>(null);
  const [deepLoading, setDeepLoading] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);
  const [activeDeepTab, setActiveDeepTab] = useState<"stored" | "itemMaster" | "transactions" | "receipts" | "workorders">("stored");
  const deepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const deepSearchRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchFullInventory({ limit: 200000 });
      setRows(result.rows);
      setTotalRows(result.totalRows);
      setGeneratedAt(result.generatedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "j") {
        e.preventDefault();
        deepSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const runDeepSearch = useCallback(async (q: string) => {
    if (q.length < 2) { setDeepResult(null); return; }
    setDeepLoading(true);
    setDeepError(null);
    try {
      const result = await fetchWmsSearch(q);
      setDeepResult(result);
      const tabs = ["stored", "itemMaster", "transactions", "receipts", "workorders"] as const;
      const firstNonEmpty = tabs.find(t => result[t].count > 0);
      if (firstNonEmpty) setActiveDeepTab(firstNonEmpty);
    } catch (e) {
      setDeepError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeepLoading(false);
    }
  }, []);

  const handleDeepSearchChange = (value: string) => {
    setDeepSearch(value);
    if (deepTimerRef.current) clearTimeout(deepTimerRef.current);
    if (value.trim().length >= 2) {
      deepTimerRef.current = setTimeout(() => runDeepSearch(value.trim()), 400);
    } else {
      setDeepResult(null);
    }
  };

  const needle = search.trim().toUpperCase();

  const filtered = useMemo(() => {
    let result = rows;

    if (needle) {
      result = result.filter(r =>
        r.locationId.toUpperCase().includes(needle) ||
        r.itemNumber.toUpperCase().includes(needle) ||
        (r.lotNumber ?? "").toUpperCase().includes(needle) ||
        (r.huId ?? "").toUpperCase().includes(needle) ||
        r.status.toUpperCase().includes(needle) ||
        (r.reservedFor ?? "").toUpperCase().includes(needle) ||
        (r.shipmentNumber ?? "").toUpperCase().includes(needle) ||
        (r.inspectionCode ?? "").toUpperCase().includes(needle) ||
        (r.putAwayLocation ?? "").toUpperCase().includes(needle)
      );
    }

    if (zoneFilter) {
      result = result.filter(r => classifyZone(r.locationId).label === zoneFilter);
    }

    if (statusFilter) {
      result = result.filter(r => r.status === statusFilter);
    }

    if (showExpiredOnly) {
      result = result.filter(isExpired);
    } else if (showExpiringSoon) {
      result = result.filter(r => isExpiringSoon(r) || isExpired(r));
    }

    return result;
  }, [rows, needle, zoneFilter, statusFilter, showExpiredOnly, showExpiringSoon]);

  const sorted = useMemo(() => {
    const cmp = (a: FullInventoryRow, b: FullInventoryRow): number => {
      let av: string | number | null, bv: string | number | null;
      switch (sortKey) {
        case "actualQty": av = a.actualQty; bv = b.actualQty; break;
        case "fifoDate": av = a.fifoDate; bv = b.fifoDate; break;
        case "expirationDate": av = a.expirationDate; bv = b.expirationDate; break;
        case "dbChangeCommitTime": av = a.dbChangeCommitTime; bv = b.dbChangeCommitTime; break;
        default: av = a[sortKey]; bv = b[sortKey];
      }
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const r = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv), "de");
      return sortDir === "asc" ? r : -r;
    };
    return [...filtered].sort(cmp);
  }, [filtered, sortKey, sortDir]);

  const stats = useMemo(() => {
    const totalQty = filtered.reduce((s, r) => s + (r.actualQty ?? 0), 0);
    const uniqueSkus = new Set(filtered.map(r => r.itemNumber)).size;
    const uniqueLocations = new Set(filtered.map(r => r.locationId)).size;
    const expiredCount = filtered.filter(isExpired).length;
    const expiringSoonCount = filtered.filter(isExpiringSoon).length;
    const unavailableQty = filtered.reduce((s, r) => s + (r.unavailableQty ?? 0), 0);
    return { totalQty, uniqueSkus, uniqueLocations, expiredCount, expiringSoonCount, unavailableQty };
  }, [filtered]);

  const zoneCounts = useMemo(() => {
    const map = new Map<string, { count: number; qty: number }>();
    for (const r of rows) {
      const z = classifyZone(r.locationId).label;
      const prev = map.get(z) ?? { count: 0, qty: 0 };
      map.set(z, { count: prev.count + 1, qty: prev.qty + (r.actualQty ?? 0) });
    }
    return [...map.entries()].sort((a, b) => b[1].qty - a[1].qty);
  }, [rows]);

  const statusCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.status, (map.get(r.status) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const grouped = useMemo(() => {
    if (groupBy === "none") return null;
    const map = new Map<string, FullInventoryRow[]>();
    for (const r of sorted) {
      const key = groupBy === "location" ? r.locationId : groupBy === "item" ? r.itemNumber : r.status;
      const arr = map.get(key);
      if (arr) arr.push(r); else map.set(key, [r]);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [sorted, groupBy]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const resetFilters = () => {
    setSearch("");
    setZoneFilter(null);
    setStatusFilter(null);
    setShowExpiredOnly(false);
    setShowExpiringSoon(false);
    setGroupBy("none");
    setVisibleCount(PAGE_SIZE);
  };

  const SortHeader = ({ label, k, className = "" }: { label: string; k: SortKey; className?: string }) => (
    <th
      className={`sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-2 py-1.5 cursor-pointer select-none hover:bg-slate-700 transition-colors ${className}`}
      onClick={() => handleSort(k)}
    >
      {label} {sortKey === k ? (sortDir === "asc" ? "\u25B2" : "\u25BC") : ""}
    </th>
  );

  const triggerDeepSearch = (sku: string) => {
    setDeepSearch(sku);
    runDeepSearch(sku);
    deepSearchRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const SkuCell = ({ sku }: { sku: string }) => (
    <td className="px-2 py-1 text-xs font-mono font-semibold">
      <button
        className="text-left hover:text-verden-600 hover:underline underline-offset-2 transition-colors cursor-pointer"
        onClick={() => triggerDeepSearch(sku)}
        title={`"${sku}" in Snowflake suchen`}
      >{sku}</button>
    </td>
  );

  const RowView = ({ r }: { r: FullInventoryRow }) => {
    const zone = classifyZone(r.locationId);
    const expired = isExpired(r);
    const expiring = isExpiringSoon(r);
    const rowBg = expired ? "bg-red-50" : expiring ? "bg-amber-50" : "";
    return (
      <tr className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${rowBg}`}>
        <td className="px-2 py-1 text-xs font-mono">{r.locationId}</td>
        <td className="px-1 py-1">
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${zone.color}`}>{zone.label}</span>
        </td>
        <SkuCell sku={r.itemNumber} />
        <td className="px-2 py-1 text-xs text-right font-mono tabular-nums">{fmtQty(r.actualQty)}</td>
        <td className="px-2 py-1 text-xs text-right font-mono tabular-nums text-slate-400">{r.unavailableQty ? fmtQty(r.unavailableQty) : ""}</td>
        <td className="px-2 py-1">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${r.status === "A" ? "bg-green-100 text-green-800" : r.status === "H" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"}`}>
            {r.status}
          </span>
        </td>
        <td className="px-2 py-1 text-[10px] font-mono text-slate-500">{r.lotNumber || ""}</td>
        <td className="px-2 py-1 text-[10px] font-mono text-slate-500">{r.huId || ""}</td>
        <td className={`px-2 py-1 text-[10px] tabular-nums ${expired ? "text-red-600 font-bold" : expiring ? "text-amber-600 font-semibold" : "text-slate-500"}`}>
          {fmtDate(r.expirationDate)}
        </td>
        <td className="px-2 py-1 text-[10px] text-slate-500 tabular-nums">{fmtDate(r.fifoDate)}</td>
        <td className="px-2 py-1 text-[10px] text-slate-400 tabular-nums">{fmtDateTime(r.dbChangeCommitTime)}</td>
        <td className="px-2 py-1 text-[10px] text-slate-400 font-mono">{r.reservedFor || ""}</td>
        <td className="px-2 py-1 text-[10px] text-slate-400 font-mono">{r.shipmentNumber || ""}</td>
      </tr>
    );
  };

  const visibleRows = groupBy === "none" ? sorted.slice(0, visibleCount) : [];
  const hasMore = groupBy === "none" && visibleCount < sorted.length;

  return (
    <div className="flex flex-col gap-3">
      {/* Command Bar */}
      <div className="card bg-slate-900 text-white p-3 flex flex-wrap items-center gap-3 sticky top-0 z-30">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold tracking-tight">Lager Komplett</span>
          <span className="text-slate-400 text-xs">Standort VF</span>
        </div>

        <div className="flex-1" />

        <input
          ref={searchRef}
          type="search"
          placeholder="Ctrl+K  SKU / Ort / Los / HU / Lieferung…"
          className="rounded bg-slate-800 border border-slate-600 px-3 py-1.5 text-xs text-slate-200 w-80 placeholder:text-slate-500 focus:ring-2 focus:ring-verden-500 focus:border-transparent outline-none"
          value={search}
          onChange={e => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
        />

        <button
          onClick={loadData}
          disabled={loading}
          className="px-3 py-1.5 text-xs rounded bg-verden-600 hover:bg-verden-500 disabled:opacity-50 transition-colors font-medium"
        >
          {loading ? "Laden…" : "Neu laden"}
        </button>

        {generatedAt && (
          <span className="text-[10px] text-slate-500">{fmtDateTime(generatedAt)}</span>
        )}
      </div>

      {error && (
        <div className="card bg-red-50 border-red-200 p-3 text-red-700 text-sm">{error}</div>
      )}

      {/* Deep Search — Snowflake Supersuche über alle Tabellen */}
      <div className="card p-3">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">Snowflake Supersuche</span>
          <span className="text-[10px] text-slate-400">5 Tabellen parallel: Bestand + Artikelstamm + Transaktionen (30d) + Wareneingang (60d) + Work Orders</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={deepSearchRef}
            type="search"
            placeholder="Ctrl+J  SKU / Beschreibung / WO / PO / Los / HU / Lieferung…"
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-verden-500 focus:border-transparent outline-none"
            value={deepSearch}
            onChange={e => handleDeepSearchChange(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && deepSearch.trim().length >= 2) runDeepSearch(deepSearch.trim()); }}
          />
          <button
            onClick={() => runDeepSearch(deepSearch.trim())}
            disabled={deepLoading || deepSearch.trim().length < 2}
            className="px-4 py-2 text-sm rounded bg-verden-600 text-white hover:bg-verden-500 disabled:opacity-50 transition-colors font-medium"
          >
            {deepLoading ? "Suche…" : "Suchen"}
          </button>
        </div>
        {deepError && <div className="mt-2 text-sm text-red-600">{deepError}</div>}

        {deepResult && (
          <div className="mt-3">
            {/* Tab bar */}
            <div className="flex gap-1 border-b border-slate-200 mb-2">
              {([
                { key: "stored" as const, label: "Bestand", count: deepResult.stored.count },
                { key: "itemMaster" as const, label: "Artikelstamm", count: deepResult.itemMaster.count },
                { key: "transactions" as const, label: "Transaktionen", count: deepResult.transactions.count },
                { key: "receipts" as const, label: "Wareneingang", count: deepResult.receipts.count },
                { key: "workorders" as const, label: "Work Orders", count: deepResult.workorders.count },
              ]).map(tab => (
                <button
                  key={tab.key}
                  className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${activeDeepTab === tab.key ? "bg-white border border-b-0 border-slate-200 text-slate-800" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"}`}
                  onClick={() => setActiveDeepTab(tab.key)}
                >
                  {tab.label}
                  <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold ${tab.count > 0 ? "bg-verden-100 text-verden-700" : "bg-slate-100 text-slate-400"}`}>
                    {tab.count}
                  </span>
                </button>
              ))}
              <span className="ml-auto text-[10px] text-slate-400 self-center">{fmtDateTime(deepResult.generatedAt)}</span>
            </div>

            {/* Tab content */}
            <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
              {activeDeepTab === "stored" && deepResult.stored.count > 0 && (
                <table className="w-full text-left">
                  <thead><tr className="bg-slate-100">
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Stellplatz</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Artikel</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Beschreibung</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500 text-right">Menge</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Status</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Los</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">HU</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">MHD</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Letzte Änd.</th>
                  </tr></thead>
                  <tbody>
                    {deepResult.stored.rows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                        <td className="px-2 py-1 text-xs font-mono">{r.locationId}</td>
                        <SkuCell sku={r.itemNumber} />
                        <td className="px-2 py-1 text-[10px] text-slate-600 max-w-[200px] truncate">{r.description}</td>
                        <td className="px-2 py-1 text-xs text-right font-mono tabular-nums">{fmtQty(r.actualQty)}</td>
                        <td className="px-2 py-1"><span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${r.status === "A" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700"}`}>{r.status}</span></td>
                        <td className="px-2 py-1 text-[10px] font-mono text-slate-500">{r.lotNumber}</td>
                        <td className="px-2 py-1 text-[10px] font-mono text-slate-500">{r.huId}</td>
                        <td className="px-2 py-1 text-[10px] text-slate-500 tabular-nums">{fmtDate(r.expirationDate)}</td>
                        <td className="px-2 py-1 text-[10px] text-slate-400 tabular-nums">{fmtDateTime(r.dbChangeCommitTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {activeDeepTab === "itemMaster" && deepResult.itemMaster.count > 0 && (
                <table className="w-full text-left">
                  <thead><tr className="bg-slate-100">
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Artikel</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Beschreibung</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Klasse</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">UOM</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Haltbarkeit</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Kategorie</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Status</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Meal Nr.</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Gewicht</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Pick Loc.</th>
                  </tr></thead>
                  <tbody>
                    {deepResult.itemMaster.rows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                        <SkuCell sku={r.itemNumber} />
                        <td className="px-2 py-1 text-[10px] text-slate-600 max-w-[250px] truncate">{r.description}</td>
                        <td className="px-2 py-1 text-[10px] font-mono">{r.classId}</td>
                        <td className="px-2 py-1 text-[10px]">{r.uom}</td>
                        <td className="px-2 py-1 text-[10px] tabular-nums">{r.shelfLife != null ? `${r.shelfLife}d` : ""}</td>
                        <td className="px-2 py-1 text-[10px]">{[r.invCat, r.invClass].filter(Boolean).join(" / ")}</td>
                        <td className="px-2 py-1"><span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${r.itemStatus === "A" ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-600"}`}>{r.itemStatus}</span></td>
                        <td className="px-2 py-1 text-[10px] font-mono">{r.mealNumber}</td>
                        <td className="px-2 py-1 text-[10px] tabular-nums">{r.unitWeight != null ? `${r.unitWeight}` : ""}</td>
                        <td className="px-2 py-1 text-[10px] font-mono">{r.pickLocation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {activeDeepTab === "transactions" && deepResult.transactions.count > 0 && (
                <table className="w-full text-left">
                  <thead><tr className="bg-slate-100">
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Datum</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Typ</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Beschreibung</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Artikel</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500 text-right">Menge</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Von</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Nach</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">WO/Control</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Mitarbeiter</th>
                  </tr></thead>
                  <tbody>
                    {deepResult.transactions.rows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                        <td className="px-2 py-1 text-[10px] tabular-nums text-slate-500">{fmtDateTime(r.tranDate)}</td>
                        <td className="px-2 py-1"><span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 font-mono">{r.tranType}</span></td>
                        <td className="px-2 py-1 text-[10px] text-slate-600 max-w-[180px] truncate">{r.description}</td>
                        <SkuCell sku={r.itemNumber} />
                        <td className="px-2 py-1 text-xs text-right font-mono tabular-nums">{fmtQty(r.tranQty)}</td>
                        <td className="px-2 py-1 text-[10px] font-mono">{r.locationId}</td>
                        <td className="px-2 py-1 text-[10px] font-mono">{r.locationId2}</td>
                        <td className="px-2 py-1 text-[10px] font-mono text-slate-500">{r.controlNumber}</td>
                        <td className="px-2 py-1 text-[10px] text-slate-400">{r.employeeId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {activeDeepTab === "receipts" && deepResult.receipts.count > 0 && (
                <table className="w-full text-left">
                  <thead><tr className="bg-slate-100">
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Datum</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">PO</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Artikel</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500 text-right">Empfangen</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500 text-right">Beschädigt</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Lieferant</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Los</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Lieferung</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Status</th>
                  </tr></thead>
                  <tbody>
                    {deepResult.receipts.rows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                        <td className="px-2 py-1 text-[10px] tabular-nums text-slate-500">{fmtDate(r.receiptDate)}</td>
                        <td className="px-2 py-1 text-xs font-mono">{r.poNumber}</td>
                        <SkuCell sku={r.itemNumber} />
                        <td className="px-2 py-1 text-xs text-right font-mono tabular-nums">{fmtQty(r.qtyReceived)}</td>
                        <td className="px-2 py-1 text-xs text-right font-mono tabular-nums text-red-500">{r.qtyDamaged ? fmtQty(r.qtyDamaged) : ""}</td>
                        <td className="px-2 py-1 text-[10px]">{r.vendorCode}</td>
                        <td className="px-2 py-1 text-[10px] font-mono text-slate-500">{r.lotNumber}</td>
                        <td className="px-2 py-1 text-[10px] font-mono text-slate-500">{r.shipmentNumber}</td>
                        <td className="px-2 py-1"><span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${r.status === "A" ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-600"}`}>{r.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {activeDeepTab === "workorders" && deepResult.workorders.count > 0 && (
                <table className="w-full text-left">
                  <thead><tr className="bg-slate-100">
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">WO</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">KW</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Submeal SKU</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Submeal</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Meal SKU</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Meal</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500 text-right">Menge</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500 text-right">Teller</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Status</th>
                    <th className="px-2 py-1 text-[10px] uppercase text-slate-500">Produktion</th>
                  </tr></thead>
                  <tbody>
                    {deepResult.workorders.rows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                        <td className="px-2 py-1 text-xs font-mono font-semibold">{r.woNumber}</td>
                        <td className="px-2 py-1 text-[10px]">{r.week}</td>
                        <td className="px-2 py-1 text-[10px] font-mono">{r.submealItemNumber}</td>
                        <td className="px-2 py-1 text-[10px] text-slate-600 max-w-[150px] truncate">{r.submealDescription}</td>
                        <td className="px-2 py-1 text-[10px] font-mono">{r.mealItemNumber}</td>
                        <td className="px-2 py-1 text-[10px] text-slate-600 max-w-[150px] truncate">{r.mealDescription}</td>
                        <td className="px-2 py-1 text-xs text-right font-mono tabular-nums">{fmtQty(r.quantity)}</td>
                        <td className="px-2 py-1 text-xs text-right font-mono tabular-nums">{r.plates != null ? fmtQty(r.plates) : ""}</td>
                        <td className="px-2 py-1"><span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 font-medium">{r.status}</span></td>
                        <td className="px-2 py-1 text-[10px] tabular-nums text-slate-500">{fmtDateTime(r.productionTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {deepResult[activeDeepTab].count === 0 && (
                <div className="py-6 text-center text-slate-400 text-sm">Keine Treffer in dieser Kategorie.</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* KPI Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {[
          { label: "Positionen", value: filtered.length.toLocaleString("de-DE"), sub: `von ${totalRows.toLocaleString("de-DE")}`, icon: "#" },
          { label: "Gesamtmenge", value: fmtQty(stats.totalQty), sub: stats.unavailableQty > 0 ? `${fmtQty(stats.unavailableQty)} gesperrt` : "", icon: "S" },
          { label: "Artikel (SKU)", value: stats.uniqueSkus.toLocaleString("de-DE"), sub: "", icon: "A" },
          { label: "Stellplätze", value: stats.uniqueLocations.toLocaleString("de-DE"), sub: "", icon: "L" },
          { label: "Abgelaufen", value: stats.expiredCount.toLocaleString("de-DE"), sub: "", icon: "!", color: stats.expiredCount > 0 ? "text-red-600" : "" },
          { label: "Läuft bald ab", value: stats.expiringSoonCount.toLocaleString("de-DE"), sub: "< 3 Tage", icon: "W", color: stats.expiringSoonCount > 0 ? "text-amber-600" : "" },
        ].map(kpi => (
          <div key={kpi.label} className="card p-2.5 flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">{kpi.label}</span>
            <span className={`text-xl font-bold tabular-nums ${kpi.color ?? "text-slate-800"}`}>{kpi.value}</span>
            {kpi.sub && <span className="text-[10px] text-slate-400">{kpi.sub}</span>}
          </div>
        ))}
      </div>

      {/* Filter Bar */}
      <div className="card p-2 flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mr-1">Zone</span>
        <button
          className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${!zoneFilter ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          onClick={() => setZoneFilter(null)}
        >Alle</button>
        {zoneCounts.map(([zone, { count, qty }]) => (
          <button
            key={zone}
            className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${zoneFilter === zone ? "bg-slate-800 text-white" : `${classifyZone(zone === "Sonstige" ? "XXX" : zone).color} hover:opacity-80`}`}
            onClick={() => setZoneFilter(zoneFilter === zone ? null : zone)}
          >
            {zone} ({count} / {fmtQty(qty)})
          </button>
        ))}

        <span className="mx-2 h-4 border-l border-slate-200" />

        <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mr-1">Status</span>
        <button
          className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${!statusFilter ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
          onClick={() => setStatusFilter(null)}
        >Alle</button>
        {statusCounts.map(([st, count]) => (
          <button
            key={st}
            className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${statusFilter === st ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
            onClick={() => setStatusFilter(statusFilter === st ? null : st)}
          >
            {st} ({count})
          </button>
        ))}

        <span className="mx-2 h-4 border-l border-slate-200" />

        <button
          className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${showExpiredOnly ? "bg-red-600 text-white" : "bg-red-50 text-red-600 hover:bg-red-100"}`}
          onClick={() => { setShowExpiredOnly(!showExpiredOnly); setShowExpiringSoon(false); }}
        >Abgelaufen ({stats.expiredCount})</button>
        <button
          className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${showExpiringSoon ? "bg-amber-500 text-white" : "bg-amber-50 text-amber-600 hover:bg-amber-100"}`}
          onClick={() => { setShowExpiringSoon(!showExpiringSoon); setShowExpiredOnly(false); }}
        >Bald ablaufend ({stats.expiringSoonCount})</button>

        <span className="mx-2 h-4 border-l border-slate-200" />

        <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mr-1">Gruppierung</span>
        {(["none", "location", "item", "status"] as GroupBy[]).map(g => (
          <button
            key={g}
            className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${groupBy === g ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
            onClick={() => { setGroupBy(g); setVisibleCount(PAGE_SIZE); setCollapsedGroups(new Set()); }}
          >
            {{ none: "Keine", location: "Stellplatz", item: "Artikel", status: "Status" }[g]}
          </button>
        ))}

        {(search || zoneFilter || statusFilter || showExpiredOnly || showExpiringSoon || groupBy !== "none") && (
          <>
            <span className="mx-2 h-4 border-l border-slate-200" />
            <button
              className="text-[10px] px-2 py-0.5 rounded-full bg-slate-200 text-slate-600 hover:bg-slate-300 transition-colors"
              onClick={resetFilters}
            >Filter zurücksetzen</button>
          </>
        )}
      </div>

      {/* Result Count */}
      <div className="flex items-center gap-2 px-1">
        <span className="text-xs text-slate-500">
          {filtered.length === rows.length
            ? `${rows.length.toLocaleString("de-DE")} Positionen`
            : `${filtered.length.toLocaleString("de-DE")} von ${rows.length.toLocaleString("de-DE")} Positionen`}
        </span>
      </div>

      {/* Data Table */}
      {loading && rows.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-slate-400 text-lg animate-pulse">Lade gesamten Lagerbestand…</div>
        </div>
      ) : grouped ? (
        <div className="flex flex-col gap-2">
          {grouped.map(([key, gRows]) => {
            const collapsed = collapsedGroups.has(key);
            const gQty = gRows.reduce((s, r) => s + (r.actualQty ?? 0), 0);
            return (
              <div key={key} className="card overflow-hidden">
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
                  onClick={() => toggleGroup(key)}
                >
                  <span className="text-[10px] text-slate-400">{collapsed ? "\u25B6" : "\u25BC"}</span>
                  <span className="text-xs font-semibold font-mono">{key || "(leer)"}</span>
                  {groupBy === "location" && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${classifyZone(key).color}`}>
                      {classifyZone(key).label}
                    </span>
                  )}
                  <span className="text-[10px] text-slate-400 ml-auto">{gRows.length} Pos. / {fmtQty(gQty)} Stk.</span>
                </button>
                {!collapsed && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr>
                          <SortHeader label="Stellplatz" k="locationId" />
                          <th className="sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-1 py-1.5">Zone</th>
                          <SortHeader label="Artikel" k="itemNumber" />
                          <SortHeader label="Menge" k="actualQty" className="text-right" />
                          <th className="sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-2 py-1.5 text-right">Gesperrt</th>
                          <SortHeader label="Status" k="status" />
                          <SortHeader label="Los" k="lotNumber" />
                          <th className="sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-2 py-1.5">HU</th>
                          <SortHeader label="MHD" k="expirationDate" />
                          <SortHeader label="FIFO" k="fifoDate" />
                          <SortHeader label="Letzte Änd." k="dbChangeCommitTime" />
                          <th className="sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-2 py-1.5">Reserviert</th>
                          <th className="sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-2 py-1.5">Lieferung</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gRows.map((r, i) => <RowView key={i} r={r} />)}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr>
                  <SortHeader label="Stellplatz" k="locationId" />
                  <th className="sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-1 py-1.5">Zone</th>
                  <SortHeader label="Artikel" k="itemNumber" />
                  <SortHeader label="Menge" k="actualQty" className="text-right" />
                  <th className="sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-2 py-1.5 text-right">Gesperrt</th>
                  <SortHeader label="Status" k="status" />
                  <SortHeader label="Los" k="lotNumber" />
                  <th className="sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-2 py-1.5">HU</th>
                  <SortHeader label="MHD" k="expirationDate" />
                  <SortHeader label="FIFO" k="fifoDate" />
                  <SortHeader label="Letzte Änd." k="dbChangeCommitTime" />
                  <th className="sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-2 py-1.5">Reserviert</th>
                  <th className="sticky top-0 bg-slate-800 text-slate-300 text-[10px] uppercase tracking-wider px-2 py-1.5">Lieferung</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r, i) => <RowView key={i} r={r} />)}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <button
              className="w-full py-2 text-xs text-slate-500 hover:bg-slate-50 transition-colors border-t border-slate-100"
              onClick={() => setVisibleCount(v => v + PAGE_SIZE)}
            >
              {sorted.length - visibleCount} weitere anzeigen…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
