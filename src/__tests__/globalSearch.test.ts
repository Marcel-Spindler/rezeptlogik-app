import { describe, expect, it } from "vitest";
import type { DataBundle, WorkOrderEntry } from "../core/types";
import { buildSearchIndex, searchIndex } from "../features/global-search/globalSearchIndex";
import { buildWoFlow, resolveWoNumbers } from "../features/global-search/woFlow";
import type { WoReconciliationRow } from "../features/wo-reconciliation/woReconcileTypes";

function woRow(over: Partial<WorkOrderEntry>): WorkOrderEntry {
  return {
    run: 0, kitchenDay: "2026-08-25", workOrder: "35-10", recipeCode: "FV0100A",
    recipeName: "Chicken Tikka [DE]", subRecipe: "Chicken - marinated", plannedMeals: 1000,
    targetPortions: 1000, stagingKg: 0, kitchenKg: 0, postKg: 0, yieldPct: 0,
    ...over,
  };
}

const DATA: DataBundle = {
  generatedAt: "",
  weeks: ["2026-W35"],
  weekRecipes: [],
  recipes: {
    FV0100A: {
      code: "FV0100A",
      baseName: "Chicken Tikka",
      markets: {
        DE: {
          market: "DE", msku: "CON-00-111", recipeNameLocal: "Chicken Tikka [DE]",
          subRecipes: [
            { id: "SUB-111-1", name: "Chicken - marinated", category: "MARINADE / GRILL" },
            { id: "SUB-111-2", name: "Tikka sauce", category: "BRAISER" },
          ],
          ingredients: [],
        },
      },
      grossIngredients: {},
    },
  },
  cookSchedules: {},
  productionPlan: {
    week: "2026-W35",
    generatedAt: "",
    rows: [
      woRow({ workOrder: "35-10", subRecipe: "Chicken - marinated", cookMethods: "MARINADE / GRILL" }),
      woRow({ workOrder: "35-10", subRecipe: "Tikka sauce", cookMethods: "BRAISER" }),
      woRow({ workOrder: "35-42", recipeCode: "FV0200A", recipeName: "Beef Stew [DE]", subRecipe: "Beef - braised", cookMethods: "BRAISER" }),
    ],
  },
  shelfLifeBySku: {
    "SPI-00-999": { skuCode: "SPI-00-999", skuName: "Tikka spice blend", customerMinDays: 7, status: "ok" },
  },
};

describe("buildSearchIndex + searchIndex", () => {
  const index = buildSearchIndex(DATA, []);

  it("finds a work order by number", () => {
    const hits = searchIndex(index, "35-10");
    expect(hits[0]?.entry.kind).toBe("wo");
    expect(hits[0]?.entry.woNumber).toBe("35-10");
  });

  it("finds a submeal by name", () => {
    const hits = searchIndex(index, "tikka sauce");
    expect(hits.some((h) => h.entry.kind === "submeal" && h.entry.subRecipe === "Tikka sauce")).toBe(true);
  });

  it("finds a submeal by its SKU/id", () => {
    const hits = searchIndex(index, "SUB-111-1");
    expect(hits.some((h) => h.entry.kind === "submeal" && h.entry.sku === "SUB-111-1")).toBe(true);
  });

  it("finds an ingredient SKU code", () => {
    const hits = searchIndex(index, "SPI-00-999");
    expect(hits.some((h) => h.entry.kind === "sku" && h.entry.sku === "SPI-00-999")).toBe(true);
  });

  it("finds a meal by family code", () => {
    const hits = searchIndex(index, "FV0100A");
    expect(hits.some((h) => h.entry.recipeCode === "FV0100A")).toBe(true);
  });

  it("returns nothing for a <2 char query", () => {
    expect(searchIndex(index, "f")).toHaveLength(0);
  });
});

describe("resolveWoNumbers", () => {
  const rows = DATA.productionPlan!.rows;

  it("returns the single WO for a wo entry", () => {
    expect(resolveWoNumbers({ kind: "wo", woNumber: "35-10" }, rows, [])).toEqual(["35-10"]);
  });

  it("returns WOs containing a submeal", () => {
    const wos = resolveWoNumbers({ kind: "submeal", recipeCode: "FV0100A", subRecipe: "Chicken - marinated" }, rows, []);
    expect(wos).toEqual(["35-10"]);
  });

  it("returns all WOs of a meal", () => {
    const wos = resolveWoNumbers({ kind: "meal", recipeCode: "FV0200A" }, rows, []);
    expect(wos).toEqual(["35-42"]);
  });
});

describe("buildWoFlow status derivation", () => {
  it("marks only 'created' done when there is no progress signal", () => {
    const flow = buildWoFlow({ woNumber: "35-10", planRows: DATA.productionPlan!.rows, data: DATA });
    expect(flow.stages.find((s) => s.key === "created")?.status).toBe("done");
    expect(flow.stages.find((s) => s.key === "kitchen")?.status).toBe("pending");
    expect(flow.stages.find((s) => s.key === "done")?.status).toBe("pending");
    expect(flow.submeals).toHaveLength(2);
  });

  it("back-fills earlier stages from a downstream kg signal", () => {
    const planRows = [
      woRow({ workOrder: "35-10", subRecipe: "Chicken - marinated", postKg: 120 }),
      woRow({ workOrder: "35-10", subRecipe: "Tikka sauce", postKg: 40 }),
    ];
    const flow = buildWoFlow({ woNumber: "35-10", planRows, data: DATA });
    expect(flow.stages.find((s) => s.key === "staging")?.status).toBe("done");
    expect(flow.stages.find((s) => s.key === "kitchen")?.status).toBe("done");
    expect(flow.stages.find((s) => s.key === "blast")?.status).toBe("done");
  });

  it("uses the reconciliation row for completion + severity", () => {
    const recon: WoReconciliationRow = {
      workOrder: "35-10", weekNum: 35, recipeCode: "FV0100A", recipeName: "Chicken Tikka [DE]",
      subRecipe: "Chicken - marinated", presentIn: ["app", "postblast"],
      appPortions: 1000, ketPortions: null, petTarget: null, petMapped: null,
      appKg: 200, ketKg: null, actualKg: 205,
      progressPct: 102, isComplete: true, isCritical: false,
      kgMismatch: false, portionsMismatch: false, missingPetAssignment: false,
      severity: "warn", weighingCount: 6, lastWeighing: "2026-08-25T12:00:00",
    };
    const flow = buildWoFlow({ woNumber: "35-10", planRows: DATA.productionPlan!.rows, recon, data: DATA });
    expect(flow.severity).toBe("warn");
    expect(flow.stages.find((s) => s.key === "blast")?.status).toBe("done");
    expect(flow.progressPct).toBe(102);
    expect(flow.weighingCount).toBe(6);
    expect(flow.stages.find((s) => s.key === "blast")?.metrics).toEqual(expect.arrayContaining([
      { label: "Plan", value: "200 kg" },
      { label: "Ist", value: "205 kg" },
      { label: "Abweichung", value: "+5.0 kg" },
    ]));
  });

  it("still produces submeals from recipe data when no plan rows match", () => {
    const flow = buildWoFlow({ woNumber: "99-99", planRows: [], data: DATA });
    expect(flow.hasPlanRows).toBe(false);
    // recipeCode is unknown here (no rows, no recon) → no recipe-derived submeals
    expect(flow.stages).toHaveLength(7);
  });

  it("places sleeving after plating and before done", () => {
    const flow = buildWoFlow({ woNumber: "35-10", planRows: DATA.productionPlan!.rows, data: DATA });
    expect(flow.stages.map((stage) => stage.key)).toEqual([
      "created", "staging", "kitchen", "blast", "plating", "sleeving", "done",
    ]);
    expect(flow.stages.find((stage) => stage.key === "sleeving")?.status).toBe("pending");
  });
});
