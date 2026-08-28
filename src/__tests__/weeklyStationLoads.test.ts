import { describe, expect, it } from "vitest";
import type { Station } from "../core/types";
import {
  computeWeeklyStationLoads,
  BLAST_CHILLER_RACK_KG,
  BLAST_CHILLER_CYCLE_MIN,
  BLAST_CHILLER_WEEKLY_MINUTES_PER_DEVICE,
  WEEKLY_MINUTES_PER_DEVICE,
  THAW_ROOM_CAPACITY_KG,
  type WeekLoad,
} from "../lib/equipment";

// Minimaler WeekLoad-Stub: computeWeeklyStationLoads liest nur recipes[].subs[]
// (minutesPerStation, totalKg) und perStationMin.
function weekLoad(
  perStationMin: Partial<Record<Station, number>>,
  subs: Array<{ totalKg: number; minutesPerStation: Partial<Record<Station, number>> }>,
): WeekLoad {
  return {
    week: "2026-W36",
    recipes: [{ weekRecipe: {}, subs, perStationMin: {}, totalActiveMin: 0 }],
    perStationMin: perStationMin as Record<Station, number>,
    perStationDriversTop3: {} as WeekLoad["perStationDriversTop3"],
    totalActiveMin: 0,
  } as unknown as WeekLoad;
}

const find = (loads: ReturnType<typeof computeWeeklyStationLoads>, key: string) =>
  loads.find((l) => l.key === key);

describe("computeWeeklyStationLoads", () => {
  it("Minuten-Modell: 100 % genau bei devices × Wochenfenster", () => {
    const devices = 6; // Braiser-Default
    const loads = computeWeeklyStationLoads(
      weekLoad({ Braiser: devices * WEEKLY_MINUTES_PER_DEVICE }, []),
    );
    expect(find(loads, "Braiser")?.utilizationPct).toBeCloseTo(100, 5);
    expect(find(loads, "Braiser")?.model).toBe("minutes");
  });

  it("Blast Chiller: Rack-Durchsatz statt Koch-Batch-Minuten", () => {
    // 6 000 kg → ceil(6000/200) = 30 Racks → 30 × 90 min
    const subs = [{ totalKg: 6000, minutesPerStation: { "Blast Chiller": 42 } }];
    const loads = computeWeeklyStationLoads(weekLoad({}, subs));
    const bc = find(loads, "Blast Chiller")!;
    const expected = (30 * BLAST_CHILLER_CYCLE_MIN) / (6 * BLAST_CHILLER_WEEKLY_MINUTES_PER_DEVICE) * 100;
    expect(bc.model).toBe("chiller-racks");
    expect(bc.utilizationPct).toBeCloseTo(expected, 5);
  });

  it("Blast Chiller: Ergebnis hängt NICHT vom minutesPerBatch-Wert ab (der alte Bug)", () => {
    const a = computeWeeklyStationLoads(weekLoad({}, [{ totalKg: 6000, minutesPerStation: { "Blast Chiller": 20 } }]));
    const b = computeWeeklyStationLoads(weekLoad({}, [{ totalKg: 6000, minutesPerStation: { "Blast Chiller": 9000 } }]));
    expect(find(a, "Blast Chiller")?.utilizationPct).toBe(find(b, "Blast Chiller")?.utilizationPct);
  });

  it("Blast Chiller: Racks werden pro Sub-Rezept aufgerundet (Allergentrennung)", () => {
    // 2 × 250 kg → 2 × ceil(250/200)=2 Racks = 4 Racks, nicht ceil(500/200)=3
    const subs = [
      { totalKg: 250, minutesPerStation: { "Blast Chiller": 1 } },
      { totalKg: 250, minutesPerStation: { "Blast Chiller": 1 } },
    ];
    const bc = find(computeWeeklyStationLoads(weekLoad({}, subs)), "Blast Chiller")!;
    const expected = (4 * BLAST_CHILLER_CYCLE_MIN) / (6 * BLAST_CHILLER_WEEKLY_MINUTES_PER_DEVICE) * 100;
    expect(bc.utilizationPct).toBeCloseTo(expected, 5);
    void BLAST_CHILLER_RACK_KG;
  });

  it("Thaw: reines Kühlraum-kg-Modell", () => {
    const subs = [{ totalKg: THAW_ROOM_CAPACITY_KG / 2, minutesPerStation: { Thaw: 2880 } }];
    const thaw = find(computeWeeklyStationLoads(weekLoad({}, subs)), "Thaw")!;
    expect(thaw.model).toBe("thaw-room");
    expect(thaw.utilizationPct).toBeCloseTo(50, 5);
  });

  it("Stationen ohne Last tauchen nicht auf", () => {
    const loads = computeWeeklyStationLoads(weekLoad({ Braiser: 100 }, []));
    expect(find(loads, "Oven")).toBeUndefined();
    expect(find(loads, "Blast Chiller")).toBeUndefined();
  });

  it("gruppiert zusammengelegte Stationen zu einem Eintrag (Last summiert)", () => {
    const loads = computeWeeklyStationLoads(
      weekLoad({ "Immersion Blender": 2000, "Hand Mix": 4000 }, []),
    );
    // Kein separater Stabmixer-/Hand-Mix-Eintrag mehr
    expect(find(loads, "Immersion Blender")).toBeUndefined();
    expect(find(loads, "Hand Mix")).toBeUndefined();
    const group = find(loads, "Stabmixer / Hand Mix")!;
    expect(group.deviceCount).toBe(3);
    expect(group.utilizationPct).toBeCloseTo(6000 / (3 * WEEKLY_MINUTES_PER_DEVICE) * 100, 5);
  });

  it("Marinade + Hand Marinade = ein Eintrag mit 20 Geräten", () => {
    const loads = computeWeeklyStationLoads(weekLoad({ Marinade: 5000, "Hand Marinade": 1000 }, []));
    expect(find(loads, "Hand Marinade")).toBeUndefined();
    expect(find(loads, "Marinade")?.deviceCount).toBe(20);
  });

  it("Scooper wird nie geführt", () => {
    const loads = computeWeeklyStationLoads(weekLoad({ Scooper: 999999 }, []));
    expect(find(loads, "Scooper")).toBeUndefined();
    expect(loads).toHaveLength(0);
  });

  it("nach Auslastung absteigend sortiert", () => {
    const loads = computeWeeklyStationLoads(
      weekLoad({ Braiser: 6 * WEEKLY_MINUTES_PER_DEVICE, Oven: 6 * WEEKLY_MINUTES_PER_DEVICE * 0.3 }, []),
    );
    expect(loads[0].key).toBe("Braiser");
    expect(loads[0].utilizationPct).toBeGreaterThan(loads[1].utilizationPct);
  });
});
