import { describe, expect, it } from "vitest";
import type { DataBundle } from "../core/types";
import type { KetRow } from "../features/ket-plan/ketTypes";
import { calcBatch } from "../features/ket-plan/ketLogic";
import { buildPdf } from "../features/ket-plan/ketPdf";
import { buildWoInstructionContext, orderCookingMethods } from "../features/ket-plan/woInstructionBot";

const row: KetRow = {
  key: "wo::34-1",
  dateNeeded: "2026-08-12 - 1",
  shift: "1",
  woNumber: "34-1",
  recipeId: "REC-001",
  recipeCode: "FV0001A",
  recipeName: "Test recipe",
  subRecipeName: "Test sauce",
  cookMethods: [],
  woCookedPortions: null,
  targetPortions: 100,
  cookedPortionsExcess: null,
  stagingStatus: "",
  stagingComment: "",
  kitchenStatus: "",
  unlockedEta: "",
  workOrderComment: "",
};

const data = {
  generatedAt: "2026-08-14T00:00:00Z",
  weeks: ["2026-W33"],
  weekRecipes: [],
  recipes: {
    FV0001A: {
      code: "FV0001A",
      baseName: "Test recipe",
      markets: {},
      grossIngredients: { DE: [] },
    },
  },
  cookSchedules: {},
  structures: {
    FV0001A: {
      code: "FV0001A",
      recipeId: "REC-001",
      name: "Test recipe",
      markets: {
        DE: [{
          id: "SUB-001",
          name: "Test sauce",
          categories: "",
          subRecipes: [],
          ingredients: [{
            id: "ING-001",
            name: "Sauce base",
            grossQty: 2,
            netQty: 2,
            uom: "kg",
          }],
        }],
      },
    },
  },
  processSpecs: {
    "SUB-001": {
      subRecipeId: "SUB-001",
      name: "Test sauce",
      primaryStation: "OVEN",
      batchSizeKg: 60,
      minutesPerBatch: {},
      holdTimeMin: {},
    },
  },
  equipmentBible: [],
} as DataBundle;

describe("calcBatch equipment resolution", () => {
  it("uses ProcessSpec equipment when the WO has no cook methods", () => {
    const calc = calcBatch(row, {}, { ...data, processSpecs: {
      "SUB-001": {
        subRecipeId: "SUB-001",
        name: "Test sauce",
        primaryStation: "OVEN",
        batchSizeKg: 45,
        minutesPerBatch: {},
        holdTimeMin: {},
      },
    } });

    expect(calc.resolvedCookMethods).toContain("OVEN");
    expect(calc.primaryEquip).toBe("OVEN");
    expect(calc.batches).toBe(5);
    expect(calc.perBatchKg).toBe(40);
  });

  it("uses a manual equipment override when no automatic source exists", () => {
    const calc = calcBatch(
      row,
      {},
      { ...data, processSpecs: {} },
      { equipment: "CUSTOM MIXER", capacityKg: 25 },
    );

    expect(calc.primaryEquip).toBe("CUSTOM MIXER");
    expect(calc.capacityKg).toBe(25);
    expect(calc.batches).toBe(8);
    expect(calc.manualEquipment?.equipment).toBe("CUSTOM MIXER");
  });

  it("prints English and German instruction blocks in the WO PDF", () => {
    const pdf = buildPdf(
      [row],
      new Map([[row.key, {
        totalKg: 10,
        equipBatches: [],
        primaryEquip: null,
        capacityKg: null,
        batches: 0,
        perBatchKg: 0,
        resolvedCookMethods: [],
        manualEquipment: null,
        ingredients: [],
        recipeFound: true,
        subRecipeFound: true,
        cookingInstructions: null,
        subRecipeInstructions: "Mix thoroughly.",
        subRecipeInstructionsDE: "Gründlich mischen.",
        subRecipeInstructionsGermanFallback: false,
      }]]),
      {},
      "WO test",
    );

    expect(pdf).toContain("English");
    expect(pdf).toContain("Deutsch");
    expect(pdf).toContain("Mix thoroughly.");
    expect(pdf).toContain("Gründlich mischen.");
  });

  it("prints each WO card on its own page and sends stations in process order", () => {
    const calc = {
      totalKg: 10,
      equipBatches: [],
      primaryEquip: null,
      capacityKg: null,
      batches: 0,
      perBatchKg: 0,
      resolvedCookMethods: ["OVEN", "SPICE PORTIONING"],
      manualEquipment: null,
      ingredients: [],
      recipeFound: true,
      subRecipeFound: true,
      cookingInstructions: null,
      subRecipeInstructions: null,
      subRecipeInstructionsDE: null,
      subRecipeInstructionsGermanFallback: false,
    };
    const secondRow = { ...row, key: "wo::34-2", woNumber: "34-2" };
    const pdf = buildPdf([row, secondRow], new Map([[row.key, calc], [secondRow.key, calc]]), {}, "WO test");
    const context = JSON.parse(buildWoInstructionContext(row, calc));

    expect(pdf).toContain("page-break-before:always");
    expect(context.cookMethods).toEqual(["SPICE PORTIONING", "OVEN"]);
  });

  it("keeps every cooking method exactly once in process order", () => {
    expect(orderCookingMethods(["OVEN", "SPICE PORTIONING", "OVEN", "BRAISER", "CUSTOM STATION"]))
      .toEqual(["SPICE PORTIONING", "BRAISER", "OVEN", "CUSTOM STATION"]);
  });
});
