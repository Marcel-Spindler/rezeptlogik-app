// Backfill-Wächter – Live-Station am RTI Plating Tracker. Pro Meal die
// Sub-Rezepte, die beim Zurückwiegen leer gelaufen sind, mit Mindestbedarf
// (Spalte "Minimum need") UND gepufferter Empfehlung (Spalte "Backfill Meals"),
// kinderleicht erklärt. Copy-Button + Abhaken zum Eintragen ins System.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useBackfills } from "./BackfillsContext";
import type { BackfillFeasibility } from "./backfillTypes";
import type { RtiMealBackfill, RtiSubShortfall } from "./rtiBackfillCalculator";
import type { SubStockElsewhere } from "./rtiInventorySweep";
import { fmt } from "../whatif/whatIfFormat";
import { codeDigits, usePersistent } from "../../lib/helpers";

// ── "eingetragen"-Status ────────────────────────────────────────────────────
// Lokal (localStorage) als Sofort-Feedback + Fallback; zusätzlich versucht der
// Wächter, Spalte J im RTI-Sheet auf "done" zu setzen (Cloud Function
// /api/rti-mark-done — braucht Bearbeiter-Rechte des Service-Accounts).
// Gemerkt wird die Mindestmenge zum Zeitpunkt des Abhakens; steigt sie später
// deutlich, taucht die Zeile wieder als offen auf.
interface EnteredMark { min: number; at: number; synced?: boolean }
type EnteredMap = Record<string, EnteredMark>;

function subKey(weekNum: number | null, mealCode: string, sub: RtiSubShortfall): string {
  return `${weekNum ?? "?"}:${sub.workOrder || mealCode}:${sub.subRecipeName}`;
}

function copyLine(meal: RtiMealBackfill, sub: RtiSubShortfall): string {
  return `${meal.mealCode} · ${sub.subRecipeName} · Backfill: ${fmt(sub.minimumNeed)} (mit Puffer ${fmt(sub.bufferedNeed)})`;
}

async function toClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fällt unten durch */ }
  return false;
}

// Ergebnis des Sheet-Schreibversuchs. "missing" = Function nicht deployed
// (Hosting-Rewrite liefert die SPA statt JSON) → kein Fehler-Hinweis nötig.
type MarkResult = "ok" | "failed" | "missing";

/** Spalte J im RTI-Sheet auf "done" setzen. */
async function markSheetDone(sub: RtiSubShortfall): Promise<MarkResult> {
  try {
    const res = await fetch("/api/rti-mark-done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wo: sub.workOrder, subRecipe: sub.subRecipeName }),
    });
    if (!res.headers.get("content-type")?.includes("application/json")) return "missing";
    const body = await res.json().catch(() => null);
    return res.ok && body?.ok ? "ok" : "failed";
  } catch { return "missing"; }
}

// ── kleine Bausteine ────────────────────────────────────────────────────────

function CopyButton({ text, label = "kopieren" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => { if (await toClipboard(text)) { setDone(true); setTimeout(() => setDone(false), 1500); } }}
      className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition ${done ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 hover:bg-slate-200 text-slate-700"}`}
    >
      {done ? "✓ kopiert" : `📋 ${label}`}
    </button>
  );
}

// Die zwei Zahlen als klare Einheit: „mindestens" (die harte Zahl) groß + dunkel,
// „mit Puffer" als Empfehlung daneben.
function NeedPills({ min, buffered }: { min: number; buffered: number }) {
  return (
    <div className="flex items-stretch shrink-0 rounded-lg overflow-hidden border border-slate-200">
      <div className="bg-slate-900 text-white px-3 py-1.5 text-center leading-none">
        <div className="text-[8px] uppercase tracking-wider text-white/50 mb-0.5">mindestens</div>
        <div className="text-lg font-bold font-mono">{fmt(min)}</div>
      </div>
      <div className="bg-amber-50 text-amber-800 px-3 py-1.5 text-center leading-none border-l border-amber-200">
        <div className="text-[8px] uppercase tracking-wider text-amber-500 mb-0.5">+ Puffer</div>
        <div className="text-lg font-bold font-mono">{fmt(buffered)}</div>
      </div>
    </div>
  );
}

function shorten(s: string, n = 32): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

// Rohware-Ampel des GANZEN Meals (feasibility ist meal-, nicht sub-Ebene) — als
// ein Streifen unter dem Meal-Kopf, nicht pro Sub wiederholt.
function RohwareStrip({ f }: { f: BackfillFeasibility | undefined }) {
  if (!f || f.verdict === "unknown") return null;
  const [cls, text] =
    f.verdict === "feasible" ? ["bg-emerald-50 text-emerald-700", "🟢 Rohware im Lager reicht für den Backfill"] :
    f.verdict === "partial" ? ["bg-amber-50 text-amber-800", `🟡 Rohware reicht nur für ${fmt(f.maxProduciblePortions)} Portionen`] :
    ["bg-rose-50 text-rose-700", `🔴 Rohware fehlt${f.bottleneck[0] ? ` — ${shorten(f.bottleneck[0].ingredientName, 40)}` : ""}`];
  return <div className={`pl-5 pr-4 py-1.5 text-[11px] font-medium ${cls}`}>{text}</div>;
}

// „Steht schon woanders im System" — nur wenn es den Bedarf DECKT ist es
// handlungsrelevant (amber-Chip). Sonst nur eine leise Info-Zeile.
function elsewhereNote(e: SubStockElsewhere | undefined) {
  if (!e || e.totalPortions <= 0) return null;
  const locs = e.byLocation.slice(0, 2).map(l => `${l.location} ${fmt(l.portions)}`).join(" · ");
  if (e.covered) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 text-amber-800 px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-amber-300">
        📦 {fmt(e.totalPortions)} liegen schon woanders — erst dort prüfen ({locs})
      </span>
    );
  }
  return (
    <span className="text-[11px] text-slate-400">
      📦 {fmt(e.totalPortions)} woanders{e.shared ? " · SKU in mehreren Meals" : ""} ({locs})
    </span>
  );
}

// ── Sub-Zeile ───────────────────────────────────────────────────────────────

function SubRow({
  meal, sub, elsewhere, entered, flash, onEnter, onUndo,
}: {
  meal: RtiMealBackfill;
  sub: RtiSubShortfall;
  elsewhere: SubStockElsewhere | undefined;
  entered: EnteredMark | undefined;
  flash: boolean;
  onEnter: () => void;
  onUndo: () => void;
}) {
  const grew = entered != null && sub.minimumNeed > entered.min + 20;
  const covered = elsewhere?.covered ?? false;

  if (entered && !grew) {
    return (
      <div className="flex items-center justify-between gap-2 pl-5 pr-4 py-2 text-[12px] text-slate-400">
        <span className="truncate">✓ eingetragen · <span className="line-through">{sub.subRecipeName}</span> ({fmt(entered.min)})</span>
        <button type="button" onClick={onUndo} className="shrink-0 text-slate-400 hover:text-slate-700 underline">rückgängig</button>
      </div>
    );
  }

  const note = elsewhereNote(elsewhere);
  const holdingInfo = sub.weighedKg > 0
    ? `${fmt(sub.weighedKg, 1)} kg zurückgewogen · deckt noch ${fmt(sub.availableMealcount)}`
    : sub.basis === "sheet"
      ? sub.availableMealcount > 0 ? `Holding: noch ${fmt(sub.availableMealcount)} — Rest fehlt` : "Plating-Holding leer"
      : null;

  return (
    <div className={`pl-5 pr-4 py-2.5 transition-colors ${flash ? "bg-amber-50" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-semibold text-[13px] text-slate-900">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${covered ? "bg-amber-400" : "bg-rose-500"}`} />
            <span className="truncate">{sub.subRecipeName}</span>
          </div>
          {(holdingInfo || sub.basis === "gap-only") && (
            <div className="mt-0.5 text-[11px] text-slate-500">
              {holdingInfo}
              {sub.basis === "gap-only" && (
                <span className="text-amber-600">{holdingInfo ? " · " : ""}⧗ noch nicht pro Sub im Sheet — geschätzt</span>
              )}
            </div>
          )}
        </div>
        <NeedPills min={sub.minimumNeed} buffered={sub.bufferedNeed} />
      </div>

      {grew && (
        <div className="mt-1.5 text-[11px] text-amber-700 font-semibold">
          ⚠ Menge gestiegen — eingetragen mit {fmt(entered!.min)}, jetzt {fmt(sub.minimumNeed)}
        </div>
      )}

      {note && <div className="mt-1.5">{note}</div>}

      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={async () => { await toClipboard(copyLine(meal, sub)); onEnter(); }}
          className="px-3 py-1 rounded-lg text-[11px] font-semibold bg-slate-800 hover:bg-slate-900 text-white transition"
          title="Kopiert die Zeile UND setzt Spalte J im RTI-Sheet auf „done“"
        >
          📋 kopieren &amp; erledigt
        </button>
        <button
          type="button"
          onClick={onEnter}
          className="text-[11px] font-medium text-slate-400 hover:text-slate-700 hover:underline transition"
        >
          nur abhaken
        </button>
        {entered?.synced === false && (
          <span className="text-[10px] text-amber-700 ml-auto">⚠ Sheet „done" fehlgeschlagen — manuell setzen</span>
        )}
      </div>
    </div>
  );
}

// ── Meal-Karte ──────────────────────────────────────────────────────────────

function MealCard({
  meal, weekNum, feasibility, elsewhere, entered, flashKeys, setEntered, openCount,
}: {
  meal: RtiMealBackfill;
  weekNum: number | null;
  feasibility: BackfillFeasibility | undefined;
  elsewhere: Map<string, SubStockElsewhere>;
  entered: EnteredMap;
  flashKeys: Set<string>;
  setEntered: Dispatch<SetStateAction<EnteredMap>>;
  openCount: number;
}) {
  const mark = useCallback((sub: RtiSubShortfall, on: boolean) => {
    const key = subKey(weekNum, meal.mealCode, sub);
    setEntered(prev => {
      const next = { ...prev };
      if (on) next[key] = { min: sub.minimumNeed, at: Date.now() };
      else delete next[key];
      return next;
    });
    if (on) {
      void markSheetDone(sub).then(result => {
        setEntered(prev => {
          const cur = prev[key];
          if (!cur) return prev;
          // "missing" (Function noch nicht deployed) NICHT als Fehler zeigen.
          return { ...prev, [key]: { ...cur, synced: result === "missing" ? undefined : result === "ok" } };
        });
      });
    }
  }, [weekNum, meal.mealCode, setEntered]);

  return (
    <div className="relative rounded-xl bg-white ring-1 ring-slate-200 shadow-sm overflow-clip">
      {/* Farb-Spine über die volle Höhe = „alles hier drunter gehört zu dem Meal" */}
      <div className="absolute inset-y-0 left-0 w-[5px] bg-rose-500 z-20" />

      {/* Meal-Kopf — bleibt beim Scrollen oben stehen, damit immer klar ist,
          zu welchem Meal die Sub-Rezepte darunter gehören. */}
      <div className="sticky top-[52px] z-[8] bg-slate-100 pl-5 pr-4 py-3 border-b border-slate-200">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-mono font-bold text-base text-slate-900">{meal.mealCode}</span>
              <span className="text-sm text-slate-700">{meal.mealName}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500 flex-wrap">
              <span>geplant {fmt(meal.plannedTarget)} · platiert {fmt(meal.actuals)}</span>
              <span className="text-slate-300">·</span>
              <span className="font-medium text-slate-600">{openCount} nachkochen</span>
              {meal.targetEstimated && (
                <span className="text-amber-600" title={`Ziel/Ist aus App-Daten (${meal.targetSourceLabel}) — Bot trägt es im RTI-Sheet nach`}>
                  ⧗ Ziel/Ist geschätzt
                </span>
              )}
              {meal.hasGapOnly && !meal.targetEstimated && <span className="text-amber-600">⧗ Sheet pro Sub unvollständig</span>}
            </div>
          </div>
          <div className="shrink-0 text-center rounded-lg bg-rose-600 text-white px-3 py-1 leading-none">
            <div className="text-xl font-bold font-mono">{fmt(meal.gap)}</div>
            <div className="text-[8px] uppercase tracking-wider text-rose-100">fehlen</div>
          </div>
        </div>
      </div>

      <RohwareStrip f={feasibility} />

      <div className="divide-y divide-slate-100">
        {meal.openSubs.map(sub => {
          const key = subKey(weekNum, meal.mealCode, sub);
          return (
            <SubRow
              key={key}
              meal={meal}
              sub={sub}
              elsewhere={elsewhere.get(`${meal.mealCode}|${sub.subRecipeName}`)}
              entered={entered[key]}
              flash={flashKeys.has(key)}
              onEnter={() => mark(sub, true)}
              onUndo={() => mark(sub, false)}
            />
          );
        })}
      </div>

      {(meal.enteredSubs.length > 0 || meal.notNeededSubs.length > 0 || meal.candidateSubNames.length > 0) && (
        <div className="pl-5 pr-4 py-2 bg-slate-50 border-t border-slate-100 space-y-0.5 text-[10px]">
          {meal.enteredSubs.length > 0 && (
            <div className="text-emerald-600">
              ✓ im Sheet „done": {meal.enteredSubs.map(s => `${s.subRecipeName} (${fmt(s.minimumNeed)})`).join(" · ")}
            </div>
          )}
          {meal.notNeededSubs.length > 0 && (
            <div className="text-slate-400">kein Backfill („no"): {meal.notNeededSubs.map(s => s.subRecipeName).join(", ")}</div>
          )}
          {meal.candidateSubNames.length > 0 && (
            <div className="text-slate-400">Backfill-WO im Sheet angelegt: {meal.candidateSubNames.join(", ")}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Erklär-Box ──────────────────────────────────────────────────────────────

function Explainer({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="card p-4">
      <button type="button" onClick={onToggle} className="text-sm font-bold text-slate-800 w-full text-left">
        {open ? "▲" : "▼"} Wie die Zahl entsteht
      </button>
      {open && (
        <ol className="mt-2 space-y-1 text-[12px] text-slate-600 list-decimal pl-5">
          <li><b>Geplant − platiert = fehlende Portionen</b> (Beispiel: 3.763 − 2.848 = 915).</li>
          <li>Pro Sub-Rezept steht im RTI-Sheet, wie viel noch im Plating-Holding ist (Spalten „RTI Plating Kg" / „Availble Mealcount").</li>
          <li>Reicht das nicht für die fehlenden Portionen → dieses Sub-Rezept muss <b>nachgekocht</b> werden. Die aus Holding gedeckten Komponenten nicht.</li>
          <li>Sobald in Spalte J des Sheets <b>„done"</b> steht, gilt der Backfill als ins System eingetragen und verschwindet hier aus der offenen Liste.</li>
        </ol>
      )}
      {open && (
        <div className="mt-2 flex flex-wrap gap-4 text-[11px]">
          <span><span className="font-mono font-bold bg-slate-900 text-white rounded px-1.5 py-0.5">mindestens</span> = so viele fehlen wirklich (Spalte „Minimum need").</span>
          <span><span className="font-mono font-bold bg-amber-100 text-amber-800 rounded px-1.5 py-0.5 ring-1 ring-amber-300">mit Puffer</span> = Empfehlung des Sheets, plus dem Prozentsatz der gefehlt hat (Spalte „Backfill Meals").</span>
        </div>
      )}
    </div>
  );
}

// ── Haupt-Ansicht ───────────────────────────────────────────────────────────

export function BackfillWatchView() {
  const {
    rtiMeals, rtiConnected, rtiLastUpdate, rtiForceRefresh,
    selectedWeekNum, setSelectedWeekNum, availableWeekNums, isStaleWeek,
    feasibilityByMeal, fullInventoryConnected, inventoryElsewhere,
  } = useBackfills();

  const [entered, setEntered] = usePersistent<EnteredMap>("backfill-watch-entered", {});
  const [explainerOpen, setExplainerOpen] = usePersistent<boolean>("backfill-watch-explainer", true);
  const [filter, setFilter] = useState<"open" | "all">("open");

  // Rohware-Ampel je 4-Ziffer-Code auflösen (feasibilityByMeal ist auf den
  // Anzeige-Code der combined-Liste gekeyed, der abweichen kann).
  const feasibilityByDigits = useMemo(() => {
    const m = new Map<string, BackfillFeasibility>();
    for (const f of feasibilityByMeal.values()) m.set(codeDigits(f.recipeCode), f);
    return m;
  }, [feasibilityByMeal]);

  // Wert-Änderungen zwischen zwei Polls kurz hervorheben.
  const prevRef = useRef<Map<string, number>>(new Map());
  const [flashKeys, setFlashKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    const cur = new Map<string, number>();
    for (const meal of rtiMeals) {
      for (const sub of meal.openSubs) cur.set(subKey(selectedWeekNum, meal.mealCode, sub), sub.minimumNeed);
    }
    const changed = new Set<string>();
    for (const [k, v] of cur) {
      if (prevRef.current.has(k) && prevRef.current.get(k) !== v) changed.add(k);
    }
    prevRef.current = cur;
    if (changed.size === 0) return;
    setFlashKeys(changed);
    const t = setTimeout(() => setFlashKeys(new Set()), 2500);
    return () => clearTimeout(t);
  }, [rtiMeals, selectedWeekNum]);

  const isEntered = useCallback((meal: RtiMealBackfill, sub: RtiSubShortfall) => {
    const e = entered[subKey(selectedWeekNum, meal.mealCode, sub)];
    return e != null && sub.minimumNeed <= e.min + 20;
  }, [entered, selectedWeekNum]);

  const withOpen = rtiMeals.filter(m => m.openSubs.length > 0);
  const headerIncomplete = rtiMeals.filter(m => m.headerIncomplete);
  const openSubCount = withOpen.reduce((s, m) => s + m.openSubs.filter(sub => !isEntered(m, sub)).length, 0);
  const enteredCount = withOpen.reduce((s, m) => s + m.openSubs.filter(sub => isEntered(m, sub)).length, 0);

  const visible = filter === "open"
    ? withOpen.filter(m => m.openSubs.some(sub => !isEntered(m, sub)))
    : withOpen;

  const copyAllOpen = useMemo(() => withOpen.flatMap(m =>
    m.openSubs.filter(sub => !isEntered(m, sub)).map(sub => copyLine(m, sub)),
  ).join("\n"), [withOpen, isEntered]);

  const lastStr = rtiLastUpdate
    ? new Date(rtiLastUpdate).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const stale = rtiLastUpdate != null && Date.now() - rtiLastUpdate > 5 * 60 * 1000;

  return (
    <div className="space-y-4 pb-8 max-w-4xl">
      {/* Kopf */}
      <div className="card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full ${rtiConnected ? (stale ? "bg-amber-400" : "bg-emerald-400") : "bg-slate-300"}`} />
              <span className="text-[11px] text-slate-500">
                RTI Plating Tracker · zuletzt {lastStr}{stale ? " · > 5 min alt" : ""} · alle 60 s
              </span>
              <button
                type="button"
                onClick={() => void rtiForceRefresh()}
                className="px-2 py-0.5 rounded-lg text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-600 transition"
              >
                ⟳ jetzt prüfen
              </button>
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Backfill-Wächter</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              {openSubCount === 0
                ? "Nichts offen — kein Sub-Rezept ist leergelaufen."
                : `${withOpen.length} Meal(s) · ${openSubCount} Sub-Rezept(e) nachproduzieren`}
              {enteredCount > 0 && ` · ${enteredCount} eingetragen`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wide">KW</label>
            <select
              value={selectedWeekNum ?? ""}
              onChange={e => setSelectedWeekNum(e.target.value === "" ? null : Number(e.target.value))}
              className="text-xs px-2 py-1 rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-teal-400"
            >
              <option value="">Auto</option>
              {availableWeekNums.map(n => <option key={n} value={n}>KW {n}</option>)}
            </select>
          </div>
        </div>
      </div>

      {isStaleWeek && (
        <div className="rounded-xl p-3 bg-amber-50 ring-1 ring-amber-300 text-xs text-amber-800">
          <b>Daten der letzten Woche (KW {selectedWeekNum})</b> — für die aktuelle KW ist noch kein Produktionsplan importiert.
        </div>
      )}

      <Explainer open={explainerOpen} onToggle={() => setExplainerOpen(o => !o)} />

      {headerIncomplete.length > 0 && (
        <div className="rounded-xl p-3 bg-amber-50 ring-1 ring-amber-300 text-xs text-amber-800">
          <b>⚠ RTI-Sheet-Kopf fehlt</b> bei {headerIncomplete.map(m => m.mealCode).join(", ")} — es wird schon gewogen,
          aber <b>Planned Target / Actuals</b> sind oben noch nicht eingetragen und liessen sich auch nicht aus
          App-Daten herleiten (kein Forecast-Wert / keine Redzone-Zählung für diese KW). Bitte im RTI-Sheet nachtragen.
        </div>
      )}

      {!rtiConnected ? (
        <div className="card p-10 text-center text-sm text-slate-400">Warte auf das RTI-Sheet …</div>
      ) : withOpen.length === 0 ? (
        <div className="card p-10 text-center text-sm text-slate-400">
          Kein Backfill-Bedarf — das RTI-Sheet zeigt keine leergelaufenen Sub-Rezepte.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            {(["open", "all"] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition ${filter === f ? "bg-teal-600 text-white shadow-sm" : "bg-white text-slate-600 hover:bg-slate-100 ring-1 ring-slate-200"}`}
              >
                {f === "open" ? "Nur offene" : "Alle"}
              </button>
            ))}
            {openSubCount > 0 && <CopyButton text={copyAllOpen} label={`alle ${openSubCount} offenen kopieren`} />}
            {!fullInventoryConnected && (
              <span className="text-[10px] text-slate-400 ml-auto">Rohware-Ampel: lokalen WMS-Server starten (npm run wms:server)</span>
            )}
          </div>

          {visible.length === 0 ? (
            <div className="card p-10 text-center text-sm text-slate-400">Alles eingetragen. 🎉</div>
          ) : (
            <div className="space-y-4">
              {visible.map(meal => (
                <MealCard
                  key={meal.mealCode}
                  meal={meal}
                  weekNum={selectedWeekNum}
                  feasibility={feasibilityByDigits.get(codeDigits(meal.mealCode))}
                  elsewhere={inventoryElsewhere}
                  entered={entered}
                  flashKeys={flashKeys}
                  setEntered={setEntered}
                  openCount={meal.openSubs.filter(sub => !isEntered(meal, sub)).length}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
