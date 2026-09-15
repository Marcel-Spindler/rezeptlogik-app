/**
 * Rack-Bilanz HEUTE — wie viele Speed Racks / Oven Racks sind gerade unterwegs?
 *
 * Speed Racks  = ceil(GN-Bleche / 12)   je Station
 * Oven Racks   = ceil(Ofen-GN-Bleche / 18)  (laut Operations-Bible: 18 GN 2/1 / Oven Rack)
 *
 *   npx tsx scripts/rack-bilanz-heute.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EQUIP_DEFAULTS, type BatchCalc, type KetRow } from "../src/features/ket-plan/ketTypes";
import { calcBatch, woEntriesToKetRows, EMPTY_GN_HINTS, type GnHints } from "../src/features/ket-plan/ketLogic";
import { computeRunAssignments, type RunInfo } from "../src/features/ket-plan/ketRunLogic";
import { computeFullResourceDemand } from "../src/features/ket-plan/ketEquipmentSummary";
import { weekPrefixFromWoNumber } from "../src/features/wms-overview/wmsWeeks";
import { wrBuildHintsFromDumps } from "../src/features/kitchen-mode/wrEquipmentHints";
import type { DataBundle, WorkOrderEntry } from "../src/core/types";

const TODAY = new Date().toISOString().slice(0, 10);
const ROOT = process.cwd();
const TRAYS_PER_SPEED_RACK = 12;
const TRAYS_PER_OVEN_RACK = 18; // laut Operations-Bible "GN 2/1 tray units per OVEN RACK"

async function loadBundle(): Promise<DataBundle> {
  const res = await fetch("http://127.0.0.1:3142/api/local-db/bundle");
  if (!res.ok) throw new Error(`local-db-server nicht erreichbar (HTTP ${res.status})`);
  return res.json() as Promise<DataBundle>;
}

function loadGnHints(): GnHints {
  try {
    const bibles = JSON.parse(readFileSync(join(ROOT, "public/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json"), "utf8"));
    const { trayHints, pieceWeightKg } = wrBuildHintsFromDumps(null, bibles);
    return { trayHints, pieceWeightKg };
  } catch {
    return EMPTY_GN_HINTS;
  }
}

async function main() {
  console.log(`\nRack-Bilanz für ${TODAY} …`);
  const data = await loadBundle();
  const gnHints = loadGnHints();

  const woRows = ((data.productionPlan?.rows ?? []) as WorkOrderEntry[]).map(r => ({
    ...r,
    kitchenDay: r.kitchenDay ? r.kitchenDay.replace(/\//g, "-") : r.kitchenDay,
  }));

  const allRows: KetRow[] = woEntriesToKetRows(woRows);

  const byWeekPrefix = new Map<number, KetRow[]>();
  for (const row of allRows) {
    const wk = weekPrefixFromWoNumber(row.woNumber) ?? -1;
    if (!byWeekPrefix.has(wk)) byWeekPrefix.set(wk, []);
    byWeekPrefix.get(wk)!.push(row);
  }
  const runAssignments = new Map<string, RunInfo>();
  for (const rows of byWeekPrefix.values()) {
    for (const [k, v] of computeRunAssignments(rows)) runAssignments.set(k, v);
  }

  const batchCalcs = new Map<string, BatchCalc>();
  for (const row of allRows) {
    batchCalcs.set(row.key, calcBatch(row, EQUIP_DEFAULTS, data, undefined, undefined, gnHints));
  }

  const summary = computeFullResourceDemand(allRows, batchCalcs, runAssignments);

  const todayDemands = summary.byRunDayShift.filter(rd => rd.date === TODAY);
  if (todayDemands.length === 0) {
    const available = [...new Set(summary.byRunDayShift.map(rd => rd.date))].sort();
    console.warn(`Keine Plan-Daten für ${TODAY}. Verfügbar: ${available.join(", ")}`);
    process.exit(0);
  }

  // Stationen aggregieren (über alle Runs/Schichten des Tages)
  const stationAgg = new Map<string, {
    label: string; totalKg: number; gnTrays: number; ovenLoads: number; wannen: number; wos: Set<string>;
  }>();

  for (const rd of todayDemands) {
    for (const st of rd.stations) {
      if (!stationAgg.has(st.station)) {
        stationAgg.set(st.station, { label: st.label, totalKg: 0, gnTrays: 0, ovenLoads: 0, wannen: 0, wos: new Set() });
      }
      const a = stationAgg.get(st.station)!;
      a.totalKg += st.totalKg;
      a.gnTrays += st.gnTrays.reduce((s, t) => s + t.count, 0);
      if (st.ovenLoads != null) a.ovenLoads += st.ovenLoads;
      a.wannen += st.wannen;
      for (const wo of st.woNumbers) a.wos.add(wo);
    }
  }

  // Sheet 1: Stationsübersicht
  let totalSpeedRacks = 0;
  let totalOvenRacks = 0;
  let totalOvenLoads = 0;
  let totalGnTrays = 0;
  let totalWannen = 0;
  let totalKg = 0;

  const stationSheet: Record<string, unknown>[] = [];
  for (const [stKey, a] of [...stationAgg.entries()].sort((x, y) => y[1].totalKg - x[1].totalKg)) {
    const speedRacks = a.gnTrays > 0 ? Math.ceil(a.gnTrays / TRAYS_PER_SPEED_RACK) : 0;
    const ovenRacks = stKey === "OVEN" && a.gnTrays > 0 ? Math.ceil(a.gnTrays / TRAYS_PER_OVEN_RACK) : 0;
    totalSpeedRacks += speedRacks;
    totalOvenRacks += ovenRacks;
    totalOvenLoads += a.ovenLoads;
    totalGnTrays += a.gnTrays;
    totalWannen += a.wannen;
    totalKg += a.totalKg;
    stationSheet.push({
      Station: a.label,
      "kg": +a.totalKg.toFixed(1),
      Wannen: a.wannen || "—",
      "GN-Bleche": a.gnTrays || "—",
      "Speed Racks": speedRacks || "—",
      "Oven Racks (18 GN/Rack)": stKey === "OVEN" ? (ovenRacks || "—") : "",
      "Oven Ladevorgänge (40 kg/Rack)": stKey === "OVEN" ? (a.ovenLoads || "—") : "",
      WOs: a.wos.size,
    });
  }

  stationSheet.push({
    Station: "── GESAMT",
    "kg": +totalKg.toFixed(1),
    Wannen: totalWannen || "—",
    "GN-Bleche": totalGnTrays,
    "Speed Racks": totalSpeedRacks,
    "Oven Racks (18 GN/Rack)": totalOvenRacks,
    "Oven Ladevorgänge (40 kg/Rack)": totalOvenLoads,
    WOs: new Set(todayDemands.flatMap(rd => rd.stations.flatMap(s => s.woNumbers))).size,
  });

  // Sheet 2: Run/Schicht-Aufschlüsselung
  const runSheet: Record<string, unknown>[] = [];
  for (const rd of todayDemands.sort((a, b) => a.run - b.run || a.shift.localeCompare(b.shift))) {
    const gnAll = rd.stations.reduce((s, st) => s + st.gnTrays.reduce((ss, t) => ss + t.count, 0), 0);
    const ovenSt = rd.stations.find(s => s.station === "OVEN");
    const ovenGn = ovenSt ? ovenSt.gnTrays.reduce((s, t) => s + t.count, 0) : 0;
    runSheet.push({
      Run: rd.run,
      Schicht: rd.shift,
      "kg": +rd.totalKg.toFixed(1),
      "GN-Bleche": gnAll,
      "Speed Racks": gnAll > 0 ? Math.ceil(gnAll / TRAYS_PER_SPEED_RACK) : 0,
      "Oven Racks": ovenGn > 0 ? Math.ceil(ovenGn / TRAYS_PER_OVEN_RACK) : 0,
      Stationen: rd.stations.length,
      WOs: new Set(rd.stations.flatMap(s => s.woNumbers)).size,
    });
  }

  // Sheet 3: Legende
  const legend = [
    { Begriff: "Speed Rack", Erklärung: "Transportgestell mit 12 GN 2/1-Blechen. Läuft durch die gesamte Küche: Debox → Vorbereitung → Ofen/Braiser → Blast Chiller.", Formel: "ceil(GN-Bleche / 12)" },
    { Begriff: "Oven Rack", Erklärung: "Gestell das IN den Ofen geschoben wird. Laut Operations-Bible: 18 GN 2/1 Bleche pro Oven Rack.", Formel: "ceil(Ofen-GN-Bleche / 18)" },
    { Begriff: "Oven Ladevorgänge", Erklärung: "Wie oft der Ofen beladen werden muss. Kalkuliert auf Basis 40 kg Produkt je Rack-Kapazität im Ofen.", Formel: "ceil(kg_Ofen / 40)" },
    { Begriff: "GN-Bleche", Erklärung: "Berechnet aus Zutatengewichten × Dichte/GN aus Bibles-Dump. Pooling pro Zutat über alle WOs (kein Aufrunden je WO).", Formel: "ceil(kg_Zutat / kgPerGN) oder pcs / pcsPerTray" },
    { Begriff: "Wannen", Erklärung: "Braiser-Wannen (unabhängig von Racks, eigenes Behältersystem).", Formel: "ceil(kg / maxKg_Wanne)" },
    { Begriff: "Quelle", Erklärung: `Lokaler DB-Server (port 3142) + Bibles-JSON. Planwerte für ${TODAY}. Für Ist-Kg: npm run wms:sync-cache erst ausführen.`, Formel: "" },
  ];

  const XLSX = await import("xlsx");
  const nodeFs = await import("node:fs");
  (XLSX as any).set_fs(nodeFs);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stationSheet), "Stationen heute");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(runSheet), "Runs heute");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(legend), "Legende");

  const outPath = `C:/Users/MarcelSpindler/OneDrive - HelloFresh Group/Desktop/Rack-Bilanz-${TODAY}.xlsx`;
  XLSX.writeFile(wb, outPath);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Rack-Bilanz ${TODAY}`);
  console.log(`  Speed Racks gesamt : ${totalSpeedRacks}`);
  console.log(`  Oven Racks gesamt  : ${totalOvenRacks}  (à 18 GN-Bleche/Rack)`);
  console.log(`  Oven Ladevorgänge  : ${totalOvenLoads}`);
  console.log(`  GN-Bleche gesamt   : ${totalGnTrays}`);
  console.log(`  kg geplant         : ${totalKg.toFixed(0)} kg`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`\n✓  ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
