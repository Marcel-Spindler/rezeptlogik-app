// Einmaliges Ad-hoc-Skript: Equipment-Bedarf (Wannen/Bleche/Racks/kg) tag-genau
// für die letzten Wochen als Excel exportieren. Läuft headless über den lokalen
// DB-Server (kein Browser nötig) und nutzt exakt dieselbe Berechnung wie
// KetEquipmentPanel (computeFullResourceDemand) — inkl. des Pooling-Fixes vom
// 2026-09-14 (Wannen/Bleche werden jetzt pro Zutat über alle WOs gepoolt bevor
// gerundet wird, statt pro WO-Zeile einzeln aufzurunden).
//
//   npx tsx scripts/ket-equipment-history-export.ts
//
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EQUIP_DEFAULTS, type BatchCalc, type KetRow } from "../src/features/ket-plan/ketTypes";
import { calcBatch, woEntriesToKetRows, EMPTY_GN_HINTS, type GnHints } from "../src/features/ket-plan/ketLogic";
import { computeRunAssignments, type RunInfo } from "../src/features/ket-plan/ketRunLogic";
import { computeFullResourceDemand, type StationDemand } from "../src/features/ket-plan/ketEquipmentSummary";
import { weekPrefixFromWoNumber } from "../src/features/wms-overview/wmsWeeks";
import { wrBuildHintsFromDumps } from "../src/features/kitchen-mode/wrEquipmentHints";
import type { DataBundle, WorkOrderEntry } from "../src/core/types";

const TODAY = "2026-09-14"; // "rückwirkend" — nur Tage bis heute (keine geplanten Zukunftstage)
const ROOT = process.cwd(); // Skript wird aus dem Projekt-Root heraus gestartet

async function loadBundle(): Promise<DataBundle> {
  const res = await fetch("http://127.0.0.1:3142/api/local-db/bundle");
  if (!res.ok) throw new Error(`local-db-server antwortet nicht (HTTP ${res.status})`);
  const bundle = await res.json() as DataBundle;

  // enrich() nachbilden (siehe src/core/dataSource.ts) — mealCatalog/recipeProfiles
  // aus den statischen public/data-Dateien nachladen, falls die lokale DB sie nicht
  // schon mitliefert.
  try {
    const mealCatalog = JSON.parse(readFileSync(join(ROOT, "public/data/meal-catalog.json"), "utf8"));
    if (mealCatalog?.mealCatalog && Object.keys(mealCatalog.mealCatalog).length > 0) {
      bundle.mealCatalog = mealCatalog.mealCatalog;
    }
  } catch { /* optional */ }
  try {
    const profiles = JSON.parse(readFileSync(join(ROOT, "public/data/recipe-profiles.json"), "utf8"));
    if (profiles?.profiles && Object.keys(profiles.profiles).length > 0) {
      (bundle as unknown as { recipeProfiles?: unknown }).recipeProfiles = profiles.profiles;
    }
  } catch { /* optional */ }

  return bundle;
}

function loadGnHints(): GnHints {
  try {
    const bibles = JSON.parse(readFileSync(join(ROOT, "public/data/gsheet-dump-Bibles_K_Operations_Manager_Supervisors.json"), "utf8"));
    const { trayHints, pieceWeightKg } = wrBuildHintsFromDumps(null, bibles);
    return { trayHints, pieceWeightKg };
  } catch (e) {
    console.warn("[ket-export] GN-Hints nicht ladbar, fahre ohne fort:", e);
    return EMPTY_GN_HINTS;
  }
}

const WEEKDAYS: Record<string, string> = { "1": "Mo", "2": "Di", "3": "Mi", "4": "Do", "5": "Fr", "6": "Sa", "0": "So" };
function weekdayLabel(dateStr: string): string {
  try { return WEEKDAYS[String(new Date(dateStr + "T00:00:00Z").getUTCDay())] ?? ""; } catch { return ""; }
}

async function main() {
  console.log("Lade DataBundle vom lokalen DB-Server …");
  const data = await loadBundle();
  const gnHints = loadGnHints();

  // kitchenDay kommt je nach Quell-Sheet mal als "YYYY-MM-DD - <Schicht>", mal
  // als "YYYY/MM/DD - <Schicht>" (Slash statt Bindestrich) — parseDateShift
  // erkennt nur die Bindestrich-Form, sonst bleibt date="" bzw. der ganze
  // Rohstring inkl. Schicht stehen und der Tag fällt aus der Gruppierung raus.
  const woRows = ((data.productionPlan?.rows ?? []) as WorkOrderEntry[]).map(r => ({
    ...r,
    kitchenDay: r.kitchenDay ? r.kitchenDay.replace(/\//g, "-") : r.kitchenDay,
  }));
  console.log(`productionPlan.rows: ${woRows.length}`);

  const allRows: KetRow[] = woEntriesToKetRows(woRows);
  console.log(`KetRows gesamt: ${allRows.length}`);

  // Run-Zuteilung ist ein Innerhalb-der-Woche-Konzept (siehe ketRunLogic.ts) —
  // exakt wie KetBreakdownView: pro WO-Wochen-Präfix separat berechnen, dann
  // zusammenführen (statt fälschlich über mehrere Wochen hinweg zu schätzen).
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

  // Nur Tage bis heute (rückwirkend) — geplante Zukunftstage im Plan ausblenden.
  const pastDemands = summary.byRunDayShift.filter(rd => rd.date <= TODAY);
  const days = [...new Set(pastDemands.map(rd => rd.date))].sort();
  console.log(`Tage im Zeitraum (<= ${TODAY}): ${days.join(", ")}`);

  // ── Sheet 1: Tages-Übersicht (über Run+Schicht gemergt) ───────────────────
  const dayRows = days.map(date => {
    const rds = pastDemands.filter(rd => rd.date === date);
    const wos = new Set<string>();
    for (const rd of rds) for (const st of rd.stations) for (const wo of st.woNumbers) wos.add(wo);
    return {
      Datum: date,
      Wochentag: weekdayLabel(date),
      WOs: wos.size,
      "kg": +rds.reduce((s, rd) => s + rd.totalKg, 0).toFixed(1),
      "GN-Bleche": rds.reduce((s, rd) => s + rd.totalGnTrays, 0),
      "Wannen": rds.reduce((s, rd) => s + rd.totalWannen, 0),
      "Racks": rds.reduce((s, rd) => s + rd.totalRacksNeeded, 0),
      "Krit. Pfad (h)": +(Math.max(0, ...rds.map(rd => rd.criticalPathMinutes)) / 60).toFixed(1),
      "MA-Bedarf (Peak)": Math.max(0, ...rds.map(rd => rd.totalStaffNeeded)),
    };
  });

  // ── Sheet 2: Station-Detail je Tag (über Run+Schicht gemergt, wie im Panel) ─
  type StationRollup = StationDemand;
  const stationRows: Record<string, unknown>[] = [];
  for (const date of days) {
    const rds = pastDemands.filter(rd => rd.date === date);
    const stationMap = new Map<string, StationRollup>();
    for (const rd of rds) {
      for (const st of rd.stations) {
        const existing = stationMap.get(st.station);
        if (existing) {
          existing.totalBatches += st.totalBatches;
          existing.totalKg = +(existing.totalKg + st.totalKg).toFixed(2);
          existing.estimatedMinutes += st.estimatedMinutes;
          existing.effectiveMinutes += st.effectiveMinutes;
          existing.wannen += st.wannen;
          for (const t of st.gnTrays) {
            const eg = existing.gnTrays.find(g => g.gnType === t.gnType);
            if (eg) eg.count += t.count; else existing.gnTrays.push({ ...t });
          }
          if (st.ovenLoads != null) existing.ovenLoads = (existing.ovenLoads ?? 0) + st.ovenLoads;
          for (const wo of st.woNumbers) if (!existing.woNumbers.includes(wo)) existing.woNumbers.push(wo);
          for (const a of st.allergensPresent) if (!existing.allergensPresent.includes(a)) existing.allergensPresent.push(a);
        } else {
          stationMap.set(st.station, { ...st, gnTrays: st.gnTrays.map(t => ({ ...t })), woNumbers: [...st.woNumbers], allergensPresent: [...st.allergensPresent], scoopsNeeded: [...st.scoopsNeeded] });
        }
      }
    }
    const racksPerStation = 12; // DEFAULT_TRAYS_PER_RACK, siehe ketEquipmentSummary.ts
    for (const st of [...stationMap.values()].sort((a, b) => b.totalBatches - a.totalBatches)) {
      const gnTotal = st.gnTrays.reduce((s, t) => s + t.count, 0);
      stationRows.push({
        Datum: date,
        Wochentag: weekdayLabel(date),
        Station: st.label,
        Batches: st.totalBatches,
        "kg": st.totalKg,
        "Dauer (h)": +(st.estimatedMinutes / 60).toFixed(1),
        "Effektiv (h)": +(st.effectiveMinutes / 60).toFixed(1),
        "Geräte": st.deviceCount,
        "Wannen": st.wannen,
        "GN-Bleche": st.gnTrays.map(t => `${t.count}×${t.gnType}`).join(", ") || "—",
        "Racks": gnTotal > 0 ? Math.ceil(gnTotal / racksPerStation) : 0,
        "MA-Bedarf": st.staffNeeded,
        "Allergene": st.allergensPresent.join(", "),
        "WOs": st.woNumbers.join(", "),
      });
    }
  }

  // ── Sheet 3: Engpässe im Zeitraum ─────────────────────────────────────────
  const bottleneckRows = summary.bottlenecks
    .filter(b => b.date <= TODAY)
    .map(b => ({
      Datum: b.date, Run: b.run, Station: b.label, Batches: b.totalBatches,
      "Geschätzt (h)": b.estimatedHours, "Effektiv (h)": b.effectiveHours,
      Geräte: b.deviceCount, "Schicht verfügbar (h)": b.shiftHoursAvailable, Grund: b.reason,
    }));

  const XLSX = await import("xlsx");
  const nodeFs = await import("node:fs");
  XLSX.set_fs(nodeFs); // ESM-Build von xlsx registriert fs in Node nicht automatisch
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dayRows), "Tage");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stationRows), "Stationen je Tag");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bottleneckRows.length > 0 ? bottleneckRows : [{ Hinweis: "Keine Engpässe im Zeitraum" }]), "Engpässe");

  // Achtung: Desktop ist per OneDrive Known-Folder-Move umgeleitet — NICHT
  // C:\Users\<user>\Desktop (das ist ein leerer Legacy-Ordner, den Explorer
  // nicht mehr als "Desktop" anzeigt).
  const outPath = join("C:/Users/MarcelSpindler/OneDrive - HelloFresh Group/Desktop", "KET-Equipment-letzte-Wochen.xlsx");
  XLSX.writeFile(wb, outPath);
  console.log(`\nGeschrieben: ${outPath}`);
  console.log(`Tage: ${days.length} · Stationen-Zeilen: ${stationRows.length} · Engpässe: ${bottleneckRows.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
