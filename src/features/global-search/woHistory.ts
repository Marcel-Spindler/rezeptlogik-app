import type { WoReconciliationRow, WoReconciliationSnapshot } from "../wo-reconciliation/woReconcileTypes";

export interface WoHistoryPoint {
  capturedAt: string;
  severity: WoReconciliationRow["severity"];
  progressPct: number | null;
  weighingCount: number;
  complete: boolean;
}

function severityRank(severity: WoReconciliationRow["severity"]): number {
  return severity === "critical" ? 2 : severity === "warn" ? 1 : 0;
}

function pointForRows(capturedAt: string, rows: WoReconciliationRow[]): WoHistoryPoint {
  const severity = rows.reduce<WoReconciliationRow["severity"]>(
    (highest, row) => severityRank(row.severity) > severityRank(highest) ? row.severity : highest,
    "ok",
  );
  const progress = rows.map((row) => row.progressPct).filter((value): value is number => value != null);
  return {
    capturedAt,
    severity,
    progressPct: progress.length ? Math.max(...progress) : null,
    weighingCount: Math.max(0, ...rows.map((row) => row.weighingCount)),
    complete: rows.length > 0 && rows.every((row) => row.isComplete),
  };
}

export function buildWoHistory(woNumber: string, snapshots: WoReconciliationSnapshot[]): WoHistoryPoint[] {
  const points = snapshots
    .map((snapshot) => pointForRows(snapshot.capturedAt, snapshot.rows.filter((row) => row.workOrder === woNumber)))
    .filter((_point, index) => snapshots[index].rows.some((row) => row.workOrder === woNumber))
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));

  return points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous
      || point.severity !== previous.severity
      || point.progressPct !== previous.progressPct
      || point.weighingCount !== previous.weighingCount
      || point.complete !== previous.complete;
  });
}

export function woHistoryDocId(woNumber: string): string {
  return encodeURIComponent(woNumber.trim());
}