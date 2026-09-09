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

// Der FV-Code steht mal am Anfang ("FV4048A - Creamy Leek …"), mal mit Präfix
// ("[DE] - FV1351A - Cheddar …") — beide Varianten kommen in derselben KW vor.
const FV_HEADER_RE = /(FV\d{4}[A-Z]?)\s*[-–]\s*(.+)/i;

function cleanMealName(raw: string): string {
  return raw
    .replace(/^\[[^\]]*\]\s*[-–]\s*/, "")   // führendes "[DE] - "
    .replace(/\s*\[[^\]]*\]\s*$/, "")       // abschließendes "[DE]"
    .trim();
}

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
      const mealName = cleanMealName(fvMatch[2]);
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
          const platingHoldingKg = num(sr[2] ?? "");   // C
          const weighedKg = num(sr[3] ?? "");           // D "RTI Plating Kg"
          const gramPerMeal = num(sr[4] ?? "");         // E "1 Meal gram"
          const availableMealcount = num(sr[5] ?? "");  // F "Availble Mealcount"
          const minimumNeed = num(sr[6] ?? "");         // G "Minimum need"
          const shortagePct = pct(sr[7] ?? "");         // H "%"
          const backfillMeals = num(sr[8] ?? "");       // I "Backfill Meals"
          // Status steht NUR in Spalte J. Spalte I ("Backfill Meals") ist eine Zahl
          // und darf nicht als Status fehlinterpretiert werden.
          // "Done?" (mit Fragezeichen) kommt im Sheet real vor und meint "fertig-ish".
          const statusRaw = (sr[9] ?? "").trim().toLowerCase();
          const status: RtiSubRecipeEntry["status"] =
            /^done/.test(statusRaw) ? "done" :
            statusRaw === "no" ? "not-needed" :
            statusRaw ? "unknown" : "open";
          // Zweite (oder weitere) Zeile mit demselben Sub-Rezept im selben Meal-Block
          // = bereits im RTI-Rechner vorbereitete Backfill-Kandidaten-WO.
          const isBackfillCandidate = seenSubNames.has(subName);
          seenSubNames.add(subName);

          subRecipes.push({
            workOrder: wo,
            subRecipeName: subName,
            platingHoldingKg,
            weighedKg,
            gramPerMeal,
            availableMealcount,
            minimumNeed,
            backfillMeals,
            shortagePct,
            status,
            isBackfillCandidate,
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
