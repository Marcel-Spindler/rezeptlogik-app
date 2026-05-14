import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import Papa from "papaparse";

type Market = "de" | "nordics";

type SourceRow = {
  Recipe: string;
  Ingredient: string;
  SKU: string;
  Line: string;
  FlowRackPosition: string;
  Quantity: number;
  ScanRegEx: string;
};

type RackfileRow = {
  Recipe: string;
  Line: string;
  FlowRackPosition: string;
  Quantity: number;
  SKU: string;
  Ingredient: string;
  ScanRegEx: string;
  LabelPos: string;
  UniCode: string;
  DisplayName: string;
  Gramage: string;
  Sort: number;
};

type ExtraItem = {
  Recipe: string;
  Ingredient: string;
  SKU?: string;
  FlowRackPosition: string;
  Quantity?: number;
};

type ValidationReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
};

type Profile = {
  sheet: string;
  lines: string[];
  outputName: (week: string, lines: string[]) => string;
  requiredRecipes: string[];
};

type EtlBoxSnapshot = {
  fileName: string;
  mealIds: Set<string>;
  iceRecipes: Set<string>;
  loyaltyRecipes: Set<string>;
  giftRecipes: Set<string>;
  boxRecipes: Set<string>;
  pouchRecipes: Set<string>;
};

type EtlSnapshot = {
  weekPath: string;
  boxfilePath: string;
  co2Path: string;
  selectedBox: EtlBoxSnapshot | null;
  co2MealIds: Set<string>;
};

const profiles: Record<Market, Profile> = {
  de: {
    sheet: "static exportP2L - DACH",
    lines: ["ASL3", "ASL4"],
    outputName: (week, lines) => `Rackfile_[${week}]_[F-DE]_[${lines.join("_")}]`,
    requiredRecipes: [
      "Factor Box Small",
      "Factor Box Medium",
      "Factor Box Large",
      "Factor Liner Small1",
      "Factor Liner Small2",
      "Factor Liner Medium1",
      "Factor Liner Medium2",
      "Factor Liner Large1",
      "Factor Liner Large2",
    ],
  },
  nordics: {
    sheet: "static exportP2L - Nordics",
    lines: ["ASL1", "ASL5"],
    outputName: (week, lines) => {
      const kw = week.split("W").at(-1) ?? week;
      const lineToken = lines.map((l) => l.replace("ASL", "")).join(",");
      return `Rackfile_KW${kw}_[Fact-Nordics]_[ASL${lineToken}]`;
    },
    requiredRecipes: ["XS", "S", "M", "L"],
  },
};

const requiredColumns = [
  "Recipe",
  "Ingredient",
  "SKU",
  "Line",
  "FlowRackPosition",
  "Quantity",
  "ScanRegEx",
] as const;

const DEFAULT_ETL_ROOT = "G:\\.shortcut-targets-by-id\\1eCsBqOA6dwfxG3KWAhOpLYnGJpYRLX0G\\ETL_OR\\ETL_OR_FACTOR";

const RECIPE_ALIASES: Record<string, string> = {
  "805_1p": "205_1p",
  "806_1p": "206_1p",
  "809_1p": "209_1p",
  "810_1p": "210_1p",
};

function normalizeRecipeId(recipeId: string): string {
  return RECIPE_ALIASES[recipeId] ?? recipeId;
}

function parseArgv(argv: string[]) {
  const [command = "plan", ...rest] = argv;
  const args = new Map<string, string>();

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
    args.set(key, value);
  }

  return { command, args };
}

function currentWeekISO() {
  const now = new Date();
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function findLatestMultilineXlsx(workspaceRoot: string) {
  const scratch = path.join(workspaceRoot, "scratch");
  if (!fs.existsSync(scratch)) return null;

  const files = fs.readdirSync(scratch)
    .filter((f) => /^MultiLine.*\.xlsx$/i.test(f))
    .map((f) => ({ name: f, fullPath: path.join(scratch, f), mtime: fs.statSync(path.join(scratch, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  return files[0]?.fullPath ?? null;
}

function toStringValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parseQuantity(v: unknown): number {
  const s = toStringValue(v);
  if (!s) return 1;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? Math.trunc(n) : 1;
}

function sortKey(fp: string): number {
  const m = fp.trim().match(/^F(\d+)$/i);
  if (!m) return Number.MAX_SAFE_INTEGER;
  return Number(m[1]);
}

function suffix(recipe: string): string {
  const idx = recipe.indexOf("_");
  return idx > -1 ? recipe.slice(idx + 1) : "";
}

function readJsonArray<T>(filePath: string): T[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error(`Datei ist kein JSON-Array: ${filePath}`);
  }
  return data as T[];
}

function readPdlRecipeIds(pdlPath: string): Set<string> {
  const csv = fs.readFileSync(pdlPath, "utf-8");
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });

  const ids = new Set<string>();
  for (const row of parsed.data) {
    const swap = String(row.meal_swap ?? "");
    if (!swap.trim()) continue;
    const parts = swap.split(/\s+/);
    for (const p of parts) {
      const m = p.match(/^(\d+):/);
      if (m) ids.add(normalizeRecipeId(`${m[1]}_1p`));
    }
  }
  return ids;
}

function parseBoxfile(filePath: string): EtlBoxSnapshot {
  const csv = fs.readFileSync(filePath, "utf-8");
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
    delimiter: ",",
  });

  const mealIds = new Set<string>();
  const iceRecipes = new Set<string>();
  const loyaltyRecipes = new Set<string>();
  const giftRecipes = new Set<string>();
  const boxRecipes = new Set<string>();
  const pouchRecipes = new Set<string>();

  function collectMealIds(raw: string) {
    const value = String(raw ?? "");
    if (!value.trim()) return;
    for (const m of value.matchAll(/(\d+_\dp)/g)) {
      mealIds.add(normalizeRecipeId(m[1]));
    }
    for (const m of value.matchAll(/-(\d{3})-/g)) {
      mealIds.add(normalizeRecipeId(`${m[1]}_1p`));
    }
    for (const m of value.matchAll(/(\d{3}):/g)) {
      mealIds.add(normalizeRecipeId(`${m[1]}_1p`));
    }
  }

  for (const row of parsed.data) {
    collectMealIds(String(row.Recipes ?? ""));
    collectMealIds(String((row as Record<string, string>)["RecipeCards"] ?? ""));
    collectMealIds(String((row as Record<string, string>)["meal_swap"] ?? ""));
    collectMealIds(String((row as Record<string, string>)["meal_swap_dash"] ?? ""));

    const ice = String(row.Ice ?? "").trim();
    if (ice) iceRecipes.add(ice);

    const loyalty = String(row.loyalty ?? "");
    for (const m of loyalty.matchAll(/([A-Z]{2,}\d+)/g)) {
      loyaltyRecipes.add(m[1]);
    }

    const gift = String(row.Gift ?? "");
    for (const m of gift.matchAll(/([A-Z]{2,}\d+)/g)) {
      giftRecipes.add(m[1]);
    }

    const boxSize = String(row.BoxSize ?? "").trim();
    if (boxSize) boxRecipes.add(boxSize);

    const pouch = String(row.Coolpouch1 ?? "").trim();
    if (pouch) pouchRecipes.add(pouch);
  }

  return {
    fileName: path.basename(filePath),
    mealIds,
    iceRecipes,
    loyaltyRecipes,
    giftRecipes,
    boxRecipes,
    pouchRecipes,
  };
}

function readEtlCo2MealIds(filePath: string, boxPrefix?: string): Set<string> {
  const csv = fs.readFileSync(filePath, "utf-8");
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
    delimiter: ";",
  });

  const ids = new Set<string>();
  function collect(raw: string) {
    const value = String(raw ?? "");
    for (const m of value.matchAll(/(\d+_\dp)/g)) {
      ids.add(normalizeRecipeId(m[1]));
    }
    for (const m of value.matchAll(/-(\d{3})-/g)) {
      ids.add(normalizeRecipeId(`${m[1]}_1p`));
    }
    for (const m of value.matchAll(/(\d{3}):/g)) {
      ids.add(normalizeRecipeId(`${m[1]}_1p`));
    }
  }

  for (const row of parsed.data) {
    const boxId = String(row.boxid ?? row.box_id ?? "").trim();
    if (boxPrefix && boxId && !boxId.startsWith(boxPrefix)) continue;
    collect(String(row.meal_swap_dash ?? row.meal_swap ?? ""));
  }
  return ids;
}

async function readEtlCo1WorkbookMealIds(filePath: string, boxPrefix?: string): Promise<Set<string>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ids = new Set<string>();

  function collect(raw: string) {
    const value = String(raw ?? "");
    for (const m of value.matchAll(/(\d+_\dp)/g)) {
      ids.add(normalizeRecipeId(m[1]));
    }
    for (const m of value.matchAll(/-(\d{3})-/g)) {
      ids.add(normalizeRecipeId(`${m[1]}_1p`));
    }
    for (const m of value.matchAll(/(\d{3}):/g)) {
      ids.add(normalizeRecipeId(`${m[1]}_1p`));
    }
  }

  for (const ws of wb.worksheets) {
    const headerCells = ws.getRow(1).values as unknown[];
    const header = headerCells.slice(1).map(toStringValue);
    const indexByName = new Map<string, number>();
    for (let i = 0; i < header.length; i++) {
      indexByName.set(header[i].toLowerCase(), i + 1);
    }

    const boxCol = indexByName.get("boxid")
      ?? indexByName.get("box_id")
      ?? indexByName.get("box id")
      ?? 0;
    const mealSwapCol = indexByName.get("meal_swap")
      ?? indexByName.get("meal swap")
      ?? 0;
    const mealSwapDashCol = indexByName.get("meal_swap_dash")
      ?? indexByName.get("meal swap dash")
      ?? 0;

    for (let rowNumber = 2; rowNumber <= ws.rowCount; rowNumber += 1) {
      const row = ws.getRow(rowNumber);
      const boxId = boxCol > 0 ? toStringValue(row.getCell(boxCol).value) : "";
      if (boxPrefix && boxId && !boxId.startsWith(boxPrefix)) continue;
      if (mealSwapCol > 0) collect(toStringValue(row.getCell(mealSwapCol).value));
      if (mealSwapDashCol > 0) collect(toStringValue(row.getCell(mealSwapDashCol).value));
    }
  }

  return ids;
}

function expectedBoxPrefixForMarket(market: Market): string {
  return market === "de" ? "TZ" : "TK";
}

async function loadEtlSnapshot(etlRoot: string, week: string, market: Market, report: ValidationReport): Promise<EtlSnapshot | null> {
  const weekPath = path.join(etlRoot, week);
  if (!fs.existsSync(weekPath)) {
    report.warnings.push(`ETL-Wochenordner nicht gefunden: ${weekPath}`);
    return null;
  }

  const boxfilePath = path.join(weekPath, "BOXFILE_VE");
  if (!fs.existsSync(boxfilePath)) {
    report.warnings.push(`BOXFILE-Ordner fehlt: ${boxfilePath}`);
    return null;
  }

  const boxCsvs = fs.readdirSync(boxfilePath)
    .filter((n) => n.toLowerCase().endsWith(".csv"))
    .map((n) => path.join(boxfilePath, n));

  if (boxCsvs.length === 0) {
    report.warnings.push(`Keine Boxfile-CSV gefunden in: ${boxfilePath}`);
    return null;
  }

  const snapshots = boxCsvs.map(parseBoxfile);
  let selectedBox: EtlBoxSnapshot | null = null;
  if (market === "de") {
    selectedBox = snapshots.find((s) => /-TZ\.csv$/i.test(s.fileName)) ?? null;
  } else {
    selectedBox = snapshots.find((s) => /-TK/i.test(s.fileName)) ?? null;
  }
  if (!selectedBox) {
    selectedBox = snapshots[0] ?? null;
    report.warnings.push(`Kein marktspezifisches Boxfile gefunden, Fallback auf: ${selectedBox?.fileName ?? "-"}`);
  }

  const boxPrefix = expectedBoxPrefixForMarket(market);
  const co1Path = path.join(weekPath, "CO_1", "DWHTAXI");
  const co2Path = path.join(weekPath, "CO_2", "DWHTAXI");
  let co2MealIds = new Set<string>();
  let usedPath = "";

  if (fs.existsSync(co1Path)) {
    const co1Workbook = fs.readdirSync(co1Path).find((n) => /\.xlsx$/i.test(n));
    if (co1Workbook) {
      usedPath = path.join(co1Path, co1Workbook);
      co2MealIds = await readEtlCo1WorkbookMealIds(usedPath, boxPrefix);
      report.info.push(`CO_1 Workbook verwendet: ${co1Workbook}`);
    } else {
      report.warnings.push(`CO_1 vorhanden, aber keine XLSX gefunden: ${co1Path}`);
    }
  }

  if (co2MealIds.size === 0 && fs.existsSync(co2Path)) {
    const co2Csv = fs.readdirSync(co2Path).find((n) => /^or-.*\.csv$/i.test(n));
    if (co2Csv) {
      usedPath = path.join(co2Path, co2Csv);
      co2MealIds = readEtlCo2MealIds(usedPath, boxPrefix);
      report.info.push(`CO_2 CSV verwendet: ${co2Csv}`);
    } else {
      report.warnings.push(`Keine or-*.csv in CO_2/DWHTAXI gefunden: ${co2Path}`);
    }
  }

  if (!usedPath && !fs.existsSync(co1Path) && !fs.existsSync(co2Path)) {
    report.warnings.push(`Weder CO_1 noch CO_2 vorhanden: ${co1Path} | ${co2Path}`);
  }

  return {
    weekPath,
    boxfilePath,
    co2Path: usedPath || co1Path || co2Path,
    selectedBox,
    co2MealIds,
  };
}

async function readSheetRows(excelPath: string, sheetName: string, report: ValidationReport): Promise<SourceRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelPath);

  const ws = wb.getWorksheet(sheetName);
  if (!ws) {
    report.errors.push(`Sheet fehlt: ${sheetName}`);
    report.info.push(`Verfuegbare Sheets: ${wb.worksheets.map((s) => s.name).join(", ")}`);
    return [];
  }

  const headerCells = ws.getRow(1).values as unknown[];
  const header = headerCells.slice(1).map(toStringValue);
  const indexByName = new Map<string, number>();
  for (let i = 0; i < header.length; i++) indexByName.set(header[i], i + 1);

  for (const col of requiredColumns) {
    if (!indexByName.has(col)) {
      report.errors.push(`Pflichtspalte fehlt im Sheet ${sheetName}: ${col}`);
    }
  }
  if (report.errors.length > 0) return [];

  const rows: SourceRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);

    const recipe = toStringValue(row.getCell(indexByName.get("Recipe")!).value);
    const flowPos = toStringValue(row.getCell(indexByName.get("FlowRackPosition")!).value);
    if (!recipe && !flowPos) continue;

    const entry: SourceRow = {
      Recipe: recipe,
      Ingredient: toStringValue(row.getCell(indexByName.get("Ingredient")!).value),
      SKU: toStringValue(row.getCell(indexByName.get("SKU")!).value),
      Line: toStringValue(row.getCell(indexByName.get("Line")!).value),
      FlowRackPosition: flowPos,
      Quantity: parseQuantity(row.getCell(indexByName.get("Quantity")!).value),
      ScanRegEx: toStringValue(row.getCell(indexByName.get("ScanRegEx")!).value),
    };

    rows.push(entry);
  }

  if (rows.length === 0) {
    report.errors.push(`Keine Datenzeilen im Sheet ${sheetName} gefunden.`);
  }

  return rows;
}

function buildRows(baseRows: SourceRow[], lines: string[], extras: ExtraItem[]): RackfileRow[] {
  const out: RackfileRow[] = [];

  for (const line of lines) {
    for (const src of baseRows) {
      if (!src.Recipe || !src.FlowRackPosition) continue;

      const lp = `${line}${src.FlowRackPosition}`;
      const portion = suffix(src.Recipe);
      const uniCode = portion ? `${lp}${portion}` : lp;

      out.push({
        Recipe: src.Recipe,
        Line: line,
        FlowRackPosition: src.FlowRackPosition,
        Quantity: src.Quantity || 1,
        SKU: src.SKU,
        Ingredient: src.Ingredient,
        ScanRegEx: src.ScanRegEx,
        LabelPos: lp,
        UniCode: uniCode,
        DisplayName: src.Ingredient,
        Gramage: "",
        Sort: sortKey(src.FlowRackPosition),
      });
    }

    for (const ex of extras) {
      const lp = `${line}${ex.FlowRackPosition}`;
      out.push({
        Recipe: ex.Recipe,
        Line: line,
        FlowRackPosition: ex.FlowRackPosition,
        Quantity: ex.Quantity ?? 1,
        SKU: ex.SKU ?? "Loyalties",
        Ingredient: ex.Ingredient,
        ScanRegEx: "",
        LabelPos: lp,
        UniCode: lp,
        DisplayName: ex.Ingredient,
        Gramage: "",
        Sort: sortKey(ex.FlowRackPosition),
      });
    }
  }

  return out.sort((a, b) => {
    if (a.Line !== b.Line) return a.Line.localeCompare(b.Line);
    if (a.Sort !== b.Sort) return a.Sort - b.Sort;
    return a.Recipe.localeCompare(b.Recipe);
  });
}

function validateData(baseRows: SourceRow[], finalRows: RackfileRow[], profile: Profile, lines: string[], report: ValidationReport) {
  for (let i = 0; i < baseRows.length; i++) {
    const r = baseRows[i];
    if (!r.Recipe) report.errors.push(`Zeile ${i + 2}: Recipe fehlt`);
    if (!r.FlowRackPosition) report.errors.push(`Zeile ${i + 2}: FlowRackPosition fehlt`);
    if (r.FlowRackPosition && !/^F\d+$/i.test(r.FlowRackPosition)) {
      report.errors.push(`Zeile ${i + 2}: FlowRackPosition ungueltig (${r.FlowRackPosition})`);
    }
  }

  for (const req of profile.requiredRecipes) {
    const exists = baseRows.some((r) => r.Recipe === req);
    if (!exists) {
      report.warnings.push(`Pflicht-Recipe fuer Profil fehlt im Source-Sheet: ${req}`);
    }
  }

  const seenUni = new Map<string, RackfileRow>();
  for (const row of finalRows) {
    const prev = seenUni.get(row.UniCode);
    if (prev) {
      const isIceDuplicate = row.SKU === "IcePack" && prev.SKU === "IcePack";
      if (!isIceDuplicate) {
        report.errors.push(`Duplikat UniCode: ${row.UniCode}`);
      } else {
        report.info.push(`Hinweis: geteilter UniCode fuer IcePack erlaubt (${row.UniCode})`);
      }
    }
    seenUni.set(row.UniCode, row);
  }

  for (const line of lines) {
    const count = finalRows.filter((r) => r.Line === line).length;
    if (count === 0) {
      report.errors.push(`Linie ohne Eintraege: ${line}`);
    } else {
      report.info.push(`Linie ${line}: ${count} Rackfile-Zeilen`);
    }
  }
}

function validateAgainstPdl(finalRows: RackfileRow[], pdlIds: Set<string>, report: ValidationReport) {
  const rackMealIds = new Set(
    finalRows
      .map((r) => r.Recipe)
      .filter((r) => /^\d+_\dp$/i.test(r)),
  );

  for (const r of [...rackMealIds].sort()) {
    if (!pdlIds.has(r)) {
      report.warnings.push(`Recipe im Rackfile aber nicht in PDL meal_swap: ${r}`);
    }
  }

  for (const p of [...pdlIds].sort()) {
    if (!rackMealIds.has(p)) {
      report.warnings.push(`Recipe in PDL meal_swap aber nicht im Rackfile: ${p}`);
    }
  }
}

function validateAgainstEtl(finalRows: RackfileRow[], market: Market, etl: EtlSnapshot, report: ValidationReport) {
  if (!etl.selectedBox) {
    report.warnings.push("ETL-Check uebersprungen: kein Boxfile-Snapshot selektiert.");
    return;
  }

  const rackRecipes = new Set(finalRows.map((r) => r.Recipe));
  const rackMealIds = new Set(
    finalRows
      .filter((r) => /^(CON|PTN|BEV)-/i.test(r.SKU))
      .map((r) => normalizeRecipeId(r.Recipe))
      .filter((r) => /^\d+_\dp$/i.test(r)),
  );

  report.info.push(`ETL-Boxfile verwendet (${market}): ${etl.selectedBox.fileName}`);
  report.info.push(`ETL meal ids aus Boxfile: ${etl.selectedBox.mealIds.size}`);
  report.info.push(`ETL meal ids aus CO2: ${etl.co2MealIds.size}`);

  for (const id of [...etl.selectedBox.mealIds].sort()) {
    if (!rackMealIds.has(id)) {
      report.errors.push(`ETL Boxfile Recipe fehlt im Rackfile: ${id}`);
    }
  }
  for (const id of [...rackMealIds].sort()) {
    if (!etl.selectedBox.mealIds.has(id)) {
      report.warnings.push(`Recipe im Rackfile, aber nicht im ETL Boxfile: ${id}`);
    }
  }

  for (const id of [...etl.co2MealIds].sort()) {
    if (!rackMealIds.has(id)) {
      report.errors.push(`ETL CO2 Recipe fehlt im Rackfile: ${id}`);
    }
  }

  for (const rec of [...etl.selectedBox.iceRecipes].sort()) {
    if (!rackRecipes.has(rec)) {
      report.errors.push(`Ice aus Boxfile fehlt im Rackfile: ${rec}`);
    }
  }
  for (const rec of [...etl.selectedBox.loyaltyRecipes].sort()) {
    if (!rackRecipes.has(rec)) {
      report.warnings.push(`Loyalty aus Boxfile fehlt im Rackfile: ${rec}`);
    }
  }
  for (const rec of [...etl.selectedBox.giftRecipes].sort()) {
    if (!rackRecipes.has(rec)) {
      report.warnings.push(`Gift aus Boxfile fehlt im Rackfile: ${rec}`);
    }
  }
  for (const rec of [...etl.selectedBox.boxRecipes].sort()) {
    if (!rackRecipes.has(rec)) {
      report.warnings.push(`BoxSize aus Boxfile fehlt im Rackfile: ${rec}`);
    }
  }
  for (const rec of [...etl.selectedBox.pouchRecipes].sort()) {
    const hasPouch = [...rackRecipes].some((r) => r === rec || r.startsWith(rec));
    if (!hasPouch) {
      report.warnings.push(`Coolpouch aus Boxfile fehlt im Rackfile: ${rec}`);
    }
  }
}

function toCsv(rows: RackfileRow[]): string {
  const header = [
    "Recipe",
    "Line",
    "FlowRackPosition",
    "Quantity",
    "SKU",
    "Ingredient",
    "ScanRegEx",
    "LabelPos",
    "UniCode",
    "DisplayName",
    "Gramage",
    "Sort",
  ];

  const esc = (v: unknown) => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes("\n") || s.includes("\"")) {
      return `"${s.replaceAll("\"", "\"\"")}"`;
    }
    return s;
  };

  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      esc(r.Recipe),
      esc(r.Line),
      esc(r.FlowRackPosition),
      esc(r.Quantity),
      esc(r.SKU),
      esc(r.Ingredient),
      esc(r.ScanRegEx),
      esc(r.LabelPos),
      esc(r.UniCode),
      esc(r.DisplayName),
      esc(r.Gramage),
      esc(r.Sort),
    ].join(","));
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const { command, args } = parseArgv(process.argv.slice(2));

  const workspaceRoot = process.cwd().includes(`${path.sep}scratch`)
    ? path.resolve(process.cwd(), "..")
    : process.cwd();

  const market = (args.get("market") ?? "de") as Market;
  if (!profiles[market]) {
    console.error(`Ungueltiger Markt: ${market}. Erlaubt: de, nordics`);
    process.exit(1);
  }
  const profile = profiles[market];

  const week = args.get("week") ?? currentWeekISO();
  const excelPath = args.get("excel")
    ? path.resolve(workspaceRoot, args.get("excel")!)
    : findLatestMultilineXlsx(workspaceRoot);

  const report: ValidationReport = {
    ok: false,
    errors: [],
    warnings: [],
    info: [],
  };

  if (!excelPath) {
    report.errors.push("Keine Excel-Quelle gefunden. Lege ein MultiLine*.xlsx in scratch ab oder gib --excel an.");
  } else if (!fs.existsSync(excelPath)) {
    report.errors.push(`Excel-Datei nicht gefunden: ${excelPath}`);
  }

  const sheetName = args.get("sheet") ?? profile.sheet;
  const lines = (args.get("lines") ?? profile.lines.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    report.errors.push("Keine Ziel-Linien gesetzt. Nutze --lines ASL3,ASL4");
  }

  let extras: ExtraItem[] = [];
  const extrasPathRaw = args.get("extras");
  if (extrasPathRaw) {
    const extrasPath = path.resolve(workspaceRoot, extrasPathRaw);
    if (!fs.existsSync(extrasPath)) {
      report.errors.push(`Extras-Datei fehlt: ${extrasPathRaw}`);
    } else {
      try {
        extras = readJsonArray<ExtraItem>(extrasPath);
      } catch (e) {
        report.errors.push(`Extras-Datei ungueltig: ${(e as Error).message}`);
      }
    }
  }

  let pdlIds: Set<string> | null = null;
  const pdlPathRaw = args.get("pdl");
  if (pdlPathRaw) {
    const pdlPath = path.resolve(workspaceRoot, pdlPathRaw);
    if (!fs.existsSync(pdlPath)) {
      report.errors.push(`PDL-Datei fehlt: ${pdlPathRaw}`);
    } else {
      try {
        pdlIds = readPdlRecipeIds(pdlPath);
        report.info.push(`PDL-Meal-IDs geladen: ${pdlIds.size}`);
      } catch (e) {
        report.errors.push(`PDL-Datei ungueltig: ${(e as Error).message}`);
      }
    }
  }

  const etlRootRaw = args.get("etl-root") ?? DEFAULT_ETL_ROOT;
  const skipEtl = args.get("skip-etl") === "true";
  const etlSnapshot = !skipEtl ? await loadEtlSnapshot(etlRootRaw, week, market, report) : null;
  if (etlSnapshot) {
    report.info.push(`ETL Root: ${etlRootRaw}`);
    report.info.push(`ETL Woche: ${etlSnapshot.weekPath}`);
  }

  let baseRows: SourceRow[] = [];
  if (report.errors.length === 0 && excelPath) {
    baseRows = await readSheetRows(excelPath, sheetName, report);
  }

  const finalRows = report.errors.length === 0 ? buildRows(baseRows, lines, extras) : [];
  if (report.errors.length === 0) {
    validateData(baseRows, finalRows, profile, lines, report);
    if (pdlIds) {
      validateAgainstPdl(finalRows, pdlIds, report);
    }
    if (etlSnapshot) {
      validateAgainstEtl(finalRows, market, etlSnapshot, report);
    }
  }

  report.ok = report.errors.length === 0;

  console.log("=== Rackfile Plan Report ===");
  console.log(`Markt: ${market}`);
  console.log(`Woche: ${week}`);
  console.log(`Excel: ${excelPath ?? "-"}`);
  console.log(`Sheet: ${sheetName}`);
  console.log(`Linien: ${lines.join(", ")}`);
  console.log(`Rows Source: ${baseRows.length}`);
  console.log(`Rows Final: ${finalRows.length}`);

  for (const msg of report.info) console.log(`[INFO] ${msg}`);
  for (const msg of report.warnings) console.log(`[WARN] ${msg}`);
  for (const msg of report.errors) console.log(`[ERROR] ${msg}`);

  if (command === "plan") {
    const reportOut = args.get("report")
      ? path.resolve(workspaceRoot, args.get("report")!)
      : path.join(workspaceRoot, "scratch", "rackfile-plan-report.json");

    fs.writeFileSync(reportOut, JSON.stringify(report, null, 2), "utf-8");
    console.log(`Report geschrieben: ${reportOut}`);
    process.exit(report.ok ? 0 : 1);
  }

  if (command !== "generate") {
    console.error(`Unbekannter Command: ${command}. Erlaubt: plan, generate`);
    process.exit(1);
  }

  if (!report.ok) {
    console.error("Abbruch: Pflichtdaten fehlen oder Validierung fehlgeschlagen.");
    process.exit(1);
  }

  const outputRaw = args.get("out") ?? profile.outputName(week, lines);
  const outPath = path.resolve(workspaceRoot, outputRaw.endsWith(".csv") ? outputRaw : `${outputRaw}.csv`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, toCsv(finalRows), "utf-8");
  console.log(`Rackfile geschrieben: ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
