# Tagesbriefing 15:00 — Einrichtung des Slack-Posts

Eine Cloud Function (`dailyBriefingSlack`) postet **jeden Tag 15:00 Uhr**
(Europe/Berlin) eine Zusammenfassung in einen Slack-Kanal — z. B. **Mission
Kontroll**.

**Umfang** (siehe Kommentar oben in `functions/dailyBriefingSlack.js`):

- 🔴 **Backfill offen** — exakt dieselbe Rechenlogik wie der laufende
  Backfill-Wächter (`rtiBackfillWatch`, siehe `BACKFILL_WAECHTER_SETUP.md`),
  hier einmal täglich zusammengefasst.
- 👥 **Küchen-/Plating-Besetzung** — aus dem wöchentlichen Staffing-Plan-Sheet.
- 🍽 **Plating-Fortschritt** — je Meal Planned/Actuals aus dem RTI-Sheet.
- 🚨 **Kritisch (Küche)**, **Zu plaitieren**, **Morgen zuerst anfassen** —
  gespeist aus dem "Transperancy Total Overview"-Sheet (live, kein Browser-
  Tab nötig) + Postblast/Preblast-Gewichten.
- 🧪 **Transparency-Produzierbarkeit** — dieselbe Rechnung wie die
  Browser-Ansicht, serverseitig nachgebaut (`functions/transparencyLite.js`).
- ⚙️ **Equipment morgen** (GN-Bleche/Wannen/Racks/Blast-Chiller/MA-Bedarf) und
  🧊 **Rohware/MHD-Feasibility** offener Backfills — diese zwei brauchen Daten,
  die nur **lokal** vorliegen (die volle Rezeptdatenbank bzw. den
  Snowflake-Vollbestand über den lokalen WMS-Server). Ein Windows Scheduled
  Task (`scripts/daily-briefing-equipment-feasibility-relay.ts`) rechnet das
  alle 20 Minuten lokal und schreibt das Ergebnis nach Firestore — die Cloud
  Function liest es beim Posten und zeigt ehrlich "nicht verfügbar", wenn der
  Snapshot älter als ~50 Minuten ist (Rechner aus, Snowflake-Session
  abgelaufen o. ä.), statt eine veraltete Zahl zu posten.

Noch offen: Cross-Source-Backfill-Alerts aus dem LinePlating-Tab (Plating-
Team-Meldungen) — der einzige Signal-Typ aus der Browser-Ansicht, der hier
noch fehlt.

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

Mit **nur** dieser URL läuft der Post schon vollständig — als **eine** lange
Nachricht (Kompaktteil + alle Details zusammen). Für das kürzere Layout
(kompakte Kacheln oben, Details als Antwort im Thread darunter) siehe
**Schritt 5** unten — das ist optional und kann jederzeit später nachgerüstet
werden, ohne dass vorher irgendetwas kaputt ist.

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

## 3 · Lokaler Relay für Equipment + Rohware/MHD

Damit die zwei lokal-gebundenen Abschnitte (Equipment morgen, Rohware/MHD)
im Post erscheinen, muss auf dem Rechner, auf dem auch der Backfill-Relay
(`rti-redzone-relay.ts`) läuft, zusätzlich dieser Windows Scheduled Task
laufen — **ist bereits eingerichtet** (Task „RezeptlogikDailyBriefingRelay",
alle 20 Minuten, siehe `scripts/run-daily-briefing-relay.cmd`). Nichts zu tun,
außer bei Bedarf zu prüfen:

```bash
schtasks /query /tn "RezeptlogikDailyBriefingRelay" /v /fo list
```

Voraussetzungen, damit der Job wirklich etwas liefert:

- Eine KET-Export-CSV liegt in `imports/` (wie gewohnt, für die Equipment-
  Rechnung — ohne sie wird der ganze Abschnitt einfach ausgelassen).
- Für Rohware/MHD zusätzlich: der lokale WMS-Server läuft (`npm run
  wms:server`) und ist per Browser-SSO mit Snowflake verbunden — läuft er
  nicht, wird nur diese eine Sektion ausgelassen (kein Fehler-Alarm).

---

## 4 · Deploy

```bash
firebase deploy --only functions:dailyBriefingSlack
```
> Nur diesen Namen deployen — **nie** `--only functions` ohne Liste (löscht
> fremde Functions im geteilten Projekt).

Beim ersten Deploy legt Firebase automatisch einen Cloud-Scheduler-Job
`firebase-schedule-dailyBriefingSlack-europe-west3` an (täglich 15:00
Berlin-Zeit, per `timeZone` in der Function-Config). Kontrolle: GCP Console →
Cloud Scheduler.

Der Service-Account (`GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, derselbe wie für
RTI-/Staffing-Sheet) braucht Lesezugriff auf das "Transperancy Total
Overview"-Sheet (`SHEET_FERTIGSTELLUNG`) — das ist bereits mit ihm geteilt
(eine andere bestehende Function, `refreshOperationalData`, liest es schon
erfolgreich). Zeigt der Post trotzdem "kein Produktionsplan gefunden": Logs
prüfen, Zugriff ggf. nachziehen.

---

## 5 · Optional: kompakter Post + Details im Thread (Bot-Token)

**Ohne diesen Schritt funktioniert alles** — der Post kommt als eine einzige,
etwas längere Nachricht. Dieser Schritt sorgt dafür, dass oben nur eine kurze
Übersicht (KPI-Zahlen + Top-5-Kritisch) steht und alle Details als Antwort
im selben Thread darunter erscheinen — übersichtlicher im Kanal, nichts geht
verloren. Braucht einen Slack-**Bot** mit Schreibrecht (`chat:write`) statt
nur einer Webhook-URL. Einmalig einzurichten, ca. 10 Minuten:

1. Browser → **`api.slack.com/apps`** → **„Create New App"** →
   **„From scratch"**. Name z. B. **„Tagesbriefing Bot"**, Workspace: eures.
2. Links im Menü: **„OAuth & Permissions"**.
3. Runterscrollen zu **„Scopes" → „Bot Token Scopes"** → **„Add an OAuth
   Scope"** → **`chat:write`** auswählen. (Nur dieser eine Scope wird
   gebraucht.)
4. Ganz oben auf der Seite: **„Install to Workspace"** (oder „Reinstall")
   klicken → bestätigen.
5. Danach steht oben ein **„Bot User OAuth Token"**, beginnt mit `xoxb-…` →
   kopieren. Das ist ein Passwort — nicht ins Git, nicht in Slack posten.
6. Den Bot in den Zielkanal einladen: im Kanal **Mission Kontroll** eine
   Nachricht schreiben mit `/invite @Tagesbriefing Bot` (Namen ggf. anpassen)
   und Enter.
7. Die Kanal-**ID** herausfinden (nicht der Name): im Kanal auf den
   Kanalnamen oben klicken → ganz unten im Popup steht z. B. `C0123456789` →
   kopieren.
8. In **`functions/.env`** ergänzen:

   ```bash
   SLACK_BOT_TOKEN=xoxb-...
   DAILY_BRIEFING_SLACK_CHANNEL=C0123456789
   ```
9. Erneut deployen (Schritt 4 oben).

Ab jetzt: kompakter Post + Thread-Antwort(en) mit den Details. Fehlt eine der
beiden Variablen (z. B. weil noch nicht eingerichtet), läuft automatisch der
bisherige Webhook-Weg — nichts bricht dabei.

---

## 6 · Prüfen

- GCP Console → Cloud Functions → `dailyBriefingSlack` → **Logs**: einmal
  täglich eine Zeile `dailyBriefingSlack gepostet { … }` mit u. a.
  `extendedOk`, `producibilityOk`, `relayAvailable`, `slackBotConfigured`.
- Manuell auslösen zum Testen: Cloud Scheduler → Job
  `firebase-schedule-dailyBriefingSlack-europe-west3` → **Force run** (postet
  sofort, unabhängig von der Uhrzeit).
- Kommt `kitchenHeadcount: null` im Log: der Service-Account hat noch keinen
  Zugriff auf das Staffing-Plan-Sheet, oder die laufende KW-Spalte fehlt dort
  noch — Post erscheint trotzdem, zeigt dann ehrlich „Staffing-Plan nicht
  erreichbar" statt einer falschen Zahl. Genauso ehrlich degradiert der Post
  bei `relayAvailable: false` (Equipment/Rohware ausgelassen) oder
  `producibilityOk: false` (Sheet-Fehler).

---

## 7 · Später erweiterbar

- Cross-Source-Backfill-Alerts (LinePlating-Tab, Plating-Team-Meldungen) —
  einziger verbliebener Signal-Typ aus der Browser-Ansicht.
- Cron auf Mo–Fr umstellen, falls Wochenenden nicht gebraucht werden (siehe
  `DAILY_BRIEFING_SCHEDULE` oben) — kein Deploy der Logik nötig.
