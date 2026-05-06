och zur verfügung haben# TODO – App What-if Fix + Rack Drag&Drop + UI Cleanup

- [ ] 1) What-if & Diff in App reparieren
  - `phase2` View korrekt im Main-Render einhängen
  - Yield-Rechner robust für beide Richtungen (Rohware→Output, Output→Rohware)
  - Diff-Anzeige stabil und nachvollziehbar

- [ ] 2) Rack: Unplaced-Meals-Pills drag&drop-fähig machen
  - `draggable` aktivieren
  - `dragstart` mit `dataTransfer` + bestehendem Handler verdrahten
  - `dragend` mit bestehendem Handler verdrahten

- [ ] 3) Rack: "Manuelle Planung" Sektion entfernen
  - komplette Tabelle + Filter-UI entfernen
  - ungenutzte States/Computed Values bereinigen (`filterText`, `filteredEntries`)

- [ ] 4) Critical-path Validierung (A)
  - What-if & Diff lokal prüfen
  - Rack Drag von "Meals ohne Pickplatz" in Slots prüfen
  - kurzer Reload/Persistenz-Check
