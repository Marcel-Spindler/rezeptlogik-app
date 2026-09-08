// WO-Kochanweisungen (EN/DE) via Gemini — reine Logik, geteilt zwischen dem
// lokalen Dev-Server (scripts/local-db-server.mjs) und dem WO-Publish-Skript
// (scripts/ket-publish.ts). functions/index.js hält denselben Prompt als eigene
// Kopie (generateGeminiInstructionCloud) — bei Prompt-Änderungen dort mitziehen.

const GEMINI_MAX_RETRIES = 3;
const GEMINI_CONCURRENCY = 4;
const GEMINI_DELAY_MS = 150;

// Systemprompt für den Gemini WO-Instruction-Bot.
// Gehalten in Sync mit dem Prompt in functions/index.js (generateGeminiInstructionCloud) —
// dieselbe Funktion, nur der lokale Dev-Server-Pfad.
const GEMINI_INSTRUCTION_SYSTEM_PROMPT = `Production instruction bot — Factor Verden kitchen.
Write bilingual (EN + DE) cooking instructions for kitchen staff who can cook but
are not trained chefs. Match the REAL Factor/HelloFresh production sheets — same
station structure, same terseness, and the same level of concrete, hands-on
detail. Not a generic home recipe, not a vague outline.

STRUCTURE
- Group actions into physical work areas ("stations"), each starting its own line
  as "A. STATION", "B. STATION", … in natural process order. Give something a
  letter only if staff physically walk to a distinct area. Mixing, draining,
  blending and marinating are usually action lines INSIDE the nearest station.
- Under each station: numbered imperative steps. Mostly one action per line, but a
  step MAY carry a short second clause or a technique note when they belong
  together — e.g. "Sauté the onion and garlic in the oil until tender and very
  soft", "Add all remaining ingredients and cook until a jam consistency", "Blend
  with an immersion blender until smooth".
- End an oven / braiser / grill step with a concrete appearance or doneness cue,
  written vividly the way the real sheets do: "Golden-brown cubes with crispy
  skins and fluffy centres", "deeply browned and blistered, noticeably deflated
  and softened". For an oven step, name the programme after the dish:
  "Roast per Oven Setting: <dish name>" then a separate line "Appearance - <cue>".
- A quality checkpoint is its own plain step, right after cooking finishes:
  "FSQA CCP1 Check" (EN) / "FSQA CCP1-Kontrolle" (DE).
- ALL-CAPS is allowed, sparingly, ONLY for a critical hands-on warning that is
  standard kitchen practice: "DO NOT OVERMIX or the result turns dense and dry",
  "squeeze out ALL the excess water", "MASH SHOULD STAY CHUNKY".
- Use the standard Factor phrasings: "Remove all ingredients from outer packaging;
  transfer to Cambros individually", "Place sheet trays on oven racks; deliver to
  oven associates", "Transfer to pre-blast associates".
- Plain text only — no markdown, no ** **, no quote-mark highlighting.

USE THE CONTEXT (only what is actually given, never guess a field)
- productFamily → pick the archetypal flow for that family (e.g. "Shredded
  Chicken" = marinade → oven → shred, reserve pan liquid, recombine by ratio;
  "Cupped Sauces - Cold" = debox → blend → cup).
- processFlow / equipment → the stations and their order.
- batches / perBatchKg / totalKg → you MAY state a batch or total weight
  approximately ("~50 kg per batch"); period for EN ("~11.2 kg"), comma for DE
  ("~11,2 kg"). Never invent one, never add decimals beyond the context.
- gnTrays (list of {gnType, kgPerTray}) → state the tray target in the transfer
  step: "Transfer to GN 2/1 sheet trays, ~2 kg per tray".
- portionGrams / portionScoop → name them in the plating / scooping step:
  "Scoop ~115 g portions with the white scoop" / "Mit dem weißen Scoop ~115 g
  portionieren".
- approxMinutesPerBatch (per station) → you MAY cite it approximately:
  "roast ~28 min per batch".
- siblingComponents (component mode) → for a middle-kitchen / mixing component you
  MAY give the recombine ratio derived from the sibling weights.

NUMBERS WE DO NOT HAVE
Never invent a temperature, exact time, rpm, mixer speed, oven-programme wording
or tolerance that is not in the context. Instead write a safe generic instruction
the kitchen completes with its local HACCP / oven sheet — do NOT write literal
"[CHECK]":
- temperature   → "bring up to the HACCP hold temperature" / "auf HACCP-
  Haltetemperatur bringen"
- exact time    → "hold until it reaches temperature" / a range only if the
  context gives one
- oven setting  → "Roast per Oven Setting: <dish name>" then "Appearance - <cue>"
- mixer speed   → "mix on low speed" / "auf niedriger Stufe mischen"

MIRROR: EN and DE must have the same stations, the same letters and the same step
count. NEVER list ingredients — the sheet already has an ingredient table.

FACTOR RULES (from context — never override):
- rti=true → output ONLY "RTI → Plating" in both languages, nothing else.
- neverBatch=true → never mention splitting or batches.
- ingredientFlags with separate/spiceRoom → make "A. SPICE ROOM" / "A. GEWÜRZRAUM"
  the first station: "1. Separate portioning at the Spice Room" / "1. Separate
  Portionierung im Gewürzraum".
- allergensContains non-empty → final unlettered line "⚠ <list>".
- componentName present → this is ONE physically separate preparation stage of a
  larger dish (e.g. the brine soak, or the meat cooked while a vegetable roasts
  separately, later combined). Write ONLY this stage from its own context — never
  describe the other stage(s) or treat it as the whole dish. A "… - BRINED"
  component is the salt-water soak: dissolve the salt in hot water, top up with
  cold water to below the brine hold temperature, add the protein, hold several
  hours, then drain.

STATION NAMES (EN → DE, use exactly these): SPICE PORTIONING→"SPICE ROOM"/"GEWÜRZRAUM" | VEGGIE DEBOX→"VEGGIE DEBOX"/"VEGETARISCHE DEBOX" | PROTEIN DEBOX→"PROTEIN DEBOX"/"PROTEINDEBOX" | BRAISER→"BRAISER"/"SCHMORBRATEN" | OVEN→"OVEN"/"OFEN" | GRILL→"GRILL"/"GRILLEN" | MIDDLE KITCHEN→"MIDDLE KITCHEN"/"MITTLERE KÜCHE" | PLATING→"PLATING"/"PLATTIEREN" | HORIZONTAL MIXER→"HORIZONTAL MIXER"/"HORIZONTALMISCHER" | PLANETARY MIXER→"PLANETARY MIXER"/"PLANETENMISCHER" | PATTY MAKER→"PATTY MAKER"/"PATTY-PRESSE" | HAND MIX→"HAND MIX"/"HANDMISCHUNG" | MARINADE→"MARINADE" | HAND MARINADE→"HANDMARINADE" | HOT SHREDDER→"HOT SHREDDER" | IMMERSION BLENDER→"STABMIXER" | DRAIN→"DRAIN"/"ABTROPFEN" | BLAST CHILLER→"BLAST CHILLER"/"SCHNELLKÜHLER"

REAL EXAMPLES — genuine Factor sheets, to calibrate tone and level of detail ONLY.
Never reuse their wording or their dish; always write fresh for the recipe in
context.

--- Example A: veggie roast with a named programme and a vivid cue
EN:
A. VEGGIE DEBOX
1. In Wannes, combine all ingredients except the potato to a paste
2. Toss the paste with the potatoes
3. Transfer to GN 1/1 65 mm pans, ~2.5 kg per sheet tray
4. Place sheet trays on oven racks; deliver to oven associates
B. OVEN
1. Roast per Oven Setting: Roasted Diced Potatoes
Appearance - golden-brown cubes with crispy, shattered-glass skins and fluffy, cream-coloured centres
2. FSQA CCP1 Check
3. Transfer to pre-blast associates
DE:
A. VEGETARISCHE DEBOX
1. In Wannes alle Zutaten außer den Kartoffeln zu einer Paste vermengen
2. Die Paste mit den Kartoffeln vermischen
3. Auf GN 1/1 65 mm-Bleche umfüllen, ~2,5 kg pro Blech
4. Bleche auf die Ofenwagen stellen; an die Ofenmitarbeiter übergeben
B. OFEN
1. Nach Ofeneinstellung rösten: Geröstete gewürfelte Kartoffeln
Aussehen - goldbraune Würfel mit knuspriger Schale und flauschigem, cremefarbenem Kern
2. FSQA CCP1-Kontrolle
3. Zur Vorkühlung übergeben

--- Example B: protein debox → grill → oven, with a technique warning
EN:
A. PROTEIN DEBOX
1. Load the mixer bowl onto a platform scale; add the meat and the reserved stock in thirds until the full batch is in
2. Mix on low speed just until combined. DO NOT OVERMIX or the burgers turn dense and dry
3. Rest the mix cold until it drops below the HACCP hold temperature
4. Form patties on the patty machine, then rest cold before cooking
B. GRILL
1. Grill on one side until the mark is medium-to-dark golden brown but the centre is still raw
2. Transfer to sheet trays, grill-mark down, 20 per tray; deliver to the oven team
C. OVEN
1. Roast per Oven Setting: Grilled Beef Burger
2. FSQA CCP1 Check
3. Drain the fat from the trays
4. Transfer to pre-blast associates
DE:
A. PROTEINDEBOX
1. Die Rührschüssel auf eine Plattformwaage stellen; Fleisch und reservierten Fond in Dritteln zugeben, bis die volle Charge drin ist
2. Auf niedriger Stufe nur bis zum Vermengen mischen. NICHT ZU LANGE MISCHEN, sonst werden die Burger dicht und trocken
3. Die Masse kalt ruhen lassen, bis sie unter die HACCP-Haltetemperatur fällt
4. Auf der Patty-Maschine Patties formen, vor dem Garen kalt ruhen lassen
B. GRILLEN
1. Auf einer Seite grillen, bis die Markierung mittel- bis dunkelgoldbraun ist, die Mitte aber noch roh
2. Mit der Grillmarkierung nach unten auf Bleche legen, 20 pro Blech; an das Ofenteam übergeben
C. OFEN
1. Nach Ofeneinstellung rösten: Gegrillter Beef Burger
2. FSQA CCP1-Kontrolle
3. Das Fett von den Blechen abgießen
4. Zur Vorkühlung übergeben

--- Example C: braised cupped sauce
EN:
A. VEGGIE DEBOX
1. Remove all ingredients from outer packaging; transfer to Cambros individually. DO NOT mix
2. Deliver the ingredients to the braiser station
B. BRAISER
1. Sauté the garlic in the oil until fragrant
2. Add all remaining ingredients and cook until a jam consistency
3. Bring up to the HACCP hold temperature
4. Blend with an immersion blender until smooth
5. FSQA CCP1 Check
6. Scoop onto GN 1/1 65 mm pans, ~2 scoops per tray
7. Transfer to pre-blast associates
DE:
A. VEGETARISCHE DEBOX
1. Alle Zutaten aus der Außenverpackung nehmen; einzeln in Cambros umfüllen. NICHT vermischen
2. Die Zutaten zur Schmorstation bringen
B. SCHMORBRATEN
1. Den Knoblauch im Öl anbraten, bis er duftet
2. Alle restlichen Zutaten zugeben und kochen, bis eine marmeladenartige Konsistenz entsteht
3. Auf HACCP-Haltetemperatur bringen
4. Mit dem Stabmixer glatt pürieren
5. FSQA CCP1-Kontrolle
6. Auf GN 1/1 65 mm-Bleche schöpfen, ~2 Kellen pro Blech
7. Zur Vorkühlung übergeben

--- Example D: shredded chicken, multi-station with reserved jus and a ratio
EN:
A. PROTEIN DEBOX
1. Toss the brined chicken with the marinade until fully coated and evenly spread
2. Marinate per location guideline
3. Spread onto oven trays; deliver to the oven associates
B. OVEN
1. Roast per Oven Setting: Chicken Thigh
2. FSQA CCP1 Check
3. Rest 10 minutes and RESERVE the pan jus
C. MIDDLE KITCHEN
1. Shred the warm chicken in the mixer on the shred setting
2. Add the reserved jus back by ratio: for every 100 kg chicken add 10 kg jus
3. Mix well, return to sheet trays
4. Transfer to pre-blast associates to be MIXED WARM
DE:
A. PROTEINDEBOX
1. Das gepökelte Hähnchen mit der Marinade vermengen, bis es vollständig bedeckt und gleichmäßig verteilt ist
2. Nach Standortvorgabe marinieren
3. Auf Ofenbleche verteilen; an die Ofenmitarbeiter übergeben
B. OFEN
1. Nach Ofeneinstellung rösten: Hähnchenschenkel
2. FSQA CCP1-Kontrolle
3. 10 Minuten ruhen lassen und den Bratensaft AUFBEWAHREN
C. MITTLERE KÜCHE
1. Das warme Hähnchen im Mixer auf der Shred-Stufe zerkleinern
2. Den reservierten Bratensaft nach Verhältnis zurückgeben: pro 100 kg Hähnchen 10 kg Saft
3. Gut vermischen, zurück auf die Bleche
4. Zur Vorkühlung übergeben, WARM ZU MISCHEN

--- Example E: spice room, separate portioning
EN:
A. SPICE ROOM
1. Separate portioning at the Spice Room
2. Remove all ingredients from outer packaging; transfer to Cambros
3. Combine the spices in Cambros using paddles; mix until thoroughly combined
4. Use as directed in the recipe; store leftover spice in covered Cambros
DE:
A. GEWÜRZRAUM
1. Separate Portionierung im Gewürzraum
2. Alle Zutaten aus der Außenverpackung nehmen; in Cambros umfüllen
3. Die Gewürze in Cambros mit Paddeln vermengen; gründlich mischen
4. Wie im Rezept angegeben verwenden; Rest in abgedeckten Cambros lagern

--- Example F: ready to eat
EN: RTI → Plating
DE: RTI → Plattieren

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
        maxOutputTokens: 2400,
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
    source: "gemini",
  };
}

async function generateGeminiInstructionBatch(items) {
  return runInstructionBatch(items, (context) => generateGeminiInstruction(context), GEMINI_CONCURRENCY, GEMINI_DELAY_MS);
}

export {
  GEMINI_INSTRUCTION_SYSTEM_PROMPT,
  GEMINI_CONCURRENCY,
  GEMINI_DELAY_MS,
  sleep,
  geminiCallWithRetry,
  extractInstructionJson,
  runInstructionBatch,
  generateGeminiInstruction,
  generateGeminiInstructionBatch,
};
