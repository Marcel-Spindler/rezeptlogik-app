// Transparency-Sheet-Relay: liest alle Transparency-Tabs vom lokalen WMS-Server
// (der per Google Service-Account auf das GSheet zugreift) und schreibt sie
// nach Firestore — damit die Online-App Producibility-Status berechnen kann.
//
// Aufruf: npx tsx scripts/transparency-relay.ts
// Voraussetzung: Lokaler WMS-Server laeuft (npm run wms:server, Port 3141).

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import admin from "firebase-admin";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";

const WMS_LOCAL_URL = process.env.WMS_LOCAL_URL || "http://127.0.0.1:3141";
const FETCH_TIMEOUT_MS = 30_000;

// Die vier Tabs die fuer Producibility gebraucht werden + weitere nuetzliche.
const TABS = [
  "importrange-weights",
  "total-overview",
  "planning-check",
  "rtem",
  "et",
  "input-kitchen",
  "kitchen-kpis",
  "issue-tracker",
];

// Shorts Tracker laeuft ueber einen eigenen Endpunkt, nicht /transparency-sheet.
const EXTRA_ENDPOINTS: { endpoint: string; docKey: string; label: string }[] = [
  { endpoint: "/shorts-tracker", docKey: "shorts-tracker", label: "Shorts Tracker" },
];

const FIRESTORE_COLLECTION = "transparencyCache";

async function fetchTab(tab: string): Promise<string[][] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${WMS_LOCAL_URL}/transparency-sheet?tab=${encodeURIComponent(tab)}`, { signal: ctrl.signal });
    if (!res.ok) { console.log(`  ${tab} → HTTP ${res.status}`); return null; }
    const body = await res.json() as { ok?: boolean; rows?: string[][] };
    if (!body?.ok || !Array.isArray(body.rows)) { console.log(`  ${tab} → keine Daten`); return null; }
    return body.rows;
  } catch (e) {
    console.log(`  ${tab} → ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Firestore doc limit: 1 MiB. Transparency tabs can be large.
const MAX_DOC_BYTES = 900_000;
function capRows(rows: string[][]): string[][] {
  const json = JSON.stringify(rows);
  if (Buffer.byteLength(json) <= MAX_DOC_BYTES) return rows;
  const avg = Buffer.byteLength(json) / rows.length;
  let capped = rows.slice(0, Math.max(1, Math.floor(MAX_DOC_BYTES / avg)));
  while (capped.length > 1 && Buffer.byteLength(JSON.stringify(capped)) > MAX_DOC_BYTES) {
    capped = capped.slice(0, Math.floor(capped.length * 0.9));
  }
  return capped;
}

async function main() {
  const health = await fetchTab("planning-check"); // quick connectivity test
  if (!health) {
    console.log(`Lokaler WMS-Server (${WMS_LOCAL_URL}) nicht erreichbar — kein Transparency Relay.`);
    return;
  }

  configureFirestoreWriterAuth();
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const now = new Date().toISOString();
  let synced = 0;

  // Write planning-check first (we already fetched it as health check)
  const pcRows = capRows(health);
    await db.collection(FIRESTORE_COLLECTION).doc("planning-check").set({ rowsJson: JSON.stringify(pcRows), rowCount: pcRows.length, pushedAt: now, tab: "planning-check" });
  console.log(`  planning-check → ${pcRows.length} Zeilen`);
  synced++;

  for (const tab of TABS) {
    if (tab === "planning-check") continue; // already done
    console.log(`→ ${tab} …`);
    const rows = await fetchTab(tab);
    if (!rows) continue;
    const capped = capRows(rows);
    if (capped.length < rows.length) console.log(`  ${rows.length} → ${capped.length} Zeilen (1MB Limit)`);
    await db.collection(FIRESTORE_COLLECTION).doc(tab).set({ rowsJson: JSON.stringify(capped), rowCount: capped.length, pushedAt: now, tab });
    console.log(`  ${tab} → ${capped.length} Zeilen`);
    synced++;
  }

  console.log(`\nTransparency Relay fertig: ${synced}/${TABS.length + EXTRA_ENDPOINTS.length} gesynct.`);

  // Extra-Endpunkte (Shorts Tracker etc.)
  for (const extra of EXTRA_ENDPOINTS) {
    console.log(`→ ${extra.label} (${extra.endpoint}) …`);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${WMS_LOCAL_URL}${extra.endpoint}`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) { console.log(`  ${extra.label} → HTTP ${res.status}`); continue; }
      const body = await res.json() as { ok?: boolean; rows?: unknown[] };
      if (!body?.ok || !Array.isArray(body.rows)) { console.log(`  ${extra.label} → keine Daten`); continue; }
      await db.collection(FIRESTORE_COLLECTION).doc(extra.docKey).set({
        rowsJson: JSON.stringify(body.rows),
        rowCount: body.rows.length,
        pushedAt: now,
        tab: extra.docKey,
      });
      console.log(`  ${extra.label} → ${body.rows.length} Zeilen`);
      synced++;
    } catch (e) {
      clearTimeout(t);
      console.log(`  ${extra.label} → ${(e as Error).message}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
