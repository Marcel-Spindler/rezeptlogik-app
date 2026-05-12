# TODO – LinePlanning Anpassungen (abgestimmt)

- [x] 1) `src/LinePlanningView.tsx`: `DAYS` auf Dienstag-Start umstellen  
      Reihenfolge: Dienstag, Mittwoch, Donnerstag, Freitag, Samstag, Sonntag, Montag

- [x] 2) `src/LinePlanningView.tsx`: Linienleistung bei 1200/h je Linie belassen  
      - Default 1200/h bestätigen
      - Keine Begrenzung auf 600 einführen

- [x] 3) `src/LinePlanningView.tsx`: „2x“-Badge verständlicher machen  
      - Anzeige in Slot-Pille von `2x` auf z. B. `2 Tage` ändern
      - Tooltip klar formulieren

- [x] 4) `src/LinePlanningView.tsx`: UI-Bereinigung laut Wunsch  
      - Button „🎯 Zielwerte übernehmen“ entfernen
      - Tab-Label „🍳 KET / Küche“ auf „🍳 KET“ ändern
      - Gelbe INFO-Hinweise entfernen (dataWarning + weekIntel-Warnung)

- [x] 5) `src/LinePlanningView.tsx`: Logik-Hinweis „Plating + Cockpit zusammen“ berücksichtigen  
      - Mindestens Reihenfolge/Tag-Logik für Auto-Plan auf Dienstag-Start konsistent halten
      - Sicherstellen, dass Zielerreichung Freitag/Sonntag durch bestehende Heuristik nicht gebrochen wird

- [x] 6) Build/Check ausführen

- [x] 7) Firebase Hosting deployen (`firebase deploy --only hosting`)

- [x] 8) `src/LinePlanningView.tsx`: Auto-Plan Kapazitätslogik auf echte Linienleistung fixen  
      - Auto-Plan darf bei 3 Linien nicht bei 1800/h hängen
      - Ziel: 1200/h je Linie => 3600/h gesamt erreichbar

- [ ] 9) `src/LinePlanningView.tsx`: Auto-Plan „zu Ende planen“ härten
      - Kein vorzeitiger Abbruch trotz freier Slots und Restmengen
      - Fallback-Belegung implementieren

- [ ] 10) `src/LinePlanningView.tsx`: Rezept-Progress/Volumen-Balance auf Linienkapazität vereinheitlichen
      - Konsistent zu IST/Ziel-Anzeige

- [ ] 11) `src/LinePlanningView.tsx`: Neuer Button „➡ Cockpit aufbauen“
      - Aus aktuellem Plating-Plan Cockpit-Daten erstellen
      - Danach automatisch in Firestore speichern

- [ ] 12) Build + Deploy + Verifikation
