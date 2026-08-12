import { describe, expect, it } from "vitest";
import { previousWmsWeekCandidates, resolveOperationalWmsWeekNum, resolveSelectedWeekFromStationRows, weekPrefixFromWoNumber, woMatchesSelectedWeek } from "../features/wms-overview/wmsWeeks";

describe("WMS week fallback", () => {
  it("uses selected week when rows exist in selected week", () => {
    const resolved = resolveOperationalWmsWeekNum(32, [
      [{ kw: 32 }, { kw: 31 }],
      [{ kw: 30 }],
    ]);
    expect(resolved).toBe(32);
  });

  it("keeps the selected week when no rows exist in that week", () => {
    const resolved = resolveOperationalWmsWeekNum(32, [
      [{ kw: 31 }],
      [{ kw: null }, { kw: 30 }],
    ]);
    expect(resolved).toBe(32);
  });

  it("keeps selected week when neither selected nor fallback week has rows", () => {
    const resolved = resolveOperationalWmsWeekNum(32, [
      [{ kw: 29 }],
      [{ kw: null }],
    ]);
    expect(resolved).toBe(32);
  });

  it("keeps week 1 when no previous-year fallback is allowed", () => {
    const resolved = resolveOperationalWmsWeekNum(1, [
      [{ kw: 52 }],
      [{ kw: null }],
    ]);
    expect(resolved).toBe(1);
  });

  it("keeps week 1 when no previous-year fallback is allowed for week 53", () => {
    const resolved = resolveOperationalWmsWeekNum(1, [
      [{ kw: 53 }],
      [{ kw: null }],
    ]);
    expect(resolved).toBe(1);
  });

  it("returns expected fallback candidates", () => {
    expect(previousWmsWeekCandidates(32)).toEqual([31]);
    expect(previousWmsWeekCandidates(1)).toEqual([52, 53]);
  });

  it("keeps the selected week when another station has rows for it even if inbound/sleeving are empty", () => {
    const resolved = resolveSelectedWeekFromStationRows(34, [
      [{ kw: 33 }],
      [{ kw: 33 }],
      [{ kw: 34 }, { kw: 34 }],
      [{ kw: 33 }],
      [{ kw: 33 }],
      [{ kw: 33 }],
    ]);
    expect(resolved).toBe(34);
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
    expect(woMatchesSelectedWeek("202633", "2026-W34")).toBe(false);
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

  it("strict mode rejects the -1/+2 adjacent-week window and only allows exact week matches", () => {
    expect(woMatchesSelectedWeek("202633", "2026-W34")).toBe(false);
    expect(woMatchesSelectedWeek("202633", "2026-W34", undefined, true)).toBe(true);
    expect(woMatchesSelectedWeek("202634", "2026-W34", undefined, false)).toBe(true);
  });
});
