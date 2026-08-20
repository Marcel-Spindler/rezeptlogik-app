// Equipment-Zuordnung für Sub-Rezepte — nutzt Equipment-Kapazitäten aus der
// Küchenbible + KET-Defaults, um für eine bestehende WO eine grobe
// Chargenanzahl zu schätzen. Erfindet KEINE neuen WOs — das eigentliche
// Anlegen von Backfill-WOs passiert manuell in einem anderen System.
import type { EquipBibleEntry } from "../../core/types";
import { EQUIP_DEFAULTS } from "../ket-plan/ketTypes";

export function findEquipmentForSubRecipe(
  subRecipeName: string,
  cookMethods: string | undefined,
  bible: EquipBibleEntry[] | undefined
): { equipment: string; capacityKg: number } {
  const sub = subRecipeName.toLowerCase();

  // 1. Bible-Lookup
  if (bible && bible.length > 0) {
    for (const entry of bible) {
      if (entry.maxKg <= 0) continue;
      const item = entry.itemName.toLowerCase();
      // Fuzzy: mindestens 60% der Wörter müssen matchen
      const subWords = sub.split(/[\s\-_,]+/).filter(w => w.length > 2);
      const matchCount = subWords.filter(w => item.includes(w)).length;
      if (subWords.length > 0 && matchCount / subWords.length >= 0.5) {
        return { equipment: entry.source, capacityKg: entry.maxKg };
      }
    }
  }

  // 2. Cook-Method-basierter Fallback
  if (cookMethods) {
    const methods = cookMethods.toUpperCase();
    if (methods.includes("BRAIS")) return { equipment: "BRAISER", capacityKg: EQUIP_DEFAULTS.BRAISER };
    if (methods.includes("OVEN") || methods.includes("ROAST") || methods.includes("BAKE"))
      return { equipment: "OVEN", capacityKg: EQUIP_DEFAULTS.OVEN };
    if (methods.includes("MIX") || methods.includes("BLEND"))
      return { equipment: "PLANETARY MIXER", capacityKg: EQUIP_DEFAULTS["PLANETARY MIXER"] };
    if (methods.includes("SHRED"))
      return { equipment: "HOT SHREDDER", capacityKg: EQUIP_DEFAULTS["HOT SHREDDER"] };
  }

  // 3. Name-basierte Heuristik
  if (sub.includes("sauce") || sub.includes("chili") || sub.includes("soup") || sub.includes("stew"))
    return { equipment: "BRAISER", capacityKg: EQUIP_DEFAULTS.BRAISER };
  if (sub.includes("roast") || sub.includes("bake") || sub.includes("grill"))
    return { equipment: "OVEN", capacityKg: EQUIP_DEFAULTS.OVEN };
  if (sub.includes("mash") || sub.includes("mix") || sub.includes("blend"))
    return { equipment: "PLANETARY MIXER", capacityKg: EQUIP_DEFAULTS["PLANETARY MIXER"] };

  // 4. Default: Braiser (häufigstes Equipment)
  return { equipment: "BRAISER", capacityKg: EQUIP_DEFAULTS.BRAISER };
}
