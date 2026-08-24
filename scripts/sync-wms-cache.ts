// Fragt WMS/Snowflake-Daten per SSO (dein HelloFresh-Login, Browser-Popup) ab
// und pusht sie in die Firestore-Collection "wmsCache" — genau dort, wo die
// deployte Cloud Function (functions/index.js runWmsQuery/wmsWorkorders) als
// Fallback nachschaut, wenn die Live-JWT-Verbindung fehlschlaegt (aktuell
// immer, da kein Snowflake-Service-Account konfiguriert ist).
//
// Aufruf: npm run wms:sync-cache
// Voraussetzung: .env.local hat SNOWFLAKE_ACCOUNT (oder Default greift) +
// FIRESTORE_WRITER_CREDENTIALS zeigt auf einen dedizierten Firestore-Writer.
//
// Ergebnis: Jeder Kitchen-Mitarbeiter, der die deployte App oeffnet, sieht
// diese Daten automatisch (ueber die bestehenden wms*-Endpoints) — ohne
// eigenen Login. Muss nur ab und zu erneut laufen, wenn die Daten sich
// merklich veraendert haben (kein Cron nötig, aber auch kein 24/7-Live-Stand).

import { config as loadEnv } from "dotenv";
loadEnv({ path: "functions/.env" });
loadEnv({ path: ".env.local" });

import admin from "firebase-admin";
import snowflake from "snowflake-sdk";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";

const ACCOUNT = process.env.SNOWFLAKE_ACCOUNT ?? "XG02811-OO69432";
const USER = process.env.SNOWFLAKE_USER ?? "MARCEL.SPINDLER@HELLOFRESH.DE";
const ROLE = process.env.SNOWFLAKE_ROLE ?? "US_OPS_ANALYTICS_USER";
const WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE ?? "US_OPS_ANALYTICS";
const DATABASE = process.env.SNOWFLAKE_DATABASE ?? "US_OPS_ANALYTICS";
const SCHEMA = process.env.SNOWFLAKE_SCHEMA ?? "HIGHJUMP";
const WH_ID = process.env.SNOWFLAKE_WH_ID ?? "VF";

// ── SQL (identisch zu functions/index.js, damit Cache-Shape exakt passt) ───

const WMS_PLATING_SQL = `
SELECT LOCATION_ID, ITEM_NUMBER, ACTUAL_QTY, LOT_NUMBER, HU_ID, STATUS, FIFO_DATE,
    EXPIRATION_DATE, DB_CHANGE_COMMIT_TIME, WEEKOFYEAR(DB_CHANGE_COMMIT_TIME) AS KW
FROM US_OPS_ANALYTICS.HIGHJUMP.T_STORED_ITEM
WHERE WH_ID = ?
  AND (LOCATION_ID ILIKE '%PLAT%' OR LOCATION_ID ILIKE '%PLH%' OR LOCATION_ID ILIKE '%PLSTG%')
  AND DB_CHANGE_COMMIT_TIME >= TO_TIMESTAMP_NTZ(?) AND DB_CHANGE_COMMIT_TIME < TO_TIMESTAMP_NTZ(?)
ORDER BY LOCATION_ID, ITEM_NUMBER LIMIT ?`;

const WMS_SLEEVING_SQL = `
SELECT LOCATION_ID AS VON, LOCATION_ID_2 AS NACH, TRAN_TYPE, ITEM_NUMBER, TRAN_QTY,
    START_TRAN_DATE, END_TRAN_DATE, WEEKOFYEAR(COALESCE(END_TRAN_DATE, START_TRAN_DATE)) AS KW,
    EMPLOYEE_ID, DESCRIPTION
FROM US_OPS_ANALYTICS.HIGHJUMP.T_TRAN_LOG
WHERE WH_ID = ?
  AND (LOCATION_ID ILIKE '%SLEEV%' OR LOCATION_ID_2 ILIKE '%SLEEV%')
  AND COALESCE(END_TRAN_DATE, START_TRAN_DATE) >= TO_TIMESTAMP_NTZ(?) AND COALESCE(END_TRAN_DATE, START_TRAN_DATE) < TO_TIMESTAMP_NTZ(?)
ORDER BY COALESCE(END_TRAN_DATE, START_TRAN_DATE) DESC LIMIT ?`;

const WMS_PLATING_HISTORY_SQL = `
SELECT LOCATION_ID AS VON, LOCATION_ID_2 AS NACH, TRAN_TYPE, ITEM_NUMBER, TRAN_QTY,
    START_TRAN_DATE, END_TRAN_DATE, WEEKOFYEAR(COALESCE(END_TRAN_DATE, START_TRAN_DATE)) AS KW,
    EMPLOYEE_ID, DESCRIPTION
FROM US_OPS_ANALYTICS.HIGHJUMP.T_TRAN_LOG
WHERE WH_ID = ?
  AND (LOCATION_ID ILIKE 'PLATING-LINE-%' OR LOCATION_ID_2 ILIKE 'PLATING-LINE-%')
  AND COALESCE(END_TRAN_DATE, START_TRAN_DATE) >= TO_TIMESTAMP_NTZ(?) AND COALESCE(END_TRAN_DATE, START_TRAN_DATE) < TO_TIMESTAMP_NTZ(?)
ORDER BY COALESCE(END_TRAN_DATE, START_TRAN_DATE) DESC LIMIT ?`;

const WMS_INBOUND_SQL = `
SELECT PO_NUMBER, ITEM_NUMBER, QTY_RECEIVED, QTY_DAMAGED, RECEIPT_DATE, VENDOR_CODE, HU_ID,
    LOT_NUMBER, EXPIRATION_DATE, SHIPMENT_NUMBER, TRAN_STATUS, STATUS, DB_CHANGE_COMMIT_TIME,
    WEEKOFYEAR(RECEIPT_DATE) AS KW
FROM US_OPS_ANALYTICS.HIGHJUMP.T_RECEIPT
WHERE WH_ID = ? AND RECEIPT_DATE >= TO_TIMESTAMP_NTZ(?) AND RECEIPT_DATE < TO_TIMESTAMP_NTZ(?)
ORDER BY RECEIPT_DATE DESC LIMIT ?`;

const WMS_STAGING_SQL = `
SELECT LOCATION_ID, ITEM_NUMBER, ACTUAL_QTY, LOT_NUMBER, HU_ID, STATUS, FIFO_DATE,
    EXPIRATION_DATE, DB_CHANGE_COMMIT_TIME, WEEKOFYEAR(DB_CHANGE_COMMIT_TIME) AS KW
FROM US_OPS_ANALYTICS.HIGHJUMP.T_STORED_ITEM
WHERE WH_ID = ? AND LOCATION_ID ILIKE 'PHSTG%'
  AND DB_CHANGE_COMMIT_TIME >= TO_TIMESTAMP_NTZ(?) AND DB_CHANGE_COMMIT_TIME < TO_TIMESTAMP_NTZ(?)
ORDER BY LOCATION_ID, ITEM_NUMBER LIMIT ?`;

const WMS_DEBOX_SQL = `
SELECT LOCATION_ID, ITEM_NUMBER, ACTUAL_QTY, LOT_NUMBER, HU_ID, STATUS, FIFO_DATE,
    EXPIRATION_DATE, DB_CHANGE_COMMIT_TIME, WEEKOFYEAR(DB_CHANGE_COMMIT_TIME) AS KW
FROM US_OPS_ANALYTICS.HIGHJUMP.T_STORED_ITEM
WHERE WH_ID = ? AND LOCATION_ID ILIKE '%DEBOX%'
  AND DB_CHANGE_COMMIT_TIME >= TO_TIMESTAMP_NTZ(?) AND DB_CHANGE_COMMIT_TIME < TO_TIMESTAMP_NTZ(?)
ORDER BY LOCATION_ID, ITEM_NUMBER LIMIT ?`;

const WMS_POSTBLAST_SQL = `
SELECT LOCATION_ID, ITEM_NUMBER, ACTUAL_QTY, LOT_NUMBER, HU_ID, STATUS, FIFO_DATE,
    EXPIRATION_DATE, DB_CHANGE_COMMIT_TIME, WEEKOFYEAR(DB_CHANGE_COMMIT_TIME) AS KW
FROM US_OPS_ANALYTICS.HIGHJUMP.T_STORED_ITEM
WHERE WH_ID = ? AND LOCATION_ID = 'PostB-01'
  AND DB_CHANGE_COMMIT_TIME >= TO_TIMESTAMP_NTZ(?) AND DB_CHANGE_COMMIT_TIME < TO_TIMESTAMP_NTZ(?)
ORDER BY ITEM_NUMBER LIMIT ?`;

const WMS_WORKORDERS_SQL = `
SELECT "wo_number", "week", "submeal_item_number", "submeal_item_desctiption",
    "meal_item_number", "meal_item_descrption", "quantity", "uom", "plates",
    "target_per_plate", "pre_blast_quantity", "preblast_location", "status",
    "expiration_date", "production_time", "last_updated"
FROM US_OPS_ANALYTICS.HIGHJUMP_ANALYTICS.V_SUBMEAL_PRODUCTION
WHERE "wh_id" = ? AND "week" IN (?, ?, ?, ?) ORDER BY "week" DESC LIMIT ?`;

// ── Mapper (identisch zu functions/index.js) ────────────────────────────────

function str(value: unknown): string { return value == null ? "" : String(value); }
function numOrNull(value: unknown): number | null { const n = Number(value); return Number.isFinite(n) ? n : null; }
function dateIsoOrNull(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mapPlatingLike(row: Record<string, unknown>) {
  return {
    locationId: str(row.LOCATION_ID), itemNumber: str(row.ITEM_NUMBER), actualQty: numOrNull(row.ACTUAL_QTY),
    lotNumber: str(row.LOT_NUMBER), huId: str(row.HU_ID), status: str(row.STATUS),
    fifoDate: dateIsoOrNull(row.FIFO_DATE), expirationDate: dateIsoOrNull(row.EXPIRATION_DATE),
    dbChangeCommitTime: dateIsoOrNull(row.DB_CHANGE_COMMIT_TIME), kw: numOrNull(row.KW),
  };
}

function mapSleevingLike(row: Record<string, unknown>) {
  return {
    von: str(row.VON), nach: str(row.NACH), tranType: str(row.TRAN_TYPE), itemNumber: str(row.ITEM_NUMBER),
    tranQty: numOrNull(row.TRAN_QTY), startTranDate: dateIsoOrNull(row.START_TRAN_DATE),
    endTranDate: dateIsoOrNull(row.END_TRAN_DATE), kw: numOrNull(row.KW),
    employeeId: str(row.EMPLOYEE_ID), description: str(row.DESCRIPTION),
  };
}

function mapInbound(row: Record<string, unknown>) {
  return {
    poNumber: str(row.PO_NUMBER), itemNumber: str(row.ITEM_NUMBER), qtyReceived: numOrNull(row.QTY_RECEIVED),
    qtyDamaged: numOrNull(row.QTY_DAMAGED), receiptDate: dateIsoOrNull(row.RECEIPT_DATE),
    vendorCode: str(row.VENDOR_CODE), huId: str(row.HU_ID), lotNumber: str(row.LOT_NUMBER),
    expirationDate: dateIsoOrNull(row.EXPIRATION_DATE), shipmentNumber: str(row.SHIPMENT_NUMBER),
    tranStatus: str(row.TRAN_STATUS), status: str(row.STATUS),
    dbChangeCommitTime: dateIsoOrNull(row.DB_CHANGE_COMMIT_TIME), kw: numOrNull(row.KW),
  };
}

function mapWorkorder(row: Record<string, unknown>) {
  return {
    woNumber: str(row.wo_number), week: str(row.week),
    submealItemNumber: str(row.submeal_item_number), submealItemDescription: str(row.submeal_item_desctiption),
    mealItemNumber: str(row.meal_item_number), mealItemDescription: str(row.meal_item_descrption),
    quantity: numOrNull(row.quantity), uom: str(row.uom), plates: numOrNull(row.plates),
    targetPerPlate: numOrNull(row.target_per_plate), preBlastQuantity: numOrNull(row.pre_blast_quantity),
    preBlastLocation: str(row.preblast_location), status: str(row.status),
    expirationDate: dateIsoOrNull(row.expiration_date), productionTime: dateIsoOrNull(row.production_time),
    lastUpdated: dateIsoOrNull(row.last_updated),
  };
}

// ── Date-Range Helper (identisch zu functions/index.js parseWmsParams) ─────

function localDateIso(date = new Date()): string {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}
function shiftedIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function rangeFor(lookbackDays: number) {
  const today = localDateIso();
  return { rangeStart: shiftedIsoDate(today, -lookbackDays), rangeEnd: shiftedIsoDate(today, 1) };
}

// "week" in V_SUBMEAL_PRODUCTION is "YYYYWW" and already uses this app's own
// hfWeek convention (Factor-KW = ISO-KW + 1) -- verified empirically against
// real cached rows (a row with productionTime 2026-05-21, ISO week 21, was
// tagged week "202622"). No further offset needed when comparing to hfWeek.
function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}
function currentHfWeek(): string {
  const iso = isoWeekLabel(new Date());
  const [, y, w] = iso.match(/^(\d{4})-W(\d{2})$/) ?? [];
  const year = Number(y);
  const week = Number(w) + 1;
  return week <= 52 ? `${year}-W${String(week).padStart(2, "0")}` : `${year + 1}-W01`;
}
function hfWeekToWmsCode(hfWeek: string): string {
  const [, y, w] = hfWeek.match(/^(\d{4})-W(\d{2})$/) ?? [];
  return `${y}${w}`;
}

// ── Snowflake SSO Connect ───────────────────────────────────────────────────

function connectSnowflake(): Promise<snowflake.Connection> {
  console.log("SSO-Anmeldung startet im Browser (HelloFresh-Login) ...");
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: ACCOUNT, username: USER, authenticator: "externalbrowser",
      role: ROLE, warehouse: WAREHOUSE, database: DATABASE, schema: SCHEMA,
      application: "rezeptlogik_wms_sync_cache",
    } as snowflake.ConnectionOptions);
    conn.connect((err, connection) => err ? reject(err) : resolve(connection));
  });
}

function executeQuery(conn: snowflake.Connection, sqlText: string, binds: unknown[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds: binds as snowflake.Binds,
      complete(err, _stmt, rows) { if (err) reject(err); else resolve((rows ?? []) as Record<string, unknown>[]); },
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

type Job = { cacheKey: string; sql: string; binds: unknown[]; mapper: (row: Record<string, unknown>) => unknown; label: string };

async function main() {
  configureFirestoreWriterAuth();
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  const conn = await connectSnowflake();
  console.log("Snowflake verbunden.\n");

  const r60 = rangeFor(60);
  const r90 = rangeFor(90);

  // Work-Orders gezielt auf ein Wochenfenster einschraenken: letzte KW (fuer
  // nachlaufende Kuechen-Updates) bis KW+2 (fuer "ein paar Tage vorher schon
  // Daten fuer die neue KW"). Ohne diesen Filter liefert die Quelle irgendeine
  // Mischung quer durch die Historie (last_updated ist ein Batch-Timestamp,
  // fuer ALLE Zeilen identisch -- ORDER BY danach ist wirkungslos).
  const hfWeek = currentHfWeek();
  const weekWindow = [hfWeekToWmsCode(hfWeek)];
  console.log(`Work-Orders Wochenfenster: ${weekWindow.join(", ")} (aktuelle hfWeek: ${hfWeek})\n`);

  const jobs: Job[] = [
    { cacheKey: "wms-plating-latest", sql: WMS_PLATING_SQL, binds: [WH_ID, r60.rangeStart, r60.rangeEnd, 25000], mapper: mapPlatingLike, label: "Plating" },
    { cacheKey: "wms-plating-history-latest", sql: WMS_PLATING_HISTORY_SQL, binds: [WH_ID, r90.rangeStart, r90.rangeEnd, 25000], mapper: mapSleevingLike, label: "Plating-History" },
    { cacheKey: "wms-sleeving-latest", sql: WMS_SLEEVING_SQL, binds: [WH_ID, r60.rangeStart, r60.rangeEnd, 25000], mapper: mapSleevingLike, label: "Sleeving" },
    { cacheKey: "wms-inbound-latest", sql: WMS_INBOUND_SQL, binds: [WH_ID, r60.rangeStart, r60.rangeEnd, 25000], mapper: mapInbound, label: "Inbound" },
    { cacheKey: "wms-staging-latest", sql: WMS_STAGING_SQL, binds: [WH_ID, r60.rangeStart, r60.rangeEnd, 25000], mapper: mapPlatingLike, label: "Staging" },
    { cacheKey: "wms-debox-latest", sql: WMS_DEBOX_SQL, binds: [WH_ID, r60.rangeStart, r60.rangeEnd, 25000], mapper: mapPlatingLike, label: "Debox" },
    { cacheKey: "wms-postblast-latest", sql: WMS_POSTBLAST_SQL, binds: [WH_ID, r60.rangeStart, r60.rangeEnd, 25000], mapper: mapPlatingLike, label: "Postblast" },
    { cacheKey: "workorders", sql: WMS_WORKORDERS_SQL, binds: [WH_ID, ...weekWindow, 25000], mapper: mapWorkorder, label: "Workorders" },
  ];

  // Firestore-Limit: 1 MiB pro Dokument. Zeilen sind bereits nach Aktualitaet
  // sortiert (ORDER BY ... DESC in der SQL) -- bei Ueberschreitung kappen wir
  // auf die neuesten Zeilen, statt den Push fehlschlagen zu lassen.
  const MAX_DOC_BYTES = 900_000; // Sicherheitsabstand zum 1_048_576-Byte-Limit
  function capToByteBudget<T>(rows: T[]): T[] {
    const bytes = Buffer.byteLength(JSON.stringify(rows));
    if (bytes <= MAX_DOC_BYTES) return rows;
    const avgBytesPerRow = bytes / rows.length;
    let capped = rows.slice(0, Math.max(1, Math.floor(MAX_DOC_BYTES / avgBytesPerRow)));
    // Zweiter Durchgang: Zeilenlaenge kann stark variieren, einmal nachschaerfen.
    while (capped.length > 1 && Buffer.byteLength(JSON.stringify(capped)) > MAX_DOC_BYTES) {
      capped = capped.slice(0, Math.floor(capped.length * 0.9));
    }
    return capped;
  }

  for (const job of jobs) {
    console.log(`→ ${job.label} …`);
    const rawRows = await executeQuery(conn, job.sql, job.binds);
    const allRows = rawRows.map(job.mapper);
    const rows = capToByteBudget(allRows);
    if (rows.length < allRows.length) {
      console.log(`  ⚠ ${allRows.length} Zeilen wuerden das 1-MB-Firestore-Limit sprengen -- auf die ${rows.length} neuesten gekappt`);
    }
    const pushedAt = new Date().toISOString();
    await db.collection("wmsCache").doc(job.cacheKey).set({ rows, generatedAt: pushedAt, pushedAt, whId: WH_ID });
    console.log(`  ${rows.length} Zeilen → wmsCache/${job.cacheKey}`);
  }

  console.log("\n✓ WMS-Cache aktualisiert. Deployte App liest das jetzt automatisch (Fallback in functions/index.js).");
  try { conn.destroy(() => undefined); } catch { /* egal */ }
  process.exit(0);
}

main().catch((e) => { console.error("FEHLER:", e?.message ?? e); process.exit(1); });
