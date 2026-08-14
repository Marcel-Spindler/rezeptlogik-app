import type { BatchCalc, KetRow, WoInstruction } from "./ketTypes";

const PROCESS_ORDER = [
  "SPICE PORTIONING", "VEGGIE DEBOX", "PROTEIN DEBOX", "MARINADE", "HAND MARINADE",
  "BRAISER", "HORIZONTAL MIXER", "PLANETARY MIXER", "PATTY MAKER", "GRILL", "OVEN",
  "IMMERSION BLENDER", "HAND MIX", "DRAIN", "BLAST CHILLER",
];

export function orderCookingMethods(methods: string[]): string[] {
  const orderOf = (method: string) => {
    const index = PROCESS_ORDER.indexOf(method.toUpperCase());
    return index < 0 ? PROCESS_ORDER.length : index;
  };
  return [...new Set(methods.map((method) => method.trim().toUpperCase()).filter(Boolean))]
    .sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b));
}

export function processOrder(): string[] {
  return [...PROCESS_ORDER];
}

export function buildWoInstructionContext(row: KetRow, calc: BatchCalc): string {
  const orderedCookMethods = orderCookingMethods(calc.resolvedCookMethods);
  return JSON.stringify({
    workOrder: row.woNumber,
    dateNeeded: row.dateNeeded,
    recipeCode: row.recipeCode,
    recipeName: row.recipeName,
    subRecipeName: row.subRecipeName,
    targetPortions: row.targetPortions,
    cookedPortions: row.woCookedPortions,
    processOrder: PROCESS_ORDER,
    cookMethods: orderedCookMethods,
    processFlow: orderedCookMethods.map((method, index) => `${index + 1}. ${method}`),
    primaryEquipment: calc.primaryEquip,
    equipmentBatches: calc.equipBatches.map((batch) => ({
      equipment: batch.equip,
      capacityKg: batch.capacityKg,
      batches: batch.batches,
      kgPerBatch: batch.perBatchKg,
    })),
    totalKg: calc.totalKg,
    ingredients: calc.ingredients.map((ingredient) => ({
      name: ingredient.name,
      category: ingredient.category,
      totalKg: ingredient.totalKg,
      perBatchKg: ingredient.perBatchKg,
    })),
    sourceInstructionEnglish: calc.subRecipeInstructions,
    sourceInstructionGerman: calc.subRecipeInstructionsDE,
  }, null, 2);
}

export async function generateWoInstruction(row: KetRow, calc: BatchCalc): Promise<WoInstruction> {
  const endpoint = typeof window === "undefined"
    ? "http://127.0.0.1:3142/api/local-db/gemini-instruction"
    : "/api/local-db/gemini-instruction";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context: buildWoInstructionContext(row, calc) }),
  });
  const raw = await response.text();
  let payload: { instruction?: WoInstruction; error?: string };
  try {
    payload = raw ? JSON.parse(raw) as { instruction?: WoInstruction; error?: string } : {};
  } catch {
    throw new Error(`Gemini-Server liefert keine gültige JSON-Antwort (HTTP ${response.status})`);
  }
  if (!response.ok || !payload.instruction) {
    throw new Error(payload.error || `Gemini antwortet nicht (HTTP ${response.status})`);
  }
  return payload.instruction;
}

export async function generateWoInstructionsBatch(
  items: Array<{ key: string; row: KetRow; calc: BatchCalc }>,
): Promise<Record<string, WoInstruction>> {
  const endpoint = typeof window === "undefined"
    ? "http://127.0.0.1:3142/api/local-db/gemini-instructions-batch"
    : "/api/local-db/gemini-instructions-batch";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: items.map((item) => ({ key: item.key, context: buildWoInstructionContext(item.row, item.calc) })) }),
  });
  const raw = await response.text();
  let payload: { results?: Record<string, { ok: boolean; instruction?: WoInstruction; error?: string }>; error?: string };
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Gemini-Batch liefert keine gültige JSON-Antwort (HTTP ${response.status})`);
  }
  if (!response.ok || !payload.results) throw new Error(payload.error || `Gemini-Batch antwortet nicht (HTTP ${response.status})`);
  const failed = Object.values(payload.results).find((result) => !result.ok);
  if (failed && !Object.values(payload.results).some((result) => result.ok)) {
    throw new Error(failed.error || "Keine WO-Instruction konnte erzeugt werden");
  }
  return Object.fromEntries(Object.entries(payload.results).filter(([, result]) => result.ok && result.instruction).map(([key, result]) => [key, result.instruction!]));
}