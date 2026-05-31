import { describe, it, expect } from "vitest";
import { rawToFinished, finishedToRaw, rawToMeals, mealsToRaw } from "../yieldCalculator";

describe("rawToFinished", () => {
  it("calculates output correctly", () => {
    const r = rawToFinished(1000, 0.7);
    expect(r.outputValue).toBeCloseTo(700, 1);
    expect(r.lossPercent).toBeCloseTo(30, 1);
  });
  it("perfect yield (1.0) produces no loss", () => {
    const r = rawToFinished(500, 1.0);
    expect(r.outputValue).toBe(500);
    expect(r.lossPercent).toBe(0);
  });
  it("throws on invalid yieldRatio", () => {
    expect(() => rawToFinished(100, 0)).toThrow();
    expect(() => rawToFinished(100, 1.5)).toThrow();
  });
  it("throws on negative input", () => {
    expect(() => rawToFinished(-1, 0.8)).toThrow();
  });
});

describe("finishedToRaw", () => {
  it("calculates required raw correctly", () => {
    const r = finishedToRaw(700, 0.7);
    expect(r.outputValue).toBeCloseTo(1000, 1);
  });
  it("is inverse of rawToFinished", () => {
    const raw = 1234;
    const yield_ = 0.82;
    const finished = rawToFinished(raw, yield_).outputValue;
    const backToRaw = finishedToRaw(finished, yield_).outputValue;
    expect(backToRaw).toBeCloseTo(raw, 1);
  });
});

describe("rawToMeals / mealsToRaw", () => {
  it("calculates meal count from raw grams", () => {
    const r = rawToMeals(1000, 0.8, 200);
    // 1000g * 0.8 yield = 800g finished / 200g per portion = 4 meals
    expect(r.mealCount).toBe(4);
  });
  it("calculates required raw from meal count", () => {
    const r = mealsToRaw(4, 0.8, 200);
    // 4 meals * 200g = 800g finished / 0.8 yield = 1000g raw
    expect(r.outputValue).toBeCloseTo(1000, 1);
  });
});
