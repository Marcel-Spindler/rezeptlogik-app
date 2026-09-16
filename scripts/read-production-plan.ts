import { google } from "googleapis";
import type { ProductionPlan, WorkOrderEntry } from "../src/core/types.ts";
import { num, parseRecipeName } from "./lib/helpers.ts";
import { getAuthClient, getAllTabNames, findCurrentWeekTab } from "./lib/gsheet-helpers.ts";

// Wandelt einen GSheet-Datumswert (Seriennummer ODER Datumsstring) in YYYY-MM-DD um.
// Mit dateTimeRenderOption=SERIAL_NUMBER liefert die API Datumszellen als Zahl (Tage
// seit 30.12.1899). Kommt doch ein String (Text-Spalte, oder anderes Rendering),
// werden die häufigsten Formate noch erkannt (DD.MM.YYYY, MM/DD/YYYY).
function normalizeKitchenDay(raw: unknown): string {
  if (raw == null || raw === "") return "";
  const num = Number(raw);
  if (Number.isFinite(num) && num > 40000) {
    // Google-Sheets-Seriennummer → UTC-Datum
    const d = new Date(Math.round((num - 25569) * 86_400_000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10); // schon ISO (YYYY-MM-DD)
  const ymdSlash = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (ymdSlash) return `${ymdSlash[1]}-${ymdSlash[2]}-${ymdSlash[3]}`; // YYYY/MM/DD
  const de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (de) return `${de[3]}-${de[2].padStart(2, "0")}-${de[1].padStart(2, "0")}`; // DD.MM.YYYY
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`; // MM/DD/YYYY
  return s; // unbekannt — unverändert zurück, parseDateShift fängt NaN ab
}

export async function readProductionPlan(spreadsheetId: string): Promise<ProductionPlan | undefined> {
  if (!spreadsheetId) return undefined;
  const client = await getAuthClient();
  const sheets = google.sheets({ version: "v4", auth: client as any });

  let tabName = process.env.SHEET_FERTIGSTELLUNG_TAB?.trim();
  if (!tabName) {
    const allTabs = await getAllTabNames(sheets, spreadsheetId);
    // "Transperancy Total Overview" (sic — sheet's own spelling) is the
    // current evergreen tab: no week number in its name, holds a rolling
    // window of the current + next weeks instead of one tab per week.
    // Keep the older week-numbered patterns too in case the sheet owner
    // reverts to per-week tabs.
    tabName = findCurrentWeekTab(allTabs, [
      "Transperancy Total Overview",
      "Transparency Total Overview",
      "W{XX} Transperancy",
      "W{XX} Transparency",
      "BENL Outbound W{XX}",
    ]);
    if (!tabName) tabName = allTabs[0];
  }
  if (!tabName) { console.warn("  Fertigstellung: kein Tab gefunden"); return undefined; }

  let rows: any[][];
  try {
    // UNFORMATTED_VALUE + SERIAL_NUMBER: Datumszellen kommen als Seriennummer (Tage seit
    // 30.12.1899), Text-Zellen als String. Das vermeidet Gebietsschema-Abhängigkeiten
    // beim Datumsformat (z.B. "16.09.2026" vs. "09/16/2026"). normalizeKitchenDay()
    // wandelt die Seriennummer dann in YYYY-MM-DD um.
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${tabName}'!A1:N2000`,
      valueRenderOption: "UNFORMATTED_VALUE" as any,
      dateTimeRenderOption: "SERIAL_NUMBER" as any,
    });
    rows = res.data.values ?? [];
  } catch (e: any) {
    console.warn(`  Fertigstellung Lesen fehlgeschlagen: ${e?.message ?? e}`);
    return undefined;
  }

  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i].map((c: unknown) => String(c ?? "").trim().toLowerCase());
    const hasLegacyRecipe = r.some(c => c === "recipe");
    const hasKetRecipe = r.some(c => c.includes("recipe name"));
    if (r.some(c => c.includes("work order")) && (hasLegacyRecipe || hasKetRecipe)) {
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
  const woIdx      = header.findIndex(c => c === "work order" || c.includes("work order number"));
  const recipeIdIdx = header.findIndex(c => c === "recipe id");
  const recipeIdx  = header.findIndex(c => c === "recipe" || c.includes("recipe name"));
  const subIdx     = header.findIndex(c => c.includes("sub recipe") || c === "sub recipe" || c.includes("sub recipe name"));
  const mealsIdx   = header.findIndex(c => c.includes("planned meals") || c === "planned meals");
  const targetPortionsIdx = header.findIndex(c => c === "target portions" || c.includes("target portion"));
  const woCookedIdx = header.findIndex(c => c.includes("wo cooked portions") || c.includes("cooked portions"));
  const excessIdx = header.findIndex(c => c.includes("cooked portions excess"));
  const stagingIdx = header.findIndex(c => c.includes("staging"));
  const kitchenIdx = header.findIndex(c => c.includes("kitchen") && c.includes("kg"));
  const postIdx    = header.findIndex(c => c.includes("post"));
  const yieldIdx   = header.findIndex(c => c === "yield");
  const cookMethodsIdx = header.findIndex(c => c.includes("cook methods"));
  const stagingStatusIdx = header.findIndex(c => c === "staging status");
  const stagingCommentIdx = header.findIndex(c => c === "staging comment");
  const kitchenStatusIdx = header.findIndex(c => c === "kitchen status");
  const unlockedEtaIdx = header.findIndex(c => c.includes("unlocked eta"));
  const workOrderCommentIdx = header.findIndex(c => c.includes("work order comment"));
  const logTgtIdx  = header.findLastIndex(c => c === "target");

  const entries: WorkOrderEntry[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;
    const woCell = woIdx >= 0 ? String(row[woIdx] ?? "").trim() : "";
    if (!woCell || !/^\d{2}-\d{1,4}$/.test(woCell)) continue;

    const fullRecipe = recipeIdx >= 0 ? String(row[recipeIdx] ?? "").trim() : "";
    const { code: recipeCode } = parseRecipeName(fullRecipe);
    const yieldRaw = String(row[yieldIdx >= 0 ? yieldIdx : 9] ?? "").replace("%", "").trim();
    const yieldPct = parseFloat(yieldRaw.replace(",", ".")) || 0;

    entries.push({
      run:            runIdx >= 0 ? (parseInt(String(row[runIdx] ?? ""), 10) || 0) : 0,
      kitchenDay:     dayIdx >= 0 ? normalizeKitchenDay(row[dayIdx]) : "",
      workOrder:      woCell,
      recipeId:       recipeIdIdx >= 0 ? String(row[recipeIdIdx] ?? "").trim() : "",
      recipeCode,
      recipeName:     fullRecipe,
      subRecipe:      subIdx >= 0 ? String(row[subIdx] ?? "").trim() : "",
      plannedMeals:   mealsIdx >= 0 ? num(row[mealsIdx]) : 0,
      targetPortions: targetPortionsIdx >= 0 ? num(row[targetPortionsIdx]) || undefined : undefined,
      woCookedPortions: woCookedIdx >= 0 ? num(row[woCookedIdx]) || undefined : undefined,
      cookedPortionsExcess: excessIdx >= 0 ? num(row[excessIdx]) || undefined : undefined,
      stagingKg:      stagingIdx >= 0 ? num(row[stagingIdx]) : 0,
      kitchenKg:      kitchenIdx >= 0 ? num(row[kitchenIdx]) : 0,
      postKg:         postIdx >= 0 ? num(row[postIdx]) : 0,
      yieldPct,
      cookMethods:    cookMethodsIdx >= 0 ? String(row[cookMethodsIdx] ?? "").trim() : "",
      stagingStatus:  stagingStatusIdx >= 0 ? String(row[stagingStatusIdx] ?? "").trim() : "",
      stagingComment: stagingCommentIdx >= 0 ? String(row[stagingCommentIdx] ?? "").trim() : "",
      kitchenStatus:  kitchenStatusIdx >= 0 ? String(row[kitchenStatusIdx] ?? "").trim() : "",
      unlockedEta:    unlockedEtaIdx >= 0 ? String(row[unlockedEtaIdx] ?? "").trim() : "",
      workOrderComment: workOrderCommentIdx >= 0 ? String(row[workOrderCommentIdx] ?? "").trim() : "",
      logisticTarget: logTgtIdx >= 0 ? (num(row[logTgtIdx]) || undefined) : undefined,
    });
  }

  const year = new Date().getFullYear();
  const tabWeekMatch = /W(\d{1,2})/i.exec(tabName);
  const week = tabWeekMatch
    ? `${year}-W${String(parseInt(tabWeekMatch[1], 10)).padStart(2, "0")}`
    : `${year}-W${String(dominantWoWeek(entries) ?? "??").padStart(2, "0")}`;

  console.log(`  Produktionsplan: ${entries.length} Work-Order-Zeilen aus Tab "${tabName}" (Woche ${week})`);
  return { week, generatedAt: new Date().toISOString(), rows: entries };
}

// Evergreen tabs (e.g. "Transperancy Total Overview") carry no week number
// in their name and hold a rolling window of the current + next weeks in
// one tab — fall back to the most common WO week-prefix ("33-1" -> 33)
// among the parsed rows instead of leaving the plan's week unset.
function dominantWoWeek(entries: WorkOrderEntry[]): number | undefined {
  const counts = new Map<number, number>();
  for (const e of entries) {
    const m = /^(\d{2})-/.exec(e.workOrder);
    if (!m) continue;
    const wk = parseInt(m[1], 10);
    counts.set(wk, (counts.get(wk) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [wk, count] of counts) {
    if (count > bestCount) { best = wk; bestCount = count; }
  }
  return best;
}
