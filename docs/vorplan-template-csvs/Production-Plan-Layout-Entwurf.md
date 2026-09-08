# Production Plan Layout Entwurf

Ziel: Ein Sheet, das wie dein aktueller Production Plan schnell scanbar bleibt, aber KET, PET und Frische-Einkauf planbar macht. Nicht mehr: CSV-Endprodukt manuell pflegen. Sondern: wenige Planwerte ändern, darunter entstehen Kalender, Küchen-WOs und Einkauf.

## Gesamtbild

```text
┌──────────────────────────────────────────────┬──────────────────────────────────────────────────────────────┐
│ A:H  RECIPE MIX                              │ J:R  PLATING CALENDAR                                        │
│ Code | Pref | Recipe | BENL | NORD | DE ...  │ Rezeptzeilen x So Mo Di Mi Do Fr Sa                          │
│ farbige Rezeptzeilen wie heute               │ farbige Planmengen + Status/Warnings                         │
├──────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┤
│ A:H  RUN + BUFFER CONTROL                    │ J:R  PLATING CAPACITY                                        │
│ Week, Run1 %, Buffer %, Earliest Fresh Day    │ unique meals, meals, hours, lines, diff                       │
├──────────────────────────────────────────────┴──────────────────────────────────────────────────────────────┤
│ A:R  KITCHEN START PREVIEW                                                                                   │
│ Sonntag Veggie: WO -> WO -> WO                                                                               │
│ Sonntag Proteine: WO -> WO -> WO                                                                             │
│ Montag Veggie: WO -> WO -> WO                                                                                │
│ Montag Proteine: WO -> WO -> WO                                                                              │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ A:R  FRISCHE EINKAUF                                                                                         │
│ Produktionstag | bis wann | SKU | Artikel | kg | WOs | Rezept(e) | Bereich                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Sheet 1: `Production Plan`

Das bleibt das Hauptsheet, ähnlich deinem Screenshot.

### Block A1:H4 - Control Bar

| Zelle | Inhalt | Format |
| --- | --- | --- |
| A1 | `Week` | fett, groß |
| B1 | `2026-W38` | gelb, editierbar |
| D1 | `First Run %` | klein |
| E1 | `70%` | gelb, editierbar |
| G1 | `Buffer %` | klein |
| H1 | `5%` | gelb, editierbar |
| J1 | `Earliest Fresh` | klein |
| K1 | `Saturday` | gelb, editierbar |

Regel: Gelb = manuelle Planannahme. Türkis = berechnetes Ergebnis. Grün/Rot = Kapazitätsfeedback.

### Block A5:H30 - Recipe Mix

Spalten:

| Spalte | Name | Zweck |
| --- | --- | --- |
| A | Code | `FV1351A` |
| B | Preference | CS/Keto/Perf/Veggie |
| C | Recipe Name | Anzeigename |
| D | BENL | Marktmenge |
| E | NORD | Marktmenge |
| F | DE | Marktmenge |
| G | Total | `=SUM(D:F)` |
| H | Total+Buffer | `=ROUND(G*(1+$H$1),0)` |

Optik:

- Header schwarz mit weißer Schrift.
- Recipe Name farbig nach Produktgruppe oder Allergenhinweis.
- `Total+Buffer` gelb wie im Screenshot, weil diese Zahl die Planbasis ist.

### Block J5:R30 - Plating Calendar

Spalten:

| Spalte | Name |
| --- | --- |
| J | Code |
| K | Sunday |
| L | Monday |
| M | Tuesday |
| N | Wednesday |
| O | Thursday |
| P | Friday |
| Q | Saturday |
| R | Check |

Regeln:

- Eingabezellen für Meal-Verteilung bleiben weiß.
- Automatisch gesetzte Vorschläge sind helltürkis.
- Engpasszellen werden rot, wenn Tageskapazität überschritten ist.
- `R Check`: `=SUM(K:Q)-H` je Rezept. Null ist grün, Abweichung rot.

### Block J32:R39 - Plating Capacity

Zeilen:

| Zeile | Kennzahl |
| --- | --- |
| 32 | unique meals |
| 33 | total meals |
| 34 | people |
| 35 | lines |
| 36 | per h/line |
| 37 | available time |
| 38 | needed time |
| 39 | diff |

Optik:

- `unique meals`, `total meals`, `per h/line` türkis.
- `diff` grün bei positiv, rot bei negativ.
- Diese Zeilen bleiben direkt unter dem Kalender, weil sie beim Schieben von Mengen sofort sichtbar sein müssen.

## Sheet 2: `Kitchen Plan`

Dieser Tab ist die KET-Brücke. Eine Zeile pro Subrecipe-WO, automatisch aus `Recipe Mix` und Rezeptdaten.

Spalten:

| Name | Zweck |
| --- | --- |
| Kitchen Day | berechneter Starttag aus Cook Schedule |
| Shift | 1/2 |
| WO Preview | z. B. `38-108` |
| Recipe Code | Bezug zum Hauptsheet |
| Recipe Name | lesbar |
| Subrecipe / Direct Item | KET-Submeal oder direkte Ingredient-Zeile |
| Cook Methods | aus Rezept / PFEI |
| Department | Veggie / Proteine |
| Target Portions | aus Plating-Verteilung |
| Planned kg | aus Rezeptmenge |
| Earliest Fresh | `MAX(calculatedNeedDate, Saturday)` |
| Status | Open/Staged/Post Blast |

Wichtig: Direkte Artikel ohne Submeal-Link bleiben eigene Planzeilen, statt als Fehlerblock zu enden. Beispiele: Cheddar, Parmesan, Mozzarella, Penne IQF, Fondue, Zucchini.

## Sheet 3: `Fresh Einkauf`

Das ist der Einkaufsblock, der später in die Rundmail kann.

Spalten:

| Name | Beispiel |
| --- | --- |
| Produktionstag | Sonntag 06.09. |
| Bereit bis | Samstag 05.09. |
| SKU | PHF-12345 |
| Artikel | Zucchini diced |
| kg | 184.5 |
| WOs | `38-3, 38-4, 38-108` |
| Rezepte | `FV1169A, FV0780A` |
| Bereich | Veggie / Proteine |

Regeln:

- Alles in kg ausgeben. Gramm immer `/1000`.
- Einkauf nur Sonntag und Montag als Standardansicht.
- `Bereit bis` darf nie vor Samstag liegen.
- Nach `Produktionstag`, dann `Bereit bis`, dann `kg desc` sortieren.

Optik:

- Pro Tag ein dunkler Header.
- kg rechtsbündig und fett.
- WOs klein, aber in einer Zeile hintereinander.
- Keine langen Erklärtexte in diesem Block.

## Sheet 4: `Export Check`

Dieser Tab zeigt, ob aus dem Plan wieder KET/PET entstehen können.

### KET Export Preview

Pflichtspalten:

`Date Needed, Work Order Number, Recipe ID, Recipe Name, Sub Recipe Name, Production Minimum Needs Amount, Cook Methods, Target Portions`

### PET Export Preview

Pflichtspalten:

`Type, Production Shift, Recipe WO #, Recipe Name, Recipe WO Target, Recipe Plating Status, Production Min Needs`

## Direkt einbaubarer Block im bestehenden Production Plan

Wenn du nicht sofort mehrere Tabs bauen willst, starte mit diesem Block unter dem Plating-Kalender:

```text
KITCHEN START
Sunday 06.09.   Veggie    38-3 Zucchini -> 38-4 Red Peppers -> 38-2 Fondue
Sunday 06.09.   Proteine  38-5 Shredded Chicken -> 38-108 Cheddar
Monday 07.09.   Veggie    ...
Monday 07.09.   Proteine  ...

FRISCHE EINKAUF
Production Day  Needed By  kg      SKU        Item                                WOs
Sunday 06.09.   Saturday   184.5   PHF-...    Zucchini diced                      38-3, 38-4
Sunday 06.09.   Saturday    42.0   DAI-...    White Cheddar shredded              38-108
Monday 07.09.   Saturday   210.2   PHF-...    Red Peppers diced                   38-4, 38-157
```

Das ist der beste erste Einbau, weil er deinen bestehenden Screenshot nicht umbaut, aber sofort die beiden wichtigsten Fragen beantwortet:

1. Welche WOs starten Sonntag/Montag in welcher Reihenfolge?
2. Welche Frischeware muss dafür spätestens wann und in kg da sein?

## Farb- und Formatvorschlag

| Zweck | Farbe |
| --- | --- |
| Manuelle Eingabe | `#fff200` gelb |
| Berechnete Tagesmengen | `#17d9d4` türkis |
| Plating Header | `#000000` schwarz |
| Kitchen Start Header | `#1e3a5f` dunkelblau |
| Fresh Einkauf Header | `#166534` grün |
| Warnung / negative diff | `#f4cccc` hellrot |
| OK / positive diff | `#b7e1cd` hellgrün |

## Umsetzungsschritte

1. Bestehenden Recipe-Mix links unverändert lassen.
2. Rechts den Plating Calendar wie bisher behalten, aber `Check` je Rezept ergänzen.
3. Unter den Kapazitätszeilen `Kitchen Start` als 4-Zeilen-Block einfügen.
4. Darunter `Fresh Einkauf` als kompakte Tabelle einfügen.
5. Erst danach separate Tabs für `Kitchen Plan`, `Fresh Einkauf` und `Export Check` auslagern.