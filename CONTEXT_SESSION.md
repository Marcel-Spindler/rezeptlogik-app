# rezeptlogik-app — Kontext für neuen Chat (Stand 2026-08-27)

Kurzfassung zum Reinkommen. Vollbild: [ARCHITECTURE.md](ARCHITECTURE.md).
Datenquellen-Troubleshooting: [DATENQUELLEN.md](DATENQUELLEN.md). Setup: [README.md](README.md).

---

## Was ist die App

**Factor OPS Planner** — internes Planungstool für HelloFresh Verden (Site **VF**),
Märkte **BENL** / **DK-SE** / **DE**. Alleinentwickler + Hauptnutzer: Marcel.
Chat-Antworten auf **Deutsch**.

React 18 + TypeScript + Vite 5 + Tailwind 3. Firebase Firestore (`europe-west3`) +
~25 Cloud Functions. Deploy auf Firebase Hosting (Site `rezeptlogik-verden-factor`,
Projekt `hellofresh-de-problem-solve` — **geteilt mit Factory Hub**).

**Nomenklatur:** `FV####` = Verden produziert selbst · `FE####` = zugeliefert.
**KW-Konvention:** HF-KW = echte ISO-KW **+ 1** (`src/lib/hfWeek.ts`, überall load-bearing).

---

## Architektur (Ist-Stand nach Refactor)

Frühere Versionen dieses Dokuments beschrieben eine `App.tsx` mit „3 Tabs" und
`types.ts`/`helpers.ts` im Root — **das ist überholt**. Aktuell:

```text
src/
  main.tsx              ?share= → ShareDashboard, sonst <App/>
  app/                  App, Router (View-Dispatch), Shell, AppContext, useAppData,
                        useRecipeSelection, NavTabs, KitchenSurface, ShopfloorKioskSurface
  core/                 types.ts (DataBundle & alle Typen), dataSource.ts, firebase.ts
  lib/                  reine Logik: hfWeek, runPlanning, planner, equipment,
                        planningOasisData, rack/rackV2, planExport, wmsCache, helpers, …
  components/           WeekSelector, RecipeList, DataHealthBanner, CapacityWarningBanner
  planning-oasis/       PlanningOasisView (Container)
  features/<feature>/   ~30 Feature-Ordner: View + *Logic.ts + Hooks
  <Root>.tsx            große Alt-Views, weiter genutzt: PlanningView, KetBreakdownView,
                        WhatIfView, WmsKwOverviewView, RackV2View, LinePlanningView,
                        BreakdownEquipmentView, RundmailView, PetPlanView, CsvImportView
scripts/                Import-/Sync-/Server-Scripts
functions/index.js      Cloud Functions (3876 Z., node_modules eingecheckt)
public/data/            data.json-Fallback, meal-catalog.json, GSheet-Dumps, Seeds
```

**Provider-Stack** (`app/App.tsx`): `RedzoneProvider` → `AppProvider` →
`WoReconciliationProvider` → `BackfillsProvider` → `Router`.

**Surfaces** (`?surface=`): `full` (Default) · `kitchen` (nur Breakdown-Rechner) ·
`rundmail` · `redzone` (nur DEV) · `shopfloor` (`&dept=veggie|protein`, Debox-Kiosk).
Dazu `?share=<week>` → read-only ShareDashboard.

---

## Views (Nav-Gruppen, `AppView` = 16 Werte)

| Nav | Datei | Kurz |
|---|---|---|
| Rezept | `features/recipe-detail/RecipeDetailShell` | 7 Tabs: Übersicht, Sub-Rezepte, Struktur, Workflow&Equipment, Brutto-Zutaten, Plating, Cook-Schedule |
| Meal Katalog | `features/meal-catalog/MealCatalogView` | Verden Meal Database: Suche/Filter, Bilder, XLSX |
| Planning OASE | `planning-oasis/PlanningOasisView` | 3 Sections: Cockpit (`PlanningView`, Drag&Drop-Wochenboard), Linienplanung (`VorstellungsplanView`, GSheet-Spiegel + Firestore-Overlay), Rack (`RackV2View`) |
| KET Plan / WO | `KetBreakdownView` + `features/ket-plan/*` | WO-Breakdown: Batch/Equipment, Factor-Regeln, Allergen→Chiller, KI-Anweisungen, Frischeliste V1+V2 (V2 WIP), PDF/Excel. Volle Breite. |
| PET Plan / Plating | `PetPlanView` + `features/pet-plan/*` | KitchenOS-PET-CSV → Linienzuweisung, Staffing, PDF |
| WMS Übersicht | `WmsKwOverviewView` + `features/wms-overview/*` | Snowflake-Live/Cache: Stationen Inbound→…→Plating, Funnel, Kettenbruch, Alerts |
| What-If Rechner | `WhatIfView` + `features/whatif/*` | Yield-aware Rohware↔Portionen, Per-Zutat-Overrides |
| Rundmail | `RundmailView` + `features/rundmail/*` | Küchen-Rundmail als Slack/HTML/PDF |
| CSV Import | `CsvImportView` | CSV → Firestore-Push aus der App |
| Artikel / KW | `features/artikel-woche/ArtikelWocheView` | Wochenbedarf aller Zutaten in kg, Braiser-Split, Tagessplit |
| Bots | `features/blast-chiller/`, `features/allergen-plating/` | Allergen→Chiller-Zuteilung, Allergen-Matrix |
| Monitoring | `features/gsheet-monitor/PostblastLiveView`, `features/backfills/BackfillsView`, `.../TransparencyPlanView` | Live-GSheet-Polling; Backfills = Postblast+Preblast+RTI+LinePlaiting+Redzone+WMS → Nachproduktions-Bedarf |
| Redzone Live | `features/redzone-live/RedzoneLiveView` | **nur DEV** (Snowflake-SSO); Provider trotzdem app-weit |

---

## Datenfluss

```text
Google Sheets ─┬─ Service-Account-Scripts ──► public/data/data.json ──► push:firestore ──► Firestore
               └─ Browser (gviz CSV: Pre/Post-Blast, RTI, ET, LinePlaiting)
Snowflake (WMS) ─┬─ Cloud Functions (JWT) ──► wmsCache/* (60-Min-Cron)
                 └─ lokaler Server :3141 (Browser-SSO) ──► /api/wms-* Proxy

Frontend: core/dataSource.loadData()
  VITE_DATA_SOURCE = firestore (Default) | local | local-db
  Fallback: firestore → data.json ; dann meal-catalog.json drübergelegt
  Live-Refresh: onSnapshot(rampUpHash) + 60s-Poll + rezeptlogik:*-saved Window-Events
```

`DataBundle` (`core/types.ts`): `weeks, weekRecipes, recipes, mealCatalog,
cookSchedules, processSpecs, shelfLifeBySku, structures, instructions,
productionPlan, printOrders, kitchenPriority, kitchenPlanning, produktionsplanung,
maitreRampup, equipmentBible, planningCalendar, weeklyYield, weightGoals`.

Firestore alles unter `apps/rezeptlogik/*` — **`allow read, write: if true`**
(kein Auth-Layer), deshalb direkte Client-Writes (rackV2PlanHistory,
woReconciliationLog, shopfloorProgress, woInstructions, platingPlan,
productionPlanOverrides, …).

---

## Lokale Dev-Server (`npm run dev` startet automatisch)

- **:3141** `scripts/wms-local-server.ts` — Snowflake über Browser-SSO
- **:3142** `scripts/local-db-server.mjs` — SQLite + Gemini-Proxy (`/api/local-db/*`)
- Vite-Middleware: `/api/import-local`, `/api/deploy`, `/api/meal-*`, `/api/start-wms-server`

---

## Wichtige npm-Scripts

```bash
npm run dev                 # Vite + CSV-Watcher (Ports 3141/3142 auto)
npm run typecheck           # tsc -b
npm run test                # vitest run
npm run sync:all            # import:gsheet + import:local + import:rampup + import:weekly-planning + push:firestore
npm run wms:sync-cache      # persönlicher SSO-Pull → wmsCache/*
npm run discover:sheets     # Tab-Namen + GIDs aller Sheets
npm run deploy              # build + firebase deploy --only hosting
npm run deploy:all          # + functions
```

---

## Fallstricke / Konventionen

- **`git status` zuerst** — Auto-Commit-Anomalie: ein unklarer Mechanismus
  committet/pusht manchmal von selbst.
- **KW = ISO + 1.** Live-Küchendaten folgen `currentHfWeek()`, nicht der Planner-KW
  (die GSheet-Pipeline kann hinterherhängen).
- **Refactor-Technik:** aus großen Views nur reine Logik nach `*Logic.ts`, State/Hooks bleiben.
- **Code-Matching** immer über Ziffern-Fallback (`resolveRecipeByCode` etc.).
- **Firestore-Rules nicht beiläufig deployen** — geteiltes Projekt. npm-`deploy` ist
  sicher (`--only hosting`); blankes `firebase deploy` würde jetzt auch Rules pushen.
- **PDF:** `window.open+print()` bricht beim Speichern — Fix-Muster in `ketPdf.ts` u.a.
- `secrets/service-account.json` niemals committen.

---

## Aktueller Fokus

- **Priorität: KI auf den verknüpften Live-Daten** (RAG-artig, kein Fine-Tuning),
  statt weiterer Standalone-Features.
- **WIP im Working Tree:** Frischeliste 2.0 (`features/ket-plan/frischeV2Logic.ts`,
  `FrischelisteV2Panel.tsx`, + Router/Shell/KetBreakdownView angepasst — uncommitted).
- **Offener Wunsch:** globale WO-Suche (chronologischer Verlauf + Submeals), NICHT
  in „KET Plan / WO".
- **`.cortex/plans/`** enthält die jüngsten Implementierungs-Pläne (KET Equipment-Panel,
  Backfills-KW-Fallback, WMS-PLH-Durchfluss, ketPdf-Layout, Instruction-Firestore-Cache).
