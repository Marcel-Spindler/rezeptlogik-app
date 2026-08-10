// Rundmail – generische Format-/Text-/Matching-Helper sowie Allergen-/Status-Einstufung.
import { ALLERGEN_DEFS } from "./rundmailTypes";
import type { AllergenDef } from "./rundmailTypes";

export function fmtInt(value: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(value);
}

export function toSlack(value: number): number {
  return value >= 0 ? value : 0;
}

export function escapeHtml(value: string): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function normalizeText(value: string): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenize(value: string): string[] {
  return normalizeText(value).split(" ").filter((token) => token.length > 1);
}

export function overlapScore(a: string, b: string): number {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

export function parseFloatSafe(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function toCells(rowValues: unknown): string[] {
  if (!Array.isArray(rowValues)) return [];
  return rowValues.map((cell) => String(cell ?? "").trim());
}


export function detectAllergens(texts: string[]): AllergenDef[] {
  const combined = texts.join(" ").toLowerCase();
  return ALLERGEN_DEFS.filter(({ keywords }) => keywords.some((kw) => combined.includes(kw)));
}

export function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("not started")) return "bg-rose-100 text-rose-700 ring-rose-200";
  if (normalized.includes("pre blast"))   return "bg-amber-100 text-amber-800 ring-amber-200";
  if (normalized.includes("post blast"))  return "bg-emerald-100 text-emerald-700 ring-emerald-200";
  if (normalized.includes("open"))        return "bg-orange-100 text-orange-700 ring-orange-200";
  if (normalized.includes("picking"))     return "bg-sky-100 text-sky-700 ring-sky-200";
  if (normalized.includes("staged"))      return "bg-violet-100 text-violet-700 ring-violet-200";
  if (normalized.includes("allocation"))  return "bg-pink-100 text-pink-700 ring-pink-200";
  return "bg-slate-200 text-slate-700 ring-slate-300";
}

export function petStatusTone(status: string): { bg: string; text: string; border: string } {
  const normalized = status.toLowerCase();
  if (normalized.includes("in progress")) return { bg: "#fef3c7", text: "#92400e", border: "#fcd34d" };
  if (normalized.includes("not started")) return { bg: "#fee2e2", text: "#991b1b", border: "#fca5a5" };
  if (normalized.includes("done") || normalized.includes("complete")) return { bg: "#dcfce7", text: "#166534", border: "#86efac" };
  return { bg: "#e2e8f0", text: "#334155", border: "#cbd5e1" };
}

