# Rezeptlogik · Verden Planer

Web-App (Vite + React + TypeScript + Tailwind + Firebase Hosting/Firestore) zur
Planung der Verden-Produktion (Site **VF**) für die Märkte BENL, DK/SE und DE.

> Pro Kalenderwoche → Rezepte mit Stückzahlen pro Markt → Sub-Rezepte,
> Brutto-Zutaten (hochgerechnet auf das gemeinsame Verden-Volumen) und
> Cook-Schedule-Timeline (4/3/2/1 Schichten vor + Produktionstag).

---

## 1. Lokal entwickeln

```powershell
cd C:\rezeptlogik-app
npm install
npm run import:local   # liest XLSX + 6 CSVs aus C:\Rezeptlogik → public/data/data.json
npm run dev            # http://127.0.0.1:5173
```

Datenquelle wird über `VITE_DATA_SOURCE` gewählt (`local` = JSON-Datei,
`firestore` = Firestore-Collections). Default ohne `.env.local` ist `local`.

---

## 2. Firebase-Projekt anlegen (4. Projekt im bestehenden Konto)

1. https://console.firebase.google.com → **Projekt hinzufügen** (z. B. `rezeptlogik-verden`).
2. Im selben Projekt: **Build → Firestore Database → Datenbank erstellen** (Region z. B. `eur3`).
3. **Build → Hosting → Loslegen**.
4. **Projekteinstellungen → Web-App** registrieren → Config-Werte kopieren.

CLI lokal:

```powershell
npm install -g firebase-tools     # falls noch nicht da
firebase login
firebase use --add                # Projekt auswählen, alias "default"
```

`.env.local` aus `.env.example` kopieren und Firebase-Werte eintragen.

---

## 3. Google Sheets live anbinden

1. **Google Cloud Console** (`console.cloud.google.com`) → gleiches Projekt wählen
   (oder ein eigenes für Service Accounts).
2. **APIs & Dienste → Bibliothek**: *Google Sheets API* aktivieren.
3. **IAM → Dienstkonten → Erstellen** (z. B. `sheet-reader`), Rolle `Viewer` reicht.
4. Beim Konto: **Schlüssel hinzufügen → JSON** → herunterladen nach
   `C:\rezeptlogik-app\secrets\service-account.json` (Ordner ist in `.gitignore`).
5. Im Google Sheet (`F_EU - 2026 Ramp Up Planning V2.0`) den Service-Account
   per **Teilen → Lesen** freigeben (E-Mail steht im JSON: `client_email`).
6. Sheet-ID aus URL kopieren (`/d/<ID>/edit`) und in `.env.local` als `GSHEET_ID` setzen.

Live-Import laufen lassen:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\rezeptlogik-app\secrets\service-account.json"
$env:GSHEET_ID="<ID>"
npm run import:gsheet
```

→ holt **Meal Selection** live aus dem Sheet, kombiniert mit lokalen Recipe/Cook-CSVs.

---

## 4. Firestore befüllen (optional, statt JSON)

```powershell
npm run push:firestore     # nutzt firebase-admin + dieselben service-account-Credentials
```

In `.env.local`: `VITE_DATA_SOURCE=firestore` setzen — die App liest dann live
aus Firestore (Read = öffentlich, Write nur per Admin-SDK, siehe
[firestore.rules](firestore.rules)).

---

## 5. Deployen

```powershell
npm run build
firebase deploy --only hosting,firestore:rules
```

Die App ist danach unter `https://<projekt>.web.app/` erreichbar.

---

## Datenfluss (Kurzfassung)

```
GSheet "Meal Selection"  ─┐
                          ├─►  scripts/import-*.ts  ─► public/data/data.json
6× CSV-Exporte (Recipes,  ┘                              │  oder
   Gross-Ingredients,                                    └─► Firestore (push:firestore)
   Cook Schedules)
```

```
Frontend  ─►  src/dataSource.ts  ─►  fetch JSON  oder  Firestore Reads
          ─►  KW-Auswahl  ─►  Rezeptliste  ─►  Detail (5 Tabs)
                                                ├─ Übersicht
                                                ├─ Sub-Rezepte (mit VF-Schedule-Match)
                                                ├─ Brutto-Zutaten (× total Verden)
                                                ├─ Plating
                                                └─ Cook-Schedule-Timeline
```

---

## Datenquellen-Quirks (wichtig)

- **Spalte „Verden Abs NORD"** in Meal Selection = **DK/SE-Volumen** in der App.
- **Total Verden Volume** = Summe aller drei Märkte; in einem Schwung gekocht
  → Brutto-Zutaten werden mit dieser Summe multipliziert.
- **Cook Schedules** werden auf `Site == "VF"` gefiltert.
- XLSX-Zellen sind **Formel-Objekte** (`{result, formula}`) — der Importer
  extrahiert konsequent `.result` (siehe `cellVal()` in
  [scripts/import-local.ts](scripts/import-local.ts)).
