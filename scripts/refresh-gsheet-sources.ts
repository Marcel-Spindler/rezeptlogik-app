import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { google } from "googleapis";

loadEnv({ path: ".env.local" });
loadEnv();

const DEFAULT_OPEN_SHELF_GSHEET_ID = "1dET5WmRKYRhmzEmhlBv1ZpRo5huWgNLfIY6uaLpCrcc";
const DEFAULT_OPEN_SHELF_TAB = "ALL in 1";
const KPL_GSHEET_ID = "13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U";
const FACTOR_FORECAST_FOLDER_ID =
  process.env.FACTOR_FORECAST_FOLDER_ID?.trim() ??
  "1Q2OTboR_X4tCGjsaag55C2WFURRpi-i2";

const OUT_DIR = resolve("public", "data");
const REGISTRY_FILE = join(OUT_DIR, "gsheet-sources.json");
const KEY_FILE = resolve("secrets", "service-account.json");

type DumpSheet = {
  title: string;
  sheetId: number;
  index?: number;
  hidden?: boolean;
  rowCount?: number;
  columnCount?: number;
  values: string[][];
};

type DumpFile = {
  generatedAt: string;
  spreadsheetId: string;
  spreadsheetTitle?: string;
  locale?: string;
  timeZone?: string;
  sheetCount: number;
  sheets: DumpSheet[];
};

type SpreadsheetSourceSeed = {
  spreadsheetId: string;
  label: string;
  purpose: string;
  envKey?: string;
  tabHint?: string;
  tags: string[];
};

type SpreadsheetSource = SpreadsheetSourceSeed & {
  aliases: string[];
  dumpFile?: string;
};

type SourceRegistryEntry = {
  spreadsheetId: string;
  title: string;
  purpose: string;
  aliases: string[];
  tags: string[];
  envKey?: string;
  tabHint?: string;
  dumpFile: string;
  generatedAt: string;
  sheetCount: number;
  totalRows: number;
  locale?: string;
  timeZone?: string;
  sheets: Array<{
    title: string;
    rowCount: number;
    columnCount: number;
    hidden: boolean;
  }>;
};

function safeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "sheet";
}

function addSeed(map: Map<string, SpreadsheetSource>, seed: SpreadsheetSourceSeed & { dumpFile?: string }) {
  const existing = map.get(seed.spreadsheetId);
  if (existing) {
    existing.aliases = Array.from(new Set([...existing.aliases, seed.label]));
    existing.tags = Array.from(new Set([...existing.tags, ...seed.tags]));
    if (!existing.envKey && seed.envKey) existing.envKey = seed.envKey;
    if (!existing.tabHint && seed.tabHint) existing.tabHint = seed.tabHint;
    if (!existing.dumpFile && seed.dumpFile) existing.dumpFile = seed.dumpFile;
    if (!existing.purpose && seed.purpose) existing.purpose = seed.purpose;
    return;
  }
  map.set(seed.spreadsheetId, {
    ...seed,
    aliases: [seed.label],
  });
}

function collectSourceSeeds(): Map<string, SpreadsheetSource> {
  const sources = new Map<string, SpreadsheetSource>();
  const mainId = process.env.GSHEET_ID?.trim();
  const extraIds = (process.env.GSHEET_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const pfeiId = process.env.PFEI_GSHEET_ID?.trim();
  const openShelfId = process.env.OPEN_SHELF_GSHEET_ID?.trim() || DEFAULT_OPEN_SHELF_GSHEET_ID;
  const openShelfTab = process.env.OPEN_SHELF_GSHEET_TAB?.trim() || DEFAULT_OPEN_SHELF_TAB;

  if (mainId) {
    addSeed(sources, {
      spreadsheetId: mainId,
      label: "Forecast Tracker",
      purpose: "Hauptsheet fuer Wochen-Rezepte, W-KWs und Ramp-up Truth Source",
      envKey: "GSHEET_ID",
      tags: ["import", "forecast", "truth"],
    });
  }

  extraIds.forEach((spreadsheetId, index) => {
    addSeed(sources, {
      spreadsheetId,
      label: `Zusatzsheet ${index + 1}`,
      purpose: "Weitere Meal-/Ramp-up Quelle fuer den Live-Import",
      envKey: "GSHEET_IDS",
      tags: ["import", "ramp-up"],
    });
  });

  if (pfeiId) {
    addSeed(sources, {
      spreadsheetId: pfeiId,
      label: "PFEI",
      purpose: "Equipment-, Batch- und Prozessdaten pro Sub-Rezept",
      envKey: "PFEI_GSHEET_ID",
      tabHint: "MAIN",
      tags: ["process", "equipment", "batch"],
    });
  }

  addSeed(sources, {
    spreadsheetId: openShelfId,
    label: "Open Shelf Life",
    purpose: "MLOR- und Open-Shelf-Life Daten fuer SKU-Risiken",
    envKey: "OPEN_SHELF_GSHEET_ID",
    tabHint: openShelfTab,
    tags: ["quality", "shelf-life"],
  });

  addSeed(sources, {
    spreadsheetId: KPL_GSHEET_ID,
    label: "Kitchen Priority List",
    purpose: "KPL Dump fuer Planning OASE, Rack und Linienplanung",
    tags: ["planning-oase", "kpl", "ops"],
  });

  for (const fileName of readdirSync(OUT_DIR)) {
    if (!fileName.startsWith("gsheet-dump-") || !fileName.endsWith(".json")) continue;
    const dumpPath = join(OUT_DIR, fileName);
    try {
      const parsed = JSON.parse(readFileSync(dumpPath, "utf8")) as Partial<DumpFile>;
      const spreadsheetId = parsed.spreadsheetId?.trim();
      if (!spreadsheetId) continue;
      addSeed(sources, {
        spreadsheetId,
        label: parsed.spreadsheetTitle?.trim() || fileName,
        purpose: "Bestehender Spreadsheet-Dump im Frontend",
        tags: ["dump"],
        dumpFile: `/data/${fileName}`,
      });
    } catch {
      // ignore unreadable old dumps
    }
  }

  return sources;
}

async function dumpSpreadsheet(
  sheetsApi: ReturnType<typeof google.sheets>,
  spreadsheetId: string
): Promise<DumpFile> {
  const metaRes = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    includeGridData: false,
  });

  const spreadsheetTitle = metaRes.data.properties?.title ?? spreadsheetId;
  const locale = metaRes.data.properties?.locale ?? undefined;
  const timeZone = metaRes.data.properties?.timeZone ?? undefined;

  const outSheets: DumpSheet[] = [];
  for (const sh of metaRes.data.sheets ?? []) {
    const properties = sh.properties;
    if (!properties?.title || properties.sheetId == null) continue;
    const range = `'${properties.title.replace(/'/g, "''")}'`;
    let values: string[][] = [];
    try {
      const valuesRes = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range });
      values = (valuesRes.data.values as string[][] | undefined) ?? [];
    } catch (error: any) {
      values = [[`__READ_ERROR__: ${error?.message ?? String(error)}`]];
    }
    outSheets.push({
      title: properties.title,
      sheetId: properties.sheetId,
      index: properties.index ?? undefined,
      hidden: properties.hidden ?? undefined,
      rowCount: properties.gridProperties?.rowCount ?? undefined,
      columnCount: properties.gridProperties?.columnCount ?? undefined,
      values,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    spreadsheetId,
    spreadsheetTitle,
    locale,
    timeZone,
    sheetCount: outSheets.length,
    sheets: outSheets,
  };
}

async function main() {
  if (!existsSync(KEY_FILE)) {
    throw new Error(`Service-Account-Datei fehlt: ${KEY_FILE}`);
  }
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  process.env.GOOGLE_APPLICATION_CREDENTIALS = KEY_FILE;
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    keyFile: KEY_FILE,
  });
  const sheetsApi = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  const sourceSeeds = collectSourceSeeds();
  const entries: SourceRegistryEntry[] = [];

  for (const source of [...sourceSeeds.values()].sort((a, b) => a.label.localeCompare(b.label, "de-DE"))) {
    console.log(`Aktualisiere ${source.label} (${source.spreadsheetId}) ...`);
    const dump = await dumpSpreadsheet(sheetsApi, source.spreadsheetId);
    const outFileName = `gsheet-dump-${safeName(dump.spreadsheetTitle ?? source.label)}.json`;
    const outFile = join(OUT_DIR, outFileName);
    writeFileSync(outFile, JSON.stringify(dump));

    const totalRows = dump.sheets.reduce((sum, sheet) => sum + sheet.values.length, 0);
    entries.push({
      spreadsheetId: source.spreadsheetId,
      title: dump.spreadsheetTitle ?? source.label,
      purpose: source.purpose,
      aliases: Array.from(new Set([source.label, ...source.aliases])).sort((a, b) => a.localeCompare(b, "de-DE")),
      tags: [...source.tags].sort((a, b) => a.localeCompare(b, "de-DE")),
      envKey: source.envKey,
      tabHint: source.tabHint,
      dumpFile: `/data/${outFileName}`,
      generatedAt: dump.generatedAt,
      sheetCount: dump.sheetCount,
      totalRows,
      locale: dump.locale,
      timeZone: dump.timeZone,
      sheets: dump.sheets.map((sheet) => ({
        title: sheet.title,
        rowCount: sheet.values.length,
        columnCount: sheet.columnCount ?? 0,
        hidden: Boolean(sheet.hidden),
      })),
    });
  }

  const registry = {
    generatedAt: new Date().toISOString(),
    spreadsheetCount: entries.length,
    spreadsheets: entries,
    extraSources: [
      {
        type: "google-drive-folder",
        label: "Factor Daily Forecast Folder",
        sourceId: FACTOR_FORECAST_FOLDER_ID,
        purpose: "CSV-Quelle fuer Factor Daily Forecast Sync",
        outputFiles: [
          "/data/gsheet-truth-export/Factor_Daily - PDL Forecast.csv",
          "/data/factor-daily-meta.json",
        ],
      },
    ],
  };

  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  console.log(`Registry geschrieben: ${REGISTRY_FILE}`);
  console.log(`Spreadsheets aktualisiert: ${entries.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
