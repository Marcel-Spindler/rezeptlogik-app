// Share Dashboard – reine Logik: Format-/Farb-Helper, GSheet-Row-Parsing (Lineplanning + KET),
// Quality-Analyse (kritische/warnende/informative Abweichungen).
import type { CSSProperties } from "react";
import { DAYS, SLOTS } from "./shareDashboardTypes";
import type { KetWO, LinePlanRecipe, ScheduleMap } from "./shareDashboardTypes";

export function parseNum(s: unknown): number {
  if (typeof s !== "string") return 0;
  const n = parseFloat(s.replace(/[,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

export function recipeHue(code: string): number {
  let h = 5381;
  for (const c of code) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}

export function pillStyle(code: string): CSSProperties {
  const h = recipeHue(code);
  return {
    background:  `hsl(${h},62%,88%)`,
    borderColor: `hsl(${h},48%,65%)`,
    color:       `hsl(${h},52%,22%)`,
  };
}

export function fmtNum(n: number): string {
  return n.toLocaleString("de-DE");
}

export function nameShort(name: string, max = 30): string {
  const t = name.replace(/\[.*?\]/g, "").trim();
  return t.length > max ? t.substring(0, max - 1) + "…" : t;
}

export function statusStyle(status: string): CSSProperties {
  if (/done|complete|fertig/i.test(status))
    return { background: "#d1fae5", color: "#065f46", borderColor: "#a7f3d0" };
  if (/progress|running|aktiv/i.test(status))
    return { background: "#fef3c7", color: "#92400e", borderColor: "#fde68a" };
  return { background: "#f1f5f9", color: "#64748b", borderColor: "#e2e8f0" };
}

export function slotDuration(slotKey: string): number {
  return SLOTS.find(s => s.key === slotKey)?.duration ?? 60;
}

export function portionsInSlot(recipe: LinePlanRecipe, slotKey: string): number {
  return recipe.speedPerMin * slotDuration(slotKey);
}

// ══════════════════════════════════════════════════════════════════════════════
//  PARSERS
// ══════════════════════════════════════════════════════════════════════════════

export function parseLineplanning(rows: string[][]): {
  weekNum: number; totalVolume: number;
  recipes: LinePlanRecipe[]; initialSchedule: ScheduleMap;
} {
  const weekNum = parseInt(rows[0]?.[2] ?? "0");
  const totalVolume = parseNum(rows[1]?.[2]);

  const recipes: LinePlanRecipe[] = [];
  for (const row of rows) {
    const code = (row[9] ?? "").trim();
    if (!/^FV\d{4}[A-Z]/.test(code)) continue;
    recipes.push({
      code, name: (row[10] ?? code).trim(),
      totalPlanned: parseNum(row[11]), nordics: parseNum(row[12]),
      bnl: (row[13] ?? "").trim() === "X" ? 0 : parseNum(row[13]),
      de: parseNum(row[14]), speedPerMin: parseNum(row[15]) || 10,
    });
  }

  const dayMap: Record<string, (typeof DAYS)[number]> = {
    Friday: "Freitag",
    Saturday: "Samstag",
    Sunday: "Sonntag",
    Monday: "Montag",
    Tuesday: "Dienstag",
    Wednesday: "Mittwoch",
    Thursday: "Donnerstag",
  };
  const slotMap: Record<string, string> = {
    "06:00 - 07:00": "06:00-07:00", "07:00 - 08:00": "07:00-08:00",
    "08:00 - 08:30": "08:00-08:30", "09:00 - 10:00": "09:00-10:00",
    "10:00 - 11:00": "10:00-11:00", "11:30 - 12:00": "11:30-12:00",
    "12:00 - 13:00": "12:00-13:00", "13:00 - 14:00": "13:00-14:00",
    "14:00 - 15:00": "14:00-15:00",
  };

  const initialSchedule: ScheduleMap = {};
  let currentDay: (typeof DAYS)[number] | null = null;
  for (const row of rows) {
    const d = (row[0] ?? "").trim();
    if (dayMap[d]) currentDay = dayMap[d];
    if (!currentDay) continue;
    const slot = slotMap[(row[1] ?? "").trim()];
    if (!slot) continue;
    for (let li = 0; li < 3; li++) {
      const cell = (row[li + 2] ?? "").trim();
      if (!cell) continue;
      const found = recipes.find(r =>
        cell.includes(r.code) ||
        r.name.toLowerCase().startsWith(cell.toLowerCase().substring(0, 12))
      );
      if (found) initialSchedule[`${currentDay}|${slot}|${li}`] = found;
    }
  }
  return { weekNum, totalVolume, recipes, initialSchedule };
}

export function parseKet(rows: string[][]): KetWO[] {
  if (rows.length < 2) return [];
  const result: KetWO[] = [];
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r[1]?.match(/^\d+$/)) continue;
    result.push({
      priority:       parseInt(r[1]),
      stagingBy:      (r[2]  ?? "").trim(),
      deboxDay:       (r[4]  ?? "").trim(),
      woReady:         r[5]  === "TRUE",
      hotKitchenDay:  (r[6]  ?? "").trim(),
      dateNeeded:     (r[7]  ?? "").trim(),
      woNumber:       (r[8]  ?? "").trim(),
      recipeId:       (r[9]  ?? "").trim(),
      recipeName:     (r[10] ?? "").trim(),
      subRecipeName:  (r[11] ?? "").trim(),
      cookMethods:    (r[13] ?? "").trim().split(" / ").filter(Boolean),
      targetPortions:  parseNum(r[14]),
      allergens:      (r[24] ?? "").trim().split(",").map(a => a.trim()).filter(Boolean),
      status:         (r[19] ?? "").trim() || "Not Started",
      comments:       (r[23] ?? "").trim(),
    });
  }
  return result.sort((a, b) => a.priority - b.priority);
}

// ══════════════════════════════════════════════════════════════════════════════
//  NAVIGATION TABS  ← hier neue Tabs hinzufügen
// ══════════════════════════════════════════════════════════════════════════════

export const NAV_TABS = [
  { key: "kitchen", label: "🍳 Küche",   desc: "Küchenplanung (KET)" },
  { key: "asl",     label: "📋 ASL",     desc: "Linienplanung (informativ)" },
  { key: "quality", label: "✅ Qualität", desc: "Datenqualität / Plausibilitätschecks" },
  { key: "kpi",     label: "📈 KPI",      desc: "Kennzahlen & Top-Treiber" },
] as const;

export type NavKey = (typeof NAV_TABS)[number]["key"];

export type QualitySeverity = "critical" | "warn" | "info";
export type QualityDomain = "ket" | "asl";

export type QualityIssue = {
  id: string;
  severity: QualitySeverity;
  domain: QualityDomain;
  title: string;
  detail: string;
};

export function sevWeight(sev: QualitySeverity): number {
  if (sev === "critical") return 0;
  if (sev === "warn") return 1;
  return 2;
}

export function qualityTone(severity: QualitySeverity): string {
  if (severity === "critical") return "bg-rose-50 text-rose-800 border-rose-200";
  if (severity === "warn") return "bg-amber-50 text-amber-800 border-amber-200";
  return "bg-slate-50 text-slate-700 border-slate-200";
}

export function analyzeQuality(ketWOs: KetWO[], recipes: LinePlanRecipe[], schedule: ScheduleMap): QualityIssue[] {
  const issues: QualityIssue[] = [];

  // KET checks
  ketWOs.forEach((wo, idx) => {
    if (!wo.woNumber) {
      issues.push({
        id: `ket-missing-wo-${idx}`,
        severity: "critical",
        domain: "ket",
        title: "WO ohne WO-Nummer",
        detail: `${wo.recipeName || "Unbekanntes Rezept"} (Prio ${wo.priority}) hat keine WO-Nummer.`,
      });
    }
    if (!wo.recipeId) {
      issues.push({
        id: `ket-missing-recipeid-${idx}`,
        severity: "warn",
        domain: "ket",
        title: "WO ohne Recipe-ID",
        detail: `WO ${wo.woNumber || "ohne Nummer"} hat keine Recipe-ID.`,
      });
    }
    if (!wo.hotKitchenDay) {
      issues.push({
        id: `ket-missing-day-${idx}`,
        severity: "warn",
        domain: "ket",
        title: "WO ohne Produktionstag",
        detail: `WO ${wo.woNumber || "ohne Nummer"} ist keinem Hot-Kitchen-Tag zugeordnet.`,
      });
    }
    if (wo.targetPortions <= 0) {
      issues.push({
        id: `ket-invalid-portions-${idx}`,
        severity: "warn",
        domain: "ket",
        title: "WO mit 0 Portionen",
        detail: `WO ${wo.woNumber || "ohne Nummer"} hat targetPortions=${wo.targetPortions}.`,
      });
    }
  });

  const woDupe = new Map<string, number>();
  for (const wo of ketWOs) {
    if (!wo.woNumber) continue;
    woDupe.set(wo.woNumber, (woDupe.get(wo.woNumber) ?? 0) + 1);
  }
  for (const [woNumber, count] of woDupe.entries()) {
    if (count > 1) {
      issues.push({
        id: `ket-dup-${woNumber}`,
        severity: "critical",
        domain: "ket",
        title: "Doppelte WO-Nummer",
        detail: `WO ${woNumber} kommt ${count}× vor.`,
      });
    }
  }

  // ASL checks
  const recipeCodes = new Set(recipes.map(r => r.code));
  recipes.forEach((r, idx) => {
    if (!r.code) {
      issues.push({
        id: `asl-missing-code-${idx}`,
        severity: "critical",
        domain: "asl",
        title: "Rezept ohne Code",
        detail: `Ein ASL-Rezept hat keinen Code.`,
      });
    }
    if (!r.name) {
      issues.push({
        id: `asl-missing-name-${idx}`,
        severity: "warn",
        domain: "asl",
        title: "Rezept ohne Name",
        detail: `Rezept ${r.code || "ohne Code"} hat keinen Namen.`,
      });
    }
    if (r.speedPerMin <= 0) {
      issues.push({
        id: `asl-speed-${idx}`,
        severity: "warn",
        domain: "asl",
        title: "Ungültige Liniengeschwindigkeit",
        detail: `${r.code || "ohne Code"} hat speedPerMin=${r.speedPerMin}.`,
      });
    }
    if (r.totalPlanned <= 0) {
      issues.push({
        id: `asl-planned-${idx}`,
        severity: "info",
        domain: "asl",
        title: "Rezept ohne Planmenge",
        detail: `${r.code || "ohne Code"} hat totalPlanned=${r.totalPlanned}.`,
      });
    }
  });

  for (const [slotKey, planned] of Object.entries(schedule)) {
    if (!planned) continue;
    if (!recipeCodes.has(planned.code)) {
      issues.push({
        id: `asl-orphan-slot-${slotKey}`,
        severity: "warn",
        domain: "asl",
        title: "Slot mit unbekanntem Rezept",
        detail: `Slot ${slotKey} referenziert ${planned.code}, das nicht in der Rezeptliste ist.`,
      });
    }
  }

  return issues.sort((a, b) => sevWeight(a.severity) - sevWeight(b.severity));
}

