import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Papa from "papaparse";

type Row = Record<string, string>;

type TranslationRow = {
  factorId: string;
  mealName?: string;
  dutchName?: string;
  danishName?: string;
  deName?: string;
  swedishName?: string;
  internalSkuDutch?: string;
  internalSkuNordics?: string;
  internalSkuDE?: string;
};

function norm(v: unknown): string | undefined {
  const s = String(v ?? "").trim();
  if (!s || s === "#N/A" || s === "#REF!") return undefined;
  return s;
}

function main() {
  const inFile = resolve("public", "data", "gsheet-truth-export", "Import Meal Database.csv");
  if (!existsSync(inFile)) {
    throw new Error(`Input fehlt: ${inFile}`);
  }

  const text = readFileSync(inFile, "utf8").replace(/^\uFEFF/, "");
  const parsed = Papa.parse<Row>(text, {
    header: true,
    skipEmptyLines: true
  });

  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(`CSV-Parse-Fehler: ${first.message}`);
  }

  const outRows: TranslationRow[] = [];
  for (const row of parsed.data) {
    const factorId = norm(row["Factor ID"]);
    if (!factorId) continue;

    outRows.push({
      factorId,
      mealName: norm(row["Meal Name"]),
      dutchName: norm(row["Dutch name"]),
      danishName: norm(row["Danish name"]),
      deName: norm(row["DE Name"]),
      swedishName: norm(row["Swedish name"]),
      internalSkuDutch: norm(row["Internal SKU (Dutch)"]),
      internalSkuNordics: norm(row["Internal SKU (NOR)"]),
      internalSkuDE: norm(row["Internal SKU (DE)"])
    });
  }

  outRows.sort((a, b) => a.factorId.localeCompare(b.factorId));

  const outDir = resolve("public", "data");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const jsonFile = join(outDir, "meal-translations-by-market.json");
  writeFileSync(
    jsonFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "Import Meal Database",
        count: outRows.length,
        items: outRows
      },
      null,
      2
    )
  );

  const csvFile = join(outDir, "meal-translations-by-market.csv");
  const header = [
    "Factor ID",
    "Meal Name",
    "Dutch name",
    "Danish name",
    "DE Name",
    "Swedish name",
    "Internal SKU (Dutch)",
    "Internal SKU (NOR)",
    "Internal SKU (DE)"
  ];
  const lines = [header.join(",")];
  for (const r of outRows) {
    const vals = [
      r.factorId,
      r.mealName,
      r.dutchName,
      r.danishName,
      r.deName,
      r.swedishName,
      r.internalSkuDutch,
      r.internalSkuNordics,
      r.internalSkuDE
    ].map((v) => `"${String(v ?? "").replaceAll("\"", "\"\"")}"`);
    lines.push(vals.join(","));
  }
  writeFileSync(csvFile, lines.join("\n"));

  console.log(`Translations extrahiert: ${outRows.length}`);
  console.log(`JSON: ${jsonFile}`);
  console.log(`CSV:  ${csvFile}`);
}

main();
