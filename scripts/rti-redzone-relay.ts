// Lokaler Redzone-Relay für den Backfill-Wächter.
//
// Die Cloud Function `rtiBackfillWatch` (functions/rtiBackfillWatch.js) braucht
// für die "Actuals" pro Meal eigentlich den Online-Redzone-Zugriff (Snowflake,
// JWT-Auth mit Marcel-Account) — der ist aktuell kaputt ("JWT token is
// invalid.", siehe Firebase-Function-Logs vom 2026-09-16). Als Fallback liest
// sie stattdessen Firestore-Doc apps/rezeptlogik/backfillWatch/rtiTargets
// (< 45 min alt), das bisher NUR ein offener Browser-Tab mit funktionierendem
// lokalem WMS-Server befüllt hat (src/features/backfills/rtiTargetsRelay.ts).
//
// Dieses Script macht denselben Job headless: fragt den bereits laufenden
// lokalen WMS-Server (`npm run wms:server`, Port 3141 — der ist per
// Browser-SSO mit Snowflake verbunden und funktioniert, im Gegensatz zum
// Cloud-Function-JWT) nach den Redzone-Plating-Zahlen, aggregiert sie pro Meal
// und schreibt sie in genau dasselbe Firestore-Doc. Gedacht zum Aufruf alle
// 10 Minuten per Windows Scheduled Task (siehe scripts/README oder die
// Task-Registrierung) — läuft der lokale Server gerade nicht (Verbindung
// abgelehnt), beendet sich das Script sofort und leise (kein Fehler-Alarm
// nötig, der 45-min-Freshness-Check in der Function fällt dann einfach auf
// "kein Relay" zurück, wie bisher ohne offenen Browser-Tab auch).
//
// Nur die 4-stellige Meal-Ziffer -> aggregierte "Actuals" (Summe outCount,
// Bereich "Plating") wird geschrieben — 1:1 dieselbe Form wie
// rtiTargetsRelay.ts, aber ohne plannedTarget (die Function liest beim Relay-
// Fallback ohnehin nur .actuals, siehe readRelayActuals in rtiBackfillWatch.js).
//
// WICHTIG (live an KW39 entdeckt): viele Plating-Zeilen tragen GAR KEINEN
// FV-Code im productTypeName, nur den Klarnamen ("Ginger Garlic Grilled
// Chicken [DE]" statt "FV4064A - …") — genau die drei Meals, die im
// RTI-KOPF-FEHLT-Spam auftauchten. Reine Regex-Extraktion (wie RZ_MEAL_RE in
// functions/rtiBackfillWatch.js) würde diese Zeilen VERWERFEN und selbst ein
// intakter Online-Redzone-JWT hätte sie nicht gefunden. Deshalb hier dieselbe
// SKU→Rezept-Auflösung wie in redzoneResolve.ts (buildRedzoneCodeResolver):
// productTypeSKU ist die MSKU aus data.recipes[code].markets.<Markt>.msku.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import admin from "firebase-admin";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";
import { codeDigits } from "../src/lib/helpers.ts";
import { extractMealCode, buildRedzoneCodeResolver } from "../src/features/redzone-live/redzoneResolve.ts";
import type { DataBundle } from "../src/core/types.ts";
import type { RedzoneRun } from "../src/features/redzone-live/redzoneTypes.ts";

const WMS_LOCAL_URL = process.env.WMS_LOCAL_URL || "http://127.0.0.1:3141";
const FETCH_TIMEOUT_MS = 15_000;

type RedzoneRow = RedzoneRun;

// 1:1 mit lookbackHoursSinceMonday() in functions/rtiBackfillWatch.js — Stunden
// von Montag 00:00 (Europe/Berlin) bis jetzt, geklemmt auf [24, 168], damit die
// ganze laufende Woche gezählt wird (nicht nur die letzten 24h).
function lookbackHoursSinceMonday(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value || "";
  const dowIdx = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[get("weekday")] ?? 0;
  const h = parseInt(get("hour"), 10) || 0;
  const min = parseInt(get("minute"), 10) || 0;
  const hrs = dowIdx * 24 + h + min / 60;
  return Math.min(168, Math.max(24, Math.ceil(hrs)));
}

async function fetchRedzoneRows(hours: number): Promise<RedzoneRow[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${WMS_LOCAL_URL}/redzone-plating-status?hours=${hours}`, { signal: ctrl.signal });
    if (!res.ok) { console.log(`WMS-Server antwortet mit ${res.status} — kein Relay-Push.`); return null; }
    const body = await res.json() as { ok?: boolean; rows?: RedzoneRow[] };
    if (!body?.ok || !Array.isArray(body.rows)) { console.log("WMS-Server: Antwort ohne rows — kein Relay-Push."); return null; }
    return body.rows;
  } catch (e) {
    // Server läuft nicht / keine Snowflake-Verbindung (SSO-Session abgelaufen) —
    // beides erwartbar außerhalb der Arbeitszeit, kein Grund für Lärm.
    console.log(`Lokaler WMS-Server (${WMS_LOCAL_URL}) nicht erreichbar: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function aggregateByMeal(
  rows: RedzoneRow[],
  resolveCode: (run: { mealCode: string | null; productTypeSKU: string }) => string | null,
): Map<string, number> {
  const byCode = new Map<string, number>();
  for (const r of rows) {
    if (r.areaName !== "Plating") continue;
    const add = Number(r.outCount) || 0;
    if (add <= 0) continue;
    const code = resolveCode({ mealCode: extractMealCode(r.productTypeName), productTypeSKU: r.productTypeSKU });
    if (!code) continue;
    const k = codeDigits(code);
    byCode.set(k, (byCode.get(k) || 0) + add);
  }
  return byCode;
}

async function main() {
  const now = new Date();
  const hours = lookbackHoursSinceMonday(now);
  const rows = await fetchRedzoneRows(hours);
  if (!rows) return; // leise beenden, siehe fetchRedzoneRows

  const bundle = JSON.parse(readFileSync(resolve("public", "data", "data.json"), "utf8")) as DataBundle;
  const resolveCode = buildRedzoneCodeResolver(bundle);

  const byCode = aggregateByMeal(rows, resolveCode);
  if (byCode.size === 0) { console.log("Keine Plating-Zeilen mit auflösbarem Meal-Code — kein Relay-Push."); return; }

  const targets: Record<string, { actuals: number; source: string }> = {};
  for (const [code, actuals] of byCode) {
    targets[code] = { actuals: Math.round(actuals), source: "Redzone (lokaler Relay-Cron)" };
  }

  configureFirestoreWriterAuth();
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const ref = admin.firestore()
    .collection("apps").doc("rezeptlogik").collection("backfillWatch").doc("rtiTargets");
  await ref.set({ targets, updatedAt: Date.now(), updatedIso: now.toISOString() });

  console.log(`Relay-Push ok: ${byCode.size} Meal(s), lookback ${hours}h.`);
}

main().catch(e => { console.error(e); process.exit(1); });
