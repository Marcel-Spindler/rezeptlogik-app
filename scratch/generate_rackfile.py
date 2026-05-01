"""
generate_rackfile.py
====================
Ersetzt den F-ALPS Excel-Schritt:
Liest 'static exportP2L - DACH' aus dem MultiLine-Excel und baut daraus
die Rackfile CSV (= das Format das ins System hochgeladen wird).

Verwendung:
    python generate_rackfile.py                          # de-Profil (ASL3 + ASL4)
    python generate_rackfile.py --market nordics        # nordics-Profil (ASL1 + ASL5)
    python generate_rackfile.py --lines ASL3 ASL4       # Linien explizit überschreiben
    python generate_rackfile.py --week 2026-W20         # andere Woche im Dateinamen
    python generate_rackfile.py --sheet "exportP2L"     # anderes Quell-Sheet

Extra-Items (kommen NICHT aus HALO, z.B. DUF1):
    Tragt in EXTRA_ITEMS_PER_LINE unten ein, welche Loyalty-Items manuell
    eine Position bekommen sollen.  Format: Liste von Dicts mit den Feldern
    Recipe, Ingredient, SKU, FlowRackPosition, Quantity.
    Wird für jede Ziellinie repliziert.

Ausgabe (de):      Rackfile_[2026-W19]_[F-DE]_[ASL3_ASL4].csv
Ausgabe (nordics): Rackfile_KW19_[Fact-Nordics]_[ASL1,5].csv
"""

import csv
import argparse
from pathlib import Path
from datetime import date

try:
    import openpyxl
except ImportError:
    raise SystemExit("openpyxl fehlt – bitte installieren: pip install openpyxl")

# ── Konfiguration ────────────────────────────────────────────────────────────

SCRATCH = Path(__file__).parent

# Standard-Excel: das zuletzt abgelegte MultiLine-Excel
def find_multiline_xlsx() -> Path:
    candidates = sorted(SCRATCH.glob("MultiLine*.xlsx"))
    if not candidates:
        raise FileNotFoundError("Kein MultiLine*.xlsx in scratch/ gefunden.")
    return candidates[-1]  # neueste Datei

DEFAULT_SHEET = "static exportP2L - DACH"
DEFAULT_LINES = ["ASL3", "ASL4"]
MARKET = "F-DE"

MARKET_PROFILES = {
    "de": {
        "sheet": "static exportP2L - DACH",
        "lines": ["ASL3", "ASL4"],
        "output_mode": "de",
    },
    "nordics": {
        "sheet": "static exportP2L - Nordics",
        "lines": ["ASL1", "ASL5"],
        "output_mode": "nordics",
    },
}

# ── Extra-Items (NICHT in HALO/exportP2L enthalten) ─────────────────────────
# Ergänze hier Loyalty-Items die manuell positioniert werden müssen.
# Einfach auskommentieren wenn sie diese Woche nicht gebraucht werden.
EXTRA_ITEMS: list[dict] = [
    # Duffel-Bag Loyalty (W19 2026 – bei F132)
    # {
    #     "Recipe": "DUF1",
    #     "Ingredient": "FA-DE Firth Box - Duffel Bag",
    #     "SKU": "Loyalties",
    #     "FlowRackPosition": "F132",
    #     "Quantity": 1,
    # },
]

# ── Transformation ──────────────────────────────────────────────────────────

def _portion_suffix(recipe: str) -> str:
    """Gibt den Teil nach '_' zurück (z.B. '1p'), oder '' wenn kein Underscore."""
    if "_" in str(recipe):
        return recipe.split("_", 1)[1]  # '304_1p' → '1p'
    return ""


def _sort_key(fp: str) -> int:
    """F55 → 55, F105 → 105"""
    try:
        return int(str(fp).lstrip("F"))
    except ValueError:
        return 9999


def build_rackfile_rows(source_rows: list, target_line: str) -> list:
    """
    Wandelt Zeilen aus exportP2L (ASL1-Vorlage) in Rackfile-Rows für target_line um.
    
    Quell-Spalten:  Recipe, Ingredient, SKU, Line, FlowRackPosition, Quantity, ScanRegEx, StorageConditions
    Ziel-Spalten:   Recipe, Line, FlowRackPosition, Quantity, SKU, Ingredient, ScanRegEx,
                    LabelPos, UniCode, DisplayName, Gramage, Sort
    """
    result = []

    for row in source_rows:
        if len(row) < 6:
            continue

        recipe, ingredient, sku, _line, fp, quantity, scan_regex = (
            row[0], row[1], row[2], row[3], row[4], row[5],
            row[6] if len(row) > 6 else None,
        )

        # Nur Zeilen mit gültiger Position
        if fp is None or recipe is None:
            continue

        fp = str(fp).strip()
        recipe = str(recipe).strip()
        ingredient = str(ingredient).strip() if ingredient else ""
        sku = str(sku).strip() if sku else ""
        scan_regex = str(scan_regex).strip() if scan_regex else ""
        qty = int(quantity) if quantity is not None else 1

        label_pos = f"{target_line}{fp}"          # z.B. ASL3F55
        portion = _portion_suffix(recipe)
        uni_code = f"{label_pos}{portion}" if portion else label_pos  # z.B. ASL3F551p

        result.append({
            "Recipe": recipe,
            "Line": target_line,
            "FlowRackPosition": fp,
            "Quantity": qty,
            "SKU": sku,
            "Ingredient": ingredient,
            "ScanRegEx": scan_regex,
            "LabelPos": label_pos,
            "UniCode": uni_code,
            "DisplayName": ingredient,
            "Gramage": "",
            "Sort": _sort_key(fp),
        })

    return result


# ── Hauptprogramm ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Rackfile CSV Generator")
    parser.add_argument(
        "--market",
        choices=["de", "nordics"],
        default="de",
        help="Marktprofil mit Standard-Sheet und Standard-Linien",
    )
    parser.add_argument("--excel", type=Path, default=None, help="Pfad zum MultiLine Excel")
    parser.add_argument("--sheet", default=None, help="Sheet-Name im Excel (überschreibt Marktprofil)")
    parser.add_argument("--lines", nargs="+", default=None, help="Ziel-Linien (überschreibt Marktprofil)")
    parser.add_argument("--week", default=None, help="Wochenbezeichnung im Dateinamen (z.B. 2026-W20)")
    parser.add_argument("--out", type=Path, default=None, help="Ausgabe-Pfad (ohne Endung)")
    args = parser.parse_args()

    profile = MARKET_PROFILES[args.market]
    sheet_name = args.sheet or profile["sheet"]
    target_lines = args.lines or profile["lines"]

    # Woche
    week_str = args.week or date.today().strftime("%G-W%V")

    # Excel-Datei
    xlsx_path = args.excel or find_multiline_xlsx()
    print(f"Lese: {xlsx_path.name}")
    print(f"Markt: {args.market}")
    print(f"Sheet: {sheet_name}")
    print(f"Linien: {', '.join(target_lines)}")

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    if sheet_name not in wb.sheetnames:
        avail = ", ".join(wb.sheetnames)
        raise SystemExit(f"Sheet '{sheet_name}' nicht gefunden.\nVerfügbar: {avail}")

    ws = wb[sheet_name]
    all_rows = list(ws.iter_rows(values_only=True))
    header = all_rows[0]
    data_rows = all_rows[1:]
    print(f"  → {len(data_rows)} Daten-Zeilen gelesen (Header: {header[:7]})")

    # Für jede Ziellinie eine CSV erzeugen
    lines_str = "_".join(target_lines)
    if args.out:
        out_name = args.out
    elif profile["output_mode"] == "nordics":
        # Für Nordics passt das bestehende Betriebsformat aus der Anlage besser.
        kw = week_str.split("W")[-1]
        lines_token = ",".join([ln.replace("ASL", "") for ln in target_lines])
        out_name = SCRATCH / f"Rackfile_KW{kw}_[Fact-Nordics]_[ASL{lines_token}]"
    else:
        out_name = SCRATCH / f"Rackfile_[{week_str}]_[{MARKET}]_[{lines_str}]"
    out_path = out_name.with_suffix(".csv")

    fieldnames = [
        "Recipe", "Line", "FlowRackPosition", "Quantity", "SKU",
        "Ingredient", "ScanRegEx", "LabelPos", "UniCode",
        "DisplayName", "Gramage", "Sort",
    ]

    total_rows = 0
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for line in target_lines:
            rows = build_rackfile_rows(data_rows, line)

            # Extra-Items anhängen (manuell positionierte Loyalty-Items)
            for extra in EXTRA_ITEMS:
                fp = extra["FlowRackPosition"]
                lp = f"{line}{fp}"
                rows.append({
                    "Recipe":          extra["Recipe"],
                    "Line":            line,
                    "FlowRackPosition": fp,
                    "Quantity":        extra.get("Quantity", 1),
                    "SKU":             extra.get("SKU", "Loyalties"),
                    "Ingredient":      extra["Ingredient"],
                    "ScanRegEx":       "",
                    "LabelPos":        lp,
                    "UniCode":         lp,
                    "DisplayName":     extra["Ingredient"],
                    "Gramage":         "",
                    "Sort":            _sort_key(fp),
                })
            rows.sort(key=lambda r: r["Sort"])

            writer.writerows(rows)
            total_rows += len(rows)
            print(f"  {line}: {len(rows)} Zeilen geschrieben")

    print(f"\nFertig: {out_path.name} ({total_rows} Zeilen gesamt)")


if __name__ == "__main__":
    main()
