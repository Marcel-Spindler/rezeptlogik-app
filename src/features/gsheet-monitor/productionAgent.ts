// Production Intelligence Agent — regelbasierte + heuristische Produktionsüberwachung.
// Analysiert Postblast-Daten, erkennt Muster, generiert Alerts und Empfehlungen.
import type { PostblastData } from "./gsheetTypes";
import type { MealProgress } from "./postblastMatch";
import type { BackfillPlan } from "./backfillGenerator";
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

function analyzeEquipmentLoad(backfillPlan: BackfillPlan): ProductionAlert[] {
  const alerts: ProductionAlert[] = [];

  // Equipment-Auslastung: wenn ein Equipment >10 Chargen hat → Bottleneck
  const byEquip = new Map<string, number>();
  for (const p of backfillPlan.proposals) {
    byEquip.set(p.equipment, (byEquip.get(p.equipment) ?? 0) + p.batchCount);
  }

  for (const [equip, batches] of byEquip) {
    if (batches > 8) {
      alerts.push({
        id: generateId(),
        severity: "warning",
        category: "equipment",
        title: `${equip} überlastet`,
        message: `${batches} Chargen für Backfill auf ${equip} geplant. Evtl. auf andere Geräte verteilen oder Schicht verlängern.`,
        timestamp: Date.now(),
        actionable: true,
        suggestedAction: `Kapazitätsplanung prüfen — ${equip} Bottleneck für ${batches} Nachproduktionen`
      });
    }
  }

  return alerts;
}

function generateRecommendations(meals: MealProgress[], backfillPlan: BackfillPlan): string[] {
  const recs: string[] = [];

  // Sortierte Priorität: Was zuerst angehen?
  const critical = backfillPlan.proposals.filter(p => p.priority === "critical");
  if (critical.length > 0) {
    recs.push(`Sofort starten: ${critical.slice(0, 3).map(c => `${c.subRecipe} (${c.batchCount}× ${c.equipment})`).join(", ")}`);
  }

  // Meals die fast fertig sind (>80%) → Fokus auf fehlende letzte WOs
  const almostDone = meals.filter(m => m.progressPct >= 80 && m.progressPct < 100);
  if (almostDone.length > 0) {
    recs.push(`Fast fertig (>80%): ${almostDone.map(m => `${m.recipeCode} (noch ${m.totalWOs - m.completedWOs} WOs)`).join(", ")} → Zuerst abschließen`);
  }

  // Equipment-Effizienz: gleiche Sub-Recipes zusammenlegen
  const subRecipeCounts = new Map<string, number>();
  for (const p of backfillPlan.proposals) {
    subRecipeCounts.set(p.subRecipe, (subRecipeCounts.get(p.subRecipe) ?? 0) + 1);
  }
  const duplicates = [...subRecipeCounts].filter(([_, count]) => count > 1);
  if (duplicates.length > 0) {
    recs.push(`Bündelung möglich: ${duplicates.map(([name, count]) => `"${name}" (${count}× benötigt)`).join(", ")} → Zusammen produzieren spart Umrüstzeit`);
  }

  // Gesamteinschätzung
  const totalHours = backfillPlan.totalBatches * 0.75; // ~45min pro Charge geschätzt
  if (totalHours > 8) {
    recs.push(`Geschätzte Backfill-Dauer: ~${totalHours.toFixed(1)}h. Evtl. Nachtschicht oder 2. Linie einplanen.`);
  } else if (totalHours > 4) {
    recs.push(`Geschätzte Backfill-Dauer: ~${totalHours.toFixed(1)}h. Machbar in einer Schicht bei sofortigem Start.`);
  }

  return recs;
}

function computeShiftSummary(postblast: PostblastData, meals: MealProgress[]): ShiftSummary | null {
  const entries = postblast.entries;
  if (entries.length === 0) return null;

  const totalWeighed = postblast.totalWeightKg;
  const timestamps = entries.map(e => new Date(e.timestamp).getTime()).filter(t => !isNaN(t));
  if (timestamps.length < 2) return null;

  const shiftStartMs = Math.min(...timestamps);
  const shiftDurationHours = (Date.now() - shiftStartMs) / 3600000;
  const entriesPerHour = shiftDurationHours > 0 ? entries.length / shiftDurationHours : 0;
  const kgPerHour = shiftDurationHours > 0 ? totalWeighed / shiftDurationHours : 0;

  // Projektion: wenn Schicht 8h dauert, wie viel noch?
  const remainingHours = Math.max(0, 8 - shiftDurationHours);
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
    projectedEndOfShift,
    shortfallAtEndOfShift: shortfall,
    topBottleneck: bottleneckMeal?.criticalWOs[0]?.subRecipe ?? null,
    overallHealth,
  };
}

export function analyzeProduction(
  postblast: PostblastData | null,
  meals: MealProgress[],
  backfillPlan: BackfillPlan,
  productionPlan: ProductionPlan | undefined
): ProductionIntelligence {
  if (!postblast) return { alerts: [], shiftSummary: null, recommendations: [], lastAnalysis: Date.now() };

  const alerts: ProductionAlert[] = [
    ...analyzeWeighingPace(postblast),
    ...analyzeWeightAnomalies(postblast, productionPlan),
    ...analyzeMealProgress(meals),
    ...analyzeEquipmentLoad(backfillPlan),
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

  const recommendations = generateRecommendations(meals, backfillPlan);
  const shiftSummary = computeShiftSummary(postblast, meals);

  return { alerts: dedupedAlerts, shiftSummary, recommendations, lastAnalysis: Date.now() };
}
