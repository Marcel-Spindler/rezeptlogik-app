// Live-Fetch für den Google Sheets Produktionsplan.
// Kein API-Key nötig – nutzt öffentliche gviz/tq und Feeds-Endpunkte.
// Voraussetzung: Sheet ist "Jeder mit Link kann anzeigen".
//
// Tab-Struktur: "W36 - Plating Plan WIP" (aktuelle Wochen)
// Header Zeile 5: Code | Preference | Recipe Name | ... | Grill | Cup | Butter | Oven | Braiser | Slice | Allergens | ... | <Datum So> | <Datum Mo> | ... | <Datum Sa>
// Tages-Spalten: Header ist Datum-Objekt → gviz liefert "Date(2026,7,23)" → Wochentag berechnen
// Stations-Spalten: "X" = aktiv, sonst leer

const SPREADSHEET_ID = "1zaQjWKlNN4JNCMnE-lrdgf7iNgabfl9HGq5vdOyKedI";
const GVIZ_BASE = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq`;

export type SheetStation = "Grill" | "Cup" | "Butter" | "Oven" | "Braiser" | "Slice";
export const SHEET_STATIONS: SheetStation[] = ["Grill", "Cup", "Butter", "Oven", "Braiser", "Slice"];

export type SheetDay = "Sunday" | "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday";
export const ALL_DAYS: SheetDay[] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const PROD_DAYS: SheetDay[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface PlanningRow {
  code: string;
  name: string;
  preference: string;
  total: number;
  totalBuffer: number;
  stations: Partial<Record<SheetStation, boolean>>;
  // Plating-Mengen je Tag (bei Zweischicht: Früh + Spät summiert).
  days: Partial<Record<SheetDay, number>>;
  // Nur beim Zweischicht-Layout (ab W39): die geplanten KOCHmengen je Tag aus
  // dem "KITCHEN"-Block unter dem Plating-Block (Kochtag statt Plating-Tag).
  kitchenDays?: Partial<Record<SheetDay, number>>;
}

export interface PlanningSheetData {
  week: string;
  tabName: string;
  // "single" = klassisches Einschicht-Layout, "dual" = Zweischicht (ab W39,
  // Mo-Fr je Früh-/Spätschicht + separater Küchenplan-Block).
  shiftModel: "single" | "dual";
  rows: PlanningRow[];
  fetchedAt: number;
}

export interface SheetTab {
  title: string;
  sheetId: number;
}

export type SheetStatus = "idle" | "loading" | "ok" | "error";

// ── Cache ──────────────────────────────────────────────────────────────────────
const _dataCache = new Map<string, PlanningSheetData>();
const _dataCacheTimes = new Map<string, number>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Tab-Listing ────────────────────────────────────────────────────────────────
// Google Sheets v3 Feeds API ist seit 2024 abgeschaltet (404).
// Tabs werden per _findTabNameByPattern direkt über gviz gefunden.

export async function fetchAllTabs(_forceRefresh = false): Promise<SheetTab[]> {
  return [];
}

let _weekTabsCache: SheetTab[] | null = null;
let _weekTabsCacheAround = "";
let _weekTabsCacheTime = 0;

// Sucht verfügbare Wochen-Tabs (±3 Wochen um weekLabel), parallel per gviz.
export async function fetchWeekDropdownTabs(weekLabel: string, forceRefresh = false): Promise<SheetTab[]> {
  const now = Date.now();
  if (!forceRefresh && _weekTabsCache && _weekTabsCacheAround === weekLabel && now - _weekTabsCacheTime < CACHE_TTL_MS) {
    return _weekTabsCache;
  }

  const m = weekLabel.match(/(\d{4})-W(\d{1,2})$/i);
  if (!m) return [];
  const year = parseInt(m[1]);
  const week = parseInt(m[2]);

  const checks: Promise<SheetTab | null>[] = [];
  for (let w = week - 3; w <= week + 4; w++) {
    if (w < 1 || w > 53) continue;
    const label = `${year}-W${w}`;
    checks.push(
      _findTabNameByPattern(label)
        .then(name => name ? { title: name, sheetId: w } : null)
        .catch(() => null),
    );
  }

  const results = (await Promise.all(checks)).filter((t): t is SheetTab => t !== null);
  _weekTabsCache = results;
  _weekTabsCacheAround = weekLabel;
  _weekTabsCacheTime = now;
  return results;
}

// Findet den passenden Tab für ein KW-Label wie "2026-W36".
// Tabs heißen z.B. "W36 - Plating Plan WIP".
function findTabForWeek(tabs: SheetTab[], weekLabel: string): SheetTab | null {
  const exact = tabs.find(t => t.title.trim() === weekLabel);
  if (exact) return exact;

  const m = weekLabel.match(/W(\d{1,2})$/i);
  if (!m) return null;
  const wNum = m[1];
  const wNumPadded = wNum.padStart(2, "0");
  const n = parseInt(wNum);

  const patterns = [
    new RegExp(`^W${n}\\b`, "i"),          // "W36 - Plating Plan WIP"
    new RegExp(`^W${wNumPadded}\\b`, "i"), // "W36..."
    new RegExp(`\\bKW\\s*${n}\\b`, "i"),
    new RegExp(`\\bKW\\s*${wNumPadded}\\b`, "i"),
    new RegExp(`\\bWeek\\s*${n}\\b`, "i"),
    new RegExp(`-W${wNumPadded}`, "i"),
  ];

  for (const pat of patterns) {
    const found = tabs.find(t => pat.test(t.title));
    if (found) return found;
  }
  return null;
}

// ── gviz/tq Daten-Fetch (kein Key nötig) ──────────────────────────────────────

async function _fetchGvizRaw(sheetName: string): Promise<string[][]> {
  // headers=0: alle Zeilen als Daten, eigene Header-Erkennung im Parser
  const url = `${GVIZ_BASE}?tqx=out:json&headers=0&sheet=${encodeURIComponent(sheetName)}&range=A1:AK300`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gviz ${res.status} für "${sheetName}"`);
  const text = await res.text();
  return _parseGvizJson(text);
}

function _parseGvizJson(text: string): string[][] {
  const jsonStr = text
    .replace(/^\/\*[\s\S]*?\*\/\s*/, "")
    .replace(/^google\.visualization\.Query\.setResponse\(/, "")
    .replace(/\);\s*$/, "");

  let data: any;
  try { data = JSON.parse(jsonStr); } catch { return []; }

  if (data.status === "error") return [];

  const table = data.table;
  if (!table) return [];
  const numCols: number = table.cols?.length ?? 0;
  const result: string[][] = [];

  // gviz erkennt die Code-Headerzeile (Excel-Zeile 5) automatisch als Header →
  // table.rows enthält sie NICHT. Spalten-Labels aus table.cols voranstellen,
  // damit der Parser "Code" findet, auch wenn headers=0 ignoriert wurde.
  const colLabels = (table.cols ?? []).map((c: any) => (typeof c.label === "string" ? c.label : ""));
  result.push(colLabels);

  for (const row of table.rows ?? []) {
    const cells: any[] = row.c ?? [];
    const rowData: string[] = [];
    for (let i = 0; i < numCols; i++) {
      const cell = cells[i];
      if (!cell || cell.v == null) {
        rowData.push("");
      } else if (typeof cell.v === "number") {
        // Falls cell.f ein Datums-String ist (z.B. "8/23/2026"), diesen bevorzugen
        const f = typeof cell.f === "string" ? cell.f : null;
        const isDateF = f != null && /^\d{1,2}[\/\.]\d{1,2}[\/\.]\d{4}$/.test(f);
        rowData.push(isDateF ? f : String(cell.v));
      } else if (typeof cell.v === "string" && cell.v.startsWith("Date(")) {
        rowData.push(cell.v);
      } else {
        rowData.push(cell.f ?? String(cell.v));
      }
    }
    result.push(rowData);
  }
  return result;
}

// Parst Datum-Strings verschiedener gviz-Formate → Wochentag-Name
// Unterstützt: "Date(2026,7,23)" · "8/23/2026" · "23.08.2026" · "2026-08-23" · Excel-Seriennummer
function _gvizDateToDayName(s: string): SheetDay | null {
  // Format 1: gviz "Date(2026,7,23)" – Monat 0-basiert
  const gvizM = s.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})\)$/);
  if (gvizM) {
    return ALL_DAYS[new Date(+gvizM[1], +gvizM[2], +gvizM[3]).getDay()] ?? null;
  }
  // Format 2: US-Datum "8/23/2026" (M/D/YYYY)
  const usM = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usM) {
    const d = new Date(+usM[3], +usM[1] - 1, +usM[2]);
    if (!isNaN(d.getTime())) return ALL_DAYS[d.getDay()] ?? null;
  }
  // Format 3: Deutsches Datum "23.08.2026" (D.M.YYYY)
  const deM = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (deM) {
    const d = new Date(+deM[3], +deM[2] - 1, +deM[1]);
    if (!isNaN(d.getTime())) return ALL_DAYS[d.getDay()] ?? null;
  }
  // Format 4: ISO "2026-08-23"
  const isoM = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoM) {
    return ALL_DAYS[new Date(+isoM[1], +isoM[2] - 1, +isoM[3]).getDay()] ?? null;
  }
  // Format 5: Excel-Seriennummer (z.B. "46296") – Bereich 2020–2035
  const n = Number(s);
  if (Number.isFinite(n) && n > 43000 && n < 55000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return ALL_DAYS[d.getUTCDay()] ?? null;
  }
  return null;
}

// Fallback: probiert bekannte Tab-Namen direkt via gviz
async function _findTabNameByPattern(weekLabel: string): Promise<string | null> {
  const m = weekLabel.match(/W(\d{1,2})$/i);
  if (!m) return null;
  const n = parseInt(m[1]);
  const padded = String(n).padStart(2, "0");

  const candidates = [
    `W${n} - Plating Plan [WIP]`,   // "W36 - Plating Plan [WIP]" – aktuelles Format
    `W${padded} - Plating Plan [WIP]`,
    `W${n} - Plating Plan WIP`,     // altes Format ohne Klammern
    `W${padded} - Plating Plan WIP`,
    `W${n} - Plan`,
    `W${padded} - Plan`,
    weekLabel,                       // "2026-W36"
    `W${n}`,
    `W${padded}`,
    `KW${n}`,
    `KW ${n}`,
    `Week ${n}`,
  ];

  for (const name of candidates) {
    try {
      const data = await _fetchGvizRaw(name);
      if (data.length > 3) return name;
    } catch { /* weiter */ }
  }
  return null;
}

// ── Haupt-Fetch ────────────────────────────────────────────────────────────────

export async function fetchPlanningSheet(
  weekLabel: string,
  forceRefresh = false,
): Promise<PlanningSheetData> {
  const now = Date.now();
  const cached = _dataCache.get(weekLabel);
  const cachedTime = _dataCacheTimes.get(weekLabel) ?? 0;
  if (!forceRefresh && cached && now - cachedTime < CACHE_TTL_MS) return cached;

  let tabName: string | null = null;
  try {
    const tabs = await fetchAllTabs(forceRefresh);
    const tab = findTabForWeek(tabs, weekLabel);
    if (tab) tabName = tab.title;
  } catch { /* Feeds API nicht verfügbar – direkte Muster probieren */ }

  if (!tabName) {
    tabName = await _findTabNameByPattern(weekLabel);
    if (!tabName) {
      throw new Error(`Kein Tab für ${weekLabel} gefunden`);
    }
  }

  const rawData = await _fetchGvizRaw(tabName);
  const result = _parseRows(rawData, tabName);

  // Sicherheitsnetz: falls Wochenlabel nicht aus Sheet gelesen werden konnte (z.B. leere Zelle),
  // weekLabel aus dem Aufruf-Parameter ableiten wenn er dem Format "YYYY-WN" entspricht
  if (result.week === tabName && /^\d{4}-W\d{1,2}$/.test(weekLabel)) {
    result.week = weekLabel;
  }

  _dataCache.set(weekLabel, result);
  _dataCache.set(tabName, result);
  _dataCacheTimes.set(weekLabel, now);
  _dataCacheTimes.set(tabName, now);
  return result;
}

export function getCachedPlanningSheet(weekLabel: string): PlanningSheetData | null {
  return _dataCache.get(weekLabel) ?? null;
}

// ── Parser ─────────────────────────────────────────────────────────────────────

// Nur für Tests exportiert (Prefix `_` = intern, nicht im App-Code verwenden).
export function _parseRows(raw: string[][], tabName: string): PlanningSheetData {
  let week = tabName;

  // Woche aus "Week | 2026-W36" ermitteln (Zeilen 1-20 scannen)
  for (let i = 0; i < Math.min(raw.length, 20); i++) {
    const row = raw[i];
    const wi = row.findIndex(c => c.trim() === "Week");
    if (wi >= 0 && /^\d{4}-W\d{1,2}$/.test(row[wi + 1]?.trim() ?? "")) {
      week = row[wi + 1].trim();
    }
  }

  // Header-Zeile finden: muss "Code" in Spalte A enthalten
  let headerIdx = -1;
  let colCode = -1;
  let colPref = -1;
  let colName = -1;
  let colTotal = -1;
  let colTotalBuf = -1;
  const stationCols: Partial<Record<SheetStation, number>> = {};
  // Ab W39 (Zweischicht-Layout) hat ein Wochentag ZWEI Spalten (Früh-/Spät-
  // schicht) mit demselben Datums-Header → alle Spalten je Tag sammeln und
  // später aufsummieren, sonst geht die Spätschicht verloren.
  const dayCols: Partial<Record<SheetDay, number[]>> = {};

  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    // "Code" steht in Spalte A (Index 0)
    if (row[0]?.trim() !== "Code") continue;

    headerIdx = i;
    colCode = 0;

    row.forEach((cell, j) => {
      const c = cell.trim();
      if (c === "Preference") colPref = j;
      else if (c === "Recipe Name") colName = j;
      else if (c === "Total" && colTotal < 0) colTotal = j;
      else if (c === "Total+Buffer") colTotalBuf = j;

      // Stationen: exakter Spalten-Name
      for (const sk of SHEET_STATIONS) {
        if (c === sk && !(sk in stationCols)) (stationCols as any)[sk] = j;
      }

      // Tages-Spalten: Header ist "Date(2026,7,23)" (gviz-Format)
      const dayName = _gvizDateToDayName(c);
      if (dayName) ((dayCols as Record<string, number[]>)[dayName] ??= []).push(j);
    });
    break;
  }

  if (headerIdx < 0) return { week, tabName, shiftModel: "single", rows: [], fetchedAt: Date.now() };

  // Zweischicht, wenn ein Wochentag ≥2 Datums-Spalten hat (Früh + Spät).
  const shiftModel: "single" | "dual" =
    Object.values(dayCols).some(cs => (cs?.length ?? 0) >= 2) ? "dual" : "single";

  // Tageswerte einer Zeile über alle Spalten je Wochentag summieren
  // (Zweischicht: Früh- + Spätschicht-Spalte). Strings ("Cup"/"Slicing") → 0.
  function readDays(row: string[]): Partial<Record<SheetDay, number>> {
    const days: Partial<Record<SheetDay, number>> = {};
    for (const [dk, djs] of Object.entries(dayCols) as [SheetDay, number[]][]) {
      const n = djs.reduce((sum, dj) => sum + parseNum(row[dj]), 0);
      if (n > 0) days[dk] = n;
    }
    return days;
  }

  const planRows: PlanningRow[] = [];
  const byCode = new Map<string, PlanningRow>();
  // Ab W39 folgt unter dem Plating-Block ein zweiter "Code"-Block (KITCHEN =
  // Kochtag-Plan je Meal). Dessen Zeilen NICHT als Plating-Zeilen mitzählen,
  // sondern als kitchenDays an die schon bekannte Plating-Zeile hängen.
  let inKitchenBlock = false;

  for (let i = headerIdx + 1; i < raw.length; i++) {
    const row = raw[i];
    if (row[colCode]?.trim() === "Code") { inKitchenBlock = true; continue; }
    const code = row[colCode]?.trim();
    if (!code || !/^F[A-Z]\d{4}[A-Z]$/.test(code)) continue;

    if (inKitchenBlock) {
      const target = byCode.get(code);
      if (target) target.kitchenDays = readDays(row);
      continue;
    }

    const stations: Partial<Record<SheetStation, boolean>> = {};
    for (const [sk, sj] of Object.entries(stationCols) as [SheetStation, number][]) {
      const v = row[sj]?.trim().toUpperCase();
      if (v === "X") stations[sk] = true;
    }

    const planRow: PlanningRow = {
      code,
      name: colName >= 0 ? (row[colName]?.trim() || code) : code,
      preference: colPref >= 0 ? (row[colPref]?.trim() || "") : "",
      total: colTotal >= 0 ? parseNum(row[colTotal]) : 0,
      totalBuffer: colTotalBuf >= 0 ? parseNum(row[colTotalBuf]) : 0,
      stations,
      days: readDays(row),
    };
    planRows.push(planRow);
    byCode.set(code, planRow);
  }

  return { week, tabName, shiftModel, rows: planRows, fetchedAt: Date.now() };
}

function parseNum(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.replace(/,/g, "").replace(/\s/g, ""));
  return isNaN(n) ? 0 : n;
}
