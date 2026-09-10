import { describe, expect, it } from "vitest";
import { buildRtiExternalTargets } from "../features/backfills/buildRtiExternalTargets";
import type { DataBundle, WeekRecipe } from "../core/types";
import type { LinePlaitingData, LinePlaitingRow } from "../features/gsheet-monitor/gsheetTypes";
import type { PlatingRunDisplay } from "../features/redzone-live/redzoneTypes";

function wr(code: string, total: number, weekShort = "W38"): WeekRecipe {
  return {
    hfWeek: `2026-${weekShort}`, weekShort, code, recipeName: code, preference: "",
    slot: {}, verdenVolume: { BENL: 0, DKSE: 0, DE: total }, totalVerdenVolume: total, productionBuffer: 0,
  };
}

function data(...recipes: WeekRecipe[]): DataBundle {
  return { weekRecipes: recipes } as unknown as DataBundle;
}

function run(code: string, outCount: number, startTime: string, area = "Plating"): PlatingRunDisplay {
  return {
    areaName: area, locationName: "Plating Line 1", productTypeName: `${code} - Test`, productTypeSKU: "",
    outCount, inCount: null, startTime, endTime: null, runName: "",
    status: "completed", mealCode: code, durationMin: null,
  };
}

function linePlaiting(...rows: Partial<LinePlaitingRow>[]): LinePlaitingData {
  const full = rows.map(r => ({
    week: "W38", day: "Tuesday", time: "", phase: "shortage" as const, recipeCode: "FV0001A", meal: "Test",
    plannedPortions: 0, actualPortions: 0, deltaPortions: 0, comment: "", backfillConfirmed: false,
    minNeededPortions: null, dayNeedPortions: null, statusText: "", shortageReason: "", shortagePct: null,
    ...r,
  }));
  return { week: "W38", rows: full, byRecipeCode: new Map(), dayTotals: [], lastUpdated: 0 };
}

// fester "jetzt": Do 2026-09-10 → Montag der Woche = 2026-09-07 00:00 lokal
const NOW = new Date(2026, 8, 10, 8, 0, 0);

describe("buildRtiExternalTargets", () => {
  it("Forecast (totalVerdenVolume) + Redzone-Output je 4-Ziffer-Code", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0780A", 6918)),
      weekShort: "W38",
      linePlaiting: null,
      redzoneRuns: [
        run("FV0780A", 3000, "2026-09-08T06:00:00"),
        run("FV0780A", 2539, "2026-09-09T06:00:00"),
      ],
      now: NOW,
    });
    const t = m.get("0780")!;
    expect(t.plannedTarget).toBe(6918);
    expect(t.actuals).toBe(5539);
    expect(t.source).toBe("Forecast + Redzone");
  });

  it("kein Redzone → LinePlaiting Σ Actual als Fallback", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0001A", 3000)),
      weekShort: "W38",
      linePlaiting: linePlaiting(
        { recipeCode: "FV0001A", plannedPortions: 1500, actualPortions: 1400 },
        { recipeCode: "FV0001A", plannedPortions: 1500, actualPortions: 1300, day: "Wednesday" },
      ),
      redzoneRuns: [],
      now: NOW,
    });
    const t = m.get("0001")!;
    expect(t.plannedTarget).toBe(3000);
    expect(t.actuals).toBe(2700);
    expect(t.source).toBe("Forecast + LinePlaiting");
  });

  it("kein Forecast → LinePlaiting Σ Planned trägt das Ziel", () => {
    const m = buildRtiExternalTargets({
      data: data(),
      weekShort: "W38",
      linePlaiting: linePlaiting({ recipeCode: "FV0042A", plannedPortions: 2000, actualPortions: 1800 }),
      redzoneRuns: [],
      now: NOW,
    });
    const t = m.get("0042")!;
    expect(t.plannedTarget).toBe(2000);
    expect(t.actuals).toBe(1800);
    expect(t.source).toBe("LinePlaiting + LinePlaiting");
  });

  it("ohne Ist-Zahl (kein Redzone, kein LinePlaiting-Actual) → kein Eintrag", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0001A", 3000)),
      weekShort: "W38", linePlaiting: null, redzoneRuns: [], now: NOW,
    });
    expect(m.has("0001")).toBe(false);
  });

  it("Redzone-Run vor Montag der Woche wird ignoriert", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0001A", 3000)),
      weekShort: "W38",
      linePlaiting: null,
      redzoneRuns: [
        run("FV0001A", 2500, "2026-09-05T06:00:00"), // Sa der Vorwoche
        run("FV0001A", 400, "2026-09-08T06:00:00"),
      ],
      now: NOW,
    });
    expect(m.get("0001")!.actuals).toBe(400);
  });

  it("Nicht-Plating-Runs (Ovens/Braisers) zählen nicht", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0001A", 3000)),
      weekShort: "W38",
      linePlaiting: null,
      redzoneRuns: [
        run("FV0001A", 2000, "2026-09-08T06:00:00", "Ovens"),
        run("FV0001A", 500, "2026-09-08T07:00:00"),
      ],
      now: NOW,
    });
    expect(m.get("0001")!.actuals).toBe(500);
  });

  it("Ist über Ziel → auf das Ziel geklemmt", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0001A", 3000)),
      weekShort: "W38",
      linePlaiting: null,
      redzoneRuns: [run("FV0001A", 3200, "2026-09-08T06:00:00")],
      now: NOW,
    });
    expect(m.get("0001")!.actuals).toBe(3000);
  });

  it("andere KW im weekShort → dieser WeekRecipe zählt nicht", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0001A", 3000, "W37")),
      weekShort: "W38",
      linePlaiting: null,
      redzoneRuns: [run("FV0001A", 1000, "2026-09-08T06:00:00")],
      now: NOW,
    });
    expect(m.has("0001")).toBe(false);
  });
});
