import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = path.resolve(process.env.LOCAL_DB_PATH ?? path.join(root, "local-db", "rezeptlogik.sqlite"));
const endpoint = process.env.TRANSLATE_URL ?? "https://translate.googleapis.com/translate_a/single";
const db = new DatabaseSync(dbPath);
const rows = db.prepare("SELECT collection, record_key, payload FROM app_records WHERE collection = 'instructions'").all();
const update = db.prepare("UPDATE app_records SET payload = ?, updated_at = ? WHERE collection = 'instructions' AND record_key = ?");

function chunks(text, maxLength = 3500) {
  if (text.length <= maxLength) return [text];
  const lines = text.split(/\r?\n/);
  const result = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > maxLength) {
      result.push(current);
      current = "";
    }
    current += `${current ? "\n" : ""}${line}`;
  }
  if (current) result.push(current);
  return result;
}

async function translateText(text) {
  const translated = [];
  for (const chunk of chunks(text)) {
    const url = new URL(endpoint);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "en");
    url.searchParams.set("tl", "de");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", chunk);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Übersetzungsdienst HTTP ${response.status}`);
    const payload = await response.json();
    const textParts = payload?.[0]?.map((part) => part?.[0]).filter(Boolean) ?? [];
    translated.push(textParts.join(""));
  }
  return translated.join("\n");
}

let translatedCount = 0;
let skippedCount = 0;
let failedCount = 0;
for (const row of rows) {
  const instruction = JSON.parse(row.payload);
  if (!instruction.english?.trim()) {
    skippedCount++;
    continue;
  }
  if (instruction.german?.trim() && instruction.translationStatus === "translated") {
    skippedCount++;
    continue;
  }
  try {
    const german = await translateText(instruction.english);
    if (!german.trim()) throw new Error("Leere Übersetzung");
    instruction.german = german.trim();
    instruction.translationStatus = "translated";
    instruction.translatedAt = new Date().toISOString();
    update.run(JSON.stringify(instruction), new Date().toISOString(), row.record_key);
    translatedCount++;
    console.log(`Übersetzt: ${instruction.recipeCode} / ${instruction.subRecipeName}`);
  } catch (error) {
    failedCount++;
    instruction.translationStatus = "needs_translation";
    update.run(JSON.stringify(instruction), new Date().toISOString(), row.record_key);
    console.warn(`Übersetzung fehlgeschlagen: ${instruction.recipeCode} / ${instruction.subRecipeName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

db.prepare("INSERT INTO database_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("instructionsTranslatedAt", new Date().toISOString());
db.close();
console.log(JSON.stringify({ total: rows.length, translated: translatedCount, skipped: skippedCount, failed: failedCount }));
