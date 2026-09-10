// GSheet Monitor – Parser für den Tab "Volume Overview" der F_VE Transparency
// Plan (Sheet-ID 1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY, gid 1602943717).
//
// Das ist die maßgebliche Minimum-Needs-Tabelle: je Meal die Forecast-Nachfrage
// pro Tag (Do/Fr/Sa), die schon plaitierte Menge ("Production" = Summe aus dem
// LinePlaiting-Tab) und daraus die Lücke pro Checkpoint ("Actual Target" Do/Fr/
// Sa = Production − kumulierter Forecast bis zu dem Tag; negativ = fehlt noch,
// positiv = Puffer).
//
// AUFBAU: Ganz oben der Gesamt-Block (alle Märkte zusammengerechnet — genau die
// „Märkte-Summe", die zählt), Header-Zeile mit "Week Recipe Code" /
// "Forecast Total" / "Production" / "Actual Target". Danach folgen je Markt
// (BENL / DKSE / DE) eigene Unter-Blöcke mit eigener "Recipe Code"-Kopfzeile —
// die interessieren hier NICHT, nur der Gesamt-Block oben.
//
// MINIMUM NEEDS = die drei Spalten unter "Actual Target" (im Sheet L/M/N =
// Do/Fr/Sa). Sind sie leer, gilt die abgeleitete Formel: Production −
// kumulierter Forecast bis zu dem Tag. Negativ = fehlt bis zu dem Checkpoint,
// positiv/0 = erreicht (Puffer).
//
// Spaltenpositionen können (wie überall in diesen Sheets) wandern, deshalb wird
// jede Spalte über ihren Header-Text gefunden; die Do/Fr/Sa-Trios über den
// Offset zu ihrem Anker ("Forecast Total" bzw. "Actual Target"), weil die
// Labels "Thu/Fri/Sat" doppelt vorkommen.

export interface VolumeOverviewRow {
  code: string;
  recipeName: string;
  /** Forecast-Gesamtnachfrage der Woche (alle Märkte). */
  forecastTotal: number;
  /** Forecast-Nachfrage je Auslieferungstag. */
  forecastByDay: { thu: number; fri: number; sat: number };
  /** Schon plaitiert (Sheet-Spalte "Production" = Σ LinePlaiting-Actuals). */
  production: number;
  /** Sheet-Spalte "Planned Volume". */
  planned: number | null;
  /** "Actual Target" je Checkpoint: Production − kumulierter Forecast bis Do/Fr/
   *  Sa. NEGATIV = so viele Portionen fehlen noch bis zu dem Tag, POSITIV =
   *  Puffer. null, wenn die Zelle leer ist. */
  gapByDay: { thu: number | null; fri: number | null; sat: number | null };
  /** Sheet-Spalte "Delta" (Production/Actuals vs. Planned). */
  deltaVsPlanned: number | null;
  comment: string;
}

export interface VolumeOverviewData {
  week: string;
  rows: VolumeOverviewRow[];
  byCode: Map<string, VolumeOverviewRow>;
  lastUpdated: number;
}

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

function num(raw: unknown): number {
  const t = String(raw ?? "").trim();
  if (!t) return 0;
  // Portionen sind ganzzahlig; "," / "." vor genau 3 Ziffern = Tausender-Trenner.
  const cleaned = t.replace(/[.,](\d{3})(?!\d)/g, "$1").replace(/[^\d.\-]/g, "");
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : 0;
}

function optNum(raw: unknown): number | null {
  const t = String(raw ?? "").trim();
  if (!t || !/^-?[\d.,\s]+$/.test(t)) return null;
  return num(t);
}

const MARKET_LABELS = new Set(["benl", "bnl", "dkse", "de", "nl", "nordics", "dach"]);
const CODE_RE = /^(F[VX]?\w*\d\w*|CF\d\w*)$/i;

export function parseVolumeOverview(rows: string[][]): VolumeOverviewData {
  let week = "";
  for (const row of rows.slice(0, 4)) {
    for (const cell of row ?? []) {
      const m = /\bW(\d{1,2})\b/i.exec(String(cell ?? "").trim());
      if (m) { week = `W${m[1].padStart(2, "0")}`; break; }
    }
    if (week) break;
  }

  const headerIdx = rows.findIndex(r =>
    r?.some(c => norm(c).includes("forecast total")) && r?.some(c => norm(c) === "production"),
  );
  if (headerIdx === -1) return { week, rows: [], byCode: new Map(), lastUpdated: Date.now() };

  const header = rows[headerIdx];
  const find = (pred: (h: string) => boolean): number => header.findIndex(c => pred(norm(c)));

  const codeCol = find(h => h === "week recipe code" || h === "recipe code");
  const forecastAnchor = find(h => h.includes("forecast total"));
  const targetAnchor = find(h => h.includes("actual target"));
  const productionCol = find(h => h === "production");
  const plannedCol = find(h => h.includes("planned"));
  const deltaCol = find(h => h === "delta");
  const commentCol = find(h => h.includes("comment") || h.includes("action"));

  if (codeCol < 0 || forecastAnchor < 0 || productionCol < 0) {
    return { week, rows: [], byCode: new Map(), lastUpdated: Date.now() };
  }
  const nameCol = codeCol + 1;

  const out: VolumeOverviewRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const code = String(row[codeCol] ?? "").trim().toUpperCase();
    // Markt-Unterblock beginnt → Gesamt-Block ist zu Ende, hier stoppen.
    if (MARKET_LABELS.has(norm(code))) break;
    if (!code || !CODE_RE.test(code)) continue;

    const forecastTotal = num(row[forecastAnchor]);
    const fThu = num(row[forecastAnchor + 1]);
    const fFri = num(row[forecastAnchor + 2]);
    const fSat = num(row[forecastAnchor + 3]);
    const production = num(row[productionCol]);

    // Spalten L/M/N ("Actual Target" Do/Fr/Sa) — die Minimum-Needs-Lücke pro
    // Checkpoint. Sind Zellen leer, ist die Formel = Production − kumulierter
    // Forecast bis zu dem Tag (an gefüllten Zeilen verifiziert). So bleibt die
    // Reihe immer vollständig, statt Lücken zu zeigen.
    const rawGap = targetAnchor >= 0
      ? { thu: optNum(row[targetAnchor + 1]), fri: optNum(row[targetAnchor + 2]), sat: optNum(row[targetAnchor + 3]) }
      : { thu: null, fri: null, sat: null };
    const hasBasis = forecastTotal > 0 || production > 0;
    const gapByDay = {
      thu: rawGap.thu ?? (hasBasis ? production - fThu : null),
      fri: rawGap.fri ?? (hasBasis ? production - (fThu + fFri) : null),
      sat: rawGap.sat ?? (hasBasis ? production - (fThu + fFri + fSat) : null),
    };

    out.push({
      code,
      recipeName: String(row[nameCol] ?? "").trim(),
      forecastTotal,
      forecastByDay: { thu: fThu, fri: fFri, sat: fSat },
      production,
      planned: plannedCol >= 0 ? optNum(row[plannedCol]) : null,
      gapByDay,
      deltaVsPlanned: deltaCol >= 0 ? optNum(row[deltaCol]) : null,
      comment: commentCol >= 0 ? String(row[commentCol] ?? "").trim() : "",
    });
  }

  const byCode = new Map<string, VolumeOverviewRow>();
  for (const r of out) byCode.set(r.code, r);

  return { week, rows: out, byCode, lastUpdated: Date.now() };
}
