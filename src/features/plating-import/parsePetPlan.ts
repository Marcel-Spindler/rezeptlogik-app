// Parser für "PET-Verden-2026-W{XX}.csv".
// Struktur: Row 1 = Header (Type, Production Shift, ..., Recipe WO #, Recipe Name, ..., Recipe WO Target, ...)
// Rows 2+ = "Recipe WO" Zeilen mit je einem Rezept pro Plating-Schicht.
// Produziert dasselbe PlatingPlanData-Format wie parsePlatingPlanCsv.
import Papa from "papaparse";
import type { PlatingDayEntry, PlatingPlanData, PlatingPlanRecipe } from "../../core/types";

const EN_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayNameFromDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return EN_DAYS[date.getDay()] ?? "";
}

function formatDateStr(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.`;
}

function extractCode(recipeName: string): string {
  const m = /([A-Z]{2}\d{4}[A-Z0-9]+)/.exec(recipeName);
  return m ? m[1] : "";
}

function cleanName(recipeName: string): string {
  return recipeName
    .replace(/^[A-Z]{2}\d{4}[A-Z0-9]+\s*-?\s*/, "")
    .replace(/\s*\[.*?\]\s*/g, " ")
    .replace(/\s*-\s*$/, "")
    .replace(/^\s*-\s*/, "")
    .trim();
}

function detectWeekFromRows(rows: Record<string, string>[]): string {
  for (const row of rows) {
    const shift = (row["Production Shift"] ?? "").trim();
    const m = shift.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const date = new Date(+m[1], +m[2] - 1, +m[3]);
      const jan1 = new Date(date.getFullYear(), 0, 1);
      const dayOfYear = Math.floor((date.getTime() - jan1.getTime()) / 86400000) + 1;
      const weekNum = Math.ceil((dayOfYear + jan1.getDay()) / 7);
      return `${date.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
    }
  }
  return "";
}

function detectWeekFromShift(rows: Record<string, string>[]): string {
  for (const row of rows) {
    const wo = (row["Recipe WO #"] ?? "").trim();
    const m = wo.match(/^(\d{1,2})-/);
    if (m) return `2026-W${m[1].padStart(2, "0")}`;
  }
  return detectWeekFromRows(rows);
}

export function isPetPlanCsv(text: string): boolean {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  return firstLine.includes("Production Shift") && firstLine.includes("Recipe WO");
}

export function parsePetPlanCsv(text: string, fileName?: string): PlatingPlanData {
  const result = Papa.parse<Record<string, string>>(
    text.replace(/^\uFEFF/, ""),
    { header: true, skipEmptyLines: true },
  );

  const rows = result.data.filter(r => (r["Type"] ?? "").trim() === "Recipe WO");
  if (rows.length === 0) throw new Error("Keine 'Recipe WO'-Zeilen in PET-CSV gefunden");

  // Woche ermitteln
  let week = "";
  if (fileName) {
    const m = fileName.match(/W(\d{2})/i);
    if (m) week = `2026-W${m[1]}`;
  }
  if (!week) week = detectWeekFromShift(rows);
  if (!week) week = "unbekannt";

  // Rezepte gruppieren (Code → Tage)
  const recipeMap = new Map<string, {
    name: string;
    totalQty: number;
    days: Map<string, { day: string; dateStr: string; qty: number }>;
  }>();

  for (const row of rows) {
    const recipeName = (row["Recipe Name"] ?? "").trim();
    const code = extractCode(recipeName);
    if (!code) continue;

    const shift = (row["Production Shift"] ?? "").trim();
    const dateMatch = shift.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue;

    const dateKey = dateMatch[1];
    const qty = Math.round(Math.abs(parseFloat((row["Recipe WO Target"] ?? "0").replace(/,/g, "")) || 0));
    if (qty === 0) continue;

    if (!recipeMap.has(code)) {
      recipeMap.set(code, { name: cleanName(recipeName), totalQty: 0, days: new Map() });
    }
    const entry = recipeMap.get(code)!;
    entry.totalQty += qty;

    const existing = entry.days.get(dateKey);
    if (existing) {
      existing.qty += qty;
    } else {
      entry.days.set(dateKey, {
        day: dayNameFromDate(dateKey),
        dateStr: formatDateStr(dateKey),
        qty,
      });
    }
  }

  const recipes: PlatingPlanRecipe[] = [];
  for (const [code, entry] of recipeMap) {
    const platingDays: PlatingDayEntry[] = [...entry.days.values()].sort(
      (a, b) => a.dateStr.localeCompare(b.dateStr),
    );
    recipes.push({
      recipeCode: code,
      recipeName: entry.name,
      numSubs: 0,
      totalQty: entry.totalQty,
      platingDays,
    });
  }

  return { week, importedAt: new Date().toISOString(), recipes };
}
