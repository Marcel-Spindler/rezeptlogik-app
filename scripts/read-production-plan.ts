import { google } from "googleapis";
import type { ProductionPlan, WorkOrderEntry } from "../src/types.ts";
import { num, parseRecipeName } from "./lib/helpers.ts";
import { getAuthClient, getAllTabNames, findCurrentWeekTab } from "./lib/gsheet-helpers.ts";

export async function readProductionPlan(spreadsheetId: string): Promise<ProductionPlan | undefined> {
  if (!spreadsheetId) return undefined;
  const client = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth: client as any });

  let tabName = process.env.SHEET_FERTIGSTELLUNG_TAB?.trim();
  if (!tabName) {
    const allTabs = await getAllTabNames(sheets, spreadsheetId);
    tabName = findCurrentWeekTab(allTabs, ["W{XX} Transperancy", "W{XX} Transparency", "BENL Outbound W{XX}"]);
    if (!tabName) tabName = allTabs[0];
  }
  if (!tabName) { console.warn("  Fertigstellung: kein Tab gefunden"); return undefined; }

  let rows: any[][];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tabName}'!A1:N2000` });
    rows = res.data.values ?? [];
  } catch (e: any) {
    console.warn(`  Fertigstellung Lesen fehlgeschlagen: ${e?.message ?? e}`);
    return undefined;
  }

  const tabWeekMatch = /W(\d{1,2})/i.exec(tabName);
  const year = new Date().getFullYear();
  const week = tabWeekMatch
    ? `${year}-W${String(parseInt(tabWeekMatch[1], 10)).padStart(2, "0")}`
    : `${year}-W??`;

  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i].map((c: unknown) => String(c ?? "").trim().toLowerCase());
    if (r.some(c => c.includes("work order")) && r.some(c => c === "recipe")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    console.warn(`  Fertigstellung: Header nicht gefunden in Tab "${tabName}"`);
    return undefined;
  }

  const header = rows[headerIdx].map((c: unknown) => String(c ?? "").trim().toLowerCase());
  const runIdx     = header.findIndex(c => c === "run");
  const dayIdx     = header.findIndex(c => c.includes("kitchen day") || c.includes("planned kitchen"));
  const woIdx      = header.findIndex(c => c === "work order");
  const recipeIdx  = header.findIndex(c => c === "recipe");
  const subIdx     = header.findIndex(c => c.includes("sub recipe") || c === "sub recipe");
  const mealsIdx   = header.findIndex(c => c.includes("planned meals") || c === "planned meals");
  const stagingIdx = header.findIndex(c => c.includes("staging"));
  const kitchenIdx = header.findIndex(c => c.includes("kitchen") && c.includes("kg"));
  const postIdx    = header.findIndex(c => c.includes("post"));
  const yieldIdx   = header.findIndex(c => c === "yield");
  const logTgtIdx  = header.findLastIndex(c => c === "target");

  const entries: WorkOrderEntry[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const woCell = woIdx >= 0 ? String(row[woIdx] ?? "").trim() : "";
    if (!woCell || !/^\d{2}-\d{3,}/.test(woCell)) continue;

    const fullRecipe = recipeIdx >= 0 ? String(row[recipeIdx] ?? "").trim() : "";
    const { code: recipeCode } = parseRecipeName(fullRecipe);
    const yieldRaw = String(row[yieldIdx >= 0 ? yieldIdx : 9] ?? "").replace("%", "").trim();
    const yieldPct = parseFloat(yieldRaw.replace(",", ".")) || 0;

    entries.push({
      run:            runIdx >= 0 ? (parseInt(String(row[runIdx] ?? ""), 10) || 0) : 0,
      kitchenDay:     dayIdx >= 0 ? String(row[dayIdx] ?? "").trim() : "",
      workOrder:      woCell,
      recipeCode,
      recipeName:     fullRecipe,
      subRecipe:      subIdx >= 0 ? String(row[subIdx] ?? "").trim() : "",
      plannedMeals:   mealsIdx >= 0 ? num(row[mealsIdx]) : 0,
      stagingKg:      stagingIdx >= 0 ? num(row[stagingIdx]) : 0,
      kitchenKg:      kitchenIdx >= 0 ? num(row[kitchenIdx]) : 0,
      postKg:         postIdx >= 0 ? num(row[postIdx]) : 0,
      yieldPct,
      logisticTarget: logTgtIdx >= 0 ? (num(row[logTgtIdx]) || undefined) : undefined,
    });
  }

  console.log(`  Produktionsplan: ${entries.length} Work-Order-Zeilen aus Tab "${tabName}"`);
  return { week, generatedAt: new Date().toISOString(), rows: entries };
}
