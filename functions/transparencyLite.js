// Transparency Producibility — Server-seitiger Zwilling, "Lite"-Variante.
//
// Die echte Engine läuft im Browser über 4 live GSheet-Tabs (eigenes Sheet,
// ID s.u., unabhängig von RTI_SHEET_ID/STAFFING_PLAN_SHEET_ID):
//   src/features/gsheet-monitor/parsers/transparency/parseTotalOverview.ts
//   src/features/gsheet-monitor/parsers/transparency/parseWeighingLedger.ts
//   src/features/gsheet-monitor/parsers/transparency/parseRtem.ts
//   src/features/gsheet-monitor/parsers/transparency/parsePlanningCheck.ts
//   src/features/gsheet-monitor/transparencyProducibility.ts
//     (computeTransparencyProducibility)
// Functions hat keinen Pfad auf src/ (plain Node/CommonJS, kein Vite/TS-
// Toolchain) — deshalb hier 1:1 portiert, exakt wie schon parseStaffingPlan
// (dailyBriefingSlack.js) und hfWeekLabel (Duplikat von src/lib/hfWeek.ts).
// ALLE Funktionen unten sind 1:1-Ports der oben genannten Dateien — bei
// Änderung an der TS-Seite hier nachziehen (1:1 halten).
//
// Fetch/Auth ist NICHT Teil dieser Datei — der Cloud-Function-seitige Aufruf
// nutzt denselben authentifizierten Sheets-Client wie schon für
// STAFFING_PLAN_SHEET_ID (sheetsClient() aus rtiBackfillWatch.js._internal),
// siehe TRANSPARENCY_TABS unten für die 4 Tab-Titel/Ranges (identische
// Registry wie scripts/wms-local-server.ts TRANSPARENCY_TAB_REGISTRY, nur auf
// die 4 hier gebrauchten Tabs reduziert).

const TRANSPARENCY_SHEET_ID = "1BEaL3ggpHGS5TbncUM5OLMUbVgRx-ADKOtRr_Sc8xXY";

// Nur die 4 Tabs, die computeTransparencyProducibility tatsächlich braucht —
// die restliche Registry (Forecast/WMS-WO/Logistik/KPIs/…) aus
// wms-local-server.ts ist hier bewusst nicht mitportiert, weil sie in den
// Slack-Post nicht einfließt.
const TRANSPARENCY_TABS = {
  "total-overview": { title: "Transperancy Total Overview", range: "A1:BF4200" },
  "importrange-weights": { title: "Importrange Weights", range: "A1:R23000" },
  "planning-check": { title: "Planning Check", range: "A1:U120" },
  rtem: { title: "RTEM", range: "A1:R1800" },
};

// ── Zell-Helfer (Portierung von transparencyCellHelpers.ts, 1:1 halten) ────
// Das Sheet mischt Tausender-Kommas ("31,851") und reine Ziffern, und viele
// Tabs enthalten an einzelnen Stellen Formel-Fehler (#REF!/#N/A/#DIV/0!/
// #VALUE!) statt echter Werte — isFormulaError() erkennt das, damit Parser
// die Zelle wie leer behandeln statt zu crashen oder Fehlertext zu übernehmen.

function cell(row, i) {
  const raw = row ? row[i] : undefined;
  return raw == null ? "" : String(raw).trim();
}

function isFormulaError(raw) {
  return /^#(REF|N\/A|DIV\/0|VALUE|NAME\?|NULL|NUM)!?/.test(raw.trim());
}

function safeCell(row, i) {
  const v = cell(row, i);
  return isFormulaError(v) ? "" : v;
}

function parseIntCell(row, i) {
  const v = safeCell(row, i);
  if (!v) return null;
  const n = parseInt(v.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatCell(row, i) {
  const v = safeCell(row, i);
  if (!v) return null;
  const n = parseFloat(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseBoolCell(row, i) {
  return safeCell(row, i).toLowerCase() === "true";
}

// "FV4034A - Pulled chicken in smokey tomato sauce [DE]" -> Code + Name.
function splitRecipeCodeAndName(raw) {
  const m = String(raw ?? "").match(/^([A-Z]{1,3}\d{3,5}[A-Z]?)\s*-\s*(.+)$/);
  if (m) return { code: m[1].trim(), name: m[2].trim() };
  return { code: "", name: raw };
}

// Erkennt "sieht aus wie ein FV/FE-Rezeptcode" (z.B. "FV4034A") — filtert
// wiederholte Kopfzeilen mitten in den Daten raus (siehe parsePlanningCheck).
function looksLikeRecipeCode(v) {
  return /^[A-Z]{1,3}\d{3,5}[A-Z]?$/.test(String(v ?? "").trim());
}

// Findet die Header-Zeile über ein Label in einer festen Spalte — Blöcke
// verschieben sich in diesen Tabs gelegentlich, eine feste Zeilennummer wäre
// zu brüchig.
function findHeaderIndex(rows, colIndex, expected) {
  return rows.findIndex((r) => cell(r, colIndex) === expected);
}

// ── weekPrefixFromWoNumber (Duplikat von src/features/wms-overview/
// wmsWeeks.ts, 1:1 halten) — WO-Nummer trägt die KW als Präfix ("35-1" =
// KW35), zuverlässiger als jedes freie Datumsfeld im Sheet.
function weekPrefixFromWoNumber(woNumber) {
  const m = String(woNumber ?? "").trim().match(/^(\d{1,2})-/);
  return m ? parseInt(m[1], 10) : null;
}

// ── parseTotalOverview (Portierung von parseTotalOverview.ts, 1:1 halten) ──
// Tab "Transperancy Total Overview": eine Zeile je (Run, Work Order,
// Subrezept), Status durch Staging -> Kitchen -> Post.
// Spalten (0-idx): 0 Run, 3 Planned Kitchen day, 4 WO, 5 Comment, 6 Recipe
// ("Code - Name [Region]"), 7 Sub recipe, 8 Planned Meals, 9 Planned Staging
// kg, 10 Kitchen kg, 11 Planned Post kg, 12 Yield, 13 Logistic Staged (bool),
// 15 Kitchen Cooked (bool), 22 Status, 23 Owner.
function parseTotalOverview(rows) {
  const headerIdx = findHeaderIndex(rows, 0, "Run");
  const parsed = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const workOrder = cell(row, 4);
      if (!workOrder) continue;

      const { code, name } = splitRecipeCodeAndName(cell(row, 6));
      parsed.push({
        run: cell(row, 0),
        plannedKitchenDay: cell(row, 3),
        workOrder,
        comment: cell(row, 5),
        recipeCode: code,
        recipeName: name,
        subRecipeName: cell(row, 7),
        plannedMeals: parseIntCell(row, 8),
        plannedStagingKg: parseFloatCell(row, 9),
        kitchenKg: parseFloatCell(row, 10),
        plannedPostKg: parseFloatCell(row, 11),
        yieldPct: parseFloatCell(row, 12),
        logisticStaged: parseBoolCell(row, 13),
        kitchenCooked: parseBoolCell(row, 15),
        logisticStatus: cell(row, 22),
        logisticOwner: cell(row, 23),
      });
    }
  }

  const byWorkOrder = new Map();
  const byRecipeCode = new Map();
  for (const r of parsed) {
    if (!byWorkOrder.has(r.workOrder)) byWorkOrder.set(r.workOrder, []);
    byWorkOrder.get(r.workOrder).push(r);
    if (r.recipeCode) {
      if (!byRecipeCode.has(r.recipeCode)) byRecipeCode.set(r.recipeCode, []);
      byRecipeCode.get(r.recipeCode).push(r);
    }
  }

  return { rows: parsed, byWorkOrder, byRecipeCode, lastUpdated: Date.now() };
}

// ── parseWeighingLedger (Portierung von parseWeighingLedger.ts, 1:1 halten) ─
// Tab "Importrange Weights": DIE Rohwiegungsquelle. Drei unabhängige
// Spaltengruppen (Raw / Pre-Blast / Post-Blast), NICHT zeilenweise verknüpft
// — jede Gruppe wird separat über ihre eigenen Spalten extrahiert.
// Spalten (0-idx): 1 WO/4 Raw kg (Raw), 6 WO/7 kg/8 SKU/9 Subrezept/10 Stück
// pro Rack (Pre-Blast), 12 WO/13 kg/14 SKU/15 Rezept/16 Subrezept (Post-Blast).
function parseWeighingLedger(rows) {
  const headerIdx = findHeaderIndex(rows, 1, "WO Number");
  const raw = [];
  const preBlast = [];
  const postBlast = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const rawWo = cell(row, 1);
      if (rawWo) {
        const weightKg = parseFloatCell(row, 4);
        if (weightKg != null) raw.push({ workOrder: rawWo, skuCode: cell(row, 2), subRecipeName: cell(row, 3), weightKg });
      }

      const preWo = cell(row, 6);
      if (preWo) {
        const weightKg = parseFloatCell(row, 7);
        if (weightKg != null) {
          preBlast.push({ workOrder: preWo, skuCode: cell(row, 8), subRecipeName: cell(row, 9), weightKg, piecesPerRack: parseIntCell(row, 10) });
        }
      }

      const postWo = cell(row, 12);
      if (postWo) {
        const weightKg = parseFloatCell(row, 13);
        if (weightKg != null) {
          postBlast.push({ workOrder: postWo, skuCode: cell(row, 14), weightKg, recipeName: cell(row, 15), subRecipeName: cell(row, 16) });
        }
      }
    }
  }

  function sumByWo(entries) {
    const m = new Map();
    for (const e of entries) m.set(e.workOrder, (m.get(e.workOrder) ?? 0) + e.weightKg);
    return m;
  }

  return {
    raw,
    preBlast,
    postBlast,
    rawKgByWorkOrder: sumByWo(raw),
    preBlastKgByWorkOrder: sumByWo(preBlast),
    postBlastKgByWorkOrder: sumByWo(postBlast),
    lastUpdated: Date.now(),
  };
}

// ── parseRtem (Portierung von parseRtem.ts, 1:1 halten) ────────────────────
// Tab "RTEM": RTI/Gekocht-Bestand je Subrezept.
// Spalten (0-idx): 0 Slot #, 1 Menu Week, 2 Recipe Code (interne "REC-..."-
// Id), 3 Recipe Name ("FVxxxxA - Name [Region]" — enthält den eigentlichen
// FV-Code), 4 Demand, 5 Scheduled Portions, 6 Sub Recipe Code, 7 Sub Recipe
// Name, 8 Cook Methods, 10 Quantity Cooked, 13 Total Cooked (Portions),
// 14 Total Mapped, 15 Estimated RTI left, 16 Actual RTI left.
function parseRtem(rows) {
  const headerIdx = findHeaderIndex(rows, 0, "Slot #");
  const parsed = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const internalRecipeId = cell(row, 2);
      const rawRecipeName = cell(row, 3);
      if (!internalRecipeId && !rawRecipeName) continue;
      const { code, name } = splitRecipeCodeAndName(rawRecipeName);

      parsed.push({
        slot: cell(row, 0),
        menuWeek: cell(row, 1),
        recipeCode: code,
        internalRecipeId,
        recipeName: name || rawRecipeName,
        demandAmount: parseIntCell(row, 4),
        scheduledPortions: parseIntCell(row, 5),
        subRecipeCode: cell(row, 6),
        subRecipeName: cell(row, 7),
        cookMethods: cell(row, 8),
        quantityCooked: parseFloatCell(row, 10),
        totalCookedPortions: parseIntCell(row, 13),
        totalMapped: parseIntCell(row, 14),
        estimatedRtiLeft: parseIntCell(row, 15),
        actualRtiLeft: parseIntCell(row, 16),
      });
    }
  }

  const byRecipeCode = new Map();
  const bySubRecipeName = new Map();
  for (const r of parsed) {
    if (r.recipeCode) {
      if (!byRecipeCode.has(r.recipeCode)) byRecipeCode.set(r.recipeCode, []);
      byRecipeCode.get(r.recipeCode).push(r);
    }
    if (r.subRecipeName) {
      if (!bySubRecipeName.has(r.subRecipeName)) bySubRecipeName.set(r.subRecipeName, []);
      bySubRecipeName.get(r.subRecipeName).push(r);
    }
  }

  return { rows: parsed, byRecipeCode, bySubRecipeName, lastUpdated: Date.now() };
}

// ── parsePlanningCheck (Portierung von parsePlanningCheck.ts, 1:1 halten) ──
// Tab "Planning Check": Meal-Ebene, Plan vs. Forecast vs. Actuals je Tag.
// Spalten (0-idx): 1 Recipe Code, 2 Recipe Name, 3 Slot, 4 Total, 5-7 Planned
// 1-3, 8 Planned vs. Forecast, 9 Planned Remaining to Plate, 11-16 Actuals
// Mon-Sat, 18 forecast delta (total).
const PLANNING_CHECK_ACTUAL_DAY_COLS = { mon: 11, tue: 12, wed: 13, thu: 14, fri: 15, sat: 16 };

function parsePlanningCheck(rows) {
  const week = (rows[0]?.[2] ?? "").trim();
  const headerIdx = findHeaderIndex(rows, 1, "Recipe Code");
  const parsed = [];

  if (headerIdx !== -1) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      const recipeCode = cell(row, 1);
      if (!recipeCode || !looksLikeRecipeCode(recipeCode)) continue;

      parsed.push({
        recipeCode,
        recipeName: cell(row, 2),
        slot: cell(row, 3),
        total: parseIntCell(row, 4),
        planned1: parseIntCell(row, 5),
        planned2: parseIntCell(row, 6),
        planned3: parseIntCell(row, 7),
        plannedVsForecast: parseIntCell(row, 8),
        plannedRemainingToPlate: parseIntCell(row, 9),
        actualsByDay: {
          mon: parseIntCell(row, PLANNING_CHECK_ACTUAL_DAY_COLS.mon),
          tue: parseIntCell(row, PLANNING_CHECK_ACTUAL_DAY_COLS.tue),
          wed: parseIntCell(row, PLANNING_CHECK_ACTUAL_DAY_COLS.wed),
          thu: parseIntCell(row, PLANNING_CHECK_ACTUAL_DAY_COLS.thu),
          fri: parseIntCell(row, PLANNING_CHECK_ACTUAL_DAY_COLS.fri),
          sat: parseIntCell(row, PLANNING_CHECK_ACTUAL_DAY_COLS.sat),
        },
        forecastDeltaTotal: parseFloatCell(row, 18),
      });
    }
  }

  const byRecipeCode = new Map(parsed.map((r) => [r.recipeCode, r]));
  return { week, rows: parsed, byRecipeCode, lastUpdated: Date.now() };
}

// ── computeTransparencyProducibility (Portierung von
// transparencyProducibility.ts, 1:1 halten) ────────────────────────────────
// Regel:
// 1. Für jedes Subrezept eines Meals (aus Total Overview, über alle
//    zugehörigen Work Orders summiert): gewogenes Post-Blast-kg (Importrange
//    Weights) vs. geplantes Post-kg. "weighedComplete", wenn das Verhältnis
//    die Toleranzschwelle erreicht.
// 2. Ein Meal ist "ready", wenn ALLE seine Subrezepte weighedComplete sind,
//    "blocked", wenn noch KEINS davon angefangen ist, sonst "partial".
// 3. KW-Trennung: Total Overview kumuliert Work Orders über viele Wochen/Runs
//    hinweg — nur Work Orders mit passendem WO-Präfix (weekPrefixFromWoNumber)
//    zählen für die aktuelle Woche; Rezepte, die NICHT im aktuellen
//    Planning-Check-Tab stehen, landen separat in "otherWeekMeals".
const WEIGHED_COMPLETE_TOLERANCE = 0.98; // 98% des geplanten Post-kg gilt als "fertig gewogen"

function computeSubRecipeProducibility(subRecipeName, workOrders, plannedPostKg, weighedPostKg, rtem) {
  const pct = plannedPostKg > 0 ? (weighedPostKg / plannedPostKg) * 100 : null;
  const weighedComplete = plannedPostKg > 0
    ? weighedPostKg / plannedPostKg >= WEIGHED_COMPLETE_TOLERANCE
    : weighedPostKg > 0;

  const rtemRows = rtem?.bySubRecipeName.get(subRecipeName) ?? [];
  const actualRtiLeft = rtemRows.length
    ? rtemRows.reduce((s, r) => s + (r.actualRtiLeft ?? 0), 0)
    : null;

  return { subRecipeName, workOrders, plannedPostKg, weighedPostKg, pct, weighedComplete, actualRtiLeft };
}

function buildMeal(recipeCode, recipeName, flowRows, weighing, rtem) {
  if (flowRows.length === 0) {
    return { recipeCode, recipeName, status: "unknown", subRecipes: [], blockedReasons: ["Keine Daten in Transperancy Total Overview für diese KW gefunden"] };
  }

  // Je Subrezept über alle Work Orders/Runs dieses Meals hinweg aggregieren.
  const bySubRecipe = new Map();
  for (const r of flowRows) {
    const key = r.subRecipeName || "(ohne Subrezept-Name)";
    if (!bySubRecipe.has(key)) bySubRecipe.set(key, { workOrders: new Set(), plannedPostKg: 0 });
    const entry = bySubRecipe.get(key);
    entry.workOrders.add(r.workOrder);
    entry.plannedPostKg += r.plannedPostKg ?? 0;
  }

  const subRecipes = [];
  for (const [subRecipeName, { workOrders, plannedPostKg }] of bySubRecipe) {
    const woList = [...workOrders];
    const weighedPostKg = woList.reduce((s, wo) => s + (weighing?.postBlastKgByWorkOrder.get(wo) ?? 0), 0);
    subRecipes.push(computeSubRecipeProducibility(subRecipeName, woList, plannedPostKg, weighedPostKg, rtem));
  }
  subRecipes.sort((a, b) => (a.pct ?? -1) - (b.pct ?? -1));

  const allComplete = subRecipes.every((s) => s.weighedComplete);
  const noneStarted = subRecipes.every((s) => s.weighedPostKg <= 0);
  const status = allComplete ? "ready" : noneStarted ? "blocked" : "partial";
  const blockedReasons = subRecipes
    .filter((s) => !s.weighedComplete)
    .map((s) => `${s.subRecipeName}: ${s.pct != null ? `${s.pct.toFixed(0)}%` : "kein Soll"} gewogen (${s.weighedPostKg.toFixed(1)}/${s.plannedPostKg.toFixed(1)} kg)`);

  return { recipeCode, recipeName, status, subRecipes, blockedReasons };
}

function computeTransparencyProducibility(flow, weighing, rtem, planningCheck, selectedWeekNum) {
  const inWeek = (r) => selectedWeekNum == null || weekPrefixFromWoNumber(r.workOrder) === selectedWeekNum;

  const currentWeekRecipeCodes = new Set(planningCheck?.rows.map((r) => r.recipeCode) ?? []);
  const allFlowRecipeCodes = new Set(flow?.byRecipeCode.keys() ?? []);

  const meals = [];
  for (const recipeCode of currentWeekRecipeCodes) {
    if (!recipeCode) continue;
    const flowRows = (flow?.byRecipeCode.get(recipeCode) ?? []).filter(inWeek);
    const planRow = planningCheck?.byRecipeCode.get(recipeCode);
    const recipeName = planRow?.recipeName || flowRows[0]?.recipeName || recipeCode;
    meals.push(buildMeal(recipeCode, recipeName, flowRows, weighing, rtem));
  }
  meals.sort((a, b) => a.recipeName.localeCompare(b.recipeName));

  // Rezepte, die es nur über (evtl. andere-Wochen-)Work-Orders in Total
  // Overview gibt, aber NICHT im aktuellen Planning-Check-Tab stehen.
  const otherWeekMeals = [];
  for (const recipeCode of allFlowRecipeCodes) {
    if (!recipeCode || currentWeekRecipeCodes.has(recipeCode)) continue;
    const flowRows = flow?.byRecipeCode.get(recipeCode) ?? [];
    const recipeName = flowRows[0]?.recipeName || recipeCode;
    otherWeekMeals.push(buildMeal(recipeCode, recipeName, flowRows, weighing, rtem));
  }
  otherWeekMeals.sort((a, b) => a.recipeName.localeCompare(b.recipeName));

  const byRecipeCode = new Map(meals.map((m) => [m.recipeCode, m]));

  return {
    byRecipeCode,
    meals,
    readyCount: meals.filter((m) => m.status === "ready").length,
    partialCount: meals.filter((m) => m.status === "partial").length,
    blockedCount: meals.filter((m) => m.status === "blocked").length,
    otherWeekMeals,
    weekNum: selectedWeekNum,
  };
}

module.exports = {
  TRANSPARENCY_SHEET_ID,
  TRANSPARENCY_TABS,
  parseTotalOverview,
  parseWeighingLedger,
  parseRtem,
  parsePlanningCheck,
  computeTransparencyProducibility,
  // Interne Helfer zusätzlich exportiert (Tests + evtl. Wiederverwendung
  // durch die Integration in dailyBriefingSlack.js), analog zu
  // rtiBackfillWatch.js._internal.
  cell,
  isFormulaError,
  safeCell,
  parseIntCell,
  parseFloatCell,
  parseBoolCell,
  splitRecipeCodeAndName,
  looksLikeRecipeCode,
  findHeaderIndex,
  weekPrefixFromWoNumber,
};
