// Pusht public/data/data.json nach Firestore (Collections: weekRecipes, recipes, structures, cookSchedules, meta).
// Voraussetzung: secrets/service-account.json + .env GOOGLE_APPLICATION_CREDENTIALS gesetzt.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import admin from "firebase-admin";
import type { DataBundle } from "../src/core/types.ts";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";

const bundle: DataBundle = JSON.parse(readFileSync(resolve("public", "data", "data.json"), "utf8"));
configureFirestoreWriterAuth();

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

// Geteiltes Projekt → alle App-Daten unter apps/rezeptlogik/<collection>/<doc>
const APP_ROOT = db.collection("apps").doc("rezeptlogik");

async function clearCollection(collName: string) {
  const coll = APP_ROOT.collection(collName);
  const refs = await coll.listDocuments();
  if (refs.length === 0) return;
  const CHUNK = 400;
  for (let i = 0; i < refs.length; i += CHUNK) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + CHUNK)) batch.delete(ref);
    await batch.commit();
  }
  console.log(`  ${collName}: ${refs.length} alte Docs gelöscht`);
}

async function batchedSet<T extends Record<string, unknown>>(collName: string, docs: { id: string; data: T }[]) {
  const coll = APP_ROOT.collection(collName);
  const MAX_DOCS = 400;                // Firestore erlaubt 500 Writes/Batch
  const MAX_BYTES = 8 * 1024 * 1024;   // Firestore-Requestlimit ~10 MiB — mit Puffer batchen
  let i = 0;
  let done = 0;
  while (i < docs.length) {
    const batch = db.batch();
    let bytes = 0;
    let n = 0;
    while (i < docs.length && n < MAX_DOCS) {
      const { id, data } = docs[i];
      const sz = Buffer.byteLength(JSON.stringify(data));
      // Mindestens 1 Doc pro Batch — auch wenn es allein schon groß ist.
      if (n > 0 && bytes + sz > MAX_BYTES) break;
      batch.set(coll.doc(id), data as Record<string, unknown>, { merge: true });
      bytes += sz;
      n++;
      i++;
    }
    await batch.commit();
    done += n;
    console.log(`  ${collName}: ${done}/${docs.length}`);
  }
}

async function main() {
  console.log("Push meta …");
  await APP_ROOT.set({ generatedAt: bundle.generatedAt, weeks: bundle.weeks }, { merge: true });

  console.log(`Push weekRecipes (${bundle.weekRecipes.length}) …`);
  // Erst alles löschen: alter Merge-Ansatz ließ orphan-Docs zurück.
  await clearCollection("weekRecipes");
  await batchedSet("weekRecipes", bundle.weekRecipes.map((w, i) => ({
    id: `${w.hfWeek}__${w.code}__${i}`, data: w as any
  })));

  // Wichtig: bundle.recipes enthält Aliase (z.B. FE0972B → gleiches Recipe-Objekt wie FV0972A).
  // Wir pushen jeden Schlüssel als eigenes Doc, damit der Firestore-Reader später per
  // weekRecipe.code direkt nachschlagen kann.
  const recipeEntries = Object.entries(bundle.recipes);
  console.log(`Push recipes (${recipeEntries.length} keys, inkl. Aliase) …`);
  await batchedSet("recipes", recipeEntries.map(([key, r]) => ({ id: key, data: r as any })));

  const structureEntries = Object.entries(bundle.structures ?? {});
  if (structureEntries.length > 0) {
    console.log(`Push structures (${structureEntries.length} keys, inkl. Aliase) …`);
    await batchedSet("structures", structureEntries.map(([key, s]) => ({ id: key, data: s as any })));
  }

  const cs = Object.values(bundle.cookSchedules);
  console.log(`Push cookSchedules (${cs.length}) …`);
  await batchedSet("cookSchedules", cs.map(c => ({
    id: c.cookMethod.replace(/[^A-Za-z0-9]+/g, "_"), data: c as any
  })));

  const ps = Object.values(bundle.processSpecs ?? {});
  if (ps.length > 0) {
    console.log(`Push processSpecs (${ps.length}) …`);
    await batchedSet("processSpecs", ps.map(p => ({
      id: p.subRecipeId, data: p as any
    })));
  }

  const shelfLifeEntries = Object.entries(bundle.shelfLifeBySku ?? {});
  if (shelfLifeEntries.length > 0) {
    console.log(`Push shelfLifeBySku (${shelfLifeEntries.length}) …`);
    await batchedSet("shelfLifeBySku", shelfLifeEntries.map(([skuCode, info]) => ({
      id: encodeURIComponent(skuCode),
      data: info as any
    })));
  }

  if (bundle.productionPlan) {
    const week = bundle.productionPlan.week ?? "unknown";
    console.log(`Push productionPlan (${bundle.productionPlan.rows.length} WO-Zeilen, KW ${week}) …`);
    await APP_ROOT.collection("productionPlan").doc(week).set(bundle.productionPlan);
  }

  if (bundle.printOrders?.length) {
    console.log(`Push printOrders (${bundle.printOrders.length}) …`);
    await batchedSet("printOrders", bundle.printOrders.map((r, i) => ({
      id: `${r.week || "?"}__${r.code}__${r.msku || i}`.replace(/[^A-Za-z0-9_-]/g, "_"),
      data: r as any
    })));
  }

  if (bundle.kitchenPriority?.length) {
    console.log(`Push kitchenPriority (${bundle.kitchenPriority.length} Einträge) …`);
    await APP_ROOT.collection("kitchenPriority").doc("current").set({
      rows: bundle.kitchenPriority,
      updatedAt: bundle.generatedAt
    });
  }

  if (bundle.kitchenPlanning?.length) {
    const week = bundle.kitchenPlanning[0]?.week ?? "unknown";
    console.log(`Push kitchenPlanning (${bundle.kitchenPlanning.length} Rezepte, KW ${week}) …`);
    await APP_ROOT.collection("kitchenPlanning").doc(week).set({
      week,
      rows: bundle.kitchenPlanning,
      updatedAt: bundle.generatedAt
    });
  }

  if (bundle.produktionsplanung) {
    console.log("Push produktionsplanung …");
    for (const [market, entry] of Object.entries(bundle.produktionsplanung)) {
      await APP_ROOT.collection("produktionsplanung").doc(`${entry.week}__${market}`).set(entry);
    }
  }

  console.log("✓ Firestore aktualisiert");
}

main().catch(e => { console.error(e); process.exit(1); });
