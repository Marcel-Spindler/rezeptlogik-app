import { useEffect, useMemo, useState } from "react";
import type { DataBundle, MealCatalogEntry, WeekRecipe } from "../../core/types";
import { codeDigits, fmtNum, resolveRecipeByCode } from "../../lib/helpers";
import { getBaseVerdenVolume } from "../../lib/equipment";

type Catalog = Record<string, MealCatalogEntry>;
type Locale = "DE" | "DKSE" | "NL" | "FR";
type CatalogScope = "week" | "future" | "all";

const field = (entry: MealCatalogEntry, sheet: string, name: string) => entry.sheets[sheet]?.[name] ?? "";
const first = (...values: string[]) => values.find(Boolean) ?? "";
const titleOf = (entry: MealCatalogEntry) => first(field(entry, "Meal DB_Culinary", "Meal Name"), field(entry, "Verden Meal Database", "Meal Name"), field(entry, "DE", "Meal Name DE"), entry.mealId);
const subtitleOf = (entry: MealCatalogEntry) => first(field(entry, "Meal DB_Culinary", "Sub Name"), field(entry, "Verden Meal Database", "Meal Descriptor"));
const tagFields = ["SPICY?", "KETO", "CAL SMART", "CALORIE SMART", "P+", "ATHLETE", "MEDI", "VEGETARIAN", "VEGAN", "LACTOSE FREE", "SOURCE OF FIBER"];

function tagsOf(entry: MealCatalogEntry): string[] {
  const sources = [entry.sheets["Meal DB_Culinary"], entry.sheets["Verden Meal Database"]];
  return tagFields.filter(tag => sources.some(source => /^(yes|true|x|1)$/i.test(source?.[tag] ?? "")));
}

function metric(entry: MealCatalogEntry, name: string): string {
  return first(field(entry, "Meal DB_Nutrition", name), field(entry, "Verden Meal Database", name));
}

function label(value: string) {
  return value.replace(/\s*\(\d+\)$/, "").replace(/\s+/g, " ").trim();
}

function InfoBlock({ title, fields }: { title: string; fields: Record<string, string> }) {
  const rows = Object.entries(fields).filter(([key, value]) => value && key !== "Meal ID");
  if (rows.length === 0) return null;
  return (
    <section className="border-t border-slate-200 pt-5">
      <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{title}</h3>
      <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {rows.map(([key, value]) => (
          <div key={key} className="min-w-0">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label(key)}</dt>
            <dd className="mt-0.5 break-words text-sm text-slate-800">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function localFields(entry: MealCatalogEntry, locale: Locale): Record<string, string> {
  const fields = entry.sheets[locale] ?? {};
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !/^Meal Name \(EN\)|^Sub Name \(EN\)|^Legal Name \(EN\)|^Ingredient declaration \(EN\)|^Meal Story \(EN\)/i.test(key)));
}

function findWeekMatches(entry: MealCatalogEntry, data: DataBundle, week: string): WeekRecipe[] {
  const digits = codeDigits(entry.mealId);
  return data.weekRecipes
    .filter(recipe => recipe.hfWeek === week && (recipe.code === entry.mealId || codeDigits(recipe.code) === digits))
    .sort((a, b) => getBaseVerdenVolume(b) - getBaseVerdenVolume(a));
}

function ProductionMatch({ matches, week, upliftPercent, onOpenRecipe, onOpenPlanning, onOpenWms }: {
  matches: WeekRecipe[];
  week: string;
  upliftPercent: number;
  onOpenRecipe: (code: string) => void;
  onOpenPlanning: (code: string) => void;
  onOpenWms: () => void;
}) {
  if (matches.length === 0) {
    return <div className="catalog-production is-idle"><span>KW {week}</span><strong>Nicht in dieser Produktionswoche geplant</strong></div>;
  }
  const primary = matches[0];
  const total = Math.round(getBaseVerdenVolume(primary) * (1 + upliftPercent / 100));
  return (
    <section className="catalog-production">
      <div><span>Produktion · {week}</span><strong>{fmtNum(total)} Meals</strong><small>{primary.code} · FE/FV-Match über {codeDigits(primary.code)}</small></div>
      <div className="catalog-market-volumes">
        {(["BENL", "DKSE", "DE"] as const).filter(market => primary.verdenVolume[market] > 0).map(market => <span key={market}>{market} {fmtNum(primary.verdenVolume[market])}</span>)}
      </div>
      <div className="catalog-production-actions">
        <button type="button" className="btn btn-primary" onClick={() => onOpenRecipe(primary.code)}>Rezept & Workflow</button>
        <button type="button" className="btn" onClick={() => onOpenPlanning(primary.code)}>Planung</button>
        <button type="button" className="btn" onClick={onOpenWms}>WMS</button>
      </div>
    </section>
  );
}

export function MealCatalogView({
  catalog, data, selectedWeek, upliftPercent, onSelectWeek, onOpenRecipe, onOpenPlanning, onOpenWms,
}: {
  catalog: Catalog;
  data: DataBundle;
  selectedWeek: string;
  upliftPercent: number;
  onSelectWeek: (week: string) => void;
  onOpenRecipe: (code: string) => void;
  onOpenPlanning: (code: string) => void;
  onOpenWms: () => void;
}) {
  const meals = useMemo(() => Object.values(catalog).sort((a, b) => titleOf(a).localeCompare(titleOf(b), "de")), [catalog]);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("Alle");
  const [selectedId, setSelectedId] = useState<string | null>(meals[0]?.mealId ?? null);
  const [locale, setLocale] = useState<Locale>("DE");
  const [scope, setScope] = useState<CatalogScope>("week");

  useEffect(() => {
    if (!selectedId || !meals.some(meal => meal.mealId === selectedId)) setSelectedId(meals[0]?.mealId ?? null);
  }, [meals, selectedId]);

  const weekMeals = useMemo(
    () => meals.filter(meal => findWeekMatches(meal, data, selectedWeek).length > 0),
    [meals, data, selectedWeek],
  );
  const futureWeeks = useMemo(() => {
    const selectedIndex = data.weeks.indexOf(selectedWeek);
    return selectedIndex >= 0 ? data.weeks.slice(selectedIndex) : data.weeks;
  }, [data.weeks, selectedWeek]);
  const futureMeals = useMemo(
    () => meals.filter(meal => futureWeeks.some(week => findWeekMatches(meal, data, week).length > 0)),
    [meals, data, futureWeeks],
  );
  const scopedMeals = scope === "all" ? meals : scope === "future" ? futureMeals : weekMeals;
  const tags = useMemo(() => ["Alle", ...Array.from(new Set(scopedMeals.flatMap(tagsOf))).sort()], [scopedMeals]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scopedMeals.filter(meal => {
      const text = `${meal.mealId} ${titleOf(meal)} ${subtitleOf(meal)} ${Object.values(meal.sheets["Meal DB_Culinary"] ?? {}).join(" ")}`.toLowerCase();
      return (!needle || text.includes(needle)) && (tag === "Alle" || tagsOf(meal).includes(tag));
    });
  }, [scopedMeals, query, tag]);
  useEffect(() => {
    if (!filtered.some(meal => meal.mealId === selectedId)) setSelectedId(filtered[0]?.mealId ?? null);
  }, [filtered, selectedId]);
  const selected = filtered.find(meal => meal.mealId === selectedId) ?? filtered[0] ?? null;
  const currentWeekMatches = useMemo(() => selected ? findWeekMatches(selected, data, selectedWeek) : [], [selected, data, selectedWeek]);
  const availableWeeks = useMemo(() => selected ? data.weeks.filter(week => findWeekMatches(selected, data, week).length > 0) : [], [selected, data]);
  const index = selected ? filtered.findIndex(meal => meal.mealId === selected.mealId) : -1;
  const selectRelative = (offset: number) => {
    if (index < 0 || filtered.length === 0) return;
    setSelectedId(filtered[(index + offset + filtered.length) % filtered.length].mealId);
  };

  if (meals.length === 0) return <div className="card p-8 text-slate-500">Der Meal-Katalog ist noch nicht geladen. Führe <code>npm run import:meal-database</code> aus.</div>;

  const culinary = selected?.sheets["Meal DB_Culinary"] ?? {};
  const product = selected?.sheets["Meal DB_Product"] ?? {};
  const nutrition = selected?.sheets["Meal DB_Nutrition"] ?? {};
  const directImage = selected?.photoUrl && (selected.photoUrl.startsWith("/data/meal-images/") || /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(selected.photoUrl)) ? selected.photoUrl : undefined;

  return (
    <div className="meal-catalog space-y-4">
      <header className="meal-catalog-header">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.16em] text-cyan-800">Verden Meal Database</div>
          <h1 className="mt-1 text-2xl font-bold text-slate-950">Meal Katalog</h1>
          <p className="mt-1 text-sm text-slate-600">{scope === "all" ? `${meals.length} Meals im Gesamtkatalog` : scope === "future" ? `${futureMeals.length} Meals ab ${selectedWeek}` : `${weekMeals.length} produzierte Meals in ${selectedWeek}`} mit Produktdaten, Nährwerten, Küchenprofil und Markttexten.</p>
        </div>
        <div className="catalog-stat"><span>{meals.filter(meal => meal.photoUrl).length}</span> Bildquellen verknüpft</div>
      </header>

      <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <aside className="catalog-browser">
          <label className="sr-only" htmlFor="catalog-search">Meal suchen</label>
          <input id="catalog-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Meal, ID, Küche, Tag suchen" className="catalog-search" />
          <div className="mt-3 grid grid-cols-3 gap-1 border border-slate-300 bg-slate-50 p-1">
            <button type="button" onClick={() => setScope("week")} className={`catalog-scope ${scope === "week" ? "is-active" : ""}`}>KW {selectedWeek}</button>
            <button type="button" onClick={() => setScope("future")} className={`catalog-scope ${scope === "future" ? "is-active" : ""}`}>Ab KW</button>
            <button type="button" onClick={() => setScope("all")} className={`catalog-scope ${scope === "all" ? "is-active" : ""}`}>Alle Meals</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.map(item => <button key={item} type="button" onClick={() => setTag(item)} className={`catalog-filter ${tag === item ? "is-active" : ""}`}>{label(item)}</button>)}
          </div>
          <div className="mt-4 flex items-baseline justify-between text-xs text-slate-500"><span>{filtered.length} von {scopedMeals.length} Treffer</span><span>{scope === "all" ? "Gesamtkatalog" : scope === "future" ? `ab ${selectedWeek}` : selectedWeek}</span></div>
          <div className="catalog-list mt-2">
            {filtered.map(meal => (
              <button key={meal.mealId} type="button" onClick={() => setSelectedId(meal.mealId)} className={`catalog-row ${selected?.mealId === meal.mealId ? "is-selected" : ""}`}>
                <span className="catalog-row-mark">{titleOf(meal).slice(0, 1)}</span>
                <span className="min-w-0 text-left"><span className="block truncate text-sm font-semibold">{titleOf(meal)}</span><span className="mt-0.5 block truncate font-mono text-[11px] text-slate-500">{meal.mealId} · {field(meal, "Meal DB_Culinary", "CUISINE") || "Meal"}</span></span>
              </button>
            ))}
          </div>
        </aside>

        {selected && <main className="catalog-detail">
          <div className="catalog-hero">
            <div className="catalog-hero-copy">
              <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs font-semibold text-cyan-800">{selected.mealId}</span>{field(selected, "Meal DB_Culinary", "STATUS") && <span className="catalog-status">{field(selected, "Meal DB_Culinary", "STATUS")}</span>}</div>
              <h2 className="mt-3 text-2xl font-bold leading-tight text-slate-950">{titleOf(selected)}</h2>
              {subtitleOf(selected) && <p className="mt-2 max-w-2xl text-base text-slate-600">{subtitleOf(selected)}</p>}
              <div className="mt-4 flex flex-wrap gap-1.5">{tagsOf(selected).map(item => <span key={item} className="catalog-tag">{label(item)}</span>)}</div>
            </div>
            {directImage ? <img className="catalog-image" src={directImage} alt={titleOf(selected)} /> : <div className="catalog-art"><span>{field(selected, "Meal DB_Culinary", "PROTEIN TYPE") || field(selected, "Meal DB_Culinary", "MEAL TYPE") || "MEAL"}</span>{selected?.photoSourceUrl && <a href={selected.photoSourceUrl} target="_blank" rel="noreferrer">Bildquelle öffnen</a>}</div>}
          </div>

          <div className="catalog-metrics">
            {[['Gewicht', metric(selected, 'MEAL WEIGHT (g)'), 'g'], ['Kalorien', metric(selected, 'CALORIES'), 'kcal'], ['Protein', metric(selected, 'PROTEIN (g)'), 'g'], ['Kohlenhydrate', metric(selected, 'CARBS (g)'), 'g'], ['Fett', metric(selected, 'FAT (g)'), 'g']].map(([name, value, unit]) => <div key={name}><span>{name}</span><strong>{value || '–'}{value ? ` ${unit}` : ''}</strong></div>)}
          </div>

          <div className="p-5 pb-0 sm:px-7 sm:pt-7">
            <ProductionMatch matches={currentWeekMatches} week={selectedWeek} upliftPercent={upliftPercent} onOpenRecipe={onOpenRecipe} onOpenPlanning={onOpenPlanning} onOpenWms={onOpenWms} />
            {availableWeeks.length > 0 && <div className="catalog-week-match"><span>Weitere Produktionswochen</span>{availableWeeks.map(week => <button key={week} type="button" onClick={() => onSelectWeek(week)} className={week === selectedWeek ? "is-current" : ""}>{week}</button>)}</div>}
            {currentWeekMatches[0] && (() => {
              const recipe = resolveRecipeByCode(data.recipes, currentWeekMatches[0].code);
              return recipe && <div className="catalog-operations-summary"><span>Operative Daten verknüpft</span><span>{Object.keys(recipe.markets).length} Märkte</span><span>{Object.values(recipe.markets).reduce((total, market) => total + market.subRecipes.length, 0)} Sub-Rezepte</span><span>{Object.values(recipe.grossIngredients).reduce((total, rows) => total + (rows?.length ?? 0), 0)} Brutto-Zutaten</span></div>;
            })()}
          </div>

          <div className="catalog-actions"><button type="button" className="btn" onClick={() => selectRelative(-1)} aria-label="Vorheriges Meal">←</button><span>{index + 1} / {filtered.length}</span><button type="button" className="btn" onClick={() => selectRelative(1)} aria-label="Nächstes Meal">→</button></div>

          <div className="space-y-6 p-5 sm:p-7">
            <InfoBlock title="Küche & Aufbau" fields={Object.fromEntries(Object.entries(culinary).filter(([key]) => ["Tray type", "Cup", "PROTEIN TYPE", "PROTEIN (GENERAL)", "FORMAT", "MEAL TYPE", "BASE", "SIDE 1", "SIDE 2", "GARNISH", "SEASONALITY", "CUISINE", "CROWD PLEASER"].includes(key)))} />
            <InfoBlock title="Nährwertprofil" fields={nutrition} />
            <InfoBlock title="Produkt & Spezifikation" fields={product} />
            <section className="border-t border-slate-200 pt-5">
              <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Marktkommunikation & Deklaration</h3><div className="inline-flex overflow-hidden rounded-md border border-slate-300 bg-white">{(["DE", "DKSE", "NL", "FR"] as Locale[]).map(item => <button key={item} type="button" onClick={() => setLocale(item)} className={`px-3 py-1.5 text-xs font-semibold ${locale === item ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{item}</button>)}</div></div>
              <div className="mt-4"><InfoBlock title={locale} fields={localFields(selected, locale)} /></div>
            </section>
          </div>
        </main>}
        {!selected && <main className="catalog-detail flex min-h-[20rem] items-center justify-center p-8 text-center text-slate-500">Für {selectedWeek} wurden keine katalogisierten Meals gefunden.</main>}
      </div>
    </div>
  );
}