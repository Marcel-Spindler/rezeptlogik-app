// What-If Rechner – Zahl-/Massen-Format- und Input-Parsing-Helper.

export function fmt(n: number, decimals = 0): string {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("de-DE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

export function fmtMass(grams: number): string {
  if (!isFinite(grams)) return "—";
  if (grams === 0) return "0 g";
  if (Math.abs(grams) >= 1000) return `${fmt(grams / 1000, 2)} kg`;
  return `${fmt(grams, grams < 10 ? 2 : 0)} g`;
}

export function fmtEuro(euros: number): string {
  if (!isFinite(euros)) return "—";
  return euros.toLocaleString("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function parseNumInput(s: string): number {
  const n = parseFloat(s.replace(/[,\s]/g, "."));
  return isNaN(n) ? 0 : n;
}

