const { createHash } = require("node:crypto");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const snowflake = require("snowflake-sdk");

admin.initializeApp();

const db = admin.firestore();
const APP_ROOT = db.collection("apps").doc("rezeptlogik");
const DEFAULT_GSHEET_ID = "1IEi_CB9KylW2MgjNiGax5EIvhhAtkIzm57uO1sSESj8";
const SHEET_RANGE = "Meal Selection!A3:X1000";
const CHECK_COOLDOWN_MS = 60 * 1000;

function getSheetIds() {
  return [
    process.env.GSHEET_ID || DEFAULT_GSHEET_ID,
    ...(process.env.GSHEET_IDS || "").split(",")
  ].map(value => value.trim()).filter(Boolean);
}

function num(value) {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function stableWeekRecipeId(row) {
  return `${row.hfWeek}__${row.code}`;
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

async function readMealSelectionRows() {
  const sheets = await createSheetsClient();
  const weekRecipes = [];
  const weeks = new Set();
  const seen = new Set();

  for (const spreadsheetId of getSheetIds()) {
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: SHEET_RANGE });
    const rows = response.data.values || [];
    for (const row of rows) {
      const hfWeek = (row[0] || "").toString().trim();
      const code = (row[1] || "").toString().trim();
      if (!hfWeek || !code || !/^\d{4}-W\d{2}$/.test(hfWeek)) continue;
      const dedupeKey = `${hfWeek}__${code}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const verdenAbsBENL = num(row[18]);
      const verdenAbsNORD = num(row[19]);
      const verdenAbsDE = num(row[20]);
      weekRecipes.push({
        hfWeek,
        weekShort: hfWeek.slice(5),
        code,
        recipeName: (row[3] || "").toString(),
        preference: (row[2] || "").toString(),
        slot: {
          BENL: num(row[5]) || undefined,
          DKSE: num(row[6]) || undefined,
          DE: num(row[7]) || undefined
        },
        verdenVolume: {
          BENL: verdenAbsBENL,
          DKSE: verdenAbsNORD,
          DE: verdenAbsDE
        },
        totalVerdenVolume: num(row[21]) || (verdenAbsBENL + verdenAbsNORD + verdenAbsDE),
        productionBuffer: num(row[23])
      });
      weeks.add(hfWeek);
    }
  }

  return {
    weekRecipes,
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

function parseHfWeek(raw) {
  const match = String(raw || "").trim().match(/^(20\d{2})-W(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) return null;
  return { year, week, label: `${year}-W${String(week).padStart(2, "0")}` };
}

function snowflakeConfig() {
  const authenticator = process.env.SNOWFLAKE_AUTHENTICATOR || (process.env.SNOWFLAKE_PASSWORD ? undefined : "externalbrowser");
  const config = {
    account: process.env.SNOWFLAKE_ACCOUNT,
    username: process.env.SNOWFLAKE_USER,
    password: process.env.SNOWFLAKE_PASSWORD,
    authenticator,
    role: process.env.SNOWFLAKE_ROLE || "US_OPS_ANALYTICS_USER",
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || "US_OPS_ANALYTICS",
    database: process.env.SNOWFLAKE_DATABASE || "US_OPS_ANALYTICS",
    schema: process.env.SNOWFLAKE_SCHEMA || "HIGHJUMP",
  };
  return config;
}

function isSnowflakeConfigured(config) {
  const hasAuth = Boolean(config.password || config.authenticator);
  return Boolean(config.account && config.username && hasAuth && config.database && config.schema && config.warehouse);
}

function connectSnowflake(config) {
  return new Promise((resolve, reject) => {
    const connection = snowflake.createConnection({
      account: config.account,
      username: config.username,
      password: config.password || undefined,
      authenticator: config.authenticator,
      role: config.role,
      warehouse: config.warehouse,
      database: config.database,
      schema: config.schema,
      application: "rezeptlogik_wms_live",
    });
    connection.connect((error, conn) => {
      if (error) reject(error);
      else resolve(conn);
    });
  });
}

function executeSnowflake(connection, sqlText, binds = []) {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete(error, _stmt, rows) {
        if (error) reject(error);
        else resolve(rows || []);
      },
    });
  });
}

function destroySnowflake(connection) {
  return new Promise((resolve) => {
    try {
      connection.destroy(() => resolve());
    } catch {
      resolve();
    }
  });
}

function buildWmsLiveSql(config) {
  return `
WITH live_items AS (
  SELECT
    CASE
      WHEN LOCATION_ID = 'DEBOXWIP' THEN '1_DEBOX'
      WHEN LOCATION_ID IN ('VEGGIE','PROTEIN','BULKLIQUID','BRAISER') THEN '2_PREPZONE'
      WHEN LOCATION_ID ILIKE 'PREB%' OR LOCATION_ID ILIKE 'PreB%' THEN '3_PREBLAST'
      WHEN LOCATION_ID ILIKE 'PLATING%' THEN '4_PLATING'
      WHEN LOCATION_ID ILIKE 'PostB%' OR LOCATION_ID ILIKE 'POSTB%' THEN '5_POSTBLAST'
      WHEN LOCATION_ID = 'SLEEVING' THEN '6_SLEEVING'
      WHEN LOCATION_ID IN ('ASSEMBLYWIP','KITCHENWIP','PRODUCTION') THEN '7_ASSEMBLY'
      WHEN LOCATION_ID ILIKE 'VF-LINE%' OR LOCATION_ID ILIKE 'SPI%' OR LOCATION_ID = 'SPI-WINDOW' THEN '8_LINE'
      WHEN LOCATION_ID ILIKE 'STGDR%' OR LOCATION_ID ILIKE 'PHSTG%' OR LOCATION_ID ILIKE 'VHSTG%' OR LOCATION_ID ILIKE 'SPISTG%' THEN '9_STAGING'
      WHEN LOCATION_ID = 'LOST' OR LOCATION_ID ILIKE 'SPERRLAGER%' OR LOCATION_ID = 'PROD RTN' OR LOCATION_ID = 'ADJ LOC' THEN 'Z_BLOCKED'
      ELSE '0_OTHER'
    END AS station,
    CASE
      WHEN LOCATION_ID = 'DEBOXWIP' THEN 'Debox'
      WHEN LOCATION_ID IN ('VEGGIE','PROTEIN','BULKLIQUID','BRAISER') THEN 'Veggie & Protein'
      WHEN LOCATION_ID ILIKE 'PREB%' OR LOCATION_ID ILIKE 'PreB%' THEN 'Pre-Blast'
      WHEN LOCATION_ID ILIKE 'PLATING%' THEN 'Plating'
      WHEN LOCATION_ID ILIKE 'PostB%' OR LOCATION_ID ILIKE 'POSTB%' THEN 'Post-Blast'
      WHEN LOCATION_ID = 'SLEEVING' THEN 'Sleeving'
      WHEN LOCATION_ID IN ('ASSEMBLYWIP','KITCHENWIP','PRODUCTION') THEN 'Assembly / Kitchen'
      WHEN LOCATION_ID ILIKE 'VF-LINE%' OR LOCATION_ID ILIKE 'SPI%' OR LOCATION_ID = 'SPI-WINDOW' THEN 'Linie / Output'
      WHEN LOCATION_ID ILIKE 'STGDR%' OR LOCATION_ID ILIKE 'PHSTG%' OR LOCATION_ID ILIKE 'VHSTG%' OR LOCATION_ID ILIKE 'SPISTG%' THEN 'Staging'
      WHEN LOCATION_ID = 'LOST' OR LOCATION_ID ILIKE 'SPERRLAGER%' OR LOCATION_ID = 'PROD RTN' OR LOCATION_ID = 'ADJ LOC' THEN 'Gesperrt / Verlust'
      ELSE 'Sonstiges'
    END AS station_label,
    LOCATION_ID,
    ITEM_NUMBER,
    LEFT(ITEM_NUMBER, 3) AS item_prefix,
    CASE
      WHEN LEFT(ITEM_NUMBER, 3) = 'SUB' THEN 'SUB - Meal Kit'
      WHEN LEFT(ITEM_NUMBER, 3) = 'PTN' THEN 'PTN - Protein Meal'
      WHEN LEFT(ITEM_NUMBER, 3) = 'PHF' THEN 'PHF - Pre-Heat Fresh'
      WHEN LEFT(ITEM_NUMBER, 3) = 'REC' THEN 'REC - Recipe'
      WHEN LEFT(ITEM_NUMBER, 3) = 'CON' THEN 'CON - Container'
      WHEN LEFT(ITEM_NUMBER, 3) = 'PCK' THEN 'PCK - Pack'
      WHEN LEFT(ITEM_NUMBER, 3) = 'SPI' THEN 'SPI - Spice'
      WHEN LEFT(ITEM_NUMBER, 3) = 'DAI' THEN 'DAI - Dairy'
      WHEN LEFT(ITEM_NUMBER, 3) = 'DRY' THEN 'DRY - Dry Goods'
      WHEN LEFT(ITEM_NUMBER, 3) = 'PRO' THEN 'PRO - Protein Raw'
      WHEN LEFT(ITEM_NUMBER, 3) = 'BEV' THEN 'BEV - Beverage'
      ELSE LEFT(ITEM_NUMBER, 3)
    END AS item_type,
    IFF(LEFT(ITEM_NUMBER, 3) IN ('SUB','PTN','PHF'), TRUE, FALSE) AS is_meal,
    STATUS,
    SUM(ACTUAL_QTY) AS qty,
    MIN(EXPIRATION_DATE) AS earliest_mhd
  FROM ${config.database}.${config.schema}.T_STORED_ITEM
  WHERE WH_ID = ?
    AND ACTUAL_QTY > 0
    AND EXPIRATION_DATE > '1901-01-01'
    AND WEEKOFYEAR(EXPIRATION_DATE) = ?
    AND YEAR(EXPIRATION_DATE) = ?
  GROUP BY 1,2,3,4,5,6,7,8
)
SELECT
  station,
  station_label,
  LOCATION_ID AS location_id,
  ITEM_NUMBER AS item_number,
  item_prefix,
  item_type,
  is_meal,
  STATUS AS status,
  qty,
  earliest_mhd
FROM live_items
ORDER BY station, qty DESC
LIMIT 2000`;
}

function toWmsPayload(rows, weekLabel) {
  const stationMap = new Map();
  const items = rows.map((row) => {
    const station = String(row.STATION || row.station || "0_OTHER");
    const label = String(row.STATION_LABEL || row.station_label || station);
    const qty = Number(row.QTY ?? row.qty ?? 0) || 0;
    const item = {
      station,
      stationLabel: label,
      locationId: String(row.LOCATION_ID || row.location_id || ""),
      itemNumber: String(row.ITEM_NUMBER || row.item_number || ""),
      itemPrefix: String(row.ITEM_PREFIX || row.item_prefix || ""),
      itemType: String(row.ITEM_TYPE || row.item_type || ""),
      isMeal: Boolean(row.IS_MEAL ?? row.is_meal ?? false),
      status: String(row.STATUS || row.status || ""),
      qty,
      earliestMhd: row.EARLIEST_MHD || row.earliest_mhd || null,
    };
    const summary = stationMap.get(station) || {
      station,
      label,
      qty: 0,
      skuSet: new Set(),
      locationSet: new Set(),
    };
    summary.qty += qty;
    if (item.itemNumber) summary.skuSet.add(item.itemNumber);
    if (item.locationId) summary.locationSet.add(item.locationId);
    stationMap.set(station, summary);
    return item;
  });

  const stations = Array.from(stationMap.values())
    .map((summary) => ({
      station: summary.station,
      label: summary.label,
      status: summary.qty > 0 ? "AKTIV" : "BEREIT",
      qty: summary.qty,
      skuCount: summary.skuSet.size,
      locationCount: summary.locationSet.size,
    }))
    .sort((a, b) => a.station.localeCompare(b.station));

  return {
    ok: true,
    configured: true,
    week: weekLabel,
    generatedAt: new Date().toISOString(),
    stations,
    items,
  };
}

exports.wmsLive = onRequest({ region: "europe-west3", timeoutSeconds: 90, memory: "512MiB" }, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }

  const week = parseHfWeek(req.query.week);
  if (!week) {
    res.status(400).json({ ok: false, error: "invalid-week" });
    return;
  }

  const config = snowflakeConfig();
  if (!isSnowflakeConfigured(config)) {
    res.status(503).json({
      ok: false,
      configured: false,
      week: week.label,
      error: "snowflake-not-configured",
      requiredEnv: ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PASSWORD oder SNOWFLAKE_AUTHENTICATOR"],
    });
    return;
  }

  const whId = process.env.SNOWFLAKE_WH_ID || "VF";
  let connection;
  try {
    connection = await connectSnowflake(config);
    const rows = await executeSnowflake(connection, buildWmsLiveSql(config), [whId, week.week, week.year]);
    res.set("Cache-Control", "private, max-age=45");
    res.json(toWmsPayload(rows, week.label));
  } catch (error) {
    logger.error("wmsLive failed", error);
    res.status(500).json({ ok: false, configured: true, week: week.label, error: error?.message || String(error) });
  } finally {
    if (connection) await destroySnowflake(connection);
  }
});
