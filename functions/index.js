const { createHash } = require("node:crypto");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const snowflake = require("snowflake-sdk");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");
const ExcelJS = require("exceljs");

const GEMINI_API_KEY_SECRET = defineSecret("GEMINI_API_KEY");

let VisionClientCtor = null;
try {
  const vision = require("@google-cloud/vision");
  VisionClientCtor = vision.ImageAnnotatorClient;
} catch {
  VisionClientCtor = null;
}

admin.initializeApp();

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const APP_ROOT = db.collection("apps").doc("rezeptlogik");
const AGENT_RUNS = APP_ROOT.collection("agentRuns");
const AGENT_PROPOSALS = APP_ROOT.collection("agentProposals");
const AGENT_APPLIES = APP_ROOT.collection("agentApplies");
const PLAN_WRITES = APP_ROOT.collection("planWrites");
const RACK_WRITES = APP_ROOT.collection("rackWrites");
const AGENT_ARTIFACTS = APP_ROOT.collection("agentRunArtifacts");
const DEFAULT_GSHEET_ID = "1IEi_CB9KylW2MgjNiGax5EIvhhAtkIzm57uO1sSESj8";
const SHEET_RANGE = "'Menu-Selection-LIVE'!A3:X1000";

function getSheetIds() {
  return [
    process.env.GSHEET_ID || DEFAULT_GSHEET_ID,
    ...(process.env.GSHEET_IDS || "").split(",")
  ].map(v => v.trim()).filter(Boolean);
}
const CHECK_COOLDOWN_MS = 60 * 1000;

const DEFAULT_GITHUB_MODELS_ENDPOINT = "https://models.inference.ai.azure.com/chat/completions";
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_INLINE_BYTES = 200 * 1024;
const DEFAULT_APPROVAL_MAX_AGE_MINUTES = 120;
const DEFAULT_WMS_LIMIT = 25000;

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

const WMS_PLATING_HOLDING_SQL = `
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
  AND LOCATION_ID ILIKE 'PLH%'
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
WHERE "wh_id" = ? AND "week" IN (?, ?, ?, ?)
ORDER BY "week" DESC
LIMIT ?`;

function num(value) {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function stableWeekRecipeId(row) {
  return `${row.hfWeek}__${row.code}`;
}

function safeJsonParse(value, fallback) {
  try {
    return typeof value === "string" ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function localDateIso(date = new Date()) {
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 10);
}

function isoWeekStart(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const out = new Date(week1Monday);
  out.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return out;
}

function isoWeekLabel(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function shiftedIsoDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// "week" in V_SUBMEAL_PRODUCTION is "YYYYWW" and already uses this app's own
// hfWeek convention (Factor-KW = ISO-KW + 1) -- verified empirically against
// real cached rows. No further offset needed when comparing to hfWeek.
function hfWeekFromIso(isoLabel) {
  const m = isoLabel.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return isoLabel;
  const year = Number(m[1]);
  const week = Number(m[2]) + 1;
  return week <= 52 ? `${year}-W${String(week).padStart(2, "0")}` : `${year + 1}-W01`;
}
function hfWeekPlusN(hfWeek, n) {
  const m = hfWeek.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return hfWeek;
  const year = Number(m[1]);
  const week = Number(m[2]) + n;
  if (week >= 1 && week <= 52) return `${year}-W${String(week).padStart(2, "0")}`;
  return week > 52 ? `${year + 1}-W${String(week - 52).padStart(2, "0")}` : `${year - 1}-W${String(week + 52).padStart(2, "0")}`;
}
function hfWeekToWmsCode(hfWeek) {
  const m = hfWeek.match(/^(\d{4})-W(\d{2})$/);
  return m ? `${m[1]}${m[2]}` : hfWeek;
}
function currentWorkorderWeekWindow(rawWeek) {
  const normalized = String(rawWeek || "").trim();
  const base = normalized && /^\d{4}-W\d{2}$/.test(normalized)
    ? normalized
    : hfWeekFromIso(isoWeekLabel(new Date()));
  const yearWeekCode = hfWeekToWmsCode(base);
  return [yearWeekCode];
}

function workorderPatternsForWeek(rawWeek) {
  const normalized = String(rawWeek || "").trim();
  const single = /^\d{4}-W\d{2}$/.test(normalized)
    ? normalized
    : hfWeekFromIso(isoWeekLabel(new Date()));
  const match = single.match(/^(\d{4})-W(\d{2})$/);
  if (!match) return ["1-%"];
  const selectedWeek = Number(match[2]);
  const yearWeekCode = `${match[1]}${String(selectedWeek).padStart(2, "0")}`;
  return [`${selectedWeek}-%`, `${yearWeekCode}-%`, `${yearWeekCode}`];
}

function buildWorkorderQueryForWeek(whId, rawWeek, limit) {
  const patterns = workorderPatternsForWeek(rawWeek);
  const clause = patterns.map(() => '"wo_number" LIKE ?').join(" OR ");
  return {
    sql: `
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
      WHERE "wh_id" = ? AND (${clause})
      ORDER BY "wo_number", "meal_item_number"
      LIMIT ?`,
    binds: [whId, ...patterns, limit],
  };
}

function wmsRangeForToolWeek(raw) {
  const match = String(raw || "").trim().match(/^(20\d{2})-W(\d{2})$/);
  if (!match) {
    const today = localDateIso();
    const todayWeek = isoWeekLabel(new Date(`${today}T12:00:00Z`));
    const m2 = todayWeek.match(/^(20\d{2})-W(\d{2})$/);
    if (!m2) return { wmsWeek: todayWeek, rangeStart: today, rangeEnd: today };
    const start = isoWeekStart(Number(m2[1]), Number(m2[2]));
    start.setUTCDate(start.getUTCDate() - 7);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 7);
    return {
      wmsWeek: todayWeek, // Tool-KW direkt als Cache-Key (kein Shift)
      rangeStart: start.toISOString().slice(0, 10),
      rangeEnd: end.toISOString().slice(0, 10),
    };
  }
  const start = isoWeekStart(Number(match[1]), Number(match[2]));
  start.setUTCDate(start.getUTCDate() - 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return {
    wmsWeek: raw, // Tool-KW direkt als Cache-Key (z.B. "2026-W23" → sucht "2026-W23")
    rangeStart: start.toISOString().slice(0, 10),
    rangeEnd: end.toISOString().slice(0, 10),
  };
}

let cachedWmsConn = null;
let connectingWmsConn = null;

function createSnowflakeConnectionOptions() {
  const account = process.env.SNOWFLAKE_ACCOUNT;
  const username = process.env.SNOWFLAKE_USER || "";
  const privateKeyRaw = process.env.SNOWFLAKE_PRIVATE_KEY || "";
  const role = process.env.SNOWFLAKE_ROLE || "US_OPS_ANALYTICS_USER";
  const warehouse = process.env.SNOWFLAKE_WAREHOUSE || "US_OPS_ANALYTICS";
  const database = process.env.SNOWFLAKE_DATABASE || "US_OPS_ANALYTICS";
  const schema = process.env.SNOWFLAKE_SCHEMA || "HIGHJUMP";

  if (!account) throw new Error("SNOWFLAKE_ACCOUNT erforderlich.");
  if (!username) throw new Error("SNOWFLAKE_USER erforderlich.");
  if (!privateKeyRaw) throw new Error("SNOWFLAKE_PRIVATE_KEY erforderlich.");

  // Private Key aus env var rekonstruieren (PKCS8 PEM, 64-Zeichen-Zeilen)
  const lines = privateKeyRaw.replace(/\s+/g, "").match(/.{1,64}/g) || [];
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;

  return {
    account,
    username,
    role,
    warehouse,
    database,
    schema,
    application: "rezeptlogik_wms_functions",
    authenticator: "SNOWFLAKE_JWT",
    privateKey,
  };
}

function connectSnowflake() {
  if (cachedWmsConn) return Promise.resolve(cachedWmsConn);
  if (connectingWmsConn) return connectingWmsConn;

  connectingWmsConn = new Promise((resolve, reject) => {
    let options;
    try {
      options = createSnowflakeConnectionOptions();
    } catch (error) {
      reject(error);
      return;
    }
    const conn = snowflake.createConnection(options);
    conn.connect((err, connection) => {
      if (err) {
        connectingWmsConn = null;
        reject(err);
        return;
      }
      cachedWmsConn = connection;
      connectingWmsConn = null;
      resolve(connection);
    });
  });

  return connectingWmsConn;
}

function executeSnowflakeQuery(conn, sqlText, binds) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete(err, _stmt, rows) {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

function str(value) {
  return value == null ? "" : String(value);
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mapWmsPlatingRow(row) {
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

function mapWmsSleevingRow(row) {
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

function mapWmsInboundRow(row) {
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

function mapWmsWorkordersRow(row) {
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

function parseWmsParams(req, options = {}) {
  const whId = str(req.query.whId || "VF") || "VF";
  const week = str(req.query.week || "");
  const limitRaw = Number(req.query.limit || DEFAULT_WMS_LIMIT);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100000, limitRaw)) : DEFAULT_WMS_LIMIT;
  const defaultLookback = options.defaultLookbackDays || 60;
  const lookbackDaysRaw = Number(req.query.lookbackDays || options.lookbackDays || defaultLookback);
  const lookbackDays = Number.isFinite(lookbackDaysRaw) ? Math.max(1, Math.min(365, lookbackDaysRaw)) : defaultLookback;
  const today = localDateIso();
  const rangeStart = shiftedIsoDate(today, -lookbackDays);
  const rangeEnd = shiftedIsoDate(today, 1);
  const wmsWeek = week || isoWeekLabel(new Date(`${today}T12:00:00Z`));
  return {
    whId,
    week,
    wmsWeek,
    rangeStart,
    rangeEnd,
    limit,
    lookbackDays,
  };
}

async function runWmsQuery(req, res, config) {
  const params = parseWmsParams(req, config);
  try {
    // Snowflake live (JWT key pair auth)
    try {
      const conn = await connectSnowflake();
      const rowsRaw = await executeSnowflakeQuery(conn, config.sql, [
        params.whId,
        params.rangeStart,
        params.rangeEnd,
        params.limit,
      ]);
      return res.json({
        ok: true,
        whId: params.whId,
        week: params.week,
        wmsWeek: params.wmsWeek,
        rangeStart: params.rangeStart,
        rangeEnd: params.rangeEnd,
        limit: params.limit,
        lookbackDays: params.lookbackDays,
        generatedAt: nowIso(),
        source: "snowflake-live",
        rows: rowsRaw.map(config.mapper),
      });
    } catch (snowflakeErr) {
      logger.warn(`WMS Snowflake failed (${config.name}), trying Firestore cache`, { error: snowflakeErr.message });
      cachedWmsConn = null; // force reconnect next time
    }

    // Firestore-Cache fallback (befüllt via: npm run wms:sync)
    const cacheKey = `${config.name}-latest`;
    const cacheDoc = await db.collection("wmsCache").doc(cacheKey).get();
    if (cacheDoc.exists) {
      const cached = cacheDoc.data();
      return res.json({
        ok: true,
        whId: params.whId,
        week: params.week,
        wmsWeek: params.wmsWeek,
        rangeStart: params.rangeStart,
        rangeEnd: params.rangeEnd,
        limit: params.limit,
        lookbackDays: params.lookbackDays,
        generatedAt: nowIso(),
        source: "firestore-cache",
        cachedAt: cached.pushedAt || cached.generatedAt,
        rows: cached.rows || [],
      });
    }

    throw new Error("Keine Daten: Snowflake JWT ungültig und kein Firestore-Cache. Bitte 'npm run wms:sync' ausführen.");
  } catch (error) {
    logger.error(`WMS endpoint ${config.name} failed`, { error: error?.message });
    res.status(500).json({
      ok: false,
      whId: params.whId,
      week: params.week,
      wmsWeek: params.wmsWeek,
      rangeStart: params.rangeStart,
      rangeEnd: params.rangeEnd,
      limit: params.limit,
      lookbackDays: params.lookbackDays,
      generatedAt: nowIso(),
      rows: [],
      error: error?.message || String(error),
    });
  }
}

function normalizeAgentRequest(body) {
  const payload = body && typeof body === "object" ? body : {};
  const schema = payload.schema && typeof payload.schema === "object" ? payload.schema : {};
  const provider = schema.provider === "github-models" ? "github-models" : "gemini";
  const objective = String(payload.objective || payload.prompt || "Erzeuge einen Planvorschlag fuer diese Woche.").trim();
  const attachmentsRaw = Array.isArray(payload.attachments) ? payload.attachments : [];
  const attachments = attachmentsRaw
    .slice(0, MAX_ATTACHMENTS)
    .map((item) => {
      const name = String(item?.name || "upload.bin").slice(0, 200);
      const mimeType = String(item?.mimeType || "application/octet-stream").slice(0, 120);
      const contentBase64 = String(item?.contentBase64 || "");
      let sizeBytes = 0;
      try {
        sizeBytes = Buffer.from(contentBase64, "base64").length;
      } catch {
        sizeBytes = 0;
      }
      return {
        name,
        mimeType,
        contentBase64,
        sizeBytes,
      };
    })
    .filter((item) => item.contentBase64 && item.sizeBytes > 0 && item.sizeBytes <= MAX_ATTACHMENT_BYTES);

  return {
    provider,
    schema,
    objective,
    attachments,
    executionMode: schema.executionMode === "dual-compare" ? "dual-compare" : "single",
    secondaryProvider: schema.secondaryProvider === "github-models" ? "github-models" : "gemini",
    secondaryModel: String(schema.secondaryModel || "").trim() || null,
    week: String(schema.weekContext || "").trim() || null,
    planningOasisContext: payload.planningOasisContext && typeof payload.planningOasisContext === "object" ? payload.planningOasisContext : null,
    runId: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    actorRole: String(payload.actorRole || "").trim(),
    actorId: String(payload.actorId || "").trim(),
    accessToken: String(payload.accessToken || "").trim(),
  };
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function hasAllowedRole(actorRole, allowedRoles) {
  const role = normalizeRole(actorRole);
  if (!role) return false;
  return (Array.isArray(allowedRoles) ? allowedRoles : [])
    .map(normalizeRole)
    .includes(role);
}

function authorizePipelineAction(schema, actorRole, accessToken, action) {
  const mode = schema?.access?.mode || "role-based";
  if (mode === "none") return { ok: true };

  if (mode === "token") {
    const expectedToken = process.env.AGENT_PIPELINE_TOKEN;
    if (!expectedToken) return { ok: false, error: "AGENT_PIPELINE_TOKEN fehlt im Backend." };
    if (!accessToken || accessToken !== expectedToken) {
      return { ok: false, error: "Token-Pruefung fehlgeschlagen." };
    }
    return { ok: true };
  }

  const roleMap = {
    trigger: schema?.access?.canTrigger,
    approve: schema?.access?.canApprove,
    publish: schema?.access?.canPublish,
  };
  const allowed = roleMap[action] || [];
  if (!hasAllowedRole(actorRole, allowed)) {
    return { ok: false, error: `Rolle '${actorRole || "unbekannt"}' darf Aktion '${action}' nicht ausfuehren.` };
  }
  return { ok: true };
}

function attachmentMeta(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map((file) => ({
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  }));
}

function decodeBase64Text(contentBase64) {
  try {
    return Buffer.from(contentBase64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function decodeBase64Bytes(contentBase64) {
  try {
    return Buffer.from(contentBase64, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function isTsvLike(mimeType, fileName) {
  const lower = `${mimeType} ${fileName}`.toLowerCase();
  return lower.includes("tsv") || fileName.toLowerCase().endsWith(".tsv") || mimeType === "text/tab-separated-values";
}

function isCsvLike(mimeType, fileName) {
  const lower = `${mimeType} ${fileName}`.toLowerCase();
  return lower.includes("csv") || fileName.toLowerCase().endsWith(".csv") || mimeType === "text/csv";
}

function isTextLike(mimeType, fileName) {
  if (isTsvLike(mimeType, fileName) || isCsvLike(mimeType, fileName)) return true;
  const lower = `${mimeType} ${fileName}`.toLowerCase();
  return lower.startsWith("text/") || fileName.toLowerCase().endsWith(".txt") || fileName.toLowerCase().endsWith(".json");
}

function isImageLike(mimeType, fileName) {
  const lower = `${mimeType} ${fileName}`.toLowerCase();
  return lower.startsWith("image/") || /\.(png|jpg|jpeg|webp)$/i.test(fileName);
}

function isExcelLike(mimeType, fileName) {
  const lower = `${mimeType} ${fileName}`.toLowerCase();
  return lower.includes("spreadsheet") || /\.(xlsx|xls)$/i.test(fileName);
}

function clampString(value, maxLen) {
  const text = String(value || "");
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

async function parseExcelAttachment(file) {
  const workbook = new ExcelJS.Workbook();
  const bytes = decodeBase64Bytes(file.contentBase64);
  await workbook.xlsx.load(bytes);

  const sheets = [];
  workbook.eachSheet((ws) => {
    if (sheets.length >= 3) return;
    const maxRows = Math.min(ws.actualRowCount || 0, 20);
    const previewRows = [];
    for (let r = 1; r <= maxRows; r += 1) {
      const row = ws.getRow(r);
      const values = row.values || [];
      const cells = [];
      for (let c = 1; c <= 12; c += 1) {
        const raw = values[c];
        if (raw === undefined || raw === null || raw === "") {
          cells.push("");
        } else if (typeof raw === "object" && raw.text) {
          cells.push(String(raw.text));
        } else {
          cells.push(String(raw));
        }
      }
      if (cells.some(Boolean)) previewRows.push(cells);
    }

    sheets.push({
      name: ws.name,
      rowCount: ws.actualRowCount || 0,
      columnCount: ws.actualColumnCount || 0,
      previewRows,
    });
  });

  return {
    sheets,
    sheetCount: workbook.worksheets.length,
  };
}

async function extractImageInsights(file) {
  const ocrEnabled = String(process.env.AGENT_OCR_ENABLED || "true").toLowerCase() !== "false";
  if (!ocrEnabled || !VisionClientCtor) {
    return {
      ocrText: "",
      tableLikeRows: [],
      ocrState: "disabled-or-client-missing",
    };
  }

  try {
    const client = new VisionClientCtor();
    const image = { content: file.contentBase64 };
    const [docResult] = await client.documentTextDetection({ image });
    const fullText = docResult?.fullTextAnnotation?.text || "";
    const lines = fullText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const tableLikeRows = lines
      .filter((line) => /	|\s{2,}|\|/.test(line))
      .slice(0, 20)
      .map((line) => clampString(line, 300));

    return {
      ocrText: clampString(fullText, 4000),
      tableLikeRows,
      ocrState: "ok",
    };
  } catch (error) {
    return {
      ocrText: "",
      tableLikeRows: [],
      ocrState: `error:${String(error?.message || error).slice(0, 120)}`,
    };
  }
}

async function enrichAttachment(file) {
  const base = {
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    contentBase64: file.contentBase64,
    sha256: createHash("sha256").update(file.contentBase64).digest("hex"),
    kind: "binary",
    parserState: "none",
    textPreview: "",
    tablePreview: [],
    excel: null,
    ocr: null,
  };

  if (isImageLike(file.mimeType, file.name)) {
    const ocr = await extractImageInsights(file);
    return {
      ...base,
      kind: "image",
      parserState: "ocr",
      textPreview: ocr.ocrText,
      tablePreview: ocr.tableLikeRows,
      ocr,
    };
  }

  if (isExcelLike(file.mimeType, file.name)) {
    try {
      const excel = await parseExcelAttachment(file);
      const sheetHead = excel.sheets
        .map((sheet) => `${sheet.name} [${sheet.rowCount}x${sheet.columnCount}]`)
        .join("; ");
      return {
        ...base,
        kind: "excel",
        parserState: "excel-ok",
        textPreview: clampString(sheetHead, 1000),
        tablePreview: excel.sheets.flatMap((sheet) => sheet.previewRows.slice(0, 4).map((row) => row.join("	"))).slice(0, 20),
        excel,
      };
    } catch (error) {
      return {
        ...base,
        kind: "excel",
        parserState: `excel-error:${String(error?.message || error).slice(0, 120)}`,
      };
    }
  }

  if (isTextLike(file.mimeType, file.name)) {
    const text = decodeBase64Text(file.contentBase64);
    const separator = isTsvLike(file.mimeType, file.name) ? "	" : ",";
    const rows = text.split(/\r?\n/).filter(Boolean);
    const previewRows = rows.slice(0, 20).map((line) => clampString(line, 300));
    const firstWidth = rows[0] ? rows[0].split(separator).length : 0;
    return {
      ...base,
      kind: isTsvLike(file.mimeType, file.name) ? "tsv" : (isCsvLike(file.mimeType, file.name) ? "csv" : "text"),
      parserState: "text-ok",
      textPreview: clampString(text, 4000),
      tablePreview: [`rows=${rows.length}`, `cols~=${firstWidth}`, ...previewRows.slice(0, 10)],
    };
  }

  return base;
}

async function enrichAttachments(attachments) {
  const out = [];
  for (const file of Array.isArray(attachments) ? attachments : []) {
    out.push(await enrichAttachment(file));
  }
  return out;
}

function buildAttachmentContext(attachments) {
  if (!attachments.length) return "Keine Attachments uebergeben.";
  const lines = ["Dateikontext:"];

  for (const file of attachments) {
    const header = `- ${file.name} (${file.mimeType}, ${file.sizeBytes} bytes)`;
    if (file.kind === "image") {
      lines.push(`${header} [Bild: OCR=${file.ocr?.ocrState || "n/a"}]`);
      if (file.textPreview) lines.push(`  OCR-Text:
${clampString(file.textPreview, 1200)}`);
      if (Array.isArray(file.tablePreview) && file.tablePreview.length > 0) {
        lines.push(`  Tabellen-Extrakt:
${file.tablePreview.slice(0, 8).join("\n")}`);
      }
      continue;
    }

    if (file.kind === "excel") {
      lines.push(`${header} [Excel: ${file.parserState}]`);
      if (file.excel?.sheets?.length) {
        const sheetLines = file.excel.sheets
          .map((sheet) => `  - Sheet ${sheet.name}: ${sheet.rowCount}x${sheet.columnCount}`)
          .join("\n");
        lines.push(sheetLines);
      }
      if (Array.isArray(file.tablePreview) && file.tablePreview.length > 0) {
        lines.push(`  Vorschau:
${file.tablePreview.slice(0, 8).join("\n")}`);
      }
      continue;
    }

    if (file.kind === "tsv" || file.kind === "csv" || file.kind === "text") {
      lines.push(`${header} [${file.kind}: ${file.parserState}]`);
      if (Array.isArray(file.tablePreview) && file.tablePreview.length > 0) {
        lines.push(`  Vorschau:
${file.tablePreview.slice(0, 10).join("\n")}`);
      } else if (file.textPreview) {
        lines.push(`  Text:
${clampString(file.textPreview, 1200)}`);
      }
      continue;
    }

    lines.push(`${header} [Dateityp ohne Parser, nur Metadaten verwendet]`);
  }

  return lines.join("\n");
}

async function cleanupExpiredArtifacts() {
  const nowTs = admin.firestore.Timestamp.now();
  const snap = await AGENT_ARTIFACTS.where("expiresAt", "<=", nowTs).limit(100).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  return snap.size;
}

async function storeRunArtifacts({ runId, request, enrichedAttachments }) {
  const retentionDaysRaw = Number(request.schema?.telemetry?.retentionDays ?? 30);
  const retentionDays = Number.isFinite(retentionDaysRaw)
    ? Math.max(1, Math.min(365, retentionDaysRaw))
    : 30;
  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + retentionDays * 24 * 60 * 60 * 1000);

  await cleanupExpiredArtifacts().catch(() => undefined);

  const writes = [];
  for (let i = 0; i < enrichedAttachments.length; i += 1) {
    const file = enrichedAttachments[i];
    const artifactId = `${runId}__${String(i + 1).padStart(2, "0")}`;
    const storeInlineBase64 = file.sizeBytes <= MAX_ARTIFACT_INLINE_BYTES;
    writes.push(
      AGENT_ARTIFACTS.doc(artifactId).set({
        artifactId,
        runId,
        week: request.week,
        name: file.name,
        mimeType: file.mimeType,
        kind: file.kind,
        sizeBytes: file.sizeBytes,
        parserState: file.parserState,
        sha256: file.sha256,
        textPreview: clampString(file.textPreview || "", 4000),
        tablePreview: Array.isArray(file.tablePreview) ? file.tablePreview.slice(0, 30) : [],
        excel: file.excel
          ? {
              sheetCount: file.excel.sheetCount,
              sheets: (file.excel.sheets || []).map((sheet) => ({
                name: sheet.name,
                rowCount: sheet.rowCount,
                columnCount: sheet.columnCount,
              })),
            }
          : null,
        ocr: file.ocr
          ? {
              state: file.ocr.ocrState,
              text: clampString(file.ocr.ocrText || "", 5000),
              tableLikeRows: Array.isArray(file.ocr.tableLikeRows) ? file.ocr.tableLikeRows.slice(0, 20) : [],
            }
          : null,
        contentBase64: storeInlineBase64 ? file.contentBase64 : null,
        inlineStored: storeInlineBase64,
        retentionDays,
        expiresAt,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true })
    );
  }
  await Promise.all(writes);
}

function buildSystemPrompt(schema) {
  const capabilities = Object.entries(schema.capabilities || {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([name]) => name);
  const rack = schema.rackV2Rules || {};
  const lines = Array.isArray(rack.selectedLines) ? rack.selectedLines : [];
  const automationProfile = String(schema.automationProfile || "").trim();
  const trainingPack = schema.planningOasisContext && typeof schema.planningOasisContext === "object" ? schema.planningOasisContext : null;
  const trainingSummary = trainingPack ? [
    `TrainingPack KW: ${String(trainingPack.week || "")}`,
    `Rezepte im Fokus: ${Array.isArray(trainingPack.recipes) ? trainingPack.recipes.length : 0}`,
    `Wochenziel: ${trainingPack.source?.totalTargetPortions ?? 0} Zielportionen / ${trainingPack.source?.workOrderCount ?? 0} Auftraege`,
    `OASE-Regeln: ${trainingPack.rules?.planLogic || "n/a"}`,
    `Antwortstil: ${trainingPack.rules?.answerStyle || "n/a"}`,
  ].join(" | ") : "";

  const automationRules = [
    "Automatik-Regel: Nutze 2 Runs und plane streng in dieser Reihenfolge.",
    "Run 1 bis Mittwoch priorisieren, Run 2 bis Freitag priorisieren.",
    "MHD-Regel beachten: Fisch engeres Fenster (9d), sonst Standardfenster (13d).",
    "Sub-Meals rueckwaerts vom Bedarfstag planen und lange/komplexe Sub-Meals frueher einplanen.",
  ];

  return [
    "Du bist ein Produktionsplanungs-Agent fuer Planning OASE.",
    "Antwortformat nur JSON mit den Schluesseln summary, verdict, status, actions, risks, improvements, questions, confidence.",
    "Keine erfundenen Zahlen. Unsichere Punkte als Risiko markieren.",
    "verdict muss genau eines von fertig, mist, besser sein.",
    "status soll eine kurze menschliche Antwort sein, als ob du direkt mit dem Nutzer sprichst.",
    `Aktive Faehigkeiten: ${capabilities.join(", ") || "keine"}.`,
    `Rack-V2 Linien im Scope: ${lines.join(", ") || "keine"}.`,
    trainingSummary,
    automationProfile === "two-run-mhd-backward-submeal" ? `Automationsprofil: ${automationProfile}.` : "",
    ...automationRules,
    rack.enforceFixedPackagingSlots ? "Rack-Regel: Packaging-Slots strikt einhalten." : "",
    rack.enforceDeLinerRules ? "Rack-Regel: DE-Liner-Regeln einhalten." : "",
    rack.enforceForezoneSlots ? "Rack-Regel: Forezone-Slots einhalten." : "",
    rack.enforceTierLogic ? "Rack-Regel: Tier-Logik einhalten." : "",
  ].filter(Boolean).join("\n");
}

function buildDeterministicFallbackResult(request, reason) {
  return {
    summary: `Fallback aktiv (${reason}). Deterministischer Vorschlag fuer ${request.week || "ohne KW"}.`,
    verdict: "besser",
    status: "Ich kann die Planung kommentieren, aber ohne Modellantwort ist das nur eine harte Regel-Notfallantwort.",
    actions: [
      "Dry-Run durchfuehren und Engpaesse markieren (2-Run-MHD-Profil)",
      "Run 1 bis Mittwoch und Run 2 bis Freitag gegen MHD-Fenster priorisieren",
      "Sub-Meals rueckwaerts vom Bedarfstag einplanen (lange Sub-Meals zuerst)",
      "Rack-V2 Regeln auf aktive Linien anwenden",
      "Planvorschlag zur Freigabe vorlegen",
    ],
    risks: [
      "Modellantwort nicht verfuegbar oder ungueltig",
      "Bitte Ergebnis vor Write-Back manuell pruefen",
    ],
    improvements: [
      "GEMINI_API_KEY oder GITHUB_MODELS_API_KEY setzen, damit echte Modellantworten kommen",
      "Rack-Automatik mit realen Zielwerten aus dem aktuellen Sheet gegenpruefen",
    ],
    questions: [
      "Soll ich den Plan nur kommentieren oder auch direkt optimieren?",
    ],
    confidence: 0.55,
    provider: "deterministic-fallback",
  };
}

function normalizeAgentResult(result, provider, model) {
  const payload = result && typeof result === "object" ? result : {};
  return {
    provider,
    model,
    summary: String(payload.summary || "").trim(),
    verdict: payload.verdict === "fertig" || payload.verdict === "mist" || payload.verdict === "besser" ? payload.verdict : "besser",
    status: String(payload.status || "").trim(),
    actions: Array.isArray(payload.actions) ? payload.actions : [],
    risks: Array.isArray(payload.risks) ? payload.risks : [],
    improvements: Array.isArray(payload.improvements) ? payload.improvements : [],
    questions: Array.isArray(payload.questions) ? payload.questions : [],
    confidence: Number.isFinite(Number(payload.confidence)) ? Math.max(0, Math.min(1, Number(payload.confidence))) : 0.5,
    raw: payload,
  };
}

function verdictScore(verdict) {
  if (verdict === "fertig") return 3;
  if (verdict === "besser") return 2;
  if (verdict === "mist") return 1;
  return 0;
}

function compareAgentResults(primary, secondary) {
  const primaryScore = verdictScore(primary.verdict) * 10 + primary.confidence * 5 + Math.min(primary.actions.length, 5);
  const secondaryScore = verdictScore(secondary.verdict) * 10 + secondary.confidence * 5 + Math.min(secondary.actions.length, 5);
  const winner = secondaryScore > primaryScore ? secondary : primary;
  const loser = winner === primary ? secondary : primary;
  return {
    winner,
    loser,
    recommendation: winner === primary
      ? `Primärmodell ${primary.provider}/${primary.model} hat den besseren OASE-Output geliefert.`
      : `Zweitmodell ${secondary.provider}/${secondary.model} hat den besseren OASE-Output geliefert.`,
    scoreboard: {
      primary: primaryScore,
      secondary: secondaryScore,
    },
  };
}

async function callGemini(request, enrichedAttachments, modelOverride) {
  const model = modelOverride || request.schema?.model || "gemini-2.5-pro";
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY fehlt.");

  const systemPrompt = buildSystemPrompt(request.schema);
  const attachmentContext = buildAttachmentContext(enrichedAttachments || []);
  const userParts = [{ text: `${systemPrompt}

Auftrag: ${request.objective}

Schema:
${JSON.stringify(request.schema)}

${attachmentContext}` }];

  for (const file of enrichedAttachments || []) {
    if (file.kind !== "image") continue;
    userParts.push({
      inlineData: {
        mimeType: file.mimeType || "image/png",
        data: file.contentBase64,
      },
    });
  }

  const payload = {
    contents: [{
      role: "user",
      parts: userParts,
    }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
    },
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini lieferte keinen Text.");
  const parsed = safeJsonParse(text, null);
  if (!parsed || typeof parsed !== "object") throw new Error("Gemini JSON-Antwort ungueltig.");
  return { provider: "gemini", model, result: parsed };
}

async function callGitHubModels(request, enrichedAttachments, modelOverride) {
  const model = modelOverride || request.schema?.model || "gpt-4.1";
  const endpoint = process.env.GITHUB_MODELS_ENDPOINT || DEFAULT_GITHUB_MODELS_ENDPOINT;
  const apiKey = process.env.GITHUB_MODELS_API_KEY;
  if (!apiKey) throw new Error("GITHUB_MODELS_API_KEY fehlt.");

  const systemPrompt = buildSystemPrompt(request.schema);
  const attachmentContext = buildAttachmentContext(enrichedAttachments || []);
  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Auftrag: ${request.objective}

Schema:
${JSON.stringify(request.schema)}

${attachmentContext}` },
    ],
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub Models HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("GitHub Models lieferte keinen Content.");
  const parsed = typeof content === "string" ? safeJsonParse(content, null) : content;
  if (!parsed || typeof parsed !== "object") throw new Error("GitHub Models JSON-Antwort ungueltig.");
  return { provider: "github-models", model, result: parsed };
}

async function runAgentByProvider(request, enrichedAttachments, providerOverride, modelOverride) {
  const provider = providerOverride || request.provider;
  if (provider === "github-models") return callGitHubModels(request, enrichedAttachments, modelOverride);
  return callGemini(request, enrichedAttachments, modelOverride);
}

async function storeRunTelemetry(params) {
  const {
    runId,
    request,
    startedAt,
    finishedAt,
    ok,
    usedFallback,
    error,
    provider,
    model,
  } = params;

  const telemetryEnabled = request.schema?.telemetry?.enabled !== false;
  if (!telemetryEnabled) return;

  const hashInput = request.schema?.telemetry?.hashUserInput !== false;
  const objectiveRaw = request.objective || "";
  const objective = hashInput
    ? createHash("sha256").update(objectiveRaw).digest("hex")
    : objectiveRaw;

  await AGENT_RUNS.doc(runId).set({
    runId,
    week: request.week,
    provider,
    model,
    ok,
    usedFallback,
    error: error ? String(error).slice(0, 2000) : null,
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    objective,
    attachmentCount: Array.isArray(request.attachments) ? request.attachments.length : 0,
    accessMode: request.schema?.access?.mode || "role-based",
    dryRun: request.schema?.actions?.defaultDryRun !== false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

function buildWeekRecipeHash(rows) {
  const normalized = rows
    .slice()
    .sort((a, b) => `${a.hfWeek}__${a.code}`.localeCompare(`${b.hfWeek}__${b.code}`));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function createSheetsClient() {
  const rawBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  const credentials = rawBase64
    ? JSON.parse(Buffer.from(rawBase64, "base64").toString("utf8"))
    : undefined;

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

function normalizeCell(value) {
  return String(value ?? "").trim();
}

function extractHfWeekFromTitle(title) {
  const direct = /(20\d{2})[-_ ]?W(\d{1,2})/i.exec(title);
  if (direct) return `${direct[1]}-W${String(parseInt(direct[2], 10)).padStart(2, "0")}`;
  const kw = /KW\s*(\d{1,2})/i.exec(title);
  if (kw) {
    const year = (process.env.GSHEET_HF_YEAR || "").trim() || String(new Date().getFullYear());
    return `${year}-W${String(parseInt(kw[1], 10)).padStart(2, "0")}`;
  }
  const w = /^W(\d{1,2})$/i.exec(title.trim());
  if (w) {
    const year = (process.env.GSHEET_HF_YEAR || "").trim() || String(new Date().getFullYear());
    return `${year}-W${String(parseInt(w[1], 10)).padStart(2, "0")}`;
  }
  return undefined;
}

function parseRecipeNameCell(full) {
  const text = normalizeCell(full);
  const m = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s*-\s*(.+?)(?:\s*\[(?:BNL|BENL|DE|DKSE|NORD)\])?\s*$/.exec(text);
  if (m) return { code: m[1], base: m[2].trim() };
  return { code: text, base: text };
}

function parseLegacyMealSelectionRows(rows, upsertWeekRecipe) {
  let added = 0;
  for (const row of rows) {
    const hfWeek = normalizeCell(row[0]);
    const code = normalizeCell(row[1]);
    const verdenAbsBENL = num(row[18]);
    const verdenAbsNORD = num(row[19]);
    const verdenAbsDE = num(row[20]);
    const ok = upsertWeekRecipe({
      hfWeek,
      weekShort: hfWeek.slice(5),
      code,
      recipeName: normalizeCell(row[3]),
      preference: normalizeCell(row[2]),
      slot: {
        BENL: num(row[5]) || undefined,
        DKSE: num(row[6]) || undefined,
        DE: num(row[7]) || undefined,
      },
      verdenVolume: {
        BENL: verdenAbsBENL,
        DKSE: verdenAbsNORD,
        DE: verdenAbsDE,
      },
      totalVerdenVolume: num(row[21]) || (verdenAbsBENL + verdenAbsNORD + verdenAbsDE),
      productionBuffer: num(row[23]),
    }, 40);
    if (ok) added += 1;
  }
  return added;
}

function parseRampUpConviniRows(rows, upsertWeekRecipe) {
  let added = 0;
  let inAllMarkets = false;

  for (const raw of rows) {
    const row = raw.map((cell) => normalizeCell(cell));
    const c0 = row[0] || "";
    const c1 = row[1] || "";
    const c3 = row[3] || "";
    const code = row[8] || "";

    if (!inAllMarkets && c0 === "All Markets" && c1 === "week.value" && code === "recipe code") {
      inAllMarkets = true;
      continue;
    }
    if (!inAllMarkets) continue;

    // PO-Abschnitte unterhalb der Tabelle sind keine Meal-Zeilen.
    if (c0.includes("Use POs below") || c0.includes("PO") || c1 === "distributionCenter.value") {
      break;
    }

    const hfWeek = c1;
    if (!/^\d{4}-W\d{2}$/.test(hfWeek) || !code) continue;

    const bnl = num(row[10]);
    const nord = num(row[14]);
    const de = num(row[18]);
    const slotVal = num(c3);

    const ok = upsertWeekRecipe({
      hfWeek,
      weekShort: normalizeCell(row[2]) || hfWeek.slice(5),
      code,
      recipeName: "",
      preference: "",
      slot: {
        BENL: slotVal || undefined,
        DKSE: slotVal || undefined,
        DE: slotVal || undefined,
      },
      verdenVolume: { BENL: bnl, DKSE: nord, DE: de },
      totalVerdenVolume: bnl + nord + de,
      productionBuffer: 0,
    }, 100);
    if (ok) added += 1;
  }

  return added;
}

function parseMskuInputRows(rows, hfWeek, upsertWeekRecipe) {
  if (!rows.length) return 0;
  const header = rows[0].map((cell) => normalizeCell(cell).toLowerCase());
  const recipeIdx = header.findIndex((h) => h === "recipe name" || h.includes("recipe name"));
  if (recipeIdx < 0) return 0;

  let added = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const full = normalizeCell(rows[i]?.[recipeIdx]);
    if (!full) continue;
    const { code, base } = parseRecipeNameCell(full);
    if (!/^[A-Z]{2}\d{4}[A-Z0-9]+$/.test(code)) continue;

    const ok = upsertWeekRecipe({
      hfWeek,
      weekShort: hfWeek.slice(5),
      code,
      recipeName: base,
    }, 10);
    if (ok) added += 1;
  }
  return added;
}

function parseWTabRows(rows, hfWeek, upsertWeekRecipe) {
  const marketToken = (value) => {
    const token = normalizeCell(value).toUpperCase().replace(/\s+/g, "");
    if (token === "BNL" || token === "BENL") return "BENL";
    if (token === "NOR" || token === "NORD" || token === "DKSE") return "DKSE";
    if (token === "DE") return "DE";
    return undefined;
  };

  const extractVolumes = (row) => {
    const out = { BENL: 0, DKSE: 0, DE: 0 };
    for (let i = 0; i < row.length - 1; i += 1) {
      const mk = marketToken(row[i] || "");
      if (!mk) continue;
      const v = num(row[i + 1]);
      if (v > 0) out[mk] = v;
    }
    return out;
  };

  let added = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i].map((cell) => normalizeCell(cell));
    const recipeCell = row.find((cell) => /^[A-Z]{2}\d{4}[A-Z0-9]+\s*-\s*/.test(cell));
    if (!recipeCell) continue;

    const { code, base } = parseRecipeNameCell(recipeCell);
    const vol = { BENL: 0, DKSE: 0, DE: 0 };

    const blockRows = rows.slice(i, Math.min(i + 10, rows.length));
    for (const blockRow of blockRows) {
      const parsed = extractVolumes(blockRow.map((cell) => normalizeCell(cell)));
      vol.BENL = Math.max(vol.BENL, parsed.BENL);
      vol.DKSE = Math.max(vol.DKSE, parsed.DKSE);
      vol.DE = Math.max(vol.DE, parsed.DE);
    }

    const ok = upsertWeekRecipe({
      hfWeek,
      weekShort: hfWeek.slice(5),
      code,
      recipeName: base,
      verdenVolume: vol,
      totalVerdenVolume: vol.BENL + vol.DKSE + vol.DE,
    }, 20);
    if (ok) added += 1;
  }

  return added;
}

async function readMealSelectionRows() {
  const sheets = await createSheetsClient();
  const byKey = new Map();
  const sourcePriority = new Map();
  const weeks = new Set();

  const keyOf = (hfWeek, code) => `${hfWeek}__${code}`;

  const upsertWeekRecipe = (patch, priority = 0) => {
    const hfWeek = normalizeCell(patch.hfWeek);
    const code = normalizeCell(patch.code).toUpperCase();
    if (!hfWeek || !code || !/^\d{4}-W\d{2}$/.test(hfWeek)) return false;

    const key = keyOf(hfWeek, code);
    const prevPriority = sourcePriority.get(key) ?? -1;
    const existing = byKey.get(key);

    if (existing && priority < prevPriority) {
      if (!existing.recipeName && patch.recipeName) existing.recipeName = patch.recipeName;
      if (!existing.preference && patch.preference) existing.preference = patch.preference;
      return false;
    }

    const next = {
      ...(existing || {
        hfWeek,
        weekShort: hfWeek.slice(5),
        code,
        recipeName: "",
        preference: "",
        slot: {},
        verdenVolume: { BENL: 0, DKSE: 0, DE: 0 },
        totalVerdenVolume: 0,
        productionBuffer: 0,
      }),
      hfWeek,
      weekShort: patch.weekShort || (existing?.weekShort ?? hfWeek.slice(5)),
      code,
      recipeName: patch.recipeName || existing?.recipeName || "",
      preference: patch.preference || existing?.preference || "",
      slot: {
        BENL: patch.slot?.BENL ?? existing?.slot?.BENL,
        DKSE: patch.slot?.DKSE ?? existing?.slot?.DKSE,
        DE: patch.slot?.DE ?? existing?.slot?.DE,
      },
      verdenVolume: {
        BENL: patch.verdenVolume?.BENL ?? existing?.verdenVolume?.BENL ?? 0,
        DKSE: patch.verdenVolume?.DKSE ?? existing?.verdenVolume?.DKSE ?? 0,
        DE: patch.verdenVolume?.DE ?? existing?.verdenVolume?.DE ?? 0,
      },
      totalVerdenVolume: patch.totalVerdenVolume ?? existing?.totalVerdenVolume ?? 0,
      productionBuffer: patch.productionBuffer ?? existing?.productionBuffer ?? 0,
    };

    if (!patch.totalVerdenVolume) {
      next.totalVerdenVolume =
        (next.verdenVolume.BENL || 0) +
        (next.verdenVolume.DKSE || 0) +
        (next.verdenVolume.DE || 0);
    }

    byKey.set(key, next);
    sourcePriority.set(key, priority);
    weeks.add(hfWeek);
    return !existing;
  };

  for (const spreadsheetId of getSheetIds()) {
    let titles = [];
    try {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets(properties(title))",
      });
      titles = (meta.data.sheets || [])
        .map((sheet) => sheet.properties?.title || "")
        .filter(Boolean);
    } catch {
      titles = [];
    }

    let addedFromRampUp = 0;
    const rampRanges = [
      "'PO Maitre'!A1:Z5000",
      "'[Import] Convini Order Sheet'!A1:Z5000",
      "'_Import_ Convini Order Sheet'!A1:Z5000",
      "'Input '!A1:Z5000",
    ];
    for (const range of rampRanges) {
      try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
        const rows = response.data.values || [];
        const added = parseRampUpConviniRows(rows, upsertWeekRecipe);
        addedFromRampUp += added;
        if (added > 0) break;
      } catch {
        // ignore and try next range candidate
      }
    }

    // Legacy Fallback nur wenn in diesem Sheet keine Ramp-up-Meals erkannt wurden.
    if (addedFromRampUp === 0) {
      try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: SHEET_RANGE });
        parseLegacyMealSelectionRows(response.data.values || [], upsertWeekRecipe);
      } catch {
        // ignore
      }
    }
  }

  return {
    weekRecipes: Array.from(byKey.values()),
    weeks: [...weeks].sort()
  };
}

async function clearCollection(collRef) {
  while (true) {
    const snap = await collRef.limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }
}

async function batchedSet(collRef, docs) {
  const chunkSize = 400;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const batch = db.batch();
    for (const { id, data } of docs.slice(i, i + chunkSize)) {
      batch.set(collRef.doc(id), data, { merge: true });
    }
    await batch.commit();
  }
}

exports.refreshRampUp = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }

  try {
    const metaSnap = await APP_ROOT.get();
    const meta = metaSnap.data() || {};
    const now = Date.now();
    const lastCheckedMs = meta.rampUpLastCheckedAt ? Date.parse(meta.rampUpLastCheckedAt) : 0;
    if (lastCheckedMs && Number.isFinite(lastCheckedMs) && now - lastCheckedMs < CHECK_COOLDOWN_MS) {
      res.json({ ok: true, refreshed: false, reason: "cooldown", checkedAt: meta.rampUpLastCheckedAt });
      return;
    }

    const { weekRecipes, weeks } = await readMealSelectionRows();
    const nextHash = buildWeekRecipeHash(weekRecipes);
    const checkedAt = new Date(now).toISOString();

    if (meta.rampUpHash === nextHash) {
      await APP_ROOT.set({ rampUpLastCheckedAt: checkedAt }, { merge: true });
      res.json({ ok: true, refreshed: false, count: weekRecipes.length, checkedAt });
      return;
    }

    const weekRecipesColl = APP_ROOT.collection("weekRecipes");
    await clearCollection(weekRecipesColl);
    await batchedSet(
      weekRecipesColl,
      weekRecipes.map(row => ({ id: stableWeekRecipeId(row), data: row }))
    );

    await APP_ROOT.set({
      generatedAt: checkedAt,
      weeks,
      rampUpHash: nextHash,
      rampUpLastCheckedAt: checkedAt
    }, { merge: true });

    res.json({ ok: true, refreshed: true, count: weekRecipes.length, checkedAt });
  } catch (error) {
    logger.error("refreshRampUp failed", error);
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

const OPERATIONAL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

async function getAllTabNamesGS(sheets, spreadsheetId) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title))" });
    return (meta.data.sheets ?? []).map(s => s.properties?.title ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

function findCurrentWeekTabGS(tabs, patterns, fallbackToLatest = true) {
  const now = new Date();
  const year = now.getFullYear();
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const kw = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

  for (const delta of [0, 1, -1, 2]) {
    const weekNum = kw + delta;
    for (const pattern of patterns) {
      const needle = pattern.replace("{XX}", String(weekNum).padStart(2, "0")).replace("{KW}", String(weekNum)).replace("{YEAR}", String(year));
      const found = tabs.find(t => t.toLowerCase().includes(needle.toLowerCase()));
      if (found) return found;
    }
  }
  if (fallbackToLatest) {
    // Pick the tab whose own week number is closest to the current week —
    // NOT the last matching tab in sheet order. Tabs get added out of
    // chronological order, so "last in the array" can silently pick stale
    // data (e.g. an old "W21" tab sitting after the current "W33" one).
    const candidates = tabs
      .map(t => ({ tab: t, weekNum: extractTabWeekNumGS(t) }))
      .filter(c => c.weekNum !== null);
    if (candidates.length) {
      candidates.sort((a, b) => Math.abs(a.weekNum - kw) - Math.abs(b.weekNum - kw) || b.weekNum - a.weekNum);
      return candidates[0].tab;
    }
  }
  return null;
}

function extractTabWeekNumGS(tab) {
  const m = tab.match(/(\d{4})-W(\d{2})/) ?? tab.match(/PW(\d{2})/) ?? tab.match(/W(\d{2})/);
  if (!m) return null;
  const weekStr = m.length === 3 ? m[2] : m[1];
  return parseInt(weekStr, 10);
}

async function sheetValues(sheets, spreadsheetId, tabName) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A1:Z2000` });
  return res.data.values ?? [];
}

function numVal(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function parseRecipeNameGS(full) {
  const m = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s*-\s*(.+?)(?:\s*\[(?:BNL|BENL|DE|DKSE|NORD)\])?\s*$/.exec(full);
  if (m) return { code: m[1], base: m[2].trim() };
  return { code: full, base: full };
}

async function readProductionPlanGSheet(sheets) {
  const spreadsheetId = process.env.SHEET_FERTIGSTELLUNG || "1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY";
  if (!spreadsheetId) return null;

  let tabName = process.env.SHEET_FERTIGSTELLUNG_TAB;
  if (!tabName) {
    const allTabs = await getAllTabNamesGS(sheets, spreadsheetId);
    // "Transperancy Total Overview" (sic) is the current evergreen tab —
    // no week number in its name, holds a rolling window of the current +
    // next weeks instead of one tab per week. Older week-numbered patterns
    // kept in case the sheet owner reverts to per-week tabs.
    tabName = findCurrentWeekTabGS(allTabs, [
      "Transperancy Total Overview",
      "Transparency Total Overview",
      "W{XX} Transperancy",
      "W{XX} Transparency",
      "BENL Outbound W{XX}",
    ]) || allTabs[0];
  }
  if (!tabName) return null;

  let rows;
  try { rows = await sheetValues(sheets, spreadsheetId, tabName); } catch { return null; }

  // Find header row: contains "Work Order" and "Recipe"
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i].map(c => String(c || "").trim().toLowerCase());
    if (r.some(c => c.includes("work order")) && r.some(c => c === "recipe")) {
      headerIdx = i; break;
    }
  }
  if (headerIdx < 0) return null;

  const header = rows[headerIdx].map(c => String(c || "").trim().toLowerCase());
  const runIdx     = header.findIndex(c => c === "run");
  const dayIdx     = header.findIndex(c => c.includes("kitchen day"));
  const woIdx      = header.findIndex(c => c === "work order");
  const recipeIdx  = header.findIndex(c => c === "recipe");
  const subIdx     = header.findIndex(c => c.includes("sub recipe"));
  const mealsIdx   = header.findIndex(c => c.includes("planned meals"));
  const stagingIdx = header.findIndex(c => c.includes("staging"));
  const kitchenIdx = header.findIndex(c => c.includes("kitchen") && c.includes("kg"));
  const postIdx    = header.findIndex(c => c.includes("post"));
  const yieldIdx   = header.findIndex(c => c === "yield");
  const logTgtIdx  = header.lastIndexOf("target");

  const resultRows = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const woCell = woIdx >= 0 ? String(row[woIdx] || "").trim() : "";
    // WO numbers restart low each week ("33-1", "33-2", …), not always
    // 3+ digits — match the same pattern used by scripts/read-production-plan.ts.
    if (!woCell || !/^\d{2}-\d{1,4}$/.test(woCell)) continue;

    const fullRecipe = recipeIdx >= 0 ? String(row[recipeIdx] || "").trim() : "";
    const { code: recipeCode } = parseRecipeNameGS(fullRecipe);
    const yieldPct = parseFloat(String(row[yieldIdx >= 0 ? yieldIdx : 9] || "").replace("%", "").replace(",", ".")) || 0;

    resultRows.push({
      run:            runIdx >= 0 ? (parseInt(String(row[runIdx] || ""), 10) || 0) : 0,
      kitchenDay:     dayIdx >= 0 ? String(row[dayIdx] || "").trim() : "",
      workOrder:      woCell,
      recipeCode,
      recipeName:     fullRecipe,
      subRecipe:      subIdx >= 0 ? String(row[subIdx] || "").trim() : "",
      plannedMeals:   mealsIdx >= 0 ? numVal(row[mealsIdx]) : 0,
      stagingKg:      stagingIdx >= 0 ? numVal(row[stagingIdx]) : 0,
      kitchenKg:      kitchenIdx >= 0 ? numVal(row[kitchenIdx]) : 0,
      postKg:         postIdx >= 0 ? numVal(row[postIdx]) : 0,
      yieldPct,
      logisticTarget: logTgtIdx >= 0 ? (numVal(row[logTgtIdx]) || undefined) : undefined,
    });
  }

  // Derive week from tab name ("W23 Transperancy Total Overview" → 2026-W23);
  // evergreen tabs carry no week number, so fall back to the most common WO
  // week-prefix among the parsed rows ("33-1" -> 33).
  const tabWeekMatch = /W(\d{1,2})/i.exec(tabName);
  const year = new Date().getFullYear();
  const week = tabWeekMatch
    ? `${year}-W${String(parseInt(tabWeekMatch[1], 10)).padStart(2, "0")}`
    : `${year}-W${String(dominantWoWeekGS(resultRows) ?? "??").padStart(2, "0")}`;

  logger.info("readProductionPlanGSheet", { tab: tabName, rows: resultRows.length, week });
  return { week, generatedAt: new Date().toISOString(), rows: resultRows };
}

function dominantWoWeekGS(rows) {
  const counts = new Map();
  for (const r of rows) {
    const m = /^(\d{2})-/.exec(r.workOrder);
    if (!m) continue;
    const wk = parseInt(m[1], 10);
    counts.set(wk, (counts.get(wk) ?? 0) + 1);
  }
  let best; let bestCount = 0;
  for (const [wk, count] of counts) {
    if (count > bestCount) { best = wk; bestCount = count; }
  }
  return best;
}

async function readPrintOrdersGSheet(sheets) {
  const spreadsheetId = process.env.SHEET_PRINT_ORDERS || "1fpEHBWmd_zk74wbu78unPoTV_u860smNlxTuioEdq-4";
  if (!spreadsheetId) return [];
  let tabName = process.env.SHEET_PRINT_ORDERS_TAB;
  if (!tabName) {
    const allTabs = await getAllTabNamesGS(sheets, spreadsheetId);
    tabName = findCurrentWeekTabGS(allTabs, ["Verden PW{XX}", "Verden PW{KW}"]) || allTabs[0];
  }
  if (!tabName) return [];
  let rows; try { rows = await sheetValues(sheets, spreadsheetId, tabName); } catch { return []; }
  if (!rows.length) return [];
  const h = rows[0].map(c => String(c || "").trim().toLowerCase());
  const weekIdx = h.findIndex(x => x.includes("week") || x === "kw");
  const codeIdx = h.findIndex(x => x.includes("code") || x.includes("recipe"));
  const mskuIdx = h.findIndex(x => x.includes("msku") || x === "sku");
  const qtyIdx = h.findIndex(x => x.includes("qty") || x.includes("menge") || x.includes("quantity"));
  const sleeveIdx = h.findIndex(x => x.includes("sleeve") || x.includes("typ"));
  return rows.slice(1).map(row => ({
    week: weekIdx >= 0 ? String(row[weekIdx] || "").trim() : "",
    code: String(row[codeIdx >= 0 ? codeIdx : 1] || "").trim(),
    msku: mskuIdx >= 0 ? String(row[mskuIdx] || "").trim() : "",
    qty: qtyIdx >= 0 ? numVal(row[qtyIdx]) : 0,
    sleeveType: sleeveIdx >= 0 ? String(row[sleeveIdx] || "").trim() || undefined : undefined,
  })).filter(r => r.code);
}

// Loeste ab Aug 2026 den alten "Verden-{YEAR}-W{XX}"-Tab (Priority/WO-Ready-Flags)
// ab -- der Sheet-Owner hat auf "Planning W{XX}" umgestellt: rezeptweise
// Forecast/Plan-Zahlen statt Work-Order-Flags (siehe KitchenPlanningRow in src/types.ts).
async function readKitchenPlanningGSheet(sheets) {
  const spreadsheetId = process.env.SHEET_KITCHEN_PRIORITY || "13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U";
  if (!spreadsheetId) return { week: null, rows: [] };
  let tabName = process.env.SHEET_KITCHEN_PRIORITY_TAB;
  if (!tabName) {
    const allTabs = await getAllTabNamesGS(sheets, spreadsheetId);
    tabName = findCurrentWeekTabGS(allTabs, ["Planning W{XX}", "Planning W{KW}"]);
  }
  if (!tabName) return { week: null, rows: [] };

  const tabWeekMatch = /W(\d{1,2})/i.exec(tabName);
  const week = tabWeekMatch ? `${new Date().getFullYear()}-W${String(parseInt(tabWeekMatch[1], 10)).padStart(2, "0")}` : null;

  let rows;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A1:J1000`, valueRenderOption: "UNFORMATTED_VALUE" });
    rows = res.data.values || [];
  } catch { return { week, rows: [] }; }
  if (!rows.length) return { week, rows: [] };

  // Header: Zeile mit "Recipe Code" und "Forecast"
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    const r = rows[i].map(c => String(c ?? "").trim().toLowerCase());
    if (r.some(c => c === "recipe code") && r.some(c => c === "forecast")) {
      headerIdx = i; break;
    }
  }
  if (headerIdx < 0) return { week, rows: [] };

  const header = rows[headerIdx].map(c => String(c ?? "").trim().toLowerCase());
  const codeIdx     = header.findIndex(c => c === "recipe code");
  const nameIdx     = header.findIndex(c => c === "recipe name");
  const forecastIdx = header.findIndex(c => c === "forecast");
  const planIdx     = header.findIndex(c => c === "plan total");
  const run1Idx      = header.findIndex(c => c === "1. run");
  const run2Idx      = header.findIndex(c => c === "2. run");
  const run3Idx      = header.findIndex(c => c === "3. run");
  const deltaIdx     = header.findIndex(c => c === "forecast delta");
  const toNum = v => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
  const runVal = (row, idx) => idx >= 0 ? (toNum(row[idx]) || undefined) : undefined;

  const result = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const recipeCode = codeIdx >= 0 ? String(row[codeIdx] ?? "").trim() : "";
    if (!recipeCode) continue;
    result.push({
      week,
      recipeCode,
      recipeName:    nameIdx >= 0 ? String(row[nameIdx] ?? "").trim() : "",
      forecast:      forecastIdx >= 0 ? toNum(row[forecastIdx]) : 0,
      planTotal:     planIdx >= 0 ? toNum(row[planIdx]) : 0,
      run1:          runVal(row, run1Idx),
      run2:          runVal(row, run2Idx),
      run3:          runVal(row, run3Idx),
      forecastDelta: deltaIdx >= 0 ? toNum(row[deltaIdx]) : 0,
    });
  }
  return { week, rows: result };
}

exports.refreshOperationalData = onRequest({ region: "europe-west3", timeoutSeconds: 120 }, async (req, res) => {
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method-not-allowed" }); return; }

  try {
    const metaSnap = await APP_ROOT.get();
    const meta = metaSnap.data() || {};
    const now = Date.now();
    const lastMs = meta.operationalLastCheckedAt ? Date.parse(meta.operationalLastCheckedAt) : 0;
    if (lastMs && Number.isFinite(lastMs) && now - lastMs < OPERATIONAL_COOLDOWN_MS) {
      res.json({ ok: true, refreshed: false, reason: "cooldown", checkedAt: meta.operationalLastCheckedAt });
      return;
    }

    const sheets = await createSheetsClient();
    const checkedAt = new Date(now).toISOString();

    const [productionPlan, printOrders, kitchenPlanning] = await Promise.all([
      readProductionPlanGSheet(sheets),
      readPrintOrdersGSheet(sheets),
      readKitchenPlanningGSheet(sheets),
    ]);

    const batch = db.batch();

    if (productionPlan?.week) {
      const pkgColl = APP_ROOT.collection("productionPlan");
      const pkgRef = pkgColl.doc(productionPlan.week);
      batch.set(pkgRef, productionPlan);
    }

    if (printOrders.length) {
      const poColl = APP_ROOT.collection("printOrders");
      for (const row of printOrders) {
        const id = `${row.week || "unknown"}_${row.code}_${row.msku}`.replace(/[^A-Za-z0-9_-]/g, "_");
        batch.set(poColl.doc(id), row);
      }
    }

    if (kitchenPlanning.week && kitchenPlanning.rows.length) {
      const kplColl = APP_ROOT.collection("kitchenPlanning");
      batch.set(kplColl.doc(kitchenPlanning.week), { week: kitchenPlanning.week, rows: kitchenPlanning.rows, updatedAt: checkedAt });
    }

    await APP_ROOT.set({ operationalLastCheckedAt: checkedAt }, { merge: true });
    await batch.commit();

    logger.info("refreshOperationalData OK", { productionRows: productionPlan?.rows?.length ?? 0, printOrders: printOrders.length, kitchenPlanning: kitchenPlanning.rows.length });
    res.json({ ok: true, refreshed: true, productionRows: productionPlan?.rows?.length ?? 0, printOrders: printOrders.length, kitchenPlanning: kitchenPlanning.rows.length, checkedAt });
  } catch (error) {
    logger.error("refreshOperationalData failed", error);
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

exports.agentRun = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }

  const startedAt = nowIso();
  const request = normalizeAgentRequest(req.body);
  const enrichedAttachments = await enrichAttachments(request.attachments || []);
  const auth = authorizePipelineAction(request.schema, request.actorRole, request.accessToken, "trigger");
  if (!auth.ok) {
    res.status(403).json({ ok: false, error: auth.error, runId: request.runId });
    return;
  }
  let usedFallback = false;
  let provider = request.provider;
  let model = request.schema?.model || null;

  try {
    const primaryResult = normalizeAgentResult(
      await runAgentByProvider(request, enrichedAttachments),
      request.provider,
      request.schema?.model || null
    );

    let finalResult = primaryResult;
    let comparison = null;

    if (request.executionMode === "dual-compare") {
      const secondaryRequest = {
        ...request,
        provider: request.secondaryProvider,
        schema: {
          ...request.schema,
          provider: request.secondaryProvider,
          model: request.secondaryModel || request.schema?.model || null,
        },
      };
      const secondaryResult = normalizeAgentResult(
        await runAgentByProvider(secondaryRequest, enrichedAttachments, request.secondaryProvider, request.secondaryModel || undefined),
        request.secondaryProvider,
        request.secondaryModel || request.schema?.model || null
      );
      comparison = compareAgentResults(primaryResult, secondaryResult);
      finalResult = comparison.winner;
      finalResult = {
        ...finalResult,
        comparison: {
          mode: request.executionMode,
          recommendation: comparison.recommendation,
          winner: {
            provider: comparison.winner.provider,
            model: comparison.winner.model,
            verdict: comparison.winner.verdict,
            confidence: comparison.winner.confidence,
          },
          loser: {
            provider: comparison.loser.provider,
            model: comparison.loser.model,
            verdict: comparison.loser.verdict,
            confidence: comparison.loser.confidence,
          },
          scoreboard: comparison.scoreboard,
          primary: primaryResult,
          secondary: secondaryResult,
        },
      };
    }

    provider = finalResult.provider;
    model = finalResult.model;

    const finishedAt = nowIso();
    await AGENT_PROPOSALS.doc(request.runId).set({
      proposalId: request.runId,
      status: "dry-run",
      week: request.week,
      provider,
      model,
      usedFallback,
      schema: request.schema,
      objective: request.objective,
      actorRole: request.actorRole || null,
      actorId: request.actorId || null,
      attachments: attachmentMeta(enrichedAttachments),
      result: finalResult,
      approved: false,
      applied: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAt,
      finishedAt,
    }, { merge: true });

    await storeRunTelemetry({
      runId: request.runId,
      request,
      startedAt,
      finishedAt,
      ok: true,
      usedFallback,
      provider,
      model,
      error: null,
    });
    await storeRunArtifacts({ runId: request.runId, request, enrichedAttachments });

    res.json({
      ok: true,
      runId: request.runId,
      proposalId: request.runId,
      provider,
      model,
      usedFallback,
      primaryProvider: request.provider,
      primaryModel: request.schema?.model || null,
      secondaryProvider: request.secondaryProvider,
      secondaryModel: request.secondaryModel,
      result: finalResult,
      startedAt,
      finishedAt,
    });
  } catch (error) {
    logger.error("agentRun failed", error);

    const canFallback = request.schema?.fallback?.useDeterministicPlannerOnFailure !== false;
    if (!canFallback) {
      const finishedAt = nowIso();
      await storeRunTelemetry({
        runId: request.runId,
        request,
        startedAt,
        finishedAt,
        ok: false,
        usedFallback,
        provider,
        model,
        error,
      });
      res.status(500).json({ ok: false, error: error?.message || String(error), runId: request.runId });
      return;
    }

    usedFallback = true;
    const fallbackResult = buildDeterministicFallbackResult(request, error?.message || "provider-failure");
    const finishedAt = nowIso();
    await AGENT_PROPOSALS.doc(request.runId).set({
      proposalId: request.runId,
      status: "dry-run",
      week: request.week,
      provider: fallbackResult.provider,
      model: "deterministic",
      usedFallback,
      schema: request.schema,
      objective: request.objective,
      actorRole: request.actorRole || null,
      actorId: request.actorId || null,
      attachments: attachmentMeta(enrichedAttachments),
      result: fallbackResult,
      approved: false,
      applied: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAt,
      finishedAt,
    }, { merge: true });

    await storeRunTelemetry({
      runId: request.runId,
      request,
      startedAt,
      finishedAt,
      ok: true,
      usedFallback,
      provider: fallbackResult.provider,
      model: "deterministic",
      error,
    });
    await storeRunArtifacts({ runId: request.runId, request, enrichedAttachments });

    res.json({
      ok: true,
      runId: request.runId,
      proposalId: request.runId,
      provider: fallbackResult.provider,
      model: "deterministic",
      usedFallback,
      result: fallbackResult,
      startedAt,
      finishedAt,
    });
  }
});

exports.agentApprove = onRequest({ region: "europe-west3", timeoutSeconds: 30 }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const proposalId = String(payload.proposalId || "").trim();
  const actorRole = String(payload.actorRole || "").trim();
  const actorId = String(payload.actorId || "").trim();
  const accessToken = String(payload.accessToken || "").trim();
  const comment = String(payload.comment || "").trim();

  if (!proposalId) {
    res.status(400).json({ ok: false, error: "proposalId fehlt." });
    return;
  }

  const proposalRef = AGENT_PROPOSALS.doc(proposalId);
  const proposalSnap = await proposalRef.get();
  if (!proposalSnap.exists) {
    res.status(404).json({ ok: false, error: "Proposal nicht gefunden." });
    return;
  }

  const proposal = proposalSnap.data() || {};
  const auth = authorizePipelineAction(proposal.schema || {}, actorRole, accessToken, "approve");
  if (!auth.ok) {
    res.status(403).json({ ok: false, error: auth.error, proposalId });
    return;
  }

  const approvedAt = nowIso();
  await proposalRef.set({
    status: "approved",
    approved: true,
    approvedAt,
    approvedByRole: actorRole || null,
    approvedById: actorId || null,
    approvalComment: comment || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  res.json({ ok: true, proposalId, status: "approved", approvedAt });
});

exports.agentApply = onRequest({ region: "europe-west3", timeoutSeconds: 30 }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }

  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const proposalId = String(payload.proposalId || "").trim();
  const actorRole = String(payload.actorRole || "").trim();
  const actorId = String(payload.actorId || "").trim();
  const accessToken = String(payload.accessToken || "").trim();

  if (!proposalId) {
    res.status(400).json({ ok: false, error: "proposalId fehlt." });
    return;
  }

  const proposalRef = AGENT_PROPOSALS.doc(proposalId);
  const proposalSnap = await proposalRef.get();
  if (!proposalSnap.exists) {
    res.status(404).json({ ok: false, error: "Proposal nicht gefunden." });
    return;
  }

  const proposal = proposalSnap.data() || {};
  const schema = proposal.schema || {};
  const auth = authorizePipelineAction(schema, actorRole, accessToken, "publish");
  if (!auth.ok) {
    res.status(403).json({ ok: false, error: auth.error, proposalId });
    return;
  }

  if (schema?.access?.requireApproval !== false && !proposal.approved) {
    res.status(412).json({ ok: false, error: "Proposal ist noch nicht freigegeben.", proposalId });
    return;
  }

  if (schema?.access?.requireApproval !== false) {
    const approvedAtRaw = String(proposal.approvedAt || "").trim();
    const approvedAtMs = Date.parse(approvedAtRaw);
    if (!approvedAtRaw || !Number.isFinite(approvedAtMs)) {
      res.status(412).json({ ok: false, error: "Proposal hat keinen gueltigen Freigabe-Zeitpunkt.", proposalId });
      return;
    }

    const maxAgeMinutesRaw = Number(
      schema?.access?.approvalMaxAgeMinutes
      ?? process.env.AGENT_APPROVAL_MAX_AGE_MINUTES
      ?? DEFAULT_APPROVAL_MAX_AGE_MINUTES
    );
    const maxAgeMinutes = Number.isFinite(maxAgeMinutesRaw)
      ? Math.max(1, Math.min(24 * 60, maxAgeMinutesRaw))
      : DEFAULT_APPROVAL_MAX_AGE_MINUTES;
    const maxAgeMs = maxAgeMinutes * 60 * 1000;
    const ageMs = Date.now() - approvedAtMs;

    if (ageMs > maxAgeMs) {
      res.status(412).json({
        ok: false,
        error: `Freigabe zu alt. Bitte neu freigeben (max ${maxAgeMinutes} Minuten).`,
        proposalId,
        approvedAt: approvedAtRaw,
      });
      return;
    }
  }

  const allowPlanWrite = schema?.actions?.allowPlanWrite === true;
  const allowRackWrite = schema?.actions?.allowRackWrite === true;
  if (!allowPlanWrite && !allowRackWrite) {
    res.status(400).json({ ok: false, error: "Apply blockiert: weder Plan- noch Rack-Write erlaubt.", proposalId });
    return;
  }

  const applyId = `${proposalId}__${Date.now()}`;
  const appliedAt = nowIso();
  const writes = [];

  if (allowPlanWrite) {
    await PLAN_WRITES.doc(applyId).set({
      applyId,
      proposalId,
      week: proposal.week || null,
      objective: proposal.objective || null,
      summary: proposal.result?.summary || null,
      actions: proposal.result?.actions || [],
      actorRole: actorRole || null,
      actorId: actorId || null,
      appliedAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    writes.push("plan");
  }

  if (allowRackWrite) {
    await RACK_WRITES.doc(applyId).set({
      applyId,
      proposalId,
      week: proposal.week || null,
      rackV2Rules: schema.rackV2Rules || {},
      suggestedActions: proposal.result?.actions || [],
      actorRole: actorRole || null,
      actorId: actorId || null,
      appliedAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    writes.push("rack");
  }

  await AGENT_APPLIES.doc(applyId).set({
    applyId,
    proposalId,
    writes,
    actorRole: actorRole || null,
    actorId: actorId || null,
    appliedAt,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await proposalRef.set({
    status: "applied",
    applied: true,
    applyId,
    appliedAt,
    appliedByRole: actorRole || null,
    appliedById: actorId || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  res.json({ ok: true, proposalId, applyId, writes, status: "applied", appliedAt });
});

exports.wmsPlating = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  await runWmsQuery(req, res, { name: "wms-plating", sql: WMS_PLATING_SQL, mapper: mapWmsPlatingRow });
});

exports.wmsPlatingHistory = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  await runWmsQuery(req, res, { name: "wms-plating-history", sql: WMS_PLATING_HISTORY_SQL, mapper: mapWmsSleevingRow, defaultLookbackDays: 90 });
});

exports.wmsSleeving = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  await runWmsQuery(req, res, { name: "wms-sleeving", sql: WMS_SLEEVING_SQL, mapper: mapWmsSleevingRow });
});

exports.wmsInbound = onRequest({
  region: "europe-west3",
  timeoutSeconds: 60,
  serviceAccount: "wmsinbound-sa@hellofresh-de-problem-solve.iam.gserviceaccount.com",
}, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  await runWmsQuery(req, res, { name: "wms-inbound", sql: WMS_INBOUND_SQL, mapper: mapWmsInboundRow });
});

exports.wmsStaging = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  await runWmsQuery(req, res, { name: "wms-staging", sql: WMS_STAGING_SQL, mapper: mapWmsPlatingRow });
});

exports.wmsDebox = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  await runWmsQuery(req, res, { name: "wms-debox", sql: WMS_DEBOX_SQL, mapper: mapWmsPlatingRow });
});

exports.wmsPostblast = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  await runWmsQuery(req, res, { name: "wms-postblast", sql: WMS_POSTBLAST_SQL, mapper: mapWmsPlatingRow });
});

exports.wmsPlatingHolding = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  await runWmsQuery(req, res, { name: "wms-plating-holding", sql: WMS_PLATING_HOLDING_SQL, mapper: mapWmsPlatingRow });
});

exports.wmsWorkorders = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  const params = parseWmsParams(req, {});
  try {
    try {
      const conn = await connectSnowflake();
      const { sql, binds } = buildWorkorderQueryForWeek(params.whId, params.week || params.wmsWeek, params.limit);
      const rowsRaw = await executeSnowflakeQuery(conn, sql, binds);
      return res.json({
        ok: true,
        whId: params.whId,
        week: params.week || params.wmsWeek,
        limit: params.limit,
        generatedAt: nowIso(),
        source: "snowflake-live",
        rows: rowsRaw.map(mapWmsWorkordersRow),
      });
    } catch (snowflakeErr) {
      logger.warn("WMS workorders Snowflake failed, trying Firestore cache", { error: snowflakeErr.message });
      cachedWmsConn = null;
    }

    const cacheDoc = await db.collection("wmsCache").doc("workorders").get();
    if (cacheDoc.exists) {
      const cached = cacheDoc.data();
      const requestedWeek = params.week || params.wmsWeek;
      const patterns = workorderPatternsForWeek(requestedWeek);
      const allCachedRows = cached.rows || [];
      const filteredRows = allCachedRows.filter(row => {
        const woNum = String(row.woNumber || "");
        return patterns.some(p => p.endsWith("%") ? woNum.startsWith(p.slice(0, -1)) : woNum === p);
      });
      logger.info("WMS workorders Firestore fallback", { requestedWeek, patterns, total: allCachedRows.length, filtered: filteredRows.length });
      return res.json({
        ok: true,
        whId: params.whId,
        week: requestedWeek,
        limit: params.limit,
        generatedAt: nowIso(),
        source: "firestore-cache",
        cachedAt: cached.pushedAt || cached.generatedAt,
        rows: filteredRows,
      });
    }

    throw new Error("Keine Workorders-Daten. Bitte 'npm run wms-sync' ausführen.");
  } catch (error) {
    logger.error("WMS workorders failed", { error: error?.message });
    res.status(500).json({ ok: false, whId: params.whId, week: params.week || params.wmsWeek, limit: params.limit, generatedAt: nowIso(), rows: [], error: error?.message || String(error) });
  }
});

exports.refreshWmsCache = onSchedule("every 60 minutes", async () => {
  try {
    const conn = await connectSnowflake();
    const dbRef = admin.firestore();
    const today = localDateIso();
    const lookback = 60;
    const rangeStart = shiftedIsoDate(today, -lookback);
    const rangeEnd = shiftedIsoDate(today, 1);
    const baseWeek = hfWeekFromIso(isoWeekLabel(new Date()));

    const allJobs = [
      { cacheKey: "wms-plating-latest", sql: WMS_PLATING_SQL, binds: ["VF", rangeStart, rangeEnd, 25000], mapper: mapWmsPlatingRow },
      { cacheKey: "wms-sleeving-latest", sql: WMS_SLEEVING_SQL, binds: ["VF", rangeStart, rangeEnd, 25000], mapper: mapWmsSleevingRow },
      { cacheKey: "wms-inbound-latest", sql: WMS_INBOUND_SQL, binds: ["VF", rangeStart, rangeEnd, 25000], mapper: mapWmsInboundRow },
      { cacheKey: "wms-staging-latest", sql: WMS_STAGING_SQL, binds: ["VF", rangeStart, rangeEnd, 25000], mapper: mapWmsPlatingRow },
      { cacheKey: "wms-debox-latest", sql: WMS_DEBOX_SQL, binds: ["VF", rangeStart, rangeEnd, 25000], mapper: mapWmsPlatingRow },
      { cacheKey: "wms-postblast-latest", sql: WMS_POSTBLAST_SQL, binds: ["VF", rangeStart, rangeEnd, 25000], mapper: mapWmsPlatingRow },
    ];

    const workorders = buildWorkorderQueryForWeek("VF", baseWeek, 25000);
    const workordersRows = (await executeSnowflakeQuery(conn, workorders.sql, workorders.binds)).map(mapWmsWorkordersRow);
    await dbRef.collection("wmsCache").doc("workorders").set({ rows: workordersRows, generatedAt: nowIso(), pushedAt: nowIso(), whId: "VF" });

    for (const job of allJobs) {
      const rawRows = await executeSnowflakeQuery(conn, job.sql, job.binds);
      await dbRef.collection("wmsCache").doc(job.cacheKey).set({ rows: rawRows.map(job.mapper), generatedAt: nowIso(), pushedAt: nowIso(), whId: "VF" });
    }

    logger.info("WMS cache refresh completed");
  } catch (error) {
    logger.error("WMS cache refresh failed", { error: error?.message || String(error) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WMS WO-DETAIL — Alle Transaktionen einer Work Order aus T_TRAN_LOG
// ═══════════════════════════════════════════════════════════════════════════════

const WMS_WO_DETAIL_SQL = `
SELECT
    CONTROL_NUMBER AS WO_NUMBER,
    TRAN_TYPE,
    DESCRIPTION,
    ITEM_NUMBER,
    TRAN_QTY,
    LOT_NUMBER,
    LOCATION_ID,
    LOCATION_ID_2,
    HU_ID,
    START_TRAN_DATE,
    END_TRAN_DATE,
    EMPLOYEE_ID
FROM US_OPS_ANALYTICS.HIGHJUMP.T_TRAN_LOG
WHERE WH_ID = ?
  AND CONTROL_NUMBER LIKE ?
  AND START_TRAN_DATE >= TO_TIMESTAMP_NTZ(?)
  AND START_TRAN_DATE < TO_TIMESTAMP_NTZ(?)
ORDER BY CONTROL_NUMBER, START_TRAN_DATE
LIMIT ?`;

function mapWmsWoDetailRow(row) {
  return {
    woNumber: String(row.WO_NUMBER ?? ""),
    tranType: String(row.TRAN_TYPE ?? ""),
    description: String(row.DESCRIPTION ?? ""),
    itemNumber: String(row.ITEM_NUMBER ?? ""),
    tranQty: row.TRAN_QTY != null ? Number(row.TRAN_QTY) : null,
    lotNumber: String(row.LOT_NUMBER ?? ""),
    locationId: String(row.LOCATION_ID ?? ""),
    locationId2: String(row.LOCATION_ID_2 ?? ""),
    huId: String(row.HU_ID ?? ""),
    startTranDate: row.START_TRAN_DATE ? String(row.START_TRAN_DATE) : null,
    endTranDate: row.END_TRAN_DATE ? String(row.END_TRAN_DATE) : null,
    employeeId: String(row.EMPLOYEE_ID ?? ""),
  };
}

function mapCachedWorkorderRowToWoDetailRow(row) {
  const qty = Number(row.preBlastQuantity ?? row.quantity ?? row.plates ?? 0);
  const safeQty = Number.isFinite(qty) ? qty : 0;
  return {
    woNumber: String(row.woNumber ?? ""),
    tranType: "651",
    description: `CACHE ${String(row.submealItemDescription ?? row.mealItemDescription ?? "").trim()}`,
    itemNumber: String(row.submealItemNumber ?? row.mealItemNumber ?? ""),
    tranQty: safeQty,
    lotNumber: String(row.mealItemNumber ?? row.submealItemNumber ?? ""),
    locationId: String(row.preBlastLocation ?? "CACHE"),
    locationId2: String(row.mealItemNumber ?? "KITCHENWIP"),
    huId: "",
    startTranDate: row.productionTime || row.lastUpdated || null,
    endTranDate: row.lastUpdated || row.productionTime || null,
    employeeId: "",
  };
}

exports.wmsWoDetail = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  const params = parseWmsParams(req, {});
  const woFilter = String(req.query.wo ?? "").trim();
  try {
    const conn = await connectSnowflake();
    const hfWeek = params.week || hfWeekFromIso(isoWeekLabel(new Date()));
    const kwMatch = hfWeek.match(/^\d{4}-W(\d{2})$/);
    const kwNum = kwMatch ? String(Number(kwMatch[1])) : "";
    const controlPattern = woFilter || `${kwNum}-%`;
    const range = wmsRangeForToolWeek(hfWeek);
    const rowsRaw = await executeSnowflakeQuery(conn, WMS_WO_DETAIL_SQL, [
      params.whId,
      controlPattern,
      range.rangeStart,
      range.rangeEnd,
      params.limit,
    ]);
    return res.json({
      ok: true,
      whId: params.whId,
      week: hfWeek,
      wmsWeek: range.wmsWeek,
      controlPattern,
      rangeStart: range.rangeStart,
      rangeEnd: range.rangeEnd,
      limit: params.limit,
      generatedAt: nowIso(),
      source: "snowflake-live",
      rows: rowsRaw.map(mapWmsWoDetailRow),
    });
  } catch (error) {
    logger.warn("WMS wo-detail Snowflake failed, trying Firestore cache", { error: error?.message });
    try {
      const cacheDoc = await db.collection("wmsCache").doc("workorders").get();
      if (cacheDoc.exists) {
        const cached = cacheDoc.data() || {};
        const cachedRows = Array.isArray(cached.rows) ? cached.rows : [];
        const rows = cachedRows.map(mapCachedWorkorderRowToWoDetailRow).slice(0, params.limit);
        return res.json({
          ok: true,
          whId: params.whId,
          week: params.week,
          wmsWeek: params.week,
          controlPattern: woFilter || null,
          rangeStart: params.rangeStart,
          rangeEnd: params.rangeEnd,
          limit: params.limit,
          generatedAt: nowIso(),
          source: "firestore-cache-derived",
          cachedAt: cached.pushedAt || cached.generatedAt,
          rows,
        });
      }
    } catch (cacheError) {
      logger.warn("WMS wo-detail cache fallback failed", { error: cacheError?.message });
    }
    res.status(500).json({ ok: false, whId: params.whId, limit: params.limit, generatedAt: nowIso(), rows: [], error: error?.message || String(error) });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WMS BREAKDOWN — Aggregierter Equipment-Breakdown pro Work Order (aktuelle KW)
// ═══════════════════════════════════════════════════════════════════════════════

const WMS_BREAKDOWN_SQL = `
SELECT
    "wo_number",
    "week",
    "submeal_item_number",
    "submeal_item_desctiption",
    "meal_item_number",
    "meal_item_descrption",
    SUM("quantity") AS total_qty,
    MAX("uom") AS primary_uom,
    SUM("pre_blast_quantity") AS total_pre_blast,
    MAX("preblast_location") AS preblast_location,
    MAX("status") AS status,
    MIN("production_time") AS earliest_production,
    MAX("production_time") AS latest_production,
    MAX("last_updated") AS last_updated,
    MAX("plates") AS plates,
    MAX("target_per_plate") AS target_per_plate,
    COUNT(*) AS row_count
FROM US_OPS_ANALYTICS.HIGHJUMP_ANALYTICS.V_SUBMEAL_PRODUCTION
WHERE "wh_id" = ?
  AND "week" IN (?, ?, ?, ?)
GROUP BY "wo_number", "week", "submeal_item_number", "submeal_item_desctiption", "meal_item_number", "meal_item_descrption", "uom"
ORDER BY "wo_number", "submeal_item_number"`;

function breakdownNorm(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function breakdownOverlapScore(a, b) {
  const aTokens = new Set(breakdownNorm(a).split(" ").filter(t => t.length > 1));
  const bTokens = new Set(breakdownNorm(b).split(" ").filter(t => t.length > 1));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of aTokens) { if (bTokens.has(t)) overlap++; }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function breakdownMatchProcessSpec(submealId, submealName, processSpecs) {
  if (!processSpecs || Object.keys(processSpecs).length === 0) return null;
  // Direct ID match
  if (processSpecs[submealId]) return processSpecs[submealId];
  // Fuzzy name match
  const needle = breakdownNorm(submealName);
  if (!needle) return null;
  let best = null;
  let bestScore = 0;
  for (const spec of Object.values(processSpecs)) {
    if (!spec || !spec.name) continue;
    const score = breakdownOverlapScore(needle, spec.name);
    if (score > bestScore) { bestScore = score; best = spec; }
  }
  return bestScore >= 0.5 ? best : null;
}

function breakdownMatchEquipBible(submealName, equipmentBible) {
  if (!equipmentBible || equipmentBible.length === 0) return null;
  const needle = breakdownNorm(submealName);
  if (!needle) return null;
  let best = null;
  let bestScore = 0;
  for (const entry of equipmentBible) {
    if (!entry || !entry.itemName) continue;
    const score = breakdownOverlapScore(needle, entry.itemName);
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  return bestScore >= 0.4 ? best : null;
}

// ─── Rack Planning: Boxfiles automatisch aus Google Drive laden ──────────────
const BOXFILE_DRIVE_ROOT = "1eCsBqOA6dwfxG3KWAhOpLYnGJpYRLX0G";

async function driveNavigatePath(drive, rootId, ...folderNames) {
  let currentId = rootId;
  for (const name of folderNames) {
    const res = await drive.files.list({
      q: `'${currentId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
    });
    const id = res.data.files?.[0]?.id;
    if (!id) throw new Error(`Drive-Ordner nicht gefunden: ${name}`);
    currentId = id;
  }
  return currentId;
}

async function driveReadFile(drive, folderId, filename) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and name = '${filename}' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });
  const fileId = res.data.files?.[0]?.id;
  if (!fileId) return null;
  const content = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
  return typeof content.data === "string" ? content.data : null;
}

exports.rackBoxfiles = onRequest({ region: "europe-west3", timeoutSeconds: 60, cors: true }, async (req, res) => {
  if (req.method !== "GET") { res.status(405).json({ ok: false, error: "method-not-allowed" }); return; }
  const week = String(req.query.week || "").trim(); // z.B. "2026-W34"
  if (!week) { res.status(400).json({ ok: false, error: "week param required (z.B. 2026-W34)" }); return; }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SA_JSON || "{}"),
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth });
    // Navigiere: Root → ETL_OR → ETL_OR_FACTOR → {week} → BOXFILE_VE
    const boxfileVeId = await driveNavigatePath(drive, BOXFILE_DRIVE_ROOT, "ETL_OR", "ETL_OR_FACTOR", week, "BOXFILE_VE");
    const [deCsv, nordicsCsv] = await Promise.all([
      driveReadFile(drive, boxfileVeId, "VE-TZ.csv"),
      driveReadFile(drive, boxfileVeId, "VE-TK-TV.csv"),
    ]);
    res.json({ ok: true, week, de: deCsv, nordics: nordicsCsv });
  } catch (err) {
    logger.error("rackBoxfiles error", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ─── Rack Planning: Inputs aus ALPS-Rackfile-GSheet lesen ───────────────────
const RACK_ALPS_GSHEET_ID = process.env.SHEET_RACK_ALPS || "1ZduHX41wLhZ3xdKQQjoqW22RpjpGNj_OFRr6iUTFdNI";
const RACK_ALPS_UPLOAD_TAB = process.env.SHEET_RACK_ALPS_UPLOAD_TAB || "RackfileUPLOAD";
const RACK_ALPS_CONTROL_TAB = process.env.SHEET_RACK_ALPS_CONTROL_TAB || "Control Panel";

const RACK_LINES_BY_MARKET = {
  DE: new Set(["ASL3", "ASL4"]),
  DKSE: new Set(["ASL1", "ASL5"]),
  BENL: new Set(["ASL2", "ASL6"]),
};

function rackMarketFromLine(line) {
  const normalized = String(line || "").trim().toUpperCase();
  if (RACK_LINES_BY_MARKET.DE.has(normalized)) return "DE";
  if (RACK_LINES_BY_MARKET.DKSE.has(normalized)) return "DKSE";
  if (RACK_LINES_BY_MARKET.BENL.has(normalized)) return "BENL";
  return "UNKNOWN";
}

function rackDataMarketFromLine(line) {
  return rackMarketFromLine(line) === "DE" ? "de" : "nordics";
}

function rackFindHeaderIdx(header, names) {
  return header.findIndex((h) => names.includes(h));
}

function rackToInt(v, fallback = 0) {
  if (v == null || v === "") return fallback;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function rackSortFromFlow(flowRackPosition) {
  const m = /^F(\d+)$/i.exec(String(flowRackPosition || "").trim());
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

exports.rackInputs = onRequest({ region: "europe-west3", timeoutSeconds: 45, cors: true }, async (req, res) => {
  if (req.method !== "GET") { res.status(405).json({ ok: false, error: "method-not-allowed" }); return; }

  const weekParam = String(req.query.week || "").trim();
  const marketParam = String(req.query.market || "ALL").trim().toUpperCase(); // ALL|DE|DKSE|BENL|NORDICS

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SA_JSON || "{}"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    const [uploadResp, controlResp] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId: RACK_ALPS_GSHEET_ID,
        range: `'${RACK_ALPS_UPLOAD_TAB}'!A1:N6000`,
        valueRenderOption: "UNFORMATTED_VALUE",
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId: RACK_ALPS_GSHEET_ID,
        range: `'${RACK_ALPS_CONTROL_TAB}'!A1:F20`,
      }).catch(() => ({ data: { values: [] } })),
    ]);

    const rows = uploadResp.data.values ?? [];
    if (!rows.length) {
      res.json({ ok: true, week: weekParam || null, market: marketParam, entries: [], pool: { de: [], nordics: [] } });
      return;
    }

    const header = rows[0].map((c) => String(c ?? "").trim().toLowerCase());
    const recipeIdx = rackFindHeaderIdx(header, ["recipe"]);
    const lineIdx = rackFindHeaderIdx(header, ["line"]);
    const flowIdx = rackFindHeaderIdx(header, ["flowrackposition", "flow rack position"]);
    const qtyIdx = rackFindHeaderIdx(header, ["quantity", "qty"]);
    const skuIdx = rackFindHeaderIdx(header, ["sku"]);
    const ingredientIdx = rackFindHeaderIdx(header, ["ingredient", "artikel"]);
    const scanIdx = rackFindHeaderIdx(header, ["scanregex", "scan regex"]);
    const labelPosIdx = rackFindHeaderIdx(header, ["labelpos", "label pos"]);
    const uniCodeIdx = rackFindHeaderIdx(header, ["unicode", "uni code"]);
    const displayNameIdx = rackFindHeaderIdx(header, ["displayname", "display name"]);
    const gramageIdx = rackFindHeaderIdx(header, ["gramage"]);
    const sortIdx = rackFindHeaderIdx(header, ["sort"]);
    const portionSizeIdx = rackFindHeaderIdx(header, ["portionsize", "portion size"]);

    const parsed = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const recipe = String(row[recipeIdx] ?? "").trim();
      const line = String(row[lineIdx] ?? "").trim().toUpperCase();
      const flowRackPosition = String(row[flowIdx] ?? "").trim().toUpperCase();
      if (!recipe || !line || !/^ASL[1-6]$/.test(line) || !/^F\d{2,3}$/.test(flowRackPosition)) continue;

      const ingredient = String(row[ingredientIdx] ?? "").trim();
      const labelPos = String(row[labelPosIdx] ?? "").trim() || `${line}${flowRackPosition}`;
      const portion = recipe.includes("_") ? recipe.split("_", 2)[1] : "";
      const uniCode = String(row[uniCodeIdx] ?? "").trim() || `${labelPos}${portion}`;
      const parsedEntry = {
        recipe,
        line,
        flowRackPosition,
        quantity: rackToInt(row[qtyIdx], 1) || 1,
        sku: String(row[skuIdx] ?? "").trim(),
        ingredient,
        scanRegEx: String(row[scanIdx] ?? "").trim(),
        labelPos,
        uniCode,
        displayName: String(row[displayNameIdx] ?? "").trim() || ingredient,
        gramage: String(row[gramageIdx] ?? "").trim(),
        sort: rackToInt(row[sortIdx], rackSortFromFlow(flowRackPosition)),
        portionSize: String(row[portionSizeIdx] ?? "").trim() || undefined,
        market: rackMarketFromLine(line),
        dataMarket: rackDataMarketFromLine(line),
      };
      parsed.push(parsedEntry);
    }

    const entries = parsed.filter((entry) => {
      if (marketParam === "ALL") return true;
      if (marketParam === "NORDICS") return entry.market === "DKSE" || entry.market === "BENL";
      return entry.market === marketParam;
    });

    const pool = {
      de: entries.filter((entry) => entry.dataMarket === "de"),
      nordics: entries.filter((entry) => entry.dataMarket === "nordics"),
    };

    let detectedWeek = weekParam || null;
    const controlRows = controlResp?.data?.values ?? [];
    if (!detectedWeek) {
      for (const row of controlRows) {
        for (const cell of row) {
          const value = String(cell ?? "").trim();
          if (/^20\d{2}-W\d{2}$/i.test(value)) {
            detectedWeek = value.toUpperCase();
            break;
          }
        }
        if (detectedWeek) break;
      }
    }

    res.json({
      ok: true,
      spreadsheetId: RACK_ALPS_GSHEET_ID,
      uploadTab: RACK_ALPS_UPLOAD_TAB,
      week: detectedWeek,
      market: marketParam,
      count: entries.length,
      entries,
      pool,
    });
  } catch (err) {
    logger.error("rackInputs error", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

const BREAKDOWN_STATIONS = [
  "Staging", "Spice Portioning", "Debox", "Thaw", "Brine", "Marinade",
  "Hand Marinade", "Immersion Blender", "Planetary Mixer", "Horizontal Mixer",
  "Patty Maker", "Braiser", "Grill", "Crusted", "Oven", "Drain",
  "Hand Mix", "Cold Shredder", "Hot Shredder", "Scooper", "Butter Machine",
  "Slicer", "Cupping", "Blast Chiller"
];

// Bekannte Protein-Items mit Stückgewicht und Tray-Kapazität
const BREAKDOWN_PTN_SPECS = {
  "PTN-00-139317-3": { pcsPerTray: 30, pieceKg: 0.160, label: "Chicken Breast B/S 160g" },
  "PTN-00-139968-1": { pcsPerTray: 28, pieceKg: 0.140, label: "Salmon Skinless Boneless 140g" },
};

function breakdownPieceWeightKg(submealId, submealName) {
  // Direct ID match
  if (BREAKDOWN_PTN_SPECS[submealId]) return BREAKDOWN_PTN_SPECS[submealId].pieceKg;
  // Try to extract weight from name (e.g. "Chicken Breast – 160g")
  const m = String(submealName || "").match(/\b(\d+(?:[.,]\d+)?)\s*(g|kg)\b/i);
  if (m) {
    const val = parseFloat(m[1].replace(",", "."));
    if (Number.isFinite(val) && val > 0) return m[2].toLowerCase() === "kg" ? val : val / 1000;
  }
  return null;
}

function breakdownPcsPerTray(submealId) {
  if (BREAKDOWN_PTN_SPECS[submealId]) return BREAKDOWN_PTN_SPECS[submealId].pcsPerTray;
  return null;
}

function breakdownCalcSubmeal(row, processSpecs, equipmentBible) {
  const submealId = row.submeal_item_number || "";
  const submealName = row.submeal_item_desctiption || "";
  const primaryUom = String(row.primary_uom || "G").toUpperCase();
  const totalQty = num(row.total_qty);

  // Determine whether this is a piece-count or weight-based entry
  const isEach = ["EA", "EACH", "PCS", "LBS"].includes(primaryUom);

  let totalKg = null;
  let totalPieces = null;
  let estimatedKgFromPieces = null;
  let pcsPerTray = null;
  let traysNeeded = null;

  if (isEach) {
    // Stückzahl-basiert
    totalPieces = totalQty;
    const pieceKg = breakdownPieceWeightKg(submealId, submealName);
    if (pieceKg) {
      estimatedKgFromPieces = totalPieces * pieceKg;
      totalKg = estimatedKgFromPieces;
    }
    pcsPerTray = breakdownPcsPerTray(submealId);
    if (pcsPerTray && totalPieces > 0) {
      traysNeeded = Math.max(1, Math.ceil(totalPieces / pcsPerTray));
    }
  } else {
    // Gewichts-basiert
    if (primaryUom === "KG") totalKg = totalQty;
    else totalKg = totalQty / 1000; // G, GRAMS, GRAM, default
  }

  const spec = breakdownMatchProcessSpec(submealId, submealName, processSpecs);
  const equipMatch = breakdownMatchEquipBible(submealName, equipmentBible);

  const batchSizeKg = spec?.batchSizeKg && spec.batchSizeKg > 0 ? spec.batchSizeKg : null;
  const batches = (batchSizeKg && totalKg && totalKg > 0)
    ? Math.max(1, Math.ceil(totalKg / batchSizeKg))
    : (totalKg && totalKg > 0 ? 1 : 0);

  // Station breakdown
  const stations = {};
  let totalActiveMin = 0;
  if (spec && spec.minutesPerBatch) {
    for (const station of BREAKDOWN_STATIONS) {
      const mpb = spec.minutesPerBatch[station];
      if (mpb && mpb > 0 && batches > 0) {
        const minutes = mpb * batches;
        const holdMin = (spec.holdTimeMin && spec.holdTimeMin[station]) || 0;
        stations[station] = { minutesPerBatch: mpb, batches, totalMin: minutes, holdMin };
        totalActiveMin += minutes;
      }
    }
  }

  // Equipment Bible capacity
  const equipmentMaxKg = equipMatch ? equipMatch.maxKg : null;
  const equipmentSource = equipMatch ? equipMatch.source : null;
  const equipmentItem = equipMatch ? equipMatch.itemName : null;
  const wannenCount = (equipmentMaxKg && totalKg && totalKg > 0)
    ? Math.max(1, Math.ceil(totalKg / equipmentMaxKg))
    : null;

  return {
    submealItemNumber: submealId,
    submealName,
    totalKg: totalKg != null ? Math.round(totalKg * 100) / 100 : null,
    totalPieces,
    estimatedKgFromPieces: estimatedKgFromPieces != null ? Math.round(estimatedKgFromPieces * 100) / 100 : null,
    pcsPerTray,
    traysNeeded,
    totalQtyRaw: totalQty,
    primaryUom,
    isEach,
    batchSizeKg,
    batches,
    equipmentMaxKg,
    equipmentSource,
    equipmentItem,
    wannenCount,
    stations,
    totalActiveMin: Math.round(totalActiveMin * 10) / 10,
    preblastLocation: row.preblast_location || null,
    preBlastQuantity: num(row.total_pre_blast),
    status: row.status || null,
    earliestProduction: row.earliest_production || null,
    latestProduction: row.latest_production || null,
    plates: num(row.plates),
    targetPerPlate: num(row.target_per_plate),
    processSpecMatch: spec ? { id: spec.subRecipeId, name: spec.name, primaryStation: spec.primaryStation || null } : null,
  };
}

exports.wmsBreakdown = onRequest({ region: "europe-west3", timeoutSeconds: 120, cors: true }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }

  const whId = str(req.query.whId || "VF") || "VF";
  const weekParam = str(req.query.week || "");

  try {
    // 1. Load Firestore data in parallel
    const [psSnap, ebDoc] = await Promise.all([
      APP_ROOT.collection("processSpecs").get(),
      APP_ROOT.collection("equipmentBible").doc("current").get(),
    ]);

    const processSpecs = {};
    psSnap.forEach(d => { const data = d.data(); if (data) processSpecs[d.id] = data; });

    let equipmentBible = [];
    if (ebDoc.exists) {
      const ebData = ebDoc.data();
      const rowsRaw = Array.isArray(ebData?.rows) ? ebData.rows : [];
      equipmentBible = rowsRaw.filter(r =>
        !!r &&
        (r.source === "BRAISER" || r.source === "MIDDLE_KITCHEN" || r.source === "VEGGIE_DEBOX") &&
        typeof r.itemName === "string" &&
        typeof r.maxKg === "number" && Number.isFinite(r.maxKg) && r.maxKg > 0
      );
    }

    // 2. Fetch WOs from Snowflake
    let weekWindow;
    if (weekParam) {
      const m = weekParam.match(/^(20\d{2})-W(\d{2})$/);
      if (m) {
        const code = `${m[1]}${m[2]}`;
        weekWindow = [code, code, code, code];
      } else {
        weekWindow = currentWorkorderWeekWindow();
      }
    } else {
      weekWindow = currentWorkorderWeekWindow();
    }

    const conn = await connectSnowflake();
    const rowsRaw = await executeSnowflakeQuery(conn, WMS_BREAKDOWN_SQL, [whId, ...weekWindow]);

    // 3. Deduplicate: prefer G/KG rows over EA for same WO+submeal_item_number
    //    (Snowflake returns separate rows per UOM and sometimes truncated descriptions)
    const deduped = new Map();
    for (const row of rowsRaw) {
      const key = `${str(row.wo_number)}::${str(row.submeal_item_number)}`;
      const uom = String(row.primary_uom || "").toUpperCase();
      const isWeight = ["G", "GRAMS", "GRAM", "KG"].includes(uom);
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, row);
      } else {
        const existingUom = String(existing.primary_uom || "").toUpperCase();
        const existingIsWeight = ["G", "GRAMS", "GRAM", "KG"].includes(existingUom);
        if (isWeight && !existingIsWeight) {
          // Weight row preferred over EA row
          deduped.set(key, row);
        } else if (isWeight && existingIsWeight) {
          // Same UOM type: merge quantities (sum up)
          existing.total_qty = num(existing.total_qty) + num(row.total_qty);
          existing.total_pre_blast = num(existing.total_pre_blast) + num(row.total_pre_blast);
          existing.row_count = num(existing.row_count) + num(row.row_count);
          // Keep longer description
          if (String(row.submeal_item_desctiption || "").length > String(existing.submeal_item_desctiption || "").length) {
            existing.submeal_item_desctiption = row.submeal_item_desctiption;
          }
        } else if (!isWeight && !existingIsWeight) {
          // Both EA: merge piece counts
          existing.total_qty = num(existing.total_qty) + num(row.total_qty);
          existing.total_pre_blast = num(existing.total_pre_blast) + num(row.total_pre_blast);
          existing.row_count = num(existing.row_count) + num(row.row_count);
        }
      }
    }

    // 4. Group by WO number and calculate breakdown
    const woMap = new Map();
    for (const row of deduped.values()) {
      const woNum = str(row.wo_number);
      if (!woNum) continue;
      if (!woMap.has(woNum)) {
        woMap.set(woNum, {
          woNumber: woNum,
          week: str(row.week),
          mealItemNumber: str(row.meal_item_number),
          mealName: str(row.meal_item_descrption),
          subMeals: [],
          totalKg: 0,
          totalPieces: 0,
          totalActiveMin: 0,
        });
      }
      const wo = woMap.get(woNum);
      const subBreakdown = breakdownCalcSubmeal(row, processSpecs, equipmentBible);
      wo.subMeals.push(subBreakdown);
      wo.totalKg += subBreakdown.totalKg || 0;
      wo.totalPieces += subBreakdown.totalPieces || 0;
      wo.totalActiveMin += subBreakdown.totalActiveMin;
    }

    const workOrders = Array.from(woMap.values()).map(wo => ({
      ...wo,
      totalKg: Math.round(wo.totalKg * 100) / 100,
      totalPieces: wo.totalPieces || null,
      totalActiveMin: Math.round(wo.totalActiveMin * 10) / 10,
    }));

    // 5. Station summary across all WOs
    const stationSummary = {};
    for (const wo of workOrders) {
      for (const sub of wo.subMeals) {
        for (const [station, info] of Object.entries(sub.stations)) {
          if (!stationSummary[station]) stationSummary[station] = { totalMin: 0, totalBatches: 0, woCount: 0 };
          stationSummary[station].totalMin += info.totalMin;
          stationSummary[station].totalBatches += info.batches;
          stationSummary[station].woCount += 1;
        }
      }
    }

    // Round station summary
    for (const s of Object.values(stationSummary)) {
      s.totalMin = Math.round(s.totalMin * 10) / 10;
    }

    res.json({
      ok: true,
      whId,
      week: weekWindow[1] || weekWindow[0],
      weekWindow,
      generatedAt: nowIso(),
      source: "snowflake-live",
      workOrderCount: workOrders.length,
      workOrders,
      stationSummary,
      equipmentBibleEntries: equipmentBible.length,
      processSpecCount: Object.keys(processSpecs).length,
    });
  } catch (error) {
    logger.error("WMS breakdown failed", { error: error?.message });
    res.status(500).json({
      ok: false,
      whId,
      generatedAt: nowIso(),
      workOrders: [],
      stationSummary: {},
      error: error?.message || String(error),
    });
  }
});

// ─── Redzone Live Plating Status (Factor Verden) ─────────────────────────────

const REDZONE_STATUS_SQL = `
SELECT "areaName", "locationName", "productTypeName", "productTypeSKU",
       "outCount", "inCount", "startTime", "endTime", "runName"
FROM "REDZONE_AWS_EUWEST1_HELLOFRESH_EXTERNAL_SHARE"."hellofresh-org"."v_shiftrunsegment"
WHERE "enterpriseUUID" IN (
  SELECT "enterpriseUUID"
  FROM "REDZONE_AWS_EUWEST1_HELLOFRESH_EXTERNAL_SHARE"."hellofresh-org"."v_enterprise"
  WHERE "enterpriseName" = 'Factor Verden'
)
AND "areaName" IN ('Plating', 'Ovens', 'Braisers')
AND "productTypeName" IS NOT NULL
AND "productTypeName" != 'None'
AND "startTime" >= DATEADD(hour, ?, CURRENT_TIMESTAMP())
ORDER BY "startTime" DESC
LIMIT 500`;

exports.redzoneStatus = onRequest({ region: "europe-west3", timeoutSeconds: 60, cors: true }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }

  const hoursParam = parseInt(req.query.hours || "24", 10);
  const hours = Number.isFinite(hoursParam) ? Math.min(168, Math.max(1, hoursParam)) : 24;

  try {
    const conn = await connectSnowflake();
    const rowsRaw = await executeSnowflakeQuery(conn, REDZONE_STATUS_SQL, [-hours]);
    const rows = rowsRaw.map(row => ({
      areaName: String(row.areaName || ""),
      locationName: String(row.locationName || ""),
      productTypeName: String(row.productTypeName || ""),
      productTypeSKU: String(row.productTypeSKU || ""),
      outCount: row.outCount != null ? Number(row.outCount) : null,
      inCount: row.inCount != null ? Number(row.inCount) : null,
      startTime: row.startTime instanceof Date ? row.startTime.toISOString() : row.startTime ? String(row.startTime) : null,
      endTime: row.endTime instanceof Date ? row.endTime.toISOString() : row.endTime ? String(row.endTime) : null,
      runName: String(row.runName || ""),
    }));
    res.json({
      ok: true,
      enterprise: "Factor Verden",
      lookbackHours: hours,
      generatedAt: nowIso(),
      rows,
    });
  } catch (error) {
    cachedWmsConn = null;
    logger.error("Redzone status failed", { error: error?.message });
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

// ─── Gemini WO-Instruction Bot ───────────────────────────────────────────────

async function generateGeminiInstructionCloud(context) {
  const apiKey = GEMINI_API_KEY_SECRET.value();
  if (!apiKey) throw new Error("Firebase Secret GEMINI_API_KEY nicht gesetzt");
  const model = "gemini-2.5-flash";
  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: `Production instruction bot — Factor Verden kitchen.
Generate clear, bilingual cooking instructions (EN + DE) for kitchen staff who can
cook but are not trained chefs — no professional shorthand or jargon, spell out
what to actually do and how to tell each step is done.

FORMAT: EVERY cook method from processFlow gets its own paragraph, each starting
on a NEW LINE (real newline character, not just a space) with a sequential letter
— "A. STATION:", then "B. STATION:", "C. STATION:", … in processFlow order. Never
run two stations together on one line. After each label, write 3-5 full, clear
sentences describing the action and a concrete visual/texture/consistency cue for
when the step is finished.
Station names: SPICE PORTIONING→"SPICE ROOM"/"GEWÜRZRAUM" | VEGGIE DEBOX→"VEGGIE DEBOX"/"GEMÜSE-DEBOX" | PROTEIN DEBOX→"PROTEIN DEBOX"/"PROTEINDEBOX" | BRAISER→"BRAISER" | OVEN→"OFEN" | GRILL→"GRILL" | HORIZONTAL MIXER→"HORIZONTAL MIXER"/"HORIZONTALMISCHER" | PLANETARY MIXER→"PLANETARY MIXER"/"PLANETENMISCHER" | PATTY MAKER→"PATTY MAKER"/"PATTY-PRESSE" | HAND MIX→"HAND MIX"/"HANDMISCHUNG" | MARINADE→"MARINADE" | HAND MARINADE→"HANDMARINADE" | IMMERSION BLENDER→"STABMIXER" | DRAIN→"DRAIN"/"ABTROPFEN" | BLAST CHILLER→"BLAST CHILLER"/"SCHNELLKÜHLER"

ABSOLUTE RULES:
- NEVER mention kg, g, grams, kilograms, weights, or quantities of ANY kind
- NEVER list ingredients — the PDF already has an ingredient table
- NEVER mention batch counts or batch sizes
- Letter every station A, B, C, … in processFlow order — never leave one unlettered
- BLAST CHILLER's lettered paragraph always includes exactly: "CCP1: Core ≤5°C" / "CCP1: Kern ≤5°C"
- EN and DE must mirror exactly (same stations, same letters, same number of sentences)
- Only use facts from context; if temp/time unknown → [CHECK]

FACTOR RULES (from context — never override):
- rti=true → output ONLY "RTI → Plating" (both languages, nothing else, no letters)
- neverBatch=true → do NOT mention splitting or batches
- separate/spiceRoom ingredients → make "SPICE ROOM" the FIRST lettered station ("A."): "A. SPICE ROOM: Separate portioning at Spice Room..." / "A. GEWÜRZRAUM: Separate Portionierung im Gewürzraum..."
- allergensContains non-empty → final unlettered line: "⚠ <list>"

Return JSON: {"english":"...","german":"...","status":"needs_review"}` }] },
    contents: [{ role: "user", parts: [{ text: `WO context:\n${context}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          english: { type: "STRING" },
          german: { type: "STRING" },
          status: { type: "STRING", enum: ["generated", "needs_review"] },
        },
        required: ["english", "german", "status"],
      },
      maxOutputTokens: 2000,
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let response;
  let payload;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: requestBody },
    );
    payload = await response.json().catch(() => ({}));
    if (response.ok || response.status < 500 || attempt === 1) break;
  }
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini HTTP ${response.status}`);
  const text = payload.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text) throw new Error(`Gemini lieferte keine Instructions (${payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason || "unbekannter Grund"})`);

  const candidate = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  if (objectStart < 0 || objectEnd <= objectStart) throw new Error(`Gemini lieferte kein JSON-Objekt (${text.slice(0, 120)})`);
  const jsonText = candidate.slice(objectStart, objectEnd + 1);
  let inString = false;
  let safeJson = "";
  for (let i = 0; i < jsonText.length; i++) {
    const c = jsonText[i];
    const prev = jsonText[i - 1];
    const escaped = prev === "\\" && jsonText[i - 2] !== "\\";
    if (c === '"' && !escaped) inString = !inString;
    if (inString && c === "\n") safeJson += "\\n";
    else if (inString && c === "\r") continue;
    else if (inString && c === "\t") safeJson += "\\t";
    else safeJson += c;
  }
  let instruction;
  try {
    instruction = JSON.parse(safeJson);
  } catch (err) {
    throw new Error(`Gemini JSON ungültig: ${err instanceof Error ? err.message : String(err)} · Anfang: ${safeJson.slice(0, 180)}`);
  }
  if (!instruction.english || !instruction.german) throw new Error("Gemini lieferte unvollständige Instructions");
  return {
    english: instruction.english,
    german: instruction.german,
    status: instruction.status === "generated" ? "generated" : "needs_review",
    generatedAt: new Date().toISOString(),
    model,
  };
}

exports.geminiInstruction = onRequest(
  { region: "europe-west3", timeoutSeconds: 60, secrets: [GEMINI_API_KEY_SECRET] },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try {
      const body = req.body || {};
      if (!body.context) { res.status(400).json({ error: "context fehlt" }); return; }
      const instruction = await generateGeminiInstructionCloud(body.context);
      res.status(200).json({ instruction });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

exports.geminiInstructionsBatch = onRequest(
  { region: "europe-west3", timeoutSeconds: 540, memory: "512MiB", concurrency: 1, secrets: [GEMINI_API_KEY_SECRET] },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try {
      const body = req.body || {};
      const items = Array.isArray(body.items) ? body.items : [];
      const results = {};
      // Keep Gemini traffic below rate limits; the browser splits large weeks
      // into requests of four WOs, and each request is processed in parallel.
      const CONCURRENCY = 4;
      for (let i = 0; i < items.length; i += CONCURRENCY) {
        await Promise.all(items.slice(i, i + CONCURRENCY).map(async (item) => {
          try {
            results[item.key] = { ok: true, instruction: await generateGeminiInstructionCloud(item.context) };
          } catch (err) {
            results[item.key] = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }));
      }
      res.status(200).json({ results });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

// ─── Gemini Planning Chat (Cockpit AI-Assistent) ─────────────────────────────

exports.geminiPlanningChat = onRequest(
  { region: "europe-west3", timeoutSeconds: 60, secrets: [GEMINI_API_KEY_SECRET] },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try {
      const body = req.body || {};
      const { context, history, message } = body;
      if (!message) { res.status(400).json({ error: "message fehlt" }); return; }

      const apiKey = GEMINI_API_KEY_SECRET.value();
      if (!apiKey) throw new Error("Firebase Secret GEMINI_API_KEY nicht gesetzt");
      const model = "gemini-2.5-flash";

      const systemPrompt = [
        "Du bist KI-Planungsassistent für die Verden-Wochenplanung bei HelloFresh.",
        "Du kennst den aktuellen Plan und alle Regeln vollständig (sieh den Planstand unten).",
        "Antworte immer auf Deutsch, direkt und präzise.",
        "Du darfst Planänderungen vorschlagen (propose_plan_change) und Probleme melden (check_plan_issues).",
        "Änderungen werden dem Nutzer zur Bestätigung angezeigt — du änderst NIE direkt.",
        "Wenn der Nutzer keine Änderung braucht, antworte einfach mit Text.",
        "",
        context || "",
      ].join("\n");

      const contents = [
        ...(Array.isArray(history) ? history : []).map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content || "(Planvorschlag / Analyse)" }],
        })),
        { role: "user", parts: [{ text: message }] },
      ];

      const tools = [{
        functionDeclarations: [
          {
            name: "propose_plan_change",
            description: "Schlägt Änderungen am Wochenplan vor. Der Nutzer sieht eine Vorschau und muss bestätigen.",
            parameters: {
              type: "OBJECT",
              properties: {
                changes: {
                  type: "ARRAY",
                  description: "Liste der vorgeschlagenen Assignments-Änderungen",
                  items: {
                    type: "OBJECT",
                    properties: {
                      recipeCode: { type: "STRING", description: "Rezept-Code, z.B. FE1234A" },
                      subRecipeId: { type: "STRING", description: "Nur bei Sub-Rezepten: Sub-Rezept-ID" },
                      day: { type: "STRING", description: "Produktionstag (Mo/Di/Mi/Do/Fr/Sa)" },
                      shift: { type: "STRING", description: "S1=Frühschicht, S2=Spätschicht" },
                      targetPortions: { type: "NUMBER", description: "Optional: Ziel-Portionszahl" },
                      splitSpec: { type: "STRING", description: "Optional: Split-Spec, z.B. Do:400|Fr:1200|Sa:800" },
                      reason: { type: "STRING", description: "Kurze Begründung für diese Änderung" },
                    },
                    required: ["recipeCode", "day", "shift", "reason"],
                  },
                },
                summary: { type: "STRING", description: "Zusammenfassung: was wird geändert und warum" },
              },
              required: ["changes", "summary"],
            },
          },
          {
            name: "check_plan_issues",
            description: "Meldet Probleme, Risiken oder Optimierungspotenziale im aktuellen Plan.",
            parameters: {
              type: "OBJECT",
              properties: {
                issues: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      severity: { type: "STRING", description: "critical, warning oder info" },
                      description: { type: "STRING" },
                      affectedRecipes: { type: "ARRAY", items: { type: "STRING" } },
                      suggestion: { type: "STRING" },
                    },
                    required: ["severity", "description"],
                  },
                },
              },
              required: ["issues"],
            },
          },
        ],
      }];

      const requestBody = JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools,
        generationConfig: { maxOutputTokens: 4096 },
      });

      let response;
      let payload;
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody }
        );
        payload = await response.json().catch(() => ({}));
        if (response.ok) break;
        if (response.status === 429 && attempt < 1) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw new Error(payload?.error?.message || `Gemini HTTP ${response.status}`);
      }

      const parts = payload?.candidates?.[0]?.content?.parts ?? [];
      let text = "";
      let toolName = null;
      let toolInput = null;

      for (const part of parts) {
        if (part.text) text += part.text;
        if (part.functionCall) {
          toolName = part.functionCall.name;
          toolInput = part.functionCall.args;
        }
      }

      res.status(200).json({ text: text.trim(), toolName, toolInput });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

// ─── Gemini Plating Chat (Plating-Linien-KI-Experte) ─────────────────────────

exports.geminiPlatingChat = onRequest(
  { region: "europe-west3", timeoutSeconds: 60, secrets: [GEMINI_API_KEY_SECRET] },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try {
      const body = req.body || {};
      const { context, history, message } = body;
      if (!message) { res.status(400).json({ error: "message fehlt" }); return; }

      const apiKey = GEMINI_API_KEY_SECRET.value();
      if (!apiKey) throw new Error("Firebase Secret GEMINI_API_KEY nicht gesetzt");
      const model = "gemini-2.5-flash";

      const systemPrompt = [
        "Du bist der PLATING-LINIEN-EXPERTE für die HelloFresh Factory Verden.",
        "Du kennst den kompletten Linienplan (welches Rezept auf welcher Linie/Slot läuft) und alle Allergen-Daten.",
        "Dein Ziel: MINIMALE Allergen-Wechsel, maximaler Durchsatz, optimale Linien-Auslastung.",
        "",
        "STRATEGIEN die du IMMER anwendest:",
        "• Linie 1 = HIGHRUNNER: Höchstes Volumen, fast keine Wechsel (0-1 Allergen-Changeover/Tag)",
        "• Linie 2 = FLEX: Mittlere Rezepte, allergen-ähnliche nacheinander (max 3-4 Wechsel/Tag)",
        "• Linie 3 = NUR bei Overload (>16k Portionen/Tag)",
        "• SPÄTSCHICHT: Zuschaltbar wenn Frühschicht >85% voll. Slots 15:00-19:00.",
        "• CARRYOVER: Wenn ein Tag sein Kontingent nicht schafft → Rest zum nächsten Tag mitnehmen",
        "• FISCH immer am Ende des Tages oder am Donnerstag/Freitag (MHD 9 Tage)",
        "• Jeder Allergen-Wechsel = 30min Reinigung. Protein-Typ-Wechsel = 1h Full Changeover.",
        "• CUP-Rezepte: Parallel zur Linie in der Cupping-Station, brauchen Vorlauf",
        "• NUR 2 TAGE VORAUSPLANEN: Immer nur den aktuellen + nächsten Tag planen",
        "",
        "Antworte IMMER auf Deutsch, direkt und mit Begründung.",
        "Bei Optimierungs-Anfragen: Nutze optimize_line_sequence für ganze Tages-Linien.",
        "Bei Verschiebungen: Nutze propose_plating_move für einzelne Rezept-Moves.",
        "Bei Analyse: Nutze check_plating_issues für Probleme und Warnungen.",
        "",
        context || "",
      ].join("\n");

      const contents = [
        ...(Array.isArray(history) ? history : []).map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content || "(Vorschlag)" }],
        })),
        { role: "user", parts: [{ text: message }] },
      ];

      const tools = [{
        functionDeclarations: [
          {
            name: "propose_plating_move",
            description: "Verschiebt ein oder mehrere Rezepte zwischen Linien oder Slots. Nutzer sieht Vorschau.",
            parameters: {
              type: "OBJECT",
              properties: {
                moves: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      recipeCode: { type: "STRING" },
                      recipeName: { type: "STRING" },
                      fromDay: { type: "STRING" },
                      fromSlot: { type: "STRING" },
                      fromLine: { type: "NUMBER", description: "0-basiert (0=L1, 1=L2, 2=L3)" },
                      toDay: { type: "STRING" },
                      toSlot: { type: "STRING" },
                      toLine: { type: "NUMBER" },
                      reason: { type: "STRING" },
                    },
                    required: ["recipeCode", "fromDay", "fromSlot", "fromLine", "toDay", "toSlot", "toLine", "reason"],
                  },
                },
                summary: { type: "STRING" },
              },
              required: ["moves", "summary"],
            },
          },
          {
            name: "optimize_line_sequence",
            description: "Gibt die optimale Reihenfolge aller Rezepte auf einer Linie für einen Tag vor (allergen-optimal sortiert).",
            parameters: {
              type: "OBJECT",
              properties: {
                changes: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      line: { type: "NUMBER", description: "0=L1, 1=L2, 2=L3" },
                      day: { type: "STRING" },
                      newOrder: { type: "ARRAY", items: { type: "STRING" }, description: "Rezept-Codes in neuer Reihenfolge" },
                      reason: { type: "STRING" },
                    },
                    required: ["line", "day", "newOrder", "reason"],
                  },
                },
                summary: { type: "STRING" },
              },
              required: ["changes", "summary"],
            },
          },
          {
            name: "check_plating_issues",
            description: "Meldet Probleme: Zu viele Allergen-Wechsel, MHD-Verstöße, Kapazitätslücken, suboptimale Reihenfolge.",
            parameters: {
              type: "OBJECT",
              properties: {
                issues: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      severity: { type: "STRING", description: "critical, warning, info" },
                      description: { type: "STRING" },
                      affectedSlots: { type: "ARRAY", items: { type: "STRING" } },
                      suggestion: { type: "STRING" },
                    },
                    required: ["severity", "description"],
                  },
                },
              },
              required: ["issues"],
            },
          },
        ],
      }];

      const requestBody = JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools,
        generationConfig: { maxOutputTokens: 4096 },
      });

      let response;
      let payload;
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody }
        );
        payload = await response.json().catch(() => ({}));
        if (response.ok) break;
        if (response.status === 429 && attempt < 1) { await new Promise(r => setTimeout(r, 2000)); continue; }
        throw new Error(payload?.error?.message || `Gemini HTTP ${response.status}`);
      }

      const parts = payload?.candidates?.[0]?.content?.parts ?? [];
      let text = "";
      let toolName = null;
      let toolInput = null;
      for (const part of parts) {
        if (part.text) text += part.text;
        if (part.functionCall) { toolName = part.functionCall.name; toolInput = part.functionCall.args; }
      }

      res.status(200).json({ text: text.trim(), toolName, toolInput });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

// ─── PDF-Generierung via Chromium ────────────────────────────────────────────

const CHROMIUM_PACK_URL = "https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar";

async function htmlToPdfCloud(html) {
  const chromium = require("@sparticuz/chromium-min");
  const puppeteer = require("puppeteer-core");
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
    headless: chromium.headless,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    return await page.pdf({
      format: "A4",
      margin: { top: "8mm", right: "8mm", bottom: "8mm", left: "8mm" },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
}

exports.generatePdf = onRequest(
  { region: "europe-west3", timeoutSeconds: 120, memory: "2GiB" },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    try {
      const body = req.body || {};
      if (!body.html) { res.status(400).json({ error: "html fehlt" }); return; }
      const pdf = await htmlToPdfCloud(body.html);
      const filename = (body.filename || "wo-breakdown.pdf").replace(/[^\w\-.]+/g, "_");
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="${filename}"`);
      res.set("Cache-Control", "no-store");
      res.status(200).end(Buffer.from(pdf));
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);