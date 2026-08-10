// Share Dashboard – Domänen-Typen, Wochentage/Slots/Linien-Konstanten, Nav-Tabs, Quality-Issue-Typ.

// ══════════════════════════════════════════════════════════════════════════════
//  TYPES
// ══════════════════════════════════════════════════════════════════════════════

export type LinePlanRecipe = {
  code: string; name: string; totalPlanned: number;
  nordics: number; bnl: number; de: number; speedPerMin: number;
};

export type KetWO = {
  priority: number; stagingBy: string; deboxDay: string; woReady: boolean;
  hotKitchenDay: string; dateNeeded: string; woNumber: string; recipeId: string;
  recipeName: string; subRecipeName: string; cookMethods: string[];
  targetPortions: number; allergens: string[]; status: string; comments: string;
};

export type ScheduleMap = Record<string, LinePlanRecipe | null>;

// ══════════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

export const DAYS = ["Freitag", "Samstag", "Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag"] as const;

export const SLOTS = [
  { key: "06:00-07:00",  label: "06 – 07",    duration: 60 },
  { key: "07:00-08:00",  label: "07 – 08",    duration: 60 },
  { key: "08:00-08:30",  label: "08 – 08:30", duration: 30 },
  { key: "09:00-10:00",  label: "09 – 10",    duration: 60 },
  { key: "10:00-11:00",  label: "10 – 11",    duration: 60 },
  { key: "11:30-12:00",  label: "11:30 – 12", duration: 30 },
  { key: "12:00-13:00",  label: "12 – 13",    duration: 60 },
  { key: "13:00-14:00",  label: "13 – 14",    duration: 60 },
  { key: "14:00-15:00",  label: "14 – 15",    duration: 60 },
] as const;

export const LINES = ["P-Linie 1", "P-Linie 2", "P-Linie 3"] as const;

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════

