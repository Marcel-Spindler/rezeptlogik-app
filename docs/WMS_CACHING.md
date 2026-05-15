# WMS Caching - Lokal SSO + Cloud Fallback

## Problem
- **Lokal:** Snowflake mit SSO (HelloFresh) funktioniert perfekt
- **Cloud Functions:** Headless → SSO möglich, kein Service Account
- **Lösung:** Lokal abfragen, Daten cachen, Cloud Functions geben Cache zurück

---

## Workflow

### 1️⃣ **Lokal: WMS-Daten abfragen & speichern**

```bash
# Voraussetzung: .env muss SNOWFLAKE_ACCOUNT haben
npx ts-node scripts/sync-wms-cache.ts

# Mit Woche angeben:
npx ts-node scripts/sync-wms-cache.ts --week 2026-W21

# Mit Lookback-Tage:
npx ts-node scripts/sync-wms-cache.ts --days 28
```

**Was passiert:**
- ✅ Öffnet Browser für SSO-Login
- ✅ Queries Snowflake (wms-plating, wms-sleeving, wms-inbound, **wms-workorders**, etc.)
- ✅ Speichert JSON in `public/data/wms-cache.json`
- ✅ Committe diese Datei ins Repo oder pushe zu Firestore

**Output:**
```json
{
  "timestamp": "2026-05-15T10:30:45.123Z",
  "week": "2026-W21",
  "range": { "start": "2026-05-19", "end": "2026-05-26" },
  "whId": "VF",
  "datasets": {
    "plating": [ ... ],
    "sleeving": [ ... ],
    "inbound": [ ... ],
    "workorders": [
      {
        "woNumber": "WO-12345",
        "week": "2026-W21",
        "submealItemNumber": "SUB-001",
        "submealItemDescription": "Pasta Sauce Base",
        "mealItemNumber": "MEAL-001",
        "mealItemDescription": "Carbonara",
        "quantity": 50,
        "uom": "KG",
        "plates": 500,
        "targetPerPlate": 0.1,
        "preBlastQuantity": 25,
        "preBlastLocation": "FREEZER-A1",
        "status": "READY",
        "expirationDate": "2026-05-23T00:00:00.000Z",
        "productionTime": "2026-05-15T08:00:00.000Z",
        "lastUpdated": "2026-05-15T10:30:00.000Z"
      }
    ]
  }
}
```

---

### 2️⃣ **Cloud Functions: Cache nutzen**

Nach `firebase deploy --only functions`:

```
GET /api/wms-plating?whId=VF&week=2026-W21
GET /api/wms-sleeving?whId=VF&week=2026-W21
GET /api/wms-inbound?whId=VF&week=2026-W21
GET /api/wms-staging?whId=VF&week=2026-W21
GET /api/wms-debox?whId=VF&week=2026-W21
GET /api/wms-postblast?whId=VF&week=2026-W21
GET /api/wms-plating-history?whId=VF&week=2026-W21&lookbackDays=28

GET /api/wms-workorders?whId=VF&limit=10000
```

**Response:**
```json
{
  "ok": true,
  "cached": true,
  "source": "firestore|public-data",
  "rows": [ ... ]
}
```

**Fallback-Logik:**
1. Versucht Daten aus Firestore (`wmsCache` Collection) zu laden
2. Falls nicht vorhanden: Versucht `public/data/wms-cache.json`
3. Falls auch das fehlschlägt: Versucht live Snowflake Query (wenn Credentials vorhanden)
4. Sonst: 500 Error mit Hinweis auf Script

---

## Deployment

### Ohne Service Account (empfohlen)

```bash
# 1. Lokal Daten abfragen
npx ts-node scripts/sync-wms-cache.ts

# 2. Daten in public/data/wms-cache.json wird mit deployed
# 3. Nur noch .env brauchst du für Agent-APIs (nicht Snowflake)
firebase deploy

# 4. Cloud Fns verwenden gecachte Daten
```

### Optional: In Firestore pushen (für Redundanz)

```bash
# Daten aus public/data/wms-cache.json in Firestore speichern
# (Script: scripts/upload-wms-cache-to-firestore.ts - optional)
```

---

## Setup

### .env (Root-Verzeichnis)

```env
# Nur Snowflake-Account nötig (User/Password leer für SSO)
SNOWFLAKE_ACCOUNT=XG02811-OO69432
SNOWFLAKE_AUTHENTICATOR=externalbrowser
SNOWFLAKE_WAREHOUSE=US_OPS_ANALYTICS
SNOWFLAKE_DATABASE=US_OPS_ANALYTICS
SNOWFLAKE_SCHEMA=HIGHJUMP
SNOWFLAKE_ROLE=US_OPS_ANALYTICS_USER
SNOWFLAKE_WH_ID=VF
```

### functions/.env

```env
# Snowflake Credentials NICHT nötig!
# (Nur Agent APIs)

GSHEET_ID=your-sheet-id
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=...
GEMINI_API_KEY=...
```

---

## Regelmäßig Sync (Optional)

### GitHub Actions (wöchentlich)

```yaml
# .github/workflows/sync-wms-cache.yml
name: Sync WMS Cache Weekly
on:
  schedule:
    - cron: '0 6 * * 1'  # Montags 6 Uhr

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: npm ci --prefix functions
      - run: npx ts-node scripts/sync-wms-cache.ts
      - run: |
          git config user.email "automation@example.com"
          git config user.name "WMS Cache Bot"
          git add public/data/wms-cache.json
          git commit -m "Update WMS cache"
          git push
```

---

## Troubleshooting

| Problem | Lösung |
|---------|--------|
| `SNOWFLAKE_ACCOUNT erforderlich` | Setze Env-Var im Root-`.env` |
| Browser öffnet sich nicht | Script braucht Desktop-SSO. Lokal ausführen (nicht SSH) |
| `403 Access Denied` | SSO-Fehler → Überprüfe HelloFresh Credentials |
| Cloud Functions geben 500 | Cache ist leer. Lokal: `npx ts-node scripts/sync-wms-cache.ts` ausführen |
| Daten sind veraltet | `npx ts-node scripts/sync-wms-cache.ts` regelmäßig laufen lassen |

---

## Performance

| Szenario | Ladezeit |
|----------|----------|
| Cloud Functions (gecacht) | ~50-100ms |
| Lokal Snowflake live Query | ~1-3 Sekunden |
| Lokal cache read | ~10-20ms |

**Vorteil:** Cloud Functions sind schnell, kein Snowflake-Overhead!

