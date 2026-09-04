import { describe, expect, it } from "vitest";
import { buildOperationsTasks, buildTaskEscalations } from "../features/today/operationsTasks";
import type { CombinedBackfillNeed } from "../features/backfills/backfillTypes";
import type { WoReconciliationRow } from "../features/wo-reconciliation/woReconcileTypes";

const backfill = (overrides: Partial<CombinedBackfillNeed> = {}): CombinedBackfillNeed => ({
  recipeCode: "FV1234",
  recipeName: "Test Meal",
  recommendedBackfillPortions: 240,
  recommendedSource: "rti",
  priority: "behind",
  ...overrides,
} as CombinedBackfillNeed);

const reconciliation = (overrides: Partial<WoReconciliationRow> = {}): WoReconciliationRow => ({
  workOrder: "36-12345",
  recipeCode: "FV1234",
  recipeName: "Test Meal",
  subRecipe: "Sauce",
  severity: "critical",
  portionsMismatch: true,
  kgMismatch: false,
  missingPetAssignment: false,
  presentIn: ["app", "ket"],
  ...overrides,
} as WoReconciliationRow);

describe("buildOperationsTasks", () => {
  it("erstellt priorisierte Vorgänge aus Backfill und WO-Abgleich", () => {
    const tasks = buildOperationsTasks([backfill()], new Map(), [reconciliation()]);

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ id: "reconciliation:36-12345:Sauce", severity: "critical" });
    expect(tasks[1]).toMatchObject({ id: "backfill:FV1234", severity: "warning" });
  });

  it("eskaliert einen Backfill bei blockierter Rohware", () => {
    const tasks = buildOperationsTasks(
      [backfill()],
      new Map([["FV1234", { verdict: "blocked", maxProduciblePortions: 0 } as never]]),
      [],
    );

    expect(tasks[0]).toMatchObject({ severity: "critical" });
    expect(tasks[0]?.detail).toContain("Rohware blockiert");
  });

  it("eskaliert Rohwarenblockade, unzugewiesene Kritikalitaet und Ueberfaelligkeit", () => {
    const tasks = buildOperationsTasks(
      [backfill({ recipeCode: "FV0001" })],
      new Map([["FV0001", { verdict: "blocked", maxProduciblePortions: 0 } as never]]),
      [reconciliation()],
    );
    const escalations = buildTaskEscalations(tasks, {
      "reconciliation:36-12345:Sauce": { status: "in-progress", owner: "Anna", changedAt: 0 },
    }, 31 * 60_000);

    expect(escalations.map((entry) => entry.detail)).toEqual(expect.arrayContaining([
      "Rohware blockiert die Nachproduktion",
      "Seit 31 Minuten nicht aktualisiert",
    ]));
  });
});