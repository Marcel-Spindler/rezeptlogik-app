import { describe, expect, it } from "vitest";
import { buildTodayTrust } from "../features/today/todayTrust";

const allSignals = { postblast: true, preblast: true, rti: true, linePlating: true, wmsHolding: true };

describe("buildTodayTrust", () => {
  it("bewertet eine aktuelle Planquelle mit ausreichend Live-Signalen als vertrauenswürdig", () => {
    expect(buildTodayTrust({ kind: "firestore", label: "Firestore", error: null }, allSignals)).toMatchObject({
      level: "trusted",
      detail: "Firestore · 5/5 Live-Signale verbunden",
    });
  });

  it("stuft Cache und fehlende Live-Signale als eingeschränkt ein", () => {
    expect(buildTodayTrust({ kind: "firestore-cache", label: "Firestore-Cache", error: null }, allSignals).level).toBe("limited");
    expect(buildTodayTrust({ kind: "firestore", label: "Firestore", error: null }, { ...allSignals, rti: false, wmsHolding: false }).level).toBe("limited");
  });

  it("stuft einen Fallback nach Fehler als offline ein", () => {
    expect(buildTodayTrust({ kind: "json-fallback", label: "JSON-Fallback", error: "Firestore nicht erreichbar" }, allSignals).level).toBe("offline");
  });
});