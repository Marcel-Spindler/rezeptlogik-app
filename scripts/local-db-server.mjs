import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env.local") });
loadEnv({ path: path.join(root, ".env") });
const dbPath = path.resolve(process.env.LOCAL_DB_PATH ?? path.join(root, "local-db", "rezeptlogik.sqlite"));
const port = Number(process.env.LOCAL_DB_PORT ?? 3142);

const dbAvailable = fs.existsSync(dbPath);
if (!dbAvailable) {
  console.warn(`[local-db] SQLite-Datenbank fehlt: ${dbPath}`);
  console.warn("[local-db] DB-Endpunkte nicht verfügbar. Gemini-Endpunkte laufen trotzdem.");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function parsePayload(row) {
  return row ? JSON.parse(row.payload) : undefined;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const GEMINI_MAX_RETRIES = 3;
const GEMINI_CONCURRENCY = 4;
const GEMINI_DELAY_MS = 150;
const CLAUDE_CONCURRENCY = 2;
const CLAUDE_DELAY_MS = 300;

// Systemprompt für den Gemini WO-Instruction-Bot.
const GEMINI_INSTRUCTION_SYSTEM_PROMPT = `Kitchen WO instructions — Factor Verden. Bilingual.

Audience: kitchen staff who can cook but are not trained chefs — no professional
shorthand or jargon, spell out what to actually do and how to tell each step is done.

FORMAT: EVERY station in processFlow gets its own paragraph, each starting on a
NEW LINE (real newline character, not just a space) with a sequential letter —
"A. STATION:", then "B. STATION:", "C. STATION:", … in processFlow order. Never
run two stations together on one line. After each label, write 3-5 full, clear
sentences describing the action and a concrete visual/texture/consistency cue for
when the step is finished. Mirror EN and DE exactly (same stations, same letters,
same number of sentences). No intro text, no closing remarks.
No numbers, weights, ingredient names — the ingredient table is shown separately.
Return JSON only: {"english":"...","german":"...","status":"generated"}

FIXED:
- Letter every station A, B, C, … in the order given by processFlow — never leave
  a station unlettered, even if there's only one.
- rti=true → english:"RTI → Plating" german:"RTI → Anrichten" (no letters, nothing else)
- separate/spiceRoom items → make "SPICE ROOM" the FIRST lettered station ("A."),
  its sentences describing separate portioning at the spice room.
  EN "A. SPICE ROOM:" / DE "A. GEWÜRZRAUM:"
- BLAST CHILLER's lettered paragraph always includes exactly the phrase
  "CCP1 core safe" / "CCP1 Kern sicher" as its finish cue.
- neverBatch=true → never mention splits or batches
- allergensContains → final unlettered line "⚠ {allergens list}"

Station names EN→DE: OVEN→OFEN, HAND MIX→HANDMISCHUNG, HORIZONTAL MIXER→HORIZONTALMISCHER, PLANETARY MIXER→PLANETENMISCHER, PATTY MAKER→PATTY-PRESSE, DRAIN→ABTROPFEN, BLAST CHILLER→SCHNELLKÜHLER, VEGGIE DEBOX→GEMÜSE-DEBOX, PROTEIN DEBOX→PROTEINDEBOX, IMMERSION BLENDER→STABMIXER`;

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
  const clean = (value) => String(value)
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|gram|grams|kilograms?|ml|l|pcs|pieces?|portions?|batches?)\b/gi, "")
    .replace(/\b\d+(?:[.,]\d+)?\b/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  instruction.english = clean(instruction.english);
  instruction.german = clean(instruction.german);
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

async function generateGeminiPlanningChat(context, history, message) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY fehlt im lokalen Server");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const systemPrompt = [
    "Du bist KI-Planungsassistent für die Verden-Wochenplanung bei HelloFresh.",
    "Du kennst den aktuellen Plan und alle Regeln vollständig (sieh den Planstand unten).",
    "Antworte immer auf Deutsch, direkt und präzise.",
    "Du darfst Planänderungen vorschlagen (propose_plan_change) und Probleme melden (check_plan_issues).",
    "Änderungen werden dem Nutzer zur Bestätigung angezeigt — du änderst NIE direkt.",
    "Wenn der Nutzer keine Änderung braucht, antworte einfach mit Text.",
    "",
    context,
  ].join("\n");

  const contents = [
    ...(Array.isArray(history) ? history : []).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content || "(Planvorschlag / Analyse)" }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const tools = [{
    functionDeclarations: [
      {
        name: "propose_plan_change",
        description: "Schlägt Änderungen am Wochenplan vor. Der Nutzer sieht eine Vorschau und muss bestätigen.",
        parameters: {
          type: "OBJECT",
          properties: {
            changes: {
              type: "ARRAY",
              description: "Liste der vorgeschlagenen Assignments-Änderungen",
              items: {
                type: "OBJECT",
                properties: {
                  recipeCode: { type: "STRING", description: "Rezept-Code, z.B. FE1234A" },
                  subRecipeId: { type: "STRING", description: "Nur bei Sub-Rezepten: Sub-Rezept-ID" },
                  day: { type: "STRING", description: "Produktionstag (Mo/Di/Mi/Do/Fr/Sa)" },
                  shift: { type: "STRING", description: "S1=Frühschicht, S2=Spätschicht" },
                  targetPortions: { type: "NUMBER", description: "Optional: Ziel-Portionszahl" },
                  splitSpec: { type: "STRING", description: "Optional: Split-Spec, z.B. Do:400|Fr:1200|Sa:800" },
                  reason: { type: "STRING", description: "Kurze Begründung für diese Änderung" },
                },
                required: ["recipeCode", "day", "shift", "reason"],
              },
            },
            summary: { type: "STRING", description: "Zusammenfassung: was wird geändert und warum" },
          },
          required: ["changes", "summary"],
        },
      },
      {
        name: "check_plan_issues",
        description: "Meldet Probleme, Risiken oder Optimierungspotenziale im aktuellen Plan.",
        parameters: {
          type: "OBJECT",
          properties: {
            issues: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  severity: { type: "STRING", description: "critical, warning oder info" },
                  description: { type: "STRING" },
                  affectedRecipes: { type: "ARRAY", items: { type: "STRING" } },
                  suggestion: { type: "STRING" },
                },
                required: ["severity", "description"],
              },
            },
          },
          required: ["issues"],
        },
      },
    ],
  }];

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools,
    generationConfig: { maxOutputTokens: 4096 },
  });

  const payload = await geminiCallWithRetry(requestBody, apiKey, model);
  const parts = payload.candidates?.[0]?.content?.parts ?? [];

  let text = "";
  let toolName = null;
  let toolInput = null;

  for (const part of parts) {
    if (part.text) text += part.text;
    if (part.functionCall) {
      toolName = part.functionCall.name;
      toolInput = part.functionCall.args;
    }
  }

  return { text: text.trim(), toolName, toolInput };
}

// Rendert HTML-String mit Playwright (Chromium) zu einem PDF-Buffer.
// Gibt null zurück wenn Playwright-Browser-Binaries fehlen (graceful fallback).
async function htmlToPdf(html) {
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    throw new Error("@playwright/test nicht gefunden – bitte 'npx playwright install chromium' ausführen.");
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("executable") || msg.includes("Executable")) {
      throw new Error("Chromium-Binary fehlt. Bitte einmalig 'npx playwright install chromium' ausführen.");
    }
    throw err;
  }
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    return await page.pdf({
      format: "A4",
      margin: { top: "8mm", right: "8mm", bottom: "8mm", left: "8mm" },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
}

function loadBundle(db) {
  const bundle = {};
  const rows = db.prepare("SELECT record_key, payload FROM app_records WHERE collection = 'bundle'").all();
  for (const row of rows) {
    const value = parsePayload(row);
    if (row.record_key === "meta") Object.assign(bundle, value);
    else bundle[row.record_key] = value;
  }
  bundle.recipes = Object.fromEntries(
    db.prepare("SELECT record_key, payload FROM app_records WHERE collection = 'recipes'").all()
      .map((row) => [row.record_key, parsePayload(row)]),
  );
  bundle.structures = Object.fromEntries(
    db.prepare("SELECT record_key, payload FROM app_records WHERE collection = 'structures'").all()
      .map((row) => [row.record_key, parsePayload(row)]),
  );
  bundle.instructions = Object.fromEntries(
    db.prepare("SELECT record_key, payload FROM app_records WHERE collection = 'instructions'").all()
      .map((row) => [row.record_key, parsePayload(row)]),
  );
  return bundle;
}

function withDb(res, fn) {
  if (!dbAvailable) {
    sendJson(res, 503, { error: "Lokale Datenbank nicht gefunden. Bitte npm run db:build ausführen." });
    return;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    fn(db);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    db.close();
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  // Gemini-Endpunkte brauchen keine DB
  if (url.pathname === "/api/local-db/gemini-instruction" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => generateGeminiInstruction(body.context))
      .then((instruction) => sendJson(res, 200, { instruction }))
      .catch((error) => sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (url.pathname === "/api/local-db/gemini-instructions-batch" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => generateGeminiInstructionBatch(Array.isArray(body.items) ? body.items : []))
      .then((results) => sendJson(res, 200, { results }))
      .catch((error) => sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (url.pathname === "/api/local-db/claude-instruction" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => generateClaudeInstruction(body.context))
      .then((instruction) => sendJson(res, 200, { instruction }))
      .catch((error) => sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (url.pathname === "/api/local-db/claude-instructions-batch" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => generateClaudeInstructionBatch(Array.isArray(body.items) ? body.items : []))
      .then((results) => sendJson(res, 200, { results }))
      .catch((error) => sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (url.pathname === "/api/local-db/gemini-planning-chat" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => generateGeminiPlanningChat(body.context ?? "", body.history ?? [], body.message ?? ""))
      .then((result) => sendJson(res, 200, result))
      .catch((error) => sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (url.pathname === "/api/local-db/generate-pdf" && req.method === "POST") {
    readJsonBody(req)
      .then(async (body) => {
        if (!body.html) throw new Error("html fehlt im Request-Body");
        const pdf = await htmlToPdf(body.html);
        const filename = (body.filename ?? "wo-breakdown.pdf").replace(/[^\w\-.]+/g, "_");
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Cache-Control", "no-store");
        res.end(Buffer.from(pdf));
      })
      .catch((error) => sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) }));
    return;
  }

  // DB-abhängige Endpunkte
  if (url.pathname === "/api/local-db/health") {
    withDb(res, (db) => {
      const meta = db.prepare("SELECT key, value FROM database_meta").all();
      sendJson(res, 200, { ok: true, dbPath, dbAvailable, meta: Object.fromEntries(meta.map((row) => [row.key, row.value])) });
    });
    return;
  }
  if (url.pathname === "/api/local-db/bundle") {
    withDb(res, (db) => sendJson(res, 200, loadBundle(db)));
    return;
  }
  if (url.pathname === "/api/local-db/records") {
    const collection = url.searchParams.get("collection");
    if (!collection) { sendJson(res, 400, { error: "collection fehlt" }); return; }
    withDb(res, (db) => {
      const rows = db.prepare("SELECT record_key, payload, source, updated_at FROM app_records WHERE collection = ? ORDER BY record_key").all(collection);
      sendJson(res, 200, rows.map((row) => ({ key: row.record_key, value: parsePayload(row), source: row.source, updatedAt: row.updated_at })));
    });
    return;
  }
  sendJson(res, 404, { error: "Nicht gefunden" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Lokale Rezeptlogik-Datenbank: http://127.0.0.1:${port}`);
});
