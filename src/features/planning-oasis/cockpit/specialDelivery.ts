// Persistenz für manuell erfasste Sonderlieferungen je Woche (localStorage,
// nicht Firestore — rein clientseitige Planungsnotiz).
import type { PlannerDay, SpecialDeliveryOrder } from "../../../lib/planner";

const SPECIAL_DELIVERY_STORAGE_KEY = "rezeptlogik-special-deliveries-v1";

export type SpecialDeliveryDraft = {
  recipeCode: string;
  fulfillmentDay: PlannerDay;
  portions: number;
  market: string;
  note: string;
};

export function loadSpecialDeliveries(week: string): SpecialDeliveryOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SPECIAL_DELIVERY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, SpecialDeliveryOrder[]>;
    return Array.isArray(parsed?.[week]) ? parsed[week] : [];
  } catch {
    return [];
  }
}

export function saveSpecialDeliveries(week: string, rows: SpecialDeliveryOrder[]) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(SPECIAL_DELIVERY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, SpecialDeliveryOrder[]> : {};
    parsed[week] = rows;
    window.localStorage.setItem(SPECIAL_DELIVERY_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    window.localStorage.setItem(SPECIAL_DELIVERY_STORAGE_KEY, JSON.stringify({ [week]: rows }));
  }
}
