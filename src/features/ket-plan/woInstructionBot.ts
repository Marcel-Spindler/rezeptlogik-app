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

// Stationsnamen (EN + DE), wie sie der KI-Prompt (GEMINI_INSTRUCTION_SYSTEM_PROMPT /
// generateGeminiInstructionCloud) für die Kochanweisungen verwendet — zum farblichen
// Hervorheben derselben Begriffe in der Anzeige (Detailansicht + PDF).
const STATION_KEYWORDS = [
  "SPICE ROOM", "SPICE PORTIONING", "GEWÜRZRAUM",
  "VEGGIE DEBOX", "VEGETARISCHE DEBOX", "GEMÜSE-DEBOX",
  "PROTEIN DEBOX", "PROTEINDEBOX",
  "HAND MARINADE", "HANDMARINADE",
  "MARINADE",
  "BRAISER", "SCHMORBRATEN",
  "HORIZONTAL MIXER", "HORIZONTALMISCHER",
  "PLANETARY MIXER", "PLANETENMISCHER",
  "PATTY MAKER", "PATTY-PRESSE",
  "HAND MIX", "HANDMISCHUNG",
  "GRILL", "GRILLEN",
  "OVEN", "OFEN",
  "IMMERSION BLENDER", "STABMIXER",
  "DRAIN", "ABTROPFEN",
  "BLAST CHILLER", "SCHNELLKÜHLER",
  "MIDDLE KITCHEN", "PRODUCTION", "PRODUKTION",
  "PLATING", "PLATTIEREN",
];

// Längste zuerst, damit z.B. "HAND MARINADE" vor dem kürzeren "MARINADE" matcht.
const STATION_KEYWORD_RE = new RegExp(
  `\\b(${[...STATION_KEYWORDS]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})\\b`,
  "gi",
);

export interface HighlightSegment { text: string; isKeyword: boolean }

// Zerlegt Kochanweisungs-Text in Segmente und markiert bekannte Stationsnamen
// (SPICE ROOM, GRILL, OFEN, …), damit UI/PDF sie farblich hervorheben können.
export function splitInstructionKeywords(text: string): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let lastIndex = 0;
  STATION_KEYWORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STATION_KEYWORD_RE.exec(text))) {
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index), isKeyword: false });
    segments.push({ text: match[0], isKeyword: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), isKeyword: false });
  return segments;
}

export interface InstructionLine {
  // true = Stations-Header ("A. STATION: ..."), false = Schritt-Satz darunter.
  isHeader: boolean;
  // Fortlaufende Nummer je Station (1, 2, 3, …), 0 bei Headern.
  stepNum: number;
  text: string;
}

// Beliebig viele Stationsbuchstaben (nicht nur A-D — bis zu ~14 mögliche Stationen).
const STATION_HEADER_RE = /^[A-Z]\.\s+/;

// Zerlegt den KI-Kochanweisungstext in Zeilen: erkennt Stations-Header ("A. STATION:",
// "B. STATION:", …) und nummeriert die Schritt-Sätze darunter je Station neu durch.
// Geteilt zwischen Detailansicht (React) und Druck-PDF (HTML-String), damit beide
// dieselbe Zeilen-/Stationsstruktur zeigen statt jede ihre eigene zu parsen.
export function parseInstructionLines(text: string): InstructionLine[] {
  const rawLines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const result: InstructionLine[] = [];
  let stepNum = 0;
  for (const line of rawLines) {
    if (STATION_HEADER_RE.test(line)) {
      stepNum = 0;
      result.push({ isHeader: true, stepNum: 0, text: line });
      continue;
    }
    const clean = line.replace(/^\s*[-–•*]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim();
    if (!clean) continue;
    stepNum++;
    result.push({ isHeader: false, stepNum, text: clean });
  }
  return result;
}

// calc.subRecipeInstructions/DE kommen aus dem Rezept-Import-Feld "Instructions" —
// das ist in der Praxis Plating-/Verpackungstext ("NET WEIGHT = 400g", "2ND
// COMPARTMENT" …), keine Kochanweisung. Deshalb NICHT als sourceInstruction an
// Gemini geben (würde den Kontext mit falsch beschrifteten Daten vergiften) —
// nur die selbst berechneten, verlässlichen Batch-Mengen fließen in den Prompt.
export function buildWoInstructionContext(row: KetRow, calc: BatchCalc): string {
  const orderedCookMethods = orderCookingMethods(calc.resolvedCookMethods);
  return JSON.stringify({
    recipeName: row.recipeName,
    subRecipeName: row.subRecipeName,
    processFlow: orderedCookMethods,
    primaryEquipment: calc.primaryEquip,
    equipment: calc.equipBatches.map((batch) => batch.equip),
    batches: calc.batches > 0 ? calc.batches : null,
    perBatchKg: calc.perBatchKg > 0 ? calc.perBatchKg : null,
    totalKg: calc.totalKg > 0 ? calc.totalKg : null,
    ingredientFlags: calc.ingredients
      .filter((ing) => ing.separate || ing.spiceRoom)
      .map((ing) => ({ name: ing.name, separate: ing.separate, spiceRoom: ing.spiceRoom })),
    rti: calc.rti,
    neverBatch: calc.neverBatch,
    allergensContains: calc.allergensContains,
  }, null, 2);
}

export async function generateWoInstruction(row: KetRow, calc: BatchCalc): Promise<WoInstruction> {
  const endpoint = typeof window === "undefined"
    ? "http://127.0.0.1:3142/api/local-db/gemini-instruction"
    : "/api/local-db/gemini-instruction";
  const response = await fetchWithTimeout(endpoint, {
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
const FETCH_TIMEOUT_MS = 90_000; // 90s pro Request (statt unendlich)
const MAX_CHUNK_RETRIES = 2;

function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function generateWoInstructionsChunk(
  items: Array<{ key: string; row: KetRow; calc: BatchCalc }>,
): Promise<WoBatchResult> {
  const endpoint = typeof window === "undefined"
    ? "http://127.0.0.1:3142/api/local-db/gemini-instructions-batch"
    : "/api/local-db/gemini-instructions-batch";

  const response = await fetchWithTimeout(endpoint, {
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
    let chunkResult: WoBatchResult | null = null;
    for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
      try {
        chunkResult = await generateWoInstructionsChunk(chunk);
        break;
      } catch (error) {
        if (attempt < MAX_CHUNK_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // backoff
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        chunkResult = { generated: {}, failed: chunk.map((item) => ({ key: item.key, woNumber: item.row.woNumber, error: message })) };
      }
    }
    Object.assign(generated, chunkResult!.generated);
    failed.push(...chunkResult!.failed);
    onChunkDone?.(chunkResult!, Math.min(i + chunk.length, items.length), items.length);
  }

  if (Object.keys(generated).length === 0 && failed.length > 0) {
    throw new Error(`Alle ${failed.length} WOs fehlgeschlagen. Erster Fehler: ${failed[0].error}`);
  }
  return { generated, failed };
}