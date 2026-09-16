// Schlanker GSheet→Firestore-Sync für den Produktionsplan (nur Production-Plan,
// kein lokales data.json nötig). Gedacht für einen Windows Scheduled Task der
// alle 2 Stunden läuft — so sehen alle Geräte (Kiosk, Tablets, Staging-Dashboard)
// immer einen frischen Produktionsplan, sobald die Logistik das GSheet aktualisiert.
//
// Firestore-Ziel: apps/rezeptlogik/productionPlan/<week>
// (genau dasselbe Schema wie push-firestore.ts → Staging-Dashboard liest es direkt)
//
// Läuft headless ohne Browser-SSO:
//   - GSheet-Auth via GOOGLE_APPLICATION_CREDENTIALS (Service-Account)
//   - Firestore-Auth via FIRESTORE_WRITER_CREDENTIALS (Firestore-Writer)
//
// Aufruf: npm run sync:production-plan
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();

import admin from "firebase-admin";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";
import { readProductionPlan } from "./read-production-plan.ts";

const SHEET_ID = process.env.SHEET_FERTIGSTELLUNG ?? "1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY";

async function main() {
  console.log(`Lese Produktionsplan aus GSheet ${SHEET_ID} …`);
  const plan = await readProductionPlan(SHEET_ID);
  if (!plan || !plan.rows.length) {
    console.warn("Kein Produktionsplan gefunden oder keine Zeilen — Firestore bleibt unverändert.");
    process.exit(0);
  }
  console.log(`  ${plan.rows.length} WO-Zeilen, Woche ${plan.week}`);

  configureFirestoreWriterAuth();
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  const ref = db
    .collection("apps").doc("rezeptlogik")
    .collection("productionPlan").doc(plan.week);

  await ref.set(plan);
  console.log(`✓ Firestore apps/rezeptlogik/productionPlan/${plan.week} aktualisiert (${plan.rows.length} Zeilen)`);

  // Browser-Reload-Signal: alle offenen Staging-Dashboards holen automatisch neue Daten
  await db.collection("apps").doc("rezeptlogik").set(
    { planSyncedAt: new Date().toISOString() },
    { merge: true },
  );
  console.log("  Browser-Signal (planSyncedAt) gesetzt.");

  // Alte Docs löschen — dataSource.ts mergt alle Docs in der Collection, alte Wochen
  // erscheinen dann als massenhaft überfällige WOs im Staging-Dashboard.
  const [planYear, planWeekStr] = plan.week.split("-W");
  const planWeekNum = parseInt(planWeekStr, 10);
  // Nur aktuelle und nächste Woche behalten — alte Docs haben veraltete/falsche Daten
  // und würden im Staging-Dashboard als massenhaft überfällige WOs auftauchen.
  const keepWeeks = new Set([
    plan.week,
    `${planYear}-W${String(planWeekNum + 1).padStart(2, "0")}`,
  ]);
  const collection = db.collection("apps").doc("rezeptlogik").collection("productionPlan");
  const allDocs = await collection.listDocuments();
  for (const doc of allDocs) {
    if (!keepWeeks.has(doc.id)) {
      await doc.delete();
      console.log(`  Gelöscht: productionPlan/${doc.id}`);
    }
  }
}

main().catch((e) => { console.error("FEHLER:", e?.message ?? e); process.exit(1); });
