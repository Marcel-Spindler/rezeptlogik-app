// Backfill-Wächter – reine Nachbildung des RTI-Plating-Tracker-Rechners
// (Tab "RTI", gid=1486350915), pro Sub-Rezept. Keine Hooks/State hier.
//
// Rechenweg (an Live-KW38 gegen 11 Meal-Blöcke verifiziert):
//   gap (Meal)            = Planned Target − Actuals            (positiv = fehlt)
//   je Sub-Rezept:
//     availableMealcount  = wie viele Meals aus dem Plating-Holding noch
//                           platierbar sind (Spalte F, liest das Sheet selbst)
//     minimumNeed (|G|)   = gap − availableMealcount            (Spalte G = F − gap)
//                           > 0  ⇒ dieses Sub-Rezept ist der Engpass, muss
//                                  nachgekocht werden
//     bufferedNeed (|I|)  = minimumNeed × (1 + |G/PlannedTarget|)  (Spalte I)
//                           Sheet-Empfehlung mit prozentualem Sicherheitspuffer
//
// Spalten D–I können LEER sein, obwohl F/G/I anderswo schon berechnet wurden
// (Import). Deshalb: G bzw. I direkt nehmen, wann immer vorhanden — nicht auf D
// warten. Ist NUR der Meal-Rückstand (gap) bekannt und pro Sub nichts, gilt der
// Bedarf als `basis: "gap-only"` (grobe Schätzung, im Sheet noch nicht erfasst).
//
// Status (Spalte J): "done" = ins System eingetragen (erledigt, raus aus der
// offenen Liste) · leer = offen, noch nachzutragen · "no" = Veto (kein Backfill).
import type { RtiData, RtiMealBlock, RtiSubRecipeEntry } from "../gsheet-monitor/gsheetTypes";
import { codeDigits } from "../../lib/helpers";

// Ein Sub-Bedarf zählt erst ab dieser Schwelle als echter Engpass (Rauschfilter
// gegen minimale Zähl-/Rundungsabweichungen — identisch zu MIN_RTI_SHORTFALL).
export const MIN_SUB_SHORTFALL = 30;

export type RtiShortfallBasis = "sheet" | "gap-only";

// Ersatz-Kopfzahlen aus App-Daten (Forecast / Redzone / LinePlaiting), wenn
// Marcel Planned Target / Actuals im RTI-Sheet-Kopf noch nicht eingetragen hat.
// Key = codeDigits(mealCode) (4-stellig). Siehe buildRtiExternalTargets.ts.
export interface RtiExternalTarget {
  plannedTarget: number;
  actuals: number;
  /** Menschenlesbare Herkunft, z.B. "Forecast + Redzone". */
  source: string;
}

// Sheet-Kopf gewinnt immer; ein externer Wert wird nur für die FEHLENDE Zahl
// eingesetzt und nur, wenn er in sich plausibel ist (Ist ≤ Ziel + Puffer).
function usableExternalTarget(ext: RtiExternalTarget | undefined): ext is RtiExternalTarget {
  return !!ext && ext.plannedTarget > 0 && ext.actuals >= 0 && ext.actuals <= ext.plannedTarget * 1.15;
}

export interface RtiSubShortfall {
  workOrder: string;
  subRecipeName: string;
  /** Spalte D – beim Zurückwiegen erfasste kg (kann 0/leer sein, obwohl gerechnet). */
  weighedKg: number;
  /** Spalte E – Gramm dieses Sub-Rezepts pro Portion (für kg→Portionen-Umrechnung). */
  gramPerMeal: number;
  /** Spalte F – wie viele Meals sich mit dem Holding-Rest noch platieren lassen. */
  availableMealcount: number;
  /** |Spalte G| – harter Mindestbedarf: so viele Portionen fehlen wirklich. */
  minimumNeed: number;
  /** |Spalte I| – Sheet-Empfehlung inkl. prozentualem Sicherheitspuffer. */
  bufferedNeed: number;
  /** |Spalte H| – Fehlmenge in % vom Planned Target. */
  shortagePct: number;
  /** "sheet" = G/I standen im Sheet · "gap-only" = nur aus dem Meal-Rückstand geschätzt. */
  basis: RtiShortfallBasis;
  /** Spalte J roh: "done" | "" | "no" (schon nach Bucket sortiert, hier nur Info). */
  status: RtiSubRecipeEntry["status"];
}

export interface RtiMealBackfill {
  mealCode: string;
  mealName: string;
  plannedTarget: number;
  actuals: number;
  /** Planned Target − Actuals (positiv = fehlende Portionen). */
  gap: number;
  /** OFFENE Engpässe: Status leer, noch ins System einzutragen. Die Aktionsliste. */
  openSubs: RtiSubShortfall[];
  /** Status "done" = schon ins System eingetragen. Nur noch zur Kontrolle. */
  enteredSubs: RtiSubShortfall[];
  /** Status "no" = ausdrücklich kein Backfill. */
  notNeededSubs: RtiSubShortfall[];
  /** Größter Mindestbedarf über openSubs (≈ gap). 0 = nichts offen. */
  recommendedMin: number;
  /** Größte gepufferte Empfehlung über openSubs. */
  recommendedBuffered: number;
  /** true = war kurz, alle Engpässe sind jetzt eingetragen (Status "done"). */
  allEntered: boolean;
  /** true = irgendein Sub dieses Meals hat schon D oder Status → Wiegung läuft. */
  weighingStarted: boolean;
  /** true = mind. ein offener Sub ist nur "gap-only" geschätzt (Sheet unvollständig). */
  hasGapOnly: boolean;
  /** true = es wird schon gewogen, aber Planned Target / Actuals fehlen im
   *  RTI-Sheet-Kopf UND ließen sich auch nicht aus App-Daten herleiten → gap
   *  nicht rechenbar. openSubs ist leer, nur ein Hinweis. */
  headerIncomplete: boolean;
  /** "sheet" = plannedTarget/actuals kamen aus dem RTI-Sheet-Kopf ·
   *  "app" = eine oder beide Zahlen aus App-Daten ergänzt (targetEstimated). */
  targetSource: "sheet" | "app";
  /** true = plannedTarget und/oder actuals stammen aus App-Daten statt aus dem
   *  RTI-Sheet-Kopf (Forecast/Redzone/LinePlaiting). Anzeige als „geschätzt". */
  targetEstimated: boolean;
  /** Herkunft der ergänzten Kopfzahlen, wenn targetEstimated (sonst ""). */
  targetSourceLabel: string;
  /** Namen der im RTI-Sheet bereits als eigene WO angelegten Backfill-Slots. */
  candidateSubNames: string[];
}

function num(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

interface Classified extends RtiSubShortfall {
  vetoed: boolean;
}

function classify(sub: RtiSubRecipeEntry, gap: number, plannedTarget: number): Classified | null {
  const weighedKg = num(sub.weighedKg);
  const sheetG = num(sub.minimumNeed);
  const sheetI = num(sub.backfillMeals);

  // "Availble Mealcount" (Spalte F): bevorzugt direkt aus dem Sheet (teils
  // Live-Import); fehlt die Zelle, aus (Holding + zurückgewogen) ÷ g/Meal
  // nachrechnen — sonst würde ein Sub mit vollem Rack fälschlich als Engpass
  // gelten, nur weil F noch nicht befüllt ist.
  const sheetAvail = num(sub.availableMealcount);
  const derivedAvail = sub.gramPerMeal > 0
    ? ((num(sub.platingHoldingKg) + weighedKg) / sub.gramPerMeal) * 1000
    : 0;
  const availableMealcount = Math.max(0, Math.round(sheetAvail !== 0 ? sheetAvail : derivedAvail));

  // Basis: hat das Sheet für dieses Sub überhaupt eine eigene Zahl (G/I/F/D)?
  const hasSheetNumber = sheetG !== 0 || sheetI !== 0 || sheetAvail !== 0 || weighedKg !== 0;
  const basis: RtiShortfallBasis = hasSheetNumber ? "sheet" : "gap-only";

  // Minimum need (Spalte G, negativ = Engpass): bevorzugt aus dem Sheet, sonst F − gap.
  const g = sheetG !== 0 ? sheetG : availableMealcount - gap;
  const minimumNeed = Math.max(0, -Math.round(g));
  if (minimumNeed < MIN_SUB_SHORTFALL) return null;

  // Backfill Meals (Spalte I) = G × (1 + |H|). Die H-Zelle im Sheet referenziert
  // bei manchen Zeilen leere Felder und läuft auf −1000 %+ → dann ist auch I
  // Unfug. Nur plausible Werte übernehmen (|H| ≤ 1, I ≤ 2× Mindestbedarf),
  // sonst mit dem korrekten Prozentsatz (G / Planned Target) nachrechnen.
  const validPct = plannedTarget > 0 ? Math.min(1, minimumNeed / plannedTarget) : 0;
  const sheetPct = Math.abs(sub.shortagePct) / 100;
  const pct = sheetPct > 0 && sheetPct <= 1 ? sheetPct : validPct;
  const computedBuffer = Math.round(minimumNeed * (1 + pct));
  const sheetIabs = Math.max(0, -Math.round(sheetI));
  const bufferedNeed = sheetIabs > 0 && sheetIabs <= minimumNeed * 2 + 5 ? sheetIabs : computedBuffer;

  return {
    workOrder: sub.workOrder,
    subRecipeName: sub.subRecipeName,
    weighedKg,
    gramPerMeal: Math.max(0, num(sub.gramPerMeal)),
    availableMealcount,
    minimumNeed,
    bufferedNeed: Math.max(minimumNeed, bufferedNeed),
    shortagePct: pct * 100,
    basis,
    status: sub.status,
    vetoed: sub.status === "not-needed",
  };
}

/**
 * Wertet jeden Meal-Block des RTI-Tabs aus und liefert die Sub-Rezept-Engpässe.
 * Nur Meals mit mindestens einem Engpass-Sub kommen in die Liste — ein Meal,
 * dessen gesamter Rückstand aus dem Holding gedeckt ist, braucht keinen Backfill.
 *
 * `externalTargets` (optional): Ersatz-Kopfzahlen aus App-Daten je 4-Ziffer-Code.
 * Fehlt im Sheet-Kopf Planned Target ODER Actuals, wird die fehlende Zahl daraus
 * ergänzt (Sheet gewinnt immer) und das Meal als `targetEstimated` markiert —
 * statt nur den „bitte eintragen"-Hinweis zu werfen.
 */
export function computeRtiBackfills(
  rti: RtiData | null | undefined,
  externalTargets?: Map<string, RtiExternalTarget>,
): RtiMealBackfill[] {
  // Mehrere Blöcke je Meal-Code (echte Wiegung + leere Prep-/Zweitrun-Blöcke,
  // teils unter Code-Varianten) — den mit dem größten Planned Target behalten.
  const bestByKey = new Map<string, RtiMealBlock>();
  for (const meal of rti?.meals ?? []) {
    const key = codeDigits(meal.mealCode).toUpperCase();
    const cur = bestByKey.get(key);
    if (!cur || meal.plannedTarget > cur.plannedTarget) bestByKey.set(key, meal);
  }

  const emptyMeal = (meal: RtiMealBlock, headerIncomplete: boolean, weighingStarted: boolean): RtiMealBackfill => ({
    mealCode: meal.mealCode, mealName: meal.mealName,
    plannedTarget: meal.plannedTarget, actuals: meal.actuals, gap: 0,
    openSubs: [], enteredSubs: [], notNeededSubs: [],
    recommendedMin: 0, recommendedBuffered: 0, allEntered: false,
    weighingStarted, hasGapOnly: false, headerIncomplete,
    targetSource: "sheet", targetEstimated: false, targetSourceLabel: "",
    candidateSubNames: [],
  });

  const out: RtiMealBackfill[] = [];
  for (const meal of bestByKey.values()) {
    const realSubs = meal.subRecipes.filter(s => !s.isBackfillCandidate);
    if (realSubs.length === 0) continue;
    const weighingStarted = realSubs.some(s => num(s.weighedKg) !== 0 || s.status !== "open");
    // Echte Zurückwiegung dieses Meals (Rack kam zurück). Erst dann ist der
    // App-Daten-Fallback sinnvoll — sonst gälte früh in der Woche jedes Meal mit
    // Forecast > Redzone-Output als „Backfill nötig".
    const someWeighed = realSubs.some(s => num(s.weighedKg) > 0);

    // Kopfzahlen: der Sheet-Eintrag gewinnt, fehlt einer → aus App-Daten
    // (externalTargets) ergänzen. Nur die tatsächlich fehlende Zahl wird ersetzt,
    // und nur wenn dieses Meal schon zurückgewogen wird.
    let plannedTarget = num(meal.plannedTarget);
    let actuals = num(meal.actuals);
    let targetEstimated = false;
    let targetSourceLabel = "";
    if ((plannedTarget <= 0 || actuals <= 0) && someWeighed) {
      const ext = externalTargets?.get(codeDigits(meal.mealCode).toUpperCase());
      if (usableExternalTarget(ext)) {
        if (plannedTarget <= 0) plannedTarget = ext.plannedTarget;
        if (actuals <= 0) actuals = ext.actuals;
        targetEstimated = true;
        targetSourceLabel = ext.source;
      }
    }

    // Immer noch keine rechenbaren Kopfzahlen. Wird schon gewogen (mind. ein
    // echtes Sub hat kg) und nicht alle Subs auf "no" → EIN Hinweis.
    if (plannedTarget <= 0 || actuals <= 0) {
      const allNo = realSubs.every(s => s.status === "not-needed");
      if (someWeighed && !allNo) out.push(emptyMeal(meal, true, weighingStarted));
      continue;
    }
    const gap = Math.round(plannedTarget - actuals);
    if (gap < MIN_SUB_SHORTFALL) continue;

    const openSubs: RtiSubShortfall[] = [];
    const enteredSubs: RtiSubShortfall[] = [];
    const notNeededSubs: RtiSubShortfall[] = [];
    const candidateSubNames = new Set<string>();

    for (const sub of meal.subRecipes) {
      if (sub.isBackfillCandidate) { candidateSubNames.add(sub.subRecipeName); continue; }
      const c = classify(sub, gap, plannedTarget);
      if (!c) continue;
      const { vetoed, ...shortfall } = c;
      if (vetoed) notNeededSubs.push(shortfall);
      else if (shortfall.status === "done") enteredSubs.push(shortfall);
      else openSubs.push(shortfall);
    }

    if (openSubs.length === 0 && enteredSubs.length === 0 && notNeededSubs.length === 0) continue;

    const recommendedMin = openSubs.reduce((m, s) => Math.max(m, s.minimumNeed), 0);
    const recommendedBuffered = openSubs.reduce((m, s) => Math.max(m, s.bufferedNeed), 0);

    // Nur die vorbereiteten Backfill-WOs zeigen, die zu einem echten Engpass
    // gehören — das Sheet legt oft für ALLE Subs Slot-Zeilen an.
    const shortNames = new Set([...openSubs, ...enteredSubs].map(s => s.subRecipeName));

    out.push({
      mealCode: meal.mealCode,
      mealName: meal.mealName,
      plannedTarget,
      actuals,
      gap,
      openSubs,
      enteredSubs,
      notNeededSubs,
      recommendedMin,
      recommendedBuffered,
      allEntered: openSubs.length === 0 && enteredSubs.length > 0,
      weighingStarted,
      hasGapOnly: openSubs.some(s => s.basis === "gap-only"),
      headerIncomplete: false,
      targetSource: targetEstimated ? "app" : "sheet",
      targetEstimated,
      targetSourceLabel,
      candidateSubNames: [...candidateSubNames].filter(n => shortNames.has(n)),
    });
  }

  // Meals mit offenem Bedarf zuerst, dann nach Mindestbedarf absteigend
  out.sort((a, b) =>
    (b.openSubs.length > 0 ? 1 : 0) - (a.openSubs.length > 0 ? 1 : 0) ||
    b.recommendedMin - a.recommendedMin,
  );
  return out;
}
