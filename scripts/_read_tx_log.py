"""Helper: liest Transaction_Log.xlsx und gibt alle Zeilen als JSON aus."""
import json
import re
import sys
from openpyxl import load_workbook

xlsx_path = sys.argv[1]

wb = load_workbook(xlsx_path, read_only=True, data_only=True)
ws = wb[wb.sheetnames[0]]
all_rows = [list(r) for r in ws.iter_rows(values_only=True)]

headers = [str(h or "").strip() for h in (all_rows[0] if all_rows else [])]
week_idx = next((i for i, h in enumerate(headers) if h.lower() == "week"), -1)


def get_week(row):
    raw = str(row[week_idx] if 0 <= week_idx < len(row) else "").strip()
    return raw[:-2] if raw.endswith(".0") else raw


body = [r for r in all_rows[1:] if re.match(r"^[0-9]{6}$", get_week(r))]
rows_out = [[str(v) if v is not None else "" for v in r] for r in body]

print(json.dumps({"headers": headers, "rows": rows_out}))
