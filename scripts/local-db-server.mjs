import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

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

async function generateGeminiInstruction(context) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY fehlt im lokalen Server");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: `You are the production instruction bot for HelloFresh professional food production kitchens (Factor, Verden facility).
Generate bilingual cooking instructions (English + German) following the HelloFresh KitchenOS recipe card format.

STATION FORMAT — mandatory:
Label each cooking method in processFlow as a lettered station (A, B, C...) in that exact order.
Station heading on its own line, then numbered steps below it.
Use these station name mappings exactly:
  SPICE PORTIONING  → "A. SPICE ROOM" / "A. GEWÜRZRAUM"
  VEGGIE DEBOX      → "A. VEGGIE DEBOX" / "A. GEMÜSE-DEBOX"
  PROTEIN DEBOX     → "A. PROTEIN DEBOX" / "A. PROTEINDEBOX"
  BRAISER           → "B. BRAISER" / "B. BRAISER"
  OVEN              → "B. OVEN" / "B. OFEN"
  GRILL             → "B. GRILL" / "B. GRILL"
  HORIZONTAL MIXER  → "B. HORIZONTAL MIXER" / "B. HORIZONTALMISCHER"
  PLANETARY MIXER   → "B. PLANETARY MIXER" / "B. PLANETENMISCHER"
  PATTY MAKER       → "B. PATTY MAKER" / "B. PATTY-PRESSE"
  HAND MIX          → "B. HAND MIX" / "B. HANDMISCHUNG"
  MARINADE          → "B. MARINADE" / "B. MARINADE"
  HAND MARINADE     → "B. HAND MARINADE" / "B. HANDMARINADE"
  IMMERSION BLENDER → "B. IMMERSION BLENDER" / "B. STABMIXER"
  DRAIN             → "C. DRAIN" / "C. ABTROPFEN"
  BLAST CHILLER     → "C. BLAST CHILLER" / "C. SCHNELLKÜHLER"

STEP RULES:
- Each station: 1–3 numbered steps
- Include one concise visual appearance indicator per cooking station (e.g. "golden and tender-crisp", "sauce consistency", "internal temp 75°C")
- BLAST CHILLER step must always end with: "FSQA CCP1: Verify core temperature ≤5°C." / "FSQA CCP1: Kerntemperatur ≤5°C prüfen."
- English and German must mirror exactly (same stations, same step count, same order)
- Use only facts from the supplied context; if temperature/time/quantity is missing write [MANUAL CHECK REQUIRED]
- Do NOT list all ingredients — only critical handling quantities or equipment settings
- Keep each language under 1500 characters

Return JSON: {"english":"...","german":"...","status":"needs_review"}
This is an operational draft and must be reviewed by the kitchen lead before production.` }] },
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
        maxOutputTokens: 8192,
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  let response;
  let payload;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    payload = await response.json().catch(() => ({}));
    if (response.ok || response.status < 500 || attempt === 1) break;
  }
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini HTTP ${response.status}`);
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!text) throw new Error(`Gemini lieferte keine Instructions (${payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason || "unbekannter Grund"})`);
  const candidate = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  if (objectStart < 0 || objectEnd <= objectStart) throw new Error(`Gemini lieferte kein JSON-Objekt (${text.slice(0, 120)})`);
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
    throw new Error(`Gemini JSON ungültig: ${error instanceof Error ? error.message : String(error)} · Anfang: ${safeJson.slice(0, 180)}`);
  }
  if (!instruction.english || !instruction.german) throw new Error("Gemini lieferte unvollständige Instructions");
  return {
    english: instruction.english,
    german: instruction.german,
    status: instruction.status === "generated" ? "generated" : "needs_review",
    generatedAt: new Date().toISOString(),
    model,
  };
}

async function generateGeminiInstructionBatch(items) {
  const results = {};
  const CONCURRENCY = 8;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(async (item) => {
      try {
        results[item.key] = { ok: true, instruction: await generateGeminiInstruction(item.context) };
      } catch (error) {
        results[item.key] = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));
  }
  return results;
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
