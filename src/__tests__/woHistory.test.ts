import { describe, expect, it } from "vitest";
import { buildWoHistory, woHistoryDocId } from "../features/global-search/woHistory";
import type { WoReconciliationRow, WoReconciliationSnapshot } from "../features/wo-reconciliation/woReconcileTypes";

const row = (overrides: Partial<WoReconciliationRow> = {}): WoReconciliationRow => ({
  workOrder: "36-12345",
  severity: "warn",
  progressPct: 40,
  weighingCount: 1,
  isComplete: false,
  ...overrides,
} as WoReconciliationRow);

const snapshot = (capturedAt: string, rows: WoReconciliationRow[]): WoReconciliationSnapshot => ({
  capturedAt,
  sourcesAvailable: ["app"],
  rowCount: rows.length,
  criticalCount: 0,
  warnCount: 0,
  rows,
});

describe("buildWoHistory", () => {
  it("kodiert Work-Order-IDs sicher für einen Firestore-Dokumentpfad", () => {
    expect(woHistoryDocId("36/12345")).toBe("36%2F12345");
  });

  it("sortiert den Verlauf und entfernt unveränderte Snapshots", () => {
    const history = buildWoHistory("36-12345", [
      snapshot("2026-09-04T11:00:00.000Z", [row({ progressPct: 80, weighingCount: 2 })]),
      snapshot("2026-09-04T09:00:00.000Z", [row()]),
      snapshot("2026-09-04T10:00:00.000Z", [row()]),
    ]);

    expect(history).toEqual([
      expect.objectContaining({ capturedAt: "2026-09-04T09:00:00.000Z", progressPct: 40, weighingCount: 1 }),
      expect.objectContaining({ capturedAt: "2026-09-04T11:00:00.000Z", progressPct: 80, weighingCount: 2 }),
    ]);
  });

  it("fasst mehrere Submeals eines Snapshots auf die kritischste Lage zusammen", () => {
    const history = buildWoHistory("36-12345", [snapshot("2026-09-04T09:00:00.000Z", [
      row({ severity: "warn", progressPct: 20 }),
      row({ severity: "critical", progressPct: 65, weighingCount: 3 }),
    ])]);

    expect(history[0]).toMatchObject({ severity: "critical", progressPct: 65, weighingCount: 3 });
  });
});