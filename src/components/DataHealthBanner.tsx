import { useState, useEffect } from "react";
import type { DataBundle } from "../core/types";

interface HealthIssue { label: string; fix: string; severity: "warn" | "stale" }

// Schwellenwerte für Datenalter
const STALE_WARN_H  = 2;   // >2h  → Warnung
const STALE_ERROR_H = 6;   // >6h  → kritisch

function dataAgeHours(generatedAt: string): number | null {
  if (!generatedAt) return null;
  const ts = new Date(generatedAt).getTime();
  if (!ts || isNaN(ts)) return null;
  return (Date.now() - ts) / 3_600_000;
}

export function DataHealthBanner({ data }: { data: DataBundle }) {
  const [dismissed, setDismissed] = useState(false);
  // Tick jede Minute, damit der Alterscheck live aktualisiert wird
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (dismissed) return null;

  const issues: HealthIssue[] = [];

  const recipeCount  = Object.keys(data.recipes).length;
  const wrCount      = data.weekRecipes.length;
  const specCount    = Object.keys(data.processSpecs ?? {}).length;
  const structCount  = Object.keys(data.structures ?? {}).length;
  const shelfCount   = Object.keys(data.shelfLifeBySku ?? {}).length;
  const ageH         = dataAgeHours(data.generatedAt);

  // ── Datenfreshness ──────────────────────────────────────────────────────
  if (ageH !== null && ageH >= STALE_ERROR_H) {
    const h = Math.floor(ageH);
    issues.push({
      label: `Daten ${h}h alt`,
      fix: "Daten veraltet (>6h) — Cloud Function prüfen oder npm run import:gsheet ausführen",
      severity: "stale",
    });
  } else if (ageH !== null && ageH >= STALE_WARN_H) {
    const h = Math.floor(ageH);
    issues.push({
      label: `Daten ${h}h alt`,
      fix: "Letzter Import vor über 2 Stunden — bei Bedarf npm run import:gsheet ausführen",
      severity: "warn",
    });
  }

  // ── Datenvollständigkeit ─────────────────────────────────────────────────
  if (wrCount === 0)
    issues.push({ label: "Keine Rezepte geladen", fix: "Ramp-Up GSheet (GSHEET_ID) nicht erreichbar — Cloud Function prüfen oder npm run import:gsheet ausführen", severity: "stale" });

  if (recipeCount === 0)
    issues.push({ label: "Keine Rezeptdaten (Zutaten, MSKUs)", fix: "export-sub-recipes-by-recipe-detailed.csv in imports/ ablegen → npm run import:local", severity: "warn" });
  else if (wrCount > 0) {
    const matched = data.weekRecipes.filter(wr => !!data.recipes[wr.code]).length;
    const pct = Math.round((matched / wrCount) * 100);
    if (pct < 60)
      issues.push({ label: `Rezept-Match nur ${pct} %`, fix: "export-sub-recipes-by-recipe-detailed.csv ist veraltet — neuen Export aus Culinary-Tool in imports/ legen → npm run import:local", severity: "warn" });
  }

  if (structCount === 0)
    issues.push({ label: "Kein Rezeptbaum (Sub-Rezepte)", fix: "export-sub-recipes-by-recipe-detailed.csv fehlt in imports/", severity: "warn" });

  if (specCount === 0)
    issues.push({ label: "Keine PFEI-Daten (Batch-Größen)", fix: "PFEI GSheet nicht importiert → npm run import:pfei && npm run push:firestore", severity: "warn" });

  if (shelfCount === 0)
    issues.push({ label: "Kein Shelf-Life (MHD-Status)", fix: "Open Shelf Life GSheet nicht erreichbar — Google-Credentials prüfen → npm run import:local", severity: "warn" });

  if (!data.productionPlan)
    issues.push({ label: "Kein Fertigstellungszeitplan", fix: "Sheet 6 (SHEET_FERTIGSTELLUNG) fehlt — Cloud Function refresh-operational oder npm run import:gsheet", severity: "warn" });

  if (issues.length === 0) return null;

  const hasCritical = issues.some(i => i.severity === "stale");
  const bannerCls = hasCritical
    ? "mb-4 rounded-xl bg-red-50 ring-1 ring-red-300 p-3"
    : "mb-4 rounded-xl bg-amber-50 ring-1 ring-amber-300 p-3";
  const titleCls  = hasCritical ? "text-red-800"   : "text-amber-800";
  const labelCls  = hasCritical ? "text-red-900"   : "text-amber-900";
  const fixCls    = hasCritical ? "text-red-700"   : "text-amber-800";
  const btnCls    = hasCritical ? "text-red-400 hover:text-red-800" : "text-amber-500 hover:text-amber-800";

  return (
    <div className={bannerCls}>
      <div className="flex items-start justify-between gap-2">
        <div className={`text-xs font-bold uppercase tracking-wide ${titleCls}`}>
          ⚠ {issues.length} {hasCritical ? "Datenproblem" : "Datenlücke"}{issues.length > 1 ? "n" : ""} erkannt
        </div>
        <button type="button" onClick={() => setDismissed(true)} className={`text-xs font-semibold shrink-0 ${btnCls}`}>
          ✕ ausblenden
        </button>
      </div>
      <ul className="mt-2 space-y-1.5">
        {issues.map((issue, i) => (
          <li key={i} className={`text-xs ${labelCls}`}>
            <span className="font-semibold">{issue.label}:</span>{" "}
            <span className={fixCls}>{issue.fix}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
