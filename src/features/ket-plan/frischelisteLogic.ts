// Frischeliste – nur PHF-Zutaten aus den WOs des ausgewählten Tages-Sets,
// aufgeteilt in Veggie Debox / Protein Debox, gruppiert nach Mahlzeit + PTN.
import type { KetRow, BatchCalc, IngCalc } from "./ketTypes";
import { classifyDeboxDepartment, parseDateShift } from "./ketLogic";

// ── Einkauf-Ansicht: Gesamtmengen je Zutat (kein Meal-Grouping) ─────────────

export interface FrischeIngredientTotal {
  name: string;
  id: string;
  totalKg: number;
  woCount: number;
}

export interface FrischelisteEinkauf {
  veggie: FrischeIngredientTotal[];
  protein: FrischeIngredientTotal[];
  totalVeggieKg: number;
  totalProteinKg: number;
}

export function buildFrischelisteEinkauf(
  ketRows: KetRow[],
  calcMap: Map<string, BatchCalc>,
  selectedWeekdays: number[],
): FrischelisteEinkauf {
  const selectedSet = new Set(selectedWeekdays);
  type IngBuf = Map<string, { name: string; id: string; totalKg: number; wos: Set<string> }>;
  const veggieBuf: IngBuf = new Map();
  const proteinBuf: IngBuf = new Map();

  for (const row of ketRows) {
    const { date } = parseDateShift(row.dateNeeded);
    if (!date) continue;
    const weekday = parseWeekday(date);
    if (!selectedSet.has(weekday)) continue;

    const calc = calcMap.get(row.key);
    if (!calc) continue;
    const dept = classifyDeboxDepartment(calc);
    if (!dept) continue;

    const buf = dept === "protein" ? proteinBuf : veggieBuf;
    const allIngs: IngCalc[] =
      calc.components.length > 0
        ? calc.components.flatMap((c) => c.ingredients)
        : calc.ingredients;

    for (const ing of allIngs) {
      if (!isPhf(ing.category)) continue;
      if (ing.totalKg <= 0) continue;
      const ingKey = ing.name.trim().toLowerCase();
      const existing = buf.get(ingKey);
      if (existing) {
        existing.totalKg += ing.totalKg;
        existing.wos.add(row.woNumber);
      } else {
        buf.set(ingKey, { name: ing.name, id: ing.id, totalKg: ing.totalKg, wos: new Set([row.woNumber]) });
      }
    }
  }

  function toTotals(buf: IngBuf): FrischeIngredientTotal[] {
    return [...buf.values()]
      .map((v) => ({ name: v.name, id: v.id, totalKg: v.totalKg, woCount: v.wos.size }))
      .sort((a, b) => b.totalKg - a.totalKg);
  }

  const veggie = toTotals(veggieBuf);
  const protein = toTotals(proteinBuf);
  return { veggie, protein, totalVeggieKg: veggie.reduce((s, i) => s + i.totalKg, 0), totalProteinKg: protein.reduce((s, i) => s + i.totalKg, 0) };
}

// ── Middle Kitchen – Spezial-Artikel (WOs ohne Komponenten, ganze KW) ────────

export interface SpezialArtikelSummary {
  veggie: FrischeIngredientTotal[];
  protein: FrischeIngredientTotal[];
  totalVeggieKg: number;
  totalProteinKg: number;
}

export function buildSpezialArtikelWeek(
  targetWeekRows: KetRow[],
  calcMap: Map<string, BatchCalc>,
): SpezialArtikelSummary {
  type IngBuf = Map<string, { name: string; id: string; totalKg: number; wos: Set<string> }>;
  const veggieBuf: IngBuf = new Map();
  const proteinBuf: IngBuf = new Map();

  for (const row of targetWeekRows) {
    const calc = calcMap.get(row.key);
    if (!calc) continue;
    const dept = classifyDeboxDepartment(calc);
    if (!dept) continue;

    const buf = dept === "protein" ? proteinBuf : veggieBuf;
    // Alle PHF-Zutaten aus dem WO – egal ob mit oder ohne Komponenten
    const allIngs: IngCalc[] =
      calc.components.length > 0
        ? calc.components.flatMap((c) => c.ingredients)
        : calc.ingredients;

    for (const ing of allIngs) {
      if (!isPhf(ing.category)) continue;
      if (ing.totalKg <= 0) continue;
      const ingKey = ing.name.trim().toLowerCase();
      const existing = buf.get(ingKey);
      if (existing) {
        existing.totalKg += ing.totalKg;
        existing.wos.add(row.woNumber);
      } else {
        buf.set(ingKey, { name: ing.name, id: ing.id, totalKg: ing.totalKg, wos: new Set([row.woNumber]) });
      }
    }
  }

  function toTotals(buf: IngBuf): FrischeIngredientTotal[] {
    return [...buf.values()]
      .map((v) => ({ name: v.name, id: v.id, totalKg: v.totalKg, woCount: v.wos.size }))
      .sort((a, b) => b.totalKg - a.totalKg);
  }

  const veggie = toTotals(veggieBuf);
  const protein = toTotals(proteinBuf);
  return { veggie, protein, totalVeggieKg: veggie.reduce((s, i) => s + i.totalKg, 0), totalProteinKg: protein.reduce((s, i) => s + i.totalKg, 0) };
}

export interface FrischeItem {
  name: string;
  id: string;
  totalKg: number;
  category: string;
  woNumbers: string[];
}

export interface FrischeMealComponent {
  componentName: string;
  items: FrischeItem[];
  totalKg: number;
}

export interface FrischeMealGroup {
  mealName: string;
  portions: number;
  woNumbers: string[];
  // Zutaten direkt an der WO (nur wenn keine Komponenten vorhanden)
  items: FrischeItem[];
  // Pro Sub-Rezept-Komponente (wenn WO zusammengesetzt ist)
  components: FrischeMealComponent[];
  totalKg: number;
}

export interface FrischeDay {
  label: string; // "Mo 14.09."
  date: string;  // "2026-09-14"
  weekday: number; // 0=So, 1=Mo, …
}

export interface Frischeliste {
  veggie: FrischeMealGroup[];
  protein: FrischeMealGroup[];
  availableDays: FrischeDay[];
}

function isPhf(category: string): boolean {
  return (category ?? "").toUpperCase().trim() === "PHF";
}

function parseWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

type IngBuf = Map<string, { name: string; id: string; totalKg: number; category: string; wos: Set<string> }>;
type CompBuf = Map<string, { name: string; ings: IngBuf }>;
type MealBuf = Map<string, { mealName: string; portions: number; wos: Set<string>; ings: IngBuf; compBuf: CompBuf }>;

function accumulateIng(buf: IngBuf, ing: IngCalc, woNumber: string) {
  const ingKey = ing.name.trim().toLowerCase();
  const existing = buf.get(ingKey);
  if (existing) {
    existing.totalKg += ing.totalKg;
    existing.wos.add(woNumber);
  } else {
    buf.set(ingKey, { name: ing.name, id: ing.id, totalKg: ing.totalKg, category: ing.category, wos: new Set([woNumber]) });
  }
}

function ingBufToItems(buf: IngBuf): FrischeItem[] {
  return [...buf.values()]
    .map((v) => ({ name: v.name, id: v.id, totalKg: v.totalKg, category: v.category, woNumbers: [...v.wos].sort() }))
    .sort((a, b) => b.totalKg - a.totalKg);
}

export function buildFrischeliste(
  ketRows: KetRow[],
  calcMap: Map<string, BatchCalc>,
  selectedWeekdays: number[],
): Frischeliste {
  const selectedSet = new Set(selectedWeekdays);
  const dayMap = new Map<number, FrischeDay>();

  const veggieBuf: MealBuf = new Map();
  const proteinBuf: MealBuf = new Map();

  for (const row of ketRows) {
    const { date } = parseDateShift(row.dateNeeded);
    if (!date) continue;
    const weekday = parseWeekday(date);

    if (!dayMap.has(weekday)) {
      const d = new Date(date + "T12:00:00");
      const label = d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
      dayMap.set(weekday, { label, date, weekday });
    }

    if (!selectedSet.has(weekday)) continue;

    const calc = calcMap.get(row.key);
    if (!calc) continue;

    const dept = classifyDeboxDepartment(calc);
    if (!dept) continue;

    const buf = dept === "protein" ? proteinBuf : veggieBuf;
    const rawName = (row.recipeName || row.woNumber || "Unbekannt").trim();
    const portions = row.targetPortions ?? 0;
    const mealKey = `${rawName.toLowerCase()}__${portions}`;

    if (!buf.has(mealKey)) {
      buf.set(mealKey, { mealName: rawName, portions, wos: new Set(), ings: new Map(), compBuf: new Map() });
    }
    const mealEntry = buf.get(mealKey)!;
    mealEntry.wos.add(row.woNumber);

    if (calc.components.length > 0) {
      // Zusammengesetztes WO: jede Komponente separat führen
      for (const comp of calc.components) {
        const compKey = comp.name.trim().toLowerCase();
        if (!mealEntry.compBuf.has(compKey)) {
          mealEntry.compBuf.set(compKey, { name: comp.name, ings: new Map() });
        }
        const compEntry = mealEntry.compBuf.get(compKey)!;
        for (const ing of comp.ingredients) {
          if (!isPhf(ing.category) || ing.totalKg <= 0) continue;
          accumulateIng(compEntry.ings, ing, row.woNumber);
        }
      }
    } else {
      // Einfaches WO: Zutaten direkt
      for (const ing of calc.ingredients) {
        if (!isPhf(ing.category) || ing.totalKg <= 0) continue;
        accumulateIng(mealEntry.ings, ing, row.woNumber);
      }
    }
  }

  function toMealGroups(buf: MealBuf): FrischeMealGroup[] {
    return [...buf.values()]
      .map((m) => {
        const items = ingBufToItems(m.ings);
        const components: FrischeMealComponent[] = [...m.compBuf.values()]
          .map((cb) => {
            const compItems = ingBufToItems(cb.ings);
            return { componentName: cb.name, items: compItems, totalKg: compItems.reduce((s, i) => s + i.totalKg, 0) };
          })
          .filter((c) => c.items.length > 0)
          .sort((a, b) => b.totalKg - a.totalKg);
        const totalKg = components.length > 0
          ? components.reduce((s, c) => s + c.totalKg, 0)
          : items.reduce((s, i) => s + i.totalKg, 0);
        if (totalKg <= 0) return null;
        return { mealName: m.mealName, portions: m.portions, woNumbers: [...m.wos].sort(), items, components, totalKg };
      })
      .filter((g): g is FrischeMealGroup => g !== null)
      .sort((a, b) => b.totalKg - a.totalKg);
  }

  const availableDays = [...dayMap.values()].sort((a, b) => {
    const order = (d: number) => (d === 0 ? 7 : d);
    return order(a.weekday) - order(b.weekday);
  });

  return {
    veggie: toMealGroups(veggieBuf),
    protein: toMealGroups(proteinBuf),
    availableDays,
  };
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function sortedByPtn(groups: FrischeMealGroup[]): FrischeMealGroup[] {
  return [...groups].sort((a, b) => a.portions - b.portions || b.totalKg - a.totalKg);
}

// ── Export helpers ──────────────────────────────────────────────────────────

function q(s: string) { return `"${s.replace(/"/g, '""')}"`; }

function groupCsvRows(g: FrischeMealGroup, dept: string): string[] {
  const rows: string[] = [];
  if (g.components.length > 0) {
    for (const comp of g.components) {
      for (const item of comp.items) {
        rows.push(`${dept},${g.portions},${q(g.mealName)},${q(comp.componentName)},${q(item.name)},${item.totalKg.toFixed(2)}`);
      }
    }
  } else {
    for (const item of g.items) {
      rows.push(`${dept},${g.portions},${q(g.mealName)},,${q(item.name)},${item.totalKg.toFixed(2)}`);
    }
  }
  return rows;
}

export function frischelisteToCsvString(
  liste: Frischeliste,
  weekLabel: string,
  dayLabel: string,
): string {
  const lines: string[] = [
    `# PHF-Frischeliste ${weekLabel} – ${dayLabel}`,
    "Abteilung,PTN,Mahlzeit,Komponente,Artikel,Menge (kg)",
  ];
  for (const g of liste.protein) lines.push(...groupCsvRows(g, "Protein Debox"));
  for (const g of liste.veggie) lines.push(...groupCsvRows(g, "Veggie Debox"));
  return lines.join("\n");
}

export function frischelisteToCsvStringByPtn(
  liste: Frischeliste,
  weekLabel: string,
  dayLabel: string,
): string {
  const lines: string[] = [
    `# PHF-Frischeliste ${weekLabel} – ${dayLabel} – nach PTN`,
    "Abteilung,PTN,Mahlzeit,Komponente,Artikel,Menge (kg)",
  ];
  for (const g of sortedByPtn(liste.protein)) lines.push(...groupCsvRows(g, "Protein Debox"));
  for (const g of sortedByPtn(liste.veggie)) lines.push(...groupCsvRows(g, "Veggie Debox"));
  return lines.join("\n");
}

export function buildFrischelistePdfHtmlByPtn(
  liste: Frischeliste,
  weekLabel: string,
  dayLabel: string,
): string {
  const COLORS = [
    { header: "#eff6ff", border: "#bfdbfe", text: "#1e40af" },
    { header: "#f0fdf4", border: "#bbf7d0", text: "#166534" },
    { header: "#fdf4ff", border: "#e9d5ff", text: "#6b21a8" },
    { header: "#fffbeb", border: "#fde68a", text: "#92400e" },
    { header: "#fff1f2", border: "#fecdd3", text: "#9f1239" },
    { header: "#f0fdfa", border: "#99f6e4", text: "#134e4a" },
  ];

  function ingTableHtml(items: FrischeItem[], border: string): string {
    return `<table style="width:100%;border-collapse:collapse;font-size:11px;border:1px solid ${border};border-top:none;">
      <tbody>
        ${items.map((item, j) => `
          <tr style="background:${j % 2 === 0 ? "#fff" : "#f8fafc"};">
            <td style="padding:4px 8px;border-bottom:1px solid #f1f5f9;">${item.name}</td>
            <td style="text-align:right;padding:4px 8px;border-bottom:1px solid #f1f5f9;font-weight:700;font-variant-numeric:tabular-nums;">${item.totalKg.toFixed(2)} kg</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
  }

  function mealBodyHtml(g: FrischeMealGroup, c: { header: string; border: string; text: string }): string {
    if (g.components.length > 0) {
      return g.components.map((comp) => `
        <div style="margin-bottom:4px;">
          <div style="background:#f1f5f9;border:1px solid ${c.border};border-bottom:none;padding:3px 8px;display:flex;justify-content:space-between;">
            <span style="font-size:9px;font-weight:700;color:#475569;">${comp.componentName}</span>
            <span style="font-size:9px;font-weight:600;color:#64748b;">${comp.totalKg.toFixed(1)} kg</span>
          </div>
          ${ingTableHtml(comp.items, c.border)}
        </div>`).join("");
    }
    return ingTableHtml(g.items, c.border);
  }

  function ptnSectionsHtml(groups: FrischeMealGroup[]): string {
    if (!groups.length) return `<p style="color:#94a3b8;font-size:11px;padding:8px 0;">Keine PHF-Frischware für diese Auswahl.</p>`;
    const sorted = sortedByPtn(groups);
    const byPtn = new Map<number, FrischeMealGroup[]>();
    for (const g of sorted) {
      if (!byPtn.has(g.portions)) byPtn.set(g.portions, []);
      byPtn.get(g.portions)!.push(g);
    }
    let colorIdx = 0;
    return [...byPtn.entries()].map(([ptn, ptnGroups]) => {
      const ptnTotal = ptnGroups.reduce((s, g) => s + g.totalKg, 0);
      const mealsHtml = ptnGroups.map((g) => {
        const c = COLORS[colorIdx % COLORS.length];
        colorIdx++;
        return `
        <div style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;background:${c.header};border:1px solid ${c.border};border-bottom:none;border-radius:6px 6px 0 0;padding:4px 8px;">
            <span style="font-size:10px;font-weight:800;color:${c.text};">${g.mealName}</span>
            <span style="font-size:9px;font-weight:700;color:${c.text};opacity:.8;">${g.totalKg.toFixed(1)} kg</span>
          </div>
          ${mealBodyHtml(g, c)}
        </div>`;
      }).join("");
      return `
      <div style="margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;background:#1e3a5f;color:#fff;border-radius:6px;padding:5px 10px;margin-bottom:8px;">
          <span style="font-size:11px;font-weight:900;">${ptn} Portionen</span>
          <span style="font-size:9px;font-weight:700;opacity:.8;">${ptnGroups.length} Mahlzeiten · ${ptnTotal.toFixed(1)} kg</span>
        </div>
        ${mealsHtml}
      </div>`;
    }).join("");
  }

  const totalProtein = liste.protein.reduce((s, g) => s + g.totalKg, 0);
  const totalVeggie  = liste.veggie.reduce((s, g) => s + g.totalKg, 0);

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>PHF-Frischeliste PTN ${weekLabel}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Arial, sans-serif; margin: 0; padding: 16px 20px; color: #0f172a; }
  h1 { font-size: 18px; font-weight: 900; margin: 0 0 2px; color: #0f2240; }
  .subtitle { font-size: 10px; color: #64748b; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .section-title { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; padding: 6px 8px; margin: 0 0 8px; border-radius: 6px; display: flex; justify-content: space-between; }
  .protein-title { background: #fef2f2; color: #991b1b; }
  .veggie-title  { background: #f0fdf4; color: #166534; }
  @media print { body { padding: 8px 12px; } }
</style>
</head>
<body>
  <h1>PHF-Frischeliste – nach PTN – ${weekLabel}</h1>
  <div class="subtitle">Tage: ${dayLabel} · Erstellt: ${new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}</div>
  <div class="grid">
    <div>
      <div class="section-title protein-title">
        <span>🥩 Protein Debox (${liste.protein.length} Mahlzeiten)</span>
        <span>${totalProtein.toFixed(1)} kg</span>
      </div>
      ${ptnSectionsHtml(liste.protein)}
    </div>
    <div>
      <div class="section-title veggie-title">
        <span>🥦 Veggie Debox (${liste.veggie.length} Mahlzeiten)</span>
        <span>${totalVeggie.toFixed(1)} kg</span>
      </div>
      ${ptnSectionsHtml(liste.veggie)}
    </div>
  </div>
</body>
</html>`;
}

export function buildFrischelistePdfHtml(
  liste: Frischeliste,
  weekLabel: string,
  dayLabel: string,
): string {
  const COLORS = [
    { header: "#eff6ff", border: "#bfdbfe", text: "#1e40af" },
    { header: "#f0fdf4", border: "#bbf7d0", text: "#166534" },
    { header: "#fdf4ff", border: "#e9d5ff", text: "#6b21a8" },
    { header: "#fffbeb", border: "#fde68a", text: "#92400e" },
    { header: "#fff1f2", border: "#fecdd3", text: "#9f1239" },
    { header: "#f0fdfa", border: "#99f6e4", text: "#134e4a" },
  ];

  function mealGroupsHtml(groups: FrischeMealGroup[]): string {
    if (!groups.length) return `<p style="color:#94a3b8;font-size:11px;padding:8px 0;">Keine PHF-Frischware für diese Auswahl.</p>`;
    return groups.map((g, i) => {
      const c = COLORS[i % COLORS.length];
      const bodyHtml = g.components.length > 0
        ? g.components.map((comp) => `
          <div style="margin-bottom:4px;">
            <div style="background:#f1f5f9;border:1px solid ${c.border};border-bottom:none;padding:3px 8px;display:flex;justify-content:space-between;">
              <span style="font-size:9px;font-weight:700;color:#475569;">${comp.componentName}</span>
              <span style="font-size:9px;color:#64748b;">${comp.totalKg.toFixed(1)} kg</span>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:11px;border:1px solid ${c.border};border-top:none;">
              <tbody>
                ${comp.items.map((item, j) => `
                  <tr style="background:${j % 2 === 0 ? "#fff" : "#f8fafc"};">
                    <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;">${item.name}</td>
                    <td style="text-align:right;padding:5px 8px;border-bottom:1px solid #f1f5f9;font-weight:700;font-variant-numeric:tabular-nums;">${item.totalKg.toFixed(2)} kg</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>`).join("")
        : `<table style="width:100%;border-collapse:collapse;font-size:11px;border:1px solid ${c.border};border-top:none;">
            <tbody>
              ${g.items.map((item, j) => `
                <tr style="background:${j % 2 === 0 ? "#fff" : "#f8fafc"};">
                  <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;">${item.name}</td>
                  <td style="text-align:right;padding:5px 8px;border-bottom:1px solid #f1f5f9;font-weight:700;font-variant-numeric:tabular-nums;">${item.totalKg.toFixed(2)} kg</td>
                </tr>`).join("")}
            </tbody>
          </table>`;
      return `
      <div style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;background:${c.header};border:1px solid ${c.border};border-bottom:none;border-radius:6px 6px 0 0;padding:5px 8px;">
          <span style="font-size:10px;font-weight:800;color:${c.text};">${g.mealName}</span>
          <span style="font-size:9px;font-weight:700;color:${c.text};opacity:.8;">${g.portions > 0 ? g.portions + " PTN · " : ""}${g.totalKg.toFixed(1)} kg</span>
        </div>
        ${bodyHtml}
      </div>`;
    }).join("");
  }

  const totalProtein = liste.protein.reduce((s, g) => s + g.totalKg, 0);
  const totalVeggie  = liste.veggie.reduce((s, g) => s + g.totalKg, 0);

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>PHF-Frischeliste ${weekLabel}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Arial, sans-serif; margin: 0; padding: 16px 20px; color: #0f172a; }
  h1 { font-size: 18px; font-weight: 900; margin: 0 0 2px; color: #0f2240; }
  .subtitle { font-size: 10px; color: #64748b; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .section-title { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; padding: 6px 8px; margin: 0 0 8px; border-radius: 6px; display: flex; justify-content: space-between; }
  .protein-title { background: #fef2f2; color: #991b1b; }
  .veggie-title  { background: #f0fdf4; color: #166534; }
  @media print { body { padding: 8px 12px; } }
</style>
</head>
<body>
  <h1>PHF-Frischeliste ${weekLabel}</h1>
  <div class="subtitle">Tage: ${dayLabel} · Erstellt: ${new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}</div>
  <div class="grid">
    <div>
      <div class="section-title protein-title">
        <span>🥩 Protein Debox (${liste.protein.length} Mahlzeiten)</span>
        <span>${totalProtein.toFixed(1)} kg</span>
      </div>
      ${mealGroupsHtml(liste.protein)}
    </div>
    <div>
      <div class="section-title veggie-title">
        <span>🥦 Veggie Debox (${liste.veggie.length} Mahlzeiten)</span>
        <span>${totalVeggie.toFixed(1)} kg</span>
      </div>
      ${mealGroupsHtml(liste.veggie)}
    </div>
  </div>
</body>
</html>`;
}
