import { useState } from "react";
import type { DataBundle } from "../types";

interface HealthIssue { label: string; fix: string }

export function DataHealthBanner({ data }: { data: DataBundle }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const issues: HealthIssue[] = [];

  const recipeCount  = Object.keys(data.recipes).length;
  const wrCount      = data.weekRecipes.length;
  const scheduleCount = Object.keys(data.cookSchedules).length;
  const specCount    = Object.keys(data.processSpecs ?? {}).length;
  const structCount  = Object.keys(data.structures ?? {}).length;
  const shelfCount   = Object.keys(data.shelfLifeBySku ?? {}).length;

  if (wrCount === 0)
    issues.push({ label: "Keine Rezepte geladen", fix: "Ramp-Up GSheet (GSHEET_ID) nicht erreichbar — Cloud Function prüfen oder npm run import:gsheet ausführen" });

  if (recipeCount === 0)
    issues.push({ label: "Keine Rezeptdaten (Zutaten, MSKUs)", fix: "export-sub-recipes-by-recipe-detailed.csv in imports/ ablegen → npm run import:local" });
  else if (wrCount > 0) {
    const matched = data.weekRecipes.filter(wr => !!data.recipes[wr.code]).length;
    const pct = Math.round((matched / wrCount) * 100);
    if (pct < 60)
      issues.push({ label: `Rezept-Match nur ${pct} %`, fix: "export-sub-recipes-by-recipe-detailed.csv ist veraltet — neuen Export aus Culinary-Tool in imports/ legen → npm run import:local" });
  }

  if (structCount === 0)
    issues.push({ label: "Kein Rezeptbaum (Sub-Rezepte)", fix: "export-sub-recipes-by-recipe-detailed.csv fehlt in imports/" });

  if (scheduleCount === 0)
    issues.push({ label: "Keine Cook Schedules (D-2/D-1/D0)", fix: "Cook Schedules Per DC.csv fehlt in imports/ → npm run import:local" });

  if (specCount === 0)
    issues.push({ label: "Keine PFEI-Daten (Batch-Größen)", fix: "PFEI GSheet nicht importiert → npm run import:pfei && npm run push:firestore" });

  if (shelfCount === 0)
    issues.push({ label: "Kein Shelf-Life (MHD-Status)", fix: "Open Shelf Life GSheet nicht erreichbar — Google-Credentials prüfen → npm run import:local" });

  if (!data.productionPlan)
    issues.push({ label: "Kein Fertigstellungszeitplan", fix: "Sheet 6 (SHEET_FERTIGSTELLUNG) fehlt — Cloud Function refresh-operational oder npm run import:gsheet" });

  if (issues.length === 0) return null;

  return (
    <div className="mb-4 rounded-xl bg-amber-50 ring-1 ring-amber-300 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-bold uppercase tracking-wide text-amber-800">
          ⚠ {issues.length} Datenlücke{issues.length > 1 ? "n" : ""} erkannt
        </div>
        <button onClick={() => setDismissed(true)}
          className="text-amber-500 hover:text-amber-800 text-xs font-semibold shrink-0">✕ ausblenden</button>
      </div>
      <ul className="mt-2 space-y-1.5">
        {issues.map((issue, i) => (
          <li key={i} className="text-xs text-amber-900">
            <span className="font-semibold">{issue.label}:</span>{" "}
            <span className="text-amber-800">{issue.fix}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
