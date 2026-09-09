// RTI Backfill-Wächter – server-seitig.
//
//  1) rtiBackfillWatch (onSchedule, alle 10 min)
//       Liest den RTI Plating Tracker, rechnet pro Sub-Rezept den Backfill-Bedarf
//       (Portierung von src/features/backfills/rtiBackfillCalculator.ts), vergleicht
//       mit dem letzten Stand in Firestore und postet Änderungen nach Slack:
//         • neuer offener Engpass          → 🔴
//         • Engpass ins System eingetragen → ✅
//         • Wiegung läuft > STALE_MIN, aber Subs noch ohne Status → ⏰
//       Nötig:  SLACK_WEBHOOK_URL in functions/.env
//               (RTI_SHEET_ID / RTI_SHEET_TAB optional, Defaults unten)
//
//  2) rtiMarkDone (onRequest, POST { wo, subRecipe })
//       Schreibt "done" in Spalte J der passenden WO-Zeile. Der Backfill-Wächter
//       ruft das beim „ins System eingetragen“ auf.
//       Nötig:  der Service-Account (GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) braucht
//               BEARBEITER-Rechte auf dem RTI-Sheet.
//
// >>> Rechenlogik 1:1 mit rtiBackfillCalculator.ts halten <<<

const admin = require("firebase-admin");
const { google } = require("googleapis");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");

const RTI_SHEET_ID = process.env.RTI_SHEET_ID || "1-brEn6eKSMFDTubokqA7brq_BzjKP0RpmGw4A1RPspw";
const RTI_SHEET_TAB = process.env.RTI_SHEET_TAB || "RTI";
const STALE_MIN = Number(process.env.RTI_STALE_MIN || 30);
const MIN_SUB_SHORTFALL = 30;
const REGION = "europe-west3";

function stateDoc() {
  return admin.firestore().collection("apps").doc("rezeptlogik").collection("backfillWatch").doc("state");
}

// ── Sheets-Clients ──────────────────────────────────────────────────────────
function saCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  return raw ? JSON.parse(Buffer.from(raw, "base64").toString("utf8")) : undefined;
}
async function sheetsClient(readonly) {
  const auth = new google.auth.GoogleAuth({
    credentials: saCredentials(),
    scopes: [readonly ? "https://www.googleapis.com/auth/spreadsheets.readonly" : "https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

// ── Parser (Portierung von parseRti.ts) ─────────────────────────────────────
function num(s) {
  if (s == null || s === "" || s === "#DIV/0!") return 0;
  const n = parseFloat(String(s).replace(/[,\s]/g, "").replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function pct(s) {
  if (s == null || s === "" || s === "#DIV/0!") return 0;
  const n = parseFloat(String(s).replace(/[%\s]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
const FV_HEADER_RE = /(FV\d{4}[A-Z]?)\s*[-–]\s*(.+)/i;
function cleanMealName(raw) {
  return String(raw).replace(/^\[[^\]]*\]\s*[-–]\s*/, "").replace(/\s*\[[^\]]*\]\s*$/, "").trim();
}
function isEndOfWeek(row) {
  return /end of week count/i.test(`${row[0] ?? ""} ${row[1] ?? ""}`);
}

function parseRti(rows) {
  const meals = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i] || [];
    if (isEndOfWeek(row)) break;
    const m = FV_HEADER_RE.exec(String(row[1] ?? "").trim());
    if (m) {
      const mealCode = m[1].toUpperCase();
      const mealName = cleanMealName(m[2]);
      const plannedTarget = num(row[3]);
      const actuals = num(row[4]);
      i += 1;
      if (i < rows.length && String((rows[i] || [])[0] ?? "").includes("WO")) i++;
      const subRecipes = [];
      const seen = new Set();
      while (i < rows.length) {
        const sr = rows[i] || [];
        const wo = String(sr[0] ?? "").trim();
        const subName = String(sr[1] ?? "").trim();
        if (FV_HEADER_RE.test(subName) || isEndOfWeek(sr)) break;
        if (!wo && !subName) { i++; break; }
        if (/^\d{2,3}-\d{2,4}$/.test(wo) && subName) {
          const statusRaw = String(sr[9] ?? "").trim().toLowerCase();
          const status = /^done/.test(statusRaw) ? "done" : statusRaw === "no" ? "not-needed" : statusRaw ? "unknown" : "open";
          const isBackfillCandidate = seen.has(subName);
          seen.add(subName);
          subRecipes.push({
            workOrder: wo, subRecipeName: subName,
            platingHoldingKg: num(sr[2]), weighedKg: num(sr[3]), gramPerMeal: num(sr[4]),
            availableMealcount: num(sr[5]), minimumNeed: num(sr[6]), shortagePct: pct(sr[7]),
            backfillMeals: num(sr[8]), status, isBackfillCandidate,
          });
        }
        i++;
      }
      meals.push({ mealCode, mealName, plannedTarget, actuals, subRecipes });
      continue;
    }
    i++;
  }
  return meals;
}

// ── Rechner (Portierung von computeRtiBackfills) ────────────────────────────
function classify(sub, gap, plannedTarget) {
  const weighedKg = num(sub.weighedKg);
  const sheetG = num(sub.minimumNeed);
  const sheetI = num(sub.backfillMeals);
  const sheetAvail = num(sub.availableMealcount);
  const derivedAvail = sub.gramPerMeal > 0 ? ((num(sub.platingHoldingKg) + weighedKg) / sub.gramPerMeal) * 1000 : 0;
  const availableMealcount = Math.max(0, Math.round(sheetAvail !== 0 ? sheetAvail : derivedAvail));
  const basis = (sheetG !== 0 || sheetI !== 0 || sheetAvail !== 0 || weighedKg !== 0) ? "sheet" : "gap-only";

  const g = sheetG !== 0 ? sheetG : availableMealcount - gap;
  const minimumNeed = Math.max(0, -Math.round(g));
  if (minimumNeed < MIN_SUB_SHORTFALL) return null;

  const validPct = plannedTarget > 0 ? Math.min(1, minimumNeed / plannedTarget) : 0;
  const sheetPct = Math.abs(sub.shortagePct) / 100;
  const p = sheetPct > 0 && sheetPct <= 1 ? sheetPct : validPct;
  const computedBuffer = Math.round(minimumNeed * (1 + p));
  const sheetIabs = Math.max(0, -Math.round(sheetI));
  const bufferedNeed = sheetIabs > 0 && sheetIabs <= minimumNeed * 2 + 5 ? sheetIabs : computedBuffer;

  return {
    workOrder: sub.workOrder, subRecipeName: sub.subRecipeName,
    minimumNeed, bufferedNeed: Math.max(minimumNeed, bufferedNeed),
    basis, status: sub.status, vetoed: sub.status === "not-needed",
  };
}

function computeRtiBackfills(meals) {
  const bestByKey = new Map();
  for (const meal of meals) {
    const key = String(meal.mealCode).replace(/\D/g, "");
    const cur = bestByKey.get(key);
    if (!cur || meal.plannedTarget > cur.plannedTarget) bestByKey.set(key, meal);
  }
  const out = [];
  for (const meal of bestByKey.values()) {
    if (meal.plannedTarget <= 0 || meal.actuals <= 0) continue;
    const gap = Math.round(meal.plannedTarget - meal.actuals);
    if (gap < MIN_SUB_SHORTFALL) continue;

    const realSubs = meal.subRecipes.filter(s => !s.isBackfillCandidate);
    const weighingStarted = realSubs.some(s => num(s.weighedKg) !== 0 || s.status !== "open");
    const openSubs = [], enteredSubs = [], notNeededSubs = [];
    for (const sub of meal.subRecipes) {
      if (sub.isBackfillCandidate) continue;
      const c = classify(sub, gap, meal.plannedTarget);
      if (!c) continue;
      if (c.vetoed) notNeededSubs.push(c);
      else if (c.status === "done") enteredSubs.push(c);
      else openSubs.push(c);
    }
    if (!openSubs.length && !enteredSubs.length && !notNeededSubs.length) continue;
    out.push({
      mealCode: meal.mealCode, mealName: meal.mealName, gap,
      plannedTarget: meal.plannedTarget, actuals: meal.actuals,
      openSubs, enteredSubs, notNeededSubs, weighingStarted,
      recommendedMin: openSubs.reduce((m, s) => Math.max(m, s.minimumNeed), 0),
      hasGapOnly: openSubs.some(s => s.basis === "gap-only"),
    });
  }
  return out;
}

// ── Slack ──────────────────────────────────────────────────────────────────
// Funktioniert für beide URL-Formen:
//  • Incoming Webhook   https://hooks.slack.com/services/…  → {"text": …} ist die Nachricht
//  • Workflow-Builder   https://hooks.slack.com/triggers/…  → Workflow braucht eine
//                       Text-Variable namens "text", die in die Kanal-Nachricht gemappt ist
const _slackDebug = []; // letzte Post-Ergebnisse, landen im state-Doc

async function postSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) { logger.warn("SLACK_WEBHOOK_URL fehlt — kein Slack-Post"); _slackDebug.push({ err: "no-url" }); return; }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await res.text().catch(() => "");
    _slackDebug.push({ status: res.status, body: body.slice(0, 120) });
    if (res.status === 429) { logger.warn("Slack rate-limited", { retryAfter: res.headers.get("retry-after") }); return; }
    if (!res.ok) logger.error("Slack-Post fehlgeschlagen", { status: res.status, body });
  } catch (e) {
    _slackDebug.push({ err: String(e).slice(0, 120) });
    logger.error("Slack-Post Exception", { error: String(e) });
  }
}

const nf = n => Math.round(n).toLocaleString("de-DE");
function subLine(s) {
  return `• *${s.subRecipeName}* — mindestens ${nf(s.minimumNeed)}, mit Puffer ${nf(s.bufferedNeed)}${s.basis === "gap-only" ? " _(im Sheet noch nicht erfasst)_" : ""}`;
}

// ── Watcher ────────────────────────────────────────────────────────────────
exports.rtiBackfillWatch = onSchedule(
  { schedule: "every 10 minutes", region: REGION, timeoutSeconds: 60 },
  async () => {
    let rows;
    try {
      const sheets = await sheetsClient(true);
      const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: RTI_SHEET_ID,
        range: `'${RTI_SHEET_TAB}'!A1:Z2000`,
        valueRenderOption: "FORMATTED_VALUE",
      });
      rows = resp.data.values || [];
    } catch (err) {
      logger.error("RTI-Sheet lesen fehlgeschlagen", { error: err?.message || String(err) });
      return;
    }

    const meals = computeRtiBackfills(parseRti(rows));
    const now = Date.now();

    const prevSnap = await stateDoc().get();
    const seeding = !prevSnap.exists; // erster Lauf → Ist-Zustand merken, nichts posten
    const prev = prevSnap.exists ? (prevSnap.data() || {}) : {};
    const prevSubs = prev.subs || {};       // key -> { min, since }
    const prevStaleWarn = prev.staleWarned || {}; // mealCode -> ts
    // "wo|sub" -> ts: vom Wächter (rtiMarkDone) gesetzt, wenn "done" aus der App kam
    const appMarks = prev.appMarks || {};

    const nextSubs = {};
    const nextStaleWarn = {};
    const newOpen = [];
    const nowEntered = [];
    const staleAlerts = [];
    const grownSubs = [];

    for (const meal of meals) {
      for (const s of meal.openSubs) {
        const key = `${s.workOrder}|${s.subRecipeName}`;
        const wasOpen = prevSubs[key];
        nextSubs[key] = { min: s.minimumNeed, since: wasOpen?.since || now, meal: meal.mealCode };
        if (!wasOpen) {
          newOpen.push({ meal, s });
        } else if (s.minimumNeed >= (wasOpen.min || 0) + 100 && s.minimumNeed >= (wasOpen.min || 0) * 1.5) {
          // schon offen, aber die Menge ist deutlich gestiegen (z.B. Rack kam
          // jetzt ganz leer zurück) → erneut melden.
          grownSubs.push({ meal, s, prevMin: wasOpen.min || 0 });
        }
      }
      for (const s of meal.enteredSubs) {
        const key = `${s.workOrder}|${s.subRecipeName}`;
        if (prevSubs[key]) {
          // war offen, jetzt "done" — kam es über den Wächter (< 25 min)?
          const viaApp = appMarks[key] && now - appMarks[key] < 25 * 60 * 1000;
          nowEntered.push({ meal, s, viaApp });
        }
      }
      // Wiegung läuft, aber Subs ohne Status offen und schon > STALE_MIN alt
      if (meal.weighingStarted && meal.openSubs.length > 0) {
        const oldest = Math.min(...meal.openSubs.map(s => nextSubs[`${s.workOrder}|${s.subRecipeName}`]?.since ?? now));
        const ageMin = (now - oldest) / 60000;
        if (ageMin >= STALE_MIN) {
          nextStaleWarn[meal.mealCode] = prevStaleWarn[meal.mealCode] || now;
          // nur alle ~2h erneut warnen
          if (now - (prevStaleWarn[meal.mealCode] || 0) > 2 * 3600 * 1000) {
            nextStaleWarn[meal.mealCode] = now;
            staleAlerts.push({ meal, ageMin });
          }
        }
      }
    }

    // Slack-Posts — auf dem allerersten Lauf NICHT (sonst Nachricht für jeden
    // aktuell offenen Backfill). Ab dann nur echte Änderungen.
    if (!seeding) {
    for (const { meal, s } of newOpen) {
      await postSlack(`🔴 *Backfill nötig — ${meal.mealCode} ${meal.mealName}*\n${meal.gap} Portionen fehlen (${nf(meal.actuals)}/${nf(meal.plannedTarget)} platiert)\n${subLine(s)}`);
    }
    for (const { meal, s, prevMin } of grownSubs) {
      await postSlack(`📈 *Backfill-Menge gestiegen — ${meal.mealCode} ${meal.mealName}*\n${subLine(s)}   _(vorher ${nf(prevMin)})_`);
    }
    for (const { meal, s, viaApp } of nowEntered) {
      const wer = viaApp ? "von *Planer Automatik* (Backfill-Wächter) erledigt" : "im RTI-Sheet als „done“ markiert";
      await postSlack(`✅ ${meal.mealCode} · ${s.subRecipeName} — ${wer}.`);
    }
    for (const { meal, ageMin } of staleAlerts) {
      const open = meal.openSubs.map(x => x.subRecipeName).join(", ");
      await postSlack(`⏰ *${meal.mealCode} ${meal.mealName}* ist ${meal.gap} Portionen kurz — Wiegung läuft seit ${Math.round(ageMin)} min, aber noch offen: ${open}. Bitte im RTI-Sheet nachtragen oder Backfill ansetzen.`);
    }
    } // ende !seeding

    // Geteiltes Flacker-Signal: jede offene App liest das und flackert dann
    // gleichzeitig — unabhängig davon, wann sie geöffnet wurde oder ob der
    // Nutzer WMS/Snowflake-Zugang hat (der Backfill kommt rein aus dem Sheet).
    const prevFlash = prev.flash || {};
    const flashSubs = [...newOpen, ...grownSubs];
    const flash = (!seeding && flashSubs.length > 0)
      ? { at: now, keys: flashSubs.map(({ s }) => `${s.workOrder}|${s.subRecipeName}`), meals: [...new Set(flashSubs.map(x => x.meal.mealCode))] }
      : prevFlash;

    // appMarks weitertragen, aber Einträge > 30 min vergessen
    const nextAppMarks = {};
    for (const [k, ts] of Object.entries(appMarks)) if (now - ts < 30 * 60 * 1000) nextAppMarks[k] = ts;

    await stateDoc().set({
      subs: nextSubs,
      staleWarned: nextStaleWarn,
      flash,
      appMarks: nextAppMarks,
      updatedAt: new Date().toISOString(),
      openCount: Object.keys(nextSubs).length,
    });

    logger.info("rtiBackfillWatch", {
      seeding, meals: meals.length,
      newOpen: newOpen.length, grown: grownSubs.length, entered: nowEntered.length, stale: staleAlerts.length,
      slackConfigured: !!process.env.SLACK_WEBHOOK_URL, slackPosts: _slackDebug,
    });
  },
);

// ── Wächter schreibt „done“ in Spalte J ────────────────────────────────────
exports.rtiMarkDone = onRequest({ region: REGION, timeoutSeconds: 30 }, async (req, res) => {
  res.set("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const { wo, subRecipe, value } = req.body || {};
  if (!wo) { res.status(400).json({ error: "wo fehlt" }); return; }
  const cell = String(value || "done");

  try {
    const sheets = await sheetsClient(false);
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: RTI_SHEET_ID,
      range: `'${RTI_SHEET_TAB}'!A1:B2000`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    const rows = resp.data.values || [];
    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      const a = String((rows[i] || [])[0] ?? "").trim();
      const b = String((rows[i] || [])[1] ?? "").trim();
      if (a === String(wo).trim() && (!subRecipe || b === String(subRecipe).trim())) { rowIndex = i; break; }
    }
    if (rowIndex < 0) { res.status(404).json({ error: `WO ${wo} nicht gefunden` }); return; }

    const a1 = `'${RTI_SHEET_TAB}'!J${rowIndex + 1}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: RTI_SHEET_ID,
      range: a1,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[cell]] },
    });
    // dem Watcher mitteilen: dieses "done" kam aus der App → Slack sagt "Planer Automatik"
    const b = String((rows[rowIndex] || [])[1] ?? "").trim();
    await stateDoc().set(
      { appMarks: { [`${String(wo).trim()}|${b}`]: Date.now() } },
      { merge: true },
    ).catch(() => {});
    res.json({ ok: true, cell: a1 });
  } catch (err) {
    const msg = err?.message || String(err);
    logger.error("rtiMarkDone fehlgeschlagen", { error: msg });
    res.status(502).json({ error: msg });
  }
});

// für lokale Tests (nicht als Function deployen — siehe index.js-Einbindung)
module.exports._internal = { parseRti, computeRtiBackfills };
