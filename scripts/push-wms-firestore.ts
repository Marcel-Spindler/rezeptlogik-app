/**
 * push-wms-firestore.ts
 * ======================
 * Liest public/data/wms-cache.json und pusht alle Datensätze nach Firestore.
 * Wird nach sync-wms-cache.ts ausgeführt damit die Cloud Functions auf Cachedaten
 * zugreifen können.
 *
 * Nutzung:
 *   npx tsx scripts/push-wms-firestore.ts
 */

import { config as loadEnv } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";

loadEnv({ path: "functions/.env" });
loadEnv({ path: ".env.local" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

async function main() {
  const cacheFile = path.join(__dirname, "../public/data/wms-cache.json");
  if (!fs.existsSync(cacheFile)) {
    throw new Error(`wms-cache.json nicht gefunden: ${cacheFile}\nBitte zuerst: npx tsx scripts/sync-wms-cache.ts`);
  }

  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const { week, datasets } = cache;

  if (!week || !datasets) {
    throw new Error("wms-cache.json hat ungültiges Format (week oder datasets fehlt)");
  }

  console.log(`📤 WMS Cache → Firestore`);
  console.log(`   Woche: ${week}`);
  console.log(`   Datensätze: ${Object.keys(datasets).join(", ")}`);
  console.log("");

  const generatedAt = cache.timestamp || new Date().toISOString();

  for (const [datasetKey, rows] of Object.entries(datasets) as [string, any[]][]) {
    // workorders hat keinen Wochen-Suffix (zeitunabhängig)
    const docId = datasetKey === "workorders" ? "workorders" : `${datasetKey}-${week}`;
    const docRef = db.collection("wmsCache").doc(docId);

    await docRef.set({
      rows,
      source: "push",
      week,
      generatedAt,
      pushedAt: new Date().toISOString(),
    });

    console.log(`   ✅ wmsCache/${docId}: ${rows.length} Zeilen`);
  }

  console.log("\n✅ Firestore aktualisiert");
}

main().catch((err) => {
  console.error("❌ Fehler:", err.message);
  process.exit(1);
});
