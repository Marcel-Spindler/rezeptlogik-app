// Frischeliste – nur PHF-Zutaten aus den WOs des ausgewählten Tages-Sets,
// aufgeteilt in Veggie Debox / Protein Debox, gruppiert nach Mahlzeit + PTN.
import type { KetRow, BatchCalc, IngCalc } from "./ketTypes";
import { classifyDeboxDepartment, parseDateShift } from "./ketLogic";

export interface FrischeItem {
  name: string;
  id: string;
  totalKg: number;
  category: string;
  woNumbers: string[];
}

export interface FrischeMealGroup {
  mealName: string;
  portions: number;
  woNumbers: string[];
  items: FrischeItem[];
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
type MealBuf = Map<string, { mealName: string; portions: number; wos: Set<string>; ings: IngBuf }>;

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
    // Separate grouping for same recipe at different portion counts
    const mealKey = `${rawName.toLowerCase()}__${portions}`;

    if (!buf.has(mealKey)) {
      buf.set(mealKey, { mealName: rawName, portions, wos: new Set(), ings: new Map() });
    }
    const mealEntry = buf.get(mealKey)!;
    mealEntry.wos.add(row.woNumber);

    const allIngs: IngCalc[] =
      calc.components.length > 0
        ? calc.components.flatMap((c) => c.ingredients)
        : calc.ingredients;

    for (const ing of allIngs) {
      if (!isPhf(ing.category)) continue;
      if (ing.totalKg <= 0) continue;

      const ingKey = ing.name.trim().toLowerCase();
      const existing = mealEntry.ings.get(ingKey);
      if (existing) {
        existing.totalKg += ing.totalKg;
        existing.wos.add(row.woNumber);
      } else {
        mealEntry.ings.set(ingKey, {
          name: ing.name,
          id: ing.id,
          totalKg: ing.totalKg,
          category: ing.category,
          wos: new Set([row.woNumber]),
        });
      }
    }
  }

  function toMealGroups(buf: MealBuf): FrischeMealGroup[] {
    return [...buf.values()]
      .map((m) => {
        const items = [...m.ings.values()]
          .map((v) => ({ name: v.name, id: v.id, totalKg: v.totalKg, category: v.category, woNumbers: [...v.wos].sort() }))
          .sort((a, b) => b.totalKg - a.totalKg);
        const totalKg = items.reduce((s, i) => s + i.totalKg, 0);
        return { mealName: m.mealName, portions: m.portions, woNumbers: [...m.wos].sort(), items, totalKg };
      })
      .filter((g) => g.items.length > 0)
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

// ── Export helpers ──────────────────────────────────────────────────────────

export function frischelisteToCsvString(
  liste: Frischeliste,
  weekLabel: string,
  dayLabel: string,
): string {
  const lines: string[] = [
    `# PHF-Frischeliste ${weekLabel} – ${dayLabel}`,
    "Abteilung,PTN,Mahlzeit,Artikel,Menge (kg)",
  ];

  function addGroup(groups: FrischeMealGroup[], dept: string) {
    for (const g of groups) {
      for (const item of g.items) {
        lines.push(`${dept},${g.portions},"${g.mealName.replace(/"/g, '""')}","${item.name.replace(/"/g, '""')}",${item.totalKg.toFixed(2)}`);
      }
    }
  }

  addGroup(liste.protein, "Protein Debox");
  addGroup(liste.veggie, "Veggie Debox");
  return lines.join("\n");
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
      return `
      <div style="margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;background:${c.header};border:1px solid ${c.border};border-bottom:none;border-radius:6px 6px 0 0;padding:5px 8px;">
          <span style="font-size:10px;font-weight:800;color:${c.text};">${g.mealName}</span>
          <span style="font-size:9px;font-weight:700;color:${c.text};opacity:.8;">${g.portions > 0 ? g.portions + " PTN · " : ""}${g.totalKg.toFixed(1)} kg</span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:11px;border:1px solid ${c.border};border-top:none;border-radius:0 0 6px 6px;overflow:hidden;">
          <tbody>
            ${g.items.map((item, j) => `
              <tr style="background:${j % 2 === 0 ? "#fff" : "#f8fafc"};">
                <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;">${item.name}</td>
                <td style="text-align:right;padding:5px 8px;border-bottom:1px solid #f1f5f9;font-weight:700;font-variant-numeric:tabular-nums;">${item.totalKg.toFixed(2)} kg</td>
              </tr>`).join("")}
          </tbody>
        </table>
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
