import { describe, expect, it } from "vitest";
import type { DataBundle } from "../core/types";
import type { KetRow } from "../features/ket-plan/ketTypes";
import { buildLogistikRundmailText, buildLogistikRundmailHtml } from "../features/vorstellungsplan/logistikRundmail";

const row: KetRow = {
  key: "test",
  dateNeeded: "2026-09-07 - 1",
  shift: "1",
  woNumber: "WO-100",
  recipeId: "recipe",
  recipeCode: "FV100",
  recipeName: "Test Recipe",
  subRecipeName: "Test Component",
  cookMethods: ["OVEN"],
  woCookedPortions: 100,
  targetPortions: 100,
  cookedPortionsExcess: null,
  stagingStatus: "Not Started",
  stagingComment: "",
  kitchenStatus: "Not Started",
  unlockedEta: "",
  workOrderComment: "",
};

const data = {
  recipes: {
    FV100: { code: "FV100", baseName: "Test Recipe", markets: {}, grossIngredients: { DE: [{ subRecipe1: "Test Component", ingredient: "Test ingredient", ingredientId: "SKU-1", ingredientCategory: "PHF", grossQuantityPerPortion: 200, uom: "grams" }] } },
  },
} as unknown as DataBundle;

describe("buildLogistikRundmailText", () => {
  it("erstellt eine kurze Frischemail mit kg-Mengen, Veggie/Protein-Split und Küchenkette", () => {
    const text = buildLogistikRundmailText([row], data, "2026-W37", "Lauch/Porree bitte separat prüfen.", {});

    expect(text).toContain("Frische-Einkauf 2026-W37");
    expect(text).toContain("WOs: WO-100");
    expect(text).toContain("Montag, 07.09.:");
    expect(text).toContain("Veggie:");
    expect(text).toContain("  - 20 kg | Test ingredient (SKU-1) | bis So., 06.09. | WOs WO-100");
    expect(text).toContain("KÜCHE | Reihenfolge");
    expect(text).toContain("(Kochstart):");
    expect(text).toContain("Veggie: WO-100 Test Component [OVEN]");
    expect(text).toContain("SONDERHINWEIS");
  });

  it("berücksichtigt überall nur Sonntag und Montag", () => {
    const sundayRow: KetRow = { ...row, key: "sunday", woNumber: "WO-050", dateNeeded: "2026-09-06 - 1", targetPortions: 50 };
    const tuesdayRow: KetRow = { ...row, key: "tuesday", woNumber: "WO-200", dateNeeded: "2026-09-08 - 1", targetPortions: 100 };
    const text = buildLogistikRundmailText([sundayRow, row, tuesdayRow], data, "2026-W37", "", {});

    expect(text).toContain("Sonntag, 06.09.:");
    expect(text).toContain("Montag, 07.09.:");
    expect(text).toContain("- 10 kg | Test ingredient (SKU-1)");
    expect(text).toContain("- 20 kg | Test ingredient (SKU-1)");
    expect(text).not.toContain("WO WO-200");
  });

  it("zieht direkte Zutaten ohne Submeal-Link zusammen", () => {
    const directRow: KetRow = { ...row, subRecipeName: "FA-DE Cheese, White Cheddar, Shredded /Käse, weißer Cheddar, gerieben" };
    const directData = { recipes: { FV100: { ...data.recipes.FV100, grossIngredients: { DE: [{ ingredient: "FA-DE Cheese, White Cheddar, Shredded /Käse, weißer Cheddar, gerieben", ingredientId: "DAI-1", ingredientCategory: "DAI", grossQuantityPerPortion: 150, uom: "g" }] } } } } as unknown as DataBundle;
    const text = buildLogistikRundmailText([directRow], directData, "2026-W37", "", {});

    expect(text).toContain("- 15 kg | FA-DE Cheese, White Cheddar, Shredded /Käse, weißer Cheddar, gerieben (DAI-1)");
    expect(text).not.toContain("Prüfen:");
  });

  it("filtert verlinkte Nicht-PHF-Zutaten aus", () => {
    const noFreshData = { recipes: { FV100: { ...data.recipes.FV100, grossIngredients: { DE: [{ subRecipe1: "Test Component", ingredient: "Dry ingredient", ingredientId: "DRY-1", ingredientCategory: "DRY", grossQuantityPerPortion: 0.2, uom: "kg" }] } } } } as unknown as DataBundle;
    const text = buildLogistikRundmailText([row], noFreshData, "2026-W37", "", {});

    expect(text).toContain("Keine Frischeartikel");
    expect(text).not.toContain("Dry ingredient");
  });
});

describe("buildLogistikRundmailHtml", () => {
  it("erzeugt HTML mit Veggie/Protein-Chips und collapsible Details", () => {
    const html = buildLogistikRundmailHtml([row], data, "2026-W37", "", {});

    expect(html).toContain("EINKAUF");
    expect(html).toContain("Veggie");
    expect(html).toContain("<details");
    expect(html).toContain("KÜCHE");
    expect(html).toContain("Kochstart");
    expect(html).toContain("OVEN");
  });
});
