// Reine Verteil-Logik des Blast Chiller Bots: KET-Work-Orders → 6 Chiller-Einheiten,
// kapazitätsbewusst (Rack-Durchsatz) und allergen-gruppiert. Kein React / kein DOM,
// damit dieselbe Rechnung testbar ist und später auch woanders laufen kann.
//
// Grundgedanken (mit Marcel abgestimmt, 2026-09-09):
//  • Kapazitätsmaß = Racks (kg ÷ Rack-kg). In EINEN Chiller passen 6 Racks pro
//    Kühlzyklus; ein Zyklus dauert ~2,5 h. Ab dem 2-Schicht-Modell werden Racks
//    nur zwischen erster (08 Uhr) und letzter Beladung (23 Uhr) eingefahren.
//    → Zyklen/Tag = floor((lastLoadHour − firstLoadHour) / cycleHours) + 1
//    → Racks/Chiller/Tag = racksPerCycle × Zyklen/Tag (≈ 6 × 7 = 42).
//  • Alle 6 Einheiten gleich groß; Einheit 1 (+ ggf. 2) ist der Allergenfrei-Bereich.
//  • "Ganze Rezepte zusammen": alle Komponenten EINES Rezepts dürfen in denselben
//    Chiller, egal welche Allergene — sie landen ohnehin zusammen auf dem Teller
//    (der "Reis + Fisch"-Fall). Das entlastet den früheren Rest-Pool (Chiller 6).
//  • Chiller-Rollen werden pro Tag / Woche NEU vergeben (dynamisch) nach Last +
//    Allergen-Nähe statt fixem "3 = Sulfit".

import { assignChiller, type AllergenPrecision, type ChillerKey } from "./blastChillerLogic";

// ── Parameter (im Bot editierbar, in localStorage) ──────────────────────────

export interface ChillerPlanParams {
  /** Rack-Plätze in EINEM Chiller pro Kühlzyklus (Verden: 6). */
  racksPerCycle: number;
  /** Dauer eines Kühlzyklus in Stunden (Verden: ~2,5). */
  cycleHours: number;
  /** Uhrzeit der ersten Rack-Beladung (0–24). 2-Schicht-Modell: 8. */
  firstLoadHour: number;
  /** Uhrzeit der letzten Rack-Beladung (0–24). 2-Schicht-Modell: 23. */
  lastLoadHour: number;
  /** kg pro Rack (Verden-Modell: 200). */
  rackKg: number;
  /** true = alle Komponenten eines Rezepts bleiben im selben Chiller. */
  keepRecipesTogether: boolean;
  /** true = ein Rezept, das allein einen Chiller-Tag sprengt, wird auf mehrere
   *  Chiller aufgeteilt ("Teil 1/2"). Sicher, weil es dasselbe Gericht ist —
   *  Kreuzkontamination zwischen den Teilen ist egal. */
  splitLargeRecipes: boolean;
}

export const DEFAULT_CHILLER_PLAN_PARAMS: ChillerPlanParams = {
  racksPerCycle: 6,
  cycleHours: 2.5,
  firstLoadHour: 8,
  lastLoadHour: 23,
  rackKg: 200,
  keepRecipesTogether: true,
  splitLargeRecipes: true,
};

/** Kühlzyklen, die ein Chiller pro Produktionstag schafft: erster Load bei
 *  firstLoadHour, danach alle cycleHours ein neuer, letzter spätestens lastLoadHour. */
export function cyclesPerDay(p: ChillerPlanParams): number {
  const windowH = Math.max(0, p.lastLoadHour - p.firstLoadHour);
  return Math.max(1, Math.floor(windowH / Math.max(0.5, p.cycleHours)) + 1);
}

/** Effektive Rack-Kapazität je Chiller pro Produktionstag = Rack-Plätze × Zyklen. */
export function racksPerChillerDay(p: ChillerPlanParams): number {
  return Math.max(1, Math.round(p.racksPerCycle)) * cyclesPerDay(p);
}

export const CHILLER_UNITS = [1, 2, 3, 4, 5, 6] as const;
export const CHILLER_UNIT_COUNT = CHILLER_UNITS.length;

// ── Allergen-Kanonisierung (Rohstring → kurze Sammel-Labels) ────────────────

const ALLERGEN_CANON: ReadonlyArray<readonly [RegExp, string]> = [
  [/MILCH|LAKTOSE|\bMILK\b|DAIRY/, "Milch"],
  [/SCHWEFELDIOXID|SULFIT|SULPHIT/, "Sulfite"],
  [/KREBSTIER|CRUSTACEAN/, "Krebstiere"],
  [/WEICHTIER|MOLLUSC|MOLLUSK/, "Weichtiere"],
  [/\bFISCH\b|\bFISH\b/, "Fisch"],
  [/GLUTEN|WEIZEN|WHEAT|GERSTE|BARLEY|HAFER|\bOATS?\b|ROGGEN|\bRYE\b|DINKEL|SPELT/, "Gluten"],
  [/\bEIER?\b|\bEGGS?\b/, "Ei"],
  [/\bSOJA\b|\bSOYA?\b/, "Soja"],
  [/SESAM/, "Sesam"],
  [/\bSENF\b|MUSTARD/, "Senf"],
  [/SELLERIE|CELERY/, "Sellerie"],
  [/ERDNUSS|ERDNÜSSE|PEANUT/, "Erdnüsse"],
  [/SCHALENFRÜCHTE|SCHALENFRUECHTE|MANDEL|ALMOND|HASELNUSS|HASELNÜSSE|WALNUSS|WALNÜSSE|CASHEW|KASCHU|PISTAZIE|PISTACHIO|PEKAN|PECAN|PARANUSS|PARANÜSSE|BRAZIL NUT|MACADAMIA|\bNÜSSE\b|TREE NUT/, "Nüsse"],
  [/LUPIN/, "Lupine"],
];

/** Rohen Allergen-String (aus computeWoAllergen) auf kurze Sammel-Labels reduzieren.
 *  "KEINE"/leer → []. Unbekannt (null) wird vom Aufrufer separat behandelt. */
export function canonicalAllergens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const u = raw.toUpperCase();
  if (!u.trim() || u.trim() === "KEINE" || u.trim() === "NONE") return [];
  const out = new Set<string>();
  for (const [re, label] of ALLERGEN_CANON) if (re.test(u)) out.add(label);
  return [...out].sort();
}

// ── Work Order → Chiller-WO ────────────────────────────────────────────────

export interface ChillerWoInput {
  wo: string;
  name: string;            // Sub-Rezept / Komponente
  recipeCode: string;      // "" wenn nicht erkannt
  recipeName: string;
  date: string;            // "YYYY-MM-DD" oder ""
  kg: number;              // 0 = keine Mengendaten
  allergen: string | null; // Rohstring aus computeWoAllergen (Komponenten-Ebene)
  precision: AllergenPrecision;
  /** Rohstring der rezeptweiten Allergen-Union (computeRecipeWideAllergen).
   *  Sicherheitsnetz: eine "KEINE"-Komponente eines Allergen-Rezepts gilt NICHT
   *  als allergenfrei und landet nie im Allergenfrei-Chiller. */
  recipeAllergen?: string | null;
  /** Schicht "1"/"2" aus "Date Needed" (nur Anzeige). */
  shift?: string;
  /** true = Kitchen Status "Post Blast" → schon durch den Chiller. Der Bot rechnet
   *  sie im Wochenplan mit, kann sie aber für die Live-Sicht ausblenden. */
  blasted?: boolean;
}

export interface ChillerWo extends ChillerWoInput {
  allergens: string[];         // kanonische Labels der Komponente
  recipeAllergens: string[];   // kanonische Labels des ganzen Rezepts
  allergenFree: boolean;       // Komponente UND Rezept ohne Allergen
  unknown: boolean;
}

export function toChillerWo(input: ChillerWoInput): ChillerWo {
  const unknown = input.allergen == null || input.precision === "none";
  const allergens = canonicalAllergens(input.allergen);
  const recipeAllergens = canonicalAllergens(input.recipeAllergen);
  return {
    ...input,
    allergens,
    recipeAllergens,
    unknown,
    allergenFree: !unknown && allergens.length === 0 && recipeAllergens.length === 0,
  };
}

// ── Rezept-Gruppen ────────────────────────────────────────────────────────

export interface RecipeGroup {
  key: string;
  recipeCode: string;
  recipeName: string;
  date: string;
  wos: ChillerWo[];
  allergens: string[];     // Union über alle WOs
  allergenFree: boolean;   // alle WOs allergenfrei & bekannt
  hasUnknown: boolean;
  kg: number;
  racks: number;
  /** Bei aufgeteilten Riesen-Rezepten gesetzt: gemeinsamer Schlüssel aller Teile
   *  (Teile desselben splitKey dürfen nie in denselben Chiller), plus Teil-Nummer. */
  splitKey?: string;
  partIndex?: number;      // 1-basiert
  partCount?: number;
}

function racksFor(kg: number, hasWos: boolean, rackKg: number): number {
  if (!hasWos) return 0;
  if (kg <= 0) return 1; // keine Mengendaten → grob 1 Rack
  return Math.max(1, Math.ceil(kg / rackKg));
}

export function buildRecipeGroups(wos: ChillerWo[], params: ChillerPlanParams): RecipeGroup[] {
  const rackKg = Math.max(1, params.rackKg);
  const map = new Map<string, RecipeGroup>();
  for (const wo of wos) {
    const groupKey = params.keepRecipesTogether
      ? `${wo.recipeCode || wo.recipeName || "?"}|${wo.date}`
      : `${wo.wo}|${wo.date}`;
    let g = map.get(groupKey);
    if (!g) {
      g = {
        key: groupKey,
        recipeCode: wo.recipeCode,
        recipeName: wo.recipeName || wo.recipeCode || wo.name,
        date: wo.date,
        wos: [],
        allergens: [],
        allergenFree: true,
        hasUnknown: false,
        kg: 0,
        racks: 0,
      };
      map.set(groupKey, g);
    }
    g.wos.push(wo);
    g.kg += Math.max(0, wo.kg);
    if (wo.unknown) g.hasUnknown = true;
    if (!wo.allergenFree || wo.unknown) g.allergenFree = false;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    const set = new Set<string>();
    // Komponenten-Allergene + rezeptweite Allergene (Sicherheitsnetz: das
    // "kann enthalten" des Chillers zeigt, was das Rezept führt, auch wenn an
    // diesem Tag nur unbedenkliche Komponenten laufen).
    for (const wo of g.wos) {
      for (const a of wo.allergens) set.add(a);
      for (const a of wo.recipeAllergens) set.add(a);
    }
    g.allergens = [...set].sort();
    g.racks = racksFor(g.kg, g.wos.length > 0, rackKg);
  }
  return groups;
}

/**
 * Rezepte, die allein mehr als `maxRacks` brauchen, in mehrere Teile schneiden
 * (Teil 1/2 …). Sicher: es ist dasselbe Gericht — Kreuzkontamination zwischen den
 * Teilen ist egal. WOs werden möglichst ganz auf die Teile verteilt; eine einzelne
 * zu große WO wird chargenweise geteilt.
 */
export function splitOversizedGroups(
  groups: RecipeGroup[],
  maxRacks: number,
  rackKg: number,
): RecipeGroup[] {
  const out: RecipeGroup[] = [];
  for (const g of groups) {
    if (g.racks <= maxRacks || g.wos.length === 0) {
      out.push(g);
      continue;
    }
    const partCount = Math.min(CHILLER_UNIT_COUNT, Math.ceil(g.racks / maxRacks));
    const targetKg = g.kg / partCount || 1;

    // WOs in Stücke zerlegen, die je ≤ targetKg sind (große WOs chargenweise).
    type Piece = { wo: ChillerWo; kg: number; label: string };
    const pieces: Piece[] = [];
    for (const wo of g.wos) {
      const chunks = Math.max(1, Math.round(wo.kg / targetKg) || 1);
      if (chunks <= 1 || wo.kg <= 0) {
        pieces.push({ wo, kg: wo.kg, label: wo.name });
      } else {
        for (let i = 0; i < chunks; i++) {
          pieces.push({ wo, kg: wo.kg / chunks, label: `${wo.name} · Charge ${i + 1}/${chunks}` });
        }
      }
    }
    pieces.sort((a, b) => b.kg - a.kg);

    // LPT: jedes Stück in den aktuell leichtesten Teil.
    const bins: { kg: number; wos: ChillerWo[] }[] = Array.from({ length: partCount }, () => ({ kg: 0, wos: [] }));
    for (const p of pieces) {
      const bin = bins.reduce((a, b) => (a.kg <= b.kg ? a : b));
      bin.kg += Math.max(0, p.kg);
      bin.wos.push({ ...p.wo, name: p.label, kg: p.kg });
    }

    bins.forEach((bin, i) => {
      out.push({
        ...g,
        key: `${g.key}#p${i + 1}`,
        wos: bin.wos,
        kg: bin.kg,
        racks: racksFor(bin.kg, bin.wos.length > 0, rackKg),
        splitKey: g.key,
        partIndex: i + 1,
        partCount,
      });
    });
  }
  return out;
}

// ── Verteilung auf die 6 Einheiten ────────────────────────────────────────

export interface PlannedChiller {
  unit: number;
  role: "allergenfrei" | "allergen" | "unbekannt" | "leer";
  allergens: string[];     // "kann enthalten"
  groups: RecipeGroup[];
  woCount: number;
  kg: number;
  racks: number;
  capRacks: number;
  pct: number;
  over: boolean;
}

export interface ChillerDayRacks {
  date: string;
  units: { unit: number; racks: number; over: boolean }[];
  totalRacks: number;
  over: boolean;
}

export interface ChillerPlan {
  scope: string;           // "" = ganze Woche, sonst "YYYY-MM-DD"
  dayCount: number;
  chillers: PlannedChiller[];   // immer 6
  totalRacks: number;
  totalCapRacks: number;
  over: boolean;
  overflowRacks: number;
  unknownWoCount: number;
  hints: string[];
  /** Nur in der Wochen-Übersicht gesetzt: Rack-Last je Chiller je Tag (Matrix). */
  byDay?: ChillerDayRacks[];
}

interface WorkUnit {
  unit: number;
  groups: RecipeGroup[];
  allergens: Set<string>;
  racks: number;
  unknownGroups: number;
  splitKeys: Set<string>;   // Teile desselben Split-Rezepts: nie in dieselbe Einheit
}

const byRacksDesc = (a: RecipeGroup, b: RecipeGroup) => b.racks - a.racks || b.kg - a.kg;

// "Seltene" Allergene, die man in möglichst wenigen Chillern bündeln will, damit
// die übrigen Allergen-Chiller ein enges "kann enthalten: Milch, Sulfite" behalten.
// Milch/Sulfite/Gluten/Soja sind überall — die verteilt man nicht.
const RARE_ALLERGENS = new Set([
  "Fisch", "Krebstiere", "Weichtiere", "Nüsse", "Erdnüsse", "Ei", "Sesam", "Sellerie", "Senf", "Lupine",
]);

const rareCount = (allergens: string[]): number => allergens.filter((a) => RARE_ALLERGENS.has(a)).length;

/** Anzahl Allergene, die Gruppe g der Einheit NEU hinzufügen würde. */
function newAllergenCount(u: WorkUnit, g: RecipeGroup): number {
  let n = 0;
  for (const a of g.allergens) if (!u.allergens.has(a)) n++;
  return n;
}

function newRareCount(u: WorkUnit, g: RecipeGroup): number {
  let n = 0;
  for (const a of g.allergens) if (RARE_ALLERGENS.has(a) && !u.allergens.has(a)) n++;
  return n;
}

function addGroup(u: WorkUnit, g: RecipeGroup): void {
  u.groups.push(g);
  u.racks += g.racks;
  for (const a of g.allergens) u.allergens.add(a);
  if (g.hasUnknown) u.unknownGroups++;
  if (g.splitKey) u.splitKeys.add(g.splitKey);
}

function removeGroup(u: WorkUnit, g: RecipeGroup): void {
  u.groups = u.groups.filter((x) => x !== g);
  u.racks -= g.racks;
  if (g.hasUnknown) u.unknownGroups--;
  u.allergens = new Set(u.groups.flatMap((x) => x.allergens));
  u.splitKeys = new Set(u.groups.map((x) => x.splitKey).filter((k): k is string => !!k));
}

const isFreeGroup = (g: RecipeGroup): boolean => g.allergenFree && !g.hasUnknown;
const unitClean = (u: WorkUnit): boolean => u.allergens.size === 0 && u.unknownGroups === 0;
const unitFreeOnly = (u: WorkUnit): boolean =>
  u.groups.length > 0 && u.groups.every(isFreeGroup);

/** Beste Einheit für eine Gruppe. Reihenfolge der Kriterien:
 *  1. Kapazität nicht sprengen
 *  2. Allergenfreie Einheit NICHT mit Allergenen verschmutzen (Qualität!) —
 *     bzw. eine allergenfreie Gruppe bevorzugt in eine saubere Einheit
 *  3. Last-Ausgleich (in Racks-"Töpfen")
 *  4. Allergen-Nähe — seltene Allergene bündeln, dann alle
 */
function pickChiller(units: WorkUnit[], g: RecipeGroup, cap: number, bucket: number): WorkUnit {
  const gFree = isFreeGroup(g);
  let best = units[0];
  let bestScore = Infinity;
  for (const u of units) {
    const projected = u.racks + g.racks;
    const over = projected > cap ? 1_000_000 + (projected - cap) * 100 : 0;
    // Zwei Teile desselben aufgeteilten Rezepts nie in denselben Chiller.
    const sameSplit = g.splitKey && u.splitKeys.has(g.splitKey) ? 5_000_000 : 0;
    const loadBucket = Math.round(projected / bucket) * bucket;

    // Sehr sanfter Positions-Bias (< ½ Rack): allergenfreie Gruppen tendenziell
    // nach unten (Chiller 1/2), allergenhaltige von oben (6) her — bricht nur
    // echte Gleichstände, ohne die gleichmäßige Last zu stören.
    const posBias = (gFree ? u.unit : CHILLER_UNIT_COUNT + 1 - u.unit) * 3;

    let affinity: number;
    if (gFree) {
      // Allergenfreie Gruppe: klar in eine saubere/leere Einheit; nur wenn alle
      // sauberen voll sind, notfalls zu einer Allergen-Einheit (zeigt dort "keine").
      affinity = unitClean(u) ? 0 : 25_000;
    } else {
      // Allergenhaltige/unbekannte Gruppe: eine Einheit, die AKTUELL nur
      // allergenfreie Gruppen hält, nicht verschmutzen — außer es geht nicht anders.
      const contaminate = unitFreeOnly(u) ? 30_000 : 0;
      affinity =
        contaminate +
        newRareCount(u, g) * 300 +
        newAllergenCount(u, g) * 20 +
        (u.unknownGroups > 0 && g.hasUnknown ? -40 : 0);
    }
    const score = sameSplit + over + loadBucket * 100 + affinity + posBias + projected;
    if (score < bestScore) {
      best = u;
      bestScore = score;
    }
  }
  return best;
}

export function planChillers(
  wos: ChillerWo[],
  params: ChillerPlanParams,
  scope = "",
  dayCount = 1,
): ChillerPlan {
  const days = Math.max(1, Math.round(dayCount));
  const cap = racksPerChillerDay(params) * days;

  const units: WorkUnit[] = CHILLER_UNITS.map((unit) => ({
    unit,
    groups: [],
    allergens: new Set<string>(),
    racks: 0,
    unknownGroups: 0,
    splitKeys: new Set<string>(),
  }));

  let groups = buildRecipeGroups(wos, params);
  if (params.splitLargeRecipes) {
    groups = splitOversizedGroups(groups, cap, Math.max(1, params.rackKg));
  }
  // Last-"Topf": Einheiten, deren Projektion sich um weniger als ~1/3 der
  // erwarteten Last je Chiller unterscheidet, gelten als gleich belastet — dann
  // entscheidet Allergen-Nähe. An die reale Tageslast gekoppelt, nicht an die
  // (oft viel größere) Kapazität, damit auch bei viel Luft eng ausbalanciert wird.
  const totalGroupRacks = groups.reduce((s, g) => s + g.racks, 0);
  const bucket = Math.min(
    Math.max(2, Math.round(cap / 6)),
    Math.max(1, Math.round(totalGroupRacks / CHILLER_UNIT_COUNT / 3)),
  );

  // Verteil-Reihenfolge:
  //  0. allergenfreie Gruppen zuerst — sie "besetzen" die sauberen Einheiten
  //  1. dann Gruppen mit seltenen Allergenen (Fisch/Nüsse/… bündeln)
  //  2. dann der Rest, groß → klein (Bin-Packing braucht die Brocken zuerst)
  //  3. unbekannte ganz am Schluss (nie in eine saubere Einheit)
  const rank = (g: RecipeGroup): number => {
    if (isFreeGroup(g)) return 0;
    if (g.hasUnknown) return 3;
    return rareCount(g.allergens) > 0 ? 1 : 2;
  };
  const queue = [...groups].sort((a, b) => rank(a) - rank(b) || byRacksDesc(a, b));
  for (const g of queue) {
    addGroup(pickChiller(units, g, cap, bucket), g);
  }

  // Rebalance: Überlauf abbauen + Spitzen glätten. Gruppen werden nie in eine
  //  Einheit geschoben, die dadurch verschmutzt würde (allergenfrei bleibt sauber).
  const tolerance = Math.max(2, Math.ceil(cap * 0.15));
  for (let iter = 0; iter < 80; iter++) {
    const active = units.filter((u) => u.groups.length > 0);
    const hi = [...active].sort((a, b) => b.racks - a.racks)[0];
    const lo = [...units].sort((a, b) => a.racks - b.racks)[0];
    if (!hi || hi === lo || hi.groups.length < 2) break;
    if (hi.racks <= cap && hi.racks - lo.racks <= tolerance) break;
    const cand = [...hi.groups]
      .sort((a, b) => a.racks - b.racks)
      .find((g) => {
        if (g.splitKey && lo.splitKeys.has(g.splitKey)) return false; // Split-Teile trennen
        if (!isFreeGroup(g) && unitFreeOnly(lo)) return false; // Qualität: sauber halten
        if (isFreeGroup(g) && !unitClean(lo) && unitClean(hi)) return false;
        return lo.racks + g.racks < hi.racks; // Verschiebung verbessert die Spanne
      });
    if (!cand) break;
    removeGroup(hi, cand);
    addGroup(lo, cand);
  }

  // ── Ergebnis zusammenstellen ────────────────────────────────────────────
  const chillers: PlannedChiller[] = units.map((u) => {
    const woCount = u.groups.reduce((s, g) => s + g.wos.length, 0);
    const kg = u.groups.reduce((s, g) => s + g.kg, 0);
    let role: PlannedChiller["role"];
    if (u.groups.length === 0) role = "leer";
    else if (unitClean(u)) role = "allergenfrei";
    else if (u.unknownGroups > 0 && u.unknownGroups === u.groups.length) role = "unbekannt";
    else role = "allergen";
    return {
      unit: u.unit,
      role,
      allergens: [...u.allergens].sort(),
      groups: [...u.groups].sort(byRacksDesc),
      woCount,
      kg,
      racks: u.racks,
      capRacks: cap,
      pct: cap > 0 ? Math.round((u.racks / cap) * 100) : 0,
      over: u.racks > cap,
    };
  });

  const totalRacks = chillers.reduce((s, c) => s + c.racks, 0);
  const totalCapRacks = cap * CHILLER_UNIT_COUNT;
  const overflowRacks = Math.max(0, totalRacks - totalCapRacks);
  const unknownWoCount = wos.filter((w) => w.unknown).length;

  const hints: string[] = [];
  const label = scope || "Woche";
  if (overflowRacks > 0) {
    hints.push(
      `${label}: ${overflowRacks} Rack${overflowRacks > 1 ? "s" : ""} über Gesamtkapazität (${totalRacks}/${totalCapRacks}). Rezepte auf einen anderen Tag verteilen.`,
    );
  }
  for (const c of chillers) {
    if (!c.over) continue;
    const biggest = c.groups[0];
    hints.push(
      `Chiller ${c.unit}: ${c.racks}/${c.capRacks} Racks` +
        (biggest ? ` — „${biggest.recipeName}" (${biggest.racks} Rack${biggest.racks > 1 ? "s" : ""}) verschieben` : ""),
    );
  }
  if (unknownWoCount > 0) {
    const unknownUnits = chillers.filter((c) => c.groups.some((g) => g.hasUnknown)).map((c) => c.unit);
    hints.push(
      `${unknownWoCount} WO${unknownWoCount > 1 ? "s" : ""} ohne klare Allergen-Daten` +
        (unknownUnits.length ? ` (Chiller ${unknownUnits.join(", ")})` : "") +
        " — bitte gegenprüfen.",
    );
  }
  // Aufgeteilte Riesen-Rezepte auflisten (pro splitKey einmal).
  const splitSeen = new Set<string>();
  for (const c of chillers) {
    for (const g of c.groups) {
      if (!g.splitKey || splitSeen.has(g.splitKey)) continue;
      splitSeen.add(g.splitKey);
      const parts = chillers
        .flatMap((x) => x.groups.filter((y) => y.splitKey === g.splitKey).map((y) => ({ unit: x.unit, racks: y.racks })))
        .sort((a, b) => a.unit - b.unit);
      hints.push(
        `„${g.recipeName}" auf ${parts.length} Chiller aufgeteilt: ${parts.map((p) => `C${p.unit} ${p.racks}R`).join(" · ")}.`,
      );
    }
  }

  return {
    scope,
    dayCount: days,
    chillers,
    totalRacks,
    totalCapRacks,
    over: overflowRacks > 0 || chillers.some((c) => c.over),
    overflowRacks,
    unknownWoCount,
    hints,
  };
}

/**
 * Wochen-Übersicht aus den Tages-Plänen: je Chiller die Spitzenlast eines Tages
 * (das ist die bindende Grenze — der Chiller läuft 24 h, nicht 5 Tage am Stück),
 * plus eine Tag×Chiller-Rack-Matrix und alle Tages-Hinweise.
 */
export function aggregateWeekPlan(dayPlans: ChillerPlan[], params: ChillerPlanParams): ChillerPlan {
  const cap = racksPerChillerDay(params);

  const chillers: PlannedChiller[] = CHILLER_UNITS.map((unit, idx) => {
    const perDay = dayPlans.map((p) => p.chillers[idx]);
    const peak = perDay.reduce((a, b) => (b.racks > a.racks ? b : a), perDay[0] ?? {
      unit, role: "leer" as const, allergens: [], groups: [], woCount: 0, kg: 0, racks: 0, capRacks: cap, pct: 0, over: false,
    });
    const allergens = [...new Set(perDay.flatMap((c) => c.allergens))].sort();
    const roles = new Set(perDay.filter((c) => c.role !== "leer").map((c) => c.role));
    const role: PlannedChiller["role"] =
      roles.size === 0 ? "leer"
        : roles.has("allergen") ? "allergen"
        : roles.has("unbekannt") ? "unbekannt"
        : "allergenfrei";
    return {
      unit,
      role,
      allergens,
      groups: [...perDay.flatMap((c) => c.groups)].sort(byRacksDesc),
      woCount: perDay.reduce((s, c) => s + c.woCount, 0),
      kg: perDay.reduce((s, c) => s + c.kg, 0),
      racks: peak.racks,
      capRacks: cap,
      pct: cap > 0 ? Math.round((peak.racks / cap) * 100) : 0,
      over: peak.racks > cap,
    };
  });

  const byDay: ChillerDayRacks[] = dayPlans.map((p) => ({
    date: p.scope,
    units: p.chillers.map((c) => ({ unit: c.unit, racks: c.racks, over: c.over })),
    totalRacks: p.totalRacks,
    over: p.over,
  }));

  // Tages-Hinweise mit Datum voranstellen, damit in der Wochen-Übersicht klar
  // ist, welcher Tag klemmt.
  const hints = [
    ...new Set(dayPlans.flatMap((p) => p.hints.map((h) => (p.scope ? `${p.scope} · ${h}` : h)))),
  ];
  const unknownWoCount = dayPlans.reduce((s, p) => s + p.unknownWoCount, 0);

  return {
    scope: "",
    dayCount: dayPlans.length,
    chillers,
    totalRacks: chillers.reduce((s, c) => s + c.racks, 0),
    totalCapRacks: cap * CHILLER_UNIT_COUNT,
    over: chillers.some((c) => c.over) || dayPlans.some((p) => p.over),
    overflowRacks: Math.max(...dayPlans.map((p) => p.overflowRacks), 0),
    unknownWoCount,
    hints,
    byDay,
  };
}

// ── Klassik-Modus: feste Töpfe, aber Chiller 6 entlastet ─────────────────────
// Behält die alte, vorhersehbare Zuteilung (1&2 frei · 3 Sulfit · 4 Milch ·
// 5 beides · 6 Rest). Zwei Entlastungen für den Rest-Pool:
//  1. Chiller 6 wird nach Allergen unterteilt (mit "UNBEKANNT" als Block oben).
//  2. Ist an dem Tag ein Allergen-Chiller (3/4/5) leer, wandert die größte
//     Rest-Allergen-Gruppe dorthin — sicher, weil dort nichts liegt, was man
//     kontaminieren könnte. Klar umbenannt ("Chiller 3 · heute: Fisch").

/** Dominantes Allergen einer Rest-WO: erst ein seltenes (Fisch, Nüsse …), sonst das erste. */
function dominantAllergen(wo: ChillerWo): string {
  const rest = wo.allergens.filter((a) => a !== "Milch" && a !== "Sulfite");
  const list = rest.length ? rest : wo.allergens;
  return list.find((a) => RARE_ALLERGENS.has(a)) ?? list[0] ?? "Sonstige";
}

export interface ClassicGroup {
  allergen: string;        // "Fisch" / "UNBEKANNT" / …
  unknown: boolean;
  wos: ChillerWo[];
  kg: number;
}

export interface ClassicSection {
  chillerKey: ChillerKey;
  label: string;           // "Chiller 3" oder "Chiller 3 · heute: Fisch"
  sub: string;             // "Sulfite" / "Rest-Pool" / "leer → Fisch"
  reassigned: boolean;     // leerer Allergen-Chiller, hier zweckentfremdet
  groups: ClassicGroup[];  // > 1 nur bei Chiller 6
  woCount: number;
  kg: number;
}

export interface ClassicLayout {
  sections: ClassicSection[];   // in Reihenfolge 1&2, 3, 4, 5, 6
  restOverloaded: boolean;      // Chiller 6 trägt spürbar mehr als der Rest
  movedGroups: number;          // wie viele Rest-Gruppen in leere Chiller verschoben
}

const sumKg = (list: ChillerWo[]) => list.reduce((s, w) => s + Math.max(0, w.kg), 0);
const byWo = (a: ChillerWo, b: ChillerWo) => a.wo.localeCompare(b.wo, undefined, { numeric: true });

export function classicLayout(wos: ChillerWo[], useEmptyChillers = true): ClassicLayout {
  const bucket: Record<ChillerKey, ChillerWo[]> = { "1": [], "3": [], "4": [], "5": [], "6": [] };
  for (const w of wos) bucket[assignChiller(w.allergen)].push(w);

  // Chiller 6 nach Allergen (UNBEKANNT zuerst).
  const restGroups = new Map<string, { unknown: boolean; wos: ChillerWo[] }>();
  for (const w of bucket["6"]) {
    const key = w.unknown ? "UNBEKANNT" : dominantAllergen(w);
    const g = restGroups.get(key) ?? { unknown: w.unknown, wos: [] };
    g.wos.push(w);
    restGroups.set(key, g);
  }
  let groups: ClassicGroup[] = [...restGroups.entries()].map(([allergen, g]) => ({
    allergen, unknown: g.unknown, wos: g.wos.sort(byWo), kg: sumKg(g.wos),
  }));

  // Größte bekannte Rest-Gruppen in leere Allergen-Chiller schieben.
  const reassign: Partial<Record<ChillerKey, ClassicGroup>> = {};
  let moved = 0;
  if (useEmptyChillers) {
    const emptyKeys = (["3", "4", "5"] as ChillerKey[]).filter((k) => bucket[k].length === 0);
    const movable = groups
      .filter((g) => !g.unknown && g.wos.length > 0)
      .sort((a, b) => b.wos.length - a.wos.length);
    for (const key of emptyKeys) {
      const g = movable.shift();
      if (!g) break;
      reassign[key] = g;
      groups = groups.filter((x) => x !== g);
      moved++;
    }
  }

  const CFG_SUB: Record<ChillerKey, string> = { "1": "Allergenfrei", "3": "Sulfite", "4": "Milch", "5": "Milch + Sulfite", "6": "Rest-Pool" };
  const sections: ClassicSection[] = (["1", "3", "4", "5", "6"] as ChillerKey[]).map((k) => {
    if (k === "6") {
      const ordered = groups.sort((a, b) => (a.unknown ? -1 : b.unknown ? 1 : b.wos.length - a.wos.length));
      const flat = ordered.flatMap((g) => g.wos);
      return { chillerKey: k, label: "Chiller 6", sub: "Rest-Pool", reassigned: false, groups: ordered, woCount: flat.length, kg: sumKg(flat) };
    }
    const movedGroup = reassign[k];
    if (movedGroup) {
      return { chillerKey: k, label: `Chiller ${k} · heute: ${movedGroup.allergen}`, sub: `leer → ${movedGroup.allergen}`, reassigned: true, groups: [movedGroup], woCount: movedGroup.wos.length, kg: movedGroup.kg };
    }
    const items = bucket[k].sort(byWo);
    return { chillerKey: k, label: k === "1" ? "Chiller 1 & 2" : `Chiller ${k}`, sub: CFG_SUB[k], reassigned: false, groups: [{ allergen: CFG_SUB[k], unknown: false, wos: items, kg: sumKg(items) }], woCount: items.length, kg: sumKg(items) };
  });

  const rest6 = sections.find((s) => s.chillerKey === "6")!;
  const others = sections.filter((s) => s.chillerKey !== "6" && s.woCount > 0).map((s) => s.woCount);
  const restOverloaded = rest6.woCount >= 12 && rest6.woCount > 1.6 * Math.max(1, ...others);

  return { sections, restOverloaded, movedGroups: moved };
}
