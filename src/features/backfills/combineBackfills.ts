// Backfills – reine Zusammenführungs-/Analyse-Logik, keine Hooks/State hier
// (siehe BackfillsContext.tsx für die Live-Verdrahtung), damit sie unabhängig
// testbar bleibt.
import type { BackfillNeed } from "../gsheet-monitor/postblastMatch";
import type { LinePlaitingData, RtiData } from "../gsheet-monitor/gsheetTypes";
import type { PlatingRunDisplay } from "../redzone-live/redzoneTypes";
import type { StoredRow } from "../wms-overview/wmsTypes";
import type { WmsSkuInfo } from "../../lib/wmsSkuEnrichment";
import { skuKey } from "../../lib/wmsSkuEnrichment";
import type { BackfillAlert, BackfillPriority, CombinedBackfillNeed } from "./backfillTypes";

interface KitchenAgg {
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
    const cur = byMeal.get(b.recipeCode) ?? {
      recipeName: b.recipeName, missingKg: 0, missingPortions: 0, priority: "on-track" as BackfillPriority, subRecipes: new Set<string>(),
    };
    cur.missingKg += b.missingKg;
    cur.missingPortions += b.estimatedPortions;
    cur.subRecipes.add(b.subRecipe);
    if (rank[b.priority] > rank[cur.priority]) cur.priority = b.priority;
    byMeal.set(b.recipeCode, cur);
  }
  return byMeal;
}

interface PlatingAgg {
  meal: string;
  plannedPortions: number;
  shortagePortions: number;
  reasons: Set<string>;
  days: Set<string>;
  minNeeded: number | null;
  resultPortions: number | null;
  resultComments: Set<string>;
}

function aggregatePlatingByMeal(linePlaiting: LinePlaitingData | null): Map<string, PlatingAgg> {
  const byMeal = new Map<string, PlatingAgg>();
  if (!linePlaiting) return byMeal;

  const get = (code: string, meal: string): PlatingAgg => {
    let cur = byMeal.get(code);
    if (!cur) {
      cur = { meal, plannedPortions: 0, shortagePortions: 0, reasons: new Set(), days: new Set(), minNeeded: null, resultPortions: null, resultComments: new Set() };
      byMeal.set(code, cur);
    }
    return cur;
  };

  for (const r of linePlaiting.rows) {
    const agg = get(r.recipeCode, r.meal);
    if (r.phase === "shortage") {
      agg.plannedPortions += r.plannedPortions;
      if (r.deltaPortions < 0) agg.shortagePortions += -r.deltaPortions;
      if (r.shortageReason) agg.reasons.add(r.shortageReason);
      agg.days.add(r.day);
    } else if (r.phase === "min-needs") {
      if (r.minNeededPortions != null) agg.minNeeded = (agg.minNeeded ?? 0) + r.minNeededPortions;
      if (r.shortageReason) agg.reasons.add(r.shortageReason);
    } else if (r.phase === "result") {
      agg.resultPortions = (agg.resultPortions ?? 0) + r.actualPortions;
      if (r.comment) agg.resultComments.add(r.comment);
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
    const code = run.mealCode.toUpperCase();
    const cur = byMeal.get(code) ?? { portions: 0, status: "completed" as const, updatedAt: null };
    cur.portions += run.outCount ?? 0;
    if (run.status === "active") cur.status = "active";
    const ts = run.endTime ?? run.startTime;
    if (ts && (!cur.updatedAt || ts > cur.updatedAt)) cur.updatedAt = ts;
    byMeal.set(code, cur);
  }
  return byMeal;
}

function aggregateRtiHoldingByMeal(rti: RtiData | null | undefined): Map<string, number> {
  const byMeal = new Map<string, number>();
  for (const meal of rti?.meals ?? []) {
    const holding = meal.subRecipes.reduce((s, sr) => s + sr.platingHoldingKg, 0);
    byMeal.set(meal.mealCode, (byMeal.get(meal.mealCode) ?? 0) + holding);
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
    for (const recipeCode of info.recipes) {
      byMeal.set(recipeCode, (byMeal.get(recipeCode) ?? 0) + qty / 1000);
    }
  }
  return byMeal;
}

function derivePriority(kitchenPriority: BackfillPriority | null, shortagePortions: number, plannedPortions: number): BackfillPriority {
  if (kitchenPriority === "critical") return "critical";
  const ratio = plannedPortions > 0 ? shortagePortions / plannedPortions : 0;
  if (ratio > 0.4) return "critical";
  if (kitchenPriority === "behind" || ratio > 0.15) return "behind";
  return "on-track";
}

// Die EINE Zahl, die zählt: wie viele Portionen dieses Meals noch fehlen.
// Priorität nach Verlässlichkeit (siehe recommendedSource-Kommentar in
// backfillTypes.ts), NICHT nach Größe — eine Fr-Handrechnung mit voller
// Wochenkenntnis schlägt eine reine Gewichts-Schätzung von Anfang der Woche,
// auch wenn die Zahlen auseinanderlaufen (dafür gibt es die "Abweichung"-
// Warnung separat).
//
// WICHTIG: wird NICHT gegen die Sa-Zeile verrechnet. Anfangs war die Annahme,
// Samstag sei "die gefahrene Backfill-Charge" und ihr Actual müsse vom Bedarf
// abgezogen werden — an echten W35-Daten geprüft, stimmt das nicht zuverlässig:
// bei manchen Meals passt Sa.Planned exakt zum Fr-Mindestbedarf (z.B. FV0576A:
// beide 1200), bei den meisten aber gar nicht (z.B. FV0713A: Sa.Planned 1160
// vs. Fr-Bedarf 260 — Größenordnungen auseinander). Samstag ist vermutlich oft
// einfach ein weiterer regulärer Plating-Tag mit eigenem Soll, kein gezielter
// Backfill-Lauf. Eine automatische Verrechnung hätte bei ca. der Hälfte der
// Meals fälschlich "0 nötig" gezeigt, obwohl unbelegt. Das Sa-Ergebnis bleibt
// deshalb rein informativ (siehe backfillResultPortions), bis geklärt ist, was
// dieser Block wirklich bedeutet.
function deriveRecommendedBackfill(
  minNeeded: number | null,
  platingShortage: number,
  kitchenPortions: number,
): { portions: number; source: CombinedBackfillNeed["recommendedSource"] } {
  if (minNeeded != null && minNeeded > 0) return { portions: minNeeded, source: "min-needs" };
  if (platingShortage > 0) return { portions: platingShortage, source: "plating" };
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
  const rtiByMeal = aggregateRtiHoldingByMeal(rti);
  const redzoneByMeal = aggregateRedzoneByMeal(redzoneRuns);
  const wmsHoldingByMeal = aggregateWmsHoldingByMeal(wmsHoldingRows, skuInfoIndex);

  // Redzone erzeugt bewusst KEINE eigenen Einträge — sonst würde jeder normal
  // laufende Plating-Run (ohne jeden Rückstand) als "Meal" in der Liste
  // auftauchen, nur weil die Linie ihn gerade zählt. Redzone reichert nur an,
  // was Küche/Plating bereits als relevant markiert haben.
  const allCodes = new Set<string>([...kitchenByMeal.keys(), ...platingByMeal.keys()]);
  const combined: CombinedBackfillNeed[] = [];

  for (const code of allCodes) {
    const k = kitchenByMeal.get(code) ?? null;
    const p = platingByMeal.get(code) ?? null;

    const confidence = k && p && p.shortagePortions > 0 ? "confirmed" : k ? "kitchen-only" : "plating-only";
    const recommended = deriveRecommendedBackfill(p?.minNeeded ?? null, p?.shortagePortions ?? 0, k?.missingPortions ?? 0);
    const priority = derivePriority(k?.priority ?? null, p?.shortagePortions ?? 0, p?.plannedPortions ?? 0);

    combined.push({
      recipeCode: code,
      recipeName: k?.recipeName ?? p?.meal ?? code,
      kitchenMissingKg: k?.missingKg ?? 0,
      kitchenMissingPortions: k?.missingPortions ?? 0,
      kitchenPriority: k?.priority ?? null,
      kitchenSubRecipes: k ? [...k.subRecipes] : [],
      platingPlannedPortions: p?.plannedPortions ?? 0,
      platingShortagePortions: p?.shortagePortions ?? 0,
      platingShortageReasons: p ? [...p.reasons] : [],
      platingDaysAffected: p ? [...p.days] : [],
      minNeededPortions: p?.minNeeded ?? null,
      backfillResultPortions: p?.resultPortions ?? null,
      backfillResultComments: p ? [...p.resultComments] : [],
      rtiHoldingKg: rtiByMeal.get(code) ?? 0,
      liveWmsHoldingKg: wmsHoldingByMeal.get(code) ?? null,
      liveRedzonePortions: redzoneByMeal.get(code)?.portions ?? null,
      liveRedzoneStatus: redzoneByMeal.get(code)?.status ?? null,
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
