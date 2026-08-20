// Production Intelligence Agent — regelbasierte + heuristische Produktionsüberwachung.
// Analysiert Postblast-Daten, erkennt Muster, generiert Alerts und Empfehlungen.
import type { PostblastData } from "./gsheetTypes";
import type { BackfillNeed, MealProgress } from "./postblastMatch";
import type { ProductionPlan } from "../../core/types";

export type AlertSeverity = "critical" | "warning" | "info" | "success";
export type AlertCategory = "pace" | "gap" | "anomaly" | "equipment" | "recommendation" | "summary";

export interface ProductionAlert {
  id: string;
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  message: string;
  workOrder?: string;
  subRecipe?: string;
  recipeCode?: string;
  timestamp: number;
  actionable: boolean;
  suggestedAction?: string;
}

export interface ShiftSummary {
  totalWeighed: number;
  totalEntries: number;
  avgWeightPerEntry: number;
  entriesPerHour: number;
  kgPerHour: number;
  shiftDurationHours: number;
  projectedEndOfShift: number;
  shortfallAtEndOfShift: number;
  topBottleneck: string | null;
  overallHealth: "good" | "warning" | "critical";
}

export interface ProductionIntelligence {
  alerts: ProductionAlert[];
  shiftSummary: ShiftSummary | null;
  recommendations: string[];
  lastAnalysis: number;
}

function generateId(): string {
  return `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function analyzeWeighingPace(postblast: PostblastData): ProductionAlert[] {
  const alerts: ProductionAlert[] = [];
  const entries = postblast.entries;
  if (entries.length < 3) return alerts;

  // Letzte 10 Einträge: Zeitabstand analysieren
  const recent = entries.slice(-10);
  const timestamps = recent
    .map(e => new Date(e.timestamp).getTime())
    .filter(t => !isNaN(t));

  if (timestamps.length >= 3) {
    const gaps = [];
    for (let i = 1; i < timestamps.length; i++) {
      gaps.push(timestamps[i] - timestamps[i - 1]);
    }
    const avgGapMs = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const avgGapMin = avgGapMs / 60000;

    // Wenn mehr als 30 Min seit letzter Wiegung → Stillstand-Warnung
    const lastTimestamp = timestamps[timestamps.length - 1];
    const sinceLastMin = (Date.now() - lastTimestamp) / 60000;

    if (sinceLastMin > 45) {
      alerts.push({
        id: generateId(),
        severity: "critical",
        category: "pace",
        title: "Produktionsstillstand",
        message: `Seit ${Math.round(sinceLastMin)} Minuten keine neue Wiegung. Letzte Eingabe: ${recent[recent.length - 1].subRecipeName}`,
        timestamp: Date.now(),
        actionable: true,
        suggestedAction: "Produktionsstatus prüfen — Maschine / Personal / Material?"
      });
    } else if (sinceLastMin > 20 && avgGapMin < 10) {
      alerts.push({
        id: generateId(),
        severity: "warning",
        category: "pace",
        title: "Verlangsamung erkannt",
        message: `Normalerweise alle ${Math.round(avgGapMin)} Min eine Wiegung, jetzt ${Math.round(sinceLastMin)} Min Pause.`,
        timestamp: Date.now(),
        actionable: false,
      });
    }
  }

  return alerts;
}

function analyzeWeightAnomalies(postblast: PostblastData, productionPlan: ProductionPlan | undefined): ProductionAlert[] {
  const alerts: ProductionAlert[] = [];
  if (!productionPlan) return alerts;

  // Pro Sub-Recipe: durchschnittliches Gewicht vs. letzter Eintrag
  for (const [subName, entries] of postblast.bySubRecipe) {
    if (entries.length < 2) continue;
    const weights = entries.map(e => e.rawWeightKg).filter(w => w > 0);
    if (weights.length < 2) continue;

    const avg = weights.reduce((s, w) => s + w, 0) / weights.length;
    const last = weights[weights.length - 1];
    const deviationPct = Math.abs((last - avg) / avg) * 100;

    // Wenn letzte Wiegung >40% vom Durchschnitt abweicht → Anomalie
    if (deviationPct > 40 && Math.abs(last - avg) > 5) {
      alerts.push({
        id: generateId(),
        severity: "warning",
        category: "anomaly",
        title: `Gewichts-Anomalie: ${subName}`,
        message: `Letzte Wiegung ${last.toFixed(1)} kg weicht ${deviationPct.toFixed(0)}% vom Ø (${avg.toFixed(1)} kg) ab.`,
        subRecipe: subName,
        timestamp: Date.now(),
        actionable: true,
        suggestedAction: last > avg ? "Überfüllung prüfen — Chargenrezept korrekt?" : "Unterfüllung — Material ausreichend?"
      });
    }
  }

  return alerts;
}

function analyzeMealProgress(meals: MealProgress[]): ProductionAlert[] {
  const alerts: ProductionAlert[] = [];

  for (const meal of meals) {
    // Meal komplett unter 10% und hat kritische WOs
    if (meal.progressPct < 10 && meal.totalPlannedKg > 0) {
      alerts.push({
        id: generateId(),
        severity: "critical",
        category: "gap",
        title: `Meal ${meal.recipeCode} kaum gestartet`,
        message: `${meal.recipeName}: nur ${meal.progressPct.toFixed(0)}% produziert. ${meal.criticalWOs.length} WOs komplett offen.`,
        recipeCode: meal.recipeCode,
        timestamp: Date.now(),
        actionable: true,
        suggestedAction: `Sofort starten: ${meal.criticalWOs.slice(0, 2).map(w => w.subRecipe).join(", ")}`
      });
    }

    // Einzelne Sub-Recipes mit 0% bei >50% Gesamt-Fortschritt → Engpass
    if (meal.progressPct > 50) {
      for (const wo of meal.criticalWOs) {
        alerts.push({
          id: generateId(),
          severity: "warning",
          category: "gap",
          title: `Engpass: ${wo.subRecipe}`,
          message: `Meal ${meal.recipeCode} ist zu ${meal.progressPct.toFixed(0)}% fertig, aber "${wo.subRecipe}" hat noch 0 kg. Blockiert das Plating.`,
          workOrder: wo.workOrder,
          subRecipe: wo.subRecipe,
          recipeCode: meal.recipeCode,
          timestamp: Date.now(),
          actionable: true,
          suggestedAction: `WO ${wo.workOrder} vorziehen — limitiert die Fertigstellung`
        });
      }
    }
  }

  return alerts;
}

function shortName(name: string, words = 3): string {
  return name.split(/[\s\-]+/).slice(0, words).join(" ");
}

function generateRecommendations(meals: MealProgress[], backfill: BackfillNeed[]): string[] {
  const recs: string[] = [];

  // Kritisch → sofort, mit fehlender Stückzahl je Sub-Rezept
  const critical = backfill.filter(b => b.priority === "critical");
  if (critical.length > 0) {
    const names = critical.slice(0, 2).map(c => `${shortName(c.subRecipe)} (−${fmtInt(c.estimatedPortions)} Stk)`).join(", ");
    const more = critical.length > 2 ? ` +${critical.length - 2} weitere` : "";
    recs.push(`Sofort melden: ${names}${more}`);
  }

  // Fast fertige Meals zuerst abschließen
  const almostDone = meals.filter(m => m.progressPct >= 80 && m.completedWOs < m.totalWOs);
  if (almostDone.length > 0) {
    recs.push(`Fast fertig: ${almostDone.slice(0, 3).map(m => `${m.recipeCode} (${m.totalWOs - m.completedWOs} WOs offen)`).join(", ")}`);
  }

  // Gleiche Sub-Rezepte fehlen in mehreren Meals — nur Anzahl, Details im Bündelungs-Block
  const subCounts = new Map<string, number>();
  for (const b of backfill) subCounts.set(b.subRecipe, (subCounts.get(b.subRecipe) ?? 0) + 1);
  const bundleCount = [...subCounts.values()].filter(n => n > 1).length;
  if (bundleCount > 0) {
    recs.push(`${bundleCount} Sub-Rezept${bundleCount > 1 ? "e" : ""} fehlen in mehreren Meals — zusammen als einen Backfill anlegen (↓ Details)`);
  }

  return recs;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("de-DE");
}

function computeShiftSummary(postblast: PostblastData, meals: MealProgress[], shiftEndHours = 8): ShiftSummary | null {
  const allEntries = postblast.entries;
  if (allEntries.length === 0) return null;

  // Nur heutige Einträge für korrekte Schichtbilanz
  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = allEntries.filter(e => e.date === today);
  const entries = todayEntries.length > 0 ? todayEntries : allEntries;

  const totalWeighed = entries.reduce((s, e) => s + e.rawWeightKg, 0);
  const timestamps = entries.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
  if (timestamps.length < 2) return null;

  const shiftStartMs = Math.min(...timestamps);
  const shiftDurationHours = (Date.now() - shiftStartMs) / 3600000;
  const entriesPerHour = shiftDurationHours > 0 ? entries.length / shiftDurationHours : 0;
  const kgPerHour = shiftDurationHours > 0 ? totalWeighed / shiftDurationHours : 0;

  const remainingHours = Math.max(0, shiftEndHours - shiftDurationHours);
  const projectedEndOfShift = totalWeighed + (kgPerHour * remainingHours);

  const totalPlanned = meals.reduce((s, m) => s + m.totalPlannedKg, 0);
  const shortfall = Math.max(0, totalPlanned - projectedEndOfShift);

  const overallHealth: ShiftSummary["overallHealth"] =
    shortfall <= 0 ? "good" : shortfall / totalPlanned < 0.2 ? "warning" : "critical";

  const bottleneckMeal = meals.filter(m => m.criticalWOs.length > 0).sort((a, b) => a.progressPct - b.progressPct)[0];

  return {
    totalWeighed,
    totalEntries: entries.length,
    avgWeightPerEntry: entries.length > 0 ? totalWeighed / entries.length : 0,
    entriesPerHour,
    kgPerHour,
    shiftDurationHours,
    projectedEndOfShift,
    shortfallAtEndOfShift: shortfall,
    topBottleneck: bottleneckMeal?.criticalWOs[0]?.subRecipe ?? null,
    overallHealth,
  };
}

export function analyzeProduction(
  postblast: PostblastData | null,
  meals: MealProgress[],
  backfill: BackfillNeed[],
  productionPlan: ProductionPlan | undefined,
  shiftEndHours = 8
): ProductionIntelligence {
  if (!postblast) return { alerts: [], shiftSummary: null, recommendations: [], lastAnalysis: Date.now() };

  const alerts: ProductionAlert[] = [
    ...analyzeWeighingPace(postblast),
    ...analyzeWeightAnomalies(postblast, productionPlan),
    ...analyzeMealProgress(meals),
  ];

  // Deduplizieren (gleiche Kategorie + WO nicht mehrfach)
  const seen = new Set<string>();
  const dedupedAlerts = alerts.filter(a => {
    const key = `${a.category}_${a.workOrder ?? ""}_${a.subRecipe ?? ""}_${a.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Nach Severity sortieren
  const severityOrder: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2, success: 3 };
  dedupedAlerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const recommendations = generateRecommendations(meals, backfill);
  const shiftSummary = computeShiftSummary(postblast, meals, shiftEndHours);

  return { alerts: dedupedAlerts, shiftSummary, recommendations, lastAnalysis: Date.now() };
}
