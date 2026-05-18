/**
 * sync-wms-cache.ts
 * ==================
 * Lokal: Liest Snowflake via SSO aus und speichert WMS-Daten als JSON
 * Diese Daten werden dann von Cloud Functions als Cache genutzt.
 * 
 * Nutzung:
 *   npx ts-node scripts/sync-wms-cache.ts [--week 2026-W21] [--days 7]
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import snowflake from "snowflake-sdk";
import { config as loadEnv } from "dotenv";
import admin from "firebase-admin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
loadEnv({ path: "functions/.env" });
loadEnv({ path: ".env.local" });

// ============================================================
// Snowflake Connection (lokal mit SSO/externalbrowser)
// ============================================================

interface SnowflakeOptions {
  account: string;
  username?: string;
  password?: string;
  authenticator?: string;
  warehouse: string;
  database: string;
  schema: string;
  role: string;
  application: string;
}

function getConnectionOptions(): SnowflakeOptions {
  const account = process.env.SNOWFLAKE_ACCOUNT;
  if (!account) {
    throw new Error("SNOWFLAKE_ACCOUNT erforderlich (.env)");
  }

  return {
    account,
    authenticator: process.env.SNOWFLAKE_AUTHENTICATOR || "externalbrowser",
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || "US_OPS_ANALYTICS",
    database: process.env.SNOWFLAKE_DATABASE || "US_OPS_ANALYTICS",
    schema: process.env.SNOWFLAKE_SCHEMA || "HIGHJUMP",
    role: process.env.SNOWFLAKE_ROLE || "US_OPS_ANALYTICS_USER",
    application: "rezeptlogik_wms_cache_sync",
  };
}

function connectSnowflake(): Promise<any> {
  const options = getConnectionOptions();
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(options);
    conn.connect((err, connection) => {
      if (err) {
        reject(err);
      } else {
        resolve(connection);
      }
    });
  });
}

function executeQuery(conn: any, sqlText: string, binds: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete(err: any, _stmt: any, rows: any[]) {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

// ============================================================
// Date Helpers
// ============================================================

function localDateIso(date = new Date()): string {
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 10);
}

function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const out = new Date(week1Monday);
  out.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return out;
}

function isoWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getWeekRange(weekStr: string): { start: string; end: string; label: string } {
  const match = (weekStr || "").trim().match(/^(20\d{2})-W(\d{2})$/);
  if (!match) {
    // Kein --week: aktuelle KW als Label (= Tool-KW), Datumsrange = eine Woche davor
    const today = new Date();
    const label = isoWeekLabel(today); // z.B. "2026-W22"
    const m2 = label.match(/^(20\d{2})-W(\d{2})$/)!;
    const start = isoWeekStart(Number(m2[1]), Number(m2[2]));
    start.setUTCDate(start.getUTCDate() - 7);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 7);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), label };
  }
  // Mit --week 2026-W23: label = "2026-W23", range = Woche davor (wie Cloud Function erwartet)
  const year = Number(match[1]);
  const week = Number(match[2]);
  const start = isoWeekStart(year, week);
  start.setUTCDate(start.getUTCDate() - 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    label: weekStr, // "2026-W23" bleibt "2026-W23" — kein Shift im Key
  };
}

// ============================================================
// SQL Queries (aus functions/index.js)
// ============================================================

const WMS_PLATING_SQL = `
SELECT
    LOCATION_ID,
    ITEM_NUMBER,
    ACTUAL_QTY,
    LOT_NUMBER,
    HU_ID,
    STATUS,
    FIFO_DATE,
    EXPIRATION_DATE,
    DB_CHANGE_COMMIT_TIME,
    WEEKOFYEAR(DB_CHANGE_COMMIT_TIME) AS KW
FROM US_OPS_ANALYTICS.HIGHJUMP.T_STORED_ITEM
WHERE WH_ID = ?
  AND (LOCATION_ID ILIKE '%PLAT%' OR LOCATION_ID ILIKE '%PLH%' OR LOCATION_ID ILIKE '%PLSTG%')
  AND DB_CHANGE_COMMIT_TIME >= TO_TIMESTAMP_NTZ(?)
  AND DB_CHANGE_COMMIT_TIME < TO_TIMESTAMP_NTZ(?)
ORDER BY LOCATION_ID, ITEM_NUMBER
LIMIT ?`;

const WMS_SLEEVING_SQL = `
SELECT
    LOCATION_ID AS VON,
    LOCATION_ID_2 AS NACH,
    TRAN_TYPE,
    ITEM_NUMBER,
    TRAN_QTY,
    START_TRAN_DATE,
    END_TRAN_DATE,
    WEEKOFYEAR(COALESCE(END_TRAN_DATE, START_TRAN_DATE)) AS KW,
    EMPLOYEE_ID,
    DESCRIPTION
FROM US_OPS_ANALYTICS.HIGHJUMP.T_TRAN_LOG
WHERE WH_ID = ?
  AND (LOCATION_ID ILIKE '%SLEEV%' OR LOCATION_ID_2 ILIKE '%SLEEV%')
  AND COALESCE(END_TRAN_DATE, START_TRAN_DATE) >= TO_TIMESTAMP_NTZ(?)
  AND COALESCE(END_TRAN_DATE, START_TRAN_DATE) < TO_TIMESTAMP_NTZ(?)
ORDER BY COALESCE(END_TRAN_DATE, START_TRAN_DATE) DESC
LIMIT ?`;

const WMS_PLATING_HISTORY_SQL = `
SELECT
    LOCATION_ID AS VON,
    LOCATION_ID_2 AS NACH,
    TRAN_TYPE,
    ITEM_NUMBER,
    TRAN_QTY,
    START_TRAN_DATE,
    END_TRAN_DATE,
    WEEKOFYEAR(COALESCE(END_TRAN_DATE, START_TRAN_DATE)) AS KW,
    EMPLOYEE_ID,
    DESCRIPTION
FROM US_OPS_ANALYTICS.HIGHJUMP.T_TRAN_LOG
WHERE WH_ID = ?
  AND (LOCATION_ID ILIKE 'PLATING-LINE-%' OR LOCATION_ID_2 ILIKE 'PLATING-LINE-%')
  AND COALESCE(END_TRAN_DATE, START_TRAN_DATE) >= TO_TIMESTAMP_NTZ(?)
  AND COALESCE(END_TRAN_DATE, START_TRAN_DATE) < TO_TIMESTAMP_NTZ(?)
ORDER BY COALESCE(END_TRAN_DATE, START_TRAN_DATE) DESC
LIMIT ?`;

const WMS_INBOUND_SQL = `
SELECT
    PO_NUMBER,
    ITEM_NUMBER,
    QTY_RECEIVED,
    QTY_DAMAGED,
    RECEIPT_DATE,
    VENDOR_CODE,
    HU_ID,
    LOT_NUMBER,
    EXPIRATION_DATE,
    SHIPMENT_NUMBER,
    TRAN_STATUS,
    STATUS,
    DB_CHANGE_COMMIT_TIME,
    WEEKOFYEAR(RECEIPT_DATE) AS KW
FROM US_OPS_ANALYTICS.HIGHJUMP.T_RECEIPT
WHERE WH_ID = ?
  AND RECEIPT_DATE >= TO_TIMESTAMP_NTZ(?)
  AND RECEIPT_DATE < TO_TIMESTAMP_NTZ(?)
ORDER BY RECEIPT_DATE DESC
LIMIT ?`;

const WMS_STAGING_SQL = `
SELECT
    LOCATION_ID,
    ITEM_NUMBER,
    ACTUAL_QTY,
    LOT_NUMBER,
    HU_ID,
    STATUS,
    FIFO_DATE,
    EXPIRATION_DATE,
    DB_CHANGE_COMMIT_TIME,
    WEEKOFYEAR(DB_CHANGE_COMMIT_TIME) AS KW
FROM US_OPS_ANALYTICS.HIGHJUMP.T_STORED_ITEM
WHERE WH_ID = ?
  AND LOCATION_ID ILIKE 'PHSTG%'
  AND DB_CHANGE_COMMIT_TIME >= TO_TIMESTAMP_NTZ(?)
  AND DB_CHANGE_COMMIT_TIME < TO_TIMESTAMP_NTZ(?)
ORDER BY LOCATION_ID, ITEM_NUMBER
LIMIT ?`;

const WMS_DEBOX_SQL = `
SELECT
    LOCATION_ID,
    ITEM_NUMBER,
    ACTUAL_QTY,
    LOT_NUMBER,
    HU_ID,
    STATUS,
    FIFO_DATE,
    EXPIRATION_DATE,
    DB_CHANGE_COMMIT_TIME,
    WEEKOFYEAR(DB_CHANGE_COMMIT_TIME) AS KW
FROM US_OPS_ANALYTICS.HIGHJUMP.T_STORED_ITEM
WHERE WH_ID = ?
  AND LOCATION_ID ILIKE '%DEBOX%'
  AND DB_CHANGE_COMMIT_TIME >= TO_TIMESTAMP_NTZ(?)
  AND DB_CHANGE_COMMIT_TIME < TO_TIMESTAMP_NTZ(?)
ORDER BY LOCATION_ID, ITEM_NUMBER
LIMIT ?`;

const WMS_POSTBLAST_SQL = `
SELECT
    LOCATION_ID,
    ITEM_NUMBER,
    ACTUAL_QTY,
    LOT_NUMBER,
    HU_ID,
    STATUS,
    FIFO_DATE,
    EXPIRATION_DATE,
    DB_CHANGE_COMMIT_TIME,
    WEEKOFYEAR(DB_CHANGE_COMMIT_TIME) AS KW
FROM US_OPS_ANALYTICS.HIGHJUMP.T_STORED_ITEM
WHERE WH_ID = ?
  AND LOCATION_ID = 'PostB-01'
  AND DB_CHANGE_COMMIT_TIME >= TO_TIMESTAMP_NTZ(?)
  AND DB_CHANGE_COMMIT_TIME < TO_TIMESTAMP_NTZ(?)
ORDER BY ITEM_NUMBER
LIMIT ?`;

const WMS_WORKORDERS_SQL = `
SELECT
    "wo_number",
    "week",
    "submeal_item_number",
    "submeal_item_desctiption",
    "meal_item_number",
    "meal_item_descrption",
    "quantity",
    "uom",
    "plates",
    "target_per_plate",
    "pre_blast_quantity",
    "preblast_location",
    "status",
    "expiration_date",
    "production_time",
    "last_updated"
FROM US_OPS_ANALYTICS.HIGHJUMP_ANALYTICS.V_SUBMEAL_PRODUCTION
WHERE "wh_id" = ?
ORDER BY "last_updated" DESC
LIMIT ?`;

// ============================================================
// Main Sync
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const weekIdx = args.indexOf("--week");
  const daysIdx = args.indexOf("--days");

  const weekArg = weekIdx >= 0 ? args[weekIdx + 1] : null;
  const daysArg = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) : 7;

  const range = getWeekRange(weekArg || "");
  const whId = process.env.SNOWFLAKE_WH_ID || "VF";
  const limit = 25000;

  console.log(`📦 WMS Cache Sync`);
  console.log(`   Cache-Key: ${range.label}`);
  console.log(`   Range: ${range.start} to ${range.end}`);
  console.log(`   Warehouse: ${whId}`);
  console.log("");

  let conn;
  try {
    console.log("🔗 Verbinde mit Snowflake (SSO)...");
    conn = await connectSnowflake();
    console.log("✅ Verbunden");
    console.log("");

    // plating-history braucht 28 Tage Lookback
    const historyStart = shiftDate(range.start, -28);

    const queries: Array<{ key: string; sql: string; binds: any[]; mapper: (r: any) => any }> = [
      { key: "wms-plating",         sql: WMS_PLATING_SQL,         binds: [whId, range.start, range.end, limit], mapper: mapWmsPlatingRow },
      { key: "wms-sleeving",        sql: WMS_SLEEVING_SQL,        binds: [whId, range.start, range.end, limit], mapper: mapWmsSleevingRow },
      { key: "wms-plating-history", sql: WMS_PLATING_HISTORY_SQL, binds: [whId, historyStart, range.end, limit], mapper: mapWmsSleevingRow },
      { key: "wms-inbound",         sql: WMS_INBOUND_SQL,         binds: [whId, range.start, range.end, limit], mapper: mapWmsInboundRow },
      { key: "wms-staging",         sql: WMS_STAGING_SQL,         binds: [whId, range.start, range.end, limit], mapper: mapWmsPlatingRow },
      { key: "wms-debox",           sql: WMS_DEBOX_SQL,           binds: [whId, range.start, range.end, limit], mapper: mapWmsPlatingRow },
      { key: "wms-postblast",       sql: WMS_POSTBLAST_SQL,       binds: [whId, range.start, range.end, limit], mapper: mapWmsPlatingRow },
      { key: "workorders",          sql: WMS_WORKORDERS_SQL,      binds: [whId, limit],                        mapper: mapWmsWorkordersRow },
    ];

    const datasets: Record<string, any[]> = {};
    for (const q of queries) {
      console.log(`⏳ Lade ${q.key}...`);
      const rows = await executeQuery(conn, q.sql, q.binds);
      datasets[q.key] = rows.map(q.mapper);
      console.log(`   ✅ ${rows.length} Zeilen`);
    }

    // Speichere alle Daten in public/data/
    const cacheFile = path.join(__dirname, "../public/data/wms-cache.json");
    const cacheData = {
      timestamp: new Date().toISOString(),
      week: range.label,
      range: { start: range.start, end: range.end },
      whId,
      datasets,
    };

    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
    console.log(`\n✅ JSON gespeichert: ${cacheFile}`);
    console.log(`   Größe: ${(fs.statSync(cacheFile).size / 1024).toFixed(1)} KB`);

    // Push nach Firestore
    console.log("\n📤 Push nach Firestore...");
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    const db = admin.firestore();
    const generatedAt = cacheData.timestamp;
    for (const [datasetKey, rows] of Object.entries(datasets)) {
      const docId = datasetKey === "workorders" ? "workorders" : `${datasetKey}-${range.label}`;
      await db.collection("wmsCache").doc(docId).set({ rows, source: "sync", week: range.label, generatedAt, pushedAt: new Date().toISOString() });
      console.log(`   ✅ wmsCache/${docId}: ${rows.length} Zeilen`);
    }
    console.log("✅ Firestore aktualisiert");

  } finally {
    if (conn) {
      conn.destroy((err: unknown) => {
        if (err) console.error("Disconnect error:", err);
      });
    }
  }
}

// ============================================================
// Helper
// ============================================================

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ============================================================
// Mapper (aus functions/index.js)
// ============================================================

function str(value: any): string {
  return value == null ? "" : String(value);
}

function numOrNull(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateIsoOrNull(value: any): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mapWmsPlatingRow(row: any) {
  return {
    locationId: str(row.LOCATION_ID),
    itemNumber: str(row.ITEM_NUMBER),
    actualQty: numOrNull(row.ACTUAL_QTY),
    lotNumber: str(row.LOT_NUMBER),
    huId: str(row.HU_ID),
    status: str(row.STATUS),
    fifoDate: dateIsoOrNull(row.FIFO_DATE),
    expirationDate: dateIsoOrNull(row.EXPIRATION_DATE),
    dbChangeCommitTime: dateIsoOrNull(row.DB_CHANGE_COMMIT_TIME),
    kw: numOrNull(row.KW),
  };
}

function mapWmsSleevingRow(row: any) {
  return {
    von: str(row.VON),
    nach: str(row.NACH),
    tranType: str(row.TRAN_TYPE),
    itemNumber: str(row.ITEM_NUMBER),
    tranQty: numOrNull(row.TRAN_QTY),
    startTranDate: dateIsoOrNull(row.START_TRAN_DATE),
    endTranDate: dateIsoOrNull(row.END_TRAN_DATE),
    kw: numOrNull(row.KW),
    employeeId: str(row.EMPLOYEE_ID),
    description: str(row.DESCRIPTION),
  };
}

function mapWmsInboundRow(row: any) {
  return {
    poNumber: str(row.PO_NUMBER),
    itemNumber: str(row.ITEM_NUMBER),
    qtyReceived: numOrNull(row.QTY_RECEIVED),
    qtyDamaged: numOrNull(row.QTY_DAMAGED),
    receiptDate: dateIsoOrNull(row.RECEIPT_DATE),
    vendorCode: str(row.VENDOR_CODE),
    huId: str(row.HU_ID),
    lotNumber: str(row.LOT_NUMBER),
    expirationDate: dateIsoOrNull(row.EXPIRATION_DATE),
    shipmentNumber: str(row.SHIPMENT_NUMBER),
    tranStatus: str(row.TRAN_STATUS),
    status: str(row.STATUS),
    dbChangeCommitTime: dateIsoOrNull(row.DB_CHANGE_COMMIT_TIME),
    kw: numOrNull(row.KW),
  };
}

function mapWmsWorkordersRow(row: any) {
  return {
    woNumber: str(row.wo_number),
    week: str(row.week),
    submealItemNumber: str(row.submeal_item_number),
    submealItemDescription: str(row.submeal_item_desctiption),
    mealItemNumber: str(row.meal_item_number),
    mealItemDescription: str(row.meal_item_descrption),
    quantity: numOrNull(row.quantity),
    uom: str(row.uom),
    plates: numOrNull(row.plates),
    targetPerPlate: numOrNull(row.target_per_plate),
    preBlastQuantity: numOrNull(row.pre_blast_quantity),
    preBlastLocation: str(row.preblast_location),
    status: str(row.status),
    expirationDate: dateIsoOrNull(row.expiration_date),
    productionTime: dateIsoOrNull(row.production_time),
    lastUpdated: dateIsoOrNull(row.last_updated),
  };
}

main().catch((err) => {
  console.error("❌ Fehler:", err.message);
  process.exit(1);
});
