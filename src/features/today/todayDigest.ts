// „Heute" — Morgen-Digest: bündelt die heute über ~5 Views verstreuten
// Live-Signale in EINE Liste. Reine Aufbereitung (kein React) — die Hook-
// Verdrahtung sitzt in TodayView.tsx.
//
// Jede Sektion kommt aus einer eigenen Quelle; ist die Quelle nicht verbunden
// (GSheet-/WMS-Poller laufen nur mit lokalem Server), trägt die Sektion einen
// `offline`-Hinweis statt so zu tun, als sei nichts los.
import type { AppView } from "../../app/AppContext";
import type { WeeklyStationLoad } from "../../lib/equipment";
import type { BackfillAlert } from "../backfills/backfillTypes";
import type { ShortageEntry } from "../gsheet-monitor/gsheetTypes";
import { formatRecoveryStatus } from "../gsheet-monitor/shortageAlerts";
import type { WoReconciliationRow } from "../wo-reconciliation/woReconcileTypes";

export type DigestSeverity = "critical" | "warning" | "info";

export interface DigestItem {
  id: string;
  severity: DigestSeverity;
  text: string;
  sub?: string;
  /** Klick öffnet dieses Rezept (statt der Sektion-View). */
  recipeCode?: string;
  /** true = Klick öffnet die Sektion-View selbst, nicht das Rezept-Detail. */
  stayInSection?: boolean;
}

export interface DigestSection {
  key: string;
  label: string;
  icon: string;
  /** „→"-Sprung ins Detail. */
  view: AppView;
  items: DigestItem[];
  /** Gesetzt, wenn die Datenquelle (noch) nicht verbunden ist. */
  offline?: string;
}

export function sevRank(s: DigestSeverity): number {
  return s === "critical" ? 0 : s === "warning" ? 1 : 2;
}

export function filterReconciliationRowsForWeek(
  rows: WoReconciliationRow[],
  weekNum: number | null,
): WoReconciliationRow[] {
  if (weekNum == null) return [];
  return rows.filter(row => row.weekNum === weekNum);
}

function sortItems(items: DigestItem[]): DigestItem[] {
  return items.slice().sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
}

const WARN_UTIL = 80;
const CRIT_UTIL = 100;

// ─── 1) Plan & Kapazität ───────────────────────────────────────────────────
// Wochen-Stations-Auslastung (Σ aktive Minuten / Kapazität). Die frühere
// Wochenboard-Analyse (Tag×Schicht-Konflikte aus dem Cockpit) ist mit dem
// Cockpit entfallen — Küchen-Timing steckt jetzt im „Kochplan".
export function buildPlanSection(
  loads: WeeklyStationLoad[],
): DigestSection {
  const items: DigestItem[] = [];

  for (const l of loads.filter((l) => l.utilizationPct >= WARN_UTIL).slice(0, 6)) {
    items.push({
      id: `cap-${l.key}`,
      severity: l.utilizationPct >= CRIT_UTIL ? "critical" : "warning",
      text: `${l.label}: ${Math.round(l.utilizationPct)}% Wochen-Auslastung`,
      sub: l.extraDevicesNeeded > 0 ? `+${l.extraDevicesNeeded} Gerät/Platz nötig für ≤ 100%` : l.basis,
    });
  }

  return { key: "plan", label: "Plan & Kapazität", icon: "📊", view: "planning", items: sortItems(items) };
}

// ─── 2) WO-Abgleich ────────────────────────────────────────────────────────
export function buildReconSection(
  bySeverityRecipe: Map<string, { severity: "warn" | "critical"; count: number }> | null,
): DigestSection {
  const items: DigestItem[] = [];
  if (bySeverityRecipe) {
    const rows = [...bySeverityRecipe.entries()].sort(
      (a, b) => (a[1].severity === "critical" ? 0 : 1) - (b[1].severity === "critical" ? 0 : 1),
    );
    for (const [code, v] of rows.slice(0, 12)) {
      items.push({
        id: `recon-${code}`,
        severity: v.severity === "critical" ? "critical" : "warning",
        text: `${code}: ${v.severity === "critical" ? "kritische Abweichung" : "Abweichung"} in ${v.count} WO(s)`,
        recipeCode: code,
      });
    }
  }
  return { key: "recon", label: "WO-Abgleich (Quellen)", icon: "🔀", view: "wo", items: sortItems(items) };
}

// ─── 3) Backfill-Bedarf ────────────────────────────────────────────────────
export function buildBackfillSection(input: {
  alerts: BackfillAlert[];
  isStaleWeek: boolean;
  selectedWeekNum: number | null;
  connected: boolean;
}): DigestSection {
  const items: DigestItem[] = [];
  for (const a of input.alerts.filter((a) => a.severity === "critical" || a.severity === "warning")) {
    items.push({
      id: `bf-${a.id}`,
      severity: a.severity,
      text: a.title,
      sub: a.message,
      // Backfill-Details stehen im Backfill-Wächter, nicht im Rezept-Detail.
      stayInSection: true,
    });
  }
  if (input.isStaleWeek) {
    items.push({
      id: "bf-stale",
      severity: "warning",
      text: `Backfills zeigt KW ${input.selectedWeekNum ?? "?"} — neuer Plan noch nicht importiert`,
    });
  }
  return {
    key: "backfill",
    label: "Backfill-Bedarf",
    icon: "♻️",
    view: "backfills",
    items: sortItems(items),
    offline: input.connected ? undefined : "Küchen-/Plating-Sheets nicht verbunden (nur lokal)",
  };
}

// ─── 4) Lager-Risiken ──────────────────────────────────────────────────────
// v1 = Rohstoff-Shortages aus dem Shorts-Tracker (Procurement/Warehouse trägt
// ein, bevor gekocht wird — das ist ein echtes Handlungssignal). MHD/Yield aus
// dem WMS-Vollbestand ist als Digest-Zeile zu verrauscht (dutzende SKUs laufen
// in einer Lebensmittel-Halle täglich ab und werden am selben Tag verbraucht) —
// dafür bleibt die WMS-Übersicht der Ort. TODO v2: MHD gegen den echten
// Wochenbedarf gegenrechnen, dann ist es ein Signal.
export function buildStockSection(input: {
  shortages: ShortageEntry[] | null;
}): DigestSection {
  const items: DigestItem[] = [];

  if (input.shortages) {
    const open = input.shortages.filter((s) => !s.filled).sort((a, b) => b.shortKg - a.shortKg);
    for (const s of open.slice(0, 12)) {
      const isNew = !s.recoveryStatus.trim() && !s.notes.trim();
      const recoveryStatusText = s.recoveryStatus ? formatRecoveryStatus(s.recoveryStatus) : "";
      const recoveryText = [recoveryStatusText, s.notes].filter(Boolean).join(" — ") || "noch keine Recovery-Info im Sheet";
      items.push({
        id: `short-${s.rowIndex}`,
        severity: isNew ? "critical" : "warning",
        text: `${isNew ? "🆕 " : ""}Mangel ${s.workOrder ?? s.rawWorkOrderSuffix}: ${s.ingredient} −${s.shortKg.toFixed(1)} kg`,
        sub: recoveryText,
      });
    }
  }

  return {
    key: "stock",
    label: "Rohstoffmängel",
    icon: "📦",
    view: "postblast-live",
    items: sortItems(items),
    offline: input.shortages === null ? "Shorts-Tracker nicht verbunden (nur lokal)" : undefined,
  };
}

// ─── Zusammenfassung ───────────────────────────────────────────────────────
export interface DigestSummary {
  critical: number;
  warning: number;
  info: number;
  total: number;
  allClear: boolean;
}

export function summarizeDigest(sections: DigestSection[]): DigestSummary {
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const s of sections) {
    for (const it of s.items) {
      if (it.severity === "critical") critical += 1;
      else if (it.severity === "warning") warning += 1;
      else info += 1;
    }
  }
  const total = critical + warning + info;
  return { critical, warning, info, total, allClear: total === 0 };
}
