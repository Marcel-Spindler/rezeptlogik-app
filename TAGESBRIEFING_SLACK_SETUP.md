# Tagesbriefing 15:00 — Einrichtung des Slack-Posts

Eine Cloud Function (`dailyBriefingSlack`) postet **jeden Tag 15:00 Uhr**
(Europe/Berlin) eine Zusammenfassung in einen Slack-Kanal — z. B. **Mission
Kontroll**.

**MVP-Umfang** (bewusst klein, siehe Kommentar oben in
`functions/dailyBriefingSlack.js`):

- 🔴 **Backfill offen** — exakt dieselbe Rechenlogik wie der laufende
  Backfill-Wächter (`rtiBackfillWatch`, siehe `BACKFILL_WAECHTER_SETUP.md`),
  hier nur einmal täglich statt alle 10 Minuten zusammengefasst.
- 👥 **Küchen-Besetzung** — aus dem wöchentlichen Staffing-Plan-Sheet
  ("Headcount - Required" → Kitchen, laufende KW).

Der volle Umfang des Browser-Tagesbriefings (Kritisch-Liste,
Rohware/MHD-Engpässe, Plating-Todo, "Morgen zuerst anfassen") ist **nicht**
enthalten — der läuft im Browser auf Live-GSheet-/Snowflake-Daten und ist kein
1:1 portierbarer Server-Job. Kann später erweitert werden.

---

## 1 · Webhook-URL besorgen (Slack Workflow Builder)

Genau derselbe Weg wie beim Backfill-Wächter — siehe
**`BACKFILL_WAECHTER_SETUP.md` → „Weg A · Workflow Builder"** — nur mit
anderem Zielkanal/Namen:

1. Kanal: **Mission Kontroll** (schon vorhanden), Leute rein falls nötig.
2. Slack → **⋯ Mehr → Automatisierungen → Workflow Builder** → **Neuer
   Workflow** → Name z. B. **„Tagesbriefing 15 Uhr"**.
3. Trigger: **„Von einem Webhook"**.
4. Webhook-Daten-Variable: Schlüssel **`text`**, Typ **Text**. Speichern.
   *(Genau `text` — der Code schickt `{"text": "…"}`.)*
5. **Schritt hinzufügen → Nachrichten → „Nachricht an einen Kanal senden"**
   → Kanal = **Mission Kontroll** → Nachrichtenfeld → **„Variable einfügen"
   → `text`**.
6. **Veröffentlichen.**
7. Beim Trigger-Schritt steht jetzt die Webhook-URL
   `https://hooks.slack.com/triggers/…` → kopieren. Das ist das Passwort —
   nicht ins Git.

Falls Workflow Builder bei euch gesperrt ist: **Weg B (Incoming Webhook)** in
`BACKFILL_WAECHTER_SETUP.md` nutzen, liefert dieselbe Art URL
(`https://hooks.slack.com/services/…`) — der Code kommt mit beiden Formen klar.

Test, sobald die URL da ist:
```bash
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"Tagesbriefing Test ✅"}' \
  "DEINE_URL"
```

---

## 2 · URL in die Functions-Umgebung

In **`functions/.env`** (lokal, gitignored) ergänzen:
```
DAILY_BRIEFING_SLACK_WEBHOOK_URL=https://hooks.slack.com/DEINE/URL
```
**Eigene Variable** — unabhängig von `SLACK_WEBHOOK_URL` (Backfill-Wächter).
Beide Automatisierungen können in unterschiedliche Kanäle posten.

Optional (Defaults passen sonst):
```
# jeden Tag 15:00 ist Default; z. B. nur Mo–Fr:
DAILY_BRIEFING_SCHEDULE=0 15 * * 1-5
```

---

## 3 · Deploy

```bash
firebase deploy --only functions:dailyBriefingSlack
```
> Nur diesen Namen deployen — **nie** `--only functions` ohne Liste (löscht
> fremde Functions im geteilten Projekt).

Beim ersten Deploy legt Firebase automatisch einen Cloud-Scheduler-Job
`firebase-schedule-dailyBriefingSlack-europe-west3` an (täglich 15:00
Berlin-Zeit, per `timeZone` in der Function-Config). Kontrolle: GCP Console →
Cloud Scheduler.

---

## 4 · Prüfen

- GCP Console → Cloud Functions → `dailyBriefingSlack` → **Logs**: einmal
  täglich eine Zeile `dailyBriefingSlack gepostet { openMeals: …,
  kitchenHeadcount: … }`.
- Manuell auslösen zum Testen: Cloud Scheduler → Job
  `firebase-schedule-dailyBriefingSlack-europe-west3` → **Force run** (postet
  sofort, unabhängig von der Uhrzeit).
- Kommt `kitchenHeadcount: null` im Log: der Service-Account hat noch keinen
  Zugriff auf das Staffing-Plan-Sheet, oder die laufende KW-Spalte fehlt dort
  noch — Post erscheint trotzdem, zeigt dann ehrlich „Staffing-Plan nicht
  erreichbar" statt einer falschen Zahl.

---

## 5 · Später erweiterbar

- Weitere Signale aus dem Browser-Tagesbriefing serverseitig nachziehen
  (Kritisch-Liste, Rohware/MHD, Plating-Todo, Morgen-zuerst) — jedes für sich
  ein eigener Portierungs-Schritt, siehe Kommentar in
  `functions/dailyBriefingSlack.js`.
- Cron auf Mo–Fr umstellen, falls Wochenenden nicht gebraucht werden (siehe
  `DAILY_BRIEFING_SCHEDULE` oben) — kein Deploy der Logik nötig.
