// Frischeliste – aggregiert frische Zutaten (alles außer DRY/SPI) aus den
// WOs des ausgewählten Tages-Sets, aufgeteilt in Veggie Debox / Protein Debox.
import type { KetRow, BatchCalc, IngCalc } from "./ketTypes";
import { classifyDeboxDepartment, parseDateShift } from "./ketLogic";

export interface FrischeItem {
  name: string;
  id: string;
  totalKg: number;
  category: string;
  woNumbers: string[];
}

export interface FrischeDay {
  label: string; // "Mo 14.09."
  date: string;  // "2026-09-14"
  weekday: number; // 0=So, 1=Mo, …
}

export interface Frischeliste {
  veggie: FrischeItem[];
  protein: FrischeItem[];
  availableDays: FrischeDay[];
}

function isFrisch(category: string): boolean {
  const c = (category ?? "").toUpperCase().trim();
  return c !== "DRY" && c !== "SPI";
}

function parseWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

export function buildFrischeliste(
  ketRows: KetRow[],
  calcMap: Map<string, BatchCalc>,
  selectedWeekdays: number[],
): Frischeliste {
  const selectedSet = new Set(selectedWeekdays);
  const dayMap = new Map<number, FrischeDay>();

  const veggieBuf = new Map<string, { name: string; id: string; totalKg: number; category: string; wos: Set<string> }>();
  const proteinBuf = new Map<string, { name: string; id: string; totalKg: number; category: string; wos: Set<string> }>();

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

    const allIngs: IngCalc[] =
      calc.components.length > 0
        ? calc.components.flatMap((c) => c.ingredients)
        : calc.ingredients;

    for (const ing of allIngs) {
      if (!isFrisch(ing.category)) continue;
      if (ing.totalKg <= 0) continue;

      const key = ing.name.trim().toLowerCase();
      const existing = buf.get(key);
      if (existing) {
        existing.totalKg += ing.totalKg;
        existing.wos.add(row.woNumber);
      } else {
        buf.set(key, {
          name: ing.name,
          id: ing.id,
          totalKg: ing.totalKg,
          category: ing.category,
          wos: new Set([row.woNumber]),
        });
      }
    }
  }

  function toItems(
    buf: Map<string, { name: string; id: string; totalKg: number; category: string; wos: Set<string> }>,
  ): FrischeItem[] {
    return [...buf.values()]
      .map((v) => ({ name: v.name, id: v.id, totalKg: v.totalKg, category: v.category, woNumbers: [...v.wos].sort() }))
      .sort((a, b) => b.totalKg - a.totalKg);
  }

  const availableDays = [...dayMap.values()].sort((a, b) => {
    // Sort Mon–Sat first, then Sun at the end (German work-week feel)
    const order = (d: number) => (d === 0 ? 7 : d);
    return order(a.weekday) - order(b.weekday);
  });

  return {
    veggie: toItems(veggieBuf),
    protein: toItems(proteinBuf),
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
    `# Frischeliste ${weekLabel} – ${dayLabel}`,
    "Abteilung,Artikel,Kategorie,Menge (kg)",
  ];
  for (const item of liste.protein) {
    lines.push(`Protein Debox,"${item.name.replace(/"/g, '""')}",${item.category || "–"},${item.totalKg.toFixed(2)}`);
  }
  for (const item of liste.veggie) {
    lines.push(`Veggie Debox,"${item.name.replace(/"/g, '""')}",${item.category || "–"},${item.totalKg.toFixed(2)}`);
  }
  return lines.join("\n");
}

export function buildFrischelistePdfHtml(
  liste: Frischeliste,
  weekLabel: string,
  dayLabel: string,
): string {
  function catBadge(cat: string): string {
    const c = (cat ?? "").toUpperCase();
    const colors: Record<string, string> = {
      PHF: "#1d4ed8",
      PRO: "#b91c1c",
      DAI: "#0e7490",
    };
    const color = colors[c] ?? "#475569";
    if (!c) return "";
    return `<span style="font-size:9px;font-weight:700;color:#fff;background:${color};border-radius:4px;padding:1px 5px;margin-left:6px;">${c}</span>`;
  }

  function tableHtml(items: FrischeItem[]): string {
    if (!items.length) return `<p style="color:#94a3b8;font-size:11px;padding:8px 0;">Keine Frischware für diese Auswahl.</p>`;
    return `
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Artikel</th>
            <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;">Menge (kg)</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item, i) => `
            <tr style="background:${i % 2 === 0 ? "#fff" : "#f8fafc"};">
              <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;">${item.name}${catBadge(item.category)}</td>
              <td style="text-align:right;padding:6px 8px;border-bottom:1px solid #f1f5f9;font-weight:700;font-variant-numeric:tabular-nums;">${item.totalKg.toFixed(2)}</td>
            </tr>`).join("")}
          <tr style="background:#f0f9ff;">
            <td style="padding:6px 8px;font-weight:700;font-size:11px;">Gesamt</td>
            <td style="text-align:right;padding:6px 8px;font-weight:700;font-variant-numeric:tabular-nums;">${items.reduce((s, i) => s + i.totalKg, 0).toFixed(2)}</td>
          </tr>
        </tbody>
      </table>`;
  }

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Frischeliste ${weekLabel}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Arial, sans-serif; margin: 0; padding: 16px 20px; color: #0f172a; }
  h1 { font-size: 18px; font-weight: 900; margin: 0 0 2px; color: #0f2240; }
  .subtitle { font-size: 10px; color: #64748b; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .section-title { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; padding: 6px 8px; margin: 0 0 8px; border-radius: 6px; }
  .protein-title { background: #fef2f2; color: #991b1b; }
  .veggie-title  { background: #f0fdf4; color: #166534; }
  @media print { body { padding: 8px 12px; } }
</style>
</head>
<body>
  <h1>Frischeliste ${weekLabel}</h1>
  <div class="subtitle">Tage: ${dayLabel} · Erstellt: ${new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}</div>
  <div class="grid">
    <div>
      <div class="section-title protein-title">🥩 Protein Debox (${liste.protein.length} Artikel)</div>
      ${tableHtml(liste.protein)}
    </div>
    <div>
      <div class="section-title veggie-title">🥦 Veggie Debox (${liste.veggie.length} Artikel)</div>
      ${tableHtml(liste.veggie)}
    </div>
  </div>
</body>
</html>`;
}
