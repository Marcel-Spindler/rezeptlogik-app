// Rundmail – Plating-Notizen-Persistenz (localStorage) und CSV-Parsing (KET+PET).
import Papa from "papaparse";
import type { PetRow, PlatingNote, RundmailRow } from "./rundmailTypes";

export const PLATING_NOTES_KEY = "rezeptlogik-plating-notes-v1";

export function loadPlatingNotes(): Record<string, PlatingNote> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PLATING_NOTES_KEY) : null;
    return raw ? (JSON.parse(raw) as Record<string, PlatingNote>) : {};
  } catch {
    return {};
  }
}

export function savePlatingNotes(notes: Record<string, PlatingNote>): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(PLATING_NOTES_KEY, JSON.stringify(notes));
  } catch { /* quota exceeded – silent */ }
}

export function parseDateNeeded(value: string): { date: string; run: number } {
  const [rawDate, rawRun] = (value ?? "").split(" - ");
  return {
    date: (rawDate ?? "").trim(),
    run: Number(rawRun ?? "0") || 0,
  };
}

export function isRun1(value: string): boolean {
  return parseDateNeeded(value).run === 1;
}

export function toNumber(raw: string): number {
  const normalized = (raw ?? "").toString().trim().replace(/,/g, "");
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseSeedCsv(csvText: string): RundmailRow[] {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const rows: RundmailRow[] = [];
  parsed.data.forEach((raw, idx) => {
    const wo = (raw["Work Order Number"] ?? "").trim();
    const dateNeeded = (raw["Date Needed"] ?? "").trim();
    if (!wo || !dateNeeded) return;

    rows.push({
      id: `${wo}-${idx}`,
      dateNeeded,
      workOrderNumber: wo,
      recipeId: (raw["Recipe ID"] ?? "").trim(),
      recipeName: (raw["Recipe Name"] ?? "").trim(),
      subRecipeName: (raw["Sub Recipe Name"] ?? "").trim(),
      minimumNeeds: toNumber(raw["Production Minimum Needs Amount"] ?? ""),
      cookMethods: (raw["Cook Methods"] ?? "").trim(),
      woCookedPortions: toNumber(raw["WO Cooked Portions"] ?? ""),
      targetPortions: toNumber(raw["Target Portions"] ?? ""),
      cookedExcess: toNumber(raw["Cooked Portions Excess"] ?? ""),
      stagingStatus: (raw["Staging Status"] ?? "").trim(),
      stagingComment: (raw["Staging Comment"] ?? "").trim(),
      kitchenStatus: (raw["Kitchen Status"] ?? "").trim(),
      unlockedEta: (raw["Unlocked ETA"] ?? "").trim(),
      workOrderComment: (raw["Work Order Comment"] ?? "").trim(),
    });
  });

  return rows;
}

export function parsePetCsv(csvText: string): PetRow[] {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const rows: PetRow[] = [];
  parsed.data.forEach((raw, idx) => {
    const productionShift = (raw["Production Shift"] ?? "").trim();
    const recipeWo = (raw["Recipe WO #"] ?? "").trim();
    const recipeName = (raw["Recipe Name"] ?? "").trim();
    if (!productionShift || !recipeWo || !recipeName) return;

    rows.push({
      id: `${recipeWo}-${idx}`,
      type: (raw["Type"] ?? "").trim(),
      productionShift,
      totalTarget: toNumber(raw["Total Target"] ?? ""),
      totalMapped: toNumber(raw["Total Mapped"] ?? ""),
      recipeWo,
      recipeName,
      recipeWoMapped: toNumber(raw["Recipe WO Mapped"] ?? ""),
      recipeWoTarget: toNumber(raw["Recipe WO Target"] ?? ""),
      recipePlatingStatus: (raw["Recipe Plating Status"] ?? "").trim(),
      recipeManualPlatingStatus: (raw["Recipe Manual Plating Status"] ?? "").trim(),
      totalWeekUnlockedVolume: toNumber(raw["Total Week Unlocked Volume"] ?? ""),
      totalWeekMapped: toNumber(raw["Total Week Mapped"] ?? ""),
      productionMinNeeds: toNumber(raw["Production Min Needs"] ?? ""),
      expiringDatetime: (raw["Expiring Datetime"] ?? "").trim(),
      expiringSubRecipeName: (raw["Expiring SubRecipe Name"] ?? "").trim(),
      expiringPortions: toNumber(raw["Expiring Portions"] ?? ""),
      expiringLicensePlate: (raw["Expiring License Plate #"] ?? "").trim(),
      comment: (raw["Comment"] ?? "").trim(),
      rolloverAmount: toNumber(raw["Rollover Amount"] ?? ""),
      actualBestByDate: (raw["Actual Best By Date"] ?? "").trim(),
      bestBySubRecipeName: (raw["Best By SubRecipe Name"] ?? "").trim(),
    });
  });

  return rows;
}

export function detectCsvType(csvText: string): "ket" | "pet" | "unknown" {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    preview: 3,
  });
  const first = parsed.data?.[0] ?? {};
  const keys = new Set(Object.keys(first));
  if (keys.has("Date Needed") && keys.has("Work Order Number")) return "ket";
  if (keys.has("Production Shift") && keys.has("Recipe WO #")) return "pet";
  return "unknown";
}

export function parseBestByTimestamp(value: string): number | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  const iso = Date.parse(raw);
  if (Number.isFinite(iso)) return iso;

  const m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (!day || !month || !year) return null;
  const ts = Date.UTC(year, month - 1, day);
  return Number.isFinite(ts) ? ts : null;
}

export function daySortValue(day: string): number {
  const [rawDate, rawSlot] = day.split(" - ");
  const ts = Date.parse(`${rawDate}T00:00:00Z`);
  const slot = Number(rawSlot ?? "0") || 0;
  return ts * 10 + slot;
}

