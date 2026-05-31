// Liest PFEI-MAIN ("[EU] F_ Recipe PFEI", Tab MAIN) live ein.
//
// Sheet-Schema (per FORMULA-Inspect verifiziert):
//   A=Recipe Name           B=Sub-Recipe ID (SUB-…)        C=Product Family
//   F=Batch Constraint (= primary station / engster Pass)
//   G=Batch Size            H=UOM
//   I..AF (cols 9..32)  → Block 1: Minuten pro Batch je Station (24 Stationen)
//                         = Manual_Moves_EU + Default aus 'Product Families'!AC..AZ
//   BE..BB? Tatsächlich Block 3: cols 57..80 → Hold-/Cool-Time per Station
//   CE (col 81)         → Hygienic_Flag (TRUE/FALSE/leer)
//
// Stations-Reihenfolge ist exakt die in src/types.ts definierte STATIONS-Konstante.

import { google } from "googleapis";
import type { ProcessSpec, Station } from "../src/types.ts";
import { STATIONS } from "../src/types.ts";
import { numOpt as num } from "./lib/helpers.ts";

export async function readPfei(): Promise<Record<string, ProcessSpec>> {
  const PFEI_ID = process.env.PFEI_GSHEET_ID ?? "";
  if (!PFEI_ID) {
    console.warn("  PFEI_GSHEET_ID nicht gesetzt — überspringe PFEI-Import");
    return {};
  }
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() as any });

  // A2:CE10000 abdeckt alle 81 Spalten (A..CE) ohne Headerzeile.
  const range = "MAIN!A2:CE12000";
  let rows: any[][];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: PFEI_ID,
      range,
      valueRenderOption: "UNFORMATTED_VALUE"
    });
    rows = res.data.values ?? [];
  } catch (e: any) {
    console.warn(`  PFEI-Sheet konnte nicht gelesen werden: ${e?.message ?? e}`);
    return {};
  }

  const out: Record<string, ProcessSpec> = {};
  let used = 0;
  for (const row of rows) {
    const subId = (row[1] || "").toString().trim();
    if (!subId || !/^SUB-/i.test(subId)) continue;

    const minutesPerBatch: Partial<Record<Station, number>> = {};
    const holdTimeMin: Partial<Record<Station, number>> = {};

    // Block 1: cols 9..32 (24 Stationen, gleiche Reihenfolge wie STATIONS)
    for (let i = 0; i < STATIONS.length; i++) {
      const v = num(row[8 + i]);
      if (v !== undefined && v > 0) minutesPerBatch[STATIONS[i]] = v;
    }
    // Block 3: cols 57..80 (24 Stationen)
    for (let i = 0; i < STATIONS.length; i++) {
      const v = num(row[56 + i]);
      if (v !== undefined && v > 0) holdTimeMin[STATIONS[i]] = v;
    }

    // primaryStation darf leer sein (in einigen Zeilen #N/A)
    const constraint = (row[5] || "").toString().trim();
    const primary = constraint && !/^#/.test(constraint) ? constraint : undefined;
    const hygienicCell = row[80];
    const hygienic = hygienicCell === true ||
      (typeof hygienicCell === "string" && /^true$/i.test(hygienicCell));

    out[subId] = {
      subRecipeId: subId,
      name: (row[0] || "").toString().trim(),
      productFamily: (row[2] || "").toString().trim() || undefined,
      primaryStation: primary,
      batchSizeKg: num(row[6]),
      batchUom: (row[7] || "").toString().trim() || undefined,
      hygienic: hygienic || undefined,
      minutesPerBatch,
      holdTimeMin
    };
    used++;
  }
  console.log(`  PFEI: ${used} Sub-Rezepte importiert`);
  return out;
}
