// Backfills – reine Zusammenführungs-/Analyse-Logik, keine Hooks/State hier
// (siehe BackfillsContext.tsx für die Live-Verdrahtung), damit sie unabhängig
// testbar bleibt.
import type { BackfillNeed } from "../gsheet-monitor/postblastMatch";
import type { LinePlaitingData, RtiData } from "../gsheet-monitor/gsheetTypes";
import type { PlatingRunDisplay } from "../redzone-live/redzoneTypes";
import type { StoredRow } from "../wms-overview/wmsTypes";
import type { WmsSkuInfo } from "../../lib/wmsSkuEnrichment";
import { skuKey } from "../../lib/wmsSkuEnrichment";
import { codeDigits } from "../../lib/helpers";
import type { BackfillAlert, BackfillPriority, CombinedBackfillNeed } from "./backfillTypes";

// Backfill-Menge zählt erst ab dieser Schwelle als echter Bedarf (Rauschfilter
// gegen minimale Rundungs-/Zählabweichungen).
const MIN_RTI_SHORTFALL = 30;

// Meal-Identität = die 4 Ziffern des Codes. FV4063A / FV4063B usw. sind dasselbe
// Meal — der Buchstabe wechselt bei SKU-/Sleeve-Druckänderungen, und die drei
// Quellen (LinePlating, RTI-Sheet, Küche) benutzen dann unterschiedliche.
function codeKey(code: string): string {
  return codeDigits(code).toUpperCase();
}

const SOURCE_SHORT: Record<CombinedBackfillNeed["recommendedSource"], string> = {
  lineplating: 'LinePlating "{Tag} needs"',
  plating: "LinePlating Planned − Actual",
  rti: "RTI-Wiegung",
  kitchen: "Küchen-Gewicht",
  none: "—",
};

interface KitchenAgg {
  code: string;
  recipeName: string;
  missingKg: number;
  missingPortions: number;
  priority: BackfillPriority;
  subRecipes: Set<string>;
}

function aggregateKitchenByMeal(kitchenBackfill: BackfillNeed[]): Map<string, KitchenAgg> {
  const byMeal = new Map<string, KitchenAgg>();
  const rank: Record<BackfillPriority, number> = { critical: 2, behind: 1, "on-track": 0 };
  for (const b of kitchenBackfill) {
    const key = codeKey(b.recipeCode);
    const cur = byMeal.get(key) ?? {
      code: b.recipeCode, recipeName: b.recipeName, missingKg: 0, missingPortions: 0,
      priority: "on-track" as BackfillPriority, subRecipes: new Set<string>(),
    };
    cur.missingKg += b.missingKg;
    cur.missingPortions += b.estimatedPortions;
    cur.subRecipes.add(b.subRecipe);
    if (rank[b.priority] > rank[cur.priority]) cur.priority = b.priority;
    byMeal.set(key, cur);
  }
  return byMeal;
}

interface PlatingAgg {
  code: string;
  meal: string;
  plannedPortions: number;    // Σ Planned, nur Di–Do-Zeilen (Detail-Anzeige)
  shortagePortions: number;   // Σ negativer Deltas, nur Di–Do (Detail-Anzeige)
  allPlannedTotal: number;    // Σ Planned über ALLE Tage der KW
  allActualTotal: number;     // Σ Actual über ALLE Tage der KW
  reasons: Set<string>;
  days: Set<string>;
  minNeeded: number | null;   // "{Tag} needs" des zuletzt befüllten Tages
  minNeededRank: number;      // Tages-Rang, aus dem minNeeded stammt (intern)
  statusText: string;         // "Ready" / "blocked" / "done" vom letzten Tag
  statusRank: number;
  resultPortions: number | null;
  resultComments: Set<string>;
}

const DAY_RANK: Record<string, number> = {
  Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7,
};

function aggregatePlatingByMeal(linePlaiting: LinePlaitingData | null): Map<string, PlatingAgg> {
  const byMeal = new Map<string, PlatingAgg>();
  if (!linePlaiting) return byMeal;

  const get = (code: string, meal: string): PlatingAgg => {
    const key = codeKey(code);
    let cur = byMeal.get(key);
    if (!cur) {
      cur = {
        code, meal, plannedPortions: 0, shortagePortions: 0, allPlannedTotal: 0, allActualTotal: 0,
        reasons: new Set(), days: new Set(), minNeeded: null, minNeededRank: 0,
        statusText: "", statusRank: 0, resultPortions: null, resultComments: new Set(),
      };
      byMeal.set(key, cur);
    }
    return cur;
  };

  for (const r of linePlaiting.rows) {
    const agg = get(r.recipeCode, r.meal);
    const rank = DAY_RANK[r.day] ?? 0;

    // Σ Planned/Actual über die ganze KW (ein Meal wird über mehrere Tage geplatet).
    agg.allPlannedTotal += r.plannedPortions;
    agg.allActualTotal += r.actualPortions;

    // "{Tag} needs" = der vom Plating-Team eingetragene Restbedarf. Der des
    // zuletzt befüllten Tages gilt (Fr schlägt Do schlägt Di) — quer über alle
    // Phasen. Fallback minNeededPortions für Alt-Datensätze ohne dayNeedPortions.
    const dayNeed = r.dayNeedPortions ?? (r.phase === "min-needs" ? r.minNeededPortions : null);
    if (dayNeed != null && rank >= agg.minNeededRank) {
      agg.minNeeded = dayNeed;
      agg.minNeededRank = rank;
    }

    if (r.statusText && rank >= agg.statusRank) {
      agg.statusText = r.statusText;
      agg.statusRank = rank;
    }

    // shortageReason vs. comment: je nach KW/Tag trägt das Sheet den Freitext-
    // Grund mal in der einen, mal in der anderen Spalte (Fr/Sa: "Shortage" →
    // "Comments") — beide einsammeln, das Set dedupliziert.
    if (r.phase === "shortage") {
      agg.plannedPortions += r.plannedPortions;
      if (r.deltaPortions < 0) agg.shortagePortions += -r.deltaPortions;
      if (r.shortageReason) agg.reasons.add(r.shortageReason);
      if (r.comment) agg.reasons.add(r.comment);
      agg.days.add(r.day);
    } else if (r.phase === "min-needs") {
      if (r.shortageReason) agg.reasons.add(r.shortageReason);
      if (r.comment) agg.reasons.add(r.comment);
      if (r.deltaPortions < 0) agg.days.add(r.day);
    } else if (r.phase === "result") {
      agg.resultPortions = (agg.resultPortions ?? 0) + r.actualPortions;
      if (r.comment) agg.resultComments.add(r.comment);
      if (r.shortageReason) agg.resultComments.add(r.shortageReason);
    }
  }
  return byMeal;
}

interface RedzoneAgg {
  portions: number;
  status: "active" | "completed";
  updatedAt: string | null;
}

// Redzone liefert Maschinen-gezählte Stückzahlen live pro Plating-Run —
// mealCode/status sind hier schon von RedzoneContext.enrichRun vorverarbeitet,
// hier nur noch nach Meal gruppieren. Nur "Plating"-Läufe zählen (Ovens/
// Braisers sind Küchen-Vorstufen, deckt Postblast Live über die Gewichte ab).
function aggregateRedzoneByMeal(runs: PlatingRunDisplay[] | undefined): Map<string, RedzoneAgg> {
  const byMeal = new Map<string, RedzoneAgg>();
  for (const run of runs ?? []) {
    if (run.areaName !== "Plating" || !run.mealCode) continue;
    const key = codeKey(run.mealCode);
    const cur = byMeal.get(key) ?? { portions: 0, status: "completed" as const, updatedAt: null };
    cur.portions += run.outCount ?? 0;
    if (run.status === "active") cur.status = "active";
    const ts = run.endTime ?? run.startTime;
    if (ts && (!cur.updatedAt || ts > cur.updatedAt)) cur.updatedAt = ts;
    byMeal.set(key, cur);
  }
  return byMeal;
}

// RTI Plating Tracker (gid=1486350915) — das Sheet, das den Backfill EXAKT
// errechnet. Meal-Block: Planned Target (D) vs. Actuals (E). Backfill-Menge =
// max(0, planned − actuals). Kandidaten-Zeilen (isBackfillCandidate — leere,
// vorbereitete Backfill-WO-Slots) fließen NICHT in die Status-Bewertung ein.
export interface RtiBackfillAgg {
  code: string;
  mealName: string;
  plannedTarget: number;
  actuals: number;
  shortfallPortions: number;
  vetoed: boolean;        // alle echten Sub-Rezepte "no" → kein Backfill nötig
  kitchenDone: boolean;   // alle echten Sub-Rezepte "done"/"no" → Rückstand final
  hasOpenSubs: boolean;
  candidateSubs: string[];
  isBackfill: boolean;
}

function aggregateRtiBackfillByMeal(rti: RtiData | null | undefined): Map<string, RtiBackfillAgg> {
  const byMeal = new Map<string, RtiBackfillAgg>();
  for (const meal of rti?.meals ?? []) {
    const key = codeKey(meal.mealCode);

    // Das RTI-Tab führt pro Meal oft MEHRERE Blöcke: die echte Wiegung plus
    // leere Vorbereitungs-/Zweitrun-Blöcke (Planned Target 0) — teils unter
    // verschiedenen Code-Varianten. Ein leerer Block darf den echten NICHT
    // überschreiben → den mit dem größten Planned Target behalten.
    const existing = byMeal.get(key);
    if (existing && meal.plannedTarget <= existing.plannedTarget) {
      // Zweitblock kann trotzdem vorbereitete Backfill-WOs auflisten.
      for (const s of meal.subRecipes) {
        if (s.isBackfillCandidate && !existing.candidateSubs.includes(s.subRecipeName)) {
          existing.candidateSubs.push(s.subRecipeName);
        }
      }
      continue;
    }

    const real = meal.subRecipes.filter(s => !s.isBackfillCandidate);
    const shortfallPortions = Math.max(0, meal.plannedTarget - meal.actuals);
    const vetoed = real.length > 0 && real.every(s => s.status === "not-needed");
    const kitchenDone = real.length > 0 && real.every(s => s.status === "done" || s.status === "not-needed");
    const hasOpenSubs = real.some(s => s.status === "open" || s.status === "unknown");
    const isBackfill = !vetoed && meal.plannedTarget > 0 && shortfallPortions >= MIN_RTI_SHORTFALL;
    byMeal.set(key, {
      code: meal.mealCode,
      mealName: meal.mealName,
      plannedTarget: meal.plannedTarget,
      actuals: meal.actuals,
      shortfallPortions,
      vetoed,
      kitchenDone,
      hasOpenSubs,
      candidateSubs: [...new Set([
        ...(existing?.candidateSubs ?? []),
        ...meal.subRecipes.filter(s => s.isBackfillCandidate).map(s => s.subRecipeName),
      ])],
      isBackfill,
    });
  }
  return byMeal;
}

function aggregateRtiHoldingByMeal(rti: RtiData | null | undefined): Map<string, number> {
  const byMeal = new Map<string, number>();
  for (const meal of rti?.meals ?? []) {
    // Holding ist ein Puffer-Snapshot — bei mehreren Blöcken je Meal (leere +
    // Varianten-Codes) den größten nehmen, nicht summieren (sonst Doppelzählung).
    const holding = meal.subRecipes.reduce((s, sr) => s + sr.platingHoldingKg, 0);
    const key = codeKey(meal.mealCode);
    byMeal.set(key, Math.max(byMeal.get(key) ?? 0, holding));
  }
  return byMeal;
}

// WMS live: Plating Holding (PLH-Locations) ist der tatsächliche physische
// Puffer zwischen Post-Blast und Plating — genau der Ort, an dem laut Marcel
// racks stehen, bevor sie geplated werden. Direkt aus dem Warenbestand
// (Snowflake, kein manuelles Sheet), deutlich aktueller als RTIs Handeintrag.
// Nur "SUB"-Kategorie-SKUs zählen (Sub-Rezepte, in Gramm) — MSKU/REC-Ebene
// (fertig verpackte Meals) hätte eine andere Einheit und würde die Summe
// verfälschen.
function aggregateWmsHoldingByMeal(
  rows: StoredRow[] | undefined,
  skuInfoIndex: Map<string, WmsSkuInfo> | undefined,
): Map<string, number> {
  const byMeal = new Map<string, number>();
  if (!rows || !skuInfoIndex) return byMeal;
  for (const row of rows) {
    const qty = row.actualQty ?? 0;
    if (qty <= 0) continue;
    const info = skuInfoIndex.get(skuKey(row.itemNumber));
    if (!info || info.category !== "SUB") continue;
    // Code-Varianten auf die 4-Ziffer entdoppeln, sonst zählt eine SKU, die in
    // FV4063A UND FV4063B steckt, doppelt.
    for (const key of new Set([...info.recipes].map(codeKey))) {
      byMeal.set(key, (byMeal.get(key) ?? 0) + qty / 1000);
    }
  }
  return byMeal;
}

function derivePriority(
  kitchenPriority: BackfillPriority | null,
  recommendedPortions: number,
  planned: number,
  rtiShortfall: number,
  rtiTarget: number,
): BackfillPriority {
  if (kitchenPriority === "critical") return "critical";
  const lpRatio = planned > 0 ? recommendedPortions / planned : 0;
  const rtiRatio = rtiTarget > 0 ? rtiShortfall / rtiTarget : 0;
  const ratio = Math.max(lpRatio, rtiRatio);
  if (ratio > 0.4) return "critical";
  if (kitchenPriority === "behind" || ratio > 0.15) return "behind";
  return "on-track";
}

// Die EINE Zahl, die zählt: wie viele Portionen dieses Meals noch nachproduziert
// werden müssen. Reihenfolge nach Verlässlichkeit:
//
// 1) LinePlating "{Tag} needs" — der vom Plating-Team im Kitchen-Priority-Sheet
//    täglich gepflegte Restbedarf. Kleiner als der rohe Σ(Planned−Actual), weil
//    ein Teil des Rückstands Puffer war. Die maßgebliche Zahl, sobald gesetzt.
// 2) RTI-Wiegung (Weight-Tracking) Planned Target − Actuals — wird nur gemacht,
//    wenn wirklich was fehlt, also die gemessene Realität. Schlüsselt den Bedarf
//    zusätzlich pro Sub-Rezept auf (rti* Felder).
// 3) LinePlating Σ(Planned − Actual) über die KW — grober Rückfall, solange
//    weder "{Tag} needs" noch RTI-Wiegung vorliegen (frühe Woche). Zu hoch.
// 4) Küchen-Gewichts-Schätzung aus Pre-/Post-Blast — letzter Rückfall.
//
// WICHTIG: wird NICHT gegen die Sa-Zeile verrechnet. Anfangs war die Annahme,
// Samstag sei "die gefahrene Backfill-Charge" und ihr Actual müsse vom Bedarf
// abgezogen werden — an echten W35-Daten geprüft, stimmt das nicht zuverlässig
// (bei den meisten Meals liegen Sa.Planned und Fr-Bedarf Größenordnungen
// auseinander). Das Sa-Ergebnis bleibt rein informativ (backfillResultPortions).
function deriveRecommendedBackfill(
  lpDayNeed: number | null,
  lpShortfall: number,
  // nur gesetzt, wenn rti.isBackfill (nicht vetoed, Rückstand über Schwelle)
  rtiShortfall: number | null,
  kitchenPortions: number,
): { portions: number; source: CombinedBackfillNeed["recommendedSource"] } {
  if (lpDayNeed != null && lpDayNeed > 0) return { portions: lpDayNeed, source: "lineplating" };
  if (rtiShortfall != null && rtiShortfall > 0) return { portions: rtiShortfall, source: "rti" };
  if (lpShortfall >= MIN_RTI_SHORTFALL) return { portions: lpShortfall, source: "plating" };
  if (kitchenPortions > 0) return { portions: kitchenPortions, source: "kitchen" };
  return { portions: 0, source: "none" };
}

export function combineBackfillSignals(
  kitchenBackfill: BackfillNeed[],
  linePlaiting: LinePlaitingData | null,
  rti: RtiData | null | undefined,
  redzoneRuns?: PlatingRunDisplay[],
  wmsHoldingRows?: StoredRow[],
  skuInfoIndex?: Map<string, WmsSkuInfo>,
): CombinedBackfillNeed[] {
  const kitchenByMeal = aggregateKitchenByMeal(kitchenBackfill);
  const platingByMeal = aggregatePlatingByMeal(linePlaiting);
  const rtiHoldingByMeal = aggregateRtiHoldingByMeal(rti);
  const rtiBackfillByMeal = aggregateRtiBackfillByMeal(rti);
  const redzoneByMeal = aggregateRedzoneByMeal(redzoneRuns);
  const wmsHoldingByMeal = aggregateWmsHoldingByMeal(wmsHoldingRows, skuInfoIndex);

  // Alle Maps sind auf die 4-Ziffer-Meal-Identität (codeKey) gekeyed — FV4063A
  // aus dem RTI-Sheet und FV4063B aus LinePlating landen im selben Eintrag.
  // Der 24-h-Redzone-Feed erzeugt KEINE eigenen Einträge (nur Anreicherung).
  // Der RTI-Rückstand dagegen SCHON — nur wenn isBackfill (nicht vetoed, über Schwelle).
  const allKeys = new Set<string>([...kitchenByMeal.keys(), ...platingByMeal.keys()]);
  for (const [key, rb] of rtiBackfillByMeal) {
    if (rb.isBackfill) allKeys.add(key);
  }
  const combined: CombinedBackfillNeed[] = [];

  for (const key of allKeys) {
    const k = kitchenByMeal.get(key) ?? null;
    const p = platingByMeal.get(key) ?? null;
    const rb = rtiBackfillByMeal.get(key) ?? null;

    // Anzeige-Code: LinePlating (Planer-Sicht) > RTI > Küche. codeVariants listet
    // alle gesehenen rohen Codes (Länge > 1 = Quellen nutzen andere Buchstaben).
    const variantSet = new Set<string>([p?.code, rb?.code, k?.code].filter((c): c is string => !!c));
    const recipeCode = p?.code ?? rb?.code ?? k?.code ?? key;

    const lpShortfall = p ? Math.max(0, p.allPlannedTotal - p.allActualTotal) : 0;
    // LinePlating meldet einen Bedarf, sobald "{Tag} needs" oder eine echte
    // Fehlmenge über der Rauschschwelle vorliegt.
    const lpHasNeed = !!p && ((p.minNeeded != null && p.minNeeded > 0) || lpShortfall >= MIN_RTI_SHORTFALL);

    const confidence =
      lpHasNeed && (k || rb?.isBackfill) ? "confirmed"
      : k && rb?.isBackfill ? "confirmed"
      : lpHasNeed ? "plating-only"
      : k ? "kitchen-only"
      : "rti-only";
    const recommended = deriveRecommendedBackfill(
      p?.minNeeded ?? null,
      lpShortfall,
      rb?.isBackfill ? rb.shortfallPortions : null,
      k?.missingPortions ?? 0,
    );
    const priority = derivePriority(
      k?.priority ?? null,
      recommended.portions,
      p?.allPlannedTotal ?? 0,
      rb?.isBackfill ? rb.shortfallPortions : 0,
      rb?.plannedTarget ?? 0,
    );

    combined.push({
      recipeCode,
      codeVariants: [...variantSet],
      recipeName: k?.recipeName ?? p?.meal ?? rb?.mealName ?? recipeCode,
      kitchenMissingKg: k?.missingKg ?? 0,
      kitchenMissingPortions: k?.missingPortions ?? 0,
      kitchenPriority: k?.priority ?? null,
      kitchenSubRecipes: k ? [...k.subRecipes] : [],
      platingPlannedPortions: p?.plannedPortions ?? 0,
      platingShortagePortions: p?.shortagePortions ?? 0,
      platingShortageReasons: p ? [...p.reasons] : [],
      platingDaysAffected: p ? [...p.days] : [],
      lpShortfallPortions: lpShortfall,
      lpWeek: linePlaiting?.week ?? "",
      lpStatusText: p?.statusText ?? "",
      minNeededPortions: p?.minNeeded ?? null,
      backfillResultPortions: p?.resultPortions ?? null,
      backfillResultComments: p ? [...p.resultComments] : [],
      rtiHoldingKg: rtiHoldingByMeal.get(key) ?? 0,
      // plannedTarget 0 = leerer/vorbereiteter RTI-Block, keine echte Wiegung.
      rtiPlannedTarget: rb && rb.plannedTarget > 0 ? rb.plannedTarget : null,
      rtiActuals: rb && rb.plannedTarget > 0 ? rb.actuals : null,
      rtiShortfallPortions: rb?.shortfallPortions ?? 0,
      rtiKitchenDone: rb?.kitchenDone ?? false,
      rtiHasOpenSubs: rb?.hasOpenSubs ?? false,
      rtiVetoed: rb?.vetoed ?? false,
      rtiBackfillCandidateSubs: rb?.candidateSubs ?? [],
      liveWmsHoldingKg: wmsHoldingByMeal.get(key) ?? null,
      liveRedzonePortions: redzoneByMeal.get(key)?.portions ?? null,
      liveRedzoneStatus: redzoneByMeal.get(key)?.status ?? null,
      recommendedBackfillPortions: recommended.portions,
      recommendedSource: recommended.source,
      confidence,
      priority,
    });
  }

  const priorityRank: Record<BackfillPriority, number> = { critical: 0, behind: 1, "on-track": 2 };
  combined.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || b.recommendedBackfillPortions - a.recommendedBackfillPortions);
  return combined;
}

let alertSeq = 0;
function alertId(): string {
  alertSeq += 1;
  return `backfill_alert_${Date.now()}_${alertSeq}`;
}

// Früherkennung. WICHTIG: Post-Blast (Küche) und Plating sind ZWEI
// EIGENSTÄNDIGE Kontrollpunkte im Produktionsablauf, keine zwei Blickwinkel
// auf dieselbe Zahl. Ein grünes Post-Blast sagt NICHTS darüber aus, ob beim
// Plating trotzdem was fehlt — zu spät gekocht, ein Rack im Plating Holding
// umgefallen/beschädigt, oder ein Rechenfehler irgendwo in der Kette, der
// erst beim tatsächlichen Plaiten sichtbar wird. Ein "nur Plating"-Fund ist
// deshalb KEINE Unstimmigkeit, die eine Bestätigung durch die Küche braucht —
// er ist für sich genommen ein vollwertiger, eigenständiger Backfill-Bedarf
// (siehe recommendedBackfillPortions/priority, die schon unabhängig vom
// Küchen-Signal greifen). Deshalb gibt es dafür hier bewusst KEINEN Alert.
// Was hier noch sinnvoll bleibt: ein rein VORWÄRTS gerichteter Hinweis, wenn
// die Küche schon ein kritisches Defizit zeigt, bevor die betroffene WO
// überhaupt beim Plating angekommen ist — und eine Gegenprüfung, wenn Freitags-
// Handrechnung und Gewichts-Schätzung deutlich auseinanderlaufen.
export function detectCrossSourceAlerts(combined: CombinedBackfillNeed[]): BackfillAlert[] {
  const alerts: BackfillAlert[] = [];

  for (const c of combined) {
    // "final" = die reguläre Produktion für die KW ist durch. Nur dann ist ein
    // Rückstand nicht mehr im Normalbetrieb aufholbar → App-weite Meldung.
    // rtiKitchenDone zählt nur bei einer ECHTEN Wiegung (rtiPlannedTarget != null);
    // ein leerer/vetoter RTI-Block (Planned Target 0) ist kein "durch".
    // "Ready"/"blocked" heißt nur "Backfill vorbereitet/blockiert", nicht "durch".
    const backfillFinal =
      (c.rtiPlannedTarget != null && c.rtiKitchenDone && !c.rtiVetoed) ||
      /\b(done|fertig)\b/i.test(c.lpStatusText);

    // LinePlating meldet Bedarf, aber im RTI-Sheet sind alle Sub-Rezepte auf
    // "no" (vetoed) — Widerspruch, muss geklärt werden.
    if (
      (c.recommendedSource === "lineplating" || c.recommendedSource === "plating") &&
      c.recommendedBackfillPortions > 0 &&
      c.rtiVetoed
    ) {
      alerts.push({
        id: alertId(),
        severity: "warning",
        recipeCode: c.recipeCode,
        recipeName: c.recipeName,
        title: `Widerspruch: ${c.recipeName}`,
        message: `LinePlating meldet ${Math.round(c.recommendedBackfillPortions).toLocaleString("de-DE")} Stk Restbedarf, im RTI-Sheet sind aber alle Sub-Rezepte auf „no" gesetzt (kein Backfill) — klären.`,
      });
    }

    // Der Bedarf ist final und über der Schwelle → hier muss ein Backfill her.
    if (
      (c.recommendedSource === "lineplating" || c.recommendedSource === "plating" || c.recommendedSource === "rti") &&
      backfillFinal &&
      c.recommendedBackfillPortions > 0
    ) {
      const planRef = c.rtiPlannedTarget || c.platingPlannedPortions || 0;
      const ratio = planRef > 0 ? c.recommendedBackfillPortions / planRef : 0;
      const madeStr = c.rtiActuals != null
        ? `${Math.round(c.rtiActuals).toLocaleString("de-DE")} von ${Math.round(c.rtiPlannedTarget ?? 0).toLocaleString("de-DE")} Stk produziert, `
        : "";
      alerts.push({
        id: alertId(),
        severity: ratio > 0.15 ? "critical" : "warning",
        recipeCode: c.recipeCode,
        recipeName: c.recipeName,
        title: `Backfill nötig: ${c.recipeName}`,
        message: `${madeStr}${Math.round(c.recommendedBackfillPortions).toLocaleString("de-DE")} Stk nachproduzieren (${SOURCE_SHORT[c.recommendedSource]}).`,
      });
    }

    // "{Tag} needs" liegt normal UNTER dem rohen RTI-Rückstand (Planned−Actual) —
    // ein Teil des Rückstands war Puffer, das ist erwartet und KEIN Alarm.
    // Auffällig ist nur die andere Richtung: das Plating-Team trägt MEHR
    // Restbedarf ein, als überhaupt fehlt (Planned − Actual) — dann stimmt
    // irgendwo eine Zahl nicht.
    if (
      c.recommendedSource === "lineplating" &&
      c.rtiShortfallPortions > 0 &&
      c.recommendedBackfillPortions > c.rtiShortfallPortions * 1.3
    ) {
      alerts.push({
        id: alertId(),
        severity: "info",
        recipeCode: c.recipeCode,
        recipeName: c.recipeName,
        title: `Abweichung Backfill-Menge: ${c.recipeName}`,
        message: `LinePlating „{Tag} needs": ${Math.round(c.recommendedBackfillPortions)} Portionen, aber Planned − Actual laut RTI-Wiegung nur ${Math.round(c.rtiShortfallPortions)} — zur Kontrolle gegenprüfen.`,
      });
    }

    // Vorwärts gerichteter Hinweis: Küche zeigt schon ein kritisches Defizit,
    // im Plating ist davon noch nichts angekommen (die WOs sind dort einfach
    // noch nicht dran) — reine Beobachtung, kein Widerspruch zwischen den
    // Kontrollpunkten, da Plating unabhängig sein eigenes Ergebnis liefert,
    // sobald die Charge ankommt.
    if (c.confidence === "kitchen-only" && c.kitchenPriority === "critical") {
      alerts.push({
        id: alertId(),
        severity: "info",
        recipeCode: c.recipeCode,
        recipeName: c.recipeName,
        title: `Küchen-Defizit noch vor dem Plating: ${c.recipeName}`,
        message: `Postblast Live zeigt −${c.kitchenMissingKg.toFixed(1)} kg fehlend (${c.kitchenSubRecipes.join(", ")}) — im Plating ist diese WO noch nicht angekommen, deshalb dort noch keine eigene Bewertung möglich.`,
      });
    }

    // Freitags-Handrechnung ("Min Needs") vs. aktuelle Gewichts-Berechnung —
    // größere Abweichung lohnt eine Gegenprüfung.
    if (c.minNeededPortions != null && c.kitchenMissingPortions > 0) {
      const diff = Math.abs(c.minNeededPortions - c.kitchenMissingPortions);
      const base = Math.max(c.minNeededPortions, c.kitchenMissingPortions, 1);
      if (diff / base > 0.3) {
        alerts.push({
          id: alertId(),
          severity: "info",
          recipeCode: c.recipeCode,
          recipeName: c.recipeName,
          title: `Abweichung Backfill-Menge: ${c.recipeName}`,
          message: `Freitags-Mindestbedarf laut LinePlaiting: ${c.minNeededPortions} Portionen, aktuelle Gewichts-Berechnung: ${Math.round(c.kitchenMissingPortions)} Portionen — zur Kontrolle gegenprüfen.`,
        });
      }
    }
  }

  const severityRank: Record<BackfillAlert["severity"], number> = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return alerts;
}
