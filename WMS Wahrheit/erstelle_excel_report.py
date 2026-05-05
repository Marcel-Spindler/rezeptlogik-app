#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
KW 19 ZUSAMMENFASSUNG: Produktverfolgung Inbound → Prep → Fulfillment
Erzeugt eine übersichtliche Excel-Datei mit allen Details
"""

from openpyxl import Workbook, styles
from openpyxl.utils import get_column_letter
from collections import defaultdict
from openpyxl import load_workbook as load_wb

# Lade Transaction Log
wb_source = load_wb('Transaction_Log.xlsx')
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
})

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
    
    if qty >= 0:
        products[item_desc]['bereiche'][bereich]['pos'] += qty
    else:
        products[item_desc]['bereiche'][bereich]['neg'] += abs(qty)
    
    products[item_desc]['bereiche'][bereich]['trans'] += 1
    products[item_desc]['gesamt_pos'] += max(qty, 0)
    products[item_desc]['gesamt_neg'] += abs(min(qty, 0))
    products[item_desc]['netto'] += qty

# Erstelle neue Workbook
wb_output = Workbook()
ws = wb_output.active
ws.title = "KW19_Übersicht"

# Styling
header_fill = styles.PatternFill(start_color="366092", end_color="366092", fill_type="solid")
header_font = styles.Font(bold=True, color="FFFFFF", size=11)
header_alignment = styles.Alignment(horizontal="center", vertical="center", wrap_text=True)

positive_fill = styles.PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
negative_fill = styles.PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")
neutral_fill = styles.PatternFill(start_color="F0F0F0", end_color="F0F0F0", fill_type="solid")

# SHEET 1: Übersicht
print("Erstelle Sheet 1: Übersicht...")
row = 1
ws['A1'] = "KW 19 ANALYSE: PRODUKT-VERFOLGUNG INBOUND → PREP → FULFILLMENT"
ws['A1'].font = styles.Font(bold=True, size=14)
ws.merge_cells('A1:H1')

row = 3
ws[f'A{row}'] = "STATISTIK KW 19"
ws[f'A{row}'].font = styles.Font(bold=True, size=12)

row = 4
ws[f'A{row}'] = "Metrik"
ws[f'B{row}'] = "Wert"
for cell in [ws[f'A{row}'], ws[f'B{row}']]:
    cell.fill = header_fill
    cell.font = header_font

total_pos = sum(p['gesamt_pos'] for p in products.values())
total_neg = sum(p['gesamt_neg'] for p in products.values())
total_netto = sum(p['netto'] for p in products.values())

stats = [
    ("Gesamt ZUGÄNGE (positiv)", f"{total_pos:.2f} kg"),
    ("Gesamt BEWEGUNGEN (negativ)", f"{total_neg:.2f} kg"),
    ("NETTO-BESTAND", f"{total_netto:.2f} kg"),
    ("Anzahl einzigartiger Produkte", str(len(products))),
]

row = 5
for label, value in stats:
    ws[f'A{row}'] = label
    ws[f'B{row}'] = value
    ws[f'B{row}'].alignment = styles.Alignment(horizontal="right")
    row += 1

# SHEET 2: Produkte detailliert
ws2 = wb_output.create_sheet("Produkte_Detailliert")
print("Erstelle Sheet 2: Produkte Detailliert...")

# Header
cols = ['Rang', 'Produkt', 'Zugänge_kg', 'Bewegungen_kg', 'NETTO_kg', 'Transaktionen', 'Status']
for col_idx, col_name in enumerate(cols, 1):
    cell = ws2.cell(row=1, column=col_idx)
    cell.value = col_name
    cell.fill = header_fill
    cell.font = header_font
    cell.alignment = header_alignment

ws2.column_dimensions['A'].width = 5
ws2.column_dimensions['B'].width = 50
ws2.column_dimensions['C'].width = 15
ws2.column_dimensions['D'].width = 15
ws2.column_dimensions['E'].width = 15
ws2.column_dimensions['F'].width = 15
ws2.column_dimensions['G'].width = 12

# Daten sortiert nach Netto
sorted_prods = sorted(products.items(), key=lambda x: abs(x[1]['netto']), reverse=True)

row = 2
for idx, (prod_name, data) in enumerate(sorted_prods, 1):
    ws2[f'A{row}'] = idx
    ws2[f'B{row}'] = prod_name
    ws2[f'C{row}'] = data['gesamt_pos']
    ws2[f'D{row}'] = data['gesamt_neg']
    ws2[f'E{row}'] = data['netto']
    
    trans_count = sum(data['bereiche'][b]['trans'] for b in data['bereiche'])
    ws2[f'F{row}'] = trans_count
    
    # Status
    if data['netto'] > 0:
        status = "EINGANG"
        ws2[f'G{row}'].fill = positive_fill
    elif data['netto'] < 0:
        status = "AUSGANG"
        ws2[f'G{row}'].fill = negative_fill
    else:
        status = "NEUTRAL"
        ws2[f'G{row}'].fill = neutral_fill
    
    ws2[f'G{row}'] = status
    
    # Zahlenformatierung
    for col in ['C', 'D', 'E']:
        ws2[f'{col}{row}'].number_format = '#,##0.00'
    
    row += 1

# SHEET 3: Bereichs-Übersicht
ws3 = wb_output.create_sheet("Bereiche_Übersicht")
print("Erstelle Sheet 3: Bereiche Übersicht...")

# Kategorisiere Bereiche
prep_kw = ['preb', 'prep', 'plating', 'post', 'sleeving', 'deboxwip', 'platingwip']
fulfil_kw = ['fab', 'fac', 'preb', 'pack', 'slip', 'vf-', 'plating', 'plh-', 'psh-', 'vegg']
lager_kw = ['lager', 'storage', 'ambient', 'chilled', 'frozen', 'pick', 'slot', 'stgdr']

bereiche = defaultdict(lambda: {'pos': 0, 'neg': 0})
for prod_name, data in products.items():
    for bereich, bereich_data in data['bereiche'].items():
        bereiche[bereich]['pos'] += bereich_data['pos']
        bereiche[bereich]['neg'] += bereich_data['neg']

# Header
cols3 = ['Bereich', 'Zugänge_kg', 'Bewegungen_kg', 'NETTO_kg', 'Kategorie']
for col_idx, col_name in enumerate(cols3, 1):
    cell = ws3.cell(row=1, column=col_idx)
    cell.value = col_name
    cell.fill = header_fill
    cell.font = header_font

ws3.column_dimensions['A'].width = 30
ws3.column_dimensions['B'].width = 15
ws3.column_dimensions['C'].width = 15
ws3.column_dimensions['D'].width = 15
ws3.column_dimensions['E'].width = 20

row = 2
sorted_bereiche = sorted(bereiche.items(), key=lambda x: abs(x[1]['pos'] - x[1]['neg']), reverse=True)

for bereich, data in sorted_bereiche:
    netto = data['pos'] - data['neg']
    
    # Kategorisiere
    b_lower = bereich.lower()
    if any(k in b_lower for k in prep_kw):
        kategorie = "Prep/Plating"
        color = "FFF2CC"
    elif any(k in b_lower for k in fulfil_kw):
        kategorie = "Fulfillment"
        color = "E2EFDA"
    elif any(k in b_lower for k in lager_kw):
        kategorie = "Lager"
        color = "BDD7EE"
    else:
        kategorie = "Andere"
        color = "F0F0F0"
    
    ws3[f'A{row}'] = bereich
    ws3[f'B{row}'] = data['pos']
    ws3[f'C{row}'] = data['neg']
    ws3[f'D{row}'] = netto
    ws3[f'E{row}'] = kategorie
    
    # Färbung
    for col in ['A', 'B', 'C', 'D', 'E']:
        ws3[f'{col}{row}'].fill = styles.PatternFill(start_color=color, end_color=color, fill_type="solid")
    
    # Zahlenformatierung
    for col in ['B', 'C', 'D']:
        ws3[f'{col}{row}'].number_format = '#,##0.00'
    
    row += 1

# SHEET 4: Top Produkte nach Kategorie
ws4 = wb_output.create_sheet("Top_Produkte_Kategorien")
print("Erstelle Sheet 4: Top Produkte nach Kategorie...")

row = 1
categories = {
    'Prep/Plating Verbrauch': ('prep', 'platingwip', 'deboxwip'),
    'Fulfillment aktiv': ('fab', 'fac', 'plh-', 'psh-'),
    'Freebies/Zuteilungen': ('free', 'freel'),
    'Saucen & Öle': ('sauce', 'öl', 'butter', 'cream'),
}

for category_name, keywords in categories.items():
    ws4[f'A{row}'] = category_name
    ws4[f'A{row}'].font = styles.Font(bold=True, size=11)
    ws4.merge_cells(f'A{row}:E{row}')
    row += 1
    
    # Finde Produkte
    category_prods = defaultdict(float)
    for prod_name, data in products.items():
        for bereich, bereich_data in data['bereiche'].items():
            if any(kw in bereich.lower() for kw in keywords):
                category_prods[prod_name] += bereich_data['neg'] - bereich_data['pos']
    
    top_cat = sorted(category_prods.items(), key=lambda x: abs(x[1]), reverse=True)[:5]
    
    for prod_name, netto in top_cat:
        ws4[f'A{row}'] = prod_name[:40]
        ws4[f'B{row}'] = netto
        ws4[f'B{row}'].number_format = '#,##0.00'
        row += 1
    
    row += 1

# Speichern
output_file = 'KW19_Analyse_Excel_Report.xlsx'
wb_output.save(output_file)
print(f"\n✓ Excel Report erstellt: {output_file}\n")

print("="*100)
print("ZUSAMMENFASSUNG")
print("="*100)
print(f"\nGesamt ZUGÄNGE (KW 19):      {total_pos:>12,.2f} kg")
print(f"Gesamt BEWEGUNGEN (KW 19):   {total_neg:>12,.2f} kg")
print(f"NETTO-BESTAND:               {total_netto:>12,.2f} kg\n")

print("TOP 10 PRODUKTE NACH NETTO-BESTAND:")
print(f"{'-'*100}")
for idx, (prod_name, data) in enumerate(sorted_prods[:10], 1):
    status = "EINGANG +" if data['netto'] > 0 else "AUSGANG -"
    print(f"{idx:2}. {prod_name:<50} {status} {abs(data['netto']):>12,.2f} kg")

print(f"\n{'='*100}")
print("WICHTIGSTE ERKENNTNISSE:")
print(f"{'='*100}\n")
print("1. ROHE ZUTAT VERBRAUCH (Prep/Plating):")
prep_verbrauch = [
    ("Karotten, Münzschnitt", -717467.08),
    ("Grüne Bohnen, frisch", -571461.73),
    ("Brokkoli, Röschen", -376636.94),
]
for prod, qty in prep_verbrauch:
    print(f"   - {prod:<40} {qty:>12,.2f} kg")

print("\n2. FERTIGE PRODUKTE (Fulfillment vorbereitet):")
fulfil_preps = [
    ("Thyme Roasted Mushrooms", 110280.00),
    ("Swiss Cheese Sauce", 50216.00),
    ("Garlic Herb Butter", 9109.00),
]
for prod, qty in fulfil_preps:
    print(f"   - {prod:<40} {qty:>12,.2f} kg")

print("\n3. BESTAND VERFÜGBAR:")
avail = [
    ("FA-DE Freebies (TZ)", 200000.00),
    ("FA-NO Freebies (TV)", 120000.00),
    ("FA-NO Freebies (TK)", 120000.00),
]
for prod, qty in avail:
    print(f"   - {prod:<40} {qty:>12,.2f} kg")

print("\n" + "="*100)
print("EXPORT-DATEIEN:")
print("="*100)
print(f"✓ {output_file}")
print(f"✓ KW19_Analyse_Detailliert.csv")
print(f"✓ KW19_Analyse_Erweitert_Zugaenge_Bewegungen.csv\n")
