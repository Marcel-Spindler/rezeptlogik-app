/**
 * Lokaler Snowflake-Server fuer WMS Live.
 *
 * Behaelt nur die Zugangsdaten lokal und stellt die aktuellen WMS-Queries bereit.
 * Keine Firebase-Persistenz, kein Cache.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: "functions/.env" });
loadEnv({ path: ".env.local" });

import snowflake from "snowflake-sdk";

const PORT = 3141;

const ACCOUNT = process.env.SNOWFLAKE_ACCOUNT ?? "XG02811-OO69432";
const USER = process.env.SNOWFLAKE_USER ?? "MARCEL.SPINDLER@HELLOFRESH.DE";
const ROLE = process.env.SNOWFLAKE_ROLE ?? "US_OPS_ANALYTICS_USER";
const WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE ?? "US_OPS_ANALYTICS";
const DATABASE = process.env.SNOWFLAKE_DATABASE ?? "US_OPS_ANALYTICS";
const SCHEMA = process.env.SNOWFLAKE_SCHEMA ?? "HIGHJUMP";

let cachedConn: snowflake.Connection | undefined;
let connectingConn: Promise<snowflake.Connection> | undefined;

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

type WmsPlatingRow = {
  locationId: string;
  itemNumber: string;
  actualQty: number | null;
  lotNumber: string;
  huId: string;
  status: string;
  fifoDate: string | null;
  expirationDate: string | null;
  dbChangeCommitTime: string | null;
  kw: number | null;
};

type WmsSleevingRow = {
  von: string;
  nach: string;
  tranType: string;
  itemNumber: string;
  tranQty: number | null;
  startTranDate: string | null;
  endTranDate: string | null;
  kw: number | null;
  employeeId: string;
  description: string;
};

type WmsPlatingHistoryRow = WmsSleevingRow;

type WmsInboundRow = {
  poNumber: string;
  itemNumber: string;
  qtyReceived: number | null;
  qtyDamaged: number | null;
  receiptDate: string | null;
  vendorCode: string;
  huId: string;
  lotNumber: string;
  expirationDate: string | null;
  shipmentNumber: string;
  tranStatus: string;
  status: string;
  dbChangeCommitTime: string | null;
  kw: number | null;
};

type WmsStagingRow = {
  locationId: string;
  itemNumber: string;
  actualQty: number | null;
  lotNumber: string;
  huId: string;
  status: string;
  fifoDate: string | null;
  expirationDate: string | null;
  dbChangeCommitTime: string | null;
  kw: number | null;
};

type WmsDeboxRow = WmsStagingRow;
type WmsPostblastRow = WmsStagingRow;

type WeekRange = {
  toolWeek: string;
  wmsWeek: string;
  startDate: string;
  endDate: string;
};

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

function currentHfWeek(): string {
  const today = new Date();
  const iso = isoWeekLabel(today);
  const match = iso.match(/^(20\d{2})-W(\d{2})$/);
  if (!match) return iso;
  const year = Number(match[1]);
  const week = Number(match[2]) + 1;
  if (week <= 52) return `${year}-W${String(week).padStart(2, "0")}`;
  return `${year + 1}-W01`;
}

function wmsRangeForToolWeek(raw: string): WeekRange {
  const match = raw.trim().match(/^(20\d{2})-W(\d{2})$/);
  if (!match) throw new Error(`Ungueltige Tool-KW: ${raw}`);
  const toolYear = Number(match[1]);
  const toolWeek = Number(match[2]);
  const wmsWeekStart = isoWeekStart(toolYear, toolWeek);
  wmsWeekStart.setUTCDate(wmsWeekStart.getUTCDate() - 7);
  const wmsWeekEnd = new Date(wmsWeekStart);
  wmsWeekEnd.setUTCDate(wmsWeekStart.getUTCDate() + 7);
  return {
    toolWeek: `${toolYear}-W${String(toolWeek).padStart(2, "0")}`,
    wmsWeek: isoWeekLabel(wmsWeekStart),
    startDate: wmsWeekStart.toISOString().slice(0, 10),
    endDate: wmsWeekEnd.toISOString().slice(0, 10),
  };
}

function shiftedIsoDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function connectSnowflake(): Promise<snowflake.Connection> {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: ACCOUNT,
      username: USER,
      authenticator: "externalbrowser",
      role: ROLE,
      warehouse: WAREHOUSE,
      database: DATABASE,
      schema: SCHEMA,
      application: "rezeptlogik_wms_plating",
    } as snowflake.ConnectionOptions);
    conn.connect((err, connection) => err ? reject(err) : resolve(connection));
  });
}

function executeQuery(conn: snowflake.Connection, sqlText: string, binds: unknown[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds: binds as snowflake.Binds,
      complete(err, _stmt, rows) {
        err ? reject(err) : resolve((rows ?? []) as Record<string, unknown>[]);
      },
    });
  });
}

function destroyConnection(conn: snowflake.Connection): Promise<void> {
  return new Promise((resolve) => {
    try {
      conn.destroy(() => resolve());
    } catch {
      resolve();
    }
  });
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function ensureConnection(): Promise<snowflake.Connection> {
  if (cachedConn) return cachedConn;
  if (!connectingConn) {
    console.log("SSO-Anmeldung startet im Browser ...");
    connectingConn = connectSnowflake()
      .then((conn) => {
        cachedConn = conn;
        console.log("Snowflake verbunden.");
        return conn;
      })
      .finally(() => {
        connectingConn = undefined;
      });
  }
  cachedConn = await connectingConn;
  return cachedConn;
}

function stringValue(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return value == null ? "" : String(value);
}

function numberValue(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value == null || value === "") return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapWmsPlatingRow(row: Record<string, unknown>): WmsPlatingRow {
  return {
    locationId: stringValue(row, "LOCATION_ID"),
    itemNumber: stringValue(row, "ITEM_NUMBER"),
    actualQty: numberValue(row, "ACTUAL_QTY"),
    lotNumber: stringValue(row, "LOT_NUMBER"),
    huId: stringValue(row, "HU_ID"),
    status: stringValue(row, "STATUS"),
    fifoDate: dateValue(row, "FIFO_DATE"),
    expirationDate: dateValue(row, "EXPIRATION_DATE"),
    dbChangeCommitTime: dateValue(row, "DB_CHANGE_COMMIT_TIME"),
    kw: numberValue(row, "KW"),
  };
}

function mapWmsSleevingRow(row: Record<string, unknown>): WmsSleevingRow {
  return {
    von: stringValue(row, "VON"),
    nach: stringValue(row, "NACH"),
    tranType: stringValue(row, "TRAN_TYPE"),
    itemNumber: stringValue(row, "ITEM_NUMBER"),
    tranQty: numberValue(row, "TRAN_QTY"),
    startTranDate: dateValue(row, "START_TRAN_DATE"),
    endTranDate: dateValue(row, "END_TRAN_DATE"),
    kw: numberValue(row, "KW"),
    employeeId: stringValue(row, "EMPLOYEE_ID"),
    description: stringValue(row, "DESCRIPTION"),
  };
}

function mapWmsPlatingHistoryRow(row: Record<string, unknown>): WmsPlatingHistoryRow {
  return mapWmsSleevingRow(row);
}

function mapWmsInboundRow(row: Record<string, unknown>): WmsInboundRow {
  return {
    poNumber: stringValue(row, "PO_NUMBER"),
    itemNumber: stringValue(row, "ITEM_NUMBER"),
    qtyReceived: numberValue(row, "QTY_RECEIVED"),
    qtyDamaged: numberValue(row, "QTY_DAMAGED"),
    receiptDate: dateValue(row, "RECEIPT_DATE"),
    vendorCode: stringValue(row, "VENDOR_CODE"),
    huId: stringValue(row, "HU_ID"),
    lotNumber: stringValue(row, "LOT_NUMBER"),
    expirationDate: dateValue(row, "EXPIRATION_DATE"),
    shipmentNumber: stringValue(row, "SHIPMENT_NUMBER"),
    tranStatus: stringValue(row, "TRAN_STATUS"),
    status: stringValue(row, "STATUS"),
    dbChangeCommitTime: dateValue(row, "DB_CHANGE_COMMIT_TIME"),
    kw: numberValue(row, "KW"),
  };
}

function mapWmsStagingRow(row: Record<string, unknown>): WmsStagingRow {
  return {
    locationId: stringValue(row, "LOCATION_ID"),
    itemNumber: stringValue(row, "ITEM_NUMBER"),
    actualQty: numberValue(row, "ACTUAL_QTY"),
    lotNumber: stringValue(row, "LOT_NUMBER"),
    huId: stringValue(row, "HU_ID"),
    status: stringValue(row, "STATUS"),
    fifoDate: dateValue(row, "FIFO_DATE"),
    expirationDate: dateValue(row, "EXPIRATION_DATE"),
    dbChangeCommitTime: dateValue(row, "DB_CHANGE_COMMIT_TIME"),
    kw: numberValue(row, "KW"),
  };
}

function mapWmsDeboxRow(row: Record<string, unknown>): WmsDeboxRow {
  return mapWmsStagingRow(row);
}

function mapWmsPostblastRow(row: Record<string, unknown>): WmsPostblastRow {
  return mapWmsStagingRow(row);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      connected: Boolean(cachedConn),
      account: ACCOUNT,
      user: USER,
      role: ROLE,
      warehouse: WAREHOUSE,
      database: DATABASE,
      schema: SCHEMA,
    });
    return;
  }

  if (url.pathname === "/connect" && req.method === "GET") {
    try {
      await ensureConnection();
      sendJson(res, 200, { ok: true, connected: true });
    } catch (error) {
      if (cachedConn) {
        void destroyConnection(cachedConn);
        cachedConn = undefined;
      }
      connectingConn = undefined;
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/wms-plating" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    const range = wmsRangeForToolWeek(week);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 25000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50000, Math.max(1, Math.round(requestedLimit)))
      : 25000;

    try {
      const conn = await ensureConnection();
      console.log(`WMS Plating Query startet: WH_ID=${whId}, TOOL_WEEK=${range.toolWeek}, WMS_WEEK=${range.wmsWeek}, RANGE=${range.startDate}..${range.endDate}, LIMIT=${limit}`);
      const rows = await executeQuery(conn, WMS_PLATING_SQL, [whId, range.startDate, range.endDate, limit]);
      sendJson(res, 200, {
        ok: true,
        whId,
        week: range.toolWeek,
        wmsWeek: range.wmsWeek,
        rangeStart: range.startDate,
        rangeEnd: range.endDate,
        limit,
        generatedAt: new Date().toISOString(),
        rows: rows.map(mapWmsPlatingRow),
      });
    } catch (error) {
      if (cachedConn) {
        void destroyConnection(cachedConn);
        cachedConn = undefined;
      }
      connectingConn = undefined;
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/wms-sleeving" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    const range = wmsRangeForToolWeek(week);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 25000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50000, Math.max(1, Math.round(requestedLimit)))
      : 25000;

    try {
      const conn = await ensureConnection();
      console.log(`WMS Sleeving Query startet: WH_ID=${whId}, TOOL_WEEK=${range.toolWeek}, WMS_WEEK=${range.wmsWeek}, RANGE=${range.startDate}..${range.endDate}, LIMIT=${limit}`);
      const rows = await executeQuery(conn, WMS_SLEEVING_SQL, [whId, range.startDate, range.endDate, limit]);
      sendJson(res, 200, {
        ok: true,
        whId,
        week: range.toolWeek,
        wmsWeek: range.wmsWeek,
        rangeStart: range.startDate,
        rangeEnd: range.endDate,
        limit,
        generatedAt: new Date().toISOString(),
        rows: rows.map(mapWmsSleevingRow),
      });
    } catch (error) {
      if (cachedConn) {
        void destroyConnection(cachedConn);
        cachedConn = undefined;
      }
      connectingConn = undefined;
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/wms-plating-history" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    const range = wmsRangeForToolWeek(week);
    const requestedLookbackDays = Number(url.searchParams.get("lookbackDays") ?? 28);
    const lookbackDays = Number.isFinite(requestedLookbackDays)
      ? Math.min(90, Math.max(1, Math.round(requestedLookbackDays)))
      : 28;
    const historyStart = shiftedIsoDate(range.startDate, -lookbackDays);
    const historyEnd = range.startDate;
    const requestedLimit = Number(url.searchParams.get("limit") ?? 25000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50000, Math.max(1, Math.round(requestedLimit)))
      : 25000;

    try {
      const conn = await ensureConnection();
      console.log(`WMS Plating History Query startet: WH_ID=${whId}, TOOL_WEEK=${range.toolWeek}, WMS_WEEK=${range.wmsWeek}, RANGE=${historyStart}..${historyEnd}, LIMIT=${limit}`);
      const rows = await executeQuery(conn, WMS_PLATING_HISTORY_SQL, [whId, historyStart, historyEnd, limit]);
      sendJson(res, 200, {
        ok: true,
        whId,
        week: range.toolWeek,
        wmsWeek: range.wmsWeek,
        rangeStart: historyStart,
        rangeEnd: historyEnd,
        limit,
        lookbackDays,
        generatedAt: new Date().toISOString(),
        rows: rows.map(mapWmsPlatingHistoryRow),
      });
    } catch (error) {
      if (cachedConn) {
        void destroyConnection(cachedConn);
        cachedConn = undefined;
      }
      connectingConn = undefined;
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/wms-inbound" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    const range = wmsRangeForToolWeek(week);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 25000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50000, Math.max(1, Math.round(requestedLimit)))
      : 25000;

    try {
      const conn = await ensureConnection();
      console.log(`WMS Inbound Query startet: WH_ID=${whId}, TOOL_WEEK=${range.toolWeek}, WMS_WEEK=${range.wmsWeek}, RANGE=${range.startDate}..${range.endDate}, LIMIT=${limit}`);
      const rows = await executeQuery(conn, WMS_INBOUND_SQL, [whId, range.startDate, range.endDate, limit]);
      sendJson(res, 200, {
        ok: true,
        whId,
        week: range.toolWeek,
        wmsWeek: range.wmsWeek,
        rangeStart: range.startDate,
        rangeEnd: range.endDate,
        limit,
        generatedAt: new Date().toISOString(),
        rows: rows.map(mapWmsInboundRow),
      });
    } catch (error) {
      if (cachedConn) {
        void destroyConnection(cachedConn);
        cachedConn = undefined;
      }
      connectingConn = undefined;
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/wms-staging" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    const range = wmsRangeForToolWeek(week);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 25000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50000, Math.max(1, Math.round(requestedLimit)))
      : 25000;

    try {
      const conn = await ensureConnection();
      console.log(`WMS Staging Query startet: WH_ID=${whId}, TOOL_WEEK=${range.toolWeek}, WMS_WEEK=${range.wmsWeek}, RANGE=${range.startDate}..${range.endDate}, LIMIT=${limit}`);
      const rows = await executeQuery(conn, WMS_STAGING_SQL, [whId, range.startDate, range.endDate, limit]);
      sendJson(res, 200, {
        ok: true,
        whId,
        week: range.toolWeek,
        wmsWeek: range.wmsWeek,
        rangeStart: range.startDate,
        rangeEnd: range.endDate,
        limit,
        generatedAt: new Date().toISOString(),
        rows: rows.map(mapWmsStagingRow),
      });
    } catch (error) {
      if (cachedConn) {
        void destroyConnection(cachedConn);
        cachedConn = undefined;
      }
      connectingConn = undefined;
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/wms-debox" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    const range = wmsRangeForToolWeek(week);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 25000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50000, Math.max(1, Math.round(requestedLimit)))
      : 25000;

    try {
      const conn = await ensureConnection();
      console.log(`WMS Debox Query startet: WH_ID=${whId}, TOOL_WEEK=${range.toolWeek}, WMS_WEEK=${range.wmsWeek}, RANGE=${range.startDate}..${range.endDate}, LIMIT=${limit}`);
      const rows = await executeQuery(conn, WMS_DEBOX_SQL, [whId, range.startDate, range.endDate, limit]);
      sendJson(res, 200, {
        ok: true,
        whId,
        week: range.toolWeek,
        wmsWeek: range.wmsWeek,
        rangeStart: range.startDate,
        rangeEnd: range.endDate,
        limit,
        generatedAt: new Date().toISOString(),
        rows: rows.map(mapWmsDeboxRow),
      });
    } catch (error) {
      if (cachedConn) {
        void destroyConnection(cachedConn);
        cachedConn = undefined;
      }
      connectingConn = undefined;
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/wms-postblast" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    const range = wmsRangeForToolWeek(week);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 25000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50000, Math.max(1, Math.round(requestedLimit)))
      : 25000;

    try {
      const conn = await ensureConnection();
      console.log(`WMS Postblast Query startet: WH_ID=${whId}, TOOL_WEEK=${range.toolWeek}, WMS_WEEK=${range.wmsWeek}, RANGE=${range.startDate}..${range.endDate}, LIMIT=${limit}`);
      const rows = await executeQuery(conn, WMS_POSTBLAST_SQL, [whId, range.startDate, range.endDate, limit]);
      sendJson(res, 200, {
        ok: true,
        whId,
        week: range.toolWeek,
        wmsWeek: range.wmsWeek,
        rangeStart: range.startDate,
        rangeEnd: range.endDate,
        limit,
        generatedAt: new Date().toISOString(),
        rows: rows.map(mapWmsPostblastRow),
      });
    } catch (error) {
      if (cachedConn) {
        void destroyConnection(cachedConn);
        cachedConn = undefined;
      }
      connectingConn = undefined;
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: "query-not-configured",
    detail: "Verfuegbar: GET /health, GET /connect, GET /wms-plating?week=YYYY-Www&whId=VF&limit=25000, GET /wms-plating-history?week=YYYY-Www&whId=VF&limit=25000&lookbackDays=28, GET /wms-sleeving?week=YYYY-Www&whId=VF&limit=25000, GET /wms-inbound?week=YYYY-Www&whId=VF&limit=25000, GET /wms-staging?week=YYYY-Www&whId=VF&limit=25000, GET /wms-debox?week=YYYY-Www&whId=VF&limit=25000, GET /wms-postblast?week=YYYY-Www&whId=VF&limit=25000.",
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Snowflake Local Server laeuft auf http://127.0.0.1:${PORT}`);
  console.log("Endpoints: GET /health, GET /connect, GET /wms-plating?week=YYYY-Www&whId=VF&limit=25000, GET /wms-plating-history?week=YYYY-Www&whId=VF&limit=25000&lookbackDays=28, GET /wms-sleeving?week=YYYY-Www&whId=VF&limit=25000, GET /wms-inbound?week=YYYY-Www&whId=VF&limit=25000, GET /wms-staging?week=YYYY-Www&whId=VF&limit=25000, GET /wms-debox?week=YYYY-Www&whId=VF&limit=25000, GET /wms-postblast?week=YYYY-Www&whId=VF&limit=25000");
});

server.on("error", (err) => {
  console.error("Server-Fehler:", err);
  process.exit(1);
});
