# Datenquellen-Dokumentation — Rezeptlogik App

> **Zweck:** Wenn etwas in der App leer oder falsch ist, hier nachschauen, welches Sheet, welcher Tab und welches Script schuld ist.

---

## Übersicht: Welche Daten kommen woher?

| Was in der App | Kommt aus | Script / Funktion | Firestore-Pfad |
|---|---|---|---|
| Rezepte je KW (Portionen, Märkte) | Forecast Tracker GSheet | `refreshRampUp` (Cloud Fn) + `import:gsheet` | `apps/rezeptlogik/weekRecipes/{id}` |
| Rezept-Stammdaten (Name, MSKU, Allergene, Sub-Rezepte) | Lokale CSV-Exporte aus `imports/` | `import:gsheet` | `apps/rezeptlogik/recipes/{code}` |
| Brutto-Zutaten (Σ Wochenbestellung, Ingredients-Tab) | Lokale CSV-Exporte aus `imports/` | `import:gsheet` | `apps/rezeptlogik/recipes/{code}` |
| Rezeptbaum / Sub-Rezept-Hierarchie (Struktur-Tab) | Lokale CSV-Exporte aus `imports/` | `import:gsheet` | `apps/rezeptlogik/structures/{code}` |
| Cook Schedules (Timing D-1, D0 usw.) | Lokale CSV aus `imports/` | `import:gsheet` | `apps/rezeptlogik/cookSchedules/{cookMethod}` |
| PFEI-Prozessdaten (Batch, Stationen, Hold-Zeiten) | PFEI GSheet | `import:gsheet` (via `import-pfei`) | `apps/rezeptlogik/processSpecs/{subId}` |
| Shelf Life / MLOR (Zutaten-Tab, Qualität) | Open Shelf Life GSheet | `import:gsheet` (via `read-open-shelf`) | `apps/rezeptlogik/shelfLifeBySku/{sku}` |
| Ramp-Up Sparkline (Live-Refresh) | Forecast Tracker GSheet | `refreshRampUp` (Cloud Fn, alle 60s) | `apps/rezeptlogik/` (rampUpHash-Trigger) |
| **Fertigstellungszeitplan** (Packing Do/Fr/Sa) | **Sheet 6** `SHEET_FERTIGSTELLUNG` | `refreshOperationalData` (Cloud Fn) + `import:gsheet` | `apps/rezeptlogik/packingSchedule/{week}` |
| **Print Orders (Sleeven)** | **Sheet 2** `SHEET_PRINT_ORDERS` | `refreshOperationalData` (Cloud Fn) + `import:gsheet` | `apps/rezeptlogik/printOrders/{id}` |
| **Kitchen Priority** | **Sheet 3** `SHEET_KITCHEN_PRIORITY` | `refreshOperationalData` (Cloud Fn) + `import:gsheet` | `apps/rezeptlogik/kitchenPriority/current` |
| KET / Rack / Breakdown | Planning OASE Sheet | KPL-Dump geladen von Planning OASE | Lokaler Dump in `public/data/` |

---

## 1. Forecast Tracker GSheet — Meal-/Portionsdaten

**Was:** Die Rezepte je Kalenderwoche mit Portionen pro Markt (BENL / DKSE / DE). Das ist die **kritischste Quelle** — ohne die steht die Rezeptliste leer.

| Feld | Wert |
|---|---|
| **Sheet-ID** | `.env.local → GSHEET_ID` (kein Default, pflicht!) |
| **Zusatz-Sheets** | `.env.local → GSHEET_IDS` (kommagetrennt, optional) |
| **Standby-Default** (Cloud Fn) | `1IEi_CB9KylW2MgjNiGax5EIvhhAtkIzm57uO1sSESj8` |

### Tabs, die gelesen werden (in Prioritätsreihenfolge):

| Tab-Name | Format | Was wird gelesen |
|---|---|---|
| `PO Maitre` | Ramp-up-Tabelle „All Markets" | Portionen je Rezept, Markt, KW |
| `[Import] Convini Order Sheet` | Gleiche Struktur | Portionen je Rezept, Markt, KW |
| `_Import_ Convini Order Sheet` | Gleiche Struktur | Portionen je Rezept, Markt, KW |
| `Input ` (mit Leerzeichen!) | Gleiche Struktur | Portionen je Rezept, Markt, KW |
| `Menu-Selection-LIVE` | Altes Layout (Legacy-Fallback) | Portionen, Slot, Buffer |
| `Meal Selection` | Ältestes Layout (letzter Fallback) | Portionen, Slot, Buffer |
| `W##` (z.B. `W22`, `W23`) | Tabellenformat mit Rezeptcode | Portionen, Rezeptname |
| `MSKU Input` | Rezeptname-Liste | Nur Rezept-Codes, keine Portionen |

> **Reihenfolge:** Der erste Tab, der Daten liefert, gewinnt. Sobald `PO Maitre` Zeilen hat, werden die anderen übersprungen. Die KW-Tabs (`W22` etc.) werden zusätzlich gescannt.

### Wann läuft es?

- **Automatisch alle 60 Sekunden** via Firebase Cloud Function `refreshRampUp` (läuft nur, wenn sich der Hash ändert — kein Overload)
- **Manuell:** `npm run import:gsheet` → schreibt alles lokal nach `public/data/data.json` und pusht via `push:firestore`

### Wenn die Rezeptliste leer ist:

1. GSHEET_ID in `.env.local` prüfen — ist sie gesetzt?
2. Service Account hat Lesezugriff auf das Sheet? (Share → Viewer mit der SA-Email)
3. Hat der Tab `PO Maitre` eine Zeile mit `All Markets` in Spalte A und `week.value` in Spalte B?
4. Stimmt die KW im Format `YYYY-WXX` (z.B. `2026-W22`)? Zweistellige Woche ohne führende Null wird automatisch ergänzt.

---

## 2. Lokale CSV-Exporte aus `C:\Rezeptlogik`

**Was:** Rezept-Stammdaten, Brutto-Zutaten, Rezeptbaum und Cook Schedules. Diese werden **lokal von deinem Rechner** gelesen — kein Internet nötig, aber die Dateien müssen aktuell sein.

| Env-Variable | Default-Pfad |
|---|---|
| `REZEPTLOGIK_SOURCE_DIR` | `C:\Rezeptlogik` |

### Dateien und ihr Zweck:

| Dateiname | Markt | Was wird geladen | In der App sichtbar |
|---|---|---|---|
| `export-recipes (1).csv` | BENL | Sub-Rezepte, MSKU, Allergene, Verpackung, Zutaten | Rezept-Header, Übersicht, Sub-Rezepte-Tab |
| `export-recipes (2).csv` | DE | Gleich wie oben | Gleich, für Markt DE |
| `export-recipes (3).csv` | DKSE | Gleich wie oben | Gleich, für Markt DK/SE |
| `export-gross-ingredients-and-sub-recipes-by-recipe (1).csv` | BENL | Brutto-Mengen je Zutat und Portion | Σ Wochenbestellung, Ingredients-Tab |
| `export-gross-ingredients-and-sub-recipes-by-recipe (2).csv` | DE | Gleich wie oben | Gleich, für Markt DE |
| `export-gross-ingredients-and-sub-recipes-by-recipe (3).csv` | DKSE | Gleich wie oben | Gleich, für Markt DK/SE |
| `export-sub-recipes-by-recipe-detailed.csv` | Alle | Vollständige Rezeptbaum-Hierarchie (Main → Sub1 → Sub2 → Zutaten) | Rezeptstruktur-Tab (SVG-Baum + Liste) |
| `Cook Schedules Per DC - Cook Shifts per DC.csv` | VF (Verden) | Cook-Method → Anzahl Shifts + Zeitplan | Cook-Schedule-Tab, Sub-Rezepte-Urgency |

### Wenn etwas leer ist:

- **Sub-Rezepte-Tab leer / kein MSKU:** `export-recipes (X).csv` fehlt oder ist veraltet → neu exportieren und `npm run import:gsheet` laufen lassen
- **Σ Wochenbestellung leer:** `export-gross-ingredients (X).csv` fehlt → neu exportieren
- **Rezeptbaum-Tab zeigt nichts:** `export-sub-recipes-by-recipe-detailed.csv` fehlt → neu exportieren
- **Cook-Schedule-Tab zeigt „kein VF-Schedule":** `Cook Schedules Per DC.csv` fehlt oder Cook-Method stimmt nicht überein

---

## 3. PFEI GSheet — Prozess- und Batch-Daten

**Was:** Equipment-Minuten je Station, Batch-Größen, Hold-Zeiten, Hygienic-Flag pro Sub-Rezept. Wird im **Workflow-Tab** und **Batch-Kalkulator** angezeigt.

| Feld | Wert |
|---|---|
| **Sheet-ID** | `.env.local → PFEI_GSHEET_ID` (pflicht) |
| **Tab** | `MAIN` |
| **Bereich** | `MAIN!A2:CE12000` |

### Spalten-Mapping im Tab MAIN:

| Spalte | Inhalt |
|---|---|
| A | Recipe Name |
| B | Sub-Recipe ID (Format: `SUB-XXXXX`) |
| C | Product Family |
| F | Batch Constraint (primäre Station / Engpass) |
| G | Batch Size (kg) |
| I–AF (Cols 9–32) | Minuten / Batch je Station (Reihenfolge = STATIONS in types.ts) |
| BE–BB (Cols 57–80) | Hold-Zeit / Station |
| CE (Col 81) | Hygienic Flag (TRUE/FALSE) |

### Wenn Workflow-Tab oder Batch-Kalkulator leer sind:

1. `PFEI_GSHEET_ID` in `.env.local` gesetzt?
2. Sub-Recipe-ID im PFEI fängt mit `SUB-` an — passt das mit den IDs aus dem `export-recipes`-CSV überein?
3. `npm run import:gsheet` ausgeführt und danach `npm run push:firestore`?

---

## 4. Open Shelf Life GSheet — MLOR & Haltbarkeit

**Was:** Shelf-Life-Tage je Ingredient-SKU. Wird im **Ingredients-Tab** (Spalte Shelf / MLOR) angezeigt — bestimmt den Status ok / knapp / kritisch.

| Feld | Wert |
|---|---|
| **Sheet-ID** | `.env.local → OPEN_SHELF_GSHEET_ID` (default: `1dET5WmRKYRhmzEmhlBv1ZpRo5huWgNLfIY6uaLpCrcc`) |
| **Tab** | `.env.local → OPEN_SHELF_GSHEET_TAB` (default: `ALL in 1`) |
| **Bereich** | `ALL in 1!A3:O9999` |

### Spalten-Mapping:

| Spalte | Inhalt |
|---|---|
| A (0) | SKU Name |
| B (1) | Kategorie |
| C (2) | **SKU Code** (Key für Matching) |
| D (3) | Sub-Kategorie |
| I (8) | Temp-Kategorie |
| J (9) | Total Shelf Life (Tage) |
| K (10) | MLOR (Tage) |
| L (11) | Open Shelf Life (Tage) |

### Matching-Logik:
- Primär: exakter SKU-Code-Match (`ingredientId` aus Gross-CSV = `skuCode` aus Shelf-Life-Sheet)
- Fallback: Namens-Fuzzy-Match (≥2 übereinstimmende Tokens)
- Kundenminimum: **7 Tage** — darunter = kritisch

### Wenn alle Zutaten „kein Sheet-Match" zeigen:

1. SKU-Codes aus dem Gross-Export prüfen (Ingredients-Tab → Spalte SKU) — stimmen sie mit `skuCode` im Shelf-Life-Sheet überein?
2. `import:gsheet` neu ausführen

---

## 5. OUTPUT - Fulfillment Report GSheet

**Was:** Ramp-Up-Snapshots je Rezept/Markt über die Woche (für Planning OASE), Produktionsvorbereitung DE/Nordics, FCMS-Inbound.

| Feld | Wert |
|---|---|
| **Sheet-ID** | Hardcoded: `1YscgiuKYVI2pGcMJ3RcJwWGQEkG46RnVnji8q8a4AeE` |
| **Env-Override** | `FULFILLMENT_REPORT_SHEET_ID` |
| **Script** | `npm run sync:fulfillment:report` |

### Tabs und ihr Zweck:

| Tab-Name | Was wird gelesen | Firestore-Pfad | In der App |
|---|---|---|---|
| `Maitre Inputs DE/NO_Stamm` | Volumen-Snapshots je Rezept/Markt/Woche (`wed-4wk` bis `order`) | `apps/rezeptlogik/maitreRampup/{week}__{market}__{code}` | Planning OASE → Ramp-Up Panel |
| `Produktionsvorbereitung_DE` | Run 1 / Run 2 Mengen je Rezept (DE) | `apps/rezeptlogik/produktionsplanung/{week}__DE` | Planning OASE → Produktionsplan |
| `_Nordics` (genauer Tab-Name prüfen!) | Run 1 / Run 2 Mengen je Rezept (Nordics) | `apps/rezeptlogik/produktionsplanung/{week}__NORDICS` | Planning OASE → Produktionsplan |
| `Logistik - FCMS Meals` | Tatsächlich eingegangene PO-Positionen | `apps/rezeptlogik/fcmsInbound/{week}` | Planning OASE → FCMS Inbound |

### Wenn Planning OASE leer ist:

1. `npm run sync:fulfillment:report` manuell ausführen
2. Prüfen, ob der Tab `Maitre Inputs DE/NO_Stamm` existiert und Spalte A `DE` oder `NORDICS` enthält
3. Hat der Service Account Lesezugriff auf Sheet `1YscgiuKYVI2pGcMJ3RcJwWGQEkG46RnVnji8q8a4AeE`?

---

## 6. Factor Daily / PDL Forecast (Google Drive)

**Was:** PDL-Forecast-Daten aus dem Factor Daily — wird für Vergleiche im Planning OASE verwendet.

| Feld | Wert |
|---|---|
| **Drive-Ordner-ID** | Hardcoded: `1Q2OTboR_X4tCGjsaag55C2WFURRpi-i2` (override via `FACTOR_FORECAST_FOLDER_ID`) |
| **Typ** | Google Drive CSV-Dateien (neueste pro KW) |
| **Script** | `npm run sync:factor:forecast` |
| **Output** | `public/data/gsheet-truth-export/Factor_Daily - PDL Forecast.csv` |
| **Metadaten** | `public/data/factor-daily-meta.json` |

### Dateiname-Format im Drive:

```
[YYYY.MM.DD] Factor Daily - PDL Forecast.csv
```

### Wenn Factor Daily leer ist:

1. Drive-Ordner `1Q2OTboR_X4tCGjsaag55C2WFURRpi-i2` mit Service-Account-Email geteilt?
2. CSV-Dateien im Drive vorhanden und benennt nach `[YYYY.MM.DD]`-Format?
3. `npm run sync:factor:forecast` ausführen

---

## 7. Running Forecast GSheet

**Was:** Forecast-Übersicht über alle Märkte.

| Feld | Wert |
|---|---|
| **Sheet-ID** | Hardcoded: `1IEi_CB9KylW2MgjNiGax5EIvhhAtkIzm57uO1sSESj8` |
| **Tab** | GID `1436441958` (Tab-Name wird dynamisch ermittelt, war bisher `OUTPUT >>`) |
| **Bereich** | `A:Z` (gesamter Tab) |
| **Script** | `npm run sync:running:forecast` |
| **Output** | `public/data/gsheet-truth-export/Running Forecast - All Markets.csv` |

---

## 8. Kitchen Priority List (KPL) GSheet

**Was:** Planungsdaten für Planning OASE, Rack, Linienplanung.

| Feld | Wert |
|---|---|
| **Sheet-ID** | Hardcoded: `13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U` |
| **Wird geladen von** | Planning OASE View (`PlanningOasisView.tsx`) direkt |
| **Dump-Datei** | `public/data/gsheet-dump-*.json` |

---

## 9. Wochenstart-Infos GSheet

**Was:** Sheet 1 — Wochenstart-Daten (diverse Zahlen rund um Factor). Wird via Tab-Discovery gelesen.

| Feld | Wert |
|---|---|
| **Sheet-ID** | `1YscgiuKYVI2pGcMJ3RcJwWGQEkG46RnVnji8q8a4AeE` |
| **Env-Variable** | `SHEET_WOCHENSTART` |
| **GID** | `1547112173` |
| **Tab** | Wird per Discovery ermittelt (`npm run discover:sheets`) |
| **Wird gelesen von** | Noch nicht in App integriert — Discovery läuft, Parsing folgt nach Tab-Bestätigung |

---

## 10. Print Orders Sleeven GSheet

**Was:** Sheet 2 — Print-Orders für das Sleeven. Zeigt welche MSKUs in welcher Menge mit Sleeves zu versehen sind.

| Feld | Wert |
|---|---|
| **Sheet-ID** | `1fpEHBWmd_zk74wbu78unPoTV_u860smNlxTuioEdq-4` |
| **Env-Variable** | `SHEET_PRINT_ORDERS` |
| **GID** | `274103732` |
| **Tab** | Erster Tab (per Discovery) — `SHEET_PRINT_ORDERS_TAB` für fixen Override |
| **Cloud Fn** | `refreshOperationalData` (5 min Cooldown) |
| **Firestore** | `apps/rezeptlogik/printOrders/{week}_{code}_{msku}` |

### Spalten (Header-Zeile wird automatisch erkannt):

| Spalte-Keyword | Was |
|---|---|
| `week` / `kw` | Lieferwoche |
| `code` / `recipe` | Rezept-Code |
| `msku` / `sku` | MSKU |
| `qty` / `menge` / `quantity` | Menge |
| `sleeve` / `typ` | Sleeve-Typ (optional) |

---

## 11. Kitchen Priority GSheet

**Was:** Sheet 3 — Küchen-Prioritätsliste. Welches Rezept hat höchste Dringlichkeit in der Produktion.

| Feld | Wert |
|---|---|
| **Sheet-ID** | `13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U` |
| **Env-Variable** | `SHEET_KITCHEN_PRIORITY` |
| **GID** | `1155412771` |
| **Tab** | Erster Tab (per Discovery) — `SHEET_KITCHEN_PRIORITY_TAB` für fixen Override |
| **Cloud Fn** | `refreshOperationalData` (5 min Cooldown) |
| **Firestore** | `apps/rezeptlogik/kitchenPriority/current` |

---

## 12. Fertigstellungszeitplan GSheet (KRITISCH)

**Was:** Sheet 6 — Wann müssen wie viele Portionen fertig sein? Donnerstag / Freitag / Samstag Packing-Targets je Rezept. Direkt in der App als **Packing-Tab** und als **"Wann packen?"-Panel** im Rezept-Overview sichtbar.

| Feld | Wert |
|---|---|
| **Sheet-ID** | `1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY` |
| **Env-Variable** | `SHEET_FERTIGSTELLUNG` |
| **GID** | `2102344204` |
| **Tab** | Erster Tab (per Discovery) — `SHEET_FERTIGSTELLUNG_TAB` für fixen Override |
| **Cloud Fn** | `refreshOperationalData` (5 min Cooldown) |
| **Firestore** | `apps/rezeptlogik/packingSchedule/{week}` |

### Spalten-Layout (Header-Zeile wird automatisch erkannt):

| Header-Keyword | Was |
|---|---|
| `DO` / `THU` / `Donnerstag` | Donnerstag: Target, Actual, Paletten (3 Spalten) |
| `FR` / `FRI` / `Freitag` | Freitag: Target, Actual, Paletten (3 Spalten) |
| `SA` / `SAT` / `Samstag` | Samstag: Target, Actual, Paletten (3 Spalten) |
| Spalte A | Rezept-Code (Format `FE1234A` o.ä.) |
| Spalte B | Rezeptname |

### In der App sichtbar:

- **Packing-Tab** in der Nav: Tabelle aller Slots mit grün/gelb/rot Farbcodierung (≥100% = grün, ≥90% = gelb, <90% = rot)
- **Rezept-Overview-Tab**: Panel "Wann packen?" mit Do/Fr/Sa Zielmenge und Ist

### Tab entdecken:

```bash
npm run discover:sheets
# → zeigt alle Tabs und GIDs der 6 Sheets
```

---

## Schnell-Diagnose: Was prüfen wenn X leer ist

### Rezeptliste (linke Seite) ist leer
→ Problem: `weekRecipes`-Collection in Firestore oder Forecast Tracker GSheet  
→ Prüfen: `.env.local GSHEET_ID` → Sheet öffnen → Tab `PO Maitre` oder `[Import] Convini Order Sheet` hat Daten?  
→ Fix: `npm run import:gsheet && npm run push:firestore`

### Portionen bei einem Rezept zeigen „0"
→ Problem: Rezept-Code stimmt nicht exakt überein (z.B. `FV1234NL` vs `FV1234NL0`)  
→ Fix: Im GSheet den exakten Code vergleichen mit dem Code in der App (Mono-Font-Anzeige im Header)

### Sub-Rezepte-Tab ist leer / „Keine Rezept-Stammdaten"
→ Problem: `export-recipes (X).csv` in `C:\Rezeptlogik` veraltet oder fehlt  
→ Fix: Frischen Export aus HelloFresh Recipe Tool ziehen → `import:gsheet` neu

### Σ Wochenbestellung zeigt keine Zutaten
→ Problem: `export-gross-ingredients (X).csv` fehlt oder Rezept hat keinen Gross-Export  
→ Fix: Gross-Ingredients-Export für den Markt neu ziehen → `import:gsheet` neu

### Rezeptstruktur (SVG-Baum) zeigt „keine Struktur"
→ Problem: `export-sub-recipes-by-recipe-detailed.csv` fehlt oder Rezept-Code nicht enthalten  
→ Fix: Detailed Export neu exportieren → `import:gsheet` neu

### Cook-Schedule zeigt „kein VF-Schedule definiert"
→ Problem: Die Cook-Method aus `export-recipes` stimmt nicht mit einer Zeile in `Cook Schedules Per DC.csv` überein  
→ Fix: Cook-Method-Name im PFEI/CSV mit dem Schedule-CSV abgleichen — fuzzy Matching versucht Subset-Matches

### PFEI-Daten fehlen (Workflow-Tab zeigt nur „keine PFEI-Daten")
→ Problem: `PFEI_GSHEET_ID` nicht gesetzt oder Sub-Recipe-ID nicht im PFEI-Tab  
→ Fix: `.env.local PFEI_GSHEET_ID` setzen → `import:gsheet` neu

### Shelf Life / MLOR zeigt überall „kein Sheet-Match"
→ Problem: SKU-Codes aus Gross-Export stimmen nicht mit Open Shelf Life Sheet überein  
→ Fix: Ingredient-IDs im Gross-CSV und im Sheet vergleichen → ggf. Sheet-ID in `.env.local OPEN_SHELF_GSHEET_ID` prüfen

### Planning OASE / Maitre-Ramp-Up leer
→ Problem: `sync:fulfillment:report` nie ausgeführt oder Fulfillment Report nicht zugänglich  
→ Fix: `npm run sync:fulfillment:report` → prüfen ob `Maitre Inputs DE/NO_Stamm`-Tab existiert

### Ramp-Up Sparkline / Geschichte fehlt (OverviewTab)
→ Problem: `refreshRampUp` Cloud Function nicht deployed oder GSheet nicht erreichbar  
→ Fix: `npm run deploy:functions` → Firebase Function Logs prüfen auf Auth-Fehler

---

## .env.local Pflicht-Felder

```env
# Service Account (NIEMALS committen!)
GOOGLE_APPLICATION_CREDENTIALS=./secrets/service-account.json

# Haupt-Sheet (Forecast Tracker / Ramp-up Quelle) — PFLICHT
GSHEET_ID=<Spreadsheet-ID>

# Weitere Ramp-Up Sheets (kommagetrennt)
# GSHEET_IDS=1cQtoL4aYHfc_44mfQQty8-EFKPZoYPLBQ2ojmO8hgzg

# Operational Sheets (Defaults sind eingetragen — nur überschreiben wenn nötig)
SHEET_WOCHENSTART=1YscgiuKYVI2pGcMJ3RcJwWGQEkG46RnVnji8q8a4AeE
SHEET_PRINT_ORDERS=1fpEHBWmd_zk74wbu78unPoTV_u860smNlxTuioEdq-4
SHEET_KITCHEN_PRIORITY=13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U
SHEET_FERTIGSTELLUNG=1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY

# Tab-Name Overrides (leer lassen = erster Tab wird automatisch genommen)
# SHEET_FERTIGSTELLUNG_TAB=
# SHEET_PRINT_ORDERS_TAB=
# SHEET_KITCHEN_PRIORITY_TAB=

# PFEI-Sheet (Equipment/Batch-Daten) — PFLICHT für Workflow-Tab
PFEI_GSHEET_ID=<Spreadsheet-ID>

# Open Shelf Life (default gesetzt, aber überschreibbar)
# OPEN_SHELF_GSHEET_ID=1dET5WmRKYRhmzEmhlBv1ZpRo5huWgNLfIY6uaLpCrcc
# OPEN_SHELF_GSHEET_TAB=ALL in 1

# Lokales CSV-Verzeichnis (default: ./imports dann C:\Rezeptlogik)
# REZEPTLOGIK_SOURCE_DIR=
```

### Tab-Namen herausfinden

Bevor der erste `import:gsheet`-Lauf mit den neuen Sheets klappt:

```bash
npm run discover:sheets
```

Gibt für alle 6 Sheets Tab-Namen + GIDs aus. Wenn ein Tab gefunden wird, wird er automatisch als erster Tab verwendet. Falls der falsche Tab gelesen wird, den richtigen Namen in `.env.local` als `_TAB`-Variable eintragen.

---

## Normaler Sync-Ablauf (Wochenstart)

```bash
# 1. Alles synchronisieren (Forecast + GSheet + Registry + Fulfillment)
npm run sync:all

# 2. Build + Deploy
npm run deploy

# Oder alles in einem:
npm run sync:all:deploy
```

Was `sync:all` macht:
1. `sync:factor:forecast` → Factor Daily von Drive laden
2. `import:gsheet` → Forecast Tracker + lokale CSVs → `public/data/data.json` + Firestore
3. `sync:gsheet:registry` → GSheet-Quellen-Registry aktualisieren
4. `sync:fulfillment:report` → Fulfillment Report → Firestore (maitreRampup, produktionsplanung, fcmsInbound)
