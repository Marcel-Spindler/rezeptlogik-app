// import-recipe-profiles.ts
// ---------------------------------------------------------------------------
// Zieht den Tab "Recipe Profil" aus Marcels Plating-Plan-GSheet (oeffentlich per
// gviz-CSV, KEIN Login / Service-Account noetig) und schreibt daraus
//   public/data/recipe-profiles.json
// die "Complexity Score"-Referenzdaten pro Rezept (Cook-Zeit, Kochstationen,
// Sub-Anzahl, Bottleneck-Batch, Complexity raw/cx, Allergene, Passive-Hold).
//
// Der "Recipe Profil"-Tab ist selbst nur ein IMPORTRANGE aus einem weiteren,
// login-geschuetzten "live MSKU"-Sheet -> die vier Roh-Inputs (Active cook min,
// # Cook stations, # Subs, Bottleneck) lassen sich in der App NICHT
// verlaesslich aus structures/processSpecs nachbauen (andere Stations-Taxonomie,
// aktiv/passiv-Trennung). Darum dieser schlanke Referenz-Import.
//
// Complexity-Formel (im Sheet verifiziert, 163/163 Zeilen exakt):
//   raw = w_cycle*activeCookMin + w_stations*#stations + w_subs*#subs
//         + w_batch*(1000 / bottleneckPortionsPerBatch)
//   cx  = raw / median(raw ueber alle Rezepte)      (Median-Meal => 1.0)
//   Gewichte aktuell: w_cycle=1, w_stations=15, w_subs=8, w_batch=1
//
// Aufruf:  npm run import:recipe-profiles
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RecipeProfile } from "../src/core/types.ts";

const SHEET_ID = process.env.SHEET_PLATING_PLAN ?? "1zaQjWKlNN4JNCMnE-lrdgf7iNgabfl9HGq5vdOyKedI";
const TAB = "Recipe Profil";
const OUT = resolve("public/data/recipe-profiles.json");

/** Minimaler RFC-4180-CSV-Parser (Anfuehrungszeichen, eingebettete Kommata / Zeilenumbrueche). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* skip */ }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function num(v: string | undefined): number {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function splitStations(v: string | undefined): string[] {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function median(xs: number[]): number {
  if (!xs.length) return 1;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(TAB)}`;
  console.log(`Lese Tab "${TAB}" (gviz-CSV, ohne Login) …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} beim Abruf des Sheets`);
  const rows = parseCsv(await res.text());

  // Gewichte: Zeile "(edit B3:E3 →)","1","15","8","1"
  const weightRow = rows.find((r) => /edit\s+B3/i.test(r[0] ?? ""));
  const weights = {
    cycle: weightRow ? num(weightRow[1]) : 1,
    stations: weightRow ? num(weightRow[2]) : 15,
    subs: weightRow ? num(weightRow[3]) : 8,
    batch: weightRow ? num(weightRow[4]) : 1,
  };
  console.log(
    `  Gewichte: w_cycle=${weights.cycle} w_stations=${weights.stations} ` +
    `w_subs=${weights.subs} w_batch=${weights.batch}`,
  );

  // Datenzeilen: Spalte A = FV-Code
  const dataRows = rows.filter((r) => /^FV[A-Z0-9]+$/i.test((r[0] ?? "").trim()));
  if (dataRows.length < 20) {
    throw new Error(`Nur ${dataRows.length} Datenzeilen gefunden — Sheet-Layout geaendert?`);
  }

  interface Raw {
    code: string; activeCookMin: number; numCookStations: number; numSubs: number;
    bottleneckPortionsPerBatch: number; sheetRaw: number; sheetCx: number;
    cookStations: string[]; allergens: string; traces: string; passiveHoldMin: number;
  }
  const raws: Raw[] = dataRows.map((r) => ({
    code: r[0].trim().toUpperCase(),
    activeCookMin: num(r[2]),
    numCookStations: num(r[3]),
    numSubs: num(r[4]),
    bottleneckPortionsPerBatch: num(r[5]),
    sheetRaw: num(r[6]),
    sheetCx: num(r[7]),
    cookStations: splitStations(r[8]),
    allergens: (r[9] ?? "").trim(),
    traces: (r[10] ?? "").trim(),
    passiveHoldMin: num(r[12]),
  }));

  const computeRaw = (x: Raw): number =>
    weights.cycle * x.activeCookMin +
    weights.stations * x.numCookStations +
    weights.subs * x.numSubs +
    (x.bottleneckPortionsPerBatch > 0 ? weights.batch * (1000 / x.bottleneckPortionsPerBatch) : 0);

  const medianRaw = median(raws.map(computeRaw).filter((n) => n > 0));

  // Sanity: neu berechnetes raw ggue. Sheet-Wert
  let drift = 0;
  const profiles: Record<string, RecipeProfile> = {};
  for (const x of raws) {
    const complexityRaw = Math.round(computeRaw(x) * 1000) / 1000;
    if (x.sheetRaw > 0 && Math.abs(complexityRaw - x.sheetRaw) > 1) drift++;
    profiles[x.code] = {
      code: x.code,
      activeCookMin: x.activeCookMin,
      numCookStations: x.numCookStations,
      numSubs: x.numSubs,
      bottleneckPortionsPerBatch: x.bottleneckPortionsPerBatch,
      complexityRaw,
      complexityCx: Math.round((complexityRaw / medianRaw) * 1_000_000) / 1_000_000,
      cookStations: x.cookStations,
      allergens: x.allergens,
      traces: x.traces,
      passiveHoldMin: x.passiveHoldMin,
    };
  }
  if (drift) console.warn(`  ⚠ ${drift} Zeilen weichen >1 vom Sheet-„Complexity raw" ab (Sheet evtl. hand-getunt).`);

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceSheetId: SHEET_ID,
    weights,
    medianRaw: Math.round(medianRaw * 1000) / 1000,
    profiles,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 0) + "\n", "utf8");
  console.log(`\n✓ ${Object.keys(profiles).length} Rezept-Profile → ${OUT}`);
  console.log(`  median(raw) = ${payload.medianRaw}`);
}

main().catch((e) => { console.error("FEHLER:", e?.message ?? e); process.exitCode = 1; });
