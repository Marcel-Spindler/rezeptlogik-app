// ═══════════════════════════════════════════════════════════════════════════
//  import-sub-recipes.ts — Rezeptstrukturen aus CSV → Firestore
//
//  Legt alle Dokumente in  apps/rezeptlogik/structures/{code}  an.
//  Läuft einmalig (npm run import:sub-recipes) oder als Watcher im Dev-
//  Server (npm run dev), der automatisch neu importiert sobald eine CSV in
//  SOURCE_DIR abgelegt wird.
//
//  ZWEI CSV-FORMATE WERDEN UNTERSTÜTZT — beide können gleichzeitig vorliegen:
//
//  ┌─ FORMAT A  export-recipes*.csv  ──────────────────────────────────────┐
//  │  Wöchentlicher Export aus dem HelloFresh Recipe Tool.                 │
//  │  Wird jede Woche neu gezogen und in imports/ abgelegt.                │
//  │  Enthält: FV-Code (z.B. FV0024A), Markt-Marker [BNL/DE/DKSE],       │
//  │           Sub-Recipe-ID + Name, Menge, UOM — eine Ebene tief.        │
//  │  → Primärquelle für die StructureTab-Anzeige (Kochschritte/Mengen).  │
//  │  → Firestore-Key = FV-Code (z.B. "FV0024A").                         │
//  └───────────────────────────────────────────────────────────────────────┘
//
//  ┌─ FORMAT B  export-sub-recipes-by-recipe-detailed*.csv  ───────────────┐
//  │  Optionaler Tiefenexport — wird seltener aktualisiert.                │
//  │  Kein FV-Code, kein Markt-Marker — plain Rezeptname.                 │
//  │  Enthält: bis zu 4 Sub-Recipe-Ebenen, Einzelzutaten mit Gross/Net-   │
//  │           Menge, Allergen, Yield% je Sub-Recipe.                      │
//  │  → Aktiviert Engpass-Tab, Yield-Rechner, Ingredienten-Übersicht.     │
//  │  → Firestore-Key = normalisierter Rezeptname (z.B. "bacon chicken"). │
//  └───────────────────────────────────────────────────────────────────────┘
//
//  Wenn beide vorhanden: Format B wird zuerst geladen (name-keyed),
//  Format A überschreibt/ergänzt mit FV-Code als Schlüssel.
//  Mehrere CSVs je Format ((1), (2), W23, W24 …) werden zusammengeführt.
// ═══════════════════════════════════════════════════════════════════════════

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Papa from "papaparse";
import admin from "firebase-admin";
import type { Market, RecipeStructure, DetailedSubRecipe, DetailedIngredient } from "../src/types.ts";

// ─── Source directory ─────────────────────────────────────────────────────

const COOK_CSV = "Cook Schedules Per DC - Cook Shifts per DC.csv";

function resolveSourceDir(): string {
  const configured = process.env.REZEPTLOGIK_SOURCE_DIR?.trim();
  if (configured) return configured;
  for (const dir of [resolve("imports"), "C:\\Rezeptlogik", resolve("Rezeptlogik")]) {
    if (!existsSync(dir)) continue;
    if (
      existsSync(join(dir, COOK_CSV)) ||
      existsSync(join(dir, "export-sub-recipes-by-recipe-detailed.csv")) ||
      readdirSync(dir).some(f => /^export-recipes.*\.csv$/i.test(f))
    ) return dir;
  }
  return resolve("imports");
}

const SOURCE_DIR = resolveSourceDir();

// ─── Helpers ─────────────────────────────────────────────────────────────

function readCsv<T = Record<string, string>>(path: string): T[] {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const res = Papa.parse<T>(text, { header: true, skipEmptyLines: true });
  if (res.errors.length) console.warn(`CSV warnings ${path}:`, res.errors.slice(0, 3));
  return res.data as T[];
}

function numStr(v: string | undefined): number {
  if (!v || v.trim() === "") return 0;
  const n = parseFloat(v.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function parseRecipeCode(full: string): { code: string; base: string } {
  // "FV0024A - Chicken in tomato cream sauce [BNL]" → code=FV0024A, base=Chicken in tomato cream sauce
  const m = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s*[-\s]\s*(.+?)(?:\s*\[(?:BNL|BENL|DE|DKSE|NORD)\])?\s*$/.exec(full);
  if (m) return { code: m[1], base: m[2].trim() };
  return { code: full, base: full };
}

function parseMarket(fullName: string): Market | null {
  if (/\[BNL\]/i.test(fullName) || /\[BENL\]/i.test(fullName)) return "BENL";
  if (/\[DKSE\]/i.test(fullName) || /\[NORD\]/i.test(fullName)) return "DKSE";
  if (/\[DE\]/i.test(fullName)) return "DE";
  return null;
}

function findCsvs(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => pattern.test(f)).sort();
}

// ─── FORMAT A: export-recipes*.csv ────────────────────────────────────────
//  Wöchentlicher Export → StructureTab (Kochschritte, Sub-Recipes, Mengen).
//  Jede Zeile = ein Sub-Recipe (Typ S) oder Direkt-Zutat (Typ I) eines FV-Codes.
//  Ergebnis: RecipeStructure pro FV-Code, je Markt eine Liste von DetailedSubRecipe-Knoten.

function loadFromRecipesCsv(files: string[]): Record<string, RecipeStructure> {
  let allRows: Record<string, string>[] = [];
  for (const f of files) {
    const rows = readCsv<Record<string, string>>(join(SOURCE_DIR, f));
    console.log(`  ${f}: ${rows.length} Zeilen`);
    allRows = allRows.concat(rows);
  }

  // Key: "CODE|MARKET" → sub-recipe rows + direct ingredient rows
  const grouped = new Map<string, {
    code: string; base: string; recipeId: string; market: Market;
    subRows: Record<string, string>[]; ingRows: Record<string, string>[];
  }>();

  for (const row of allRows) {
    const fullName = (row["Recipe name"] ?? "").trim();
    if (!fullName) continue;
    const { code, base } = parseRecipeCode(fullName);
    const market = parseMarket(fullName);
    if (!market) continue;
    const type = (row["Ingredient Type"] ?? "").trim().toUpperCase();
    if (type !== "S" && type !== "I") continue;

    const key = `${code}|${market}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        code, base,
        recipeId: (row["MSKU Code"] ?? "").trim(),
        market, subRows: [], ingRows: [],
      });
    }
    const entry = grouped.get(key)!;
    if (type === "S") entry.subRows.push(row);
    else entry.ingRows.push(row);
  }

  const byCode = new Map<string, RecipeStructure>();

  for (const entry of grouped.values()) {
    const { code, base, recipeId, market, subRows, ingRows } = entry;

    if (!byCode.has(code)) byCode.set(code, { code, recipeId, name: base, markets: {} });
    const struct = byCode.get(code)!;

    const seen = new Set<string>();
    const nodes: DetailedSubRecipe[] = [];

    for (const row of subRows) {
      const id = (row["Sub-Recipe ID"] ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        id,
        name: (row["Ingredient Name"] ?? "").trim(),
        categories: (row["Sub-Recipe Categories"] ?? "").trim(),
        quantity: numStr(row["Ingredient Quantity"]) || undefined,
        uom: (row["Ingredient UOM"] ?? "").trim() || undefined,
        subRecipes: [],
        ingredients: [],
      });
    }

    if (ingRows.length > 0) {
      nodes.push({
        id: `${code}|direct`,
        name: "Direct Ingredients",
        categories: "",
        subRecipes: [],
        ingredients: ingRows.map(r => ({
          id:       (r["Ingredient ID"] ?? "").trim(),
          name:     (r["Ingredient Name"] ?? "").trim(),
          grossQty: numStr(r["Ingredient Quantity"]),
          netQty:   numStr(r["Ingredient Quantity"]),
          uom:      (r["Ingredient UOM"] ?? "").trim(),
          allergen: (r["Allergen Contains"] ?? "").trim() || undefined,
        } satisfies DetailedIngredient)),
      });
    }

    struct.markets[market] = nodes;
  }

  const result = Object.fromEntries(byCode);
  console.log(`  export-recipes: ${byCode.size} Rezepte (${grouped.size} Markt-Varianten)`);
  return result;
}

// ─── FORMAT B: export-sub-recipes-by-recipe-detailed*.csv ─────────────────
//  Tiefenexport → Engpass-Tab, Yield-Rechner, Ingredienten-Übersicht.
//  Enthält bis zu 4 Sub-Recipe-Ebenen + Einzelzutaten mit Allergen & Yield%.
//  Kein FV-Code vorhanden — Firestore-Key = normalisierter Rezeptname.

function buildSubTree(rows: Record<string, string>[], level: number): DetailedSubRecipe[] {
  if (level > 4 || rows.length === 0) return [];
  const idCol   = `Sub-Recipe ${level} ID`;
  const nameCol = `Sub-Recipe ${level} Name`;
  const catCol  = `Sub-Recipe ${level} Recipe Categories`;
  const qtyCol  = `Sub-Recipe ${level} Quantity`;
  const uomCol  = `Sub-Recipe ${level} UOM`;

  const byId = new Map<string, Record<string, string>[]>();
  const noSub: Record<string, string>[] = [];

  for (const row of rows) {
    const id = (row[idCol] ?? "").trim();
    if (!id) { noSub.push(row); continue; }
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(row);
  }

  const nodes: DetailedSubRecipe[] = [];

  for (const [id, subRows] of byId) {
    const first = subRows[0];
    const nextIdCol = `Sub-Recipe ${level + 1} ID`;
    const deeper = level < 4 ? subRows.filter(r => (r[nextIdCol] ?? "").trim() !== "") : [];
    const leaves = subRows.filter(r => level >= 4 || (r[nextIdCol] ?? "").trim() === "");

    const ingredients: DetailedIngredient[] = [];
    const seen = new Set<string>();
    for (const r of leaves) {
      const ingName = (r["Ingredient"] ?? "").trim();
      const ingId   = (r["Ingredient ID"] ?? "").trim();
      if (!ingName) continue;
      const k = `${ingId}|${ingName}`;
      if (seen.has(k)) continue;
      seen.add(k);
      ingredients.push({
        id: ingId, name: ingName,
        grossQty: numStr(r["Gross Ingredient Qty"]),
        netQty:   numStr(r["Net Ingredient Qty"]),
        uom:      (r["Ingredient UOM"] ?? "").trim(),
        allergen: (r["Ingredient Allergen Type"] ?? "").trim() || undefined,
        yieldPct: numStr(r["Sub-Recipe Yield %"]) || undefined,
      });
    }

    nodes.push({
      id,
      name:       (first[nameCol] ?? "").trim(),
      categories: (first[catCol] ?? "").trim(),
      quantity:   numStr(first[qtyCol]) || undefined,
      uom:        (first[uomCol] ?? "").trim() || undefined,
      subRecipes: deeper.length > 0 ? buildSubTree(deeper, level + 1) : [],
      ingredients,
    });
  }

  void noSub;
  return nodes;
}

function loadFromDetailedCsv(files: string[]): Record<string, RecipeStructure> {
  let allRows: Record<string, string>[] = [];
  for (const f of files) {
    const rows = readCsv<Record<string, string>>(join(SOURCE_DIR, f));
    console.log(`  ${f}: ${rows.length} Zeilen`);
    allRows = allRows.concat(rows);
  }

  const grouped = new Map<string, Map<Market, { recipeId: string; name: string; rows: Record<string, string>[] }>>();

  for (const row of allRows) {
    const fullName = (row["Recipe Name"] ?? "").trim();
    if (!fullName) continue;
    const { code, base } = parseRecipeCode(fullName);
    if (!code) continue;
    const market = parseMarket(fullName);
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

  const structures: Record<string, RecipeStructure> = {};
  for (const [groupKey, mMap] of grouped) {
    const first = [...mMap.values()][0];
    const docKey = groupKey.replace(/\//g, "_");
    const struct: RecipeStructure = { code: docKey, recipeId: first.recipeId, name: first.name, markets: {} };
    for (const [market, { rows }] of mMap) {
      struct.markets[market] = buildSubTree(rows, 1);
    }
    structures[docKey] = struct;
  }

  console.log(`  export-sub-recipes-detailed: ${Object.keys(structures).length} Rezepte`);
  return structures;
}

// ─── Main ─────────────────────────────────────────────────────────────────

function loadStructures(): Record<string, RecipeStructure> {
  const recipesCsvs  = findCsvs(SOURCE_DIR, /^export-recipes.*\.csv$/i);
  const detailedCsvs = findCsvs(SOURCE_DIR, /^export-sub-recipes-by-recipe-detailed.*\.csv$/i);

  if (recipesCsvs.length === 0 && detailedCsvs.length === 0) {
    console.error(`Keine 'export-recipes*.csv' oder 'export-sub-recipes-by-recipe-detailed*.csv' in ${SOURCE_DIR}`);
    process.exit(1);
  }

  // Format B (detailliert, mit Zutaten) zuerst laden, dann Format A (FV-Code) drüber mergen.
  // WICHTIG: Deep-Merge damit Format-B-Zutaten nicht von Format A überschrieben werden.
  // Strategie: Metadaten + fehlende Märkte aus A; für Märkte die B abdeckt → B bevorzugen (hat Zutaten).
  const detailed  = detailedCsvs.length > 0 ? loadFromDetailedCsv(detailedCsvs)  : {};
  const recipes   = recipesCsvs.length  > 0 ? loadFromRecipesCsv(recipesCsvs)    : {};

  const allCodes = new Set([...Object.keys(detailed), ...Object.keys(recipes)]);
  const merged: Record<string, RecipeStructure> = {};
  for (const code of allCodes) {
    const a = recipes[code];   // Format A: FV-Code, keine Zutaten
    const b = detailed[code];  // Format B: Zutaten vorhanden
    if (!a && b)  { merged[code] = b; continue; }
    if (a && !b)  { merged[code] = a; continue; }
    // Beide vorhanden: Metadaten + alle Märkte aus A; Märkte die B hat → B-Version (mit Zutaten)
    const markets = { ...a.markets };
    for (const [mkt, bData] of Object.entries(b.markets)) {
      markets[mkt] = bData;
    }
    merged[code] = { ...a, markets };
  }
  console.log(`  Gesamt: ${Object.keys(merged).length} Strukturen (${Object.keys(recipes).length} mit FV-Code, ${Object.keys(detailed).length} detailliert)`);
  return merged;
}

let db: admin.firestore.Firestore | null = null;

function initDb(): admin.firestore.Firestore {
  if (!db) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
  }
  return db;
}

async function pushToFirestore(structures: Record<string, RecipeStructure>) {
  const fs = initDb();
  const coll = fs.collection("apps").doc("rezeptlogik").collection("structures");

  const existing = await coll.listDocuments();
  if (existing.length > 0) {
    const CHUNK = 400;
    for (let i = 0; i < existing.length; i += CHUNK) {
      const batch = fs.batch();
      for (const ref of existing.slice(i, i + CHUNK)) batch.delete(ref);
      await batch.commit();
    }
    console.log(`  structures: ${existing.length} alte Docs gelöscht`);
  }

  const entries = Object.entries(structures);
  const CHUNK = 400;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const batch = fs.batch();
    for (const [code, s] of entries.slice(i, i + CHUNK)) {
      batch.set(coll.doc(code), s as any);
    }
    await batch.commit();
    console.log(`  structures: ${Math.min(i + CHUNK, entries.length)}/${entries.length}`);
  }

  console.log("✓ structures in Firestore aktualisiert");
}

function countIngredients(structures: Record<string, any>): number {
  let n = 0;
  for (const s of Object.values(structures)) {
    for (const mkt of Object.values(s.markets || {})) {
      if (Array.isArray(mkt)) mkt.forEach((sr: any) => { n += (sr.ingredients?.length ?? 0); if (sr.subRecipes) sr.subRecipes.forEach((c: any) => { n += (c.ingredients?.length ?? 0); }); });
    }
  }
  return n;
}

async function runImport() {
  const structures = loadStructures();

  // Update local public/data/data.json with structures and recipes
  const localDataPath = resolve("public", "data", "data.json");
  if (existsSync(localDataPath)) {
    try {
      const data = JSON.parse(readFileSync(localDataPath, "utf8"));
      const prevIngCount = countIngredients(data.structures || {});

      // Deep-Merge: bestehende Zutaten-Daten niemals überschreiben
      const existing: Record<string, any> = data.structures || {};
      for (const [code, s] of Object.entries(structures)) {
        const newS = s as any;
        if (!existing[code]) { existing[code] = newS; continue; }
        // Für jeden Markt: neue Version nur verwenden wenn sie MEHR Zutaten hat
        const mergedMarkets = { ...existing[code].markets };
        for (const [mkt, newMktData] of Object.entries(newS.markets)) {
          const oldData = mergedMarkets[mkt];
          const newIngCount = Array.isArray(newMktData)
            ? (newMktData as any[]).reduce((s: number, sr: any) => s + (sr.ingredients?.length ?? 0), 0)
            : 0;
          const oldIngCount = Array.isArray(oldData)
            ? (oldData as any[]).reduce((s: number, sr: any) => s + (sr.ingredients?.length ?? 0), 0)
            : 0;
          // Neue Daten nur übernehmen wenn sie besser oder gleich gut sind
          if (newIngCount >= oldIngCount) mergedMarkets[mkt] = newMktData;
        }
        existing[code] = { ...existing[code], ...newS, markets: mergedMarkets };
      }
      data.structures = existing;

      // Schutzsperre: niemals schreiben wenn Zutaten verloren gehen würden
      const newIngCount = countIngredients(data.structures);
      if (prevIngCount > 0 && newIngCount < prevIngCount) {
        console.warn(`⚠  Import würde Zutaten verlieren (${prevIngCount} → ${newIngCount}) — data.json wird NICHT überschrieben.`);
        return;
      }

      // If data.recipes is empty or missing, let's populate it from the structures
      if (!data.recipes || Object.keys(data.recipes).length === 0) {
        data.recipes = {};
      }
      for (const [code, s] of Object.entries(structures)) {
        if (!data.recipes[code]) {
          data.recipes[code] = {
            code,
            baseName: (s as any).name,
            markets: {},
            grossIngredients: {}
          };
        }
        // Populate markets if they don't exist
        for (const [market, subRecipes] of Object.entries((s as any).markets)) {
          if (!data.recipes[code].markets[market]) {
            const recipeId = (s as any).recipeId || "";
            data.recipes[code].markets[market] = {
              market,
              msku: recipeId,
              recipeNameLocal: (s as any).name,
              subRecipes: (subRecipes as any[]).map((sr: any) => ({
                id: sr.id,
                name: sr.name,
                category: sr.categories || ""
              })),
              ingredients: []
            };
          }
        }
      }

      writeFileSync(localDataPath, JSON.stringify(data));
      console.log(`✓ structures und Rezepte lokal in ${localDataPath} aktualisiert (${newIngCount} Zutaten)`);
    } catch (e) {
      console.error("Fehler beim Aktualisieren der lokalen data.json:", e);
    }
  }

  // Attempt pushing to Firestore, but don't fail if we have insufficient permissions locally
  try {
    await pushToFirestore(structures);
  } catch (err: any) {
    console.warn("Firestore-Push übersprungen oder fehlgeschlagen (normal im lokalen Modus):", err.message || err);
  }
}

function watchAndImport() {
  import("node:fs").then(({ watch }) => {
    console.log(`👁  Beobachte ${SOURCE_DIR} auf neue CSV-Dateien...`);

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const CSV_PAT = /^export-(recipes|sub-recipes-by-recipe-detailed).*\.csv$/i;

    // Initial import on start
    runImport().catch(console.error);

    watch(SOURCE_DIR, { persistent: true }, (event, filename) => {
      if (!filename || !CSV_PAT.test(filename)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.log(`\n📥 ${filename} erkannt (${event}) — starte Import...`);
        runImport().catch(console.error);
      }, 800);
    });
  });
}

const watchMode = process.argv.includes("--watch");

if (watchMode) {
  watchAndImport();
} else {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
