import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentHfWeek, isoWeekLabel } from "../lib/hfWeek";

describe("isoWeekLabel", () => {
  it("puts January 4th in week 1 for several years (ISO definition invariant)", () => {
    expect(isoWeekLabel(new Date(Date.UTC(2024, 0, 4)))).toBe("2024-W01");
    expect(isoWeekLabel(new Date(Date.UTC(2025, 0, 4)))).toBe("2025-W01");
    expect(isoWeekLabel(new Date(Date.UTC(2026, 0, 4)))).toBe("2026-W01");
  });

  it("assigns late-December dates to the following year's week 1 when appropriate", () => {
    // 2018-12-31 is a Monday, i.e. the start of ISO week 1 of 2019.
    expect(isoWeekLabel(new Date(Date.UTC(2018, 11, 31)))).toBe("2019-W01");
  });

  it("supports 53-week years", () => {
    // 2020 is a 53-ISO-week year; Dec 31 2020 (Thursday) falls in week 53.
    expect(isoWeekLabel(new Date(Date.UTC(2020, 11, 31)))).toBe("2020-W53");
  });
});

describe("currentHfWeek", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is always exactly one ISO week ahead of the calendar-true week", () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 11))); // 2026-08-11
    const trueIso = isoWeekLabel(new Date());
    const [, trueWeekStr] = trueIso.match(/^(\d{4})-W(\d{2})$/)!.slice(1);
    expect(currentHfWeek()).toBe(`2026-W${String(Number(trueWeekStr) + 1).padStart(2, "0")}`);
  });

  it("rolls over into next year's W01 once the +1 offset pushes past week 52", () => {
    // Find a date whose true ISO week is 52, so HF week (+1) rolls to next year.
    // 2026-12-24 (Thursday) is ISO week 2026-W52.
    vi.setSystemTime(new Date(Date.UTC(2026, 11, 24)));
    expect(isoWeekLabel(new Date())).toBe("2026-W52");
    expect(currentHfWeek()).toBe("2027-W01");
  });
});
