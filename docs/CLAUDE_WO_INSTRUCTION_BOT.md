# Google Gemini WO Instruction Bot

Der KET-WO-Breakdown kann pro ausgewaehlter WO eine individuelle Arbeitsanweisung erzeugen. Der Google-Gemini-Aufruf laeuft ausschliesslich im lokalen Server; der API-Key wird nie an den Browser uebergeben.

## Konfiguration

In `.env.local` oder in der Serverumgebung setzen:

```env
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
```

Danach starten:

```powershell
npm run dev:local
```

In der WO-Detailansicht `Instruction erzeugen` klicken. Der Kontext enthaelt WO, Rezept, Sub-Rezept, Portionen, Zutaten, Cook Methods, Equipment und Batchwerte.

## Sicherheitsregeln

- Gemini darf keine unbekannten Temperaturen, Zeiten, Kapazitaeten oder Qualitaetsgrenzen erfinden.
- Fehlende Fakten werden als `[MANUAL CHECK REQUIRED]` markiert.
- Jede Antwort wird als `needs_review` behandelt, bis sie fachlich geprueft wurde.
- Die erzeugte englische und deutsche Anweisung wird beim PDF-Druck fuer genau diese WO verwendet.
- Ohne `GEMINI_API_KEY` bleibt der bestehende Rezept-/Datenbanktext erhalten; der Server gibt eine kontrollierte Fehlermeldung zurueck.
