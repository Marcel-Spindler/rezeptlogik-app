import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import admin from "firebase-admin";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";

configureFirestoreWriterAuth();
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const col = db.collection("apps").doc("rezeptlogik").collection("productionPlan");
const snap = await col.get();
console.log(`Docs in productionPlan: ${snap.docs.length}`);
for (const doc of snap.docs) {
  const d = doc.data();
  const rows: any[] = d?.rows ?? [];
  const prefixes = [...new Set(rows.map((r: any) => r.workOrder?.split("-")[0]))].sort();
  const sample = rows.slice(0, 2).map((r: any) => `${r.workOrder}|${r.kitchenDay}`).join(", ");
  console.log(`  ${doc.id}: ${rows.length} rows  prefixes:[${prefixes.join(",")}]  sample: ${sample}`);
}
