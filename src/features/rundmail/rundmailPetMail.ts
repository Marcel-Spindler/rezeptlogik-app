// Rundmail – PET Plating-Präsentation (Print/PDF-Export, keine React-Abhängigkeit).
import type { AllergenDef, PetRow, PlatingNote } from "./rundmailTypes";
import type { Recipe } from "../../core/types";
import { daySortValue, parseBestByTimestamp, parseDateNeeded } from "./rundmailParsing";
import { detectAllergens, escapeHtml, fmtInt, petStatusTone, toSlack } from "./rundmailFormat";
import { PRINT_COLOR_FIX } from "./rundmailKetMail";

export const PET_PORTIONS_PER_LINE_PER_SHIFT = 1000;
export const PET_LINE_START_HOUR = 7;
const SHIFT_DURATION_MIN = 7 * 60;

export function formatClock(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes));
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
}

export function extractMealCode(recipeName: string): string {
  const match = recipeName.match(/([A-Z]{2}\d{4}[A-Z])/i);
  if (match) return match[1].toUpperCase();
  return recipeName.split(/\s+/)[0] ?? "";
}

export function oneDayBefore(isoDate: string): string {
  const ts = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(ts)) return isoDate;
  return new Date(ts - 86400000).toISOString().slice(0, 10);
}

function extractMarketTag(name: string): string {
  const m = (name ?? "").match(/\[(DE|BNL|DKSE|BENL|NORD)\]/i);
  return m ? m[1].toUpperCase() : "";
}

type SubRecipeData = { name: string; instruction?: string };

function getSubRecipeData(
  recipes: Record<string, Recipe> | undefined,
  mealCode: string,
  recipeName: string,
): SubRecipeData[] {
  if (!recipes) return [];
  const recipe = recipes[mealCode];
  if (!recipe) return [];
  const tag = extractMarketTag(recipeName);
  const order: Array<"DE" | "BENL" | "DKSE"> =
    tag === "BENL" || tag === "BNL" ? ["BENL", "DE", "DKSE"] :
    tag === "DKSE"                  ? ["DKSE", "DE", "BENL"] :
                                      ["DE", "BENL", "DKSE"];
  for (const m of order) {
    const md = recipe.markets[m];
    if (md?.subRecipes?.length) {
      return md.subRecipes.map((s) => ({ name: s.name, instruction: s.instructions ?? undefined }));
    }
  }
  return [];
}

function utilBarColor(pct: number): string {
  return pct >= 90 ? "#dc2626" : pct >= 70 ? "#d97706" : "#16a34a";
}

function inlineBar(pct: number, color: string, h = 8): string {
  return `<div style="background:#e2e8f0;border-radius:4px;height:${h}px;overflow:hidden;">
    <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;"></div></div>`;
}

// ─── Typen für die aufgeteilte Linien-Berechnung ──────────────────────────────

type EnrichedRow = PetRow & {
  status: string; bestByText: string; bestByTs: number | null;
  open: number; ratio: number; allergens: AllergenDef[];
};

type ComputedLine = {
  lineIdx: number;
  lineRows: EnrichedRow[];
  lineTarget: number;
  date: string;
  completedOn: string;
  shift: string;
};

// ─── Linie-Berechnung (gemeinsam für Full-Plan und per-Line-Export) ───────────

function computeLines(
  allPetRows: PetRow[],
  targetRun: 1 | 2,
): { lines: ComputedLine[]; runRows: EnrichedRow[] } {
  const runRows: EnrichedRow[] = allPetRows
    .filter((r) => parseDateNeeded(r.productionShift).run === targetRun)
    .map((r) => {
      const status = r.recipeManualPlatingStatus || r.recipePlatingStatus || "Not Started";
      const bestByText = r.actualBestByDate || r.expiringDatetime || "";
      const bestByTs = parseBestByTimestamp(bestByText);
      const open = toSlack(r.recipeWoTarget - r.recipeWoMapped);
      const ratio = r.recipeWoTarget > 0 ? Math.min(100, Math.round((r.recipeWoMapped / r.recipeWoTarget) * 100)) : 0;
      const allergens = detectAllergens([r.recipeName, r.expiringSubRecipeName || ""]);
      return { ...r, status, bestByText, bestByTs, open, ratio, allergens };
    });

  function allergenSig(row: EnrichedRow): string {
    return row.allergens.map((a) => a.label).sort().join("|") || "none";
  }
  function placementScore(lineRows: EnrichedRow[], lineTargets: number[], idx: number, candidate: EnrichedRow): number {
    const last = lineRows.at(-1);
    const switchPenalty = last && allergenSig(last) !== allergenSig(candidate) ? 3 : 0;
    const projected = lineTargets.map((v, i) => i === idx ? v + candidate.recipeWoTarget : v);
    const max = Math.max(...projected, 1), min = Math.min(...projected);
    return switchPenalty + (max - min) / PET_PORTIONS_PER_LINE_PER_SHIFT
      + Math.max(0, (projected[idx] - PET_PORTIONS_PER_LINE_PER_SHIFT) / PET_PORTIONS_PER_LINE_PER_SHIFT) * 2;
  }

  const shifts = Array.from(new Set(runRows.map((r) => r.productionShift)))
    .sort((a, b) => daySortValue(a) - daySortValue(b));

  const lines: ComputedLine[] = [];

  for (const shift of shifts) {
    const rows = runRows
      .filter((r) => r.productionShift === shift)
      .sort((a, b) => {
        if (a.bestByTs != null && b.bestByTs != null && a.bestByTs !== b.bestByTs) return a.bestByTs - b.bestByTs;
        if (a.bestByTs != null && b.bestByTs == null) return -1;
        if (a.bestByTs == null && b.bestByTs != null) return 1;
        return b.open - a.open;
      });

    const shiftTarget = rows.reduce((s, r) => s + r.recipeWoTarget, 0);
    const lineCount = shiftTarget > PET_PORTIONS_PER_LINE_PER_SHIFT * 2 ? 3 : 2;
    const buckets: EnrichedRow[][] = Array.from({ length: lineCount }, () => []);
    const bucketTargets = Array.from({ length: lineCount }, () => 0);

    for (const row of rows) {
      let best = 0, bestScore = Infinity;
      for (let i = 0; i < lineCount; i++) {
        const s = placementScore(buckets[i], bucketTargets, i, row) + (bucketTargets[i] / PET_PORTIONS_PER_LINE_PER_SHIFT) * 0.001;
        if (s < bestScore) { bestScore = s; best = i; }
      }
      buckets[best].push(row);
      bucketTargets[best] += row.recipeWoTarget;
    }

    const { date } = parseDateNeeded(shift);
    const completedOn = oneDayBefore(date);

    for (let i = 0; i < lineCount; i++) {
      lines.push({ lineIdx: i, lineRows: buckets[i], lineTarget: bucketTargets[i], date, completedOn, shift });
    }
  }

  return { lines, runRows };
}

// ─── Karten-HTML für eine einzelne Linie ─────────────────────────────────────

const LINE_COLORS  = ["#0369a1", "#065f46", "#92400e"];
const LINE_LIGHT   = ["#dbeafe", "#d1fae5", "#fef3c7"];
const LINE_ACCENT  = ["#0ea5e9", "#10b981", "#f59e0b"];
const LINE_GRAD    = [
  "linear-gradient(135deg,#0c2340 0%,#0369a1 100%)",
  "linear-gradient(135deg,#022c22 0%,#065f46 100%)",
  "linear-gradient(135deg,#451a03 0%,#92400e 100%)",
];

function buildLinePageHtml(
  line: ComputedLine,
  isFirstPage: boolean,
  soonLimit: number,
  platingNotes: Record<string, PlatingNote> | undefined,
  mealCatalogImages: Record<string, string> | undefined,
  recipes: Record<string, Recipe> | undefined,
): string {
  const { lineIdx, lineRows, lineTarget, date, completedOn } = line;
  const lineColor  = LINE_COLORS[lineIdx]  ?? "#0369a1";
  const lineLight  = LINE_LIGHT[lineIdx]   ?? "#dbeafe";
  const lineAccent = LINE_ACCENT[lineIdx]  ?? "#0ea5e9";
  const lineGrad   = LINE_GRAD[lineIdx]    ?? LINE_GRAD[0];
  const pageBreak  = isFirstPage ? "" : "page-break-before:always;";

  let cursorMin = PET_LINE_START_HOUR * 60;
  let cleaningCount = 0;

  const totalSubRecipes = lineRows.reduce((s, row) => {
    const code = extractMealCode(row.recipeName);
    const subs = getSubRecipeData(recipes, code, row.recipeName);
    return s + (subs.length > 0 ? subs.length : 1);
  }, 0);
  const totalStaff = totalSubRecipes + 1;

  // Mini-Gantt
  let ganttCursor = PET_LINE_START_HOUR * 60;
  const ganttBars = lineRows.map((row, gi) => {
    const dur   = Math.max(10, Math.round((row.recipeWoTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) * 60));
    const left  = Math.round(((ganttCursor - PET_LINE_START_HOUR * 60) / SHIFT_DURATION_MIN) * 100);
    const width = Math.round((dur / SHIFT_DURATION_MIN) * 100);
    ganttCursor += dur;
    const code  = extractMealCode(row.recipeName);
    const shade = gi % 2 === 0 ? "rgba(255,255,255,.9)" : "rgba(255,255,255,.65)";
    return `<div style="position:absolute;left:${left}%;width:${Math.max(width, 2)}%;top:0;bottom:0;background:${shade};display:flex;align-items:center;padding:0 5px;border-right:1px solid rgba(0,0,0,.12);overflow:hidden;">
  <span style="font-size:9px;font-weight:800;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(code)}</span>
</div>`;
  }).join("");

  // Karten
  const cards = lineRows.map((row, rowIdx) => {
    const mealCode    = extractMealCode(row.recipeName);
    const mealTitle   = row.recipeName.replace(/\s*\[.*?\]/g, "").replace(/^[A-Z]{2}\d{4}[A-Z]\s*[-–]\s*/i, "").trim();
    const durationMin = Math.max(10, Math.round((row.recipeWoTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) * 60));
    const timeStart   = cursorMin;
    const timeEnd     = cursorMin + durationMin;
    cursorMin = timeEnd;

    const bestByUrgent = row.bestByTs != null && row.bestByTs <= soonLimit;
    const tone    = petStatusTone(row.status);
    const note    = platingNotes?.[mealCode];
    const imgSrc  = mealCatalogImages?.[mealCode] ?? note?.mealImageDataUrl;
    const util    = Math.round((row.recipeWoTarget / PET_PORTIONS_PER_LINE_PER_SHIFT) * 100);
    const hasFish = row.allergens.some((a) => a.label === "Fisch");

    // Subrezepte mit Instructions
    const subData   = getSubRecipeData(recipes, mealCode, row.recipeName);
    const mealStaff = (subData.length > 0 ? subData.length : 1) + 1;

    // MA-Kacheln
    const staffChips = subData.length > 0
      ? [
          ...subData.map((s, i) => `<div class="s-chip" style="background:${lineLight};border:2px solid ${lineAccent};">
  <div class="s-role">MA ${i + 1}</div>
  <div class="s-task">${escapeHtml(s.name)}</div>
  ${s.instruction ? `<div class="s-instr">${escapeHtml(s.instruction)}</div>` : ""}
</div>`),
          `<div class="s-chip s-lead" style="background:${lineColor};">
  <div class="s-role" style="color:rgba(255,255,255,.65);">LINIENLEAD</div>
  <div class="s-task" style="color:#fff;">Koordination &amp; QS</div>
</div>`,
        ].join("")
      : `<div class="s-chip" style="background:${lineLight};border:2px dashed ${lineAccent}40;">
  <div class="s-role">MA 1+</div><div class="s-task" style="color:#64748b;">Subrezepte prüfen</div>
</div>
<div class="s-chip s-lead" style="background:${lineColor};">
  <div class="s-role" style="color:rgba(255,255,255,.65);">LINIENLEAD</div>
  <div class="s-task" style="color:#fff;">Koordination &amp; QS</div>
</div>`;

    // Plating-Anweisung: manuelle Note hat Vorrang, sonst Instructions aus Rezept
    let platingHtml = "";
    if (note?.instruction) {
      platingHtml = `<div class="r-plating">
  <div class="r-plating-hdr">🍽&ensp;PLATING-ANWEISUNG</div>
  <div class="r-plating-text">${escapeHtml(note.instruction)}</div>
</div>`;
    } else if (subData.some((s) => s.instruction)) {
      const instrLines = subData
        .filter((s) => s.instruction)
        .map((s) => `<div class="instr-item"><strong>${escapeHtml(s.name)}:</strong> ${escapeHtml(s.instruction!)}</div>`)
        .join("");
      platingHtml = `<div class="r-plating">
  <div class="r-plating-hdr">🍽&ensp;PLATING-ANWEISUNG (aus Rezept)</div>
  <div class="instr-list">${instrLines}</div>
</div>`;
    }

    // Allergen-Badges
    const allergenBadges = row.allergens.length
      ? row.allergens.map((a) => `<span class="a-badge" style="background:${a.bg};color:${a.text};border:1px solid ${a.border};">${escapeHtml(a.label)}</span>`).join("")
      : `<span class="a-none">Keine bekannten Allergene ✓</span>`;

    // Besonderheiten
    const attn: string[] = [];
    if (hasFish)      attn.push(`<span class="attn-icon">🐟</span><div><strong>FISCH-ALLERGEN</strong><br>Linie nach diesem Meal vollständig reinigen</div>`);
    if (bestByUrgent) attn.push(`<span class="attn-icon">⏰</span><div><strong>BEST BY DRINGEND:</strong> ${escapeHtml(row.bestByText)}<br>Dieses Meal als erstes platen!</div>`);
    if (row.open > 0) attn.push(`<span class="attn-icon">⚠</span><div>Noch <strong>${fmtInt(row.open)} Portionen</strong> offen (Gap)</div>`);
    const attnHtml = attn.length
      ? `<div class="r-attn">${attn.map((a) => `<div class="r-attn-item">${a}</div>`).join("")}</div>`
      : "";

    // Reinigung
    let cleanHtml = "";
    if (rowIdx < lineRows.length - 1) {
      const cur = new Set(row.allergens.map((a) => a.label));
      const nxt = new Set((lineRows[rowIdx + 1]?.allergens ?? []).map((a) => a.label));
      const removed = [...cur].filter((l) => !nxt.has(l));
      const added   = [...nxt].filter((l) => !cur.has(l));
      if (removed.length || added.length) {
        const parts = [
          removed.length ? `entfernt: <strong>${removed.map(escapeHtml).join(", ")}</strong>` : "",
          added.length   ? `neu: <strong>${added.map(escapeHtml).join(", ")}</strong>` : "",
        ].filter(Boolean).join(" · ");
        cleanHtml = `<div class="clean-bar">🧹&ensp;LINIE REINIGEN vor nächstem Meal — ${parts}</div>`;
        cleaningCount++;
      }
    }

    // Gantt-Position
    const ganttLeft  = Math.min(99, Math.round(((timeStart - PET_LINE_START_HOUR * 60) / SHIFT_DURATION_MIN) * 100));
    const ganttWidth = Math.min(100 - ganttLeft, Math.max(2, Math.round((durationMin / SHIFT_DURATION_MIN) * 100)));

    return `<div class="r-card" style="border-left-color:${lineAccent};">
  <div class="r-id">
    <div class="r-id-left">
      <span class="r-code">${escapeHtml(mealCode)}</span>
      <span class="r-title">${escapeHtml(mealTitle)}</span>
    </div>
    <span class="r-status" style="background:${tone.bg};color:${tone.text};border:2px solid ${tone.border};">${escapeHtml(row.status)}</span>
  </div>
  <div class="r-body">
    ${imgSrc ? `<div class="r-img-col"><img src="${imgSrc}" alt="${escapeHtml(mealCode)}" class="r-img"></div>` : ""}
    <div class="r-metrics">
      <div class="r-time-row">
        <div><div class="m-lbl">Zeitfenster</div><div class="m-time">${formatClock(timeStart)}&nbsp;<span style="color:#94a3b8;font-weight:300;">→</span>&nbsp;${formatClock(timeEnd)}</div></div>
        <div><div class="m-lbl">Dauer</div><div class="m-dur">${(durationMin / 60).toFixed(1)}&thinsp;h <span class="m-min">(${durationMin}&thinsp;min)</span></div></div>
      </div>
      <div class="m-lbl" style="margin-top:6px;">Position im Shift (07:00–14:00)</div>
      <div class="g-track"><div class="g-fill" style="margin-left:${ganttLeft}%;width:${ganttWidth}%;background:${lineAccent};"></div></div>
      <div class="m-kpi-row">
        <div class="m-kpi">
          <div class="m-lbl">Auslastung</div>
          <div class="m-kpi-val" style="color:${utilBarColor(util)};">${util}%</div>
          ${inlineBar(util, utilBarColor(util), 5)}
        </div>
        <div class="m-kpi"><div class="m-lbl">SOLL</div><div class="m-kpi-val">${fmtInt(row.recipeWoTarget)}</div></div>
        <div class="m-kpi"><div class="m-lbl">IST</div><div class="m-kpi-val" style="color:#0369a1;">${fmtInt(row.recipeWoMapped)}</div></div>
        <div class="m-kpi"><div class="m-lbl">Gap</div><div class="m-kpi-val" style="color:${row.open > 0 ? "#dc2626" : "#16a34a"};">${row.open > 0 ? "−" : ""}${fmtInt(row.open)}</div></div>
      </div>
      ${row.bestByText ? `<div class="r-bb${bestByUrgent ? " r-bb-urgent" : ""}">⏰ Best By: <strong>${escapeHtml(row.bestByText)}</strong></div>` : ""}
      <div class="r-allergens">${allergenBadges}</div>
    </div>
  </div>
  <div class="r-staff" style="border-color:${lineAccent}30;">
    <div class="r-staff-hdr" style="color:${lineColor};">👥&ensp;<strong>${mealStaff} Mitarbeiter</strong> für dieses Meal</div>
    <div class="s-grid">${staffChips}</div>
  </div>
  ${platingHtml}
  ${attnHtml}
  ${note?.packSchemaImageDataUrl ? `<div class="r-pack"><div class="m-lbl" style="margin-bottom:4px;">Packschema</div><img src="${note.packSchemaImageDataUrl}" alt="Packschema" class="pack-img"></div>` : ""}
</div>${cleanHtml}`;
  }).join("");

  const lineEndTime   = cursorMin;
  const lineDoneCount = lineRows.filter((r) => /done|complet/i.test(r.status)).length;
  const linePct       = lineRows.length > 0 ? Math.round((lineDoneCount / lineRows.length) * 100) : 0;

  return `<div class="l-page" style="${pageBreak}">
  <div class="l-hdr" style="background:${lineGrad};">
    <div class="l-hdr-top">
      <div>
        <div class="l-num">Plating-Linie ${lineIdx + 1}</div>
        <div class="l-shift">Shift: ${escapeHtml(date)}&ensp;·&ensp;Fertig bis: ${escapeHtml(completedOn)}</div>
      </div>
      <div class="l-badges">
        <div class="l-badge"><div class="l-b-lbl">Meals</div><div class="l-b-val">${lineRows.length}</div></div>
        <div class="l-badge"><div class="l-b-lbl">Portionen</div><div class="l-b-val">${fmtInt(lineTarget)}</div></div>
        <div class="l-badge"><div class="l-b-lbl">Mitarbeiter</div><div class="l-b-val">${totalStaff}</div></div>
        <div class="l-badge"><div class="l-b-lbl">Reinigungen</div><div class="l-b-val">${cleaningCount}</div></div>
      </div>
    </div>
    <div class="l-gantt-row">
      <span>07:00</span>
      <div class="l-gantt">
        <div class="l-gantt-lbls"><span>07:00</span><span>08:45</span><span>10:30</span><span>12:15</span><span>14:00</span></div>
        <div class="l-gantt-bars">${ganttBars}</div>
      </div>
      <span>${formatClock(lineEndTime)}</span>
    </div>
    <div class="l-prog-row">
      <span class="l-prog-lbl">Fortschritt: ${lineDoneCount}/${lineRows.length}</span>
      ${inlineBar(linePct, "#fff", 6)}
    </div>
  </div>
  <div class="l-cards">${cards || `<div class="empty-msg">Keine Rezepte für diese Linie</div>`}</div>
</div>`;
}

// ─── Gemeinsames CSS ──────────────────────────────────────────────────────────

const BASE_CSS = `
${PRINT_COLOR_FIX}
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4 landscape;margin:8mm 10mm}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1e293b;background:#f1f5f9}

/* ── Linie-Seite ── */
.l-page{display:block;margin-bottom:20px}
.l-hdr{border-radius:12px 12px 0 0;padding:16px 22px 14px;color:#fff}
.l-hdr-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:16px}
.l-num{font-size:30px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;line-height:1}
.l-shift{font-size:13px;opacity:.82;margin-top:5px;font-weight:500}
.l-badges{display:flex;gap:8px;flex-shrink:0}
.l-badge{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:6px 14px;text-align:center;min-width:70px}
.l-b-lbl{font-size:9px;opacity:.7;text-transform:uppercase;letter-spacing:.09em}
.l-b-val{font-size:21px;font-weight:900;line-height:1;margin-top:2px}
.l-gantt-row{display:flex;align-items:center;gap:10px;font-size:11px;opacity:.75;margin-bottom:10px}
.l-gantt{flex:1}
.l-gantt-lbls{display:flex;justify-content:space-between;font-size:9px;opacity:.65;margin-bottom:3px}
.l-gantt-bars{height:24px;background:rgba(0,0,0,.2);border-radius:4px;position:relative;overflow:hidden}
.l-prog-row{display:flex;align-items:center;gap:10px;opacity:.8}
.l-prog-lbl{font-size:10px;white-space:nowrap;min-width:140px}
.l-cards{background:#e2e8f0;padding:8px;border-radius:0 0 12px 12px;display:flex;flex-direction:column;gap:10px}

/* ── Rezept-Karte ── */
.r-card{background:#fff;border-radius:0 10px 10px 0;border:1px solid #e2e8f0;border-left:6px solid;padding:14px 16px;page-break-inside:avoid;break-inside:avoid;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.r-id{display:flex;align-items:center;gap:12px;margin-bottom:12px;padding-bottom:10px;border-bottom:2px solid #f1f5f9;flex-wrap:wrap}
.r-id-left{display:flex;align-items:baseline;gap:10px;flex:1;min-width:0;flex-wrap:wrap}
.r-code{font-family:'Courier New',monospace;font-size:17px;font-weight:900;color:#0f172a;flex-shrink:0;background:#f1f5f9;padding:3px 8px;border-radius:5px}
.r-title{font-size:17px;font-weight:800;color:#1e293b;line-height:1.3;overflow-wrap:anywhere}
.r-status{border-radius:99px;padding:5px 14px;font-size:11px;font-weight:900;white-space:nowrap;flex-shrink:0;text-transform:uppercase;letter-spacing:.04em}
.r-body{display:flex;gap:14px;margin-bottom:10px}
.r-img-col{flex-shrink:0;width:190px}
.r-img{width:100%;height:148px;object-fit:cover;border-radius:8px;border:1px solid #e2e8f0;display:block}
.r-metrics{flex:1;min-width:0}
.r-time-row{display:flex;gap:24px;margin-bottom:8px}
.m-lbl{font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px}
.m-time{font-size:21px;font-weight:900;color:#0f172a}
.m-dur{font-size:18px;font-weight:800;color:#334155}
.m-min{font-size:12px;font-weight:400;color:#94a3b8}
.g-track{background:#e2e8f0;border-radius:4px;height:10px;overflow:hidden;margin-bottom:8px;position:relative}
.g-fill{height:100%;border-radius:4px;position:absolute;top:0}
.m-kpi-row{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:7px}
.m-kpi{min-width:56px}
.m-kpi-val{font-size:16px;font-weight:900;line-height:1.1;margin-top:1px}
.r-bb{font-size:11px;color:#475569;margin-top:5px;padding:3px 8px;background:#f8fafc;border-radius:4px;display:inline-block}
.r-bb-urgent{background:#fee2e2;color:#991b1b;font-weight:800}
.r-allergens{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
.a-badge{display:inline-block;border-radius:4px;padding:3px 9px;font-size:10px;font-weight:800}
.a-none{font-size:10px;color:#22c55e;font-weight:700;background:#f0fdf4;padding:3px 9px;border-radius:4px}

/* ── MA-Zuweisung ── */
.r-staff{border-top:2px dashed;margin-top:10px;padding-top:10px}
.r-staff-hdr{font-size:14px;font-weight:800;margin-bottom:8px;display:flex;align-items:center;gap:5px}
.s-grid{display:flex;flex-wrap:wrap;gap:6px}
.s-chip{border-radius:8px;padding:7px 12px;min-width:130px;max-width:230px}
.s-role{font-size:9px;text-transform:uppercase;letter-spacing:.12em;color:#64748b;margin-bottom:3px;font-weight:700}
.s-lead .s-role{color:rgba(255,255,255,.65)}
.s-task{font-size:13px;font-weight:700;color:#1e293b;line-height:1.3;overflow-wrap:anywhere}
.s-instr{font-size:11px;color:#475569;margin-top:3px;line-height:1.4;font-style:italic;border-top:1px solid rgba(0,0,0,.07);padding-top:3px;margin-top:4px}

/* ── Plating-Anweisung ── */
.r-plating{margin-top:10px;padding:10px 14px;background:#f0fdf4;border-left:5px solid #22c55e;border-radius:0 8px 8px 0}
.r-plating-hdr{font-size:10px;font-weight:900;color:#166534;text-transform:uppercase;letter-spacing:.12em;margin-bottom:5px}
.r-plating-text{font-size:15px;color:#14532d;line-height:1.55;font-weight:500}
.instr-list{display:flex;flex-direction:column;gap:5px}
.instr-item{font-size:13px;color:#14532d;line-height:1.45}

/* ── Besonderheiten ── */
.r-attn{margin-top:10px;padding:10px 14px;background:#fffbeb;border:2px solid #f59e0b;border-radius:8px;display:flex;flex-direction:column;gap:7px}
.r-attn-item{display:flex;align-items:flex-start;gap:10px;font-size:12px;color:#78350f}
.attn-icon{font-size:18px;flex-shrink:0;line-height:1.2}
.r-pack{margin-top:10px}
.pack-img{max-width:100%;max-height:120px;object-fit:contain;border:1px solid #e2e8f0;border-radius:6px}
.clean-bar{display:flex;align-items:center;gap:12px;padding:10px 16px;background:#fef3c7;border:3px dashed #d97706;border-radius:8px;margin:4px 0;font-size:13px;color:#78350f;font-weight:800}
.empty-msg{font-size:12px;color:#94a3b8;text-align:center;padding:28px}
.doc-footer{margin-top:20px;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px;display:flex;justify-content:space-between}
`;

// ─── Vollständiger Plan (alle Linien) ─────────────────────────────────────────

export function buildPetPresentationHtml(
  allPetRows: PetRow[],
  sourceLabel: string,
  targetRun: 1 | 2,
  platingNotes?: Record<string, PlatingNote>,
  mealCatalogImages?: Record<string, string>,
  recipes?: Record<string, Recipe>,
): string {
  const runLabel = `Run ${targetRun}`;
  const generatedAt = new Date().toLocaleString("de-DE");
  const soonLimit = Date.now() + 48 * 60 * 60 * 1000;

  const { lines, runRows } = computeLines(allPetRows, targetRun);

  const totalTarget = runRows.reduce((s, r) => s + r.recipeWoTarget, 0);
  const totalMapped = runRows.reduce((s, r) => s + r.recipeWoMapped, 0);
  const totalOpen   = runRows.reduce((s, r) => s + r.open, 0);
  const completion  = totalTarget > 0 ? Math.min(100, Math.round((totalMapped / totalTarget) * 100)) : 0;
  const doneCount   = runRows.filter((r) => /done|complet/i.test(r.status)).length;
  const inProgCount = runRows.filter((r) => /in.?progress/i.test(r.status)).length;
  const nsCount     = runRows.filter((r) => /not.?started/i.test(r.status)).length;
  const urgBBCount  = runRows.filter((r) => r.bestByTs != null && r.bestByTs <= soonLimit).length;
  const globalAllergens = new Set(runRows.flatMap((r) => r.allergens.map((a) => a.label)));
  const shifts = Array.from(new Set(runRows.map((r) => r.productionShift)));

  const linePages = lines.map((line, i) =>
    buildLinePageHtml(line, i === 0, soonLimit, platingNotes, mealCatalogImages, recipes)
  );

  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>PET Plating — ${runLabel}</title>
<style>
${BASE_CSS}
/* ── Deckblatt (nur im Full-Plan) ── */
.cover{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 50%,#0369a1 100%);border-radius:12px;padding:28px 32px 22px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-end;gap:24px}
.cover-left .c-eye{font-size:10px;letter-spacing:.25em;color:#7dd3fc;text-transform:uppercase;margin-bottom:8px}
.cover-left .c-title{font-size:34px;font-weight:900;color:#fff;letter-spacing:-.02em;line-height:1}
.cover-left .c-sub{font-size:14px;color:#bae6fd;margin-top:8px;font-weight:500}
.cover-left .c-meta{font-size:10px;color:#64748b;margin-top:14px;border-top:1px solid rgba(255,255,255,.12);padding-top:10px}
.c-kpis{display:flex;gap:8px;flex-shrink:0}
.ckpi{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:10px 16px;text-align:center;min-width:72px}
.ckpi-lbl{font-size:9px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:.1em}
.ckpi-val{font-size:24px;font-weight:900;color:#fff;margin-top:4px;line-height:1}
.prog-outer{margin-bottom:14px;background:#fff;border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:16px}
.prog-lbl{font-size:11px;color:#475569;white-space:nowrap;min-width:120px}
.prog-track{flex:1;height:10px;background:#e2e8f0;border-radius:5px;overflow:hidden}
.prog-fill{height:100%;border-radius:5px;background:linear-gradient(90deg,#0ea5e9,#10b981)}
.prog-pct{font-size:15px;font-weight:900;min-width:42px;text-align:right}
.s-row{display:flex;gap:8px;margin-bottom:14px}
.s-box{flex:1;border-radius:8px;padding:10px 12px;border:1px solid}
.s-lbl{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#64748b;margin-bottom:4px}
.s-val{font-size:22px;font-weight:900}
.s-box.done{background:#f0fdf4;border-color:#86efac}.s-box.done .s-val{color:#16a34a}
.s-box.prog{background:#fffbeb;border-color:#fde68a}.s-box.prog .s-val{color:#d97706}
.s-box.open{background:#fef2f2;border-color:#fca5a5}.s-box.open .s-val{color:#dc2626}
.s-box.bb{background:#faf5ff;border-color:#d8b4fe}.s-box.bb .s-val{color:#9333ea}
.g-allergens{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;font-size:11px;color:#334155;margin-bottom:14px}
</style>
</head><body>
<div class="cover">
  <div class="cover-left">
    <div class="c-eye">Factor OPS &middot; Verden &middot; PET Plating</div>
    <div class="c-title">PET Plating Plan<br><span style="color:#7dd3fc;">${runLabel}</span></div>
    <div class="c-sub">${fmtInt(runRows.length)} Meals &ensp;·&ensp; ${fmtInt(totalTarget)} Portionen &ensp;·&ensp; ${shifts.length} Schicht${shifts.length !== 1 ? "en" : ""}</div>
    <div class="c-meta">Erstellt: ${escapeHtml(generatedAt)} &nbsp;·&nbsp; Quelle: ${escapeHtml(sourceLabel)}</div>
  </div>
  <div class="c-kpis">
    <div class="ckpi"><div class="ckpi-lbl">Soll</div><div class="ckpi-val">${fmtInt(totalTarget)}</div></div>
    <div class="ckpi"><div class="ckpi-lbl">Ist</div><div class="ckpi-val" style="color:#7dd3fc;">${fmtInt(totalMapped)}</div></div>
    <div class="ckpi"><div class="ckpi-lbl">Offen</div><div class="ckpi-val" style="color:${totalOpen > 0 ? "#fca5a5" : "#86efac"};">${fmtInt(totalOpen)}</div></div>
    <div class="ckpi"><div class="ckpi-lbl">Fertig</div><div class="ckpi-val" style="color:${completion >= 80 ? "#86efac" : completion >= 50 ? "#fde68a" : "#fca5a5"};">${completion}%</div></div>
  </div>
</div>
<div class="prog-outer">
  <span class="prog-lbl">Gesamtfortschritt ${runLabel}</span>
  <div class="prog-track"><div class="prog-fill" style="width:${completion}%;"></div></div>
  <span class="prog-pct" style="color:${completion >= 80 ? "#16a34a" : completion >= 50 ? "#d97706" : "#dc2626"};">${completion}%</span>
</div>
<div class="s-row">
  <div class="s-box done"><div class="s-lbl">Erledigt</div><div class="s-val">${fmtInt(doneCount)}</div></div>
  <div class="s-box prog"><div class="s-lbl">In Arbeit</div><div class="s-val">${fmtInt(inProgCount)}</div></div>
  <div class="s-box open"><div class="s-lbl">Offen</div><div class="s-val">${fmtInt(nsCount)}</div></div>
  <div class="s-box bb"><div class="s-lbl">Best-By &lt;48h</div><div class="s-val">${fmtInt(urgBBCount)}</div></div>
</div>
${globalAllergens.size ? `<div class="g-allergens">&#9888;&ensp;<strong>Allergene in diesem Run:</strong> ${Array.from(globalAllergens).join(" · ")}</div>` : ""}
${linePages.join("\n") || `<div class="empty-msg">Keine Daten für ${escapeHtml(runLabel)}.</div>`}
<div class="doc-footer">
  <span>Factor OPS Planner &middot; PET Plating Plan &middot; ${escapeHtml(runLabel)}</span>
  <span>${escapeHtml(generatedAt)}</span>
</div>
</body></html>`;
}

// ─── Pro-Linie-Exports (für separate Popup-Fenster / E-Mail-Anhänge) ─────────

export type PetLineExport = { lineName: string; html: string };

export function buildPetLineHtmls(
  allPetRows: PetRow[],
  sourceLabel: string,
  targetRun: 1 | 2,
  platingNotes?: Record<string, PlatingNote>,
  mealCatalogImages?: Record<string, string>,
  recipes?: Record<string, Recipe>,
): PetLineExport[] {
  const runLabel = `Run ${targetRun}`;
  const generatedAt = new Date().toLocaleString("de-DE");
  const soonLimit = Date.now() + 48 * 60 * 60 * 1000;

  const { lines } = computeLines(allPetRows, targetRun);

  return lines.map((line) => {
    const lineName = `Plating-Linie ${line.lineIdx + 1} — ${runLabel} (${line.date})`;
    const pageHtml = buildLinePageHtml(line, true, soonLimit, platingNotes, mealCatalogImages, recipes);

    const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><title>${lineName}</title>
<style>
${BASE_CSS}
</style>
</head><body>
${pageHtml}
<div class="doc-footer">
  <span>${escapeHtml(lineName)} &middot; Quelle: ${escapeHtml(sourceLabel)}</span>
  <span>${escapeHtml(generatedAt)}</span>
</div>
</body></html>`;

    return { lineName, html };
  });
}
