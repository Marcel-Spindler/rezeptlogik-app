import { describe, expect, it, vi } from "vitest";
import type { DataBundle } from "../core/types";
import {
  buildCommandItems,
  buildRecipeItems,
  buildSearchEntryItems,
  buildViewItems,
  buildWeekItems,
  matchScore,
  rankPaletteItems,
} from "../features/command-palette";
import type { PaletteItem } from "../features/command-palette";

const DATA: DataBundle = {
  generatedAt: "",
  weeks: ["2026-W35", "2026-W36", "2026-W37"],
  weekRecipes: [
    { hfWeek: "2026-W37", weekShort: "W37", code: "FV0100A", recipeName: "Chicken Tikka", preference: "P+", slot: {}, verdenVolume: { BENL: 0, DKSE: 0, DE: 0 }, totalVerdenVolume: 0, productionBuffer: 0 },
  ],
  recipes: {
    FV0100A: {
      code: "FV0100A",
      baseName: "Chicken Tikka Masala",
      markets: {
        DE: {
          market: "DE", msku: "CON-00-111", recipeNameLocal: "Chicken Tikka [DE]",
          subRecipes: [{ id: "SUB-111-1", name: "Chicken - marinated", category: "GRILL" }],
          ingredients: [],
        },
      },
      grossIngredients: {},
    },
  },
  cookSchedules: {},
  productionPlan: {
    week: "2026-W37",
    generatedAt: "",
    rows: [
      { run: 0, kitchenDay: "2026-09-08", workOrder: "37-10", recipeCode: "FV0100A", recipeName: "Chicken Tikka [DE]", subRecipe: "Chicken - marinated", plannedMeals: 1000, targetPortions: 1000, stagingKg: 0, kitchenKg: 0, postKg: 0, yieldPct: 0 },
    ],
  },
  shelfLifeBySku: {
    "SPI-00-999": { skuCode: "SPI-00-999", skuName: "Tikka spice blend", customerMinDays: 7, status: "ok" },
  },
};

describe("buildViewItems", () => {
  it("creates a runnable item per nav view, honouring the localOnly filter", () => {
    const setView = vi.fn();
    const prod = buildViewItems(setView, false);
    const dev = buildViewItems(setView, true);
    expect(prod.length).toBeGreaterThan(10);
    // No nav view is currently localOnly, so prod and dev match; the filter
    // still drops any future localOnly view outside dev.
    expect(dev.length).toBeGreaterThanOrEqual(prod.length);
    expect(prod.every((i) => i.group === "view")).toBe(true);

    const recipeView = prod.find((i) => i.title === "Rezept");
    expect(recipeView).toBeTruthy();
    (recipeView!.action as { type: "run"; run: () => void }).run();
    expect(setView).toHaveBeenCalledWith("recipe");
  });

  it("matches an alias term (warehouse → WMS Übersicht)", () => {
    const items = buildViewItems(vi.fn(), true);
    const hit = rankPaletteItems(items, "warehouse").flatMap((g) => g.items)[0];
    expect(hit?.title).toBe("WMS Übersicht");
  });
});

describe("buildWeekItems", () => {
  it("lists weeks newest-first with recipe counts and a working setter", () => {
    const setWeek = vi.fn();
    const items = buildWeekItems(DATA, (w) => (w === "2026-W37" ? 1 : 0), setWeek);
    expect(items.map((i) => i.title)).toEqual(["KW 2026-W37", "KW 2026-W36", "KW 2026-W35"]);
    expect(items[0].subtitle).toBe("1 Rezepte");
    (items[0].action as { type: "run"; run: () => void }).run();
    expect(setWeek).toHaveBeenCalledWith("2026-W37");
  });

  it("is findable by kw-number alias", () => {
    const items = buildWeekItems(DATA, () => 0, vi.fn());
    const hit = rankPaletteItems(items, "kw36").flatMap((g) => g.items)[0];
    expect(hit?.title).toBe("KW 2026-W36");
  });
});

describe("buildRecipeItems", () => {
  it("makes one item per recipe that opens the recipe view", () => {
    const openRecipe = vi.fn();
    const items = buildRecipeItems(DATA, openRecipe);
    const tikka = items.find((i) => i.subtitle === "FV0100A");
    expect(tikka?.title).toBe("Chicken Tikka Masala");
    (tikka!.action as { type: "run"; run: () => void }).run();
    expect(openRecipe).toHaveBeenCalledWith("FV0100A");
  });

  it("dedupes recipe + weekRecipe by code", () => {
    const items = buildRecipeItems(DATA, vi.fn());
    expect(items.filter((i) => i.subtitle === "FV0100A")).toHaveLength(1);
  });
});

describe("buildSearchEntryItems", () => {
  const items = buildSearchEntryItems(DATA, []);

  it("includes work orders and submeals but not meals", () => {
    expect(items.some((i) => i.group === "wo" && i.title === "WO 37-10")).toBe(true);
    expect(items.some((i) => i.group === "submeal")).toBe(true);
    expect(items.some((i) => i.group === "sku")).toBe(true);
    expect(items.some((i) => (i.group as string) === "meal")).toBe(false);
  });

  it("carries a flow action with the underlying SearchEntry", () => {
    const wo = items.find((i) => i.title === "WO 37-10")!;
    expect(wo.action.type).toBe("flow");
    expect((wo.action as { type: "flow"; entry: { woNumber?: string } }).entry.woNumber).toBe("37-10");
  });
});

describe("matchScore", () => {
  const item = (over: Partial<PaletteItem>): PaletteItem => ({
    key: "k", group: "view", title: "Plating Tag", icon: "x",
    search: "plating tag plaiten linienplan", priority: 30,
    action: { type: "run", run: () => {} }, ...over,
  });

  it("returns 0 when nothing matches", () => {
    expect(matchScore("zzz", item({}))).toBe(0);
  });

  it("ranks an exact title above a mere substring", () => {
    const exact = matchScore("plating tag", item({}));
    const partial = matchScore("plating", item({}));
    expect(exact).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(0);
  });

  it("supports subsequence matches for short queries", () => {
    expect(matchScore("ptg", item({ title: "Plating Tag", search: "plating tag" }))).toBeGreaterThan(0);
  });

  it("requires every whitespace token to appear", () => {
    expect(matchScore("plating zzz", item({}))).toBe(0);
  });
});

describe("rankPaletteItems", () => {
  const setView = vi.fn();
  const all: PaletteItem[] = [
    ...buildCommandItems({ view: "recipe", selectedWeek: "2026-W37", upliftPercent: 0, setUpliftPercent: vi.fn() }),
    ...buildViewItems(setView, true),
    ...buildWeekItems(DATA, () => 0, vi.fn()),
    ...buildRecipeItems(DATA, vi.fn()),
    ...buildSearchEntryItems(DATA, []),
  ];

  it("shows only commands + views when there is no query", () => {
    const groups = rankPaletteItems(all, "");
    expect(groups.map((g) => g.group).sort()).toEqual(["command", "view"]);
  });

  it("floats the most relevant group to the top for a query", () => {
    const groups = rankPaletteItems(all, "chicken tikka");
    expect(groups[0].group).toBe("recipe");
    expect(groups[0].items[0].title).toBe("Chicken Tikka Masala");
  });

  it("caps SKU results", () => {
    const groups = rankPaletteItems(all, "tikka");
    const sku = groups.find((g) => g.group === "sku");
    if (sku) expect(sku.items.length).toBeLessThanOrEqual(6);
  });
});

describe("buildCommandItems", () => {
  it("clamps uplift and reports the new value", async () => {
    const setUpliftPercent = vi.fn();
    const items = buildCommandItems({ view: "recipe", selectedWeek: "2026-W37", upliftPercent: 28, setUpliftPercent });
    const plus = items.find((i) => i.key === "cmd:uplift-plus")!;
    const msg = await (plus.action as { type: "run"; run: () => Promise<string> }).run();
    expect(setUpliftPercent).toHaveBeenCalledWith(30); // 28 + 5 clamped to max 30
    expect(msg).toContain("30");
  });

  it("offers kitchen-link + reload commands", () => {
    const items = buildCommandItems({ view: "wo", selectedWeek: "2026-W37", upliftPercent: 0, setUpliftPercent: vi.fn() });
    expect(items.some((i) => i.key === "cmd:kitchen-copy")).toBe(true);
    expect(items.some((i) => i.key === "cmd:reload")).toBe(true);
  });
});
