import openpyxl, json
from openpyxl.utils import get_column_letter

draft_path = "DRAFT VolumeBuffer Overview F_ .xlsx"
inv_path = "Current_Inventory (2).xlsx"

print("=== DRAFT (values) ===")
wb = openpyxl.load_workbook(draft_path, data_only=True)
ws = wb.active
print("sheet:", ws.title, "dims:", ws.dimensions, "max_row:", ws.max_row, "max_col:", ws.max_column)
# print first 30 rows
for r in range(1, min(ws.max_row, 40)+1):
    row = [ws.cell(row=r, column=c).value for c in range(1, ws.max_column+1)]
    if any(v not in (None,"") for v in row):
        print(r, row)

print("\n=== DRAFT (formulas) ===")
wb2 = openpyxl.load_workbook(draft_path, data_only=False)
ws2 = wb2.active
for r in range(1, min(ws2.max_row, 40)+1):
    for c in range(1, ws2.max_column+1):
        v = ws2.cell(row=r, column=c).value
        if isinstance(v, str) and v.startswith("="):
            print(f"{get_column_letter(c)}{r}: {v}")
