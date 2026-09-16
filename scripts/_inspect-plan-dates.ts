import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import admin from "firebase-admin";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";

configureFirestoreWriterAuth();
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const snap = await db.collection("apps").doc("rezeptlogik").collection("productionPlan").get();
for (const doc of snap.docs) {
  const rows: any[] = doc.data()?.rows ?? [];
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const d = r.kitchenDay || "(leer)";
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const sorted = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  console.log(`\n=== ${doc.id} (${rows.length} rows) ===`);
  for (const [day, count] of sorted) {
    console.log(`  ${day}: ${count} WOs`);
  }
}
