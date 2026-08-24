// WMS Übersicht – gemeinsamer Stations-Fetch (lokaler Server / Cloud Function).
// Extrahiert aus WmsKwOverviewView, damit andere Views (z.B. der Rezept-Detail-
// Meal-Trace) dieselbe Retry-/Fehlerlogik nutzen können, statt sie zu duplizieren.
import type {
  AllData, BasePayload, InboundPayload, SleevingPayload,
  StoredPayload, StoredRow, WoDetailPayload, WorkordersPayload,
} from "./wmsTypes";

export interface WmsStationsResult {
  data: AllData;
  generatedAt: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
}

export async function fetchAllWmsStations(
  week: string,
  opts: { whId?: string; limit?: number; maxRetries?: number; onRetry?: (attempt: number, message: string) => void } = {},
): Promise<WmsStationsResult> {
  const { whId = "VF", limit = 50000, maxRetries = 3, onRetry } = opts;

  const attempt = async (retryCount: number): Promise<WmsStationsResult> => {
    try {
      const p = new URLSearchParams({ whId, week, limit: String(limit), ts: String(Date.now()) });
      const [plR, stgR, debR, pbR, slR, inR, woR, wodR, plhR] = await Promise.all([
        fetch(`/api/wms-plating?${p}`, { cache: "no-store" }),
        fetch(`/api/wms-staging?${p}`, { cache: "no-store" }),
        fetch(`/api/wms-debox?${p}`, { cache: "no-store" }),
        fetch(`/api/wms-postblast?${p}`, { cache: "no-store" }),
        fetch(`/api/wms-sleeving?${p}`, { cache: "no-store" }),
        fetch(`/api/wms-inbound?${p}`, { cache: "no-store" }),
        fetch(`/api/wms-workorders?${p}`, { cache: "no-store" }),
        fetch(`/api/wms-wo-detail?${p}`, { cache: "no-store" }),
        fetch(`/api/wms-plating-holding?${p}`, { cache: "no-store" }),
      ]);
      const ct = plR.headers.get("content-type") ?? "";
      if (!ct.includes("application/json") && !ct.includes("text/json")) {
        if (retryCount < maxRetries) {
          onRetry?.(retryCount + 1, `Warte auf WMS-Server… (Versuch ${retryCount + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, 2500));
          return attempt(retryCount + 1);
        }
        throw new Error(`WMS-Server nicht erreichbar (HTTP ${plR.status}). Lokalen Server starten: npm run wms:server`);
      }
      const [pl, stg, deb, pb, sl, inb, wo, wod, plh] = await Promise.all([
        plR.json() as Promise<StoredPayload>,
        stgR.json() as Promise<StoredPayload>,
        debR.json() as Promise<StoredPayload>,
        pbR.json() as Promise<StoredPayload>,
        slR.json() as Promise<SleevingPayload>,
        inR.json() as Promise<InboundPayload>,
        woR.ok ? woR.json() as Promise<WorkordersPayload> : woR.json().catch(() => ({})).then(body => {
          console.warn(`WMS WO-Endpoint Fehler HTTP ${woR.status}:`, body);
          return { ok: false, rows: [], error: `WO-Daten nicht verfügbar (HTTP ${woR.status}) — lokaler Server läuft? Snowflake verbunden?` } as WorkordersPayload;
        }),
        wodR.ok && (wodR.headers.get("content-type") ?? "").includes("json") ? wodR.json() as Promise<WoDetailPayload> : Promise.resolve({ ok: true, rows: [] } as WoDetailPayload),
        plhR.ok && (plhR.headers.get("content-type") ?? "").includes("json") ? plhR.json() as Promise<StoredPayload> : Promise.resolve({ ok: true, rows: [] } as StoredPayload),
      ]);
      for (const [label, pay] of [["Plating", pl], ["Staging", stg], ["Debox", deb], ["Post-Blast", pb], ["Sleeving", sl], ["Inbound", inb]] as [string, BasePayload][]) {
        if (!pay.ok) throw new Error(`${label}: ${pay.error ?? "Unbekannter Fehler"}`);
      }
      return {
        data: { plating: pl, platingHolding: plh, staging: stg, debox: deb, postblast: pb, sleeving: sl, inbound: inb, workorders: wo, woDetail: wod },
        generatedAt: pl.generatedAt ?? sl.generatedAt ?? inb.generatedAt ?? null,
        rangeStart: pl.rangeStart ?? inb.rangeStart ?? null,
        rangeEnd: pl.rangeEnd ?? inb.rangeEnd ?? null,
      };
    } catch (e) {
      if (retryCount < maxRetries && e instanceof TypeError && e.message.includes("fetch")) {
        onRetry?.(retryCount + 1, `Warte auf WMS-Server… (Versuch ${retryCount + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, 2500));
        return attempt(retryCount + 1);
      }
      throw e;
    }
  };

  return attempt(0);
}

// Schlanker Einzel-Fetch nur für Plating Holding (PLH-Locations, aktueller
// Bestand — die SQL hat bewusst keinen Wochen-Filter). Für Verbraucher, die
// nur den Holding-Puffer brauchen (z.B. Backfills), ohne den kompletten
// 8-Stationen-Funnel aus fetchAllWmsStations mitzuziehen.
export async function fetchPlatingHoldingRows(whId = "VF", limit = 25000): Promise<StoredRow[]> {
  const p = new URLSearchParams({ whId, limit: String(limit), ts: String(Date.now()) });
  const res = await fetch(`/api/wms-plating-holding?${p}`, { cache: "no-store" });
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json")) throw new Error(`WMS Plating Holding nicht erreichbar (HTTP ${res.status})`);
  const payload = await res.json() as StoredPayload;
  if (!payload.ok) throw new Error(payload.error ?? "Unbekannter Fehler");
  return payload.rows;
}
