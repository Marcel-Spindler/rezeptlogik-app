import {
  rackV2AutoFillLayout,
  rackV2SlotPurpose,
  rackV2EntryPurpose,
  rackV2SlotNumber,
  rackV2PackagingZoneForEntry,
  rackV2PackagingAllowedSlots,
  rackV2PurposeSlots,
  rackV2BlockForSlot,
  rackV2EntryFingerprint,
  rackV2IsIceLike,
  type RackV2MarketId,
} from "../src/rackV2.ts";
import { type RackEntry } from "../src/rack.ts";

// ---------------------------------------------------------------------------
// Ergonomie-Gewichtung: T2 = optimal, T1 = bücken (+20%), T3 = strecken (+30%)
// ---------------------------------------------------------------------------
const TIER_WEIGHT: Record<1 | 2 | 3, number> = { 1: 1.2, 2: 1.0, 3: 1.3 };
const TIER_LABEL: Record<1 | 2 | 3, string> = { 1: "unten (bücken)", 2: "Mitte (optimal)", 3: "oben (strecken)" };

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function makeEntry(recipe: string, sku: string, displayName = "", quantity = 1): RackEntry {
  return {
    id: crypto.randomUUID(),
    recipe,
    sku,
    ingredient: "",
    displayName,
    line: "",
    flowRackPosition: "",
    quantity,
    scanRegEx: "",
    labelPos: "",
    uniCode: "",
    gramage: "",
    sort: 0,
    source: "manual",
  };
}

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ✅ ${label}${detail ? `: ${detail}` : ""}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? `: ${detail}` : ""}`);
    failed++;
  }
}

function header(title: string) {
  console.log(`\n${"─".repeat(65)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(65));
}

function bar(value: number, max: number, width = 20): string {
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// TEST 1: Grundplatzierung (je 1 Eintrag pro Typ)
// ---------------------------------------------------------------------------

function testGrundplatzierung(market: RackV2MarketId) {
  header(`TEST 1 – Grundplatzierung [${market}]`);

  const pool: RackEntry[] = [
    makeEntry("MEAL-001", "CON-001"),
    makeEntry("Ice1", "IcePack"),
    makeEntry("smoothie-mango", "CON-002", "Mango Smoothie"),
    makeEntry("flyer-promo", "CON-003"),
    makeEntry("gift-card", "Loyalties"),
    makeEntry("S", "BOX-S"),
    ...(market === "DE" ? [makeEntry("Factor Liner", "FL-001")] : []),
  ];

  const result = rackV2AutoFillLayout([], pool, market);

  for (const entry of result) {
    const slot = rackV2SlotNumber(entry.flowRackPosition);
    const tier = (entry.tier ?? 1) as 1 | 2 | 3;
    if (slot <= 12) {
      const zone = rackV2PackagingZoneForEntry(entry);
      const allowedSlots = rackV2PackagingAllowedSlots(market, zone);
      check(
        `Packaging ${zone} (${entry.recipe}) → F${String(slot).padStart(2, "0")} T${tier}`,
        allowedSlots.includes(slot),
        allowedSlots.includes(slot) ? "OK" : `NICHT erlaubt (erlaubt: ${allowedSlots.join(",")})`
      );
    } else {
      const actual = rackV2SlotPurpose(slot, tier, market);
      const expected = rackV2EntryPurpose(entry, market);
      check(
        `${expected.padEnd(8)} (${entry.recipe}) → F${String(slot).padStart(3, "0")} T${tier}`,
        actual === expected,
        actual !== expected ? `Slot-Zweck ist "${actual}"` : "OK"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// TEST 2: Alle Meal-Slots 100% befüllt
// ---------------------------------------------------------------------------

function testAlleMealSlots(market: RackV2MarketId) {
  header(`TEST 2 – Alle Meal-Slots 100% [${market}]`);

  const mealSlots = rackV2PurposeSlots(market, "meal");
  console.log(`  ${mealSlots.length} Meal-Slots im Markt ${market}`);

  const meals = Array.from({ length: mealSlots.length + 5 }, (_, i) =>
    makeEntry(`meal-${i + 1}`, `CON-${2000 + i}`)
  );

  const result = rackV2AutoFillLayout([], meals, market);

  const filledSlotKeys = new Set<string>();
  for (const entry of result) {
    const slot = rackV2SlotNumber(entry.flowRackPosition);
    if (slot <= 12) continue;
    const tier = (entry.tier ?? 1) as 1 | 2 | 3;
    if (rackV2SlotPurpose(slot, tier, market) === "meal") filledSlotKeys.add(`${slot}:${tier}`);
  }

  let allOk = true;
  for (const { slot, tier } of mealSlots) {
    if (!filledSlotKeys.has(`${slot}:${tier}`)) {
      console.log(`  ❌ F${String(slot).padStart(3, "0")} T${tier} NICHT befüllt`);
      failed++;
      allOk = false;
    }
  }

  check(
    `Alle ${mealSlots.length} Meal-Slots befüllt`,
    allOk && filledSlotKeys.size === mealSlots.length,
    `${filledSlotKeys.size}/${mealSlots.length}`
  );
}

// ---------------------------------------------------------------------------
// TEST 3: Kein doppeltes Meal pro Linie (Eis-Ausnahme bei DE)
// ---------------------------------------------------------------------------

function testKeinDuplikat(market: RackV2MarketId) {
  header(`TEST 3 – Kein doppeltes Meal [${market}]`);

  const mealSlots = rackV2PurposeSlots(market, "meal");
  const meals = Array.from({ length: mealSlots.length + 5 }, (_, i) =>
    makeEntry(`meal-${i + 1}`, `CON-${3000 + i}`)
  );

  const result = rackV2AutoFillLayout([], meals, market);
  const seen = new Map<string, string>();
  let dupCount = 0;

  for (const entry of result) {
    const slot = rackV2SlotNumber(entry.flowRackPosition);
    if (slot <= 12) continue;
    if (rackV2IsIceLike(entry)) continue;
    const fp = rackV2EntryFingerprint(entry);
    const existing = seen.get(fp);
    if (existing) {
      console.log(`  ❌ Duplikat: ${entry.recipe} auf ${existing} UND ${entry.flowRackPosition}`);
      failed++;
      dupCount++;
    } else {
      seen.set(fp, entry.flowRackPosition);
    }
  }

  check(
    "Keine doppelten Meals",
    dupCount === 0,
    dupCount > 0 ? `${dupCount} Duplikate` : `${seen.size} eindeutige Einträge`
  );
}

// ---------------------------------------------------------------------------
// TEST 4 + ANALYSE: Ergonomie & Pickface-Balance
// ---------------------------------------------------------------------------

function analyseErgonomie(market: RackV2MarketId) {
  header(`ANALYSE – Ergonomie & Pickface-Balance [${market}]`);

  const mealSlots = rackV2PurposeSlots(market, "meal");

  // Realistische Pickmengen: 50–500, abnehmend (Top-Seller zuerst)
  const meals = Array.from({ length: mealSlots.length }, (_, i) => {
    const qty = Math.max(50, 500 - i * 18);
    return makeEntry(`meal-${i + 1}`, `CON-${5000 + i}`, "", qty);
  });

  const result = rackV2AutoFillLayout([], meals, market);
  const mealResults = result.filter((e) => {
    const slot = rackV2SlotNumber(e.flowRackPosition);
    return slot > 12 && rackV2SlotPurpose(slot, (e.tier ?? 1) as 1 | 2 | 3, market) === "meal";
  });

  // ── Tier-Verteilung der Pickmengen ───────────────────────────────────────
  console.log("\n  TIER-VERTEILUNG (Gesamtpicks pro Ebene):");
  const byTier: Record<number, { picks: number; count: number }> = { 1: { picks: 0, count: 0 }, 2: { picks: 0, count: 0 }, 3: { picks: 0, count: 0 } };
  for (const e of mealResults) {
    const t = e.tier ?? 1;
    byTier[t].picks += e.quantity;
    byTier[t].count++;
  }
  const totalPicks = Object.values(byTier).reduce((s, v) => s + v.picks, 0);
  for (const t of [2, 1, 3] as const) {
    const { picks, count } = byTier[t];
    const pct = totalPicks > 0 ? ((picks / totalPicks) * 100).toFixed(1) : "0.0";
    console.log(`  T${t} ${TIER_LABEL[t].padEnd(20)}: ${String(picks).padStart(6)} Picks (${pct}%) ${count} Meals  ${bar(picks, totalPicks)}`);
  }

  // Ergonomie-Prüfung: Sind die Top-Picks auf T2?
  const sortedByQty = [...mealResults].sort((a, b) => b.quantity - a.quantity);
  const t2Count = mealSlots.filter((s) => s.tier === 2).length;
  const topMeals = sortedByQty.slice(0, t2Count);
  const topOnT2 = topMeals.filter((e) => e.tier === 2).length;

  console.log(`\n  ERGONOMIE-CHECK: Top-${t2Count} Meals (höchste Qty) auf T2?`);
  check(
    `Top-${t2Count} Meals auf optimaler Ebene T2`,
    topOnT2 === t2Count,
    `${topOnT2}/${t2Count} auf T2`
  );

  // Durchschnittliche Qty nach Tier
  for (const t of [2, 1, 3] as const) {
    const entries = mealResults.filter((e) => e.tier === t);
    if (entries.length === 0) continue;
    const avg = entries.reduce((s, e) => s + e.quantity, 0) / entries.length;
    console.log(`  Ø Qty auf T${t}: ${avg.toFixed(0)} Picks`);
  }

  // ── Ergonomische Gesamtlast pro Pickface ─────────────────────────────────
  console.log("\n  PICKFACE-BALANCE (Picks + ergonomische Gewichtung):");

  type PFStats = { rawPicks: number; ergoPicks: number; slots: number; t1: number; t2: number };
  const byPickface: Record<string, PFStats> = {};

  for (const e of mealResults) {
    const slot = rackV2SlotNumber(e.flowRackPosition);
    const tier = (e.tier ?? 1) as 1 | 2 | 3;
    const block = rackV2BlockForSlot(slot, market);
    const label = block?.pLabel ?? block?.label ?? "?";
    if (!byPickface[label]) byPickface[label] = { rawPicks: 0, ergoPicks: 0, slots: 0, t1: 0, t2: 0 };
    byPickface[label].rawPicks += e.quantity;
    byPickface[label].ergoPicks += Math.round(e.quantity * TIER_WEIGHT[tier]);
    byPickface[label].slots += 1;
    if (tier === 1) byPickface[label].t1 += e.quantity;
    if (tier === 2) byPickface[label].t2 += e.quantity;
  }

  const labels = Object.keys(byPickface).sort();
  const ergoTotals = labels.map((l) => byPickface[l].ergoPicks);
  const maxErgo = Math.max(...ergoTotals);
  const minErgo = Math.min(...ergoTotals);
  const meanErgo = ergoTotals.reduce((a, b) => a + b, 0) / ergoTotals.length;
  const spanne = ((maxErgo - minErgo) / meanErgo) * 100;

  console.log(`  ${"P".padEnd(5)} ${"Picks".padStart(6)} ${"T2".padStart(6)} ${"T1".padStart(6)} ${"Ergo".padStart(6)}  Auslastung`);
  console.log(`  ${"─".repeat(60)}`);
  for (const label of labels) {
    const { rawPicks, ergoPicks, t1, t2 } = byPickface[label];
    console.log(
      `  ${label.padEnd(5)} ${String(rawPicks).padStart(6)} ${String(t2).padStart(6)} ${String(t1).padStart(6)} ${String(ergoPicks).padStart(6)}  ${bar(ergoPicks, maxErgo)}`
    );
  }

  console.log(`\n  Ø Ergo-Last: ${meanErgo.toFixed(0)} | Min: ${minErgo} | Max: ${maxErgo} | Spanne: ${spanne.toFixed(1)}%`);

  // ── Verbesserungsideen ───────────────────────────────────────────────────
  console.log("\n  IDEEN FÜR BESSERE BALANCE:");

  // Idee 1: Sind T2-Slots über Pickfaces verteilt oder geclustert?
  const t2Pickfaces = labels.filter((l) => byPickface[l].t2 > 0).length;

  if (t2Pickfaces < labels.length) {
    console.log(`  💡 [T2-Verteilung] ${labels.length - t2Pickfaces} Pickface(s) haben KEIN T2-Meal-Slot.`);
    console.log(`     → Slot-Reihenfolge in rackV2.ts auf Round-Robin umstellen:`);
    console.log(`       statt [P1-T2, P1-T2, P2-T2, P2-T2, ...] → [P1-T2, P2-T2, P3-T2, ..., P1-T2, ...]`);
    console.log(`       Damit bekämen alle Pickfaces die höchsten Picks auf T2 statt nur die ersten.`);
  }

  // Idee 2: Spanne zu groß?
  if (spanne > 30) {
    const maxLabel = labels.reduce((a, b) => byPickface[a].ergoPicks > byPickface[b].ergoPicks ? a : b);
    const minLabel = labels.reduce((a, b) => byPickface[a].ergoPicks < byPickface[b].ergoPicks ? a : b);
    console.log(`  💡 [Workload-Balance] ${maxLabel} hat ${byPickface[maxLabel].ergoPicks} Ergo-Picks, ${minLabel} nur ${byPickface[minLabel].ergoPicks}.`);
    console.log(`     → Meal-Zuweisung könnte Pickface-Last berücksichtigen:`);
    console.log(`       Nächstes Meal immer dem aktuell schwächsten Pickface zuweisen`);
    console.log(`       statt einfach sequenziell durch die Slot-Liste zu gehen.`);
  }

  // Idee 3: T1-Anteil bei hohen Pickmengen
  const highQtyOnT1 = mealResults.filter((e) => e.tier === 1 && e.quantity > 150);
  if (highQtyOnT1.length > 0) {
    console.log(`  💡 [T1 mit hohen Picks] ${highQtyOnT1.length} Meal(s) >150 Picks auf T1 (Bücken!):`);
    for (const e of highQtyOnT1) {
      console.log(`     ${e.recipe}: ${e.quantity} Picks auf ${e.flowRackPosition} T1`);
    }
    console.log(`     → Ergonomisch wäre T2 besser. Slot-Reihenfolge oder Sortierung anpassen.`);
  }

  return spanne;
}

// ---------------------------------------------------------------------------
// Alle Tests ausführen
// ---------------------------------------------------------------------------

const markets: RackV2MarketId[] = ["DE", "DKSE", "BENL"];

for (const market of markets) {
  testGrundplatzierung(market);
  testAlleMealSlots(market);
  testKeinDuplikat(market);
}

const spannen: Record<string, number> = {};
for (const market of markets) {
  spannen[market] = analyseErgonomie(market);
}

console.log(`\n${"═".repeat(65)}`);
console.log(`  GESAMTERGEBNIS: ${passed} bestanden | ${failed} fehlgeschlagen`);
console.log(`\n  ERGONOMIE-SPANNE (Pickface-Balance):`);
for (const [m, s] of Object.entries(spannen)) {
  const icon = s <= 30 ? "✅" : s <= 60 ? "⚠️ " : "❌";
  console.log(`  ${icon} ${m}: ${s.toFixed(1)}% Abweichung ${s <= 30 ? "(gut)" : s <= 60 ? "(akzeptabel)" : "(optimierbar)"}`);
}
console.log("═".repeat(65));
if (failed > 0) process.exit(1);
