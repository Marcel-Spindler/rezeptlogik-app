// Polling-Watch für operative GSheets (Fertigstellung, Shelf-Life, PFEI).
// Startet import:local in konfigurierbarem Intervall und schreibt data.json neu.
// Starten: tsx scripts/watch-operational.ts
// Intervall anpassen: WATCH_INTERVAL_MIN=5 tsx scripts/watch-operational.ts

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { execSync } from "node:child_process";

const INTERVAL_MIN = parseInt(process.env.WATCH_INTERVAL_MIN ?? "10", 10);
const INTERVAL_MS  = INTERVAL_MIN * 60 * 1000;

function runImport() {
  const ts = new Date().toLocaleTimeString("de-DE");
  console.log(`[${ts}] Aktualisiere operative Daten …`);
  try {
    execSync("npx tsx scripts/import-local.ts", { stdio: "inherit" });
    console.log(`[${new Date().toLocaleTimeString("de-DE")}] ✓ data.json aktualisiert`);
  } catch {
    console.warn(`[${new Date().toLocaleTimeString("de-DE")}] Import fehlgeschlagen — nächster Versuch in ${INTERVAL_MIN} Min.`);
  }
}

console.log(`Operative GSheet-Watch gestartet (alle ${INTERVAL_MIN} Minuten). Ctrl+C zum Stoppen.`);
runImport();
setInterval(runImport, INTERVAL_MS);
