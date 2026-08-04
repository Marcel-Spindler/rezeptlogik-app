import { describe, expect, it } from "vitest";
import { previousWmsWeekCandidates, resolveOperationalWmsWeekNum } from "../WmsKwOverviewView";

describe("WMS week fallback", () => {
  it("uses selected week when rows exist in selected week", () => {
    const resolved = resolveOperationalWmsWeekNum(32, [
      [{ kw: 32 }, { kw: 31 }],
      [{ kw: 30 }],
    ]);
    expect(resolved).toBe(32);
  });

  it("falls back to previous week when selected week has no rows", () => {
    const resolved = resolveOperationalWmsWeekNum(32, [
      [{ kw: 31 }],
      [{ kw: null }, { kw: 30 }],
    ]);
    expect(resolved).toBe(31);
  });

  it("keeps selected week when neither selected nor fallback week has rows", () => {
    const resolved = resolveOperationalWmsWeekNum(32, [
      [{ kw: 29 }],
      [{ kw: null }],
    ]);
    expect(resolved).toBe(32);
  });

  it("supports year transition fallback from week 1 to week 52", () => {
    const resolved = resolveOperationalWmsWeekNum(1, [
      [{ kw: 52 }],
      [{ kw: null }],
    ]);
    expect(resolved).toBe(52);
  });

  it("supports year transition fallback from week 1 to week 53", () => {
    const resolved = resolveOperationalWmsWeekNum(1, [
      [{ kw: 53 }],
      [{ kw: null }],
    ]);
    expect(resolved).toBe(53);
  });

  it("returns expected fallback candidates", () => {
    expect(previousWmsWeekCandidates(32)).toEqual([31]);
    expect(previousWmsWeekCandidates(1)).toEqual([52, 53]);
  });
});
