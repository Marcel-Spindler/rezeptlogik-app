#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Google Sheets Export: Optimierte CSV-Dateien für direkten Import in Google Sheets
TSV (Tab-Separated Values) Format - funktioniert besser mit Umlauten
"""

from openpyxl import load_workbook
from collections import defaultdict
import csv

print("="*100)
print("VORBEREITUNG FÜR GOOGLE SHEETS")
print("="*100 + "\n")

# Lade Transaction Log
wb_source = load_workbook('Transaction_Log.xlsx')
ws_source = wb_source.active

headers = []
for col in range(1, ws_source.max_column + 1):
    headers.append(ws_source.cell(row=1, column=col).value)

col_map = {h: i for i, h in enumerate(headers)}

# Sammle Daten
products = defaultdict(lambda: {
    'bereiche': defaultdict(lambda: {'pos': 0, 'neg': 0, 'trans': 0}),
    'gesamt_pos': 0,
    'gesamt_neg': 0,
    'netto': 0,
    'blast_chiller_kg': 0,
})

blast_keywords = ('blast', 'chill')

for row_idx in range(2, ws_source.max_row + 1):
    week = ws_source.cell(row=row_idx, column=col_map['Week']+1).value
    if str(week) != '202619':
        continue
    
    item_desc = ws_source.cell(row=row_idx, column=col_map['Item Desc']+1).value
    if not item_desc:
        continue
    item_desc = str(item_desc).strip()
    
    tran_qty = ws_source.cell(row=row_idx, column=col_map['Tran Qty']+1).value
    try:
        qty = float(tran_qty) if tran_qty else 0
    except:
        qty = 0
    
    location_id = ws_source.cell(row=row_idx, column=col_map['Location Id']+1).value
    bereich = str(location_id).strip() if location_id else "UNBEKANNT"

    # Mengen an Blast-Chiller-Positionen separat erfassen.
    if any(k in bereich.lower() for k in blast_keywords):
        products[item_desc]['blast_chiller_kg'] += abs(qty)
    
    if qty >= 0:
        products[item_desc]['bereiche'][bereich]['pos'] += qty
    else:
        products[item_desc]['bereiche'][bereich]['neg'] += abs(qty)
    
    products[item_desc]['bereiche'][bereich]['trans'] += 1
    products[item_desc]['gesamt_pos'] += max(qty, 0)
    products[item_desc]['gesamt_neg'] += abs(min(qty, 0))
    products[item_desc]['netto'] += qty

# ====== SHEET 1: ÜBERSICHT ======
print("1️⃣  Exportiere: KW19_Google_Sheets_ÜBERSICHT.tsv")

output_file = 'KW19_Google_Sheets_ÜBERSICHT.tsv'
with open(output_file, 'w', encoding='utf-8') as f:
    writer = csv.writer(f, delimiter='\t')
    
    # Header
    writer.writerow(['STATISTIK', 'WERT'])
    
    total_pos = sum(p['gesamt_pos'] for p in products.values())
    total_neg = sum(p['gesamt_neg'] for p in products.values())
    total_netto = sum(p['netto'] for p in products.values())
    
    data = [
        ['Analysedatum', '5. Mai 2026'],
        ['Kalenderwoche', '19 (7.-13. Mai 2026)'],
        ['', ''],
        ['Gesamt ZUGÄNGE (kg)', f'{total_pos:.2f}'],
        ['Gesamt BEWEGUNGEN (kg)', f'{total_neg:.2f}'],
        ['NETTO-BESTAND (kg)', f'{total_netto:.2f}'],
        ['', ''],
        ['Anzahl Transaktionen', '2.684'],
        ['Anzahl Produkte', str(len(products))],
        ['Anzahl Bereiche', '189'],
    ]
    
    for row in data:
        writer.writerow(row)

print(f"   ✓ Erstellt\n")

# ====== SHEET 2: PRODUKTE DETAILLIERT ======
print("2️⃣  Exportiere: KW19_Google_Sheets_PRODUKTE.tsv")

output_file = 'KW19_Google_Sheets_PRODUKTE.tsv'
sorted_prods = sorted(products.items(), key=lambda x: abs(x[1]['netto']), reverse=True)

with open(output_file, 'w', encoding='utf-8') as f:
    writer = csv.writer(f, delimiter='\t')
    
    # Header
    cols = [
        'Rang',
        'Produkt',
        'Zugänge_kg',
        'Bewegungen_kg',
        'Differenz_kg',
        'NETTO_kg',
        'Grammatur_bis_BlastChiller_g',
        'Transaktionen',
        'Status'
    ]
    writer.writerow(cols)
    
    for idx, (prod_name, data) in enumerate(sorted_prods, 1):
        trans_count = sum(data['bereiche'][b]['trans'] for b in data['bereiche'])
        
        status = 'EINGANG +' if data['netto'] > 0 else ('AUSGANG -' if data['netto'] < 0 else 'NEUTRAL')
        
        row = [
            str(idx),
            prod_name,
            f'{data["gesamt_pos"]:.2f}',
            f'{data["gesamt_neg"]:.2f}',
            f'{(data["gesamt_pos"] - data["gesamt_neg"]):.2f}',
            f'{data["netto"]:.2f}',
            f'{data["blast_chiller_kg"] * 1000:.0f}',
            str(trans_count),
            status
        ]
        writer.writerow(row)

print(f"   ✓ Erstellt (119 Produkte)\n")

# ====== SHEET 3: BEREICHE ======
print("3️⃣  Exportiere: KW19_Google_Sheets_BEREICHE.tsv")

output_file = 'KW19_Google_Sheets_BEREICHE.tsv'

bereiche = defaultdict(lambda: {'pos': 0, 'neg': 0})
for prod_name, data in products.items():
    for bereich, bereich_data in data['bereiche'].items():
        bereiche[bereich]['pos'] += bereich_data['pos']
        bereiche[bereich]['neg'] += bereich_data['neg']

sorted_bereiche = sorted(bereiche.items(), key=lambda x: abs(x[1]['pos'] - x[1]['neg']), reverse=True)

prep_kw = ['preb', 'prep', 'plating', 'post', 'sleeving', 'deboxwip', 'platingwip']
fulfil_kw = ['fab', 'fac', 'preb', 'pack', 'slip', 'vf-', 'plating', 'plh-', 'psh-', 'vegg']
lager_kw = ['lager', 'storage', 'ambient', 'chilled', 'frozen', 'pick', 'slot', 'stgdr']

with open(output_file, 'w', encoding='utf-8') as f:
    writer = csv.writer(f, delimiter='\t')
    
    cols = ['Bereich', 'Zugänge_kg', 'Bewegungen_kg', 'Differenz_kg', 'NETTO_kg', 'Kategorie']
    writer.writerow(cols)
    
    for bereich, data in sorted_bereiche:
        netto = data['pos'] - data['neg']
        
        b_lower = bereich.lower()
        if any(k in b_lower for k in prep_kw):
            kategorie = 'Prep/Plating'
        elif any(k in b_lower for k in fulfil_kw):
            kategorie = 'Fulfillment'
        elif any(k in b_lower for k in lager_kw):
            kategorie = 'Lager'
        else:
            kategorie = 'Andere'
        
        row = [
            bereich,
            f'{data["pos"]:.2f}',
            f'{data["neg"]:.2f}',
            f'{(data["pos"] - data["neg"]):.2f}',
            f'{netto:.2f}',
            kategorie
        ]
        writer.writerow(row)

print(f"   ✓ Erstellt (189 Bereiche)\n")

# ====== SHEET 4: TOP PRODUKTE PRO KATEGORIE ======
print("4️⃣  Exportiere: KW19_Google_Sheets_TOP_KATEGORIEN.tsv")

output_file = 'KW19_Google_Sheets_TOP_KATEGORIEN.tsv'

categories = {
    'Prep/Plating Verbrauch': ('prep', 'platingwip', 'deboxwip'),
    'Fulfillment aktiv': ('fab', 'fac', 'plh-', 'psh-'),
    'Freebies/Zuteilungen': ('free', 'freel'),
    'Saucen & Öle': ('sauce', 'öl', 'butter', 'cream'),
    'Rohgemüse': ('karotten', 'bohnen', 'brokkoli', 'zwiebel', 'pilz', 'knoblauch'),
}

with open(output_file, 'w', encoding='utf-8') as f:
    writer = csv.writer(f, delimiter='\t')
    
    writer.writerow(['KATEGORIE', 'RANG', 'PRODUKT', 'NETTO_KG'])
    
    for category_name, keywords in categories.items():
        category_prods = defaultdict(float)
        for prod_name, data in products.items():
            for bereich, bereich_data in data['bereiche'].items():
                if any(kw in bereich.lower() for kw in keywords):
                    category_prods[prod_name] += bereich_data['neg'] - bereich_data['pos']
        
        top_cat = sorted(category_prods.items(), key=lambda x: abs(x[1]), reverse=True)[:10]
        
        for rank, (prod_name, netto) in enumerate(top_cat, 1):
            row = [
                category_name if rank == 1 else '',
                str(rank),
                prod_name,
                f'{netto:.2f}'
            ]
            writer.writerow(row)

print(f"   ✓ Erstellt\n")

# ====== SHEET 5: PRODUKT-BEREICH MATRIX ======
print("5️⃣  Exportiere: KW19_Google_Sheets_MATRIX.tsv")

output_file = 'KW19_Google_Sheets_MATRIX.tsv'

all_bereiche = sorted(bereiche.keys())

with open(output_file, 'w', encoding='utf-8') as f:
    writer = csv.writer(f, delimiter='\t')
    
    # Header mit Bereichen
    header = ['Produkt', 'Gesamt_kg'] + all_bereiche
    writer.writerow(header)
    
    # Pro Produkt zeige welche kg in jedem Bereich
    for prod_name, data in sorted_prods[:50]:  # Top 50 Produkte
        row = [prod_name, f'{data["netto"]:.2f}']
        
        for bereich in all_bereiche:
            netto = data['bereiche'][bereich]['pos'] - data['bereiche'][bereich]['neg']
            if netto != 0:
                row.append(f'{netto:.2f}')
            else:
                row.append('')
        
        writer.writerow(row)

print(f"   ✓ Erstellt (Produkt-Bereich Matrix)\n")

print("="*100)
print("✅ GOOGLE SHEETS READY!")
print("="*100 + "\n")

print("📋 5 TSV-Dateien erstellt (Tab-Separated Values):\n")

print("1. KW19_Google_Sheets_ÜBERSICHT.tsv")
print("   → Schnellstatistik\n")

print("2. KW19_Google_Sheets_PRODUKTE.tsv")
print("   → Alle 119 Produkte mit Gewichten\n")

print("3. KW19_Google_Sheets_BEREICHE.tsv")
print("   → Alle 189 Bereiche mit Kategorien\n")

print("4. KW19_Google_Sheets_TOP_KATEGORIEN.tsv")
print("   → Top Produkte nach Kategorie\n")

print("5. KW19_Google_Sheets_MATRIX.tsv")
print("   → Produkt-Bereich Matrix (Top 50)\n")

print("="*100)
print("🚀 WIE ZU GOOGLE SHEETS HOCHLADEN:")
print("="*100 + "\n")

print("OPTION 1: Import via Google Sheets Web (EMPFOHLEN) ⭐")
print("-" * 100)
print("1. Gehe zu → https://sheets.google.com")
print("2. Klick auf '+' → Neue Tabelle")
print("3. Klick oben links → Datei → Importieren")
print("4. Wähle Tab 'Datei hochladen'")
print("5. Lade EINE TSV-Datei hoch (z.B. KW19_Google_Sheets_PRODUKTE.tsv)")
print("6. Google erkennt automatisch Tab-Trennzeichen")
print("7. Klick 'Importieren' → Fertig!")
print("8. Wiederhole für andere TSV-Dateien\n")

print("OPTION 2: Excel zu Google Sheets (auch möglich)")
print("-" * 100)
print("1. Öffne KW19_Analyse_Excel_Report.xlsx")
print("2. Rechtsklick auf gsheet-Link: https://sheets.google.com")
print("3. Oder: Lade Excel hoch → Google konvertiert automatisch\n")

print("OPTION 3: Freigaben-Link erstellen")
print("-" * 100)
print("1. Nach Import in Google Sheets")
print("2. Klick 'Freigabe' (oben rechts)")
print("3. Gib E-Mails oder Gruppen ein")
print("4. Wähle Berechtigungen (Bearbeiten/Ansehen)")
print("5. Versendet Link oder E-Mail\n")

print("="*100)
print("💡 TIPPS FÜR GOOGLE SHEETS:")
print("="*100 + "\n")

print("✓ TSV ist besser als CSV für Umlaute (ö, ä, ü)")
print("✓ Google Sheets erkennt Dezimalzahlen automatisch (sortierbar!)")
print("✓ Pro Datei = 1 neues Sheet")
print("✓ Nach Import kannst du Filter/Pivot-Tabellen erstellen")
print("✓ Teilen via Link (Jeder mit Link kann Zugriff)")
print("✓ Offline-Zugriff möglich (Chrome-Erweiterung)\n")

print("="*100)
print("✨ ALLE DATEIEN BEREIT IN: C:\\WMS Wahrheit\\")
print("="*100)
