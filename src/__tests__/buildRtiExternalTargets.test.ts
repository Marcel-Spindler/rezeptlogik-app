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
  it("LinePlaiting 1. Run treibt Planned UND Actual (nicht die Forecast-Gesamtzahl)", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0780A", 6918)), // Forecast-Gesamt, hier NICHT verwendet
      weekShort: "W38",
      linePlaiting: linePlaiting(
        { recipeCode: "FV0780A", plannedPortions: 5510, actualPortions: 5600 },
        { recipeCode: "FV0780A", plannedPortions: 2540, actualPortions: 0, day: "Friday" }, // 2. Run — ignoriert
      ),
      redzoneRuns: [run("FV0780A", 5539, "2026-09-08T06:00:00")],
      now: NOW,
    });
    const t = m.get("0780")!;
    expect(t.plannedTarget).toBe(5510);
    expect(t.actuals).toBe(5600); // Ist > Ziel (Überproduktion 1. Run) — bis Ziel×1.05 erlaubt
    expect(t.source).toBe("LinePlaiting 1. Run");
  });

  it("kein LinePlaiting-Actual → Redzone-Output als Ist-Fallback", () => {
    const m = buildRtiExternalTargets({
      data: data(),
      weekShort: "W38",
      linePlaiting: linePlaiting({ recipeCode: "FV0001A", plannedPortions: 3000, actualPortions: 0 }),
      redzoneRuns: [run("FV0001A", 2700, "2026-09-08T06:00:00")],
      now: NOW,
    });
    const t = m.get("0001")!;
    expect(t.plannedTarget).toBe(3000);
    expect(t.actuals).toBe(2700);
    expect(t.source).toBe("LinePlaiting 1. Run / Redzone");
  });

  it("kein LinePlaiting → Forecast-Gesamt trägt das Ziel (markiert), Redzone das Ist", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0042A", 4000)),
      weekShort: "W38",
      linePlaiting: null,
      redzoneRuns: [run("FV0042A", 3600, "2026-09-08T06:00:00")],
      now: NOW,
    });
    const t = m.get("0042")!;
    expect(t.plannedTarget).toBe(4000);
    expect(t.actuals).toBe(3600);
    expect(t.source).toBe("Forecast-Gesamt / Redzone");
  });

  it("ohne Ist-Zahl → kein Eintrag", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0001A", 3000)),
      weekShort: "W38",
      linePlaiting: linePlaiting({ recipeCode: "FV0001A", plannedPortions: 3000, actualPortions: 0 }),
      redzoneRuns: [], now: NOW,
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

  it("Redzone-Ist deutlich über Ziel → verworfen (Mehr-Run-Meal, nicht zum 1. Run passend)", () => {
    const m = buildRtiExternalTargets({
      data: data(wr("FV0001A", 3000)),
      weekShort: "W38",
      linePlaiting: null,
      redzoneRuns: [run("FV0001A", 4200, "2026-09-08T06:00:00")], // > 3000×1.05
      now: NOW,
    });
    expect(m.has("0001")).toBe(false);
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

  it("ohne weekShort → leer", () => {
    expect(buildRtiExternalTargets({
      data: data(wr("FV0001A", 3000)), weekShort: "", linePlaiting: null, redzoneRuns: [], now: NOW,
    }).size).toBe(0);
  });
});
