import { describe, expect, it } from "vitest";
import { parseShortsTracker } from "../features/gsheet-monitor/parsers/parseShortsTracker";

// Realer Zeilen-Ausschnitt aus dem "Shorts Tracker"-Tab (Live-Dump 2026-08-25) —
// Titel-/Leer-/Header-/Rollen-Zeilen davor, dann die eigentlichen Datenzeilen.
const RAW_ROWS: string[][] = [
  ["28"],
  [],
  ["WO", "Staging Day", "Ingredient", "", "Short (KGs)", "Recovery Status", "", "Ticket #", "Notes", "Filled"],
  ["", "", "", "SKU", "", "", "Quantity Located"],
  ["WH", "WH", "WH", "", "WH", "Procurement", "WH", "WH", "Procurement", "WH"],
  ["58", "22.08.2026", "FA-DE Basil, Fresh /Basilikum, frisch", "PHF-00-139175-3", "81.5", "Shipment  En Route", "", "", "Supplier shorted: 160kg will arrive tomorrow (2635VF771941) ETA 12:30 "],
  ["89", "22.08.2026", "FA-DE Pork, Tenderloin /Schweinefleisch, Filet", "PTN-00-139310-3", "183.8", "Shipment  En Route"],
  ["17", "21.08.2026", "FA-DE Chicken, Thighs, Boneless Skinless /Hähnchen", "PTN-00-139343-3", "385.8"],
];

describe("parseShortsTracker", () => {
  it("skips title/blank/header/role rows and only parses real data rows", () => {
    const result = parseShortsTracker(RAW_ROWS);
    expect(result.entries).toHaveLength(3);
  });

  it("reconstructs the full WO number (<KW>-<Nummer>) from Staging Day using the HF-week convention", () => {
    const result = parseShortsTracker(RAW_ROWS);
    // 22.08.2026 (Saturday) falls in ISO week 2026-W34 (Mon 17.08.-Sun 23.08.)
    // -> HF week (ISO+1) = W35 -> "35-58".
    const basil = result.entries.find(e => e.ingredient.startsWith("FA-DE Basil"));
    expect(basil?.workOrder).toBe("35-58");
    expect(basil?.rawWorkOrderSuffix).toBe("58");
    expect(basil?.stagingDay).toBe("2026-08-22");
  });

  it("parses the shortage amount and free-text fields", () => {
    const result = parseShortsTracker(RAW_ROWS);
    const basil = result.entries.find(e => e.ingredient.startsWith("FA-DE Basil"));
    expect(basil?.shortKg).toBeCloseTo(81.5, 5);
    expect(basil?.sku).toBe("PHF-00-139175-3");
    expect(basil?.recoveryStatus).toBe("Shipment  En Route");
    expect(basil?.notes).toContain("Supplier shorted");
    expect(basil?.filled).toBe(false);
  });

  it("treats a row with neither recovery status nor notes as not yet triaged", () => {
    const result = parseShortsTracker(RAW_ROWS);
    const chicken = result.entries.find(e => e.ingredient.startsWith("FA-DE Chicken"));
    expect(chicken?.recoveryStatus).toBe("");
    expect(chicken?.notes).toBe("");
  });

  it("indexes entries by their reconstructed work order", () => {
    const result = parseShortsTracker(RAW_ROWS);
    expect(result.byWorkOrder.get("35-58")).toHaveLength(1);
    expect(result.byWorkOrder.get("35-89")).toHaveLength(1);
  });

  it("marks a row as filled when the Filled column says TRUE", () => {
    const rows = [
      ["WO", "Staging Day", "Ingredient", "SKU", "Short (KGs)", "Recovery Status", "", "Ticket #", "Notes", "Filled"],
      ["58", "22.08.2026", "Test Ingredient", "SKU-1", "10", "Resolved", "", "", "", "TRUE"],
    ];
    const result = parseShortsTracker(rows);
    expect(result.entries[0].filled).toBe(true);
  });
});
