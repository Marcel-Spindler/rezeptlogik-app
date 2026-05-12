import { useEffect, useMemo, useState } from "react";
import type { DataBundle, WeekRecipe } from "./types";

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

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

function wmsRecipeId(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().toUpperCase();
  return value.startsWith("REC-") ? value : null;
}

function isProducedInVerden(r: WeekRecipe): boolean {
  const c = (r.code ?? "").toUpperCase();
  if (!(c.startsWith("FE") || c.startsWith("FV"))) return false;
  return (r.verdenVolume.BENL ?? 0) + (r.verdenVolume.DKSE ?? 0) + (r.verdenVolume.DE ?? 0) > 0;
}

function stationTone(status: string): string {
  if (status === "AKTIV") return "bg-emerald-50 text-emerald-900 ring-emerald-200";
  if (status === "STILL") return "bg-rose-50 text-rose-900 ring-rose-200";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

async function loadWmsLive(week: string): Promise<WmsLivePayload> {
  const response = await fetch(`/api/wms-live?week=${encodeURIComponent(week)}`, { cache: "no-store" });
  const text = await response.text();
  let payload: WmsLivePayload;
  try {
    payload = JSON.parse(text) as WmsLivePayload;
  } catch {
    throw new Error("WMS API ist lokal nicht erreichbar. Im Firebase Hosting laeuft sie unter /api/wms-live.");
  }
  if (!response.ok) return payload;
  return payload;
}

export function WmsLiveView({ data, week }: Props): JSX.Element {
  const [payload, setPayload] = useState<WmsLivePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadWmsLive(week)
      .then((result) => {
        if (cancelled) return;
        setPayload(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setPayload(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [week, reloadTick]);

  const planRows = useMemo(() => {
    const actualByRecipeId = new Map<string, number>();
    for (const item of payload?.items ?? []) {
      const recipeId = wmsRecipeId(item.itemNumber);
      if (!recipeId) continue;
      actualByRecipeId.set(recipeId, (actualByRecipeId.get(recipeId) ?? 0) + item.qty);
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
        };
      })
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [data.structures, data.weekRecipes, payload?.items, week]);

  const kpis = useMemo(() => {
    const planned = planRows.reduce((sum, row) => sum + row.planned, 0);
    const actualMatched = planRows.reduce((sum, row) => sum + row.actual, 0);
    const totalWms = (payload?.stations ?? []).reduce((sum, row) => sum + row.qty, 0);
    const critical = planRows.filter(row => row.mapped && row.planned > 0 && row.progressPct < 90).length;
    const mapped = planRows.filter(row => row.mapped).length;
    return { planned, actualMatched, totalWms, critical, mapped };
  }, [payload?.stations, planRows]);

  const notConfigured = payload && payload.configured === false;

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-black text-slate-900">WMS Live Soll/Ist</h3>
            <p className="mt-1 text-sm text-slate-600">
              Live-Bestand aus Snowflake/HighJump gegen Planning-OASE-Verden-Plan.
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
          </div>
        )}

        {notConfigured && (
          <div className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
            Snowflake ist noch nicht fuer die Firebase Function konfiguriert. Benoetigt werden serverseitig:
            <span className="ml-1 font-mono">{payload.requiredEnv?.join(", ") ?? "SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD"}</span>.
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-700 ring-1 ring-slate-200">
            {error}
          </div>
        )}

        {payload?.configured && payload.error && (
          <div className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">
            Snowflake-Fehler: {payload.error}
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 text-xs">
          <LiveStat label="Plan Verden" value={fmtNum(kpis.planned)} />
          <LiveStat label="REC gematcht" value={fmtNum(kpis.actualMatched)} accent />
          <LiveStat label="WMS gesamt" value={fmtNum(kpis.totalWms)} />
          <LiveStat label="Meals mapped" value={`${fmtNum(kpis.mapped)} / ${fmtNum(planRows.length)}`} accent={kpis.critical > 0} />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
        {(payload?.stations ?? []).map(station => (
          <div key={station.station} className={`rounded-xl p-3 ring-1 ${stationTone(station.status)}`}>
            <div className="text-[10px] font-bold uppercase tracking-wide opacity-70">{station.station}</div>
            <div className="mt-1 text-sm font-black">{station.label}</div>
            <div className="mt-2 text-2xl font-black tabular-nums">{fmtNum(station.qty)}</div>
            <div className="mt-1 text-[11px] opacity-80">
              {fmtNum(station.skuCount)} SKUs · {fmtNum(station.locationCount)} Locations · {station.status}
            </div>
          </div>
        ))}
        {payload?.configured && (payload.stations ?? []).length === 0 && !loading && (
          <div className="card p-4 text-sm text-slate-500">Keine WMS-Bestaende fuer {week} gefunden.</div>
        )}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-bold text-slate-800">Meal-Abgleich</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="py-2 pr-2 text-left">Meal</th>
                <th className="py-2 pr-2 text-right">Plan</th>
                <th className="py-2 pr-2 text-right">WMS Ist</th>
                <th className="py-2 pr-2 text-right">Delta</th>
                <th className="py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {planRows.slice(0, 80).map(row => {
                const isLow = row.mapped && row.planned > 0 && row.progressPct < 90;
                const isOver = row.progressPct > 110;
                return (
                  <tr key={row.code} className="border-b last:border-0">
                    <td className="py-2 pr-2">
                      <div className="font-mono text-xs text-slate-500">{row.code}</div>
                      {row.recipeId && <div className="font-mono text-[10px] text-slate-400">{row.recipeId}</div>}
                      <div className="max-w-lg truncate text-slate-800">{row.name}</div>
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">{fmtNum(row.planned)}</td>
                    <td className="py-2 pr-2 text-right tabular-nums font-semibold">{fmtNum(row.actual)}</td>
                    <td className={`py-2 pr-2 text-right tabular-nums font-semibold ${row.delta < 0 ? "text-rose-700" : row.delta > 0 ? "text-amber-700" : "text-emerald-700"}`}>
                      {row.delta > 0 ? "+" : ""}{fmtNum(row.delta)}
                    </td>
                    <td className="py-2">
                      <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ring-1 ${
                        !row.mapped ? "bg-slate-50 text-slate-700 ring-slate-200" : isLow ? "bg-rose-50 text-rose-800 ring-rose-200" : isOver ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-emerald-50 text-emerald-800 ring-emerald-200"
                      }`}>
                        {!row.mapped ? "kein REC-Mapping" : isLow ? "nacharbeiten" : isOver ? "Ueberhang pruefen" : "im Soll"}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {planRows.length === 0 && (
                <tr>
                  <td className="py-4 text-slate-500" colSpan={5}>Keine Plan-Meals fuer diese KW.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-bold text-slate-800">WMS Artikel-Detail</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="uppercase tracking-wide text-slate-500">
              <tr className="border-b">
                <th className="py-2 pr-2 text-left">Station</th>
                <th className="py-2 pr-2 text-left">Location</th>
                <th className="py-2 pr-2 text-left">Typ</th>
                <th className="py-2 pr-2 text-left">Artikel</th>
                <th className="py-2 pr-2 text-right">Menge</th>
                <th className="py-2 text-left">MHD</th>
              </tr>
            </thead>
            <tbody>
              {(payload?.items ?? []).slice(0, 250).map((item, index) => (
                <tr key={`${item.station}-${item.locationId}-${item.itemNumber}-${index}`} className="border-b last:border-0">
                  <td className="py-1.5 pr-2">{item.stationLabel}</td>
                  <td className="py-1.5 pr-2 font-mono text-[10px] text-slate-500">{item.locationId}</td>
                  <td className="py-1.5 pr-2 text-[10px] text-slate-500">{item.itemPrefix ?? "-"}</td>
                  <td className="py-1.5 pr-2 font-mono text-[10px] text-slate-700">{item.itemNumber}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums font-semibold">{fmtNum(item.qty)}</td>
                  <td className="py-1.5 text-slate-500">{item.earliestMhd ? new Date(item.earliestMhd).toLocaleDateString("de-DE") : "-"}</td>
                </tr>
              ))}
              {(payload?.items ?? []).length === 0 && (
                <tr>
                  <td className="py-4 text-slate-500" colSpan={5}>Noch keine WMS-Artikel geladen.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function LiveStat({ label, value, accent }: { label: string; value: string; accent?: boolean }): JSX.Element {
  return (
    <div className={`rounded-lg px-3 py-2 ${accent ? "bg-emerald-50 ring-1 ring-emerald-300" : "bg-slate-50 ring-1 ring-slate-200"}`}>
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-xl font-black tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
