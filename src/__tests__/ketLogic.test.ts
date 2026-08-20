import { describe, expect, it } from "vitest";
import type { DataBundle } from "../core/types";
import type { KetRow } from "../features/ket-plan/ketTypes";
import { calcBatch, parseKetCsv, parseSortKey } from "../features/ket-plan/ketLogic";
import { buildPdf } from "../features/ket-plan/ketPdf";
import { buildWoInstructionContext, orderCookingMethods } from "../features/ket-plan/woInstructionBot";
import { classify } from "../features/ket-plan/factorRules";

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
    expect(calc.perBatchKg).toBe(40);   // 200kg gleichmäßig auf 5 Batches verteilt, kein Rest-Batch
    expect(calc.remainderKg).toBe(0);
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

  it("deduplicates the same station when it is reported by multiple sources", () => {
    const calc = calcBatch(
      { ...row, cookMethods: ["OVEN"] },
      {},
      { ...data, processSpecs: {
        "SUB-001": {
          subRecipeId: "SUB-001",
          name: "Test sauce",
          primaryStation: "OVEN",
          batchSizeKg: 50,
          minutesPerBatch: {},
          holdTimeMin: {},
        },
      } },
      { equipment: "OVEN", capacityKg: 45 },
    );

    expect(calc.resolvedCookMethods.filter((m) => m === "OVEN")).toHaveLength(1);
    expect(calc.equipBatches.filter((b) => b.equip === "OVEN")).toHaveLength(1);
    expect(calc.primaryEquip).toBe("OVEN");
  });

  it("drops numeric quantities from the instruction context so the model stays concise", () => {
    const context = JSON.parse(buildWoInstructionContext({
      ...row,
      recipeCode: "FV0001A",
      subRecipeName: "Test sauce",
    }, {
      ...({
        totalKg: 120,
        equipBatches: [],
        primaryEquip: "OVEN",
        capacityKg: 60,
        batches: 2,
        perBatchKg: 60,
        remainderKg: 0,
        resolvedCookMethods: ["OVEN"],
        manualEquipment: null,
        ingredients: [],
        recipeFound: true,
        subRecipeFound: true,
        cookingInstructions: null,
        subRecipeInstructions: "Mix 500 g sauce and hold at 2°C.",
        subRecipeInstructionsDE: "Mische 500 g Sauce und halte bei 2°C.",
        subRecipeInstructionsGermanFallback: false,
        rti: false,
        neverBatch: false,
        factorCapacityKg: null,
        factorBatches: null,
        factorBatchQtyKg: null,
        factorFallbackCapacity: false,
        readyMade: false,
        allergensContains: ["Milk"],
      } as any),
    }));

    expect(context.recipeName).toBe("Test recipe");
    expect(JSON.stringify(context)).not.toMatch(/\d/);
    expect(context.sourceInstructionEnglish).toBe("Mix sauce and hold at °C.");
    expect(context.sourceInstructionGerman).toBe("Mische Sauce und halte bei °C.");
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
        remainderKg: 0,
        resolvedCookMethods: [],
        manualEquipment: null,
        ingredients: [],
        recipeFound: true,
        subRecipeFound: true,
        cookingInstructions: null,
        subRecipeInstructions: null,
        subRecipeInstructionsDE: null,
        subRecipeInstructionsGermanFallback: false,
        rti: false,
        neverBatch: false,
        factorCapacityKg: null,
        factorBatches: null,
        factorBatchQtyKg: null,
        factorFallbackCapacity: false,
        readyMade: false,
        allergensContains: [],
        chillerAssignment: null,
        uomWarnings: [],
        factorOverridesEquip: false,
      }]]),
      {},
      "WO test",
      null,
      { [row.key]: { english: "Mix thoroughly.", german: "Gründlich mischen.", status: "generated" } },
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
      remainderKg: 0,
      resolvedCookMethods: ["OVEN", "SPICE PORTIONING"],
      manualEquipment: null,
      ingredients: [],
      recipeFound: true,
      subRecipeFound: true,
      cookingInstructions: null,
      subRecipeInstructions: null,
      subRecipeInstructionsDE: null,
      subRecipeInstructionsGermanFallback: false,
      rti: false,
      neverBatch: false,
      factorCapacityKg: null,
      factorBatches: null,
      factorBatchQtyKg: null,
      factorFallbackCapacity: false,
      readyMade: false,
      allergensContains: [],
      chillerAssignment: null,
      uomWarnings: [],
      factorOverridesEquip: false,
    };
    const secondRow = { ...row, key: "wo::34-2", woNumber: "34-2" };
    const pdf = buildPdf([row, secondRow], new Map([[row.key, calc], [secondRow.key, calc]]), {}, "WO test");
    const context = JSON.parse(buildWoInstructionContext(row, calc));

    expect(pdf).toContain("page-break-before:always");
    expect(context.processFlow).toEqual(["SPICE PORTIONING", "OVEN"]);
  });

  it("keeps every cooking method exactly once in process order", () => {
    expect(orderCookingMethods(["OVEN", "SPICE PORTIONING", "OVEN", "BRAISER", "CUSTOM STATION"]))
      .toEqual(["SPICE PORTIONING", "BRAISER", "OVEN", "CUSTOM STATION"]);
  });
});

describe("UoM handling", () => {
  it("converts ml and l correctly to kg-equivalent", () => {
    const mlData = {
      ...data,
      structures: {
        FV0001A: {
          ...data.structures!.FV0001A,
          markets: {
            DE: [{
              id: "SUB-001",
              name: "Test sauce",
              categories: "",
              subRecipes: [],
              ingredients: [
                { id: "ING-ML", name: "Water", grossQty: 500, netQty: 500, uom: "ml" },
                { id: "ING-L", name: "Oil", grossQty: 2, netQty: 2, uom: "l" },
              ],
            }],
          },
        },
      },
    } as DataBundle;
    const calc = calcBatch(row, {}, mlData);
    // 500ml * 100 portions = 50000ml = 50kg
    expect(calc.ingredients.find(i => i.name === "Water")?.totalKg).toBe(50);
    // 2l * 100 portions = 200l = 200kg
    expect(calc.ingredients.find(i => i.name === "Oil")?.totalKg).toBe(200);
  });

  it("handles piece-based UoMs without adding to totalKg", () => {
    const pcsData = {
      ...data,
      structures: {
        FV0001A: {
          ...data.structures!.FV0001A,
          markets: {
            DE: [{
              id: "SUB-001",
              name: "Test sauce",
              categories: "",
              subRecipes: [],
              ingredients: [
                { id: "ING-PCS", name: "Eggs", grossQty: 2, netQty: 2, uom: "pcs" },
                { id: "ING-KG", name: "Flour", grossQty: 0.5, netQty: 0.5, uom: "kg" },
              ],
            }],
          },
        },
      },
    } as DataBundle;
    const calc = calcBatch(row, {}, pcsData);
    const eggs = calc.ingredients.find(i => i.name === "Eggs")!;
    expect(eggs.totalKg).toBe(0);
    expect(eggs.totalPcs).toBe(200); // 2 * 100
    // totalKg should only include flour: 0.5 * 100 = 50
    expect(calc.totalKg).toBe(50);
  });

  it("warns about unknown UoMs", () => {
    const unknownData = {
      ...data,
      structures: {
        FV0001A: {
          ...data.structures!.FV0001A,
          markets: {
            DE: [{
              id: "SUB-001",
              name: "Test sauce",
              categories: "",
              subRecipes: [],
              ingredients: [
                { id: "ING-OZ", name: "Butter", grossQty: 4, netQty: 4, uom: "oz" },
              ],
            }],
          },
        },
      },
    } as DataBundle;
    const calc = calcBatch(row, {}, unknownData);
    expect(calc.uomWarnings.length).toBe(1);
    expect(calc.uomWarnings[0]).toContain("oz");
  });
});

describe("Factor rules — sauce vs. meat priority", () => {
  it("classifies 'Chicken Teriyaki Sauce' as sauce, not meat", () => {
    const result = classify("Chicken Teriyaki Sauce", ["BRAISER"]);
    expect(result.rti).toBe(false);
    expect(result.capacityKg).toBe(105); // Sauce capacity
  });

  it("classifies 'Salmon Gravy' as sauce, not fish", () => {
    const result = classify("Salmon Gravy", ["BRAISER"]);
    expect(result.capacityKg).toBe(105);
  });

  it("still classifies plain 'Chicken Breast' as NO_BATCH", () => {
    const result = classify("Chicken Breast", ["GRILL"]);
    expect(result.capacityKg).toBe(999999);
  });
});

describe("parseSortKey edge cases", () => {
  it("returns 0 for invalid date strings", () => {
    expect(parseSortKey("not-a-date")).toBe(0);
    expect(parseSortKey("")).toBe(0);
  });

  it("handles valid date correctly", () => {
    const key = parseSortKey("2026-08-12 - 2");
    expect(key).toBeGreaterThan(0);
    expect(key % 10).toBe(2); // shift
  });
});

describe("parseKetCsv", () => {
  it("returns warnings for malformed CSV rows", () => {
    const csv = `Work Order Number,Recipe Name,Date Needed,Sub Recipe Name,Target Portions,Cook Methods
WO-001,FV0001A Test,2026-08-12,Sauce,100,BRAISER
"broken,row`;
    const { rows, warnings } = parseKetCsv(csv);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("parses valid CSV without warnings", () => {
    const csv = `Work Order Number,Recipe Name,Date Needed,Sub Recipe Name,Target Portions,Cook Methods
WO-001,FV0001A Test,2026-08-12,Sauce,100,BRAISER`;
    const { rows, warnings } = parseKetCsv(csv);
    expect(rows.length).toBe(1);
    expect(warnings.length).toBe(0);
    expect(rows[0].woNumber).toBe("WO-001");
  });
});
