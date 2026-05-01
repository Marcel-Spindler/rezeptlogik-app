"""Fill DRAFT VolumeBuffer Overview F.xlsx Actual columns (H, J, L, N) for sub-recipe rows
using net positive inventory from Current_Inventory (2).xlsx.

Logic (user-confirmed):
- Match the sub-recipe name in column C of the draft against 'Item Description' in inventory.
- Sum only positive 'Actual Quantity' values, but ignore tiny placeholder lots (qty <= 1.5 KG/EA).
- Write into the empty Actual cells (H, J, L, N). Do NOT overwrite existing values/formulas.
"""

import openpyxl
from collections import defaultdict
import shutil
import re

DRAFT = "DRAFT VolumeBuffer Overview F_ .xlsx"
INV   = "Current_Inventory (2).xlsx"
OUT   = "DRAFT VolumeBuffer Overview F_ FILLED.xlsx"

# 1) Load inventory: name -> sum of positive (>1.5) quantities
inv_wb = openpyxl.load_workbook(INV, data_only=True)
inv_ws = inv_wb.active
inv_pos = defaultdict(float)
inv_lots = defaultdict(list)
all_inv_names = set()
for r in range(2, inv_ws.max_row + 1):
    desc = inv_ws.cell(row=r, column=4).value
    qty  = inv_ws.cell(row=r, column=10).value
    if not desc:
        continue
    all_inv_names.add(desc)
    try:
        q = float(qty)
    except (TypeError, ValueError):
        continue
    if q > 1.5:
        inv_pos[desc] += q
        inv_lots[desc].append(q)

def lookup(name: str):
    """Return the positive inventory sum for `name`. Tries exact match, then
    case-insensitive contains both ways."""
    if name is None:
        return None, None
    key = name.strip()
    if key in inv_pos:
        return inv_pos[key], key
    low = key.lower()
    # Inventory descriptions are sometimes truncated (e.g. "Honey-Garlic Roasted Carrot Co").
    for k in inv_pos:
        if k.lower() == low:
            return inv_pos[k], k
    # Try prefix match (draft name starts with inventory name OR vice versa)
    for k in inv_pos:
        kl = k.lower()
        if low.startswith(kl) or kl.startswith(low):
            return inv_pos[k], k
    # Try substring
    for k in inv_pos:
        if low in k.lower() or k.lower() in low:
            return inv_pos[k], k
    return None, None

# 2) Open draft (preserve formulas)
shutil.copy(DRAFT, OUT)
wb = openpyxl.load_workbook(OUT)
ws = wb.active

ACTUAL_COLS = [8, 10, 12, 14]   # H=Debox Actual, J=Blast Chiller Actual, L=Plating Holding Actual, N=Plating Actual
SUB_RECIPE_ROWS = []

# Identify Sub-Recipe rows: column B == 'Sub' OR previous Rezept block continuation rows.
# Strategy: walk rows; when col B == 'Rezept' begin block; subsequent rows up to next blank/header are subs.
# Skip the first block (rows 5-10) which is the template example with fictional data.
SKIP_ROWS = set(range(5, 11))
in_block = False
for r in range(1, ws.max_row + 1):
    b = ws.cell(row=r, column=2).value
    c = ws.cell(row=r, column=3).value
    if b == 'Rezept':
        in_block = True
        continue
    if in_block:
        if (b is None and c is None):
            in_block = False
            continue
        # treat any non-empty C row in the block as sub-recipe (incl. 'Sub' marker rows)
        if c and r not in SKIP_ROWS:
            SUB_RECIPE_ROWS.append(r)

print(f"Sub-recipe rows detected: {SUB_RECIPE_ROWS}")

report = []
for r in SUB_RECIPE_ROWS:
    name = ws.cell(row=r, column=3).value
    val, matched = lookup(name)
    if val is None:
        # Try also negative-only matches: report as 0 if name occurs in inventory (no positive stock)
        any_match = any(name and (name.lower() in k.lower() or k.lower() in (name or "").lower())
                        for k in all_inv_names)
        if any_match:
            val = 0.0
            matched = "(no positive stock)"
        else:
            report.append((r, name, None, "NO MATCH", []))
            continue
    written = []
    for col in ACTUAL_COLS:
        cell = ws.cell(row=r, column=col)
        if cell.value in (None, ""):
            cell.value = round(val, 2)
            written.append(openpyxl.utils.get_column_letter(col))
    report.append((r, name, val, matched, written))

wb.save(OUT)

print("\n=== Fill Report ===")
for r, name, val, matched, written in report:
    if val is None:
        print(f"R{r:3}  [{name}]  -> NO INVENTORY MATCH")
    else:
        cols = ",".join(written) if written else "(all already filled)"
        print(f"R{r:3}  [{name}]  pos_sum={val:.2f}  matched='{matched}'  written: {cols}")

print(f"\nSaved: {OUT}")
