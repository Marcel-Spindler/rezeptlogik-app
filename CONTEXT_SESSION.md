# rezeptlogik-app — Kontext für neuen Chat (Stand 2026-05-27)

## Was ist die App

**Factor OPS Planner** — internes Planungstool für HelloFresh Verden (VF).  
React 18 + TypeScript + Vite + Tailwind CSS 3, Firebase Firestore (europe-west3) + Cloud Functions.  
Deployed auf Firebase Hosting. Daten kommen aus Firestore (realtime) + Google Sheets (Service Account).

Service Account: `planningmsku@hellofresh-de-problem-solve.iam.gserviceaccount.com`  
**`secrets/service-account.json` ist NIEMALS in git** (in `.gitignore`).

---

## Architektur

```
src/
  App.tsx                         ~530 Zeilen, 3 Haupt-Tabs: Rezept | Planning OASE | Packing
  types.ts                        Alle gemeinsamen Typen (WeekRecipe, Recipe, RecipeStructure …)
  helpers.ts                      Shared Utilities (resolveStructureByCode, adjustedPortions …)
  dataSource.ts                   Firestore-Subscriptions + GSheet-Refresh
  runPlanning.ts                  runSplitForRecipeLike() — Run-Split-Formel
  RecipeDetailView.tsx            ~1300 Zeilen, 8 Tabs:
                                    overview | subrecipes | structure | ingredients |
                                    engpass  | plating    | cook      | workflow
  PackingScheduleView.tsx         Packing-Tab (Do/Fr/Sa Farbkodierung)
  ManufacturingCalendarView.tsx   Küchenkalender (eine Woche voraus planen)
  LinePlanningView.tsx            Plating-Linien Drag & Drop
  RackV2View.tsx                  Fulfillment Rack
  planning-oasis/
    PlanningOasisView.tsx         Container: mfg / lines / rack / cockpit
    PlanningOasisAgentForm.tsx
  components/
    WeekSelector.tsx
    RecipeList.tsx
    DataHealthBanner.tsx

scripts/
  import-sub-recipes.ts          CSV → Firestore (structures), Watch-Modus
  import-gsheet.ts               6 GSheets → public/data/data.json
  import-pfei.ts                 PFEI CSV → processSpecs in data.json
  push-firestore.ts              data.json → Firestore pushen
  discover-sheets.ts             Tab-Namen per GSheets API ermitteln
  import-local.ts                Lokale CSVs importieren

functions/
  index.js                       Cloud Functions (refreshOperationalData u.a.)
```

---

## Nomenklatur (wichtig!)

- **FV-Codes** (FV0024A etc.) = Verden produziert diese Rezepte selbst
- **FE-Codes** = werden zugeliefert (extern), Verden produziert sie nicht
- **Märkte:** BENL = Belgien/Niederlande · DKSE = Dänemark/Schweden · DE = Deutschland

---

## CSV-Import (scripts/import-sub-recipes.ts)

Zwei Formate, beide in `imports/` ablegen — werden automatisch zusammengeführt.  
**Watch-Modus:** `npm run dev` startet automatisch einen Watcher — neue CSV ablegen = automatischer Import ohne npm-Befehl.

**Format A — `export-recipes*.csv`** (wöchentlich, bevorzugt)
- Hat FV-Codes (z.B. `FV0024A`) + Markt-Marker `[BNL]` / `[DE]` / `[DKSE]`
- Eine Ebene tief: Rezept → Sub-Recipes mit Koch-Methode + Menge
- → StructureTab in RecipeDetailView
- Firestore-Key = FV-Code

**Format B — `export-sub-recipes-by-recipe-detailed*.csv`** (seltener, optional)
- Kein FV-Code, kein Markt-Marker, plain Rezeptname
- Bis zu 4 Sub-Recipe-Ebenen + Einzelzutaten mit Allergen & Yield%
- → Engpass-Tab, Yield-Rechner, Ingredienten-Übersicht
- Firestore-Key = normalisierter Rezeptname

Aktuell in `imports/`:
- `export-recipes W23.csv` + `export-recipes W24.csv`
- `export-sub-recipes-by-recipe-detailed (1).csv` + `(7).csv`

Letzter Import: **219 Strukturen** in Firestore (28 mit FV-Code + 219 detailliert).

---

## Google Sheets — 6 Quellen

| Env-Var | Sheet-ID | Inhalt |
|---------|----------|--------|
| `GSHEET_ID` | `1IEi_CB9KylW2MgjNiGax5EIvhhAtkIzm57uO1sSESj8` | Ramp-Up Plan primär (Marcel pflegt) |
| `GSHEET_IDS` | `1cQtoL4aYHfc_44mfQQty8-EFKPZoYPLBQ2ojmO8hgzg` | Ramp-Up Plan 2 |
| `SHEET_WOCHENSTART` | `1YscgiuKYVI2pGcMJ3RcJwWGQEkG46RnVnji8q8a4AeE` | Wochenstart-Infos |
| `SHEET_PRINT_ORDERS` | `1fpEHBWmd_zk74wbu78unPoTV_u860smNlxTuioEdq-4` | Print Orders Sleeven |
| `SHEET_KITCHEN_PRIORITY` | `13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U` | Kitchen Priority |
| `SHEET_FERTIGSTELLUNG` | `1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY` | Fertigstellungszeitplan (Do/Fr/Sa) |

---

## Firestore Collections (alle unter `apps/rezeptlogik/`)

| Collection | Inhalt | Key |
|---|---|---|
| `weekRecipes` | Ramp-Up je Rezept und KW | `{hfWeek}__{code}__{i}` |
| `recipes` | Rezept-Stammdaten + Zutaten | recipe code |
| `structures` | Sub-Recipe-Strukturen aus CSV | FV-Code oder normalisierter Name |
| `cookSchedules` | Cook-Methoden + Zeiten | cookMethod (sanitized) |
| `processSpecs` | PFEI Prozess-Specs | subRecipeId |
| `shelfLifeBySku` | Haltbarkeitsdaten | encodeURIComponent(skuCode) |
| `productionPlan/{week}` | Fertigstellungszeitplan Sheet 6 | z.B. `2026-W23` |
| `printOrders` | Print Orders Sleeven | `{week}__{code}__{msku}` |
| `kitchenPriority/current` | Kitchen Priority Sheet 3 | `{ rows, updatedAt }` |

---

## Wichtige Typen (src/types.ts)

```typescript
type Market = "BENL" | "DKSE" | "DE"

interface RecipeStructure {
  code: string          // FV-Code oder normalisierter Name
  recipeId: string
  name: string
  markets: Partial<Record<Market, DetailedSubRecipe[]>>
}

interface DetailedSubRecipe {
  id: string; name: string; categories: string
  quantity?: number; uom?: string
  subRecipes: DetailedSubRecipe[]
  ingredients: DetailedIngredient[]
}

interface WeekRecipe {
  hfWeek: string        // "2026-W23"
  code: string          // Family code "FE4009A"
  recipeName: string
  verdenVolume: { BENL: number; DKSE: number; DE: number }
  totalVerdenVolume: number
}

interface DataBundle {
  generatedAt: string
  weeks: string[]
  weekRecipes: WeekRecipe[]
  recipes: Record<string, Recipe>
  cookSchedules: Record<string, CookSchedule>
  processSpecs?: Record<string, ProcessSpec>
  structures?: Record<string, RecipeStructure>
  productionPlan?: ProductionPlan      // aus Sheet 6
  printOrders?: PrintOrderRow[]
  kitchenPriority?: KitchenPriorityRow[]
}
```

---

## Run-Split Formel (src/runPlanning.ts)

`runSplitForRecipeLike(weekRecipe)`:
- **Run 1 (Sonntag/Montag):** BENL×100% + DKSE×100% + DE×70%
- **Run 2 (Dienstag/Mittwoch):** Rest = Total − Run 1
- **Buffer:** `SECOND_RUN_TOTAL_FACTOR = 1.1` (+10% auf Gesamtvolumen)
- Küche ist **Mo–Fr** offen (Sa/So zu)

---

## npm Scripts

```bash
npm run dev                    # Vite dev server + CSV-Watcher (concurrently)
npm run typecheck              # tsc -b
npm run discover:sheets        # Tab-Namen aller 6 Sheets ausgeben
npm run import:sub-recipes     # CSV → Firestore (structures) einmalig
npm run import:gsheet          # GSheets → public/data/data.json
npm run import:pfei            # PFEI CSV → processSpecs in data.json
npm run push:firestore         # data.json → Firestore
npm run sync:all               # import:gsheet + import:pfei + push:firestore
npm run deploy:all             # build + firebase deploy hosting + functions
```

---

## Setup (frisch oder nach Pause)

```bash
# 1. secrets/service-account.json platzieren
# 2. .env.local anlegen (Felder aus .env.example)
npm run discover:sheets        # Tab-Namen prüfen (einmalig)
npm run sync:all               # GSheets + CSVs → Firestore
npm run dev                    # Dev-Server starten
```

---

## Was zuletzt gemacht wurde (2026-05-27)

- `scripts/import-sub-recipes.ts` komplett neu geschrieben:
  - Zwei klar dokumentierte Import-Funktionen: `loadFromRecipesCsv` (Format A) + `loadFromDetailedCsv` (Format B)
  - Watch-Modus (`--watch`) via `fs.watch` mit 800ms Debounce, in `npm run dev` integriert
  - `ignoreUndefinedProperties: true` in Firestore-Settings
- `src/helpers.ts` — `resolveStructureByCode` mit Name-Fallback erweitert:
  - Neue Signatur: `(structures, primaryCode, fallbackCode?, recipeName?)`
- `src/RecipeDetailView.tsx` — übergibt jetzt `recipe?.baseName ?? wr.recipeName` als Name-Fallback
- `package.json` — `dev`-Script nutzt `concurrently` für Vite + CSV-Watcher
- Import durchgelaufen: 219 Strukturen in Firestore

---

## Offene Punkte

- `SHEET_WOCHENSTART` wird erkannt aber noch nicht in der App geparst
- `import-rampup.ts` fehlt noch (Typen vorhanden, Script nicht)
- StructureTab / Engpass-Tab nach Import visuell im Browser prüfen
- Wöchentlich neue `export-recipes W25.csv` etc. in `imports/` ablegen
