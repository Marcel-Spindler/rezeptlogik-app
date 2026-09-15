import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/hfWeek", () => ({ currentHfWeek: () => "2026-W39" }));

const { lookbackHoursFor } = await import("../features/gsheet-monitor/useCombinedPlaited");

describe("lookbackHoursFor", () => {
  it("bleibt bei 72h für die laufende Woche", () => {
    expect(lookbackHoursFor(39)).toBe(72);
  });

  it("bleibt bei 72h ohne Wochenauswahl", () => {
    expect(lookbackHoursFor(null)).toBe(72);
  });

  // Live-Fall: KW38 angeschaut, nachdem der Kalender schon auf KW39 steht —
  // Redzone muss dann die GANZE KW38 abdecken, nicht nur die letzten 72h ab heute.
  it("deckt eine Woche zusätzlich ab, wenn genau die Vorwoche angeschaut wird", () => {
    expect(lookbackHoursFor(38)).toBe(72 + 168);
  });

  it("deckelt bei 3 Wochen zurück", () => {
    expect(lookbackHoursFor(35)).toBe(72 + 3 * 168);
    expect(lookbackHoursFor(20)).toBe(72 + 3 * 168);
  });

  it("dehnt das Fenster nicht aus, wenn eine zukünftige Woche gewählt ist", () => {
    expect(lookbackHoursFor(40)).toBe(72);
  });
});
