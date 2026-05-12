# TODO – Planning OASE / Cockpit Fixes

- [x] Analyse der Main-Pillen-Renderlogik und Auto-Plan-Zuordnung (Main vs. Sub) in `src/PlanningView.tsx`
- [ ] Fix implementieren: Main-Pille mit Stückzahl muss sichtbar sein (inkl. robustem Fallback auf Produktionstag)
- [ ] "Plan sichern" Funktion im UI ergänzen (KW/Szenario Snapshot für Rundmail-Weitergabe)
- [ ] Ggf. Persistenz/Typen in `src/planner.ts` erweitern
- [ ] Critical-Path Testing durchführen:
  - [ ] Main-Pille sichtbar bei aufgeklapptem Main + Auto/Sub-Plan
  - [ ] Auto-Plan Main/Sub konsistent
  - [ ] "Plan sichern" funktioniert wie erwartet
- [ ] TODO aktualisieren und Ergebnis zusammenfassen
