"""
Template für schnelle Daten-Analysen.
Kopieren, umbenennen (YYYY-MM-DD_thema.py), loslegen.
"""

import json
import csv
from pathlib import Path

ROOT = Path(__file__).parent.parent

# ── Daten laden ──────────────────────────────────────────────
with open(ROOT / "public/data/data.json", encoding="utf-8") as f:
    data = json.load(f)

# ── Beispiel: Überblick ───────────────────────────────────────
print(f"Top-Level-Keys: {list(data.keys())}")

# ── Analyse hier ──────────────────────────────────────────────
