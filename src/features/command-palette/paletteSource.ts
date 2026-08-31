// Command-Palette — reine Index-Bauer + Ranking (kein React).
//
// Setzt die durchsuchbare Item-Liste aus vier Quellen zusammen:
//   view    – alle Nav-Views (Label + Kategorie + Aliase)
//   week    – die im DataBundle vorhandenen Kalenderwochen
//   recipe  – jedes Rezept (öffnet direkt die Rezept-Ansicht)
//   wo/submeal/sku – die bestehende globale Suche (→ Flow-Overlay)
// Kommandos kommen separat aus paletteCommands.ts dazu.
import type { AppView } from "../../app/AppContext";
import { allNavViews } from "../../app/NavTabs";
import type { DataBundle } from "../../core/types";
import type { WoReconciliationRow } from "../wo-reconciliation/woReconcileTypes";
import { buildSearchIndex } from "../global-search/globalSearchIndex";
import { GROUP_ICON, type PaletteGroup, type PaletteItem, type PaletteResultGroup, GROUP_LABEL } from "./paletteTypes";

export const GROUP_PRIORITY: Record<PaletteGroup, number> = {
  command: 34,
  view: 30,
  wo: 26,
  week: 20,
  recipe: 16,
  submeal: 12,
  sku: 8,
};

/** Zusätzliche Suchbegriffe je View, damit „warehouse", „was wäre wenn" etc. treffen. */
const VIEW_ALIASES: Partial<Record<AppView, string>> = {
  recipe: "rezept detail zutaten",
  catalog: "meal katalog bilder database",
  planning: "oase cockpit kapazitaet auslastung",
  "plating-plan": "plaiten wochenplanung sheet runs besetzung",
  "plating-day": "plaiten linienplan tagesplan changeover reinigung highrunner",
  "artikel-woche": "artikel sku pro woche",
  whatif: "was waere wenn rechner rohware portionen simulation",
  wo: "work order ket breakdown kochanweisungen",
  pet: "plating petplan zuteilung",
  wms: "lager warehouse bestand uebersicht",
  "full-inventory": "lager komplett inventory bestand alle",
  "postblast-live": "wiegungen blast monitor gsheet",
  backfills: "rti postblast holding nachschub",
  "transparency-plan": "transparency wo status freitext",
  "redzone-live": "kueche live monitoring redzone plating now",
  "blast-chiller": "chiller bot kuehl zuteilung",
  "allergen-plating": "allergen bot linien",
  rundmail: "email mail rundschreiben pet info",
  import: "csv upload datei",
};

function norm(v: unknown): string {
  return String(v ?? "").toLowerCase().trim();
}

function weekAliases(week: string): string {
  // "2026-W37" → "kw37 w37 37"
  const m = /w(\d{1,2})$/i.exec(week);
  const n = m?.[1];
  return n ? `kw${n} w${n} ${n}` : "";
}

// ─── Bauer ─────────────────────────────────────────────────────────────────

export function buildViewItems(setView: (v: AppView) => void, isDev: boolean): PaletteItem[] {
  return allNavViews()
    .filter((v) => isDev || !v.localOnly)
    .map((v) => ({
      key: `view:${v.view}`,
      group: "view" as const,
      title: v.label,
      subtitle: v.category,
      hint: "Ansicht",
      icon: GROUP_ICON.view,
      search: [v.label, v.category, v.view, VIEW_ALIASES[v.view] ?? ""].map(norm).join(" "),
      priority: GROUP_PRIORITY.view,
      action: { type: "run", run: () => setView(v.view) },
    }));
}

export function buildWeekItems(
  data: DataBundle | null,
  weekRecipeCount: (week: string) => number,
  setSelectedWeek: (w: string) => void,
): PaletteItem[] {
  const weeks = [...(data?.weeks ?? [])].reverse(); // neueste zuerst
  return weeks.map((w) => {
    const count = weekRecipeCount(w);
    return {
      key: `week:${w}`,
      group: "week" as const,
      title: `KW ${w}`,
      subtitle: count > 0 ? `${count} Rezepte` : "keine Rezepte",
      hint: "KW",
      icon: GROUP_ICON.week,
      search: [w, weekAliases(w), "kalenderwoche woche"].map(norm).join(" "),
      priority: GROUP_PRIORITY.week,
      action: { type: "run", run: () => setSelectedWeek(w) },
    };
  });
}

export function buildRecipeItems(
  data: DataBundle | null,
  openRecipe: (code: string) => void,
): PaletteItem[] {
  if (!data) return [];
  const out: PaletteItem[] = [];
  const seen = new Set<string>();
  const add = (code: string, name: string, extra: string) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    out.push({
      key: `recipe:${code}`,
      group: "recipe",
      title: name || code,
      subtitle: code,
      hint: "Rezept",
      icon: GROUP_ICON.recipe,
      search: [name, code, extra].map(norm).join(" "),
      priority: GROUP_PRIORITY.recipe,
      action: { type: "run", run: () => openRecipe(code) },
    });
  };
  for (const [code, recipe] of Object.entries(data.recipes ?? {})) {
    add(code, recipe.baseName ?? "", "");
  }
  for (const wr of data.weekRecipes ?? []) {
    add(wr.code, wr.recipeName ?? "", wr.preference ?? "");
  }
  return out;
}

/** Die bestehende globale Suche (wo/submeal/sku) als Palette-Items — Meals sind
 *  raus, die deckt buildRecipeItems mit der besseren Aktion (Rezept öffnen) ab. */
export function buildSearchEntryItems(
  data: DataBundle | null,
  reconRows: WoReconciliationRow[],
): PaletteItem[] {
  return buildSearchIndex(data, reconRows)
    .filter((e) => e.kind === "wo" || e.kind === "submeal" || e.kind === "sku")
    .map((e) => {
      const group = e.kind as Extract<PaletteGroup, "wo" | "submeal" | "sku">;
      return {
        key: `${e.kind}:${e.woNumber ?? e.sku ?? e.subRecipe ?? ""}:${e.recipeCode}:${e.title}`,
        group,
        title: e.title,
        subtitle: e.subtitle,
        hint: e.sku && group === "submeal" ? e.sku : GROUP_LABEL[group],
        icon: GROUP_ICON[group],
        search: e.haystack,
        priority: GROUP_PRIORITY[group],
        action: { type: "flow", entry: e },
      };
    });
}

// ─── Ranking ───────────────────────────────────────────────────────────────

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (needle[i] === hay[j]) i += 1;
  }
  return i === needle.length;
}

/** 0 = kein Treffer. Höher = besser. */
export function matchScore(query: string, item: PaletteItem): number {
  const q = norm(query);
  if (!q) return 0;
  const hay = item.search;
  const title = norm(item.title);
  const tokens = q.split(/\s+/).filter(Boolean);

  const allTokensHit = tokens.every((t) => hay.includes(t));
  const subseqHit = tokens.length === 1 && q.length >= 3 && isSubsequence(q, title);
  if (!allTokensHit && !subseqHit) return 0;

  let score = item.priority;
  if (title === q) score += 140;
  else if (title.startsWith(q)) score += 80;
  else if (hay.startsWith(q) || hay.includes(` ${q}`)) score += 40;
  else if (hay.includes(q)) score += 18;
  else if (subseqHit) score += 8;

  for (const t of tokens) {
    if (title.startsWith(t)) score += 10;
    else if (hay.includes(` ${t}`)) score += 6;
    else if (hay.includes(t)) score += 3;
  }

  // Kürzere Titel sind meist die gemeinten.
  score -= Math.min(12, Math.floor(title.length / 10));
  return score;
}

const PER_GROUP_CAP: Record<PaletteGroup, number> = {
  command: 8,
  view: 12,
  week: 8,
  recipe: 8,
  wo: 8,
  submeal: 8,
  sku: 6,
};

/** Ohne Suchbegriff gezeigte Gruppen (Browse-Modus). */
const BROWSE_GROUPS: PaletteGroup[] = ["command", "view"];

const GROUP_ORDER: PaletteGroup[] = ["command", "view", "week", "recipe", "wo", "submeal", "sku"];

export function rankPaletteItems(items: PaletteItem[], query: string): PaletteResultGroup[] {
  const q = query.trim();

  let picked: { item: PaletteItem; score: number }[];
  if (!q) {
    picked = items
      .filter((it) => BROWSE_GROUPS.includes(it.group))
      .map((item) => ({ item, score: item.priority }));
  } else {
    picked = [];
    for (const item of items) {
      const score = matchScore(q, item);
      if (score > 0) picked.push({ item, score });
    }
  }

  const byGroup = new Map<PaletteGroup, { item: PaletteItem; score: number }[]>();
  for (const p of picked) {
    if (!byGroup.has(p.item.group)) byGroup.set(p.item.group, []);
    byGroup.get(p.item.group)!.push(p);
  }

  const ranked: { group: PaletteResultGroup; best: number }[] = [];
  for (const group of GROUP_ORDER) {
    const rows = byGroup.get(group);
    if (!rows || rows.length === 0) continue;
    rows.sort((a, b) => b.score - a.score || a.item.title.length - b.item.title.length);
    ranked.push({
      group: {
        group,
        label: GROUP_LABEL[group],
        items: rows.slice(0, PER_GROUP_CAP[group]).map((r) => r.item),
      },
      best: rows[0].score,
    });
  }

  // Ohne Suchbegriff: feste Reihenfolge. Mit Suchbegriff: relevanteste Gruppe oben.
  if (q) {
    ranked.sort(
      (a, b) =>
        b.best - a.best ||
        GROUP_ORDER.indexOf(a.group.group) - GROUP_ORDER.indexOf(b.group.group),
    );
  }
  return ranked.map((r) => r.group);
}
