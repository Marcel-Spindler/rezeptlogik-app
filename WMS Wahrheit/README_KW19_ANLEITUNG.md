# 📊 KW 19 ANALYSE - VOLLSTÄNDIGE ÜBERSICHT
## Inbound bis Fulfillment Produktverfolgung

---

## 📁 ALLE ERSTELLTEN DATEIEN

### **1. Excel Report (HAUPTDATEI) 📊**
**Datei:** `KW19_Analyse_Excel_Report.xlsx`
**Wie anschauen:** 
- Doppelklick → Öffnet in Excel/LibreOffice
- 4 Arbeitsblätter mit Graphiken und Tabellen

**Inhalte:**
- **Sheet 1: Übersicht** → Statistik KW 19 (Zugänge, Bewegungen, Netto)
- **Sheet 2: Produkte_Detailliert** → Alle 119 Produkte sortiert nach Gewicht
- **Sheet 3: Bereiche_Übersicht** → 189 Bereiche mit Kategorien (Prep, Fulfillment, Lager)
- **Sheet 4: Top_Produkte_Kategorien** → Top Produkte pro Bereichskategorie

---

### **2. CSV Export (DETAILLIERTE DATEN) 📋**
**Datei:** `KW19_Analyse_Detailliert.csv`
**Wie anschauen:**
- Mit Excel öffnen (Doppelklick)
- Oder mit Notepad/Editor anschauen
- Spalten mit `;` getrennt

**Inhalte:**
- Jede Zeile = 1 Produkt
- Spalten: Produkt | Gesamt_kg | Transaktionen | dann 189 Bereiche
- Zeigt wo das Produkt überall ist

---

### **3. CSV Export ERWEITERT (ZUGÄNGE vs BEWEGUNGEN) 📈**
**Datei:** `KW19_Analyse_Erweitert_Zugaenge_Bewegungen.csv`
**Wie anschauen:**
- Mit Excel öffnen
- Beste Detailansicht

**Inhalte:**
- Trennung von EINGÄNGEN und AUSGÄNGEN
- Pro Produkt und pro Bereich sichtbar
- Welche kg reinkommen + welche rausgehen = Netto

---

### **4. Jupyter Notebook (INTERAKTIV) 🔬**
**Datei:** `KW19_Analyse.ipynb`
**Wie anschauen:**
- Öffnen in VS Code
- Oder in https://jupyter.org/ hochladen
- Oder in ChatGPT/Claude hochladen zur Erklärung

---

---

## 📊 WICHTIGSTE ZAHLEN KW 19

```
Gesamte Analyse:        2.684 Transaktionen
Zeitraum:               Kalenderwoche 19 (7.-13. Mai 2026)

ZUGÄNGE (positiv):       1.180.637,05 kg
BEWEGUNGEN (negativ):    3.058.424,74 kg
NETTO-BESTAND:          -1.877.787,69 kg

Produkte gefunden:       119 verschiedene Artikel
Bereiche kartographiert: 189 verschiedene Orte
```

---

## 🏭 WO IST DAS MATERIAL?

### **TOP 5 VERBRAUCH (Prep/Plating - wird verarbeitet)**
```
1. Karotten, Münzschnitt 5 mm           -717.467 kg  (Roh → wird geschnitten)
2. Grüne Bohnen, frisch & geschnitten   -571.462 kg  (Roh → wird gekocht)
3. Brokkoli, Röschen                    -376.637 kg  (Roh → wird zubereitet)
4. Sahne 20%                            -237.622 kg  (Zutat → wird verwendet)
5. Zwiebel, grün, geschnitten            -205.803 kg  (Roh → wird gekocht)
```

### **TOP 5 FERTIG (Fulfillment - versandbereit)**
```
1. Thyme Roasted Mushrooms               +110.280 kg  (Fertig → Versand)
2. Swiss Cheese Sauce - More Salt         +50.216 kg  (Fertig → Versand)
3. Garlic Herb Butter                      +9.109 kg  (Fertig → Versand)
4. Roasted Green Onions                    +9.017 kg  (Fertig → Versand)
5. Salmon - garlic seasoning               +8.765 kg  (Fertig → Versand)
```

### **TOP 5 BESTAND (verfügbar/gelagert)**
```
1. FA-DE Freebies (TZ)                  +200.000 kg  (Bonus → Lager)
2. FA-NO Freebies (TV)                  +120.000 kg  (Bonus → Lager)
3. FA-NO Freebies (TK)                  +120.000 kg  (Bonus → Lager)
4. FA-NO Nordics Box Size XS             +45.200 kg  (Behälter → Lager)
5. Garlic Herb Butter                    +40.287 kg  (Komponente → Lager)
```

---

## 🗂️ BEREICHE-KATEGORISIERUNG

Die 189 Bereiche wurden in Kategorien eingeteilt:

### **PREP/PLATING (8 Bereiche)**
- DEBOXWIP (WIP = Work In Progress)
- PLATING-LINE-01, 02, 03
- PLATINGWIP
- PostB-01
- SLEEVING
- PREB-01

**Material hier:** Rohzutaten werden zu Meals verarbeitet
**Netto-Bestand:** -2.812.833 kg (Material KONSUMIERT)

### **FULFILLMENT (50 Bereiche)**
- PLH-01-02 bis PLH-04-16 (Plating Hold Lanes?)
- FACAPK, FACHIRANI, etc. (FA = Facility Codes)
- VF-LINE-01, 02

**Material hier:** Fertige Produkte warten auf Versand
**Netto-Bestand:** +187.830 kg (Material VORHANDEN)

### **LAGER (5 Bereiche)**
- STGDR-27, 28, 29, 30, 85

**Material hier:** Rohzutaten & Komponenten lagern
**Netto-Bestand:** +174.477 kg (Material GELAGERT)

### **ANDERE (127 Bereiche)**
- A-01-*, A-02-*, D-06-*, GC-*, P-04-*, etc.

**Material hier:** QC, Rücksendungen, Spezialbearbeitung
**Netto-Bestand:** +572.739 kg

---

## 🔍 WIE MAN JEDES PRODUKT VERFOLGT

**Beispiel: "Thyme Roasted Mushrooms"**

1. **In der CSV öffnen** → Zeile suchen mit diesem Namen
2. **Spalten lesen:**
   - `Gesamt_kg` → 111.855 kg Gesamtbewegung
   - `Zugänge` → +222.174 kg reingekommen
   - `Bewegungen` → -110.319 kg rausgegangen
   - `Netto` → +111.855 kg aktuell vorhanden
3. **Pro Bereich sehen** → In welchen Bereichen (Spalten) ist es?
   - Zeilen mit `Zugänge_` zeigen wo es reinkam
   - Zeilen mit `Bewegungen_` zeigen wo es rausging
   - Zeilen mit `Netto_` zeigen Saldo pro Ort

**In Excel:** Spalte sortieren/filtern → Nach Produkt suchen

---

## 💾 WAS TU ICH DAMIT?

### **Für Management:**
→ Öffne `KW19_Analyse_Excel_Report.xlsx`
- Sheet "Übersicht" für Statistik
- Sheet "Top_Produkte_Kategorien" für Highlights

### **Für Logistik/Lager:**
→ Öffne `KW19_Analyse_Erweitert_Zugaenge_Bewegungen.csv`
- Sehen welche Produkte wo sind
- Tracking namentlich möglich (KEINE Label-Nummer nötig!)

### **Für Produktion/Prep:**
→ Öffne `KW19_Analyse_Detailliert.csv`
- Top Rohzutaten im Verbrauch sehen
- Welche wurden verarbeitet?

### **Für IT/Data-Analyse:**
→ Python-Dateien verfügbar:
- `analyse_kw19.py` → Basis-Analyse
- `analyse_kw19_erweitert.py` → Erweiterte Version
- `erstelle_excel_report.py` → Report-Generator

---

## 🎯 GELÖSTES PROBLEM

**Original-Problem:** 
❌ "Keine Nummern begleiten Produkte von Anfang bis Ende"
❌ "Produkte nur in kg auf verschiedenen Racks"
❌ "Wie kg pro Produkt pro Bereich zusammensuchen?"

**Lösung:** ✅
✅ Gruppiere nach PRODUKTNAMEN (nicht Nummern)
✅ Summiere kg pro Produkt PER BEREICH
✅ Zeige Fluss von Inbound → Prep → Fulfillment

**Resultat:** 
Alle 119 Produkte namentlich verfolgt!
Alle kg pro Produkt pro Bereich sichtbar!
Kein Label nötig - nur Produktname!

---

## 📱 SCHNELLANLEITUNG ANSCHAUEN

### **OPTION 1: Excel (einfach, visuell) ⭐**
```
C:\WMS Wahrheit\KW19_Analyse_Excel_Report.xlsx
↓
Doppelklick
↓
Excel öffnet automatisch
↓
4 Sheets durchblättern
```

### **OPTION 2: CSV in Excel (Details, sortierbar)**
```
C:\WMS Wahrheit\KW19_Analyse_Detailliert.csv
↓
Rechtsklick → Öffnen mit → Excel
↓
Nach Produkt sortieren/filtern
↓
Alle Bereiche sehen
```

### **OPTION 3: CSV Erweitert (Zugänge/Bewegungen)**
```
C:\WMS Wahrheit\KW19_Analyse_Erweitert_Zugaenge_Bewegungen.csv
↓
Excel öffnen
↓
Sehen: Wo kam es her? Wo ging es hin?
```

### **OPTION 4: Jupyter Notebook (interaktiv)**
```
C:\WMS Wahrheit\KW19_Analyse.ipynb
↓
Mit VS Code öffnen
↓
Zellen einzeln ausführen (Play-Button)
↓
Graphen und Auswertungen live
```

---

## ✅ FERTIG!

Alle Daten sind analysiert und exportiert.
Du kannst sofort anfangen, sie anzuschauen! 🚀

Fragen? → Gib mir Bescheid, ich erkläre Details!
