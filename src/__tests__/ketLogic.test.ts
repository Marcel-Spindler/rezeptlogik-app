import { describe, expect, it } from "vitest";
import type { DataBundle } from "../core/types";
import type { BatchCalc, KetRow } from "../features/ket-plan/ketTypes";
import { calcBatch, parseKetCsv, parseSortKey, rowInstructionStatus } from "../features/ket-plan/ketLogic";
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

  it("includes computed batch weights but omits the contaminated recipe-import instruction text", () => {
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
    expect(context.batches).toBe(2);
    expect(context.perBatchKg).toBe(60);
    expect(context.totalKg).toBe(120);
    expect(context.sourceInstructionEnglish).toBeUndefined();
    expect(context.sourceInstructionGerman).toBeUndefined();
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
        components: [],
        gnTraySummary: [],
        scoopInfo: null,
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
      components: [],
      gnTraySummary: [],
      scoopInfo: null,
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

describe("calcBatch composite sub-recipes", () => {
  // Mirrors the real "Stuffed Pepper Casserole Base-V2" WMS structure: the WO's
  // sub-recipe is itself a composite of two children on different equipment
  // (e.g. "Ground Beef - cooked" [BRAISER] + "...Vegetable Mix" [OVEN]), each
  // of which needs its own cooking instruction and its own batch math — NOT
  // the combined total applied to both pieces of equipment.
  const compositeRow: KetRow = {
    ...row,
    recipeCode: "FV0002A",
    subRecipeName: "Composite Base",
  };
  const compositeData = {
    ...data,
    recipes: { FV0002A: { code: "FV0002A", baseName: "Composite recipe", markets: {}, grossIngredients: { DE: [] } } },
    structures: {
      FV0002A: {
        code: "FV0002A",
        recipeId: "REC-002",
        name: "Composite recipe",
        markets: {
          DE: [{
            id: "SUB-BASE",
            name: "Composite Base",
            categories: "BRAISER",
            subRecipes: [
              {
                id: "SUB-MEAT",
                name: "Meat Part",
                categories: "BRAISER",
                subRecipes: [],
                ingredients: [{ id: "ING-MEAT", name: "Ground meat", grossQty: 1, netQty: 1, uom: "kg", allergen: "SOJA" }],
              },
              {
                id: "SUB-VEG",
                name: "Veg Part",
                categories: "OVEN",
                subRecipes: [],
                ingredients: [{ id: "ING-VEG", name: "Chopped veg", grossQty: 0.5, netQty: 0.5, uom: "kg" }],
              },
            ],
            ingredients: [{ id: "ING-SPICE", name: "Shared spice mix", grossQty: 0.1, netQty: 0.1, uom: "kg" }],
          }],
        },
      },
    },
    processSpecs: {},
  } as DataBundle;

  it("splits a composite sub-recipe into per-equipment components with independent batch math", () => {
    const calc = calcBatch(compositeRow, { BRAISER: 40, OVEN: 20 }, compositeData);

    // Gesamt-Rohware bleibt der volle kombinierte Wert (100 + 50 + 10 Zutaten-Anteil).
    expect(calc.totalKg).toBeCloseTo(160, 5);

    expect(calc.components).toHaveLength(2);
    const meat = calc.components.find((c) => c.name === "Meat Part")!;
    const veg = calc.components.find((c) => c.name === "Veg Part")!;
    expect(meat).toBeTruthy();
    expect(veg).toBeTruthy();

    // Jede Komponente rechnet mit ihrer EIGENEN Menge, nicht mit den kombinierten 160 kg.
    expect(meat.totalKg).toBeCloseTo(100, 5);
    expect(meat.resolvedCookMethods).toEqual(["BRAISER"]);
    expect(meat.batches).toBe(3); // ceil(100 / 40)
    expect(meat.perBatchKg).toBeCloseTo(100 / 3, 2);

    expect(veg.totalKg).toBeCloseTo(50, 5);
    expect(veg.resolvedCookMethods).toEqual(["OVEN"]);
    expect(veg.batches).toBe(3); // ceil(50 / 20)
    expect(veg.perBatchKg).toBeCloseTo(50 / 3, 2);

    // Allergen einer Komponenten-Zutat bleibt bis in die Zutatentabelle erhalten
    // (zeigt in der UI/PDF direkt an der Zutat, statt nur im WO-weiten Badge).
    expect(meat.ingredients.find((i) => i.name === "Ground meat")?.allergen).toBe("SOJA");

    // Top-Level equipBatches/batches spiegeln jetzt die je-Komponente korrekt
    // berechneten Werte wider (der ursprüngliche Bug: dieselbe kombinierte
    // Gesamtmenge fälschlich auf beide Equipments angewendet).
    const topBraiser = calc.equipBatches.find((eb) => eb.equip === "BRAISER");
    const topOven = calc.equipBatches.find((eb) => eb.equip === "OVEN");
    expect(topBraiser?.batches).toBe(3);
    expect(topOven?.batches).toBe(3);
  });

  it("does not split when children share the same equipment (not a real composite)", () => {
    const sameEquipData = {
      ...compositeData,
      structures: {
        FV0002A: {
          ...compositeData.structures!.FV0002A,
          markets: {
            DE: [{
              ...compositeData.structures!.FV0002A.markets.DE![0],
              subRecipes: compositeData.structures!.FV0002A.markets.DE![0].subRecipes.map((s) => ({ ...s, categories: "BRAISER" })),
            }],
          },
        },
      },
    } as DataBundle;

    const calc = calcBatch(compositeRow, { BRAISER: 40, OVEN: 20 }, sameEquipData);
    expect(calc.components).toHaveLength(0);
  });

  it("classifies Factor rules (neverBatch/RTI/capacity) per component name, not the composite WO name", () => {
    // Regression: the WO's own subRecipeName ("Composite Base") never matches a
    // meat pattern, so classify(row.subRecipeName, ...) at the top level would
    // never flag this — but the "Meat Part" component IS beef and must be
    // recognized as neverBatch via its OWN name, same as the real
    // "Stuffed Pepper Casserole Base-V2" → "Ground Beef - cooked" case.
    const beefNamedData = {
      ...compositeData,
      structures: {
        FV0002A: {
          ...compositeData.structures!.FV0002A,
          markets: {
            DE: [{
              ...compositeData.structures!.FV0002A.markets.DE![0],
              subRecipes: [
                { ...compositeData.structures!.FV0002A.markets.DE![0].subRecipes[0], name: "Ground Beef - cooked" },
                compositeData.structures!.FV0002A.markets.DE![0].subRecipes[1],
              ],
            }],
          },
        },
      },
    } as DataBundle;

    const calc = calcBatch(compositeRow, { BRAISER: 40, OVEN: 20 }, beefNamedData);
    const beef = calc.components.find((c) => c.name === "Ground Beef - cooked")!;
    expect(beef).toBeTruthy();
    expect(beef.neverBatch).toBe(true);
    expect(beef.rti).toBe(false);
    expect(beef.factorCapacityKg).toBeNull();
  });

  it("applies a manual equipment override to a single component without affecting the others", () => {
    // OVEN bewusst NICHT in caps gesetzt: die globale Sidebar-Kapazität (caps[e])
    // hat laut effectiveCap()-Priorität immer Vorrang vor einem manuellen
    // Override — ein Override wirkt nur, wo die Sidebar für dieses Equipment
    // noch keinen Wert gesetzt hat (deckt sich mit dem bestehenden WO-weiten
    // Override-Verhalten, hier nur pro Komponente statt für die ganze WO).
    const calc = calcBatch(
      compositeRow,
      { BRAISER: 40 },
      compositeData,
      null,
      { "Veg Part": { equipment: "OVEN", capacityKg: 5 } },
    );
    const meat = calc.components.find((c) => c.name === "Meat Part")!;
    const veg = calc.components.find((c) => c.name === "Veg Part")!;

    // Veg Part: 50 kg über die manuelle 5kg-Kapazität statt der Sidebar-caps (20kg).
    expect(veg.batches).toBe(10); // ceil(50 / 5)
    expect(veg.equipBatches.find((eb) => eb.equip === "OVEN")?.capacityKg).toBe(5);

    // Meat Part bleibt unverändert bei der normalen 40kg-Kapazität.
    expect(meat.batches).toBe(3); // ceil(100 / 40)
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

describe("GN-Blech-Berechnung (resolveGnTrays)", () => {
  const gnRow: KetRow = { ...row, recipeCode: "FV0003A", subRecipeName: "Pepper Mix", targetPortions: 100 };
  const gnData = {
    ...data,
    recipes: { FV0003A: { code: "FV0003A", baseName: "Pepper Mix Recipe", markets: {}, grossIngredients: { DE: [] } } },
    structures: {
      FV0003A: {
        code: "FV0003A",
        recipeId: "REC-003",
        name: "Pepper Mix Recipe",
        markets: {
          DE: [{
            id: "SUB-PEP",
            name: "Pepper Mix",
            categories: "OVEN",
            subRecipes: [],
            // Realer Namensstil: Länderpräfix + bilingual ("EN /DE") — muss vor
            // dem Lookup bereinigt werden (siehe cleanIngredientNameForGnLookup).
            ingredients: [
              { id: "ING-PEP", name: "FA-DE Bell Peppers, Red, Diced 10mm /Paprika, rot, gewürfelt 10 mm", grossQty: 0.08, netQty: 0.08, uom: "kg" },
              { id: "ING-CHK", name: "FA-DE Chicken Breast, Boneless Skinless /Hähnchenbrust", grossQty: 0.6, netQty: 0.6, uom: "ea" },
            ],
          }],
        },
      },
    },
    processSpecs: {},
  } as DataBundle;

  it("resolves kg-based GN trays via the hardcoded capacity table, cleaning FA-DE/bilingual names first", () => {
    const calc = calcBatch(gnRow, {}, gnData);
    const pepper = calc.ingredients.find((i) => i.name.includes("Bell Peppers"))!;
    expect(pepper.totalKg).toBeCloseTo(8, 5); // 0.08 kg × 100 Portionen
    expect(pepper.gnTrays).toBe(1); // 8 kg / 8 kg pro GN 2:1 ("10mm Diced Pepper")
    expect(pepper.gnType).toBe("GN 2/1");
  });

  it("resolves piece-based GN trays from supplied tray hints", () => {
    const gnHints = {
      trayHints: [{ key: "chicken breast", pcsPerTray: 30, gnType: "GN 2/1" }],
      pieceWeightKg: new Map<string, number>(),
    };
    const calc = calcBatch(gnRow, {}, gnData, null, undefined, gnHints);
    const chicken = calc.ingredients.find((i) => i.name.includes("Chicken Breast"))!;
    expect(chicken.totalPcs).toBeCloseTo(60, 5); // 0.6 Stk × 100 Portionen
    expect(chicken.gnTrays).toBe(2); // ceil(60 / 30)
    expect(chicken.gnType).toBe("GN 2/1");
  });

  it("groups the WO-level GN tray summary by GN size instead of merging into one number", () => {
    const gnHints = {
      trayHints: [{ key: "chicken breast", pcsPerTray: 30, gnType: "GN 1/1" }],
      pieceWeightKg: new Map<string, number>(),
    };
    const calc = calcBatch(gnRow, {}, gnData, null, undefined, gnHints);
    expect(calc.gnTraySummary).toEqual(
      expect.arrayContaining([
        { gnType: "GN 1/1", trays: 2 },
        { gnType: "GN 2/1", trays: 1 },
      ]),
    );
  });

  it("never guesses — leaves gnTrays null for ingredients with no matching capacity/tray source", () => {
    const calc = calcBatch(gnRow, {}, gnData); // keine trayHints übergeben
    const chicken = calc.ingredients.find((i) => i.name.includes("Chicken Breast"))!;
    expect(chicken.gnTrays).toBeNull();
    expect(chicken.gnType).toBeNull();
  });
});

describe("rowInstructionStatus — Druck-Gate", () => {
  const has = (keys: string[]) => (k: string) => keys.includes(k);
  const composite = (...names: string[]) =>
    ({ components: names.map((name) => ({ name })) } as unknown as BatchCalc);

  it("einfache WO ohne Anweisung ist unvollständig", () => {
    expect(rowInstructionStatus(row, { components: [] }, has([]))).toEqual({
      total: 1, have: 0, complete: false, missing: ["ganze WO"],
    });
  });

  it("einfache WO mit Anweisung ist vollständig", () => {
    expect(rowInstructionStatus(row, { components: [] }, has([row.key]))).toEqual({
      total: 1, have: 1, complete: true, missing: [],
    });
  });

  it("ohne calc verhält sich wie eine einfache WO", () => {
    expect(rowInstructionStatus(row, null, has([])).complete).toBe(false);
    expect(rowInstructionStatus(row, undefined, has([row.key])).complete).toBe(true);
  });

  it("zusammengesetzte WO braucht jede eindeutige Komponente", () => {
    const calc = composite("Fleisch", "Gemüse");
    expect(rowInstructionStatus(row, calc, has([`${row.key}::Fleisch`])).missing).toEqual(["Gemüse"]);
    expect(rowInstructionStatus(row, calc, has([`${row.key}::Fleisch`, `${row.key}::Gemüse`])).complete).toBe(true);
  });

  it("dedupliziert gleichnamige Komponenten", () => {
    const calc = composite("Fleisch", "Fleisch", "Gemüse");
    const st = rowInstructionStatus(row, calc, has([`${row.key}::Fleisch`, `${row.key}::Gemüse`]));
    expect(st.total).toBe(2);
    expect(st.complete).toBe(true);
  });
});
