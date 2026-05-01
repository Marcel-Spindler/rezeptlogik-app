# Scratch – Schnelle Berechnungen & Analysen

Hier kommen Ad-hoc-Skripte, Wegwerf-Analysen und Experimente rein.
Nichts hier ist produktionskritisch.

## Konventionen

- Dateinamen mit Datum-Präfix, z.B. `2026-05-01_analyse-portionen.py`
- Temporäre Outputs (CSV, JSON) liegen ebenfalls hier und werden **nicht** committed
- `.gitignore` schließt `*.csv`, `*.json`, `output/` aus

## Verfügbare Datenquellen

- `../public/data/data.json` – Haupt-Datendump
- `../public/data/gsheet-truth-export/` – CSV-Exporte aus Google Sheets
- `../Rezeptlogik/` – Rezept- und Zutaten-Exporte

## Rackfile Tool

- Plan-Check (fehlende Inputs, fehlende Spalten, ungültige Positionen):
  `npm run rackfile:plan -- --market de --week 2026-W19`
- Generieren:
  `npm run rackfile:generate -- --market de --week 2026-W19`
- Nordics:
  `npm run rackfile:generate -- --market nordics --week 2026-W19`

Optional:

- `--excel scratch/MultiLine ... .xlsx` (Quelle explizit)
- `--sheet "static exportP2L - DACH"` (Sheet überschreiben)
- `--lines ASL3,ASL4` (Linien überschreiben)
- `--extras scratch/rackfile-extras.de.json` (manuelle Zusatzitems)
- `--pdl public/data/gsheet-truth-export/Factor_DE - PDL Forecast.csv` (Meal-Abgleich)
- `--etl-root G:\\.shortcut-targets-by-id\\...\\ETL_OR\\ETL_OR_FACTOR` (ETL-Boxfile/CO2-Abgleich)
- `--skip-etl true` (ETL-Check deaktivieren)

## Pflicht-Inputs (für stabile Produktion)

- `market`: `de` oder `nordics`
- `week`: ISO-Woche wie `2026-W19`
- MultiLine-Excel mit passendem Export-Sheet (de: `static exportP2L - DACH`, nordics: `static exportP2L - Nordics`)
- Ziel-Linien (de: `ASL3,ASL4`, nordics: `ASL1,ASL5`)

## ETL-Validierung

Wenn der ETL-Root erreichbar ist, vergleicht das Tool automatisch:

- Rackfile-Rezepte vs. `BOXFILE_VE` (marktbezogen: DE=TZ, Nordics=TK)
- Rackfile-Rezepte vs. `CO_2/DWHTAXI/or-*.csv` (boxid-prefix gefiltert)
- Ice/Loyalty/BoxSize/Coolpouch aus Boxfile gegen Rackfile-Recipes
