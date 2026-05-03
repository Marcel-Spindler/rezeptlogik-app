/**
 * ShareDashboard – Interaktives Team-Dashboard (read-only)
 *
 * Primärinhalt:  KET / Küchenplanung (Kanban nach Tag, filterbar)
 * Sekundär:      ASL-Linienplan (informativ, nur lesbar)
 * Erweiterbar:   Neue Tabs in NAV_TABS ergänzen
 *
 * URL:   ?share=2026-W19
 * Embed: ?share=2026-W19&embed=1  (ohne TopBar / Footer-Links)
 */

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

// ══════════════════════════════════════════════════════════════════════════════
//  TYPES
// ══════════════════════════════════════════════════════════════════════════════

type LinePlanRecipe = {
  code: string; name: string; totalPlanned: number;
  nordics: number; bnl: number; de: number; speedPerMin: number;
};

type KetWO = {
  priority: number; stagingBy: string; deboxDay: string; woReady: boolean;
  hotKitchenDay: string; dateNeeded: string; woNumber: string; recipeId: string;
  recipeName: string; subRecipeName: string; cookMethods: string[];
  targetPortions: number; allergens: string[]; status: string; comments: string;
};

type ScheduleMap = Record<string, LinePlanRecipe | null>;

// ══════════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const DAYS = ["Freitag", "Samstag", "Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag"] as const;

const SLOTS = [
  { key: "06:00-07:00",  label: "06 – 07",    duration: 60 },
  { key: "07:00-08:00",  label: "07 – 08",    duration: 60 },
  { key: "08:00-08:30",  label: "08 – 08:30", duration: 30 },
  { key: "09:00-10:00",  label: "09 – 10",    duration: 60 },
  { key: "10:00-11:00",  label: "10 – 11",    duration: 60 },
  { key: "11:30-12:00",  label: "11:30 – 12", duration: 30 },
  { key: "12:00-13:00",  label: "12 – 13",    duration: 60 },
  { key: "13:00-14:00",  label: "13 – 14",    duration: 60 },
  { key: "14:00-15:00",  label: "14 – 15",    duration: 60 },
] as const;

const LINES = ["P-Linie 1", "P-Linie 2", "P-Linie 3"] as const;

// ══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function parseNum(s: unknown): number {
  if (typeof s !== "string") return 0;
  const n = parseFloat(s.replace(/[,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

function recipeHue(code: string): number {
  let h = 5381;
  for (const c of code) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}

function pillStyle(code: string): CSSProperties {
  const h = recipeHue(code);
  return {
    background:  `hsl(${h},62%,88%)`,
    borderColor: `hsl(${h},48%,65%)`,
    color:       `hsl(${h},52%,22%)`,
  };
}

function fmtNum(n: number): string {
  return n.toLocaleString("de-DE");
}

function nameShort(name: string, max = 30): string {
  const t = name.replace(/\[.*?\]/g, "").trim();
  return t.length > max ? t.substring(0, max - 1) + "…" : t;
}

function statusStyle(status: string): CSSProperties {
  if (/done|complete|fertig/i.test(status))
    return { background: "#d1fae5", color: "#065f46", borderColor: "#a7f3d0" };
  if (/progress|running|aktiv/i.test(status))
    return { background: "#fef3c7", color: "#92400e", borderColor: "#fde68a" };
  return { background: "#f1f5f9", color: "#64748b", borderColor: "#e2e8f0" };
}

function slotDuration(slotKey: string): number {
  return SLOTS.find(s => s.key === slotKey)?.duration ?? 60;
}

function portionsInSlot(recipe: LinePlanRecipe, slotKey: string): number {
  return recipe.speedPerMin * slotDuration(slotKey);
}

// ══════════════════════════════════════════════════════════════════════════════
//  PARSERS
// ══════════════════════════════════════════════════════════════════════════════

function parseLineplanning(rows: string[][]): {
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

function parseKet(rows: string[][]): KetWO[] {
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

const NAV_TABS = [
  { key: "kitchen", label: "🍳 Küche",   desc: "Küchenplanung (KET)" },
  { key: "asl",     label: "📋 ASL",     desc: "Linienplanung (informativ)" },
  // { key: "quality", label: "✅ QS",    desc: "Qualitätschecks" },
  // { key: "stock",   label: "📦 Lager", desc: "Bestand & Debox" },
] as const;

type NavKey = (typeof NAV_TABS)[number]["key"];

// ══════════════════════════════════════════════════════════════════════════════
//  KET / KITCHEN  — Card
// ══════════════════════════════════════════════════════════════════════════════

function KitchenCard({
  wo,
  effectiveStatus,
}: {
  wo: KetWO;
  effectiveStatus: string;
}) {
  const code = wo.recipeId.match(/FV\d+[A-Z]/)?.[0] ?? "";
  const h = code ? recipeHue(code) : 210;

  return (
    <div
      className="rounded-xl border bg-white p-2.5 shadow-sm"
      style={{
        borderColor:      `hsl(${h},38%,82%)`,
        borderLeftColor:  `hsl(${h},52%,52%)`,
        borderLeftWidth:  3,
      }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-1.5 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <div
            className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
            style={{ background: `hsl(${h},55%,88%)`, color: `hsl(${h},52%,22%)` }}
          >
            {wo.priority}
          </div>
          <span className="font-semibold text-xs text-slate-800 leading-tight line-clamp-2">
            {wo.subRecipeName || wo.recipeName}
          </span>
        </div>
        <span
          className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border"
          style={statusStyle(effectiveStatus)}
        >
          {effectiveStatus.length > 12 ? effectiveStatus.substring(0, 10) + "…" : effectiveStatus}
        </span>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap gap-2 items-center mb-1">
        {code && (
          <span className="text-[10px] font-bold" style={{ color: `hsl(${h},52%,32%)` }}>{code}</span>
        )}
        {wo.woNumber && (
          <span className="text-[10px] font-mono text-slate-400">{wo.woNumber}</span>
        )}
        {wo.woReady && (
          <span className="ml-auto text-[9px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-1 rounded">
            ✓ WO
          </span>
        )}
        {wo.targetPortions > 0 && (
          <span className="text-[10px] font-bold tabular-nums text-slate-500 shrink-0">
            {fmtNum(wo.targetPortions)}
          </span>
        )}
      </div>

      {/* Cook methods */}
      {wo.cookMethods.length > 0 && (
        <div className="flex flex-wrap gap-0.5 mb-1.5">
          {wo.cookMethods.slice(0, 3).map(m => (
            <span key={m} className="px-1 py-0.5 rounded text-[9px] font-medium bg-slate-100 text-slate-600">{m}</span>
          ))}
          {wo.cookMethods.length > 3 && (
            <span className="text-[9px] text-slate-400">+{wo.cookMethods.length - 3}</span>
          )}
        </div>
      )}

      {/* Allergens */}
      {wo.allergens.length > 0 && (
        <div className="flex flex-wrap gap-0.5 mb-1">
          {wo.allergens.slice(0, 2).map(a => (
            <span key={a} className="px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-amber-50 text-amber-700 border border-amber-100">
              ⚠ {a.substring(0, 12)}
            </span>
          ))}
          {wo.allergens.length > 2 && (
            <span className="text-[9px] text-slate-400">+{wo.allergens.length - 2}</span>
          )}
        </div>
      )}

      {/* Comment */}
      {wo.comments && (
        <div className="mt-1 text-[10px] text-slate-400 italic border-t border-slate-50 pt-1 leading-tight">
          {wo.comments}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  KET / KITCHEN  — View  (Kanban, filterbar)
// ══════════════════════════════════════════════════════════════════════════════

function KitchenView({
  ketWOs,
  ketOverrides,
  weekNum,
}: {
  ketWOs: KetWO[];
  ketOverrides: Record<string, { day?: string; status?: string }>;
  weekNum: number;
}) {
  const [search, setSearch]     = useState("");
  const [statusF, setStatusF]   = useState<"all" | "open" | "done">("all");
  const [activeDay, setActiveDay] = useState<string>("all");

  const recipeLegend = useMemo(() => {
    const m = new Map<string, { code: string; name: string; count: number }>();
    for (const wo of ketWOs) {
      const code = wo.recipeId.match(/FV\d+[A-Z]/)?.[0] ?? "";
      if (!code) continue;
      if (!m.has(code)) m.set(code, { code, name: wo.recipeName, count: 0 });
      m.get(code)!.count++;
    }
    return Array.from(m.values());
  }, [ketWOs]);

  const allDays = useMemo(() => {
    const days: string[] = [];
    for (const d of DAYS) {
      const has = ketWOs.some(wo => {
        const day = ketOverrides[wo.woNumber]?.day ?? wo.hotKitchenDay;
        return day === d;
      });
      if (has) days.push(d);
    }
    return days;
  }, [ketWOs, ketOverrides]);

  const columns = useMemo(() => {
    let wos = ketWOs;
    if (search) {
      const q = search.toLowerCase();
      wos = wos.filter(wo =>
        wo.recipeName.toLowerCase().includes(q) ||
        wo.subRecipeName.toLowerCase().includes(q) ||
        wo.woNumber.toLowerCase().includes(q)
      );
    }
    if (statusF === "open") wos = wos.filter(wo =>
      !/done|fertig/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)
    );
    if (statusF === "done") wos = wos.filter(wo =>
      /done|fertig/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)
    );

    const map: Record<string, KetWO[]> = {};
    for (const wo of wos) {
      const day = ketOverrides[wo.woNumber]?.day ?? wo.hotKitchenDay;
      const key = day || "__unassigned__";
      if (!map[key]) map[key] = [];
      map[key].push(wo);
    }

    const cols: Array<{ day: string; label: string; wos: KetWO[] }> = [];
    if ((map["__unassigned__"] ?? []).length > 0)
      cols.push({ day: "__unassigned__", label: "Nicht geplant", wos: map["__unassigned__"] ?? [] });
    for (const d of DAYS) cols.push({ day: d, label: d, wos: map[d] ?? [] });

    if (activeDay !== "all")
      return cols.filter(c => c.day === activeDay || c.day === "__unassigned__");
    return cols;
  }, [ketWOs, ketOverrides, search, statusF, activeDay]);

  const totalWOs      = ketWOs.length;
  const doneWOs       = ketWOs.filter(wo => /done|fertig/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)).length;
  const progressWOs   = ketWOs.filter(wo => /progress|aktiv/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)).length;
  const totalPortions = ketWOs.reduce((s, wo) => s + wo.targetPortions, 0);

  return (
    <div className="flex gap-4 items-start">

      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      <aside className="w-48 shrink-0 space-y-3">

        {/* KW Stats Card */}
        <div
          className="rounded-2xl p-4 text-white"
          style={{ background: "linear-gradient(135deg,#312e81,#4338ca)" }}
        >
          <div className="text-[10px] font-bold uppercase tracking-widest opacity-60 mb-1">Küchenplanung</div>
          <div className="text-3xl font-black leading-none">KW {weekNum}</div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="bg-white/10 rounded-xl p-2">
              <div className="text-xs font-bold tabular-nums">{fmtNum(totalWOs)}</div>
              <div className="text-[9px] opacity-60 uppercase tracking-wide">Aufträge</div>
            </div>
            <div className="bg-white/10 rounded-xl p-2">
              <div className="text-xs font-bold tabular-nums">{fmtNum(totalPortions)}</div>
              <div className="text-[9px] opacity-60 uppercase tracking-wide">Portionen</div>
            </div>
          </div>
          <div className="mt-3">
            <div className="flex justify-between text-[10px] opacity-70 mb-1">
              <span>{doneWOs} fertig</span>
              <span>{Math.round((doneWOs / Math.max(totalWOs, 1)) * 100)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/20">
              <div
                className="h-1.5 rounded-full bg-emerald-400 transition-all"
                style={{ width: `${(doneWOs / Math.max(totalWOs, 1)) * 100}%` }}
              />
            </div>
            {progressWOs > 0 && (
              <div className="text-[9px] mt-1 opacity-60">{progressWOs} in Arbeit</div>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Suche</div>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Rezept, WO-Nr …"
            className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
          />
        </div>

        {/* Status filter */}
        <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Status</div>
          <div className="flex flex-col gap-1">
            {([ ["all","Alle"], ["open","Offen"], ["done","Fertig"] ] as const).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setStatusF(k)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-xl text-left transition-all ${
                  statusF === k
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-500 hover:bg-slate-50"
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Day filter */}
        {allDays.length > 1 && (
          <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Tag</div>
            <div className="flex flex-col gap-1">
              <button
                onClick={() => setActiveDay("all")}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-xl text-left transition-all ${
                  activeDay === "all"
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-slate-500 hover:bg-slate-50"
                }`}
              >
                Alle Tage
              </button>
              {allDays.map(d => (
                <button
                  key={d}
                  onClick={() => setActiveDay(d === activeDay ? "all" : d)}
                  className={`px-2.5 py-1.5 text-xs font-semibold rounded-xl text-left transition-all ${
                    activeDay === d
                      ? "bg-indigo-600 text-white shadow-sm"
                      : "text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {d.substring(0, 2)}.
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Recipe legend */}
        {recipeLegend.length > 0 && (
          <div className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">Rezepte</div>
            <div className="space-y-1.5">
              {recipeLegend.map(({ code, name, count }) => (
                <div key={code} style={pillStyle(code)} className="rounded-xl border px-2 py-1.5">
                  <div className="text-xs font-bold">{code}</div>
                  <div className="text-[10px] opacity-70 truncate">{nameShort(name, 20)}</div>
                  <div className="text-[9px] opacity-50 tabular-nums">{count} Sub-Rezepte</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>

      {/* ── Kanban board ────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-x-auto pb-2">
        <div
          className="flex gap-3"
          style={{ minWidth: `${columns.length * 212}px` }}
        >
          {columns.map(({ day, label, wos }) => {
            const totalP = wos.reduce((s, wo) => s + wo.targetPortions, 0);
            const done   = wos.filter(wo =>
              /done|fertig/i.test(ketOverrides[wo.woNumber]?.status ?? wo.status)
            ).length;

            return (
              <div key={day} className="w-52 shrink-0">
                {/* Column header */}
                <div className="rounded-t-2xl border border-b-0 border-slate-100 bg-white px-3 py-3 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-bold text-sm text-slate-700">{label}</div>
                      {totalP > 0 && (
                        <div className="text-[10px] text-slate-400 tabular-nums mt-0.5">
                          ∑ {fmtNum(totalP)}
                        </div>
                      )}
                    </div>
                    <span className={`text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full ${
                      wos.length > 0 ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-400"
                    }`}>
                      {wos.length}
                    </span>
                  </div>
                  {wos.length > 0 && (
                    <div className="mt-2 h-1 rounded-full bg-slate-100">
                      <div
                        className="h-1 rounded-full bg-emerald-400 transition-all"
                        style={{ width: `${(done / wos.length) * 100}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Cards */}
                <div className="border border-t-0 border-slate-100 rounded-b-2xl bg-slate-50/50 p-2 space-y-2 min-h-28">
                  {wos.map(wo => (
                    <KitchenCard
                      key={`${wo.woNumber}-${wo.subRecipeName}`}
                      wo={wo}
                      effectiveStatus={ketOverrides[wo.woNumber]?.status ?? wo.status}
                    />
                  ))}
                  {wos.length === 0 && (
                    <div className="flex items-center justify-center h-12 text-xs text-slate-200">
                      Leer
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {columns.every(c => c.wos.length === 0) && (
            <div className="flex-1 rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-slate-400">
              {search ? "Keine Treffer für diese Suche." : "Keine KET-Daten vorhanden."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  ASL VIEW  (Linienplan — informativ, read-only)
// ══════════════════════════════════════════════════════════════════════════════

function AslView({
  schedule,
  recipes,
  weekNum,
}: {
  schedule: ScheduleMap;
  recipes: LinePlanRecipe[];
  weekNum: number;
}) {
  const slotsFilled = Object.values(schedule).filter(Boolean).length;

  const scheduledPortions = useMemo(() => {
    const map = new Map<string, number>();
    for (const [key, r] of Object.entries(schedule)) {
      if (!r) continue;
      const slotKey = key.split("|")[1] ?? "";
      map.set(r.code, (map.get(r.code) ?? 0) + portionsInSlot(r, slotKey));
    }
    return map;
  }, [schedule]);

  if (slotsFilled === 0) return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center">
      <div className="text-4xl mb-3">📋</div>
      <div className="text-slate-500 font-medium">Kein ASL-Plan gespeichert für KW {weekNum}.</div>
      <div className="text-slate-400 text-sm mt-1">Der Plan wird sichtbar sobald der Planer ihn speichert.</div>
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Info banner */}
      <div className="rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3 flex items-center gap-3">
        <span className="text-lg">ℹ️</span>
        <div>
          <div className="text-sm font-semibold text-indigo-800">ASL-Linienplanung · KW {weekNum}</div>
          <div className="text-xs text-indigo-600 mt-0.5">
            Informative Ansicht. Den Plan pflegt der Planer in der internen App — er dient zur Erstellung der Rackfile.
          </div>
        </div>
      </div>

      {/* Volume balance */}
      {recipes.length > 0 && (
        <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">Volumen-Balance</div>
          <div className="grid gap-2">
            {recipes.map(r => {
              const scheduled = scheduledPortions.get(r.code) ?? 0;
              const pct = r.totalPlanned > 0 ? Math.min((scheduled / r.totalPlanned) * 100, 100) : 0;
              const h   = recipeHue(r.code);
              return (
                <div key={r.code}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ background: `hsl(${h},52%,52%)` }} />
                      <span className="font-mono text-slate-500 text-[10px]">{r.code}</span>
                      <span className="font-medium text-slate-700 truncate max-w-[10rem]">{nameShort(r.name, 18)}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-[10px] tabular-nums">
                      <span className="font-bold" style={{ color: `hsl(${h},52%,32%)` }}>{fmtNum(scheduled)}</span>
                      <span className="text-slate-300">/</span>
                      <span className="text-slate-400">{fmtNum(r.totalPlanned)}</span>
                    </div>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100">
                    <div
                      className="h-1.5 rounded-full transition-all"
                      style={{ width: `${pct}%`, background: `hsl(${h},52%,52%)` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Schedule grid */}
      <div className="rounded-2xl border border-slate-100 bg-white shadow-sm overflow-hidden">
        <div
          className="px-4 py-2.5 border-b border-slate-50 bg-slate-50/50 hidden sm:grid gap-2"
          style={{ gridTemplateColumns: "5rem 6.5rem repeat(3, 1fr) 5rem" }}
        >
          <div className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Tag</div>
          <div className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Zeit</div>
          {LINES.map(l => <div key={l} className="text-xs font-semibold text-slate-500 text-center">{l}</div>)}
          <div className="text-[10px] font-bold text-slate-300 uppercase tracking-wider text-right">Meals/h</div>
        </div>

        {DAYS.map(day => {
          const hasSomething = SLOTS.some(s =>
            LINES.some((_, li) => schedule[`${day}|${s.key}|${li}`])
          );
          if (!hasSomething) return null;
          return (
            <div key={day}>
              <div className="px-4 py-2 bg-gradient-to-r from-slate-50 to-white border-y border-slate-50">
                <span className="font-bold text-sm text-slate-700">{day}</span>
              </div>
              {SLOTS.map(slot => {
                const cells = LINES.map((_, li) => schedule[`${day}|${slot.key}|${li}`] ?? null);
                if (cells.every(c => !c)) return null;
                let totalP = 0;
                for (const r of cells) if (r) totalP += portionsInSlot(r, slot.key);
                const mh = slot.duration > 0 ? Math.round((totalP / slot.duration) * 60) : 0;

                return (
                  <div key={slot.key} className="px-4 py-2 border-b border-slate-50 last:border-0">
                    {/* Desktop */}
                    <div
                      className="hidden sm:grid gap-2 items-center"
                      style={{ gridTemplateColumns: "5rem 6.5rem repeat(3, 1fr) 5rem" }}
                    >
                      <div className="text-[10px] text-slate-300">{slot.duration < 60 ? `${slot.duration} min` : ""}</div>
                      <div className="text-xs font-mono text-slate-500 font-semibold">{slot.label}</div>
                      {cells.map((r, li) => {
                        if (!r) return <div key={li} className="h-7 rounded-lg border border-dashed border-slate-100" />;
                        const h = recipeHue(r.code);
                        return (
                          <div
                            key={li}
                            className="rounded-lg px-2 py-1.5 flex items-center gap-1.5 text-xs font-semibold"
                            style={{
                              background:       `hsl(${h},62%,90%)`,
                              borderLeft:       `3px solid hsl(${h},52%,52%)`,
                              color:            `hsl(${h},52%,22%)`,
                            }}
                          >
                            <span className="font-mono opacity-60 text-[10px] shrink-0">{r.code}</span>
                            <span className="truncate">{nameShort(r.name, 12)}</span>
                            <span className="ml-auto opacity-50 tabular-nums text-[10px] shrink-0">
                              {fmtNum(portionsInSlot(r, slot.key))}
                            </span>
                          </div>
                        );
                      })}
                      <div className={`text-right text-xs font-bold tabular-nums ${mh > 3000 ? "text-emerald-600" : "text-slate-400"}`}>
                        {mh > 0 ? fmtNum(mh) : "—"}
                      </div>
                    </div>

                    {/* Mobile */}
                    <div className="sm:hidden space-y-1">
                      <div className="text-[10px] text-slate-400 font-mono font-semibold">{slot.label}</div>
                      {cells.map((r, li) => {
                        if (!r) return null;
                        const h = recipeHue(r.code);
                        return (
                          <div
                            key={li}
                            className="rounded-lg px-2.5 py-1.5 flex items-center gap-2 text-xs font-semibold"
                            style={{
                              background:  `hsl(${h},62%,90%)`,
                              borderLeft:  `3px solid hsl(${h},52%,52%)`,
                              color:       `hsl(${h},52%,22%)`,
                            }}
                          >
                            <span className="font-mono opacity-60 text-[10px] shrink-0">{r.code}</span>
                            <span className="truncate">{nameShort(r.name, 22)}</span>
                            <span className="text-[9px] shrink-0 ml-auto">{LINES[li]}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROOT COMPONENT
// ══════════════════════════════════════════════════════════════════════════════

export function ShareDashboard({ week }: { week: string }) {
  const weekStr  = week.split("-W")[1] ?? week;
  const isEmbed  = new URLSearchParams(window.location.search).has("embed");

  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [recipes,      setRecipes]      = useState<LinePlanRecipe[]>([]);
  const [schedule,     setSchedule]     = useState<ScheduleMap>({});
  const [ketWOs,       setKetWOs]       = useState<KetWO[]>([]);
  const [ketOverrides, setKetOverrides] = useState<Record<string, { day?: string; status?: string }>>({});
  const [weekNum,      setWeekNum]      = useState(0);
  const [savedAt,      setSavedAt]      = useState<string | null>(null);
  const [activeTab,    setActiveTab]    = useState<NavKey>("kitchen");
  const [copied,       setCopied]       = useState(false);

  // ── Load ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/data/gsheet-dump-Kitchen_Priority_List-Verden-2026.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as {
          sheets: Array<{ title: string; sheetId: number; values: string[][] }>;
        };

        const lpSheet = data.sheets.find(s => s.title === "Lineplanning");
        if (lpSheet) {
          const { weekNum: wn, recipes: recs, initialSchedule } =
            parseLineplanning(lpSheet.values);
          setWeekNum(wn); setRecipes(recs); setSchedule(initialSchedule);
        }

        const ketSheet =
          data.sheets.find(s => s.title.includes(`W${weekStr}`) && s.title.startsWith("KET")) ??
          data.sheets.find(s => s.title.startsWith("KET"));
        if (ketSheet) setKetWOs(parseKet(ketSheet.values));

        // Firestore overrides (public read)
        const { getFirebase }           = await import("./firebase");
        const { doc, getDoc }           = await import("firebase/firestore");
        const { db }                    = getFirebase();
        const snap                      = await getDoc(doc(db, "apps/rezeptlogik/lineplanning", `de_W${weekStr}`));
        if (snap.exists()) {
          const d = snap.data() as {
            schedule?:     ScheduleMap;
            ketOverrides?: Record<string, { day?: string; status?: string }>;
            savedAt?:      string;
          };
          if (d.schedule)     setSchedule(d.schedule);
          if (d.ketOverrides) setKetOverrides(d.ketOverrides);
          if (d.savedAt)      setSavedAt(d.savedAt);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [weekStr]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const savedAtLabel = savedAt
    ? new Date(savedAt).toLocaleString("de-DE", {
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : null;

  function copyLink() {
    void navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4"
      style={{ background: "linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#0f172a 100%)" }}
    >
      <div className="w-14 h-14 rounded-full border-4 border-indigo-500/30 border-t-indigo-400 animate-spin" />
      <div className="text-center">
        <div className="text-white text-lg font-semibold">Lade Produktionsplan</div>
        <div className="text-indigo-300 text-sm mt-1">Factor Verden · KW {weekStr}</div>
      </div>
    </div>
  );

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error) return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#0f172a 100%)" }}
    >
      <div className="text-center">
        <div className="text-5xl mb-4">⚠️</div>
        <div className="text-rose-300 text-xl font-semibold">Plan konnte nicht geladen werden</div>
        <div className="text-slate-400 text-sm mt-2 font-mono">{error}</div>
        <a
          href={window.location.origin}
          className="mt-6 inline-block px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition-colors"
        >
          → App öffnen
        </a>
      </div>
    </div>
  );

  // ── Main ──────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">

      {/* ── Top Bar ────────────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-50 border-b border-slate-200/60 shrink-0"
        style={{ backdropFilter: "blur(20px)", background: "rgba(248,250,252,0.92)" }}
      >
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6">
          <div className="flex items-center gap-4 py-2.5">

            {/* Brand */}
            <div className="flex items-center gap-2.5 shrink-0">
              <div
                className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-black"
                style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)" }}
              >
                F
              </div>
              <div className="hidden sm:block">
                <div className="text-xs font-bold text-slate-700 leading-none">Factor Verden</div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  KW {weekNum > 0 ? weekNum : weekStr}
                  {savedAtLabel && <> · {savedAtLabel}</>}
                </div>
              </div>
            </div>

            {/* Tabs */}
            <nav className="flex-1 flex items-center gap-2 overflow-x-auto">
              <div className="flex gap-1 p-1 rounded-xl bg-slate-100 ring-1 ring-slate-200">
                {NAV_TABS.map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap transition-all duration-150 ${
                      activeTab === tab.key
                        ? "bg-white shadow-sm ring-1 ring-slate-200 text-slate-800"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-lg bg-amber-50 border border-amber-100">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide">Nur Ansicht</span>
              </div>
            </nav>

            {/* Actions */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={copyLink}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all"
                style={copied
                  ? { borderColor: "#6ee7b7", background: "#d1fae5", color: "#065f46" }
                  : { borderColor: "#e2e8f0", background: "white",   color: "#475569" }
                }
              >
                <span>{copied ? "✓" : "🔗"}</span>
                <span className="hidden sm:inline">{copied ? "Kopiert!" : "Teilen"}</span>
              </button>
              {!isEmbed && (
                <a
                  href={window.location.origin}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
                >
                  <span>↗</span>
                  <span className="hidden sm:inline">App</span>
                </a>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Subtitle bar ─────────────────────────────────────────────── */}
      <div
        className="shrink-0 border-b border-slate-100"
        style={{ background: "linear-gradient(90deg,#f8fafc,white)" }}
      >
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
            {NAV_TABS.find(t => t.key === activeTab)?.desc}
          </div>
          <h1 className="text-xl font-black text-slate-800 mt-0.5">
            {NAV_TABS.find(t => t.key === activeTab)?.label}
            <span className="ml-2.5 text-slate-300 font-normal text-base">
              KW {weekNum > 0 ? weekNum : weekStr}
            </span>
          </h1>
        </div>
      </div>

      {/* ── Main ─────────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-screen-2xl w-full mx-auto px-4 sm:px-6 py-6">
        {activeTab === "kitchen" && (
          <KitchenView
            ketWOs={ketWOs}
            ketOverrides={ketOverrides}
            weekNum={weekNum > 0 ? weekNum : parseInt(weekStr)}
          />
        )}
        {activeTab === "asl" && (
          <AslView
            schedule={schedule}
            recipes={recipes}
            weekNum={weekNum > 0 ? weekNum : parseInt(weekStr)}
          />
        )}
        {/* Weitere Tabs hier ergänzen */}
      </main>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <footer className="shrink-0 border-t border-slate-100">
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <div
              className="w-4 h-4 rounded flex items-center justify-center text-white text-[9px] font-black"
              style={{ background: "linear-gradient(135deg,#4f46e5,#7c3aed)" }}
            >F</div>
            <span>Factor · Verden · KW {weekNum > 0 ? weekNum : weekStr}</span>
            {savedAtLabel && (
              <><span className="text-slate-200">·</span><span>Stand: {savedAtLabel}</span></>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={copyLink} className="hover:text-slate-600 transition-colors">
              {copied ? "✓ Link kopiert" : "🔗 Link kopieren"}
            </button>
            {!isEmbed && (
              <>
                <span className="text-slate-200">·</span>
                <a href={window.location.origin} className="hover:text-slate-600 transition-colors">
                  ↗ Planer-App
                </a>
              </>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
