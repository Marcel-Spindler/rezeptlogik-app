import { useEffect, useMemo, useState } from "react";
import type { DataBundle, Market, Recipe, ShelfLifeInfo, WeekRecipe } from "../../../core/types";
import {
  categoryRiskTone, findShelfLifeNameHint, fmtNum, ingredientSectionTone,
  matchesNeedle, scaleQty, shelfLifeTone, MARKET_LABEL,
} from "../../../lib/helpers";
import { Stat } from "../shared";
import { WeeklyOrderAggregation } from "../WeeklyOrderAggregation";

interface Props {
  recipe: Recipe;
  market: Market;
  portionsTotal: number;
  wr: WeekRecipe;
  shelfLifeBySku: Record<string, ShelfLifeInfo>;
  generatedAt: string;
  detailSearch: string;
  data?: DataBundle;
  selectedWeek?: string;
  upliftPercent?: number;
}

interface GroupedRow {
  sub: string; ingredient: string; ingredientId: string; uom: string; perPortion: number; cat?: string;
  shelfLife?: ShelfLifeInfo;
  suggested?: ReturnType<typeof findShelfLifeNameHint>;
  matchReason: string;
}

const COLLAPSE_STORAGE_PREFIX = "rezeptlogik-ingredient-collapse-v1";

function groupIngredients(list: Recipe["grossIngredients"][Market], shelfLifeBySku: Record<string, ShelfLifeInfo>): GroupedRow[] {
  const rows = list ?? [];
  const bySubAndSku = new Map<string, Omit<GroupedRow, "shelfLife" | "suggested" | "matchReason">>();
  for (const g of rows) {
    const sub = g.subRecipe1 || g.subRecipe2 || g.subRecipe3 || "—";
    const key = `${sub}::${g.ingredientId}::${g.uom}`;
    const existing = bySubAndSku.get(key);
    if (existing) existing.perPortion += g.grossQuantityPerPortion;
    else bySubAndSku.set(key, { sub, ingredient: g.ingredient, ingredientId: g.ingredientId, uom: g.uom, perPortion: g.grossQuantityPerPortion, cat: g.ingredientCategory });
  }
  return [...bySubAndSku.values()]
    .map(row => {
      const shelfLife = shelfLifeBySku[row.ingredientId];
      const suggested = shelfLife ? undefined : findShelfLifeNameHint(row.ingredient, shelfLifeBySku);
      const matchReason = shelfLife
        ? `exakter SKU-Match: ${row.ingredientId}`
        : !row.ingredientId
          ? "keine Ingredient-ID im Gross-Export"
          : suggested
            ? `kein ID-Match, aber ähnliche Sheet-SKU: ${suggested.skuCode}`
            : `SKU ${row.ingredientId} nicht im Shelf-Life-Sheet`;
      return { ...row, shelfLife, suggested, matchReason };
    })
    .sort((a, b) => (a.sub === b.sub ? b.perPortion - a.perPortion : a.sub.localeCompare(b.sub)));
}

function buildSections(rows: GroupedRow[]) {
  const bySub = new Map<string, GroupedRow[]>();
  for (const row of rows) {
    const bucket = bySub.get(row.sub) ?? [];
    bucket.push(row);
    bySub.set(row.sub, bucket);
  }
  return [...bySub.entries()]
    .map(([sub, subRows]) => {
      const categoryBuckets = new Map<string, Map<string, number>>();
      for (const row of subRows) {
        const key = row.cat?.trim() || "ohne Kategorie";
        const bucket = categoryBuckets.get(key) ?? new Map<string, number>();
        bucket.set(row.uom, (bucket.get(row.uom) ?? 0) + row.perPortion);
        categoryBuckets.set(key, bucket);
      }
      const categoryTotals = [...categoryBuckets.entries()]
        .map(([category, totals]) => {
          const rowsInCat = subRows.filter(r => (r.cat?.trim() || "ohne Kategorie") === category);
          const riskStatus: ShelfLifeInfo["status"] | "unknown" =
            rowsInCat.some(r => r.shelfLife?.status === "critical") ? "critical" :
            rowsInCat.some(r => r.shelfLife?.status === "risk") ? "risk" :
            rowsInCat.some(r => r.shelfLife?.status === "ok") ? "ok" : "unknown";
          return { category, riskStatus, totals: [...totals.entries()].map(([uom, total]) => ({ uom, total })) };
        })
        .sort((a, b) => a.category.localeCompare(b.category));

      const unitBuckets = new Map<string, number>();
      for (const row of subRows) unitBuckets.set(row.uom, (unitBuckets.get(row.uom) ?? 0) + row.perPortion);
      const unitTotals = [...unitBuckets.entries()].map(([uom, total]) => ({ uom, total })).sort((a, b) => a.uom.localeCompare(b.uom));

      return { sub, rows: subRows, categoryTotals, unitTotals };
    })
    .sort((a, b) => a.sub.localeCompare(b.sub));
}

function useCollapsedSections(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(window.localStorage.getItem(storageKey) ?? "{}"); } catch { return {}; }
  });

  // Re-read when storageKey changes (different recipe/market selected)
  useEffect(() => {
    try { setCollapsed(JSON.parse(window.localStorage.getItem(storageKey) ?? "{}")); } catch { setCollapsed({}); }
  }, [storageKey]);

  useEffect(() => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(collapsed)); } catch { /* quota */ }
  }, [storageKey, collapsed]);

  return [collapsed, setCollapsed] as const;
}

function IngredientSection({ section, index, collapsed, onToggle, portionsTotal }: {
  section: ReturnType<typeof buildSections>[number];
  index: number;
  collapsed: boolean;
  onToggle: () => void;
  portionsTotal: number;
}) {
  const tone = ingredientSectionTone(index);
  return (
    <div className={`rounded-2xl border bg-white shadow-sm overflow-hidden ${tone.frame}`}>
      <button className={`flex w-full flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-left ${tone.header} ${tone.frame}`} onClick={onToggle}>
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Sub-Rezept</div>
          <h4 className={`text-base font-semibold ${tone.headerText}`}>{section.sub}</h4>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
          <span className={tone.badge}>{fmtNum(section.rows.length)} Zutaten</span>
          {section.unitTotals.map(t => <span key={`${section.sub}-${t.uom}`} className={tone.badge}>Σ {scaleQty(t.total, 1, t.uom)} / Portion</span>)}
          <span className={`rounded-full px-2.5 py-1 font-semibold uppercase tracking-wide ${collapsed ? "bg-slate-200 text-slate-600" : "bg-slate-800 text-white"}`}>{collapsed ? "zu" : "offen"}</span>
        </div>
      </button>
      {!collapsed && (
        <>
          <div className="border-b border-slate-100 bg-white px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Kategorien im Block</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {section.categoryTotals.map(cat => (
                <span key={`${section.sub}-${cat.category}`} className={`pill text-xs ${categoryRiskTone(cat.riskStatus)}`}>
                  {cat.category}: {cat.totals.map(t => scaleQty(t.total, 1, t.uom)).join(" · ")}
                </span>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500 bg-white">
                <tr className="border-b border-slate-100">
                  <th className="text-left py-2 pr-2 pl-4">Zutat</th>
                  <th className="text-left py-2 pr-2">Cat</th>
                  <th className="text-right py-2 pr-2">/ Portion</th>
                  <th className="text-right py-2 pr-2">Σ {fmtNum(portionsTotal)} Portionen</th>
                  <th className="text-left py-2 pr-4 pl-2">Shelf / MLOR</th>
                </tr>
              </thead>
              <tbody>
                {section.rows.map((g, i) => (
                  <tr key={`${section.sub}-${g.ingredientId}-${i}`} className="border-b border-slate-100 last:border-0 align-top hover:bg-slate-50/80">
                    <td className="py-2 pr-2 pl-4">
                      <div className="font-medium text-slate-800">{g.ingredient}</div>
                      <div className="font-mono text-[10px] text-slate-400">{g.ingredientId || "ohne SKU"}</div>
                    </td>
                    <td className="py-2 pr-2"><span className="pill bg-slate-100 text-slate-700">{g.cat ?? "-"}</span></td>
                    <td className="py-2 pr-2 text-right tabular-nums">{fmtNum(g.perPortion, 2)} {g.uom}</td>
                    <td className="py-2 pr-2 text-right tabular-nums font-semibold">{scaleQty(g.perPortion, portionsTotal, g.uom)}</td>
                    <td className="py-2 pl-2 pr-4 text-xs">
                      {g.shelfLife ? (
                        <div className="space-y-1">
                          <span className={`pill ${shelfLifeTone(g.shelfLife.status)}`}>
                            {g.shelfLife.status === "critical" ? "kritisch" : g.shelfLife.status === "risk" ? "knapp" : g.shelfLife.status === "ok" ? "ok" : "unbekannt"}
                          </span>
                          <div className="font-mono text-[10px] text-slate-500">{g.matchReason}</div>
                          <div className="text-slate-600">MLOR: {g.shelfLife.mlorRaw ?? "-"}</div>
                          <div className="text-slate-600">Open: {g.shelfLife.openShelfLifeRaw ?? "-"}</div>
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <span className="text-slate-400">kein Sheet-Match</span>
                          <div className="font-mono text-[10px] text-slate-500">{g.matchReason}</div>
                          {g.suggested && <div className="text-[10px] text-blue-700">Namenshinweis: {g.suggested.skuCode} · {g.suggested.skuName}</div>}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={`flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs ${tone.header} ${tone.frame}`}>
            <div className="font-semibold text-slate-600">Summen für {section.sub}</div>
            <div className="flex flex-wrap gap-2">
              {section.unitTotals.map(t => (
                <span key={`${section.sub}-footer-${t.uom}`} className={tone.badge}>
                  {t.uom}: {scaleQty(t.total, 1, t.uom)} / Portion · {scaleQty(t.total, portionsTotal, t.uom)} gesamt
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function IngredientsTab({ recipe, market, portionsTotal, wr, shelfLifeBySku, generatedAt, detailSearch, data, selectedWeek, upliftPercent }: Props) {
  const [showWeeklyAgg, setShowWeeklyAgg] = useState(false);
  const list = useMemo(() => recipe.grossIngredients[market] ?? [], [recipe.grossIngredients, market]);
  const grouped = useMemo(() => groupIngredients(list, shelfLifeBySku), [list, shelfLifeBySku]);

  const needle = detailSearch.trim().toLowerCase();
  const filteredGrouped = useMemo(
    () => grouped.filter(g => matchesNeedle([g.sub, g.ingredient, g.ingredientId, g.cat, g.shelfLife?.skuCode, g.shelfLife?.skuName], needle)),
    [grouped, needle]
  );
  const sections = useMemo(() => buildSections(filteredGrouped), [filteredGrouped]);

  const shelfSummary = useMemo(() => {
    const known = filteredGrouped.filter(g => !!g.shelfLife);
    return { known: known.length, critical: known.filter(g => g.shelfLife?.status === "critical").length, risk: known.filter(g => g.shelfLife?.status === "risk").length };
  }, [filteredGrouped]);

  const collapseStorageKey = useMemo(() => `${COLLAPSE_STORAGE_PREFIX}:${wr.code}:${market}`, [wr.code, market]);
  const [collapsedSections, setCollapsedSections] = useCollapsedSections(collapseStorageKey);
  const allCollapsed = sections.length > 0 && sections.every(s => collapsedSections[s.sub]);

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-slate-700">
          Brutto-Zutaten ({MARKET_LABEL[market]}) — hochgerechnet auf <b>{fmtNum(portionsTotal)}</b> Portionen Verden gesamt
        </h3>
        <div className="text-right">
          <div className="text-xs text-slate-500">{list.length} Zeilen aus Gross-Export</div>
          <div className="text-[11px] text-slate-400">Datenstand: {new Date(generatedAt).toLocaleString("de-DE")}</div>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <Stat label="Sheet-Matches" value={fmtNum(shelfSummary.known)} />
        <Stat label="kritisch < 7d" value={fmtNum(shelfSummary.critical)} accent={shelfSummary.critical > 0} />
        <Stat label="knapp" value={fmtNum(shelfSummary.risk)} accent={shelfSummary.risk > 0} />
        <Stat label="Kundenziel" value="7 Tage" />
      </div>
      {data && selectedWeek && upliftPercent !== undefined && (
        <div className="mb-3">
          <button
            className={`btn text-xs ${showWeeklyAgg ? "bg-teal-600 text-white ring-teal-700" : ""}`}
            onClick={() => setShowWeeklyAgg(s => !s)}
          >
            {showWeeklyAgg ? "Wochenbestellung ausblenden" : "Wochenbestellung anzeigen (alle Rezepte)"}
          </button>
          {showWeeklyAgg && (
            <div className="mt-3">
              <WeeklyOrderAggregation data={data} selectedWeek={selectedWeek} upliftPercent={upliftPercent} />
            </div>
          )}
        </div>
      )}
      {sections.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
          <div className="text-xs text-slate-500">{fmtNum(sections.length)} Sub-Rezept-Blöcke sichtbar.</div>
          <button className="btn" onClick={() => setCollapsedSections(Object.fromEntries(sections.map(s => [s.sub, !allCollapsed])))}>
            {allCollapsed ? "Alle aufklappen" : "Alle einklappen"}
          </button>
        </div>
      )}
      {list.length === 0 && <div className="text-slate-500 text-sm">Keine Brutto-Daten für {MARKET_LABEL[market]}.</div>}
      <div className="space-y-4">
        {sections.map((section, index) => (
          <IngredientSection
            key={section.sub} section={section} index={index} portionsTotal={portionsTotal}
            collapsed={!!collapsedSections[section.sub]}
            onToggle={() => setCollapsedSections(prev => ({ ...prev, [section.sub]: !prev[section.sub] }))}
          />
        ))}
      </div>
      {list.length > 0 && filteredGrouped.length === 0 && <div className="mt-3 text-sm text-slate-500">Keine Zutaten-Treffer für diese Suche.</div>}
    </div>
  );
}
