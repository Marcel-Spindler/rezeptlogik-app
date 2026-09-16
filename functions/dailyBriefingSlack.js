// Tagesbriefing 15:00 — Slack-Post, server-seitig.
//
// Der volle Tagesbriefing-Rechenkern (src/features/daily-briefing/
// dailyBriefingLogic.ts — Kritisch, gefährdete WOs mit Rohware/MHD,
// Plating-Todo, Morgen zuerst) läuft im Browser über React-Hooks auf Live-
// GSheet-/Snowflake-Daten und ist kein 1:1 portierbarer Server-Job. Dieser
// Post deckt inzwischen fast alle Signale ab:
//   • Backfill-Bedarf     — exakt dieselbe Rechenlogik wie rtiBackfillWatch
//                           (importiert, nicht dupliziert — siehe unten).
//   • Küchen-/Plating-
//     Besetzung           — aus dem wöchentlichen Staffing-Plan-Sheet, Tab
//                           "Financial" (Portierung von parseStaffingPlan.ts,
//                           1:1 halten).
//   • Plating-Fortschritt — je Meal Planned/Actuals aus dem RTI-Sheet-Kopf
//                           (rti.summarizeRtiProgress).
//   • Kritisch (Küche),
//     Zu plaitieren,
//     Morgen zuerst        — vereinfachter Zwilling von
//                           matchPostblastToWorkOrders/mealProgress/
//                           plateableNet (dailyBriefingLogic.ts), gespeist aus
//                           dem "Transperancy Total Overview"-Sheet (live per
//                           Sheets API, siehe fetchWoOverviewPlan — NICHT mehr
//                           nur die Firestore-Momentaufnahme, die einen
//                           offenen Browser-Tab brauchte) + live
//                           Postblast/Preblast (gviz-CSV, kein Snowflake).
//                           Firestore apps/rezeptlogik/productionPlan/{KW}
//                           bleibt Fallback, falls das Sheet mal nicht lesbar
//                           ist. Kein recipeWeights (export-recipes.csv nicht
//                           serverseitig verfügbar) → immer der
//                           Planverhältnis-Fallback.
//   • Transparency-
//     Produzierbarkeit     — Server-Zwilling in transparencyLite.js (1:1
//                           Port der 4 Browser-Parser + computeTransparency-
//                           Producibility), liest dasselbe "Transperancy
//                           Total Overview"-Sheet + 3 weitere Tabs, alle per
//                           authentifiziertem Sheets-Client (kein Snowflake).
//   • Equipment morgen,
//     Rohware/MHD-
//     Feasibility          — BEIDE brauchen Daten, die nur lokal liegen (die
//                           volle Rezeptstruktur/data.json bzw. den
//                           Snowflake-Vollbestand über den lokalen WMS-
//                           Server) — kommen über einen lokalen Relay-Job
//                           (scripts/daily-briefing-equipment-feasibility-
//                           relay.ts, Windows Scheduled Task alle 20 Min) als
//                           Firestore-Snapshot (apps/rezeptlogik/daily
//                           Briefing/relaySnapshot). Ist der Snapshot älter
//                           als RELAY_FRESHNESS_MIN, wird das ehrlich als
//                           "nicht verfügbar" gezeigt statt eine veraltete
//                           Zahl zu posten.
// Noch offen (braucht neue Infra, größerer Lift):
//   • Cross-Source-Backfill-Alerts (combineBackfills.ts, ~560 Zeilen, braucht
//     LinePlating-Live-Daten) — die Kritisch-Liste hier deckt Küche/
//     Produzierbarkeit/Rohware ab, aber nicht die Plating-Team-Meldungen.
//
// Nötig: DAILY_BRIEFING_SLACK_WEBHOOK_URL in functions/.env — siehe
// TAGESBRIEFING_SLACK_SETUP.md (Repo-Wurzel). Eigene Variable, unabhängig von
// SLACK_WEBHOOK_URL (rtiBackfillWatch) — beide Automatisierungen können in
// unterschiedliche Kanäle posten.
// Optional zusätzlich: SLACK_BOT_TOKEN + DAILY_BRIEFING_SLACK_CHANNEL — dann
// wird der Post kompakt (KPIs + Top-Kritisch) gehalten und alle Details
// (Backfill, Plating-Fortschritt, Zu plaitieren, Morgen zuerst, Equipment,
// Rohware) als Thread-Antwort(en) darunter gepostet, statt alles in einer
// langen Nachricht zu bündeln. Ohne Bot-Token läuft der Post wie bisher als
// EINE Nachricht über den Webhook — nichts bricht, es fehlt nur das
// Thread-Layout. Siehe TAGESBRIEFING_SLACK_SETUP.md für die Bot-Einrichtung.

const admin = require("firebase-admin");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const rti = require("./rtiBackfillWatch.js")._internal;
const transparency = require("./transparencyLite.js");

const REGION = "europe-west3";

// Cron, Standard: jeden Tag 15:00 Europe/Berlin. Anpassbar ohne Deploy-Logik-
// Änderung, nur die Env-Var setzen (z. B. "0 15 * * 1-5" für Mo–Fr).
const DAILY_BRIEFING_SCHEDULE = process.env.DAILY_BRIEFING_SCHEDULE || "0 15 * * *";

// Staffing-Plan-Sheet (Hiring/Kosten-BP-Modell, "Headcount - Required" je
// Abteilung/KW) — mit dem Service-Account ("PDL fast reader") geteilt.
const STAFFING_PLAN_SHEET_ID = process.env.STAFFING_PLAN_SHEET_ID || "1qHOGFAbUmAa4nxqBF9LcAT3trl0inDoupZflQhqb8wU";
const STAFFING_PLAN_GID = process.env.STAFFING_PLAN_GID || "308443134"; // Tab "Financial"

// "Fertigstellungszeitplan"/Transparency-Sheet — dieselbe Kennung, mit der
// scripts/read-production-plan.ts (Produktionsplan) UND transparencyLite.js
// (Produzierbarkeit) es schon kennen. Muss mit demselben Service-Account
// geteilt sein, der auch RTI_SHEET_ID/STAFFING_PLAN_SHEET_ID liest.
const FERTIGSTELLUNG_SHEET_ID = process.env.SHEET_FERTIGSTELLUNG || transparency.TRANSPARENCY_SHEET_ID;

// Relay-Snapshot (Equipment morgen + Feasibility) gilt ab diesem Alter als
// veraltet — dann ehrlich "nicht verfügbar" statt einer falschen Momentauf-
// nahme. Etwas großzügiger als der 10-Min-Redzone-Relay, weil der Equipment-/
// Feasibility-Relay-Job seltener läuft (alle 20 Min, siehe .cmd).
const RELAY_FRESHNESS_MIN = 50;

// ── Slack ────────────────────────────────────────────────────────────────
async function postToSlackWebhook(text) {
  const url = process.env.DAILY_BRIEFING_SLACK_WEBHOOK_URL;
  if (!url) { logger.warn("DAILY_BRIEFING_SLACK_WEBHOOK_URL fehlt — kein Slack-Post"); return; }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error("Slack-Post fehlgeschlagen", { status: res.status, body: body.slice(0, 200) });
    }
  } catch (e) {
    logger.error("Slack-Post Exception", { error: String(e) });
  }
}

// Slack empfiehlt Nachrichten deutlich unter dem harten Limit (40.000
// Zeichen) zu halten, damit sie lesbar bleiben — hier hart gedeckelt, damit
// eine besonders volle Woche (viele Kritisch-/Backfill-Einträge) nie an
// irgendein Limit stößt ("Slack-Post überläuft", siehe TAGESBRIEFING_SLACK
// _SETUP.md). Ein zu langer Detail-Text wird in mehrere Thread-Antworten
// aufgeteilt statt abgeschnitten — sonst würde ein "Rohware"-Abschnitt mitten
// im Text verschwinden, ohne dass irgendjemand das bemerkt.
const SLACK_CHUNK_MAX_CHARS = 3500;

function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const lines = text.split("\n");
  const chunks = [];
  let cur = "";
  for (const line of lines) {
    if (cur.length + line.length + 1 > maxChars && cur.length > 0) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur.length > 0 ? `${cur}\n${line}` : line;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

// Wirft NIE — ein Netzwerkfehler hier darf den ganzen Function-Lauf nicht zu
// Fall bringen (sonst geht der komplette Post verloren statt nur die
// Thread-Antwort). Fehler werden geloggt, der Aufrufer bekommt { ok: false }.
async function slackApi(method, token, body) {
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!json.ok) logger.error("Slack Web API Fehler", { method, error: json.error });
    return json;
  } catch (e) {
    logger.error("Slack Web API Exception", { method, error: String(e) });
    return { ok: false, error: String(e) };
  }
}

// Kompakter Hauptpost + Detail(s) als Thread-Antwort, wenn ein Bot-Token
// konfiguriert ist (chat:write, in den Zielkanal eingeladen — siehe
// TAGESBRIEFING_SLACK_SETUP.md). Ohne Bot-Token: EINE Nachricht über den
// bestehenden Webhook (bisheriges Verhalten, nichts bricht ohne Setup).
// Schlägt der Bot-Weg fehl (Token ungültig, Bot nicht im Kanal, Netzwerk),
// fällt der Post auf den Webhook zurück statt komplett auszufallen.
async function postDailyBriefing(main, detail) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.DAILY_BRIEFING_SLACK_CHANNEL;
  if (!token || !channel) {
    await postToSlackWebhook(detail ? `${main}\n\n${detail}` : main);
    return;
  }
  const posted = await slackApi("chat.postMessage", token, { channel, text: main });
  if (!posted.ok) { await postToSlackWebhook(detail ? `${main}\n\n${detail}` : main); return; }
  const threadTs = posted.ts;
  for (const chunk of chunkText(detail, SLACK_CHUNK_MAX_CHARS)) {
    await slackApi("chat.postMessage", token, { channel, text: chunk, thread_ts: threadTs });
  }
}

// ── HF-Woche als "YYYY-Wnn" (Jahr + Woche, für den Sheet-Spaltenabgleich) ──
// Gleiche Rechnung wie currentWorkOrderWeek in rtiBackfillWatch.js (ISO-Woche
// + 1, Thursday-Trick), hier zusätzlich mit Jahr — Duplikat von
// src/lib/hfWeek.ts, weil Functions keinen Zugriff auf src/ haben.
function hfWeekLabel(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const week = isoWeek + 1;
  return week <= 52 ? `${isoYear}-W${String(week).padStart(2, "0")}` : `${isoYear + 1}-W01`;
}

// Nur die Zahl (ohne Jahr) — parseWoOverviewRows braucht sie zum Filtern auf
// "diese KW" über weekPrefixFromWoNumber (WO "39-101" -> 39), 1:1 wie
// transparencyLite.js.computeTransparencyProducibility das schon tut.
function weekNumFromLabel(weekLabel) {
  const m = /W(\d{1,2})$/i.exec(weekLabel);
  return m ? parseInt(m[1], 10) : null;
}

// ── Küchen-Besetzung (Portierung von parseStaffingPlan.ts, 1:1 halten) ─────
function parseStaffingNum(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[,\s]/g, "").trim();
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
function parseStaffingPlan(rows, weekLabel) {
  let headerRow = null;
  let headerScore = 0;
  for (const row of rows) {
    const score = row.filter(c => /^\d{4}-W\d{2}$/.test(String(c ?? "").trim())).length;
    if (score > headerScore) { headerScore = score; headerRow = row; }
  }
  if (!headerRow) return { kitchenHeadcount: null, platingHeadcount: null, weekLabel };

  const colIndex = headerRow.findIndex(c => String(c ?? "").trim() === weekLabel);
  if (colIndex < 0) return { kitchenHeadcount: null, platingHeadcount: null, weekLabel };

  const headcountRow = dept => rows.find(row =>
    row.some(c => String(c ?? "").trim() === "Headcount - Required")
    && row.some(c => String(c ?? "").trim() === dept));

  const kitchenRow = headcountRow("Kitchen");
  const platingRow = headcountRow("Plating");

  return {
    kitchenHeadcount: kitchenRow ? parseStaffingNum(kitchenRow[colIndex]) : null,
    platingHeadcount: platingRow ? parseStaffingNum(platingRow[colIndex]) : null,
    weekLabel,
  };
}

async function fetchStaffingPlanRows(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: STAFFING_PLAN_SHEET_ID,
    fields: "sheets(properties(title,sheetId))",
  });
  const tab = (meta.data.sheets || []).find(s => String(s.properties?.sheetId ?? "") === STAFFING_PLAN_GID);
  if (!tab) throw new Error(`Kein Tab mit gid=${STAFFING_PLAN_GID} im Staffing-Plan-Sheet gefunden`);
  const title = tab.properties?.title || "";
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: STAFFING_PLAN_SHEET_ID,
    range: `'${title.replace(/'/g, "''")}'!A1:BE400`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return resp.data.values || [];
}

// ── Backfill + Plating-Fortschritt (identische Rechenlogik wie
// rtiBackfillWatch, importiert — beide lesen denselben RTI-Sheet-Kopf) ──────
async function fetchRtiSignals(sheets, now) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: rti.RTI_SHEET_ID,
    range: `'${rti.RTI_SHEET_TAB}'!A1:Z2000`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  const rows = resp.data.values || [];
  const weekShort = rti.detectWeek(rows);

  let externalTargets = new Map();
  try {
    const derived = await rti.deriveHeaderTargets(weekShort, now);
    externalTargets = derived.targets;
  } catch (e) {
    logger.warn("deriveHeaderTargets fehlgeschlagen (Tagesbriefing)", { error: String(e).slice(0, 160) });
  }

  const parsed = rti.parseRti(rows);
  const backfills = rti.computeRtiBackfills(parsed, externalTargets, now);
  const openMeals = backfills.filter(m => !m.headerIncomplete && m.openSubs.length > 0);
  const platingProgress = rti.summarizeRtiProgress(parsed, externalTargets);
  return { openMeals, platingProgress };
}

// ── Transperancy Total Overview: EIN Fetch, ZWEI Verwendungen ─────────────
// Dasselbe Sheet/Tab liefert sowohl die WO-Ebene für Kritisch/Zu-plaitieren/
// Morgen-zuerst (parseWoOverviewRows unten) als auch die Grundlage für
// Transparency-Producibility (transparency.parseTotalOverview) — ein Fetch
// spart einen API-Call und garantiert, dass beide auf demselben Stand rechnen.
async function fetchTotalOverviewRows(sheets) {
  const tab = transparency.TRANSPARENCY_TABS["total-overview"];
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: FERTIGSTELLUNG_SHEET_ID,
    range: `'${tab.title.replace(/'/g, "''")}'!${tab.range}`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return resp.data.values || [];
}

// Portierung von scripts/read-production-plan.ts (nur die Spalten, die
// buildMealProgress/buildKitchenCritical/buildPlatingTodoLite/
// buildTomorrowPriorityLite unten tatsächlich brauchen — nicht run/recipeId/
// yieldPct/cookMethods/Status-Texte wie das TS-Original, die dort nur die
// Browser-Detailansicht füllen). 1:1 halten mit der Spalten-Erkennungslogik
// (Header per Namen suchen, nicht per festem Index — das Sheet hat schon
// mehrfach Spalten verschoben, siehe Kommentar in parseProductionPlan.ts).
// Live-Probe (2026-09-16, KW39) zeigte: die Spalten-NAMEN-Suche von
// scripts/read-production-plan.ts (Header per Text wie "Work Order"/"Recipe
// Name" suchen) griff auf diesem Tab nicht — die echte Kopfzeile hat andere
// Bezeichner. transparency.parseTotalOverview (transparencyLite.js) liest
// denselben Tab aber schon zuverlässig über FESTE Spalten-Indizes (verifiziert
// per computeTransparencyProducibility, das damit produktiv läuft) — hier
// dieselben geparsten Zeilen wiederverwenden statt eine zweite, abweichende
// Spalten-Erkennung zu pflegen. Nur die Feldnamen auf das mappen, was
// buildMealProgress unten braucht.
function parseWoOverviewRows(rows) {
  const { rows: flowRows } = transparency.parseTotalOverview(rows);
  return flowRows
    .filter(r => r.workOrder && r.recipeCode)
    .map(r => ({
      workOrder: r.workOrder,
      recipeCode: r.recipeCode,
      recipeName: r.recipeName || r.recipeCode,
      subRecipe: r.subRecipeName,
      plannedMeals: r.plannedMeals ?? 0,
      stagingKg: r.plannedStagingKg ?? 0,
      kitchenKg: r.kitchenKg ?? 0,
      postKg: r.plannedPostKg ?? 0,
      kitchenDay: r.plannedKitchenDay,
    }));
}

// Produktionsplan-Quelle, Priorität: 1) live GSheet ("Transperancy Total
// Overview", per Sheets API — kein Firestore/Browser-Zwischenschritt mehr
// nötig, siehe fetchTotalOverviewRows), 2) Firestore-Momentaufnahme
// apps/rezeptlogik/productionPlan/{KW} (nur befüllt, wenn zufällig ein
// Browser-Tab offen war/ist) als Fallback, falls das Sheet mal nicht lesbar
// ist. totalOverviewRows wird übergeben statt selbst gefetcht, damit der
// Aufrufer sie auch für Producibility wiederverwenden kann (ein Fetch).
async function fetchProductionPlanRows(totalOverviewRows, weekLabel) {
  try {
    const rows = parseWoOverviewRows(totalOverviewRows);
    if (rows.length > 0) return { generatedAt: new Date().toISOString(), rows, source: "gsheet" };
  } catch (e) {
    logger.warn("Produktionsplan aus GSheet parsen fehlgeschlagen", { error: String(e).slice(0, 160) });
  }
  try {
    const snap = await admin.firestore()
      .collection("apps").doc("rezeptlogik").collection("productionPlan").doc(weekLabel).get();
    if (!snap.exists) return null;
    const data = snap.data() || {};
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (rows.length === 0) return null;
    return { generatedAt: data.generatedAt || null, rows, source: "firestore" };
  } catch (e) {
    logger.warn("Produktionsplan-Fallback (Firestore) fehlgeschlagen", { error: String(e).slice(0, 160) });
    return null;
  }
}

// ── Erweiterte Signale: Kritisch (Küche), Zu plaitieren, Morgen zuerst ─────
// Portierung von matchPostblastToWorkOrders.ts / mealProgress.ts /
// plateableNet.ts, DEUTLICH vereinfacht:
//   • kein recipeWeights (export-recipes.csv ist nicht serverseitig verfügbar)
//     → grossPlateable nutzt IMMER den Planverhältnis-Fallback, nie den
//       Gramm/Portion-Pfad. Das ist derselbe Fallback, den der Browser auch
//       nutzt, wenn für ein Rezept keine Gewichtsdaten vorliegen — hier gilt
//       er einfach für alle Meals.
//   • kein rtiData-Abgleich (platingHoldingKg/rtiStatus je WO) — der
//     RTI-basierte Backfill-Bedarf kommt ohnehin schon aus dem eigenen
//     Backfill-Abschnitt oben, nicht nochmal hier.
//   • kein eigener Backfill-Vorschlag (BackfillNeed) — das RTI-Sheet ist die
//     verlässlichere Quelle dafür (siehe Backfill-Abschnitt), nicht nochmal
//     aus Gewichtsdifferenzen herleiten.
const POSTBLAST_GID = "161435799";
const PREBLAST_GID = "152682456";

function numKg(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[,\s]/g, "").replace(/[^\d.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// Summe der Wiegungen je WO — mehr braucht die vereinfachte Kritisch-/Plating-
// Rechnung nicht (keine Einzel-Wiegungen/Timestamps wie im Browser-Panel).
async function fetchBlastWeightsByWo(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${rti.RTI_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok || !(res.headers.get("content-type") || "").includes("csv")) {
    throw new Error(`Blast-CSV gid=${gid} nicht lesbar (HTTP ${res.status})`);
  }
  const rows = rti.parseCsv(await res.text());
  const byWo = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const wo = String(row[1] ?? "").trim();
    if (!wo) continue;
    byWo.set(wo, (byWo.get(wo) ?? 0) + numKg(row[2]));
  }
  return byWo;
}

// Zwilling von matchPostblastToWorkOrders (siehe Kommentarblock oben) —
// liefert nur, was Kritisch/PlatingTodo/TomorrowPriority tatsächlich brauchen.
function buildMealProgress(planRows, postblastByWo, preblastByWo) {
  const matched = [];
  for (const wo of planRows) {
    const woNum = String(wo.workOrder || "").trim();
    if (!woNum || !wo.recipeCode) continue;
    const actualKg = postblastByWo.get(woNum) ?? 0;
    const preBlastKg = preblastByWo.get(woNum) ?? 0;
    const plannedKg = Number(wo.postKg) || Number(wo.kitchenKg) || Number(wo.stagingKg) || 0;
    const awaitingPostBlast = preBlastKg > 0 && actualKg === 0;
    const progressPct = Math.min(plannedKg > 0 ? (actualKg / plannedKg) * 100 : (actualKg > 0 ? 100 : 0), 100);
    const isComplete = plannedKg > 0 && progressPct >= 95;
    const isCritical = plannedKg > 0 && progressPct < 30 && actualKg === 0 && !awaitingPostBlast;
    matched.push({
      workOrder: woNum, subRecipe: wo.subRecipe || "", recipeCode: wo.recipeCode,
      recipeName: wo.recipeName || wo.recipeCode, plannedMeals: Number(wo.plannedMeals) || 0,
      plannedKg, actualKg, isComplete, isCritical, awaitingPostBlast, kitchenDay: wo.kitchenDay || "",
    });
  }

  const byMeal = new Map();
  for (const m of matched) {
    if (!byMeal.has(m.recipeCode)) byMeal.set(m.recipeCode, []);
    byMeal.get(m.recipeCode).push(m);
  }
  const meals = [];
  for (const [recipeCode, wos] of byMeal) {
    meals.push({
      recipeCode, recipeName: wos[0].recipeName, plannedMeals: wos[0].plannedMeals, workOrders: wos,
      criticalWOs: wos.filter(w => w.isCritical),
    });
  }
  return { matched, meals };
}

// Planverhältnis-Fallback von grossPlateable (siehe Kommentarblock oben —
// der Gramm/Portion-Pfad entfällt hier ganz, recipeWeights ist immer null).
function grossPlateableLite(meal) {
  const bySub = new Map();
  for (const wo of meal.workOrders) {
    const e = bySub.get(wo.subRecipe) ?? { actualKg: 0, plannedKgSum: 0, plannedWO: 0, totalWO: 0, blockingZero: false };
    e.actualKg += wo.actualKg;
    e.totalWO++;
    if (wo.plannedKg > 0) { e.plannedKgSum += wo.plannedKg; e.plannedWO++; }
    if (wo.plannedKg > 0 && wo.actualKg === 0 && !wo.awaitingPostBlast) e.blockingZero = true;
    bySub.set(wo.subRecipe, e);
  }
  for (const e of bySub.values()) if (e.actualKg > 0) e.blockingZero = false;

  let minMeals = Infinity, found = 0;
  for (const [, e] of bySub) {
    if (e.blockingZero) {
      found++;
      minMeals = Math.min(minMeals, 0);
    } else if (e.plannedWO > 0 && meal.plannedMeals > 0) {
      const estTotal = (e.plannedKgSum / e.plannedWO) * e.totalWO;
      const m = estTotal > 0 ? Math.floor((e.actualKg / estTotal) * meal.plannedMeals) : 0;
      found++;
      minMeals = Math.min(minMeals, m);
    }
  }
  if (found === 0) return null;
  return { meals: minMeals === Infinity ? 0 : Math.max(0, minMeals) };
}

async function fetchPlaitedByCode(now) {
  const lookback = rti.lookbackHoursSinceMonday(now);
  const [redzone, relay] = await Promise.all([
    rti.fetchRedzoneActuals(lookback).catch(() => null),
    rti.readRelayActuals(now).catch(() => null),
  ]);
  const byCode = new Map();
  if (redzone) for (const [k, v] of redzone) byCode.set(k, Math.max(byCode.get(k) ?? 0, v));
  if (relay) for (const [k, v] of relay) byCode.set(k, Math.max(byCode.get(k) ?? 0, v));
  return byCode;
}

// "Was ist JETZT netto plaitierbar" — Brutto (Planverhältnis-Fallback) minus
// schon plaitiert (Redzone/Relay, siehe fetchPlaitedByCode).
function buildPlatingTodoLite(meals, plaitedByCode) {
  const items = [];
  for (const meal of meals) {
    const gross = grossPlateableLite(meal);
    if (!gross) continue;
    const plated = Math.max(0, Math.round(plaitedByCode.get(rti.codeDigits(meal.recipeCode)) ?? 0));
    const grossMeals = Math.max(0, Math.round(gross.meals));
    const netMeals = Math.max(0, grossMeals - plated);
    if (netMeals <= 0) continue;
    items.push({ recipeCode: meal.recipeCode, recipeName: meal.recipeName, netMeals, grossMeals, platedMeals: plated });
  }
  items.sort((a, b) => b.netMeals - a.netMeals);
  return items;
}

// "Küche hat trotz Plan nichts gewogen" — dasselbe robuste Signal, das im
// Browser die Kritisch-Liste auch dann noch befüllt, wenn Transparency/
// Feasibility (Snowflake) nicht verfügbar sind (siehe buildCriticalItems in
// dailyBriefingLogic.ts).
function buildKitchenCritical(meals) {
  const items = [];
  for (const meal of meals) {
    if (meal.criticalWOs.length === 0) continue;
    const woList = meal.criticalWOs.slice(0, 4).map(w => w.workOrder).join(", ");
    const more = meal.criticalWOs.length > 4 ? ` +${meal.criticalWOs.length - 4}` : "";
    items.push({
      recipeCode: meal.recipeCode, recipeName: meal.recipeName, count: meal.criticalWOs.length,
      message: `${meal.criticalWOs.length} WO ohne Gewicht trotz Plan — ${woList}${more}`,
    });
  }
  items.sort((a, b) => b.count - a.count);
  return items;
}

// ── Transparency-Producibility → Kritisch-Einträge ─────────────────────────
// Zwilling von "producibility"-Quelle in buildCriticalItems (dailyBriefing
// Logic.ts): blocked/partial-Meals aus computeTransparencyProducibility, mit
// den bereits vorformulierten blockedReasons (siehe transparencyLite.js).
function buildProducibilityCritical(producibility) {
  if (!producibility) return [];
  const items = [];
  for (const meal of producibility.meals) {
    if (meal.status !== "blocked" && meal.status !== "partial") continue;
    items.push({
      recipeCode: meal.recipeCode, recipeName: meal.recipeName,
      severity: meal.status === "blocked" ? "critical" : "warning",
      message: meal.blockedReasons.slice(0, 2).join("; ") || "nicht vollständig produziert",
    });
  }
  return items;
}

function parseKitchenDayShift(kitchenDay) {
  const m = /^(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d+)/.exec(String(kitchenDay || ""));
  return m ? { date: m[1] } : { date: String(kitchenDay || "") };
}

function berlinIsoDate(date, dayOffset) {
  const shifted = new Date(date.getTime() + dayOffset * 86400000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(shifted);
  const get = t => parts.find(p => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Kritisches zuerst, danach die größten Ansätze — Zwilling von
// buildTomorrowPriority (dailyBriefingLogic.ts), aber "fertig" hier über die
// echte Gewichts-Kennzahl (isComplete) statt der Standort-Heuristik der
// KET-Ansicht (die braucht Felder, die der Produktionsplan hier nicht führt).
function buildTomorrowPriorityLite(matched, now, kitchenCriticalByCode) {
  const tomorrow = berlinIsoDate(now, 1);
  const rows = matched.filter(w => !w.isComplete && parseKitchenDayShift(w.kitchenDay).date === tomorrow);
  if (rows.length === 0) return [];

  return rows
    .map(w => {
      const crit = kitchenCriticalByCode.get(w.recipeCode);
      return {
        w, isCritical: !!crit,
        reason: crit ? `Kritisch (Küche): ${crit.message}` : `Großer Ansatz (${nf(w.plannedMeals)} Portionen)`,
      };
    })
    .sort((a, b) => Number(b.isCritical) - Number(a.isCritical) || b.w.plannedMeals - a.w.plannedMeals)
    .slice(0, 8)
    .map(({ w, reason }) => ({
      workOrder: w.workOrder, recipeCode: w.recipeCode, recipeName: w.recipeName,
      subRecipe: w.subRecipe, plannedMeals: w.plannedMeals, reason,
    }));
}

// Bündelt Produktionsplan-Read + Postblast/Preblast-Fetch + die drei
// abgeleiteten Listen. Postblast-Fehler ist FATAL für den ganzen Block: ohne
// echte Ist-Gewichte sähe jede geplante WO wie "Küche hat nichts gewogen"
// aus — ein Fetch-Fehler darf niemals als Produktionsproblem verkleidet
// werden. Fehlender Produktionsplan (weder GSheet noch Firestore-
// Momentaufnahme verfügbar) wird separat und ehrlich ausgewiesen.
async function fetchExtendedSignals(totalOverviewRows, now, weekLabel) {
  const plan = await fetchProductionPlanRows(totalOverviewRows, weekLabel);
  if (!plan || plan.rows.length === 0) {
    return { ok: false, reason: `kein Produktionsplan für ${weekLabel} gefunden (weder GSheet noch Firestore)`, kitchenCritical: [], platingTodo: [], tomorrowPriority: [] };
  }

  const [postblastByWo, preblastByWo] = await Promise.all([
    fetchBlastWeightsByWo(POSTBLAST_GID),
    fetchBlastWeightsByWo(PREBLAST_GID),
  ]);
  const { matched, meals } = buildMealProgress(plan.rows, postblastByWo, preblastByWo);
  const kitchenCritical = buildKitchenCritical(meals);
  const plaitedByCode = await fetchPlaitedByCode(now).catch(() => new Map());
  const platingTodo = buildPlatingTodoLite(meals, plaitedByCode);
  const kitchenCriticalByCode = new Map(kitchenCritical.map(c => [c.recipeCode, c]));
  const tomorrowPriority = buildTomorrowPriorityLite(matched, now, kitchenCriticalByCode);

  return { ok: true, generatedAt: plan.generatedAt, source: plan.source, kitchenCritical, platingTodo, tomorrowPriority };
}

// ── Producibility fetchen (3 weitere Tabs; total-overview kommt schon von
// fetchTotalOverviewRows, hier nur nochmal geparst) ─────────────────────────
async function fetchTransparencyProducibility(sheets, totalOverviewRows, weekNum) {
  const fetchTab = async (key) => {
    const tab = transparency.TRANSPARENCY_TABS[key];
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: transparency.TRANSPARENCY_SHEET_ID,
      range: `'${tab.title.replace(/'/g, "''")}'!${tab.range}`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    return resp.data.values || [];
  };

  const [weighingRows, planningCheckRows, rtemRows] = await Promise.all([
    fetchTab("importrange-weights"),
    fetchTab("planning-check"),
    fetchTab("rtem"),
  ]);

  const flow = transparency.parseTotalOverview(totalOverviewRows);
  const weighing = transparency.parseWeighingLedger(weighingRows);
  const planningCheck = transparency.parsePlanningCheck(planningCheckRows);
  const rtem = transparency.parseRtem(rtemRows);
  return transparency.computeTransparencyProducibility(flow, weighing, rtem, planningCheck, weekNum);
}

// ── Relay-Snapshot (Equipment morgen + Feasibility) ────────────────────────
// Geschrieben vom lokalen Script (siehe Kommentarblock oben) — hier nur
// gelesen + auf Frische geprüft. Fehlt der Doc oder ist er zu alt, kommt
// "unavailable" zurück (kein Fehler, kein Alarm — der Relay-Job kann einfach
// gerade nicht laufen, z. B. Rechner aus/Snowflake-SSO abgelaufen).
async function fetchRelaySnapshot() {
  try {
    const snap = await admin.firestore()
      .collection("apps").doc("rezeptlogik").collection("dailyBriefing").doc("relaySnapshot").get();
    if (!snap.exists) return { available: false };
    const data = snap.data() || {};
    const ageMin = (Date.now() - (data.updatedAt ?? 0)) / 60000;
    if (!(ageMin <= RELAY_FRESHNESS_MIN)) return { available: false, staleMinutes: Math.round(ageMin) };
    return { available: true, equipmentTomorrow: data.equipmentTomorrow ?? null, feasibility: Array.isArray(data.feasibility) ? data.feasibility : [] };
  } catch (e) {
    logger.warn("Relay-Snapshot lesen fehlgeschlagen", { error: String(e).slice(0, 160) });
    return { available: false };
  }
}

// Eigene Rundung/DE-Format, 1:1 mit `nf` aus rtiBackfillWatch.js (nicht
// exportiert, daher hier dupliziert — trivialer Einzeiler).
const nf = n => Math.round(n).toLocaleString("de-DE");

// Meal gilt als fertig plaitiert ab 95 % — derselbe Schwellwert wie
// isComplete in postblastMatch.ts.
const PLATING_DONE_PCT = 95;
// Mehr als das würde den Post sprengen — Rest nur als Zahl anhängen.
const PLATING_LIST_MAX = 8;

const EXTENDED_LIST_MAX = 8;
const COMPACT_CRITICAL_MAX = 5;

// Alle "Kritisch"-Quellen (Küche, Produzierbarkeit, Rohware) zu EINER
// severity-sortierten Liste zusammenführen — Zwilling der Zusammenführung in
// buildCriticalItems (dailyBriefingLogic.ts), nur mit den drei server-seitig
// verfügbaren Quellen statt vier (Cross-Source-Alerts fehlen noch, siehe
// Kommentarblock oben).
function buildCombinedCritical(kitchenCritical, producibilityCritical, feasibilityItems) {
  const items = [];
  for (const c of kitchenCritical) items.push({ severity: "critical", sourceLabel: "Küche", recipeCode: c.recipeCode, recipeName: c.recipeName, message: c.message });
  for (const c of producibilityCritical) items.push({ severity: c.severity, sourceLabel: "Produzierbarkeit", recipeCode: c.recipeCode, recipeName: c.recipeName, message: c.message });
  for (const f of feasibilityItems) items.push({ severity: f.verdict === "blocked" ? "critical" : "warning", sourceLabel: "Rohware", recipeCode: f.recipeCode, recipeName: f.recipeName, message: f.message });
  const rank = { critical: 0, warning: 1 };
  items.sort((a, b) => (rank[a.severity] ?? 1) - (rank[b.severity] ?? 1) || a.recipeName.localeCompare(b.recipeName));
  return items;
}

// ── Equipment morgen → Slack-Text ──────────────────────────────────────────
function formatEquipmentSection(relay) {
  if (!relay.available) {
    return relay.staleMinutes != null
      ? `⚙️ *Equipment morgen*: _Relay-Daten veraltet (${relay.staleMinutes} Min.) — lokaler Relay-Job läuft gerade nicht._`
      : `⚙️ *Equipment morgen*: _kein Relay-Snapshot verfügbar (lokaler Relay-Job noch nicht gelaufen)._`;
  }
  const eq = relay.equipmentTomorrow;
  if (!eq || !eq.runs || eq.runs.length === 0) {
    return `⚙️ *Equipment morgen (${eq?.date ?? ""})*: keine WOs im KET-Plan für diesen Tag.`;
  }
  const lines = [`⚙️ *Equipment morgen (${eq.date})*`];
  for (const run of eq.runs) {
    lines.push(`${rti.IND}Run ${run.run} · ${run.shiftLabel} · ${run.totalWos} WOs · ${nf(run.totalKg)} kg · ${run.totalGnTrays} Bleche · ${run.totalWannen} Wannen · MA ${run.totalStaffNeeded}`);
    for (const st of run.stations.slice(0, 6)) {
      lines.push(`${rti.IND}${rti.IND}• ${st.label}: ${st.totalBatches} Bat · ${nf(st.totalKg)} kg${st.ovenLoads != null ? ` · ${st.ovenLoads} Racks` : ""}`);
    }
    if (run.chillerSlots.length > 0) {
      lines.push(`${rti.IND}${rti.IND}❄ ${run.chillerSlots.map(c => `${c.label}:${c.woCount}`).join(" · ")}`);
    }
  }
  return lines.join("\n");
}

function formatFeasibilitySection(relay) {
  if (!relay.available) return null; // schon in formatEquipmentSection erklärt, nicht doppelt zeigen
  if (relay.feasibility.length === 0) return "✅ Rohware/MHD: keine blockierten/knappen Backfills erkannt.";
  const lines = [`🧊 *Rohware/MHD — blockierte/knappe Backfills (${relay.feasibility.length})*`];
  for (const f of relay.feasibility.slice(0, EXTENDED_LIST_MAX)) {
    lines.push(`${rti.IND}${f.verdict === "blocked" ? "🔴" : "🟡"} *${f.recipeCode}* ${f.recipeName} — ${f.message}`);
  }
  if (relay.feasibility.length > EXTENDED_LIST_MAX) lines.push(`${rti.IND}_(+${relay.feasibility.length - EXTENDED_LIST_MAX} weitere)_`);
  return lines.join("\n");
}

// ── Post zusammenbauen ──────────────────────────────────────────────────────
// Baut den Post in zwei Teilen: compactLines (KPI-Kacheln + Top-Kritisch, für
// den Hauptpost) und detailLines (alles andere, für die Thread-Antwort).
// buildMessage() (unten) verbindet beide zu EINEM String — Rückwärts-
// kompatibel für Tests/den Webhook-Fallback ohne Bot-Token.
function buildBriefingParts({ now, openMeals, platingProgress, rtiError, kitchenHeadcount, platingHeadcount, weekLabel, extended, producibility, relay }) {
  const dateStr = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin", weekday: "long", day: "2-digit", month: "2-digit",
  }).format(now);

  const producibilityCritical = buildProducibilityCritical(producibility);
  const feasibilityItems = relay.available ? relay.feasibility : [];
  const combinedCritical = buildCombinedCritical(extended.ok ? extended.kitchenCritical : [], producibilityCritical, feasibilityItems);

  // ── Compact (Hauptpost) ─────────────────────────────────────────────────
  const compact = [`*Tagesbriefing · 15:00 · ${dateStr}*`, rti.RULE];
  compact.push(kitchenHeadcount != null
    ? `👥 Besetzung Küche: *${kitchenHeadcount} MA*  _(lt. Staffing-Plan, ${weekLabel})_`
    : `👥 Besetzung Küche: _Staffing-Plan nicht erreichbar_`);
  compact.push(platingHeadcount != null
    ? `👥 Besetzung Plating: *${platingHeadcount} MA*  _(lt. Staffing-Plan, ${weekLabel})_`
    : `👥 Besetzung Plating: _Staffing-Plan nicht erreichbar_`);

  const doneCount = platingProgress.filter(m => m.pct >= PLATING_DONE_PCT).length;
  const producibilitySummary = producibility ? `${producibility.readyCount}/${producibility.meals.length} ready` : "n/v";
  const equipmentFlag = relay.available ? "✅ verfügbar" : "⚠️ nicht verfügbar";
  compact.push("");
  compact.push(`📊 Kritisch: *${combinedCritical.length}* · Backfill: *${openMeals.length}* Meal(s) · Plating: *${doneCount}/${platingProgress.length}* ≥${PLATING_DONE_PCT}% · Produzierbarkeit: *${producibilitySummary}* · Equipment morgen: ${equipmentFlag}`);
  compact.push("");

  if (combinedCritical.length > 0) {
    compact.push(`🚨 *Kritisch (${combinedCritical.length}) — Top ${Math.min(COMPACT_CRITICAL_MAX, combinedCritical.length)}*`);
    for (const c of combinedCritical.slice(0, COMPACT_CRITICAL_MAX)) {
      compact.push(`${rti.IND}${c.severity === "critical" ? "🔴" : "🟡"} [${c.sourceLabel}] *${c.recipeCode}* ${c.recipeName} — ${c.message}`);
    }
    if (combinedCritical.length > COMPACT_CRITICAL_MAX) compact.push(`${rti.IND}_(+${combinedCritical.length - COMPACT_CRITICAL_MAX} weitere im Thread)_`);
  } else {
    compact.push("✅ Keine kritischen Meldungen.");
  }
  compact.push("");
  compact.push("_Details (Backfill, Plating-Fortschritt, Produzierbarkeit, Zu plaitieren, Morgen zuerst, Equipment, Rohware) im Thread ⬇️_");

  // ── Detail (Thread) ──────────────────────────────────────────────────────
  const detail = [];

  if (extended.ok && extended.kitchenCritical.length > 0) {
    const stand = extended.generatedAt
      ? new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(extended.generatedAt))
      : null;
    const standTag = stand ? `  _(Produktionsplan-Stand: ${stand}${extended.source === "firestore" ? ", Firestore-Fallback" : ""})_` : "";
    detail.push(`🚨 *Kritisch – Küche (${extended.kitchenCritical.length} Meal${extended.kitchenCritical.length === 1 ? "" : "s"} ohne Gewicht trotz Plan)*${standTag}`);
    for (const c of extended.kitchenCritical.slice(0, EXTENDED_LIST_MAX)) {
      detail.push(`${rti.IND}• *${c.recipeCode}* ${c.recipeName} — ${c.message}`);
    }
    if (extended.kitchenCritical.length > EXTENDED_LIST_MAX) detail.push(`${rti.IND}_(+${extended.kitchenCritical.length - EXTENDED_LIST_MAX} weitere)_`);
    detail.push("");
  } else if (!extended.ok) {
    detail.push(`🚨 Kritisch (Küche) / Zu plaitieren / Morgen zuerst: _${extended.reason}_`);
    detail.push("");
  } else {
    detail.push("✅ Keine kritischen Küchen-WOs.");
    detail.push("");
  }

  if (producibility) {
    detail.push(`🧪 *Produzierbarkeit (Transparency)*: ${producibility.readyCount} ready · ${producibility.partialCount} partial · ${producibility.blockedCount} blocked`);
    for (const c of producibilityCritical.slice(0, EXTENDED_LIST_MAX)) {
      detail.push(`${rti.IND}${c.severity === "critical" ? "🔴" : "🟡"} *${c.recipeCode}* ${c.recipeName} — ${c.message}`);
    }
    if (producibilityCritical.length > EXTENDED_LIST_MAX) detail.push(`${rti.IND}_(+${producibilityCritical.length - EXTENDED_LIST_MAX} weitere)_`);
  } else {
    detail.push("🧪 Produzierbarkeit (Transparency): _nicht ermittelbar (Sheet-Fehler, siehe Logs)_");
  }
  detail.push("");

  if (rtiError) {
    detail.push("⚠️ Backfill & Plating-Fortschritt: RTI-Sheet gerade nicht erreichbar.");
  } else {
    if (openMeals.length > 0) {
      detail.push(`🔴 *Backfill offen (${openMeals.length} Meal${openMeals.length === 1 ? "" : "s"})*`);
      detail.push(openMeals.map(m => rti.mealBlock(m, m.openSubs.map(rti.subNeed))).join("\n\n"));
    } else {
      detail.push("✅ Kein offener Backfill-Bedarf.");
    }
    detail.push("");

    const done = platingProgress.filter(m => m.pct >= PLATING_DONE_PCT);
    const open = platingProgress.filter(m => m.pct < PLATING_DONE_PCT);
    if (platingProgress.length === 0) {
      detail.push("🍽 Plating-Fortschritt: noch keine Wiegedaten für heute.");
    } else {
      detail.push(`🍽 *Plating-Fortschritt*: ${done.length} von ${platingProgress.length} Meals ≥${PLATING_DONE_PCT} % fertig`);
      const shown = open.slice(0, PLATING_LIST_MAX);
      for (const m of shown) {
        const est = m.targetEstimated ? "  _(geschätzt)_" : "";
        detail.push(`${rti.IND}• *${m.mealCode}* ${m.mealName} — ${Math.round(m.pct)} %  (${nf(m.actuals)} / ${nf(m.plannedTarget)})${est}`);
      }
      if (open.length > shown.length) detail.push(`${rti.IND}_(+${open.length - shown.length} weitere < ${PLATING_DONE_PCT} %)_`);
    }
  }
  detail.push("");

  if (extended.ok) {
    if (extended.platingTodo.length > 0) {
      detail.push(`🍽 *Zu plaitieren (jetzt möglich)*`);
      for (const p of extended.platingTodo.slice(0, EXTENDED_LIST_MAX)) {
        detail.push(`${rti.IND}• *${p.recipeCode}* ${p.recipeName} — ${nf(p.netMeals)} Port. bereit  (${nf(p.platedMeals)}/${nf(p.grossMeals)} schon plaitiert)`);
      }
      if (extended.platingTodo.length > EXTENDED_LIST_MAX) detail.push(`${rti.IND}_(+${extended.platingTodo.length - EXTENDED_LIST_MAX} weitere)_`);
      detail.push("");
    }

    if (extended.tomorrowPriority.length > 0) {
      detail.push(`🌅 *Morgen zuerst anfassen*`);
      for (const p of extended.tomorrowPriority) {
        detail.push(`${rti.IND}• WO ${p.workOrder} — *${p.recipeCode}* ${p.recipeName} (${p.subRecipe}) — ${p.reason}`);
      }
      detail.push("");
    }
  }

  detail.push(formatEquipmentSection(relay));
  detail.push("");
  const feasText = formatFeasibilitySection(relay);
  if (feasText) { detail.push(feasText); detail.push(""); }

  detail.push("_Als Nächstes geplant: Cross-Source-Backfill-Alerts (Plating-Team-Meldungen aus LinePlaiting)._");

  return { compact: compact.join("\n"), detail: detail.join("\n") };
}

// Rückwärtskompatibel: EIN String (Hauptpost + Detail zusammen) — für
// bestehende Tests und den Webhook-Fallback ohne Bot-Token.
function buildMessage(opts) {
  const { compact, detail } = buildBriefingParts(opts);
  return `${compact}\n\n${detail}`;
}

// ── Scheduler ────────────────────────────────────────────────────────────
exports.dailyBriefingSlack = onSchedule(
  { schedule: DAILY_BRIEFING_SCHEDULE, timeZone: "Europe/Berlin", region: REGION, timeoutSeconds: 60 },
  async () => {
    const now = new Date();
    const sheets = await rti.sheetsClient(true);
    const weekLabel = hfWeekLabel(now);
    const weekNum = weekNumFromLabel(weekLabel);

    let openMeals = [];
    let platingProgress = [];
    let rtiError = false;
    try {
      const signals = await fetchRtiSignals(sheets, now);
      openMeals = signals.openMeals;
      platingProgress = signals.platingProgress;
    } catch (e) {
      rtiError = true;
      logger.error("RTI-Abruf für Tagesbriefing fehlgeschlagen", { error: e?.message || String(e) });
    }

    let kitchenHeadcount = null;
    let platingHeadcount = null;
    try {
      const rows = await fetchStaffingPlanRows(sheets);
      const staffing = parseStaffingPlan(rows, weekLabel);
      kitchenHeadcount = staffing.kitchenHeadcount;
      platingHeadcount = staffing.platingHeadcount;
    } catch (e) {
      logger.warn("Staffing-Plan für Tagesbriefing fehlgeschlagen", { error: String(e).slice(0, 160) });
    }

    let totalOverviewRows = [];
    try {
      totalOverviewRows = await fetchTotalOverviewRows(sheets);
    } catch (e) {
      logger.warn("Transperancy Total Overview lesen fehlgeschlagen", { error: String(e).slice(0, 160) });
    }

    let extended;
    try {
      extended = await fetchExtendedSignals(totalOverviewRows, now, weekLabel);
    } catch (e) {
      extended = { ok: false, reason: "Postblast/Preblast nicht erreichbar", kitchenCritical: [], platingTodo: [], tomorrowPriority: [] };
      logger.error("Erweiterte Tagesbriefing-Signale fehlgeschlagen", { error: e?.message || String(e) });
    }

    let producibility = null;
    try {
      producibility = totalOverviewRows.length > 0
        ? await fetchTransparencyProducibility(sheets, totalOverviewRows, weekNum)
        : null;
    } catch (e) {
      logger.warn("Transparency-Producibility für Tagesbriefing fehlgeschlagen", { error: String(e).slice(0, 160) });
    }

    const relay = await fetchRelaySnapshot();

    const { compact, detail } = buildBriefingParts({
      now, openMeals, platingProgress, rtiError, kitchenHeadcount, platingHeadcount, weekLabel, extended, producibility, relay,
    });
    await postDailyBriefing(compact, detail);

    logger.info("dailyBriefingSlack gepostet", {
      openMeals: openMeals.length, platingProgressMeals: platingProgress.length, rtiError,
      kitchenHeadcount, platingHeadcount, weekLabel,
      extendedOk: extended.ok, extendedSource: extended.source, kitchenCritical: extended.kitchenCritical.length,
      platingTodo: extended.platingTodo.length, tomorrowPriority: extended.tomorrowPriority.length,
      producibilityOk: !!producibility, relayAvailable: relay.available,
      slackConfigured: !!process.env.DAILY_BRIEFING_SLACK_WEBHOOK_URL,
      slackBotConfigured: !!(process.env.SLACK_BOT_TOKEN && process.env.DAILY_BRIEFING_SLACK_CHANNEL),
    });
  },
);

// für lokale Tests (nicht als Function deployen — siehe index.js-Einbindung)
module.exports._internal = {
  parseStaffingPlan, hfWeekLabel, weekNumFromLabel, buildMessage, buildBriefingParts,
  buildMealProgress, grossPlateableLite, buildPlatingTodoLite, buildKitchenCritical,
  buildTomorrowPriorityLite, parseKitchenDayShift, berlinIsoDate,
  parseWoOverviewRows, buildProducibilityCritical, buildCombinedCritical,
  formatEquipmentSection, formatFeasibilitySection, chunkText,
};
