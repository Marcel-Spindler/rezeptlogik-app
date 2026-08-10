# Eingabe-Quellen · Rezeptlogik Verden Planer

> Lebende Liste aller externen Inputs der App. Bei jeder neuen Quelle hier ergänzen.

## 1. Firebase / Google Cloud

| Eintrag | Wert |
|---|---|
| Projekt | `hellofresh-de-problem-solve` |
| Web-App-Name | `Rezeptlogik Verden Planer` |
| Hosting-Site | `rezeptlogik-verden-factor` → https://rezeptlogik-verden-factor.web.app |
| App-ID | `1:853119829386:web:528af3a484863bbe437473` |
| Reader Service-Account (Sheets/Drive) | `planningmsku@hellofresh-de-problem-solve.iam.gserviceaccount.com` |
| Writer Service-Account (Firestore) | empfohlen: dediziert, z. B. `rezeptlogik-writer@hellofresh-de-problem-solve.iam.gserviceaccount.com` |
| Reader-Key | `GOOGLE_APPLICATION_CREDENTIALS` (lokal, nicht committen) |
| Writer-Key | `FIRESTORE_WRITER_CREDENTIALS` (lokal, nicht committen) |
| Firestore-Pfad dieser App | `apps/rezeptlogik/{weekRecipes|recipes|cookSchedules|processSpecs}` |

## 2. Google Sheets (live)

Konfiguriert über `.env.local` und den Dump-/Registry-Sync.
Der **Reader-Service-Account** muss bei jedem Sheet als **Viewer** geteilt sein.

| # | Name | Spreadsheet-ID | Zweck | Env / Sync |
|---|---|---|---|---|
| 1 | Factor_ Rolling Forecast Tracker | `1NX4ccmp9EHgjcQcZPt2RVC4dGZm-Lhq_XEIxgs3iBP4` | Haupt-Truth-Source fuer Wochen-Rezepte, W-Tabs, Ramp-up und Forecast-Import | `GSHEET_ID` |
| 2 | F_EU - 2026 Ramp Up Planning V2.0 | `1IEi_CB9KylW2MgjNiGax5EIvhhAtkIzm57uO1sSESj8` | Zusatzquelle fuer Meal-/Ramp-up Daten | `GSHEET_IDS` |
| 3 | [EU] F_ Recipe PFEI | `1cQtoL4aYHfc_44mfQQty8-EFKPZoYPLBQ2ojmO8hgzg` | Equipment-Zeiten & Batch-Groessen pro Sub-Rezept | `PFEI_GSHEET_ID`, Tab `MAIN` |
| 4 | Open Shelf Life / MLOR | `1dET5WmRKYRhmzEmhlBv1ZpRo5huWgNLfIY6uaLpCrcc` | MLOR- und Open-Shelf-Life Daten fuer SKU-Risiken | `OPEN_SHELF_GSHEET_ID`, Default-Tab `ALL in 1` |
| 5 | Kitchen Priority List-Verden-2026 | `13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U` | KPL-Dump fuer Planning OASE, Rack und Linienplanung | `npm run sync:gsheet:registry` |
| 6 | [NEW] MASTER+SUPERVISORS WORKLOAD PLANNING | `1vwTeKDkQcSrWtFLioOBlkcQrbbDzMxbra-f-AbXgO1Q` | Supervisor-/Workload-Dump fuer Breakdown und Manufacturing-Hinweise | Registry / Dump |
| 7 | Bibles_K_Operations_Manager_Supervisors | `1jZXgFcnDhmALSbIlyDbzL-uKpDyLycwdxcVnFNPn32c` | Bible-/Supervisor-Hinweise fuer Breakdown und Manufacturing | Registry / Dump |
| 8 | Cook Schedules Per DC | `1jUN_IxCT4nodV21gwb1N_RKdxDrVilH00rC8khBEll8` | Cook-Methoden und Shift-Timings je Site (in der App auf `Site == VF` gefiltert) | `SHEET_COOK_SCHEDULES` |
| 9 | OUTPUT - [F_ x HF] Weekly Fulfillment Report | `1YscgiuKYVI2pGcMJ3RcJwWGQEkG46RnVnji8q8a4AeE` | Maitre-Ramp-up (DE/Nordics je KW), Produktionsvorbereitung DE+Nordics, FCMS-Inbound, Logistik | `npm run sync:fulfillment:report` → Firestore: `maitreRampup`, `produktionsplanung`, `fcmsInbound` |
| 10 | F_VE Production Plan (Tab "Planning Calendar") | `1zaQjWKlNN4JNCMnE-lrdgf7iNgabfl9HGq5vdOyKedI` | Wöchentliche Planungs-Deadlines + Eskalationskontakte (L1/L2/L3) | `SHEET_PLANNING_CALENDAR`, `npm run import:planning-calendar` → Firestore: `planningCalendar/current` |

> Live-Inventar fuer die UI: `public/data/gsheet-sources.json`
> Vollstaendige Dumps: `public/data/gsheet-dump-*.json`

> **So fügst du ein neues Sheet hinzu:**
> 1. Sheet öffnen → **Teilen** → `planningmsku@hellofresh-de-problem-solve.iam.gserviceaccount.com` als Betrachter hinzufügen.
> 2. Spreadsheet-ID aus URL nehmen (`docs.google.com/spreadsheets/d/`**`<ID>`**`/edit`).
> 3. In `.env.local` an `GSHEET_IDS=` anhängen (kommagetrennt).
> 4. `npm run import:gsheet`
> 5. `npm run sync:gsheet:registry`
> 6. Optional `npm run push:firestore`

## 2b. Weitere Google-Quelle

| Quelle | ID | Zweck |
|---|---|---|
| Factor Daily Forecast Folder (Google Drive) | `1Q2OTboR_X4tCGjsaag55C2WFURRpi-i2` | CSV-Quelle fuer `npm run sync:factor:forecast` |

## 3. CSV-Exporte (lokal, aus C:\Rezeptlogik)

| Datei | Inhalt | Markt-Mapping |
|---|---|---|
| `export-recipes (1).csv` | Recipe-Stammdaten | BENL |
| `export-recipes (2).csv` | Recipe-Stammdaten | DE |
| `export-recipes (3).csv` | Recipe-Stammdaten | DKSE |
| `export-gross-ingredients-and-sub-recipes-by-recipe (1).csv` | Brutto-Zutaten | BENL |
| `export-gross-ingredients-and-sub-recipes-by-recipe (2).csv` | Brutto-Zutaten | DE |
| `export-gross-ingredients-and-sub-recipes-by-recipe (3).csv` | Brutto-Zutaten | DKSE |
| `Cook Schedules Per DC - Cook Shifts per DC.csv` | Cook-Methoden je Site (gefiltert auf VF) | – |

## 4. Code-Normalisierung

- Meal Selection nutzt `FE…`-Codes, Recipe-Exports nutzen `FV…`-Codes mit ggf. anderem Variantenbuchstaben.
- Mapping über die **4-stellige Nummer** im Code (`digitKey()` im Importer).
- Aktueller Stand: 15 automatische Aliase (z. B. `FE0972B` ↔ `FV0972A` Salmon Piccata).

## 5. PFEI-Schema (Tab `MAIN`)

Per FORMULA-Inspect verifiziert. Stations-Reihenfolge ist exakt die `STATIONS`-Konstante in `src/types.ts`.

| Spalte | Index | Inhalt |
|---|---|---|
| A | 0 | Recipe Name |
| B | 1 | **Sub-Recipe ID** (`SUB-…`) — Join-Key auf `SubRecipe.id` |
| C | 2 | Product Family |
| F | 5 | Batch Constraint = primäre Station / Engpass |
| G | 6 | Batch Size |
| H | 7 | Batch UOM |
| I..AF | 8..31 | **Block 1**: Minuten / Batch je Station (24 Stationen) |
| BE..CD | 56..79 | **Block 3**: Hold-/Cool-Time je Station |
| CE | 80 | Hygienic Flag |

**Stations-Reihenfolge:** Staging · Spice Portioning · Debox · Thaw · Brine · Marinade · Hand Marinade · Immersion Blender · Planetary Mixer · Horizontal Mixer · Patty Maker · Braiser · Grill · Crusted · Oven · Drain · Hand Mix · Cold Shredder · Hot Shredder · Scooper · Butter Machine · Slicer · Cupping · Blast Chiller.

**Verwendung in der UI:**
- Tab _Workflow & Equipment_ pro Rezept: Reihenfolge aus `SubRecipe.category` (per `/` getrennt) → Station gemappt → Minuten/Batch × Batches.
- Sicht _Equipment-Auslastung_ (KW-global): summiert über alle Sub-Rezepte aller Rezepte einer KW (Σ aller Märkte = `totalVerdenVolume`).

