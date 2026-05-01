// Pusht public/data/data.json nach Firestore (Collections: weekRecipes, recipes, structures, cookSchedules, meta).
// Voraussetzung: secrets/service-account.json + .env GOOGLE_APPLICATION_CREDENTIALS gesetzt.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import admin from "firebase-admin";
import type { DataBundle } from "../src/types.ts";

const bundle: DataBundle = JSON.parse(readFileSync(resolve("public", "data", "data.json"), "utf8"));

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

// Geteiltes Projekt → alle App-Daten unter apps/rezeptlogik/<collection>/<doc>
const APP_ROOT = db.collection("apps").doc("rezeptlogik");

async function batchedSet<T extends Record<string, unknown>>(collName: string, docs: { id: string; data: T }[]) {
  const coll = APP_ROOT.collection(collName);
  const CHUNK = 400;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch();
    for (const { id, data } of docs.slice(i, i + CHUNK)) {
      batch.set(coll.doc(id), data, { merge: true });
    }
    await batch.commit();
    console.log(`  ${collName}: ${Math.min(i + CHUNK, docs.length)}/${docs.length}`);
  }
}

async function main() {
  console.log("Push meta …");
  await APP_ROOT.set({ generatedAt: bundle.generatedAt, weeks: bundle.weeks }, { merge: true });

  console.log(`Push weekRecipes (${bundle.weekRecipes.length}) …`);
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

  console.log("✓ Firestore aktualisiert");
}

main().catch(e => { console.error(e); process.exit(1); });
