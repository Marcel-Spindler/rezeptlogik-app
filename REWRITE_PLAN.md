# Rewrite-Plan: rezeptlogik-app v2

**Datum:** 2026-05-26  
**Status:** Entwurf — wartet auf `export-sub-recipes-by-recipe-detailed` CSV-Beispiel

---

## 1. Motivation

Die aktuelle App ist über viele Iterationen gewachsen und hat erheblichen Ballast angesammelt:

- `App.tsx` ist 4.126 Zeilen — enthält Views, Business-Logik, Utility-Funktionen und State in einer einzigen Datei
- 8 verschiedene Views, von denen viele nicht aktiv genutzt werden (WMS Live, Rack, Wochenplaner, Rundmail, What-if)
- 9 Datenquellen in `DataBundle`, davon werden zukünftig nur 3–4 benötigt
- 18 Sync-Scripts, von denen ein Großteil für abgekündigte Features existiert
- Die Typ-Definitionen mischen aktive und legacy Felder, was das Lesen erschwert

**Ziel:** Neustart auf einer sauberen, minimalen Basis — nur das, was wirklich gebraucht wird.

> **Constraint:** Die **Planning OASE View bleibt erhalten** — sie wird als eigenständige Komponente aus dem aktuellen Code herausgelöst und in die neue Struktur übernommen.

---

## 2. Neue Datenbasis — 3 Quellen

### 2.1 WeekRecipes (bestehend)

- **Quelle:** Google Sheets (bestehender Tab, Format bereits bekannt)
- **Inhalt:** Welche Rezepte werden in welcher KW produziert, mit Portionsmengen je Markt (BENL, DKSE, DE)
- **Script:** `scripts/import-gsheet.ts` — wird vereinfacht beibehalten

```
Felder (Kern):
  hfWeek       "2026-W22"
  code         "FE4009A"
  recipeName   "Chicken Tikka"
  preference   "P+", "Keto", ...
  verdenVolume { BENL, DKSE, DE }
```

### 2.2 Ramp-Up Zahlen (bestehend, vereinfacht)

- **Quelle:** Google Sheets — Maitre Inputs Tab (Fulfillment Report)
- **Inhalt:** Volumen-Snapshots je Rezept und Woche — von 4 Wochen vor Lieferung bis Endbestellung
- **Snapshots:** `wed-4wk`, `wed-3wk`, `wed-2wk`, `wed-1wk`, `fri-1wk`, `mon`, `tue`, `wed`, `thu`
- **Script:** `scripts/sync-factor-forecast.ts` — wird vereinfacht beibehalten

```
Felder (Kern):
  week         "W22"
  market       "DE" | "NORDICS"
  recipeCode   "FE4009A"
  recipeName   lokaler Name
  snapshots    { wed-4wk: 800, wed-3wk: 950, ..., thu: 1100 }
  orderVolume  finale Bestellmenge
```

### 2.3 Sub-Recipe Detail (neu / wird angeliefert)

- **Quelle:** `export-sub-recipes-by-recipe-detailed.csv` — Export aus dem Rezept-System
- **Inhalt:** Vollständiger Rezeptbaum — Main Recipe → Sub-Rezepte (bis 4 Ebenen) → Zutaten
- **Script:** wird neu geschrieben, sobald CSV-Format bekannt ist

```
Erwartete Felder (Schema folgt nach CSV-Beispiel):
  recipe_code / recipe_id
  sub_recipe_id / sub_recipe_name
  sub_recipe_categories    (Cook Methods, z. B. "GRILL, BLAST CHILLER")
  ingredient_id / ingredient_name
  gross_qty / net_qty / uom
  hierarchy_level          (1–4)
```

---

## 3. Neue Datenmodell-Typen

Die neue `types.ts` wird auf ~100 Zeilen reduziert (aktuell 252 Zeilen mit Legacy-Feldern).

```typescript
// Die drei Kern-Typen:

export type Market = "BENL" | "DKSE" | "DE";

export interface WeekRecipe {
  hfWeek: string;           // "2026-W22"
  code: string;             // "FE4009A"
  recipeName: string;
  preference: string;
  verdenVolume: { BENL: number; DKSE: number; DE: number };
}

export type RampUpLabel =
  "wed-4wk" | "wed-3wk" | "wed-2wk" | "wed-1wk" |
  "fri-1wk" | "mon" | "tue" | "wed" | "thu";

export interface RampUpEntry {
  week: string;             // "W22"
  market: string;           // "DE" | "NORDICS"
  recipeCode: string;
  recipeName: string;
  snapshots: Partial<Record<RampUpLabel, number>>;
  orderVolume: number;
}

export interface SubRecipeNode {
  id: string;
  name: string;
  categories: string;       // Cook Methods, z. B. "GRILL, BLAST CHILLER"
  quantity?: number;
  uom?: string;
  children: SubRecipeNode[];
  ingredients: RecipeIngredient[];
}

export interface RecipeIngredient {
  id: string;
  name: string;
  grossQty: number;
  netQty: number;
  uom: string;
  allergen?: string;
}

export interface RecipeDetail {
  code: string;
  name: string;
  market: Market;
  subRecipes: SubRecipeNode[];
}

// Das neue DataBundle — nur 4 Felder:
export interface DataBundle {
  generatedAt: string;
  weeks: string[];
  weekRecipes: WeekRecipe[];
  rampUp: RampUpEntry[];
  recipeDetails: Record<string, RecipeDetail[]>; // key = recipeCode, value = je Markt ein Eintrag
}
```

---

## 4. Neue Dateistruktur

```
src/
  main.tsx              — unverändert
  App.tsx               — neu, ~250 Zeilen
  types.ts              — neu, ~120 Zeilen (s.o.)
  dataSource.ts         — vereinfacht, ~80 Zeilen
  firebase.ts           — unverändert
  vite-env.d.ts         — unverändert

  components/
    Shell.tsx           — Header + Layout-Wrapper
    WeekSelector.tsx    — KW-Dropdown + Portionen-Übersicht
    RecipeList.tsx      — Rezeptliste (links, scrollbar)
    RecipeDetail.tsx    — Haupt-Detailansicht (rechts)
    RampUpPanel.tsx     — Ramp-Up Sparkline + Tabelle
    SubRecipeTree.tsx   — Rezeptbaum aus Detailed Export

  planning-oasis/       ← Planning OASE bleibt, wird als eigener Ordner herausgelöst
    PlanningOasisView.tsx     — bestehende View, unverändert übernommen
    PlanningOasisAgentForm.tsx
    planningOasisData.ts
    planningTruthData.ts
    (alle internen Abhängigkeiten bleiben erhalten)

scripts/
  import-week-recipes.ts    — GSheets → WeekRecipes (aus import-gsheet.ts)
  import-rampup.ts          — GSheets → RampUpEntries (aus sync-factor-forecast.ts)
  import-sub-recipes.ts     — CSV → RecipeDetails (neu)
  push-firestore.ts         — alle Collections in Firestore schreiben (vereinfacht)

public/
  data/
    data.json           — lokaler Fallback (optional, für Offline-Entwicklung)
```

**Gelöschte Dateien (aktuell in src/):**
- `equipment.ts` (Equipment-Kapazitäts-Logik — nicht mehr gebraucht)
- `planner.ts`, `rack.ts`, `rackV2.ts`, `RackV2View.tsx`
- `PlanningView.tsx` (alter Wochenplaner)
- `PlanningEmailView.tsx`
- `WmsLiveView.tsx`
- `WhatIfView.tsx`
- `BreakdownEquipmentView.tsx`
- `LinePlanningView.tsx`
- `rampUpHistory.ts` (Logik geht in `components/RampUpPanel.tsx` auf)
- `i18n.ts` (mehrsprachige Unterstützung entfällt, alles auf Deutsch)
- `runPlanning.ts`, `planExport.ts`, `yieldCalculator.ts`
- `dynamicImport.ts`, `ShareDashboard.tsx`

**Planning OASE — bleibt:**
- `PlanningOasisView.tsx` → nach `src/planning-oasis/` verschoben, inhaltlich unverändert
- `PlanningOasisAgentForm.tsx`, `planningOasisData.ts`, `planningTruthData.ts` → mitgenommen
- Die Planning OASE bekommt einen eigenen Tab in der neuen Navigation

**Gelöschte Scripts:**
- `sync-wms-cache.ts`, `push-wms-firestore.ts`, `push-wms-transaction-log.ts`
- `sync-wms-kw-tabs.ts`, `sync-wms-kw-reports.ts`, `wms-local-server.ts`
- `sync-fulfillment-report.ts` (Logik geht in `import-rampup.ts` auf)
- `sync-running-forecast.ts`, `rackfile-tool.ts`
- `import-pfei.ts`, `read-open-shelf.ts`, `dump-gsheet.ts`
- `extract-meal-translations.ts`, `test-automatik.ts`
- `refresh-gsheet-sources.ts` (wird nicht mehr gebraucht)

---

## 5. Views / Komponenten im Detail

### 5.1 App.tsx — Haupt-Layout

```
┌───────────────────────────────────────────────────────────────┐
│  Header: "Factor OPS Planner"                                 │
│  Tabs: [Rezept] [Planning OASE]                               │
├──────────────────────┬────────────────────────────────────────┤
│  WeekSelector        │                                        │
│  [KW-Dropdown]       │  Tab: Rezept                          │
│  Portionen-Summen    │  ┌── RampUpPanel ──────────────────┐  │
│  Delta Vorwoche      │  │  Sparkline + Snapshot-Tabelle   │  │
│  ──────────────────  │  └─────────────────────────────────┘  │
│  RecipeList          │  ┌── SubRecipeTree ─────────────────┐  │
│  [scrollbare Liste]  │  │  Rezeptbaum (Sub-Rezepte)       │  │
│  Suche               │  └─────────────────────────────────┘  │
│                      │                                        │
│                      │  Tab: Planning OASE                   │
│                      │  [bestehende PlanningOasisView]        │
└──────────────────────┴────────────────────────────────────────┘
```

State in App.tsx:
- `selectedWeek` — persistiert in localStorage
- `selectedRecipe` — persistiert in localStorage
- `activeTab: "recipe" | "planning-oasis"` — persistiert in localStorage
- `data: DataBundle | null`
- `searchText`

### 5.2 WeekSelector.tsx

- Dropdown mit allen verfügbaren KWs
- Zeigt je KW: Anzahl produzierter Rezepte, Gesamtportionen (BENL + DKSE + DE)
- Delta-Anzeige zur Vorwoche (Δ Portionen, Δ Rezepte, neu/weggefallen)
- Kein Uplift-Slider (wurde selten genutzt, kann später ergänzt werden)

### 5.3 RecipeList.tsx

- Scrollbare Liste aller Rezepte der gewählten KW
- Sortiert nach Gesamtportionen (absteigend)
- Je Eintrag: Code, Name, Preference-Tag, Portionen je Markt als Pills
- Suchfeld filtert nach Code, Name, Preference
- Aktives Rezept farblich hervorgehoben

### 5.4 RecipeDetail.tsx

Wrapper-Komponente, die `RampUpPanel` und `SubRecipeTree` zusammenfasst.

Header zeigt:
- Rezeptname + Code
- Preference-Tag
- Portionen je Markt (BENL / DKSE / DE)

### 5.5 RampUpPanel.tsx

Visualisiert die Ramp-Up-Kurve für das gewählte Rezept:

```
Snapshot-Timeline:
  wed-4wk → wed-3wk → wed-2wk → wed-1wk → fri-1wk → mon → tue → wed → thu
     800       870       920       980      1010      1050  1070  1090  1100

[Sparkline SVG]

Tabelle:
  Zeitpunkt   | DE     | NORDICS
  4 Wo. vorher| 800    | 320
  3 Wo. vorher| 870    | 355
  ...
  Endbestellung| 1100  | 401
```

- Δ zwischen erster und letzter Snapshot-Messung als Pill (grün/rot)
- Markt-Filter (DE / NORDICS)

### 5.6 SubRecipeTree.tsx

Visualisiert den Rezeptbaum aus `export-sub-recipes-by-recipe-detailed`:

```
▼ Chicken Tikka (FE4009A)
   ▼ Marinade [MARINADE]
      • Yoghurt 150g
      • Garlic Paste 20g
   ▼ Chicken Breast [OVEN, BLAST CHILLER]
      • Chicken Breast 200g
   ▼ Sauce [BRAISER]
      ▼ Tomato Base [HAND MIX]
         • Crushed Tomatoes 180g
         • Cumin 5g
```

- Alle Ebenen initial ausgeklappt (oder ein-/ausklappbar)
- Cook-Method-Kategorien als farbige Tags je Sub-Rezept
- Mengenangaben in lesbarerer Form (g / kg, ml / L)
- Markt-Wechsler oben (BENL / DKSE / DE) falls Struktur marktspezifisch ist

---

## 6. Daten-Pipeline (Scripts)

### 6.1 `import-week-recipes.ts`

**Basis:** Bestehende Logik aus `import-gsheet.ts`  
**Output:** `weekRecipes` Collection in Firestore

```
GSheets Tab "Rampup" / "Week Recipes"
  → Zeilen parsen (hfWeek, code, recipeName, preference, BENL/DKSE/DE Portionen)
  → Fehlende / inkonsistente Zeilen loggen
  → Batch-Write in Firestore: apps/rezeptlogik/weekRecipes/{code_week}
```

### 6.2 `import-rampup.ts`

**Basis:** Vereinfachte Logik aus `sync-factor-forecast.ts`  
**Output:** `rampUp` Collection in Firestore

```
GSheets Tab "Maitre Inputs DE" + "Maitre Inputs Nordics"
  → Snapshot-Spalten je Zeitpunkt (wed-4wk … thu) einlesen
  → RampUpEntry je Zeile aufbauen
  → Batch-Write: apps/rezeptlogik/rampUp/{week_market_recipeCode}
```

### 6.3 `import-sub-recipes.ts` (neu)

**Input:** `export-sub-recipes-by-recipe-detailed.csv`  
**Output:** `recipeDetails` Collection in Firestore

```
CSV einlesen (papaparse)
  → Zeilen nach recipe_code gruppieren
  → Hierarchie aufbauen (sub_recipe_id + parent-Felder → Baum)
  → RecipeDetail[] je Code
  → Batch-Write: apps/rezeptlogik/recipeDetails/{code}
```

> **Offen:** CSV-Schema wird nach Beispiel-Export festgelegt.

### 6.4 `push-firestore.ts` (vereinfacht)

Führt die drei Import-Scripts nacheinander aus und schreibt `generatedAt` + `weeks`-Array in das Root-Dokument `apps/rezeptlogik`.

```bash
# Alles in einem:
npm run sync:all
# = import-week-recipes + import-rampup + import-sub-recipes + push-firestore
```

---

## 7. Firestore-Struktur (neu, vereinfacht)

```
apps/rezeptlogik/                   ← Root-Dokument
  generatedAt: "2026-05-26T..."
  weeks: ["2026-W20", "2026-W21", ...]
  rampUpHash: "abc123"              ← für Live-Refresh-Trigger

  /weekRecipes/{code}_{week}/       ← z. B. "FE4009A_2026-W22"
    hfWeek, code, recipeName, preference, verdenVolume

  /rampUp/{week}_{market}_{code}/   ← z. B. "W22_DE_FE4009A"
    week, market, recipeCode, recipeName, snapshots, orderVolume

  /recipeDetails/{code}/            ← z. B. "FE4009A"
    code, name, market, subRecipes[]
```

---

## 8. `dataSource.ts` (neu, vereinfacht)

```typescript
export async function loadData(): Promise<DataBundle> {
  // Firestore-Pfad oder lokales data.json (Fallback)
}

export function subscribeRampUpHashChanges(cb: () => void): () => void {
  // Unverändert — Firestore onSnapshot auf apps/rezeptlogik
}

export async function refreshRampUpOnStart(): Promise<void> {
  // POST /api/refresh-ramp-up — unverändert
}
```

Keine Änderung an der Firebase-Function — der Live-Refresh-Mechanismus bleibt wie er ist.

---

## 9. package.json Scripts (bereinigt)

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview --port 5173",

    "import:week-recipes": "tsx scripts/import-week-recipes.ts",
    "import:rampup":       "tsx scripts/import-rampup.ts",
    "import:sub-recipes":  "tsx scripts/import-sub-recipes.ts",
    "push:firestore":      "tsx scripts/push-firestore.ts",

    "sync:all":         "npm run import:week-recipes && npm run import:rampup && npm run import:sub-recipes && npm run push:firestore",
    "sync:all:deploy":  "npm run sync:all && npm run build && npx firebase-tools deploy --only hosting",

    "deploy":           "npm run build && npx firebase-tools deploy --only hosting",
    "deploy:functions": "cd functions && npm install && npx firebase-tools deploy --only functions",
    "deploy:all":       "npm run build && npx firebase-tools deploy --only hosting,functions"
  }
}
```

---

## 10. Was bleibt unverändert

| Datei / Bereich | Grund |
|---|---|
| `firebase.ts` | Firebase-Config ist stabil |
| `functions/index.js` | Cloud Function für Ramp-Up-Refresh bleibt |
| `vite.config.ts` | Kein Änderungsbedarf |
| `tailwind.config.js` | Kein Änderungsbedarf |
| `tsconfig.json` | Kein Änderungsbedarf |
| `.env` / Firebase-Credentials | Kein Änderungsbedarf |
| `public/` (statische Assets) | Kein Änderungsbedarf |

---

## 11. Migrations-Reihenfolge

```
Phase 1 — Typen & Datenpipeline (kein UI)
  1. Neues types.ts schreiben
  2. import-week-recipes.ts fertigstellen (aus bestehendem Script)
  3. import-rampup.ts fertigstellen (aus bestehendem Script)
  4. import-sub-recipes.ts schreiben (nach CSV-Beispiel) ← wartet auf CSV
  5. push-firestore.ts vereinfachen
  6. Sync einmal durchlaufen, Firestore prüfen

Phase 2 — Planning OASE herauslösen
  7. src/planning-oasis/ Ordner anlegen
  8. PlanningOasisView.tsx + Abhängigkeiten dorthin verschieben
  9. Imports in App.tsx anpassen, sicherstellen dass OASE noch funktioniert
  10. Smoke-Test: Planning OASE läuft noch korrekt

Phase 3 — neues UI bauen
  11. Shell.tsx + App.tsx (Skeleton mit 2 Tabs)
  12. WeekSelector.tsx + RecipeList.tsx
  13. RampUpPanel.tsx
  14. SubRecipeTree.tsx
  15. RecipeDetail.tsx (fasst 13+14 zusammen)
  16. dataSource.ts vereinfachen

Phase 4 — Aufräumen & Deploy
  17. Alle alten src/-Dateien löschen (Liste s. Abschnitt 4)
  18. Alle nicht mehr benötigten Scripts löschen
  19. package.json bereinigen
  20. Build + Typecheck + Deploy
```

---

## 12. Offene Punkte

| # | Frage | Warte auf |
|---|---|---|
| 1 | CSV-Schema von `export-sub-recipes-by-recipe-detailed` | Marcel schickt Beispiel-CSV |
| 2 | Sind die Markt-Spalten in der Sub-Recipe CSV vorhanden oder eine CSV je Markt? | CSV-Beispiel |
| 3 | Soll `orderVolume` aus dem Ramp-Up als "geplante Produktion" in der Rezeptliste angezeigt werden, zusätzlich zu den `verdenVolume`-Portionen? | Klärung |
| 4 | Soll es weiterhin einen Uplift-Slider geben? | Entscheidung |
| 5 | Welcher Branch — neuer `rewrite/v2` oder direkt auf `main`? | Präferenz |
