# Session-Handoff: WmsLiveView Neuaufbau

## Status quo (Stand: 13.05.2026)

### Was passiert ist
Die alte `WmsLiveView.tsx` (2180 Zeilen) war komplett verbuggt durch mehrfaches Hin-und-Her bei der KW-Berechnung (ISO+1 rein, raus, wieder rein). Resultat: falsche KW-Anzeige oder leere Tabellen. Entscheidung: **Alles löschen, neu bauen.**

### Aktueller Dateizustand

**`src/WmsLiveView.tsx`** — 19-Zeilen-Stub, deployed:
```tsx
import type { DataBundle } from "./types";

type Props = {
  data: DataBundle;
  week: string;
};

export function WmsLiveView({ week }: Props): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <div className="text-5xl">🚧</div>
      <h2 className="text-2xl font-black text-slate-800">WMS Live — Neuaufbau</h2>
      <p className="max-w-md text-slate-500">
        Diese Ansicht wird gerade neu gebaut. <br />
        Aktive Woche: <span className="font-bold text-slate-700">{week}</span>
      </p>
    </div>
  );
}
```

**`scripts/wms-local-server.ts`** — UNVERÄNDERT, NICHT ANFASSEN. Enthält:
- Snowflake-Zugangsdaten (Fallback-Hardcode + dotenv aus `functions/.env` + `.env.local`)
- Lokaler HTTP-Server Port **3141**, Start: `npm run wms:server`
- KW-Logik: `currentHfWeek()` = ISO-KW + 1 → heute (KW20 ISO) = **2026-W21**
- Endpoints: `GET /wms-live?week=`, `GET /redzone?week=`, `GET /submeals?week=`, `GET /health`

**`src/PlanningOasisView.tsx`** — NICHT ANFASSEN. Importiert WmsLiveView:
- Line 5: `import { WmsLiveView } from "./WmsLiveView";`
- Line ~397: `<WmsLiveView data={data} week={week} />`

---

## Infrastruktur

| Was | Wert |
|---|---|
| App | React 18 + TypeScript + Vite |
| Hosting | Firebase Hosting, Site `rezeptlogik-verden-factor` |
| Projekt | `hellofresh-de-problem-solve` |
| URL | https://rezeptlogik-verden-factor.web.app |
| Build | `npm run build` |
| Deploy | `firebase deploy --only hosting` |

### Snowflake (für WMS-Abfragen)
| Was | Wert |
|---|---|
| Account | `XG02811-OO69432` |
| User | `MARCEL.SPINDLER@HELLOFRESH.DE` |
| Role | `US_OPS_ANALYTICS_USER` |
| Warehouse | `US_OPS_ANALYTICS` |
| Database | `US_OPS_ANALYTICS` |
| Schema | `HIGHJUMP` |
| WH_ID | `VF` |
| Auth | `externalbrowser` (SSO / Okta) |

---

## SQL-Logik im lokalen Server (Stationen-Mapping)

Der SQL-Query in `wms-local-server.ts` mappt `LOCATION_ID` auf Stationen:

| sort key | Station-Label | LOCATION_IDs |
|---|---|---|
| `1_DEBOX` | Debox | `DEBOXWIP` |
| `2_PREPZONE` | Veggie & Protein | `VEGGIE`, `PROTEIN`, `BULKLIQUID`, `BRAISER` |
| `3_PREBLAST` | Pre-Blast | `PREB%`, `PreB%` |
| `4_REDZONE` | Redzone / Plating Scan | `%REDZONE%`, `REDZ%`, `RZ-%`, `RZ%` |
| `4_PLATING` | Plating / PLH | `PLATING%`, `PLH%`, `%PLAT%`, `%PLAIT%` |
| `5_POSTBLAST` | Post-Blast | `PostB%`, `POSTB%` |
| `6_SLEEVING` | Sleeving | `SLEEVING`, `%SLEEV%` |
| `7_ASSEMBLY` | Assembly / Kitchen | `ASSEMBLYWIP`, `KITCHENWIP`, `PRODUCTION` |
| `8_LINE` | Linie / Output | `VF-LINE%`, `SPI%`, `SPI-WINDOW` |
| `9_STAGING` | Staging | `STGDR%`, `PHSTG%`, `VHSTG%`, `SPISTG%` |
| `Z_BLOCKED` | Gesperrt / Verlust | `LOST`, `SPERRLAGER%`, `PROD RTN`, `ADJ LOC` |
| `0_OTHER` | Sonstiges | alles andere |

---

## Warum die alte View kaputt war

1. **KW-Mismatch**: Factor-KW = ISO-KW + 1. Der Bug: mal wurde +1 gemacht, mal nicht. Tabellen zeigten dadurch entweder die falsche KW oder waren komplett leer.
2. **lsLoad()-Bug**: Ein zwischenzeitlicher Fix hat den localStorage-Cache nach KW geprüft und bei Mismatch geleert → alle Tabellen nach Refresh leer.
3. **KW20-Restbestände**: Items wie `FV0472A`, `FV0846A` mit KW20-Label im WMS sind echte Restbestände aus der Vorwoche → „NICHT ZUGEORDNET" ist korrekt, kein Bug.

---

## Nächste Schritte

`WmsLiveView.tsx` neu bauen. Der lokale Server (`/wms-live?week=2026-W21`) liefert bereits sauber:
- Liste aller WMS-Items mit Station, SKU, Menge, Gewicht, Lot/MHD
- Gruppiert nach Station (sort key für Reihenfolge vorhanden)

Die neue View soll (noch zu klären mit User):
- [ ] Tabelle je Station oder eine Gesamttabelle?
- [ ] Filter nach Station, SKU, Status?
- [ ] Demand-Abgleich (Plan-Menge vs. WMS-Bestand)?
- [ ] Redzone-Tab separat?

---

## Wichtige Regel: Firebase Deploy

`firebase deploy --only hosting` ist sicher (nur Hosting, keine Rules).  
**NIEMALS** `firebase deploy --only firestore:rules` aus diesem Repo → würde alle anderen Apps im shared Projekt überschreiben.
