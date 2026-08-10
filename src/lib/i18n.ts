import type { Market } from "../core/types";

export type UiLocale = "de" | "nl" | "en";

export const MARKET_UI_LOCALE: Record<Market, UiLocale> = {
  BENL: "nl",
  DKSE: "en",
  DE: "de"
};

export const MARKET_LANGUAGE_LABEL: Record<Market, string> = {
  BENL: "BENL",
  DKSE: "DK/SE",
  DE: "DE"
};

export const MARKET_VARIANT_LABEL: Record<UiLocale, Record<Market, string>> = {
  de: {
    BENL: "Benelux",
    DKSE: "DK/SE",
    DE: "Deutschland"
  },
  nl: {
    BENL: "Benelux",
    DKSE: "DK/SE",
    DE: "Duitsland"
  },
  en: {
    BENL: "Benelux",
    DKSE: "DK/SE",
    DE: "Germany"
  }
};

export const UI_INTL_LOCALE: Record<UiLocale, string> = {
  de: "de-DE",
  nl: "nl-NL",
  en: "en-GB"
};

const TEXTS: Record<string, Partial<Record<UiLocale, string>>> = {
  "Rezept": { nl: "Recept", en: "Recipe" },
  "Σ Wochenbestellung": { nl: "Σ Weekorder", en: "Σ Weekly order" },
  "Equipment": { nl: "Equipment", en: "Equipment" },
  "Wochenplaner": { nl: "Weekplanner", en: "Weekly planner" },
  "Kalenderwoche": { nl: "Kalenderweek", en: "Calendar week" },
  "Produzierte Rezepte": { nl: "Geproduceerde recepten", en: "Produced recipes" },
  "Verden Basis": { nl: "Verden basis", en: "Verden base" },
  "Verden Uplift": { nl: "Verden uplift", en: "Verden uplift" },
  "Planmenge per Klick prozentual anheben": { nl: "Planhoeveelheid per klik procentueel verhogen", en: "Increase planned quantity by percentage per click" },
  "Reset": { nl: "Reset", en: "Reset" },
  "Suche leeren": { nl: "Zoekopdracht wissen", en: "Clear search" },
  "Keine Treffer für diese Suche.": { nl: "Geen resultaten voor deze zoekopdracht.", en: "No results for this search." },
  "Keine Rezepte in dieser Woche.": { nl: "Geen recepten in deze week.", en: "No recipes in this week." },
  "Kein Rezept ausgewählt.": { nl: "Geen recept geselecteerd.", en: "No recipe selected." },
  "Lade Daten…": { nl: "Gegevens worden geladen...", en: "Loading data..." },
  "Fehler:": { nl: "Fout:", en: "Error:" },
  "Tipp:": { nl: "Tip:", en: "Tip:" },
  "Übersicht": { nl: "Overzicht", en: "Overview" },
  "Rezeptstruktur": { nl: "Receptstructuur", en: "Recipe structure" },
  "Workflow & Equipment": { nl: "Workflow en equipment", en: "Workflow & equipment" },
  "Brutto-Zutaten (Σ)": { nl: "Bruto-ingrediënten (Σ)", en: "Gross ingredients (Σ)" },
  "🚨 Engpass-Analyse": { nl: "🚨 Bottleneckanalyse", en: "🚨 Bottleneck analysis" },
  "Plating / Anweisungen": { nl: "Plating / instructies", en: "Plating / instructions" },
  "Cook-Schedule": { nl: "Kookschema", en: "Cook schedule" },
  "Produktion (alle Märkte werden gemeinsam gekocht)": { nl: "Productie (alle markten worden samen gekookt)", en: "Production (all markets are cooked together)" },
  "MSKU": { nl: "MSKU", en: "MSKU" },
  "Lokaler Name": { nl: "Lokale naam", en: "Local name" },
  "Yield": { nl: "Yield", en: "Yield" },
  "Allergene": { nl: "Allergenen", en: "Allergens" },
  "Primäre Verpackung": { nl: "Primaire verpakking", en: "Primary packaging" },
  "Compartment": { nl: "Compartment", en: "Compartment" },
  "Sek. Verpackungen": { nl: "Sec. verpakkingen", en: "Secondary packaging" },
  "Märkte verfügbar": { nl: "Beschikbare markten", en: "Markets available" },
  "Keine Daten für diesen Markt.": { nl: "Geen gegevens voor deze markt.", en: "No data for this market." },
  "Engpass-Analyse": { nl: "Bottleneckanalyse", en: "Bottleneck analysis" },
  "Verfügbare Mengen eingeben →": { nl: "Beschikbare hoeveelheden invoeren ->", en: "Enter available quantities ->" },
  "Alle eingegebenen Mengen ausreichend ✓": { nl: "Alle ingevoerde hoeveelheden zijn voldoende ✓", en: "All entered quantities are sufficient ✓" },
  "Engpass": { nl: "Bottleneck", en: "Bottleneck" },
  "Knapp": { nl: "Krap", en: "Tight" },
  "OK": { nl: "OK", en: "OK" },
  "Kritischster Engpass": { nl: "Meest kritische bottleneck", en: "Most critical bottleneck" },
  "Yield-Verlust nach Kochprozess berücksichtigen": { nl: "Yield-verlies per kookproces meenemen", en: "Include yield loss by cooking process" },
  "Sortierung: Standard (Sub-Rezept)": { nl: "Sortering: standaard (subrecept)", en: "Sort: default (sub-recipe)" },
  "Sortierung: Status (kritisch zuerst)": { nl: "Sortering: status (kritisch eerst)", en: "Sort: status (critical first)" },
  "Sortierung: Fehlmenge ↓": { nl: "Sortering: tekort ↓", en: "Sort: shortfall ↓" },
  "Sortierung: Name A–Z": { nl: "Sortering: naam A-Z", en: "Sort: name A-Z" },
  "↓ Alle befüllen": { nl: "↓ Alles vullen", en: "↓ Fill all" },
  "📋 Export TSV": { nl: "📋 TSV exporteren", en: "📋 Export TSV" },
  "✓ Kopiert!": { nl: "✓ Gekopieerd!", en: "✓ Copied!" },
  "Alle zurücksetzen": { nl: "Alles resetten", en: "Reset all" },
  "Verfügbar eingeben": { nl: "Beschikbaar invoeren", en: "Enter available" },
  "Max. Portionen": { nl: "Max. porties", en: "Max portions" },
  "Status": { nl: "Status", en: "Status" },
  "✓ Ausreichend": { nl: "✓ Voldoende", en: "✓ Sufficient" },
  "✗ Engpass": { nl: "✗ Bottleneck", en: "✗ Bottleneck" },
  "— offen": { nl: "— open", en: "— open" },
  "Fehlend": { nl: "Ontbreekt", en: "Missing" },
  "Wochenboard": { nl: "Weekboard", en: "Week board" },
  "geplant": { nl: "gepland", en: "planned" },
  "offen": { nl: "open", en: "open" },
  "🗑 Kalender leeren": { nl: "🗑 Kalender leegmaken", en: "🗑 Clear calendar" },
  "Verfügbare Rezepte": { nl: "Beschikbare recepten", en: "Available recipes" },
  "✓ Alle Rezepte verplant": { nl: "✓ Alle recepten ingepland", en: "✓ All recipes scheduled" },
  "Sub-Rezepte": { nl: "Subrecepten", en: "Sub-recipes" },
  "Planungsmodus": { nl: "Planningsmodus", en: "Planning mode" },
  "Schichtmodell": { nl: "Ploegmodel", en: "Shift model" },
  "Kapazitätsprüfungen": { nl: "Capaciteitscontroles", en: "Capacity checks" },
  "Stationskonflikte": { nl: "Stationconflicten", en: "Station conflicts" },
  "Poolkonflikte": { nl: "Poolconflicten", en: "Pool conflicts" },
  "Automatik": { nl: "Automatiek", en: "Automation" },
  "Auto-Vorschläge": { nl: "Automatische voorstellen", en: "Auto suggestions" },
  "Szenarioverwaltung": { nl: "Scenariobeheer", en: "Scenario management" },
  "Klonen": { nl: "Klonen", en: "Clone" },
  "Leeren": { nl: "Leegmaken", en: "Clear" },
  "Geplant": { nl: "Gepland", en: "Planned" },
  "Offen": { nl: "Open", en: "Open" },
  "Konflikte": { nl: "Conflicten", en: "Conflicts" },
  "Szenario": { nl: "Scenario", en: "Scenario" },
  "Schichten aktiv": { nl: "Actieve ploegen", en: "Shifts active" },
  "Slots/Woche": { nl: "Slots/week", en: "Slots/week" },
  "Vorschläge": { nl: "Voorstellen", en: "Suggestions" },
  "Modell": { nl: "Model", en: "Model" },
  "Shelf-Life-Risiko der Woche": { nl: "Shelf-life-risico van de week", en: "Shelf-life risk of the week" },
  "kritisch": { nl: "kritiek", en: "critical" },
  "Wochenrhythmus Donnerstag bis Sonntag": { nl: "Weekritme donderdag tot zondag", en: "Weekly rhythm Thursday to Sunday" },
  "Wochenrhythmus Montag bis Sonntag": { nl: "Weekritme maandag tot zondag", en: "Weekly rhythm Monday to Sunday" },
  "Konflikte & Engpässe": { nl: "Conflicten en bottlenecks", en: "Conflicts & bottlenecks" },
  "Rezept-Zuordnung": { nl: "Recepttoewijzing", en: "Recipe assignment" },
  "Code": { nl: "Code", en: "Code" },
  "Top-Stationen": { nl: "Topstations", en: "Top stations" },
  "Vorschlag": { nl: "Voorstel", en: "Suggestion" },
  "Plan-Slot": { nl: "Planslot", en: "Plan slot" },
  "nicht geplant": { nl: "niet gepland", en: "not planned" },
  "an": { nl: "aan", en: "on" },
  "aus": { nl: "uit", en: "off" }
};

export function marketToLocale(market: Market): UiLocale {
  // UI-Sprache ist global immer Deutsch; Marktwechsel betrifft nur Marktdaten
  // (z. B. lokale Meal-/Rezeptnamen), nicht die Oberflächensprache.
  void market;
  return "de";
}

export function formatNumber(locale: UiLocale, value: number, digits = 0): string {
  return value.toLocaleString(UI_INTL_LOCALE[locale], { maximumFractionDigits: digits });
}

export function formatDateTime(locale: UiLocale, value: string | number | Date): string {
  return new Date(value).toLocaleString(UI_INTL_LOCALE[locale]);
}

export function tl(locale: UiLocale, text: string): string {
  if (locale === "de") return text;
  return TEXTS[text]?.[locale] ?? text;
}

export function marketVariantLabel(locale: UiLocale, market: Market): string {
  return MARKET_VARIANT_LABEL[locale][market];
}