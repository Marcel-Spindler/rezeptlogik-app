const { createHash } = require("node:crypto");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const snowflake = require("snowflake-sdk");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const ExcelJS = require("exceljs");

let VisionClientCtor = null;
try {
  const vision = require("@google-cloud/vision");
  VisionClientCtor = vision.ImageAnnotatorClient;
} catch {
  VisionClientCtor = null;
}

admin.initializeApp();

const db = admin.firestore();
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
    "production_.time",
    "last_updated"
FROM US_OPS_ANALYTICS.HIGHJUMP_ANALYTICS.V_SUBMEAL_PRODUCTION
WHERE "wh_id" = ?
ORDER BY "last_updated" DESC
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
    const kwTabs = tabs.filter(t => /W\d{2}|PW\d{2}|\d{4}-W\d{2}/.test(t));
    if (kwTabs.length) return kwTabs[kwTabs.length - 1];
  }
  return null;
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
    tabName = findCurrentWeekTabGS(allTabs, ["W{XX} Transperancy", "W{XX} Transparency", "BENL Outbound W{XX}"]) || allTabs[0];
  }
  if (!tabName) return null;

  let rows;
  try { rows = await sheetValues(sheets, spreadsheetId, tabName); } catch { return null; }

  // Derive week from tab name: "W23 Transperancy Total Overview" → 2026-W23
  const tabWeekMatch = /W(\d{1,2})/i.exec(tabName);
  const year = new Date().getFullYear();
  const week = tabWeekMatch
    ? `${year}-W${String(parseInt(tabWeekMatch[1], 10)).padStart(2, "0")}`
    : `${year}-W??`;

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
    if (!woCell || !/^\d{2}-\d{3,}/.test(woCell)) continue;

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

  logger.info("readProductionPlanGSheet", { tab: tabName, rows: resultRows.length });
  return { week, generatedAt: new Date().toISOString(), rows: resultRows };
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

async function readKitchenPriorityGSheet(sheets) {
  const spreadsheetId = process.env.SHEET_KITCHEN_PRIORITY || "13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U";
  if (!spreadsheetId) return [];
  let tabName = process.env.SHEET_KITCHEN_PRIORITY_TAB;
  if (!tabName) {
    const allTabs = await getAllTabNamesGS(sheets, spreadsheetId);
    tabName = findCurrentWeekTabGS(allTabs, ["Verden-{YEAR}-W{XX}", "Verden-{YEAR}-W{KW}"]) || allTabs[0];
  }
  if (!tabName) return [];
  let rows; try { rows = await sheetValues(sheets, spreadsheetId, tabName); } catch { return []; }
  if (!rows.length) return [];

  // Find header row: contains "Priority" and "Work Order"
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    const r = rows[i].map(c => String(c || "").trim().toLowerCase());
    if (r.some(c => c === "priority") && r.some(c => c.includes("work order"))) {
      headerIdx = i; break;
    }
  }
  if (headerIdx < 0) return [];

  const header = rows[headerIdx].map(c => String(c || "").trim().toLowerCase());
  const prioIdx    = header.findIndex(c => c === "priority");
  const stagingIdx = header.findIndex(c => c.includes("wostaging") || (c.includes("wo") && c.includes("staging")));
  const commentIdx = header.findIndex(c => c.includes("comment"));
  const deboxIdx   = header.findIndex(c => c.includes("debox"));
  const readyIdx   = header.findIndex(c => c.includes("wo ready"));
  const hkIdx      = header.findIndex(c => c.includes("hot kitchen"));
  const dateIdx    = header.findIndex(c => c.includes("date needed"));
  const woIdx      = header.findIndex(c => c.includes("work order number"));

  const result = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const wo = woIdx >= 0 ? String(row[woIdx] || "").trim() : "";
    if (!wo || !/^\d{2}-\d{3,}/.test(wo)) continue;
    const readyRaw = readyIdx >= 0 ? String(row[readyIdx] || "").trim().toUpperCase() : "";
    result.push({
      priority:          prioIdx >= 0 ? (parseInt(String(row[prioIdx] || ""), 10) || result.length + 1) : result.length + 1,
      workOrder:         wo,
      woStagingBy:       stagingIdx >= 0 ? String(row[stagingIdx] || "").trim() || undefined : undefined,
      deboxDay:          deboxIdx >= 0 ? String(row[deboxIdx] || "").trim() || undefined : undefined,
      woReady:           readyRaw === "TRUE",
      hotKitchenWeekday: hkIdx >= 0 ? String(row[hkIdx] || "").trim() || undefined : undefined,
      dateNeeded:        dateIdx >= 0 ? String(row[dateIdx] || "").trim() || undefined : undefined,
      comments:          commentIdx >= 0 ? String(row[commentIdx] || "").trim() || undefined : undefined,
    });
  }
  return result;
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

    const [productionPlan, printOrders, kitchenPriority] = await Promise.all([
      readProductionPlanGSheet(sheets),
      readPrintOrdersGSheet(sheets),
      readKitchenPriorityGSheet(sheets),
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

    const kpColl = APP_ROOT.collection("kitchenPriority");
    const kpRef = kpColl.doc("current");
    if (kitchenPriority.length) batch.set(kpRef, { rows: kitchenPriority, updatedAt: checkedAt });

    await APP_ROOT.set({ operationalLastCheckedAt: checkedAt }, { merge: true });
    await batch.commit();

    logger.info("refreshOperationalData OK", { productionRows: productionPlan?.rows?.length ?? 0, printOrders: printOrders.length, kitchenPriority: kitchenPriority.length });
    res.json({ ok: true, refreshed: true, productionRows: productionPlan?.rows?.length ?? 0, printOrders: printOrders.length, kitchenPriority: kitchenPriority.length, checkedAt });
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

exports.wmsInbound = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
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

exports.wmsWorkorders = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }
  const params = parseWmsParams(req, {});
  try {
    try {
      const conn = await connectSnowflake();
      const rowsRaw = await executeSnowflakeQuery(conn, WMS_WORKORDERS_SQL, [params.whId, params.limit]);
      return res.json({
        ok: true,
        whId: params.whId,
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
      return res.json({
        ok: true,
        whId: params.whId,
        limit: params.limit,
        generatedAt: nowIso(),
        source: "firestore-cache",
        cachedAt: cached.pushedAt || cached.generatedAt,
        rows: cached.rows || [],
      });
    }

    throw new Error("Keine Workorders-Daten. Bitte 'npm run wms-sync' ausführen.");
  } catch (error) {
    logger.error("WMS workorders failed", { error: error?.message });
    res.status(500).json({ ok: false, whId: params.whId, limit: params.limit, generatedAt: nowIso(), rows: [], error: error?.message || String(error) });
  }
});