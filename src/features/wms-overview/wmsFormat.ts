// WMS Übersicht – generische Format-/Datums-Helper.

export function fmtQty(v: number | null | undefined, unit = ""): string {
  if (v == null || !Number.isFinite(v)) return "–";
  const abs = Math.abs(v);
  const dec = abs >= 1000 ? 0 : 1;
  const s = v.toLocaleString("de-DE", { maximumFractionDigits: dec });
  return unit ? `${s} ${unit}` : s;
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return "–";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function daysUntil(exp: string): number {
  // Compare calendar dates (ignoring time-of-day) to avoid timezone drift
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(exp);
  d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

export function mhdClass(exp: string | null | undefined): string {
  if (!exp) return "text-slate-400";
  const days = daysUntil(exp);
  if (days < 0)  return "text-slate-500 line-through bg-slate-100 px-1 rounded"; // abgelaufen
  if (days < 3)  return "text-rose-700 font-bold bg-rose-100 px-1 rounded";      // kritisch
  if (days < 7)  return "text-amber-600 font-semibold";                           // warnung
  return "text-emerald-700";
}

export function skuKey(s: string): string {
  return String(s ?? "").trim().toUpperCase();
}

export function cleanName(s: string): string {
  return String(s ?? "").replace(/\s+\[PENDING CULINARY REVIEW\]/gi, "").replace(/\s+/g, " ").trim() || "–";
}

export function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

