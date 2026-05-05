#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
KW 19 Analyse: Produkt-Verfolgung von Inbound bis Fulfillment
Aggregiert Gewichte produktweise über alle Bereiche hinweg
"""

from openpyxl import load_workbook
from collections import defaultdict
import csv
from datetime import datetime

# Lade Workbook
wb = load_workbook('Transaction_Log.xlsx')
ws = wb.active

# Lese Header
headers = []
for col in range(1, ws.max_column + 1):
    headers.append(ws.cell(row=1, column=col).value)

print(f"{'='*100}")
print("KW 19 ANALYSE: INBOUND BIS FULFILLMENT")
print(f"{'='*100}\n")

# Spalten-Indizes
col_map = {h: i for i, h in enumerate(headers)}
print(f"Relevante Spalten:")
print(f"  - Week: Index {col_map.get('Week')}")
print(f"  - Item Desc: Index {col_map.get('Item Desc')}")
print(f"  - Tran Qty: Index {col_map.get('Tran Qty')}")
print(f"  - Location Id: Index {col_map.get('Location Id')}")
print(f"  - Eaches/Weight Per Case: Index {col_map.get('Eaches/Weight Per Case')}")
print(f"  - Start Tran Date: Index {col_map.get('Start Tran Date')}")
print(f"  - User Zone: Index {col_map.get('User Zone')}\n")

# Daten für KW 19 sammeln
products = defaultdict(lambda: {
    'bereiche': defaultdict(float),
    'gesamt_kg': 0,
    'transaktionen': 0,
    'daten': []
})

bereiche_set = set()
kw19_count = 0
total_rows = ws.max_row

print(f"Lese {total_rows - 1} Zeilen...")

for row_idx in range(2, total_rows + 1):
    if row_idx % 5000 == 0:
        print(f"  Verarbeitet: {row_idx}/{total_rows}...")
    
    # Hole Zellenwerte
    week = ws.cell(row=row_idx, column=col_map['Week']+1).value
    item_desc = ws.cell(row=row_idx, column=col_map['Item Desc']+1).value
    tran_qty = ws.cell(row=row_idx, column=col_map['Tran Qty']+1).value
    location_id = ws.cell(row=row_idx, column=col_map['Location Id']+1).value
    weight_per_case = ws.cell(row=row_idx, column=col_map['Eaches/Weight Per Case']+1).value
    user_zone = ws.cell(row=row_idx, column=col_map['User Zone']+1).value
    start_date = ws.cell(row=row_idx, column=col_map['Start Tran Date']+1).value
    
    # Filtere KW 19 (202619)
    if str(week) != '202619':
        continue
    
    kw19_count += 1
    
    # Sicherstelle, dass Item Desc existiert
    if not item_desc:
        continue
    
    item_desc = str(item_desc).strip()
    
    # Konvertiere Menge zu float
    try:
        qty = float(tran_qty) if tran_qty else 0
    except:
        qty = 0
    
    # Standort/Bereich
    bereich = str(location_id).strip() if location_id else "UNBEKANNT"
    bereiche_set.add(bereich)
    
    # Speichere Daten
    products[item_desc]['bereiche'][bereich] += qty
    products[item_desc]['transaktionen'] += 1
    products[item_desc]['gesamt_kg'] += qty
    products[item_desc]['daten'].append({
        'bereich': bereich,
        'menge': qty,
        'zone': user_zone,
        'datum': start_date
    })

print(f"\n✓ {kw19_count} Transaktionen für KW 19 gefunden\n")

# Kategorisiere Bereiche
print(f"{'='*100}")
print("BEREICHE (LOCATIONS) IDENTIFIZIERT:")
print(f"{'='*100}\n")

inbound_keywords = ['inb', 'empf', 'wareneingang', 'receiving', 'stage']
lager_keywords = ['lager', 'storage', 'warehouse', 'ambient', 'chilled', 'frozen', 'zl', 'pick', 'slot']
fulfillment_keywords = ['fulfil', 'versand', 'ship', 'pack', 'dispatch', 'outbound', 'fab']
qc_keywords = ['qc', 'control', 'adj', 'adjust']

inbound_areas = []
lager_areas = []
fulfillment_areas = []
qc_areas = []
other_areas = []

for bereich in sorted(bereiche_set):
    bereich_lower = bereich.lower()
    if any(k in bereich_lower for k in inbound_keywords):
        inbound_areas.append(bereich)
        status = "INBOUND"
    elif any(k in bereich_lower for k in lager_keywords):
        lager_areas.append(bereich)
        status = "LAGER"
    elif any(k in bereich_lower for k in fulfillment_keywords):
        fulfillment_areas.append(bereich)
        status = "FULFILLMENT"
    elif any(k in bereich_lower for k in qc_keywords):
        qc_areas.append(bereich)
        status = "QC/ADJUST"
    else:
        other_areas.append(bereich)
        status = "ANDERE"
    
    print(f"  [{status:15s}] {bereich}")

print(f"\nZusammenfassung:")
print(f"  Inbound-Bereiche:    {len(inbound_areas)}")
print(f"  Lager-Bereiche:      {len(lager_areas)}")
print(f"  Fulfillment-Bereiche: {len(fulfillment_areas)}")
print(f"  QC/Adjust-Bereiche:  {len(qc_areas)}")
print(f"  Andere:              {len(other_areas)}")

# Sortiere Produkte nach Gesamtgewicht
sorted_products = sorted(products.items(), key=lambda x: x[1]['gesamt_kg'], reverse=True)

print(f"\n{'='*100}")
print("PRODUKTE NACH GESAMTGEWICHT (KW 19)")
print(f"{'='*100}\n")

total_kg = sum(p[1]['gesamt_kg'] for p in sorted_products)
print(f"GESAMTMENGE KW 19: {total_kg:.2f} kg")
print(f"Anzahl einzigartiger Produkte: {len(sorted_products)}\n")

print(f"{'Pos':<4} {'Produkt':<50} {'Gesamt_kg':>12} {'Transactions':>12} {'%':<6}")
print(f"{'-'*100}")

for i, (prod_name, data) in enumerate(sorted_products[:30], 1):
    pct = (data['gesamt_kg'] / total_kg) * 100 if total_kg > 0 else 0
    print(f"{i:<4} {prod_name:<50} {data['gesamt_kg']:>12.2f} {data['transaktionen']:>12} {pct:>5.1f}%")

if len(sorted_products) > 30:
    print(f"\n... und {len(sorted_products) - 30} weitere Produkte")

# PRODUKT-FLOW: Inbound bis Fulfillment
print(f"\n\n{'='*100}")
print("PRODUKT-FLOW: VON INBOUND BIS FULFILLMENT")
print(f"{'='*100}\n")

print(f"{'Produkt':<50} {'Inbound':>12} {'Lager':>12} {'Fulfillment':>12} {'QC/Adj':>12} {'Andere':>12} {'Gesamt':>12}")
print(f"{'-'*110}")

for prod_name, data in sorted_products[:20]:
    inbound_qty = sum(data['bereiche'].get(b, 0) for b in inbound_areas)
    lager_qty = sum(data['bereiche'].get(b, 0) for b in lager_areas)
    fulfillment_qty = sum(data['bereiche'].get(b, 0) for b in fulfillment_areas)
    qc_qty = sum(data['bereiche'].get(b, 0) for b in qc_areas)
    other_qty = sum(data['bereiche'].get(b, 0) for b in other_areas)
    
    print(f"{prod_name:<50} {inbound_qty:>12.2f} {lager_qty:>12.2f} {fulfillment_qty:>12.2f} {qc_qty:>12.2f} {other_qty:>12.2f} {data['gesamt_kg']:>12.2f}")

# GEWICHTSVERTEILUNG NACH BEREICHEN
print(f"\n\n{'='*100}")
print("GEWICHTSVERTEILUNG NACH BEREICHEN (KW 19)")
print(f"{'='*100}\n")

bereich_totals = defaultdict(float)
for prod_name, data in sorted_products:
    for bereich, qty in data['bereiche'].items():
        bereich_totals[bereich] += qty

print(f"{'Bereich':<40} {'Gewicht_kg':>12} {'%':>6} {'Typ':<15}")
print(f"{'-'*75}")

for bereich in sorted(bereich_totals.keys()):
    qty = bereich_totals[bereich]
    pct = (qty / total_kg) * 100 if total_kg > 0 else 0
    
    bereich_lower = bereich.lower()
    if any(k in bereich_lower for k in inbound_keywords):
        typ = "INBOUND"
    elif any(k in bereich_lower for k in lager_keywords):
        typ = "LAGER"
    elif any(k in bereich_lower for k in fulfillment_keywords):
        typ = "FULFILLMENT"
    elif any(k in bereich_lower for k in qc_keywords):
        typ = "QC/ADJUST"
    else:
        typ = "ANDERE"
    
    print(f"{bereich:<40} {qty:>12.2f} {pct:>5.1f}% {typ:<15}")

# Exportiere detaillierte Ergebnisse zu CSV
output_file = 'KW19_Analyse_Detailliert.csv'
print(f"\n\nExportiere detaillierte Ergebnisse zu {output_file}...")

with open(output_file, 'w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f, delimiter=';')
    
    # Header
    all_bereiche = sorted(bereiche_set)
    header = ['Produkt', 'Gesamt_kg', 'Transaktionen'] + all_bereiche
    writer.writerow(header)
    
    # Daten
    for prod_name, data in sorted_products:
        row = [prod_name, f"{data['gesamt_kg']:.2f}", str(data['transaktionen'])]
        for bereich in all_bereiche:
            row.append(f"{data['bereiche'].get(bereich, 0):.2f}")
        writer.writerow(row)

print(f"✓ Exportiert: {output_file}\n")

print(f"{'='*100}")
print("ANALYSE ABGESCHLOSSEN")
print(f"{'='*100}")
