import { useEffect, useState } from "react";
import type { DataBundle } from "../core/types";
import type { DataSourceStatus } from "../core/dataSource";

interface HealthIssue { label: string; fix: string; severity: "warn" | "stale" }

const STALE_WARN_H = 2;   // >2h  → Warnung
const STALE_ERROR_H = 6;  // >6h  → kritisch
const MATCH_RATE_WARN_PCT = 60;

const DISMISS_KEY = "dataHealthBanner.dismissedUntil";

function dataAgeHours(generatedAt: string): number | null {
  if (!generatedAt) return null;
  const ts = new Date(generatedAt).getTime();
  if (!ts || isNaN(ts)) return null;
  return (Date.now() - ts) / 3_600_000;
}

function checkFreshness(generatedAt: string): HealthIssue | null {
  const ageH = dataAgeHours(generatedAt);
  if (ageH === null) return null;
  const hours = Math.floor(ageH);
  if (ageH >= STALE_ERROR_H) {
    return { label: `Daten ${hours}h alt`, fix: "Daten veraltet (>6h) — Cloud Function prüfen oder npm run import:gsheet ausführen", severity: "stale" };
  }
  if (ageH >= STALE_WARN_H) {
    return { label: `Daten ${hours}h alt`, fix: "Letzter Import vor über 2 Stunden — bei Bedarf npm run import:gsheet ausführen", severity: "warn" };
  }
  return null;
}

function checkCompleteness(data: DataBundle): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const wrCount = data.weekRecipes.length;
  const recipeCount = Object.keys(data.recipes).length;
  const structCount = Object.keys(data.structures ?? {}).length;
  const specCount = Object.keys(data.processSpecs ?? {}).length;
  const shelfCount = Object.keys(data.shelfLifeBySku ?? {}).length;

  if (wrCount === 0) {
    issues.push({ label: "Keine Rezepte geladen", fix: "Ramp-Up GSheet (GSHEET_ID) nicht erreichbar — Cloud Function prüfen oder npm run import:gsheet ausführen", severity: "stale" });
  }

  if (recipeCount === 0) {
    issues.push({ label: "Keine Rezeptdaten (Zutaten, MSKUs)", fix: "export-sub-recipes-by-recipe-detailed.csv in imports/ ablegen → npm run import:local", severity: "warn" });
  } else if (wrCount > 0) {
    const matched = data.weekRecipes.filter(wr => !!data.recipes[wr.code]).length;
    const pct = Math.round((matched / wrCount) * 100);
    if (pct < MATCH_RATE_WARN_PCT) {
      issues.push({ label: `Rezept-Match nur ${pct} %`, fix: "export-sub-recipes-by-recipe-detailed.csv ist veraltet — neuen Export aus Culinary-Tool in imports/ legen → npm run import:local", severity: "warn" });
    }
  }

  if (structCount === 0) {
    issues.push({ label: "Kein Rezeptbaum (Sub-Rezepte)", fix: "export-sub-recipes-by-recipe-detailed.csv fehlt in imports/", severity: "warn" });
  }
  if (specCount === 0) {
    issues.push({ label: "Keine PFEI-Daten (Batch-Größen)", fix: "PFEI GSheet nicht importiert → npm run import:pfei && npm run push:firestore", severity: "warn" });
  }
  if (shelfCount === 0) {
    issues.push({ label: "Kein Shelf-Life (MHD-Status)", fix: "Open Shelf Life GSheet nicht erreichbar — Google-Credentials prüfen → npm run import:local", severity: "warn" });
  }
  if (!data.productionPlan) {
    issues.push({ label: "Kein Fertigstellungszeitplan", fix: "Sheet 6 (SHEET_FERTIGSTELLUNG) fehlt — Cloud Function refresh-operational oder npm run import:gsheet", severity: "warn" });
  }

  return issues;
}

function collectHealthIssues(data: DataBundle, source: DataSourceStatus): HealthIssue[] {
  const freshness = checkFreshness(data.generatedAt);
  const sourceIssue = source.error
    ? { label: `${source.label}: Aktualisierung fehlgeschlagen`, fix: source.error, severity: "warn" as const }
    : source.kind === "firestore-cache"
      ? { label: "Firestore-Cache aktiv", fix: "Live-Daten werden im Hintergrund aktualisiert", severity: "warn" as const }
      : null;
  return [...(freshness ? [freshness] : []), ...(sourceIssue ? [sourceIssue] : []), ...checkCompleteness(data)];
}

function readDismissed(): boolean {
  try {
    const until = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return until > Date.now();
  } catch { return false; }
}

export function DataHealthBanner({ data, source }: { data: DataBundle; source: DataSourceStatus }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [open, setOpen] = useState(false);
  // Tick jede Minute, damit der Alterscheck live aktualisiert wird
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => forceTick(t => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (dismissed) return null;

  const issues = collectHealthIssues(data, source);
  if (issues.length === 0) return null;

  const hasCritical = issues.some(i => i.severity === "stale");
  // Bewusst dezent: eine kleine Statuspille rechts oben statt eines großen Alarm-Banners.
  // Details erst auf Klick. Für Außenstehende soll die App nicht "kaputt" wirken.
  const dotCls = hasCritical ? "bg-red-500" : "bg-amber-400";
  const chipCls = hasCritical
    ? "text-red-600 hover:text-red-800"
    : "text-slate-400 hover:text-slate-600";

  const summary = issues.length === 1
    ? issues[0].label
    : `${issues.length} Datenhinweise`;

  function dismissForToday() {
    try {
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      localStorage.setItem(DISMISS_KEY, String(midnight.getTime()));
    } catch { /* ignore */ }
    setDismissed(true);
  }

  return (
    <div className="mb-2 flex justify-end">
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className={`flex items-center gap-1.5 text-[11px] font-medium ${chipCls}`}
          title="Daten-Status anzeigen"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${dotCls}`} />
          {summary}
        </button>

        {open && (
          <div className="absolute right-0 z-20 mt-1 w-80 rounded-lg bg-white p-3 text-left shadow-lg ring-1 ring-slate-200">
            <div className="flex items-start justify-between gap-2">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                Daten-Status
              </div>
              <button
                type="button"
                onClick={dismissForToday}
                className="shrink-0 text-[11px] font-semibold text-slate-400 hover:text-slate-700"
              >
                heute ausblenden
              </button>
            </div>
            <ul className="mt-2 space-y-1.5">
              {issues.map((issue, i) => (
                <li key={i} className="text-[11px] text-slate-700">
                  <span className="font-semibold">{issue.label}:</span>{" "}
                  <span className="text-slate-500">{issue.fix}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
