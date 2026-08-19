// Postblast Live — regelbasierte Chat-KI für Produktionsabfragen.
import type { PostblastEntry } from "./gsheetTypes";
import type { MealProgress, WoMatchedStatus, BackfillNeed } from "./postblastMatch";
import type { ProductionIntelligence } from "./productionAgent";

export interface ChatMessage {
  role: "user" | "agent";
  text: string;
}

export interface ChatContext {
  meals: MealProgress[];
  backfill: BackfillNeed[];
  intelligence: ProductionIntelligence;
  matched: WoMatchedStatus[];
  todayEntries: PostblastEntry[];
}

export function respondToChat(input: string, ctx: ChatContext): string {
  const q = input.toLowerCase().trim();
  if (!q) return "";

  if (q === "hilfe" || q === "help" || q === "?" || q === "befehle") {
    return [
      "Verfügbare Abfragen:",
      "'was fehlt' — Backfill-Übersicht",
      "'kritisch' — kritische Work Orders",
      "'wie viel gewogen' — heutige Wiegungs-Bilanz",
      "'tempo' — Wiegungs-Pace",
      "'prognose' — Schichtende-Projektion",
      "'fertig' — abgeschlossene WOs",
      "'engpass' — Produktions-Bottleneck",
      "'empfehlung' — KI-Handlungsempfehlungen",
      "'status' — Gesamtüberblick",
      "'WO 123456' — spezifische Work Order",
      "'meal XY-001' — spezifisches Meal",
    ].join(" | ");
  }

  // Gesamtstatus / Überblick
  if (q.includes("status") || q.includes("überblick") || q.includes("zusammenfassung") || q.includes("wie läuft")) {
    const done = ctx.matched.filter(m => m.isComplete).length;
    const critical = ctx.backfill.filter(b => b.priority === "critical").length;
    const totalMissing = ctx.backfill.reduce((s, b) => s + b.missingKg, 0);
    const health = ctx.intelligence.shiftSummary?.overallHealth ?? "unknown";
    const healthLabel = health === "good" ? "ON TRACK ✓" : health === "warning" ? "ACHTUNG ⚠" : health === "critical" ? "KRITISCH ●" : "Unbekannt";
    const kg = ctx.todayEntries.reduce((s, e) => s + e.rawWeightKg, 0);
    return `Schicht-Status: ${healthLabel} | ${done}/${ctx.matched.length} WOs fertig | ${critical} kritisch | Heute: ${kg.toFixed(1)} kg | Fehlmenge: ${totalMissing.toFixed(0)} kg`;
  }

  // Heutige Wiegungen / Gewicht
  if (q.includes("gewogen") || q.includes("gewicht") || q.includes("wie viel") || q.includes("wieviel") || q.includes("kg heute")) {
    const kg = ctx.todayEntries.reduce((s, e) => s + e.rawWeightKg, 0);
    const count = ctx.todayEntries.length;
    if (count === 0) return "Heute noch keine Wiegungen erfasst.";
    const avg = kg / count;
    const ss = ctx.intelligence.shiftSummary;
    const paceStr = ss ? ` | Tempo: ${ss.kgPerHour.toFixed(1)} kg/h` : "";
    return `Heute: ${count} Wiegungen, ${kg.toFixed(1)} kg gesamt | Ø ${avg.toFixed(1)} kg/Wiegung${paceStr}`;
  }

  // Kritische WOs
  if (q.includes("kritisch")) {
    const critical = ctx.backfill.filter(b => b.priority === "critical");
    if (critical.length === 0) return "Keine kritischen Work Orders — alles im grünen Bereich.";
    const list = critical.slice(0, 5).map(b => `${b.workOrder} "${b.subRecipe}" (−${b.missingKg.toFixed(1)} kg)`).join(" | ");
    return `${critical.length} kritische WO${critical.length > 1 ? "s" : ""}: ${list}`;
  }

  // Was fehlt / Backfill
  if (q.includes("was fehlt") || q.includes("backfill") || (q.includes("fehlt") && !q.includes("wo"))) {
    if (ctx.backfill.length === 0) return "Kein Backfill-Bedarf — Plan wird erfüllt!";
    const total = ctx.backfill.reduce((s, b) => s + b.missingKg, 0);
    const critical = ctx.backfill.filter(b => b.priority === "critical").length;
    const behind = ctx.backfill.filter(b => b.priority === "behind").length;
    return `Gesamt fehlt: ${total.toFixed(1)} kg in ${ctx.backfill.length} WOs | ${critical} kritisch | ${behind} hinter Plan`;
  }

  // Fertige WOs
  if (q.includes("fertig") || q.includes("abgeschlossen") || q.includes("done") || q.includes("komplett")) {
    const done = ctx.matched.filter(m => m.isComplete);
    const pct = ctx.matched.length > 0 ? (done.length / ctx.matched.length * 100).toFixed(0) : "0";
    if (done.length === 0) return "Noch keine Work Orders abgeschlossen.";
    return `${done.length} von ${ctx.matched.length} Work Orders fertig (${pct}%) | Zuletzt: ${done.slice(-3).map(w => `${w.workOrder} "${w.subRecipe}"`).join(", ")}`;
  }

  // Tempo / Pace
  if (q.includes("tempo") || q.includes("pace") || q.includes("geschwindigkeit") || q.includes("pro stunde")) {
    const ss = ctx.intelligence.shiftSummary;
    if (!ss) return "Zu wenig Daten für Tempo-Analyse (mind. 2 Wiegungen heute nötig).";
    return `Tempo: ${ss.kgPerHour.toFixed(1)} kg/h | ${ss.entriesPerHour.toFixed(1)} Wiegungen/h | Ø ${ss.avgWeightPerEntry.toFixed(1)} kg/Wiegung | Schicht läuft seit ${ss.shiftDurationHours.toFixed(1)} h`;
  }

  // Prognose / Schichtende
  if (q.includes("prognose") || q.includes("schichtende") || q.includes("projektion") || q.includes("reicht")) {
    const ss = ctx.intelligence.shiftSummary;
    if (!ss) return "Zu wenig Daten für Prognose (mind. 2 Wiegungen nötig).";
    if (ss.shortfallAtEndOfShift > 0) {
      return `Prognose Schichtende: ${ss.projectedEndOfShift.toFixed(0)} kg | Fehlprognose: −${ss.shortfallAtEndOfShift.toFixed(0)} kg — Backfill nötig!`;
    }
    return `Prognose Schichtende: ${ss.projectedEndOfShift.toFixed(0)} kg — Plan wird voraussichtlich erfüllt!`;
  }

  // Empfehlungen
  if (q.includes("empfehlung") || q.includes("was tun") || q.includes("was machen") || q.includes("was soll") || q.includes("tipp")) {
    if (ctx.intelligence.recommendations.length === 0) return "Keine besonderen Empfehlungen — Produktion läuft gut.";
    return ctx.intelligence.recommendations.join(" | ");
  }

  // Engpass / Bottleneck
  if (q.includes("engpass") || q.includes("bottleneck") || q.includes("blockiert") || q.includes("problem")) {
    const ss = ctx.intelligence.shiftSummary;
    if (ss?.topBottleneck) return `Hauptengpass: "${ss.topBottleneck}" — sofort vorziehen!`;
    const critMeals = ctx.meals.filter(m => m.criticalWOs.length > 0).sort((a, b) => a.progressPct - b.progressPct);
    if (critMeals.length === 0) return "Kein kritischer Engpass erkannt.";
    const top = critMeals[0];
    return `Top-Engpass: Meal ${top.recipeCode} "${top.recipeName}" (${top.progressPct.toFixed(0)}%) — offen: ${top.criticalWOs.slice(0, 2).map(w => `"${w.subRecipe}"`).join(", ")}`;
  }

  // WO-Lookup: "WO 123456", "wo123456", "work order 123456"
  const woMatch = /(?:wo|work.?order)\s*[#-]?(\d{4,})/i.exec(q);
  if (woMatch) {
    const woNum = woMatch[1];
    const wo = ctx.matched.find(m => m.workOrder.includes(woNum));
    if (!wo) return `WO ${woNum} nicht im Produktionsplan gefunden. Tippe 'fertig' oder 'kritisch' für eine Übersicht.`;
    const status = wo.isComplete
      ? "✓ Fertig (≥95%)"
      : wo.isCritical
        ? "⚠ Kritisch — noch 0 kg"
        : `${wo.progressPct.toFixed(0)}% (${wo.actualKg.toFixed(1)} von ${wo.plannedKg.toFixed(1)} kg)`;
    return `WO ${wo.workOrder}: "${wo.subRecipe}" — ${status} | Meal: ${wo.recipeCode} ${wo.recipeName}`;
  }

  // Meal-Lookup: "meal XY-001", "rezept abc", "code R12"
  const mealMatch = /(?:meal|rezept|code|recipe)\s*[#:]?\s*([A-Z0-9][A-Z0-9_\-]{1,})/i.exec(q);
  if (mealMatch) {
    const code = mealMatch[1].toUpperCase();
    const meal = ctx.meals.find(m =>
      m.recipeCode.toUpperCase().includes(code) ||
      m.recipeName.toUpperCase().includes(code)
    );
    if (!meal) return `Meal "${code}" nicht gefunden. Tippe 'status' für alle Meals.`;
    const critStr = meal.criticalWOs.length > 0
      ? ` | Kritisch: ${meal.criticalWOs.slice(0, 2).map(w => `"${w.subRecipe}"`).join(", ")}`
      : "";
    return `Meal ${meal.recipeCode} "${meal.recipeName}": ${meal.progressPct.toFixed(0)}% | ${meal.completedWOs}/${meal.totalWOs} WOs fertig${critStr}`;
  }

  return "Ich habe das nicht verstanden. Tippe 'hilfe' für verfügbare Befehle — z.B. 'was fehlt', 'kritisch', 'prognose', 'WO 123456'.";
}
