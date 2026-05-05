import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { google } from "googleapis";

const SHEET_ID = process.env.GSHEET_ID?.trim();
if (!SHEET_ID) {
  console.error("GSHEET_ID fehlt (.env.local/.env)");
  process.exit(1);
}

const DRY_RUN = (process.env.WMS_PUSH_DRY_RUN ?? "true").toLowerCase() !== "false";
const MIN_WEEK = parseInt(process.env.WMS_MIN_WEEK?.trim() || "202619", 10);

type TxRow = Record<string, string>;

type ProductAgg = {
  pos: number;
  neg: number;
  net: number;
  trans: number;
};

type AreaAgg = {
  pos: number;
  neg: number;
  net: number;
};

type WeekAgg = {
  trans: number;
  pos: number;
  neg: number;
  net: number;
  products: Map<string, ProductAgg>;
  areas: Map<string, AreaAgg>;
};

function resolveTransactionLogPath(): string {
  const configured = process.env.WMS_TRANSACTION_LOG_PATH?.trim();
  if (configured && existsSync(configured)) return configured;

  const candidates = [
    resolve("WMS Wahrheit", "Transaction_Log.xlsx"),
    "C:\\WMS Wahrheit\\Transaction_Log.xlsx",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

function toFloat(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeWeek(v: string | undefined): string {
  if (!v) return "";
  const s = String(v).trim();
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function formatKwTitle(week: string): string {
  const year = week.slice(0, 4);
  const kw = parseInt(week.slice(4), 10);
  return `KW ${kw} / ${year}`;
}

function categoryForArea(area: string): string {
  const a = area.toLowerCase();
  const prep = ["preb", "prep", "plating", "post", "sleeving", "deboxwip", "platingwip"];
  const fulfil = ["fab", "fac", "pack", "slip", "vf-", "plh-", "psh-", "vegg"];
  const lager = ["lager", "storage", "ambient", "chilled", "frozen", "pick", "slot", "stgdr"];

  if (prep.some(k => a.includes(k))) return "Prep/Plating";
  if (fulfil.some(k => a.includes(k))) return "Fulfillment";
  if (lager.some(k => a.includes(k))) return "Lager";
  return "Andere";
}

/** reads workbook using existing python helper and maps headers->row object */
function loadRows(filePath: string): TxRow[] {
  const helperScript = resolve("scripts", "_read_tx_log.py");
  const raw = execFileSync("python", [helperScript, filePath], {
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });

  const parsed = JSON.parse(raw) as { headers: string[]; rows: string[][] };
  const headers = parsed.headers ?? [];
  return (parsed.rows ?? []).map((row) => {
    const obj: TxRow = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i] ?? "";
    return obj;
  });
}

function aggregateByWeek(rows: TxRow[]): Map<string, WeekAgg> {
  const map = new Map<string, WeekAgg>();

  for (const r of rows) {
    const week = normalizeWeek(r["Week"]);
    if (!week) continue;
    const weekNum = parseInt(week, 10);
    if (!Number.isFinite(weekNum) || weekNum < MIN_WEEK) continue;

    const item = (r["Item Desc"] || "").trim() || "(Unbekannt)";
    const area = (r["Location Id"] || "").trim() || "(Ohne Bereich)";
    const qtyRaw = toFloat(r["Tran Qty"]);
    const qty = Math.abs(qtyRaw);

    if (!map.has(week)) {
      map.set(week, {
        trans: 0,
        pos: 0,
        neg: 0,
        net: 0,
        products: new Map<string, ProductAgg>(),
        areas: new Map<string, AreaAgg>(),
      });
    }

    const agg = map.get(week)!;
    agg.trans += 1;

    const isPositive = qtyRaw >= 0;
    if (isPositive) agg.pos += qty;
    else agg.neg += qty;
    agg.net += qtyRaw;

    if (!agg.products.has(item)) {
      agg.products.set(item, { pos: 0, neg: 0, net: 0, trans: 0 });
    }
    const pa = agg.products.get(item)!;
    pa.trans += 1;
    if (isPositive) pa.pos += qty;
    else pa.neg += qty;
    pa.net += qtyRaw;

    if (!agg.areas.has(area)) {
      agg.areas.set(area, { pos: 0, neg: 0, net: 0 });
    }
    const aa = agg.areas.get(area)!;
    if (isPositive) aa.pos += qty;
    else aa.neg += qty;
    aa.net += qtyRaw;
  }

  return map;
}

function makeReportRows(week: string, agg: WeekAgg): string[][] {
  const rows: string[][] = [];
  const title = `${formatKwTitle(week)} — WMS Vollanalyse Report`;
  rows.push([title]);
  rows.push([]);

  const posNegRatio = agg.neg === 0 ? "n/a" : (agg.pos / agg.neg).toFixed(4);
  const avgNetPerTx = agg.trans === 0 ? 0 : agg.net / agg.trans;
  const avgAbsPerTx = agg.trans === 0 ? 0 : (agg.pos + agg.neg) / agg.trans;

  rows.push(["ÜBERSICHT"]);
  rows.push(["KPI", "Wert"]);
  rows.push(["Transaktionen", String(agg.trans)]);
  rows.push(["Zugänge (kg)", agg.pos.toFixed(2)]);
  rows.push(["Bewegungen (kg)", agg.neg.toFixed(2)]);
  rows.push(["Netto (kg)", agg.net.toFixed(2)]);
  rows.push(["Produkte (gesamt)", String(agg.products.size)]);
  rows.push(["Bereiche (gesamt)", String(agg.areas.size)]);
  rows.push(["Pos/Neg Verhältnis", posNegRatio]);
  rows.push(["Ø Netto je Transaktion (kg)", avgNetPerTx.toFixed(4)]);
  rows.push(["Ø Absolute Menge je Transaktion (kg)", avgAbsPerTx.toFixed(4)]);
  rows.push([]);

  const categoryTotals = new Map<string, { pos: number; neg: number; net: number; count: number }>();
  for (const [area, a] of agg.areas.entries()) {
    const cat = categoryForArea(area);
    if (!categoryTotals.has(cat)) categoryTotals.set(cat, { pos: 0, neg: 0, net: 0, count: 0 });
    const c = categoryTotals.get(cat)!;
    c.pos += a.pos;
    c.neg += a.neg;
    c.net += a.net;
    c.count += 1;
  }

  rows.push(["KATEGORIEN (BEREICHE)"]);
  rows.push(["Kategorie", "Bereiche_Anzahl", "Zugänge_kg", "Bewegungen_kg", "Netto_kg"]);
  for (const cat of ["Prep/Plating", "Fulfillment", "Lager", "Andere"]) {
    const c = categoryTotals.get(cat) ?? { pos: 0, neg: 0, net: 0, count: 0 };
    rows.push([cat, String(c.count), c.pos.toFixed(2), c.neg.toFixed(2), c.net.toFixed(2)]);
  }
  rows.push([]);

  const allProducts = [...agg.products.entries()]
    .sort((a, b) => Math.abs(b[1].net) - Math.abs(a[1].net));

  rows.push(["ALLE PRODUKTE (sortiert nach |Netto|)"]);
  rows.push(["Produkt", "Zugänge_kg", "Bewegungen_kg", "Netto_kg", "Transaktionen"]);
  for (const [name, p] of allProducts) {
    rows.push([name, p.pos.toFixed(2), p.neg.toFixed(2), p.net.toFixed(2), String(p.trans)]);
  }
  rows.push([]);

  const allAreas = [...agg.areas.entries()]
    .sort((a, b) => Math.abs(b[1].net) - Math.abs(a[1].net));

  rows.push(["ALLE BEREICHE (sortiert nach |Netto|)"]);
  rows.push(["Bereich", "Kategorie", "Zugänge_kg", "Bewegungen_kg", "Netto_kg"]);
  for (const [area, a] of allAreas) {
    rows.push([area, categoryForArea(area), a.pos.toFixed(2), a.neg.toFixed(2), a.net.toFixed(2)]);
  }

  return rows;
}

async function main() {
  const txPath = resolveTransactionLogPath();
  console.log(`Lese Transaction Log: ${txPath}`);
  const rows = loadRows(txPath);
  const weekAgg = aggregateByWeek(rows);

  const weeks = [...weekAgg.keys()].sort();
  if (weeks.length === 0) {
    console.log(`Keine KWs >= ${MIN_WEEK} gefunden.`);
    return;
  }

  if (DRY_RUN) {
    console.log(`Gefundene KWs (ab ${MIN_WEEK}): ${weeks.join(", ")}`);
    console.log("\n[DRY-RUN] Folgende Report-Tabs würden erstellt/aktualisiert:");
    for (const w of weeks) {
      const tab = `KW${parseInt(w.slice(4), 10)}_Report`;
      console.log(`  → ${tab}`);
    }
    console.log("\nSetze WMS_PUSH_DRY_RUN=false zum echten Ausführen.");
    return;
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: "sheets.properties",
  });

  const existingTabs = new Map<string, number>();
  for (const s of meta.data.sheets ?? []) {
    const t = s.properties?.title;
    const id = s.properties?.sheetId;
    if (t && typeof id === "number") existingTabs.set(t, id);
  }

  for (const w of weeks) {
    const tab = `KW${parseInt(w.slice(4), 10)}_Report`;
    const values = makeReportRows(w, weekAgg.get(w)!);

    if (!existingTabs.has(tab)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          requests: [{
            addSheet: { properties: { title: tab } },
          }],
        },
      });
      console.log(`✓ Tab '${tab}' neu angelegt`);
    } else {
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `'${tab}'!A:Z`,
      });
      console.log(`↻ Tab '${tab}' aktualisiert`);
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${tab}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values },
    });

    console.log(`  Report geschrieben: '${tab}'`);
  }

  console.log(`\n✓ Fertig. ${weeks.length} KW-Report-Tabs synchronisiert.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
