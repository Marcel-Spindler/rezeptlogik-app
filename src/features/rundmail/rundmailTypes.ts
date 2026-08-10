// Rundmail – geteilte Zeilen-/Domänen-Typen (KET-, PET-, Planungs-Rohdaten).

export type RundmailRow = {
  id: string;
  dateNeeded: string;
  workOrderNumber: string;
  recipeId: string;
  recipeName: string;
  subRecipeName: string;
  minimumNeeds: number;
  cookMethods: string;
  woCookedPortions: number;
  targetPortions: number;
  cookedExcess: number;
  stagingStatus: string;
  stagingComment: string;
  kitchenStatus: string;
  unlockedEta: string;
  workOrderComment: string;
  kitchenKg?: number | null;
  batchSizeKg?: number | null;
  batchesNeeded?: number | null;
};

export type BatchHint = {
  capacityKg: number;
};

export type StatusFilter = "all" | "Not Started" | "Pre Blast" | "Post Blast";

export type DeficitItem = {
  row: RundmailRow;
  deficit: number;
};

export type PetRow = {
  id: string;
  type: string;
  productionShift: string;
  totalTarget: number;
  totalMapped: number;
  recipeWo: string;
  recipeName: string;
  recipeWoMapped: number;
  recipeWoTarget: number;
  recipePlatingStatus: string;
  recipeManualPlatingStatus: string;
  totalWeekUnlockedVolume: number;
  totalWeekMapped: number;
  productionMinNeeds: number;
  expiringDatetime: string;
  expiringSubRecipeName: string;
  expiringPortions: number;
  expiringLicensePlate: string;
  comment: string;
  rolloverAmount: number;
  actualBestByDate: string;
  bestBySubRecipeName: string;
};

export type PlatingNote = {
  instruction: string;
  packSchemaImageDataUrl?: string;
};


export type BoxDay = {
  dayLabel: string;
  boxes: number;
  meals: number;
};

export type TeamDay = {
  dayLabel: string;
  date: string;
  platingLinesEarly: number;
  platingLinesLate: number;
  platingHeadcountEarly: number;
  platingHeadcountLate: number;
  kitchenHeadcountEarly: number;
  kitchenHeadcountLate: number;
  allStaffEarly: number;
  allStaffLate: number;
  areas: Record<string, { early: number; late: number }>;
};

export type WeeklyPlanningData = {
  cw: number;
  year: number;
  isReference: boolean;
  referenceNote: string;
  spreadsheetName: string;
  generatedAt: string;
  boxesPerLinePerShift: number;
  boxSchedule: BoxDay[];
  teamByDay: TeamDay[];
};

export const DAY_LABEL_TO_WEEKDAY: Record<string, string> = {
  Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday",
  Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday",
};

// ── Allergen Detection ───────────────────────────────────────────────────────

export type AllergenDef = {
  label: string;
  bg: string;
  text: string;
  border: string;
  keywords: string[];
};

export const ALLERGEN_DEFS: AllergenDef[] = [
  { label: "Fisch", bg: "#dbeafe", text: "#1e40af", border: "#93c5fd", keywords: ["salmon", "lachs", "fish", "fisch", "tuna"] },
  { label: "Milch/Laktose", bg: "#e0f2fe", text: "#0c4a6e", border: "#7dd3fc", keywords: ["butter", "cream", "cheese", "käse", "kase", "parmesan", "mozzarella", "mascarpone", "cheddar", "gratin"] },
  { label: "Eier", bg: "#fef9c3", text: "#713f12", border: "#fde047", keywords: ["egg", " ei "] },
  { label: "Gluten", bg: "#fef3c7", text: "#92400e", border: "#fcd34d", keywords: ["burger", "meatball", "breadcrumb"] },
  { label: "Senf", bg: "#f0fdf4", text: "#14532d", border: "#86efac", keywords: ["mustard", "ranch", "senf"] },
  { label: "Sellerie", bg: "#dcfce7", text: "#166534", border: "#6ee7b7", keywords: ["celery", "sellerie"] },
  { label: "Sesam", bg: "#fdf4ff", text: "#581c87", border: "#d8b4fe", keywords: ["sesame", "sesam"] },
  { label: "Soja", bg: "#fff1f2", text: "#881337", border: "#fda4af", keywords: ["soy", "soja", "tofu"] },
];

