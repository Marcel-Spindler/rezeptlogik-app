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

const FV_HEADER_RE = /^(FV\d{4}[A-Z]?)\s*-\s*(.+)/i;

function isEndOfWeekMarker(row: string[]): boolean {
  return /end of week count/i.test((row[0] ?? "") + " " + (row[1] ?? ""));
}

export function parseRti(rows: string[][]): RtiData {
  const meals: RtiMealBlock[] = [];
  const week = detectWeek(rows);
  let i = 0;

  while (i < rows.length) {
    const row = rows[i];

    // Ab hier beginnt der Bilanz-Bereich einer ANDEREN Kalenderwoche im selben Tab —
    // nicht mehr für die aktuelle Woche auswerten.
    if (isEndOfWeekMarker(row)) break;

    // Erkennung eines neuen Meal-Blocks direkt am FV-Code in Spalte B. Jeder Meal-Block
    // hat seine eigene Header-Zeile — die "Planned Target"-Beschriftung selbst steht nur
    // EINMAL ganz oben im Tab und darf kein Gate für weitere Meals sein.
    const headerCell = (row[1] ?? "").trim();
    const fvMatch = FV_HEADER_RE.exec(headerCell);

    if (fvMatch) {
      const mealCode = fvMatch[1].toUpperCase();
      const mealName = fvMatch[2].replace(/\s*\[.*?\]\s*$/, "").trim();
      const planned = num(row[3] ?? "");
      const actuals = num(row[4] ?? "");
      const delta = num(row[5] ?? "");
      const deltaPct = pct(row[6] ?? "");

      // Skip Meal-Header + optionale WO-Header-Zeile
      i += 1;
      if (i < rows.length && (rows[i][0] ?? "").includes("WO")) i++;

      // Sub-Recipes einlesen bis zur nächsten Leerzeile / zum nächsten Meal-Block
      const subRecipes: RtiSubRecipeEntry[] = [];
      const seenSubNames = new Set<string>();
      while (i < rows.length) {
        const sr = rows[i];
        const wo = (sr[0] ?? "").trim();
        const subName = (sr[1] ?? "").trim();

        // Nächster Meal-Block folgt direkt (ohne Leerzeile) → NICHT konsumieren, nur stoppen
        if (FV_HEADER_RE.test(subName) || isEndOfWeekMarker(sr)) break;
        // Leerzeile → Block Ende
        if (!wo && !subName) { i++; break; }

        if (/^\d{2,3}-\d{2,4}$/.test(wo) && subName) {
          const holding = num(sr[2] ?? "");
          const rtiKgCol3 = num(sr[3] ?? "");
          const rtiKgCol4 = num(sr[4] ?? "");
          const rtiKg = (sr[3] ?? "").trim() !== "" ? rtiKgCol3 : rtiKgCol4;
          const produced = num(sr[5] ?? "");
          const subDeltaCol6 = (sr[6] ?? "").trim();
          const subDelta = subDeltaCol6 !== "" ? num(subDeltaCol6) : num(sr[5] ?? "");
          const subDeltaPct = pct(sr[7] ?? "");
          const statusRaw = (sr[9] ?? sr[8] ?? "").trim().toLowerCase();
          const status: RtiSubRecipeEntry["status"] =
            statusRaw === "done" ? "done" :
            statusRaw === "no" ? "not-needed" :
            statusRaw ? "unknown" : "open";
          // Zweite (oder weitere) Zeile mit demselben Sub-Rezept im selben Meal-Block
          // = bereits im RTI-Rechner vorbereitete Backfill-Kandidaten-WO.
          const isBackfillCandidate = seenSubNames.has(subName);
          seenSubNames.add(subName);

          subRecipes.push({
            workOrder: wo,
            subRecipeName: subName,
            platingHoldingKg: holding,
            rtiPlatingKg: rtiKg,
            producedQty: produced,
            delta: subDelta,
            deltaPct: subDeltaPct,
            status,
            isBackfillCandidate
          });
        }
        i++;
      }

      meals.push({ mealCode, mealName, plannedTarget: planned, actuals, delta, deltaPct, subRecipes });
      continue;
    }
    i++;
  }

  return { week, meals, lastUpdated: Date.now() };
}
