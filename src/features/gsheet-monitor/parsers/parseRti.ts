// GSheet Monitor – RTI Parser: parst das RTI-Sheet in strukturierte Meal-Blöcke.
import type { RtiData, RtiMealBlock, RtiSubRecipeEntry } from "../gsheetTypes";

function num(s: string): number {
  if (!s || s === "#DIV/0!") return 0;
  const cleaned = s.replace(/[,\s]/g, "").replace(/[^\d.\-]/g, "");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

function pct(s: string): number {
  if (!s || s === "#DIV/0!") return 0;
  const cleaned = s.replace(/[%\s]/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

function detectWeek(rows: string[][]): string {
  for (const row of rows) {
    const cell = (row[0] ?? "").trim();
    const m = /^KW\s*(\d+)/i.exec(cell);
    if (m) return `W${m[1].padStart(2, "0")}`;
  }
  return "";
}

export function parseRti(rows: string[][]): RtiData {
  const meals: RtiMealBlock[] = [];
  const week = detectWeek(rows);
  let i = 0;

  while (i < rows.length) {
    const row = rows[i];

    // Erkennung eines neuen Meal-Blocks: Zeile mit "Planned Target" + nächste Zeile hat FV-Code
    if ((row[3] ?? "").includes("Planned Target")) {
      // Nächste Zeile = Meal-Header mit FV-Code, Target, Actuals
      const headerRow = rows[i + 1] ?? rows[i];
      const mealCell = (headerRow[1] ?? "").trim();
      const fvMatch = /^(FV\d{4}[A-Z]?)\s*-\s*(.+)/i.exec(mealCell);

      if (fvMatch) {
        const mealCode = fvMatch[1].toUpperCase();
        const mealName = fvMatch[2].replace(/\s*\[.*?\]\s*$/, "").trim();
        const planned = num(headerRow[3] ?? "");
        const actuals = num(headerRow[4] ?? "");
        const delta = num(headerRow[5] ?? "");
        const deltaPct = pct(headerRow[6] ?? "");

        // Skip header + WO-Header zeile
        i += 2;
        if (i < rows.length && (rows[i][0] ?? "").includes("WO")) i++;

        // Sub-Recipes einlesen bis zur nächsten Leerzeile / neuem Meal-Block
        const subRecipes: RtiSubRecipeEntry[] = [];
        while (i < rows.length) {
          const sr = rows[i];
          const wo = (sr[0] ?? "").trim();
          const subName = (sr[1] ?? "").trim();

          // Leer oder neuer Block → stoppen
          if (!wo && !subName) { i++; break; }
          if ((sr[3] ?? "").includes("Planned Target")) break;

          if (/^\d{2,3}-\d{2,4}$/.test(wo) && subName) {
            const holding = num(sr[2] ?? "");
            const rtiKg = num(sr[3] ?? "") || num(sr[4] ?? "");
            const produced = num(sr[5] ?? "");
            const subDelta = num(sr[6] ?? "") || num(sr[5] ?? "");
            const subDeltaPct = pct(sr[7] ?? "");
            const statusRaw = (sr[9] ?? sr[8] ?? "").trim().toLowerCase();
            const status: RtiSubRecipeEntry["status"] = statusRaw === "done" ? "done" : statusRaw ? "unknown" : "open";

            subRecipes.push({
              workOrder: wo,
              subRecipeName: subName,
              platingHoldingKg: holding,
              rtiPlatingKg: rtiKg,
              producedQty: produced,
              delta: subDelta,
              deltaPct: subDeltaPct,
              status
            });
          }
          i++;
        }

        meals.push({ mealCode, mealName, plannedTarget: planned, actuals, delta, deltaPct, subRecipes });
        continue;
      }
    }
    i++;
  }

  return { week, meals, lastUpdated: Date.now() };
}
