# Backfill-Wächter — Einrichtung der Meldungen

Der Backfill-Wächter (`Live-Monitoring → Backfill-Wächter`) liest den RTI Plating
Tracker und meldet pro Sub-Rezept, was nachproduziert werden muss.

Es gibt **drei Melde-Wege**. Der In-App-Alarm läuft sofort; Slack und
„done"-Rückschreiben brauchen einmal Setup + einen `functions`-Deploy.

---

## 1 · In-App: rotes Flackern + Alarmton  ✅ läuft ohne Setup

- Taucht ein Backfill in den letzten **15 Minuten** neu auf, flackert das
  app-weite Banner hart rot und ein dreifacher Piepton geht los.
- **Bei ALLEN offenen Apps gleichzeitig:** wessen App den Backfill zuerst
  erkennt, schickt ein Flacker-Signal über Firestore an alle anderen. Hängt
  **nicht** an Snowflake — die Backfill-Erkennung kommt rein aus dem
  Google-Sheet. (Ohne die Cloud Function unten propagiert es trotzdem, sobald
  irgendeine App es sieht; die Function ist das Netz für „niemand hat die App
  offen".)
- Der **🔔 / 🔇**-Knopf im Banner schaltet den Ton ab (pro Browser gemerkt).
- Der Ton kann beim allerersten Mal stumm bleiben, bis die Seite einmal
  angeklickt wurde (Browser-Autoplay-Sperre) — das Flackern greift immer.
- Nichts zu tun.

---

## 2 · Slack-Meldung  (empfohlen für „3 Leute direkt")

Eine Cloud Function (`rtiBackfillWatch`) prüft den RTI-Rechner **alle 10 Minuten**
server-seitig und postet in einen Slack-Kanal:

| | wann |
|---|---|
| 🔴 *Backfill nötig* | ein Sub-Rezept ist neu leergelaufen |
| ✅ | ein Engpass wurde ins System eingetragen (Sheet „done") |
| ⏰ | Wiegung läuft seit > 30 min, aber Subs noch ohne Status im Sheet |

Die Function braucht **eine URL**, an die sie `{"text": "…"}` per HTTP POST
schickt. Es gibt zwei Wege dahin. Beide liefern eine `https://hooks.slack.com/…`-
URL, beide funktionieren mit dem Code — nimm den, der bei euch nicht an einer
Freigabe hängt.

---

### Weg A · Workflow Builder  (meist ohne App-Freigabe, wenn Paid-Plan)

Das ist **keine App** → kein „App-Approval"-Menü. Voraussetzung: Paid-Plan und
der Admin hat Workflow Builder nicht gesperrt.

1. Zielkanal anlegen, z. B. **`#backfill-alarm`**, die 3 Leute rein (`/invite`).
2. In Slack oben links **… Mehr → Automatisierungen → Workflow Builder** →
   **Neuer Workflow** → Name „Backfill-Wächter".
3. Trigger wählen: **„Von einem Webhook"** (engl. *From a webhook*).
4. Bei **Webhook-Daten** eine Variable anlegen:
   Schlüssel **`text`**, Typ **Text**. Speichern. *(Genau `text` — der Code
   schickt `{"text": "…"}`.)*
5. **Schritt hinzufügen → Nachrichten → „Nachricht an einen Kanal senden"**.
   Kanal = **`#backfill-alarm`**. Ins Nachrichtenfeld **„Variable einfügen" → `text`**.
6. **„Fertigstellen" / Veröffentlichen.**
7. Beim Trigger-Schritt steht jetzt die **Webhook-URL**
   `https://hooks.slack.com/triggers/…` → **kopieren**.
   Das ist das Passwort — nicht ins Git.

Test:
```bash
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"Backfill-Wächter Test A ✅"}' \
  "https://hooks.slack.com/triggers/DEINE/URL"
```

---

### Weg B · Incoming Webhook (Slack-App)  — falls Weg A nicht geht

Hier landest du im „Basic Information"-Menü mit **Client ID / Client Secret /
Signing Secret / App-Level Tokens** — **die brauchst du alle NICHT**. Ignorieren.
Du brauchst nur die eine Zeile unter „Incoming Webhooks".

1. Zielkanal anlegen (`#backfill-alarm`), 3 Leute rein.
2. <https://api.slack.com/apps> → **Create New App** → **From scratch** →
   Name „Backfill-Wächter", Workspace = euer Space → **Create App**.
   *(App ERSTELLEN darf jeder — kein Admin nötig. Die Freigabe kommt erst
   beim Installieren in Schritt 4.)*
3. Linke Leiste → **Incoming Webhooks** → **„Activate Incoming Webhooks"** auf **On**.
4. Ganz unten **„Add New Webhook to Workspace"** → Kanal **`#backfill-alarm`**
   → **Zulassen / Authorize**.
   - **Kommt jetzt eine URL** (`https://hooks.slack.com/services/T…/B…/…`) →
     kopieren, fertig.
   - **Kommt stattdessen „Anfrage an Admins gesendet"** → euer Workspace hat
     App-Freigabe an. Ein **Workspace-Owner / App-Manager** genehmigt unter
     **Verwaltung → Apps und Workflows → App-Verwaltung**. Danach kommt per
     Slackbot eine Nachricht; dann Schritt 4 nochmal. Status siehst du auch
     auf der App-Seite selbst („Pending Approval").

Test:
```bash
curl -X POST -H 'Content-type: application/json' \
  --data '{"text":"Backfill-Wächter Test B ✅"}' \
  "https://hooks.slack.com/services/DEINE/WEBHOOK/URL"
```

> **Fehler `action_prohibited` beim POST** = der Admin hat die App/den Webhook
> nachträglich eingeschränkt → nochmal genehmigen lassen.

---

**Rate-Limit (beide Wege):** 1 Nachricht/Sekunde (kurze Spitzen ok). Der
Wächter postet höchstens ein paar Zeilen alle 10 min — unkritisch. Bei `HTTP 429`
wartet die Function bis zum nächsten Lauf.

### 2b · URL in die Functions-Umgebung

In **`functions/.env`** (lokal, gitignored) ergänzen — egal ob `…/triggers/…`
(Weg A) oder `…/services/…` (Weg B):
```
SLACK_WEBHOOK_URL=https://hooks.slack.com/DEINE/URL
```
Optional daneben (Defaults passen sonst):
```
RTI_SHEET_TAB=RTI
RTI_STALE_MIN=30
```

### 2c · Deploy

```bash
firebase deploy --only functions:rtiBackfillWatch,functions:rtiMarkDone
```
> Nur diese beiden Namen deployen — **nie** `--only functions` ohne Liste
> (löscht fremde Functions im geteilten Projekt).

Beim ersten Deploy legt Firebase automatisch einen **Cloud-Scheduler-Job**
`firebase-schedule-rtiBackfillWatch-europe-west3` an (alle 10 min). Nichts weiter
zu tun. Kontrolle: GCP Console → Cloud Scheduler.

### 2d · Prüfen

- GCP Console → Cloud Functions → `rtiBackfillWatch` → **Logs**: alle 10 min
  eine Zeile `rtiBackfillWatch { meals: …, newOpen: … }`.
- Beim nächsten echten Engpass kommt der Slack-Post.
- Manuell auslösen: Cloud Scheduler → Job → **Force run**.

---

## 3 · Wächter schreibt „done" ins Sheet zurück

Wenn du im Wächter **„📋 kopieren & erledigt"** oder **„✓ nur als erledigt"**
klickst, ruft die App `/api/rti-mark-done` (Function `rtiMarkDone`), die **`done`
in Spalte J** der WO-Zeile setzt. Der Sub verschwindet dann beim nächsten Poll
aus der offenen Liste — bei dir und bei allen anderen.

**Voraussetzung:** der Service-Account darf das RTI-Sheet **bearbeiten**.

1. Finde die SA-E-Mail: sie steht im JSON hinter
   `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (Feld `client_email`), Form
   `…@….iam.gserviceaccount.com` (aktuell `pdl fast reader`).
   ```bash
   node -e "console.log(JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64,'base64')).client_email)"
   ```
2. RTI-Sheet öffnen → **Freigeben** → SA-E-Mail eintragen → Rolle
   **Bearbeiter** → senden (Häkchen „Personen benachrichtigen" aus).
3. `firebase deploy --only functions:rtiMarkDone` (falls noch nicht in 2c mit).

Schlägt der Aufruf fehl (Recht fehlt / Function nicht deployed), bleibt der
lokale Haken trotzdem stehen und die Zeile zeigt „⚠ Sheet-Eintrag `done` hat
nicht geklappt" — dann im Sheet von Hand `done` eintragen.

---

## 4 · Bestandssuche „steht es vielleicht schon woanders?" ✅ im Wächter

Pro offenem Engpass-Sub zeigt der Wächter eine Zeile **„📦 Woanders im System:
N Portionen (Chiller · Staging · …)"** — der fertige Sub-Bestand über *alle*
WMS-Lagerorte (Plating Holding ausgenommen, das zählt Spalte F schon). Deckt das
den Mindestbedarf, wird 🔴 zu 🟡 „erst dort prüfen". Alles an einer Stelle, kein
Umherklicken.

Läuft nur mit dem **lokalen WMS-Server** (`npm run wms:server`) bzw. dem
Cloud-Cache — sonst erscheint die Zeile einfach nicht.

## 5 · Noch nicht gebaut (auf Zuruf)

- **Browser-Push** (OS-Benachrichtigung, auch bei Tab im Hintergrund / Handy) —
  braucht ein PWA-Grundgerüst + VAPID-Keys. Separater Schritt.
- **Bestandssuche erweitern** — bald eintreffende reguläre/Backfill-WOs und den
  Blast-Chiller-*Plan* mit einbeziehen (aktuell nur der physische WMS-Bestand).
