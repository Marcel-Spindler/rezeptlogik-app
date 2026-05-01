"""Build an overview Excel that aggregates Current_Inventory per SKU + base location.
Base location = location string with the trailing '-<digit>' (Abstelllinie) stripped.
e.g. A-02-19-1 and A-02-19-2 -> A-02-19
"""
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from collections import defaultdict
import re

INV = "Current_Inventory (2).xlsx"
OUT = "Inventory Overview by SKU+Location.xlsx"

inv_wb = openpyxl.load_workbook(INV, data_only=True)
ws = inv_wb.active

# Header indices (0-based -> +1 for openpyxl)
H = {ws.cell(row=1, column=c).value: c for c in range(1, ws.max_column + 1)}

def strip_line(loc):
    if not loc:
        return loc
    return re.sub(r'-\d+$', '', str(loc).strip())

# Aggregate: (sku, item_desc, uom, base_loc) -> dict
agg = defaultdict(lambda: {
    'qty_pos': 0.0, 'qty_neg': 0.0, 'cases': 0.0,
    'lots': set(), 'lps': set(), 'sub_locs': set(),
    'statuses': set(), 'po_weeks': set(), 'fifo_min': None, 'exp_min': None,
})

def parse_date(s):
    if not s: return None
    if hasattr(s, 'year'):
        return s
    try:
        from datetime import datetime
        return datetime.strptime(str(s).split()[0], '%m/%d/%Y')
    except Exception:
        return None

for r in range(2, ws.max_row + 1):
    sku   = ws.cell(row=r, column=H['Item Number']).value
    desc  = ws.cell(row=r, column=H['Item Description']).value
    uom   = ws.cell(row=r, column=H['Unit of Measure']).value
    loc   = ws.cell(row=r, column=H['Location']).value
    qty   = ws.cell(row=r, column=H['Actual Quantity']).value
    cases = ws.cell(row=r, column=H['Cases']).value
    lot   = ws.cell(row=r, column=H['Lot Number']).value
    lp    = ws.cell(row=r, column=H['License Plate']).value
    stat  = ws.cell(row=r, column=H['Status']).value
    pow_  = ws.cell(row=r, column=H['PO Week']).value
    fifo  = ws.cell(row=r, column=H['FIFO Date']).value
    exp   = ws.cell(row=r, column=H['Expiration Date']).value

    if not sku:
        continue
    try: q = float(qty)
    except (TypeError, ValueError): q = 0.0
    try: c = float(cases)
    except (TypeError, ValueError): c = 0.0

    base = strip_line(loc)
    key = (sku, desc, uom, base)
    a = agg[key]
    if q >= 0: a['qty_pos'] += q
    else:      a['qty_neg'] += q
    a['cases'] += c
    if lot: a['lots'].add(str(lot))
    if lp:  a['lps'].add(str(lp))
    if loc and loc != base: a['sub_locs'].add(str(loc))
    elif loc: a['sub_locs'].add(str(loc))
    if stat: a['statuses'].add(str(stat))
    if pow_: a['po_weeks'].add(str(pow_))
    fd = parse_date(fifo)
    if fd:
        if a['fifo_min'] is None or fd < a['fifo_min']: a['fifo_min'] = fd
    ed = parse_date(exp)
    if ed:
        if a['exp_min'] is None or ed < a['exp_min']: a['exp_min'] = ed

# ---- Build output workbook ----
out = openpyxl.Workbook()

# Sheet 1: Aggregated overview
s1 = out.active
s1.title = "By SKU+Location"
headers = [
    "Item Number (SKU)", "Item Description", "UoM",
    "Base Location", "Sub Locations (Lines)",
    "Net Qty", "Positive Qty", "Negative Qty", "Cases",
    "# Lots", "# License Plates", "Status", "PO Weeks",
    "Earliest FIFO", "Earliest Expiration",
]
s1.append(headers)

# Style header
hdr_font = Font(bold=True, color="FFFFFF")
hdr_fill = PatternFill("solid", fgColor="305496")
center = Alignment(horizontal="center", vertical="center", wrap_text=True)
thin = Side(border_style="thin", color="BFBFBF")
border = Border(left=thin, right=thin, top=thin, bottom=thin)
for col in range(1, len(headers)+1):
    c = s1.cell(row=1, column=col)
    c.font = hdr_font; c.fill = hdr_fill; c.alignment = center; c.border = border

# Sort: by description, then base location
rows = sorted(agg.items(), key=lambda kv: (str(kv[0][1] or ''), str(kv[0][3] or '')))

red_fill   = PatternFill("solid", fgColor="F8CBAD")  # negative net
green_fill = PatternFill("solid", fgColor="E2EFDA")  # all positive
yellow_fill= PatternFill("solid", fgColor="FFF2CC")  # mixed

for (sku, desc, uom, base), a in rows:
    net = a['qty_pos'] + a['qty_neg']
    sub_locs = ", ".join(sorted(a['sub_locs']))
    stat = ", ".join(sorted(a['statuses']))
    pw   = ", ".join(sorted(a['po_weeks']))
    fifo_s = a['fifo_min'].strftime('%Y-%m-%d') if a['fifo_min'] else ''
    exp_s  = a['exp_min'].strftime('%Y-%m-%d')  if a['exp_min']  else ''
    s1.append([
        sku, desc, uom, base, sub_locs,
        round(net, 3), round(a['qty_pos'], 3), round(a['qty_neg'], 3), round(a['cases'], 3),
        len(a['lots']), len(a['lps']), stat, pw, fifo_s, exp_s,
    ])
    r = s1.max_row
    # color the row by status
    fill = green_fill
    if net < 0: fill = red_fill
    elif a['qty_neg'] < 0 and a['qty_pos'] > 0: fill = yellow_fill
    for col in (6, 7, 8):
        s1.cell(row=r, column=col).fill = fill
    for col in range(1, len(headers)+1):
        s1.cell(row=r, column=col).border = border

# Column widths
widths = [20, 50, 6, 14, 28, 12, 12, 12, 10, 8, 10, 10, 12, 14, 14]
for i, w in enumerate(widths, start=1):
    s1.column_dimensions[get_column_letter(i)].width = w

s1.freeze_panes = "A2"
s1.auto_filter.ref = s1.dimensions

# Sheet 2: Per-location summary (one row per base location)
s2 = out.create_sheet("By Base Location")
s2.append(["Base Location", "# distinct SKUs", "# Lots", "# LPs", "Total Net Qty (mixed UoM!)"])
for col in range(1, 6):
    c = s2.cell(row=1, column=col)
    c.font = hdr_font; c.fill = hdr_fill; c.alignment = center; c.border = border

loc_agg = defaultdict(lambda: {'skus': set(), 'lots': set(), 'lps': set(), 'net': 0.0})
for (sku, desc, uom, base), a in agg.items():
    L = loc_agg[base]
    L['skus'].add(sku)
    L['lots'].update(a['lots'])
    L['lps'].update(a['lps'])
    L['net'] += a['qty_pos'] + a['qty_neg']

for base, L in sorted(loc_agg.items(), key=lambda kv: str(kv[0] or '')):
    s2.append([base, len(L['skus']), len(L['lots']), len(L['lps']), round(L['net'], 3)])

for col, w in enumerate([18, 16, 10, 10, 22], start=1):
    s2.column_dimensions[get_column_letter(col)].width = w
s2.freeze_panes = "A2"
s2.auto_filter.ref = s2.dimensions

# Sheet 3: Sub-recipe focus list (the items used in DRAFT)
s3 = out.create_sheet("DRAFT Sub-Recipes")
s3.append(["Sub-Recipe (DRAFT)", "Matched SKU", "UoM", "Base Location",
           "Sub Locations", "Net Qty", "Pos Qty", "Neg Qty", "Cases",
           "Lots", "Status"])
for col in range(1, 12):
    c = s3.cell(row=1, column=col)
    c.font = hdr_font; c.fill = hdr_fill; c.alignment = center; c.border = border

DRAFT_NAMES = [
    "Garlic Spinach Stamppot",
    "Green Beans CUT 1-1/2 - Fresh - Less Salt",
    "Honey-Garlic Roasted Carrot Co",   # truncated in inventory
    "Sauce - Creamy Dijon and Dill",
    "Salmon - garlic seasoning",
    "Garlic Herb Marinated Salmon",
    "Broccoli - S&P Broccoli FLORETS - less salt",
    "FA-DE Capers, Preserved/Kapern, konserviert",
    "Parmesan Cauliflower Mash - Ri",
    "Sauce - Piccata Sauce - Lower",
]

for name in DRAFT_NAMES:
    rows_for = [(k,a) for k,a in agg.items() if (k[1] or '').strip() == name]
    if not rows_for:
        s3.append([name, "—", "", "", "", 0, 0, 0, 0, 0, "NO MATCH"])
        s3.cell(row=s3.max_row, column=1).fill = red_fill
        continue
    rows_for.sort(key=lambda kv: kv[0][3] or '')
    for (sku, desc, uom, base), a in rows_for:
        net = a['qty_pos'] + a['qty_neg']
        s3.append([
            name, sku, uom, base,
            ", ".join(sorted(a['sub_locs'])),
            round(net,3), round(a['qty_pos'],3), round(a['qty_neg'],3), round(a['cases'],3),
            len(a['lots']),
            ", ".join(sorted(a['statuses'])),
        ])
        r = s3.max_row
        fill = green_fill
        if net < 0: fill = red_fill
        elif a['qty_neg'] < 0 and a['qty_pos'] > 0: fill = yellow_fill
        for col in (6,7,8):
            s3.cell(row=r, column=col).fill = fill

for col, w in enumerate([42, 22, 6, 14, 26, 12, 12, 12, 10, 8, 10], start=1):
    s3.column_dimensions[get_column_letter(col)].width = w
s3.freeze_panes = "A2"
s3.auto_filter.ref = s3.dimensions

out.save(OUT)
print(f"Saved: {OUT}")
print(f"Sheet1 rows: {s1.max_row-1}  | Sheet2 rows: {s2.max_row-1}  | Sheet3 rows: {s3.max_row-1}")
