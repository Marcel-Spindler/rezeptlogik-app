import openpyxl
from openpyxl.utils import get_column_letter

inv_path = "Current_Inventory (2).xlsx"
wb = openpyxl.load_workbook(inv_path, data_only=True)
for s in wb.sheetnames:
    ws = wb[s]
    print(f"=== {s}  dims={ws.dimensions}  rows={ws.max_row} cols={ws.max_column} ===")

ws = wb.active
print("active sheet:", ws.title)
# header rows
for r in range(1, 6):
    row = [ws.cell(row=r, column=c).value for c in range(1, ws.max_column+1)]
    print(r, row)

# print first 25 data rows
print("--- first 25 rows ---")
for r in range(1, 30):
    row = [ws.cell(row=r, column=c).value for c in range(1, ws.max_column+1)]
    print(r, row)
