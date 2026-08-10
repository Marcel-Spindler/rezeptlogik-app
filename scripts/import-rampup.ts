// import-rampup.ts: Liest "Maitre Inputs DE/NO_Stamm" aus SHEET_WOCHENSTART (live)
// und speichert die Snapshots in Firestore unter collection "maitreRampup".

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { google } from "googleapis";
import admin from "firebase-admin";
import type { MaitreRampupEntry, MaitreSnapshotLabel } from "../src/core/types.ts";

function num(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const spreadsheetId = process.env.SHEET_WOCHENSTART ?? "1YscgiuKYVI2pGcMJ3RcJwWGQEkG46RnVnji8q8a4AeE";
  console.log(`Lese Maitre Inputs DE/NO_Stamm live aus GSheet: ${spreadsheetId} …`);

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  let rows: any[][];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'Maitre Inputs DE/NO_Stamm'!A1:Z3000"
    });
    rows = res.data.values ?? [];
  } catch (e: any) {
    console.error(`Fehler beim Lesen des Sheets: ${e.message}`);
    process.exit(1);
  }

  if (rows.length < 2) {
    console.error("Keine ausreichenden Daten im GSheet gefunden.");
    process.exit(1);
  }

  // Parse header
  const header = rows[1].map((c: unknown) => String(c ?? "").trim().toLowerCase());
  console.log("Header Columns:", header);

  const marketIdx = header.findIndex(h => h === "market");
  const weekIdx = header.findIndex(h => h === "week");
  const slotIdx = header.findIndex(h => h.includes("slot") || h === "recipe slot number");
  const skuIdx = header.findIndex(h => h === "sku code" || h === "sku");
  const recipeNameIdx = header.findIndex(h => h === "recipe name");
  const recipeCodeIdx = header.findIndex(h => h === "recipe code");
  const maitreCodeIdx = header.findIndex(h => h === "maitre code");

  // Snapshot-Zeitpunkte Spaltenzuordnung
  const snapshotCols: { label: MaitreSnapshotLabel; idx: number }[] = [
    { label: "wed-4wk", idx: header.findIndex(h => h.includes("wed") && h.includes("-4wk")) },
    { label: "wed-3wk", idx: header.findIndex(h => h.includes("wed") && h.includes("-3wk")) },
    { label: "wed-2wk", idx: header.findIndex(h => h.includes("wed") && h.includes("-2wk")) },
    { label: "wed-1wk", idx: header.findIndex(h => h === "wed-1wk" || h.includes("wed-1wk") || h.includes("wed -1wk")) },
    { label: "fri-1wk", idx: header.findIndex(h => h === "fri-1wk" || h.includes("fri-1wk") || h.includes("fri -1wk")) },
    { label: "mon", idx: header.findIndex(h => h === "mon" || h === "monday") },
    { label: "tue", idx: header.findIndex(h => h === "tues" || h === "tuesday" || h === "tue") },
    { label: "wed", idx: header.findIndex(h => h === "weds" || h === "wednesday" || h === "wed") },
    { label: "thu", idx: header.findIndex(h => h === "thurs" || h === "thursday" || h === "thu") },
  ];

  const orderIdx = header.findIndex(h => h === "order");

  const entries: MaitreRampupEntry[] = [];

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;

    const market = marketIdx >= 0 ? String(row[marketIdx] ?? "").trim() : "";
    const week = weekIdx >= 0 ? String(row[weekIdx] ?? "").trim() : "";
    const recipeCode = recipeCodeIdx >= 0 ? String(row[recipeCodeIdx] ?? "").trim() : "";

    if (!market || !week || !recipeCode) continue;

    // Summenzeilen ignorieren
    if (market.toLowerCase().includes("summe") || recipeCode.toLowerCase().includes("summe")) continue;

    const slot = slotIdx >= 0 ? parseInt(String(row[slotIdx] ?? ""), 10) || 0 : 0;
    const skuCode = skuIdx >= 0 ? String(row[skuIdx] ?? "").trim() : "";
    const recipeName = recipeNameIdx >= 0 ? String(row[recipeNameIdx] ?? "").trim() : "";
    const maitreCode = maitreCodeIdx >= 0 ? String(row[maitreCodeIdx] ?? "").trim() : "";

    const snapshots: Partial<Record<MaitreSnapshotLabel, number>> = {};
    for (const snap of snapshotCols) {
      if (snap.idx >= 0) {
        snapshots[snap.label] = num(row[snap.idx]);
      }
    }

    const orderVolume = orderIdx >= 0 ? num(row[orderIdx]) : 0;

    entries.push({
      week,
      market,
      slot,
      recipeCode,
      maitreCode,
      skuCode,
      recipeName,
      snapshots,
      orderVolume
    });
  }

  console.log(`Parsed ${entries.length} Maitre Ramp-up Snapshots.`);

  // Push to Firestore
  console.log("Initializing Firebase Admin...");
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const APP_ROOT = db.collection("apps").doc("rezeptlogik");
  const coll = APP_ROOT.collection("maitreRampup");

  const CHUNK = 400;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = db.batch();
    for (const entry of entries.slice(i, i + CHUNK)) {
      const docId = `${entry.market}__${entry.week}__${entry.recipeCode}`.replace(/[^A-Za-z0-9_-]/g, "_");
      batch.set(coll.doc(docId), entry, { merge: true });
    }
    await batch.commit();
    console.log(`  maitreRampup: ${Math.min(i + CHUNK, entries.length)}/${entries.length}`);
  }

  console.log("✓ Ramp-up Snapshots erfolgreich in Firestore importiert.");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
