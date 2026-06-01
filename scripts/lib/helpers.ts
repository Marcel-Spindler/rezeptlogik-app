// Gemeinsame Hilfsfunktionen für alle Import-Scripts.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import Papa from "papaparse";
import type { Market } from "../../src/types.ts";

const COOK_CSV = "Cook Schedules Per DC - Cook Shifts per DC.csv";

// ─── Numerische Konvertierung ─────────────────────────────────────────────

export function num(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

export function numOpt(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

// ─── CSV-Parsing ──────────────────────────────────────────────────────────

export function readCsv<T = Record<string, string>>(path: string): T[] {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/^\uFEFF/, "");
  const res = Papa.parse<T>(text, { header: true, skipEmptyLines: true });
  if (res.errors.length) console.warn(`CSV warnings ${path}:`, res.errors.slice(0, 3));
  return res.data as T[];
}

// ─── Rezept-Code-Parsing ──────────────────────────────────────────────────

export function parseRecipeName(full: string): { code: string; base: string } {
  const m = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s*-\s*(.+?)(?:\s*\[(?:BNL|BENL|DE|DKSE|NORD)\])?\s*$/.exec(full);
  if (m) return { code: m[1], base: m[2].trim() };
  const suffix = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s+(.+?)\s+(?:BNL|BENL|DE|DKSE|NORD)\s*$/i.exec(full);
  if (suffix) return { code: suffix[1], base: suffix[2].trim() };
  const plain = /^([A-Z]{2}\d{4}[A-Z0-9]+)\s+(.+?)\s*$/.exec(full);
  if (plain) return { code: plain[1], base: plain[2].trim() };
  return { code: full, base: full };
}

// Kern-Schlüssel: nur die 4–5-stellige Nummer (z. B. "FE0972B" → "0972").
export function digitKey(code: string): string {
  const m = /(\d{4,5})/.exec(code);
  return m ? m[1] : code;
}

// ─── Markt-Erkennung ──────────────────────────────────────────────────────

export function detectMarket(fullName: string): Market | null {
  if (/\[BNL\]/i.test(fullName) || /\[BENL\]/i.test(fullName)) return "BENL";
  if (/\[DKSE\]/i.test(fullName) || /\[NORD\]/i.test(fullName)) return "DKSE";
  if (/\[DE\]/i.test(fullName)) return "DE";
  return null;
}

// ─── Quellverzeichnis ────────────────────────────────────────────────────

export function resolveSourceDir(): string {
  const configured = process.env.REZEPTLOGIK_SOURCE_DIR?.trim();
  if (configured) return configured;

  for (const dir of [resolve("imports"), "C:\\Rezeptlogik", resolve("Rezeptlogik")]) {
    if (!existsSync(dir)) continue;
    if (
      existsSync(join(dir, COOK_CSV)) ||
      existsSync(join(dir, "export-sub-recipes-by-recipe-detailed.csv")) ||
      readdirSync(dir).some(f => /^export-recipes.*\.csv$/i.test(f))
    ) return dir;
  }

  return resolve("imports");
}
