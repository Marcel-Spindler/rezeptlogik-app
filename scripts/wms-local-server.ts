/**
 * Lokaler Snowflake-Server fuer WMS Live.
 *
 * Behaelt nur die Zugangsdaten lokal und stellt die aktuellen WMS-Queries bereit.
 * Keine Firebase-Persistenz, kein Cache.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

loadEnv({ path: "functions/.env" });
loadEnv({ path: ".env.local" });

import snowflake from "snowflake-sdk";
import { google } from "googleapis";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3141;

const ACCOUNT = process.env.SNOWFLAKE_ACCOUNT ?? "XG02811-OO69432";
const USER = process.env.SNOWFLAKE_USER ?? "MARCEL.SPINDLER@HELLOFRESH.DE";
const ROLE = process.env.SNOWFLAKE_ROLE ?? "US_OPS_ANALYTICS_USER";
const WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE ?? "US_OPS_ANALYTICS";
const DATABASE = process.env.SNOWFLAKE_DATABASE ?? "US_OPS_ANALYTICS";
const SCHEMA = process.env.SNOWFLAKE_SCHEMA ?? "HIGHJUMP";

// ─── Google Sheets (Service Account) — Production Plan ─────────────────────
// Eigener Zugriffsweg, unabhängig von Snowflake oben: liest ein einzelnes
// GSheet-Tab per gid über die authentifizierte Sheets API statt über den
// anonymen gviz/tq-CSV-Export, den die App für alle anderen GSheet-Quellen
// nutzt (useGSheetMonitor.ts). Grund: der öffentliche CSV-Export lässt bei
// diesem konkreten Sheet Text-Zellen ("Cup"/"Slicing") in sonst zahlenlastigen
// Spalten stillschweigend leer — über die echte Sheets API kommt der
// Zelleninhalt zuverlässig an (verifiziert: FORMULA/UNFORMATTED_VALUE/
// FORMATTED_VALUE liefern übereinstimmend den echten Text).
// Sheet-ID muss mit PRODUCTIONPLAN_SHEET_ID in useGSheetMonitor.ts übereinstimmen.
const PRODUCTION_PLAN_SHEET_ID = "1zaQjWKlNN4JNCMnE-lrdgf7iNgabfl9HGq5vdOyKedI";

const sheetsAuth = new google.auth.GoogleAuth({
  keyFile: join(__dirname, "../secrets/service-account.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
let sheetsClient: ReturnType<typeof google.sheets> | undefined;

async function getSheetsClient() {
  if (!sheetsClient) {
    const authClient = await sheetsAuth.getClient();
    sheetsClient = google.sheets({ version: "v4", auth: authClient as never });
  }
  return sheetsClient;
}

// Alle Tabs im Production-Plan-Sheet, die dem Muster "W{NN} - Plating Plan
// [WIP]" folgen -- Marcel legt jede Woche einen neuen Tab an (Kopie des
// Vorwochen-Tabs), die gid steht nirgends hart hinterlegt. Aeltere Tabs (vor
// W33) folgen uneinheitlichen Namen ("[Updated] W29 - Plan", "adapted W30 -
// Plating Plan [WIP]", Duplikate) und werden bewusst NICHT erkannt -- fuer
// die Vorstellung der kommenden Woche irrelevant, siehe gsheetTypes.ts.
const PRODUCTION_PLAN_TAB_PATTERN = /^W(\d{1,2})\s*-\s*Plating Plan\s*\[WIP\]$/i;

interface ProductionPlanWeekTab {
  week: number;
  gid: string;
  title: string;
}

async function fetchProductionPlanWeekTabs(): Promise<ProductionPlanWeekTab[]> {
  const client = await getSheetsClient();
  const meta = await client.spreadsheets.get({
    spreadsheetId: PRODUCTION_PLAN_SHEET_ID,
    fields: "sheets(properties(title,sheetId))",
  });
  const tabs: ProductionPlanWeekTab[] = [];
  for (const sheet of meta.data.sheets ?? []) {
    const title = (sheet.properties?.title ?? "").trim();
    const match = PRODUCTION_PLAN_TAB_PATTERN.exec(title);
    if (!match) continue;
    tabs.push({ week: Number(match[1]), gid: String(sheet.properties?.sheetId ?? ""), title });
  }

  // "ab jetzt aufwaerts": Wochenzahlen allein tragen kein Jahr -- direkt um
  // den Jahreswechsel herum koennte z.B. "W01" (naechstes Jahr) numerisch
  // kleiner als die laufende KW49 wirken. Grobe Absicherung: bei einer
  // laufenden KW > 45 zaehlen auch kleine Wochenzahlen (<=6) als "zukuenftig".
  const currentWeekNum = Number(/W(\d{2})$/.exec(currentHfWeek())?.[1] ?? "0");
  const wrapsToNextYear = currentWeekNum > 45;
  return tabs
    .filter(t => t.week >= currentWeekNum || (wrapsToNextYear && t.week <= 6))
    .sort((a, b) => a.week - b.week);
}

async function fetchProductionPlanRows(gid: string): Promise<string[][]> {
  const client = await getSheetsClient();
  const meta = await client.spreadsheets.get({
    spreadsheetId: PRODUCTION_PLAN_SHEET_ID,
    fields: "sheets(properties(title,sheetId))",
  });
  const tab = (meta.data.sheets ?? []).find(s => String(s.properties?.sheetId ?? "") === gid);
  if (!tab) throw new Error(`Kein Tab mit gid=${gid} im Production-Plan-Sheet gefunden`);
  const title = tab.properties?.title ?? "";
  const valuesRes = await client.spreadsheets.values.get({
    spreadsheetId: PRODUCTION_PLAN_SHEET_ID,
    range: `'${title}'!A1:AK500`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return (valuesRes.data.values ?? []) as string[][];
}

// ─── Forecast & Recipe Profil (Live-Vergleich, siehe productionPlanLiveCheck.ts) ──
// Zwei weitere Tabs im selben Sheet, aus denen der Production-Plan-Tab selbst
// per VLOOKUP/FILTER gespeist wird -- hier NICHT als Ersatzquelle geholt,
// sondern damit der Client abgleichen kann, ob der im Production-Plan-Tab
// eingefrorene Wert noch zu Forecast/Recipe Profil passt (z.B. neue Zeile,
// VLOOKUP-Formeln noch nicht heruntergezogen).
async function fetchForecastRows(hfWeek: string): Promise<string[][]> {
  const client = await getSheetsClient();
  const valuesRes = await client.spreadsheets.values.get({
    spreadsheetId: PRODUCTION_PLAN_SHEET_ID,
    range: `'Forecast'!A1:V5000`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = (valuesRes.data.values ?? []) as string[][];
  // Serverseitig auf die gewuenschte HF-Woche filtern (Spalte A) -- Forecast
  // waechst ueber viele Wochen hinweg, das komplette Tab clientseitig zu
  // parsen waere unnoetig langsam.
  return rows.filter(r => (r[0] ?? "").trim() === hfWeek);
}

async function fetchRecipeProfilRows(): Promise<string[][]> {
  const client = await getSheetsClient();
  const valuesRes = await client.spreadsheets.values.get({
    spreadsheetId: PRODUCTION_PLAN_SHEET_ID,
    range: `'Recipe Profil'!A1:M5000`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return (valuesRes.data.values ?? []) as string[][];
}

// ─── Transparency Plan (Google Sheets, Service Account) ────────────────────
// Separates Sheet ("F_VE Transparency Plan"), unabhaengig vom Production-Plan-
// Sheet oben: Live-Wiegungen (Raw/Pre-/Post-Blast) je Work Order/Subrezept,
// Status durch die Stationen (Staging -> Kitchen -> Post), Bedarf/RTI-Bestand,
// plus Logistik-/Ausfuehrungs-Tabs. Ein generisches Tab-Registry + eine Route
// statt eines Endpoints pro Tab, weil hier deutlich mehr Tabs relevant sind
// als bei Production Plan/Forecast/Recipe Profil oben.
const TRANSPARENCY_SHEET_ID = "1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY";

const TRANSPARENCY_TAB_REGISTRY: Record<string, { title: string; range: string }> = {
  "planning-check": { title: "Planning Check", range: "A1:U120" },
  "total-overview": { title: "Transperancy Total Overview", range: "A1:BF4200" },
  "importrange-weights": { title: "Importrange Weights", range: "A1:R23000" },
  rtem: { title: "RTEM", range: "A1:R1800" },
  forecast: { title: "[Import] Forecast", range: "A1:X1200" },
  "wms-wo": { title: "WMS WO", range: "A1:N1200" },
  et: { title: "ET", range: "A1:O1200" },
  "input-kitchen": { title: "Input Kitchen ", range: "A1:Z1200" },
  ku: { title: "KU", range: "A1:AC250" },
  "ku-week": { title: "KU Week", range: "A1:T120" },
  "sleeving-output": { title: "🍱 Sleeving - Output", range: "A1:J150" },
  "sleeving-requirements": { title: "🍱 Sleeving - Requirements", range: "A1:T150" },
  "printing-output": { title: "🖨️ Printing - Output", range: "A1:H220" },
  "printing-requirements": { title: "🖨️ Printing - Requirements", range: "A1:K260" },
  "benl-outbound": { title: "🚚 BENL Outbound", range: "A1:Z100" },
  "printing-overview": { title: "Printing Overview", range: "A1:Z1200" },
  "plating-execution": { title: "Plating Excecution Tracking", range: "A1:U1200" },
  "counting-plating-holding": { title: "Counting Plating Holding", range: "A1:H1200" },
  "kitchen-kpis": { title: "Kitchen KPIs", range: "A1:Z1200" },
  "issue-tracker": { title: "Issue Tracker", range: "A1:F1200" },
  "eaches-conversion": { title: "Eaches Converstion", range: "A1:B1200" },
  "manual-check": { title: "Manual Check", range: "A1:H120" },
  "all-shortages": { title: "All shortages W24", range: "A1:F1200" },
  "analysis-eli": { title: "Analysis Eli", range: "A1:BC1200" },
  "stock-recount": { title: "Stock Re-Count", range: "A1:I120" },
  sheet82: { title: "Sheet82", range: "A1:Z1200" },
  sheet93: { title: "Sheet93", range: "A1:P1200" },
  "sum-of-all-recipes": { title: "Sum of all recipes", range: "A1:I1200" },
  "calculation-gewicht": { title: "Calculation Gewicht per Workorder ", range: "A1:G1200" },
  "input-plating-sleeving": { title: "Input Plating/Sleeving", range: "A1:F1200" },
  "post-blast-wms": { title: "Post Blast WMS", range: "A1:Z1200" },
  "kitchen-wms": { title: "Kitchen WMS", range: "A1:Z1200" },
  "blast-overview": { title: "Blast Overview", range: "A1:R1200" },
  "all-recipes": { title: "All recipes", range: "A1:AI38300" },
};

async function fetchTransparencyTabRows(key: string): Promise<string[][]> {
  const cfg = TRANSPARENCY_TAB_REGISTRY[key];
  if (!cfg) throw new Error(`Unbekannter Transparency-Tab-Key: ${key}`);
  const client = await getSheetsClient();
  const valuesRes = await client.spreadsheets.values.get({
    spreadsheetId: TRANSPARENCY_SHEET_ID,
    range: `'${cfg.title.replace(/'/g, "''")}'!${cfg.range}`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return (valuesRes.data.values ?? []) as string[][];
}

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
  AND (LOCATION_ID ILIKE 'PLATING-LINE%' OR LOCATION_ID ILIKE 'PLSTG%')
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
  AND ACTUAL_QTY > 0
ORDER BY LOCATION_ID, ITEM_NUMBER
LIMIT ?`;

const WMS_PLH_MOVEMENTS_SQL = `
SELECT
    CASE WHEN LOCATION_ID_2 ILIKE 'PLH%' THEN LOCATION_ID ELSE LOCATION_ID_2 END AS COUNTERPART_LOC,
    CASE WHEN LOCATION_ID_2 ILIKE 'PLH%' THEN 'IN' ELSE 'OUT' END AS DIRECTION,
    CASE WHEN LOCATION_ID ILIKE 'PLH%' THEN LOCATION_ID ELSE LOCATION_ID_2 END AS PLH_LOC,
    TRAN_TYPE,
    DESCRIPTION,
    ITEM_NUMBER,
    TRAN_QTY,
    LOT_NUMBER,
    HU_ID,
    COALESCE(END_TRAN_DATE, START_TRAN_DATE) AS TRAN_DATE,
    WEEKOFYEAR(COALESCE(END_TRAN_DATE, START_TRAN_DATE)) AS KW,
    EMPLOYEE_ID
FROM US_OPS_ANALYTICS.HIGHJUMP.T_TRAN_LOG
WHERE WH_ID = ?
  AND (LOCATION_ID ILIKE 'PLH%' OR LOCATION_ID_2 ILIKE 'PLH%')
  AND COALESCE(END_TRAN_DATE, START_TRAN_DATE) >= TO_TIMESTAMP_NTZ(?)
  AND COALESCE(END_TRAN_DATE, START_TRAN_DATE) < TO_TIMESTAMP_NTZ(?)
ORDER BY TRAN_DATE DESC
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
  AND (LOCATION_ID ILIKE '%POSTB%' OR LOCATION_ID ILIKE '%POST-BLAST%')
  AND DB_CHANGE_COMMIT_TIME >= TO_TIMESTAMP_NTZ(?)
  AND DB_CHANGE_COMMIT_TIME < TO_TIMESTAMP_NTZ(?)
ORDER BY LOCATION_ID, ITEM_NUMBER
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
WHERE "wh_id" = ? AND ("wo_number" LIKE ? OR "wo_number" LIKE ? OR "wo_number" LIKE ?)
ORDER BY "wo_number", "meal_item_number"
LIMIT ?`;

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

type WmsPlhMovementRow = {
  counterpartLoc: string;
  direction: "IN" | "OUT";
  plhLoc: string;
  tranType: string;
  description: string;
  itemNumber: string;
  tranQty: number | null;
  lotNumber: string;
  huId: string;
  tranDate: string | null;
  kw: number | null;
  employeeId: string;
};

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

type WmsWorkordersRow = {
  woNumber: string;
  week: string;
  submealItemNumber: string;
  submealItemDescription: string;
  mealItemNumber: string;
  mealItemDescription: string;
  quantity: number | null;
  uom: string;
  plates: number | null;
  targetPerPlate: number | null;
  preBlastQuantity: number | null;
  preBlastLocation: string;
  status: string;
  expirationDate: string | null;
  productionTime: string | null;
  lastUpdated: string | null;
};

type WmsWoDetailRow = {
  woNumber: string;
  tranType: string;
  description: string;
  itemNumber: string;
  tranQty: number | null;
  lotNumber: string;
  locationId: string;
  locationId2: string;
  huId: string;
  startTranDate: string | null;
  endTranDate: string | null;
  employeeId: string;
};

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
  const weekLabel = `${toolYear}-W${String(toolWeek).padStart(2, "0")}`;
  // "KW"/HF-Woche ist app-weit als (echte ISO-Woche + 1) definiert, siehe
  // currentHfWeekLocal()/currentHfWeek() — die Kalendertage von HF-Woche N
  // sind also die von echter ISO-Woche (N-1). Nur so bilden startDate/endDate
  // die tatsächlichen Kalendertage der eingegebenen KW ab.
  const weekStart = isoWeekStart(toolYear, toolWeek);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7);
  return {
    toolWeek: weekLabel,
    wmsWeek: weekLabel,
    startDate: weekStart.toISOString().slice(0, 10),
    endDate: weekEnd.toISOString().slice(0, 10),
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
        if (err) reject(err); else resolve((rows ?? []) as Record<string, unknown>[]);
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

function mapPlhMovementRow(row: Record<string, unknown>): WmsPlhMovementRow {
  return {
    counterpartLoc: stringValue(row, "COUNTERPART_LOC"),
    direction: stringValue(row, "DIRECTION") as "IN" | "OUT",
    plhLoc: stringValue(row, "PLH_LOC"),
    tranType: stringValue(row, "TRAN_TYPE"),
    description: stringValue(row, "DESCRIPTION"),
    itemNumber: stringValue(row, "ITEM_NUMBER"),
    tranQty: numberValue(row, "TRAN_QTY"),
    lotNumber: stringValue(row, "LOT_NUMBER"),
    huId: stringValue(row, "HU_ID"),
    tranDate: dateValue(row, "TRAN_DATE"),
    kw: numberValue(row, "KW"),
    employeeId: stringValue(row, "EMPLOYEE_ID"),
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

function mapWmsWorkordersRow(row: Record<string, unknown>): WmsWorkordersRow {
  return {
    woNumber: stringValue(row, "wo_number"),
    week: stringValue(row, "week"),
    submealItemNumber: stringValue(row, "submeal_item_number"),
    submealItemDescription: stringValue(row, "submeal_item_desctiption"),
    mealItemNumber: stringValue(row, "meal_item_number"),
    mealItemDescription: stringValue(row, "meal_item_descrption"),
    quantity: numberValue(row, "quantity"),
    uom: stringValue(row, "uom"),
    plates: numberValue(row, "plates"),
    targetPerPlate: numberValue(row, "target_per_plate"),
    preBlastQuantity: numberValue(row, "pre_blast_quantity"),
    preBlastLocation: stringValue(row, "preblast_location"),
    status: stringValue(row, "status"),
    expirationDate: dateValue(row, "expiration_date"),
    productionTime: dateValue(row, "production_time"),
    lastUpdated: dateValue(row, "last_updated"),
  };
}

function mapWmsWoDetailRow(row: Record<string, unknown>): WmsWoDetailRow {
  return {
    woNumber: stringValue(row, "WO_NUMBER"),
    tranType: stringValue(row, "TRAN_TYPE"),
    description: stringValue(row, "DESCRIPTION"),
    itemNumber: stringValue(row, "ITEM_NUMBER"),
    tranQty: numberValue(row, "TRAN_QTY"),
    lotNumber: stringValue(row, "LOT_NUMBER"),
    locationId: stringValue(row, "LOCATION_ID"),
    locationId2: stringValue(row, "LOCATION_ID_2"),
    huId: stringValue(row, "HU_ID"),
    startTranDate: dateValue(row, "START_TRAN_DATE"),
    endTranDate: dateValue(row, "END_TRAN_DATE"),
    employeeId: stringValue(row, "EMPLOYEE_ID"),
  };
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

  if (url.pathname === "/wms-plating-holding" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    const requestedLimit = Number(url.searchParams.get("limit") ?? 25000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50000, Math.max(1, Math.round(requestedLimit)))
      : 25000;

    try {
      const conn = await ensureConnection();
      console.log(`WMS Plating Holding Query startet: WH_ID=${whId}, LIMIT=${limit} (kein Date-Filter — aktueller Bestand)`);
      const rows = await executeQuery(conn, WMS_PLATING_HOLDING_SQL, [whId, limit]);
      sendJson(res, 200, {
        ok: true,
        whId,
        week,
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

  if (url.pathname === "/wms-plh-detail" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    const range = wmsRangeForToolWeek(week);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 25000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(50000, Math.max(1, Math.round(requestedLimit)))
      : 25000;

    try {
      const conn = await ensureConnection();
      console.log(`WMS PLH Detail Query startet: WH_ID=${whId}, RANGE=${range.startDate}..${range.endDate}, LIMIT=${limit}`);
      const [stockRows, movementRows] = await Promise.all([
        executeQuery(conn, WMS_PLATING_HOLDING_SQL, [whId, limit]),
        executeQuery(conn, WMS_PLH_MOVEMENTS_SQL, [whId, range.startDate, range.endDate, limit]),
      ]);
      const movements = movementRows.map(mapPlhMovementRow);
      const summary = {
        totalPutaway: movements.filter(m => m.direction === "IN" && m.tranType === "212").reduce((s, m) => s + Math.abs(m.tranQty ?? 0), 0),
        totalPicked: movements.filter(m => m.direction === "OUT" && ["203", "204"].includes(m.tranType)).reduce((s, m) => s + Math.abs(m.tranQty ?? 0), 0),
        totalLost: movements.filter(m => ["023", "026"].includes(m.tranType)).reduce((s, m) => s + Math.abs(m.tranQty ?? 0), 0),
        cycleCountDelta: movements.filter(m => m.tranType === "800").reduce((s, m) => s + (m.tranQty ?? 0), 0),
        activeSkus: new Set(movements.map(m => m.itemNumber)).size,
        activeLocations: new Set(movements.map(m => m.plhLoc)).size,
      };
      sendJson(res, 200, {
        ok: true,
        whId,
        week: range.toolWeek,
        rangeStart: range.startDate,
        rangeEnd: range.endDate,
        generatedAt: new Date().toISOString(),
        stock: stockRows.map(mapWmsPlatingRow),
        movements,
        summary,
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

  if (url.pathname === "/wms-workorders" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    // Three patterns like Cloud Function: plain week ("34-%"), year+week ("202634-%"), exact year+week ("202634")
    const mWeek = week.match(/^(\d{4})-W(\d{2})$/);
    const kwNum = mWeek ? String(Number(mWeek[2])) : week.replace(/^\d{4}-W0?/, "");
    const yearWeekCode = mWeek ? `${mWeek[1]}${kwNum.padStart(2, "0")}` : `2026${kwNum.padStart(2, "0")}`;
    const woPatterns = [`${kwNum}-%`, `${yearWeekCode}-%`, `${yearWeekCode}`];
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100000, Math.max(1, Math.round(requestedLimit)))
      : 50000;

    try {
      const conn = await ensureConnection();
      console.log(`WMS Workorders Query startet: WH_ID=${whId}, WO_PATTERNS=${JSON.stringify(woPatterns)} (HF-Week=${week}), LIMIT=${limit}`);
      const rows = await executeQuery(conn, WMS_WORKORDERS_SQL, [whId, ...woPatterns, limit]);
      const mappedRows = rows.map(mapWmsWorkordersRow);
      console.log(`WMS Workorders: ${mappedRows.length} Zeilen für WO-Patterns ${JSON.stringify(woPatterns)}`);
      sendJson(res, 200, {
        ok: true,
        whId,
        week,
        woPatterns,
        limit,
        generatedAt: new Date().toISOString(),
        rows: mappedRows,
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

  if (url.pathname === "/wms-wo-detail" && req.method === "GET") {
    const whId = url.searchParams.get("whId")?.trim() || "VF";
    const week = url.searchParams.get("week")?.trim() || currentHfWeek();
    const range = wmsRangeForToolWeek(week);
    const woFilter = url.searchParams.get("wo")?.trim() || "";
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100000, Math.max(1, Math.round(requestedLimit)))
      : 50000;

    // WO numbers use HF-Week prefix (e.g. 32-xxx for HF-Week 32), not ISO week
    const hfWeekNum = week.replace(/^\d{4}-W0?/, "");
    const controlPattern = woFilter || `${hfWeekNum}-%`;

    try {
      const conn = await ensureConnection();
      console.log(`WMS WO-Detail Query startet: WH_ID=${whId}, PATTERN=${controlPattern}, RANGE=${range.startDate}..${range.endDate}, LIMIT=${limit}`);
      const rows = await executeQuery(conn, WMS_WO_DETAIL_SQL, [whId, controlPattern, range.startDate, range.endDate, limit]);
      sendJson(res, 200, {
        ok: true,
        whId,
        week: range.toolWeek,
        wmsWeek: range.wmsWeek,
        controlPattern,
        rangeStart: range.startDate,
        rangeEnd: range.endDate,
        limit,
        generatedAt: new Date().toISOString(),
        rows: rows.map(mapWmsWoDetailRow),
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

  // ─── Redzone Live Plating Status (Factor Verden) ──────────────────────────
  if (url.pathname === "/redzone-plating-status" && req.method === "GET") {
    const lookbackHours = Number(url.searchParams.get("hours") ?? 24);
    const hours = Number.isFinite(lookbackHours) ? Math.min(168, Math.max(1, lookbackHours)) : 24;

    const REDZONE_SQL = `
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
      AND "startTime" >= DATEADD(hour, -${hours}, CURRENT_TIMESTAMP())
      ORDER BY "startTime" DESC
      LIMIT 500`;

    try {
      const conn = await ensureConnection();
      console.log(`Redzone Plating Status: lookback=${hours}h`);
      const rows = await executeQuery(conn, REDZONE_SQL, []);
      const mapped = rows.map((row) => ({
        areaName: stringValue(row, "areaName"),
        locationName: stringValue(row, "locationName"),
        productTypeName: stringValue(row, "productTypeName"),
        productTypeSKU: stringValue(row, "productTypeSKU"),
        outCount: numberValue(row, "outCount"),
        inCount: numberValue(row, "inCount"),
        startTime: dateValue(row, "startTime"),
        endTime: dateValue(row, "endTime"),
        runName: stringValue(row, "runName"),
      }));
      sendJson(res, 200, {
        ok: true,
        enterprise: "Factor Verden",
        lookbackHours: hours,
        generatedAt: new Date().toISOString(),
        rows: mapped,
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

  // ─── Production Plan (Google Sheets, Service Account) ────────────────────
  if (url.pathname === "/production-plan-weeks" && req.method === "GET") {
    try {
      const weeks = await fetchProductionPlanWeekTabs();
      sendJson(res, 200, { ok: true, weeks, currentHfWeek: currentHfWeek(), sheetId: PRODUCTION_PLAN_SHEET_ID, generatedAt: new Date().toISOString() });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/production-plan" && req.method === "GET") {
    const gid = url.searchParams.get("gid")?.trim() || "";
    if (!gid) { sendJson(res, 400, { ok: false, error: "gid fehlt" }); return; }

    try {
      console.log(`Production Plan Query startet: gid=${gid}`);
      const rows = await fetchProductionPlanRows(gid);
      sendJson(res, 200, { ok: true, gid, generatedAt: new Date().toISOString(), rows });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/forecast" && req.method === "GET") {
    const week = url.searchParams.get("week")?.trim() || "";
    if (!week) { sendJson(res, 400, { ok: false, error: "week fehlt" }); return; }
    try {
      const rows = await fetchForecastRows(week);
      sendJson(res, 200, { ok: true, week, generatedAt: new Date().toISOString(), rows });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/recipe-profil" && req.method === "GET") {
    try {
      const rows = await fetchRecipeProfilRows();
      sendJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), rows });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === "/transparency-sheet" && req.method === "GET") {
    const tab = url.searchParams.get("tab")?.trim() || "";
    if (!tab) { sendJson(res, 400, { ok: false, error: "tab fehlt" }); return; }
    try {
      const rows = await fetchTransparencyTabRows(tab);
      sendJson(res, 200, { ok: true, tab, generatedAt: new Date().toISOString(), rows });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: "query-not-configured",
    detail: "Verfuegbar: GET /health, GET /connect, GET /wms-plating, /wms-staging, /wms-debox, /wms-postblast, /wms-sleeving, /wms-inbound, /wms-workorders, /wms-wo-detail, /wms-plating-history, /redzone-plating-status, /production-plan, /production-plan-weeks, /forecast, /recipe-profil, /transparency-sheet?tab=...",
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Snowflake Local Server laeuft auf http://127.0.0.1:${PORT}`);
  console.log("Endpoints: GET /health, GET /connect, GET /wms-plating?week=YYYY-Www&whId=VF&limit=25000, GET /wms-plating-history?week=YYYY-Www&whId=VF&limit=25000&lookbackDays=28, GET /wms-sleeving?week=YYYY-Www&whId=VF&limit=25000, GET /wms-inbound?week=YYYY-Www&whId=VF&limit=25000, GET /wms-staging?week=YYYY-Www&whId=VF&limit=25000, GET /wms-debox?week=YYYY-Www&whId=VF&limit=25000, GET /wms-postblast?week=YYYY-Www&whId=VF&limit=25000, GET /production-plan?gid=..., GET /production-plan-weeks, GET /forecast?week=YYYY-Www..., GET /recipe-profil, GET /transparency-sheet?tab=planning-check|total-overview|importrange-weights|rtem|forecast|...");
});

server.on("error", (err) => {
  console.error("Server-Fehler:", err);
  process.exit(1);
});
