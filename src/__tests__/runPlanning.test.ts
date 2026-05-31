import { describe, it, expect } from "vitest";
import {
  recommendedRunCount,
  SINGLE_RUN_MAX,
  TRIPLE_RUN_MIN,
} from "../runPlanning";

describe("recommendedRunCount", () => {
  it("returns 1 for small volumes", () => {
    expect(recommendedRunCount(0)).toBe(1);
    expect(recommendedRunCount(SINGLE_RUN_MAX)).toBe(1);
  });
  it("returns 2 for medium volumes", () => {
    expect(recommendedRunCount(SINGLE_RUN_MAX + 1)).toBe(2);
    expect(recommendedRunCount(TRIPLE_RUN_MIN - 1)).toBe(2);
  });
  it("returns 3 for large volumes", () => {
    expect(recommendedRunCount(TRIPLE_RUN_MIN)).toBe(3);
    expect(recommendedRunCount(10000)).toBe(3);
  });
  it("boundary: exactly at SINGLE_RUN_MAX is still 1 run", () => {
    expect(recommendedRunCount(800)).toBe(1);
    expect(recommendedRunCount(801)).toBe(2);
  });
  it("boundary: exactly at TRIPLE_RUN_MIN is 3 runs", () => {
    expect(recommendedRunCount(4500)).toBe(3);
    expect(recommendedRunCount(4499)).toBe(2);
  });
});
