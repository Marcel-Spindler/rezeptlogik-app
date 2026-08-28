import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  generateGeminiInstruction,
  generateGeminiInstructionBatch,
  generateClaudeInstruction,
  generateClaudeInstructionBatch,
  geminiCallWithRetry,
} from "./lib/gemini-instruction.mjs";

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

async function generateGeminiVorplanung(currentWeek, prevWeek, gsheetUrl) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY fehlt im lokalen Server");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const systemPrompt = [
    "Du bist Marcel's KI-Planungsassistent für die Vor-Vor-Planung bei HelloFresh Verden.",
    "Du schreibst locker, direkt und auf den Punkt — wie ein erfahrener Planer der die Zahlen kennt.",
    "Eingestreute kurze Kommentare und Einschätzungen sind erwünscht.",
    "",
    "Du bekommst den VOLLSTÄNDIGEN Production Plan der aktuellen Woche und der Vorwoche.",
    "",
    "Erstelle den Bericht ZUERST AUF ENGLISCH, dann die deutsche Übersetzung darunter.",
    "Trenne beide Versionen mit einer Leerzeile und '--- DE ---'.",
    "",
    "Erstelle einen Klartext-Bericht (Copy-Paste in Teams/Slack/Email).",
    "Der Text geht an die Boss-Runde zur Vorab-Freigabe.",
    "",
    "PFLICHT-INHALTE (in dieser Reihenfolge):",
    "",
    "1. Überschrift: 📅 Pre-Planning {week} — Plating Plan (WIP)",
    "",
    "2. 📊 KPI COMPARISON table (plain text, align with spaces):",
    "   Metric                           | {prevWeek}  | {currentWeek} | Δ",
    "   ────────────────────────────────────────────────────────────────────",
    "   Total meals (incl. buffer)       | X           | Y             | +/-Z (+/-N%)",
    "   BENL                             | X           | Y             | +/-Z",
    "   NORD                             | X           | Y             | +/-Z",
    "   DE                               | X           | Y             | +/-Z",
    "   Recipes                          | X           | Y             | +/-Z",
    "   Avg. complexity score            | X           | Y             | +/-Z",
    "   Total active cook time           | X min       | Y min         | +/-Z min",
    "   Total passive hold time          | X min       | Y min         | +/-Z min",
    "   Peak meals/hour (busiest day)    | X           | Y             | +/-Z",
    "   Top-volume recipe                | Name (Port) | Name (Port)   | –",
    "   ────────────────────────────────────────────────────────────────────",
    "   Use thousands separator (e.g. 79,517). If prev week unavailable, use '–'.",
    "",
    "3. 🥤 CUP-PREP DETAIL:",
    "   - Number of meals cupped AND total portions going through cup",
    "   - A meal needs cupping if stations.cup=true OR day matrix label contains 'Cup'/'Cup + Slicing'",
    "   - Delta vs. prev week (meals AND portions)",
    "   - List cup meals with portion count",
    "",
    "4. 🔪🔥🍳🍲🧈 STATIONS OVERVIEW:",
    "   - Per station: meals + total portions, delta vs. prev week",
    "",
    "5. ⚠️ ALLERGENS:",
    "   - Full list this week",
    "   - NEW allergens vs. prev week highlighted: '⚠️🆕 NEW: sesame, fish'",
    "   - Dropped allergens mentioned briefly",
    "",
    "6. 📈 RISKS (1-2 sentences max):",
    "   - Only mention if there's a real issue (high complexity, capacity concern)",
    "   - Skip entirely if nothing noteworthy",
    "",
    "7. 💡 SUMMARY (1-2 sentences max):",
    "   - One-liner on volume stability, regional shifts, cook time trend",
    "   - Keep it tight, no padding",
    "",
    "8. CLOSING (always at the end, verbatim):",
    "   'Detailed day/station overview (who plates what when, incl. cup/slicing) attached as graphic.'",
    "   ''",
    "   'Feedback, corrections, or hints on potential bottlenecks always welcome – the earlier, the better.'",
    "   ''",
    "   '🔗 Plan: {gsheetUrl}'   ← insert the actual GSheet URL here if provided",
    "   ''",
    "   'Best regards'",
    "",
    "   In the German version use the same closing but translated:",
    "   'Die detaillierte Tages- und Stationsübersicht (wer plattiert wann was, inkl. Cup-/Slicing-Hinweisen) ist als Grafik beigefügt.'",
    "   ''",
    "   'Feedback, Korrekturen oder Hinweise zu möglichen Engpässen sind jederzeit willkommen – je früher, desto besser können wir reagieren.'",
    "   ''",
    "   '🔗 Plan: {gsheetUrl}'",
    "   ''",
    "   'Viele Grüße'",
    "",
    "FORMAT RULES:",
    "- Use emojis (📊📦🥤🔪🔥⚠️🆕📈🏆💡)",
    "- Plain text, NO Markdown (no **, no ```, no #)",
    "- Thousands separator for numbers (79,517 in EN / 79.517 in DE)",
    "- English version FIRST, then '--- DE ---', then German translation",
    "- Both versions must have all 8 sections",
    "- Sections 6 (Risks) and 7 (Summary) are SHORT: 1-2 sentences each, not more!",
    "- The KPI table alone is 12+ lines",
    "- Closing (section 8) must be verbatim, word for word",
    "",
    "WICHTIG zur Cup-Berechnung:",
    "- stations.cup = true ODER ein Tages-Label das 'Cup' enthält → dieses Meal wird gecuppt",
    "- PORTIONEN gecuppt = Summe totalWithBuffer aller Cup-Meals",
    "- Im Kontext siehst du 'CUP-GESAMT' = korrekt berechnete Zahl (nutze DIESE!)",
  ].join("\n");

  function summarizePlanData(data, label) {
    if (!data) return `${label}: nicht verfügbar\n`;
    const rows = data.rows || [];
    const mealCount = rows.length;
    const totalPortions = data.totals?.totalWithBuffer ?? rows.reduce((s, r) => s + (r.totalWithBuffer || 0), 0);
    const totalBenl = data.totals?.benl ?? rows.reduce((s, r) => s + (r.benl || 0), 0);
    const totalNordics = data.totals?.nordics ?? rows.reduce((s, r) => s + (r.nordics || 0), 0);
    const totalDe = data.totals?.de ?? rows.reduce((s, r) => s + (r.de || 0), 0);

    // Highrunner: Meal mit den meisten Portionen
    const highrunner = rows.reduce((best, r) => (!best || r.totalWithBuffer > best.totalWithBuffer) ? r : best, null);

    // Station-Flags (Spalte N-S)
    const stationDetails = {};
    const stationPortions = {};
    for (const r of rows) {
      for (const [key, val] of Object.entries(r.stations || {})) {
        if (val) {
          stationDetails[key] = (stationDetails[key] || 0) + 1;
          stationPortions[key] = (stationPortions[key] || 0) + (r.totalWithBuffer || 0);
        }
      }
    }

    // Cup-Erkennung aus Tages-Matrix (fängt "Cup + Slicing" u.ä. auf)
    const cupFromDayMatrix = [];
    for (const r of rows) {
      if (r.stations?.cup) continue; // bereits per Flag gezählt
      const hasCupLabel = Object.values(r.byDay || {}).some(
        cell => cell && cell.kind === "station" && /cup/i.test(cell.label || "")
      );
      if (hasCupLabel) cupFromDayMatrix.push(r.code);
    }
    const totalCupMeals = (stationDetails.cup || 0) + cupFromDayMatrix.length;
    const totalCupPortions = (stationPortions.cup || 0) + rows.filter(r => cupFromDayMatrix.includes(r.code)).reduce((s, r) => s + (r.totalWithBuffer || 0), 0);

    const allergens = [...new Set(rows.flatMap(r => (r.allergens || "").split(",").map(a => a.trim()).filter(Boolean)))].sort();
    const complexities = rows.filter(r => r.complexityScore != null).map(r => ({ code: r.code, name: r.recipeName, score: r.complexityScore }));
    const highComplexity = complexities.filter(c => c.score > 6);
    const avgComplexity = complexities.length > 0 ? (complexities.reduce((a, b) => a + b.score, 0) / complexities.length).toFixed(2) : "n/a";

    // Aggregierte Zeiten
    const totalActiveCookMin = rows.reduce((s, r) => s + (r.activeCookMin || 0), 0);
    const totalPassiveHoldMin = rows.reduce((s, r) => s + (r.passiveHoldMin || 0), 0);

    // Peak meals/hour aus kpiRows ("per hour" oder "per hr")
    let peakMealsPerHour = null;
    const perHourRow = (data.kpiRows || []).find(k => /per\s*h(ou)?r/i.test(k.label));
    if (perHourRow) {
      const vals = Object.values(perHourRow.byDay || {}).filter(v => v != null);
      peakMealsPerHour = vals.length > 0 ? Math.max(...vals) : null;
    }

    const mealDetails = rows.map(r => {
      const dayLabels = Object.entries(r.byDay || {})
        .filter(([, cell]) => cell && cell.kind === "station")
        .map(([day, cell]) => `${day}:${cell.label}`);
      return {
        code: r.code,
        name: r.recipeName,
        totalWithBuffer: r.totalWithBuffer,
        stations: Object.entries(r.stations || {}).filter(([, v]) => v).map(([k]) => k),
        dayLabels,
        allergens: r.allergens,
        complexityScore: r.complexityScore,
        subCount: r.subCount,
      };
    });

    const dayDistribution = {};
    for (const r of rows) {
      for (const [day, cell] of Object.entries(r.byDay || {})) {
        if (cell && cell.kind === "portions") {
          dayDistribution[day] = (dayDistribution[day] || 0) + 1;
        } else if (cell && cell.kind === "station") {
          const prepKey = `${day}_prep(${cell.label})`;
          dayDistribution[prepKey] = (dayDistribution[prepKey] || 0) + 1;
        }
      }
    }

    const sections = [
      `=== ${label}: ${data.week} ===`,
      `Recipes: ${mealCount}`,
      `Portionen gesamt (inkl. Buffer): ${totalPortions}`,
      `Regionen: BeNeLux=${totalBenl}, Nordics=${totalNordics}, DE=${totalDe}`,
      `Avg. Complexity: ${avgComplexity}`,
      `Total active cook time: ${totalActiveCookMin} min`,
      `Total passive hold time: ${totalPassiveHoldMin} min`,
      peakMealsPerHour != null ? `Peak meals/hour (busiest day): ${peakMealsPerHour}` : "",
      ``,
      highrunner ? `TOP-VOLUME RECIPE: ${highrunner.code} "${highrunner.recipeName}" — ${highrunner.totalWithBuffer} Portionen (${((highrunner.totalWithBuffer / totalPortions) * 100).toFixed(1)}% der Gesamtmenge)` : "",
      ``,
      `Stationen per X-Flag (Meals / Portionen):`,
      ...Object.entries(stationDetails).map(([key, count]) => `  ${key}: ${count} Meals, ${stationPortions[key]} Portionen`),
      ``,
      `CUP-GESAMT (Flag + Tages-Matrix): ${totalCupMeals} Meals, ${totalCupPortions} Portionen`,
      cupFromDayMatrix.length > 0 ? `  → davon per Tages-Label "Cup"/"Cup + Slicing" erkannt (KEIN X-Flag): ${cupFromDayMatrix.join(", ")}` : "",
      ``,
      `Allergene: ${allergens.join(", ") || "keine"}`,
      highComplexity.length > 0 ? `Hohe Complexity (>6): ${highComplexity.map(c => `${c.code} "${c.name}" (${c.score})`).join(", ")}` : "",
      ``,
      `Tages-Verteilung: ${JSON.stringify(dayDistribution)}`,
      ``,
      `Meal-Details:`,
      ...mealDetails.map(m => `  ${m.code} "${m.name}" — ${m.totalWithBuffer} Port., Stationen: [${m.stations.join(",")}], DayLabels: [${m.dayLabels.join(",")}], Allergen: ${m.allergens || "-"}, Cx: ${m.complexityScore ?? "-"}, Subs: ${m.subCount ?? "-"}`),
    ];

    if (data.kpiRows?.length > 0) {
      sections.push("", "Sheet-KPIs:");
      for (const k of data.kpiRows) {
        const vals = Object.entries(k.byDay || {}).filter(([, v]) => v != null).map(([d, v]) => `${d}=${v}`).join(", ");
        sections.push(`  ${k.label}: ${vals}`);
      }
    }
    if (data.utilization?.length > 0) {
      sections.push("", "Utilization:");
      for (const u of data.utilization) {
        const vals = Object.entries(u.byDay || {}).filter(([, v]) => v != null).map(([d, v]) => `${d}=${v}`).join(", ");
        sections.push(`  ${u.station}: ${vals}`);
      }
    }

    return sections.filter(l => l !== undefined).join("\n");
  }

  const context = [
    summarizePlanData(currentWeek, "AKTUELLE WOCHE"),
    "",
    summarizePlanData(prevWeek, "VORWOCHE"),
    "",
    gsheetUrl ? `GSHEET-LINK: ${gsheetUrl}` : "GSHEET-LINK: nicht verfügbar",
  ].join("\n");

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: context }] }],
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.4,
      thinkingConfig: { thinkingBudget: 2048 },
    },
  });

  const payload = await geminiCallWithRetry(requestBody, apiKey, model);
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!text) throw new Error("Gemini lieferte keinen Vor-Vor-Planungstext");
  return text.trim();
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

  // CORS für Vite dev server (localhost:5173)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

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
  if (url.pathname === "/api/local-db/gemini-vorplanung" && req.method === "POST") {
    readJsonBody(req)
      .then((body) => generateGeminiVorplanung(body.currentWeek, body.prevWeek, body.gsheetUrl))
      .then((result) => sendJson(res, 200, { ok: true, text: result }))
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
