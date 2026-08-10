// PET Plan – Konstanten, Datenzeilen-Typ, Allergen-Definitionen.

// ── Konstanten ──────────────────────────────────────────────────────────────

export const LS_IMAGES_KEY = "pet_plating_images_v1";
export const PORTIONS_PER_HOUR = 1000;
export const LINE_START_HOUR = 7;
export const LINE_COLORS = ["#0ea5e9", "#10b981", "#f59e0b"] as const;
export const LINE_COLORS_BG = ["#eff6ff", "#f0fdf4", "#fffbeb"] as const;
export const LINE_COLORS_BORDER = ["#bfdbfe", "#bbf7d0", "#fde68a"] as const;
export const LINE_COLORS_DARK = ["#0369a1", "#059669", "#b45309"] as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface PetRow {
  key: string;
  shiftKey: string;
  shiftTotalTarget: number;
  shiftTotalMapped: number | null;
  _woNumber: string;
  recipeName: string;
  recipeCode: string;
  market: string;
  mapped: number | null;
  target: number;
  platingStatus: string;
  manualStatus: string;
  weekUnlocked: number | null;
  weekMapped: number | null;
  minNeeds: number | null;
  expiringDatetime: string;
  expiringSubRecipe: string;
  expiringPortions: string;
  expiringLp: string;
  comment: string;
  rolloverAmount: number | null;
  bestByDate: string;
  bestBySubRecipe: string;
}

export interface PlatingImage {
  dataUrl: string;
  name: string;
  addedAt: string;
}

export type WoSortMode = "auto" | "name" | "target" | "status" | "code";
export type ViewMode = "lines" | "list";

// ── Allergen Definitionen ──────────────────────────────────────────────────

export interface AllergenDef {
  label: string;
  color: string;
  bg: string;
  border: string;
  keywords: string[];
}

export const ALLERGEN_DEFS: AllergenDef[] = [
  { label: "Fisch",    color: "#1e40af", bg: "#dbeafe", border: "#93c5fd", keywords: ["salmon","lachs","fish","fisch","tuna","forelle","trout","seabass","bass","cod","kabeljau"] },
  { label: "Milch",    color: "#0c4a6e", bg: "#e0f2fe", border: "#7dd3fc", keywords: ["butter","cream","cheese","käse","kase","parmesan","mozzarella","mascarpone","cheddar","gratin","milch","milk","dairy","rahm","quark","ricotta","feta","gouda"] },
  { label: "Eier",     color: "#713f12", bg: "#fef9c3", border: "#fde047", keywords: ["egg","eier"," ei ","eggs"] },
  { label: "Gluten",   color: "#92400e", bg: "#fef3c7", border: "#fcd34d", keywords: ["burger","meatball","breadcrumb","gluten","weizen","wheat","panko","crispy"] },
  { label: "Senf",     color: "#14532d", bg: "#f0fdf4", border: "#86efac", keywords: ["mustard","ranch","senf","mustard"] },
  { label: "Sellerie", color: "#166534", bg: "#dcfce7", border: "#6ee7b7", keywords: ["celery","sellerie"] },
  { label: "Sesam",    color: "#581c87", bg: "#fdf4ff", border: "#d8b4fe", keywords: ["sesame","sesam"] },
  { label: "Soja",     color: "#881337", bg: "#fff1f2", border: "#fda4af", keywords: ["soy","soja","tofu","edamame"] },
  { label: "Nüsse",    color: "#7c2d12", bg: "#fff7ed", border: "#fdba74", keywords: ["nut","cashew","walnut","almond","peanut","nuss","pistachio","pistazien"] },
];
