/**
 * wms-local-server.ts
 *
 * Lokaler HTTP-Server auf Port 3141, der Snowflake-Abfragen über SSO
 * (externalbrowser / Okta) ausführt und dem Browser zurückgibt.
 *
 * Start: npm run wms:server
 *
 * Danach funktioniert der "Aktualisieren"-Button in der App direkt.
 * Ein Browser-Fenster für die SSO-Anmeldung öffnet sich automatisch.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: "functions/.env" });
loadEnv({ path: ".env.local" });

import snowflake from "snowflake-sdk";

const PORT = 3141;

const ACCOUNT   = process.env.SNOWFLAKE_ACCOUNT    ?? "XG02811-OO69432";
const USER      = process.env.SNOWFLAKE_USER        ?? "MARCEL.SPINDLER@HELLOFRESH.DE";
const ROLE      = process.env.SNOWFLAKE_ROLE        ?? "US_OPS_ANALYTICS_USER";
const WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE   ?? "US_OPS_ANALYTICS";
const DATABASE  = process.env.SNOWFLAKE_DATABASE    ?? "US_OPS_ANALYTICS";
const SCHEMA    = process.env.SNOWFLAKE_SCHEMA      ?? "HIGHJUMP";
const WH_ID     = process.env.SNOWFLAKE_WH_ID       ?? "VF";

function currentHfWeek(): string {
  const now = new Date();
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const diff = now.getTime() - startOfWeek1.getTime();
  const isoWeek = Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1;
  const factorWeek = isoWeek + 1; // HF Factor-Woche = ISO-Woche + 1
  const year = factorWeek > 52 ? now.getFullYear() + 1 : now.getFullYear();
  const week = factorWeek > 52 ? 1 : factorWeek;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function parseHfWeek(raw: string): { year: number; week: number; label: string } {
  const match = raw.trim().match(/^(20\d{2})-W(\d{2})$/);
  if (!match) throw new Error(`Ungültiges KW-Format: "${raw}". Erwartet: YYYY-Www`);
  return { year: Number(match[1]), week: Number(match[2]), label: raw.trim() };
}

function snowflakeWeekForToolWeek(weekInfo: { year: number; week: number }): { year: number; week: number; label: string } {
  const week = weekInfo.week - 1;
  if (week >= 1) return { year: weekInfo.year, week, label: `${weekInfo.year}-W${String(week).padStart(2, "0")}` };
  return { year: weekInfo.year - 1, week: 52, label: `${weekInfo.year - 1}-W52` };
}

const SQL = `
WITH raw_items AS (
  SELECT
    si.STO_ID,
    si.SEQUENCE,
    si.ITEM_NUMBER,
    si.ACTUAL_QTY,
    si.UNAVAILABLE_QTY,
    si.WH_ID,
    si.LOCATION_ID,
    si.LOT_NUMBER,
    si.HU_ID,
    si.SHIPMENT_NUMBER,
    si.DB_CHANGE_COMMIT_TIME,
    WEEKOFYEAR(si.DB_CHANGE_COMMIT_TIME) AS SNOWFLAKE_KW,
    si.CONNECTOR_PROCESSED_TIME,
    si.SF_INSERT_TIME,
    si.OP_FLAG,
    si.EVENT_SERIAL_NO,
    si.UPDATED_AT_UTC,
    si.SERVER,
    im.DESCRIPTION AS ITEM_DESCRIPTION,
    im.UOM AS ITEM_UOM,
    im.INVENTORY_TYPE,
    im.INV_CAT AS INVENTORY_CATEGORY,
    im.INV_CLASS AS INVENTORY_CLASS,
    im.ITEM_STATUS AS ITEM_MASTER_STATUS,
    im.MEAL_NUMBER,
    im.SHELF_LIFE,
    LEFT(si.ITEM_NUMBER, 3) AS ITEM_PREFIX,
    CASE
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'SUB' THEN 'SUB - Meal Kit'
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'PTN' THEN 'PTN - Protein Meal'
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'PHF' THEN 'PHF - Pre-Heat Fresh'
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'REC' THEN 'REC - Recipe'
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'CON' THEN 'CON - Container'
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'PCK' THEN 'PCK - Pack'
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'SPI' THEN 'SPI - Spice'
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'DAI' THEN 'DAI - Dairy'
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'DRY' THEN 'DRY - Dry Goods'
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'PRO' THEN 'PRO - Protein Raw'
      WHEN LEFT(si.ITEM_NUMBER, 3) = 'BEV' THEN 'BEV - Beverage'
      ELSE LEFT(si.ITEM_NUMBER, 3)
    END AS ITEM_TYPE,
    IFF(LEFT(si.ITEM_NUMBER, 3) IN ('SUB','PTN','PHF'), TRUE, FALSE) AS IS_MEAL,
    CASE
      WHEN si.LOCATION_ID = 'DEBOXWIP' THEN '1_DEBOX'
      WHEN si.LOCATION_ID IN ('VEGGIE','PROTEIN','BULKLIQUID','BRAISER') THEN '2_PREPZONE'
      WHEN si.LOCATION_ID ILIKE 'PREB%' OR si.LOCATION_ID ILIKE 'PreB%' THEN '3_PREBLAST'
      WHEN si.LOCATION_ID ILIKE '%REDZONE%' OR si.LOCATION_ID ILIKE 'REDZ%' OR si.LOCATION_ID ILIKE 'RZ-%' OR si.LOCATION_ID ILIKE 'RZ%' THEN '4_REDZONE'
      WHEN si.LOCATION_ID ILIKE 'PLATING%' OR si.LOCATION_ID ILIKE 'PLH%' OR si.LOCATION_ID ILIKE '%PLAT%' OR si.LOCATION_ID ILIKE '%PLAIT%' THEN '4_PLATING'
      WHEN si.LOCATION_ID ILIKE 'PostB%' OR si.LOCATION_ID ILIKE 'POSTB%' THEN '5_POSTBLAST'
      WHEN si.LOCATION_ID = 'SLEEVING' OR si.LOCATION_ID ILIKE '%SLEEV%' THEN '6_SLEEVING'
      WHEN si.LOCATION_ID IN ('ASSEMBLYWIP','KITCHENWIP','PRODUCTION') THEN '7_ASSEMBLY'
      WHEN si.LOCATION_ID ILIKE 'VF-LINE%' OR si.LOCATION_ID ILIKE 'SPI%' OR si.LOCATION_ID = 'SPI-WINDOW' THEN '8_LINE'
      WHEN si.LOCATION_ID ILIKE 'STGDR%' OR si.LOCATION_ID ILIKE 'PHSTG%' OR si.LOCATION_ID ILIKE 'VHSTG%' OR si.LOCATION_ID ILIKE 'SPISTG%' THEN '9_STAGING'
      WHEN si.LOCATION_ID = 'LOST' OR si.LOCATION_ID ILIKE 'SPERRLAGER%' OR si.LOCATION_ID = 'PROD RTN' OR si.LOCATION_ID = 'ADJ LOC' THEN 'Z_BLOCKED'
      ELSE '0_OTHER'
    END AS station,
    CASE
      WHEN si.LOCATION_ID = 'DEBOXWIP' THEN 'Debox'
      WHEN si.LOCATION_ID IN ('VEGGIE','PROTEIN','BULKLIQUID','BRAISER') THEN 'Veggie & Protein'
      WHEN si.LOCATION_ID ILIKE 'PREB%' OR si.LOCATION_ID ILIKE 'PreB%' THEN 'Pre-Blast'
      WHEN si.LOCATION_ID ILIKE '%REDZONE%' OR si.LOCATION_ID ILIKE 'REDZ%' OR si.LOCATION_ID ILIKE 'RZ-%' OR si.LOCATION_ID ILIKE 'RZ%' THEN 'Redzone / Plating Scan'
      WHEN si.LOCATION_ID ILIKE 'PLATING%' OR si.LOCATION_ID ILIKE 'PLH%' OR si.LOCATION_ID ILIKE '%PLAT%' OR si.LOCATION_ID ILIKE '%PLAIT%' THEN 'Plating / PLH'
      WHEN si.LOCATION_ID ILIKE 'PostB%' OR si.LOCATION_ID ILIKE 'POSTB%' THEN 'Post-Blast'
      WHEN si.LOCATION_ID = 'SLEEVING' OR si.LOCATION_ID ILIKE '%SLEEV%' THEN 'Sleeving'
      WHEN si.LOCATION_ID IN ('ASSEMBLYWIP','KITCHENWIP','PRODUCTION') THEN 'Assembly / Kitchen'
      WHEN si.LOCATION_ID ILIKE 'VF-LINE%' OR si.LOCATION_ID ILIKE 'SPI%' OR si.LOCATION_ID = 'SPI-WINDOW' THEN 'Linie / Output'
      WHEN si.LOCATION_ID ILIKE 'STGDR%' OR si.LOCATION_ID ILIKE 'PHSTG%' OR si.LOCATION_ID ILIKE 'VHSTG%' OR si.LOCATION_ID ILIKE 'SPISTG%' THEN 'Staging'
      WHEN si.LOCATION_ID = 'LOST' OR si.LOCATION_ID ILIKE 'SPERRLAGER%' OR si.LOCATION_ID = 'PROD RTN' OR si.LOCATION_ID = 'ADJ LOC' THEN 'Gesperrt / Verlust'
      ELSE 'Sonstiges'
    END AS station_label
  FROM ${DATABASE}.${SCHEMA}.T_STORED_ITEM si
  LEFT JOIN ${DATABASE}.${SCHEMA}.T_ITEM_MASTER im
    ON im.ITEM_NUMBER = si.ITEM_NUMBER
   AND im.WH_ID = si.WH_ID
  WHERE si.WH_ID = ?
    AND WEEKOFYEAR(si.DB_CHANGE_COMMIT_TIME) = ?
    AND YEAR(si.DB_CHANGE_COMMIT_TIME) = ?
    AND (COALESCE(si.ACTUAL_QTY, 0) <> 0 OR COALESCE(si.UNAVAILABLE_QTY, 0) <> 0)
    AND si.LOCATION_ID IN (
      'PRODUCTION','LOST','DEBOXWIP','VEGGIE','PostB-01','SLEEVING',
      'PLATING-LINE-03','ASSEMBLYWIP','PROD RTN','PROTEIN','VF-LINE-02',
      'KITCHENWIP','VF-LINE-01','STGDR-27','PHSTG-13','STGDR-30',
      'PREB-01','SPI-WINDOW','VHSTG-10','PLATING-LINE-01','VHSTG-11',
      'ADJ LOC','PLATING-LINE-02','PHSTG-09','BULKLIQUID','PHSTG-06',
      'PHSTG-12','SPISTG-10','VHSTG-25','FH-01-01','VHSTG-17','SPISTG-14',
      'PHSTG-05','VHSTG-22','PHSTG-14','SPISTG-12','VHSTG-16','VHSTG-15',
      'SPERRLAGER P','SPERRLAGER C','BRAISER','PS WIP','Sleeving','VH-03-01',
      'STGDR-29','STGDR-85','VHSTG-01','VHSTG-18','VHSTG-19','VHSTG-23',
      'PHSTG-17','PHSTG-18','PHSTG-19','PHSTG-20','PHSTG-22',
      'SPISTG-01','SPISTG-03','SPISTG-04','SPISTG-05','SPISTG-06',
      'SPISTG-07','SPISTG-08','SPISTG-09','SPISTG-11','SPISTG-13',
      'SPISTG-15','SPISTG-16','SPISTG-17','SPISTG-18','SPISTG-20'
    )
)
SELECT
  station, station_label, STO_ID, SEQUENCE,
  LOCATION_ID AS location_id,
  ITEM_NUMBER AS item_number,
  ACTUAL_QTY AS qty,
  UNAVAILABLE_QTY AS unavailable_qty,
  WH_ID, LOT_NUMBER, HU_ID, SHIPMENT_NUMBER,
  DB_CHANGE_COMMIT_TIME, SNOWFLAKE_KW, CONNECTOR_PROCESSED_TIME,
  SF_INSERT_TIME, OP_FLAG, EVENT_SERIAL_NO, UPDATED_AT_UTC, SERVER,
  ITEM_DESCRIPTION AS item_description, ITEM_UOM AS item_uom,
  INVENTORY_TYPE AS inventory_type, INVENTORY_CATEGORY AS inventory_category,
  INVENTORY_CLASS AS inventory_class, ITEM_MASTER_STATUS AS item_master_status,
  MEAL_NUMBER AS meal_number, SHELF_LIFE AS shelf_life,
  ITEM_PREFIX AS item_prefix, ITEM_TYPE AS item_type, IS_MEAL AS is_meal
FROM raw_items
ORDER BY LOCATION_ID, ITEM_NUMBER, DB_CHANGE_COMMIT_TIME DESC
LIMIT 2000`;

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
      application: "rezeptlogik_wms_server",
    } as any);
    conn.connect((err, c) => err ? reject(err) : resolve(c));
  });
}

function executeQuery(conn: snowflake.Connection, sql: string, binds: unknown[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: sql,
      binds: binds as any,
      complete(err, _stmt, rows) {
        err ? reject(err) : resolve((rows ?? []) as Record<string, unknown>[]);
      },
    });
  });
}

function destroyConnection(conn: snowflake.Connection): Promise<void> {
  return new Promise((resolve) => {
    try { conn.destroy(() => resolve()); } catch { resolve(); }
  });
}

function buildPayload(rows: Record<string, unknown>[], weekLabel: string, snowflakeWeekLabel: string) {
  const stationMap = new Map<string, { station: string; label: string; qty: number; unavailableQty: number; skuSet: Set<string>; locationSet: Set<string> }>();

  const items = rows.map((row) => {
    const station = String(row.STATION ?? row.station ?? "0_OTHER");
    const label   = String(row.STATION_LABEL ?? row.station_label ?? station);
    const qty     = Number(row.QTY ?? row.qty ?? 0) || 0;
    const unavailableQty = Number(row.UNAVAILABLE_QTY ?? row.unavailable_qty ?? 0) || 0;
    const itemNumber = String(row.ITEM_NUMBER ?? row.item_number ?? "");
    const locationId = String(row.LOCATION_ID ?? row.location_id ?? "");

    const summary = stationMap.get(station) ?? { station, label, qty: 0, unavailableQty: 0, skuSet: new Set(), locationSet: new Set() };
    summary.qty += qty;
    summary.unavailableQty += unavailableQty;
    if (itemNumber) summary.skuSet.add(itemNumber);
    if (locationId) summary.locationSet.add(locationId);
    stationMap.set(station, summary);

    return {
      station,
      stationLabel: label,
      stoId:             String(row.STO_ID ?? row.sto_id ?? ""),
      sequence:          String(row.SEQUENCE ?? row.sequence ?? ""),
      locationId,
      itemNumber,
      qty,
      unavailableQty,
      whId:              String(row.WH_ID ?? row.wh_id ?? ""),
      lotNumber:         String(row.LOT_NUMBER ?? row.lot_number ?? ""),
      huId:              String(row.HU_ID ?? row.hu_id ?? ""),
      shipmentNumber:    String(row.SHIPMENT_NUMBER ?? row.shipment_number ?? ""),
      dbChangeCommitTime:(row.DB_CHANGE_COMMIT_TIME ?? row.db_change_commit_time ?? null) as string | null,
      snowflakeKw:       Number(row.SNOWFLAKE_KW ?? row.snowflake_kw ?? 0) || null,
      connectorProcessedTime:(row.CONNECTOR_PROCESSED_TIME ?? row.connector_processed_time ?? null) as string | null,
      sfInsertTime:      (row.SF_INSERT_TIME ?? row.sf_insert_time ?? null) as string | null,
      opFlag:            String(row.OP_FLAG ?? row.op_flag ?? ""),
      eventSerialNo:     String(row.EVENT_SERIAL_NO ?? row.event_serial_no ?? ""),
      updatedAtUtc:      (row.UPDATED_AT_UTC ?? row.updated_at_utc ?? null) as string | null,
      server:            String(row.SERVER ?? row.server ?? ""),
      itemName:          String(row.ITEM_DESCRIPTION ?? row.item_description ?? ""),
      itemUom:           String(row.ITEM_UOM ?? row.item_uom ?? ""),
      inventoryType:     String(row.INVENTORY_TYPE ?? row.inventory_type ?? ""),
      inventoryCategory: String(row.INVENTORY_CATEGORY ?? row.inventory_category ?? ""),
      inventoryClass:    String(row.INVENTORY_CLASS ?? row.inventory_class ?? ""),
      itemMasterStatus:  String(row.ITEM_MASTER_STATUS ?? row.item_master_status ?? ""),
      mealNumber:        String(row.MEAL_NUMBER ?? row.meal_number ?? ""),
      shelfLife:         Number(row.SHELF_LIFE ?? row.shelf_life ?? 0) || null,
      itemPrefix:        String(row.ITEM_PREFIX ?? row.item_prefix ?? ""),
      itemType:          String(row.ITEM_TYPE ?? row.item_type ?? ""),
      isMeal:            Boolean(row.IS_MEAL ?? row.is_meal ?? false),
    };
  });

  const stations = Array.from(stationMap.values())
    .map(s => ({ station: s.station, label: s.label, status: s.qty > 0 ? "AKTIV" : "BEREIT", qty: s.qty, unavailableQty: s.unavailableQty, skuCount: s.skuSet.size, locationCount: s.locationSet.size }))
    .sort((a, b) => a.station.localeCompare(b.station));

  return { ok: true, configured: true, week: weekLabel, snowflakeWeek: snowflakeWeekLabel, generatedAt: new Date().toISOString(), stations, items };
}

// ── Redzone (OEE-System) ───────────────────────────────────────────────────────

function buildRedzoneSQL(year: number, week: number): string {
  return `
WITH params AS (
  SELECT ${year} AS kw_year, ${week} AS kw_week, '%Verden%' AS site_filter
)

SELECT '1_RUN' AS SECTION,
       "siteName"                     AS SITE,
       "areaName"                     AS AREA,
       "locationName"                 AS LINE,
       "runStartTime"::TIMESTAMP_NTZ  AS TS,
       "runName"                      AS LABEL1,
       "productTypeSKU"               AS LABEL2,
       ROUND("oee"*100,1)             AS OEE_PCT,
       ROUND("availability"*100,1)    AS AVAIL_PCT,
       ROUND("performance"*100,1)     AS PERF_PCT,
       ROUND("quality"*100,1)         AS QUAL_PCT,
       "inCount"::FLOAT               AS IN_COUNT,
       "outCount"::FLOAT              AS OUT_COUNT,
       "targetQuantity"::FLOAT        AS TARGET,
       "manHours"::FLOAT              AS MAN_HOURS,
       ROUND("upSeconds"/60.0,1)      AS UP_MIN,
       ROUND("downSeconds"/60.0,1)    AS DOWN_MIN,
       NULL                           AS EVENTS,
       NULL                           AS UNITS_LOST
FROM REDZONE_AWS_EUWEST1_HELLOFRESH_EXTERNAL_SHARE."hellofresh-org"."v_run", params
WHERE "dateYear" = params.kw_year
  AND "week"     = params.kw_week
  AND "siteName" ILIKE params.site_filter

UNION ALL

SELECT '2_LOSS',
       "siteName","areaName","locationName",
       "startTime"::TIMESTAMP_NTZ,
       "problemTypeName","problemCategory",
       NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL,
       ROUND("secondsLost"/60.0,1)    AS UP_MIN,
       NULL                           AS DOWN_MIN,
       1::FLOAT                       AS EVENTS,
       "unitsLost"::FLOAT             AS UNITS_LOST
FROM REDZONE_AWS_EUWEST1_HELLOFRESH_EXTERNAL_SHARE."hellofresh-org"."v_losses", params
WHERE "dateYear" = params.kw_year
  AND "week"     = params.kw_week
  AND "siteName" ILIKE params.site_filter

UNION ALL

SELECT '3_HOURLY',
       "siteName","areaName","locationName",
       "timePeriod"::TIMESTAMP_NTZ,
       "shiftName","productTypeSKU",
       ROUND("oee"*100,1),
       ROUND("availability"*100,1),
       ROUND("performance"*100,1),
       ROUND("quality"*100,1),
       "inCount"::FLOAT,"outCount"::FLOAT,
       "targetQuantity"::FLOAT,"manHours"::FLOAT,
       ROUND("upSeconds"/60.0,1),
       ROUND("downSeconds"/60.0,1),
       NULL, NULL
FROM REDZONE_AWS_EUWEST1_HELLOFRESH_EXTERNAL_SHARE."hellofresh-org"."v_hourlyperformancesummary", params
WHERE "dateYear" = params.kw_year
  AND "week"     = params.kw_week
  AND "siteName" ILIKE params.site_filter

UNION ALL

SELECT '4_SUMMARY',
       "siteName","areaName","locationName",
       NULL, 'KW ${week}', NULL,
       ROUND(AVG("oee")*100,1),
       ROUND(AVG("availability")*100,1),
       ROUND(AVG("performance")*100,1),
       ROUND(AVG("quality")*100,1),
       SUM("inCount")::FLOAT, SUM("outCount")::FLOAT,
       SUM("targetQuantity")::FLOAT, ROUND(SUM("manHours"),1),
       ROUND(SUM("upSeconds")/60.0,1),
       ROUND(SUM("downSeconds")/60.0,1),
       COUNT(*)::FLOAT, NULL
FROM REDZONE_AWS_EUWEST1_HELLOFRESH_EXTERNAL_SHARE."hellofresh-org"."v_run", params
WHERE "dateYear" = params.kw_year
  AND "week"     = params.kw_week
  AND "siteName" ILIKE params.site_filter
GROUP BY "siteName","areaName","locationName", params.kw_week

ORDER BY SECTION, SITE, AREA, LINE, TS DESC`;
}

async function handleRedzone(res: ServerResponse, year: number, week: number): Promise<void> {
  console.log(`\n→ Redzone Anfrage KW ${week}/${year}`);

  if (!cachedConn) {
    console.log("  SSO-Anmeldung … (Browser-Fenster öffnet sich)");
    cachedConn = await connectSnowflake();
    console.log("  ✓ Snowflake verbunden");
  }

  console.log("  Redzone-Abfrage läuft …");
  const sql = buildRedzoneSQL(year, week);
  const rows = await executeQuery(cachedConn, sql, []);
  console.log(`  ✓ ${rows.length} Redzone-Einträge`);

  const mapped = rows.map(row => ({
    section:   String(row.SECTION ?? ""),
    site:      String(row.SITE ?? ""),
    area:      String(row.AREA ?? ""),
    line:      String(row.LINE ?? ""),
    ts:        row.TS   != null ? String(row.TS)   : null,
    label1:    row.LABEL1 != null ? String(row.LABEL1) : null,
    label2:    row.LABEL2 != null ? String(row.LABEL2) : null,
    oee:       row.OEE_PCT   != null ? Number(row.OEE_PCT)   : null,
    avail:     row.AVAIL_PCT != null ? Number(row.AVAIL_PCT) : null,
    perf:      row.PERF_PCT  != null ? Number(row.PERF_PCT)  : null,
    qual:      row.QUAL_PCT  != null ? Number(row.QUAL_PCT)  : null,
    inCount:   row.IN_COUNT  != null ? Number(row.IN_COUNT)  : null,
    outCount:  row.OUT_COUNT != null ? Number(row.OUT_COUNT) : null,
    target:    row.TARGET    != null ? Number(row.TARGET)    : null,
    manHours:  row.MAN_HOURS != null ? Number(row.MAN_HOURS) : null,
    upMin:     row.UP_MIN    != null ? Number(row.UP_MIN)    : null,
    downMin:   row.DOWN_MIN  != null ? Number(row.DOWN_MIN)  : null,
    events:    row.EVENTS    != null ? Number(row.EVENTS)    : null,
    unitsLost: row.UNITS_LOST!= null ? Number(row.UNITS_LOST): null,
  }));

  const weekLabel = `${year}-W${String(week).padStart(2, "0")}`;
  sendJson(res, 200, { ok: true, week: weekLabel, generatedAt: new Date().toISOString(), rows: mapped });
}

// ── Request-Handler ────────────────────────────────────────────────────────────

// Eine laufende Verbindung und ein laufender Fetch werden gecacht – SSO öffnet sich
// nur einmal pro Server-Laufzeit (bis die Verbindung abläuft).
let cachedConn: snowflake.Connection | undefined;
let pendingFetch: Promise<Record<string, unknown>[]> | undefined;

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

const SQL_SUBMEALS = `
SELECT
  WEEK,
  WO,
  RECIPE_ITEM,
  DESCRIPTION,
  PUTAWAY_LOCATION,
  STATUS,
  SUM(BOM_QUANTITY)     AS BOM_QTY,
  SUM(OUT_ACTUAL_QTY)   AS OUT_QTY,
  SUM(ADJUSTED_OUT_QTY) AS ADJUSTED_QTY,
  SUM(PORTIONS)         AS PORTIONS,
  MAX(CREATE_DATE)      AS LAST_UPDATE
FROM US_OPS_ANALYTICS.HIGHJUMP_ANALYTICS.FACTOR_SUBMEALS_BUSINESS_LAYER
WHERE WH_ID = 'VF'
  AND WEEK = ?
GROUP BY 1,2,3,4,5,6
ORDER BY WEEK DESC, WO, RECIPE_ITEM
`;

async function handleSubmeals(res: ServerResponse, weekLabel: string, weekNum: number): Promise<void> {
  console.log(`\n→ Submeals-Anfrage für KW ${weekLabel} (${weekNum})`);

  if (!cachedConn) {
    console.log("  SSO-Anmeldung … (Browser-Fenster öffnet sich)");
    cachedConn = await connectSnowflake();
    console.log("  ✓ Snowflake verbunden");
  }

  console.log("  Abfrage läuft …");
  const rows = await executeQuery(cachedConn, SQL_SUBMEALS, [weekNum]);
  console.log(`  ✓ ${rows.length} Submeals-Zeilen`);

  const mapped = rows.map(r => ({
    week:           Number(r.WEEK ?? 0),
    wo:             String(r.WO ?? ""),
    recipeItem:     String(r.RECIPE_ITEM ?? ""),
    description:    String(r.DESCRIPTION ?? ""),
    putawayLocation:String(r.PUTAWAY_LOCATION ?? ""),
    status:         String(r.STATUS ?? ""),
    bomQty:         Number(r.BOM_QTY ?? 0),
    outQty:         Number(r.OUT_QTY ?? 0),
    adjustedQty:    Number(r.ADJUSTED_QTY ?? 0),
    portions:       Number(r.PORTIONS ?? 0),
    lastUpdate:     r.LAST_UPDATE != null ? String(r.LAST_UPDATE) : null,
  }));

  sendJson(res, 200, { ok: true, week: weekLabel, generatedAt: new Date().toISOString(), rows: mapped });
}

async function handleWmsLive(req: IncomingMessage, res: ServerResponse, week: string): Promise<void> {
  const weekInfo = parseHfWeek(week);
  const snowflakeWeek = snowflakeWeekForToolWeek(weekInfo);

  console.log(`\n→ Anfrage für Tool-KW ${week} (Snowflake ${snowflakeWeek.label})`);

  if (!cachedConn) {
    console.log("  SSO-Anmeldung … (Browser-Fenster öffnet sich)");
    cachedConn = await connectSnowflake();
    console.log("  ✓ Snowflake verbunden");
  }

  console.log("  Abfrage läuft …");
  const rows = await executeQuery(cachedConn, SQL, [WH_ID, snowflakeWeek.week, snowflakeWeek.year]);
  console.log(`  ✓ ${rows.length} Einträge`);

  const payload = buildPayload(rows, weekInfo.label, snowflakeWeek.label);
  sendJson(res, 200, payload);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/wms-live" && req.method === "GET") {
    const week = url.searchParams.get("week") ?? currentHfWeek();
    try {
      await handleWmsLive(req, res, week);
    } catch (err) {
      // Verbindung zurücksetzen damit nächster Versuch neu verbindet
      if (cachedConn) {
        destroyConnection(cachedConn).catch(() => {});
        cachedConn = undefined;
      }
      console.error("  ✗ Fehler:", err);
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return;
  }

  if (url.pathname === "/redzone" && req.method === "GET") {
    const weekStr = url.searchParams.get("week") ?? currentHfWeek();
    try {
      const weekInfo = parseHfWeek(weekStr);
      await handleRedzone(res, weekInfo.year, weekInfo.week);
    } catch (err) {
      if (cachedConn) {
        destroyConnection(cachedConn).catch(() => {});
        cachedConn = undefined;
      }
      console.error("  ✗ Redzone Fehler:", err);
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return;
  }

  if (url.pathname === "/submeals" && req.method === "GET") {
    const weekStr = url.searchParams.get("week") ?? currentHfWeek();
    try {
      const weekInfo = parseHfWeek(weekStr);
      const weekNum = weekInfo.year * 100 + weekInfo.week; // z.B. 202621
      await handleSubmeals(res, weekStr, weekNum);
    } catch (err) {
      if (cachedConn) {
        destroyConnection(cachedConn).catch(() => {});
        cachedConn = undefined;
      }
      console.error("  ✗ Submeals Fehler:", err);
      sendJson(res, 500, { ok: false, error: String(err) });
    }
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, connected: !!cachedConn });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n✅ WMS Local Server läuft auf http://localhost:${PORT}`);
  console.log(`   Endpunkte:`);
  console.log(`     GET /wms-live?week=2026-W22   → Snowflake T_STORED_ITEM (SSO)`);
  console.log(`     GET /redzone?week=2026-W22    → Redzone OEE-Daten`);
  console.log(`     GET /submeals?week=2026-W22   → FACTOR_SUBMEALS_BUSINESS_LAYER`);
  console.log(`     GET /health                   → Status`);
  console.log(`\n   Beim ersten "Aktualisieren"-Klick öffnet sich das SSO-Browser-Fenster.`);
  console.log(`   Danach wird die Verbindung bis zum Neustart gecacht.\n`);
});

server.on("error", (err) => {
  console.error("Server-Fehler:", err);
  process.exit(1);
});
