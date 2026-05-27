// Liest die *gleichen* Sheets/CSVs aus einem Google-Spreadsheet (live).
// Voraussetzung:
//   1) Service Account erstellt, JSON unter ./secrets/service-account.json
//   2) Sheet mit der Service-Account-Email als Viewer geteilt
//   3) .env: GSHEET_ID=<id>
//
// Primäre Quelle fuer zu produzierende Meals ist Ramp-up (z.B. Tab "_Import_ Convini Order Sheet").
// Ein altes Tab "Meal Selection" wird weiterhin als Fallback unterstuetzt.
// WICHTIG: PO-Abschnitte (z.B. MAITRE) werden bewusst NICHT als Meal-Quelle verwendet.
// Die 3 Recipe-/Gross-Exporte und Cook Schedules werden weiterhin lokal aus C:\Rezeptlogik
// gelesen (das sind separate Exporte).
//
// Output: public/data/data.json (gleiches Format wie import-local.ts)

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" }); loadEnv();   // .env.local hat Vorrang, .env als Fallback
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { google } from "googleapis";
import Papa from "papaparse";
import type {
  DataBundle, Market, WeekRecipe, Recipe, GrossIngredient, CookSchedule,
  ProductionPlan, WorkOrderEntry, PrintOrderRow, KitchenPriorityRow,
  ProduktionsplanungEntry, ProduktionsplanungSlot
} from "../src/types.ts";
import { readPfei } from "./import-pfei.ts";
import { readOpenShelfLifeSheet } from "./read-open-shelf.ts";

// Wiederverwenden: importiere die Loader aus import-local NICHT direkt (zyklus); kopieren würde Logik dupliziertn.
// Stattdessen: die Funktionen sind klein genug, hier neu für Sheet aufzubauen.

const COOK_CSV = "Cook Schedules Per DC - Cook Shifts per DC.csv";

function resolveSourceDir(): string {
  const configured = process.env.REZEPTLOGIK_SOURCE_DIR?.trim();
  if (configured) return configured;

  // Priorität: ./imports (im Projektordner) → C:\Rezeptlogik → ./Rezeptlogik
  const candidates = [
    resolve("imports"),
    "C:\\Rezeptlogik",
    resolve("Rezeptlogik"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, COOK_CSV))) return candidate;
  }

  return candidates[0];
}

const SOURCE_DIR = resolveSourceDir();
const OUT_DIR = resolve("public", "data");
const OUT_FILE = join(OUT_DIR, "data.json");

// Mehrere Sheets möglich: GSHEET_ID (primär) + GSHEET_IDS (kommagetrennt).
// Reihenfolge = Priorität (spätere Sheets überschreiben dieselbe hfWeek+code-Kombi nicht).
const SHEET_IDS = [
  process.env.GSHEET_ID ?? "",
  ...(process.env.GSHEET_IDS ?? "").split(",")
].map(s => s.trim()).filter(Boolean);

if (SHEET_IDS.length === 0) {
  console.error("GSHEET_ID/GSHEET_IDS nicht in .env.local gesetzt");
  process.exit(1);
}
const RECIPE_CSVS: Record<Market, string> = {
  BENL: "export-recipes (1).csv",
  DE:   "export-recipes (2).csv",
  DKSE: "export-recipes (3).csv"
};
const GROSS_CSVS: Record<Market, string> = {
  BENL: "export-gross-ingredients-and-sub-recipes-by-recipe (1).csv",
  DE:   "export-gross-ingredients-and-sub-recipes-by-recipe (2).csv",
  DKSE: "export-gross-ingredients-and-sub-recipes-by-recipe (3).csv"
};

function num(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
function readCsv<T = Record<string, string>>(path: string): T[] {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  return Papa.parse<T>(text, { header: true, skipEmptyLines: true }).data as T[];
}
function parseRecipeName(full: string): { code: string; base: string } {
  const m = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s*-\s*(.+?)(?:\s*\[(?:BNL|BENL|DE|DKSE|NORD)\])?\s*$/.exec(full);
  if (m) return { code: m[1], base: m[2].trim() };
  return { code: full, base: full };
}

async function readMealSelectionFromGSheet(): Promise<{ weekRecipes: WeekRecipe[]; weeks: string[] }> {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  const out = new Map<string, WeekRecipe>();
  const weekSet = new Set<string>();

  const keyOf = (hfWeek: string, code: string) => `${hfWeek}__${code}`;

  const upsertWeekRecipe = (patch: Partial<WeekRecipe> & { hfWeek: string; code: string }): boolean => {
    const hfWeek = patch.hfWeek?.trim();
    const code = patch.code?.trim();
    if (!hfWeek || !code || !/^\d{4}-W\d{2}$/.test(hfWeek)) return false;

    const k = keyOf(hfWeek, code);
    const existedBefore = out.has(k);
    const existing = out.get(k) ?? {
      hfWeek,
      weekShort: hfWeek.slice(5),
      code,
      recipeName: "",
      preference: "",
      slot: {},
      verdenVolume: { BENL: 0, DKSE: 0, DE: 0 },
      totalVerdenVolume: 0,
      productionBuffer: 0,
    };

    const next: WeekRecipe = {
      ...existing,
      weekShort: patch.weekShort ?? existing.weekShort,
      recipeName: patch.recipeName || existing.recipeName,
      preference: patch.preference || existing.preference,
      productionBuffer: patch.productionBuffer ?? existing.productionBuffer,
      slot: {
        BENL: patch.slot?.BENL ?? existing.slot.BENL,
        DKSE: patch.slot?.DKSE ?? existing.slot.DKSE,
        DE: patch.slot?.DE ?? existing.slot.DE,
      },
      verdenVolume: {
        BENL: patch.verdenVolume?.BENL ?? existing.verdenVolume.BENL,
        DKSE: patch.verdenVolume?.DKSE ?? existing.verdenVolume.DKSE,
        DE: patch.verdenVolume?.DE ?? existing.verdenVolume.DE,
      },
      totalVerdenVolume: patch.totalVerdenVolume ?? existing.totalVerdenVolume,
    };

    if (!patch.totalVerdenVolume) {
      next.totalVerdenVolume = next.verdenVolume.BENL + next.verdenVolume.DKSE + next.verdenVolume.DE;
    }

    out.set(k, next);
    weekSet.add(hfWeek);
    return !existedBefore;
  };

  const extractHfWeekFromTitle = (title: string): string | undefined => {
    const direct = /(20\d{2})[-_ ]?W(\d{1,2})/i.exec(title);
    if (direct) return `${direct[1]}-W${String(parseInt(direct[2], 10)).padStart(2, "0")}`;
    const kw = /KW\s*(\d{1,2})/i.exec(title);
    if (kw) {
      const year = process.env.GSHEET_HF_YEAR?.trim() || String(new Date().getFullYear());
      return `${year}-W${String(parseInt(kw[1], 10)).padStart(2, "0")}`;
    }
    const w = /^W(\d{1,2})$/i.exec(title.trim());
    if (w) {
      const year = process.env.GSHEET_HF_YEAR?.trim() || String(new Date().getFullYear());
      return `${year}-W${String(parseInt(w[1], 10)).padStart(2, "0")}`;
    }
    return undefined;
  };

  const parseLegacyMealSelectionRows = (rows: any[][]): number => {
    let added = 0;
    for (const row of rows) {
      const hfWeek = (row[0] || "").toString().trim();
      const code = (row[1] || "").toString().trim();
      const verdenAbsBENL = num(row[18]);
      const verdenAbsNORD = num(row[19]);
      const verdenAbsDE = num(row[20]);
      const ok = upsertWeekRecipe({
        hfWeek,
        weekShort: hfWeek.slice(5),
        code,
        recipeName: (row[3] || "").toString(),
        preference: (row[2] || "").toString(),
        slot: { BENL: num(row[5]) || undefined, DKSE: num(row[6]) || undefined, DE: num(row[7]) || undefined },
        verdenVolume: { BENL: verdenAbsBENL, DKSE: verdenAbsNORD, DE: verdenAbsDE },
        totalVerdenVolume: num(row[21]) || (verdenAbsBENL + verdenAbsNORD + verdenAbsDE),
        productionBuffer: num(row[23])
      });
      if (ok) added++;
    }
    return added;
  };

  const parseRampUpConviniRows = (rows: any[][]): number => {
    let added = 0;
    let inAllMarkets = false;

    for (const raw of rows) {
      const row = raw.map((c: unknown) => (c ?? "").toString().trim());
      const c0 = row[0] || "";
      const c1 = row[1] || "";
      const c3 = row[3] || "";
      const code = row[8] || "";

      // Start: header of production meals (Ramp-up table).
      if (!inAllMarkets && c0 === "All Markets" && c1 === "week.value" && code === "recipe code") {
        inAllMarkets = true;
        continue;
      }

      if (!inAllMarkets) continue;

      // End of meal section: PO blocks below are supplier logistics (e.g. MAITRE) and must be ignored.
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
        weekShort: (row[2] || hfWeek.slice(5)).toString(),
        code,
        recipeName: "",
        preference: "",
        slot: {
          BENL: slotVal || undefined,
          DKSE: slotVal || undefined,
          DE: slotVal || undefined
        },
        verdenVolume: { BENL: bnl, DKSE: nord, DE: de },
        totalVerdenVolume: bnl + nord + de,
        productionBuffer: 0
      });
      if (ok) added++;
    }
    return added;
  };

  const parseMskuInputRows = (rows: any[][], hfWeek: string): number => {
    if (!rows.length) return 0;
    const header = rows[0].map((c: unknown) => (c ?? "").toString().trim().toLowerCase());
    const recipeIdx = header.findIndex(h => h === "recipe name" || h.includes("recipe name"));
    if (recipeIdx < 0) return 0;

    let added = 0;
    for (let i = 1; i < rows.length; i++) {
      const full = (rows[i]?.[recipeIdx] ?? "").toString().trim();
      if (!full) continue;
      const { code, base } = parseRecipeName(full);
      if (!/^[A-Z]{2}\d{4}[A-Z0-9]+$/.test(code)) continue;

      const ok = upsertWeekRecipe({
        hfWeek,
        weekShort: hfWeek.slice(5),
        code,
        recipeName: base,
      });
      if (ok) added++;
    }
    return added;
  };

  const parseWTabRows = (rows: any[][], hfWeek: string): number => {
    const marketToken = (v: string): "BENL" | "DKSE" | "DE" | undefined => {
      const t = v.trim().toUpperCase().replace(/\s+/g, "");
      if (t === "BNL" || t === "BENL") return "BENL";
      if (t === "NOR" || t === "NORD" || t === "DKSE") return "DKSE";
      if (t === "DE") return "DE";
      return undefined;
    };

    const extractVolumes = (row: string[]): { BENL: number; DKSE: number; DE: number } => {
      const outVol = { BENL: 0, DKSE: 0, DE: 0 };
      for (let i = 0; i < row.length - 1; i++) {
        const mk = marketToken(row[i] || "");
        if (!mk) continue;
        const v = num(row[i + 1]);
        if (v > 0) outVol[mk] = v;
      }
      return outVol;
    };

    let added = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i].map((c: unknown) => (c ?? "").toString().trim());
      const recipeCell = row.find(c => /^[A-Z]{2}\d{4}[A-Z0-9]+\s*-\s*/.test(c));
      if (!recipeCell) continue;

      const { code, base } = parseRecipeName(recipeCell);
      const vol = { BENL: 0, DKSE: 0, DE: 0 };

      const blockRows = rows.slice(i, Math.min(i + 10, rows.length));
      for (const b of blockRows) {
        const parsed = extractVolumes(b.map((c: unknown) => (c ?? "").toString().trim()));
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
      });
      if (ok) added++;
    }

    return added;
  };

  for (const SHEET_ID of SHEET_IDS) {
    console.log(`  → Sheet ${SHEET_ID}`);

    let titles: string[] = [];
    try {
      const meta = await sheets.spreadsheets.get({
        spreadsheetId: SHEET_ID,
        fields: "sheets(properties(title))"
      });
      titles = (meta.data.sheets ?? [])
        .map(s => s.properties?.title ?? "")
        .filter(Boolean);
    } catch (e: any) {
      console.warn(`     Konnte Sheet-Metadaten nicht lesen (${e?.message ?? e})`);
    }

    // 1) Preferred source: Ramp-up table.
    let added = 0;
    try {
      const rampRanges = [
        "'PO Maitre'!A1:Z5000",
        "'[Import] Convini Order Sheet'!A1:Z5000",
        "'_Import_ Convini Order Sheet'!A1:Z5000",
        "'Input '!A1:Z5000"
      ];
      for (const range of rampRanges) {
        try {
          const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
          const rows = res.data.values ?? [];
          added += parseRampUpConviniRows(rows);
          if (added > 0) {
            console.log(`     ${added} neue Zeilen aus Ramp-up (All Markets) übernommen`);
            break;
          }
        } catch {
          // intentionally ignored: try next candidate range
        }
      }
      if (added > 0) continue;
      console.warn("     Ramp-up Tab nicht lesbar oder ohne Meal-Zeilen");
    } catch (e: any) {
      console.warn(`     Ramp-up Lesen fehlgeschlagen (${e?.message ?? e})`);
    }

    // 2) Legacy fallback: old Meal Selection layout.
    try {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Meal Selection!A3:X1000" });
      const rows = res.data.values ?? [];
      added += parseLegacyMealSelectionRows(rows);
    } catch (e: any) {
      console.warn(`     Meal Selection Fallback fehlgeschlagen (${e?.message ?? e})`);
    }

    console.log(`     ${added} neue Zeilen übernommen`);
  }
  return { weekRecipes: [...out.values()], weeks: [...weekSet].sort() };
}

function loadRecipesFromCsv(): Record<string, Recipe> {
  const recipes: Record<string, Recipe> = {};
  for (const market of Object.keys(RECIPE_CSVS) as Market[]) {
    const path = join(SOURCE_DIR, RECIPE_CSVS[market]);
    if (!existsSync(path)) continue;
    const rows = readCsv<Record<string, string>>(path);
    for (const row of rows) {
      const fullName = row["Recipe name"] ?? "";
      const { code, base } = parseRecipeName(fullName);
      if (!code) continue;
      if (!recipes[code]) recipes[code] = { code, baseName: base, markets: {}, grossIngredients: {} };
      const rec = recipes[code];
      let md = rec.markets[market];
      if (!md) {
        md = {
          market, msku: row["MSKU Code"] ?? "", recipeNameLocal: fullName,
          recipeYield: num(row["Recipe Yield"]) || undefined,
          recipeYieldUom: row["Recipe Yield UOM"] || undefined,
          allergens: row["Allergen Contains"] || undefined,
          primaryPackagingSku: row["Primary Packaging Sku Code"] || undefined,
          compartmentName: row["Compartment Name"] || undefined,
          secondaryPackagingSkus: row["Secondary Packaging Sku Codes"] || undefined,
          subRecipes: [], ingredients: []
        };
        rec.markets[market] = md;
      }
      const subId = row["Sub-Recipe ID"] || "";
      const subName = row["Ingredient Name"] || "";
      const subCat = row["Sub-Recipe Categories"] || "";
      if (subId && !md.subRecipes.find(s => s.id === subId)) {
        md.subRecipes.push({
          id: subId, name: subName, category: subCat,
          yield: num(row["Sub-Recipe Yield"]) || undefined,
          instructions: row["Instructions"] || undefined,
          methodColor: row["Method Color"] || undefined,
          methodType: row["Method Type"] || undefined
        });
      }
      md.ingredients.push({
        name: subName,
        ingredientId: row["Ingredient ID"] || "",
        ingredientCategory: row["Ingredient Type"] || undefined,
        type: row["Ingredient Type"] || undefined,
        subRecipeId: subId || undefined, subRecipeName: subName || undefined,
        quantityPerPortion: num(row["Ingredient Quantity"]),
        uom: row["Ingredient UOM"] || "",
        preparation: row["Preparation"] || undefined
      });
    }
  }
  return recipes;
}

function loadGrossFromCsv(recipes: Record<string, Recipe>) {
  for (const market of Object.keys(GROSS_CSVS) as Market[]) {
    const path = join(SOURCE_DIR, GROSS_CSVS[market]);
    if (!existsSync(path)) continue;
    for (const row of readCsv<Record<string, string>>(path)) {
      const { code } = parseRecipeName(row["Recipe Name"] ?? "");
      if (!code) continue;
      if (!recipes[code]) recipes[code] = { code, baseName: code, markets: {}, grossIngredients: {} };
      (recipes[code].grossIngredients[market] ??= []).push({
        subRecipe1: row["Sub-Recipe 1 Name"] || undefined,
        subRecipe2: row["Sub-Recipe 2 Name"] || undefined,
        subRecipe3: row["Sub-Recipe 3 Name"] || undefined,
        ingredient: row["Ingredient"] || "",
        ingredientId: row["Ingredient ID"] || "",
        ingredientCategory: row["Ingredient Category"] || undefined,
        grossQuantityPerPortion: num(row["Gross Quantity"]),
        uom: row["UOM"] || ""
      } as GrossIngredient);
    }
  }
}

function loadCookSchedulesVF(): Record<string, CookSchedule> {
  const path = join(SOURCE_DIR, COOK_CSV);
  const out: Record<string, CookSchedule> = {};
  for (const row of readCsv<Record<string, string>>(path)) {
    if ((row["Site"] || "").trim().toUpperCase() !== "VF") continue;
    const method = (row["COOK METHODS"] || "").trim();
    if (!method) continue;
    const steps: CookSchedule["steps"] = [];
    const cells: [number, string][] = [
      [4, row["4 Shifts Before"] || ""], [3, row["3 Shifts Before"] || ""],
      [2, row["2 Shifts Before"] || ""], [1, row["1 Shift Before"] || ""],
      [0, row["Same Day/Shift"] || ""]
    ];
    for (const [n, l] of cells) if (l.trim()) steps.push({ shiftsBefore: n, label: l.trim() });
    out[method] = { cookMethod: method, site: "VF", cookShifts: num(row["Cook Shifts"]) || 1, steps };
  }
  return out;
}

// ─── Operational Sheet Readers ────────────────────────────────────────────────

// ─── KW-Tab Auswahl ────────────────────────────────────────────────────────
// Sucht unter den Tab-Titeln nach dem Tab der aktuellen (oder nächsten) KW.
// patterns: Array von Suchmustern, z.B. ["Verden PW{XX}", "Verden PW{KW}"]
// {XX} = zweistellige KW-Zahl, {YEAR} = Jahr
function findCurrentWeekTab(tabs: string[], patterns: string[], fallbackToLatest = true): string | undefined {
  const now = new Date();
  const year = now.getFullYear();
  // ISO-Wochennummer
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const kw = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);

  // Versuche aktuelle KW, dann nächste, dann vorherige
  for (const delta of [0, 1, -1, 2]) {
    const weekNum = kw + delta;
    for (const pattern of patterns) {
      const needle = pattern
        .replace("{XX}", String(weekNum).padStart(2, "0"))
        .replace("{KW}", String(weekNum))
        .replace("{YEAR}", String(year));
      const found = tabs.find(t => t.toLowerCase().includes(needle.toLowerCase()));
      if (found) return found;
    }
  }

  // Fallback: neuesten Tab mit KW-Muster suchen
  if (fallbackToLatest) {
    const kwTabs = tabs.filter(t => /W\d{2}|PW\d{2}|\d{4}-W\d{2}/.test(t));
    if (kwTabs.length) return kwTabs[kwTabs.length - 1];
  }
  return undefined;
}

async function getAuthClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  return auth.getClient();
}

async function getAllTabNames(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string): Promise<string[]> {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title))" });
    return (meta.data.sheets ?? []).map(s => s.properties?.title ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

async function readProductionPlan(spreadsheetId: string): Promise<ProductionPlan | undefined> {
  if (!spreadsheetId) return undefined;
  const client = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth: client as any });

  let tabName = process.env.SHEET_FERTIGSTELLUNG_TAB?.trim();
  if (!tabName) {
    const allTabs = await getAllTabNames(sheets, spreadsheetId);
    tabName = findCurrentWeekTab(allTabs, ["W{XX} Transperancy", "W{XX} Transparency", "BENL Outbound W{XX}"]);
    if (!tabName) tabName = allTabs[0];
  }
  if (!tabName) { console.warn("  Fertigstellung: kein Tab gefunden"); return undefined; }

  let rows: any[][];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A1:N2000` });
    rows = res.data.values ?? [];
  } catch (e: any) {
    console.warn(`  Fertigstellung Lesen fehlgeschlagen: ${e?.message ?? e}`);
    return undefined;
  }

  // Derive week from tab name: "W23 Transperancy Total Overview" → 2026-W23
  const tabWeekMatch = /W(\d{1,2})/i.exec(tabName);
  const year = new Date().getFullYear();
  const week = tabWeekMatch
    ? `${year}-W${String(parseInt(tabWeekMatch[1], 10)).padStart(2, "0")}`
    : `${year}-W??`;

  // Find header row: contains "Work Order" and "Recipe"
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i].map((c: unknown) => String(c ?? "").trim().toLowerCase());
    if (r.some(c => c.includes("work order")) && r.some(c => c === "recipe")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    console.warn(`  Fertigstellung: Header nicht gefunden in Tab "${tabName}"`);
    return undefined;
  }

  const header = rows[headerIdx].map((c: unknown) => String(c ?? "").trim().toLowerCase());
  const runIdx     = header.findIndex(c => c === "run");
  const dayIdx     = header.findIndex(c => c.includes("kitchen day") || c.includes("planned kitchen"));
  const woIdx      = header.findIndex(c => c === "work order");
  const recipeIdx  = header.findIndex(c => c === "recipe");
  const subIdx     = header.findIndex(c => c.includes("sub recipe") || c === "sub recipe");
  const mealsIdx   = header.findIndex(c => c.includes("planned meals") || c === "planned meals");
  const stagingIdx = header.findIndex(c => c.includes("staging"));
  const kitchenIdx = header.findIndex(c => c.includes("kitchen") && c.includes("kg"));
  const postIdx    = header.findIndex(c => c.includes("post"));
  const yieldIdx   = header.findIndex(c => c === "yield");
  // Logistik block appears to the right: cols 11+ (WO, Target)
  const logTgtIdx  = header.findLastIndex(c => c === "target");

  const entries: WorkOrderEntry[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const woCell = woIdx >= 0 ? String(row[woIdx] ?? "").trim() : "";
    if (!woCell || !/^\d{2}-\d{3,}/.test(woCell)) continue; // must look like "23-175"

    const fullRecipe = recipeIdx >= 0 ? String(row[recipeIdx] ?? "").trim() : "";
    const { code: recipeCode, base: recipeName } = parseRecipeName(fullRecipe);

    const yieldRaw = String(row[yieldIdx >= 0 ? yieldIdx : 9] ?? "").replace("%", "").trim();
    const yieldPct = parseFloat(yieldRaw.replace(",", ".")) || 0;

    entries.push({
      run:            runIdx >= 0 ? (parseInt(String(row[runIdx] ?? ""), 10) || 0) : 0,
      kitchenDay:     dayIdx >= 0 ? String(row[dayIdx] ?? "").trim() : "",
      workOrder:      woCell,
      recipeCode,
      recipeName:     fullRecipe,
      subRecipe:      subIdx >= 0 ? String(row[subIdx] ?? "").trim() : "",
      plannedMeals:   mealsIdx >= 0 ? num(row[mealsIdx]) : 0,
      stagingKg:      stagingIdx >= 0 ? num(row[stagingIdx]) : 0,
      kitchenKg:      kitchenIdx >= 0 ? num(row[kitchenIdx]) : 0,
      postKg:         postIdx >= 0 ? num(row[postIdx]) : 0,
      yieldPct,
      logisticTarget: logTgtIdx >= 0 ? (num(row[logTgtIdx]) || undefined) : undefined,
    });
  }

  console.log(`  Produktionsplan: ${entries.length} Work-Order-Zeilen aus Tab "${tabName}"`);
  return { week, generatedAt: new Date().toISOString(), rows: entries };
}

async function readPrintOrders(spreadsheetId: string): Promise<PrintOrderRow[]> {
  if (!spreadsheetId) return [];
  const client = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth: client as any });

  let tabName = process.env.SHEET_PRINT_ORDERS_TAB?.trim();
  if (!tabName) {
    const allTabs = await getAllTabNames(sheets, spreadsheetId);
    tabName = findCurrentWeekTab(allTabs, ["Verden PW{XX}", "Verden PW{KW}"]);
    if (!tabName) tabName = allTabs[0];
  }
  if (!tabName) { console.warn("  Print Orders: kein Tab gefunden"); return []; }

  let rows: any[][];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A1:Z2000` });
    rows = res.data.values ?? [];
  } catch (e: any) {
    console.warn(`  Print Orders Lesen fehlgeschlagen: ${e?.message ?? e}`);
    return [];
  }

  if (!rows.length) return [];
  const header = rows[0].map((c: unknown) => String(c ?? "").trim().toLowerCase());
  const weekIdx   = header.findIndex(h => h.includes("week") || h === "kw");
  const codeIdx   = header.findIndex(h => h.includes("code") || h.includes("recipe"));
  const mskuIdx   = header.findIndex(h => h.includes("msku") || h === "sku");
  const qtyIdx    = header.findIndex(h => h.includes("qty") || h.includes("menge") || h.includes("quantity"));
  const sleeveIdx = header.findIndex(h => h.includes("sleeve") || h.includes("typ"));

  const result: PrintOrderRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const code = String(row[codeIdx >= 0 ? codeIdx : 1] ?? "").trim();
    if (!code) continue;
    result.push({
      week:      weekIdx >= 0 ? String(row[weekIdx] ?? "").trim() : "",
      code,
      msku:      mskuIdx >= 0 ? String(row[mskuIdx] ?? "").trim() : "",
      qty:       qtyIdx >= 0 ? num(row[qtyIdx]) : 0,
      sleeveType: sleeveIdx >= 0 ? String(row[sleeveIdx] ?? "").trim() || undefined : undefined,
    });
  }

  console.log(`  Print Orders: ${result.length} Zeilen aus Tab "${tabName}"`);
  return result;
}

async function readKitchenPriority(spreadsheetId: string): Promise<KitchenPriorityRow[]> {
  if (!spreadsheetId) return [];
  const client = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth: client as any });

  let tabName = process.env.SHEET_KITCHEN_PRIORITY_TAB?.trim();
  if (!tabName) {
    const allTabs = await getAllTabNames(sheets, spreadsheetId);
    tabName = findCurrentWeekTab(allTabs, ["Verden-{YEAR}-W{XX}", "Verden-{YEAR}-W{KW}"]);
    if (!tabName) tabName = allTabs[0];
  }
  if (!tabName) { console.warn("  Kitchen Priority: kein Tab gefunden"); return []; }

  let rows: any[][];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A1:J1000` });
    rows = res.data.values ?? [];
  } catch (e: any) {
    console.warn(`  Kitchen Priority Lesen fehlgeschlagen: ${e?.message ?? e}`);
    return [];
  }

  if (!rows.length) return [];

  // Find header row: row with "Priority" and "Work Order" (may be row 0 or 1)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    const r = rows[i].map((c: unknown) => String(c ?? "").trim().toLowerCase());
    if (r.some(c => c === "priority") && r.some(c => c.includes("work order"))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    console.warn(`  Kitchen Priority: Header nicht gefunden in Tab "${tabName}"`);
    return [];
  }

  const header = rows[headerIdx].map((c: unknown) => String(c ?? "").trim().toLowerCase());
  const prioIdx    = header.findIndex(c => c === "priority");
  const stagingIdx = header.findIndex(c => c.includes("wo") && c.includes("staging") || c.includes("wostaging"));
  const commentIdx = header.findIndex(c => c.includes("comment"));
  const deboxIdx   = header.findIndex(c => c.includes("debox"));
  const readyIdx   = header.findIndex(c => c.includes("wo ready") || c === "wo ready");
  const hkIdx      = header.findIndex(c => c.includes("hot kitchen"));
  const dateIdx    = header.findIndex(c => c.includes("date needed"));
  const woIdx      = header.findIndex(c => c.includes("work order number") || c === "work order number");

  const result: KitchenPriorityRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const wo = woIdx >= 0 ? String(row[woIdx] ?? "").trim() : "";
    if (!wo || !/^\d{2}-\d{3,}/.test(wo)) continue; // must look like "23-175"

    const readyRaw = readyIdx >= 0 ? String(row[readyIdx] ?? "").trim().toUpperCase() : "";
    result.push({
      priority:          prioIdx >= 0 ? (parseInt(String(row[prioIdx] ?? ""), 10) || result.length + 1) : result.length + 1,
      workOrder:         wo,
      woStagingBy:       stagingIdx >= 0 ? String(row[stagingIdx] ?? "").trim() || undefined : undefined,
      deboxDay:          deboxIdx >= 0 ? String(row[deboxIdx] ?? "").trim() || undefined : undefined,
      woReady:           readyRaw === "TRUE",
      hotKitchenWeekday: hkIdx >= 0 ? String(row[hkIdx] ?? "").trim() || undefined : undefined,
      dateNeeded:        dateIdx >= 0 ? String(row[dateIdx] ?? "").trim() || undefined : undefined,
      comments:          commentIdx >= 0 ? String(row[commentIdx] ?? "").trim() || undefined : undefined,
    });
  }

  console.log(`  Kitchen Priority: ${result.length} Einträge aus Tab "${tabName}"`);
  return result;
}

async function readProduktionsplanung(spreadsheetId: string, market: "DE" | "NORDICS"): Promise<ProduktionsplanungEntry | undefined> {
  if (!spreadsheetId) return undefined;
  const client = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth: client as any });

  const tabName = market === "DE" ? "Produktionsvorbereitung_DE" : "Produktionsvorbereitung_Nordics";
  
  let rows: any[][];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A1:Z500` });
    rows = res.data.values ?? [];
  } catch (e: any) {
    console.warn(`  Produktionsvorbereitung ${market} Lesen fehlgeschlagen: ${e?.message ?? e}`);
    return undefined;
  }

  if (!rows.length) return undefined;

  let week = "";
  const row1 = rows[1] ?? [];
  if (row1[2] && String(row1[2]).trim()) {
    week = String(row1[2]).trim();
  } else {
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const kw = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    week = `${now.getFullYear()}-W${String(kw).padStart(2, "0")}`;
  }

  const row3 = rows[3] ?? [];
  const boxVolRun1 = num(row3[1]);
  const boxVolRun2 = num(row3[3]);

  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const r = (rows[i] ?? []).map((c: unknown) => String(c ?? "").trim().toLowerCase());
    if (r.includes("maitre code") && r.includes("fe/fv code")) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx < 0) {
    console.warn(`  Produktionsvorbereitung ${market}: Header nicht gefunden`);
    return undefined;
  }

  const header = rows[headerIdx].map((c: unknown) => String(c ?? "").trim().toLowerCase());
  const slotIdx = header.findIndex(c => c === "rezept" || c === "slot");
  const mCodeIdx = header.findIndex(c => c === "maitre code");
  const codeIdx = header.findIndex(c => c === "fe/fv code" || c === "code");
  const skuIdx = header.findIndex(c => c === "sku");
  const nameIdx = header.findIndex(c => c === "artikel" || c === "rezeptname");
  const friIdx = header.findIndex(c => c === "friday");
  const monIdx = header.findIndex(c => c === "monday");
  const sumIdx = header.findIndex(c => c === "summe soll");
  const palFriIdx = header.findIndex(c => c === "paletten friday");

  const slots: ProduktionsplanungSlot[] = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    
    const c0 = String(row[0] ?? "").trim();
    if (c0 === "Summe" || c0 === "Sum" || c0 === "Total") break;

    const recipeCode = codeIdx >= 0 ? String(row[codeIdx] ?? "").trim() : "";
    if (!recipeCode || recipeCode.includes("FE/FV") || recipeCode.includes("Code")) continue;

    const mCode = mCodeIdx >= 0 ? String(row[mCodeIdx] ?? "").trim() : "";
    if (!mCode) continue;

    slots.push({
      slot: slotIdx >= 0 ? (parseInt(String(row[slotIdx] ?? ""), 10) || 0) : 0,
      maitreCode: mCode,
      recipeCode,
      skuCode: skuIdx >= 0 ? String(row[skuIdx] ?? "").trim() : "",
      recipeName: nameIdx >= 0 ? String(row[nameIdx] ?? "").trim() : "",
      volRun1: friIdx >= 0 ? num(row[friIdx]) : 0,
      volRun2: monIdx >= 0 ? num(row[monIdx]) : 0,
      totalVol: sumIdx >= 0 ? num(row[sumIdx]) : 0,
      paletten: palFriIdx >= 0 ? String(row[palFriIdx] ?? "").trim() : undefined,
    });
  }

  console.log(`  Produktionsvorbereitung ${market}: ${slots.length} Slots geladen`);

  return {
    week,
    market,
    boxVolRun1,
    boxVolRun2,
    maxKapaPerDay: 5000,
    startTime: "06:00",
    endTime: "22:00",
    slots,
    generatedAt: new Date().toISOString()
  };
}

async function main() {
  console.log(`Lese Ramp-up Meals LIVE aus ${SHEET_IDS.length} GSheet(s) …`);
  const { weekRecipes, weeks } = await readMealSelectionFromGSheet();
  console.log(`  ${weekRecipes.length} Zeilen, ${weeks.length} Wochen`);

  const recipes = loadRecipesFromCsv();
  loadGrossFromCsv(recipes);
  const cookSchedules = loadCookSchedulesVF();

  console.log("Lese PFEI (Equipment- & Batch-Daten) live …");
  const processSpecs = await readPfei();

  console.log("Lese Open Shelf Life / MLOR live …");
  const shelfLifeBySku = await readOpenShelfLifeSheet();

  console.log("Lese Fertigstellungszeitplan (Sheet 6) …");
  const productionPlan = await readProductionPlan(process.env.SHEET_FERTIGSTELLUNG ?? "1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY");

  console.log("Lese Print Orders Sleeven (Sheet 2) …");
  const printOrders = await readPrintOrders(process.env.SHEET_PRINT_ORDERS ?? "1fpEHBWmd_zk74wbu78unPoTV_u860smNlxTuioEdq-4");

  console.log("Lese Kitchen Priority (Sheet 3) …");
  const kitchenPriority = await readKitchenPriority(process.env.SHEET_KITCHEN_PRIORITY ?? "13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U");

  console.log("Lese Produktionsvorbereitung DE/Nordics (Sheet 1) ...");
  const sheetWochenstartId = process.env.SHEET_WOCHENSTART ?? "1YscgiuKYVI2pGcMJ3RcJwWGQEkG46RnVnji8q8a4AeE";
  const dePlan = await readProduktionsplanung(sheetWochenstartId, "DE");
  const noPlan = await readProduktionsplanung(sheetWochenstartId, "NORDICS");
  const produktionsplanung: Record<string, ProduktionsplanungEntry> = {};
  if (dePlan) produktionsplanung["DE"] = dePlan;
  if (noPlan) produktionsplanung["NORDICS"] = noPlan;

  // FE↔FV harmonisieren über die 4-stellige Nummer im Code.
  const byDigits: Record<string, Recipe> = {};
  for (const r of Object.values(recipes)) {
    const m = /(\d{4,5})/.exec(r.code); if (m) byDigits[m[1]] = r;
  }
  let aliased = 0;
  for (const wr of weekRecipes) {
    if (recipes[wr.code]) continue;
    const m = /(\d{4,5})/.exec(wr.code); const hit = m ? byDigits[m[1]] : undefined;
    if (hit) { recipes[wr.code] = hit; aliased++; }
  }
  console.log(`  Code-Mapping: ${aliased} Aliase (FE↔FV)`);

  const bundle: DataBundle = {
    generatedAt: new Date().toISOString(),
    weeks,
    weekRecipes,
    recipes,
    cookSchedules,
    processSpecs,
    shelfLifeBySku,
    productionPlan: productionPlan ?? undefined,
    printOrders: printOrders.length ? printOrders : undefined,
    kitchenPriority: kitchenPriority.length ? kitchenPriority : undefined,
    produktionsplanung: Object.keys(produktionsplanung).length ? produktionsplanung : undefined,
  };
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(bundle));
  console.log(`✓ ${OUT_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
