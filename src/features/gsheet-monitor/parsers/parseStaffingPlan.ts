// GSheet Monitor – Parser für das wöchentliche Staffing/Hiring-BP-Sheet
// ("Headcount - Required" je Abteilung, u.a. Kitchen/Plating, über alle KWs).
// Sucht Header- und Datenzeile über Inhalt statt fester Zeilennummern, damit
// eingefügte/gelöschte Zeilen im Sheet die Zuordnung nicht kippen: die
// Header-Zeile ist die mit den meisten "YYYY-Wnn"-Zellen, die Kitchen-Zeile
// die mit "Headcount - Required" UND "Kitchen" irgendwo in der Zeile.
// Fürs Tagesbriefing wird NUR Kitchen gebraucht — Plating kommt bewusst aus
// einer anderen Quelle (siehe dailyBriefingLogic.ts).
export interface StaffingPlanResult {
  kitchenHeadcount: number | null;
  weekLabel: string;
}

function parseNum(s: string | undefined): number | null {
  if (s == null) return null;
  const cleaned = String(s).replace(/[,\s]/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseStaffingPlan(rows: string[][], weekLabel: string): StaffingPlanResult {
  let headerRow: string[] | null = null;
  let headerScore = 0;
  for (const row of rows) {
    const score = row.filter(c => /^\d{4}-W\d{2}$/.test((c ?? "").trim())).length;
    if (score > headerScore) { headerScore = score; headerRow = row; }
  }
  if (!headerRow) return { kitchenHeadcount: null, weekLabel };

  const colIndex = headerRow.findIndex(c => (c ?? "").trim() === weekLabel);
  if (colIndex < 0) return { kitchenHeadcount: null, weekLabel };

  const kitchenRow = rows.find(row =>
    row.some(c => (c ?? "").trim() === "Headcount - Required")
    && row.some(c => (c ?? "").trim() === "Kitchen"));
  if (!kitchenRow) return { kitchenHeadcount: null, weekLabel };

  return { kitchenHeadcount: parseNum(kitchenRow[colIndex]), weekLabel };
}
