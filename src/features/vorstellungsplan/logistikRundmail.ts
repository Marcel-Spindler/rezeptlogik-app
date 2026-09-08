import type { KetRow } from "../ket-plan/ketTypes";
import type { CookSchedule, DataBundle, GrossIngredient } from "../../core/types";
import { classifyIstDepartment, istCookingStartDate, sortIstRows, type IstDepartment } from "./istPlanungText";
import { normStr, parseDateShift } from "../ket-plan/ketLogic";
import { orderCookingMethods } from "../ket-plan/woInstructionBot";
import { skuKey } from "../../lib/wmsSkuEnrichment";

function fmtQty(value: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(value);
}

function isDone(row: KetRow): boolean {
  const status = `${row.kitchenStatus} ${row.stagingStatus}`.toLowerCase();
  return status.includes("post blast") || status.includes("done") || status.includes("complete");
}

type IngredientDemand = {
  sku: string;
  name: string;
  uom: string;
  required: number;
  productionDay: string;
  deliveryDay: string | null;
  rows: KetRow[];
};

function isSundayOrMonday(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 1;
}

function shortDate(date: string | null): string {
  if (!date) return "-";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function fullDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit" });
}

function floorToSaturday(date: string | null, scopedRows: KetRow[]): string | null {
  if (!date) return null;
  const firstDate = scopedRows.map(row => parseDateShift(row.dateNeeded).date).filter(Boolean).sort()[0];
  if (!firstDate) return date;
  const saturday = new Date(`${firstDate}T00:00:00Z`);
  saturday.setUTCDate(saturday.getUTCDate() - ((saturday.getUTCDay() + 1) % 7));
  const saturdayKey = saturday.toISOString().slice(0, 10);
  return date < saturdayKey ? saturdayKey : date;
}

function normalizeDemandQuantity(quantity: number, uom: string): { quantity: number; uom: string } {
  const unit = String(uom ?? "").trim().toLowerCase();
  if (/^(g|gram|grams|gramm)$/.test(unit)) return { quantity: quantity / 1000, uom: "kg" };
  if (/^(kg|kilogram|kilograms)$/.test(unit)) return { quantity, uom: "kg" };
  return { quantity, uom: uom || "Stk" };
}

function stripIngredientPrefix(name: string): string {
  return name.replace(/^[A-Z]{2}-[A-Z]{2}\s+/i, "").split("/")[0].trim();
}

function hasSubmealLink(ingredient: GrossIngredient): boolean {
  return !!normStr(`${ingredient.subRecipe1 ?? ""} ${ingredient.subRecipe2 ?? ""} ${ingredient.subRecipe3 ?? ""}`);
}

function grossIngredientsForRow(grossIngredients: GrossIngredient[], row: KetRow): GrossIngredient[] {
  const submeal = normStr(row.subRecipeName);
  return grossIngredients.filter(ingredient => [ingredient.subRecipe1, ingredient.subRecipe2, ingredient.subRecipe3]
    .some(name => normStr(name ?? "") === submeal))
    .concat(grossIngredients.filter(ingredient => !hasSubmealLink(ingredient) && (
      normStr(ingredient.ingredient) === submeal ||
      normStr(stripIngredientPrefix(ingredient.ingredient)) === submeal ||
      skuKey(ingredient.ingredientId) === skuKey(row.subRecipeName)
    )));
}

export function buildSundayMondayFreshDemand(rows: KetRow[], data: DataBundle, cookSchedules: Record<string, CookSchedule> = {}): { productionDays: string[]; scopedRows: KetRow[]; demand: IngredientDemand[]; unmatchedSubmeals: KetRow[] } {
  const scopedRows = rows.filter(row => isSundayOrMonday(parseDateShift(row.dateNeeded).date));
  const productionDays = [...new Set(scopedRows.map(row => parseDateShift(row.dateNeeded).date))].sort();
  const demandBySku = new Map<string, IngredientDemand>();
  const unmatchedSubmeals: KetRow[] = [];
  for (const row of scopedRows) {
    const recipe = data.recipes[row.recipeCode];
    const grossIngredients = recipe?.grossIngredients.DE ?? recipe?.grossIngredients.BENL ?? recipe?.grossIngredients.DKSE ?? [];
    const ingredients = grossIngredientsForRow(grossIngredients, row);
    if (!ingredients.length) {
      unmatchedSubmeals.push(row);
      continue;
    }
    for (const ingredient of ingredients) {
      const directIngredient = !hasSubmealLink(ingredient);
      if (ingredient.ingredientCategory?.trim().toUpperCase() !== "PHF" && !directIngredient) continue;
      const sku = skuKey(ingredient.ingredientId || ingredient.ingredient);
      if (!sku) continue;
      const productionDay = parseDateShift(row.dateNeeded).date;
      const deliveryDay = floorToSaturday(istCookingStartDate(row, cookSchedules), scopedRows);
      const normalized = normalizeDemandQuantity(ingredient.grossQuantityPerPortion * row.targetPortions, ingredient.uom);
      const key = `${productionDay}|${deliveryDay ?? ""}|${sku}|${normalized.uom}`;
      const entry = demandBySku.get(key) ?? { sku, name: ingredient.ingredient || sku, uom: normalized.uom, required: 0, productionDay, deliveryDay, rows: [] };
      entry.required += normalized.quantity;
      if (!entry.rows.some(demandRow => demandRow.key === row.key)) entry.rows.push(row);
      demandBySku.set(key, entry);
    }
  }
  return { productionDays, scopedRows, demand: [...demandBySku.values()], unmatchedSubmeals };
}

function woChain(rows: KetRow[]): string {
  return rows.map(row => row.woNumber).join(" -> ");
}

function firstCookMethod(row: KetRow): string {
  const ordered = orderCookingMethods(row.cookMethods);
  return ordered[0] ?? "—";
}

function kitchenChainWithMethod(rows: KetRow[]): string {
  if (!rows.length) return "-";
  return rows.map(row => `${row.woNumber} ${row.subRecipeName} [${firstCookMethod(row)}]`).join(" -> ");
}

function cookingStartDays(scopedRows: KetRow[], cookSchedules: Record<string, CookSchedule>): string[] {
  const days = new Set<string>();
  for (const row of scopedRows) {
    const start = istCookingStartDate(row, cookSchedules);
    days.add(start ?? parseDateShift(row.dateNeeded).date);
  }
  return [...days].sort();
}

function rowsByStartDay(scopedRows: KetRow[], cookSchedules: Record<string, CookSchedule>): Map<string, KetRow[]> {
  const map = new Map<string, KetRow[]>();
  for (const row of scopedRows) {
    const start = istCookingStartDate(row, cookSchedules) ?? parseDateShift(row.dateNeeded).date;
    const list = map.get(start) ?? [];
    list.push(row);
    map.set(start, list);
  }
  return map;
}

function deptForDemandItem(item: IngredientDemand): IstDepartment {
  const depts = item.rows.map(r => classifyIstDepartment(r));
  return depts.includes("protein") && !depts.includes("veggie") ? "protein" : "veggie";
}

export function buildLogistikRundmailText(
  rows: KetRow[],
  data: DataBundle,
  week: string,
  specialNote: string,
  cookSchedules: Record<string, CookSchedule>,
): string {
  const lines = [
    `Frische-Einkauf ${week}`,
    "",
    "EINKAUF | Sonntag + Montag",
  ];

  const orderedRows = sortIstRows(rows, cookSchedules);
  const { productionDays, scopedRows, demand, unmatchedSubmeals } = buildSundayMondayFreshDemand(rows, data, cookSchedules);
  const purchaseItems = demand
    .map(item => ({ item, dept: deptForDemandItem(item), firstPosition: Math.min(...item.rows.map(row => orderedRows.indexOf(row))) }))
    .sort((a, b) => a.item.productionDay.localeCompare(b.item.productionDay) || (a.item.deliveryDay ?? "").localeCompare(b.item.deliveryDay ?? "") || b.item.required - a.item.required);

  if (scopedRows.length) lines.push(`WOs: ${woChain(sortIstRows(scopedRows, cookSchedules))}`);

  if (!purchaseItems.length) {
    lines.push("Keine Frischeartikel für Sonntag/Montag berechenbar.");
  } else {
    for (const day of productionDays) {
      const dayItems = purchaseItems.filter(({ item }) => item.productionDay === day);
      if (!dayItems.length) continue;
      lines.push("");
      lines.push(`${fullDate(day)}:`);
      for (const dept of ["veggie", "protein"] as const) {
        const label = dept === "protein" ? "  Proteine:" : "  Veggie:";
        const deptItems = dayItems.filter(di => di.dept === dept);
        if (!deptItems.length) continue;
        lines.push(label);
        for (const { item } of deptItems) {
          lines.push(`  - ${fmtQty(item.required)} ${item.uom} | ${item.name} (${item.sku}) | bis ${shortDate(item.deliveryDay)} | WOs ${item.rows.map(row => row.woNumber).join(", ")}`);
        }
      }
    }
    if (unmatchedSubmeals.length) lines.push(`Prüfen: ${unmatchedSubmeals.length} WO${unmatchedSubmeals.length === 1 ? "" : "s"} ohne Rohwarenmatch.`);
  }

  if (specialNote.trim()) {
    lines.push("");
    lines.push("SONDERHINWEIS");
    lines.push(specialNote.trim());
  }

  lines.push("");
  lines.push("KÜCHE | Reihenfolge");
  const startDayMap = rowsByStartDay(scopedRows, cookSchedules);
  const startDays = cookingStartDays(scopedRows, cookSchedules);
  for (const day of startDays) {
    const dayRows = sortIstRows(startDayMap.get(day) ?? [], cookSchedules).filter(row => !isDone(row));
    if (!dayRows.length) continue;
    lines.push("");
    lines.push(`${fullDate(day)} (Kochstart):`);
    for (const department of ["veggie", "protein"] as const) {
      const label = department === "protein" ? "Proteine" : "Veggie";
      lines.push(`${label}: ${kitchenChainWithMethod(dayRows.filter(row => classifyIstDepartment(row) === department))}`);
    }
  }

  return lines.join("\n");
}

// ─── HTML-Version mit Collapsible Einkauf + grafischen Chips ─────────────────

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function esc(s: string): string { return s.replace(/[&<>"]/g, c => ESC[c] ?? c); }

const DEPT_COLORS: Record<IstDepartment, { bg: string; text: string; border: string; accent: string }> = {
  veggie:  { bg: "#ecfdf5", text: "#065f46", border: "#6ee7b7", accent: "#10b981" },
  protein: { bg: "#fef2f2", text: "#991b1b", border: "#fca5a5", accent: "#ef4444" },
};
const DEPT_LABEL: Record<IstDepartment, string> = { veggie: "Veggie", protein: "Proteine" };

function deptChip(dept: IstDepartment): string {
  const c = DEPT_COLORS[dept];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:700;background:${c.bg};color:${c.text};border:1px solid ${c.border}">${DEPT_LABEL[dept]}</span>`;
}

function methodChip(method: string): string {
  return `<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;background:#ede9fe;color:#5b21b6;border:1px solid #c4b5fd">${esc(method)}</span>`;
}

export function buildLogistikRundmailHtml(
  rows: KetRow[],
  data: DataBundle,
  week: string,
  specialNote: string,
  cookSchedules: Record<string, CookSchedule>,
): string {
  const orderedRows = sortIstRows(rows, cookSchedules);
  const { productionDays, scopedRows, demand, unmatchedSubmeals } = buildSundayMondayFreshDemand(rows, data, cookSchedules);
  const purchaseItems = demand
    .map(item => ({ item, dept: deptForDemandItem(item), firstPosition: Math.min(...item.rows.map(row => orderedRows.indexOf(row))) }))
    .sort((a, b) => a.item.productionDay.localeCompare(b.item.productionDay) || (a.item.deliveryDay ?? "").localeCompare(b.item.deliveryDay ?? "") || b.item.required - a.item.required);

  const h: string[] = [];
  h.push(`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:700px;margin:0 auto">`);
  h.push(`<h2 style="margin:0 0 4px;font-size:18px;color:#1e293b">Frische-Einkauf ${esc(week)}</h2>`);
  h.push(`<p style="margin:0 0 12px;font-size:12px;color:#64748b">Sonntag + Montag · ${scopedRows.length} WOs</p>`);

  // ── EINKAUF ───
  h.push(`<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 16px;margin-bottom:12px">`);
  h.push(`<h3 style="margin:0 0 8px;font-size:14px;color:#334155;letter-spacing:0.5px">EINKAUF</h3>`);

  if (!purchaseItems.length) {
    h.push(`<p style="color:#94a3b8;font-size:12px">Keine Frischeartikel für Sonntag/Montag berechenbar.</p>`);
  } else {
    for (const day of productionDays) {
      const dayItems = purchaseItems.filter(({ item }) => item.productionDay === day);
      if (!dayItems.length) continue;

      for (const dept of ["veggie", "protein"] as const) {
        const deptItems = dayItems.filter(di => di.dept === dept);
        if (!deptItems.length) continue;
        const c = DEPT_COLORS[dept];
        h.push(`<details style="margin-bottom:8px" open>`);
        h.push(`<summary style="cursor:pointer;font-size:13px;font-weight:700;color:#1e293b;padding:6px 0;user-select:none">${esc(fullDate(day))} · ${deptChip(dept)} · ${deptItems.length} Artikel</summary>`);
        h.push(`<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:4px">`);
        h.push(`<thead><tr style="background:${c.bg}"><th style="text-align:left;padding:4px 8px;border-bottom:1px solid ${c.border};font-weight:700;color:${c.text}">Artikel</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid ${c.border};font-weight:700;color:${c.text}">Menge</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid ${c.border};font-weight:700;color:${c.text}">bis</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid ${c.border};font-weight:700;color:${c.text}">WOs</th></tr></thead>`);
        h.push(`<tbody>`);
        for (const { item } of deptItems) {
          h.push(`<tr style="border-bottom:1px solid #f1f5f9"><td style="padding:4px 8px;color:#334155">${esc(item.name)}<br><span style="color:#94a3b8;font-size:10px">${esc(item.sku)}</span></td><td style="padding:4px 8px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap">${fmtQty(item.required)} ${esc(item.uom)}</td><td style="padding:4px 8px;color:#64748b;white-space:nowrap">${esc(shortDate(item.deliveryDay))}</td><td style="padding:4px 8px;color:#64748b">${item.rows.map(row => esc(row.woNumber)).join(", ")}</td></tr>`);
        }
        h.push(`</tbody></table>`);
        h.push(`</details>`);
      }
    }
    if (unmatchedSubmeals.length) {
      h.push(`<p style="font-size:11px;color:#d97706;margin:8px 0 0">⚠ ${unmatchedSubmeals.length} WO${unmatchedSubmeals.length === 1 ? "" : "s"} ohne Rohwarenmatch — bitte prüfen.</p>`);
    }
  }
  h.push(`</div>`);

  // ── SONDERHINWEIS ───
  if (specialNote.trim()) {
    h.push(`<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#92400e"><strong>Sonderhinweis:</strong> ${esc(specialNote.trim())}</div>`);
  }

  // ── KÜCHE ───
  h.push(`<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 16px">`);
  h.push(`<h3 style="margin:0 0 8px;font-size:14px;color:#334155;letter-spacing:0.5px">KÜCHE · Reihenfolge</h3>`);
  const startDayMap = rowsByStartDay(scopedRows, cookSchedules);
  const startDays = cookingStartDays(scopedRows, cookSchedules);
  for (const day of startDays) {
    const dayRows = sortIstRows(startDayMap.get(day) ?? [], cookSchedules).filter(row => !isDone(row));
    if (!dayRows.length) continue;
    h.push(`<div style="margin-bottom:10px">`);
    h.push(`<div style="font-size:13px;font-weight:700;color:#1e293b;margin-bottom:4px">${esc(fullDate(day))} <span style="font-weight:400;color:#64748b;font-size:11px">(Kochstart)</span></div>`);
    for (const department of ["veggie", "protein"] as const) {
      const deptRows = dayRows.filter(row => classifyIstDepartment(row) === department);
      if (!deptRows.length) continue;
      h.push(`<div style="margin:4px 0 6px;padding:6px 10px;border-radius:8px;border-left:3px solid ${DEPT_COLORS[department].accent};background:${DEPT_COLORS[department].bg}">`);
      h.push(`<div style="font-size:11px;font-weight:700;color:${DEPT_COLORS[department].text};margin-bottom:3px">${DEPT_LABEL[department]}</div>`);
      for (const row of deptRows) {
        h.push(`<div style="font-size:11px;color:#334155;padding:1px 0">${esc(row.woNumber)} <strong>${esc(row.subRecipeName)}</strong> ${methodChip(firstCookMethod(row))}</div>`);
      }
      h.push(`</div>`);
    }
    h.push(`</div>`);
  }
  h.push(`</div>`);

  h.push(`</div>`);
  return h.join("\n");
}
