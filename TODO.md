# Phase 3 – TODO (Engpass-Radar + Weekly Export + Automation)

- [ ] 1) Scope & Architektur festziehen
  - Zielbereiche: Engpass-Radar, Export-Paket, Automations/Polish
  - Ziel-Dateien identifizieren (voraussichtlich `src/App.tsx`, ggf. Helferdateien)

- [ ] 2) Engpass-Radar (MVP) implementieren
  - Aggregation kritischer Ingredients über Woche/Märkte
  - Severity-Logik + Priorisierung
  - UI-Karten + Tabelle mit Drilldown

- [ ] 3) Weekly Export-Paket (MVP) implementieren
  - Export der Radar-/Planungsdaten (CSV, optional XLSX)
  - konsistente Spalten + Dateinamen-Konvention

- [ ] 4) Automations/Polish
  - Filter/Zustand persistieren
  - UX-Polish + Fallbacks bei fehlenden Daten
  - Performance-Checks auf großen Datensätzen

- [ ] 5) Validierung
  - Build/Typecheck
  - Smoke-Tests der neuen Phase-3-Bereiche
  - kurze Regression der Kern-Navigation
