import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.resolve(process.env.LOCAL_DB_PATH ?? path.join(root, "local-db", "rezeptlogik.sqlite"));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

function readJson(relativePath, fallback = null) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function json(value) {
  return JSON.stringify(value ?? null);
}

const data = readJson("public/data/data.json", {});
const mealCatalogPayload = readJson("public/data/meal-catalog.json", {});
const wmsCache = readJson("public/data/wms-cache.json", {});

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS database_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_records (
    collection TEXT NOT NULL,
    record_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, record_key)
  );
  CREATE INDEX IF NOT EXISTS idx_app_records_collection ON app_records(collection);
  CREATE TABLE IF NOT EXISTS source_files (
    path TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    content_type TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const existingInstructions = new Map(
  db.prepare("SELECT record_key, payload FROM app_records WHERE collection = 'instructions'")
    .all()
    .map((row) => [row.record_key, JSON.parse(row.payload)]),
);

const now = new Date().toISOString();
const upsertRecord = db.prepare(`
  INSERT INTO app_records (collection, record_key, payload, source, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(collection, record_key) DO UPDATE SET
    payload = excluded.payload,
    source = excluded.source,
    updated_at = excluded.updated_at
`);
const clearCollection = db.prepare("DELETE FROM app_records WHERE collection = ?");

function replaceCollection(collection, entries, source, keyOf) {
  clearCollection.run(collection);
  for (const [index, entry] of entries.entries()) {
    const key = keyOf(entry, index);
    if (key) upsertRecord.run(collection, String(key), json(entry), source, now);
  }
}

function replaceSingle(collection, key, value, source) {
  if (value !== undefined) upsertRecord.run(collection, key, json(value), source, now);
}

function parseKg(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "TBD" || text.startsWith("#")) return null;
  const number = Number(text.replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseEquipmentBibleDump(dump) {
  const output = [];
  for (const sheet of dump?.sheets ?? []) {
    const values = Array.isArray(sheet.values) ? sheet.values : [];
    const title = String(sheet.title ?? "");
    if (title.includes("BRAISER")) {
      for (let index = 5; index < values.length; index++) {
        const row = values[index] ?? [];
        const maxKg = parseKg(row[4]);
        if (row[2] && row[3] && maxKg) output.push({ source: "BRAISER", category: String(row[2]).trim(), itemName: String(row[3]).trim(), maxKg });
      }
    } else if (title.includes("MIDDLE-KITCHEN")) {
      let machine = "";
      for (let index = 5; index < values.length; index++) {
        const row = values[index] ?? [];
        if (row[1]) machine = String(row[1]).trim();
        const itemName = String(row[2] ?? "").trim();
        const maxKg = parseKg(row[3]);
        if (itemName.toUpperCase().includes("PORTIONING") || itemName.toUpperCase().includes("SCOOP")) break;
        if (machine && itemName && maxKg) output.push({ source: "MIDDLE_KITCHEN", category: machine, itemName, maxKg });
      }
    } else if (title.includes("VEGGIE-DEBOX")) {
      for (let index = 13; index < values.length; index++) {
        const row = values[index] ?? [];
        const maxKg = parseKg(row[4]);
        if (row[1] && row[2] && maxKg) output.push({ source: "VEGGIE_DEBOX", category: String(row[1]).trim(), itemName: String(row[2]).trim(), maxKg });
      }
    }
  }
  return output;
}

function loadKetCsv(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (header) => header.trim() });
  return parsed.data.map((row, index) => {
    const recipeName = String(row["Recipe Name"] ?? "").trim();
    const recipeCode = recipeName.match(/^([A-Z]{2}\d{4}[A-Z0-9]+)/)?.[1] ?? "";
    const targetPortions = Number.parseFloat(String(row["Target Portions"] ?? "")) || 0;
    const dateNeeded = String(row["Date Needed"] ?? "").trim();
    return {
      run: 0,
      kitchenDay: dateNeeded,
      workOrder: String(row["Work Order Number"] ?? "").trim(),
      recipeId: String(row["Recipe ID"] ?? "").trim(),
      recipeCode,
      recipeName,
      subRecipe: String(row["Sub Recipe Name"] ?? "").trim(),
      plannedMeals: targetPortions,
      targetPortions,
      woCookedPortions: Number.parseFloat(String(row["WO Cooked Portions"] ?? "")) || undefined,
      cookedPortionsExcess: Number.parseFloat(String(row["Cooked Portions Excess"] ?? "")) || undefined,
      stagingKg: 0,
      kitchenKg: 0,
      postKg: 0,
      yieldPct: 0,
      cookMethods: String(row["Cook Methods"] ?? "").trim(),
      stagingStatus: String(row["Staging Status"] ?? "").trim(),
      stagingComment: String(row["Staging Comment"] ?? "").trim(),
      kitchenStatus: String(row["Kitchen Status"] ?? "").trim(),
      unlockedEta: String(row["Unlocked ETA"] ?? "").trim(),
      workOrderComment: String(row["Work Order Comment"] ?? "").trim(),
      sourceRow: index,
    };
  }).filter((row) => row.workOrder && row.recipeCode);
}

function loadInstructionRecords() {
  const records = new Map();
  for (const [recipeCode, recipe] of Object.entries(data.recipes ?? {})) {
    for (const [market, marketDetails] of Object.entries(recipe.markets ?? {})) {
      for (const subRecipe of marketDetails?.subRecipes ?? []) {
        const english = String(subRecipe.instructions ?? "").trim();
        if (!english) continue;
        const key = `${recipeCode}::${subRecipe.id || subRecipe.name}`;
        const existing = records.get(key);
        const translated = existingInstructions.get(key);
        records.set(key, {
          key,
          recipeCode,
          subRecipeId: subRecipe.id || "",
          subRecipeName: subRecipe.name,
          market,
          english: existing?.english || english,
          german: translated?.german || existing?.german || String(subRecipe.instructionsDE ?? "").trim(),
          translationStatus: translated?.translationStatus || existing?.translationStatus || (subRecipe.instructionsDE ? "source" : "needs_translation"),
          source: "public/data/data.json",
        });
      }
    }
  }
  return [...records.values()];
}

clearCollection.run("bundle");
replaceSingle("bundle", "meta", {
  generatedAt: data.generatedAt ?? now,
  weeks: data.weeks ?? [],
}, "public/data/data.json");

const bundleCollections = [
  "weekRecipes", "cookSchedules", "processSpecs", "shelfLifeBySku", "productionPlan",
  "printOrders", "kitchenPriority", "kitchenPlanning", "equipmentBible", "planningCalendar",
  "weeklyYield", "weightGoals", "produktionsplanung", "maitreRampup",
];
for (const collection of bundleCollections) {
  replaceSingle("bundle", collection, data[collection], "public/data/data.json");
}
replaceCollection("recipes", Object.values(data.recipes ?? {}), "public/data/data.json", (entry) => entry.code);
replaceCollection("structures", Object.values(data.structures ?? {}), "public/data/data.json", (entry) => entry.code);
const instructionRecords = loadInstructionRecords();
replaceCollection("instructions", instructionRecords, "public/data/data.json", (entry) => entry.key);
replaceCollection("weekRecipes", data.weekRecipes ?? [], "public/data/data.json", (entry, index) => `${entry.hfWeek ?? ""}::${entry.code ?? index}`);
replaceCollection("productionPlan", data.productionPlan?.rows ?? [], "public/data/data.json", (entry, index) => `${entry.kitchenDay ?? ""}::${entry.workOrder ?? index}::${entry.recipeCode ?? ""}::${entry.subRecipe ?? ""}`);

const mealCatalog = mealCatalogPayload.mealCatalog ?? data.mealCatalog ?? {};
replaceSingle("bundle", "mealCatalog", mealCatalog, "public/data/meal-catalog.json");
replaceCollection("mealCatalog", Object.values(mealCatalog), "public/data/meal-catalog.json", (entry) => entry.mealId);
replaceCollection("wmsCache", wmsCache.rows ?? [], "public/data/wms-cache.json", (entry, index) => `${entry.woNumber ?? index}::${entry.submealItemNumber ?? ""}`);

const ketCandidates = [
  process.env.KET_CSV_PATH,
  path.join(root, "imports", "KET-Verden-2026-W34 (2).csv"),
  path.join(process.env.USERPROFILE ?? "", "Downloads", "KET-Verden-2026-W34.csv"),
].filter(Boolean);
const ketPath = ketCandidates.find((candidate) => fs.existsSync(candidate));
const ketRows = loadKetCsv(ketPath);
if (ketRows.length) {
  const week = ketPath.match(/W(\d{2})/i)?.[1] ?? "";
  // Merge KET CSV rows INTO the existing production plan (data.json) rather than
  // replacing it. The KET CSV has no kg columns (postKg/kitchenKg/stagingKg are 0)
  // so we enrich KET rows from the existing plan where a matching WO exists.
  // Additionally, data.json rows for OTHER weeks are preserved so the plan covers
  // all available weeks, not just the one KET week.
  const existingRows = data.productionPlan?.rows ?? [];
  const planByWo = new Map();
  for (const r of existingRows) {
    if (r.workOrder) planByWo.set(r.workOrder, r);
  }
  const enrichedKetRows = ketRows.map((row) => {
    const existing = planByWo.get(row.workOrder);
    if (!existing) return row;
    return {
      ...row,
      stagingKg: existing.stagingKg ?? row.stagingKg,
      kitchenKg: existing.kitchenKg ?? row.kitchenKg,
      postKg: existing.postKg ?? row.postKg,
      yieldPct: existing.yieldPct ?? row.yieldPct,
      plannedMeals: existing.plannedMeals || row.plannedMeals,
    };
  });
  // Combine: enriched KET rows + data.json rows whose WO is NOT in the KET set
  const ketWoSet = new Set(ketRows.map((r) => r.workOrder));
  const combinedRows = [...enrichedKetRows, ...existingRows.filter((r) => !ketWoSet.has(r.workOrder))];
  const planWeek = data.productionPlan?.week || `2026-W${week}`;
  replaceSingle("bundle", "productionPlan", { week: planWeek, generatedAt: now, rows: combinedRows }, ketPath);
  replaceCollection("productionPlan", combinedRows, ketPath, (entry, index) => `${entry.kitchenDay}::${entry.workOrder}::${entry.recipeCode}::${entry.subRecipe}::${index}`);
}

const biblePath = path.join(root, "public", "data", "gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json");
const bibleDump = readJson("public/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json", null);
const equipmentBible = parseEquipmentBibleDump(bibleDump);
if (equipmentBible.length) {
  replaceSingle("bundle", "equipmentBible", equipmentBible, biblePath);
  replaceCollection("equipmentBible", equipmentBible, biblePath, (entry, index) => `${entry.source}::${entry.category}::${entry.itemName}::${index}`);
}

const sourceFiles = [
  "public/data/data.json",
  "public/data/meal-catalog.json",
  "public/data/wms-cache.json",
  "public/data/weekly-planning.json",
  "public/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json",
];
if (ketPath) sourceFiles.push(path.relative(root, ketPath));
const upsertFile = db.prepare(`
  INSERT INTO source_files (path, content, content_type, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET
    content = excluded.content,
    content_type = excluded.content_type,
    updated_at = excluded.updated_at
`);
for (const relativePath of sourceFiles) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) continue;
  const content = fs.readFileSync(filePath, "utf8");
  const contentType = relativePath.endsWith(".csv") ? "text/csv" : "application/json";
  upsertFile.run(relativePath, content, contentType, now);
}

const setMeta = db.prepare(`
  INSERT INTO database_meta (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
setMeta.run("schemaVersion", "1");
setMeta.run("generatedAt", now);
setMeta.run("sourceDataGeneratedAt", String(data.generatedAt ?? ""));
setMeta.run("recordCount", String(db.prepare("SELECT COUNT(*) AS count FROM app_records").get().count));

db.close();
console.log(`Lokale Rezeptlogik-Datenbank erstellt: ${dbPath}`);
console.log(`Quelle: ${data.generatedAt ?? "unbekannt"}`);
