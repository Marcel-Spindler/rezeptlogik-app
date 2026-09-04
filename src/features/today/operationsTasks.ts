import type { BackfillFeasibility, CombinedBackfillNeed } from "../backfills/backfillTypes";
import type { WoReconciliationRow } from "../wo-reconciliation/woReconcileTypes";

export type OperationsTaskSeverity = "critical" | "warning";
export type OperationsTaskStatus = "open" | "in-progress" | "done";

export interface OperationsTaskState {
  status: OperationsTaskStatus;
  owner: string;
  changedAt?: number;
}

export interface OperationsTask {
  id: string;
  severity: OperationsTaskSeverity;
  title: string;
  detail: string;
  recipeCode: string;
  workOrder?: string;
  source: "backfill" | "reconciliation";
  rawMaterialBlocked?: boolean;
}

export interface OperationsTaskEscalation {
  taskId: string;
  title: string;
  detail: string;
}

const ESCALATION_AFTER_MS = 30 * 60_000;

function severityRank(severity: OperationsTaskSeverity): number {
  return severity === "critical" ? 0 : 1;
}

export function buildOperationsTasks(
  backfills: CombinedBackfillNeed[],
  feasibilityByMeal: Map<string, BackfillFeasibility>,
  reconciliationRows: WoReconciliationRow[],
): OperationsTask[] {
  const tasks: OperationsTask[] = [];

  for (const backfill of backfills) {
    if (backfill.recommendedBackfillPortions <= 0 || backfill.priority === "on-track") continue;
    const feasibility = feasibilityByMeal.get(backfill.recipeCode);
    const blocked = feasibility?.verdict === "blocked";
    const partial = feasibility?.verdict === "partial";
    const severity: OperationsTaskSeverity = blocked || backfill.priority === "critical" ? "critical" : "warning";
    const stockDetail = blocked
      ? "Rohware blockiert die Nachproduktion"
      : partial
        ? `Rohware reicht nur für ${feasibility.maxProduciblePortions} Portionen`
        : "Rohware noch nicht geprüft";
    tasks.push({
      id: `backfill:${backfill.recipeCode}`,
      severity,
      title: `${backfill.recipeCode}: ${backfill.recommendedBackfillPortions} Portionen nachproduzieren`,
      detail: `${backfill.recipeName} · Quelle: ${backfill.recommendedSource} · ${stockDetail}`,
      recipeCode: backfill.recipeCode,
      source: "backfill",
      rawMaterialBlocked: blocked,
    });
  }

  for (const row of reconciliationRows) {
    if (row.severity === "ok") continue;
    const issue = row.portionsMismatch ? "Portionsabweichung" : row.kgMismatch ? "Gewichtsabweichung" : row.missingPetAssignment ? "PET-Zuweisung fehlt" : "Quellenabweichung";
    tasks.push({
      id: `reconciliation:${row.workOrder}:${row.subRecipe}`,
      severity: row.severity === "critical" ? "critical" : "warning",
      title: `${row.workOrder}: ${issue}`,
      detail: `${row.recipeCode}${row.subRecipe ? ` · ${row.subRecipe}` : ""} · Quellen: ${row.presentIn.join(", ")}`,
      recipeCode: row.recipeCode,
      workOrder: row.workOrder,
      source: "reconciliation",
    });
  }

  return tasks.sort((left, right) => severityRank(left.severity) - severityRank(right.severity) || left.title.localeCompare(right.title, "de"));
}

export function buildTaskEscalations(
  tasks: OperationsTask[],
  state: Record<string, OperationsTaskState>,
  now = Date.now(),
): OperationsTaskEscalation[] {
  const escalations: OperationsTaskEscalation[] = [];
  for (const task of tasks) {
    const taskState = state[task.id] ?? { status: "open", owner: "" };
    if (taskState.status === "done") continue;
    if (task.rawMaterialBlocked) {
      escalations.push({ taskId: task.id, title: task.title, detail: "Rohware blockiert die Nachproduktion" });
    } else if (task.severity === "critical" && !taskState.owner.trim()) {
      escalations.push({ taskId: task.id, title: task.title, detail: "Kritischer Vorgang ohne Verantwortliche" });
    } else if (taskState.changedAt != null && now - taskState.changedAt >= ESCALATION_AFTER_MS) {
      const minutes = Math.floor((now - taskState.changedAt) / 60_000);
      escalations.push({ taskId: task.id, title: task.title, detail: `Seit ${minutes} Minuten nicht aktualisiert` });
    }
  }
  return escalations;
}