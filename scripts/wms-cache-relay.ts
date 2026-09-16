// WMS-Cache-Relay: liest vom bereits laufenden lokalen WMS-Server (Port 3141,
// Browser-SSO) und schreibt die Daten nach Firestore wmsCache/* — genau dort,
// wo die Cloud Functions als Fallback nachschauen. Kein eigener SSO-Popup
// (anders als sync-wms-cache.ts), laeuft headless alle 10 Min per Scheduled Task.
//
// Aufruf: npx tsx scripts/wms-cache-relay.ts
// Voraussetzung: Lokaler WMS-Server laeuft (npm run wms:server, Port 3141).

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import admin from "firebase-admin";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";

const WMS_LOCAL_URL = process.env.WMS_LOCAL_URL || "http://127.0.0.1:3141";
const FETCH_TIMEOUT_MS = 30_000;

// Firestore doc size limit: 1 MiB. Cap rows to stay safely below.
const MAX_DOC_BYTES = 900_000;
function capRows<T>(rows: T[]): T[] {
  const json = JSON.stringify(rows);
  if (Buffer.byteLength(json) <= MAX_DOC_BYTES) return rows;
  const avg = Buffer.byteLength(json) / rows.length;
  let capped = rows.slice(0, Math.max(1, Math.floor(MAX_DOC_BYTES / avg)));
  while (capped.length > 1 && Buffer.byteLength(JSON.stringify(capped)) > MAX_DOC_BYTES) {
    capped = capped.slice(0, Math.floor(capped.length * 0.9));
  }
  return capped;
}

interface RelayJob {
  endpoint: string;
  cacheKey: string;
  label: string;
}

const JOBS: RelayJob[] = [
  { endpoint: "/wms-plating",         cacheKey: "wms-plating-latest",         label: "Plating" },
  { endpoint: "/wms-plating-holding", cacheKey: "wms-plating-holding-latest", label: "Plating Holding" },
  { endpoint: "/wms-staging",         cacheKey: "wms-staging-latest",         label: "Staging" },
  { endpoint: "/wms-debox",           cacheKey: "wms-debox-latest",           label: "Debox" },
  { endpoint: "/wms-postblast",       cacheKey: "wms-postblast-latest",       label: "Postblast" },
  { endpoint: "/wms-sleeving",        cacheKey: "wms-sleeving-latest",        label: "Sleeving" },
  { endpoint: "/wms-plating-history", cacheKey: "wms-plating-history-latest", label: "Plating-History" },
  { endpoint: "/wms-inbound",         cacheKey: "wms-inbound-latest",         label: "Inbound" },
  { endpoint: "/wms-workorders",      cacheKey: "workorders",                 label: "Workorders" },
  { endpoint: "/wms-full-inventory",  cacheKey: "wms-full-inventory-latest",  label: "Full Inventory" },
];

async function fetchEndpoint(endpoint: string): Promise<{ ok: boolean; rows?: unknown[]; [k: string]: unknown } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${WMS_LOCAL_URL}${endpoint}`, { signal: ctrl.signal });
    if (!res.ok) { console.log(`  ${endpoint} → HTTP ${res.status}, uebersprungen`); return null; }
    return await res.json() as { ok: boolean; rows?: unknown[] };
  } catch (e) {
    console.log(`  ${endpoint} → ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  // Quick health check — if server is down, exit immediately
  const health = await fetchEndpoint("/health");
  if (!health) {
    console.log(`Lokaler WMS-Server (${WMS_LOCAL_URL}) nicht erreichbar — kein Relay.`);
    return;
  }

  configureFirestoreWriterAuth();
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const now = new Date().toISOString();

  let synced = 0;
  let skipped = 0;

  for (const job of JOBS) {
    console.log(`→ ${job.label} (${job.endpoint}) …`);
    const data = await fetchEndpoint(job.endpoint);
    if (!data?.ok || !Array.isArray(data.rows)) { skipped++; continue; }

    const rows = capRows(data.rows);
    if (rows.length < data.rows.length) {
      console.log(`  ${data.rows.length} → ${rows.length} Zeilen (Firestore 1MB Limit)`);
    }

    await db.collection("wmsCache").doc(job.cacheKey).set({
      rows,
      generatedAt: data.generatedAt ?? now,
      pushedAt: now,
      whId: data.whId ?? "VF",
    });
    console.log(`  ${rows.length} Zeilen → wmsCache/${job.cacheKey}`);
    synced++;
  }

  console.log(`\nRelay fertig: ${synced} gesynct, ${skipped} uebersprungen.`);
}

main().catch(e => { console.error(e); process.exit(1); });
