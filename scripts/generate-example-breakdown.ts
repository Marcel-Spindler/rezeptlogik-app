import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calcBatch } from "../src/features/ket-plan/ketLogic";
import { buildPdf } from "../src/features/ket-plan/ketPdf";
import { EQUIP_DEFAULTS } from "../src/features/ket-plan/ketTypes";
import { generateWoInstruction } from "../src/features/ket-plan/woInstructionBot";
import type { DataBundle } from "../src/core/types";

const root = process.cwd();
const db = new DatabaseSync(path.join(root, "local-db", "rezeptlogik.sqlite"), { readOnly: true });
const data = JSON.parse(fs.readFileSync(path.join(root, "public/data/data.json"), "utf8")) as DataBundle;
const bundleRows = db.prepare("SELECT record_key, payload FROM app_records WHERE collection = 'bundle'").all() as Array<{ record_key: string; payload: string }>;
for (const row of bundleRows) (data as Record<string, unknown>)[row.record_key] = JSON.parse(row.payload);
data.instructions = Object.fromEntries(
  (db.prepare("SELECT record_key, payload FROM app_records WHERE collection = 'instructions'").all() as Array<{ record_key: string; payload: string }>)
    .map((row) => [row.record_key, JSON.parse(row.payload)]),
);
data.recipes = Object.fromEntries(
  (db.prepare("SELECT record_key, payload FROM app_records WHERE collection = 'recipes'").all() as Array<{ record_key: string; payload: string }>)
    .map((row) => [row.record_key, JSON.parse(row.payload)]),
);
data.structures = Object.fromEntries(
  (db.prepare("SELECT record_key, payload FROM app_records WHERE collection = 'structures'").all() as Array<{ record_key: string; payload: string }>)
    .map((row) => [row.record_key, JSON.parse(row.payload)]),
);
const productionRows = (db.prepare("SELECT payload FROM app_records WHERE collection = 'productionPlan'").all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload));
data.productionPlan = { week: "2026-W34", generatedAt: new Date().toISOString(), rows: productionRows };
db.close();

const sourceRow = productionRows.find((entry) => entry.workOrder === "34-64");
if (!sourceRow) throw new Error("WO 34-64 nicht in der lokalen Datenbank gefunden");
const row = {
  key: `example::${sourceRow.workOrder}`,
  dateNeeded: sourceRow.kitchenDay ?? "",
  shift: sourceRow.kitchenDay?.match(/[-–]\s*(\d+)$/)?.[1] ?? "",
  woNumber: sourceRow.workOrder,
  recipeId: sourceRow.recipeId ?? "",
  recipeCode: sourceRow.recipeCode,
  recipeName: sourceRow.recipeName,
  subRecipeName: sourceRow.subRecipe,
  cookMethods: sourceRow.cookMethods ? sourceRow.cookMethods.split(",").map((method: string) => method.trim().toUpperCase()).filter(Boolean) : [],
  woCookedPortions: sourceRow.woCookedPortions ?? null,
  targetPortions: sourceRow.targetPortions ?? sourceRow.plannedMeals ?? 0,
  cookedPortionsExcess: sourceRow.cookedPortionsExcess ?? null,
  stagingStatus: sourceRow.stagingStatus ?? "",
  stagingComment: sourceRow.stagingComment ?? "",
  kitchenStatus: sourceRow.kitchenStatus ?? "",
  unlockedEta: sourceRow.unlockedEta ?? "",
  workOrderComment: sourceRow.workOrderComment ?? "",
};
const calc = calcBatch(row, { ...EQUIP_DEFAULTS }, data);
const instruction = await generateWoInstruction(row, calc);
const html = buildPdf([row], new Map([[row.key, calc]]), { ...EQUIP_DEFAULTS }, "WO 34-64 · Mixed veg - Roasted Zucchini & Corn", "CSV", { [row.key]: instruction });
const outputPath = path.join(root, "public/data/example-wo-34-64-breakdown.html");
fs.writeFileSync(outputPath, html, "utf8");
console.log(JSON.stringify({ outputPath, workOrder: row.workOrder, recipeCode: row.recipeCode, subRecipe: row.subRecipeName, totalKg: calc.totalKg, batches: calc.batches, instructionStatus: instruction.status, instructionModel: instruction.model, generatedEnglish: instruction.english.length, generatedGerman: instruction.german.length, manualChecks: (instruction.english.match(/MANUAL CHECK REQUIRED/g) ?? []).length + (instruction.german.match(/MANUAL CHECK REQUIRED/g) ?? []).length }, null, 2));
