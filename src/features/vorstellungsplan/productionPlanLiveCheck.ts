// Live-Vergleich: eine Production-Plan-Zeile (im Sheet bereits fertig
// berechnet, siehe parseProductionPlan.ts) gegen das, was "Forecast"/"Recipe
// Profil" GERADE JETZT sagen. Kein Ersatz für die Sheet-Werte -- die App holt
// weiterhin die vom Sheet fertig berechneten Zahlen (FORMATTED_VALUE). Der
// Live-Check ist nur ein Frühwarn-Hinweis für den häufigsten praktischen
// Fehlerfall: eine neue Meal-Zeile im Sheet, bei der Marcel die VLOOKUP-
// Formeln (I-T) noch nicht heruntergezogen hat -- dann ist z.B. Complexity/
// Allergene im Sheet leer, obwohl Recipe Profil den Rezeptcode längst kennt.
// Erster Baustein von Marcels Live-View-Verknüpfung (2026-08-24) -- Snowflake/
// WMS/Redzone/Postblast folgen als eigene Quellen nach demselben Muster.
import type { ForecastRow, ProductionPlanRow, RecipeProfilRow } from "../gsheet-monitor/gsheetTypes";

export interface ProductionPlanFieldMismatch {
  label: string;
  sheetValue: string;
  liveValue: string;
  source: "Forecast" | "Recipe Profil";
}

const STATION_LABELS: ReadonlyArray<{ key: keyof ProductionPlanRow["stations"]; label: string }> = [
  { key: "grill", label: "Grill" }, { key: "cup", label: "Cup" }, { key: "butter", label: "Butter" },
  { key: "oven", label: "Oven" }, { key: "braiser", label: "Braiser" }, { key: "slice", label: "Slice" },
];

function fmt(n: number | null): string {
  return n == null ? "–" : String(n);
}

export function crossCheckProductionPlanRow(
  row: ProductionPlanRow,
  forecastByCode: Map<string, ForecastRow> | undefined,
  recipeProfilByCode: Map<string, RecipeProfilRow> | undefined,
): ProductionPlanFieldMismatch[] {
  const mismatches: ProductionPlanFieldMismatch[] = [];

  const fc = forecastByCode?.get(row.code);
  if (fc && fc.total !== row.total) {
    mismatches.push({ label: "Total", sheetValue: fmt(row.total), liveValue: fmt(fc.total), source: "Forecast" });
  }

  const rp = recipeProfilByCode?.get(row.code);
  if (rp) {
    if (rp.complexityScore != null && (row.complexityScore == null || Math.abs(rp.complexityScore - row.complexityScore) > 0.01)) {
      mismatches.push({ label: "Complexity Score", sheetValue: fmt(row.complexityScore), liveValue: rp.complexityScore.toFixed(2), source: "Recipe Profil" });
    }
    if (rp.subCount != null && rp.subCount !== row.subCount) {
      mismatches.push({ label: "# Subs", sheetValue: fmt(row.subCount), liveValue: fmt(rp.subCount), source: "Recipe Profil" });
    }
    if (rp.cookStationCount != null && rp.cookStationCount !== row.cookStationCount) {
      mismatches.push({ label: "# Cook Stations", sheetValue: fmt(row.cookStationCount), liveValue: fmt(rp.cookStationCount), source: "Recipe Profil" });
    }
    if (rp.activeCookMin != null && rp.activeCookMin !== row.activeCookMin) {
      mismatches.push({ label: "Active Cook Min", sheetValue: fmt(row.activeCookMin), liveValue: fmt(rp.activeCookMin), source: "Recipe Profil" });
    }
    if (rp.passiveHoldMin != null && rp.passiveHoldMin !== row.passiveHoldMin) {
      mismatches.push({ label: "Passive Hold Min", sheetValue: fmt(row.passiveHoldMin), liveValue: fmt(rp.passiveHoldMin), source: "Recipe Profil" });
    }
    const rpAllergens = rp.allergens.trim();
    if (rpAllergens && rpAllergens.toLowerCase() !== row.allergens.trim().toLowerCase()) {
      mismatches.push({ label: "Allergene", sheetValue: row.allergens || "–", liveValue: rpAllergens, source: "Recipe Profil" });
    }
    for (const s of STATION_LABELS) {
      const expected = rp.stationsText.toLowerCase().includes(s.label.toLowerCase());
      const actual = row.stations[s.key];
      if (expected !== actual) {
        mismatches.push({ label: `Station: ${s.label}`, sheetValue: actual ? "X" : "–", liveValue: expected ? "X" : "–", source: "Recipe Profil" });
      }
    }
  }

  return mismatches;
}
