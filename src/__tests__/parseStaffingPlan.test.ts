import { describe, expect, it } from "vitest";
import { parseStaffingPlan } from "../features/gsheet-monitor/parsers/parseStaffingPlan";

// Nachgebaut aus dem echten Sheet-Dump (Tab hinter gid=630874084): eine
// Blindzeile ("2026" = Jahres-Spalte) zwischen Zeilenlabel und den KW-Werten,
// mehrere Headcount-Zeilen für verschiedene Rollen/Abteilungen.
function realisticRows(): string[][] {
  const header = ["", "", "", "", "2026", "2026-W01", "2026-W02", "2026-W03", "2026-W38", "2026-W39", "2026-W40"];
  const supervisors = ["Input", "Staffing", "Headcount - Required", "Supervisors", "", "0", "0", "0", "10", "10", "10"];
  const kitchen = ["Input", "Staffing", "Headcount - Required", "Kitchen", "", "0", "0", "0", "32", "36", "36"];
  const plating = ["Input", "Staffing", "Headcount - Required", "Plating", "", "0", "0", "0", "40", "44", "44"];
  return [header, supervisors, kitchen, plating];
}

describe("parseStaffingPlan", () => {
  it("reads the Kitchen headcount for the requested week", () => {
    const result = parseStaffingPlan(realisticRows(), "2026-W39");
    expect(result).toEqual({ kitchenHeadcount: 36, weekLabel: "2026-W39" });
  });

  it("reads a different week correctly (column alignment, not just a fixed offset)", () => {
    const result = parseStaffingPlan(realisticRows(), "2026-W38");
    expect(result.kitchenHeadcount).toBe(32);
  });

  it("does not confuse the Kitchen row with Supervisors or Plating", () => {
    const result = parseStaffingPlan(realisticRows(), "2026-W39");
    expect(result.kitchenHeadcount).not.toBe(10); // Supervisors
    expect(result.kitchenHeadcount).not.toBe(44); // Plating
  });

  it("returns null when the requested week isn't in the sheet yet", () => {
    const result = parseStaffingPlan(realisticRows(), "2027-W05");
    expect(result.kitchenHeadcount).toBeNull();
  });

  it("returns null gracefully when the sheet is empty or unrecognized", () => {
    expect(parseStaffingPlan([], "2026-W39")).toEqual({ kitchenHeadcount: null, weekLabel: "2026-W39" });
    expect(parseStaffingPlan([["a", "b"], ["c", "d"]], "2026-W39").kitchenHeadcount).toBeNull();
  });
});
