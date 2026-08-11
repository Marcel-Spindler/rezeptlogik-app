import { describe, expect, it } from "vitest";
import { previousWmsWeekCandidates, resolveOperationalWmsWeekNum, weekPrefixFromWoNumber, woMatchesSelectedWeek } from "../features/wms-overview/wmsWeeks";

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

  it("allowFallback=false always returns the selected week as-is, even with no matching rows anywhere", () => {
    expect(resolveOperationalWmsWeekNum(32, [[{ kw: 31 }], [{ kw: 30 }]], false)).toBe(32);
    expect(resolveOperationalWmsWeekNum(32, [[{ kw: 32 }]], false)).toBe(32);
  });
});

describe("weekPrefixFromWoNumber", () => {
  it("extracts the KW prefix from real WO number formats", () => {
    expect(weekPrefixFromWoNumber("34-62")).toBe(34);
    expect(weekPrefixFromWoNumber("34-R1")).toBe(34);
    expect(weekPrefixFromWoNumber("9-5")).toBe(9);
  });

  it("returns null for numbers without a KW prefix", () => {
    expect(weekPrefixFromWoNumber("")).toBeNull();
    expect(weekPrefixFromWoNumber("ABC-123")).toBeNull();
  });
});

describe("woMatchesSelectedWeek", () => {
  it("matches the documented YYYYWW raw format", () => {
    expect(woMatchesSelectedWeek("202634", "2026-W34")).toBe(true);
    // 202633 falls inside the intentional "-1 week" adjacent-week fallback below,
    // so use a week further outside that window to test the exact-match path.
    expect(woMatchesSelectedWeek("202628", "2026-W34")).toBe(false);
  });

  it("falls back to the WO-number prefix when the raw week field doesn't match — this is the KW34 bug: the server already filtered by wo_number, but an unexpected/malformed row.week value used to hide every row again", () => {
    expect(woMatchesSelectedWeek("garbage-format", "2026-W34", "34-62")).toBe(true);
    expect(woMatchesSelectedWeek("", "2026-W34", "34-R1")).toBe(true);
    expect(woMatchesSelectedWeek("202601", "2026-W34", "34-62")).toBe(true);
  });

  it("still rejects rows that match neither the week field nor the WO-number prefix", () => {
    expect(woMatchesSelectedWeek("202601", "2026-W34", "33-62")).toBe(false);
    expect(woMatchesSelectedWeek("garbage", "2026-W34", "12-99")).toBe(false);
  });

  it("allowAdjacentWeekFallback=false (strict mode) rejects the -1/+2 adjacent-week window that otherwise leaks e.g. KW32 into a KW33 view", () => {
    // 202633 is inside the default adjacent-week window for a KW34 selection...
    expect(woMatchesSelectedWeek("202633", "2026-W34")).toBe(true);
    // ...but not in strict mode, where only exact matches (or WO-number prefix) count.
    expect(woMatchesSelectedWeek("202633", "2026-W34", undefined, false)).toBe(false);
    expect(woMatchesSelectedWeek("202634", "2026-W34", undefined, false)).toBe(true);
  });
});
