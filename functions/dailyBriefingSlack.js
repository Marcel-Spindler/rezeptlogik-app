// Tagesbriefing 15:00 — Slack-Post, server-seitig (MVP).
//
// Umfang bewusst klein gehalten: der volle Tagesbriefing-Rechenkern
// (src/features/daily-briefing/dailyBriefingLogic.ts — Kritisch, gefährdete
// WOs mit Rohware/MHD, Plating-Todo, Morgen zuerst) läuft im Browser über
// React-Hooks auf Live-GSheet-/Snowflake-Daten und ist kein 1:1 portierbarer
// Server-Job (allein die RTI-Backfill-Rechenlogik serverseitig sind schon
// ~940 Zeilen, siehe rtiBackfillWatch.js). Dieser Post deckt zwei Signale ab,
// die schon zuverlässig serverseitig verfügbar sind:
//   • Backfill-Bedarf   — exakt dieselbe Rechenlogik wie rtiBackfillWatch
//                         (importiert, nicht dupliziert — siehe unten).
//   • Küchen-Besetzung  — aus dem wöchentlichen Staffing-Plan-Sheet
//                         (Portierung von parseStaffingPlan.ts, 1:1 halten).
// Erweiterbar "auf Zuruf", wenn mehr Umfang gebraucht wird.
//
// Nötig: DAILY_BRIEFING_SLACK_WEBHOOK_URL in functions/.env — siehe
// TAGESBRIEFING_SLACK_SETUP.md (Repo-Wurzel). Eigene Variable, unabhängig von
// SLACK_WEBHOOK_URL (rtiBackfillWatch) — beide Automatisierungen können in
// unterschiedliche Kanäle posten.

const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const rti = require("./rtiBackfillWatch.js")._internal;

const REGION = "europe-west3";

// Cron, Standard: jeden Tag 15:00 Europe/Berlin. Anpassbar ohne Deploy-Logik-
// Änderung, nur die Env-Var setzen (z. B. "0 15 * * 1-5" für Mo–Fr).
const DAILY_BRIEFING_SCHEDULE = process.env.DAILY_BRIEFING_SCHEDULE || "0 15 * * *";

// Staffing-Plan-Sheet (Hiring/Kosten-BP-Modell, "Headcount - Required" je
// Abteilung/KW) — mit dem Service-Account ("PDL fast reader") geteilt.
const STAFFING_PLAN_SHEET_ID = process.env.STAFFING_PLAN_SHEET_ID || "1qHOGFAbUmAa4nxqBF9LcAT3trl0inDoupZflQhqb8wU";
const STAFFING_PLAN_GID = process.env.STAFFING_PLAN_GID || "630874084";

// ── Slack ────────────────────────────────────────────────────────────────
async function postToSlack(text) {
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
  if (!headerRow) return { kitchenHeadcount: null, weekLabel };

  const colIndex = headerRow.findIndex(c => String(c ?? "").trim() === weekLabel);
  if (colIndex < 0) return { kitchenHeadcount: null, weekLabel };

  const kitchenRow = rows.find(row =>
    row.some(c => String(c ?? "").trim() === "Headcount - Required")
    && row.some(c => String(c ?? "").trim() === "Kitchen"));
  if (!kitchenRow) return { kitchenHeadcount: null, weekLabel };

  return { kitchenHeadcount: parseStaffingNum(kitchenRow[colIndex]), weekLabel };
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

// ── Backfill (identische Rechenlogik wie rtiBackfillWatch, importiert) ─────
async function fetchOpenBackfills(sheets, now) {
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
  return backfills.filter(m => !m.headerIncomplete && m.openSubs.length > 0);
}

// ── Post zusammenbauen ──────────────────────────────────────────────────────
function buildMessage({ now, openMeals, kitchenHeadcount, weekLabel }) {
  const dateStr = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin", weekday: "long", day: "2-digit", month: "2-digit",
  }).format(now);

  const lines = [`*Tagesbriefing · 15:00 · ${dateStr}*`, rti.RULE];

  lines.push(kitchenHeadcount != null
    ? `👥 Besetzung Küche: *${kitchenHeadcount} MA*  _(lt. Staffing-Plan, ${weekLabel})_`
    : `👥 Besetzung Küche: _Staffing-Plan nicht erreichbar_`);
  lines.push("");

  if (openMeals.length > 0) {
    lines.push(`🔴 *Backfill offen (${openMeals.length} Meal${openMeals.length === 1 ? "" : "s"})*`);
    lines.push(openMeals.map(m => rti.mealBlock(m, m.openSubs.map(rti.subNeed))).join("\n\n"));
  } else {
    lines.push("✅ Kein offener Backfill-Bedarf.");
  }

  lines.push("");
  lines.push("_MVP — voller Umfang (Kritisch/Rohware/Plating-Todo/Morgen zuerst) folgt._");
  return lines.join("\n");
}

// ── Scheduler ────────────────────────────────────────────────────────────
exports.dailyBriefingSlack = onSchedule(
  { schedule: DAILY_BRIEFING_SCHEDULE, timeZone: "Europe/Berlin", region: REGION, timeoutSeconds: 60 },
  async () => {
    const now = new Date();
    const sheets = await rti.sheetsClient(true);

    let openMeals = [];
    try {
      openMeals = await fetchOpenBackfills(sheets, now);
    } catch (e) {
      logger.error("Backfill-Abruf für Tagesbriefing fehlgeschlagen", { error: e?.message || String(e) });
    }

    let kitchenHeadcount = null;
    const weekLabel = hfWeekLabel(now);
    try {
      const rows = await fetchStaffingPlanRows(sheets);
      kitchenHeadcount = parseStaffingPlan(rows, weekLabel).kitchenHeadcount;
    } catch (e) {
      logger.warn("Staffing-Plan für Tagesbriefing fehlgeschlagen", { error: String(e).slice(0, 160) });
    }

    await postToSlack(buildMessage({ now, openMeals, kitchenHeadcount, weekLabel }));
    logger.info("dailyBriefingSlack gepostet", {
      openMeals: openMeals.length, kitchenHeadcount, weekLabel,
      slackConfigured: !!process.env.DAILY_BRIEFING_SLACK_WEBHOOK_URL,
    });
  },
);

// für lokale Tests (nicht als Function deployen — siehe index.js-Einbindung)
module.exports._internal = { parseStaffingPlan, hfWeekLabel, buildMessage };
