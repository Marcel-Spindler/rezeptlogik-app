import { memo, useState } from "react";
import type { DataBundle, MealCatalogEntry, WeekRecipe } from "../../core/types";
import { fmtNum, resolveRecipeByCode } from "../../lib/helpers";
import { getBaseVerdenVolume } from "../../lib/equipment";
import { field, label, localFields, metric, subtitleOf, tagsOf, titleOf, findWeekMatches, type Locale } from "./catalog-utils";
import { resolveMealPhotoUrl, type ImageOverride } from "./useImageOverrides";
import { ImagePickerModal } from "./ImagePickerModal";

const InfoBlock = memo(function InfoBlock({ title, fields }: { title: string; fields: Record<string, string> }) {
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
});

function ProductionMatch({ matches, mealId, week, upliftPercent, onOpenRecipe, onOpenPlanning, onOpenWms }: {
  matches: WeekRecipe[];
  mealId: string;
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
  const matchLabel = primary.code === mealId ? "Exakter Code-Match" : `FE/FV-Match über ${primary.code.replace(/[^0-9]/g, "")}`;
  return (
    <section className="catalog-production">
      <div><span>Produktion · {week}</span><strong>{fmtNum(total)} Meals</strong><small>{primary.code} · {matchLabel}</small></div>
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

interface CatalogDetailProps {
  selected: MealCatalogEntry;
  data: DataBundle;
  selectedWeek: string;
  upliftPercent: number;
  index: number;
  total: number;
  isFavorite: boolean;
  isInCompare: boolean;
  imageOverride?: ImageOverride;
  onConfirmImage: () => void;
  onRejectImage: () => void;
  onResetImage: () => void;
  onPickImage: (url: string) => void;
  onToggleFavorite: () => void;
  onToggleCompare: () => void;
  onSelectRelative: (offset: number) => void;
  onSelectWeek: (week: string) => void;
  onOpenRecipe: (code: string) => void;
  onOpenPlanning: (code: string) => void;
  onOpenWms: () => void;
}

export function CatalogDetail({
  selected, data, selectedWeek, upliftPercent,
  index, total, isFavorite, isInCompare, imageOverride,
  onConfirmImage, onRejectImage, onResetImage, onPickImage,
  onToggleFavorite, onToggleCompare, onSelectRelative, onSelectWeek,
  onOpenRecipe, onOpenPlanning, onOpenWms,
}: CatalogDetailProps) {
  const [locale, setLocale] = useState<Locale>("DE");
  const [imgError, setImgError] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const culinary = selected.sheets?.["Meal DB_Culinary"] ?? {};
  const product = selected.sheets?.["Meal DB_Product"] ?? {};
  const nutrition = selected.sheets?.["Meal DB_Nutrition"] ?? {};
  const currentWeekMatches = findWeekMatches(selected, data, selectedWeek);
  const availableWeeks = data.weeks.filter(week => findWeekMatches(selected, data, week).length > 0);

  const isImageRejected = imageOverride && "hidden" in imageOverride;
  const isImageConfirmed = imageOverride && "url" in imageOverride;
  const overrideUrl = isImageConfirmed && imageOverride && "url" in imageOverride ? imageOverride.url : undefined;

  // Fuer Picker-Vorbelegung + "Geaendert/Bestaetigt"-Badge: rohe Kombination.
  const effectivePhotoUrl = overrideUrl ?? selected.photoUrl;
  // Fuers tatsaechlich angezeigte Bild: derselbe Resolver wie in der Rezeptliste.
  const resolvedPhotoUrl = resolveMealPhotoUrl(selected, imageOverride);
  const directImage = !imgError && resolvedPhotoUrl ? resolvedPhotoUrl : undefined;

  const metrics: [string, string, string][] = [
    ["Gewicht", metric(selected, "MEAL WEIGHT (g)"), "g"],
    ["Kalorien", metric(selected, "CALORIES"), "kcal"],
    ["Protein", metric(selected, "PROTEIN (g)"), "g"],
    ["Kohlenhydrate", metric(selected, "CARBS (g)"), "g"],
    ["Fett", metric(selected, "FAT (g)"), "g"],
  ];

  return (
    <main className="catalog-detail">
      <div className="catalog-hero">
        <div className="catalog-hero-copy">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-cyan-800">{selected.mealId}</span>
            {field(selected, "Meal DB_Culinary", "STATUS") && <span className="catalog-status">{field(selected, "Meal DB_Culinary", "STATUS")}</span>}
            <button type="button" onClick={onToggleCompare} className="ml-auto border border-white/30 px-2 py-0.5 text-[10px] font-bold uppercase text-white/85 hover:bg-white/10" aria-pressed={isInCompare}>
              {isInCompare ? "Im Vergleich" : "Vergleichen"}
            </button>
            <button type="button" onClick={onToggleFavorite} className="text-lg leading-none" aria-label={isFavorite ? "Aus Merkliste entfernen" : "Zur Merkliste hinzufügen"} title={isFavorite ? "Favorit entfernen" : "Als Favorit merken"}>
              {isFavorite ? <span className="text-amber-400">&#9733;</span> : <span className="text-white/40 hover:text-amber-300">&#9734;</span>}
            </button>
          </div>
          <h2 className="mt-3 text-2xl font-bold leading-tight text-white">{titleOf(selected)}</h2>
          {subtitleOf(selected) && <p className="mt-2 max-w-2xl text-base text-slate-600">{subtitleOf(selected)}</p>}
          <div className="mt-4 flex flex-wrap gap-1.5">
            {tagsOf(selected).map(item => <span key={item} className="catalog-tag">{label(item)}</span>)}
          </div>
        </div>
        {directImage ? (
          <a href={selected.photoSourceUrl || directImage} target="_blank" rel="noreferrer" className="relative cursor-pointer group" title={`Bilder-Ordner öffnen · ${selected.mealId}`}>
            <img className="catalog-image" src={directImage} alt={titleOf(selected)} onError={() => setImgError(true)} />
            <span className="absolute inset-0 flex items-end justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
              <span className="mb-2 hidden group-hover:block border border-white/80 bg-black/60 px-2 py-1 text-[10px] font-bold text-white">Bilder-Ordner</span>
            </span>
          </a>
        ) : (
          <div className="catalog-art">
            <span>{field(selected, "Meal DB_Culinary", "PROTEIN TYPE") || field(selected, "Meal DB_Culinary", "MEAL TYPE") || "MEAL"}</span>
            {selected.photoSourceUrl && <a href={selected.photoSourceUrl} target="_blank" rel="noreferrer">Bildquelle öffnen</a>}
          </div>
        )}
        {showPicker && (
          <ImagePickerModal
            mealId={selected.mealId}
            currentUrl={effectivePhotoUrl}
            onSelect={url => { onPickImage(url); setImgError(false); }}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>

      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-5 py-2 text-[11px]">
        <span className="font-semibold text-slate-500">Bild:</span>
        {isImageConfirmed && overrideUrl !== selected.photoUrl && <span className="text-cyan-700 font-bold">Geändert</span>}
        {isImageConfirmed && overrideUrl === selected.photoUrl && <span className="text-green-700 font-bold">Bestätigt</span>}
        {isImageRejected && <span className="text-red-600 font-bold">Abgelehnt</span>}
        {!imageOverride && <span className="text-slate-400">Nicht bewertet</span>}
        <span className="ml-auto flex gap-1.5">
          <button type="button" onClick={() => setShowPicker(true)} className="border border-cyan-300 bg-cyan-50 px-2 py-0.5 text-cyan-800 hover:bg-cyan-100">Bild wählen</button>
          {!isImageConfirmed && selected.photoUrl && <button type="button" onClick={onConfirmImage} className="border border-green-300 bg-green-50 px-2 py-0.5 text-green-800 hover:bg-green-100">Passt</button>}
          {!isImageRejected && selected.photoUrl && <button type="button" onClick={onRejectImage} className="border border-red-300 bg-red-50 px-2 py-0.5 text-red-800 hover:bg-red-100">Falsch</button>}
          {imageOverride && <button type="button" onClick={onResetImage} className="border border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-100">Reset</button>}
        </span>
      </div>

      <div className="catalog-metrics">
        {metrics.map(([name, value, unit]) => (
          <div key={name}><span>{name}</span><strong>{value || "–"}{value ? ` ${unit}` : ""}</strong></div>
        ))}
      </div>

      <div className="p-5 pb-0 sm:px-7 sm:pt-7">
        <ProductionMatch matches={currentWeekMatches} mealId={selected.mealId} week={selectedWeek} upliftPercent={upliftPercent} onOpenRecipe={onOpenRecipe} onOpenPlanning={onOpenPlanning} onOpenWms={onOpenWms} />
        {availableWeeks.length > 0 && (
          <div className="catalog-week-match">
            <span>{availableWeeks.length === 1 && availableWeeks[0] === selectedWeek ? "Produktion nur in dieser KW" : "Alle Produktionswochen"}</span>
            {availableWeeks.map(week => <button key={week} type="button" onClick={() => onSelectWeek(week)} className={week === selectedWeek ? "is-current" : ""}>{week}</button>)}
          </div>
        )}
        {currentWeekMatches[0] && (() => {
          const recipe = resolveRecipeByCode(data.recipes, currentWeekMatches[0].code);
          return recipe && (
            <div className="catalog-operations-summary">
              <span>Operative Daten verknüpft</span>
              <span>{Object.keys(recipe.markets).length} Märkte</span>
              <span>{Object.values(recipe.markets).reduce((total, market) => total + market.subRecipes.length, 0)} Sub-Rezepte</span>
              <span>{Object.values(recipe.grossIngredients).reduce((total, rows) => total + (rows?.length ?? 0), 0)} Brutto-Zutaten</span>
            </div>
          );
        })()}
      </div>

      <div className="catalog-actions">
        <button type="button" className="btn" onClick={() => onSelectRelative(-1)} aria-label="Vorheriges Meal">←</button>
        <span>{index + 1} / {total}</span>
        <button type="button" className="btn" onClick={() => onSelectRelative(1)} aria-label="Nächstes Meal">→</button>
      </div>

      <div className="space-y-6 p-5 sm:p-7">
        <InfoBlock title="Küche & Aufbau" fields={Object.fromEntries(Object.entries(culinary).filter(([key]) => ["Tray type", "Cup", "PROTEIN TYPE", "PROTEIN (GENERAL)", "FORMAT", "MEAL TYPE", "BASE", "SIDE 1", "SIDE 2", "GARNISH", "SEASONALITY", "CUISINE", "CROWD PLEASER"].includes(key)))} />
        <InfoBlock title="Nährwertprofil" fields={nutrition} />
        <InfoBlock title="Produkt & Spezifikation" fields={product} />
        <section className="border-t border-slate-200 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Marktkommunikation & Deklaration</h3>
            <div className="inline-flex overflow-hidden rounded-md border border-slate-300 bg-white">
              {(["DE", "DKSE", "NL", "FR"] as Locale[]).map(item => (
                <button key={item} type="button" onClick={() => setLocale(item)} className={`px-3 py-1.5 text-xs font-semibold ${locale === item ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                  {item}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4"><InfoBlock title={locale} fields={localFields(selected, locale)} /></div>
        </section>
      </div>
    </main>
  );
}
