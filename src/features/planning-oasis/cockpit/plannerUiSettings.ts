// Persistente UI-Einstellungen des Cockpit-Planers: Schichtmodell-Preset,
// Sichtbarkeit von Konflikt-Hinweisen, Auto-Split-Profil.
import type { UiLocale } from "../../../lib/i18n";
import { AUTO_FULFILLMENT_PROFILES } from "./slotScheduling";

export const PLANNER_UI_SETTINGS_STORAGE_KEY = "rezeptlogik-planner-ui-settings-v1";

export type PlannerUiSettings = {
  shiftPresetId: string;
  shiftCount: number;
  showAutoSuggestions: boolean;
  showStationConflicts: boolean;
  showPoolConflicts: boolean;
  autoSplitProfileId: string;
};

const DEFAULT_PLANNER_UI_SETTINGS: PlannerUiSettings = {
  shiftPresetId: "single-current",
  shiftCount: 1,
  showAutoSuggestions: true,
  showStationConflicts: true,
  showPoolConflicts: true,
  autoSplitProfileId: "mhd-smart",
};

export const SHIFT_MODEL_PRESETS = [
  {
    id: "single-current",
    label: "Aktuell: Einschicht",
    shortLabel: "Einschicht",
    shiftCount: 1,
    tone: "bg-emerald-50 text-emerald-900 ring-emerald-200",
    note: "Produktivbetrieb heute. Das ist der sichere Default und bleibt beim Neuladen aktiv.",
    areas: ["Kitchen", "Plating", "Fulfilment"],
    areaShiftPlan: { Warehouse: 0, Kitchen: 1, Printing: 0, Plating: 1, Fulfilment: 1, FSQA: 0 },
  },
  {
    id: "double-ready",
    label: "Vorbereitet: 2 Schichten",
    shortLabel: "2 Schichten",
    shiftCount: 2,
    tone: "bg-amber-50 text-amber-900 ring-amber-200",
    note: "Ein Klick schaltet zusätzliche Slots zu, ohne die restliche Planung umzubauen.",
    areas: ["Warehouse", "Kitchen", "Plating", "Fulfilment"],
    areaShiftPlan: { Warehouse: 1, Kitchen: 2, Printing: 1, Plating: 2, Fulfilment: 2, FSQA: 1 },
  },
  {
    id: "triple-ready",
    label: "Vorbereitet: 3 Schichten",
    shortLabel: "3 Schichten",
    shiftCount: 3,
    tone: "bg-sky-50 text-sky-900 ring-sky-200",
    note: "Für späteren Mehrschichtbetrieb vorbereitet, inkl. 3 Assembly Lines im Fulfilment.",
    areas: ["Warehouse", "Kitchen", "Plating", "Fulfilment", "FSQA"],
    areaShiftPlan: { Warehouse: 2, Kitchen: 3, Printing: 1, Plating: 3, Fulfilment: 3, FSQA: 2 },
  },
] as const;

export const SHIFT_MODEL_AREAS = [
  { key: "Warehouse", sheets: ["W1", "W2", "W3", "W4"] },
  { key: "Kitchen", sheets: ["K1", "K2", "K3", "K4"] },
  { key: "Printing", sheets: ["Printing"] },
  { key: "Plating", sheets: ["P1", "P2", "P3", "P4"] },
  { key: "Fulfilment", sheets: ["FFM1", "FFM2", "FFM3", "FFM4"] },
  { key: "FSQA", sheets: ["QA1", "QA2", "QA3", "QA4", "QA5"] },
] as const;

export function loadPlannerUiSettings(): PlannerUiSettings {
  if (typeof window === "undefined") return DEFAULT_PLANNER_UI_SETTINGS;
  try {
    const raw = window.localStorage.getItem(PLANNER_UI_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_PLANNER_UI_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PlannerUiSettings>;
    const shiftCount = Number(parsed.shiftCount ?? 1);
    const preset = SHIFT_MODEL_PRESETS.find(item => item.id === parsed.shiftPresetId)
      ?? SHIFT_MODEL_PRESETS.find(item => item.shiftCount === shiftCount)
      ?? SHIFT_MODEL_PRESETS[0];
    return {
      shiftPresetId: preset.id,
      shiftCount: shiftCount >= 1 && shiftCount <= 3 ? shiftCount : 1,
      showAutoSuggestions: parsed.showAutoSuggestions ?? true,
      showStationConflicts: parsed.showStationConflicts ?? true,
      showPoolConflicts: parsed.showPoolConflicts ?? true,
      autoSplitProfileId: AUTO_FULFILLMENT_PROFILES.some(profile => profile.id === parsed.autoSplitProfileId)
        ? String(parsed.autoSplitProfileId)
        : "mhd-smart",
    };
  } catch {
    return DEFAULT_PLANNER_UI_SETTINGS;
  }
}

export function shiftCountLabel(shiftCount: number): string {
  return shiftCount === 1 ? "1 Schicht" : `${shiftCount} Schichten`;
}

export function getShiftPreset(presetId: string, shiftCount: number) {
  return SHIFT_MODEL_PRESETS.find(item => item.id === presetId)
    ?? SHIFT_MODEL_PRESETS.find(item => item.shiftCount === shiftCount)
    ?? SHIFT_MODEL_PRESETS[0];
}

export function shiftPresetLabel(locale: UiLocale, presetId: string): string {
  void locale;
  if (presetId === "single-current") return "Aktuell: Einschicht";
  if (presetId === "double-ready") return "Vorbereitet: 2 Schichten";
  return "Vorbereitet: 3 Schichten";
}

export function shiftPresetShortLabel(locale: UiLocale, presetId: string): string {
  void locale;
  if (presetId === "single-current") return "Einschicht";
  if (presetId === "double-ready") return "2 Schichten";
  return "3 Schichten";
}

export function shiftPresetNote(locale: UiLocale, presetId: string): string {
  void locale;
  if (presetId === "single-current") return "Produktivbetrieb heute. Das ist der sichere Default und bleibt beim Neuladen aktiv.";
  if (presetId === "double-ready") return "Ein Klick schaltet zusätzliche Slots zu, ohne die restliche Planung umzubauen.";
  return "Für späteren Mehrschichtbetrieb vorbereitet, inkl. 3 Assembly Lines im Fulfilment.";
}
