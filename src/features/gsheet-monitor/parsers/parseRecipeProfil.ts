// GSheet Monitor – Recipe-Profil-Parser ("F_VE Production Plan"-Sheet, Tab
// "Recipe Profil"). Speist Complexity/Subs/Cook-Stationen/Active+Passive-Min/
// Stationsflags/Allergene im Production-Plan-Tab per VLOOKUP (siehe
// parseProductionPlan.ts-Kommentar) -- wird hier NICHT zum Ersatz geparst,
// sondern für den Live-Vergleich (productionPlanLiveCheck.ts). Global, nicht
// wochenweise (ein Rezeptcode hat nur ein Profil).
//
// Header steht in der Zeile mit "FV code" in Spalte A (Zeilen 1-3 sind Titel/
// Gewichte für die sheet-interne Complexity-Berechnung, hier irrelevant).
// Spalten (0-indiziert): A(0) FV code, B(1) Recipe, C(2) Active cook min,
// D(3) # Cook stations, E(4) # Subs, G(6) Complexity raw, H(7) Complexity cx,
// I(8) Cook stations (Rohtext), J(9) Allergens, M(12) Passive hold min.
import type { RecipeProfilData, RecipeProfilRow } from "../gsheetTypes";

function parseIntCell(raw: string): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const n = parseInt(trimmed.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatCell(raw: string): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseRecipeProfil(rows: string[][]): RecipeProfilData {
  const headerIdx = rows.findIndex(r => (r[0] ?? "").trim() === "FV code");
  const result: RecipeProfilRow[] = [];
  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const code = (row[0] ?? "").trim();
      if (!code) continue;
      result.push({
        code,
        recipeName: (row[1] ?? "").trim(),
        activeCookMin: parseIntCell(row[2] ?? ""),
        cookStationCount: parseIntCell(row[3] ?? ""),
        subCount: parseIntCell(row[4] ?? ""),
        complexityScore: parseFloatCell(row[7] ?? ""),
        stationsText: (row[8] ?? "").trim(),
        allergens: (row[9] ?? "").trim(),
        passiveHoldMin: parseIntCell(row[12] ?? ""),
      });
    }
  }
  const byCode = new Map(result.map(r => [r.code, r] as const));
  return { rows: result, byCode, lastUpdated: Date.now() };
}
