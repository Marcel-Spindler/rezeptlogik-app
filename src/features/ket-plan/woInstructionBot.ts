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

function stripNumericArtifacts(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|gram|grams|ml|l|pcs|portion|portions|batch|batches)\b/gi, "")
    .replace(/\b\d+(?:[.,]\d+)?\b/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

export function buildWoInstructionContext(row: KetRow, calc: BatchCalc): string {
  const orderedCookMethods = orderCookingMethods(calc.resolvedCookMethods);
  return JSON.stringify({
    recipeName: row.recipeName,
    subRecipeName: row.subRecipeName,
    processFlow: orderedCookMethods,
    primaryEquipment: calc.primaryEquip,
    equipment: calc.equipBatches.map((batch) => batch.equip),
    ingredientFlags: calc.ingredients
      .filter((ing) => ing.separate || ing.spiceRoom)
      .map((ing) => ({ name: ing.name, separate: ing.separate, spiceRoom: ing.spiceRoom })),
    rti: calc.rti,
    neverBatch: calc.neverBatch,
    allergensContains: calc.allergensContains,
    sourceInstructionEnglish: stripNumericArtifacts(calc.subRecipeInstructions),
    sourceInstructionGerman: stripNumericArtifacts(calc.subRecipeInstructionsDE),
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

export interface WoBatchResult {
  generated: Record<string, WoInstruction>;
  failed: Array<{ key: string; woNumber: string; error: string }>;
}

// Firebase-Hosting-Rewrites zu Cloud Functions werden vom Loadbalancer nach ~60s
// hart gekappt (rohe Google-502-Seite statt unserer JSON-Fehlerantwort) — unabhängig
// vom timeoutSeconds der Function selbst. Ein Batch mit vielen WOs (~20-25s je WO)
// überschreitet das schnell, deshalb wird hier in kleine, garantiert schnelle
// Häppchen aufgeteilt statt alle Items in einem einzigen HTTP-Request zu senden.
const BATCH_CHUNK_SIZE = 5;

async function generateWoInstructionsChunk(
  items: Array<{ key: string; row: KetRow; calc: BatchCalc }>,
): Promise<WoBatchResult> {
  const endpoint = typeof window === "undefined"
    ? "http://127.0.0.1:3142/api/local-db/gemini-instructions-batch"
    : "/api/local-db/gemini-instructions-batch";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: items.map((item) => ({
      key: item.key,
      context: buildWoInstructionContext(item.row, item.calc),
    })) }),
  });
  const raw = await response.text();
  let payload: { results?: Record<string, { ok: boolean; instruction?: WoInstruction; error?: string }>; error?: string };
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    const detail = raw.replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`Gemini-Batch liefert keine gültige JSON-Antwort (HTTP ${response.status}): ${detail || "leere Antwort"}`);
  }
  if (!response.ok || !payload.results) {
    throw new Error(payload.error || `Gemini-Batch antwortet nicht (HTTP ${response.status})`);
  }

  const generated: Record<string, WoInstruction> = {};
  const failed: Array<{ key: string; woNumber: string; error: string }> = [];

  for (const item of items) {
    const result = payload.results[item.key];
    if (result?.ok && result.instruction) {
      generated[item.key] = result.instruction;
    } else {
      failed.push({ key: item.key, woNumber: item.row.woNumber, error: result?.error || "Unbekannter Fehler" });
    }
  }
  return { generated, failed };
}

export async function generateWoInstructionsBatch(
  items: Array<{ key: string; row: KetRow; calc: BatchCalc }>,
  onChunkDone?: (result: WoBatchResult, doneCount: number, totalCount: number) => void,
): Promise<WoBatchResult> {
  const generated: Record<string, WoInstruction> = {};
  const failed: Array<{ key: string; woNumber: string; error: string }> = [];

  for (let i = 0; i < items.length; i += BATCH_CHUNK_SIZE) {
    const chunk = items.slice(i, i + BATCH_CHUNK_SIZE);
    let chunkResult: WoBatchResult;
    try {
      chunkResult = await generateWoInstructionsChunk(chunk);
    } catch (error) {
      // HTTP-Ebene des ganzen Häppchens fehlgeschlagen (z. B. trotzdem ein Timeout) —
      // nur diese wenigen Items als fehlgeschlagen markieren, Rest des Batches weiterlaufen lassen.
      const message = error instanceof Error ? error.message : String(error);
      chunkResult = { generated: {}, failed: chunk.map((item) => ({ key: item.key, woNumber: item.row.woNumber, error: message })) };
    }
    Object.assign(generated, chunkResult.generated);
    failed.push(...chunkResult.failed);
    onChunkDone?.(chunkResult, Math.min(i + chunk.length, items.length), items.length);
  }

  if (Object.keys(generated).length === 0 && failed.length > 0) {
    throw new Error(`Alle ${failed.length} WOs fehlgeschlagen. Erster Fehler: ${failed[0].error}`);
  }
  return { generated, failed };
}