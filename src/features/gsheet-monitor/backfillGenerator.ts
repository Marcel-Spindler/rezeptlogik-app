// Backfill WO Generator — berechnet neue Work-Order-Vorschläge aus dem Backfill-Bedarf.
// Nutzt Equipment-Kapazitäten aus der Küchenbible + KET-Defaults für Chargengrößen.
import type { DataBundle, EquipBibleEntry } from "../../core/types";
import type { BackfillNeed } from "./postblastMatch";
import { EQUIP_DEFAULTS } from "../ket-plan/ketTypes";

export interface BackfillWoProposal {
  originalWo: string;
  backfillWoNumber: string;
  subRecipe: string;
  recipeCode: string;
  recipeName: string;
  missingKg: number;
  equipment: string;
  capacityKg: number;
  batchCount: number;
  totalProducedKg: number;
  excessKg: number;
  estimatedPortions: number;
  priority: "critical" | "behind" | "on-track";
  cookMethod: string;
  suggestedDay: string;
}

export interface BackfillPlan {
  proposals: BackfillWoProposal[];
  totalBatches: number;
  totalKg: number;
  totalPortions: number;
  criticalCount: number;
  generatedAt: string;
}

export function findEquipmentForSubRecipe(
  subRecipeName: string,
  cookMethods: string | undefined,
  bible: EquipBibleEntry[] | undefined
): { equipment: string; capacityKg: number } {
  const sub = subRecipeName.toLowerCase();

  // 1. Bible-Lookup
  if (bible && bible.length > 0) {
    for (const entry of bible) {
      if (entry.maxKg <= 0) continue;
      const item = entry.itemName.toLowerCase();
      // Fuzzy: mindestens 60% der Wörter müssen matchen
      const subWords = sub.split(/[\s\-_,]+/).filter(w => w.length > 2);
      const matchCount = subWords.filter(w => item.includes(w)).length;
      if (subWords.length > 0 && matchCount / subWords.length >= 0.5) {
        return { equipment: entry.source, capacityKg: entry.maxKg };
      }
    }
  }

  // 2. Cook-Method-basierter Fallback
  if (cookMethods) {
    const methods = cookMethods.toUpperCase();
    if (methods.includes("BRAIS")) return { equipment: "BRAISER", capacityKg: EQUIP_DEFAULTS.BRAISER };
    if (methods.includes("OVEN") || methods.includes("ROAST") || methods.includes("BAKE"))
      return { equipment: "OVEN", capacityKg: EQUIP_DEFAULTS.OVEN };
    if (methods.includes("MIX") || methods.includes("BLEND"))
      return { equipment: "PLANETARY MIXER", capacityKg: EQUIP_DEFAULTS["PLANETARY MIXER"] };
    if (methods.includes("SHRED"))
      return { equipment: "HOT SHREDDER", capacityKg: EQUIP_DEFAULTS["HOT SHREDDER"] };
  }

  // 3. Name-basierte Heuristik
  if (sub.includes("sauce") || sub.includes("chili") || sub.includes("soup") || sub.includes("stew"))
    return { equipment: "BRAISER", capacityKg: EQUIP_DEFAULTS.BRAISER };
  if (sub.includes("roast") || sub.includes("bake") || sub.includes("grill"))
    return { equipment: "OVEN", capacityKg: EQUIP_DEFAULTS.OVEN };
  if (sub.includes("mash") || sub.includes("mix") || sub.includes("blend"))
    return { equipment: "PLANETARY MIXER", capacityKg: EQUIP_DEFAULTS["PLANETARY MIXER"] };

  // 4. Default: Braiser (häufigstes Equipment)
  return { equipment: "BRAISER", capacityKg: EQUIP_DEFAULTS.BRAISER };
}

function suggestDay(): string {
  const now = new Date();
  // Nächster Arbeitstag
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  return next.toISOString().split("T")[0];
}

function generateBackfillWoNumber(originalWo: string, index: number): string {
  // Format: Original-WO + "B" + Index, z.B. "35-162" → "35-162B1"
  return `${originalWo}B${index + 1}`;
}

export function generateBackfillPlan(
  backfillNeeds: BackfillNeed[],
  data: DataBundle
): BackfillPlan {
  const proposals: BackfillWoProposal[] = [];
  const day = suggestDay();
  let bfIndex = 0;

  for (const need of backfillNeeds) {
    if (need.missingKg <= 0) continue;

    // Finde die Original-WO im Produktionsplan für Cook-Method
    const originalWoEntry = data.productionPlan?.rows.find(r => r.workOrder === need.workOrder);
    const cookMethods = originalWoEntry?.cookMethods ?? "";

    const { equipment, capacityKg } = findEquipmentForSubRecipe(
      need.subRecipe,
      cookMethods,
      data.equipmentBible
    );

    // Chargen berechnen (Guard gegen division by zero)
    const effectiveCapacity = capacityKg > 0 ? capacityKg : EQUIP_DEFAULTS.BRAISER;
    const batchCount = Math.ceil(need.missingKg / effectiveCapacity);
    const totalProducedKg = batchCount * effectiveCapacity;
    const excessKg = totalProducedKg - need.missingKg;

    proposals.push({
      originalWo: need.workOrder,
      backfillWoNumber: generateBackfillWoNumber(need.workOrder, bfIndex),
      subRecipe: need.subRecipe,
      recipeCode: need.recipeCode,
      recipeName: need.recipeName,
      missingKg: need.missingKg,
      equipment,
      capacityKg,
      batchCount,
      totalProducedKg,
      excessKg,
      estimatedPortions: need.estimatedPortions,
      priority: need.priority,
      cookMethod: cookMethods,
      suggestedDay: day,
    });

    bfIndex++;
  }

  return {
    proposals,
    totalBatches: proposals.reduce((s, p) => s + p.batchCount, 0),
    totalKg: proposals.reduce((s, p) => s + p.totalProducedKg, 0),
    totalPortions: proposals.reduce((s, p) => s + p.estimatedPortions, 0),
    criticalCount: proposals.filter(p => p.priority === "critical").length,
    generatedAt: new Date().toISOString(),
  };
}

export async function exportBackfillPlanExcel(plan: BackfillPlan, weekLabel: string): Promise<void> {
  const exceljs = await import("exceljs");
  const WorkbookClass = exceljs.Workbook || (exceljs as any).default?.Workbook;
  const workbook = new WorkbookClass();
  workbook.creator = "Rezeptlogik Verden — Backfill Generator";
  workbook.created = new Date();

  const border = {
    top: { style: "thin" as const, color: { argb: "FFCBD5E1" } },
    bottom: { style: "thin" as const, color: { argb: "FFCBD5E1" } },
    left: { style: "thin" as const, color: { argb: "FFCBD5E1" } },
    right: { style: "thin" as const, color: { argb: "FFCBD5E1" } },
  };

  // Sheet 1: Backfill-Plan
  const ws = workbook.addWorksheet("Backfill WOs", { views: [{ state: "frozen", ySplit: 2 }] });
  ws.columns = [
    { width: 14 }, { width: 14 }, { width: 36 }, { width: 14 },
    { width: 14 }, { width: 16 }, { width: 12 }, { width: 12 },
    { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 },
    { width: 14 },
  ];

  // Title
  ws.mergeCells("A1:M1");
  const title = ws.getCell("A1");
  title.value = `Backfill Work Orders — ${weekLabel} — generiert ${new Date().toLocaleString("de-DE")}`;
  title.font = { name: "Calibri", size: 14, bold: true, color: { argb: "FFFFFFFF" } };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
  title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(1).height = 26;

  // Header
  const header = ws.addRow([
    "Backfill-WO", "Original-WO", "Sub-Rezept", "Meal-Code",
    "Prio", "Equipment", "Kapazität (kg)", "Chargen",
    "Fehlt (kg)", "Produziert (kg)", "Überschuss (kg)", "~ Portionen",
    "Vorgeschl. Tag",
  ]);
  header.eachCell(cell => {
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
    cell.border = border;
  });

  for (const p of plan.proposals) {
    const row = ws.addRow([
      p.backfillWoNumber,
      p.originalWo,
      p.subRecipe,
      p.recipeCode,
      p.priority === "critical" ? "KRITISCH" : p.priority === "behind" ? "HINTER PLAN" : "OK",
      p.equipment,
      p.capacityKg,
      p.batchCount,
      Number(p.missingKg.toFixed(2)),
      Number(p.totalProducedKg.toFixed(2)),
      Number(p.excessKg.toFixed(2)),
      p.estimatedPortions,
      p.suggestedDay,
    ]);
    row.eachCell((cell, col) => {
      cell.border = border;
      cell.alignment = { vertical: "middle", horizontal: col >= 7 ? "right" : "left" };
      if (p.priority === "critical") {
        cell.font = { name: "Calibri", size: 10, color: { argb: "FF991B1B" } };
      }
    });
  }

  // Summary row
  ws.addRow([]);
  const sumRow = ws.addRow([
    "GESAMT", "", "", "",
    `${plan.criticalCount} kritisch`, "",
    "", plan.totalBatches,
    "", Number(plan.totalKg.toFixed(2)), "",
    plan.totalPortions, "",
  ]);
  sumRow.eachCell(cell => {
    cell.font = { name: "Calibri", size: 10, bold: true };
    cell.border = border;
  });

  // Sheet 2: Zusammenfassung nach Equipment
  const equipSheet = workbook.addWorksheet("Nach Equipment");
  equipSheet.columns = [{ width: 24 }, { width: 12 }, { width: 14 }, { width: 16 }];
  equipSheet.addRow(["Equipment", "Chargen", "Gesamt kg", "WOs"]).eachCell(cell => {
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0369A1" } };
    cell.border = border;
  });

  const byEquip = new Map<string, { batches: number; kg: number; wos: number }>();
  for (const p of plan.proposals) {
    const e = byEquip.get(p.equipment) ?? { batches: 0, kg: 0, wos: 0 };
    e.batches += p.batchCount;
    e.kg += p.totalProducedKg;
    e.wos += 1;
    byEquip.set(p.equipment, e);
  }
  for (const [equip, stats] of byEquip) {
    equipSheet.addRow([equip, stats.batches, Number(stats.kg.toFixed(2)), stats.wos]).eachCell(cell => { cell.border = border; });
  }

  // Download
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `backfill_workorders_${weekLabel}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
}
