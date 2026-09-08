/**
 * planExport.ts
 * Cook-Timeline PDF (D-4 … D0) für den App-Footer.
 * (Die früheren Wochenboard-Exporte TSV/Excel/PDF sind mit dem Cockpit entfernt —
 *  siehe git-Historie von src/PlanningView.tsx.)
 */
import type { DataBundle, CookSchedule, Recipe } from "../core/types";
import { adjustedPortions } from "./helpers";
import { getBaseVerdenVolume } from "./equipment";

function fmtDE(n: number, digits = 0): string {
  return n.toLocaleString("de-DE", { maximumFractionDigits: digits });
}

// ─── Cook-Timeline PDF (D-2 bis D0 Tagesplan) ────────────────────────────────

interface CookEntry {
  code: string;
  recipeName: string;
  portions: number;
  subRecipe: string;
  cookMethod: string;
  dBefore: number;  // 0 = D0 (Produktionstag), 2 = D-2
}

function resolveCookScheduleForExport(
  category: string,
  cookSchedules: Record<string, CookSchedule>,
): CookSchedule | undefined {
  const key = Object.keys(cookSchedules).find(k =>
    k.toLowerCase().replace(/[^a-z0-9]/g, "").includes(
      category.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)
    )
  );
  return key ? cookSchedules[key] : undefined;
}

export function exportWeeklyCookPlanPDF(
  data: DataBundle,
  week: string,
  upliftPercent: number,
): void {
  const weekRecipes = data.weekRecipes.filter(r => r.hfWeek === week);
  const entries: CookEntry[] = [];

  for (const wr of weekRecipes) {
    const recipe: Recipe | undefined = data.recipes[wr.code] ??
      Object.values(data.recipes).find(r => {
        const getDigits = (c: string) => /(\d{4,5})/.exec(c)?.[1] ?? c;
        return getDigits(r.code) === getDigits(wr.code);
      });
    if (!recipe) continue;

    const portions = adjustedPortions(getBaseVerdenVolume(wr), upliftPercent);
    const seenSubs = new Set<string>();

    for (const md of Object.values(recipe.markets)) {
      if (!md) continue;
      for (const sub of md.subRecipes) {
        if (seenSubs.has(sub.id)) continue;
        seenSubs.add(sub.id);

        // Resolve cook schedule
        const cs = resolveCookScheduleForExport(sub.category, data.cookSchedules);
        const maxDBefore = cs
          ? Math.max(...cs.steps.map(s => s.shiftsBefore))
          : 0;

        entries.push({
          code: wr.code,
          recipeName: recipe.baseName || wr.recipeName,
          portions,
          subRecipe: sub.name,
          cookMethod: sub.category,
          dBefore: maxDBefore,
        });
      }
    }
  }

  // Group by D-before offset (descending: D-4, D-3, D-2, D-1, D0)
  const grouped = new Map<number, CookEntry[]>();
  for (const e of entries) {
    if (!grouped.has(e.dBefore)) grouped.set(e.dBefore, []);
    grouped.get(e.dBefore)!.push(e);
  }
  const sortedDays = [...grouped.keys()].sort((a, b) => b - a);

  function renderGroup(dBefore: number): string {
    const label = dBefore === 0 ? "D0 — Produktionstag" : `D-${dBefore} — ${dBefore} Tag${dBefore > 1 ? "e" : ""} vorher`;
    const rows = grouped.get(dBefore)!.sort((a, b) => b.portions - a.portions);
    let html = `<div class="day-block"><h2 class="day-hdr">${label}</h2>
      <table><thead><tr>
        <th>Code</th><th>Rezept</th><th>Sub-Rezept</th><th>Methode</th><th class="r">Portionen</th>
      </tr></thead><tbody>`;
    let last = "";
    for (const r of rows) {
      const isNewRecipe = r.code !== last;
      last = r.code;
      html += `<tr class="${isNewRecipe ? "main" : "sub"}">
        <td class="mono">${isNewRecipe ? r.code : ""}</td>
        <td>${isNewRecipe ? r.recipeName : ""}</td>
        <td>${r.subRecipe}</td>
        <td>${r.cookMethod}</td>
        <td class="r">${isNewRecipe ? fmtDE(r.portions) : ""}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
    return html;
  }

  const bodyContent = sortedDays.map(renderGroup).join("\n");
  const now = new Date().toLocaleString("de-DE");
  const upliftLabel = upliftPercent !== 0 ? ` (+${upliftPercent}% Uplift)` : "";

  const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Cook-Timeline ${week}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Arial, sans-serif; font-size: 10px; color: #1e293b; padding: 20px 24px; }
h1 { font-size: 18px; margin-bottom: 2px; }
.meta { font-size: 9px; color: #64748b; margin-bottom: 18px; }
.day-block { margin-bottom: 24px; page-break-inside: avoid; }
.day-hdr { font-size: 12px; font-weight: bold; background: #0f4c81; color: #fff; padding: 5px 10px; border-radius: 3px 3px 0 0; }
table { width: 100%; border-collapse: collapse; font-size: 9px; }
th { background: #e2e8f0; font-weight: bold; text-align: left; padding: 3px 6px; border: 1px solid #cbd5e1; }
td { padding: 3px 6px; border: 1px solid #e2e8f0; vertical-align: top; }
.main { background: #f8fafc; font-weight: 500; }
.sub { background: #fff; }
.mono { font-family: monospace; color: #475569; white-space: nowrap; }
.r { text-align: right; }
@media print { body { padding: 8px; } .day-block { page-break-inside: avoid; } }
</style>
</head>
<body>
<h1>Cook-Timeline — ${week}${upliftLabel}</h1>
<div class="meta">Generiert: ${now} · Verden (VF) · ${weekRecipes.length} Rezepte</div>
${bodyContent}
</body></html>`;

  const win = window.open("", "_blank", "width=1000,height=750");
  if (!win) { alert("Bitte Popup-Blocker deaktivieren und erneut versuchen."); return; }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 500);
}
