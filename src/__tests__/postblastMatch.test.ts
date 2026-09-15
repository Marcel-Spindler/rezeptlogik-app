import { describe, expect, it } from "vitest";
import { matchPostblastToWorkOrders } from "../features/gsheet-monitor/postblastMatch";
import type { PostblastData, RtiData } from "../features/gsheet-monitor/gsheetTypes";
import type { ProductionPlan } from "../core/types";

function productionPlan(): ProductionPlan {
  return {
    week: "2026-W38",
    generatedAt: "",
    rows: [{
      run: 1, kitchenDay: "2026-09-09", workOrder: "38-21", recipeCode: "FV1169A",
      recipeName: "Salmon and sweet soy dressing", subRecipe: "Ginger Cabbage",
      plannedMeals: 800, stagingKg: 0, kitchenKg: 0, postKg: 100, yieldPct: 0,
    }],
  };
}

function postblast(weighedKg: number): PostblastData {
  return {
    entries: [{ timestamp: "", date: "", workOrder: "38-21", subRecipeName: "Ginger Cabbage", weightKg: weighedKg }],
    byWorkOrder: new Map([["38-21", [{ timestamp: "", date: "", workOrder: "38-21", subRecipeName: "Ginger Cabbage", weightKg: weighedKg }]]]),
    bySubRecipe: new Map(),
    totalWeightKg: weighedKg,
    lastEntry: null,
    lastUpdated: Date.now(),
  };
}

// Live an KW38 verifiziert: das RTI-Sheet tippt WO-Nummern mit führender Null
// ("38-021"), Produktionsplan/Post-Blast konsequent ohne ("38-21") — dieselbe
// physische Work Order, zwei verschiedene Schreibweisen im selben Datensatz.
function rtiWithPaddedWorkOrder(): RtiData {
  return {
    week: "W38",
    meals: [{
      mealCode: "FV1169A", mealName: "Salmon and sweet soy dressing",
      plannedTarget: 7343, actuals: 6496, delta: -847, deltaPct: -11.53,
      subRecipes: [{
        workOrder: "38-021", subRecipeName: "Ginger Cabbage",
        platingHoldingKg: 42, weighedKg: 170, gramPerMeal: 60,
        availableMealcount: 2834, minimumNeed: 1987, backfillMeals: 0,
        shortagePct: 27.06, status: "done", isBackfillCandidate: false,
      }],
    }],
    lastUpdated: Date.now(),
  };
}

describe("matchPostblastToWorkOrders — RTI-Zuordnung trotz WO-Padding-Unterschied", () => {
  it("findet den RTI-Status/Holding-Puffer, obwohl RTI die WO mit führender Null führt", () => {
    const { matched } = matchPostblastToWorkOrders(postblast(50), null, productionPlan(), rtiWithPaddedWorkOrder());
    expect(matched).toHaveLength(1);
    expect(matched[0].rtiStatus).toBe("done");
    expect(matched[0].platingHoldingKg).toBe(42);
  });

  it("liefert kein RTI-Match, wenn wirklich unterschiedliche WOs gemeint sind", () => {
    const rti = rtiWithPaddedWorkOrder();
    rti.meals[0].subRecipes[0].workOrder = "38-099"; // andere WO, nicht nur anders gepaddet
    const { matched } = matchPostblastToWorkOrders(postblast(50), null, productionPlan(), rti);
    expect(matched[0].rtiStatus).toBeNull();
    expect(matched[0].platingHoldingKg).toBe(0);
  });
});
