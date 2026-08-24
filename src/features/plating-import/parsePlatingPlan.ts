// Parser für "F_VE Production Plan - W{XX} - Plating Plan [WIP].csv".
// Struktur: Row 2 = Woche, Row 5 = Header (Code, ..., Sunday DD.MM., Monday DD.MM., ...),
// Rows 6+ = Rezeptzeilen bis zur leeren Code-Spalte.
import type { PlatingDayEntry, PlatingPlanData, PlatingPlanRecipe } from "../../core/types";

const EN_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseCSVRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields: string[] = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        let field = "";
        i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
          else if (line[i] === '"') { i++; break; }
          else field += line[i++];
        }
        fields.push(field);
        if (line[i] === ",") i++;
      } else {
        const end = line.indexOf(",", i);
        if (end === -1) { fields.push(line.slice(i)); i = line.length; }
        else { fields.push(line.slice(i, end)); i = end + 1; }
      }
    }
    if (line.endsWith(",")) fields.push("");
    rows.push(fields);
  }
  return rows;
}

function toNum(s: string): number {
  // Entfernt Tausender-Komma, wandelt Dezimalpunkt: "5,487" → 5487, "1.17" → 1.17
  const clean = s.replace(/,(?=\d{3}(?:[^,]|$))/g, "").replace(",", ".");
  return parseFloat(clean);
}

export function parsePlatingPlanCsv(text: string): PlatingPlanData {
  const rows = parseCSVRows(text);

  // Woche: Zeile wo Spalte 0 = "Week", Spalte 1 = "2026-W36"
  const weekRow = rows.find(r => String(r[0] ?? "").trim() === "Week");
  const week = weekRow ? String(weekRow[1] ?? "").trim() : "";

  // Header: erste Zeile wo Spalte 0 = "Code"
  const headerIdx = rows.findIndex(r => String(r[0] ?? "").trim() === "Code");
  if (headerIdx < 0) throw new Error("Header-Zeile nicht gefunden (Spalte A = 'Code' erwartet)");
  const header = rows[headerIdx];

  // Tagesspalten ermitteln: Zellen die mit Tagesname UND Datum beginnen (z.B. "Tuesday 25.08.")
  // Reine Tagesnamen ohne Datum ("Thursday") sind Summary-Spalten und werden ignoriert.
  const dayColMap: Array<{ col: number; dayName: string; dateStr: string }> = [];
  for (let col = 0; col < header.length; col++) {
    const cell = String(header[col] ?? "").trim();
    const match = EN_DAYS.find(d => cell.startsWith(d));
    if (match) {
      const dateStr = cell.replace(match, "").trim();
      if (dateStr) dayColMap.push({ col, dayName: match, dateStr }); // nur mit Datum (z.B. "25.08.")
    }
  }
  if (dayColMap.length === 0) throw new Error("Keine Tagesspalten mit Datum (z.B. 'Tuesday 25.08.') im Header gefunden");

  const recipes: PlatingPlanRecipe[] = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const code = String(row[0] ?? "").trim();
    // Rezeptcodes folgen dem Muster FVxxxxA
    if (!code || !/^[A-Z]{2}\d{4}[A-Z]$/.test(code)) continue;

    const name = String(row[2] ?? "").trim();
    const numSubs = Math.round(Math.abs(toNum(String(row[9] ?? "0"))) || 0);
    const totalQty = Math.round(Math.abs(toNum(String(row[7] ?? "0"))) || 0);

    const platingDays: PlatingDayEntry[] = [];

    for (let di = 0; di < dayColMap.length; di++) {
      const { col, dayName, dateStr } = dayColMap[di];
      const cellVal = String(row[col] ?? "").trim();
      if (!cellVal) continue;

      const qty = toNum(cellVal);
      if (!isNaN(qty) && qty > 0) {
        // Prüfe ob Vortags-Spalte ein Geräte-Label hat (z.B. "Cup", "Slicing")
        let equipment: string | undefined;
        let equipDay: string | undefined;
        if (di > 0) {
          const prevInfo = dayColMap[di - 1];
          const prevVal = String(row[prevInfo.col] ?? "").trim();
          if (prevVal && isNaN(toNum(prevVal))) {
            equipment = prevVal;
            equipDay = prevInfo.dayName;
          }
        }
        platingDays.push({ day: dayName, dateStr, qty: Math.round(qty), ...(equipment ? { equipment, equipDay } : {}) });
      }
    }

    if (platingDays.length > 0) {
      recipes.push({ recipeCode: code, recipeName: name, numSubs, totalQty, platingDays });
    }
  }

  return { week: week || "unbekannt", importedAt: new Date().toISOString(), recipes };
}
