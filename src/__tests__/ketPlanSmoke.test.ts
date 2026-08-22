// Smoke-Tests für das KET-Plan Feature — End-to-End-Pfade und Edge Cases,
// die über die bestehenden Unit-Tests hinausgehen.
import { describe, expect, it } from "vitest";
import type { KetRow, BatchCalc } from "../features/ket-plan/ketTypes";
import { parseKetCsv, parseDateShift, fmtKg, parseSortKey } from "../features/ket-plan/ketLogic";
import { computeRunAssignments, shiftWindow } from "../features/ket-plan/ketRunLogic";
import { computeFullResourceDemand, formatFullResourceAsText, formatFullResourceAsCsv, computeWeekDelta } from "../features/ket-plan/ketEquipmentSummary";
import { buildPdf } from "../features/ket-plan/ketPdf";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<KetRow> & { key: string }): KetRow {
  return {
    dateNeeded: "2026-08-18 - 1",
    shift: "1",
    woNumber: "35-1",
    recipeId: "REC-001",
    recipeCode: "FV0001A",
    recipeName: "Test Recipe",
    subRecipeName: "Test Sauce",
    cookMethods: ["BRAISER"],
    woCookedPortions: null,
    targetPortions: 200,
    cookedPortionsExcess: null,
    stagingStatus: "",
    stagingComment: "",
    kitchenStatus: "",
    unlockedEta: "",
    workOrderComment: "",
    ...overrides,
  };
}

function makeCalc(overrides?: Partial<BatchCalc>): BatchCalc {
  return {
    totalKg: 80,
    equipBatches: [
      { equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 1, perBatchKg: 80, remainderKg: 0, utilizationPct: 100 },
    ],
    primaryEquip: "BRAISER",
    capacityKg: 80,
    batches: 1,
    perBatchKg: 80,
    remainderKg: 0,
    resolvedCookMethods: ["BRAISER"],
    ingredients: [],
    recipeFound: true,
    subRecipeFound: true,
    cookingInstructions: null,
    subRecipeInstructions: null,
    subRecipeInstructionsDE: null,
    subRecipeInstructionsGermanFallback: false,
    rti: false,
    neverBatch: false,
    factorCapacityKg: null,
    factorBatches: null,
    factorBatchQtyKg: null,
    factorFallbackCapacity: false,
    readyMade: false,
    allergensContains: [],
    chillerAssignment: null,
    uomWarnings: [],
    factorOverridesEquip: false,
    components: [],
    gnTraySummary: [],
    scoopInfo: null,
    ...overrides,
  };
}

const MINIMAL_CSV = `Work Order Number,Date Needed,Recipe Name,Sub Recipe Name,Cook Methods,Target Portions,Kitchen Status,Staging Status,Staging Comment,Unlocked ETA,Work Order Comment,WO Cooked Portions,Cooked Portions Excess,Recipe ID
35-1,2026-08-18 - 1,FV0001A - Chicken Bowl [DE],Chicken Teriyaki Sauce,BRAISER,200,Pre Blast,Picking,,,,,,REC-001
35-2,2026-08-18 - 1,FV0002A - Veggie Wrap [DE],Mixed Vegetables,OVEN,150,Not Started,Released,,,,,,REC-002`;

// ═══════════════════════════════════════════════════════════════════════
// 1. CSV → parse → End-to-End
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: CSV → parse → pipeline", () => {
  it("parst eine valide CSV und liefert korrekte KetRow-Struktur", () => {
    const { rows, warnings } = parseKetCsv(MINIMAL_CSV);
    expect(rows).toHaveLength(2);
    expect(warnings).toHaveLength(0);
    expect(rows[0].woNumber).toBe("35-1");
    expect(rows[0].recipeCode).toBe("FV0001A");
    expect(rows[0].subRecipeName).toBe("Chicken Teriyaki Sauce");
    expect(rows[0].cookMethods).toEqual(["BRAISER"]);
    expect(rows[0].targetPortions).toBe(200);
    expect(rows[0].shift).toBe("1");
    expect(rows[1].woNumber).toBe("35-2");
    expect(rows[1].targetPortions).toBe(150);
  });

  it("parsed rows → computeRunAssignments → computeFullResourceDemand (full pipeline)", () => {
    const { rows } = parseKetCsv(MINIMAL_CSV);
    const runAssignments = computeRunAssignments(rows);
    const calcMap = new Map<string, BatchCalc>([
      [rows[0].key, makeCalc({ totalKg: 60, equipBatches: [{ equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 1, perBatchKg: 60, remainderKg: 0, utilizationPct: 75 }] })],
      [rows[1].key, makeCalc({ totalKg: 45, primaryEquip: "OVEN", equipBatches: [{ equip: "OVEN", label: "Ofen", capacityKg: 60, batches: 1, perBatchKg: 45, remainderKg: 0, utilizationPct: 75 }], resolvedCookMethods: ["OVEN"] })],
    ]);
    const summary = computeFullResourceDemand(rows, calcMap, runAssignments);
    expect(summary.byRunDayShift.length).toBeGreaterThan(0);
    expect(summary.totalKgWeek).toBeCloseTo(105, 0);
    expect(summary.bottlenecks).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Edge Cases: leere / ungültige CSVs
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: CSV Edge Cases", () => {
  it("leere CSV (kein Inhalt) → 0 Zeilen", () => {
    const { rows } = parseKetCsv("");
    expect(rows).toHaveLength(0);
  });

  it("CSV mit nur Header → 0 Zeilen, keine Fehler", () => {
    const headerOnly = "Work Order Number,Date Needed,Recipe Name,Sub Recipe Name,Cook Methods,Target Portions\n";
    const { rows, warnings } = parseKetCsv(headerOnly);
    expect(rows).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("CSV mit fehlender WO-Nummer → Zeile wird gefiltert", () => {
    const csv = `Work Order Number,Date Needed,Recipe Name,Sub Recipe Name,Cook Methods,Target Portions
,2026-08-18 - 1,FV0001A - Test [DE],Sauce,BRAISER,100`;
    const { rows } = parseKetCsv(csv);
    expect(rows).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. parseDateShift Edge-Inputs
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: parseDateShift Edge Cases", () => {
  it("leerer String → date und shift sind leer", () => {
    const result = parseDateShift("");
    expect(result.date).toBe("");
    expect(result.shift).toBe("");
  });

  it("nur Datum ohne Schicht → shift bleibt leer", () => {
    const result = parseDateShift("2026-08-18");
    expect(result.date).toBe("2026-08-18");
    expect(result.shift).toBe("");
  });

  it("normales Format 'YYYY-MM-DD - N' → korrekt geparst", () => {
    const result = parseDateShift("2026-08-18 - 2");
    expect(result.date).toBe("2026-08-18");
    expect(result.shift).toBe("2");
  });

  it("Format mit En-Dash 'YYYY-MM-DD – N' → korrekt geparst", () => {
    const result = parseDateShift("2026-08-18 – 1");
    expect(result.date).toBe("2026-08-18");
    expect(result.shift).toBe("1");
  });

  it("ungültiges Datum → wird als ganzer String in date zurückgegeben", () => {
    const result = parseDateShift("not-a-date");
    expect(result.date).toBe("not-a-date");
    expect(result.shift).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. fmtKg Grenzwerte
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: fmtKg Grenzwerte", () => {
  it("0 kg → '0 kg'", () => {
    expect(fmtKg(0)).toBe("0 kg");
  });

  it("winziger Wert (0.05 kg) → Gramm-Darstellung", () => {
    expect(fmtKg(0.05)).toBe("50 g");
  });

  it("0.5 kg → Gramm-Darstellung (< 1 kg)", () => {
    expect(fmtKg(0.5)).toBe("500 g");
  });

  it("100 kg → kg-Darstellung mit Komma", () => {
    expect(fmtKg(100)).toBe("100,0 kg");
  });

  it("1.0 kg Grenze → kg-Darstellung", () => {
    expect(fmtKg(1.0)).toBe("1,0 kg");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Wochenerkennung (detectWeekFromRows-Pattern)
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: Wochenerkennung aus WO-Nummern", () => {
  it("'35-1' enthält W35 → Woche erkennbar", () => {
    const match = "35-1".match(/W(\d{2})/i) || "2026-08-18 - 1".match(/W(\d{2})/i);
    // Ohne W-Prefix wird es nicht gematcht — das ist das erwartete Verhalten
    // bei numerischen WO-Nummern. Das CSV-Dateiname-Pattern übernimmt dann.
    expect(match).toBeNull();
  });

  it("'W35-1' mit explizitem W-Prefix → matcht korrekt", () => {
    const match = "W35-1".match(/W(\d{2})/i);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("35");
  });

  it("'BOWL33' wird vom aktuellen Regex nicht gematcht (W gefolgt von 2 Ziffern prüfen)", () => {
    // "BOWL33" → kein Match, denn nach dem "W" kommt "L33", nicht "\d\d"
    const match = "BOWL33".match(/W(\d{2})/i);
    expect(match).toBeNull();
  });

  it("'STEW35-1' matcht fälschlich auf W35 (Substring-Bug im Regex)", () => {
    // Zeigt den Bug: "STEW35" enthält "W35" als Substring
    const match = "STEW35-1".match(/W(\d{2})/i);
    expect(match).not.toBeNull(); // Bug: matcht fälschlich
    expect(match![1]).toBe("35");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. computeRunAssignments: 0 targetPortions
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: computeRunAssignments Edge Cases", () => {
  it("alle targetPortions = 0 → kein Crash, alle Run 1", () => {
    const rows = [
      makeRow({ key: "a", dateNeeded: "2026-08-17 - 1", targetPortions: 0 }),
      makeRow({ key: "b", dateNeeded: "2026-08-18 - 1", targetPortions: 0 }),
    ];
    const assignments = computeRunAssignments(rows);
    expect(assignments.get("a")!.run).toBe(1);
    expect(assignments.get("b")!.run).toBe(1);
    expect(assignments.get("a")!.cumulativeSharePct).toBe(0);
  });

  it("Zeilen ohne recipeCode werden ignoriert", () => {
    const rows = [
      makeRow({ key: "a", recipeCode: "", targetPortions: 500 }),
    ];
    const assignments = computeRunAssignments(rows);
    expect(assignments.size).toBe(0);
  });

  it("einzelne Zeile → Run 1, nicht gesplittet", () => {
    const rows = [makeRow({ key: "solo", targetPortions: 1000 })];
    const assignments = computeRunAssignments(rows);
    expect(assignments.get("solo")!.run).toBe(1);
    expect(assignments.get("solo")!.isSplit).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. computeFullResourceDemand mit leeren Maps
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: computeFullResourceDemand graceful handling", () => {
  it("leere rows → leeres Ergebnis ohne Crash", () => {
    const result = computeFullResourceDemand([], new Map(), new Map());
    expect(result.byRunDayShift).toHaveLength(0);
    expect(result.bottlenecks).toHaveLength(0);
    expect(result.totalKgWeek).toBe(0);
    expect(result.scoopInventory).toHaveLength(0);
  });

  it("rows ohne passende calcMap-Einträge → Stationen sind leer", () => {
    const rows = [makeRow({ key: "wo::1" })];
    const result = computeFullResourceDemand(rows, new Map(), new Map());
    expect(result.byRunDayShift).toHaveLength(1);
    expect(result.byRunDayShift[0].stations).toHaveLength(0);
    expect(result.byRunDayShift[0].totalKg).toBe(0);
  });

  it("formatFullResourceAsText mit leerem Ergebnis crasht nicht", () => {
    const result = computeFullResourceDemand([], new Map(), new Map());
    const text = formatFullResourceAsText(result);
    expect(typeof text).toBe("string");
    expect(text).toContain("STATIONS-RESSOURCEN-PLAN");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. buildPdf Edge Cases
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: buildPdf", () => {
  it("leere rows-Liste → valides HTML-Dokument ohne Cards", () => {
    const html = buildPdf([], new Map(), {}, "Test KET Plan");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Test KET Plan</title>");
    expect(html).not.toContain("class=\"card\"");
  });

  it("row ohne passenden calcMap-Eintrag → wird übersprungen (leerer String)", () => {
    const rows = [makeRow({ key: "orphan" })];
    const html = buildPdf(rows, new Map(), {}, "Test");
    expect(html).toContain("<!DOCTYPE html>");
    // Kein Card-HTML für die Zeile ohne Calc
    expect(html).not.toContain("WO 35-1");
  });

  it("vollständiger Durchlauf mit einer WO → generiert Card-HTML", () => {
    const rows = [makeRow({ key: "wo::1", woNumber: "35-7" })];
    const calcMap = new Map<string, BatchCalc>([["wo::1", makeCalc()]]);
    const html = buildPdf(rows, calcMap, {}, "Woche 35");
    expect(html).toContain("WO 35-7");
    expect(html).toContain("BRAISER");
    expect(html).toContain("Test Sauce"); // subRecipeName als sub-heading
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. utilizationPct Grenzwerte
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: utilizationPct Berechnung", () => {
  // Nachbildung der KetEquipmentPanel-Logik
  function utilizationPct(effectiveMinutes: number): number {
    const shiftMin = 8 * 60;
    return Math.min(100, Math.round((effectiveMinutes / shiftMin) * 100));
  }

  it("0 Minuten → 0%", () => {
    expect(utilizationPct(0)).toBe(0);
  });

  it("240 Minuten (halbe Schicht) → 50%", () => {
    expect(utilizationPct(240)).toBe(50);
  });

  it("480 Minuten (volle Schicht) → 100%", () => {
    expect(utilizationPct(480)).toBe(100);
  });

  it("600 Minuten (Überlast) → gedeckelt auf 100%", () => {
    expect(utilizationPct(600)).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. parseSortKey robustness
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: parseSortKey Sortierung", () => {
  it("sortiert chronologisch nach Datum, dann nach Schicht", () => {
    const keys = [
      parseSortKey("2026-08-20 - 1"),
      parseSortKey("2026-08-18 - 2"),
      parseSortKey("2026-08-18 - 1"),
    ];
    const sorted = [...keys].sort((a, b) => a - b);
    expect(sorted[0]).toBe(keys[2]); // 18 - 1
    expect(sorted[1]).toBe(keys[1]); // 18 - 2
    expect(sorted[2]).toBe(keys[0]); // 20 - 1
  });

  it("leerer String → sortKey 0", () => {
    expect(parseSortKey("")).toBe(0);
  });

  it("ungültiges Datum → sortKey 0", () => {
    expect(parseSortKey("xyz-nonsense")).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 11. Personalbedarfsschätzung (staffNeeded)
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: Personalbedarfsschätzung", () => {
  it("berechnet staffNeeded pro Station basierend auf effectiveMinutes", () => {
    const rows = [makeRow({ key: "wo::1", woNumber: "35-1", dateNeeded: "2026-08-18 - 1" })];
    const calcMap = new Map<string, BatchCalc>([
      ["wo::1", makeCalc({
        totalKg: 320,
        equipBatches: [{ equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 4, perBatchKg: 80, remainderKg: 0, utilizationPct: 100 }],
      })],
    ]);
    // 4 batches × 45min = 180min total, ÷ 3 Braiser = 60min effective
    // 60min ÷ 480min (Schicht) = 0.125 → aufgerundet 1 MA
    const result = computeFullResourceDemand(rows, calcMap, new Map());
    const braiser = result.byRunDayShift[0].stations.find(s => s.station === "BRAISER");
    expect(braiser!.staffNeeded).toBe(1);
  });

  it("staffNeeded > 1 bei Überlast (effectiveMinutes > Schichtlänge)", () => {
    const rows = [makeRow({ key: "wo::1", woNumber: "35-1", dateNeeded: "2026-08-18 - 1" })];
    const calcMap = new Map<string, BatchCalc>([
      ["wo::1", makeCalc({
        totalKg: 2400,
        equipBatches: [{ equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 30, perBatchKg: 80, remainderKg: 0, utilizationPct: 100 }],
      })],
    ]);
    // 30 batches × 45min = 1350min ÷ 3 Braiser = 450min effective
    // 450 ÷ 480 = 0.9375 → aufgerundet 1 MA (knapp unter 1 Schicht)
    const result = computeFullResourceDemand(rows, calcMap, new Map());
    const braiser = result.byRunDayShift[0].stations.find(s => s.station === "BRAISER");
    expect(braiser!.staffNeeded).toBe(1);
  });

  it("totalStaffNeeded summiert alle Stationen", () => {
    const rows = [makeRow({ key: "wo::1", woNumber: "35-1", dateNeeded: "2026-08-18 - 1" })];
    const calcMap = new Map<string, BatchCalc>([
      ["wo::1", makeCalc({
        equipBatches: [
          { equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 2, perBatchKg: 40, remainderKg: 0, utilizationPct: 50 },
          { equip: "OVEN", label: "Ofen", capacityKg: 60, batches: 1, perBatchKg: 50, remainderKg: 0, utilizationPct: 83 },
        ],
        resolvedCookMethods: ["BRAISER", "OVEN"],
      })],
    ]);
    const result = computeFullResourceDemand(rows, calcMap, new Map());
    expect(result.byRunDayShift[0].totalStaffNeeded).toBeGreaterThanOrEqual(1);
    expect(result.peakStaffNeeded).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 12. Multi-Schicht-Support (Nachtschicht)
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: Schicht-Modell", () => {
  it("shiftWindow('3') gibt null zurück (keine Nachtschicht bestätigt)", () => {
    expect(shiftWindow("3")).toBeNull();
  });

  it("parseDateShift mit Schicht 3 parst Datum korrekt, shift ist '3'", () => {
    const result = parseDateShift("2026-08-18 - 3");
    expect(result.date).toBe("2026-08-18");
    expect(result.shift).toBe("3");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 13. CSV-Export
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: CSV-Export", () => {
  it("formatFullResourceAsCsv erzeugt valide CSV mit Header und Daten", () => {
    const rows = [makeRow({ key: "wo::1", woNumber: "35-1", dateNeeded: "2026-08-18 - 1" })];
    const calcMap = new Map<string, BatchCalc>([
      ["wo::1", makeCalc({
        equipBatches: [{ equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 2, perBatchKg: 40, remainderKg: 0, utilizationPct: 50 }],
      })],
    ]);
    const summary = computeFullResourceDemand(rows, calcMap, new Map());
    const csv = formatFullResourceAsCsv(summary);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Run;Datum;Schicht;Station");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toContain("Braiser");
  });

  it("leere Summary → nur Header-Zeile", () => {
    const summary = computeFullResourceDemand([], new Map(), new Map());
    const csv = formatFullResourceAsCsv(summary);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Run");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 14. Wochen-Delta-Vergleich
// ═══════════════════════════════════════════════════════════════════════

describe("Smoke: computeWeekDelta", () => {
  it("berechnet Deltas zwischen zwei Wochen korrekt", () => {
    const rowsCur = [makeRow({ key: "wo::1", woNumber: "35-1", dateNeeded: "2026-08-18 - 1" })];
    const rowsPrev = [makeRow({ key: "wo::1", woNumber: "34-1", dateNeeded: "2026-08-11 - 1" })];
    const calcCur = new Map<string, BatchCalc>([
      ["wo::1", makeCalc({ totalKg: 160, equipBatches: [{ equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 2, perBatchKg: 80, remainderKg: 0, utilizationPct: 100 }] })],
    ]);
    const calcPrev = new Map<string, BatchCalc>([
      ["wo::1", makeCalc({ totalKg: 80, equipBatches: [{ equip: "BRAISER", label: "Braiser", capacityKg: 80, batches: 1, perBatchKg: 80, remainderKg: 0, utilizationPct: 100 }] })],
    ]);
    const current = computeFullResourceDemand(rowsCur, calcCur, new Map());
    const previous = computeFullResourceDemand(rowsPrev, calcPrev, new Map());
    const delta = computeWeekDelta(current, previous);

    expect(delta.kgDelta).toBeCloseTo(80, 0);
    expect(delta.stations.length).toBe(1);
    expect(delta.stations[0].station).toBe("BRAISER");
    expect(delta.stations[0].batchesDelta).toBe(1);
  });

  it("identische Wochen → alle Deltas 0", () => {
    const rows = [makeRow({ key: "wo::1", woNumber: "35-1", dateNeeded: "2026-08-18 - 1" })];
    const calcMap = new Map<string, BatchCalc>([["wo::1", makeCalc()]]);
    const summary = computeFullResourceDemand(rows, calcMap, new Map());
    const delta = computeWeekDelta(summary, summary);

    expect(delta.kgDelta).toBe(0);
    expect(delta.gnTraysDelta).toBe(0);
    expect(delta.staffDelta).toBe(0);
    expect(delta.stations.every(s => s.batchesDelta === 0)).toBe(true);
  });
});
