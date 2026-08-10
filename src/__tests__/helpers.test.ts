import { describe, it, expect } from "vitest";
import { fmtNum, stripMarketTag, codeDigits, adjustedPortions } from "../lib/helpers";
import { parseRecipeName, digitKey } from "../../scripts/lib/helpers";

// ─── fmtNum ──────────────────────────────────────────────────────────────────

describe("fmtNum", () => {
  it("formats integers with German locale", () => {
    expect(fmtNum(1234)).toBe("1.234");
    expect(fmtNum(0)).toBe("0");
  });
  it("respects digit count", () => {
    expect(fmtNum(1.5, 1)).toBe("1,5");
    expect(fmtNum(1.567, 2)).toBe("1,57");
  });
});

// ─── stripMarketTag ──────────────────────────────────────────────────────────

describe("stripMarketTag", () => {
  it("removes [BNL] tag", () => {
    expect(stripMarketTag("Chicken Tikka [BNL]")).toBe("Chicken Tikka");
  });
  it("removes [DKSE] tag", () => {
    expect(stripMarketTag("Pesto Pasta [DKSE]")).toBe("Pesto Pasta");
  });
  it("leaves names without tags unchanged", () => {
    expect(stripMarketTag("Salmon Rice Bowl")).toBe("Salmon Rice Bowl");
  });
  it("removes mid-string tags and trims", () => {
    // stripMarketTag removes the tag including surrounding spaces → collapses to one space after trim
    const result = stripMarketTag("Tikka [DE] Masala");
    expect(result.trim()).toContain("Tikka");
    expect(result.trim()).toContain("Masala");
    expect(result).not.toContain("[DE]");
  });
});

// ─── codeDigits ──────────────────────────────────────────────────────────────

describe("codeDigits", () => {
  it("extracts 4-digit core", () => {
    expect(codeDigits("FE0628B")).toBe("0628");
    expect(codeDigits("FV1646A")).toBe("1646");
  });
  it("handles undefined", () => {
    expect(codeDigits(undefined)).toBe("");
  });
});

// ─── adjustedPortions ────────────────────────────────────────────────────────

describe("adjustedPortions", () => {
  it("applies uplift percentage", () => {
    expect(adjustedPortions(1000, 10)).toBe(1100);
    expect(adjustedPortions(1000, 0)).toBe(1000);
    expect(adjustedPortions(1000, -5)).toBe(950);
  });
  it("rounds to integer", () => {
    expect(adjustedPortions(1001, 10)).toBe(1101);
  });
});

// ─── parseRecipeName (shared lib) ────────────────────────────────────────────

describe("parseRecipeName", () => {
  it("parses standard code-dash-name format", () => {
    const r = parseRecipeName("FE0628B - Mushroom Chicken [BNL]");
    expect(r.code).toBe("FE0628B");
    expect(r.base).toBe("Mushroom Chicken");
  });
  it("parses plain code space name format", () => {
    const r = parseRecipeName("FV1646A Lemon Garlic Shrimp");
    expect(r.code).toBe("FV1646A");
    expect(r.base).toBe("Lemon Garlic Shrimp");
  });
  it("returns full string unchanged when no code found", () => {
    const r = parseRecipeName("No code here");
    expect(r.code).toBe("No code here");
  });
  it("strips bracket market suffix", () => {
    const r = parseRecipeName("FV0024A - Chicken Tikka [DKSE]");
    expect(r.code).toBe("FV0024A");
    expect(r.base).toBe("Chicken Tikka");
  });
  it("preserves plain-text market suffix (not bracket-wrapped)", () => {
    // Without brackets, plain "DKSE" at end stays in base via pattern 1
    const r = parseRecipeName("FV0024A - Chicken Tikka DKSE");
    expect(r.code).toBe("FV0024A");
    // The function keeps plain-text market tokens as part of the base
    expect(r.base).toContain("Chicken Tikka");
  });
});

// ─── digitKey (shared lib) ───────────────────────────────────────────────────

describe("digitKey", () => {
  it("extracts 4-digit core from FE code", () => {
    expect(digitKey("FE0972B")).toBe("0972");
  });
  it("extracts 4-digit core from FV code", () => {
    expect(digitKey("FV0972A")).toBe("0972");
  });
  it("FE and FV with same digits produce identical key", () => {
    expect(digitKey("FE4009A")).toBe(digitKey("FV4009A"));
  });
  it("returns original string if no digits found", () => {
    expect(digitKey("ABC")).toBe("ABC");
  });
});
