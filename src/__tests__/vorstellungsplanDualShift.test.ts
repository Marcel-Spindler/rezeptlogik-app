import { describe, expect, it } from "vitest";
import type { ProductionPlanData, ProductionPlanDayCell, ProductionPlanRow } from "../features/gsheet-monitor/gsheetTypes";
import { PRODUCTION_PLAN_DAYS } from "../features/gsheet-monitor/gsheetTypes";
import { buildVorstellungsplanMailHtml } from "../features/vorstellungsplan/vorstellungsplanMail";
import { buildVorVorPlanungText } from "../features/vorstellungsplan/vorVorPlanungText";
import { mergeRowOverride } from "../features/vorstellungsplan/productionPlanOverrides";

const EMPTY: ProductionPlanDayCell = { kind: "empty" };
const P = (portions: number): ProductionPlanDayCell => ({ kind: "portions", portions });

function emptyByDay(): Record<(typeof PRODUCTION_PLAN_DAYS)[number], ProductionPlanDayCell> {
  return Object.fromEntries(PRODUCTION_PLAN_DAYS.map(d => [d, EMPTY])) as Record<(typeof PRODUCTION_PLAN_DAYS)[number], ProductionPlanDayCell>;
}

function row(code: string, name: string, opts: Partial<ProductionPlanRow> = {}): ProductionPlanRow {
  return {
    code, preference: "Keto", recipeName: name,
    benl: 1000, nordics: 800, de: 600, total: 2400, totalWithBuffer: 2520,
    complexityScore: 1, subCount: 4, cookStationCount: 5, activeCookMin: 300, passiveHoldMin: 0,
    stations: { grill: false, cup: false, butter: false, oven: true, braiser: true, slice: false },
    allergens: "milk",
    byDay: emptyByDay(),
    readyByDay: { thu: 2520, fri: 2520, sat: 2520 },
    minNeedsByDay: { thu: 1200, fri: null, sat: null },
    ...opts,
  };
}

const dualData: ProductionPlanData = {
  week: "2026-W39",
  shiftModel: "dual",
  rows: [
    row("FV1351A", "Cheddar Pasta", {
      byDay: { ...emptyByDay(), Wednesday: P(5032), Friday: P(2156) },
      byShift: {
        Monday: { early: EMPTY, late: EMPTY },
        Wednesday: { early: P(3000), late: P(2032) },
        Friday: { early: P(2156), late: EMPTY },
      },
    }),
  ],
  totals: { benl: 44106, nordics: 30139, de: 21484, total: 95729, totalWithBuffer: 100804 },
  kpiRows: [{ label: "lines", byDay: { Tuesday: 2, Wednesday: 2 } }],
  utilization: [],
  kitchen: {
    rows: [row("FV1351A", "Cheddar Pasta", {
      byDay: { ...emptyByDay(), Tuesday: P(5032), Thursday: P(2156) },
      byShift: {
        Tuesday: { early: P(3000), late: P(2032) },
        Thursday: { early: P(2156), late: EMPTY },
      },
      readyByDay: { thu: null, fri: null, sat: null },
      minNeedsByDay: { thu: null, fri: null, sat: null },
    })],
  },
  lastUpdated: Date.now(),
};

describe("Vorstellungsplan – Zweischicht-Woche", () => {
  it("mail HTML nennt das Schichtmodell und rendert einen Küchenplan-Block", () => {
    const html = buildVorstellungsplanMailHtml(dualData, "2026-W39", { backfills: null, redzone: null, wms: { status: "ready", totalWoPortions: 0, uniqueMeals: 0 } as never });
    expect(html).toContain("2-Schicht-Modell");
    expect(html).toContain("Küchenplan");
    // früh/spät-Split-Notiz im Plating-Teil (Wed 3000/2032)
    expect(html).toContain("3.000 / 2.032");
  });

  it("Vor-Vor-Text nennt Schichtmodell + Küchenplan-Kochmengen je Tag", () => {
    const text = buildVorVorPlanungText(dualData, {});
    expect(text).toContain("2-Schicht-Modell");
    expect(text).toContain("Küchenplan");
    expect(text).toMatch(/Di: 5\.032 \(früh 3\.000 \/ spät 2\.032\)/);
    expect(text).toMatch(/Do: 2\.156/);
  });

  it("Einschicht-Woche erwähnt nichts von Schichten/Küchenplan", () => {
    const singleData: ProductionPlanData = { ...dualData, shiftModel: "single", kitchen: undefined };
    const text = buildVorVorPlanungText(singleData, {});
    expect(text).not.toContain("2-Schicht-Modell");
    expect(text).not.toContain("Küchenplan");
  });
});

describe("Schicht-Zell-Overrides (mergeRowOverride)", () => {
  const base = row("FV1351A", "Cheddar Pasta", {
    nordics: 2000, benl: 1000, de: 1000,
    byDay: { ...emptyByDay(), Wednesday: P(5000) },
    byShift: { Wednesday: { early: P(3000), late: P(2000) } },
    readyByDay: { thu: 5000, fri: 5000, sat: 5000 },
    minNeedsByDay: { thu: 1000, fri: null, sat: null },
  });

  it("Edit einer Früh-Zelle rechnet die gemergte Tages-Sicht + auto-Ready neu", () => {
    const merged = mergeRowOverride(base, { byShift: { Wednesday: { early: P(4000) } } });
    expect(merged.byShift?.Wednesday).toEqual({ early: P(4000), late: P(2000) });
    // gemergt: 4000 + 2000
    expect(merged.byDay.Wednesday).toEqual({ kind: "portions", portions: 6000 });
    // auto-Ready = Summe aller byDay-Portionen der Woche
    expect(merged.readyByDay).toEqual({ thu: 6000, fri: 6000, sat: 6000 });
  });

  it("Spät-Zelle bleibt unangetastet, wenn nur die Früh-Zelle editiert wird", () => {
    const merged = mergeRowOverride(base, { byShift: { Wednesday: { early: { kind: "empty" } } } });
    expect(merged.byShift?.Wednesday).toEqual({ early: { kind: "empty" }, late: P(2000) });
    expect(merged.byDay.Wednesday).toEqual({ kind: "portions", portions: 2000 });
  });

  it("ohne Override unverändert (inkl. byShift)", () => {
    expect(mergeRowOverride(base, undefined)).toBe(base);
  });
});
