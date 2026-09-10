// RTI Backfill-Wächter – server-seitig.
//
//  1) rtiBackfillWatch (onSchedule, alle 10 min)
//       Liest den RTI Plating Tracker, rechnet pro Sub-Rezept den Backfill-Bedarf
//       (Portierung von src/features/backfills/rtiBackfillCalculator.ts), vergleicht
//       mit dem letzten Stand in Firestore und postet Änderungen nach Slack:
//         • neuer offener Engpass          → 🔴
//         • Engpass ins System eingetragen → ✅
//         • Wiegung läuft > STALE_MIN, aber Subs noch ohne Status → ⏰
//         • Planned Target/Actuals fehlten → Ziel aus Forecast (weekRecipes),
//           Ist aus Kaskade Redzone → Firestore-Relay (Browser-Redzone) →
//           LinePlaiting Σ Actual; beide in den Sheet-Kopf (Spalte D/E) → 🤖
//       Nur im Wiege-Fenster (RTI_PLATING_START/END_HOUR, Europe/Berlin) wird
//       ausgefüllt und proaktiv gemeldet — nach Feierabend kein Gemecker.
//       Nötig:  SLACK_WEBHOOK_URL in functions/.env
//               (RTI_SHEET_ID / RTI_SHEET_TAB / RTI_AUTOFILL_HEADER /
//                RTI_PLATING_*_HOUR / REDZONE_STATUS_URL / LINEPLAITING_SHEET_ID
//                optional, Defaults unten)
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

// Planned Target / Actuals selbst in den RTI-Sheet-Kopf schreiben, wenn sie
// fehlen (Forecast + Redzone). "0" = aus → nur intern rechnen + alter Hinweis.
const RTI_AUTOFILL_HEADER = process.env.RTI_AUTOFILL_HEADER !== "0";
// Redzone-Plating-Output (Ist-Zahl). Hosting-Rewrite, Server-zu-Server ohne
// Origin-Header ist erlaubt (siehe guardRequest in index.js).
const REDZONE_STATUS_URL = process.env.REDZONE_STATUS_URL
  || "https://rezeptlogik-verden-factor.web.app/api/redzone-plating-status";
// Ein externer Kopf-Wert wird nur übernommen, wenn er in sich plausibel ist.
const EXT_ACTUALS_MAX_RATIO = 1.15;

// Wiege-/Plating-Fenster (Europe/Berlin). AUSSERHALB: keine proaktiven Nag-Posts
// (Kopf fehlt / Wiegung hängt) und kein Auto-Ausfüllen — nach Feierabend wird
// nicht mehr gewogen, da braucht niemand alle 2 h eine Erinnerung. Ab der
// Spätschicht (nächste KW) einfach RTI_PLATING_END_HOUR=23 setzen, kein Deploy
// der Logik nötig. Änderungs-Meldungen (neuer Backfill, „done", Menge gestiegen)
// laufen weiter rund um die Uhr.
const PLATING_START_HOUR = Number(process.env.RTI_PLATING_START_HOUR || 6);
const PLATING_END_HOUR = Number(process.env.RTI_PLATING_END_HOUR || 15);

function berlinHour(now) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", hour: "2-digit", hour12: false,
  }).formatToParts(now || new Date());
  return parseInt(parts.find(p => p.type === "hour")?.value || "0", 10) % 24;
}
function withinPlatingHours(now) {
  const h = berlinHour(now);
  return h >= PLATING_START_HOUR && h < PLATING_END_HOUR;
}

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
function codeDigits(code) {
  const m = /(\d{4,5})/.exec(String(code || ""));
  return m ? m[1] : String(code || "");
}
function detectWeek(rows) {
  for (const row of rows) {
    const m = /^KW\s*(\d+)/i.exec(String((row || [])[0] ?? "").trim());
    if (m) return `W${m[1].padStart(2, "0")}`;
  }
  return "";
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
      const headerRow = i; // 0-basiert; Spalte D/E dieser Zeile = Planned/Actuals
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
      meals.push({ mealCode, mealName, plannedTarget, actuals, subRecipes, headerRow });
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

// externalTargets: Map<4-Ziffer-Code, { plannedTarget, actuals, source }> —
// Ersatz-Kopfzahlen aus App-Daten (Forecast + Redzone), 1:1 mit
// src/features/backfills/rtiBackfillCalculator.ts.
function usableExternalTarget(ext) {
  return !!ext && ext.plannedTarget > 0 && ext.actuals >= 0
    && ext.actuals <= ext.plannedTarget * EXT_ACTUALS_MAX_RATIO;
}

function computeRtiBackfills(meals, externalTargets) {
  const bestByKey = new Map();
  for (const meal of meals) {
    const key = String(meal.mealCode).replace(/\D/g, "");
    const cur = bestByKey.get(key);
    if (!cur || meal.plannedTarget > cur.plannedTarget) bestByKey.set(key, meal);
  }
  const out = [];
  for (const meal of bestByKey.values()) {
    const realSubs = meal.subRecipes.filter(s => !s.isBackfillCandidate);
    if (realSubs.length === 0) continue;
    const weighingStarted = realSubs.some(s => num(s.weighedKg) !== 0 || s.status !== "open");
    const someWeighed = realSubs.some(s => num(s.weighedKg) > 0);

    // Kopfzahlen: Sheet gewinnt; fehlt eine → aus App-Daten ergänzen, aber nur
    // wenn dieses Meal schon zurückgewogen wird (sonst gälte früh in der Woche
    // jedes Meal mit Forecast > Redzone-Output als „Backfill nötig").
    let plannedTarget = num(meal.plannedTarget);
    let actuals = num(meal.actuals);
    let targetEstimated = false;
    let targetSourceLabel = "";
    if ((plannedTarget <= 0 || actuals <= 0) && someWeighed) {
      const ext = externalTargets && externalTargets.get(codeDigits(meal.mealCode));
      if (usableExternalTarget(ext)) {
        if (plannedTarget <= 0) plannedTarget = ext.plannedTarget;
        if (actuals <= 0) actuals = ext.actuals;
        targetEstimated = true;
        targetSourceLabel = ext.source;
      }
    }

    if (plannedTarget <= 0 || actuals <= 0) {
      const allNo = realSubs.every(s => s.status === "not-needed");
      if (someWeighed && !allNo) {
        out.push({ mealCode: meal.mealCode, mealName: meal.mealName, gap: 0,
          plannedTarget, actuals, headerRow: meal.headerRow,
          openSubs: [], enteredSubs: [], notNeededSubs: [], weighingStarted,
          recommendedMin: 0, hasGapOnly: false, headerIncomplete: true,
          targetEstimated: false, targetSourceLabel: "" });
      }
      continue;
    }
    const gap = Math.round(plannedTarget - actuals);
    if (gap < MIN_SUB_SHORTFALL) continue;

    const openSubs = [], enteredSubs = [], notNeededSubs = [];
    for (const sub of meal.subRecipes) {
      if (sub.isBackfillCandidate) continue;
      const c = classify(sub, gap, plannedTarget);
      if (!c) continue;
      if (c.vetoed) notNeededSubs.push(c);
      else if (c.status === "done") enteredSubs.push(c);
      else openSubs.push(c);
    }
    if (!openSubs.length && !enteredSubs.length && !notNeededSubs.length) continue;
    out.push({
      mealCode: meal.mealCode, mealName: meal.mealName, gap,
      plannedTarget, actuals, headerRow: meal.headerRow,
      openSubs, enteredSubs, notNeededSubs, weighingStarted,
      recommendedMin: openSubs.reduce((m, s) => Math.max(m, s.minimumNeed), 0),
      hasGapOnly: openSubs.some(s => s.basis === "gap-only"),
      headerIncomplete: false,
      targetEstimated, targetSourceLabel,
    });
  }
  return out;
}

// ── Ersatz-Kopfzahlen (Planned Target / Actuals aus App-Daten) ──────────────
// Ziel  = Forecast der KW (apps/rezeptlogik/weekRecipes, totalVerdenVolume) —
//         dieselbe Quelle wie das „Wochen-Kontingent" in der Redzone-Live-View.
// Ist   = Redzone-Plating-Output der KW (Maschinenzählung), Fallback: nichts.

async function readWeekRecipeTargets(weekShort) {
  const coll = admin.firestore()
    .collection("apps").doc("rezeptlogik").collection("weekRecipes");
  // weekShort ist ein einfaches Feld → automatischer Single-Field-Index.
  const snap = weekShort
    ? await coll.where("weekShort", "==", weekShort).get()
    : await coll.get();
  const byCode = new Map(); // 4-Ziffer → { target }
  snap.forEach(doc => {
    const wr = doc.data() || {};
    const total = Number(wr.totalVerdenVolume) || 0;
    if (total <= 0 || !wr.code) return;
    const k = codeDigits(wr.code);
    // größten Wert je 4-Ziffer behalten (Code-Varianten)
    if ((byCode.get(k)?.target ?? 0) < total) byCode.set(k, { target: total });
  });
  return byCode;
}

// Stunden von Montag 00:00 (Europe/Berlin) bis jetzt, geklemmt auf [24, 168].
function lookbackHoursSinceMonday(now) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now || new Date());
  const get = t => parts.find(p => p.type === t)?.value || "";
  const dowIdx = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[get("weekday")] ?? 0;
  const h = parseInt(get("hour"), 10) || 0;
  const min = parseInt(get("minute"), 10) || 0;
  const hrs = dowIdx * 24 + h + min / 60;
  return Math.min(168, Math.max(24, Math.ceil(hrs)));
}

const RZ_MEAL_RE = /\b(F[A-Z]\d{4}[A-Z])\b/;

async function fetchRedzoneActuals(lookbackHours) {
  const url = `${REDZONE_STATUS_URL}?hours=${lookbackHours}`;
  let body;
  try {
    const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
    if (!res.headers.get("content-type")?.includes("application/json")) return null;
    body = await res.json();
  } catch (e) {
    logger.warn("Redzone-Fetch fehlgeschlagen", { error: String(e).slice(0, 160) });
    return null;
  }
  if (!body || body.ok === false || !Array.isArray(body.rows)) return null;
  const byCode = new Map(); // 4-Ziffer → Σ outCount (nur Plating)
  for (const r of body.rows) {
    if (String(r.areaName || "") !== "Plating") continue;
    const m = RZ_MEAL_RE.exec(String(r.productTypeName || ""));
    if (!m) continue;
    const add = Number(r.outCount) || 0;
    if (add <= 0) continue;
    const k = codeDigits(m[1]);
    byCode.set(k, (byCode.get(k) || 0) + add);
  }
  return byCode;
}

// Firestore-Relay: eine offene App mit funktionierender Redzone (lokaler
// WMS-Server) schreibt ihre errechneten Kopfzahlen hierher (siehe
// src/features/backfills/rtiTargetsRelay.ts). Nur nutzen, wenn frisch (< 45 min).
async function readRelayActuals(now) {
  try {
    const snap = await admin.firestore()
      .collection("apps").doc("rezeptlogik").collection("backfillWatch").doc("rtiTargets").get();
    if (!snap.exists) return null;
    const d = snap.data() || {};
    const age = (now ? now.getTime() : Date.now()) - (Number(d.updatedAt) || 0);
    if (!(age >= 0) || age > 45 * 60 * 1000) return null;
    const byCode = new Map();
    for (const [k, v] of Object.entries(d.targets || {})) {
      const a = Math.round(Number(v && v.actuals) || 0);
      if (a > 0) byCode.set(codeDigits(k), a);
    }
    return byCode.size > 0 ? byCode : null;
  } catch (e) {
    logger.warn("Relay-Read fehlgeschlagen", { error: String(e).slice(0, 160) });
    return null;
  }
}

// Portionen ganzzahlig; "," / "." vor genau 3 Ziffern = Tausender-Trenner
// (1:1 mit parseWholeNumber aus src/.../parsers/parseLinePlaiting.ts).
function parseWholeNumber(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return 0;
  const n = parseInt(t.replace(/[.,](\d{3})(?!\d)/g, "$1").replace(/[^\d.\-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// LinePlaiting-Tab (anonymes gviz-CSV, KEIN Snowflake): Σ Planned / Σ Actual je
// Meal über die ganze KW. Das Sheet labelt Planned/Actual/Delta NICHT sauber
// (gviz-Export), aber die Struktur je Meal-Zeile ist stabil: nach „Code" +
// Meal-Name folgen ein paar Zahlen, darunter eine kleine „Run"-Zahl (< 50) und
// das Tripel Planned / Actual / Delta mit Delta = Actual − Planned. Darüber
// wird das Tripel eindeutig erkannt — kein voller Parser-Port nötig.
const LINEPLAITING_SHEET_ID = process.env.LINEPLAITING_SHEET_ID
  || "13lZfV1HAcVuOAxd9-xHCEsxO0wHmPnJNl9NuoURpM6U";

const NUMERIC_CELL = /^-?[\d.,\s]+$/;
const RUN_COUNT_CELL = /^\d{1,2}\.\d$/; // „3.0" = Run-Zähler, keine Portionszahl

// Aus einer Meal-Zeile das (Planned, Actual)-Paar ziehen. Fenster codeCol+2 …
// codeCol+12 — die rechts anschließenden „Rolling Progress"-Wochensummen (ab
// ~Spalte 22) NICHT mitnehmen. Run-Zähler ("3.0") rausfiltern, dann das Tripel
// Planned/Actual/Delta mit Delta = Actual − Planned suchen.
function plannedActualFromRow(cells, startIdx) {
  const nums = [];
  for (let i = startIdx; i < Math.min(cells.length, startIdx + 11); i++) {
    const raw = String(cells[i] ?? "").trim();
    if (raw && NUMERIC_CELL.test(raw) && !RUN_COUNT_CELL.test(raw)) nums.push(parseWholeNumber(raw));
  }
  for (let i = 0; i + 2 < nums.length; i++) {
    const [p, a, d] = [nums[i], nums[i + 1], nums[i + 2]];
    if (p > 100 && a >= 0 && Math.abs(d - (a - p)) <= 2) return { planned: p, actual: a };
  }
  return null;
}

async function fetchLinePlaitingTotals(weekShort) {
  const wk = /^W(\d{1,2})$/.exec(weekShort || "");
  if (!wk) return null;
  const tab = `LinePlating W${Number(wk[1])}`;
  const url = `https://docs.google.com/spreadsheets/d/${LINEPLAITING_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok || !(res.headers.get("content-type") || "").includes("csv")) return null;
    text = await res.text();
  } catch (e) {
    logger.warn("LinePlaiting-Fetch fehlgeschlagen", { error: String(e).slice(0, 160) });
    return null;
  }
  const rows = parseCsv(text);
  let codeCol = -1;
  const actual = new Map(); // nur Ist — Σ Planned aus LinePlaiting ist unzuverlässig
                            // (mischt Erst-Plan + Backfill-Runs), Ziel kommt vom Forecast.
  for (const row of rows) {
    const lower = row.map(c => String(c ?? "").trim().toLowerCase());
    const ci = lower.indexOf("code");
    if (ci >= 0) { codeCol = ci; continue; } // „Comms"-Kopfzeile
    if (codeCol < 0) continue;
    const code = String(row[codeCol] ?? "").trim();
    if (!/^F[A-Z]\d{4}[A-Z]?$/i.test(code)) continue;
    const pa = plannedActualFromRow(row, codeCol + 2); // +1 Meal-Name überspringen
    if (!pa || pa.actual <= 0) continue;
    const k = codeDigits(code);
    actual.set(k, (actual.get(k) || 0) + pa.actual);
  }
  return actual.size ? { actual } : null;
}

// Baut die externalTargets-Map (4-Ziffer → { plannedTarget, actuals, source }).
// Ziel: Forecast (weekRecipes) — die einzige verlässliche Plan-Quelle.
// Ist  (Kaskade): Online-Redzone → Firestore-Relay (Browser-Redzone) → LinePlaiting Σ Actual.
// Nur Einträge mit Ziel UND Ist — ohne beides ist kein gap rechenbar.
async function deriveHeaderTargets(weekShort, now) {
  const [targets, redzone, relay, lp] = await Promise.all([
    readWeekRecipeTargets(weekShort).catch(() => new Map()),
    fetchRedzoneActuals(lookbackHoursSinceMonday(now)).catch(() => null),
    readRelayActuals(now).catch(() => null),
    fetchLinePlaitingTotals(weekShort).catch(() => null),
  ]);

  const out = new Map();
  for (const [k, t] of targets) {
    if (!(t.target > 0)) continue;
    const target = Math.round(t.target);

    let actuals = 0, actSrc = "";
    const rz = redzone ? Math.round(redzone.get(k) || 0) : 0;
    const rl = relay ? Math.round(relay.get(k) || 0) : 0;
    const la = lp && lp.actual ? Math.round(lp.actual.get(k) || 0) : 0;
    if (rz > 0) { actuals = rz; actSrc = "Redzone"; }
    else if (rl > 0) { actuals = rl; actSrc = "Redzone (Browser)"; }
    else if (la > 0 && la <= target) { actuals = la; actSrc = "LinePlaiting"; }
    else continue;

    out.set(k, {
      plannedTarget: target,
      actuals: Math.min(actuals, target),
      source: `Forecast + ${actSrc}`,
    });
  }
  return { targets: out, redzoneOk: redzone != null, relayOk: relay != null, lpOk: lp != null };
}

// Guarded Writer: trägt Planned Target (D) / Actuals (E) in die FV-Kopfzeile ein.
// Schreibt nur, wenn BEIDE Zellen leer sind (nie einen vorhandenen Wert — egal ob
// von Hand oder von uns — überschreiben) und die Zahlen plausibel sind.
async function fillRtiHeader(sheetsRw, rows, meal, planned, actuals) {
  const hr = meal.headerRow;
  if (hr == null || hr < 0 || hr >= rows.length) return { ok: false, reason: "no-row" };
  const row = rows[hr] || [];
  // Kopfzeile gegenprüfen: Spalte B muss den FV-Code tragen.
  if (codeDigits(String(row[1] ?? "")) !== codeDigits(meal.mealCode)) return { ok: false, reason: "row-mismatch" };
  const curD = num(row[3]);
  const curE = num(row[4]);
  if (curD > 0 || curE > 0) return { ok: false, reason: "not-empty" };
  if (!(planned > 0) || actuals < 0 || actuals > planned * 1.05) return { ok: false, reason: "implausible" };
  if (planned < 100 || planned > 60000) return { ok: false, reason: "out-of-range" };

  const a1 = `'${RTI_SHEET_TAB}'!D${hr + 1}:E${hr + 1}`;
  await sheetsRw.spreadsheets.values.update({
    spreadsheetId: RTI_SHEET_ID,
    range: a1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[Math.round(planned), Math.round(actuals)]] },
  });
  return { ok: true, cell: a1, planned: Math.round(planned), actuals: Math.round(actuals) };
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

    const now = Date.now();
    const nowDate = new Date(now);
    const plating = withinPlatingHours(nowDate);

    // Ersatz-Kopfzahlen aus App-Daten — nur im Wiege-Fenster herleiten (nach
    // Feierabend wird nicht mehr gewogen). Ist-Kaskade: Redzone → Browser-Relay
    // → LinePlaiting.
    let externalTargets = new Map();
    let sourcesOk = { redzoneOk: false, relayOk: false, lpOk: false };
    if (plating && RTI_AUTOFILL_HEADER) {
      try {
        const derived = await deriveHeaderTargets(detectWeek(rows), nowDate);
        externalTargets = derived.targets;
        sourcesOk = derived;
      } catch (e) {
        logger.warn("deriveHeaderTargets fehlgeschlagen", { error: String(e).slice(0, 160) });
      }
    }

    const meals = computeRtiBackfills(parseRti(rows), externalTargets);

    const prevSnap = await stateDoc().get();
    const seeding = !prevSnap.exists; // erster Lauf → Ist-Zustand merken, nichts posten
    const prev = prevSnap.exists ? (prevSnap.data() || {}) : {};
    const prevSubs = prev.subs || {};       // key -> { min, since }
    const prevStaleWarn = prev.staleWarned || {}; // mealCode -> ts
    const prevHeaderWarn = prev.headerWarn || {}; // mealCode -> ts
    const prevHeaderFilled = prev.headerFilled || {}; // mealCode -> ts (von uns eingetragen)
    // "wo|sub" -> ts: vom Wächter (rtiMarkDone) gesetzt, wenn "done" aus der App kam
    const appMarks = prev.appMarks || {};

    const nextSubs = {};
    const nextStaleWarn = {};
    const nextHeaderWarn = {};
    const nextHeaderFilled = { ...prevHeaderFilled };
    const newOpen = [];
    const nowEntered = [];
    const staleAlerts = [];
    const grownSubs = [];
    const headerAlerts = [];
    const headerFilledAlerts = [];

    // ── Planned Target / Actuals selbst in den Sheet-Kopf schreiben ──────────
    // Nur Meals, deren Kopf wir gerade aus App-Daten geschätzt haben (D & E leer,
    // Zahlen plausibel). fillRtiHeader überschreibt nie einen vorhandenen Wert.
    if (plating && RTI_AUTOFILL_HEADER) {
      const toFill = meals.filter(m => m.targetEstimated && m.headerRow != null);
      if (toFill.length > 0) {
        let sheetsRw;
        try { sheetsRw = await sheetsClient(false); } catch (e) {
          logger.warn("Sheets-RW-Client fehlgeschlagen", { error: String(e).slice(0, 160) });
        }
        for (const m of toFill) {
          if (!sheetsRw) break;
          try {
            const r = await fillRtiHeader(sheetsRw, rows, m, m.plannedTarget, m.actuals);
            if (r.ok) {
              if (!prevHeaderFilled[m.mealCode]) headerFilledAlerts.push({ meal: m, ...r });
              nextHeaderFilled[m.mealCode] = now;
            } else {
              logger.info("fillRtiHeader übersprungen", { meal: m.mealCode, reason: r.reason });
            }
          } catch (e) {
            logger.error("fillRtiHeader fehlgeschlagen", { meal: m.mealCode, error: e?.message || String(e) });
          }
        }
      }
    }

    for (const meal of meals) {
      if (meal.headerIncomplete) {
        if (!plating) continue; // nach Feierabend nicht meckern
        // Kopf fehlt UND nicht aus App-Daten herleitbar → 1× melden, dann alle ~3 h
        nextHeaderWarn[meal.mealCode] = prevHeaderWarn[meal.mealCode] || now;
        if (now - (prevHeaderWarn[meal.mealCode] || 0) > 3 * 3600 * 1000) {
          nextHeaderWarn[meal.mealCode] = now;
          headerAlerts.push({ meal });
        }
        continue;
      }
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
      if (plating && meal.weighingStarted && meal.openSubs.length > 0) {
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
    for (const { meal, planned, actuals } of headerFilledAlerts) {
      await postSlack(`🤖 *${meal.mealCode} ${meal.mealName}* — *Planned Target ${nf(planned)}* / *Actuals ${nf(actuals)}* automatisch in den RTI-Sheet-Kopf eingetragen (Forecast + Redzone-Zählung). Zahlen bitte kurz gegenprüfen.`);
    }
    for (const { meal, s } of newOpen) {
      const est = meal.targetEstimated ? `  _(Ziel/Ist geschätzt: ${meal.targetSourceLabel})_` : "";
      await postSlack(`🔴 *Backfill nötig — ${meal.mealCode} ${meal.mealName}*\n${meal.gap} Portionen fehlen (${nf(meal.actuals)}/${nf(meal.plannedTarget)} platiert)${est}\n${subLine(s)}`);
    }
    for (const { meal, s, prevMin } of grownSubs) {
      await postSlack(`📈 *Backfill-Menge gestiegen — ${meal.mealCode} ${meal.mealName}*\n${subLine(s)}   _(vorher ${nf(prevMin)})_`);
    }
    for (const { meal } of headerAlerts) {
      const dead = [
        !sourcesOk.redzoneOk && "Redzone",
        !sourcesOk.relayOk && "Browser-Relay",
        !sourcesOk.lpOk && "LinePlaiting",
      ].filter(Boolean).join(" / ");
      const why = dead
        ? `keine Ist-Quelle erreichbar (${dead})`
        : "kein Forecast-Wert und keine Ist-Zahl für dieses Meal gefunden";
      await postSlack(`⚠️ *${meal.mealCode} ${meal.mealName}* — es wird schon gewogen, aber *Planned Target / Actuals* fehlen im RTI-Sheet-Kopf und liessen sich nicht automatisch füllen (${why}). Bitte oben eintragen.`);
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

    // headerFilled: Einträge > 5 Tage vergessen (KW-Wechsel → nächste Woche darf
    // dieselbe 4-Ziffer erneut gemeldet werden).
    const prunedHeaderFilled = {};
    for (const [k, ts] of Object.entries(nextHeaderFilled)) if (now - ts < 5 * 24 * 3600 * 1000) prunedHeaderFilled[k] = ts;

    await stateDoc().set({
      subs: nextSubs,
      staleWarned: nextStaleWarn,
      headerWarn: nextHeaderWarn,
      headerFilled: prunedHeaderFilled,
      flash,
      appMarks: nextAppMarks,
      updatedAt: new Date().toISOString(),
      openCount: Object.keys(nextSubs).length,
    });

    logger.info("rtiBackfillWatch", {
      seeding, plating, meals: meals.length,
      redzoneOk: sourcesOk.redzoneOk, relayOk: sourcesOk.relayOk, lpOk: sourcesOk.lpOk,
      externalTargets: externalTargets.size, headerFilled: headerFilledAlerts.length,
      newOpen: newOpen.length, grown: grownSubs.length, entered: nowEntered.length, stale: staleAlerts.length, header: headerAlerts.length,
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
module.exports._internal = {
  parseRti, computeRtiBackfills, detectWeek, codeDigits,
  usableExternalTarget, lookbackHoursSinceMonday, withinPlatingHours, fillRtiHeader,
  parseCsv, parseWholeNumber, fetchLinePlaitingTotals, deriveHeaderTargets,
};
