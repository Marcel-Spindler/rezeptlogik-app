// Liest die beiden CSV-Dateien und pusht sie nach Firestore (additiv, wie der Browser-Import).
// Usage: tsx scripts/push-csv-firestore.ts <recipes.csv> <detailed.csv>
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import admin from "firebase-admin";
import Papa from "papaparse";
import { configureFirestoreWriterAuth } from "./lib/firestore-auth.ts";

// ─── CSV-Parser (identisch zu src/lib/csv-parser.ts, aber ohne Browser-APIs) ──

function parseCsv(text: string): Record<string, string>[] {
  const res = Papa.parse<Record<string, string>>(
    text.replace(/^\uFEFF/, ""),
    { header: true, skipEmptyLines: true }
  );
  return res.data;
}

function num(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

type Market = "BENL" | "DKSE" | "DE";

function detectMarket(fullName: string): Market | null {
  if (/\[BNL\]|\[BENL\]/i.test(fullName)) return "BENL";
  if (/\[DKSE\]|\[NORD\]/i.test(fullName)) return "DKSE";
  if (/\[DE\]/i.test(fullName)) return "DE";
  if (/\s(BNL|BENL)\s*$/i.test(fullName)) return "BENL";
  if (/\s(DKSE|NORD)\s*$/i.test(fullName)) return "DKSE";
  if (/\sDE\s*$/i.test(fullName)) return "DE";
  return null;
}

function detectDetailedMarket(fullName: string): Market | null {
  if (/\[BNL\]/i.test(fullName) || /\[BENL\]/i.test(fullName)) return "BENL";
  if (/\[DKSE\]/i.test(fullName) || /\[NORD\]/i.test(fullName)) return "DKSE";
  if (/\[DE\]/i.test(fullName)) return "DE";
  return null;
}

function parseCode(fullName: string): { code: string; base: string } {
  const m = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s*-\s*(.+?)(?:\s*\[(?:BNL|BENL|DE|DKSE|NORD)\])?\s*$/.exec(fullName);
  if (m) return { code: m[1], base: m[2].trim() };
  const suffix = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s+(.+?)\s+(?:BNL|BENL|DE|DKSE|NORD)\s*$/i.exec(fullName);
  if (suffix) return { code: suffix[1], base: suffix[2].trim() };
  const plain = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s+(.+?)\s*$/.exec(fullName);
  if (plain) return { code: plain[1], base: plain[2].trim() };
  return { code: fullName, base: fullName };
}

// ─── Parse recipes CSV ────────────────────────────────────────────────────────

function parseRecipesCsv(text: string): Record<string, any> {
  const recipes: Record<string, any> = {};
  const rows = parseCsv(text);

  for (const row of rows) {
    const fullName = row["Recipe name"] ?? "";
    const { code, base } = parseCode(fullName);
    if (!code) continue;
    const market = detectMarket(fullName);
    if (!market) continue;

    if (!recipes[code]) {
      recipes[code] = { code, baseName: base, markets: {}, grossIngredients: {} };
    }
    const rec = recipes[code];
    let md = rec.markets[market];
    if (!md) {
      md = {
        market,
        msku: row["MSKU Code"] ?? "",
        recipeNameLocal: fullName,
        recipeYield: num(row["Recipe Yield"]) || undefined,
        recipeYieldUom: row["Recipe Yield UOM"] || undefined,
        allergens: row["Allergen Contains"] || undefined,
        primaryPackagingSku: row["Primary Packaging Sku Code"] || undefined,
        compartmentName: row["Compartment Name"] || undefined,
        secondaryPackagingSkus: row["Secondary Packaging Sku Codes"] || undefined,
        subRecipes: [],
        ingredients: [],
      };
      rec.markets[market] = md;
    }

    const subId = row["Sub-Recipe ID"] || "";
    const subName = row["Ingredient Name"] || "";
    if (subId && !md.subRecipes.find((s: any) => s.id === subId)) {
      md.subRecipes.push({
        id: subId,
        name: subName,
        category: row["Sub-Recipe Categories"] || "",
        yield: num(row["Sub-Recipe Yield"]) || undefined,
        yieldUom: row["Recipe Yield UOM"] || undefined,
        instructions: row["Instructions"] || undefined,
        methodColor: row["Method Color"] || undefined,
        methodType: row["Method Type"] || undefined,
      });
    }
    md.ingredients.push({
      name: subName,
      ingredientId: row["Ingredient ID"] || "",
      ingredientCategory: row["Ingredient Type"] || undefined,
      type: row["Ingredient Type"] || undefined,
      subRecipeId: subId || undefined,
      subRecipeName: subName || undefined,
      quantityPerPortion: num(row["Ingredient Quantity"]),
      uom: row["Ingredient UOM"] || "",
      preparation: row["Preparation"] || undefined,
    });
  }

  return recipes;
}

// ─── Parse detailed CSV ───────────────────────────────────────────────────────

function buildSubTree(rows: Record<string, string>[], level: number): any[] {
  if (level > 4 || rows.length === 0) return [];
  const idCol   = `Sub-Recipe ${level} ID`;
  const nameCol = `Sub-Recipe ${level} Name`;
  const catCol  = `Sub-Recipe ${level} Recipe Categories`;
  const qtyCol  = `Sub-Recipe ${level} Quantity`;
  const uomCol  = `Sub-Recipe ${level} UOM`;

  const byId = new Map<string, Record<string, string>[]>();
  for (const row of rows) {
    const id = (row[idCol] ?? "").trim();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(row);
  }

  const nodes: any[] = [];
  for (const [id, subRows] of byId) {
    const first = subRows[0];
    const nextIdCol = `Sub-Recipe ${level + 1} ID`;
    const deeper = level < 4 ? subRows.filter(r => (r[nextIdCol] ?? "").trim() !== "") : [];
    const leaves = subRows.filter(r => level >= 4 || (r[nextIdCol] ?? "").trim() === "");

    const node: any = {
      id,
      name: (first[nameCol] ?? "").trim(),
      categories: (first[catCol] ?? "").trim(),
      quantity: num(first[qtyCol]) || undefined,
      uom: (first[uomCol] ?? "").trim() || undefined,
      subRecipes: deeper.length > 0 ? buildSubTree(deeper, level + 1) : [],
      ingredients: [],
    };

    const seen = new Set<string>();
    for (const r of leaves) {
      const ingName = (r["Ingredient"] ?? "").trim();
      const ingId   = (r["Ingredient ID"] ?? "").trim();
      if (!ingName) continue;
      const key = `${ingId}|${ingName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      node.ingredients.push({
        id: ingId,
        name: ingName,
        grossQty: num(r["Gross Ingredient Qty"]),
        netQty:   num(r["Net Ingredient Qty"]),
        uom:      (r["Ingredient UOM"] ?? "").trim(),
        allergen: (r["Ingredient Allergen Type"] ?? "").trim() || undefined,
        yieldPct: num(r["Sub-Recipe Yield %"]) || undefined,
      });
    }
    nodes.push(node);
  }
  return nodes;
}

function parseDetailedCsv(text: string) {
  const rows = parseCsv(text);
  const grouped = new Map<string, Map<Market, { recipeId: string; name: string; rows: Record<string, string>[] }>>();

  for (const row of rows) {
    const fullName = (row["Recipe Name"] ?? "").trim();
    if (!fullName) continue;
    const { code, base } = parseCode(fullName);
    if (!code) continue;
    const market = detectDetailedMarket(fullName);
    const markets: Market[] = market ? [market] : ["BENL", "DKSE", "DE"];
    const recipeId = (row["Recipe ID"] ?? "").trim();
    const groupKey = market ? code : base.toLowerCase().trim();

    if (!grouped.has(groupKey)) grouped.set(groupKey, new Map());
    const mMap = grouped.get(groupKey)!;
    for (const m of markets) {
      if (!mMap.has(m)) mMap.set(m, { recipeId, name: base, rows: [] });
      mMap.get(m)!.rows.push(row);
    }
  }

  const structures: Record<string, any> = {};
  for (const [groupKey, mMap] of grouped) {
    const first = [...mMap.values()][0];
    const docKey = groupKey.replace(/\//g, "_");
    const struct: any = { code: docKey, recipeId: first.recipeId, name: first.name, markets: {} };
    for (const [market, { rows: mRows }] of mMap) {
      struct.markets[market] = buildSubTree(mRows, 1);
    }
    structures[docKey] = struct;
  }

  // Gross-Ingredients
  const grossByCode: Record<string, Partial<Record<Market, any[]>>> = {};
  for (const row of rows) {
    const fullName = (row["Recipe Name"] ?? "").trim();
    if (!fullName) continue;
    const { code } = parseCode(fullName);
    if (!code || !/^[A-Z]{2}\d{4}[A-Z0-9]+$/.test(code)) continue;
    const market = detectDetailedMarket(fullName) ?? "BENL";
    if (!grossByCode[code]) grossByCode[code] = {};
    const arr = (grossByCode[code][market] ??= []);
    const ingredientId = row["Ingredient ID"] || "";
    const catMatch = ingredientId.match(/^([A-Z]{2,4})-/);
    arr.push({
      subRecipe1: row["Sub-Recipe 1 Name"] || undefined,
      subRecipe2: row["Sub-Recipe 2 Name"] || undefined,
      subRecipe3: row["Sub-Recipe 3 Name"] || undefined,
      ingredient: row["Ingredient"] || "",
      ingredientId,
      ingredientCategory: catMatch ? catMatch[1] : undefined,
      grossQuantityPerPortion: num(row["Gross Ingredient Qty"]),
      uom: row["Ingredient UOM"] || "",
    });
  }

  return { structures, grossByCode };
}

function mergeGrossIntoRecipes(recipes: Record<string, any>, grossByCode: Record<string, any>) {
  for (const [code, byMarket] of Object.entries(grossByCode)) {
    if (!recipes[code]) continue;
    for (const [market, arr] of Object.entries(byMarket)) {
      if (arr) recipes[code].grossIngredients[market] = arr;
    }
  }
}

// ─── Strip undefined (Firestore Admin SDK erlaubt keine undefined-Werte) ─────

function stripUndefined(obj: any): any {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  if (typeof obj === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out;
  }
  return obj;
}

// ─── Firestore Push (additiv, 400er Chunks) ──────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: tsx scripts/push-csv-firestore.ts <recipes.csv> <detailed.csv>");
    process.exit(1);
  }
  const [recipesPath, detailedPath] = args.map(a => resolve(a));

  console.log("Lese CSVs…");
  const recipesText = readFileSync(recipesPath, "utf8");
  const detailedText = readFileSync(detailedPath, "utf8");

  console.log("Parsing export-recipes CSV…");
  const recipes = parseRecipesCsv(recipesText);
  console.log(`  ${Object.keys(recipes).length} Rezept-Codes gelesen`);

  console.log("Parsing Detailed-CSV (Zutaten, Yield)…");
  const { structures, grossByCode } = parseDetailedCsv(detailedText);
  console.log(`  ${Object.keys(structures).length} Strukturen gelesen`);

  mergeGrossIntoRecipes(recipes, grossByCode);
  console.log("  Gross-Ingredients eingemischt");

  // Firebase Admin Init
  configureFirestoreWriterAuth();
  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();
  const APP_ROOT = db.collection("apps").doc("rezeptlogik");

  async function batchWrite(collName: string, entries: [string, any][]) {
    const coll = APP_ROOT.collection(collName);
    const CHUNK = 400;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const batch = db.batch();
      for (const [id, data] of entries.slice(i, i + CHUNK)) {
        batch.set(coll.doc(id), stripUndefined(data), { merge: true });
      }
      await batch.commit();
      console.log(`  ${collName}: ${Math.min(i + CHUNK, entries.length)}/${entries.length}`);
    }
  }

  const recipeEntries = Object.entries(recipes);
  if (recipeEntries.length > 0) {
    console.log(`Schreibe ${recipeEntries.length} Rezepte nach Firestore…`);
    await batchWrite("recipes", recipeEntries);
  }

  const structEntries = Object.entries(structures);
  if (structEntries.length > 0) {
    console.log(`Schreibe ${structEntries.length} Strukturen nach Firestore…`);
    await batchWrite("structures", structEntries);
  }

  console.log("✓ Firestore aktualisiert");
}

main().catch(e => { console.error(e); process.exit(1); });
