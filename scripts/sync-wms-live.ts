/**
 * sync-wms-live.ts
 *
 * Verbindet lokal mit Snowflake via SSO (externalbrowser),
 * fragt WMS-Livebestand ab und schreibt das Ergebnis in:
 *   public/data/wms-live-cache.json
 *
 * Danach optional: firebase deploy --only hosting
 *
 * Aufruf:
 *   npm run wms:sync                        # aktuelle KW
 *   npm run wms:sync -- --week 2026-W22     # bestimmte KW
 *   npm run wms:sync -- --week 2026-W22 --deploy  # + Auto-Deploy
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: "functions/.env" });
loadEnv({ path: ".env.local" });

import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import snowflake from "snowflake-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const weekArg = (() => {
  const idx = args.indexOf("--week");
  return idx >= 0 ? args[idx + 1] : null;
})();
const autoDeploy = args.includes("--deploy");

function currentHfWeek(): string {
  const now = new Date();
  // ISO-Wochennummer
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const diff = now.getTime() - startOfWeek1.getTime();
  const week = Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function parseHfWeek(raw: string): { year: number; week: number; label: string } {
  const match = raw.trim().match(/^(20\d{2})-W(\d{2})$/);
  if (!match) throw new Error(`Ungültiges KW-Format: "${raw}". Erwartet: YYYY-Www`);
  return { year: Number(match[1]), week: Number(match[2]), label: raw.trim() };
}

const weekStr = weekArg ?? currentHfWeek();
const weekInfo = parseHfWeek(weekStr);

// ── Snowflake-Konfiguration ────────────────────────────────────────────────────

const ACCOUNT   = process.env.SNOWFLAKE_ACCOUNT    ?? "XG02811-OO69432";
const USER      = process.env.SNOWFLAKE_USER        ?? "MARCEL.SPINDLER@HELLOFRESH.DE";
const ROLE      = process.env.SNOWFLAKE_ROLE        ?? "US_OPS_ANALYTICS_USER";
const WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE   ?? "US_OPS_ANALYTICS";
const DATABASE  = process.env.SNOWFLAKE_DATABASE    ?? "US_OPS_ANALYTICS";
const SCHEMA    = process.env.SNOWFLAKE_SCHEMA      ?? "HIGHJUMP";
const WH_ID     = process.env.SNOWFLAKE_WH_ID       ?? "VF";

// Lokaler Script: immer externalbrowser (SSO). Kein Passwort nötig/sinnvoll.
const AUTHENTICATOR = "externalbrowser";

// ── SQL ───────────────────────────────────────────────────────────────────────

const SQL = `
WITH live_items AS (
  SELECT
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
    END AS station_label,
    si.LOCATION_ID,
    si.ITEM_NUMBER,
    MAX(im.DESCRIPTION) AS item_description,
    MAX(im.UOM) AS item_uom,
    MAX(im.INVENTORY_TYPE) AS inventory_type,
    MAX(im.INV_CAT) AS inventory_category,
    MAX(im.INV_CLASS) AS inventory_class,
    MAX(im.ITEM_STATUS) AS item_master_status,
    MAX(im.MEAL_NUMBER) AS meal_number,
    MAX(im.SHELF_LIFE) AS shelf_life,
    LEFT(si.ITEM_NUMBER, 3) AS item_prefix,
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
    END AS item_type,
    IFF(LEFT(si.ITEM_NUMBER, 3) IN ('SUB','PTN','PHF'), TRUE, FALSE) AS is_meal,
    si.STATUS,
    SUM(si.ACTUAL_QTY) AS qty,
    MIN(si.EXPIRATION_DATE) AS earliest_mhd
  FROM ${DATABASE}.${SCHEMA}.T_STORED_ITEM si
  LEFT JOIN ${DATABASE}.${SCHEMA}.T_ITEM_MASTER im
    ON im.ITEM_NUMBER = si.ITEM_NUMBER
   AND im.WH_ID = si.WH_ID
  WHERE si.WH_ID = ?
    AND si.ACTUAL_QTY > 0
    AND si.EXPIRATION_DATE > '1901-01-01'
    AND WEEKOFYEAR(si.EXPIRATION_DATE) = ?
    AND YEAR(si.EXPIRATION_DATE) = ?
  GROUP BY 1,2,3,4,13,14,15,16
)
SELECT
  station, station_label,
  LOCATION_ID AS location_id,
  ITEM_NUMBER AS item_number,
  item_description, item_uom, inventory_type, inventory_category,
  inventory_class, item_master_status, meal_number, shelf_life,
  item_prefix, item_type, is_meal, STATUS AS status, qty, earliest_mhd
FROM live_items
ORDER BY station, qty DESC
LIMIT 2000`;

// ── Snowflake-Verbindung ───────────────────────────────────────────────────────

function connectSnowflake(): Promise<snowflake.Connection> {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection({
      account: ACCOUNT,
      username: USER,
      authenticator: AUTHENTICATOR,
      role: ROLE,
      warehouse: WAREHOUSE,
      database: DATABASE,
      schema: SCHEMA,
      application: "rezeptlogik_wms_sync",
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

// ── Payload aufbauen (identisch zur Cloud Function) ───────────────────────────

function buildPayload(rows: Record<string, unknown>[], weekLabel: string) {
  const stationMap = new Map<string, { station: string; label: string; qty: number; skuSet: Set<string>; locationSet: Set<string> }>();

  const items = rows.map((row) => {
    const station = String(row.STATION ?? row.station ?? "0_OTHER");
    const label = String(row.STATION_LABEL ?? row.station_label ?? station);
    const qty = Number(row.QTY ?? row.qty ?? 0) || 0;
    const itemNumber = String(row.ITEM_NUMBER ?? row.item_number ?? "");
    const locationId = String(row.LOCATION_ID ?? row.location_id ?? "");

    const summary = stationMap.get(station) ?? { station, label, qty: 0, skuSet: new Set(), locationSet: new Set() };
    summary.qty += qty;
    if (itemNumber) summary.skuSet.add(itemNumber);
    if (locationId) summary.locationSet.add(locationId);
    stationMap.set(station, summary);

    return {
      station,
      stationLabel: label,
      locationId,
      itemNumber,
      itemName: String(row.ITEM_DESCRIPTION ?? row.item_description ?? ""),
      itemUom: String(row.ITEM_UOM ?? row.item_uom ?? ""),
      inventoryType: String(row.INVENTORY_TYPE ?? row.inventory_type ?? ""),
      inventoryCategory: String(row.INVENTORY_CATEGORY ?? row.inventory_category ?? ""),
      inventoryClass: String(row.INVENTORY_CLASS ?? row.inventory_class ?? ""),
      itemMasterStatus: String(row.ITEM_MASTER_STATUS ?? row.item_master_status ?? ""),
      mealNumber: String(row.MEAL_NUMBER ?? row.meal_number ?? ""),
      shelfLife: Number(row.SHELF_LIFE ?? row.shelf_life ?? 0) || null,
      itemPrefix: String(row.ITEM_PREFIX ?? row.item_prefix ?? ""),
      itemType: String(row.ITEM_TYPE ?? row.item_type ?? ""),
      isMeal: Boolean(row.IS_MEAL ?? row.is_meal ?? false),
      status: String(row.STATUS ?? row.status ?? ""),
      qty,
      earliestMhd: (row.EARLIEST_MHD ?? row.earliest_mhd ?? null) as string | null,
    };
  });

  const stations = Array.from(stationMap.values())
    .map(s => ({ station: s.station, label: s.label, status: s.qty > 0 ? "AKTIV" : "BEREIT", qty: s.qty, skuCount: s.skuSet.size, locationCount: s.locationSet.size }))
    .sort((a, b) => a.station.localeCompare(b.station));

  return { ok: true, configured: true, week: weekLabel, generatedAt: new Date().toISOString(), stations, items };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n🔗 WMS-Sync für ${weekInfo.label}`);
console.log(`   Snowflake: ${ACCOUNT} | User: ${USER}`);
console.log(`   Ein Browser-Fenster öffnet sich für die SSO-Anmeldung...\n`);

let conn: snowflake.Connection | undefined;
try {
  conn = await connectSnowflake();
  console.log("✅ Verbunden. Abfrage läuft...");

  const rows = await executeQuery(conn, SQL, [WH_ID, weekInfo.week, weekInfo.year]);
  console.log(`✅ ${rows.length} Einträge abgerufen.`);

  const payload = buildPayload(rows, weekInfo.label);

  const outDir = join(ROOT, "public", "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "wms-live-cache.json");
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`✅ Gespeichert: public/data/wms-live-cache.json`);

  if (autoDeploy) {
    console.log("\n🚀 Deploy läuft (npm run build && firebase deploy --only hosting)...");
    execSync("npm run build && firebase deploy --only hosting", { cwd: ROOT, stdio: "inherit" });
    console.log("✅ Deploy abgeschlossen.");
  } else {
    console.log("\n💡 Jetzt deployen: npm run wms:deploy");
  }
} finally {
  if (conn) await destroyConnection(conn);
}
