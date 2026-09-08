// Küchenbereiche für den Kochplan. Eigenständig gehalten (nicht aus
// frischeV2Logic importiert), damit die Frischeliste-2.0-Aggregation unberührt
// bleibt — die Mapping-Logik ist bewusst deckungsgleich mit
// `frischeV2Logic.cookMethodToStation`, nur „Oven" ist hier ein eigener Bereich
// statt unter „Andere" zu fallen.

export type KitchenArea = "Braiser" | "Middle Kitchen" | "Brine / Grill" | "Oven" | "Andere";

export const KITCHEN_AREA_ORDER: readonly KitchenArea[] = [
  "Braiser", "Middle Kitchen", "Brine / Grill", "Oven", "Andere",
];

export const KITCHEN_AREA_COLORS: Record<KitchenArea, { header: string; chip: string; hex: string }> = {
  "Braiser":        { header: "bg-orange-600 text-white",  chip: "bg-orange-100 text-orange-800 border-orange-200",  hex: "#c2410c" },
  "Middle Kitchen": { header: "bg-[#1e3a5f] text-white",   chip: "bg-blue-100 text-blue-800 border-blue-200",        hex: "#1e3a5f" },
  "Brine / Grill":  { header: "bg-rose-700 text-white",    chip: "bg-rose-100 text-rose-800 border-rose-200",        hex: "#be123c" },
  "Oven":           { header: "bg-amber-600 text-white",   chip: "bg-amber-100 text-amber-800 border-amber-200",     hex: "#d97706" },
  "Andere":         { header: "bg-slate-500 text-white",   chip: "bg-slate-100 text-slate-600 border-slate-200",     hex: "#64748b" },
};

/** Sub-Rezept-Kategorie (Kochmethoden-Kette wie „BRAISER/BRINE/OVEN") → Küchenbereich.
 *  Priorität deckungsgleich mit frischeV2Logic: Braiser > Grill > Middle Kitchen
 *  (Cup/Butter/Slice/Mixer/Blender/Shredder) > Oven > Andere. */
export function areaForCookMethod(category: string): KitchenArea {
  const c = (category || "").toUpperCase();
  if (c.includes("BRAISER")) return "Braiser";
  if (c.includes("GRILL") || c.includes("GRIDDLE")) return "Brine / Grill";
  if (
    c.includes("CUP") || c.includes("BUTTER") || c.includes("SCOOP") ||
    c.includes("PLANETARY") || c.includes("IMMERSION") || c.includes("BLENDER") ||
    c.includes("HORIZONTAL MIXER") || c.includes("HAND MIX") || c.includes("SHREDDER") ||
    c.includes("SLICE") || c.includes("SLICER")
  ) return "Middle Kitchen";
  if (c.includes("OVEN") || c.includes("CRUSTED")) return "Oven";
  if (c.includes("BRINE") || c.includes("MARINADE") || c.includes("ACID BATH") || c.includes("PATTY")) return "Brine / Grill";
  return "Andere";
}
