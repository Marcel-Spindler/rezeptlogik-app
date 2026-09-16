// Tagesbriefing – Pure Berechnungen für das 15:30-Meeting.
import type { DataBundle } from "../../core/types";
import type { MealProgress } from "../gsheet-monitor/postblastMatch";
import type { BackfillAlert, BackfillFeasibility, CombinedBackfillNeed } from "../backfills/backfillTypes";
import type { RtiMealBackfill } from "../backfills/rtiBackfillCalculator";
import type { KetRow } from "../ket-plan/ketTypes";
import type { TransparencyProducibilityResult } from "../gsheet-monitor/transparencyTypes";
import type { RecipeWeightLookup } from "../gsheet-monitor/parsers/parseExportRecipes";
import { honestMealProgress, mealReadiness } from "../gsheet-monitor/mealProgress";
import { platedForMeal, mealCodeKey } from "../gsheet-monitor/plateableNet";
import { resolveStructureByCode } from "../../lib/helpers";
import { getStructureForRecipe } from "../whatif/whatIfAggregate";
import { parseDateShift } from "../ket-plan/ketLogic";

// ── Helpers ─────────────────────────────────────────────────────────────────

// Zweischicht-Modell (ab KW39, siehe ketRunLogic.ts): dieselbe Schicht-Ziffer
// hinter "Date Needed" ("2026-09-16 - 1"), über den kanonischen Parser statt
// einer eigenen Regex, damit Tagesbriefing/KET-Plan/Kochplan garantiert
// dieselbe Schicht für dieselbe Zeile sehen.
export const SHIFT_LABEL_SHORT: Record<string, string> = { "1": "Früh", "2": "Spät" };

function localIso(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDateDE(iso: string): string {
  try { return new Date(iso + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }); } catch { return iso; }
}
function fmtMhd(iso: string | null): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }); } catch { return ""; }
}

// ── Result types ────────────────────────────────────────────────────────────

export type WoLocation = "Staging" | "Kitchen" | "Post-Blast" | "Fertig" | "Warte" | "unbekannt";

export interface KetWoRow {
  woNumber: string;
  recipeCode: string;
  recipeName: string;
  subRecipeName: string;
  shift: string;
  targetPortions: number;
  cookedPortions: number;
  cookedPct: number;
  stagingStatus: string;
  kitchenStatus: string;
  location: WoLocation;
  comment: string;
}

// Eine Gruppe = EIN Tag × EINE Schicht (Zweischicht-Modell ab KW39) — nicht
// mehr der ganze Tag in einem Block. "shift" leer = Zeile ohne erkennbare
// Schicht (älteres Einschicht-Layout/kein Suffix in "Date Needed").
export interface KetDayGroup {
  date: string;
  shift: string;
  dateLabel: string;
  isToday: boolean;
  isTomorrow: boolean;
  rows: KetWoRow[];
  totalTarget: number;
  totalCooked: number;
  cookedPct: number;
}

// Tages-Fokus: der Bericht ist für die 15:30-Runde HEUTE, mit Blick auf morgen
// — kein Wochen-Dashboard. "unbekannt" = KET-Plan liefert (noch) gar keine
// Tagesinfo (nicht verbunden) → dann NICHT filtern, sonst verschwindet bei
// fehlender KET-Verbindung plötzlich der ganze Meal-/Kritisch-Teil, obwohl
// Postblast/RTI/Transparency vielleicht längst live sind.
// "plating" = kein Küchen-WO heute/morgen, aber JETZT plaitierbar/plaitiert —
// Plaitieren läuft nicht nach demselben Kalender wie die Küchen-WOs (eine
// Komponente kann Tage vorher fertig gekocht sein und heute erst plaitiert
// werden). Live beobachtet: "Plating 0/62.409", obwohl am Tag längst plaitiert
// wurde — weil das betroffene Meal keinen Küchen-WO heute/morgen hatte und
// deshalb komplett aus der Liste flog.
export type DayScope = "heute" | "morgen" | "beide" | "unbekannt" | "plating";

export interface MealPlatingStatus {
  recipeCode: string;
  recipeName: string;
  plannedMeals: number;
  platedPortions: number;
  platingPct: number;
  producibility: "ready" | "partial" | "blocked" | "unknown";
  productionPct: number;
  completedWOs: number;
  totalWOs: number;
  bottleneckSub: string | null;
  dayScope: DayScope;
}

export interface BackfillWatchItem {
  mealCode: string;
  mealName: string;
  gap: number;
  openSubs: { subRecipeName: string; minimumNeed: number; bufferedNeed: number }[];
  recommendedMin: number;
}

// Ein Eintrag in der "Was ist JETZT faul"-Liste ganz oben im Briefing — bündelt
// drei unabhängige, bereits an anderer Stelle berechnete Signale (Produzierbarkeit,
// quellenübergreifender Backfill-Alert, Küche ohne Gewicht) zu EINER sortierten
// Liste, statt dass der Leser sie über drei Sektionen verteilt selbst zusammensuchen muss.
export interface CriticalItem {
  recipeCode: string;
  recipeName: string;
  severity: "critical" | "warning";
  source: "producibility" | "backfill" | "kitchen" | "feasibility";
  sourceLabel: string;
  message: string;
  dayScope: DayScope;
}

// "Was soll geplaitet werden" — Netto-plaitierbar je Meal (Brutto-produziert
// minus schon plaitiert, siehe mealReadiness/netPlateable in mealProgress.ts /
// plateableNet.ts — dieselbe Rechnung wie im Plating Dashboard).
export interface PlatingTodoItem {
  recipeCode: string;
  recipeName: string;
  netMeals: number;   // sofort plaitierbar, noch NICHT plaitiert — die Handlungszahl
  grossMeals: number;  // insgesamt bisher produziert (Brutto, ganze KW)
  platedMeals: number; // schon plaitiert (LinePlaiting ⊕ Redzone)
  dayScope: DayScope;
}

// Konkrete WO-Nummern hinter den Kritisch-Meldungen — "welche WOs genau sind
// gefährdet", nicht nur "dieses Meal hat ein Problem". EIN Eintrag PRO MEAL
// (nicht pro WO): ein Backfill-/Produzierbarkeits-Grund betrifft typischerweise
// alle Sub-Rezept-WOs desselben Meals gleichzeitig — ohne Gruppierung stand
// derselbe lange Absatz 6× identisch untereinander (live beobachtet bei einem
// Meal mit 6 offenen Sub-Rezept-WOs). Alle betroffenen WO-Nummern werden hier
// gesammelt, jeder Grund nur einmal genannt.
export interface AtRiskWo {
  recipeCode: string;
  recipeName: string;
  isToday: boolean;
  dayLabel: string;
  woNumbers: string[];
  targetPortions: number;
  cookedPortions: number;
  reasons: string[];
}

// "Was muss morgen zuerst angefasst werden" — Kritisches zuerst, danach die
// größten Ansätze (brauchen am meisten Vorlauf).
export interface TomorrowPriorityWo {
  woNumber: string;
  recipeCode: string;
  recipeName: string;
  subRecipeName: string;
  targetPortions: number;
  reason: string;
}

// Küche: die konkrete Zahl aus dem wöchentlichen Staffing/Hiring-BP-Sheet
// ("Headcount - Required" → Kitchen, laufende KW) — fällt auf dieselbe
// Sub-Rezepte+1-Schätzung wie Plating zurück, wenn das Sheet nicht verbunden
// ist, damit die Kachel nicht einfach leer bleibt.
// Plating: Marcels Faustregel — Anzahl Sub-Rezepte der tatsächlich zu
// plaitierenden Meals (aus der Rezeptstruktur, nicht aus den KET-Zeilen) + 1
// Lead/Springer. 0 = nichts offen (keine Schätzung möglich).
export type StaffingSource = "plan" | "estimate" | "none";
export interface StaffingEstimate {
  kitchen: number;
  kitchenSource: StaffingSource;
  kitchenComponents: number;
  plating: number;
  platingComponents: number;
}

export interface BriefingSummary {
  totalMeals: number;
  mealsReady: number;
  mealsBlocked: number;
  platingPct: number;
  totalPlated: number;
  totalPlannedPortions: number;
  productionPct: number;
  backfillMeals: number;
  totalBackfillPortions: number;
  todayWos: number;
  todayCooked: number;
  todayCookedPct: number;
  tomorrowWos: number;
  criticalCount: number;
}

export interface DailyBriefing {
  generatedAt: string;
  currentWeek: string;
  ketDays: KetDayGroup[];
  mealPlating: MealPlatingStatus[];
  backfillWatch: BackfillWatchItem[];
  backfillAlerts: BackfillAlert[];
  criticalItems: CriticalItem[];
  platingTodo: PlatingTodoItem[];
  atRiskWos: AtRiskWo[];
  tomorrowPriority: TomorrowPriorityWo[];
  staffing: StaffingEstimate;
  deadlines: { activity: string; time: string; owner?: string }[];
  deadlinesTomorrow: { activity: string; time: string; owner?: string }[];
  summary: BriefingSummary;
  copyText: string;
}

// ── KET rows → day groups ───────────────────────────────────────────────────

// Menge schlägt Status-Text: "Kitchen/Staging Status" kennt in der Praxis GAR
// KEIN "Done"/"Fertig" (echte Werte laut statusColors() in ketLogic.ts: Kitchen
// = "Not Started"/"Pre Blast"/"Post Blast", Staging = "Open"/"Picking"/
// "Partially Staged"/"Staged"/"Released") — "Fertig" war über den Text also
// NIE erreichbar, das WO-Tableau zeigte deshalb live immer "0 fertig", egal
// wie hoch cookedPct stand. Tatsächlich gekochte Menge ist die verlässliche
// Quelle — gleicher 95%-Schwellwert wie WoMatchedStatus.isComplete in
// postblastMatch.ts.
function woLocation(row: KetRow): WoLocation {
  const cooked = row.woCookedPortions ?? 0;
  if (row.targetPortions > 0 && cooked >= row.targetPortions * 0.95) return "Fertig";

  const ks = (row.kitchenStatus ?? "").toLowerCase().trim();
  const ss = (row.stagingStatus ?? "").toLowerCase().trim();
  // "Pre Blast" enthält ebenfalls "blast" — explizit auf "post blast" prüfen,
  // sonst würde "Pre Blast" (noch mitten in der Küche) fälschlich als
  // Post-Blast (kurz vor fertig) durchgehen.
  if (ks.includes("post blast") || ks.includes("chiller")) return "Post-Blast";
  if (ks.includes("pre blast") || cooked > 0) return "Kitchen";
  if (ss !== "" && ss !== "open" && ss !== "offen" && ss !== "not started") return "Staging";
  return "Warte";
}

function buildKetDays(ketRows: KetRow[]): KetDayGroup[] {
  const today = localIso(0);
  const tomorrow = localIso(1);
  const byKey = new Map<string, { date: string; shift: string; rows: KetWoRow[] }>();

  for (const r of ketRows) {
    const { date, shift } = parseDateShift(r.dateNeeded);
    const cooked = r.woCookedPortions ?? 0;
    const row: KetWoRow = {
      woNumber: r.woNumber,
      recipeCode: r.recipeCode,
      recipeName: r.recipeName,
      subRecipeName: r.subRecipeName,
      shift: shift || r.shift,
      targetPortions: r.targetPortions,
      cookedPortions: cooked,
      cookedPct: r.targetPortions > 0 ? Math.min(100, (cooked / r.targetPortions) * 100) : 0,
      stagingStatus: r.stagingStatus,
      kitchenStatus: r.kitchenStatus,
      location: woLocation(r),
      comment: r.workOrderComment || r.stagingComment || "",
    };
    const key = `${date}__${shift}`;
    const g = byKey.get(key) ?? { date, shift, rows: [] };
    g.rows.push(row);
    byKey.set(key, g);
  }

  // Sort: location priority within each day×Schicht-Gruppe
  const locOrder: Record<WoLocation, number> = { Warte: 0, Staging: 1, Kitchen: 2, "Post-Blast": 3, Fertig: 4, unbekannt: 5 };

  return [...byKey.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.shift.localeCompare(b.shift))
    .map(({ date, shift, rows }) => {
      rows.sort((a, b) => locOrder[a.location] - locOrder[b.location] || a.woNumber.localeCompare(b.woNumber));
      const totalTarget = rows.reduce((s, r) => s + r.targetPortions, 0);
      const totalCooked = rows.reduce((s, r) => s + r.cookedPortions, 0);
      const dayName = date === today ? "Heute" : date === tomorrow ? "Morgen" : fmtDateDE(date);
      const shiftName = SHIFT_LABEL_SHORT[shift];
      return {
        date,
        shift,
        dateLabel: `${dayName}${shiftName ? ` · ${shiftName}` : ""} (${fmtDateDE(date)})`,
        isToday: date === today,
        isTomorrow: date === tomorrow,
        rows,
        totalTarget,
        totalCooked,
        cookedPct: totalTarget > 0 ? Math.round((totalCooked / totalTarget) * 100) : 0,
      };
    });
}

// ── Tages-Fokus: heute + morgen ──────────────────────────────────────────────
// Meal-Identität wird über die 4-stellige Code-Digit-Identität abgeglichen
// (mealCodeKey — wie überall sonst im Code: FV4063A/FV4063B etc. sind dasselbe
// Meal, KET/Postblast/RTI/LinePlating benutzen teils unterschiedliche
// Varianten-Buchstaben, siehe plateableNet.ts).
// hasKetData unterscheidet "KET-Plan nicht verbunden" (todayCodes/tomorrowCodes
// zwangsläufig leer, aber NICHT filtern — siehe dayScopeFor: "unbekannt") von
// "KET IST verbunden, aber für heute/morgen steht dort nichts von diesem Meal"
// (ECHT außerhalb des Fokus, also raus). Ohne diese Unterscheidung würde ein
// Meal, dessen einzige WO erst später in der Woche liegt, fälschlich als
// "unbekannt" durchgewunken, sobald zufällig auch sonst nichts heute/morgen läuft.
interface DayScopeCtx {
  todayCodes: Set<string>;
  tomorrowCodes: Set<string>;
  hasKetData: boolean;
}

function buildDayScopeCtx(ketDays: KetDayGroup[], ketRows: KetRow[]): DayScopeCtx {
  const todayCodes = new Set<string>();
  const tomorrowCodes = new Set<string>();
  for (const day of ketDays) {
    if (!day.isToday && !day.isTomorrow) continue;
    const target = day.isToday ? todayCodes : tomorrowCodes;
    for (const r of day.rows) target.add(mealCodeKey(r.recipeCode));
  }
  return { todayCodes, tomorrowCodes, hasKetData: ketRows.length > 0 };
}

// null = weder heute noch morgen relevant → aus dem Tagesbriefing raus.
function dayScopeFor(recipeCode: string, ctx: DayScopeCtx): DayScope | null {
  if (!ctx.hasKetData) return "unbekannt";
  const key = mealCodeKey(recipeCode);
  const isToday = ctx.todayCodes.has(key);
  const isTomorrow = ctx.tomorrowCodes.has(key);
  if (isToday && isTomorrow) return "beide";
  if (isToday) return "heute";
  if (isTomorrow) return "morgen";
  return null;
}

// ── Meal plating with producibility ─────────────────────────────────────────

function buildMealPlating(
  meals: MealProgress[],
  plaitedByCode: Map<string, number>,
  producibility: TransparencyProducibilityResult | null,
  recipeWeights: RecipeWeightLookup | null,
  dayScopeCtx: DayScopeCtx,
): MealPlatingStatus[] {
  return meals
    .filter(m => m.plannedMeals > 0 || m.totalPlannedKg > 0 || m.totalActualKg > 0)
    .map(m => {
      const kitchenScope = dayScopeFor(m.recipeCode, dayScopeCtx);
      const plated = platedForMeal(plaitedByCode, m.recipeCode);
      // Küchen-WO-Kalender (heute/morgen) UND Plating-Relevanz (schon/noch zu
      // plaitieren) sind zwei unabhängige Kriterien — ein Meal fällt raus, nur
      // wenn KEINS von beiden zutrifft, siehe DayScope-Kommentar oben.
      const { net } = mealReadiness(m, recipeWeights, plaitedByCode);
      const platingRelevant = plated > 0 || (!!net && net.netMeals > 0);
      if (kitchenScope == null && !platingRelevant) return null;
      const dayScope: DayScope = kitchenScope ?? "plating";
      const { pct, bottleneckSub } = honestMealProgress(m);
      const platingPct = m.plannedMeals > 0 ? Math.min(100, (plated / m.plannedMeals) * 100) : 0;
      const prod = producibility?.byRecipeCode.get(m.recipeCode);
      const status: MealPlatingStatus = {
        recipeCode: m.recipeCode,
        recipeName: m.recipeName,
        plannedMeals: m.plannedMeals,
        platedPortions: plated,
        platingPct,
        producibility: prod?.status ?? ("unknown" as const),
        productionPct: pct,
        completedWOs: m.completedWOs,
        totalWOs: m.totalWOs,
        bottleneckSub,
        dayScope,
      };
      return status;
    })
    .filter((m): m is MealPlatingStatus => m !== null)
    .sort((a, b) => {
      const p = { blocked: 0, partial: 1, unknown: 2, ready: 3 };
      return (p[a.producibility] ?? 2) - (p[b.producibility] ?? 2) || a.platingPct - b.platingPct;
    });
}

// ── Backfill watcher ────────────────────────────────────────────────────────

function buildBackfillWatch(rtiMeals: RtiMealBackfill[], dayScopeCtx: DayScopeCtx): BackfillWatchItem[] {
  return rtiMeals
    .filter(m => m.openSubs.length > 0 && !m.allEntered)
    .filter(m => dayScopeFor(m.mealCode, dayScopeCtx) != null)
    .map(m => ({
      mealCode: m.mealCode,
      mealName: m.mealName,
      gap: m.gap,
      openSubs: m.openSubs.map(s => ({ subRecipeName: s.subRecipeName, minimumNeed: s.minimumNeed, bufferedNeed: s.bufferedNeed })),
      recommendedMin: m.recommendedMin,
    }))
    .sort((a, b) => b.recommendedMin - a.recommendedMin);
}

// ── Kritisch JETZT — drei unabhängige Signale zusammengeführt ───────────────
// Der alte Stand hing die "was ist faul"-Aussage komplett an die Transparency-
// Producibility (braucht 4 lebende GSheet-Tabs gleichzeitig). Fehlt EINE davon,
// blieb die Liste leer, obwohl z.B. Postblast längst ein kritisches Küchen-
// Defizit zeigt. Deshalb hier zusätzlich das robustere, immer schon berechnete
// Signal "Küche hat trotz Plan nichts gewogen" (MealProgress.criticalWOs, siehe
// postblastMatch.ts) und die app-weiten Cross-Source-Alerts (combineBackfills.ts)
// einbeziehen — beide brauchen nur Postblast bzw. Postblast/RTI/LinePlating,
// nicht alle Quellen gleichzeitig.
// Ein Backfill-Bedarf (siehe oben, source "backfill") sagt nur "es fehlt noch
// was". Ob die Küche das heute überhaupt NACHKOCHEN kann, hängt an der
// Rohware im Lager — genau das prüft computeBackfillFeasibility (Bestand ./.
// benötigte Menge je Zutat, siehe backfillFeasibility.ts). War bisher
// komplett berechnet, aber im Briefing nirgends sichtbar. Nur befüllt, wenn
// der lokale WMS-Server läuft (siehe fullInventoryConnected) — sonst leere Map.
function buildFeasibilityItems(
  feasibility: Map<string, BackfillFeasibility>,
  combined: CombinedBackfillNeed[],
  dayScopeCtx: DayScopeCtx,
): CriticalItem[] {
  const nameByCode = new Map(combined.map(c => [c.recipeCode, c.recipeName]));
  const items: CriticalItem[] = [];
  for (const f of feasibility.values()) {
    if (f.verdict !== "blocked" && f.verdict !== "partial") continue;
    const dayScope = dayScopeFor(f.recipeCode, dayScopeCtx);
    if (dayScope == null) continue;
    const bottleneck = f.bottleneck[0];
    const mhd = bottleneck ? fmtMhd(bottleneck.nearestExpiry) : "";
    // MHD nennen: entweder der Rest ist noch da, verfällt aber bald (mhd), oder
    // es liegt komplett abgelaufene Ware im Lager (expiredQty) — beides ist für
    // die Küche eine andere Handlung als "gar nichts da".
    const wareLabel = bottleneck
      ? mhd
        ? ` — Engpass: ${bottleneck.ingredientName} (Rest-Bestand MHD ${mhd})`
        : bottleneck.expiredQty > 0
          ? ` — Engpass: ${bottleneck.ingredientName} (${Math.round(bottleneck.expiredQty)} ${bottleneck.uom} auf Lager, aber MHD abgelaufen)`
          : ` — Engpass: ${bottleneck.ingredientName}`
      : "";
    const message = f.verdict === "blocked"
      ? `Rohware fehlt komplett${wareLabel} (0/${Math.round(f.neededPortions)} Portionen möglich)`
      : `Rohware reicht nur für ${Math.round(f.maxProduciblePortions)}/${Math.round(f.neededPortions)} Portionen (${Math.round(f.coveragePct * 100)}%)${wareLabel}`;
    items.push({
      recipeCode: f.recipeCode,
      recipeName: nameByCode.get(f.recipeCode) ?? f.recipeCode,
      severity: f.verdict === "blocked" ? "critical" : "warning",
      source: "feasibility",
      sourceLabel: "Rohware",
      message,
      dayScope,
    });
  }
  return items;
}

// mealPlating kommt hier schon Tages-gefiltert rein (buildMealPlating). Für die
// beiden anderen rohen Quellen (backfillAlerts/meals — beide unabhängig von KET
// berechnet) wird der Tages-Bezug hier zusätzlich geprüft.
function buildCriticalItems(
  mealPlating: MealPlatingStatus[],
  backfillAlerts: BackfillAlert[],
  meals: MealProgress[],
  feasibility: Map<string, BackfillFeasibility>,
  combined: CombinedBackfillNeed[],
  dayScopeCtx: DayScopeCtx,
): CriticalItem[] {
  const items: CriticalItem[] = [];

  for (const m of mealPlating) {
    if (m.producibility !== "blocked" && m.producibility !== "partial") continue;
    items.push({
      recipeCode: m.recipeCode,
      recipeName: m.recipeName,
      severity: m.producibility === "blocked" ? "critical" : "warning",
      source: "producibility",
      sourceLabel: "Produzierbarkeit",
      message: `Produktion ${m.productionPct.toFixed(0)}% · Plating ${m.platingPct.toFixed(0)}%${m.bottleneckSub ? ` — Engpass: ${m.bottleneckSub}` : ""}`,
      dayScope: m.dayScope,
    });
  }

  for (const a of backfillAlerts) {
    if (a.severity !== "critical" && a.severity !== "warning") continue;
    const dayScope = dayScopeFor(a.recipeCode, dayScopeCtx);
    if (dayScope == null) continue;
    items.push({
      recipeCode: a.recipeCode,
      recipeName: a.recipeName,
      severity: a.severity,
      source: "backfill",
      sourceLabel: "Backfill",
      message: a.message,
      dayScope,
    });
  }

  for (const meal of meals) {
    if (meal.criticalWOs.length === 0) continue;
    const dayScope = dayScopeFor(meal.recipeCode, dayScopeCtx);
    if (dayScope == null) continue;
    const woList = meal.criticalWOs.map(w => w.workOrder).slice(0, 4).join(", ");
    const more = meal.criticalWOs.length > 4 ? ` +${meal.criticalWOs.length - 4}` : "";
    items.push({
      recipeCode: meal.recipeCode,
      recipeName: meal.recipeName,
      severity: "critical",
      source: "kitchen",
      sourceLabel: "Küche",
      message: `${meal.criticalWOs.length} WO ohne Gewicht trotz Plan — ${woList}${more}`,
      dayScope,
    });
  }

  items.push(...buildFeasibilityItems(feasibility, combined, dayScopeCtx));

  const severityRank: Record<CriticalItem["severity"], number> = { critical: 0, warning: 1 };
  const scopeRank: Record<DayScope, number> = { heute: 0, beide: 0, morgen: 1, plating: 1, unbekannt: 1 };
  items.sort((x, y) =>
    severityRank[x.severity] - severityRank[y.severity]
    || scopeRank[x.dayScope] - scopeRank[y.dayScope]
    || x.recipeName.localeCompare(y.recipeName));
  return items;
}

// ── Was soll geplaitet werden ────────────────────────────────────────────────

// Bewusst OHNE Küchen-WO-Tages-Filter: Plaitieren folgt nicht dem Küchen-
// Kalender (eine Komponente kann längst fertig gekocht sein und erst heute
// zum Plaitieren anstehen) — "was soll geplaitet werden" heißt schlicht
// "was ist gerade netto plaitierbar", unabhängig davon, wann die Küche daran
// gearbeitet hat. dayScopeFor liefert nur noch das Anzeige-Tag fürs Badge.
function buildPlatingTodo(
  meals: MealProgress[],
  recipeWeights: RecipeWeightLookup | null,
  plaitedByCode: Map<string, number>,
  dayScopeCtx: DayScopeCtx,
): PlatingTodoItem[] {
  const items: PlatingTodoItem[] = [];
  for (const meal of meals) {
    const { net } = mealReadiness(meal, recipeWeights, plaitedByCode);
    if (!net || net.netMeals <= 0) continue;
    const dayScope = dayScopeFor(meal.recipeCode, dayScopeCtx) ?? "plating";
    items.push({
      recipeCode: meal.recipeCode,
      recipeName: meal.recipeName,
      netMeals: net.netMeals,
      grossMeals: net.grossMeals,
      platedMeals: net.platedMeals,
      dayScope,
    });
  }
  items.sort((a, b) => b.netMeals - a.netMeals);
  return items;
}

// ── Gefährdete WOs — konkrete WO-Nummern hinter der Kritisch-Liste ──────────

function buildAtRiskWos(criticalItems: CriticalItem[], ketDays: KetDayGroup[]): AtRiskWo[] {
  const rowsByMealKey = new Map<string, { row: KetWoRow; isToday: boolean }[]>();
  for (const day of ketDays) {
    for (const row of day.rows) {
      if (row.location === "Fertig") continue;
      const key = mealCodeKey(row.recipeCode);
      const list = rowsByMealKey.get(key) ?? [];
      list.push({ row, isToday: day.isToday });
      rowsByMealKey.set(key, list);
    }
  }

  interface Building {
    recipeCode: string; recipeName: string;
    woNumbers: Set<string>; hasToday: boolean; hasTomorrow: boolean;
    targetPortions: number; cookedPortions: number; reasons: Set<string>;
  }
  const byMeal = new Map<string, Building>();
  for (const item of criticalItems) {
    const key = mealCodeKey(item.recipeCode);
    const matches = rowsByMealKey.get(key);
    if (!matches) continue;
    let entry = byMeal.get(key);
    if (!entry) {
      entry = {
        recipeCode: item.recipeCode, recipeName: item.recipeName,
        woNumbers: new Set(), hasToday: false, hasTomorrow: false,
        targetPortions: 0, cookedPortions: 0, reasons: new Set(),
      };
      byMeal.set(key, entry);
    }
    for (const { row, isToday } of matches) {
      if (!entry.woNumbers.has(row.woNumber)) {
        entry.woNumbers.add(row.woNumber);
        entry.targetPortions += row.targetPortions;
        entry.cookedPortions += row.cookedPortions;
      }
      if (isToday) entry.hasToday = true; else entry.hasTomorrow = true;
    }
    entry.reasons.add(`[${item.sourceLabel}] ${item.message}`);
  }

  return [...byMeal.values()]
    .map(e => ({
      recipeCode: e.recipeCode,
      recipeName: e.recipeName,
      isToday: e.hasToday,
      dayLabel: e.hasToday && e.hasTomorrow ? "Heute + Morgen" : e.hasToday ? "Heute" : "Morgen",
      woNumbers: [...e.woNumbers].sort(),
      targetPortions: e.targetPortions,
      cookedPortions: e.cookedPortions,
      reasons: [...e.reasons],
    }))
    .sort((a, b) => Number(b.isToday) - Number(a.isToday) || a.recipeName.localeCompare(b.recipeName));
}

// ── Morgen zuerst anfassen ───────────────────────────────────────────────────
// Kritisches zuerst (das Risiko ist schon bekannt), danach die größten Ansätze
// (brauchen am meisten Vorlauf) — beschränkt auf eine kurze, wirklich
// priorisierte Liste statt der kompletten Morgen-Tabelle nochmal.
function buildTomorrowPriority(ketDays: KetDayGroup[], criticalItems: CriticalItem[]): TomorrowPriorityWo[] {
  // Zweischicht-Modell: "morgen" kann zwei Gruppen sein (Früh + Spät) —
  // beide einsammeln, nicht nur die erste per find().
  const openRows = ketDays.filter(d => d.isTomorrow).flatMap(d => d.rows).filter(r => r.location !== "Fertig");
  if (openRows.length === 0) return [];

  const criticalByKey = new Map<string, CriticalItem>();
  for (const item of criticalItems) {
    if (item.dayScope !== "morgen" && item.dayScope !== "beide") continue;
    const key = mealCodeKey(item.recipeCode);
    if (!criticalByKey.has(key)) criticalByKey.set(key, item); // Liste ist schon severity-sortiert
  }

  return openRows
    .map(row => {
      const crit = criticalByKey.get(mealCodeKey(row.recipeCode));
      return {
        row,
        isCritical: !!crit,
        reason: crit ? `Kritisch (${crit.sourceLabel}): ${crit.message}` : `Großer Ansatz (${Math.round(row.targetPortions)} Portionen)`,
      };
    })
    .sort((a, b) => Number(b.isCritical) - Number(a.isCritical) || b.row.targetPortions - a.row.targetPortions)
    .slice(0, 10)
    .map(({ row, reason }) => ({
      woNumber: row.woNumber, recipeCode: row.recipeCode, recipeName: row.recipeName,
      subRecipeName: row.subRecipeName, targetPortions: row.targetPortions, reason,
    }));
}

// ── Besetzungs-Schätzung ─────────────────────────────────────────────────────

function buildStaffingEstimate(
  ketDays: KetDayGroup[],
  platingTodo: PlatingTodoItem[],
  structures: DataBundle["structures"],
  kitchenHeadcountFromPlan: number | null,
): StaffingEstimate {
  // Zweischicht-Modell: beide heutigen Schicht-Gruppen einsammeln, nicht nur
  // die erste per find().
  const todayRows = ketDays.filter(d => d.isToday).flatMap(d => d.rows);
  const kitchenComponents = new Set<string>();
  for (const row of todayRows) {
    if (row.location !== "Kitchen" && row.location !== "Post-Blast" && row.location !== "Staging") continue;
    kitchenComponents.add(`${row.recipeCode}||${row.subRecipeName}`);
  }
  const kitchenEstimate = kitchenComponents.size > 0 ? kitchenComponents.size + 1 : 0;

  // Plating: aus den tatsächlich zu plaitierenden Meals (platingTodo) über die
  // echte Rezeptstruktur — nicht über heutige KET-Zeilen (die zeigen nur, was
  // HEUTE gekocht wird; ein Meal kann längst fertig gekocht sein und trotzdem
  // heute zu plaitieren anstehen, siehe Marcel).
  const platingComponents = new Set<string>();
  for (const p of platingTodo) {
    const structure = resolveStructureByCode(structures, p.recipeCode, undefined, p.recipeName);
    if (!structure) continue;
    for (const node of getStructureForRecipe(structure)) platingComponents.add(`${p.recipeCode}||${node.name}`);
  }

  return {
    kitchen: kitchenHeadcountFromPlan ?? kitchenEstimate,
    kitchenSource: kitchenHeadcountFromPlan != null ? "plan" : kitchenEstimate > 0 ? "estimate" : "none",
    kitchenComponents: kitchenComponents.size,
    plating: platingComponents.size > 0 ? platingComponents.size + 1 : 0,
    platingComponents: platingComponents.size,
  };
}

// ── Deadlines ───────────────────────────────────────────────────────────────

function dayDeadlines(cal: DataBundle["planningCalendar"], dayOffset: number) {
  if (!cal) return [];
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return cal.deadlines.filter(x => x.days.includes(dayName)).map(x => ({ activity: x.activity, time: x.time, owner: x.owner })).sort((a, b) => a.time.localeCompare(b.time));
}

// ── Copyable text ───────────────────────────────────────────────────────────

function buildCopyText(
  s: BriefingSummary,
  days: KetDayGroup[],
  critical: CriticalItem[],
  backfill: BackfillWatchItem[],
  platingTodo: PlatingTodoItem[],
  atRiskWos: AtRiskWo[],
  tomorrowPriority: TomorrowPriorityWo[],
  staffing: StaffingEstimate,
  week: string,
): string {
  const lines: string[] = [];
  const time = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  lines.push(`*Tagesbriefing ${week} — ${time}* _(Fokus: Heute + Morgen)_`);
  lines.push("");
  lines.push(`Produktion: ${s.productionPct}% | Plating: ${s.platingPct}% (${s.totalPlated}/${s.totalPlannedPortions})`);
  lines.push(`Planungsziel: ${s.mealsReady}/${s.totalMeals} ready${s.mealsBlocked > 0 ? ` | ${s.mealsBlocked} BLOCKED` : ""}`);
  if (s.backfillMeals > 0) lines.push(`Backfill: ${s.backfillMeals} offen (${s.totalBackfillPortions} Port.)`);
  if (staffing.kitchen > 0 || staffing.plating > 0) {
    const kitchenTag = staffing.kitchenSource === "plan" ? "" : " (Schätzung)";
    lines.push(`Besetzung: Küche ${staffing.kitchen} MA${kitchenTag} · Plating ~${staffing.plating} MA (Schätzung)`);
  }
  lines.push("");

  // Was ist JETZT faul — EINE Liste statt über Sektionen verteilt.
  if (critical.length > 0) {
    lines.push(`*Kritisch (${critical.length}):*`);
    for (const c of critical.slice(0, 12)) {
      const tag = c.dayScope === "morgen" ? " (morgen)" : "";
      lines.push(`  ${c.severity === "critical" ? "🔴" : "🟡"} [${c.sourceLabel}]${tag} ${c.recipeCode} ${c.recipeName} — ${c.message}`);
    }
    if (critical.length > 12) lines.push(`  … + ${critical.length - 12} weitere`);
    lines.push("");
  } else {
    lines.push("Keine kritischen Meldungen.");
    lines.push("");
  }

  // Konkrete gefährdete WOs — nicht nur "dieses Meal hat ein Problem".
  if (atRiskWos.length > 0) {
    lines.push(`*Gefährdete WOs (${atRiskWos.length} Meals):*`);
    for (const w of atRiskWos.slice(0, 12)) {
      const wos = w.woNumbers.length > 4 ? `${w.woNumbers.slice(0, 4).join(", ")} +${w.woNumbers.length - 4}` : w.woNumbers.join(", ");
      lines.push(`  ${w.dayLabel} · ${w.recipeCode} ${w.recipeName} — WOs ${wos} (${w.woNumbers.length})`);
      for (const r of w.reasons) lines.push(`    ${r}`);
    }
    if (atRiskWos.length > 12) lines.push(`  … + ${atRiskWos.length - 12} weitere`);
    lines.push("");
  }

  // Per day summary
  for (const day of days) {
    const offen = day.rows.filter(r => r.location !== "Fertig").length;
    const fertig = day.rows.filter(r => r.location === "Fertig").length;
    lines.push(`${day.dateLabel}: ${day.rows.length} WOs (${fertig} fertig, ${offen} offen) — ${day.cookedPct}%`);
  }
  lines.push("");

  // Was heute noch produziert werden muss — WO-Level, nur offene (nicht Fertig).
  // Zweischicht-Modell: beide heutigen Schicht-Gruppen einsammeln.
  const todayRowsAll = days.filter(d => d.isToday).flatMap(d => d.rows);
  const openToday = todayRowsAll.filter(r => r.location !== "Fertig");
  if (openToday.length > 0) {
    lines.push(`*Heute noch offen (${openToday.length}/${todayRowsAll.length} WOs):*`);
    for (const r of openToday.slice(0, 20)) {
      lines.push(`  [${r.location}]${r.shift ? ` ${SHIFT_LABEL_SHORT[r.shift] ?? r.shift}` : ""} WO ${r.woNumber} — ${r.recipeCode} ${r.recipeName} (${r.subRecipeName}) — ${r.cookedPortions}/${r.targetPortions} Port. (${r.cookedPct.toFixed(0)}%)`);
    }
    if (openToday.length > 20) lines.push(`  … + ${openToday.length - 20} weitere`);
    lines.push("");
  }

  // Was soll geplaitet werden — Netto-plaitierbar je Meal.
  if (platingTodo.length > 0) {
    lines.push("*Zu plaitieren:*");
    for (const p of platingTodo.slice(0, 10)) {
      lines.push(`  ${p.recipeCode} ${p.recipeName} — ${p.netMeals} Port. bereit (${p.platedMeals}/${p.grossMeals} schon plaitiert)`);
    }
    lines.push("");
  }

  // Morgen zuerst anfassen.
  if (tomorrowPriority.length > 0) {
    lines.push("*Morgen zuerst anfassen:*");
    for (const p of tomorrowPriority) {
      lines.push(`  WO ${p.woNumber} — ${p.recipeCode} ${p.recipeName} (${p.subRecipeName}) — ${p.reason}`);
    }
    lines.push("");
  }

  // Backfills (Detail — Wächter-Ebene, ergänzt die Kritisch-Liste oben)
  if (backfill.length > 0) {
    lines.push("*Backfill-Details:*");
    for (const b of backfill.slice(0, 6)) {
      lines.push(`  ${b.mealCode} ${b.mealName} — ${b.openSubs.map(s => `${s.subRecipeName} (min ${s.minimumNeed})`).join(", ")}`);
    }
  }

  return lines.join("\n");
}

// ── Main entry ──────────────────────────────────────────────────────────────

export function buildDailyBriefing(opts: {
  data: DataBundle;
  meals: MealProgress[];
  rtiMeals: RtiMealBackfill[];
  alerts: BackfillAlert[];
  ketRows: KetRow[];
  plaitedByCode: Map<string, number>;
  producibility: TransparencyProducibilityResult | null;
  week: string;
  combined?: CombinedBackfillNeed[];
  feasibilityByMeal?: Map<string, BackfillFeasibility>;
  recipeWeights?: RecipeWeightLookup | null;
  kitchenHeadcountFromPlan?: number | null;
}): DailyBriefing {
  const { data, meals, rtiMeals, alerts, ketRows, plaitedByCode, producibility, week } = opts;
  const combined = opts.combined ?? [];
  const feasibilityByMeal = opts.feasibilityByMeal ?? new Map<string, BackfillFeasibility>();
  const recipeWeights = opts.recipeWeights ?? null;
  const kitchenHeadcountFromPlan = opts.kitchenHeadcountFromPlan ?? null;

  const ketDaysAll = buildKetDays(ketRows);
  // Nur heute + morgen anzeigen — vergangene Tage (Sonntag/Montag etc.) und
  // Tage weiter als morgen sind für die 15:30-Runde nicht relevant. Ändert
  // dayScopeCtx NICHT (das liest ohnehin nur isToday/isTomorrow-Tage).
  const ketDays = ketDaysAll.filter(d => d.isToday || d.isTomorrow);
  const dayScopeCtx = buildDayScopeCtx(ketDaysAll, ketRows);
  const mealPlating = buildMealPlating(meals, plaitedByCode, producibility, recipeWeights, dayScopeCtx);
  const backfillWatch = buildBackfillWatch(rtiMeals, dayScopeCtx);
  const backfillAlerts = alerts.filter(a => a.severity !== "info");
  const criticalItems = buildCriticalItems(mealPlating, backfillAlerts, meals, feasibilityByMeal, combined, dayScopeCtx);
  const platingTodo = buildPlatingTodo(meals, recipeWeights, plaitedByCode, dayScopeCtx);
  const atRiskWos = buildAtRiskWos(criticalItems, ketDays);
  const tomorrowPriority = buildTomorrowPriority(ketDays, criticalItems);
  const staffing = buildStaffingEstimate(ketDays, platingTodo, data.structures, kitchenHeadcountFromPlan);
  const deadlines = dayDeadlines(data.planningCalendar, 0);
  const deadlinesTomorrow = dayDeadlines(data.planningCalendar, 1);

  // Zweischicht-Modell: heute/morgen sind je bis zu zwei Gruppen (Früh + Spät)
  // — über beide summieren statt nur die per find() erstgefundene zu nehmen
  // (sonst hätte die Spätschicht in Summary/KPIs einfach gefehlt).
  const todayGroups = ketDays.filter(d => d.isToday);
  const tomorrowGroups = ketDays.filter(d => d.isTomorrow);
  const todayWos = todayGroups.reduce((s, d) => s + d.rows.length, 0);
  const todayCooked = todayGroups.reduce((s, d) => s + d.totalCooked, 0);
  const todayTarget = todayGroups.reduce((s, d) => s + d.totalTarget, 0);
  const tomorrowWos = tomorrowGroups.reduce((s, d) => s + d.rows.length, 0);

  const totalPlated = mealPlating.reduce((s, m) => s + m.platedPortions, 0);
  const totalPlannedPortions = mealPlating.reduce((s, m) => s + m.plannedMeals, 0);
  const productionPcts = mealPlating.filter(m => m.productionPct > 0 || m.completedWOs > 0);
  const avgProdPct = productionPcts.length > 0 ? Math.round(productionPcts.reduce((s, m) => s + m.productionPct, 0) / productionPcts.length) : 0;

  const summary: BriefingSummary = {
    totalMeals: mealPlating.length,
    mealsReady: mealPlating.filter(m => m.producibility === "ready").length,
    mealsBlocked: mealPlating.filter(m => m.producibility === "blocked").length,
    platingPct: totalPlannedPortions > 0 ? Math.round((totalPlated / totalPlannedPortions) * 100) : 0,
    totalPlated,
    totalPlannedPortions,
    productionPct: avgProdPct,
    backfillMeals: backfillWatch.length,
    totalBackfillPortions: backfillWatch.reduce((s, b) => s + b.recommendedMin, 0),
    todayWos,
    todayCooked,
    todayCookedPct: todayTarget > 0 ? Math.round((todayCooked / todayTarget) * 100) : 0,
    tomorrowWos,
    criticalCount: criticalItems.length,
  };

  return {
    generatedAt: new Date().toISOString(),
    currentWeek: week,
    ketDays,
    mealPlating,
    backfillWatch,
    backfillAlerts,
    criticalItems,
    platingTodo,
    atRiskWos,
    tomorrowPriority,
    staffing,
    deadlines,
    deadlinesTomorrow,
    summary,
    copyText: buildCopyText(summary, ketDays, criticalItems, backfillWatch, platingTodo, atRiskWos, tomorrowPriority, staffing, week),
  };
}
