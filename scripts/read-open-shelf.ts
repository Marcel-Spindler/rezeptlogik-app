import { google } from "googleapis";
import type { ShelfLifeInfo } from "../src/core/types.ts";

const DEFAULT_OPEN_SHELF_GSHEET_ID = "1dET5WmRKYRhmzEmhlBv1ZpRo5huWgNLfIY6uaLpCrcc";
const DEFAULT_OPEN_SHELF_TAB = "ALL in 1";
const CUSTOMER_MIN_DAYS = 7;

function parseLeadingNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/\d+/);
  if (!match) return undefined;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

function computeStatus(mlorDays?: number, openShelfLifeDays?: number): ShelfLifeInfo["status"] {
  const checks = [mlorDays, openShelfLifeDays].filter((v): v is number => typeof v === "number");
  if (checks.length === 0) return "unknown";
  if (checks.some(v => v < CUSTOMER_MIN_DAYS)) return "critical";
  if (checks.some(v => v < CUSTOMER_MIN_DAYS + 3)) return "risk";
  return "ok";
}

export async function readOpenShelfLifeSheet(): Promise<Record<string, ShelfLifeInfo>> {
  const spreadsheetId = process.env.OPEN_SHELF_GSHEET_ID ?? DEFAULT_OPEN_SHELF_GSHEET_ID;
  const tab = process.env.OPEN_SHELF_GSHEET_TAB ?? DEFAULT_OPEN_SHELF_TAB;

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A3:O9999`
    });
    const rows = res.data.values ?? [];
    const out: Record<string, ShelfLifeInfo> = {};
    for (const row of rows) {
      const skuCode = (row[2] || "").toString().trim();
      if (!skuCode) continue;
      const totalShelfLifeRaw = (row[9] || "").toString().trim() || undefined;
      const mlorRaw = (row[10] || "").toString().trim() || undefined;
      const openShelfLifeRaw = (row[11] || "").toString().trim() || undefined;
      const totalShelfLifeDays = parseLeadingNumber(totalShelfLifeRaw);
      const mlorDays = parseLeadingNumber(mlorRaw);
      const openShelfLifeDays = parseLeadingNumber(openShelfLifeRaw);
      out[skuCode] = {
        skuCode,
        skuName: (row[0] || "").toString().trim(),
        category: (row[1] || "").toString().trim() || undefined,
        subCategory: (row[3] || "").toString().trim() || undefined,
        tempCategory: (row[8] || "").toString().trim() || undefined,
        totalShelfLifeRaw,
        totalShelfLifeDays,
        mlorRaw,
        mlorDays,
        openShelfLifeRaw,
        openShelfLifeDays,
        customerMinDays: CUSTOMER_MIN_DAYS,
        mlorVsCustomerGapDays: typeof mlorDays === "number" ? mlorDays - CUSTOMER_MIN_DAYS : undefined,
        openVsCustomerGapDays: typeof openShelfLifeDays === "number" ? openShelfLifeDays - CUSTOMER_MIN_DAYS : undefined,
        status: computeStatus(mlorDays, openShelfLifeDays)
      };
    }
    console.log(`  Open Shelf Life: ${Object.keys(out).length} SKU-Zeilen importiert`);
    return out;
  } catch (e: any) {
    console.warn(`  Open-Shelf-Sheet konnte nicht gelesen werden: ${e?.message ?? e}`);
    return {};
  }
}