// Übergeordnete Suche — reiner Index-Aufbau + Ranking (kein React).
// Baut aus dem geladenen DataBundle (+ WO-Abgleich-Zeilen, falls vorhanden) einen
// flachen, durchsuchbaren Index über vier Trefferarten:
//   wo      – Work-Order-Nummer (das Leitbeispiel)
//   submeal – Sub-Rezept, per Name UND per SKU/ID
//   sku     – Ingredient-/Packaging-SKU-Code
//   meal    – Rezept (Family-Code / Name)
import type { DataBundle } from "../../core/types";
import type { WoReconciliationRow } from "../wo-reconciliation/woReconcileTypes";
import type { SearchEntry, SearchHit } from "./searchTypes";
import { weekPrefixFromWoNumber } from "../wms-overview/wmsWeeks";

function norm(v: unknown): string {
  return String(v ?? "").toLowerCase().trim();
}

function tokenize(v: string): string[] {
  return norm(v)
    .split(/[^a-z0-9äöüß]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function pushEntry(
  out: SearchEntry[],
  seen: Set<string>,
  base: Omit<SearchEntry, "haystack" | "tokens">,
  extraText: string[] = [],
): void {
  const dedupeKey = `${base.kind}::${base.woNumber ?? ""}::${base.sku ?? ""}::${base.subRecipe ?? ""}::${base.recipeCode}::${base.title}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  const parts = [base.title, base.subtitle, base.recipeCode, base.woNumber, base.sku, base.subRecipe, ...extraText];
  const haystack = parts.map(norm).filter(Boolean).join(" ");
  out.push({ ...base, haystack, tokens: [...new Set(parts.flatMap((p) => tokenize(String(p ?? ""))))] });
}

/** Alle Sub-Rezepte eines Rezepts über die Märkte (id + name), dedupliziert. */
function recipeSubmeals(data: DataBundle, code: string): { id: string; name: string; category: string }[] {
  const recipe = data.recipes?.[code];
  const out = new Map<string, { id: string; name: string; category: string }>();
  for (const md of Object.values(recipe?.markets ?? {})) {
    for (const sub of md.subRecipes ?? []) {
      if (!out.has(sub.name)) out.set(sub.name, { id: sub.id, name: sub.name, category: sub.category });
    }
  }
  return [...out.values()];
}

export function buildSearchIndex(
  data: DataBundle | null,
  reconRows: WoReconciliationRow[],
): SearchEntry[] {
  if (!data) return [];
  const out: SearchEntry[] = [];
  const seen = new Set<string>();

  // ── Work Orders: aus Produktionsplan + WO-Abgleich ────────────────────────
  const woSubs = new Map<string, Set<string>>();
  const woMeta = new Map<string, { code: string; name: string }>();
  for (const row of data.productionPlan?.rows ?? []) {
    const wo = String(row.workOrder ?? "").trim();
    if (!wo) continue;
    if (!woMeta.has(wo)) woMeta.set(wo, { code: row.recipeCode ?? "", name: row.recipeName ?? "" });
    if (row.subRecipe) {
      if (!woSubs.has(wo)) woSubs.set(wo, new Set());
      woSubs.get(wo)!.add(row.subRecipe);
    }
  }
  for (const row of reconRows) {
    const wo = String(row.workOrder ?? "").trim();
    if (!wo) continue;
    if (!woMeta.has(wo)) woMeta.set(wo, { code: row.recipeCode ?? "", name: row.recipeName ?? "" });
    if (row.subRecipe) {
      if (!woSubs.has(wo)) woSubs.set(wo, new Set());
      woSubs.get(wo)!.add(row.subRecipe);
    }
  }
  for (const [wo, meta] of woMeta) {
    const subs = [...(woSubs.get(wo) ?? [])];
    const weekNum = weekPrefixFromWoNumber(wo);
    pushEntry(
      out,
      seen,
      {
        kind: "wo",
        title: `WO ${wo}`,
        subtitle: [meta.code, meta.name].filter(Boolean).join(" · ") || "ohne Rezept-Zuordnung",
        recipeCode: meta.code,
        woNumber: wo,
      },
      [weekNum != null ? `kw${weekNum}` : "", ...subs],
    );
  }

  // ── Submeals: aus Produktionsplan-Zeilen + Rezept-Stammdaten ──────────────
  const submealSeen = new Set<string>();
  const addSubmeal = (code: string, name: string, id: string, category: string, recipeName: string) => {
    const key = `${code}::${name}`;
    if (submealSeen.has(key) || !name) return;
    submealSeen.add(key);
    pushEntry(
      out,
      seen,
      {
        kind: "submeal",
        title: name,
        subtitle: [code, recipeName].filter(Boolean).join(" · "),
        recipeCode: code,
        subRecipe: name,
        sku: id || undefined,
      },
      [id, category],
    );
  };
  // Rezept-Stammdaten zuerst — die tragen die Sub-Rezept-ID/SKU; die Plan-Zeilen
  // führen sie oft nicht mit (recipeId leer) und würden sonst per Dedup gewinnen.
  for (const [code, recipe] of Object.entries(data.recipes ?? {})) {
    for (const sub of recipeSubmeals(data, code)) {
      addSubmeal(code, sub.name, sub.id, sub.category, recipe.baseName ?? "");
    }
  }
  for (const row of data.productionPlan?.rows ?? []) {
    if (!row.subRecipe || !row.recipeCode) continue;
    addSubmeal(row.recipeCode, row.subRecipe, row.recipeId ?? "", row.cookMethods ?? "", row.recipeName ?? "");
  }

  // ── SKU-Codes: Shelf-Life + MSKU + Packaging ──────────────────────────────
  for (const info of Object.values(data.shelfLifeBySku ?? {})) {
    if (!info.skuCode) continue;
    pushEntry(out, seen, {
      kind: "sku",
      title: info.skuCode,
      subtitle: info.skuName || info.category || "SKU",
      recipeCode: "",
      sku: info.skuCode,
    }, [info.category ?? "", info.subCategory ?? ""]);
  }
  for (const [code, recipe] of Object.entries(data.recipes ?? {})) {
    for (const md of Object.values(recipe.markets ?? {})) {
      const skus = [md.msku, md.primaryPackagingSku, ...String(md.secondaryPackagingSkus ?? "").split(/[,;]/)]
        .map((s) => String(s ?? "").trim())
        .filter(Boolean);
      for (const sku of skus) {
        pushEntry(out, seen, {
          kind: "sku",
          title: sku,
          subtitle: [code, recipe.baseName].filter(Boolean).join(" · "),
          recipeCode: code,
          sku,
        });
      }
    }
  }

  // ── Meals ────────────────────────────────────────────────────────────────
  const mealSeen = new Set<string>();
  for (const [code, recipe] of Object.entries(data.recipes ?? {})) {
    if (mealSeen.has(code)) continue;
    mealSeen.add(code);
    pushEntry(out, seen, {
      kind: "meal",
      title: recipe.baseName || code,
      subtitle: code,
      recipeCode: code,
    });
  }
  for (const wr of data.weekRecipes ?? []) {
    if (mealSeen.has(wr.code)) continue;
    mealSeen.add(wr.code);
    pushEntry(out, seen, {
      kind: "meal",
      title: wr.recipeName || wr.code,
      subtitle: [wr.code, wr.preference].filter(Boolean).join(" · "),
      recipeCode: wr.code,
    });
  }

  return out;
}

// ─── Ranking ───────────────────────────────────────────────────────────────

const KIND_BOOST: Record<SearchEntry["kind"], number> = { wo: 12, submeal: 6, sku: 4, meal: 2 };

function scoreEntry(entry: SearchEntry, needle: string, needleTokens: string[]): number {
  const hay = entry.haystack;
  if (!hay.includes(needle) && !needleTokens.every((t) => hay.includes(t))) return 0;

  let score = KIND_BOOST[entry.kind];
  const title = norm(entry.title);
  const bareTitle = title.replace(/^wo\s+/, "");

  if (bareTitle === needle || title === needle) score += 120;
  else if (title.startsWith(needle) || bareTitle.startsWith(needle)) score += 70;
  else if (entry.tokens.some((t) => t.startsWith(needle))) score += 40;
  else if (hay.includes(` ${needle}`)) score += 25;
  else if (hay.includes(needle)) score += 12;

  for (const tok of needleTokens) {
    if (entry.tokens.includes(tok)) score += 8;
    else if (entry.tokens.some((t) => t.startsWith(tok))) score += 4;
  }

  // Kürzere Treffer sind meist relevanter (weniger Rauschen im Titel).
  score -= Math.min(10, Math.floor(title.length / 12));
  return score;
}

export function searchIndex(entries: SearchEntry[], query: string, limit = 24): SearchHit[] {
  const needle = norm(query);
  if (needle.length < 2) return [];
  const needleTokens = tokenize(query);

  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, needle, needleTokens);
    if (score > 0) hits.push({ entry, score });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.title.length - b.entry.title.length);
  return hits.slice(0, limit);
}

export function groupHits(hits: SearchHit[]): { kind: SearchEntry["kind"]; hits: SearchHit[] }[] {
  const order: SearchEntry["kind"][] = ["wo", "submeal", "sku", "meal"];
  return order
    .map((kind) => ({ kind, hits: hits.filter((h) => h.entry.kind === kind) }))
    .filter((g) => g.hits.length > 0);
}
