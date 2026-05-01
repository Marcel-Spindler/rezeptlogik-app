const { createHash } = require("node:crypto");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

admin.initializeApp();

const db = admin.firestore();
const APP_ROOT = db.collection("apps").doc("rezeptlogik");
const DEFAULT_GSHEET_ID = "1IEi_CB9KylW2MgjNiGax5EIvhhAtkIzm57uO1sSESj8";
const SHEET_RANGE = "Meal Selection!A3:X1000";
const CHECK_COOLDOWN_MS = 60 * 1000;

function getSheetIds() {
  return [
    process.env.GSHEET_ID || DEFAULT_GSHEET_ID,
    ...(process.env.GSHEET_IDS || "").split(",")
  ].map(value => value.trim()).filter(Boolean);
}

function num(value) {
  if (value == null || value === "") return 0;
  const parsed = typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function stableWeekRecipeId(row) {
  return `${row.hfWeek}__${row.code}`;
}

function buildWeekRecipeHash(rows) {
  const normalized = rows
    .slice()
    .sort((a, b) => `${a.hfWeek}__${a.code}`.localeCompare(`${b.hfWeek}__${b.code}`));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function createSheetsClient() {
  const rawBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  const credentials = rawBase64
    ? JSON.parse(Buffer.from(rawBase64, "base64").toString("utf8"))
    : undefined;

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function readMealSelectionRows() {
  const sheets = await createSheetsClient();
  const weekRecipes = [];
  const weeks = new Set();
  const seen = new Set();

  for (const spreadsheetId of getSheetIds()) {
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: SHEET_RANGE });
    const rows = response.data.values || [];
    for (const row of rows) {
      const hfWeek = (row[0] || "").toString().trim();
      const code = (row[1] || "").toString().trim();
      if (!hfWeek || !code || !/^\d{4}-W\d{2}$/.test(hfWeek)) continue;
      const dedupeKey = `${hfWeek}__${code}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const verdenAbsBENL = num(row[18]);
      const verdenAbsNORD = num(row[19]);
      const verdenAbsDE = num(row[20]);
      weekRecipes.push({
        hfWeek,
        weekShort: hfWeek.slice(5),
        code,
        recipeName: (row[3] || "").toString(),
        preference: (row[2] || "").toString(),
        slot: {
          BENL: num(row[5]) || undefined,
          DKSE: num(row[6]) || undefined,
          DE: num(row[7]) || undefined
        },
        verdenVolume: {
          BENL: verdenAbsBENL,
          DKSE: verdenAbsNORD,
          DE: verdenAbsDE
        },
        totalVerdenVolume: num(row[21]) || (verdenAbsBENL + verdenAbsNORD + verdenAbsDE),
        productionBuffer: num(row[23])
      });
      weeks.add(hfWeek);
    }
  }

  return {
    weekRecipes,
    weeks: [...weeks].sort()
  };
}

async function clearCollection(collRef) {
  while (true) {
    const snap = await collRef.limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }
}

async function batchedSet(collRef, docs) {
  const chunkSize = 400;
  for (let i = 0; i < docs.length; i += chunkSize) {
    const batch = db.batch();
    for (const { id, data } of docs.slice(i, i + chunkSize)) {
      batch.set(collRef.doc(id), data, { merge: true });
    }
    await batch.commit();
  }
}

exports.refreshRampUp = onRequest({ region: "europe-west3", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }

  try {
    const metaSnap = await APP_ROOT.get();
    const meta = metaSnap.data() || {};
    const now = Date.now();
    const lastCheckedMs = meta.rampUpLastCheckedAt ? Date.parse(meta.rampUpLastCheckedAt) : 0;
    if (lastCheckedMs && Number.isFinite(lastCheckedMs) && now - lastCheckedMs < CHECK_COOLDOWN_MS) {
      res.json({ ok: true, refreshed: false, reason: "cooldown", checkedAt: meta.rampUpLastCheckedAt });
      return;
    }

    const { weekRecipes, weeks } = await readMealSelectionRows();
    const nextHash = buildWeekRecipeHash(weekRecipes);
    const checkedAt = new Date(now).toISOString();

    if (meta.rampUpHash === nextHash) {
      await APP_ROOT.set({ rampUpLastCheckedAt: checkedAt }, { merge: true });
      res.json({ ok: true, refreshed: false, count: weekRecipes.length, checkedAt });
      return;
    }

    const weekRecipesColl = APP_ROOT.collection("weekRecipes");
    await clearCollection(weekRecipesColl);
    await batchedSet(
      weekRecipesColl,
      weekRecipes.map(row => ({ id: stableWeekRecipeId(row), data: row }))
    );

    await APP_ROOT.set({
      generatedAt: checkedAt,
      weeks,
      rampUpHash: nextHash,
      rampUpLastCheckedAt: checkedAt
    }, { merge: true });

    res.json({ ok: true, refreshed: true, count: weekRecipes.length, checkedAt });
  } catch (error) {
    logger.error("refreshRampUp failed", error);
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});