export interface RedzoneRun {
  areaName: string;
  locationName: string;
  productTypeName: string;
  productTypeSKU: string;
  outCount: number | null;
  inCount: number | null;
  startTime: string | null;
  endTime: string | null;
  runName: string;
}

export interface RedzoneStatusResponse {
  ok: boolean;
  enterprise: string;
  lookbackHours: number;
  generatedAt: string;
  rows: RedzoneRun[];
  error?: string;
}

export type PlatingStatus = "active" | "completed";

export interface PlatingRunDisplay extends RedzoneRun {
  status: PlatingStatus;
  mealCode: string | null;
  durationMin: number | null;
}
