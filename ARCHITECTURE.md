# Architektur — Rezeptlogik App (Factor OPS Planner)

> Stand 2026-08-27. Gesamtüberblick der Web-App: Aufbau, Datenfluss, alle Views,
> Kernlogik, Cloud Functions, Scripts. Für "was ist wo leer / falsch" siehe
> [DATENQUELLEN.md](DATENQUELLEN.md). Für den Schnellstart siehe
> [CONTEXT_SESSION.md](CONTEXT_SESSION.md) und [README.md](README.md).

---

## 1. Was die App ist

Internes Planungstool für **HelloFresh Verden (Site VF)**, Märkte **BENL**
(Belgien/Niederlande), **DK-SE**, **DE**. Alleinentwickler + Hauptnutzer: Marcel.

Kernfluss: KW wählen → Rezepte mit Portionen je Markt → Sub-Rezepte, Brutto-Zutaten
(hochgerechnet auf Σ Verden-Volumen), Cook-Schedule-Timeline, Equipment-/Batch-
Planung, Work-Order-Breakdown, PDF-Arbeitsblätter, Live-Monitoring (WMS/Snowflake,
GSheet-Polling, Redzone).

**Nomenklatur:** `FV####` = Verden produziert selbst · `FE####` = zugeliefert.
Codes tragen oft einen Markt-Marker im Namen: `FE1234A5 - Chicken Tikka [DE]`.
`[BNL]`/`[DE]`/`[DKSE]`/`[NORD]`.

---

## 2. Tech-Stack

| Bereich | Wahl |
|---|---|
| Build/Dev | Vite 5, `npm run dev` (Vite + CSV-Watcher via `concurrently`) |
| UI | React 18.3, TypeScript 5.6, Tailwind CSS 3.4 |
| Daten | Firebase 11.0.2 (nur Firestore genutzt), Projekt `hellofresh-de-problem-solve` (geteilt mit Factory Hub), Hosting-Site `rezeptlogik-verden-factor` |
| Backend | Firebase Cloud Functions v2, Region `europe-west3` (~25 Functions) |
| Exporte | `xlsx` (Client), `exceljs` (Functions, eigener Vendor-Chunk) |
| Sonstiges | `@tanstack/react-virtual`, `@anthropic-ai/sdk` (nur Scripts), `papaparse` |
| Tests | Vitest (`src/__tests__/**`), Playwright-Smoke (`Test/planning-oase-smoke.spec.ts`) |

`firebase.ts` re-exportiert alle Firestore-Funktionen zentral — kein anderes Modul
importiert `firebase/firestore` direkt. **Kein Auth-Layer in der App** (siehe §9).

---

## 3. Verzeichnis-Layout

```text
src/
  main.tsx                 Entry: ?share= → ShareDashboard (lazy), sonst <App/>
  app/
    App.tsx                Provider-Stack: Redzone → App → WoReconciliation → Backfills → Router
    Router.tsx             View-Dispatch nach surface / view
    Shell.tsx              Header + Layout-Rahmen (wide-Modus für KET Plan/WO)
    AppContext.tsx         Zentraler State (KW, Rezept, View, Uplift) + Surface-Auflösung
    useAppData.ts          Lädt DataBundle, Live-Refresh (rampUpHash-Snapshot + 60s-Poll)
    useRecipeSelection.ts  Ableitungen: Wochenliste, Summen, Vorwochen-Delta, aktives Rezept
    NavTabs.tsx            Linkes Menü (Nav-Gruppen) + GroupSubTabs + "KET Plan hochladen"
    KitchenSurface.tsx     ?surface=kitchen → nur BreakdownEquipmentView
    ShopfloorKioskSurface  ?surface=shopfloor&dept=veggie|protein → Debox-Kiosk (KET-WO-Liste)
    AppFooter.tsx
  core/
    types.ts               ALLE gemeinsamen Typen (DataBundle, WeekRecipe, Recipe, …)
    dataSource.ts          loadData() + Fallback-Kette + GSheet-/RampUp-Refresh
    firebase.ts            Firebase-Init + Firestore-Re-Exports
  lib/                     Reine Logik-Module (kein React) — siehe §6
  components/              WeekSelector, RecipeList, DataHealthBanner, CapacityWarningBanner, ErrorBoundary
  planning-oasis/          PlanningOasisView (Container) + oasisSourceHealth + GsheetRegistryPanel
  features/<feature>/      Feature-Ordner (View-Komponenten + *Logic.ts + Hooks) — siehe §5
  __tests__/               Vitest
  <Root-Views>.tsx         Ältere, große View-Dateien (weiter aktiv genutzt) — siehe §5
scripts/                   Import-/Sync-/Server-Scripts (tsx / node) — siehe §7
functions/                 Cloud Functions (index.js, 3876 Z.) — node_modules eingecheckt
public/data/               JSON-Dumps, data.json-Fallback, meal-catalog.json, Seeds
Test/                      Playwright-Smoke
.cortex/plans/             Historische Implementierungs-Pläne (Kontext, nicht Code)
Bots-Factor/, Work Order Bot/  Externe Bot-Artefakte (Chrome-Profile etc.) — nicht Teil der App
```

---

## 4. Startablauf & Surfaces

`main.tsx` → bei `?share=<week>` lazy `ShareDashboard`, sonst `<App/>`:

```text
<RedzoneProvider>        Live-Plating/Cooking-Poll (60s), app-weit verfügbar
 <AppProvider>           KW/Rezept/View/Uplift-State + DataBundle
  <WoReconciliationProvider>  gleicht App-Plan/KET/PET/Postblast/WMS laufend ab, 15-Min-Snapshots
   <BackfillsProvider>   Nachproduktions-Bedarf aus GSheet-Monitor + Redzone + WMS
    <Router/>
```

`Router.tsx` entscheidet in dieser Reihenfolge:

| Bedingung | Ergebnis |
|---|---|
| `?surface=redzone` | `RedzoneLiveView` (nur DEV; online Hinweis-Karte) |
| `error` | `ErrorCard` |
| `!data` | `LoadingCard` |
| `?surface=rundmail` | `RundmailView` |
| `?surface=kitchen` | `KitchenSurface` → `BreakdownEquipmentView` |
| `?surface=shopfloor` | `ShopfloorKioskSurface` (`&dept=veggie\|protein`) |
| sonst | `FullApp` (Shell + NavTabs + WeekSelector + RecipeList + `MainPane` + AppFooter) |

**Deep-Links:** `?view=`, `?week=`, `?oase=cockpit\|lines\|rack`, `?meal=`, `?q=`, `?tags=`.
`?view=breakdown` ist ein Legacy-Alias → mappt auf `wo`.

---

## 5. Views (`AppView` + Nav-Gruppen)

`AppView` (16): `recipe · catalog · planning · wo · pet · whatif · rundmail ·
import · wms · blast-chiller · allergen-plating · postblast-live · backfills ·
redzone-live · transparency-plan · artikel-woche`

Nav-Gruppen bündeln teils mehrere Views mit interner Sub-Tab-Leiste (`GroupSubTabs`).

| Nav-Label | View(s) | Haupt-Datei(en) | Zweck |
|---|---|---|---|
| **Rezept** | `recipe` | `features/recipe-detail/RecipeDetailShell.tsx` | 7 Tabs: Übersicht · Sub-Rezepte · Rezeptstruktur · Workflow & Equipment · Brutto-Zutaten · Plating · Cook-Schedule. Markt-Switcher, Vergleichs-Panel, In-Rezept-Suche. |
| **Meal Katalog** | `catalog` | `features/meal-catalog/MealCatalogView.tsx` | Verden Meal Database: Suche/Filter/Tags/Cup, Detailkarte, Favoriten, Bild-Overrides (`useImageOverrides`), XLSX-Export, Compare (≤3), Deploy-Button (DEV). |
| **Planning OASE** | `planning` | `planning-oasis/PlanningOasisView.tsx` | 3 Sections (`?oase=`): **Cockpit** = `PlanningView.tsx` (Drag&Drop-Wochenboard, Stations-/Pool-Konflikte, Run-Split, Batch-Split, Szenarien, Board-Editor-Modal, Firestore-Snapshot); **Linienplanung** = `LinePlanningView` → `features/vorstellungsplan/VorstellungsplanView` (1:1-Spiegel von Marcels „F_VE Production Plan"-GSheet, editierbares Firestore-Overlay, KPI-Vergleich, „Vor-Vor-Planung Text"); **Rack** = `RackV2View.tsx` (ASL1–6 paarweise, `lib/rackV2`). Header zeigt Source-Health + GSheet-Registry + Ramp-Up-Änderungsbanner. |
| **KET Plan / WO** | `wo` | `KetBreakdownView.tsx` + `features/ket-plan/*` | KET-CSV / Firestore-`productionPlan` / Live-WMS → WO-Breakdown: Batch-/Equipment-Kapazität (Küchenbible-Fallback für BRAISER), Factor-Regeln (`factorRules.ts`: RTI / neverBatch / readyMade / separate / spiceRoom), zusammengesetzte Sub-Rezepte (`WoComponent`), Allergen→Blast-Chiller, GN-Bleche, Scoop, KI-Kochanweisungen (Gemini, Firestore-Cache), Run-Zuweisung, Equipment-Panel, Frischeliste V1 (`KetFrischelistePanel`) + V2 (`FrischelisteV2Panel`/`frischeV2Logic` — *WIP*), Shopfloor-Dashboard, PDF/Excel/CSV. **Braucht die volle Bildschirmbreite (`wide`-Shell).** |
| **PET Plan / Plating** | `pet` | `PetPlanView.tsx` + `features/pet-plan/*` | KitchenOS-PET-CSV (manueller Upload, keine Alternativquelle) → allergen-bewusste Linienzuweisung, variable Kapazität/h je Linie, Staffing (Submeals + 1 MA), Plating-Bilder, PDF-Linienplan. |
| **WMS Übersicht** | `wms` | `WmsKwOverviewView.tsx` + `features/wms-overview/*` | Snowflake-Live (lokaler Server 3141) / Firestore-Cache: Stationen Inbound → Staging → Debox → Postblast → Sleeving → Plating, SKU-Funnel & -Trace, Kettenbruch-Erkennung, SKU-Bilanz, Snapshots + Timeline, Meal-Operations-Board, PLH-Ready-to-Plate, MHD-/Yield-Alerts, Planning-Kalender + Weight-Goals. Auto-Reset auf aktuelle KW bei Tab-Focus. |
| **What-If Rechner** | `whatif` | `WhatIfView.tsx` + `features/whatif/*` | Yield-aware Rohware↔Portionen-Rechner. Echte Yield-% aus `export-sub-recipes-by-recipe-detailed.csv`. Per-Zutat-Overrides in localStorage (`rezeptlogik_v1_yield_override_*`), Forward/Reverse, Engpass-Analyse. |
| **Rundmail** | `rundmail` | `RundmailView.tsx` + `features/rundmail/*` | Seed-/PET-CSV → Slack-/HTML-/PDF-Präsentation für die Küchen-Rundmail. Plating-Notizen + Bilder, Bible-Batch-Hints, KET- und PET-Mail-Varianten. Auch als `?surface=rundmail`. |
| **CSV Import** | `import` | `CsvImportView.tsx` + `features/csv-import/*` | CSV → Firestore-Push direkt aus der App (`csvImportFirestore.ts`); feuert `rezeptlogik:csv-import-saved`. |
| **Artikel / KW** | `artikel-woche` | `features/artikel-woche/ArtikelWocheView.tsx` | Wochenbedarf aller Zutaten in kg, Kategorie-Farbcodierung, Braiser/Andere-Station-Split, Tagessplit über einstellbare Tagesvolumina. |
| **Bots** | `blast-chiller`, `allergen-plating` | `features/blast-chiller/`, `features/allergen-plating/` | Allergen→Chiller-Zuteilung (`blastChillerLogic.ts`: 1&2 allergenfrei · 3 Sulfit · 4 Milch · 5 beide · 6 Rest-Pool; Unbekannt → **immer** Chiller 6, nie „frei"). Allergen-Matrix mit XLSX-Export. Volle Breite ohne Sidebar (`BOT_VIEWS`). |
| **Monitoring** | `postblast-live`, `backfills`, `transparency-plan` | `features/gsheet-monitor/*`, `features/backfills/*` | `PostblastLiveView` (2666 Z.): Live-GSheet-Polling, PlatingNow ↔ Redzone ↔ MinimumNeeds als 3-Panel-System, Shortage-Alerts. `BackfillsView`: kombiniert Postblast + Preblast + RTI + LinePlaiting + Redzone + WMS-Holding zu Nachproduktions-Empfehlung je Meal (`combineBackfills.ts`), KW-Auswahl mit Stale-Week-Warnung, LinePlaiting-gid in-app aktualisierbar. `TransparencyPlanView`: eigenes „Transparency"-GSheet mit vielen Sub-Parsern (`parsers/transparency/*`). |
| **Redzone Live** | `redzone-live` | `features/redzone-live/RedzoneLiveView.tsx` | **Nur DEV** (braucht Snowflake-SSO über lokalen Server; Cloud-Function ohne gültigen Key & ohne Cache-Fallback). Live-Plating/Cooking-Runs. `RedzoneProvider` ist trotzdem app-weit → `useRedzoneOptional()`. |

**Übergreifend (keine eigene View):** `features/global-search/` — app-weite Suche
(`GlobalSearch.tsx`), gerendert in `FullApp` als Suchleiste über dem Grid,
ausgeblendet bei `view === "wo"`. `Cmd/Ctrl+K` fokussiert. Autocomplete über
WO-Nummer / Submeal (Name + SKU/ID) / Ingredient-SKU / Mealcode / Rezeptname
(`globalSearchIndex.ts`). Treffer → Overlay mit grafischer Stufen-Schiene
(angelegt → Staging → Küche → Blast → Plating → fertig, `woFlow.ts` +
`WoFlowCard.tsx`), Status je Stufe heuristisch aus Produktionsplan-Statusfeldern
+ kg-Signalen + `WoReconciliation` + Redzone. Submeal-Tabelle mit Chiller/Allergen.
v2 offen: echter Verlauf aus `woReconciliationLog`, `wmsWoDetail`-Live-Anreicherung.

**Ältere Root-View-Dateien, weiter aktiv** (nicht in `features/`): `RundmailView`,
`BreakdownEquipmentView` (Kitchen-/Shopfloor-Surface), `ShareDashboard`,
`PetPlanView`, `CsvImportView`, `RackV2View`, `WhatIfView`, `LinePlanningView`,
`PlanningView`, `WmsKwOverviewView`, `KetBreakdownView`.

**Größte Dateien** (Refactor-Kandidaten, aber Logik ist bereits weitgehend nach
`*Logic.ts` extrahiert): `PostblastLiveView` 2666 · `BreakdownEquipmentView` 2425
· `PlanningView` 1983 · `WhatIfView` 1938 · `KetBreakdownView` 1812 · `RackV2View`
1283 · `RedzoneLiveView` 1099 · `lib/planner` 1098.

---

## 6. Kernlogik (`src/lib/`)

| Datei | Inhalt |
|---|---|
| `hfWeek.ts` | **HF-KW = echte ISO-KW + 1.** Single source of truth (war früher doppelt implementiert, hat einen echten Datums-Bug verursacht). `currentHfWeek()`, `hfWeekForDate()`. |
| `runPlanning.ts` | Run-Split-Formel: 1 Run ≤800 Portionen, 3 Runs >4500, sonst 2. Run 1 = 65 % der Basis, +5 % Uplift auf alles. |
| `planner.ts` | Wochenboard-Szenarien + `analyzePlan` (Stations-/Pool-Konflikte je Tag×Schicht), `computeBatchSplitPlan` (MHD: Fisch 9 d, sonst 13 d; Kunde will 7 d Rest), `suggestAssignments` (Lead-Class rückwärts vom Plating-Tag; Küche **Mo–Fr**, Sa/So zu). |
| `equipment.ts` | 24 Stationen (`STATIONS`), Cook-Method→Station-Aliase, `computeWeekLoad` (kg/Portion, Batches, Minuten/Batch, Hold-Zeiten), Gerätezahlen + Pools (localStorage). |
| `planningOasisData.ts` | KPL-GSheet-Dump + Planning-Truth + DataBundle → `PlanningRecipeIntel` (Rolle factory/hybrid/supplied), Forecast/Plating/PDL und deren Gaps. 120s-Poll + Focus-Refresh. |
| `planningTruthData.ts` | Factor-Daily-PDL-Forecast + Running-Forecast-CSVs (`public/data/gsheet-truth-export/`). |
| `rack.ts` / `rackV2.ts` | Rack-Belegung. `RACK_V2_LINES` ASL1–6, paarweise (ASL1+5 Nordics, ASL2+6 Benelux, ASL3+4 DE), `validateRackPlan`. |
| `planExport.ts` | Wochenplan-Export als TSV / Excel / PDF. |
| `planningSheetApi.ts` | Planning-Sheet-API (Frischeliste-V2-Anbindung). |
| `rampUpHistory.ts` | Ramp-Up-Snapshots + Änderungs-Events (Portionszahlen-Diff je Rezept). |
| `wmsCache.ts` | Liest `wmsCache/workorders` (von `scripts/sync-wms-cache.ts` geschrieben). Dedup je (woNumber, submealItemNumber). `filterRowsToWeekWindow`. Re-exportiert `currentHfWeek` aus `hfWeek.ts`. |
| `wmsSkuEnrichment.ts` | SKU-Info-Index + „welche SKUs sind in dieser KW geplant". |
| `helpers.ts` | Code-/Struktur-/Rezept-Resolver mit Ziffern-Fallback (`FV0024A`↔`0024`), Zahlen-/Namensformat, Farb-Tones, `usePersistent`/`lsGet`/`lsSet` (Prefix `rezeptlogik_v1_`), Markt-Konstanten, Share-URL-Builder. |
| `i18n.ts` | Locale-Helfer (`de`), Markt→Sprache-Labels. |
| `csv-parser.ts` | CSV-Parsing-Helfer. |

---

## 7. Datenfluss & Datenquellen

Ausführlich in [DATENQUELLEN.md](DATENQUELLEN.md). Kurzform:

```text
Google Sheets ─┬─ Service-Account-Import-Scripts ──► public/data/data.json ──► push:firestore ──► Firestore
               └─ Browser (gviz/tq CSV, GSheet-Monitor: Pre/Post-Blast, RTI, ET, LinePlaiting)

Snowflake (WMS) ─┬─ Cloud Functions (JWT) ──► Firestore wmsCache/* (60-Min-Cron)
                 └─ lokaler Server 3141 (Browser-SSO) ──► /api/wms-* Proxy

Frontend: core/dataSource.loadData()
  VITE_DATA_SOURCE = firestore (Default) | local (data.json) | local-db (SQLite-Server 3142)
  Fallback-Kette: firestore ──(Fehler)──► data.json ; danach mergeMealCatalog() legt meal-catalog.json drüber
  Live: onSnapshot auf apps/rezeptlogik (rampUpHash-Feld) + 60s /api/refresh-ramp-up-Poll
        + Window-Events rezeptlogik:{ket-plan,plating-plan,csv-import}-saved lösen Reload aus
```

**`DataBundle`** (`core/types.ts`) — Felder: `weeks`, `weekRecipes`, `recipes`,
`mealCatalog`, `cookSchedules`, `processSpecs`, `shelfLifeBySku`, `structures`,
`instructions`, `productionPlan`, `printOrders`, `kitchenPriority`,
`kitchenPlanning`, `produktionsplanung`, `maitreRampup`, `equipmentBible`,
`planningCalendar`, `weeklyYield`, `weightGoals`.

**Firestore-Collections** unter `apps/rezeptlogik/`: `weekRecipes`, `recipes`,
`structures`, `cookSchedules`, `processSpecs`, `shelfLifeBySku`,
`productionPlan/{week}`, `printOrders`, `kitchenPriority/current`,
`kitchenPlanning/{week}`, `equipmentBible/current`, `planningCalendar/current`,
`weeklyYield/current`, `weightGoals/current`, `produktionsplanung/{market}`,
`maitreRampup/{market__week__code}`. Dazu direkte Client-Writes (siehe §9):
`rackV2PlanHistory`, `woReconciliationLog`, `shopfloorProgress/{week}`,
`woInstructions`, `platingPlan/{week}`, `productionPlanOverrides`, `agentRuns` u.a.
Top-Level (Admin-geschrieben): `wmsCache/*`.

---

## 8. Lokale Dev-Infrastruktur (`vite.config.ts`)

Vite-Plugins starten beim `npm run dev` automatisch (falls Port frei):

| Port | Server | Zweck |
|---|---|---|
| 3141 | `scripts/wms-local-server.ts` | Snowflake über Browser-SSO. Endpoints `/wms-plating`, `/wms-staging`, `/wms-debox`, `/wms-postblast`, `/wms-sleeving`, `/wms-inbound`, `/wms-workorders`, `/wms-wo-detail`, `/wms-plating-holding`, `/wms-plating-history`, `/redzone-plating-status`, `/production-plan(-weeks)`, `/forecast`, `/recipe-profil`, `/transparency-sheet`, `/shorts-tracker` |
| 3142 | `scripts/local-db-server.mjs` | SQLite-Bundle + Gemini-Proxy (`/api/local-db/*`) |

**Vite-Middleware-Endpoints** (nur DEV): `/api/import-local` (→ `import:local` +
`push:firestore`, gestreamt), `/api/push-firestore`, `/api/deploy` (build +
`firebase deploy --only hosting`), `/api/start-wms-server`, `/api/server-status`,
`/api/meal-folder-images` + `/api/drive-image` + `/api/save-meal-image` +
`/api/meal-images` (Meal-Bilder aus Google-Drive-Shortcut), `/api/refresh-ramp-up`
(noop 204).

**Proxy-Ziele:** `/api/wms-live`, `/api/refresh-ramp-up`, `/api/rack-boxfiles`,
`/api/rack-inputs` → Functions-Emulator `127.0.0.1:5001`; `/api/wms-*`,
`/api/production-plan`, `/api/forecast`, … → `127.0.0.1:3141`; `/api/local-db` →
`127.0.0.1:3142`.

---

## 9. Auth & Sicherheit

- **Kein Auth-Layer in der App.** `firestore.rules` (rezeptlogik-Block, additiv):
  `match /apps/rezeptlogik/{path=**} { allow read, write: if true; }`. Deshalb
  funktionieren direkte Client-Writes. Der Factory-Hub-Teil derselben Datei ist
  live-identisch übernommen und rollenbasiert (`isEnabled`/`isReviewer`/`isAdmin`
  über `factoryHub_users`).
- **Firestore-Rules-Deploy:** Historisch war der `firestore`-Block in
  `firebase.json` bewusst weggelassen (Schutzgeländer, geteiltes Projekt). Seit
  Commit `ea6c697` (2026-08-24) ist der Block **wieder da**
  (`"firestore": { "rules": "firestore.rules" }`), und `firestore.rules` enthält
  jetzt die kompletten Factory-Hub-Rules + additiven Block. Die Kommentare in der
  Datei („KEIN Rules-Deploy aus diesem Repo") widersprechen dem inzwischen.
  **Praxis:** Rules nicht beiläufig deployen, erst fragen. Die npm-Scripts sind
  sicher (`deploy` = `--only hosting`, `deploy:all` = `--only hosting,functions`);
  nur ein blankes `firebase deploy` würde jetzt auch Rules pushen.
- `secrets/service-account.json` ist in `.gitignore`, **niemals committen**.
- `functions/node_modules` **ist** eingecheckt (~16,7k Dateien) — bläht
  `git ls-files` auf, ist aber Absicht (Deploy ohne Install).

---

## 10. Cloud Functions (`functions/index.js`, ~25)

Alle Region `europe-west3`. Rewrites in `firebase.json` → `/api/*`.

| Function | Zweck |
|---|---|
| `refreshRampUp` | Forecast-Tracker-GSheet → `weekRecipes`, setzt `rampUpHash` (Client-Reload-Trigger). |
| `refreshOperationalData` | Print Orders / Kitchen Priority / Fertigstellungszeitplan (5-Min-Cooldown). |
| `refreshWmsCache` | **Cron, alle 60 Min:** Snowflake → `wmsCache/*`. |
| `wmsPlating · wmsStaging · wmsDebox · wmsPostblast · wmsSleeving · wmsInbound · wmsWorkorders · wmsWoDetail · wmsPlatingHolding · wmsPlatingHistory` | Snowflake-Live (JWT-KeyPair) → Firestore-Cache-Fallback. |
| `wmsBreakdown` | Aggregierter WMS-Breakdown. |
| `redzoneStatus` | Redzone Plating/Cooking-Status (aktuell ohne gültigen Snowflake-Key → online gesperrt). |
| `rackBoxfiles · rackInputs` | Rack-Boxfiles / -Inputs. |
| `agentRun · agentApprove · agentApply` | Planungs-Agent (Gemini bzw. GitHub Models). Attachment-Verarbeitung mit OCR (Vision) + Excel-Parsing, Rollen-/Token-Auth, Artefakt-Retention in Firestore, deterministischer Fallback. |
| `geminiInstruction · geminiInstructionsBatch` | KET-Kochanweisungen EN/DE generieren. |
| `geminiPlanningChat · geminiPlatingChat` | Chat-Assistenten. |
| `generatePdf` | Server-seitige PDF-Generierung. |

`GEMINI_API_KEY` als `defineSecret`. Weitere Env: `SNOWFLAKE_*`,
`GITHUB_MODELS_API_KEY`, `AGENT_PIPELINE_TOKEN`.

---

## 11. Scripts (`package.json`)

**Import → data.json / Firestore:** `import:gsheet` (6 Sheets → `data.json`, ruft
`import-pfei` mit auf), `import:local`, `import:sub-recipes` (`--watch` in
`npm run dev`), `import:meal-database`, `import:kitchen-bible`,
`import:weight-tracking`, `import:planning-calendar`, `import:rampup`,
`import:weekly-planning`, `push:firestore`, `push-csv-firestore`.

**WMS / Cache:** `wms:server` (3141), `wms:sync-cache` (persönlicher SSO-Pull →
`wmsCache/*`).

**Lokale DB:** `db:build` (→ SQLite), `db:serve` (3142), `db:translate-instructions`,
`dev:local`.

**Rack:** `rackfile:plan`, `rackfile:generate`.

**Utility:** `discover:sheets` (Tab-Namen + GIDs aller Sheets), `dump:kpl`,
`watch:operational`, `test:smoke:oase`.

**Deploy:** `deploy` (build + hosting), `deploy:functions`, `deploy:all` (hosting +
functions).

**Wochenstart:** `sync:all` (`import:gsheet` + `import:local` + `import:rampup` +
`import:weekly-planning` + `push:firestore`), `sync:all:deploy`.

---

## 12. Wiederkehrende Muster & Fallstricke

- **KW-Konvention:** HF-KW = ISO + 1, überall load-bearing. `weekRecipes` aus dem
  GSheet-Pipeline kann Wochen hinterherhängen — Live-Küchendaten müssen dem echten
  Kalender folgen (`currentHfWeek()`), nicht der gewählten Planner-KW.
- **Refactor-Technik (bestätigt):** aus großen stateful Views nur **reine Logik**
  nach `*Logic.ts` ziehen, State/Hooks im View lassen. Umgesetzt in `ket-plan`,
  `wms-overview`, `whatif`, `pet-plan`, `rundmail`, `gsheet-monitor`.
- **PDF-Treue:** `window.open()` + `print()` sieht am Bildschirm gut aus, bricht
  aber beim Speichern — eigenes Fix-Muster nötig (`ketPdf.ts` u.a.).
- **Code-Matching:** immer über Ziffern-Fallback (`resolveRecipeByCode` /
  `resolveStructureByCode` / `codeDigits`), nie strikter String-Vergleich.
- **Auto-Commit-Anomalie:** ein unklarer Mechanismus committet/pusht manchmal von
  selbst — vor Arbeitsbeginn `git status` prüfen.
- **`CONTEXT_SESSION.md` / `DATENQUELLEN.md`:** DATENQUELLEN ist aktuell und
  verlässlich; CONTEXT_SESSION ist die Schnellstart-Kurzfassung.
- **Dynamische Firebase-Imports** waren im Vite-Dev-Server sporadisch instabil —
  deshalb zentrale Re-Exports in `core/firebase.ts`.

---

## 13. Vision (Kontext für Feature-Arbeit)

Marcels aktuelle Priorität: **eine KI auf den verknüpften Live-Daten aufbauen**
(RAG-artig: LLM liest frisch zusammengestellten Kontext aus allen verknüpften
Quellen zur Generierungszeit — kein Fine-Tuning), statt weiterer Standalone-
Features. Die editierbare Firestore-Overlay-Infrastruktur des Vorstellungsplans
ist der erste Baustein: jede Zelle wird ein referenzierbarer Datenpunkt.

Konkrete offene Wünsche:
- **Globale/übergeordnete Suche** (Shell-Header, Command-Palette-artig): Suche nach
  WO-Nummer, **Submeal via SKU-Code und via Name**, Meal-Code, Rezeptname — mit
  **Autovervollständigung** beim Tippen. Treffer → **grafisch starke Flow-Ansicht**
  von allem Verbundenen: Stufen-Timeline (angelegt → Staging → Küche → Blast →
  Sleeving → Plating → fertig) + Submeal-Breakdown + verknüpfte Datenpunkte
  (Wiegungen, Allergene/Chiller, Plating-Linie, Mengen). NICHT in „KET Plan / WO".
  Verlaufsquelle: `woReconciliationLog`-Snapshots + `wmsWoDetail` +
  `productionPlan`-Statusfelder; Sucheingabe-Index: `recipes[].markets[].subRecipes`
  + `structures` + `wmsCache` + `shelfLifeBySku` (`lib/helpers.searchMatchReason`
  als Basis).
- **„Vor-vor-Planung"-Mail** (teilweise umgesetzt in `vorVorPlanungText.ts`).
- KET: zusammengesetzte Sub-Rezepte künftig nach Allergen-Zahl sortieren.
