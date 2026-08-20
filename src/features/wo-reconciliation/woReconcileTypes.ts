// WO-Abgleich – Work Orders existieren parallel in mehreren Systemen (App-
// Produktionsplan, KET-Plan, PET-Plan, WMS-Submeals, Postblast-Wiegungen).
// Diese Typen bilden den Abgleich EINER Work Order über alle Quellen hinweg ab.

export type ReconcileSource = "app" | "ket" | "pet" | "wms" | "postblast";
export type ReconcileSeverity = "ok" | "warn" | "critical";

export interface WoReconciliationRow {
  workOrder: string;
  weekNum: number | null;
  recipeCode: string;
  recipeName: string;
  subRecipe: string;

  // In welchen Quellen taucht diese WO überhaupt auf?
  presentIn: ReconcileSource[];

  // Portionen je Quelle (App-Plan, KET-Ziel, PET-Ziel/gemappt)
  appPortions: number | null;
  ketPortions: number | null;
  petTarget: number | null;
  petMapped: number | null;

  // kg je Quelle (App-Plan-Soll, KET-Schätzung aus Portionen×Rezeptgewicht, tatsächlich gewogen)
  appKg: number | null;
  ketKg: number | null;
  actualKg: number | null;

  progressPct: number | null;
  isComplete: boolean;
  isCritical: boolean;

  kgMismatch: boolean;
  portionsMismatch: boolean;
  missingPetAssignment: boolean;

  severity: ReconcileSeverity;
  weighingCount: number;
  lastWeighing: string | null;
}

export interface WoReconciliationSnapshot {
  capturedAt: string;
  sourcesAvailable: ReconcileSource[];
  rowCount: number;
  criticalCount: number;
  warnCount: number;
  rows: WoReconciliationRow[];
}
