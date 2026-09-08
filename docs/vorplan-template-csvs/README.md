# Vorplan-GSheet Template aus KET/PET-Ergebnis-CSV

Dieser Ordner enthält die zwei Ergebnisdateien, aus denen das neue Plan-Template rückwärts gedacht wird:

- `KET-Verden-2026-W37.csv` - 205 Subrecipe-/Küchen-WOs
- `PET-Verden-2026-W37.csv` - 34 Recipe-/Plating-WOs

## Ziel

Das GSheet soll nicht das Endprodukt manuell nachbauen. Es soll eine Planfläche sein, aus der KET- und PET-Exports logisch entstehen können.

Der Screenshot zeigt dafür das richtige Grundprinzip: links Rezept-/Mengensteuerung, rechts Tagesverteilung, unten Kapazitätscheck. Für KET/PET brauchen wir zusätzlich die Subrecipe-Ebene und die Frische-/Küchenableitung.

## Empfohlene Tabs

### 00_Control

Globale Stellschrauben:

| Feld | Beispiel | Zweck |
| --- | ---: | --- |
| HF Week | 2026-W38 | Zielwoche |
| First Run Assumption | 70% | Run-1-Aufteilung |
| Buffer Assumption | 5% | Puffer auf Meal-Mengen |
| Earliest Fresh Delivery | Saturday | Ware nie früher als Samstag planen |
| Site | VF | Verden-Logik/Cook-Schedules |

### 01_Recipe_Mix

Entspricht dem linken Block im Screenshot. Eine Zeile pro Rezept.

Spalten:

`Code, Preference, Recipe Name, BENL, NORD, DE, Total, Total+Buffer, Run1 %, Run1 Meals, Notes`

Diese Tabelle ist die zentrale Plan-Eingabe. `Run1 Meals` speist später KET und PET.

### 02_Plating_Calendar

Entspricht dem rechten PLATING-Block im Screenshot.

Spalten:

`Code, Recipe Name, Sunday, Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Total Planned, Lines, People, Bottleneck, Comment`

Zweck:

- verteilt Recipe-WOs auf Plating-Tage
- erzeugt später PET-Rezept-WOs wie `37-R14`
- zeigt Tageslast, Linien, People/h und Differenz gegen verfügbare Zeit

### 03_Kitchen_Subrecipe_Plan

Die fehlende clevere Ebene zwischen Meal-Plan und KET-Export.

Spalten:

`Kitchen Day, Shift, Recipe Code, Recipe Name, Subrecipe Name, Cook Methods, Target Portions, Planned kg, Department, Earliest Delivery, WO Preview, Status`

Zweck:

- erzeugt die KET-WOs
- sortiert Küche nach Veggie/Proteine
- berechnet frühesten Start aus Cook Schedule
- setzt `Earliest Delivery` nie früher als Samstag

### 04_Fresh_Purchasing

Der Einkauf bekommt keine WO-Wüste, sondern eine Tagesliste.

Spalten:

`Production Day, Needed By, Ingredient SKU, Ingredient Name, UOM, Qty kg, WOs, Recipes, Department`

Regeln:

- Mengen immer in kg, auch wenn Rezeptdaten Gramm liefern
- nur Frische-/Rohwaren, die für Sonntag und Montag relevant sind
- direkte Zutaten ohne Submeal-Link werden mitgezogen, z. B. Käse, Pasta, Zucchini, Fondue
- keine WMS-Bestands-/Fehlmengenlogik in diesem Template

### 05_Export_Check

Endprodukt-Kontrolle gegen die beiden CSV-Formate.

KET-Spalten:

`Date Needed, Work Order Number, Recipe ID, Recipe Name, Sub Recipe Name, Production Minimum Needs Amount, Cook Methods, Target Portions`

PET-Spalten:

`Type, Production Shift, Recipe WO #, Recipe Name, Recipe WO Target, Recipe Plating Status, Production Min Needs`

## Layout-Idee wie im Screenshot

Oben links steht die Rezeptmatrix mit farbigen Recipe-Zeilen. Oben rechts steht der Plating-Kalender als Wochenraster. Darunter liegen Summenzeilen:

- unique meals
- total meals
- per hour
- lines
- available plating time
- needed plating time
- diff

Unter dem Kalender kommen zwei operative Blöcke:

- `Kitchen Start` mit Pfeilketten je Tag: Veggie und Proteine getrennt
- `Fresh Einkauf` als kompakte kg-Liste je Produktionstag

## Warum diese Struktur

KET und PET sind unterschiedliche Endprodukte:

- PET plant Recipe-WOs pro Plating-Tag.
- KET plant Subrecipe-WOs pro Küchen-/Vorproduktionstag.

Das Template muss deshalb auf Rezeptebene planen, aber Subrecipe- und Rohwarenebene automatisch ableiten. So wird der Plan steuerbar, ohne dass später 200 KET-Zeilen manuell gepflegt werden müssen.