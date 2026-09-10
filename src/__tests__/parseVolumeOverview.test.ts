import { describe, expect, it } from "vitest";
import { parseVolumeOverview } from "../features/gsheet-monitor/parsers/parseVolumeOverview";

// Zeilen nach dem echten "Volume Overview"-Dump (F_VE Transparency Plan, gid
// 1602943717). Ganz oben der Gesamt-Block (alle Märkte), darunter Markt-
// Unterblöcke ("BENL" / "DE") mit eigener "Recipe Code"-Kopfzeile.
const ROWS: string[][] = [
  ["", "", "W38"],
  // Header des Gesamt-Blocks (Spacer-Spalten 8/14/17 leer)
  ["", "Week Recipe Code", "W38 Recipe Name", "Slot", "Forecast Total", "Thu", "Fri", "Sat", "", "Production", "Actual Target", "Thu", "Fri", "Sat", "", "Planned", "Delta", "", "Comment | Action"],
  ["W38YES", "FV1351A", "Cheddar & Red Pepper Chicken", "402", "6,958", "3,555", "1,311", "2,092", "", "4,960", "-1,998", "1,405", "94", "-1,998", "", "7,635", "-677", "", "Fondue short"],
  ["W38YES", "FV4063C", "Cheddar pulled beef", "403", "7,953", "4,161", "1,436", "2,356", "", "0", "-7,953", "-4,161", "-5,597", "-7,953", "", "8,881", "-928", "", ""],
  // L/M/N leer → Lücke muss abgeleitet werden: Production − kumulierter Forecast
  ["W38YES", "FV0780A", "Whole Wheat Penne Bolognese", "405", "7,039", "3,622", "1,300", "2,117", "", "5,600", "", "", "", "", "", "7,982", "", "", ""],
  // Gesamt-Total-Zeile (Code-Spalte leer)
  ["", "", "", "", "14,911", "7,716", "2,747", "4,448", "", "4,960", "-9,951", "-2,756", "-5,503", "-9,951"],
  // Markt-Unterblock DE — darf NICHT mehr eingelesen werden
  ["", "DE"],
  ["", "Recipe Code", "Recipe Name"],
  ["W38YES", "FV1351A", "Cheddar & Red Pepper Chicken", "402", "1,448", "453", "0", "995", "", "352", "-1,096", "-101", "-101", "-1,096"],
];

describe("parseVolumeOverview", () => {
  const data = parseVolumeOverview(ROWS);

  it("reads the week and only the combined (all-markets) block", () => {
    expect(data.week).toBe("W38");
    expect(data.rows.map(r => r.code)).toEqual(["FV1351A", "FV4063C", "FV0780A"]); // DE sub-block excluded
  });

  it("derives the Actual-Target gap (L/M/N) when the cells are empty", () => {
    const c = data.byCode.get("FV0780A")!; // Production 5600, Forecast Do/Fr/Sa 3622/1300/2117
    expect(c.gapByDay.thu).toBe(5600 - 3622);                 // 1978
    expect(c.gapByDay.fri).toBe(5600 - (3622 + 1300));        // 678
    expect(c.gapByDay.sat).toBe(5600 - (3622 + 1300 + 2117)); // -1439
  });

  it("maps forecast, production and the per-checkpoint gap", () => {
    const a = data.byCode.get("FV1351A")!;
    expect(a.forecastTotal).toBe(6958);
    expect(a.forecastByDay).toEqual({ thu: 3555, fri: 1311, sat: 2092 });
    expect(a.production).toBe(4960);
    expect(a.planned).toBe(7635);
    expect(a.deltaVsPlanned).toBe(-677);
    // "Actual Target" Thu/Fri/Sat = Production − kumulierter Forecast
    expect(a.gapByDay).toEqual({ thu: 1405, fri: 94, sat: -1998 });
    expect(a.comment).toBe("Fondue short");
  });

  it("carries a not-yet-plaited meal as a full shortfall", () => {
    const b = data.byCode.get("FV4063C")!;
    expect(b.production).toBe(0);
    expect(b.gapByDay.sat).toBe(-7953);
  });

  it("returns an empty result when the header is missing", () => {
    expect(parseVolumeOverview([["no", "header", "here"]]).rows).toEqual([]);
  });
});
