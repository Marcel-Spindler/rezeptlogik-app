// Gemeinsame Zell-Helfer für alle Transparency-Plan-Parser. Das Sheet mischt
// Tausender-Kommas ("31,851") und reine Ziffern, und viele Tabs enthalten an
// einzelnen Stellen Formel-Fehler (#REF!/#N/A/#DIV/0!/#VALUE!) statt echter
// Werte — das macht einen Tab nicht insgesamt unbrauchbar, nur die einzelne
// Zelle. isFormulaError() erkennt diese Fälle, damit Parser sie wie leer
// behandeln statt zu crashen oder Fehlertext als Wert zu übernehmen.

export function cell(row: string[] | undefined, i: number): string {
  const raw = row?.[i];
  return raw == null ? "" : String(raw).trim();
}

export function isFormulaError(raw: string): boolean {
  return /^#(REF|N\/A|DIV\/0|VALUE|NAME\?|NULL|NUM)!?/.test(raw.trim());
}

export function safeCell(row: string[] | undefined, i: number): string {
  const v = cell(row, i);
  return isFormulaError(v) ? "" : v;
}

export function parseIntCell(row: string[] | undefined, i: number): number | null {
  const v = safeCell(row, i);
  if (!v) return null;
  const n = parseInt(v.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

export function parseFloatCell(row: string[] | undefined, i: number): number | null {
  const v = safeCell(row, i);
  if (!v) return null;
  const n = parseFloat(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseBoolCell(row: string[] | undefined, i: number): boolean {
  return safeCell(row, i).toLowerCase() === "true";
}

// "FV4034A - Pulled chicken in smokey tomato sauce [DE]" -> Code + Name.
// Kommt so kombiniert in mehreren Transparency-Tabs vor (Total Overview,
// RTEM), während andere Tabs (Planning Check, Forecast) Code/Name schon
// getrennt liefern.
export function splitRecipeCodeAndName(raw: string): { code: string; name: string } {
  const m = raw.match(/^([A-Z]{1,3}\d{3,5}[A-Z]?)\s*-\s*(.+)$/);
  if (m) return { code: m[1].trim(), name: m[2].trim() };
  return { code: "", name: raw };
}

// Erkennt "sieht aus wie ein FV/FE-Rezeptcode" (z.B. "FV4034A"). Tabs, die
// mehrere Blöcke/Wochen in derselben physischen Tab-Seite stapeln, wiederholen
// gelegentlich ihre eigene Kopfzeile mitten in den Daten ("Recipe Code" als
// Zellwert statt als echter Code) -- ohne diesen Filter würde so eine
// Kopfzeile als eigenes "Meal" durchrutschen.
export function looksLikeRecipeCode(v: string): boolean {
  return /^[A-Z]{1,3}\d{3,5}[A-Z]?$/.test(v.trim());
}

// Findet die Header-Zeile über ein Label in einer festen Spalte -- Blöcke
// verschieben sich in diesen Tabs gelegentlich (neue Zeilen oben eingefügt),
// eine feste Zeilennummer wäre zu brüchig.
export function findHeaderIndex(rows: string[][], colIndex: number, expected: string): number {
  return rows.findIndex((r) => cell(r, colIndex) === expected);
}
