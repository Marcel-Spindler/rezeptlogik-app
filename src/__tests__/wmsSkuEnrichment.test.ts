import { describe, expect, it } from "vitest";
import { buildSkuInfoIndex, getSkuDisplayLabel } from "../wmsSkuEnrichment";
import type { DataBundle } from "../types";

describe("wms SKU enrichment", () => {
  it("prefers week-plan names over raw SKU codes", () => {
    const data: DataBundle = {
      generatedAt: "",
      weeks: ["2026-W20"],
      weekRecipes: [{
        hfWeek: "2026-W20",
        weekShort: "W20",
        code: "TEST001",
        recipeName: "Test recipe",
        preference: "P+",
        slot: {},
        verdenVolume: { BENL: 10, DKSE: 0, DE: 0 },
        totalVerdenVolume: 10,
        productionBuffer: 0,
      }],
      recipes: {
        TEST001: {
          code: "TEST001",
          baseName: "Test recipe",
          markets: {
            BENL: {
              market: "BENL",
              msku: "MSKU-1",
              recipeNameLocal: "Test recipe local",
              subRecipes: [{ id: "SUB-001", name: "Sub recipe", category: "HAND MIX", yieldUom: "grams" }],
              ingredients: [{ name: "Tomato", ingredientId: "ING-001", quantityPerPortion: 1, uom: "grams" }],
            },
          },
          grossIngredients: {},
        },
      },
      cookSchedules: {},
      shelfLifeBySku: {
        "ING-002": { skuCode: "ING-002", skuName: "Shelf item", category: "PRO", customerMinDays: 5, status: "ok" },
      },
      structures: {},
    };

    const index = buildSkuInfoIndex(data, "2026-W20");

    expect(getSkuDisplayLabel("MSKU-1", index)).toBe("Test recipe local");
    expect(getSkuDisplayLabel("SUB-001", index)).toBe("Sub recipe");
    expect(getSkuDisplayLabel("ING-001", index)).toBe("Tomato");
    expect(getSkuDisplayLabel("ING-002", index)).toBe("Shelf item");
  });

  it("falls back to the raw SKU when no human-readable name exists", () => {
    const index = buildSkuInfoIndex({
      generatedAt: "",
      weeks: [],
      weekRecipes: [],
      recipes: {},
      cookSchedules: {},
      shelfLifeBySku: {},
      structures: {},
    }, "2026-W20");

    expect(getSkuDisplayLabel("UNKNOWN-SKU", index)).toBe("UNKNOWN-SKU");
  });
});
