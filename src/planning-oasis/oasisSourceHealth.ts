// Prüft, ob die statischen Dump-Dateien erreichbar sind, auf denen Planning OASE
// zusätzlich zum DataBundle aufbaut (KPL-Dump, Forecast-Exporte, Rack-XLSX).
import { useEffect, useState } from "react";

export type SourceHealthStatus = "ok" | "warn" | "missing" | "checking";

export interface SourceHealthEntry {
  key: string;
  label: string;
  status: SourceHealthStatus;
  detail: string;
}

interface SourceCheck {
  key: string;
  label: string;
  path: string;
  optional?: boolean;
}

const SOURCE_CHECKS: readonly SourceCheck[] = [
  { key: "app-data", label: "App Data", path: "/data/data.json" },
  { key: "kpl", label: "KPL Dump", path: "/data/gsheet-dump-Kitchen_Priority_List-Verden-2026.json" },
  { key: "forecast", label: "Forecast", path: "/data/gsheet-truth-export/Running Forecast - All Markets.csv" },
  { key: "pdl-de", label: "PDL DE", path: "/data/gsheet-truth-export/Factor_DE - PDL Forecast.csv" },
  { key: "pdl-nor", label: "PDL NOR", path: "/data/gsheet-truth-export/Factor_Nor - PDL Forecast.csv" },
  { key: "daily", label: "Daily", path: "/data/gsheet-truth-export/Factor_Daily - PDL Forecast.csv", optional: true },
  { key: "rack", label: "Rack XLSX", path: "/data/rack/MultiLine-latest.xlsx" },
];

async function checkSource(source: SourceCheck): Promise<SourceHealthEntry> {
  try {
    const response = await fetch(`${source.path}?ts=${Date.now()}`, { method: "HEAD", cache: "no-store" });
    if (response.ok) {
      const modified = response.headers.get("last-modified");
      return { key: source.key, label: source.label, status: "ok", detail: modified ? new Date(modified).toLocaleDateString("de-DE") : "geladen" };
    }
    return { key: source.key, label: source.label, status: source.optional ? "warn" : "missing", detail: source.optional ? "optional fehlt" : `HTTP ${response.status}` };
  } catch {
    return { key: source.key, label: source.label, status: source.optional ? "warn" : "missing", detail: source.optional ? "optional fehlt" : "nicht erreichbar" };
  }
}

export function useOasisSourceHealth(): SourceHealthEntry[] {
  const [health, setHealth] = useState<SourceHealthEntry[]>(() =>
    SOURCE_CHECKS.map(s => ({ key: s.key, label: s.label, status: "checking", detail: "prüft" }))
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all(SOURCE_CHECKS.map(checkSource)).then(result => {
      if (!cancelled) setHealth(result);
    });
    return () => { cancelled = true; };
  }, []);

  return health;
}

export function sourceHealthTone(status: SourceHealthStatus): string {
  if (status === "ok") return "bg-emerald-50 text-emerald-800 ring-emerald-200";
  if (status === "warn") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (status === "missing") return "bg-rose-50 text-rose-800 ring-rose-200";
  return "bg-slate-50 text-slate-500 ring-slate-200";
}
