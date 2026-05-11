/**
 * planExport.ts
 * Wochenplan-Export: TSV, Excel (SpreadsheetML .xls) und PDF/Print
 */
import type { DataBundle, CookSchedule, WeekRecipe } from "./types";
import type { PlannerWeekAnalysis, PlannerDay, PlannerShift } from "./planner";
import { PLANNER_DAYS, PLANNER_SHIFTS } from "./planner";

// ─── Typen ───────────────────────────────────────────────────────────────────

export interface PlanExportRow {
  tag: string;
  tagShort: PlannerDay;
  schicht: string;
  schichtShort: PlannerShift;
  reihenfolge: number;
  art: "Hauptrezept" | "Sub-Rezept";
  code: string;
  name: string;
  subRezept: string;
  category: string;
  portionen: number;
  minuten: number;
  notiz: string;
  dkse: number;
  benl: number;
  de: number;
}

export interface PrepStep {
  rezeptCode: string;
  rezeptName: string;
  subRezept: string;
  category: string;
  schritt: string;
  ausführTag: string;
  ausführTagShort: PlannerDay;
  ausführSchicht: string;
  ausführSchichtShort: PlannerShift;
  hauptTag: string;
  hauptSchicht: string;
}

// ─── Interne Hilfsfunktionen ─────────────────────────────────────────────────

const DAY_LABELS: Record<PlannerDay, string> = {
  Mo: "Montag", Di: "Dienstag", Mi: "Mittwoch", Do: "Donnerstag",
  Fr: "Freitag", Sa: "Samstag", So: "Sonntag",
};

const SHIFT_LABELS: Record<PlannerShift, string> = {
  S1: "1st Shift (06–14 Uhr)",
  S2: "2nd Shift (14–22 Uhr)",
  S3: "3rd Shift (22–06 Uhr)",
};

function slotIdx(day: PlannerDay, shift: PlannerShift): number {
  return PLANNER_DAYS.indexOf(day) * PLANNER_SHIFTS.length + PLANNER_SHIFTS.indexOf(shift);
}

function slotFromIdx(idx: number): { day: PlannerDay; shift: PlannerShift } | null {
  const dayIdx = Math.floor(idx / PLANNER_SHIFTS.length);
  const shiftIdx = idx % PLANNER_SHIFTS.length;
  if (dayIdx < 0 || dayIdx >= PLANNER_DAYS.length) return null;
  return { day: PLANNER_DAYS[dayIdx], shift: PLANNER_SHIFTS[shiftIdx] };
}

function canonicalMethod(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

function resolveCookSchedule(category: string, schedules: Record<string, CookSchedule>): CookSchedule | undefined {
  if (schedules[category]) return schedules[category];
  const canon = canonicalMethod(category);
  for (const [method, sched] of Object.entries(schedules)) {
    if (canonicalMethod(method) === canon) return sched;
  }
  const wanted = new Set(canon.split("/").filter(Boolean));
  for (const [method, sched] of Object.entries(schedules)) {
    const actual = canonicalMethod(method).split("/").filter(Boolean);
    if (actual.length > 0 && actual.every(t => wanted.has(t))) return sched;
  }
  return undefined;
}

function fmtDE(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── Exportdaten aufbauen ────────────────────────────────────────────────────

export function buildPlanExportRows(
  analysis: PlannerWeekAnalysis,
  data: DataBundle,
  week: string,
  portionMultiplier = 1,
): { rows: PlanExportRow[]; prepSteps: PrepStep[] } {
  const weekRecipeByCode = Object.fromEntries(
    data.weekRecipes.filter(r => r.hfWeek === week).map(r => [r.code, r]),
  ) as Record<string, WeekRecipe>;

  const rows: PlanExportRow[] = [];
  const prepSteps: PrepStep[] = [];

  for (const recipe of analysis.recipes) {
    const wr = weekRecipeByCode[recipe.recipeCode];
    const totalPortions = wr ? Math.round(wr.totalVerdenVolume * portionMultiplier) : 0;
    const dkse = wr ? Math.round(wr.verdenVolume.DKSE * portionMultiplier) : 0;
    const benl = wr ? Math.round(wr.verdenVolume.BENL * portionMultiplier) : 0;
    const de   = wr ? Math.round(wr.verdenVolume.DE   * portionMultiplier) : 0;

    if (recipe.assigned) {
      rows.push({
        tag: DAY_LABELS[recipe.assigned.day],
        tagShort: recipe.assigned.day,
        schicht: SHIFT_LABELS[recipe.assigned.shift],
        schichtShort: recipe.assigned.shift,
        reihenfolge: recipe.assigned.order ?? 1,
        art: "Hauptrezept",
        code: recipe.recipeCode,
        name: recipe.recipeName,
        subRezept: "",
        category: "",
        portionen: recipe.assigned.targetPortions ?? totalPortions,
        minuten: recipe.activeMin,
        notiz: recipe.assigned.note ?? "",
        dkse, benl, de,
      });
    }

    for (const sub of recipe.subRecipes) {
      if (!sub.assigned) continue;

      rows.push({
        tag: DAY_LABELS[sub.assigned.day],
        tagShort: sub.assigned.day,
        schicht: SHIFT_LABELS[sub.assigned.shift],
        schichtShort: sub.assigned.shift,
        reihenfolge: sub.assigned.order ?? 1,
        art: "Sub-Rezept",
        code: recipe.recipeCode,
        name: recipe.recipeName,
        subRezept: sub.subRecipeName,
        category: sub.category,
        portionen: sub.assigned.targetPortions ?? totalPortions,
        minuten: sub.activeMin,
        notiz: sub.assigned.note ?? "",
        dkse, benl, de,
      });

      const schedule = resolveCookSchedule(sub.category, data.cookSchedules);
      if (schedule) {
        const baseIdx = slotIdx(sub.assigned.day, sub.assigned.shift);
        for (const step of schedule.steps) {
          const prepIdx = baseIdx - step.shiftsBefore;
          const prepSlot = slotFromIdx(prepIdx);
          if (!prepSlot) continue;
          prepSteps.push({
            rezeptCode: recipe.recipeCode,
            rezeptName: recipe.recipeName,
            subRezept: sub.subRecipeName,
            category: sub.category,
            schritt: step.label,
            ausführTag: DAY_LABELS[prepSlot.day],
            ausführTagShort: prepSlot.day,
            ausführSchicht: SHIFT_LABELS[prepSlot.shift],
            ausführSchichtShort: prepSlot.shift,
            hauptTag: DAY_LABELS[sub.assigned.day],
            hauptSchicht: SHIFT_LABELS[sub.assigned.shift],
          });
        }
      }
    }
  }

  rows.sort((a, b) => {
    const ai = slotIdx(a.tagShort, a.schichtShort) * 1000 + a.reihenfolge;
    const bi = slotIdx(b.tagShort, b.schichtShort) * 1000 + b.reihenfolge;
    return ai - bi;
  });

  prepSteps.sort((a, b) =>
    slotIdx(a.ausführTagShort, a.ausführSchichtShort) -
    slotIdx(b.ausführTagShort, b.ausführSchichtShort),
  );

  return { rows, prepSteps };
}

// ─── TSV Export ──────────────────────────────────────────────────────────────

export function exportAsTSV(
  analysis: PlannerWeekAnalysis,
  data: DataBundle,
  week: string,
  portionMultiplier = 1,
): void {
  const { rows } = buildPlanExportRows(analysis, data, week, portionMultiplier);
  const headers = ["Tag", "Schicht", "#", "Art", "Code", "Rezeptname", "Sub-Rezept", "Portionen", "DKSE", "BENL", "DE", "Minuten (aktiv)", "Notiz"];
  const lines = [headers.join("\t")];
  for (const r of rows) {
    lines.push([r.tag, r.schicht, r.reihenfolge, r.art, r.code, r.name, r.subRezept, r.portionen, r.dkse, r.benl, r.de, r.minuten, r.notiz].join("\t"));
  }
  triggerDownload(
    new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/tab-separated-values;charset=utf-8" }),
    `Wochenplan-${week}.tsv`,
  );
}

// ─── Excel (SpreadsheetML .xls) ───────────────────────────────────────────────

function xlsEsc(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xlsCell(value: string | number, type: "String" | "Number" = "String", bold = false): string {
  const style = bold ? ' ss:StyleID="bold"' : "";
  return `<Cell${style}><Data ss:Type="${type}">${xlsEsc(value)}</Data></Cell>`;
}

function xlsRow(...cells: string[]): string {
  return `<Row>${cells.join("")}</Row>\n`;
}

function xlsSheet(name: string, rows: string[]): string {
  return `<Worksheet ss:Name="${xlsEsc(name)}"><Table>${rows.join("")}</Table></Worksheet>`;
}

function xlsH(...labels: string[]): string {
  return xlsRow(...labels.map(l => xlsCell(l, "String", true)));
}

export function exportAsExcel(
  analysis: PlannerWeekAnalysis,
  data: DataBundle,
  week: string,
  portionMultiplier = 1,
): void {
  const { rows, prepSteps } = buildPlanExportRows(analysis, data, week, portionMultiplier);

  // Sheet 1 – Tagesplan
  const s1: string[] = [xlsH("Tag", "Schicht", "#", "Art", "Code", "Rezeptname", "Sub-Rezept", "Portionen", "DKSE", "BENL", "DE", "Minuten (aktiv)", "Notiz")];
  for (const r of rows) {
    s1.push(xlsRow(
      xlsCell(r.tag), xlsCell(r.schicht), xlsCell(r.reihenfolge, "Number"),
      xlsCell(r.art), xlsCell(r.code), xlsCell(r.name), xlsCell(r.subRezept),
      xlsCell(r.portionen, "Number"), xlsCell(r.dkse, "Number"),
      xlsCell(r.benl, "Number"), xlsCell(r.de, "Number"),
      xlsCell(r.minuten, "Number"), xlsCell(r.notiz),
    ));
  }

  // Sheet 2 – Cook-Vorbereitungen
  const s2: string[] = [xlsH("Vorbereitung-Tag", "Vorbereitung-Schicht", "Aktion (Step)", "Sub-Rezept", "Cook-Methode", "Rezeptname", "Rezeptcode", "Produktionstag", "Produktions-Schicht")];
  for (const s of prepSteps) {
    s2.push(xlsRow(
      xlsCell(s.ausführTag), xlsCell(s.ausführSchicht), xlsCell(s.schritt),
      xlsCell(s.subRezept), xlsCell(s.category), xlsCell(s.rezeptName),
      xlsCell(s.rezeptCode), xlsCell(s.hauptTag), xlsCell(s.hauptSchicht),
    ));
  }

  // Sheet 3 – Marktvolumen
  const weekRecipes = data.weekRecipes.filter(r => r.hfWeek === week);
  const plannedCodes = new Set(
    analysis.recipes
      .filter(r => r.assigned || r.subRecipes.some(s => s.assigned))
      .map(r => r.recipeCode),
  );
  const s3: string[] = [xlsH("Code", "Rezeptname", "DKSE", "BENL", "DE", "Total (Verden)", "Geplant (Ja/Nein)")];
  for (const wr of weekRecipes) {
    s3.push(xlsRow(
      xlsCell(wr.code), xlsCell(wr.recipeName),
      xlsCell(Math.round(wr.verdenVolume.DKSE * portionMultiplier), "Number"),
      xlsCell(Math.round(wr.verdenVolume.BENL * portionMultiplier), "Number"),
      xlsCell(Math.round(wr.verdenVolume.DE * portionMultiplier), "Number"),
      xlsCell(Math.round(wr.totalVerdenVolume * portionMultiplier), "Number"),
      xlsCell(plannedCodes.has(wr.code) ? "Ja" : "Nein"),
    ));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles>
    <Style ss:ID="bold"><Font ss:Bold="1"/></Style>
  </Styles>
  ${xlsSheet("Tagesplan", s1)}
  ${xlsSheet("Cook-Vorbereitungen", s2)}
  ${xlsSheet("Marktvolumen", s3)}
</Workbook>`;

  triggerDownload(
    new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" }),
    `Wochenplan-${week}.xls`,
  );
}

// ─── PDF / Drucken ────────────────────────────────────────────────────────────

export function exportAsPDF(
  analysis: PlannerWeekAnalysis,
  data: DataBundle,
  week: string,
  portionMultiplier = 1,
): void {
  const { rows, prepSteps } = buildPlanExportRows(analysis, data, week, portionMultiplier);

  const byDay = new Map<string, PlanExportRow[]>();
  for (const row of rows) {
    if (!byDay.has(row.tag)) byDay.set(row.tag, []);
    byDay.get(row.tag)!.push(row);
  }
  const prepByDay = new Map<string, PrepStep[]>();
  for (const step of prepSteps) {
    if (!prepByDay.has(step.ausführTag)) prepByDay.set(step.ausführTag, []);
    prepByDay.get(step.ausführTag)!.push(step);
  }

  const ALL_DAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

  function renderDay(day: string): string {
    const dayRows = byDay.get(day) ?? [];
    const dayPreps = prepByDay.get(day) ?? [];
    if (dayRows.length === 0 && dayPreps.length === 0) return "";

    let html = `<div class="day-block"><h2 class="day-hdr">${day}</h2>`;

    if (dayRows.length > 0) {
      html += `<table><thead><tr>
        <th>#</th><th>Schicht</th><th>Art</th><th>Code</th><th>Rezept / Sub-Rezept</th>
        <th class="r">Port.</th><th class="r">DKSE</th><th class="r">BENL</th><th class="r">DE</th><th class="r">Min</th><th>Notiz</th>
      </tr></thead><tbody>`;
      for (const r of dayRows) {
        const sub = r.art === "Sub-Rezept";
        html += `<tr class="${sub ? "sub" : "main"}">
          <td class="r">${r.reihenfolge}</td>
          <td>${r.schicht.replace(/ \(.*\)/, "")}</td>
          <td>${sub ? "Sub" : "Main"}</td>
          <td class="mono">${r.code}</td>
          <td>${r.name}${sub ? `<br><span class="subn">${r.subRezept}</span>` : ""}</td>
          <td class="r">${fmtDE(r.portionen)}</td>
          <td class="r">${r.dkse > 0 ? fmtDE(r.dkse) : "–"}</td>
          <td class="r">${r.benl > 0 ? fmtDE(r.benl) : "–"}</td>
          <td class="r">${r.de > 0 ? fmtDE(r.de) : "–"}</td>
          <td class="r">${fmtDE(r.minuten)}</td>
          <td>${r.notiz}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }

    if (dayPreps.length > 0) {
      html += `<div class="prep"><h3>⬇ Vorbereitungen (für spätere Produktion)</h3>
        <table><thead><tr>
          <th>Schicht</th><th>Aktion</th><th>Sub-Rezept</th><th>Methode</th><th>Code</th><th>→ Produktionstag</th>
        </tr></thead><tbody>`;
      for (const s of dayPreps) {
        html += `<tr>
          <td>${s.ausführSchicht.replace(/ \(.*\)/, "")}</td>
          <td class="action">${s.schritt}</td>
          <td>${s.subRezept}</td>
          <td>${s.category}</td>
          <td class="mono">${s.rezeptCode}</td>
          <td>${s.hauptTag} · ${s.hauptSchicht.replace(/ \(.*\)/, "")}</td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
    }

    html += `</div>`;
    return html;
  }

  const bodyContent = ALL_DAYS.map(renderDay).filter(Boolean).join("\n");
  const now = new Date().toLocaleString("de-DE");

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Wochenplan ${week}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; font-size: 10px; color: #1e293b; padding: 20px 24px; }
h1 { font-size: 20px; margin-bottom: 2px; }
.meta { font-size: 9px; color: #64748b; margin-bottom: 18px; }
.day-block { margin-bottom: 28px; page-break-inside: avoid; }
.day-hdr { font-size: 13px; font-weight: bold; background: #1e3a5f; color: #fff; padding: 5px 10px; border-radius: 3px 3px 0 0; }
table { width: 100%; border-collapse: collapse; font-size: 9px; margin-top: 0; }
th { background: #e2e8f0; font-weight: bold; text-align: left; padding: 3px 6px; border: 1px solid #cbd5e1; }
td { padding: 3px 6px; border: 1px solid #e2e8f0; vertical-align: top; }
.main { background: #f8fafc; font-weight: 500; }
.sub { background: #fff; }
.subn { color: #64748b; font-size: 8px; }
.mono { font-family: monospace; color: #475569; white-space: nowrap; }
.r { text-align: right; white-space: nowrap; }
.action { font-weight: bold; color: #1d4ed8; }
.prep { margin-top: 6px; }
.prep h3 { font-size: 9px; font-weight: bold; color: #92400e; background: #fef3c7; border-left: 3px solid #d97706; padding: 3px 8px; margin-bottom: 2px; }
@media print {
  body { padding: 8px; }
  .day-block { page-break-inside: avoid; margin-bottom: 16px; }
}
</style>
</head>
<body>
<h1>Wochenplan ${week}</h1>
<p class="meta">Erstellt: ${now} &nbsp;·&nbsp; ${analysis.plannedCount} Rezepte geplant &nbsp;·&nbsp; Szenario: ${analysis.scenario.name}</p>
${bodyContent}
</body>
</html>`;

  const win = window.open("", "_blank", "width=1000,height=750");
  if (!win) { alert("Bitte Popup-Blocker deaktivieren und erneut versuchen."); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 500);
}
