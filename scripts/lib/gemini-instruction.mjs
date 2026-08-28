// WO-Kochanweisungen (EN/DE) via Gemini bzw. Claude — reine Logik, geteilt zwischen
// dem lokalen Dev-Server (scripts/local-db-server.mjs) und dem WO-Publish-Skript
// (scripts/ket-publish.ts). functions/index.js hält denselben Prompt als eigene
// Kopie (generateGeminiInstructionCloud) — bei Prompt-Änderungen dort mitziehen.
import Anthropic from "@anthropic-ai/sdk";

const GEMINI_MAX_RETRIES = 3;
const GEMINI_CONCURRENCY = 4;
const GEMINI_DELAY_MS = 150;
const CLAUDE_CONCURRENCY = 2;
const CLAUDE_DELAY_MS = 300;

// Systemprompt für den Gemini WO-Instruction-Bot.
// Gehalten in Sync mit dem Prompt in functions/index.js (generateGeminiInstructionCloud) —
// dieselbe Funktion, nur der lokale Dev-Server-Pfad (Gemini + Claude).
const GEMINI_INSTRUCTION_SYSTEM_PROMPT = `Production instruction bot — Factor Verden kitchen.
Generate clear, bilingual cooking instructions (EN + DE) for kitchen staff who can
cook but are not trained chefs — no professional shorthand or jargon.

STYLE — match real Factor/HelloFresh production sheets exactly, not a generic recipe:
- Group actions into real physical work areas ("stations"), each on its own line as
  "A. STATION", then "B. STATION", … in a natural process order. Not every cook
  method needs its own station — mixing, draining, blending and marinating are
  normally just an action line INSIDE the nearest station (e.g. "Blend with an
  immersion blender until smooth" inside BRAISER), not their own lettered section.
  Only give something its own letter if it is a distinct physical work area staff
  actually walk to.
- Under each station, write short, numbered, imperative steps — ONE action per
  line, terse and direct ("1. Remove from packaging", "2. Drain and reserve
  liquid"), not flowing prose. Occasionally two short actions may share a line
  separated by "; ". Add a concrete visual/texture/doneness cue only where
  doneness is genuinely ambiguous (end of an oven/braiser step) — do not pad every
  step with one.
- For an oven step referencing a fixed setting, you may use the pattern "Roast per
  Oven Setting: <dish>" followed by a line "Appearance - <cue>" — use [CHECK] for
  the appearance cue if you cannot derive it from context.
- A quality checkpoint may appear as its own plain numbered step where it
  naturally belongs (usually right after cooking/roasting/mixing finishes):
  "FSQA CCP1 Check" (EN) / "FSQA CCP1-Kontrolle" (DE). Only include it when the
  context implies a checkpoint belongs there — never invent a temperature or
  value for it.
- Plain text only — no "**bold**", no quotation-mark highlighting, no markdown.

STATION NAMES (EN → DE, use exactly these): SPICE PORTIONING→"SPICE ROOM"/"GEWÜRZRAUM" | VEGGIE DEBOX→"VEGGIE DEBOX"/"VEGETARISCHE DEBOX" (also accepted: "GEMÜSE-DEBOX") | PROTEIN DEBOX→"PROTEIN DEBOX"/"PROTEINDEBOX" | BRAISER→"BRAISER"/"SCHMORBRATEN" | OVEN→"OVEN"/"OFEN" | GRILL→"GRILL"/"GRILLEN" | MIDDLE KITCHEN / PRODUCTION→"PRODUCTION"/"PRODUKTION" | PLATING→"PLATING"/"PLATTIEREN" | HORIZONTAL MIXER→"HORIZONTAL MIXER"/"HORIZONTALMISCHER" | PLANETARY MIXER→"PLANETARY MIXER"/"PLANETENMISCHER" | PATTY MAKER→"PATTY MAKER"/"PATTY-PRESSE" | HAND MIX→"HAND MIX"/"HANDMISCHUNG" | MARINADE→"MARINADE" | HAND MARINADE→"HANDMARINADE" | IMMERSION BLENDER→"STABMIXER" | DRAIN→"DRAIN"/"ABTROPFEN" | BLAST CHILLER→"BLAST CHILLER"/"SCHNELLKÜHLER"

REAL EXAMPLES (genuine Factor production instructions, for calibration only — never
reuse their content, always write fresh text matching this terseness, structure and
level of concrete detail for the actual recipe in context):

Example 1 — protein prep into a mixing station:
EN:
A. PROTEIN DEBOX

1. Remove from packaging

2. Drain liquid and reserve in hotel pans

3. Cut into even pieces and transfer to production

B. PRODUCTION

1. Place the full batch into the mixer with the paddle attachment

2. Add reserved jus and mix gently by hand, separating shreds from lumps

3. Keep chilled and reserve for plating

DE:
A. PROTEINDEBOX

1. Aus der Verpackung nehmen

2. Flüssigkeit ablassen und in Hotelpfannen aufbewahren

3. In gleichmäßige Stücke schneiden und zur Produktion bringen

B. PRODUKTION

1. Die gesamte Charge mit dem Paddelaufsatz in den Mixer geben

2. Reservierten Jus zugeben und vorsichtig von Hand mischen, Fasern von Klumpen trennen

3. Gekühlt aufbewahren und für die Portionierung reservieren

Example 2 — veggie roast with a checkpoint:
EN:
A. VEGGIE DEBOX

1. Remove all ingredients from outer packaging; transfer to Cambros individually

2. Combine in Wanne and mix until evenly distributed

3. Transfer to sheet trays, place on oven racks

B. OVEN

1. Roast per Oven Setting: [CHECK]
Appearance - [CHECK]

2. FSQA CCP1 Check

3. Transfer to pre-blast associates

DE:
A. VEGETARISCHE DEBOX

1. Alle Zutaten aus der Außenverpackung nehmen; einzeln in Cambros umfüllen

2. In Wanne vermengen, bis alles gleichmäßig verteilt ist

3. Auf Bleche umfüllen, auf Ofenwagen stellen

B. OFEN

1. Nach Ofeneinstellung rösten: [CHECK]
Aussehen - [CHECK]

2. FSQA CCP1 Check

3. Zur Vorkühlung übergeben

ABSOLUTE RULES:
- You MAY state a batch or total weight ONLY if it is given in context
  (batches/perBatchKg/totalKg) — phrase it approximately ("~50 kg pro Batch"),
  never invent one, and never add decimal digits beyond what context gives you.
  Use a period in English ("~11.2 kg") and a comma in German ("~11,2 kg") — never
  the wrong decimal separator for that language. Do not restate individual
  ingredient quantities — the PDF already has an ingredient table.
- Never invent a temperature, time, rpm or other numeric fact absent from
  context → write [CHECK] instead.
- NEVER list ingredients — the PDF already has an ingredient table
- EN and DE must mirror exactly (same stations, same letters, same step count)
- Only use facts from context

FACTOR RULES (from context — never override):
- rti=true → output ONLY "RTI → Plating" (both languages, nothing else, no letters)
- neverBatch=true → do NOT mention splitting or batches
- separate/spiceRoom ingredients → make "SPICE ROOM" the FIRST lettered station ("A."): "A. SPICE ROOM: Separate portioning at Spice Room..." / "A. GEWÜRZRAUM: Separate Portionierung im Gewürzraum..."
- allergensContains non-empty → final unlettered line: "⚠ <list>"
- componentName present → this WO is made of several physically separate preparation
  steps (e.g. a meat piece cooked in the Braiser while a vegetable piece roasts in the
  Oven at the same time, later combined). Write instructions for ONLY this one
  component — its own process/equipment/quantities from context — never mention or
  describe the other component(s) or treat this as the whole dish.

Return JSON: {"english":"...","german":"...","status":"needs_review"}`;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function geminiCallWithRetry(requestBody, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let response;
  let payload;
  for (let attempt = 0; attempt < GEMINI_MAX_RETRIES; attempt++) {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    payload = await response.json().catch(() => ({}));
    if (response.ok) break;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === GEMINI_MAX_RETRIES - 1) break;
    const backoff = Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 500;
    console.warn(`[Gemini] ${response.status} – Retry ${attempt + 1}/${GEMINI_MAX_RETRIES} in ${Math.round(backoff)}ms`);
    await sleep(backoff);
  }
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini HTTP ${response.status}`);
  return payload;
}

// Extrahiert/repariert ein JSON-Objekt {english, german, status} aus rohem LLM-Text
// (Markdown-Codefences, unescaped Newlines im String etc.).
function extractInstructionJson(text, providerLabel) {
  if (!text) throw new Error(`${providerLabel} lieferte keine Instructions (leere Antwort)`);
  const candidate = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  if (objectStart < 0 || objectEnd <= objectStart) throw new Error(`${providerLabel} lieferte kein JSON-Objekt (${text.slice(0, 120)})`);
  const jsonText = candidate.slice(objectStart, objectEnd + 1);
  let inString = false;
  let safeJson = "";
  for (let index = 0; index < jsonText.length; index++) {
    const character = jsonText[index];
    const previous = jsonText[index - 1];
    const escaped = previous === "\\" && jsonText[index - 2] !== "\\";
    if (character === '"' && !escaped) inString = !inString;
    if (inString && character === "\n") safeJson += "\\n";
    else if (inString && character === "\r") continue;
    else if (inString && character === "\t") safeJson += "\\t";
    else safeJson += character;
  }
  let instruction;
  try {
    instruction = JSON.parse(safeJson);
  } catch (error) {
    throw new Error(`${providerLabel} JSON ungültig: ${error instanceof Error ? error.message : String(error)} · Anfang: ${safeJson.slice(0, 180)}`);
  }
  if (!instruction.english || !instruction.german) throw new Error(`${providerLabel} lieferte unvollständige Instructions`);
  return instruction;
}

// Generischer Batch-Runner mit begrenzter Nebenläufigkeit.
async function runInstructionBatch(items, generate, concurrency, delayMs) {
  const results = {};
  const queue = [...items];
  let active = 0;
  let idx = 0;

  await new Promise((resolve) => {
    function next() {
      if (idx >= queue.length && active === 0) { resolve(); return; }
      while (active < concurrency && idx < queue.length) {
        const item = queue[idx++];
        active++;
        sleep(delayMs * (idx - 1 > 0 ? 1 : 0)).then(() =>
          generate(item.context)
            .then((instruction) => { results[item.key] = { ok: true, instruction }; })
            .catch((error) => { results[item.key] = { ok: false, error: error instanceof Error ? error.message : String(error) }; })
            .finally(() => { active--; next(); })
        );
      }
    }
    next();
  });
  return results;
}

async function generateGeminiInstruction(context) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY fehlt im lokalen Server");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: GEMINI_INSTRUCTION_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: `WO context:\n${context}` }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            english: { type: "STRING" },
            german: { type: "STRING" },
            status: { type: "STRING", enum: ["generated", "needs_review"] },
          },
          required: ["english", "german", "status"],
        },
        maxOutputTokens: 1600,
        temperature: 0.1,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  const payload = await geminiCallWithRetry(requestBody, apiKey, model);
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!text) throw new Error(`Gemini lieferte keine Instructions (${payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason || "unbekannter Grund"})`);
  const instruction = extractInstructionJson(text, "Gemini");
  return {
    english: instruction.english,
    german: instruction.german,
    status: instruction.status === "generated" ? "generated" : "needs_review",
    generatedAt: new Date().toISOString(),
    model,
  };
}

async function generateGeminiInstructionBatch(items) {
  return runInstructionBatch(items, (context) => generateGeminiInstruction(context), GEMINI_CONCURRENCY, GEMINI_DELAY_MS);
}

async function generateClaudeInstruction(context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY fehlt im lokalen Server");
  const model = process.env.CLAUDE_MODEL || "claude-opus-5";
  const client = new Anthropic({ apiKey, maxRetries: 3 });
  const response = await client.messages.create({
    model,
    max_tokens: 1200,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: GEMINI_INSTRUCTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `WO context:\n${context}` }],
  });
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  if (!text) throw new Error("Claude lieferte keine Instructions (leere Antwort)");
  const instruction = extractInstructionJson(text, "Claude");
  return {
    english: instruction.english,
    german: instruction.german,
    status: instruction.status === "generated" ? "generated" : "needs_review",
    generatedAt: new Date().toISOString(),
    model,
  };
}

async function generateClaudeInstructionBatch(items) {
  return runInstructionBatch(items, (context) => generateClaudeInstruction(context), CLAUDE_CONCURRENCY, CLAUDE_DELAY_MS);
}

export {
  GEMINI_INSTRUCTION_SYSTEM_PROMPT,
  GEMINI_CONCURRENCY,
  GEMINI_DELAY_MS,
  CLAUDE_CONCURRENCY,
  CLAUDE_DELAY_MS,
  sleep,
  geminiCallWithRetry,
  extractInstructionJson,
  runInstructionBatch,
  generateGeminiInstruction,
  generateGeminiInstructionBatch,
  generateClaudeInstruction,
  generateClaudeInstructionBatch,
};
