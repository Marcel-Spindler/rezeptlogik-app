# Feature-Checkliste: Was bleibt, was fliegt?

Hake an, was in der neuen App enthalten sein soll.  
Alles ohne Haken wird gelöscht.

---

## Views / Seiten

- [xx ] **Rezept-Detailansicht** — Haupt-View: zeigt Infos zum gewählten Rezept
- [ x] **Planning OASE** — Planungs-Cockpit (Marcel: bleibt!)
- [x ] **Σ Wochenbestellung** — aggregierte Brutto-Zutaten über alle Rezepte einer KW
- [ ] **Equipment-Kapazität** — Kapazitätsberechnung je Station (Braiser, Oven, ...)
- [ ] **WMS Live** — Live-Ansicht aus dem Warehouse Management System
- [ ] **Wochenplaner** — ältere Planungs-View
- [x ] **What-if & Diff** — Szenarien vergleichen / Mengen-Diff
- [x ] **Rundmail / 📧** — automatisch generierte Planungs-E-Mail
- [ x] **Breakdown (Küchenmodus)** — Küchen-optimierte View, teilbar per Link
- [ x] **KET / Rack** — Rack-Auslastungs-Ansicht

---

## Features in der Seitenleiste

- [ x] **KW-Auswahl** — Dropdown Kalenderwoche
- [ ]x **Rezeptliste** — Liste aller Rezepte der gewählten KW mit Portionen
- [x ] **Suche** — Freitext-Suche nach Rezeptname, Code, SKU, Zutat
- [ ] **Vorwochenvergleich (Delta-Karte)** — Δ Portionen, Δ Rezepte, neu/weggefallen
- [ x] **Uplift-Slider** — Planmenge prozentual anheben (–10 % bis +30 %)
- [ x] **Markt-Portionen-Summen** — BENL / DKSE / DE Gesamtportionen je KW
- [ x] **Ramp-Up Sparkline** (in Rezeptliste) — kleine Kurve je Rezept in der Liste
- [ 00] **Küchen-Link kopieren** — Share-URL für den Küchenmodus

---

## Features im Rezept-Detail

- [x ] **Rezept-Header** — Name, Code, Preference, Portionen je Markt
- [ x] **Sub-Rezept-Baum** — Hierarchie Main → Sub1 → Sub2 → Zutaten (aus Detailed Export)
- [x ] **Ramp-Up Panel** — Snapshot-Tabelle + Sparkline für das gewählte Rezept
- [ x] **Zutaten-Liste** — alle Zutaten mit Mengen, flach aufgelistet
- [ x] **Brutto-Zutaten** — Brutto-Mengen je Markt (aus GrossIngredients)
- [ ] **Shelf Life / Haltbarkeit** — MHD-Status je Zutat (ok / risk / critical)
- [ x] **Cook Schedule / Timing** — wann welcher Schritt (D-2, D-1, D0)
- [ x] **Prozess-Steps / Workflow** — Stationsschritte aus PFEI (Braiser, Oven, ...)
- [ x] **Batch-Kalkulator** — Batch-Größen + Anzahl Batches je Station
- [x ] **Vorproduktions-Empfehlung** — Hinweis wenn Sub-Rezept D-2 empfohlen
- [ x] **Markt-Wechsler** — zwischen BENL / DKSE / DE wechseln
- [ x] **Fulfillment-Split** — Freitag vs. Sonntag Lieferung DE
- [ x] **MSKU / Verpackungs-SKU** — Primär- und Sekundärverpackung je Markt
- [ x] **Allergen-Anzeige** — Allergene je Rezept / Markt

---

## Datenquellen (Imports)

- [ ] **WeekRecipes** — Rezepte + Portionen je KW (aus GSheets)
- [ ] **Ramp-Up / Maitre Inputs** — Snapshot-Volumen je Rezept/Woche (aus GSheets)
- [ ] **Sub-Recipe Detailed Export** — Rezeptbaum aus `export-sub-recipes-by-recipe-detailed.csv`
- [ ] **Recipes (Vollstruktur)** — vollständige Rezeptdaten inkl. Zutaten, MSKUs, Allergene
- [ x] **Cook Schedules** — Timing-Pläne je Cook Method (D-2, D-1, D0)
- [x ] **Process Specs (PFEI)** — Batch-Größen + Minuten je Station
- [ x] **Shelf Life** — MHD-Daten je Ingredient-SKU
- [x ] **WMS-Daten** — Warehouse-Bewegungsdaten
- [ x] **Fulfillment Report** — Produktionsplanungs-Tabs (DE / Nordics Slots)
- [x ] **FCMS Inbound** — tatsächlich eingegangene PO-Positionen

---

## Scripts

- [ ] `import-week-recipes` — GSheets → WeekRecipes
- [ x] `import-rampup` — GSheets → Ramp-Up Snapshots
- [ x] `import-sub-recipes` — CSV → Rezeptbaum (neu, nach CSV-Beispiel)
- [ x] `push-firestore` — Daten in Firestore schreiben
- [x ] `import-gsheet` (aktuell) — volles GSheets-Import inkl. Rezepte/Strukturen
- [ ] `sync-factor-forecast` — Factor-Forecast Sync
- [ ] `sync-running-forecast` — Running Forecast Sync
- [ ] `sync-fulfillment-report` — Fulfillment Report Sync
- [x ] `import-pfei` — PFEI Process Specs Import
- [ ] `sync-wms-cache` — WMS Cache Sync
- [ ] `push-wms-firestore` — WMS Daten → Firestore
- [ ] `push-wms-transaction-log` — WMS Transaktions-Log
- [ ] `sync-wms-kw-tabs` — WMS KW-Tabs Sync
- [x ] `rackfile-tool` — Rack-File Generator
- [x ] `read-open-shelf` — Open Shelf Life Daten
- [ ] `refresh-gsheet-sources` — GSheet Registry aktualisieren
- [ ] `dump-gsheet` — GSheet Dump
- [ x] `extract-meal-translations` — Meal-Übersetzungen extrahieren

---

## Sonstiges

- [ ] **Mehrsprachigkeit (DE / NL / EN)** — UI-Labels in 3 Sprachen
- [x ] **Kitchen Mode** — separater URL-Parameter `?surface=kitchen`
- [ x] **Live-Refresh** — Firestore-Listener + minütlicher Ramp-Up Refresh
- [ x] **URL-Parameter** — `?view=...&week=...` für Deep-Links
- [ x] **localStorage-Persistenz** — KW, Rezept, View zwischen Sessions merken
- [ x] **Export TSV** — Wochenbestellung als Tab-getrennte Datei kopieren
- [ x] **Playwright Smoke Tests** — automatisierte UI-Tests
