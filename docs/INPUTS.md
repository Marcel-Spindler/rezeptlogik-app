# Eingabe-Quellen · Rezeptlogik Verden Planer

> Lebende Liste aller externen Inputs der App. Bei jeder neuen Quelle hier ergänzen.

## 1. Firebase / Google Cloud

| Eintrag | Wert |
|---|---|
| Projekt | `hellofresh-de-problem-solve` |
| Web-App-Name | `Rezeptlogik Verden Planer` |
| Hosting-Site | `rezeptlogik-verden-factor` → https://rezeptlogik-verden-factor.web.app |
| App-ID | `1:853119829386:web:528af3a484863bbe437473` |
| Service-Account | `planningmsku@hellofresh-de-problem-solve.iam.gserviceaccount.com` |
| Service-Account-Key | `secrets/service-account.json` (lokal, nicht committen) |
| Firestore-Pfad dieser App | `apps/rezeptlogik/{weekRecipes|recipes|cookSchedules|processSpecs}` |

## 2. Google Sheets (live)

Konfiguriert über `.env.local` → `GSHEET_ID` (primär) und `GSHEET_IDS` (zusätzlich, kommagetrennt).
Der Service-Account muss bei jedem Sheet als **Viewer** geteilt sein.

| # | Name | Spreadsheet-ID | Zweck |
|---|---|---|---|
| 1 | F_EU – 2026 Ramp Up Planning V2.0 | `1IEi_CB9KylW2MgjNiGax5EIvhhAtkIzm57uO1sSESj8` | Meal Selection live (Tab gid=1436441958) |
| 2 | [EU] F_ Recipe PFEI | `1cQtoL4aYHfc_44mfQQty8-EFKPZoYPLBQ2ojmO8hgzg` | Equipment-Zeiten & Batch-Größen pro Sub-Rezept (Tab `MAIN`) — Env-Var `PFEI_GSHEET_ID` |

> **So fügst du ein neues Sheet hinzu:**
> 1. Sheet öffnen → **Teilen** → `planningmsku@hellofresh-de-problem-solve.iam.gserviceaccount.com` als Betrachter hinzufügen.
> 2. Spreadsheet-ID aus URL nehmen (`docs.google.com/spreadsheets/d/`**`<ID>`**`/edit`).
> 3. In `.env.local` an `GSHEET_IDS=` anhängen (kommagetrennt).
> 4. `npm run import:gsheet` (+ optional `npm run push:firestore`).

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

