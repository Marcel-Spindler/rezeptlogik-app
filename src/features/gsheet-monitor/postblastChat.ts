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
      "Verfügbare Befehle:",
      "'status' — Gesamtüberblick Schicht",
      "'was fehlt' — Backfill-Bedarf nach Meal",
      "'als nächstes' — Top-Prioritäten jetzt",
      "'kritisch' — kritische Work Orders",
      "'runs' — Run-Übersicht aller Meals",
      "'run 2' — Details zu Run 2",
      "'meals' — alle Meals mit Status",
      "'tempo' — kg/h Wiegungs-Pace",
      "'prognose' — Schichtende-Projektion",
      "'fertig' — abgeschlossene WOs",
      "'engpass' — Produktions-Bottleneck",
      "'empfehlung' — KI-Handlungsempfehlungen",
      "'gewogen' — heutige Wiegungs-Bilanz",
      "'WO 35-209' — spezifische Work Order",
      "'meal FV0516A' — spezifisches Meal",
    ].join("\n");
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

  // Was fehlt / Backfill — aufgeschlüsselt nach Meal
  if (q.includes("was fehlt") || q.includes("backfill") || (q.includes("fehlt") && !q.includes("wo"))) {
    if (ctx.backfill.length === 0) return "✓ Kein Backfill-Bedarf — Plan wird erfüllt!";
    const total = ctx.backfill.reduce((s, b) => s + b.missingKg, 0);
    const critical = ctx.backfill.filter(b => b.priority === "critical").length;
    const behind = ctx.backfill.filter(b => b.priority === "behind").length;
    const mealMap = new Map<string, { kg: number; count: number; hasCritical: boolean }>();
    for (const b of ctx.backfill) {
      const cur = mealMap.get(b.recipeCode) ?? { kg: 0, count: 0, hasCritical: false };
      cur.kg += b.missingKg;
      cur.count++;
      if (b.priority === "critical") cur.hasCritical = true;
      mealMap.set(b.recipeCode, cur);
    }
    const lines = [`Backfill-Bedarf: ${ctx.backfill.length} WOs · ${total.toFixed(1)} kg gesamt | ${critical} kritisch | ${behind} hinter Plan`];
    for (const [code, info] of [...mealMap.entries()].sort((a, b) => b[1].kg - a[1].kg).slice(0, 6)) {
      lines.push(`${info.hasCritical ? "⚠" : "○"} ${code}: ${info.count} WOs · ${info.kg.toFixed(1)} kg`);
    }
    return lines.join("\n");
  }

  // Fertige WOs
  if (q.includes("fertig") || q.includes("abgeschlossen") || q.includes("done") || q.includes("komplett")) {
    const done = ctx.matched.filter(m => m.isComplete);
    const pct = ctx.matched.length > 0 ? (done.length / ctx.matched.length * 100).toFixed(0) : "0";
    if (done.length === 0) return "Noch keine Work Orders abgeschlossen.";
    const lines = [`${done.length} von ${ctx.matched.length} WOs fertig (${pct}%)`];
    done.slice(-4).reverse().forEach(w => lines.push(`✓ ${w.workOrder}: "${w.subRecipe}"`));
    return lines.join("\n");
  }

  // Runs-Übersicht
  if (q === "runs" || q === "alle runs" || q === "run übersicht") {
    const runMap = new Map<number, { total: number; done: number; critical: number; kg: number; plannedKg: number }>();
    for (const m of ctx.matched) {
      const r = m.run ?? 1;
      const cur = runMap.get(r) ?? { total: 0, done: 0, critical: 0, kg: 0, plannedKg: 0 };
      cur.total++;
      if (m.isComplete) cur.done++;
      if (m.isCritical) cur.critical++;
      cur.kg += m.actualKg;
      cur.plannedKg += m.plannedKg;
      runMap.set(r, cur);
    }
    if (runMap.size === 0) return "Keine Run-Daten verfügbar.";
    const lines = [`Run-Übersicht (${runMap.size} Runs):`];
    for (const [r, s] of [...runMap.entries()].sort(([a], [b]) => a - b)) {
      const pct = s.plannedKg > 0 ? (s.kg / s.plannedKg * 100).toFixed(0) : "?";
      const flag = s.done === s.total ? "✓" : s.critical > 0 ? "⚠" : "○";
      lines.push(`${flag} Run ${r}: ${s.done}/${s.total} WOs · ${pct}% · ${s.kg.toFixed(1)}/${s.plannedKg.toFixed(1)} kg${s.critical > 0 ? ` · ${s.critical} KRITISCH` : ""}`);
    }
    return lines.join("\n");
  }

  // Spezifischer Run: "run 1", "run 2"
  const runNumMatch = /^run\s*(\d+)$/.exec(q) || /\brun\s+(\d+)\b/.exec(q);
  if (runNumMatch && q !== "runs") {
    const runNum = parseInt(runNumMatch[1], 10);
    const runWos = ctx.matched.filter(m => (m.run ?? 1) === runNum);
    if (runWos.length === 0) return `Run ${runNum} nicht gefunden. Tippe 'runs' für eine Übersicht.`;
    const done = runWos.filter(w => w.isComplete).length;
    const critical = runWos.filter(w => w.isCritical);
    const totalKg = runWos.reduce((s, w) => s + w.actualKg, 0);
    const plannedKg = runWos.reduce((s, w) => s + w.plannedKg, 0);
    const pct = plannedKg > 0 ? (totalKg / plannedKg * 100).toFixed(0) : "?";
    const lines = [
      `Run ${runNum}: ${done}/${runWos.length} WOs fertig · ${pct}% · ${totalKg.toFixed(1)}/${plannedKg.toFixed(1)} kg`,
    ];
    if (critical.length > 0) lines.push(`Kritisch: ${critical.slice(0, 3).map(w => `${w.workOrder} "${w.subRecipe}"`).join(" | ")}`);
    const open = runWos.filter(w => !w.isComplete && !w.isCritical).slice(0, 4);
    if (open.length > 0) lines.push("Laufend: " + open.map(w => `${w.workOrder} ${w.progressPct.toFixed(0)}%`).join(" | "));
    return lines.join("\n");
  }

  // Als nächstes / Priorität
  if (q.includes("als nächstes") || q.includes("nächste") || q === "zuerst" || q === "priorität" || q.includes("was zuerst")) {
    const critical = ctx.backfill.filter(b => b.priority === "critical").slice(0, 4);
    const behind = ctx.backfill.filter(b => b.priority === "behind").slice(0, 3);
    if (critical.length === 0 && behind.length === 0) return "✓ Alles im Plan — kein dringender Handlungsbedarf!";
    const lines = ["Sofort starten:"];
    critical.forEach(b => lines.push(`→ ${b.workOrder} "${b.subRecipe}" (−${b.missingKg.toFixed(1)} kg KRITISCH)`));
    if (behind.length > 0) {
      lines.push("Danach:");
      behind.forEach(b => lines.push(`→ ${b.workOrder} "${b.subRecipe}" (−${b.missingKg.toFixed(1)} kg)`));
    }
    return lines.join("\n");
  }

  // Meals-Liste
  if (q === "meals" || q === "meal liste" || q.includes("alle meals") || q === "welche meals") {
    if (ctx.meals.length === 0) return "Keine Meals im Produktionsplan.";
    const lines = [`${ctx.meals.length} Meals:`];
    ctx.meals.forEach(m => {
      const flag = m.criticalWOs.length > 0 ? "⚠" : m.completedWOs === m.totalWOs ? "✓" : "○";
      lines.push(`${flag} ${m.recipeCode}: ${m.progressPct.toFixed(0)}% · ${m.completedWOs}/${m.totalWOs} WOs`);
    });
    return lines.join("\n");
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
